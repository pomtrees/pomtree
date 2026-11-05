// The capture broker: the one daemon component that acquires a web page on an agent's
// behalf. A request runs admission (generation, render, scope with the capture_host approval, the per-agent quota), then the shared
// cache and the negative cache, then policy (the operator User-Agent, the denylist, a Retry-After pause), then joins or creates a
// durable job in CaptureIndex and waits up to capture.waitMs for it. The job's runner tries the rungs (an official-API acquirer, or
// robots.txt then the static fetch; then Wayback after a failure that says nothing about the publisher's wishes), stores what it
// received as root-owned reports addressed by sha256, and settles the job. Every mutating step is journaled under a key derived from
// the job and the step, so recover() after a restart resumes rather than repeats. pomtreed hashes and stores bodies but never
// interprets one: robots.txt and the Wayback answer go through the CaptureParser port (decision C9).
// The only in-process state is ephemeral: the runner and waiter map (one runner per job id) and the operator evidence of a running
// job's failure. The durable truth is the index, robots.txt included: each origin's robots.txt is itself a capture under its own
// cache key (acquirer ROBOTS_ACQUIRER), reused for at most RFC 9309's 24 hours and evaluated through the parser on every use, so a
// restarted pomtreed rereads it from the index instead of fetching it again.
import { createHash } from "node:crypto";
import type {
  AgentId,
  CaptureArtifact,
  CaptureArtifactRole,
  CaptureFailure,
  CaptureId,
  CaptureJob,
  CaptureJobId,
  CaptureMessageContext,
  CaptureOutcome,
  CapturePredicate,
  CaptureRecord,
  CaptureRequest,
  CaptureResponse,
  CaptureRung,
  CaptureStep,
  FetchMeta,
  FreshnessClass,
  RobotsEvidence,
} from "@pomtree/core";
import {
  IdempotencyConflictError,
  ROBOTS_CACHE_MAX_MS,
  ROBOTS_PARSE_LIMIT_BYTES,
  WAYBACK_ANSWER_MAX_BYTES,
  brokerRetriesOnce,
  cacheShareable,
  canonicalCaptureUrl,
  captureCacheKey,
  captureFailure,
  captureIdOf,
  captureMessages,
  capturePendingMessage,
  captureRequestProblem,
  captureRequestedPayload,
  captureSettledPayload,
  captureStatement,
  captureStepPayload,
  denylistMatch,
  effectiveMaxAgeMs,
  freshnessOf,
  maxAgeFor,
  robotsFetchVerdict,
  robotsTokens,
  userAgentIdOf,
  userAgentReason,
  waybackAvailabilityUrl,
  waybackEligible,
  waybackSnapshotRawUrl,
} from "@pomtree/core";
import { QUOTA_SCOPES, windowStart } from "../quota.ts";
import { registrableDomain } from "../registrable-domain.ts";
import { type AcquirerMatch, acquirerFor } from "./acquirers.ts";
import { type DialFailure, type DialOptions, type DialResult, dial } from "./dial.ts";
import { CaptureParserError } from "./process-parser.ts";
import type { CaptureBroker, CaptureBrokerDeps, CaptureRequester, CaptureRequestOptions, CaptureScope } from "./types.ts";

// The content types the static rung stores. Raw bytes of any document type are kept as evidence (text extraction is S2); media,
// fonts, archives and opaque binaries are refused as unsupported_type, because no rung can extract them.
const UNSTORABLE_MAJOR = ["video/", "audio/", "font/", "model/", "multipart/"];
const UNSTORABLE = [
  "application/octet-stream",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
];
export function storableType(contentType: string | null): boolean {
  if (contentType === null) return true;
  const base = (contentType.split(";")[0] as string).trim().toLowerCase();
  return !UNSTORABLE_MAJOR.some((m) => base.startsWith(m)) && !UNSTORABLE.includes(base);
}

const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

// The job id named in a refusal that happened before any job existed (admission, cache, policy): a stable id of the request.
const requestJobId = (requester: AgentId, idempotencyKey: string): CaptureJobId => `cj-${sha256Hex(`request\0${requester}\0${idempotencyKey}`)}`;

// A rung's outcome inside the runner.
type RungResult =
  | { ok: true; record: CaptureRecord | null; status: number; bytes: number } // record null: a robots.txt step
  | { ok: false; failure: CaptureFailure; ctx: Partial<CaptureMessageContext>; status: number | null; aborted?: true };

type RobotsEntry = { status: number; bytes: Uint8Array | null; artifact: CaptureArtifact | null; fetchedAt: number };
// The acquirer of an origin's robots.txt capture: its cache key names the robots.txt URL as the resource.
export const ROBOTS_ACQUIRER = "robots";

interface RunOptions {
  allows: (u: URL) => boolean;
  revalidate: CaptureRecord | null;
  // The creating requester's per-call limits (CaptureRequestOptions.takeRequest and maxBytes); absent for a joined, recovered or
  // waited-on job, so one requester's budget never gates another's shared job.
  takeRequest?: () => boolean;
  maxBytes?: number;
}

class IndexUnavailable extends Error {}

