import assert from "node:assert/strict";
import type { MergeRequest, MergeStore, Registry } from "@pomtree/core";
import { sameMergeRequest, StaleGenerationError } from "@pomtree/core";
import { CONTRACT_SPAWN_SPEC } from "./fakes.ts";

export interface MergeStoreContractWorld {
  merges: MergeStore;
  registry: Registry;
}

// MergeStore port contract: begin is idempotent by key and fenced by the caller's generation; advance records
// phase and pinned tips; settle is terminal (first wins) and maintains the per-child round counter; a conflict
// for identical tips is findable; open records are listable for recovery; host and generation ride on every record.
export async function mergeStoreContractBody(w: MergeStoreContractWorld): Promise<void> {
  const { merges: m, registry } = w;
  const a = await registry.create({
    id: "mc-parent",
    parent: null,
    name: "p",
    task: "t",
    host: "h",
    budgetMicros: 1,
    spec: CONTRACT_SPAWN_SPEC,
    idempotencyKey: "mc-create",
  });
  const req: MergeRequest = {
    repo: "r1",
    host: "h",
    caller: a.id,
    callerGeneration: a.generation,
    child: "mc-child",
    source: "refs/agents/mc-child/heads/agent/mc-child",
    target: "refs/agents/mc-parent/heads/agent/mc-parent",
  };
  const r1 = await m.begin({ repo: "r1", host: "h", request: req, startedAt: 1000 }, "mk-1");
  assert.deepEqual([r1.phase, r1.attempts, r1.base, r1.result, r1.host, r1.generation], ["begun", 0, null, null, "h", a.generation]);
  assert.deepEqual(await m.begin({ repo: "r1", host: "h", request: req, startedAt: 2000 }, "mk-1"), r1); // replay: same record, original startedAt
  // A key reused with a DIFFERENT request returns the original record unchanged (its request is still the first one),
  // so the engine can compare with sameMergeRequest and answer key_reuse instead of replaying the old outcome.
  const reused = await m.begin({ repo: "r1", host: "h", request: { ...req, child: "someone-else" }, startedAt: 3000 }, "mk-1");
  assert.deepEqual(
    [reused.id, reused.child, reused.request.child, sameMergeRequest(reused.request, req), sameMergeRequest(reused.request, { ...req, child: "someone-else" })],
    [r1.id, "mc-child", "mc-child", true, false],
  );
  assert.equal((await m.status("r1", "mc-child")).state, "none");
  const adv = await m.advance(r1.id, { phase: "pinned", attempts: 1, base: "b1", source: "s1" }, "mk-a1");
  assert.deepEqual([adv.phase, adv.attempts, adv.base, adv.source], ["pinned", 1, "b1", "s1"]);
  const cand = await m.advance(r1.id, { phase: "candidate", candidate: "c1" }, "mk-a2");
  assert.deepEqual([cand.phase, cand.candidate, cand.base], ["candidate", "c1", "b1"]); // unspecified fields keep their value
  assert.deepEqual(
    (await m.list({ open: true })).map((r) => r.id),
    [r1.id],
  );
  const done = await m.settle(r1.id, { status: "conflict", paths: ["a.txt"], targetTip: "b1", sourceTip: "s1", round: 1 }, "mk-s1");
  assert.equal(done.phase, "done");
  assert.deepEqual(await m.settle(r1.id, { status: "merged", commit: "x", base: "b1", source: "s1" }, "mk-s2"), done); // first settle wins
  assert.deepEqual(await m.advance(r1.id, { phase: "pinned" }, "mk-a3"), done); // a settled record does not move
  assert.deepEqual(await m.list({ open: true }), []);
  const st = await m.status("r1", "mc-child");
  assert.deepEqual([st.state, st.failedRounds, st.lastMerge, st.host, st.generation], ["conflict", 1, r1.id, "h", a.generation]);
  assert.equal((await m.findConflict({ repo: "r1", caller: a.id, child: "mc-child", base: "b1", source: "s1" }))?.id, r1.id);
  assert.equal(await m.findConflict({ repo: "r1", caller: a.id, child: "mc-child", base: "b1", source: "other" }), null);
  // moved and policy_rejected do not touch the status; merged resets the rounds.
  const r2 = await m.begin({ repo: "r1", host: "h", request: req, startedAt: 1001 }, "mk-2");
  await m.settle(r2.id, { status: "moved", attempts: 5, targetTip: "b2" }, "mk-s3");
  assert.equal((await m.status("r1", "mc-child")).failedRounds, 1);
  const r3 = await m.begin({ repo: "r1", host: "h", request: req, startedAt: 1002 }, "mk-3");
  await m.advance(r3.id, { phase: "pinned", base: "b3", source: "s3" }, "mk-a4");
  await m.settle(r3.id, { status: "merged", commit: "m3", base: "b3", source: "s3" }, "mk-s4");
  const merged = await m.status("r1", "mc-child");
  assert.deepEqual([merged.state, merged.failedRounds], ["merged", 0]);
  assert.equal((await m.list({ child: "mc-child" })).length, 3);
  assert.equal((await m.list({ caller: "nobody" })).length, 0);
  // Fence: a caller generation below the registry's is rejected, but a replay of an existing key is not.
  const bumped = await registry.bumpGeneration(a.id, "h", "mc-bump");
  await assert.rejects(() => m.begin({ repo: "r1", host: "h", request: req, startedAt: 1 }, "mk-stale"), StaleGenerationError);
  assert.equal((await m.begin({ repo: "r1", host: "h", request: req, startedAt: 1 }, "mk-1")).id, r1.id);
  const fresh = await m.begin({ repo: "r1", host: "h", request: { ...req, callerGeneration: bumped.generation }, startedAt: 1 }, "mk-fresh");
  assert.equal(fresh.generation, bumped.generation);
  // Escalation sets the counter to the rounds reached.
  await m.settle(fresh.id, { status: "escalate", reason: "conflict", rounds: 3, targetTip: "b", sourceTip: "s", paths: ["z"] }, "mk-s5");
  const esc = await m.status("r1", "mc-child");
  assert.deepEqual([esc.state, esc.failedRounds], ["escalated", 3]);
  for (const rec of await m.list())
    for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(rec)) as Record<string, unknown>))
      assert.ok(!(typeof v === "string" && v.startsWith("/")), `merge field ${k} looks like a path`);
}
