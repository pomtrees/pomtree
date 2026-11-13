import { createHash } from "node:crypto";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentId,
  AgentRecord,
  AgentState,
  Approval,
  ApprovalDecision,
  ApprovalId,
  ApprovalKind,
  ApprovalRank,
  ApprovalState,
  ApprovalStore,
  Checkpoint,
  CheckpointStore,
  Escalation,
  EscalationId,
  EscalationState,
  EscalationStore,
  ExitCause,
  ExtensionGateway,
  ExtensionResult,
  ExtensionSpec,
  ExitStatus,
  Harness,
  HarnessEvent,
  HarnessSession,
  HostId,
  HostRecord,
  HostState,
  HostStore,
  Journal,
  JournalEntry,
  JournalSpend,
  Delivered,
  DeterministicExecutor,
  DeterministicOps,
  DeterministicRunContext,
  ExecutorReapReceipt,
  ExecutorSpawnRequest,
  ForcedRefUpdate,
  Handoff,
  JsonValue,
  Mailbox,
  MessagingSender,
  MessageTarget,
  IngestResult,
  PruneResult,
  ModelGateway,
  MountProvider,
  MountSpec,
  NewHost,
  NewReservation,
  ResolvedMount,
  Reservation,
  Resources,
  WorkspaceId,
  NewAgent,
  NewApproval,
  NewApprovalDecision,
  NewEscalation,
  NewJournalEntry,
  NewReport,
  Orchestrator,
  Placement,
  PlacementStatus,
  Registry,
  Report,
  ReportId,
  ReportStore,
  ImageIdentity,
  ProbeResult,
  Sandbox,
  SandboxCapability,
  SandboxDeclaration,
  SandboxFacets,
  SandboxChannel,
  SandboxHandle,
  SandboxBackendId,
  SandboxId,
  SandboxListing,
  SandboxOwner,
  SandboxSpec,
  ByteStream,
  LoopbackPort,
  TerminalClose,
  TerminalSession,
  Schedule,
  ScheduleId,
  ScheduleStore,
  SessionStore,
  Signal,
  SignalId,
  SpawnSpec,
  Subscription,
  Template,
  TemplateId,
  TemplateStore,
  WaitCondition,
  WatchdogState,
  WatchdogStore,
  Workspace,
  CheckResult,
  CheckRunner,
  DurableModelDebitStore,
  GatewayCredential,
  MergeId,
  MergeRecord,
  MergeReport,
  MergeRequest,
  MergeResult,
  MergeStatus,
  MergeStatusState,
  MergeStep,
  MergeStore,
  NewMergeRecord,
  Repo,
  RepoId,
  RepoStore,
  StateDoc,
  StateKey,
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
  StateFence,
  StateWriter,
} from "@pomtree/core";
import {
  LOOPBACK_PORTS,
  applyDecision,
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
  CHECKPOINT_FORMAT,
  canonical,
  decodeGatewayCredential,
  encodeGatewayCredential,
  IdempotencyConflictError,
  assertImageArtifactFence,
  replayOfImageArtifact,
  checkImageArtifact,
  imageArtifactSlot,
  type ImageArtifact,
  type ImageArtifacts,
  IllegalTransitionError,
  isLevelKind,
  JOURNAL_PRUNABLE_KINDS,
  LEGAL_TRANSITIONS,
  mergeSettled,
  newAgentExecutor,
  rankOfRung,
  rungsAbove,
  sameMergeRequest,
  SandboxOutcomeUnknownError,
  SandboxTransferError,
  SandboxUnavailableError,
  sandboxIdForKey,
  SANDBOX_CAPABILITIES,
  FACET_OF,
  checkProbe,
  validateDeclaration,
  ownerStampTags,
  STATE_LIMITS_DEFAULT,
  StaleGenerationError,
  sandboxBackendAfter,
  StateError,
  stateWriterId,
  budgetLedger,
  POMTREED_KINDS,
  RootWithdrawalError,
  validDebitMicros,
  validDebitRequestId,
  validWorkflowState,
  validWorkflowWait,
  verifyGatewayCredential,
  waitChildIds,
} from "@pomtree/core";
import type {
  AgentLedger,
  CredentialCheck,
  LedgerNode,
  ModelCallMeta,
  PublishReview,
  QuotaCounters,
  RequestReservation,
  ReserveResult,
  SettleResult,
} from "@pomtree/core";
import { FakeCaptureIndex, FakeCaptureParser } from "./capture-fakes.ts";
import { FaultPlan, preemptedError } from "./sandbox-faults.ts";
import type { FaultOp } from "./sandbox-faults.ts";

export interface Call {
  port: string;
  method: string;
  args: unknown[];
}
export type CallLog = Call[];

export interface Script {
  harnessEvents?: Record<AgentId, HarnessEvent[]>;
  sandboxExitCodes?: number[]; // consumed in order, default 0
  sandboxStop?: SandboxStop; // FakeSandbox.stop() exit semantics; default "graceful" (exit 0)
  sandboxOptions?: FakeSandboxOptions; // declaration overrides, facets and probe for FakeSandbox
  placement?: (req: {
    agent: AgentId;
    priority: number;
    resources?: Resources;
    template?: TemplateId;
    affinity?: { host?: HostId };
  }) => { host: HostId } | { queued: true; reason?: string };
  placementStatus?: () => PlacementStatus | PlacementStatus[];
  placementMaxConcurrent?: number;
  templates?: Template[];
  host?: HostId;
  now?: () => number;
  strictMailboxTargets?: boolean; // FakeMailbox rejects unknown/reaped targets like the store
  stateLimits?: (owner: StateOwner) => StateLimits; // FakeStateStore quotas; default STATE_LIMITS_DEFAULT
}

function wrap<T extends object>(port: string, impl: T, calls: CallLog): T {
  return new Proxy(impl, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function" || typeof p !== "string") return v;
      return (...args: unknown[]) => {
        calls.push({ port, method: p, args });
        return v.apply(t, args);
      };
    },
  });
}

class Queue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

export class FakeJournal implements Journal {
  entries: JournalEntry[] = [];
  private keys = new Map<string, JournalEntry>();
  private usageKeys = new Map<string, JournalEntry>();
  private subs = new Set<{ agent?: AgentId; q: Queue<JournalEntry> }>();
  private now: () => number;
  private registry?: FakeRegistry;
  private nextSeq = 1;
  private spend = new Map<AgentId, JournalSpend>();
  // Latest checkpoint createdAt per agent (wired by createFakes); rows at/after it are kept by pruneJournal.
  checkpointFloor: (agent: AgentId) => number | null = () => null;
  constructor(now: () => number, registry?: FakeRegistry) {
    this.now = now;
    this.registry = registry;
  }
  async spendFor(agent: AgentId): Promise<JournalSpend> {
    return { ...(this.spend.get(agent) ?? { costMicros: 0, unpricedInputTokens: 0, unpricedOutputTokens: 0, events: 0 }) };
  }
  async pruneJournal(o: { olderThanMs: number; keepPerAgent: number; kinds?: string[]; protectKinds?: string[] }): Promise<{ deleted: number }> {
    const protect = new Set(o.protectKinds ?? []);
    const kinds = new Set((o.kinds ?? [...JOURNAL_PRUNABLE_KINDS]).filter((k) => !protect.has(k)));
    const cutoff = this.now() - Math.max(0, o.olderThanMs);
    const keep = Math.max(0, Math.floor(o.keepPerAgent));
    const rank = new Map<number, number>(); // seq -> 1-based rank from newest within its agent
    const seen = new Map<AgentId, number>();
    for (const e of [...this.entries].reverse()) {
      const n = (seen.get(e.agent) ?? 0) + 1;
      seen.set(e.agent, n);
      rank.set(e.seq, n);
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      const floor = this.checkpointFloor(e.agent);
      const prune = e.ts < cutoff && kinds.has(e.payload.kind) && rank.get(e.seq)! > keep && (floor === null || e.ts < floor);
      return !prune;
    });
    return { deleted: before - this.entries.length };
  }
  async append(e: NewJournalEntry): Promise<JournalEntry> {
    const prior = this.keys.get(e.idempotencyKey);
    if (prior) return structuredClone(prior);
    const a = this.registry?.agents.get(e.agent);
    if (!a) throw new Error(`unknown agent ${e.agent}`);
    if (a.generation !== e.generation) throw new StaleGenerationError(e.agent, e.generation, a.generation);
    const usageKey = e.payload.kind === "usage" && e.payload.requestId !== undefined ? JSON.stringify([e.agent, e.payload.requestId]) : undefined;
    const usage = usageKey !== undefined ? this.usageKeys.get(usageKey) : undefined;
    if (usage) {
      this.keys.set(e.idempotencyKey, usage);
      return structuredClone(usage);
    }
    const { idempotencyKey, ...rest } = e;
    const entry: JournalEntry = { ...rest, seq: this.nextSeq++, ts: this.now() };
    this.entries.push(entry);
    if (entry.payload.kind === "usage") {
      const p = entry.payload;
      // A null cost (the harness reported none) is unpriced like a zero cost with tokens, as in store-sqlite.
      const u = (p.costMicros === null || p.costMicros === 0) && (p.inputTokens > 0 || p.outputTokens > 0);
      const cur = this.spend.get(e.agent) ?? { costMicros: 0, unpricedInputTokens: 0, unpricedOutputTokens: 0, events: 0 };
      this.spend.set(e.agent, {
        costMicros: cur.costMicros + (u ? 0 : (p.costMicros ?? 0)),
        unpricedInputTokens: cur.unpricedInputTokens + (u ? p.inputTokens : 0),
        unpricedOutputTokens: cur.unpricedOutputTokens + (u ? p.outputTokens : 0),
        events: cur.events + 1,
      });
    }
    this.keys.set(idempotencyKey, entry);
    if (usageKey !== undefined) this.usageKeys.set(usageKey, entry);
    for (const s of this.subs) if (!s.agent || s.agent === entry.agent) s.q.push(structuredClone(entry));
    return structuredClone(entry);
  }
  async read(o: { from?: number; agent?: AgentId; limit?: number }): Promise<JournalEntry[]> {
    const r = this.entries.filter((e) => e.seq >= (o.from ?? 0) && (!o.agent || e.agent === o.agent));
    return structuredClone(o.limit !== undefined ? r.slice(0, o.limit) : r);
  }
  subscribe(o: { from?: number; agent?: AgentId }): Subscription {
    const q = new Queue<JournalEntry>();
    for (const e of this.entries) if (e.seq >= (o.from ?? 0) && (!o.agent || e.agent === o.agent)) q.push(structuredClone(e));
    const sub = { agent: o.agent, q };
    this.subs.add(sub);
    return {
      close: () => {
        this.subs.delete(sub);
        q.close();
      },
      [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
    };
  }
}

export class FakeRegistry implements Registry {
  agents = new Map<AgentId, AgentRecord>();
  // setRootPool journals through this in the same synchronous step as the change (wired by createFakes); unset, it throws.
  journal?: FakeJournal;
  // Test convenience that the store does not have: a setSandbox that names a sandbox but no backend, on a record with no pin,
  // pins this backend (createFakes sets it to the fake sandbox's own), so the many tests that set a sandbox by hand model a
  // daemon that started it. Set it to undefined, or write `agents` directly, to build a legacy record that holds a sandbox
  // with no backend.
  // TODO(fake-registry-default-backend): a fake-only convenience that makes the fake more lenient than the real store; current behavior: a record
  // holding a sandbox with no backend is pinned to the fake sandbox's backend. Remove once tests set the backend explicitly.
  defaultBackend: SandboxBackendId | undefined;
  // Own settled plus in-flight model use per agent for the ledger setRootPool reads (the fake has no debit buckets); default 0.
  ownUse: (id: AgentId) => number = () => 0;
  // The provider retry ladder's count per agent (bumpProviderAttempts), and each bump key's first answer.
  providerAttempts = new Map<AgentId, number>();
  private attemptKeys = new Map<string, number>();
  private keys = new Map<string, { fingerprint: string; record: AgentRecord }>(); // idempotencyKey -> record as of the original create
  private ops = new Map<string, { fingerprint?: string; record: AgentRecord }>(); // "<op>:<key>" -> record as of the original call
  private n = 0;
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  async create(a: NewAgent): Promise<AgentRecord> {
    // The fingerprint is the request without its key, as in store-sqlite; a replay with a different request is a conflict.
    const { idempotencyKey: _key, ...request } = a;
    const fingerprint = JSON.stringify(canonical(request));
    const prior = this.keys.get(a.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new IdempotencyConflictError("registry.create", a.idempotencyKey);
      return structuredClone(prior.record);
    }
    const id = a.id ?? `agent-${++this.n}`;
    if (this.agents.has(id)) throw new Error(`agent ${id} already exists`);
    const t = this.now();
    // Same fail-closed executor/spec check as the store: an unknown executor or malformed deterministic spec throws.
    const { executor, spec } = newAgentExecutor(a);
    const rec = {
      id,
      parent: a.parent,
      name: a.name,
      task: a.task,
      state: "pending",
      exit: null,
      result: null,
      host: a.host,
      generation: 0,
      sandbox: null,
      sandboxBackend: null,
      budgetMicros: a.budgetMicros,
      executor,
      spec,
      createdAt: t,
      updatedAt: t,
    } as AgentRecord;
    this.agents.set(id, rec);
    this.keys.set(a.idempotencyKey, { fingerprint, record: structuredClone(rec) });
    return structuredClone(rec);
  }
  async get(id: AgentId) {
    const a = this.agents.get(id);
    return a ? structuredClone(a) : null;
  }
  async list(o?: { parent?: AgentId; state?: AgentState; excludeState?: AgentState }) {
    return [...this.agents.values()]
      .filter((a) => (!o?.parent || a.parent === o.parent) && (!o?.state || a.state === o.state) && (!o?.excludeState || a.state !== o.excludeState))
      .map((a) => structuredClone(a));
  }
  private must(id: AgentId) {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  }
  // `scope` and `fingerprint` (both given, or neither) make a replay with a different request throw like the store's once().
  private once(op: string, key: string, fn: () => AgentRecord, scope?: string, fingerprint?: string): AgentRecord {
    const prior = this.ops.get(`${op}:${key}`);
    if (prior) {
      if (scope !== undefined && prior.fingerprint !== undefined && prior.fingerprint !== fingerprint) throw new IdempotencyConflictError(scope, key);
      return structuredClone(prior.record);
    }
    const rec = fn();
    this.ops.set(`${op}:${key}`, { fingerprint, record: structuredClone(rec) });
    return structuredClone(rec);
  }
  async transition(
    id: AgentId,
    generation: number,
    to: AgentState,
    o: { exit?: ExitStatus; result?: unknown; exitCause?: ExitCause; resume?: true; idempotencyKey: string },
  ) {
    return this.once("transition", o.idempotencyKey, () => {
      const a = this.must(id);
      if (generation !== a.generation) throw new StaleGenerationError(id, generation, a.generation);
      const resume = o.resume === true && a.state === "exited" && to === "running";
      if (!resume && !LEGAL_TRANSITIONS[a.state].includes(to)) throw new IllegalTransitionError(id, a.state, to);
      if (resume) Object.assign(a, { state: to, exit: null, result: null, updatedAt: this.now() });
      else Object.assign(a, { state: to, exit: o.exit ?? a.exit, result: o.result === undefined ? a.result : o.result, updatedAt: this.now() });
      if (to === "exited" && o.exitCause !== undefined) a.exitCause = o.exitCause;
      else if (to !== "reaped") delete a.exitCause;
      return a;
    });
  }
  async bumpGeneration(id: AgentId, host: HostId, idempotencyKey: string) {
    return this.once("bump", idempotencyKey, () => {
      const a = this.must(id);
      Object.assign(a, { generation: a.generation + 1, host, updatedAt: this.now() });
      delete a.exitCause;
      return a;
    });
  }
  async setSandbox(id: AgentId, generation: number, sandbox: SandboxId | null, idempotencyKey: string, backend?: SandboxBackendId) {
    return this.once("setSandbox", idempotencyKey, () => {
      const a = this.must(id);
      if (generation !== a.generation) throw new StaleGenerationError(id, generation, a.generation);
      const sandboxBackend = sandboxBackendAfter(a, sandbox, backend ?? (sandbox !== null && a.sandboxBackend === null ? this.defaultBackend : undefined));
      Object.assign(a, { sandbox, sandboxBackend, updatedAt: this.now() });
      return a;
    });
  }
  async raiseBudget(id: AgentId, deltaMicros: number, idempotencyKey: string) {
    if (!Number.isSafeInteger(deltaMicros) || deltaMicros <= 0) throw new Error("budget raise micros must be a positive safe integer");
    return this.once(
      "raiseBudget",
      idempotencyKey,
      () => {
        const a = this.must(id);
        Object.assign(a, { budgetMicros: a.budgetMicros + deltaMicros, updatedAt: this.now() });
        return a;
      },
      "registry.raiseBudget",
      JSON.stringify(canonical([id, deltaMicros])),
    );
  }
  // Same rule as the durable store: one step (no await between the check, the journal row and the change), a withdrawal of at
  // most the root's ledger remaining, refused in full with RootWithdrawalError.
  async setRootPool(id: AgentId, toMicros: number, idempotencyKey: string): Promise<{ record: AgentRecord; entry: JournalEntry | null }> {
    if (!Number.isSafeInteger(toMicros) || toMicros < 0) throw new Error("root pool micros must be a non-negative safe integer");
    const a = this.must(id);
    if (a.parent !== null) throw new Error(`agent ${id} is not a root; only a root's pool is set by the operator`);
    if (!this.journal) throw new Error("FakeRegistry.setRootPool needs a wired journal");
    const from = a.budgetMicros;
    if (toMicros === from) return { record: structuredClone(a), entry: null };
    if (toMicros < from) {
      const view = budgetLedger(
        [...this.agents.values()].map((n) => ({
          id: n.id,
          parent: n.parent,
          budgetMicros: n.budgetMicros,
          live: n.state !== "reaped",
          usedMicros: this.ownUse(n.id),
        })),
      );
      const available = Math.max(0, view.remaining(id));
      if (from - toMicros > available) throw new RootWithdrawalError(id, from, toMicros, from - available);
    }
    const kind = toMicros > from ? POMTREED_KINDS.budgetTopUp : POMTREED_KINDS.budgetWithdrawal;
    // FakeJournal.append has no await before its write, so the row lands in this same step; the change follows it.
    const pending = this.journal.append({
      agent: id,
      host: a.host,
      generation: a.generation,
      payload: { kind, from, to: toMicros, by: "operator" },
      idempotencyKey,
    });
    Object.assign(a, { budgetMicros: toMicros, updatedAt: this.now() });
    return { record: structuredClone(a), entry: await pending };
  }
  async bumpProviderAttempts(id: AgentId, idempotencyKey: string): Promise<number> {
    const prior = this.attemptKeys.get(idempotencyKey);
    if (prior !== undefined) return prior;
    this.must(id);
    const n = (this.providerAttempts.get(id) ?? 0) + 1;
    this.providerAttempts.set(id, n);
    this.attemptKeys.set(idempotencyKey, n);
    return n;
  }
  async resetProviderAttempts(id: AgentId): Promise<void> {
    this.must(id);
    this.providerAttempts.delete(id);
  }
}

// Host-side ops for one deterministic run. Every call is recorded; a repeated mutation key returns its first result without
// a second effect, mirroring the host. Lifecycle is observable: terminate() (cancel/deadline) or supersede() (a newer
// generation) fences the run, and every later call rejects, replays included. Children are owned by the run that spawned
// them: reap needs an exited child of this run, and a message to a child needs one of this run's children. Custody is tracked
// per ops instance; children persisted by an earlier run (which the host would still own) are not modelled.
export interface DeterministicOpCall {
  op:
    | "peek"
    | "ack"
    | "message"
    | "spawn"
    | "reap"
    | "submitResult"
    | "findChild"
    | "suspend"
    | "answerEscalation"
    | "passEscalation"
    | "openApproval"
    | "getApproval";
  key?: string;
  arg?: unknown;
}
// TODO(workflow-ops-contract): import the child ownership rule from core. Current behavior: this fake tracks ownership itself.
// The daemon keys continuation-workflow messages generation-free as workflow:message:<id>:<key>; core does not state that.
export class FakeDeterministicOps implements DeterministicOps {
  readonly calls: DeterministicOpCall[] = [];
  readonly sent: { to: MessageTarget; body: string }[] = [];
  readonly children: ExecutorSpawnRequest[] = [];
  readonly reaped: AgentId[] = [];
  readonly results: Handoff[] = [];
  private kids = new Map<AgentId, { request: ExecutorSpawnRequest; exited: ExitOutcome | null; reaped: boolean }>();
  // Scripted by the test: what findChild returns for a spawn key (the host would return the record it persisted), or null.
  private foundChildren = new Map<string, AgentRecord | null>();
  readonly suspensions: { state: JsonValue; wait: WaitCondition; key: string }[] = [];
  readonly escalationAnswers: { id: EscalationId; answer: string; key: string }[] = [];
  readonly escalationPasses: { id: EscalationId; key: string }[] = [];
  readonly approvals = new Map<ApprovalId, Approval>();
  private approvalSeq = 0;
  private inbox: Delivered[] = [];
  private byKey = new Map<string, unknown>();
  private static seq = 0; // child ids are unique across runs, so a foreign child is never mistaken for an owned one
  private gen: number;
  private fenced: Error | null = null;
  private readonly unusedMicros: number;
  private readonly agent: string;
  constructor(unusedMicros = 0, generation = 0, agent = "deterministic-run") {
    this.unusedMicros = unusedMicros;
    this.gen = generation;
    this.agent = agent;
  }
  get generation(): number {
    return this.gen;
  }
  deliver(signal: Signal, id: SignalId): void {
    this.inbox.push({ ...signal, id });
  }
  // Test control: the run is cancelled or timed out. Every later call rejects, even a replay of an earlier key.
  terminate(reason = "terminated"): void {
    this.fenced ??= new Error(`deterministic run ${reason}`);
  }
  // Test control: a newer generation was admitted. This run's ops are stale from now on; the newer generation must advance.
  supersede(generation: number): void {
    if (!(generation > this.gen)) throw new Error(`generation must advance past ${this.gen}, got ${generation}`);
    this.fenced ??= new StaleGenerationError("fake", this.gen, generation);
    this.gen = generation;
  }
  // Test control: the child's durable outcome becomes final (it has exited). Reap is only valid after this.
  exitChild(child: AgentId, outcome: ExitOutcome): void {
    const k = this.kids.get(child);
    if (!k) throw new Error(`unknown child ${child}`);
    if (k.exited) throw new Error(`child ${child} already exited`);
    k.exited = structuredClone(outcome);
  }
  private admit(op: DeterministicOpCall["op"], key?: string, arg?: unknown): void {
    this.calls.push({ op, ...(key === undefined ? {} : { key }), ...(arg === undefined ? {} : { arg }) });
    if (this.fenced) throw this.fenced;
  }
  private once<T>(op: string, key: string, fn: () => T): T {
    const hit = `${op}:${key}`;
    if (this.byKey.has(hit)) return structuredClone(this.byKey.get(hit)) as T;
    const r = fn();
    this.byKey.set(hit, structuredClone(r));
    return r;
  }
  private ownedChild(child: AgentId): void {
    if (!this.kids.has(child)) throw new Error(`${child} is not a child of this run`);
  }
  async peek(): Promise<Delivered[]> {
    this.admit("peek");
    return structuredClone(this.inbox);
  }
  async ack(ids: SignalId[], key: string): Promise<SignalId[]> {
    this.admit("ack", key, ids);
    return this.once("ack", key, () => {
      const removed = this.inbox.filter((d) => ids.includes(d.id)).map((d) => d.id);
      this.inbox = this.inbox.filter((d) => !removed.includes(d.id));
      return removed;
    });
  }
  async message(to: MessageTarget, body: string, key: string): Promise<void> {
    this.admit("message", key, { to, body });
    if (to.kind === "child") this.ownedChild(to.child);
    this.once("message", key, () => {
      this.sent.push({ to: structuredClone(to), body });
      return null;
    });
  }
  async spawn(child: ExecutorSpawnRequest): Promise<AgentId> {
    this.admit("spawn", child.idempotencyKey, child);
    if (!child.name || !child.task) throw new Error("spawn needs name and task");
    return this.once("spawn", child.idempotencyKey, () => {
      const id = `child-${++FakeDeterministicOps.seq}`;
      this.children.push(structuredClone(child));
      this.kids.set(id, { request: structuredClone(child), exited: null, reaped: false });
      return id;
    });
  }
  async reap(child: AgentId, key: string): Promise<ExecutorReapReceipt> {
    this.admit("reap", key, child);
    return this.once("reap", key, () => {
      this.ownedChild(child);
      const k = this.kids.get(child)!;
      if (!k.exited) throw new Error(`child ${child} has not exited`);
      // Like the host: a different-key reap of an already-reaped child succeeds and recomputes the same receipt.
      if (!k.reaped) {
        k.reaped = true;
        this.reaped.push(child);
      }
      const o = k.exited;
      return {
        child,
        state: "reaped" as const,
        exit: o.exit,
        ...(o.exitCause ? { exitCause: o.exitCause } : {}),
        ...(o.toolFailureCause ? { toolFailureCause: o.toolFailureCause } : {}),
        result: o.result,
        unusedMicros: this.unusedMicros,
      };
    });
  }
  async submitResult(result: Handoff, key: string): Promise<void> {
    this.admit("submitResult", key, result);
    if (typeof result.summary !== "string" || result.summary.trim() === "") throw new Error("result summary must be non-empty");
    this.once("submitResult", key, () => {
      this.results.push(structuredClone(result));
      return null;
    });
  }
  // Test control: what findChild returns for this spawn key. Unscripted keys resolve to null (no persisted child).
  scriptChild(spawnKey: string, record: AgentRecord | null): void {
    this.foundChildren.set(spawnKey, structuredClone(record));
  }
  async findChild(spawnKey: string): Promise<AgentRecord | null> {
    this.admit("findChild", undefined, spawnKey);
    return structuredClone(this.foundChildren.get(spawnKey) ?? null);
  }
  // Always rejects with a FakeSuspension (the host parks the run). A replay of the same key rejects with the same suspension, no second record.
  async suspend(state: JsonValue, wait: WaitCondition, key: string): Promise<never> {
    this.admit("suspend", key, { state, wait });
    if (!validWorkflowState(state) || !validWorkflowWait(wait)) throw new Error("invalid workflow suspension");
    for (const child of waitChildIds(wait)) if (!this.kids.has(child)) throw new Error("workflow wait must name an owned child");
    const hit = this.suspensions.find((s) => s.key === key);
    if (!hit) this.suspensions.push({ state: structuredClone(state), wait: structuredClone(wait), key });
    throw new FakeSuspension(structuredClone(state), structuredClone(wait));
  }
  async answerEscalation(id: EscalationId, answer: string, key: string): Promise<void> {
    this.admit("answerEscalation", key, { id, answer });
    this.once("answerEscalation", key, () => {
      this.escalationAnswers.push({ id, answer, key });
      return null;
    });
  }
  async passEscalation(id: EscalationId, key: string): Promise<void> {
    this.admit("passEscalation", key, id);
    this.once("passEscalation", key, () => {
      this.escalationPasses.push({ id, key });
      return null;
    });
  }
  // Opens a pending approval for this run (requester is the run, rank "agent"). Keyed: a replay returns the first approval.
  async openApproval(kind: ApprovalKind, target: string, key: string): Promise<Approval> {
    this.admit("openApproval", key, { kind, target });
    if (kind === "publish" && !/^[a-f0-9]{64}$/.test(target)) throw new Error("publish approval target must be the draft sha256");
    return this.once("openApproval", JSON.stringify([kind, target, key]), () => {
      const id = `ap-run-${++this.approvalSeq}`;
      const a: Approval = {
        id,
        requester: { id: this.agent, rank: "agent", generation: this.gen },
        action: { kind, target },
        rungs: kind === "budget_raise" ? ["parent-agent", "operator", "owner"] : ["operator", "owner"],
        rungIndex: 0,
        state: "pending",
        host: "h",
        journal: [],
        deadlineAt: 0,
        createdAt: 0,
        decidedAt: null,
      };
      this.approvals.set(id, structuredClone(a));
      return a;
    });
  }
  async getApproval(id: ApprovalId): Promise<Approval | null> {
    this.admit("getApproval", undefined, id);
    return structuredClone(this.approvals.get(id) ?? null);
  }
}
// Thrown by FakeDeterministicOps.suspend: the run is parked with this state and wait condition.
export class FakeSuspension extends Error {
  readonly state: JsonValue;
  readonly wait: WaitCondition;
  constructor(state: JsonValue, wait: WaitCondition) {
    super("deterministic run suspended");
    this.name = "FakeSuspension";
    this.state = state;
    this.wait = wait;
  }
}
type ExitOutcome = { exit: ExitStatus | null; exitCause?: ExitCause; toolFailureCause?: string; result: unknown };

