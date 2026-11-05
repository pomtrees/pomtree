// Thin node:http shell over the pure matcher, shapers and plan builder: a
// deterministic model upstream on host loopback for `model.baseUrl`.
//
// Routes (any base path prefix is accepted, so both `http://h:p` and
// `http://h:p/v1` work as the base URL):
//   POST …/chat/completions  OpenAI chat completions, stream and non-stream
//   POST …/messages          Anthropic Messages, stream only
//   GET  …/models            the models named by the script's rules (or "stub-model")

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { planResponse } from "./faults.ts";
import { DEFAULT_FALLBACK, type ModelScript, matchRule, type RecordedCall, type RequestShape, recordUse, replyKind, type Wire } from "./script.ts";
import { shapeAnthropicRequest } from "./wire-anthropic.ts";
import { openAiModels, shapeOpenAiRequest } from "./wire-openai.ts";

/** Request bodies above this are refused with 413 (a runaway prompt is a test bug). */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Characters of the last user text shown on an unmatched line: enough to tell a task from a wake or signal. */
const UNMATCHED_TEXT_CHARS = 120;

/** Every field a rule can test, on one line: the model and the head of the last user text (JSON-quoted, so newlines stay on one line). */
function matchFields(call: RecordedCall): string {
  const text = call.lastUserText === null ? "null" : JSON.stringify(call.lastUserText.slice(0, UNMATCHED_TEXT_CHARS));
  return `model=${call.model} turn=${call.turn} toolResults=${call.toolResults} lastTool=${call.lastTool} agent=${call.agentId} markers=${call.markers.join(",")} lastUser=${text}`;
}

/** The one-line stderr diagnostic for a call no rule matched, so the request a script missed can be compared with its rules. */
export function unmatchedLine(call: RecordedCall): string {
  return `fake model: unmatched ${call.wire} call ${call.index} ${matchFields(call)}`;
}

/** One recorded call for a failure dump: its index, the rule it matched (or UNMATCHED) and the fields rules test. */
export function describeCall(call: RecordedCall): string {
  return `${call.index} ${call.matched ?? "UNMATCHED"} ${matchFields(call)}`;
}

export class FakeModelUpstream {
  readonly baseUrl: string;
  private readonly server: Server;
  private script: ModelScript;
  private used = new Map<string, number>();
  private readonly recorded: RecordedCall[] = [];
  private waiters: { n: number; resolve: () => void }[] = [];

  private constructor(server: Server, script: ModelScript, baseUrl: string) {
    this.server = server;
    this.script = script;
    this.baseUrl = baseUrl;
  }

  static start(opts: { script: ModelScript; host?: string; port?: number }): Promise<FakeModelUpstream> {
    const host = opts.host ?? "127.0.0.1";
    const server = createServer();
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, host, () => {
        server.off("error", reject);
        const { port } = server.address() as AddressInfo;
        const shown = host.includes(":") ? `[${host}]` : host;
        const up = new FakeModelUpstream(server, opts.script, `http://${shown}:${port}/v1`);
        server.on("request", (req, res) => {
          up.handle(req, res).catch(() => res.destroy());
        });
        resolve(up);
      });
    });
  }

  get calls(): readonly RecordedCall[] {
    return this.recorded;
  }

  get unmatched(): readonly RecordedCall[] {
    return this.recorded.filter((c) => c.matched === null);
  }

  /** Replaces the script and resets the per-rule `times` counters; recorded calls are kept. */
  setScript(script: ModelScript): void {
    this.script = script;
    this.used = new Map();
  }

  waitForCalls(n: number, timeoutMs = 10_000): Promise<readonly RecordedCall[]> {
    if (this.recorded.length >= n) return Promise.resolve(this.recorded);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`fake model: waited ${timeoutMs}ms for ${n} calls, saw ${this.recorded.length}`));
      }, timeoutMs);
      const waiter = {
        n,
        resolve: () => {
          clearTimeout(timer);
          resolve(this.recorded);
        },
      };
      this.waiters.push(waiter);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  private record(call: RecordedCall): void {
    this.recorded.push(call);
    if (call.matched === null) process.stderr.write(`${unmatchedLine(call)}\n`);
    const ready = this.waiters.filter((w) => this.recorded.length >= w.n);
    this.waiters = this.waiters.filter((w) => this.recorded.length < w.n);
    for (const w of ready) w.resolve();
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?", 1)[0] ?? "/";
    if (req.method === "GET" && /\/models\/?$/.test(path)) {
      const models = [...new Set(this.script.rules.map((r) => r.when.model).filter((m): m is string => typeof m === "string"))];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(openAiModels(models.length ? models : ["stub-model"])));
      return;
    }
    const wire: Wire | null = /\/chat\/completions\/?$/.test(path) ? "openai-completions" : /\/messages\/?$/.test(path) ? "anthropic-messages" : null;
    if (req.method !== "POST" || wire === null) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `stub: no route ${req.method} ${path}` } }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(c as Buffer);
    }
    let body: unknown = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub: request body is not JSON" } }));
      return;
    }
    const headers = headerMap(req);
    const shape: RequestShape = wire === "openai-completions" ? shapeOpenAiRequest(body, headers) : shapeAnthropicRequest(body, headers);
    const rule = matchRule(this.script, shape, this.used);
    if (rule) recordUse(this.used, rule);
    const reply = rule?.reply ?? this.script.fallback ?? DEFAULT_FALLBACK;
    const index = this.recorded.length;
    this.record({
      ...shape,
      index,
      path,
      matched: rule?.id ?? null,
      replyKind: replyKind(reply),
    });
    const plan = planResponse(reply, {
      wire,
      stream: shape.stream,
      model: shape.model ?? "stub-model",
      id: `stub${index}`,
    });
    if (plan.reset) {
      req.socket.destroy();
      return;
    }
    res.writeHead(plan.status, plan.headers);
    const sent = plan.cutAfter === null ? plan.frames.length : Math.min(plan.cutAfter, plan.frames.length);
    for (const [i, f] of plan.frames.slice(0, sent).entries()) {
      if (i > 0 && plan.chunkDelayMs > 0) await sleep(plan.chunkDelayMs);
      if (res.destroyed) return;
      res.write(f);
    }
    if (plan.cutAfter !== null) {
      // Flush what was written, then drop the connection without a terminating chunk.
      await new Promise<void>((r) => res.write("", () => r()));
      res.destroy();
      return;
    }
    res.end();
  }
}
