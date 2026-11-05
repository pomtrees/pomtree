import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveView } from "./live.ts";
import { agent, entry } from "./fixtures.ts";
import { buildTree } from "./tree.ts";
import type { JournalEntry } from "@pomtree/core";

async function* source(list: JournalEntry[]) {
  for (const e of list) yield e;
}

const journal = [
  entry(1, "a", { kind: "spawned" }),
  entry(2, "a", { kind: "usage", inputTokens: 4, outputTokens: 1, costMicros: 9 }),
  entry(3, "a", { kind: "tool_call", tool: "bash", callId: "c", input: {} }),
];

test("folding a subscription matches the batch tree, ignoring duplicates", async () => {
  const view = new LiveView();
  const seen: number[] = [];
  await view.consume(source([...journal, journal[1]!]), (e) => seen.push(e.seq));
  assert.deepEqual(seen, [1, 2, 3]);
  const agents = [agent("a", null)];
  assert.deepEqual(view.rows(agents, { now: 50 }), buildTree(agents, journal, { now: 50 }));
});

test("rows update incrementally as entries arrive", () => {
  const view = new LiveView();
  const agents = [agent("a", null)];
  assert.equal(view.apply(journal[0]!), true);
  assert.equal(view.rows(agents, { now: 1 })[0]!.activity, "spawned");
  view.apply(journal[2]!);
  assert.equal(view.rows(agents, { now: 1 })[0]!.activity, "tool bash");
  assert.equal(view.apply(journal[2]!), false);
});

test("a late older entry does not overwrite newer activity", () => {
  const view = new LiveView();
  view.apply(journal[2]!);
  view.apply(journal[0]!);
  assert.equal(view.rows([agent("a", null)], { now: 1 })[0]!.activity, "tool bash");
});

test("LiveView applies each seq once and retires the delivered prefix (dedupe itself: seqDedupe.test.ts)", () => {
  const view = new LiveView();
  assert.equal(view.apply(entry(2, "a", { kind: "spawned" })), true);
  assert.equal(view.apply(entry(1, "a", { kind: "spawned" })), true);
  assert.equal(view.seenSeqCount, 0);
  assert.equal(view.apply(entry(2, "a", { kind: "spawned" })), false);
});

test("LiveView hides message text unless constructed with includeContent", () => {
  const msg = entry(1, "root", { kind: "message", role: "user", text: "hunter2" });
  const hidden = new LiveView();
  hidden.apply(msg);
  assert.equal(hidden.rows([agent("root", null)], { now: 1 })[0]!.activity, "user message");
  const shown = new LiveView({ includeContent: true });
  shown.apply(msg);
  assert.equal(shown.rows([agent("root", null)], { now: 1 })[0]!.activity, "user: hunter2");
});
