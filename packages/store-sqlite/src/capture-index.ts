import type { DatabaseSync } from "node:sqlite";
import { CAPTURE_LIST_LIMIT_DEFAULT, CAPTURE_LIST_LIMIT_MAX, captureJobIdOf, negativeTtlMs, ROBOTS_CACHE_MAX_MS } from "@pomtree/core";
import type { CaptureArtifact, CaptureFailure, CaptureIndex, CaptureJob, CaptureJobId, CaptureOutcome, CaptureRecord, NewCaptureJob } from "@pomtree/core";
import type { Row } from "./db.ts";

// Additive and idempotent like workspace_cleanup (CREATE IF NOT EXISTS on every open), deliberately not a versioned migration: a DB
// without these tables simply gains them. A job is one JSON document beside the columns its lookups need; records, artifacts, the
// negative cache and the domain pauses are keyed tables.
export const CAPTURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS capture_jobs (id TEXT PRIMARY KEY, key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','settled')), doc TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS capture_jobs_key_state ON capture_jobs(key, state);
CREATE TABLE IF NOT EXISTS capture_records (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, key TEXT NOT NULL, created_at INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS capture_records_key ON capture_records(key, created_at);
CREATE TABLE IF NOT EXISTS capture_artifacts (sha256 TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capture_negative (key TEXT PRIMARY KEY, failure TEXT NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capture_pauses (domain TEXT PRIMARY KEY, until INTEGER NOT NULL);
`;

export interface CaptureIndexDeps {
  db: DatabaseSync;
  once<T>(scope: string, key: string, fn: () => T, fingerprint?: string): T;
  fingerprintOf(...parts: unknown[]): string;
  now(): number;
}

// The durable CaptureIndex (core ports.ts) over the store's database. Every mutation runs in one transaction under its idempotency
// key; reads return copies (parsed JSON), so a caller cannot mutate stored state.
export function sqliteCaptureIndex(d: CaptureIndexDeps): CaptureIndex {
  const { db, once, fingerprintOf, now } = d;
  const jobRow = (id: CaptureJobId): CaptureJob | null => {
    const r = db.prepare("SELECT doc FROM capture_jobs WHERE id=?").get(id) as Row | undefined;
    return r ? (JSON.parse(r.doc) as CaptureJob) : null;
  };
  const mustJob = (id: CaptureJobId): CaptureJob => {
    const j = jobRow(id);
    if (j === null) throw new Error(`unknown capture job ${id}`);
    return j;
  };
  const putJob = (j: CaptureJob): void => {
    db.prepare(
      "INSERT INTO capture_jobs (id,key,state,doc,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, doc=excluded.doc",
    ).run(j.id, j.key, j.state, JSON.stringify(j), j.createdAt);
  };
  const recordOf = (r: Row | undefined): CaptureRecord | null => (r ? (JSON.parse(r.doc) as CaptureRecord) : null);

  return {
    async begin(n: NewCaptureJob, key: string): Promise<CaptureJob> {
      const id = once<CaptureJobId>(
        "capture.begin",
        key,
        () => {
          const open = db.prepare("SELECT doc FROM capture_jobs WHERE key=? AND state='open' ORDER BY created_at LIMIT 1").get(n.key) as Row | undefined;
          if (open) {
            const j = JSON.parse(open.doc) as CaptureJob;
            if (!j.requesters.some((x) => x.agent === n.requester)) {
              j.requesters.push({ agent: n.requester, generation: n.generation });
              j.updatedAt = now();
              putJob(j);
            }
            return j.id;
          }
          let createdAt = n.createdAt;
          while (db.prepare("SELECT 1 FROM capture_jobs WHERE id=?").get(captureJobIdOf(n.key, createdAt))) createdAt++;
          const j: CaptureJob = {
            id: captureJobIdOf(n.key, createdAt),
            key: n.key,
            request: structuredClone(n.request),
            acquirer: n.acquirer,
            render: n.render,
            requester: n.requester,
            generation: n.generation,
            host: n.host,
            requesters: [{ agent: n.requester, generation: n.generation }],
            state: "open",
            steps: [],
            outcome: null,
            createdAt,
            updatedAt: createdAt,
          };
          putJob(j);
          return j.id;
        },
        fingerprintOf("capture.begin", n.key, n.request, n.acquirer, n.render, n.requester),
      );
      return mustJob(id);
    },

    async advance(id, step, key) {
      return once(
        "capture.advance",
        key,
        () => {
          const j = mustJob(id);
          if (j.state === "settled") return j;
          j.steps.push(structuredClone(step));
          j.updatedAt = now();
          putJob(j);
          return j;
        },
        fingerprintOf("capture.advance", id, step),
      );
    },

    async settle(id, outcome: CaptureOutcome, key) {
      return once(
        "capture.settle",
        key,
        () => {
          const j = mustJob(id);
          if (j.state === "settled") return j;
          if (outcome.state === "pending") throw new Error(`capture job ${id} cannot settle as pending; pending is not terminal`);
          const t = now();
          if (outcome.state === "ok") {
            const rec = outcome.capture;
            if (rec.predicate.key !== j.key) throw new Error(`capture ${rec.id} has cache key ${rec.predicate.key}, not job ${id}'s key ${j.key}`);
            db.prepare("INSERT OR IGNORE INTO capture_records (id,key,created_at,doc) VALUES (?,?,?,?)").run(rec.id, j.key, rec.createdAt, JSON.stringify(rec));
            for (const a of rec.artifacts) db.prepare("INSERT OR IGNORE INTO capture_artifacts (sha256,doc) VALUES (?,?)").run(a.sha256, JSON.stringify(a));
            db.prepare("DELETE FROM capture_negative WHERE key=?").run(j.key);
          } else {
            if (outcome.job !== id) throw new Error(`failed outcome names job ${outcome.job}, not ${id}`);
            const ttl = negativeTtlMs(outcome.failure, ROBOTS_CACHE_MAX_MS);
            if (ttl > 0)
              db.prepare(
                "INSERT INTO capture_negative (key,failure,until) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET failure=excluded.failure, until=excluded.until",
              ).run(j.key, JSON.stringify(outcome.failure), t + ttl);
          }
          j.state = "settled";
          j.outcome = structuredClone(outcome);
          j.updatedAt = t;
          putJob(j);
          return j;
        },
        fingerprintOf("capture.settle", id, outcome),
      );
    },

    async job(id) {
      return jobRow(id);
    },

    async open() {
      return (db.prepare("SELECT doc FROM capture_jobs WHERE state='open' ORDER BY created_at, id").all() as Row[]).map((r) => JSON.parse(r.doc) as CaptureJob);
    },

    async latest(key) {
      return recordOf(db.prepare("SELECT doc FROM capture_records WHERE key=? ORDER BY created_at DESC, seq DESC LIMIT 1").get(key) as Row | undefined);
    },

    async get(id) {
      return recordOf(db.prepare("SELECT doc FROM capture_records WHERE id=?").get(id) as Row | undefined);
    },

    async list(opts = {}) {
      const limit = Math.min(CAPTURE_LIST_LIMIT_MAX, Math.max(1, Math.trunc(opts.limit ?? CAPTURE_LIST_LIMIT_DEFAULT)));
      return (db.prepare("SELECT doc FROM capture_records ORDER BY created_at DESC, seq DESC LIMIT ?").all(limit) as Row[]).map(
        (r) => JSON.parse(r.doc) as CaptureRecord,
      );
    },

    async byDigest(sha256) {
      const r = db.prepare("SELECT doc FROM capture_artifacts WHERE sha256=?").get(sha256) as Row | undefined;
      return r ? (JSON.parse(r.doc) as CaptureArtifact) : null;
    },

    async negative(key, at) {
      const r = db.prepare("SELECT failure, until FROM capture_negative WHERE key=?").get(key) as Row | undefined;
      if (!r || (r.until as number) <= at) return null;
      return { failure: JSON.parse(r.failure) as CaptureFailure, until: r.until as number };
    },

    async pauseDomain(domain, until, key) {
      if (!Number.isSafeInteger(until) || until < 0) throw new Error(`capture pause until must be a non-negative safe integer, got ${until}`);
      once(
        "capture.pause",
        key,
        () => {
          db.prepare("INSERT INTO capture_pauses (domain,until) VALUES (?,?) ON CONFLICT(domain) DO UPDATE SET until=max(until, excluded.until)").run(
            domain,
            until,
          );
          return null;
        },
        fingerprintOf("capture.pause", domain, until),
      );
    },

    async domainPause(domain, at) {
      const r = db.prepare("SELECT until FROM capture_pauses WHERE domain=?").get(domain) as Row | undefined;
      return r && (r.until as number) > at ? (r.until as number) : null;
    },
  };
}
