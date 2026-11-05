import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { encodeGatewayCredential } from "../gateway.ts";
import { callFacts, capOutputTokens, createPrice, createRequestEstimate, createSettleEstimate } from "./price.ts";
import { RequestBudget } from "./request-budget.ts";
import { ClientClosed, createModelProxyServer, MODEL_BUDGET_EXHAUSTED, ModelProxy, proxyMetaOf } from "./service.ts";
import type { ModelProxyOptions, ProxySettlement } from "./service.ts";

// Spend control at the proxy: a 2xx stream cut off mid-body is charged (stream-cut), a clamped reservation forwards only the
// output it affords, the credential's model allowlist and the unmeterable Responses shapes are refused (spend-cap), and the
// provider's response id rides on the settlement (usage-join).
const secret = "controller-secret";
const now = () => 1_000;
const key = (budgetMicros = 1000, models: readonly string[] = ["m"]) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros, expiresAt: 2_000, issuedAt: 1_000, models });
const enc = (s: string) => new TextEncoder().encode(s);
const rates = new FakeRatesSource({ p: { m: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } } });
const sseHeaders = { "content-type": "text/event-stream" };
const chunk = (text: string) => enc(`data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content: text } }] })}\n\n`);

function make(fetch: NonNullable<ModelProxyOptions["fetch"]>, extra: Partial<ModelProxyOptions> = {}) {
  const budget = new RequestBudget({ secret, now });
  const events: ProxySettlement[] = [];
  const warnings: string[] = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 500,
    price: createPrice(rates, "p"),
    estimate: createRequestEstimate(rates, "p"),
    estimateSettle: createSettleEstimate(rates, "p"),
    onSettlement: (e) => events.push(e),
    warn: (m) => warnings.push(m),
    fetch,
    ...extra,
  });
  return { proxy, budget, events, warnings };
}

const remaining = (budget: RequestBudget, credential = key()): number => {
  const probe = budget.reserve(credential, `probe-${Math.random()}`, 0);
  assert.ok(probe.ok);
  budget.cancel(probe.reservation);
  return probe.remainingMicros;
};
const chat = (proxy: ModelProxy, requestId: string, body = '{"model":"m","max_tokens":10,"stream":true}', credential = key()) =>
  proxy.forward({ credential, requestId, path: "/chat/completions", body: enc(body) });

test("stream-cut: an SSE body that stalls mid-stream hits the idle deadline and is charged from the bytes received", async () => {
  const { proxy, budget, events } = make(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(chunk("lots of billed tokens"));
            // then nothing: the upstream stalls without closing (this stream also ignores the abort signal)
          },
        }),
        { headers: sseHeaders },
      ),
    { upstreamTimeoutMs: 40 },
  );
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 502);
  const error = "error" in r ? r.error : "";
  assert.match(error, /^model upstream stream cut \(stream_cut\): the 2xx response from provider\.example\/v1\/chat\/completions stopped after \d+ bytes/);
  assert.match(error, /the upstream sent nothing for 40 ms \(idle deadline model\.upstreamTimeoutMs\)/);
  assert.match(error, /charged \d+ micro-USD \(estimated from the \d+ bytes received at the model's highest rates\)/);
  assert.doesNotMatch(error, /check model\.baseUrl/);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "estimated");
  assert.equal(events[0]!.errorClass, "stream_cut");
  assert.ok(events[0]!.micros > 0);
  assert.equal(proxyMetaOf(r)?.chargedMicros, events[0]!.micros);
  assert.equal(remaining(budget), 1000 - events[0]!.micros, "charged, and the rest of the reservation released");
});

test("stream-cut: an SSE body reset by the upstream is charged, never released", async () => {
  const { proxy, budget, events } = make(
    async (_u, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(chunk("partial answer"));
            setTimeout(() => c.error(Object.assign(new Error("socket"), { code: "ECONNRESET" })), 5);
            init?.signal?.addEventListener("abort", () => c.error(init.signal?.reason));
          },
        }),
        { headers: sseHeaders },
      ),
  );
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 502);
  assert.match("error" in r ? r.error : "", /because the upstream reset or closed the connection; charged \d+ micro-USD/);
  assert.deepEqual([events[0]!.kind, events[0]!.errorClass, events[0]!.basis], ["estimated", "stream_cut", "estimated"]);
  assert.ok(events[0]!.micros > 0);
  assert.equal(remaining(budget), 1000 - events[0]!.micros);
});

