import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { IdempotencyConflictError } from "@pomtree/core";

export type Row = Record<string, any>;

export interface Migration {
  /** Target user_version; migrations must be numbered 2, 3, ... with no gaps. */
  version: number;
  up(db: DatabaseSync): void;
}

export interface VersionedDbOptions {
  /** ":memory:" or "" for an in-memory database. */
  path: string;
  /** Names the database in errors ("store", "state store"). */
  label: string;
  /** Ordered forward-only migrations beyond the v1 baseline (already merged with any test-only extras). */
  migrations: Migration[];
  /** SQLite `PRAGMA application_id` that marks this kind of database (a 32-bit signed integer). The baseline of an empty database stamps it. */
  applicationId: number;
  /** Creates the v1 baseline inside the opening write transaction of an empty database; user_version is raised to 1 and applicationId stamped with it. */
  baseline(db: DatabaseSync): void;
  busyTimeoutMs?: number;
  /** Receives the backup-retention outcome after an open that migrated (see BackupPruneReport). Absent: a report with errors
   * is raised as a process warning instead, so a failed deletion is never silent. */
  onBackupPrune?(report: BackupPruneReport): void;
}

// Backup retention: only the newest pre-migration backup of a database is kept. After an open that applied a migration and
// whose post-migration integrity_check passed, every `<db>.pre-v<N>.bak` with N below the version just backed up is deleted.
// The backup for the version just migrated from (`kept`) is never deleted, nor is one for a higher version (a backup taken
// before an operator restored an older copy). A failed deletion is listed in `errors`; it never fails the open.
export interface BackupPruneReport {
  kept: string;
  removed: string[];
  errors: { path: string; message: string }[];
}

export interface VersionedDb {
  db: DatabaseSync;
  onDisk: boolean;
  /** The retention outcome of this open, or null when it applied no migration (nothing is pruned then). */
  backupPrune: BackupPruneReport | null;
  tx<T>(fn: () => T): T;
  /** Runs fn once per (scope,key); repeats return the stored result. Rolls back with fn on throw. Needs an `idempotency` table.
   * `fingerprint` (a hash of the canonical request; needs a `fingerprint` column) is stored with the key; a repeat with a
   * different fingerprint throws IdempotencyConflictError and runs nothing. A row stored without one (older rows) matches any. */
  once<T>(scope: string, key: string, fn: () => T, fingerprint?: string): T;
  /** Deletes rows older than `olderThanMs`, except those in `keepScopes` (scopes whose replay must never re-execute). */
  pruneIdempotency(olderThanMs: number, keepScopes?: readonly string[]): number;
}

