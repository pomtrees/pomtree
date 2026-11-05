import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeModelUpstream, FakeRatesSource } from "@pomtree/testing";
import { settlementCallMeta } from "../model-settlement.ts";
import { callFacts, createPrice, createSettleEstimate } from "./price.ts";
import { chargeMicros } from "./rates.ts";
import type { ModelRates } from "./rates.ts";
import { RequestBudget } from "./request-budget.ts";
import { ModelProxy } from "./service.ts";
import type { ProxySettlement } from "./service.ts";
import { encodeGatewayCredential } from "../gateway.ts";

// Hand-written Anthropic Messages streaming fixtures (shape of a recorded stream; offline).
const rate: ModelRates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const rates = new FakeRatesSource({ p: { m: rate } });
const charge = createPrice(rates, "p");
// The charge's micros (null when unpriceable); the basis is asserted on `charge` itself, below.
const price = (...args: Parameters<typeof charge>) => charge(...args)?.micros ?? null;
const enc = (s: string) => new TextEncoder().encode(s);
const req = enc(JSON.stringify({ model: "m" }));
const sseHeaders = () => new Headers({ "content-type": "text/event-stream" });
const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const start = (usage: Record<string, unknown>) =>
  ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5.5", content: [], stop_reason: null, usage } });
const blocks =
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  ev("ping", {}) +
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }) +
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: " world" } }) +
  ev("content_block_stop", { index: 0 });
const delta = (usage: Record<string, unknown>, stop = "end_turn") => ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage });
const stop = ev("message_stop", {});

const startUsage = { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 1 };
const full = start(startUsage) + blocks + delta({ output_tokens: 50 }) + stop;
const expected = chargeMicros(rate, { input: 1000, output: 50, cacheRead: 300, cacheWrite: 200 });

test("anthropic stream: input from message_start (cache aware), output from message_delta", () => {
  assert.equal(price(enc(full), sseHeaders(), req), expected);
  assert.ok(expected > 1000 + 100);
});

test("anthropic stream: output_tokens is cumulative, the last message_delta wins (not summed)", () => {
  const body = start(startUsage) + blocks + delta({ output_tokens: 20 }) + delta({ output_tokens: 50 }) + stop;
  assert.equal(price(enc(body), sseHeaders(), req), expected);
});

test("anthropic stream: a message_delta repeating input as well as output (the stub shape) prices the same", () => {
  const body =
    start(startUsage) + blocks + delta({ input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 }) + stop;
  assert.equal(price(enc(body), sseHeaders(), req), expected);
  const onlyDelta = delta({ input_tokens: 10, output_tokens: 5 });
  assert.equal(price(enc(onlyDelta), sseHeaders(), req), chargeMicros(rate, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }));
});

