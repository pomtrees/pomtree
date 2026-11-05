import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { MODEL_BUDGET_REFUSAL_MESSAGE, MODEL_PROXY_CREDENTIAL_EXPIRED, MODEL_PROXY_INVALID_CREDENTIAL, modelRefusalTag } from "@pomtree/core";
import type {
  CredentialCheck,
  GatewayCredential,
  ModelCallErrorClass,
  ModelCallRoute,
  ModelPriceBasis,
  ModelCallUpstream,
  ModelDebitStore,
  RequestReservation,
  ReserveResult,
} from "@pomtree/core";
import { formatAccessLine, oneLine, shouldLog } from "../accesslog.ts";
import type { AccessLogMode, AccessSink } from "../accesslog.ts";
import { callFacts, capOutputTokens, MIN_THINKING_BUDGET_TOKENS, unsupportedRequest } from "./price.ts";
import type { EstimateOutcome, PricedCharge, RequestEstimate } from "./price.ts";
import { refuseMalformedToolCalls } from "./tool-args.ts";
import { checkModelBaseUrl, notFoundHint, scrubBody, statusClass, streamErrored, thrownClass, upstreamMessage } from "./upstream.ts";

export type { ModelDebitStore } from "@pomtree/core";

// The durable debit-store boundary. `reserve` must atomically verify the signed credential,
// reject a durable revocation, and reserve the agent-wide cap; a database implementation must make
// that one transaction. RequestBudget satisfies this shape only for local tests and must not be used
// by main.ts, because its debits and revocations disappear at restart.

// Third argument of the upstream fetch: which agent and request id the call belongs to (equal to the settlement event's).
export interface ProxyFetchContext {
  agent: string;
  requestId: string;
}

export interface ModelProxyOptions {
  // This key is controller-only. It is added only to the upstream request.
  upstream: { baseUrl: string; key: string };
  // `authorize` (the durable store's read-only credential check) yields the credential's model allowlist before anything is
  // reserved, and lets a refused request write nothing. `checkCredential` (read-only too) names why a key was refused, so
  // an expired key answers 401 MODEL_PROXY_CREDENTIAL_EXPIRED; without it every refused key is MODEL_PROXY_INVALID_CREDENTIAL.
  budget: ModelDebitStore & { authorize(key: string): GatewayCredential | null; checkCredential?(key: string): CredentialCheck };
  // Reserved (and, if the response cannot be priced, charged) for a request whose cost `estimate` cannot price: a
  // model missing from the catalog, reserved at least this much (a body with no valid output limit is refused, not
  // reserved). It never rejects a request whose reservation fits the credential's remaining budget (a known model is
  // reserved by its own estimate, clamped to what remains).
  maximumRequestMicros: number;
  // `request` is the request body that produced the response (its `model` selects the catalog rates).
  price: (body: Uint8Array, headers: Headers, request: Uint8Array) => PricedCharge | null;
  // Pessimistic reservation for the body (prompt plus max_tokens at the model's highest output rate) and the
  // minimum remaining budget worth forwarding for; a refusal for a body with no valid
  // output limit (refused with a reason, 400, before anything is reserved), otherwise the body to forward and its
  // estimate (null: reserve the fixed amount, or `unknownBound` for an uncatalogued model). The reservation is clamped
  // to the credential's remaining budget, never refused for its size. Absent, bodies are forwarded as sent with the
  // fixed amount (main.ts always wires it).
  estimate?: (body: Uint8Array, path: string) => EstimateOutcome;
  // How the controller key is presented upstream. Default "bearer" (`authorization: Bearer`); "x-api-key" sends only
  // `x-api-key` (Anthropic); "both" sends the two.
  authStyle?: "bearer" | "x-api-key" | "both";
  // Called as `fetch(url, init, ctx)`; the third argument names the agent and request id of the call so an audited fetch can
  // attribute it. Plain global fetch ignores it.
  fetch?: (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1], ctx?: ProxyFetchContext) => Promise<Response>;
  maxBodyBytes?: number;
  // Idle deadline, not a total one: the response headers must arrive within it, and then each body chunk within it of the
  // last, so a long generation that keeps streaming is never cut. Missing the headers deadline releases the reservation; an
  // idle body after 2xx headers is a stream cut and is charged (see `forward`).
  // A call in flight touches its reservation (ModelDebitStore.touch) when the headers arrive and then at least every half of
  // this value while chunks arrive, so the store's reclaim (2 x this value, idle) never expires a generation still streaming.
  upstreamTimeoutMs?: number;
  // Metered inference paths (relative to the upstream base URL, query ignored) that may be forwarded; anything
  // else is refused with no reservation and no upstream call. Default: DEFAULT_ALLOWED_PATHS.
  allowedPaths?: readonly string[];
  // Request headers (lowercase) forwarded upstream; every other caller header is dropped. Default: DEFAULT_FORWARD_HEADERS.
  forwardHeaders?: readonly string[];
  // Charge policy when a 2xx response carries no usable usage (see `forward`): the micros to charge, from the
  // response and request bodies, or null when it cannot be bounded. The proxy clamps the result to [1, reservation].
  // Absent or null: the whole reservation is charged and the response is withheld (502).
  estimateSettle?: (response: Uint8Array, headers: Headers, request: Uint8Array) => number | null;
  // Ask OpenAI-compatible streaming chat requests for a usage chunk (`stream_options.include_usage`). Default true.
  requestStreamUsage?: boolean;
  // Observes every settlement (priced, estimated, reserve) with how it was charged and the call's metadata; main.ts journals
  // each kind and records the metadata on the debit ledger, and must not throw into the request.
  onSettlement?: (event: ProxySettlement) => void;
  // Called when a request is refused 402 because the agent's remainder is below the minimum a call needs (not for the thinking-budget
  // clamp, which the agent can fix itself). Fires on every such refusal; the consumer dedupes. Must not throw into the request.
  onBudgetStall?: (event: { agent: string; remainingMicros: number | null; floorMicros: number }) => void;
  // Operator warnings (never keys or bodies): the first upstream 404 per route, naming the upstream host and path with a
  // hint. Must not throw into the request. Absent: no warnings.
  warn?: (message: string) => void;
  // The name the operator sets the base URL by, for messages (default the registry key model.baseUrl; pomtreed passes its env name).
  baseUrlName?: string;
}

