import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { encodeGatewayCredential } from "../gateway.ts";
import { createPrice } from "./price.ts";
import { RequestBudget } from "./request-budget.ts";
import { ModelProxy } from "./service.ts";

// Every model id these tests send: the credential allows them all (model_not_allowed has its own tests).
const TEST_MODELS = ["m", "ds", "nope", "big", "deepseek/deepseek-v4-pro", "DS", " ds", "ds:free", "p/ds", "ds\u0000"];
const secret = "controller-secret";
const now = () => 1_000;
const key = (id = "a".repeat(32), budgetMicros = 100) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id, budgetMicros, expiresAt: 2_000, issuedAt: 1_000, models: TEST_MODELS });

function proxy(fetch: typeof globalThis.fetch, price = () => ({ micros: 20, basis: "catalog" as const })): ModelProxy {
  return new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1/", key: "provider-secret" },
    budget: new RequestBudget({ secret, now }),
    maximumRequestMicros: 50,
    price,
    fetch,
  });
}

test("model proxy reserves before forwarding, substitutes its upstream credential, and settles trusted price", async () => {
  let url = "";
  let authorization = "";
  const p = proxy(async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    assert.equal(new Headers(init?.headers).get("x-pomtree-request-id"), null);
    return new Response('{"usage":{}}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "never-forward" } });
  });
  const result = await p.forward({
    credential: key(),
    requestId: "r1",
    path: "/chat/completions",
    headers: new Headers({ authorization: "Bearer agent-token" }),
    body: new TextEncoder().encode('{"model":"m"}'),
  });
  assert.equal(url, "https://provider.example/v1/chat/completions"); // the base path prefix is kept
  assert.equal(authorization, "Bearer provider-secret");
  assert.deepEqual(result, { status: 200, headers: new Headers({ "content-type": "application/json" }), body: new TextEncoder().encode('{"usage":{}}') });
});

test("model proxy refuses invalid credentials and never contacts the upstream", async () => {
  const p = proxy(async () => {
    throw new Error("must not call");
  });
  assert.deepEqual(await p.forward({ credential: "bad", requestId: "r1", path: "/chat/completions", body: new TextEncoder().encode('{"model":"m"}') }), {
    status: 401,
    error: "invalid-credential",
  });
});

test("model proxy keeps the configured upstream authority", async () => {
  const p = proxy(async () => {
    throw new Error("must not call");
  });
  assert.deepEqual(await p.forward({ credential: key(), requestId: "r1", path: "//attacker.example/x", body: new Uint8Array() }), {
    status: 400,
    error: "invalid model proxy request",
  });
});

test("model proxy fails closed for an unpriced response and exhausts its reservation", async () => {
  const budget = new RequestBudget({ secret, now });
  const p = new ModelProxy({
    upstream: { baseUrl: "https://provider.example", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => null,
    fetch: async () => new Response("{}"),
  });
  assert.deepEqual(await p.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: new TextEncoder().encode('{"model":"m"}') }), {
    status: 502,
    error: "upstream 2xx response had no usable usage (malformed_response): no usage the proxy can price; the whole reservation was charged",
  });
  assert.deepEqual(budget.reserve(key(), "r2", 51), { ok: false, reason: "budget-exhausted" });
});

test("model proxy cancels only a request that failed before the upstream accepted it", async () => {
  const budget = new RequestBudget({ secret, now });
  const p = new ModelProxy({
    upstream: { baseUrl: "https://provider.example", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 1, basis: "catalog" }),
    fetch: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(await p.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: new TextEncoder().encode('{"model":"m"}') }), {
    status: 502,
    error:
      "model upstream unavailable (transport): the call to provider.example/chat/completions failed before a response; retry later, and check model.baseUrl if it persists",
  });
  assert.equal(budget.reserve(key(), "r2", 100).ok, true);
});

test("model proxy prices a streaming (SSE) upstream response and returns the buffered stream", async () => {
  const budget = new RequestBudget({ secret, now });
  const sse =
    'data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n' +
    "data: [DONE]\n\n";
  const p = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1/", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: createPrice(new FakeRatesSource({ p: { m: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } }), "p"),
    fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const result = await p.forward({
    credential: key(),
    requestId: "r1",
    path: "/chat/completions",
    headers: new Headers({ authorization: "Bearer agent-token" }),
    body: new TextEncoder().encode('{"model":"m"}'),
  });
  assert.deepEqual(result, { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: new TextEncoder().encode(sse) });
  // Charged 50 micros ((10 * 1M + 20 * 2M) / 1M); the 100-micro budget leaves 50, so a 51-micro reserve is refused.
  assert.deepEqual(budget.reserve(key(), "r2", 51), { ok: false, reason: "budget-exhausted" });
});
