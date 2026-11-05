// SPEC design rule 4 at the API boundary: every mutating route requires an idempotency key, and a call without one is a 400 that names
// the field and the fix. The route table below is checked against the router's own source (a route added without a row fails the
// exhaustiveness test), so a new mutating route cannot skip the key unnoticed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { FakeStateStore } from "@pomtree/testing";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { StatePolicy } from "./state-policy.ts";
import { handleTransfer } from "./transfer-route.ts";
import { SECRET, setup, until } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

const QUERY_MISSING = "key is required: every mutating call carries an idempotency key (send a unique string as ?key=, reused on retry)";
const EXT_MISSING =
  "idempotencyKey is required: every mutating call carries one (send a unique string as the body field idempotencyKey, or as ?key= on a bodyless or raw-body call, reused on retry)";
const MISSING = "idempotencyKey is required: every mutating call carries one (send a unique string, reused on retry)";

type Who = "operator" | "agent" | "host";
interface Row {
  name: string;
  method: "POST" | "PUT" | "DELETE" | "PATCH";
  who: Who;
  // The URL and body once the world exists; the body never carries a key (the test adds one for the negative control).
  url: (w: World) => string;
  body?: (w: World) => unknown;
  // Where the key rides: the JSON body (default) or `?key=` (a bodyless DELETE, the raw-body report publish, merge).
  keyIn?: "query";
  // An extension-registered route: the generic extension-seam check answers first, with the combined message.
  ext?: true;
  // The router guard sites this row covers (see the exhaustiveness test).
  sites?: number;
  // Answered by a test that owns the route's setup (named here), not probed by this table.
  coveredBy?: string;
}

interface World {
  agent: AgentRecord;
  child: AgentRecord;
  escalationId: string;
  call(who: Who, method: string, url: string, body?: unknown, query?: string): ReturnType<typeof handle>;
}