// How a charge was decided: "priced" from usable usage the response reported; "estimated" from sizes when the 2xx reported none;
// "reserve" the whole reservation (unpriceable and unestimable, or oversize response). `basis` says where the money figure came
// from: for "priced", the provider's own cost (`reported`) or the local rate card applied to reported tokens (`catalog`); an
// "estimated" settlement is `estimated` and a "reserve" one `reserve`. It is present on "priced", "estimated" and "reserve" and
// absent on "failed" (nothing billable was produced, so nothing was priced).
// `upstreamHost`/`upstreamPath` (core ModelCallUpstream) are set once the call was addressed to the upstream, and
// `upstreamMessage` only on a "failed" event whose upstream answered with error text.
export interface ProxySettlement extends ModelCallUpstream {
  agent: string;
  requestId: string;
  kind: "priced" | "estimated" | "reserve" | "failed";
  micros: number;
  model?: string;
  // Audit metadata for the ledger/journal join (never bodies): the upstream status, the call's wall time, and the tokens
  // and finish reason the response reported (absent when it reported none).
  upstreamStatus?: number;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  finishReason?: string;
  // The provider's own id for the response (body or SSE `id`), for joining the harness's usage record to this charge.
  responseId?: string;
  // Closed classes: `route` on every event; `errorClass` on every "failed" one, and on a "reserve" one charged for an
  // unusable 2xx (malformed_response, response_too_large), a priced/estimated/reserve one whose stream reported an error
  // (stream_error), or one whose 2xx body was cut off before it ended (stream_cut), or a priced/estimated one whose tool call
  // the proxy refused for arguments that are not a JSON object (malformed_tool_arguments).
  route?: RouteClass;
  errorClass?: ErrorClass;
  basis?: ModelPriceBasis;
}

// "failed": the upstream call produced nothing billable (non-2xx, redirect, transport error, timeout); charged 0 and
// the reservation released. The classes and their mapping are core's (MODEL_CALL_ERROR_CLASSES; upstream.ts maps them).
export type ErrorClass = ModelCallErrorClass;
export type RouteClass = ModelCallRoute;

// The request path as a closed class, so a journal can say which API surface failed without the raw path or query.
export function routeClass(path: string): RouteClass {
  const p = pathOnly(path).replace(/\/+$/, "");
  if (p.endsWith("/messages")) return "messages";
  if (p.endsWith("/chat/completions")) return "chat_completions";
  return "other";
}

// Inference endpoints that every working provider (OpenAI-compatible, OpenRouter, deepseek, Anthropic) is metered on.
// Bases already end in /v1 for most, so the prefixed form covers bases that do not.
export const DEFAULT_ALLOWED_PATHS: readonly string[] = ["/chat/completions", "/completions", "/responses", "/messages"].flatMap((p) => [p, `/v1${p}`]);
export const DEFAULT_FORWARD_HEADERS: readonly string[] = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"];

// Facts for the access line only: never headers, keys or bodies (the upstream message is the scrubbed, bounded one).
export interface ProxyMeta extends ModelCallUpstream {
  agent?: string;
  model?: string;
  upstreamStatus?: number;
  chargedMicros?: number;
  settlement?: ProxySettlement["kind"];
  errorClass?: ErrorClass;
  basis?: ModelPriceBasis;
}

// The 402 body prefix for a request refused for lack of budget: core's phrase and its refusal tag. The harness and the daemon
// recognise it by the tag (modelRefusalCodeIn), never by the phrase.
export const MODEL_BUDGET_EXHAUSTED = `${MODEL_BUDGET_REFUSAL_MESSAGE} ${modelRefusalTag("model_budget_exhausted")}`;

export type ModelProxyResult = { status: number; headers: Headers; body: Uint8Array } | { status: 400 | 401 | 402 | 409 | 413 | 502; error: string };

// The response header naming the proxy's request id (the settlement's `requestId`), echoed on every answer so the harness
// can join its usage record to the charge.
export const REQUEST_ID_HEADER = "x-pomtree-request-id";

// Access-line facts ride beside a result (not in it), so the result shape callers and tests compare is unchanged.
const metas = new WeakMap<object, ProxyMeta>();
export const proxyMetaOf = (r: ModelProxyResult): ProxyMeta | undefined => metas.get(r);
function tag<T extends ModelProxyResult>(r: T, meta: ProxyMeta): T {
  metas.set(r, meta);
  return r;
}

// An upstream error body is passed to the caller capped, after scrubbing (upstream.ts scrubBody): some providers echo a
// masked or whole key in a 401, so key-shaped substrings and the configured upstream key are removed first.
const MAX_UPSTREAM_ERROR_BYTES = 4096;

// The 409 body for a debit-store refusal that is neither an invalid credential (401) nor the first, sized budget refusal
// (402): a stable message that keeps the store's reason token and says what to do. `budget-exhausted` here is the clamped
// re-reservation losing a race with a concurrent request.
type ConflictReason = Exclude<Extract<ReserveResult, { ok: false }>["reason"], "invalid-credential">;
export const RESERVE_REFUSAL_MESSAGES: Readonly<Record<ConflictReason, string>> = {
  "idempotency-conflict":
    "model request id already used (idempotency-conflict): every model call needs a fresh x-pomtree-request-id header; a retried call must not reuse one",
  "invalid-request":
    "model request refused by the debit store (invalid-request): the x-pomtree-request-id header is empty or over 256 characters, or the reservation is not a valid amount",
  "budget-exhausted":
    "model budget changed while reserving (budget-exhausted): a concurrent call took the remainder; retry with a fresh request id, or raise the budget",
};

// The 401 bodies for a request that lacks the proxy credential or the request id header (checked before the body is read).
export const MISSING_PROXY_CREDENTIAL =
  "missing proxy credential: send the agent's model token as Authorization: Bearer <token> or x-api-key (the staged Pi auth.json holds it)";
export const MISSING_REQUEST_ID = "missing x-pomtree-request-id header: every model call needs a fresh request id (the staged Pi models.json injects it)";

function parseObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    // TextDecoder drops a leading BOM, as the estimate's own parse does.
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The model a body names, shortened for logs (never compared: the allowlist compares the raw `model`).
function requestModel(parsed: Record<string, unknown> | null): string | undefined {
  const m = parsed?.model;
  return typeof m === "string" ? oneLine(m, 80) : undefined;
}

const DEFAULT_MAX_BODY_BYTES = 8 << 20;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

// The caller picks only a path under the configured upstream: no authority, no backslashes, and no
// dot segments, including percent-encoded ones (%2e%2e, %2f) that an upstream or CDN may decode.
// The path without query or fragment.
const pathOnly = (path: string): string => path.split(/[?#]/, 1)[0] ?? "";

function validPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  for (const segment of pathOnly(path).split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false;
  }
  return true;
}

// Keeps the configured base path prefix (`https://api.openai.com/v1` + `/chat/completions`), which
// `new URL(path, base)` would drop.
function upstreamUrl(base: URL, path: string): URL {
  const url = new URL(base.origin + base.pathname.replace(/\/+$/, "") + path);
  if (url.origin !== base.origin) throw new Error("model proxy path escaped the upstream origin");
  return url;
}

// The scoped credential: Authorization Bearer, or x-api-key (what the Anthropic SDK sends).
function credentialOf(headers: IncomingHttpHeaders): string | undefined {
  const bearer = headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return bearer;
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" && apiKey ? apiKey : undefined;
}

// Only allowlisted headers survive; the controller credential is injected separately by `forward`.
function requestHeaders(headers: IncomingHttpHeaders | Headers, allow: ReadonlySet<string>): Headers {
  const out = new Headers();
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, raw] of entries) {
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    if (typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (allow.has(lower)) out.set(name, value);
  }
  return out;
}

// Upstream response headers the agent sees: the body's type, the backoff hint and the provider's request id (for support
// and logs). Everything else is dropped: account facts (openai-organization, openai-project, *-ratelimit-* quotas of the
// operator's account), cookies, hop-by-hop headers, and the encoding and length fetch has already undone.
export const FORWARDED_RESPONSE_HEADERS: readonly string[] = ["content-type", "retry-after", "request-id", "x-request-id"];

function responseHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const v = headers.get(name);
    if (v) out.set(name, v);
  }
  return out;
}

// An upstream body read under the idle deadline: `touch` is called on every chunk (it re-arms the deadline). `bytes` is
// null when the body passed `maxBytes`; `cut` is the error that ended the body early (reset, idle timeout, abort), with
// `bytes` the prefix received before it; `unreadable` marks a body that could not be read at all (no reader).
async function readUpstream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
  touch: () => void,
): Promise<{ bytes: Uint8Array | null; cut?: unknown; unreadable?: true }> {
  if (!body) return { bytes: new Uint8Array() };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (e) {
    return { bytes: new Uint8Array(), cut: e, unreadable: true };
  }
  // A body that ignores the abort signal must still end at the deadline.
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) {
        reader.cancel().catch(() => {});
        return { bytes: null };
      }
      chunks.push(next.value);
      touch();
    }
  } catch (e) {
    reader.cancel(e).catch(() => {});
    return { bytes: concat(chunks, size), cut: e };
  }
  return { bytes: concat(chunks, size) };
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return concat(chunks, size);
}

// Stateless HTTP forwarding around the single-owner debit primitive.
export class ModelProxy {
  private readonly fetch: NonNullable<ModelProxyOptions["fetch"]>;
  readonly maxBodyBytes: number;
  private readonly upstreamTimeoutMs: number;
  private readonly o: ModelProxyOptions;
  private readonly allowedPaths: ReadonlySet<string>;
  readonly forwardHeaders: ReadonlySet<string>;
  private readonly base: URL;
  private readonly baseUrlName: string;
  // Routes whose first upstream 404 has been warned about (an operator-log dedupe only; nothing durable depends on it).
  private readonly warned404 = new Set<RouteClass>();
  private readonly warnedModel = new Set<string>();

