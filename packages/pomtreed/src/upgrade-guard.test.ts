import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { issueToken, issueUiCookie } from "./auth.ts";
import type { ReqCtx } from "./server.ts";
import { SECRET, op, setup, spawnSpec, until } from "./test-setup.ts";
import { authorizeUpgrade, closeThenDestroy, completeHandshake, startKeepalive, writeFrames } from "./upgrade-guard.ts";
import { WsConnection } from "./websocket.ts";

const PATH = /^\/v1\/agents\/([^/]+)\/thing$/;
const msg = (id: string, state: string) => `thing unavailable: ${id} is ${state}`;
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const HOST = "127.0.0.1:1";

async function fixture() {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const mk = async (name: string) =>
    t.daemon.deps.registry.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 1_000, idempotencyKey: `k-${name}` });
  const pending = await mk("pending");
  const nosb = await mk("nosb");
  const nosbRunning = await t.daemon.deps.registry.transition(nosb.id, nosb.generation, "running", { idempotencyKey: "r-nosb" });
  const ok = await mk("ok");
  const okRunning = await t.daemon.deps.registry.transition(ok.id, ok.generation, "running", { idempotencyKey: "r-ok" });
  await t.daemon.deps.registry.setSandbox(ok.id, okRunning.generation, "sb-ok", "sb-set");
  return { t, pending, nosb: nosbRunning, ok: okRunning };
}

function call(f: Awaited<ReturnType<typeof fixture>>, o: { url?: string; method?: string; headers?: Record<string, string>; restricted?: boolean } = {}) {
  const socket = new PassThrough();
  let out = "";
  socket.on("data", (d) => {
    out += d.toString();
  });
  const headers = {
    host: HOST,
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": KEY,
    authorization: `Bearer ${op}`,
    origin: `http://${HOST}`,
    ...o.headers,
  };
  const req = { url: o.url ?? `/v1/agents/${f.ok.id}/thing`, method: o.method ?? "GET", headers } as unknown as IncomingMessage;
  const ctx: ReqCtx = { principal: null, hadCredential: false };
  const verdict = authorizeUpgrade(f.t.daemon, PATH, msg, o.restricted ?? false, req, socket, ctx);
  const outText = async () => {
    await verdict;
    await new Promise((r) => setImmediate(r));
    return out;
  };
  return { verdict, ctx, socket, out: outText };
}

async function refused(r: ReturnType<typeof call>, status: number, error: string, extra: Record<string, unknown> = {}) {
  const v = await r.verdict;
  assert.deepEqual(v, { ok: false, status });
  assert.equal(r.ctx.error, error);
  const text = await r.out();
  assert.ok(text.startsWith(`HTTP/1.1 ${status} `), text);
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("\r\n\r\n") + 4)), { error, ...extra });
}

test("guard: restricted listener and non-matching path are 404 before anything else", async () => {
  const f = await fixture();
  await refused(call(f, { restricted: true }), 404, "not found");
  await refused(call(f, { url: "/v1/agents/x/other" }), 404, "not found");
  const r = call(f, { restricted: true }); // default headers carry a valid operator Bearer token
  await refused(r, 404, "not found");
  assert.equal(r.ctx.hadCredential, false); // refused before credentials are looked at
  assert.equal(r.ctx.principal, null);
});

test("guard: a route regex without an id capture and a malformed % escape are 404", async () => {
  const f = await fixture();
  const noCapture = /^\/v1\/agents\/[^/]+\/thing$/;
  const socket = new PassThrough();
  const headers = {
    host: HOST,
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": KEY,
    authorization: `Bearer ${op}`,
    origin: `http://${HOST}`,
  };
  const req = { url: `/v1/agents/${f.ok.id}/thing`, method: "GET", headers } as unknown as IncomingMessage;
  const ctx: ReqCtx = { principal: null, hadCredential: false };
  assert.deepEqual(await authorizeUpgrade(f.t.daemon, noCapture, msg, false, req, socket, ctx), { ok: false, status: 404 });
  assert.equal(ctx.error, "not found");
  await refused(call(f, { url: "/v1/agents/%E0%A4%A/thing" }), 404, "not found");
});

test("guard: upgrade header failures are 405, 400 and 426", async () => {
  const f = await fixture();
  await refused(call(f, { method: "POST" }), 405, "method must be GET");
  await refused(call(f, { headers: { upgrade: "h2c" } }), 400, "Upgrade: websocket required");
  await refused(call(f, { headers: { "sec-websocket-version": "8" } }), 426, "Sec-WebSocket-Version: 13 required");
});

test("guard: no credential or a bad one is 401 and records the credential flag", async () => {
  const f = await fixture();
  const none = call(f, { headers: { authorization: "" } });
  await refused(none, 401, "missing or invalid token");
  assert.equal(none.ctx.hadCredential, false);
  const bad = call(f, { headers: { authorization: "Bearer op.nope" } });
  await refused(bad, 401, "missing or invalid token");
  assert.equal(bad.ctx.hadCredential, true);
  const cookie = call(f, { headers: { authorization: "", cookie: "pomtreed_ui=1.bad" } });
  await refused(cookie, 401, "missing or invalid token");
  assert.equal(cookie.ctx.hadCredential, true);
});

