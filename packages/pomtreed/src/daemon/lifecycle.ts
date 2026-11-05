// Agent lifecycle of the Daemon: spawn, drive and the run segment, yield and resume,
// settle and finish, reap, cancel and kill, interrupts, adoption, the per-agent claim and the forced-resume chokepoint.
// It is the top layer, so it calls the other modules directly; the few things that stay on `Daemon` (admission and the host-health latches, `push`, the keyed op markers,
// `sendToUser`) are reached through `ctx.hub`. `live` and `resuming` are the Daemon's own maps; the claim state (`claims`, `dirty`,
// `starting`), `kicks`, `urgent`, `spawning` and `adoptFailures` live here; the provider retry count is durable (Registry.bumpProviderAttempts).

import { mkdirSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CODE_TEMPLATE_ID,
  allowlistTemplateProblem,
  canonical,
  IllegalTransitionError,
  DOCKER_GROUP_ACTION,
  deadlineAction,
  EXIT_CAUSE_WORDING,
  START_FAILURE_CAUSE,
  SandboxStartError,
  SandboxUnavailableError,
  TemplateError,
  type SandboxSpec,
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  type ContainerConfigValues,
  containerConfigEnv,
  containerContract,
  MAX_HANDOFF_BYTES,
  StaleGenerationError,
  PASSIVE_SETTLE_KIND,
  parseDeterministicSpec,
  dispositionError,
  isUserAbort,
  validWorkflowState,
  validWorkflowWait,
  waitChildIds,
  MAX_PASSIVE_SETTLES,
  initialSettle,
  settleStep,
  POMTREED_KINDS,
} from "@pomtree/core";
import type {
  AgentId,
  AgentRecord,
  Checkpoint,
  DeterministicOps,
  DeterministicRunContext,
  DeterministicSpec,
  ExitCause,
  ExitSignal,
  ExitStatus,
  SandboxHandle,
  Signal,
  SpawnSpec,
  Template,
  WaitCondition,
  WorkspaceId,
  MountSpec,
} from "@pomtree/core";
import { MAX_SESSION_BYTES, PI_SESSION_PATH, SafeOpenError, safeReadFile, safeWriteFile, trimTornTail, verifySession } from "@pomtree/harness-pi";
import { emptyManifest, mountPlan } from "@pomtree/agent-image";
import { egressPolicy } from "../egress.ts";
import { delegationProblem } from "./delegation.ts";
import { DEFAULT_CONTAINER_MEMORY_BYTES } from "../host-guards.ts";
import { continuationBarrier } from "../workflows.ts";
import { CONTINUATION_KIND, latestContinuation } from "../workflow-continuation.ts";
import { PRIORITY, nextDeadline, satisfied } from "@pomtree/sched";
import { AGENT_TOKEN_TTL_MS, issueToken } from "../auth.ts";
import { firstModel } from "../model-catalog.ts";
import { effectiveGrants, grantSubset } from "../state-policy.ts";
import { LifecycleError, agentIdFor, carve, checkFanout, isDone, isResourceError, providerBackoffMs, unreaped } from "../lifecycle.ts";
import { TEMPLATES_NOT_CONFIGURED, uncommittedWorkMessage, unknownTemplateMessage } from "../error-codes.ts";
import { MAX_TIMER_MS } from "../orchestrator.ts";
import { pumpBuffered } from "../pump.ts";
import { statusSubject } from "../to-user.ts";
import { describeDriverError } from "../driver-error.ts";
import { isBudgetRefusal } from "../budget-raise.ts";
import { WAITING_KIND } from "../watchdog.ts";
import type { DeterministicStartRequest, Live, SpawnRequest } from "../daemon-types.ts";
import { defaultDenyEgress, describeRunHardening, type RunHardening } from "@pomtree/sandbox-docker";
import { describeSandboxSpec, type SandboxSpecSummary } from "../sandbox-spec.ts";
import {
  DEFAULT_CONTAINER_CONFIG,
  SANDBOX_LIFECYCLE_KIND,
  browserEnv,
  exitedDetail,
  journalFailed,
  lastToolFailureCause,
  spawnedPayload,
  withoutControllerEnv,
} from "../daemon-util.ts";
import type { WaitCtx } from "../daemon-util.ts";
import type { DaemonCtx, ForceResumeCause, InterruptMode } from "./ctx.ts";
import type { Budget } from "./budget.ts";
import type { Merge } from "./merge.ts";
import type { Messaging } from "./messaging.ts";
import type { Reconcile } from "./reconcile.ts";
import type { Sweeps } from "./sweeps.ts";
import type { Tree } from "./tree.ts";
import type { ProviderBreaker } from "../provider-breaker.ts";
import { AUTO_RESTART, RESTART_RESET } from "./reconcile.ts";
import {
  containerSpec,
  gitIdentityEnv,
  checkpointTemplate,
  specResources,
  classifySandboxExit,
  WORKSPACE_MOUNT_DIR,
  FORK_KIND,
  YIELD_INBOX_KIND,
  YIELD_CTX_KIND,
  INTERRUPT_KIND,
  INTERRUPT_DONE_KIND,
  PROVIDER_DEGRADED_KIND,
  HANDOFF_REQUIRED,
  SIGNAL_HANDOFF_CHARS,
  clipAgentText,
  clipText,
  handoffOf,
  usd,
  SESSION_FILE,
  SESSION_MOUNT_DIR,
  isStoreDown,
  folderId,
  signalToWake,
  clip,
  transitionKey,
} from "../daemon-util.ts";

// Journal prefix (an `error` entry) that ends a `pausing` marker: `pause-aborted: <attempt id>`.
export const PAUSE_ABORTED = "pause-aborted:";
// Journal kinds only a running agent produces after yield() journaled its marker (yield's own writes, the stop and a late pump
// event are not among them): any one of them after a marker means the pause was abandoned and the agent kept executing.
const EXECUTION_KINDS = new Set<string>(["proxy_call", "message_sent", "escalation_raised", "ingested"]);

// sha256 hex of a normalized result's canonical JSON (core `canonical`) with its status, journaled with the result before redaction so a
// same-key retry can be told apart from a different value (Lifecycle.assertSameResult).
function resultDigest(status: "succeeded" | "failed", result: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ status, result })))
    .digest("hex");
}

// How each forced-resume cause differs (see Daemon.forceResume). `checkpoint`: the stop-checkpoint key suffix, whether a
// failure propagates, and whether it needs the agent's folder; `stale`: how the caller learns another actor resumed first;
// `observed`: whether the resume carries the observed generation (a typed no-op when it moved).
const FORCE_RESUME_POLICY: Record<
  ForceResumeCause,
  {
    charges: boolean; // journals an `auto-restart:` entry (one unit of maxRestarts) and refuses when the budget is spent
    checkpoint: { suffix: string; strict: boolean; needsFolder: boolean } | null;
    stale: "generation" | "claim" | null;
    observed: boolean;
  }
> = {
  boot: { charges: false, checkpoint: { suffix: "recover", strict: false, needsFolder: true }, stale: "claim", observed: false },
  reconcile_orphan: { charges: true, checkpoint: { suffix: "recover", strict: false, needsFolder: true }, stale: "claim", observed: false },
  host_fault: { charges: true, checkpoint: { suffix: "auto-restart", strict: true, needsFolder: false }, stale: "generation", observed: true },
  interrupted: { charges: false, checkpoint: { suffix: "interrupt", strict: true, needsFolder: false }, stale: "generation", observed: false },
  watchdog: { charges: false, checkpoint: null, stale: null, observed: true },
};

// Resume wording for operator interrupts (Lifecycle.takeInterrupts). The notes stand alone when no message is pending any more.
const INTERRUPTED_NOTE = "Your previous turn was interrupted by the operator (in-flight tool calls were aborted; re-check workspace state before continuing).";
const WOKE_NOTE = "Resumed: woken by an operator message.";
export function interruptResumeText(mode: InterruptMode, wake: string, pend: { body: string }[]): string {
  const list = pend.length === 1 ? pend[0]!.body : pend.map((m, i) => `${i + 1}. ${m.body}`).join("\n");
  const s = pend.length === 1 ? "" : "s";
  if (mode === "interrupted") return `${INTERRUPTED_NOTE} Operator message${s}: ${list}`;
  if (mode === "woke") return `Resumed: woken by an operator message${s}: ${list}`;
  // Any other resume (a timer or message wake, a budget grant): its own wake text first, then the messages.
  return `${wake} Operator message${s} received while you were parked: ${list}`;
}

export type MergeOutcome = { status: "merged" | "skipped" | "conflict"; detail: string };
export type ReapOutcome = { record: AgentRecord; unusedMicros: number; merge?: MergeOutcome };

export class Lifecycle {
  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;
  private readonly messaging: Messaging;
  private readonly budget: Budget;
  private readonly merger: Merge;
  private readonly sweeps: Sweeps;
  private readonly reconciler: Reconcile;
  private readonly live: Map<AgentId, Live>;
  private readonly resuming: Map<AgentId, Promise<AgentRecord>>;
  private readonly breaker: ProviderBreaker;
  private readonly epoch: string;
  // Blocked server-side long-polls (inbox/wait/ask) per waiting agent; an interrupt or cancel releases them at once.
  // Runtime-only by nature (a poll is an open request): a restart drops the requests too.
  private kicks = new Map<AgentId, Set<() => void>>();
  private urgent = new Set<AgentId>(); // next resume jumps the admission queue (interrupt); runtime-only, priority is an optimisation
  // How the next resume's run words the pending interrupts it delivers (interruptResumeText), per resumed generation. Runtime-only
  // wording: which interrupts are pending lives in the journal alone, and a missing entry falls back to the plain "resume" wording.
  private interruptModes = new Map<AgentId, { generation: number; mode: InterruptMode }>();
  private spawning: Promise<unknown> = Promise.resolve(); // serializes spawns so fan-out/budget checks can't race
  // Per-agent claim: try-acquire exclusion between the restart-class actors (reconcile,
  // settle, resumeAgent); taken synchronously, never awaited, so it cannot deadlock with the `result:<id>` lock. Cancel, kill and
  // yield never take it. A resume that starts while another actor holds it sets `preempted` (the holder's decision is stale) and
  // proceeds. `dirty` = agents reconcile skipped, re-run on release. `starting` = generation -> resumed, covering the gap between
  // resumeAgent returning and runResumed creating its `live` placeholder; reconcile skips such agents. All in memory
  // (TODO(rule6)); a restart starts empty.
  private readonly starting = new Map<AgentId, number>();
  private readonly claims = new Map<AgentId, { purpose: string; preempted: boolean }>();
  private readonly dirty = new Set<AgentId>();
  private readonly adoptFailures = new Map<AgentId, number>();

  constructor(
    ctx: DaemonCtx,
    tree: Tree,
    messaging: Messaging,
    budget: Budget,
    merger: Merge,
    sweeps: Sweeps,
    reconciler: Reconcile,
    live: Map<AgentId, Live>,
    resuming: Map<AgentId, Promise<AgentRecord>>,
    breaker: ProviderBreaker,
    epoch: string,
  ) {
    this.ctx = ctx;
    this.tree = tree;
    this.messaging = messaging;
    this.budget = budget;
    this.merger = merger;
    this.sweeps = sweeps;
    this.reconciler = reconciler;
    this.live = live;
    this.resuming = resuming;
    this.breaker = breaker;
    this.epoch = epoch;
  }

  // Runs fn inside the `spawning` chain (the one chain, shared with spawn()); the budget grant carve uses it through the hub.
  exclusiveSpawn(fn: () => Promise<void>): Promise<void> {
    const run = this.spawning.then(fn);
    this.spawning = run.catch(() => {});
    return run;
  }

  markDirty(id: AgentId): void {
    this.dirty.add(id);
  }

  startingGeneration(id: AgentId): number | undefined {
    return this.starting.get(id);
  }

  // The model for a spawn that names none and has no template/parent/daemon model to inherit: the catalog's
  // first model for the provider. Undefined when something already supplies a model, or no catalog is wired
  // (library use); an empty catalog is a 400, never an unvalidated Pi default.
  private async defaultModelPick(t: Template | null, parentSpec: SpawnSpec | undefined): Promise<{ provider: string; id: string } | undefined> {
    const d = this.ctx.deps;
    if (!d.models || t?.model !== undefined || parentSpec?.model !== undefined || d.model !== undefined) return undefined;
    const provider = t?.provider ?? parentSpec?.provider ?? d.provider;
    const list = await d.models.list();
    // list.default is the catalog's resolved default (Pi settings default if listed, else first); reuse it when in scope.
    const pick = list.default && (!provider || list.default.provider === provider) ? list.default : firstModel(list.models, provider);
    if (!pick) {
      throw new LifecycleError(
        400,
        `no model: none was given and no default could be resolved (${list.reason ?? "the catalog lists no models for the provider"}); pass --model PROVIDER/ID (see \`pomtree models\`)`,
      );
    }
    return pick;
  }

  // `fence` (host ops only) is re-checked inside the serialized chain, right before the record is created.
  spawn(requester: AgentId, req: SpawnRequest, fence?: () => Promise<void>): Promise<AgentRecord> {
    const run = this.spawning.then(() => this.spawnNow(requester, req, fence));
    this.spawning = run.catch(() => {});
    return run;
  }

  private async spawnNow(requester: AgentId, req: SpawnRequest, fence?: () => Promise<void>): Promise<AgentRecord> {
    const d = this.ctx.deps;
    if (req.wrapupMs !== undefined && (!Number.isSafeInteger(req.wrapupMs) || req.wrapupMs <= 0 || req.wrapupMs > Number.MAX_SAFE_INTEGER - this.ctx.now()))
      throw new LifecycleError(400, "wrapupMs must be a positive safe integer duration");
    if (req.disposition !== undefined) {
      const problem = dispositionError(req.disposition);
      if (problem !== null) throw new LifecycleError(400, problem);
    }
    // Fail closed: a store outage (ENOSPC/busy/IO) means a spawn cannot be recorded durably, so it 503s.
    if (this.ctx.hub.store.degraded()) throw new LifecycleError(503, "store is degraded; spawns are paused");
    if (this.ctx.hub.store.draining()) throw new LifecycleError(503, "daemon is draining; spawns are paused");
    if (d.resourceGate) {
      const gate = await d.resourceGate();
      if (!gate.ok) throw new LifecycleError(503, gate.reason ?? "host resource gate closed");
    }
    const id = agentIdFor(requester, req.idempotencyKey); // namespaced by who asked, never by who adopts
    const existing = await d.registry.get(id);
    if (existing) {
      // A terminal agent is never retried: a failed cron fire or a retried `pomtree spawn` must
      // surface a conflict rather than silently returning the already-ran record.
      if (existing.executor !== "container")
        throw new LifecycleError(409, "idempotency key is already used by a deterministic agent; use a new key", { code: "idempotency_conflict" });
      if (fence && req.model && (existing.spec.provider !== req.model.provider || existing.spec.model !== req.model.id))
        throw new LifecycleError(409, "child spawn key is already bound to a different model; use a new key", { code: "idempotency_conflict" });
      if (existing.state === "exited" || existing.state === "reaped") {
        const detail = existing.exit ? `${existing.state}/${existing.exit}` : existing.state;
        // The message keeps its `already ran:` prefix: the chat spawn path (messaging.ts) matches it to return the original receipt.
        throw new LifecycleError(409, `already ran: ${detail}; this idempotency key names a finished agent (use a new key to spawn again)`, {
          code: "idempotency_conflict",
        });
      }
      // A retry must not be re-judged against limits it already consumed, but the keyed steps after create
      // (the `spawned` journal entry, the deadline, and the actual start) may have been lost to a crash.
      // Replay them for a still-pending record so it is not stranded.
      if (existing.state === "pending") {
        await this.ctx.record(existing, spawnedPayload(existing), `${existing.id}:spawned`);
        await this.budget.spawnDeadline(existing, req, await d.registry.get(requester));
        await d.orchestrator.start(existing.id, existing.generation);
      }
      return existing;
    }
    const p = await d.registry.get(requester);
    if (!p) throw new LifecycleError(404, `no such parent: ${requester}`);
    const rootId = await this.tree.rootAgentId();
    const isRoot = p.id === rootId;
    let template: Template | null = null;
    if (req.template !== undefined) {
      if (!d.templates && req.template !== CODE_TEMPLATE_ID) throw new LifecycleError(400, TEMPLATES_NOT_CONFIGURED);
      try {
        template = await this.tree.resolveTemplate(req.template);
      } catch (e) {
        // The named file exists but fails validation: the caller's request names a broken template (422), never a daemon fault.
        if (e instanceof TemplateError) throw new LifecycleError(422, e.message, { code: "template_error" });
        throw e;
      }
      if (!template) throw new LifecycleError(404, unknownTemplateMessage(req.template), { code: "unknown_template" });
      // Operator (root) spawns may use any template; agents are default-deny unless a
      // mayUseTemplate predicate grants them. TODO(templates): agent-use is a later policy knob.
      if (d.mayUseTemplate ? !(await d.mayUseTemplate(requester, template)) : !isRoot) {
        throw new LifecycleError(403, `template ${req.template} is not permitted for this caller`);
      }
    }
    if (req.template === undefined && p.executor === "deterministic" && d.mayUseTemplate) {
      template = await this.tree.resolveTemplate(CODE_TEMPLATE_ID);
      if (!template || !(await d.mayUseTemplate(requester, template))) throw new LifecycleError(403, "default template is not permitted for this caller");
    }
    // A caller that needs a tool-restricted worker (an analyst) names the profile; a template without exactly it is refused before any row or
    // container exists, so the worker can never start with the default loadout (bash, read, write, edit).
    if (req.requireAllowlist !== undefined && template?.allowlist !== req.requireAllowlist)
      throw new LifecycleError(403, `template ${template?.id ?? CODE_TEMPLATE_ID} does not carry the required allowlist profile ${req.requireAllowlist}`);
    // The analyst/specialist rule (core allowlistTemplateProblem) is checked here too, not only by the template store's file parser, so a
    // template built in code (a TemplateStore that does not parse files) is refused before any row exists, with the store's error text.
    const templateProblem = template ? allowlistTemplateProblem(template) : undefined;
    if (template && templateProblem !== undefined) throw new LifecycleError(422, `${template.id}: ${templateProblem}`, { code: "template_error" });
    const dispositionProblem = template?.disposition !== undefined ? dispositionError(template.disposition) : null;
    if (template && dispositionProblem !== null) throw new LifecycleError(422, `template ${template.id}: ${dispositionProblem}`, { code: "template_error" });
    if (fence && req.model !== undefined) {
      const pick = req.model;
      if (!pick || typeof pick.provider !== "string" || !pick.provider || typeof pick.id !== "string" || !pick.id)
        throw new LifecycleError(400, "invalid explicit child model");
      if ((template?.provider !== undefined && template.provider !== pick.provider) || (d.provider !== undefined && d.provider !== pick.provider))
        throw new LifecycleError(403, "explicit child model provider does not match host/template policy");
      const catalog = await d.models?.list();
      if (!catalog || catalog.source === "none" || !catalog.models.some((m) => m.provider === pick.provider && m.id === pick.id))
        throw new LifecycleError(400, "explicit child model is not available in the host catalog");
    }
    if (template?.egress?.kind === "audited-public" && d.publicEgressReady && !d.publicEgressReady())
      throw new LifecycleError(503, "public egress audit collector is unavailable");
    await this.checkStateGrants(p, isRoot, template?.id ?? CODE_TEMPLATE_ID);
    // Delegation only narrows: a non-root container parent's child may not exceed its egress or resource limits. The operator (root) is
    // unbounded, and a deterministic parent (a reviewed driver with no sandbox spec) is bounded by the operator's template grant instead.
    if (!isRoot && p.executor === "container") {
      const problem = delegationProblem(this.tree.resolvedSpec(template, undefined), p.spec, template?.id ?? null, {
        memoryBytes: d.containerMemoryBytes ?? DEFAULT_CONTAINER_MEMORY_BYTES,
      });
      if (problem !== null) throw new LifecycleError(403, problem, { code: "delegation_exceeds_parent" });
    }
    checkFanout(this.ctx.limits, {
      depth: (await this.tree.depth(p)) + 1,
      liveChildren: unreaped(await this.tree.ownedChildren(p)).length,
      isRoot,
    });
    const budgetMicros = carve(
      req.budgetMicros ?? template?.budgetMicros,
      isRoot ? (d.topLevelBudgetMicros ?? d.defaultBudgetMicros) : d.defaultBudgetMicros,
      p.budgetMicros - (await this.tree.consumed(p)),
    );
    const forkSource = await this.merger.resolveFork(p, req);
    const parentSpec = p.executor === "container" ? p.spec : undefined;
    const modelPick = req.model ?? (await this.defaultModelPick(template, parentSpec));
    const rec = await this.createFenced(requester, fence, () =>
      d.registry.create({
        id,
        parent: requester,
        name: req.name,
        task: req.task,
        host: d.hostId,
        budgetMicros,
        idempotencyKey: `${requester}:${req.idempotencyKey}`,
        // Disposition: the request beats the template (resolvedSpec copies the template's); absent means hold.
        spec: {
          ...this.tree.resolvedSpec(template, parentSpec, modelPick),
          wrapupMs: req.wrapupMs ?? 30_000,
          ...(req.disposition !== undefined && { disposition: { ...req.disposition } }),
        },
      }),
    );
    if (rec.state === "pending") {
      await this.ctx.record(rec, spawnedPayload(rec), `${rec.id}:spawned`);
      if (forkSource) await this.ctx.record(rec, { kind: FORK_KIND, ...forkSource }, `${rec.id}:fork`);
      await this.budget.spawnDeadline(rec, req, p);
      await d.orchestrator.start(rec.id, rec.generation);
    }
    return rec;
  }

  // State grants are delegation-safe: a child may hold only grants its requester effectively holds (operator/root = all). The same
  // pure functions decide this and each later request (state-routes.ts), so the two cannot disagree.
  private async checkStateGrants(requester: AgentRecord, isRoot: boolean, childKey: string): Promise<void> {
    const policy = this.ctx.deps.stateGrants;
    if (!policy || isRoot) return;
    const child = policy.grantsFor(childKey);
    if (child.length === 0) return;
    const held = await effectiveGrants(policy.grantsFor, requester, (id) => this.ctx.deps.registry.get(id));
    if (!grantSubset(child, held)) throw new LifecycleError(403, `state grants of ${childKey} exceed the requester's grants`);
  }

  // The create of a fenced child runs under the requester's result lock, after its fence: chain outer -> result:<parent> inner.
  // Without a fence (external callers) it is the plain create.
  private createFenced<T>(requester: AgentId, fence: (() => Promise<void>) | undefined, create: () => Promise<T>): Promise<T> {
    if (!fence) return create();
    return this.ctx.withLock(`result:${requester}`, async () => {
      await fence();
      return create();
    });
  }

  // Internal start of a deterministic (non-container) task: no route, no model, no sandbox. Serialized in the spawning chain
  // like spawn(); the requester is the host-supplied parent. An unknown or unavailable driver is refused before any record exists.
  // `fence` (host ops only) is re-checked inside the serialized chain, right before the record is created.
  startDeterministic(requester: AgentId, req: DeterministicStartRequest, fence?: () => Promise<void>): Promise<AgentRecord> {
    const run = this.spawning.then(() => this.startDeterministicNow(requester, req, fence));
    this.spawning = run.catch(() => {});
    return run;
  }