export type DeterministicHandler = (ctx: DeterministicRunContext) => void | Promise<void>;
export interface DeterministicRunRecord {
  agent: AgentId;
  generation: number;
  outcome: "returned" | "threw" | "aborted";
}

// Scriptable driver. By default run() returns at once; setHandler scripts behaviour, hold() parks every run at its start until
// release(), and a handler that throws makes run() reject. An aborted signal rejects run() with the signal's reason even if the
// handler is still pending (the handler is not cancelled: it is the driver's own code).
export class FakeDeterministicExecutor implements DeterministicExecutor {
  readonly contexts: DeterministicRunContext[] = [];
  readonly runs: DeterministicRunRecord[] = [];
  private handler: DeterministicHandler = () => {};
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  readonly driver: string;
  constructor(driver = "fake") {
    this.driver = driver;
  }
  setHandler(h: DeterministicHandler): void {
    this.handler = h;
  }
  hold(): void {
    if (!this.gate) this.gate = new Promise<void>((resolve) => (this.openGate = resolve));
  }
  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }
  async run(ctx: DeterministicRunContext): Promise<void> {
    this.contexts.push(ctx);
    if (ctx.ops instanceof FakeDeterministicOps && ctx.ops.generation !== ctx.generation) {
      this.runs.push({ agent: ctx.agent, generation: ctx.generation, outcome: "threw" });
      throw new StaleGenerationError(ctx.agent, ctx.generation, ctx.ops.generation);
    }
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(ctx.signal.reason ?? new Error("aborted"));
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {}); // a late abort after a normal return must not surface as an unhandled rejection
    const body = async () => {
      if (this.gate) await this.gate;
      await this.handler(ctx);
    };
    try {
      await Promise.race([body(), aborted]);
      this.runs.push({ agent: ctx.agent, generation: ctx.generation, outcome: "returned" });
    } catch (e) {
      this.runs.push({ agent: ctx.agent, generation: ctx.generation, outcome: ctx.signal.aborted ? "aborted" : "threw" });
      throw e;
    }
  }
}

// A run context for tests: an un-aborted signal, FakeDeterministicOps unless one is given, and no deadline by default.
export function fakeDeterministicContext(
  o: Partial<Pick<DeterministicRunContext, "agent" | "generation" | "host" | "input" | "deadlineAt" | "ops" | "signal" | "continuation">> = {},
): DeterministicRunContext {
  return {
    ...(o.continuation === undefined ? {} : { continuation: o.continuation }),
    agent: o.agent ?? "det-1",
    generation: o.generation ?? 0,
    host: o.host ?? "h",
    input: (o.input ?? null) as JsonValue,
    signal: o.signal ?? new AbortController().signal,
    deadlineAt: o.deadlineAt ?? null,
    ops: o.ops ?? new FakeDeterministicOps(0, o.generation ?? 0),
  };
}

// TODO(testing-mailbox-contract): the Mailbox port has no contract in port-contracts.ts; add one when the port next changes.
export class FakeMailbox implements Mailbox {
  boxes = new Map<AgentId, { id: SignalId; signal: Signal }[]>();
  private keys = new Map<string, string>(); // send key -> request fingerprint, as store-sqlite's once() keeps it
  private received = new Map<string, Delivered[]>();
  private acked = new Map<string, SignalId[]>();
  private registry?: FakeRegistry;
  // When true (the default), send() rejects an unknown or reaped target like the real store.
  strictTargets: boolean;
  constructor(registry?: FakeRegistry, strictTargets = true) {
    this.registry = registry;
    this.strictTargets = strictTargets;
  }
  async send(to: AgentId, signal: Signal, key: string, senderGeneration?: number) {
    const fingerprint = JSON.stringify(canonical([to, signal]));
    const prior = this.keys.get(key);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new IdempotencyConflictError("mailbox", key);
      return;
    }
    // Mirrors the store when strictTargets: a signal to an unknown or reaped target is rejected. Daemon-originated signals skip the sender check.
    if (this.registry && this.strictTargets) {
      const target = this.registry.agents.get(to);
      if (!target) throw new Error(`unknown agent ${to}`);
      if (target.state === "reaped") throw new Error(`cannot signal reaped agent ${to}`);
    }
    if (senderGeneration !== undefined && signal.kind === "message") {
      const sender = this.registry?.agents.get(signal.from);
      if (!sender) throw new Error(`unknown agent ${signal.from}`);
      if (sender.generation !== senderGeneration) throw new StaleGenerationError(signal.from, senderGeneration, sender.generation);
    }
    this.keys.set(key, fingerprint);
    const box = this.boxes.get(to) ?? this.boxes.set(to, []).get(to)!;
    // A level kind supersedes the unconsumed one of that kind (latest wins, the survivor carries the new id).
    if (isLevelKind(signal.kind)) box.splice(0, box.length, ...box.filter((e) => e.signal.kind !== signal.kind));
    box.push({ id: key, signal });
  }
  // Interrupt-flagged signals sort ahead of the rest (stable), like the store's ORDER BY.
  private ordered(agent: AgentId): { id: SignalId; signal: Signal }[] {
    const b = this.boxes.get(agent) ?? [];
    const isInt = (e: { signal: Signal }) => (e.signal as { interrupt?: boolean }).interrupt === true;
    const sorted = [...b.filter(isInt), ...b.filter((e) => !isInt(e))];
    b.splice(0, b.length, ...sorted);
    return b;
  }
  private delivered(e: { id: SignalId; signal: Signal }): Delivered {
    return { ...structuredClone(e.signal), id: e.id };
  }
  async receive(agent: AgentId, idempotencyKey: string, o?: { limit?: number }) {
    const prior = this.received.get(idempotencyKey);
    if (prior) return structuredClone(prior);
    const b = this.ordered(agent);
    const got = b.splice(0, o?.limit ?? b.length).map((e) => this.delivered(e));
    this.received.set(idempotencyKey, structuredClone(got));
    return structuredClone(got);
  }
  async peek(agent: AgentId) {
    return this.ordered(agent).map((e) => this.delivered(e));
  }
  async ack(agent: AgentId, ids: SignalId[], idempotencyKey: string) {
    const prior = this.acked.get(idempotencyKey);
    if (prior) return [...prior];
    const b = this.boxes.get(agent) ?? [];
    const removed = ids.filter((id) => {
      const at = b.findIndex((e) => e.id === id);
      if (at < 0) return false;
      b.splice(at, 1);
      return true;
    });
    this.acked.set(idempotencyKey, [...removed]);
    return removed;
  }
}

export class FakeCheckpointStore implements CheckpointStore {
  all: Checkpoint[] = [];
  private keys = new Map<string, Checkpoint>();
  private now: () => number;
  private registry?: FakeRegistry;
  constructor(now: () => number, registry?: FakeRegistry) {
    this.now = now;
    this.registry = registry;
  }
  async write(c: Omit<Checkpoint, "id" | "createdAt" | "version">, key: string) {
    const prior = this.keys.get(key);
    if (prior) return structuredClone(prior);
    const a = this.registry?.agents.get(c.agent);
    if (!a) throw new Error(`unknown agent ${c.agent}`);
    if (a.generation !== c.generation) throw new StaleGenerationError(c.agent, c.generation, a.generation);
    const cp: Checkpoint = { ...c, version: CHECKPOINT_FORMAT, id: `cp-${this.all.length + 1}`, createdAt: this.now() };
    this.all.push(cp);
    this.keys.set(key, cp);
    return structuredClone(cp);
  }
  async latest(agent: AgentId) {
    const c = [...this.all].reverse().find((x) => x.agent === agent);
    return c ? structuredClone(c) : null;
  }
  async read(id: string) {
    const c = this.all.find((x) => x.id === id);
    return c ? structuredClone(c) : null;
  }
}

export class FakeSessionStore implements SessionStore {
  blobs = new Map<string, Uint8Array>();
  async put(session: Uint8Array): Promise<string> {
    const ref = createHash("sha256").update(session).digest("hex");
    if (!this.blobs.has(ref)) this.blobs.set(ref, structuredClone(session));
    return ref;
  }
  async get(ref: string): Promise<Uint8Array | null> {
    const b = this.blobs.get(ref);
    return b ? structuredClone(b) : null;
  }
}

export class FakeScheduleStore implements ScheduleStore {
  all: Schedule[] = [];
  lastFiredAt = new Map<ScheduleId, number>();
  private keys = new Map<string, Schedule>();
  private firedKeys = new Set<string>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  private pauseKeys = new Map<string, Schedule | null>();
  async setPaused(id: ScheduleId, paused: boolean, key: string): Promise<Schedule | null> {
    if (this.pauseKeys.has(key)) return structuredClone(this.pauseKeys.get(key)!);
    const cur = this.all.find((x) => x.id === id);
    if (cur) {
      if (paused) cur.paused = true;
      else {
        delete cur.paused;
        delete cur.failures;
        delete cur.retryAt;
      }
    }
    const out = cur ? structuredClone(cur) : null;
    this.pauseKeys.set(key, out);
    return structuredClone(out);
  }
  private failKeys = new Map<string, Schedule | null>();
  async recordFailure(id: ScheduleId, retryAt: number, key: string): Promise<Schedule | null> {
    if (this.failKeys.has(key)) return structuredClone(this.failKeys.get(key)!);
    const cur = this.all.find((x) => x.id === id);
    if (cur) {
      cur.failures = (cur.failures ?? 0) + 1;
      cur.retryAt = retryAt;
    }
    const out = cur ? structuredClone(cur) : null;
    this.failKeys.set(key, out);
    return structuredClone(out);
  }
  private orphanKeys = new Map<string, Schedule | null>();
  async setOrphaned(id: ScheduleId, key: string): Promise<Schedule | null> {
    if (this.orphanKeys.has(key)) return structuredClone(this.orphanKeys.get(key)!);
    const cur = this.all.find((x) => x.id === id);
    if (cur) cur.orphaned = true;
    const out = cur ? structuredClone(cur) : null;
    this.orphanKeys.set(key, out);
    return structuredClone(out);
  }
  private clearKeys = new Set<string>();
  async clearFailures(id: ScheduleId, key: string): Promise<void> {
    if (this.clearKeys.has(key)) return;
    this.clearKeys.add(key);
    const cur = this.all.find((x) => x.id === id);
    if (cur) {
      delete cur.failures;
      delete cur.retryAt;
    }
  }
  async upsert(s: Omit<Schedule, "createdAt">, key: string) {
    const prior = this.keys.get(key);
    if (prior) return structuredClone(prior);
    const existing = this.all.find((x) => x.id === s.id);
    const paused = s.paused ?? existing?.paused;
    // Real store replaces every field on update (tz included) and preserves only createdAt.
    const schedule: Schedule = {
      id: s.id,
      cron: s.cron,
      ...(s.tz ? { tz: s.tz } : {}),
      task: s.task,
      missed: s.missed,
      overlap: s.overlap,
      jitterMs: s.jitterMs,
      ...(paused ? { paused: true } : {}),
      ...(existing?.failures ? { failures: existing.failures } : {}),
      ...(existing?.retryAt !== undefined ? { retryAt: existing.retryAt } : {}),
      ...(s.agent !== undefined && { agent: s.agent }),
      ...(s.createdBy !== undefined && { createdBy: s.createdBy }),
      ...(s.budgetMicros !== undefined && { budgetMicros: s.budgetMicros }),
      ...(s.deadlineMs !== undefined && { deadlineMs: s.deadlineMs }),
      ...(s.template !== undefined && { template: s.template }),
      ...(s.model !== undefined && { model: structuredClone(s.model) }),
      createdAt: existing ? existing.createdAt : this.now(),
    };
    if (existing) this.all[this.all.indexOf(existing)] = schedule;
    else this.all.push(schedule);
    this.keys.set(key, structuredClone(schedule));
    return structuredClone(schedule);
  }
  async remove(id: ScheduleId): Promise<boolean> {
    const i = this.all.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.all.splice(i, 1);
    this.lastFiredAt.delete(id);
    return true;
  }
  async get(id: ScheduleId) {
    const s = this.all.find((x) => x.id === id);
    return s ? structuredClone(s) : null;
  }
  async list(): Promise<Schedule[]> {
    return structuredClone(this.all);
  }
  async lastFired(id: ScheduleId): Promise<number | null> {
    return this.lastFiredAt.get(id) ?? null;
  }
  async setLastFired(id: ScheduleId, at: number, key: string): Promise<void> {
    if (this.firedKeys.has(key)) return;
    this.firedKeys.add(key);
    this.lastFiredAt.set(id, at);
  }
}

export class FakeWatchdogStore implements WatchdogStore {
  state = new Map<AgentId, WatchdogState>();
  private keys = new Map<string, WatchdogState>();
  async get(agent: AgentId): Promise<WatchdogState | null> {
    const s = this.state.get(agent);
    return s ? structuredClone(s) : null;
  }
  async set(agent: AgentId, state: WatchdogState, key: string): Promise<WatchdogState> {
    const prior = this.keys.get(key);
    if (prior) return structuredClone(prior);
    const next = structuredClone(state);
    this.state.set(agent, next);
    this.keys.set(key, structuredClone(next));
    return structuredClone(next);
  }
  async clear(agent: AgentId): Promise<void> {
    this.state.delete(agent);
  }
}

export class FakeEscalationStore implements EscalationStore {
  all: Escalation[] = [];
  private keys = new Map<string, Escalation>();
  // Each answer key keeps its request fingerprint beside the result (idem-fingerprint), as store-sqlite's once() does.
  private answerKeys = new Map<string, { fingerprint: string; result: Escalation }>();
  private advanceKeys = new Map<string, Escalation>();
  private now: () => number;
  private registry?: FakeRegistry;
  constructor(now: () => number, registry?: FakeRegistry) {
    this.now = now;
    this.registry = registry;
  }
  async create(e: NewEscalation, key: string): Promise<Escalation> {
    const prior = this.keys.get(key);
    if (prior) return structuredClone(prior);
    const existing = this.all.find((x) => x.id === e.id);
    if (existing) return structuredClone(existing);
    const a = this.registry?.agents.get(e.agent);
    if (!a) throw new Error(`unknown agent ${e.agent}`);
    if (a.generation !== e.generation) throw new StaleGenerationError(e.agent, e.generation, a.generation);
    const esc: Escalation = {
      ...e,
      state: "open",
      answer: null,
      answeredBy: null,
      createdAt: this.now(),
      answeredAt: null,
      holder: e.holder ?? null,
    };
    this.all.push(esc);
    this.keys.set(key, structuredClone(esc));
    return structuredClone(esc);
  }
  async get(id: EscalationId): Promise<Escalation | null> {
    const e = this.all.find((x) => x.id === id);
    return e ? structuredClone(e) : null;
  }
  async list(opts?: { agent?: AgentId; state?: EscalationState }): Promise<Escalation[]> {
    return structuredClone(this.all.filter((e) => (!opts?.agent || e.agent === opts.agent) && (!opts?.state || e.state === opts.state)));
  }
  async answer(id: EscalationId, answer: string, by: MessagingSender, key: string): Promise<Escalation> {
    const fingerprint = JSON.stringify([id, answer, by.channel, by.sender, by.name ?? null]);
    const prior = this.answerKeys.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new IdempotencyConflictError("escalation.answer", key);
      return structuredClone(prior.result);
    }
    const e = this.all.find((x) => x.id === id);
    if (!e) throw new Error(`unknown escalation ${id}`);
    // First answer wins; a later key records the escalation as it stands.
    if (e.state === "open") Object.assign(e, { state: "answered" as const, answer, answeredBy: by, answeredAt: this.now() });
    this.answerKeys.set(key, { fingerprint, result: structuredClone(e) });
    return structuredClone(e);
  }
  async advance(id: EscalationId, holder: AgentId | null, hopDeadlineAt: number | undefined, key: string): Promise<Escalation> {
    const prior = this.advanceKeys.get(key);
    if (prior) return structuredClone(prior);
    const e = this.all.find((x) => x.id === id);
    if (!e) throw new Error(`unknown escalation ${id}`);
    if (e.state !== "open") return structuredClone(e);
    e.holder = holder;
    if (hopDeadlineAt === undefined) delete e.hopDeadlineAt;
    else e.hopDeadlineAt = hopDeadlineAt;
    this.advanceKeys.set(key, structuredClone(e));
    return structuredClone(e);
  }
}

export class FakeApprovalStore implements ApprovalStore {
  all: Approval[] = [];
  private keys = new Map<string, Approval>(); // create idempotency
  private decisionKeys = new Map<string, { fingerprint: string; result: Approval }>(); // decide idempotency
  private timeoutKeys = new Map<string, Approval>(); // timeout idempotency (scoped apart from decide, like the store)
  private notifiedKeys = new Map<string, Approval>(); // markNotified idempotency
  private now: () => number;
  private registry?: FakeRegistry;
  constructor(now: () => number, registry?: FakeRegistry) {
    this.now = now;
    this.registry = registry;
  }

  private current(id: ApprovalId): Approval {
    const a = this.all.find((x) => x.id === id);
    if (!a) throw new Error(`unknown approval ${id}`);
    return a;
  }

  private failClosed(cur: Approval): Approval {
    cur.state = "denied";
    cur.rungIndex = cur.rungs.length;
    cur.decidedAt = this.now();
    return structuredClone(cur);
  }

  private apply(id: ApprovalId, decision: ApprovalDecision, who: string | null, rank: ApprovalRank, why: string, grantMicros?: number): Approval {
    const cur = this.current(id);
    if (cur.state !== "pending") return structuredClone(cur); // settled: replay
    if (cur.rungIndex >= cur.rungs.length) return this.failClosed(cur); // no rung left to decide: deny
    const rung = cur.rungs[cur.rungIndex]!;
    const res = applyDecision(cur.requester.rank, rank, cur.rungs, cur.rungIndex, decision);
    if (!res.ok) throw new Error(res.reason);
    cur.journal.push({ rung, rank, who, decision, why, ...(grantMicros !== undefined ? { grantMicros } : {}), at: this.now() });
    if (res.outcome.state === "pending") {
      cur.rungIndex += 1;
      const window = cur.rungWindowsMs?.[cur.rungIndex] ?? cur.rungMs;
      if (window !== undefined) cur.deadlineAt = this.now() + window; // re-base on the new rung
    } else {
      cur.state = res.outcome.state;
      cur.decidedAt = this.now();
      if (res.outcome.failClosed) cur.rungIndex = cur.rungs.length;
    }
    return structuredClone(cur);
  }

  async create(a: NewApproval, key: string): Promise<Approval> {
    const prior = this.keys.get(key);
    if (prior) return structuredClone(prior);
    const existing = this.all.find((x) => x.id === a.id);
    if (existing) return structuredClone(existing);
    if (a.requester.generation !== undefined) {
      const agent = this.registry?.agents.get(a.requester.id);
      if (!agent) throw new Error(`unknown agent ${a.requester.id}`);
      if (agent.generation !== a.requester.generation) throw new StaleGenerationError(a.requester.id, a.requester.generation, agent.generation);
    }
    const createdAt = this.now();
    const rungs = a.rungs ?? rungsAbove(a.requester.rank);
    const ap: Approval = {
      id: a.id,
      requester: { id: a.requester.id, rank: a.requester.rank, ...(a.requester.generation !== undefined ? { generation: a.requester.generation } : {}) },
      action: { kind: a.action.kind, target: a.action.target },
      rungs,
      rungIndex: 0,
      state: rungs.length === 0 ? "denied" : "pending", // owner requester: nobody above, fail closed
      host: a.host,
      journal: [],
      deadlineAt: a.deadlineAt,
      rungMs: Math.max(0, a.deadlineAt - createdAt),
      ...(a.rungWindowsMs ? { rungWindowsMs: [...a.rungWindowsMs] } : {}),
      createdAt,
      decidedAt: rungs.length === 0 ? createdAt : null,
    };
    this.all.push(ap);
    this.keys.set(key, structuredClone(ap));
    return structuredClone(ap);
  }
  async get(id: ApprovalId): Promise<Approval | null> {
    const a = this.all.find((x) => x.id === id);
    return a ? structuredClone(a) : null;
  }
  async list(opts?: { requester?: string; state?: ApprovalState; unnotified?: boolean }): Promise<Approval[]> {
    return structuredClone(
      this.all.filter(
        (a) =>
          (!opts?.requester || a.requester.id === opts.requester) &&
          (!opts?.state || a.state === opts.state) &&
          (!opts?.unnotified || (a.state !== "pending" && a.notifiedAt === undefined)),
      ),
    );
  }
  async markNotified(id: ApprovalId, key: string): Promise<Approval> {
    const prior = this.notifiedKeys.get(key);
    if (prior) return structuredClone(prior);
    const cur = this.current(id);
    if (cur.state === "pending") throw new Error(`approval ${id} is pending: no decision to mark delivered`);
    cur.notifiedAt ??= this.now();
    this.notifiedKeys.set(key, structuredClone(cur));
    return structuredClone(cur);
  }
  async decide(id: ApprovalId, d: NewApprovalDecision, key: string): Promise<Approval> {
    const fingerprint = JSON.stringify(canonical([id, d]));
    const prior = this.decisionKeys.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new IdempotencyConflictError("approval.decide", key);
      return structuredClone(prior.result);
    }
    const result = this.apply(id, d.decision, d.who, d.rank, d.why, d.grantMicros);
    this.decisionKeys.set(key, { fingerprint, result: structuredClone(result) });
    return structuredClone(result);
  }
  async timeout(id: ApprovalId, key: string): Promise<Approval> {
    const prior = this.timeoutKeys.get(key);
    if (prior) return structuredClone(prior);
    const cur = this.current(id);
    let result: Approval;
    if (cur.state !== "pending") {
      result = structuredClone(cur);
    } else if (cur.rungIndex >= cur.rungs.length) {
      result = this.failClosed(cur);
    } else {
      result = this.apply(id, "timeout", null, rankOfRung(cur.rungs[cur.rungIndex]!), "rung deadline passed");
    }
    this.timeoutKeys.set(key, structuredClone(result));
    return structuredClone(result);
  }
}

export class FakeReportStore implements ReportStore {
  all: Report[] = [];
  blobs = new Map<ReportId, Uint8Array>();
  private now: () => number;
  private registry?: FakeRegistry;
  constructor(now: () => number, registry?: FakeRegistry) {
    this.now = now;
    this.registry = registry;
  }
  async write(r: NewReport, _idempotencyKey: string): Promise<Report> {
    const prior = this.all.find((x) => x.id === r.id);
    if (prior) return structuredClone(prior);
    const a = this.registry?.agents.get(r.agent);
    if (!a) throw new Error(`unknown agent ${r.agent}`);
    if (a.generation !== r.generation) throw new StaleGenerationError(r.agent, r.generation, a.generation);
    const { content, ...rest } = r;
    const report: Report = { ...rest, createdAt: this.now() };
    this.all.push(report);
    this.blobs.set(r.id, content);
    return structuredClone(report);
  }
  async list(agent: AgentId): Promise<Report[]> {
    return structuredClone(this.all.filter((x) => x.agent === agent).sort((x, y) => y.createdAt - x.createdAt));
  }
  async read(agent: AgentId, id: ReportId) {
    const report = this.all.find((x) => x.agent === agent && x.id === id);
    const content = report && this.blobs.get(id);
    if (!report || content === undefined) return null;
    return { report: structuredClone(report), content: structuredClone(content) };
  }
  async remove(agent: AgentId, id: ReportId): Promise<boolean> {
    const i = this.all.findIndex((x) => x.agent === agent && x.id === id);
    if (i < 0) return false;
    this.all.splice(i, 1);
    this.blobs.delete(id);
    return true;
  }
}

export class FakeTemplateStore implements TemplateStore {
  templates = new Map<TemplateId, Template>();
  constructor(templates: Template[] = []) {
    for (const t of templates) this.templates.set(t.id, t);
  }
  async resolve(name: TemplateId): Promise<Template | null> {
    const t = this.templates.get(name);
    return t ? structuredClone(t) : null;
  }
  async list(): Promise<Template[]> {
    return [...this.templates.values()].map((t) => structuredClone(t));
  }
}

export type SandboxStop = "graceful" | "sigterm" | "sigkill";

// Scripted terminal session: records writes/resizes/closes; tests push output with emit() and end
// the stream with end(). write() can be made to wait via `holdWrites` to exercise backpressure.
export class FakeTerminal implements TerminalSession {
  writes: Uint8Array[] = [];
  resizes: { cols: number; rows: number }[] = [];
  closes = 0;
  redraws = 0;
  // Scripted failure for the next resize() call.
  resizeError: Error | null = null;
  readonly closed: Promise<TerminalClose>;
  private settle!: (c: TerminalClose) => void;
  private ended = false;
  private failure: Error | undefined;
  private queue: Uint8Array[] = [];
  private wake: (() => void) | undefined;
  constructor(size?: { cols: number; rows: number }) {
    if (size) this.resizes.push({ ...size });
    this.closed = new Promise((r) => (this.settle = r));
  }
  // Test hook: push terminal output.
  emit(data: Uint8Array | string) {
    if (this.ended) return;
    this.queue.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    this.wake?.();
  }
  // Test hook: end the stream (container exit / remote detach), or break it with an error.
  end(error?: Error) {
    this.finish(error ? { reason: "error", error } : { reason: "remote" });
  }
  // Everything written so far, decoded as UTF-8.
  get written(): string {
    return new TextDecoder().decode(Buffer.concat(this.writes));
  }
  private finish(c: TerminalClose) {
    if (this.ended) return;
    this.ended = true;
    this.failure = c.error;
    this.settle(c);
    this.wake?.();
  }
  async write(data: Uint8Array | string): Promise<void> {
    if (this.ended) throw new Error("terminal closed");
    this.writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
  async resize(cols: number, rows: number): Promise<void> {
    if (this.ended) return;
    if (this.resizeError) {
      const e = this.resizeError;
      this.resizeError = null;
      throw e;
    }
    this.resizes.push({ cols, rows });
  }
  async redraw(): Promise<void> {
    const last = this.resizes.at(-1);
    if (!last) throw new Error("terminal size unknown: call resize(cols, rows) first");
    this.redraws++;
    await this.resize(last.cols + 1, last.rows);
    await this.resize(last.cols, last.rows);
  }
  async *output(): AsyncGenerator<Uint8Array> {
    while (true) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      } else await new Promise<void>((r) => (this.wake = r));
    }
  }
  close() {
    this.closes++;
    this.queue.length = 0;
    this.finish({ reason: "local" });
  }
}