test("stream-cut: a cut with nothing priceable or estimable charges the whole reservation", async () => {
  const { proxy, budget, events } = make(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(chunk("x"));
            setTimeout(() => c.error(Object.assign(new Error("socket"), { code: "ECONNRESET" })), 5);
          },
        }),
        { headers: sseHeaders },
      ),
    { estimateSettle: undefined },
  );
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 502);
  assert.match("error" in r ? r.error : "", /\(the whole reservation, since nothing received could be priced or estimated\)/);
  assert.deepEqual([events[0]!.kind, events[0]!.errorClass, events[0]!.basis], ["reserve", "stream_cut", "reserve"]);
  assert.ok(events[0]!.micros > 0);
  assert.equal(remaining(budget), 1000 - events[0]!.micros);
});

test("stream-cut: usage the stream reported before the cut is priced", async () => {
  const usage = enc(`data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
  const { proxy, events } = make(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(usage);
            setTimeout(() => c.error(Object.assign(new Error("socket"), { code: "ECONNRESET" })), 5);
          },
        }),
        { headers: sseHeaders },
      ),
  );
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 502);
  assert.match("error" in r ? r.error : "", /charged 50 micro-USD \(from the usage the stream reported before the cut\)/);
  assert.deepEqual([events[0]!.kind, events[0]!.errorClass, events[0]!.micros, events[0]!.basis], ["priced", "stream_cut", 50, "catalog"]);
});

test("stream-cut: a provider cost the stream reported before the cut is charged as reported", async () => {
  const usage = enc(`data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.000125 } })}\n\n`);
  const { proxy, events } = make(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(usage);
            setTimeout(() => c.error(Object.assign(new Error("socket"), { code: "ECONNRESET" })), 5);
          },
        }),
        { headers: sseHeaders },
      ),
  );
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 502);
  assert.deepEqual([events[0]!.kind, events[0]!.errorClass, events[0]!.micros, events[0]!.basis], ["priced", "stream_cut", 125, "reported"]);
  assert.equal(proxyMetaOf(r)?.basis, "reported");
});

test("stream-cut: the deadline is idle, not total; a slow stream that keeps sending completes", async () => {
  const usage = `data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`;
  const { proxy, events } = make(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            for (let i = 0; i < 6; i++) {
              c.enqueue(chunk(`t${i}`));
              await new Promise((r) => setTimeout(r, 50));
            }
            c.enqueue(enc(usage));
            c.close();
          },
        }),
        { headers: sseHeaders },
      ),
    { upstreamTimeoutMs: 200 },
  );
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 200, "about 300 ms in total, never 200 ms idle");
  assert.deepEqual([events[0]!.kind, events[0]!.errorClass, events[0]!.micros], ["priced", undefined, 50]);
});

test("stream-cut: no response headers within the deadline still releases the whole reservation", async () => {
  const { proxy, budget, events } = make((_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal?.reason))), {
    upstreamTimeoutMs: 20,
  });
  const r = await chat(proxy, "r1");
  assert.match("error" in r ? r.error : "", /^model upstream timed out \(timeout\): no response headers from /);
  assert.deepEqual([events[0]!.kind, events[0]!.micros, events[0]!.errorClass], ["failed", 0, "timeout"]);
  assert.equal(remaining(budget), 1000);
});

test("spend-cap: a reservation clamped to the remaining budget rewrites max_tokens to what it affords (cap 1000 holds)", async () => {
  let forwarded: Record<string, unknown> = {};
  const { proxy, budget, events } = make(async (_u, init) => {
    forwarded = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"));
    // The upstream generates every token it was allowed.
    const out = forwarded.max_tokens as number;
    return new Response(JSON.stringify({ id: "chatcmpl-9", usage: { prompt_tokens: 8, completion_tokens: out } }), {
      headers: { "content-type": "application/json" },
    });
  });
  const r = await chat(proxy, "r1", '{"model":"m","max_tokens":99999}');
  assert.equal(r.status, 200);
  const limit = forwarded.max_tokens as number;
  assert.ok(limit < 99999 && limit >= 256, `forwarded max_tokens ${limit}`);
  assert.ok(events[0]!.micros <= 1000, `settled ${events[0]!.micros} within the 1000 cap`);
  assert.ok(remaining(budget) >= 0);
  // A reservation that is not clamped forwards the limit unchanged.
  const roomy = make(async (_u, init) => {
    forwarded = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"));
    return new Response('{"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  });
  await chat(roomy.proxy, "r2", '{"model":"m","max_tokens":100}');
  assert.equal(forwarded.max_tokens, 100);
});

test("spend-cap: capOutputTokens lowers every present limit field, never raises one, and honours n", () => {
  const body = enc(JSON.stringify({ model: "m", max_tokens: 1000, max_completion_tokens: 50 }));
  const estimate = {
    reserveMicros: 10 + 2 * 1000 * 2,
    floorMicros: 10 + 2 * 256 * 2,
    output: { promptMicros: 10, microsPerToken: 2, multiplier: 2, fields: ["max_tokens", "max_completion_tokens"] },
  };
  const out = capOutputTokens(body, estimate, 1010);
  assert.ok("body" in out);
  assert.deepEqual(JSON.parse(Buffer.from(out.body).toString("utf8")), { model: "m", max_tokens: 250, max_completion_tokens: 50 }); // (1010 - 10) / (2 * 2)
  assert.deepEqual(capOutputTokens(body, estimate, estimate.reserveMicros), { body }, "unclamped: forwarded byte for byte");
  assert.deepEqual(capOutputTokens(body, { reserveMicros: 50, floorMicros: 50 }, 10), { body }, "no output term (fixed amount): unchanged");
});

test("spend-cap: Responses (max_output_tokens) and Anthropic (max_tokens) limits are lowered on their own endpoints", async () => {
  for (const [path, field] of [
    ["/responses", "max_output_tokens"],
    ["/messages", "max_tokens"],
  ] as const) {
    let forwarded: Record<string, unknown> = {};
    const { proxy } = make(async (_u, init) => {
      forwarded = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      return new Response('{"usage":{"input_tokens":1,"output_tokens":1}}');
    });
    await proxy.forward({ credential: key(), requestId: "r1", path, body: enc(JSON.stringify({ model: "m", [field]: 99999 })) });
    assert.ok((forwarded[field] as number) < 500, `${path} ${field}=${forwarded[field]}`);
  }
});

test("spend-cap: a model outside the credential's allowlist is refused with model_not_allowed, before reserving or calling upstream", async () => {
  let calls = 0;
  const { proxy, budget, events, warnings } = make(async () => (calls++, new Response("{}")));
  const other = await chat(proxy, "r1", '{"model":"gpt-x","max_tokens":10}', key(1000, ["m", "m2"]));
  assert.deepEqual(other, {
    status: 400,
    error: `model not allowed (model_not_allowed): this agent's credential allows only "m", "m2", not model "gpt-x"; use an allowed model, or have the operator grant the model to the agent's template`,
  });
  assert.equal(proxyMetaOf(other)?.errorClass, "model_not_allowed");
  const none = await chat(proxy, "r2", '{"model":"m","max_tokens":10}', key(1000, []));
  assert.match("error" in none ? none.error : "", /credential allows no models, not model "m";/);
  const unnamed = await chat(proxy, "r3", '{"max_tokens":10}');
  assert.match("error" in unnamed ? unnamed.error : "", /not a request that names no model;/);
  await chat(proxy, "r4", '{"model":"gpt-x","max_tokens":10}', key(1000, ["m", "m2"]));
  assert.equal(calls, 0);
  assert.equal(events.length, 0);
  assert.equal(remaining(budget), 1000);
  assert.equal(warnings.filter((w) => w.includes('"gpt-x"')).length, 1, "the operator is warned once per agent and model");
  assert.match(warnings[0]!, /^pomtreed: WARNING: agent agent-1 was refused a model call: model not allowed \(model_not_allowed\)/);
  // The refused request id was not burned.
  assert.equal((await chat(proxy, "r1", '{"model":"m","max_tokens":10}')).status, 200); // "{}" is estimated; it reached the upstream
  assert.equal(calls, 1);
});

test("spend-cap: /responses with background, previous_response_id or conversation is refused as unsupported_request", async () => {
  let calls = 0;
  const { proxy } = make(async () => (calls++, new Response('{"usage":{"input_tokens":1,"output_tokens":1}}')));
  for (const [name, extra] of [
    ["background", { background: true }],
    ["previous_response_id", { previous_response_id: "resp_1" }],
    ["conversation", { conversation: "conv_1" }],
  ] as const) {
    const r = await proxy.forward({
      credential: key(),
      requestId: name,
      path: "/v1/responses",
      body: enc(JSON.stringify({ model: "m", max_output_tokens: 5, ...extra })),
    });
    assert.equal(r.status, 400, name);
    assert.match("error" in r ? r.error : "", new RegExp(`^unsupported model request \\(unsupported_request\\): /responses with ${name} is not allowed`));
    assert.equal(proxyMetaOf(r)?.errorClass, "unsupported_request");
  }
  const fg = await proxy.forward({
    credential: key(),
    requestId: "fg",
    path: "/responses",
    body: enc(JSON.stringify({ model: "m", max_output_tokens: 5, background: false, previous_response_id: null })),
  });
  assert.equal(fg.status, 200);
  // The same fields on chat completions are not Responses state and pass.
  assert.equal((await chat(proxy, "chat", '{"model":"m","max_tokens":5,"background":true}')).status, 200);
  assert.equal(calls, 2);
});

test("spend-cap: Responses usage is priced from response.completed (stream) and the body (cached input excluded)", () => {
  const charge = createPrice(rates, "p");
  const price = (...args: Parameters<typeof charge>) => charge(...args)?.micros ?? null;
  const req = enc('{"model":"m","max_output_tokens":100,"stream":true}');
  const usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } };
  const sse = [
    { type: "response.created", response: { id: "resp_7", status: "in_progress", usage: null } },
    { type: "response.output_text.delta", delta: "hi" },
    { type: "response.completed", response: { id: "resp_7", status: "completed", usage } },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  // 60 uncached input at 1, 40 cached at 0.5, 20 output at 2.
  assert.equal(price(enc(sse), new Headers(sseHeaders), req), 60 + 20 + 40);
  assert.equal(price(enc(JSON.stringify({ id: "resp_7", usage })), new Headers({ "content-type": "application/json" }), req), 120);
  assert.deepEqual(callFacts(enc(sse), new Headers(sseHeaders)), {
    responseId: "resp_7",
    tokensIn: 100,
    tokensOut: 20,
    cacheReadTokens: 40,
    finishReason: "completed",
  });
  // A stream cut before response.completed has no usage to price.
  assert.equal(price(enc(sse.slice(0, sse.indexOf("event: response.completed"))), new Headers(sseHeaders), req), null);
});

test("usage-join: the settlement carries the provider's response id from a chat stream and a JSON body", async () => {
  const stream = `${new TextDecoder().decode(chunk("hi"))}data: ${JSON.stringify({ id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
  const s = make(async () => new Response(stream, { headers: sseHeaders }));
  assert.equal((await chat(s.proxy, "r1")).status, 200);
  assert.equal(s.events[0]!.responseId, "chatcmpl-1");
  const j = make(async () => new Response('{"id":"msg_01","usage":{"input_tokens":1,"output_tokens":1}}', { headers: { "content-type": "application/json" } }));
  await j.proxy.forward({ credential: key(), requestId: "r1", path: "/v1/messages", body: enc('{"model":"m","max_tokens":5}') });
  assert.equal(j.events[0]!.responseId, "msg_01");
});

test("review(2): /responses with a stored prompt or an input item reference is refused as unsupported_request", async () => {
  let calls = 0;
  const { proxy } = make(async () => (calls++, new Response('{"usage":{"input_tokens":1,"output_tokens":1}}')));
  const send = (requestId: string, extra: Record<string, unknown>) =>
    proxy.forward({ credential: key(), requestId, path: "/responses", body: enc(JSON.stringify({ model: "m", max_output_tokens: 5, ...extra })) });
  for (const [requestId, extra, name] of [
    ["p", { prompt: { id: "pmpt_1" } }, "a stored prompt"],
    [
      "i1",
      {
        input: [
          { role: "user", content: "hi" },
          { type: "item_reference", id: "msg_1" },
        ],
      },
      "an input item_reference",
    ],
    ["i2", { input: [{ id: "msg_1" }] }, "an input item_reference"],
  ] as const) {
    const r = await send(requestId, extra);
    assert.equal(r.status, 400, requestId);
    assert.match("error" in r ? r.error : "", new RegExp(`^unsupported model request \\(unsupported_request\\): /responses with ${name} is not allowed`));
  }
  const inline = await send("ok", {
    input: [
      { role: "user", content: "hi" },
      { type: "reasoning", id: "rs_1", summary: [] },
    ],
  });
  assert.equal(inline.status, 200, "inline items (with a role or a content type) pass");
  assert.equal(calls, 1);
});

test("review(3): an OpenRouter `models` fallback list is refused unless every entry is allowed", async () => {
  let calls = 0;
  const { proxy } = make(async () => (calls++, new Response('{"usage":{"prompt_tokens":1,"completion_tokens":1}}')));
  const credential = key(1000, ["m", "m2"]);
  const bad = await chat(proxy, "r1", JSON.stringify({ model: "m", models: ["m", "gpt-x"], route: "fallback", max_tokens: 5 }), credential);
  assert.equal(bad.status, 400);
  assert.match("error" in bad ? bad.error : "", /^model not allowed \(model_not_allowed\): the fallback list `models` names model "gpt-x"/);
  assert.equal(proxyMetaOf(bad)?.errorClass, "model_not_allowed");
  const shape = await chat(proxy, "r2", JSON.stringify({ model: "m", models: "gpt-x", max_tokens: 5 }), credential);
  assert.match("error" in shape ? shape.error : "", /the fallback list `models` is not a list of model ids;/);
  const ok = await chat(proxy, "r3", JSON.stringify({ model: "m", models: ["m", "m2"], route: "fallback", max_tokens: 5 }), credential);
  assert.equal(ok.status, 200);
  assert.equal(calls, 1);
});

test("review(4): a lowered Anthropic max_tokens also lowers thinking.budget_tokens below it, or refuses when under the minimum", async () => {
  let forwarded: Record<string, unknown> = {};
  let calls = 0;
  const upstream = async (_u: unknown, init?: RequestInit) => {
    calls++;
    forwarded = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"));
    return new Response('{"usage":{"input_tokens":1,"output_tokens":1}}');
  };
  const body = enc(JSON.stringify({ model: "m", max_tokens: 99999, thinking: { type: "enabled", budget_tokens: 50000 } }));
  const roomy = await make(upstream).proxy.forward({ credential: key(10_000), requestId: "r1", path: "/v1/messages", body });
  assert.equal(roomy.status, 200);
  const max = forwarded.max_tokens as number;
  assert.ok(max < 99999 && max > 1024, String(max));
  assert.deepEqual(forwarded.thinking, { type: "enabled", budget_tokens: max - 1 });
  const tightProxy = make(upstream);
  const tight = await tightProxy.proxy.forward({ credential: key(1000), requestId: "r2", path: "/v1/messages", body });
  assert.equal(tight.status, 402);
  const error = "error" in tight ? tight.error : "";
  assert.ok(error.startsWith(`${MODEL_BUDGET_EXHAUSTED}: `), error);
  assert.match(
    error,
    /so max_tokens was clamped to \d+, which leaves no room for thinking\.budget_tokens 50000 \(it must be below max_tokens and at least 1024\); disable thinking or lower its budget, or raise the agent's budget$/,
  );
  assert.equal(calls, 1, "the refused call never reached the upstream");
  assert.equal(remaining(tightProxy.budget), 1000, "its reservation was released");
});

test("review(5): a 2xx body that cannot be read at all charges the whole reservation and clears the idle timer", async () => {
  const unreadable = {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: {
      getReader() {
        throw new TypeError("ReadableStream is locked");
      },
    },
  } as unknown as Response;
  const { proxy, budget, events } = make(async () => unreadable, { upstreamTimeoutMs: 60_000 });
  const r = await chat(proxy, "r1");
  assert.equal(r.status, 502);
  assert.match(
    "error" in r ? r.error : "",
    /^model upstream response unreadable \(malformed_response\): the 2xx body from provider\.example\/v1\/chat\/completions could not be read; the whole reservation \(\d+ micro-USD\) was charged/,
  );
  assert.deepEqual([events[0]!.kind, events[0]!.errorClass], ["reserve", "malformed_response"]);
  assert.equal(remaining(budget), 1000 - events[0]!.micros);
  // A leaked 60 s idle timer would hold the test process open past --test-timeout; reaching here and exiting proves it was cleared.
});

test("review(6): Responses usage with input_tokens_details but no cached_tokens prices the cached count as 0", () => {
  const price = (...args: Parameters<ReturnType<typeof createPrice>>) => createPrice(rates, "p")(...args)?.micros ?? null;
  const req = enc('{"model":"m","max_output_tokens":5}');
  const json = new Headers({ "content-type": "application/json" });
  for (const details of [{}, { cached_tokens: null }])
    assert.equal(
      price(enc(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: details } })), json, req),
      14,
      JSON.stringify(details),
    );
});

