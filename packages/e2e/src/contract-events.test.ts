import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PI_SINK_FILE, PI_SINK_PATH, events } from "@pomtree/harness-pi";
import type { HarnessEvent } from "@pomtree/core";
import { DEFAULT_SINK_PATH, SINK_EVENTS, sinkLine } from "../../agent-image/ext/pomtree-events/events.ts";

// Contract between the pomtree-events Pi extension (writer, agent-image) and harness-pi's normalizer (reader).
// Each sink line is produced by the real sinkLine and read by the real events() normalizer.

// index.ts imports a type from Pi, which is not a dependency of this repo, so it cannot be statically imported
// under tsc here. It is loaded at runtime (type stripping erases the type import) through a computed specifier.
const EXT_INDEX = new URL("../../agent-image/ext/pomtree-events/index.ts", import.meta.url).href;

// One minimal, realistic Pi extension-API event per SINK_EVENTS name.
const SAMPLE: Record<string, Record<string, unknown>> = {
  agent_start: { type: "agent_start" },
  agent_end: { type: "agent_end", messages: [] },
  agent_settled: { type: "agent_settled" },
  turn_start: { type: "turn_start" },
  turn_end: { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] },
  message_start: { type: "message_start", message: { role: "assistant", content: [] } },
  message_update: {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    assistantMessageEvent: { type: "text_delta", delta: "partial" },
  },
  message_end: {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: { input: 3, output: 2, cost: { total: 0.000001 } },
    },
  },
  tool_execution_start: { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
  tool_execution_update: {
    type: "tool_execution_update",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "ls" },
    partialResult: { content: [{ type: "text", text: "a" }] },
  },
  tool_execution_end: {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "a b" }] },
    isError: false,
  },
  session_info_changed: { type: "session_info_changed", name: "run" },
  thinking_level_select: { type: "thinking_level_select", level: "high" },
  session_compact: { type: "session_compact", aborted: false, result: { summary: "s" } },
  session_compact_failed: { type: "session_compact_failed", aborted: false, errorMessage: "model refused" },
  input: { type: "input", text: "hello", source: "interactive" },
};

async function* oneChunk(s: string): AsyncGenerator<string> {
  yield s;
}

// Kinds the real normalizer yields for one sink line (keepOpen, so agent_settled surfaces as `settled`).
async function normalized(line: string): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of events(oneChunk(line), undefined, undefined, true)) out.push(e);
  return out;
}

test("sink path: the extension's default path and file name equal harness-pi's PI_SINK_PATH", () => {
  assert.equal(DEFAULT_SINK_PATH, PI_SINK_PATH);
  assert.equal(PI_SINK_PATH, "/workspace/.pi-session/events.jsonl");
  assert.equal(PI_SINK_PATH.slice(PI_SINK_PATH.lastIndexOf("/") + 1), PI_SINK_FILE);
});

test("SAMPLE covers exactly SINK_EVENTS, so the table below cannot silently skip a name", () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...SINK_EVENTS].sort());
});

// The table: which sink event kinds the real normalizer turns into HarnessEvents, and which it drops.
// Kept kinds assert their exact output kinds. Dropped kinds assert zero output and carry the reason.
const KEPT: Record<string, string[]> = {
  message_end: ["message", "usage"], // the authoritative final message; usage from the same message
  tool_execution_start: ["tool_call"],
  tool_execution_end: ["tool_result"], // the authoritative tool result (tool_execution_update is dropped below)
  session_compact_failed: ["error"], // sink counterpart of compaction_end{errorMessage}; success is not surfaced
  input: ["user_input"], // sinkLine rewrites typed input to user_input; the normalizer keeps it
};

// Dropped on purpose, with the reason from the code:
const DROPPED: Record<string, string> = {
  agent_start: "lifecycle marker; the adapter reads it through onStart, not as a HarnessEvent",
  agent_end: "lifecycle marker; the stream ends on agent_settled, not agent_end",
  turn_start: "turn marker with no HarnessEvent kind",
  turn_end: "turn marker with no HarnessEvent kind; usage comes from message_end",
  message_start: "normalizer ignores deltas and start markers; message_end is authoritative",
  message_update: "deltas are ignored per the message_end comment in normalizeRecord",
  tool_execution_update: "partial tool output; tool_execution_end carries the final result (inferred, no comment in code)",
  session_info_changed: "no HarnessEvent kind for session metadata",
  thinking_level_select: "no HarnessEvent kind for thinking level",
  session_compact: "successful compaction is not surfaced; only failures are (compaction_end comment in normalizeRecord)",
};

