import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BackupPruneReport } from "./db.ts";
import { openStore, SCHEMA_VERSION } from "./store.ts";
import { openStateStore, STATE_SCHEMA_VERSION } from "./state-store.ts";
import { tmpDir } from "@pomtree/testing";

const withDir = (fn: (dir: string) => void): void => {
  const dir = tmpDir("store-bak-");
  fn(dir);
};
// Test-only synthetic migrations: the built-in chain is empty, so a pending migration is always one of these.
const next = (v: number) => [{ version: v + 1, up: (d: DatabaseSync) => d.exec("CREATE TABLE extra (x INTEGER)") }];
// The v1 baseline migrated once (leaving a pre-v1 backup), then a second synthetic migration pending: its backup is pre-v2.
const chain = (v: number) => [...next(v), { version: v + 2, up: (d: DatabaseSync) => d.exec("CREATE TABLE extra2 (x INTEGER)") }];
const isSqlite = (file: string): boolean => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    return (d.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok";
  } finally {
    d.close();
  }
};

test("a migration keeps only the newest pre-migration backup of that database", () =>
  withDir((dir) => {
    const file = join(dir, "s.db");
    openStore(file).close();
    openStore(file, { migrations: next(SCHEMA_VERSION) }).close(); // leaves a real pre-v1 backup to be pruned by the next migration
    const old = [0, 1].map((v) => `${file}.pre-v${v}.bak`);
    for (const f of old) writeFileSync(f, "old backup", { mode: 0o600 });
    // Not this database's backups, or not older: left alone.
    const others = [join(dir, "other.db.pre-v0.bak"), `${file}.pre-v99.bak`, `${file}.pre-vx.bak`, `${file}.pre-v0.bak.1.ab.tmp`];
    for (const f of others) writeFileSync(f, "keep");
    const reports: BackupPruneReport[] = [];
    openStore(file, { migrations: chain(SCHEMA_VERSION), onBackupPrune: (r) => reports.push(r) }).close();
    const kept = `${file}.pre-v${SCHEMA_VERSION + 1}.bak`;
    assert.ok(isSqlite(kept), "the backup just written survives and is a valid database");
    for (const f of old) assert.equal(existsSync(f), false, `${f} pruned`);
    for (const f of others) assert.ok(existsSync(f), `${f} untouched`);
    assert.deepEqual(reports, [{ kept, removed: old, errors: [] }]);
  }));

test("the state.sqlite chain prunes the same way", () =>
  withDir((dir) => {
    const file = join(dir, "state.sqlite");
    openStateStore(file).close();
    writeFileSync(`${file}.pre-v0.bak`, "old");
    const reports: BackupPruneReport[] = [];
    openStateStore(file, { migrations: next(STATE_SCHEMA_VERSION), onBackupPrune: (r) => reports.push(r) }).close();
    assert.equal(existsSync(`${file}.pre-v0.bak`), false);
    assert.ok(isSqlite(`${file}.pre-v${STATE_SCHEMA_VERSION}.bak`));
    assert.equal(reports.length, 1);
  }));

test("a failing post-migration integrity check fails the open and keeps every backup", () =>
  withDir((dir) => {
    const file = join(dir, "s.db");
    openStore(file).close();
    writeFileSync(`${file}.pre-v0.bak`, "old");
    // A row that violates its CHECK constraint, written with the check off: integrity_check reports it.
    const corrupting = [
      {
        version: SCHEMA_VERSION + 1,
        up: (d: DatabaseSync) =>
          d.exec(
            "CREATE TABLE bad (x INTEGER CHECK (x > 0)); PRAGMA ignore_check_constraints = ON; INSERT INTO bad VALUES (-1); PRAGMA ignore_check_constraints = OFF",
          ),
      },
    ];
    const reports: BackupPruneReport[] = [];
    assert.throws(
      () => openStore(file, { migrations: corrupting, onBackupPrune: (r) => reports.push(r) }),
      /integrity_check failed.*every pre-migration backup is kept/,
    );
    assert.ok(existsSync(`${file}.pre-v0.bak`));
    assert.ok(isSqlite(`${file}.pre-v${SCHEMA_VERSION}.bak`));
    assert.deepEqual(reports, []);
  }));

test("a read-only backup file is pruned; an undeletable one is reported, not fatal", () =>
  withDir((dir) => {
    const file = join(dir, "s.db");
    openStore(file).close();
    openStore(file, { migrations: next(SCHEMA_VERSION) }).close(); // leaves a real pre-v1 backup
    rmSync(`${file}.pre-v1.bak`);
    writeFileSync(`${file}.pre-v0.bak`, "old");
    chmodSync(`${file}.pre-v0.bak`, 0o400); // unlink needs the directory writable, not the file
    mkdirSync(`${file}.pre-v1.bak`); // a directory: unlink fails
    writeFileSync(join(`${file}.pre-v1.bak`, "inside"), "x");
    const reports: BackupPruneReport[] = [];
    openStore(file, { migrations: chain(SCHEMA_VERSION), onBackupPrune: (r) => reports.push(r) }).close();
    assert.equal(existsSync(`${file}.pre-v0.bak`), false);
    assert.ok(statSync(`${file}.pre-v1.bak`).isDirectory());
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]!.removed, [`${file}.pre-v0.bak`]);
    assert.equal(reports[0]!.errors.length, 1);
    assert.equal(reports[0]!.errors[0]!.path, `${file}.pre-v1.bak`);
  }));

test("without a reporter, a failed deletion is a process warning", async () => {
  const dir = tmpDir("store-bak-");
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  process.on("warning", onWarning);
  try {
    const file = join(dir, "s.db");
    openStore(file).close();
    mkdirSync(`${file}.pre-v0.bak`);
    openStore(file, { migrations: next(SCHEMA_VERSION) }).close();
    await new Promise((r) => setImmediate(r)); // warnings are emitted on the next tick
    assert.ok(warnings.some((w) => w.name === "BackupPruneWarning" && w.message.includes(`${file}.pre-v0.bak`)));
  } finally {
    process.off("warning", onWarning);
  }
});

test("reopening without a migration prunes nothing and reports nothing", () =>
  withDir((dir) => {
    const file = join(dir, "s.db");
    const migrations = next(SCHEMA_VERSION);
    openStore(file).close();
    openStore(file, { migrations }).close();
    writeFileSync(`${file}.pre-v0.bak`, "old");
    const before = readdirSync(dir).sort();
    const reports: BackupPruneReport[] = [];
    openStore(file, { migrations, onBackupPrune: (r) => reports.push(r) }).close();
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.deepEqual(reports, []);
  }));