  constructor(o: ModelProxyOptions) {
    if (!o.upstream.baseUrl || !o.upstream.key) throw new Error("model proxy upstream baseUrl and key are required");
    this.baseUrlName = o.baseUrlName ?? "model.baseUrl";
    const base = checkModelBaseUrl(o.upstream.baseUrl, this.baseUrlName);
    if (!base.ok) throw new Error(base.error);
    this.base = base.url;
    if (!Number.isSafeInteger(o.maximumRequestMicros) || o.maximumRequestMicros <= 0) throw new Error("maximumRequestMicros must be a positive safe integer");
    this.o = o;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.allowedPaths = new Set(o.allowedPaths ?? DEFAULT_ALLOWED_PATHS);
    this.forwardHeaders = new Set((o.forwardHeaders ?? DEFAULT_FORWARD_HEADERS).map((h) => h.toLowerCase()));
    this.maxBodyBytes = o.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) throw new Error("maxBodyBytes must be a positive safe integer");
    this.upstreamTimeoutMs = o.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.upstreamTimeoutMs) || this.upstreamTimeoutMs <= 0) throw new Error("upstreamTimeoutMs must be a positive safe integer");
  }

  async forward(input: {
    credential: string;
    requestId: string;
    path: string;
    method?: string;
    headers?: Headers;
    body: Uint8Array;
    // The downstream request's lifetime (the HTTP server aborts it with a ClientClosed when the agent's connection closes):
    // aborting it aborts the upstream call at once, released before the 2xx headers and charged as a stream_cut after them.
    signal?: AbortSignal;
  }): Promise<ModelProxyResult> {
    if ((input.method ?? "POST") !== "POST" || !validPath(input.path)) return { status: 400, error: "invalid model proxy request" };
    // Only metered inference endpoints: files, batches, fine-tunes etc. are never forwarded (and never reserved for).
    if (!this.allowedPaths.has(pathOnly(input.path).replace(/\/+$/, ""))) return { status: 400, error: "model proxy path not allowed" };
    if (input.body.length > this.maxBodyBytes) return { status: 413, error: "request body too large" };
    const parsed = parseObject(input.body);
    const model = requestModel(parsed);
    // Request-shape refusals reserve nothing and burn no request id. The credential is checked first, so an invalid one
    // answers 401 as for any other request, and a refusal names the agent for the access log.
    const credential = this.o.budget.authorize(input.credential);
    if (!credential) return this.unauthorized(input.credential);
    const refuse = (error: string, errorClass?: ErrorClass): ModelProxyResult =>
      tag({ status: 400, error }, { agent: credential.agent, ...(model && { model }), chargedMicros: 0, ...(errorClass && { errorClass }) });
    const outcome = this.o.estimate?.(input.body, input.path) ?? { body: input.body, estimate: null };
    if ("refuse" in outcome) return refuse(outcome.refuse);
    const unsupported = parsed ? unsupportedRequest(parsed, input.path) : null;
    if (unsupported) return refuse(unsupported, "unsupported_request");
    const notAllowed = modelRefusal(parsed, credential);
    if (notAllowed) {
      this.warnModel(credential.agent, model, notAllowed);
      return refuse(notAllowed, "model_not_allowed");
    }
    const estimate = this.basisOf(outcome);
    const reserved = this.reserve(input, estimate);
    if ("status" in reserved) return tag(reserved, { ...(model && { model }) });
    // A reservation clamped below the estimate forwards only the output it affords, so the upstream cannot bill past it.
    const capped = capOutputTokens(outcome.body, estimate, reserved.micros);
    if ("thinkingTooSmall" in capped) {
      this.o.budget.cancel(reserved.reservation);
      const { affordable, budgetTokens } = capped.thinkingTooSmall;
      return tag(
        {
          status: 402,
          error: `${MODEL_BUDGET_EXHAUSTED}: the remaining ${reserved.micros} micro-USD affords only ${affordable} output tokens, so max_tokens was clamped to ${affordable}, which leaves no room for thinking.budget_tokens ${budgetTokens} (it must be below max_tokens and at least ${MIN_THINKING_BUDGET_TOKENS}); disable thinking or lower its budget, or raise the agent's budget`,
        },
        { agent: reserved.reservation.agent, ...(model && { model }), chargedMicros: 0 },
      );
    }
    const requestBody = this.o.requestStreamUsage === false ? capped.body : withStreamUsage(input.path, capped.body);
    const agent = reserved.reservation.agent;
    const startedAt = Date.now();

    const route = routeClass(input.path);
    const secrets = [this.o.upstream.key];
    // The final upstream URL. The base was validated at construction and the path by validPath, so this throws only for a
    // path escaping the origin; that is a refused request, never an "upstream unavailable".
    let target: URL;
    try {
      target = upstreamUrl(this.base, input.path);
    } catch {
      this.o.budget.cancel(reserved.reservation);
      return tag({ status: 400, error: "invalid model proxy request" }, { agent, ...(model && { model }), chargedMicros: 0 });
    }
    const where: ModelCallUpstream = { upstreamHost: target.host, upstreamPath: target.pathname };
    const at = `${target.host}${target.pathname}`;
    const failed = (errorClass: ErrorClass, upstreamStatus?: number, message?: string): void => {
      try {
        this.o.onSettlement?.({
          agent,
          requestId: input.requestId,
          kind: "failed",
          micros: 0,
          ...(model && { model }),
          ...(upstreamStatus !== undefined && { upstreamStatus }),
          latencyMs: Date.now() - startedAt,
          route,
          errorClass,
          ...where,
          ...(message !== undefined && { upstreamMessage: message }),
        });
      } catch {
        /* observing must never affect a request */
      }
    };
    const failedMeta = (errorClass: ErrorClass, upstreamStatus?: number): ProxyMeta => ({
      agent,
      ...(model && { model }),
      ...(upstreamStatus !== undefined && { upstreamStatus }),
      chargedMicros: 0,
      errorClass,
      ...where,
    });

    // The idle deadline (upstreamTimeoutMs): armed for the headers, re-armed by every body chunk, never a total deadline.
    const controller = new AbortController();
    const onClientAbort = (): void => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onClientAbort();
    else input.signal?.addEventListener("abort", onClientAbort, { once: true });
    const done = (): void => {
      clearTimeout(idle);
      input.signal?.removeEventListener("abort", onClientAbort);
    };
    const idle = setTimeout(
      () => controller.abort(new DOMException(`no upstream bytes for ${this.upstreamTimeoutMs} ms`, "TimeoutError")),
      this.upstreamTimeoutMs,
    );
    // The store touch is throttled to half the idle deadline (a write per SSE chunk would be one per token).
    let storeTouchedAt = Number.NEGATIVE_INFINITY;
    const touch = (): void => {
      idle.refresh();
      const at = Date.now();
      if (at - storeTouchedAt < this.upstreamTimeoutMs / 2) return;
      storeTouchedAt = at;
      try {
        this.o.budget.touch?.(reserved.reservation);
      } catch {
        /* a failed touch only risks an early fail-closed reclaim, never a free call */
      }
    };

    // From here every exit settles or cancels the reservation. Nothing below may leave it reserved. Before the 2xx headers
    // nothing was generated, so a failure releases it; after them the provider bills, so it is never released.
    let upstream: Response;
    try {
      const headers = requestHeaders(input.headers ?? new Headers(), this.forwardHeaders);
      // The body is re-serialised canonical JSON, whatever the client said it was.
      headers.set("content-type", "application/json");
      const style = this.o.authStyle ?? "bearer";
      if (style !== "x-api-key") headers.set("authorization", `Bearer ${this.o.upstream.key}`);
      if (style !== "bearer") headers.set("x-api-key", this.o.upstream.key);
      upstream = await this.fetch(
        target,
        {
          method: "POST",
          headers,
          body: Buffer.from(requestBody),
          redirect: "manual",
          signal: controller.signal,
        },
        { agent, requestId: input.requestId },
      );
    } catch (e) {
      done();
      this.o.budget.cancel(reserved.reservation);
      const cls = thrownClass(e);
      failed(cls);
      const error =
        e instanceof ClientClosed
          ? `model call cancelled (aborted): ${CLIENT_CLOSED} before ${at} answered; nothing was generated, so the reservation was released`
          : thrownMessage(cls, target, this.upstreamTimeoutMs, this.baseUrlName);
      return tag({ status: 502, error }, failedMeta(cls));
    }
    touch();
    if (upstream.status >= 300 && upstream.status < 400) {
      done();
      await upstream.body?.cancel().catch(() => {});
      this.o.budget.cancel(reserved.reservation);
      failed("redirect", upstream.status);
      return tag(
        {
          status: 502,
          error: `model upstream redirected (redirect, ${upstream.status} from ${at}): the proxy does not follow redirects; set ${this.baseUrlName} to the final URL`,
        },
        failedMeta("redirect", upstream.status),
      );
    }
    const read = await readUpstream(upstream.body, this.maxBodyBytes, controller.signal, touch);
    done();
    const body = read.bytes;
    const meta = (chargedMicros: number, settlement?: ProxySettlement["kind"], errorClass?: ErrorClass, basis?: ModelPriceBasis): ProxyMeta => ({
      agent,
      ...(model && { model }),
      upstreamStatus: upstream.status,
      chargedMicros,
      ...(settlement && { settlement }),
      ...(errorClass && { errorClass }),
      ...(basis && { basis }),
      ...where,
    });
    const note = (kind: ProxySettlement["kind"], micros: number, errorClass?: ErrorClass, basis?: ModelPriceBasis): void => {
      try {
        const facts = body ? callFacts(body, upstream.headers) : {};
        this.o.onSettlement?.({
          agent,
          requestId: input.requestId,
          kind,
          micros,
          ...(model && { model }),
          upstreamStatus: upstream.status,
          latencyMs: Date.now() - startedAt,
          route,
          ...facts,
          ...(errorClass && { errorClass }),
          ...(basis && { basis }),
          ...where,
        });
      } catch {
        /* observing must never affect a request */
      }
    };
    // A non-2xx upstream generated nothing: pass its status and a capped, scrubbed body (what arrived of it, if it was cut)
    // through, charge 0, and release the whole reservation (an oversized error body is dropped, not charged).
    if (!upstream.ok) {
      this.o.budget.cancel(reserved.reservation);
      const cls = statusClass(upstream.status);
      const message = upstreamMessage(body, secrets);
      failed(cls, upstream.status, message);
      if (upstream.status === 404) this.warnNotFound(route, target, input.path, message);
      return tag(
        {
          status: upstream.status,
          headers: responseHeaders(upstream.headers),
          body: scrubBody(body ?? new Uint8Array(), secrets).slice(0, MAX_UPSTREAM_ERROR_BYTES),
        },
        { ...meta(0, undefined, cls), ...(message !== undefined && { upstreamMessage: message }) },
      );
    }
    // A 2xx body that could not be read at all may still have been billed: charge the whole reservation (fail closed).
    if (read.unreadable) {
      this.settleFailClosed(reserved);
      note("reserve", reserved.micros, "malformed_response", "reserve");
      return tag(
        {
          status: 502,
          error: `model upstream response unreadable (malformed_response): the 2xx body from ${at} could not be read; the whole reservation (${reserved.micros} micro-USD) was charged; retry with a fresh request id`,
        },
        meta(reserved.micros, "reserve", "malformed_response", "reserve"),
      );
    }
    if (body === null) {
      this.settleFailClosed(reserved);
      note("reserve", reserved.micros, "response_too_large", "reserve");
      return tag(
        { status: 502, error: `model upstream response too large (response_too_large): over ${this.maxBodyBytes} bytes; the whole reservation was charged` },
        meta(reserved.micros, "reserve", "response_too_large", "reserve"),
      );
    }
    // A 2xx body cut off before it ended (reset, idle deadline, abort) was billed by the provider for what it generated: it is
    // charged from the usage the received bytes report, else estimated from them, else the whole reservation, and answered 502.
    if (read.cut !== undefined) {
      let charged: number | null = null;
      let kind: ProxySettlement["kind"] = "reserve";
      let chargeBasis: ModelPriceBasis = "reserve";
      try {
        const priced = this.o.price(body, upstream.headers, requestBody);
        if (priced !== null && Number.isSafeInteger(priced.micros) && priced.micros >= 0) {
          charged = priced.micros;
          kind = "priced";
          chargeBasis = priced.basis;
        } else {
          const guess = this.o.estimateSettle?.(body, upstream.headers, requestBody);
          if (guess !== null && guess !== undefined && Number.isFinite(guess)) {
            charged = Math.min(reserved.micros, Math.max(1, Math.ceil(guess)));
            kind = "estimated";
            chargeBasis = "estimated";
          }
        }
      } catch {
        /* a throwing pricer or estimator charges the whole reservation (fail closed) */
      }
      if (charged === null) charged = reserved.micros;
      const settled = this.o.budget.settle(reserved.reservation, charged);
      if (!settled.ok)
        return tag(
          { status: 502, error: this.chargeRejected(agent, input.requestId, settled.reason, charged) },
          meta(charged, kind, "stream_cut", chargeBasis),
        );
      note(kind, charged, "stream_cut", chargeBasis);
      const why =
        kind === "priced"
          ? "from the usage the stream reported before the cut"
          : kind === "estimated"
            ? `estimated from the ${body.length} bytes received at the model's highest rates`
            : "the whole reservation, since nothing received could be priced or estimated";
      return tag(
        {
          status: 502,
          error: `model upstream stream cut (stream_cut): the 2xx response from ${at} stopped after ${body.length} bytes because ${cutCause(read.cut, this.upstreamTimeoutMs)}; charged ${charged} micro-USD (${why}), since the provider bills what it generated; retry with a fresh request id`,
        },
        meta(charged, kind, "stream_cut", chargeBasis),
      );
    }
    // TODO(stream-error): a 2xx SSE stream that carries an in-stream error / finish_reason "error" is priced from
    // whatever usage it reported (else fail-closed below) and passed through as a 2xx, not as an upstream error; its
    // settlement carries errorClass "stream_error" so the journal shows it.
    // A completed tool call whose arguments are not a JSON object is answered as a refusal, never run (tool-args.ts); the
    // charge is still priced from the body the upstream produced, and the settlement carries malformed_tool_arguments.
    const rewrite = refuseMalformedToolCalls(body, upstream.headers, route);
    const answer = rewrite?.body ?? body;
    const streamError: ErrorClass | undefined = streamErrored(body, upstream.headers) ? "stream_error" : undefined;
    // The class a returned 2xx carries: a stream error first (the call is suspect as a whole), else a refused tool call.
    const answerClass: ErrorClass | undefined = streamError ?? (rewrite ? "malformed_tool_arguments" : undefined);
    let charged: number | null;
    let basis: ModelPriceBasis | undefined;
    let guess: number | null | undefined;
    try {
      const priced = this.o.price(body, upstream.headers, requestBody);
      charged = priced === null ? null : priced.micros;
      basis = priced?.basis;
      if (charged === null || !Number.isSafeInteger(charged) || charged < 0) guess = this.o.estimateSettle?.(body, upstream.headers, requestBody);
    } catch {
      // A throwing pricer or estimator must not leak the reservation to reclaim: charge it in full now (fail closed).
      this.settleFailClosed(reserved);
      note("reserve", reserved.micros, "malformed_response", "reserve");
      return tag(
        { status: 502, error: "model pricing failed (malformed_response): the upstream 2xx body could not be priced; the whole reservation was charged" },
        meta(reserved.micros, "reserve", "malformed_response", "reserve"),
      );
    }
    if (charged === null || !Number.isSafeInteger(charged) || charged < 0) {
      // POLICY (fail closed, not ruinous): a 2xx without usable usage was billable, so it is never free. When the
      // model's rates are known, charge an ESTIMATE from the request and response sizes (never zero, never above the
      // reservation) and return the response, since it was produced; the settlement is reported as "estimated".
      // Otherwise charge the whole reservation and withhold the response (502), as before.
      if (guess !== null && guess !== undefined && Number.isFinite(guess)) {
        const micros = Math.min(reserved.micros, Math.max(1, Math.ceil(guess)));
        const settled = this.o.budget.settle(reserved.reservation, micros);
        if (!settled.ok)
          return tag(
            { status: 502, error: this.chargeRejected(agent, input.requestId, settled.reason, micros) },
            meta(micros, "estimated", undefined, "estimated"),
          );
        note("estimated", micros, answerClass, "estimated");
        return tag({ status: upstream.status, headers: responseHeaders(upstream.headers), body: answer }, meta(micros, "estimated", answerClass, "estimated"));
      }
      this.settleFailClosed(reserved);
      const cls = streamError ?? "malformed_response";
      note("reserve", reserved.micros, cls, "reserve");
      return tag(
        {
          status: 502,
          error: `upstream 2xx response had no usable usage (${cls}): ${body.length === 0 ? "the body was empty" : "no usage the proxy can price"}; the whole reservation was charged`,
        },
        meta(reserved.micros, "reserve", cls, "reserve"),
      );
    }
    // Real priced usage above the reservation is recorded in full by the store (remaining goes
    // negative and later reservations are refused); the response itself was produced, so return it.
    const settled = this.o.budget.settle(reserved.reservation, charged);
    if (!settled.ok) return tag({ status: 502, error: this.chargeRejected(agent, input.requestId, settled.reason, charged) }, meta(charged));
    note("priced", charged, answerClass, basis);
    return tag({ status: upstream.status, headers: responseHeaders(upstream.headers), body: answer }, meta(charged, "priced", answerClass, basis));
  }

  // The operator warning for the first upstream 404 per route: the host and final path, the upstream's (scrubbed) message
  // and a base-URL hint. Never a key, query or body.
  private warnNotFound(route: RouteClass, target: URL, requestPath: string, message: string | undefined): void {
    if (!this.o.warn || this.warned404.has(route)) return;
    this.warned404.add(route);
    const basePath = this.base.pathname;
    try {
      this.o.warn(
        `pomtreed: WARNING: model upstream answered 404 (not_found) for ${target.host}${target.pathname} (route ${route})${message ? `: ${JSON.stringify(message)}` : ""}; ${notFoundHint(this.baseUrlName, basePath, requestPath)}`,
      );
    } catch {
      /* warning must never affect a request */
    }
  }

  // The 502 body for a settle the debit store refused after the upstream answered, and the operator warning for it: the
  // response is withheld (its cost is not on the ledger), and the store's reason names what to check.
  private chargeRejected(agent: string, requestId: string, reason: string, micros: number): string {
    const message = `model charge rejected (${reason}): the upstream answered but the debit store refused its ${micros} micro-USD charge for request id ${JSON.stringify(oneLine(requestId, 80))}, so the response is withheld; retry with a fresh request id, and if it repeats the operator must check the debit ledger for this agent`;
    try {
      this.o.warn?.(`pomtreed: WARNING: agent ${agent}: ${message}`);
    } catch {
      /* warning must never affect a request */
    }
    return message;
  }

  // The operator warning for a model the agent's credential does not allow, once per agent and model (an operator-log dedupe
  // only, bounded; nothing durable depends on it).
  private warnModel(agent: string, model: string | undefined, refusal: string): void {
    const key = `${agent}\u0000${model ?? ""}`;
    if (!this.o.warn || this.warnedModel.has(key)) return;
    if (this.warnedModel.size >= 1000) this.warnedModel.clear();
    this.warnedModel.add(key);
    try {
      this.o.warn(`pomtreed: WARNING: agent ${agent} was refused a model call: ${refusal}`);
    } catch {
      /* warning must never affect a request */
    }
  }

  // The 401 for a refused credential: MODEL_PROXY_CREDENTIAL_EXPIRED when the store says the key is expired (so the harness
  // knows to issue a fresh one), MODEL_PROXY_INVALID_CREDENTIAL for anything else (invalid, revoked, or no checkCredential).
  // The body is the code alone: nothing about the key, its agent or its expiry.
  private unauthorized(key: string): { status: 401; error: string } {
    const check = this.o.budget.checkCredential?.call(this.o.budget, key);
    return { status: 401, error: check && !check.ok && check.reason === "expired" ? MODEL_PROXY_CREDENTIAL_EXPIRED : MODEL_PROXY_INVALID_CREDENTIAL };
  }

  // Admission is by the credential's remaining budget, not a per-request ceiling: reserve the estimate, or the
  // whole remainder when the estimate exceeds it. `reserve` and the probe run synchronously, so concurrent
  // requests cannot interleave between reading the remainder and reserving it; the store's own accounting sums
  // reservations per agent, so in-flight requests are already subtracted from what remains.
  // The reservation basis for a body: its own estimate; for an uncatalogued model the larger of the catalog bound and
  // the fixed amount (so a budget below the fixed amount is still refused); otherwise the fixed amount for both.
  private basisOf(outcome: { estimate: RequestEstimate | null; unknownBound?: RequestEstimate }): RequestEstimate {
    const fixed = this.o.maximumRequestMicros;
    if (outcome.estimate) return outcome.estimate;
    if (outcome.unknownBound)
      return {
        reserveMicros: Math.max(fixed, outcome.unknownBound.reserveMicros),
        floorMicros: Math.max(fixed, outcome.unknownBound.floorMicros),
        ...(outcome.unknownBound.output && { output: outcome.unknownBound.output }),
      };
    return { reserveMicros: fixed, floorMicros: fixed };
  }

  private reserve(
    input: { credential: string; requestId: string },
    estimate: RequestEstimate,
  ): { reservation: RequestReservation; micros: number } | { status: 401 | 402 | 409; error: string } {
    const wanted = estimate.reserveMicros;
    const floor = estimate.floorMicros;
    const first = this.o.budget.reserve(input.credential, input.requestId, wanted);
    if (first.ok) return { reservation: first.reservation, micros: wanted };
    if (first.reason === "invalid-credential") return this.unauthorized(input.credential);
    if (first.reason !== "budget-exhausted") return { status: 409, error: RESERVE_REFUSAL_MESSAGES[first.reason] };
    // A zero-micro reservation succeeds whenever the remainder is not negative and reports it.
    const probe = this.o.budget.reserve(input.credential, `${input.requestId.slice(0, 200)}:probe`, 0);
    const remaining = probe.ok ? probe.remainingMicros : null;
    if (probe.ok) this.o.budget.cancel(probe.reservation);
    if (remaining === null || remaining < floor) {
      const agent = this.o.budget.authorize(input.credential)?.agent;
      if (agent !== undefined) {
        try {
          this.o.onBudgetStall?.({ agent, remainingMicros: remaining, floorMicros: floor });
        } catch {
          // an observer must never fail the refusal it observes
        }
      }
      return {
        status: 402,
        error: `${MODEL_BUDGET_EXHAUSTED}: ${remaining === null ? "no budget remains" : `${remaining} micro-USD remain`} after in-flight requests, below the ${floor} micro-USD minimum for this request (full requested output estimated at ${wanted > 1e12 ? "more than any budget" : wanted})`,
      };
    }
    const micros = Math.min(wanted, remaining);
    const clamped = this.o.budget.reserve(input.credential, input.requestId, micros);
    if (clamped.ok) return { reservation: clamped.reservation, micros };
    return clamped.reason === "invalid-credential" ? this.unauthorized(input.credential) : { status: 409, error: RESERVE_REFUSAL_MESSAGES[clamped.reason] };
  }

  private settleFailClosed(reserved: { reservation: RequestReservation; micros: number }): void {
    // Charges the whole reservation. This return value is intentionally not surfaced: the caller already gets a
    // generic safe failure.
    this.o.budget.settle(reserved.reservation, reserved.micros);
  }
}

