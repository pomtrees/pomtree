import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeGatewayCredential } from "@pomtree/core";
import { openVersionedDb } from "./db.ts";
import { openStore, SCHEMA_VERSION, STORE_APPLICATION_ID } from "./store.ts";
import { openStateStore, STATE_APPLICATION_ID } from "./state-store.ts";
import { tmpDir } from "@pomtree/testing";

const withDir = (fn: (dir: string) => void): void => {
  const dir = tmpDir("store-schema-");
  fn(dir);
};
const version = (file: string): number => {
  const d = new DatabaseSync(file);
  try {
    return (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    d.close();
  }
};
const tableNames = (file: string): string[] => {
  const d = new DatabaseSync(file);
  try {
    return (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  } finally {
    d.close();
  }
};

test("a pending migration runs once in a transaction after a 0600 backup", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStore(file).close();
    const seed = new DatabaseSync(file);
    seed.exec(`INSERT INTO mailbox (agent, signal) VALUES ('a', '{"kind":"message"}')`);
    seed.close();
    const next = SCHEMA_VERSION + 1;
    const migrations = [{ version: next, up: (d: DatabaseSync) => d.exec("CREATE TABLE extra (x INTEGER); INSERT INTO extra VALUES (7)") }];
    openStore(file, { migrations }).close();
    assert.equal(version(file), next);
    const bak = `${file}.pre-v${SCHEMA_VERSION}.bak`;
    assert.equal(statSync(bak).mode & 0o777, 0o600);
    const b = new DatabaseSync(bak);
    assert.equal((b.prepare("SELECT count(*) AS n FROM mailbox").get() as { n: number }).n, 1);
    assert.equal(b.prepare("SELECT name FROM sqlite_master WHERE name='extra'").get(), undefined);
    b.close();
    openStore(file, { migrations }).close(); // already at the newest version: no re-run, no second backup
    assert.equal(existsSync(`${file}.pre-v${next}.bak`), false);

    const after = [...migrations, { version: next + 1, up: (d: DatabaseSync) => d.exec("INSERT INTO extra VALUES (8)") }];
    openStore(file, { migrations: after }).close();
    assert.equal(version(file), next + 1);
    assert.equal(statSync(`${file}.pre-v${next}.bak`).mode & 0o777, 0o600);
  }));

test("a failing migration rolls back, keeps the old version and reports it", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStore(file).close();
    const bad = [{ version: SCHEMA_VERSION + 1, up: (d: DatabaseSync) => d.exec("CREATE TABLE half (x); NOT SQL") }];
    assert.throws(() => openStore(file, { migrations: bad }), new RegExp(`migration to v${SCHEMA_VERSION + 1} failed`));
    assert.equal(version(file), SCHEMA_VERSION);
    const d = new DatabaseSync(file);
    assert.equal(d.prepare("SELECT name FROM sqlite_master WHERE name='half'").get(), undefined);
    d.close();
  }));

test("a DB newer than the binary supports is refused", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStore(file).close();
    const d = new DatabaseSync(file);
    d.exec("PRAGMA user_version = 99");
    d.close();
    assert.throws(() => openStore(file), /newer than this binary supports/);
    assert.equal(version(file), 99);
  }));

test("a corrupt file fails loudly at open", () =>
  withDir((dir) => {
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, "this is not a database".repeat(200));
    assert.throws(() => openStore(junk));

    const file = join(dir, "s.sqlite");
    const s = openStore(file);
    for (let i = 0; i < 200; i++) s.pruneIdempotency(0);
    s.close();
    const d = new DatabaseSync(file);
    d.exec("CREATE TABLE big (v TEXT); CREATE INDEX big_v ON big(v)");
    for (let i = 0; i < 300; i++) d.prepare("INSERT INTO big VALUES (?)").run(`row-${i}`.repeat(20));
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    d.close();
    // Zero a middle page of the index so the file opens but fails integrity_check.
    const buf = readFileSync(file);
    const pages = buf.length / 4096;
    assert.ok(pages > 4);
    buf.fill(0xff, 4096 * (pages - 2), 4096 * (pages - 1));
    writeFileSync(file, buf);
    assert.throws(() => openStore(file), /integrity_check|malformed|corrupt/i);
  }));

test("database, WAL and SHM files are 0600 even under a permissive umask", () =>
  withDir((dir) => {
    const old = process.umask(0o000);
    try {
      const file = join(dir, "s.sqlite");
      const s = openStore(file);
      s.pruneIdempotency(0);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) assert.equal(statSync(f).mode & 0o777, 0o600, f);
      s.close();
      // A pre-existing loose DB is tightened.
      writeFileSync(join(dir, "loose.sqlite"), "", { mode: 0o644 });
      openStore(join(dir, "loose.sqlite")).close();
      assert.equal(statSync(join(dir, "loose.sqlite")).mode & 0o777, 0o600);
    } finally {
      process.umask(old);
    }
  }));

