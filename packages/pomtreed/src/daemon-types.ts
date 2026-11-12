import type { CaptureBroker } from "./capture/types.ts";
import type { AllowlistProfile, ContainerConfigValues, InboundIntent, InboundMessage, MessageReceipt, ResultDisposition } from "@pomtree/core";
import type { ChannelRegistry } from "./channels.ts";
import type { ModelCatalog } from "./model-catalog.ts";
import type { StatePolicy } from "./state-policy.ts";
// Dependency and request types of the Daemon.

import type {
  AgentId,
  AgentRecord,
  AgentState,
  ApprovalStore,
  CheckpointStore,
  EscalationId,
  EscalationStore,
  ExitCause,
  ExitStatus,
  ExtensionGateway,
  ExtensionRegistry,
  Harness,
  HarnessSession,
  HostId,
  Journal,
  Mailbox,
  MessagingChannel,
  MessagingSender,
  ModelGateway,
  Placement,
  Registry,
  RepoStore,
  ReportStore,
  Sandbox,
  SandboxHandle,
  ScheduleStore,
  SessionStore,
  SpawnSpec,
  Template,
  TemplateId,
  StateStore,
  TemplateStore,
  WatchdogStore,
  Workspace,
  WorkspaceId,
} from "@pomtree/core";

import type { DeterministicExecutor, ExecutorSpawnRequest } from "@pomtree/core";
import type { JsonValue } from "@pomtree/core";
import type { EnvManifest } from "@pomtree/agent-image";
import { egressPolicy } from "./egress.ts";
import { DEFAULT_WATCHDOG, evaluate } from "@pomtree/sched";
import type { WatchdogOptions } from "@pomtree/sched";
import { AGENT_TOKEN_TTL_MS } from "./auth.ts";

import type { Limits } from "./lifecycle.ts";

import type { BindableOrchestrator } from "./orchestrator.ts";
import type { PiCredentials } from "./pi-auth.ts";

// Cleanup marks for reaped root children (store-sqlite's `workspaceCleanup` satisfies this structurally).
export interface WorkspaceCleanupMarks {
  markPruned(agent: AgentId, at: number): void;
  markCleaned(agent: AgentId, at: number): void;
  prunedAgents(): Set<AgentId>;
  cleanedAgents(): Set<AgentId>;
}

// The resolved sandbox backend as reported to operators: ids, the CLI binary and the socket path with where it came from; never env values.
export interface ResolvedBackendReport {
  id: string;
  engine?: { binary: string; socket?: string; source?: "config" | "env" | "cli" | "default"; via?: string };
}