const ROWS: Row[] = [
  { name: "drain", method: "POST", who: "operator", url: () => "/v1/drain", body: () => ({ deadline: 1 }) },
  { name: "peers send", method: "POST", who: "agent", url: (w) => `/v1/peers/${w.child.id}/send`, body: () => ({ generation: 0, body: "hi" }) },
  { name: "ui reply", method: "POST", who: "operator", url: () => "/v1/ui/reply", body: () => ({ replyTo: "es-x", body: "yes" }) },
  {
    name: "messages (host)",
    method: "POST",
    who: "host",
    url: () => "/v1/messages",
    body: () => ({ channel: "discord", sender: "u1", body: "hi", intent: "status" }),
  },
  {
    name: "messages/failed (host)",
    method: "POST",
    who: "host",
    url: () => "/v1/messages/failed",
    body: () => ({ channel: "discord", purpose: "alert", subject: "s", reason: "r" }),
  },
  {
    name: "escalation answer",
    method: "POST",
    who: "operator",
    url: (w) => `/v1/escalations/${w.escalationId}/answer`,
    body: () => ({ body: "yes" }),
    sites: 1,
  },
  { name: "escalation pass", method: "POST", who: "operator", url: (w) => `/v1/escalations/${w.escalationId}/pass`, body: () => ({}), sites: 0 },
  { name: "approval decide", method: "POST", who: "operator", url: () => "/v1/approvals/ap-x/decide", body: () => ({ decision: "approve" }) },
  { name: "capture request", method: "POST", who: "operator", url: () => "/v1/capture", coveredBy: "api.capture.test.ts" },
  { name: "ext call", method: "POST", who: "agent", url: () => "/v1/ext/x/call", body: () => ({ input: {} }) },
  { name: "state doc put", method: "PUT", who: "operator", url: () => "/v1/state/doc", body: () => ({ owner: "o", key: "k", value: 1 }) },
  { name: "state rm", method: "POST", who: "operator", url: () => "/v1/state/rm", body: () => ({ owner: "o", key: "k" }) },
  { name: "state import", method: "POST", who: "operator", url: () => "/v1/state/import", body: () => ({ owner: "o", docs: [{ key: "k", value: 1 }] }) },
  { name: "workflow launch", method: "POST", who: "operator", url: () => "/v1/workflows/launch", body: () => ({ workflow: "o/w" }) },
  { name: "spawn (operator)", method: "POST", who: "operator", url: () => "/v1/agents", body: () => ({ task: "t" }) },
  { name: "deadline", method: "POST", who: "operator", url: (w) => `/v1/agents/${w.agent.id}/deadline`, body: () => ({ deadlineMs: 1000 }) },
  { name: "inbox ack", method: "POST", who: "agent", url: () => "/v1/agents/self/inbox/ack", body: () => ({ ids: [] }) },
  { name: "ask", method: "POST", who: "agent", url: () => "/v1/agents/self/ask", body: () => ({ question: "q", options: [], generation: 0 }) },
  { name: "reap", method: "POST", who: "operator", url: (w) => `/v1/agents/${w.child.id}/reap` },
  { name: "message (operator signal)", method: "POST", who: "operator", url: (w) => `/v1/agents/${w.agent.id}/message`, body: () => ({ body: "hi" }) },
  { name: "result", method: "POST", who: "agent", url: () => "/v1/agents/self/result", body: () => ({ status: "succeeded", result: { summary: "ok" } }) },
  { name: "publish", method: "POST", who: "agent", url: (w) => `/v1/agents/${w.agent.id}/publish`, body: () => ({ branch: "b", target: "t" }) },
  { name: "park", method: "POST", who: "agent", url: () => "/v1/agents/self/park", body: () => ({ timeoutMs: 0, on: { kind: "inbox" } }) },
  { name: "await-user", method: "POST", who: "agent", url: () => "/v1/agents/self/await-user", body: () => ({}) },
  { name: "yield", method: "POST", who: "agent", url: () => "/v1/agents/self/yield", body: () => ({ wait: { kind: "message" } }) },
  { name: "merge", method: "POST", who: "agent", url: () => "/v1/agents/self/merge", body: () => ({}), keyIn: "query" },
  { name: "resume (agent)", method: "POST", who: "agent", url: () => "/v1/agents/self/resume", body: () => ({}) },
  { name: "resume (operator)", method: "POST", who: "operator", url: (w) => `/v1/agents/${w.agent.id}/resume` },
  { name: "cancel", method: "POST", who: "operator", url: (w) => `/v1/agents/${w.agent.id}/cancel` },
  { name: "schedule put", method: "PUT", who: "operator", url: () => "/v1/schedules/s1", body: () => ({ cron: "* * * * *", task: "t" }), ext: true },
  { name: "schedule rm", method: "DELETE", who: "operator", url: () => "/v1/schedules/s1", keyIn: "query", ext: true },
  { name: "schedule pause", method: "POST", who: "operator", url: () => "/v1/schedules/s1/pause", body: () => ({}), ext: true },
  { name: "schedule resume", method: "POST", who: "operator", url: () => "/v1/schedules/s1/resume", body: () => ({}), sites: 0, ext: true }, // pause and resume share one registration
  { name: "report publish", method: "POST", who: "agent", url: () => "/v1/agents/self/reports", body: () => new Uint8Array([1]), keyIn: "query", ext: true },
  { name: "report rm", method: "DELETE", who: "operator", url: (w) => `/v1/agents/${w.agent.id}/reports/r1`, keyIn: "query", ext: true },
  {
    name: "transfer push",
    method: "POST",
    who: "agent",
    url: () => "/v1/agents/self/push",
    keyIn: "query",
    coveredBy: "the handleTransfer test below (it bypasses handle())",
  },
  { name: "kill", method: "POST", who: "operator", url: (w) => `/v1/agents/${w.agent.id}/kill`, sites: 0 }, // cancel and kill share one guard site
];

async function world(): Promise<{ w: World; release: () => void }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const t = setup(async (_c: Ctx) => void (await gate), { messagingChannels: ["discord"] });
  t.daemon.deps.state = new FakeStateStore(() => Date.now(), t.fakes.hooks.raw.registry);
  t.daemon.deps.stateGrants = new StatePolicy("{}");
  const agent = await t.spawn("api-idem-a");
  await until(async () => (await t.daemon.get(agent.id))?.state === "running");
  const child = await t.spawn("api-idem-b");
  const esc = await t.fakes.escalations.create(
    { id: "es-api-idem", agent: agent.id, host: "h1", generation: agent.generation, question: "q?", options: [] },
    "es-api-idem",
  );
  const tokens: Record<Who, string> = {
    operator: issueToken(SECRET, { scope: "operator" }),
    agent: t.daemon.agentToken(agent.id, agent.generation),
    host: issueToken(SECRET, { scope: "host", channel: "discord" }),
  };
  const call: World["call"] = (who, method, url, body, query = "") => handle(t.daemon, { method, url: url + query, body, token: tokens[who] });
  return { w: { agent, child, escalationId: esc.id, call }, release };
}

