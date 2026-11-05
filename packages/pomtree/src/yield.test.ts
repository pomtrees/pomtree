import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveYieldKey, parseYieldWait } from "./yield.ts";

test("parseYieldWait parses message", () => {
  assert.deepEqual(parseYieldWait("message", 1000), { kind: "message" });
});

test("parseYieldWait parses timer as now plus ms", () => {
  assert.deepEqual(parseYieldWait("timer:250", 1000), { kind: "timer", at: 1250 });
  assert.deepEqual(parseYieldWait("timer:0", 1000), { kind: "timer", at: 1000 });
});

test("parseYieldWait parses child_exited with a default mode of any", () => {
  assert.deepEqual(parseYieldWait("child_exited:a,b", 0), { kind: "child_exited", children: ["a", "b"], mode: "any" });
  assert.deepEqual(parseYieldWait("child_exited:a", 0), { kind: "child_exited", children: ["a"], mode: "any" });
  assert.deepEqual(parseYieldWait("child_exited: a, b", 0), { kind: "child_exited", children: ["a", "b"], mode: "any" });
});

test("parseYieldWait parses explicit child_exited modes", () => {
  assert.deepEqual(parseYieldWait("child_exited:any:a,b", 0), { kind: "child_exited", children: ["a", "b"], mode: "any" });
  assert.deepEqual(parseYieldWait("child_exited:all:a,b", 0), { kind: "child_exited", children: ["a", "b"], mode: "all" });
});

test("parseYieldWait rejects empty or unknown shorthands", () => {
  for (const raw of [
    "",
    "timer:",
    "timer:soon",
    "timer:-1",
    "timer:1.5",
    "child_exited",
    "child_exited:any",
    "child_exited:all",
    "child_exited:",
    "child_exited:any:",
    "bogus",
    "message:x",
  ]) {
    assert.throws(() => parseYieldWait(raw, 0), /child id|non-negative|unknown --until/, raw || "<empty>");
  }
});

test("effectiveYieldKey prefers the explicit key and otherwise issues a fresh per-invocation key", () => {
  assert.equal(effectiveYieldKey("k1"), "k1");
  assert.notEqual(effectiveYieldKey(), effectiveYieldKey()); // two identical yields are not deduplicated
  assert.match(effectiveYieldKey(), /^[0-9a-f-]{36}$/);
});
