import assert from "node:assert/strict";
import { test } from "node:test";
import { planEvictions } from "./folder-retention.ts";
import type { FolderCandidate, RetentionPolicy } from "./folder-retention.ts";

const DAY = 24 * 3600 * 1000;
const policy: RetentionPolicy = { idleMs: 7 * DAY, reapedGraceMs: 0, minFreeBytes: 0 };
const c = (agent: string, state: FolderCandidate["state"], since: number, busy = false): FolderCandidate => ({ agent, state, since, busy });
const ids = (e: { agent: string }[]) => e.map((x) => x.agent);

test("reaped folders are evicted; running, pending, exited and busy ones never are", () => {
  const plan = planEvictions(
    [c("r", "reaped", 0), c("run", "running", 0), c("p", "pending", 0), c("x", "exited", 0), c("busy", "reaped", 0, true)],
    100 * DAY,
    policy,
    null,
  );
  assert.deepEqual(plan.due, [{ agent: "r", reason: "reaped" }]);
  assert.deepEqual(plan.pressure, []);
});

test("a paused agent is evicted only after the idle window; 0 disables idle eviction", () => {
  const now = 10 * DAY;
  assert.deepEqual(ids(planEvictions([c("y", "yielded", now - 6 * DAY)], now, policy, null).due), []);
  assert.deepEqual(planEvictions([c("y", "yielded", now - 7 * DAY)], now, policy, null).due, [{ agent: "y", reason: "idle" }]);
  assert.deepEqual(planEvictions([c("y", "yielded", 0)], 1000 * DAY, { ...policy, idleMs: 0 }, null).due, []);
  assert.deepEqual(planEvictions([c("y", "yielded", 0, true)], 1000 * DAY, policy, null).due, [], "a resuming agent's folder is busy");
});

test("a reaped folder inside its grace is kept, then goes oldest first under disk pressure only", () => {
  const p: RetentionPolicy = { idleMs: 0, reapedGraceMs: DAY, minFreeBytes: 1000 };
  const cands = [c("new", "reaped", 90), c("old", "reaped", 10), c("mid", "reaped", 50), c("y", "yielded", 0)];
  const calm = planEvictions(cands, 100, p, 5000);
  assert.deepEqual(calm, { due: [], pressure: [] });
  const tight = planEvictions(cands, 100, p, 10);
  assert.deepEqual(tight.due, []);
  assert.deepEqual(tight.pressure, [
    { agent: "old", reason: "disk_pressure" },
    { agent: "mid", reason: "disk_pressure" },
    { agent: "new", reason: "disk_pressure" },
  ]);
  assert.deepEqual(planEvictions(cands, 100, p, null).pressure, [], "unknown free space is not pressure");
  assert.deepEqual(planEvictions(cands, 100, { ...p, minFreeBytes: 0 }, 10).pressure, [], "0 disables the pressure pass");
});

test("due evictions come oldest first", () => {
  const plan = planEvictions([c("b", "reaped", 20), c("a", "reaped", 10), c("z", "yielded", 5)], 100 * DAY, policy, null);
  assert.deepEqual(ids(plan.due), ["z", "a", "b"]);
});
