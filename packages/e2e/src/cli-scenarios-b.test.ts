// Scenarios 11, 2 and 4 of cli-scenarios.test.ts (same harness and header; split so node --test runs the files in parallel).
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import { type AgentJson, bash } from "./cli-scenarios-harness.ts";
import { BIG, reap, SKIP, spawnAgent, sum, TIMEOUT, waitDone, withStack } from "./cli-scenarios-kit.ts";

// (11) Operator steer: `pomtree send` while the agent runs a long tool reaches the model as the last user message.
test("cli scenario 11: pomtree send steers a running agent and the model sees the steer", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const STEER = "STEER-7f3a finish now";
  const script: ModelScript = {
    name: "cli-steer",
    rules: [
      {
        id: "steer-result",
        when: { lastUserIncludes: "STEER-7f3a" },
        times: 1,
        reply: { kind: "tool_calls", calls: [bash("pomtree result --summary steered")], usage: BIG },
      },
      { id: "after-steer", when: { lastUserIncludes: "STEER-7f3a" }, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
      {
        id: "sleep",
        when: { toolResults: 0 },
        reply: { kind: "tool_calls", calls: [bash(holdUntilReleased("rm -f /tmp/e2e-release; echo slept"))], usage: BIG },
      },
      {
        id: "sleep-again",
        when: {},
        times: 4,
        reply: { kind: "tool_calls", calls: [bash(holdUntilReleased("rm -f /tmp/e2e-release; echo slept"))], usage: BIG },
      },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:steer]] wait for instructions", name: "steer", budget: 500_000 });
    await s.stub.waitForCalls(1, 120_000);
    const sent = await s.pomtree(["send", a.id, STEER]);
    assert.equal(sent.code, 0, sent.err);
    // Each held tool call ends only when released (and clears the flag), so the model's turns advance one release at a time until the steer
    // reaches it: the steer was sent while the first tool was still running.
    const box = `pomtree-${(await showAgent(s, a.id)).sandbox}`;
    // The agent pulls the steer on its own poll (journaled as ext.pomtreed.steered): releasing the tool before that burns the scripted turns.
    await s.until("the agent has pulled the steer", async () => (await s.kinds(a.id, "ext.pomtreed.steered")).length > 0, 60_000);
    await s.until(
      "the steer reaches the model",
      async () => {
        if (s.stub.calls.some((c) => c.matched === "steer-result")) return true;
        await release([box]).catch(() => {}); // the container may be gone once the agent has finished
        return false;
      },
      60_000,
    );
    assert.equal(typeof sent.json<{ delivered?: string }>(), "object");
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    assert.equal((rec.result as { summary?: string }).summary, "steered");
    const steered = s.stub.calls.filter((c) => c.matched === "steer-result");
    assert.equal(steered.length, 1);
    assert.ok(steered[0]!.lastUserText?.includes(STEER));
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (2) Budget exhaustion: a reply whose usage overspends the budget parks the agent on a budget_raise approval; the operator grants it and
// the agent finishes, or denies it and the run ends over_budget. Prompt tokens are priced at deepseek-flash's $0.30/MTok against a
// $0.10 budget: 400k tokens overshoot by $0.02 (under the default 50% raise), 1M by $0.20 (over it).
// The raise is the overshoot plus the pct headroom (budget-raise-headroom), so even the large overshoot resumes with budget left; a raise
// of exactly the overshoot would leave the agent parked with budget == spent.
const BUDGET_CASES = [
  { label: "approve resumes", decision: "approve", input: 400_000 },
  { label: "approve resumes after a large overshoot", decision: "approve", input: 1_000_000 },
  { label: "deny ends over_budget", decision: "deny", input: 400_000 },
] as const;
for (const c of BUDGET_CASES) {
  const { decision } = c;
  test(`cli scenario 2: budget exhaustion parks on an escalation; ${c.label}`, {
    skip: SKIP,
    timeout: TIMEOUT,
  }, async () => {
    const script: ModelScript = {
      name: `cli-budget-${decision}`,
      rules: [
        { id: "overspend", when: { turn: 0 }, times: 1, reply: { kind: "text", text: "spent a lot", usage: { input: c.input, output: 10 } } },
        { id: "finish", when: { toolResults: 0 }, times: 1, reply: { kind: "tool_calls", calls: [bash("pomtree result --summary granted")], usage: BIG } },
        { id: "done", when: {}, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
      ],
    };
    await withStack({ script }, async (s) => {
      const a = await spawnAgent(s, { task: "[[scn:budget]] spend", name: "spender", budget: 100_000 });
      await s.until("budget escalation", async () => (await s.kinds(a.id, POMTREED_KINDS.budgetEscalated)).length === 1, 120_000);
      const esc = (await s.kinds(a.id, POMTREED_KINDS.budgetEscalated))[0]!.payload as unknown as { approval: string; requested: number; spent: number };
      assert.ok(esc.spent >= 100_000, JSON.stringify(esc));
      assert.ok(esc.requested > 0, JSON.stringify(esc));
      await s.until("agent parked", async () => (await s.pomtree(["show", a.id])).json<{ agent: AgentJson }>().agent.state === "yielded", 60_000);
      const d = await s.pomtree(["decide", esc.approval, decision]);
      assert.equal(d.code, 0, d.err);
      const rec = await waitDone(s, a.id);
      if (decision === "approve") {
        assert.equal(rec.exit, "succeeded");
        assert.equal((await s.kinds(a.id, POMTREED_KINDS.budgetGranted)).length, 1);
        assert.ok(rec.budgetMicros > 100_000, JSON.stringify(rec));
      } else {
        assert.equal(rec.exit, "over_budget");
        assert.equal(s.stub.calls.filter((c) => c.matched === "finish").length, 0);
      }
      // Repeating the decision is a replay (exit 0); the opposite decision on a settled approval is a conflict (exit 5).
      assert.equal((await s.pomtree(["decide", esc.approval, decision])).code, 0);
      assert.equal((await s.pomtree(["decide", esc.approval, decision === "approve" ? "deny" : "approve"])).code, 5);
      const settled = await s.settlements(a.id);
      assert.equal(s.debit(a.id)?.spent, sum(settled));
      assert.equal(s.debit(a.id)?.reserved, 0);
      await reap(s, a.id);
      assert.deepEqual(s.stub.unmatched, []);
    });
  });
}

// (4) Three different 402/401 causes have three different outcomes: upstream 401 is an auth stop, upstream 402 a funding stop, and the
// proxy's own 402 (the reservation does not fit the budget; the stub is never called) a budget escalation.
test("cli scenario 4: upstream 401, upstream 402 and proxy 402 have distinct outcomes", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const script: ModelScript = {
    name: "cli-401-402",
    rules: [
      { id: "auth", when: { lastUserIncludes: "[[scn:auth]]" }, reply: { kind: "fault", fault: { type: "status", status: 401 } } },
      // Every other call is the funding agent's (passive-settle nudges replace its last user message); the proxy-402 agent never calls.
      { id: "funding", when: {}, reply: { kind: "fault", fault: { type: "status", status: 402 } } },
    ],
  };
  await withStack({ script }, async (s) => {
    const auth = await spawnAgent(s, { task: "[[scn:auth]] go", name: "auth", budget: 500_000 });
    const funding = await spawnAgent(s, { task: "[[scn:funding]] go", name: "funding", budget: 500_000 });
    const broke = await spawnAgent(s, { task: "[[scn:broke]] go", name: "broke", budget: 10 });

    const authRec = await waitDone(s, auth.id);
    assert.equal(authRec.exit, "failed");
    assert.equal(authRec.exitCause, "provider_error");
    assert.ok((await s.settlements(auth.id)).every((x) => x.settlement === "failed" && x.errorClass === "auth_rejected"));
    const authErr = (await s.kinds(auth.id, "provider_error")).map((e) => e.payload as unknown as { code: string; retryable: boolean });
    assert.equal(authErr.at(-1)?.code, "auth", JSON.stringify(authErr));
    await t.test("auth is never retryable", () => {
      assert.ok(
        authErr.every((e) => e.retryable === false),
        JSON.stringify(authErr),
      );
      assert.equal(s.stub.calls.filter((c) => c.matched === "auth").length, 1);
    });

    const fundRec = await waitDone(s, funding.id);
    assert.equal(fundRec.exit, "failed");
    assert.ok((await s.settlements(funding.id)).every((x) => x.settlement === "failed" && x.errorClass === "insufficient_funds"));
    assert.equal((await s.kinds(funding.id, POMTREED_KINDS.budgetEscalated)).length, 0);
    // An upstream 402 with a plain JSON body is classified by the HTTP status alone, so the run stops at once as a funding stop rather
    // than settling the turn as passive and ending passive_settle after three 402s (provider-error-gaps).
    await t.test("an upstream 402 is a funding stop", async () => {
      assert.equal(fundRec.exitCause, "provider_error");
      assert.equal(((await s.kinds(funding.id, "provider_error")).at(-1)?.payload as { code?: string } | undefined)?.code, "funding");
      assert.ok((await s.kinds(funding.id, "error")).some((e) => String(e.payload.message).startsWith("provider funding:")));
      assert.equal(s.stub.calls.filter((c) => c.matched === "funding").length, 1);
    });

    // Proxy 402: never reaches the stub; parks on a budget escalation instead of failing.
    await s.until("proxy-402 budget escalation", async () => (await s.kinds(broke.id, POMTREED_KINDS.budgetEscalated)).length === 1, 120_000);
    assert.equal((await s.kinds(broke.id, "provider_error")).filter((e) => e.payload.code === "funding").length, 0);
    assert.deepEqual(await s.settlements(broke.id), []);
    const esc = (await s.kinds(broke.id, POMTREED_KINDS.budgetEscalated))[0]!.payload as unknown as { approval: string };
    assert.equal((await s.pomtree(["decide", esc.approval, "deny"])).code, 0);
    assert.equal((await waitDone(s, broke.id)).exit, "over_budget");

    for (const id of [auth.id, funding.id, broke.id]) await reap(s, id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
