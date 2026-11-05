import { test } from "node:test";
import assert from "node:assert/strict";
import { POMTREED_KINDS } from "@pomtree/core";
import { buildTree } from "./tree.ts";
import { agent, entry } from "./fixtures.ts";

const agents = [
  agent("root", null, { createdAt: 0 }),
  agent("b", "root", { createdAt: 20, state: "yielded", budgetMicros: 500 }),
  agent("a", "root", { createdAt: 10, state: "exited", exit: "failed", updatedAt: 60 }),
  agent("a1", "a", { createdAt: 30, state: "reaped", updatedAt: 40 }),
  agent("orphan", "ghost", { createdAt: 5 }),
];

test("tree order, depth, and yielded agents stay in the tree with their wait", () => {
  const rows = buildTree(agents, [], {
    now: 100,
    waits: new Map([["b", { kind: "child_exited", children: ["a1"], mode: "all" }]]),
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.depth]),
    [
      ["root", 0],
      ["a", 1],
      ["a1", 2],
      ["b", 1],
      ["orphan", 0],
    ],
  );
  const b = rows.find((r) => r.id === "b")!;
  assert.equal(b.state, "yielded");
  assert.deepEqual(b.wait, { kind: "child_exited", children: ["a1"], mode: "all" });
});

test("age uses updatedAt for finished agents and now for live ones", () => {
  const rows = buildTree(agents, [], { now: 100 });
  assert.equal(rows.find((r) => r.id === "a")!.ageMs, 50);
  assert.equal(rows.find((r) => r.id === "root")!.ageMs, 100);
});

test("activity, tokens, cost and remaining budget come from the journal, deduped", () => {
  const usage = entry(2, "b", { kind: "usage", inputTokens: 100, outputTokens: 20, costMicros: 200 });
  const rows = buildTree(
    agents,
    [
      entry(3, "b", { kind: "tool_call", tool: "bash", callId: "c", input: {} }),
      usage,
      usage,
      entry(1, "b", { kind: "message", role: "assistant", text: "hello\nsecond line" }),
    ],
    { now: 100 },
  );
  const b = rows.find((r) => r.id === "b")!;
  assert.equal(b.activity, "tool bash");
  assert.equal(b.tokens, 120);
  assert.equal(b.costMicros, 200);
  assert.equal(b.remainingBudgetMicros, 300);
});

test("unknown cost (null) is not zero: the row is partial and the known sum is a bound", () => {
  const rows = buildTree(
    agents,
    [
      entry(1, "b", { kind: "usage", inputTokens: 10, outputTokens: 2, costMicros: null }),
      entry(2, "b", { kind: "usage", inputTokens: 5, outputTokens: 1, costMicros: 40 }),
      entry(3, "a", { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 0 }),
    ],
    { now: 100 },
  );
  const b = rows.find((r) => r.id === "b")!;
  assert.equal(b.tokens, 18);
  assert.equal(b.costMicros, 40);
  assert.equal(b.costPartial, true);
  assert.equal(b.remainingBudgetMicros, 460);
  const a = rows.find((r) => r.id === "a")!;
  assert.equal(a.costMicros, 0);
  assert.equal(a.costPartial, false, "a reported zero is a known zero");
});

test("message and error text stay out of the activity column unless includeContent", () => {
  const journal = [entry(1, "b", { kind: "message", role: "assistant", text: "secret plan\nline two" })];
  const off = buildTree(agents, journal, { now: 100 }).find((r) => r.id === "b")!;
  assert.equal(off.activity, "assistant message");
  const on = buildTree(agents, journal, { now: 100, includeContent: true }).find((r) => r.id === "b")!;
  assert.equal(on.activity, "assistant: secret plan");
  const err = [entry(1, "b", { kind: "error", message: "boom with details" })];
  assert.equal(buildTree(agents, err, { now: 100 }).find((r) => r.id === "b")!.activity, "error");
});

