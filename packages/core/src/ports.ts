import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AgentId,
  AgentRecord,
  AgentState,
  Approval,
  ApprovalId,
  ApprovalState,
  Checkpoint,
  CheckpointId,
  Delivered,
  JsonValue,
  StateDoc,
  StateKey,
  StateMeta,
  StateOwner,
  StateUsage,
  StateWriter,
  DeterministicSpec,
  Escalation,
  EscalationId,
  EscalationState,
  ExitCause,
  ExitStatus,
  ExtensionId,
  ExtensionResult,
  ExtensionSpec,
  HarnessEvent,
  HostId,
  HostRecord,
  HostState,
  NewHost,
  NewReservation,
  Reservation,
  Resources,
  WorkspaceId,
  JournalEntry,
  MessagingChannel,
  MessagingSender,
  MessageKind,
  NewApproval,
  NewApprovalDecision,
  NewEscalation,
  NewJournalEntry,
  NewReport,
  PlacementStatus,
  Report,
  ReportId,
  SandboxBackendId,
  SandboxId,
  Schedule,
  ScheduleId,
  SessionId,
  Signal,
  SignalId,
  SnapshotId,
  SpawnSpec,
  Template,
  TemplateId,
  WaitCondition,
  WatchdogState,
} from "./types.ts";
import type { LOOPBACK_PORTS } from "./config/image-facts.ts";
import type { SandboxCapability, SandboxDeclaration } from "./sandbox-capabilities.ts";
import type {
  CheckResult,
  MergeId,
  MergeRecord,
  MergeReport,
  MergeRequest,
  MergeResult,
  MergeStatus,
  MergeStep,
  NewMergeRecord,
  Repo,
  RepoId,
} from "./merge.ts";
import type {
  CaptureArtifact,
  CaptureFailure,
  CaptureId,
  CaptureJobId,
  CaptureKeyRender,
  CaptureOutcome,
  CaptureRecord,
  CaptureRequest,
  CaptureRung,
  FetchMeta,
  RobotsEvidence,
} from "./capture.ts";

// Legal lifecycle edges: pending->running, running->yielded|exited, yielded->running|exited, exited->reaped.
export const LEGAL_TRANSITIONS: Record<AgentState, AgentState[]> = {
  pending: ["running"],
  running: ["yielded", "exited"],
  yielded: ["running", "exited"],
  exited: ["reaped"],
  reaped: [],
};

export interface Subscription extends AsyncIterable<JournalEntry> {
  close(): void;
}

// Every mutating call takes an idempotency key; repeating a key returns the original result.
export interface Journal {
  // Joined usage additionally has durable identity (agent, requestId): a new key or generation returns the first entry
  // without adding tokens or spend again, even after journal/idempotency retention. Unjoined usage keeps key-only identity.
  append(entry: NewJournalEntry): Promise<JournalEntry>; // rejects stale generations
  // `from` is inclusive: entries with seq >= from.
  read(opts: { from?: number; agent?: AgentId; limit?: number }): Promise<JournalEntry[]>;
  subscribe(opts: { from?: number; agent?: AgentId }): Subscription;
  // Retention. Deletes only rows of a prunable kind that are older than
  // `olderThanMs`, outside the newest `keepPerAgent` rows of their agent, and older than the
  // agent's latest checkpoint (the tail since it is kept for recovery; no checkpoint = no
  // such floor). `protectKinds` is subtracted from `kinds` (default JOURNAL_PRUNABLE_KINDS), so
  // audit kinds (lifecycle, signals, escalations, messages, proxy) survive. Seqs are never reused.
  pruneJournal(opts: { olderThanMs: number; keepPerAgent: number; kinds?: string[]; protectKinds?: string[] }): Promise<{ deleted: number }>;
  // Incremental usage totals per agent, maintained with each `usage` append (survives pruning).
  // Events with costMicros 0 and nonzero tokens add to the unpriced token sums so the caller
  // can apply a fallback price table.
  spendFor(agent: AgentId): Promise<JournalSpend>;
}

// High-volume kinds that retention may delete by default; everything else is audit.
export const JOURNAL_PRUNABLE_KINDS: readonly string[] = ["message", "tool_call", "tool_result", "usage"];

export interface JournalSpend {
  costMicros: number; // sum of costMicros over events that reported a cost
  unpricedInputTokens: number; // tokens of events with costMicros 0 and nonzero tokens
  unpricedOutputTokens: number;
  events: number;
}

interface NewAgentBase {
  id?: AgentId; // caller-chosen opaque id (e.g. the root supervisor); generated when omitted
  parent: AgentId | null;
  name: string;
  task: string;
  host: HostId;
  budgetMicros: number;
  idempotencyKey: string;
}

// `executor` defaults to "container" when omitted, so existing container callers are unchanged.
export type NewAgent = NewAgentBase & ({ executor?: "container"; spec: SpawnSpec } | { executor: "deterministic"; spec: DeterministicSpec });

// Every mutating call takes an idempotency key; repeating a key returns the original record
// and must not re-apply the mutation. This makes retried transitions and
// resumes safe: a repeat never double-applies a transition or double-bumps a generation.
export interface Registry {
  create(a: NewAgent): Promise<AgentRecord>;
  get(id: AgentId): Promise<AgentRecord | null>;
  // `excludeState` (optional) drops rows in that state; omitted = no exclusion. Reaped rows are never deleted, so a whole-table
  // list grows with agent history: passes that need no reaped rows pass `excludeState: "reaped"`.
  list(opts?: { parent?: AgentId; state?: AgentState; excludeState?: AgentState }): Promise<AgentRecord[]>;
  // Compare-and-set on generation; throws StaleGenerationError on mismatch and
  // IllegalTransitionError when the edge is not in LEGAL_TRANSITIONS. Repeating the
  // idempotency key returns the original record without re-applying the transition.
  // `resume: true` additionally allows the one resume edge exited->running (an unreaped child woken to
  // resolve a merge conflict). The caller bumps the generation first and
  // transitions at the new one; the edge clears `exit` and `result`. Without the flag exited->running stays illegal.
  transition(
    id: AgentId,
    generation: number,
    to: AgentState,
    opts: { exit?: ExitStatus; result?: unknown; exitCause?: ExitCause; resume?: true; idempotencyKey: string },
  ): Promise<AgentRecord>;
  // Repeating the idempotency key returns the original record without re-bumping the generation.
  bumpGeneration(id: AgentId, host: HostId, idempotencyKey: string): Promise<AgentRecord>;
  // Compare-and-set on generation like `transition` (throws StaleGenerationError on mismatch;
  // IllegalTransitionError is not involved). Records/clears the live sandbox id as sandboxes
  // start and stop. Idempotent by key (repeating a key returns the original record without
  // re-applying the write).
  // `backend` (optional) records the backend the sandbox is started under, before the provider call. The backend is pinned for as
  // long as the record holds a sandbox id: a different one against a recorded backend throws SandboxBackendMismatchError and
  // changes nothing, and clearing the sandbox (null) clears the backend too (null with a backend is a caller bug and throws).
  setSandbox(id: AgentId, generation: number, sandbox: SandboxId | null, idempotencyKey: string, backend?: SandboxBackendId): Promise<AgentRecord>;
  // Bump the agent's budgetMicros by deltaMicros (an approved budget raise). Idempotent by key: a replay
  // returns the original record without raising again. deltaMicros must be a positive safe integer;
  // anything else throws before the key lookup and mutates nothing.
  raiseBudget(id: AgentId, deltaMicros: number, idempotencyKey: string): Promise<AgentRecord>;
  // The operator's movement of a root's (parentless agent's) pool to `toMicros`, applied and journaled in ONE store transaction
  // (topup-atomic), so a crash never leaves a changed pool without its journal row. A raise journals a `budget_topup`; a
  // lowering journals a `budget_withdrawal` and takes at most the root's unheld remainder (core budgetLedger `remaining` of the
  // root: the pool minus what its children hold and its own settled and in-flight use); a larger one throws
  // RootWithdrawalError and changes nothing. Equal: no write, `entry` null. It is an absolute set, so it is idempotent by its
  // target: repeating it after it applied changes and journals nothing. `idempotencyKey` keys the journal row. `toMicros`
  // must be a non-negative safe integer and `id` a root, else it throws before any write.
  setRootPool(id: AgentId, toMicros: number, idempotencyKey: string): Promise<{ record: AgentRecord; entry: JournalEntry | null }>;
  // The provider retry ladder's durable count (SPEC rule 6; provider-attempts-durable): consecutive retryable provider errors
  // of an agent, carried across the backoff yields and resumes (each of which bumps the generation) and across a daemon
  // restart. `bumpProviderAttempts` adds one and returns the new count; idempotent by key (a replay returns the count it first
  // returned and adds nothing), so a caller keys it by agent and generation to count at most one error per generation.
  // `resetProviderAttempts` sets the count to 0 (a successful call, or the agent finished); an absolute set, so repeating it
  // is harmless. An unknown agent throws.
  bumpProviderAttempts(id: AgentId, idempotencyKey: string): Promise<number>;
  resetProviderAttempts(id: AgentId): Promise<void>;
}

