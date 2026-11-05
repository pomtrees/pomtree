import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_BUDGET_REFUSAL_MESSAGE, modelRefusalTag } from "@pomtree/core";
import { normalizeRecord, providerFailure } from "./pi-format.ts";

// The proxy's 402 prefix as core defines it (pomtreed's budget-refusal-contract.test.ts pins the proxy's real body).
const CONTROLLER_BUDGET_REFUSAL = `${MODEL_BUDGET_REFUSAL_MESSAGE} ${modelRefusalTag("model_budget_exhausted")}`;

// Live upstream strings as Pi surfaces them in message_end.errorMessage (status, colon, provider body).
const failed = (errorMessage: string) =>
  normalizeRecord({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } });

test("a 404 from the upstream (bad base URL or model id) is a provider config error that names what to check", () => {
  const live = '404: {"message":"Not Found","code":404}';
  const [e] = failed(live);
  assert.ok(e?.kind === "provider_error" && e.code === "config" && e.retryable === false, JSON.stringify(e));
  assert.match(
    e?.kind === "provider_error" ? e.message : "",
    /no such model or endpoint .*check the model id .*base URL; retrying will not help; provider said: 404: \{"message":"Not Found"/,
  );
  assert.match((providerFailure("HTTP 404 Not Found") as { message: string }).message, /^the provider has no such model or endpoint/);
});

test("a 400 naming the model is a provider config error; a context-length 400 and prose numbers are not", () => {
  assert.match(
    (providerFailure("400: model 'gpt-x' does not exist") as { message: string }).message,
    /^the provider rejected the request for this model \(HTTP 400\)/,
  );
  for (const msg of ["400: This model's maximum context length is 128000 tokens", "400: prompt is too long", "tried 404 times", "file not found"]) {
    assert.deepEqual(providerFailure(msg), { kind: "error", message: msg }, msg);
  }
});

test("a 402 out of credits is a provider funding error; the controller proxy's own budget 402 is left for pomtreed", () => {
  const live = '402: {"error":{"message":"Insufficient credits. Add more using https://example.invalid/credits","code":402}}';
  const [e] = failed(live);
  assert.ok(e?.kind === "provider_error" && e.code === "funding" && e.retryable === false, JSON.stringify(e));
  assert.match(e?.kind === "provider_error" ? e.message : "", /add credits with the provider .*retrying will not help; provider said: 402: /);
  assert.match((providerFailure("402 Payment Required") as { message: string }).message, /^the model provider account has no credits left/);
  // Negative: the proxy's 402 (the agent's pomtree budget) keeps its exact text, which pomtreed's isBudgetRefusal matches by its tag.
  const proxy = `402 ${CONTROLLER_BUDGET_REFUSAL}: no budget remains after in-flight requests, below the 100 micro-USD minimum for this request`;
  assert.deepEqual(failed(proxy), [{ kind: "error", message: proxy }]);
  // The phrase without the tag is an upstream's prose, not the proxy's refusal: a 402 carrying it is funding.
  assert.equal((providerFailure("402 model budget exhausted: no budget remains") as { code?: string }).code, "funding");
  // Any other 402 is the upstream's Payment Required: funding, even with no funding wording in its body.
  assert.equal((providerFailure("402") as { code?: string }).code, "funding");
});

test("401 invalid-credential and credential-expired stay auth but say which and what to do", () => {
  const [inv] = failed("401: invalid-credential");
  assert.equal(inv?.kind, "provider_error");
  assert.ok(inv?.kind === "provider_error" && inv.code === "auth");
  assert.match(inv?.kind === "provider_error" ? inv.message : "", /^provider credential invalid: .*on the host .*provider said: 401: invalid-credential$/);
  const [exp] = failed("401: credential-expired");
  assert.ok(exp?.kind === "provider_error" && exp.code === "auth");
  assert.match(
    exp?.kind === "provider_error" ? exp.message : "",
    /^provider credential expired: refresh the provider login on the host .*provider said: 401: credential-expired$/,
  );
  // Auth is never retryable (core types.ts): every auth class stops the run for the operator.
  assert.ok(inv?.kind === "provider_error" && inv.retryable === false && exp?.kind === "provider_error" && exp.retryable === false);
  // A plain 401 names the generic cause and action, then keeps the provider's text.
  assert.deepEqual(failed("401 invalid token"), [
    {
      kind: "provider_error",
      code: "auth",
      message:
        "provider authentication failed: check the provider key or login on the host (the Pi auth.json pomtreed stages), then retry the run; provider said: 401 invalid token",
      retryable: false,
    },
  ]);
});

test("429 and 503 keep their retryable classes; 'tried 503 times' prose stays generic", () => {
  assert.deepEqual(failed("429 Too Many Requests"), [{ kind: "provider_error", code: "rate_limit", message: "429 Too Many Requests", retryable: true }]);
  assert.deepEqual(failed("503 Service Unavailable"), [{ kind: "provider_error", code: "outage", message: "503 Service Unavailable", retryable: true }]);
  // A 429 mentioning credits or quota is still a rate limit, not funding.
  assert.equal((providerFailure("429: credits per minute exceeded") as { code?: string }).code, "rate_limit");
  assert.deepEqual(failed("tried 503 times and gave up"), [{ kind: "error", message: "tried 503 times and gave up" }]);
});

test("an auto_retry_end failure is classified the same way", () => {
  const [e] = normalizeRecord({ type: "auto_retry_end", success: false, finalError: '404: {"message":"Not Found","code":404}' });
  assert.ok(e?.kind === "provider_error" && e.code === "config" && e.retryable === false, JSON.stringify(e));
});

test("a 429 insufficient_quota without the digits is funding (words-led match); with the 429 token it stays a rate limit", () => {
  assert.equal((providerFailure("insufficient_quota: You exceeded your current quota") as { code?: string }).code, "funding");
  assert.equal((providerFailure("429 insufficient_quota") as { code?: string }).code, "rate_limit");
});

test("auth words are matched as words: 'Author' and 'OAuth' in a provider message are not an auth failure", () => {
  for (const msg of ["Author field missing in request", "OAuth scopes listed in the docs"])
    assert.deepEqual(providerFailure(msg), { kind: "error", message: msg }, msg);
  for (const msg of ["Unauthorized", "authentication_error: invalid x-api-key", "permission_error: forbidden", "Incorrect API key provided"]) {
    const e = providerFailure(msg);
    assert.ok(e.kind === "provider_error" && e.code === "auth" && e.retryable === false, msg);
  }
});

test("transport failures without a status are retryable outages (provider-error-gaps)", () => {
  for (const msg of [
    "This operation was aborted",
    "terminated",
    "deepseek stream ended without a terminal event",
    "stream ended without finish",
    "Connection error.",
    "fetch failed",
    "read ECONNRESET",
    "socket hang up",
  ]) {
    const e = providerFailure(msg);
    assert.ok(e.kind === "provider_error" && e.code === "outage" && e.retryable === true && e.message === msg, msg);
  }
  // Negative: "terminated" in the middle of prose is not a transport failure.
  assert.deepEqual(providerFailure("the tool terminated early"), { kind: "error", message: "the tool terminated early" });
});

test("opaque JSON error bodies are classified from their type/code/status fields (provider-error-gaps)", () => {
  const code = (m: string) => (providerFailure(m) as { code?: string }).code;
  assert.equal(code('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "outage");
  assert.equal(code('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), "rate_limit");
  assert.equal(code('{"error":{"type":"authentication_error","message":"bad key"}}'), "auth");
  assert.equal(code('{"error":{"type":"api_error","message":"Internal"}}'), "outage");
  assert.equal(code('{"error":{"code":"503","message":"busy"}}'), "outage");
  assert.equal(code('{"status":429,"message":"busy"}'), "rate_limit");
  // Negative: a JSON body with no class field stays generic, and malformed JSON never throws.
  assert.deepEqual(providerFailure('{"error":{"message":"something odd"}}'), { kind: "error", message: '{"error":{"message":"something odd"}}' });
  assert.deepEqual(providerFailure("bad {json"), { kind: "error", message: "bad {json" });
});

test("an HTTP status in Pi's structured diagnostics classifies a message that omits it, and is prefixed for the operator", () => {
  const withStatus = (errorMessage: string, status: number) =>
    normalizeRecord({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
        diagnostics: [{ type: "pi_messages_response_failure", timestamp: 1, details: { status } }],
      },
    }).filter((e) => e.kind !== "usage");
  assert.deepEqual(withStatus("Too busy", 503), [{ kind: "provider_error", code: "outage", message: "HTTP 503: Too busy", retryable: true }]);
  assert.equal((withStatus("Not Found", 404)[0] as { code?: string }).code, "config");
  // A message that already leads with the status is not prefixed twice.
  assert.deepEqual(withStatus("429 Too Many Requests", 429), [
    { kind: "provider_error", code: "rate_limit", message: "429 Too Many Requests", retryable: true },
  ]);
});

test("usage carries cache tokens, provider, model, responseId and stopReason; an absent cost is null, not zero (cache-tokens, usage-join)", () => {
  const [u] = normalizeRecord({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      provider: "anthropic",
      model: "claude-x",
      responseId: "msg_01",
      stopReason: "toolUse",
      usage: { input: 5, output: 7, cacheRead: 100, cacheWrite: 20, cost: { total: 0.000123 } },
    },
  });
  assert.deepEqual(u, {
    kind: "usage",
    inputTokens: 5,
    outputTokens: 7,
    costMicros: 123,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    model: "claude-x",
    provider: "anthropic",
    responseId: "msg_01",
    stopReason: "toolUse",
  });
  const [noCost] = normalizeRecord({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 1, output: 2 } } });
  assert.deepEqual(noCost, { kind: "usage", inputTokens: 1, outputTokens: 2, costMicros: null });
  // A reported zero stays a real zero.
  const [zero] = normalizeRecord({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 1, output: 2, cost: { total: 0 } } } });
  assert.equal((zero as { costMicros: number | null }).costMicros, 0);
});

