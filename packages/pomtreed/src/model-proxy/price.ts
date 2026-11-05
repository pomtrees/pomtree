// Provider JSON response pricing for the controller-side model proxy. Pure: parse token
// usage out of a provider body and convert it to micros. A finite `usage.cost` from the provider is charged as
// reported; otherwise the tokens (cache-aware) are priced from Pi's own catalog rates for the request's model
// (rates.ts), exactly as Pi's calculateCost would. Any unknown model, malformed, or partial usage shape returns
// null so the proxy settles the whole reservation (fail closed) — never zero, never a partial price.
//
// Streaming providers (Pi sends `stream: true`) answer with an SSE stream of `data:` JSON chunks, so
// the body is not a single JSON document. The pricer therefore detects SSE and mines the chunks for
// the usage block (the final chunk before `data: [DONE]` carries `prompt_tokens`/`completion_tokens`),
// keeping the buffered JSON path for non-streaming responses.

import type { ModelPriceBasis } from "@pomtree/core";
import { chargeMicros, maxInputMicrosPerToken, maxOutputMicrosPerToken } from "./rates.ts";
import type { RatesSource, UsageTokens } from "./rates.ts";

function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Optional token field: absent or null is 0 (as Pi's `||0`/`??`), a present non-count is malformed (undefined).
function optCount(v: unknown): number | undefined {
  if (v === undefined || v === null) return 0;
  return tokenCount(v) ?? undefined;
}

// Pi's usage split from a provider usage object: `input` excludes cache tokens. Anthropic shape
// (`input_tokens`/`output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, 1h share in
// `cache_creation.ephemeral_1h_input_tokens`) or OpenAI shape (`prompt_tokens` includes cached and written tokens:
// `prompt_tokens_details.cached_tokens` | `prompt_cache_hit_tokens` | `cached_tokens` read,
// `prompt_tokens_details.cache_write_tokens` written). A mixed, partial, or malformed shape is null (fail closed).
function usageTokens(usage: Record<string, unknown>): UsageTokens | null {
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  // OpenAI Responses shape: `input_tokens` INCLUDES the cached tokens in `input_tokens_details.cached_tokens` (no write count).
  if (input !== null && output !== null && isObject(usage.input_tokens_details)) {
    const cacheRead = optCount(usage.input_tokens_details.cached_tokens);
    if (cacheRead === undefined || cacheRead > input) return null;
    return { input: input - cacheRead, output, cacheRead, cacheWrite: 0 };
  }
  if (input !== null && output !== null) {
    const cacheRead = optCount(usage.cache_read_input_tokens);
    const cacheWrite = optCount(usage.cache_creation_input_tokens);
    const longWrite = optCount(isObject(usage.cache_creation) ? usage.cache_creation.ephemeral_1h_input_tokens : undefined);
    if (cacheRead === undefined || cacheWrite === undefined || longWrite === undefined || longWrite > cacheWrite) return null;
    return { input, output, cacheRead, cacheWrite, cacheWrite1h: longWrite };
  }
  const prompt = tokenCount(usage.prompt_tokens);
  const completion = tokenCount(usage.completion_tokens);
  if (prompt === null || completion === null) return null;
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cacheRead = optCount(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens);
  const cacheWrite = optCount(details.cache_write_tokens);
  if (cacheRead === undefined || cacheWrite === undefined) return null;
  return { input: Math.max(0, prompt - cacheRead - cacheWrite), output: completion, cacheRead, cacheWrite };
}

// Provider-reported cost (OpenRouter-shaped `usage.cost`, USD) in micros, or null when unreported. Only a
// finite number >= 0 counts (strings are ignored). A reported 0 with nonzero tokens is "unreported" (an
// unpriced model), so the catalog prices it; 0 with zero or absent tokens is a genuine free call.
// TODO(live): OpenRouter documents chat-completions `cost` as "in credits" and does not state the unit on the messages route; this treats it as USD. A live messages-route call that reports a cost would settle it.
function reportedMicros(usage: Record<string, unknown>): number | null {
  const cost = usage.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  if (cost > 0) return Math.ceil(cost * 1_000_000);
  for (const name of ["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens"]) {
    const n = tokenCount(usage[name]);
    if (n !== null && n > 0) return null;
    if (name in usage && n === null && usage[name] !== undefined && usage[name] !== null) return null; // malformed counts are not "zero"
  }
  return 0;
}

// A priced charge and where it came from. The reported-vs-catalog choice is made here, once, and carried; nothing downstream
// recomputes it.
export interface PricedCharge {
  micros: number;
  basis: ModelPriceBasis;
}

function priceUsage(usage: unknown, price: (tokens: UsageTokens) => number | null): PricedCharge | null {
  if (!isObject(usage)) return null;
  const reported = reportedMicros(usage);
  if (reported !== null) return { micros: reported, basis: "reported" };
  const tokens = usageTokens(usage);
  const micros = tokens ? price(tokens) : null;
  return micros === null ? null : { micros, basis: "catalog" };
}

// The `model` a request body names, or null.
function requestModel(request: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(request));
    return isObject(parsed) && typeof parsed.model === "string" && parsed.model ? parsed.model : null;
  } catch {
    return null;
  }
}

