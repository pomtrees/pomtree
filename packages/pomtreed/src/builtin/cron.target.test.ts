import assert from "node:assert/strict";
import { test } from "node:test";
import type { Schedule, Signal, Template } from "@pomtree/core";
import { handle } from "../api.ts";
import { DEADLINE_KIND } from "../watchdog.ts";
import { TEST_MODEL, keyed } from "@pomtree/testing";
import { get, setup, until, userAbort } from "../test-setup.ts";
import { MAX_AGENT_SCHEDULES, MIN_AGENT_INTERVAL_MS } from "./cron.ts";

// Targeted schedules (a periodic wakeup of one agent), the carried spawn parameters, and agent-scope authority.
const T0 = Date.parse("2026-01-01T00:00:00Z");
type T = ReturnType<typeof setup>;
const base = { cron: "* * * * *", task: "t", missed: "skip", overlap: "skip" };
const BODY = (id: string) => `Scheduled wakeup (schedule ${id}): t`;
const rootKids = async (t: T) => t.daemon.list({ parent: (await t.daemon.root()).id });
const alerts = async (t: T) => (await t.daemon.deps.journal.read({ agent: (await t.daemon.root()).id })).filter((e) => e.payload.kind === "ext.cron.error");
const peek = (t: T, id: string): Promise<Signal[]> => t.fakes.mailbox.peek(id);
const asAgent = async (t: T, id: string, method: string, url: string, body?: unknown) =>
  handle(t.daemon, { method, url, body: keyed(method, body), token: t.daemon.agentToken(id, (await get(t, id)).generation) });

// A target that stays up until the daemon stops it; `mode` shapes what it does at start.
// `start` is the fake clock's origin: tests that issue agent tokens need real time (token expiry is checked against it).
function rig(mode: "run" | "wait" | "yield" | "finish" = "run", start = T0) {
  let clock = start;
  let id = "";
  const wakes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t = setup(
    async (c) => {
      if (c.wake) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
      }
      if (id === "")
        id = c.agent; // the first agent is the target; later ones are spawned schedule children
      else return void (await c.stopped);
      if (mode === "wait") await userAbort(t, c); // a bare settled is a passive settle now; only a corroborated Esc yields waiting
      if (mode === "yield") return void (await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" }));
      if (mode === "finish") {
        await gate;
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
      }
      await c.stopped;
    },
    { now: () => clock },
  );
  return { t, wakes, release, tick: (ms: number) => (clock += ms), setClock: (v: number) => (clock = v), target: () => id };
}
async function started(r: ReturnType<typeof rig>, state: "running" | "yielded" = "running"): Promise<string> {
  await r.t.spawn();
  await until(async () => r.target() !== "" && (await get(r.t, r.target())).state === state);
  return r.target();
}

test("spawn path is unchanged when no agent is set: a fire spawns a root child and delivers nothing", async () => {
  const r = rig();
  const id = await started(r);
  const put = await r.t.operator("PUT", "/v1/schedules/m", base);
  assert.equal((put.body as Schedule).agent, undefined);
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  assert.deepEqual((await rootKids(r.t)).map((k) => k.name).sort(), ["m", "w"]);
  assert.deepEqual(await peek(r.t, id), []);
});

test("a spawning schedule carries budget, deadline, template and model into the spawn", async () => {
  const r = rig();
  r.t.fakes.hooks.raw.templates.templates.set("tp", { id: "tp", budgetMicros: 100, provider: "tp-prov", model: "tp-model" } as Template);
  const put = await r.t.operator("PUT", "/v1/schedules/m", {
    ...base,
    budgetMicros: 777,
    deadlineMs: 60_000,
    template: "tp",
    model: { ...TEST_MODEL },
  });
  assert.equal(put.status, 200);
  assert.deepEqual((put.body as Schedule).model, TEST_MODEL);
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  const kid = (await rootKids(r.t)).find((k) => k.name === "m")!;
  assert.ok(kid.executor === "container");
  assert.equal(kid.budgetMicros, 777, "request beats template");
  assert.deepEqual([kid.spec.provider, kid.spec.model], [TEST_MODEL.provider, TEST_MODEL.id], "request model beats template model");
  assert.ok(
    (await r.t.journal.read({ agent: kid.id })).some((e) => e.payload.kind === DEADLINE_KIND),
    "deadlineMs reaches the spawn",
  );
});

