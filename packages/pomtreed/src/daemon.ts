import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import {
  CODE_TEMPLATE_ID,
  SandboxUnavailableError,
  StaleGenerationError,
  waitingStep,
  mergeJournalPayload,
  mergeResumeKey,
  DEFAULT_DENIED_PATHS,
  pathDenied,
} from "@pomtree/core";
import { lastMergeFailure, mergeTarget, resumeWake, scrubResult } from "./merge-route.ts";
import type { MergeOutcome as MergeAnswer } from "./merge-route.ts";
import type {
  AgentId,
  AgentRecord,
  AgentState,
  Approval,
  Checkpoint,
  Delivered,
  Escalation,
  EscalationId,
  ExitCause,
  ExitStatus,
  ExtensionId,
  ExtensionResult,
  ExtensionSpec,
  HarnessEvent,
  HarnessSession,
  IngestResult,
  ExtensionJournalPayload,
  JournalEntry,
  JournalPayload,
  Journal,
  MessageFailedBody,
  MessageKind,
  MessagingChannel,
  MessagingSender,
  OutboxEntry,
  MergeResult,
  PlacementStatus,
  Signal,
  SpawnSpec,
  Template,
  TemplateStore,
  WaitCondition,
  WatchdogState,
  WatchdogStore,
  Workspace,
  WorkspaceId,
} from "@pomtree/core";

import { PRIORITY } from "@pomtree/sched";
import { parseTranscript } from "./transcript.ts";
import { gateReason, pendingReasons, PENDING_REASON_KIND } from "./auto-sessions.ts";
import { ProviderBreaker } from "./provider-breaker.ts";
import { DEFAULT_LIMITS, LifecycleError, isResourceError } from "./lifecycle.ts";
import type { Limits } from "./lifecycle.ts";
import type { Driver } from "./orchestrator.ts";

import { buildVersion, gitSha, imageRevision, revisionMismatch } from "./revision.ts";
import { DEADLINE_KIND, HOST_HEALTH_KIND } from "./watchdog.ts";

export * from "./daemon-types.ts";
import type { CaptureJournalPayload } from "./capture/types.ts";
export { EXPIRED_ANSWER, journalRow, journalSummary } from "./daemon-util.ts";
import type {
  ActionResult,
  ChannelAction,
  DaemonDeps,
  Live,
  JournalRow,
  InboundMessage,
  MessageReceipt,
  SpawnRequest,
  DeterministicStartRequest,
} from "./daemon-types.ts";
import { CLI_CHANNEL } from "./channels.ts";
import type { WaitCtx } from "./daemon-util.ts";
import { Locks } from "./daemon/ctx.ts";
import type { DaemonCtx, ForceResumeCause, UserMessageExtra } from "./daemon/ctx.ts";
import { Budget } from "./daemon/budget.ts";
import { sandboxOwner } from "./daemon/sandbox-ops.ts";
import { Escalation as EscalationModule } from "./daemon/escalation.ts";
import { Merge } from "./daemon/merge.ts";
import { Messaging } from "./daemon/messaging.ts";
import { Lifecycle } from "./daemon/lifecycle.ts";
import { Reconcile } from "./daemon/reconcile.ts";

export { PAUSE_ABORTED } from "./daemon/lifecycle.ts";
import { Sweeps } from "./daemon/sweeps.ts";
import { Tree } from "./daemon/tree.ts";
import { toUser } from "./to-user.ts";
import { tracedJournal } from "./trace-context.ts";
import {
  redactPaths,
  capToolPayload,
  redactPayload,
  specResources,
  containerSpec,
  journalRow,
  OP_KIND,
  PUBLISHED_KIND,
  clipText,
  escalationIdFor,
  isStoreDown,
  journalFailed,
  extCallIdFor,
  sleep,
  transitionKey,
} from "./daemon-util.ts";

const ASK_OPTIONS_MAX = 10;
const ASK_OPTION_MAX = 200;
// A bounded default makes every spawned agent finite-lived unless an operator explicitly
// configures a different (still bounded) policy at daemon startup.
export const DEFAULT_SESSION_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_MAX_SESSION_MS = DEFAULT_SESSION_MS;

type SessionDeadlineDeps = { defaultSessionMs?: number; maxSessionMs?: number };

