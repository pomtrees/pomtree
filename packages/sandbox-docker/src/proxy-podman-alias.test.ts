// Rootless Podman on pasta (--map-host-loopback): the sidecar sees the daemon host's loopback as 169.254.1.2, and also still reaches
// docker0, br-*, LAN and wildcard-bound host listeners. Only an exact relay grant for host.docker.internal:<port> may use the alias.
import test from "node:test";
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { createServer, request, type RequestOptions } from "node:http";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { attachProxy, parseAllow, PASTA_HOST_LOOPBACK_ALIAS, resolveAllowed } from "./proxy.ts";

const ALIAS = PASTA_HOST_LOOPBACK_ALIAS;
const NAMES: Record<string, string[]> = {
  "host.docker.internal": [ALIAS],
  "lan-name.test": ["10.11.12.13"],
  "docker0.test": ["172.17.0.1"],
  "bridge.test": ["172.18.0.1"],
};
const resolve = async (h: string): Promise<string[]> => NAMES[h] ?? ["93.184.216.34"];
const hostAddresses = new Set(["10.11.12.13", "172.17.0.1", "172.18.0.1"]);

test("allow: [] denies the alias, loopback, a LAN host address and docker0 / br-* addresses, by literal and by name", async () => {
  for (const h of [ALIAS, "127.0.0.1", "10.11.12.13", "172.17.0.1", "172.18.0.1", "host.docker.internal", "lan-name.test", "docker0.test", "bridge.test"]) {
    assert.equal(await resolveAllowed(h, resolve, hostAddresses, false, false), undefined, h);
  }
});

test("a relay grant reaches the alias (and its IPv4-mapped spelling) but no other hard-class or host address", async () => {
  assert.equal(await resolveAllowed("host.docker.internal", resolve, hostAddresses, false, true), ALIAS);
  assert.equal(await resolveAllowed("host.docker.internal", async () => [`::ffff:${ALIAS}`], hostAddresses, false, true), `::ffff:${ALIAS}`);
  for (const ip of ["169.254.1.3", "169.254.169.254", "127.0.0.1", "0.0.0.0"]) {
    assert.equal(await resolveAllowed("x.test", async () => [ip], hostAddresses, false, true), undefined, ip);
  }
});

test("a relay name other than host.docker.internal never reaches the alias, in any spelling", async () => {
  for (const ip of [ALIAS, `::ffff:${ALIAS}`]) {
    assert.equal(await resolveAllowed("api.internal", async () => [ip], hostAddresses, false, true), undefined, ip);
  }
});

test("host.docker.internal reaches only the plain and IPv4-mapped alias, not its 6to4, NAT64 or IPv4-compatible spellings", async () => {
  for (const ip of ["2002:a9fe:0102::", "64:ff9b::a9fe:102", "::169.254.1.2", "::a9fe:102"]) {
    assert.equal(await resolveAllowed("host.docker.internal", async () => [ip], hostAddresses, false, true), undefined, ip);
  }
});

test("the alias is not reachable as a non-relay destination even when a public name also resolves to it", async () => {
  assert.equal(await resolveAllowed("evil.test", async () => ["93.184.216.34", ALIAS], hostAddresses, false, false), undefined);
});

async function status(opts: { allow: string[]; relay: string[]; target: string }): Promise<{ status: number; dials: number }> {
  let dials = 0;
  const proxy = createServer();
  const control = attachProxy(proxy, parseAllow(opts.allow.join(",")), {
    relay: parseAllow(opts.relay.join(",")),
    hostAddresses,
    resolve,
    request: ((o: RequestOptions, cb: never) => {
      dials++;
      return request({ ...o, host: "127.0.0.1", port: 1 }, cb);
    }) as unknown as typeof request,
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const port = (proxy.address() as AddressInfo).port;
    const code = await new Promise<number>((done) => {
      const req = request({ host: "127.0.0.1", port, path: opts.target, agent: false }, (res) => {
        res.resume();
        res.on("end", () => done(res.statusCode ?? 0));
      });
      req.on("error", () => done(0));
      req.end();
    });
    return { status: code, dials };
  } finally {
    control.close();
    proxy.closeAllConnections();
    proxy.close();
  }
}

test("through the proxy: a relay for host.docker.internal:8080 dials; another port on the alias and a literal alias do not", async () => {
  const granted = await status({ allow: [], relay: ["host.docker.internal:8080"], target: "http://host.docker.internal:8080/" });
  assert.equal(granted.dials, 1);
  assert.notEqual(granted.status, 403);
  assert.equal((await status({ allow: [], relay: ["host.docker.internal:8080"], target: "http://host.docker.internal:9090/" })).status, 403);
  assert.equal((await status({ allow: [], relay: ["host.docker.internal:8080"], target: `http://${ALIAS}:8080/` })).status, 403);
  assert.equal((await status({ allow: [], relay: ["host.docker.internal:8080"], target: "http://lan-name.test:8080/" })).status, 403);
});

test("through the proxy: allow-host grants exactly host:port, not another port, another host or an IP literal", async () => {
  const ok = await status({ allow: ["api.example.test:443"], relay: [], target: "http://api.example.test:443/" });
  assert.equal(ok.dials, 1);
  for (const target of ["http://api.example.test:444/", "http://other.example.test:443/", "http://93.184.216.34:443/", `http://${ALIAS}:443/`]) {
    assert.equal((await status({ allow: ["api.example.test:443"], relay: [], target })).status, 403, target);
  }
});

const osResolve = async (h: string): Promise<string[]> => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address);