test("review(7): a settle the debit store refuses answers 502 naming the cause and action, and warns the operator", async () => {
  const inner = new RequestBudget({ secret, now });
  const warnings: string[] = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget: {
      reserve: (k, id, m) => inner.reserve(k, id, m),
      settle: () => ({ ok: false, reason: "unknown-reservation" }),
      cancel: (r) => inner.cancel(r),
      authorize: (k) => inner.authorize(k),
    },
    maximumRequestMicros: 500,
    price: () => ({ micros: 7, basis: "catalog" }),
    warn: (m) => warnings.push(m),
    fetch: async () => new Response("{}"),
  });
  const r = await chat(proxy, "r1");
  assert.deepEqual(r, {
    status: 502,
    error:
      'model charge rejected (unknown-reservation): the upstream answered but the debit store refused its 7 micro-USD charge for request id "r1", so the response is withheld; retry with a fresh request id, and if it repeats the operator must check the debit ledger for this agent',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^pomtreed: WARNING: agent agent-1: model charge rejected \(unknown-reservation\)/);
});

test("review(7): the HTTP server echoes x-pomtree-request-id on its early 401 and 413 refusals", async () => {
  const { proxy } = make(async () => new Response("{}"), { maxBodyBytes: 64 });
  const server = createModelProxyServer(proxy);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const post = (headers: Record<string, string>, body: string) =>
    new Promise<{ status: number; echoed: unknown }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/chat/completions", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, echoed: res.headers["x-pomtree-request-id"] }));
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    assert.deepEqual(await post({ "x-pomtree-request-id": "no-cred" }, "{}"), { status: 401, echoed: "no-cred" });
    assert.deepEqual(await post({ authorization: `Bearer ${key()}`, "x-pomtree-request-id": "big" }, "x".repeat(100)), { status: 413, echoed: "big" });
    assert.deepEqual(await post({ authorization: `Bearer ${key()}` }, "{}"), { status: 401, echoed: undefined }, "no id to echo");
  } finally {
    server.close();
  }
});