test("spawn parameters validate like a spawn request and are refused on a targeted schedule", async () => {
  const r = rig();
  const id = await started(r);
  const bad = (extra: object) => r.t.operator("PUT", "/v1/schedules/x", { ...base, ...extra });
  assert.equal((await bad({ budgetMicros: -5 })).status, 400);
  assert.equal((await bad({ budgetMicros: 1.5 })).status, 400);
  assert.equal((await bad({ deadlineMs: 0 })).status, 400);
  assert.equal((await bad({ model: { provider: "p" } })).status, 400);
  assert.equal((await bad({ agent: id, budgetMicros: 5 })).status, 400);
  assert.equal((await r.t.operator("GET", "/v1/schedules")).body instanceof Array, true);
  assert.deepEqual((await r.t.operator("GET", "/v1/schedules")).body, []);
});

test("a targeted fire steers a running agent and spawns nothing", async () => {
  const r = rig();
  const id = await started(r);
  assert.equal((await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id })).status, 200);
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  const sigs = await peek(r.t, id);
  assert.equal(sigs.length, 1);
  assert.deepEqual(
    [sigs[0]!.kind, (sigs[0] as { body: string }).body, (sigs[0] as { interrupt?: boolean }).interrupt],
    ["human_message", BODY("m"), undefined],
  );
  assert.deepEqual(
    (await rootKids(r.t)).map((k) => k.name),
    ["w"],
  );
  assert.equal(await r.t.fakes.schedules.lastFired("m"), T0 + 60_000);
});

test("a targeted fire steers a waiting agent (settled, no result) through the mailbox", async () => {
  const r = rig("wait");
  const id = await started(r);
  await until(async () => (await r.t.journal.read({ agent: id })).some((e) => e.payload.kind === "ext.pomtreed.waiting"));
  await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id });
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  const sigs = await peek(r.t, id);
  assert.deepEqual(
    sigs.map((s) => (s as { body: string }).body),
    [BODY("m")],
  );
  const journal = await r.t.journal.read({ agent: id });
  assert.ok(
    journal.some((e) => e.payload.kind === "message_received" && (e.payload as { body?: string }).body === BODY("m")),
    "journaled like an operator message",
  );
});

test("a targeted fire wakes a yielded agent with the task as the wake message", async () => {
  const r = rig("yield", Date.now());
  const id = await started(r, "yielded");
  await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id });
  r.tick(90_000);
  await r.t.cronExt.sweep();
  await r.t.orchestrator.idle();
  assert.deepEqual(r.wakes, [BODY("m")]);
  assert.ok((await get(r.t, id)).generation > 0, "resumed");
  assert.deepEqual(await peek(r.t, id), [], "a wake is not also mailboxed");
});

test("an exited target orphans the schedule, drops the fire, and alerts exactly once", async () => {
  const r = rig("finish");
  const id = await started(r);
  await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id });
  r.release();
  await until(async () => ["exited", "reaped"].includes((await get(r.t, id)).state));
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  r.setClock(T0 + 150_000);
  await r.t.cronExt.sweep();
  await r.t.cronExt.sweep();
  const s = (await r.t.fakes.schedules.get("m"))!;
  assert.equal(s.orphaned, true);
  assert.equal(await r.t.fakes.schedules.lastFired("m"), null, "fire dropped, cursor untouched");
  assert.deepEqual(await peek(r.t, id), []);
  const orphanAlerts = (await alerts(r.t)).filter((e) => /orphaned/.test((e.payload as { message: string }).message));
  assert.equal(orphanAlerts.length, 1);
  // Retargeting (PUT) clears the flag; a fresh target resumes firing.
  const r2 = await r.t.spawn("k2", { name: "second" });
  await until(async () => (await get(r.t, r2.id)).state === "running");
  assert.equal((await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: r2.id })).status, 200);
  assert.ok(!(await r.t.fakes.schedules.get("m"))!.orphaned);
});

