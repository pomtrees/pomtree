// RLY-2 and RLY-3 (S1): the canonical depth-k poem relay on the fake model, through the real pomtreed and `pomtree` binaries and the real agent
// image. Each level's scripted model replies with bash tool calls that run `pomtree` inside the container:
// budget, spawn exactly one child with budget = remaining - 80000, wait, reap the child itself, take the poem from the reap result, and
// submit it unchanged with `pomtree result --summary-file`. Level 1 also publishes poem.html as report `poem` and asks the operator to
// release it, so the test fetches the report through `pomtree report` before answering. The in-process half is relay.test.ts.
// Depth: root 0, the operator-spawned top agent is level/depth 1, the leaf is level k + 1; k = 1..3 succeed under the default
// agent.maxDepth (4), k = 4 is refused when the depth-4 agent spawns the leaf (RLY-3), and the same chain succeeds with maxDepth 5.
//
// Run: AGENT_IMAGE_TAG=pomtree/agent:smoke-<sha> node packages/agent-image/scripts/build.ts, then
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=pomtree/agent:smoke-<sha> node --test packages/e2e/src/cli-relay.test.ts
// The gate is cliScenarioSkip (cli-scenarios-harness.ts), as in cli-scenarios.test.ts. Nothing here spends money: the only upstream is
// the loopback stub. Split over cli-relay*.test.ts so node --test runs the chains in parallel (helpers: cli-relay-kit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lineValue,
  POEM,
  pageFor,
  RESERVE,
  relayScript,
  relaySettings,
  relayTemplates,
  runRelay,
  SKIP,
  showAgent,
  summaryOf,
  timeoutFor,
  withStack,
} from "./cli-relay-kit.ts";
import type { AgentJson } from "./cli-scenarios-harness.ts";

for (const k of [1, 2, 3]) {
  const leaf = k + 1;
  test(`cli relay k=${k} (RLY-2): ${leaf} levels hand the poem up unchanged, each parent reaps its own child, the report is fetched before the top finishes`, {
    skip: SKIP,
    timeout: timeoutFor(leaf),
  }, async () => {
    await withStack({ script: relayScript(leaf), templates: relayTemplates(), set: relaySettings() }, async (s) => {
      const { top, levels, fetched, topStateAtFetch } = await runRelay(s, leaf);

      assert.equal(topStateAtFetch, "running", `the report was fetched before the top agent finished: expected state running, got ${topStateAtFetch}`);
      assert.equal(fetched, pageFor(POEM), "the fetched report must be the minimal HTML page carrying the poem");
      assert.ok(!/<script/i.test(fetched), "the page must have no scripts");

      assert.equal(levels.length, leaf, `expected ${leaf} levels in the chain, got ${levels.length}`);
      assert.equal(top.exit, "succeeded", `top agent: expected exit succeeded, got ${top.exit}`);
      assert.equal(summaryOf(top), POEM, "top result summary must equal the leaf's poem byte for byte");

      for (const [i, f] of levels.entries()) {
        const a = await showAgent(s, f.id);
        assert.equal(a.state, "reaped", `level ${f.level}: expected state reaped, got ${a.state}`);
        assert.equal(a.exit, "succeeded", `level ${f.level}: expected exit succeeded, got ${a.exit} (cancelled would mean cancelChildren)`);
        assert.equal(summaryOf(a), POEM, `level ${f.level}: expected the poem unchanged, got ${JSON.stringify(summaryOf(a))}`);
        assert.equal(lineValue(f, "result-exit"), "0", `level ${f.level}: expected pomtree result to exit 0, got ${lineValue(f, "result-exit")}`);
        if (i > 0) assert.equal(a.parent, levels[i - 1]!.id, `level ${f.level}: expected parent ${levels[i - 1]!.id}, got ${a.parent}`);
        if (f.level === leaf) continue;

        // The parent's own `pomtree reap` is in its tool results and precedes its result; the budget was carved from its remainder.
        const child = levels[i + 1]!;
        assert.equal(lineValue(f, "SPAWN-EXIT"), "0", `level ${f.level}: expected the spawn to exit 0, got ${lineValue(f, "SPAWN-EXIT")}`);
        const reap = JSON.parse(lineValue(f, "REAP") ?? "null") as { record: AgentJson } | null;
        assert.ok(reap, `level ${f.level}: expected a REAP= line in its tool results, got ${JSON.stringify(f.lines)}`);
        assert.equal(reap.record.id, child.id, `level ${f.level}: expected to reap ${child.id}, reaped ${reap.record.id}`);
        assert.equal(reap.record.state, "reaped", `level ${f.level}: expected the reap result state reaped, got ${reap.record.state}`);
        assert.equal(reap.record.parent, f.id, `level ${f.level}: expected the reaped child's parent ${f.id}, got ${reap.record.parent}`);
        assert.ok(
          f.reapSeq !== undefined && f.reapSeq < f.resultSeq,
          `level ${f.level}: expected the reap (seq ${f.reapSeq}) before its result (seq ${f.resultSeq})`,
        );
        const [rem, carved] = (lineValue(f, "BUDGET") ?? "").split(",").map(Number);
        assert.ok(rem !== undefined && carved !== undefined && carved <= rem, `level ${f.level}: child budget ${carved} must be at most the remainder ${rem}`);
        assert.equal(carved, rem! - RESERVE, `level ${f.level}: expected the child budget to be the remainder minus ${RESERVE}`);
        assert.equal((await showAgent(s, child.id)).budgetMicros, carved, `level ${f.level}: expected the child record's budget to be ${carved}`);
      }
      const ps = await s.pomtree(["ps"]);
      assert.equal(ps.json<AgentJson[]>().filter((a) => a.parent !== null).length, leaf, `expected ${leaf} agents below the root`);
      assert.deepEqual(s.stub.unmatched, []);
    });
  });
}
