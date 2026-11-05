import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AgentRecord, ExtensionSpec, SpawnSpec } from "@pomtree/core";
import { FakeExtensionGateway } from "@pomtree/testing";
import { handle } from "./api.ts";
import { op, setup } from "./test-setup.ts";

const allowFetch: SpawnSpec = { image: "img", envManifestHash: null, extensions: ["web_fetch"], systemPrompt: null, egress: { kind: "registry" } };

const specs: ExtensionSpec[] = [
  { name: "web_fetch", description: "fetch", inputSchema: { type: "object" }, streaming: false },
  { name: "web_search", description: "search", inputSchema: { type: "object" }, streaming: false },
];

async function runningAgent(t: ReturnType<typeof setup>, id: string, spec: SpawnSpec = allowFetch): Promise<AgentRecord> {
  const r = await t.daemon.deps.registry.create({ spec, id, parent: null, name: id, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: `mk-${id}` });
  return t.daemon.deps.registry.transition(id, r.generation, "running", { idempotencyKey: `mk-${id}-run` });
}

const call = (t: ReturnType<typeof setup>, name: string, input: unknown, key: string) =>
  handle(t.daemon, { method: "POST", url: `/v1/ext/${name}/call`, token: t.daemon.agentToken("a"), body: { input, idempotencyKey: key } });

test("extList returns the gateway specs filtered to the agent's allowlist (empty = none)", async () => {
  const t = setup(async () => {}, { extensions: new FakeExtensionGateway(specs) });
  const a = await runningAgent(t, "a");
  assert.deepEqual(
    (await t.daemon.extList(a)).map((s) => s.name),
    ["web_fetch"],
  );
  const b = await runningAgent(t, "b", { ...allowFetch, extensions: [] });
  assert.deepEqual(await t.daemon.extList(b), []);
});

test("extCall 403s for a non-running agent", async () => {
  const t = setup(async () => {}, { extensions: new FakeExtensionGateway(specs) });
  await t.daemon.deps.registry.create({ spec: allowFetch, id: "a", parent: null, name: "a", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "mk-a" });
  const res = await call(t, "web_fetch", { url: "x" }, "k");
  assert.equal(res.status, 403);
  assert.match((res.body as { error: string }).error, /not running/);
});

test("extCall 403s for an extension outside the agent's allowlist", async () => {
  const t = setup(async () => {}, { extensions: new FakeExtensionGateway(specs) });
  await runningAgent(t, "a");
  const res = await call(t, "web_search", {}, "k");
  assert.equal(res.status, 403);
  assert.match((res.body as { error: string }).error, /not enabled/);
});

test("extCall deny path journals proxy_call + proxy_result{denied} and returns 403", async () => {
  const t = setup(async () => {}, {
    extensions: new FakeExtensionGateway(specs),
    approveExtension: async () => ({ decision: "deny", reason: "nope" }),
  });
  await runningAgent(t, "a");
  const res = await call(t, "web_fetch", { url: "x" }, "k");
  assert.equal(res.status, 403);
  assert.equal((res.body as { error: string }).error, "nope");
  const entries = await t.journal.read({ agent: "a" });
  assert.ok(entries.some((e) => e.payload.kind === "proxy_call"));
  const pr = entries.find((e) => e.payload.kind === "proxy_result")!.payload as { ok: boolean; denied: boolean; reason: string };
  assert.equal(pr.ok, false);
  assert.equal(pr.denied, true);
  assert.equal(pr.reason, "nope");
});

test("extCall allow path journals proxy_call + proxy_result and returns the gateway result", async () => {
  const gw = new FakeExtensionGateway(specs, [{ ok: true, result: { body: "hi" } }]);
  const t = setup(async () => {}, { extensions: gw });
  await runningAgent(t, "a");
  const res = await call(t, "web_fetch", { url: "https://e.com" }, "k");
  assert.equal(res.status, 200);
  const expected = `ext-${createHash("sha256").update("a\0web_fetch\0k").digest("hex").slice(0, 24)}`;
  const body = res.body as { callId: string; ok: boolean; result: { body: string } };
  assert.equal(body.callId, expected);
  assert.equal(body.ok, true);
  assert.equal(body.result.body, "hi");
  // the gateway was called with the agent id, extension, input, and key
  assert.deepEqual(gw.calls, [{ agent: "a", extension: "web_fetch", input: { url: "https://e.com" }, idempotencyKey: "k" }]);
  const entries = await t.journal.read({ agent: "a" });
  assert.ok(entries.some((e) => e.payload.kind === "proxy_call"));
  const pr = entries.find((e) => e.payload.kind === "proxy_result")!.payload as { ok: boolean; callId: string };
  assert.equal(pr.ok, true);
  assert.equal(pr.callId, expected);
});

test("GET /v1/ext returns the agent's specs and is agent-scoped", async () => {
  const t = setup(async () => {}, { extensions: new FakeExtensionGateway(specs) });
  await runningAgent(t, "a");
  const res = await handle(t.daemon, { method: "GET", url: "/v1/ext", token: t.daemon.agentToken("a") });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (res.body as { extensions: ExtensionSpec[] }).extensions.map((s) => s.name),
    ["web_fetch"],
  );
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/ext", token: op })).status, 403);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/ext" })).status, 401);
});
