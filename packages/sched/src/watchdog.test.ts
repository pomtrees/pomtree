import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WATCHDOG, evaluate, hasLadderReason, tripReasons, type WatchdogSnapshot } from "./watchdog.ts";

const base: WatchdogSnapshot = {
  now: 1_000_000,
  startedAt: 0,
  lastProgressAt: 999_000,
  deadlineAt: null,
  budgetMicros: 1_000_000,
  spentMicros: 0,
  recentFailures: 0,
  rung: "none",
  lastActionAt: null,
  retries: 0,
};
const stalled = { ...base, lastProgressAt: 0 };

test("healthy agent: no action", () => {
  assert.deepEqual(evaluate(base), { action: "none", reasons: [], warnBudget: false, budgetThreshold: 0.9 });
});

test("each signal trips independently", () => {
  assert.deepEqual(evaluate(stalled).reasons, ["stalled"]);
  assert.deepEqual(evaluate({ ...base, deadlineAt: 900_000 }).reasons, ["deadline"]);
  assert.deepEqual(evaluate({ ...base, spentMicros: 950_000 }).reasons, ["budget"]);
  assert.deepEqual(evaluate({ ...base, recentFailures: 3 }).reasons, ["failures"]);
  const burn = evaluate({ ...base, spentMicros: 500_000 }, { budgetFraction: 1, maxBurnMicrosPerMin: 1000 });
  assert.deepEqual(burn.reasons, ["burn_rate"]);
});

test("ladder climbs nudge -> cancel -> kill_resume -> escalate -> quarantine", () => {
  assert.equal(evaluate(stalled).action, "nudge");
  assert.equal(evaluate({ ...stalled, rung: "nudged" }).action, "cancel");
  assert.equal(evaluate({ ...stalled, rung: "cancelled", retries: 0 }).action, "kill_resume");
  assert.equal(evaluate({ ...stalled, rung: "cancelled", retries: 1 }).action, "kill_resume");
  assert.equal(evaluate({ ...stalled, rung: "cancelled", retries: 2 }).action, "escalate");
  assert.equal(evaluate({ ...stalled, rung: "escalated", retries: 2 }).action, "quarantine");
});

test("retry limit is configurable", () => {
  assert.equal(evaluate({ ...stalled, rung: "cancelled", retries: 1 }, { maxRetries: 1 }).action, "escalate");
});

test("grace period holds the ladder after an action", () => {
  assert.equal(evaluate({ ...stalled, rung: "nudged", lastActionAt: 999_000 }).action, "none");
  assert.equal(evaluate({ ...stalled, rung: "nudged", lastActionAt: 800_000 }).action, "cancel");
});

test("grace period starts exactly at lastActionAt", () => {
  assert.equal(evaluate({ ...stalled, rung: "nudged", lastActionAt: base.now }).action, "none");
});

test("grace period ends exactly graceMs after the action", () => {
  const lastActionAt = base.now - DEFAULT_WATCHDOG.graceMs;
  assert.equal(evaluate({ ...stalled, rung: "nudged", lastActionAt }).action, "cancel");
  assert.equal(evaluate({ ...stalled, rung: "nudged", lastActionAt: lastActionAt + 1 }).action, "none");
});

test("past-deadline skips the nudge", () => {
  assert.equal(evaluate({ ...base, deadlineAt: 900_000 }).action, "cancel");
});

test("deadline trips exactly at deadlineAt", () => {
  assert.deepEqual(evaluate({ ...base, deadlineAt: base.now }).reasons, ["deadline"]);
  assert.deepEqual(evaluate({ ...base, deadlineAt: base.now + 1 }).reasons, []);
});

test("quarantined is terminal: no further action", () => {
  assert.deepEqual(evaluate({ ...stalled, rung: "quarantined" }), {
    action: "none",
    reasons: ["stalled"],
    warnBudget: false,
    budgetThreshold: 0.9,
  });
});

test("budget alone is advisory: warnBudget true, no ladder action", () => {
  const r = evaluate({ ...base, spentMicros: 950_000 });
  assert.deepEqual(r, { action: "none", reasons: ["budget"], warnBudget: true, budgetThreshold: 0.9 });
  assert.equal(evaluate({ ...base, spentMicros: 900_000 }).warnBudget, true);
  assert.equal(evaluate({ ...base, spentMicros: 2_000_000, rung: "cancelled", retries: 2 }).action, "none");
});

