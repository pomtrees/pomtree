import type { ExtensionJournalPayload } from "./extension.ts";
import type {
  BudgetDeniedJournalPayload,
  BudgetEscalatedJournalPayload,
  BudgetGrantedJournalPayload,
  BudgetOverageJournalPayload,
  BudgetTopUpJournalPayload,
  BudgetWithdrawalJournalPayload,
  ModelSettlementJournalPayload,
  UsageCostSource,
} from "./kinds.ts";
import type { ForcedRefUpdate, IngestFailCode } from "./ports.ts";

export type AgentId = string;
export type HostId = string;
export type SessionId = string;
export type SandboxId = string;
export type CheckpointId = string;
export type TemplateId = string;
export type WorkspaceId = string; // opaque id of an agent's working folder on a host; never a path

// How a paused agent resumes: `session` restores the harness session, `task` starts a fresh run seeded from the
// journaled steps, `none` is not resumable.
export type ResumeLevel = "session" | "task" | "none";

export interface Resources {
  cpus?: number;
  memoryBytes?: number;
  shmBytes?: number;
  diskBytes?: number;
  accelerators?: string[];
}

export type EgressPolicy = { kind: "none" } | { kind: "registry" } | { kind: "allowlist"; hosts: string[] } | { kind: "audited-public" };

// The closed set of tool-allowlist profiles a template may name (Template.allowlist). A profile fixes the worker's complete Pi tool
// loadout (tool names and the one in-image extension that provides them); the realization lives in @pomtree/agent-image
// (ALLOWLIST_PROFILES), exhaustive over this list. `analyst`: the digest's article analyst (article_page, analysis_result; no shell).
// `browse`: a general text-page reader (web_fetch only; no shell, files or JS rendering); its template must list the web_fetch extension and use an `allowlist` egress.
// `specialist`: a closed paged-reader profile (thread_page, source_page, post_draft; no shell, network or pomtree tool; first user: a domain example's research board): it reads the pages its
// coordinator published to it and returns one post draft that the coordinator validates and stamps.
export const ALLOWLIST_PROFILES = ["analyst", "browse", "specialist"] as const;
export type AllowlistProfile = (typeof ALLOWLIST_PROFILES)[number];
export const isAllowlistProfile = (v: unknown): v is AllowlistProfile => typeof v === "string" && (ALLOWLIST_PROFILES as readonly string[]).includes(v);

// The closed set of browser worker profiles a template may name (Template.browser.profile). Absent is the capture-only worker
// (browser_capture and capture_finish). `interactive`: EXPERIMENTAL, the model drives the page (navigate, snapshot, click, type, keys,
// scroll, screenshot, back, tabs, wait) and ends with capture_finish; it still has no shell, files or pomtree tool. The realization (the
// exact tool list, prompt preamble and evidence bounds) lives in @pomtree/agent-image browser-run.ts (BROWSER_PROFILE_TOOLS), exhaustive over this list.
export const BROWSER_PROFILES = ["interactive"] as const;
export type BrowserProfile = (typeof BROWSER_PROFILES)[number];
export const isBrowserProfile = (v: unknown): v is BrowserProfile => typeof v === "string" && (BROWSER_PROFILES as readonly string[]).includes(v);

// A browser worker's block: whole-run budgets (tool steps and wall-clock milliseconds) and its optional profile (absent = capture-only).
export interface BrowserLimits {
  maxSteps: number;
  maxMs: number;
  profile?: BrowserProfile;
}

// What happens to an exited child's record after its parent has been told. `hold` (the default): it stays exited until its custodian
// reaps it; `ttlMs` (hold only) is how long the daemon waits before reaping it and telling the custodian. `reap-on-exit`: the daemon reaps
// it as soon as the parent has the exit signal (its record and result stay readable). Children of the root supervisor are always reaped at exit.
export interface ResultDisposition {
  mode: "hold" | "reap-on-exit";
  ttlMs?: number;
}

