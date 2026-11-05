import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TOOL_DETAILS_BYTES, TOOL_DETAILS_DROP_KEY, boundToolDetails } from "./tool-details.ts";

const dropped = (reason: string) => ({ [TOOL_DETAILS_DROP_KEY]: reason });

test("absent details stay absent", () => {
  assert.equal(boundToolDetails(undefined), undefined);
});

test("plain JSON within the bound is kept as is", () => {
  const d = { page: 3, attempts: 2, nested: [1, "a", null, true, { k: 1.5 }] };
  assert.deepEqual(boundToolDetails(d), d);
  assert.equal(boundToolDetails(null), null);
  assert.equal(boundToolDetails(0), 0);
});

test("oversize details become the drop marker, never a clipped fragment", () => {
  const big = { text: "x".repeat(MAX_TOOL_DETAILS_BYTES) };
  assert.deepEqual(boundToolDetails(big), dropped("oversize"));
  const edge = "x".repeat(MAX_TOOL_DETAILS_BYTES - 2); // JSON string adds two quotes: exactly at the bound
  assert.equal(boundToolDetails(edge), edge);
  assert.deepEqual(boundToolDetails(`${edge}y`), dropped("oversize"));
  assert.deepEqual(boundToolDetails(Array.from({ length: 5000 }, () => 0)), dropped("oversize")); // node budget, not walked in full
});

test("the bound counts UTF-8 bytes, not characters", () => {
  assert.deepEqual(boundToolDetails("é".repeat(MAX_TOOL_DETAILS_BYTES / 2)), dropped("oversize"));
});

test("non-JSON values are refused with the marker", () => {
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  for (const bad of [
    () => 1,
    1n,
    Symbol("s"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(0),
    new Map(),
    new (class A {})(),
    { a: undefined },
    [undefined],
    cyc,
  ]) {
    assert.deepEqual(boundToolDetails(bad), dropped("non_json"), String(typeof bad));
  }
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  assert.deepEqual(boundToolDetails(deep), dropped("non_json"));
});

test("a marker passes unchanged (idempotent)", () => {
  assert.deepEqual(boundToolDetails(boundToolDetails({ x: "y".repeat(5000) })), dropped("oversize"));
});
