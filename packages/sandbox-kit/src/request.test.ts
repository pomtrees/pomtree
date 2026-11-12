import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { DEFAULT_USER_AGENT, type KitResponse, type RequestInit, buildHttpOptions, createRequest, openWebSocket } from "./request.ts";
import { redactError } from "./redact.ts";

const ok: KitResponse = { status: 200, headers: {}, body: new Uint8Array() };

function recorder() {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return ok;
  };
  return { calls, transport };
}

test("request: stamps the injected User-Agent on every call, replacing a caller-supplied one in any case", async () => {
  const r = recorder();
  const request = createRequest({ userAgent: "pomtree/1 ops@example.com", transport: r.transport });
  await request("https://a.example/x", { method: "GET" });
  await request("https://a.example/y", { method: "POST", headers: { "User-Agent": "adapter-own/9", Accept: "*/*" } });
  assert.deepEqual(
    r.calls.map((c) => c.init.headers?.["user-agent"]),
    ["pomtree/1 ops@example.com", "pomtree/1 ops@example.com"],
  );
  assert.equal(r.calls[1]?.init.headers?.Accept, "*/*");
  assert.ok(!Object.keys(r.calls[1]?.init.headers ?? {}).includes("User-Agent"), "no second, caller-cased copy");
});

test("request: the default User-Agent is pomtree; a blank injected value falls back to it", async () => {
  const r = recorder();
  await createRequest({ transport: r.transport })("https://a.example/", { method: "GET" });
  await createRequest({ userAgent: "  ", transport: r.transport })("https://a.example/", { method: "GET" });
  assert.deepEqual(
    r.calls.map((c) => c.init.headers?.["user-agent"]),
    [DEFAULT_USER_AGENT, DEFAULT_USER_AGENT],
  );
});

test("request: TLS options are per call; a second call without them carries none", async () => {
  const r = recorder();
  const request = createRequest({ transport: r.transport });
  const tls = { ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" };
  await request("https://k8s.example/", { method: "GET", tls });
  await request("https://other.example/", { method: "GET" });
  assert.deepEqual(r.calls[0]?.init.tls, tls);
  assert.equal(r.calls[1]?.init.tls, undefined);
});

test("request: the default transport sends the stamped User-Agent over the wire and returns status, headers and body", async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers["user-agent"]);
    res.setHeader("x-thing", "a");
    res.end("hello");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/p`;
    const res = await createRequest({ userAgent: "ua-under-test" })(url, { method: "POST", body: "x", headers: { "user-agent": "overridden" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-thing"], "a");
    assert.equal(Buffer.from(res.body).toString(), "hello");
    assert.deepEqual(seen, ["ua-under-test"]);
  } finally {
    server.close();
  }
});

test("request: failures name the cause and the action, drop the query string and never carry a credential", async () => {
  const secret = ["tok", "s3cr3tvalue"].join("_");
  const err = await createRequest()(`http://127.0.0.1:1/p?token=${secret}`, { method: "GET" }).then(
    () => undefined,
    (e: Error) => e,
  );
  assert.ok(err, "connection refused must reject");
  assert.match(err.message, /^request GET http:\/\/127\.0\.0\.1:1\/p failed: connect ECONNREFUSED/);
  assert.match(err.message, /Check the endpoint address/);
  assert.ok(!err.message.includes(secret), err.message);
});

test("request: TLS options over plain http and unsupported schemes are refused with an action", async () => {
  const request = createRequest();
  await assert.rejects(request("http://127.0.0.1:1/", { method: "GET", tls: { ca: "x" } }), /plain http; use an https: URL or drop the tls option/);
  await assert.rejects(request("ftp://example.com/", { method: "GET" }), /unsupported scheme.*use an http: or https: URL/);
});

test("request: upgrade resolves with the raw socket on 101", async () => {
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const res = await createRequest()(url, { method: "GET", upgrade: true, headers: { connection: "Upgrade", upgrade: "x" } });
    assert.equal(res.status, 101);
    assert.ok(res.socket);
    res.socket.destroy();
  } finally {
    server.close();
  }
});

test("openWebSocket: passes stamped headers to the constructor", () => {
  const args: unknown[] = [];
  class Fake {
    constructor(...a: unknown[]) {
      args.push(...a);
    }
  }
  openWebSocket("wss://x.example/ws", { headers: { Authorization: "Bearer <T>", "User-Agent": "own" }, userAgent: "ua-ws", WebSocketImpl: Fake as never });
  assert.equal(args[0], "wss://x.example/ws");
  assert.deepEqual(args[1], { headers: { Authorization: "Bearer <T>", "user-agent": "ua-ws" } });
});

