import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "./rates-fake.ts";

test("FakeRatesSource returns scripted rates, null for unknown models, and records each lookup", () => {
  const card = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
  const src = new FakeRatesSource({ p: { m: card } });
  assert.deepEqual(src.lookup("p", "m"), card);
  assert.equal(src.lookup("p", "nope"), null);
  assert.equal(src.lookup("q", "m"), null);
  assert.deepEqual(src.lookups, [
    { provider: "p", model: "m" },
    { provider: "p", model: "nope" },
    { provider: "q", model: "m" },
  ]);
});
