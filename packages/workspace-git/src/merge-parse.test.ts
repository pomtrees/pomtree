import { test } from "node:test";
import assert from "node:assert/strict";
import type { MergeRequest, Repo } from "@pomtree/core";
import { candidateMessage, checkDiff, checkRequest, parseMergeTree } from "./merge-parse.ts";

const T = "a".repeat(40);
const repo: Repo = { id: "r", name: "r", defaultBranch: "main", policy: { deniedPaths: [".github/"], check: null } };
const req: MergeRequest = {
  repo: "r",
  host: "h",
  caller: "p",
  callerGeneration: 0,
  child: "c",
  source: "refs/agents/c/heads/agent/c",
  target: "refs/agents/p/heads/agent/p",
};

test("parseMergeTree: clean, conflicted (deduplicated), and non-results", () => {
  assert.deepEqual(parseMergeTree(`${T}\0`), { tree: T, conflicts: [] });
  assert.deepEqual(parseMergeTree(`${T}\0a b.txt\0dir/ü\0a b.txt\0`), { tree: T, conflicts: ["a b.txt", "dir/ü"] });
  assert.equal(parseMergeTree(""), null);
  assert.equal(parseMergeTree("merge-tree: nosuch - not something we can merge\n"), null);
});

test("checkRequest accepts the caller's branch and an approved protected branch, and refuses everything else", () => {
  assert.equal(checkRequest(req, repo), null);
  assert.equal(checkRequest({ ...req, target: "refs/heads/main" }, repo)?.code, "approval_required");
  assert.equal(checkRequest({ ...req, target: "refs/heads/main", approval: "a1" }, repo), null);
  for (const over of [
    { repo: "x" },
    { child: "p" },
    { source: "refs/heads/main" },
    { source: "refs/agents/d/heads/x" },
    { source: "--upload-pack=x" },
    { target: "refs/agents/d/heads/x" },
    { target: "refs/tags/t" },
    { target: "refs/heads/-x", approval: "a" },
    { caller: "../p" },
    { source: "refs/agents/c/heads/a..b" },
  ] as Partial<MergeRequest>[])
    assert.equal(checkRequest({ ...req, ...over }, repo)?.code, "bad_ref", JSON.stringify(over));
  assert.equal(checkRequest({ ...req, expectSource: "abc" }, repo)?.code, "bad_revision");
});

test("checkDiff applies the ingest path rules and the repo denylist", () => {
  const e = (path: string, mode = "100644") => ({ mode, oid: T, path });
  assert.equal(checkDiff([e("src/a.ts"), e("run.sh", "100755"), e("l", "120000")], [".github/"]), null);
  assert.equal(checkDiff([e(".github/workflows/ci.yml")], [".github/"])?.code, "denied_path");
  assert.equal(checkDiff([e("a/.git/config")], [])?.code, "unsafe_path");
  assert.equal(checkDiff([e("x/.gitmodules")], [])?.code, "submodule");
  assert.equal(checkDiff([e("sub", "160000")], [])?.code, "submodule");
  assert.equal(checkDiff([e("weird", "100666")], [])?.code, "unsafe_path");
});

test("candidateMessage carries the Pomtree-Agent trailer last", () => {
  const m = candidateMessage({ caller: "p", child: "c", source: T, target: "refs/agents/p/heads/agent/p" });
  assert.equal(m, `Merge c into agent/p\n\nPomtree-Agent: p\nPomtree-Merged: c ${T}\n`);
  assert.match(candidateMessage({ caller: "p", child: "c", source: T, target: "refs/heads/main" }), /^Merge c into main\n/);
});