export interface DaemonDeps {
  hostId: HostId;
  maxSessions?: { value: number; mode: "auto" | "manual" }; // effective session cap (surfaced by doctor); the cap itself lives in the Placement
  backend?: ResolvedBackendReport; // the resolved sandbox backend (surfaced by doctor and /readyz)
  // Process-wide wall-clock policy. A request may shorten this interval; children never exceed
  // their requester's durable deadline.
  defaultSessionMs?: number;
  maxSessionMs?: number;
  secret: string;
  image: string;
  // Client/server revision skew: the daemon's own git sha and the agent image's baked OCI label
  // revision. Both default to the shared best-effort helpers (revision.ts); override to script them
  // in tests. An undefined result means "unknown", never a mismatch.
  gitSha?: () => string | undefined;
  imageRevision?: (image: string) => string | undefined;
  sandboxSocketPath: string; // where agents see the daemon socket inside the sandbox
  socketHostPath: string; // where the daemon socket lives on the host; bind-mounted at sandboxSocketPath
  agentApiUrl?: () => string | undefined; // when it yields a URL, agents get POMTREE_API=<url> and no socket mount (see listenAgents)
  // The Pi extensions main.ts loads through `command` (harness.steerExt, harness.jobsExt); reported by the trace. Absent = the registry defaults.
  harnessExtensions?: { steerExt: boolean; jobsExt: boolean };
  command?: (task: string, spec?: Pick<SpawnSpec, "provider" | "model" | "allowlist" | "browser"> & { systemPrompt?: string }) => string[]; // harness-specific sandbox cmd (e.g. Pi's argv); spec carries the agent's resolved provider/model, the template's allowlist profile, its browser block and its system prompt (absent when none)
  models?: ModelCatalog; // lists the models Pi can use; validates SpawnRequest.model and serves GET /v1/models
  // Workspace-folder retention (the cleanup sweep, sweepFolders): paused agents idle this long lose their folder (0/unset = never);
  // reaped agents' folders are kept this long (0/unset = evicted at the next sweep); below `folderMinFreeBytes` of free disk the
  // remaining reaped folders go oldest first.
  folderIdleMs?: number;
  folderReapedGraceMs?: number;
  folderMinFreeBytes?: number;
  diskFreeBytes?: () => Promise<number | null>; // free bytes where the folders live; null = unknown
  pushMaxBytes?: number; // POST /v1/agents/:id/push body and result-save bundle cap (push.maxBytes; absent = its registry default)
  // Memory limit of a container whose spec names none (capacity.containerMemoryBytes); absent = the sandbox's own default.
  containerMemoryBytes?: number;
  credentials?: PiCredentials; // per-agent credential file staged before start, removed at settle
  // Default SpawnSpec provider/model for untemplated spawns. TODO(templates): per-template provider/model
  // resolution replaces these once TemplateStore is wired; main.ts can set them from its harness config.
  provider?: string;
  model?: string;
  templates?: TemplateStore;
  // Egress of a spawn that names no template (the built-in code template, which sets none). Absent = none: the library fails closed;
  // main.ts always states it (agent.untemplatedEgress), because boot refuses to start while it is unset (safety-boot.ts).
  untemplatedEgress?: "none" | "registry";
  // Durable keyed state and its grants (SPEC workflow-store). Absent = /v1/state answers 503 and no grant constrains a spawn.
  state?: StateStore;
  stateGrants?: StatePolicy;
  // Operator/root spawns may use any template; agents are default-deny unless this predicate
  // grants them (v1: operator-only). Called with the spawner's agent id and the resolved template.
  mayUseTemplate?: (caller: AgentId, t: Template) => boolean | Promise<boolean>;
  // Template admission against the selected sandbox backend's declaration (main.ts: admitTemplateSpec): the refusal lines for a spec the
  // backend cannot honour, [] when admitted. Checked at spawn and again at start and resume. Absent = no check, on purpose: main.ts is the only production composition root and wires it; the e2e harness and demos run a fake or unconstrained sandbox and omit it.
  admitSpec?: (spec: SpawnSpec) => string[];
  publicEgressReady?: () => boolean; // composition's durable audit collector health; blocks new public workers when unhealthy
  // Per-agent credential lifetime; defaults to AGENT_TOKEN_TTL_MS. main.ts passes agent.tokenTtlMs so stale-container
  // tokens decay even without a fence.
  agentTokenTtlMs?: number;
  // Interval between reconcile() passes (default 30s); main.ts passes agent.reconcileSweepMs.
  reconcileMs?: number;
  // Per-agent failure isolation of the reconcile pass: an agent whose per-agent step throws this many
  // consecutive passes (default 3) raises one alert and is skipped for `reconcileBackoffMs` (default 60s), doubling per further
  // failure up to `reconcileBackoffMaxMs` (default 15 min). A pass in which the agent does not fail resets the count. Only tests override these.
  reconcileFailureThreshold?: number;
  reconcileBackoffMs?: number;
  reconcileBackoffMaxMs?: number;
  // Rate limit on the post-recovery reconcile pass (Daemon.probeStore): while consecutive recovery passes re-latch the store, the
  // next one waits `storeRecoveryBackoffMs` (default admitRetryMs) * 2^relatches, capped at `storeRecoveryBackoffMaxMs` (default
  // 60s); a recovery pass that does not re-latch resets it. `storeRelatchAlertAfter` (default 3) consecutive re-latches raise one
  // alert per episode. Only tests override these.
  storeRecoveryBackoffMs?: number;
  storeRecoveryBackoffMaxMs?: number;
  storeRelatchAlertAfter?: number;
  rootBudgetMicros: number;
  defaultBudgetMicros: number; // µ$ (micro-dollars) carved for an agent-spawned child that omits a budget
  topLevelBudgetMicros?: number; // µ$ carved for an operator (top-level) spawn that omits a budget; falls back to defaultBudgetMicros
  graceMs: number;
  admitRetryMs: number;
  // Pre-flight resource gate consulted before admitting or spawning (503 on failure): a host-level
  // resource check (disk free, sqlite health). A closed gate holds admission until it reopens.
  resourceGate?: () => Promise<{ ok: boolean; reason?: string }>;
  registry: Registry;
  journal: Journal;
  mailbox: Mailbox;
  escalations: EscalationStore;
  // Reports and schedules are owned by the builtin extensions (builtin/reports.ts, builtin/cron.ts); the daemon
  // holds the report store only to remove an agent's reports when it is reaped.
  reportStore: ReportStore;
  // Durable marker for reaped root children whose workspace cleanup finished (sweepCleanup skips them). Optional: without it every
  // sweep re-runs the prune for each merged reaped child. main.ts passes the store's `workspaceCleanup`.
  workspaceCleanup?: WorkspaceCleanupMarks;
  reportMaxBytes: number;
  schedules: ScheduleStore;
  watchdogs: WatchdogStore;
  // Checkpoint store and content-addressed session bytes, plus the host directory where per-agent
  // session JSONL files live (bind-mounted at the container's session dir).
  checkpoints: CheckpointStore;
  sessions: SessionStore;
  sessionRoot: string;
  // Host directories (typically the state dir) whose absolute paths are replaced by `<state>` in journaled error text;
  // `sessionRoot` is always redacted. Realpaths are added automatically.
  redactRoots?: string[];
  // Interactive-pi mode: start sandboxes with a TTY of this size and merge `env` (e.g. harness-pi PI_TTY_ENV) into the
  // sandbox env, and delete a stale per-agent sink file (`sinkFile`, in the session dir) before each start so a previous
  // run's `agent_settled` is never replayed. Unset keeps the plain non-TTY container.
  terminal?: { size: { cols: number; rows: number }; env: Readonly<Record<string, string>>; sinkFile: string };
  // The channel registry (channels.ts), built once at boot: which channels a host token may post to and where asks/alerts
  // are sent OUT (root broadcasts to every outbound one). "ui" is the in-daemon operator UI (no adapter, no host token).
  channels: ChannelRegistry;
  // Gate for inbound `intent: "spawn"` (messaging.allowSpawn); off by default.
  messagingAllowSpawn?: boolean;
  sandbox: Sandbox;
  // The sandbox of any backend this build and config can reach (boot reconcile walks every backend a live record names).
  // Absent = only `sandbox` is reachable; undefined for an id = that backend is not available. For the selected id it must return
  // this object's own `sandbox` (the guard/trace wrapper), never the raw adapter, or one sandbox is reconciled twice. Each backend's
  // `list(owner)` must filter by owner server-side: reconcile reclaims only what a backend lists and can prove is this daemon's.
  sandboxFor?: (backend: string) => Sandbox | undefined;
  workspace: Workspace;
  // Merge engine. Absent = merging is not configured (merge route 503, reap unguarded).
  repos?: RepoStore;
  harness: Harness;
  gateway: ModelGateway;
  placement: Placement;
  orchestrator: BindableOrchestrator;
  limits?: Partial<Limits>;
  now?: () => number;
  random?: () => number; // jitter source for provider-failure backoff (default Math.random)
  // Watchdog ladder: the interval lives in Limits.watchdogSweepMs; options default to DEFAULT_WATCHDOG via evaluate().
  watchdogOptions?: Partial<WatchdogOptions>;
  // Environment layer (TODO(env)): `cacheRoot` is the realpathed cache directory; `manifest` is the
  // base/default manifest (empty additions when absent). Only the base layer is mounted per spawn until
  // per-spawn additions and a parent-layer (manifest-hash inheritance) land.
  env?: { cacheRoot: string; manifest?: EnvManifest };
  // Extension host (TODO(extensions)): loaded by main.ts; the daemon does not drive extension hooks
  // yet (no spawn integration), but the server mounts their routes from here. Optional so packages
  // that build a Daemon without extensions (e2e) keep typechecking.
  extensionHost?: ExtensionRegistry;
  // Agent-side extension gateway (TODO(pi-ext)): the host implementations of the agent extension tools
  // (web_fetch/web_search). Optional so packages that build a Daemon without an extension gateway (e2e)
  // keep typechecking. `approveExtension` gates each call (absent = allow); a deny is journaled and 403.
  extensions?: ExtensionGateway;
  // The capture broker behind POST/GET /v1/capture (capture/types.ts); absent: those routes answer 503.
  capture?: CaptureBroker;
  captureWaitMs?: number; // capture.waitMs: the bound on a /v1/capture ?waitMs= (default the registry default)
  approveExtension?: (req: { agent: AgentRecord; extension: string; input: unknown }) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  // Gated-action approvals (TODO(authz-escalation)). When set, gated actions (extension calls selected by
  // `extApprovalRequired`, publish) create a durable approval, alert the escalation channel, and fail closed on timeout.
  approvals?: ApprovalStore;
  approvalTimeoutMs?: number; // per-rung fail-closed window for human rungs (default 5 min)
  escAgentMs?: number; // per-hop window of an agent rung on a bubbled ask or approval (default 10 min; escalation.agentRungMs)
  budgetRaiseMs?: number; // per-rung fail-closed window of a human rung on a budget_raise approval (default 24 h; budget.raiseMs)
  budgetRaisePct?: number; // requested raise as a percent of the agent's original budget (default 50; budget.raisePct)
  approvalWaitMs?: number; // how long one gated call blocks before answering 409 "approval pending" (default 20s; the retry converges on the same approval)
  extApprovalRequired?: (extension: string) => boolean;
  // Deterministic (non-container) drivers, keyed by the driver name a spec names. Absent = none available (refused before create).
  deterministicExecutors?: ReadonlyMap<string, DeterministicExecutor>;
  // Open escalations expire after this long (default 24h): the asker is answered with EXPIRED_ANSWER (fail closed).
  askTimeoutMs?: number;
  // The resolved container subset (core containerConfigValues): written into every container as PTREE_CONFIG_JSON and
  // recorded on the sandbox `started` entry. Its wait.yieldMs is also the daemon's own yield threshold: an agent's
  // `pomtree wait/inbox --wait/ask --wait` longer than it yields under the hood instead of holding the container.
  // Absent = the registry defaults (DEFAULT_CONTAINER_CONFIG).
  containerConfig?: ContainerConfigValues;
  // The resolved workflow.fetch.userAgent (never blank after config resolution): a browser worker receives it as
  // PTREE_BROWSER_USER_AGENT (daemon-util.ts browserEnv). Absent = a browser worker's start is refused; no default here.
  fetchUserAgent?: string;
  // After an operator interrupt reaches a running agent, how long its Pi process gets to exit (the mailbox extension aborts
  // it) before the container is killed (default 5000). The agent is then checkpointed and resumed with the message.
  interruptGraceMs?: number;
  // Re-alert cadence for an unanswered ask: a reminder at 1x, 4x and 24x this base age (default 1 h).
  askRealertBaseMs?: number;
  // Per-sender authorization for inbound messages (TODO(msg-authz)); absent = every configured channel's sender is accepted.
  authorizeInbound?: (msg: InboundMessage, route: InboundIntent) => boolean | Promise<boolean>;
  // Chat-initiated routes that need a durable human approval before they act (TODO(authz-escalation)); needs `approvals`.
  // A launch is gated by chatApproval("spawn"): it has no route of its own here.
  chatApproval?: (route: "spawn" | "cancel") => boolean;
  // Named workflow launch (TODO(flow-launch)): admits a registered workflow as a root child. The host owns key replay and
  // definition checks, and refuses with LifecycleError (400/403/404/409/503). Absent = launch is refused (503).
  launchWorkflow?: (
    requester: AgentId,
    req: { workflow: string; input: JsonValue; idempotencyKey: string; budgetMicros?: number; deadlineMs?: number },
  ) => Promise<AgentRecord>;
  // Chat-rank launch allowlist, default deny: only a true result admits `workflow` from this actor. Operator rank does not consult it.
  allowChatWorkflow?: (actor: { channel: MessagingChannel; sender: MessagingSender }, workflow: string) => boolean | Promise<boolean>;
  // Host-side git publish (TODO(publish)): only the daemon holds credentials; `push` is injected by main.ts.
  // `resolve` pins the agent's INGESTED branch to a sha and a short diffstat at approval time; `push` then publishes exactly
  // that sha from the mirror (never a moving tip, never a branch name). Both are mandatory: an unpinned push is refused.
  publisher?: {
    allowedTargets: string[];
    push: (agent: AgentId, branch: string, target: string, sha: string) => Promise<void>;
    resolve: (agent: AgentId, branch: string, target: string) => Promise<{ sha: string; summary: string; paths: string[] }>;
    requireApproval?: boolean;
    // Repo-relative path prefixes a publish may not touch (publish.deny); absent = DEFAULT_DENIED_PATHS, [] = no denylist.
    deniedPaths?: readonly string[];
  };
  // Trust registry-less containers/worktrees (agent.adoptOrphans); otherwise an empty registry beside live
  // resources is treated as suspect and nothing is reclaimed (Reconcile.canReclaimOrphans).
  adoptOrphans?: boolean;
  // Ownership labels: `storeId` is a stable id for this registry/store (main.ts persists it) and
  // `epoch` a monotonic decimal string for this boot (default: boot time in ms). Both are stamped on every sandbox at
  // spawn; reconcile skips containers of another store or a newer epoch, and unlabelled containers.
  storeId?: string;
  epoch?: string;
  // Max automatic restarts per agent (host-stop resumes and restart-from-scratch after a spawn crash); default 3.
  maxRestarts?: number;
  // Spawn preflight: is the agent API endpoint reachable? A false result is remembered so a nonzero container exit is
  // classified `endpoint_unreachable` (TODO(exit-cause)). Absent = no probe.
  agentEndpointProbe?: () => Promise<boolean>;
  // Detail behind the probe (bind addresses, POMTREE_API, container reachability); shown by doctor and in the preflight error.
  agentEndpointStatus?: () => Promise<{ bind: string[]; apiUrl: string; containerReachable: boolean; hostProbe: boolean; probe: string; message?: string }>;
}