// The 502 body for a thrown upstream call, by class: names the cause, the upstream host and what to check. Never the
// error's own message (it can quote a URL or header).
function thrownMessage(cls: ErrorClass, target: URL, timeoutMs: number, baseUrlName: string): string {
  const at = `${target.host}${target.pathname}`;
  switch (cls) {
    case "dns":
      return `model upstream unreachable (dns): ${target.hostname} did not resolve; check ${baseUrlName} and the host's DNS`;
    case "connect":
      return `model upstream unreachable (connect): ${target.host} refused or reset the connection; check ${baseUrlName} and that the upstream is up`;
    case "tls":
      return `model upstream unreachable (tls): the TLS handshake with ${target.host} failed; check ${baseUrlName}'s scheme and the host's certificate`;
    case "timeout":
      return `model upstream timed out (timeout): no response headers from ${at} within ${timeoutMs} ms; retry later or raise model.upstreamTimeoutMs`;
    case "aborted":
      return `model upstream call aborted (aborted): the call to ${at} was cancelled before it completed; retry`;
    default:
      return `model upstream unavailable (transport): the call to ${at} failed before a response; retry later, and check ${baseUrlName} if it persists`;
  }
}

// The abort reason the HTTP server gives `forward` when the agent's connection closes before the answer was written. Its name
// classes it as `aborted` (thrownClass); the messages name the cause.
const CLIENT_CLOSED = "the agent's client closed the connection";
export class ClientClosed extends Error {
  override name = "AbortError";
  constructor() {
    super(CLIENT_CLOSED);
  }
}

