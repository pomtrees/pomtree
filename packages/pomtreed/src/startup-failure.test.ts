import assert from "node:assert/strict";
import { test } from "node:test";
import { formatStartupFailure } from "./startup-failure.ts";

test("a deliberate startup refusal is one line naming the cause, with no stack", () => {
  const out = formatStartupFailure(new Error("no model provider is configured;\n set POMTREED_PROVIDER"));
  assert.deepEqual(out, ["pomtreed: startup failed: no model provider is configured; set POMTREED_PROVIDER"]);
  assert.deepEqual(formatStartupFailure("plain string"), ["pomtreed: startup failed: plain string"]);
});

test("negative: a programming fault keeps its stack after the one line", () => {
  const err = new TypeError("cannot read properties of undefined");
  const out = formatStartupFailure(err);
  assert.equal(out[0], "pomtreed: startup failed: TypeError: cannot read properties of undefined");
  assert.equal(out[1], err.stack);
  assert.equal(out.length, 2);
});
