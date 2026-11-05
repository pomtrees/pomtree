import { test } from "node:test";
import assert from "node:assert/strict";
import type { WaitCondition } from "@pomtree/core";
import { nextDeadline, satisfied } from "./wait.ts";

const ctx = (over: { signal?: unknown; done?: Set<string>; now?: number } = {}) => ({
  signal: over.signal as never,
  childDone: (id: string) => over.done?.has(id) ?? false,
  now: over.now ?? 0,
});

test("message is satisfied by message, human_message, and human_answer signals", () => {
  assert.equal(satisfied({ kind: "message" }, ctx({ signal: { kind: "message", from: "a", body: "hi" } })), true);
  assert.equal(satisfied({ kind: "message" }, ctx({ signal: { kind: "human_message", from: { channel: "operator", sender: "operator" }, body: "hi" } })), true);
  assert.equal(
    satisfied(
      { kind: "message" },
      ctx({ signal: { kind: "human_answer", escalation: "es-1", from: { channel: "operator", sender: "operator" }, body: "yes" } }),
    ),
    true,
  );
  assert.equal(satisfied({ kind: "message" }, ctx({ signal: { kind: "timeout" } })), false);
  assert.equal(satisfied({ kind: "message" }, ctx()), false);
});

test("an escalation signal satisfies message, any, child_exited and timer waits alike", () => {
  const signal = { kind: "escalation", escalation: "es-1", subject: "ask", from: "c", body: "q?", deadlineAt: 9 };
  const conds: WaitCondition[] = [
    { kind: "message" },
    { kind: "child_exited", children: ["c"], mode: "all" },
    { kind: "timer", at: 1000 },
    {
      kind: "any",
      of: [
        { kind: "child_exited", children: ["c"], mode: "any" },
        { kind: "timer", at: 1000 },
      ],
    },
  ];
  for (const c of conds) assert.equal(satisfied(c, ctx({ signal })), true);
  assert.equal(satisfied({ kind: "child_exited", children: ["c"], mode: "all" }, ctx()), false);
});

test("timer is satisfied by now reaching at, or by a timeout signal", () => {
  const cond: WaitCondition = { kind: "timer", at: 100 };
  assert.equal(satisfied(cond, ctx({ now: 99 })), false);
  assert.equal(satisfied(cond, ctx({ now: 100 })), true);
  assert.equal(satisfied(cond, ctx({ signal: { kind: "timeout" }, now: 0 })), true);
});

test("child_exited any is satisfied when any listed child is done", () => {
  const cond: WaitCondition = { kind: "child_exited", children: ["a", "b"], mode: "any" };
  assert.equal(satisfied(cond, ctx()), false);
  assert.equal(satisfied(cond, ctx({ done: new Set(["a"]) })), true);
});

test("child_exited all is satisfied when every listed child is done", () => {
  const cond: WaitCondition = { kind: "child_exited", children: ["a", "b"], mode: "all" };
  assert.equal(satisfied(cond, ctx()), false);
  assert.equal(satisfied(cond, ctx({ done: new Set(["a"]) })), false);
  assert.equal(satisfied(cond, ctx({ done: new Set(["a", "b"]) })), true);
});

test("any-of nests recursive OR", () => {
  const cond: WaitCondition = {
    kind: "any",
    of: [
      { kind: "message" },
      { kind: "child_exited", children: ["a"], mode: "any" },
      {
        kind: "any",
        of: [{ kind: "timer", at: 50 }, { kind: "message" }],
      },
    ],
  };
  assert.equal(satisfied(cond, ctx()), false);
  assert.equal(satisfied(cond, ctx({ done: new Set(["a"]) })), true);
  assert.equal(satisfied(cond, ctx({ now: 50 })), true);
  assert.equal(satisfied(cond, ctx({ signal: { kind: "timeout" } })), true);
});

// A custody hand-up is a `child_exited` carrying `custodyOf` (the dead parent); `ownExit` is an ordinary child exit, the
// negative control: without `custodyOf` the signal behaves as before.
const custody = { kind: "child_exited", child: "leaf", exit: "succeeded", handoff: "done", custodyOf: "middle" };
const ownExit = { kind: "child_exited", child: "middle", exit: "failed" };

test("custody hand-up: wakes a message wait; an ordinary child_exited still does not", () => {
  assert.equal(satisfied({ kind: "message" }, ctx({ signal: custody })), true);
  assert.equal(satisfied({ kind: "message" }, ctx({ signal: ownExit, done: new Set(["middle"]) })), false);
});

test("custody hand-up: wakes an any-mode child_exited wait on running children; an all-mode join still needs every child", () => {
  const any: WaitCondition = { kind: "child_exited", children: ["other"], mode: "any" };
  const all: WaitCondition = { kind: "child_exited", children: ["middle", "other"], mode: "all" };
  assert.equal(satisfied(any, ctx({ signal: custody })), true);
  assert.equal(satisfied(any, ctx({ signal: ownExit, done: new Set(["middle"]) })), false);
  assert.equal(satisfied(all, ctx({ signal: custody })), false);
  assert.equal(satisfied(all, ctx({ signal: custody, done: new Set(["middle"]) })), false);
  assert.equal(satisfied(all, ctx({ signal: custody, done: new Set(["middle", "other"]) })), true);
});

test("custody hand-up: wakes a timer wait before its deadline, and an any-of through any member it wakes", () => {
  assert.equal(satisfied({ kind: "timer", at: 100 }, ctx({ signal: custody, now: 0 })), true);
  assert.equal(satisfied({ kind: "timer", at: 100 }, ctx({ signal: ownExit, now: 0 })), false);
  const anyOf: WaitCondition = { kind: "any", of: [{ kind: "message" }, { kind: "timer", at: 100 }] };
  assert.equal(satisfied(anyOf, ctx({ signal: custody, now: 0 })), true);
  assert.equal(satisfied(anyOf, ctx({ signal: ownExit, now: 0 })), false);
  // an any-of whose only member is an all-mode join keeps the join's rule
  const joinOnly: WaitCondition = { kind: "any", of: [{ kind: "child_exited", children: ["a", "b"], mode: "all" }] };
  assert.equal(satisfied(joinOnly, ctx({ signal: custody, done: new Set(["a"]) })), false);
});

test("nextDeadline returns the minimum timer.at over the tree", () => {
  const cond: WaitCondition = {
    kind: "any",
    of: [
      { kind: "message" },
      { kind: "timer", at: 200 },
      {
        kind: "any",
        of: [
          { kind: "timer", at: 50 },
          { kind: "child_exited", children: [], mode: "all" },
        ],
      },
    ],
  };
  assert.equal(nextDeadline(cond), 50);
});

test("nextDeadline returns a leaf timer and null with no timers", () => {
  assert.equal(nextDeadline({ kind: "timer", at: 42 }), 42);
  assert.equal(nextDeadline({ kind: "message" }), null);
  assert.equal(nextDeadline({ kind: "child_exited", children: ["a"], mode: "any" }), null);
  assert.equal(nextDeadline({ kind: "any", of: [{ kind: "message" }, { kind: "child_exited", children: [], mode: "all" }] }), null);
});