// Usage blocks found in an SSE body, in stream order. Lines that are not `data:` JSON objects (event
// comments, `[DONE]`, malformed payloads) are skipped; a stream with no usable usage yields [].
// An Anthropic Messages stream splits its usage: `message_start.message.usage` carries the input side (and cache
// counts) and each `message_delta.usage` the cumulative output (newer versions repeat the input side). Those are
// merged field by field, later events overriding earlier ones (so the last cumulative output_tokens wins, never a
// sum, and a provider `cost` anywhere is kept); a null or undefined field never overrides an earlier value. A typeless
// `data: {"usage":{..}}` chunk after the merge began (OpenRouter's trailing cost chunk) joins the merge too. The merge
// counts only once the stream reached its final usage (a `message_delta`, or a trailing usage chunk) and saw no `error`
// event: a cut-off or errored stream yields no merged usage, so the caller falls back to the byte-size estimate. The
// merge is appended last so it is priced first; the chat-completions top-level `usage` entries before it are unchanged.
// An OpenAI Responses stream reports its usage once, on the terminal `response.completed` (or `response.incomplete` /
// `response.failed`) event's `response.usage`.
const RESPONSES_TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"]);

function mergeUsage(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  const out = { ...into };
  for (const [k, v] of Object.entries(from)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function sseUsages(text: string): unknown[] {
  const usages: unknown[] = [];
  let merged: Record<string, unknown> | null = null;
  let final = false;
  let errored = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]" || payload === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    if (parsed.type === "error") errored = true;
    else if (typeof parsed.type === "string" && RESPONSES_TERMINAL.has(parsed.type) && isObject(parsed.response)) usages.push(parsed.response.usage);
    else if (parsed.type === "message_start" && isObject(parsed.message) && isObject(parsed.message.usage))
      merged = mergeUsage(merged ?? {}, parsed.message.usage);
    else if (parsed.type === "message_delta" && isObject(parsed.usage)) {
      merged = mergeUsage(merged ?? {}, parsed.usage);
      final = true;
    } else if ("usage" in parsed) {
      if (merged && parsed.type === undefined && isObject(parsed.usage)) {
        merged = mergeUsage(merged, parsed.usage);
        final = true;
      } else usages.push(parsed.usage);
    }
  }
  if (merged && final && !errored) usages.push(merged);
  return usages;
}

