import { createHash } from "node:crypto";
import {
  CAPTURE_LIST_LIMIT_DEFAULT,
  CAPTURE_LIST_LIMIT_MAX,
  canonical,
  captureJobIdOf,
  IdempotencyConflictError,
  negativeTtlMs,
  parseWaybackAvailability,
  ROBOTS_CACHE_MAX_MS,
  robotsVerdict,
} from "@pomtree/core";
import type {
  CaptureArtifact,
  CaptureFailure,
  CaptureIndex,
  CaptureJob,
  CaptureJobId,
  CaptureOutcome,
  CaptureParser,
  CaptureRecord,
  CaptureStep,
  NewCaptureJob,
  RobotsEvidence,
} from "@pomtree/core";

// In-memory CaptureIndex with the durable adapter's rules (store-sqlite capture-index.ts): the same idempotency fingerprints and
// IdempotencyConflictError, join-the-open-job, first-wins settle, negative-cache TTLs from core negativeTtlMs, pauses that only
// extend, and newest-first listing. `errors` scripts a failure for the next mutating call (begin/advance/settle/pauseDomain),
// consumed in order (null lets that call through), to drive the broker's `unavailable`/`index` path. Reads return copies.
export class FakeCaptureIndex implements CaptureIndex {
  readonly jobs = new Map<CaptureJobId, CaptureJob>();
  readonly records: CaptureRecord[] = []; // insertion order
  readonly artifacts = new Map<string, CaptureArtifact>();
  readonly negatives = new Map<string, { failure: CaptureFailure; until: number }>();
  readonly pauses = new Map<string, number>();
  errors: (Error | null)[] = [];
  private keys = new Map<string, { fingerprint: string; result: unknown }>();
  private now: () => number;
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private fault(): void {
    const e = this.errors.shift();
    if (e) throw e;
  }
  private once<T>(scope: string, key: string, fingerprint: string, fn: () => T): T {
    const k = `${scope}:${key}`;
    const hit = this.keys.get(k);
    if (hit) {
      if (hit.fingerprint !== fingerprint) throw new IdempotencyConflictError(scope, key);
      return structuredClone(hit.result) as T;
    }
    const r = fn();
    this.keys.set(k, { fingerprint, result: structuredClone(r) });
    return structuredClone(r);
  }
  private must(id: CaptureJobId): CaptureJob {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown capture job ${id}`);
    return j;
  }

  async begin(n: NewCaptureJob, key: string): Promise<CaptureJob> {
    this.fault();
    const id = this.once("capture.begin", key, fingerprint("capture.begin", n.key, n.request, n.acquirer, n.render, n.requester), () => {
      const open = [...this.jobs.values()].filter((j) => j.key === n.key && j.state === "open").sort((a, b) => a.createdAt - b.createdAt)[0];
      if (open) {
        if (!open.requesters.some((x) => x.agent === n.requester)) {
          open.requesters.push({ agent: n.requester, generation: n.generation });
          open.updatedAt = this.now();
        }
        return open.id;
      }
      let createdAt = n.createdAt;
      while (this.jobs.has(captureJobIdOf(n.key, createdAt))) createdAt++;
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
      this.jobs.set(j.id, j);
      return j.id;
    });
    return structuredClone(this.must(id));
  }

  async advance(id: CaptureJobId, step: CaptureStep, key: string): Promise<CaptureJob> {
    this.fault();
    return this.once("capture.advance", key, fingerprint("capture.advance", id, step), () => {
      const j = this.must(id);
      if (j.state === "settled") return j;
      j.steps.push(structuredClone(step));
      j.updatedAt = this.now();
      return j;
    });
  }

  async settle(id: CaptureJobId, outcome: CaptureOutcome, key: string): Promise<CaptureJob> {
    this.fault();
    return this.once("capture.settle", key, fingerprint("capture.settle", id, outcome), () => {
      const j = this.must(id);
      if (j.state === "settled") return j;
      if (outcome.state === "pending") throw new Error(`capture job ${id} cannot settle as pending; pending is not terminal`);
      const t = this.now();
      if (outcome.state === "ok") {
        const rec = outcome.capture;
        if (rec.predicate.key !== j.key) throw new Error(`capture ${rec.id} has cache key ${rec.predicate.key}, not job ${id}'s key ${j.key}`);
        if (!this.records.some((r) => r.id === rec.id)) this.records.push(structuredClone(rec));
        for (const a of rec.artifacts) if (!this.artifacts.has(a.sha256)) this.artifacts.set(a.sha256, structuredClone(a));
        this.negatives.delete(j.key);
      } else {
        if (outcome.job !== id) throw new Error(`failed outcome names job ${outcome.job}, not ${id}`);
        const ttl = negativeTtlMs(outcome.failure, ROBOTS_CACHE_MAX_MS);
        if (ttl > 0) this.negatives.set(j.key, { failure: structuredClone(outcome.failure), until: t + ttl });
      }
      j.state = "settled";
      j.outcome = structuredClone(outcome);
      j.updatedAt = t;
      return j;
    });
  }

  async job(id: CaptureJobId): Promise<CaptureJob | null> {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }

  async open(): Promise<CaptureJob[]> {
    // TODO(audit-suspected-pool): no test lists open jobs whose creation order differs from id order, so the tie-break is unpinned.
    return [...this.jobs.values()]
      .filter((j) => j.state === "open")
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((j) => structuredClone(j));
  }

  private newestFirst(): CaptureRecord[] {
    return this.records
      .map((r, seq) => ({ r, seq }))
      .sort((a, b) => b.r.createdAt - a.r.createdAt || b.seq - a.seq)
      .map((x) => x.r);
  }

  async latest(key: string): Promise<CaptureRecord | null> {
    const r = this.newestFirst().find((x) => x.predicate.key === key);
    return r ? structuredClone(r) : null;
  }

  async get(id: string): Promise<CaptureRecord | null> {
    const r = this.records.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }

  async list(opts: { limit?: number } = {}): Promise<CaptureRecord[]> {
    const limit = Math.min(CAPTURE_LIST_LIMIT_MAX, Math.max(1, Math.trunc(opts.limit ?? CAPTURE_LIST_LIMIT_DEFAULT)));
    return structuredClone(this.newestFirst().slice(0, limit));
  }

  async byDigest(sha256: string): Promise<CaptureArtifact | null> {
    const a = this.artifacts.get(sha256);
    return a ? structuredClone(a) : null;
  }

  async negative(key: string, now: number): Promise<{ failure: CaptureFailure; until: number } | null> {
    const n = this.negatives.get(key);
    return n && n.until > now ? structuredClone(n) : null;
  }

  async pauseDomain(domain: string, until: number, key: string): Promise<void> {
    this.fault();
    if (!Number.isSafeInteger(until) || until < 0) throw new Error(`capture pause until must be a non-negative safe integer, got ${until}`);
    this.once("capture.pause", key, fingerprint("capture.pause", domain, until), () => {
      this.pauses.set(domain, Math.max(this.pauses.get(domain) ?? 0, until));
      return null;
    });
  }

  async domainPause(domain: string, now: number): Promise<number | null> {
    const u = this.pauses.get(domain);
    return u !== undefined && u > now ? u : null;
  }
}

