import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { LifecycleError } from "./lifecycle.ts";
import { SECRET, setup, spawnSpec } from "./test-setup.ts";
import { DEADLINE_KIND, QUARANTINED_KIND } from "./watchdog.ts";

// A running agent created straight in the registry, with no live drive handle (like the escalation tests).
async function runningAgent(t: ReturnType<typeof setup>, key: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  return t.daemon.deps.registry.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${key}-exit` });
}

test("host and ext tokens cannot read an agent, its events, checkpoint, or wait", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  const host = issueToken(SECRET, { scope: "host", channel: "web" });
  const ext = issueToken(SECRET, { scope: "ext", name: "tick" });
  const cases: Array<[string, string]> = [
    ["GET", `/v1/agents/${a.id}`],
    ["GET", `/v1/agents/${a.id}/events`],
    ["GET", `/v1/agents/${a.id}/checkpoint`],
    ["GET", `/v1/agents/${a.id}/wait`],
  ];
  for (const [method, url] of cases) {
    for (const token of [host, ext]) {
      const res = await handle(t.daemon, { method, url, token });
      assert.equal(res.status, 403, `${method} ${url} with ${token.slice(0, 2)} token`);
    }
  }
});

test("an operator GET serializes a stored deterministic agent with its executor and spec, and POST /v1/agents cannot select it", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const spec = { driver: "fetch-diff", input: { url: "https://example.com/feed" } };
  const d = await t.daemon.deps.registry.create({
    executor: "deterministic",
    spec,
    parent: root.id,
    name: "d",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "det-1",
  });
  const read = await t.operator("GET", `/v1/agents/${d.id}`);
  assert.equal(read.status, 200);
  const body = read.body as AgentRecord;
  assert.equal(body.id, d.id);
  assert.equal(body.executor, "deterministic");
  assert.deepEqual(body.spec, spec);
  // The operator create route has no executor selector: a valid ordinary request ignores the extra fields and creates a container agent.
  const before = (await t.daemon.list()).map((a) => a.id);
  const created = await t.operator("POST", "/v1/agents", {
    name: "ordinary",
    task: "t",
    idempotencyKey: "det-2",
    executor: "deterministic",
    spec,
  });
  assert.equal(created.status, 201);
  assert.equal((created.body as AgentRecord).executor, "container");
  const after = await t.daemon.list();
  assert.equal(after.length, before.length + 1, "exactly one new agent");
  assert.deepEqual(
    after.filter((a) => a.executor === "deterministic").map((a) => a.id),
    [d.id],
    "the stored deterministic agent is unchanged and alone",
  );
  await t.orchestrator.idle();
});

test("POST reap requires operator for non-agents (host and ext tokens are refused)", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  const host = issueToken(SECRET, { scope: "host", channel: "web" });
  const ext = issueToken(SECRET, { scope: "ext", name: "tick" });
  for (const token of [host, ext]) {
    const res = await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/reap`, token });
    assert.equal(res.status, 403);
  }
});

test("an operator can still read and reap, and an agent still addresses itself", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  const read = await t.operator("GET", `/v1/agents/${a.id}`);
  assert.equal(read.status, 200);
  const reaped = await t.operator("POST", `/v1/agents/${a.id}/reap`);
  assert.equal(reaped.status, 200);

  const b = await runningAgent(t, "b");
  const self = await handle(t.daemon, { method: "GET", url: "/v1/agents/self", token: t.daemon.agentToken(b.id, b.generation) });
  assert.equal(self.status, 200);
  assert.equal((self.body as { id: string }).id, b.id);
});

test("POST /v1/agents forwards deadlineMs to daemon.spawn", async () => {
  const t = setup(async () => {});
  const a = (await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "k", deadlineMs: 60_000 })).body as AgentRecord;
  const deadline = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === DEADLINE_KIND);
  assert.ok(deadline, "deadlineMs is forwarded and journaled");
  assert.ok(((deadline!.payload as { at?: number }).at ?? 0) > 0);
  await t.orchestrator.idle();
});

test("POST /v1/agents accepts operator-only deadlineMs: 0 as an explicit unlimited deadline", async () => {
  const t = setup(async () => {}, { defaultSessionMs: 10, maxSessionMs: 10 });
  const a = (await t.operator("POST", "/v1/agents", { task: "t", idempotencyKey: "unlimited", deadlineMs: 0 })).body as AgentRecord;
  assert.equal(
    (await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === DEADLINE_KIND),
    false,
  );

  const parent = await t.spawn("parent");
  const denied = await handle(t.daemon, {
    method: "POST",
    url: "/v1/agents",
    token: t.daemon.agentToken(parent.id, parent.generation),
    body: { task: "t", idempotencyKey: "agent-unlimited", deadlineMs: 0 },
  });
  assert.equal(denied.status, 403);
  await t.orchestrator.idle();
});

test("POST /v1/agents/:id/resume forwards force to override quarantine", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(aId))!.state, "yielded");
  const r = (await t.daemon.get(aId))!;
  await t.journal.append({ agent: aId, host: "h1", generation: r.generation, payload: { kind: QUARANTINED_KIND, at: Date.now() }, idempotencyKey: "q" });

  const refused = await t.operator("POST", `/v1/agents/${aId}/resume`);
  assert.equal(refused.status, 409, "resume without force is refused for a quarantined agent");
  assert.equal((await t.daemon.get(aId))!.state, "yielded", "a refused resume leaves the agent parked");

  const forced = await t.operator("POST", `/v1/agents/${aId}/resume`, { force: true });
  assert.equal(forced.status, 200);
  assert.ok((forced.body as AgentRecord).generation > r.generation, "force bumps the generation");
  await t.orchestrator.idle();
  assert.deepEqual((await t.daemon.get(aId))!.result, { summary: "ok", value: "woke" });
});

