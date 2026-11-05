// Traffic classes (TODO(relay-class)): relay endpoints run without the public absolute deadline and under their own byte cap.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as tcpServer, Socket, type AddressInfo, type Server as NetServer } from "node:net";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_CONNECTION_BYTES,
  DEFAULT_RELAY_MAX_BYTES,
  DEFAULT_UNADMITTED_IDLE_TIMEOUT_MS,
  RELAY_TUNNEL_CEILING_FACTOR,
  RELAY_TUNNEL_CEILING_FLOOR_BYTES,
  attachProxy,
  createSidecarProxies,
  relayTunnelCeiling,
  type ProxyOptions,
} from "./proxy.ts";
import { validateProxyConfig, type EgressAuditEvent, type EgressAuditWriter, type EgressProxyConfig } from "./audit.ts";

const MiB = 1024 ** 2;

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function sink(): { events: EgressAuditEvent[]; writer: EgressAuditWriter } {
  const events: EgressAuditEvent[] = [];
  return { events, writer: { append: (e) => void events.push(e) } };
}

// A local "daemon" that counts the request body and answers with the count.
async function countingServer(): Promise<{ port: number; close(): void }> {
  const server = createServer((req, res) => {
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
    });
    req.on("end", () => res.end(String(n)));
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}

// POSTs `bytes` through the proxy to `target` in 1 MiB chunks; resolves with the status and body, or the client error code.
function post(proxyPort: number, target: string, bytes: number): Promise<{ status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: "POST", path: target, agent: false, headers: { "content-length": String(bytes) } },
      (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    const chunk = Buffer.alloc(MiB, 120);
    let sent = 0;
    const pump = () => {
      while (sent < bytes) {
        const n = Math.min(chunk.length, bytes - sent);
        sent += n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void req.once("drain", pump);
      }
      req.end();
    };
    pump();
  });
}

// The sidecar's main listener over TCP for tests, with relay.test:<port> as the relay and the loopback dial allowed.
async function sidecar(relayPort: number, limits?: EgressProxyConfig["limits"]) {
  const { events, writer } = sink();
  const config: EgressProxyConfig = {
    allow: [],
    relay: [`relay.test:${relayPort}`],
    identity: { sandbox: "sb", agent: "a", host: "h", generation: 1 },
    auditedPublic: true,
    ...(limits ? { limits } : {}),
  };
  const proxies = createSidecarProxies(validateProxyConfig(config), new Set(), writer, { resolve: async () => ["127.0.0.1"], unsafeAllowLoopback: true });
  const port = await listen(proxies.main.server);
  return {
    port,
    events,
    proxies,
    close: () => {
      for (const { control, server } of [proxies.main, proxies.browser]) {
        control.close();
        server.closeAllConnections();
        server.close();
      }
    },
  };
}

test("the relay byte-cap default is the push.maxBytes default in core's config registry", () => {
  assert.equal(DEFAULT_RELAY_MAX_BYTES, CONFIG_DEFAULTS["push.maxBytes"]);
});

test("(a) a 20 MiB relayed POST reaches the relay under the relay cap", { timeout: 20000 }, async () => {
  const daemon = await countingServer();
  const proxy = await sidecar(daemon.port);
  try {
    assert.equal(proxy.proxies.main.server.requestTimeout, 0, "no server-wide request deadline");
    const bytes = 20 * MiB;
    assert.ok(bytes > DEFAULT_MAX_CONNECTION_BYTES, "the body is over the public cap");
    const res = await post(proxy.port, `http://relay.test:${daemon.port}/v1/agents/a/push`, bytes);
    assert.deepEqual(res, { status: 200, body: String(bytes) });
    assert.equal(
      proxy.events.some((e) => e.outcome === "limit"),
      false,
    );
  } finally {
    proxy.close();
    daemon.close();
  }
});