test("openWebSocket: the real global WebSocket sends the headers on the handshake", async () => {
  const seen: { ua?: string; auth?: string } = {};
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    seen.ua = req.headers["user-agent"];
    seen.auth = req.headers.authorization;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const ws = openWebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, { headers: { Authorization: "Bearer <T>" }, userAgent: "ua-ws" });
    await new Promise((resolve) => {
      ws.addEventListener("error", resolve);
      ws.addEventListener("close", resolve);
    });
    assert.deepEqual(seen, { ua: "ua-ws", auth: "Bearer <T>" });
  } finally {
    server.close();
  }
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

test("buildHttpOptions: copies only ca/cert/key; a hostile tls object cannot override agent, headers or verification", () => {
  const agent = { hostile: true };
  const hostile = { ca: "CA", cert: "CERT", key: "KEY", agent, rejectUnauthorized: false, headers: { "user-agent": "evil" }, servername: "x" };
  const o = buildHttpOptions({ method: "GET", headers: { "user-agent": "stamped" }, tls: hostile as never });
  assert.equal(o.agent, false);
  assert.deepEqual(o.headers, { "user-agent": "stamped" });
  assert.equal(o.rejectUnauthorized, undefined);
  assert.equal(o.servername, undefined);
  assert.deepEqual([o.ca, o.cert, o.key], ["CA", "CERT", "KEY"]);
  assert.deepEqual(buildHttpOptions({ method: "GET" }).ca, undefined, "no tls means no TLS keys");
});

test("buildHttpOptions: a non-string PEM value is refused with an action", () => {
  assert.throws(() => buildHttpOptions({ method: "GET", tls: { ca: Buffer.from("x") as never } }), /tls\.ca must be a non-empty PEM string; pass the PEM text/);
});

test("request: a 302 is returned as is, with its Location, and not followed", async () => {
  let hits = 0;
  const { server, url } = await listen((_req, res) => {
    hits++;
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  try {
    const res = await createRequest()(url, { method: "GET" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/elsewhere");
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("request: a response that streams without end is cut at maxBytes with cause and action", async () => {
  const chunk = Buffer.alloc(64 * 1024, 1);
  const { server, url } = await listen((_req, res) => {
    let open = true;
    res.on("close", () => {
      open = false;
    });
    const pump = () => {
      while (open && res.write(chunk));
      if (open) res.once("drain", pump);
    };
    pump();
  });
  try {
    await assert.rejects(createRequest({ maxBytes: 100_000 })(url, { method: "GET" }), /response body exceeded 100000 bytes\. Raise maxBytes/);
    await assert.rejects(createRequest()(url, { method: "GET", maxBytes: 70_000 }), /exceeded 70000 bytes/, "per-call value wins");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("request: a body exactly at maxBytes is accepted (negative control for the cap)", async () => {
  const { server, url } = await listen((_req, res) => res.end("x".repeat(100)));
  try {
    const res = await createRequest()(url, { method: "GET", maxBytes: 100 });
    assert.equal(res.body.length, 100);
  } finally {
    server.close();
  }
});

test("request: a server that never responds is cut at timeoutMs with cause and action", async () => {
  const { server, url } = await listen(() => {});
  try {
    await assert.rejects(
      createRequest()(url, { method: "GET", timeoutMs: 30 }),
      /no complete response within 30 ms\. Check that the endpoint is reachable.*raise timeoutMs/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("request: defaults give plain requests a timeout and upgrades none; per-call values win", async () => {
  const r = recorder();
  const request = createRequest({ transport: r.transport });
  await request("https://a.example/", { method: "GET" });
  await request("https://a.example/", { method: "GET", upgrade: true });
  await request("https://a.example/", { method: "GET", timeoutMs: 5, maxBytes: 7 });
  assert.deepEqual(
    r.calls.map((c) => [c.init.timeoutMs, c.init.maxBytes]),
    [
      [60_000, 16 * 1024 * 1024],
      [undefined, 16 * 1024 * 1024],
      [5, 7],
    ],
  );
});

test("request: aborting via signal rejects with a cause and action", async () => {
  const controller = new AbortController();
  const { server, url } = await listen(() => controller.abort());
  try {
    await assert.rejects(createRequest()(url, { method: "GET", signal: controller.signal }), /failed: .*abort.*Check the endpoint address/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("redactError: a secret inside an error cause never reaches the message", () => {
  const secret = ["tok", "c4us3secret"].join("_");
  const e = redactError(new Error("outer", { cause: new Error(`inner saw ${secret}`) }), { secrets: [secret] });
  assert.ok(e.message.includes("inner saw"), e.message);
  assert.ok(!e.message.includes(secret), e.message);
});

test("request: the bound openWebSocket carries the shared User-Agent and a caller cannot override it", () => {
  const args: unknown[] = [];
  class Fake {
    constructor(...a: unknown[]) {
      args.push(...a);
    }
  }
  createRequest({ userAgent: "shared-ua" }).openWebSocket("wss://x.example/", { headers: { "User-Agent": "own" }, WebSocketImpl: Fake as never });
  assert.deepEqual(args[1], { headers: { "user-agent": "shared-ua" } });
});
