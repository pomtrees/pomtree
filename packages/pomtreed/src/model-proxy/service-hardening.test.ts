import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { isBudgetRefusal } from "../budget-raise.ts";
import { encodeGatewayCredential } from "../gateway.ts";
import { createRequestEstimate } from "./price.ts";
import { RequestBudget } from "./request-budget.ts";
import { createModelProxyServer, ModelProxy, proxyMetaOf, RESERVE_REFUSAL_MESSAGES } from "./service.ts";
import type { ModelProxyOptions } from "./service.ts";

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

const fwd = (proxy: ModelProxy, requestId: string, over: { path?: string; body?: Uint8Array } = {}) =>
  proxy.forward({ credential: key(), requestId, path: over.path ?? "/chat/completions", body: over.body ?? enc('{"model":"m"}') });

test("a settled request id cannot replay: the second call is refused and never reaches the upstream", async () => {
  let calls = 0;
  const { proxy } = make({ fetch: async () => (calls++, new Response("{}")) });
  assert.equal((await fwd(proxy, "r1")).status, 200);
  assert.deepEqual(await fwd(proxy, "r1"), { status: 409, error: RESERVE_REFUSAL_MESSAGES["idempotency-conflict"] });
  assert.equal(calls, 1);
});

test("a concurrent duplicate of an in-flight request id is refused", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { proxy } = make({
    fetch: async () => {
      calls++;
      await gate;
      return new Response("{}");
    },
  });
  const first = fwd(proxy, "r1");
  assert.deepEqual(await fwd(proxy, "r1"), { status: 409, error: RESERVE_REFUSAL_MESSAGES["idempotency-conflict"] });
  release();
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test("real usage above the reservation is recorded in full and exhausts the agent budget", async () => {
  const { proxy, budget } = make({ price: () => ({ micros: 130, basis: "catalog" }) });
  const result = await fwd(proxy, "r1");
  assert.equal("error" in result, false); // the produced response is still returned
  assert.deepEqual(budget.reserve(key(), "r2", 1), { ok: false, reason: "budget-exhausted" });
});

const rates = new FakeRatesSource({
  p: { ds: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, big: { input: 0.28, output: 0.4176, cacheRead: 0, cacheWrite: 0 } },
});
const estimating = (over: Partial<ModelProxyOptions> = {}) => make({ estimate: createRequestEstimate(rates, "p"), ...over });
const bigKey = (budgetMicros: number, id = "a".repeat(32)) => key(id, budgetMicros);
const fwdWith = (proxy: ModelProxy, credential: string, requestId: string, body: string) =>
  proxy.forward({ credential, requestId, path: "/chat/completions", body: enc(body) });

test("a deepseek-v4-pro-shaped request (max_tokens 384000, reservation far above any flat cap) is forwarded unchanged on a $5 budget and refunds the unused reservation", async () => {
  const budget = new RequestBudget({ secret, now });
  const sent: string[] = [];
  const { proxy } = estimating({
    budget,
    price: () => ({ micros: 1_234, basis: "catalog" }),
    fetch: async (_u, init) => (sent.push(Buffer.from(init?.body as Buffer).toString()), new Response("{}")),
  });
  const body = '{"model":"big","max_tokens":384000,"stream":true}';
  assert.equal((await fwdWith(proxy, bigKey(5_000_000), "r1", body)).status, 200);
  assert.deepEqual(
    sent.map((s) => JSON.parse(s)),
    [{ ...JSON.parse(body), stream_options: { include_usage: true } }],
  ); // max_tokens is not rewritten; usage is requested
  assert.equal(budget.reserve(bigKey(5_000_000), "r2", 5_000_000 - 1_234).ok, true); // only the actual cost was kept
  assert.deepEqual(budget.reserve(bigKey(5_000_000), "r3", 1), { ok: false, reason: "budget-exhausted" });
});

test("a request is refused with the remaining budget and the estimate only when the budget cannot cover the minimum", async () => {
  let calls = 0;
  const fetch = async () => (calls++, new Response("{}"));
  const { proxy, budget } = estimating({ fetch });
  const refused = await fwdWith(proxy, bigKey(100), "r1", '{"model":"ds","max_tokens":384000}');
  assert.equal(refused.status, 402);
  assert.match("error" in refused ? refused.error : "", /100 micro-USD remain.*below the 256 micro-USD minimum.*estimated at 384000/);
  assert.ok(isBudgetRefusal("error" in refused ? refused.error : ""), "the daemon escalates on this refusal text");
  assert.equal(calls, 0);
  assert.equal(budget.reserve(bigKey(100), "r2", 100).ok, true); // the probe left nothing reserved
  // The same request with a budget just over the floor is clamped to the remainder and goes through.
  assert.equal((await fwdWith(estimating({ fetch }).proxy, bigKey(256), "r3", '{"model":"ds","max_tokens":384000}')).status, 200);
  assert.equal(calls, 1);
});

test("concurrent reservations are summed per credential and never jointly exceed the budget", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { proxy, budget } = estimating({
    price: () => ({ micros: 100, basis: "catalog" }),
    fetch: async () => {
      calls++;
      await gate;
      return new Response("{}");
    },
  });
  const body = '{"model":"ds","max_tokens":400}';
  const a = fwdWith(proxy, bigKey(1000), "r1", body);
  const b = fwdWith(proxy, bigKey(1000), "r2", body);
  const c = await fwdWith(proxy, bigKey(1000), "r3", body); // 200 left, below the 256 floor
  assert.equal(c.status, 402);
  assert.match("error" in c ? c.error : "", /200 micro-USD remain/);
  release();
  assert.deepEqual([(await a).status, (await b).status, calls], [200, 200, 2]);
  assert.equal(budget.reserve(bigKey(1000), "r4", 800).ok, true); // both settled at 100; the rest is refunded
});