export interface Template {
  id: TemplateId;
  name?: string;
  image?: string;
  env?: unknown;
  extensions?: string[];
  provider?: string;
  model?: string;
  budgetMicros?: number;
  memoryBytes?: number;
  cpus?: number;
  shmBytes?: number;
  // Maximum writable workspace bytes. The sandbox adapter must reject a start when it cannot
  // enforce this continuously; accepting it and merely accounting after the fact is unsafe.
  diskBytes?: number;
  systemPrompt?: string;
  egress?: EgressPolicy;
  resume?: ResumeLevel; // default "session"
  requires?: string[]; // host capability labels a placement must satisfy
  // When present the container is a browser worker: the controller sets the PTREE_BROWSER* env from these budgets
  // (never from a spawn request) and the template must use `audited-public` egress. Ranges: BROWSER_MAX_STEPS_RANGE / BROWSER_MAX_MS_RANGE.
  // `profile` (BROWSER_PROFILES) selects the worker's tool set; absent is the capture-only worker.
  browser?: BrowserLimits;
  // Names a tool-allowlist profile (ALLOWLIST_PROFILES): the harness argv offers exactly that profile's tools, never the default
  // loadout (bash, read, write, edit). Absent keeps the default loadout.
  allowlist?: AllowlistProfile;
  // Default disposition of the results of agents spawned from this template (a spawn request overrides it); absent means hold.
  disposition?: ResultDisposition;
  // Adapter-owned realization block (e.g. the Docker run shape). Opaque to core: core names no Docker flag.
  runtime?: Readonly<Record<string, unknown>>;
}

export const CODE_TEMPLATE_ID: TemplateId = "code";

// The built-in default agent type. Its container shape is the adapter's default (no `runtime`
// block); the daemon fills `image` from its configuration.
export const CODE_TEMPLATE: Template = { id: CODE_TEMPLATE_ID, resume: "session" };

export interface SpawnSpec {
  // Time allowed after reporting a result for the runtime to wrap up (default 30 seconds).
  wrapupMs?: number;
  image: string;
  envManifestHash: string | null;
  extensions: string[];
  provider?: string;
  model?: string;
  systemPrompt: string | null;
  egress: EgressPolicy;
  memoryBytes?: number;
  cpus?: number;
  shmBytes?: number;
  // Resolved from Template.diskBytes and retained so a resumed agent keeps the same hard limit.
  diskBytes?: number;
  // The resolved template, recorded at spawn. A body lacking these fields reads as `code`.
  template?: TemplateId;
  templateDigest?: string | null; // sha256 hex of the canonical template JSON (templateDigest in template.ts); null for an untemplated spawn
  resume?: ResumeLevel;
  browser?: BrowserLimits; // copied from Template.browser: its presence makes the container a browser worker
  allowlist?: AllowlistProfile; // copied from Template.allowlist: the harness argv is resolved from it at start
  runtime?: Readonly<Record<string, unknown>>; // the template's opaque adapter block, copied so a resume needs no re-read
  disposition?: ResultDisposition; // request > template > absent (hold); persisted so a resume or restart keeps it
}

export type ExitCause =
  | "oom_killed"
  | "host_stopped"
  | "resource_exhaustion"
  | "journal_unwritable"
  | "provider_error"
  | "sandbox_unavailable"
  | "merge_conflict"
  | "empty_branch"
  | "signal" // killed by a signal we did not send (e.g. 139 SIGSEGV)
  | "endpoint_unreachable" // the sandbox could not reach the daemon/docker endpoint (spawn preflight)
  | "exec_failed" // the container could not run its command (125/126/127)
  | "app_exit" // the agent process exited non-zero on its own
  | "restart_exhausted" // maxRestarts spent: a reconcile-found-dead or host-fault checkpointed agent could not be auto-restarted again
  | "quarantined" // reconcile found a quarantined running agent and refuses to auto-resume it
  | "passive_settle" // ended turn after turn with no result, yield or activity, past the daemon's nudge cap (TODO(no-passive-settle))
  | "image_unavailable" // the sandbox could not start: the agent image does not exist or cannot be pulled (SandboxStartError image_unavailable)
  | "pull_failed" // the sandbox could not start: a transient image pull/registry failure (SandboxStartError pull_failed)
  | "start_failed"; // the sandbox could not start for another reason (SandboxStartError unknown / egress_start_failed)

export type AgentState = "pending" | "running" | "yielded" | "exited" | "reaped";
export type ExitStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "over_budget";

// Plain JSON data only: the deterministic input is persisted in the agent's spec column and must round-trip exactly.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Which runtime owns an agent. Stored once, as the agents.executor column; never repeated inside the spec JSON.
export type ExecutorKind = "container" | "deterministic";

// A non-container agent: a reviewed driver name and its JSON input. Lives in the same spec column as SpawnSpec.
export interface DeterministicSpec {
  driver: string;
  input: JsonValue;
}

