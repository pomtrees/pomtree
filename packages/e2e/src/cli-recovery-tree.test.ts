// REC-5: SIGKILL with a parent, two live children and an unrelated agent.
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
  MODEL_FLAG,
  SKIP,
  spawnAgent,
  sum,
  summaryOf,
  TIMEOUT,
  textReply,
  waitDone,
  withStack,
} from "./cli-recovery-support.ts";
import { type AgentJson, MODEL, PROVIDER } from "./cli-scenarios-harness.ts";
import { evaluateRecovery } from "./crash-recovery-decisions.ts";

// REC-5: a parent with two live children plus one unrelated top-level agent, all live at the SIGKILL.
test("cli recovery REC-5: SIGKILL with a parent, two live children and an unrelated agent adopts every one; the parent reaps both children", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async () => {
  const CHILD_BUDGET = 150_000;
  const kids = "$(cat /tmp/kid1) $(cat /tmp/kid2)";
  const spawnKid = (n: number) =>
    `pomtree spawn --task '[[scn:rec5kid]] work ${n}' --name kid${n} --budget ${CHILD_BUDGET} --model ${MODEL_FLAG} > /tmp/kid${n} && cat /tmp/kid${n}`;
  const script: ModelScript = {
    name: "rec5",
    rules: [
      { id: "parent-spawn", when: { marker: "rec5parent", toolResults: 0 }, reply: callReply(spawnKid(1), spawnKid(2)) },
      // The parent parks on an operator ask so the SIGKILL cannot land inside its `pomtree wait` loop (which does not retry an unreachable daemon).
      { id: "parent-ask", when: { marker: "rec5parent", toolResults: 2 }, reply: callReply('pomtree ask "reap now?" --wait 600000; echo ask-exit=$?') },
      {
        id: "parent-reap",
        when: { marker: "rec5parent", toolResults: 3 },
        reply: callReply(
          `for k in ${kids}; do for i in $(seq 1 20); do pomtree wait $k --timeout 15000 && break; done; echo REAP=$(pomtree --json reap $k); done`,
        ),
      },
      { id: "parent-result", when: { marker: "rec5parent", toolResults: 4 }, reply: callReply("pomtree result --summary 'parent done'; echo final-exit=$?") },
      { id: "parent-done", when: { marker: "rec5parent", toolResults: 5 }, reply: textReply("STUB-PARENT-DONE") },
      // The two spawns are separate tool calls of one turn: Pi runs them and the next turn sees two results.
      { id: "kid-long", when: { lastUserIncludes: "[[scn:rec5kid]]", toolResults: 0 }, reply: callReply(holdUntilReleased("echo kid-after-restart")) },
      { id: "kid-result", when: { lastUserIncludes: "[[scn:rec5kid]]", toolResults: 1 }, reply: callReply("pomtree result --summary 'kid done'") },
      { id: "solo-long", when: { lastUserIncludes: "[[scn:rec5solo]]", toolResults: 0 }, reply: callReply(holdUntilReleased("echo solo-after-restart")) },
      { id: "solo-result", when: { lastUserIncludes: "[[scn:rec5solo]]", toolResults: 1 }, reply: callReply("pomtree result --summary 'solo done'") },
      // Late turns pomtreed injects after an agent's final reply (child exit signals, the wake of a waiting parent).
      { id: "late-signal", when: { lastUserIncludes: "[pomtree]" }, reply: textReply("STUB-LATE-SIGNAL") },
      { id: "done", when: { toolResults: 2 }, reply: textReply("STUB-DONE") },
    ],
  };
  const templates = { "rec5-parent": { provider: PROVIDER, model: MODEL, systemPrompt: "Scripted parent. [[stub:rec5parent]]", egress: { kind: "registry" } } };
  await withStack({ script, templates, set: { "capacity.maxSessions": "6", "wait.yieldMs": "700000" } }, async (s) => {
    const parent = await spawnAgent(s, { task: "[[scn:rec5parent]] run the tree", name: "parent", budget: 1_000_000, template: "rec5-parent" });
    const solo = await spawnAgent(s, { task: "[[scn:rec5solo]] work alone", name: "solo", budget: 300_000 });
    // All five agents running, each past one settled call: the parent's turn 1 spawned both children, which each made one call.
    let childIds: string[] = [];
    await s.until(
      "parent, both children and the solo agent running past a settled call",
      async () => {
        const ps = (await s.pomtree(["ps"])).json<AgentJson[]>();
        const kidRecs = ps.filter((x) => x.parent === parent.id);
        childIds = kidRecs.map((x) => x.id);
        if (kidRecs.length < 2) return false;
        for (const x of [parent, solo, ...kidRecs]) {
          const cur = await showAgent(s, x.id);
          if (["exited", "reaped"].includes(cur.state)) throw new Error(`agent ${x.id} (${cur.state}/${cur.exit}) ended before the kill`);
          if (cur.state !== "running" || !cur.sandbox) return false;
          if ((await s.settlements(x.id)).length < 1) return false;
        }
        return true;
      },
      200_000,
    );
    assert.equal(childIds.length, 2, `expected exactly two children, got ${childIds}`);
    // The parent is parked on its ask (not inside a wait loop) before the kill.
    let escalation = "";
    await s.until(
      "the parent parked on its open ask",
      async () => {
        const r = await s.pomtree(["escalations", "ls", "--agent", parent.id]);
        escalation = r.code === 0 ? (r.json<{ id: string; state: string }[]>().find((e) => e.state === "open")?.id ?? "") : "";
        return escalation !== "" && s.stub.calls.some((c) => c.matched === "parent-ask");
      },
      120_000,
    );
    const all = [parent.id, ...childIds, solo.id];
    const pre = new Map<string, Awaited<ReturnType<typeof showAgent>>>();
    const journalBefore = new Map<string, Awaited<ReturnType<typeof s.events>>>();
    const preDebit = new Map<string, ReturnType<typeof debitRows>>();
    const preSpent = new Map<string, number>();
    for (const id of all) {
      pre.set(id, await showAgent(s, id));
      journalBefore.set(id, await s.events(id));
    }

    await sigkillPomtreed(s);
    const maxSeq = maxJournalSeq(s);
    const runningAfterKill = new Map<string, boolean>();
    for (const id of all) {
      runningAfterKill.set(id, await containerRunning(`pomtree-${pre.get(id)!.sandbox}`));
      preDebit.set(id, debitRows(s, id));
      preSpent.set(id, spentMicros(s, id));
    }
    // TODO(e2e-time-reconcile-sweep): MEASURED, not the reconcile sweep: with agent.reconcileSweepMs=1000 (and watchdog.sweepMs=1000) the wait after `release` is still ~30 s (REC-4: 31 s of 36 s; REC-5: 62 s of 73 s). The exit path is event-driven (adoptRunning -> handle.wait()), so the 30 s source is undiagnosed (candidates: container-side retry backoff after the pomtreed kill, a 30 s long-poll cap in lifecycle.ts/escalation.ts).
    await s.restart();
    await release(all.map((id) => `pomtree-${pre.get(id)!.sandbox}`));
    const ans = await s.pomtree(["answer", escalation, "OK"]);
    assert.equal(ans.code, 0, `answer ${escalation}: exit ${ans.code}: ${ans.err}`);
    for (const id of all) await waitDone(s, id, 200_000);

    // Every agent: judged by evaluateRecovery, then the adopt-or-resume facts the judge does not cover.
    for (const id of all) {
      const final = await showAgent(s, id);
      const journal = await s.events(id);
      const verdict = evaluateRecovery({
        variant: "adopt",
        capMicros: pre.get(id)!.budgetMicros,
        pre: {
          agent: agentView(pre.get(id)!),
          maxSeq,
          debit: preDebit.get(id)!,
          spentMicros: preSpent.get(id)!,
          containerRunningAfterKill: runningAfterKill.get(id)!,
        },
        final: {
          agent: agentView(final),
          journal,
          debit: debitRows(s, id),
          spentMicros: spentMicros(s, id),
          agentContainers: (await agentContainers(id)).map((c) => ({ id: c.name, running: c.running })),
          workspaceDirs: 0,
          operatorApiOk: (await s.pomtree(["ps"])).code === 0,
        },
      });
      assert.ok(
        verdict.ok,
        `evaluateRecovery failed for ${final.name} (${id}):\n${verdict.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.name}: ${c.detail}`)
          .join("\n")}`,
      );
      assertPrefixPreserved(journalBefore.get(id)!, journal, final.name);
      const settled = await s.settlements(id);
      assert.equal(new Set(settled.map((x) => x.requestId)).size, settled.length, `${final.name}: a settlement was journaled twice`);
      assert.equal((await s.kinds(id, POMTREED_KINDS.result)).length, 1, `${final.name}: exactly one recorded result`);
      assert.equal((await s.kinds(id, "report_published")).length, 0, `${final.name}: no report was published`);
      assert.equal(final.generation, pre.get(id)!.generation, `${final.name}: adoption must not bump the generation`);
      assert.equal(final.exit, "succeeded", `${final.name}: ${JSON.stringify(final)}`);
      assert.deepEqual(s.debit(id), { budget: pre.get(id)!.budgetMicros, spent: sum(settled), reserved: 0 }, `${final.name}: spend must equal the debit row`);
    }
    // The model saw each call once: settlements across the five agents equal the stub's calls.
    let total = 0;
    for (const id of all) total += (await s.settlements(id)).length;
    assert.equal(total, s.stub.calls.length, "stub calls and settlements differ across the tree");

    // The parent reaped both children itself. Its tool outputs are not journaled after adoption (the daemon no longer reads an adopted
    // run's session: TODO(adopted-degraded)), so the reaps are shown by their effects: each child's single `reaped` entry precedes the
    // parent's result, and the daemon accepted that result, which it refuses (exit 5) while a child is unreaped (cli scenario 6).
    const parentResult = (await s.kinds(parent.id, POMTREED_KINDS.result))[0]!;
    for (const kid of childIds) {
      const rec = await showAgent(s, kid);
      assert.equal(rec.state, "reaped", `child ${kid}: expected the parent to have reaped it, got ${rec.state}`);
      assert.equal(rec.parent, parent.id);
      const reaped = await s.kinds(kid, "reaped");
      assert.equal(reaped.length, 1, `child ${kid}: expected exactly one reaped entry, got ${reaped.length}`);
      assert.ok(reaped[0]!.seq < parentResult.seq, `child ${kid}: reaped (seq ${reaped[0]!.seq}) must precede the parent's result (seq ${parentResult.seq})`);
    }
    assert.equal(summaryOf(await showAgent(s, parent.id)), "parent done");
    assert.deepEqual(
      (await agentContainers(parent.id)).concat(...(await Promise.all(all.map(agentContainers)))).filter((c) => c.running),
      [],
    );
    assert.deepEqual(s.stub.unmatched, []);
  });
});