test("every mutating route refuses a call without idempotencyKey with a 400 naming the field and the fix; a keyed call is not refused for the key", async () => {
  // A fresh world per row: a keyed control call may cancel, reap or exit an agent that a later row needs.
  for (const row of ROWS.filter((r) => r.coveredBy === undefined)) {
    const { w, release } = await world();
    try {
      const body = row.body?.(w) ?? {};
      const viaQuery = row.keyIn === "query";
      const bare = await w.call(row.who, row.method, row.url(w), body);
      const err = (bare.body as { error?: string }).error ?? "";
      assert.equal(bare.status, 400, `${row.name} without a key must be 400, got ${bare.status}: ${err}`);
      if (row.ext) assert.equal(err, EXT_MISSING, row.name);
      else if (viaQuery) assert.equal(err, QUERY_MISSING, row.name);
      else assert.equal(err, MISSING, row.name);
      // Negative control: with a key the refusal (if any) is about something else.
      const keyed = viaQuery
        ? await w.call(row.who, row.method, row.url(w), body, "?key=k1")
        : await w.call(row.who, row.method, row.url(w), { ...body, idempotencyKey: `k-${row.name}` });
      const keyedErr = (keyed.body as { error?: string } | null)?.error ?? "";
      assert.ok(!/idempotencyKey is required|^key is required/.test(keyedErr), `${row.name} with a key was refused for the key: ${keyedErr}`);
    } finally {
      release();
    }
  }
});

test("an empty or non-string idempotencyKey is refused like a missing one", async () => {
  const { w, release } = await world();
  try {
    for (const bad of ["", 7, null]) {
      const r = await w.call("operator", "POST", `/v1/agents/${w.child.id}/reap`, { idempotencyKey: bad });
      assert.equal(r.status, 400, String(bad));
      assert.equal((r.body as { error: string }).error, MISSING);
    }
  } finally {
    release();
  }
});

// The router is an if-chain, so the exhaustiveness check reads its source: every `m === "POST|PUT|PATCH|DELETE"` guard in api.ts and
// state-routes.ts, and every `method: "..."` route registration in the builtin extensions, must be accounted for by a row. A new mutating
// route fails here until it has a row, and so a key check.
const ROUTE_SOURCES = ["api.ts", "state-routes.ts", "builtin/cron.ts", "builtin/reports.ts", "transfer-route.ts"];
// Files that register routes but only GET (no key to require); a mutating route added to one moves it to ROUTE_SOURCES.
const READ_ONLY_ROUTE_FILES = ["builtin/observe.ts"];
const MUTATING = /^\s*(?:if \(.*\b(?:m|method) === "(?:POST|PUT|PATCH|DELETE)"|method: "(?:POST|PUT|PATCH|DELETE)",?\s*$)/gm;
const src = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

test("the route table covers every mutating route in the router and the builtin extensions (a new mutating route needs a row)", () => {
  const found = ROUTE_SOURCES.reduce((n, f) => n + (src(f).match(MUTATING) ?? []).length, 0);
  // answer and pass share one guard site, as do cancel and kill, and schedule pause and resume.
  const covered = ROWS.reduce((n, r) => n + (r.sites ?? 1), 0);
  assert.equal(found, covered, `the router has ${found} mutating sites but ROWS covers ${covered}: add a row (and a key check) for the new route`);
});

test("every file that registers routes is either scanned or known to be read-only", () => {
  const files = [
    ...readdirSync(new URL("./", import.meta.url)).filter((f) => f.endsWith(".ts")),
    ...readdirSync(new URL("./builtin/", import.meta.url)).map((f) => `builtin/${f}`),
  ]
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /\.route\(/.test(src(f)));
  for (const f of files)
    assert.ok([...ROUTE_SOURCES, ...READ_ONLY_ROUTE_FILES].includes(f), `${f} registers routes: add it to ROUTE_SOURCES (or READ_ONLY_ROUTE_FILES)`);
  for (const f of READ_ONLY_ROUTE_FILES)
    assert.equal((src(f).match(MUTATING) ?? []).length, 0, `${f} now registers a mutating route: move it to ROUTE_SOURCES with rows`);
});

test("reap and operator message replay under the same key", async () => {
  const t = setup(async (c: Ctx) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok" } })));
  const a = await t.spawn("replay-a");
  await t.orchestrator.idle();
  // reap
  const first = await t.operator("POST", `/v1/agents/${a.id}/reap`, { idempotencyKey: "reap-1" });
  assert.equal(first.status, 200);
  const second = await t.operator("POST", `/v1/agents/${a.id}/reap`, { idempotencyKey: "reap-1" });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  // message: the same key is one signal
  const b = await t.spawn("replay-b");
  const m1 = await t.operator("POST", `/v1/agents/${b.id}/message`, { body: "hi", idempotencyKey: "m-1" });
  const m2 = await t.operator("POST", `/v1/agents/${b.id}/message`, { body: "hi", idempotencyKey: "m-1" });
  assert.equal(m1.status, 201);
  assert.deepEqual(m2.body, m1.body);
});

test("a schedule PUT and pause replay under the same key (the first result)", async () => {
  const t = setup(async () => {});
  const put = (cron: string, key: string) => t.operator("PUT", "/v1/schedules/s1", { cron, task: "t", idempotencyKey: key });
  const first = await put("* * * * *", "put-1");
  assert.equal(first.status, 200);
  const replay = await put("*/5 * * * *", "put-1");
  assert.deepEqual(replay.body, first.body, "same key replays the first upsert even though the body differs");
  assert.notEqual(((await put("*/5 * * * *", "put-2")).body as { cron: string }).cron, (first.body as { cron: string }).cron, "a new key applies");
  const p1 = await t.operator("POST", "/v1/schedules/s1/pause", { idempotencyKey: "pa-1" });
  const p2 = await t.operator("POST", "/v1/schedules/s1/pause", { idempotencyKey: "pa-1" });
  assert.equal(p1.status, 200);
  assert.deepEqual(p2.body, p1.body);
});

test("a result replays under the same key (the first result, not the 409 already-has-a-result)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const t = setup(async () => void (await gate));
  const a = await t.spawn("replay-c");
  await until(async () => (await t.daemon.get(a.id))?.state === "running");
  const tok = t.daemon.agentToken(a.id, a.generation);
  const submit = (key: string) =>
    handle(t.daemon, {
      method: "POST",
      url: "/v1/agents/self/result",
      token: tok,
      body: { status: "succeeded", result: { summary: "ok" }, idempotencyKey: key },
    });
  const r1 = await submit("r-1");
  assert.equal(r1.status, 200);
  const r2 = await submit("r-1");
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.body, r1.body);
  // Negative: another key is a second result, refused.
  assert.equal((await submit("r-2")).status, 409);
  release();
});

