import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { SECRET, setup, until } from "./test-setup.ts";

const MAX = 100_000;

function rig() {
  const clock = { v: Date.now() }; // token expiry is checked against the real clock
  const t = setup(async (c) => void (await c.stopped), { now: () => clock.v, defaultSessionMs: 10_000, maxSessionMs: MAX });
  const spawned: AgentRecord[] = [];
  const spawn = async (key: string, deadlineMs?: number) => {
    const a = await t.spawn(key, deadlineMs === undefined ? {} : { deadlineMs });
    spawned.push(a);
    await until(async () => ((await t.daemon.get(a.id)) as AgentRecord).state === "running");
    return a;
  };
  // Cancel everything so no kill timers or sandboxes outlive the test.
  const done = async () => {
    for (const a of spawned) await t.daemon.cancel(a.id, 5).catch(() => {});
    await t.orchestrator.idle();
  };
  const live = (id: string) => (t.daemon as unknown as { live: Map<string, { timedOut?: boolean; killTimer?: unknown }> }).live.get(id)!;
  return { t, clock, spawn, done, live };
}

const tokenFor = async (t: ReturnType<typeof setup>, a: AgentRecord) => t.daemon.agentToken(a.id, ((await t.daemon.get(a.id)) as AgentRecord).generation);
const agentApi = async (t: ReturnType<typeof setup>, a: AgentRecord, method: string, url: string, body?: unknown) =>
  handle(t.daemon, { method, url, body, token: await tokenFor(t, a) });

test("extendDeadline adds to the current deadline, capped per extension, and reports the previous one", async () => {
  const { t, spawn, done } = rig();
  const a = await spawn("a", 5_000);
  const d0 = (await t.daemon.sessionDeadlineAt(a.id))!;
  assert.equal(d0, a.createdAt + 5_000);
  assert.deepEqual(await t.daemon.extendDeadline(a.id, 2_000, "e1"), { deadlineAt: d0 + 2_000, previousDeadlineAt: d0 });
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), d0 + 2_000);
  assert.deepEqual(await t.daemon.extendDeadline(a.id, undefined, "e2"), { deadlineAt: d0 + 12_000, previousDeadlineAt: d0 + 2_000 });
  await assert.rejects(t.daemon.extendDeadline(a.id, 0, "bad"), (e: { status?: number }) => e.status === 400);
  await assert.rejects(t.daemon.extendDeadline("nope", 1, "x"), (e: { status?: number }) => e.status === 404);
  await done();
});

test("replaying an earlier extension key is read-only: it returns the recorded result and leaves the deadline and timer alone", async () => {
  const { t, spawn, done, live } = rig();
  const a = await spawn("a", 5_000);
  const d0 = (await t.daemon.sessionDeadlineAt(a.id))!;
  const first = await t.daemon.extendDeadline(a.id, 1_000, "k1");
  const second = await t.daemon.extendDeadline(a.id, 1_000, "k2");
  assert.equal(second.deadlineAt, d0 + 2_000);
  const timer = live(a.id).killTimer;
  const replay = await t.daemon.extendDeadline(a.id, 1_000, "k1");
  assert.deepEqual(replay, first);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), d0 + 2_000, "the later extension survives the replay");
  assert.equal(live(a.id).killTimer, timer, "the timer is not re-armed");
  // A same-key replay of the latest extension is also stable.
  assert.deepEqual(await t.daemon.extendDeadline(a.id, 1_000, "k2"), second);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), d0 + 2_000);
  await done();
});

test("an unlimited agent (deadlineMs 0) cannot be extended: typed 409, still unlimited", async () => {
  const { t, spawn, done } = rig();
  const a = await spawn("a", 0);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), null);
  await assert.rejects(t.daemon.extendDeadline(a.id, 1_000, "e"), (e: { status?: number }) => e.status === 409);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), null);
  await done();
});

test("extending after the deadline has passed counts from now; a timed-out run is refused", async () => {
  const { t, clock, spawn, done, live } = rig();
  const a = await spawn("a", 5_000);
  const d0 = (await t.daemon.sessionDeadlineAt(a.id))!;
  clock.v = d0 + 50_000; // the (fake-clock) deadline is long past; the timer has not fired
  const r = await t.daemon.extendDeadline(a.id, 3_000, "late");
  assert.equal(r.previousDeadlineAt, d0);
  assert.equal(r.deadlineAt, clock.v + 3_000, "extension is measured from now, not from the stale deadline");
  live(a.id).timedOut = true;
  await assert.rejects(t.daemon.extendDeadline(a.id, 3_000, "too-late"), (e: { status?: number }) => e.status === 409);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), r.deadlineAt);
  live(a.id).timedOut = false;
  await done();
});

