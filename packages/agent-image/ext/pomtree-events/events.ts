// Pure logic for the pomtree-events Pi extension: turns a Pi extension-API event into one JSONL sink line.
// No Pi or fs imports. The sink replaces `--mode json` stdout, which an interactive TTY session no longer provides.

// Container path of the sink file when PTREE_EVENTS_SINK is unset; harness-pi's PI_SINK_PATH must equal it.
export const DEFAULT_SINK_PATH = "/workspace/.pi-session/events.jsonl";

// Extension-API events mirrored to the sink, named exactly as in Pi's JSON mode so harness-pi's normalizer
// reads them unchanged. Checked against the pinned Pi's extension types (PI_VERSION in scripts/build.ts).
// JSON-mode-only records with NO extension event in the pinned Pi: session (header), queue_update, entry_appended,
// compaction_start/end, auto_retry_start/end, summarization_*, thinking_level_changed (known to harness-pi's normalizer; the extension
// API's counterpart is thinking_level_select, mirrored below); `session_compact_failed` stands in for compaction_end.
export const SINK_EVENTS: readonly string[] = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_info_changed",
  "thinking_level_select",
  "session_compact",
  "session_compact_failed",
  "input",
];

// Pi's JSON mode strips the cumulative `message` from message_update; the extension event carries it, so a long
// reply would be rewritten in full on every delta (quadratic). Drop it to match the wire shape.
export function sinkLine(event: unknown): string | undefined {
  try {
    if (typeof event !== "object" || event === null) return undefined;
    const e = event as Record<string, unknown>;
    if (typeof e.type !== "string") return undefined;
    // `agent_settled.aborted` (set by Pi's abort()) passes through unchanged; absent means not aborted.
    // Pi `input` (per the pinned Pi's prompt()): source "interactive" is the TTY user; sendUserMessage (our mailbox
    // extension) arrives with source "extension", "rpc" is the RPC client. Only typed input is recorded, as `user_input`; the
    // `input` handler returns nothing, so Pi continues unchanged.
    if (e.type === "input") {
      if (e.source !== "interactive" || typeof e.text !== "string") return undefined;
      return `${JSON.stringify({ type: "user_input", text: e.text })}\n`;
    }
    if (e.type === "message_update") {
      const { message: _message, ...rest } = e;
      return `${JSON.stringify(rest)}\n`;
    }
    return `${JSON.stringify(e)}\n`;
  } catch {
    return undefined; // circular or otherwise unserializable: drop, never throw into Pi
  }
}