export interface Mailbox {
  // `senderGeneration` is omitted for daemon-originated signals (cancel, timeout,
  // child_exited, budget_exceeded). An agent-originated `message` signal stamps the
  // sender's current generation, and implementations must reject with StaleGenerationError
  // when it no longer matches the registry (fences stale senders).
  // The send's idempotency key becomes the signal's id. LEVEL kinds (LEVEL_KINDS) coalesce: a send replaces
  // the agent's unconsumed signal of the same kind (latest wins; the survivor carries the new id) while every
  // other kind queues. A replayed key is a no-op and never resurrects a coalesced signal.
  send(to: AgentId, signal: Signal, idempotencyKey: string, senderGeneration?: number): Promise<void>;
  // Consumes the agent's queued signals. Idempotent by key: repeating a key returns the
  // signals already consumed by that call without consuming more.
  receive(agent: AgentId, idempotencyKey: string, opts?: { limit?: number }): Promise<Delivered[]>;
  peek(agent: AgentId): Promise<Delivered[]>;
  // Remove the given signals from the agent's mailbox without consuming the rest. Idempotent by key (a
  // replay returns the prior result), order-free (no contiguous-head rule); unknown or already-gone ids are a
  // no-op. Returns the ids that were actually removed by this call.
  ack(agent: AgentId, ids: SignalId[], idempotencyKey: string): Promise<SignalId[]>;
}

export interface CheckpointStore {
  // Fenced: rejects with StaleGenerationError when c.generation is below the agent's registry
  // generation (a superseded writer). Idempotent by key. Rows hold ids and hashes only, never a path.
  // The store stamps `version` (CHECKPOINT_FORMAT); callers never supply it.
  write(c: Omit<Checkpoint, "id" | "createdAt" | "version">, idempotencyKey: string): Promise<Checkpoint>;
  latest(agent: AgentId): Promise<Checkpoint | null>;
  read(id: CheckpointId): Promise<Checkpoint | null>;
}

// Content-addressed session-file bytes. `put` is idempotent by content —
// the returned ref is the sha256 hex of the bytes — so it needs no idempotency key.
// `ref` is what Checkpoint.sessionRef stores; bytes must be retrievable after the
// worktree is gone.
export interface SessionStore {
  put(session: Uint8Array): Promise<string>;
  get(ref: string): Promise<Uint8Array | null>;
}

// Durable store for agent-published static reports (files), distinct from CheckpointStore
// (resume records, ids/hashes only) and Workspace (git). `write` is idempotent by the deterministic report id
// (content addressing) and fenced against the agent's generation like CheckpointStore.write.
export interface ReportStore {
  write(r: NewReport, idempotencyKey: string): Promise<Report>; // idempotent by r.id; rejects stale generations
  list(agent: AgentId): Promise<Report[]>; // newest first
  read(agent: AgentId, id: ReportId): Promise<{ report: Report; content: Uint8Array } | null>;
  remove(agent: AgentId, id: ReportId): Promise<boolean>; // operator delete; TODO(cleanup): no automatic report GC sweep yet
}

// Durable store for escalations (human asks). Idempotent by escalation id/key and fenced
// against the asker's generation like CheckpointStore.write.
export interface EscalationStore {
  // Idempotent by e.id/key; rejects a stale asker generation (StaleGenerationError), like CheckpointStore.write.
  create(e: NewEscalation, idempotencyKey: string): Promise<Escalation>;
  get(id: EscalationId): Promise<Escalation | null>;
  list(opts?: { agent?: AgentId; state?: EscalationState }): Promise<Escalation[]>;
  // First answer wins; idempotent (replays return the stored answer without re-applying).
  answer(id: EscalationId, answer: string, by: MessagingSender, idempotencyKey: string): Promise<Escalation>;
  // Move a bubbled ask to its next holder (null = the user via root) and hop window (undefined clears it). Idempotent by
  // key; an answered ask is returned unchanged; an unknown id throws.
  advance(id: EscalationId, holder: AgentId | null, hopDeadlineAt: number | undefined, idempotencyKey: string): Promise<Escalation>;
}

// Durable store for gated-action approvals: the single record type every gated action
// (extension calls, publish, budget raises, egress, spawn limits, chat-initiated spawn/cancel,
// human asks) routes through. Decisions are applied through the pure `approval` policy table:
// deny is final; abstain/escalate/timeout advance a rung; past the top rung the result is deny
// (fail closed); approver rank must strictly exceed requester rank.
// `deadlineAt` is the current rung's fail-closed deadline; the timeout driver calls `timeout`
// when it fires, and re-arms its own timer on each advanced rung (the store does not re-arm).
export interface ApprovalStore {
  // Idempotent by a.id/key; rejects a stale requester generation (StaleGenerationError) when
  // the requester is an agent. The escalation ladder is derived from the requester's rank.
  create(a: NewApproval, idempotencyKey: string): Promise<Approval>;
  get(id: ApprovalId): Promise<Approval | null>;
  // `unnotified`: only records whose decision has not been marked delivered (markNotified); a pending record never is.
  list(opts?: { requester?: string; state?: ApprovalState; unnotified?: boolean }): Promise<Approval[]>;
  // Record an approver's decision at the current rung. Idempotent by key (a replay returns
  // the stored result without re-applying). Rejects an approver whose rank does not exceed
  // the requester's. Decisions on a settled record are a no-op returning the stored record.
  decide(id: ApprovalId, d: NewApprovalDecision, idempotencyKey: string): Promise<Approval>;
  // Advance the current rung when its deadline passed with no approver (fail-closed timeout).
  // Idempotent by key. Journaled as a `timeout` decision by no one (who is null).
  timeout(id: ApprovalId, idempotencyKey: string): Promise<Approval>;
  // Record that a settled record's decision reached its requester (or needs no delivery), so the reconcile sweep stops
  // re-sending it. Sets `notifiedAt` once; a repeat (any key) keeps the first stamp. A pending record is rejected: a
  // decision that does not exist yet cannot have been delivered. Unknown id rejects.
  markNotified(id: ApprovalId, idempotencyKey: string): Promise<Approval>;
}

// Durable store for cron schedules. `lastFired` is the restart-safe cursor that lets the
// cron driver compute missed runs without keeping any schedule state in daemon memory.
// The pure scheduling policy lives in `@pomtree/sched`.
export interface ScheduleStore {
  // Create (stamping createdAt) or replace an existing schedule by id, preserving its
  // original createdAt (and its breaker fields). Repeating the idempotency key returns the original result.
  upsert(s: Omit<Schedule, "createdAt">, idempotencyKey: string): Promise<Schedule>;
  remove(id: ScheduleId): Promise<boolean>;
  get(id: ScheduleId): Promise<Schedule | null>;
  list(): Promise<Schedule[]>;
  // Pause/resume a schedule without removing it (a paused schedule never fires). Returns the
  // updated schedule, or null when unknown. Idempotent by key. `upsert` preserves `paused`
  // unless the new value sets it.
  setPaused(id: ScheduleId, paused: boolean, idempotencyKey: string): Promise<Schedule | null>;
  // Durable cron breaker: count one more consecutive failure and set `retryAt`; null when unknown.
  // `clearFailures` resets both after a success; `setPaused(id, false)` also clears them.
  recordFailure(id: ScheduleId, retryAt: number, idempotencyKey: string): Promise<Schedule | null>;
  clearFailures(id: ScheduleId, idempotencyKey: string): Promise<void>;
  // Mark a targeted schedule whose agent exited as orphaned (it stops firing). Idempotent by key; null when
  // unknown. `upsert` (a retarget or replace) clears it.
  setOrphaned(id: ScheduleId, idempotencyKey: string): Promise<Schedule | null>;
  lastFired(id: ScheduleId): Promise<number | null>; // null = never fired
  setLastFired(id: ScheduleId, at: number, idempotencyKey: string): Promise<void>;
}

// Durable watchdog ladder position per agent (see WatchdogState in types.ts). Keeps the
// escalation ladder across restarts, since the daemon keeps no state in memory.
export interface WatchdogStore {
  get(agent: AgentId): Promise<WatchdogState | null>;
  set(agent: AgentId, state: WatchdogState, idempotencyKey: string): Promise<WatchdogState>;
  clear(agent: AgentId): Promise<void>;
}

export interface EgressTarget {
  host: string;
  port?: number; // defaults to 443
}

