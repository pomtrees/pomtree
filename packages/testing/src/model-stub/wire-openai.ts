// OpenAI chat-completions wire: the pure request shaper and response builders.
// Builders return the exact wire text the server writes, so every fault's
// output is unit-testable without a socket.

import { agentIdFrom, markersFrom, type Reply, type RequestShape, type StubUsage } from "./script.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

/** Text of an OpenAI message `content` (string or content-part array). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("");
}

/** Pure: the structural shape of an OpenAI chat-completions request. */
export function shapeOpenAiRequest(body: unknown, headers: Record<string, string | undefined>): RequestShape {
  const b = isObj(body) ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages.filter(isObj) : [];
  const system = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => contentText(m.content))
    .join("\n");
  const toolNameById = new Map<string, string>();
  let turn = 0;
  let toolResults = 0;
  let lastTool: string | null = null;
  let lastUserText: string | null = null;
  for (const m of messages) {
    if (m.role === "assistant") {
      turn++;
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObj(c) || typeof c.id !== "string") continue;
        const fn = isObj(c.function) ? c.function : {};
        if (typeof fn.name === "string") toolNameById.set(c.id, fn.name);
      }
    } else if (m.role === "tool") {
      toolResults++;
      lastTool = (typeof m.tool_call_id === "string" ? toolNameById.get(m.tool_call_id) : undefined) ?? (typeof m.name === "string" ? m.name : null);
    } else if (m.role === "user") {
      lastUserText = contentText(m.content);
    }
  }
  const offeredTools = (Array.isArray(b.tools) ? b.tools : [])
    .map((t) => (isObj(t) && isObj(t.function) && typeof t.function.name === "string" ? t.function.name : null))
    .filter((n): n is string => n !== null);
  const maxTokens = typeof b.max_completion_tokens === "number" ? b.max_completion_tokens : typeof b.max_tokens === "number" ? b.max_tokens : null;
  return {
    wire: "openai-completions",
    model: typeof b.model === "string" ? b.model : null,
    stream: b.stream === true,
    turn,
    toolResults,
    lastTool,
    // The chat-completions wire has no tool-error flag on `role: "tool"` messages.
    // TODO(fake-model): lastToolIsError is always null on this wire; match it on the Anthropic wire (is_error).
    lastToolIsError: null,
    offeredTools,
    agentId: agentIdFrom(system, headers),
    markers: markersFrom(system),
    lastUserText,
    maxTokens,
  };
}

export interface BuildOpts {
  model: string;
  id?: string;
}

/** Default usage when a reply names none: small fixed numbers so settlement math stays exact. */
export const DEFAULT_USAGE: StubUsage = { input: 10, output: 5 };

/** OpenAI usage object. `prompt_tokens` includes cached tokens, as OpenAI reports it. */
function openAiUsage(u: StubUsage): Obj {
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const prompt = u.input + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: {
      cached_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
    ...("cost" in u ? { cost: u.cost } : {}),
  };
}

function argText(a: string | Record<string, unknown>): string {
  return typeof a === "string" ? a : JSON.stringify(a);
}

/** A tool-call argument string that is guaranteed to fail JSON.parse. */
export const MALFORMED_TOOL_ARGS = '{"command": "echo';

export const REFUSAL_TEXT = "I can't help with that.";

interface Plan {
  text?: string;
  refusal?: string;
  calls?: { id: string; name: string; args: string }[];
  finish: string;
  usage: StubUsage | null;
}

/** Pure: what a non-transport reply says (content, calls, finish, usage). */
function plan(reply: Reply, id: string): Plan {
  if (reply.kind === "text")
    return {
      text: reply.text,
      finish: reply.finish ?? "stop",
      usage: reply.usage ?? DEFAULT_USAGE,
    };
  if (reply.kind === "tool_calls")
    return {
      calls: reply.calls.map((c, k) => ({
        id: `call_${id}_${k}`,
        name: c.name,
        args: argText(c.arguments),
      })),
      finish: "tool_calls",
      usage: reply.usage ?? DEFAULT_USAGE,
    };
  const f = reply.fault;
  switch (f.type) {
    case "missing_usage":
      return { text: "no usage follows", finish: "stop", usage: null };
    case "malformed_tool_json":
      return {
        calls: [{ id: `call_${id}_0`, name: f.name, args: MALFORMED_TOOL_ARGS }],
        finish: "tool_calls",
        usage: DEFAULT_USAGE,
      };
    case "empty":
      return { text: "", finish: "stop", usage: { input: 10, output: 0 } };
    case "refusal":
      return {
        refusal: f.text ?? REFUSAL_TEXT,
        finish: "stop",
        usage: DEFAULT_USAGE,
      };
    case "oversize":
      return { text: "x".repeat(f.bytes), finish: "stop", usage: DEFAULT_USAGE };
    case "slow_stream":
      return {
        text: "s".repeat(Math.max(1, f.chunks)),
        finish: "stop",
        usage: DEFAULT_USAGE,
      };
    default:
      // Transport-level faults (status, reset, cut, in-stream error) are realised by the server;
      // their body content is an ordinary short text.
      return { text: "partial", finish: "stop", usage: DEFAULT_USAGE };
  }
}

