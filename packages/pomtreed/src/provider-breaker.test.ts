import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderBreaker } from "./provider-breaker.ts";

test("breaker trips after threshold errors in the window and closes on success", () => {
  const b = new ProviderBreaker({ threshold: 3, windowMs: 1000 });
  assert.equal(b.record("p", 0, 500), null);
  assert.equal(b.record("p", 100, 500), null);
  assert.equal(b.record("p", 200, 500), 700);
  assert.equal(b.degradedUntil("p", 300), 700);
  assert.equal(b.degradedUntil("q", 300), null);
  assert.equal(b.degradedUntil("p", 800), null);
  b.success("p");
  assert.equal(b.anyDegraded(300), false);
});

test("errors outside the window do not accumulate", () => {
  const b = new ProviderBreaker({ threshold: 2, windowMs: 100 });
  b.record("p", 0, 50);
  assert.equal(b.record("p", 500, 50), null);
});