test("guard: a non-operator scope is 403", async () => {
  const f = await fixture();
  const agentTok = issueToken(SECRET, { scope: "agent", agent: f.ok.id, generation: f.ok.generation, expiry: Date.now() + 60_000 });
  const r = call(f, { headers: { authorization: `Bearer ${agentTok}` } });
  await refused(r, 403, "operator scope required");
  assert.equal(r.ctx.principal?.scope, "agent");
});

test("guard: Origin must be present and equal Host", async () => {
  const f = await fixture();
  await refused(call(f, { headers: { origin: "http://evil.example" } }), 403, "origin not allowed");
  await refused(call(f, { headers: { origin: "" } }), 403, "origin not allowed");
  await refused(call(f, { headers: { origin: "null" } }), 403, "origin not allowed");
  await refused(call(f, { headers: { origin: "not a url" } }), 403, "origin not allowed");
  // an absent header (not just an empty one) is refused too
  const socket = new PassThrough();
  const headers: Record<string, string> = {
    host: HOST,
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": KEY,
    authorization: `Bearer ${op}`,
  };
  const ctx: ReqCtx = { principal: null, hadCredential: false };
  const req = { url: `/v1/agents/${f.ok.id}/thing`, method: "GET", headers } as unknown as IncomingMessage;
  assert.deepEqual(await authorizeUpgrade(f.t.daemon, PATH, msg, false, req, socket, ctx), { ok: false, status: 403 });
  assert.equal(ctx.error, "origin not allowed");
});

test("guard: unknown agent is 404, a non-running or sandbox-less agent is 409 with its state", async () => {
  const f = await fixture();
  await refused(call(f, { url: "/v1/agents/nope/thing" }), 404, "no such agent: nope");
  await refused(call(f, { url: `/v1/agents/${f.pending.id}/thing` }), 409, msg(f.pending.id, "pending"), { state: "pending" });
  await refused(call(f, { url: `/v1/agents/${f.nosb.id}/thing` }), 409, msg(f.nosb.id, "running"), { state: "running" });
});

test("guard: success returns the agent, the key and a refuse that writes and records", async () => {
  const f = await fixture();
  const r = call(f);
  const v = await r.verdict;
  assert.ok(v.ok);
  assert.equal(v.id, f.ok.id);
  assert.equal(v.rec.sandbox, "sb-ok");
  assert.equal(v.key, KEY);
  assert.deepEqual(r.ctx.principal, { scope: "operator" });
  assert.equal(r.ctx.hadCredential, true);
  assert.equal(r.ctx.error, undefined);
  assert.equal(await r.out(), ""); // nothing written on success
  assert.equal(v.refuse(500, "internal error"), 500);
  assert.equal(r.ctx.error, "internal error");
  assert.match(await r.out(), /^HTTP\/1\.1 500 Internal Server Error\r\n/);
});

test("guard: the UI session cookie authorises like a Bearer token", async () => {
  const f = await fixture();
  const r = call(f, { headers: { authorization: "", cookie: issueUiCookie(SECRET, 60_000) } });
  assert.ok((await r.verdict).ok);
});

test("guard: an encoded agent id is decoded", async () => {
  const f = await fixture();
  await refused(call(f, { url: "/v1/agents/a%20b/thing" }), 404, "no such agent: a b");
});

test("guard helpers: handshake, frame writes, close-then-destroy and idle keepalive", async () => {
  const s = new PassThrough();
  let out = Buffer.alloc(0);
  s.on("data", (d: Buffer) => {
    out = Buffer.concat([out, d]);
  });
  completeHandshake(s, KEY);
  assert.match(out.toString(), /^HTTP\/1\.1 101 /);
  const conn = new WsConnection({});
  const t = closeThenDestroy(s, conn, 10, [Buffer.from("pre")]);
  assert.equal(conn.closeSent, true);
  await new Promise((r) => s.once("close", r));
  clearTimeout(t);
  assert.ok(out.includes("pre"));
  const before = out.length;
  writeFrames(s, [Buffer.from("late")]); // destroyed: skipped
  assert.equal(out.length, before);

  const s2 = new PassThrough();
  let n = 0;
  s2.on("data", () => n++);
  const c2 = new WsConnection({});
  const ping = startKeepalive(s2, c2, { pingMs: 5, idleMs: 1_000_000, lastSeen: () => Date.now() });
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(ping);
  assert.ok(n >= 1); // pings flowed
  const s3 = new PassThrough();
  const c3 = new WsConnection({});
  const idle = startKeepalive(s3, c3, { pingMs: 5, idleMs: 0, lastSeen: () => 0 });
  await until(() => c3.closeSent);
  clearInterval(idle); // production clears it on socket close
  assert.equal(c3.closeSent, true); // idle timeout sent a close frame and dropped the socket
  const s4 = new PassThrough();
  const c4 = new WsConnection({});
  const busy = startKeepalive(s4, c4, { pingMs: 5, idleMs: 0, lastSeen: () => 0, busy: () => true });
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(busy);
  assert.equal(c4.closeSent, false); // outstanding input keeps a silent peer alive
});
