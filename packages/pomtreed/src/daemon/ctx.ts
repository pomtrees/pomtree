// The shared context every Daemon module is constructed with.
// Type-only imports from the rest of pomtreed keep this file a leaf, so the modules stay acyclic.

import type {
  AgentId,
  AgentRecord,
  Approval,
  Checkpoint,
  Escalation,
  EscalationId,
  ExitCause,
  ExitStatus,
  IngestResult,
  JournalEntry,
  JournalPayload,
  MessageKind,
  MessageSentPayload,
  MessagingSender,
  Signal,
  WaitCondition,
  WorkspaceId,
} from "@pomtree/core";
import type { DaemonDeps, Live, SpawnRequest } from "../daemon-types.ts";
import type { WaitCtx } from "../daemon-util.ts";
import type { Limits } from "../lifecycle.ts";

// What a user-bound message says about its reply (core MessageSentPayload): `subjectKind` for an ask or an approval, and
// an ask's offered `options`, so an adapter renders the right controls.
export type UserMessageExtra = Pick<MessageSentPayload, "subjectKind" | "options">;

// Late-bound collaborators a lower layer needs from a higher one (or from the Daemon facade). Each member is a
// narrow, type-only interface. A call upward goes through the hub, never an import.
export interface Hub {
  // The Daemon facade's own `root()` (creates/reads the root supervisor record); Tree needs its id.
  root: { root(): Promise<AgentRecord> };
  // Messaging sits below escalation and lifecycle, so everything it calls upward goes through these members.
  // The blocked long-poll registry (Daemon.onKick; `kicks` stays with lifecycle).
  kicks: { onKick(agent: AgentId | undefined, fn: () => void): () => void; kick(agent: AgentId): void };
  // The ONE user-bound `message_sent` writer. It stays on Daemon because the guard in daemon.touser.test.ts reads daemon.ts.
  user: { sendToUser(a: AgentRecord, purpose: MessageKind, subject: string, key: string, replyTo?: string, extra?: UserMessageExtra): Promise<void> };
  // receiveMessage routes replies into escalation answers, passes and approval decisions, and chat approvals.
  escalation: {
    answerEscalation(id: EscalationId, answer: string, by: MessagingSender, key: string): Promise<Escalation>;
    passEscalation(id: EscalationId, agent: AgentId | null, key: string): Promise<Escalation>;
    answerEscalationAs(agent: AgentId, id: EscalationId, answer: string, key: string): Promise<Escalation>;
    openApproval(agent: AgentRecord, kind: string, target: string, key: string): Promise<Approval>;
    getApprovalFor(agent: AgentId, id: string): Promise<Approval | null>;
    decideApproval(
      id: string,
      decision: "approve" | "deny" | "pass",
      who: string,
      why: string,
      key: string,
      as?: { agent?: AgentId; grantMicros?: number },
    ): Promise<Approval>;
    requireApproval(agent: AgentRecord, kind: string, target: string, key: string): Promise<Approval>;
    safeWake(agent: AgentId, signal: Signal, rec: AgentRecord | null, errKey: string): Promise<void>;
    // Merge: the failed-merge escalation is a `pomtree ask` (stays on Daemon).
    ask(
      agent: AgentId,
      req: { question: string; options?: string[]; generation: number; idempotencyKey: string },
    ): Promise<{ escalation: Escalation; delivered: boolean }>;
  };
  // performAction's operator message route (queue or interrupt) is the Daemon's messageAgent.
  operator: {
    messageAgent(agent: AgentId, body: string, key: string, mode: "queue" | "interrupt", o: { from: MessagingSender; audited: boolean }): Promise<unknown>;
  };
  // Escalation calls up into budget, lifecycle and reconcile through these members.
  budget: {
    isParked(r: AgentRecord): Promise<boolean>;
    // applyBudgetDecision for a settled budget_raise approval; a failure goes to Daemon.hookError (retried by the next reconcile tick).
    applyDecision(requester: AgentId): Promise<void>;
  };
  reconcile: {
    isQuarantined(a: AgentRecord): Promise<boolean>;
    // Held for a sandbox backend this daemon cannot reach (Reconcile.held): never resumed, killed or revoked by a supervisor path.
    isHeld(id: AgentId): boolean;
    // Sweeps and the watchdog share the reconcile-error journal line and the sandbox reclaim.
    journalError(a: AgentRecord, e: unknown): Promise<void>;
    reclaimSandbox(r: AgentRecord, force?: boolean): Promise<void>;
  };
  // The keyed op markers (opSeen/markOp) that make agent-originated mutations replay-safe.
  ops: {
    seen(agent: AgentId, op: string, key: string | undefined): Promise<boolean>;
    // `find` and the `extra` fields serve reap and the other keyed ops.
    find(agent: AgentId, op: string, key: string | undefined): Promise<{ unusedMicros?: number; delivered?: string; checkpoint?: string } | null>;
    mark(
      rec: AgentRecord | null,
      op: string,
      key: string | undefined,
      extra?: { unusedMicros?: number; delivered?: string; checkpoint?: string },
    ): Promise<void>;
  };
  // receiveMessage's cancel and spawn intents.
  lifecycle: {
    cancel(id: AgentId, graceMs: number | undefined, key?: string): Promise<unknown>;
    spawn(requester: AgentId, req: SpawnRequest): Promise<AgentRecord>;
    // Budget: runs fn inside the lifecycle-owned `spawning` chain (budget never makes its own).
    exclusiveSpawn(fn: () => Promise<void>): Promise<void>;
    resumeAgent(
      agent: AgentId,
      wake: string | undefined,
      opts: { forced?: boolean; grant?: boolean; observedGeneration?: number; operator?: boolean; interruptMode?: InterruptMode },
      key?: string,
    ): Promise<AgentRecord>;
    // The single forced-resume chokepoint (Lifecycle.forceResume, reached via the Daemon delegate); reconcile and the watchdog sweep enter through it.
    forceResume(
      agent: AgentRecord,
      observedGeneration: number,
      cause: ForceResumeCause,
      o?: { wake?: string | (() => Promise<string | undefined>); restartReason?: string; isStale?: () => boolean },
    ): Promise<"resumed" | "superseded" | "skipped" | "exhausted">;
    finish(id: AgentId, exit: ExitStatus, result?: unknown, cause?: ExitCause): Promise<unknown>;
    yield(agent: AgentId, o: { wait: WaitCondition | null; idempotencyKey: string; ctx?: WaitCtx }): Promise<Checkpoint>;
    // Merge-resume writes the exited child's checkpoint and takes the per-folder lock.
    stopCheckpoint(r: AgentRecord, key: string, wait: WaitCondition | null, workspace?: WorkspaceId): Promise<Checkpoint>;
    withFolderLock<T>(agent: AgentId, fn: () => Promise<T>): Promise<T>;
    // Sweeps: the watchdog nudge.
    deliver(agent: AgentId, signal: Signal, source: string): Promise<void>;
    // Reconcile: the restart-class actions handed to the lifecycle owner.
    reap(id: AgentId): Promise<unknown>;
    // The reap route's merge guard (Merge.requireMergeSettled): resolves when the child's merge is settled, else throws the 409 "unmerged" LifecycleError. Sweeps reuses it so the hold-TTL sweep and the API reap cannot disagree.
    requireMergeSettled(id: AgentId): Promise<void>;
    orphanChildren(parent: AgentRecord, open: AgentRecord[]): Promise<void>;
    finishTail(upd: AgentRecord, exit: ExitStatus, cause?: ExitCause): Promise<void>;
    wakeResume(agent: AgentId, signal: Signal): Promise<void>;
    canContinue(agent: AgentRecord): boolean;
    checkWorkflowWait(agent: AgentId): Promise<void>;
    recoverWorkflow(agent: AgentRecord): Promise<void>;
    yieldInbox(id: AgentId, cp: string): Promise<Set<string>>;
    reportedResult(r: AgentRecord): Promise<{ status: "succeeded" | "failed"; result: unknown; wrapupDeadlineAt: number; key?: string } | undefined>;
    notifyResult(child: AgentRecord, status: "succeeded" | "failed", result: unknown): Promise<void>;
    pausingMarker(a: AgentRecord): Promise<{ key: string; wait: WaitCondition | null; inbox: string[]; ctx?: WaitCtx } | null>;
    completePause(a: AgentRecord, m: { key: string; wait: WaitCondition | null; inbox: string[]; ctx?: WaitCtx }): Promise<void>;
    adoptRunning(
      id: AgentId,
      sandboxId: string,
      gen: number,
      reported?: { status: "succeeded" | "failed"; result: unknown; wrapupDeadlineAt: number },
    ): Promise<void>;
    restartCount(id: AgentId): Promise<number>;
    armDeadline(e: Live, deadlineAt: number): void;
  };
  // Reconcile: the per-agent claim helpers; the claim, `dirty` set and `starting` map are owned by Lifecycle.
  claim: {
    tryClaim(id: AgentId, purpose: string): { purpose: string; preempted: boolean } | null;
    releaseClaim(id: AgentId, claim: { purpose: string; preempted: boolean }): void;
    markDirty(id: AgentId): void;
    startingGeneration(id: AgentId): number | undefined;
  };
  // Host-health latches: markDown latches `degraded` after a durable write failed; hostUp = sandbox up, journal writable and
  // not degraded; markSandboxDown is called when the sandbox engine is unavailable; draining/degraded/journalFailed expose the Daemon-owned flags.
  store: {
    markDown(e: unknown): void;
    hostUp(): boolean;
    markSandboxDown(): Promise<void>;
    draining(): boolean;
    degraded(): boolean;
    journalFailed(): boolean;
  };
  // Admission (owns the host-health gate and the admit queue) and `pomtree push` stay on Daemon.
  host: {
    admit(id: AgentId, priority?: number): Promise<boolean>;
    push(
      agent: AgentId,
      generation: number,
      key: string,
      bundle: AsyncIterable<Uint8Array>,
      maxBytes: number,
      opts?: { force?: boolean },
    ): Promise<IngestResult>;
  };
}

