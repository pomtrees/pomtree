import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { IllegalTransitionError, StaleGenerationError } from "@pomtree/core";
import { contract, CONTRACT_SPAWN_SPEC, mergeStoreContractBody } from "@pomtree/testing";
import type { MergeStoreContractWorld } from "@pomtree/testing";
import { openStore } from "./store.ts";
import { tmpDir } from "@pomtree/testing";

contract<MergeStoreContractWorld>("MergeStore", { real: () => openStore() })("begin/advance/settle/rounds/fence", mergeStoreContractBody);

test("merge rows survive a reopen", async () => {
  const dir = tmpDir("store-merge-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  const a = await s.registry.create({
    id: "p",
    parent: null,
    name: "p",
    task: "t",
    host: "h",
    budgetMicros: 1,
    spec: CONTRACT_SPAWN_SPEC,
    idempotencyKey: "c",
  });
  const req = {
    repo: "r",
    host: "h",
    caller: "p",
    callerGeneration: a.generation,
    child: "c",
    source: "refs/agents/c/heads/x",
    target: "refs/agents/p/heads/y",
  };
  const m = await s.merges.begin({ repo: "r", host: "h", request: req, startedAt: 5 }, "k");
  await s.merges.advance(m.id, { phase: "candidate", attempts: 1, base: "b", source: "s", candidate: "c1" }, "a1");
  s.close();
  const s2 = openStore(file);
  const open = await s2.merges.list({ open: true });
  assert.deepEqual(
    open.map((r) => [r.id, r.phase, r.candidate, r.startedAt]),
    [[m.id, "candidate", "c1", 5]],
  );
  assert.deepEqual(open[0]!.request, req);
  s2.close();
});

test("registry.transition resume:true allows exited->running only, clears exit and result, stays fenced and idempotent", async () => {
  const s = openStore();
  const a = await s.registry.create({
    id: "r",
    parent: null,
    name: "n",
    task: "t",
    host: "h",
    budgetMicros: 1,
    spec: CONTRACT_SPAWN_SPEC,
    idempotencyKey: "c",
  });
  await s.registry.transition("r", 0, "running", { idempotencyKey: "t1" });
  await s.registry.transition("r", 0, "exited", { exit: "succeeded", result: { x: 1 }, idempotencyKey: "t2" });
  await assert.rejects(() => s.registry.transition("r", 0, "running", { idempotencyKey: "t3" }), IllegalTransitionError);
  const b = await s.registry.bumpGeneration("r", "h", "b1");
  await assert.rejects(() => s.registry.transition("r", a.generation, "running", { resume: true, idempotencyKey: "t4" }), StaleGenerationError);
  const back = await s.registry.transition("r", b.generation, "running", { resume: true, idempotencyKey: "t5" });
  assert.deepEqual([back.state, back.exit, back.result], ["running", null, null]);
  assert.deepEqual(await s.registry.transition("r", b.generation, "running", { resume: true, idempotencyKey: "t5" }), back);
  await s.registry.transition("r", b.generation, "exited", { exit: "failed", idempotencyKey: "t6" });
  await assert.rejects(() => s.registry.transition("r", b.generation, "yielded", { resume: true, idempotencyKey: "t7" }), IllegalTransitionError);
  s.close();
});