export interface SpawnRequest {
  name: string;
  task: string;
  budgetMicros?: number;
  // Wall-clock cap (ms from creation) on this agent's run; enforced by a hard kill timer
  // and surfaced durably as the watchdog's `deadlineAt`. Omit to use the configured
  // default; zero is an explicit unlimited request, authorized only for operators by API.
  deadlineMs?: number;
  wrapupMs?: number; // positive wrap-up window after result; defaults to 30 seconds
  disposition?: ResultDisposition; // what happens to this child's result after its parent is told; request > template > hold
  idempotencyKey: string;
  // Refuse the spawn (403) unless the resolved template carries exactly this allowlist profile (core ExecutorSpawnRequest.requireAllowlist).
  requireAllowlist?: AllowlistProfile;
  template?: TemplateId; // named profile overlay resolved against the TemplateStore (v1: operator-only)
  // Fork: start from a prior commit and/or a stored session. `fork` alone inherits the requester's
  // latest checkpoint. The source is journaled (FORK_KIND) so a replayed or recovered start finds it again.
  fork?: boolean;
  fromCommit?: string;
  sessionRef?: string;
  // Per-agent model override (precedence: this > template > parent's model > daemon default). Persisted on the record's spec.
  model?: { provider: string; id: string };
}

// An inbound message posted by a messaging adapter (host credential): core's wire shape (messaging.ts), declared once. The
// route already verified the caller's host channel matches `channel`.
export type { InboundMessage } from "@pomtree/core";

