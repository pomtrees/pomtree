import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STATE_DOC_BYTES_CEILING, STATE_DOC_BYTES_CONFIG_MAX, STATE_TOMBSTONES_CEILING, StateError } from "@pomtree/core";
import type { StateLimits } from "@pomtree/core";
import { CONTRACT_SPAWN_SPEC } from "@pomtree/testing";
import { openStore } from "./store.ts";
import { openStateStore, STATE_SCHEMA_VERSION } from "./state-store.ts";
import { tmpDir } from "@pomtree/testing";

// The shared StateStore contract body runs against this store in packages/e2e/src/contract.test.ts; this file covers what is
// specific to the SQLite realization: its own schema chain, database-level invariants, cross-connection atomicity and store options.

const op = { operator: true as const };
const withDir = async (fn: (dir: string) => void | Promise<void>): Promise<void> => {
  const dir = tmpDir("store-state-");
  await fn(dir);
};
const raw = <T>(file: string, fn: (d: DatabaseSync) => T): T => {
  const d = new DatabaseSync(file);
  try {
    return fn(d);
  } finally {
    d.close();
  }
};
const version = (file: string): number => raw(file, (d) => (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
const hasTable = (file: string, name: string): boolean =>
  raw(file, (d) => d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined);
const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof StateError);
    return e.kind;
  }
  return assert.fail("expected a StateError");
};

