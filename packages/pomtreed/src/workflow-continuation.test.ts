import assert from "node:assert/strict";
import test from "node:test";
import type { JournalEntry } from "@pomtree/core";
import { FakeJournal } from "@pomtree/testing";
import { CONTINUATION_KIND, latestContinuation } from "./workflow-continuation.ts";

// Journal fake: the shared FakeJournal with its entries seeded directly and every read recorded.
function journalOf(entries: JournalEntry[]) {
  const journal = new FakeJournal(() => 0);
  journal.entries = entries;
  const calls: { agent?: string; from?: number; limit?: number }[] = [];
  const read = journal.read.bind(journal);
  journal.read = async (o) => {
    calls.push({ ...o });
    return read(o);
  };
  return { journal, calls };
}

function row(seq: number, payload: Record<string, unknown>, generation = 1): JournalEntry {
  return { seq, ts: seq, agent: "a", host: "h", generation, payload: payload as never } as JournalEntry;
}

function continuation(seq: number, generation = 1, extra: Record<string, unknown> = {}): JournalEntry {
  return row(seq, { kind: CONTINUATION_KIND, state: { n: seq }, wait: { kind: "message" }, inbox: [], ...extra }, generation);
}

function filler(seq: number): JournalEntry {
  return row(seq, { kind: "usage", costMicros: 0, inputTokens: 1, outputTokens: 1 });
}

test("latestContinuation pages past the 500-row boundary and returns the latest continuation", async () => {
  const entries: JournalEntry[] = [];
  for (let seq = 1; seq <= 600; seq++) {
    if (seq === 100) entries.push(continuation(seq, 1));
    else if (seq === 550) entries.push(continuation(seq, 2, { state: { n: 550 }, inbox: ["m1"] }));
    else entries.push(filler(seq));
  }
  const { journal, calls } = journalOf(entries);
  const latest = await latestContinuation(journal, "a");
  assert.deepEqual(latest, { generation: 2, state: { n: 550 }, wait: { kind: "message" }, inbox: ["m1"] });
  assert.deepEqual(calls, [
    { agent: "a", from: 0, limit: 500 },
    { agent: "a", from: 501, limit: 500 },
  ]);
});

test("latestContinuation reads a second empty page when exactly 500 rows are returned", async () => {
  const entries: JournalEntry[] = [];
  for (let seq = 1; seq <= 500; seq++) entries.push(seq === 10 ? continuation(seq, 3) : filler(seq));
  const { journal, calls } = journalOf(entries);
  const latest = await latestContinuation(journal, "a");
  assert.equal(latest?.generation, 3);
  assert.deepEqual(calls, [
    { agent: "a", from: 0, limit: 500 },
    { agent: "a", from: 501, limit: 500 },
  ]);
});

test("latestContinuation returns undefined when no continuation exists", async () => {
  const { journal } = journalOf([filler(1), filler(2), row(3, { kind: "other" })]);
  assert.equal(await latestContinuation(journal, "a"), undefined);
  const empty = journalOf([]);
  assert.equal(await latestContinuation(empty.journal, "a"), undefined);
});

test("latestContinuation skips rows whose kind is not the continuation kind", async () => {
  const { journal } = journalOf([
    row(1, { kind: "ext.workflow.continuation.draft", wait: "bad", inbox: 7, state: undefined }),
    row(2, { kind: "other", wait: "bad", inbox: 7 }),
    continuation(3, 4),
    row(4, { kind: "ext.workflow.continuation.draft", wait: "bad" }),
  ]);
  const latest = await latestContinuation(journal, "a");
  assert.equal(latest?.generation, 4);
});

test("latestContinuation takes the generation from the continuation entry", async () => {
  const { journal } = journalOf([continuation(1, 7)]);
  assert.equal((await latestContinuation(journal, "a"))?.generation, 7);
});

test("latestContinuation rejects malformed continuation rows", async () => {
  const bad: Record<string, unknown>[] = [
    { state: undefined, wait: { kind: "message" }, inbox: [] },
    { state: 1n, wait: { kind: "message" }, inbox: [] },
    { state: {}, wait: { kind: "sleep" }, inbox: [] },
    { state: {}, wait: { kind: "timer", at: -1 }, inbox: [] },
    { state: {}, wait: { kind: "message" }, inbox: "m1" },
    { state: {}, wait: { kind: "message" }, inbox: [1] },
  ];
  for (const payload of bad) {
    const { journal } = journalOf([row(1, { kind: CONTINUATION_KIND, ...payload })]);
    await assert.rejects(latestContinuation(journal, "a"), /invalid workflow continuation/);
  }
});

test("latestContinuation throws when a malformed continuation follows a valid one", async () => {
  const { journal } = journalOf([continuation(1, 1), row(2, { kind: CONTINUATION_KIND, state: {}, wait: null, inbox: [] })]);
  await assert.rejects(latestContinuation(journal, "a"), /invalid workflow continuation/);
});
