import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTraceparent, buildSpans, parseTraceparent, SpanTracker } from "./spans.ts";
import { entry } from "./fixtures.ts";

const run = [
  entry(1, "a", { kind: "spawned" }),
  entry(2, "a", { kind: "tool_call", tool: "bash", callId: "c1", input: { cmd: "ls secret" } }),
  entry(3, "a", { kind: "tool_result", callId: "c1", ok: true, output: "hunter2" }),
  entry(4, "a", { kind: "usage", inputTokens: 10, outputTokens: 5, costMicros: 70 }),
  entry(5, "a", { kind: "yielded" }),
  entry(6, "a", { kind: "resumed" }, { generation: 1 }),
  entry(7, "a", { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 3 }),
  entry(8, "a", { kind: "exited", exit: "succeeded" }, { generation: 1 }),
];

test("agent span with tool child, usage sums, yield/resume counts", () => {
  const [agent, tool, ...rest] = buildSpans(run);
  assert.equal(rest.length, 0);
  assert.equal(agent!.kind, "agent");
  assert.equal(agent!.status, "ok");
  assert.equal(agent!.endTs, 1080);
  assert.equal(agent!.attributes["gen_ai.usage.input_tokens"], 11);
  assert.equal(agent!.attributes["pomtree.cost_micros"], 73);
  assert.equal(agent!.attributes["pomtree.yields"], 1);
  assert.equal(agent!.attributes["pomtree.resumes"], 1);
  assert.equal(agent!.attributes["pomtree.generation"], 1);
  assert.equal(tool!.parentSpanId, agent!.spanId);
  assert.equal(tool!.traceId, agent!.traceId);
  assert.equal(tool!.status, "ok");
  assert.equal(tool!.attributes["gen_ai.tool.name"], "bash");
});

test("usage with unknown cost (null) is counted, not summed as zero", () => {
  const [agent] = buildSpans([
    entry(1, "a", { kind: "spawned" }),
    entry(2, "a", { kind: "usage", inputTokens: 4, outputTokens: 1, costMicros: null }),
    entry(3, "a", { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 9 }),
    entry(4, "a", { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: null }),
  ]);
  assert.equal(agent!.attributes["gen_ai.usage.input_tokens"], 6);
  assert.equal(agent!.attributes["pomtree.cost_micros"], 9);
  assert.equal(agent!.attributes["pomtree.cost_unknown_events"], 2);
  const [known] = buildSpans(run);
  assert.equal(known!.attributes["pomtree.cost_unknown_events"], undefined);
});

test("content is omitted by default and included on opt-in", () => {
  const plain = JSON.stringify(buildSpans(run));
  assert.ok(!plain.includes("secret") && !plain.includes("hunter2"));
  const full = JSON.stringify(buildSpans(run, { includeContent: true }));
  assert.ok(full.includes("secret") && full.includes("hunter2"));
});

test("out-of-order and duplicate delivery give the same spans", () => {
  const shuffled = [run[4]!, run[2]!, run[2]!, run[7]!, run[0]!, run[1]!, run[3]!, run[5]!, run[6]!, run[1]!];
  assert.deepEqual(buildSpans(shuffled), buildSpans(run));
});

test("open agent and open tool span stay open across a yield", () => {
  const spans = buildSpans(run.slice(0, 2).concat(entry(5, "a", { kind: "yielded" })));
  assert.equal(spans[0]!.endTs, null);
  assert.equal(spans[0]!.status, "unset");
  assert.equal(spans[1]!.endTs, null);
});

test("tool open at agent exit is closed as interrupted", () => {
  const spans = buildSpans([entry(1, "a", { kind: "tool_call", tool: "bash", callId: "c", input: {} }), entry(2, "a", { kind: "exited", exit: "cancelled" })]);
  assert.equal(spans[0]!.status, "error");
  assert.equal(spans[1]!.status, "error");
  assert.equal(spans[1]!.endTs, spans[0]!.endTs);
  assert.equal(spans[1]!.attributes["pomtree.interrupted"], true);
});

test("failed tool result marks the span as error", () => {
  const spans = buildSpans([
    entry(1, "a", { kind: "tool_call", tool: "t", callId: "c", input: {} }),
    entry(2, "a", { kind: "tool_result", callId: "c", ok: false, output: "x" }),
  ]);
  assert.equal(spans[1]!.status, "error");
});

test("child spans nest under the parent's span via traceparent", () => {
  const parentTp = agentTraceparent("p");
  const childTp = agentTraceparent("c", parentTp);
  const spans = buildSpans([entry(1, "p", { kind: "spawned" }), entry(2, "c", { kind: "spawned" }, { traceparent: parentTp })]);
  const [p, c] = spans;
  assert.equal(c!.traceId, p!.traceId);
  assert.equal(c!.parentSpanId, p!.spanId);
  assert.equal(parseTraceparent(parentTp)!.spanId, p!.spanId);
  assert.equal(parseTraceparent(childTp)!.traceId, p!.traceId);
  assert.equal(p!.parentSpanId, null);
});

test("SpanTracker hands out spans as they complete and matches the batch build", () => {
  const t = new SpanTracker();
  const completed = run.flatMap((e) => t.apply(e));
  // the tool closes at entry 3, the agent at entry 8; the tool is not re-handed at exit
  assert.deepEqual(
    completed.map((s) => s.kind),
    ["tool", "agent"],
  );
  assert.deepEqual(t.snapshot(), buildSpans(run));
  assert.deepEqual(t.apply(run[2]!), []); // duplicate seq is ignored
});

