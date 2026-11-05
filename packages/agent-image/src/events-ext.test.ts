import { test } from "node:test";
import assert from "node:assert/strict";
import { SINK_EVENTS, sinkLine } from "../ext/pomtree-events/events.ts";

test("sinkLine: one JSON line, verbatim fields", () => {
  const ev = { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a b" }] }, isError: false };
  const line = sinkLine(ev)!;
  assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
  assert.deepEqual(JSON.parse(line), ev);
});

test("sinkLine: message_update drops the cumulative message, keeps the delta", () => {
  const ev = { type: "message_update", message: { role: "assistant", content: "big" }, assistantMessageEvent: { type: "text_delta", delta: "x" } };
  assert.deepEqual(JSON.parse(sinkLine(ev)!), { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
});

test("sinkLine: unserializable or untyped events are dropped, never thrown", () => {
  const circ: Record<string, unknown> = { type: "turn_end" };
  circ.self = circ;
  assert.equal(sinkLine(circ), undefined);
  assert.equal(sinkLine(null), undefined);
  assert.equal(sinkLine({ nope: 1 }), undefined);
  assert.equal(sinkLine({ type: "turn_end", n: 1n }), undefined);
});

test("sinkLine: agent_settled's own aborted flag passes through unchanged", () => {
  assert.deepEqual(JSON.parse(sinkLine({ type: "agent_settled", aborted: true })!), { type: "agent_settled", aborted: true });
  assert.deepEqual(JSON.parse(sinkLine({ type: "agent_settled", aborted: false })!), { type: "agent_settled", aborted: false });
  assert.deepEqual(JSON.parse(sinkLine({ type: "agent_settled" })!), { type: "agent_settled" }, "absent stays absent: no synthesis");
});

test("sinkLine: typed (source interactive) input is recorded as user_input; mailbox-injected (extension) and rpc input is not", () => {
  assert.deepEqual(JSON.parse(sinkLine({ type: "input", text: "hello", source: "interactive" })!), { type: "user_input", text: "hello" });
  assert.equal(sinkLine({ type: "input", text: "[pomtree] nudge", source: "extension" }), undefined);
  assert.equal(sinkLine({ type: "input", text: "x", source: "rpc" }), undefined);
  assert.equal(sinkLine({ type: "input", source: "interactive" }), undefined);
  assert.ok(SINK_EVENTS.includes("input"));
});

test("SINK_EVENTS includes agent_settled and the message/tool lifecycle", () => {
  for (const t of ["agent_settled", "message_end", "tool_execution_start", "tool_execution_end", "session_compact_failed"])
    assert.ok(SINK_EVENTS.includes(t), t);
});