test("(d) a relayed POST over EgressProxyConfig.limits.relayMaxBytes trips limitKind bytes, trafficClass relay", { timeout: 20000 }, async () => {
  const daemon = await countingServer();
  const proxy = await sidecar(daemon.port, { relayMaxBytes: MiB });
  try {
    const res = await post(proxy.port, `http://relay.test:${daemon.port}/v1/agents/a/push`, 4 * MiB);
    assert.notEqual(res.status, 200);
    await new Promise((r) => setImmediate(r));
    const limits = proxy.events.filter((e) => e.outcome === "limit");
    assert.equal(limits.length, 1);
    assert.equal(limits[0]?.limitKind, "bytes");
    assert.equal(limits[0]?.trafficClass, "relay");
    assert.equal(limits[0]?.authority, `relay.test:${daemon.port}`);
  } finally {
    proxy.close();
    daemon.close();
  }
});

test("the browser listener has no relay set, so the same authority runs under the public cap there", { timeout: 20000 }, async () => {
  const daemon = await countingServer();
  const proxy = await sidecar(daemon.port, { relayMaxBytes: 64 * MiB });
  const port = await listen(proxy.proxies.browser.server);
  try {
    assert.equal(proxy.proxies.browser.server.requestTimeout, 0);
    const res = await post(port, `http://relay.test:${daemon.port}/v1/agents/a/push`, 20 * MiB);
    assert.notEqual(res.status, 200);
    await new Promise((r) => setImmediate(r));
    const limits = proxy.events.filter((e) => e.outcome === "limit");
    assert.deepEqual(
      limits.map((e) => [e.limitKind, e.trafficClass]),
      [["bytes", "public"]],
    );
  } finally {
    proxy.close();
    daemon.close();
  }
});

test("invalid EgressProxyConfig.limits are refused", () => {
  for (const limits of [null, [], { relayMaxBytes: 0 }, { relayMaxBytes: 1.5 }, { relayMaxBytes: "1" }, { other: 1 }])
    assert.throws(() => validateProxyConfig({ allow: [], relay: [], limits }), /invalid egress limits/, JSON.stringify(limits));
  assert.doesNotThrow(() => validateProxyConfig({ allow: [], relay: [], limits: {} }));
});

// CONNECT through `attachProxy` to a local echo. relay.test:<echo> is the relay; any other name is public (audited).
async function tunnelProxy(opts: Partial<ProxyOptions>) {
  const echo = tcpServer((s) => {
    s.on("error", () => {});
    s.pipe(s);
  });
  const echoPort = await listen(echo);
  const { events, writer } = sink();
  const server = createServer();
  const control = attachProxy(server, new Set(), {
    relay: new Set([`relay.test:${echoPort}`]),
    hostAddresses: new Set(),
    auditedPublic: writer,
    resolve: async () => ["8.8.8.8"],
    connect: () => new Socket().connect(echoPort, "127.0.0.1"),
    ...opts,
  });
  const port = await listen(server);
  // Opens a tunnel and resolves once the 200 arrives.
  const open = async (authority: string) => {
    const s = connect(port, "127.0.0.1");
    s.on("error", () => {});
    await once(s, "connect");
    s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [first] = (await once(s, "data")) as [Buffer];
    assert.match(first.toString(), /^HTTP\/1\.1 200/);
    return s;
  };
  return {
    port,
    echoPort,
    events,
    open,
    close: () => {
      control.close();
      server.closeAllConnections();
      server.close();
      echo.close();
    },
  };
}

// node:test mock.timers replaces the global setTimeout, which is what the flow deadline uses; socket idle timers (setTimeout on a
// socket) are Node-internal and keep real time, so the idle bound is exercised with a small real relayIdleTimeoutMs instead.
test("(b) an idle-but-alive relay tunnel survives far past the public 120 s deadline; a public one does not", { timeout: 10000 }, async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const p = await tunnelProxy({});
  try {
    const relay = await p.open(`relay.test:${p.echoPort}`);
    const pub = await p.open(`public.test:${p.echoPort}`);
    const pubClosed = new Promise<void>((r) => pub.once("close", () => r()));
    mock.timers.tick(DEFAULT_DEADLINE_MS * 5);
    await pubClosed;
    assert.equal(relay.destroyed, false);
    relay.write("still-here");
    const [echoed] = (await once(relay, "data")) as [Buffer];
    assert.equal(echoed.toString(), "still-here");
    const limits = p.events.filter((e) => e.outcome === "limit");
    assert.deepEqual(
      limits.map((e) => [e.authority, e.limitKind, e.trafficClass]),
      [[`public.test:${p.echoPort}`, "deadline", "public"]],
    );
    relay.destroy();
  } finally {
    mock.timers.reset();
    p.close();
  }
});