// Why a supervisor force-resumes an agent. Charge to maxRestarts: reconcile_orphan and host_fault 1; boot, interrupted
// and watchdog 0. An operator resume is not a supervisor cause: it goes through resumeAgent({operator}) and resets the count.
export type ForceResumeCause = "boot" | "reconcile_orphan" | "host_fault" | "interrupted" | "watchdog";

// How a resume words the operator interrupts its run delivers, also journaled as the interrupt_done `mode` (Lifecycle.takeInterrupts):
// "interrupted" (the run was aborted for them), "woke" (they woke a parked agent), "budget-grant" (they ride in a grant's wake text),
// "resume" (any other resume that found them pending: a timer or message wake that won the race, or one sent during admission).
export type InterruptMode = "interrupted" | "woke" | "budget-grant" | "resume";

export interface DaemonCtx {
  readonly deps: DaemonDeps;
  readonly limits: Limits;
  now(): number;
  random(): number;
  // The redacting journal write (Daemon.record): the one place free-text from exceptions reaches the journal.
  record(r: AgentRecord, payload: JournalPayload, idempotencyKey: string): Promise<JournalEntry>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  readonly hub: Hub;
}

// Serializes work per key (an ancestor, or one ask/approval) so concurrent decisions, passes and sweeps cannot double-apply.
// In-process only: the durable idempotency keys remain the correctness backstop. Not reentrant: never nest the same key.
// Exactly one instance exists, owned by the Daemon and shared through the ctx.
export class Locks {
  private locks = new Map<string, Promise<unknown>>();
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}