test("a parent cycle does not loop forever", () => {
  const rows = buildTree([agent("x", "y"), agent("y", "x")], [], { now: 1 });
  assert.equal(rows.length, 0);
});

test("pending reason is tracked from the journal, cleared when empty, and shown only for pending agents", async () => {
  const { displayRow } = await import("./web.ts");
  const ag = [agent("p", null, { state: "pending" })];
  const slot = entry(1, "p", { kind: POMTREED_KINDS.pendingReason, reason: "waiting for a session slot (1 of 1 in use)" } as never);
  let rows = buildTree(ag, [slot], { now: 10 });
  assert.equal(rows[0]!.pendingReason, "waiting for a session slot (1 of 1 in use)");
  assert.equal(displayRow(rows[0]!).activity, "queued \u2014 waiting for a session slot (1 of 1 in use)");
  rows = buildTree(ag, [slot, entry(2, "p", { kind: POMTREED_KINDS.pendingReason, reason: "" } as never)], { now: 10 });
  assert.equal(rows[0]!.pendingReason, "");
  rows = buildTree([agent("p", null, { state: "running" })], [slot], { now: 10 });
  assert.equal(rows[0]!.pendingReason, "");
});

test("waitingSince folds from the journal: set by the marker, kept through passive entries, cleared by activity, only for running agents", async () => {
  const { displayRow } = await import("./web.ts");
  const mark = { ...entry(1, "r", { kind: POMTREED_KINDS.waiting } as never), ts: 100 };
  const ag = [agent("r", null, { state: "running" })];
  let rows = buildTree(ag, [mark], { now: 200 });
  assert.equal(rows[0]!.waitingSince, 100);
  assert.deepEqual([displayRow(rows[0]!).activity, displayRow(rows[0]!).waitingSince], ["waiting", 100]);
  const passive = entry(2, "r", {
    kind: "message_received",
    channel: "operator",
    from: { channel: "operator", sender: "operator" },
    to: "r",
    body: "hi",
  } as never);
  assert.equal(buildTree(ag, [mark, passive], { now: 200 })[0]!.waitingSince, 100);
  const active = entry(3, "r", { kind: "message", role: "assistant", text: "x" } as never);
  rows = buildTree(ag, [mark, passive, active], { now: 200 });
  assert.equal(rows[0]!.waitingSince, null);
  assert.equal("waitingSince" in displayRow(rows[0]!), false);
  assert.equal(buildTree([agent("r", null, { state: "exited" })], [mark], { now: 200 })[0]!.waitingSince, null);
});

test("deadlineAt folds from the journal: the newest ext.pomtreed.deadline entry wins and it never pollutes activity", async () => {
  const ag = [agent("d", null, { state: "running" })];
  const rows = buildTree(
    ag,
    [entry(1, "d", { kind: POMTREED_KINDS.deadline, at: 100 } as never), entry(2, "d", { kind: POMTREED_KINDS.deadline, at: 300 } as never)],
    { now: 200 },
  );
  assert.equal(rows[0]!.deadlineAt, 300);
  assert.equal(rows[0]!.activity, null);
  const { displayRow } = await import("./web.ts");
  assert.equal(displayRow(rows[0]!).deadline, "expired");
  const none = buildTree(ag, [entry(1, "d", { kind: "tool_call", tool: "bash", callId: "c", input: {} })], { now: 200 });
  assert.equal(none[0]!.deadlineAt, null);
  assert.equal(displayRow(none[0]!).deadline, "");
});

test("a deterministic task projects without a model and does not throw", () => {
  const det = agent("d", "root", { executor: "deterministic", spec: { driver: "fetch-diff", input: {} } });
  const rows = buildTree([agents[0]!, det], [], { now: 100 });
  const row = rows.find((r) => r.id === "d");
  assert.equal(row?.model, "");
  assert.equal(row?.depth, 1);
});