test("an upstream 402 with an opaque body is a non-retryable funding stop; the controller proxy's budget 402 is not", () => {
  for (const live of [
    '402 {"error":{"message":"stub upstream status 402","code":402}}',
    "402 stub upstream status 402",
    '402: {"type":"error","error":{"type":"api_error","message":"stub upstream status 402"}}',
    "402 status code (no body)",
  ]) {
    const [e] = failed(live);
    assert.ok(e?.kind === "provider_error" && e.code === "funding" && e.retryable === false, live);
    assert.ok(e?.kind === "provider_error" && e.message.endsWith(`provider said: ${live}`), live);
  }
  // The status only in Pi's structured diagnostics.
  const [d] = normalizeRecord({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Payment Required",
      diagnostics: [{ type: "x", timestamp: 1, details: { status: 402 } }],
    },
  }).filter((e) => e.kind !== "usage");
  assert.ok(d?.kind === "provider_error" && d.code === "funding" && d.retryable === false, JSON.stringify(d));
  // Negative: every shape of the proxy's own refusal stays a plain error with its exact text (pomtreed's isBudgetRefusal parks it).
  for (const own of [
    `402 ${CONTROLLER_BUDGET_REFUSAL}: 50 micro-USD remain after in-flight requests, below the 100 micro-USD minimum for this request`,
    `402 {"error":"${CONTROLLER_BUDGET_REFUSAL}: no budget remains after in-flight requests"}`,
  ])
    assert.deepEqual(failed(own), [{ kind: "error", message: own }], own);
});

