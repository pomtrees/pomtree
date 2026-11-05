import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { encodeGatewayCredential } from "./gateway.ts";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { buildModelProxyOptions, modelProxyEnv, modelProxySettings, startReservationReclaim, type ModelProxyInputs } from "./model-proxy-options.ts";
import { DEFAULT_ALLOWED_PATHS, ModelProxy } from "./model-proxy/service.ts";
import { RequestBudget } from "./model-proxy/request-budget.ts";

const secret = "controller-secret";
const rates = new FakeRatesSource({ p: { m: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
const inputs = (o: Partial<ModelProxyInputs> = {}): ModelProxyInputs => {
  const budget = new RequestBudget({ secret, now: () => 1_000 });
  return {
    settings: modelProxySettings(CONFIG_DEFAULTS),
    provider: "openrouter",
    upstream: { baseUrl: "https://openrouter.ai/api", key: "upstream-secret" },
    catalog: { found: true, rates },
    debits: Object.assign(budget, { recordCall: () => true }) as never,
    registry: { get: async () => null },
    journal: { append: async () => undefined } as never,
    onSettlement: () => undefined,
    log: () => undefined,
    ...o,
  };
};
const scalars = (i: ModelProxyInputs) => {
  const { proxy, tokenTtlMs } = buildModelProxyOptions(i);
  return {
    keys: Object.keys(proxy).sort(),
    authStyle: proxy.authStyle,
    allowedPaths: proxy.allowedPaths,
    upstreamTimeoutMs: proxy.upstreamTimeoutMs,
    tokenTtlMs,
  };
};

// Values captured from the pre-refactor inline literals in main.ts (default env, catalog found).
test("daemon options equal the pre-refactor main.ts literals", () => {
  const { proxy, tokenTtlMs, upstreamTimeoutMs } = buildModelProxyOptions(inputs());
  assert.equal(proxy.maximumRequestMicros, 50_000);
  assert.equal(proxy.upstreamTimeoutMs, 120_000);
  assert.equal(upstreamTimeoutMs, 120_000);
  assert.equal(tokenTtlMs, 3_600_000);
  assert.equal(proxy.authStyle, "bearer");
  assert.deepEqual(proxy.allowedPaths, [...DEFAULT_ALLOWED_PATHS]);
  assert.deepEqual(Object.keys(proxy).sort(), [
    "allowedPaths",
    "authStyle",
    "baseUrlName",
    "budget",
    "estimate",
    "estimateSettle",
    "maximumRequestMicros",
    "onSettlement",
    "price",
    "upstream",
    "upstreamTimeoutMs",
    "warn",
  ]);
  assert.equal(buildModelProxyOptions(inputs({ provider: "anthropic" })).proxy.authStyle, "both");
  assert.equal("estimateSettle" in buildModelProxyOptions(inputs({ catalog: { found: false, rates } })).proxy, false);
  const e = modelProxyEnv({
    POMTREED_MODEL_UPSTREAM_TIMEOUT_MS: "5000",
    POMTREED_MODEL_PROXY_TTL_MS: "99",
    POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS: "7",
    POMTREED_MODEL_PROXY_EXTRA_PATHS: "/extra",
  });
  assert.deepEqual([e.upstreamTimeoutMs, e.tokenTtlMs, e.maximumRequestMicros, e.allowedPaths.includes("/extra")], [5000, 99, 7, true]);
  assert.throws(() => modelProxyEnv({ POMTREED_MODEL_UPSTREAM_TIMEOUT_MS: "0" }), /POMTREED_MODEL_UPSTREAM_TIMEOUT_MS/);
  assert.throws(() => modelProxyEnv({ POMTREED_MODEL_PROXY_TTL_MS: "x" }), /POMTREED_MODEL_PROXY_TTL_MS/);
});

test("the resolved upstream is logged once as scheme://host/basePath, never the key; a malformed base URL throws naming POMTREED_MODEL_BASE_URL", () => {
  const lines: string[] = [];
  const { proxy } = buildModelProxyOptions(
    inputs({ log: (m) => lines.push(m), upstream: { baseUrl: "https://openrouter.ai/api/v1/", key: "upstream-secret" } }),
  );
  assert.deepEqual(lines, ["pomtreed: model upstream https://openrouter.ai/api/v1 (provider openrouter)"]);
  assert.equal(proxy.baseUrlName, "POMTREED_MODEL_BASE_URL");
  proxy.warn?.("w");
  assert.deepEqual(lines.slice(1), ["w"], "the proxy's warnings go to the same operator log");
  const bad: string[] = [];
  assert.throws(
    () => buildModelProxyOptions(inputs({ log: (m) => bad.push(m), upstream: { baseUrl: "https://openrouter.ai/api#x", key: "upstream-secret" } })),
    /^Error: invalid POMTREED_MODEL_BASE_URL: it has a fragment \(https:\/\/openrouter\.ai\/api\); /,
  );
  assert.deepEqual(bad, [], "nothing is logged for a refused base");
  for (const l of lines) assert.doesNotMatch(l, /upstream-secret/);
});

test("parity: daemon and live compositions get the same keys, auth style, paths, timeout and TTL", () => {
  for (const provider of ["openrouter", "anthropic"]) {
    const daemon = scalars(
      inputs({ provider, settings: modelProxySettings({ ...CONFIG_DEFAULTS, "model.proxy.extraPaths": ["/x"], "model.upstreamTimeoutMs": 9000 }), host: "h1" }),
    );
    // The live composition (e2e live-model.ts) still passes its env map; it must land on the same options.
    const live = scalars(
      inputs({
        provider,
        settings: undefined,
        env: { POMTREED_MODEL_PROXY_EXTRA_PATHS: "/x", POMTREED_MODEL_UPSTREAM_TIMEOUT_MS: "9000" },
        fetch: async () => new Response("{}"),
      }),
    );
    // live adds the optional fetch seam; every other key must match
    assert.deepEqual(
      live.keys.filter((k) => k !== "fetch"),
      daemon.keys,
    );
    assert.deepEqual({ ...live, keys: 0 }, { ...daemon, keys: 0 });
  }
});

test("negative control: a builder missing a key fails the parity comparison", () => {
  const full = scalars(inputs());
  const { proxy } = buildModelProxyOptions(inputs());
  const { allowedPaths: _dropped, ...broken } = proxy;
  assert.notDeepEqual(Object.keys(broken).sort(), full.keys);
});

const enc = (s: string) => new TextEncoder().encode(s);
const cred = () =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros: 1_000_000, expiresAt: 2_000, issuedAt: 1_000, models: ["m"] });

// Route shapes real Pi runs use, through the shared options and a fake upstream fetch.
for (const [name, provider, base, path, url, header] of [
  [
    "Anthropic Messages via openrouter /api",
    "openrouter",
    "https://openrouter.ai/api",
    "/v1/messages",
    "https://openrouter.ai/api/v1/messages",
    "authorization",
  ],
  [
    "chat completions via openrouter /api/v1",
    "openrouter",
    "https://openrouter.ai/api/v1",
    "/chat/completions",
    "https://openrouter.ai/api/v1/chat/completions",
    "authorization",
  ],
  [
    "Anthropic Messages direct sends x-api-key too",
    "anthropic",
    "https://api.anthropic.com",
    "/v1/messages",
    "https://api.anthropic.com/v1/messages",
    "x-api-key",
  ],
] as const) {
  test(`route shape: ${name} is allowed and forwarded`, async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const { proxy } = buildModelProxyOptions(
      inputs({
        provider,
        upstream: { baseUrl: base, key: "upstream-secret" },
        fetch: async (u, init) => {
          seen.push({ url: String(u), headers: new Headers(init?.headers) });
          return new Response('{"usage":{"cost":0.000001}}', { headers: { "content-type": "application/json" } });
        },
      }),
    );
    const r = await new ModelProxy(proxy).forward({ credential: cred(), requestId: "r1", path, body: enc('{"model":"m","max_tokens":10}') });
    assert.equal(r.status, 200);
    assert.equal(seen[0]?.url, url);
    assert.equal(seen[0]?.headers.get(header), header === "authorization" ? "Bearer upstream-secret" : "upstream-secret");
  });
}

test("a path outside the daemon allowlist is refused through the shared options", async () => {
  const { proxy } = buildModelProxyOptions(
    inputs({
      fetch: async () => {
        throw new Error("must not call");
      },
    }),
  );
  const r = await new ModelProxy(proxy).forward({ credential: cred(), requestId: "r1", path: "/files", body: enc("{}") });
  assert.equal(r.status, 400);
});

test("startReservationReclaim runs once immediately, logs a release and a failure, and returns a clearable timer", () => {
  const logs: string[] = [];
  let n = 2;
  const timer = startReservationReclaim(
    {
      expireReservations: (ms: number) => {
        assert.equal(ms, 2 * 1000);
        return n;
      },
    } as never,
    1000,
    (m) => logs.push(m),
  );
  clearInterval(timer);
  assert.deepEqual(logs, ["pomtreed: released 2 stale model reservation(s)"]);
  n = 0;
  const t2 = startReservationReclaim(
    {
      expireReservations: () => {
        throw new Error("boom");
      },
    } as never,
    1000,
    (m) => logs.push(m),
  );
  clearInterval(t2);
  assert.equal(logs[1], "pomtreed: model reservation reclaim failed: boom");
});