export interface SandboxEgress {
  allow: EgressTarget[]; // matching a target never grants private-network access; only an explicit relay does
  // Exact controller endpoints only. Does not override hard metadata/link-local/loopback/etc denial.
  relay?: EgressTarget[];
  // Presence enables public destinations AND requires durable auditing. Immutable spawning-record attribution.
  auditedPublic?: { host: HostId; generation: number };
}

// What an agent sees at a container path, named by id and resolved per host by a MountProvider. A spawn names mounts, never paths, except `bind`.
interface MountBase {
  containerPath: string;
  readOnly?: boolean;
  generation?: number; // the agent generation the mount was granted to (fencing)
  quotaBytes?: number;
}

export type MountSpec =
  | (MountBase & { kind: "workspace"; workspace: WorkspaceId }) // the agent's clone folder (one writer, one generation)
  | (MountBase & { kind: "session"; agent: AgentId }) // harness session and event sink directory
  | (MountBase & { kind: "scratch"; sizeBytes?: number }) // per-container tmpfs
  | (MountBase & { kind: "bind"; hostPath: string }); // operator-only escape hatch; remote nodes refuse it

export type ResolvedMount =
  | { type: "bind"; hostPath: string; containerPath: string; readOnly: boolean }
  | { type: "tmpfs"; containerPath: string; sizeBytes?: number };

// Resolves a MountSpec to a host realization on one node. Host paths exist only on this side of the
// port and never enter a journal row, checkpoint or API response. Rejects on
// ENOSPC, a stale handle, or a revoked mount.
export interface MountProvider {
  resolve(agent: AgentId, mount: MountSpec): Promise<ResolvedMount>;
}

export interface SandboxSpec {
  agent: AgentId; // labels the sandbox so reconciliation can map it back to an agent
  image: string; // pinned digest
  env: Record<string, string>;
  mounts: MountSpec[]; // the mount of kind "workspace" is the working directory
  cmd?: string[];
  resources?: Resources;
  // The template's opaque adapter block (Template.runtime); the adapter validates and realizes it.
  runtime?: Readonly<Record<string, unknown>>;
  egress?: SandboxEgress; // default-deny when present
  // Extra ownership labels stamped on the sandbox (e.g. daemon_epoch, store_id) so reconcile can
  // tell which daemon/epoch owns it; returned by list(). Keys: [A-Za-z0-9_.-], must not start
  // with "pomtree" (reserved). Optional/additive.
  labels?: Record<string, string>;
  // Start with a TTY and stdin open (`-it` equivalent) so a terminal can be attached via
  // the terminal facet. cols/rows is the initial size (best effort; 80x24 until sized). Unset keeps
  // the plain non-TTY container.
  tty?: { cols: number; rows: number };
}

// How a sandbox ended. "expired" = the provider lifetime or lease ran out; "preempted" = the provider reclaimed it. Both are
// distinguishable from an agent exit so the daemon resumes instead of failing (exit code null for those two).
// TODO(exit-reason-wiring): wait() still returns { exitCode: number; oomKilled?: boolean } and no caller passes `reason` to classifyExit;
// pending: widening wait() to report the reason, the daemon passing it through, and reconciling with the fake's SandboxUnavailableError rejection.
export type SandboxExitReason = "exited" | "oom" | "killed" | "expired" | "preempted";

export interface SandboxHandle {
  id: SandboxId;
  output(): AsyncIterable<{ stream: "stdout" | "stderr"; chunk: string }>;
  wait(): Promise<{ exitCode: number; oomKilled?: boolean }>;
}

// Why a terminal stream ended: "local" = close() was called, "remote" = the container exited, the
// detach key was typed, or the peer closed, "error" = the stream broke (`error` is set).
export interface TerminalClose {
  reason: "local" | "remote" | "error";
  error?: Error;
}

// A raw bidirectional byte stream; TerminalSession extends it with resize/redraw. It does NOT assume a full-duplex socket: an
// adapter may realise write() as separate provider input calls and output() as a provider output stream (Sail, Vercel,
// Cloudflare, Daytona sessions), multiplexing frames over that pair.
export interface ByteChannel {
  // Resolves once the bytes are accepted by the transport (waits for drain under backpressure);
  // rejects if the channel is closed.
  write(data: Uint8Array | string): Promise<void>;
  // Raw output, bounded by transport backpressure (never dropped). Single consumer: calls
  // share one queue. Ends when the stream closes; throws if it broke.
  output(): AsyncIterable<Uint8Array>;
  // Detach. Idempotent.
  close(): void;
  closed: Promise<TerminalClose>;
}

// A bidirectional raw byte stream to a TCP port on a sandbox's own loopback, carried over the container runtime's exec channel
// (no port is published). Closing ends only this stream; the container keeps running. Several streams may be open on one sandbox.
export interface ByteStream {
  // Resolves once the bytes are accepted by the transport (waits for drain under backpressure);
  // rejects if the stream is closed.
  write(data: Uint8Array): Promise<void>;
  // Bytes from the port, bounded by transport backpressure (never dropped). Single consumer: calls share one queue. Ends when
  // the stream closes; throws if it broke.
  output(): AsyncIterable<Uint8Array>;
  // Close this stream. Idempotent.
  close(): void;
  closed: Promise<TerminalClose>;
}

// The loopback ports the loopback facet may open: the image's LOOPBACK_PORTS.
export type LoopbackPort = (typeof LOOPBACK_PORTS)[number];

// A bidirectional raw-byte terminal stream attached to a TTY sandbox. Closing only detaches; the
// container keeps running. Several sessions may be open on one sandbox.
export interface TerminalSession extends ByteChannel {
  // Resizes the pty. No-op once closed; rejects if the engine refuses.
  resize(cols: number, rows: number): Promise<void>;
  // Forces a full-screen redraw by nudging the size (cols+1, then back) at the last known size;
  // rejects if no size is known yet (open with a size or call resize first).
  redraw(): Promise<void>;
}

// Named channels into a sandbox: the address is a name, never a port, because exec-based providers have no port namespace and
// Docker already addresses these as named unix sockets.
export type SandboxChannel = "daemon-api" | "egress" | "egress-browser" | "workspace";

// What a readiness probe found. It may only narrow the declaration (see checkProbe).
export interface ProbeResult {
  withheld: SandboxCapability[]; // capabilities declared true but unavailable now (plan, quota, runtime block)
  problems: { code: string; cause: string; action: string }[]; // readiness failures: unreachable engine, bad credential, image missing
  account: string | null; // opaque hash of the provider-reported account id (never a credential); null for local engines
}

// Which daemon owns a sandbox: the host, the store and the epoch it stamps on what it creates.
export interface SandboxOwner {
  host: HostId;
  storeId: string;
  epoch: number;
}

export interface SandboxListing {
  id: SandboxId;
  agent: AgentId;
  backend: SandboxBackendId;
  host: HostId | null;
  generation: number | null; // null host/generation = untagged or foreign: never adopted, reported only
  state: "creating" | "running" | "paused" | "stopped" | "exited" | "unknown";
  labels?: Record<string, string>; // echoes SandboxSpec.labels (omitted when none)
}

// Image identity = the engine-local image id (what the daemon compares at start and what checkpoints pin to) plus the canonical OCI
// config digest and org.opencontainers.image.revision. Manifest digests and provider templates are derived ImageArtifact records
// keyed by configDigest. image.digestAttest = the adapter can report the engine-local id itself; without it, imageIdentity throws
// SandboxCapabilityError and the daemon resolves identity from the registry.
export interface ImageIdentity {
  // The content-addressed local id the owning engine reports: equals the config digest on a classic Docker store and on Podman; the
  // index/manifest digest on Docker with the containerd store. Needs no `docker save`.
  engineLocalId: string;
  // "sha256:<hex>"; canonical and portable across engines and registries. null = the engine cannot attest it at runtime (Docker with the
  // containerd store).
  // TODO(image-config-digest): fill the digest from the image build record and decide the artifact key when it is null; current behavior: null on the
  // containerd store, and checkpoints pin the engine-local id. The `egressProxyImage` comments in sandbox-docker's docker.ts and pomtreed's
  // safety-boot.ts move to the build-line wording with it.
  configDigest: string | null;
  revision: string | null; // org.opencontainers.image.revision (the key across builds); null = label absent
}

// A derived artifact of one canonical image, keyed by configDigest: a registry manifest, a provider template, or a provider
// snapshot used as an image. Images are built in OCI format (a docker-format image converted to OCI changes its config digest);
// the build fails closed if no source yields the config digest.
export interface ImageArtifact {
  configDigest: string; // canonical identity, "sha256:<hex>"
  revision: string | null; // OCI revision label
  engineLocalId: string | null; // as ImageIdentity; null when not engine-local
  providerImage?: string; // derived artifacts only: provider template, snapshot or registry ref; never a local path
  sourceConfigDigest?: string; // set only when pomtree converted the format; layer diff_ids must match the source
  backend: SandboxBackendId | null; // null for a registry artifact usable by any backend
  hostId: HostId;
  generation: number; // SPEC rule 2
  idempotencyKey: string; // the key of the call that produced it
}

