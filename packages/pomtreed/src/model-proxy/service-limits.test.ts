import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { encodeGatewayCredential } from "../gateway.ts";
import { createRequestEstimate } from "./price.ts";
import type { RatesSource } from "./rates.ts";
import { RequestBudget } from "./request-budget.ts";
import type { ModelProxyOptions } from "./service.ts";
import { DEFAULT_ALLOWED_PATHS, ModelProxy, proxyMetaOf } from "./service.ts";

// Every model id these tests send: the credential allows them all (model_not_allowed has its own tests).
const TEST_MODELS = ["m", "ds", "nope", "big", "deepseek/deepseek-v4-pro", "DS", " ds", "ds:free", "p/ds", "ds\u0000"];
const secret = "controller-secret";
const now = () => 1_000;
const key = (id = "a".repeat(32), budgetMicros = 100) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id, budgetMicros, expiresAt: 2_000, issuedAt: 1_000, models: TEST_MODELS });
const enc = (s: string) => new TextEncoder().encode(s);

function make(over: Partial<ModelProxyOptions> = {}, budget = new RequestBudget({ secret, now })) {
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    fetch: async () => new Response("{}"),
    ...over,
  });
  return { proxy, budget };
}

const rates = new FakeRatesSource({
  p: { ds: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, big: { input: 0.28, output: 0.4176, cacheRead: 0, cacheWrite: 0 } },
});
const estimating = (over: Partial<ModelProxyOptions> = {}) => make({ estimate: createRequestEstimate(rates, "p"), ...over });
const bigKey = (budgetMicros: number, id = "a".repeat(32)) => key(id, budgetMicros);
const fwdWith = (proxy: ModelProxy, credential: string, requestId: string, body: string, path = "/chat/completions") =>
  proxy.forward({ credential, requestId, path, body: enc(body) });

const LIMIT_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
const HONOURED: Record<string, string[]> = {
  "/messages": ["max_tokens"],
  "/responses": ["max_output_tokens"],
  "/chat/completions": ["max_tokens", "max_completion_tokens"],
  "/completions": ["max_tokens", "max_completion_tokens"],
};
const PATHS = Object.keys(HONOURED).flatMap((p) => [p, `/v1${p}`]);

// A refusal must reach neither the upstream nor the budget: nothing reserved, nothing called.
const assertUntouched = (calls: number, budget: RequestBudget) => {
  assert.equal(calls, 0);
  assert.equal(budget.reserve(bigKey(1_000_000), "x", 1_000_000).ok, true);
};

test("each limit field is honoured only on the endpoints that read it, with or without the /v1 prefix", async () => {
  for (const path of PATHS)
    for (const field of LIMIT_FIELDS) {
      let calls = 0;
      const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
      const body = `{"model":"ds","${field}":5}`;
      const result = await fwdWith(proxy, bigKey(1_000_000), `${path}-${field}`, body, path);
      const honoured = HONOURED[path.replace(/^\/v1/, "")]!.includes(field);
      if (honoured) {
        assert.equal(result.status, 200, `${path} ${field}`);
        assert.equal(calls, 1, `${path} ${field}`);
      } else {
        const expected = new RegExp(`^output token limit required for ${path}: set `);
        assert.equal(result.status, 400, `${path} ${field}`);
        assert.match("error" in result ? result.error : "", expected, `${path} ${field}`);
        assertUntouched(calls, budget);
      }
    }
});

test("bad limit values are refused before reserving, for catalogued and unknown models", async () => {
  const values = ["0", "-1", "1.5", '"5"', "null", "true", "9007199254740992", "[5]", "{}", "1e-320"];
  for (const model of ["ds", "nope"])
    for (const v of values) {
      let calls = 0;
      const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
      const body = `{"model":"${model}","max_tokens":${v}}`;
      const result = await fwdWith(proxy, bigKey(1_000_000), `r-${model}-${v}`, body);
      assert.equal(result.status, 400, body);
      assert.match("error" in result ? result.error : "", /^invalid output token limit/, body);
      assertUntouched(calls, budget);
    }
  assert.deepEqual(await fwdWith(estimating().proxy, bigKey(100), "msg", '{"model":"ds","max_tokens":"9"}'), {
    status: 400,
    error: "invalid output token limit: max_tokens must be a positive integer",
  });
});

