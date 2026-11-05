import { test } from "node:test";
import assert from "node:assert/strict";
import { otlpValue, toOtlpRequest, toOtlpSpan } from "./otlp.ts";
import { buildSpans } from "./spans.ts";
import { entry } from "./fixtures.ts";

const run = [
  entry(1, "a", { kind: "spawned" }),
  entry(2, "a", { kind: "tool_call", tool: "bash", callId: "c1", input: {} }),
  entry(3, "a", { kind: "tool_result", callId: "c1", ok: true, output: "x" }),
  entry(4, "a", { kind: "usage", inputTokens: 3, outputTokens: 2, costMicros: 5 }),
  entry(5, "a", { kind: "exited", exit: "failed" }),
];

test("maps spans into the OTLP/HTTP JSON envelope", () => {
  const req = toOtlpRequest(buildSpans(run), { "service.name": "pomtree-test" });
  const rs = req.resourceSpans[0]!;
  assert.deepEqual(rs.resource.attributes, [{ key: "service.name", value: { stringValue: "pomtree-test" } }]);
  assert.equal(rs.scopeSpans[0]!.scope.name, "pomtree");
  const [agent, tool, ...rest] = rs.scopeSpans[0]!.spans;
  assert.equal(rest.length, 0);
  assert.equal(agent!.name, "invoke_agent a");
  assert.equal(agent!.kind, 1);
  assert.equal(agent!.parentSpanId, undefined);
  assert.deepEqual(agent!.status, { code: 2 });
  assert.equal(agent!.startTimeUnixNano, "1010000000");
  assert.equal(agent!.endTimeUnixNano, "1050000000");
  assert.deepEqual(agent!.attributes.find((a) => a.key === "gen_ai.usage.input_tokens")!.value, { intValue: "3" });
  assert.deepEqual(agent!.attributes.find((a) => a.key === "pomtree.host")!.value, { stringValue: "h1" });
  assert.deepEqual(tool!.status, { code: 1 });
  assert.equal(tool!.parentSpanId, agent!.spanId);
  assert.equal(tool!.traceId, agent!.traceId);
});

test("open spans omit endTime and map to unset status", () => {
  const [s] = buildSpans([entry(1, "a", { kind: "spawned" })]);
  const o = toOtlpSpan(s!);
  assert.equal(o.endTimeUnixNano, undefined);
  assert.deepEqual(o.status, { code: 0 });
});

test("int64 values are decimal strings and non-finite numbers stay valid JSON", () => {
  assert.deepEqual(otlpValue(7), { intValue: "7" });
  assert.deepEqual(otlpValue(2 ** 60), { intValue: "1152921504606846976" });
  assert.deepEqual(otlpValue(1.5), { doubleValue: 1.5 });
  assert.deepEqual(otlpValue(2 ** 70), { doubleValue: 2 ** 70 });
  for (const n of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(otlpValue(n), { stringValue: String(n) });
    assert.ok(!JSON.stringify(otlpValue(n)).includes("null"));
  }
});

test("a non-finite timestamp never throws while mapping", () => {
  const [s] = buildSpans([entry(1, "a", { kind: "spawned" }, { ts: Number.NaN })]);
  const o = toOtlpSpan(s!);
  assert.equal(o.startTimeUnixNano, "0");
  assert.equal(o.endTimeUnixNano, undefined);
});