  private async startDeterministicNow(requester: AgentId, req: DeterministicStartRequest, fence?: () => Promise<void>): Promise<AgentRecord> {
    const d = this.ctx.deps;
    if (this.ctx.hub.store.degraded()) throw new LifecycleError(503, "store is degraded; spawns are paused");
    if (this.ctx.hub.store.draining()) throw new LifecycleError(503, "daemon is draining; spawns are paused");
    let spec: DeterministicSpec;
    try {
      spec = parseDeterministicSpec(req.spec);
    } catch (e) {
      throw new LifecycleError(400, e instanceof Error ? e.message : "invalid deterministic spec");
    }
    const driver = d.deterministicExecutors?.get(spec.driver);
    if (!driver || driver.driver !== spec.driver)
      throw new LifecycleError(400, `no deterministic driver ${JSON.stringify(spec.driver)} is available on this host`);
    const sreq: SpawnRequest = {
      name: req.name,
      task: req.task,
      idempotencyKey: req.idempotencyKey,
      budgetMicros: req.budgetMicros,
      deadlineMs: req.deadlineMs,
    };
    const id = agentIdFor(requester, req.idempotencyKey);
    const existing = await d.registry.get(id);
    if (existing) {
      if (existing.executor !== "deterministic")
        throw new LifecycleError(409, "idempotency key is already used by a container agent; use a new key", { code: "idempotency_conflict" });
      // A keyed replay returns the original record, even a finished one: nothing reruns and no effect repeats.
      if (existing.state === "pending") {
        await this.ctx.record(existing, spawnedPayload(existing), `${existing.id}:spawned`);
        await this.budget.spawnDeadline(existing, sreq, await d.registry.get(requester));
        await d.orchestrator.start(existing.id, existing.generation);
      }
      return existing;
    }
    const p = await d.registry.get(requester);
    if (!p) throw new LifecycleError(404, `no such parent: ${requester}`);
    const rootId = await this.tree.rootAgentId();
    const isRoot = p.id === rootId;
    await this.checkStateGrants(p, isRoot, spec.driver);
    checkFanout(this.ctx.limits, {
      depth: (await this.tree.depth(p)) + 1,
      liveChildren: unreaped(await this.tree.ownedChildren(p)).length,
      isRoot,
    });
    // Deadline is validated with the same rule spawnDeadline applies, before anything is created: no pending row, no carved budget.
    if (req.deadlineMs !== undefined && (!Number.isFinite(req.deadlineMs) || req.deadlineMs < 0))
      throw new LifecycleError(400, "deadlineMs must be a non-negative number");
    const budgetMicros = carve(
      req.budgetMicros,
      isRoot ? (d.topLevelBudgetMicros ?? d.defaultBudgetMicros) : d.defaultBudgetMicros,
      p.budgetMicros - (await this.tree.consumed(p)),
    );
    const rec = await this.createFenced(requester, fence, () =>
      d.registry.create({
        id,
        parent: requester,
        name: req.name,
        task: req.task,
        host: d.hostId,
        budgetMicros,
        idempotencyKey: `${requester}:${req.idempotencyKey}`,
        executor: "deterministic",
        spec,
      }),
    );
    if (rec.state === "pending") {
      await this.ctx.record(rec, spawnedPayload(rec), `${rec.id}:spawned`);
      await this.budget.spawnDeadline(rec, sreq, p);
      await d.orchestrator.start(rec.id, rec.generation);
    }
    return rec;
  }

  // The one run loop of a deterministic task. The driver runs detached; the loop returns as soon as the driver returns or the
  // run aborts (cancel, deadline, settle), so a driver that ignores its signal cannot hold the task open. First exit wins.
  private async driveDeterministic(id: AgentId, gen: number): Promise<void> {
    const d = this.ctx.deps;
    const cur = await d.registry.get(id);
    if (!cur || cur.executor !== "deterministic") return;
    if (this.live.has(id)) return; // already running: a replayed start
    if (cur.generation !== gen || (cur.state !== "pending" && cur.state !== "running")) return;
    const entry: Live = { cancelled: false, deterministic: true, generation: gen, abort: new AbortController() };
    this.live.set(id, entry);
    try {
      const deadlineAt = await this.budget.sessionDeadlineAt(id);
      if (deadlineAt !== null) {
        this.budget.deadlines.set(id, deadlineAt);
        if (deadlineAt <= this.ctx.now()) entry.timedOut = true;
        this.armDeadline(entry, deadlineAt);
      }
      const driver = d.deterministicExecutors?.get(cur.spec.driver);
      if (!driver || driver.driver !== cur.spec.driver) {
        entry.driverError = { error: new LifecycleError(503, `deterministic driver ${cur.spec.driver} is unavailable (is its extension loaded?)`) };
        return void (await this.settleDeterministic(id, entry));
      }
      const running = cur.state === "running" ? cur : await d.registry.transition(id, gen, "running", { idempotencyKey: transitionKey(id, gen, "running") });
      await this.ctx.record(running, { kind: "started" }, `${id}:${gen}:started`);
      // Start gate. A cancel that found no live entry finishes the row under `result:<id>` (stopDetNoLive). `live` is already
      // registered, so under that lock either the finish landed first (the row is no longer running: the driver never starts)
      // or the stopper sees this entry and aborts it through the run loop. A bare read outside the lock could fall between
      // finish's pending->running and running->exited steps.
      const startable = await this.ctx.withLock(`result:${id}`, async () => {
        const g = await d.registry.get(id);
        return (
          !!g &&
          g.state === "running" &&
          g.generation === gen &&
          !entry.abort!.signal.aborted &&
          !entry.cancelled &&
          !entry.timedOut &&
          this.live.get(id) === entry
        );
      });
      if (!startable) {
        await this.settleDeterministic(id, entry);
        return;
      }
      const continuation = continuationBarrier(driver) ? await latestContinuation(d.journal, id) : undefined;
      entry.approvalReadSignals = new Set(continuation?.inbox ?? []);
      const ctx: DeterministicRunContext = {
        agent: id,
        generation: gen,
        host: d.hostId,
        input: cur.spec.input,
        ...(continuation && { continuation: continuation.state }),
        signal: entry.abort!.signal,
        deadlineAt: deadlineAt !== null && Number.isFinite(deadlineAt) ? deadlineAt : null,
        ops: this.detOps(id, gen, entry),
      };
      // A cancel, deadline or supersede that lands before this microtask must keep the driver body from starting.
      const run = Promise.resolve().then(() => (entry.abort!.signal.aborted || this.live.get(id) !== entry ? undefined : driver.run(ctx)));
      await new Promise<void>((resolve) => {
        const sig = entry.abort!.signal;
        if (sig.aborted) return resolve();
        sig.addEventListener("abort", () => resolve(), { once: true });
        run.then(
          () => resolve(),
          (error: unknown) => {
            entry.driverError = { error };
            resolve();
          },
        );
      });
      if (entry.suspension && !entry.cancelled && !entry.timedOut) {
        // Continuation must join the body/effects, but a hard deadline may settle terminal without that join.
        // WorkflowHost still tracks the actual effects for shutdown; an abort never admits another generation.
        const joined = run
          .catch(() => {})
          .then(async () => {
            await continuationBarrier(driver)?.(id);
          });
        await new Promise<void>((resolve, reject) => {
          const signal = entry.abort!.signal;
          const aborted = () => resolve();
          if (signal.aborted) {
            void joined.catch(() => {});
            resolve();
            return;
          }
          signal.addEventListener("abort", aborted, { once: true });
          joined.then(
            () => {
              signal.removeEventListener("abort", aborted);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener("abort", aborted);
              reject(error);
            },
          );
        });
        if (entry.abort!.signal.aborted) await this.settleDeterministic(id, entry);
        else await this.parkDeterministic(id, entry);
      } else await this.settleDeterministic(id, entry);
    } catch (e) {
      if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
      entry.driverError ??= { error: e };
      await this.settleDeterministic(id, entry).catch(() => {});
    } finally {
      // Every exit path stops the driver's signal and disposes the deadline timer, even when settling itself failed.
      entry.abort?.abort();
      clearTimeout(entry.killTimer);
      if (this.live.get(id) === entry) this.live.delete(id);
      if (entry.suspension) await this.checkWorkflowWait(id).catch(() => {});
    }
  }

  // Only the host's reviewed WorkflowHost adapter can opt in; ordinary deterministic drivers retain fail-on-restart behavior.
  canContinue(r: AgentRecord): boolean {
    return r.executor === "deterministic" && !!continuationBarrier(this.ctx.deps.deterministicExecutors?.get(r.spec.driver));
  }

  private async parkDeterministic(id: AgentId, e: Live): Promise<void> {
    const d = this.ctx.deps;
    await this.ctx.withLock(`result:${id}`, async () => {
      const r = await d.registry.get(id);
      if (!r || r.generation !== e.generation || r.state !== "running") return;
      if (e.cancelled || e.timedOut) return this.settleDeterministicLocked(id, e);
      await d.registry.transition(id, r.generation, "yielded", { idempotencyKey: `${id}:${r.generation}:workflow-yielded` });
    });
    const r = await d.registry.get(id);
    if (r?.state === "yielded") {
      await this.ctx.record(r, { kind: "yielded" }, `${id}:${r.generation}:yielded`);
      await d.orchestrator.waitFor(id, this.workflowArmedWait(id, e.suspension!.wait));
    }
  }

  // Re-check both level child state and newly queued signals after persistence, including the send/yield race.
  async checkWorkflowWait(id: AgentId): Promise<void> {
    const d = this.ctx.deps;
    const r = await d.registry.get(id);
    if (!r || r.state !== "yielded" || !this.canContinue(r) || this.live.has(id)) return;
    const cp = await latestContinuation(d.journal, id);
    if (!cp) return;
    const deadline = await this.budget.sessionDeadlineAt(id);
    if (deadline !== null) this.budget.deadlines.set(id, deadline);
    if (deadline !== null && deadline <= this.ctx.now()) return void (await this.finish(id, "timed_out"));
    await d.orchestrator.waitFor(id, this.workflowArmedWait(id, cp.wait));
    // Child exits and timers are level-triggered, regardless of whether a delivery raced the snapshot.
    if (await this.workflowWaitSatisfied(cp.wait)) {
      await this.resumeAgent(id);
      return;
    }
    for (const signal of await d.mailbox.peek(id)) {
      // TODO(steer): a queued escalation already in cp.inbox still wakes, so a workflow that re-suspends without acking it re-wakes on every check (a resume loop). cp.inbox cannot tell an observed escalation from one that arrived mid-run unseen, so dropping this clause would lose that wake; current behavior: always wake.
      if (!cp.inbox.includes(signal.id) || signal.kind === "escalation") {
        await this.wakeResume(id, signal);
        if ((await d.registry.get(id))?.state !== "yielded") break;
      }
    }
  }

  private workflowArmedWait(id: AgentId, wait: WaitCondition): WaitCondition {
    const at = this.budget.deadlines.get(id);
    // Durable orchestrators must register a signal receiver even for a timer-only dependency wait, so attention and
    // approval decisions can interrupt it. wakeResume still checks the original persisted wait for ordinary messages.
    return { kind: "any", of: [wait, { kind: "message" }, ...(at === undefined ? [] : [{ kind: "timer" as const, at }])] };
  }

  // Complete the durable snapshot -> yielded edge if a crash interrupted suspension. Do not run downstream early.
  async recoverWorkflow(r: AgentRecord): Promise<void> {
    const d = this.ctx.deps;
    const snapshot = await latestContinuation(d.journal, r.id);
    if (snapshot?.generation === r.generation) {
      await d.registry.transition(r.id, r.generation, "yielded", { idempotencyKey: `${r.id}:${r.generation}:workflow-yielded` });
      await this.checkWorkflowWait(r.id);
    } else await this.resumeAgent(r.id, "workflow recovery", { forced: true, observedGeneration: r.generation });
  }

  private async workflowWaitSatisfied(wait: WaitCondition, signal?: Signal): Promise<boolean> {
    if (signal?.kind === "approval_decided") return true; // terminal attention is independent of the dependency/timer wait
    const done = new Set<AgentId>();
    for (const id of waitChildIds(wait)) {
      const child = await this.ctx.deps.registry.get(id);
      if (child && (child.state === "exited" || child.state === "reaped")) done.add(id);
    }
    return satisfied(wait, { signal, childDone: (id) => done.has(id), now: this.ctx.now() });
  }

  // Cancel or kill of a deterministic run: flag, abort the driver's signal, then settle (idempotent with the run loop).
  private async stopDeterministic(id: AgentId, e: Live): Promise<void> {
    e.cancelled = true;
    e.abort?.abort();
    await this.settleDeterministic(id, e);
  }

  // The single terminal path of a deterministic run. A submitted result already finished the run (ops.submitResult); this
  // covers cancel, timeout, a driver error and a driver return without a result. Aborts the driver's signal afterwards so
  // late ops are refused.
  // Serialized on the same `result:<id>` lock as the submitted-result writer, so the two linearize: whichever commits first wins.
  private async settleDeterministic(id: AgentId, e: Live): Promise<void> {
    try {
      await this.ctx.withLock(`result:${id}`, () => this.settleDeterministicLocked(id, e));
    } finally {
      e.abort?.abort(); // also when the settle itself failed: a cooperative driver is told to stop
      clearTimeout(e.killTimer);
    }
  }

  private async settleDeterministicLocked(id: AgentId, e: Live): Promise<void> {
    const r = await this.ctx.deps.registry.get(id);
    if (!r || isDone(r)) {
      e.abort?.abort();
      return;
    }
    if (r.generation !== e.generation) {
      // Superseded: the old run can no longer write. Only an authoritative cancel or timeout finishes the current row, because no
      // live run owns it; a driver return or error from the old generation changes nothing.
      if (e.cancelled || e.timedOut) await this.finish(id, e.timedOut ? "timed_out" : "cancelled");
      e.abort?.abort();
      return;
    }
    // An accepted durable result (latched by the submit under the spawn chain) is the terminal if it committed first.
    if (e.result) await this.finish(id, e.result.status, e.result.result);
    else if (e.timedOut) await this.finish(id, "timed_out");
    else if (e.cancelled) await this.finish(id, "cancelled");
    else if (e.driverError !== undefined) {
      // The bounded, redacted form (driver-error.ts), never the raw thrown value; the journal write then redacts host paths, and
      // the daemon log prints the line as journaled, so both say the same thing and neither carries a host path.
      const { cause, line } = describeDriverError(e.driverError.error, isStoreDown(e.driverError.error));
      await this.ctx.record(r, { kind: "error", message: line }, `${id}:${r.generation}:driver-error`).then(
        (entry) => {
          const shown = entry.payload.kind === "error" ? entry.payload.message : `deterministic driver failed [cause=${cause}]`;
          console.error(`pomtreed: agent ${id} generation ${r.generation}: ${shown}`);
        },
        () => {
          console.error(`pomtreed: agent ${id} generation ${r.generation}: deterministic driver failed [cause=${cause}] (error not journaled)`);
          return journalFailed(this.ctx.record, r, "driver-error")();
        },
      );
      await this.finish(id, "failed");
    } else {
      await this.ctx
        .record(r, { kind: "error", message: "deterministic driver returned without submitting a result" }, `${id}:${r.generation}:no-result`)
        .catch(journalFailed(this.ctx.record, r, "no-result"));
      await this.finish(id, "failed");
    }
    e.abort?.abort();
  }

  // The host-mediated ops a driver receives. Admission: every op is refused once the run is aborted, cancelled, superseded or latched
  // with an accepted result, and it is re-checked inside the result:<id> lock. Effects (ack, message, reap) hold that lock through
  // the store write, so a terminal settlement waits behind any admitted effect: nothing lands after the terminal, and an effect that
  // was admitted before a cancel completes before it. Lock order everywhere: spawn chain (outer) -> result:<id> (inner).
  private detOps(id: AgentId, gen: number, e: Live): DeterministicOps {
    const d = this.ctx.deps;
    const opKey = (op: string, key: string) => `det:${op}:${id}:${gen}:${key}`;
    const guard = async (): Promise<AgentRecord> => {
      const r = await d.registry.get(id);
      if (
        this.live.get(id) !== e ||
        e.abort!.signal.aborted ||
        e.result !== undefined ||
        e.suspension !== undefined ||
        !r ||
        r.state !== "running" ||
        r.generation !== gen
      )
        throw new LifecycleError(409, "deterministic run is no longer active");
      return r;
    };
    const effect = <T>(fn: (r: AgentRecord) => Promise<T>): Promise<T> => this.ctx.withLock(`result:${id}`, async () => fn(await guard()));
    return {
      peek: async () => {
        await guard();
        return d.mailbox.peek(id);
      },
      findChild: (key) =>
        effect(async () => {
          const child = await d.registry.get(agentIdFor(id, key));
          return child?.parent === id ? child : null;
        }),
      suspend: async (state, wait, key): Promise<never> => {
        await effect(async (r) => {
          if (!this.canContinue(r)) throw new LifecycleError(409, "deterministic driver has not opted into workflow continuation");
          if (!validWorkflowState(state) || !validWorkflowWait(wait)) throw new LifecycleError(400, "invalid workflow suspension");
          for (const child of waitChildIds(wait))
            if ((await d.registry.get(child))?.parent !== id) throw new LifecycleError(403, "workflow wait must name an owned child");
          // A decision can arrive after the handler's pending read but before this snapshot. It is not observed until a
          // canonical terminal getApproval, even if already queued. Observed decisions remain queued until caller ack.
          const inbox = (await d.mailbox.peek(id)).filter((s) => s.kind !== "approval_decided" || e.approvalReadSignals?.has(s.id)).map((s) => s.id);
          await this.ctx.record(r, { kind: CONTINUATION_KIND, state, wait, inbox }, opKey("suspend", key));
          e.suspension = { wait: structuredClone(wait) };
        });
        throw new Error("workflow suspended");
      },
      answerEscalation: (escalation, answer, key) =>
        effect(async () => {
          await this.ctx.hub.escalation.answerEscalationAs(id, escalation, answer, `workflow:answer:${id}:${key}`);
        }),
      passEscalation: (escalation, key) =>
        effect(async () => {
          const op = `workflow:pass:${id}:${key}`;
          if (await d.escalations.get(escalation)) await this.ctx.hub.escalation.passEscalation(escalation, id, op);
          else await this.ctx.hub.escalation.decideApproval(escalation, "pass", id, "workflow passed held approval", op, { agent: id });
        }),
      openApproval: (kind, target, key) =>
        effect(async (r) => {
          if (kind === "publish" && !/^[a-f0-9]{64}$/.test(target)) throw new LifecycleError(400, "publish approval target must be the draft sha256");
          return this.ctx.hub.escalation.openApproval(r, kind, target, `workflow:approval:${id}:${key}`);
        }),
      getApproval: (approval) =>
        effect(async () => {
          const ap = await this.ctx.hub.escalation.getApprovalFor(id, approval);
          if (ap && ap.state !== "pending") e.approvalReadSignals?.add(`${ap.id}:decision:${ap.state}`);
          return ap;
        }),
      ack: (ids, key) => effect(() => d.mailbox.ack(id, ids, opKey("ack", key))),
      message: (to, body, key) =>
        effect(async (r) => {
          const target = to.kind === "self" ? id : to.kind === "parent" ? r.parent : to.child;
          if (!target) throw new LifecycleError(409, "this run has no parent");
          if (to.kind === "child" && (await d.registry.get(to.child))?.parent !== id) throw new LifecycleError(404, `no such child: ${to.child}`);
          // A continuation segment replays in a newer generation after a crash, so its key is stable on id+key (like reap).
          await this.messaging.sendMessage(id, target, body, gen, this.canContinue(r) ? `workflow:message:${id}:${key}` : opKey("message", key));
        }),
      spawn: async (req) => {
        await guard();
        // Re-checked inside the chain, under result:<id>, right before the create (see createFenced).
        const fence = async () => void (await guard());
        if (req.executor === "deterministic") return (await this.startDeterministic(id, req, fence)).id;
        const sreq: SpawnRequest = {
          name: req.name,
          task: req.task,
          idempotencyKey: req.idempotencyKey,
          budgetMicros: req.budgetMicros,
          deadlineMs: req.deadlineMs,
          template: req.template,
          model: req.model,
          ...(req.requireAllowlist !== undefined && { requireAllowlist: req.requireAllowlist }),
        };
        return (await this.spawn(id, sreq, fence)).id;
      },
      reap: (child, key) =>
        effect(async (r) => {
          const c = await d.registry.get(child);
          if (!c || c.parent !== id) throw new LifecycleError(404, `no such child: ${child}`);
          // The same task may recover after reap but before persisting its receipt. Preserve the original reclaim receipt
          // across continuation generations; ordinary deterministic contexts retain their generation-scoped keys.
          const out = await this.reap(child, this.canContinue(r) ? `workflow:reap:${id}:${key}` : opKey("reap", key));
          // A container child's last failed tool error carries the closed cause token (a deterministic child has no tool results).
          const toolFailureCause = out.record.executor === "container" ? lastToolFailureCause(await d.journal.read({ agent: child })) : null;
          return {
            child,
            state: out.record.state,
            exit: out.record.exit,
            ...(out.record.exitCause !== undefined && { exitCause: out.record.exitCause }),
            ...(toolFailureCause !== null && { toolFailureCause }),
            result: out.record.result,
            unusedMicros: out.unusedMicros,
          };
        }),
      // Admission runs under the spawn chain (so no child is created between the children check and the latch), then the result:<id>
      // lock. The chain is released before any finish: a finish cancels and reaps children, which must not wait behind it.
      submitResult: async (handoff, key) => {
        const opk = opKey("result", key);
        if (await this.ctx.hub.ops.seen(id, "result", opk)) return;
        await this.exclusiveSpawn(() =>
          this.ctx.withLock(`result:${id}`, async () => {
            const r = await guard();
            if (await this.ctx.hub.ops.seen(id, "result", opk)) return;
            const result = this.normalizeResult("succeeded", handoff);
            await this.assertNoOpenChildren(id);
            const recorded = await this.recordResult(r, "succeeded", result, this.ctx.now(), opk);
            await this.ctx.hub.ops.mark(r, "result", opk);
            e.result = { status: "succeeded", result: recorded };
          }),
        );
        if (e.result) await this.settleDeterministic(id, e);
        e.abort!.abort(); // the run is complete: the driver's remaining ops are refused
      },
    };
  }

  // Optional trailing client key: a replay with the same key returns the first call's unusedMicros.
  // `guard` (the API route, i.e. a parent or operator reaping by hand) refuses an unmerged child; the daemon's own
  // cleanup reaps (a gone parent, the root's children) pass no guard because nobody is left to merge.
  async reap(id: AgentId, key?: string, guard = false): Promise<ReapOutcome> {
    const hit = await this.ctx.hub.ops.find(id, "reap", key);
    if (guard) await this.merger.requireMergeSettled(id);
    const out = await this.reapNow(id);
    if (hit?.unusedMicros !== undefined) return { record: out.record, unusedMicros: hit.unusedMicros };
    if (hit === null) await this.ctx.hub.ops.mark(out.record, "reap", key, { unusedMicros: out.unusedMicros });
    return out;
  }

