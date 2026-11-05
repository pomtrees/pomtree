// The capture broker's pomtreed-side contract: what its clients (agent web_fetch, the workflow
// fetch capability, the /v1/capture routes) call, and what the daemon wiring (main.ts, the hn-digest in-process runtime) injects.
// The broker implementation lives in broker.ts beside it; the pure shapes it builds on are core's (capture.ts, ports.ts, kinds.ts).
// Types only.
import type {
  AgentId,
  ApprovalId,
  CaptureArtifact,
  CaptureId,
  CaptureIndex,
  CaptureJobId,
  CaptureParser,
  CaptureRecord,
  CaptureRequest,
  CaptureRequestedJournalPayload,
  CaptureResponse,
  CaptureSettledJournalPayload,
  CaptureStepJournalPayload,
  FreshnessConfig,
  FreshnessRule,
  HostId,
  QuotaCounters,
  ReportStore,
} from "@pomtree/core";
import type { FetchFn } from "../ext-gateway.ts";
import type { HostPace } from "../host-pacer.ts";

// Who asks. An agent at the generation its credential (or registry record) carries; the broker re-checks it against the registry
// (a stale one is `forbidden`). The operator has no quota and any public host in scope.
export type CaptureRequester = { kind: "agent"; agent: AgentId; generation: number } | { kind: "operator" };

// The verdict of a capture_host approval for one out-of-scope host (webfetch-approval.ts's ladder, approval kind CAPTURE_HOST_KIND).
export type CaptureApprovalVerdict =
  | { state: "approved"; approval: ApprovalId }
  | { state: "pending"; approval: ApprovalId }
  | { state: "denied"; approval: ApprovalId; decision: "denied" | "timed out" };

// The request scope (doc section 5 step 1; L4: in S1 the agent's web_fetch host allowlist, or the workflow capability's `hosts`).
// `allows` is checked for the initial URL and every redirect hop (and for every redirect hop recorded in a cached capture before it
// is served). A refused initial host asks `approve` when present (pending_approval / denied); without one, or when it answers null
// (no approval path for this requester: refuse without asking), it fails network/egress_denied. A refused redirect hop always fails
// network/egress_denied. An approved host is in scope for the rest of that request.
export interface CaptureScope {
  allows(url: URL): boolean;
  approve?(host: string, idempotencyKey: string): Promise<CaptureApprovalVerdict | null>;
}

export type CaptureJournalPayload = CaptureRequestedJournalPayload | CaptureStepJournalPayload | CaptureSettledJournalPayload;

export interface CaptureBrokerConfig {
  userAgent: string; // workflow.fetch.userAgent, as resolved by resolveConfig (never blank); createCaptureBroker throws on a blank or invalid value
  waitMs: number; // capture.waitMs: default wait before a request answers pending
  timeoutMs: number; // capture.timeoutMs: per-rung deadline (every hop and the body)
  maxBytes: number; // capture.maxBytes: per-capture body cap (too_large)
  freshness: FreshnessConfig; // capture.freshness.{stable,daily,live}Ms
  freshnessRules: readonly FreshnessRule[]; // capture.freshness.rules (core parseFreshnessRules)
  denylist: readonly string[]; // capture.denylist (core denylistMatch)
  quota: { requests: number; windowMs: number }; // capture.quota.requests / capture.quota.windowMs, per agent
  maxRedirects?: number; // default 5
}

