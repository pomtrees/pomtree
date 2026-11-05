// Local stub of an OpenAI/OpenRouter-compatible `POST <base>/chat/completions` endpoint and of an Anthropic-compatible
// `POST <base>/v1/messages` endpoint for the Docker live smoke test.
// It stands in for the upstream model so a real Pi agent (which streams) can run through the key-issuing proxy with no
// network and no real model calls. Every request is recorded before it is answered, whatever its method or path.
// Only POST ...`/chat/completions` or POST ...`/messages` (query string ignored; exactly `servePaths` when given) gets a completion; anything else gets a
// 404 JSON. `respond` scripts each completion, and both wire formats share one completion index.
// Importing this file performs no I/O.
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ALLOWLIST_PROFILE_TOOLS } from "../../packages/agent-image/src/allowlist-profiles.ts";
import { ANALYST_TOOLS } from "../../packages/agent-image/ext/pomtree-analyst/analyst-contract.ts";
import { BROWSER_TOOLS } from "../../packages/agent-image/src/browser-run.ts";

export interface StubRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  // Parsed JSON body, or the raw string when the body is not JSON.
  body: unknown;
}

export type StubReply = { kind: "text"; text: string } | { kind: "tool"; name: string; args: Record<string, unknown> };

interface StubUsage {
  promptTokens: number;
  completionTokens: number;
}

// The tool names a model request declares: Anthropic Messages `tools[].name` or chat-completions `tools[].function.name`; null when the body declares none.
export function declaredToolNames(body: unknown): string[] | null {
  const tools = isObject(body) ? body.tools : undefined;
  if (!Array.isArray(tools)) return null;
  return tools.map((t) => {
    if (!isObject(t)) return "?";
    if (typeof t.name === "string") return t.name;
    return isObject(t.function) && typeof t.function.name === "string" ? t.function.name : "?";
  });
}

// A worker may declare exactly its image allowlist: a bash, read, write or edit tool, a missing tool or a duplicate is a violation.
function toolViolation(body: unknown, allowed: readonly string[]): string | null {
  const names = declaredToolNames(body);
  if (names === null) return "the request declares no tools";
  const want = [...allowed].sort().join(",");
  return [...names].sort().join(",") === want ? null : `declared tools [${names.join(", ")}] differ from the allowlist [${allowed.join(", ")}]`;
}
export const browserToolViolation = (body: unknown): string | null => toolViolation(body, BROWSER_TOOLS);
// The analyst declares exactly ANALYST_TOOLS (TODO(analyst-allowlist)).
export const analystToolViolation = (body: unknown): string | null => toolViolation(body, ANALYST_TOOLS);
// A `browse` template's worker declares exactly the profile's web_fetch.
export const browseToolViolation = (body: unknown): string | null => toolViolation(body, ALLOWLIST_PROFILE_TOOLS.browse.tools);

// The offline stand-in for the worker's tool registry: only BROWSER_TOOLS exist, so a bash `pomtree result` finish is rejected like Pi would.
export function dispatchBrowserWorkerTool(name: string): { ok: boolean; text: string } {
  return (BROWSER_TOOLS as readonly string[]).includes(name) ? { ok: true, text: "ok" } : { ok: false, text: `Tool ${name} not found` };
}

export interface ModelStub {
  port: number;
  // http://127.0.0.1:<port>/api/v1
  baseUrl: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

export async function startModelStub(o: {
  respond(req: StubRequest, index: number): StubReply;
  usage?: StubUsage;
  host?: string;
  // Exact request pathnames (query ignored) that get a completion; any other path is a 404. Default: any path ending in /chat/completions or /messages.
  servePaths?: readonly string[];
}): Promise<ModelStub> {
  const usage = o.usage ?? { promptTokens: 120, completionTokens: 40 };
  const host = o.host ?? "127.0.0.1";
  const requests: StubRequest[] = [];
  let completions = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: { message: errorMessage(err) } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const record: StubRequest = {
      url: req.url ?? "",
      method: req.method ?? "",
      headers: req.headers,
      body: parseBody(raw),
    };
    requests.push(record);

    const path = new URL(record.url, "http://stub").pathname;
    const served = o.servePaths === undefined || o.servePaths.includes(path);
    const openai = served && path.endsWith("/chat/completions");
    const anthropic = served && path.endsWith("/messages");
    if (record.method !== "POST" || !(openai || anthropic)) {
      sendJson(res, 404, { error: { message: `no route for ${record.method} ${path}` } });
      return;
    }

    const index = completions;
    completions += 1;
    let reply: StubReply;
    try {
      reply = o.respond(record, index);
    } catch (err) {
      sendJson(res, 500, { error: { message: errorMessage(err) } });
      return;
    }

    const body = isObject(record.body) ? record.body : {};
    const model = typeof body.model === "string" ? body.model : "stub-model";
    if (anthropic) {
      answerAnthropic(res, { reply, index, model, streaming: body.stream === true, usage });
      return;
    }
    const id = `chatcmpl-stub-${index}`;
    const created = Math.floor(Date.now() / 1000);
    const callId = `call_stub_${index}`;
    const usageBlock = {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    };
    const finish = reply.kind === "text" ? "stop" : "tool_calls";

    if (body.stream !== true) {
      const message =
        reply.kind === "text"
          ? { role: "assistant", content: reply.text }
          : {
              role: "assistant",
              content: null,
              tool_calls: [{ id: callId, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }],
            };
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: usageBlock,
      });
      return;
    }

    const base = { id, object: "chat.completion.chunk", created, model };
    const send = (chunk: unknown) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    if (reply.kind === "text") {
      for (const piece of halve(reply.text)) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
    } else {
      const [first, second] = halve(JSON.stringify(reply.args));
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: callId, type: "function", function: { name: reply.name, arguments: first } }],
            },
            finish_reason: null,
          },
        ],
      });
      send({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: second } }] }, finish_reason: null }],
      });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    send({ ...base, choices: [], usage: usageBlock });
    res.end("data: [DONE]\n\n");
  }

  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://${host}:${port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

interface AnthropicTurn {
  reply: StubReply;
  index: number;
  model: string;
  streaming: boolean;
  usage: StubUsage;
}

// Anthropic Messages API wire format: a JSON message, or SSE with a named `event:` line per frame.
function answerAnthropic(res: ServerResponse, t: AnthropicTurn): void {
  const id = `msg_stub_${t.index}`;
  const toolId = `toolu_stub_${t.index}`;
  const stopReason = t.reply.kind === "text" ? "end_turn" : "tool_use";
  const inputTokens = t.usage.promptTokens;
  const outputTokens = t.usage.completionTokens;

  if (!t.streaming) {
    const content =
      t.reply.kind === "text" ? [{ type: "text", text: t.reply.text }] : [{ type: "tool_use", id: toolId, name: t.reply.name, input: t.reply.args }];
    sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model: t.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    return;
  }

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: t.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  if (t.reply.kind === "text") {
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const piece of halve(t.reply.text)) {
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
    }
  } else {
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: toolId, name: t.reply.name, input: {} },
    });
    for (const piece of halve(JSON.stringify(t.reply.args))) {
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: piece } });
    }
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    // The final delta carries cumulative input and output counts (the proxy prices a stream from top-level `usage` objects only).
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// Always two pieces (the first may be empty for a one-character input) so streamed text is genuinely split.
function halve(s: string): [string, string] {
  const mid = Math.floor(s.length / 2);
  return [s.slice(0, mid), s.slice(mid)];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