interface AgentRecordBase {
  id: AgentId;
  parent: AgentId | null; // null only for the root supervisor
  name: string;
  task: string;
  state: AgentState;
  exit: ExitStatus | null;
  exitCause?: ExitCause;
  result: unknown;
  host: HostId;
  generation: number; // fencing token; bumped on every resume
  sandbox: SandboxId | null; // live sandbox id, null when none; lets a restarted daemon stop/kill/inspect without container labels (the daemon keeps no state in memory)
  budgetMicros: number; // carved out of the parent's
  createdAt: number; // epoch ms
  updatedAt: number;
}

// The executor discriminates the spec: a container agent carries SpawnSpec (image mandatory), a deterministic one carries DeterministicSpec.
export type AgentRecord = AgentRecordBase & ({ executor: "container"; spec: SpawnSpec } | { executor: "deterministic"; spec: DeterministicSpec });

export type WaitCondition =
  | { kind: "child_exited"; children: AgentId[]; mode: "any" | "all" }
  | { kind: "message" }
  | { kind: "timer"; at: number }
  | { kind: "any"; of: WaitCondition[] };

// Format version stamped on every checkpoint by the store; a reader refuses any other version, and a missing one.
export const CHECKPOINT_FORMAT = 1;

export interface Checkpoint {
  id: CheckpointId;
  version: number; // CHECKPOINT_FORMAT at write time; stamped by the store; a missing value is refused
  agent: AgentId;
  host: HostId; // host that wrote this record (every durable record carries one)
  generation: number;
  sessionRef: string; // content hash or store key, never a path
  workspace: WorkspaceId; // the agent's folder (kept on pause)
  node: HostId; // the node holding the folder
  ingested: { ref: string; commit: string } | null; // last ingested ref (refs/agents/<id>/heads/<name>); null = none yet
  wait: WaitCondition | null;
  remainingBudgetMicros: number;
  imageDigest: string;
  envManifestHash: string | null;
  template: TemplateId; // the agent type this segment ran as
  templateDigest: string | null;
  resumeLevel: ResumeLevel;
  createdAt: number;
}

export type ReportId = string; // deterministic lowercase sha256 hex, derived from (agent, name, key)

// A published static report: an agent's durable file output (HTML/Markdown/JSON/image/PDF),
// stored by pomtreed in a visible directory and retrievable by the operator and the agent's parent.
export interface Report {
  id: ReportId;
  agent: AgentId; // publisher; namespaces the id so cross-agent keys never collide
  generation: number; // fencing token of the publishing run (a stale generation is rejected)
  host: HostId;
  name: string; // slugified label; versions share a name
  mediaType: string;
  sizeBytes: number;
  sha256: string; // hex sha256 of the raw content
  createdAt: number;
}

export interface NewReport {
  id: ReportId;
  agent: AgentId;
  generation: number;
  host: HostId;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  content: Uint8Array; // the raw bytes
}

export type EscalationId = string; // deterministic "es-" + sha256(agent\0key)
export type MessagingChannel = string; // e.g. "discord", "slack"
export type MessageKind = "ask" | "alert" | "status" | "report";
export type EscalationState = "open" | "answered";

export interface MessagingSender {
  channel: MessagingChannel;
  sender: string;
  name?: string;
}

export interface Escalation {
  id: EscalationId;
  agent: AgentId;
  host: HostId;
  generation: number;
  question: string;
  options: string[];
  state: EscalationState;
  answer: string | null;
  answeredBy: MessagingSender | null;
  createdAt: number;
  answeredAt: number | null;
  holder: AgentId | null; // the ancestor currently holding the ask; null = the user via root
  hopDeadlineAt?: number; // when the current holder's hop window lapses and the ask moves up
}

export interface NewEscalation {
  id: EscalationId;
  agent: AgentId;
  host: HostId;
  generation: number;
  question: string;
  options: string[];
  holder?: AgentId | null; // default null
  hopDeadlineAt?: number;
}

export type ApprovalId = string;
// Existing approval policy kinds are extensible; unknown/external-effect kinds require human approvers.
export type ApprovalKind = string;

// Authority ranks, lowest to highest. An agent requester ranks `agent`; the escalation
// ladder of approver rungs starts at the requester's parent agent, then a human operator,
// then the owner. Approver rank must strictly exceed requester rank (no peer or subordinate
// may approve).
export type ApprovalRank = "agent" | "parent-agent" | "operator" | "owner";