const fingerprint = (...parts: unknown[]): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(parts)))
    .digest("hex");

// One scripted CaptureParser answer: let the pure function answer (null), reject with an error, or hang until released.
// TODO(testing-dead-exports): exported but unused outside this file; un-export once the open packages/testing branches merge.
export type FakeCaptureParserScript = null | { reject: Error } | { hang: true };

// CaptureParser that runs core's pure functions in-process (robotsVerdict, parseWaybackAvailability), so a test gets the real
// verdicts without a child process. Every call is recorded in `calls` (method, decoded body and arguments). `script` is consumed in
// order, one entry per call; an empty script answers. A hung call stays pending until `releaseHung(error)` rejects it.
export class FakeCaptureParser implements CaptureParser {
  calls: ({ method: "robots"; body: string; tokens: string[]; path: string } | { method: "waybackAvailability"; body: string })[] = [];
  script: FakeCaptureParserScript[] = [];
  private hung: ((e: Error) => void)[] = [];

  private async next<T>(answer: () => T): Promise<T> {
    const s = this.script.shift() ?? null;
    if (s === null) return answer();
    if ("reject" in s) throw s.reject;
    return new Promise<T>((_, reject) => {
      this.hung.push(reject);
    });
  }

  async robots(i: { body: Uint8Array; tokens: string[]; path: string }): Promise<Pick<RobotsEvidence, "verdict" | "rule">> {
    const body = new TextDecoder().decode(i.body);
    this.calls.push({ method: "robots", body, tokens: [...i.tokens], path: i.path });
    return this.next(() => robotsVerdict(body, i.tokens, i.path));
  }

  async waybackAvailability(i: { body: Uint8Array }): Promise<{ url: string; timestamp: string; archivedAt: number } | null> {
    const body = new TextDecoder().decode(i.body);
    this.calls.push({ method: "waybackAvailability", body });
    return this.next(() => parseWaybackAvailability(body));
  }

  // Rejects every hung call (for test cleanup or to simulate the parser process dying); returns how many there were.
  releaseHung(error: Error = new Error("capture parser hung call released")): number {
    const n = this.hung.length;
    for (const r of this.hung.splice(0)) r(error);
    return n;
  }
}