test("an unpriced response charges the whole (possibly clamped) reservation, not a fixed amount", async () => {
  const { proxy, budget } = estimating({ price: () => null });
  const result = await fwdWith(proxy, bigKey(300), "r1", '{"model":"ds","max_tokens":100000}');
  assert.deepEqual(result, {
    status: 502,
    error: "upstream 2xx response had no usable usage (malformed_response): no usage the proxy can price; the whole reservation was charged",
  });
  assert.deepEqual(budget.reserve(bigKey(300), "r2", 1), { ok: false, reason: "budget-exhausted" });
});

test("an unknown model reserves the fixed amount and is refused only when the remaining budget cannot cover it", async () => {
  const { proxy, budget } = estimating();
  assert.equal((await fwdWith(proxy, bigKey(100), "r1", '{"model":"nope","max_tokens":384000}')).status, 200); // 50 held, then 20 charged
  assert.equal(budget.reserve(bigKey(100), "r2", 80).ok, true);
  const refused = await fwdWith(proxy, bigKey(100), "r3", '{"model":"nope","max_tokens":384000}');
  assert.equal(refused.status, 402);
});

const NO_LIMIT = /^output token limit required for \/chat\/completions: set max_tokens or max_completion_tokens/;

test("a body with no output limit is refused before reserving or reaching the upstream, for known and unknown models and whatever the prompt size", async () => {
  let calls = 0;
  const { proxy, budget } = estimating({ fetch: async () => (calls++, new Response("{}")) });
  const bodies = [
    '{"model":"ds"}',
    '{"model":"big","stream":true}',
    '{"model":"nope"}',
    "{}",
    JSON.stringify({ model: "big", messages: [{ role: "user", content: "x".repeat(100_000) }] }),
  ];
  for (const [i, body] of bodies.entries()) {
    const refused = await fwdWith(proxy, bigKey(1_000_000), `r${i}`, body);
    assert.equal(refused.status, 400, body.slice(0, 40));
    assert.match("error" in refused ? refused.error : "", NO_LIMIT);
  }
  assert.equal(calls, 0);
  assert.equal(budget.reserve(bigKey(1_000_000), "all", 1_000_000).ok, true); // none of the refusals reserved anything
});

test("an aliased, case-variant or padded model name is not in the catalog: it still needs a limit and is charged the fixed amount", async () => {
  let calls = 0;
  const { proxy } = estimating({ fetch: async () => (calls++, new Response("{}")) });
  for (const [i, model] of ["DS", " ds", "ds:free", "p/ds", "ds\u0000"].entries()) {
    const refused = await fwdWith(proxy, bigKey(1_000_000), `n${i}`, JSON.stringify({ model }));
    assert.equal(refused.status, 400, model);
    const ok = await fwdWith(proxy, bigKey(1_000_000), `y${i}`, JSON.stringify({ model, max_tokens: 5 }));
    assert.equal(ok.status, 200, model);
    assert.equal(proxyMetaOf(ok)?.chargedMicros, 20, model);
  }
  assert.equal(calls, 5);
});

