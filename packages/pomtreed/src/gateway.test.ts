import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeJournal, FakeModelDebitStore, FakeRegistry } from "@pomtree/testing";
import { openStore } from "@pomtree/store-sqlite";
import { decodeGatewayCredential, encodeGatewayCredential, ProxyCredentialGateway, reclaimStaleReservations } from "./gateway.ts";

// A registered container agent's spec with a resolved model: the gateway refuses to issue for one without.
const SPEC = { image: "i", envManifestHash: null, extensions: [], provider: "p", model: "m", systemPrompt: null, egress: { kind: "registry" as const } };

test("gateway credentials are signed, scoped, and expire", () => {
  const credential = { agent: "a1", budgetMicros: 99, expiresAt: 1_001, issuedAt: 1, id: "a".repeat(32), models: [] };
  const token = encodeGatewayCredential("secret", credential);
  assert.deepEqual(decodeGatewayCredential("secret", token, 1_000), credential);
  assert.equal(decodeGatewayCredential("different", token, 1_000), null);
  assert.equal(decodeGatewayCredential("secret", `${token}x`, 1_000), null);
  assert.equal(decodeGatewayCredential("secret", token, 1_001), null);
});

test("proxy credential gateway never issues the upstream key and reuses an idempotency key", async () => {
  let now = 100;
  const fakeNow = () => now;
  const registry = new FakeRegistry(fakeNow);
  await agentRecord(registry);
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(fakeNow),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://model-relay.internal/v1",
    tokenTtlMs: 500,
    now: () => now,
  });
  const first = await gateway.issueKey("a1", 77, "start-1");
  const repeated = await gateway.issueKey("a1", 77, "start-1");
  assert.deepEqual(repeated, first);
  assert.equal(first.baseUrl, "http://model-relay.internal/v1");
  assert.doesNotMatch(first.key, /controller-secret|sk-|upstream/i);
  assert.deepEqual(gateway.authorize(first.key), {
    agent: "a1",
    budgetMicros: 77,
    expiresAt: 600,
    issuedAt: 100,
    id: decodeGatewayCredential("controller-secret", first.key, now)!.id,
    // The agent's resolved spec model, and only it.
    models: ["m"],
  });
  now = 600;
  assert.equal(gateway.authorize(first.key), null);
});

test("the issued key's model allowlist is the agent's resolved spec model, signed in", async () => {
  const clock = () => 1_000;
  const registry = new FakeRegistry(clock);
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(clock),
    registry,
    now: clock,
    secret: "s",
    proxyBaseUrl: "http://m/v1",
    tokenTtlMs: 60_000,
  });
  const a = await registry.create({
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 10,
    idempotencyKey: "a",
    spec: { ...SPEC, model: "claude-x" },
  });
  assert.deepEqual(gateway.authorize((await gateway.issueKey(a.id, 10)).key)?.models, ["claude-x"]);
});

test("a registered agent with no resolved model, or a deterministic agent, is refused at issue, naming the agent, the cause and the fix", async () => {
  const clock = () => 1_000;
  const registry = new FakeRegistry(clock);
  const debits = new FakeModelDebitStore({ secret: "s", now: clock });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(clock),
    registry,
    now: clock,
    secret: "s",
    proxyBaseUrl: "http://m/v1",
    tokenTtlMs: 60_000,
    debits,
  });
  const { provider: _p, model: _m, ...modelless } = SPEC;
  const b = await registry.create({ parent: null, name: "b", task: "t", host: "h", budgetMicros: 10, idempotencyKey: "b", spec: modelless });
  await assert.rejects(
    gateway.issueKey(b.id, 10, "k"),
    new RegExp(
      `agent ${b.id} has no model resolved \\(no model catalog is wired, or its spec names no model\\); no model credential is issued: spawn it with a model \\(--model PROVIDER/ID\\)`,
    ),
  );
  const d = await registry.create({
    parent: null,
    name: "d",
    task: "t",
    host: "h",
    budgetMicros: 10,
    idempotencyKey: "d",
    executor: "deterministic",
    spec: { driver: "x", input: {} },
  });
  await assert.rejects(
    gateway.issueKey(d.id, 10, "k"),
    new RegExp(`agent ${d.id} is a deterministic agent and makes no model calls; no model credential is issued`),
  );
  assert.deepEqual(
    debits.calls.filter((c) => c.method === "setBudget" || c.method === "issue"),
    [],
    "refused before any budget write or issuance",
  );
  // Negative control: the same gateway issues for a registered agent with a resolved model.
  const a = await registry.create({ parent: null, name: "a", task: "t", host: "h", budgetMicros: 10, idempotencyKey: "a", spec: SPEC });
  assert.deepEqual(gateway.authorize((await gateway.issueKey(a.id, 10, "k")).key)?.models, ["m"]);
});