  private async reapNow(id: AgentId): Promise<ReapOutcome> {
    const d = this.ctx.deps;
    const r = await d.registry.get(id);
    if (!r) throw new LifecycleError(404, `no such agent: ${id}`);
    let record = r;
    if (r.state !== "reaped") {
      if (r.state !== "exited") {
        if (await this.reportedResult(r)) throw new LifecycleError(409, "reported but not yet exited");
        throw new LifecycleError(409, `agent is ${r.state}, not exited`);
      }
      try {
        record = await d.registry.transition(id, r.generation, "reaped", { idempotencyKey: transitionKey(id, r.generation, "reaped") });
      } catch (e) {
        if (!(e instanceof IllegalTransitionError || e instanceof StaleGenerationError)) throw e;
        const now = await d.registry.get(id);
        if (now?.state !== "reaped") throw new LifecycleError(409, `agent is ${now?.state ?? "gone"}, not exited`);
        record = now; // another reaper won
      }
      await this.ctx.record(record, { kind: "reaped" }, `${id}:${r.generation}:reaped`);
    }
    // A deterministic child has no gateway key: its unused budget is its carve less what its own subtree consumed.
    let unusedMicros: number;
    if (record.executor === "deterministic") unusedMicros = Math.max(0, record.budgetMicros - (await this.tree.consumed(record)));
    else ({ unusedMicros } = await d.gateway.revoke(id));
    // The folder is NOT removed here: the cleanup sweep evicts reaped agents' folders (oldest first under disk pressure).
    // Reap does not merge: a parent pulls the child's ingested ref with `pomtree pull --from` and merges in its own clone.
    return { record, unusedMicros };
  }

