import assert from "node:assert/strict";
import { test } from "node:test";
import { egressAuditReport, nearCap, nearCapTransition, stuckSpools } from "./health.ts";

const status = (open: string[], quarantined: string[], max = 16) => ({ quarantined, retention: { spools: open.length + 3, max, closed: 3, open } });
const ids = (n: number, p = "sb") => Array.from({ length: n }, (_, i) => `${p}${i}`);

test("stuckSpools counts a quarantined-and-open spool once", () => {
  assert.equal(stuckSpools(status(["a", "b"], ["b", "c"])), 3);
  assert.equal(stuckSpools({ quarantined: ["x"] }), 1);
});

test("nearCap triggers at max - 2 and not below; a reader without a cap never triggers", () => {
  assert.equal(nearCap(status(ids(13), [])), false);
  assert.equal(nearCap(status(ids(14), [])), true);
  assert.equal(nearCap(status(ids(12), ids(2, "q"))), true);
  assert.equal(nearCap({ quarantined: ids(20) }), false);
});

test("egressAuditReport carries counts only, never ids", () => {
  const r = egressAuditReport(status(["secret-a"], ["secret-a"]));
  assert.deepEqual(r, { quarantined: 1, retention: { spools: 4, max: 16, closed: 3, open: 1 }, nearCap: false });
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.deepEqual(egressAuditReport({ quarantined: [] }), { quarantined: 0, nearCap: false });
});

test("nearCapTransition logs once per transition, not per tick", () => {
  const hi = status(ids(14), []);
  const lo = status(ids(2), []);
  const up = nearCapTransition(false, hi);
  assert.equal(up.nearCap, true);
  assert.match(up.line ?? "", /nearing the cap \(14 .* of 16\)/);
  assert.equal(nearCapTransition(true, hi).line, undefined);
  assert.equal(nearCapTransition(false, lo).line, undefined);
  const down = nearCapTransition(true, lo);
  assert.equal(down.nearCap, false);
  assert.match(down.line ?? "", /cleared/);
});