test("PUT refuses an unknown or exited target for an operator", async () => {
  const r = rig();
  assert.equal((await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: "nope" })).status, 404);
});

test("overlap skip drops a fire while the previous steer is unconsumed; once consumed the next fires", async () => {
  const r = rig();
  const id = await started(r);
  await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id, overlap: "skip" });
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep(); // 00:01 steers
  r.setClock(T0 + 150_000);
  await r.t.cronExt.sweep(); // 00:02 dropped: 00:01 still in the mailbox
  assert.equal((await peek(r.t, id)).length, 1);
  assert.equal(await r.t.fakes.schedules.lastFired("m"), T0 + 120_000, "skipped fire is settled, cursor moves on");
  await r.t.fakes.mailbox.receive(id, "consume");
  r.setClock(T0 + 210_000);
  await r.t.cronExt.sweep(); // 00:03 steers
  assert.equal((await peek(r.t, id)).length, 1);
});

test("overlap queue holds the cursor while the previous steer is unconsumed, then releases it", async () => {
  const r = rig();
  const id = await started(r);
  await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id, overlap: "queue", missed: "catch-up" });
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  r.setClock(T0 + 210_000); // 00:02 and 00:03 are due behind the unconsumed 00:01 steer
  await r.t.cronExt.sweep();
  assert.equal((await peek(r.t, id)).length, 1);
  assert.equal(await r.t.fakes.schedules.lastFired("m"), T0 + 60_000, "cursor held");
  await r.t.fakes.mailbox.receive(id, "consume");
  await r.t.cronExt.sweep();
  assert.equal((await peek(r.t, id)).length, 1, "one fire at a time");
  assert.equal(await r.t.fakes.schedules.lastFired("m"), T0 + 120_000);
});

test("a retried fire does not double-steer: the fire key is the schedule id and scheduled time", async () => {
  const r = rig();
  const id = await started(r);
  await r.t.operator("PUT", "/v1/schedules/m", { ...base, agent: id });
  r.setClock(T0 + 90_000);
  await r.t.cronExt.sweep();
  await r.t.fakes.mailbox.receive(id, "consume"); // consumed, so only the key can stop a repeat
  r.t.fakes.schedules.lastFiredAt.delete("m"); // simulate a crash between delivery and the cursor write
  await r.t.cronExt.sweep();
  assert.deepEqual(await peek(r.t, id), [], "the replayed fire was recognized as a duplicate");
});

