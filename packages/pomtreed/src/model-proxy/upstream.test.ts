import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_CALL_ERROR_CLASSES } from "@pomtree/core";
import {
  OPENROUTER_BASE_HINT,
  checkModelBaseUrl,
  notFoundHint,
  scrubBody,
  scrubSecrets,
  statusClass,
  streamErrored,
  thrownClass,
  upstreamMessage,
} from "./upstream.ts";

const NAME = "POMTREED_MODEL_BASE_URL";
const enc = (s: string) => new TextEncoder().encode(s);
const expect = "expected http(s)://host[/basePath] with no query, fragment or credentials, e.g. https://openrouter.ai/api/v1";

test("checkModelBaseUrl accepts http(s) bases and shows scheme://host/basePath", () => {
  const ok = checkModelBaseUrl("https://openrouter.ai/api/v1/", NAME);
  assert.ok(ok.ok);
  assert.equal(ok.display, "https://openrouter.ai/api/v1");
  const local = checkModelBaseUrl("http://127.0.0.1:8080", NAME);
  assert.ok(local.ok && local.display === "http://127.0.0.1:8080");
  for (const raw of ["http://localhost:8080/v1", "http://[::1]:8080/v1", "https://api.example.com/v1", "https://10.0.0.5/v1"])
    assert.ok(checkModelBaseUrl(raw, NAME).ok, raw);
});

test("checkModelBaseUrl refuses plain http to a non-loopback host, naming the variable and the action", () => {
  for (const raw of ["http://api.example.com/v1", "http://10.0.0.5/v1", "http://127.0.0.1.example.com/v1", "http://[2001:db8::1]/v1"]) {
    const r = checkModelBaseUrl(raw, NAME);
    assert.equal(r.ok, false, raw);
    if (r.ok) continue;
    assert.match(r.error, new RegExp(`^invalid ${NAME}: plain http to non-loopback `), raw);
    assert.match(r.error, /use an https:\/\/ URL or a loopback address/, raw);
  }
});