// A WRITE action on the daemon by a human through any channel (performAction, daemon/messaging.ts). `answer` replies to an
// ask or an approval id (the approval reply is parsed from `body`, or `pass`); `decide` decides an approval explicitly.
export type ChannelAction =
  | { kind: "answer"; replyTo: EscalationId; body: string; pass?: boolean }
  | { kind: "decide"; id: string; decision: "approve" | "deny" | "pass"; why: string; grantMicros?: number }
  // `mode` set = the operator's message route (journal on the target, queue or interrupt); unset = a chat/UI reply.
  | { kind: "signal"; to: AgentId; body: string; mode?: "queue" | "interrupt" }
  | { kind: "spawn"; parent?: AgentId; request: Omit<SpawnRequest, "idempotencyKey"> }
  | { kind: "cancel"; to: AgentId; graceMs?: number }
  | { kind: "status"; to: AgentId }
  | { kind: "launch"; workflow: string; input: JsonValue; budgetMicros?: number; deadlineMs?: number };

export type ActionResult = { kind: "rejected"; reason: string; status?: number } | { kind: "ok"; receipt: MessageReceipt; value?: unknown };

export type { MessageReceipt };

// A display-ready row for the operator journal view: seq is the paging cursor, and only
// ts/agent/kind/summary are painted by the observe panes.
export interface JournalRow {
  seq: number;
  ts: number;
  agent: AgentId;
  kind: string;
  summary: string;
  // tool_call: {callId, tool, input}; tool_result: {callId, ok, output, details?}. Raw (capped) content; `details` is bounded JSON or a drop marker (core boundToolDetails).
  tool?: { callId: string; tool?: string; input?: unknown; ok?: boolean; output?: string };
  // A child_exited signal row that carries the child's handoff (<= 2 KB): the UI renders a "Handoff from <child>" card.
  handoff?: { child: string; exit: string; text: string; branch?: string; spentMicros?: number; budgetMicros?: number; files?: string[] };
}

