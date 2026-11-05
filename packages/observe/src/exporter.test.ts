import { test } from "node:test";
import assert from "node:assert/strict";
import type { Journal, JournalEntry, NewJournalEntry, Subscription } from "@pomtree/core";
import { OtlpExporter, type FetchLike } from "./exporter.ts";
import type { OtlpTracesRequest } from "./otlp.ts";
import { entry } from "./fixtures.ts";

// File-local test doubles (candidates for @pomtree/testing).

type FetchResult = { ok: boolean; status: number };

interface RecordedPost {
  url: string;
  headers: Record<string, string>;
  body: OtlpTracesRequest;
}

// A fetch that records calls and plays a script of results; the last entry repeats.
function fakeFetch(script: Array<FetchResult | Error>) {
  const calls: RecordedPost[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as OtlpTracesRequest });
    const next = script.length > 1 ? script.shift()! : script[0];
    if (!next) throw new Error("fakeFetch: empty script");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

// A Journal whose subscription replays a fixed entry list, then ends.
function fakeJournal(entries: JournalEntry[]): Journal {
  return {
    append: (_e: NewJournalEntry) => Promise.reject(new Error("fakeJournal: append not used")),
    spendFor: () => Promise.reject(new Error("fakeJournal: spendFor not used")),
    pruneJournal: () => Promise.reject(new Error("fakeJournal: pruneJournal not used")),
    read: () => Promise.resolve(entries),
    subscribe: () => {
      let closed = false;
      const sub: Subscription = {
        close() {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {
          for (const e of entries) {
            if (closed) return;
            yield e;
          }
        },
      };
      return sub;
    },
  };
}

// A Journal whose subscription replays the entries and then stays open (blocked) until
// close() is called, so the run loop only settles via an explicit close. `allConsumed`
// resolves once the last entry has been yielded to (and thus applied by) the loop.
function openJournal(entries: JournalEntry[]) {
  let closed = false;
  let wake: (() => void) | null = null;
  let markConsumed!: () => void;
  const allConsumed = new Promise<void>((res) => {
    markConsumed = res;
  });
  const journal: Journal = {
    append: (_e: NewJournalEntry) => Promise.reject(new Error("openJournal: append not used")),
    spendFor: () => Promise.reject(new Error("openJournal: spendFor not used")),
    pruneJournal: () => Promise.reject(new Error("openJournal: pruneJournal not used")),
    read: () => Promise.resolve(entries),
    subscribe: () => {
      const sub: Subscription = {
        close() {
          closed = true;
          wake?.();
        },
        async *[Symbol.asyncIterator]() {
          for (const e of entries) {
            if (closed) return;
            yield e;
          }
          markConsumed();
          while (!closed) {
            await new Promise<void>((res) => {
              wake = res;
            });
          }
        },
      };
      return sub;
    },
  };
  return { journal, allConsumed, isClosed: () => closed };
}

// A sleep that records the requested delays instead of waiting.
function fakeSleep() {
  const delays: number[] = [];
  return {
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    delays,
  };
}

const run = [
  entry(1, "a", { kind: "spawned" }),
  entry(2, "a", { kind: "tool_call", tool: "bash", callId: "c", input: {} }),
  entry(3, "a", { kind: "tool_result", callId: "c", ok: true, output: "x" }),
  entry(4, "a", { kind: "exited", exit: "succeeded" }),
];

const ok = { ok: true, status: 200 };
const spansOf = (p: RecordedPost) => p.body.resourceSpans[0]!.scopeSpans[0]!.spans;

test("posts completed spans to <endpoint>/v1/traces when the subscription ends", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const { sleep } = fakeSleep();
  const exp = new OtlpExporter({ endpoint: "http://collector:4318/", fetch, sleep });
  await exp.run(fakeJournal(run));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://collector:4318/v1/traces");
  assert.equal(calls[0]!.headers["content-type"], "application/json");
  assert.deepEqual(
    spansOf(calls[0]!).map((s) => s.kind),
    [1, 1],
  );
  assert.deepEqual(
    spansOf(calls[0]!).map((s) => s.name),
    ["execute_tool bash", "invoke_agent a"],
  );
  assert.equal(exp.stats.exportedSpans, 2);
  assert.deepEqual([exp.stats.failedPosts, exp.stats.droppedBatches], [0, 0]);
});

test("flushes mid-stream once the buffer reaches batchSize", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const { sleep } = fakeSleep();
  const exp = new OtlpExporter({ endpoint: "http://c", fetch, sleep, batchSize: 1 });
  await exp.run(fakeJournal(run));
  assert.equal(calls.length, 2); // the tool span at entry 3, the agent span at entry 4
  assert.equal(exp.stats.exportedSpans, 2);
});

test("endpoint failure retries with backoff, then drops without killing the subscription", async () => {
  const { fetch, calls } = fakeFetch([{ ok: false, status: 500 }]);
  const { sleep, delays } = fakeSleep();
  const exp = new OtlpExporter({ endpoint: "http://c", fetch, sleep, maxRetries: 2, baseDelayMs: 100 });
  await exp.run(fakeJournal(run)); // settles: the stream was consumed despite the failures
  assert.equal(calls.length, 3); // first attempt plus two retries
  assert.deepEqual(delays, [100, 200]);
  assert.equal(exp.stats.failedPosts, 3);
  assert.equal(exp.stats.droppedBatches, 1);
  assert.equal(exp.stats.exportedSpans, 0);
});

