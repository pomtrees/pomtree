// REC-7: an adopted checkpointed agent keeps its typed result.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-recovery-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern 'REC-4' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { showAgent, sigkillPomtreed } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import { callReply, SKIP, spawnAgent, sum, TIMEOUT, textReply, untilSettledAndRunning, waitDone, withStack } from "./cli-recovery-support.ts";

// REC-7: an agent that has checkpointed (yield, wake) is adopted after a SIGKILL restart and then reports a typed result. Observed on Linux
// (the stack's pinned agent endpoint survives the restart, so the adopted container's `pomtree result` reaches the new pomtreed): the typed
// result IS recorded and the run exits succeeded. TODO(adopted-degraded) is therefore narrower than the ledger says (a result lost only
// when the adopted agent never calls `pomtree result`, or cannot reach the endpoint). A successful exit has no exitCause in any run (a
// non-adopted success has none either), so a missing cause is not asserted; the failure path is not exercised here.
test("cli recovery REC-7: an adopted checkpointed agent keeps its typed result, exits once, stays within its budget", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async () => {
  const WAKE = "WAKE-rec7 finish after the crash";
  const TYPED = { kind: "rec7-typed", count: 7 };
  const script: ModelScript = {
    name: "rec7",
    rules: [
      { id: "woken", when: { lastUserIncludes: "WAKE-rec7" }, times: 1, reply: callReply(holdUntilReleased("echo after-restart")) },
      {
        id: "typed-result",
        when: { lastUserIncludes: "WAKE-rec7" },
        times: 1,
        reply: callReply(`pomtree result '${JSON.stringify(TYPED)}' --summary 'typed done'; echo result-exit=$?`),
      },
      { id: "after-wake", when: { lastUserIncludes: "WAKE-rec7" }, reply: textReply("STUB-DONE") },
      { id: "yield", when: { toolResults: 0 }, times: 1, reply: callReply("pomtree yield --until message") },
      { id: "parked", when: { toolResults: 1 }, reply: textReply("parked") },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:rec7]] checkpoint, then finish with a typed result", name: "checkpointed", budget: 500_000 });
    await s.until("the agent to yield", async () => (await showAgent(s, a.id)).state === "yielded", 120_000);
    assert.equal((await s.pomtree(["send", a.id, WAKE])).code, 0);
    await s.until("the woken run to be busy", async () => s.stub.calls.filter((c) => c.matched === "woken").length === 1, 120_000);
    await untilSettledAndRunning(s, a.id, 2);
    const genBefore = (await showAgent(s, a.id)).generation;

    const container = `pomtree-${(await showAgent(s, a.id)).sandbox}`;
    await sigkillPomtreed(s);
    // TODO(e2e-time-reconcile-sweep): the ~30 s after `release` is not the reconcile sweep (see cli-recovery-tree.test.ts).
    await s.restart();
    await release([container]);
    const rec = await waitDone(s, a.id);
    const outputs = (await s.kinds(a.id, "tool_result")).map((e) => String((e.payload as unknown as { output: string }).output));
    const results = await s.kinds(a.id, POMTREED_KINDS.result);
    const exited = (await s.kinds(a.id, "exited")).map((e) => e.payload);
    const facts = `exit=${rec.exit} cause=${rec.exitCause} generation ${genBefore} -> ${rec.generation}; results=${JSON.stringify(results.map((e) => e.payload))}; exited=${JSON.stringify(exited)}; tool outputs=${JSON.stringify(outputs.map((o) => o.slice(0, 200)))}`;
    assert.equal(results.length, 1, `the typed result must be recorded once; ${facts}`);
    assert.deepEqual(results[0]!.payload.result, { ...TYPED, summary: "typed done" }, `the recorded result must be the typed one; ${facts}`);
    assert.deepEqual(rec.result, { ...TYPED, summary: "typed done" }, `the agent record must carry the typed result; ${facts}`);
    assert.equal(rec.exit, "succeeded", facts);
    assert.equal(exited.length, 1, facts);
    assert.equal(rec.generation, genBefore, `adoption must not bump the generation; ${facts}`);
    const settled = await s.settlements(a.id);
    assert.deepEqual(
      s.debit(a.id),
      { budget: 500_000, spent: sum(settled), reserved: 0 },
      `spend after adoption must equal the debit row and stay within the carve; ${facts}`,
    );
    assert.equal(settled.length, s.stub.calls.length, facts);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