// Live handles are runtime-only; every durable fact is in the registry/journal/mailbox.
// The sandbox id is durable (AgentRecord.sandbox); only the handle and harness session live here.
// TODO(rule6): the live map (handle + harness session) is runtime-only by nature; reconcile() rebuilds what it can.
export interface Live {
  cancelled: boolean;
  deterministic?: boolean; // a deterministic run: no sandbox/session; stopped through `abort`
  suspension?: { wait: import("@pomtree/core").WaitCondition }; // durable snapshot accepted; remaining ops fenced until body/effects unwind
  approvalReadSignals?: Set<string>; // canonical terminal approval reads observed by this body (not inbox consumption)
  generation?: number; // the deterministic run's generation (its settle finishes only this one)
  abort?: AbortController; // aborts on cancel, timeout or settle; the driver's signal is this controller's
  driverError?: { error: unknown }; // the driver threw (or setup failed); sanitized into the journal on failure
  interrupt?: boolean; // an operator interrupt is pending: when the Pi process ends, checkpoint and resume with the message
  interruptTimer?: ReturnType<typeof setTimeout>; // backstop: kill the container if Pi has not exited within interruptGraceMs
  yieldSettled?: boolean; // settleYield ran (the pump ended mid-yield); a later cancel-abort of the yield must finish the agent itself
  yieldGate?: Promise<void>; // resolves when yield() finished its durable writes; settleYield waits so it cannot revoke the key mid-snapshot
  yielding?: boolean; // set by yield(); the settle path ends the segment without finish()/exited
  cause?: ExitCause; // host/provider fault classified before settle (e.g. provider_error)
  resultTimer?: ReturnType<typeof setTimeout>;
  resultDeadlineAt?: number;
  result?: { status: "succeeded" | "failed"; result: unknown };
  timedOut?: boolean; // the wall-clock deadline (SpawnRequest.deadlineMs) elapsed; settle exits `timed_out`
  sandbox?: SandboxHandle;
  session?: HarnessSession;
  killTimer?: ReturnType<typeof setTimeout>;
  admitting?: boolean; // a resume parked in admission: no runtime yet, so kill/stop finish the agent directly
  settled?: boolean; // the harness event stream ended on its own without an `error` event (silent-exit diagnosis)
  endpointUnreachable?: boolean; // the spawn preflight could not reach the agent API endpoint
  workspace?: WorkspaceId; // this segment's workspace id, so settle can name the kept folder on commit failure (never a path)
}

export type DeterministicStartRequest = Extract<ExecutorSpawnRequest, { executor: "deterministic" }>;
