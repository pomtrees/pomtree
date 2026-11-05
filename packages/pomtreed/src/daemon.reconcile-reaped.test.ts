import assert from "node:assert/strict";
import { test } from "node:test";
import { setup, spawnSpec } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

// Reaped rows are never deleted, so a steady-state reconcile pass must not read the whole registry: every registry.list it issues
// filters by state, and the unfiltered list (which would return the reaped history) is gone from the periodic passes.
test("a reconcile pass over a registry full of reaped children lists only filtered rows", async () => {
  const t = setup(async (c: Ctx) => void (await c.stopped));
  const reg = t.fakes.hooks.raw.registry;
  const root = await t.daemon.root();
  for (let i = 0; i < 40; i++) {
    const key = `r${i}`;
    const a = await reg.create({ spec: spawnSpec, parent: root.id, name: key, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: key });
    await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
    await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${key}-exit` });
    await reg.transition(a.id, a.generation, "reaped", { idempotencyKey: `${key}-reap` });
  }
  t.fakes.calls.splice(0);

  await t.daemon.reconcile();

  const lists = t.fakes.calls.filter((c) => c.port === "Registry" && c.method === "list");
  assert.ok(lists.length > 0, "the pass still lists the registry");
  for (const c of lists) {
    const o = (c.args[0] ?? {}) as { state?: string; excludeState?: string };
    assert.ok(o.state !== undefined || o.excludeState === "reaped", `unfiltered registry.list in the reconcile pass: ${JSON.stringify(o)}`);
  }
  const orphanAndPrune = lists.filter((c) => (c.args[0] as { excludeState?: string } | undefined)?.excludeState === "reaped");
  assert.equal(orphanAndPrune.length, 2, "phaseOrphans and phasePrune both pass excludeState reaped");
});

// A crash after reapNow's `reaped` row but before its gateway revoke: the boot replay must still revoke the key.
test("boot replay revokes a reaped agent's gateway key even when its reaped row is already journaled", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "rv", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "rv" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "rv-run" });
  await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: "rv-x" });
  const reaped = await reg.transition(a.id, a.generation, "reaped", { idempotencyKey: "rv-r" });
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: reaped.generation,
    payload: { kind: "reaped" },
    idempotencyKey: `${a.id}:${reaped.generation}:reaped`,
  });
  const revoked: string[] = [];
  const gw = t.daemon.deps.gateway;
  t.daemon.deps.gateway = Object.assign(Object.create(gw), {
    revoke: async (id: string) => {
      revoked.push(id);
      return gw.revoke(id);
    },
  });
  await t.daemon.recover();
  assert.ok(revoked.includes(a.id), "the gateway key is revoked at boot despite the journaled reaped row");
});