test("anthropic stream: split at every byte boundary through the proxy settles the same", async () => {
  for (const size of [1, 7, 64]) {
    const { proxy, events } = make(async () => {
      const bytes = enc(full);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/v1/messages", body: enc('{"model":"m","stream":true,"max_tokens":100}') });
    assert.equal(r.status, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "priced");
    assert.equal(events[0]!.micros, expected, `chunk size ${size}`);
  }
});

test("anthropic stream: provider usage.cost (OpenRouter) takes precedence wherever it appears", () => {
  const inDelta = start(startUsage) + blocks + delta({ output_tokens: 50, cost: 0.000321 }) + stop;
  assert.equal(price(enc(inDelta), sseHeaders(), req), 321);
  const inStart = start({ ...startUsage, cost: 0.000125 }) + blocks + delta({ output_tokens: 50 }) + stop;
  assert.equal(price(enc(inStart), sseHeaders(), req), 125);
});

test("anthropic stream: unknown model or missing input side fails closed (null), as before", () => {
  assert.equal(price(enc(full), sseHeaders(), enc('{"model":"nope"}')), null);
  assert.equal(price(enc(blocks + delta({ output_tokens: 50 }) + stop), sseHeaders(), req), null);
});

test("stream with no usage anywhere still prices null and settles as an estimate", async () => {
  const body = blocks + delta({}, "end_turn").replace('"usage":{}', '"x":1') + stop;
  assert.equal(price(enc(body), sseHeaders(), req), null);
  assert.ok((createSettleEstimate(rates, "p")(enc(body), sseHeaders(), req) ?? 0) >= 1);
  const { proxy, events } = make(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  await proxy.forward({ credential: key(), requestId: "r1", path: "/messages", body: enc('{"model":"m","stream":true,"max_tokens":100}') });
  assert.equal(events[0]!.kind, "estimated");
});

const estimated = (body: string) => createSettleEstimate(rates, "p")(enc(body), sseHeaders(), req);

test("anthropic stream: a cut-off stream (message_start only, no message_delta) is not priced; the estimate applies", () => {
  assert.equal(price(enc(start(startUsage)), sseHeaders(), req), null);
  assert.equal(price(enc(start(startUsage) + blocks), sseHeaders(), req), null);
  assert.ok((estimated(start(startUsage) + blocks) ?? 0) >= 1);
});

test("anthropic stream: an error event is not priced as a success", () => {
  const err = ev("error", { error: { type: "overloaded_error", message: "Overloaded" } });
  assert.equal(price(enc(start(startUsage) + err), sseHeaders(), req), null);
  assert.equal(price(enc(start(startUsage) + blocks + delta({ output_tokens: 50 }) + err), sseHeaders(), req), null);
});

test("anthropic stream: upstream closing right after message_start through the proxy settles as an estimate", async () => {
  const { proxy, events } = make(async () => new Response(start(startUsage), { headers: { "content-type": "text/event-stream" } }));
  await proxy.forward({ credential: key(), requestId: "r1", path: "/v1/messages", body: enc('{"model":"m","stream":true,"max_tokens":100}') });
  assert.equal(events[0]!.kind, "estimated");
});

test("anthropic stream: a null or undefined field in a message_delta does not erase message_start's count", () => {
  const body = start(startUsage) + blocks + delta({ input_tokens: null, cache_read_input_tokens: null, output_tokens: 50 }) + stop;
  assert.equal(price(enc(body), sseHeaders(), req), expected);
});

test("anthropic stream: cost only in a trailing typeless usage chunk (OpenRouter) is charged as reported", () => {
  const trailing = `data: ${JSON.stringify({ usage: { cost: 0.000444 } })}\n\n`;
  assert.equal(price(enc(start(startUsage) + blocks + delta({ output_tokens: 50 }) + stop + trailing), sseHeaders(), req), 444);
  assert.equal(price(enc(start(startUsage) + blocks + trailing), sseHeaders(), req), 444);
});

test("non-streaming anthropic JSON with top-level usage prices from the table", () => {
  const json = JSON.stringify({
    id: "msg_1",
    type: "message",
    stop_reason: "end_turn",
    content: [],
    usage: { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 },
  });
  assert.equal(price(enc(json), new Headers({ "content-type": "application/json" }), req), expected);
});

test("callFacts: anthropic stream yields tokensIn (message_start), tokensOut (last delta), stop_reason", () => {
  assert.deepEqual(callFacts(enc(full), sseHeaders()), {
    tokensIn: 1000,
    tokensOut: 50,
    cacheReadTokens: 300,
    cacheWriteTokens: 200,
    finishReason: "end_turn",
    responseId: "msg_1",
  });
  assert.deepEqual(callFacts(enc(start(startUsage) + delta({ output_tokens: 9 }, "max_tokens")), sseHeaders()), {
    tokensIn: 1000,
    tokensOut: 9,
    cacheReadTokens: 300,
    cacheWriteTokens: 200,
    finishReason: "max_tokens",
    responseId: "msg_1",
  });
});

test("callFacts: cache tokens from an anthropic stream, a non-stream body, and the OpenAI cached_tokens shape", () => {
  assert.deepEqual(callFacts(enc(full), sseHeaders()), {
    tokensIn: 1000,
    tokensOut: 50,
    cacheReadTokens: 300,
    cacheWriteTokens: 200,
    finishReason: "end_turn",
    responseId: "msg_1",
  });
  const json = JSON.stringify({
    stop_reason: "end_turn",
    usage: { input_tokens: 4, cache_creation_input_tokens: 12152, cache_read_input_tokens: 1039, output_tokens: 2994 },
  });
  assert.deepEqual(callFacts(enc(json), new Headers({ "content-type": "application/json" })), {
    tokensIn: 4,
    tokensOut: 2994,
    cacheReadTokens: 1039,
    cacheWriteTokens: 12152,
    finishReason: "end_turn",
  });
  const oa = JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } });
  assert.deepEqual(callFacts(enc(oa), new Headers({ "content-type": "application/json" })), { tokensIn: 50, tokensOut: 5, cacheReadTokens: 20 });
});

