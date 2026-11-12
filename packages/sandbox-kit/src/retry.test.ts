import assert from "node:assert/strict";
import { test } from "node:test";
import type { KitResponse, RequestInit } from "./request.ts";
import { defaultIsTransient, type QuotaScope, type RetryPolicy, isRepeatable, parseRetryAfter, withRetry } from "./retry.ts";

// Stand-in for core's SandboxQuotaError (the kit does not depend on core); an adapter passes the real constructor.
class QuotaStub extends Error {
  scope: QuotaScope;
  retryAfterMs: number | null;
  constructor(scope: QuotaScope, retryAfterMs: number | null) {
    super(`quota ${scope}`);
    this.scope = scope;
    this.retryAfterMs = retryAfterMs;
  }
}

const res = (status: number, headers: Record<string, string> = {}): KitResponse => ({ status, headers, body: new Uint8Array() });

function harness(script: (KitResponse | Error)[], extra: Partial<RetryPolicy> = {}) {
  const calls: RequestInit[] = [];
  const sleeps: number[] = [];
  const request = async (_url: string, init: RequestInit) => {
    calls.push(init);
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  const wrapped = withRetry(request, {
    quotaError: (scope, ms) => new QuotaStub(scope, ms),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => Date.parse("2030-01-01T00:00:00Z"),
    random: () => 0,
    ...extra,
  });
  return { wrapped, calls, sleeps };
}

test("retry: a 429 with Retry-After on an idempotent GET waits that long, then succeeds", async () => {
  const h = harness([res(429, { "retry-after": "2" }), res(200)]);
  const r = await h.wrapped("https://p.example/x", { method: "GET" });
  assert.equal(r.status, 200);
  assert.deepEqual(h.sleeps, [2000]);
  assert.equal(h.calls.length, 2);
});

test("retry: attempts are capped, and the final 429 maps to the typed quota error with scope and wait", async () => {
  const h = harness([res(429, { "retry-after": "1" })], { maxAttempts: 3, scopeOf: () => "concurrency" });
  await assert.rejects(
    h.wrapped("https://p.example/x", { method: "GET" }),
    (e: unknown) => e instanceof QuotaStub && e.scope === "concurrency" && e.retryAfterMs === 1000,
  );
  assert.equal(h.calls.length, 3, "exactly maxAttempts calls");
  assert.deepEqual(h.sleeps, [1000, 1000]);
});

test("retry: a 429 without Retry-After backs off exponentially and reports a null wait", async () => {
  const h = harness([res(429)], { maxAttempts: 4, baseDelayMs: 100 });
  await assert.rejects(
    h.wrapped("https://p.example/x", { method: "GET" }),
    (e: unknown) => e instanceof QuotaStub && e.scope === "rate" && e.retryAfterMs === null,
  );
  assert.deepEqual(h.sleeps, [100, 200, 400]);
});

test("retry: a Retry-After longer than maxDelayMs is not slept; it fails now carrying the wait", async () => {
  const h = harness([res(429, { "retry-after": "120" })], { maxDelayMs: 5_000 });
  await assert.rejects(h.wrapped("https://p.example/x", { method: "GET" }), (e: unknown) => e instanceof QuotaStub && e.retryAfterMs === 120_000);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
});

test("retry NEG: a non-idempotent POST is not repeated on a 429 without a key, but still maps to the quota error", async () => {
  const h = harness([res(429, { "retry-after": "1" }), res(200)]);
  await assert.rejects(h.wrapped("https://p.example/sandboxes", { method: "POST", body: "{}" }), QuotaStub);
  assert.equal(h.calls.length, 1);
});

test("retry: the same POST with an Idempotency-Key header (any case) is repeated", async () => {
  const h = harness([res(429, { "retry-after": "1" }), res(201)]);
  const r = await h.wrapped("https://p.example/sandboxes", { method: "POST", headers: { "Idempotency-Key": "k1" }, body: "{}" });
  assert.equal(r.status, 201);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], h.calls[0], "the repeat is byte-identical");
});

test("retry NEG: a transport error on a non-idempotent POST is thrown at once (its outcome is unknown); on a GET it is retried", async () => {
  const boom = new Error("socket hang up");
  const post = harness([boom, res(200)]);
  await assert.rejects(post.wrapped("https://p.example/x", { method: "POST" }), /socket hang up/);
  assert.equal(post.calls.length, 1);
  const get = harness([boom, res(200)]);
  assert.equal((await get.wrapped("https://p.example/x", { method: "GET" })).status, 200);
  assert.equal(get.calls.length, 2);
});

