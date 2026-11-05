import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  checkStateExpectRev,
  checkStateKey,
  checkStateListPrefix,
  checkStateOwner,
  checkStateRemove,
  checkStateFence,
  checkStateWriter,
  clampStateLimits,
  clampStateListLimit,
  encodeStateValue,
  STATE_DOC_BYTES_CEILING,
  STATE_LIMITS_DEFAULT,
  StaleGenerationError,
  StateError,
  stateWriterId,
} from "@pomtree/core";
import type {
  AgentId,
  StateDoc,
  StateFence,
  StateLimits,
  StateListOptions,
  StateMeta,
  StateOwner,
  StatePutRequest,
  StatePutResult,
  StateRemoveRequest,
  StateRemoveResult,
  StateStore,
  StateUsage,
  StateWriter,
} from "@pomtree/core";
import { openVersionedDb } from "./db.ts";
import type { BackupPruneReport, Migration, Row } from "./db.ts";

// SQLite `PRAGMA application_id` of a state database: big-endian ASCII "POMT". Stamped by the baseline; a database without it
// (a pre-release build) or with another id is refused (db.ts).
export const STATE_APPLICATION_ID = 0x504f4d54;

// Workflow state lives in its own SQLite file (<stateDir>/state.sqlite), never in the production audit/registry database: standalone
// tools open it without opening or migrating that one, and it is backed up, erased and migrated on its own schema chain
// (this file's user_version, independent of store.ts). Reopen trigger for per-extension files: extensions out of process or under
// another uid, per-extension erasure/retention/encryption needs, or tenancy.
//
// A removed doc is kept as a tombstone (value NULL, bytes 0) so its rev never restarts; the first CHECK makes "no content on a
// tombstone" a database invariant, the second is the hard per-document ceiling (STATE_DOC_BYTES_CEILING), so both hold even for
// writes that bypass the store API. The partial index serves per-owner usage and listing, which only ever read live docs.
// state_floor is the per-owner rev floor (high-water mark of purged tombstone revs, so a key put after its tombstone was purged
// starts above every rev it ever had); state_docs_dead serves oldest-tombstone purging.
const BASELINE = `
CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, key));
CREATE TABLE IF NOT EXISTS state_docs (
  owner TEXT NOT NULL, key TEXT NOT NULL, rev INTEGER NOT NULL, value TEXT, bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, writer TEXT NOT NULL,
  PRIMARY KEY (owner, key),
  CHECK ((value IS NULL) = (deleted_at IS NOT NULL)),
  CHECK (bytes <= ${STATE_DOC_BYTES_CEILING})
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS state_docs_live ON state_docs(owner) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS state_floor (owner TEXT PRIMARY KEY, rev_floor INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS state_docs_dead ON state_docs(owner, deleted_at, key) WHERE deleted_at IS NOT NULL;
`;

// Ordered forward-only migrations beyond the v1 baseline; none yet.
const STATE_MIGRATIONS: Migration[] = [];

// The version a binary built from this source opens and writes.
export const STATE_SCHEMA_VERSION = 1 + STATE_MIGRATIONS.length;

export interface OpenStateOptions {
  /** Per-owner state quotas, read on every write; defaults to STATE_LIMITS_DEFAULT. maxDocBytes and maxTombstones are further capped (clampStateLimits). */
  stateLimits?: (owner: StateOwner) => StateLimits;
  /** Current generation of an agent (Store.generationOf on the production store); required to accept agent writers, which are fenced by it. */
  generationOf?: (agent: AgentId) => number | undefined;
  /** Extra migrations appended after the built-in ones (tests only). */
  migrations?: Migration[];
  busyTimeoutMs?: number;
  /** Backup-retention outcome after an open that migrated (db.ts BackupPruneReport); absent = errors become a process warning. */
  onBackupPrune?(report: BackupPruneReport): void;
}

export interface StateDb {
  state: StateStore;
  pruneIdempotency(olderThanMs: number): number;
  close(): void;
}