test("normalizer kind table: every SINK_EVENTS name is either kept with its kinds or dropped with a reason", async () => {
  assert.deepEqual([...Object.keys(KEPT), ...Object.keys(DROPPED), "agent_settled"].sort(), [...SINK_EVENTS].sort());
  for (const name of SINK_EVENTS) {
    const line = sinkLine(SAMPLE[name]);
    assert.ok(line !== undefined, `${name}: sinkLine dropped the sample`);
    const out = await normalized(line);
    const kinds = out.map((e) => e.kind);
    assert.ok(!kinds.includes("error") || name === "session_compact_failed", `${name}: unexpected error event ${JSON.stringify(out)}`);
    if (name === "agent_settled") assert.deepEqual(kinds, ["settled"], "agent_settled ends the stream via the settled marker");
    else if (name in KEPT) assert.deepEqual(kinds, KEPT[name], `${name}: kept kinds`);
    else assert.deepEqual(out, [], `${name}: expected drop (${DROPPED[name]})`);
  }
});

// The normalizer reports an unknown record type as a protocol-drift error at end of stream.
const driftErrors = (out: HarnessEvent[]) => out.filter((e) => e.kind === "error" && e.message.includes("protocol drift"));

test("sinkLine output is never protocol drift: every sink type is a known normalizer type", async () => {
  for (const name of SINK_EVENTS) {
    const line = sinkLine(SAMPLE[name]);
    assert.ok(line !== undefined);
    assert.deepEqual(driftErrors(await normalized(line)), [], name);
  }
});

// JSON-mode-only record types the normalizer knows and the sink does not mirror. Documented in events.ts.
// thinking_level_changed is known to the normalizer but is not in events.ts's JSON-mode-only list (reported, not asserted).
const JSON_MODE_ONLY = [
  "session",
  "queue_update",
  "entry_appended",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
];

test("JSON-mode-only types are known to the normalizer and not mirrored by the sink", async () => {
  for (const t of JSON_MODE_ONLY) {
    assert.deepEqual(driftErrors(await normalized(`${JSON.stringify({ type: t })}\n`)), [], `${t} must be a known type`);
    assert.ok(!SINK_EVENTS.includes(t), `${t} must not be in SINK_EVENTS`);
  }
  // Negative control: a made-up type is reported as drift, so the check above is not vacuous.
  assert.equal(driftErrors(await normalized('{"type":"not_a_pi_event"}\n')).length, 1);
});

test("registration: the extension subscribes exactly SINK_EVENTS; names outside it are never subscribed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "events-ext-"));
  const sink = join(dir, "events.jsonl");
  const prev = process.env.PTREE_EVENTS_SINK;
  process.env.PTREE_EVENTS_SINK = sink; // read at module load, so set before the dynamic import
  try {
    const mod = (await import(EXT_INDEX)) as { default: (pi: unknown) => void };
    const subscribed = new Map<string, (event: unknown) => unknown>();
    mod.default({
      on: (name: string, handler: (event: unknown) => unknown) => {
        subscribed.set(name, handler);
      },
    });
    assert.deepEqual([...subscribed.keys()].sort(), [...SINK_EVENTS].sort());
    for (const negative of ["session", "queue_update", "not_a_pi_event"]) assert.ok(!subscribed.has(negative), negative);

    const handler = subscribed.get("input");
    assert.ok(handler);
    await handler({ type: "input", text: "hi", source: "interactive" });
    await handler({ type: "input", text: "[pomtree] nudge", source: "extension" });
    assert.equal(readFileSync(sink, "utf8"), '{"type":"user_input","text":"hi"}\n');
  } finally {
    if (prev === undefined) delete process.env.PTREE_EVENTS_SINK;
    else process.env.PTREE_EVENTS_SINK = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