// The escalation ladder of approver rungs, lowest to highest. Each rung doubles as the rank
// of the authority deciding at that rung.
// `agent:<id>` names one specific ancestor on a bubbled ladder (see ladderFor); its rank is "parent-agent".
// The bare "parent-agent" rung is the single agent step of the default ladder (see rungsAbove), used when no ancestor chain is given.
export type ApprovalRung = "parent-agent" | "operator" | "owner" | `agent:${AgentId}`;

export type ApprovalState = "pending" | "approved" | "denied";

// An approver's explicit decision. `timeout` is not an approver decision: it is recorded by
// the store when a rung's deadline passes with no answer (see ApprovalStore.timeout).
export type ApproverDecision = "approve" | "deny" | "abstain" | "escalate";

export type ApprovalDecision = ApproverDecision | "timeout";

// The requester of a gated action. Agents carry their registry generation for fencing;
// operator/owner (human) requesters have no generation.
export interface ApprovalRequester {
  id: string;
  rank: ApprovalRank;
  generation?: number;
}

// One recorded decision in the authority chain: who decided, at what rank, and why. `who` is
// null only for a timeout (no approver answered); `rank` is then the rung's rank.
export interface ApprovalJournalEntry {
  rung: ApprovalRung;
  rank: ApprovalRank;
  who: string | null;
  decision: ApprovalDecision;
  why: string;
  grantMicros?: number;
  at: number; // epoch ms
}

// A durable, journaled approval record for one gated action.
export interface Approval {
  id: ApprovalId;
  requester: ApprovalRequester;
  action: { kind: string; target: string };
  rungs: ApprovalRung[]; // escalation ladder from the requester's rank upward
  rungIndex: number; // index of the rung awaiting a decision; === rungs.length means past the top
  state: ApprovalState;
  host: HostId;
  journal: ApprovalJournalEntry[];
  deadlineAt: number; // fail-closed timeout for the CURRENT rung (epoch ms); re-based on each rung advance
  rungMs?: number; // per-rung window (deadlineAt - createdAt at create); absent on rows created before per-rung windows existed, where deadlineAt then stays put on advance
  rungWindowsMs?: number[]; // per-rung windows by rung index (from NewApproval.rungWindowsMs); overrides rungMs where present
  createdAt: number;
  decidedAt: number | null;
  // When the settled decision was delivered to its requester (the approval_decided signal enqueued and the wake attempted), via
  // ApprovalStore.markNotified. Absent: not delivered yet, so the reconcile sweep still owes it (fixed: approval replay).
  notifiedAt?: number;
}

export interface NewApproval {
  id: ApprovalId;
  requester: ApprovalRequester;
  action: { kind: string; target: string };
  host: HostId;
  deadlineAt: number;
  rungs?: ApprovalRung[]; // default: rungsAbove(requester.rank)
  rungWindowsMs?: number[]; // window of each rung by index; the first sets deadlineAt's window, the rest re-base on advance
}

export interface NewApprovalDecision {
  who: string; // approver id (agent id or human principal)
  rank: ApprovalRank; // must strictly exceed the requester's rank
  decision: ApproverDecision;
  why: string;
  grantMicros?: number; // budget_raise: amount the approver grants (recorded on the journal entry)
}

// Result of applying a decision through the pure approval policy (packages/core approval.ts).
export interface ApprovalOutcome {
  state: ApprovalState;
  nextRung: ApprovalRung | null; // next rung to await, or null when settled/past the top
  failClosed: boolean; // true when denial came from running past the top rung
}

export type ScheduleId = string;

export type MissedPolicy = "skip" | "run-one" | "catch-up";
export type OverlapPolicy = "skip" | "queue";

