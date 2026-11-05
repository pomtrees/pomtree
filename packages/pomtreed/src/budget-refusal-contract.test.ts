import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { modelRefusalCodeIn } from "@pomtree/core";
import { normalizeRecord, providerFailure } from "@pomtree/harness-pi";
import { isBudgetRefusal } from "./budget-raise.ts";
import { encodeGatewayCredential } from "./gateway.ts";
import { RequestBudget } from "./model-proxy/request-budget.ts";
import { createModelProxyServer, ModelProxy } from "./model-proxy/service.ts";
import type { ModelProxyOptions } from "./model-proxy/service.ts";

// Producer-to-consumer pins for the proxy's tagged refusals (core model-refusal.ts): the bytes the real proxy server answers
// are fed to the harness's classifier and the daemon's matcher, so neither side keeps its own copy of the shape.
const secret = "controller-secret";
const key = (budgetMicros: number) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros, expiresAt: 2_000, issuedAt: 1_000, models: ["m"] });

async function serve(over: Partial<ModelProxyOptions>, budgetMicros: number, body: string): Promise<{ status: number; text: string }> {
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://upstream.example/v1", key: "sk-upstream-0123456789" },
    budget: new RequestBudget({ secret, now: () => 1_000 }),
    maximumRequestMicros: 50,
    price: () => ({ micros: 5, basis: "catalog" }),
    fetch: async () => new Response("{}"),
    ...over,
  });
  const server = createModelProxyServer(proxy);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/chat/completions",
          headers: { authorization: `Bearer ${key(budgetMicros)}`, "x-pomtree-request-id": "r1", "content-type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the proxy's real 402 body reaches the lifecycle as a plain error isBudgetRefusal matches; an upstream 402 is funding", async () => {
  const r = await serve({}, 1, '{"model":"m","max_tokens":10}');
  assert.equal(r.status, 402, r.text);
  assert.equal(modelRefusalCodeIn(r.text), "model_budget_exhausted");
  // Pi reports the failed request as `<status> <body>`; whichever wrapping, the tag survives and the harness leaves it alone.
  for (const message of [`402 ${r.text}`, `402 ${(JSON.parse(r.text) as { error: string }).error}`]) {
    const own = providerFailure(message);
    assert.ok(own.kind === "error" && isBudgetRefusal(own.message), JSON.stringify(own));
  }
  const upstream = providerFailure('402 {"error":{"message":"stub upstream status 402","code":402}}');
  assert.ok(upstream.kind === "provider_error" && upstream.code === "funding" && !isBudgetRefusal(upstream.message));
});

test("the proxy's refusal of malformed tool arguments reaches the harness as a failed tool result and a journal error", async () => {
  const sse = [
    {
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "" } }] } }],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command": "echo' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]
    .map((o) => `data: ${JSON.stringify(o)}\n\n`)
    .join("");
  const r = await serve(
    { fetch: async () => new Response(`${sse}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }) },
    1_000,
    '{"model":"m","max_tokens":10,"stream":true}',
  );
  assert.equal(r.status, 200, r.text);
  // The call's arguments, as Pi accumulates them from the deltas, are the refusal's JSON string literal.
  let args = "";
  for (const line of r.text.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { tool_calls?: { function?: { arguments?: string } }[] } }[] };
    for (const c of chunk.choices ?? []) for (const t of c.delta?.tool_calls ?? []) args += t.function?.arguments ?? "";
  }
  const refusal = JSON.parse(args) as unknown;
  assert.equal(typeof refusal, "string", "not a JSON object, so pinned Pi fails the call before running it");
  assert.equal(modelRefusalCodeIn(refusal as string), "malformed_tool_arguments");
  // Pinned Pi's isError result for such a call (pi-ai validateToolArguments), as the events sink records it.
  const piText = `Invalid arguments for tool "bash": Tool arguments must be a JSON object\n\nReceived arguments:\n${args}`;
  const ev = normalizeRecord({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    isError: true,
    result: { content: [{ type: "text", text: piText }] },
  });
  assert.equal(ev[0]?.kind === "tool_result" && ev[0].ok, false);
  assert.match(ev[1]?.kind === "error" ? ev[1].message : "", /call to bash whose arguments were not valid JSON \(malformed_tool_arguments\)/);
});