test("a refusal does not mask an invalid credential: it is 401, not a 400 that reveals the catalog", async () => {
  const { proxy } = estimating();
  assert.deepEqual(await fwdWith(proxy, "not-a-credential", "r1", '{"model":"ds"}'), { status: 401, error: "invalid-credential" });
  assert.deepEqual(await fwdWith(proxy, "not-a-credential", "r2", "garbage"), { status: 401, error: "invalid-credential" });
});

test("the forwarded body is the canonical form of what was priced, so a duplicate key cannot carry a larger limit upstream", async () => {
  let sent = "";
  const { proxy } = estimating({
    fetch: async (_url, init) => {
      sent = Buffer.from(init?.body as Uint8Array).toString("utf8");
      return new Response("{}");
    },
  });
  assert.equal((await fwdWith(proxy, bigKey(1_000_000), "r1", '{"model":"ds","max_tokens":999999999,"max_tokens":5}')).status, 200);
  assert.equal(sent, '{"model":"ds","max_tokens":5}');
  const refused = await fwdWith(proxy, bigKey(1_000_000), "r2", '{"model":"ds","max_tokens":5,"MAX_TOKENS":999999999}');
  assert.equal(refused.status, 400);
  assert.match("error" in refused ? refused.error : "", /ambiguous key "MAX_TOKENS"/);
});

test("the prompt is part of the reservation: in-flight input cost reduces what other requests can reserve", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { proxy, budget } = estimating({
    price: () => ({ micros: 10, basis: "catalog" }),
    fetch: async () => {
      await gate;
      return new Response("{}");
    },
  });
  const body = JSON.stringify({ model: "big", max_tokens: 10, messages: [{ role: "user", content: "x".repeat(40_000) }] });
  const held = (createRequestEstimate(rates, "p")(enc(body), "/chat/completions") as { estimate: { reserveMicros: number } }).estimate.reserveMicros;
  assert.ok(held > (40_000 / 4) * 0.5, "prompt tokens at the highest input rate dominate the 10 output tokens");
  const first = fwdWith(proxy, bigKey(10_000), "r1", body);
  assert.deepEqual(budget.reserve(bigKey(10_000), "r2", 10_000 - held + 1), { ok: false, reason: "budget-exhausted" });
  assert.equal(budget.reserve(bigKey(10_000), "r3", 10_000 - held).ok, true);
  release();
  assert.equal((await first).status, 200);
});

test("a prompt whose input cost alone exceeds the remaining budget is refused before the upstream, even with a tiny output limit", async () => {
  let calls = 0;
  const fetch = async () => (calls++, new Response("{}"));
  const { proxy, budget } = estimating({ fetch });
  // 400 KB at 0.56 micros per token is about 56000 micros against a 10000 budget.
  const body = JSON.stringify({ model: "big", max_tokens: 1, messages: [{ role: "user", content: "x".repeat(400_000) }] });
  const refused = await fwdWith(proxy, bigKey(10_000), "r1", body);
  assert.equal(refused.status, 402);
  assert.match("error" in refused ? refused.error : "", /10000 micro-USD remain.*below the \d+ micro-USD minimum/);
  assert.ok(isBudgetRefusal("error" in refused ? refused.error : ""));
  assert.equal(calls, 0);
  assert.equal(budget.reserve(bigKey(10_000), "r2", 10_000).ok, true);
  assert.equal((await fwdWith(estimating({ fetch }).proxy, bigKey(1_000_000), "r3", body)).status, 200); // the same body fits a larger budget
  assert.equal(calls, 1);
});