test("a zone-suffixed answer is never the alias, even for host.docker.internal under a relay grant", async () => {
  for (const ip of [`::ffff:${ALIAS}%lo`, `::ffff:a9fe:102%eth0`, `${ALIAS}%lo`]) {
    assert.equal(await resolveAllowed("host.docker.internal", async () => [ip], hostAddresses, false, true), undefined, ip);
  }
});

test("alias spellings that are not a relay to host.docker.internal are denied, with and without a relay grant", async () => {
  // Numeric spellings go through the OS resolver, which reads them as inet_aton forms of the alias.
  const nonRelay = [
    "::ffff:a9fe:102",
    "2002:a9fe:0102::",
    "64:ff9b::a9fe:102",
    "2851995906",
    "0251.0376.01.02",
    "0xa9fe0102",
    "169.254.258",
    "host.docker.internal.",
    "[::ffff:169.254.1.2]",
    "[::ffff:a9fe:102]",
    "fe80::1",
    "[fe80::1]",
    "::",
    "::1",
    "[::1]",
  ];
  for (const h of nonRelay) {
    for (const relay of [false, true]) {
      assert.equal(await resolveAllowed(h, osResolve, hostAddresses, false, relay), undefined, `${h} relay=${relay}`);
    }
  }
  for (const h of ["HOST.DOCKER.INTERNAL", "Host.Docker.Internal"]) {
    assert.equal(await resolveAllowed(h, resolve, hostAddresses, false, false), undefined, h);
  }
});

test("hostAddresses alone denies a public-class address without a relay grant, and a relay grant lifts it", async () => {
  const pub = "93.184.216.34";
  const owned = new Set([pub]);
  assert.equal(await resolveAllowed("a.test", async () => [pub], owned, false, false), undefined);
  assert.equal(await resolveAllowed(pub, async () => [], owned, false, false), undefined);
  assert.equal(await resolveAllowed("a.test", async () => [pub], new Set(), false, false), pub, "control: not host-owned");
  assert.equal(await resolveAllowed("a.test", async () => [pub], owned, false, true), pub, "relay grant is exempt from host ownership");
});

async function viaProxy(opts: { relay: string[]; allow?: string[]; method: "CONNECT" | "GET"; target: string; upstream: number }) {
  const dials: Array<[number, string]> = [];
  const proxy = createServer();
  const control = attachProxy(proxy, parseAllow((opts.allow ?? []).join(",")), {
    relay: parseAllow(opts.relay.join(",")),
    hostAddresses,
    resolve,
    connect: ((port: number, host: string) => {
      dials.push([port, host]);
      return createConnection(opts.upstream, "127.0.0.1");
    }) as unknown as (port: number, host: string) => Socket,
    request: ((o: RequestOptions, cb: never) => {
      dials.push([Number(o.port), String(o.host)]);
      return request({ ...o, host: "127.0.0.1", port: opts.upstream }, cb);
    }) as unknown as typeof request,
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const port = (proxy.address() as AddressInfo).port;
    const res = await new Promise<{ status: number; location?: string }>((done) => {
      const req = request({ host: "127.0.0.1", port, method: opts.method, path: opts.target, agent: false });
      req.on("connect", (r, sock) => {
        sock.destroy();
        done({ status: r.statusCode ?? 0 });
      });
      req.on("response", (r) => {
        r.resume();
        r.on("end", () => done({ status: r.statusCode ?? 0, location: r.headers.location }));
      });
      req.on("error", () => done({ status: 0 }));
      req.end();
    });
    return { ...res, dials };
  } finally {
    control.close();
    proxy.closeAllConnections();
    proxy.close();
  }
}

test("CONNECT: host.docker.internal on the granted port is admitted, another port and the alias literal are denied", async () => {
  const sink = createTcpServer((s) => s.on("error", () => {}));
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const upstream = (sink.address() as AddressInfo).port;
  try {
    const relay = ["host.docker.internal:8080"];
    const ok = await viaProxy({ relay, method: "CONNECT", target: "host.docker.internal:8080", upstream });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.dials, [[8080, ALIAS]]);
    for (const target of ["host.docker.internal:9090", `${ALIAS}:8080`, "lan-name.test:8080"]) {
      const r = await viaProxy({ relay, method: "CONNECT", target, upstream });
      assert.equal(r.status, 403, target);
      assert.deepEqual(r.dials, [], target);
    }
  } finally {
    sink.close();
  }
});

test("a redirect from the relayed target to the alias is relayed to the client, not followed", async () => {
  const target = createServer((_req, res) => {
    res.writeHead(302, { location: `http://${ALIAS}:8080/secret` });
    res.end();
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  try {
    const r = await viaProxy({
      relay: ["host.docker.internal:8080"],
      method: "GET",
      target: "http://host.docker.internal:8080/",
      upstream: (target.address() as AddressInfo).port,
    });
    assert.equal(r.status, 302);
    assert.equal(r.location, `http://${ALIAS}:8080/secret`);
    assert.deepEqual(r.dials, [[8080, ALIAS]], "exactly one dial: the redirect is not followed");
  } finally {
    target.close();
    target.closeAllConnections();
  }
});