test("bodies that are not a JSON object are refused before reserving, for catalogued and unknown models", async () => {
  for (const model of ["ds", "nope"]) {
    const bodies = [
      `{"model":"${model}","max_tokens":NaN}`,
      `{"model":"${model}","max_tokens":Infinity}`,
      "[]",
      "7",
      "",
      `{"model":"${model}","max_tokens":5`,
      "null",
      '"max_tokens"',
      "not json",
      `[{"model":"${model}","max_tokens":5}]`,
    ];
    for (const body of bodies) {
      let calls = 0;
      const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
      const result = await fwdWith(proxy, bigKey(1_000_000), `o-${model}-${body}`, body);
      assert.deepEqual(result, { status: 400, error: "request body must be a JSON object" }, body);
      assertUntouched(calls, budget);
    }
  }
});

test("n and best_of must be positive safe integers on /completions; valid ones are forwarded", async () => {
  const cases: [string, number, RegExp | null][] = [
    ['"n":1', 200, null],
    ['"n":4', 200, null],
    ['"best_of":2', 200, null],
    ['"n":0', 400, /^invalid n: must be a positive integer$/],
    ['"n":-1', 400, /^invalid n: must be a positive integer$/],
    ['"n":1.5', 400, /^invalid n: must be a positive integer$/],
    ['"n":"2"', 400, /^invalid n: must be a positive integer$/],
    ['"n":null', 400, /^invalid n: must be a positive integer$/],
    ['"best_of":0', 400, /^invalid best_of: must be a positive integer$/],
    ['"best_of":1.5', 400, /^invalid best_of: must be a positive integer$/],
  ];
  for (const [extra, status, error] of cases) {
    let calls = 0;
    const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
    const result = await fwdWith(proxy, bigKey(1_000_000), `m-${extra}`, `{"model":"ds","max_tokens":5,${extra}}`, "/completions");
    assert.equal(result.status, status, extra);
    if (error) {
      assert.match("error" in result ? result.error : "", error, extra);
      assertUntouched(calls, budget);
    } else assert.equal(calls, 1, extra);
  }
});

test("n and best_of raise the reservation", () => {
  const held = (extra: string) =>
    (createRequestEstimate(rates, "p")(enc(`{"model":"ds","max_tokens":100${extra}}`), "/completions") as { estimate: { reserveMicros: number } }).estimate
      .reserveMicros;
  assert.ok(held(',"n":4') - held("") >= 300 && held(',"best_of":8,"n":2') - held("") >= 1500);
});

test("keys differing only in case from a limit or multiplier field are refused as ambiguous", async () => {
  for (const extra of ['"MAX_TOKENS":9', '"Max_Completion_Tokens":9', '"MAX_OUTPUT_TOKENS":9', '"N":2', '"Best_Of":2']) {
    let calls = 0;
    const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
    const result = await fwdWith(proxy, bigKey(1_000_000), `amb-${extra}`, `{"model":"ds","max_tokens":5,${extra}}`, "/completions");
    assert.equal(result.status, 400, extra);
    assert.match("error" in result ? result.error : "", /ambiguous key/, extra);
    assertUntouched(calls, budget);
  }
});

test("a refusal is tagged for the access log (model, agent, charge 0) and burns no request id: only the one settled charge is spent", async () => {
  const { proxy, budget } = estimating();
  const refused = await fwdWith(proxy, bigKey(1_000), "same", '{"model":"ds"}');
  assert.equal(refused.status, 400);
  assert.deepEqual([proxyMetaOf(refused)?.model, typeof proxyMetaOf(refused)?.agent, proxyMetaOf(refused)?.chargedMicros], ["ds", "string", 0]);
  assert.equal((await fwdWith(proxy, bigKey(1_000), "same", '{"model":"ds","max_tokens":10}')).status, 200);
  assert.equal(budget.reserve(bigKey(1_000), "all", 1_000 - 20).ok, true); // only the one settled charge is spent
});

