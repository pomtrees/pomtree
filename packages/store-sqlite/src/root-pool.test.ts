import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeGatewayCredential, POMTREED_KINDS, RootWithdrawalError } from "@pomtree/core";
import { openStore } from "./store.ts";
import { tmpDir } from "@pomtree/testing";

const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };

function withFile(fn: (file: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = tmpDir("root-pool-");
    await fn(join(dir, "pomtreed.sqlite"));
  };
}

test(
  "topup-atomic: a journal write that fails rolls the pool change back with it",
  withFile(async (file) => {
    const s = openStore(file);
    const root = await s.registry.create({ parent: null, name: "root", task: "t", host: "h", budgetMicros: 1_000, idempotencyKey: "root", spec });
    s.close();
    // A crash between the two writes, simulated: the journal insert fails inside the transaction.
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    raw.close();
    const s2 = openStore(file);
    await assert.rejects(s2.registry.setRootPool(root.id, 2_000, "up"), /disk full/);
    assert.equal((await s2.registry.get(root.id))?.budgetMicros, 1_000, "the raise did not land without its journal row");
    await assert.rejects(s2.registry.setRootPool(root.id, 500, "down"), /disk full/);
    assert.equal((await s2.registry.get(root.id))?.budgetMicros, 1_000, "nor the withdrawal");
    s2.close();
    const raw2 = new DatabaseSync(file);
    raw2.exec("DROP TRIGGER fail_journal");
    raw2.close();
    const s3 = openStore(file);
    const up = await s3.registry.setRootPool(root.id, 2_000, "up");
    assert.equal(up.record.budgetMicros, 2_000);
    assert.equal((await s3.journal.read({ agent: root.id })).filter((e) => e.payload.kind === POMTREED_KINDS.budgetTopUp).length, 1);
    s3.close();
  }),
);

test("budget-withdrawal: the root's own settled and in-flight model use is held too", async () => {
  const s = openStore();
  const secret = "rp-secret";
  const debits = s.modelDebit({ secret });
  const root = await s.registry.create({ parent: null, name: "root", task: "t", host: "h", budgetMicros: 1_000, idempotencyKey: "root", spec });
  const key = encodeGatewayCredential(secret, {
    agent: root.id,
    id: "c".repeat(32),
    budgetMicros: 1_000,
    expiresAt: Date.now() + 3_600_000,
    issuedAt: 1,
    models: ["m"],
  });
  const settled = debits.reserve(key, "r1", 200);
  assert.ok(settled.ok);
  debits.settle(settled.reservation, 150);
  assert.ok(debits.reserve(key, "r2", 100).ok, "100 in flight");
  // Held: 150 spent + 100 in flight = 250; available 750.
  const err = await s.registry.setRootPool(root.id, 249, "over").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof RootWithdrawalError);
  assert.deepEqual([err.requestedMicros, err.heldMicros, err.availableMicros], [751, 250, 750]);
  assert.equal((await s.registry.setRootPool(root.id, 250, "fits")).record.budgetMicros, 250);
  s.close();
});
