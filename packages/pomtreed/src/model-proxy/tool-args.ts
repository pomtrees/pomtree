import { modelRefusalTag } from "@pomtree/core";

// Malformed tool-call arguments: a model reply whose completed tool call carries arguments that are not a JSON object (the
// reply was cut or garbled) is never handed to the harness as a runnable call. The proxy rewrites that call's arguments to a
// JSON string literal holding the refusal. Pi fails a cut arguments text itself, but with no tag the harness can read. A JSON string
// is complete, parses on every Pi path, and is never an object, so Pi fails the call before running it (as malformed arguments,
// or failing the tool's object schema) with an isError tool result that quotes the received arguments: the model reads the
// cause and the action, and the harness reads the tag (harness-pi pi-format.ts, tool_execution_end). A string, not a renamed
// call, so the tool keeps its name in the transcript and the replayed history stays valid for the provider. Pi's refusal of
// the rewritten call is verified live on the OpenAI wire (cli scenario 8); the Anthropic wire's rewrite is covered by unit tests.
// Only OpenAI chat completions and Anthropic messages are checked; TODO(responses-tool-args): the OpenAI Responses route
// (`function_call` items) passes through unchecked.

/** The refusal the model reads in place of the arguments of a call to `tool`. */
export function malformedToolArgumentsRefusal(tool: string): string {
  return `${modelRefusalTag("malformed_tool_arguments")} the arguments of this ${tool} tool call were not valid JSON (the reply was cut off or garbled), so pomtree did not run it; re-issue the call with complete arguments`;
}

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

// The lexical repairs pinned Pi applies before giving up (pi-ai repairJson): raw control characters inside strings are
// escaped and a backslash before an invalid escape is doubled. Mirrored so the proxy never refuses a call Pi would run as
// the model meant it; nothing else (no closing of a cut string or object) is repaired.
function repair(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i] as string;
    if (!inString) {
      out += c;
      if (c === '"') inString = true;
      continue;
    }
    if (c === '"') {
      out += c;
      inString = false;
    } else if (c === "\\") {
      const next = json[i + 1];
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(i + 2, i + 6))) {
        out += json.slice(i, i + 6);
        i += 5;
      } else if (next !== undefined && VALID_ESCAPES.has(next)) {
        out += `\\${next}`;
        i += 1;
      } else out += "\\\\";
    } else {
      const code = c.charCodeAt(0);
      out += code <= 0x1f ? `\\u${code.toString(16).padStart(4, "0")}` : c;
    }
  }
  return out;
}

const isPlainObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a finished call's arguments text is runnable: empty (no arguments), or a JSON object, after Pi's lexical repairs. */
export function toolArgumentsValid(text: string): boolean {
  if (text.trim() === "") return true;
  for (const candidate of [text, repair(text)]) {
    try {
      return isPlainObject(JSON.parse(candidate));
    } catch {
      /* try the repaired text, then give up */
    }
  }
  return false;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (isPlainObject(v) ? (v as Obj) : undefined);

/** The rewritten body and the names of the tools whose calls were refused; null when every call's arguments are valid. */
export interface ToolArgsRewrite {
  body: Uint8Array;
  refused: string[];
}

/**
 * Replaces the arguments of every completed tool call that are not a JSON object with the refusal (a JSON string literal), on an
 * OpenAI chat-completions or Anthropic messages response, streamed (SSE: arguments accumulate across deltas and are judged on
 * the whole) or not. Returns null when nothing was refused, so the body passes through byte for byte. Never throws: a body it
 * cannot read is left as it is.
 */
export function refuseMalformedToolCalls(body: Uint8Array, headers: Headers, route: "messages" | "chat_completions" | "other"): ToolArgsRewrite | null {
  if (route === "other" || body.length === 0) return null;
  const text = new TextDecoder().decode(body);
  const sse = (headers.get("content-type") ?? "").includes("text/event-stream") || /^\s*(?:data|event):/m.test(text);
  try {
    const out = sse ? rewriteSse(text, route) : rewriteJson(text, route);
    return out && { body: new TextEncoder().encode(out.text), refused: out.refused };
  } catch {
    return null;
  }
}

function rewriteJson(text: string, route: "messages" | "chat_completions"): { text: string; refused: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const root = obj(parsed);
  if (!root) return null;
  const refused: string[] = [];
  if (route === "chat_completions") {
    for (const choice of Array.isArray(root.choices) ? root.choices : []) {
      const calls = obj(obj(choice)?.message)?.tool_calls;
      for (const call of Array.isArray(calls) ? calls : []) {
        const fn = obj(obj(call)?.function);
        if (!fn || typeof fn.arguments !== "string" || toolArgumentsValid(fn.arguments)) continue;
        const name = typeof fn.name === "string" ? fn.name : "?";
        fn.arguments = JSON.stringify(malformedToolArgumentsRefusal(name));
        refused.push(name);
      }
    }
  } else {
    // A JSON body's `input` is already parsed: only a non-object one is malformed; it becomes the refusal string itself.
    for (const block of Array.isArray(root.content) ? root.content : []) {
      const b = obj(block);
      if (b?.type !== "tool_use" || !("input" in b) || isPlainObject(b.input)) continue;
      const name = typeof b.name === "string" ? b.name : "?";
      b.input = malformedToolArgumentsRefusal(name);
      refused.push(name);
    }
  }
  return refused.length === 0 ? null : { text: JSON.stringify(root), refused };
}

// One SSE event: its raw text (lines without the blank-line separator) and the separator that followed it.
interface SseEvent {
  raw: string;
  sep: string;
  data?: Obj;
  dirty?: boolean;
}

function parseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const re = /\r?\n\r?\n/g;
  let at = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    events.push({ raw: text.slice(at, m.index), sep: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) events.push({ raw: text.slice(at), sep: "" });
  for (const e of events) {
    const data = e.raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (data.length === 0) continue;
    try {
      const v = obj(JSON.parse(data.join("\n")));
      if (v) e.data = v;
    } catch {
      /* [DONE] and other non-JSON payloads stay as they are */
    }
  }
  return events;
}

// A changed event keeps its non-data lines (event:, id:) and carries its payload on one `data:` line.
function serialize(events: readonly SseEvent[]): string {
  return events
    .map((e) => {
      if (!e.dirty || !e.data) return e.raw + e.sep;
      const lines = e.raw.split(/\r?\n/);
      const first = lines.findIndex((l) => l.startsWith("data:"));
      const kept = lines.flatMap((l, i) => (i === first ? [`data: ${JSON.stringify(e.data)}`] : l.startsWith("data:") ? [] : [l]));
      return kept.join("\n") + e.sep;
    })
    .join("");
}

interface Accum {
  name: string;
  args: string;
  // The fragments carrying this call's arguments, in stream order: the holder whose `field` is the text.
  parts: { event: SseEvent; holder: Obj; field: string }[];
}

function rewriteSse(text: string, route: "messages" | "chat_completions"): { text: string; refused: string[] } | null {
  const events = parseEvents(text);
  // Calls still open, by choice and tool index (OpenAI) or content block index (Anthropic); `done` holds the ones whose block stopped.
  const calls = new Map<string, Accum>();
  const done: Accum[] = [];
  const accum = (key: string): Accum => {
    let a = calls.get(key);
    if (!a) {
      a = { name: "?", args: "", parts: [] };
      calls.set(key, a);
    }
    return a;
  };
  for (const e of events) {
    const d = e.data;
    if (!d) continue;
    if (route === "chat_completions") {
      for (const choice of Array.isArray(d.choices) ? d.choices : []) {
        const c = obj(choice);
        const deltaCalls = obj(c?.delta)?.tool_calls;
        for (const call of Array.isArray(deltaCalls) ? deltaCalls : []) {
          const tc = obj(call);
          const fn = obj(tc?.function);
          if (!tc || !fn) continue;
          const a = accum(`${String(c?.index ?? 0)}:${String(tc.index ?? 0)}`);
          if (typeof fn.name === "string" && fn.name !== "") a.name = fn.name;
          if (typeof fn.arguments === "string") {
            a.args += fn.arguments;
            a.parts.push({ event: e, holder: fn, field: "arguments" });
          }
        }
      }
    } else {
      const key = String(d.index ?? 0);
      if (d.type === "content_block_start") {
        const block = obj(d.content_block);
        if (block?.type === "tool_use") accum(key).name = typeof block.name === "string" ? block.name : "?";
      } else if (d.type === "content_block_delta" && calls.has(key)) {
        const delta = obj(d.delta);
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const a = accum(key);
          a.args += delta.partial_json;
          a.parts.push({ event: e, holder: delta, field: "partial_json" });
        }
      } else if (d.type === "content_block_stop" && calls.has(key)) {
        // The call is complete; a later block that reuses the index starts a new one.
        done.push(calls.get(key) as Accum);
        calls.delete(key);
      }
    }
  }
  // A call never closed (OpenAI has no per-call stop; an Anthropic stream that ended early) is judged on what arrived.
  done.push(...calls.values());
  const refused: string[] = [];
  for (const a of done) {
    if (a.parts.length === 0 || toolArgumentsValid(a.args)) continue;
    a.parts.forEach((p, i) => {
      p.holder[p.field] = i === 0 ? JSON.stringify(malformedToolArgumentsRefusal(a.name)) : "";
      p.event.dirty = true;
    });
    refused.push(a.name);
  }
  return refused.length === 0 ? null : { text: serialize(events), refused };
}
