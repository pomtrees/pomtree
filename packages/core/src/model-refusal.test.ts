import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_BUDGET_REFUSAL_MESSAGE, MODEL_REFUSAL_CODES, modelRefusalCodeIn, modelRefusalTag } from "./index.ts";

test("every refusal code round-trips through its tag embedded in error text", () => {
  for (const code of MODEL_REFUSAL_CODES) {
    const tag = modelRefusalTag(code);
    assert.equal(tag, `[pomtree-refusal:${code}]`);
    assert.equal(modelRefusalCodeIn(`402 ${MODEL_BUDGET_REFUSAL_MESSAGE}: no budget remains ${tag}`), code);
  }
});

test("unknown codes, near-miss markers and bare prose parse to undefined", () => {
  assert.equal(modelRefusalCodeIn("[pomtree-refusal:model_budget_exhaustedx]"), undefined);
  assert.equal(modelRefusalCodeIn("[pomtree-refusal:rate_limited]"), undefined);
  assert.equal(modelRefusalCodeIn("[pomtree-refusal: model_budget_exhausted]"), undefined);
  assert.equal(modelRefusalCodeIn("[pomtree_refusal:model_budget_exhausted]"), undefined);
  assert.equal(modelRefusalCodeIn("pomtree-refusal:model_budget_exhausted"), undefined);
  assert.equal(modelRefusalCodeIn(MODEL_BUDGET_REFUSAL_MESSAGE), undefined);
  assert.equal(modelRefusalCodeIn(""), undefined);
});

test("an unknown tag before a known one does not hide the known code", () => {
  assert.equal(modelRefusalCodeIn("[pomtree-refusal:other] then [pomtree-refusal:malformed_tool_arguments]"), "malformed_tool_arguments");
});
