import { test } from "node:test";
import assert from "node:assert/strict";
import { planJournalRetention } from "./retention.ts";

test("planJournalRetention: off when retention <= 0, otherwise prunable kinds minus protected", () => {
  assert.equal(planJournalRetention({ retentionMs: 0, keepPerAgent: 10 }), null);
  assert.equal(planJournalRetention({ retentionMs: Number.NaN, keepPerAgent: 10 }), null);
  const p = planJournalRetention({ retentionMs: 5, keepPerAgent: -3, protectKinds: ["usage"] })!;
  assert.deepEqual(p.kinds, ["message", "tool_call", "tool_result"]);
  assert.equal(p.keepPerAgent, 0);
  assert.ok(!p.kinds.includes("exited") && !p.kinds.includes("signal"));
});

test("planJournalRetention: a non-finite keepPerAgent falls back to 0", () => {
  assert.equal(planJournalRetention({ retentionMs: 5, keepPerAgent: Number.NaN })!.keepPerAgent, 0);
});
