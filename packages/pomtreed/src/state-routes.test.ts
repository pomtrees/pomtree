import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_DOC_BYTES_CONFIG_MAX, STATE_KEY_MAX_LENGTH } from "@pomtree/core";
import { createFakes, FakeStateStore } from "@pomtree/testing";
import { handleState } from "./state-routes.ts";
import type { StateRouteDeps } from "./state-routes.ts";
import { MAX_BODY } from "./server.ts";
import { StatePolicy } from "./state-policy.ts";
import { spawnSpec } from "./test-setup.ts";

// handleState driven directly: what the HTTP-level tests cannot reach because the token fence refuses a stale token before the store sees it.

async function world() {
  const fakes = createFakes();
  const registry = fakes.hooks.raw.registry;
  const root = await registry.create({
    parent: null,
    name: "root",
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: "root",
    spec: spawnSpec as never,
  });
  const flow = await registry.create({
    parent: root.id,
    name: "flow",
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: "flow",
    executor: "deterministic",
    spec: { driver: "hn-digest/flow", input: null } as never,
  } as never);
  await registry.transition(flow.id, flow.generation, "running", { idempotencyKey: "flow-run" });
  const store = new FakeStateStore(() => Date.now(), registry);
  const deps: StateRouteDeps = {
    store,
    policy: new StatePolicy(JSON.stringify({ "hn-digest/flow": [{ owner: "hn-digest", mode: "rw" }] })),
    get: (id) => registry.get(id),
    root: async () => root,
    record: async () => undefined,
    redactText: (t) => t,
  };
  return { deps, registry, flow, store };
}

test("an agent write carries the token's generation, so a stale token is refused by the store's fence (403, nothing written)", async () => {
  const w = await world();
  await w.registry.bumpGeneration(w.flow.id, "h1", "bump");
  const principal = { scope: "agent" as const, agent: w.flow.id, generation: w.flow.generation, expiry: 0 };
  // The route's own fence is stubbed open: the store must still catch the stale generation (the registry now holds generation + 1).
  const res = await handleState(w.deps, {
    principal,
    method: "PUT",
    sub: ["doc"],
    query: new URLSearchParams(),
    body: { owner: "hn-digest", key: "memo/a", value: 1, idempotencyKey: "k1" },
    fence: async () => {},
  });
  assert.equal(res.status, 403);
  assert.equal(await w.store.get("hn-digest", "memo/a"), null);
  // A current token writes, and the recorded writer is the token's generation.
  const ok = await handleState(w.deps, {
    principal: { ...principal, generation: w.flow.generation + 1 },
    method: "PUT",
    sub: ["doc"],
    query: new URLSearchParams(),
    body: { owner: "hn-digest", key: "memo/a", value: 1, idempotencyKey: "k2" },
    fence: async () => {},
  });
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as { doc: { writer: unknown } }).doc.writer, { agent: w.flow.id, host: "h1", generation: w.flow.generation + 1 });
});

test("an agent writer the registry does not know is a 403, not a 500", async () => {
  const w = await world();
  const running = await w.registry.get(w.flow.id);
  w.deps.get = async (id) => (id === w.flow.id ? { ...running!, id: "ghost-agent" } : w.registry.get(id));
  const res = await handleState(w.deps, {
    principal: { scope: "agent", agent: w.flow.id, generation: 1, expiry: 0 },
    method: "PUT",
    sub: ["doc"],
    query: new URLSearchParams(),
    body: { owner: "hn-digest", key: "memo/a", value: 1, idempotencyKey: "k1" },
    fence: async () => {},
  });
  assert.equal(res.status, 403);
  assert.equal((res.body as { kind?: string }).kind, "unknown-writer");
});

test("rm with expectRev null is a 400 (a removal has no create reading)", async () => {
  const w = await world();
  const res = await handleState(w.deps, {
    principal: { scope: "operator" },
    method: "POST",
    sub: ["rm"],
    query: new URLSearchParams(),
    body: { owner: "hn-digest", key: "memo/a", expectRev: null, idempotencyKey: "k1" },
    fence: async () => {},
  });
  assert.equal(res.status, 400);
});

test("the largest configurable document, with worst-case owner, key, idempotency key and expectRev, still fits one request body", () => {
  const value = "x".repeat(STATE_DOC_BYTES_CONFIG_MAX - 2); // canonical JSON of a string: two quotes plus content
  const body = JSON.stringify({
    owner: "o".repeat(STATE_KEY_MAX_LENGTH),
    key: "k".repeat(STATE_KEY_MAX_LENGTH),
    value,
    expectRev: Number.MAX_SAFE_INTEGER,
    idempotencyKey: "i".repeat(200),
  });
  assert.ok(Buffer.byteLength(body) < MAX_BODY, `${Buffer.byteLength(body)} bytes against a ${MAX_BODY} byte limit`);
});