test("a third-party extension's mutating route is refused without a key at the extension seam, and reaches its handler with one", async () => {
  const t = setup(async () => {});
  let reached = 0;
  t.extensions.registerBuiltin({
    manifest: { name: "fakeext", entry: "builtin", capabilities: { routes: true }, deps: [] },
    init(h) {
      for (const method of ["POST", "PUT", "DELETE"] as const)
        h.route({
          method,
          path: "/v1/fakeext/do",
          scope: { kind: "operator" },
          handler: async () => {
            reached++;
            return { status: 200, body: { ok: true } };
          },
        });
      h.route({ method: "GET", path: "/v1/fakeext/read", scope: { kind: "operator" }, handler: async () => ({ status: 200, body: { ok: true } }) });
    },
  });
  await t.extensions.startAll();
  const op = issueToken(SECRET, { scope: "operator" });
  for (const method of ["POST", "PUT", "DELETE"]) {
    const bare = await handle(t.daemon, { method, url: "/v1/fakeext/do", body: {}, token: op });
    assert.equal(bare.status, 400, method);
    assert.equal((bare.body as { error: string }).error, EXT_MISSING);
  }
  assert.equal(reached, 0, "the handler never ran without a key");
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/fakeext/do", body: { idempotencyKey: "k" }, token: op })).status, 200);
  assert.equal((await handle(t.daemon, { method: "DELETE", url: "/v1/fakeext/do?key=k", token: op })).status, 200);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/fakeext/read", token: op })).status, 200, "a read needs no key");
  assert.equal(reached, 2);
});

test("push without ?key= is refused with the shared query message (handleTransfer bypasses handle())", async () => {
  const t = setup(async () => {});
  const a = await t.spawn("transfer-a");
  const sent: { status?: number; body?: string } = {};
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: (s: number) => {
      sent.status = s;
    },
    end: (b: string) => {
      sent.body = b;
    },
  };
  await handleTransfer(
    t.daemon,
    { scope: "agent", agent: a.id, generation: a.generation, expiry: Date.now() + 60_000 },
    { verb: "push", id: "self" },
    new URL("http://x/v1/agents/self/push"),
    {} as never,
    res as never,
  );
  assert.equal(sent.status, 400);
  assert.equal((JSON.parse(sent.body!) as { error: string }).error, QUERY_MISSING);
});

// agent resume and drain take the key for uniformity; a replay is safe by state, not by the key.
test("operator resume and drain replays are safe by state: the second call answers equivalently", async () => {
  const t = setup(async () => {});
  assert.equal((await t.operator("POST", "/v1/drain", { deadline: 1, idempotencyKey: "d1" })).status, 202);
  assert.equal((await t.operator("POST", "/v1/drain", { deadline: 1, idempotencyKey: "d1" })).status, 202);
});
