// Pure upstream-facing decisions of the model proxy: the configured base URL's validation and display, the error class of a
// failed call, the scrubbing of upstream error text, and the operator hint for a 404. No fs, sockets or logging.
import type { ModelCallErrorClass } from "@pomtree/core";
import { isLoopbackHost } from "../config.ts";

// The base URL check shared by config resolution (daemon-config.ts) and the proxy constructor: parseable, http or https (plain http only to a loopback host, so the
// upstream key never crosses a network in cleartext), no credentials, query or fragment. The refusal never echoes the raw value (it may carry a key); a parseable URL without
// credentials is shown as scheme://host/basePath.
export function checkModelBaseUrl(raw: string, name: string): { ok: true; url: URL; display: string } | { ok: false; error: string } {
  const expect = "expected http(s)://host[/basePath] with no query, fragment or credentials, e.g. https://openrouter.ai/api/v1";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `invalid ${name}: not a parseable URL; ${expect}` };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, error: `invalid ${name}: it carries credentials (user:password@); ${expect}` };
  const shown = describeUpstream(url);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, error: `invalid ${name}: scheme ${url.protocol.replace(/:$/, "")} is not http or https (${shown}); ${expect}` };
  // URL keeps the brackets of an IPv6 literal; the loopback check wants the bare address.
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname.replace(/^\[(.*)\]$/, "$1")))
    return {
      ok: false,
      error: `invalid ${name}: plain http to non-loopback ${url.hostname} (${shown}) would send the upstream API key in cleartext; use an https:// URL or a loopback address (localhost, 127.0.0.1, ::1); ${expect}`,
    };
  if (url.search !== "" || raw.includes("?")) return { ok: false, error: `invalid ${name}: it has a query string (${shown}); ${expect}` };
  if (url.hash !== "" || raw.includes("#")) return { ok: false, error: `invalid ${name}: it has a fragment (${shown}); ${expect}` };
  return { ok: true, url, display: shown };
}