test("issuing for an agent the registry does not know is refused at issue time, naming the agent and the action", async () => {
  const clock = () => 1_000;
  const debits = new FakeModelDebitStore({ secret: "s", now: clock });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(clock),
    registry: new FakeRegistry(clock),
    now: clock,
    secret: "s",
    proxyBaseUrl: "http://m/v1",
    tokenTtlMs: 60_000,
    debits,
  });
  await assert.rejects(gateway.issueKey("ghost", 10, "k"), /agent ghost is not registered.*register the agent with a spec\.model before issuing a credential/);
  assert.deepEqual(
    debits.calls.filter((c) => c.method === "setBudget" || c.method === "issue"),
    [],
    "refused before any budget write or issuance",
  );
});

test("proxy credential gateway revokes all issued credentials for an agent", async () => {
  const now = () => Date.now();
  const registry = new FakeRegistry(now);
  await registry.create({
    id: "a1",
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 10,
    idempotencyKey: "a",
    spec: SPEC,
  });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
  });
  const first = await gateway.issueKey("a1", 10, "one");
  const second = await gateway.issueKey("a1", 10, "two");
  await gateway.revoke("a1");
  assert.equal(gateway.authorize(first.key), null);
  assert.equal(gateway.authorize(second.key), null);
});

test("proxy credential gateway backs authorize/revoke onto the durable debit store", async () => {
  const now = () => Date.now();
  const registry = new FakeRegistry(now);
  await registry.create({
    id: "a1",
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 10,
    idempotencyKey: "a",
    spec: SPEC,
  });
  const debits = new FakeModelDebitStore({ secret: "controller-secret" });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
    debits,
  });
  const key = await gateway.issueKey("a1", 10, "one");
  assert.deepEqual(gateway.authorize(key.key), decodeGatewayCredential("controller-secret", key.key, now()));
  await gateway.revoke("a1");
  assert.equal(gateway.authorize(key.key), null);
  assert.deepEqual(debits.reserve(key.key, "r1", 1), { ok: false, reason: "invalid-credential" });
});

test("proxy credential gateway prunes expired issued and revoked entries but keeps live revocations", async () => {
  let now = 100;
  const registry = new FakeRegistry(() => now);
  for (const id of ["a1", "a2", "a3", "a4"]) await agentRecord(registry, id);
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(() => now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://model-relay.internal/v1",
    tokenTtlMs: 500,
    now: () => now,
  });
  const internals = gateway as unknown as { issued: Map<string, unknown>; revoked: Map<string, number> };
  const live = await gateway.issueKey("a1", 5, "k1");
  await gateway.issueKey("a2", 5, "k2");
  await gateway.revoke("a1").catch(() => {});
  assert.equal(internals.issued.size, 2);
  assert.equal(internals.revoked.size, 1);
  assert.equal(gateway.authorize(live.key), null);
  now = 599;
  await gateway.issueKey("a3", 5, "k3");
  assert.equal(internals.issued.size, 3, "unexpired entries stay");
  assert.equal(internals.revoked.size, 1, "revocation holds while the credential is unexpired");
  assert.equal(gateway.authorize(live.key), null);
  now = 600;
  await gateway.issueKey("a4", 5, "k4");
  assert.equal(internals.issued.size, 2, "expired entries dropped (a3 at 1099, a4)");
  assert.equal(internals.revoked.size, 0);
  assert.equal(gateway.authorize(live.key), null, "expired credential still rejected");
});

test("reclaimStaleReservations expires reservations older than twice the upstream timeout", () => {
  const store = new FakeModelDebitStore({ secret: "s" });
  assert.equal(reclaimStaleReservations(store, 30_000), 0);
  assert.deepEqual(store.calls.at(-1), { method: "expireReservations", args: [60_000] });
});

