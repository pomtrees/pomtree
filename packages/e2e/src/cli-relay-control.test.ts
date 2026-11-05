// RLY-3 (k=4 control with agent.maxDepth 5) of cli-relay.test.ts; a file of its own so node --test runs it in parallel (helpers: cli-relay-kit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { POEM, relayScript, relaySettings, relayTemplates, runRelay, SKIP, showAgent, summaryOf, timeoutFor, withStack } from "./cli-relay-kit.ts";

test("cli relay k=4 control with agent.maxDepth 5 (RLY-3): the same chain succeeds with five agents", { skip: SKIP, timeout: timeoutFor(5) }, async () => {
  await withStack({ script: relayScript(5), templates: relayTemplates(), set: { ...relaySettings(), "agent.maxDepth": "5" } }, async (s) => {
    const { top, levels } = await runRelay(s, 5);
    assert.equal(levels.length, 5, `expected 5 levels, got ${levels.length}`);
    assert.equal(top.exit, "succeeded", `top agent: expected exit succeeded, got ${top.exit}`);
    assert.equal(summaryOf(top), POEM, "the control's top summary must equal the leaf's poem");
    for (const f of levels) {
      const a = await showAgent(s, f.id);
      assert.equal(a.state, "reaped", `level ${f.level}: expected state reaped, got ${a.state}`);
      assert.equal(a.exit, "succeeded", `level ${f.level}: expected exit succeeded, got ${a.exit}`);
    }
  });
});