test("realistic Anthropic- and Responses-shaped bodies are bounded by their own field", async () => {
  let calls = 0;
  const fetch = async () => (calls++, new Response("{}"));
  const send = (path: string, body: string, id: string) => fwdWith(estimating({ fetch }).proxy, bigKey(1_000_000), id, body, path);
  const messages = JSON.stringify({
    model: "big",
    max_tokens: 64,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "s",
    thinking: { type: "enabled", budget_tokens: 32 },
  });
  const responses = JSON.stringify({
    model: "big",
    max_output_tokens: 64,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    store: false,
  });
  assert.equal((await send("/v1/messages", messages, "a1")).status, 200);
  assert.equal((await send("/responses", responses, "a2")).status, 200);
  assert.equal(calls, 2);
  assert.equal((await send("/messages", responses, "a3")).status, 400); // max_output_tokens is no bound on /messages
  assert.equal((await send("/v1/responses", messages, "a4")).status, 400); // nor max_tokens on /responses
  assert.equal(calls, 2);
});

test("a refused request id is not burned: the same id is accepted once the body is fixed", async () => {
  for (const [refusedBody, fixedBody] of [
    ['{"model":"ds"}', '{"model":"ds","max_tokens":5}'],
    ['{"model":"nope","max_tokens":0}', '{"model":"nope","max_tokens":5}'],
    ["[]", '{"model":"big","max_completion_tokens":5}'],
  ] as const) {
    let calls = 0;
    const { proxy } = estimating({ fetch: async () => (calls++, new Response("{}")) });
    assert.equal((await fwdWith(proxy, bigKey(1_000_000), "same", refusedBody)).status, 400, refusedBody);
    assert.equal((await fwdWith(proxy, bigKey(1_000_000), "same", fixedBody)).status, 200, fixedBody);
    assert.equal(calls, 1, fixedBody);
  }
});

// Catalog-wide ceiling (micros per token) for unknown models; the lookup is the fake's.
const withCeiling = (c: { inputMicrosPerToken: number; outputMicrosPerToken: number } | null): RatesSource => ({
  lookup: (p, m) => rates.lookup(p, m),
  ceiling: () => c,
});
const sentBody = (init: RequestInit | undefined): string => Buffer.from(init?.body as Uint8Array).toString("utf8");

test("an unknown model is reserved at the catalog ceiling on its limit, clamped to the remaining budget", async () => {
  const budget = new RequestBudget({ secret, now });
  const cred = key("c".repeat(32), 200_000);
  let probeOk: boolean | null = null;
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    estimate: createRequestEstimate(withCeiling({ inputMicrosPerToken: 0, outputMicrosPerToken: 100 }), "p"),
    fetch: async () => {
      probeOk = budget.reserve(cred, "probe", 1).ok;
      return new Response("{}");
    },
  });
  // 5000 x 100 = 500 000 micros wanted, 200 000 remain: the whole remainder is held while the request is in flight.
  assert.equal((await fwdWith(proxy, cred, "unk-clamp", '{"model":"nope","max_tokens":5000}')).status, 200);
  assert.equal(probeOk, false);
});

test("an unknown model whose remaining budget is below the ceiling floor is refused with 402, not admitted at the fixed amount", async () => {
  const budget = new RequestBudget({ secret, now });
  const cred = key("d".repeat(32), 20_000);
  let calls = 0;
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    estimate: createRequestEstimate(withCeiling({ inputMicrosPerToken: 0, outputMicrosPerToken: 100 }), "p"),
    fetch: async () => (calls++, new Response("{}")),
  });
  // floor = 256 x 100 = 25 600 > 20 000 remaining.
  const result = await fwdWith(proxy, cred, "unk-402", '{"model":"nope","max_tokens":5000}');
  assert.equal(result.status, 402);
  assert.match("error" in result ? result.error : "", /^model budget exhausted/);
  assert.equal(calls, 0);
  assert.equal(budget.reserve(cred, "x", 20_000).ok, true);
});