  onKick(agent: AgentId | undefined, fn: () => void): () => void {
    if (!agent) return () => {};
    const set = this.kicks.get(agent) ?? this.kicks.set(agent, new Set()).get(agent)!;
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size && this.kicks.get(agent) === set) this.kicks.delete(agent);
    };
  }

  // Releases every long-poll `agent` is blocked in (interrupt message, cancel).
  kick(agent: AgentId): void {
    for (const fn of [...(this.kicks.get(agent) ?? [])]) fn();
  }

  // Blocks briefly until the agent has exited (or the timeout), woken by the journal's `exited` entry.
  // `waiter` is the calling agent (if any): an interrupt or cancel for it releases the poll at once.
  async waitDone(id: AgentId, timeoutMs: number, waiter?: AgentId): Promise<{ done: boolean; record: AgentRecord }> {
    const j = this.ctx.deps.journal;
    let r: AgentRecord | null = await this.ctx.deps.registry.get(id);
    if (!r) throw new LifecycleError(404, `no such agent: ${id}`);
    const startGen = r.generation;
    if (isDone(r) || timeoutMs <= 0) return { done: isDone(r), record: r };
    const sub = j.subscribe({ agent: id, from: 1 });
    const it = sub[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unkick = () => {};
    try {
      const timeout = new Promise<null>((res) => {
        timer = setTimeout(() => res(null), Math.min(timeoutMs, 30000));
        unkick = this.onKick(waiter, () => res(null));
      });
      for (;;) {
        const next = await Promise.race([it.next(), timeout]);
        if (!next || next.done) break;
        // An `exited` from an earlier generation (replayed after a resume) must not end the wait.
        if (next.value.payload.kind === "exited" && next.value.generation >= startGen) break;
      }
    } finally {
      clearTimeout(timer);
      unkick();
      sub.close();
    }
    r = (await this.ctx.deps.registry.get(id)) ?? r;
    return { done: isDone(r), record: r };
  }

  // Agent-reported typed result; `pomtree result`.
  submitResult(id: AgentId, status: "succeeded" | "failed", result: unknown, key?: string, saveUncommitted?: string): Promise<AgentRecord | "conflict" | null> {
    return this.ctx.withLock(`result:${id}`, () => this.submitResultLocked(id, status, result, key, saveUncommitted));
  }

  private async submitResultLocked(
    id: AgentId,
    status: "succeeded" | "failed",
    result: unknown,
    key?: string,
    saveUncommitted?: string,
  ): Promise<AgentRecord | "conflict" | null> {
    const r = await this.ctx.deps.registry.get(id);
    if (!r) return null;
    if (r.executor === "deterministic") throw new LifecycleError(409, "deterministic runs submit results through their driver");
    const replay = await this.ctx.hub.ops.seen(id, "result", key);
    const reported = await this.reportedResult(r);
    // A same-key retry is acknowledged only when it carries the recorded value; a different value under that key is refused (409), never
    // silently dropped, so the caller learns its second result was not recorded.
    if (replay) {
      if (reported && key !== undefined && reported.key === key) this.assertSameResult(reported, status, result, key);
      return r;
    }
    if (reported) {
      if (key === undefined || reported.key !== key) return "conflict";
      this.assertSameResult(reported, status, result, key);
      await this.notifyResult(r, reported.status, reported.result);
      await this.ctx.hub.ops.mark(r, "result", key);
      return r;
    }
    result = this.normalizeResult(status, result);
    const out = await this.submitResultNow(r, status, result, key, saveUncommitted);
    if (out !== "conflict") await this.ctx.hub.ops.mark(r, "result", key);
    return out;
  }

  // The recorded result's digest (resultDigest) against the retry's normalized value. Comparing digests, not the journaled value, keeps an
  // identical retry equal although the journal write redacts host paths. A retry that the handoff contract refuses cannot match a recorded
  // result, so it is a conflict too.
  private assertSameResult(
    reported: { status: "succeeded" | "failed"; result: unknown; digest?: string },
    status: "succeeded" | "failed",
    result: unknown,
    key: string,
  ): void {
    let digest: string | undefined;
    try {
      digest = resultDigest(status, this.normalizeResult(status, result));
    } catch {
      digest = undefined;
    }
    // A row journaled before the digest existed is compared by its recorded value.
    if (digest === (reported.digest ?? resultDigest(reported.status, reported.result))) return;
    throw new LifecycleError(
      409,
      `a different result was already reported under idempotency key ${key}; the first result stands and this run cannot report another. Resend the first result unchanged to confirm it, or stop retrying`,
      { code: "idempotency_conflict" },
    );
  }

  // The handoff contract shared by every submission (container `pomtree result` and the deterministic driver op): a succeeded
  // result needs a non-blank summary (rejected, the agent keeps running and may retry); a failed one without it is accepted with
  // a synthesized summary so a failing agent is never wedged; an oversized summary is refused (succeeded) or clipped (failed).
  private normalizeResult(status: "succeeded" | "failed", result: unknown): unknown {
    if (handoffOf(result) === null) {
      if (status === "succeeded") throw new LifecycleError(400, HANDOFF_REQUIRED);
      result = {
        ...(result !== null && typeof result === "object" && !Array.isArray(result) ? result : result === null || result === undefined ? {} : { result }),
        summary: "failed without a handoff",
        synthesized: true,
      };
    }
    const h = handoffOf(result)!;
    if (Buffer.byteLength(h.summary) > MAX_HANDOFF_BYTES) {
      if (status === "succeeded")
        throw new LifecycleError(400, `handoff summary is too long (max ${MAX_HANDOFF_BYTES} bytes); shorten it and put detail in files`);
      result = { ...h, summary: clipAgentText(h.summary, MAX_HANDOFF_BYTES) };
    }
    return result;
  }

  // A succeeded result cannot finish while the agent has unreaped children (409 with their ids).
  private async assertNoOpenChildren(id: AgentId): Promise<void> {
    const open = unreaped(await this.ctx.deps.registry.list({ parent: id }));
    if (open.length) {
      const ids = open.map((c) => c.id);
      throw new LifecycleError(409, `unreaped children: ${ids.join(", ")}`, { children: ids });
    }
  }

  // The one durable writer of a submitted result (journal `ext.pomtreed.result`, before any acknowledgement or notify). Returns the
  // journal's normalized result, which both the live and the recovered exit use.
  private async recordResult(r: AgentRecord, status: "succeeded" | "failed", result: unknown, wrapupDeadlineAt: number, key?: string): Promise<unknown> {
    const recorded = await this.ctx.record(
      r,
      { kind: POMTREED_KINDS.result, status, result, wrapupDeadlineAt, digest: resultDigest(status, result), ...(key !== undefined && { key }) },
      `${r.id}:${r.generation}:result`,
    );
    return (recorded.payload as { result?: unknown }).result;
  }

  private async submitResultNow(
    r: AgentRecord,
    status: "succeeded" | "failed",
    result: unknown,
    key?: string,
    saveUncommitted?: string,
  ): Promise<AgentRecord | "conflict" | null> {
    const id = r.id;
    if (r.state !== "running") return "conflict";
    if (status === "succeeded") await this.assertNoOpenChildren(id);
    const e = this.live.get(id);
    if (e?.result || (await this.reportedResult(r))) return "conflict";
    if (e?.sandbox) {
      // push.maxBytes caps the result-save bundle the adapter collects as well as the local collection below.
      const pushMaxBytes = this.ctx.deps.pushMaxBytes ?? CONFIG_DEFAULTS["push.maxBytes"];
      const work = await this.ctx.deps.sandbox.resultWork(e.sandbox.id, { maxBytes: pushMaxBytes }).catch(() => {
        throw new LifecycleError(409, "result not recorded: sandbox workspace inspection failed; check the sandbox and retry");
      });
      const warn = (fingerprint: string, dirty = true): never => {
        throw new LifecycleError(409, uncommittedWorkMessage(fingerprint, dirty), { code: "uncommitted_work", uncommitted: dirty, fingerprint });
      };
      if ((work.dirty || saveUncommitted !== undefined) && saveUncommitted !== work.fingerprint) warn(work.fingerprint, work.dirty);
      if (saveUncommitted !== undefined) {
        await this.ctx.record(
          r,
          { kind: POMTREED_KINDS.resultSaveApproved, fingerprint: saveUncommitted },
          `${id}:${r.generation}:result-save:${saveUncommitted}`,
        );
        const saved = await this.ctx.deps.sandbox
          .resultWork(e.sandbox.id, { save: true, expectedFingerprint: work.fingerprint, maxBytes: pushMaxBytes })
          .catch(() => {
            throw new LifecycleError(409, "result not recorded: approved workspace save failed; commit and pomtree push manually, or retry the approved save");
          });
        if (!saved.bundle) warn(saved.fingerprint, saved.dirty);
        const iterator = saved.bundle![Symbol.asyncIterator]();
        try {
          const collected = await this.ctx.hub.host
            .push(id, r.generation, `result-save:${saveUncommitted}:${saved.fingerprint}`, { [Symbol.asyncIterator]: () => iterator }, pushMaxBytes)
            .catch(() => {
              throw new LifecycleError(409, "result not recorded: local collection failed; retry the approved save");
            });
          if (!collected.ok) throw new LifecycleError(409, `result not recorded: local collection failed (${collected.code}): ${collected.message}`);
        } finally {
          await iterator.return?.().catch(() => {});
        }
      }
    } else if (saveUncommitted !== undefined || (await this.ctx.deps.workspace.has(id))) {
      throw new LifecycleError(409, "result not recorded: no live sandbox available to inspect or save uncommitted work");
    }
    // Persist before acknowledging or notifying the parent; recovery can finish a reported generation.
    const wrapupDeadlineAt = this.ctx.now() + (r.executor === "container" ? (r.spec.wrapupMs ?? 30_000) : 30_000);
    // Use the journal's normalized value in both live and recovered exits.
    result = await this.recordResult(r, status, result, wrapupDeadlineAt, key);
    if (e) {
      e.result = { status, result };
      this.armResultWindow(e, wrapupDeadlineAt);
    }
    await this.notifyResult(r, status, result);
    if (!e) {
      const out = await this.finish(id, status, result);
      return out.changed ? out.record : "conflict";
    }
    return r;
  }

  async reportedResult(
    r: AgentRecord,
  ): Promise<{ status: "succeeded" | "failed"; result: unknown; wrapupDeadlineAt: number; key?: string; digest?: string } | undefined> {
    for (let from = 1; ; ) {
      const rows = await this.ctx.deps.journal.read({ agent: r.id, from, limit: 500 });
      const row = rows.find((e) => e.generation === r.generation && e.payload.kind === POMTREED_KINDS.result);
      if (row) return row.payload as unknown as { status: "succeeded" | "failed"; result: unknown; wrapupDeadlineAt: number; key?: string; digest?: string };
      const last = rows.at(-1);
      if (!last || rows.length < 500) return undefined;
      from = last.seq + 1;
    }
  }

  private armResultWindow(e: Live, deadlineAt: number): void {
    e.resultDeadlineAt = deadlineAt;
    clearTimeout(e.resultTimer);
    const remaining = deadlineAt - this.ctx.now();
    e.resultTimer = setTimeout(
      () => {
        if (deadlineAt > this.ctx.now()) return this.armResultWindow(e, deadlineAt);
        // Stopping the session ends the event stream; settle then stops the sandbox before completion.
        void e.session?.stop().catch(() => {});
        if (e.sandbox)
          void this.ctx.deps.sandbox
            .stop(e.sandbox.id, this.ctx.deps.graceMs)
            .catch(() => this.ctx.deps.sandbox.kill(e.sandbox!.id))
            .catch(() => {});
      },
      Math.min(MAX_TIMER_MS, Math.max(0, remaining)),
    );
    e.resultTimer.unref?.();
  }

  async notifyResult(child: AgentRecord, status: "succeeded" | "failed", result: unknown): Promise<void> {
    const generationKey = String(child.generation);
    if (await this.ctx.hub.ops.seen(child.id, "child_result", generationKey)) return;
    const owner = child.parent ? await this.ctx.deps.registry.get(child.parent) : null;
    if (!owner || owner.state === "reaped") return;
    const signal: Signal = { kind: "child_result", child: child.id, status, handoff: clipAgentText(handoffOf(result)!.summary, SIGNAL_HANDOFF_CHARS) };
    const key = `${child.id}:${child.generation}:child_result`;
    if (await this.messaging.toMailbox(child, owner.id, signal, key)) {
      await this.ctx.record(owner, { kind: "signal", signal }, `${key}:journal`);
      await this.ctx.deps.orchestrator.wake(owner.id, signal).catch(() => {});
    }
    await this.ctx.hub.ops.mark(child, "child_result", generationKey);
  }

  async cancel(id: AgentId, graceMs = this.ctx.deps.graceMs, key?: string) {
    const r = await this.ctx.deps.registry.get(id);
    if (await this.ctx.hub.ops.seen(id, "cancel", key)) return;
    await this.ctx.deps.orchestrator.cancel(id, graceMs);
    await this.ctx.hub.ops.mark(r, "cancel", key);
  }

  async kill(id: AgentId, key?: string) {
    const r0 = await this.ctx.deps.registry.get(id);
    if (await this.ctx.hub.ops.seen(id, "kill", key)) return;
    await this.killNow(id);
    await this.ctx.hub.ops.mark(r0, "kill", key);
  }

  private async killNow(id: AgentId) {
    const e = this.live.get(id);
    if (e?.deterministic) return this.stopDeterministic(id, e);
    if (!e && (await this.stopDetNoLive(id))) return;
    if (!e || e.admitting) {
      const r = await this.ctx.deps.registry.get(id);
      if (r && r.executor === "container") await this.reconciler.reclaimSandbox(r, true);
      await this.finish(id, "cancelled");
      return;
    }
    e.cancelled = true;
    if (e.sandbox) {
      await this.ctx.deps.sandbox.kill(e.sandbox.id);
      await e.session?.stop().catch(() => {});
    }
    // No sandbox yet: drive() observes e.cancelled and lets settle finish, instead of finishing here and
    // leaving drive to start a container for an agent the registry already shows as exited.
  }

  // Admission priority for a resumed agent: timer (scheduled/cron) waits are lower urgency than signal
  // wakes, and leaf agents (no unreaped children) resume before parents so a parent that will immediately
  // yield on its children does not hold a slot.
  private async resumePriority(agent: AgentId, cp: Checkpoint): Promise<number> {
    const base = cp.wait !== null && nextDeadline(cp.wait) !== null ? PRIORITY.scheduled : PRIORITY.interactive;
    const kids = unreaped(await this.ctx.deps.registry.list({ parent: agent }));
    return kids.length === 0 ? base : base + 1;
  }

  // Try-acquire the agent's claim; null when another actor holds it. Never blocks.
  tryClaim(id: AgentId, purpose: string): { purpose: string; preempted: boolean } | null {
    if (this.claims.has(id)) return null;
    const claim = { purpose, preempted: false };
    this.claims.set(id, claim);
    return claim;
  }

  // Release in a `finally`. A pass that skipped this agent while the claim was held is re-run now, not at the next timer.
  releaseClaim(id: AgentId, claim: { purpose: string; preempted: boolean }): void {
    if (this.claims.get(id) !== claim) return;
    this.claims.delete(id);
    if (this.dirty.delete(id) && !this.ctx.hub.store.draining()) void this.reconciler.reconcile().catch(() => {});
  }

  // Re-adopt a checkpoint-less running container after a daemon restart:
  // attach by sandbox id, stream its output into the journal, and finish from its exit — instead
  // of failing a still-live agent and cancelling its children. Fire-and-forget (like drive()): the
  // pump runs in the background while reconcile() returns.
  adoptRunning(
    id: AgentId,
    sandboxId: string,
    gen: number,
    reported?: { status: "succeeded" | "failed"; result: unknown; wrapupDeadlineAt: number },
  ): Promise<void> {
    // Reserved synchronously, before the registry read: an overlapping reconcile pass sees a live run and skips it.
    const reserved: Live = { cancelled: false };
    this.live.set(id, reserved);
    const release = () => {
      if (this.live.get(id) === reserved) this.live.delete(id);
    };
    return this.ctx.deps.registry.get(id).then(
      (rec) => {
        // A deterministic run has no sandbox to adopt: refuse, and free the reservation.
        if (rec?.executor === "deterministic") {
          release();
          throw new LifecycleError(409, `agent ${id} is deterministic; it has no sandbox to adopt`);
        }
        return this.adoptContainer(id, sandboxId, gen, reported, reserved);
      },
      (e) => {
        release();
        throw e;
      },
    );
  }

  // `entry` is the reservation adoptRunning installed before its registry read: it is reused, never replaced, so a stop or deadline
  // that landed during that read (cancelled, killTimer, timedOut) still governs this run.
  private adoptContainer(
    id: AgentId,
    sandboxId: string,
    gen: number,
    reported: { status: "succeeded" | "failed"; result: unknown; wrapupDeadlineAt: number } | undefined,
    entry: Live,
  ): Promise<void> {
    const d = this.ctx.deps;
    const adoptDeadline = this.budget.deadlines.get(id);
    if (adoptDeadline !== undefined) this.armDeadline(entry, adoptDeadline);
    // A result recorded after adoption lives on `entry`; the adopt-time `reported` is the fallback before it is installed there.
    const recorded = () => entry.result ?? reported;
    return (async () => {
      try {
        let handle: SandboxHandle;
        try {
          handle = await d.sandbox.attach(sandboxId, id);
        } catch (e) {
          if (e instanceof SandboxUnavailableError) {
            const a = await this.ctx.deps.registry.get(id);
            if (a && a.generation === gen) {
              await this.ctx
                .record(a, { kind: "error", message: "daemon restarted while running; container is gone (no checkpoint to resume)" }, `${id}:${gen}:restart`)
                .catch(journalFailed(this.ctx.record, a, "restart"));
              if (await this.teardownExit(id, gen, entry)) await this.finish(id, recorded()?.status ?? "failed", recorded()?.result);
            }
            return;
          }
          throw e;
        }
        entry.sandbox = handle;
        // A cancel or deadline that landed before the sandbox was attached: its kill timer may have fired with no sandbox to kill, so
        // re-arm it unconditionally now. A deadline sets cancelled too. The timer reads entry.sandbox when it fires.
        if (entry.cancelled) this.armKill(entry, d.graceMs);
        if (reported) {
          entry.result = reported;
          this.armResultWindow(entry, reported.wrapupDeadlineAt);
        }
        let i = 0;
        for await (const c of handle.output()) {
          const r = await this.ctx.deps.registry.get(id);
          if (r && r.generation === gen)
            await this.ctx
              .record(r, { kind: "message", role: "assistant", text: c.chunk }, `${id}:${gen}:adopt:${this.messaging.bootNonce}:ev:${i++}`)
              .catch(journalFailed(this.ctx.record, r, "adopt-ev"));
        }
        const w = await handle.wait();
        // A yield (budget escalation of an adopted agent) stopped this container on purpose: settle it as a yield, not an exit.
        if (entry.yielding) {
          await this.settleYield(id, entry, gen);
          return;
        }
        const a = await this.ctx.deps.registry.get(id);
        if (!a || a.generation !== gen) return; // a newer run owns this agent
        // `entry.result`, not the adopt-time `reported`: an adopted container may record its result after adoption (submitResultNow
        // sets it on this live entry). Regression: such a result was dropped, and the run ended `failed` with "no handoff was written".
        const exit = classifySandboxExit({ ...w, hasResult: entry.result !== undefined, cancelled: entry.cancelled, timedOut: entry.timedOut });
        await this.journalSandbox(a, gen, "exited", sandboxId, { ...exitedDetail(w, exit.expected), ...(exit.cause && { cause: exit.cause }) });
        if (entry.result) {
          await this.settle(id, entry, false, gen);
          return;
        }
        if (entry.cancelled) {
          await d.registry.setSandbox(id, gen, null, `${id}:${gen}:adopt-clear`).catch(() => {});
          if (await this.teardownExit(id, gen, entry)) await this.finish(id, entry.timedOut ? "timed_out" : "cancelled");
          return;
        }
        let cause: ExitCause | undefined = exit.cause;
        // A checkpoint-less adopted container cannot report a typed result: exit 0 is success,
        // anything else is failed (the old daemon's `pomtree result` call went to a stale endpoint).
        await d.registry.setSandbox(id, gen, null, `${id}:${gen}:adopt-clear`).catch(() => {});
        // The agent's work lives in its own folder; this path commits nothing there (the cleanup sweep removes reaped folders later).
        // Torn down once: the host-fault branch drops the live entry before its restart attempt, so a second teardown would read
        // as superseded. A restart that superseded it returns true (handled); otherwise nothing newer took the agent.
        let tornDown = false;
        if (cause === "host_stopped" || cause === "oom_killed") {
          if (!(await this.teardownExit(id, gen, entry))) return;
          tornDown = true;
          if (this.live.get(id) === entry) this.live.delete(id);
          const auto = await this.tryAutoRestart(id, gen, cause);
          if (auto === true) return;
          if (auto === "exhausted") cause = "restart_exhausted";
        }
        if (!tornDown && !(await this.teardownExit(id, gen, entry))) return;
        await this.finish(id, w.exitCode === 0 ? "succeeded" : "failed", undefined, cause);
      } catch (e) {
        if (e instanceof SandboxUnavailableError) {
          const a = await this.ctx.deps.registry.get(id).catch(() => null);
          if (a)
            await this.ctx
              .record(a, { kind: "error", message: "adopted container stopped unexpectedly" }, `${id}:${gen}:adopt-error`)
              .catch(journalFailed(this.ctx.record, a, "adopt-error"));
          if (await this.teardownExit(id, gen, entry)) await this.finish(id, recorded()?.status ?? "failed", recorded()?.result).catch(() => {});
        } else {
          // One re-adoption is allowed (the next tick); a second failure fails the agent instead of looping forever.
          const n = (this.adoptFailures.get(id) ?? 0) + 1;
          this.adoptFailures.set(id, n);
          const a = await this.ctx.deps.registry.get(id).catch(() => null);
          if (a)
            await this.ctx
              .record(a, { kind: "error", message: `adoption failed (${n}): ${String(e instanceof Error ? e.message : e)}` }, `${id}:${gen}:adopt-error:${n}`)
              .catch(journalFailed(this.ctx.record, a, "adopt-error"));
          if (n >= 2 && (await this.teardownExit(id, gen, entry))) await this.finish(id, recorded()?.status ?? "failed", recorded()?.result).catch(() => {});
        }
      } finally {
        clearTimeout(entry.killTimer);
        clearTimeout(entry.resultTimer);
        if (this.live.get(id) === entry) this.live.delete(id);
      }
    })();
  }

  private ownerLabels(): Record<string, string> {
    return { daemon_epoch: this.epoch, ...(this.ctx.deps.storeId !== undefined && { store_id: this.ctx.deps.storeId }) };
  }

  // An agent credential issued for a given generation and a bounded expiry. The generation argument is
  // the caller's current fence value (the record's generation at issue time); it defaults to 0 for callers
  // that only need a structurally valid token (tests probing a missing or foreign agent).
  agentToken(id: AgentId, generation = 0): string {
    const expiry = this.ctx.now() + (this.ctx.deps.agentTokenTtlMs ?? AGENT_TOKEN_TTL_MS);
    return issueToken(this.ctx.deps.secret, { scope: "agent", agent: id, generation, expiry });
  }

  // `source` names the event that produced the signal (e.g. `${agent}:${generation}:cancel:${graceMs}`), so a replay of that
  // event after a restart derives the same key and the mailbox dedupes it; a new event carries a new source.
  async deliver(agent: AgentId, signal: Signal, source: string) {
    await this.ctx.deps.mailbox.send(agent, signal, `${agent}:deliver:${source}`);
  }

  // Driver.isYielded: durable orchestrators re-arm a wait only while the agent
  // remains yielded (a non-satisfying wake leaves it parked).
  async isYielded(agent: AgentId): Promise<boolean> {
    return (await this.ctx.deps.registry.get(agent))?.state === "yielded";
  }

  // Finishes a row that has no live entry. A deterministic row is finished under `result:<id>` and re-checks `live` inside the
  // lock, so a drive that registers concurrently is stopped through its run loop instead of racing this finish.
  private async stopDetNoLive(id: AgentId): Promise<boolean> {
    const r = await this.ctx.deps.registry.get(id);
    if (!r || r.executor !== "deterministic") return false;
    let late: Live | undefined;
    await this.ctx.withLock(`result:${id}`, async () => {
      late = this.live.get(id);
      if (!late?.deterministic) await this.finish(id, "cancelled");
    });
    if (late?.deterministic) await this.stopDeterministic(id, late);
    return true;
  }

  async stop(id: AgentId, graceMs: number) {
    const e = this.live.get(id);
    if (e?.deterministic) return this.stopDeterministic(id, e);
    if (!e && (await this.stopDetNoLive(id))) return;
    if (!e || e.admitting) {
      await this.finish(id, "cancelled");
      return;
    }
    e.cancelled = true;
    this.kick(id); // release a blocked wait/inbox/ask long-poll now, not at its cap
    const signal: Signal = { kind: "cancel", graceMs };
    const r = await this.ctx.deps.registry.get(id);
    await this.deliver(id, signal, `${r?.generation ?? 0}:cancel:${graceMs}`);
    if (r) await this.ctx.record(r, { kind: "signal", signal }, `${id}:${r.generation}:cancel`);
    this.armKill(e, graceMs);
    await e.session?.stop().catch(() => {});
  }

  private armKill(e: Live, graceMs: number) {
    clearTimeout(e.killTimer);
    e.killTimer = setTimeout(() => {
      if (e.sandbox) this.ctx.deps.sandbox.kill(e.sandbox.id).catch(() => {});
    }, graceMs);
    e.killTimer.unref?.();
  }

  // Hard wall-clock cap (SpawnRequest.deadlineMs): at `deadlineAt`, mark the run timed-out,
  // kill its sandbox and stop the harness so settle finishes it as `timed_out`. Chunked like
  // the orchestrator's timer waits so a >24.8-day deadline does not overflow setTimeout.
  armDeadline(e: Live, deadlineAt: number) {
    const ms = Math.max(0, deadlineAt - this.ctx.now());
    clearTimeout(e.killTimer);
    e.killTimer = setTimeout(
      () => {
        if (this.ctx.now() < deadlineAt) {
          this.armDeadline(e, deadlineAt);
          return;
        }
        e.timedOut = true;
        e.cancelled = true; // reuse the cancel early-exits so a deadline that lands mid-start still settles
        if (e.deterministic) return e.abort?.abort(); // the run loop settles it as timed_out
        if (e.sandbox) this.ctx.deps.sandbox.kill(e.sandbox.id).catch(() => {});
        void e.session?.stop().catch(() => {});
      },
      Math.min(ms, MAX_TIMER_MS),
    );
    e.killTimer.unref?.();
  }

  async drive(id: AgentId, gen: number) {
    const d = this.ctx.deps;
    // A failed read is not "no record": it must not fall through to container admission. Fail closed on a store error.
    const first = await d.registry.get(id).catch((e: unknown) => {
      if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
      throw e;
    });
    if (first?.executor === "deterministic") return this.driveDeterministic(id, gen);
    const pre = this.live.get(id)?.admitting ? this.live.get(id) : undefined; // a restartFresh placeholder
    if (!(await this.ctx.hub.host.admit(id))) {
      if (pre && this.live.get(id) === pre) this.live.delete(id);
      return;
    }
    const entry: Live = { cancelled: false };
    this.live.set(id, entry);
    const deadlineAt = this.budget.deadlines.get(id);
    if (deadlineAt !== undefined) this.armDeadline(entry, deadlineAt);
    try {
      // A restartFresh agent is already running (new generation); a normal start moves pending -> running.
      const cur = await this.ctx.deps.registry.get(id);
      const running =
        cur?.state === "running" && cur.generation === gen
          ? cur
          : await d.registry.transition(id, gen, "running", { idempotencyKey: transitionKey(id, gen, "running") });
      await this.ctx.record(running, { kind: "started" }, `${id}:${gen}:started`);
      const fork = await this.merger.forkSource(id);
      let ws: { workspace: WorkspaceId; commit: string };
      if (await d.workspace.has(id))
        ws = await d.workspace.create(id, {}); // a restarted start re-mounts its folder
      else if (fork?.fromAgent !== undefined) {
        // `spawn --fork`: the child's folder is a sanitised byte copy of the STOPPED parent's (untracked files included).
        const parent = await this.ctx.deps.registry.get(fork.fromAgent);
        if (!parent || parent.state === "running" || parent.state === "pending")
          throw new Error(`fork source ${fork.fromAgent} is ${parent?.state ?? "gone"}; it must be yielded or exited to be forked`);
        ws = await d.workspace.fork(fork.fromAgent, id);
      } else ws = await d.workspace.create(id, fork?.commit !== undefined ? { fromCommit: fork.commit } : {});
      let forkSession: Uint8Array | null = null;
      if (fork?.sessionRef !== undefined) {
        forkSession = await d.sessions.get(fork.sessionRef);
        if (!forkSession) throw new Error(`fork session ${fork.sessionRef} is gone`);
        const verdict = verifySession(forkSession, fork.sessionRef);
        if (!verdict.ok) throw new Error(`fork session ${fork.sessionRef} failed integrity check (${verdict.reason})`);
        await this.writeSessionFile(id, forkSession);
      }
      // A fork with a session continues that conversation: the harness resumes it with the task as the wake text.
      if (running.executor !== "container") throw new Error(`agent ${id} is not a container`);
      await this.runSegment(id, entry, running, gen, {
        workspace: ws.workspace,
        baseCommit: ws.commit,
        budgetMicros: running.budgetMicros,
        image: running.spec.image,
        ...(forkSession
          ? { kind: "resume" as const, prompt: running.task, sessionRef: fork!.sessionRef!, wake: running.task }
          : { kind: "start" as const, prompt: running.task, sessionRef: "", wake: "" }),
      });
    } catch (e) {
      if (e instanceof SandboxUnavailableError) await this.ctx.hub.store.markSandboxDown();
      else if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
      const r = await this.ctx.deps.registry.get(id).catch(() => null);
      if (r)
        await this.ctx
          .record(r, { kind: "error", message: String(e instanceof Error ? e.message : e) }, `${id}:${gen}:drive-error`)
          .catch(journalFailed(this.ctx.record, r, "drive-error"));
      await this.settle(id, entry, false, gen);
    }
  }

  // The sandbox start + harness start/resume + event pump, shared by the fresh (drive) and resume
  // paths. Settles the live entry (exit or yield) at the end.
  private async runSegment(
    id: AgentId,
    entry: Live,
    rec: AgentRecord,
    gen: number,
    prep: {
      workspace: WorkspaceId;
      baseCommit: string;
      budgetMicros: number;
      image: string;
      kind: "start" | "resume";
      prompt: string;
      sessionRef: string;
      wake: string;
    },
  ): Promise<void> {
    const d = this.ctx.deps;
    let overBudget = false;
    entry.settled = false;
    entry.workspace = prep.workspace;
    try {
      // Re-check new workflow/public authority on actual start/resume, not input-provided authorization identifiers.
      // Classic container descendants keep their existing non-public admission/resume semantics: named templates were
      // checked at spawn, and an untemplated code/registry child never needed a workflow-driver grant.
      if (d.mayUseTemplate && rec.parent !== null) {
        const parent = await d.registry.get(rec.parent);
        if (parent?.executor === "deterministic" || containerSpec(rec).egress.kind === "audited-public") {
          const template = await this.tree.resolveTemplate(containerSpec(rec).template ?? CODE_TEMPLATE_ID);
          if (!template || !(await d.mayUseTemplate(rec.parent, template)))
            throw new LifecycleError(403, "worker template is no longer permitted for this caller");
        }
      }
      if (containerSpec(rec).egress.kind === "audited-public" && d.publicEgressReady && !d.publicEgressReady())
        throw new LifecycleError(503, "public egress audit collector is unavailable");
      // The launch backstop of the analyst/specialist rule: the persisted spec carries the allowlist, extensions and egress the harness argv
      // and the sandbox egress are built from, so a spec that breaks the rule (however it was produced) never starts or resumes.
      const specProblem = allowlistTemplateProblem(containerSpec(rec));
      if (specProblem !== undefined)
        throw new LifecycleError(422, `refusing to start ${id}: template ${containerSpec(rec).template ?? CODE_TEMPLATE_ID}: ${specProblem}`, {
          code: "template_error",
        });
      const model = await d.gateway.issueKey(id, prep.budgetMicros);
      const deadlineAt = this.budget.deadlines.get(id);
      const cred = d.credentials?.stage(id, model);
      const apiUrl = d.agentApiUrl?.();
      // TODO(env): only the base manifest is mounted (empty when absent), no parent layer; per-spawn additions and manifest-hash
      // inheritance need a manifest-hash field on core's AgentRecord/Checkpoint. Layers are `<cacheRoot>/<hash>`, created by the caller.
      const envMounts = d.env ? mountPlan(d.env.manifest ?? emptyManifest(), { cacheRoot: d.env.cacheRoot }) : [];
      const resources = specResources(containerSpec(rec), d.containerMemoryBytes);
      const containerConfig = d.containerConfig ?? DEFAULT_CONTAINER_CONFIG;
      // Policy resolution stays in the controller: the Docker adapter only realizes this explicit,
      // default-deny list. It must not reconstruct policy from a template or environment itself. An analyst or specialist is relay-only
      // (core allowlistTemplateProblem): its registry egress is built from the empty manifest, so the host's base env manifest never
      // opens package-registry hosts to it.
      const relayOnly = containerSpec(rec).allowlist === "analyst" || containerSpec(rec).allowlist === "specialist";
      const egress = egressPolicy({
        policy: containerSpec(rec).egress,
        host: rec.host,
        generation: rec.generation,
        manifest: relayOnly ? emptyManifest() : (d.env?.manifest ?? emptyManifest()),
        agentApiUrl: apiUrl,
        modelBaseUrl: model.baseUrl,
      });
      for (const m of envMounts) if (m.kind === "bind") mkdirSync(m.hostPath, { recursive: true });
      mkdirSync(this.sessionHostDir(id), { recursive: true });
      if (apiUrl && d.agentEndpointProbe) {
        entry.endpointUnreachable = !(await d.agentEndpointProbe().catch(() => false));
        if (entry.endpointUnreachable) {
          // The agent will start but cannot call pomtree; name the cause and fix now rather than ending as a mute failure.
          const st = await d.agentEndpointStatus?.().catch(() => undefined);
          const message = st?.message ?? `agent endpoint unreachable (POMTREE_API=${apiUrl})`;
          console.error(`pomtreed: ${message}`);
          await this.ctx
            .record(rec, { kind: "error", message }, `${id}:${gen}:endpoint-preflight`)
            .catch(journalFailed(this.ctx.record, rec, "endpoint-preflight"));
        }
      }
      // A stale sink file from an earlier run would replay its `agent_settled`; the tail starts at offset 0.
      if (d.terminal) rmSync(join(this.sessionHostDir(id), d.terminal.sinkFile), { force: true });
      const sandboxSpec: SandboxSpec = {
        agent: id,
        ...(d.terminal && { tty: d.terminal.size }),
        labels: this.ownerLabels(),
        image: prep.image,
        // The workspace mount is the working directory. The daemon names the folder by id; the node's MountProvider resolves it.
        mounts: [
          { kind: "workspace", workspace: prep.workspace, containerPath: WORKSPACE_MOUNT_DIR, generation: gen },
          ...(apiUrl ? [] : [{ kind: "bind" as const, hostPath: d.socketHostPath, containerPath: d.sandboxSocketPath }]),
          ...(cred ?? []),
          ...envMounts,
          this.sessionMount(id, gen),
        ],
        ...(resources !== undefined && { resources }),
        ...(containerSpec(rec).runtime !== undefined && { runtime: containerSpec(rec).runtime }),
        // The agent's persisted spec provider/model (per-spawn pick, template, or inherited) reach the harness here.
        // The sandbox command is the prompt for a fresh start and the wake text for a resume
        // (Pi's `--session` appends the prompt to the restored conversation as the wake message).
        cmd: d.command?.(prep.kind === "start" ? prep.prompt : prep.wake, {
          ...(containerSpec(rec).provider !== undefined && { provider: containerSpec(rec).provider }),
          ...(containerSpec(rec).model !== undefined && { model: containerSpec(rec).model }),
          ...(containerSpec(rec).allowlist !== undefined && { allowlist: containerSpec(rec).allowlist }),
          ...(containerSpec(rec).browser !== undefined && { browser: containerSpec(rec).browser }),
          ...(typeof containerSpec(rec).systemPrompt === "string" && { systemPrompt: containerSpec(rec).systemPrompt as string }),
        }),
        egress,
        env: {
          ...gitIdentityEnv(id),
          POMTREE_BASE_COMMIT: prep.baseCommit,
          ...withoutControllerEnv(d.terminal?.env),
          ...browserEnv(containerSpec(rec), d.fetchUserAgent),
          // The resolved container subset as one validated document (core config/container.ts), after the caller's env so it
          // cannot be replaced. Every container gets it: it carries no secret, and wait.yieldMs is in it for the in-container pomtree.
          ...containerConfigEnv(CONFIG_REGISTRY, containerConfig),
          POMTREE_AGENT_ID: id,
          POMTREE_AGENT_GENERATION: String(rec.generation),
          POMTREE_TOKEN: this.agentToken(id, rec.generation),
          ...(apiUrl ? { POMTREE_API: apiUrl } : { POMTREE_SOCKET: d.sandboxSocketPath }),
          // The model key and proxy URL reach Pi only through the staged credentials (auth.json and models.json), never env.
          // The wall-clock deadline (ISO) lets the pomtree-jobs extension cap a job's timeout at the agent's remaining time.
          ...(deadlineAt !== undefined && { POMTREE_AGENT_DEADLINE_AT: new Date(deadlineAt).toISOString() }),
        },
      };
      entry.sandbox = await d.sandbox.start(sandboxSpec, `${id}:${gen}:start`);
      await d.registry.setSandbox(id, gen, entry.sandbox.id, `${id}:${gen}:sandbox-set`);
      await this.journalSandbox(rec, gen, "started", entry.sandbox.id, {
        spec: describeSandboxSpec(sandboxSpec),
        realized: describeRunHardening(defaultDenyEgress(sandboxSpec)),
        // The bounds this worker was given (policy numbers only; no secret can be a delivered key).
        containerConfig: { contract: containerContract(CONFIG_REGISTRY), values: containerConfig },
      });
      if (entry.cancelled) return void (await this.settle(id, entry, false, gen));
      entry.session =
        prep.kind === "start"
          ? await d.harness.start({ agent: id, sandbox: entry.sandbox, prompt: prep.prompt })
          : await d.harness.resume({ agent: id, sandbox: entry.sandbox, sessionRef: prep.sessionRef, wake: prep.wake });
      if (entry.cancelled) await entry.session.stop();
      if (entry.interrupt) this.armInterrupt(id); // an interrupt armed before the session existed: start its backstop now
      if (entry.resultDeadlineAt !== undefined) this.armResultWindow(entry, entry.resultDeadlineAt);
      let i = 0;
      let harnessSettled = true;
      const session = entry.session;
      // Budget reached: a reported result settles as is (nothing more to spend); otherwise park behind a budget approval.
      // Only the fail-closed fallback (no approvals, or the park failed before its checkpoint) ends the run over_budget.
      const budgetStop = async (): Promise<"stop" | undefined> => {
        if (entry.result) return "stop";
        if (entry.yielding || entry.cancelled || entry.timedOut) return;
        if (!(await this.budget.escalateBudget(id, entry))) {
          overBudget = true;
          await session.stop();
        }
        return "stop";
      };
      // Events are drained into a queue as fast as the harness yields them and journaled
      // by the handler, so a slow journal append cannot back-pressure the stream and drop `agent_settled`.
      await pumpBuffered(session.events(), async (ev) => {
        if (ev.kind === "settled") {
          // The turn ended but the process lives on (interactive TTY). No-passive-settle rule (TODO(no-passive-settle)): a settle is
          // legitimate only when declared: (a) `pomtree result`, (b) `pomtree yield`, (c) `pomtree await-user` (accepted only after an
          // interactive message), or (d) the user aborted the turn (`aborted`, from the events extension). Cases, in order:
          //  - result recorded, or an operator interrupt pending (resumes through settle()): the run is over ("stop").
          //  - yield in flight or cancel in progress: the yield/cancel path ends the segment; nothing to do here.
          //  - user abort, or an accepted await-user pending (`declared`): `waiting` (the WAITING_KIND marker; the watchdog stall ladder
          //    exempts it, idle time = now - its ts). Resets the passive count. A human message alone does NOT make a settle waiting.
          //  - otherwise PASSIVE: nudge through the steer path (mailbox extension) and keep running; the MAX_PASSIVE_SETTLES-th
          //    consecutive passive settle (no tool call or inbound message between) fails the run (cause passive_settle). A live
          //    background job is NOT recognised (the daemon cannot see jobs): the agent is expected to job_wait or yield, and
          //    those tool calls count as activity. TODO(jobs-settle).
          // TODO(idle): no idle timeout; a waiting run lasts until a result, container exit, budget stop, operator stop, or a spawn deadline.
          if (entry.result || entry.interrupt) return "stop";
          if (entry.yielding || entry.cancelled) return;
          let st = initialSettle;
          for (const e of await d.journal.read({ agent: id })) st = settleStep(st, e);
          // `aborted` comes from a file the agent can write; it counts only with a daemon-journaled viewer Esc just before the settle.
          if (isUserAbort(st, ev.aborted, this.ctx.now()) || st.declared) {
            await this.ctx.record(rec, { kind: WAITING_KIND }, `${id}:${gen}:waiting:${i++}`);
            return;
          }
          const count = st.passive + 1;
          await this.ctx.record(rec, { kind: PASSIVE_SETTLE_KIND, count, max: MAX_PASSIVE_SETTLES } as never, `${id}:${gen}:passive-settle:${i++}`);
          if (count >= MAX_PASSIVE_SETTLES) {
            const message = `agent ended ${count} consecutive turns with no result, yield or activity (passive settle cap ${MAX_PASSIVE_SETTLES}); failing the run`;
            await this.ctx
              .record(rec, { kind: "error", message }, `${id}:${gen}:passive-settle-fail`)
              .catch(journalFailed(this.ctx.record, rec, "passive-settle-fail"));
            entry.cause = "passive_settle";
            entry.result = { status: "failed", result: undefined };
            await session.stop();
            return "stop";
          }
          const body = `Your turn ended but you have not finished: no result, yield or await-user declared. This is passive settle ${count} of ${MAX_PASSIVE_SETTLES} (the run fails at ${MAX_PASSIVE_SETTLES}). Valid exits: keep working on your task; report with \`pomtree result --summary ...\`; park with \`pomtree yield\`; or, only if a human just messaged you and you expect their reply, \`pomtree await-user\`. Do not just reply with text.`;
          await this.deliver(id, { kind: "nudge", body, attempt: count, max: MAX_PASSIVE_SETTLES }, `${gen}:passive-nudge:${i - 1}`);
          return;
        }
        await this.ctx.record(rec, ev.kind === "usage" ? await this.budget.meterUsage(rec, ev) : ev, `${id}:${gen}:ev:${i++}`);
        if (ev.kind === "error") harnessSettled = false; // the harness ended without settling (e.g. a nonzero exit)
        // The proxy refused a request for lack of budget (402): same escalation as reaching the cap.
        // Verified live (packages/e2e/src/demo/budget-escalate.ts): Pi surfaces the proxy's 402 body verbatim after a `402 ` prefix, so a substring match on the proxy's own phrase works.
        if ((ev.kind === "error" || ev.kind === "provider_error") && isBudgetRefusal(ev.message)) return budgetStop();
        if (ev.kind === "usage") {
          // A successful call is progress; only consecutive failures count toward the cap. Rule: stopReason "error" or "aborted" is not progress (Pi emits a zero usage event before each provider_error).
          if (ev.stopReason !== "error" && ev.stopReason !== "aborted") {
            await d.registry.resetProviderAttempts(id);
            this.breaker.success(containerSpec(rec).provider ?? d.provider ?? "default");
          }
          // `gateway.spend` reads the proxy debit store (the single spend authority), so the stop reflects provider-reported cost.
          const s = await d.gateway.spend(id);
          if (s.spentMicros >= s.budgetMicros) return budgetStop();
        } else if (ev.kind === "provider_error") {
          // A cancel aborts the in-flight model turn, which Pi reports as an outage: the cancel decides the exit,
          // so no retry ladder and no synthesized failed result, which settle would rank above e.cancelled.
          if (entry.cancelled) return "stop";
          // Non-retryable (auth) fails immediately. A retryable error backs off: yield with a
          // jittered exponential timer wait, resume to retry, and fail after maxProviderRetries.
          // This is the ONE retry ladder: Pi's own auto-retry is off in the staged settings (PI_SETTINGS, pi-auth.ts, TODO(retry-ladder)).
          if (ev.code === "auth" || ev.code === "funding" || ev.code === "config") {
            // Retrying cannot fix any of these: say which one and what the operator must do, then stop at once.
            await this.ctx
              .record(rec, { kind: "error", message: providerStopMessage(ev.code, ev.message) }, `${id}:${gen}:provider-stop:${ev.code}`)
              .catch(journalFailed(this.ctx.record, rec, "provider-stop"));
            entry.cause = "provider_error";
            entry.result = { status: "failed", result: undefined };
            await session.stop();
            return "stop";
          }
          // An operator interrupt aborts the in-flight model request too, which Pi reports as a retryable outage ("This operation
          // was aborted"). The interrupt decides what happens next, exactly as on the `settled` path above: stop the pump so settle()
          // checkpoints and resumes at once with the message (resumeInterrupted). Never the ladder: counting it would spend a retry
          // (or exhaust the ladder and fail the run), and the backoff yield would resume on "timer elapsed" instead of the message
          // (YLD-4). After the non-retryable stop above: an auth/funding/config fault fails the run either way, so it fails now.
          // The raw provider_error row stays journaled (as for a cancel); interrupt_done mode "interrupted" records the decision.
          if (entry.interrupt) return "stop";
          // The count is durable (SPEC rule 6), per agent across the backoff resumes (each bumps the generation) and a daemon
          // restart; keyed by generation, so a replayed error of the same generation is never counted twice.
          const attempt = await d.registry.bumpProviderAttempts(id, `${id}:${gen}:provider-attempt`);
          const attempts = attempt - 1;
          if (attempts >= this.ctx.limits.maxProviderRetries) {
            await this.ctx
              .record(rec, { kind: "error", message: providerExhaustedMessage(attempts, ev.code, ev.message) }, `${id}:${gen}:provider-exhausted`)
              .catch(journalFailed(this.ctx.record, rec, "provider-exhausted"));
            entry.cause = "provider_error";
            entry.result = { status: "failed", result: undefined };
            await session.stop();
            return "stop";
          }
          let waitMs = providerBackoffMs(attempts, this.ctx.limits, () => this.ctx.random());
          // Shared breaker (TODO(provider-breaker)): the Nth error in the window opens it; retries back off past its end.
          const provider = containerSpec(rec).provider ?? d.provider ?? "default";
          const nowMs = this.ctx.now();
          const tripped = this.breaker.record(provider, nowMs, this.ctx.limits.maxProviderBackoffMs);
          if (tripped !== null) {
            await this.ctx
              .record(rec, { kind: PROVIDER_DEGRADED_KIND, provider, until: tripped }, `${id}:${gen}:provider-degraded:${tripped}`)
              .catch(journalFailed(this.ctx.record, rec, "provider-degraded"));
          }
          const open = this.breaker.degradedUntil(provider, nowMs);
          if (open !== null) waitMs = Math.max(waitMs, open - nowMs + Math.floor(this.ctx.random() * this.ctx.limits.providerBackoffMs));
          try {
            await this.ctx.hub.lifecycle.yield(id, {
              wait: { kind: "timer", at: this.ctx.now() + waitMs },
              idempotencyKey: `provider-backoff:${gen}:${attempt}`,
            });
          } catch {
            // Yield failed before checkpointing (the agent is still running): fail with provider_error.
            if (!entry.yielding) {
              entry.cause = "provider_error";
              entry.result = { status: "failed", result: undefined };
              await session.stop().catch(() => {});
            }
          }
          return "stop";
        }
      });
      entry.settled = harnessSettled; // reached when the pump ends without throwing
    } catch (e) {
      // A failed container start ends the run terminally (retryable kinds included: the adapter already retried pulls), with the
      // start failure's kind as the exit cause. Docker being down (endpoint_unreachable, or a bare SandboxUnavailableError) also
      // marks the sandbox down, so admission holds until the health probe sees it back.
      // TODO(start-retry): nothing retries a failed start; `retryable` only changes the message ("respawn").
      const start = startFailure(e);
      if (start) {
        entry.cause = start.cause;
        if (start.engineDown) await this.ctx.hub.store.markSandboxDown();
      } else if (isResourceError(e)) entry.cause = "resource_exhaustion";
      else if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
      const r = await this.ctx.deps.registry.get(id).catch(() => null);
      if (r)
        await this.ctx
          .record(r, { kind: "error", message: start?.message ?? String(e instanceof Error ? e.message : e) }, `${id}:${gen}:drive-error`)
          .catch(journalFailed(this.ctx.record, r, "drive-error"));
    }
    await this.settle(id, entry, overBudget, gen);
  }

  // `pomtree yield`: checkpoint the running agent and park it until its wait condition is met. Called
  // from within the agent's own sandbox, so the durable writes must complete before the container
  // exits; the drive loop then ends through settleYield (no finish()/exited).
  // `wait: null` parks with no wake of its own (a budget park): only the grant hook resumes it.
  async yield(agent: AgentId, o: { wait: WaitCondition | null; idempotencyKey: string; ctx?: WaitCtx }): Promise<Checkpoint> {
    const d = this.ctx.deps;
    if ((await d.registry.get(agent))?.executor === "deterministic") throw new LifecycleError(409, "deterministic runs cannot yield");
    // Retry-safe: a client killed mid-call (or a lost reply) retries with the same key and gets the checkpoint the
    // daemon already wrote, instead of a 409 for an agent that is already parked.
    // The marker key carries the generation: callers reuse keys across generations (provider backoff), and a yield
    // after a resume is a new yield.
    const gen0 = (await d.registry.get(agent))?.generation;
    const done = await this.ctx.hub.ops.find(agent, "yield", `${gen0}:${o.idempotencyKey}`);
    if (done?.checkpoint) {
      const prior = await d.checkpoints.read(done.checkpoint);
      if (prior) return prior;
    }
    const e = this.live.get(agent);
    if (!e) throw new LifecycleError(409, `agent ${agent} is not running`);
    // A cancel that landed before the point of no return wins: never park a cancelled agent.
    if (e.cancelled) throw new LifecycleError(409, `agent ${agent} was cancelled; not yielding`);
    // Point of no return: set the flag before the first await so a pump that ends during any of
    // these durable writes settles through settleYield instead of finish(); reset it if we never
    // reach `yielded` (a throw before the transition means no checkpoint to orphan).
    e.yielding = true;
    const r = await d.registry.get(agent);
    if (!r) {
      e.yielding = false;
      throw new LifecycleError(404, `no such agent: ${agent}`);
    }
    if (r.state !== "running") {
      e.yielding = false;
      throw new LifecycleError(409, `agent is ${r.state}, not running`);
    }
    let checkpoint: Checkpoint;
    let release!: () => void;
    let stopping = false; // set once the stop begins: past it the pause is half done and completePause finishes it
    const attempt = randomUUID(); // one id per attempt: a retry with the same idempotencyKey is a new attempt with its own marker
    e.yieldGate = new Promise<void>((res) => {
      release = res;
    });
    // The signals already visible to the agent when it asked to yield. Read before the stop: a signal that lands while the pause
    // is under way is unseen, and its own wake was dropped (the agent was still `running`), so wakeUnseen re-checks it once parked.
    let seen: string[] = [];
    try {
      seen = (await d.mailbox.peek(agent)).map((s) => s.id);
      // Pause order: journal the intent, stop the container, THEN read the session file, write the checkpoint and
      // mark `yielded`. The marker lets recovery finish the checkpoint if the daemon dies between the stop and the write.
      await this.ctx.record(
        r,
        { kind: "pausing", reason: "yield", key: o.idempotencyKey, wait: o.wait, attempt, inbox: seen, ...(o.ctx && { ctx: o.ctx }) },
        `${agent}:${r.generation}:pausing:${attempt}`,
      );
      stopping = true;
      await e.session?.stop().catch(() => {});
      // Stop the runtime before snapshotting spend so a post-stop usage event cannot land after
      // the read and be excluded from the resumed budget key.
      if (e.sandbox) await d.sandbox.stop(e.sandbox.id, d.graceMs).catch(() => {});
      checkpoint = await this.stopCheckpoint(r, `${agent}:${r.generation}:yield:${o.idempotencyKey}`, o.wait, e.workspace);
      await this.ctx
        .record(r, { kind: YIELD_INBOX_KIND, checkpoint: checkpoint.id, signals: seen } as never, `${agent}:${r.generation}:yield-inbox:${checkpoint.id}`)
        .catch(journalFailed(this.ctx.record, r, "yield-inbox"));
      if (o.ctx)
        await this.ctx
          .record(r, { kind: YIELD_CTX_KIND, checkpoint: checkpoint.id, ctx: o.ctx } as never, `${agent}:${r.generation}:yield-ctx:${checkpoint.id}`)
          .catch(journalFailed(this.ctx.record, r, "yield-ctx"));
      // A cancel that arrived during the durable writes above: leave the agent running so the cancelled settle
      // path finishes it (the checkpoint written is harmless; nothing resumes from it).
      if (e.cancelled) throw new LifecycleError(409, `agent ${agent} was cancelled; not yielding`);
      // The yield contract: `yielded` visible implies this generation's container is stopped, its exit journaled, its credentials
      // unstaged, its model key revoked and its slot released. A wake can resume the agent the instant the transition lands, so the
      // teardown runs here, before it, not in the pump-end settleYield, which may still be stopping the container (and then skips
      // what a resume took over). The checkpoint above has read spend, so the revoke may run.
      if (e.sandbox) {
        await d.registry.setSandbox(agent, r.generation, null, `${agent}:${r.generation}:yield-clear`).catch(() => {});
        await this.journalSandbox(r, r.generation, "exited", e.sandbox.id, { cause: "yielded" });
      }
      try {
        d.credentials?.unstage(agent);
      } catch (err) {
        await this.ctx
          .record(r, { kind: "error", message: `credential cleanup failed: ${String(err)}` }, `${agent}:${r.generation}:cred-cleanup`)
          .catch(journalFailed(this.ctx.record, r, "cred-cleanup"));
      }
      await d.gateway.revoke(agent).catch(() => {});
      await d.placement.release(agent).catch(() => {});
      await d.registry.transition(agent, r.generation, "yielded", { idempotencyKey: transitionKey(agent, r.generation, "yielded") });
    } catch (err) {
      e.yielding = false;
      // End the attempt's marker (see pausingMarker) when the agent keeps running: a throw before the stop, or a cancel (cancel wins
      // over a half-done pause). A throw after the stop began keeps the marker so a crash is completed by completePause.
      if (!stopping || e.cancelled)
        // TODO(pausing-residual): a crash before this abort write, with no execution evidence journaled, can still park an agent that kept running.
        await this.ctx
          .record(r, { kind: "error", message: `${PAUSE_ABORTED} ${attempt}` }, `${agent}:${r.generation}:pause-aborted:${attempt}`)
          .catch(journalFailed(this.ctx.record, r, "pause-aborted"));
      // The pump ended during the yield and already tore the runtime down as a yield; nobody is left to finish a
      // cancelled agent, so do it here (otherwise it would sit `running` with no container).
      if (e.cancelled && e.yieldSettled) await this.finish(agent, "cancelled").catch(() => {});
      throw err;
    } finally {
      release(); // lets settleYield (the pump ended when the container stopped) release the gateway key and slot
    }
    await this.ctx.record(r, { kind: "yielded" }, `${agent}:${r.generation}:yielded`);
    await this.ctx.hub.ops.mark(r, "yield", `${r.generation}:${o.idempotencyKey}`, { checkpoint: checkpoint.id });
    // Arm timer waits; signal waits are driven by orchestrator.wake.
    if (o.wait) await d.orchestrator.waitFor(agent, o.wait);
    await this.wakeUnseen(r, seen);
    // The drive loop ends through settleYield; the session and container are already stopped above.
    // TODO(yield-attached): keep the viewer's terminal alive briefly after yield until the viewer disconnects; today the stop is immediate and the terminal websocket closes with the container (an attached viewer does not delay the yield).
    return checkpoint;
  }

  // Wake a just-parked agent for the queued signals it had not seen when it asked to yield (`seen`). Their own wakes ran while it
  // was still `running` (pausing) and were dropped. Each is checked against the wait as a normal wake; the loop stops at the first
  // resume, and a racing wake for the same signal shares that resume (resumeAgent), so nothing resumes twice. A failed wake is
  // journaled and the signal stays queued (the boot lost-wake scan does not skip it: it is not in the yield inbox).
  private async wakeUnseen(r: AgentRecord, seen: readonly string[]): Promise<void> {
    const d = this.ctx.deps;
    const skip = new Set(seen);
    try {
      for (const signal of await d.mailbox.peek(r.id)) {
        if (skip.has(signal.id)) continue;
        if (await this.wakeResumeNow(r.id, signal)) return;
        if ((await d.registry.get(r.id))?.state !== "yielded") return;
      }
    } catch (err) {
      if ((await d.registry.get(r.id).catch(() => null))?.state !== "yielded") return; // another wake resumed it first
      await this.ctx
        .record(
          r,
          {
            kind: "error",
            message: `wake after pause failed: ${String(err instanceof Error ? err.message : err)}; a signal that arrived while the agent was pausing is still queued; run \`pomtree resume ${r.id}\` to resume it`,
          },
          `${r.id}:${r.generation}:pause-wake-error`,
        )
        .catch(journalFailed(this.ctx.record, r, "pause-wake-error"));
    }
  }

  // Checkpoint a STOPPED agent: the session file (torn tail trimmed), spend, image, the folder id and the last ingested ref.
  // Hashes and ids only. Idempotent by `key` (the store returns the first write). The container must already be stopped.
  async stopCheckpoint(r: AgentRecord, key: string, wait: WaitCondition | null, workspace?: WorkspaceId): Promise<Checkpoint> {
    const d = this.ctx.deps;
    // A container killed mid-write can leave a torn final JSONL line; it is trimmed before checkpointing.
    let sessionRef: string;
    try {
      const rawSession = await this.readSessionFile(r.id);
      const trimmed = trimTornTail(Buffer.from(rawSession).toString("utf8"));
      sessionRef = await d.sessions.put(trimmed.dropped ? new Uint8Array(Buffer.from(trimmed.text, "utf8")) : rawSession);
    } catch (e) {
      if (!(e instanceof SafeOpenError)) throw e;
      sessionRef = await this.refusedSession(r, key, e);
    }
    const spend = await d.gateway.spend(r.id);
    const imageDigest = await d.sandbox.resolveImageDigest(containerSpec(r).image);
    const ws = workspace ?? (await folderId(this.ctx.deps, r.id));
    if (ws === null) throw new LifecycleError(409, `agent ${r.id} has no workspace folder to checkpoint`);
    return d.checkpoints.write(
      {
        agent: r.id,
        generation: r.generation,
        host: d.hostId,
        sessionRef,
        workspace: ws,
        node: d.hostId,
        ingested: await d.workspace.ingested(r.id),
        wait,
        remainingBudgetMicros: Math.max(0, r.budgetMicros - spend.spentMicros),
        imageDigest,
        envManifestHash: containerSpec(r).envManifestHash,
        ...checkpointTemplate(containerSpec(r)),
      },
      key,
    );
  }

  // The folder a resume mounts: the agent's own kept folder when it is still here; else (evicted) a fresh clone at the
  // last ingested commit (the default branch when nothing was ingested). `commit` is the base commit for POMTREE_BASE_COMMIT.
  private async resumeFolder(agent: AgentId, cp: Checkpoint): Promise<{ workspace: WorkspaceId; commit: string }> {
    const d = this.ctx.deps;
    if (await d.workspace.has(agent)) return d.workspace.create(agent, {});
    const ws = await d.workspace.create(agent, cp.ingested ? { fromCommit: cp.ingested.commit } : {});
    const r = await this.ctx.deps.registry.get(agent);
    if (r)
      await this.ctx
        .record(
          r,
          {
            kind: "error",
            message: `workspace folder was evicted; restored from ${cp.ingested ? `the last ingested ref ${cp.ingested.ref}` : "the default branch"}; un-pushed work is gone`,
          },
          `${agent}:${cp.id}:folder-restored`,
        )
        .catch(journalFailed(this.ctx.record, r, "folder-restored"));
    return ws;
  }

  // Journal-derived intent marker: the latest `pausing` entry for the agent's current generation, ended by an `error` entry
  // `pause-aborted: <attempt>` (the core journal has no kind for it) or dropped when a later EXECUTION_KINDS entry shows the agent
  // kept running, because the end record itself can be lost to a crash. Returns the unfinished pause journaled by yield() before
  // the container stops, or null. A running agent with the marker, no container and a folder crashed between the stop and the checkpoint.
  // TODO(session-integrity): a stale marker after an aborted, adopted pause could mis-complete a later crash as a pause (low risk, bounded by generation scoping).
  async pausingMarker(a: AgentRecord): Promise<{ key: string; wait: WaitCondition | null; inbox: string[]; ctx?: WaitCtx } | null> {
    let found: { key: string; wait: WaitCondition | null; inbox: string[]; ctx?: WaitCtx } | null = null;
    let attempt: string | undefined;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: a.id, limit: 500 });
      for (const e of page) {
        if (e.generation !== a.generation) continue;
        if (e.payload.kind === "error") {
          const m = (e.payload as { message?: string }).message;
          if (found && attempt !== undefined && m === `${PAUSE_ABORTED} ${attempt}`) found = null;
          continue;
        }
        if (found && EXECUTION_KINDS.has(e.payload.kind)) {
          found = null;
          continue;
        }
        if (e.payload.kind !== "pausing") continue;
        const p = e.payload;
        found = { key: p.key, wait: p.wait, inbox: p.inbox, ...(p.ctx && { ctx: p.ctx }) };
        attempt = p.attempt;
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return found;
      from = last.seq + 1;
    }
  }

  // Crash recovery for a pause (see pausingMarker): the container is gone, the folder and session file are intact, so write the
  // checkpoint (same key as yield(), so a checkpoint that already landed is reused) and mark the agent yielded.
  // TODO(yield-deadline): the yield handshake has no deadline of its own (only the session wall-clock bounds it); a crash in between is completed idempotently here.
  async completePause(a: AgentRecord, m: { key: string; wait: WaitCondition | null; inbox: string[]; ctx?: WaitCtx }): Promise<void> {
    const d = this.ctx.deps;
    await this.reconciler.reclaimSandbox(a, true);
    // The inbox the marker recorded when the yield was requested: a signal that arrived during the pause (or the crash) is unseen.
    const seen = m.inbox;
    const checkpoint = await this.stopCheckpoint(a, `${a.id}:${a.generation}:yield:${m.key}`, m.wait);
    await this.ctx
      .record(a, { kind: YIELD_INBOX_KIND, checkpoint: checkpoint.id, signals: seen } as never, `${a.id}:${a.generation}:yield-inbox:${checkpoint.id}`)
      .catch(journalFailed(this.ctx.record, a, "yield-inbox"));
    if (m.ctx)
      await this.ctx
        .record(a, { kind: YIELD_CTX_KIND, checkpoint: checkpoint.id, ctx: m.ctx } as never, `${a.id}:${a.generation}:yield-ctx:${checkpoint.id}`)
        .catch(journalFailed(this.ctx.record, a, "yield-ctx"));
    // The yield contract (see yield()): journal the exit, unstage, revoke and release BEFORE `yielded`. A wake can resume the agent as
    // soon as the transition lands, and these are keyed by agent id only, so after it they would hit the resumed generation's
    // credentials, key and slot. The checkpoint (which reads spend) has landed. The exit row shares yield()'s key, so a row the
    // crashed daemon already wrote is not repeated.
    if (a.sandbox) await this.journalSandbox(a, a.generation, "exited", a.sandbox, { cause: "yielded" });
    try {
      d.credentials?.unstage(a.id);
    } catch (err) {
      await this.ctx
        .record(a, { kind: "error", message: `credential cleanup failed: ${String(err)}` }, `${a.id}:${a.generation}:cred-cleanup`)
        .catch(journalFailed(this.ctx.record, a, "cred-cleanup"));
    }
    await d.gateway.revoke(a.id).catch(() => {});
    await d.placement.release(a.id).catch(() => {});
    await d.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: transitionKey(a.id, a.generation, "yielded") });
    await this.ctx.record(a, { kind: "yielded" }, `${a.id}:${a.generation}:yielded`);
    await this.ctx.hub.ops.mark(a, "yield", `${a.generation}:${m.key}`, { checkpoint: checkpoint.id });
    if (m.wait) await d.orchestrator.waitFor(a.id, m.wait);
    await this.wakeUnseen(a, seen);
  }

  // Resume an agent from its latest checkpoint. Normal resumes require `yielded`; `forced` also
  // accepts a `running` agent (daemon-restart fence). `wake` is the text handed to the harness.
  async resumeAgent(
    agent: AgentId,
    wake = "operator resumed you",
    opts: { forced?: boolean; grant?: boolean; observedGeneration?: number; operator?: boolean; interruptMode?: InterruptMode } = {},
    key?: string,
  ): Promise<AgentRecord> {
    const deterministic = await this.ctx.deps.registry.get(agent);
    if (deterministic?.executor === "deterministic" && !this.canContinue(deterministic)) throw new LifecycleError(409, "deterministic runs cannot be resumed");
    const inflight = this.resuming.get(agent);
    if (inflight) return opts.operator ? this.resetRestartBudget(await inflight) : inflight; // Concurrent satisfying wakes share one resume
    // Take the claim before the first await. When another actor holds it, a resume is never refused (operator, wake and watchdog
    // must go through): it tells the holder its decision is stale and proceeds.
    const claim = this.tryClaim(agent, "resume");
    const holder = this.claims.get(agent);
    if (!claim && holder) holder.preempted = true;
    // Register the in-flight run synchronously (before any await) so a concurrent resume shares it instead of racing past the
    // check and bumping the generation a second time.
    const run = (async () => {
      if (key !== undefined && (await this.ctx.hub.ops.seen(agent, "resume", key))) {
        const cur = await this.ctx.deps.registry.get(agent);
        if (cur) return cur;
      }
      const rec = await this.resumeAgentNow(agent, wake, opts);
      if (opts.operator) await this.resetRestartBudget(rec);
      await this.ctx.hub.ops.mark(rec, "resume", key);
      return rec;
    })();
    this.resuming.set(agent, run);
    try {
      return await run;
    } finally {
      if (this.resuming.get(agent) === run) this.resuming.delete(agent);
      if (claim) this.releaseClaim(agent, claim);
    }
  }

  // An operator resume (`pomtree resume`, with or without --force) is the explicit reset of the lifetime restart count: it journals a
  // RESTART_RESET marker on the resumed generation, and restartCount counts only entries after the latest one. Keyed per
  // generation, so a replay of the same resume writes it once (restartCount honors only the latest marker).
  private async resetRestartBudget(rec: AgentRecord): Promise<AgentRecord> {
    await this.ctx.record(rec, { kind: "error", message: `${RESTART_RESET} operator resume` }, `${rec.id}:${rec.generation}:restart-reset`);
    return rec;
  }

  // The one chokepoint for a supervisor-initiated forced resume. A cause that `charges` first
  // checks the lifetime budget ("exhausted" = spent, nothing done; the caller takes its exhaustion path) and journals one
  // `auto-restart:` entry. Order: budget check, optional stop-checkpoint, optional staleness check, the charge, then
  // `resumeAgent(forced)`. The charge precedes the checkpoint when staleness is a generation compare (a host fault is a real
  // event), and follows the claim check otherwise (a preempted decider restarts nothing and must not be charged).
  // "superseded" = another actor moved the agent first (the caller leaves it alone); "skipped" = `o.wake` declined. A strict
  // checkpoint failure throws; the caller owns that handling.
  async forceResume(
    agent: AgentRecord,
    observedGeneration: number,
    cause: ForceResumeCause,
    o: { wake?: string | (() => Promise<string | undefined>); restartReason?: string; isStale?: () => boolean; interruptMode?: InterruptMode } = {},
  ): Promise<"resumed" | "superseded" | "skipped" | "exhausted"> {
    const id = agent.id;
    if (agent.executor === "deterministic") return "skipped"; // no runtime to adopt or restart: the reconcile phase fails it explicitly
    const p = FORCE_RESUME_POLICY[cause];
    let charge = async () => {};
    if (p.charges) {
      const used = await this.restartCount(id);
      const max = this.ctx.deps.maxRestarts ?? 3;
      if (used >= max) return "exhausted";
      charge = async () =>
        void (await this.ctx.record(
          agent,
          { kind: "error", message: `${AUTO_RESTART} ${o.restartReason} (${used + 1}/${max})` },
          `${id}:${observedGeneration}:auto-restart`,
        ));
    }
    if (p.stale === "generation") await charge();
    if (p.checkpoint) {
      if (!p.checkpoint.needsFolder || (await this.ctx.deps.workspace.has(id))) {
        const cp = this.stopCheckpoint(agent, `${id}:${observedGeneration}:${p.checkpoint.suffix}`, null);
        if (p.checkpoint.strict) await cp;
        else await cp.catch(() => {});
      }
    }
    if (p.stale === "generation" && (await this.superseded(id, observedGeneration))) return "superseded";
    // A resume that started during the checkpoint already advanced the generation: the caller's decision is stale.
    if (p.stale === "claim") {
      if (o.isStale?.()) return "superseded";
      await charge();
    }
    const wake = typeof o.wake === "function" ? await o.wake() : o.wake;
    if (typeof o.wake === "function" && wake === undefined) return "skipped";
    await this.resumeAgent(id, wake, { forced: true, ...(p.observed && { observedGeneration }), ...(o.interruptMode && { interruptMode: o.interruptMode }) });
    return "resumed";
  }

  private async resumeAgentNow(
    agent: AgentId,
    wake: string,
    opts: { forced?: boolean; grant?: boolean; observedGeneration?: number; interruptMode?: InterruptMode },
  ): Promise<AgentRecord> {
    const d = this.ctx.deps;
    const forced = opts.forced === true;
    const workflow = await d.registry.get(agent);
    if (workflow && this.canContinue(workflow)) return this.resumeWorkflow(workflow, opts);
    const cp = await d.checkpoints.latest(agent);
    if (!cp) throw new LifecycleError(409, `no checkpoint for ${agent}`);
    const r = await d.registry.get(agent);
    if (!r) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (r.state === "exited" || r.state === "reaped") throw new LifecycleError(409, `agent is ${r.state}, cannot resume`);
    if (r.state !== "yielded" && !(forced && r.state === "running")) {
      throw new LifecycleError(409, `agent is ${r.state}, not yielded`);
    }
    // A budget-parked agent resumes only through the grant hook (`grant`), never by `pomtree resume`, a message or a timer.
    if (!opts.grant && (await this.budget.isBudgetParked(r))) {
      throw new LifecycleError(409, `agent ${agent} is parked on a budget approval; it resumes when the approval is granted`, { code: "budget_pending" });
    }
    // A quarantined agent is not auto-resumed; only an explicit --force (opts.forced) overrides it.
    if (!forced && (await this.reconciler.isQuarantined(r))) {
      throw new LifecycleError(409, "agent is quarantined; resume requires --force");
    }
    // The key carries the current generation so a second forced resume from
    // the same checkpoint bumps again instead of replaying the first resume's snapshot.
    const resumeKey = `${agent}:${cp.id}:${r.generation}:resume`;
    // Held across the claim so the folder sweep, which re-checks the state under the same lock, cannot evict a folder this resume took.
    const rec: AgentRecord | null = await this.sweeps.withFolderLock(agent, async () => {
      // Observed generation: a decider that read generation G before an await and finds the agent
      // already past it is stale; it returns the current record without bumping. The registry bump is unconditional, so this
      // compare is the only guard. It is race-free here because the read and the bump are adjacent and a concurrent resume of
      // this agent is either the in-flight `resuming` promise (shared, never a second bump) or already complete (seen by the read).
      if (opts.observedGeneration !== undefined) {
        const cur = await d.registry.get(agent);
        if (cur && cur.generation !== opts.observedGeneration) return null;
      }
      if (r.state === "yielded") {
        const bumped = await d.registry.bumpGeneration(agent, d.hostId, resumeKey);
        return d.registry.transition(agent, bumped.generation, "running", { idempotencyKey: transitionKey(agent, bumped.generation, "running") });
      }
      // Forced resume of a running agent: fence the dead instance and stay running.
      return d.registry.bumpGeneration(agent, d.hostId, resumeKey);
    });
    if (rec === null) return (await d.registry.get(agent)) ?? r; // stale decider: a no-op, not an error
    if (forced) await this.sweeps.setWatchdog(agent, { quarantined: false }, `${agent}:${rec.generation}:unquarantine`).catch(() => {});
    await this.ctx.record(rec, { kind: "resumed" }, `${agent}:${rec.generation}:resumed`);
    if (opts.interruptMode) this.interruptModes.set(agent, { generation: rec.generation, mode: opts.interruptMode });
    // Run the segment in the background (tracked by the orchestrator), like drive().
    this.starting.set(agent, rec.generation);
    try {
      await d.orchestrator.resume(agent, rec.generation, wake);
    } catch (e) {
      this.starting.delete(agent);
      throw e;
    }
    return rec;
  }

  private async resumeWorkflow(r: AgentRecord, opts: { forced?: boolean; observedGeneration?: number; interruptMode?: InterruptMode }): Promise<AgentRecord> {
    const d = this.ctx.deps;
    const rec = await this.ctx.withLock(`result:${r.id}`, async () => {
      const current = await d.registry.get(r.id);
      if (!current) throw new LifecycleError(404, "workflow no longer exists");
      if (opts.observedGeneration !== undefined && current.generation !== opts.observedGeneration) return current;
      if (current.state !== "yielded" && !(opts.forced && current.state === "running")) return current;
      if (this.live.has(r.id)) throw new LifecycleError(409, "workflow body is still settling");
      const deadline = await this.budget.sessionDeadlineAt(r.id);
      if (deadline !== null) this.budget.deadlines.set(r.id, deadline);
      if (deadline !== null && deadline <= this.ctx.now()) {
        await this.finish(r.id, "timed_out");
        return (await d.registry.get(r.id))!;
      }
      const snapshot = current.state === "yielded" ? await latestContinuation(d.journal, r.id) : undefined;
      const bumped = await d.registry.bumpGeneration(r.id, d.hostId, `${r.id}:${snapshot?.generation ?? current.generation}:workflow-resume`);
      return current.state === "yielded"
        ? d.registry.transition(r.id, bumped.generation, "running", { idempotencyKey: transitionKey(r.id, bumped.generation, "running") })
        : bumped;
    });
    if (rec.state === "running") {
      await this.ctx.record(rec, { kind: "resumed" }, `${rec.id}:${rec.generation}:resumed`);
      if (opts.interruptMode) this.interruptModes.set(rec.id, { generation: rec.generation, mode: opts.interruptMode });
      this.starting.set(rec.id, rec.generation);
      try {
        await d.orchestrator.resume(rec.id, rec.generation, "workflow continuation");
      } catch (error) {
        this.starting.delete(rec.id);
        throw error;
      }
    }
    return rec;
  }

  // Driver.resume: the post-transition segment for a resumed agent (checkout, restore session,
  // sandbox from the checkpoint image, harness.resume, pump).
  async runResumed(agent: AgentId, gen: number, wake: string): Promise<void> {
    const d = this.ctx.deps;
    const clearStarting = () => {
      if (this.starting.get(agent) === gen) this.starting.delete(agent);
    };
    const workflow = await d.registry.get(agent);
    if (workflow && this.canContinue(workflow)) {
      try {
        // A workflow has no prompt: interrupts pending at its resume are consumed by it (journaled delivered, signals drained).
        if (workflow.generation === gen && workflow.state === "running") await this.takeInterrupts(agent, gen, "workflow continuation");
        await this.driveDeterministic(agent, gen);
      } finally {
        clearStarting();
      }
      return;
    }
    let cp: Checkpoint | null;
    let rec: AgentRecord | null;
    try {
      cp = await d.checkpoints.latest(agent);
      rec = await this.ctx.deps.registry.get(agent);
    } catch (e) {
      clearStarting();
      throw e;
    }
    if (!cp || !rec) return clearStarting();
    // A stale call (the generation moved on, e.g. a replayed resume) must do nothing: it must never kill or reclaim a
    // newer run's runtime. Check the generation FIRST, before any destructive step.
    if (rec.generation !== gen || rec.state !== "running") return clearStarting();
    // Mark the resume in flight BEFORE any destructive step and before admission: otherwise each reconcile tick sees
    // running-with-no-live and bumps the generation again while this call is parked, and a stale call could later
    // mount the shared folder.
    const prior = this.live.get(agent);
    const entry: Live = { cancelled: false, admitting: true };
    this.live.set(agent, entry);
    clearStarting();
    try {
      // Fence a still-driven previous instance (a forced resume of a running agent): stop its runtime
      // so its own settle() sees the generation move and does a no-op cleanup, not a finish().
      if (prior || rec.sandbox) {
        // Revoke the superseded instance's model key BEFORE killing it and before the new key is issued: the kill is
        // best-effort and a partitioned container could keep spending until the key expires. The gateway stamps the
        // fresh key strictly after this revocation. (The superseded run's settle skips revocation, so it cannot kill
        // the fresh key.) A revoke failure fails the resume loudly (the catch below) rather than leaving a live key.
        await d.gateway.revoke(agent);
      }
      if (prior) {
        prior.cancelled = true;
        if (prior.sandbox) await d.sandbox.kill(prior.sandbox.id).catch(() => {});
        await prior.session?.stop().catch(() => {});
      } else if (rec.sandbox) {
        // After a daemon restart no live entry exists to kill the registry's container, so reclaim it before
        // the resume (else a second container would share the folder). The folder is the agent's own and is mounted as it
        // stands: whatever the dead run left, uncommitted edits included, survives into the resumed run.
        await this.reconciler.reclaimSandbox(rec, true);
      }
    } catch (e) {
      if (this.live.get(agent) === entry) this.live.delete(agent);
      throw e;
    }
    // A resumed agent goes through admission (priority by cause, leaves first) so a recovered fleet
    // respects the placement cap instead of resuming every checkpointed agent at once; settle() then
    // releases a slot this path actually took.
    const admitted = await this.ctx.hub.host.admit(agent, this.urgent.delete(agent) ? PRIORITY.alert : await this.resumePriority(agent, cp)).catch(() => false);
    entry.admitting = false;
    if (!admitted) {
      if (this.live.get(agent) === entry) this.live.delete(agent);
      return;
    }
    const fresh = await this.ctx.deps.registry.get(agent).catch(() => null);
    if (!fresh || fresh.generation !== gen) {
      // Superseded while queued: never touch the folder; the newer resume owns the slot (admit/settle fence).
      if (this.live.get(agent) === entry) this.live.delete(agent);
      return;
    }
    const deadlineAt = this.budget.deadlines.get(agent);
    if (deadlineAt !== undefined) this.armDeadline(entry, deadlineAt);
    try {
      const ws = await this.resumeFolder(agent, cp);
      const bytes = await d.sessions.get(cp.sessionRef);
      if (bytes) {
        // Verify content address then structure before restoring; a corrupt blob fails the
        // resume loudly (journaled by the catch below) rather than handing Pi a torn conversation.
        const verdict = verifySession(bytes, cp.sessionRef);
        if (!verdict.ok) throw new Error(`session ${cp.sessionRef} failed integrity check (${verdict.reason}); refusing to restore`);
        await this.writeSessionFile(agent, bytes);
      }
      // Every resume delivers the interrupts pending at this point, whichever wake started it (an interrupt wake, or a timer or
      // message wake that won the race with one, or one sent while this run sat in admission). Taken as late as possible, after
      // every step that can fail before the container starts, so a failed resume leaves them pending.
      const prompt = await this.takeInterrupts(agent, gen, wake, entry);
      await this.runSegment(agent, entry, rec, gen, {
        workspace: ws.workspace,
        baseCommit: ws.commit,
        budgetMicros: fresh.budgetMicros, // the TOTAL cap (spent still counts), read after any raise
        image: cp.imageDigest || d.image,
        kind: "resume",
        prompt: rec.task,
        sessionRef: cp.sessionRef,
        wake: prompt,
      });
    } catch (e) {
      if (e instanceof SandboxUnavailableError) await this.ctx.hub.store.markSandboxDown();
      else if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
      const cur = await this.ctx.deps.registry.get(agent).catch(() => null);
      if (cur)
        await this.ctx
          .record(cur, { kind: "error", message: String(e instanceof Error ? e.message : e) }, `${agent}:${gen}:drive-error`)
          .catch(journalFailed(this.ctx.record, cur, "drive-error"));
      await this.settle(agent, entry, false, gen);
    }
  }

  // Ids of the signals that were queued when checkpoint `cp` was written (empty when no marker, e.g. a crash mid-yield).
  async yieldInbox(id: AgentId, cp: string): Promise<Set<string>> {
    const seen = new Set<string>();
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: id, limit: 500 });
      for (const e of page) {
        const f = e.payload as { kind: string; checkpoint?: string; signals?: string[] };
        if (f.kind !== YIELD_INBOX_KIND || f.checkpoint !== cp) continue;
        seen.clear();
        for (const k of f.signals ?? []) seen.add(k);
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return seen;
      from = last.seq + 1;
    }
  }

  // An interrupt reached a running agent: its mailbox extension aborts the Pi turn, the turn settles (the interactive Pi stays
  // open) and the pump stops on `entry.interrupt`, so settle() checkpoints + resumes with the message. Backstop: if the run has
  // not ended within interruptGraceMs, kill the container and stop the session.
  armInterrupt(agent: AgentId): void {
    const e = this.live.get(agent);
    // No runtime yet: a resumed run delivers the message in its prompt (takeInterrupts). A fresh start does not: TODO(interrupts)
    // at queueInterrupt.
    if (!e || e.admitting) return;
    e.interrupt = true;
    // The backstop starts once the session exists (runSegment re-arms then): fired earlier it would have nothing to stop.
    if (e.interruptTimer || !e.session) return;
    e.interruptTimer = setTimeout(() => {
      const sb = e.sandbox?.id;
      if (sb)
        this.ctx.deps.sandbox.kill(sb).catch(async (err) => {
          // Not fatal (stopping the session below ends the run and settle() stops the sandbox again), but a container that
          // survives both is the operator's to remove: say so once per generation.
          const r = await this.ctx.deps.registry.get(agent).catch(() => null);
          if (r)
            await this.ctx
              .record(
                r,
                {
                  kind: "error",
                  message: `interrupt backstop: killing sandbox ${sb} failed: ${String(err instanceof Error ? err.message : err)}; the run is ended by stopping its session and settle retries the stop; if the container is still running, remove it with \`docker rm -f ${sb}\``,
                },
                `${agent}:${r.generation}:interrupt-kill-failed`,
              )
              .catch(journalFailed(this.ctx.record, r, "interrupt-kill-failed"));
        });
      void e.session?.stop().catch(() => {}); // ends the event stream even if the kill is slow or fails (harness contract)
    }, this.ctx.deps.interruptGraceMs ?? 5000);
    e.interruptTimer.unref?.();
  }

  // Interrupt messages journaled but not yet delivered as a resume prompt, in order.
  async pendingInterrupts(agent: AgentId): Promise<{ key: string; body: string }[]> {
    const all: { key: string; body: string }[] = [];
    const done = new Set<string>();
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent, limit: 500 });
      for (const en of page) {
        const p = en.payload as { kind: string; key?: string; body?: string; keys?: string[] };
        if (p.kind === INTERRUPT_KIND && p.key !== undefined) all.push({ key: p.key, body: p.body ?? "" });
        else if (p.kind === INTERRUPT_DONE_KIND) for (const k of p.keys ?? []) done.add(k);
      }
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    return all.filter((m) => !done.has(m.key));
  }

  // Resume `agent` (yielded, or a just-checkpointed running one) for its pending interrupt messages, ahead of other pending
  // resumes. Returns whether a resume was started. The resumed run words and delivers the messages itself (takeInterrupts).
  // A resume already in flight is left alone: its run takes every interrupt journaled before it reaches takeInterrupts, and
  // queueInterrupt arms it for any journaled after, so this caller never needs to wait for it.
  async resumeWithInterrupts(agent: AgentId, mode: "woke"): Promise<boolean> {
    if (this.resuming.has(agent)) return false;
    const r = await this.ctx.deps.registry.get(agent);
    if (r && (await this.budget.isBudgetParked(r))) return false; // the message stays queued until the grant resumes the agent
    if (!(await this.pendingInterrupts(agent)).length) return false;
    this.urgent.add(agent);
    try {
      await this.resumeAgent(agent, WOKE_NOTE, { interruptMode: mode });
    } catch (err) {
      this.urgent.delete(agent);
      throw err;
    }
    return true;
  }

  // An operator interrupt for `rec`: journal it (the journal is the only record of pending interrupts), queue its flagged signal
  // and arm the agent's run if that run already took its resume's interrupts. Serialized with takeInterrupts on the agent's
  // interrupt lock, so for a resumed run a message is either in its resume prompt or armed for, never both and never neither.
  // TODO(interrupts): not for a fresh start. An interrupt to a `pending` agent, or to one restarted fresh (restartFresh's
  // admitting placeholder, then drive(), which never calls takeInterrupts), is journaled and flagged but neither delivered in a
  // prompt nor armed: the run's mailbox extension aborts its first turn for the flagged signal while the daemon is unarmed, and
  // the agent can wedge (pre-existing, not fixed here).
  async queueInterrupt(rec: AgentRecord, key: string, body: string, send: () => Promise<unknown>): Promise<void> {
    await this.ctx.withLock(`interrupt:${rec.id}`, async () => {
      // At the current generation: a resume since the caller read `rec` moved it, and the journal refuses a superseded one.
      const cur = (await this.ctx.deps.registry.get(rec.id)) ?? rec;
      await this.ctx.record(cur, { kind: INTERRUPT_KIND, key, body } as never, `${rec.id}:interrupt:${key}`);
      await send();
      this.armInterrupt(rec.id); // no-op without a live run, or while it is admitting (its takeInterrupts is still ahead)
    });
  }

  // The resume prompt for run `gen`: `wake` plus every interrupt message still pending, which are journaled delivered (their
  // flagged signals drained) here and only here. The arming of `entry` is cleared under the same lock: any interrupt it was armed
  // for is in this prompt, and queueInterrupt re-arms it for a later one.
  private async takeInterrupts(agent: AgentId, gen: number, wake: string, entry?: Live): Promise<string> {
    return this.ctx.withLock(`interrupt:${agent}`, async () => {
      const hint = this.interruptModes.get(agent);
      if (hint?.generation === gen) this.interruptModes.delete(agent);
      const mode = hint?.generation === gen ? hint.mode : "resume";
      // TODO(interrupts): a full scan of the agent's journal per resume, under the lock (Journal.read has no kind filter or
      // backward read, so it cannot stop at the latest interrupt_done without a durable marker).
      let pend: { key: string; body: string }[];
      try {
        pend = await this.pendingInterrupts(agent);
      } catch (err) {
        // An unreadable journal must not fail a resume that may have nothing to deliver: resume without them. They stay
        // pending (no interrupt_done is written) and an armed entry stays armed, so a later resume delivers them.
        if (isStoreDown(err)) this.ctx.hub.store.markDown(err);
        const r = await this.ctx.deps.registry.get(agent).catch(() => null);
        if (r)
          await this.ctx
            .record(
              r,
              {
                kind: "error",
                message: `pending operator interrupts unreadable (${String(err instanceof Error ? err.message : err)}); resuming without them; they stay pending and the next resume delivers them`,
              },
              `${agent}:${gen}:interrupts-unreadable`,
            )
            .catch(journalFailed(this.ctx.record, r, "interrupts-unreadable"));
        return wake;
      }
      if (entry) {
        clearTimeout(entry.interruptTimer);
        entry.interruptTimer = undefined;
        entry.interrupt = false;
      }
      if (!pend.length) return wake;
      await this.markInterruptsDelivered(agent, pend, mode);
      return interruptResumeText(mode, wake, pend);
    });
  }
  // The pending interrupt messages went out in a resume prompt: journal them delivered (keyed by the entries, so a replay
  // adds nothing) and drop their flagged mailbox signals (they head the mailbox: interrupts sort first).
  private async markInterruptsDelivered(agent: AgentId, pend: { key: string }[], mode: string): Promise<void> {
    const rec = await this.ctx.deps.registry.get(agent);
    if (rec)
      await this.ctx
        .record(rec, { kind: INTERRUPT_DONE_KIND, keys: pend.map((m) => m.key), mode } as never, `${agent}:interrupt-done:${pend[0]!.key}:${pend.length}`)
        .catch(journalFailed(this.ctx.record, rec, "interrupt-done"));
    const queued = await this.ctx.deps.mailbox.peek(agent);
    let n = 0;
    while (n < pend.length && (queued[n] as { interrupt?: boolean } | undefined)?.interrupt === true) n++;
    if (n) await this.ctx.deps.mailbox.receive(agent, `interrupt-drain:${agent}:${pend[0]!.key}:${pend.length}`, { limit: n }).catch(() => {});
  }

  // The Pi process ended while an interrupt was armed: checkpoint the aborted run (the kept folder, session with any torn
  // tail trimmed) and resume at once; the resumed run delivers the pending messages (takeInterrupts). With none pending (an
  // arming whose message another resume already delivered) it still resumes, with the interrupted note alone: the agent was
  // stopped by the daemon, not by a fault. False = nothing resumed (caller fails the run).
  private async resumeInterrupted(id: AgentId, gen: number): Promise<boolean> {
    const d = this.ctx.deps;
    try {
      const r = await d.registry.get(id);
      if (!r || r.state !== "running" || r.generation !== gen || this.ctx.hub.store.draining()) return false;
      this.urgent.add(id);
      try {
        const res = await this.forceResume(r, gen, "interrupted", { wake: INTERRUPTED_NOTE, interruptMode: "interrupted" });
        if (res !== "resumed") this.urgent.delete(id); // no resume of ours will consume the priority
        if (res === "superseded") return true;
        if (res === "skipped") return false;
      } catch (err) {
        this.urgent.delete(id);
        throw err;
      }
      return true;
    } catch (err) {
      if (await this.superseded(id, gen).catch(() => false)) return true; // a resume completed inside the checkpoint window
      const r = await this.ctx.deps.registry.get(id).catch(() => null);
      if (r)
        await this.ctx
          .record(
            r,
            { kind: "error", message: `interrupt resume failed: ${String(err instanceof Error ? err.message : err)}` },
            `${id}:${gen}:interrupt-resume-error`,
          )
          .catch(journalFailed(this.ctx.record, r, "interrupt-resume-error"));
      return false;
    }
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
    const d = this.ctx.deps;
    const parkedBefore = await this.ctx.hub.ops.find(agent, "yield", `${(await d.registry.get(agent))?.generation}:${o.idempotencyKey}`);
    if (parkedBefore?.checkpoint) {
      const cp = await d.checkpoints.read(parkedBefore.checkpoint);
      if (cp) return { parked: true, checkpoint: cp }; // a retry of a park that already landed
    }
    const rec = await d.registry.get(agent);
    if (!rec || rec.state !== "running") throw new LifecycleError(409, `agent is ${rec?.state ?? "unknown"}, not running`);
    // The same value the container's document carries, so the in-container pomtree long-polls exactly as long as this allows.
    const threshold = (d.containerConfig ?? DEFAULT_CONTAINER_CONFIG)["wait.yieldMs"];
    if (!(o.timeoutMs > threshold)) return { parked: false };
    const at = this.ctx.now() + o.timeoutMs;
    let cond: WaitCondition;
    let ctx: WaitCtx;
    switch (o.on.kind) {
      case "child": {
        const child = await d.registry.get(o.on.child);
        if (!child) throw new LifecycleError(404, `no such agent: ${o.on.child}`);
        // The same rule the synchronous GET /wait applies (api.ts target()): itself, a child, or an exited descendant held in custody.
        if (!(await this.tree.canWaitOn(agent, child))) throw new LifecycleError(404, `no such agent: ${o.on.child}`);
        if (isDone(child)) return { parked: false };
        cond = { kind: "child_exited", children: [o.on.child], mode: "any" };
        ctx = { kind: "child", child: o.on.child, timeoutMs: o.timeoutMs, at };
        break;
      }
      case "inbox":
        if ((await d.mailbox.peek(agent)).length) return { parked: false };
        cond = { kind: "message" };
        ctx = { kind: "inbox", timeoutMs: o.timeoutMs, at };
        break;
      case "ask": {
        const esc = await d.escalations.get(o.on.escalation);
        if (!esc || esc.agent !== agent) throw new LifecycleError(404, `no such escalation: ${o.on.escalation}`);
        if (esc.state === "answered") return { parked: false };
        cond = { kind: "message" }; // an answer arrives as human_answer; wakeResume ignores other messages for an ask park
        ctx = { kind: "ask", escalation: o.on.escalation, timeoutMs: o.timeoutMs, at };
        break;
      }
    }
    const checkpoint = await this.ctx.hub.lifecycle.yield(agent, {
      wait: { kind: "any", of: [cond, { kind: "timer", at }] },
      idempotencyKey: o.idempotencyKey,
      ctx,
    });
    return { parked: true, checkpoint };
  }

  private async yieldCtx(id: AgentId, cp: string): Promise<WaitCtx | null> {
    let found: WaitCtx | null = null;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: id, limit: 500 });
      for (const e of page) {
        const f = e.payload as { kind: string; checkpoint?: string; ctx?: WaitCtx };
        if (f.kind === YIELD_CTX_KIND && f.checkpoint === cp && f.ctx) found = f.ctx;
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return found;
      from = last.seq + 1;
    }
  }

  // The synthetic first message a resumed agent sees: what it was waiting for and what happened.
  private async resumeText(agent: AgentId, ctx: WaitCtx | null, signal: Signal): Promise<string> {
    const sig = signalToWake(signal);
    if (signal.kind === "escalation") return `Resumed: ${sig}. Run \`pomtree inbox\` to read it, then decide or answer it, or pass it up.`;
    // A custody hand-up wakes a message, timer or any-mode child wait, so the wait-specific lines below (a timeout, a named child) would be false.
    if (signal.kind === "child_exited" && signal.custodyOf !== undefined)
      return `Resumed: ${sig}. ${signal.child} exited under ${signal.custodyOf}, which is gone, and is now held for you. Read its handoff with \`pomtree wait ${signal.child}\` (the work is on branch agent/${signal.child}), collect it, then \`pomtree reap ${signal.child}\`.`;
    if (!ctx) return sig;
    const secs = ctx.timeoutMs >= 1000 ? `${Math.round(ctx.timeoutMs / 1000)} s` : `${ctx.timeoutMs} ms`;
    const timedOut = signal.kind === "timeout";
    switch (ctx.kind) {
      case "child": {
        const c = await this.ctx.deps.registry.get(ctx.child);
        if (c && isDone(c)) {
          const h = handoffOf(c.result);
          const res = h
            ? ` Handoff: ${clipAgentText(h.summary, SIGNAL_HANDOFF_CHARS)}${Array.isArray(h.files) && h.files.length ? ` Files: ${h.files.join(", ")}.` : ""} Branch: agent/${c.id}.`
            : c.result === undefined || c.result === null
              ? ""
              : ` Result: ${clip(typeof c.result === "string" ? c.result : JSON.stringify(c.result), 2000)}`;
          return `Resumed: child ${ctx.child} exited (${c.exit ?? "unknown"}).${res}`;
        }
        return `Resumed: wait for child ${ctx.child} timed out after ${secs} (it is still ${c?.state ?? "unknown"}).`;
      }
      case "inbox":
        return timedOut
          ? `Resumed: wait for messages timed out after ${secs} (no new messages).`
          : `Resumed: a message arrived: ${sig}. Run \`pomtree inbox\` to read your queued signals.`;
      case "ask":
        return signal.kind === "human_answer"
          ? `Resumed: your question was answered: ${signal.body}`
          : `Resumed: wait for an answer timed out after ${secs}; the question is still open (a late answer will arrive in your inbox).`;
    }
  }

  // Driver.wakeResume: re-check the yielded agent's checkpoint wait against the incoming signal
  // (message/child_exited/timer) and resume only when it is satisfied.
  async wakeResume(agent: AgentId, signal: Signal): Promise<void> {
    await this.wakeResumeNow(agent, signal);
  }

  // Returns whether a resume was started.
  private async wakeResumeNow(agent: AgentId, signal: Signal): Promise<boolean> {
    const workflow = await this.ctx.deps.registry.get(agent);
    if (workflow && this.canContinue(workflow)) {
      if (workflow.state !== "yielded" || this.live.has(agent)) return false;
      const deadline = await this.budget.sessionDeadlineAt(agent);
      if (deadline !== null) this.budget.deadlines.set(agent, deadline);
      if (deadline !== null && deadline <= this.ctx.now()) {
        await this.finish(agent, "timed_out");
        return false;
      }
      const snapshot = await latestContinuation(this.ctx.deps.journal, agent);
      if (signal.kind === "approval_decided" && snapshot?.inbox.includes(`${signal.approval}:decision:${signal.state}`)) return false;
      if (!snapshot || !(await this.workflowWaitSatisfied(snapshot.wait, signal))) return false;
      await this.resumeAgent(agent, undefined, { observedGeneration: workflow.generation });
      return true;
    }
    const cp = await this.ctx.deps.checkpoints.latest(agent);
    if (!cp || !cp.wait) return false;
    const r = await this.ctx.deps.registry.get(agent);
    if (!r || r.state !== "yielded") return false;
    const ctx = await this.yieldCtx(agent, cp.id);
    {
      const done = new Set<AgentId>();
      for (const c of waitChildIds(cp.wait)) {
        const child = await this.ctx.deps.registry.get(c);
        if (child && (child.state === "exited" || child.state === "reaped")) done.add(c);
      }
      // An escalation addressed to this ancestor wakes it whatever it waits on (`satisfied` knows the escalation kind).
      const escalated = signal.kind === "escalation";
      if (!satisfied(cp.wait, { signal, childDone: (id) => done.has(id), now: this.ctx.now() })) return false;
      // An ask park is released by its answer (or its timer), not by any other message.
      if (
        !escalated &&
        ctx?.kind === "ask" &&
        signal.kind !== "timeout" &&
        this.ctx.now() < ctx.at &&
        !(signal.kind === "human_answer" && signal.escalation === ctx.escalation)
      )
        return false;
    }
    await this.resumeAgent(agent, await this.resumeText(agent, ctx, signal));
    return true;
  }

  private sessionHostDir(id: AgentId): string {
    return join(this.ctx.deps.sessionRoot, id);
  }

  private sessionMount(id: AgentId, generation: number): MountSpec {
    return { kind: "session", agent: id, containerPath: SESSION_MOUNT_DIR, generation };
  }

  private sessionFilePath(id: AgentId): string {
    return join(this.sessionHostDir(id), SESSION_FILE);
  }

  // The session dir is bind-mounted into the agent's container, so the agent controls what sits at session.jsonl: both go through
  // the harness-pi safe-open guard (a FIFO, symlink or device there is a SafeOpenError naming the path and the action, never a
  // hang, a read of a sibling's conversation, or a write through a link). A refused read is handled by stopCheckpoint.
  // TODO(session-fs): stream the session out of the container instead of reading an agent-writable path on the host.
  private async readSessionFile(id: AgentId): Promise<Uint8Array> {
    return (await safeReadFile(this.sessionFilePath(id), MAX_SESSION_BYTES)) ?? new Uint8Array(0);
  }

  // A refusal names the container path: the resume error is journaled where the agent's tree can read it.
  private async writeSessionFile(id: AgentId, bytes: Uint8Array): Promise<void> {
    mkdirSync(this.sessionHostDir(id), { recursive: true });
    try {
      await safeWriteFile(this.sessionFilePath(id), bytes);
    } catch (e) {
      if (e instanceof SafeOpenError) throw new Error(`cannot restore the session of agent ${id}: ${e.describe(PI_SESSION_PATH)}`);
      throw e;
    }
  }

  // DECIDED (session-fs): a session file the guard refuses at checkpoint time does not fail the agent. The checkpoint keeps the
  // previous checkpoint's session (an empty one when there is none), so the agent resumes from its earlier conversation, and the
  // refusal is journaled with its cause and the operator's action. Every checkpoint path (yield, completePause, forced resumes whose
  // checkpoint errors are otherwise dropped) goes through stopCheckpoint, so none loses the refusal. The agent cannot be told at
  // yield time: its container is already stopped when the session is read.
  private async refusedSession(r: AgentRecord, key: string, e: SafeOpenError): Promise<string> {
    const d = this.ctx.deps;
    const prev = await d.checkpoints.latest(r.id);
    const sessionRef = prev?.sessionRef ?? (await d.sessions.put(new Uint8Array(0)));
    const kept = prev ? `the session of the previous checkpoint ${prev.id}` : "an empty session (there is no earlier checkpoint)";
    await this.ctx
      .record(
        r,
        {
          kind: "error",
          message: `session-fs: ${e.message}. The checkpoint keeps ${kept}, so the agent resumes from that conversation; remove the entry from the agent's session directory (session.dir/${r.id}) before it resumes to keep later checkpoints current`,
        },
        `${key}:session-refused`,
      )
      .catch(journalFailed(this.ctx.record, r, "session-refused"));
    return sessionRef;
  }

  // Settle takes the claim first (while `live` still has the entry, so a reconcile tick that sees it deleted also sees the claim),
  // then the `result:<id>` lock. If the claim is taken settle proceeds without it: teardown cannot be skipped, and the generation
  // fence in settleLocked covers a stale entry.
  async settle(id: AgentId, e: Live, overBudget: boolean, gen: number): Promise<void> {
    const claim = this.tryClaim(id, "settle");
    try {
      await this.ctx.withLock(`result:${id}`, () => this.settleLocked(id, e, overBudget, gen));
    } finally {
      if (claim) this.releaseClaim(id, claim);
    }
  }

  // Exit teardown shared by settleLocked and the adopted-exit paths: unstage credentials, revoke the
  // gateway key and release the placement slot. A revoke failure is journaled (the key stays live until expiry), never thrown.
  // Idempotent; skipped when the generation moved (a newer run owns the key and slot).
  // Journals a sandbox lifecycle edge (never aborts the operation; a failure is surfaced by journalFailed). `rec` supplies the
  // host and agent; the envelope and payload carry `gen`, the generation the sandbox belonged to.
  private async journalSandbox(
    rec: AgentRecord,
    gen: number,
    phase: "started" | "exited",
    sandbox: string,
    detail: {
      exitCode?: number;
      oomKilled?: boolean;
      cause?: string;
      expected?: true;
      observedExitCode?: number;
      signal?: ExitSignal;
      stop?: "deadline" | "cancelled";
      spec?: SandboxSpecSummary;
      realized?: RunHardening;
      containerConfig?: { contract: string; values: ContainerConfigValues };
    } = {},
  ): Promise<void> {
    const at = { ...rec, generation: gen };
    await this.ctx
      .record(
        at,
        { kind: SANDBOX_LIFECYCLE_KIND, phase, sandbox, agent: rec.id, generation: gen, host: rec.host, ...detail } as never,
        `${rec.id}:${gen}:sandbox:${phase}:${sandbox}`,
      )
      .catch(journalFailed(this.ctx.record, at, `sandbox-${phase}`));
  }

  // `e` is the exiting run's live entry. Like settleYield, each id-keyed action runs only while `e` is still the agent's live entry,
  // checked directly before its call with no await between: a forced resume replaces the entry synchronously before it stages,
  // issues or admits, so a teardown it overtakes skips the rest. False = superseded (the generation moved, or the entry was
  // replaced): the newer run owns the agent, and the caller must not finish() it.
  private async teardownExit(id: AgentId, gen: number, e: Live): Promise<boolean> {
    const d = this.ctx.deps;
    const owned = () => this.live.get(id) === e;
    const cur = await d.registry.get(id).catch(() => null);
    if (cur && cur.generation !== gen) return false;
    if (!owned()) return false;
    try {
      d.credentials?.unstage(id);
    } catch (err) {
      if (cur)
        await this.ctx
          .record(cur, { kind: "error", message: `credential cleanup failed: ${String(err)}` }, `${id}:${gen}:cred-cleanup`)
          .catch(journalFailed(this.ctx.record, cur, "cred-cleanup"));
    }
    if (!owned()) return false;
    await d.gateway.revoke(id).catch(async (err) => {
      if (isStoreDown(err)) this.ctx.hub.store.markDown(err);
      if (cur)
        await this.ctx
          .record(
            cur,
            { kind: "error", message: `gateway key revoke failed (key stays live until expiry): ${String(err instanceof Error ? err.message : err)}` },
            `${id}:${gen}:revoke-failed`,
          )
          .catch(journalFailed(this.ctx.record, cur, "revoke-failed"));
    });
    if (!owned()) return false;
    await d.placement.release(id).catch(() => {});
    return true;
  }

  private async settleLocked(id: AgentId, e: Live, overBudget: boolean, gen: number) {
    const d = this.ctx.deps;
    clearTimeout(e.killTimer);
    clearTimeout(e.resultTimer);
    clearTimeout(e.interruptTimer);
    // The first registry read is guarded: a store write/read failure (ENOSPC/busy/IO) must not skip the
    // teardown below and leak a container, a placement slot and a ghost running agent (fail closed).
    let cur: AgentRecord | null = null;
    try {
      cur = await d.registry.get(id);
    } catch (err) {
      if (isStoreDown(err)) this.ctx.hub.store.markDown(err);
    }
    // Superseded by a resume: the generation moved, so this stale entry must only clean up its own
    // runtime — never finish() the resumed agent or revoke its fresh gateway key. The resumed run owns
    // the placement slot, so it is not released here.
    if (cur && cur.generation !== gen) {
      await e.session?.stop().catch(() => {});
      // No `sandbox exited` row: the journal refuses a write at the superseded generation, and a row at the current one would read
      // as the current run's exit. The resumed generation's `resumed` and `sandbox started` rows record the supersession.
      if (e.sandbox) await d.sandbox.stop(e.sandbox.id, d.graceMs).catch(() => {});
      if (this.live.get(id) === e) this.live.delete(id);
      return;
    }
    if (e.yielding) return void (await this.settleYield(id, e, gen));
    await e.session?.stop().catch(() => {});
    let cause: ExitCause | undefined = e.cause;
    let w: { exitCode: number; oomKilled?: boolean } | undefined;
    let expected = false;
    if (e.sandbox) {
      await d.sandbox.stop(e.sandbox.id, d.graceMs).catch(() => {});
      // Classify the sandbox exit: a container taken by the OOM killer (exit 137 + oomKilled) is
      // `oom_killed`; an unexplained 137/143 with no deliberate cancel by us is `host_stopped`.
      w = await e.sandbox.wait().catch(() => undefined);
      // The agent reported its result and the container then took our stop signal: an expected, clean stop (never host_stopped).
      if (w) {
        const c = classifySandboxExit({
          ...w,
          hasResult: e.result !== undefined,
          cancelled: e.cancelled,
          timedOut: e.timedOut,
          endpointUnreachable: e.endpointUnreachable,
          overBudget,
        });
        expected = c.expected;
        if (cause === undefined) cause = c.cause;
      }
      await d.registry.setSandbox(id, gen, null, `${id}:${gen}:settle-clear`).catch(() => {}); // stale generation: a newer run owns the field
      if (cur)
        await this.journalSandbox(cur, gen, "exited", e.sandbox.id, {
          ...(w && exitedDetail(w, expected)),
          ...(cause && { cause }),
          // The daemon's own stop (a deadline or a cancel) is what a bare 143 means when no cause is set.
          ...(e.timedOut ? { stop: "deadline" as const } : e.cancelled ? { stop: "cancelled" as const } : {}),
        });
    }
    // A journal-append failure leaves the exit cause journal_unwritable rather than a bare failed (fail-closed).
    if (cause === undefined && this.ctx.hub.store.journalFailed()) cause = "journal_unwritable";
    // Superseded during the stop or the teardown (a forced resume replaced the entry or moved the generation): the newer run owns
    // the agent, so never finish() it, like the superseded branch above.
    if (!(await this.teardownExit(id, gen, e))) return;
    // An operator interrupt aborted the Pi process (clean exit without settling, 143, or the grace backstop's kill): that is
    // INTERRUPTED, not failed. Checkpoint and resume immediately (ahead of other resumes); the resumed run delivers the message.
    if (e.interrupt && !e.cancelled && !e.timedOut && !e.result && !overBudget && (cause === undefined || cause === "host_stopped")) {
      if (this.live.get(id) === e) this.live.delete(id);
      if (await this.resumeInterrupted(id, gen)) return;
      this.live.set(id, e);
    }
    // A Docker restart or OOM stopped a checkpointed agent that reported nothing: resume it
    // (bounded by maxRestarts) instead of failing it and cascading to its children.
    if ((cause === "host_stopped" || cause === "oom_killed") && !e.cancelled && !e.timedOut && !e.result && !overBudget) {
      if (this.live.get(id) === e) this.live.delete(id);
      const auto = await this.tryAutoRestart(id, gen, cause);
      if (auto === true) return;
      if (auto === "exhausted") cause = "restart_exhausted";
      this.live.set(id, e);
    }
    const exitStatus: ExitStatus = e.timedOut
      ? "timed_out"
      : e.result && !overBudget
        ? e.result.status
        : e.cancelled
          ? "cancelled"
          : overBudget
            ? "over_budget"
            : "failed";
    const result = e.result && !overBudget ? e.result.result : undefined;
    // Record why a run ended with no result, cancel or budget fault, so a mute failure is distinguishable from a crash.
    // A result the agent itself recorded as failed (its own choice) is not a mute exit.
    if (exitStatus === "failed" && cause === undefined && e.settled && e.result === undefined) {
      // A worker whose last tool failed with a closed cause did record why it could not finish: say that, not that it was silent.
      const toolCause = cur ? lastToolFailureCause(await d.journal.read({ agent: id }).catch(() => [])) : null;
      const message =
        toolCause !== null
          ? `agent ended after a failed tool call (cause=${toolCause}) without a result (exit ${w?.exitCode ?? "?"}, settled=${e.settled})`
          : `agent ended without reporting a result (exit ${w?.exitCode ?? "?"}, settled=${e.settled})`;
      if (cur) await this.ctx.record(cur, { kind: "error", message }, `${id}:${gen}:silent-exit`).catch(journalFailed(this.ctx.record, cur, "silent-exit"));
    }
    try {
      await this.finish(id, exitStatus, result, cause);
    } catch (err) {
      // A non-fence throw (journal/mailbox/store) must not strand the agent running with its sandbox
      // already stopped: mark a store outage, fall back to a best-effort failed finish, and only then
      // drop the live handle.
      if (isStoreDown(err)) this.ctx.hub.store.markDown(err);
      await this.finish(id, "failed", undefined, cause).catch(() => {});
      throw err;
    } finally {
      if (this.live.get(id) === e) this.live.delete(id);
    }
  }

  // Automatic restarts used so far: `error` entries with the AUTO_RESTART prefix after the agent's latest RESTART_RESET marker
  // (an operator resume), across all generations. A lifetime count otherwise (maxRestarts is not windowed).
  // TODO(restart-window): maxRestarts is not windowed; reopen when a long-lived agent is failed by restart exhaustion.
  async restartCount(id: AgentId): Promise<number> {
    const rows = await this.ctx.deps.journal.read({ agent: id });
    let n = 0;
    for (const r of rows) {
      const m = r.payload.kind === "error" ? (r.payload as { message?: string }).message : undefined;
      if (m?.startsWith(RESTART_RESET)) n = 0;
      else if (m?.startsWith(AUTO_RESTART)) n++;
    }
    return n;
  }

  // Settle's restart paths decided on generation `gen` before their checkpoint write; an operator or watchdog resume that completed
  // inside that window already restarted the agent (true = leave it alone; the caller must not finish it). Compared on the generation,
  // not on the claim's `preempted` flag: a resume that merely started (and was refused, e.g. a plain resume of a running agent) sets
  // `preempted` too, and trusting it would strand the agent. A resume still in flight is shared by the caller's own resumeAgent.
  private async superseded(id: AgentId, gen: number): Promise<boolean> {
    const cur = await this.ctx.deps.registry.get(id);
    return !cur || cur.state !== "running" || cur.generation !== gen;
  }

  // Resume a checkpointed running agent whose container a host fault took (Docker restart/OOM), within maxRestarts.
  // The caller has already torn down the runtime. False = not eligible; the caller finishes. "exhausted" = a checkpointed agent
  // whose maxRestarts is spent; the caller finishes it failed with cause restart_exhausted.
  private async tryAutoRestart(id: AgentId, gen: number, cause: ExitCause): Promise<boolean | "exhausted"> {
    try {
      const r = await this.ctx.deps.registry.get(id);
      if (!r || r.state !== "running" || r.generation !== gen || r.host !== this.ctx.deps.hostId || this.ctx.hub.store.draining()) return false;
      // A dead container is paused like a yield and resumed in its own folder: the folder keeps uncommitted edits, the
      // session file keeps the conversation. Needs the folder, and something to resume (a checkpoint or a session).
      if (!(await this.ctx.deps.workspace.has(id)) || (await this.reconciler.isQuarantined(r))) return false;
      // A refused session file counts as no session here (stopCheckpoint journals the refusal when it checkpoints).
      const session = await this.readSessionFile(id).catch((e) => (e instanceof SafeOpenError ? new Uint8Array(0) : Promise.reject(e)));
      if (!(await this.ctx.deps.checkpoints.latest(id)) && session.length === 0) return false;
      const res = await this.forceResume(r, gen, "host_fault", {
        restartReason: `resuming after ${cause}`,
        wake: `your container was stopped (${cause}); resuming from your last checkpoint`,
      });
      if (res !== "exhausted") return true;
      return (await this.ctx.deps.checkpoints.latest(id)) ? "exhausted" : false;
    } catch {
      // The checkpoint write fails when a resume already moved the generation past it; that is the same supersession.
      return await this.superseded(id, gen).catch(() => false);
    }
  }

  // Yield teardown: stop the runtime and release every runtime resource WITHOUT finish()/exited.
  // The unstage, revoke and release are keyed by agent id only, so each runs only while `e` is still the agent's live entry. A wake
  // that lands at `yielded`, while this teardown is still stopping the container, makes runResumed replace the entry synchronously
  // before it stages, issues or admits anything; each check here is adjacent to its call with no await between, so a teardown that
  // outlives the resume skips them and the resumed run keeps its credentials, key and slot (it revokes the old key and restages
  // itself). A generation check would not close this: the registry read is an await before the act.
  private async settleYield(id: AgentId, e: Live, gen: number) {
    const d = this.ctx.deps;
    const owned = () => this.live.get(id) === e;
    e.yieldSettled = true;
    clearTimeout(e.killTimer);
    clearTimeout(e.resultTimer);
    clearTimeout(e.interruptTimer);
    await e.session?.stop().catch(() => {});
    if (e.sandbox) {
      await d.sandbox.stop(e.sandbox.id, d.graceMs).catch(() => {});
      await d.registry.setSandbox(id, gen, null, `${id}:${gen}:yield-clear`).catch(() => {});
      const yr = await d.registry.get(id).catch(() => null);
      // A resume that overtook this teardown already moved the generation: the journal refuses a write at `gen`, so skip it.
      if (yr && yr.generation === gen) await this.journalSandbox(yr, gen, "exited", e.sandbox.id, { cause: "yielded" });
    }
    if (owned()) {
      try {
        d.credentials?.unstage(id);
      } catch (err) {
        const r = await d.registry.get(id).catch(() => null);
        if (r)
          await this.ctx
            .record(r, { kind: "error", message: `credential cleanup failed: ${String(err)}` }, `${id}:${gen}:cred-cleanup`)
            .catch(journalFailed(this.ctx.record, r, "cred-cleanup"));
      }
    }
    await e.yieldGate; // the yield's checkpoint reads spend; revoke only after it has landed
    if (owned()) await d.gateway.revoke(id).catch(() => {});
    if (owned()) await d.placement.release(id).catch(() => {});
    if (owned()) this.live.delete(id);
    // An interrupt raced the yield: it must not be lost, so wake the now-parked agent with it. A resume already in flight (the
    // yield's own timer, a message wake) makes this a no-op; that run's takeInterrupts delivers the message.
    if (e.interrupt) await this.resumeWithInterrupts(id, "woke").catch(() => {});
    // A budget decision that landed while the agent was still parking (the yield returns ~400 ms before this teardown ends).
    await this.ctx.hub.budget.applyDecision(id);
  }

  // No-op (changed=false) if the agent already exited; the first exit wins.
  async finish(id: AgentId, exit: ExitStatus, result?: unknown, cause?: ExitCause): Promise<{ record: AgentRecord | null; changed: boolean }> {
    const d = this.ctx.deps;
    const firedDeadline = this.budget.deadlines.get(id);
    this.budget.deadlines.delete(id);
    this.budget.deadlineLoaded.delete(id);
    let r = await d.registry.get(id);
    if (!r) return { record: null, changed: false };
    if (r.state === "exited" || r.state === "reaped") return { record: r, changed: false };
    // The one place every timed_out exit passes: journal which deadline fired and the action, so the trace and the operator see it.
    if (exit === "timed_out")
      await this.ctx
        .record(r, { kind: "error", message: timedOutMessage(id, r.state, firedDeadline) }, `${id}:${r.generation}:timed-out`)
        .catch(journalFailed(this.ctx.record, r, "timed-out"));
    result = await this.withHandoff(r, exit, result, cause);
    let upd: AgentRecord;
    try {
      // pending -> exited is not a legal edge; a never-started agent passes through running.
      if (r.state === "pending") r = await d.registry.transition(id, r.generation, "running", { idempotencyKey: transitionKey(id, r.generation, "running") });
      if (!this.live.has(id) && r.executor === "container") await this.reconciler.reclaimSandbox(r);
      upd = await d.registry.transition(id, r.generation, "exited", {
        exit,
        result,
        exitCause: cause,
        idempotencyKey: transitionKey(id, r.generation, "exited"),
      });
    } catch (e) {
      if (!(e instanceof IllegalTransitionError || e instanceof StaleGenerationError)) {
        if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
        throw e;
      }
      return { record: await d.registry.get(id), changed: false }; // lost the race to another finisher
    }
    // The finished agent's retry ladder is over (a resume to fix a merge conflict starts a new one). Not awaited before the
    // exit lands, so the first finisher's exit wins as before. A failed clear does not block the exit, but the durable count stays:
    // a later resume's ladder reads it (bumpProviderAttempts, against maxProviderRetries) and starts partway up, until a successful
    // usage event resets it. So log the failure and its consequence.
    await d.registry.resetProviderAttempts(id).catch((e: unknown) => {
      console.error(
        `pomtreed: agent ${id}: could not reset the provider-attempt count after exit (${e instanceof Error ? e.message : String(e)}); a stale count may make its next run reach the provider retry cap early, so check the store`,
      );
    });
    await this.finishTail(upd, exit, cause);
    return { record: upd, changed: true };
  }

  // Every exit carries a non-empty handoff: the agent's own, or a short system one for exits it did not complete itself.
  private async withHandoff(r: AgentRecord, exit: ExitStatus, result: unknown, cause?: ExitCause): Promise<unknown> {
    if (handoffOf(result) !== null) return result;
    const spent = await this.tree.spentOf(r).catch(() => null);
    const money = spent === null ? "" : ` after ${usd(spent)} of ${usd(r.budgetMicros)}`;
    const why = cause !== undefined ? ` (${cause})` : "";
    const what = cause !== undefined ? `; ${EXIT_CAUSE_WORDING[cause]}` : "";
    if (r.executor === "deterministic") {
      // No workspace folder and no branch exist for a deterministic task; the container wording below is unchanged.
      const text =
        exit === "succeeded" ? `Child ${r.id} finished without writing a handoff.` : `Child ${r.id} ended ${exit}${why}${what}; no handoff was written.`;
      const base = result !== null && typeof result === "object" && !Array.isArray(result) ? result : result === null || result === undefined ? {} : { result };
      return { ...base, summary: text, synthesized: true };
    }
    const merged = exit === "succeeded" ? "" : " (not merged)";
    const summary =
      exit === "succeeded"
        ? `Child ${r.id} finished without writing a handoff; its workspace folder is kept, but only work it pushed is on branch agent/${r.id}.`
        : `Child ${r.id} ended ${exit}${why}${money}${what}; no handoff was written; its workspace folder is kept${merged}; only work it pushed is on branch agent/${r.id}.`;
    const base = result !== null && typeof result === "object" && !Array.isArray(result) ? result : result === null || result === undefined ? {} : { result };
    return { ...base, summary, synthesized: true };
  }

  // The idempotent steps after the exited transition. Safe to re-run: recover() replays them for an
  // agent that crashed between the transition and the tail (journal, notify, cancel, reap).
  async finishTail(upd: AgentRecord, exit: ExitStatus, cause?: ExitCause): Promise<void> {
    const d = this.ctx.deps;
    const reported = await this.reportedResult(upd);
    if (reported) await this.notifyResult(upd, reported.status, reported.result);
    await this.ctx.record(upd, { kind: "exited", exit, ...(cause !== undefined && { cause }) }, `${upd.id}:${upd.generation}:exited`);
    await d.watchdogs.clear(upd.id); // the ladder is per-running-agent; a finished agent is no longer watched
    if (upd.parent) await this.notifyParent(upd, exit, cause);
    await this.cancelChildren(upd);
    if (!upd.parent) return;
    if (upd.parent === (await this.tree.rootAgentId())) return void (await this.reap(upd.id)); // the root supervisor cannot reap later
    // A non-root parent that is gone cannot reap either; the result is held for the nearest live ancestor, never reaped for it.
    const parent = await d.registry.get(upd.parent);
    const advisory = this.reapsOnExit(upd);
    if (!parent || isDone(parent)) {
      await this.holdForCustodian(upd, { advisory });
      if (advisory) await this.reap(upd.id);
    } else if (advisory) await this.reap(upd.id); // the live parent already got child_exited with the clipped handoff
  }

  // A parent-declared reap-on-exit result (SpawnSpec.disposition). Deterministic agents carry no disposition and stay hold.
  private reapsOnExit(a: AgentRecord): boolean {
    return a.executor === "container" && a.spec.disposition?.mode === "reap-on-exit";
  }

  private async exitSignal(child: AgentRecord, exit: ExitStatus, cause?: ExitCause): Promise<Extract<Signal, { kind: "child_exited" }>> {
    const h = handoffOf(child.result);
    const files = h && Array.isArray(h.files) ? h.files.filter((f): f is string => typeof f === "string").slice(0, 50) : [];
    const spent = await this.tree.spentOf(child).catch(() => undefined);
    return {
      kind: "child_exited",
      child: child.id,
      exit,
      ...(cause !== undefined && { cause }),
      ...(h && { handoff: clipAgentText(h.summary, SIGNAL_HANDOFF_CHARS) }),
      ...(child.executor === "container" && { branch: `agent/${child.id}` }),
      ...(spent !== undefined && { spentMicros: spent }),
      budgetMicros: child.budgetMicros,
      ...(files.length && { files }),
    };
  }

  // Failure is pushed to the child's parent (its owner).
  private async notifyParent(child: AgentRecord, exit: ExitStatus, cause?: ExitCause) {
    const ownerId = child.parent;
    if (!ownerId) return;
    const signal = await this.exitSignal(child, exit, cause);
    const owner = await this.ctx.deps.registry.get(ownerId);
    // The store rejects signals to unknown or reaped agents; an owner that is already
    // reaped can neither read nor be woken, so skip the mailbox send (and the wake) instead of throwing.
    if (!owner || owner.state === "reaped") return;
    // per generation: a child resumed to fix a merge exits again
    if (!(await this.messaging.toMailbox(child, ownerId, signal, `${child.id}:${child.generation}:child_exited`))) return;
    await this.ctx.record(owner, { kind: "signal", signal }, `${child.id}:${child.generation}:child_exited:journal`);
    // Wake a yielded owner whose wait condition is satisfied by this child exit. A throwing wake
    // (e.g. a 409 surfaced after delivery) must not abort finishTail's cancelChildren/reap steps.
    try {
      await this.ctx.deps.orchestrator.wake(ownerId, signal);
    } catch (e) {
      await this.ctx
        .record(owner, { kind: "error", message: `wake of ${ownerId} failed: ${String(e instanceof Error ? e.message : e)}` }, `${child.id}:wake-error`)
        .catch(journalFailed(this.ctx.record, owner, "wake-error"));
    }
  }

  // An exited agent whose parent is gone becomes a zombie of its custodian (the nearest live ancestor), who is told once per
  // (generation, custodian) and reaps it by hand; nothing reaps it for them. A root custodian is the operator: delivery is a
  // user message, and past rootCustodyMax each further one is also raised as an alert. The ops marker is the durable record
  // of the transfer; the replay (every reconcile pass reruns finishTail) is one journal scan of the zombie (ops.seen pages its journal).
  // `advisory` (the child declared reap-on-exit) changes the wording to "reaped on exit" and skips the queue bound and the no-channel
  // warning, which apply only to results actually held; the caller reaps afterwards.
  private async holdForCustodian(z0: AgentRecord, opts: { advisory: boolean } = { advisory: false }): Promise<void> {
    const d = this.ctx.deps;
    const z = await d.registry.get(z0.id);
    if (!z || z.state !== "exited") return;
    const custodian = await this.tree.custodian(z);
    if (custodian.id === z.parent) return; // a live parent holds it
    const opKey = `${z.generation}:${custodian.id}`;
    if (await this.ctx.hub.ops.seen(z.id, "custody", opKey)) return;
    const signal = { ...(await this.exitSignal(z, z.exit ?? "failed", z.exitCause)), ...(z.parent !== null && { custodyOf: z.parent }) };
    const key = `${z.id}:${z.generation}:custody:${custodian.id}`;
    const rootId = await this.tree.rootAgentId();
    if (custodian.id === rootId) {
      // Not toMailbox: its relay is the bare exit line, which would not say why the user is getting it or what to do.
      const subject = statusSubject({
        id: signal.child,
        exit: signal.exit,
        ...(signal.cause !== undefined && { cause: signal.cause }),
        // clipped so the toUser cap cannot cut off the action below
        ...(signal.handoff !== undefined && { handoff: clipText(signal.handoff, 1200) }),
        ...(signal.spentMicros !== undefined && { spentMicros: signal.spentMicros }),
        ...(signal.budgetMicros !== undefined && { budgetMicros: signal.budgetMicros }),
        ...(signal.branch !== undefined && { branch: signal.branch }),
      });
      if (!opts.advisory && !this.messaging.hasUserChannel())
        await this.ctx
          .record(
            z,
            {
              kind: "error",
              message: `custody: held for the operator, but no user channel is configured, so nobody was told; read it with \`pomtree show ${z.id}\`, then \`pomtree reap ${z.id}\`; configure an escalation channel to be told`,
            },
            `${key}:no-channel`,
          )
          .catch(journalFailed(this.ctx.record, z, "custody-no-channel"));
      await this.ctx.hub.user.sendToUser(
        z,
        "status",
        opts.advisory
          ? `${subject} | reaped on exit (disposition reap-on-exit): parent ${z.parent} is gone; its record and result stay readable with \`pomtree show ${z.id}\``
          : `${subject} | held for the operator: parent ${z.parent} is gone; read it with \`pomtree show ${z.id}\`, then \`pomtree reap ${z.id}\``,
        key,
      );
      if (opts.advisory) return void (await this.ctx.hub.ops.mark(z, "custody", opKey, { delivered: custodian.id }));
      const held = await this.rootCustodyCount(rootId, z);
      const max = this.ctx.limits.rootCustodyMax;
      if (held > max) {
        const message = `custody queue full: ${held} exited results are held for the operator (limit ${max}); ${z.id} (parent ${z.parent} is gone) is one: read it with \`pomtree show ${z.id}\`, then \`pomtree reap ${z.id}\``;
        await this.ctx.record(z, { kind: "error", message }, `${key}:full:journal`).catch(journalFailed(this.ctx.record, z, "custody-full"));
        await this.ctx.hub.user.sendToUser(z, "alert", message, `${key}:full`);
      }
    } else if (await this.messaging.toMailbox(z, custodian.id, signal, key)) {
      await this.ctx.record(custodian, { kind: "signal", signal }, `${key}:journal`);
      try {
        await d.orchestrator.wake(custodian.id, signal);
      } catch (e) {
        await this.ctx
          .record(
            custodian,
            { kind: "error", message: `wake of ${custodian.id} failed (custody of ${z.id}): ${String(e instanceof Error ? e.message : e)}` },
            `${z.id}:${z.generation}:custody-wake-error:${custodian.id}`,
          )
          .catch(journalFailed(this.ctx.record, custodian, "custody-wake-error"));
      }
    }
    await this.ctx.hub.ops.mark(z, "custody", opKey, { delivered: custodian.id });
  }

  // Delivery-order count of results held for the operator: those already delivered (custody ops marker set) plus `current`, so the
  // Nth delivery is "past the cap" only when N > rootCustodyMax, whatever the burst order. Siblings exited but not yet delivered are not counted.
  private async rootCustodyCount(rootId: AgentId, current: AgentRecord): Promise<number> {
    let n = 1;
    for (const a of await this.ctx.deps.registry.list({ state: "exited" }))
      if (
        a.id !== current.id &&
        a.parent !== rootId &&
        !this.reapsOnExit(a) &&
        (await this.tree.custodian(a)).id === rootId &&
        (await this.ctx.hub.ops.seen(a.id, "custody", `${a.generation}:${rootId}`))
      )
        n++;
    return n;
  }

  // Structured concurrency: no child outlives its parent; orphans are cancelled with a grace period, then killed.
  // A yielded child has no live process: stop() finishes it directly (finishTail then orphans its own children).
  // A dead parent's exited descendants are not reaped: custody moves up to the nearest live ancestor, so the walk goes through
  // the exited subtree (an exited grandchild whose custodian was this parent now moves up). Custody is derived, never stored.
  // It does not descend into reaped nodes (that would walk the whole reaped history on every exit): an exited descendant under a
  // reaped node is still reached by the reconcile pass, whose exited-tails phase reruns finishTail for every exited agent.
  private async cancelChildren(parent: AgentRecord) {
    const kids = await this.ctx.deps.registry.list({ parent: parent.id });
    await this.orphanChildren(
      parent,
      kids.filter((c) => !isDone(c)),
    ); // first: no child outlives its parent even when a custody hold below fails
    const seen = new Set<AgentId>([parent.id]);
    const walk = async (children: AgentRecord[]): Promise<void> => {
      for (const c of children) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (c.state === "exited") {
          // One child's failed hold must not stop the others, and (the orphan cancel ran first) never a live child.
          const advisory = this.reapsOnExit(c);
          await this.holdForCustodian(c, { advisory })
            .then(() => (advisory ? this.reap(c.id) : undefined))
            .catch((e) =>
              this.ctx
                .record(
                  parent,
                  {
                    kind: "error",
                    message: `custody of ${c.id} was not delivered: ${String(e instanceof Error ? e.message : e)}; the next reconcile pass retries it (exited-tails reruns its finishTail)`,
                  },
                  `${c.id}:${c.generation}:custody-error`,
                )
                .catch(journalFailed(this.ctx.record, parent, "custody-error")),
            );
          await walk(await this.ctx.deps.registry.list({ parent: c.id }));
        }
      }
    };
    await walk(kids);
  }

  // Cancel each still-live child of a dead/exiting parent: a grace period, then kill.
  async orphanChildren(parent: AgentRecord, open: AgentRecord[]) {
    const d = this.ctx.deps;
    for (const c of open) {
      try {
        await d.orchestrator.cancel(c.id, d.graceMs);
      } catch (e) {
        await this.ctx
          .record(parent, { kind: "error", message: `orphan cancel of ${c.id} failed: ${String(e)}` }, `${c.id}:orphan-cancel-error`)
          .catch(journalFailed(this.ctx.record, parent, "orphan-cancel-error"));
      }
    }
  }
}