test("a retry that succeeds exports the batch and counts the failed attempts", async () => {
  const { fetch, calls } = fakeFetch([new Error("boom"), { ok: false, status: 503 }, ok]);
  const { sleep, delays } = fakeSleep();
  const exp = new OtlpExporter({ endpoint: "http://c", fetch, sleep, maxRetries: 3, baseDelayMs: 100 });
  await exp.run(fakeJournal(run));
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(exp.stats.failedPosts, 2);
  assert.equal(exp.stats.exportedSpans, 2);
  assert.equal(exp.stats.droppedBatches, 0);
});

test("flush with an empty buffer is a no-op", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const exp = new OtlpExporter({ endpoint: "http://c", fetch });
  await exp.flush();
  exp.apply(entry(1, "a", { kind: "spawned" })); // opens a span, completes none
  assert.equal(exp.pending, 0);
  await exp.flush();
  assert.equal(calls.length, 0);
});

test("run exports agents that are still running when the stream ends", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const exp = new OtlpExporter({ endpoint: "http://c", fetch });
  await exp.run(fakeJournal([entry(1, "a", { kind: "message", role: "assistant", text: "hi" })]));
  assert.equal(exp.stats.exportedSpans, 1);
  const [s] = spansOf(calls[0]!);
  assert.equal(s!.name, "invoke_agent a");
  assert.equal(s!.endTimeUnixNano, undefined);
});

test("an explicit close() settles the run loop and flushes pending spans once", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const exp = new OtlpExporter({ endpoint: "http://c", fetch });
  const { journal, allConsumed, isClosed } = openJournal([entry(1, "a", { kind: "message", role: "assistant", text: "hi" })]);
  const handle = exp.run(journal);
  await allConsumed; // the loop has applied the entry and is now waiting on the open subscription
  handle.close();
  handle.close(); // idempotent: a second close (and the finally's sub.close) must not double-flush
  await handle; // settles without throwing, flushing the still-running agent span
  assert.equal(isClosed(), true);
  assert.equal(exp.stats.exportedSpans, 1);
  assert.equal(calls.length, 1);
  assert.equal(spansOf(calls[0]!)[0]!.name, "invoke_agent a");
});

test("run exports a tool interrupted by an exit nobody reaped", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const exp = new OtlpExporter({ endpoint: "http://c", fetch });
  await exp.run(fakeJournal([entry(1, "a", { kind: "tool_call", tool: "t", callId: "c", input: {} }), entry(2, "a", { kind: "exited", exit: "cancelled" })]));
  assert.equal(exp.stats.exportedSpans, 2);
  assert.deepEqual(
    calls
      .flatMap(spansOf)
      .map((s) => s.name)
      .sort(),
    ["execute_tool t", "invoke_agent a"],
  );
});

test("flush never rejects: a non-finite timestamp is sanitized, a throwing batch is counted as dropped", async () => {
  const { fetch, calls } = fakeFetch([ok]);
  const exp = new OtlpExporter({ endpoint: "http://c", fetch });
  exp.apply(entry(1, "a", { kind: "spawned" }));
  exp.apply(entry(2, "a", { kind: "tool_call", tool: "t", callId: "c", input: {} }, { ts: Number.NaN }));
  exp.apply(entry(3, "a", { kind: "tool_result", callId: "c", ok: true, output: "" }, { ts: Number.NaN }));
  await exp.flush();
  assert.equal(calls.length, 1);
  assert.equal(exp.stats.exportedSpans, 1);
  const bad = new OtlpExporter({
    endpoint: "http://c",
    fetch,
    resource: {
      get boom(): string {
        throw new Error("boom");
      },
    },
  });
  bad.apply(entry(1, "a", { kind: "spawned" }));
  bad.apply(entry(2, "a", { kind: "tool_call", tool: "t", callId: "c", input: {} }));
  bad.apply(entry(3, "a", { kind: "tool_result", callId: "c", ok: true, output: "" }));
  await bad.flush();
  assert.equal(bad.stats.droppedBatches, 1);
  assert.equal(calls.length, 1);
});

test("a collector that never answers times out, retries and drops instead of hanging", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const fetch: FetchLike = (_url, init) => {
    signals.push(init.signal);
    return new Promise(() => {});
  };
  const { sleep } = fakeSleep();
  const exp = new OtlpExporter({ endpoint: "http://c", fetch, sleep, timeoutMs: 10, maxRetries: 1 });
  await exp.run(fakeJournal(run));
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
  assert.equal(exp.stats.failedPosts, 2);
  assert.equal(exp.stats.droppedBatches, 1);
});

test("permanent 4xx responses are not retried; 408 and 429 are", async () => {
  for (const [status, calls] of [
    [400, 1],
    [401, 1],
    [404, 1],
    [408, 3],
    [429, 3],
    [500, 3],
  ] as const) {
    const f = fakeFetch([{ ok: false, status }]);
    const { sleep } = fakeSleep();
    const exp = new OtlpExporter({ endpoint: "http://c", fetch: f.fetch, sleep, maxRetries: 2 });
    await exp.run(fakeJournal(run));
    assert.equal(f.calls.length, calls, `status ${status}`);
    assert.equal(exp.stats.droppedBatches, 1);
  }
});
