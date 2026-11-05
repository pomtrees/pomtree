import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MERGE_ROUNDS, mergeJournalPayload, mergeResumeKey, mergeSettled, mergeTipKey, mergeWake, pathDenied } from "./merge.ts";

test("mergeTipKey is stable per (caller, child, base, source) and sensitive to each", () => {
  const p = { caller: "p", child: "c", base: "b", source: "s" };
  assert.equal(mergeTipKey(p), mergeTipKey({ ...p }));
  for (const k of ["caller", "child", "base", "source"] as const) assert.notEqual(mergeTipKey(p), mergeTipKey({ ...p, [k]: "x" }));
  assert.notEqual(mergeTipKey({ caller: "a", child: "bc", base: "d", source: "e" }), mergeTipKey({ caller: "ab", child: "c", base: "d", source: "e" })); // no concatenation ambiguity
});

test("mergeResumeKey is (child, generation, round)", () => {
  assert.equal(mergeResumeKey("c", 2, 1), "merge-resume:c:2:1");
  assert.notEqual(mergeResumeKey("c", 2, 1), mergeResumeKey("c", 3, 1));
});

test("mergeSettled: merged, escalated and empty settle a child; open states do not", () => {
  assert.equal(mergeSettled("none", true), true);
  assert.equal(mergeSettled("escalated", false), true);
  assert.equal(mergeSettled("empty", false), true);
  for (const s of ["none", "conflict", "check_failed"] as const) assert.equal(mergeSettled(s, false), false);
});

test("mergeJournalPayload maps outcomes to journal kinds and skips moved/policy_rejected", () => {
  assert.deepEqual(mergeJournalPayload("c", "t", { status: "merged", commit: "m", base: "b", source: "s" }), {
    kind: "merged",
    child: "c",
    target: "t",
    commit: "m",
  });
  assert.equal(mergeJournalPayload("c", "t", { status: "conflict", paths: ["a"], targetTip: "b", sourceTip: "s", round: 2 })?.kind, "merge_conflict");
  assert.equal(
    mergeJournalPayload("c", "t", { status: "check_failed", summary: "x", candidate: "k", targetTip: "b", sourceTip: "s", round: 1 })?.kind,
    "check_failed",
  );
  assert.equal(
    mergeJournalPayload("c", "t", { status: "escalate", reason: "check_failed", rounds: 3, targetTip: "b", sourceTip: "s", summary: "x" })?.kind,
    "merge_escalated",
  );
  assert.equal(mergeJournalPayload("c", "t", { status: "moved", attempts: 5, targetTip: "b" }), null);
  assert.equal(mergeJournalPayload("c", "t", { status: "policy_rejected", code: "denied_path", message: "m" }), null);
});

test("mergeWake names the paths, the parent tip and the round, and bounds a long list", () => {
  const w = mergeWake({ callerTip: "abc", paths: ["a.txt", "dir/b.txt"], round: 1 });
  assert.ok(w.includes("abc") && w.includes('"a.txt"') && w.includes(`round 1 of ${MAX_MERGE_ROUNDS}`));
  const long = mergeWake({ callerTip: "abc", paths: Array.from({ length: 80 }, (_, i) => `f${i}`), round: 2 });
  assert.ok(long.includes("and 30 more"));
});

test("pathDenied matches whole path components under a prefix", () => {
  assert.equal(pathDenied(".github/workflows/ci.yml", [".github/"]), ".github/");
  assert.equal(pathDenied(".github", [".github"]), ".github");
  assert.equal(pathDenied(".githubx/a", [".github"]), null);
  assert.equal(pathDenied("a/.github/x", [".github"]), null);
  assert.equal(pathDenied("a", ["", "/"]), null);
});