// A cron schedule: the operator's static config plus the createdAt cursor used to bound
// missed-run back-fill. Each firing spawns a child of the root supervisor with a task key
// derived from the schedule id and scheduled time (so a repeated firing is a duplicate).
export interface Schedule {
  id: ScheduleId;
  cron: string; // 5-field cron expression
  tz?: string; // IANA name; default UTC
  task: string; // the prompt for the spawned root child
  missed: MissedPolicy; // what to do with fires missed while down
  overlap: OverlapPolicy; // what to do when the previous run is still going
  jitterMs: number; // max de-sync delay (deterministic, hashed from id)
  paused?: boolean; // a paused schedule is kept but never fires; absent = false
  failures?: number; // consecutive failed fires (the cron circuit breaker); absent = 0
  retryAt?: number; // epoch ms: no fire is attempted before this while the breaker is open
  // Targeted wakeup: when `agent` is set the schedule never spawns; each fire delivers `task` to that agent
  // (steer when pending/running/waiting, wake when yielded). Unset = spawn a fresh child of the root (default).
  agent?: AgentId;
  createdBy?: AgentId; // the agent that created it; absent = operator. An agent-created schedule dies with its agent.
  orphaned?: boolean; // the target exited: the schedule is kept but never fires until retargeted (PUT) or removed
  // Spawn parameters (agent unset only), validated like a spawn request; precedence request > template > daemon default.
  budgetMicros?: number;
  // Wall-clock deadline in milliseconds. Omitted means use the daemon's configured default;
  // zero is an explicit unlimited request (only the operator spawn route may make one).
  deadlineMs?: number;
  template?: TemplateId;
  model?: { provider: string; id: string };
  createdAt: number; // epoch ms; the missed-run cursor starts here for a never-fired schedule
}

export type HostState = "ready" | "draining" | "unknown" | "lost";

// A machine that can run sandboxes (the local one is a LocalNode). Held in the HostStore, never in daemon memory.
export interface HostRecord {
  id: HostId;
  labels: Record<string, string>;
  capacity: Resources & { maxSessions: number };
  images: string[]; // cached image digests
  state: HostState;
  createdAt: number;
  updatedAt: number;
}

export type NewHost = Omit<HostRecord, "createdAt" | "updatedAt">;

// An agent's claim on a host: `running` holds capacity, `queued` waits for it.
// TODO(multi-host): an expiring `reserved` state needs the node's start acknowledgement (multi-node work); current behavior: admit goes straight to `running`.
export interface Reservation {
  agent: AgentId;
  host: HostId | null; // null while queued
  state: "queued" | "running";
  priority: number; // lower runs first
  seq: number; // arrival order, breaks priority ties
  resources: Resources;
  template: TemplateId | null;
  createdAt: number;
}

export type NewReservation = Omit<Reservation, "seq" | "createdAt">;

// Read-only snapshot of a host's placement state for the operator UI's host/queue tab.
export interface PlacementStatus {
  host: HostId;
  maxConcurrent: number;
  running: AgentId[];
  queue: { agent: AgentId; priority: number }[];
}

// "quarantined" is terminal: the ladder never climbs past it.
export type WatchdogRung = "none" | "nudged" | "cancelled" | "escalated" | "quarantined";

// Durable watchdog ladder position, moved out of daemon memory so a restart keeps the
// escalation ladder (nudge -> cancel -> kill_resume -> escalate -> quarantine).
export interface WatchdogState {
  rung: WatchdogRung;
  lastActionAt: number | null;
  retries: number; // kill_resume count so far
  restarts?: number[]; // epoch ms of each watchdog restart (restart-intensity window); absent = none
  quarantined?: boolean; // set once the agent is quarantined; absent = false
}

// Convention for the `pomtree result` payload (AgentRecord.result): `summary` is required and non-empty; extra keys pass through.
export interface Handoff {
  summary: string; // <= 8 KB
  files?: string[];
  notes?: string;
  synthesized?: true; // set by the daemon when the agent wrote no handoff itself
  [extra: string]: unknown;
}

export type Signal =
  // Daemon-owned durable terminal approval notification. Query ApprovalStore through the fenced facade before effects;
  // this signal is a wake hint, never authorization. Ack it after handling like every queued inbox event.
  | { kind: "approval_decided"; approval: ApprovalId; state: "approved" | "denied"; action: { kind: ApprovalKind; target: string } }
  | { kind: "child_result"; child: AgentId; status: "succeeded" | "failed"; handoff: string }
  // The handoff fields are additive: `handoff` is the child's summary (first 2 KB; daemon-synthesized when the
  // child wrote none), `branch` its workspace branch, spend/budget in micro-dollars, `files` the child's listed outputs.
  | {
      kind: "child_exited";
      child: AgentId;
      exit: ExitStatus;
      cause?: ExitCause;
      handoff?: string;
      branch?: string;
      spentMicros?: number;
      budgetMicros?: number;
      files?: string[];
      // Set when the recipient is the custodian, not the parent: names the dead parent.
      custodyOf?: AgentId;
    }
  | { kind: "pause"; reason: string }
  // Daemon-injected when a turn ends passively (no result, yield or user abort): tells the agent to report, yield or keep working.
  | { kind: "nudge"; body: string; attempt: number; max: number }
  | { kind: "cancel"; graceMs: number }
  | { kind: "timeout" }
  | { kind: "budget_exceeded" }
  | { kind: "budget_warning"; remainingMicros: number; budgetMicros: number; thresholdFraction: number }
  // A bubbled ask/approval/budget-raise request addressed to the current holder; answers to an asker reuse human_answer.
  | {
      kind: "escalation";
      escalation: EscalationId | ApprovalId;
      subject: "ask" | "approval" | "budget_raise";
      from: AgentId;
      body: string;
      options?: string[];
      requestedMicros?: number;
      spentMicros?: number;
      budgetMicros?: number;
      deadlineAt: number;
    }
  | { kind: "message"; from: AgentId; body: string; interrupt?: true }
  | { kind: "human_answer"; escalation: EscalationId; from: MessagingSender; body: string }
  // `interrupt: true` (operator "interrupt and steer now"): mailboxes order it ahead of queued signals and the
  // mailbox extension aborts the current turn before injecting; absent = queue (delivered at the next boundary).
  | { kind: "human_message"; from: MessagingSender; body: string; interrupt?: true };