test("an absurd output limit is clamped to the remaining budget like any other large one, not refused as invalid", async () => {
  let calls = 0;
  const { proxy } = estimating({ fetch: async () => (calls++, new Response("{}")) });
  assert.equal((await fwdWith(proxy, bigKey(5_000), "r1", '{"model":"big","max_tokens":9007199254740991}')).status, 200);
  const refused = await fwdWith(
    estimating({ fetch: async () => (calls++, new Response("{}")) }).proxy,
    bigKey(100),
    "r2",
    '{"model":"big","max_tokens":9007199254740991}',
  );
  assert.equal(refused.status, 402);
  assert.doesNotMatch("error" in refused ? refused.error : "", /9007199254740991/);
  assert.match("error" in refused ? refused.error : "", /more than any budget/);
  assert.equal(calls, 1);
});

test("an oversized request body is refused", async () => {
  const { proxy } = make({ maxBodyBytes: 4 });
  assert.deepEqual(await fwd(proxy, "r1", { body: enc("12345") }), { status: 413, error: "request body too large" });
});

test("a stuck upstream times out and releases its reservation", async () => {
  const { proxy, budget } = make({
    upstreamTimeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  });
  assert.deepEqual(await fwd(proxy, "r1"), {
    status: 502,
    error:
      "model upstream timed out (timeout): no response headers from provider.example/v1/chat/completions within 20 ms; retry later or raise model.upstreamTimeoutMs",
  });
  assert.equal(budget.reserve(key(), "r2", 100).ok, true);
});

test("a 2xx upstream body that errors mid-read is a stream cut: charged, never released", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc("{"));
      c.error(new Error("socket hang up"));
    },
  });
  const { proxy, budget } = make({ fetch: async () => new Response(body) });
  const r = await fwd(proxy, "r1");
  assert.equal(r.status, 502);
  assert.match(
    "error" in r ? r.error : "",
    /^model upstream stream cut \(stream_cut\): the 2xx response from provider\.example\/v1\/chat\/completions stopped after \d+ bytes because /,
  );
  assert.equal(proxyMetaOf(r)?.errorClass, "stream_cut");
  assert.equal(proxyMetaOf(r)?.chargedMicros, 20);
  assert.equal(budget.reserve(key(), "r2", 81).ok, false, "the 20 micros charged stay spent");
  assert.equal(budget.reserve(key(), "r3", 80).ok, true);
});

test("upstream redirects are not followed and are treated as errors", async () => {
  let redirect: RequestRedirect | undefined;
  const { proxy, budget } = make({
    fetch: async (_url, init) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
    },
  });
  assert.deepEqual(await fwd(proxy, "r1"), {
    status: 502,
    error:
      "model upstream redirected (redirect, 302 from provider.example/v1/chat/completions): the proxy does not follow redirects; set model.baseUrl to the final URL",
  });
  assert.equal(redirect, "manual");
  assert.equal(budget.reserve(key(), "r2", 100).ok, true);
});

test("percent-encoded traversal and encoded separators are refused", async () => {
  const { proxy } = make({
    fetch: async () => {
      throw new Error("must not call");
    },
  });
  for (const path of ["/%2e%2e/admin", "/a/%2E%2E/b", "/a%2fb", "/a%5cb", "/%zz", "/./x", "/x/.."])
    assert.deepEqual(await fwd(proxy, "r1", { path }), { status: 400, error: "invalid model proxy request" }, path);
  assert.equal((await fwd(make().proxy, "r2", { path: "/chat/completions?stream=true" })).status, 200);
});

test("only allowlisted upstream response headers reach the agent: no account, quota, cookie or encoding headers", async () => {
  const upstreamHeaders = {
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": "99",
    "openai-organization": "operator-org",
    "openai-project": "proj_secret",
    "x-ratelimit-remaining-tokens": "123",
    "anthropic-ratelimit-requests-limit": "50",
    "set-cookie": "a=b",
    "x-request-id": "req_1",
    "request-id": "req_2",
    "retry-after": "3",
    "x-other": "1",
  };
  for (const status of [200, 429]) {
    const { proxy } = make({ fetch: async () => new Response("{}", { status, headers: upstreamHeaders }) });
    const result = await fwd(proxy, `r${status}`);
    assert.ok(!("error" in result), String(status));
    if ("error" in result) return;
    assert.deepEqual([...result.headers.keys()].sort(), ["content-type", "request-id", "retry-after", "x-request-id"], String(status));
  }
});

