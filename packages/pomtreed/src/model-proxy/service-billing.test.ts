import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { encodeGatewayCredential } from "../gateway.ts";
import { createPrice, createSettleEstimate } from "./price.ts";
import { RequestBudget } from "./request-budget.ts";
import { ModelProxy, proxyMetaOf } from "./service.ts";
import type { ProxySettlement } from "./service.ts";

// Every model id these tests send: the credential allows them all (model_not_allowed has its own tests).
const TEST_MODELS = ["m", "ds", "nope", "big", "deepseek/deepseek-v4-pro", "DS", " ds", "ds:free", "p/ds", "ds\u0000"];
const secret = "controller-secret";
const now = () => 1_000;
const key = (budgetMicros = 1000) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros, expiresAt: 2_000, issuedAt: 1_000, models: TEST_MODELS });
const enc = (s: string) => new TextEncoder().encode(s);
const rates = new FakeRatesSource({ p: { m: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });

function make(fetch: NonNullable<ConstructorParameters<typeof ModelProxy>[0]["fetch"]>, extra: Partial<ConstructorParameters<typeof ModelProxy>[0]> = {}) {
  const budget = new RequestBudget({ secret, now });
  const events: ProxySettlement[] = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 500,
    price: createPrice(rates, "p"),
    estimateSettle: createSettleEstimate(rates, "p"),
    onSettlement: (e) => events.push(e),
    fetch,
    ...extra,
  });
  return { proxy, budget, events };
}

test("a path outside the allowlist is refused with no upstream call and no reservation", async () => {
  const { proxy, budget } = make(async () => {
    throw new Error("must not call");
  });
  for (const path of ["/files", "/batches", "/fine_tuning/jobs", "/v1/images/generations", "/chat/completions/extra", "/chat/completions/../files"]) {
    assert.deepEqual(await proxy.forward({ credential: key(), requestId: "r1", path, body: enc('{"model":"m"}') }), {
      status: 400,
      error: path.includes("..") ? "invalid model proxy request" : "model proxy path not allowed",
    });
  }
  assert.equal(budget.reserve(key(), "r2", 1000).ok, true); // nothing was reserved
});

test("default allowlist covers the inference endpoints, with or without /v1 and a query", async () => {
  const seen: string[] = [];
  const { proxy } = make(async (url) => {
    seen.push(String(url));
    return new Response('{"usage":{"cost":0.000001}}', { headers: { "content-type": "application/json" } });
  });
  for (const [i, path] of ["/chat/completions", "/responses", "/messages", "/completions", "/v1/messages", "/chat/completions?x=1"].entries())
    assert.equal((await proxy.forward({ credential: key(), requestId: `r${i}`, path, body: enc('{"model":"m"}') })).status, 200);
  assert.equal(seen.length, 6);
});

test("allowedPaths is configurable", async () => {
  const { proxy } = make(async () => new Response('{"usage":{"cost":0}}'), { allowedPaths: ["/only"] });
  assert.equal((await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m"}') })).status, 400);
  assert.equal((await proxy.forward({ credential: key(), requestId: "r2", path: "/only", body: enc('{"model":"m"}') })).status, 200);
});

test("only allowlisted request headers are forwarded; auth is the injected key", async () => {
  let seen = new Headers();
  const { proxy } = make(async (_u, init) => {
    seen = new Headers(init?.headers);
    return new Response('{"usage":{"cost":0}}');
  });
  await proxy.forward({
    credential: key(),
    requestId: "r1",
    path: "/messages",
    headers: new Headers({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "x",
      cookie: "c=1",
      "x-forwarded-for": "1.2.3.4",
      "openai-organization": "org",
      authorization: "Bearer agent",
    }),
    body: enc('{"model":"m"}'),
  });
  assert.deepEqual([...seen.keys()].sort(), ["anthropic-beta", "anthropic-version", "authorization", "content-type"]);
  assert.equal(seen.get("authorization"), "Bearer provider-secret");
});

test("a streaming chat request is asked for usage; other bodies are untouched", async () => {
  const bodies: string[] = [];
  const { proxy } = make(async (_u, init) => {
    bodies.push(Buffer.from(init?.body as Buffer).toString());
    return new Response('{"usage":{"cost":0}}');
  });
  await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m","stream":true}') });
  await proxy.forward({
    credential: key(),
    requestId: "r2",
    path: "/chat/completions",
    body: enc('{"model":"m","stream":true,"stream_options":{"include_usage":false,"k":1}}'),
  });
  await proxy.forward({ credential: key(), requestId: "r3", path: "/chat/completions", body: enc('{"model":"m"}') });
  await proxy.forward({ credential: key(), requestId: "r4", path: "/messages", body: enc('{"model":"m","stream":true}') });
  assert.deepEqual(JSON.parse(bodies[0]!), { model: "m", stream: true, stream_options: { include_usage: true } });
  assert.deepEqual(JSON.parse(bodies[1]!).stream_options, { include_usage: true, k: 1 });
  assert.equal(bodies[2], '{"model":"m"}');
  assert.equal(bodies[3], '{"model":"m","stream":true}');
});

test("a 2xx with no usage is charged an estimate (not the reservation), returned, and reported as estimated", async () => {
  const sse = `data: ${JSON.stringify({ id: "x", choices: [{ delta: { content: "hello world!" } }] })}\n\ndata: [DONE]\n\n`; // 12 chars -> 3 tokens
  const { proxy, budget, events } = make(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  const body = enc('{"model":"m","stream":true,"max_tokens":100000}');
  const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body });
  assert.ok("body" in r && r.status === 200);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "estimated");
  assert.ok(events[0]!.micros >= 1 && events[0]!.micros < 100, `estimate ${events[0]!.micros}`);
  // the reservation (clamped to the 1000 budget) was settled to the estimate, not burned
  assert.equal(budget.reserve(key(), "r2", 1000 - events[0]!.micros).ok, true);
});