test("below the budget fraction: no warning; threshold is configurable", () => {
  assert.equal(evaluate({ ...base, spentMicros: 899_999 }).warnBudget, false);
  assert.equal(evaluate({ ...base, budgetMicros: 0, spentMicros: 5 }).warnBudget, false);
  const r = evaluate({ ...base, spentMicros: 500_000 }, { budgetFraction: 0.5 });
  assert.equal(r.warnBudget, true);
  assert.equal(r.budgetThreshold, 0.5);
});

test("budget plus a real stall climbs on the stall", () => {
  const r = evaluate({ ...stalled, spentMicros: 950_000 });
  assert.equal(r.action, "nudge");
  assert.equal(r.warnBudget, true);
  assert.deepEqual(r.reasons, ["stalled", "budget"]);
  assert.equal(evaluate({ ...stalled, spentMicros: 950_000, rung: "nudged" }).action, "cancel");
});

test("backward clock step: grace counts as elapsed, the watchdog acts again", () => {
  const r = evaluate({ ...stalled, rung: "nudged", lastActionAt: 1_500_000 });
  assert.equal(r.action, "cancel");
  assert.equal(evaluate({ ...stalled, lastActionAt: 1_000_001 }).action, "nudge");
});

test("clockGapMs: a suspend gap does not trip stalled; absent or non-positive behaves as before", () => {
  assert.deepEqual(evaluate({ ...stalled, clockGapMs: 1_000_000 }).reasons, []);
  assert.equal(evaluate({ ...stalled, clockGapMs: 1_000_000 }).action, "none");
  assert.deepEqual(evaluate({ ...stalled, clockGapMs: 400_000 }).reasons, ["stalled"]); // 600_000 left == stallMs
  assert.deepEqual(evaluate({ ...stalled, clockGapMs: 400_001 }).reasons, []);
  assert.deepEqual(evaluate({ ...stalled, clockGapMs: 0 }), evaluate(stalled));
  assert.deepEqual(evaluate({ ...stalled, clockGapMs: -5 }), evaluate(stalled));
  assert.deepEqual(evaluate({ ...base, clockGapMs: 10 }), evaluate(base));
});

test("clockGapMs does not mask a deadline", () => {
  assert.deepEqual(evaluate({ ...stalled, deadlineAt: 900_000, clockGapMs: 1_000_000 }).reasons, ["deadline"]);
});

test("stall threshold is inclusive when there is no clock gap", () => {
  const at = (now: number) => ({ ...base, now, lastProgressAt: 0 });
  // Default stallMs is 10 minutes; clockGapMs is absent.
  assert.deepEqual(evaluate(at(600_000)).reasons, ["stalled"]);
  assert.deepEqual(evaluate(at(599_999)).reasons, []);
});

test("hasLadderReason ignores the advisory budget reason", () => {
  assert.equal(hasLadderReason([]), false);
  assert.equal(hasLadderReason(["budget"]), false);
  assert.equal(hasLadderReason(["budget", "stalled"]), true);
  assert.equal(hasLadderReason(["failures"]), true);
});

test("burn rate uses a 60,000 ms minute", () => {
  const snapshot: WatchdogSnapshot = {
    now: 60_000,
    startedAt: 0,
    lastProgressAt: 60_000,
    deadlineAt: null,
    budgetMicros: 0,
    spentMicros: 1_000,
    recentFailures: 0,
    rung: "none",
    lastActionAt: null,
    retries: 0,
  };
  const options = {
    ...DEFAULT_WATCHDOG,
    stallMs: 1_000_000,
    budgetFraction: 1,
    maxBurnMicrosPerMin: 1_000,
    failureLimit: 999,
  };

  assert.deepEqual(tripReasons(snapshot, options), []);
  assert.deepEqual(tripReasons({ ...snapshot, spentMicros: 1_001 }, options), ["burn_rate"]);
});

test("burn rate uses elapsed minutes since start, not the sum of now and startedAt", () => {
  const snapshot = { ...base, startedAt: 600_000, spentMicros: 800_000 };
  const result = evaluate(snapshot, { budgetFraction: 1, maxBurnMicrosPerMin: 100_000 });
  assert.deepEqual(result.reasons, ["burn_rate"]);
});

test("burn rate equal to the limit does not trip", () => {
  const options = { budgetFraction: 1, maxBurnMicrosPerMin: 1_000 };
  const atLimit: WatchdogSnapshot = { ...base, startedAt: 940_000, spentMicros: 1_000 };
  assert.ok(!evaluate(atLimit, options).reasons.includes("burn_rate"));
  assert.deepEqual(evaluate({ ...atLimit, spentMicros: 1_001 }, options).reasons, ["burn_rate"]);
});