test("retry: 503 on a GET is retried and the last 503 is returned, not thrown, when attempts run out", async () => {
  const h = harness([res(503)], { maxAttempts: 2 });
  assert.equal((await h.wrapped("https://p.example/x", { method: "GET" })).status, 503);
  assert.equal(h.calls.length, 2);
  const post = harness([res(503), res(200)]);
  assert.equal((await post.wrapped("https://p.example/x", { method: "POST" })).status, 503);
  assert.equal(post.calls.length, 1);
});

test("retry: other statuses (404, 500) pass through untouched with one call", async () => {
  for (const status of [200, 404, 500]) {
    const h = harness([res(status)]);
    assert.equal((await h.wrapped("https://p.example/x", { method: "GET" })).status, status);
    assert.equal(h.calls.length, 1);
  }
});

test("retry: an aborted signal stops a retry loop instead of sleeping on", async () => {
  const ac = new AbortController();
  const h = harness([new Error("read ECONNRESET")], { sleep: async () => ac.abort(new Error("stop")) });
  await assert.rejects(h.wrapped("https://p.example/x", { method: "GET", signal: ac.signal }), /ECONNRESET|stop/);
  assert.equal(h.calls.length, 2);
});

test("retry: parseRetryAfter reads seconds and HTTP dates, and ignores junk", () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("7", now), 7000);
  assert.equal(parseRetryAfter("Tue, 01 Jan 2030 00:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("Mon, 31 Dec 2029 00:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("soon", now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
  for (const junk of ["-5", "1.5", "5s", "", "Tue 01 Jan 2030", "01/01/2030 00:00:30"]) assert.equal(parseRetryAfter(junk, now), null, junk);
});

test("retry: isRepeatable honours the configured idempotency header names", () => {
  assert.equal(isRepeatable({ method: "POST" }), false);
  assert.equal(isRepeatable({ method: "POST", headers: { "X-Request-Id": "a" } }, ["x-request-id"]), true);
  assert.equal(isRepeatable({ method: "delete" }), true);
});

test("retry: a 503 with Retry-After beyond maxDelayMs is returned without sleeping (3600 s)", async () => {
  const h = harness([res(503, { "retry-after": "3600" }), res(200)]);
  const r = await h.wrapped("https://p.example/x", { method: "GET" });
  assert.equal(r.status, 503);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
  const short = harness([res(503, { "retry-after": "2" }), res(200)]);
  assert.equal((await short.wrapped("https://p.example/x", { method: "GET" })).status, 200);
  assert.deepEqual(short.sleeps, [2000]);
});

test("retry NEG: a TLS verification or option error is thrown at once; socket-level and timeout errors are retried", async () => {
  const tlsErr = new Error("request GET https://p.example/x failed: self-signed certificate in certificate chain. Check the endpoint address");
  const h = harness([tlsErr, res(200)]);
  await assert.rejects(h.wrapped("https://p.example/x", { method: "GET" }), /self-signed/);
  assert.equal(h.calls.length, 1);
  const opt = harness([new Error("tls.ca must be a non-empty PEM string; pass the PEM text"), res(200)]);
  await assert.rejects(opt.wrapped("https://p.example/x", { method: "GET" }), /tls.ca/);
  assert.equal(opt.calls.length, 1);
  for (const transient of [
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    new Error("request GET https://p.example/x failed: connect ETIMEDOUT 1.2.3.4:443. Check"),
    new Error("request GET https://p.example/x failed: no complete response within 60000 ms. Check"),
    new Error("socket hang up"),
  ]) {
    const t = harness([transient, res(200)]);
    assert.equal((await t.wrapped("https://p.example/x", { method: "GET" })).status, 200);
    assert.equal(t.calls.length, 2);
  }
  assert.equal(defaultIsTransient("string"), false);
  const custom = harness([tlsErr, res(200)], { isTransient: () => true });
  assert.equal((await custom.wrapped("https://p.example/x", { method: "GET" })).status, 200);
});

test("retry: jitter is capped by maxDelayMs after jitter, while Retry-After is used as given", async () => {
  const h = harness([res(429)], { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000, random: () => 1 });
  await assert.rejects(h.wrapped("https://p.example/x", { method: "GET" }), QuotaStub);
  assert.deepEqual(h.sleeps, [1000, 1000]);
  const ra = harness([res(429, { "retry-after": "10" }), res(200)], { random: () => 1 });
  await ra.wrapped("https://p.example/x", { method: "GET" });
  assert.deepEqual(ra.sleeps, [10_000]);
});