test("the estimate never exceeds the reservation and is never zero", async () => {
  const huge = "y".repeat(50_000);
  const big = make(async () => new Response(`{"c":"${huge}"}`), { maximumRequestMicros: 100 });
  const r = await big.proxy.forward({ credential: key(100), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m","max_tokens":10}') });
  assert.equal(r.status, 200);
  assert.ok(big.events[0]!.micros <= 100 && big.events[0]!.micros >= 1);
  const tiny = make(async () => new Response("{}"), { maximumRequestMicros: 100 });
  await tiny.proxy.forward({ credential: key(100), requestId: "r1", path: "/chat/completions", body: enc('{"model":"nope"}') });
  // unknown model (no rates): falls back to the full reservation, response withheld
  assert.equal(tiny.events[0]!.kind, "reserve");
  assert.equal(tiny.events[0]!.micros, 100); // clamped to the credential budget
});

test("reported usage still wins over the estimate, and a replayed request id cannot settle twice", async () => {
  const { proxy, events } = make(
    async () => new Response('{"usage":{"prompt_tokens":10,"completion_tokens":20}}', { headers: { "content-type": "application/json" } }),
  );
  const body = enc('{"model":"m"}');
  assert.equal((await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body })).status, 200);
  assert.deepEqual(
    events.map((e) => [e.kind, e.micros]),
    [["priced", 50]],
  );
  assert.equal((await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body })).status, 409);
});