test("an expired reservation is charged; a late settle never double charges", () =>
  withDir((dir) => {
    const secret = "controller-secret";
    let t = 1_000;
    const s = openStore(join(dir, "s.sqlite"));
    const d = s.modelDebit({ secret, now: () => t });
    const key = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 100_000, issuedAt: 500, models: [] });
    const r = d.reserve(key, "req", 40);
    assert.ok(r.ok);
    if (!r.ok) return;
    t += 500;
    assert.equal(d.expireReservations(400), 1);
    assert.equal(d.spentFor("a"), 40); // fail-closed charge
    assert.equal(d.cancel(r.reservation), false);
    assert.deepEqual(d.reserve(key, "req", 1), { ok: false, reason: "idempotency-conflict" });
    assert.deepEqual(d.settle(r.reservation, 25), { ok: true, chargedMicros: 40, remainingMicros: 60, expiredCharged: true }); // no second charge
    assert.equal(d.spentFor("a"), 40);
    assert.deepEqual(d.settle(r.reservation, 55), { ok: true, chargedMicros: 55, remainingMicros: 45, expiredCharged: true }); // only the overage is topped up
    assert.equal(d.spentFor("a"), 55);
    assert.equal(d.expireReservations(400), 0);
    s.close();
  }));

test("two handles, one pending non-idempotent migration: applied exactly once, second opener is a no-op", () => {
  withDir((dir) => {
    const file = join(dir, "s.db");
    openStore(file).close(); // v1
    let runs = 0;
    const migrations = [
      {
        version: SCHEMA_VERSION + 1,
        up: (d: DatabaseSync) => {
          runs++;
          d.exec("ALTER TABLE mailbox ADD COLUMN extra TEXT"); // throws if applied twice
        },
      },
    ];
    const a = openStore(file, { migrations });
    const b = openStore(file, { migrations }); // opens while a is still live
    assert.equal(runs, 1);
    assert.equal(version(file), SCHEMA_VERSION + 1);
    a.close();
    b.close();
  });
});

test("an existing .bak for the version is replaced by a fresh copy, so pruning never leaves only a stale one (fixed: a stale .bak was once reused)", () => {
  withDir((dir) => {
    const file = join(dir, "s.db");
    openStore(file).close();
    const bak = `${file}.pre-v${SCHEMA_VERSION}.bak`;
    // A leftover from an earlier attempt, taken before later writes; plus an older backup that pruning will delete.
    copyFileSync(file, bak);
    writeFileSync(`${file}.pre-v0.bak`, "older");
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE written_since (x)");
    raw.close();
    openStore(file, { migrations: [{ version: SCHEMA_VERSION + 1, up: (d: DatabaseSync) => d.exec("CREATE TABLE t2 (x)") }] }).close();
    assert.ok(tableNames(bak).includes("written_since"), "the backup holds the data as of this migration, not the stale copy");
    assert.equal(tableNames(bak).includes("t2"), false, "and predates the migration");
    assert.equal(existsSync(`${file}.pre-v0.bak`), false, "older backups are pruned against the fresh one");
    assert.equal(statSync(bak).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith(".tmp")),
      [],
      "no temp copy is left behind",
    );
    assert.equal(version(file), SCHEMA_VERSION + 1);
  });
});

test("a newer DB is refused before the journal mode is touched", () => {
  withDir((dir) => {
    const file = join(dir, "s.db");
    const d = new DatabaseSync(file);
    d.exec("PRAGMA user_version = 9");
    d.close();
    assert.throws(() => openStore(file), /newer than this binary supports/);
    const r = new DatabaseSync(file);
    assert.notEqual((r.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    r.close();
  });
});

test("the current binary refuses a newer schema version rather than opening it at the same version", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStore(file).close();
    const d = new DatabaseSync(file);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    d.close();
    assert.throws(() => openStore(file), /newer than this binary supports/);
    assert.equal(version(file), SCHEMA_VERSION + 1, "the refused file keeps its version");
  }));

