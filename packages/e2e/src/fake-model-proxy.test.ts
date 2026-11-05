// The fake model upstream end to end through pomtreed's REAL model proxy, without Docker: the option set main.ts uses
// (buildModelProxyOptions), the default settlement sink over a real store-sqlite journal and debit ledger, and the proxy's own HTTP
// server. Only the upstream (FakeModelUpstream) and the rate card (injected, so the micros are exact) are test-owned. CI covers the
// stub's wire format against the real settlement path here; the Docker-gated cli-scenarios.test.ts covers the same path from Pi.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { encodeGatewayCredential, POMTREED_KINDS } from "@pomtree/core";
import { ModelProxy, createModelProxyServer } from "@pomtree/pomtreed";
import { FakeModelUpstream, type ModelScript } from "@pomtree/testing";
import { openStore } from "@pomtree/store-sqlite";
import { buildModelProxyOptions } from "../../pomtreed/src/model-proxy-options.ts";
import type { ModelRates, RatesSource } from "../../pomtreed/src/model-proxy/rates.ts";

const SECRET = "fake-model-proxy-secret";
const PROVIDER = "deepseek"; // any non-anthropic provider: bearer auth, OpenAI chat-completions wire
const MODEL = "stub-model";
// USD per million tokens, so micros per token equal these numbers: 1000 input + 500 output = 1000*1 + 500*2 = 2000 micros.
const RATES: ModelRates = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 };
const rates: RatesSource = {
  lookup: (p, m) => (p === PROVIDER && m === MODEL ? RATES : null),
  ceiling: () => ({ inputMicrosPerToken: 2.5, outputMicrosPerToken: 2 }),
};

const SCRIPT: ModelScript = {
  name: "fake-model-proxy-smoke",
  rules: [
    { id: "rate-limited", when: { marker: "r429", turn: 0 }, times: 1, reply: { kind: "fault", fault: { type: "status", status: 429, retryAfterS: 1 } } },
    { id: "text", when: { marker: "text", turn: 0 }, reply: { kind: "text", text: "STUB-SMOKE-DONE", usage: { input: 1000, output: 500 } } },
    {
      id: "tool",
      when: { marker: "tool", turn: 0, offersTool: "bash" },
      reply: { kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "echo hi" } }], usage: { input: 300, output: 40 } },
    },
  ],
};

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanup.reverse()) await c();
});

