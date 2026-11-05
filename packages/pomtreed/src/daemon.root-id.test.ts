import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { POMTREED_KINDS, RootWithdrawalError } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { ScriptHarness, createFakes, tmpDir } from "@pomtree/testing";
import { buildChannelRegistry } from "./channels.ts";
import { Daemon, rootAgentIdFor } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { HostPlacement } from "./placement.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { SECRET, spawnSpec } from "./test-setup.ts";

// One "boot" of the daemon over a sqlite file with the given root pool.
function boot(dbPath: string, rootBudgetMicros: number) {
  const fakes = createFakes({ host: "h1" });
  const store = openStore(dbPath);
  const daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: "/host/pomtreed.sock",
    rootBudgetMicros,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox: fakes.hooks.raw.sandbox,
    workspace: fakes.hooks.raw.workspace,
    harness: new ScriptHarness(async () => {}),
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: tmpDir("pomtreed-sess-"),
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement: new HostPlacement({ hosts: store.hosts, host: "h1" }),
    orchestrator: new LocalOrchestrator(),
  });
  return { store, daemon };
}

const ageIdempotency = (dbPath: string, days: number) => {
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE idempotency SET created_at = ?").run(Date.now() - days * 86_400_000);
  raw.close();
};

test("root-id: a restart after the idempotency prune keeps one root with the same id, pool and children (root re-creation repro)", async () => {
  const dbPath = join(tmpDir("pomtreed-root-"), "pomtreed.sqlite");
  const one = boot(dbPath, 10_000_000);
  const root = await one.daemon.root();
  assert.equal(root.id, rootAgentIdFor("h1"), "a stable id derived from the host");
  const child = await one.store.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "top",
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: "top",
  });
  // Past the 30-day retention, every idempotency row goes (even the kept scopes, to prove the root does not depend on them).
  ageIdempotency(dbPath, 31);
  one.store.pruneIdempotency(30 * 86_400_000);
  const raw = new DatabaseSync(dbPath);
  raw.prepare("DELETE FROM idempotency").run();
  raw.close();
  one.store.close();

  const two = boot(dbPath, 10_000_000);
  const again = await two.daemon.root();
  assert.equal(again.id, root.id);
  const roots = (await two.store.registry.list()).filter((a) => a.parent === null);
  assert.equal(roots.length, 1, "no second root with a fresh pool");
  assert.equal(roots[0]!.budgetMicros, 10_000_000);
  assert.equal((await two.store.registry.get(child.id))?.parent, root.id, "existing top-level agents keep their parent");
  two.store.close();
});

test("root pool: a raised budget.rootMicros is a journaled operator top-up, a lowered one a journaled withdrawal, each applied once", async () => {
  const dbPath = join(tmpDir("pomtreed-root-"), "pomtreed.sqlite");
  const one = boot(dbPath, 10_000);
  const root = await one.daemon.reconcileRootPool();
  assert.equal(root.budgetMicros, 10_000);
  one.store.close();
  const moves = async (b: ReturnType<typeof boot>) =>
    (await b.store.journal.read({ agent: root.id }))
      .map((e) => e.payload as unknown as Record<string, unknown>)
      .filter((p) => p.kind === POMTREED_KINDS.budgetTopUp || p.kind === POMTREED_KINDS.budgetWithdrawal);

  const two = boot(dbPath, 15_000);
  assert.equal((await two.daemon.reconcileRootPool()).budgetMicros, 15_000);
  assert.deepEqual(await moves(two), [{ kind: POMTREED_KINDS.budgetTopUp, from: 10_000, to: 15_000, by: "operator" }]);
  two.store.close();

  // A restart at the same value is a no-op (never a second row).
  const three = boot(dbPath, 15_000);
  assert.equal((await three.daemon.reconcileRootPool()).budgetMicros, 15_000);
  assert.equal((await moves(three)).length, 1);
  // A child holds 4000 of the pool.
  await three.store.registry.create({ spec: spawnSpec, parent: root.id, name: "c", task: "t", host: "h1", budgetMicros: 4_000, idempotencyKey: "c" });
  three.store.close();

  const four = boot(dbPath, 12_000);
  assert.equal((await four.daemon.reconcileRootPool()).budgetMicros, 12_000);
  assert.deepEqual((await moves(four)).at(-1), { kind: POMTREED_KINDS.budgetWithdrawal, from: 15_000, to: 12_000, by: "operator" });
  four.store.close();

  // Back up to an earlier total is a fresh top-up, not a replay of the first one.
  const five = boot(dbPath, 15_000);
  assert.equal((await five.daemon.reconcileRootPool()).budgetMicros, 15_000);
  assert.equal((await moves(five)).length, 3);
  five.store.close();

  // 11000 is unheld; withdrawing 11001 is refused in full (never clipped), so startup is refused and nothing changes.
  const six = boot(dbPath, 3_999);
  const err = await six.daemon.reconcileRootPool().then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RootWithdrawalError);
  assert.deepEqual([err.requestedMicros, err.heldMicros, err.availableMicros], [11_001, 4_000, 11_000]);
  assert.match(err.message, /set budget\.rootMicros to at least 4000/);
  assert.equal((await six.store.registry.get(root.id))?.budgetMicros, 15_000, "never silently shrunk");
  assert.equal((await moves(six)).length, 3);
  six.store.close();

  // The largest withdrawal that fits lands.
  const seven = boot(dbPath, 4_000);
  assert.equal((await seven.daemon.reconcileRootPool()).budgetMicros, 4_000);
  seven.store.close();
});