test("SpanTracker ignores a re-delivered seq and retires the delivered prefix (dedupe itself: seqDedupe.test.ts)", () => {
  const t = new SpanTracker();
  t.apply(entry(2, "a", { kind: "spawned" }));
  t.apply(entry(1, "a", { kind: "spawned" }));
  assert.equal(t.seenSeqCount, 0);
  assert.deepEqual(t.apply(entry(2, "a", { kind: "spawned" })), []);
});

test("a tool_result after the agent's exit still closes its tool (batch and tracker)", () => {
  const late = [
    entry(1, "a", { kind: "tool_call", tool: "bash", callId: "c", input: {} }),
    entry(2, "a", { kind: "exited", exit: "succeeded" }),
    entry(3, "a", { kind: "tool_result", callId: "c", ok: true, output: "x" }),
  ];
  const [, tool] = buildSpans(late);
  assert.equal(tool!.status, "ok");
  assert.equal(tool!.endTs, 1030);
  assert.equal(tool!.attributes["pomtree.interrupted"], undefined);
  const t = new SpanTracker();
  const kinds = late.map((e) => t.apply(e).map((s) => `${s.kind}:${s.status}`));
  assert.deepEqual(kinds, [[], ["agent:ok"], ["tool:ok"]]);
  assert.deepEqual(t.drain(), []);
});

test("SpanTracker holds an open tool at exit and closes it as interrupted on reaped or drain", () => {
  const exited = [entry(1, "a", { kind: "tool_call", tool: "bash", callId: "c", input: {} }), entry(2, "a", { kind: "exited", exit: "cancelled" })];
  const t = new SpanTracker();
  const out = exited.flatMap((e) => t.apply(e));
  assert.deepEqual(
    out.map((s) => s.kind),
    ["agent"],
  );
  const reaped = t.apply(entry(3, "a", { kind: "reaped" }));
  assert.deepEqual(
    reaped.map((s) => s.kind),
    ["tool"],
  );
  assert.equal(reaped[0]!.attributes["pomtree.interrupted"], true);
  assert.equal(reaped[0]!.endTs, out[0]!.endTs);
  assert.deepEqual(t.drain(), []);
  const t2 = new SpanTracker();
  exited.forEach((e) => {
    t2.apply(e);
  });
  const drained = t2.drain();
  assert.deepEqual(
    drained.map((s) => s.kind),
    ["tool"],
  );
  assert.equal(drained[0]!.status, "error");
});

test("SpanTracker.drain hands out open agent spans once, and re-hands a closed one that changed", () => {
  const t = new SpanTracker();
  t.apply(entry(1, "a", { kind: "spawned" }));
  t.apply(entry(2, "a", { kind: "message", role: "assistant", text: "hi" }));
  const first = t.drain();
  assert.deepEqual(
    first.map((s) => [s.kind, s.endTs]),
    [["agent", null]],
  );
  assert.deepEqual(t.drain(), []);
  t.apply(entry(3, "a", { kind: "exited", exit: "succeeded" }));
  t.apply(entry(4, "a", { kind: "usage", inputTokens: 9, outputTokens: 1, costMicros: 2 }));
  const again = t.drain();
  assert.equal(again.length, 1);
  assert.equal(again[0]!.attributes["gen_ai.usage.input_tokens"], 9);
  assert.equal(again[0]!.endTs, 1030);
  assert.deepEqual(t.drain(), []);
});

test("SpanTracker keeps a tool finished before the agent's traceparent on the agent's trace", () => {
  const t = new SpanTracker();
  const parentTp = agentTraceparent("p");
  assert.deepEqual(t.apply(entry(2, "c", { kind: "tool_call", tool: "x", callId: "k", input: {} })), []);
  assert.deepEqual(t.apply(entry(3, "c", { kind: "tool_result", callId: "k", ok: true, output: "" })), []);
  const out = t.apply(entry(1, "c", { kind: "spawned" }, { traceparent: parentTp }));
  assert.deepEqual(
    out.map((s) => s.kind),
    ["tool"],
  );
  assert.equal(out[0]!.traceId, parseTraceparent(parentTp)!.traceId);
  assert.deepEqual(
    t.snapshot().map((s) => s.traceId),
    [out[0]!.traceId, out[0]!.traceId],
  );
});

test("SpanTracker propagates traceparent to spans handed out after it arrives", () => {
  const t = new SpanTracker();
  const parentTp = agentTraceparent("p");
  const none = t.apply(entry(1, "c", { kind: "spawned" }));
  assert.deepEqual(none, []);
  const done = t.apply(entry(2, "c", { kind: "exited", exit: "succeeded" }, { traceparent: parentTp }));
  assert.equal(done[0]!.traceId, parseTraceparent(parentTp)!.traceId);
  assert.equal(done[0]!.parentSpanId, parseTraceparent(parentTp)!.spanId);
});

test("malformed traceparent is ignored", () => {
  const [s] = buildSpans([entry(1, "a", { kind: "spawned" }, { traceparent: "garbage" })]);
  assert.equal(s!.parentSpanId, null);
});