// Why a 2xx body ended early, for the stream_cut message (from the error's class, never its text).
function cutCause(e: unknown, timeoutMs: number): string {
  if (e instanceof ClientClosed) return CLIENT_CLOSED;
  switch (thrownClass(e)) {
    case "timeout":
      return `the upstream sent nothing for ${timeoutMs} ms (idle deadline model.upstreamTimeoutMs)`;
    case "connect":
      return "the upstream reset or closed the connection";
    case "aborted":
      return "the call was aborted";
    default:
      return "the response body failed in transport";
  }
}

// The 400 body for a request whose model the agent's credential does not allow, or null when it is allowed. The model is
// compared exactly; a body naming no model is refused (an upstream may pick an account default the operator never granted).
const MAX_LISTED_MODELS = 10;
function modelRefusal(parsed: Record<string, unknown> | null, credential: GatewayCredential): string | null {
  const allowed: readonly string[] = Array.isArray(credential.models) ? credential.models : [];
  const model = parsed?.model;
  // OpenRouter's fallback list (`models`, with `route`) lets the upstream serve another model than `model`: every entry must
  // be allowed too.
  const fallbacks = parsed?.models;
  if (fallbacks !== undefined) {
    if (!Array.isArray(fallbacks))
      return "model not allowed (model_not_allowed): the fallback list `models` is not a list of model ids; send only `model` (or a list of allowed fallbacks)";
    const bad = fallbacks.find((m) => typeof m !== "string" || !allowed.includes(m));
    if (bad !== undefined)
      return `model not allowed (model_not_allowed): the fallback list \`models\` names ${typeof bad === "string" ? `model ${JSON.stringify(oneLine(bad, 80))}` : "a non-model entry"}, which this agent's credential does not allow; send only \`model\` (or only allowed fallbacks)`;
  }
  if (typeof model === "string" && allowed.includes(model)) return null;
  const shown = allowed.slice(0, MAX_LISTED_MODELS).map((m) => JSON.stringify(oneLine(m, 80)));
  const list =
    allowed.length === 0
      ? "allows no models"
      : `allows only ${shown.join(", ")}${allowed.length > MAX_LISTED_MODELS ? ` (and ${allowed.length - MAX_LISTED_MODELS} more)` : ""}`;
  const asked = typeof model === "string" ? `model ${JSON.stringify(oneLine(model, 80))}` : "a request that names no model";
  return `model not allowed (model_not_allowed): this agent's credential ${list}, not ${asked}; use an allowed model, or have the operator grant the model to the agent's template`;
}

