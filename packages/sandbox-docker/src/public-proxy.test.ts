import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type RequestOptions, type IncomingMessage } from "node:http";
import { connect, createServer as tcpServer, type AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachProxy, resolveAllowed } from "./proxy.ts";
import { DiskEgressAudit, FileEgressAuditWriter, prepareEgressSpool, type EgressAuditEvent } from "./audit.ts";

function get(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
test("audited public HTTP uses pinned validated IP, fsync seam precedes dial, metadata redacts secrets and redirects revalidate", async () => {
  const events: EgressAuditEvent[] = [];
  const upstream = createServer((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/metadata" });
    res.end("local fixture");
  });
  const upPort = await listen(upstream);
  const proxy = createServer();
  const dialed: string[] = [];
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async () => ["8.8.8.8"],
    request: ((options: RequestOptions, cb: (res: IncomingMessage) => void) => {
      assert.equal(events.at(-1)?.phase, "admission");
      assert.equal(events.at(-1)?.outcome, "allowed");
      dialed.push(options.host as string);
      return request({ ...options, host: "127.0.0.1", port: upPort }, cb);
    }) as typeof request,
  });
  const port = await listen(proxy);
  try {
    assert.deepEqual(await get(port, "http://public.test:8081/private-token?secret=hello"), { status: 302, body: "local fixture" });
    assert.equal((await get(port, "http://169.254.169.254/metadata")).status, 403);
    assert.deepEqual(dialed, ["8.8.8.8"]);
    assert.ok(events.some((e) => e.status === 302));
    assert.doesNotMatch(JSON.stringify(events), /private-token|secret|hello|metadata/);
    assert.ok(events.some((e) => e.url === "http://public.test:8081/[redacted]"));
  } finally {
    control.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.close();
  }
});
test("public policy denies private literals, metadata, host gateway, mixed DNS, host-owned public addresses and IPv6/reserved", async () => {
  for (const host of [
    "10.0.0.1",
    "172.17.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "ff00::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "3fff::1",
    "100::1",
  ]) {
    assert.equal(await resolveAllowed(host, async () => [], new Set()), undefined, host);
  }
  assert.equal(await resolveAllowed("mixed.test", async () => ["8.8.8.8", "10.0.0.1"], new Set()), undefined);
  assert.equal(await resolveAllowed("host-public.test", async () => ["8.8.8.8"], new Set(["8.8.8.8"]), false, false), undefined);
  const proxy = createServer();
  let dials = 0;
  const control = attachProxy(proxy, new Set(["host.docker.internal:80"]), {
    hostAddresses: new Set<string>(),
    auditedPublic: { append() {} },
    resolve: async () => ["8.8.8.8"],
    request: (() => {
      dials++;
      throw Error("not allowed");
    }) as typeof request,
  });
  const port = await listen(proxy);
  try {
    for (const name of ["host.docker.internal", "gateway.docker.internal", "localhost", "x.localhost"])
      assert.equal((await get(port, `http://${name}/`)).status, 403);
    assert.equal(dials, 0);
  } finally {
    control.close();
    proxy.close();
  }
});
test("relay exception is exact endpoint, never grants metadata/loopback and allowlist does not grant private", async () => {
  const proxy = createServer();
  const events: EgressAuditEvent[] = [];
  const control = attachProxy(proxy, new Set(["private.test:80"]), {
    hostAddresses: new Set<string>(),
    relay: new Set(["private.test:81"]),
    resolve: async () => ["10.0.0.1"],
    audit: {
      append: (e) => {
        events.push(e);
      },
    },
    request: (() => {
      throw Error("fixture dial");
    }) as typeof request,
  });
  const port = await listen(proxy);
  try {
    assert.equal((await get(port, "http://private.test:80/")).status, 403);
    await assert.rejects(get(port, "http://private.test:81/"));
    assert.ok(events.some((e) => e.phase === "admission" && e.outcome === "allowed" && e.peer === "10.0.0.1"));
    for (const ip of ["169.254.169.254", "127.0.0.1", "::1"]) assert.equal(await resolveAllowed("relay", async () => [ip], new Set(), false, true), undefined);
  } finally {
    control.close();
    proxy.close();
  }
});
test("stalled DNS retains a bounded resolver reservation after deadline; no late admission or new DNS queue", { timeout: 2000 }, async () => {
  let lookups = 0;
  const events: EgressAuditEvent[] = [];
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    maxConnections: 1,
    deadlineMs: 20,
    resolve: async () => {
      lookups++;
      return new Promise<string[]>(() => {});
    },
    connect: () => {
      throw Error("must not dial");
    },
    request: (() => {
      throw Error("must not dial");
    }) as typeof request,
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(get(port, "http://stalled.test/"));
    assert.equal((await get(port, "http://another.test/")).status, 403);
    assert.equal(lookups, 1);
    assert.equal(
      events.some((e) => e.phase === "admission" && e.outcome === "allowed"),
      false,
    );
    assert.ok(events.some((e) => e.outcome === "limit"));
  } finally {
    control.close();
    proxy.close();
  }
});