// A signal's id is the idempotency key of the send that enqueued it; it is not stored inside Signal.
export type SignalId = string;
export type Delivered<S = Signal> = S & { id: SignalId };

// Level kinds describe a state, not an event: a newer one supersedes an unconsumed older one of the same
// kind in the same mailbox (latest wins). Every other kind queues.
export const LEVEL_KINDS = ["nudge", "cancel", "timeout", "pause", "budget_exceeded", "budget_warning"] as const;
export type LevelKind = (typeof LEVEL_KINDS)[number];
export function isLevelKind(kind: string): kind is LevelKind {
  return (LEVEL_KINDS as readonly string[]).includes(kind);
}

// Normalized harness events; the journal and all readers depend on this, never on Pi's format.
export type HarnessEvent =
  | { kind: "message"; role: "assistant" | "user"; text: string }
  | { kind: "tool_call"; tool: string; callId: string; input: unknown }
  // `details`: optional structured metadata the tool returned beside its text (e.g. a poll count). Bounded by boundToolDetails
  // (tool-details.ts): at most MAX_TOOL_DETAILS_BYTES of JSON, otherwise a closed drop marker; never model-visible text.
  | { kind: "tool_result"; callId: string; ok: boolean; output: string; details?: JsonValue }
  // `model` is the run's resolved spec model id, stamped by the daemon at ingestion (absent when none
  // resolved); it lets a zero-cost event be catalog-priced per event. `costMicros` is the reported cost,
  // or the catalog price the daemon substituted for a zero-cost event (informational, never authoritative).
  // The daemon joins each usage event to the model proxy's settlement of the same call (see UsageCostSource, kinds.ts): when
  // it finds one, `costMicros` is that settled charge, `requestId` is the settlement's, and `harnessCostMicros` keeps the
  // harness's own figure (Pi prices and rounds on its side, so it can differ by a micro). A reader sums `costMicros` once per
  // `requestId` and never adds the settlement entry's `micros` on top. The join is exact on `responseId` (the provider's
  // response id, which the proxy records on the settlement); an event without one, or with no matching settlement, stays
  // unjoined. `costMicros: null` means the harness did not report a cost (distinct from a real zero); the daemon then
  // catalog-prices it when it can. `cacheReadTokens` / `cacheWriteTokens`, `provider` and `stopReason` are as the harness
  // reported them.
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      costMicros: number | null;
      model?: string;
      costSource?: UsageCostSource;
      requestId?: string;
      harnessCostMicros?: number;
      responseId?: string;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      provider?: string;
      stopReason?: string;
    }
  | { kind: "error"; message: string }
  // Text the user typed in the interactive TTY (Pi `input` event, source "interactive"); never mailbox-injected input.
  | { kind: "user_input"; text: string }
  // `funding`: the provider account is out of credits; `config`: the provider rejected the request shape (base URL or model id). Both,
  // like `auth`, are never retryable: the daemon stops the run at once.
  | { kind: "provider_error"; code: "outage" | "rate_limit" | "auth" | "funding" | "config"; message: string; retryable: boolean }
  // Stream-only (never journaled): the agent finished a turn and is idle. Emitted only by a harness whose process
  // outlives the turn (interactive TTY); the consumer decides whether that means "done" (a result exists) or "waiting".
  // `aborted` is set when the user aborted the turn (Pi: the last assistant message has stopReason "aborted").
  | { kind: "settled"; aborted?: true };