test("without a catalog ceiling an unknown model keeps the fixed reservation", async () => {
  const budget = new RequestBudget({ secret, now });
  const cred = key("e".repeat(32), 20_000);
  let calls = 0;
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    estimate: createRequestEstimate(withCeiling(null), "p"),
    fetch: async () => (calls++, new Response("{}")),
  });
  assert.equal((await fwdWith(proxy, cred, "unk-fixed", '{"model":"nope","max_tokens":5000}')).status, 200);
  assert.equal(calls, 1);
});

test("hosted tools and non-default service tiers are refused before reserving; function and custom tools pass", async () => {
  const cases: [string, RegExp | null][] = [
    ['"tools":[{"type":"web_search_20250305","name":"web_search"}]', /^invalid request: tools\[\]\.type "web_search_20250305" is not allowed/],
    ['"tools":[{"type":"code_interpreter"}]', /^invalid request: tools\[\]\.type "code_interpreter" is not allowed/],
    ['"tools":[{"type":7}]', /^invalid request: tools\[\]\.type 7 is not allowed/],
    ['"tools":[{"type":"function","function":{"name":"f"}}]', null],
    ['"tools":[{"type":"custom","name":"c"}]', null],
    ['"tools":[{"name":"c","input_schema":{}}]', null],
    ['"service_tier":"priority"', /^invalid request: service_tier "priority" is not allowed/],
    ['"service_tier":null', /^invalid request: service_tier null is not allowed/],
    ['"service_tier":"auto"', null],
    ['"service_tier":"default"', null],
  ];
  for (const [extra, error] of cases) {
    let calls = 0;
    const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
    const result = await fwdWith(proxy, bigKey(1_000_000), `t-${extra}`, `{"model":"ds","max_tokens":5,${extra}}`);
    if (error) {
      assert.equal(result.status, 400, extra);
      assert.match("error" in result ? result.error : "", error, extra);
      assertUntouched(calls, budget);
    } else assert.equal(result.status, 200, extra);
  }
});

test("a refused request writes nothing to the budget: no reserve, no cancel; a bad credential is 401", async () => {
  const budget = new RequestBudget({ secret, now });
  const calls = { reserve: 0, cancel: 0 };
  const spy = {
    authorize: (k: string) => budget.authorize(k),
    reserve: (k: string, id: string, max: number) => (calls.reserve++, budget.reserve(k, id, max)),
    settle: (r: Parameters<RequestBudget["settle"]>[0], c: number) => budget.settle(r, c),
    cancel: (r: Parameters<RequestBudget["cancel"]>[0]) => (calls.cancel++, budget.cancel(r)),
  };
  const { proxy } = make({ budget: spy, estimate: createRequestEstimate(rates, "p") }, budget);
  assert.deepEqual(await fwdWith(proxy, bigKey(1_000_000), "w1", '{"model":"ds"}'), {
    status: 400,
    error: "output token limit required for /chat/completions: set max_tokens or max_completion_tokens",
  });
  assert.deepEqual(await fwdWith(proxy, "pg1.bogus.bogus", "w2", '{"model":"ds"}'), { status: 401, error: "invalid-credential" });
  assert.deepEqual(calls, { reserve: 0, cancel: 0 });
});

