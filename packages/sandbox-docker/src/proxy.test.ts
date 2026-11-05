import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { attachProxy, classifyAddress, isAllowed, parseAllow, resolveAllowed, splitHostPort } from "./proxy.ts";
import type { ProxyOptions } from "./proxy.ts";

test("parseAllow: comma-separated host:port, missing port means 443", () => {
  assert.deepEqual(parseAllow("pypi.org:443, registry.npmjs.org"), new Set(["pypi.org:443", "registry.npmjs.org:443"]));
});

test("parseAllow: skips blanks, malformed ports, and empty hosts; lowercases hosts", () => {
  assert.deepEqual(parseAllow("  ,Example.COM:80,bad:0,,host:notaport,other:70000"), new Set(["example.com:80"]));
});

test("isAllowed: exact host match, case-insensitive, exact port", () => {
  const allow = parseAllow("PyPI.org:443");
  assert.equal(isAllowed(allow, "pypi.org", 443), true);
  assert.equal(isAllowed(allow, "pypi.org", 80), false);
  assert.equal(isAllowed(allow, "other.org", 443), false);
});

test("splitHostPort: host:port and bare host (443 default)", () => {
  assert.deepEqual(splitHostPort("example.com:8443"), { host: "example.com", port: 8443 });
  assert.deepEqual(splitHostPort("example.com"), { host: "example.com", port: 443 });
});

async function startProxy(allowCsv: string, opts?: Partial<ProxyOptions>) {
  const server = createServer();
  attachProxy(server, parseAllow(allowCsv), {
    hostAddresses: new Set<string>(),
    unsafeAllowLoopback: true,
    resolve: async () => ["93.184.216.34"],
    ...opts,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

function absoluteGet(proxyPort: number, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET" }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`status ${res.statusCode}`));
        res.resume();
        return;
      }
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.end();
  });
}

// A stand-in for the upstream `http.ClientRequest` returned by an injected `request`. It is a
// Writable (so the proxy's `req.pipe(upstream)` works) and counts `destroy()` calls so tests can
// observe whether a timeout tore it down.
class FakeClientRequest extends Writable {
  destroyCalls = 0;
  constructor() {
    super({ autoDestroy: false });
  }
  _write(_chunk: unknown, _encoding: unknown, cb: () => void): void {
    cb();
  }
  setTimeout(): this {
    return this;
  }
  override destroy(error?: Error): this {
    this.destroyCalls += 1;
    return super.destroy(error);
  }
}

// A minimal upstream response used by the reused-socket test so the proxy can complete the
// client's 200 without a real upstream server.
class FakeUpstreamResponse extends Readable {
  statusCode = 200;
  headers = { "content-type": "text/plain" };
  private sent = false;
  _read(): void {
    if (this.sent) return;
    this.sent = true;
    this.push("ok");
    this.push(null);
  }
  setTimeout(): this {
    return this;
  }
}

test("absolute-form GET relays to an allowed host and denies everything else", async () => {
  const upstream = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`ok:${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as AddressInfo).port;
  const proxy = await startProxy(`127.0.0.1:${upPort}`);
  try {
    assert.equal(await absoluteGet(proxy.port, `http://127.0.0.1:${upPort}/hello`), "ok:/hello");
    await assert.rejects(absoluteGet(proxy.port, `http://127.0.0.1:${upPort + 1}/nope`), /status 403/);
  } finally {
    proxy.server.close();
    upstream.close();
  }
});

function establishTunnel(proxyPort: number, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1");
    let buf = "";
    let done = false;
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    s.on("data", (d) => {
      buf += d;
      if (done || !buf.includes("\r\n\r\n")) return;
      done = true;
      if (!buf.startsWith("HTTP/1.1 200")) {
        reject(new Error(buf));
        s.destroy();
        return;
      }
      resolve(s);
    });
  });
}