test("spool admission failure prevents dial and permanently fails closed", async () => {
  let dials = 0;
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append() {
        throw Error("disk full");
      },
    },
    resolve: async () => ["8.8.8.8"],
    request: (() => {
      dials++;
      throw Error("not reached");
    }) as typeof request,
  });
  const port = await listen(proxy);
  try {
    await assert.rejects(get(port, "http://public.test/"));
    await assert.rejects(get(port, "http://public.test/"));
    assert.equal(dials, 0);
  } finally {
    control.close();
    proxy.close();
  }
});
test("CONNECT deadline/cancellation and late audit keep connection metadata only; outcome failure closes flow", { timeout: 3000 }, async () => {
  const upstream = tcpServer((s) => s.pipe(s));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = (upstream.address() as AddressInfo).port;
  for (const mode of ["deadline", "cancel", "audit-failure"]) {
    const events: EgressAuditEvent[] = [];
    const abort = new AbortController();
    const proxy = createServer();
    const control = attachProxy(proxy, new Set(), {
      hostAddresses: new Set<string>(),
      // Only the deadline mode may trip the deadline. The cancel and audit-failure modes keep the default 120 s, far past the
      // test's own timeout, so under load a short deadline can never fire before the abort or the failed append (TODO(load-flakes)).
      ...(mode === "deadline" ? { deadlineMs: 40 } : {}),
      signal: abort.signal,
      auditedPublic: {
        append(e) {
          if (mode === "audit-failure" && e.outcome === "connected") throw Error("fsync failed");
          events.push(e);
        },
      },
      resolve: async () => ["8.8.8.8"],
      connect: (_port, ip) => {
        assert.equal(ip, "8.8.8.8");
        return connect(upPort, "127.0.0.1");
      },
    });
    const port = await listen(proxy);
    try {
      await new Promise<void>((resolve, reject) => {
        const client = connect(port, "127.0.0.1", () => client.write("CONNECT public.test:8443 HTTP/1.1\r\nHost: public.test:8443\r\n\r\n"));
        client.on("data", () => {
          if (mode === "cancel") abort.abort();
        });
        client.on("close", resolve);
        client.on("error", reject);
      });
      assert.equal(events[0]?.phase, "admission");
      assert.ok(events.every((e) => e.url === undefined && e.status === undefined));
      if (mode !== "audit-failure") assert.equal(events.at(-1)?.outcome, mode === "deadline" ? "limit" : "cancelled");
    } finally {
      control.close();
      proxy.close();
    }
  }
  upstream.close();
});

test("oversized host over HTTP and CONNECT is denied with a bounded record; the spool still reopens, reads and acks", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-oversized-")));
  const identity = { sandbox: "sb", agent: "worker", host: "host", generation: 1 };
  const { logDir } = prepareEgressSpool(root, "sb", { allow: [], relay: [], identity });
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: new FileEgressAuditWriter(logDir, identity),
    resolve: async () => ["8.8.8.8"],
    request: (() => {
      throw Error("must not dial");
    }) as typeof request,
    connect: () => {
      throw Error("must not dial");
    },
  });
  const port = await listen(proxy);
  const long = `${"a".repeat(600)}.com`;
  try {
    assert.equal((await get(port, `http://${long}/`)).status, 403);
    const connectStatus = await new Promise<string>((resolve, reject) => {
      const client = connect(port, "127.0.0.1", () => client.write(`CONNECT ${long}:443 HTTP/1.1\r\nHost: ${long}:443\r\n\r\n`));
      let data = "";
      client.on("data", (d) => {
        data += d;
      });
      client.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
      client.on("error", reject);
    });
    assert.match(connectStatus, /403/);
    // A healthy request after the oversized ones still works: the writer did not fail closed.
    assert.equal((await get(port, "http://169.254.169.254/")).status, 403);
    const reopened = new FileEgressAuditWriter(logDir, identity);
    reopened.append({ connection: "c", phase: "admission", transport: "connect", authority: "public.test:443", outcome: "allowed" });
    const disk = new DiskEgressAudit({ root });
    const rows = await disk.read("sb", 0);
    assert.ok(rows.length >= 5);
    assert.ok(rows.every((r) => r.authority.length <= 512));
    assert.ok(rows.some((r) => r.transport === "http" && r.outcome === "denied" && r.authority.endsWith(":80")));
    assert.ok(rows.some((r) => r.transport === "connect" && r.outcome === "denied" && r.authority.endsWith(":443")));
    await disk.ack("sb", rows.at(-1)!.sequence);
  } finally {
    control.close();
    proxy.closeAllConnections();
    proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-web public ports stay allowed (TODO(egress)) and the audit record carries the port", async () => {
  const events: EgressAuditEvent[] = [];
  const upstream = tcpServer((s) => s.pipe(s));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createServer();
  const control = attachProxy(proxy, new Set(), {
    hostAddresses: new Set<string>(),
    auditedPublic: {
      append: (e) => {
        events.push(e);
      },
    },
    resolve: async () => ["8.8.8.8"],
    connect: () => connect((upstream.address() as AddressInfo).port, "127.0.0.1"),
  });
  const port = await listen(proxy);
  try {
    await new Promise<void>((resolve, reject) => {
      const client = connect(port, "127.0.0.1", () => client.write("CONNECT mail.public.test:25 HTTP/1.1\r\nHost: mail.public.test:25\r\n\r\n"));
      client.on("data", () => client.destroy());
      client.on("close", resolve);
      client.on("error", reject);
    });
    assert.ok(events.some((e) => e.phase === "admission" && e.outcome === "allowed" && e.authority === "mail.public.test:25" && e.peer === "8.8.8.8"));
  } finally {
    control.close();
    proxy.close();
    upstream.close();
  }
});
