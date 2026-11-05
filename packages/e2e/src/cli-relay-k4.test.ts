// RLY-3 (k=4 under the default agent.maxDepth) of cli-relay.test.ts; a file of its own so node --test runs it in parallel (helpers: cli-relay-kit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lineValue,
  REFUSAL,
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

test("cli relay k=4 under the default agent.maxDepth (RLY-3): the depth-4 agent's spawn exits 5, the chain ends failed, all reaped, no depth-5 agent", {
  skip: SKIP,
  timeout: timeoutFor(5),
}, async () => {
  await withStack({ script: relayScript(5), templates: relayTemplates(), set: relaySettings() }, async (s) => {
    const { top, levels } = await runRelay(s, 5);
    assert.equal(levels.length, 4, `expected a chain of 4 levels (no depth-5 agent), got ${levels.length}`);
    const last = levels[3]!;
    assert.equal(lineValue(last, "SPAWN-EXIT"), "5", `level 4 spawn: expected exit 5, got ${lineValue(last, "SPAWN-EXIT")}`);
    assert.ok(lineValue(last, "SPAWN-ERR")?.includes(REFUSAL), `level 4 spawn error: expected "${REFUSAL}", got ${lineValue(last, "SPAWN-ERR")}`);
    assert.equal(top.exit, "failed", `top agent: expected exit failed, got ${top.exit}`);
    for (const f of levels) {
      const a = await showAgent(s, f.id);
      assert.equal(a.state, "reaped", `level ${f.level}: expected state reaped, got ${a.state}`);
      assert.equal(a.exit, "failed", `level ${f.level}: expected exit failed, got ${a.exit}`);
      assert.equal(summaryOf(a), REFUSAL, `level ${f.level}: expected the refusal message as summary, got ${JSON.stringify(summaryOf(a))}`);
      assert.equal(lineValue(f, "result-exit"), "0", `level ${f.level}: expected pomtree result to exit 0, got ${lineValue(f, "result-exit")}`);
      if (f.level < 4) assert.ok(f.reapSeq !== undefined && f.reapSeq < f.resultSeq, `level ${f.level}: expected its own reap before its result`);
    }
    const ps = await s.pomtree(["ps"]);
    const agents = ps.json<AgentJson[]>().filter((a) => a.parent !== null);
    assert.equal(agents.length, 4, `expected 4 agents in the registry, got ${agents.map((a) => a.name)}`);
    assert.ok(!agents.some((a) => a.name === "relay-5"), "no relay-5 agent may exist under the default depth limit");
  });
});