// A scripted ByteStream: records writes and closes; the test pushes the port's bytes with emit() and ends or breaks the stream
// with end()/fail().
export class FakeByteStream implements ByteStream {
  writes: Uint8Array[] = [];
  closes = 0;
  // Test hook: every accepted write is also emitted back as output.
  echo = false;
  readonly closed: Promise<TerminalClose>;
  private settle!: (c: TerminalClose) => void;
  private ended = false;
  private failure: Error | undefined;
  private queue: Uint8Array[] = [];
  private wake: (() => void) | undefined;
  constructor() {
    this.closed = new Promise((r) => (this.settle = r));
  }
  // Test hook: push bytes from the port.
  emit(data: Uint8Array | string) {
    if (this.ended) return;
    this.queue.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    this.wake?.();
  }
  // Test hook: the remote side ended the stream (resolves "remote").
  end() {
    this.finish({ reason: "remote" });
  }
  // Test hook: the stream broke (resolves "error"; output() throws once drained).
  fail(error: Error) {
    this.finish({ reason: "error", error });
  }
  // Everything written so far, decoded as UTF-8.
  get written(): string {
    return new TextDecoder().decode(Buffer.concat(this.writes));
  }
  private finish(c: TerminalClose) {
    if (this.ended) return;
    this.ended = true;
    this.failure = c.error;
    this.settle(c);
    this.wake?.();
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.ended) throw new Error("byte stream closed");
    this.writes.push(data);
    if (this.echo) this.emit(data);
  }
  async *output(): AsyncGenerator<Uint8Array> {
    while (true) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      } else await new Promise<void>((r) => (this.wake = r));
    }
  }
  close() {
    this.closes++;
    this.queue.length = 0;
    this.finish({ reason: "local" });
  }
}

// The fake's default declaration: backend "fake", terminal and loopback on, everything that needs a facet (snapshots, pause, lease, images,
// connect, files) off. It declares the non-facet behaviour the fake already has: host mounts, OCI pulls, digest attestation,
// egress and reach, secrets and limits.
const FAKE_SANDBOX_TRUE: readonly SandboxCapability[] = [
  "terminal",
  "loopback",
  "mounts.host",
  "image.ociPull",
  "image.digestAttest",
  "egress.denyAll",
  "egress.allowHost",
  "egress.allowCidr",
  "reach.outbound",
  "secrets.env",
  "resources.limits",
];

export function fakeSandboxDeclaration(overrides: FakeSandboxDeclaration = {}): SandboxDeclaration {
  const capabilities = Object.fromEntries(SANDBOX_CAPABILITIES.map((c) => [c, FAKE_SANDBOX_TRUE.includes(c)])) as Record<SandboxCapability, boolean>;
  const { capabilities: caps, ...rest } = overrides;
  return {
    backend: "fake",
    region: null,
    idempotency: "unique-name",
    idempotencyWindowMs: null,
    tagging: "metadata",
    output: "stream",
    maxLifetimeMs: null,
    preemptible: false,
    billing: { unit: "none", whileStopped: false, whilePaused: false },
    ...rest,
    capabilities: { ...capabilities, ...caps },
  };
}

export type FakeSandboxDeclaration = Partial<Omit<SandboxDeclaration, "capabilities">> & {
  capabilities?: Partial<Record<SandboxCapability, boolean>>;
};

export interface FakeSandboxOptions {
  // Overrides merged onto the default declaration (capabilities merge key by key).
  declaration?: FakeSandboxDeclaration;
  // Facets merged onto the default ({ terminal, loopback }); an explicit `undefined` value omits that facet, so a test can build a fake that
  // declares a capability without its facet or the reverse. Any facet given here is the test's own object.
  facets?: { [K in keyof SandboxFacets]?: SandboxFacets[K] | undefined };
  // Makes probe() present and return this result (a copy); `probeResult` stays settable. Absent = the fake has no probe.
  probe?: ProbeResult;
  // Fault plan consulted by start, stop, kill, list, inspect, wait, probe, files and connect; default is an empty plan.
  faults?: FaultPlan;
  // Remote mode: declares connect, files.put and files.get and installs in-memory facets for them (a loopback connect channel and
  // a per-sandbox file store); `declaration` and `facets` still override.
  remote?: boolean;
  // Sandbox ids are sandboxIdForKey(idempotencyKey), as the port specifies, instead of the default sbx-1, sbx-2, ... that older
  // tests assert on. Implied by `remote`.
  derivedIds?: boolean;
}

// A connect channel that loops written bytes back as output. With dropAfter set, the stream breaks after that many output bytes.
export class FakeChannel extends FakeTerminal {
  readonly id: SandboxId;
  readonly channel: SandboxChannel;
  private readonly dropAfter: number | undefined;
  private sent = 0;
  private shut = false;
  constructor(id: SandboxId, channel: SandboxChannel, dropAfter?: number) {
    super();
    this.id = id;
    this.channel = channel;
    this.dropAfter = dropAfter;
    if (dropAfter === 0) this.drop();
  }
  private drop() {
    this.end(
      new SandboxUnavailableError("provider-outage", `connect channel ${this.channel} of sandbox ${this.id} dropped (injected fault); reopen the channel`),
    );
  }
  // Backpressure is not modelled: write() always resolves as soon as the bytes are accepted.
  override end(error?: Error) {
    this.shut = true;
    super.end(error);
  }
  override close() {
    this.shut = true;
    super.close();
  }
  override async write(data: Uint8Array | string): Promise<void> {
    if (this.shut) throw new SandboxUnavailableError("provider-outage", `connect channel ${this.channel} of sandbox ${this.id} is closed; reopen the channel`);
    await super.write(data);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const room = this.dropAfter === undefined ? bytes.length : Math.max(0, this.dropAfter - this.sent);
    const out = bytes.subarray(0, room);
    if (out.length > 0) this.emit(out);
    this.sent += out.length;
    if (this.dropAfter !== undefined && this.sent >= this.dropAfter) this.drop();
  }
}

// One recorded call to a fault-injectable operation of FakeSandbox, in call order (before any fault takes effect).
export interface SandboxOpCall {
  op: FaultOp;
  key?: string;
  id?: SandboxId;
  path?: string;
  channel?: SandboxChannel;
}

export class FakeSandbox implements Sandbox {
  resultWorkResults: ({ dirty: boolean; fingerprint: string; bundle?: AsyncIterable<Uint8Array> } | Error)[] = [];
  // Every resultWork call in order, with a copy of its opts (maxBytes included), recorded before the availability check.
  resultWorkCalls: { id: SandboxId; opts: { save?: boolean; expectedFingerprint?: string; maxBytes: number } }[] = [];
  async resultWork(id: SandboxId, opts: { save?: boolean; expectedFingerprint?: string; maxBytes: number }) {
    this.resultWorkCalls.push({ id, opts: { ...opts } });
    const s = this.running.get(id);
    if (!s || s.exitCode !== null) throw new SandboxUnavailableError();
    const result = this.resultWorkResults.shift();
    if (result instanceof Error) throw result;
    return result ?? { dirty: false, fingerprint: "clean" };
  }
  exitCodes: number[];
  // Scriptable image ref -> engineLocalId reported by imageIdentity(); defaults to `${ref}@sha256:fake`.
  engineLocalIds = new Map<string, string>();
  readonly declaration: SandboxDeclaration;
  terminal?: SandboxFacets["terminal"];
  connect?: SandboxFacets["connect"];
  loopback?: SandboxFacets["loopback"];
  files?: SandboxFacets["files"];
  snapshots?: SandboxFacets["snapshots"];
  lease?: SandboxFacets["lease"];
  pause?: SandboxFacets["pause"];
  images?: SandboxFacets["images"];
  // Present only when constructed with options.probe; every call's runtime block argument is recorded.
  probe?: Sandbox["probe"];
  probeResult: ProbeResult | undefined;
  probeCalls: (SandboxSpec["runtime"] | undefined)[] = [];
  // Owners passed to list() and reclaim(), in call order.
  listOwners: SandboxOwner[] = [];
  // stop() and kill() calls with the idempotency key, in call order.
  stopCalls: { id: SandboxId; graceMs: number; idempotencyKey: string }[] = [];
  killCalls: { id: SandboxId; idempotencyKey: string }[] = [];
  // stop() exit semantics: "graceful" (handled SIGTERM -> 0), "sigterm" (default SIGTERM
  // handler -> 143), "sigkill" (ignored SIGTERM -> SIGKILL after graceMs -> 137).
  stopPolicy: SandboxStop;
  running = new Map<
    SandboxId,
    {
      agent: AgentId;
      // The owner stamp start() recorded from SandboxSpec.host and generation; list and inspect report it back.
      host: HostId;
      generation: number;
      labels?: Record<string, string>;
      exitCode: number | null;
      oomKilled: boolean;
      done: Promise<{ exitCode: number; oomKilled?: boolean }>;
      finish(c: number): void;
    }
  >();
  started: SandboxSpec[] = [];
  // Scripted start() failures, consumed in order (one per non-replayed start call); an entry of
  // null lets that call succeed. A failed start records nothing and does not consume an exit code.
  startErrors: (Error | null)[] = [];
  // Scripted wait() failures by sandbox id: wait() on a handle from start() or attach() rejects with the entry instead of
  // resolving at exit. Absent (the default) keeps the exit-resolving behavior.
  waitErrors = new Map<SandboxId, Error>();
  // Terminals opened via terminal.open, per sandbox id, in open order. They end ("remote") when the sandbox exits.
  terminals = new Map<SandboxId, FakeTerminal[]>();
  // Loopback streams opened via loopback.open, per sandbox id, in open order. They end ("remote") when the sandbox exits.
  loopbackStreams = new Map<SandboxId, FakeByteStream[]>();
  // Every loopback.open call in order, recorded before any check.
  loopbackCalls: { id: SandboxId; port: number }[] = [];
  // Scripted loopback.open failures, consumed in order (one per call that passed the port and availability checks); an
  // entry of null lets that call succeed.
  loopbackErrors: (Error | null)[] = [];
  // When set, the next loopback stream opened echoes every written byte back as output (one-shot).
  echoNextLoopback = false;
  private n = 0;
  private startKeys = new Map<string, SandboxHandle>();
  // The ordered one-shot fault plan; empty unless options.faults was given or a test adds to it.
  readonly faults: FaultPlan;
  // Every fault-injectable operation call in order, recorded before its fault (if any) takes effect.
  ops: SandboxOpCall[] = [];
  // Accepted file content by sandbox id and path (remote mode); a rejected or partial transfer leaves nothing here.
  readonly fileStore = new Map<SandboxId, Map<string, Uint8Array>>();
  // Connect channels opened per sandbox id, in open order (remote mode).
  channels = new Map<SandboxId, FakeChannel[]>();
  private putKeys = new Set<string>();
  private readonly derivedIds: boolean;
  // The sandbox ids in the fake's store, in creation order (exited ones included).
  get sandboxes(): SandboxId[] {
    return [...this.running.keys()];
  }
  constructor(exitCodes: number[] = [], stopPolicy: SandboxStop = "graceful", options: FakeSandboxOptions = {}) {
    this.exitCodes = [...exitCodes];
    this.stopPolicy = stopPolicy;
    this.faults = options.faults ?? new FaultPlan();
    const remote = options.remote === true;
    this.derivedIds = remote || options.derivedIds === true;
    this.declaration = fakeSandboxDeclaration({
      ...options.declaration,
      ...(remote ? { capabilities: { connect: true, "files.put": true, "files.get": true, ...options.declaration?.capabilities } } : {}),
    });
    const facets: { [K in keyof SandboxFacets]?: SandboxFacets[K] | undefined } = {
      terminal: {
        open: async (id, size): Promise<TerminalSession> => {
          const s = this.running.get(id);
          if (!s || s.exitCode !== null) throw new SandboxUnavailableError();
          const t = new FakeTerminal(size);
          this.terminals.set(id, [...(this.terminals.get(id) ?? []), t]);
          void s.done.then(() => t.end());
          return t;
        },
      },
      loopback: {
        open: async (id, port): Promise<ByteStream> => {
          this.loopbackCalls.push({ id, port });
          if (!(LOOPBACK_PORTS as readonly number[]).includes(port)) throw new RangeError(`loopback port ${port} is not in LOOPBACK_PORTS`);
          const s = this.running.get(id);
          if (!s || s.exitCode !== null) throw new SandboxUnavailableError();
          if (this.loopbackErrors.length > 0) {
            const err = this.loopbackErrors.shift();
            if (err) throw err;
          }
          const b = new FakeByteStream();
          if (this.echoNextLoopback) {
            b.echo = true;
            this.echoNextLoopback = false;
          }
          this.loopbackStreams.set(id, [...(this.loopbackStreams.get(id) ?? []), b]);
          void s.done.then(() => b.end());
          return b;
        },
      },
      ...(remote ? { connect: this.remoteConnect(), files: this.remoteFiles() } : {}),
      ...options.facets,
    };
    for (const k of Object.keys(facets) as (keyof SandboxFacets)[]) {
      if (facets[k] !== undefined) Object.assign(this, { [k]: facets[k] });
    }
    this.probeResult = options.probe;
    if (options.probe !== undefined) {
      this.probe = async (runtime) => {
        this.probeCalls.push(runtime);
        const fault = this.fault("probe", {});
        if (fault?.kind === "timeout") await this.faults.hold("probe");
        return structuredClone(this.probeResult ?? { withheld: [], problems: [], account: null });
      };
    }
  }
  // Records the call, then takes the next matching fault: an error fault throws here, and any other kind is returned for the caller
  // to apply (a timeout is awaited by the caller through this.faults.hold). No await on the fault-free path, so a call without a
  // fault mutates the fake synchronously exactly as it did before fault injection existed.
  private fault(op: FaultOp, call: { key?: string; id?: SandboxId }, extra: Partial<SandboxOpCall> = {}) {
    this.ops.push({ op, ...call, ...extra });
    const fault = this.faults.take(op, call);
    if (fault?.kind === "error") throw fault.error;
    return fault;
  }
  private preempt(id: SandboxId) {
    const err = preemptedError(id);
    this.waitErrors.set(id, err);
    this.statuses.set(id, "preempted");
    for (const c of this.channels.get(id) ?? []) c.end(err);
    this.running.get(id)?.finish(137);
  }
  async start(spec: SandboxSpec, idempotencyKey: string): Promise<SandboxHandle> {
    const fault = this.fault("start", { key: idempotencyKey });
    if (fault?.kind === "timeout") await this.faults.hold("start");
    if (fault?.kind === "unknown-outcome" && !fault.applied) throw new SandboxOutcomeUnknownError(this.nextIdFor(idempotencyKey), idempotencyKey);
    const handle = this.create(spec, idempotencyKey);
    if (fault?.kind === "unknown-outcome") throw new SandboxOutcomeUnknownError(handle.id, idempotencyKey);
    if (fault?.kind === "preempt") this.preempt(handle.id);
    if (fault?.kind === "duplicate-key") return this.start(spec, idempotencyKey);
    return handle;
  }
  // The id a start with this key has or will get: the existing sandbox's, else the derived id, else the next sbx-N (exact unless
  // another sandbox is created in between).
  private nextIdFor(idempotencyKey: string): SandboxId {
    return this.startKeys.get(idempotencyKey)?.id ?? (this.derivedIds ? sandboxIdForKey(idempotencyKey) : `sbx-${this.n + 1}`);
  }
  private create(spec: SandboxSpec, idempotencyKey: string): SandboxHandle {
    const prior = this.startKeys.get(idempotencyKey);
    if (prior) return prior;
    for (const k of Object.keys(spec.labels ?? {}))
      if (!/^[A-Za-z0-9_.-]+$/.test(k) || k.startsWith("pomtree")) throw new Error(`invalid sandbox label name: ${k}`);
    ownerStampTags(spec); // a host or generation no real adapter could stamp is refused here too, before anything is created
    if (this.startErrors.length > 0) {
      const err = this.startErrors.shift();
      if (err) throw err;
    }
    this.started.push(spec);
    const id = this.derivedIds ? sandboxIdForKey(idempotencyKey) : `sbx-${++this.n}`;
    let resolveWait!: (v: { exitCode: number; oomKilled?: boolean }) => void;
    const done = new Promise<{ exitCode: number; oomKilled?: boolean }>((r) => {
      resolveWait = r;
    });
    const st = {
      agent: spec.agent,
      host: spec.host,
      generation: spec.generation,
      ...(spec.labels && Object.keys(spec.labels).length ? { labels: { ...spec.labels } } : {}),
      exitCode: null as number | null,
      oomKilled: false,
      done,
      finish(c: number) {
        if (this.exitCode !== null) return; // first exit wins; later stop/kill/exit never overwrite
        this.exitCode = c;
        resolveWait({ exitCode: c, ...(this.oomKilled ? { oomKilled: true } : {}) });
      },
    };
    this.running.set(id, st);
    const code = this.exitCodes.shift();
    if (code !== undefined) queueMicrotask(() => st.finish(code));
    const handle: SandboxHandle = {
      id,
      output: async function* () {},
      wait: () => this.waitFor(id, done),
    };
    this.startKeys.set(idempotencyKey, handle);
    return handle;
  }
  // Re-adopt an existing live container after a daemon restart; unavailable when not running.
  async attach(id: SandboxId, _agent: AgentId): Promise<SandboxHandle> {
    const s = this.running.get(id);
    if (!s || s.exitCode !== null) throw new SandboxUnavailableError();
    return { id, output: async function* () {}, wait: () => this.waitFor(id, s.done) };
  }
  private waitFor(id: SandboxId, done: Promise<{ exitCode: number; oomKilled?: boolean }>) {
    let fault: ReturnType<FakeSandbox["fault"]>;
    try {
      fault = this.fault("wait", { id });
    } catch (e) {
      return Promise.reject(e);
    }
    if (fault?.kind === "preempt") this.preempt(id);
    if (fault?.kind === "timeout") return this.faults.hold("wait");
    const err = this.waitErrors.get(id);
    return err ? Promise.reject(err) : done;
  }
  // Test hook: end a sandbox that has no scripted exit code; oomKilled marks an OOM exit.
  exit(id: SandboxId, code: number, oomKilled = false) {
    const s = this.running.get(id);
    if (s) {
      s.oomKilled = oomKilled;
      s.finish(code);
    }
  }
  async stop(id: SandboxId, graceMs: number, idempotencyKey: string): Promise<void> {
    this.stopCalls.push({ id, graceMs, idempotencyKey });
    const fault = this.fault("stop", { id, key: idempotencyKey });
    if (fault?.kind === "timeout") await this.faults.hold("stop");
    const s = this.running.get(id);
    if (!s || s.exitCode !== null) return; // unknown or already-exited: Docker's stop is a no-op
    if (this.stopPolicy === "graceful") s.finish(0);
    else if (this.stopPolicy === "sigterm") s.finish(143);
    else
      await new Promise<void>((r) =>
        setTimeout(
          () => {
            s.finish(137);
            r();
          },
          Math.max(0, graceMs),
        ),
      );
  }
  async kill(id: SandboxId, idempotencyKey: string): Promise<void> {
    this.killCalls.push({ id, idempotencyKey });
    const fault = this.fault("kill", { id, key: idempotencyKey });
    if (fault?.kind === "timeout") await this.faults.hold("kill");
    const s = this.running.get(id);
    if (!s || s.exitCode !== null) return;
    s.finish(137);
  }
  // Scripted inspect() failures by sandbox id (a container whose state cannot be read); the entry stays until deleted.
  inspectErrors = new Map<SandboxId, Error>();
  // Scripted runtime status by sandbox id, reported by inspect() in place of the lifecycle's own "running"/"exited" (e.g.
  // created, paused, restarting, dead, or an unrecognized string); null omits status. `running` follows Docker: true for
  // running, paused and restarting, false for created, exited and dead, otherwise the lifecycle's. The lifecycle is unchanged.
  statuses = new Map<SandboxId, string | null>();
  async inspect(id: SandboxId) {
    const fault = this.fault("inspect", { id });
    if (fault?.kind === "timeout") await this.faults.hold("inspect");
    if (fault?.kind === "preempt") this.preempt(id);
    const err = this.inspectErrors.get(id);
    if (err) throw err;
    const s = this.running.get(id);
    if (!s) return null;
    const scripted = this.statuses.get(id);
    const status = scripted === undefined ? (s.exitCode === null ? "running" : "exited") : scripted;
    const running = ["running", "paused", "restarting"].includes(status ?? "")
      ? true
      : ["created", "exited", "dead"].includes(status ?? "")
        ? false
        : s.exitCode === null;
    return {
      running,
      exitCode: running ? null : s.exitCode,
      ...(s.oomKilled ? { oomKilled: true } : {}),
      ...(status !== null ? { status } : {}),
      host: s.host,
      generation: s.generation,
    };
  }
  // engineLocalId is the scripted value or `${ref}@sha256:fake`; configDigest is the sha256 of the ref; revision is null.
  async imageIdentity(ref: string): Promise<ImageIdentity> {
    return {
      configDigest: `sha256:${createHash("sha256").update(ref).digest("hex")}`,
      revision: null,
      engineLocalId: this.engineLocalIds.get(ref) ?? `${ref}@sha256:fake`,
    };
  }
  // `docker ps -a` lists exited containers too, so the fake keeps self-exited sandboxes. Host and generation are the stamp start()
  // recorded from the spec, as every real adapter reports them.
  async list(owner: SandboxOwner): Promise<SandboxListing[]> {
    this.listOwners.push({ ...owner });
    const fault = this.fault("list", {});
    if (fault?.kind === "timeout") await this.faults.hold("list");
    return [...this.running]
      .filter(([, s]) => {
        // Same exclusion rule as DockerSandbox.list: a store_id label other than the owner's, or a daemon_epoch label newer
        // than the owner's, marks a sandbox someone else owns; unlabelled sandboxes are included.
        const store = s.labels?.store_id;
        if (store !== undefined && store !== owner.storeId) return false;
        const epoch = Number(s.labels?.daemon_epoch);
        return !(Number.isFinite(epoch) && epoch > owner.epoch);
      })
      .map(([id, s]) => {
        const status = this.statuses.get(id);
        const state: SandboxListing["state"] =
          status === "paused"
            ? "paused"
            : status === "created"
              ? "creating"
              : s.exitCode !== null
                ? "exited"
                : status === undefined || status === "running"
                  ? "running"
                  : "unknown";
        return {
          id,
          agent: s.agent,
          backend: this.declaration.backend,
          host: s.host,
          generation: s.generation,
          state,
          ...(s.labels ? { labels: { ...s.labels } } : {}),
        };
      });
  }
  private remoteConnect(): NonNullable<SandboxFacets["connect"]> {
    return {
      open: async (id, channel) => {
        const fault = this.fault("connect", { id }, { channel });
        if (fault?.kind === "timeout") await this.faults.hold("connect");
        const s = this.running.get(id);
        if (!s || s.exitCode !== null) throw new SandboxUnavailableError("not-found");
        const c = new FakeChannel(id, channel, fault?.kind === "drop" ? fault.afterBytes : undefined);
        this.channels.set(id, [...(this.channels.get(id) ?? []), c]);
        void s.done.then(() => c.end());
        return c;
      },
    };
  }
  private remoteFiles(): NonNullable<SandboxFacets["files"]> {
    return {
      put: async (id, path, body, sha256, idempotencyKey) => {
        const fault = this.fault("files.put", { id, key: idempotencyKey }, { path });
        if (fault?.kind === "timeout") await this.faults.hold("files.put");
        const s = this.running.get(id);
        if (!s || s.exitCode !== null) throw new SandboxUnavailableError("not-found");
        // Idempotent by key per sandbox and path: a repeat accepts nothing new, but a transfer fault planned for it still fires.
        const putKey = `${id}\0${path}\0${idempotencyKey}`;
        if (this.putKeys.has(putKey) && fault?.kind !== "partial" && fault?.kind !== "hash-mismatch") return;
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of body) {
          chunks.push(chunk);
          size += chunk.length;
          if (fault?.kind === "partial" && size >= fault.afterBytes) throw new SandboxTransferError(id, "partial");
        }
        if (fault?.kind === "partial") throw new SandboxTransferError(id, "partial");
        const data = Buffer.concat(chunks);
        if (fault?.kind === "hash-mismatch" || createHash("sha256").update(data).digest("hex") !== sha256) throw new SandboxTransferError(id, "hash-mismatch");
        const files = this.fileStore.get(id) ?? new Map<string, Uint8Array>();
        files.set(path, data);
        this.fileStore.set(id, files);
        this.putKeys.add(putKey);
      },
      get: async (id, path, maxBytes) => {
        const fault = this.fault("files.get", { id }, { path });
        if (fault?.kind === "timeout") await this.faults.hold("files.get");
        const data = this.fileStore.get(id)?.get(path);
        if (!data) throw new SandboxUnavailableError("not-found", `sandbox ${id} has no file ${path}; put it first or check the path`);
        if (data.length > maxBytes) throw new SandboxTransferError(id, "too-large");
        const cut = fault?.kind === "partial" ? fault.afterBytes : undefined;
        return {
          body: (async function* () {
            yield cut === undefined ? data : data.subarray(0, cut);
            if (cut !== undefined) throw new SandboxTransferError(id, "partial");
          })(),
          // A hash-mismatch fault reports a sha256 that does not match the body; the caller verifies, as the port requires.
          sha256: Promise.resolve(
            createHash("sha256")
              .update(fault?.kind === "hash-mismatch" ? Buffer.concat([data, Buffer.from("corrupt")]) : data)
              .digest("hex"),
          ),
        };
      },
    };
  }
  // Scripted: the sandbox ids the next reclaim() reports as reclaimed (the fake owns no adapter-side resources).
  egressOrphans: SandboxId[] = [];
  reclaimEgressCalls = 0;
  reclaimOwners: SandboxOwner[] = [];
  async reclaim(owner: SandboxOwner): Promise<SandboxId[]> {
    this.reclaimEgressCalls++;
    this.reclaimOwners.push({ ...owner });
    return this.egressOrphans.splice(0);
  }
}

export class FakeHarness implements Harness {
  events: Record<AgentId, HarnessEvent[]>;
  steered: { agent: AgentId; message: string }[] = [];
  stopped: AgentId[] = [];
  starts: { agent: AgentId; prompt: string }[] = [];
  resumes: { agent: AgentId; sessionRef: string; wake: string }[] = [];
  constructor(events: Record<AgentId, HarnessEvent[]> = {}) {
    this.events = events;
  }
  private session(agent: AgentId): HarnessSession {
    const evs = this.events[agent] ?? [];
    return {
      session: `session-${agent}`,
      events: async function* () {
        yield* evs;
      },
      steer: async (message) => {
        this.steered.push({ agent, message });
      },
      stop: async () => {
        this.stopped.push(agent);
      },
    };
  }
  async start(o: { agent: AgentId; sandbox: SandboxHandle; prompt: string }) {
    this.starts.push({ agent: o.agent, prompt: o.prompt });
    return this.session(o.agent);
  }
  async resume(o: { agent: AgentId; sandbox: SandboxHandle; sessionRef: string; wake: string }) {
    this.resumes.push({ agent: o.agent, sessionRef: o.sessionRef, wake: o.wake });
    return this.session(o.agent);
  }
}

export class FakeOrchestrator implements Orchestrator {
  started: { agent: AgentId; generation: number }[] = [];
  waits: { agent: AgentId; cond: WaitCondition }[] = [];
  wakes: { agent: AgentId; signal: Signal }[] = [];
  cancels: { agent: AgentId; graceMs: number }[] = [];
  async start(agent: AgentId, generation: number) {
    this.started.push({ agent, generation });
  }
  async waitFor(agent: AgentId, cond: WaitCondition) {
    this.waits.push({ agent, cond });
  }
  async wake(agent: AgentId, signal: Signal) {
    this.wakes.push({ agent, signal });
  }
  async cancel(agent: AgentId, graceMs: number) {
    this.cancels.push({ agent, graceMs });
  }
}