test("a body nested at a normal depth is still estimated and forwarded", async () => {
  const depth = 50;
  const body = `{"model":"ds","max_tokens":5,"x":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  let calls = 0;
  const { proxy } = estimating({ fetch: async () => (calls++, new Response("{}")) });
  const result = await fwdWith(proxy, bigKey(1_000_000), "shallow", body);
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
});

test("a body nested past the depth bound is refused with 400 before reserving", async () => {
  const depth = 200_000;
  const body = `{"model":"ds","max_tokens":5,"x":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  let calls = 0;
  const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
  const result = await fwdWith(proxy, bigKey(1_000_000), "deep", body);
  assert.equal(result.status, 400);
  assert.match("error" in result ? result.error : "", /^request body is too deeply nested/);
  assertUntouched(calls, budget);
});

test("the upstream content-type is always application/json, whatever the client sent", async () => {
  const sent: Array<string | null> = [];
  const { proxy } = estimating({
    fetch: async (_u, init) => (sent.push(new Headers(init?.headers).get("content-type")), new Response("{}")),
  });
  const body = enc('{"model":"ds","max_tokens":5}');
  await proxy.forward({
    credential: bigKey(1_000_000),
    requestId: "ct1",
    path: "/chat/completions",
    headers: new Headers({ "content-type": "text/plain" }),
    body,
  });
  await proxy.forward({ credential: bigKey(1_000_000), requestId: "ct2", path: "/chat/completions", body });
  assert.deepEqual(sent, ["application/json", "application/json"]);
});

test("an operator extra path with no limit field (embeddings) is refused; the hint names only the endpoint's fields", async () => {
  let calls = 0;
  const { proxy, budget } = estimating({
    allowedPaths: [...DEFAULT_ALLOWED_PATHS, "/embeddings"],
    fetch: async () => (calls++, new Response("{}")),
  });
  const emb = await fwdWith(proxy, bigKey(1_000_000), "emb", '{"model":"ds","input":"hi"}', "/embeddings");
  assert.match("error" in emb ? emb.error : "", /^output token limit required for \/embeddings: set max_tokens or max_completion_tokens or max_output_tokens$/);
  assertUntouched(calls, budget);
  const chat = await fwdWith(proxy, bigKey(1_000_000), "chat-hint", '{"model":"ds"}');
  assert.doesNotMatch("error" in chat ? chat.error : "", /supportsMaxOutputTokens/);
  const responses = await fwdWith(proxy, bigKey(1_000_000), "resp-hint", '{"model":"ds"}', "/responses");
  assert.match("error" in responses ? responses.error : "", /supportsMaxOutputTokens=false/);
});

test("a __proto__ key is forwarded as data and never supplies the limit", async () => {
  let sent = "";
  const { proxy } = estimating({
    fetch: async (_u, init) => {
      sent = sentBody(init);
      return new Response("{}");
    },
  });
  assert.equal((await fwdWith(proxy, bigKey(1_000_000), "pr1", '{"__proto__":{"max_tokens":5},"model":"ds","max_tokens":5}')).status, 200);
  assert.match(sent, /"__proto__":\{"max_tokens":5\}/);
  const refused = await fwdWith(proxy, bigKey(1_000_000), "pr2", '{"__proto__":{"max_tokens":5},"model":"ds"}');
  assert.match("error" in refused ? refused.error : "", /^output token limit required/);
});

test("a UTF-8 BOM is dropped and invalid UTF-8 is replaced before pricing and forwarding", async () => {
  let sent = "";
  const { proxy } = estimating({
    fetch: async (_u, init) => {
      sent = sentBody(init);
      return new Response("{}");
    },
  });
  assert.equal((await fwdWith(proxy, bigKey(1_000_000), "bom", '\uFEFF{"model":"ds","max_tokens":5}')).status, 200);
  assert.ok(!sent.startsWith("\uFEFF"));
  const invalid = new Uint8Array([...enc('{"model":"ds","max_tokens":5,"s":"'), 0xff, ...enc('"}')]);
  assert.equal((await proxy.forward({ credential: bigKey(1_000_000), requestId: "bad-utf8", path: "/chat/completions", body: invalid })).status, 200);
  assert.match(sent, /"s":"\uFFFD"/);
});

test("a limit given only in the query string does not count", async () => {
  const { proxy, budget } = estimating();
  const result = await fwdWith(proxy, bigKey(1_000_000), "qs", '{"model":"ds"}', "/chat/completions?max_tokens=5");
  assert.match("error" in result ? result.error : "", /^output token limit required/);
  assert.equal(budget.reserve(bigKey(1_000_000), "x", 1_000_000).ok, true);
});