export type LifecycleEvent =
  | { kind: "spawned"; template?: TemplateId }
  | { kind: "started" | "yielded" | "resumed" | "reaped" }
  | { kind: "exited"; exit: ExitStatus; cause?: ExitCause }
  | { kind: "report_published"; report: ReportId; name: string; sizeBytes: number };

export type ExtensionId = string;

export interface ExtensionSpec {
  name: ExtensionId;
  description: string;
  inputSchema: unknown;
  streaming: boolean;
}

export interface ExtensionSummary {
  bytes: number;
  mediaType: string;
  sha256: string;
}

export interface ExtensionResult {
  ok: boolean;
  denied?: boolean;
  reason?: string;
  result?: unknown;
  summary?: ExtensionSummary;
}

// Why an agent yielded under the hood (a long wait); journaled with `pausing` so the resume can say what happened.
export type WaitCtx =
  | { kind: "child"; child: AgentId; timeoutMs: number; at: number }
  | { kind: "inbox"; timeoutMs: number; at: number }
  | { kind: "ask"; escalation: string; timeoutMs: number; at: number };

// A user-bound outbound message (the adapters' outbox, GET /v1/messages). `replyTo` names what a reply answers: an escalation
// id (`es-…`) or an approval id. `subjectKind` says which, so an adapter renders the right controls without sniffing the id
// prefix: "ask" for an ask/escalation reply, "approval" for an approval decision (approve/deny/pass). `options` are the ask's
// offered answers, in order, for an adapter to render as buttons; absent = free text only. Both are optional and additive:
// an entry journaled before they existed, or by a producer that does not set them, has neither, and an adapter falls back to
// its previous behavior (text reply; id-prefix sniffing until every producer sets `subjectKind`). Producers that must set them
// (pomtreed): Daemon.sendToUser and its callers, escalation.ts alertApproval/notifyApprovalAsk ("approval"), the ask relay in
// to-user.ts relayOf ("ask", plus the ask's options).
export interface MessageSentPayload {
  kind: "message_sent";
  channel: MessagingChannel;
  purpose: MessageKind;
  subject: string;
  replyTo?: EscalationId;
  subjectKind?: "ask" | "approval";
  options?: string[];
}

// A messaging adapter's dead-lettered outbound message, journaled on the root (POST /v1/messages/failed).
export interface MessageFailedPayload {
  kind: "message_failed";
  channel: MessagingChannel;
  purpose: MessageKind;
  subject: string;
  reason: string;
  attempts?: number;
}

export type JournalPayload =
  | Exclude<HarnessEvent, { kind: "settled" }>
  | LifecycleEvent
  | { kind: "signal"; signal: Signal }
  | { kind: "escalation_raised"; escalation: EscalationId; question: string }
  | { kind: "escalation_answered"; escalation: EscalationId; answeredBy: MessagingSender; answer: string }
  | MessageSentPayload
  | { kind: "message_received"; channel: MessagingChannel; from: MessagingSender; to: AgentId | null; body: string; interrupt?: true }
  | { kind: "provider_paused"; scope: "agent" | "tree"; reason: string }
  | { kind: "provider_resumed"; scope: "agent" | "tree" }
  | { kind: "host_error"; component: "sandbox" | "journal" | "workspace" | "gateway" | "daemon"; message: string }
  | MessageFailedPayload
  | { kind: "ingested"; refs: { ref: string; commit: string }[]; forced?: undefined; forcedFrom?: undefined }
  // A forced ingest (operator-only): `forcedFrom` names each ref whose tip was overwritten, so the lost commit can still be named.
  | { kind: "ingested"; refs: { ref: string; commit: string }[]; forced: true; forcedFrom: ForcedRefUpdate[] }
  | { kind: "ingest_failed"; code: IngestFailCode; message: string }
  | { kind: "workspace_evicted"; workspace: WorkspaceId; reason: "reaped" | "idle" | "disk_pressure" | "operator" }
  | { kind: "pausing"; reason?: string; key: string; attempt: string; wait: WaitCondition | null; inbox: string[]; ctx?: WaitCtx } // journaled before the container stops so recovery can finish the checkpoint; `inbox` is the signal ids seen at the yield request
  | { kind: "merge_failed"; child: AgentId; code: "conflict" | "empty" | "unknown"; message: string }
  | { kind: "merged"; child: AgentId; target: string; commit: string; alreadyMerged?: true }
  | { kind: "merge_conflict"; child: AgentId; paths: string[]; targetTip: string; sourceTip: string; round: number }
  | { kind: "check_failed"; child: AgentId; summary: string; candidate: string; round: number }
  | { kind: "merge_escalated"; child: AgentId; reason: "conflict" | "check_failed"; rounds: number; paths?: string[]; summary?: string }
  | { kind: "proxy_call"; extension: ExtensionId; callId: string; input: unknown }
  | { kind: "proxy_result"; callId: string; ok: boolean; denied?: boolean; reason?: string; summary?: ExtensionSummary }
  // Typed `ext.pomtreed.*` payloads (kinds.ts). Each is also an `ext.*` kind, so a reader that narrows on `kind` alone still
  // sees the ExtensionJournalPayload member; the typed members let a producer journal them without a cast.
  | ModelSettlementJournalPayload
  | BudgetEscalatedJournalPayload
  | BudgetGrantedJournalPayload
  | BudgetDeniedJournalPayload
  | BudgetOverageJournalPayload
  | BudgetTopUpJournalPayload
  | BudgetWithdrawalJournalPayload
  | ExtensionJournalPayload;