// TODO(host-misc) synchronous: every open pins synchronous=FULL (2) on its own connection, not the build default, on a fresh
// file and on a reopen of an existing one.
test("openVersionedDb pins PRAGMA synchronous = FULL on a fresh and on a reopened database", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    const open = () =>
      openVersionedDb({ path: file, label: "test", migrations: [], applicationId: 1, baseline: (d) => d.exec("CREATE TABLE IF NOT EXISTS t (x)") });
    const sync = (d: DatabaseSync): unknown => (d.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    const fresh = open();
    assert.equal(sync(fresh.db), 2, "fresh database");
    assert.equal((fresh.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    fresh.db.close();
    const reopened = open();
    assert.equal(sync(reopened.db), 2, "reopened database");
    reopened.db.close();
  }));

const pragma = (file: string, name: "user_version" | "application_id"): number => {
  const d = new DatabaseSync(file);
  try {
    return (d.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]!;
  } finally {
    d.close();
  }
};
// A database as a pre-release build left it: tables, a user_version, and no application_id.
const preRelease = (file: string, userVersion: number): void => {
  const d = new DatabaseSync(file);
  d.exec(
    `CREATE TABLE idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (scope, key)); PRAGMA user_version = ${userVersion}`,
  );
  d.close();
};

test("the application ids are the big-endian ASCII of their four-character tags", () => {
  const be = (tag: string): number => Buffer.from(tag, "ascii").readInt32BE(0);
  assert.equal(STORE_APPLICATION_ID, be("POMS"));
  assert.equal(STATE_APPLICATION_ID, be("POMT"));
  assert.equal(STORE_APPLICATION_ID, 1347374419);
  assert.equal(STATE_APPLICATION_ID, 1347374420);
});

test("a fresh path and an empty database initialize at v1 stamped with the store id", () =>
  withDir((dir) => {
    const fresh = join(dir, "fresh.sqlite");
    openStore(fresh).close();
    assert.equal(pragma(fresh, "user_version"), 1);
    assert.equal(pragma(fresh, "application_id"), STORE_APPLICATION_ID);
    const empty = join(dir, "empty.sqlite");
    new DatabaseSync(empty).close();
    openStore(empty).close();
    assert.equal(pragma(empty, "user_version"), 1);
    assert.equal(pragma(empty, "application_id"), STORE_APPLICATION_ID);
    const state = join(dir, "state.sqlite");
    openStateStore(state).close();
    assert.equal(pragma(state, "user_version"), 1);
    assert.equal(pragma(state, "application_id"), STATE_APPLICATION_ID);
  }));

test("a pre-release store (tables, no application id) is refused untouched, naming cause and action", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    preRelease(file, 3);
    const before = readFileSync(file);
    assert.throws(
      () => openStore(file),
      (e: Error) =>
        e.message ===
        `store ${file} was created by a pre-release build (no pomtree schema id); refusing to open: move it aside and restart to re-initialize (development databases do not carry over)`,
    );
    assert.equal(pragma(file, "user_version"), 3);
    assert.equal(pragma(file, "application_id"), 0);
    assert.deepEqual(readFileSync(file), before, "the refused file is byte-identical");
    assert.equal(existsSync(`${file}-wal`), false);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith(".bak")),
      [],
    );
  }));

test("a pre-release state store (tables, no application id) is refused untouched", () =>
  withDir((dir) => {
    const file = join(dir, "state.sqlite");
    preRelease(file, 2);
    const before = readFileSync(file);
    assert.throws(
      () => openStateStore(file),
      (e: Error) =>
        e.message ===
        `state store ${file} was created by a pre-release build (no pomtree schema id); refusing to open: move it aside and restart to re-initialize (development databases do not carry over)`,
    );
    assert.equal(pragma(file, "user_version"), 2);
    assert.equal(pragma(file, "application_id"), 0);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(existsSync(`${file}-wal`), false);
  }));

// Forces the first-open race deterministically: right after the opener's first application_id read returns (an empty, unstamped
// file), `rival` writes the same file from another connection, before the opener reads anything else. The hook wraps
// DatabaseSync.prototype.prepare for the duration of one synchronous open, so nothing else can interleave.
const withRivalAfterStampRead = <T>(rival: () => void, fn: () => T): T => {
  const realPrepare = DatabaseSync.prototype.prepare;
  let armed = true;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]) {
    const stmt = (realPrepare as (...a: unknown[]) => ReturnType<DatabaseSync["prepare"]>).call(this, sql, ...rest);
    if (armed && sql.includes("application_id")) {
      const realGet = stmt.get as (...a: unknown[]) => unknown;
      stmt.get = ((...args: unknown[]) => {
        const row = realGet.apply(stmt, args);
        if (armed) {
          armed = false;
          rival();
        }
        return row;
      }) as typeof stmt.get;
    }
    return stmt;
  } as DatabaseSync["prepare"];
  try {
    return fn();
  } finally {
    DatabaseSync.prototype.prepare = realPrepare;
  }
};