// OpenAI-compatible streaming chat requests only report usage when asked (`stream_options.include_usage`); without
// it the final chunk has none and the call cannot be priced. Only /chat/completions with `stream: true` is changed;
// any other body (or unparseable JSON) is forwarded byte for byte. The injection is OpenAI-shaped and deliberately not applied to
// the Anthropic messages route: that route's documented usage carries `cost` with no request-side opt-in, and the pricer
// (price.ts) already reads it from the merged stream usage.
function withStreamUsage(path: string, body: Uint8Array): Uint8Array {
  if (!/\/chat\/completions\/?$/.test(pathOnly(path))) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
  const request = parsed as Record<string, unknown>;
  if (request.stream !== true) return body;
  const options =
    typeof request.stream_options === "object" && request.stream_options !== null && !Array.isArray(request.stream_options) ? request.stream_options : {};
  if ((options as Record<string, unknown>).include_usage === true) return body;
  return Buffer.from(JSON.stringify({ ...request, stream_options: { ...options, include_usage: true } }));
}

// `accessLog` follows pomtreed's accessLog.mode convention (accesslog.ts); absent means off.
export function createModelProxyServer(proxy: ModelProxy, accessLog?: { mode: AccessLogMode; sink: AccessSink }): Server {
  const server = createServer((req, res) => {
    // No rejection may escape: an unhandled one would drain the whole daemon (main.ts), and a client
    // aborting mid-body is routine.
    res.on("error", () => {});
    handle(proxy, req, res, accessLog).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(400, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "request aborted" }));
      } else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