export function createCaptureBroker(deps: CaptureBrokerDeps): CaptureBroker {
  const cfg = deps.config;
  // The identity is resolved upstream (resolveConfig maps a blank to the default); a blank or invalid one here is a wiring bug, not a request failure.
  const uaWhy = cfg.userAgent === "" ? "empty" : userAgentReason(cfg.userAgent);
  if (uaWhy !== null)
    throw new Error(
      `createCaptureBroker: config.userAgent is ${cfg.userAgent === "" ? "empty" : `invalid: ${uaWhy}`}; pass the value resolved from workflow.fetch.userAgent (resolveConfig), which is never blank`,
    );
  const now = deps.now ?? Date.now;
  const index = deps.index;
  const shutdown = new AbortController();
  const running = new Map<CaptureJobId, Promise<CaptureOutcome | null>>();
  const evidence = new Map<CaptureJobId, Partial<CaptureMessageContext>>();
  const tokens = robotsTokens(cfg.userAgent);

  const log = (line: string) => {
    try {
      deps.log(line);
    } catch {
      // a broken log sink never fails a capture
    }
  };
  const record = async (agent: AgentId, payload: Parameters<CaptureBrokerDeps["record"]>[1], key: string): Promise<void> => {
    try {
      await deps.record(agent, payload, key);
    } catch (e) {
      log(`capture: journal write failed for ${agent} (${key.slice(0, 80)}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const idx = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (e instanceof IdempotencyConflictError) throw e;
      log(`capture: index unavailable: ${e instanceof Error ? e.message : String(e)}`);
      throw new IndexUnavailable();
    }
  };

  // Defaults every message can name without the runner's evidence, so a replayed or cached failure renders the same text.
  const defaultsFor = (url: string | undefined): Partial<CaptureMessageContext> => {
    let robotsUrl: string | undefined;
    let domain: string | undefined;
    try {
      if (url !== undefined) {
        const u = new URL(url);
        robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
        domain = registrableDomain(u.hostname);
      }
    } catch {
      // keep the defaults unset
    }
    return {
      ms: cfg.timeoutMs,
      cap: cfg.maxBytes,
      key: "capture.maxBytes",
      tokens,
      ...(robotsUrl !== undefined && { robotsUrl }),
      ...(domain !== undefined && { domain }),
    };
  };

  const freshFor = (rec: CaptureRecord, requestMaxAgeMs: number | undefined): boolean => {
    const age = now() - (rec.predicate.archivedAt ?? rec.predicate.fetch.fetchedAt);
    const max = effectiveMaxAgeMs({
      class: rec.predicate.freshness,
      cfg: cfg.freshness,
      ...(requestMaxAgeMs !== undefined && { requestMaxAgeMs }),
      cacheControl: rec.predicate.fetch.headers["cache-control"] ?? null,
    });
    return age <= max;
  };

  // The first host of a static capture's chain (every redirect hop and the final URL) outside `allows`, or null.
  const hopOutside = (rec: CaptureRecord, allows: (u: URL) => boolean): string | null => {
    if (rec.predicate.source !== "static") return null;
    for (const raw of [...rec.predicate.fetch.redirects.map((r) => r.url), rec.predicate.fetch.finalUrl]) {
      try {
        const u = new URL(raw);
        if (!allows(u)) return u.host;
      } catch {
        return raw.slice(0, 80);
      }
    }
    return null;
  };

  const store = async (bytes: Uint8Array, role: CaptureArtifactRole, mediaType: string): Promise<CaptureArtifact> => {
    const sha256 = sha256Hex(bytes);
    const root = await deps.root();
    // One report per digest per owner: the id is derived from the sha256 (the write is idempotent by id).
    const id = `cap-${sha256}`;
    const report = await deps.reports.write(
      {
        id,
        agent: root.id,
        generation: root.generation,
        host: root.host,
        name: `capture-${role}`,
        mediaType,
        sizeBytes: bytes.byteLength,
        sha256,
        content: bytes,
      },
      `capture:${sha256}`,
    );
    if (report.sha256 !== sha256) throw new Error(`capture report ${id} holds sha256 ${report.sha256}, not ${sha256}`);
    return { role, mediaType, sizeBytes: bytes.byteLength, sha256, report: { agent: root.id, id } };
  };

  const buildRecord = async (
    job: CaptureJob,
    p: Omit<CapturePredicate, "key" | "worker" | "controller">,
    artifacts: CaptureArtifact[],
  ): Promise<CaptureRecord> => {
    const root = await deps.root();
    const predicate: CapturePredicate = {
      key: job.key,
      ...p,
      // TODO(capture-broker): S2 names the capture worker that parsed the body (its agent, sandbox, image digest and egress chain
      // head); in S1 pomtreed itself dialed and stored the bytes and no worker parsed them, so the controller stands in.
      worker: { agent: root.id, generation: root.generation, host: deps.hostId, sandbox: "pomtreed", imageDigest: "none", egressChainHead: null },
      controller: { host: deps.hostId, pomtreedVersion: deps.pomtreedVersion },
    };
    const id: CaptureId = captureIdOf(captureStatement(predicate, artifacts));
    return { id, predicate, artifacts, envelope: null, timestamp: null, createdAt: now() };
  };

  // ---- steps ----

  const advance = (job: CaptureJob, step: CaptureStep, key: string) => idx(() => index.advance(job.id, step, key));

  const stepped = async (job: CaptureJob, rung: CaptureRung, label: string, work: () => Promise<RungResult>): Promise<RungResult> => {
    const root = await deps.root();
    const key = `${job.id}:${rung}:${label}`;
    const t0 = now();
    await advance(job, { kind: "rung_entered", rung, at: t0 }, `${key}:entered`);
    await record(root.id, captureStepPayload({ job: job.id, rung, phase: "entered" }), `${key}:entered`);
    const r = await work();
    if (r.ok === false && r.aborted) return r;
    const durationMs = Math.max(0, now() - t0);
    const bytes = r.ok ? r.bytes : 0;
    const status = r.status;
    await advance(job, { kind: "rung_result", rung, status, durationMs, bytes, ...(r.ok ? {} : { failure: r.failure }), at: now() }, `${key}:result`);
    await record(
      root.id,
      captureStepPayload({
        job: job.id,
        rung,
        phase: "finished",
        ...(status !== null && { status }),
        durationMs,
        bytes,
        ...(!r.ok && { failureClass: r.failure.class, ...(r.failure.reason !== undefined && { reason: r.failure.reason }) }),
      }),
      `${key}:finished`,
    );
    return r;
  };

  const dialWith = (o: Omit<DialOptions, "userAgent" | "fetch" | "resolveDns" | "pace" | "signal" | "now" | "maxRedirects">): Promise<DialResult> =>
    dial({
      ...o,
      userAgent: cfg.userAgent,
      signal: shutdown.signal,
      now,
      ...(cfg.maxRedirects !== undefined && { maxRedirects: cfg.maxRedirects }),
      ...(deps.fetch && { fetch: deps.fetch }),
      ...(deps.resolveDns && { resolveDns: deps.resolveDns }),
      ...(deps.pace && { pace: deps.pace }),
    });

  const parserFailure = (e: unknown): DialFailure => {
    const cause = e instanceof CaptureParserError ? e.failureCause : "killed";
    return { failure: captureFailure({ class: "capture_failed", reason: cause }), ctx: { cause, rung: "robots" }, meta: {} };
  };

  // The durable robots.txt cache. A fetched robots.txt (2xx, or a 4xx that allows all) is settled as its own capture job under
  // robotsKey, the RFC 9309 lifetime (ROBOTS_CACHE_MAX_MS) counted from its fetch; an unreachable one is never kept.
  const robotsKey = (robotsUrl: string) =>
    captureCacheKey({ acquirer: ROBOTS_ACQUIRER, resource: robotsUrl, render: "static", userAgentId: userAgentIdOf(cfg.userAgent) });
  const storedRobots = async (robotsUrl: string): Promise<RobotsEntry | null> => {
    const rec = await idx(() => index.latest(robotsKey(robotsUrl)));
    if (rec === null || now() - rec.predicate.fetch.fetchedAt >= ROBOTS_CACHE_MAX_MS) return null;
    const artifact = rec.artifacts.find((a) => a.role === "robots") ?? null;
    let bytes: Uint8Array | null = null;
    if (artifact !== null) {
      try {
        bytes = await broker.read(artifact);
      } catch (e) {
        log(`capture: stored robots.txt ${robotsUrl} is unreadable (${e instanceof Error ? e.message : String(e)}); fetching it again`);
        return null;
      }
    }
    return { status: rec.predicate.fetch.status, bytes, artifact, fetchedAt: rec.predicate.fetch.fetchedAt };
  };
  const keepRobots = async (robotsUrl: string, meta: FetchMeta, artifact: CaptureArtifact | null): Promise<void> => {
    const root = await deps.root();
    const key = robotsKey(robotsUrl);
    const t = now();
    const job = await idx(() =>
      index.begin(
        {
          key,
          request: { url: robotsUrl, render: "static", purpose: "robots.txt" },
          acquirer: ROBOTS_ACQUIRER,
          render: "static",
          requester: root.id,
          generation: root.generation,
          host: root.host,
          createdAt: t,
        },
        `robots:${key}:${meta.fetchedAt}`,
      ),
    );
    const rec = await buildRecord(
      job,
      { source: "static", acquirer: ROBOTS_ACQUIRER, freshness: "daily", fetch: meta, robots: null },
      artifact ? [artifact] : [],
    );
    await idx(() => index.settle(job.id, { state: "ok", capture: rec, servedFrom: "static", ageMs: 0 }, `robots:${key}:${meta.fetchedAt}:settle`));
  };

  // robots.txt for the origin of `u` (RFC 9309, decision C3): the stored verdict for its path, or why the origin may not be dialed.
  const robotsFor = async (
    job: CaptureJob,
    u: URL,
    label: string,
  ): Promise<{ evidence: RobotsEvidence; artifact: CaptureArtifact | null } | (DialFailure & { aborted?: true })> => {
    const origin = `${u.protocol}//${u.host}`;
    const robotsUrl = `${origin}/robots.txt`;
    let entry = await storedRobots(robotsUrl);
    if (entry === null) {
      const held: { failure: (DialFailure & { aborted?: true }) | null } = { failure: null };
      const fetched = await stepped(job, "robots", label, async () => {
        const d = await dialWith({
          url: robotsUrl,
          maxBytes: ROBOTS_PARSE_LIMIT_BYTES,
          overflow: "truncate",
          timeoutMs: cfg.timeoutMs,
          rawStatus: true,
          opIdBase: `${job.id}:robots:${label}`,
        });
        const unreach = (status: number | null, extra: Partial<CaptureMessageContext>): RungResult => {
          const f: DialFailure = {
            failure: captureFailure({ class: "network", reason: "robots_unreachable", ...(status !== null && { status }) }),
            ctx: { robotsUrl, ...extra },
            meta: {},
          };
          held.failure = f;
          return { ok: false, ...f, status };
        };
        if (!d.ok) {
          if (d.aborted) {
            held.failure = { ...d, aborted: true };
            return { ok: false, failure: d.failure, ctx: {}, status: null, aborted: true };
          }
          // A name that does not resolve, a TLS failure or an address the SSRF guard refuses is the origin's own failure, reported
          // as itself; a timeout, a reset or a malformed answer makes the robots.txt unreachable.
          if (d.failure.class === "network") {
            held.failure = { failure: d.failure, ctx: d.ctx, meta: {} };
            return { ok: false, failure: d.failure, ctx: d.ctx, status: null };
          }
          return unreach(d.meta.status ?? null, { ...(d.failure.class === "timeout" && { phase: d.failure.reason }) });
        }
        const verdict = robotsFetchVerdict(d.meta.status);
        if (verdict === "unreachable") return unreach(d.meta.status, {});
        const artifact = verdict === "parse" ? await store(d.bytes, "robots", "text/plain") : null;
        entry = { status: d.meta.status, bytes: verdict === "parse" ? d.bytes : null, artifact, fetchedAt: d.meta.fetchedAt };
        await keepRobots(robotsUrl, d.meta, artifact);
        return { ok: true, record: null, status: d.meta.status, bytes: d.bytes.byteLength };
      });
      if (!fetched.ok) return held.failure ?? { failure: fetched.failure, ctx: fetched.ctx, meta: {} };
    }
    const e = entry as RobotsEntry;
    let verdict: Pick<RobotsEvidence, "verdict" | "rule"> = { verdict: "allow", rule: null };
    if (e.bytes !== null) {
      try {
        verdict = await deps.parser.robots({ body: e.bytes, tokens, path: `${u.pathname}${u.search}` });
      } catch (err) {
        return parserFailure(err);
      }
    }
    return {
      evidence: { url: robotsUrl, sha256: e.artifact?.sha256 ?? null, status: e.status, tokens: [...tokens], ...verdict, fetchedAt: e.fetchedAt },
      artifact: e.artifact,
    };
  };

  // A failure as a rung result, keeping the dial's status and evidence.
  const failed = (d: DialFailure & { aborted?: true }, status: number | null): RungResult => ({
    ok: false,
    failure: d.failure,
    ctx: d.ctx,
    status,
    ...(d.aborted && { aborted: true as const }),
  });

  const pauseOn = async (job: CaptureJob, host: string, f: CaptureFailure, ctx: Partial<CaptureMessageContext>): Promise<void> => {
    if (f.class !== "rate_limited") return;
    const domain = registrableDomain(host);
    const until = now() + (f.retryAfterMs ?? 0);
    ctx.domain = domain;
    ctx.pausedUntil = until;
    await idx(() => index.pauseDomain(domain, until, `${job.id}:pause:${domain}`));
  };

  // Rung 2, static: robots.txt for every hop's origin, then a guarded GET (a conditional one when revalidating).
  // The creating requester's limits on an origin dial (the static and official-API rungs; robots.txt and Wayback reads are the
  // broker's own protocol reads and are not charged): the byte cap is the tighter of capture.maxBytes and its maxBytes, and every send
  // first takes one unit of its request budget. A refused take is quota/requests (never negatively cached: it is the requester's).
  const originLimits = (o: RunOptions) => ({
    maxBytes: Math.min(cfg.maxBytes, o.maxBytes ?? cfg.maxBytes),
    ...(o.takeRequest && {
      beforeSend: (hop: number): DialFailure | null =>
        (o.takeRequest as () => boolean)()
          ? null
          : { failure: captureFailure({ class: "quota", reason: "requests" }), ctx: { hops: hop, reason: "requests" }, meta: {} },
    }),
  });

  const staticRung = async (job: CaptureJob, o: RunOptions, attempt: number): Promise<RungResult> => {
    const url = job.request.url;
    let robots: { evidence: RobotsEvidence; artifact: CaptureArtifact | null } | null = null;
    const stale = o.revalidate;
    const conditional =
      stale === null
        ? undefined
        : {
            ...(stale.predicate.fetch.headers.etag !== undefined && { etag: stale.predicate.fetch.headers.etag }),
            ...(stale.predicate.fetch.headers["last-modified"] !== undefined && { lastModified: stale.predicate.fetch.headers["last-modified"] }),
          };
    return stepped(job, "static", String(attempt), async () => {
      const d = await dialWith({
        url,
        ...originLimits(o),
        overflow: "fail",
        timeoutMs: cfg.timeoutMs,
        opIdBase: `${job.id}:static:${attempt}`,
        allows: o.allows,
        ...(conditional && { conditional }),
        beforeHop: async (hu, hop) => {
          const r = await robotsFor(job, hu, `${attempt}:${hop}`);
          if ("failure" in r) return r;
          if (r.evidence.verdict === "disallow")
            return {
              failure: captureFailure({ class: "blocked", reason: "robots", ...(r.evidence.rule !== null && { rule: r.evidence.rule }) }),
              ctx: { robotsUrl: r.evidence.url, robotsSha256: r.evidence.sha256, tokens: r.evidence.tokens },
              meta: {},
            };
          robots = r;
          return null;
        },
      });
      if (!d.ok) {
        if (!d.aborted) await pauseOn(job, new URL(d.meta.finalUrl ?? url).hostname, d.failure, d.ctx);
        return failed(d, d.meta.status ?? null);
      }
      const rob = robots as { evidence: RobotsEvidence; artifact: CaptureArtifact | null } | null;
      const robotsArtifacts = rob?.artifact ? [rob.artifact] : [];
      const freshness = job.acquirer === "web" ? freshnessOf(url, null, cfg.freshnessRules) : "daily";
      if (d.meta.status === 304 && stale !== null) {
        const meta: FetchMeta = { ...d.meta, contentType: stale.predicate.fetch.contentType, headers: { ...stale.predicate.fetch.headers, ...d.meta.headers } };
        const rec = await buildRecord(
          job,
          { source: "static", acquirer: "static", freshness, fetch: meta, robots: rob?.evidence ?? null, revalidatedFrom: stale.id },
          stale.artifacts,
        );
        return { ok: true, record: rec, status: 304, bytes: 0 };
      }
      if (!storableType(d.meta.contentType))
        return {
          ok: false,
          failure: captureFailure({ class: "unsupported_type", status: d.meta.status }),
          ctx: { type: d.meta.contentType ?? "none", rung: "static" },
          status: d.meta.status,
        };
      const raw = await store(d.bytes, "raw", d.meta.contentType ?? "application/octet-stream");
      const rec = await buildRecord(job, { source: "static", acquirer: "static", freshness, fetch: d.meta, robots: rob?.evidence ?? null }, [
        raw,
        ...robotsArtifacts,
      ]);
      return { ok: true, record: rec, status: d.meta.status, bytes: d.bytes.byteLength };
    });
  };

  // Rung 1, an official-API acquirer: pomtreed dials the API under its declared terms, stores the bytes unread and hands them to the
  // parse seam. No robots.txt: the acquirer declares its own terms (RobotsEvidence null).
  const apiRung = async (job: CaptureJob, acq: AcquirerMatch, o: RunOptions, attempt: number): Promise<RungResult> =>
    stepped(job, "api", String(attempt), async () => {
      const d = await dialWith({ url: acq.apiUrl, ...originLimits(o), overflow: "fail", timeoutMs: cfg.timeoutMs, opIdBase: `${job.id}:api:${attempt}` });
      if (!d.ok) {
        if (!d.aborted) await pauseOn(job, new URL(acq.apiUrl).hostname, d.failure, d.ctx);
        return failed(d, d.meta.status ?? null);
      }
      const mediaType = d.meta.contentType ?? "application/octet-stream";
      const raw = await store(d.bytes, "raw", mediaType);
      try {
        await deps.handoffApiBody?.({ job: job.id, acquirer: acq.acquirer, resource: acq.resource, mediaType, body: d.bytes });
      } catch (e) {
        log(`capture ${job.id}: api body handoff failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const meta: FetchMeta = { ...d.meta, requestedUrl: job.request.url };
      const rec = await buildRecord(job, { source: "api", acquirer: acq.acquirer, freshness: acq.freshness, fetch: meta, robots: null }, [raw]);
      return { ok: true, record: rec, status: d.meta.status, bytes: d.bytes.byteLength };
    });

  // Rung 3, Wayback (read-only availability API; Save Page Now is never used, decision C2): after web.archive.org's and archive.org's
  // own robots.txt, the snapshot closest to now, if it is young enough for the URL's freshness class.
  const waybackRung = async (job: CaptureJob, freshness: FreshnessClass): Promise<RungResult | { none: "none" | "too old" }> => {
    let why: "none" | "too old" = "none";
    const r = await stepped(job, "wayback", "0", async () => {
      const miss = (status: number | null): RungResult => ({ ok: false, failure: captureFailure({ class: "not_found" }), ctx: {}, status });
      const availUrl = waybackAvailabilityUrl(job.request.url, now());
      const robotsA = await robotsFor(job, new URL(availUrl), "wayback:availability");
      if ("failure" in robotsA || robotsA.evidence.verdict !== "allow") return miss(null);
      const a = await dialWith({
        url: availUrl,
        maxBytes: WAYBACK_ANSWER_MAX_BYTES,
        overflow: "fail",
        timeoutMs: cfg.timeoutMs,
        opIdBase: `${job.id}:wayback:availability`,
      });
      if (!a.ok) return a.aborted ? failed(a, null) : miss(a.meta.status ?? null);
      let snap: { url: string; timestamp: string; archivedAt: number } | null;
      try {
        snap = await deps.parser.waybackAvailability({ body: a.bytes });
      } catch {
        return miss(a.meta.status);
      }
      if (snap === null) return miss(a.meta.status);
      if (now() - snap.archivedAt > maxAgeFor(freshness, cfg.freshness)) {
        why = "too old";
        return miss(a.meta.status);
      }
      let robots: RobotsEvidence | null = null;
      const s = await dialWith({
        url: waybackSnapshotRawUrl(snap.timestamp, snap.url),
        maxBytes: cfg.maxBytes,
        overflow: "fail",
        timeoutMs: cfg.timeoutMs,
        opIdBase: `${job.id}:wayback:snapshot`,
        beforeHop: async (hu, hop) => {
          const rr = await robotsFor(job, hu, `wayback:${hop}`);
          if ("failure" in rr) return rr;
          if (rr.evidence.verdict === "disallow")
            return {
              failure: captureFailure({ class: "blocked", reason: "robots", ...(rr.evidence.rule !== null && { rule: rr.evidence.rule }) }),
              ctx: {},
              meta: {},
            };
          robots = rr.evidence;
          return null;
        },
      });
      if (!s.ok) return s.aborted ? failed(s, null) : miss(s.meta.status ?? null);
      if (!storableType(s.meta.contentType)) return miss(s.meta.status);
      const raw = await store(s.bytes, "raw", s.meta.contentType ?? "application/octet-stream");
      const meta: FetchMeta = { ...s.meta, requestedUrl: job.request.url };
      const rec = await buildRecord(job, { source: "wayback", acquirer: "wayback", freshness, fetch: meta, robots, archivedAt: snap.archivedAt }, [raw]);
      return { ok: true, record: rec, status: s.meta.status, bytes: s.bytes.byteLength };
    });
    if (r.ok || r.aborted) return r;
    return { none: why };
  };

  const withRetry = async (work: (attempt: number) => Promise<RungResult>): Promise<RungResult> => {
    const first = await work(0);
    if (first.ok || first.aborted || !brokerRetriesOnce(first.failure)) return first;
    return work(1);
  };

  // The job's runner: the rungs, then settle. Null when the broker shut down mid-run (the job stays open for recover()).
  const run = async (jobIn: CaptureJob, o: RunOptions): Promise<CaptureOutcome | null> => {
    let job = jobIn;
    try {
      const current = await idx(() => index.job(job.id));
      if (current === null) throw new IndexUnavailable();
      if (current.state === "settled") return current.outcome;
      job = current;
      // A robots.txt job left open by a crash between its begin and settle is closed unkept (not negatively cached); the next
      // request for that origin fetches robots.txt again.
      if (job.acquirer === ROBOTS_ACQUIRER) {
        const closed: CaptureOutcome = { state: "failed", job: job.id, failure: captureFailure({ class: "unavailable", reason: "index" }), cached: false };
        await idx(() => index.settle(job.id, closed, `${job.id}:settle`));
        return closed;
      }
      const acq = job.acquirer === "web" ? null : acquirerFor(job.request.url);
      const freshness = acq?.freshness ?? freshnessOf(job.request.url, null, cfg.freshnessRules);
      let r = acq === null ? await withRetry((a) => staticRung(job, o, a)) : await withRetry((a) => apiRung(job, acq, o, a));
      if (!r.ok && r.aborted) return null;
      // Rung 3 rescues web pages only: an official API is the authority for its own resource, and an archived copy of an API
      // answer is neither what the acquirer declared nor something the Wayback Machine reliably holds (deviation from section 5,
      // which does not restrict it). The API failure stands, with fallbackTried false.
      if (!r.ok && acq === null && waybackEligible(r.failure)) {
        const wb = await waybackRung(job, freshness);
        if ("none" in wb) {
          r = { ...r, failure: { ...r.failure, fallbackTried: true }, ctx: { ...r.ctx, wayback: wb.none } };
        } else if (!wb.ok && wb.aborted) return null;
        else r = wb;
      }
      if (shutdown.signal.aborted) return null;
      if (r.ok && r.record === null) throw new Error("a rung succeeded without a capture record");
      const outcome: CaptureOutcome = r.ok
        ? { state: "ok", capture: r.record as CaptureRecord, servedFrom: (r.record as CaptureRecord).predicate.source, ageMs: 0 }
        : { state: "failed", job: job.id, failure: r.failure, cached: false };
      if (!r.ok) evidence.set(job.id, { rung: acq === null ? "static" : "api", ...r.ctx });
      if (outcome.state === "ok")
        await advance(
          job,
          { kind: "stored", artifacts: outcome.capture.artifacts, fetch: outcome.capture.predicate.fetch, robots: outcome.capture.predicate.robots, at: now() },
          `${job.id}:stored`,
        );
      const settled = await idx(() => index.settle(job.id, outcome, `${job.id}:settle`));
      return settled.outcome ?? outcome;
    } catch (e) {
      if (shutdown.signal.aborted) return null;
      if (!(e instanceof IndexUnavailable)) log(`capture ${job.id}: runner failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      // The index (or the report store) cannot record the job: answer unavailable/index; the job stays open for recover().
      return { state: "failed", job: job.id, failure: captureFailure({ class: "unavailable", reason: "index" }), cached: false };
    }
  };

  const ensureRunner = (job: CaptureJob, o: RunOptions): Promise<CaptureOutcome | null> => {
    const live = running.get(job.id);
    if (live) return live;
    const p = run(job, o).finally(() => {
      if (running.get(job.id) === p) running.delete(job.id);
    });
    running.set(job.id, p);
    return p;
  };

  // ---- delivery ----

  interface Who {
    rid: AgentId; // the requester's journal (the root for the operator)
    generation: number;
    allows: (u: URL) => boolean;
  }

  const respondFailed = async (
    who: Who,
    job: CaptureJobId,
    failure: CaptureFailure,
    ctx: Partial<CaptureMessageContext>,
    url: string,
    cached: boolean,
  ): Promise<CaptureResponse> => {
    const m = captureMessages(failure, { ...defaultsFor(url), job, agent: who.rid, generation: who.generation, url, ...ctx });
    log(m.operator);
    await record(
      who.rid,
      captureSettledPayload({
        job,
        state: "failed",
        url,
        failureClass: failure.class,
        ...(failure.reason !== undefined && { reason: failure.reason }),
        cached,
      }),
      `${job}:settled:${who.rid}`,
    );
    return { outcome: { state: "failed", job, failure, cached }, message: m.model };
  };

  const deliver = async (who: Who, job: CaptureJobId, outcome: CaptureOutcome, url: string): Promise<CaptureResponse> => {
    if (outcome.state === "failed") return respondFailed(who, job, outcome.failure, evidence.get(job) ?? {}, url, outcome.cached);
    if (outcome.state === "pending") return { outcome, message: capturePendingMessage(outcome.job) };
    const outside = hopOutside(outcome.capture, who.allows);
    if (outside !== null)
      return respondFailed(
        who,
        job,
        captureFailure({ class: "network", reason: "egress_denied" }),
        { host: outside, egressRow: `scope refused ${outside}` },
        url,
        false,
      );
    await record(
      who.rid,
      captureSettledPayload({ job, state: "ok", url, capture: outcome.capture.id, servedFrom: outcome.servedFrom }),
      `${job}:settled:${who.rid}`,
    );
    return { outcome: { ...outcome, ageMs: Math.max(0, now() - outcome.capture.predicate.fetch.fetchedAt) }, message: null };
  };

  const awaitJob = async (
    who: Who,
    jobId: CaptureJobId,
    p: Promise<CaptureOutcome | null>,
    waitMs: number,
    url: string,
    signal?: AbortSignal,
  ): Promise<CaptureResponse> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, waitMs));
      onAbort = () => resolve(null);
      if (signal?.aborted) resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      shutdown.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([p, timeout]);
      if (outcome === null) return { outcome: { state: "pending", job: jobId }, message: capturePendingMessage(jobId) };
      return deliver(who, jobId, outcome, url);
    } finally {
      clearTimeout(timer);
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
        shutdown.signal.removeEventListener("abort", onAbort);
      }
    }
  };

  const safeAllows = (scope: CaptureScope) => (u: URL) => {
    try {
      return scope.allows(u);
    } catch {
      return false; // a broken scope check refuses (fail closed)
    }
  };

  const whoOf = async (who: CaptureRequester): Promise<{ rid: AgentId; generation: number }> => {
    if (who.kind === "agent") return { rid: who.agent, generation: who.generation };
    const root = await deps.root();
    return { rid: root.id, generation: root.generation };
  };

  const scopeOf = async (who: CaptureRequester, override?: CaptureScope): Promise<CaptureScope> => {
    if (override) return override;
    try {
      return await deps.scopeFor(who);
    } catch (e) {
      log(`capture: scope lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return { allows: () => false }; // fail closed
    }
  };

  const latestFresh = async (key: string, maxAgeMs: number | undefined): Promise<{ fresh: CaptureRecord | null; revalidate: CaptureRecord | null }> => {
    const latest = await idx(() => index.latest(key));
    if (latest === null) return { fresh: null, revalidate: null };
    if (freshFor(latest, maxAgeMs) && cacheShareable(latest.predicate.fetch.headers)) return { fresh: latest, revalidate: null };
    const h = latest.predicate.fetch.headers;
    const validators = latest.predicate.source === "static" && (h.etag !== undefined || h["last-modified"] !== undefined);
    return { fresh: null, revalidate: validators ? latest : null };
  };

  const broker: CaptureBroker = {
    async request(requester, req: CaptureRequest, idempotencyKey, opts: CaptureRequestOptions = {}) {
      let base: { rid: AgentId; generation: number };
      try {
        base = await whoOf(requester);
      } catch {
        const f = captureFailure({ class: "unavailable", reason: "index" });
        const job = requestJobId("operator", idempotencyKey);
        const m = captureMessages(f, { job });
        log(m.operator);
        return { outcome: { state: "failed", job, failure: f, cached: false }, message: m.model };
      }
      const pre = requestJobId(base.rid, idempotencyKey);
      const rawUrl = typeof (req as { url?: unknown } | null)?.url === "string" ? (req as { url: string }).url : "";
      let allows: (u: URL) => boolean = () => false;
      const refuse = (f: Omit<CaptureFailure, "retryable" | "fallbackTried">, ctx: Partial<CaptureMessageContext>, url: string) =>
        respondFailed({ ...base, allows }, pre, captureFailure(f), ctx, url, false);

      try {
        // 1. Admission: the request's shape, the URL, the generation, the render mode, the scope, the quota (before the cache, C8).
        const problem = captureRequestProblem(req);
        if (problem !== null) return refuse({ class: "invalid_request" }, { problem }, rawUrl);
        const canon = canonicalCaptureUrl(req.url);
        if ("problem" in canon) return refuse({ class: "invalid_request" }, { problem: canon.problem }, rawUrl);
        const url = canon.url;
        const u = new URL(url);
        const host = u.hostname.toLowerCase();
        if (requester.kind === "agent") {
          let current: number | null = null;
          try {
            current = await deps.generationOf(requester.agent);
          } catch {
            current = null;
          }
          if (current === null || current !== requester.generation)
            return refuse(
              { class: "forbidden" },
              { render: req.render ?? "auto", lacks: current === null ? "a registered generation" : `the current generation (${current})` },
              url,
            );
        }
        const render = req.render ?? "auto";
        if (render === "browser") return refuse({ class: "forbidden" }, { render: "browser", lacks: "render browser" }, url);
        // TODO(capture-broker): S2 adds the browser rung; until then `auto` never escalates and resolves to the static rung.
        const keyRender = "static" as const;
        const scope = await scopeOf(requester, opts.scope);
        const inScope = safeAllows(scope);
        const approved = new Set<string>();
        allows = (x: URL) => approved.has(x.hostname.toLowerCase()) || inScope(x);
        if (!allows(u)) {
          let v: Awaited<ReturnType<NonNullable<CaptureScope["approve"]>>> = null;
          try {
            v = scope.approve ? await scope.approve(host, idempotencyKey) : null;
          } catch {
            v = null; // a broken approval path refuses without asking (fail closed)
          }
          if (v === null) return refuse({ class: "network", reason: "egress_denied" }, { egressRow: `host ${host} is outside the request scope` }, url);
          if (v.state === "pending") return refuse({ class: "pending_approval", approval: v.approval }, {}, url);
          if (v.state === "denied") return refuse({ class: "denied", approval: v.approval }, { decision: v.decision, rung: "admission" }, url);
          approved.add(host);
        }
        if (requester.kind === "agent") {
          const t = now();
          const ws = windowStart(t, cfg.quota.windowMs);
          const q = deps.quota.take(QUOTA_SCOPES.captureRequests, requester.agent, ws, 1, cfg.quota.requests, `capture:${idempotencyKey}`);
          if (!q.ok)
            return refuse(
              { class: "quota", reason: "requests", retryAfterMs: ws + cfg.quota.windowMs - t },
              { used: q.used, limit: cfg.quota.requests, windowMs: cfg.quota.windowMs },
              url,
            );
        }

        // 2. Cache, then the negative cache.
        const acq = acquirerFor(url);
        const acquirer = acq?.acquirer ?? "web";
        const key = captureCacheKey({ acquirer, resource: acq?.resource ?? url, render: keyRender, userAgentId: userAgentIdOf(cfg.userAgent) });
        const { fresh, revalidate } = await latestFresh(key, req.maxAgeMs);
        const who: Who = { ...base, allows };
        if (fresh !== null) {
          await record(
            base.rid,
            captureRequestedPayload({ requester: base.rid, generation: base.generation, job: pre, key, render: keyRender, url, purpose: req.purpose }),
            `${pre}:requested`,
          );
          return deliver(who, pre, { state: "ok", capture: fresh, servedFrom: "cache", ageMs: 0 }, url);
        }
        const neg = await idx(() => index.negative(key, now()));
        if (neg !== null) return respondFailed(who, pre, neg.failure, {}, url, true);

        // 3. Policy: the denylist, a Retry-After pause on the domain we would dial.
        const dialHost = acq === null ? host : new URL(acq.apiUrl).hostname;
        const entry = denylistMatch(host, cfg.denylist) ?? denylistMatch(dialHost, cfg.denylist);
        if (entry !== null) return refuse({ class: "blocked", reason: "policy" }, { denylistEntry: entry }, url);
        const domain = registrableDomain(dialHost);
        const pausedUntil = await idx(() => index.domainPause(domain, now()));
        if (pausedUntil !== null) return refuse({ class: "rate_limited", retryAfterMs: pausedUntil - now() }, { domain, pausedUntil }, url);

        // 4. Begin or join the job, and wait for it.
        const job = await idx(() =>
          index.begin(
            {
              key,
              request: {
                url,
                purpose: req.purpose,
                ...(req.render !== undefined && { render: req.render }),
                ...(req.maxAgeMs !== undefined && { maxAgeMs: req.maxAgeMs }),
              },
              acquirer,
              render: keyRender,
              requester: base.rid,
              generation: base.generation,
              host: deps.hostId,
              createdAt: now(),
            },
            `${base.rid}:${idempotencyKey}`,
          ),
        );
        await record(
          base.rid,
          captureRequestedPayload({ requester: base.rid, generation: base.generation, job: job.id, key, render: keyRender, url, purpose: req.purpose }),
          `${job.id}:requested:${base.rid}:${idempotencyKey}`,
        );
        if (job.state === "settled" && job.outcome !== null) return deliver(who, job.id, job.outcome, url);
        // The per-call limits bind only the job this call created and starts: a joiner (or a replay of a job already running) shares
        // the creator's run and is charged nothing.
        // TODO(capture-broker): a requester that joined a job whose creator's per-call budget (takeRequest or maxBytes) refused it receives that requester-specific quota or too_large failure; it should instead start or join a fresh job
        const created = !running.has(job.id) && job.steps.length === 0 && job.requesters.length === 1 && job.requester === base.rid;
        const limits = created
          ? { ...(opts.takeRequest && { takeRequest: opts.takeRequest }), ...(opts.maxBytes !== undefined && { maxBytes: opts.maxBytes }) }
          : {};
        const p = ensureRunner(job, { allows, revalidate, ...limits });
        return awaitJob(who, job.id, p, opts.waitMs ?? cfg.waitMs, url, opts.signal);
      } catch (e) {
        if (e instanceof IdempotencyConflictError) throw e;
        if (!(e instanceof IndexUnavailable)) log(`capture ${pre}: request failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return refuse({ class: "unavailable", reason: "index" }, {}, rawUrl);
      }
    },

    async wait(requester, jobId, waitMs, signal) {
      const base = await whoOf(requester);
      const job = await index.job(jobId);
      if (job === null) return null;
      if (requester.kind === "agent" && !job.requesters.some((r) => r.agent === requester.agent)) return null;
      const scope = await scopeOf(requester);
      const allows = safeAllows(scope);
      const who: Who = { ...base, allows };
      if (job.state === "settled" && job.outcome !== null) return deliver(who, job.id, job.outcome, job.request.url);
      const { revalidate } = await latestFresh(job.key, job.request.maxAgeMs).catch(() => ({ revalidate: null }));
      return awaitJob(who, job.id, ensureRunner(job, { allows, revalidate }), waitMs, job.request.url, signal);
    },

    show: (id) => index.get(id),
    list: (limit) => index.list(limit === undefined ? {} : { limit }),

    async read(artifact) {
      const r = await deps.reports.read(artifact.report.agent, artifact.report.id);
      if (r === null) throw new Error(`capture artifact report ${artifact.report.id} is missing`);
      const sha = sha256Hex(r.content);
      if (sha !== artifact.sha256) throw new Error(`capture artifact report ${artifact.report.id} holds sha256 ${sha}, not ${artifact.sha256}`);
      return r.content;
    },

    async recover() {
      const open = await index.open();
      const root = await deps.root();
      let n = 0;
      for (const job of open) {
        if (running.has(job.id)) continue;
        const requester: CaptureRequester =
          job.requester === root.id ? { kind: "operator" } : { kind: "agent", agent: job.requester, generation: job.generation };
        const allows = safeAllows(await scopeOf(requester));
        const { revalidate } = await latestFresh(job.key, job.request.maxAgeMs).catch(() => ({ revalidate: null }));
        void ensureRunner(job, { allows, revalidate });
        n++;
      }
      return n;
    },

    async close() {
      shutdown.abort();
      await Promise.allSettled([...running.values()]);
    },
  };
  return broker;
}