test("the owner's deadline caps an extension but never shortens the current deadline", async () => {
  const { t, spawn, done } = rig();
  const owner = await spawn("owner", 50_000);
  const spawned = await agentApi(t, owner, "POST", "/v1/agents", { task: "k", idempotencyKey: "kid", deadlineMs: 20_000 });
  assert.equal(spawned.status, 201, JSON.stringify(spawned.body));
  const kid = spawned.body as AgentRecord;
  await until(async () => ((await t.daemon.get(kid.id)) as AgentRecord).state === "running");
  const kd = (await t.daemon.sessionDeadlineAt(kid.id))!;
  const od = (await t.daemon.sessionDeadlineAt(owner.id))!;
  assert.equal((await t.daemon.extendDeadline(kid.id, 90_000, "cap")).deadlineAt, od, "capped at the owner's deadline");
  // Owner's recorded deadline now sits below the child's current one (e.g. a clamped owner): no shortening.
  (t.daemon as unknown as { deadlines: Map<string, number> }).deadlines.set(owner.id, kd - 5_000);
  const r = await t.daemon.extendDeadline(kid.id, 1_000, "floor");
  assert.ok(r.deadlineAt! >= r.previousDeadlineAt!, `${r.deadlineAt} < ${r.previousDeadlineAt}`);
  await t.daemon.cancel(kid.id, 5).catch(() => {});
  await done();
});

test("/deadline route: operator extends, agents may read but not extend, and the body is validated", async () => {
  const { t, spawn, done } = rig();
  const a = await spawn("a", 5_000);
  const d0 = (await t.daemon.sessionDeadlineAt(a.id))!;
  const post = (body: unknown) => t.operator("POST", `/v1/agents/${a.id}/deadline`, body);
  const ok = await post({ deadlineMs: 1_000, idempotencyKey: "r1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { deadlineAt: d0 + 1_000, previousDeadlineAt: d0 });
  assert.equal((await agentApi(t, a, "POST", `/v1/agents/${a.id}/deadline`, { deadlineMs: 1_000, idempotencyKey: "r2" })).status, 403);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), d0 + 1_000, "the refused agent extension changed nothing");
  const get = await agentApi(t, a, "GET", `/v1/agents/${a.id}/deadline`);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { deadlineAt: d0 + 1_000 });
  assert.equal((await t.operator("GET", `/v1/agents/${a.id}/deadline`)).status, 200);
  assert.equal((await post({ deadlineMs: -1, idempotencyKey: "r3" })).status, 400);
  assert.equal((await t.operator("POST", "/v1/agents/missing/deadline", { deadlineMs: 1, idempotencyKey: "r4" })).status, 404);
  await done();
});

test("/whoami: agent scope only, and the response carries no secret or host path", async () => {
  const { t, spawn, done } = rig();
  const a = await spawn("a", 5_000);
  assert.equal((await t.operator("GET", "/v1/whoami")).status, 403);
  const r = await agentApi(t, a, "GET", "/v1/whoami");
  assert.equal(r.status, 200);
  const body = r.body as Record<string, unknown>;
  assert.equal(body.id, a.id);
  assert.deepEqual(Object.keys(body).sort(), ["endpoint", "generation", "host", "id", "name", "state"]);
  const text = JSON.stringify(body);
  for (const leak of [SECRET, "/run/pomtreed.sock", "/host/pomtreed.sock", "pomtreed-sess-", "POMTREE_TOKEN"])
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  await done();
});

test("the sandbox env carries the agent's deadline as ISO (POMTREE_AGENT_DEADLINE_AT) and no model key or URL", async () => {
  const { t, spawn, done } = rig();
  const a = await spawn("a", 5_000);
  const env = t.sandbox.started.find((s) => s.env.POMTREE_AGENT_ID === a.id)!.env;
  assert.equal(env.POMTREE_AGENT_DEADLINE_AT, new Date(a.createdAt + 5_000).toISOString());
  assert.equal(Date.parse(env.POMTREE_AGENT_DEADLINE_AT!), (await t.daemon.sessionDeadlineAt(a.id))!);
  assert.ok(!("POMTREE_MODEL_KEY" in env) && !("POMTREE_MODEL_BASE_URL" in env), "model credentials reach Pi only through staged auth files");
  await done();
});

test("a requested deadline cut short journals requestedMs and clampedBy on its deadline entry (deadline-session-cap)", async () => {
  const { t, spawn, done } = rig();
  const entry = async (a: AgentRecord) => (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "ext.pomtreed.deadline")!.payload;
  const capped = await spawn("capped", 500_000); // above maxSessionMs
  assert.deepEqual(await entry(capped), { kind: "ext.pomtreed.deadline", at: capped.createdAt + MAX, requestedMs: 500_000, clampedBy: "maxSessionMs" });
  const within = await spawn("within", 5_000);
  assert.deepEqual(await entry(within), { kind: "ext.pomtreed.deadline", at: within.createdAt + 5_000 }, "not clamped: no extra fields");
  const dflt = await spawn("dflt");
  assert.deepEqual(await entry(dflt), { kind: "ext.pomtreed.deadline", at: dflt.createdAt + 10_000 }, "no request: nothing to report");
  // A child asking for more than its requester has left is bounded by the requester.
  const kid = await t.daemon.spawn(within.id, { name: "kid", task: "t", deadlineMs: 50_000, idempotencyKey: "kid" });
  assert.deepEqual(await entry(kid), { kind: "ext.pomtreed.deadline", at: within.createdAt + 5_000, requestedMs: 50_000, clampedBy: "requester" });
  await t.daemon.cancel(kid.id, 5).catch(() => {});
  await done();
});