test("a yielded agent resumes with a fresh key; the old key stays dead and a terminal agent cannot issue", async () => {
  let t = 1_000;
  const now = () => t;
  const registry = new FakeRegistry(now);
  const rec = await registry.create({
    id: "a1",
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 100,
    idempotencyKey: "a",
    spec: SPEC,
  });
  const debits = new FakeModelDebitStore({ secret: "controller-secret", now });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 5_000,
    now,
    debits,
  });
  const old = await gateway.issueKey("a1", 100);
  assert.equal(debits.reserve(old.key, "r1", 10).ok, true);
  await gateway.revoke("a1"); // settleYield
  assert.deepEqual(debits.reserve(old.key, "r2", 1), { ok: false, reason: "invalid-credential" });
  t += 10;
  const resumed = await gateway.issueKey("a1", 100);
  assert.equal(debits.reserve(resumed.key, "r3", 10).ok, true);
  assert.equal(gateway.authorize(old.key), null);
  assert.notEqual(gateway.authorize(resumed.key), null);

  // issueKey's budget is the TOTAL cap: a higher one raises the bucket so a refused request goes through,
  // and the old (revoked) key stays dead.
  assert.deepEqual(debits.reserve(resumed.key, "r4", 91), { ok: false, reason: "budget-exhausted" });
  await gateway.revoke("a1");
  t += 10;
  const raised = await gateway.issueKey("a1", 300);
  assert.equal(debits.reserve(raised.key, "r4", 91).ok, true);
  assert.equal(debits.reserve(old.key, "r5", 1).ok, false);
  assert.equal(gateway.authorize(resumed.key), null);

  // exited and reaped agents get no credential, and their revocation persists.
  const running = await registry.transition("a1", rec.generation, "running", { idempotencyKey: "run" });
  await registry.transition("a1", running.generation, "exited", { exit: "succeeded", idempotencyKey: "exit" });
  await gateway.revoke("a1");
  t += 10;
  await assert.rejects(gateway.issueKey("a1", 100), /exited/);
  assert.equal(gateway.authorize(resumed.key), null);
});

test("gateway.spend reads the proxy debit store (the single spend authority), never the journal", async () => {
  const now = () => Date.now();
  const registry = new FakeRegistry(now);
  const rec = await registry.create({
    id: "a1",
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 100,
    idempotencyKey: "a",
    spec: SPEC,
  });
  const journal = new FakeJournal(now, registry);
  // Journaled Pi usage (cost.total) is informational only: it must not move the debit-store meter.
  await journal.append({
    agent: "a1",
    host: "h",
    generation: rec.generation,
    payload: { kind: "usage", inputTokens: 10, outputTokens: 5, costMicros: 42 },
    idempotencyKey: "u1",
  });
  const debits = new FakeModelDebitStore({ secret: "controller-secret" });
  const gateway = new ProxyCredentialGateway({
    journal,
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
    debits,
  });
  // No proxy call yet (the agent issued no key that reserved): no bucket, reads as 0.
  assert.deepEqual(await gateway.spend("a1"), { spentMicros: 0, budgetMicros: 100 });
  const { key } = await gateway.issueKey("a1", 100, "k1");
  const r = debits.reserve(key, "req-1", 60);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal((await gateway.spend("a1")).spentMicros, 0, "an in-flight reservation is not spend");
  assert.deepEqual(debits.settle(r.reservation, 12), { ok: true, chargedMicros: 12, remainingMicros: 88 });
  assert.deepEqual(await gateway.spend("a1"), { spentMicros: 12, budgetMicros: 100 });
  // A true overcharge (the provider billed past the reservation) is recorded in full.
  const r2 = debits.reserve(key, "req-2", 80);
  assert.ok(r2.ok);
  if (!r2.ok) return;
  debits.settle(r2.reservation, 95);
  assert.equal((await gateway.spend("a1")).spentMicros, 107);
  assert.deepEqual(await gateway.revoke("a1"), { unusedMicros: 0 });
});

test("gateway.priceUsage catalog-prices a zero-cost usage event per model", async () => {
  const now = () => Date.now();
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry: new FakeRegistry(now),
    secret: "s",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
    catalog: {
      provider: "deepseek",
      source: { lookup: (_p, model) => (model === "m1" ? { input: 3, output: 15, cacheRead: 1, cacheWrite: 2 } : null) },
    },
  });
  assert.equal(await gateway.priceUsage({ model: "m1", inputTokens: 1_000_000, outputTokens: 500_000 }), 10_500_000);
  assert.equal(await gateway.priceUsage({ model: "unknown", inputTokens: 1_000_000, outputTokens: 500_000 }), null);
  assert.equal(await gateway.priceUsage({ inputTokens: 1, outputTokens: 1 }), null, "no model: unpriced");
  const uncatalogued = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry: new FakeRegistry(now),
    secret: "s",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
  });
  assert.equal(await uncatalogued.priceUsage({ model: "m1", inputTokens: 1, outputTokens: 1 }), null, "no catalog wired: unpriced");
});

