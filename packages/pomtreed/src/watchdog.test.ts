import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, SandboxSpec, Signal } from "@pomtree/core";
import { providerExhaustedMessage, providerStopMessage, timedOutMessage } from "./daemon/lifecycle.ts";
import { setup, spawnSpec, until } from "./test-setup.ts";

// Each test creates a running, non-root agent directly in the registry (no live drive handle), then drives the
// watchdog with a controlled clock. Only "stalled" trips: budgetFraction is left alone (spent 0), failureLimit is
// raised so a lone error event never trips, and stallMs/graceMs are small so clock bumps climb one rung at a time.

const spec = (agent: string): SandboxSpec => ({ agent, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] });

async function runningAgent(t: ReturnType<typeof setup>, idempotencyKey: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${idempotencyKey}-run` });
  return a;
}

const baseOpts = { stallMs: 1_000, graceMs: 500, failureLimit: 100 };

test("nudge delivers a message signal to the mailbox and journals it", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();

  const box = await t.daemon.deps.mailbox.peek(a.id);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "message");
  assert.equal((box[0] as { from: string }).from, (await t.daemon.root()).id);

  const signals = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "signal");
  assert.equal(signals.length, 1);
  assert.equal((signals[0]!.payload as { kind: string; signal: Signal }).signal.kind, "message");
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
  // the agent is still running; only a signal was delivered
  assert.equal((await t.daemon.get(a.id))!.state, "running");
});

test("a nudged agent that is still stalled is cancelled", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  await t.fakes.watchdogs.set(a.id, { rung: "nudged", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();

  const after = await t.daemon.get(a.id);
  assert.equal(after!.exit, "cancelled");
  assert.ok(after!.state === "exited" || after!.state === "reaped");
});

test("kill_resume kills the sandbox and finishes failed (no checkpoints yet)", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { ...baseOpts, maxRetries: 1 } });
  const a = await runningAgent(t, "a");
  const sb = await t.fakes.sandbox.start(spec(a.id), "sb-kill-resume");
  await t.daemon.deps.registry.setSandbox(a.id, a.generation, sb.id, "set-kill-resume");
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();

  const after = await t.daemon.get(a.id);
  assert.equal(after!.exit, "failed");
  const kills = t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "kill").map((c) => c.args[0] as string);
  assert.ok(kills.includes(sb.id));
});

test("escalate journals an error when retries are exhausted", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { ...baseOpts, maxRetries: 0 } });
  const a = await runningAgent(t, "a");
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();

  const errors = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.equal(errors.length, 1);
  assert.match((errors[0]!.payload as { message: string }).message, /watchdog escalated/);
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "escalated");
});

test("an escalated agent is quarantined on the next trip", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  await t.fakes.watchdogs.set(a.id, { rung: "escalated", lastActionAt: clock, retries: 2 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();

  const errors = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.equal(errors.length, 1);
  assert.match((errors[0]!.payload as { message: string }).message, /watchdog quarantined/);
});

test("a healthy agent is never acted on, and the grace period holds the ladder", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  await t.daemon.sweepWatchdogs(); // no stall yet: lastProgressAt == createdAt
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0);
  assert.equal(await t.fakes.watchdogs.get(a.id), null);

  await t.fakes.watchdogs.set(a.id, { rung: "none", lastActionAt: clock + 1_999, retries: 0 }, "seed");
  clock += 2_000; // stalled, but an action happened < graceMs ago
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0);
});

// Regression: a genuinely-running agent is driven through the live handle (drive() puts it in this.live),
// so the watchdog must NOT skip it. This test fails if sweepWatchdogs ignores live agents.
test("a live, driven agent that stalls is nudged through its live handle", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100 } });
  const a = await t.spawn();
  await until(async () => (await t.daemon.get(a.id))!.state === "running" && (await t.daemon.get(a.id))!.sandbox !== null);
  assert.ok((await t.daemon.get(a.id))!.sandbox, "driven agent owns a live sandbox handle");
  clock += 2_000; // past stallMs with no new journal progress
  await t.daemon.sweepWatchdogs();

  const box = await t.daemon.deps.mailbox.peek(a.id);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "message");
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");

  await t.daemon.kill(a.id);
  await t.orchestrator.idle();
});

test("a recovered agent resets to the bottom and later stalls climb from none", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 1 }, "seed");
  await t.daemon.sweepWatchdogs(); // no trip reasons: the ladder resets rung/retries but keeps lastActionAt
  assert.deepEqual(await t.fakes.watchdogs.get(a.id), { rung: "none", lastActionAt: clock, retries: 0 });
  clock += 2_000; // a later stall starts from the bottom: nudge, not cancel/kill_resume
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
});

test("recovery keeps lastActionAt so a stale error cannot re-trip", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    watchdogOptions: { stallMs: 1_000_000, graceMs: 500, failureLimit: 1 },
  });
  const a = await runningAgent(t, "a");
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "error", message: "old" }, idempotencyKey: "old" });
  clock += 1;
  await t.daemon.sweepWatchdogs(); // the lone error trips failures -> nudge, stamping lastActionAt
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
  const actedAt = (await t.fakes.watchdogs.get(a.id))!.lastActionAt;
  clock += 1;
  await t.daemon.sweepWatchdogs(); // the old error predates lastActionAt, so it no longer trips
  assert.deepEqual(await t.fakes.watchdogs.get(a.id), { rung: "none", lastActionAt: actedAt, retries: 0 });
  clock += 1;
  await t.daemon.sweepWatchdogs(); // still anchored: the stale error does not reopen the window
  assert.deepEqual(await t.fakes.watchdogs.get(a.id), { rung: "none", lastActionAt: actedAt, retries: 0 });
});

test("a terminal exit's reason entries (provider stop, retries exhausted, timed out) are not counted as recent failures; an ordinary error is", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000_000, graceMs: 500, failureLimit: 1 } });
  const a = await runningAgent(t, "a");
  const terminal = [
    providerStopMessage("auth", "401"),
    providerStopMessage("funding"),
    providerStopMessage("config"),
    providerExhaustedMessage(3, "outage", "503"),
    timedOutMessage(a.id, "running", 0),
  ];
  for (const [i, message] of terminal.entries())
    await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "error", message }, idempotencyKey: `term-${i}` });
  clock += 1;
  await t.daemon.sweepWatchdogs();
  assert.equal(await t.fakes.watchdogs.get(a.id), null, "no failure trip from terminal-exit reasons");
  // negative control: one ordinary error entry trips failureLimit 1
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "error", message: "drive failed" }, idempotencyKey: "plain" });
  clock += 1;
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
});

test("kill_resume on a live driven agent finishes failed, not cancelled", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { ...baseOpts, maxRetries: 1 } });
  const a = await t.spawn();
  await until(async () => (await t.daemon.get(a.id))!.state === "running");
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(a.id))!.exit, "failed");
});

test("the watchdog's own nudge does not count as progress", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000, graceMs: 100, failureLimit: 100 } });
  const a = await runningAgent(t, "a");
  clock += 2_000;
  await t.daemon.sweepWatchdogs(); // nudge
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
  clock += 200; // past graceMs (100), but under stallMs (1000) measured from the nudge
  await t.daemon.sweepWatchdogs();
  // The agent never made real progress, so it is still stalled and must climb to cancel.
  assert.equal((await t.daemon.get(a.id))!.exit, "cancelled");
});

test("a second stall in the same generation re-fires the watchdog action", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000, graceMs: 100, failureLimit: 100 } });
  const a = await runningAgent(t, "a");
  clock += 2_000;
  await t.daemon.sweepWatchdogs(); // first stall -> nudge
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
  // Recover: real progress resets the ladder.
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "message", role: "assistant", text: "progress" },
    idempotencyKey: "p1",
  });
  clock += 1;
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "none");
  // Stall again in the same generation -> a second nudge must be journaled (keys are unique).
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  const signals = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "signal");
  assert.equal(signals.length, 2);
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 2); // both nudges delivered, not deduped by key
});

test("a watchdog-authored error does not trip the failure limit", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000_000, graceMs: 500, failureLimit: 1 } });
  const a = await runningAgent(t, "a");
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "error", message: "watchdog escalated: stalled" },
    idempotencyKey: "w1",
  });
  clock += 1;
  await t.daemon.sweepWatchdogs();
  assert.equal(await t.fakes.watchdogs.get(a.id), null); // no trip -> no action
});

// --- Pure watchdog helpers (packages/pomtreed/src/watchdog.ts) ---

import type { JournalEntry } from "@pomtree/core";
import { blockedSince, foldBlocked, intensityRetries, newBlockedScan, openCallSince, QUARANTINED_KIND } from "./watchdog.ts";

const je = (ts: number, payload: JournalEntry["payload"]): JournalEntry => ({ seq: ts, ts, agent: "a", host: "h1", generation: 0, payload });

test("blockedSince: an open escalation blocks from its createdAt", () => {
  assert.equal(blockedSince([], 42), 42);
  assert.equal(blockedSince([je(1, { kind: "tool_call", tool: "t", callId: "c", input: {} })], 42), 42, "escalation wins over a tool call");
});

test("blockedSince: an in-flight tool_call blocks, and a result clears it", () => {
  const open = [je(10, { kind: "tool_call", tool: "t", callId: "c1", input: {} })];
  assert.equal(blockedSince(open, null), 10);
  const closed = [...open, je(11, { kind: "tool_result", callId: "c1", ok: true, output: "" })];
  assert.equal(blockedSince(closed, null), null);
});

test("blockedSince folds pages incrementally (bounded scan) and matches a single pass", () => {
  const entries = [
    je(1, { kind: "tool_call", tool: "t", callId: "a", input: {} }),
    je(2, { kind: "tool_call", tool: "t", callId: "b", input: {} }),
    je(3, { kind: "tool_result", callId: "a", ok: true, output: "" }),
    je(4, { kind: "tool_call", tool: "t", callId: "c", input: {} }),
    je(5, { kind: "tool_result", callId: "b", ok: true, output: "" }),
  ];
  // a (1) and b (2) closed; c (4) is still open -> earliest open call is 4.
  assert.equal(blockedSince(entries, null), 4);
  const scan = newBlockedScan();
  foldBlocked(scan, entries.slice(0, 3));
  foldBlocked(scan, entries.slice(3));
  assert.equal(openCallSince(scan), 4, "paged fold matches a single pass");
  // Escalation short-circuits before any fold.
  assert.equal(blockedSince(entries, 42), 42);
});

test("intensityRetries: counts within the window and resets after a stable stretch", () => {
  const now = 100_000;
  assert.equal(intensityRetries([], now, 60_000, 30_000), 0);
  // One restart 20s ago (within 60s window, within 30s stable) -> 1.
  assert.equal(intensityRetries([now - 20_000], now, 60_000, 30_000), 1);
  // A restart 40s ago: past the 30s stable threshold -> reset to 0.
  assert.equal(intensityRetries([now - 40_000], now, 60_000, 30_000), 0);
  // Two restarts within the window, last recent -> 2.
  assert.equal(intensityRetries([now - 50_000, now - 10_000], now, 60_000, 30_000), 2);
  // The older of the two falls outside the window -> only the recent one counts.
  assert.equal(intensityRetries([now - 70_000, now - 10_000], now, 60_000, 30_000), 1);
});

// --- blocked-agent exemption ---

test("a blocked agent (open escalation) is exempt from the stall ladder until blockedMs", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100 },
    limits: { watchdogBlockedMs: 5_000 },
  });
  const a = await runningAgent(t, "a");
  await t.daemon.ask(a.id, { question: "approve?", generation: a.generation, idempotencyKey: "q1" });
  clock += 2_000; // past stallMs (1s) but within blockedMs (5s)
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0, "no nudge while legitimately blocked");
  assert.equal(await t.fakes.watchdogs.get(a.id), null);

  clock += 4_000; // 6s since the ask -> past blockedMs
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
});

// --- watchdog intensity ---

test("kill_resume restart timestamps persist: a second climb escalates instead of another kill_resume", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100, maxRetries: 1 },
  });
  const a = await runningAgent(t, "a");
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );

  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs(); // kill_resume: journals the restart timestamp and resumes (generation bump)
  const cur = await t.daemon.get(a.id);
  assert.ok(cur && cur.generation > a.generation, "kill_resume resumed the checkpointed agent");
  const persisted = await t.fakes.watchdogs.get(a.id);
  assert.equal(persisted?.restarts?.length, 1, "the restart timestamp is durable in the WatchdogStore");
  assert.ok(
    !(await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === "ext.pomtreed.watchdog_restart"),
    "restarts no longer persist as journal entries",
  );

  // A second climb in the same intensity window must escalate, not kill_resume again.
  await t.fakes.watchdogs.set(
    cur!.id,
    { rung: "cancelled", lastActionAt: clock, retries: 0, ...(persisted?.restarts && { restarts: persisted.restarts }) },
    "seed2",
  );
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  const errors = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.ok(
    errors.some((e) => (e.payload as { message: string }).message.startsWith("watchdog escalated")),
    "intensity budget exhausted -> escalate",
  );

  await t.daemon.kill(cur!.id); // unblock the still-running resumed agent
});

test("quarantine journals a durable marker and does not re-alert on later sweeps", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100 } });
  const a = await runningAgent(t, "a");
  await t.fakes.watchdogs.set(a.id, { rung: "escalated", lastActionAt: clock, retries: 2 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  assert.ok(
    (await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === QUARANTINED_KIND),
    "durable quarantine marker journaled",
  );

  clock += 2_000;
  await t.daemon.sweepWatchdogs(); // still escalated -> quarantine again, but alerts are keyed once
  const errors = (await t.journal.read({ agent: a.id })).filter(
    (e) => e.payload.kind === "error" && (e.payload as { message: string }).message.startsWith("watchdog quarantined"),
  );
  assert.equal(errors.length, 1, "the quarantine alert is keyed once per (agent, rung)");
});

// --- watchdog-suspend (clockGapMs), C2b-15 (budget-only reset), C2b-16 (terminal quarantine) ---

test("a host-suspend gap is not a stall: the gap is fed as clockGapMs until the agent next makes progress", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts, limits: { watchdogSweepMs: 100 } });
  const a = await runningAgent(t, "a");
  await t.daemon.sweepWatchdogs(); // baseline sweep
  clock += 60_000; // suspended for a minute: far past stallMs (1s), and past 2 * watchdogSweepMs
  await t.daemon.sweepWatchdogs(); // the gap sweep itself is skipped (one-sweep grace)
  clock += 100;
  await t.daemon.sweepWatchdogs(); // without clockGapMs this sweep would nudge: now - lastProgressAt is ~60s
  clock += 100;
  await t.daemon.sweepWatchdogs(); // still fed (no journal progress since): the gap stays subtracted
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0, "no nudge for the suspend gap");
  assert.equal(await t.fakes.watchdogs.get(a.id), null);
  // A real stall after the gap still trips: only the unwatched interval is forgiven (1.2s of watched silence > stallMs).
  for (let i = 0; i < 9; i++) {
    clock += 100;
    await t.daemon.sweepWatchdogs();
  }
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
});

test("journal progress after a suspend gap stops it counting: a later stall is measured from the progress", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts, limits: { watchdogSweepMs: 100 } });
  const a = await runningAgent(t, "a");
  await t.daemon.sweepWatchdogs();
  clock += 60_000;
  await t.daemon.sweepWatchdogs(); // gap recorded
  clock += 100;
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "message", role: "assistant", text: "back" },
    idempotencyKey: "p1",
  });
  for (let i = 0; i < 9; i++) {
    clock += 100;
    await t.daemon.sweepWatchdogs(); // under stallMs since the progress
  }
  assert.equal(await t.fakes.watchdogs.get(a.id), null);
  for (let i = 0; i < 3; i++) {
    clock += 100; // 1.2s since the progress: stalled, the old gap no longer subtracts anything
    await t.daemon.sweepWatchdogs();
  }
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
});

test("a recovered agent past the budget fraction resets its ladder (budget is advisory) and still gets its warning", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  const gateway = t.daemon.deps.gateway as { spend: (id: string) => Promise<{ spentMicros: number; budgetMicros: number }> };
  gateway.spend = async () => ({ spentMicros: 95_000, budgetMicros: 100_000 });
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 1 }, "seed");
  await t.daemon.sweepWatchdogs(); // reasons = ["budget"] only
  assert.deepEqual(await t.fakes.watchdogs.get(a.id), { rung: "none", lastActionAt: clock, retries: 0 });
  assert.deepEqual(
    (await t.daemon.deps.mailbox.peek(a.id)).map((s) => s.kind),
    ["budget_warning"],
  );
  clock += 2_000; // a later stall climbs from the bottom
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.fakes.watchdogs.get(a.id))!.rung, "nudged");
});

test("quarantine is terminal: a still-running quarantined agent is not re-quarantined, and no watchdog row is rewritten", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: baseOpts });
  const a = await runningAgent(t, "a");
  await t.fakes.watchdogs.set(a.id, { rung: "escalated", lastActionAt: clock, retries: 2 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  const after = await t.fakes.watchdogs.get(a.id);
  assert.equal(after!.rung, "quarantined");
  assert.equal(after!.quarantined, true);
  const keys: string[] = [];
  const set = t.fakes.watchdogs.set.bind(t.fakes.watchdogs);
  t.fakes.watchdogs.set = (id, st, key) => {
    keys.push(key);
    return set(id, st, key);
  };
  for (let i = 0; i < 3; i++) {
    clock += 2_000; // past graceMs each time, still stalled
    await t.daemon.sweepWatchdogs();
  }
  assert.deepEqual(keys, [], "no watchdog row written per graceMs");
  assert.deepEqual(await t.fakes.watchdogs.get(a.id), after);
  assert.equal((await t.daemon.get(a.id))!.state, "running");
});