// In-memory Workspace: folders (with a base commit), refs/agents/<id>/heads/* refs and an ingest log.
// The fake "bundle" is JSON bytes `{"refs":[{"name":"agent/a","commit":"x"}]}` (see fakeBundle); any other
// bytes ingest as one ref `agent/<id>` with a generated commit. Scripted results (`ingestResults`) are
// consumed in order and take precedence. Calls are recorded by createFakes' wrapper.
export class FakeWorkspace implements Workspace {
  workspaces = new Map<AgentId, { branch: string; commit: string }>(); // folders on this node
  refs = new Map<string, string>(); // refs/agents/<id>/heads/<name> -> commit (the mirror)
  ingestLog: { agent: AgentId; ref: string; commit: string }[] = []; // ingest order
  ancestors = new Map<string, Set<string>>(); // commit -> its ancestors, learned from fakeBundle `parent` fields
  defaultRef = "refs/heads/main"; // set `refs` at this name to give publish a default-branch commit
  ingestResults: IngestResult[] = []; // scripted, consumed in order
  published: { agent: AgentId; commit: string; remote: string; target: string; reviewed?: PublishReview }[] = [];
  // Scriptable: agent ids whose ref tips are considered merged into the root (prunable).
  merged = new Set<AgentId>();
  private n = 0;
  private check(agent: AgentId) {
    if (!agent || /[\/\\\0]/.test(agent) || agent.includes("..") || agent.startsWith("-") || agent.startsWith(".")) {
      throw new Error(`invalid agent id for workspace: ${JSON.stringify(agent)}`);
    }
  }
  private workspaceId(agent: AgentId): WorkspaceId {
    return `ws-${agent}`;
  }
  private prefix(agent: AgentId) {
    return `refs/agents/${agent}/heads/`;
  }
  async create(agent: AgentId, o: { fromCommit?: string }) {
    this.check(agent);
    const prior = this.workspaces.get(agent);
    if (prior) {
      if (o.fromCommit && o.fromCommit !== prior.commit) {
        throw new Error(`workspace ${agent} already exists at ${prior.commit}, not requested ${o.fromCommit}`);
      }
      return { branch: prior.branch, commit: prior.commit, workspace: this.workspaceId(agent) };
    }
    const commit = o.fromCommit ?? "c0";
    this.workspaces.set(agent, { branch: `agent/${agent}`, commit });
    return { branch: `agent/${agent}`, commit, workspace: this.workspaceId(agent) };
  }
  async fork(parent: AgentId, child: AgentId) {
    this.check(parent);
    this.check(child);
    const p = this.workspaces.get(parent);
    if (!p) throw new Error(`no workspace for ${parent}`);
    const prior = this.workspaces.get(child);
    if (prior) return { branch: prior.branch, commit: prior.commit, workspace: this.workspaceId(child) };
    this.workspaces.set(child, { branch: `agent/${child}`, commit: p.commit });
    return { branch: `agent/${child}`, commit: p.commit, workspace: this.workspaceId(child) };
  }
  async has(agent: AgentId) {
    this.check(agent);
    return this.workspaces.has(agent);
  }
  async list() {
    return [...this.workspaces.keys()];
  }
  async evict(agent: AgentId) {
    this.check(agent);
    this.workspaces.delete(agent);
  }
  async ingest(agent: AgentId, bundle: AsyncIterable<Uint8Array>, o: { maxBytes: number; force?: boolean }): Promise<IngestResult> {
    this.check(agent);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const c of bundle) {
      size += c.byteLength;
      if (size > o.maxBytes) return { ok: false, code: "too_large", message: `bundle exceeds ${o.maxBytes} bytes` };
      chunks.push(c);
    }
    const scripted = this.ingestResults.shift();
    if (scripted) return structuredClone(scripted);
    if (!this.workspaces.has(agent)) return { ok: false, code: "unknown", message: `no workspace for ${agent}` };
    let want: { name: string; commit: string; parent?: string }[];
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { refs: { name: string; commit: string; parent?: string }[] };
      want = j.refs;
    } catch {
      want = [{ name: `agent/${agent}`, commit: `i${++this.n}` }];
    }
    if (!Array.isArray(want) || want.length === 0) return { ok: false, code: "bad_bundle", message: "bundle has no refs" };
    const refs: { ref: string; commit: string }[] = [];
    for (const r of want) {
      if (typeof r.name !== "string" || !r.name || r.name.includes("..") || r.name.startsWith("/") || r.name === "HEAD") {
        return { ok: false, code: "bad_ref", message: `bad ref name ${JSON.stringify(r.name)}` };
      }
      refs.push({ ref: this.prefix(agent) + r.name, commit: r.commit });
    }
    const forcedFrom: ForcedRefUpdate[] = []; // parity with GitWorkspace: a forced update names the tip it overwrote
    for (const l of want) if (l.parent !== undefined) this.ancestors.set(l.commit, new Set([l.parent, ...(this.ancestors.get(l.parent) ?? [])]));
    for (const r of refs) {
      const cur = this.refs.get(r.ref);
      if (cur === undefined || cur === r.commit || this.ancestors.get(r.commit)?.has(cur)) continue;
      if (!o.force) return { ok: false, code: "non_fast_forward", message: `${r.ref} would move from ${cur} to ${r.commit}, which does not descend from it` };
      forcedFrom.push({ ref: r.ref, from: cur, to: r.commit });
    }
    for (const r of refs) {
      this.refs.set(r.ref, r.commit);
      this.ingestLog = this.ingestLog.filter((e) => e.ref !== r.ref);
      this.ingestLog.push({ agent, ...r });
    }
    return forcedFrom.length > 0 ? { ok: true, refs, forced: true, forcedFrom } : { ok: true, refs };
  }
  async ingested(agent: AgentId) {
    this.check(agent);
    const last = this.ingestLog.filter((e) => e.agent === agent).at(-1);
    const now = last ? this.refs.get(last.ref) : undefined; // the ref's current tip, whoever moved it
    return last && now !== undefined ? { ref: last.ref, commit: now } : null;
  }
  async serve(agent: AgentId, o?: { scope?: AgentId }): Promise<AsyncIterable<Uint8Array>> {
    this.check(agent);
    const scope = o?.scope ?? agent;
    this.check(scope);
    const refs = [...this.refs].filter(([r]) => r.startsWith(this.prefix(scope))).map(([name, commit]) => ({ name, commit }));
    const bytes = new TextEncoder().encode(JSON.stringify({ refs }));
    return (async function* () {
      yield bytes;
    })();
  }
  async resolve(agent: AgentId, ref: string) {
    this.check(agent);
    const commit = ref.startsWith(this.prefix(agent)) ? this.refs.get(ref) : undefined;
    if (!commit) throw new Error(`unknown ref ${ref} for ${agent}`);
    return { commit, diffstat: "", subject: `fake ${commit}`, paths: [] };
  }
  async publish(agent: AgentId, push: { commit: string; remote: string; target: string; reviewed?: PublishReview }) {
    this.check(agent);
    const def = this.refs.get(this.defaultRef);
    const reachable =
      [...this.refs].some(([r, c]) => r.startsWith(this.prefix(agent)) && c === push.commit) ||
      (def !== undefined && (def === push.commit || (this.ancestors.get(def)?.has(push.commit) ?? false)));
    if (!reachable) throw new Error(`commit ${push.commit} is not reachable from ${agent}'s refs`);
    this.published.push({ agent, ...push });
  }
  // Deletes the agent's refs only when scripted as merged ("pruned"); no refs is "nothing"; unmerged refs or the merge target itself is "refused".
  async prune(agent: AgentId, opts: { mergedInto: AgentId }): Promise<PruneResult> {
    this.check(agent);
    this.check(opts.mergedInto);
    if (agent === opts.mergedInto) return "refused";
    const mine = [...this.refs.keys()].filter((r) => r.startsWith(this.prefix(agent)));
    if (mine.length === 0) return "nothing";
    if (!this.merged.has(agent)) return "refused";
    for (const r of mine) this.refs.delete(r);
    this.ingestLog = this.ingestLog.filter((e) => e.agent !== agent);
    return "pruned";
  }
}

// Bundle bytes the FakeWorkspace understands; the real GitWorkspace suite supplies git bundles instead.
export function fakeBundle(refs: { name: string; commit: string; parent?: string }[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ refs }));
}

// The issue refusals of pomtreed's ProxyCredentialGateway, word for word. pomtreed cannot import testing at runtime, so this is the
// single definition the fake throws and modelGatewayContractBody asserts against both the fake and the real gateway.
export const ISSUE_REFUSAL = {
  terminal: (agent: AgentId, state: string) => `agent ${agent} is ${state}; no model credential is issued`,
  unregistered: (agent: AgentId) =>
    `agent ${agent} is not registered; no model credential is issued: register the agent with a spec.model before issuing a credential`,
  deterministic: (agent: AgentId) => `agent ${agent} is a deterministic agent and makes no model calls; no model credential is issued`,
  noModel: (agent: AgentId) =>
    `agent ${agent} has no model resolved (no model catalog is wired, or its spec names no model); no model credential is issued: spawn it with a model (--model PROVIDER/ID), a template or daemon default model, or wire a model catalog`,
} as const;

// With a registry (createFakes wires its own), `issueKey` refuses exactly as the real gateway does: a terminal, unregistered,
// deterministic or model-less agent gets no key (ISSUE_REFUSAL). Without one (a bare `new FakeModelGateway()`), any agent issues.
export class FakeModelGateway implements ModelGateway {
  private readonly registry?: Pick<Registry, "get">;
  constructor(registry?: Pick<Registry, "get">) {
    this.registry = registry;
  }
  budgets = new Map<AgentId, { budget: number; spent: number }>();
  // Credentials are cached by AGENT plus idempotency key, as ProxyCredentialGateway does: one key replayed for two agents must
  // issue each its own credential. Caching by the key alone handed the second agent a credential scoped to the first.
  private issueKeys = new Map<string, { key: string; baseUrl: string }>();
  private static cacheKey(agent: AgentId, idempotencyKey: string): string {
    return JSON.stringify([agent, idempotencyKey]);
  }
  async issueKey(agent: AgentId, budgetMicros: number, idempotencyKey?: string) {
    if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 0) throw new Error("budgetMicros must be a non-negative safe integer");
    if (this.registry) {
      const rec = await this.registry.get(agent);
      if (rec?.state === "exited" || rec?.state === "reaped") throw new Error(ISSUE_REFUSAL.terminal(agent, rec.state));
      if (!rec) throw new Error(ISSUE_REFUSAL.unregistered(agent));
      if (rec.executor === "deterministic") throw new Error(ISSUE_REFUSAL.deterministic(agent));
      if (rec.spec.model === undefined) throw new Error(ISSUE_REFUSAL.noModel(agent));
    }
    const cacheKey = idempotencyKey === undefined ? undefined : FakeModelGateway.cacheKey(agent, idempotencyKey);
    const prior = cacheKey === undefined ? undefined : this.issueKeys.get(cacheKey);
    if (prior) return { ...prior }; // a replay never re-issues (and so never resets spend)
    this.budgets.set(agent, { budget: budgetMicros, spent: 0 });
    const out = { key: `key-${agent}`, baseUrl: "http://fake-gateway" };
    if (cacheKey !== undefined) this.issueKeys.set(cacheKey, out);
    return { ...out };
  }
  // Test hook: record spend.
  addSpend(agent: AgentId, micros: number) {
    const b = this.budgets.get(agent);
    if (b) b.spent += micros;
  }
  // An agent that holds no credential has spent nothing; its cap is the one it was registered with, which exists before any
  // credential does (ProxyCredentialGateway.spend reads the registry for exactly that, and 0 for an agent no registry knows).
  async spend(agent: AgentId) {
    const b = this.budgets.get(agent);
    if (!b) return { spentMicros: 0, budgetMicros: (await this.registry?.get(agent))?.budgetMicros ?? 0 };
    return { spentMicros: b.spent, budgetMicros: b.budget };
  }
  // Scripted informational catalog prices for zero-cost usage events, consumed in order (default null:
  // unpriced). Every call is recorded.
  priceUsageResults: (number | null)[] = [];
  priceUsageCalls: { model?: string; inputTokens: number; outputTokens: number }[] = [];
  async priceUsage(usage: { model?: string; inputTokens: number; outputTokens: number }): Promise<number | null> {
    this.priceUsageCalls.push({ ...usage });
    return this.priceUsageResults.length > 0 ? (this.priceUsageResults.shift() ?? null) : null;
  }
  // Revocation is an idempotent cleanup: there is always an answer, including for an agent that holds no credential (nothing
  // was issued, so the whole registered budget is unused). The spend record outlives the revoke, as the durable ledger's does,
  // so a second revoke answers the same number.
  async revoke(agent: AgentId) {
    const b = this.budgets.get(agent);
    if (!b) return { unusedMicros: (await this.registry?.get(agent))?.budgetMicros ?? 0 };
    return { unusedMicros: Math.max(0, b.budget - b.spent) };
  }
}

// In-memory ModelDebitStore that mirrors RequestBudget's per-agent accounting and the durable
// store's authorize/revoke. Scripted results (`reserveResults`/`settleResults`/`cancelResults`) are
// consumed in order and short-circuit the stateful logic; otherwise the real semantics run and
// every call is recorded in `calls`. Without a registry the ledger is flat: every bucket is a root, so `ledgerFor` reads a bucket's own
// cap, as the durable store does for an agent its registry does not know. With one, `ledgerFor` builds the nodes as store-sqlite's
// `ledgerView` does: each registered agent contributes its registered cap, parent and liveness, with its bucket's use (0 when it has
// none), and a bucket for an unregistered agent stays a root.
export class FakeModelDebitStore implements DurableModelDebitStore {
  calls: {
    method:
      | "authorize"
      | "checkCredential"
      | "issue"
      | "revoke"
      | "reserve"
      | "settle"
      | "cancel"
      | "expireReservations"
      | "spentFor"
      | "setBudget"
      | "recordCall"
      | "touch"
      | "ledgerFor"
      | "settledCall";
    args: unknown[];
  }[] = [];
  reserveResults: ReserveResult[] = [];
  settleResults: SettleResult[] = [];
  cancelResults: boolean[] = [];
  touchResults: boolean[] = [];
  // Scripted `issue` stamps, consumed in order before the real atomic rule runs (like the other scripts above).
  issueResults: number[] = [];
  // Metadata last recorded per call, keyed by [agent, requestId]; a replay overwrites.
  readonly callMeta = new Map<string, ModelCallMeta>();
  private readonly secret: string;
  private readonly now: () => number;
  private readonly revoked = new Map<AgentId, number>();
  private readonly issued = new Map<AgentId, number>();
  private readonly agents = new Map<AgentId, FakeAgentState>();
  private readonly registry?: FakeRegistry;

  constructor(options: { secret: string; now?: () => number; registry?: FakeRegistry }) {
    if (!options.secret) throw new Error("secret is required");
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.registry = options.registry;
  }

  private credentialOf(key: string): GatewayCredential | null {
    const credential = decodeGatewayCredential(this.secret, key, this.now());
    if (!credential) return null;
    const at = this.revoked.get(credential.agent);
    return at !== undefined && credential.issuedAt <= at ? null : credential;
  }

  authorize(key: string): GatewayCredential | null {
    this.calls.push({ method: "authorize", args: [key] });
    return this.credentialOf(key);
  }

  // Same rule as the durable store: verify (invalid | expired) first, then the revocation cutoff.
  checkCredential(key: string): CredentialCheck {
    this.calls.push({ method: "checkCredential", args: [key] });
    const r = verifyGatewayCredential(this.secret, key, this.now());
    if (!r.ok) return r;
    const at = this.revoked.get(r.credential.agent);
    return at !== undefined && r.credential.issuedAt <= at ? { ok: false, reason: "revoked" } : r;
  }

  // Same rule as the durable store: strictly after the revocation, never below the latest stamp handed out.
  issue(agent: AgentId, clockMs: number): number {
    this.calls.push({ method: "issue", args: [agent, clockMs] });
    if (this.issueResults.length > 0) return this.issueResults.shift()!;
    if (!Number.isSafeInteger(clockMs)) throw new Error("issue clock must be a safe integer");
    const stamp = Math.max(clockMs, (this.revoked.get(agent) ?? -Infinity) + 1, this.issued.get(agent) ?? clockMs);
    if (!Number.isSafeInteger(stamp)) throw new Error("issued stamp is not a safe integer");
    this.issued.set(agent, stamp);
    return stamp;
  }

  revoke(agent: AgentId): void {
    this.calls.push({ method: "revoke", args: [agent] });
    this.revoked.set(agent, Math.max(this.revoked.get(agent) ?? 0, this.now(), this.issued.get(agent) ?? 0));
  }

  reserve(key: string, requestId: string, maximumMicros: number): ReserveResult {
    this.calls.push({ method: "reserve", args: [key, requestId, maximumMicros] });
    if (this.reserveResults.length > 0) return this.reserveResults.shift()!;
    const credential = this.credentialOf(key);
    if (!credential) return { ok: false, reason: "invalid-credential" };
    if (!validDebitRequestId(requestId) || !validDebitMicros(maximumMicros)) return { ok: false, reason: "invalid-request" };
    const state = this.agentState(credential);
    const existing = state.requests.get(requestId);
    // Request ids are single-use: a replay of a reserved, settled or cancelled id never re-authorizes.
    if (existing) return { ok: false, reason: "idempotency-conflict" };
    if (maximumMicros > state.budgetMicros - state.spentMicros - state.reservedMicros) return { ok: false, reason: "budget-exhausted" };
    state.requests.set(requestId, { credentialId: credential.id, maximumMicros, status: "reserved", createdAt: this.now() });
    state.reservedMicros += maximumMicros;
    return { ok: true, reservation: this.reservation(credential, requestId), remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros };
  }

  settle(reservation: RequestReservation, chargedMicros: number): SettleResult {
    this.calls.push({ method: "settle", args: [reservation, chargedMicros] });
    if (this.settleResults.length > 0) return this.settleResults.shift()!;
    if (!validDebitMicros(chargedMicros)) return { ok: false, reason: "invalid-charge" };
    const state = this.agents.get(reservation.agent);
    const request = state?.requests.get(reservation.requestId);
    if (!state || !request || request.credentialId !== reservation.credentialId) return { ok: false, reason: "unknown-reservation" };
    if (request.status === "settled")
      return { ok: true, chargedMicros: request.chargedMicros!, remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros };
    if (request.status === "expired-charged") {
      // Expiry already charged the full reservation (fail-closed); a late settle only tops up a true overage.
      const extra = Math.max(0, chargedMicros - request.chargedMicros!);
      state.spentMicros += extra;
      request.chargedMicros! += extra;
      return {
        ok: true,
        chargedMicros: request.chargedMicros!,
        remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros,
        expiredCharged: true,
      };
    }
    if (request.status !== "reserved") return { ok: false, reason: "unknown-reservation" };
    // True overage is recorded in full (remaining may go negative), never clamped to the reservation.
    state.reservedMicros -= request.maximumMicros;
    state.spentMicros += chargedMicros;
    request.status = "settled";
    request.chargedMicros = chargedMicros;
    return { ok: true, chargedMicros, remainingMicros: state.budgetMicros - state.spentMicros - state.reservedMicros };
  }

  // Same rule as the durable store: false for a request id never reserved; otherwise the metadata replaces any earlier record.
  recordCall(agent: AgentId, requestId: string, meta: ModelCallMeta): boolean {
    this.calls.push({ method: "recordCall", args: [agent, requestId, meta] });
    if (!this.agents.get(agent)?.requests.has(requestId)) return false;
    this.callMeta.set(JSON.stringify([agent, requestId]), structuredClone(meta));
    return true;
  }

  // Same rule as the durable store: marks an in-flight reservation alive; false unless it is reserved under that credential.
  touch(reservation: RequestReservation): boolean {
    this.calls.push({ method: "touch", args: [reservation] });
    if (this.touchResults.length > 0) return this.touchResults.shift()!;
    const request = this.agents.get(reservation.agent)?.requests.get(reservation.requestId);
    if (!request || request.credentialId !== reservation.credentialId || request.status !== "reserved") return false;
    request.touchedAt = this.now();
    return true;
  }

  // Same rule as the durable store: the earliest-reserved settled or expired-charged call of this agent whose recorded
  // responseId matches exactly; null otherwise.
  settledCall(agent: AgentId, responseId: string): { requestId: string; chargedMicros: number } | null {
    this.calls.push({ method: "settledCall", args: [agent, responseId] });
    for (const [requestId, request] of this.agents.get(agent)?.requests ?? [])
      if (
        (request.status === "settled" || request.status === "expired-charged") &&
        request.chargedMicros !== undefined &&
        this.callMeta.get(JSON.stringify([agent, requestId]))?.responseId === responseId
      )
        return { requestId, chargedMicros: request.chargedMicros };
    return null;
  }

  // The core ledger over the buckets: committed is spend plus reservations. Registered agents (when a registry was given) carry their
  // registered cap, parent and liveness even with no bucket; every other bucket is a root.
  ledgerFor(agent: AgentId): AgentLedger {
    this.calls.push({ method: "ledgerFor", args: [agent] });
    const used = (a: FakeAgentState | undefined) => (a ? a.spentMicros + a.reservedMicros : 0);
    const nodes: LedgerNode[] = [];
    for (const r of this.registry?.agents.values() ?? [])
      nodes.push({ id: r.id, parent: r.parent ?? null, budgetMicros: r.budgetMicros, live: r.state !== "reaped", usedMicros: used(this.agents.get(r.id)) });
    for (const [id, a] of this.agents)
      if (!this.registry?.agents.has(id)) nodes.push({ id, parent: null, budgetMicros: a.budgetMicros, live: true, usedMicros: used(a) });
    const view = budgetLedger(nodes);
    const budgetMicros = view.node(agent)?.budgetMicros ?? 0;
    const committedMicros = view.committed(agent);
    return { budgetMicros, committedMicros, remainingMicros: budgetMicros - committedMicros, overageMicros: view.overage(agent) };
  }

  // Settled charges for the agent (0 when it has no bucket); in-flight reservations do not count.
  spentFor(agent: AgentId): number {
    this.calls.push({ method: "spentFor", args: [agent] });
    return this.agents.get(agent)?.spentMicros ?? 0;
  }

  // Sets the agent's total cap (spend untouched); creates the bucket for an unknown agent.
  setBudget(agent: AgentId, micros: number): void {
    this.calls.push({ method: "setBudget", args: [agent, micros] });
    if (!validDebitMicros(micros)) throw new Error("budget micros must be a non-negative safe integer");
    const state = this.agents.get(agent);
    if (state) state.budgetMicros = micros;
    else this.agents.set(agent, { budgetMicros: micros, spentMicros: 0, reservedMicros: 0, requests: new Map() });
  }

  // Expires reservations unsettled and untouched for at least `olderThanMs`, charging each in full; returns how many expired.
  expireReservations(olderThanMs: number): number {
    this.calls.push({ method: "expireReservations", args: [olderThanMs] });
    const cutoff = this.now() - olderThanMs;
    let released = 0;
    for (const state of this.agents.values())
      for (const request of state.requests.values())
        if (request.status === "reserved" && (request.touchedAt ?? request.createdAt) <= cutoff) {
          // Fail-closed: the upstream call may have been billed, so expiry charges the whole reservation.
          request.status = "expired-charged";
          request.chargedMicros = request.maximumMicros;
          state.reservedMicros -= request.maximumMicros;
          state.spentMicros += request.maximumMicros;
          released++;
        }
    return released;
  }

  cancel(reservation: RequestReservation): boolean {
    this.calls.push({ method: "cancel", args: [reservation] });
    if (this.cancelResults.length > 0) return this.cancelResults.shift()!;
    const state = this.agents.get(reservation.agent);
    const request = state?.requests.get(reservation.requestId);
    if (!state || !request || request.credentialId !== reservation.credentialId || request.status !== "reserved") return false;
    request.status = "cancelled";
    state.reservedMicros -= request.maximumMicros;
    return true;
  }

  private agentState(credential: GatewayCredential): FakeAgentState {
    const old = this.agents.get(credential.agent);
    if (old) return old;
    const state: FakeAgentState = { budgetMicros: credential.budgetMicros, spentMicros: 0, reservedMicros: 0, requests: new Map() };
    this.agents.set(credential.agent, state);
    return state;
  }

  private reservation(credential: GatewayCredential, requestId: string): RequestReservation {
    return { agent: credential.agent, credentialId: credential.id, requestId };
  }
}

interface FakeAgentState {
  budgetMicros: number;
  spentMicros: number;
  reservedMicros: number;
  requests: Map<string, FakeRequestState>;
}

interface FakeRequestState {
  credentialId: string;
  maximumMicros: number;
  status: "reserved" | "settled" | "cancelled" | "expired-charged";
  chargedMicros?: number;
  createdAt: number;
  touchedAt?: number;
}

// In-memory QuotaCounters with the durable store's rules (store-sqlite quotaCounters): arguments are validated the same way and
// `take` refuses past the limit without changing the count. `takeResults` are consumed in order and short-circuit the logic;
// every call is recorded in `calls`. `counts` is the state, keyed by JSON [scope, key, windowStartMs]; `ops` holds the result of
// each successful take made under an opId, keyed by JSON [scope, key, windowStartMs, opId], so a replay returns it and adds nothing.
export class FakeQuotaCounters implements QuotaCounters {
  calls: { method: "take" | "give" | "peek"; args: unknown[] }[] = [];
  takeResults: { ok: boolean; used: number }[] = [];
  readonly counts = new Map<string, number>();
  readonly ops = new Map<string, number>();

  take(scope: string, key: string, windowStartMs: number, amount: number, limit: number, opId?: string): { ok: boolean; used: number } {
    this.calls.push({
      method: "take",
      args: opId === undefined ? [scope, key, windowStartMs, amount, limit] : [scope, key, windowStartMs, amount, limit, opId],
    });
    if (this.takeResults.length > 0) return { ...this.takeResults.shift()! };
    quotaArg("window start", windowStartMs);
    quotaArg("amount", amount);
    quotaArg("limit", limit);
    if (opId !== undefined && (typeof opId !== "string" || opId === "")) throw new Error("quota opId must be a non-empty string when given");
    const opKey = JSON.stringify([scope, key, windowStartMs, opId]);
    if (opId !== undefined && this.ops.has(opKey)) return { ok: true, used: this.ops.get(opKey)! };
    const id = JSON.stringify([scope, key, windowStartMs]);
    const used = this.counts.get(id) ?? 0;
    if (used + amount > limit) return { ok: false, used };
    this.counts.set(id, used + amount);
    if (opId !== undefined) this.ops.set(opKey, used + amount);
    return { ok: true, used: used + amount };
  }

  give(scope: string, key: string, windowStartMs: number, amount: number): number {
    this.calls.push({ method: "give", args: [scope, key, windowStartMs, amount] });
    quotaArg("window start", windowStartMs);
    quotaArg("amount", amount);
    const id = JSON.stringify([scope, key, windowStartMs]);
    const used = this.counts.get(id) ?? 0;
    const next = Math.max(0, used - amount);
    if (used > 0) this.counts.set(id, next);
    return next;
  }

  peek(scope: string, key: string, windowStartMs: number): number {
    this.calls.push({ method: "peek", args: [scope, key, windowStartMs] });
    quotaArg("window start", windowStartMs);
    return this.counts.get(JSON.stringify([scope, key, windowStartMs])) ?? 0;
  }
}

function quotaArg(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`quota ${name} must be a non-negative safe integer, got ${v}`);
}

export class FakeExtensionGateway implements ExtensionGateway {
  specs: ExtensionSpec[];
  results: ExtensionResult[]; // consumed in order
  calls: { agent: AgentId; extension: string; input: unknown; idempotencyKey: string }[] = [];
  constructor(specs: ExtensionSpec[] = [], results: ExtensionResult[] = []) {
    this.specs = specs;
    this.results = [...results];
  }
  async list(): Promise<ExtensionSpec[]> {
    return structuredClone(this.specs);
  }
  async call(agent: AgentId, extension: string, input: unknown, idempotencyKey: string): Promise<ExtensionResult> {
    this.calls.push({ agent, extension, input, idempotencyKey });
    return structuredClone(this.results.shift() ?? { ok: false, reason: "no scripted result" });
  }
}