test("the relay idle bound is relayIdleTimeoutMs and trips with trafficClass relay", { timeout: 5000 }, async () => {
  const p = await tunnelProxy({ relayIdleTimeoutMs: 50, idleTimeoutMs: 60_000 });
  try {
    const relay = await p.open(`relay.test:${p.echoPort}`);
    await new Promise<void>((r) => relay.once("close", () => r()));
    const limits = p.events.filter((e) => e.outcome === "limit");
    assert.deepEqual(
      limits.map((e) => [e.limitKind, e.trafficClass]),
      [["idle", "relay"]],
    );
  } finally {
    p.close();
  }
});

test("(c) the public byte cap keeps its 16 MiB default on a non-relay destination", { timeout: 20000 }, async () => {
  const p = await tunnelProxy({});
  try {
    const pub = await p.open(`public.test:${p.echoPort}`);
    pub.on("data", () => {});
    // Not events.once: it rejects on the socket's 'error' (the proxy's teardown resets the writer), which is expected here.
    const closed = new Promise<void>((r) => pub.once("close", () => r()));
    const chunk = Buffer.alloc(MiB, 120);
    for (let i = 0; i < 17 && !pub.destroyed; i++) if (!pub.write(chunk)) await Promise.race([new Promise<void>((r) => pub.once("drain", () => r())), closed]);
    await closed;
    const limits = p.events.filter((e) => e.outcome === "limit");
    assert.deepEqual(
      limits.map((e) => [e.limitKind, e.trafficClass]),
      [["bytes", "public"]],
    );
    assert.ok((limits[0]?.bytesIn ?? 0) + (limits[0]?.bytesOut ?? 0) > DEFAULT_MAX_CONNECTION_BYTES);
  } finally {
    p.close();
  }
});

test("a listener without an audit writer names the class, kind and host:port of a tripped limit on stderr", { timeout: 5000 }, async () => {
  const lines: string[] = [];
  const err = mock.method(console, "error", (line: string) => void lines.push(line));
  const echo = tcpServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  const server = createServer();
  const control = attachProxy(server, new Set([`relay.test:${echoPort}`]), {
    relay: new Set([`relay.test:${echoPort}`]),
    hostAddresses: new Set(),
    relayIdleTimeoutMs: 50,
    resolve: async () => ["127.0.0.1"],
    unsafeAllowLoopback: true,
  });
  const port = await listen(server);
  try {
    const s = connect(port, "127.0.0.1");
    s.on("error", () => {});
    s.on("data", () => {});
    await once(s, "connect");
    s.write(`CONNECT relay.test:${echoPort} HTTP/1.1\r\nHost: relay.test\r\n\r\n`);
    await new Promise<void>((r) => s.once("close", () => r()));
    assert.deepEqual(lines, [`egress limit relay idle relay.test:${echoPort}`]);
  } finally {
    err.mock.restore();
    control.close();
    server.closeAllConnections();
    server.close();
    echo.close();
  }
});