test("a first open racing another first open is not mistaken for a pre-release database", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    // The rival is a complete concurrent first open: it commits the baseline tables and the id in one transaction.
    withRivalAfterStampRead(
      () => openStore(file).close(),
      () => openStore(file).close(),
    );
    assert.equal(pragma(file, "user_version"), 1);
    assert.equal(pragma(file, "application_id"), STORE_APPLICATION_ID);
  }));

test("negative control: a pre-release build populating the file in the same window is still refused with the pre-release message", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    assert.throws(
      () =>
        withRivalAfterStampRead(
          () => preRelease(file, 1),
          () => openStore(file),
        ),
      (e: Error) =>
        e.message ===
        `store ${file} was created by a pre-release build (no pomtree schema id); refusing to open: move it aside and restart to re-initialize (development databases do not carry over)`,
    );
    assert.equal(pragma(file, "application_id"), 0);
    assert.deepEqual(tableNames(file), ["idempotency"]);
  }));

test("a database stamped with the other kind's id is refused, in both directions, untouched", () =>
  withDir((dir) => {
    const store = join(dir, "s.sqlite");
    const state = join(dir, "state.sqlite");
    openStore(store).close();
    openStateStore(state).close();
    const storeBytes = readFileSync(store);
    const stateBytes = readFileSync(state);
    assert.throws(
      () => openStateStore(store),
      new RegExp(
        `state store .* is not a pomtree state store database \\(application_id ${STORE_APPLICATION_ID}, expected ${STATE_APPLICATION_ID}\\); refusing to open: check the path`,
      ),
    );
    assert.throws(
      () => openStore(state),
      new RegExp(
        `store .* is not a pomtree store database \\(application_id ${STATE_APPLICATION_ID}, expected ${STORE_APPLICATION_ID}\\); refusing to open: check the path`,
      ),
    );
    assert.deepEqual(readFileSync(store), storeBytes);
    assert.deepEqual(readFileSync(state), stateBytes);
  }));

test("a foreign SQLite file with tables is refused", () =>
  withDir((dir) => {
    const file = join(dir, "other.sqlite");
    const d = new DatabaseSync(file);
    d.exec("CREATE TABLE t (x); PRAGMA application_id = 12345");
    d.close();
    assert.throws(() => openStore(file), /application_id 12345, expected 1347374419\); refusing to open/);
    assert.equal(pragma(file, "application_id"), 12345);
  }));

test("an empty SQLite file stamped with a foreign application_id is refused and left unmodified", () =>
  withDir((dir) => {
    const file = join(dir, "other.sqlite");
    const d = new DatabaseSync(file);
    d.exec("PRAGMA application_id = 12345");
    d.close();
    const bytes = readFileSync(file);
    assert.throws(() => openStore(file), /application_id 12345, expected 1347374419\); refusing to open/);
    assert.throws(() => openStateStore(file), /application_id 12345, expected 1347374420\); refusing to open/);
    assert.equal(pragma(file, "application_id"), 12345);
    assert.deepEqual(readFileSync(file), bytes);
  }));

test("a matching-id store with a newer user_version gets the newer refusal, not the id refusal", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStore(file).close();
    const d = new DatabaseSync(file);
    d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 4}`);
    d.close();
    assert.throws(() => openStore(file), /newer than this binary supports \(1\); refusing to open \(upgrade pomtreed or restore a backup\)/);
    assert.equal(pragma(file, "application_id"), STORE_APPLICATION_ID);
  }));

test("a synthetic v2 migration applies forward on a v1 baseline: data intact, id kept, 0600 pre-v1 backup at user_version 1", () =>
  withDir((dir) => {
    const file = join(dir, "s.sqlite");
    openStore(file).close();
    const seed = new DatabaseSync(file);
    seed.exec(`INSERT INTO idempotency (scope, key, result) VALUES ('s', 'k', '"kept"')`);
    seed.close();
    openStore(file, { migrations: [{ version: 2, up: (d: DatabaseSync) => d.exec("CREATE TABLE synthetic (x INTEGER)") }] }).close();
    assert.equal(pragma(file, "user_version"), 2);
    assert.equal(pragma(file, "application_id"), STORE_APPLICATION_ID);
    const d = new DatabaseSync(file);
    assert.equal((d.prepare("SELECT result FROM idempotency").get() as { result: string }).result, '"kept"');
    d.close();
    const bak = `${file}.pre-v1.bak`;
    assert.equal(statSync(bak).mode & 0o777, 0o600);
    assert.equal(pragma(bak, "user_version"), 1);
    assert.equal(tableNames(bak).includes("synthetic"), false);
  }));