export interface CaptureBrokerDeps {
  index: CaptureIndex; // Store.captures
  parser: CaptureParser; // ProcessCaptureParser in production (decision C9 / L1)
  quota: QuotaCounters; // the store's durable counters (QUOTA_SCOPES.captureRequests and the pacer)
  pace?: HostPace; // the ONE daemon pacer (host-pacer.ts), shared with web_fetch and workflow fetch; absent = unpaced
  reports: ReportStore; // artifacts are root-owned reports, id derived from the sha256
  root(): Promise<{ id: AgentId; generation: number; host: HostId }>;
  // The agent's current registry generation, or null when it is unknown (both refuse as `forbidden` unless it matches).
  generationOf(agent: AgentId): Promise<number | null>;
  // The request scope of a requester when the call passes none (CaptureRequestOptions.scope): main.ts derives it from the agent's
  // egress policy and the approvals store, exactly as web_fetch's scope and escalation today. Operator: absent means any host.
  scopeFor(who: CaptureRequester): Promise<CaptureScope>;
  // Journals one capture row on `agent`'s journal (requested and settled on each requester, the root for the operator; steps on the
  // root), idempotent by key. A failure is logged, never fatal to the capture.
  record(agent: AgentId, payload: CaptureJournalPayload, key: string): Promise<void>;
  log(line: string): void; // operator-facing text (captureMessages(...).operator) and broker diagnostics
  // The API rung's parse handoff: pomtreed stores the official-API body unread and hands it here (decision C9).
  // TODO(capture-broker): S2 replaces this with the agent-image capture worker (parse-only mode); core CaptureParser has no
  // parse-only method yet, so text extraction does not run in S1 and the default is a no-op.
  handoffApiBody?(i: { job: CaptureJobId; acquirer: string; resource: string; mediaType: string; body: Uint8Array }): Promise<void>;
  fetch?: FetchFn; // default ext-gateway defaultFetch (pinned); tests pass testFetchSeam(origin.hostsMap(...)).fetch
  resolveDns?: (h: string) => Promise<{ address: string; family: number }[]>;
  hostId: HostId;
  pomtreedVersion: string;
  config: CaptureBrokerConfig;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CaptureRequestOptions {
  waitMs?: number; // overrides config.waitMs for this call (web_fetch: webfetch.timeoutMs; workflow fetch: its timeoutMs/deadline)
  signal?: AbortSignal; // the caller stops waiting (the job keeps running for other requesters)
  scope?: CaptureScope; // overrides deps.scopeFor (workflow fetch: its capability `hosts`, no approval)
  // Per-call limits of the requester, applied only when this call creates the job (a joined job or a cache hit charges nothing).
  // `takeRequest` is called synchronously right before each origin send (the static or official-API rung, every redirect hop and
  // the broker's own retry; robots.txt and Wayback reads are not charged); false stops the job before that send, settling
  // quota/requests, which is never negatively cached. `maxBytes` tightens capture.maxBytes for the body read (too_large, likewise
  // never negatively cached). Workflow fetch passes its capability's maxRequests budget and maxBytes.
  takeRequest?: () => boolean;
  maxBytes?: number;
}

export interface CaptureBroker {
  // The section 5 lifecycle. Never throws for a request-level problem: every failure is an outcome with `message` set to the
  // model-facing text (captureMessages(...).model); the operator text goes to deps.log and the journal. Throws only
  // IdempotencyConflictError (the same key with a different request; the API maps it to 409).
  request(who: CaptureRequester, req: CaptureRequest, idempotencyKey: string, opts?: CaptureRequestOptions): Promise<CaptureResponse>;
  // Waits up to waitMs on a job (pomtree capture wait); null when the job is unknown. An agent may wait only on a job it joined.
  wait(who: CaptureRequester, job: CaptureJobId, waitMs: number, signal?: AbortSignal): Promise<CaptureResponse | null>;
  show(id: CaptureId): Promise<CaptureRecord | null>;
  list(limit?: number): Promise<CaptureRecord[]>;
  // The stored bytes of one artifact, re-hashed against artifact.sha256 (throws when missing or mismatched). pomtreed decodes nothing.
  read(artifact: CaptureArtifact): Promise<Uint8Array>;
  // Restart recovery: reruns each open job's interrupted rung once under the same step keys (opId keeps quota and pacing charged
  // once). Called once at daemon start; resolves when the jobs have been started, not when they settle.
  recover(): Promise<number>;
  // Stops waiting and aborts in-flight rungs (daemon shutdown); open jobs stay open in the index for recover().
  close(): Promise<void>;
}