// What the proxy reserves for a request, from its body and the model's catalog rates. `reserveMicros` is the
// pessimistic cost: the prompt (about 4 bytes per token) plus the largest of max_tokens, max_completion_tokens and
// max_output_tokens, each at the model's highest catalog rate (any tier). `floorMicros` is the least the credential
// must still have for the request to be worth forwarding: the same prompt plus MIN_OUTPUT_TOKENS of output. Pi sends the
// model's whole maximum output as max_tokens, so `reserveMicros` can be large; the proxy then reserves what remains
// of the credential's budget instead (service.ts), and the settlement charges the actual cost.
export interface RequestEstimate {
  reserveMicros: number;
  floorMicros: number;
  // The terms of `reserveMicros`, so a reservation clamped below it can rewrite the output limit to what it affords
  // (capOutputTokens). Absent for a fixed-amount reservation (no rates).
  output?: OutputTerm;
}

export interface OutputTerm {
  promptMicros: number;
  // The highest catalog output rate, and the `n`/`best_of` product the output term was multiplied by.
  microsPerToken: number;
  multiplier: number;
  // The limit fields present in the body (each was a positive integer).
  fields: readonly string[];
}

export const MIN_OUTPUT_TOKENS = 256;
const BYTES_PER_TOKEN = 4;

// The output-limit fields each metered endpoint honours (a field an endpoint ignores is no bound at all there).
// Anthropic /messages: max_tokens. OpenAI Responses: max_output_tokens. Chat completions: max_tokens or
// max_completion_tokens (Pi's compat picks one). The older text /completions endpoint: its own field is max_tokens; max_completion_tokens
// is accepted there too (UNCERTAIN whether every upstream honours it), as is the union for any custom allowed path.
const ALL_LIMIT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
const MULTIPLIER_FIELDS = ["n", "best_of"] as const;

// The endpoint a path names: the path without query or fragment, a trailing slash and a leading /v1.
function endpointOf(path: string): string {
  return (path.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "");
}

// Extra paths (POMTREED_MODEL_PROXY_EXTRA_PATHS) are not in the table above, so they fall through to the all-three-fields
// branch and must carry one of those limit fields. A non-generation endpoint (e.g. /embeddings) therefore has no
// limit to name and is refused unless the operator accepts that.
export function limitFieldsFor(path: string): readonly string[] {
  const p = endpointOf(path);
  if (p === "/messages") return ["max_tokens"];
  if (p === "/responses") return ["max_output_tokens"];
  if (p === "/chat/completions" || p === "/completions") return ["max_tokens", "max_completion_tokens"];
  return ALL_LIMIT_FIELDS;
}

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

// What the proxy does with a metered request body: refuse it with a reason (400, before anything is reserved), or
// forward `body` (the canonical re-serialisation of what was parsed and priced, so a duplicate key or any other parser
// differential cannot make the upstream read a different limit) reserving `estimate`, or the fixed amount when null.
// `unknownBound` is set (with `estimate` null) for a model missing from the catalog when the catalog has a ceiling: the
// caller reserves the larger of that bound and the fixed amount. Without a ceiling, `estimate` null means the fixed amount.
export type EstimateOutcome = { refuse: string } | { body: Uint8Array; estimate: RequestEstimate | null; unknownBound?: RequestEstimate };

// TODO(trace-tool-list): record offered tool names in audit output. Current behavior: tools are only checked for hosted types.
// Nothing in the model proxy keeps the tool names.
// A refusal for a request shape that would bill outside max_tokens (hosted tools, priority tiers), or null. Pi sends only
// function tools and the default tier; Anthropic custom tools carry no type or type "custom".
function refusedFeature(parsed: Record<string, unknown>): string | null {
  if (Array.isArray(parsed.tools))
    for (const tool of parsed.tools)
      if (isObject(tool) && "type" in tool && tool.type !== "function" && tool.type !== "custom")
        return `invalid request: tools[].type ${JSON.stringify(tool.type)} is not allowed (only function or custom; hosted tools bill outside max_tokens)`;
  if ("service_tier" in parsed && parsed.service_tier !== "auto" && parsed.service_tier !== "default")
    return `invalid request: service_tier ${JSON.stringify(parsed.service_tier)} is not allowed (only auto or default)`;
  return null;
}

