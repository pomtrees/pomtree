// REC-4: SIGKILL of pomtreed after the first settled call, restart on the same state.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-recovery-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern 'REC-4' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { agentContainers, agentView, containerRunning, debitRows, maxJournalSeq, showAgent, sigkillPomtreed, spentMicros } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import {
  assertPrefixPreserved,
  callReply,
  SKIP,
  sandboxCount,
  spawnAgent,
  sum,
  summaryOf,
  TIMEOUT,
  textReply,
  untilSettledAndRunning,
  waitDone,
  withStack,
} from "./cli-recovery-support.ts";
import { type Evidence, evaluateRecovery } from "./crash-recovery-decisions.ts";

// REC-4: one agent, SIGKILL after its first settled call, restart on the same state, the agent finishes by adoption.
test("cli recovery REC-4: SIGKILL of pomtreed after the first settled call loses nothing (evaluateRecovery holds, journal continues, one container)", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async () => {
  const script: ModelScript = {
    name: "rec4",
    rules: [
      { id: "long-tool", when: { toolResults: 0 }, reply: callReply(holdUntilReleased("echo after-restart")) },
      { id: "result", when: { toolResults: 1 }, reply: callReply("pomtree result --summary 'survived sigkill'") },
      { id: "done", when: { toolResults: 2 }, reply: textReply("STUB-DONE") },
    ],
  };
  await withStack({ script }, async (s) => {
    const budget = 500_000;
    const a = await spawnAgent(s, { task: "[[scn:rec4]] go", name: "victim", budget });
    await untilSettledAndRunning(s, a.id, 1);
    const pre = await showAgent(s, a.id);
    assert.ok(pre.sandbox, "the running agent must have a sandbox id before the kill");
    const containersBefore = await agentContainers(a.id);
    assert.equal(containersBefore.length, 1, `expected one container before the kill, got ${containersBefore.map((c) => c.name)}`);
    const journalBefore = await s.events(a.id);

    await sigkillPomtreed(s);
    const containerRunningAfterKill = await containerRunning(`pomtree-${pre.sandbox}`);
    const preEvidence: Evidence["pre"] = {
      agent: agentView(pre),
      maxSeq: maxJournalSeq(s),
      debit: debitRows(s, a.id),
      spentMicros: spentMicros(s, a.id),
      containerRunningAfterKill,
    };
    // TODO(e2e-time-reconcile-sweep): the ~30 s after `release` is not the reconcile sweep (see cli-recovery-tree.test.ts).
    await s.restart();
    await release([`pomtree-${pre.sandbox}`]);
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.equal(summaryOf(rec), "survived sigkill");
    await s.until("the adopted agent's teardown", async () => (await agentContainers(a.id)).every((c) => !c.running), 30_000);

    const journal = await s.events(a.id);
    const final = await showAgent(s, a.id);
    const verdict = evaluateRecovery({
      variant: "adopt",
      capMicros: budget,
      pre: preEvidence,
      final: {
        agent: agentView(final),
        journal,
        debit: debitRows(s, a.id),
        spentMicros: spentMicros(s, a.id),
        agentContainers: (await agentContainers(a.id)).map((c) => ({ id: c.name, running: c.running })),
        workspaceDirs: 0, // read by the dead-container variant only
        operatorApiOk: (await s.pomtree(["ps"])).code === 0,
      },
    });
    assert.ok(
      verdict.ok,
      `evaluateRecovery failed:\n${verdict.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`)
        .join("\n")}`,
    );

    assertPrefixPreserved(journalBefore, journal, "REC-4");
    const kinds = journal.map((e) => String(e.payload.kind));
    assert.equal(kinds.filter((k) => k === "exited").length, 1, `exactly one exited entry, got ${kinds}`);
    assert.equal(kinds.filter((k) => k === "resumed").length, 0, `adoption must not journal a resume, got ${kinds}`);
    assert.equal(sandboxCount(kinds), 1, `exactly one started entry, got ${kinds}`);
    assert.equal((await s.kinds(a.id, POMTREED_KINDS.result)).length, 1, "exactly one recorded result");

    const settled = await s.settlements(a.id);
    assert.equal(new Set(settled.map((x) => x.requestId)).size, settled.length, "a settlement was journaled twice");
    assert.equal(settled.length, s.stub.calls.length, "stub calls and settlements differ (a call went unsettled or was settled twice)");
    assert.equal(s.stub.calls.filter((c) => c.matched === "long-tool").length, 1, "the tool turn was replayed after the restart");
    assert.deepEqual(s.debit(a.id), { budget, spent: sum(settled), reserved: 0 }, "spend must equal the debit row and the sum of settlements");
    assert.equal((await agentContainers(a.id)).filter((c) => c.running).length, 0);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