// Endings of adapter start-failure messages that already name their own operator action (the docker-group fix, an image rebuild,
// which ends "then restart pomtreed", or a respawn). Appending the cause's generic action to one of those gives two contradictory
// actions, e.g. the docker-group fix followed by "start Docker".
const OWN_ACTION = [DOCKER_GROUP_ACTION, "then restart pomtreed", "then respawn the agent"];

// A container start failure, classified: the exit cause (core START_FAILURE_CAUSE), whether the Docker engine itself is down, and
// the journal text naming the kind, whether a retry could help, and exactly one action. Null for any other error.
export function startFailure(e: unknown): { cause: ExitCause; engineDown: boolean; message: string } | null {
  if (e instanceof SandboxStartError) {
    const cause = START_FAILURE_CAUSE[e.kind];
    const text = clipText(e.message, 1000);
    const action = OWN_ACTION.some((a) => text.includes(a)) ? "" : `; ${EXIT_CAUSE_WORDING[cause]}`;
    return {
      cause,
      // A docker socket permission error is endpoint_unreachable too, and it also holds admission on purpose: the daemon is up
      // but every start fails the same way until the operator fixes access, and the health probe's sandbox.list fails the same
      // way, so admission resumes only once access works (doctor names the docker-group fix for sandboxUp=false).
      engineDown: e.kind === "endpoint_unreachable",
      message: `sandbox start failed (kind=${e.kind}, retryable=${e.retryable}): ${text}${action}`,
    };
  }
  if (e instanceof SandboxUnavailableError)
    return { cause: "sandbox_unavailable", engineDown: true, message: `sandbox start failed (kind=unavailable): ${EXIT_CAUSE_WORDING.sandbox_unavailable}` };
  return null;
}