// Every body on a metered endpoint must be a JSON object naming a valid output limit for that endpoint, whether or not
// the catalog knows the model: a known model is reserved by its priced estimate, an unknown one (estimate null) by the
// caller's fixed amount. The limit field is provider-specific, so the proxy refuses rather than injecting one the
// upstream might ignore. A reservation is capped at the largest safe integer so an absurd limit is clamped to the
// remaining budget (service.ts), not refused as invalid. `n` and `best_of` multiply the output term.
// Real requests nest a handful of levels (messages, content parts, tool schemas); this bound is far above that and below
// where older engines overflow the stack in JSON.stringify.
const MAX_JSON_DEPTH = 1000;

// Iterative, so a hostile depth cannot overflow the stack here.
function jsonDepthExceeds(root: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[root, 1]];
  for (let top = stack.pop(); top; top = stack.pop()) {
    const [value, depth] = top;
    if (typeof value !== "object" || value === null) continue;
    if (depth > limit) return true;
    for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}

// TODO(proxy-gaps): bound or price remaining inputs. Current behavior: prompt sized at BYTES_PER_TOKEN, no remote-input bound.
// Open: beta headers, remote file or image inputs, CJK and emoji under-count, hosted-tool fees, non-default service tiers.
export function createRequestEstimate(rates: RatesSource, provider: string): (body: Uint8Array, path: string) => EstimateOutcome {
  return (body, path) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { refuse: "request body must be a JSON object" };
    }
    if (!isObject(parsed)) return { refuse: "request body must be a JSON object" };
    const fields = limitFieldsFor(path);
    // A key that differs from a limit or multiplier field only in case could be read as that field by a case-insensitive upstream.
    for (const key of Object.keys(parsed)) {
      const lower = key.toLowerCase();
      if (key !== lower && ([...ALL_LIMIT_FIELDS, ...MULTIPLIER_FIELDS] as string[]).includes(lower))
        return { refuse: `invalid request: ambiguous key ${oneLineKey(key)}` };
    }
    let tokens: number | null = null;
    const present: string[] = [];
    for (const name of fields) {
      if (!(name in parsed)) continue;
      const n = positiveInt(parsed[name]);
      if (n === null) return { refuse: `invalid output token limit: ${name} must be a positive integer` };
      tokens = Math.max(tokens ?? 0, n);
      present.push(name);
    }
    if (tokens === null)
      return {
        refuse: `output token limit required for ${path.split(/[?#]/)[0]}: set ${fields.join(" or ")}${endpointOf(path) === "/responses" ? " (a model with compat supportsMaxOutputTokens=false omits it)" : ""}`,
      };
    let multiplier = 1;
    for (const name of MULTIPLIER_FIELDS) {
      if (!(name in parsed)) continue;
      const n = positiveInt(parsed[name]);
      if (n === null) return { refuse: `invalid ${name}: must be a positive integer` };
      multiplier *= n;
    }
    const refused = refusedFeature(parsed);
    if (refused) return { refuse: refused };
    if (jsonDepthExceeds(parsed, MAX_JSON_DEPTH)) return { refuse: "request body is too deeply nested" };
    let canonical: Buffer;
    try {
      canonical = Buffer.from(JSON.stringify(parsed));
    } catch {
      // Backstop for engines whose stringify still overflows the stack below the depth bound: refuse rather than reject the request unanswered.
      return { refuse: "request body is too deeply nested" };
    }
    const model = typeof parsed.model === "string" ? rates.lookup(provider, parsed.model) : null;
    // An unknown model is sized by the catalog-wide ceiling (its real rate is not known), or left to the fixed amount.
    const rate = model
      ? { inputMicrosPerToken: maxInputMicrosPerToken(model), outputMicrosPerToken: maxOutputMicrosPerToken(model) }
      : (rates.ceiling?.() ?? null);
    if (!rate) return { body: canonical, estimate: null };
    const output = rate.outputMicrosPerToken;
    const prompt = Math.ceil((canonical.length / BYTES_PER_TOKEN) * rate.inputMicrosPerToken);
    const cap = (v: number): number => Math.min(Number.MAX_SAFE_INTEGER, v);
    // TODO(proxy-reserve-billing): cap the output reservation. Current behavior: it reserves the request's full output limit.
    // reserveMicros prices that limit (times n and best_of) at the model's highest output rate; no operator-set cap applies.
    const estimate: RequestEstimate = {
      reserveMicros: cap(prompt + Math.ceil(tokens * multiplier * output)),
      floorMicros: cap(prompt + Math.ceil(Math.min(tokens, MIN_OUTPUT_TOKENS) * multiplier * output)),
      output: { promptMicros: prompt, microsPerToken: output, multiplier, fields: present },
    };
    return model ? { body: canonical, estimate } : { body: canonical, estimate: null, unknownBound: estimate };
  };
}

