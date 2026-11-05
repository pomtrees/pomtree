// Anthropic Messages wire: the pure request shaper and SSE builder.

import { agentIdFrom, markersFrom, type Reply, type RequestShape, type StubUsage } from "./script.ts";
import { type BuildOpts, DEFAULT_USAGE, MALFORMED_TOOL_ARGS, REFUSAL_TEXT } from "./wire-openai.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

function blocks(content: unknown): Obj[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isObj) : [];
}

const textOf = (content: unknown): string =>
  blocks(content)
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");

/** Pure: the structural shape of an Anthropic Messages request. */
export function shapeAnthropicRequest(body: unknown, headers: Record<string, string | undefined>): RequestShape {
  const b = isObj(body) ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages.filter(isObj) : [];
  const system = textOf(b.system);
  const toolNameById = new Map<string, string>();
  let turn = 0;
  let toolResults = 0;
  let lastTool: string | null = null;
  let lastToolIsError: boolean | null = null;
  let lastUserText: string | null = null;
  for (const m of messages) {
    if (m.role === "assistant") {
      turn++;
      for (const c of blocks(m.content)) if (c.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") toolNameById.set(c.id, c.name);
    } else if (m.role === "user") {
      let text = "";
      for (const c of blocks(m.content)) {
        if (c.type === "tool_result") {
          toolResults++;
          lastTool = typeof c.tool_use_id === "string" ? (toolNameById.get(c.tool_use_id) ?? null) : null;
          lastToolIsError = c.is_error === true;
        } else if (c.type === "text" && typeof c.text === "string") {
          text += c.text;
        }
      }
      if (text !== "") lastUserText = text;
    }
  }
  const offeredTools = (Array.isArray(b.tools) ? b.tools : [])
    .map((t) => (isObj(t) && typeof t.name === "string" ? t.name : null))
    .filter((n): n is string => n !== null);
  return {
    wire: "anthropic-messages",
    model: typeof b.model === "string" ? b.model : null,
    stream: b.stream === true,
    turn,
    toolResults,
    lastTool,
    lastToolIsError,
    offeredTools,
    agentId: agentIdFrom(system, headers),
    markers: markersFrom(system),
    lastUserText,
    maxTokens: typeof b.max_tokens === "number" ? b.max_tokens : null,
  };
}

const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function usageStart(u: StubUsage | null): Obj {
  return {
    input_tokens: u?.input ?? 0,
    output_tokens: 1,
    cache_read_input_tokens: u?.cacheRead ?? 0,
    cache_creation_input_tokens: u?.cacheWrite ?? 0,
    // The consumer (price.ts `mergeUsage`) drops a null or undefined field in its message_start/message_delta merge, so a scripted `cost: null` does not survive on this wire while it does on the OpenAI wire.
    ...(u && "cost" in u ? { cost: u.cost } : {}),
  };
}

/**
 * Pure: Anthropic SSE events for a reply. Usage is reported as Anthropic does:
 * input and cache tokens on `message_start`, output tokens on `message_delta`.
 * `missing_usage` omits the `usage` field from both.
 */
export function buildAnthropicSse(reply: Reply, opts: BuildOpts): string[] {
  const id = opts.id ?? "stub";
  if (reply.kind === "fault" && reply.fault.type === "status") throw new Error("status faults have no SSE body; use faultResponse");
  let usage: StubUsage | null = DEFAULT_USAGE;
  let stop = "end_turn";
  const content: ({ text: string } | { name: string; args: string })[] = [];
  if (reply.kind === "text") {
    usage = reply.usage ?? DEFAULT_USAGE;
    stop = reply.finish === "length" ? "max_tokens" : "end_turn";
    content.push({ text: reply.text });
  } else if (reply.kind === "tool_calls") {
    usage = reply.usage ?? DEFAULT_USAGE;
    stop = "tool_use";
    for (const c of reply.calls)
      content.push({
        name: c.name,
        args: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
      });
  } else {
    const f = reply.fault;
    if (f.type === "missing_usage") {
      usage = null;
      content.push({ text: "no usage follows" });
    } else if (f.type === "malformed_tool_json") {
      stop = "tool_use";
      content.push({ name: f.name, args: MALFORMED_TOOL_ARGS });
    } else if (f.type === "empty") {
      usage = { input: 10, output: 0 };
    } else if (f.type === "refusal") {
      stop = "refusal";
      content.push({ text: f.text ?? REFUSAL_TEXT });
    } else if (f.type === "oversize") {
      content.push({ text: "x".repeat(f.bytes) });
    } else if (f.type === "slow_stream") {
      content.push({ text: "s".repeat(Math.max(1, f.chunks)) });
    } else {
      content.push({ text: "partial" });
    }
  }
  const startUsage = usageStart(usage);
  const out: string[] = [
    event("message_start", {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        model: opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        ...(usage ? { usage: startUsage } : {}),
      },
    }),
  ];
  content.forEach((c, index) => {
    if ("text" in c) {
      out.push(
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      const pieces = reply.kind === "fault" && reply.fault.type === "slow_stream" ? [...c.text] : [c.text];
      for (const p of pieces)
        out.push(
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: p },
          }),
        );
    } else {
      out.push(
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: `toolu_${id}_${index}`,
            name: c.name,
            input: {},
          },
        }),
        event("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: c.args },
        }),
      );
    }
    out.push(event("content_block_stop", { type: "content_block_stop", index }));
    if (reply.kind === "fault" && reply.fault.type === "in_stream_error" && index === 0)
      out.push(
        event("error", {
          type: "error",
          error: { type: "api_error", message: reply.fault.message },
        }),
      );
  });
  if (reply.kind === "fault" && reply.fault.type === "in_stream_error") return out.slice(0, out.findIndex((f) => f.startsWith("event: error")) + 1);
  out.push(
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      ...(usage ? { usage: { output_tokens: usage.output } } : {}),
    }),
    event("message_stop", { type: "message_stop" }),
  );
  return out;
}

/** Pure: an Anthropic-style error body for a status fault. */
export function anthropicErrorBody(status: number, body?: string): string {
  return (
    body ??
    JSON.stringify({
      type: "error",
      error: {
        type: status === 429 ? "rate_limit_error" : "api_error",
        message: `stub upstream status ${status}`,
      },
    })
  );
}
