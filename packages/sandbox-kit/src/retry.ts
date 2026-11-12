// Retry and quota mapping around the kit's request function. A 429 becomes a typed quota error carrying the limit scope and
// the wait the provider asked for; transient failures are retried only when repeating the call cannot do harm twice.
//
// The kit takes no dependency on @pomtree/core, so the error is built by an injected factory: an adapter passes
// `(scope, retryAfterMs) => new SandboxQuotaError(backendId, scope, retryAfterMs)`.

import type { KitResponse, RequestFn, RequestInit } from "./request.ts";

export type QuotaScope = "rate" | "concurrency" | "plan";

export interface RetryPolicy {
  quotaError: (scope: QuotaScope, retryAfterMs: number | null, response: KitResponse) => Error;
  // Total calls including the first. Default 3.
  maxAttempts?: number;
  // Wait when the provider gave no Retry-After: baseDelayMs * 2^(attempt - 1) with up to 25% added jitter, then capped at
  // maxDelayMs (the cap applies after the jitter). A provider's Retry-After is used as given, without jitter.
  baseDelayMs?: number;
  // The longest single wait this wrapper will sit through (default 30 s). A longer Retry-After is not slept: on a 429 the call
  // fails now with the wait in the error, and on a 502/503/504 the response is returned, so the caller can hold the work and
  // retry later.

  maxDelayMs?: number;
  // Header names (lower-case) that make a non-idempotent request safe to repeat. Default ["idempotency-key"].
  idempotencyHeaders?: string[];
  // Which thrown errors are worth repeating for a repeatable request. The default accepts socket-level transient failures
  // (reset, timeout, broken pipe, refused, DNS try-again, hang-up) and the kit's own no-response timeout, which is retried
  // because a repeatable request may safely run twice; TLS verification failures, bad PEM or option errors and anything
  // unrecognised are thrown at once, since repeating them cannot help.
  isTransient?: (error: unknown) => boolean;
  // Pick the scope from the provider's body or headers; default "rate".
  scopeOf?: (response: KitResponse) => QuotaScope;
  // Injected for tests; defaults are real timers, Date.now and Math.random.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// Retry-After: delta-seconds or an HTTP date. Null when absent or unparseable.
export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // Only the IMF-fixdate form RFC 9110 requires; Date.parse alone would also accept junk such as "-5" or "2030".
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED"]);
// The kit's transport re-wraps node errors into a message, so the code is matched in the text as well as on `code`.
const TRANSIENT_TEXT = /\b(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|ECONNABORTED)\b|socket hang up|no complete response within/;

export function defaultIsTransient(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return error instanceof Error && TRANSIENT_TEXT.test(error.message);
}

export function isRepeatable(init: RequestInit, idempotencyHeaders: readonly string[] = ["idempotency-key"]): boolean {
  if (IDEMPOTENT_METHODS.has(init.method.toUpperCase())) return true;
  const names = Object.keys(init.headers ?? {}).map((h) => h.toLowerCase());
  return idempotencyHeaders.some((h) => names.includes(h.toLowerCase()));
}

export function withRetry(request: RequestFn, policy: RetryPolicy): RequestFn {
  const maxAttempts = Math.max(1, policy.maxAttempts ?? 3);
  const base = policy.baseDelayMs ?? 500;
  const cap = policy.maxDelayMs ?? 30_000;
  const sleep = policy.sleep ?? defaultSleep;
  const now = policy.now ?? Date.now;
  const random = policy.random ?? Math.random;
  const isTransient = policy.isTransient ?? defaultIsTransient;
  const backoff = (attempt: number) => Math.min(cap, base * 2 ** (attempt - 1) * (1 + 0.25 * random()));

  return async (url, init) => {
    const repeatable = isRepeatable(init, policy.idempotencyHeaders);
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts;
      let res: KitResponse;
      try {
        res = await request(url, init);
      } catch (e) {
        // A transport failure after the request may have been sent leaves its outcome unknown: repeat only what is safe to repeat.
        if (last || !repeatable || init.signal?.aborted || !isTransient(e)) throw e;
        await sleep(backoff(attempt), init.signal);
        continue;
      }
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers["retry-after"], now());
        const scope = policy.scopeOf?.(res) ?? "rate";
        // A 429 means the call was refused, but a non-idempotent request without a key is still not repeated here: the caller
        // decides, with the typed error in hand.
        if (last || !repeatable || (wait !== null && wait > cap)) throw policy.quotaError(scope, wait, res);
        await sleep(wait ?? backoff(attempt), init.signal);
        continue;
      }
      if (TRANSIENT_STATUSES.has(res.status) && repeatable && !last) {
        const wait = parseRetryAfter(res.headers["retry-after"], now());
        if (wait !== null && wait > cap) return res;
        await sleep(wait ?? backoff(attempt), init.signal);
        continue;
      }
      return res;
    }
  };
}
