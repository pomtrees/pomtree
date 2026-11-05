import { test } from "node:test";
import assert from "node:assert/strict";
import { IllegalTransitionError, StaleGenerationError } from "@pomtree/core";
import type { MergeRequest } from "@pomtree/core";
import { contract, createFakes, CONTRACT_SPAWN_SPEC } from "./fakes.ts";
import { mergeStoreContractBody } from "./merge-contract.ts";
import type { MergeStoreContractWorld } from "./merge-contract.ts";

contract<MergeStoreContractWorld>("MergeStore", { fake: () => createFakes() })("begin/advance/settle/rounds/fence", mergeStoreContractBody);

const req: MergeRequest = {
  repo: "repo-1",
  host: "h",
  caller: "p",
  callerGeneration: 0,
  child: "c",
  source: "refs/agents/c/heads/agent/c",
  target: "refs/agents/p/heads/agent/p",
};

test("FakeRepoStore scripts results, records requests and tracks the reap report", async () => {
  const f = createFakes();
  f.hooks.raw.repos.results.push({ status: "conflict", paths: ["a"], targetTip: "b", sourceTip: "s", round: 1 });
  assert.equal((await f.repos.mergeStatus({ child: "c", target: req.target })).settled, false);
  assert.equal((await f.repos.merge(req, "k1")).status, "conflict");
  assert.deepEqual(await f.repos.mergeStatus({ child: "c", target: req.target }), { state: "conflict", merged: false, failedRounds: 1, settled: false });
  assert.equal((await f.repos.merge(req, "k1")).status, "conflict"); // replay: the script is not consumed again
  assert.equal(f.hooks.raw.repos.requests.length, 1);
  assert.equal((await f.repos.merge(req, "k2")).status, "merged");
  assert.equal((await f.repos.mergeStatus({ child: "c", target: req.target })).settled, true);
  f.hooks.raw.repos.results.push({ status: "escalate", reason: "conflict", rounds: 3, targetTip: "b", sourceTip: "s" });
  await f.repos.merge({ ...req, child: "d" }, "k3");
  assert.equal((await f.repos.mergeStatus({ child: "d", target: req.target })).settled, true);
  f.hooks.raw.repos.reachable.set("abc", ["c"]);
  assert.equal(await f.repos.commitInSubtree("abc", ["c", "d"]), "abc");
  assert.equal(await f.repos.commitInSubtree("abc", ["x"]), null);
  assert.ok(f.calls.some((c) => c.port === "RepoStore" && c.method === "merge"));
});

test("FakeRepoStore self-merge needs the default-branch target and an approval, like GitRepoStore", async () => {
  const f = createFakes();
  const self = { ...req, child: "p", source: "refs/agents/p/heads/agent/p", target: "refs/heads/main" };
  assert.equal(((await f.repos.merge(self, "s1")) as { code?: string }).code, "approval_required");
  assert.equal(((await f.repos.merge({ ...self, target: "refs/heads/dev", approval: "a" }, "s2")) as { code?: string }).code, "bad_ref");
  assert.equal((await f.repos.merge({ ...self, approval: "a" }, "s3")).status, "merged");
});

test("FakeRepoStore: a key reused with a different request is policy_rejected key_reuse", async () => {
  const f = createFakes();
  assert.equal((await f.repos.merge(req, "k")).status, "merged");
  const r = await f.repos.merge({ ...req, child: "other" }, "k");
  assert.deepEqual([r.status, (r as { code?: string }).code], ["policy_rejected", "key_reuse"]);
  assert.equal((await f.repos.merge({ ...req }, "k")).status, "merged");
});

test("FakeCheckRunner scripts pass/fail/throw and records runs", async () => {
  const f = createFakes();
  const cmd = { repo: "r", commit: "c1", command: ["make", "test"], idempotencyKey: "k" };
  assert.deepEqual(await f.checks.run(cmd), { ok: true, summary: "ok" });
  f.hooks.raw.checks.results.push({ ok: false, summary: "boom" }, new Error("runner down"));
  assert.equal((await f.checks.run(cmd)).ok, false);
  await assert.rejects(() => f.checks.run(cmd), /runner down/);
  assert.equal(f.hooks.raw.checks.runs.length, 3);
});

test("registry resume edge: exited->running only with resume:true, clears exit and result, fenced and idempotent", async () => {
  for (const f of [createFakes()]) {
    const a = await f.registry.create({
      id: "r",
      parent: null,
      name: "n",
      task: "t",
      host: "h",
      budgetMicros: 1,
      spec: CONTRACT_SPAWN_SPEC,
      idempotencyKey: "c",
    });
    await f.registry.transition("r", 0, "running", { idempotencyKey: "t1" });
    await f.registry.transition("r", 0, "exited", { exit: "succeeded", result: { x: 1 }, idempotencyKey: "t2" });
    await assert.rejects(() => f.registry.transition("r", 0, "running", { idempotencyKey: "t3" }), IllegalTransitionError);
    const b = await f.registry.bumpGeneration("r", "h", "b1");
    await assert.rejects(() => f.registry.transition("r", a.generation, "running", { resume: true, idempotencyKey: "t4" }), StaleGenerationError);
    const back = await f.registry.transition("r", b.generation, "running", { resume: true, idempotencyKey: "t5" });
    assert.deepEqual([back.state, back.exit, back.result], ["running", null, null]);
    assert.deepEqual(await f.registry.transition("r", b.generation, "running", { resume: true, idempotencyKey: "t5" }), back);
    // resume does not open other edges
    await assert.rejects(() => f.registry.transition("r", b.generation, "reaped", { resume: true, idempotencyKey: "t6" }), IllegalTransitionError);
  }
});
