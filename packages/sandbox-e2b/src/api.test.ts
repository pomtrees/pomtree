import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxQuotaError, SandboxUnavailableError } from "@pomtree/core";
import { createRequest, type KitResponse } from "@pomtree/sandbox-kit";
import { assertAllRequestsCarry, identityCollector, loadFixture, ProviderStub, scaled } from "@pomtree/testing";
import { E2B_LIST_PAGE_SIZE, E2BApi, E2BApiError, E2BListTruncatedError } from "./api.ts";
import { E2BSandbox } from "./sandbox.ts";
import { API_KEY_PLACEHOLDER } from "./stub-world.ts";

// Strict replay of the hand-written lifecycle fixture: the adapter's requests must match the fixture's method, path, query, body and
// key header in order, and every entry must be consumed. The fixture is `inferred` (see its header and the README's Provenance).

const UA = "pomtree-e2b-test/1";
const FIXTURE = fileURLToPath(new URL("./fixtures/lifecycle.jsonl", import.meta.url));
const DERIVED = "b1ba4c8adcc712f1c797e42f413042510e4cbdb2f35413617412683369625f0d";
const noWait = { maxAttempts: 2, sleep: async () => {} };

async function replay(userAgent: string) {
  const identity = identityCollector();
  const stub = await ProviderStub.start({ fixture: loadFixture(FIXTURE), observeUserAgent: identity.observe, requireHeaderNames: ["x-api-key"] });
  const api = new E2BApi({ baseUrl: stub.baseUrl, request: createRequest({ userAgent }), apiKey: async () => API_KEY_PLACEHOLDER, retry: noWait });
  return { stub, identity, api, sandbox: new E2BSandbox({ api, template: "", timeoutS: 900, pollMs: 10 }) };
}

test("the fixture's header says where its bytes came from (inferred from the docs)", () => {
  const f = loadFixture(FIXTURE);
  assert.equal(f.header.provenance, "inferred");
  assert.equal(f.header.provider, "e2b");
  assert.ok(f.header.placeholders.includes(DERIVED));
});

test("start, inspect, list, kill replay the documented E2B wire exactly, with the configured User-Agent on every request", async () => {
  const { stub, identity, api, sandbox } = await replay(UA);
  try {
    const h = await sandbox.start({ agent: "agent-a", image: "base", env: { GREETING: "hi" }, mounts: [], labels: { store_id: "store-1" } }, "fixture-start-1");
    assert.equal(h.id, DERIVED, "the pomtree id is derived from the idempotency key, not E2B's sandboxID");
    assert.deepEqual(await sandbox.inspect(h.id), { running: true, exitCode: null, status: "running" });
    const listed = await sandbox.list({ host: "host-1", storeId: "store-1", epoch: 1 });
    // The other store's sandbox is filtered out; the one whose hashed tag has no annotation is foreign and never listed.
    assert.deepEqual(listed, [
      { id: DERIVED, agent: "agent-a", backend: "e2b", host: null, generation: null, state: "running", labels: { store_id: "store-1" } },
    ]);
    await sandbox.kill(h.id, "k1");
    assert.deepEqual(await h.wait(), { exitCode: 137 });
    assert.deepEqual(await sandbox.inspect(h.id), { running: false, exitCode: 137, status: "exited" });
    await sandbox.kill(h.id, "k1"); // repeated: no second request
    await api.kill("sbxfixture01"); // a kill answered 404 is success
    stub.assertNoUnmatched();
    stub.assertFixtureConsumed();
    assertAllRequestsCarry(identity, UA);
  } finally {
    await stub.close();
  }
});

test("negative control: a facade stamping another User-Agent fails the identity check", async () => {
  const { stub, identity, sandbox } = await replay("someone-else/2");
  try {
    await sandbox.start({ agent: "agent-a", image: "base", env: { GREETING: "hi" }, mounts: [], labels: { store_id: "store-1" } }, "fixture-start-1");
    assert.throws(() => assertAllRequestsCarry(identity, UA), /did not carry the configured User-Agent/);
  } finally {
    await stub.close();
  }
});

// A transport that answers every call itself and echoes the API key it was sent, as a careless provider error page might.
function echoing(status: number, headers: Record<string, string> = {}) {
  const seen: string[] = [];
  const transport = async (url: string, init: { method: string; headers?: Record<string, string> }): Promise<KitResponse> => {
    seen.push(`${init.method} ${new URL(url).pathname}`);
    const key = init.headers?.["x-api-key"] ?? "";
    return { status, headers, body: new TextEncoder().encode(JSON.stringify({ message: `bad request for key ${key}`, key })) };
  };
  return { seen, request: createRequest({ userAgent: UA, transport }) };
}

const PLANTED = "e2b_PLANTEDcredential0123456789abcdef";

