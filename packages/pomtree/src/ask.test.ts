import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveAskKey, parseGeneration, parseOptions, renderBudget } from "./ask.ts";

test("effectiveAskKey prefers the explicit key and otherwise issues a fresh per-invocation key", () => {
  assert.equal(effectiveAskKey("k1"), "k1");
  assert.notEqual(effectiveAskKey(), effectiveAskKey()); // two identical asks are not deduplicated
  assert.match(effectiveAskKey(), /^[0-9a-f-]{36}$/);
});

test("parseOptions splits on commas, trims, and drops empties", () => {
  assert.deepEqual(parseOptions(undefined), []);
  assert.deepEqual(parseOptions(""), []);
  assert.deepEqual(parseOptions("a,b"), ["a", "b"]);
  assert.deepEqual(parseOptions("a, b"), ["a", "b"]);
  assert.deepEqual(parseOptions("a,,b"), ["a", "b"]);
});

test("parseGeneration accepts a non-negative integer and rejects everything else", () => {
  assert.equal(parseGeneration("0"), 0);
  assert.equal(parseGeneration("7"), 7);
  assert.equal(parseGeneration(undefined), null);
  assert.equal(parseGeneration(""), null);
  assert.equal(parseGeneration("-1"), null);
  assert.equal(parseGeneration("1.5"), null);
  assert.equal(parseGeneration("soon"), null);
});

test("renderBudget shows remaining against budget", () => {
  assert.equal(renderBudget({ budgetMicros: 1000, remainingMicros: 250 }), "budget: $0.00 (1000 µ$)\nremaining: $0.00 (250 µ$)");
});
