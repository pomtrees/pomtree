import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { listenHost, listenUi, makeServer } from "./server.ts";
import { SECRET, op, setup, spawnSpec } from "./test-setup.ts";

function http(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: s }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

test("budgetMicros must be a positive integer", async () => {
  const t = setup(async () => {});
  for (const bad of [0, 1.5, -1]) {
    const r = await t.operator("POST", "/v1/agents", { name: "w", task: "x", idempotencyKey: `b${bad}`, budgetMicros: bad });
    assert.equal(r.status, 400, String(bad));
  }
});

test("500 bodies do not leak the internal error message", async () => {
  const t = setup(async () => {});
  t.daemon.doctor = async () => {
    throw new Error("ENOENT /home/secret/path");
  };
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await handle(t.daemon, { method: "GET", url: "/v1/doctor", token: op });
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(r.body), /secret/);
  } finally {
    console.error = orig;
  }
});

test("fork fields are validated and operator-only", async () => {
  const t = setup(async () => {});
  assert.equal((await t.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "f1", fork: "yes" })).status, 400);
  assert.equal((await t.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "f2", fromCommit: 5 })).status, 400);
});

test("UI: CSP header, Secure cookie behind https, cross-origin cookie POST refused", async () => {
  const t = setup(async () => {});
  const { server, port } = await listenUi(t.daemon, "127.0.0.1", 0);
  try {
    const ui = await http(port, "/ui");
    assert.match(String(ui.headers["content-security-policy"]), /default-src 'none'/);
    const plain = await http(port, "/ui/login", { method: "POST", headers: { authorization: `Bearer ${op}` } });
    assert.doesNotMatch(String(plain.headers["set-cookie"]), /Secure/);
    const tls = await http(port, "/ui/login", { method: "POST", headers: { authorization: `Bearer ${op}`, "x-forwarded-proto": "https" } });
    assert.match(String(tls.headers["set-cookie"]), /; Secure/);
    const cookie = String(plain.headers["set-cookie"]).split(";")[0]!;
    const body = JSON.stringify({ task: "x", idempotencyKey: "o1" });
    const evil = await http(port, "/v1/agents", {
      method: "POST",
      body,
      headers: { cookie, origin: "http://evil.example", "content-type": "application/json" },
    });
    assert.equal(evil.status, 403);
    const same = await http(port, "/v1/agents", {
      method: "POST",
      body,
      headers: { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
    });
    assert.equal(same.status, 201);
    // A bogus Bearer header must not bypass the Origin check for cookie-authenticated requests.
    const sneaky = await http(port, "/v1/agents", {
      method: "POST",
      body,
      headers: { cookie, authorization: "Bearer junk", origin: "http://evil.example", "content-type": "application/json" },
    });
    assert.equal(sneaky.status, 403);
  } finally {
    server.close();
  }
});

test("host TCP endpoint serves only host-scoped /v1/messages", async () => {
  const t = setup(async () => {}, { messagingChannels: ["discord"] });
  const { server, port } = await listenHost(t.daemon, "127.0.0.1", 0);
  try {
    const ht = issueToken(SECRET, { scope: "host", channel: "discord" });
    assert.equal((await http(port, "/v1/messages?channel=discord", { headers: { authorization: `Bearer ${ht}` } })).status, 200);
    assert.equal((await http(port, "/v1/messages", { headers: { authorization: `Bearer ${op}` } })).status, 401);
    assert.equal((await http(port, "/v1/agents", { headers: { authorization: `Bearer ${ht}` } })).status, 404);
  } finally {
    server.close();
  }
});

test("SSE streams send heartbeats and are capped", async () => {
  const t = setup(async () => {});
  const server = makeServer(t.daemon, false, { heartbeatMs: 20, maxConnections: 5 });
  assert.equal(server.maxConnections, 5);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const chunks = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/live/events", headers: { authorization: `Bearer ${op}` } }, (res) => {
        let s = "";
        res.on("data", (d) => {
          s += d;
          if (s.includes(": hb")) {
            req.destroy();
            resolve(s);
          }
        });
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("no heartbeat")), 1500);
      req.end();
    });
    assert.match(chunks, /: hb/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("agent spawn: own-session fork allowed in scope, fromCommit/sessionRef refused with an actionable 403", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const a0 = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 10_000_000,
    idempotencyKey: "fa",
  });
  const a = await t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: "fa-run" });
  const token = t.daemon.agentToken(a.id, a.generation);
  const post = (body: object) => handle(t.daemon, { method: "POST", url: "/v1/agents", token, body: { task: "x", ...body } });
  for (const f of [{ fromCommit: "abc" }, { sessionRef: "s" }]) {
    const r = await post({ idempotencyKey: "k1", ...f });
    assert.equal(r.status, 403);
    assert.match(String((r.body as { error: string }).error), /operator-only.*fork/);
  }
  // fork passes the scope check; with no checkpoint the daemon answers 409 (not 403).
  assert.equal((await post({ idempotencyKey: "k2", fork: true })).status, 409);
});
