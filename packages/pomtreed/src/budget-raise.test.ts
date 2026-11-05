import assert from "node:assert/strict";
import { test } from "node:test";
import { modelRefusalTag } from "@pomtree/core";
import { budgetRaiseBody, budgetRaiseTarget, budgetWakeText, isBudgetRefusal, parseBudgetRaiseTarget, requestedRaise } from "./budget-raise.ts";
import { signalToWake } from "./daemon-util.ts";
import { MODEL_BUDGET_EXHAUSTED } from "./model-proxy/service.ts";

test("the approval target round-trips and rejects malformed or non-positive amounts", () => {
  const target = budgetRaiseTarget("ag-1", 3, 500);
  assert.equal(target, "ag-1:3:3:500");
  assert.deepEqual(parseBudgetRaiseTarget(target), { asker: "ag-1", generation: 3, n: 3, requestedMicros: 500 });
  assert.equal(parseBudgetRaiseTarget("a:b:3:3:500")?.asker, "a:b", "an asker id may itself contain a colon");
  assert.equal(parseBudgetRaiseTarget("ag-1:0:0:0"), null);
  assert.equal(parseBudgetRaiseTarget("nonsense"), null);
});

test("the requested raise is the percent of the original budget, never below the overshoot or one micro", () => {
  assert.equal(requestedRaise(50, 1_000, 0), 500);
  assert.equal(requestedRaise(50, 1_001, 0), 501, "rounds up");
  assert.equal(requestedRaise(50, 1_000, 700), 1_200, "the overshoot plus the pct headroom");
  // budget-raise-headroom regression: a large overshoot still leaves pct of the original budget to spend after the grant.
  const budget = 1_000;
  const spent = 3_500;
  const granted = budget + requestedRaise(50, budget, spent - budget);
  assert.equal(granted - spent, 500, "pct headroom remains after a 2.5x overshoot");
  assert.equal(requestedRaise(50, 1, 0), 1);
  assert.equal(requestedRaise(1, 10, 0), 1);
});

test("the proxy refusal is matched by its refusal tag only", () => {
  assert.equal(isBudgetRefusal(`402 ${MODEL_BUDGET_EXHAUSTED}: 5 micro-USD remain after in-flight requests`), true);
  assert.equal(isBudgetRefusal("402 model budget exhausted: 5 micro-USD remain after in-flight requests"), false, "the phrase alone is prose, not the code");
  assert.equal(isBudgetRefusal(`400 ${modelRefusalTag("malformed_tool_arguments")} bad call`), false, "another refusal code");
  assert.equal(isBudgetRefusal("429 rate limit exceeded"), false);
});

test("texts name the asker, the amount and the aborted tool calls; the budget warning urges a push", () => {
  assert.equal(budgetRaiseBody("ag-1", 2_000_000), "ag-1 out of budget; approve +$2.00?");
  const text = budgetWakeText({ spent: 1_000_000, budget: 1_000_000, holder: "ag-2", amount: 500_000, newBudget: 1_500_000 });
  assert.match(
    text,
    /^Resumed: your budget \(\$1\.00 of \$1\.00\) was exhausted and you were parked\. ag-2 granted \+\$0\.50; budget is now \$1\.50 \(\$0\.50 left\)\./,
  );
  assert.match(text, /in flight when you stopped were aborted and may have partly run/);
  assert.match(signalToWake({ kind: "budget_warning", remainingMicros: 100_000, budgetMicros: 1_000_000, thresholdFraction: 0.9 }), /pomtree push/);
});