// The body to forward for a reservation of `micros`, below the estimate's own `reserveMicros`: every output limit field is
// lowered to the tokens the reservation affords at the model's highest output rate (never raised), so the upstream cannot
// generate more than was reserved. The prompt term is the same 4-bytes-per-token guess the reservation used, so a prompt
// that tokenizes denser can still overrun by its input share. Unchanged when the estimate has no output term (fixed amount), the
// rate is zero, or nothing needs lowering. `body` is the canonical JSON createRequestEstimate returned.
// Anthropic extended thinking: `thinking.budget_tokens` must be below `max_tokens` and at least this.
export const MIN_THINKING_BUDGET_TOKENS = 1024;

// A lowered limit also lowers an Anthropic `thinking.budget_tokens` to one below it (the upstream refuses a budget at or
// above max_tokens); `thinkingTooSmall` (nothing forwarded) when that would fall under MIN_THINKING_BUDGET_TOKENS.
export type CappedBody = { body: Uint8Array } | { thinkingTooSmall: { affordable: number; budgetTokens: number } };

export function capOutputTokens(body: Uint8Array, estimate: RequestEstimate, micros: number): CappedBody {
  const term = estimate.output;
  if (!term || term.microsPerToken <= 0 || micros >= estimate.reserveMicros) return { body };
  const affordable = Math.max(1, Math.floor((micros - term.promptMicros) / (term.microsPerToken * term.multiplier)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { body };
  }
  if (!isObject(parsed)) return { body };
  let changed = false;
  for (const name of term.fields) {
    const n = positiveInt(parsed[name]);
    if (n !== null && n > affordable) {
      parsed[name] = affordable;
      changed = true;
    }
  }
  if (!changed) return { body };
  const thinking = parsed.thinking;
  const budgetTokens = isObject(thinking) ? positiveInt(thinking.budget_tokens) : null;
  if (isObject(thinking) && budgetTokens !== null && budgetTokens >= affordable) {
    if (affordable - 1 < MIN_THINKING_BUDGET_TOKENS) return { thinkingTooSmall: { affordable, budgetTokens } };
    parsed.thinking = { ...thinking, budget_tokens: affordable - 1 };
  }
  return { body: Buffer.from(JSON.stringify(parsed)) };
}

// A request shape whose cost the proxy cannot see from the body, refused as `unsupported_request` (400, before anything is
// reserved): an OpenAI Responses call run in the background (billed after the proxy has settled) or one pulling server-side
// state (`previous_response_id`, `conversation`, a stored `prompt` template, or an `input` item reference: the stored
// content is billed as input the estimate never saw).
const present = (v: unknown): boolean => v !== undefined && v !== null;

// An `input` item that names a stored item instead of carrying content: `{type: "item_reference", id}`, or a bare `{id}`
// (the type is optional there; a message carries a role, every other item a type).
const isItemReference = (item: unknown): boolean =>
  isObject(item) && (item.type === "item_reference" || (item.type === undefined && item.role === undefined && "id" in item));

export function unsupportedRequest(parsed: Record<string, unknown>, path: string): string | null {
  if (endpointOf(path) !== "/responses") return null;
  for (const [name, bad] of [
    ["background", parsed.background === true],
    ["previous_response_id", present(parsed.previous_response_id)],
    ["conversation", present(parsed.conversation)],
    ["a stored prompt", present(parsed.prompt)],
    ["an input item_reference", Array.isArray(parsed.input) && parsed.input.some(isItemReference)],
  ] as const)
    if (bad)
      return `unsupported model request (unsupported_request): /responses with ${name} is not allowed, because the proxy cannot meter it (it is billed outside the request it sees); send the whole input in each request, in the foreground`;
  return null;
}

function oneLineKey(key: string): string {
  return JSON.stringify(key.slice(0, 40));
}

// Audit facts of a provider response: reported token counts (as the provider counted them: tokensIn is `prompt_tokens`, which
// includes cache tokens, for the OpenAI shape and `input_tokens`, which excludes cache read/write tokens, for the Anthropic shape) and the finish reason. Metadata only: no content is read beyond these fields. Absent fields are omitted.
export interface CallFacts {
  tokensIn?: number;
  tokensOut?: number;
  // Cache tokens, when reported: Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`; OpenAI
  // `prompt_tokens_details.cached_tokens`, Responses `input_tokens_details.cached_tokens` (read only; OpenAI has no write count).
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  finishReason?: string;
  // The provider's own id for the response (chat `id`, Anthropic `message.id`, Responses `response.id`): the first seen.
  responseId?: string;
}

function cacheFacts(usage: Record<string, unknown>, out: CallFacts): void {
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const responses = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const r = tokenCount(usage.cache_read_input_tokens) ?? tokenCount(details.cached_tokens) ?? tokenCount(responses.cached_tokens);
  const w = tokenCount(usage.cache_creation_input_tokens);
  if (r !== null) out.cacheReadTokens = r;
  if (w !== null) out.cacheWriteTokens = w;
}

export function callFacts(body: Uint8Array, headers: Headers): CallFacts {
  const text = new TextDecoder().decode(body);
  const sse = (headers.get("content-type") ?? "").includes("text/event-stream") || /^\s*data:/m.test(text);
  const docs: Record<string, unknown>[] = [];
  if (sse) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const d: unknown = JSON.parse(line.slice("data:".length).trim());
        if (isObject(d)) docs.push(d);
      } catch {
        /* [DONE] and malformed payloads carry no facts */
      }
    }
  } else {
    try {
      const d: unknown = JSON.parse(text);
      if (isObject(d)) docs.push(d);
    } catch {
      /* unparseable: no facts */
    }
  }
  const out: CallFacts = {};
  for (const d of docs) {
    if (out.responseId === undefined) {
      const holder = isObject(d.message) ? d.message : isObject(d.response) ? d.response : d;
      if (typeof holder.id === "string" && holder.id) out.responseId = holder.id.slice(0, 128);
    }
    if (typeof d.type === "string" && RESPONSES_TERMINAL.has(d.type) && isObject(d.response) && isObject(d.response.usage)) {
      const i = tokenCount(d.response.usage.input_tokens);
      const o = tokenCount(d.response.usage.output_tokens);
      if (i !== null) out.tokensIn = i;
      if (o !== null) out.tokensOut = o;
      cacheFacts(d.response.usage, out);
      if (typeof d.response.status === "string" && d.response.status) out.finishReason = d.response.status.slice(0, 64);
    }
    if (d.type === "message_start" && isObject(d.message) && isObject(d.message.usage)) {
      const i = tokenCount(d.message.usage.input_tokens);
      const o = tokenCount(d.message.usage.output_tokens);
      if (i !== null) out.tokensIn = i;
      if (o !== null) out.tokensOut = o;
      cacheFacts(d.message.usage, out);
    }
    if (isObject(d.usage)) {
      const i = tokenCount(d.usage.prompt_tokens) ?? tokenCount(d.usage.input_tokens);
      const o = tokenCount(d.usage.completion_tokens) ?? tokenCount(d.usage.output_tokens);
      if (i !== null) out.tokensIn = i;
      if (o !== null) out.tokensOut = o;
      cacheFacts(d.usage, out);
    }
    const choice = Array.isArray(d.choices) && isObject(d.choices[0]) ? d.choices[0] : undefined;
    const fr = choice?.finish_reason ?? d.stop_reason ?? (isObject(d.delta) ? d.delta.stop_reason : undefined);
    if (typeof fr === "string" && fr) out.finishReason = fr.slice(0, 64);
  }
  return out;
}

