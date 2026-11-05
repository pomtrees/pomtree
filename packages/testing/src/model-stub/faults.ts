// Pure: turns a reply into a transport plan the server executes verbatim
// (status, headers, body frames, pacing, truncation, reset). Keeping this pure
// means every fault's wire behavior is unit-testable without a socket.

import type { Reply, Wire } from "./script.ts";
import { anthropicErrorBody, buildAnthropicSse } from "./wire-anthropic.ts";
import { buildOpenAiJson, buildOpenAiSse, openAiErrorBody } from "./wire-openai.ts";

export interface ResponsePlan {
  /** Destroy the socket before writing any header. */
  reset: boolean;
  status: number;
  headers: Record<string, string>;
  /** Body pieces written in order (SSE frames, or one JSON string). */
  frames: string[];
  /** Delay before each frame after the first. */
  chunkDelayMs: number;
  /** Destroy the socket after writing this many frames (null: end normally). */
  cutAfter: number | null;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};
const JSON_HEADERS = { "content-type": "application/json" };

export function planResponse(reply: Reply, opts: { wire: Wire; stream: boolean; model: string; id: string }): ResponsePlan {
  const plan: ResponsePlan = {
    reset: false,
    status: 200,
    headers: opts.stream ? { ...SSE_HEADERS } : { ...JSON_HEADERS },
    frames: [],
    chunkDelayMs: 0,
    cutAfter: null,
  };
  if (reply.kind === "fault") {
    const f = reply.fault;
    if (f.type === "reset_before_headers") return { ...plan, reset: true };
    if (f.type === "status") {
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (f.retryAfterS !== undefined) headers["retry-after"] = String(f.retryAfterS);
      return {
        ...plan,
        status: f.status,
        headers,
        frames: [opts.wire === "anthropic-messages" ? anthropicErrorBody(f.status, f.body) : openAiErrorBody(f.status, f.body)],
      };
    }
    if (f.type === "slow_stream") plan.chunkDelayMs = f.chunkDelayMs;
    if (f.type === "cut_mid_stream") plan.cutAfter = f.afterChunks;
  }
  const build = { model: opts.model, id: opts.id };
  if (opts.stream) {
    plan.frames = opts.wire === "anthropic-messages" ? buildAnthropicSse(reply, build) : buildOpenAiSse(reply, build);
  } else if (opts.wire === "anthropic-messages") {
    // TODO(fake-model): non-stream Anthropic Messages bodies are not built; Pi always streams. Served as a 400.
    return {
      ...plan,
      status: 400,
      headers: { ...JSON_HEADERS },
      frames: [anthropicErrorBody(400, '{"type":"error","error":{"type":"invalid_request_error","message":"stub serves only stream:true on /v1/messages"}}')],
    };
  } else {
    const body = JSON.stringify(buildOpenAiJson(reply, build));
    // A non-stream cut is a truncated JSON body.
    plan.frames = plan.cutAfter !== null ? [body.slice(0, Math.floor(body.length / 2))] : [body];
    if (plan.cutAfter !== null) plan.cutAfter = 1;
  }
  return plan;
}