// CONNECT through `attachProxy` to a request/response upstream: it answers "ok" after each `exchange` bytes it receives, the way an
// HTTP server answers a request after reading its body. relay.test:<port> is the relay; any other name is public (audited).
async function exchangeTunnel(exchange: number, opts: Partial<ProxyOptions>) {
  const upstream = tcpServer((s) => {
    s.on("error", () => {});
    let pending = 0;
    s.on("data", (d: Buffer) => {
      pending += d.length;
      for (; pending >= exchange; pending -= exchange) s.write("ok");
    });
  });
  const upPort = await listen(upstream);
  const { events, writer } = sink();
  const server = createServer();
  const control = attachProxy(server, new Set(), {
    relay: new Set([`relay.test:${upPort}`]),
    hostAddresses: new Set(),
    auditedPublic: writer,
    resolve: async () => ["8.8.8.8"],
    connect: () => new Socket().connect(upPort, "127.0.0.1"),
    ...opts,
  });
  const port = await listen(server);
  const open = async (authority: string) => {
    const s = connect(port, "127.0.0.1");
    s.on("error", () => {});
    await once(s, "connect");
    s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [first] = (await once(s, "data")) as [Buffer];
    assert.match(first.toString(), /^HTTP\/1\.1 200/);
    return s;
  };
  // Sends one request body of `bytes` and resolves true on its "ok", or false when the tunnel closes first.
  const send = (s: Socket, bytes: number) =>
    new Promise<boolean>((resolve) => {
      const onData = (d: Buffer) => {
        if (!d.toString().includes("ok")) return;
        s.off("close", onClose);
        resolve(true);
      };
      const onClose = () => {
        s.off("data", onData);
        resolve(false);
      };
      s.once("data", onData);
      s.once("close", onClose);
      s.write(Buffer.alloc(bytes, 120));
    });
  return {
    upPort,
    events,
    open,
    send,
    close: () => {
      control.close();
      server.closeAllConnections();
      server.close();
      upstream.close();
    },
  };
}

test("the relay byte cap is per exchange on a reused CONNECT tunnel, as Node's fetch reuses one for http:// relays", { timeout: 10000 }, async () => {
  const KiB = 1024;
  const p = await exchangeTunnel(600 * KiB, { relayMaxBytes: MiB });
  try {
    const relay = await p.open(`relay.test:${p.upPort}`);
    // Four 600 KiB exchanges: 2.4 MiB through one tunnel, each exchange under the 1 MiB cap.
    for (let i = 0; i < 4; i++) assert.equal(await p.send(relay, 600 * KiB), true, `exchange ${i}`);
    assert.equal(
      p.events.some((e) => e.outcome === "limit"),
      false,
    );
    relay.destroy();
  } finally {
    p.close();
  }
  // One exchange over the cap still trips it (the upstream answers only after the whole 1.2 MiB body, so nothing resets the count).
  const q = await exchangeTunnel(1200 * KiB, { relayMaxBytes: MiB });
  try {
    const relay = await q.open(`relay.test:${q.upPort}`);
    assert.equal(await q.send(relay, 1200 * KiB), false);
    assert.deepEqual(
      q.events.filter((e) => e.outcome === "limit").map((e) => [e.limitKind, e.trafficClass]),
      [["bytes", "relay"]],
    );
  } finally {
    q.close();
  }
});

test("relayTunnelCeiling is the factor x the cap, never below the 1 GiB floor", () => {
  assert.equal(RELAY_TUNNEL_CEILING_FLOOR_BYTES, 1024 ** 3);
  assert.equal(relayTunnelCeiling(1024), RELAY_TUNNEL_CEILING_FLOOR_BYTES, "a small cap is lifted to the floor");
  assert.equal(relayTunnelCeiling(DEFAULT_RELAY_MAX_BYTES), 2 * 1024 ** 3, "the 256 MiB default keeps its 8x ceiling");
  assert.equal(relayTunnelCeiling(RELAY_TUNNEL_CEILING_FLOOR_BYTES), RELAY_TUNNEL_CEILING_FACTOR * RELAY_TUNNEL_CEILING_FLOOR_BYTES);
});

test("a tunnel with a small relayMaxBytes is not cut at 8x the cap: the ceiling floor applies", { timeout: 10000 }, async () => {
  const cap = 1024;
  const exchange = 900; // under the cap; each upstream "ok" resets the per-exchange count
  const p = await exchangeTunnel(exchange, { relayMaxBytes: cap });
  try {
    const relay = await p.open(`relay.test:${p.upPort}`);
    for (let i = 0; i < 60; i++) assert.equal(await p.send(relay, exchange), true, `exchange ${i}`); // 54000 B, 52x the cap
    assert.ok(60 * exchange > RELAY_TUNNEL_CEILING_FACTOR * cap, "the total is over the old 8x ceiling");
    assert.equal(
      p.events.some((e) => e.outcome === "limit"),
      false,
    );
    relay.destroy();
  } finally {
    p.close();
  }
});