export interface JournalEntry {
  seq: number; // global, monotonically increasing; assigned by the journal
  ts: number;
  agent: AgentId;
  host: HostId;
  generation: number;
  traceparent?: string;
  payload: JournalPayload;
}

export type NewJournalEntry = Omit<JournalEntry, "seq" | "ts"> & { idempotencyKey: string };

// Durable keyed state, owned by an extension (by name) or the operator. Documents are JSON, revisioned for compare-and-set.
export type StateOwner = string; // an extension name or "operator"; `^[a-z0-9][a-z0-9_-]*$`
export type StateKey = string; // matches STATE_KEY_RE, <= STATE_KEY_MAX_LENGTH chars, no ".." segment content
export const STATE_KEY_MAX_LENGTH = 128;
export const STATE_KEY_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
export const STATE_OWNER_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Hard per-document ceiling; configured limits may only be lower.
export const STATE_DOC_BYTES_CEILING = 1024 * 1024;
// Largest configurable maxDocBytes: the ceiling less room for the request envelope (owner, key, idempotency key, JSON punctuation), so a
// maximal document always fits one JSON request body under the daemon's 1 MiB limit (MAX_BODY in pomtreed server.ts).
export const STATE_DOC_BYTES_CONFIG_MAX = STATE_DOC_BYTES_CEILING - 16 * 1024;
// Hard per-owner cap on retained tombstones; configured limits may only be lower.
export const STATE_TOMBSTONES_CEILING = 100_000;

// Who wrote a state doc: a live agent through /v1/state (fenced by its generation), the operator, or a reviewed workflow through
// ctx.workflow.store/shared, stamped by its qualified name (`<ext>/<workflow>`) and instance ("" when it declares none), never by
// the task that ran it, so a repaired task replays the same logical write and an agent can never present as a workflow.
export type StateWriter = { agent: AgentId; host: HostId; generation: number } | { operator: true } | { workflow: string; instance: string };

export interface StateDoc {
  owner: StateOwner;
  key: StateKey;
  rev: number; // CAS counter, starts at 1, never restarts (a removed doc keeps its rev as a tombstone; a purged one raises the owner's rev floor)
  value: JsonValue;
  bytes: number; // size of the canonical JSON encoding of value
  createdAt: number;
  updatedAt: number;
  writer: StateWriter;
}

export type StateMeta = Omit<StateDoc, "value">;

export interface StateLimits {
  maxDocs: number;
  maxDocBytes: number;
  maxOwnerBytes: number;
  maxTombstones: number; // removed-doc rows kept per owner; beyond it the oldest are purged and the owner's rev floor rises
}

export const STATE_LIMITS_DEFAULT: StateLimits = {
  maxDocs: 1000,
  maxDocBytes: 128 * 1024,
  maxOwnerBytes: 16 * 1024 * 1024,
  maxTombstones: 1000,
};

export interface StateUsage {
  docs: number;
  bytes: number;
}

// The single definition of a valid state key: regex, length bound, and no ".." anywhere.
export function validStateKey(key: string): boolean {
  return key.length <= STATE_KEY_MAX_LENGTH && !key.includes("..") && STATE_KEY_RE.test(key);
}