test("a key issued right after a revocation in the same millisecond is stamped strictly later and stays valid", async () => {
  const now = () => 1_000;
  const registry = new FakeRegistry(now);
  const debits = new FakeModelDebitStore({ secret: "controller-secret", now });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
    now,
    debits,
  });
  await agentRecord(registry);
  const old = await gateway.issueKey("a1", 10);
  await gateway.revoke("a1");
  const fresh = await gateway.issueKey("a1", 10);
  assert.equal(gateway.authorize(old.key), null, "the old key is dead");
  assert.ok(gateway.authorize(fresh.key), "the same-millisecond fresh key is alive");
  assert.equal(decodeGatewayCredential("controller-secret", fresh.key, 1_000)?.issuedAt, 1_001);
});

// Gateway + durable store (the real atomic issuance): a backward clock or a restart cannot resurrect a credential
// issued before a revoke, and a fresh issue after the revoke is valid. Expiry stays a TTL from the wall-clock issue.
const sqliteGateway = async (file: string, clock: () => number, registry: FakeRegistry, secret = "controller-secret") => {
  const store = openStore(file);
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(clock),
    registry,
    secret,
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 5_000,
    now: clock,
    debits: store.modelDebit({ secret, now: clock }),
  });
  return { store, gateway };
};
const agentRecord = (registry: FakeRegistry, id = "a1") =>
  registry.create({
    id,
    parent: null,
    name: "a",
    task: "t",
    host: "h",
    budgetMicros: 100,
    idempotencyKey: id,
    spec: SPEC,
  });

test("a backward clock step cannot resurrect a pre-revoke key through the gateway; the fresh issue is valid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-backward-"));
  try {
    let t = 10_000;
    const clock = () => t;
    const registry = new FakeRegistry(clock);
    await agentRecord(registry);
    const { store, gateway } = await sqliteGateway(join(dir, "s.sqlite"), clock, registry);
    const old = await gateway.issueKey("a1", 100);
    assert.equal(decodeGatewayCredential("controller-secret", old.key, clock())?.issuedAt, 10_000);
    t = 5_000;
    await gateway.revoke("a1");
    assert.equal(gateway.authorize(old.key), null, "the 10000-stamped key is dead after a revoke at clock 5000");
    const fresh = await gateway.issueKey("a1", 100);
    const freshCredential = decodeGatewayCredential("controller-secret", fresh.key, t);
    assert.ok(freshCredential && freshCredential.issuedAt > 10_000, "the fresh stamp is above the high-water");
    assert.equal(freshCredential.expiresAt, 5_000 + 5_000, "expiry is a TTL from the wall-clock issue, not from the stamp");
    assert.ok(gateway.authorize(fresh.key), "the fresh key is alive");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart: the high-water persists, so a resume after reopen at a lower clock is valid and the old key stays dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-restart-"));
  try {
    const file = join(dir, "s.sqlite");
    let t = 10_000;
    const clock = () => t;
    const registry = new FakeRegistry(clock);
    await agentRecord(registry);
    let g = await sqliteGateway(file, clock, registry);
    const old = await g.gateway.issueKey("a1", 100);
    g.store.close();

    t = 5_000;
    g = await sqliteGateway(file, clock, registry); // a fresh process: no revokedAt map survives
    await g.gateway.revoke("a1");
    assert.equal(g.gateway.authorize(old.key), null);
    const resumed = await g.gateway.issueKey("a1", 100);
    assert.ok(g.gateway.authorize(resumed.key), "the post-restart resume key is valid");
    assert.equal(g.gateway.authorize(old.key), null);
    g.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two gateways on two handles to one file: a issue after the other handle's revoke is valid, the earlier key dead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-two-"));
  try {
    const file = join(dir, "s.sqlite");
    let t = 10_000;
    const clock = () => t;
    const registry = new FakeRegistry(clock);
    await agentRecord(registry);
    const a = await sqliteGateway(file, clock, registry);
    const b = await sqliteGateway(file, clock, registry);
    const early = await a.gateway.issueKey("a1", 100);
    t = 5_000;
    await b.gateway.revoke("a1");
    assert.equal(a.gateway.authorize(early.key), null);
    const late = await a.gateway.issueKey("a1", 100);
    assert.ok(b.gateway.authorize(late.key));
    assert.equal(b.gateway.authorize(early.key), null);
    a.store.close();
    b.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a issue whose expiry sum is not a safe integer is refused before any issuance or budget write", async () => {
  const now = () => Number.MAX_SAFE_INTEGER - 10;
  const registry = new FakeRegistry(now);
  await agentRecord(registry);
  const debits = new FakeModelDebitStore({ secret: "controller-secret", now });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 100,
    now,
    debits,
  });
  await assert.rejects(gateway.issueKey("a1", 10, "k"), /safe integer/);
  assert.equal(debits.calls.filter((c) => c.method === "issue" || c.method === "setBudget").length, 0, "no issue and no budget write");
});