test("a fresh state store is at its own current version with the state_docs table and no production tables", () =>
  withDir((dir) => {
    const file = join(dir, "state.sqlite");
    openStateStore(file).close();
    assert.equal(STATE_SCHEMA_VERSION, 1);
    assert.equal(version(file), STATE_SCHEMA_VERSION);
    assert.ok(hasTable(file, "state_docs"));
    assert.ok(hasTable(file, "state_floor"));
    assert.ok(hasTable(file, "idempotency"));
    assert.equal(hasTable(file, "agents"), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test("a current state database upgrades through the state chain keeping its data, after a 0600 backup; state then persists", () =>
  withDir(async (dir) => {
    const file = join(dir, "state.sqlite");
    const s = openStateStore(file);
    assert.ok((await s.state.put({ owner: "o", key: "k", value: { n: 1 }, writer: op }, "p1")).ok);
    s.close();

    const v2 = [{ version: STATE_SCHEMA_VERSION + 1, up: (d: DatabaseSync) => d.exec("CREATE TABLE state_extra (x)") }];
    const up = openStateStore(file, { migrations: v2 });
    assert.equal(version(file), STATE_SCHEMA_VERSION + 1);
    assert.deepEqual((await up.state.get("o", "k"))?.value, { n: 1 });
    up.close();
    const bak = `${file}.pre-v${STATE_SCHEMA_VERSION}.bak`;
    assert.ok(existsSync(bak));
    assert.equal(statSync(bak).mode & 0o777, 0o600);
    assert.equal(version(bak), STATE_SCHEMA_VERSION);
    assert.equal(hasTable(bak, "state_extra"), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }));

test("a state database newer than this binary's chain is refused", () =>
  withDir((dir) => {
    const file = join(dir, "state.sqlite");
    openStateStore(file).close();
    raw(file, (d) => d.exec(`PRAGMA user_version = ${STATE_SCHEMA_VERSION + 1}`));
    assert.throws(() => openStateStore(file), /state store .* newer than this binary supports/);
    assert.equal(version(file), STATE_SCHEMA_VERSION + 1);
  }));

test("opening the state db never touches pomtreed.sqlite, and opening the main store never creates state.sqlite", () =>
  withDir(async (dir) => {
    const main = join(dir, "pomtreed.sqlite");
    const st = join(dir, "state.sqlite");
    openStateStore(st).close();
    assert.equal(existsSync(main), false);
    openStore(main).close();
    rmSync(st);
    rmSync(`${st}-wal`, { force: true });
    rmSync(`${st}-shm`, { force: true });
    const before = version(main);
    openStore(main).close();
    assert.equal(existsSync(st), false);
    assert.equal(hasTable(main, "state_docs"), false);
    assert.equal(version(main), before);
    // And the other way round with the main store already present: the state open leaves it byte-for-byte alone.
    const mtime = statSync(main).mtimeMs;
    openStateStore(st).close();
    assert.equal(statSync(main).mtimeMs, mtime);
  }));

test("the table's CHECK constraints reject content on a tombstone, a live row without content, and an oversize row", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStateStore(file).close();
    const ins = (d: DatabaseSync, value: string | null, bytes: number, deletedAt: number | null) =>
      d
        .prepare("INSERT INTO state_docs (owner,key,rev,value,bytes,created_at,updated_at,deleted_at,writer) VALUES ('o',?,1,?,?,1,1,?,'{}')")
        .run(`k${Math.random()}`, value, bytes, deletedAt);
    raw(file, (d) => {
      assert.throws(() => ins(d, "1", 1, 5), /CHECK/, "value on a tombstone");
      assert.throws(() => ins(d, null, 0, null), /CHECK/, "live row without a value");
      assert.throws(() => ins(d, "1", STATE_DOC_BYTES_CEILING + 1, null), /CHECK/, "over the hard ceiling");
      ins(d, "1", STATE_DOC_BYTES_CEILING, null);
      ins(d, null, 0, 5);
    });
  }));

test("a tombstone keeps no content or size, only its rev, and the live-only index exists", async () =>
  withDir(async (dir) => {
    const file = join(dir, "s.sqlite");
    const s = openStateStore(file);
    await s.state.put({ owner: "o", key: "k", value: { secret: "hunter2-planted" }, writer: op }, "p1");
    await s.state.remove({ owner: "o", key: "k", writer: op }, "r1");
    const row = raw(file, (d) => ({ ...(d.prepare("SELECT * FROM state_docs WHERE owner='o' AND key='k'").get() as Record<string, unknown>) }));
    assert.equal(row.value, null);
    assert.equal(row.bytes, 0);
    assert.equal(row.rev, 1);
    assert.equal(typeof row.deleted_at, "number");
    assert.ok(!JSON.stringify(row).includes("hunter2"));
    const idx = raw(file, (d) => d.prepare("SELECT sql FROM sqlite_master WHERE name='state_docs_live'").get() as { sql: string });
    assert.match(idx.sql, /WHERE deleted_at IS NULL/);
    // Idempotency rows hold results only; the removed value is not in the put's replay record of the remove.
    const rmRow = raw(file, (d) => d.prepare("SELECT result FROM idempotency WHERE scope='state.rm:o'").get() as { result: string });
    assert.ok(!rmRow.result.includes("hunter2"));
    s.close();
  }));

test("rev continues past a removal, also across a reopen", async () =>
  withDir(async (dir) => {
    const file = join(dir, "s.sqlite");
    let s = openStateStore(file);
    await s.state.put({ owner: "o", key: "k", value: 1, writer: op }, "p1");
    await s.state.put({ owner: "o", key: "k", value: 2, writer: op }, "p2");
    await s.state.remove({ owner: "o", key: "k", writer: op }, "r1");
    s.close();
    s = openStateStore(file);
    const r = await s.state.put({ owner: "o", key: "k", value: 3, writer: op }, "p3");
    assert.ok(r.ok && r.doc.rev === 3);
    s.close();
  }));

test("two connections racing on one key: compare-and-set admits exactly one writer, and a quota is not oversold", async () =>
  withDir(async (dir) => {
    const file = join(dir, "s.sqlite");
    const limits = (): StateLimits => ({ maxDocs: 1, maxDocBytes: 64, maxOwnerBytes: 1000, maxTombstones: 10 });
    const a = openStateStore(file, { stateLimits: limits });
    const b = openStateStore(file, { stateLimits: limits });
    const [x, y] = await Promise.all([
      a.state.put({ owner: "o", key: "k", value: "a", expectRev: null, writer: op }, "ka"),
      b.state.put({ owner: "o", key: "k", value: "b", expectRev: null, writer: op }, "kb"),
    ]);
    assert.equal([x, y].filter((r) => r.ok).length, 1);
    const loser = [x, y].find((r) => !r.ok);
    assert.deepEqual(loser, { ok: false, reason: "conflict", currentRev: 1 });
    // Each connection now CASes on rev 1: one wins, the other sees the new rev.
    const [p, q] = await Promise.all([
      a.state.put({ owner: "o", key: "k", value: "a2", expectRev: 1, writer: op }, "ka2"),
      b.state.put({ owner: "o", key: "k", value: "b2", expectRev: 1, writer: op }, "kb2"),
    ]);
    assert.equal([p, q].filter((r) => r.ok).length, 1);
    // maxDocs 1: a second key from either connection is refused, whichever gets there.
    assert.equal(await kindOf(b.state.put({ owner: "o", key: "k2", value: 1, writer: op }, "kq")), "quota-docs");
    assert.deepEqual(await a.state.usage("o"), { docs: 1, bytes: 4 });
    a.close();
    b.close();
  }));

test("limits come from the store option, default to STATE_LIMITS_DEFAULT, and never exceed the configurable document maximum", async () => {
  const s = openStateStore(":memory:");
  const big = (bytes: number) => "x".repeat(bytes - 2);
  assert.ok((await s.state.put({ owner: "o", key: "k", value: big(128 * 1024), writer: op }, "p1")).ok, "default allows 128 KiB");
  assert.equal(await kindOf(s.state.put({ owner: "o", key: "k", value: big(128 * 1024 + 1), writer: op }, "p2")), "too-large");
  s.close();
  const per = openStateStore(":memory:", {
    stateLimits: (owner) =>
      owner === "wide"
        ? { maxDocs: 10, maxDocBytes: 10 * STATE_DOC_BYTES_CEILING, maxOwnerBytes: 100 * STATE_DOC_BYTES_CEILING, maxTombstones: 10 }
        : { maxDocs: 1, maxDocBytes: 8, maxOwnerBytes: 8, maxTombstones: 10 },
  });
  assert.equal(await kindOf(per.state.put({ owner: "tiny", key: "k", value: "123456789", writer: op }, "p3")), "too-large");
  assert.ok((await per.state.put({ owner: "wide", key: "k", value: big(STATE_DOC_BYTES_CONFIG_MAX), writer: op }, "p4")).ok);
  assert.equal(await kindOf(per.state.put({ owner: "wide", key: "k", value: big(STATE_DOC_BYTES_CONFIG_MAX + 1), writer: op }, "p5")), "too-large");
  per.close();
});

test("after idempotency rows are pruned, a replayed write re-executes and only expectRev protects it", async () => {
  const s = openStateStore(":memory:");
  const req = { owner: "o", key: "k", value: 1, expectRev: null, writer: op };
  assert.ok((await s.state.put(req, "same")).ok);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(s.pruneIdempotency(0) > 0);
  assert.deepEqual(await s.state.put(req, "same"), { ok: false, reason: "conflict", currentRev: 1 });
  s.close();
});

test("a put's idempotency row stores result metadata only, never the value, and a replay still returns the first result with it (fixed: the idempotency row once stored the value)", async () =>
  withDir(async (dir) => {
    const file = join(dir, "state.sqlite");
    const s = openStateStore(file);
    const value = { text: "x".repeat(500), n: [1, 2, { deep: true }] };
    const req = { owner: "o", key: "k", value, writer: op };
    const first = await s.state.put(req, "idem-1");
    assert.ok(first.ok);
    const stored = raw(file, (d) => (d.prepare("SELECT result FROM idempotency WHERE key='idem-1'").get() as { result: string }).result);
    assert.equal(stored.includes("xxxx"), false, "the document value is not in the idempotency row");
    assert.ok(stored.length < 400, "the row is bounded by the metadata, not the document");
    // The document moves on; the replay still answers with the first result, value included.
    assert.ok((await s.state.put({ ...req, value: "later" }, "idem-2")).ok);
    assert.deepEqual(await s.state.put(req, "idem-1"), first);
    assert.deepEqual((await s.state.get("o", "k"))?.value, "later", "a replay applies nothing");
    // Negative: the value is rebuilt from the replaying request, which the fingerprint binds to the first, so a different value is refused.
    assert.equal(await kindOf(s.state.put({ ...req, value: { text: "other" } }, "idem-1")), "idempotency-mismatch");
    // A conflict result (no document) round-trips unchanged.
    const conflict = await s.state.put({ ...req, expectRev: 99 }, "idem-3");
    assert.deepEqual(conflict, { ok: false, reason: "conflict", currentRev: 2 });
    assert.deepEqual(await s.state.put({ ...req, expectRev: 99 }, "idem-3"), conflict);
    // A row written before this change carries the value; it is still returned as stored.
    raw(file, (d) =>
      d
        .prepare("UPDATE idempotency SET result=? WHERE key='idem-1'")
        .run(JSON.stringify({ fp: JSON.parse(stored).fp, r: { ok: true, doc: { ...(first.ok ? first.doc : {}) } } })),
    );
    assert.deepEqual(await s.state.put(req, "idem-1"), first);
    s.close();
  }));

test("a stale agent writer leaves no idempotency row, so a retry with a current generation succeeds under the same key", async () => {
  const main = openStore();
  const s = openStateStore(":memory:", { generationOf: main.generationOf });
  const a = await main.registry.create({ parent: null, name: "a", task: "t", host: "h", budgetMicros: 1, spec: CONTRACT_SPAWN_SPEC, idempotencyKey: "c" });
  await main.registry.bumpGeneration(a.id, "h", "bump");
  const stale = { agent: a.id, host: "h", generation: a.generation };
  await assert.rejects(() => s.state.put({ owner: "o", key: "k", value: 1, writer: stale }, "w1"));
  const cur = { ...stale, generation: a.generation + 1 };
  assert.ok((await s.state.put({ owner: "o", key: "k", value: 1, writer: cur }, "w1")).ok);
  s.close();
  main.close();
});

test("an agent writer is refused (fail closed) when the state store was opened without a generation lookup, or the agent is unknown", async () => {
  const s = openStateStore(":memory:");
  const w = { agent: "ghost", host: "h", generation: 1 };
  await assert.rejects(() => s.state.put({ owner: "o", key: "k", value: 1, writer: w }, "w1"), /without generationOf/);
  assert.equal(await kindOf(s.state.put({ owner: "o", key: "k", value: 1, writer: w }, "w1b")), "unknown-writer");
  s.close();
  const t = openStateStore(":memory:", { generationOf: () => undefined });
  await assert.rejects(() => t.state.put({ owner: "o", key: "k", value: 1, writer: w }, "w2"), /unknown agent/);
  assert.equal(await kindOf(t.state.remove({ owner: "o", key: "k", writer: w }, "w3")), "unknown-writer");
  t.close();
});

test("tombstones are purged beyond maxTombstones, the rev floor survives a reopen, and the clamp holds", async () =>
  withDir(async (dir) => {
    const file = join(dir, "s.sqlite");
    const limits = (): StateLimits => ({ maxDocs: 10, maxDocBytes: 64, maxOwnerBytes: 1000, maxTombstones: 2 });
    let s = openStateStore(file, { stateLimits: limits });
    for (let i = 0; i < 5; i++) {
      await s.state.put({ owner: "o", key: `k${i}`, value: 1, writer: op }, `p${i}`);
      await s.state.put({ owner: "o", key: `k${i}`, value: 2, writer: op }, `q${i}`);
      await s.state.remove({ owner: "o", key: `k${i}`, writer: op }, `r${i}`);
    }
    const count = () => raw(file, (d) => (d.prepare("SELECT count(*) AS n FROM state_docs WHERE owner='o'").get() as { n: number }).n);
    assert.equal(count(), 2, "only the newest two tombstones remain");
    assert.equal(
      raw(file, (d) => (d.prepare("SELECT rev_floor FROM state_floor WHERE owner='o'").get() as { rev_floor: number }).rev_floor),
      2,
    );
    s.close();
    s = openStateStore(file, { stateLimits: limits });
    const r = await s.state.put({ owner: "o", key: "k0", value: 3, writer: op }, "again");
    assert.ok(r.ok && r.doc.rev === 3, "a purged key restarts above the floor, not at 1");
    s.close();
    const clamped = openStateStore(":memory:", {
      stateLimits: () => ({ maxDocs: 1, maxDocBytes: 8, maxOwnerBytes: 8, maxTombstones: STATE_TOMBSTONES_CEILING * 2 }),
    });
    clamped.close();
  }));

test("a workflow writer is fingerprinted by workflow + instance, not task: a repaired task replays put and rm; other principals still collide", async () => {
  const s = openStateStore(":memory:", { generationOf: () => 1 });
  try {
    const wf = { workflow: "fin/desk", instance: "daily" };
    const t1 = { agent: "t1", generation: 1 };
    const t2 = { agent: "t2", generation: 1 }; // the repaired task
    const a = await s.state.put({ owner: "fin", key: "ext/s/board", value: 1, writer: wf, fence: t1 }, "k1");
    const b = await s.state.put({ owner: "fin", key: "ext/s/board", value: 1, writer: { ...wf }, fence: t2 }, "k1");
    assert.deepEqual(b, a, "the replay returns the first result");
    assert.deepEqual(a.ok && a.doc.writer, wf, "the doc carries the workflow writer, no task");
    assert.deepEqual((await s.state.get("fin", "ext/s/board"))?.writer, wf);
    const r1 = await s.state.remove({ owner: "fin", key: "ext/s/board", writer: wf, fence: t1 }, "r1");
    assert.deepEqual(await s.state.remove({ owner: "fin", key: "ext/s/board", writer: { ...wf }, fence: t2 }, "r1"), r1);
    assert.ok(r1.ok && r1.removed === 1);
    // Another instance, another workflow, an agent or the operator reusing the key is a different request.
    for (const writer of [{ ...wf, instance: "other" }, { workflow: "fin/scan", instance: "daily" }, { agent: "a1", host: "h", generation: 1 }, op])
      assert.equal(
        await kindOf(s.state.put({ owner: "fin", key: "ext/s/board", value: 1, writer, ...("workflow" in writer && { fence: t1 }) }, "k1")),
        "idempotency-mismatch",
        JSON.stringify(writer),
      );
  } finally {
    s.close();
  }
});

test("a workflow write's fence is checked against the registry inside the write but left out of the fingerprint and the stored writer", async () => {
  const gens = new Map([
    ["t1", 1],
    ["t2", 1],
  ]);
  const s = openStateStore(":memory:", { generationOf: (a) => gens.get(a) });
  try {
    const writer = { workflow: "fin/desk", instance: "" };
    const a = await s.state.put({ owner: "fin", key: "k", value: 1, writer, fence: { agent: "t1", generation: 1 } }, "p1");
    assert.deepEqual(a.ok && a.doc.writer, writer);
    // A repaired task (other agent id) replays the same request.
    assert.deepEqual(await s.state.put({ owner: "fin", key: "k", value: 1, writer, fence: { agent: "t2", generation: 1 } }, "p1"), a);
    // A stale or unknown fence is refused before anything is written.
    gens.set("t1", 2);
    await assert.rejects(s.state.put({ owner: "fin", key: "k2", value: 1, writer, fence: { agent: "t1", generation: 1 } }, "p2"), /generation/i);
    await assert.rejects(s.state.remove({ owner: "fin", key: "k", writer, fence: { agent: "t1", generation: 1 } }, "r1"), /generation/i);
    assert.equal(await kindOf(s.state.put({ owner: "fin", key: "k2", value: 1, writer, fence: { agent: "ghost", generation: 1 } }, "p3")), "unknown-writer");
    for (const fence of [{ agent: "", generation: 1 }, { agent: "t2" }, { agent: "t2", generation: -1 }, { agent: "t2", generation: 1, extra: 1 }])
      assert.equal(
        await kindOf(s.state.put({ owner: "fin", key: "k2", value: 1, writer, fence: fence as never }, "p4")),
        "invalid-value",
        JSON.stringify(fence),
      );
    assert.equal(await s.state.get("fin", "k2"), null);
    assert.equal((await s.state.get("fin", "k"))?.rev, 1);
  } finally {
    s.close();
  }
});