function connectTunnel(proxyPort: number, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, "127.0.0.1");
    let buf = "";
    let established = false;
    s.setEncoding("utf8");
    s.on("error", reject);
    s.on("connect", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    s.on("data", (d) => {
      buf += d;
      if (!established) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        if (!buf.startsWith("HTTP/1.1 200")) {
          reject(new Error(buf));
          s.destroy();
          return;
        }
        established = true;
        buf = buf.slice(i + 4);
        s.write("ping");
      }
      if (established && buf.includes("ping")) {
        resolve(buf);
        s.destroy();
      }
    });
  });
}

test("CONNECT blind-tunnels to an allowed host:port", async () => {
  const echo = createTcpServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as AddressInfo).port;
  const proxy = await startProxy(`127.0.0.1:${echoPort}`);
  try {
    assert.equal(await connectTunnel(proxy.port, "127.0.0.1", echoPort), "ping");
  } finally {
    proxy.server.close();
    echo.close();
  }
});

test("CONNECT connect timeout closes a client whose upstream never connects", { timeout: 2000 }, async () => {
  // A fake upstream that never emits 'connect' models a blackholed dial; the proxy must drop the
  // client after connectTimeoutMs instead of leaving it hanging forever.
  const emitter = new EventEmitter();
  const never = Object.assign(emitter, { destroy: () => emitter.emit("close") }) as unknown as Socket;
  const proxy = await startProxy("example.com:443", { connectTimeoutMs: 30, connect: () => never });
  try {
    await new Promise<void>((resolve, reject) => {
      const s = connect(proxy.port, "127.0.0.1");
      s.on("error", reject);
      s.on("connect", () => s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
      s.on("close", () => resolve());
    });
  } finally {
    proxy.server.close();
  }
});

test("CONNECT idle timeout closes an idle tunnel", { timeout: 2000 }, async () => {
  const echo = createTcpServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as AddressInfo).port;
  const proxy = await startProxy(`127.0.0.1:${echoPort}`, { idleTimeoutMs: 30 });
  try {
    const s = await establishTunnel(proxy.port, "127.0.0.1", echoPort);
    await new Promise<void>((resolve, reject) => {
      s.on("error", reject);
      s.on("close", () => resolve());
    });
  } finally {
    proxy.server.close();
    echo.close();
  }
});

test("absolute-form idle timeout tears down a stalled upstream instead of hanging", { timeout: 2000 }, async () => {
  const stall = createServer(() => {
    /* accept and never respond */
  });
  await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
  const stallPort = (stall.address() as AddressInfo).port;
  const proxy = await startProxy(`127.0.0.1:${stallPort}`, { idleTimeoutMs: 30 });
  try {
    await assert.rejects(absoluteGet(proxy.port, `http://127.0.0.1:${stallPort}/slow`));
  } finally {
    proxy.server.close();
    stall.close();
  }
});

test("absolute-form reused (already-connected) socket does not trip the connect timer", { timeout: 2000 }, async () => {
  // A keep-alive socket arrives on the `socket` event already connected, so its `connect` event
  // never fires. Regression: the connect-timer must not tear down a healthy
  // response that merely arrived on a reused socket.
  const socket = Object.assign(new EventEmitter(), { connecting: false }) as unknown as Socket;
  let upstream: FakeClientRequest | undefined;
  const proxy = await startProxy("example.com:80", {
    connectTimeoutMs: 30,
    request: ((_options: unknown, cb: (res: IncomingMessage) => void) => {
      upstream = new FakeClientRequest();
      queueMicrotask(() => upstream!.emit("socket", socket));
      cb(new FakeUpstreamResponse() as unknown as IncomingMessage);
      return upstream;
    }) as unknown as typeof httpRequest,
  });
  try {
    assert.equal(await absoluteGet(proxy.port, "http://example.com/"), "ok");
    // Well past the 30ms connect timeout; the reused socket must not have been destroyed.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(upstream!.destroyCalls, 0);
  } finally {
    proxy.server.close();
  }
});