test("review(1): a stream active longer than the reclaim age is touched and not reclaimed; without touch it would be", async () => {
  const run = async (withTouch: boolean) => {
    let clock = 1_000;
    const inner = new RequestBudget({ secret, now: () => clock });
    const budget: ModelProxyOptions["budget"] = {
      reserve: (k, id, m) => inner.reserve(k, id, m),
      settle: (r, c) => inner.settle(r, c),
      cancel: (r) => inner.cancel(r),
      authorize: (k) => inner.authorize(k),
      ...(withTouch && { touch: (r) => inner.touch(r) }),
    };
    const usage = `data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`;
    const proxy = new ModelProxy({
      upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
      budget,
      maximumRequestMicros: 500,
      price: createPrice(rates, "p"),
      estimate: createRequestEstimate(rates, "p"),
      upstreamTimeoutMs: 100,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              for (let i = 0; i < 4; i++) {
                c.enqueue(chunk(`t${i}`));
                await new Promise((r) => setTimeout(r, 60));
                // The store's clock runs 150 per chunk (600 in all) against a reclaim age of 2 x 100.
                clock += 150;
                inner.expireReservations(200);
              }
              c.enqueue(enc(usage));
              c.close();
            },
          }),
          { headers: sseHeaders },
        ),
    });
    const credential = key(1000, ["m"]);
    const r = await proxy.forward({ credential, requestId: "r1", path: "/chat/completions", body: enc('{"model":"m","max_tokens":300,"stream":true}') });
    assert.equal(r.status, 200);
    const probe = inner.reserve(credential, "probe", 0);
    assert.ok(probe.ok);
    return probe.remainingMicros;
  };
  assert.equal(await run(true), 1000 - 50, "touched: charged its priced 50 only");
  assert.ok((await run(false)) < 1000 - 50, "negative control: untouched, reclaim charged the whole reservation mid-stream");
});