async function listen(proxy: ModelProxy) {
  const server = createModelProxyServer(proxy);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

function post(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; text: string; requestId?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/chat/completions", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      const echoed = res.headers["x-pomtree-request-id"];
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), ...(typeof echoed === "string" && { requestId: echoed }) }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the HTTP server accepts the scoped credential from x-api-key and never forwards it", async () => {
  let seen: Headers | undefined;
  const { proxy } = make({
    fetch: async (_u, init) => {
      seen = new Headers(init?.headers);
      return new Response("{}");
    },
  });
  const { server, port } = await listen(proxy);
  try {
    const ok = await post(port, { "x-api-key": key(), "x-pomtree-request-id": "r1" }, '{"model":"m"}');
    assert.equal(ok.status, 200);
    assert.equal(ok.requestId, "r1", "the proxy's request id is echoed for the harness's usage join");
    const refused = await post(port, { "x-api-key": key(), "x-pomtree-request-id": "r9" }, '{"model":"not-granted"}');
    assert.equal(refused.status, 400);
    assert.equal(refused.requestId, "r9", "echoed on an error answer too");
    assert.equal(seen?.get("x-api-key"), null);
    assert.equal(seen?.get("authorization"), "Bearer provider-secret");
    assert.equal((await post(port, { "x-pomtree-request-id": "r2" }, "{}")).status, 401);
  } finally {
    server.close();
  }
});

test("a client aborting mid-body neither crashes the process nor leaves an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (r: unknown) => rejections.push(r);
  process.on("unhandledRejection", onRejection);
  const { proxy } = make();
  const { server, port } = await listen(proxy);
  try {
    for (const headers of [{ authorization: `Bearer ${key()}`, "x-pomtree-request-id": "r1" }, {}] as Record<string, string>[]) {
      await new Promise<void>((resolve) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/x", headers: { ...headers, "content-length": "100" } });
        req.on("error", () => resolve());
        req.write("{");
        setTimeout(() => (req.destroy(), setTimeout(resolve, 50)), 30);
      });
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rejections, []);
    assert.equal((await post(port, { authorization: `Bearer ${key()}`, "x-pomtree-request-id": "r2" }, '{"model":"m"}')).status, 200); // still serving
  } finally {
    process.off("unhandledRejection", onRejection);
    server.close();
  }
});

for (const status of [401, 402, 404, 429, 500]) {
  test(`an upstream ${status} is passed through with a capped body, charges 0 and releases the whole reservation`, async () => {
    const big = JSON.stringify({ error: { message: "x".repeat(10_000) } });
    const { proxy, budget } = make({
      fetch: async () => new Response(big, { status, headers: { "content-type": "application/json", "set-cookie": "never", "retry-after": "3" } }),
    });
    const result = await fwd(proxy, "r1");
    assert.ok("body" in result);
    assert.equal(result.status, status);
    assert.equal(result.body.length, 4096);
    assert.equal(result.headers.get("retry-after"), "3");
    assert.equal(result.headers.get("set-cookie"), null);
    assert.equal(proxyMetaOf(result)?.chargedMicros, 0);
    // Nothing was spent or left reserved: the full 100 micros are still reservable.
    assert.equal(budget.reserve(key(), "r2", 100).ok, true);
  });
}

test("the access line has method, model, upstream status, charge and duration, and no secrets", async () => {
  const lines: string[] = [];
  const { proxy } = make({ fetch: async () => new Response('{"error":"nope"}', { status: 429 }) });
  const server = createModelProxyServer(proxy, { mode: "all", sink: (l) => lines.push(l) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await post(
      port,
      { authorization: `Bearer ${key()}`, "x-pomtree-request-id": "r1" },
      '{"model":"deepseek/deepseek-v4-pro","secret":"body-secret"}',
    );
    assert.equal(res.status, 429);
    assert.equal(lines.length, 1);
    assert.match(
      lines[0]!,
      /model-proxy POST \/chat\/completions 429 \d+ms agent:agent-1 model="deepseek\/deepseek-v4-pro" upstream=429 upstreamHost=provider\.example upstreamPath=\/v1\/chat\/completions charged=0 class=rate_limited upstreamMessage="nope"/,
    );
    assert.doesNotMatch(lines[0]!, /provider-secret|pg1\.|Bearer|body-secret|controller-secret/);
  } finally {
    server.close();
  }
});