test("POST /v1/drain stops admission and returns 202", async () => {
  const t = setup(async () => {});
  const res = await t.operator("POST", "/v1/drain", { deadline: Date.now() + 60_000 });
  assert.equal(res.status, 202);
  assert.equal((res.body as { draining: boolean }).draining, true);
  const root = await t.daemon.root();
  await assert.rejects(
    () => t.daemon.spawn(root.id, { name: "x", task: "t", idempotencyKey: "k" }),
    (e: unknown) => e instanceof LifecycleError && e.status === 503,
  );
});

test("transcript route: host/ext refused, operator gets 404 without a checkpoint, unknown agent 404", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "tr");
  for (const token of [issueToken(SECRET, { scope: "host", channel: "web" }), issueToken(SECRET, { scope: "ext", name: "tick" })]) {
    assert.equal((await handle(t.daemon, { method: "GET", url: `/v1/agents/${a.id}/transcript`, token })).status, 403);
  }
  assert.equal((await t.operator("GET", `/v1/agents/${a.id}/transcript?limit=5`)).status, 404);
  assert.equal((await t.operator("GET", `/v1/agents/nope/transcript`)).status, 404);
});

test("reap passes the idempotency key; inbound accepts cancel and status intents", async () => {
  const t = setup(async () => {}, { messagingChannels: ["web"] });
  const a = await runningAgent(t, "rk");
  const r = await t.operator("POST", `/v1/agents/${a.id}/reap`, { idempotencyKey: "k1" });
  assert.equal(r.status, 200);
  const again = await t.operator("POST", `/v1/agents/${a.id}/reap`, { idempotencyKey: "k1" });
  assert.equal(again.status, 200);
  const host = issueToken(SECRET, { scope: "host", channel: "web" });
  const post = (intent: string, key: string) =>
    handle(t.daemon, {
      method: "POST",
      url: "/v1/messages",
      token: host,
      body: { channel: "web", sender: "u", intent, body: "x", to: a.id, idempotencyKey: key },
    });
  assert.equal((await post("bogus", "m0")).status, 400);
  assert.notEqual((await post("status", "m1")).status, 400);
  assert.notEqual((await post("cancel", "m2")).status, 400);
});

test("GET /v1/summary is operator-only and aggregates agents, spend and escalations", async () => {
  const t = setup(async () => {});
  await runningAgent(t, "sum");
  const res = await t.operator("GET", "/v1/summary");
  assert.equal(res.status, 200);
  const b = res.body as { agentsByState: Record<string, number>; totalSpendMicros: number; openEscalations: number; hosts: unknown };
  assert.equal(b.agentsByState.exited, 1);
  assert.equal(typeof b.totalSpendMicros, "number");
  assert.equal(b.openEscalations, 0);
  assert.ok(b.hosts);
  for (const token of [issueToken(SECRET, { scope: "host", channel: "web" }), issueToken(SECRET, { scope: "ext", name: "tick" })]) {
    assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/summary", token })).status, 403);
  }
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/summary" })).status, 401);
});

test("trace route: operator gets markdown; agent (even self), host and ext tokens are 403; unknown 404; bad flags 400", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "tr");
  const tok = [
    t.daemon.agentToken(a.id, a.generation),
    issueToken(SECRET, { scope: "host", channel: "web" }),
    issueToken(SECRET, { scope: "ext", name: "tick" }),
  ];
  for (const token of tok) assert.equal((await handle(t.daemon, { method: "GET", url: `/v1/agents/${a.id}/trace`, token })).status, 403);
  assert.equal((await handle(t.daemon, { method: "GET", url: `/v1/agents/self/trace`, token: tok[0] })).status, 403);
  assert.equal((await handle(t.daemon, { method: "GET", url: `/v1/agents/${a.id}/trace` })).status, 401);
  assert.equal((await t.operator("GET", "/v1/agents/nope/trace")).status, 404);
  assert.equal((await t.operator("GET", `/v1/agents/${a.id}/trace?raw=2`)).status, 400);
  assert.equal((await t.operator("GET", `/v1/agents/${a.id}/trace?format=xml`)).status, 400);

  const md = await t.operator("GET", `/v1/agents/${a.id}/trace`);
  assert.equal(md.status, 200);
  assert.match(md.contentType ?? "", /^text\/markdown/);
  const text = (md.body as Buffer).toString("utf8");
  assert.match(text, new RegExp(`^# Trace: a \\(${a.id}\\)`));
  assert.match(text, /redacted: 0 values/);
  assert.match(text, /state: exited, exit: succeeded/);
  assert.equal(md.headers?.["x-trace-redacted"], "0");

  const js = await t.operator("GET", `/v1/agents/${a.id}/trace?format=json&include=children&raw=1&short=1`);
  assert.equal(js.status, 200);
  const b = js.body as { markdown: string; events: number; redacted: number; raw: boolean };
  assert.equal(b.raw, true);
  assert.match(b.markdown, /redacted: NO/);
  assert.equal(b.events, 0);
});