test("a throwing pricer or estimator settles the reservation in full at once and returns 502", async () => {
  for (const which of ["price", "estimateSettle"] as const) {
    const throwing = () => {
      throw new Error("boom");
    };
    const { proxy, budget, events } = make(
      async () => new Response('{"usage":{}}'),
      which === "price" ? { price: throwing } : { price: () => null, estimateSettle: throwing },
    );
    const res = await proxy.forward({ credential: key(1000), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m"}') });
    assert.equal(res.status, 502);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["reserve"],
    );
    // Nothing left reserved: the reservation was charged (500), so exactly 500 remains.
    assert.equal(budget.expireReservations(0), 0);
    assert.equal(budget.reserve(key(1000), "r2", 500).ok, true);
    assert.equal(budget.reserve(key(1000), "r3", 1).ok, false);
  }
});

test("upstream auth header follows authStyle and the caller's x-api-key is never forwarded", async () => {
  const cases: [ConstructorParameters<typeof ModelProxy>[0]["authStyle"], string | null, string | null][] = [
    [undefined, "Bearer provider-secret", null],
    ["bearer", "Bearer provider-secret", null],
    ["x-api-key", null, "provider-secret"],
    ["both", "Bearer provider-secret", "provider-secret"],
  ];
  for (const [authStyle, auth, apiKey] of cases) {
    let seen: Headers | undefined;
    const { proxy } = make(
      async (_url, init) => {
        seen = new Headers(init?.headers);
        return new Response('{"usage":{"cost":0}}');
      },
      authStyle === undefined ? {} : { authStyle },
    );
    const headers = new Headers({ authorization: "Bearer caller", "x-api-key": "caller-key", "content-type": "application/json" });
    assert.equal((await proxy.forward({ credential: key(), requestId: "r1", path: "/messages", headers, body: enc('{"model":"m"}') })).status, 200);
    assert.equal(seen?.get("authorization") ?? null, auth);
    assert.equal(seen?.get("x-api-key") ?? null, apiKey);
  }
});

test("path bypass variants are refused with no reservation and no upstream call", async () => {
  const { proxy, budget } = make(async () => {
    throw new Error("must not call");
  });
  const paths = [
    "/Chat/Completions",
    "//chat/completions",
    "/chat%2Fcompletions",
    "/chat/completions/../files",
    "/%63hat/completions",
    "/chat/completions.",
    "/chat/completions%20",
    "/chat/completions ",
    "/chat/completions%00",
    "/chat/./completions/x",
    "/chat/completions;x",
    "\\chat\\completions",
  ];
  for (const path of paths) {
    const res = await proxy.forward({ credential: key(), requestId: "r1", path, body: enc('{"model":"m"}') });
    assert.equal(res.status, 400, path);
  }
  assert.equal(budget.reserve(key(), "r2", 1000).ok, true); // nothing was reserved
});

test("the settle estimate counts UTF-8 bytes, not UTF-16 units", () => {
  const est = createSettleEstimate(rates, "p");
  const req = enc(JSON.stringify({ model: "m" }));
  const sse = (t: string) => enc(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n`);
  const h = new Headers({ "content-type": "text/event-stream" });
  const ascii = est(sse("a".repeat(300)), h, req)!;
  const cjk = est(sse("字".repeat(300)), h, req)!; // 3 bytes each
  assert.ok(cjk > ascii * 2, `${cjk} vs ${ascii}`);
});

test("a priced settlement reports call metadata (tokens, finish reason, upstream status, latency) and the charge is unchanged", async () => {
  const body = '{"model":"m","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}';
  const { proxy, budget, events } = make(async () => new Response(body, { headers: { "content-type": "application/json" } }));
  const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m"}') });
  assert.equal(r.status, 200);
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.kind, "priced");
  assert.deepEqual(
    { model: e.model, in: e.tokensIn, out: e.tokensOut, fr: e.finishReason, st: e.upstreamStatus, micros: e.micros },
    { model: "m", in: 100, out: 50, fr: "stop", st: 200, micros: 200 },
  );
  assert.ok(typeof e.latencyMs === "number" && e.latencyMs >= 0);
  const probe = budget.reserve(key(), "probe", 0);
  assert.ok(probe.ok && probe.remainingMicros === 800, "the ledger is charged once, by the settlement amount");
});

const failedFacts = (e: ProxySettlement) => ({
  kind: e.kind,
  micros: e.micros,
  model: e.model,
  st: e.upstreamStatus,
  ec: e.errorClass,
  route: e.route,
  agent: e.agent,
});
const assertFree = (budget: RequestBudget) => {
  const probe = budget.reserve(key(), "probe", 0);
  assert.ok(probe.ok && probe.remainingMicros === 1000, "a failed call charges nothing and holds nothing");
};

test("a non-2xx upstream reports one failed event with status, class and route, and charges nothing", async () => {
  for (const [status, ec] of [
    [404, "not_found"],
    [418, "upstream_4xx"],
    [503, "upstream_5xx"],
  ] as const) {
    const { proxy, budget, events } = make(async () => new Response('{"error":"upstream said no","key":"sk-or-v1-0123456789abcdef"}', { status }));
    const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/v1/messages?x=1", body: enc('{"model":"m","messages":"hello"}') });
    assert.equal(r.status, status);
    assert.equal(events.length, 1);
    assert.deepEqual(failedFacts(events[0]!), { kind: "failed", micros: 0, model: "m", st: status, ec, route: "messages", agent: "agent-1" });
    assert.ok(typeof events[0]!.latencyMs === "number");
    // The upstream's own message is journaled (scrubbed and bounded); the rest of its body and the request body are not.
    assert.equal(events[0]!.upstreamMessage, "upstream said no");
    assert.deepEqual([events[0]!.upstreamHost, events[0]!.upstreamPath], ["provider.example", "/v1/v1/messages"]);
    assert.equal(JSON.stringify(events[0]).includes("sk-or-v1"), false);
    assert.equal(JSON.stringify(events[0]).includes("x=1"), false);
    assert.equal(JSON.stringify(events[0]).includes("hello"), false);
    assertFree(budget);
  }
});

test("a transport error and a timeout each report one failed event with no status", async () => {
  const cases: [string, typeof globalThis.fetch, string, Partial<ConstructorParameters<typeof ModelProxy>[0]>][] = [
    [
      "transport",
      async () => {
        throw new TypeError("fetch failed");
      },
      "transport",
      {},
    ],
    [
      "timeout",
      (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal?.reason))),
      "timeout",
      { upstreamTimeoutMs: 10 },
    ],
  ];
  for (const [, fetch, ec, extra] of cases) {
    const { proxy, budget, events } = make(fetch, extra);
    const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m"}') });
    assert.equal(r.status, 502);
    assert.equal(events.length, 1);
    assert.deepEqual(failedFacts(events[0]!), { kind: "failed", micros: 0, model: "m", st: undefined, ec, route: "chat_completions", agent: "agent-1" });
    assert.ok(typeof events[0]!.latencyMs === "number");
    assertFree(budget);
  }
});

test("a non-JSON request body names no allowed model and is refused before any event, and a 2xx event carries its route", async () => {
  const f = make(async () => new Response("x", { status: 404 }));
  const refused = await f.proxy.forward({ credential: key(), requestId: "r1", path: "/responses", body: enc("not json") });
  assert.equal(refused.status, 400);
  assert.match("error" in refused ? refused.error : "", /^model not allowed \(model_not_allowed\): .* not a request that names no model;/);
  assert.equal(f.events.length, 0);
  const ok = make(async () => new Response('{"usage":{"cost":0.000001}}', { headers: { "content-type": "application/json" } }));
  await ok.proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc('{"model":"m"}') });
  assert.equal(ok.events[0]!.kind, "priced");
  assert.equal(ok.events[0]!.route, "chat_completions");
  assert.equal(ok.events[0]!.errorClass, undefined);
});

test("the upstream fetch gets {agent, requestId} as a third argument equal to the settlement's, for ok, failed and streamed calls", async () => {
  const seen: unknown[] = [];
  const responses = [
    () => new Response('{"usage":{"input_tokens":1,"output_tokens":1}}', { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { status: 404 }),
    () =>
      new Response(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
  ];
  let n = 0;
  const { proxy, events } = make(async (_u, _i, ctx) => {
    seen.push(ctx);
    return responses[n++]!();
  });
  for (const id of ["r1", "r2", "r3"]) await proxy.forward({ credential: key(), requestId: id, path: "/messages", body: enc('{"model":"m","max_tokens":10}') });
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["priced", "failed", "priced"],
  );
  assert.deepEqual(
    seen,
    events.map((e) => ({ agent: e.agent, requestId: e.requestId })),
  );
  assert.deepEqual(seen[1], { agent: "agent-1", requestId: "r2" });
});

// The settlement's `basis` is decided once, by the pricer (price.ts), and carried: a settlement that billed something names where its
// figure came from; a "failed" one billed nothing and names none.
const BASIS_BODY = { model: "m" };
const forwardBasis = async (response: () => Response, body: unknown = BASIS_BODY, extra: Partial<ConstructorParameters<typeof ModelProxy>[0]> = {}) => {
  const { proxy, events } = make(async () => response(), extra);
  const r = await proxy.forward({ credential: key(), requestId: "r1", path: "/chat/completions", body: enc(JSON.stringify(body)) });
  assert.equal(events.length, 1);
  return { r, e: events[0]!, meta: proxyMetaOf(r) };
};
const json = { headers: { "content-type": "application/json" } };

test("a priced call from a provider-reported cost settles with basis reported", async () => {
  const { e, meta } = await forwardBasis(() => new Response('{"usage":{"prompt_tokens":10,"completion_tokens":20,"cost":0.000125}}', json));
  assert.deepEqual([e.kind, e.micros, e.basis], ["priced", 125, "reported"]);
  assert.equal(meta?.basis, "reported");
});

test("a priced call from the local rate card settles with basis catalog", async () => {
  const { e, meta } = await forwardBasis(() => new Response('{"usage":{"prompt_tokens":10,"completion_tokens":20}}', json));
  assert.deepEqual([e.kind, e.micros, e.basis], ["priced", 50, "catalog"]);
  assert.equal(meta?.basis, "catalog");
});

test("a 2xx with no usable usage that falls to the estimator settles with basis estimated", async () => {
  const sse = `data: ${JSON.stringify({ id: "x", choices: [{ delta: { content: "hello world!" } }] })}\n\ndata: [DONE]\n\n`;
  const { e, meta } = await forwardBasis(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }), {
    model: "m",
    stream: true,
    max_tokens: 100000,
  });
  assert.deepEqual([e.kind, e.basis], ["estimated", "estimated"]);
  assert.equal(meta?.basis, "estimated");
});

test("a 2xx charged the whole reservation settles with basis reserve", async () => {
  const unusable = await forwardBasis(() => new Response("{}"), { model: "nope" }); // no rates for the model, so no estimate either
  assert.deepEqual([unusable.e.kind, unusable.e.basis], ["reserve", "reserve"]);
  assert.equal(unusable.meta?.basis, "reserve");
  const throwing = await forwardBasis(() => new Response('{"usage":{}}'), BASIS_BODY, {
    price: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual([throwing.e.kind, throwing.e.basis], ["reserve", "reserve"]);
});

test("a failed settlement carries no basis, in the event or its access-line facts", async () => {
  const { e, meta } = await forwardBasis(() => new Response('{"error":"nope"}', { status: 503 }));
  assert.equal(e.kind, "failed");
  assert.equal("basis" in e, false);
  assert.equal(meta !== undefined && "basis" in meta, false);
});