export function sessionDeadlineConfig(deps: SessionDeadlineDeps): { defaultSessionMs: number; maxSessionMs: number } | null {
  // With neither value set there is no default or maximum session length; only an explicit per-spawn deadlineMs
  // applies. main.ts always supplies both.
  if (deps.defaultSessionMs === undefined && deps.maxSessionMs === undefined) return null;
  const defaultSessionMs = deps.defaultSessionMs ?? DEFAULT_SESSION_MS;
  const maxSessionMs = deps.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
  for (const [name, value] of [
    ["defaultSessionMs", defaultSessionMs],
    ["maxSessionMs", maxSessionMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (defaultSessionMs > maxSessionMs) throw new Error("defaultSessionMs must not exceed maxSessionMs");
  return { defaultSessionMs, maxSessionMs };
}

export type { MergeOutcome, ReapOutcome } from "./daemon/lifecycle.ts";
import type { ReapOutcome } from "./daemon/lifecycle.ts";

export { credentialPath } from "./daemon-util.ts";

export class Daemon implements Driver {
  private live = new Map<AgentId, Live>();
  private rootIdHint: AgentId | null = null; // cache of a registry fact (the root's id), not state
  // Runtime wake callbacks for queued admissions (TODO(rule6): by nature process-local; a restart re-enters admit()
  // from recover(), and each waiter also has an admitRetryMs safety-net timer, so losing the map loses nothing).
  private admitWaiters = new Map<AgentId, () => void>();
  private pendingSeq = 0; // keys each pending-reason change (with bootNonce) so a repeated reason after a change still journals
  // Runtime host-health flags (not durable; the durable facts are the journal's
  // host_error entry and the registry state). sandboxUp=false holds admission until the periodic probe
  // succeeds; journalFailed is set once on a resource-error journal append and holds admission too.
  private sandboxUp = true;
  private journalFailed = false;
  // Store down (SQLITE_FULL/IOERR/CORRUPT/BUSY or ENOSPC): a durable write failed, so admission holds
  // and spawn 503s until the store recovers. Fail closed so a half-settled agent cannot strand runtime
  // resources behind a store that will not take the write.
  private degraded = false;
  // Supervisor drain: once set, admission releases queued work and spawns 503.
  // Containers are left running (adoptable via Sandbox.attach on the next boot) rather than SIGKILLed.
  private draining = false;
  // Revision-skew journaled-once flag: the boot-time mismatch is journaled as a host_error at the
  // first admission, so it is visible in ps/show/trace without rerunning doctor.
  private revisionWarned = false;
  private breaker!: ProviderBreaker;
  // In-flight resumes per agent: two concurrent satisfying wakes share one resume.
  private readonly resuming = new Map<AgentId, Promise<AgentRecord>>();
  private readonly locks = new Locks();
  private readonly tree: Tree;
  private readonly messaging: Messaging;
  private readonly escalation: EscalationModule;
  private readonly budget: Budget;
  private readonly merger: Merge;
  private readonly sweeps: Sweeps;
  private readonly reconciler: Reconcile;
  private readonly lifecycle: Lifecycle;
  readonly deps: DaemonDeps;
  readonly limits: Limits;
  readonly epoch: string;
  private readonly redactRoots: string[];
  private probeSeq = 0;
  // Post-recovery pass rate limit (probeStore): consecutive recovery passes that left the store latched again, when the next
  // recovery pass may fire, and the flap episode (keys the one alert).
  private relatches = 0;
  private nextRecoveryAt = 0;
  private flapEpisode = 0;
  private flapAlerted = false;
  private readonly sessionDeadline: { defaultSessionMs: number; maxSessionMs: number } | null;

  constructor(input: DaemonDeps) {
    // Every journal write the daemon makes carries its agent's trace context (trace-context.ts), however the daemon was built: main.ts,
    // a live entry or a test. Wrapping is idempotent, so a journal that is already traced (openDaemonStore) is used as is.
    const deps: DaemonDeps = { ...input, journal: tracedJournal(input.journal, (id) => input.registry.get(id)) };
    this.deps = deps;
    this.epoch = deps.epoch ?? String((deps.now ?? Date.now)());
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.sessionDeadline = sessionDeadlineConfig(deps as DaemonDeps & SessionDeadlineDeps);
    // Host state roots (and their realpaths) that error text must not carry into a journal row.
    this.redactRoots = [...(deps.redactRoots ?? []), deps.sessionRoot, ...(deps.socketHostPath ? [deps.socketHostPath] : [])].flatMap((r) =>
      existsSync(r) ? [r, realpathSync(r)] : [r],
    );
    this.breaker = new ProviderBreaker({ threshold: this.limits.providerBreakerThreshold, windowMs: this.limits.providerBreakerWindowMs });
    const ctx: DaemonCtx = {
      deps,
      limits: this.limits,
      now: () => this.now(),
      random: () => this.random(),
      record: (r, payload, key) => this.record(r, payload, key),
      withLock: (key, fn) => this.locks.withLock(key, fn),
      hub: {
        root: { root: () => this.root() },
        kicks: { onKick: (agent, fn) => this.lifecycle.onKick(agent, fn), kick: (agent) => this.lifecycle.kick(agent) },
        user: { sendToUser: (a, purpose, subject, key, replyTo, extra) => this.sendToUser(a, purpose, subject, key, replyTo, extra) },
        operator: { messageAgent: (agent, body, key, mode, o) => this.messageAgent(agent, body, key, mode, o) },
        escalation: {
          answerEscalation: (id, answer, by, key) => this.escalation.answerEscalation(id, answer, by, key),
          passEscalation: (id, agent, key) => this.escalation.passEscalation(id, agent, key),
          answerEscalationAs: (agent, id, answer, key) => this.escalation.answerEscalationAs(agent, id, answer, key),
          openApproval: (agent, kind, target, key) => this.escalation.openApproval(agent, kind, target, key),
          getApprovalFor: (agent, id) => this.escalation.getApprovalFor(agent, id),
          decideApproval: (id, decision, who, why, key, as) => this.escalation.decideApproval(id, decision, who, why, key, as),
          requireApproval: (agent, kind, target, key) => this.escalation.requireApproval(agent, kind, target, key),
          safeWake: (agent, signal, rec, errKey) => this.escalation.safeWake(agent, signal, rec, errKey),
          ask: (agent, req) => this.ask(agent, req),
        },
        budget: {
          isParked: (r) => this.budget.isBudgetParked(r),
          applyDecision: (requester) => this.budget.applyBudgetDecision(requester).catch((e) => this.hookError(requester, e)),
        },
        reconcile: {
          isQuarantined: (a) => this.reconciler.isQuarantined(a),
          isHeld: (id) => this.reconciler.isHeld(id),
          journalError: (a, e) => this.reconciler.journalReconcileError(a, e),
          reclaimSandbox: (r, force) => this.reconciler.reclaimSandbox(r, force),
        },
        ops: {
          seen: (agent, op, key) => this.opSeen(agent, op, key),
          find: (agent, op, key) => this.opFind(agent, op, key),
          mark: (rec, op, key, extra) => this.markOp(rec, op, key, extra),
        },
        lifecycle: {
          // Via the Daemon delegate (like yield): the operator cancel route reaches it through performAction, and daemon.cancel stays the one seam tests wrap.
          cancel: (id, graceMs, key) => this.cancel(id, graceMs, key),
          spawn: (requester, req) => this.lifecycle.spawn(requester, req),
          exclusiveSpawn: (fn) => this.lifecycle.exclusiveSpawn(fn),
          resumeAgent: (agent, wake, opts, key) => this.lifecycle.resumeAgent(agent, wake, opts, key),
          forceResume: (agent, observedGeneration, cause, o) => this.lifecycle.forceResume(agent, observedGeneration, cause, o),
          finish: (id, exit, result, cause) => this.lifecycle.finish(id, exit, result, cause),
          // Via the Daemon delegate on purpose: Lifecycle's own yield calls come back through here, so daemon.budget.test.ts can wrap `daemon.yield`.
          yield: (agent, o) => this.yield(agent, o),
          stopCheckpoint: (r, key, wait, workspace) => this.lifecycle.stopCheckpoint(r, key, wait, workspace),
          withFolderLock: (agent, fn) => this.sweeps.withFolderLock(agent, fn),
          deliver: (agent, signal, source) => this.lifecycle.deliver(agent, signal, source),
          reap: (id) => this.lifecycle.reap(id),
          requireMergeSettled: (id) => this.merger.requireMergeSettled(id),
          orphanChildren: (parent, open) => this.lifecycle.orphanChildren(parent, open),
          finishTail: (upd, exit, cause) => this.lifecycle.finishTail(upd, exit, cause),
          wakeResume: (agent, signal) => this.lifecycle.wakeResume(agent, signal),
          canContinue: (agent) => this.lifecycle.canContinue(agent),
          checkWorkflowWait: (agent) => this.lifecycle.checkWorkflowWait(agent),
          recoverWorkflow: (agent) => this.lifecycle.recoverWorkflow(agent),
          yieldInbox: (id, cp) => this.lifecycle.yieldInbox(id, cp),
          reportedResult: (r) => this.lifecycle.reportedResult(r),
          notifyResult: (child, status, result) => this.lifecycle.notifyResult(child, status, result),
          pausingMarker: (a) => this.lifecycle.pausingMarker(a),
          completePause: (a, m) => this.lifecycle.completePause(a, m),
          adoptRunning: (id, sandboxId, gen, reported) => this.lifecycle.adoptRunning(id, sandboxId, gen, reported),
          restartCount: (id) => this.lifecycle.restartCount(id),
          armDeadline: (e, deadlineAt) => this.lifecycle.armDeadline(e, deadlineAt),
        },
        claim: {
          tryClaim: (id, purpose) => this.lifecycle.tryClaim(id, purpose),
          releaseClaim: (id, claim) => this.lifecycle.releaseClaim(id, claim),
          markDirty: (id) => this.lifecycle.markDirty(id),
          startingGeneration: (id) => this.lifecycle.startingGeneration(id),
        },
        host: {
          admit: (id, priority) => this.admit(id, priority),
          push: (agent, generation, key, bundle, maxBytes, opts) => this.push(agent, generation, key, bundle, maxBytes, opts),
        },
        store: {
          markDown: (e) => this.markStoreDown(e),
          hostUp: () => this.sandboxUp && !this.journalFailed && !this.degraded,
          markSandboxDown: () => this.markSandboxDown(),
          draining: () => this.draining,
          degraded: () => this.degraded,
          journalFailed: () => this.journalFailed,
        },
      },
    };
    this.tree = new Tree(ctx);
    this.messaging = new Messaging(ctx, this.tree);
    this.escalation = new EscalationModule(ctx, this.tree, this.messaging);
    this.budget = new Budget(ctx, this.tree, this.escalation, this.live, this.sessionDeadline);
    this.merger = new Merge(ctx, this.tree, (text) => this.redactText(text));
    this.sweeps = new Sweeps(ctx, this.tree, this.budget, this.live, this.resuming);
    this.reconciler = new Reconcile(ctx, this.tree, this.escalation, this.budget, this.live, this.epoch);
    this.lifecycle = new Lifecycle(
      ctx,
      this.tree,
      this.messaging,
      this.budget,
      this.merger,
      this.sweeps,
      this.reconciler,
      this.live,
      this.resuming,
      this.breaker,
      this.epoch,
    );
    deps.orchestrator.bind(this);
  }

  // A journal payload with every configured host path replaced by a placeholder; for the journal writers outside `record`
  // (extensions, the drain-time host_error in main.ts).
  redact(payload: JournalPayload): JournalPayload {
    return redactPayload(payload, this.redactRoots);
  }

  // Text with every configured host path replaced by a placeholder (also what main.ts hands the merge engine).
  redactText(text: string): string {
    return redactPaths(text, this.redactRoots);
  }

  now() {
    return (this.deps.now ?? Date.now)();
  }

  private random(): number {
    return (this.deps.random ?? Math.random)();
  }

  // Messaging owns the boot nonce and the inbound receipt cache; Daemon (and tests) reach them through these facades.
  private get bootNonce(): string {
    return this.messaging.bootNonce;
  }

  private get inboundReceipts(): Map<string, MessageReceipt> {
    return this.messaging.inboundReceipts;
  }

  // Budget owns the deadline map and the loaded-set; the arm/rearm/extend code (and tests) reach them through these facades.
  private get deadlines(): Map<AgentId, number> {
    return this.budget.deadlines;
  }

  private get deadlineLoaded(): Set<AgentId> {
    return this.budget.deadlineLoaded;
  }

  // Reconcile owns the boot-only lost-wake scan flag; tests reset it through this facade to simulate a fresh boot.
  private get lostWakeScanned(): boolean {
    return this.reconciler.lostWakeScanned;
  }

  private set lostWakeScanned(v: boolean) {
    this.reconciler.lostWakeScanned = v;
  }

  private rootAgentId(): Promise<AgentId> {
    return this.tree.rootAgentId();
  }

  private defaultSpec(): SpawnSpec {
    return this.tree.defaultSpec();
  }

  private resolveTemplate(name: string): Promise<Template | null> {
    return this.tree.resolveTemplate(name);
  }

  private resolvedSpec(t: Template | null, inherit?: SpawnSpec, pick?: { provider: string; id: string }): SpawnSpec {
    return this.tree.resolvedSpec(t, inherit, pick);
  }

  // Host-internal seams for the workflow capability host (workflow-capabilities.ts). Root-owned: the root journal, the root's
  // user outbox (one `report` message per channel, via the one sendToUser writer) and nothing else.
  async workflowRecord(payload: ExtensionJournalPayload, key: string): Promise<JournalEntry> {
    return this.record(await this.root(), payload, key);
  }

  // The journal writer for the capture broker's rows (capture/types.ts CaptureBrokerDeps.record): the named agent's journal, or the
  // root's when that agent is unknown (the operator's requests and job-level steps are journaled on the root).
  async captureRecord(agent: AgentId, payload: CaptureJournalPayload, key: string): Promise<void> {
    const rec = (await this.deps.registry.get(agent)) ?? (await this.root());
    await this.record(rec, payload as unknown as ExtensionJournalPayload, key);
  }

  // The journal writer for state operations (state-routes.ts): the caller's own journal, or the root's for the operator.
  stateRecord(rec: AgentRecord, payload: ExtensionJournalPayload, key: string): Promise<JournalEntry> {
    return this.record(rec, payload, key);
  }

  async workflowReadRoot(from: number, limit: number): Promise<JournalEntry[]> {
    return this.deps.journal.read({ from, agent: (await this.root()).id, limit });
  }

  async workflowMessage(body: string, key: string): Promise<void> {
    await this.sendToUser(await this.root(), "report", body, key);
  }

  // The root supervisor of this host (root-id): a stable id derived from the host id (rootAgentIdFor), found by that id, else
  // created with it. Never keyed on the idempotency row alone, so pruning that row cannot create a second root with a fresh pool.
  async root(): Promise<AgentRecord> {
    const d = this.deps;
    const found = await d.registry.get(this.rootIdHint ?? rootAgentIdFor(d.hostId));
    const created =
      found ??
      (await d.registry.create({
        id: rootAgentIdFor(d.hostId),
        parent: null,
        name: "root",
        task: "root supervisor",
        host: d.hostId,
        budgetMicros: d.rootBudgetMicros,
        idempotencyKey: `root:${d.hostId}`,
        spec: this.defaultSpec(),
      }));
    this.rootIdHint = created.id;
    // A replayed idempotent create returns the original (pending) snapshot, so re-read the live state.
    let rec = (await d.registry.get(created.id)) ?? created;
    if (rec.state === "pending") {
      rec = await d.registry.transition(rec.id, rec.generation, "running", { idempotencyKey: transitionKey(rec.id, rec.generation, "running") });
      await this.record(rec, { kind: "started" }, `${rec.id}:${rec.generation}:started`);
    }
    return rec;
  }

  // Startup reconciliation of the root pool with budget.rootMicros (root-id). The root's budget is the operator-injected total.
  // A different configured value is an explicit operator movement, applied and journaled in one store transaction
  // (Registry.setRootPool; topup-atomic): a higher value journals a `budget_topup` of the delta, a lower one a `budget_withdrawal`
  // of at most the root's unheld remainder (budget-withdrawal). A larger withdrawal throws RootWithdrawalError, which main.ts
  // turns into a refused startup naming the requested, held and available amounts (fail closed). An unchanged value journals
  // nothing, so a restart never re-journals.
  async reconcileRootPool(): Promise<AgentRecord> {
    const d = this.deps;
    const root = await this.root();
    const configured = d.rootBudgetMicros;
    if (configured === root.budgetMicros) return root;
    return (await d.registry.setRootPool(root.id, configured, `root-pool:${d.hostId}:${root.budgetMicros}:${configured}`)).record;
  }

  spawn(requester: AgentId, req: SpawnRequest): Promise<AgentRecord> {
    return this.lifecycle.spawn(requester, req);
  }

  // Internal only (no route, no selector): starts a deterministic task for a host-supplied requester.
  startDeterministic(requester: AgentId, req: DeterministicStartRequest): Promise<AgentRecord> {
    return this.lifecycle.startDeterministic(requester, req);
  }

  private async resolveFork(requester: AgentRecord, req: SpawnRequest): Promise<{ commit?: string; sessionRef?: string; fromAgent?: AgentId } | null> {
    return this.merger.resolveFork(requester, req);
  }

  private async forkSource(id: AgentId): Promise<{ commit?: string; sessionRef?: string; fromAgent?: AgentId } | null> {
    return this.merger.forkSource(id);
  }

  private spawnDeadline(rec: AgentRecord, req: SpawnRequest, requester: AgentRecord | null): Promise<void> {
    return this.budget.spawnDeadline(rec, req, requester);
  }

  // Current durable session deadline (absolute epoch ms; null = none); see Budget.sessionDeadlineAt. Exposed for GET /v1/agents/:id/deadline.
  sessionDeadlineAt(agent: AgentId): Promise<number | null> {
    return this.budget.sessionDeadlineAt(agent);
  }

  // Operator extension of a session's wall-clock deadline (POST /v1/agents/:id/deadline). `deadlineMs`
  // is a relative extension added to the current deadline (or now when none); omitted = the daemon's
  // default session length. Capped at maxSessionMs and the agent's budget owner's deadline, mirroring
  // spawnDeadline. Idempotent by key: the journal replays the first DEADLINE_KIND append for a repeated
  // key, so a replay returns the original deadline and does not extend again.
  async extendDeadline(
    agent: AgentId,
    deadlineMs: number | undefined,
    idempotencyKey: string,
  ): Promise<{ deadlineAt: number | null; previousDeadlineAt: number | null }> {
    if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)) {
      throw new LifecycleError(400, "deadlineMs must be a positive integer");
    }
    const rec = await this.get(agent);
    if (!rec) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (deadlineMs === undefined && !this.sessionDeadline) {
      throw new LifecycleError(400, "no default session deadline configured; provide deadlineMs");
    }
    const previousDeadlineAt = await this.sessionDeadlineAt(agent);
    // No recorded deadline = unlimited (or predates the policy): there is nothing to extend, and
    // "extending" would silently turn it into a limited session.
    if (previousDeadlineAt === null) throw new LifecycleError(409, "agent has no session deadline (unlimited); nothing to extend");
    const live = this.live.get(agent);
    if (live?.timedOut) throw new LifecycleError(409, "session deadline already elapsed; the agent is being stopped");
    const extension = deadlineMs ?? this.sessionDeadline!.defaultSessionMs;
    // An already-passed deadline (timer not yet fired) extends from now, not from the stale time.
    const ownDeadlineAt = Math.max(previousDeadlineAt, this.now()) + Math.min(extension, this.sessionDeadline?.maxSessionMs ?? Infinity);
    const ownerId = this.budgetOwner(rec);
    const ownerDeadlineAt = ownerId ? await this.sessionDeadlineAt(ownerId) : null;
    // The owner's deadline caps the extension but never shortens the current deadline.
    const deadlineAt = Math.max(previousDeadlineAt, Math.min(ownDeadlineAt, ownerDeadlineAt ?? Infinity));
    // Persist keyed (scoped per agent); the journal replays the first append for a repeated key, so
    // the recorded payload is authoritative on replay. `previousAt` rides along so a replay still
    // returns the true previous deadline.
    const entry = await this.record(rec, { kind: DEADLINE_KIND, at: deadlineAt, previousAt: previousDeadlineAt }, `${agent}:deadline:${idempotencyKey}`);
    const p = entry.payload as { at?: unknown; previousAt?: unknown };
    const recordedAt = typeof p.at === "number" && Number.isFinite(p.at) ? p.at : deadlineAt;
    const recordedPrevious = p.previousAt === null || typeof p.previousAt === "number" ? (p.previousAt as number | null) : previousDeadlineAt;
    // A replay (the recorded entry is not the one just computed) is read-only: it must not move the
    // armed deadline back to an older value or re-arm the timer.
    if (recordedAt !== deadlineAt || recordedPrevious !== previousDeadlineAt) return { deadlineAt: recordedAt, previousDeadlineAt: recordedPrevious };
    this.deadlines.set(agent, deadlineAt);
    this.deadlineLoaded.add(agent);
    if (live) this.armDeadline(live, deadlineAt);
    return { deadlineAt, previousDeadlineAt };
  }

  private budgetOwner(a: AgentRecord): AgentId | null {
    return this.tree.budgetOwner(a);
  }

  private ownedChildren(a: AgentRecord): Promise<AgentRecord[]> {
    return this.tree.ownedChildren(a);
  }

  // Who holds `id`'s result when its parent is gone (Tree.custodian); null for an unknown agent.
  async custodianOf(id: AgentId): Promise<AgentId | null> {
    const r = await this.deps.registry.get(id);
    return r ? (await this.tree.custodian(r)).id : null;
  }

  // Whether `caller` may address `rec` as itself, its child or an exited agent it holds in custody (Tree.canWaitOn).
  canWaitOn(caller: AgentId, rec: AgentRecord): Promise<boolean> {
    return this.tree.canWaitOn(caller, rec);
  }

  private addressable(caller: AgentId): Promise<AgentRecord[]> {
    return this.tree.addressable(caller);
  }

  private canAddress(from: AgentId, to: AgentId): Promise<boolean> {
    return this.tree.canAddress(from, to);
  }

  private depth(a: AgentRecord): Promise<number> {
    return this.tree.depth(a);
  }

  private consumed(a: AgentRecord): Promise<number> {
    return this.tree.consumed(a);
  }

  remainingMicros(a: AgentRecord): Promise<number> {
    return this.tree.remainingMicros(a);
  }

  // Optional trailing client key: a replay with the same key returns the first call's unusedMicros.
  // `guard` (the API route, i.e. a parent or operator reaping by hand) refuses an unmerged child; the daemon's own
  // cleanup reaps (a gone parent, the root's children) pass no guard because nobody is left to merge.
  async reap(id: AgentId, key?: string, guard = false): Promise<ReapOutcome> {
    return this.lifecycle.reap(id, key, guard);
  }

  private async requireMergeSettled(id: AgentId): Promise<void> {
    return this.merger.requireMergeSettled(id);
  }

  // Releases every long-poll `agent` is blocked in (interrupt message, cancel).
  private kick(agent: AgentId): void {
    this.lifecycle.kick(agent);
  }

  // Blocks briefly until the agent has exited (or the timeout), woken by the journal's `exited` entry.
  // `waiter` is the calling agent (if any): an interrupt or cancel for it releases the poll at once.
  async waitDone(id: AgentId, timeoutMs: number, waiter?: AgentId): Promise<{ done: boolean; record: AgentRecord }> {
    return this.lifecycle.waitDone(id, timeoutMs, waiter);
  }

  async inbox(id: AgentId, o: { waitMs?: number }): Promise<Delivered[]> {
    return this.messaging.inbox(id, o);
  }

  async peers(caller: AgentId): Promise<Pick<AgentRecord, "id" | "name" | "state">[]> {
    return this.messaging.peers(caller);
  }

  // --- Agent extension gateway (TODO(pi-ext)) ---

  // The extension specs an agent may call: the gateway's full list filtered to the agent's
  // spec.extensions allowlist. An empty allowlist yields none (default-deny).
  async extList(agent: AgentRecord): Promise<ExtensionSpec[]> {
    const allowed = new Set(containerSpec(agent).extensions);
    if (allowed.size === 0) return [];
    const all = (await this.deps.extensions?.list()) ?? [];
    return all.filter((s) => allowed.has(s.name));
  }

  // Proxy one agent extension call through the host gateway, journaled as proxy_call + proxy_result and
  // gated by approveExtension (absent = allow). The deterministic callId links the two journal entries
  // across retries. Non-running agents and extensions outside the agent's allowlist are 403.
  async extCall(agent: AgentRecord, name: ExtensionId, input: unknown, idempotencyKey: string): Promise<ExtensionResult & { callId: string }> {
    if (agent.state !== "running") throw new LifecycleError(403, `agent is ${agent.state}, not running`);
    if (!containerSpec(agent).extensions.includes(name)) throw new LifecycleError(403, `extension ${name} is not enabled for this agent`);
    const gw = this.deps.extensions;
    if (!gw) throw new LifecycleError(404, "extension gateway is not configured");
    const callId = extCallIdFor(agent.id, name, idempotencyKey);
    await this.record(agent, { kind: "proxy_call", extension: name, callId, input }, `${agent.id}:${name}:${idempotencyKey}:call`);
    // Durable approval for extensions the deploy selected; fails closed (403/409 thrown).
    if (this.deps.approvals && this.deps.extApprovalRequired?.(name)) {
      try {
        await this.requireApproval(agent, "extension", name, idempotencyKey);
      } catch (e) {
        if (e instanceof LifecycleError && e.status === 403) {
          await this.record(
            agent,
            { kind: "proxy_result", callId, ok: false, denied: true, reason: e.message },
            `${agent.id}:${name}:${idempotencyKey}:denied`,
          );
        }
        throw e;
      }
    }
    const approval = await this.deps.approveExtension?.({ agent, extension: name, input });
    if (approval && approval.decision === "deny") {
      const reason = approval.reason ?? `extension ${name} was denied`;
      await this.record(agent, { kind: "proxy_result", callId, ok: false, denied: true, reason }, `${agent.id}:${name}:${idempotencyKey}:denied`);
      throw new LifecycleError(403, reason);
    }
    const result = await gw.call(agent.id, name, input, idempotencyKey);
    await this.record(
      agent,
      {
        kind: "proxy_result",
        callId,
        ok: result.ok,
        ...(result.denied !== undefined && { denied: result.denied }),
        ...(result.reason !== undefined && { reason: result.reason }),
        ...(result.summary !== undefined && { summary: result.summary }),
      },
      `${agent.id}:${name}:${idempotencyKey}:result`,
    );
    return { callId, ...result };
  }

  async sendMessage(from: AgentId, to: AgentId, body: string, generation: number, idempotencyKey: string): Promise<Signal> {
    return this.messaging.sendMessage(from, to, body, generation, idempotencyKey);
  }

  // Operator message: an operator posts to any agent. Journals a `message_received` on the target's journal (so
  // operator journal views show it), delivers a `human_message` signal, and asks the orchestrator to wake a
  // yielded target. Idempotent by key at every step (a replay returns the first delivery's outcome).
  // mode "queue" (default): delivered at the agent's next inbox read / wake / steering boundary.
  // mode "interrupt": a yielded target is woken at once whatever its wait condition (the message is its resume
  // prompt); a running target gets the signal flagged `interrupt` (ordered first in its mailbox, for the mailbox
  // extension to abort + steer) and any long-poll it is blocked in returns immediately.
  async messageAgent(
    agent: AgentId,
    body: string,
    idempotencyKey: string,
    mode: "queue" | "interrupt" = "queue",
    // `from` is the acting identity (default the operator token, cli:operator); `audited` = performAction already journaled the `message_received` row.
    o: { from?: MessagingSender; audited?: boolean } = {},
  ): Promise<Signal & { mode: "queue" | "interrupt"; delivered: "queued" | "woke" | "interrupting" | "steered" }> {
    const d = this.deps;
    const a = await d.registry.get(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    const interrupt = mode === "interrupt";
    // A waiting agent (settled turn, no result, container up) has no turn to abort: either mode is a plain mailbox message the
    // mailbox extension injects as a steer; Pi starts a turn for it on an idle session and the ack ends the wait.
    const waiting = a.state === "running" && (await this.waitingSince(agent)) !== null;
    const from: MessagingSender = o.from ?? { channel: CLI_CHANNEL, sender: "operator" };
    const signal: Signal = { kind: "human_message", from, body, ...(interrupt && !waiting && { interrupt: true as const }) };
    const prior = await this.opFind(agent, "msg", idempotencyKey);
    if (prior) return { ...signal, mode, delivered: (prior.delivered as "queued" | "woke" | "interrupting" | "steered" | undefined) ?? "queued" };
    if (interrupt && (a.state === "exited" || a.state === "reaped")) throw new LifecycleError(409, `agent is ${a.state}; cannot interrupt`);
    await this.messaging.assertReceivable(agent);
    if (!o.audited)
      await this.record(
        a,
        { kind: "message_received", channel: from.channel, from, to: agent, body, ...(interrupt && { interrupt: true as const }) },
        `msg:${from.channel}:${idempotencyKey}`,
      );
    let delivered: "queued" | "woke" | "interrupting" | "steered" = "queued";
    if (interrupt && !waiting) {
      // Journal + flagged signal + arming of a started run, under the agent's interrupt lock (Lifecycle.queueInterrupt).
      await this.lifecycle.queueInterrupt(a, idempotencyKey, body, () => d.mailbox.send(agent, signal, `msg:${from.channel}:${idempotencyKey}:signal`));
      this.kick(agent);
      // The state read above may be stale by now: decide on a fresh one. A resume that raced this message delivers it in its
      // prompt or was armed for it by queueInterrupt, so a refused or skipped wake here loses nothing.
      const now = (await d.registry.get(agent))?.state;
      if (now === "yielded") {
        try {
          if (await this.resumeWithInterrupts(agent, "woke")) delivered = "woke";
        } catch {
          /* raced a concurrent resume (409 not yielded): that run delivers the message */
        }
      } else if (now === "running") delivered = "interrupting";
    } else {
      await d.mailbox.send(agent, signal, `msg:${from.channel}:${idempotencyKey}:signal`);
      await d.orchestrator.wake(agent, signal);
      // TODO(wake-waiting): verify waking a waiting agent live. Current behavior: the message is mailboxed and reported steered.
      // Also open: the collision with a user typing in the same terminal.
      if (waiting) delivered = "steered";
      else if (a.state === "yielded" && (await d.registry.get(agent))?.state !== "yielded") delivered = "woke";
    }
    await this.markOp((await d.registry.get(agent)) ?? a, "msg", idempotencyKey, { delivered }); // fresh record: a resume may have bumped the generation
    return { ...signal, mode, delivered };
  }

  // --- Escalations (SPEC "Signals"; `pomtree ask`) ---

  // `pomtree ask`: a running agent raises a human escalation. The escalation id is deterministic from
  // (agent, idempotencyKey), so a retry converges on the same open escalation; the store fences the
  // claimed generation (StaleGenerationError surfaces as 409) and the journal records both the raise
  // and the outbound ask (when an escalation channel is configured).
  async ask(
    agent: AgentId,
    req: { question: string; options?: string[]; generation: number; idempotencyKey: string },
  ): Promise<{ escalation: Escalation; delivered: boolean }> {
    const d = this.deps;
    const a = await d.registry.get(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (a.state !== "running") throw new LifecycleError(409, `agent is ${a.state}, not running`);
    const id = escalationIdFor(agent, req.idempotencyKey);
    // Agent-controlled text reaches a human's chat: sanitize once (toUser: control/bidi/zero-width chars, mentions, length cap
    // with a visible marker) and persist that value, so the escalation, journal and outbox all carry the same text.
    // TODO(ask-text-cap): tell the asker when its ask text was truncated. Current behavior: toUser caps the question with a
    // visible marker and the ask result carries no truncation indicator.
    const question = toUser(req.question);
    const options = (req.options ?? []).slice(0, ASK_OPTIONS_MAX).map((o) => toUser(o, ASK_OPTION_MAX));
    // An ask bubbles up the ancestor chain (root excluded); a top-level agent's ask goes straight to the user.
    const chain = await this.ancestorChain(a);
    const escalation = await d.escalations.create(
      {
        id,
        agent,
        host: a.host,
        generation: req.generation,
        question,
        options,
        ...(chain.length > 0 && { holder: chain[0]!, hopDeadlineAt: this.now() + this.escAgentMs() }),
      },
      `${agent}:${req.idempotencyKey}`,
    );
    await this.record(a, { kind: "escalation_raised", escalation: id, question }, `${agent}:${req.idempotencyKey}:raised`);
    const delivered = d.channels.hasOutbound();
    if (chain.length === 0)
      await this.sendToUser(a, "ask", question, `${agent}:${req.idempotencyKey}:sent`, id, { subjectKind: "ask", ...(options.length > 0 && { options }) });
    else await this.dispatchAskHop(escalation, a, chain, 0);
    return { escalation, delivered };
  }

  waitAsk(agent: AgentId, id: EscalationId, waitMs: number): Promise<Escalation> {
    return this.escalation.waitAsk(agent, id, waitMs);
  }

  answerEscalation(id: EscalationId, answer: string, by: MessagingSender, key: string): Promise<Escalation> {
    return this.escalation.answerEscalation(id, answer, by, key);
  }

  private deliverAnswer(esc: Escalation, answer: string, answeredBy: MessagingSender, wake = false): Promise<void> {
    return this.escalation.deliverAnswer(esc, answer, answeredBy, wake);
  }

  private safeWake(agent: AgentId, signal: Signal, rec: AgentRecord | null, errKey: string): Promise<void> {
    return this.escalation.safeWake(agent, signal, rec, errKey);
  }

  sweepEscalations(): Promise<EscalationId[]> {
    return this.escalation.sweepEscalations();
  }

  // --- Bubbled escalations (asks and approvals climb the ancestor chain) ---

  private escAgentMs(): number {
    return this.escalation.escAgentMs();
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.withLock(key, fn);
  }

  private ancestorChain(a: AgentRecord): Promise<AgentId[]> {
    return this.tree.ancestorChain(a);
  }

  private dispatchAskHop(esc: Escalation, asker: AgentRecord, chain: AgentId[], from: number): Promise<void> {
    return this.escalation.dispatchAskHop(esc, asker, chain, from);
  }

  passEscalation(id: EscalationId, agent: AgentId | null, key: string): Promise<Escalation> {
    return this.escalation.passEscalation(id, agent, key);
  }

  answerEscalationAs(agent: AgentId, id: EscalationId, body: string, key: string): Promise<Escalation> {
    return this.escalation.answerEscalationAs(agent, id, body, key);
  }

  // --- Approvals (TODO(authz-escalation)) ---

  requireApproval(agent: AgentRecord, kind: string, target: string, key: string): Promise<Approval> {
    return this.escalation.requireApproval(agent, kind, target, key);
  }

  private openApproval(agent: AgentRecord, kind: string, target: string, key: string, humanMs?: number): Promise<Approval> {
    return this.escalation.openApproval(agent, kind, target, key, humanMs);
  }

  notifyApprovalAsk(ap: Approval): Promise<void> {
    return this.escalation.notifyApprovalAsk(ap);
  }

  decideApproval(
    id: string,
    decision: "approve" | "deny" | "pass",
    who: string,
    why: string,
    key: string,
    as: { agent?: AgentId; grantMicros?: number } = {},
  ): Promise<Approval> {
    return this.escalation.decideApproval(id, decision, who, why, key, as);
  }

  sweepApprovals(): Promise<number> {
    return this.escalation.sweepApprovals();
  }

  // --- Budget escalation (docs/economy.md section 13) ---
  // An agent that exhausts its budget parks (yield with wait null, so no wake path resumes it) behind a `budget_raise`
  // approval that climbs its ancestor chain. Only the grant hook resumes it, after the deciding ancestor's slice has been
  // carved down the chain; a denial or timeout finishes it `over_budget` with its folder and checkpoint kept.

  private hookError(id: AgentId, e: unknown): Promise<void> {
    if (this.isStoreDown(e)) {
      this.markStoreDown(e);
      return Promise.resolve();
    }
    return this.get(id)
      .then((a) => (a ? this.journalReconcileError(a, e) : undefined))
      .catch(() => {});
  }

  // The model proxy refused a call for lack of budget (below the minimum): escalate an adopted agent, whose events no drive loop reads.
  budgetStalled(id: AgentId, remainingMicros: number | null, floorMicros: number): Promise<void> {
    return this.budget.escalateStalled(id, remainingMicros, floorMicros);
  }

  private escalateBudget(id: AgentId, entry: Live): Promise<boolean> {
    return this.budget.escalateBudget(id, entry);
  }

  private isBudgetParked(r: AgentRecord): Promise<boolean> {
    return this.budget.isBudgetParked(r);
  }

  // The budget grant hook (Budget.applyBudgetDecision).
  applyBudgetDecision(id: AgentId): Promise<void> {
    return this.budget.applyBudgetDecision(id);
  }

  async publish(agent: AgentId, req: { branch: string; target: string; idempotencyKey: string }): Promise<{ branch: string; target: string }> {
    return this.merger.publish(agent, req);
  }

  // `pomtree push`: the agent's bundle goes through Workspace.ingest (quarantined, size-capped while streaming) into the mirror.
  // Fenced against the caller's token generation, idempotent by key (a replay returns the first result without ingesting again),
  // journals `ingested` / `ingest_failed`. Content failures come back as { ok: false, code } for the route to map.
  // `force` is operator-only, exactly as it is for resume (api.ts): a forced ingest moves an agent ref to a non-descendant,
  // which can leave a controller-written merge commit unreachable. The check lives here, not in the route, because every push
  // path reaches the mirror through this method: a second route that forwarded `force` would inherit the refusal, not skip it.
  // `operator` is set only by a caller holding operator scope; the agent transfer route never sets it.
  async push(
    agent: AgentId,
    generation: number,
    key: string,
    bundle: AsyncIterable<Uint8Array>,
    maxBytes: number,
    opts: { force?: boolean; operator?: boolean } = {},
  ): Promise<IngestResult> {
    const d = this.deps;
    // TODO(custody-force): decide an operator route for forced ingest. Current behavior: push throws 403 for force without
    // operator; its only non-test caller, transfer-route, forwards force and never sets operator. forcedFrom goes to the journal
    // row and a host warning only.
    if (opts.force && !opts.operator)
      throw new LifecycleError(403, "--force is operator-only; run `pomtree pull`, fast-forward your branch onto the ingested tip, then push again");
    const r = await d.registry.get(agent);
    if (!r) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (r.generation !== generation) throw new StaleGenerationError(agent, generation, r.generation);
    if (r.state !== "running") throw new LifecycleError(409, `agent is ${r.state}, not running`);
    for (let from = 1; ; ) {
      const page = await d.journal.read({ from, agent, limit: 500 });
      for (const e of page) {
        const p = e.payload as { kind: string; key?: string; refs?: { ref: string; commit: string }[] };
        if (p.kind === "ingested" && p.key === key && p.refs) return { ok: true, refs: p.refs };
      }
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    const out = await d.workspace.ingest(agent, bundle, { maxBytes, ...(opts.force && { force: true }) });
    if (out.ok) {
      // A forced ingest is never silent: the journal row carries it, and the host log names the overwritten tips so an
      // operator sees the loss without reading the journal back.
      if (out.forced) console.warn(`pomtreed: forced ingest for ${agent}: ${out.forcedFrom.map((f) => `${f.ref} ${f.from} -> ${f.to}`).join(", ")}`);
      await this.record(
        r,
        { kind: "ingested", refs: out.refs, key, ...(out.forced ? { forced: true, forcedFrom: out.forcedFrom } : {}) } as JournalPayload,
        `${agent}:${generation}:ingested:${key}`,
      );
    } else
      await this.record(r, { kind: "ingest_failed", code: out.code, message: clipText(out.message, 500) }, `${agent}:${generation}:ingest-failed:${key}`).catch(
        () => {},
      );
    return out;
  }

  isDescendant(ancestor: AgentId, id: AgentId): Promise<boolean> {
    return this.tree.isDescendant(ancestor, id);
  }

  scopedCommit(agent: AgentId, commit: string): Promise<string | null> {
    return this.tree.scopedCommit(agent, commit);
  }

  private isTopLevel(a: AgentRecord): Promise<boolean> {
    return this.tree.isTopLevel(a);
  }

  async merge(agent: AgentId, generation: number, key: string, req: { child?: AgentId; into?: string }): Promise<MergeAnswer> {
    return this.merger.merge(agent, generation, key, req);
  }

  async recoverMerges(): Promise<MergeResult[]> {
    return this.merger.recoverMerges();
  }

  async resumeChild(agent: AgentId, generation: number, child: AgentId): Promise<AgentRecord> {
    return this.merger.resumeChild(agent, generation, child);
  }

  async pull(agent: AgentId, generation: number, from?: AgentId): Promise<AsyncIterable<Uint8Array>> {
    return this.merger.pull(agent, generation, from);
  }

  async messageFailed(f: MessageFailedBody): Promise<void> {
    return this.messaging.messageFailed(f);
  }

  // --- Inbound/outbound messaging (host credentials) ---

  async receiveMessage(msg: InboundMessage): Promise<MessageReceipt> {
    return this.messaging.receiveMessage(msg);
  }

  // The one action core (daemon/messaging.ts performAction): the operator routes in api.ts call it with their channel (cli or ui).
  performAction(actor: MessagingSender, action: ChannelAction, key: string | undefined, opts?: { raw?: boolean; msg?: InboundMessage }): Promise<ActionResult> {
    return this.messaging.performAction(actor, action, key, opts);
  }

  async outbox(o: { channel: MessagingChannel; from?: number }): Promise<(JournalEntry & OutboxEntry)[]> {
    return this.messaging.outbox(o);
  }

  // Cleanup, folder, zombie and watchdog sweeps live in `Sweeps`; the timers in startWatchers call these delegates.
  sweepCleanup(): Promise<AgentId[]> {
    return this.sweeps.sweepCleanup();
  }

  private async withFolderLock<T>(agent: AgentId, fn: () => Promise<T>): Promise<T> {
    return this.sweeps.withFolderLock(agent, fn);
  }

  async sweepFolders(): Promise<AgentId[]> {
    return this.sweeps.sweepFolders();
  }

  async sweepZombies(): Promise<AgentId[]> {
    return this.sweeps.sweepZombies();
  }

  async sweepHoldTtl(): Promise<AgentId[]> {
    return this.sweeps.sweepHoldTtl();
  }

  sweepWatchdogs(): Promise<void> {
    return this.sweeps.sweepWatchdogs();
  }

  private sweepsStale(now: number): boolean {
    return this.sweeps.sweepsStale(now);
  }

  private async setWatchdog(id: AgentId, patch: Partial<WatchdogState>, key: string): Promise<void> {
    return this.sweeps.setWatchdog(id, patch, key);
  }

  startWatchers(): () => void {
    // Cron runs in the cron extension (builtin/cron.ts), which owns its interval. Here: zombie, watchdog, cleanup,
    // sandbox-probe and store-probe sweeps.
    const z = setInterval(() => {
      this.sweepZombies().catch((e) => console.error("zombie sweep failed:", e));
      this.sweepHoldTtl().catch((e) => console.error("hold ttl sweep failed:", e));
    }, this.limits.zombieSweepMs);
    const w = setInterval(() => this.sweepWatchdogs().catch((e) => console.error("watchdog sweep failed:", e)), this.limits.watchdogSweepMs);
    const c = setInterval(() => this.sweepCleanup().catch((e) => console.error("cleanup sweep failed:", e)), this.limits.cleanupSweepMs);
    const s = setInterval(() => this.probeSandbox().catch((e) => console.error("sandbox probe failed:", e)), this.deps.admitRetryMs);
    const p = setInterval(() => this.probeStore().catch((e) => console.error("store probe failed:", e)), this.deps.admitRetryMs);
    // Re-armed after each pass ends (not setInterval), so a pass that outlasts the interval cannot stack ticks behind it.
    let r: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const armReconcile = () => {
      r = setTimeout(() => {
        this.reconcile()
          .catch((e) => console.error("reconcile sweep failed:", e))
          .finally(() => {
            if (!stopped) armReconcile();
          });
      }, this.deps.reconcileMs ?? 30_000);
      r.unref?.();
    };
    armReconcile();
    z.unref?.();
    w.unref?.();
    c.unref?.();
    s.unref?.();
    p.unref?.();
    return () => {
      clearInterval(z);
      clearInterval(w);
      clearInterval(c);
      clearInterval(s);
      clearInterval(p);
      stopped = true;
      clearTimeout(r);
    };
  }

  // --- Observe ---

  // Yielded agents' wait conditions, from each one's latest checkpoint. Exposed for the built-in observe
  // extension (builtin/observe.ts), which renders the live view from this.
  async liveWaits(): Promise<ReadonlyMap<AgentId, WaitCondition>> {
    const out = new Map<AgentId, WaitCondition>();
    for (const a of await this.list({ state: "yielded" })) {
      const cp = await this.deps.checkpoints.latest(a.id);
      if (cp?.wait) out.set(a.id, cp.wait);
    }
    return out;
  }

  get(id: AgentId) {
    return this.deps.registry.get(id);
  }

  list(opts?: { parent?: AgentId; state?: AgentState }) {
    return this.deps.registry.list(opts);
  }

  // Operator journal view: Journal.read supports from/agent/limit; `kind` (and the row mapping) is
  // applied after the read so the global seq cursor stays the paging key.
  async journal(opts: { from?: number; limit?: number; agent?: AgentId; kind?: string }): Promise<JournalRow[]> {
    const entries = await this.deps.journal.read({ from: opts.from, agent: opts.agent, limit: opts.limit });
    return entries.filter((e) => !opts.kind || e.payload.kind === opts.kind).map((e) => journalRow(e));
  }

  // `pomtree logs` transcript (TODO(transcript)): the newest entries of the agent's latest checkpointed session. Null when the
  // agent has never yielded/checkpointed (a running agent's live session is not readable from here).
  async transcript(id: AgentId, limit?: number): Promise<{ entries: unknown[]; skipped: number; total: number; commit: string } | null> {
    if (!(await this.get(id))) throw new LifecycleError(404, `no such agent: ${id}`);
    const cp = await this.deps.checkpoints.latest(id);
    if (!cp) return null;
    const bytes = await this.deps.sessions.get(cp.sessionRef);
    if (!bytes) return null;
    return { ...parseTranscript(bytes, limit), commit: cp.ingested?.commit ?? "" };
  }

  // The hosts pane and /v1/placement show this daemon's own host row.
  // TODO(multi-host): expose all host rows (PlacementStatus[]) over HTTP and in the UI hosts pane.
  async placementStatus(): Promise<PlacementStatus> {
    const rows = await this.deps.placement.status();
    const own = rows.find((s) => s.host === this.deps.hostId);
    if (!own) throw new LifecycleError(503, `host ${this.deps.hostId} has no host row (not registered yet); no placement status`);
    return own;
  }

  async events(opts: { agent?: AgentId; from?: number; limit?: number; tail?: number; waitMs?: number }): Promise<JournalEntry[]> {
    const j = this.deps.journal;
    if (opts.tail) {
      // Pages through the journal keeping only the last `tail` entries.
      let ring: JournalEntry[] = [];
      for (let from = 1; ; ) {
        const page = await j.read({ agent: opts.agent, from, limit: 1000 });
        ring = ring.concat(page).slice(-opts.tail);
        const last = page.at(-1);
        if (!last || page.length < 1000) return ring;
        from = last.seq + 1;
      }
    }
    const q = { agent: opts.agent, from: opts.from, limit: opts.limit };
    const first = await j.read(q);
    if (first.length || !opts.waitMs) return first;
    const sub = j.subscribe({ agent: opts.agent, from: opts.from });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), Math.min(opts.waitMs!, 30000))));
      const next = await Promise.race([sub[Symbol.asyncIterator]().next(), timeout]);
      if (!next || next.done) return [];
    } finally {
      clearTimeout(timer);
      sub.close();
    }
    return j.read(q);
  }

  // Client idempotency keys on mutating ops: a completed op journals a keyed marker; a replay
  // with the same key finds it and answers with the current record instead of 409/re-applying.
  private async opSeen(agent: AgentId, op: string, key: string | undefined): Promise<boolean> {
    return (await this.opFind(agent, op, key)) !== null;
  }

  private async opFind(
    agent: AgentId,
    op: string,
    key: string | undefined,
  ): Promise<{ unusedMicros?: number; delivered?: string; checkpoint?: string } | null> {
    if (key === undefined) return null;
    for (let from = 1; ; ) {
      const page = await this.deps.journal.read({ from, agent, limit: 500 });
      for (const e of page) {
        if (e.payload.kind === OP_KIND) {
          const p = e.payload as { op?: string; key?: string; unusedMicros?: number; delivered?: string; checkpoint?: string };
          if (p.op === op && p.key === key)
            return {
              ...(p.unusedMicros !== undefined && { unusedMicros: p.unusedMicros }),
              ...(p.delivered !== undefined && { delivered: p.delivered }),
              ...(p.checkpoint !== undefined && { checkpoint: p.checkpoint }),
            };
        }
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return null;
      from = last.seq + 1;
    }
  }

  private async markOp(
    rec: AgentRecord | null,
    op: string,
    key: string | undefined,
    extra: { unusedMicros?: number; delivered?: string; checkpoint?: string } = {},
  ): Promise<void> {
    if (key === undefined || !rec) return;
    const record = (r: AgentRecord, p: JournalPayload, k: string) => this.record(r, p, k);
    await this.record(rec, { kind: OP_KIND, op, key, ...extra }, `${rec.id}:op:${op}:${key}`).catch(journalFailed(record, rec, "op"));
  }

  // Agent-reported typed result; `pomtree result`.
  submitResult(id: AgentId, status: "succeeded" | "failed", result: unknown, key?: string, saveUncommitted?: string): Promise<AgentRecord | "conflict" | null> {
    return this.lifecycle.submitResult(id, status, result, key, saveUncommitted);
  }

  async cancel(id: AgentId, graceMs = this.deps.graceMs, key?: string) {
    return this.lifecycle.cancel(id, graceMs, key);
  }

  async kill(id: AgentId, key?: string) {
    return this.lifecycle.kill(id, key);
  }

  // `pomtree abandon` (abandon.ts): end a run as cancelled with cause abandoned, stopping a live driver.
  async abandonRun(id: AgentId, result: unknown) {
    return this.lifecycle.abandon(id, result);
  }

  async doctor() {
    const counts: Partial<Record<AgentState, number>> = {};
    for (const a of await this.list()) counts[a.state] = (counts[a.state] ?? 0) + 1;
    let sandboxes = 0;
    let sandboxOk = true;
    try {
      sandboxes = (await this.deps.sandbox.list(sandboxOwner(this.deps, this.epoch))).length;
    } catch (e) {
      sandboxOk = false;
      if (e instanceof SandboxUnavailableError) {
        await this.markSandboxDown();
      } else {
        // A non-standard sandbox failure must not 500 doctor(); surface it as a host_error
        // and report unhealthy instead.
        const root = await this.root().catch(() => null);
        if (root) {
          await this.record(
            root,
            { kind: "host_error", component: "sandbox", message: `sandbox.list failed: ${e instanceof Error ? e.message : String(e)}` },
            `host:sandbox:list-error`,
          ).catch(() => {});
        }
      }
    }
    const sweepsStale = this.sweepsStale(this.now());
    const agentEndpoint = await this.deps.agentEndpointStatus?.().catch(() => undefined);
    const endpointOk = agentEndpoint === undefined || (agentEndpoint.hostProbe && agentEndpoint.containerReachable);
    const rev = this.revisionState();
    return {
      ok: sandboxOk && this.sandboxUp && !this.journalFailed && !this.degraded && !sweepsStale && endpointOk,
      host: this.deps.hostId,
      agents: counts,
      sandboxes,
      live: this.live.size,
      sandboxUp: this.sandboxUp,
      journalFailed: this.journalFailed,
      degraded: this.degraded,
      sweepsStale,
      // The daemon's printed build identity (revision.ts buildVersion), for `pomtree doctor`; gitSha stays the bare revision.
      version: buildVersion(),
      gitSha: rev.gitSha,
      imageRevision: rev.imageRevision,
      revisionMismatch: rev.mismatch,
      ...(this.deps.maxSessions && { maxSessions: this.deps.maxSessions }),
      ...(this.deps.backend && { backend: this.deps.backend }),
      // Agents held for an unreachable sandbox backend (ids only); absent when none. `pomtree abandon <agent>` resolves each.
      ...(this.reconciler.held().length > 0 && { heldAgents: this.reconciler.held() }),
      ...(agentEndpoint !== undefined && { agentEndpoint }),
    };
  }

  // Supervisor drain: stop admitting new work and leave running
  // containers adoptable for the next daemon (Sandbox.attach) instead of SIGKILLing them.
  // `deadline` is the absolute time past which the caller must force-exit nonzero; it is unused here because
  // this method only flips the runtime flag and unwinds runtime-only state — process exit is the caller's (main.ts) job.
  async shutdown(deadline: number): Promise<void> {
    void deadline;
    if (this.draining) return;
    this.draining = true;
    // Release queued admission waiters so nothing new starts; they re-check draining in admit().
    for (const wake of this.admitWaiters.values()) wake();
    this.admitWaiters.clear();
    // Abort each live agent's kill timer so a SIGKILL cannot fire mid-drain: containers stay
    // running and are re-adopted (or finished from their exit) by the next daemon.
    for (const e of this.live.values()) {
      clearTimeout(e.killTimer);
      e.killTimer = undefined;
    }
  }

  // Periodic sandbox health probe (driven by startWatchers at admitRetryMs backoff): a successful
  // sandbox.list() clears the down flag and reconciles; a SandboxUnavailableError marks the host down
  // so admission holds.
  async probeSandbox(): Promise<void> {
    try {
      await this.deps.sandbox.list(sandboxOwner(this.deps, this.epoch));
      if (!this.sandboxUp) await this.markSandboxUp();
    } catch (e) {
      if (e instanceof SandboxUnavailableError) await this.markSandboxDown();
      else throw e;
    }
  }

  private async markSandboxDown(): Promise<void> {
    if (!this.sandboxUp) return; // journal once per down episode
    this.sandboxUp = false;
    try {
      const root = await this.root();
      await this.record(root, { kind: "host_error", component: "sandbox", message: "sandbox unavailable" }, `host:sandbox:down`);
    } catch {
      // the journal may be down too; the runtime flag still holds admission
    }
  }

  private async markSandboxUp(): Promise<void> {
    this.sandboxUp = true;
    await this.reconcileSandboxes();
  }

  private markJournalFailed(e: unknown): void {
    if (this.journalFailed) return;
    this.journalFailed = true;
    console.error(`pomtreed: journal append failed (${e instanceof Error ? e.message : String(e)}); admission stopped`);
  }

  private isStoreDown(e: unknown): boolean {
    return isStoreDown(e);
  }

  private markStoreDown(e: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    console.error(`pomtreed: store write failed (${e instanceof Error ? e.message : String(e)}); admission stopped`);
  }

  // Periodic store-recovery probe (driven by startWatchers at admitRetryMs backoff): a durable write
  // failure (SQLITE_BUSY/ENOSPC/IO) latches `degraded` and holds admission until a write succeeds
  // again. The probe re-runs the keyed host-health heartbeat write; when it lands the store is
  // writable and admission reopens. Keyed so the probe never spams the journal.
  // TODO(degraded-flap): each probe that clears the latch still writes one `ext.pomtreed.host_health` entry (the write is the probe), so a latch that keeps re-setting adds one entry per probe tick.
  async probeStore(): Promise<void> {
    if (!this.degraded && !this.journalFailed) return;
    try {
      // A unique key per probe: a keyed replay of an earlier heartbeat would "succeed" without writing. Without a root
      // record there is nothing to write against, so the latches stay set.
      const root = await this.deps.registry.get(await this.rootAgentId());
      if (!root) return;
      await this.record(
        root,
        { kind: HOST_HEALTH_KIND, ok: true, sweepsStale: this.sweepsStale(this.now()) },
        `host:probe:${this.bootNonce}:${++this.probeSeq}`,
      );
      // The journal-failed latch (a resource-error append) clears the same way: the probe write just landed.
      this.degraded = false;
      this.journalFailed = false;
      console.error("pomtreed: store write recovered; admission resumed");
      // Wakes sent while the store was down may be lost: re-arm the one-shot lost-wake scan and run one pass now, unless the
      // previous recovery passes keep re-latching the store (then back off so a failing phase cannot drive a pass per probe).
      if (this.now() < this.nextRecoveryAt) return;
      this.reconciler.rearmLostWakeScan();
      this.reconcile()
        .then(() => this.noteRecoveryPass())
        .catch((e) => console.error("post-recovery reconcile failed:", e));
    } catch (e) {
      if (this.isStoreDown(e)) return; // still down; the next probe retries
      throw e;
    }
  }

  // After a recovery pass: a pass that left the store latched again counts toward the backoff (and the single per-episode alert);
  // one that did not resets both.
  private async noteRecoveryPass(): Promise<void> {
    const d = this.deps;
    if (!this.degraded && !this.journalFailed) {
      if (this.relatches > 0) this.flapEpisode++;
      this.relatches = 0;
      this.nextRecoveryAt = 0;
      this.flapAlerted = false;
      return;
    }
    this.relatches++;
    const base = d.storeRecoveryBackoffMs ?? d.admitRetryMs;
    this.nextRecoveryAt = this.now() + Math.min(base * 2 ** this.relatches, d.storeRecoveryBackoffMaxMs ?? 60_000);
    if (this.flapAlerted || this.relatches < (d.storeRelatchAlertAfter ?? 3)) return;
    try {
      const root = await d.registry.get(await this.rootAgentId());
      if (!root) return;
      const message = `store re-latched after ${this.relatches} consecutive recovery passes: a reconcile phase keeps failing with a store error while the probe succeeds; recovery passes are backing off`;
      const key = `${root.id}:${root.generation}:store-flap:${this.bootNonce}:${this.flapEpisode}`;
      await this.record(root, { kind: "error", message }, key);
      await this.sendToUser(root, "alert", message, `${key}:alert`);
      this.flapAlerted = true;
    } catch (e) {
      console.error("store-flap alert failed (retried on the next re-latch):", e);
    }
  }

  async recover() {
    return this.reconciler.recover();
  }

  // Restart reconciliation lives in `Reconcile`; the reconcile timer in startWatchers calls this delegate.
  reconcile(): Promise<void> {
    return this.reconciler.reconcile();
  }

  private async journalReconcileError(a: AgentRecord, e: unknown): Promise<void> {
    return this.reconciler.journalReconcileError(a, e);
  }

  private async isQuarantined(a: AgentRecord): Promise<boolean> {
    return this.reconciler.isQuarantined(a);
  }

  private async restartFresh(a: AgentRecord): Promise<boolean> {
    return this.reconciler.restartFresh(a);
  }

  private async reconcileSandboxes() {
    return this.reconciler.reconcileSandboxes();
  }

  async reclaimEgressOrphans(): Promise<void> {
    return this.reconciler.reclaimEgressOrphans();
  }

  private async reclaimSandbox(r: AgentRecord, force = false) {
    return this.reconciler.reclaimSandbox(r, force);
  }

  // Wire to the placement's promotion callback so queued agents start as soon as a slot frees.
  admitted(agent: AgentId) {
    this.admitWaiters.get(agent)?.();
  }

  // An agent credential issued for a given generation and a bounded expiry. The generation argument is
  // the caller's current fence value (the record's generation at issue time); it defaults to 0 for callers
  // that only need a structurally valid token (tests probing a missing or foreign agent).
  agentToken(id: AgentId, generation = 0): string {
    return this.lifecycle.agentToken(id, generation);
  }

  // --- Driver ---

  // `source` names the event that produced the signal (e.g. `${agent}:${generation}:cancel:${graceMs}`), so a replay of that
  // event after a restart derives the same key and the mailbox dedupes it; a new event carries a new source.
  async deliver(agent: AgentId, signal: Signal, source: string) {
    return this.lifecycle.deliver(agent, signal, source);
  }

  // Driver.isYielded: durable orchestrators re-arm a wait only while the agent
  // remains yielded (a non-satisfying wake leaves it parked).
  async isYielded(agent: AgentId): Promise<boolean> {
    return this.lifecycle.isYielded(agent);
  }

  async stop(id: AgentId, graceMs: number) {
    return this.lifecycle.stop(id, graceMs);
  }

  // Hard wall-clock cap (SpawnRequest.deadlineMs): at `deadlineAt`, mark the run timed-out,
  // kill its sandbox and stop the harness so settle finishes it as `timed_out`. Chunked like
  // the orchestrator's timer waits so a >24.8-day deadline does not overflow setTimeout.
  private armDeadline(e: Live, deadlineAt: number) {
    return this.lifecycle.armDeadline(e, deadlineAt);
  }

  async drive(id: AgentId, gen: number) {
    return this.lifecycle.drive(id, gen);
  }

  // `pomtree yield`: checkpoint the running agent and park it until its wait condition is met. Called
  // from within the agent's own sandbox, so the durable writes must complete before the container
  // exits; the drive loop then ends through settleYield (no finish()/exited).
  // `wait: null` parks with no wake of its own (a budget park): only the grant hook resumes it.
  async yield(agent: AgentId, o: { wait: WaitCondition | null; idempotencyKey: string; ctx?: WaitCtx }): Promise<Checkpoint> {
    return this.lifecycle.yield(agent, o);
  }

  // Checkpoint a STOPPED agent: the session file (torn tail trimmed), spend, image, the folder id and the last ingested ref.
  // Hashes and ids only. Idempotent by `key` (the store returns the first write). The container must already be stopped.
  private async stopCheckpoint(r: AgentRecord, key: string, wait: WaitCondition | null, workspace?: WorkspaceId): Promise<Checkpoint> {
    return this.lifecycle.stopCheckpoint(r, key, wait, workspace);
  }

  // The unfinished pause (a live `pausing` marker for the agent's current generation), or null; see Lifecycle.pausingMarker.
  private async pausingMarker(a: AgentRecord): Promise<{ key: string; wait: WaitCondition | null; ctx?: WaitCtx } | null> {
    return this.lifecycle.pausingMarker(a);
  }

  // Resume an agent from its latest checkpoint. Normal resumes require `yielded`; `forced` also
  // accepts a `running` agent (daemon-restart fence). `wake` is the text handed to the harness.
  async resumeAgent(
    agent: AgentId,
    wake = "operator resumed you",
    opts: { forced?: boolean; grant?: boolean; observedGeneration?: number; operator?: boolean } = {},
    key?: string,
  ): Promise<AgentRecord> {
    return this.lifecycle.resumeAgent(agent, wake, opts, key);
  }

  // The one chokepoint for a supervisor-initiated forced resume. The ordering of the restart charge, stop-checkpoint and
  // staleness check, and the result values, are documented on Lifecycle.forceResume.
  async forceResume(
    agent: AgentRecord,
    observedGeneration: number,
    cause: ForceResumeCause,
    o: { wake?: string | (() => Promise<string | undefined>); restartReason?: string; isStale?: () => boolean } = {},
  ): Promise<"resumed" | "superseded" | "skipped" | "exhausted"> {
    return this.lifecycle.forceResume(agent, observedGeneration, cause, o);
  }

  // Driver.resume: the post-transition segment for a resumed agent (checkout, restore session,
  // sandbox from the checkpoint image, harness.resume, pump).
  async runResumed(agent: AgentId, gen: number, wake: string): Promise<void> {
    return this.lifecycle.runResumed(agent, gen, wake);
  }

  // Resume `agent` (yielded, or a just-checkpointed running one) for its pending interrupt messages, ahead of other pending
  // resumes (Lifecycle.resumeWithInterrupts). Returns whether a resume was started; the resumed run words them into its prompt
  // and marks them delivered (Lifecycle.takeInterrupts).
  private async resumeWithInterrupts(agent: AgentId, mode: "woke"): Promise<boolean> {
    return this.lifecycle.resumeWithInterrupts(agent, mode);
  }

  // `pomtree wait/inbox --wait/ask --wait` from an agent: when the wait would exceed wait.yieldMs (default 20s) the
  // agent yields under the hood instead of holding its container, with the equivalent wake condition plus a timer
  // for the remaining timeout, and resumes later with a synthetic message saying what happened (see resumeText).
  // Returns { parked: false } when the wait is short or already satisfied (the caller then long-polls as before).
  // TODO(background-jobs): jobs v1 is files-only, so live background processes are not detectable here; a yield
  // (like any exit) kills them. Refuse/defer the park when the jobs extension reports a live job.
  async parkForWait(
    agent: AgentId,
    o: { on: { kind: "child"; child: AgentId } | { kind: "inbox" } | { kind: "ask"; escalation: string }; timeoutMs: number; idempotencyKey: string },
  ): Promise<{ parked: false } | { parked: true; checkpoint: Checkpoint }> {
    return this.lifecycle.parkForWait(agent, o);
  }

  // Driver.wakeResume: re-check the yielded agent's checkpoint wait against the incoming signal
  // (message/child_exited/timer) and resume only when it is satisfied.
  async wakeResume(agent: AgentId, signal: Signal): Promise<void> {
    return this.lifecycle.wakeResume(agent, signal);
  }

  // --- internals ---

  // Why a pending agent is held in admit(): journaled as ext.pomtreed.pending_reason (at most once per change; the
  // empty reason clears it). Only fresh (pending) starts show one. Best-effort: a journal failure never blocks admission.
  private async notePending(r: AgentRecord, last: { v: string }, reason: string): Promise<void> {
    if (r.state !== "pending" || last.v === reason) return;
    last.v = reason;
    await this.record(r, { kind: PENDING_REASON_KIND, reason }, `${r.id}:${r.generation}:pending:${this.bootNonce}:${++this.pendingSeq}`).catch(() => {});
  }

  // The agent's current pending reason: the newest ext.pomtreed.pending_reason in its journal ("" = none/cleared).
  // Read from the journal, not daemon memory, so it survives a restart.
  async pendingReason(id: AgentId): Promise<string> {
    const rows = await this.deps.journal.read({ agent: id });
    for (let i = rows.length - 1; i >= 0; i--) {
      const p = rows[i]!.payload as { kind: string; reason?: unknown };
      if (p.kind === PENDING_REASON_KIND) return typeof p.reason === "string" ? p.reason : "";
    }
    return "";
  }

  // The agent's `waitingSince` (ms), or null when it is not waiting: folded from its journal (core `waitingStep`), not daemon
  // memory, so it survives a restart. TODO(waiting-scan): reads the whole journal per call, like pendingReason.
  async waitingSince(id: AgentId): Promise<number | null> {
    let w: number | null = null;
    for (const e of await this.deps.journal.read({ agent: id })) w = waitingStep(w, e);
    return w;
  }

  // Additive `waitingSince` on a running agent that is waiting (API and CLI field; `state` stays `running`).
  async withWaiting<T extends AgentRecord>(r: T): Promise<T & { waitingSince?: number }> {
    if (r.state !== "running") return r;
    const since = await this.waitingSince(r.id).catch(() => null);
    return since === null ? r : { ...r, waitingSince: since };
  }

  async userEsc(agent: AgentId): Promise<void> {
    return this.messaging.userEsc(agent);
  }

  async awaitUser(agent: AgentId, key: string): Promise<{ accepted: true }> {
    return this.messaging.awaitUser(agent, key);
  }

  async steered(agent: AgentId, count: number, key: string): Promise<void> {
    return this.messaging.steered(agent, count, key);
  }

  // list()/get() plus `pendingReason` on pending agents (additive field for the API and CLI).
  async withPendingReason<T extends AgentRecord>(r: T): Promise<T & { pendingReason?: string }> {
    if (r.state !== "pending") return r;
    const reason = await this.pendingReason(r.id).catch(() => "");
    return reason ? { ...r, pendingReason: reason } : r;
  }

  // TODO(session-reservation): reserve sessions per tree. Current behavior: children queue on placement.admit under one cap.
  // The cap is capacity.maxSessions with no per-tree share; a waiting parent keeps its slot until it yields.
  private async admit(id: AgentId, priority: number = PRIORITY.interactive): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const last = { v: "" };
    try {
      for (;;) {
        const r = await this.get(id);
        if (!r || (r.state !== "pending" && r.state !== "running") || this.draining) {
          if (r && this.draining) await this.notePending(r, last, pendingReasons.draining);
          await this.deps.placement.release(id).catch(() => {}); // drop a queued or just-promoted slot nobody will use
          return false;
        }
        // Host-health gates hold admission until the sandbox/journal/store recover or the resource gate reopens.
        if (this.degraded || this.journalFailed || !this.sandboxUp) {
          await this.notePending(r, last, !this.sandboxUp ? pendingReasons.sandboxDown : pendingReasons.host);
          await sleep(this.deps.admitRetryMs);
          continue;
        }
        const gate = await this.deps.resourceGate?.();
        if (gate && !gate.ok) {
          await this.notePending(r, last, gateReason(gate.reason));
          await sleep(this.deps.admitRetryMs);
          continue;
        }
        // An open provider breaker holds fresh starts (a resume is a retry and is paced by its own timer wait).
        const until =
          r.state === "pending"
            ? this.breaker.degradedUntil((r.executor === "container" ? containerSpec(r).provider : undefined) ?? this.deps.provider ?? "default", this.now())
            : null;
        if (until !== null) {
          await this.notePending(r, last, pendingReasons.degraded(until));
          await sleep(this.deps.admitRetryMs);
          continue;
        }
        const resources = specResources(containerSpec(r), this.deps.containerMemoryBytes);
        const a = await this.deps.placement.admit({
          agent: id,
          priority,
          ...(resources && { resources }),
          template: containerSpec(r).template ?? CODE_TEMPLATE_ID,
        });
        if (!("queued" in a)) {
          if (last.v !== "") await this.notePending(r, last, ""); // admitted: clear
          await this.journalRevisionMismatch();
          return true;
        }
        await this.notePending(r, last, a.reason);
        await new Promise<void>((wake) => {
          this.admitWaiters.set(id, wake);
          timer = setTimeout(() => {
            this.admitWaiters.delete(id);
            wake();
          }, this.deps.admitRetryMs); // safety net if the promotion callback is never wired
          timer.unref?.();
        });
        this.admitWaiters.delete(id);
        clearTimeout(timer);
        timer = undefined;
      }
    } catch (e) {
      clearTimeout(timer);
      this.admitWaiters.delete(id);
      if (e instanceof SandboxUnavailableError) await this.markSandboxDown();
      else if (this.isStoreDown(e)) this.markStoreDown(e);
      await this.deps.placement.release(id).catch(() => {});
      // Only a fresh (pending) start is finished here; a failed resume is left running for reconcile().
      const r = await this.get(id).catch(() => null);
      if (r?.state === "pending") await this.finish(id, "failed");
      return false;
    }
  }

  // See Lifecycle.settle.
  private async settle(id: AgentId, e: Live, overBudget: boolean, gen: number): Promise<void> {
    return this.lifecycle.settle(id, e, overBudget, gen);
  }

  // No-op (changed=false) if the agent already exited; the first exit wins.
  private async finish(id: AgentId, exit: ExitStatus, result?: unknown, cause?: ExitCause): Promise<{ record: AgentRecord | null; changed: boolean }> {
    return this.lifecycle.finish(id, exit, result, cause);
  }

  // The idempotent steps after the exited transition. Safe to re-run: recover() replays them for an
  // agent that crashed between the transition and the tail (journal, notify, cancel, reap).
  private async finishTail(upd: AgentRecord, exit: ExitStatus, cause?: ExitCause): Promise<void> {
    return this.lifecycle.finishTail(upd, exit, cause);
  }

  // The ONE writer of user-bound `message_sent` (a guard test enforces it): sanitizes the subject (toUser), broadcasts one
  // entry per escalation channel (key `${key}:${channel}`, so a replay is idempotent per channel), and no-ops when none is
  // configured. Agent-bound clips (signals, resume text) are not user-bound and stay clipText. `extra` carries the reply's
  // `subjectKind` and an ask's `options` (sanitized and capped like an ask's own options; an empty list is omitted).
  private async sendToUser(a: AgentRecord, purpose: MessageKind, subject: string, key: string, replyTo?: string, extra?: UserMessageExtra): Promise<void> {
    const options = (extra?.options ?? []).slice(0, ASK_OPTIONS_MAX).map((o) => toUser(o, ASK_OPTION_MAX));
    const reply = {
      ...(replyTo !== undefined && { replyTo }),
      ...(extra?.subjectKind !== undefined && { subjectKind: extra.subjectKind }),
      ...(options.length > 0 && { options }),
    };
    for (const channel of this.deps.channels.outbound()) {
      await this.record(a, { kind: "message_sent", channel, purpose, subject: toUser(subject), ...reply }, `${key}:${channel}`);
    }
  }

  private hasUserChannel(): boolean {
    return this.messaging.hasUserChannel();
  }

  private async toMailbox(sender: AgentRecord, to: AgentId, signal: Signal, key: string, generation?: number): Promise<boolean> {
    return this.messaging.toMailbox(sender, to, signal, key, generation);
  }

  private meterUsage(rec: AgentRecord, ev: Extract<HarnessEvent, { kind: "usage" }>): Promise<Extract<HarnessEvent, { kind: "usage" }>> {
    return this.budget.meterUsage(rec, ev);
  }

  // Returns the journal append promise unchanged (so the caller's await is not shifted an extra
  // microtask); the side `.catch` flips journalFailed on a resource error without wrapping the result.
  private record(r: AgentRecord, payload: JournalPayload, idempotencyKey: string): Promise<JournalEntry> {
    // The one place free-text from exceptions reaches the journal: host paths are redacted here (journal rows name ids, never host paths).
    const p = this.deps.journal.append({
      agent: r.id,
      host: r.host,
      generation: r.generation,
      payload: redactPayload(capToolPayload(payload), this.redactRoots),
      idempotencyKey,
    });
    p.catch((e) => {
      if (isResourceError(e)) this.markJournalFailed(e);
    });
    return p;
  }

  // Both revisions with the injected lookups (defaulting to the shared helpers), never throwing:
  // an unknown revision is surfaced as undefined and is never a mismatch.
  private revisionState(): { gitSha: string | undefined; imageRevision: string | undefined; mismatch: boolean } {
    let git: string | undefined;
    let image: string | undefined;
    try {
      git = this.deps.gitSha ? this.deps.gitSha() : gitSha();
    } catch {
      /* unknown */
    }
    try {
      image = this.deps.imageRevision ? this.deps.imageRevision(this.deps.image) : imageRevision(this.deps.image);
    } catch {
      /* unknown */
    }
    return { gitSha: git, imageRevision: image, mismatch: revisionMismatch(git, image) };
  }

  // Journal the revision mismatch once per boot at the first admission (best-effort, never blocks
  // admission) so the skew is visible in ps/show/trace even if nobody runs doctor.
  private async journalRevisionMismatch(): Promise<void> {
    if (this.revisionWarned) return;
    this.revisionWarned = true;
    const rev = this.revisionState();
    if (!rev.mismatch) return;
    const root = await this.root().catch(() => null);
    if (root) {
      await this.record(
        root,
        {
          kind: "host_error",
          component: "daemon",
          message: `client/server revision mismatch: pomtreed git ${rev.gitSha} vs agent image ${rev.imageRevision} (rebuild the image)`,
        },
        "host:revision-mismatch",
      ).catch(() => {});
    }
  }
}

// The root supervisor's stable id for a host: a hash of the host id, so it is a safe path segment and ref component whatever
// the host id holds, and the same on every restart.
export function rootAgentIdFor(hostId: string): AgentId {
  return `root-${createHash("sha256").update(hostId).digest("hex").slice(0, 24)}`;
}