test("a relay tunnel whose count keeps resetting is still cut at RELAY_TUNNEL_CEILING_FACTOR x the cap", { timeout: 10000 }, async () => {
  const cap = 4000;
  const exchange = 3000; // under the cap; each upstream "ok" resets the per-exchange count
  const ceiling = RELAY_TUNNEL_CEILING_FACTOR * cap;
  const p = await exchangeTunnel(exchange, { relayMaxBytes: cap, relayTunnelCeilingBytes: ceiling });
  try {
    const relay = await p.open(`relay.test:${p.upPort}`);
    let cutAt = -1;
    for (let i = 0; i < 40 && cutAt < 0; i++) if (!(await p.send(relay, exchange))) cutAt = i;
    assert.ok(cutAt >= 0, "the tunnel was cut");
    assert.ok((cutAt + 1) * exchange > ceiling - 2 * exchange, "not cut before the ceiling is near");
    assert.deepEqual(
      p.events.filter((e) => e.outcome === "limit").map((e) => [e.limitKind, e.trafficClass]),
      [["bytes", "relay"]],
    );
  } finally {
    p.close();
  }
  // Negative control: sequential exchanges whose total stays under the ceiling are not cut.
  const q = await exchangeTunnel(exchange, { relayMaxBytes: cap, relayTunnelCeilingBytes: ceiling });
  try {
    const relay = await q.open(`relay.test:${q.upPort}`);
    for (let i = 0; i < 5; i++) assert.equal(await q.send(relay, exchange), true, `exchange ${i}`);
    assert.equal(
      q.events.some((e) => e.outcome === "limit"),
      false,
    );
    relay.destroy();
  } finally {
    q.close();
  }
});

test("one continuous body over a relay tunnel is cut near the ceiling although upstream bytes keep resetting the count", { timeout: 10000 }, async () => {
  const cap = 4000;
  const chunk = 1000;
  const ceiling = RELAY_TUNNEL_CEILING_FACTOR * cap;
  // The upstream answers one byte per received chunk before the body ends (an early interim response), so each reply resets the per-exchange count.
  const upstream = tcpServer((s) => {
    s.on("error", () => {});
    s.on("data", () => s.write("x"));
  });
  const upPort = await listen(upstream);
  const { events, writer } = sink();
  const server = createServer();
  const control = attachProxy(server, new Set(), {
    relay: new Set([`relay.test:${upPort}`]),
    hostAddresses: new Set(),
    auditedPublic: writer,
    relayMaxBytes: cap,
    relayTunnelCeilingBytes: ceiling,
    resolve: async () => ["8.8.8.8"],
    connect: () => new Socket().connect(upPort, "127.0.0.1"),
  });
  const port = await listen(server);
  const s = connect(port, "127.0.0.1");
  s.on("error", () => {});
  try {
    await once(s, "connect");
    s.write(`CONNECT relay.test:${upPort} HTTP/1.1\r\nHost: relay.test:${upPort}\r\n\r\n`);
    await once(s, "data");
    const closed = once(s, "close");
    let sent = 0;
    while (!s.destroyed && sent < 4 * ceiling) {
      s.write(Buffer.alloc(chunk, 120));
      sent += chunk;
      await new Promise((r) => setTimeout(r, 2));
    }
    await closed;
    assert.ok(sent < 4 * ceiling, "the tunnel was cut before the client finished");
    assert.deepEqual(
      events.filter((e) => e.outcome === "limit").map((e) => [e.limitKind, e.trafficClass]),
      [["bytes", "relay"]],
    );
    const row = events.find((e) => e.outcome === "limit")!;
    assert.ok(row.bytesIn! > 0 && row.bytesIn! <= ceiling + 2 * chunk, `bytesIn ${row.bytesIn} stops near the ceiling ${ceiling}`);
  } finally {
    s.destroy();
    control.close();
    server.closeAllConnections();
    server.close();
    upstream.close();
  }
});

