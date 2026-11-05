import assert from "node:assert/strict";
import { test } from "node:test";
import { OUTLINE, REFUSAL, ROOT_TASK, describePlan, formatReport, formatTree, parseAgentRefs } from "./chapters-text.ts";

const plan = {
  provider: "anthropic",
  image: "img:dev",
  budgetMicros: 2_500_000,
  timeoutMs: 600000,
};

test("describePlan names provider, auth path, image, cap and spend", () => {
  const s = describePlan(plan);
  for (const part of ["anthropic", "img:dev", "$2.50", "600s", "real money"]) assert.ok(s.includes(part), part);
});

test("root task mentions the outline, pomtree spawn, reaping, merging and pomtree result", () => {
  for (const part of ["outline.md", "pomtree spawn", "reap", "merge", "chapter1.md", "pomtree push", "pomtree result"])
    assert.ok(ROOT_TASK.includes(part), part);
  assert.ok(OUTLINE.includes("1.1") && OUTLINE.includes("1.2"));
  assert.ok(REFUSAL.includes("POMTREED_LIVE=1"));
});

test("formatTree nests children under their parent", () => {
  const t = formatTree(
    [
      { id: "r", name: "root", parent: null, state: "exited", exit: "succeeded" },
      { id: "a", name: "alpha", parent: "r", state: "reaped", exit: "succeeded" },
      { id: "b", name: "beta", parent: "r", state: "reaped", exit: "failed" },
    ],
    "r",
  );
  assert.equal(t, "root (r) exited succeeded\n  alpha (a) reaped succeeded\n  beta (b) reaped failed");
});

test("formatReport shows result, shortened hashes, chapter path, temp dir and timeout", () => {
  const out = formatReport({
    result: { ok: true },
    tree: "root (r) exited",
    branches: [{ branch: "agent/r", commit: "0123456789abcdef" }],
    chapterPath: "/t/chapter1.md",
    tempDir: "/t",
    timedOut: false,
  });
  for (const part of ['"ok": true', "agent/r  0123456789ab", "merged chapter: /t/chapter1.md", "temp dir: /t"]) assert.ok(out.includes(part), part);
  assert.ok(!out.includes("0123456789abc"));
  assert.ok(formatReport({ result: null, tree: "", branches: [], chapterPath: null, tempDir: "/t", timedOut: true }).includes("TIMED OUT"));
});

test("parseAgentRefs maps refs/agents/<id>/heads/<name> to the branch name and ignores other refs", () => {
  const out = ["refs/heads/main aaa111", "refs/agents/ag1/heads/agent/ag1 bbb222", "refs/agents/ag2/heads/agent/ag2 ccc333", "refs/tags/x ddd444"].join("\n");
  assert.deepEqual(parseAgentRefs(out), [
    { branch: "agent/ag1", commit: "bbb222" },
    { branch: "agent/ag2", commit: "ccc333" },
  ]);
});

test("parseAgentRefs gives [] for empty input and for a repo with only refs/heads/agent/* (the old layout)", () => {
  assert.deepEqual(parseAgentRefs(""), []);
  assert.deepEqual(parseAgentRefs("refs/heads/agent/ag1 bbb222\nrefs/heads/main aaa111"), []);
});