test("absolute-form connect timeout still drops an upstream whose socket never connects", { timeout: 2000 }, async () => {
  // The still-connecting branch must keep the original semantics: a TCP handshake that never
  // completes is dropped after connectTimeoutMs.
  const socket = Object.assign(new EventEmitter(), { connecting: true }) as unknown as Socket;
  let upstream: FakeClientRequest | undefined;
  const proxy = await startProxy("example.com:80", {
    connectTimeoutMs: 30,
    request: ((_options: unknown, _cb: (res: IncomingMessage) => void) => {
      upstream = new FakeClientRequest();
      queueMicrotask(() => upstream!.emit("socket", socket));
      return upstream;
    }) as unknown as typeof httpRequest,
  });
  try {
    await assert.rejects(absoluteGet(proxy.port, "http://example.com/"));
    assert.equal(upstream!.destroyCalls, 1);
  } finally {
    proxy.server.close();
  }
});

test("denied CONNECT and absolute-form requests log `egress denied host:port` to stderr, nothing else", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void logged.push(a.join(" ")));
  const proxy = await startProxy("example.com:443");
  try {
    await assert.rejects(absoluteGet(proxy.port, "http://denied.test:8080/secret/path?token=x"), /status 403/);
    await new Promise<void>((resolve) => {
      const s = connect(proxy.port, "127.0.0.1", () => s.write("CONNECT blocked.test:443 HTTP/1.1\r\nHost: blocked.test:443\r\n\r\n"));
      s.resume(); // consume the explicit 403 before observing EOF
      s.on("close", () => resolve());
      s.on("error", () => {});
    });
    assert.deepEqual(logged, ["egress denied denied.test:8080", "egress denied blocked.test:443"]);
  } finally {
    proxy.server.close();
  }
});

test("classifyAddress: private, loopback, link-local, CGNAT, ULA, mapped and NAT64 forms are not public", () => {
  const notPublic = [
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::10.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b::169.254.169.254",
    "2002:a00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  ];
  for (const ip of notPublic) assert.notEqual(classifyAddress(ip), "public", ip);
  assert.equal(classifyAddress("169.254.169.254"), "hard");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "hard");
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(classifyAddress(ip), "public", ip);
  assert.equal(classifyAddress("not-an-ip"), "hard");
});

test("resolveAllowed: hostname resolving to a private/mixed answer is denied; public passes", async () => {
  assert.equal(await resolveAllowed("evil.test", async () => ["10.0.0.5"], new Set()), undefined);
  assert.equal(await resolveAllowed("evil.test", async () => ["93.184.216.34", "169.254.169.254"], new Set()), undefined);
  assert.equal(await resolveAllowed("evil.test", async () => ["::ffff:10.0.0.5"], new Set()), undefined);
  assert.equal(await resolveAllowed("evil.test", async () => ["fd00::1"], new Set()), undefined);
  assert.equal(await resolveAllowed("evil.test", async () => [], new Set()), undefined);
  assert.equal(
    await resolveAllowed(
      "evil.test",
      async () => {
        throw new Error("ENOTFOUND");
      },
      new Set(),
    ),
    undefined,
  );
  assert.equal(await resolveAllowed("ok.test", async () => ["93.184.216.34"], new Set()), "93.184.216.34");
});

test("resolveAllowed: private literals and host gateway require explicit relay, never hard-denied classes", async () => {
  assert.equal(await resolveAllowed("host.docker.internal", async () => ["172.17.0.1"], new Set()), undefined);
  assert.equal(await resolveAllowed("host.docker.internal", async () => ["172.17.0.1"], new Set(), false, true), "172.17.0.1");
  assert.equal(await resolveAllowed("host.docker.internal", async () => ["169.254.169.254"], new Set()), undefined);
  assert.equal(await resolveAllowed("host.docker.internal", async () => ["127.0.0.1"], new Set()), undefined);
  assert.equal(await resolveAllowed("172.17.0.2", async () => [], new Set()), undefined);
  assert.equal(await resolveAllowed("172.17.0.2", async () => [], new Set(), false, true), "172.17.0.2");
  assert.equal(await resolveAllowed("169.254.169.254", async () => [], new Set()), undefined);
  assert.equal(await resolveAllowed("[::1]", async () => [], new Set()), undefined);
  assert.equal(await resolveAllowed("other.internal", async () => ["172.17.0.1"], new Set()), undefined);
});