export class FakeHostStore implements HostStore {
  hosts = new Map<HostId, HostRecord>();
  reservations = new Map<AgentId, Reservation>();
  // Scripted failure for the next mutating call, consumed in order (null lets that call succeed).
  errors: (Error | null)[] = [];
  private nextSeq = 1; // never reused, even after a release
  private keys = new Map<string, unknown>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  private once<T>(op: string, key: string, fn: () => T): T {
    const k = `${op}:${key}`;
    if (this.keys.has(k)) return structuredClone(this.keys.get(k) as T);
    const err = this.errors.shift();
    if (err) throw err;
    const r = fn();
    this.keys.set(k, structuredClone(r));
    return structuredClone(r);
  }
  async upsertHost(h: NewHost, key: string): Promise<HostRecord> {
    return this.once("upsertHost", key, () => {
      const t = this.now();
      const prior = this.hosts.get(h.id);
      const rec: HostRecord = { ...structuredClone(h), createdAt: prior ? prior.createdAt : t, updatedAt: t };
      this.hosts.set(h.id, rec);
      return rec;
    });
  }
  async getHost(id: HostId): Promise<HostRecord | null> {
    const h = this.hosts.get(id);
    return h ? structuredClone(h) : null;
  }
  async listHosts(): Promise<HostRecord[]> {
    return structuredClone([...this.hosts.values()]);
  }
  async setHostState(id: HostId, state: HostState, key: string): Promise<HostRecord | null> {
    return this.once("setHostState", key, () => {
      const h = this.hosts.get(id);
      if (!h) return null;
      h.state = state;
      h.updatedAt = this.now();
      return h;
    });
  }
  async reserve(r: NewReservation, key: string): Promise<Reservation> {
    return this.once("reserve", key, () => {
      const prior = this.reservations.get(r.agent);
      const rec: Reservation = { ...structuredClone(r), seq: prior ? prior.seq : this.nextSeq++, createdAt: prior ? prior.createdAt : this.now() };
      this.reservations.set(r.agent, rec);
      return rec;
    });
  }
  async getReservation(agent: AgentId): Promise<Reservation | null> {
    const r = this.reservations.get(agent);
    return r ? structuredClone(r) : null;
  }
  async listReservations(o?: { host?: HostId; state?: Reservation["state"] }): Promise<Reservation[]> {
    return structuredClone(
      [...this.reservations.values()]
        .filter((r) => (o?.host === undefined || r.host === o.host) && (o?.state === undefined || r.state === o.state))
        .sort((a, b) => a.priority - b.priority || a.seq - b.seq),
    );
  }
  async releaseReservation(agent: AgentId, key: string): Promise<boolean> {
    return this.once("releaseReservation", key, () => this.reservations.delete(agent));
  }
}

// Resolves mounts to deterministic fake host realizations: workspace/session/bind become a bind at
// `<root>/<kind>/<id>` and scratch a tmpfs. Scripted failures (ENOSPC, stale handle, a mount revoked
// while mounted) are queued in `errors`, consumed in order, one per resolve call (null = succeed).
export class FakeMountProvider implements MountProvider {
  resolved: { agent: AgentId; mount: MountSpec; result: ResolvedMount }[] = [];
  errors: (Error | null)[] = [];
  // Test hook: ids (workspace id, session agent, bind path) whose mount was revoked; resolve then rejects.
  revoked = new Set<string>();
  readonly root: string;
  constructor(root = "/fake") {
    this.root = root;
  }
  async resolve(agent: AgentId, mount: MountSpec): Promise<ResolvedMount> {
    const err = this.errors.shift();
    if (err) throw err;
    const id = mount.kind === "workspace" ? mount.workspace : mount.kind === "session" ? mount.agent : mount.kind === "bind" ? mount.hostPath : "";
    if (id && this.revoked.has(id)) throw new Error(`mount revoked: ${mount.kind} ${id}`);
    const result: ResolvedMount =
      mount.kind === "scratch"
        ? { type: "tmpfs", containerPath: mount.containerPath, ...(mount.sizeBytes !== undefined ? { sizeBytes: mount.sizeBytes } : {}) }
        : {
            type: "bind",
            hostPath: mount.kind === "bind" ? mount.hostPath : `${this.root}/${mount.kind}/${id}`,
            containerPath: mount.containerPath,
            readOnly: mount.readOnly ?? false,
          };
    this.resolved.push({ agent, mount: structuredClone(mount), result: structuredClone(result) });
    return structuredClone(result);
  }
}

export class FakePlacement implements Placement {
  admitted = new Set<AgentId>();
  queued = new Map<AgentId, number>(); // agent -> priority
  private hostOf = new Map<AgentId, HostId>(); // host each admitted agent was placed on (sync-adopted agents are local)
  private host: HostId;
  private max: number;
  private decide: NonNullable<Script["placement"]>;
  private statusScript: NonNullable<Script["placementStatus"]> | null;
  constructor(decide: NonNullable<Script["placement"]>, host: HostId, maxConcurrent: number, statusScript?: NonNullable<Script["placementStatus"]>) {
    this.decide = decide;
    this.host = host;
    this.max = maxConcurrent;
    this.statusScript = statusScript ?? null;
  }
  async admit(req: {
    agent: AgentId;
    priority: number;
    resources?: Resources;
    template?: TemplateId;
    affinity?: { host?: HostId };
  }): Promise<{ host: HostId } | { queued: true; reason: string }> {
    const prior = this.admitted.has(req.agent) ? (this.hostOf.get(req.agent) ?? this.host) : undefined;
    if (prior !== undefined) return { host: prior }; // like HostPlacement: a running agent is never re-decided
    const r = this.decide(req);
    if ("host" in r) {
      this.queued.delete(req.agent);
      this.admitted.add(req.agent);
      this.hostOf.set(req.agent, r.host);
      return r;
    }
    this.queued.set(req.agent, req.priority);
    return { queued: true, reason: r.reason ?? "no capacity" };
  }
  async release(agent: AgentId) {
    this.admitted.delete(agent);
    this.queued.delete(agent);
  }
  // Mirrors HostPlacement.sync: listed agents become running (leaving the queue), others released.
  async sync(agents: AgentId[]): Promise<void> {
    const live = new Set(agents);
    for (const a of live) {
      this.queued.delete(a);
      this.admitted.add(a);
    }
    for (const a of [...this.admitted]) if (!live.has(a)) this.admitted.delete(a);
  }
  // One row per host; the fake models a single host.
  async status(): Promise<PlacementStatus[]> {
    if (this.statusScript) {
      const s = this.statusScript();
      return Array.isArray(s) ? s : [s];
    }
    return [
      {
        host: this.host,
        maxConcurrent: this.max,
        running: [...this.admitted],
        queue: [...this.queued].map(([agent, priority]) => ({ agent, priority })),
      },
    ];
  }
}

// In-memory MergeStore with the same semantics as the SQLite adapter (see mergeStoreContractBody).
export class FakeMergeStore implements MergeStore {
  records = new Map<MergeId, MergeRecord>();
  statuses = new Map<string, MergeStatus>();
  private byKey = new Map<string, MergeId>();
  private keys = new Map<string, unknown>();
  private n = 0;
  private now: () => number;
  private registry?: FakeRegistry;
  constructor(now: () => number, registry?: FakeRegistry) {
    this.now = now;
    this.registry = registry;
  }
  private once<T>(op: string, key: string, fn: () => T): T {
    const k = `${op}:${key}`;
    if (this.keys.has(k)) return structuredClone(this.keys.get(k) as T);
    const r = fn();
    this.keys.set(k, structuredClone(r));
    return structuredClone(r);
  }
  private must(id: MergeId): MergeRecord {
    const r = this.records.get(id);
    if (!r) throw new Error(`unknown merge ${id}`);
    return r;
  }
  async begin(n: NewMergeRecord, key: string): Promise<MergeRecord> {
    const prior = this.byKey.get(key);
    if (prior) return structuredClone(this.must(prior));
    const q = n.request;
    const a = this.registry?.agents.get(q.caller);
    if (this.registry && !a) throw new Error(`unknown agent ${q.caller}`);
    if (a && a.generation !== q.callerGeneration) throw new StaleGenerationError(q.caller, q.callerGeneration, a.generation);
    const t = this.now();
    const rec: MergeRecord = {
      id: `merge-${++this.n}`,
      repo: n.repo,
      host: n.host,
      generation: q.callerGeneration,
      caller: q.caller,
      child: q.child,
      request: structuredClone(q),
      idempotencyKey: key,
      phase: "begun",
      attempts: 0,
      base: null,
      source: null,
      candidate: null,
      startedAt: n.startedAt,
      result: null,
      createdAt: t,
      updatedAt: t,
    };
    this.records.set(rec.id, rec);
    this.byKey.set(key, rec.id);
    return structuredClone(rec);
  }
  async advance(id: MergeId, step: MergeStep, key: string): Promise<MergeRecord> {
    return this.once("advance", key, () => {
      const r = this.must(id);
      if (r.phase === "done") return structuredClone(r);
      Object.assign(r, { phase: step.phase, updatedAt: this.now() });
      if (step.attempts !== undefined) r.attempts = step.attempts;
      if (step.base !== undefined) r.base = step.base;
      if (step.source !== undefined) r.source = step.source;
      if (step.candidate !== undefined) r.candidate = step.candidate;
      return structuredClone(r);
    });
  }
  async settle(id: MergeId, result: MergeResult, key: string): Promise<MergeRecord> {
    return this.once("settle", key, () => {
      const r = this.must(id);
      if (r.phase === "done") return structuredClone(r);
      Object.assign(r, { phase: "done", result: structuredClone(result), updatedAt: this.now() });
      const state: MergeStatusState | null =
        result.status === "merged"
          ? "merged"
          : result.status === "conflict"
            ? "conflict"
            : result.status === "check_failed"
              ? "check_failed"
              : result.status === "escalate"
                ? "escalated"
                : null;
      if (state) {
        const failed = result.status === "escalate" ? result.rounds : result.status === "conflict" || result.status === "check_failed" ? result.round : 0;
        this.statuses.set(`${r.repo}\0${r.child}`, {
          repo: r.repo,
          child: r.child,
          state,
          failedRounds: failed,
          lastMerge: id,
          host: r.host,
          generation: r.generation,
          updatedAt: this.now(),
        });
      }
      return structuredClone(r);
    });
  }
  async get(id: MergeId): Promise<MergeRecord | null> {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }
  async status(repo: RepoId, child: AgentId): Promise<MergeStatus> {
    return structuredClone(
      this.statuses.get(`${repo}\0${child}`) ?? { repo, child, state: "none", failedRounds: 0, lastMerge: null, host: null, generation: null, updatedAt: null },
    );
  }
  async findConflict(q: { repo: RepoId; caller: AgentId; child: AgentId; base: string; source: string }): Promise<MergeRecord | null> {
    const hits = [...this.records.values()].filter(
      (r) =>
        r.phase === "done" &&
        r.result?.status === "conflict" &&
        r.repo === q.repo &&
        r.caller === q.caller &&
        r.child === q.child &&
        r.base === q.base &&
        r.source === q.source,
    );
    return hits.length ? structuredClone(hits[hits.length - 1]!) : null;
  }
  async list(o: { open?: true; caller?: AgentId; child?: AgentId } = {}): Promise<MergeRecord[]> {
    return structuredClone(
      [...this.records.values()].filter(
        (r) => (!o.open || r.phase !== "done") && (o.caller === undefined || r.caller === o.caller) && (o.child === undefined || r.child === o.child),
      ),
    );
  }
}

// RepoStore that scripts merge results and records requests. `results` are consumed in order (empty =
// merged with a made-up commit). Reports follow the results the way the real engine's MergeStore does, so a
// daemon test can drive "merge, then reap" without a repository. Replays of an idempotency key return the first result.
export class FakeRepoStore implements RepoStore {
  repoRecord: Repo = { id: "repo-1", name: "repo", defaultBranch: "main", policy: { deniedPaths: [], check: null } };
  results: MergeResult[] = [];
  requests: { req: MergeRequest; key: string }[] = [];
  reports = new Map<AgentId, MergeReport>(); // set directly (e.g. "empty") or updated by merge()
  reachable = new Map<string, AgentId[]>(); // commit -> agents whose ingested heads contain it, for commitInSubtree
  recovered: MergeResult[] = [];
  private replies = new Map<string, MergeResult>();
  private n = 0;
  async repo(): Promise<Repo> {
    return structuredClone(this.repoRecord);
  }
  async merge(req: MergeRequest, key: string): Promise<MergeResult> {
    const prior = this.replies.get(key);
    if (prior) {
      const first = this.requests.find((x) => x.key === key)!.req;
      return sameMergeRequest(first, req)
        ? structuredClone(prior)
        : { status: "policy_rejected", code: "key_reuse", message: "this idempotency key was already used with a different merge request" };
    }
    this.requests.push({ req: structuredClone(req), key });
    // Self-merge (child === caller) only into the default branch and only with an approval, like GitRepoStore.
    if (req.caller === req.child) {
      const bad: MergeResult | null =
        req.target !== `refs/heads/${this.repoRecord.defaultBranch}`
          ? { status: "policy_rejected", code: "bad_ref", message: "an agent can merge itself only into the default branch" }
          : !req.approval
            ? { status: "policy_rejected", code: "approval_required", message: `merging into protected ${req.target} needs an approval` }
            : null;
      if (bad) {
        this.replies.set(key, structuredClone(bad));
        return bad;
      }
    }
    const r = this.results.shift() ?? { status: "merged" as const, commit: `fake-merge-${++this.n}`, base: "fake-base", source: "fake-source" };
    this.replies.set(key, structuredClone(r));
    if (r.status === "merged") this.reports.set(req.child, { state: "merged", merged: true, failedRounds: 0, settled: true });
    else if (r.status === "conflict" || r.status === "check_failed")
      this.reports.set(req.child, { state: r.status, merged: false, failedRounds: r.round, settled: false });
    else if (r.status === "escalate") this.reports.set(req.child, { state: "escalated", merged: false, failedRounds: r.rounds, settled: true });
    else if (!this.reports.has(req.child)) this.reports.set(req.child, { state: "none", merged: false, failedRounds: 0, settled: false });
    return structuredClone(r);
  }
  async mergeStatus(q: { child: AgentId; target: string }): Promise<MergeReport> {
    return structuredClone(this.reports.get(q.child) ?? { state: "none", merged: false, failedRounds: 0, settled: mergeSettled("none", false) });
  }
  async commitInSubtree(commit: string, agents: AgentId[]): Promise<string | null> {
    const holders = this.reachable.get(commit);
    return holders && holders.some((a) => agents.includes(a)) ? commit : null;
  }
  async recover(): Promise<MergeResult[]> {
    return structuredClone(this.recovered);
  }
}

// CheckRunner that scripts results (default: pass) and records every run. A queued Error is thrown (runner failure).
export class FakeCheckRunner implements CheckRunner {
  results: (CheckResult | Error)[] = [];
  runs: { repo: RepoId; commit: string; command: string[]; idempotencyKey: string }[] = [];
  async run(req: { repo: RepoId; commit: string; command: string[]; idempotencyKey: string }): Promise<CheckResult> {
    this.runs.push(structuredClone(req));
    const r = this.results.shift() ?? { ok: true, summary: "ok" };
    if (r instanceof Error) throw r;
    return structuredClone(r);
  }
}

// In-memory StateStore with the same validation, quota, tombstone and idempotency semantics as store-sqlite (the shared contract body
// keeps them aligned). `errors` scripts a failure for the next mutating calls, consumed one per call before any effect.
export class FakeStateStore implements StateStore {
  errors: (Error | null)[] = [];
  private readonly docs = new Map<string, { doc: StateDoc; json: string; deleted: boolean }>();
  private readonly floors = new Map<string, number>(); // per-owner rev floor: highest rev of a purged tombstone
  private readonly keys = new Map<string, { fp: string; r: unknown }>();
  private readonly now: () => number;
  private readonly registry: FakeRegistry;
  private readonly limits: (owner: StateOwner) => StateLimits;

  constructor(now: () => number, registry: FakeRegistry, limits: (owner: StateOwner) => StateLimits = () => STATE_LIMITS_DEFAULT) {
    this.now = now;
    this.registry = registry;
    this.limits = limits;
  }

  private effective(owner: StateOwner): StateLimits {
    return clampStateLimits(this.limits(owner));
  }
  private fenceAgent(agent: AgentId, generation: number): void {
    const a = this.registry.agents.get(agent);
    if (!a) throw new StateError("unknown-writer", `unknown agent ${agent}`);
    if (a.generation !== generation) throw new StaleGenerationError(agent, generation, a.generation);
  }
  // An agent writer fences itself; a workflow writer is fenced by the request's `fence` (the task it runs as).
  private fence(w: StateWriter, fence: StateFence | undefined): void {
    if ("agent" in w) this.fenceAgent(w.agent, w.generation);
    if (fence !== undefined) this.fenceAgent(fence.agent, fence.generation);
  }
  private once<T>(scope: string, key: string, fp: string, fn: () => T): T {
    const k = `${scope}:${key}`;
    const hit = this.keys.get(k);
    if (hit) {
      if (hit.fp !== fp) throw new StateError("idempotency-mismatch", `key ${key} was already used for a different ${scope} request`);
      return structuredClone(hit.r) as T;
    }
    const err = this.errors.shift();
    if (err) throw err;
    const r = fn();
    this.keys.set(k, { fp, r: structuredClone(r) });
    return structuredClone(r);
  }
  // Keeps at most `max` tombstones for the owner (oldest by removal time, then key) and raises the owner's rev floor, as the SQLite store does.
  private purgeTombstones(owner: StateOwner, max: number): void {
    const dead = [...this.docs.entries()]
      .filter(([, x]) => x.doc.owner === owner && x.deleted)
      .sort(([, a], [, b]) => a.doc.updatedAt - b.doc.updatedAt || (a.doc.key < b.doc.key ? -1 : a.doc.key > b.doc.key ? 1 : 0));
    for (const [k, x] of dead.slice(0, Math.max(0, dead.length - max))) {
      this.floors.set(owner, Math.max(this.floors.get(owner) ?? 0, x.doc.rev));
      this.docs.delete(k);
    }
  }
  private slot(owner: StateOwner, key: StateKey) {
    return this.docs.get(`${owner}\u0000${key}`);
  }
  private live(owner: StateOwner, prefix: string | undefined): { doc: StateDoc; json: string; deleted: boolean }[] {
    return [...this.docs.values()]
      .filter((x) => x.doc.owner === owner && !x.deleted && (!prefix || x.doc.key.startsWith(prefix)))
      .sort((a, b) => (a.doc.key < b.doc.key ? -1 : a.doc.key > b.doc.key ? 1 : 0));
  }
  private usageOf(owner: StateOwner): StateUsage {
    const l = this.live(owner, undefined);
    return { docs: l.length, bytes: l.reduce((n, x) => n + x.doc.bytes, 0) };
  }
  private static meta(d: StateDoc): StateMeta {
    const { value: _v, ...m } = structuredClone(d);
    return m;
  }

  async get(owner: StateOwner, key: StateKey): Promise<StateDoc | null> {
    checkStateOwner(owner);
    checkStateKey(key);
    const s = this.slot(owner, key);
    return s && !s.deleted ? structuredClone(s.doc) : null;
  }

  async put(req: StatePutRequest, idempotencyKey: string): Promise<StatePutResult> {
    const { owner, key, writer } = req;
    checkStateOwner(owner);
    checkStateKey(key);
    checkStateWriter(writer);
    checkStateFence(writer, req.fence);
    checkStateExpectRev(req.expectRev);
    const { json, bytes } = encodeStateValue(req.value);
    const limits = this.effective(owner);
    if (bytes > limits.maxDocBytes) throw new StateError("too-large", `value is ${bytes} bytes, over the ${limits.maxDocBytes} byte document limit`);
    const fp = JSON.stringify(["put", owner, key, json, req.expectRev === undefined ? "omit" : req.expectRev, stateWriterId(writer)]);
    return this.once(`state.put:${owner}`, idempotencyKey, fp, (): StatePutResult => {
      this.fence(writer, req.fence);
      const cur = this.slot(owner, key);
      const live = !!cur && !cur.deleted;
      if (req.expectRev !== undefined) {
        const ok = req.expectRev === null || req.expectRev === 0 ? !live : live && cur!.doc.rev === req.expectRev;
        if (!ok) return { ok: false, reason: "conflict", currentRev: live ? cur!.doc.rev : 0 };
      }
      const u = this.usageOf(owner);
      if (!live && u.docs + 1 > limits.maxDocs) throw new StateError("quota-docs", `owner ${owner} is at its ${limits.maxDocs} document limit`);
      if (u.bytes - (live ? cur!.doc.bytes : 0) + bytes > limits.maxOwnerBytes) {
        throw new StateError("quota-owner-bytes", `owner ${owner} would exceed its ${limits.maxOwnerBytes} byte limit`);
      }
      const t = this.now();
      const doc: StateDoc = {
        owner,
        key,
        rev: (cur ? cur.doc.rev : (this.floors.get(owner) ?? 0)) + 1,
        value: JSON.parse(json),
        bytes,
        createdAt: live ? cur!.doc.createdAt : t,
        updatedAt: t,
        writer: structuredClone(writer),
      };
      this.docs.set(`${owner}\u0000${key}`, { doc, json, deleted: false });
      return { ok: true, doc: structuredClone(doc) };
    });
  }

  async list(owner: StateOwner, o: StateListOptions = {}): Promise<StateMeta[]> {
    checkStateOwner(owner);
    checkStateListPrefix(o.prefix);
    const limit = clampStateListLimit(o.limit);
    return this.live(owner, o.prefix)
      .filter((x) => o.after === undefined || x.doc.key > o.after)
      .slice(0, limit)
      .map((x) => FakeStateStore.meta(x.doc));
  }

  async remove(req: StateRemoveRequest, idempotencyKey: string): Promise<StateRemoveResult> {
    const { owner, key, prefix, writer } = req;
    checkStateOwner(owner);
    checkStateRemove(req);
    checkStateWriter(writer);
    checkStateFence(writer, req.fence);
    const fp = JSON.stringify([
      "rm",
      owner,
      key ?? null,
      prefix ?? null,
      req.olderThanMs ?? null,
      req.expectRev === undefined ? "omit" : req.expectRev,
      stateWriterId(writer),
    ]);
    return this.once(`state.rm:${owner}`, idempotencyKey, fp, (): StateRemoveResult => {
      this.fence(writer, req.fence);
      const t = this.now();
      let hit: { doc: StateDoc; json: string; deleted: boolean }[];
      if (key !== undefined) {
        const cur = this.slot(owner, key);
        const live = !!cur && !cur.deleted;
        if (req.expectRev !== undefined && !(req.expectRev === 0 ? !live : live && cur!.doc.rev === req.expectRev)) {
          return { ok: false, reason: "conflict", currentRev: live ? cur!.doc.rev : 0 };
        }
        hit = live ? [cur!] : [];
      } else {
        hit = this.live(owner, prefix).filter((x) => req.olderThanMs === undefined || x.doc.updatedAt <= t - req.olderThanMs);
      }
      for (const x of hit) {
        // Tombstone: content-free, rev kept.
        x.deleted = true;
        x.json = "";
        x.doc = { ...x.doc, value: null, bytes: 0, updatedAt: t, writer: structuredClone(writer) };
      }
      if (hit.length > 0) this.purgeTombstones(owner, this.effective(owner).maxTombstones);
      return { ok: true, removed: hit.length, keys: hit.map((x) => x.doc.key) };
    });
  }

  async usage(owner: StateOwner): Promise<StateUsage> {
    checkStateOwner(owner);
    return this.usageOf(owner);
  }

  async export(owner: StateOwner, o: { prefix?: string } = {}): Promise<StateDoc[]> {
    checkStateOwner(owner);
    checkStateListPrefix(o.prefix);
    return this.live(owner, o.prefix).map((x) => structuredClone(x.doc));
  }
}

export interface Fakes {
  journal: FakeJournal;
  registry: FakeRegistry;
  mailbox: FakeMailbox;
  checkpoints: FakeCheckpointStore;
  sessions: FakeSessionStore;
  escalations: FakeEscalationStore;
  approvals: FakeApprovalStore;
  schedules: FakeScheduleStore;
  watchdogs: FakeWatchdogStore;
  hosts: FakeHostStore;
  merges: FakeMergeStore;
  repos: FakeRepoStore;
  checks: FakeCheckRunner;
  mounts: FakeMountProvider;
  state: FakeStateStore;
  reportStore: FakeReportStore;
  templates: FakeTemplateStore;
  sandbox: FakeSandbox;
  harness: FakeHarness;
  orchestrator: FakeOrchestrator;
  workspace: FakeWorkspace;
  gateway: FakeModelGateway;
  placement: FakePlacement;
  extensions: FakeExtensionGateway;
  captures: FakeCaptureIndex;
  imageArtifacts: ImageArtifacts;
  captureParser: FakeCaptureParser;
  calls: CallLog;
  hooks: Hooks;
}

// Test hooks act on the unwrapped fakes, so they never appear in `calls`.
export interface Hooks {
  raw: {
    journal: FakeJournal;
    registry: FakeRegistry;
    mailbox: FakeMailbox;
    checkpoints: FakeCheckpointStore;
    sessions: FakeSessionStore;
    escalations: FakeEscalationStore;
    approvals: FakeApprovalStore;
    schedules: FakeScheduleStore;
    watchdogs: FakeWatchdogStore;
    hosts: FakeHostStore;
    merges: FakeMergeStore;
    repos: FakeRepoStore;
    checks: FakeCheckRunner;
    mounts: FakeMountProvider;
    state: FakeStateStore;
    reportStore: FakeReportStore;
    templates: FakeTemplateStore;
    sandbox: FakeSandbox;
    harness: FakeHarness;
    orchestrator: FakeOrchestrator;
    workspace: FakeWorkspace;
    gateway: FakeModelGateway;
    placement: FakePlacement;
    extensions: FakeExtensionGateway;
    captures: FakeCaptureIndex;
    imageArtifacts: FakeImageArtifacts;
    captureParser: FakeCaptureParser;
  };
  exitSandbox(id: SandboxId, code: number, oomKilled?: boolean): void;
  addSpend(agent: AgentId, micros: number): void;
}

// Ports are call-logged views over the fakes; use the fake class fields for scripted state.
export function createFakes(script: Script = {}): Fakes {
  const calls: CallLog = [];
  const now = script.now ?? (() => Date.now());
  const host = script.host ?? "host-1";
  const registry = new FakeRegistry(now);
  const checkpoints = new FakeCheckpointStore(now, registry);
  const journal = new FakeJournal(now, registry);
  registry.journal = journal;
  journal.checkpointFloor = (agent) => {
    const c = checkpoints.all.filter((x) => x.agent === agent);
    return c.length ? Math.max(...c.map((x) => x.createdAt)) : null;
  };
  const raw = {
    journal,
    registry,
    mailbox: new FakeMailbox(registry, script.strictMailboxTargets),
    checkpoints,
    sessions: new FakeSessionStore(),
    escalations: new FakeEscalationStore(now, registry),
    approvals: new FakeApprovalStore(now, registry),
    schedules: new FakeScheduleStore(now),
    watchdogs: new FakeWatchdogStore(),
    hosts: new FakeHostStore(now),
    merges: new FakeMergeStore(now, registry),
    repos: new FakeRepoStore(),
    checks: new FakeCheckRunner(),
    mounts: new FakeMountProvider(),
    state: new FakeStateStore(now, registry, script.stateLimits),
    reportStore: new FakeReportStore(now, registry),
    templates: new FakeTemplateStore(script.templates ?? []),
    sandbox: new FakeSandbox(script.sandboxExitCodes, script.sandboxStop, script.sandboxOptions),
    harness: new FakeHarness(script.harnessEvents),
    orchestrator: new FakeOrchestrator(),
    workspace: new FakeWorkspace(),
    gateway: new FakeModelGateway(registry),
    placement: new FakePlacement(script.placement ?? (() => ({ host })), host, script.placementMaxConcurrent ?? 4, script.placementStatus),
    extensions: new FakeExtensionGateway(),
    captures: new FakeCaptureIndex(now),
    imageArtifacts: new FakeImageArtifacts(),
    captureParser: new FakeCaptureParser(),
  };
  registry.defaultBackend = raw.sandbox.declaration.backend;
  return {
    journal: wrap("Journal", raw.journal, calls),
    registry: wrap("Registry", raw.registry, calls),
    mailbox: wrap("Mailbox", raw.mailbox, calls),
    checkpoints: wrap("CheckpointStore", raw.checkpoints, calls),
    sessions: wrap("SessionStore", raw.sessions, calls),
    escalations: wrap("EscalationStore", raw.escalations, calls),
    approvals: wrap("ApprovalStore", raw.approvals, calls),
    schedules: wrap("ScheduleStore", raw.schedules, calls),
    watchdogs: wrap("WatchdogStore", raw.watchdogs, calls),
    hosts: wrap("HostStore", raw.hosts, calls),
    merges: wrap("MergeStore", raw.merges, calls),
    repos: wrap("RepoStore", raw.repos, calls),
    checks: wrap("CheckRunner", raw.checks, calls),
    mounts: wrap("MountProvider", raw.mounts, calls),
    state: wrap("StateStore", raw.state, calls),
    reportStore: wrap("ReportStore", raw.reportStore, calls),
    templates: wrap("TemplateStore", raw.templates, calls),
    sandbox: wrap("Sandbox", raw.sandbox, calls),
    harness: wrap("Harness", raw.harness, calls),
    orchestrator: wrap("Orchestrator", raw.orchestrator, calls),
    workspace: wrap("Workspace", raw.workspace, calls),
    gateway: wrap("ModelGateway", raw.gateway, calls),
    placement: wrap("Placement", raw.placement, calls),
    extensions: wrap("ExtensionGateway", raw.extensions, calls),
    captures: wrap("CaptureIndex", raw.captures, calls),
    imageArtifacts: wrap("ImageArtifacts", raw.imageArtifacts, calls),
    captureParser: wrap("CaptureParser", raw.captureParser, calls),
    calls,
    hooks: {
      raw,
      exitSandbox: (id, code, oomKilled) => raw.sandbox.exit(id, code, oomKilled),
      addSpend: (agent, micros) => raw.gateway.addSpend(agent, micros),
    },
  };
}