interface Settlement {
  settlement: string;
  micros: number;
  requestId: string;
  upstreamStatus?: number;
  tokensIn?: number;
  tokensOut?: number;
  finishReason?: string;
  route?: string;
  errorClass?: string;
  model?: string;
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-e2e-fake-model-proxy-"));
  const store = openStore(join(dir, "pomtreed.sqlite"));
  const stub = await FakeModelUpstream.start({ script: SCRIPT });
  const agent = await store.registry.create({
    parent: null,
    name: "smoke",
    task: "t",
    host: "h1",
    budgetMicros: 1_000_000,
    idempotencyKey: "smoke",
    spec: { image: "img@sha256:smoke", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
  });
  const debits = store.modelDebit({ secret: SECRET });
  const { proxy: options } = buildModelProxyOptions({
    env: {},
    provider: PROVIDER,
    upstream: { baseUrl: stub.baseUrl, key: "stub-upstream-key-not-real" },
    catalog: { found: true, rates },
    debits,
    registry: store.registry,
    journal: store.journal,
    log: () => {},
  });
  const server: Server = createModelProxyServer(new ModelProxy(options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await stub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now();
  const credential = encodeGatewayCredential(SECRET, {
    agent: agent.id,
    id: "c".repeat(32),
    budgetMicros: 1_000_000,
    expiresAt: now + 600_000,
    issuedAt: now,
    models: [MODEL],
  });
  // One streamed chat completion through the proxy, as Pi sends it: the system prompt carries the stub marker.
  const call = async (marker: string, requestId: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "x-pomtree-request-id": requestId, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 1000,
        messages: [
          { role: "system", content: `you are a test agent [[stub:${marker}]]` },
          { role: "user", content: "go" },
        ],
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  // The sink journals after the body ends; poll the journal (bounded) for this request's settlement.
  const settlement = async (requestId: string): Promise<Settlement> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const hit = (await store.journal.read({ agent: agent.id }))
        .map((e) => e.payload as unknown as Settlement & { kind: string })
        .find((p) => p.kind === POMTREED_KINDS.modelSettlement && p.requestId === requestId);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no settlement journaled for ${requestId}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { stub, store, debits, agent, call, settlement };
}

test("fake model through the real proxy: streamed text, tool call and 429 settle exactly, every call matched", { timeout: 60_000 }, async () => {
  const r = await rig();

  // Streamed text: priced from the stub's usage chunk at the injected rate card, exactly.
  const text = await r.call("text", "req-text");
  assert.equal(text.status, 200, text.text);
  assert.match(text.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(text.text.includes("STUB-SMOKE-DONE"), text.text.slice(0, 500));
  assert.ok(text.text.includes("data: [DONE]"));
  const s1 = await r.settlement("req-text");
  assert.equal(s1.settlement, "priced", JSON.stringify(s1));
  assert.equal(s1.micros, 2000);
  assert.equal(s1.tokensIn, 1000);
  assert.equal(s1.tokensOut, 500);
  assert.equal(s1.upstreamStatus, 200);
  assert.equal(s1.route, "chat_completions");
  assert.equal(s1.model, MODEL);
  assert.equal(s1.finishReason, "stop");
  assert.equal(s1.errorClass, undefined);

  // Streamed tool call: 300*1 + 40*2 = 380 micros.
  const tool = await r.call("tool", "req-tool");
  assert.equal(tool.status, 200, tool.text);
  assert.ok(tool.text.includes('"tool_calls"'), tool.text.slice(0, 500));
  const s2 = await r.settlement("req-tool");
  assert.equal(s2.settlement, "priced", JSON.stringify(s2));
  assert.equal(s2.micros, 380);
  assert.equal(s2.finishReason, "tool_calls");

  // 429: passed through to the caller with its retry-after, charged 0, one failed settlement classed rate_limited.
  const limited = await r.call("r429", "req-429");
  assert.equal(limited.status, 429, limited.text);
  const s3 = await r.settlement("req-429");
  assert.equal(s3.settlement, "failed", JSON.stringify(s3));
  assert.equal(s3.micros, 0);
  assert.equal(s3.upstreamStatus, 429);
  assert.equal(s3.errorClass, "rate_limited");

  // The ledger agrees with the journal: spend is exactly the sum of the settlements, and nothing stays reserved.
  const entries = (await r.store.journal.read({ agent: r.agent.id })).map((e) => e.payload as unknown as Settlement & { kind: string });
  const settled = entries.filter((p) => p.kind === POMTREED_KINDS.modelSettlement);
  assert.equal(settled.length, 3, JSON.stringify(settled));
  assert.equal(r.debits.spentFor(r.agent.id), 2000 + 380 + 0);
  // Committed is spend plus open reservations (the agent has no children), so equal to spend means the reserved total is 0.
  assert.equal(r.debits.ledgerFor(r.agent.id).committedMicros, 2000 + 380 + 0);

  // The stub saw exactly the three calls, each matched to its rule, with the shapes the proxy forwarded.
  assert.deepEqual(r.stub.unmatched, []);
  assert.deepEqual(
    r.stub.calls.map((c) => [c.matched, c.wire, c.model, c.stream, c.turn, c.markers, c.offeredTools]),
    [
      ["text", "openai-completions", MODEL, true, 0, ["text"], ["bash"]],
      ["tool", "openai-completions", MODEL, true, 0, ["tool"], ["bash"]],
      ["rate-limited", "openai-completions", MODEL, true, 0, ["r429"], ["bash"]],
    ],
  );
  assert.ok(
    r.stub.calls.every((c) => c.path.endsWith("/v1/chat/completions")),
    JSON.stringify(r.stub.calls.map((c) => c.path)),
  );
});