// Sends one request through a real proxy server, destroys the client after `afterMs`, and returns the settlement and how long
// after the disconnect it landed.
async function disconnectAfter(fetch: NonNullable<ModelProxyOptions["fetch"]>, afterMs: number) {
  const settledAt: number[] = [];
  const events: ProxySettlement[] = [];
  const f = make(fetch, { onSettlement: (e) => (events.push(e), settledAt.push(Date.now())) });
  const server = createModelProxyServer(f.proxy);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const req = request({
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      method: "POST",
      path: "/chat/completions",
      headers: { authorization: `Bearer ${key()}`, "x-pomtree-request-id": "r1" },
    });
    req.on("error", () => {});
    req.end('{"model":"m","max_tokens":300,"stream":true}');
    await new Promise((r) => setTimeout(r, afterMs));
    const closedAt = Date.now();
    req.destroy();
    for (let i = 0; i < 200 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(events[0], "settled");
    return { event: events[0], lagMs: settledAt[0]! - closedAt, budget: f.budget };
  } finally {
    server.close();
  }
}

test("proxy-abort: an agent disconnecting mid-stream aborts the upstream and settles at once from the bytes received", async () => {
  let upstreamAborted = false;
  const { event, lagMs, budget } = await disconnectAfter(async (_u, init) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          // A slow upstream: 20 s of chunks, 100 ms apart.
          let n = 0;
          timer = setInterval(() => (n++ < 200 ? c.enqueue(chunk(`t${n}`)) : (clearInterval(timer), c.close())), 100);
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            clearInterval(timer);
            c.error(init.signal?.reason);
          });
        },
      }),
      { headers: sseHeaders },
    );
  }, 350);
  assert.ok(lagMs < 500, `settled ${lagMs} ms after the client went away`);
  assert.ok(upstreamAborted, "the upstream call was aborted");
  assert.deepEqual([event.kind, event.errorClass], ["estimated", "stream_cut"]);
  assert.ok(event.micros > 0, "charged from the chunks received, never free");
  assert.equal(remaining(budget), 1000 - event.micros);
});

test("proxy-abort: an agent disconnecting before the upstream answered releases the reservation at once", async () => {
  let upstreamAborted = false;
  const { event, lagMs, budget } = await disconnectAfter(
    (_u, init) =>
      new Promise<Response>((_res, rej) =>
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
          rej(init.signal?.reason);
        }),
      ),
    100,
  );
  assert.ok(lagMs < 500, `settled ${lagMs} ms after the client went away`);
  assert.ok(upstreamAborted);
  assert.deepEqual([event.kind, event.micros, event.errorClass], ["failed", 0, "aborted"]);
  assert.equal(remaining(budget), 1000);
});

test("proxy-abort: forward with an aborted signal names the client in its messages", async () => {
  const signal = AbortSignal.abort(new ClientClosed());
  const { proxy } = make((_u, init) => Promise.reject(init?.signal?.reason));
  const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m","max_tokens":5}'), signal });
  assert.deepEqual(r, {
    status: 502,
    error:
      "model call cancelled (aborted): the agent's client closed the connection before provider.example/v1/chat/completions answered; nothing was generated, so the reservation was released",
  });
});