const frame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
export const DONE_FRAME = "data: [DONE]\n\n";

/**
 * Pure: SSE frames for a reply, ending with the usage chunk (unless
 * `missing_usage`) and `[DONE]`. `in_stream_error` emits one content chunk then
 * an `{error}` frame and no `[DONE]`. `slow_stream` splits text into `chunks`
 * single-character frames (the server paces them). `cut_mid_stream` frames are
 * the normal ones; the server truncates after `afterChunks`.
 */
export function buildOpenAiSse(reply: Reply, opts: BuildOpts): string[] {
  const id = opts.id ?? "stub";
  const base = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: 0,
    model: opts.model,
  };
  const chunk = (delta: Obj, finish: string | null): string => frame({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  if (reply.kind === "fault" && reply.fault.type === "in_stream_error")
    return [chunk({ role: "assistant", content: "partial" }, null), frame({ error: { message: reply.fault.message, type: "server_error" } })];
  if (reply.kind === "fault" && reply.fault.type === "status") throw new Error("status faults have no SSE body; use faultResponse");
  const p = plan(reply, id);
  const out: string[] = [];
  if (p.calls) {
    out.push(
      chunk(
        {
          role: "assistant",
          content: null,
          tool_calls: p.calls.map((c, k) => ({
            index: k,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: "" },
          })),
        },
        null,
      ),
    );
    p.calls.forEach((c, k) => {
      out.push(chunk({ tool_calls: [{ index: k, function: { arguments: c.args } }] }, null));
    });
  } else if (p.refusal !== undefined) {
    out.push(chunk({ role: "assistant", content: null, refusal: p.refusal }, null));
  } else if (reply.kind === "fault" && reply.fault.type === "slow_stream" && p.text) {
    out.push(chunk({ role: "assistant", content: "" }, null));
    for (const ch of p.text) out.push(chunk({ content: ch }, null));
  } else {
    out.push(chunk({ role: "assistant", content: p.text ?? "" }, null));
  }
  out.push(chunk({}, p.finish));
  if (p.usage) out.push(frame({ ...base, choices: [], usage: openAiUsage(p.usage) }));
  out.push(DONE_FRAME);
  return out;
}

/** Pure: the non-stream chat.completion body for a reply. */
export function buildOpenAiJson(reply: Reply, opts: BuildOpts): unknown {
  const id = opts.id ?? "stub";
  if (reply.kind === "fault" && reply.fault.type === "status") throw new Error("status faults have no completion body; use faultResponse");
  if (reply.kind === "fault" && reply.fault.type === "in_stream_error") return { error: { message: reply.fault.message, type: "server_error" } };
  const p = plan(reply, id);
  const message: Obj = { role: "assistant", content: p.text ?? null };
  if (p.refusal !== undefined) message.refusal = p.refusal;
  if (p.calls)
    message.tool_calls = p.calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));
  const out: Obj = {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: 0,
    model: opts.model,
    choices: [{ index: 0, message, finish_reason: p.finish }],
  };
  if (p.usage) out.usage = openAiUsage(p.usage);
  return out;
}

/** Pure: an OpenAI-style error body for a status fault. */
export function openAiErrorBody(status: number, body?: string): string {
  return (
    body ??
    JSON.stringify({
      error: { message: `stub upstream status ${status}`, code: status },
    })
  );
}

/** The models list served at GET /v1/models. */
export function openAiModels(models: string[]): unknown {
  return {
    object: "list",
    data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "stub" })),
  };
}
