// Offline checks for the live model upstream derivation: the base comes from the Pi catalog entry's baseUrl, and the final URL the REAL
// pomtreed ModelProxy requests (not a copy of its join) is exactly what OpenRouter serves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeGatewayCredential } from "../../packages/pomtreed/src/gateway.ts";
import { RequestBudget } from "../../packages/pomtreed/src/model-proxy/request-budget.ts";
import { ModelProxy } from "../../packages/pomtreed/src/model-proxy/service.ts";
import { catalogRouteEntry, liveUpstreamBaseUrl } from "./content-live-upstream.mts";

const ID = "anthropic/claude-haiku-5.5";
const secret = "controller-secret";
const now = () => 1_000;

// The URL the real proxy fetches for a Pi request path.
async function finalUrl(baseUrl: string, path: string): Promise<string> {
  let url = "";
  const proxy = new ModelProxy({
    upstream: { baseUrl, key: "provider-secret" },
    budget: new RequestBudget({ secret, now }),
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    fetch: async (input) => {
      url = String(input);
      return new Response('{"usage":{}}', { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const credential = encodeGatewayCredential(secret, {
    agent: "agent-1",
    id: "a".repeat(32),
    budgetMicros: 100,
    expiresAt: 2_000,
    issuedAt: 1_000,
    models: [ID],
  });
  const result = await proxy.forward({
    credential,
    requestId: "r1",
    path,
    headers: new Headers(),
    body: new TextEncoder().encode(JSON.stringify({ model: ID })),
  });
  assert.equal(result.status, 200);
  return url;
}

const noQuery = (u: string) => u.split("?")[0];

test("anthropic-messages catalog shape: Pi's /v1/messages lands on /api/v1/messages, not the doubled /api/v1/v1/messages", async () => {
  const base = liveUpstreamBaseUrl({ api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" });
  assert.equal(noQuery(await finalUrl(base, "/v1/messages?beta=true")), "https://openrouter.ai/api/v1/messages");
});

test("openai-completions catalog shape: /chat/completions lands on /api/v1/chat/completions", async () => {
  const base = liveUpstreamBaseUrl({ api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1/" });
  assert.equal(base, "https://openrouter.ai/api/v1");
  assert.equal(noQuery(await finalUrl(base, "/chat/completions")), "https://openrouter.ai/api/v1/chat/completions");
});

test("a missing, malformed or non-openrouter baseUrl refuses", () => {
  for (const entry of [
    null,
    {},
    { baseUrl: "" },
    { baseUrl: 7 },
    { baseUrl: "not a url" },
    { baseUrl: "http://openrouter.ai/api" },
    { baseUrl: "https://evil.example/api" },
    { baseUrl: "https://openrouter.ai.evil.example/api" },
    { baseUrl: "https://user:pw@openrouter.ai/api" },
  ])
    assert.throws(() => liveUpstreamBaseUrl(entry), /baseUrl/, JSON.stringify(entry));
});

test("catalog entry lookup: built-in groups, later wins, chat only, and a newer overlay wins", () => {
  const builtin = {
    "anthropic-messages": {
      a: { id: ID, type: "chat", baseUrl: "https://openrouter.ai/api" },
      b: { id: "other", type: "chat" },
      c: { id: "emb", type: "embedding" },
    },
  };
  assert.deepEqual(catalogRouteEntry({ builtin, generatedAt: 10 }, ID), { id: ID, type: "chat", baseUrl: "https://openrouter.ai/api" });
  assert.equal(catalogRouteEntry({ builtin, generatedAt: 10 }, "emb"), null);
  assert.equal(catalogRouteEntry({ builtin, generatedAt: 10 }, "absent"), null);
  const overlay = { lastModified: 20, models: [{ id: ID, baseUrl: "https://openrouter.ai/api/v1" }] };
  assert.deepEqual(catalogRouteEntry({ builtin, overlay, generatedAt: 10 }, ID), overlay.models[0]);
  assert.equal(
    (catalogRouteEntry({ builtin, overlay: { ...overlay, lastModified: 5 }, generatedAt: 10 }, ID) as { baseUrl: string }).baseUrl,
    "https://openrouter.ai/api",
  );
});
