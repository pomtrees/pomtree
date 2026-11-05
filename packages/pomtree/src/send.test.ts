import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveSendKey } from "./send.ts";

test("effectiveSendKey prefers the explicit key and otherwise issues a fresh per-invocation key", () => {
  assert.equal(effectiveSendKey("k1"), "k1");
  const a = effectiveSendKey();
  const b = effectiveSendKey();
  assert.notEqual(a, b); // two intentional identical sends are not deduplicated
  assert.match(a, /^[0-9a-f-]{36}$/);
});
