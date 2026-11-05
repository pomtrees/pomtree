import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IdempotencyConflictError } from "@pomtree/core";
import { openStore } from "./store.ts";
import { tmpDir } from "@pomtree/testing";

const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };
const req = (key: string, budgetMicros = 100, extra: { id?: string; parent?: string | null } = {}) => ({
  parent: extra.parent ?? null,
  name: "a",
  task: "t",
  host: "h1",
  budgetMicros,
  idempotencyKey: key,
  spec,
  ...(extra.id !== undefined && { id: extra.id }),
});

test("idem-fingerprint: a key replayed with the same request replays; with a different one it is a typed 409-class conflict", async () => {
  const s = openStore();
  const a = await s.registry.create(req("spawn-1"));
  // Field order does not matter: the fingerprint is over canonical JSON.
  const { spec: sp, ...rest } = req("spawn-1");
  assert.equal((await s.registry.create({ spec: sp, ...rest })).id, a.id);
  const err = await s.registry.create(req("spawn-1", 999)).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof IdempotencyConflictError, "a different body under one key is refused");
  assert.equal(err.code, "idempotency_conflict");
  assert.equal(err.scope, "registry.create");
  assert.match(err.message, /retry the original request unchanged, or use a new key/);
  assert.equal((await s.registry.list()).length, 1, "the conflict created nothing");
  await s.registry.raiseBudget(a.id, 5, "raise-1");
  await assert.rejects(() => s.registry.raiseBudget(a.id, 6, "raise-1"), IdempotencyConflictError);
  assert.equal((await s.registry.get(a.id))?.budgetMicros, 105);
  await s.mailbox.send(a.id, { kind: "message", from: "user", body: "hi" } as never, "m-1");
  await assert.rejects(() => s.mailbox.send(a.id, { kind: "message", from: "user", body: "bye" } as never, "m-1"), IdempotencyConflictError);
  s.close();
});

test("idem-fingerprint: a row stored before fingerprints existed matches any replay (no false conflict on upgrade)", async () => {
  const dir = tmpDir("idem-legacy-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  const a = await s.registry.create(req("legacy"));
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE idempotency SET fingerprint = NULL").run();
  raw.close();
  assert.equal((await s.registry.create(req("legacy", 7))).id, a.id);
  s.close();
});

test("registry.create with a caller-chosen id is an identity: a re-create under a new key returns it; a different parent/host is refused", async () => {
  const s = openStore();
  const root = await s.registry.create(req("root:h1", 100, { id: "root-h1" }));
  assert.equal((await s.registry.create(req("another-key", 100, { id: "root-h1" }))).id, root.id);
  await assert.rejects(() => s.registry.create(req("third", 100, { id: "root-h1", parent: root.id })), /already exists with parent none/);
  assert.equal((await s.registry.list()).length, 1);
  s.close();
});

test("quota counters: argument errors name the bad argument (sqlite)", () => {
  const q = openStore().quotaCounters();
  assert.throws(() => q.take("s", "k", 0, -1, 3), /amount must be a non-negative safe integer/);
  assert.throws(() => q.take("s", "k", 0, 1, 1.5), /limit must be a non-negative safe integer/);
});

test("quota counters survive a reopen and the sweep prunes old windows but never a live lifetime (window 0) counter", () => {
  const dir = tmpDir("quota-");
  const file = join(dir, "s.sqlite");
  let s = openStore(file);
  s.quotaCounters().take("web_fetch.calls", "a1", 1_000, 1, 5);
  s.quotaCounters().take("web_fetch.calls", "a1", 9_000, 1, 5);
  s.quotaCounters().take("web_fetch.bytes", "a1", 0, 100, 1_000);
  s.quotaCounters().take("web_fetch.bytes", "a-gone", 0, 100, 1_000);
  s.close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE quota_counters SET updated_at = 1 WHERE key = 'a-gone'").run();
  raw.close();
  s = openStore(file);
  assert.equal(s.quotaCounters().peek("web_fetch.calls", "a1", 1_000), 1, "durable across a restart (SPEC rule 6)");
  assert.equal(s.pruneQuotaCounters(5_000), 2, "the old window and the untouched lifetime row go");
  assert.equal(s.quotaCounters().peek("web_fetch.calls", "a1", 1_000), 0);
  assert.equal(s.quotaCounters().peek("web_fetch.calls", "a1", 9_000), 1);
  assert.equal(s.quotaCounters().peek("web_fetch.bytes", "a1", 0), 100, "a lifetime cap touched since the cutoff is kept");
  s.close();
});