test("attachProxy requires an explicit hostAddresses set", () => {
  const server = createServer();
  assert.throws(() => attachProxy(server, new Set(), {} as never), /hostAddresses/);
});

test("allowlisted hostname resolving private is denied on CONNECT and absolute-form, and logged", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void logged.push(a.join(" ")));
  let dialed = 0;
  const proxy = await startProxy("rebind.test:80,rebind.test:443", {
    resolve: async () => ["169.254.169.254"],
    connect: () => {
      dialed += 1;
      throw new Error("must not dial");
    },
  });
  try {
    await assert.rejects(absoluteGet(proxy.port, "http://rebind.test/x"), /status 403/);
    await new Promise<void>((resolve) => {
      const s = connect(proxy.port, "127.0.0.1", () => s.write("CONNECT rebind.test:443 HTTP/1.1\r\nHost: rebind.test:443\r\n\r\n"));
      s.resume();
      s.on("close", () => resolve());
      s.on("error", () => {});
    });
    assert.equal(dialed, 0);
    assert.deepEqual(logged, ["egress denied rebind.test:80", "egress denied rebind.test:443"]);
  } finally {
    proxy.server.close();
  }
});

test("CONNECT dials the validated IP from a single lookup (rebind between lookups cannot redirect it)", async () => {
  const echo = createTcpServer((c) => c.pipe(c));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = (echo.address() as AddressInfo).port;
  let lookups = 0;
  const dialedHosts: string[] = [];
  const proxy = await startProxy(`rebind.test:${echoPort}`, {
    // first answer public, any later answer would be private: the proxy must use only the first
    resolve: async () => (++lookups === 1 ? ["93.184.216.34"] : ["10.0.0.5"]),
    connect: (port, host) => {
      dialedHosts.push(host);
      return connect(port, "127.0.0.1");
    },
  });
  try {
    assert.equal(await connectTunnel(proxy.port, "rebind.test", echoPort), "ping");
    assert.deepEqual(dialedHosts, ["93.184.216.34"]);
    assert.equal(lookups, 1);
  } finally {
    proxy.server.close();
    echo.close();
  }
});

test("classifyAddress: only the reserved 192.0.0.0/16 sub-ranges are denied; public neighbours stay public", () => {
  for (const ip of [
    "192.0.43.8",
    "192.0.32.1",
    "192.0.1.1",
    "192.0.3.255",
    "192.0.255.255",
    "192.1.0.1",
    "191.255.255.255",
    "198.17.255.255",
    "198.20.0.0",
    "198.51.99.255",
    "198.51.101.0",
    "203.0.112.255",
    "203.0.114.0",
    "192.88.98.255",
    "192.88.100.0",
    "100.128.0.1",
    "3fff:1000::1",
    "::ffff:192.0.43.8",
    "64:ff9b::c000:2b08",
    "2002:c000:2b08::",
  ])
    assert.equal(classifyAddress(ip), "public", ip);
  for (const ip of [
    "192.0.0.0",
    "192.0.0.9",
    "192.0.0.255",
    "192.0.2.0",
    "192.0.2.255",
    "192.88.99.1",
    "198.18.0.0",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.7",
    "240.0.0.1",
    "255.255.255.255",
    "3fff::1",
    "3fff:fff::1",
    "::ffff:192.0.2.1",
    "64:ff9b::c000:201",
    "2002:c000:201::",
  ])
    assert.equal(classifyAddress(ip), "hard", ip);
  for (const ip of ["100.64.0.0", "100.127.255.255", "::ffff:100.64.0.1"]) assert.equal(classifyAddress(ip), "private", ip);
});