// ---- Shared contract tests ---------------------------------------------------------------
// One body runs against the fake and, when an adapter package supplies `real`, the real
// adapter, so the fakes cannot drift from the ports. An adapter package whose fake half
// already runs in @pomtree/testing omits `fake` and wires only `real`.
//
// A real half is skipped only when declared: `gate()` returns a reason string (e.g. Docker is
// not enabled) and `real()` is then never called. A throw out of `real()` fails the case,
// except the temporary docker-gate bridge below. Skips are counted, never silent: an
// `after()` hook (registered on the first contract() call with a `real` adapter) fails the
// file when a port supplied `real` but registered no cases, when a case was neither attempted
// nor gated, or when no case of a port ran against the real adapter and not all were gated
// (a fully gated port also prints one stderr line). `requireReal: true` on a port's adapters turns
// its gated skips into failures: the lever a Docker-capable lane sets at its own call site to prove
// the real halves ran.

export interface ContractAdapters<W> {
  fake?: () => W | Promise<W>;
  real?: () => W | Promise<W>;
  // Pre-flight gate for the real half: a non-empty string is the reason to skip it as GATED.
  gate?: () => string | false | null | undefined;
  // When true, a gated case (or no real case running at all) fails the file instead of passing loudly. Default false.
  requireReal?: boolean;
}

// TODO(fakes): bridge only. sandbox-contract.test.ts still throws docker-gate.ts's reason from `real`; list every
// reason gate() and engineGate() can return. Delete this list once that test passes gate() through `gate` instead.
export const DOCKER_GATE_REASONS: RegExp[] = [
  /^PTREE_DOCKER_TESTS not set \(no Docker execution\)$/,
  /^PTREE_DOCKER_TESTS not set \(no Podman execution; backend podman\)$/,
  /^Docker unavailable \(backend docker\): .+$/,
  /^Podman unavailable \(backend podman\): .+$/,
  /^explicit committed PTREE_AGENT_TEST_REVISION required; no old-image proof$/,
  /^commit adapter\/image checkpoint before Docker gates; untracked sources are not image proof$/,
  /^adapter\/image source differs from requested committed image revision$/,
  /^(Docker|Podman) unavailable; network-none\/UDS\/browser confinement unverified$/,
  /^(Docker|Podman) unavailable; egress network isolation unverified$/,
  /^(rebuilt )?\S+ unavailable( in the (docker|podman) image store)?; this gate never pulls or builds$/,
  /^image revision \S+ does not match approved \S+$/,
  /^cannot establish rebuilt image revision$/,
];

// One tally per contract() call (site), not per port label: two sites sharing a label must not mask each other.
interface ContractTally {
  port: string;
  cases: number;
  attempted: number;
  gated: string[];
  requireReal: boolean;
}
const contractTallies: ContractTally[] = [];
let contractHookRegistered = false;

// A node --test run narrowed by name or `only` legitimately leaves cases unrun. Checked empirically (node 26): the child process carries the flags in execArgv (argv is empty); both are read. Control in
// fakes.test.ts (the filtered-run test).
function runIsFiltered(): boolean {
  return [...process.execArgv, ...process.argv].some((a) => /^--test-(name-pattern|skip-pattern|only)\b/.test(a));
}

function checkContractCoverage(): void {
  const filtered = runIsFiltered();
  if (filtered)
    console.error(
      "CONTRACT FLOOR RELAXED: this run is filtered (--test-name-pattern/--test-skip-pattern/--test-only), so unrun cases are not counted as missing coverage",
    );
  const problems: string[] = [];
  contractTallies.forEach((t) => {
    // Several sites may share a port label: number them so a message names the site at fault.
    const same = contractTallies.filter((o) => o.port === t.port);
    const port = same.length > 1 ? `${t.port} #${same.indexOf(t) + 1}` : t.port;
    const gated = t.gated.length;
    const counts = `cases=${t.cases} attempted=${t.attempted} gated=${gated}`;
    if (t.cases === 0)
      problems.push(`${port}: a real adapter was supplied but no contract cases were registered (${counts}); restore the dropped contract case calls`);
    else if (!filtered && t.attempted + gated !== t.cases)
      problems.push(`${port}: ${counts}; every case must be attempted or gated, so a real half failed to construct or never ran`);
    else if (!filtered && t.attempted === 0 && gated !== t.cases) problems.push(`${port}: no case ran against the real adapter (${counts})`);
    else if (t.requireReal && !filtered && t.attempted === 0) problems.push(`${port}: requireReal is set but no case ran against the real adapter (${counts})`);
    else if (t.requireReal && gated > 0)
      problems.push(`${port}: requireReal is set but ${gated} case(s) were gated (${counts}): ${[...new Set(t.gated)].join("; ")}`);
    if (t.cases > 0 && gated === t.cases) {
      console.error(
        `CONTRACT GATED: ${port}: all ${t.cases} real-adapter case(s) skipped, nothing ran against the real adapter: ${[...new Set(t.gated)].join("; ")}`,
      );
    }
  });
  if (problems.length) throw new Error(`contract coverage floor violated:\n  ${problems.join("\n  ")}`);
}

export function contract<W>(port: string, adapters: ContractAdapters<W>) {
  if (!adapters.fake && !adapters.real) throw new Error(`contract(${port}): supply a fake, a real adapter, or both: with neither, no test would run`);
  const tally: ContractTally = { port, cases: 0, attempted: 0, gated: [], requireReal: adapters.requireReal === true };
  if (adapters.real) {
    contractTallies.push(tally);
    if (!contractHookRegistered) {
      contractHookRegistered = true;
      after(checkContractCoverage);
    }
  }
  return function contractCase(name: string, body: (w: W) => void | Promise<void>): void {
    if (adapters.fake) {
      const fake = adapters.fake;
      test(`${port} [fake] ${name}`, async () => {
        await body(await fake());
      });
    }
    if (adapters.real) {
      tally.cases++;
      test(`${port} [real] ${name}`, async (t) => {
        const why = adapters.gate?.();
        if (why) {
          tally.gated.push(why);
          t.skip(`real adapter gated: ${why}`);
          return;
        }
        let w: W;
        try {
          w = await adapters.real!();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!DOCKER_GATE_REASONS.some((re) => re.test(msg))) throw e;
          tally.gated.push(msg);
          t.skip(`real adapter gated: ${msg} (TODO(fakes): pass the gate via \`gate\`)`);
          return;
        }
        tally.attempted++;
        await body(w);
      });
    }
  };
}

export interface JournalContractWorld {
  journal: Journal;
  registry: Registry;
  checkpoints: CheckpointStore;
  // Advance the adapter's clock by ms (fake: script clock; real: backdate/sleep).
  age(ms: number): Promise<void>;
}

// Journal retention + spend contract: pruneJournal keeps audit kinds, the newest keepPerAgent
// rows and the tail since the latest checkpoint; seqs are not reused; spendFor survives pruning.
export async function journalRetentionContractBody(w: JournalContractWorld): Promise<void> {
  // TODO(load-flakes): the real store measures age with Date.now(), so a runner stall longer than the 1000 ms window makes the fresh row prunable.
  // The exact fix is a clock seam on the store, openStore({ now }); until then the windows are sized at 10x the observed CI stall.
  const j = w.journal;
  const a = await w.registry.create({ parent: null, name: "a", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "jr-a", spec: {} as SpawnSpec });
  const put = (kind: string, i: number, payload: any) =>
    j.append({ agent: a.id, host: "h", generation: a.generation, payload, idempotencyKey: `jr-${kind}-${i}` });
  await put("spawned", 0, { kind: "spawned" });
  for (let i = 0; i < 4; i++) await put("message", i, { kind: "message", role: "assistant", text: `m${i}` });
  await put("usage", 0, { kind: "usage", inputTokens: 10, outputTokens: 5, costMicros: 0 });
  await put("usage", 1, { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 7 });
  assert.deepEqual(await j.spendFor(a.id), { costMicros: 7, unpricedInputTokens: 10, unpricedOutputTokens: 5, events: 2 });
  assert.equal((await j.spendFor("nobody")).events, 0);
  await w.age(2000);
  await put("message", 9, { kind: "message", role: "assistant", text: "fresh" });
  // Fresh row is inside the age window; the newest 2 rows are kept regardless.
  const r = await j.pruneJournal({ olderThanMs: 1000, keepPerAgent: 2 });
  assert.equal(r.deleted, 5); // m0..m3 and the old usage row; the newest two rows (usage, fresh) stay
  const left = (await j.read({ agent: a.id })).map((e) => e.payload.kind);
  assert.deepEqual(left, ["spawned", "usage", "message"]);
  assert.deepEqual(await j.spendFor(a.id), { costMicros: 7, unpricedInputTokens: 10, unpricedOutputTokens: 5, events: 2 });
  // protectKinds shields a normally prunable kind.
  const r2 = await j.pruneJournal({ olderThanMs: 1000, keepPerAgent: 0, protectKinds: ["usage"] });
  assert.equal(r2.deleted, 0); // the only old prunable rows are usage (protected); the message is fresh
  // Seqs are never reused after pruning.
  const n = await put("message", 10, { kind: "message", role: "user", text: "next" });
  assert.ok(n.seq > Math.max(...(await j.read({ agent: a.id })).filter((e) => e.seq !== n.seq).map((e) => e.seq)));
  // Entries since the latest checkpoint are kept.
  await w.age(2000);
  await w.checkpoints.write(
    {
      agent: a.id,
      host: "h",
      generation: a.generation,
      sessionRef: "s",
      workspace: "ws-a",
      node: "h",
      ingested: null,
      wait: null,
      remainingBudgetMicros: 1,
      imageDigest: "d",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    },
    "jr-cp",
  );
  await put("message", 11, { kind: "message", role: "user", text: "after-cp" });
  await w.age(2000);
  await j.pruneJournal({ olderThanMs: 1000, keepPerAgent: 0 });
  const texts = (await j.read({ agent: a.id })).filter((e) => e.payload.kind === "message").map((e) => (e.payload as any).text);
  assert.deepEqual(texts, ["after-cp"]);
  assert.equal((await j.read({ agent: a.id })).filter((e) => e.payload.kind === "spawned").length, 1);
}

export interface SandboxContractWorld {
  sandbox: Sandbox;
  // Adapter-specific values the body cannot invent: a startable image reference (default "i") and the workspace
  // id of a mount the adapter can resolve (default "ws-a"). A real adapter's world sets both.
  imageRef?: string;
  workspaceId?: string;
  // A long-lived command for every sandbox the body starts, for an image whose default entrypoint exits without one (default none).
  cmd?: string[];
}

// Sandbox port contract: start/list/attach/wait/inspect/kill/imageIdentity, facet presence and the probe subset rule. The body is
// adapter-agnostic; run it with `contract("Sandbox", { fake, real? })`.
const CONTRACT_OWNER: SandboxOwner = { host: "host-contract", storeId: "store-contract", epoch: 1 };

// Contract case 1: a facet is present iff at least one capability mapped to it by FACET_OF is declared true.
export function assertFacetPresence(s: Sandbox): void {
  assert.deepEqual(validateDeclaration(s.declaration), [], "the declaration must be valid");
  const facets = new Set(Object.values(FACET_OF));
  for (const facet of facets) {
    const declared = (Object.keys(FACET_OF) as (keyof typeof FACET_OF)[]).filter((c) => FACET_OF[c] === facet && s.declaration.capabilities[c] === true);
    const present = s[facet] !== undefined && s[facet] !== null;
    assert.equal(
      present,
      declared.length > 0,
      `facet ${facet} is ${present ? "present" : "absent"} but capabilities [${declared.join(", ")}] are declared true`,
    );
  }
}

// Contract case 2: a probe result only narrows the declaration, with and without a runtime block. A backend with no probe passes.
export async function assertProbeSubset(s: Sandbox): Promise<void> {
  if (s.probe === undefined) return;
  checkProbe(s.declaration, await s.probe());
  checkProbe(s.declaration, await s.probe({ ociRuntime: "runsc" }));
}