test("checkModelBaseUrl refuses each malformed base with a message naming the variable and never the raw value", () => {
  const cases: [string, string][] = [
    ["sk-or-v1-notaurl0123456789", `invalid ${NAME}: not a parseable URL; ${expect}`],
    ["ftp://openrouter.ai/api", `invalid ${NAME}: scheme ftp is not http or https (ftp://openrouter.ai/api); ${expect}`],
    ["https://openrouter.ai/api?key=sk-live-123456789", `invalid ${NAME}: it has a query string (https://openrouter.ai/api); ${expect}`],
    ["https://openrouter.ai/api?", `invalid ${NAME}: it has a query string (https://openrouter.ai/api); ${expect}`],
    ["https://openrouter.ai/api#frag", `invalid ${NAME}: it has a fragment (https://openrouter.ai/api); ${expect}`],
    ["https://user:hunter2-pass@openrouter.ai/api", `invalid ${NAME}: it carries credentials (user:password@); ${expect}`],
  ];
  for (const [raw, error] of cases) {
    const r = checkModelBaseUrl(raw, NAME);
    assert.deepEqual(r, { ok: false, error }, raw);
    assert.doesNotMatch(error, /sk-or-v1|sk-live|key=|hunter2|#frag/);
  }
});

test("statusClass maps each status family to its class and keeps the 4xx/5xx fallbacks", () => {
  const table: [number, string][] = [
    [301, "redirect"],
    [307, "redirect"],
    [400, "bad_request"],
    [413, "bad_request"],
    [422, "bad_request"],
    [401, "auth_rejected"],
    [403, "auth_rejected"],
    [402, "insufficient_funds"],
    [404, "not_found"],
    [429, "rate_limited"],
    [418, "upstream_4xx"],
    [500, "upstream_5xx"],
    [503, "upstream_5xx"],
  ];
  for (const [status, cls] of table) {
    assert.equal(statusClass(status), cls, String(status));
    assert.ok(MODEL_CALL_ERROR_CLASSES.includes(statusClass(status)));
  }
});

const fetchFailed = (cause: unknown) => new TypeError("fetch failed", { cause });
const coded = (code: string) => Object.assign(new Error("x"), { code });

test("thrownClass reads the cause chain's code, never the message", () => {
  const table: [unknown, string][] = [
    [fetchFailed(coded("ENOTFOUND")), "dns"],
    [fetchFailed(coded("EAI_AGAIN")), "dns"],
    [fetchFailed(coded("ECONNREFUSED")), "connect"],
    [fetchFailed(coded("ECONNRESET")), "connect"],
    [fetchFailed(coded("CERT_HAS_EXPIRED")), "tls"],
    [fetchFailed(coded("ERR_TLS_CERT_ALTNAME_INVALID")), "tls"],
    [fetchFailed(coded("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), "tls"],
    [fetchFailed(coded("UND_ERR_CONNECT_TIMEOUT")), "timeout"],
    [fetchFailed(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")])), "connect"],
    [new DOMException("t", "TimeoutError"), "timeout"],
    [new DOMException("a", "AbortError"), "aborted"],
    [fetchFailed(coded("EWHATEVER")), "transport"],
    [new Error("boom"), "transport"],
    [null, "transport"],
  ];
  for (const [e, cls] of table) assert.equal(thrownClass(e), cls);
  // Negative: a message that names a code is not a code.
  assert.equal(thrownClass(fetchFailed(new Error("getaddrinfo ENOTFOUND openrouter.ai"))), "transport");
});

test("scrubSecrets removes the configured key and key-shaped substrings", () => {
  const key = "plain-upstream-key-value";
  assert.equal(scrubSecrets(`bad key ${key}!`, [key]), "bad key [redacted]!");
  assert.equal(scrubSecrets("Incorrect API key provided: sk-or-v1-abc***wxyz.", []), "Incorrect API key provided: [redacted]");
  assert.equal(scrubSecrets("got Authorization: Bearer abc.def-123", []), "got Authorization: Bearer [redacted]");
  assert.equal(scrubSecrets("key AIzaSyA0123456789abcdefghijklmnop rejected", []), "key [redacted] rejected");
  assert.equal(scrubSecrets("token 0123456789abcdef0123456789abcdef01 is bad", []), "token [redacted] is bad");
  // Negative: innocuous text, a short secret and a long letters-only run are left alone.
  const innocuous = '{"error":{"message":"model anthropic/claude-sonnet-4.5 not found","code":404}}';
  assert.equal(scrubSecrets(innocuous, ["short"]), innocuous);
  assert.equal(scrubSecrets("abcdefghijklmnopqrstuvwxyzabcdefghij", []), "abcdefghijklmnopqrstuvwxyzabcdefghij");
});

test("scrubBody keeps an innocuous body byte-identical and rewrites only a matching one", () => {
  const body = enc('{"message":"Not Found","code":404}');
  assert.equal(scrubBody(body, ["provider-secret"]), body, "the same bytes, not a copy");
  const leaky = scrubBody(enc('{"error":"bad key provider-secret"}'), ["provider-secret"]);
  assert.equal(Buffer.from(leaky).toString("utf8"), '{"error":"bad key [redacted]"}');
});

test("upstreamMessage picks the provider's text, strips control characters, scrubs and bounds it", () => {
  assert.equal(upstreamMessage(enc('{"message":"Not Found","code":404}'), []), "Not Found");
  assert.equal(upstreamMessage(enc('{"error":{"message":"No auth credentials found","code":401}}'), []), "No auth credentials found");
  assert.equal(upstreamMessage(enc('{"error":"quota\\nexceeded"}'), []), "quota exceeded");
  assert.equal(upstreamMessage(enc('{"detail":"bad"}'), []), "bad");
  assert.equal(upstreamMessage(enc("<html>\r\n\t502 Bad Gateway\u0007</html>"), []), "<html> 502 Bad Gateway </html>");
  assert.equal(upstreamMessage(enc(`{"error":{"message":"invalid key the-upstream-key"}}`), ["the-upstream-key"]), "invalid key [redacted]");
  const long = upstreamMessage(enc("x".repeat(500)), []);
  assert.equal(long?.length, 200);
  assert.ok(long?.endsWith("..."));
  // Negative: nothing to say.
  assert.equal(upstreamMessage(enc(""), []), undefined);
  assert.equal(upstreamMessage(null, []), undefined);
  assert.equal(upstreamMessage(enc(" \n "), []), undefined);
});

test("notFoundHint names the openrouter base-path fix only for the known mismatches", () => {
  const hint = `check ${NAME}: ${OPENROUTER_BASE_HINT}`;
  assert.equal(notFoundHint(NAME, "/api", "/chat/completions"), hint);
  assert.equal(notFoundHint(NAME, "/api/", "/chat/completions?x=1"), hint);
  assert.equal(notFoundHint(NAME, "/api/v1", "/v1/messages"), hint);
  // Negative: the right pairings get the generic hint, not the openrouter one.
  const generic = (path: string) => `check ${NAME} (the proxy appends the agent's request path ${path} to it) and the model id`;
  assert.equal(notFoundHint(NAME, "/api/v1", "/chat/completions"), generic("/chat/completions"));
  assert.equal(notFoundHint(NAME, "/api", "/v1/messages"), generic("/v1/messages"));
});

test("streamErrored recognizes an in-stream error event only in an SSE body", () => {
  const sse = new Headers({ "content-type": "text/event-stream" });
  assert.equal(streamErrored(enc('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n'), sse), true);
  assert.equal(streamErrored(enc('data: {"choices":[{"finish_reason":"error"}]}\n\n'), sse), true);
  // Negative: a clean stream, and the same text in a JSON response.
  assert.equal(streamErrored(enc('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), sse), false);
  assert.equal(streamErrored(enc('{"finish_reason":"error"}'), new Headers({ "content-type": "application/json" })), false);
});
