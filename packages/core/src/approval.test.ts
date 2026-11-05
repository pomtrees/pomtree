import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDecision, exceeds, ladderFor, nextRung, rankOfRung, rungsAbove, RANK_ORDER, RUNG_ORDER } from "./approval.ts";
import type { ApprovalRung } from "./types.ts";

const LADDER: ApprovalRung[] = ["parent-agent", "operator", "owner"];

test("rank and rung order are fixed and increasing", () => {
  assert.deepEqual([...RANK_ORDER], ["agent", "parent-agent", "operator", "owner"]);
  assert.deepEqual([...RUNG_ORDER], ["parent-agent", "operator", "owner"]);
  assert.equal(exceeds("parent-agent", "agent"), true);
  assert.equal(exceeds("operator", "agent"), true);
  assert.equal(exceeds("owner", "agent"), true);
  assert.equal(exceeds("operator", "parent-agent"), true);
  assert.equal(exceeds("owner", "operator"), true);
  assert.equal(exceeds("agent", "agent"), false);
  assert.equal(exceeds("parent-agent", "parent-agent"), false);
  assert.equal(exceeds("operator", "owner"), false);
  assert.equal(exceeds("owner", "owner"), false);
});

test("rungsAbove is the ladder above the requester's rank", () => {
  assert.deepEqual(rungsAbove("agent"), ["parent-agent", "operator", "owner"]);
  assert.deepEqual(rungsAbove("parent-agent"), ["operator", "owner"]);
  assert.deepEqual(rungsAbove("operator"), ["owner"]);
  assert.deepEqual(rungsAbove("owner"), []);
});

test("nextRung advances and runs out at the top", () => {
  assert.equal(nextRung("parent-agent"), "operator");
  assert.equal(nextRung("operator"), "owner");
  assert.equal(nextRung("owner"), null);
});

test("applyDecision: approve and deny settle; deny is final", () => {
  assert.deepEqual(applyDecision("agent", "owner", LADDER, 0, "approve"), {
    ok: true,
    outcome: { state: "approved", nextRung: null, failClosed: false },
  });
  assert.deepEqual(applyDecision("agent", "parent-agent", LADDER, 0, "deny"), {
    ok: true,
    outcome: { state: "denied", nextRung: null, failClosed: false },
  });
});

test("applyDecision: abstain/escalate/timeout advance a rung", () => {
  assert.deepEqual(applyDecision("agent", "parent-agent", LADDER, 0, "abstain"), {
    ok: true,
    outcome: { state: "pending", nextRung: "operator", failClosed: false },
  });
  assert.deepEqual(applyDecision("agent", "operator", LADDER, 1, "escalate"), {
    ok: true,
    outcome: { state: "pending", nextRung: "owner", failClosed: false },
  });
  assert.deepEqual(applyDecision("agent", "operator", LADDER, 1, "timeout"), {
    ok: true,
    outcome: { state: "pending", nextRung: "owner", failClosed: false },
  });
});

test("applyDecision: past the top rung fails closed to deny", () => {
  assert.deepEqual(applyDecision("agent", "owner", LADDER, 2, "abstain"), {
    ok: true,
    outcome: { state: "denied", nextRung: null, failClosed: true },
  });
  assert.deepEqual(applyDecision("agent", "owner", LADDER, 2, "timeout"), {
    ok: true,
    outcome: { state: "denied", nextRung: null, failClosed: true },
  });
  assert.deepEqual(applyDecision("operator", "owner", LADDER, 2, "escalate"), {
    ok: true,
    outcome: { state: "denied", nextRung: null, failClosed: true },
  });
});

test("applyDecision: approver rank must strictly exceed requester rank", () => {
  assert.deepEqual(applyDecision("agent", "agent", LADDER, 0, "approve"), {
    ok: false,
    reason: "approver rank agent does not exceed requester rank agent",
  });
  assert.deepEqual(applyDecision("operator", "operator", LADDER, 2, "approve"), {
    ok: false,
    reason: "approver rank operator does not exceed requester rank operator",
  });
  assert.deepEqual(applyDecision("operator", "parent-agent", LADDER, 2, "approve"), {
    ok: false,
    reason: "approver rank parent-agent does not exceed requester rank operator",
  });
});

test("applyDecision runs over an arbitrary ladder", () => {
  const ladder = ladderFor(["p", "gp"]);
  assert.deepEqual(ladder, ["agent:p", "agent:gp", "operator", "owner"]);
  assert.deepEqual(applyDecision("agent", "parent-agent", ladder, 0, "abstain"), {
    ok: true,
    outcome: { state: "pending", nextRung: "agent:gp", failClosed: false },
  });
  assert.deepEqual(applyDecision("agent", "parent-agent", ladder, 1, "timeout"), {
    ok: true,
    outcome: { state: "pending", nextRung: "operator", failClosed: false },
  });
  assert.deepEqual(applyDecision("agent", "owner", ladder, 3, "escalate"), {
    ok: true,
    outcome: { state: "denied", nextRung: null, failClosed: true },
  });
  assert.deepEqual(applyDecision("agent", "parent-agent", ladder, 1, "approve"), {
    ok: true,
    outcome: { state: "approved", nextRung: null, failClosed: false },
  });
});

test("ladderFor: depth 0, 1 and 3 chains; rankOfRung", () => {
  assert.deepEqual(ladderFor([]), ["operator", "owner"]);
  assert.deepEqual(ladderFor(["p"]), ["agent:p", "operator", "owner"]);
  assert.deepEqual(ladderFor(["a", "b", "c"]), ["agent:a", "agent:b", "agent:c", "operator", "owner"]);
  assert.equal(rankOfRung("agent:p"), "parent-agent");
  assert.equal(rankOfRung("parent-agent"), "parent-agent");
  assert.equal(rankOfRung("operator"), "operator");
  assert.equal(rankOfRung("owner"), "owner");
});