function reject(res: ServerResponse, status: number, error: string, requestId?: string): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close", ...(requestId && { [REQUEST_ID_HEADER]: requestId }) });
  res.end(JSON.stringify({ error }));
}

// `auth` overrides the access line's derived auth reason (a 401 for a missing request id carries a credential).
function logProxied(
  accessLog: { mode: AccessLogMode; sink: AccessSink } | undefined,
  req: IncomingMessage,
  status: number,
  startedAt: number,
  meta: ProxyMeta | undefined,
  error?: string,
  auth?: { hadCredential: boolean; reason?: string },
): void {
  if (!accessLog || !shouldLog(accessLog.mode, status)) return;
  try {
    accessLog.sink(
      formatAccessLine({
        at: new Date(),
        listener: "model-proxy",
        method: req.method ?? "?",
        url: req.url ?? "/",
        status,
        durationMs: Date.now() - startedAt,
        principal: meta?.agent ? { scope: "agent", agent: meta.agent } : null,
        hadCredential: auth?.hadCredential ?? true,
        ...(auth?.reason !== undefined && { authReason: auth.reason }),
        ...(error !== undefined && { error }),
        ...(meta?.model !== undefined && { model: meta.model }),
        ...(meta?.upstreamStatus !== undefined && { upstreamStatus: meta.upstreamStatus }),
        ...(meta?.chargedMicros !== undefined && { chargedMicros: meta.chargedMicros }),
        ...(meta?.upstreamHost !== undefined && { upstreamHost: meta.upstreamHost }),
        ...(meta?.upstreamPath !== undefined && { upstreamPath: meta.upstreamPath }),
        ...(meta?.errorClass !== undefined && { errorClass: meta.errorClass }),
        ...(meta?.upstreamMessage !== undefined && { upstreamMessage: meta.upstreamMessage }),
      }),
    );
  } catch {
    /* logging must never affect a request */
  }
}

async function handle(proxy: ModelProxy, req: IncomingMessage, res: ServerResponse, accessLog?: { mode: AccessLogMode; sink: AccessSink }): Promise<void> {
  const startedAt = Date.now();
  // Authenticate the shape before reading the body, so an unauthenticated peer cannot make us buffer it.
  const credential = credentialOf(req.headers);
  const requestId = req.headers["x-pomtree-request-id"];
  const refuse = (status: number, error: string, auth?: { hadCredential: boolean; reason?: string }): void => {
    logProxied(accessLog, req, status, startedAt, undefined, error, auth);
    reject(res, status, error, typeof requestId === "string" ? requestId : undefined);
  };
  if (!credential) return refuse(401, MISSING_PROXY_CREDENTIAL, { hadCredential: false });
  if (typeof requestId !== "string" || requestId === "") return refuse(401, MISSING_REQUEST_ID, { hadCredential: true, reason: "missing-request-id" });
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > proxy.maxBodyBytes) return refuse(413, "request body too large");
  const body = await readCapped(req, proxy.maxBodyBytes);
  if (body === null) return refuse(413, "request body too large");
  // The agent going away (pomtree cancel, a killed harness) aborts the upstream call instead of holding the reservation until it ends.
  const client = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) client.abort(new ClientClosed());
  });
  const result = await proxy.forward({
    credential,
    requestId,
    path: req.url ?? "/",
    method: req.method,
    headers: requestHeaders(req.headers, proxy.forwardHeaders),
    body,
    signal: client.signal,
  });
  logProxied(accessLog, req, result.status, startedAt, proxyMetaOf(result), "error" in result ? result.error : undefined);
  if ("error" in result) {
    res.writeHead(result.status, { "content-type": "application/json", [REQUEST_ID_HEADER]: requestId });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }
  res.writeHead(result.status, { ...Object.fromEntries(result.headers), [REQUEST_ID_HEADER]: requestId });
  res.end(result.body);
}