// The real journal de-duplicates by key alone; this record stub does the same so key collisions show up as dropped rows.
function dedupingJournal(deps: StateRouteDeps): string[] {
  const keys: string[] = [];
  deps.record = async (_on, _payload, key) => {
    if (!keys.includes(key as string)) keys.push(key as string);
    return undefined;
  };
  return keys;
}

test("exports under one caller idempotencyKey (different owners or principals) each journal their own row", async () => {
  const w = await world();
  const keys = dedupingJournal(w.deps);
  const op = { scope: "operator" as const, expiry: 0 } as never;
  const exp = (owner: string) =>
    handleState(w.deps, {
      principal: op,
      method: "GET",
      sub: ["export"],
      query: new URLSearchParams({ owner, idempotencyKey: "same" }),
      fence: async () => {},
    } as never);
  assert.equal((await exp("hn-digest")).status, 200);
  assert.equal((await exp("other")).status, 200);
  assert.equal((await exp("hn-digest")).status, 200);
  assert.equal(keys.length, 3);
});

test("mutations: a retry of the same request journals one row; the same caller key under another owner journals its own", async () => {
  const w = await world();
  const keys = dedupingJournal(w.deps);
  const op = { scope: "operator" as const, expiry: 0 } as never;
  const put = (owner: string) =>
    handleState(w.deps, {
      principal: op,
      method: "PUT",
      sub: ["doc"],
      query: new URLSearchParams(),
      body: { owner, key: "a", value: 1, idempotencyKey: "same" },
      fence: async () => {},
    } as never);
  assert.equal((await put("hn-digest")).status, 200);
  assert.equal((await put("hn-digest")).status, 200);
  assert.equal(keys.length, 1);
  assert.equal((await put("other")).status, 200);
  assert.equal(keys.length, 2);
});

test("an agent never writes under the workflow-shared scope ext/s/, even with a whole-owner rw grant; the operator does, and agents still read", async () => {
  const w = await world();
  const agentP = { scope: "agent" as const, agent: w.flow.id, generation: w.flow.generation, expiry: 0 };
  const call = (principal: never, method: string, verb: string, body?: unknown, query = "") =>
    handleState(w.deps, { principal, method, sub: [verb], query: new URLSearchParams(query), body, fence: async () => {} });
  const as = agentP as never;
  const shared = (e: { status: number; body: unknown }) => e.status === 403 && /agents may not write under ext\/s\//.test(JSON.stringify(e.body));
  const refused = [
    await call(as, "PUT", "doc", { owner: "hn-digest", key: "ext/s/board/1", value: { forged: true }, idempotencyKey: "f1" }),
    await call(as, "POST", "rm", { owner: "hn-digest", key: "ext/s/board/1", idempotencyKey: "f2" }),
    await call(as, "POST", "rm", { owner: "hn-digest", prefix: "ext/", idempotencyKey: "f3" }),
    await call(as, "POST", "rm", { owner: "hn-digest", prefix: "e", idempotencyKey: "f4" }),
    await call(as, "POST", "import", {
      owner: "hn-digest",
      docs: [
        { key: "memo/ok", value: 1 },
        { key: "ext/s/x", value: 1 },
      ],
      idempotencyKey: "f5",
    }),
  ];
  for (const r of refused) assert.ok(shared(r), JSON.stringify(r));
  assert.deepEqual(await w.store.list("hn-digest"), [], "nothing written, not even the import's first doc");
  // Keys beside the scope are ordinary keys.
  for (const key of ["ext/sx", "ext", "e"])
    assert.equal((await call(as, "PUT", "doc", { owner: "hn-digest", key, value: 1, idempotencyKey: `n-${key}` })).status, 200, key);
  // The operator writes there; the agent may read it and sees the operator as the writer.
  const op = { scope: "operator" as const, expiry: 0 } as never;
  assert.equal((await call(op, "PUT", "doc", { owner: "hn-digest", key: "ext/s/board/1", value: 1, idempotencyKey: "o1" })).status, 200);
  const read = await call(as, "GET", "doc", undefined, "owner=hn-digest&key=ext/s/board/1");
  assert.equal(read.status, 200);
  assert.deepEqual((read.body as { doc: { writer: unknown } }).doc.writer, { operator: true });
});
