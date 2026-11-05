import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { buildTree } from "@pomtree/observe";
import { openStore } from "@pomtree/store-sqlite";
import { tmpDir } from "@pomtree/testing";
import { ProxyCredentialGateway } from "./gateway.ts";
import { settlementPayload } from "./model-settlement.ts";
import { SECRET, setup, spawnSpec } from "./test-setup.ts";

test("accounting proof: direct display, fleet spend and hierarchical headroom reconcile across reopen and journal pruning", async (ctx) => {
  let clock = 1_000_000;
  ctx.mock.method(Date, "now", () => clock);
  const file = join(tmpDir("analytics-accounting-"), "store.sqlite");
  let store = openStore(file);
  const world = () => {
    const debits = store.modelDebit({ secret: SECRET });
    const gateway = new ProxyCredentialGateway({
      journal: store.journal,
      registry: store.registry,
      secret: SECRET,
      proxyBaseUrl: "http://model.invalid",
      tokenTtlMs: 3_600_000,
      debits,
    });
    const t = setup(async () => {}, { registry: store.registry, journal: store.journal, gateway });
    return { debits, gateway, ...t };
  };
  try {
    let t = world();
    const root = await t.daemon.root();
    const create = async (id: string, parent: string, budgetMicros: number) => {
      const a = await store.registry.create({ id, parent, budgetMicros, name: id, task: "proof", host: "h1", spec: spawnSpec, idempotencyKey: id });
      return store.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${id}:run` });
    };
    const parent = await create("parent", root.id, 1_000);
    const child = await create("child", parent.id, 400);
    const reserve = async (a: AgentRecord, requestId: string, micros: number) => {
      const { key } = await t.gateway.issueKey(a.id, a.budgetMicros);
      const r = t.debits.reserve(key, requestId, micros);
      assert.ok(r.ok);
      return r.reservation;
    };
    const parentCall = await reserve(parent, "p-call", 100);
    assert.equal(t.debits.settle(parentCall, 80).ok, true);
    const record = (a: AgentRecord, requestId: string, costMicros: number, key = `${a.id}:usage:${requestId}`) =>
      store.journal.append({
        agent: a.id,
        host: a.host,
        generation: a.generation,
        payload: { kind: "usage", requestId, costMicros, costSource: "settled", inputTokens: 10, outputTokens: 2 },
        idempotencyKey: key,
      });
    const firstUsage = await record(parent, parentCall.requestId, 80);
    const childCall = await reserve(child, "c-call", 200);
    const summary = async () => (await t.operator("GET", "/v1/summary")).body as { totalSpendMicros: number };
    assert.equal((await summary()).totalSpendMicros, 80, "in-flight reservations are not settled spend");
    assert.equal(await t.daemon.remainingMicros(parent), 520, "the live child holds its whole 400 carve beside the parent's 80");
    assert.equal(t.debits.settle(childCall, 120).ok, true);
    await record(child, childCall.requestId, 120);
    for (const [a, call, micros] of [
      [parent, parentCall, 80],
      [child, childCall, 120],
    ] as const)
      await store.journal.append({
        agent: a.id,
        host: a.host,
        generation: a.generation,
        payload: settlementPayload({ agent: a.id, requestId: call.requestId, kind: "priced", micros }),
        idempotencyKey: `${a.id}:settlement`,
      });
    const rows = buildTree(await store.registry.list(), await store.journal.read({}), { now: clock });
    assert.deepEqual(
      rows.filter((r) => r.id !== root.id).map((r) => [r.id, r.costMicros, r.remainingBudgetMicros]),
      [
        [parent.id, 80, 920],
        [child.id, 120, 280],
      ],
      "rows show own usage without adding settlement entries or child charges again",
    );
    assert.equal((await summary()).totalSpendMicros, 200, "fleet spend sums direct charges once");
    await store.registry.transition(child.id, child.generation, "exited", { exit: "succeeded", idempotencyKey: "child:exit" });
    await store.registry.transition(child.id, child.generation, "reaped", { idempotencyKey: "child:reap" });
    assert.equal(await t.daemon.remainingMicros(parent), 800, "reaping returns the unused 280 of the child's carve");
    await reserve(parent, "p-in-flight", 50);
    assert.equal(await t.daemon.remainingMicros(parent), 750);
    store.close();
    store = openStore(file);
    t = world();
    assert.equal((await summary()).totalSpendMicros, 200);
    assert.equal(await t.daemon.remainingMicros(parent), 750, "reopen retains the 50 reservation and descendant spend");
    assert.equal((await record(parent, parentCall.requestId, 80)).seq, firstUsage.seq, "replaying usage retains its identity after reopen");
    assert.equal(t.debits.settle(parentCall, 80).ok, true, "settlement replay is harmless too");
    assert.equal((await summary()).totalSpendMicros, 200);
    clock += 1_000;
    assert.equal((await store.journal.pruneJournal({ olderThanMs: 0, keepPerAgent: 0, kinds: ["usage"] })).deleted, 2);
    assert.ok(store.pruneIdempotency(0) > 0, "ordinary append keys expire");
    store.close();
    store = openStore(file);
    t = world();
    const resumed = await store.registry.bumpGeneration(parent.id, parent.host, "parent:resumed");
    assert.deepEqual(
      await record(resumed, parentCall.requestId, 999, "new-key-after-pruning"),
      firstUsage,
      "joined identity survives both kinds of pruning and reopen",
    );
    assert.equal((await summary()).totalSpendMicros, 200);
    assert.equal((await store.journal.spendFor(parent.id)).costMicros, 80);
    assert.equal((await store.journal.spendFor(child.id)).costMicros, 120);
    assert.equal(await t.daemon.remainingMicros(parent), 750);
    assert.ok(buildTree(await store.registry.list(), await store.journal.read({}), { now: clock }).every((r) => r.costMicros === 0));
  } finally {
    store.close();
  }
});
