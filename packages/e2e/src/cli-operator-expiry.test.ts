// OPS-6 (expiry) of cli-operator.test.ts (same harness, helpers in cli-operator-kit.ts; a file of its own so node --test runs it in parallel).
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { callReply, SKIP, spawnAgent, summaryOf, TIMEOUT, textReply, untilEscalation, waitDone, withStack } from "./cli-operator-kit.ts";

// TODO(e2e-time-reconcile-sweep): the expiry lands on pomtreed's 30 s reconcile tick (agent.reconcileSweepMs, default 30 s), so this test takes ~35 s; set that key to 1000 to shorten it.
// OPS-6, expiry: with a short ask.timeoutMs and no answer the sweep (reconcile timer, about every 30 s) expires the ask and answers the
// asker with the documented default; a late operator answer is then rejected.
test("cli operator OPS-6 (expiry): an unanswered ask expires, the asker is told, a late answer is rejected", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const script: ModelScript = {
    name: "ops6-expiry",
    rules: [
      {
        id: "expired",
        when: { lastUserIncludes: "expired: no human answered" },
        times: 1,
        reply: callReply("pomtree result --summary 'proceeded with the default'"),
      },
      { id: "after-expired", when: { lastUserIncludes: "expired: no human answered" }, reply: textReply("STUB-DONE") },
      { id: "ask", when: { toolResults: 0 }, reply: callReply('pomtree ask "pick one" --options alpha-1,beta-2 --wait 600000; echo ask-exit=$?') },
      { id: "parked", when: {}, reply: textReply("parked") },
    ],
  };
  await withStack({ script, set: { "ask.timeoutMs": "5000" } }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:ops6x]] ask the operator", name: "asker", budget: 500_000 });
    const esc = await untilEscalation(s, a.id);
    const rec = await waitDone(s, a.id, 120_000);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.equal(summaryOf(rec), "proceeded with the default");
    const told = s.stub.calls.find((c) => c.matched === "expired");
    assert.ok(
      told?.lastUserText?.includes("proceed with your documented default"),
      `the asker must be told the default, got ${JSON.stringify(told?.lastUserText)}`,
    );
    assert.equal((await s.kinds(a.id, POMTREED_KINDS.escalationExpired)).length, 1);
    const late = await s.pomtree(["answer", esc.id, "alpha-1"]);
    t.diagnostic(`late answer: exit ${late.code}; stdout ${JSON.stringify(late.out)}; stderr ${JSON.stringify(late.err)}`);
    // The daemon keeps the expiry answer and refuses the late one with 409 (pomtree exit 5, the error body on stdout under --json).
    await t.test("a late answer is rejected with a nonzero exit", () => {
      assert.notEqual(late.code, 0, `late answer: expected a nonzero exit, got ${late.code}: ${late.out}`);
      assert.equal(late.code, 5, `late answer: expected exit 5 (409), got ${late.code}: ${late.out}`);
      // pomtree --json prints failures as {"error": "..."} on stdout, so stderr is empty.
      assert.match(late.out, new RegExp(`escalation ${esc.id} was already answered`), `stdout: ${late.out}`);
      assert.match(late.out, /your answer was not applied/, `stdout: ${late.out}`);
    });
    assert.equal(s.stub.calls.filter((c) => c.lastUserText?.includes("alpha-1")).length, 0, "the late answer must never reach the asker");
    assert.deepEqual(s.stub.unmatched, []);
  });
});