test("the public byte cap stays cumulative over a tunnel's lifetime", { timeout: 10000 }, async () => {
  const KiB = 1024;
  const p = await exchangeTunnel(600 * KiB, { maxConnectionBytes: MiB });
  try {
    const pub = await p.open(`public.test:${p.upPort}`);
    assert.equal(await p.send(pub, 600 * KiB), true);
    assert.equal(await p.send(pub, 600 * KiB), false, "the second exchange takes the tunnel past 1 MiB");
    assert.deepEqual(
      p.events.filter((e) => e.outcome === "limit").map((e) => [e.limitKind, e.trafficClass]),
      [["bytes", "public"]],
    );
  } finally {
    p.close();
  }
});

// The listeners run with requestTimeout 0 and headersTimeout only counts from the first byte, so the pre-admission idle bound is
// what frees a silent socket's slot (DEFAULT_MAX_CONNECTIONS) in the sidecar.
test("a client that never completes its request is dropped after the unadmitted idle bound; an admitted silent tunnel is not", { timeout: 10000 }, async () => {
  assert.ok(DEFAULT_UNADMITTED_IDLE_TIMEOUT_MS > 0);
  const p = await tunnelProxy({ unadmittedIdleTimeoutMs: 100, relayIdleTimeoutMs: 60_000 });
  try {
    const silent = connect(p.port, "127.0.0.1");
    silent.on("error", () => {});
    const partial = connect(p.port, "127.0.0.1", () => partial.write(`CONNECT relay.test:${p.echoPort} HTTP/1.1\r\n`));
    partial.on("error", () => {});
    const relay = await p.open(`relay.test:${p.echoPort}`);
    await Promise.all([once(silent, "close"), once(partial, "close")]);
    // Both dropped sockets closed after the 100 ms bound; the tunnel admitted before then is still open and still relays.
    assert.equal(relay.destroyed, false);
    relay.write("still-here");
    const [echoed] = (await once(relay, "data")) as [Buffer];
    assert.equal(echoed.toString(), "still-here");
    assert.equal(
      p.events.some((e) => e.outcome === "limit"),
      false,
    );
    relay.destroy();
  } finally {
    p.close();
  }
});

test("an admitted absolute-form long-poll outlives the unadmitted idle bound while the client waits in silence", { timeout: 10000 }, async () => {
  const daemon = createServer((_req, res) => void setTimeout(() => res.end("late"), 400));
  const daemonPort = await listen(daemon);
  const { events, writer } = sink();
  const server = createServer({ requestTimeout: 0 });
  const control = attachProxy(server, new Set(), {
    relay: new Set([`relay.test:${daemonPort}`]),
    hostAddresses: new Set(),
    auditedPublic: writer,
    resolve: async () => ["127.0.0.1"],
    unsafeAllowLoopback: true,
    unadmittedIdleTimeoutMs: 100,
  });
  const port = await listen(server);
  try {
    const res = await post(port, `http://relay.test:${daemonPort}/v1/agents/a/inbox`, 0);
    assert.deepEqual(res, { status: 200, body: "late" });
    assert.equal(
      events.some((e) => e.outcome === "limit"),
      false,
    );
  } finally {
    control.close();
    server.closeAllConnections();
    server.close();
    daemon.close();
  }
});

test("a client dropped while its admission is still pending is recorded as limit idle, not complete", { timeout: 10000 }, async () => {
  const p = await tunnelProxy({ unadmittedIdleTimeoutMs: 100, resolve: () => new Promise<string[]>(() => {}) });
  try {
    const s = connect(p.port, "127.0.0.1", () => s.write(`CONNECT relay.test:${p.echoPort} HTTP/1.1\r\nHost: relay.test\r\n\r\n`));
    s.on("error", () => {});
    await once(s, "close");
    assert.deepEqual(
      p.events.filter((e) => e.phase === "outcome").map((e) => [e.outcome, e.limitKind, e.trafficClass]),
      [["limit", "idle", "relay"]],
    );
  } finally {
    p.close();
  }
});
