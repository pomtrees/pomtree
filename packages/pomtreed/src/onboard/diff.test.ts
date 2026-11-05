import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "./diff.ts";

test("diffLines prints only changed lines", () => {
  assert.deepEqual(diffLines("a\nb\nc\n", "a\nB\nc\nd\n"), ["-b", "+B", "+d"]);
});

test("diffLines is empty for equal text and handles an empty side", () => {
  assert.deepEqual(diffLines("a\n", "a\n"), []);
  assert.deepEqual(diffLines("", "x\n"), ["+x"]);
  assert.deepEqual(diffLines("x\n", ""), ["-x"]);
});