test("agent scope: self only, derived from the credential; 403 otherwise; operator may target any agent", async () => {
  const r = rig("run", Date.now());
  const a = await started(r);
  const other = await r.t.spawn("k2", { name: "other" });
  await until(async () => (await get(r.t, other.id)).state === "running");
  // Body agent omitted: the daemon fills in the caller. Body naming someone else: 403.
  const mine = await asAgent(r.t, a, "PUT", "/v1/schedules/mine", { ...base, cron: "*/10 * * * *" });
  assert.equal(mine.status, 200);
  assert.deepEqual([(mine.body as Schedule).agent, (mine.body as Schedule).createdBy], [a, a]);
  assert.equal((await asAgent(r.t, a, "PUT", "/v1/schedules/x", { ...base, cron: "*/10 * * * *", agent: other.id })).status, 403);
  assert.equal(
    (await asAgent(r.t, a, "PUT", "/v1/schedules/x", { ...base, cron: "*/10 * * * *", budgetMicros: 5 })).status,
    400,
    "spawn params make no sense for a self wakeup",
  );
  // The operator may target any agent; the agent cannot touch or see it unless it targets the agent itself.
  assert.equal((await r.t.operator("PUT", "/v1/schedules/theirs", { ...base, agent: other.id })).status, 200);
  assert.equal((await asAgent(r.t, a, "DELETE", "/v1/schedules/theirs?key=d1")).status, 403);
  assert.equal((await asAgent(r.t, a, "PUT", "/v1/schedules/theirs", { ...base, cron: "*/10 * * * *" })).status, 403);
  assert.equal((await r.t.operator("PUT", "/v1/schedules/spawny", base)).status, 200);
  assert.equal((await asAgent(r.t, a, "DELETE", "/v1/schedules/spawny?key=d2")).status, 403);
  assert.equal((await asAgent(r.t, a, "PUT", "/v1/schedules/spawny", { ...base, cron: "*/10 * * * *" })).status, 403);
  assert.equal((await asAgent(r.t, a, "POST", "/v1/schedules/mine/pause", { key: "k" })).status, 403, "pause stays operator-only");
  assert.deepEqual(
    ((await asAgent(r.t, a, "GET", "/v1/schedules")).body as Schedule[]).map((s) => s.id),
    ["mine"],
  );
  assert.deepEqual(((await r.t.operator("GET", "/v1/schedules")).body as Schedule[]).map((s) => s.id).sort(), ["mine", "spawny", "theirs"]);
  const own = await asAgent(r.t, a, "DELETE", "/v1/schedules/mine?key=d3");
  assert.deepEqual([own.status, (own.body as { removed: boolean }).removed], [200, true]);
});

test("agent-created schedules may fire every minute and are capped per agent", async () => {
  const r = rig("run", Date.now());
  const a = await started(r);
  assert.equal(MIN_AGENT_INTERVAL_MS, 60_000);
  assert.equal((await asAgent(r.t, a, "PUT", "/v1/schedules/s0", base)).status, 200);
  for (let i = 1; i < MAX_AGENT_SCHEDULES; i++)
    assert.equal((await asAgent(r.t, a, "PUT", `/v1/schedules/s${i}`, { ...base, cron: "*/10 * * * *" })).status, 200);
  assert.equal((await asAgent(r.t, a, "PUT", "/v1/schedules/over", { ...base, cron: "*/10 * * * *" })).status, 429);
  assert.equal(
    (await asAgent(r.t, a, "PUT", "/v1/schedules/s0", { ...base, cron: "*/15 * * * *" })).status,
    200,
    "replacing one of its own is not a new schedule",
  );
  // The operator is exempt from the per-agent cap.
  assert.equal((await r.t.operator("PUT", "/v1/schedules/op", { ...base, agent: a })).status, 200);
});

test("an agent's own schedules are removed when it exits; an operator's targeted one is orphaned instead", async () => {
  const r = rig("finish", Date.now());
  await r.t.extensions.startAll(); // journal dispatch drives the exit hook
  const a = await started(r);
  await asAgent(r.t, a, "PUT", "/v1/schedules/self", { ...base, cron: "*/10 * * * *" });
  await r.t.operator("PUT", "/v1/schedules/ops", { ...base, agent: a });
  r.release();
  await until(async () => !(await r.t.fakes.schedules.get("self")), 3000);
  assert.ok(await r.t.fakes.schedules.get("ops"), "operator-created schedules outlive the agent until swept");
  r.tick(90_000);
  await r.t.cronExt.sweep();
  assert.equal((await r.t.fakes.schedules.get("ops"))!.orphaned, true);
});

test("agent scope: an invalid tz is a 400, not a 500", async () => {
  const r = rig("run", Date.now());
  const a = await started(r);
  const res = await asAgent(r.t, a, "PUT", "/v1/schedules/bad", { ...base, cron: "*/10 * * * *", tz: "Mars/Olympus" });
  assert.equal(res.status, 400);
});