// Opens a SQLite file the way every pomtree database is opened: created 0600 (with its -wal/-shm), WAL, busy_timeout, a newer
// schema, a foreign or pre-release (unstamped) database refused before anything mutates it, a full integrity_check and a pre-migration backup before a real migration, then the
// baseline and the forward-only migrations, each in its own transaction that bumps user_version atomically. After a migration,
// a second full integrity_check of the migrated database, and only when it passes are older backups pruned (BackupPruneReport);
// when it fails the open fails and every backup is kept.
export function openVersionedDb(o: VersionedDbOptions): VersionedDb {
  const { path, label, migrations, baseline, applicationId } = o;
  const onDisk = path !== ":memory:" && path !== "";
  migrations.forEach((m, i) => {
    if (m.version !== i + 2) throw new Error(`${label} migrations must be numbered consecutively from 2: got ${m.version} at index ${i}`);
  });
  // Create the file 0600 up front (an empty file is a valid new SQLite DB); SQLite gives -wal/-shm the main file's mode.
  if (onDisk) {
    if (!existsSync(path)) {
      // Concurrent first opens can both pass existsSync(); the loser's exclusive create then fails with EEXIST. That is benign
      // only when the winner left a regular file (lstat: a symlink or directory there is still refused). Any other error propagates.
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (e) {
        const regularFile = (() => {
          try {
            return lstatSync(path).isFile();
          } catch {
            return false;
          }
        })();
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !regularFile) throw e;
      }
    }
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path);
  const supportedVersion = 1 + migrations.length;
  // busy_timeout first: switching to WAL itself needs a lock another process may hold. SQLite does not
  // always call the busy handler for that switch (or for the first lock upgrade when two fresh opens race:
  // it returns SQLITE_BUSY immediately to break a deadlock), so retry the init on "locked/busy" with a small
  // jittered backoff within the busy budget instead of failing the open.
  const busyMs = Math.max(0, Math.trunc(o.busyTimeoutMs ?? 5000));
  const isBusy = (e: unknown): boolean => /database is locked|SQLITE_BUSY|database table is locked/i.test(e instanceof Error ? e.message : String(e));
  const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  const deadline = Date.now() + Math.max(busyMs, 1000) * 2;
  const retryBusy = <T>(fn: () => T): T => {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (e) {
        if (!isBusy(e) || Date.now() > deadline) throw e;
        sleepSync(5 + Math.floor(Math.random() * 20) * Math.min(attempt + 1, 10));
      }
    }
  };
  db.exec(`PRAGMA busy_timeout = ${busyMs}`);
  const refuseNewer = (current: number): void => {
    if (current > supportedVersion) {
      throw new Error(
        `${label} ${path} has schema version ${current}, newer than this binary supports (${supportedVersion}); refusing to open (upgrade pomtreed or restore a backup)`,
      );
    }
  };

  const userVersion = (): number => (db.prepare("PRAGMA user_version").get() as Row).user_version as number;
  const appId = (): number => (db.prepare("PRAGMA application_id").get() as Row).application_id as number;
  const hasTables = (): boolean => (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as Row).n > 0;
  // A nonzero id must be this kind's, even on an empty file (the baseline would write our schema into another application's
  // database without stamping it). A database with tables and no id is a pre-release build's; an empty one is initialized by the baseline.
  // The id and the table count are read in ONE statement, so one snapshot: read separately (outside a transaction), a rival's
  // first open could commit its baseline between them, and the id read before it (0) paired with the tables read after it
  // looked like a pre-release database (fixed: concurrent first opens were refused that way).
  const refuseForeign = (): void => {
    const stamp = db
      .prepare(
        "SELECT (SELECT application_id FROM pragma_application_id) AS id, (SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%') AS n",
      )
      .get() as Row;
    const id = stamp.id as number;
    if (id === applicationId) return;
    if (id === 0) {
      if (stamp.n === 0) return;
      throw new Error(
        `${label} ${path} was created by a pre-release build (no pomtree schema id); refusing to open: move it aside and restart to re-initialize (development databases do not carry over)`,
      );
    }
    throw new Error(
      `${label} ${path} is not a pomtree ${label} database (application_id ${id}, expected ${applicationId}); refusing to open: check the path, or move it aside and restart to re-initialize`,
    );
  };
  try {
    // Refuse a foreign or newer DB before the WAL switch mutates its header (re-checked under the write lock in initSchema).
    retryBusy(refuseForeign);
    refuseNewer(retryBusy(userVersion));
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    // Pinned, not left to the build default: under WAL, NORMAL can lose the last committed transactions on a power loss, and
    // the debit ledger and journal must not. Per-connection, so every open sets it.
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (e) {
    db.close();
    throw e;
  }

  // Full integrity_check (not quick_check): opened once per process and the DB is small; a corrupt file must fail loudly.
  const integrityCheck = (): void => {
    const rows = db.prepare("PRAGMA integrity_check").all() as Row[];
    const bad = rows.map((r) => String(r.integrity_check)).filter((m) => m !== "ok");
    if (bad.length > 0) throw new Error(`${label} integrity_check failed for ${path}: ${bad.slice(0, 5).join("; ")}`);
  };

  // Pre-migration backup: checkpoint the WAL, then VACUUM INTO a 0600 file (a consistent single-file copy that needs no WAL sidecars).
  // Only the newest backup survives a successful migration (pruneBackups below); older ones are deleted then.
  let backedUp: number | null = null; // the version of the last backup this open took
  const backupBefore = (version: number): void => {
    if (!onDisk) return;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bak = `${path}.pre-v${version}.bak`;
    // Always take a fresh copy: a `.bak` left by an earlier attempt can predate data written since, and pruneBackups then
    // deletes every older backup, so a reused one could be the only copy and stale (fixed: a stale .bak was once reused). The copy goes
    // to a private temp file and is installed with rename(), atomic over any existing `.bak` (so a .bak is never partial).
    // A copy whose user_version is no longer `version` was taken after another process migrated; installing it would mislabel
    // post-migration data as the pre-migration backup, so it is discarded and the existing `.bak` (if any) stays.
    const tmp = `${bak}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    closeSync(openSync(tmp, "wx", 0o600));
    try {
      db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
      chmodSync(tmp, 0o600);
      const copy = new DatabaseSync(tmp, { readOnly: true });
      let copyVersion: number;
      try {
        copyVersion = (copy.prepare("PRAGMA user_version").get() as Row).user_version as number;
      } finally {
        copy.close();
      }
      if (copyVersion === version) renameSync(tmp, bak);
    } finally {
      rmSync(tmp, { force: true });
    }
    // Older backups are pruned only against a backup of this version that exists (an installed one, or the one kept above).
    if (existsSync(bak)) backedUp = version;
  };

  let migrated = false; // this open applied at least one migration (not merely saw another process apply it)
  const initSchema = (): void => {
    // Unlocked pre-read, used only to decide on the integrity check and backup (VACUUM cannot run inside a transaction).
    // The authoritative version is re-read under the write lock below, so a racing process that migrates first is seen.
    refuseForeign();
    const pre = userVersion();
    refuseNewer(pre);
    if (hasTables()) {
      integrityCheck();
      // Back up only when a real migration will run.
      if (pre < supportedVersion) backupBefore(pre);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = userVersion();
      refuseForeign();
      refuseNewer(current);
      baseline(db);
      if (current < 1) db.exec("PRAGMA user_version = 1");
      if (appId() === 0) db.exec(`PRAGMA application_id = ${applicationId}`);
      db.exec("COMMIT");
      for (const m of migrations) {
        db.exec("BEGIN IMMEDIATE");
        try {
          // Re-read under this transaction's lock: another process may have applied it since we last looked.
          const v = userVersion();
          refuseNewer(v);
          if (m.version > v) {
            migrated = true;
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`);
          }
          db.exec("COMMIT");
        } catch (e) {
          try {
            db.exec("ROLLBACK");
          } catch {
            /* nothing to roll back */
          }
          throw new Error(`${label} migration to v${m.version} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
  };
  // Deletes this database's `.pre-v<N>.bak` files with N below `keep`. Never throws: each failure is an entry in `errors`.
  const pruneBackups = (keep: number): BackupPruneReport => {
    const kept = `${path}.pre-v${keep}.bak`;
    const report: BackupPruneReport = { kept, removed: [], errors: [] };
    const dir = dirname(path);
    const prefix = `${basename(path)}.pre-v`;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      report.errors.push({ path: dir, message: e instanceof Error ? e.message : String(e) });
      return report;
    }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".bak")) continue;
      const v = name.slice(prefix.length, -".bak".length);
      if (!/^\d+$/.test(v) || Number(v) >= keep) continue;
      const file = join(dir, name);
      try {
        unlinkSync(file);
        report.removed.push(file);
      } catch (e) {
        report.errors.push({ path: file, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return report;
  };

  let backupPrune: BackupPruneReport | null = null;
  try {
    retryBusy(initSchema);
    if (onDisk) for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f) && (statSync(f).mode & 0o077) !== 0) chmodSync(f, 0o600);
    if (migrated && backedUp !== null) {
      // The migrated database must pass a full check before any older backup goes; on failure the open fails, all are kept.
      try {
        integrityCheck();
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)} after migrating; every pre-migration backup is kept`);
      }
      backupPrune = pruneBackups(backedUp);
    }
  } catch (e) {
    db.close();
    throw e;
  }
  if (backupPrune) {
    const warn = (m: string): void => process.emitWarning(`${label} ${m}`, "BackupPruneWarning");
    if (o.onBackupPrune) {
      try {
        o.onBackupPrune(backupPrune);
      } catch (e) {
        warn(`backup-retention reporter threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (backupPrune.errors.length > 0)
      warn(`could not delete old pre-migration backups: ${backupPrune.errors.map((x) => `${x.path}: ${x.message}`).join("; ")}`);
  }

  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  const once = <T>(scope: string, key: string, fn: () => T, fingerprint?: string): T =>
    tx(() => {
      if (fingerprint === undefined) {
        const hit = db.prepare("SELECT result FROM idempotency WHERE scope=? AND key=?").get(scope, key) as Row | undefined;
        if (hit) return JSON.parse(hit.result) as T;
        const r = fn();
        db.prepare("INSERT INTO idempotency (scope,key,result,created_at) VALUES (?,?,?,?)").run(scope, key, JSON.stringify(r ?? null), Date.now());
        return r;
      }
      const hit = db.prepare("SELECT result, fingerprint FROM idempotency WHERE scope=? AND key=?").get(scope, key) as Row | undefined;
      if (hit) {
        if (hit.fingerprint != null && hit.fingerprint !== fingerprint) throw new IdempotencyConflictError(scope, key);
        return JSON.parse(hit.result) as T;
      }
      const r = fn();
      db.prepare("INSERT INTO idempotency (scope,key,result,created_at,fingerprint) VALUES (?,?,?,?,?)").run(
        scope,
        key,
        JSON.stringify(r ?? null),
        Date.now(),
        fingerprint,
      );
      return r;
    });

  const pruneIdempotency = (olderThanMs: number, keepScopes: readonly string[] = []): number => {
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    const keep = keepScopes.length > 0 ? ` AND scope NOT IN (${keepScopes.map(() => "?").join(",")})` : "";
    return Number(db.prepare(`DELETE FROM idempotency WHERE created_at < ?${keep}`).run(cutoff, ...keepScopes).changes);
  };

  return { db, onDisk, backupPrune, tx, once, pruneIdempotency };
}