test("a synthetic issuedAt above expiresAt expires exactly at the wall-clock expiry; the revoked key stays dead", async () => {
  let t = 10_000;
  const clock = () => t;
  const registry = new FakeRegistry(clock);
  await agentRecord(registry);
  const debits = new FakeModelDebitStore({ secret: "controller-secret", now: clock });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(clock),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 5_000,
    now: clock,
    debits,
  });
  const old = await gateway.issueKey("a1", 10); // issuedAt 10000, expires 15000
  await gateway.revoke("a1");
  t = 5_000; // backward step
  const fresh = await gateway.issueKey("a1", 10);
  const credential = decodeGatewayCredential("controller-secret", fresh.key, 9_999);
  assert.ok(credential);
  assert.equal(credential.expiresAt, 10_000, "wall-clock expiry: 5000 + ttl");
  assert.ok(credential.issuedAt > credential.expiresAt, "the logical stamp exceeds the wall-clock expiry");
  assert.ok(gateway.authorize(fresh.key), "valid just before expiry");
  t = 10_000;
  assert.equal(gateway.authorize(fresh.key), null, "expires exactly at expiresAt");
  assert.equal(gateway.authorize(old.key), null, "the pre-revoke key stays revoked");
});

test("an idempotent issue replay does not advance the issuance high-water", async () => {
  const now = () => 1_000;
  const registry = new FakeRegistry(now);
  await agentRecord(registry);
  const debits = new FakeModelDebitStore({ secret: "controller-secret", now });
  const gateway = new ProxyCredentialGateway({
    journal: new FakeJournal(now),
    registry,
    secret: "controller-secret",
    proxyBaseUrl: "http://relay",
    tokenTtlMs: 500,
    now,
    debits,
  });
  const first = await gateway.issueKey("a1", 10, "start");
  assert.deepEqual(await gateway.issueKey("a1", 10, "start"), first);
  assert.equal(debits.calls.filter((c) => c.method === "issue").length, 1, "only the first issueKey takes a stamp");
});

test("gateway checkCredential names the refusal: expired, revoked (process-local), invalid; the durable store's when wired", async () => {
  let now = 100;
  const registry = new FakeRegistry(() => now);
  const local = new ProxyCredentialGateway({
    journal: new FakeJournal(() => now),
    registry,
    secret: "s",
    proxyBaseUrl: "http://p/v1",
    tokenTtlMs: 500,
    now: () => now,
  });
  await agentRecord(registry, "a1");
  await agentRecord(registry, "a2");
  // The process-local fallback revokes only keys it cached (issued with an idempotency key), as `authorize` does.
  const { key } = await local.issueKey("a1", 10, "start-1");
  assert.equal(local.checkCredential(key).ok, true);
  assert.deepEqual(local.checkCredential(`${key}x`), { ok: false, reason: "invalid" });
  await local.revoke("a1");
  assert.deepEqual(local.checkCredential(key), { ok: false, reason: "revoked" });
  now = 600;
  assert.deepEqual(local.checkCredential(key), { ok: false, reason: "expired" });
  const debits = new FakeModelDebitStore({ secret: "s", now: () => now });
  const durable = new ProxyCredentialGateway({
    journal: new FakeJournal(() => now),
    registry,
    secret: "s",
    proxyBaseUrl: "http://p/v1",
    tokenTtlMs: 500,
    now: () => now,
    debits,
  });
  const issued = await durable.issueKey("a2", 10);
  assert.equal(durable.checkCredential(issued.key).ok, true);
  assert.deepEqual(debits.calls.at(-1), { method: "checkCredential", args: [issued.key] });
});