// scheme://host/basePath, no trailing slash, no credentials or query.
export const describeUpstream = (url: URL): string => `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;

// The class of a non-2xx upstream status.
export function statusClass(status: number): ModelCallErrorClass {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 402) return "insufficient_funds";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 413 || status === 422) return "bad_request";
  return status >= 500 ? "upstream_5xx" : "upstream_4xx";
}

const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|HOSTNAME_MISMATCH)/;

function codeClass(code: string): ModelCallErrorClass | undefined {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME" || code === "EAI_FAIL") return "dns";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"].includes(code)) return "connect";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return "timeout";
  if (TLS_CODE.test(code)) return "tls";
  return undefined;
}

// A thrown fetch error's class, from its name (the proxy's own deadline is a TimeoutError) and the `code` of its cause chain
// (undici wraps the socket error as `TypeError("fetch failed", { cause })`, sometimes an AggregateError of attempts); the
// message is never read.
export function thrownClass(e: unknown): ModelCallErrorClass {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  let at: unknown = e;
  for (let depth = 0; depth < 5 && typeof at === "object" && at !== null; depth++) {
    const code = (at as { code?: unknown }).code;
    const found = typeof code === "string" ? codeClass(code) : undefined;
    if (found) return found;
    const errors = (at as { errors?: unknown }).errors;
    if (Array.isArray(errors)) for (const inner of errors) if (inner !== at) return thrownClass(inner);
    at = (at as { cause?: unknown }).cause;
  }
  return "transport";
}

// Key-shaped substrings: OpenAI/OpenRouter/Anthropic style `sk-...` keys (also masked ones like `sk-or-v1-ab***cd`), a
// Bearer value, Google `AIza...` keys, and any 32+ character run of letters, digits, `_` and `-` that mixes letters and digits.
const KEY_SHAPES: readonly RegExp[] = [/\bsk-[A-Za-z0-9_\-*.]{6,}/g, /\bBearer\s+[A-Za-z0-9._~+/=\-*]+/gi, /\bAIza[0-9A-Za-z_-]{20,}/g];
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;
export const REDACTED = "[redacted]";

// Removes every occurrence of each secret (compared in-process; secrets shorter than 8 characters are ignored, too short
// to tell from text) and every key-shaped substring. Text without a match is returned unchanged.
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8 && out.includes(s)) out = out.split(s).join(REDACTED);
  for (const re of KEY_SHAPES) out = out.replace(re, (m) => (m.toLowerCase().startsWith("bearer") ? `${m.split(/\s+/, 1)[0]} ${REDACTED}` : REDACTED));
  return out.replace(LONG_RUN, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) ? REDACTED : m));
}

// The scrubbed body bytes: byte-identical when nothing matched (also for a body that is not UTF-8 text, which is scrubbed
// on its lossy decoding only when a match is found).
export function scrubBody(body: Uint8Array, secrets: readonly string[]): Uint8Array {
  const text = Buffer.from(body).toString("utf8");
  const scrubbed = scrubSecrets(text, secrets);
  return scrubbed === text ? body : new Uint8Array(Buffer.from(scrubbed, "utf8"));
}

export const UPSTREAM_MESSAGE_MAX = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL_OR_SPACE = /[\u0000-\u001f\u007f\u2028\u2029\s]+/g;

// The upstream's own error text, for the journal and the operator: a JSON body's `error.message`, `message`, `error` or
// `detail` string, else the raw text; scrubbed, control characters (and runs of whitespace) collapsed to one space, and
// trimmed to UPSTREAM_MESSAGE_MAX characters. Undefined for an empty body.
export function upstreamMessage(body: Uint8Array | null, secrets: readonly string[]): string | undefined {
  if (!body || body.length === 0) return undefined;
  const raw = Buffer.from(body.subarray(0, 16_384)).toString("utf8");
  let text = raw;
  try {
    const j = JSON.parse(raw) as Record<string, unknown> | null;
    const err = j?.error;
    const pick = [typeof err === "object" && err !== null ? (err as { message?: unknown }).message : undefined, j?.message, err, j?.detail].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (pick !== undefined) text = pick;
  } catch {
    /* not JSON: the raw text */
  }
  const flat = scrubSecrets(text, secrets).replace(CONTROL_OR_SPACE, " ").trim();
  if (flat === "") return undefined;
  return flat.length > UPSTREAM_MESSAGE_MAX ? `${flat.slice(0, UPSTREAM_MESSAGE_MAX - 3)}...` : flat;
}

// A 2xx SSE stream that reported an error: an Anthropic `event: error` / `"type":"error"` event, or an OpenAI-shaped
// `finish_reason: "error"`. A cheap textual check of the buffered body (TODO(stream-error) in service.ts says what is not done).
export function streamErrored(body: Uint8Array, headers: Headers): boolean {
  if (!(headers.get("content-type") ?? "").includes("text/event-stream")) return false;
  const text = Buffer.from(body).toString("utf8");
  return /^event:\s*error\s*$/m.test(text) || /^data:\s*\{\s*"type"\s*:\s*"error"/m.test(text) || /"finish_reason"\s*:\s*"error"/.test(text);
}

export const OPENROUTER_BASE_HINT = "openrouter chat completions need https://openrouter.ai/api/v1; anthropic-messages need https://openrouter.ai/api";

// The operator hint for a 404 at `basePath + requestPath`. Which API family an agent's model speaks (chat completions or
// Anthropic messages) is chosen per model in Pi's catalog and per template override, so it is not known at startup; the
// known base-path mismatches are recognized on the failing call instead.
export function notFoundHint(baseName: string, basePath: string, requestPath: string): string {
  const base = basePath.replace(/\/+$/, "");
  const path = requestPath.split(/[?#]/, 1)[0] ?? "";
  const chatUnderApi = base.endsWith("/api") && /^\/(chat\/completions|completions|responses)\/?$/.test(path);
  const messagesUnderV1 = base.endsWith("/v1") && /^\/v1\//.test(path);
  if (chatUnderApi || messagesUnderV1) return `check ${baseName}: ${OPENROUTER_BASE_HINT}`;
  return `check ${baseName} (the proxy appends the agent's request path ${path} to it) and the model id`;
}