test("the API key never appears in an error message or a log field, even when the provider echoes it", async () => {
  const logs: string[] = [];
  for (const [status, expect] of [
    [401, SandboxUnavailableError],
    [500, Error],
    [422, Error],
  ] as const) {
    const { request } = echoing(status);
    const api = new E2BApi({ baseUrl: "https://api.e2b.test", request, apiKey: async () => PLANTED, retry: noWait });
    const sandbox = new E2BSandbox({
      api,
      template: "base",
      timeoutS: 60,
      probe: { probes: 1, intervalMs: 0 },
      log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
    });
    for (const op of [() => api.get("sbx1"), () => sandbox.start({ agent: "a", image: "base", env: {}, mounts: [] }, `k-${status}`)]) {
      const err = await op().then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof expect, `status ${status}: got ${String(err)}`);
      const text = `${(err as Error).message} ${JSON.stringify(err)} ${String((err as Error).cause ?? "")}`;
      assert.ok(!text.includes(PLANTED), `status ${status}: the planted key leaked into the error`);
      assert.ok(!text.includes("PLANTEDcredential"), `status ${status}: part of the planted key leaked into the error`);
    }
    const probe = await sandbox.probe();
    assert.ok(!JSON.stringify(probe).includes("PLANTEDcredential"), `status ${status}: the planted key leaked into the probe result`);
    assert.equal(probe.problems[0]?.code, status === 401 ? "auth" : "unreachable");
  }
  assert.ok(!logs.join("\n").includes("PLANTEDcredential"), "the planted key leaked into a log line");
});

test("429 on create is a SandboxQuotaError carrying the provider's wait, and no create is repeated", async () => {
  const { seen, request } = echoing(429, { "retry-after": "7" });
  const api = new E2BApi({ baseUrl: "https://api.e2b.test", request, apiKey: async () => "k", retry: noWait });
  const err = await api.create({ templateID: "base", timeout: 60, metadata: {}, envVars: {} }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SandboxQuotaError, String(err));
  assert.equal(err.backend, "e2b");
  assert.equal(err.retryAfterMs, 7000);
  assert.deepEqual(seen, ["POST /sandboxes"], "a create is never repeated by the retry wrapper");
});

test("429 through the stub: a rate-limited create is a SandboxQuotaError and creates nothing", async () => {
  const stub = await ProviderStub.start({ resources: [{ collection: "/sandboxes", idField: "sandboxID", requireKey: false }] });
  try {
    stub.faults.arm("rate-limit", { method: "POST", path: "/sandboxes", retryAfterS: 2 });
    const api = new E2BApi({
      baseUrl: stub.baseUrl,
      request: createRequest({ userAgent: UA }),
      apiKey: async () => "k",
      retry: noWait,
      timeoutMs: scaled(5000),
    });
    await assert.rejects(
      () => api.create({ templateID: "base", timeout: 60, metadata: {}, envVars: {} }),
      (e: unknown) => e instanceof SandboxQuotaError && e.retryAfterMs === 2000,
    );
    assert.equal(stub.model.resources("/sandboxes").length, 0);
  } finally {
    await stub.close();
  }
});

// A transport answering GETs from a table: path -> JSON body.
function answering(table: Record<string, unknown>) {
  return createRequest({
    userAgent: UA,
    transport: async (url: string): Promise<KitResponse> => {
      const body = table[new URL(url).pathname];
      return body === undefined
        ? { status: 404, headers: {}, body: new Uint8Array() }
        : { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    },
  });
}
const item = (n: number, state = "running") => ({
  sandboxID: `sbx${n}`,
  state,
  metadata: { "pomtree.sandbox": `p${n}`, "pomtree.agent": "a", "pomtree.backend": "e2b", store_id: "s" },
});

test("a full list page fails closed as possibly truncated, and a non-array answer is refused, each with an action", async () => {
  const full = new E2BApi({
    baseUrl: "https://api.e2b.test",
    request: answering({ "/v2/sandboxes": Array.from({ length: E2B_LIST_PAGE_SIZE }, (_, i) => item(i)) }),
    apiKey: async () => "k",
    retry: noWait,
  });
  await assert.rejects(
    () => full.list({ a: "b" }),
    (e: unknown) => e instanceof E2BListTruncatedError && /may be truncated.*kill sandboxes/.test(e.message),
  );
  const sandbox = new E2BSandbox({ api: full, template: "base", timeoutS: 60 });
  await assert.rejects(() => sandbox.list({ host: "h", storeId: "s", epoch: 1 }), SandboxUnavailableError);
  const short = new E2BApi({
    baseUrl: "https://api.e2b.test",
    request: answering({ "/v2/sandboxes": Array.from({ length: E2B_LIST_PAGE_SIZE - 1 }, (_, i) => item(i)) }),
    apiKey: async () => "k",
  });
  assert.equal((await short.list({ a: "b" })).length, E2B_LIST_PAGE_SIZE - 1);
  const paged = new E2BApi({
    baseUrl: "https://api.e2b.test",
    request: answering({ "/v2/sandboxes": { sandboxes: [], nextToken: "t" } }),
    apiKey: async () => "k",
  });
  await assert.rejects(
    () => paged.list({ a: "b" }),
    (e: unknown) => e instanceof E2BApiError && /bare JSON array/.test(e.message),
  );
});

test("a paused sandbox inspects and lists as paused, distinct from an exit", async () => {
  const api = new E2BApi({
    baseUrl: "https://api.e2b.test",
    request: answering({ "/v2/sandboxes": [item(1, "paused")], "/sandboxes/sbx1": item(1, "paused") }),
    apiKey: async () => "k",
  });
  const sandbox = new E2BSandbox({ api, template: "base", timeoutS: 60 });
  assert.deepEqual(await sandbox.inspect("p1"), { running: false, exitCode: null, status: "paused" });
  assert.equal((await sandbox.list({ host: "h", storeId: "s", epoch: 1 }))[0]?.state, "paused");
});