// TODO(sandbox-contract-body-removal): remove this once the conformance suite has run green for a release cycle; current behavior: both run.
export async function sandboxContractBody(w: SandboxContractWorld): Promise<void> {
  const s = w.sandbox;
  const image = w.imageRef ?? "i";
  const spec: SandboxSpec = {
    host: "host-test",
    generation: 0,
    agent: "a",
    image,
    env: {},
    mounts: [{ kind: "workspace", workspace: w.workspaceId ?? "ws-a", containerPath: "/w" }],
    ...(w.cmd && { cmd: w.cmd }),
  };
  const h = await s.start(spec, "sb-contract");
  assert.equal(typeof h.id, "string");
  // A started sandbox reports the runtime's running status (the memory gate counts it).
  assert.deepEqual(await s.inspect(h.id), { running: true, exitCode: null, status: "running", host: spec.host, generation: spec.generation });
  // Idempotent by key: a repeated start re-adopts the same sandbox instead of starting a second.
  assert.equal((await s.start(spec, "sb-contract")).id, h.id);
  assertFacetPresence(s);
  await assertProbeSubset(s);
  assert.equal((await s.list(CONTRACT_OWNER)).filter((x) => x.id === h.id).length, 1);
  // Negative: a label name that is malformed or reserved ("pomtree" prefix) is rejected before anything starts.
  for (const bad of ["pomtree.owner", "has space", ""]) {
    await assert.rejects(
      () => s.start({ ...spec, agent: "c", labels: { [bad]: "v" } }, `sb-contract-bad-${bad}`),
      `label ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.ok(!(await s.list(CONTRACT_OWNER)).some((x) => x.agent === "c"));
  const listed = await s.list(CONTRACT_OWNER);
  assert.ok(listed.some((x) => x.id === h.id && x.agent === "a" && x.labels === undefined));
  const hl = await s.start(
    { ...spec, agent: "b", labels: { daemon_epoch: String(CONTRACT_OWNER.epoch), store_id: CONTRACT_OWNER.storeId } },
    "sb-contract-labels",
  );
  assert.deepEqual((await s.list(CONTRACT_OWNER)).find((x) => x.id === hl.id)?.labels, {
    daemon_epoch: String(CONTRACT_OWNER.epoch),
    store_id: CONTRACT_OWNER.storeId,
  });
  await s.kill(hl.id, "sb-contract-kill-labels");
  const identity = await s.imageIdentity(image);
  assert.ok(identity.engineLocalId.length > 0, "imageIdentity reports a non-empty engine-local id");
  assert.ok(identity.configDigest === null || /^sha256:[0-9a-f]{64}$/.test(identity.configDigest), "configDigest is null or sha256:<hex>");
  await assert.rejects(() => s.attach("no-such-id", "a"), SandboxUnavailableError);
  if (s.terminal) await assert.rejects(() => s.terminal!.open("no-such-id"), SandboxUnavailableError);
  if (s.loopback) {
    await assert.rejects(() => s.loopback!.open("no-such-id", LOOPBACK_PORTS[0]), SandboxUnavailableError);
    await assert.rejects(() => s.loopback!.open(h.id, 1 as LoopbackPort), RangeError);
  }
  await s.kill(h.id, "sb-contract-kill");
  assert.deepEqual(await h.wait(), { exitCode: 137 });
  // Exited (and, after an observed exit, removed) sandboxes report "exited", which the memory gate does not count. The owner stamp is
  // read back only while the sandbox still exists, so it is not part of the exited shape.
  const { host: _host, generation: _generation, ...exited } = (await s.inspect(h.id)) ?? {};
  assert.deepEqual(exited, { running: false, exitCode: 137, status: "exited" });
  assert.equal(await s.inspect("nope"), null);
}

export interface ScheduleContractWorld {
  schedules: ScheduleStore;
}

// ScheduleStore port contract: upsert preserves createdAt/paused/breaker fields, setPaused
// (unknown -> null, idempotent by key, resume clears the breaker), recordFailure/clearFailures
// (count, retryAt, idempotent by key), remove, lastFired.
export async function scheduleContractBody(w: ScheduleContractWorld): Promise<void> {
  const ss = w.schedules;
  const base = { id: "s1", cron: "* * * * *", task: "t", missed: "skip" as const, overlap: "skip" as const, jitterMs: 0 };
  const created = await ss.upsert(base, "u1");
  assert.equal(created.failures ?? 0, 0);
  assert.equal(created.retryAt, undefined);
  assert.equal(await ss.setPaused("nope", true, "p0"), null);
  assert.equal(await ss.recordFailure("nope", 1, "f0"), null);
  const p = await ss.setPaused("s1", true, "p1");
  assert.equal(p?.paused, true);
  assert.equal((await ss.setPaused("s1", true, "p1"))?.paused, true); // key replay
  assert.equal((await ss.upsert({ ...base, task: "t2" }, "u2")).paused, true); // upsert preserves paused
  assert.equal((await ss.get("s1"))?.createdAt, created.createdAt);
  assert.equal((await ss.recordFailure("s1", 10, "f1"))?.failures, 1);
  assert.equal((await ss.recordFailure("s1", 10, "f1"))?.failures, 1); // key replay
  const g = await ss.recordFailure("s1", 20, "f2");
  assert.deepEqual([g?.failures, g?.retryAt], [2, 20]);
  assert.equal((await ss.upsert({ ...base, task: "t3" }, "u3")).failures, 2); // upsert preserves breaker
  const r = await ss.setPaused("s1", false, "p2"); // resume clears the breaker
  assert.ok(!r?.paused);
  assert.ok(!r?.failures);
  assert.equal(r?.retryAt, undefined);
  await ss.recordFailure("s1", 5, "f3");
  await ss.clearFailures("s1", "c1");
  const c = await ss.get("s1");
  assert.ok(!c?.failures);
  assert.equal(c?.retryAt, undefined);
  // Targeting/spawn params round-trip; setOrphaned is idempotent and an upsert (retarget) clears it.
  const t = await ss.upsert({ ...base, agent: "a1", createdBy: "a1", budgetMicros: 3, deadlineMs: 4, template: "tp", model: { provider: "p", id: "m" } }, "u4");
  assert.deepEqual([t.agent, t.createdBy, t.budgetMicros, t.deadlineMs, t.template, t.model], ["a1", "a1", 3, 4, "tp", { provider: "p", id: "m" }]);
  assert.equal(await ss.setOrphaned("nope", "or0"), null);
  assert.equal((await ss.setOrphaned("s1", "or1"))?.orphaned, true);
  assert.equal((await ss.setOrphaned("s1", "or1"))?.orphaned, true); // key replay
  const re = await ss.upsert({ ...base }, "u5");
  assert.ok(!re.orphaned && re.agent === undefined && re.model === undefined);
  assert.equal(await ss.lastFired("s1"), null);
  await ss.setLastFired("s1", 7, "lf1");
  assert.equal(await ss.lastFired("s1"), 7);
  assert.equal(await ss.remove("s1"), true);
  assert.equal(await ss.remove("s1"), false);
  assert.equal(await ss.get("s1"), null);
}

export interface EscalationContractWorld {
  escalations: EscalationStore;
  registry: Registry;
}

export const CONTRACT_SPAWN_SPEC: SpawnSpec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } };

// EscalationStore port contract: create idempotency (by key and by id), get/list, first-answer-wins
// answer idempotency, and unknown-id behavior. Generation fencing is exercised by the adapter's
// own tests (the body only needs a registry row as a create prerequisite).
export async function escalationContractBody(w: EscalationContractWorld): Promise<void> {
  const { escalations: es, registry } = w;
  await registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec: CONTRACT_SPAWN_SPEC, idempotencyKey: "c-a" });
  const e: NewEscalation = { id: "es-1", agent: "a", generation: 0, host: "h", question: "q", options: ["yes", "no"] };
  const created = await es.create(e, "k1");
  assert.equal(created.state, "open");
  assert.equal(created.answer, null);
  assert.equal(created.holder, null); // default: the user via root
  assert.deepEqual(created.options, ["yes", "no"]);
  assert.equal(created.hopDeadlineAt, undefined);
  const held = await es.create({ ...e, id: "es-h", holder: "p", hopDeadlineAt: 99 }, "kh");
  assert.deepEqual([held.holder, held.hopDeadlineAt], ["p", 99]);
  assert.deepEqual(await es.get("es-h"), held);
  assert.deepEqual(await es.create(e, "k1"), created); // key replay
  assert.equal((await es.create(e, "k2")).id, created.id); // id replay, new key
  assert.equal((await es.create(e, "k3")).createdAt, created.createdAt); // id replay returns the stored record
  assert.deepEqual(
    (await es.list({ agent: "a" })).map((x) => x.id),
    ["es-1", "es-h"],
  );
  assert.equal((await es.get("es-1"))?.question, "q");
  assert.equal(await es.get("nope"), null);
  const by1 = { channel: "discord", sender: "u1" };
  const by2 = { channel: "slack", sender: "u2" };
  const answered = await es.answer("es-1", "yes", by1, "a1");
  assert.equal(answered.answer, "yes");
  assert.deepEqual((await es.answer("es-1", "no", by2, "a2")).answeredBy, by1); // first answer wins
  assert.deepEqual(await es.answer("es-1", "yes", by1, "a1"), answered); // key replay
  // Negative: the same key with a different request is a conflict (idem-fingerprint) and changes nothing.
  await assert.rejects(() => es.answer("es-1", "again", by1, "a1"), IdempotencyConflictError);
  await assert.rejects(() => es.answer("es-1", "yes", by2, "a1"), IdempotencyConflictError);
  assert.equal((await es.get("es-1"))?.answer, "yes");
  assert.deepEqual(
    (await es.list({ state: "answered" })).map((x) => x.id),
    ["es-1"],
  );
  await assert.rejects(() => es.answer("nope", "x", by1, "a3"), /unknown escalation nope/);

  // advance moves holder and hop window; null holder = the user; replays by key return the first result.
  const adv = await es.advance("es-h", "q", 150, "v1");
  assert.deepEqual([adv.holder, adv.hopDeadlineAt], ["q", 150]);
  assert.deepEqual(await es.advance("es-h", null, undefined, "v1"), adv); // key replay
  assert.deepEqual(await es.get("es-h"), adv);
  const user = await es.advance("es-h", null, undefined, "v2");
  assert.deepEqual([user.holder, user.hopDeadlineAt], [null, undefined]);
  assert.equal((await es.get("es-h"))?.holder, null);
  await assert.rejects(() => es.advance("nope", null, undefined, "v3"), /unknown escalation nope/);
  await es.answer("es-h", "yes", by1, "a4");
  assert.equal((await es.advance("es-h", "p", 7, "v4")).holder, null); // an answered ask no longer moves
}

export interface ApprovalContractWorld {
  approvals: ApprovalStore;
  registry: Registry;
}

// ApprovalStore port contract: create idempotency (by key and id), the derived escalation
// ladder, deny-final / abstain-escalate-timeout rung transitions, fail-closed timeout past
// the top rung, rank-exceeds-requester authorization, and unknown-id behavior. Generation
// fencing is exercised by the adapter's own tests (the body only needs a registry row for
// an agent requester).
export async function approvalContractBody(w: ApprovalContractWorld): Promise<void> {
  const { approvals: ap, registry } = w;
  await registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec: CONTRACT_SPAWN_SPEC, idempotencyKey: "c-a" });
  const na: NewApproval = {
    id: "ap-1",
    requester: { id: "a", rank: "agent", generation: 0 },
    action: { kind: "extension", target: "ext-1" },
    host: "h",
    deadlineAt: 1000,
  };
  const created = await ap.create(na, "k1");
  assert.equal(created.state, "pending");
  assert.deepEqual(created.rungs, ["parent-agent", "operator", "owner"]);
  assert.equal(created.rungIndex, 0);
  assert.deepEqual(created.journal, []);
  assert.deepEqual(await ap.create(na, "k1"), created); // key replay
  assert.equal((await ap.create(na, "k2")).id, created.id); // id replay, new key
  assert.equal((await ap.create(na, "k2b")).createdAt, created.createdAt); // id replay returns the stored record
  assert.equal((await ap.list({ requester: "a" })).length, 1);

  // Deny is final; decisions on a settled record replay the stored outcome.
  const denied = await ap.decide("ap-1", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1");
  assert.equal(denied.state, "denied");
  assert.equal(denied.journal.length, 1);
  assert.equal(denied.journal[0]!.decision, "deny");
  assert.ok(denied.decidedAt !== null);
  assert.deepEqual(await ap.decide("ap-1", { who: "owner", rank: "owner", decision: "approve", why: "yes" }, "d2"), denied);
  assert.deepEqual(await ap.decide("ap-1", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1"), denied); // key replay

  // Ladder: abstain -> operator, timeout -> owner, top-rung timeout -> fail-closed deny.
  const ap2 = await ap.create(
    { id: "ap-2", requester: { id: "a", rank: "agent", generation: 0 }, action: { kind: "spawn", target: "x" }, host: "h", deadlineAt: 2000 },
    "k3",
  );
  const afterAbstain = await ap.decide("ap-2", { who: "p", rank: "parent-agent", decision: "abstain", why: "not mine" }, "d3");
  assert.equal(afterAbstain.state, "pending");
  assert.equal(afterAbstain.rungIndex, 1);
  assert.equal(afterAbstain.rungs[1], "operator");
  const afterTimeout = await ap.timeout("ap-2", "t1");
  assert.equal(afterTimeout.state, "pending");
  assert.equal(afterTimeout.rungIndex, 2);
  assert.equal(afterTimeout.journal[1]!.decision, "timeout");
  const afterTopTimeout = await ap.timeout("ap-2", "t2"); // owner rung timed out -> deny
  assert.equal(afterTopTimeout.state, "denied");
  assert.equal(afterTopTimeout.journal[2]!.decision, "timeout");
  assert.equal(afterTopTimeout.rungIndex, 3); // past the top

  // Approver rank must strictly exceed requester rank.
  const ap3 = await ap.create(
    { id: "ap-3", requester: { id: "a", rank: "agent", generation: 0 }, action: { kind: "extension", target: "e" }, host: "h", deadlineAt: 3000 },
    "k4",
  );
  await assert.rejects(() => ap.decide("ap-3", { who: "peer", rank: "agent", decision: "approve", why: "y" }, "d4"), /does not exceed/);
  const approved = await ap.decide("ap-3", { who: "op", rank: "operator", decision: "approve", why: "y" }, "d5");
  assert.equal(approved.state, "approved");

  // Operator requester needs an owner approver.
  const ap4 = await ap.create(
    { id: "ap-4", requester: { id: "op1", rank: "operator" }, action: { kind: "budget", target: "raise" }, host: "h", deadlineAt: 4000 },
    "k5",
  );
  assert.deepEqual(ap4.rungs, ["owner"]);
  await assert.rejects(() => ap.decide("ap-4", { who: "op2", rank: "operator", decision: "approve", why: "y" }, "d6"), /does not exceed/);
  const approvedOwner = await ap.decide("ap-4", { who: "owner", rank: "owner", decision: "approve", why: "y" }, "d7");
  assert.equal(approvedOwner.state, "approved");

  // Owner requester has no rung above: the ladder is empty (fail closed when consumed).
  const ap5 = await ap.create(
    { id: "ap-5", requester: { id: "o", rank: "owner" }, action: { kind: "egress", target: "e" }, host: "h", deadlineAt: 5000 },
    "k6",
  );
  assert.deepEqual(ap5.rungs, []);
  assert.equal(ap5.state, "denied"); // fail closed at create: no rung above an owner
  assert.ok(ap5.decidedAt !== null);
  assert.equal((await ap.timeout("ap-5", "t9")).state, "denied");

  // decide and timeout idempotency keys are scoped separately: a key reused across the two
  // ops is applied by each (not a stale replay).
  const t0 = Date.now();
  await ap.create(
    { id: "ap-6", requester: { id: "a", rank: "agent", generation: 0 }, action: { kind: "spawn", target: "y" }, host: "h", deadlineAt: t0 + 60_000 },
    "k7",
  );
  const s1 = await ap.decide("ap-6", { who: "p", rank: "parent-agent", decision: "abstain", why: "w" }, "shared");
  assert.equal(s1.rungIndex, 1);
  // deadlineAt is re-based on the new rung, from the advance time.
  assert.ok(s1.rungMs !== undefined && s1.deadlineAt >= t0 + s1.rungMs);
  const s2 = await ap.timeout("ap-6", "shared");
  assert.equal(s2.rungIndex, 2);

  await assert.rejects(() => ap.decide("nope", { who: "owner", rank: "owner", decision: "approve", why: "y" }, "d8"), /unknown approval nope/);

  // A bubbled ladder (specific ancestors, then operator/owner) with per-rung windows and a recorded grant.
  const t1 = Date.now();
  const ap7 = await ap.create(
    {
      id: "ap-7",
      requester: { id: "a", rank: "agent", generation: 0 },
      action: { kind: "budget_raise", target: "a" },
      host: "h",
      deadlineAt: t1 + 1000,
      rungs: ["agent:p", "agent:gp", "operator", "owner"],
      rungWindowsMs: [1000, 5000, 7000, 9000],
    },
    "k8",
  );
  assert.deepEqual(ap7.rungs, ["agent:p", "agent:gp", "operator", "owner"]);
  assert.deepEqual(ap7.rungWindowsMs, [1000, 5000, 7000, 9000]);
  const hop1 = await ap.timeout("ap-7", "t7a"); // the parent's window lapsed: the ask moves to the grandparent
  assert.equal(hop1.rungIndex, 1);
  assert.equal(hop1.journal[0]!.rung, "agent:p");
  assert.equal(hop1.journal[0]!.rank, "parent-agent");
  assert.ok(hop1.deadlineAt >= t1 + 5000); // re-based on the next rung's own window
  const granted = await ap.decide("ap-7", { who: "gp", rank: "parent-agent", decision: "approve", why: "ok", grantMicros: 250 }, "d9");
  assert.equal(granted.state, "approved");
  assert.equal(granted.journal[1]!.grantMicros, 250);
  assert.equal(granted.journal[1]!.rung, "agent:gp");

  // Delivery marker (fixed: approval replay): only settled records can be marked; the first stamp wins; list({unnotified}) is the
  // sweep's work list and shrinks as records are marked.
  const owed = async () => (await ap.list({ unnotified: true })).map((x) => x.id).sort();
  assert.ok(!(await ap.get("ap-1"))!.notifiedAt);
  assert.ok((await owed()).includes("ap-1") && !(await owed()).includes("ap-6"), "settled and undelivered is owed; a pending record never is");
  await assert.rejects(() => ap.markNotified("ap-6", "n0"), /pending/);
  await assert.rejects(() => ap.markNotified("nope", "n0b"), /unknown approval nope/);
  const marked = await ap.markNotified("ap-1", "n1");
  assert.ok(marked.notifiedAt !== undefined);
  assert.equal(marked.state, "denied");
  assert.deepEqual(await ap.markNotified("ap-1", "n1"), marked); // key replay
  assert.equal((await ap.markNotified("ap-1", "n2")).notifiedAt, marked.notifiedAt, "a new key keeps the first stamp");
  assert.equal((await ap.get("ap-1"))!.notifiedAt, marked.notifiedAt);
  assert.ok(!(await owed()).includes("ap-1"));
  assert.ok((await ap.list({ state: "denied", unnotified: true })).every((x) => x.id !== "ap-1" && x.state === "denied"));
}

export interface MailboxContractWorld {
  mailbox: Mailbox;
  registry: Registry;
}

// Mailbox port contract: the send's key is the delivered id; LEVEL kinds coalesce (latest wins, the survivor carries
// the new id) while payload kinds queue; a replayed send key never resurrects a coalesced signal; ack is keyed-idempotent,
// order-free, and a no-op for unknown ids; receive replays by key.
export async function mailboxContractBody(w: MailboxContractWorld): Promise<void> {
  const { mailbox: mb, registry } = w;
  await registry.create({ id: "mx", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec: CONTRACT_SPAWN_SPEC, idempotencyKey: "mx-a" });
  const msg = (body: string): Signal => ({ kind: "message", from: "mx", body });

  await mb.send("mx", msg("one"), "s1");
  await mb.send("mx", { kind: "nudge", body: "n1", attempt: 1, max: 3 }, "s2");
  await mb.send("mx", msg("two"), "s3");
  await mb.send("mx", { kind: "nudge", body: "n2", attempt: 2, max: 3 }, "s4"); // supersedes s2
  await mb.send("mx", msg("two"), "s5"); // identical payload, distinct key: queues
  let seen = await mb.peek("mx");
  assert.deepEqual(
    seen.map((x) => x.id),
    ["s1", "s3", "s4", "s5"],
  );
  assert.deepEqual(seen[2], { kind: "nudge", body: "n2", attempt: 2, max: 3, id: "s4" });

  await mb.send("mx", { kind: "nudge", body: "n1", attempt: 1, max: 3 }, "s2"); // replay of a coalesced key: no resurrection
  assert.deepEqual(
    (await mb.peek("mx")).map((x) => x.id),
    ["s1", "s3", "s4", "s5"],
  );

  // ack: order-free (a non-head id), unknown ids are a no-op, a replayed key returns the prior result.
  assert.deepEqual(await mb.ack("mx", ["s3", "nope"], "ack1"), ["s3"]);
  assert.deepEqual(
    (await mb.peek("mx")).map((x) => x.id),
    ["s1", "s4", "s5"],
  );
  assert.deepEqual(await mb.ack("mx", ["s3", "nope"], "ack1"), ["s3"]);
  assert.deepEqual(await mb.ack("mx", ["s2", "s3"], "ack2"), []); // coalesced and already-acked ids: harmless no-op
  assert.deepEqual(await mb.ack("mx", ["s1"], "ack1"), ["s3"]); // same key, different ids: the prior result, nothing removed
  assert.equal((await mb.peek("mx")).length, 3);

  // receive consumes the rest, in order, and replays by key; ids ride along.
  const got = await mb.receive("mx", "r1");
  assert.deepEqual(
    got.map((x) => x.id),
    ["s1", "s4", "s5"],
  );
  assert.deepEqual(await mb.receive("mx", "r1"), got);
  assert.deepEqual(await mb.peek("mx"), []);
  assert.deepEqual(await mb.ack("mx", ["s1"], "ack3"), []); // already consumed

  // A level kind sent after the earlier one was consumed is a fresh row; interrupts still sort first.
  await mb.send("mx", { kind: "budget_warning", remainingMicros: 5, budgetMicros: 10, thresholdFraction: 0.5 }, "w1");
  await mb.send("mx", { kind: "budget_warning", remainingMicros: 2, budgetMicros: 10, thresholdFraction: 0.8 }, "w2");
  await mb.send("mx", msg("late"), "m9");
  await mb.send("mx", { kind: "human_message", from: { channel: "c", sender: "u" }, body: "now", interrupt: true }, "i1");
  assert.deepEqual(
    (await mb.peek("mx")).map((x) => x.id),
    ["i1", "w2", "m9"],
  );
}

export interface RaiseBudgetContractWorld {
  registry: Registry;
}

export interface RegistryListContractWorld {
  registry: Registry;
}

// Registry.list filters: `excludeState` drops rows in that state and composes with `parent`/`state`; omitted = no exclusion.
export async function registryListContractBody(w: RegistryListContractWorld): Promise<void> {
  const { registry } = w;
  const spec = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec: CONTRACT_SPAWN_SPEC };
  await registry.create({ ...spec, id: "root", idempotencyKey: "l-root" });
  await registry.create({ ...spec, id: "run", parent: "root", idempotencyKey: "l-run" });
  await registry.create({ ...spec, id: "gone", parent: "root", idempotencyKey: "l-gone" });
  await registry.create({ ...spec, id: "pend", parent: "root", idempotencyKey: "l-pend" });
  await registry.transition("run", 0, "running", { idempotencyKey: "l-t1" });
  await registry.transition("gone", 0, "running", { idempotencyKey: "l-t2" });
  await registry.transition("gone", 0, "exited", { exit: "succeeded", idempotencyKey: "l-t3" });
  await registry.transition("gone", 0, "reaped", { idempotencyKey: "l-t4" });
  const ids = async (o?: Parameters<Registry["list"]>[0]) => (await registry.list(o)).map((a) => a.id).sort();
  assert.deepEqual(await ids(), ["gone", "pend", "root", "run"]);
  assert.deepEqual(await ids({ excludeState: "reaped" }), ["pend", "root", "run"]);
  assert.deepEqual(await ids({ parent: "root", excludeState: "reaped" }), ["pend", "run"]);
  assert.deepEqual(await ids({ state: "reaped", excludeState: "reaped" }), []); // both set: the row must match both
  assert.deepEqual(await ids({ excludeState: "exited" }), ["gone", "pend", "root", "run"]); // "gone" is reaped, not exited
  assert.deepEqual(await ids({ state: "running", excludeState: "pending" }), ["run"]);
}

// Registry.raiseBudget: adds to budgetMicros, idempotent by key, unknown agent and non-positive-safe-integer deltas rejected.
export async function raiseBudgetContractBody(w: RaiseBudgetContractWorld): Promise<void> {
  const { registry } = w;
  await registry.create({ id: "rb", parent: null, name: "n", task: "t", host: "h", budgetMicros: 100, spec: CONTRACT_SPAWN_SPEC, idempotencyKey: "rb-a" });
  assert.equal((await registry.raiseBudget("rb", 50, "rb1")).budgetMicros, 150);
  assert.equal((await registry.raiseBudget("rb", 50, "rb1")).budgetMicros, 150); // replay: not raised again
  assert.equal((await registry.get("rb"))?.budgetMicros, 150);
  assert.equal((await registry.raiseBudget("rb", 25, "rb2")).budgetMicros, 175);
  await assert.rejects(() => registry.raiseBudget("nope", 1, "rb3"), /unknown agent nope/);
  // Invalid deltas throw before the idempotency lookup and change nothing (the key stays unused).
  for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => registry.raiseBudget("rb", bad, "rb-bad"), /positive safe integer/);
    await assert.rejects(() => registry.raiseBudget("rb", bad, "rb1"), /positive safe integer/); // even on a used key
    assert.equal((await registry.get("rb"))?.budgetMicros, 175);
  }
  assert.equal((await registry.raiseBudget("rb", 5, "rb-bad")).budgetMicros, 180); // "rb-bad" was never consumed
}

export interface HostStoreContractWorld {
  hosts: HostStore;
  // Advance the adapter's clock by ms (fake: script clock; real: sleep).
  age(ms: number): Promise<void>;
}

const CONTRACT_HOST: NewHost = { id: "h1", labels: { zone: "a" }, capacity: { maxSessions: 4, cpus: 8 }, images: ["img@sha256:1"], state: "ready" };

// HostStore port contract: upsertHost keeps createdAt, get/list/setHostState (unknown -> null),
// reserve is upsert-by-agent keeping seq and createdAt, listReservations orders by priority then seq
// and filters, releaseReservation, seqs never reused, and idempotency-key replay.
export async function hostStoreContractBody(w: HostStoreContractWorld): Promise<void> {
  const hs = w.hosts;
  assert.equal(await hs.getHost("h1"), null);
  const created = await hs.upsertHost(CONTRACT_HOST, "hu1");
  assert.deepEqual([created.id, created.state, created.labels, created.capacity.maxSessions], ["h1", "ready", { zone: "a" }, 4]);
  assert.deepEqual(await hs.upsertHost(CONTRACT_HOST, "hu1"), created); // key replay
  await w.age(5);
  const again = await hs.upsertHost({ ...CONTRACT_HOST, labels: { zone: "b" }, images: [] }, "hu2");
  assert.equal(again.createdAt, created.createdAt);
  assert.ok(again.updatedAt >= created.updatedAt);
  assert.deepEqual(again.labels, { zone: "b" });
  assert.deepEqual((await hs.getHost("h1"))?.images, []);
  await hs.upsertHost({ ...CONTRACT_HOST, id: "h2" }, "hu3");
  assert.deepEqual(
    (await hs.listHosts()).map((h) => h.id),
    ["h1", "h2"],
  );
  assert.equal(await hs.setHostState("nope", "lost", "hs0"), null);
  assert.equal((await hs.setHostState("h1", "draining", "hs1"))?.state, "draining");
  assert.equal((await hs.setHostState("h1", "ready", "hs1"))?.state, "draining"); // key replay
  assert.equal((await hs.getHost("h1"))?.state, "draining");

  const nr = (agent: string, priority: number, state: "queued" | "running" = "queued", host: string | null = null) => ({
    agent,
    host,
    state,
    priority,
    resources: { cpus: 1 },
    template: "code" as string | null,
  });
  const ra = await hs.reserve(nr("a", 5), "r1");
  const rb = await hs.reserve(nr("b", 5), "r2");
  const rc = await hs.reserve(nr("c", 1), "r3");
  assert.ok(ra.seq < rb.seq && rb.seq < rc.seq);
  assert.deepEqual(await hs.reserve(nr("a", 9), "r1"), ra); // key replay returns the original
  assert.deepEqual(
    (await hs.listReservations()).map((r) => r.agent),
    ["c", "a", "b"],
  ); // priority then seq
  await w.age(5);
  const ra2 = await hs.reserve(nr("a", 5, "running", "h1"), "r4"); // upsert by agent
  assert.deepEqual([ra2.seq, ra2.createdAt, ra2.state, ra2.host], [ra.seq, ra.createdAt, "running", "h1"]);
  assert.deepEqual(
    (await hs.listReservations({ state: "running" })).map((r) => r.agent),
    ["a"],
  );
  assert.deepEqual(
    (await hs.listReservations({ host: "h1" })).map((r) => r.agent),
    ["a"],
  );
  assert.deepEqual(
    (await hs.listReservations({ state: "queued" })).map((r) => r.agent),
    ["c", "b"],
  );
  assert.equal((await hs.getReservation("b"))?.priority, 5);
  assert.equal(await hs.getReservation("nope"), null);
  assert.equal(await hs.releaseReservation("b", "rl1"), true);
  assert.equal(await hs.releaseReservation("b", "rl1"), true); // key replay
  assert.equal(await hs.releaseReservation("b", "rl2"), false);
  assert.equal(await hs.getReservation("b"), null);
  const rd = await hs.reserve(nr("d", 5), "r5");
  assert.ok(rd.seq > rc.seq);
  const rb2 = await hs.reserve(nr("b", 5), "r6"); // re-reserving a released agent is a fresh insert with a new seq
  assert.ok(rb2.seq > rd.seq);
}

// In-memory ImageArtifacts with the durable adapter's rules (store-sqlite image-artifacts.ts), through the same core helpers:
// validation, the generation fence, and idempotency by key with a whole-artifact fingerprint.
export class FakeImageArtifacts implements ImageArtifacts {
  readonly rows = new Map<string, ImageArtifact>();
  private keys = new Map<string, { fingerprint: string; result: ImageArtifact }>();
  async put(a: ImageArtifact): Promise<ImageArtifact> {
    checkImageArtifact(a);
    const fingerprint = JSON.stringify(a, Object.keys(a).sort());
    const scoped = `imageArtifacts.put:${a.idempotencyKey}`;
    const hit = this.keys.get(scoped);
    if (hit) {
      if (hit.fingerprint !== fingerprint) throw new IdempotencyConflictError("imageArtifacts.put", a.idempotencyKey);
      return structuredClone(hit.result);
    }
    const slot = imageArtifactSlot(a.configDigest, a.backend);
    const stored = this.rows.get(slot) ?? null;
    const replay = replayOfImageArtifact(stored, a);
    if (replay) return structuredClone(replay);
    assertImageArtifactFence(stored, a);
    this.rows.set(slot, structuredClone(a));
    this.keys.set(scoped, { fingerprint, result: structuredClone(a) });
    return structuredClone(a);
  }
  async get(configDigest: string, backend: string | null): Promise<ImageArtifact | null> {
    const a = this.rows.get(imageArtifactSlot(configDigest, backend));
    return a ? structuredClone(a) : null;
  }
}

export interface ImageArtifactsContractWorld {
  imageArtifacts: ImageArtifacts;
}

// ImageArtifacts contract: a replay of one key returns the stored artifact (one row); the same key with different content is an
// IdempotencyConflictError that changes nothing; a write below the slot's generation is StaleGenerationError; an equal or higher one
// replaces; slots are per backend; a path-looking reference or a bad digest is refused and nothing is stored.
export async function imageArtifactsContractBody(w: ImageArtifactsContractWorld): Promise<void> {
  const ia = w.imageArtifacts;
  const digest = `sha256:${"a".repeat(64)}`;
  const base: ImageArtifact = {
    configDigest: digest,
    revision: "r1",
    engineLocalId: null,
    providerImage: "tmpl-1",
    backend: "e2b",
    hostId: "h",
    generation: 2,
    idempotencyKey: "ia-1",
  };
  const first = await ia.put(base);
  assert.deepEqual(first, base);
  assert.deepEqual(await ia.put({ ...base }), first); // replay: same key, same content
  assert.deepEqual(await ia.get(digest, "e2b"), base);
  assert.equal(await ia.get(digest, null), null);
  assert.equal(await ia.get(digest, "docker"), null);
  await assert.rejects(() => ia.put({ ...base, providerImage: "tmpl-2" }), IdempotencyConflictError);
  assert.deepEqual(await ia.get(digest, "e2b"), base); // the conflict changed nothing
  await assert.rejects(() => ia.put({ ...base, generation: 1, idempotencyKey: "ia-stale" }), StaleGenerationError);
  assert.deepEqual(await ia.get(digest, "e2b"), base);
  // Decision: equal generation, different key and content, overwrites (last write wins within a generation).
  const same = await ia.put({ ...base, idempotencyKey: "ia-eq", providerImage: "tmpl-3" });
  assert.equal((await ia.get(digest, "e2b"))?.providerImage, "tmpl-3");
  assert.equal(same.providerImage, "tmpl-3");
  const up = await ia.put({ ...base, idempotencyKey: "ia-up", generation: 3, providerImage: "tmpl-4" });
  assert.equal((await ia.get(digest, "e2b"))?.generation, 3);
  assert.deepEqual(await ia.put({ ...base, idempotencyKey: "ia-up", generation: 3, providerImage: "tmpl-4" }), up);
  await ia.put({ ...base, backend: null, providerImage: undefined, idempotencyKey: "ia-reg", generation: 1 }); // another slot, lower generation is fine
  assert.equal((await ia.get(digest, null))?.generation, 1);
  assert.equal((await ia.get(digest, "e2b"))?.generation, 3);
  for (const [i, bad] of [
    { providerImage: "/var/lib/images/x" },
    { providerImage: "../x" },
    { engineLocalId: "C:\\images\\x" },
    { engineLocalId: "file:///x" },
    { configDigest: "sha256:abc" },
  ].entries()) {
    await assert.rejects(
      () => ia.put({ ...base, ...bad, configDigest: bad.configDigest ?? `sha256:${"b".repeat(64)}`, idempotencyKey: `ia-bad-${i}` }),
      /image artifact/,
    );
  }
  assert.equal(await ia.get(`sha256:${"b".repeat(64)}`, "e2b"), null);
}

export interface CheckpointFenceContractWorld {
  checkpoints: CheckpointStore;
  registry: Registry;
}

// CheckpointStore fence + shape contract: a write below the registry generation is rejected with
// StaleGenerationError, an idempotent replay returns the original, the template fields round-trip,
// and the stored row has no filesystem path value (rows hold ids and hashes only).
export async function checkpointFenceContractBody(w: CheckpointFenceContractWorld): Promise<void> {
  const { checkpoints: cs, registry } = w;
  const a = await registry.create({
    id: "cf-a",
    parent: null,
    name: "n",
    task: "t",
    host: "h",
    budgetMicros: 1,
    spec: CONTRACT_SPAWN_SPEC,
    idempotencyKey: "cf-create",
  });
  const base = {
    agent: a.id,
    host: "h",
    generation: a.generation,
    sessionRef: "abc123",
    workspace: "ws-a",
    node: "h",
    ingested: { ref: "refs/agents/a/heads/x", commit: "deadbeef" },
    wait: null,
    remainingBudgetMicros: 1,
    imageDigest: "img@sha256:1",
    envManifestHash: null,
    template: "code",
    templateDigest: "d1",
    resumeLevel: "task" as const,
  };
  const first = await cs.write(base, "cf-1");
  assert.deepEqual([first.template, first.templateDigest, first.resumeLevel], ["code", "d1", "task"]);
  assert.equal(first.version, CHECKPOINT_FORMAT); // the store stamps the format version
  assert.deepEqual(await cs.write({ ...base, ingested: null }, "cf-1"), first); // replay returns the original
  assert.deepEqual(await cs.read(first.id), first);
  assert.deepEqual(await cs.latest(a.id), first);
  const bumped = await registry.bumpGeneration(a.id, "h", "cf-bump");
  await assert.rejects(() => cs.write(base, "cf-stale"), StaleGenerationError); // below the registry generation
  const fresh = await cs.write({ ...base, generation: bumped.generation, templateDigest: null, resumeLevel: "none" }, "cf-2");
  assert.deepEqual([fresh.templateDigest, fresh.resumeLevel], [null, "none"]);
  for (const c of [first, fresh]) {
    const row = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(row)) assert.ok(!(typeof v === "string" && v.startsWith("/")), `checkpoint field ${k} looks like a path`);
  }
}

export interface MountProviderContractWorld {
  mounts: MountProvider;
}

// MountProvider port contract: workspace/session/bind resolve to a bind whose containerPath and
// readOnly carry over, scratch resolves to tmpfs, resolution is deterministic, and the spec itself
// never gains a host path (host paths exist only in the ResolvedMount).
export async function mountProviderContractBody(w: MountProviderContractWorld): Promise<void> {
  const m = w.mounts;
  const ws: MountSpec = { kind: "workspace", workspace: "ws-a", containerPath: "/work" };
  const r1 = await m.resolve("a", ws);
  assert.equal(r1.type, "bind");
  if (r1.type === "bind") {
    assert.equal(r1.containerPath, "/work");
    assert.equal(r1.readOnly, false);
    assert.ok(r1.hostPath.length > 0);
  }
  assert.deepEqual(await m.resolve("a", ws), r1); // deterministic
  const ro = await m.resolve("a", { kind: "session", agent: "a", containerPath: "/session", readOnly: true });
  assert.equal(ro.type, "bind");
  if (ro.type === "bind") assert.deepEqual([ro.containerPath, ro.readOnly], ["/session", true]);
  const tmp = await m.resolve("a", { kind: "scratch", containerPath: "/tmp", sizeBytes: 1024 });
  assert.deepEqual(tmp, { type: "tmpfs", containerPath: "/tmp", sizeBytes: 1024 });
  const b = await m.resolve("a", { kind: "bind", hostPath: "/srv/x", containerPath: "/x" });
  assert.deepEqual(b, { type: "bind", hostPath: "/srv/x", containerPath: "/x", readOnly: false });
  assert.deepEqual(Object.keys(ws).sort(), ["containerPath", "kind", "workspace"]);
}

// Workspace port contract. `bundle` produces bytes the implementation ingests as `refs/agents/<agent>/heads/<name>`
// tipping `commit` (fake: JSON; GitWorkspace: a real git bundle). `remote` is a push target for `publish`.
export interface WorkspaceContractWorld {
  ws: Workspace;
  remote: string;
  // `onTop` makes the new tip a child of that commit; without it the tip is unrelated to earlier ones (a stale push).
  bundle(agent: AgentId, name: string, opts?: { onTop?: string }): Promise<{ bytes: Uint8Array; commit: string }>;
  mainCommit(): string; // a commit on the mirror's default branch (publishable by any agent)
  // Scripts that `agent`'s work counts as merged into its descendants' refs (fake: `merged`); real adapters derive it from ancestry and omit this.
  markMerged?(agent: AgentId): void;
}

export async function workspaceContractBody(w: WorkspaceContractWorld): Promise<void> {
  const { ws } = w;
  const stream = (b: Uint8Array) =>
    (async function* () {
      yield b;
    })();
  const drain = async (it: AsyncIterable<Uint8Array>) => {
    let n = 0;
    for await (const c of it) n += c.byteLength;
    return n;
  };
  const rejectsId = async (id: string) => assert.rejects(ws.create(id, {}));
  for (const bad of ["", "a/b", "..", "-x", ".x"]) await rejectsId(bad);

  const a = await ws.create("a", {});
  assert.equal(a.branch, "agent/a");
  assert.match(a.workspace, /^[A-Za-z0-9_.-]+$/); // opaque id, never a path
  assert.equal(await ws.has("a"), true);
  assert.deepEqual(await ws.create("a", {}), a); // idempotent
  assert.deepEqual(await ws.list(), ["a"]);

  const f = await ws.fork("a", "b");
  assert.equal(f.commit, a.commit);
  assert.notEqual(f.workspace, a.workspace);
  assert.equal(await ws.has("b"), true);

  assert.equal(await ws.ingested("a"), null);
  const one = await w.bundle("a", "agent/a");
  const r1 = await ws.ingest("a", stream(one.bytes), { maxBytes: 1 << 20 });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.deepEqual(r1.refs, [{ ref: "refs/agents/a/heads/agent/a", commit: one.commit }]);
  assert.deepEqual(await ws.ingested("a"), r1.refs[0]);
  const again = await ws.ingest("a", stream(one.bytes), { maxBytes: 1 << 20 }); // idempotent
  assert.deepEqual(again, r1);

  const tooBig = await ws.ingest("a", stream(one.bytes), { maxBytes: 1 });
  assert.equal(tooBig.ok === false && tooBig.code, "too_large");
  assert.deepEqual(await ws.ingested("a"), r1.refs[0]); // a failure changes nothing

  assert.ok((await drain(await ws.serve("a"))) > 0);
  assert.ok((await drain(await ws.serve("b", { scope: "a" }))) > 0);

  const pinned = await ws.resolve("a", r1.refs[0]!.ref);
  assert.equal(pinned.commit, one.commit);
  await assert.rejects(ws.resolve("b", r1.refs[0]!.ref)); // another agent's ref
  await assert.rejects(ws.publish("a", { commit: "0".repeat(40), remote: w.remote, target: "main" })); // unreachable
  await ws.publish("a", { commit: pinned.commit, remote: w.remote, target: "out" });

  assert.equal(await ws.prune("a", { mergedInto: "b" }), "refused"); // not merged: nothing lost

  await ws.evict("a");
  await ws.evict("a"); // idempotent
  assert.equal(await ws.has("a"), false);
  assert.deepEqual(await ws.list(), ["b"]);
  assert.deepEqual(await ws.ingested("a"), r1.refs[0]); // refs outlive the folder

  // Prune is tri-state: "nothing" (no refs: never ingested, or already pruned), "refused" (refs stay), "pruned".
  assert.equal(await ws.prune("never-ingested", { mergedInto: "b" }), "nothing");
  await ws.create("pm", {});
  const pm = await w.bundle("pm", "agent/pm");
  assert.equal((await ws.ingest("pm", stream(pm.bytes), { maxBytes: 1 << 20 })).ok, true);
  await ws.fork("pm", "pt");
  assert.equal(await ws.prune("pm", { mergedInto: "pt" }), "refused"); // the target has no refs yet
  const pt = await w.bundle("pt", "agent/pt", { onTop: pm.commit });
  assert.equal((await ws.ingest("pt", stream(pt.bytes), { maxBytes: 1 << 20 })).ok, true);
  assert.equal(await ws.prune("pt", { mergedInto: "pm" }), "refused"); // pt's tip is not an ancestor of pm's
  assert.notEqual(await ws.ingested("pt"), null);
  w.markMerged?.("pm");
  assert.equal(await ws.prune("pm", { mergedInto: "pt" }), "pruned");
  assert.equal(await ws.ingested("pm"), null);
  assert.equal(await ws.prune("pm", { mergedInto: "pt" }), "nothing"); // a replay after a crash between prune and mark
  assert.equal(await ws.prune("pt", { mergedInto: "pt" }), "refused"); // never prunes the target itself
  await ws.evict("pm");
  await ws.evict("pt");

  // Ingest is fast-forward only; `force` overrides and is reported; a stale push cannot erase newer work.
  const tipOf = async () => JSON.stringify(await ws.ingested("b"));
  const b1 = await w.bundle("b", "agent/b");
  assert.equal((await ws.ingest("b", stream(b1.bytes), { maxBytes: 1 << 20 })).ok, true);
  const b2 = await w.bundle("b", "agent/b", { onTop: b1.commit });
  const ff = await ws.ingest("b", stream(b2.bytes), { maxBytes: 1 << 20 });
  assert.deepEqual([ff.ok, ff.ok && ff.forced, ff.ok && ff.refs[0]!.commit], [true, undefined, b2.commit]);
  const stale = await w.bundle("b", "agent/b");
  const before = await tipOf();
  const refused = await ws.ingest("b", stream(stale.bytes), { maxBytes: 1 << 20 });
  assert.equal(refused.ok === false && refused.code, "non_fast_forward");
  assert.ok(!refused.ok && refused.message.includes("refs/agents/b/heads/agent/b"));
  assert.equal(await tipOf(), before); // the newer tip survives
  assert.equal((await ws.ingested("b"))?.commit, b2.commit);
  const forcedRes = await ws.ingest("b", stream(stale.bytes), { maxBytes: 1 << 20, force: true });
  assert.deepEqual([forcedRes.ok, forcedRes.ok && forcedRes.forced, (await ws.ingested("b"))?.commit], [true, true, stale.commit]);
  // publish also accepts a commit on the default branch, and still refuses one reachable from neither
  await ws.publish("b", { commit: w.mainCommit(), remote: w.remote, target: "from-main" });
  await assert.rejects(ws.publish("b", { commit: "1".repeat(40), remote: w.remote, target: "nope" }));
  await ws.evict("b");
}

// ---- Model debit contract ----------------------------------------------------------------
// Mirrors request-budget's semantics and runs against both the fake and the durable store.
export interface ModelDebitContractWorld {
  // Both the fake and the durable store implement the optional ledger methods (touch, ledgerFor, settledCall).
  debits: DurableModelDebitStore & Required<Pick<DurableModelDebitStore, "touch" | "ledgerFor" | "settledCall">>;
  secret: string;
  now(): number;
  advance(ms: number): void; // moves `now` forward
  // The metadata recordCall last stored for (agent, requestId), read back from the implementation's own storage (fake: its
  // `callMeta` map; real: the ledger row's columns), omitted fields absent. Read only after a successful recordCall.
  callMeta(agent: AgentId, requestId: string): ModelCallMeta | null;
}

export function modelDebitContractBody(w: ModelDebitContractWorld): void {
  const d = w.debits;
  const key = (id = "a".repeat(32), budgetMicros = 100, agent = "agent-1") =>
    encodeGatewayCredential(w.secret, { agent, id, budgetMicros, expiresAt: w.now() + 1_000, issuedAt: w.now(), models: ["m1"] });

  // Verifies credentials; rejects malformed and expired ones.
  assert.equal(d.reserve("not-a-token", "r1", 1).ok, false);
  assert.deepEqual(d.reserve(key("a".repeat(32)), "r1", 30), {
    ok: true,
    reservation: { agent: "agent-1", credentialId: "a".repeat(32), requestId: "r1" },
    remainingMicros: 70,
  });
  const expired = encodeGatewayCredential(w.secret, {
    agent: "agent-expired",
    id: "b".repeat(32),
    budgetMicros: 10,
    expiresAt: w.now(),
    issuedAt: w.now() - 1,
    models: ["m1"],
  });
  assert.deepEqual(d.reserve(expired, "r2", 1), { ok: false, reason: "invalid-credential" });
  // checkCredential tells the refusals apart (reserve still reports them all as "invalid-credential"), and is read-only.
  assert.deepEqual(d.checkCredential(expired), { ok: false, reason: "expired" });
  assert.deepEqual(d.checkCredential("not-a-token"), { ok: false, reason: "invalid" });
  assert.deepEqual(d.checkCredential(`${expired}x`), { ok: false, reason: "invalid" }, "a tampered expired key is invalid, not expired");
  const valid = key("d".repeat(32), 5, "agent-check");
  assert.deepEqual(d.checkCredential(valid), { ok: true, credential: d.authorize(valid) });
  assert.deepEqual(d.authorize(valid)?.models, ["m1"], "the model allowlist is part of the verified credential");
  // Fail closed: a correctly signed credential without a `models` allowlist (a pre-allowlist token) is invalid everywhere.
  const { models: _dropped, ...noModels } = {
    agent: "agent-check",
    id: "d".repeat(32),
    budgetMicros: 5,
    expiresAt: w.now() + 1_000,
    issuedAt: w.now(),
    models: [],
  };
  const legacy = encodeGatewayCredential(w.secret, noModels as GatewayCredential);
  assert.deepEqual(d.checkCredential(legacy), { ok: false, reason: "invalid" });
  assert.equal(d.authorize(legacy), null);
  assert.deepEqual(d.reserve(legacy, "legacy-1", 1), { ok: false, reason: "invalid-credential" });

  // Reserves before forwarding and releases the unused upper bound at settlement.
  const first = d.reserve(key("c".repeat(32), 100, "agent-2"), "req-1", 60);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(d.reserve(key("d".repeat(32), 100, "agent-2"), "req-2", 41), { ok: false, reason: "budget-exhausted" });
  // spentFor is the settled-charge ledger: unknown agents and mere reservations read as 0.
  assert.equal(d.spentFor("agent-2"), 0);
  assert.equal(d.spentFor("agent-never-seen"), 0);
  assert.deepEqual(d.settle(first.reservation, 12), { ok: true, chargedMicros: 12, remainingMicros: 88 });
  assert.equal(d.spentFor("agent-2"), 12);
  assert.equal(d.reserve(key("c".repeat(32), 100, "agent-2"), "req-3", 88).ok, true);
  assert.equal(d.spentFor("agent-2"), 12, "an in-flight reservation is not spend");

  // Idempotent by request id; a second token cannot reuse or enlarge the agent cap.
  const k1 = key("e".repeat(32), 100, "agent-3");
  const r4 = d.reserve(k1, "request-1", 80);
  assert.equal(r4.ok, true);
  if (!r4.ok) return;
  // A request id is single-use: replaying an in-flight (reserved) id must not authorize a second
  // upstream call, and neither must replaying a settled id (settle would be an idempotent no-charge).
  assert.deepEqual(d.reserve(k1, "request-1", 80), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(d.reserve(k1, "request-1", 81), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(d.settle(r4.reservation, 5), { ok: true, chargedMicros: 5, remainingMicros: 95 });
  assert.deepEqual(d.reserve(k1, "request-1", 80), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(d.settle(r4.reservation, 99), { ok: true, chargedMicros: 5, remainingMicros: 95 }); // settle replay charges nothing more
  assert.deepEqual(d.reserve(key("f".repeat(32), 100, "agent-3"), "request-3", 96), { ok: false, reason: "budget-exhausted" });
  assert.deepEqual(d.reserve(key("f".repeat(32), 100, "agent-3"), "request-1", 80), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(d.reserve(key("f".repeat(32), 100, "agent-3"), "request-2", 96), { ok: false, reason: "budget-exhausted" });

  // Overcharge is recorded in full (the provider billed it), so the remaining budget can go negative;
  // cancellation releases only unforwarded work, and a cancelled id is not reusable.
  const k2 = key("0".repeat(32), 100, "agent-4");
  const r5 = d.reserve(k2, "r5", 50);
  assert.equal(r5.ok, true);
  if (!r5.ok) return;
  assert.deepEqual(d.settle(r5.reservation, 120), { ok: true, chargedMicros: 120, remainingMicros: -20 });
  assert.equal(d.spentFor("agent-4"), 120, "a true overcharge is recorded in full");
  assert.deepEqual(d.reserve(k2, "r6", 1), { ok: false, reason: "budget-exhausted" });
  const k2b = key("9".repeat(32), 100, "agent-4b");
  const r7 = d.reserve(k2b, "r7", 50);
  assert.equal(r7.ok, true);
  if (!r7.ok) return;
  assert.equal(d.cancel(r7.reservation), true);
  assert.deepEqual(d.reserve(k2b, "r7", 50), { ok: false, reason: "idempotency-conflict" });
  assert.equal(d.reserve(k2b, "r8", 50).ok, true);

  // Stale reservations (an upstream call that never completed) are reclaimable; settled ones are not.
  const k4 = key("4".repeat(32), 100, "agent-7");
  const stale = d.reserve(k4, "s1", 40);
  const done = d.reserve(k4, "s2", 30);
  assert.ok(stale.ok && done.ok);
  if (!stale.ok || !done.ok) return;
  assert.deepEqual(d.settle(done.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 50 });
  assert.equal(d.expireReservations(400), 0); // nothing is old enough yet
  w.advance(500);
  assert.ok(d.expireReservations(400) >= 1); // sweeps every stale reservation, including s1 (s2 is settled)
  assert.equal(d.cancel(stale.reservation), false); // already released
  assert.deepEqual(d.reserve(k4, "s1", 40), { ok: false, reason: "idempotency-conflict" }); // an expired id is not reusable
  assert.equal(d.spentFor("agent-7"), 50, "expiry charges the full reservation (fail-closed): 10 settled + 40 expired");
  // A late settle never re-charges the reserved amount; only an overage above it is topped up. Every settle of an expired
  // row says so (`expiredCharged`), and a normal settle (or its replay) never does.
  assert.deepEqual(d.settle(stale.reservation, 25), { ok: true, chargedMicros: 40, remainingMicros: 50, expiredCharged: true });
  assert.deepEqual(d.settle(stale.reservation, 40), { ok: true, chargedMicros: 40, remainingMicros: 50, expiredCharged: true });
  assert.deepEqual(d.settle(done.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 50 }, "a settled row's replay is not expired");
  assert.equal(d.spentFor("agent-7"), 50);
  assert.equal(d.cancel(stale.reservation), false);
  const fresh = d.reserve(k4, "s3", 10);
  assert.equal(fresh.ok, true);
  assert.equal(d.expireReservations(400), 0); // s3 is fresh
  assert.deepEqual(d.reserve(k4, "s4", 41), { ok: false, reason: "budget-exhausted" }); // remaining is 100 - 50 - 10
  assert.deepEqual(d.reserve(k4, "s4", 40), { ok: true, reservation: { agent: "agent-7", credentialId: "4".repeat(32), requestId: "s4" }, remainingMicros: 0 });
  assert.deepEqual(d.settle(stale.reservation, 55), { ok: true, chargedMicros: 55, remainingMicros: -15, expiredCharged: true }); // overage tops up by 15
  assert.equal(d.spentFor("agent-7"), 65);
  assert.deepEqual(d.settle(stale.reservation, 99), { ok: true, chargedMicros: 99, remainingMicros: -59, expiredCharged: true });
  assert.equal(d.spentFor("agent-7"), 109);

  // A refreshed credential with a larger budget never enlarges an established bucket.
  const small = d.reserve(key("1".repeat(32), 40, "agent-5"), "req-6", 30);
  assert.equal(small.ok, true);
  if (!small.ok) return;
  assert.deepEqual(d.reserve(key("2".repeat(32), 100, "agent-5"), "req-7", 11), { ok: false, reason: "budget-exhausted" });

  // setBudget sets the TOTAL cap (spend untouched): it grows, is idempotent, and a request refused for
  // budget-exhausted succeeds once the cap is raised; shrinking is explicit and never goes below what is passed.
  const kb = key("7".repeat(32), 50, "agent-9");
  const rb = d.reserve(kb, "b1", 40);
  assert.ok(rb.ok);
  if (!rb.ok) return;
  assert.deepEqual(d.settle(rb.reservation, 40), { ok: true, chargedMicros: 40, remainingMicros: 10 });
  assert.deepEqual(d.reserve(kb, "b2", 30), { ok: false, reason: "budget-exhausted" });
  d.setBudget("agent-9", 100);
  assert.equal(d.spentFor("agent-9"), 40, "setBudget does not touch spent");
  assert.deepEqual(d.reserve(kb, "b3", 30), {
    ok: true,
    reservation: { agent: "agent-9", credentialId: "7".repeat(32), requestId: "b3" },
    remainingMicros: 30,
  });
  d.setBudget("agent-9", 100); // idempotent
  assert.equal(d.spentFor("agent-9"), 40);
  assert.deepEqual(d.reserve(kb, "b4", 31), { ok: false, reason: "budget-exhausted" });
  d.setBudget("agent-9", 60); // explicit shrink: remaining goes negative, spent unchanged
  assert.equal(d.spentFor("agent-9"), 40);
  assert.deepEqual(d.reserve(kb, "b5", 1), { ok: false, reason: "budget-exhausted" });
  assert.deepEqual(d.reserve(key("8".repeat(32), 1_000, "agent-9"), "b6", 1), { ok: false, reason: "budget-exhausted" }); // a credential's own budget never enlarges the cap
  d.setBudget("agent-fresh", 25); // unknown agent: creates the bucket
  assert.equal(d.spentFor("agent-fresh"), 0);
  assert.equal(d.reserve(key("a1".repeat(16), 1, "agent-fresh"), "f1", 25).ok, true);
  assert.throws(() => d.setBudget("agent-9", -1));
  assert.throws(() => d.setBudget("agent-9", 1.5));

  // Durable revocation is checked by both authorize and reserve.
  const k3 = key("3".repeat(32), 100, "agent-6");
  assert.ok(d.authorize(k3));
  d.revoke("agent-6");
  assert.equal(d.authorize(k3), null);
  assert.deepEqual(d.reserve(k3, "r9", 1), { ok: false, reason: "invalid-credential" });
  assert.deepEqual(d.checkCredential(k3), { ok: false, reason: "revoked" });

  // Revocation kills credentials issued up to the revoke instant, not one issued afterwards (a resumed
  // run); a request reserved with the old credential still settles, and the bucket carries over.
  const k5 = key("5".repeat(32), 100, "agent-8");
  const inflight = d.reserve(k5, "i1", 30);
  assert.ok(inflight.ok);
  if (!inflight.ok) return;
  d.revoke("agent-8");
  assert.equal(d.authorize(k5), null);
  assert.deepEqual(d.reserve(k5, "i2", 1), { ok: false, reason: "invalid-credential" });
  assert.deepEqual(d.settle(inflight.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 90 });
  w.advance(1);
  const k5b = key("6".repeat(32), 100, "agent-8");
  assert.ok(d.authorize(k5b));
  assert.deepEqual(d.reserve(k5b, "i3", 20), {
    ok: true,
    reservation: { agent: "agent-8", credentialId: "6".repeat(32), requestId: "i3" },
    remainingMicros: 70,
  });
  assert.equal(d.authorize(k5), null); // the old token stays dead
  d.revoke("agent-8"); // a second yield revokes the resumed run's credential too
  assert.equal(d.authorize(k5b), null);
  assert.deepEqual(d.reserve(k5b, "i4", 1), { ok: false, reason: "invalid-credential" });

  // Atomic issuance: a stamp is strictly after the revocation, and a credential issued before a revoke is
  // killed by the cutoff even at the same instant. A clock below the latest stamp still yields a stamp at or above it.
  const stamp = (id: string, issuedAt: number, agent: string) =>
    encodeGatewayCredential(w.secret, { agent, id, budgetMicros: 100, expiresAt: w.now() + 1_000, issuedAt, models: ["m1"] });
  const s1 = d.issue("agent-10", w.now());
  assert.ok(d.authorize(stamp("7".repeat(32), s1, "agent-10")));
  d.revoke("agent-10");
  assert.equal(d.authorize(stamp("7".repeat(32), s1, "agent-10")), null, "a same-instant credential is killed by the cutoff");
  const s2 = d.issue("agent-10", w.now());
  assert.ok(s2 > s1, "a fresh issue after a revoke is strictly later");
  assert.ok(d.authorize(stamp("8".repeat(32), s2, "agent-10")));
  assert.ok(d.issue("agent-10", w.now() - 500) >= s2, "a backward clock never issues below the high-water");

  // recordCall: false for a request id never reserved (or an agent with no bucket); true once reserved, before and
  // after settlement; a replay is idempotent; it never moves spend.
  const kc = key("9".repeat(32), 100, "agent-11");
  const meta = { model: "m1", tokensIn: 7, tokensOut: 3, cacheReadTokens: 5, cacheWriteTokens: 2, upstreamStatus: 200, latencyMs: 12, finishReason: "stop" };
  assert.equal(d.recordCall("agent-11", "c1", meta), false, "agent without a bucket");
  const rc = d.reserve(kc, "c1", 40);
  assert.ok(rc.ok);
  if (!rc.ok) return;
  assert.equal(d.recordCall("agent-11", "nope", meta), false, "unknown request id");
  assert.equal(d.recordCall("other-agent", "c1", meta), false, "request ids are per agent");
  assert.equal(d.recordCall("agent-11", "c1", { model: "m0" }), true, "an in-flight reservation has a row");
  assert.deepEqual(d.settle(rc.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 90 });
  assert.equal(d.recordCall("agent-11", "c1", meta), true);
  assert.equal(d.recordCall("agent-11", "c1", meta), true, "replay rewrites the same values");
  assert.deepEqual(w.callMeta("agent-11", "c1"), meta, "every field round-trips");
  assert.equal(d.recordCall("agent-11", "c1", {}), true, "empty metadata is accepted");
  assert.deepEqual(w.callMeta("agent-11", "c1"), {}, "omitted fields are cleared, not merged");
  assert.equal(d.spentFor("agent-11"), 10, "metadata never moves spend");

  // A failed call: cancelled, then its closed route and error class are recorded beside the status (no tokens).
  const rf = d.reserve(kc, "c2", 10);
  assert.ok(rf.ok);
  if (!rf.ok) return;
  assert.equal(d.cancel(rf.reservation), true);
  const failed = { model: "m1", upstreamStatus: 503, latencyMs: 9, route: "messages", errorClass: "upstream_5xx" } as const;
  assert.equal(d.recordCall("agent-11", "c2", failed), true, "a cancelled call's row still takes metadata");
  assert.deepEqual(w.callMeta("agent-11", "c2"), failed);
  assert.equal(d.recordCall("agent-11", "c2", { route: "chat_completions", errorClass: "timeout" }), true);
  assert.deepEqual(w.callMeta("agent-11", "c2"), { route: "chat_completions", errorClass: "timeout" }, "a replay replaces the classes too");
  assert.equal(d.spentFor("agent-11"), 10);

  // touch keeps an in-flight reservation alive: expiry measures idleness since the last touch, not age. It is false for a
  // reservation that is not in flight (expired, settled, unknown, or presented under another credential id).
  const kt = key("ab".repeat(16), 100, "agent-12");
  const t1 = d.reserve(kt, "t1", 30);
  const t2 = d.reserve(kt, "t2", 20);
  assert.ok(t1.ok && t2.ok);
  if (!t1.ok || !t2.ok) return;
  w.advance(300);
  assert.equal(d.touch(t1.reservation), true);
  w.advance(300);
  assert.ok(d.expireReservations(400) >= 1, "t2 is idle past the cutoff");
  assert.equal(d.spentFor("agent-12"), 20, "only the untouched t2 was expire-charged");
  assert.equal(d.touch(t2.reservation), false, "an expired reservation is not in flight");
  assert.equal(d.touch({ ...t1.reservation, credentialId: "cd".repeat(16) }), false, "another credential id does not match");
  assert.equal(d.touch({ ...t1.reservation, requestId: "t-unknown" }), false);
  assert.deepEqual(d.settle(t1.reservation, 10), { ok: true, chargedMicros: 10, remainingMicros: 70 }, "the touched reservation settles normally");
  assert.equal(d.touch(t1.reservation), false, "a settled reservation is not in flight");

  // ledgerFor: an unregistered agent's bucket is its own root; committed is spend plus in-flight reservations, overage what
  // exceeds the budget. An agent with no bucket reads all zero.
  const t3 = d.reserve(kt, "t3", 15);
  assert.ok(t3.ok);
  if (!t3.ok) return;
  assert.deepEqual(d.ledgerFor("agent-12"), { budgetMicros: 100, committedMicros: 45, remainingMicros: 55, overageMicros: 0 });
  assert.deepEqual(d.ledgerFor("agent-4"), { budgetMicros: 100, committedMicros: 120, remainingMicros: -20, overageMicros: 20 });
  assert.deepEqual(d.ledgerFor("agent-never-seen"), { budgetMicros: 0, committedMicros: 0, remainingMicros: 0, overageMicros: 0 });

  // settledCall joins on the recorded provider response id, exactly and per agent, for settled and expire-charged calls only.
  assert.equal(d.recordCall("agent-12", "t1", { model: "m1", responseId: "msg_t1" }), true);
  assert.equal(d.recordCall("agent-12", "t2", { responseId: "msg_t2" }), true);
  assert.equal(d.recordCall("agent-12", "t3", { responseId: "msg_t3" }), true);
  assert.deepEqual(d.settledCall("agent-12", "msg_t1"), { requestId: "t1", chargedMicros: 10 });
  assert.deepEqual(d.settledCall("agent-12", "msg_t2"), { requestId: "t2", chargedMicros: 20 }, "an expire-charged call joins");
  assert.equal(d.settledCall("agent-12", "msg_t3"), null, "an in-flight call has not settled");
  assert.equal(d.settledCall("agent-11", "msg_t1"), null, "the join is per agent");
  assert.equal(d.settledCall("agent-12", "msg_t"), null, "the join is exact, never a prefix");
  assert.equal(d.settledCall("agent-12", "msg_none"), null);
  assert.equal(d.cancel(t3.reservation), true);
  assert.equal(d.settledCall("agent-12", "msg_t3"), null, "a cancelled call never joins");
}

// Scriptable, observable egress-audit reader (structural: the consumer's record type is generic, so testing does not depend on
// the adapter). Records are kept per sandbox; discover lists every sandbox spool that holds records or a retained ack, read is
// filtered by afterSequence and bounded by limit (1..256), ack is recorded and never filters reads. Each op consumes one scripted
// failure per call from its queue (undefined = succeed). Reads and discovers return clones.
export interface EgressAuditCall {
  op: "discover" | "read" | "ack" | "vacuumCandidate" | "vacuum" | "reapVacuumed";
  sandbox?: string;
  afterSequence?: number;
  afterChain?: string;
  limit?: number;
  throughSequence?: number;
  chain?: string;
  graceMs?: number;
  now?: number;
}
// Shape of a vacuum candidate (structural twin of sandbox-docker's EgressVacuumCandidate).
export interface FakeVacuumCandidate {
  sandbox: string;
  throughSequence: number;
  chain: string;
  bytes: number;
  closedAt: number;
}
// Vacuum model: `close(sandbox, closedAt)` stands for the host's closed marker. vacuumCandidate answers a candidate only for a
// closed spool, past the grace window, whose records are all acknowledged (ackedThrough covers the last sequence), reporting the
// last record's `chain`; `vacuum` deletes the spool (records and receipt) and is recorded. Like the real adapter it never deletes
// an un-acked spool, and unlike it does no hashing: chain checks are the consumer's job and are tested with scripted rows.
export class FakeEgressAuditReader<T extends { sandbox: string; sequence: number; chain?: string }> {
  readonly calls: EgressAuditCall[] = [];
  private readonly spools = new Map<string, T[]>();
  private readonly retained = new Map<string, number>();
  // Scripted per-call failures, consumed in order. undefined entries succeed.
  readonly failures: {
    discover: (Error | undefined)[];
    read: (Error | undefined)[];
    ack: (Error | undefined)[];
    vacuumCandidate: (Error | undefined)[];
    vacuum: (Error | undefined)[];
  } = { discover: [], read: [], ack: [], vacuumCandidate: [], vacuum: [] };
  private readonly closed = new Map<string, number>();
  // Sandboxes whose spool was vacuumed, in order (observable).
  readonly vacuumed: string[] = [];
  close(sandbox: string, closedAt: number): void {
    this.closed.set(sandbox, closedAt);
  }
  hasSpool(sandbox: string): boolean {
    return this.spools.has(sandbox) || this.retained.has(sandbox);
  }
  // Records one sandbox spool (replaces its contents).
  setRecords(sandbox: string, records: T[]): void {
    this.spools.set(
      sandbox,
      records.map((r) => structuredClone(r)),
    );
  }
  append(sandbox: string, record: T): void {
    const cur = this.spools.get(sandbox) ?? [];
    cur.push(structuredClone(record));
    this.spools.set(sandbox, cur);
  }
  // Highest sequence acknowledged for a sandbox (0 when never acked). Observable only; reads ignore it.
  ackedThrough(sandbox: string): number {
    return this.retained.get(sandbox) ?? 0;
  }
  private fail(op: keyof FakeEgressAuditReader<T>["failures"]): void {
    const e = this.failures[op].shift();
    if (e) throw e;
  }
  async discover(): Promise<string[]> {
    this.calls.push({ op: "discover" });
    this.fail("discover");
    return [...new Set([...this.spools.keys(), ...this.retained.keys()])].sort();
  }
  async read(sandbox: string, afterSequence: number, limit = 256, afterChain?: string): Promise<T[]> {
    this.calls.push({ op: "read", sandbox, afterSequence, limit, ...(afterChain !== undefined && { afterChain }) });
    this.fail("read");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error(`read limit must be 1..256, got ${limit}`);
    return (this.spools.get(sandbox) ?? [])
      .filter((r) => r.sequence > afterSequence)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async ack(sandbox: string, throughSequence: number, chain?: string): Promise<void> {
    this.calls.push({ op: "ack", sandbox, throughSequence, ...(chain !== undefined && { chain }) });
    this.fail("ack");
    this.retained.set(sandbox, Math.max(this.retained.get(sandbox) ?? 0, throughSequence));
  }
  async vacuumCandidate(sandbox: string, graceMs: number, now: number): Promise<FakeVacuumCandidate | undefined> {
    this.calls.push({ op: "vacuumCandidate", sandbox, graceMs, now });
    this.fail("vacuumCandidate");
    const closedAt = this.closed.get(sandbox);
    const records = this.spools.get(sandbox) ?? [];
    const last = records[records.length - 1];
    const through = last?.sequence ?? 0;
    if (closedAt === undefined || now - closedAt < graceMs || (this.retained.get(sandbox) ?? 0) < through) return undefined;
    return { sandbox, throughSequence: through, chain: last?.chain ?? "", bytes: records.length, closedAt };
  }
  vacuum(candidate: FakeVacuumCandidate): boolean {
    this.calls.push({ op: "vacuum", sandbox: candidate.sandbox, throughSequence: candidate.throughSequence });
    this.fail("vacuum");
    this.spools.delete(candidate.sandbox);
    this.retained.delete(candidate.sandbox);
    this.closed.delete(candidate.sandbox);
    this.vacuumed.push(candidate.sandbox);
    return true;
  }
  reapVacuumed(): number {
    this.calls.push({ op: "reapVacuumed" });
    return 0;
  }
}