test("settlement carries the charged micros and tokens/finish reason into ModelCallMeta", async () => {
  const { proxy, events } = make(async () => new Response(full, { headers: { "content-type": "text/event-stream" } }));
  await proxy.forward({ credential: key(), requestId: "r1", path: "/v1/messages", body: enc('{"model":"m","stream":true,"max_tokens":100}') });
  const e = events[0]!;
  assert.equal(e.micros, expected);
  assert.deepEqual(
    (({ model, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, finishReason }) => ({
      model,
      tokensIn,
      tokensOut,
      cacheReadTokens,
      cacheWriteTokens,
      finishReason,
    }))(settlementCallMeta(e)),
    {
      model: "m",
      tokensIn: 1000,
      tokensOut: 50,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
      finishReason: "end_turn",
    },
  );
});

// Every model id these tests send: the credential allows them all (model_not_allowed has its own tests).
const TEST_MODELS = ["m", "ds", "nope", "big", "deepseek/deepseek-v4-pro", "DS", " ds", "ds:free", "p/ds", "ds\u0000"];
const secret = "controller-secret";
const key = () =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros: 100_000, expiresAt: 2_000, issuedAt: 1_000, models: TEST_MODELS });
function make(fetch: typeof globalThis.fetch) {
  const budget = new RequestBudget({ secret, now: () => 1_000 });
  const events: ProxySettlement[] = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50_000,
    price: createPrice(rates, "p"),
    estimateSettle: createSettleEstimate(rates, "p"),
    onSettlement: (e) => events.push(e),
    fetch,
  });
  return { proxy, events };
}

// Finding B: OpenRouter's /messages usage documents a `cost` with no request-side opt-in, and the pricer reads it from the merged stream usage
// (message_start here). These tests make that observable on the Anthropic wire: a scripted cost is charged as reported, the same stream without one is
// priced from the catalog.
test("anthropic stream: a cost on message_start is charged as reported; without it the catalog prices the same tokens", () => {
  const withCost = start({ ...startUsage, cost: 0.0042 }) + blocks + delta({ output_tokens: 50 }) + stop;
  assert.deepEqual(charge(enc(withCost), sseHeaders(), req), { micros: 4200, basis: "reported" });
  assert.deepEqual(charge(enc(full), sseHeaders(), req), { micros: expected, basis: "catalog" });
});

test("anthropic stream: a cost on message_delta or a trailing usage chunk is also charged as reported", () => {
  const inDelta = start(startUsage) + blocks + delta({ output_tokens: 50, cost: 0.0042 }) + stop;
  assert.deepEqual(charge(enc(inDelta), sseHeaders(), req), { micros: 4200, basis: "reported" });
  const trailing = `data: ${JSON.stringify({ usage: { cost: 0.0042 } })}\n\n`;
  assert.deepEqual(charge(enc(start(startUsage) + blocks + delta({ output_tokens: 50 }) + stop + trailing), sseHeaders(), req), {
    micros: 4200,
    basis: "reported",
  });
});

// Over the real HTTP fake (the Anthropic wire with a scripted `usage.cost`), through the proxy's own forward: the settled basis is
// reported when the provider sends a cost and catalog when it does not, with the proxy asking for nothing extra on the /messages route.
test("a /messages call through the fake upstream settles reported with a scripted cost and catalog without", async () => {
  const up = await FakeModelUpstream.start({
    script: {
      name: "basis",
      rules: [
        { id: "cost", when: { marker: "cost" }, reply: { kind: "text", text: "ok", usage: { input: 1000, output: 50, cost: 0.0042 } } },
        { id: "plain", when: {}, reply: { kind: "text", text: "ok", usage: { input: 1000, output: 50 } } },
      ],
    },
  });
  try {
    const events: ProxySettlement[] = [];
    const proxy = new ModelProxy({
      upstream: { baseUrl: up.baseUrl, key: "provider-secret" },
      budget: new RequestBudget({ secret, now: () => 1_000 }),
      maximumRequestMicros: 50_000,
      price: createPrice(rates, "p"),
      estimateSettle: createSettleEstimate(rates, "p"),
      onSettlement: (e) => events.push(e),
    });
    const ask = (requestId: string, system: string) =>
      proxy.forward({
        credential: key(),
        requestId,
        path: "/messages",
        body: enc(JSON.stringify({ model: "m", max_tokens: 100, stream: true, system, messages: [{ role: "user", content: "hi" }] })),
      });
    assert.equal((await ask("r1", "[[stub:cost]]")).status, 200);
    assert.equal((await ask("r2", "no marker")).status, 200);
    assert.deepEqual(
      events.map((e) => [e.requestId, e.kind, e.route, e.micros, e.basis]),
      [
        ["r1", "priced", "messages", 4200, "reported"],
        ["r2", "priced", "messages", chargeMicros(rate, { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 }), "catalog"],
      ],
    );
  } finally {
    await up.close();
  }
});