// `request` is the request body that produced `body`; its `model` selects the catalog rates.
export function createPrice(rates: RatesSource, provider: string): (body: Uint8Array, headers: Headers, request: Uint8Array) => PricedCharge | null {
  return (body, headers, request) => {
    const modelId = requestModel(request);
    const price = (tokens: UsageTokens): number | null => {
      const model = modelId === null ? null : rates.lookup(provider, modelId);
      return model ? chargeMicros(model, tokens) : null;
    };
    const text = new TextDecoder().decode(body);
    const sse = (headers.get("content-type") ?? "").includes("text/event-stream") || /^\s*data:/m.test(text);
    if (sse) {
      const usages = sseUsages(text);
      for (let i = usages.length - 1; i >= 0; i--) {
        const p = priceUsage(usages[i], price);
        if (p !== null) return p;
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;
    return priceUsage(parsed.usage, price);
  };
}

// Fallback charge for a 2xx whose usage is absent or unparseable (fail closed, never zero): the request body at the
// model's highest input rate plus the output actually seen, at the highest output rate. Output tokens are about 4
// bytes each; an SSE stream counts only the string payload of its chunks (ids, models and framing excluded), so the
// guess errs high but is far below the max_tokens-sized reservation the proxy would otherwise burn. Null for an
// unknown model: the caller then charges the whole reservation. The proxy clamps the result to [1, reservation].
const SSE_NOISE_KEYS = new Set(["id", "model", "object", "type", "role", "created", "finish_reason", "index", "system_fingerprint"]);

function stringBytes(v: unknown, key = ""): number {
  if (SSE_NOISE_KEYS.has(key)) return 0;
  if (typeof v === "string") return Buffer.byteLength(v, "utf8");
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + stringBytes(x), 0);
  if (isObject(v)) return Object.entries(v).reduce((n, [k, x]) => n + stringBytes(x, k), 0);
  return 0;
}

export function createSettleEstimate(rates: RatesSource, provider: string): (body: Uint8Array, headers: Headers, request: Uint8Array) => number | null {
  return (body, headers, request) => {
    const modelId = requestModel(request);
    const model = modelId === null ? null : rates.lookup(provider, modelId);
    if (!model) return null;
    const text = new TextDecoder().decode(body);
    const sse = (headers.get("content-type") ?? "").includes("text/event-stream") || /^\s*data:/m.test(text);
    let outBytes = body.length;
    if (sse) {
      outBytes = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          outBytes += stringBytes(JSON.parse(line.slice("data:".length).trim()));
        } catch {
          /* [DONE] and malformed payloads carry no output */
        }
      }
    }
    const promptMicros = (request.length / BYTES_PER_TOKEN) * maxInputMicrosPerToken(model);
    const outputMicros = (outBytes / BYTES_PER_TOKEN) * maxOutputMicrosPerToken(model);
    return Math.max(1, Math.ceil(promptMicros + outputMicros));
  };
}