// The durable record of derived images, one row per (configDigest, backend). Rows hold ids and digests, never local paths.
export interface ImageArtifacts {
  // Idempotent by `a.idempotencyKey` with a fingerprint of the whole artifact: a replay of the same artifact returns the stored one
  // with no second row, a different artifact under the same key throws IdempotencyConflictError and changes nothing. A write whose
  // generation is below the stored row's for the same (configDigest, backend) throws StaleGenerationError; an equal or higher one
  // replaces the row. Throws on an invalid artifact (bad digest, path-looking reference).
  put(a: ImageArtifact): Promise<ImageArtifact>;
  // The exact (configDigest, backend) row, or null; a null backend reads the registry artifact only. Throws if the stored row is invalid.
  get(configDigest: string, backend: SandboxBackendId | null): Promise<ImageArtifact | null>;
}

export interface SnapshotRef {
  id: SnapshotId;
  backend: SandboxBackendId;
  memory: boolean;
  sha256?: string; // when the provider exposes a content hash (checkpoints hold ids and hashes)
}

// Optional capabilities, each gated by SandboxDeclaration.capabilities. A facet is present iff at least one of its capabilities in
// FACET_OF is declared true; call sites obtain one through `need`, never by testing the property ad hoc.
export interface SandboxFacets {
  // Attach a terminal stream to a running sandbox that was started with SandboxSpec.tty. Throws
  // SandboxUnavailableError when the sandbox is not running (or the engine is unreachable).
  // `size` resizes the pty right after attaching (and seeds redraw()).
  terminal?: { open(id: SandboxId, size?: { cols: number; rows: number }): Promise<TerminalSession> };
  // Open a byte stream to `port` on the running sandbox's own loopback, with no port published. Throws SandboxUnavailableError when
  // the sandbox is not running (or the engine is unreachable) and RangeError for a port outside LOOPBACK_PORTS, also at run time.
  loopback?: { open(id: SandboxId, port: LoopbackPort): Promise<ByteStream> };
  // Carries the daemon API, the egress proxies and the workspace bundle. Docker realises each channel as its existing named unix socket.
  connect?: { open(id: SandboxId, channel: SandboxChannel): Promise<ByteChannel> };
  files?: {
    // Path is sandbox-absolute; body is a tar stream; the adapter verifies sha256 end to end and throws SandboxTransferError on
    // mismatch or partial upload. Idempotent by key.
    put(id: SandboxId, path: string, body: AsyncIterable<Uint8Array>, sha256: string, idempotencyKey: string): Promise<void>;
    get(id: SandboxId, path: string, maxBytes: number): Promise<{ body: AsyncIterable<Uint8Array>; sha256: Promise<string> }>;
  };
  snapshots?: {
    create(id: SandboxId, opts: { memory: boolean }, idempotencyKey: string): Promise<SnapshotRef>;
    start(from: SnapshotRef, spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle>; // also "fork" when called twice with distinct keys
    remove(ref: SnapshotRef, idempotencyKey: string): Promise<void>;
  };
  lease?: { extend(id: SandboxId, untilMs: number, idempotencyKey: string): Promise<{ untilMs: number }> };
  pause?: {
    pause(id: SandboxId, idempotencyKey: string): Promise<void>;
    resume(id: SandboxId, idempotencyKey: string): Promise<void>;
  };
  // image.template: build the provider-side template for an image; returns the provider artifact ref recorded as a derived
  // ImageArtifact keyed by configDigest.
  images?: { prepare(ref: string, identity: ImageIdentity, idempotencyKey: string): Promise<{ providerImage: string }> };
}

export interface Sandbox extends SandboxFacets {
  // Static, exhaustive and readable offline; the daemon admits or refuses the backend from it (admitBackend).
  readonly declaration: SandboxDeclaration;
  // Readiness and runtime narrowing for an optional template runtime block. A probe may only narrow the declaration (checkProbe).
  probe?(runtime?: SandboxSpec["runtime"]): Promise<ProbeResult>;
  // Inspect or, only after explicit approval, commit remaining workspace changes and return a
  // bundle for the controller's normal quarantined ingest. Git runs inside the sandbox only.
  // A changed fingerprint returns the current state without mutation or a bundle.
  // `maxBytes` caps the collected bundle (the resolved push.maxBytes); an adapter refuses a larger one, never truncates it.
  resultWork(
    id: SandboxId,
    opts: { save?: boolean; expectedFingerprint?: string; maxBytes: number },
  ): Promise<{ dirty: boolean; fingerprint: string; bundle?: AsyncIterable<Uint8Array> }>;
  // When spec.egress is present the adapter MUST default-deny all network except
  // egress.allow and MUST throw if it cannot enforce it. Idempotent by key: repeating
  // the same key returns the same handle without starting a second container.
  // Throws SandboxOutcomeUnknownError when the create times out with no reply.
  start(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle>;
  // Re-adopt an existing live container (by sandbox id) after a daemon restart, so a
  // restarted daemon can finish/drain a checkpoint-less agent. output() derives from the
  // container's logs and wait() from its exit. Throws SandboxUnavailableError when the
  // container is not running.
  attach(id: SandboxId, agent: AgentId): Promise<SandboxHandle>;
  // "Already gone" is success; the key only deduplicates journaling.
  stop(id: SandboxId, graceMs: number, idempotencyKey: string): Promise<void>;
  kill(id: SandboxId, idempotencyKey: string): Promise<void>;
  // `status` (optional) is the container runtime's own state string (Docker: created, running, paused, restarting, removing,
  // exited, dead); a sandbox whose exit the adapter observed before it was removed reports "exited". `running: false` alone
  // does not tell a created container from an exited one, so a consumer deciding whether a container holds memory must
  // treat an absent or unrecognized status as "may hold memory". null = no such sandbox.
  inspect(id: SandboxId): Promise<{ running: boolean; exitCode: number | null; oomKilled?: boolean; status?: string } | null>;
  // Used by startup reconciliation: the sandboxes this owner's daemon may have created, with host and generation so reconcile can
  // fence by generation. Required on every backend; `list.byTag` only means the filter runs server-side.
  list(owner: SandboxOwner): Promise<SandboxListing[]>;
  // Reclaim any adapter-side resource this daemon owns that no live sandbox uses (Docker: egress proxies/socket volumes whose
  // sandbox container no longer exists, a crash between egress setup and `run`; hosted: orphaned volumes, snapshots or templates).
  // Only resources owned by `owner` (its store id, an epoch not newer than its own) are candidates; another daemon's, an unlabelled
  // one, or an adapter with no owner configured is left alone.
  // Returns the reclaimed sandbox ids. Call at startup, before spawns begin (it cannot tell an orphan from a start in flight).
  reclaim(owner: SandboxOwner): Promise<SandboxId[]>;
  // Resolve an image reference (tag or digest) to its canonical identity, so a checkpoint records the exact image.
  imageIdentity(ref: string): Promise<ImageIdentity>;
}

// Why an ingest was refused. The mirror is untouched on every failure.
export type IngestFailCode =
  | "too_large"
  | "bad_bundle"
  | "prerequisite"
  | "bad_ref"
  | "unsafe_path"
  | "symlink"
  | "submodule"
  | "git_version"
  | "non_fast_forward"
  | "unknown";
export type PruneResult = "pruned" | "nothing" | "refused";

// A ref a forced ingest moved to a commit that does not descend from it. `from` is the overwritten tip: the only record of
// it, since the ref itself no longer names it. Shaped so `forced` cannot appear without it, which is what made a forced
// push silent before: the flag was journaled and the overwritten commit was not.
export interface ForcedRefUpdate {
  ref: string;
  from: string; // the tip the ref held before the force (unreachable from `to`)
  to: string;
}

export type IngestResult =
  // the refs/agents/<id>/heads/* refs written
  | { ok: true; refs: { ref: string; commit: string }[]; forced?: undefined; forcedFrom?: undefined }
  // `force` moved at least one ref to a non-descendant; `forcedFrom` names every such ref with the tip it overwrote
  | { ok: true; refs: { ref: string; commit: string }[]; forced: true; forcedFrom: ForcedRefUpdate[] }
  | { ok: false; code: IngestFailCode; message: string };

// Each agent works in a private full clone (own objects, refs and config, no remote, no credentials)
// on node-local disk. The controller runs git inside a clone only on a fork copy it has sanitised first; otherwise work crosses only as a bundle
// through `ingest` (quarantined, verified) into the controller's mirror, and back through `serve`.
// `workspace` is the opaque id of the folder (stable across restarts, never a path); the
// MountProvider resolves it.
export interface Workspace {
  // Private full clone at `fromCommit` (default: the mirror's default branch tip). `commit` is the
  // base commit, always present in the mirror. Repeating `create` for an existing folder returns the same id.
  create(agent: AgentId, opts: { fromCommit?: string }): Promise<{ branch: string; commit: string; workspace: WorkspaceId }>;
  // Child folder = byte copy of the STOPPED parent folder (untracked and ignored files included, symlinks copied
  // as links), sanitised, then git runs in that copy only to put it on the child's own branch. `commit` is the parent's base commit (the child's bundle prerequisite).
  fork(parent: AgentId, child: AgentId): Promise<{ branch: string; commit: string; workspace: WorkspaceId }>;
  has(agent: AgentId): Promise<boolean>; // the folder exists on this node
  list(): Promise<AgentId[]>; // folders on this node (startup reconciliation)
  evict(agent: AgentId): Promise<void>; // deletes the folder; idempotent. The mirror's refs for the agent are kept.
  // Streams `bundle` to a capped temp file and verifies it in a quarantine; only on full success are
  // refs written into the mirror as refs/agents/<id>/heads/<name>. Idempotent for the same bundle.
  // Fast-forward only: a new tip must descend from the ref's current tip, else `non_fast_forward` (the message
  // names the ref; mirror untouched), so a stale push cannot erase the controller's merge commit. `force: true`
  // allows a non-descendant update and returns `forced: true` with `forcedFrom` naming the overwritten tips; the caller
  // journals both. `force` is an operator-only capability: Daemon.push refuses it for an agent credential.
  ingest(agent: AgentId, bundle: AsyncIterable<Uint8Array>, opts: { maxBytes: number; force?: boolean }): Promise<IngestResult>;
  // Newest ingested ref by ingest order, persisted in the mirror (not memory); null when none.
  ingested(agent: AgentId): Promise<{ ref: string; commit: string } | null>;
  // A full bundle from the mirror for `pomtree pull`: the default branch plus refs/agents/<scope>/heads/*
  // (scope defaults to `agent`; the daemon authorizes self or descendant).
  serve(agent: AgentId, opts?: { scope?: AgentId }): Promise<AsyncIterable<Uint8Array>>;
  // Pins an ingested ref to a commit for publish approval. Rejects a ref outside the agent's namespace.
  // `paths` is the NFC-normalized, sorted list of changed files (same base as the diffstat) for publish-time flagging.
  resolve(agent: AgentId, ref: string): Promise<{ commit: string; diffstat: string; subject: string; paths: string[] }>;
  // Pushes exactly `commit` from the mirror to `remote`:`target`. Refuses a commit not reachable from the agent's refs.
  publish(agent: AgentId, push: { commit: string; remote: string; target: string }): Promise<void>;
  // Deletes the agent's mirror refs only when their tips are ancestors of `mergedInto`'s ref, so
  // un-merged work is never lost. "pruned": refs deleted. "nothing": the agent has no refs (never ingested, or already pruned),
  // so a replay after a crash reads "nothing". "refused": refs remain because a tip is not merged, the target has no refs, or
  // the agent is the target; a later call may succeed.
  prune(agent: AgentId, opts: { mergedInto: AgentId }): Promise<PruneResult>;
}

export interface HarnessSession {
  session: SessionId;
  events(): AsyncIterable<HarnessEvent>;
  steer(message: string): Promise<void>;
  stop(): Promise<void>;
}

export interface Harness {
  start(opts: { agent: AgentId; sandbox: SandboxHandle; prompt: string }): Promise<HarnessSession>;
  resume(opts: { agent: AgentId; sandbox: SandboxHandle; sessionRef: string; wake: string }): Promise<HarnessSession>;
}

export interface ModelGateway {
  // `idempotencyKey`: repeating a key returns the same key without re-issuing.
  issueKey(agent: AgentId, budgetMicros: number, idempotencyKey?: string): Promise<{ key: string; baseUrl: string }>;
  spend(agent: AgentId): Promise<{ spentMicros: number; budgetMicros: number }>;
  revoke(agent: AgentId): Promise<{ unusedMicros: number }>;
  // The agent's hierarchical ledger position from the spend authority (DurableModelDebitStore.ledgerFor). Absent: the daemon
  // computes the same ledger (budgetLedger) from the registry and `spend`.
  ledger?(agent: AgentId): Promise<AgentLedger>;
  // usage-join: the settled call of `agent` that carried the provider response id `responseId` (DurableModelDebitStore
  // .settledCall). Absent without a debit store; the daemon then joins on the journaled settlements by the same id.
  settledCall?(agent: AgentId, responseId: string): Promise<{ requestId: string; chargedMicros: number } | null>;
  // Informational catalog price (micros) for a usage event the provider reported at zero cost, so the
  // journal can carry a per-event estimate. Null when no catalog is wired, the event names no model, or
  // the model is unknown — the caller then journals the event unpriced. Never authoritative: the proxy
  // debit store is the spend ledger.
  priceUsage?(usage: { model?: string; inputTokens: number; outputTokens: number }): Promise<number | null>;
}

// TODO(capability-caveats): bind generation and route-set caveats into the HMAC credential. Current behavior: it signs agent,
// budget, expiry, issuance stamp, id and model allowlist only.
// A short-lived, signed bearer credential for the controller-side model proxy. It carries the
// agent's budget and expiry but never the upstream provider credential. The proxy verifies it
// before forwarding; a container can use it only through the controller proxy.
export interface GatewayCredential {
  agent: AgentId;
  budgetMicros: number;
  expiresAt: number;
  // Durable logical issuance stamp (ms): a revocation kills every credential with issuedAt at or before its
  // cutoff, and a resumed issue is stamped after it. Under a backward clock or a restart it may exceed the
  // wall clock and even expiresAt; expiresAt alone is the wall-clock expiry authority.
  issuedAt: number;
  id: string;
  // The model ids this credential may call, signed into the token. Fail closed: an empty list allows no model. The gateway
  // issues it from the agent's resolved model; the proxy refuses any other model with `model_not_allowed`.
  models: readonly string[];
}

const encodeCredentialPayload = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function signCredential(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function encodeGatewayCredential(secret: string, credential: GatewayCredential): string {
  const payload = encodeCredentialPayload(credential);
  return `pg1.${payload}.${signCredential(secret, payload)}`;
}

// Why a presented credential is not usable. `invalid`: malformed, wrong version, bad signature or a payload that does not
// validate. `expired`: correctly signed and well formed, but `expiresAt <= now`. Only a token whose signature verifies can be
// `expired`, so the distinction tells the holder nothing it could not read from its own token. A durable store adds `revoked`
// (see DurableModelDebitStore.checkCredential).
export type GatewayCredentialRejection = "invalid" | "expired";

export type GatewayCredentialCheck = { ok: true; credential: GatewayCredential } | { ok: false; reason: GatewayCredentialRejection };

// The error code the model proxy returns (401) for an expired credential, so a harness can tell "issue a fresh key" from
// "this key is wrong". Every other unusable credential (invalid or revoked) keeps MODEL_PROXY_INVALID_CREDENTIAL.
export const MODEL_PROXY_CREDENTIAL_EXPIRED = "credential-expired" as const;
export const MODEL_PROXY_INVALID_CREDENTIAL = "invalid-credential" as const;

// decodeGatewayCredential with the reason a token was refused. Same validation, same order: the signature is verified before
// the payload is trusted, and expiry is judged last.
export function verifyGatewayCredential(secret: string, token: string, now = Date.now()): GatewayCredentialCheck {
  const invalid = { ok: false, reason: "invalid" } as const;
  const [version, payload, mac, ...extra] = token.split(".");
  if (version !== "pg1" || !payload || !mac || extra.length !== 0) return invalid;
  const expected = signCredential(secret, payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return invalid;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return invalid;
    const c = parsed as Partial<GatewayCredential>;
    const { agent, budgetMicros, expiresAt, issuedAt, id, models } = c;
    if (
      typeof agent !== "string" ||
      typeof budgetMicros !== "number" ||
      !Number.isSafeInteger(budgetMicros) ||
      budgetMicros < 0 ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      typeof id !== "string" ||
      !/^[a-f0-9]{32}$/.test(id) ||
      !Array.isArray(models) ||
      !models.every((m) => typeof m === "string" && m.length > 0)
    )
      return invalid;
    if (expiresAt <= now) return { ok: false, reason: "expired" };
    return { ok: true, credential: { agent, budgetMicros, expiresAt, issuedAt, id, models: [...models] } };
  } catch {
    return invalid;
  }
}

// The credential, or null for any refusal (invalid or expired); verifyGatewayCredential says which.
export function decodeGatewayCredential(secret: string, token: string, now = Date.now()): GatewayCredential | null {
  const r = verifyGatewayCredential(secret, token, now);
  return r.ok ? r.credential : null;
}

// Validation shared by the debit store's implementations so the request-id and micros rules cannot
// drift between the in-memory primitive, the durable store, and the test fake.
export function validDebitMicros(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validDebitRequestId(value: string): boolean {
  return value.length > 0 && value.length <= 256;
}

export interface RequestReservation {
  readonly agent: AgentId;
  readonly credentialId: string;
  readonly requestId: string;
}

export type ReserveResult =
  | { ok: true; reservation: RequestReservation; remainingMicros: number }
  | { ok: false; reason: "invalid-credential" | "invalid-request" | "budget-exhausted" | "idempotency-conflict" };

// `expiredCharged: true` marks a settle that landed after `expireReservations` had already charged the whole reservation
// (fail-closed): `chargedMicros` is that charge plus any true overage topped up now, not the amount this call passed. A
// proxy can tell a late settle from a normal one by it. Absent on every other ok result (a settle replay of a settled row
// included). An implementation without expiry never sets it.
export type SettleResult =
  | { ok: true; chargedMicros: number; remainingMicros: number; expiredCharged?: true }
  | { ok: false; reason: "unknown-reservation" | "invalid-charge" };

// Controller-side hard-cap primitive behind the model proxy. `reserve` must atomically verify the
// signed credential, reject a durable revocation, and reserve the agent-wide cap; a durable
// implementation must make that one transaction. Accounting is per agent (not per token) so a
// refreshed or concurrently used credential cannot multiply spend authority. In-flight reservations
// are unaffected by a later revocation: `settle` and `cancel` never consult it.
export interface AgentLedger {
  budgetMicros: number;
  committedMicros: number;
  remainingMicros: number;
  overageMicros: number;
}

export interface ModelDebitStore {
  reserve(key: string, requestId: string, maximumMicros: number): ReserveResult;
  settle(reservation: RequestReservation, chargedMicros: number): SettleResult;
  cancel(reservation: RequestReservation): boolean;
  // Marks an in-flight reservation alive (the proxy calls it as response bytes arrive), so a durable store's
  // expireReservations measures idleness, not duration: a long healthy stream is never expire-charged mid-flight. False when
  // the reservation is not in flight. Optional: a store without it expires by reservation age.
  touch?(reservation: RequestReservation): boolean;
}

// Per-call metadata the debit ledger keeps beside the charge (see DurableModelDebitStore.recordCall). Token counts are as
// the provider reported them. For the Anthropic shape `tokensIn` EXCLUDES cache tokens (it is `input_tokens`); for the OpenAI
// shape it is `prompt_tokens`, which includes cached tokens. The charge is cost = f(tokensIn, tokensOut, cacheReadTokens,
// cacheWriteTokens) per the rate table, so a call's cost is explained by all four. OpenAI reports no cache write count.
// `route` is the closed class of the request path (never the raw path); `errorClass` names why a call failed: on a call that
// produced nothing billable (non-2xx, redirect, transport error, timeout, abort), on a 2xx charged the whole reservation
// because its body was unusable (`malformed_response`, `response_too_large`), and on a 2xx stream that carried an in-stream
// error (`stream_error`). Absent on a clean call.
export interface ModelCallMeta {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  upstreamStatus?: number;
  latencyMs?: number;
  finishReason?: string;
  route?: ModelCallRoute;
  errorClass?: ModelCallErrorClass;
  // The provider's own response id (Anthropic `msg_...`, OpenAI `chatcmpl-...` / `resp_...`), when the body carried one.
  // The daemon joins a harness usage event to this call on it (exact match, never by token counts).
  responseId?: string;
  // Where the call's charge came from (ModelPriceBasis). Present on every call that was billed (settlement "priced", "estimated"
  // or "reserve"), absent on a "failed" one: nothing billable was produced, so nothing was priced.
  basis?: ModelPriceBasis;
}

// Closed classes the model proxy stamps on a call: which API surface it hit, and why a failed call failed.
export type ModelCallRoute = "messages" | "chat_completions" | "other";
// Where a charge came from. "reported": the provider's own cost field, charged as reported; the provider's own figure was used, and
// for a genuine free call that figure is 0 (a 0 charge with basis "reported" is a free call, not a missing basis). A reported cost of
// 0 counts only when the call's token counts are zero or absent; a 0 cost on nonzero tokens (or a malformed count) means an unpriced
// model, so it is "catalog" instead. "catalog": the local rate card applied to the provider's reported token counts. "estimated": the
// byte-size fallback for a 2xx with no usable usage. "reserve": the whole reservation charged, fail closed.
export type ModelPriceBasis = "reported" | "catalog" | "estimated" | "reserve";
// The error classes, the one definition (the type is derived from it). By HTTP status: not_found 404, auth_rejected 401/403,
// insufficient_funds 402, rate_limited 429, bad_request 400/413/422, redirect 3xx, else upstream_4xx / upstream_5xx. By a
// thrown fetch error's `cause.code` (never its message): dns, connect (refused, reset, unreachable), tls, timeout (also the
// proxy's own deadline), aborted (any other abort), else transport. By a 2xx body: malformed_response (no usable usage,
// empty or unpriceable), response_too_large (over the proxy's body cap), stream_error (an SSE stream that reported an error),
// stream_cut (a 2xx body cut off mid-stream: reset, idle or body timeout, abort after headers; charged, never cancelled). Refused
// by the proxy before forwarding: model_not_allowed (the request names a model outside the credential's `models`),
// unsupported_request (a request shape the proxy cannot meter, e.g. Responses `background` or `previous_response_id`).
// By a 2xx body whose completed tool call's arguments are not valid JSON: malformed_tool_arguments (the proxy replaced the
// call with a refusal the harness answers as an error tool result; charged as usual).
export const MODEL_CALL_ERROR_CLASSES = [
  "not_found",
  "auth_rejected",
  "insufficient_funds",
  "rate_limited",
  "bad_request",
  "upstream_4xx",
  "upstream_5xx",
  "redirect",
  "dns",
  "connect",
  "tls",
  "timeout",
  "aborted",
  "transport",
  "malformed_response",
  "response_too_large",
  "stream_error",
  "stream_cut",
  "model_not_allowed",
  "unsupported_request",
  "malformed_tool_arguments",
] as const;
export type ModelCallErrorClass = (typeof MODEL_CALL_ERROR_CLASSES)[number];

// Where a model call went and what the upstream said when it failed. The host and the final path (base path plus request
// path, never the query) are the operator's own configuration; `upstreamMessage` is the upstream error text trimmed to 200
// characters with control characters, key-shaped substrings and the configured upstream key removed. Journaled on the
// settlement entry (host and path on every entry whose call reached the upstream, the message on "failed" ones); not kept
// on the debit ledger.
export interface ModelCallUpstream {
  upstreamHost?: string;
  upstreamPath?: string;
  upstreamMessage?: string;
}

// The durable superset the store's `modelDebit` accessor returns: the debit primitive plus the
// credential authorization/revocation the proxy gateway backs onto. `authorize` returns null for a
// malformed, expired, tampered, or revoked credential; `revoke` is durable and checked by `reserve`.
// `revoke(agent)` kills every credential whose `issuedAt` is at or before the revocation cutoff
// (`issuedAt <= revokedAt`); the cutoff is never below the latest stamp `issue` handed out, so a
// credential issued before the revoke is always killed, even if the clock stepped backwards. A
// credential issued after it is valid, so a yielded agent can resume with a fresh key.
export type CredentialCheck = { ok: true; credential: GatewayCredential } | { ok: false; reason: GatewayCredentialRejection | "revoked" };

export interface DurableModelDebitStore extends ModelDebitStore {
  // Records per-call metadata on the request row for (agent, requestId) so cost joins to a call. Returns false when
  // that request id is unknown (never reserved). Idempotent: a replay rewrites the same values (omitted fields are
  // cleared, not merged). Never touches spend or budget. No prompts or bodies.
  recordCall(agent: AgentId, requestId: string, meta: ModelCallMeta): boolean;
  authorize(key: string): GatewayCredential | null;
  // `authorize` with the reason for a refusal: `invalid` or `expired` from verifyGatewayCredential (expiry is judged before
  // revocation, so an expired and revoked key reads `expired`), else `revoked` for a signed, unexpired key at or before the
  // agent's revocation cutoff. Read-only, like `authorize`; `ok` exactly when `authorize` returns the credential. The proxy
  // calls it after a 401-class refusal (`authorize` null, or `reserve` -> "invalid-credential") to pick its error code:
  // `expired` -> MODEL_PROXY_CREDENTIAL_EXPIRED, anything else -> MODEL_PROXY_INVALID_CREDENTIAL.
  checkCredential(key: string): CredentialCheck;
  // Atomic issuance: returns the `issuedAt` stamp for a credential issued at `clockMs` (wall clock, ms).
  // The stamp is `max(clockMs, latest issued stamp, revokedAt + 1)`, persisted as the agent's new latest
  // issued stamp in the same transaction, so a issue is always strictly after the agent's revocation and
  // a later revoke cannot undercut it. The gateway calls this instead of reading a floor and issuing.
  // Fail-closed: a non-safe-integer clock, or a computed stamp that is not a safe integer (e.g. revoked_at at
  // MAX_SAFE_INTEGER), throws and persists nothing, so the agent's high-water is unchanged.
  issue(agent: AgentId, clockMs: number): number;
  revoke(agent: AgentId): void;
  // Settled charges for the agent — the spend authority behind the daemon's over-budget stop and resume
  // check. 0 when the agent has no bucket yet (no credential ever reserved). In-flight reservations do
  // not count; a settle records the true charge, even past the budget.
  spentFor(agent: AgentId): number;
  // The agent's place in the one hierarchical ledger (budget-ledger.ts), read in one transaction over the registry and the
  // buckets: its budget (registry carve; a bucket's own cap for an agent the registry does not know), what it has committed
  // (own spend and reservations plus what its children hold), the signed remainder, and the overage beyond its budget.
  // `reserve` enforces the same arithmetic up the ancestor chain, so a child's carve is out of its parent's reach. Optional so a
  // flat store without a registry (the testing fake) still satisfies the port; the gateway then falls back to `spentFor` and the
  // daemon computes the ledger itself.
  ledgerFor?(agent: AgentId): AgentLedger;
  // usage-join: the settled call (settled or expired-charged) whose recorded provider response id (ModelCallMeta.responseId)
  // is `responseId`, for this agent only. Null when none matches; the join is exact and never falls back to token counts.
  // Optional like ledgerFor (the flat testing fake may omit it; the daemon then joins on the journaled settlements).
  settledCall?(agent: AgentId, responseId: string): { requestId: string; chargedMicros: number } | null;
  // Sets the agent's cumulative budget cap to `micros` — the TOTAL budget (spent included), not a delta.
  // Grows or shrinks explicitly; idempotent; never touches spend. Creates the bucket (spent 0) for an
  // unknown agent. `reserve` never changes an established cap, so a credential's own budget cannot
  // enlarge it; the gateway applies this at issue. Throws on a negative or non-integer value.
  setBudget(agent: AgentId, micros: number): void;
  // Charge (fail closed) reservations left unsettled and untouched for at least `olderThanMs` (a crashed proxy or lost settle)
  // and return how many were expired. The age runs from the last `touch`, else from the reservation.
  expireReservations(olderThanMs: number): number;
}

// Durable fixed-window counters (SPEC rule 6: no state in daemon memory), for per-agent call/byte quotas and host pacing that
// must survive a restart. A counter is identified by (scope, key, windowStartMs): `scope` names the quota ("web_fetch.calls"),
// `key` its subject (an agent id, a registrable domain), `windowStartMs` the caller's window bucket (e.g. floor(now / windowMs) *
// windowMs; a lifetime quota passes 0). Each call is atomic. `take` adds `amount` only when `used + amount <= limit` and returns
// the resulting count (unchanged on refusal); `give` returns up to `amount` (never below 0) and returns the new count; `peek`
// reads it (0 when absent). Amounts and limits are non-negative safe integers, else the call throws. Windows that started before
// the store's retention cutoff are pruned by the daemon's sweep; a lifetime quota (window 0) is pruned only once it has not
// changed since that cutoff, so a live subject's lifetime count is never reset.
// `opId` (optional, a non-empty string): a take that succeeded under this (scope, key, windowStartMs, opId) is applied once; a
// replay returns that first result and adds nothing, so a broker step replayed after a crash charges a quota or claims a pacing
// slot once. Only a successful take is recorded: a refused one changed nothing, so its replay is evaluated afresh. The record is
// durable (a restart keeps it) and pruned with its window. Absent: every take is evaluated.
export interface QuotaCounters {
  take(scope: string, key: string, windowStartMs: number, amount: number, limit: number, opId?: string): { ok: boolean; used: number };
  give(scope: string, key: string, windowStartMs: number, amount: number): number;
  peek(scope: string, key: string, windowStartMs: number): number;
}

export interface ExtensionGateway {
  list(): Promise<ExtensionSpec[]>;
  call(agent: AgentId, extension: ExtensionId, input: unknown, idempotencyKey: string): Promise<ExtensionResult>;
}

export interface Orchestrator {
  // Durable, restartable lifecycle driver. Its internal log is not read by anyone else.
  start(agent: AgentId, generation: number): Promise<void>;
  waitFor(agent: AgentId, cond: WaitCondition): Promise<void>;
  wake(agent: AgentId, signal: Signal): Promise<void>;
  cancel(agent: AgentId, graceMs: number): Promise<void>;
}

// Admission over the host and reservation tables (HostStore), never daemon memory: a restarted
// daemon sees the same running set. Idempotent per agent: admitting an already running or queued
// agent returns its current answer.
export interface Placement {
  admit(req: {
    agent: AgentId;
    priority: number;
    resources?: Resources;
    template?: TemplateId;
    affinity?: { host?: HostId };
  }): Promise<{ host: HostId } | { queued: true; reason: string }>;
  release(agent: AgentId): Promise<void>;
  status(): Promise<PlacementStatus[]>; // one row per host
  // Reconcile the running set with the agents actually running (hot restart via Sandbox.attach,
  // cross-host records): listed agents are marked running (no queueing, may exceed max), others
  // that were running are released.
  sync(agents: AgentId[]): Promise<void>;
}

// Durable host and reservation tables behind Placement. Every mutating call is idempotent by key.
export interface HostStore {
  upsertHost(h: NewHost, idempotencyKey: string): Promise<HostRecord>; // keeps createdAt of an existing row
  getHost(id: HostId): Promise<HostRecord | null>;
  listHosts(): Promise<HostRecord[]>;
  setHostState(id: HostId, state: HostState, idempotencyKey: string): Promise<HostRecord | null>; // null when unknown
  // One reservation per agent: upsert by agent, assigning `seq` on first insert. Returns the stored row.
  reserve(r: NewReservation, idempotencyKey: string): Promise<Reservation>;
  getReservation(agent: AgentId): Promise<Reservation | null>;
  // Ordered by priority ascending, then seq ascending.
  listReservations(opts?: { host?: HostId; state?: Reservation["state"] }): Promise<Reservation[]>;
  releaseReservation(agent: AgentId, idempotencyKey: string): Promise<boolean>; // false when none existed
}

export interface TemplateStore {
  resolve(name: TemplateId): Promise<Template | null>;
  list(): Promise<Template[]>;
}

// ---- Merging a child's branch into its parent's ------------------------------

// The only writer of a merge target. Merges for one repo run one at a time; the ref move is a
// compare-and-swap on the pinned target tip, so a crash leaves the old ref or the new one.
export interface RepoStore {
  repo(): Promise<Repo>;
  // Idempotent by `idempotencyKey` (per invocation): a replay returns the original result without re-running.
  // Rejects StaleGenerationError when `req.callerGeneration` is below the caller's registry generation.
  merge(req: MergeRequest, idempotencyKey: string): Promise<MergeResult>;
  // The status `reap` consults: merged (child tips reachable from `target`), escalated, or nothing to merge.
  mergeStatus(q: { child: AgentId; target: string }): Promise<MergeReport>;
  // Scoped `--from-commit`: the full commit id when `commit` exists and is reachable from the ingested heads of
  // one of `agents` (the caller's own subtree), else null. Never reads outside `agents`.
  commitInSubtree(commit: string, agents: AgentId[]): Promise<string | null>;
  // Re-runs merges left open by a crash (phase before "done") from their stored requests. Returns their results.
  recover(): Promise<MergeResult[]>;
}

// Durable merge journal, rounds and per-child status (host id and generation on every record, no daemon
// memory). Every mutating call is idempotent by key.
export interface MergeStore {
  // Returns the existing record for `idempotencyKey` (in its current phase) or inserts a new one. Fenced:
  // rejects StaleGenerationError when the request's callerGeneration is below the caller's registry generation.
  begin(r: NewMergeRecord, idempotencyKey: string): Promise<MergeRecord>;
  // Moves an unsettled record to the next phase and records the pinned tips / candidate. A settled record is returned unchanged.
  advance(id: MergeId, step: MergeStep, idempotencyKey: string): Promise<MergeRecord>;
  // Terminal. First settle wins (a later one returns the stored record). Updates the per-child status and round
  // counter in the same transaction: merged resets rounds; conflict/check_failed/escalate set failedRounds
  // to the result's round(s); moved and policy_rejected leave the status alone.
  settle(id: MergeId, result: MergeResult, idempotencyKey: string): Promise<MergeRecord>;
  get(id: MergeId): Promise<MergeRecord | null>;
  status(repo: RepoId, child: AgentId): Promise<MergeStatus>; // state "none", 0 rounds when unknown
  // A settled conflict for exactly these pinned tips, if any: re-merging unchanged tips replays it without a new round.
  findConflict(q: { repo: RepoId; caller: AgentId; child: AgentId; base: string; source: string }): Promise<MergeRecord | null>;
  list(opts?: { open?: true; caller?: AgentId; child?: AgentId }): Promise<MergeRecord[]>; // oldest first
}

// Runs the repo's check command on exactly one candidate commit, in a throwaway no-network container
// (the adapter's job). Throwing means the runner itself failed (infrastructure): the merge stays open and
// retries, the target is untouched. `ok: false` is a failing check.
export interface CheckRunner {
  run(req: { repo: RepoId; commit: string; command: string[]; idempotencyKey: string }): Promise<CheckResult>;
}

// ---- The capture broker -----------------------------------------------------

// A job to create, or to join (CaptureIndex.begin). `request` carries the canonical URL. Host id and generation are the requester's.
export interface NewCaptureJob {
  key: string; // the cache key (captureCacheKey)
  request: CaptureRequest;
  acquirer: string; // "web" or an official-API acquirer id
  render: CaptureKeyRender;
  requester: AgentId;
  generation: number;
  host: HostId;
  createdAt: number;
}

// One journaled step of a job, replayed in order after a restart.
export type CaptureStep =
  | { kind: "rung_entered"; rung: CaptureRung; at: number }
  | { kind: "rung_result"; rung: CaptureRung; status: number | null; durationMs: number; bytes: number; failure?: CaptureFailure; at: number }
  | { kind: "stored"; artifacts: CaptureArtifact[]; fetch: FetchMeta; robots: RobotsEvidence | null; at: number };

export interface CaptureJob {
  id: CaptureJobId; // captureJobIdOf(key, createdAt)
  key: string;
  request: CaptureRequest;
  acquirer: string;
  render: CaptureKeyRender;
  requester: AgentId; // who created it
  generation: number;
  host: HostId;
  requesters: { agent: AgentId; generation: number }[]; // the creator first, then each joiner once, in join order
  state: "open" | "settled";
  steps: CaptureStep[];
  outcome: CaptureOutcome | null; // the settled outcome (ok or failed), null while open
  createdAt: number;
  updatedAt: number;
}

// The broker's durable state: jobs (begin/advance/settle, the MergeStore shape, so a crash resumes from the last step), the
// positive cache (captures by cache key, id and artifact digest), the negative cache, and per-domain Retry-After pauses. No state
// in daemon memory: a restarted pomtreed sees the same open jobs and caches. Every mutating call is idempotent by key.
export interface CaptureIndex {
  // Idempotent by `idempotencyKey` with a fingerprint of the request (key, request, acquirer, render, requester; not createdAt,
  // generation or host): a replay of the same request returns that job as it is now, a different request under the same key
  // throws IdempotencyConflictError and changes nothing. Otherwise joins the open (unsettled) job for `j.key`, adding the requester,
  // or creates one with id captureJobIdOf(j.key, j.createdAt) (createdAt is bumped by 1 ms until the id is unused).
  begin(j: NewCaptureJob, idempotencyKey: string): Promise<CaptureJob>;
  // Appends a step to an open job (a settled job is returned unchanged); a replayed key returns the first answer. Throws on an
  // unknown job.
  advance(id: CaptureJobId, step: CaptureStep, idempotencyKey: string): Promise<CaptureJob>;
  // Terminal; first settle wins (a later one returns the stored job). `outcome` is ok or failed (pending throws). ok: the record
  // must carry the job's key (predicate.key); it is inserted (latest/get/list/byDigest) and the key's negative entry is cleared.
  // failed: the outcome's job must be this job; a negative entry for the key is stored until now + negativeTtlMs(failure,
  // ROBOTS_CACHE_MAX_MS) when that is positive. Throws on an unknown job.
  settle(id: CaptureJobId, outcome: CaptureOutcome, idempotencyKey: string): Promise<CaptureJob>;
  job(id: CaptureJobId): Promise<CaptureJob | null>;
  open(): Promise<CaptureJob[]>; // unsettled jobs, oldest first, for restart recovery
  latest(key: string): Promise<CaptureRecord | null>; // newest successful capture for a cache key
  get(id: CaptureId): Promise<CaptureRecord | null>;
  // Newest first; limit defaults to CAPTURE_LIST_LIMIT_DEFAULT and is clamped to 1..CAPTURE_LIST_LIMIT_MAX.
  list(opts?: { limit?: number }): Promise<CaptureRecord[]>;
  byDigest(sha256: string): Promise<CaptureArtifact | null>; // dedup across owners: the first artifact stored with this digest
  negative(key: string, now: number): Promise<{ failure: CaptureFailure; until: number } | null>; // null once until <= now
  pauseDomain(domain: string, until: number, idempotencyKey: string): Promise<void>; // a 429/503 Retry-After; only ever extends a pause
  domainPause(domain: string, now: number): Promise<number | null>; // until when the registrable domain is paused, or null
}

// Parses untrusted bodies outside pomtreed (decision C9). The doc puts robots.txt evaluation and the Wayback answer in the capture
// worker; until the worker modes land (S2), pomtreed runs this port in a separate child process, so pomtreed itself never parses a body.
// Both methods reject when the parser fails (crash, timeout, malformed answer); a parse that finds nothing is a value, not a
// rejection (an empty robots.txt allows; no snapshot is null).
export interface CaptureParser {
  robots(i: { body: Uint8Array; tokens: string[]; path: string }): Promise<Pick<RobotsEvidence, "verdict" | "rule">>;
  waybackAvailability(i: { body: Uint8Array }): Promise<{ url: string; timestamp: string; archivedAt: number } | null>;
}

// Expected conflicts are returned, not thrown: `currentRev` is the live document's rev, 0 when the key is absent (never existed, removed, or purged); expectRev 0 means "absent", like null.
export type StatePutResult = { ok: true; doc: StateDoc } | { ok: false; reason: "conflict"; currentRev: number };
export type StateRemoveResult = { ok: true; removed: number; keys: StateKey[] } | { ok: false; reason: "conflict"; currentRev: number };

// The task a workflow writer runs as: fenced against the registry's generation inside the store's write, like an agent writer, but
// left out of the idempotency fingerprint and the stored writer, so a repaired task replays its predecessor's write.
export interface StateFence {
  agent: AgentId;
  generation: number;
}

export interface StatePutRequest {
  owner: StateOwner;
  key: StateKey;
  value: JsonValue;
  // null or 0 = the key must not exist (or be a tombstone); a number = compare-and-set on rev; omitted = blind overwrite.
  expectRev?: number | null;
  writer: StateWriter;
  fence?: StateFence;
}

// `key` removes one doc (expectRev applies); `prefix` removes every live doc under it; `olderThanMs` further restricts a
// prefix removal to docs not updated within that age. expectRev with prefix is invalid; for a key it is a number (0 = must be absent,
// removing nothing), never null: a removal has no "create" reading.
export interface StateRemoveRequest {
  owner: StateOwner;
  key?: StateKey;
  prefix?: string;
  olderThanMs?: number;
  expectRev?: number;
  writer: StateWriter;
  fence?: StateFence;
}

export interface StateListOptions {
  prefix?: string;
  after?: StateKey; // exclusive cursor
  limit?: number; // <= STATE_LIST_LIMIT_MAX
}
export const STATE_LIST_LIMIT_MAX = 200;

// Durable keyed JSON state per owner. Removed docs leave a tombstone (value gone, rev kept) so rev never restarts; a tombstone
// reads as absent and does not count against maxDocs. Tombstones are capped per owner (maxTombstones): the oldest are purged and the
// owner records a rev floor, so a key put after its tombstone was purged starts above every rev it ever had. Limits come from the store's options, never from call arguments.
// Every mutating call is idempotent by key; replay after idempotency retention is protected only by expectRev.
// Throws StateError for policy refusals (an agent writer or fence the registry does not know is `unknown-writer`) and
// StaleGenerationError when an agent writer's or a fence's generation no longer matches the registry's. A writer must be exactly
// { operator: true }, a full agent writer, or a workflow writer { workflow, instance } (checkStateWriter).
export interface StateStore {
  get(owner: StateOwner, key: StateKey): Promise<StateDoc | null>;
  put(req: StatePutRequest, idempotencyKey: string): Promise<StatePutResult>;
  list(owner: StateOwner, opts?: StateListOptions): Promise<StateMeta[]>; // key order, no values
  remove(req: StateRemoveRequest, idempotencyKey: string): Promise<StateRemoveResult>;
  usage(owner: StateOwner): Promise<StateUsage>;
  export(owner: StateOwner, opts?: { prefix?: string }): Promise<StateDoc[]>; // bounded by the owner quota
}
