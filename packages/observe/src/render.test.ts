import { test } from "node:test";
import assert from "node:assert/strict";
import { POMTREED_KINDS } from "@pomtree/core";
import { buildTree } from "./tree.ts";
import { describeWait, formatAge, formatDeadline, formatRowCost, formatRowLeft, renderTree } from "./render.ts";
import { agent, entry } from "./fixtures.ts";

const rows = buildTree(
  [agent("root0000-x", null, { name: "root" }), agent("kid", "root0000-x", { name: "kid", state: "yielded", createdAt: 1 })],
  [entry(1, "kid", { kind: "tool_call", tool: "bash", callId: "c", input: {} })],
  { now: 90_000, waits: new Map([["kid", { kind: "any", of: [{ kind: "message" }, { kind: "child_exited", children: ["a", "b"], mode: "any" }] }]]) },
);

test("renders header, indentation, wait and activity", () => {
  const out = renderTree(rows);
  const lines = out.split("\n");
  assert.match(lines[0]!, /^AGENT\s+ID\s+STATE/);
  assert.match(lines[1]!, /^root\s+root0000\s+running/);
  assert.match(lines[2]!, /^ {2}kid\s+kid\s+yielded.*tool bash.*message \| any of 2 children/);
  assert.ok(!out.includes("\x1b["));
});

test("color adds ANSI codes only when asked", () => {
  assert.ok(renderTree(rows, { color: true }).includes("\x1b[33m"));
});

test("empty and formatting helpers", () => {
  assert.equal(renderTree([]), "(no agents)");
  assert.equal(formatAge(5_000), "5s");
  assert.equal(formatAge(125_000), "2m");
  assert.equal(formatAge(3 * 3_600_000 + 5 * 60_000), "3h05m");
  assert.equal(formatAge(2 * 86_400_000), "2d");
  assert.equal(formatDeadline(null, 0), "");
  assert.equal(formatDeadline(10_000, 20_000), "expired");
  assert.equal(formatDeadline(20_000, 10_000), "in 10s");
  assert.equal(describeWait({ kind: "child_exited", children: ["a"], mode: "all" }), "all of 1 child");
});

test("renders the deadline column from the journal's deadline entry", () => {
  const d = buildTree([agent("d", null, { state: "running" })], [entry(1, "d", { kind: POMTREED_KINDS.deadline, at: 90_000 + 3_600_000 } as never)], {
    now: 90_000,
  });
  const out = renderTree(d, { now: 90_000 });
  assert.match(out, /DEADLINE/);
  assert.match(out, /in 1h/);
  const none = buildTree([agent("d", null)], [], { now: 90_000 });
  assert.ok(!renderTree(none, { now: 90_000 }).includes("in "));
});

test("unknown cost renders as unknown, never $0; a partial sum renders as a bound", () => {
  assert.equal(formatRowCost({ costMicros: 0, costPartial: true }), "unknown");
  assert.equal(formatRowCost({ costMicros: 0, costPartial: false }), "$0.0000");
  assert.equal(formatRowCost({ costMicros: 1500, costPartial: true }), ">=$0.0015");
  assert.equal(formatRowLeft({ remainingBudgetMicros: 1000, costPartial: true }), "<=$0.0010");
  assert.equal(formatRowLeft({ remainingBudgetMicros: 1000, costPartial: false }), "$0.0010");
  const rows = buildTree([agent("x", null, { createdAt: 0 })], [entry(1, "x", { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: null })], {
    now: 10,
  });
  const out = renderTree(rows, { now: 10 });
  assert.match(out, /unknown/);
  assert.doesNotMatch(out.split("\n")[1]!, /\$0\.0000 /);
});