test("a reply cut at the output-token limit while writing a tool call is surfaced as an error naming the tool (provider-error-gaps)", () => {
  const ev = normalizeRecord({
    type: "message_end",
    message: { role: "assistant", stopReason: "length", content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }] },
  });
  assert.equal(ev.length, 1);
  assert.match(
    ev[0]?.kind === "error" ? ev[0].message : "",
    /output-token limit \(stopReason length\) while writing a call to write: .*raise the model's max output tokens/,
  );
  // Negatives: a length stop with text only, and a normal tool-use stop, add no error.
  assert.deepEqual(
    normalizeRecord({ type: "message_end", message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] } }),
    [{ kind: "message", role: "assistant", text: "partial" }],
  );
  assert.deepEqual(
    normalizeRecord({
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }] },
    }),
    [],
  );
});

test("a tool call the model proxy refused for malformed arguments is a failed tool result plus a journal error naming the tool", () => {
  const refused = `Invalid arguments for tool "bash": Tool arguments must be a JSON object\n\nReceived arguments:\n"${modelRefusalTag("malformed_tool_arguments")} re-issue the call"`;
  const end = (text: string, isError: boolean) =>
    normalizeRecord({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError, result: { content: [{ type: "text", text }] } });
  const ev = end(refused, true);
  assert.equal(ev.length, 2);
  assert.ok(ev[0]?.kind === "tool_result" && ev[0].ok === false && ev[0].output === refused);
  assert.match(
    ev[1]?.kind === "error" ? ev[1].message : "",
    /^the model sent a call to bash whose arguments were not valid JSON \(malformed_tool_arguments\): the model proxy refused it, so nothing ran/,
  );
  // Negatives: an ordinary tool failure, and a successful tool whose output merely quotes the tag, add no error.
  assert.equal(end('Invalid arguments for tool "bash": command is required', true).length, 1);
  assert.equal(end(refused, false).length, 1);
});