export function openStateStore(path: string, opts: OpenStateOptions = {}): StateDb {
  const { db, once, pruneIdempotency } = openVersionedDb({
    path,
    label: "state store",
    applicationId: STATE_APPLICATION_ID,
    migrations: [...STATE_MIGRATIONS, ...(opts.migrations ?? [])],
    busyTimeoutMs: opts.busyTimeoutMs,
    onBackupPrune: opts.onBackupPrune,
    baseline: (d: DatabaseSync) => d.exec(BASELINE),
  });
  // Semantics shared with FakeStateStore (testing/fakes.ts); the shared contract body keeps them aligned. Idempotency rows are
  // pruned (pruneIdempotency), so a replay after retention re-executes: it is protected only by expectRev, not by the key.
  // A conflict is a stored result like any other: replaying its key returns the conflict, so a retry after a conflict needs a fresh key.
  const stateLimitsFor = (owner: StateOwner): StateLimits => {
    return clampStateLimits(opts.stateLimits?.(owner) ?? STATE_LIMITS_DEFAULT);
  };
  // The registry lives in the production database, not this file, so the generation fence reads it through the injected lookup.
  // Fail closed: without one, an agent writer (or a fence) is refused rather than written unfenced. An agent writer fences itself; a
  // workflow writer carries no task, so it is fenced by the request's `fence` (the task it runs as), which the fingerprint leaves out.
  const fenceAgent = (agent: AgentId, generation: number): void => {
    if (!opts.generationOf) throw new StateError("unknown-writer", `state store opened without generationOf: cannot fence agent writer ${agent}`);
    const gen = opts.generationOf(agent);
    if (gen === undefined) throw new StateError("unknown-writer", `unknown agent ${agent}`);
    if (gen !== generation) throw new StaleGenerationError(agent, generation, gen);
  };
  const stateFence = (w: StateWriter, fence: StateFence | undefined): void => {
    if ("agent" in w) fenceAgent(w.agent, w.generation);
    if (fence !== undefined) fenceAgent(fence.agent, fence.generation);
  };
  const stateMetaOf = (r: Row): StateMeta => ({
    owner: r.owner,
    key: r.key,
    rev: r.rev,
    bytes: r.bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    writer: JSON.parse(r.writer),
  });
  const stateDocOf = (r: Row): StateDoc => ({ ...stateMetaOf(r), value: JSON.parse(r.value) });
  // The idempotency scope includes the owner, and the fingerprint the writer (stateWriterId), so owners and principals never collide on a key.
  const stateFingerprint = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  // Runs an idempotent state mutation; a repeated key with a different request is refused rather than answered with the first result.
  // `pack` shrinks the result before it is stored and `unpack` restores it on a replay (identity by default).
  const stateOnce = <T>(scope: string, key: string, fp: string, fn: () => T, pack: (r: T) => T = (r) => r, unpack: (r: T) => T = (r) => r): T => {
    const out = once(scope, key, () => ({ fp, r: pack(fn()) }));
    if (out.fp !== fp) throw new StateError("idempotency-mismatch", `key ${key} was already used for a different ${scope} request`);
    return unpack(out.r);
  };
  const stateUsage = (owner: StateOwner): StateUsage => {
    const r = db.prepare("SELECT count(*) AS docs, coalesce(sum(bytes),0) AS bytes FROM state_docs WHERE owner=? AND deleted_at IS NULL").get(owner) as Row;
    return { docs: r.docs, bytes: r.bytes };
  };
  const stateFloor = (owner: StateOwner): number =>
    ((db.prepare("SELECT rev_floor FROM state_floor WHERE owner=?").get(owner) as Row | undefined)?.rev_floor as number | undefined) ?? 0;
  // Keeps at most `max` tombstones for the owner: purges the oldest (by removal time, then key) and raises the rev floor to the highest
  // rev purged. Runs inside the removing transaction.
  const purgeTombstones = (owner: StateOwner, max: number): void => {
    const dead = (db.prepare("SELECT count(*) AS n FROM state_docs WHERE owner=? AND deleted_at IS NOT NULL").get(owner) as Row).n as number;
    if (dead <= max) return;
    const victims = db
      .prepare("SELECT key, rev FROM state_docs WHERE owner=? AND deleted_at IS NOT NULL ORDER BY deleted_at, key LIMIT ?")
      .all(owner, dead - max) as Row[];
    const floor = Math.max(stateFloor(owner), ...victims.map((v) => v.rev as number));
    db.prepare("INSERT OR REPLACE INTO state_floor (owner, rev_floor) VALUES (?,?)").run(owner, floor);
    for (const v of victims) db.prepare("DELETE FROM state_docs WHERE owner=? AND key=?").run(owner, v.key);
  };
  const stateRows = (owner: StateOwner, prefix: string | undefined, after: string | undefined, limit: number): Row[] =>
    db
      .prepare(
        "SELECT * FROM state_docs WHERE owner=? AND deleted_at IS NULL AND (? = '' OR substr(key,1,?)=?) AND (? IS NULL OR key > ?) ORDER BY key LIMIT ?",
      )
      .all(owner, prefix ?? "", (prefix ?? "").length, prefix ?? "", after ?? null, after ?? null, limit) as Row[];

  const state: StateStore = {
    async get(owner, key) {
      checkStateOwner(owner);
      checkStateKey(key);
      const r = db.prepare("SELECT * FROM state_docs WHERE owner=? AND key=? AND deleted_at IS NULL").get(owner, key) as Row | undefined;
      return r ? stateDocOf(r) : null;
    },
    async put(req: StatePutRequest, idempotencyKey): Promise<StatePutResult> {
      const { owner, key, writer } = req;
      checkStateOwner(owner);
      checkStateKey(key);
      checkStateWriter(writer);
      checkStateFence(writer, req.fence);
      checkStateExpectRev(req.expectRev);
      const { json, bytes } = encodeStateValue(req.value);
      const limits = stateLimitsFor(owner);
      if (bytes > limits.maxDocBytes) throw new StateError("too-large", `value is ${bytes} bytes, over the ${limits.maxDocBytes} byte document limit`);
      const fp = stateFingerprint(["put", owner, key, json, req.expectRev === undefined ? "omit" : req.expectRev, stateWriterId(writer)]);
      // The stored idempotency row keeps the result metadata only (not counted against maxOwnerBytes, so it must stay small): the
      // request's fingerprint covers `json`, so a replay carries the identical value and the first result is rebuilt from it.
      // Rows written before this carry the value and are returned as stored.
      const packPut = (r: StatePutResult): StatePutResult => {
        if (!r.ok) return r;
        const { value: _v, ...meta } = r.doc;
        return { ok: true, doc: meta as StateDoc };
      };
      const unpackPut = (r: StatePutResult): StatePutResult =>
        r.ok && (r.doc as Partial<StateDoc>).value === undefined ? { ok: true, doc: { ...r.doc, value: JSON.parse(json) } } : r;
      return stateOnce(
        `state.put:${owner}`,
        idempotencyKey,
        fp,
        (): StatePutResult => {
          stateFence(writer, req.fence);
          const cur = db.prepare("SELECT * FROM state_docs WHERE owner=? AND key=?").get(owner, key) as Row | undefined;
          const live = !!cur && cur.deleted_at == null;
          if (req.expectRev !== undefined) {
            const ok = req.expectRev === null || req.expectRev === 0 ? !live : live && cur!.rev === req.expectRev;
            if (!ok) return { ok: false, reason: "conflict", currentRev: live ? cur!.rev : 0 };
          }
          const u = stateUsage(owner);
          if (!live && u.docs + 1 > limits.maxDocs) throw new StateError("quota-docs", `owner ${owner} is at its ${limits.maxDocs} document limit`);
          if (u.bytes - (live ? cur!.bytes : 0) + bytes > limits.maxOwnerBytes) {
            throw new StateError("quota-owner-bytes", `owner ${owner} would exceed its ${limits.maxOwnerBytes} byte limit`);
          }
          const now = Date.now();
          // A key with no row (never written, or its tombstone purged) starts above the owner's rev floor.
          const rev = (cur ? cur.rev : stateFloor(owner)) + 1;
          const createdAt = live ? cur!.created_at : now;
          db.prepare("INSERT OR REPLACE INTO state_docs (owner,key,rev,value,bytes,created_at,updated_at,deleted_at,writer) VALUES (?,?,?,?,?,?,?,NULL,?)").run(
            owner,
            key,
            rev,
            json,
            bytes,
            createdAt,
            now,
            JSON.stringify(writer),
          );
          return { ok: true, doc: { owner, key, rev, value: JSON.parse(json), bytes, createdAt, updatedAt: now, writer: structuredClone(writer) } };
        },
        packPut,
        unpackPut,
      );
    },
    async list(owner, o: StateListOptions = {}) {
      checkStateOwner(owner);
      checkStateListPrefix(o.prefix);
      const limit = clampStateListLimit(o.limit);
      return stateRows(owner, o.prefix, o.after, limit).map(stateMetaOf);
    },
    async remove(req: StateRemoveRequest, idempotencyKey): Promise<StateRemoveResult> {
      const { owner, key, prefix, writer } = req;
      checkStateRemove(req);
      checkStateWriter(writer);
      checkStateFence(writer, req.fence);
      const fp = stateFingerprint([
        "rm",
        owner,
        key ?? null,
        prefix ?? null,
        req.olderThanMs ?? null,
        req.expectRev === undefined ? "omit" : req.expectRev,
        stateWriterId(writer),
      ]);
      return stateOnce(`state.rm:${owner}`, idempotencyKey, fp, (): StateRemoveResult => {
        stateFence(writer, req.fence);
        const now = Date.now();
        let rows: Row[];
        if (key !== undefined) {
          const cur = db.prepare("SELECT * FROM state_docs WHERE owner=? AND key=?").get(owner, key) as Row | undefined;
          const live = !!cur && cur.deleted_at == null;
          if (req.expectRev !== undefined && !(req.expectRev === 0 ? !live : live && cur!.rev === req.expectRev)) {
            return { ok: false, reason: "conflict", currentRev: live ? cur!.rev : 0 };
          }
          rows = live ? [cur!] : [];
        } else {
          rows = stateRows(owner, prefix, undefined, -1).filter((r) => req.olderThanMs === undefined || r.updated_at <= now - req.olderThanMs);
        }
        for (const r of rows) {
          db.prepare("UPDATE state_docs SET value=NULL, bytes=0, deleted_at=?, updated_at=?, writer=? WHERE owner=? AND key=?").run(
            now,
            now,
            JSON.stringify(writer),
            owner,
            r.key,
          );
        }
        if (rows.length > 0) purgeTombstones(owner, stateLimitsFor(owner).maxTombstones);
        return { ok: true, removed: rows.length, keys: rows.map((r) => r.key as string) };
      });
    },
    async usage(owner) {
      checkStateOwner(owner);
      return stateUsage(owner);
    },
    async export(owner, o = {}) {
      checkStateOwner(owner);
      checkStateListPrefix(o.prefix);
      return stateRows(owner, o.prefix, undefined, -1).map(stateDocOf);
    },
  };

  return {
    state,
    pruneIdempotency,
    close: () => db.close(),
  };
}