// The operator-facing reason a provider error stopped the run at once; the provider's own message is clipped into `auth` and `config`.
// TODO(provider-error-redact): the clipped provider text is journaled unredacted (redaction happens only when the trace is rendered).
export function providerStopMessage(code: "auth" | "funding" | "config", message = ""): string {
  if (code === "auth")
    return `provider auth: the model provider rejected the API key (${clipText(message, 200)}); check the key file named by POMTREED_MODEL_UPSTREAM_KEY_FILE, then respawn the agent`;
  return code === "funding"
    ? "provider funding: the model provider account is out of credits; add credits with the provider, then resume or respawn the agent"
    : "provider config: the model provider rejected the request (wrong base URL or model id); check POMTREED_MODEL_BASE_URL and the model, then respawn the agent";
}

// The operator-facing reason the retry ladder gave up (`attempts` consecutive failed calls).
export function providerExhaustedMessage(attempts: number, code: string, message: string): string {
  return `provider retries exhausted: ${attempts} attempts failed (last: ${code}: ${clipText(message, 200)}); check the provider's status and POMTREED_MODEL_BASE_URL, then respawn the agent`;
}

const TIMED_OUT_PREFIX = "timed out: ";

// When the session deadline passed and what to do; a parked (yielded) agent is said to have been waiting when it passed.
export function timedOutMessage(id: string, state: string, deadlineAt: number | undefined): string {
  const at = deadlineAt === undefined ? "" : ` at ${new Date(deadlineAt).toISOString()}`;
  const parked = state === "yielded" ? " while it was parked on a wait" : "";
  return `${TIMED_OUT_PREFIX}its session deadline passed${at}${parked}; ${deadlineAction(id)}`;
}

// The error entries a terminal exit journals (the provider stops, retries exhausted, a passed deadline): they say why the run
// ended, not that a live run is failing, so the watchdog's recentFailures does not count them (sweeps.ts watchdogSnapshot).
const TERMINAL_EXIT_PREFIXES = ["provider auth: ", "provider funding: ", "provider config: ", "provider retries exhausted: ", TIMED_OUT_PREFIX];
export function isTerminalExitMessage(message: string): boolean {
  return TERMINAL_EXIT_PREFIXES.some((p) => message.startsWith(p));
}
