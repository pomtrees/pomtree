// Restart reconciliation of the Daemon: recover(), the serialized reconcile pass,
// the sandbox and worktree reconcilers, the deadline re-arm, and the quarantine marker.
// Calls up go through `ctx.hub`: lifecycle (finish, resume, pause completion, adoption,
// reaping, tails), the per-agent claim (`hub.claim`; the claim, `dirty` set and `starting` map are owned by Lifecycle),
// and the host-health latches (`hub.store`). `reconcile()` is the only entry to `reconcileNow`; the
// self-rescheduling reconcile timer stays in `Daemon.startWatchers` and calls the `Daemon.reconcile` delegate.

import { SandboxBackendMismatchError, SandboxUnavailableError, sandboxIdForKey } from "@pomtree/core";
import type { AgentId, AgentRecord, AgentState, Sandbox } from "@pomtree/core";
import type { Live } from "../daemon-types.ts";
import { isStoreDown, journalFailed, spawnedPayload } from "../daemon-util.ts";
import { isDone } from "../lifecycle.ts";
import { DEADLINE_KIND, QUARANTINED_KIND } from "../watchdog.ts";
import type { Budget } from "./budget.ts";
import { ownedByUs } from "./reconcile-remote.ts";
import { sandboxOpKey, sandboxOwner } from "./sandbox-ops.ts";
import type { DaemonCtx } from "./ctx.ts";
import type { Escalation } from "./escalation.ts";
import type { Tree } from "./tree.ts";

const MAX_INSPECT_FAILURES = 3;
// Journal prefix of an automatic restart; lifecycle's restartCount and tryAutoRestart read it too.
export const AUTO_RESTART = "auto-restart:";
// Journal prefix of an operator reset marker: restartCount counts only AUTO_RESTART entries after the latest one.
export const RESTART_RESET = "restart-budget-reset:";

export class Reconcile {
  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;
  private readonly escalation: Escalation;
  private readonly budget: Budget;
  private readonly live: Map<AgentId, Live>;
  private readonly epoch: string;
  // Serializes reconcile() passes (at most one running) and coalesces triggers (at most one queued): see reconcile().
  private reconcileRun: Promise<void> | null = null;
  private reconcileQueued: Promise<void> | null = null;
  private egressReclaimed = false;
  private bootPending = false;
  // Lost-wake scan flag (a crash between mailbox send and wake can lose a wake): true only once a scan over yielded agents
  // finished with no per-agent failure. Daemon exposes it through a private get/set facade (tests reset it to simulate a fresh
  // boot); setting it false re-arms the scan (boot, or store recovery) and forgets which agents the previous scan handled.
  private scanned = false;
  // Agents the in-progress scan has handled without error: a retry after a partial failure skips them.
  private readonly scanHandled = new Set<AgentId>();
  get lostWakeScanned(): boolean {
    return this.scanned;
  }
  set lostWakeScanned(v: boolean) {
    this.scanned = v;
    if (!v) this.scanHandled.clear();
  }

  // Store recovery (probeStore down/degraded -> healthy): wakes may have been lost while the store was down, so scan once more.
  rearmLostWakeScan(): void {
    this.lostWakeScanned = false;
  }
  private readonly inspectFailures = new Map<AgentId, number>();
  // Consecutive per-agent step failures: `until` is the end of the skip window, `since` the episode start.
  private readonly failures = new Map<AgentId, { n: number; since: number; until: number }>();
  private readonly failedThisPass = new Set<AgentId>();
  // Strays: sandbox id -> alerted yet. Present means seen in the previous consecutive pass.
  private readonly strays = new Map<string, boolean>();
  // Agents of this host whose live sandbox is on a backend this build or config cannot reach, from the latest reconcileSandboxes. They are
  // held: no listing, adoption, resume or kill touches them, and `pomtree abandon <agent>` (or selecting the backend again) resolves them.
  private readonly heldAgents = new Map<AgentId, string>();

  constructor(ctx: DaemonCtx, tree: Tree, escalation: Escalation, budget: Budget, live: Map<AgentId, Live>, epoch: string) {
    this.ctx = ctx;
    this.tree = tree;
    this.escalation = escalation;
    this.budget = budget;
    this.live = live;
    this.epoch = epoch;
  }

  // Rebuild runtime state from the stores after a restart: reconcile containers and worktrees against the registry, then
  // run a boot reconcile pass (restart pending agents, resume or adopt orphaned running ones).
  async recover() {
    await this.reclaimEgressOrphans();
    await this.ctx.hub.root.root();
    await this.reconcileSandboxes();
    await this.reconcileWorktrees();
    await this.replayReapedTails();
    await this.reconcile({ boot: true });
  }

  // Boot only (not in the periodic passes, which list with excludeState "reaped"): a crash between reapNow's registry `reaped`
  // transition, its journal row and its gateway revoke leaves a reaped agent with a missing row and/or a live key, and
  // nothing else replays either. A missing row gets the keyed `${id}:${gen}:reaped` (the key reapNow uses). Every reaped
  // agent's key is revoked again: revoke is an idempotent durable upsert (store-sqlite max(revoked_at)) and the port has no
  // read-only "already revoked" check, so the residual cost is one upsert plus one spend read per reaped agent per boot, and
  // the journal check is one read per reaped agent per boot (no kind filter on journal.read). A failure is logged, never
  // thrown: boot recovery must go on.
  private async replayReapedTails(): Promise<void> {
    const d = this.ctx.deps;
    for (const a of await d.registry.list({ state: "reaped" })) {
      try {
        let has = false;
        for (let from = 1; !has; ) {
          const page = await d.journal.read({ from, agent: a.id, limit: 500 });
          has = page.some((e) => e.payload.kind === "reaped");
          const last = page.at(-1);
          if (!last || page.length < 500) break;
          from = last.seq + 1;
        }
        if (!has) await this.ctx.record(a, { kind: "reaped" }, `${a.id}:${a.generation}:reaped`);
        if (a.executor !== "deterministic") await d.gateway.revoke(a.id);
      } catch (e) {
        if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
        console.error(`pomtreed: reaped-tail replay failed for ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // The idempotent, re-runnable part of recovery. Safe to call at boot and on a ~30s timer:
  // every step is keyed so a replay is a no-op, and each agent's pass is individually guarded so one
  // failure cannot strand the rest. Serialized and coalesced: at most one pass runs and one is
  // queued; a trigger while one is queued shares the queued promise. The returned promise settles with a pass that started
  // after this call (the running pass is never the one returned, since it may have read state before the caller's change).
  // `boot` marks the recovery pass after a daemon start: its restarts charge nothing (cause `boot`). The flag is sticky until a
  // pass starts, so a boot trigger that coalesces into a queued pass still makes the next pass a boot pass.
  reconcile(opts: { boot?: boolean } = {}): Promise<void> {
    if (opts.boot) this.bootPending = true;
    if (this.reconcileQueued) return this.reconcileQueued;
    if (!this.reconcileRun) return this.startPass();
    this.reconcileQueued = this.reconcileRun.catch(() => {}).then(() => this.startPass());
    return this.reconcileQueued;
  }

  private startPass(): Promise<void> {
    this.reconcileQueued = null;
    const boot = this.bootPending;
    this.bootPending = false;
    const run: Promise<void> = this.reconcileNow(boot).finally(() => {
      if (this.reconcileRun === run) this.reconcileRun = null;
    });
    this.reconcileRun = run;
    return run;
  }

  // The pass is an ordered list of named phases; `phase` isolates each, so one throwing phase
  // cannot abort the rest. The two `exited-tails` phases bracket the running loop and keep their order.
  private async reconcileNow(boot: boolean): Promise<void> {
    this.failedThisPass.clear();
    await this.phase("escalations", () => this.phaseEscalations());
    await this.phase("budget-decisions", () => this.phaseBudgetDecisions());
    await this.phase("deadlines", () => this.rearmDeadlines());
    // Replay the keyed tail for exited-but-unreaped agents: a crash between the exited transition and the
    // journal/notify/cancel/reap steps loses the rest, and the parent-death pass below skips root-parented
    // agents, so an unreaped root child would keep its carve forever.
    await this.phase("exited-tails", () => this.replayExitedTails());
    await this.phase("orphans", () => this.phaseOrphans());
    await this.phase("pending", () => this.phasePending());
    await this.phase("yielded", () => this.phaseYielded());
    await this.phase("running", () => this.phaseRunning(boot));
    // Agents failed by the running phase are now `exited`: replay their tails so recover() resolves converged (root
    // children reaped), not one tick later. adoptRunning is background work and can still land later.
    await this.phase("exited-tails-after", () => this.replayExitedTails());
    await this.phase("placement", () => this.phasePlacement());
    await this.phase("answered-escalations", () => this.phaseAnsweredEscalations());
    await this.phase("strays", () => this.phaseStrays());
    await this.phase("prune", () => this.phasePrune());
  }

  // Runs one phase; a throw is reported (never propagated). A store outage is logged and latches the host-health flag but is
  // not journaled (the journal is what is down); anything else is journaled once per phase on the root's journal.
  private async phase(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`pomtreed: reconcile phase ${name} failed: ${message}`);
      if (isStoreDown(e)) {
        this.ctx.hub.store.markDown(e);
        return;
      }
      try {
        const root = await this.ctx.hub.root.root();
        await this.ctx.record(
          root,
          { kind: "error", message: `reconcile phase ${name} failed: ${message}` },
          `${root.id}:${root.generation}:reconcile-phase:${name}`,
        );
      } catch {}
    }
  }

  // Is `a` inside its failure backoff window? Per-agent loops skip it; the skip is not a failure.
  private backedOff(a: AgentRecord): boolean {
    return (this.failures.get(a.id)?.until ?? 0) > this.ctx.now();
  }

  // A per-agent step threw. A store outage latches and counts nothing (the store, not the agent). Otherwise journal as ever,
  // count the consecutive failure, and from `reconcileFailureThreshold` skip the agent with an exponential window; one alert
  // fires when the threshold is first crossed (keyed by the episode start, so it is deduplicated across replays).
  private async agentFailed(a: AgentRecord, e: unknown): Promise<void> {
    if (isStoreDown(e)) {
      this.ctx.hub.store.markDown(e);
      return;
    }
    await this.journalReconcileError(a, e).catch(() => {});
    const d = this.ctx.deps;
    const now = this.ctx.now();
    const f = this.failures.get(a.id) ?? { n: 0, since: now, until: 0 };
    f.n++;
    this.failedThisPass.add(a.id);
    const threshold = d.reconcileFailureThreshold ?? 3;
    if (f.n >= threshold) {
      const base = d.reconcileBackoffMs ?? 60_000;
      f.until = now + Math.min(d.reconcileBackoffMaxMs ?? 900_000, base * 2 ** Math.min(f.n - threshold, 30));
    }
    this.failures.set(a.id, f);
    if (f.n === threshold) {
      const message = `reconcile failed ${f.n} consecutive passes for this agent; backing off (${String(e instanceof Error ? e.message : e)})`;
      const key = `${a.id}:${a.generation}:reconcile-backoff:${f.since}`;
      await this.ctx.record(a, { kind: "error", message }, key).catch(journalFailed(this.ctx.record, a, "agent-error"));
      await this.ctx.hub.user.sendToUser(a, "alert", message, `${key}:alert`).catch(() => {});
    }
  }

  private async phaseEscalations(): Promise<void> {
    // Fail-closed sweeps that need no per-agent state: expired asks and approvals past their rung deadline.
    await this.escalation.sweepEscalations().catch((e) => {
      if (isStoreDown(e)) throw e;
    });
    await this.escalation.sweepApprovals().catch((e) => {
      if (isStoreDown(e)) throw e;
    });
  }

  private async phaseBudgetDecisions(): Promise<void> {
    const d = this.ctx.deps;
    // Budget-parked agents: apply any decision that landed while the daemon was down or before the agent finished parking.
    for (const a of await d.registry.list({ state: "yielded" })) {
      if (a.host === d.hostId) await this.ctx.hub.budget.applyDecision(a.id);
    }
  }

  private async phaseOrphans(): Promise<void> {
    const d = this.ctx.deps;
    const hub = this.ctx.hub;
    const root = await hub.root.root();
    // Reaped rows need no reconciliation (and the loop skips them below); leaving them out keeps this pass off the unbounded history.
    for (const a of await d.registry.list({ excludeState: "reaped" })) {
      if (!a.parent || a.parent === root.id) continue;
      if (this.backedOff(a)) continue;
      try {
        const parent = await d.registry.get(a.parent);
        if (!parent || !isDone(parent)) continue;
        // parent died while we were down: cancel the orphan.
        // custody: the exited-tails phase (finishTail) hands an exited orphan to the nearest live ancestor.
        if (a.state === "exited") continue;
        else await hub.lifecycle.orphanChildren(parent, [a]);
      } catch (e) {
        await this.agentFailed(a, e);
      }
    }
  }

  private async phasePending(): Promise<void> {
    const d = this.ctx.deps;
    // pending with no run: replay the keyed spawned entry and start (both idempotent). Node-owned: another host starts its own.
    for (const a of await d.registry.list({ state: "pending" })) {
      if (a.host !== d.hostId || this.backedOff(a)) continue;
      try {
        await this.ctx.record(a, spawnedPayload(a), `${a.id}:spawned`).catch(journalFailed(this.ctx.record, a, "spawned"));
        await d.orchestrator.start(a.id, a.generation);
      } catch (e) {
        await this.agentFailed(a, e);
      }
    }
  }

  private async phaseYielded(): Promise<void> {
    const d = this.ctx.deps;
    const hub = this.ctx.hub;
    // Re-arm timer waits for yielded agents (their in-memory orchestrator timers died with the daemon). Node-owned: the timer
    // and the lost-wake scan belong to the agent's own host.
    // TODO(multi-host): a wake for a yielded agent on another host is not re-placed or forwarded here; it is left to that host.
    let scanIncomplete = false;
    for (const a of await d.registry.list({ state: "yielded" })) {
      if (a.host !== d.hostId) continue;
      if (this.backedOff(a)) {
        scanIncomplete = true; // not scanned this pass; keep the scan pending
        continue;
      }
      try {
        if (hub.lifecycle.canContinue(a)) {
          await hub.lifecycle.checkWorkflowWait(a.id);
          continue;
        }
        const cp = await d.checkpoints.latest(a.id);
        if (cp?.wait) await d.orchestrator.waitFor(a.id, cp.wait);
        // A crash between mailbox.send and orchestrator.wake loses the wake: re-check queued signals against the wait.
        // Not periodic: signals are not consumed at resume (the wake text carries them and they stay
        // queued for `pomtree inbox`), and satisfied() has no staleness, so a periodic scan would re-wake an agent from an
        // already-seen signal at every tick. Only the first pass after boot (the crash it exists for) and the first
        // after a store recovery scan, and the scan stays pending until it completes with no per-agent failure.
        // Agents handled by an earlier partial scan are skipped (the resume key is idempotent in any case).
        if (cp?.wait && !this.scanned && !this.scanHandled.has(a.id)) {
          // Signals already queued when the checkpoint was written were seen by the agent (or acked/stale): skip them,
          // by signal id, so only signals enqueued after the yield can re-wake it.
          const seen = await hub.lifecycle.yieldInbox(a.id, cp.id);
          for (const sig of await d.mailbox.peek(a.id)) {
            if (seen.has(sig.id)) continue;
            await hub.lifecycle.wakeResume(a.id, sig);
            if ((await d.registry.get(a.id))?.state !== "yielded") break;
          }
          this.scanHandled.add(a.id);
        }
      } catch (e) {
        scanIncomplete = true;
        await this.agentFailed(a, e);
      }
    }
    if (!scanIncomplete) this.scanned = true;
  }

  private async phaseRunning(boot: boolean): Promise<void> {
    const d = this.ctx.deps;
    const hub = this.ctx.hub;
    const root = await hub.root.root();
    // running with no live entry: a checkpointed agent resumes (through admission), a checkpoint-less
    // one is failed. Both are idempotent.
    for (const a of await d.registry.list({ state: "running" })) {
      if (a.id === root.id || a.host !== d.hostId) continue;
      if (this.backedOff(a)) continue;
      let claim: { purpose: string; preempted: boolean } | null = null;
      try {
        if (this.live.has(a.id)) {
          const reported = await hub.lifecycle.reportedResult(a);
          if (reported) await hub.lifecycle.notifyResult(a, reported.status, reported.result);
          continue;
        }
        if (hub.claim.startingGeneration(a.id) === a.generation) continue; // a resume of this generation is handing off to runResumed
        // No live entry: a restart-class decision follows. Claim before the first await (the `live` read above is synchronous
        // with this); a held claim means settle or a resume owns the agent, so skip and run again when it is released.
        claim = hub.claim.tryClaim(a.id, "reconcile");
        if (!claim) {
          hub.claim.markDirty(a.id);
          continue;
        }
        // Attach, inspect, stop and the resume path go through the selected backend; a sandbox pinned to another backend must not
        // be looked up there (an empty answer reads as dead and would be force-resumed). Left as is, with one finding.
        const selectedBackend = d.sandbox.declaration.backend;
        if (this.heldAgents.has(a.id) || (a.sandbox !== null && a.sandboxBackend !== null && a.sandboxBackend !== selectedBackend)) {
          await this.ctx
            .record(
              a,
              {
                kind: "error",
                message: `sandbox ${a.sandbox} is on backend ${a.sandboxBackend}, but the selected backend is ${selectedBackend}, and this pass cannot attach, inspect or stop it through the selected backend; left as is: select ${a.sandboxBackend} again (sandbox.backend), or run pomtree abandon ${a.id}`,
              },
              `${a.id}:${a.generation}:foreign-backend`,
            )
            .catch(journalFailed(this.ctx.record, a, "foreign-backend"));
          continue;
        }
        if (a.executor === "deterministic") {
          // Never sandbox-adopt or restartFresh. Reviewed opt-in workflows recover their task-local snapshot;
          // ordinary deterministic drivers still fail on interruption and cancel/reap their children.
          const reportedDet = await hub.lifecycle.reportedResult(a);
          if (reportedDet) await hub.lifecycle.finish(a.id, reportedDet.status, reportedDet.result);
          else if (hub.lifecycle.canContinue(a)) await hub.lifecycle.recoverWorkflow(a);
          else {
            await this.ctx
              .record(
                a,
                { kind: "error", message: "daemon restarted while a deterministic run was in flight; not replayed" },
                `${a.id}:${a.generation}:restart`,
              )
              .catch(journalFailed(this.ctx.record, a, "restart"));
            await hub.lifecycle.finish(a.id, "failed");
          }
          continue;
        }
        const reported = await hub.lifecycle.reportedResult(a);
        if (reported) {
          await hub.lifecycle.notifyResult(a, reported.status, reported.result);
          if (a.sandbox && reported.wrapupDeadlineAt > this.ctx.now()) {
            void hub.lifecycle.adoptRunning(a.id, a.sandbox, a.generation, reported).catch((e) => this.journalReconcileError(a, e));
          } else {
            await this.reclaimSandbox(a);
            const deadline = this.budget.deadlines.get(a.id);
            await hub.lifecycle.finish(a.id, deadline !== undefined && deadline <= this.ctx.now() ? "timed_out" : reported.status, reported.result);
          }
          continue;
        }
        const cp = await d.checkpoints.latest(a.id);
        const pausing = await hub.lifecycle.pausingMarker(a);
        let inspectFailed = false;
        const alive =
          (cp || pausing) && a.sandbox
            ? await d.sandbox.inspect(a.sandbox).then(
                (i) => i?.running === true,
                () => {
                  inspectFailed = true;
                  return false;
                },
              )
            : false;
        if (inspectFailed) {
          // An engine error says nothing about the container: never treat it as dead (completePause force-kills). Retry on later
          // ticks; after MAX_INSPECT_FAILURES journal one error and leave the agent for the operator.
          const n = (this.inspectFailures.get(a.id) ?? 0) + 1;
          this.inspectFailures.set(a.id, n);
          if (n === MAX_INSPECT_FAILURES)
            await this.ctx
              .record(
                a,
                {
                  kind: "error",
                  message: `cannot tell whether container ${a.sandbox} is alive (sandbox inspect keeps failing); leaving the agent as is, resolve by hand (pomtree kill / resume --force)`,
                },
                `${a.id}:${a.generation}:inspect-unknown`,
              )
              .catch(journalFailed(this.ctx.record, a, "inspect-unknown"));
          continue;
        }
        this.inspectFailures.delete(a.id);
        if (pausing && !alive && (await d.workspace.has(a.id))) {
          // Crashed between the container stop and the checkpoint write: finish the pause from the kept folder and session file.
          await hub.lifecycle.completePause(a, pausing);
        } else if (cp && alive && a.sandbox && !(await this.isQuarantined(a))) {
          // A healthy container survived the restart: adopt it. Force-resuming would kill it and roll the worktree
          // and session back to the last yield, discarding everything since.
          void hub.lifecycle.adoptRunning(a.id, a.sandbox, a.generation).catch((e) => this.journalReconcileError(a, e));
        } else if (cp) {
          if (await this.isQuarantined(a)) {
            // A quarantined agent is not auto-resumed: it is failed with cause `quarantined` (the operator can still inspect its
            // branch and checkpoint).
            await this.ctx
              .record(a, { kind: "error", message: "agent is quarantined; refusing to auto-resume" }, `${a.id}:${a.generation}:quarantine-refuse`)
              .catch(journalFailed(this.ctx.record, a, "quarantine-refuse"));
            await hub.lifecycle.finish(a.id, "failed", undefined, "quarantined");
          } else {
            // A running agent with a checkpoint: fence the dead instance and resume it in its own folder. Checkpoint the stopped
            // state first (folder and session file as the dead run left them), so uncommitted edits and turns since the last
            // yield survive; if that fails the resume falls back to the last checkpoint.
            // Boot recovery charges nothing; a steady-state tick finding the same dead agent charges maxRestarts like a host fault,
            // and an exhausted budget takes the same path as there: finish(failed, restart_exhausted), with the reason journaled.
            const res = await hub.lifecycle.forceResume(a, a.generation, boot ? "boot" : "reconcile_orphan", {
              restartReason: "no runtime found; resuming from checkpoint",
              isStale: () => claim?.preempted === true,
            });
            if (res === "exhausted") {
              await this.ctx
                .record(a, { kind: "error", message: "restart budget exhausted; failing the orphaned run" }, `${a.id}:${a.generation}:restart-exhausted`)
                .catch(journalFailed(this.ctx.record, a, "restart-exhausted"));
              await hub.lifecycle.finish(a.id, "failed", undefined, "restart_exhausted");
            }
          }
        } else if (a.sandbox) {
          // Re-adopt a checkpoint-less live container instead of failing it.
          void hub.lifecycle.adoptRunning(a.id, a.sandbox, a.generation).catch((e) => this.journalReconcileError(a, e));
        } else if (await this.restartFresh(a)) {
          // The crash hit after pending->running but before any container ran; restarted from scratch.
        } else {
          // No checkpoint and no live container to adopt: fail the orphaned run.
          await this.ctx
            .record(a, { kind: "error", message: "daemon restarted while running; no checkpoint to resume" }, `${a.id}:${a.generation}:restart`)
            .catch(journalFailed(this.ctx.record, a, "restart"));
          await hub.lifecycle.finish(a.id, "failed");
        }
      } catch (e) {
        await this.agentFailed(a, e);
      } finally {
        if (claim) hub.claim.releaseClaim(a.id, claim);
      }
    }
  }

  private async phasePlacement(): Promise<void> {
    const d = this.ctx.deps;
    const root = await this.ctx.hub.root.root();
    // Tell the placement which agents run here so status() reflects ones that stay
    // running without a resume (adoption, hot restart).
    await d.placement
      .sync?.((await d.registry.list({ state: "running" })).filter((a) => a.id !== root.id && a.host === d.hostId).map((a) => a.id))
      .catch(() => {});
  }

  private async phaseAnsweredEscalations(): Promise<void> {
    const d = this.ctx.deps;
    // answered escalations: replay the journal + mailbox send (a crash after the store write leaves an
    // answered escalation with no human_answer signal and a waiting agent forever).
    for (const esc of await d.escalations.list({ state: "answered" })) {
      if (esc.answer === null || esc.answeredBy === null) continue;
      await this.escalation.deliverAnswer(esc, esc.answer, esc.answeredBy).catch(() => {});
    }
  }

  // Forget per-agent state for agents that left `running` (inspect counter) or finished (failure backoff), and reset the
  // backoff of an agent that was eligible this pass and did not fail.
  private async phasePrune(): Promise<void> {
    // Reaped rows are in neither set below, so leaving them out of the list changes nothing (and skips the unbounded history).
    const all = await this.ctx.deps.registry.list({ excludeState: "reaped" });
    const running = new Set(all.filter((a) => a.state === "running").map((a) => a.id));
    const open = new Set(all.filter((a) => a.state !== "exited").map((a) => a.id));
    for (const id of [...this.inspectFailures.keys()]) if (!running.has(id)) this.inspectFailures.delete(id);
    const now = this.ctx.now();
    for (const [id, f] of [...this.failures]) {
      if (!open.has(id) || (f.until <= now && !this.failedThisPass.has(id))) this.failures.delete(id);
    }
  }

  private async replayExitedTails(): Promise<void> {
    for (const a of await this.ctx.deps.registry.list({ state: "exited" })) {
      if (this.backedOff(a)) continue;
      try {
        await this.ctx.hub.lifecycle.finishTail(a, a.exit ?? "failed", a.exitCause);
      } catch (e) {
        await this.agentFailed(a, e);
      }
    }
  }

  // The wall-clock deadline is durable (DEADLINE_KIND) but the runtime map is not. Load it back
  // for running/yielded agents (once per agent); a yielded agent parked past its deadline is finished `timed_out`
  // here (the watchdog skips yielded agents). Running agents get their kill timer from drive()/runResumed().
  private async rearmDeadlines(): Promise<void> {
    const d = this.ctx.deps;
    const deadlines = this.budget.deadlines;
    for (const state of ["running", "yielded"] as const) {
      for (const a of await d.registry.list({ state })) {
        if (a.host !== d.hostId) continue;
        if (this.backedOff(a)) continue;
        try {
          if (!this.budget.deadlineLoaded.has(a.id)) {
            for (let from = 1; ; ) {
              const page = await d.journal.read({ from, agent: a.id, limit: 500 });
              for (const e of page) {
                const at = e.payload.kind === DEADLINE_KIND ? (e.payload as { at?: number }).at : undefined;
                if (typeof at === "number") deadlines.set(a.id, at);
              }
              const last = page.at(-1);
              if (!last || page.length < 500) break;
              from = last.seq + 1;
            }
            this.budget.deadlineLoaded.add(a.id);
          }
          const at = deadlines.get(a.id);
          // The wall-clock is paused while parked on a budget approval; the grant shifts the deadline by the parked time.
          if (state === "yielded" && at !== undefined && this.ctx.now() >= at && !(await this.budget.isBudgetParked(a))) {
            // Lifecycle.finish journals the one timed-out error entry (its text says the agent was parked).
            await this.ctx.hub.lifecycle.finish(a.id, "timed_out");
          } else if (state === "running" && at !== undefined) {
            const live = this.live.get(a.id);
            if (live && live.killTimer === undefined && !live.timedOut) this.ctx.hub.lifecycle.armDeadline(live, at);
          }
        } catch (e) {
          await this.agentFailed(a, e);
        }
      }
    }
  }

  async journalReconcileError(a: AgentRecord, e: unknown): Promise<void> {
    await this.ctx
      .record(a, { kind: "error", message: `reconcile failed: ${String(e instanceof Error ? e.message : e)}` }, `${a.id}:${a.generation}:reconcile-error`)
      .catch(journalFailed(this.ctx.record, a, "reconcile-error"));
  }

  // A durable quarantine marker: true once the watchdog has
  // quarantined the agent's current generation. resume()/recover() refuse to auto-resume a
  // quarantined agent without --force. A forced resume bumps the generation, so the marker
  // no longer matches and the quarantine is effectively cleared for the fresh run.
  async isQuarantined(a: AgentRecord): Promise<boolean> {
    if ((await this.ctx.deps.watchdogs.get(a.id))?.quarantined === true) return true;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: a.id, limit: 500 });
      for (const e of page) {
        if (e.payload.kind === QUARANTINED_KIND && e.generation === a.generation) return true;
      }
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    return false;
  }

  // A running agent with no checkpoint, no container and no harness output never got a runtime (crash between
  // pending->running and sandbox.start): restart it from the task text under a new generation, bounded by maxRestarts.
  async restartFresh(a: AgentRecord): Promise<boolean> {
    if (a.executor === "deterministic") return false; // opt-in workflow recovery is handled separately, never through restartFresh
    const ranNothing = (await this.ctx.deps.journal.read({ agent: a.id })).every((e) =>
      ["spawned", "started", "error", "resumed", "signal"].includes(e.payload.kind),
    );
    if (!ranNothing) return false;
    const used = await this.ctx.hub.lifecycle.restartCount(a.id);
    const max = this.ctx.deps.maxRestarts ?? 3;
    if (used >= max) return false;
    await this.ctx.record(
      a,
      { kind: "error", message: `${AUTO_RESTART} no runtime had started; restarting from scratch (${used + 1}/${max})` },
      `${a.id}:${a.generation}:auto-restart`,
    );
    const bumped = await this.ctx.deps.registry.bumpGeneration(a.id, this.ctx.deps.hostId, `${a.id}:${a.generation}:fresh-restart`);
    this.live.set(a.id, { cancelled: false, admitting: true }); // hold off the next reconcile tick while parked in admit()
    await this.ctx.deps.orchestrator.start(a.id, bumped.generation);
    return true;
  }

  // Read-only periodic stray report: a running, owned container that no agent on this host
  // claims (no record, a record whose current sandbox is another id, or a record that is not running). Never kills, stops or
  // writes the registry; reaping stays boot-only (reconcileSandboxes) until containers carry a generation label. A spawn
  // mid-start has a container the registry does not record yet, so a stray must be seen in two
  // consecutive passes before the single alert; the memory is in-process and forgets a container the moment it is not a
  // stray. The alert is keyed by sandbox id, so a daemon restart or a replay does not repeat it. Skipped (memory cleared)
  // while the host is down, since nothing listed then can be trusted.
  // Listed across the active set (activeBackends): the selected backend by `ownsSandbox`, any other by the stricter `provablyOurs`.
  // A backend that cannot be reached or listed is skipped here (reconcileSandboxes holds or reports it); its strays are not seen.
  private async phaseStrays(): Promise<void> {
    const d = this.ctx.deps;
    if (!this.ctx.hub.store.hostUp()) {
      this.strays.clear();
      return;
    }
    const selected = d.sandbox.declaration.backend;
    const targets = await this.targetsOrSelected("stray listing", ["running", "yielded"]);
    const found: { key: string; id: string; agent: AgentId; why: string }[] = [];
    const done = new Set<Sandbox>();
    const skipped = new Set<string>(); // non-selected backends that could not be listed this pass
    for (const [backend, sb] of targets) {
      if (done.has(sb)) continue;
      done.add(sb);
      const isSelected = backend === selected;
      let listed: Awaited<ReturnType<Sandbox["list"]>>;
      try {
        listed = await sb.list(sandboxOwner(d, this.epoch));
      } catch (e) {
        if (e instanceof SandboxUnavailableError) {
          if (!isSelected) {
            skipped.add(backend);
            continue;
          }
          this.strays.clear();
          await this.ctx.hub.store.markSandboxDown();
          return;
        }
        throw e;
      }
      for (const s of listed.filter((x) => (isSelected ? this.ownsSandbox(x.labels) : this.provablyOurs(x)))) {
        if (this.live.has(s.agent)) continue;
        const r = await d.registry.get(s.agent);
        let why = "";
        if (!r) why = "no agent record";
        else if (r.sandbox === s.id && (r.sandboxBackend ?? selected) === backend && r.state === "running" && r.host === d.hostId) continue;
        else why = r.sandbox === s.id ? `agent is ${r.state} on host ${r.host}` : "agent's current sandbox is another container";
        // `list` includes exited containers (no --rm); only a running one is a stray worth reporting.
        if (!(await sb.inspect(s.id))?.running) continue;
        // The selected backend keeps its original key; another backend's ids are qualified so two backends never share one.
        const key = isSelected ? s.id : `${backend}:${s.id}`;
        found.push({ key, id: s.id, agent: s.agent, why });
      }
    }
    const now = new Set(found.map((f) => f.key));
    // A skipped backend's keys stay (backend-qualified), so a flapping backend does not reset the two-pass memory.
    for (const id of [...this.strays.keys()]) if (!now.has(id) && ![...skipped].some((b) => id.startsWith(`${b}:`))) this.strays.delete(id);
    const root = await this.ctx.hub.root.root();
    for (const f of found) {
      const seenBefore = this.strays.get(f.key);
      if (seenBefore === undefined) {
        this.strays.set(f.key, false);
        continue;
      }
      if (seenBefore) continue;
      const message = `stray container ${f.id} (labelled for agent ${f.agent}): ${f.why}; not reaped until restart`;
      const key = `${root.id}:${root.generation}:stray:${f.key}`;
      await this.ctx.record(root, { kind: "error", message }, key);
      await this.ctx.hub.user.sendToUser(root, "alert", message, `${key}:alert`);
      this.strays.set(f.key, true);
    }
  }

  // Label-driven sandbox reconciliation (SPEC: reconcile the registry against the containers that actually exist).
  // Adopt: a live container whose label maps to a running agent on this host is linked into the registry (closing
  // the crash window between sandbox.start and setSandbox) so finish() reclaims it by registry id.
  // Kill/stop: containers with no registry record, and containers whose record lives on another host, are killed;
  // same-host containers whose record is not running are stopped; a second container labelled for an already-
  // adopted agent is superseded and stopped. Agents being driven right now (this.live) are never touched.
  async reconcileSandboxes() {
    // The backend comes from the RECORD, never from current config. The active set is the selected backend plus every backend
    // named by a non-terminal record of this host that holds a sandbox (overflow, or a backend left behind by a config change);
    // each is reconciled against its own sandbox. A record that names a backend this build cannot reach cannot be listed, adopted
    // or stopped, so it is HELD: skipped by every loop here, with one journaled finding, and the daemon boots so the operator can
    // `pomtree abandon` it. A record on another host, or a finished one, is not this daemon's. A record that holds a sandbox but
    // names no backend cannot be matched to any backend: refused.
    const d = this.ctx.deps;
    const selected = d.sandbox.declaration.backend;
    this.heldAgents.clear();
    const { targets, unreachable } = await this.activeBackends();
    for (const [id, agents] of unreachable) await this.hold(id, selected, agents);
    // One backend failing never skips the others: each runs, the first unexpected error is rethrown afterwards.
    const done = new Set<Sandbox>(); // the same sandbox reached under two ids is reclaimed once
    let failure: { error: unknown } | null = null;
    for (const [id, sb] of targets) {
      if (done.has(sb)) continue;
      done.add(sb);
      try {
        await this.reconcileBackend(sb, id, id === selected);
      } catch (e) {
        failure ??= { error: e };
      }
    }
    if (failure) throw failure.error;
  }

  // The active set of backends: the selected one plus every backend named by a non-terminal record of this host that holds a
  // sandbox. `targets` are the reachable ones (the selected backend first); `unreachable` maps each backend this build cannot
  // reach to the records that name it. A record that holds a sandbox but names no backend cannot be matched: refused.
  private async activeBackends(states?: readonly AgentState[]): Promise<{ targets: [string, Sandbox][]; unreachable: Map<string, AgentRecord[]> }> {
    const d = this.ctx.deps;
    const selected = d.sandbox.declaration.backend;
    const holders = new Map<string, AgentRecord[]>();
    // The periodic strays phase passes `states` so it reads only the live rows, never the reaped history.
    const rows = states ? (await Promise.all(states.map((state) => d.registry.list({ state })))).flat() : await d.registry.list({ excludeState: "reaped" });
    for (const r of rows) {
      if (r.sandbox === null || r.host !== d.hostId || isDone(r)) continue;
      if (r.sandboxBackend === null) {
        throw new Error(
          `agent ${r.id} holds sandbox ${r.sandbox} but its record names no sandbox backend (written by a build before the field existed, or damaged), so the sandbox cannot be matched to a backend; move the database file aside and restart to re-initialize`,
        );
      }
      if (r.sandboxBackend === selected) continue;
      holders.set(r.sandboxBackend, [...(holders.get(r.sandboxBackend) ?? []), r]);
    }
    const targets: [string, Sandbox][] = [[selected, d.sandbox]];
    const unreachable = new Map<string, AgentRecord[]>();
    for (const [id, agents] of holders) {
      const sb = d.sandboxFor?.(id);
      if (sb) targets.push([id, sb]);
      else unreachable.set(id, agents);
    }
    return { targets, unreachable };
  }

  // The active set, or the selected backend alone when a record names no backend (reconcileSandboxes refuses that at boot, so a periodic
  // pass reaching it is a record damaged since); the cause is logged, never thrown, so one bad record does not stop the pass.
  private async targetsOrSelected(what: string, states?: readonly AgentState[]): Promise<[string, Sandbox][]> {
    try {
      return (await this.activeBackends(states)).targets;
    } catch (e) {
      console.error(`pomtreed: ${what} limited to the selected backend: ${e instanceof Error ? e.message : String(e)}`);
      return [[this.ctx.deps.sandbox.declaration.backend, this.ctx.deps.sandbox]];
    }
  }

  // The agents currently held for an unreachable backend (ids only), for operator surfaces.
  held(): AgentId[] {
    return [...this.heldAgents.keys()];
  }

  isHeld(id: AgentId): boolean {
    return this.heldAgents.has(id);
  }

  private async hold(backend: string, selected: string, agents: AgentRecord[]) {
    const root = await this.ctx.hub.root.root();
    for (const a of agents) {
      this.heldAgents.set(a.id, backend);
      const message = `agent ${a.id} holds sandbox ${a.sandbox} on backend ${backend}, which is not available here (the selected backend is ${selected}); the agent is held (never inspected, resumed or killed) and the daemon started without it: select ${backend} again (sandbox.backend), or run pomtree abandon ${a.id}`;
      console.error(`pomtreed: ${message}`);
      await this.ctx
        .record(root, { kind: "host_error", component: "sandbox", message }, `host:backend-held:${a.id}:${backend}`)
        .catch(journalFailed(this.ctx.record, root, "sandbox"));
    }
  }

  // One backend of the active set. A backend that cannot be listed is skipped, and the records it holds stay as they are
  // (nothing is adopted, stopped or cleared on a listing that was not read): the selected one latches the sandbox-down health
  // flag, any other is reported on the root's journal and the log.
  private async reconcileBackend(sandbox: Sandbox, backend: string, isSelected: boolean) {
    let listed: Awaited<ReturnType<Sandbox["list"]>>;
    try {
      listed = await sandbox.list(sandboxOwner(this.ctx.deps, this.epoch));
    } catch (e) {
      if (e instanceof SandboxUnavailableError) {
        if (isSelected) {
          await this.ctx.hub.store.markSandboxDown();
          return;
        }
        const message = `sandbox backend ${backend} cannot be listed (${e.message}); its sandboxes were not reconciled this boot, start it and restart pomtreed, or run pomtree abandon <agent> for the agents that hold sandboxes on it`;
        console.error(`pomtreed: ${message}`);
        const root = await this.ctx.hub.root.root();
        await this.ctx
          .record(root, { kind: "host_error", component: "sandbox", message }, `host:sandbox-list:${backend}`)
          .catch(journalFailed(this.ctx.record, root, "sandbox"));
        return;
      }
      throw e;
    }
    // Containers of another store or a newer daemon epoch are not ours; neither are unlabelled ones.
    listed = listed.filter((s) => (isSelected ? this.ownsSandbox(s.labels) : this.provablyOurs(s)));
    // A registry holding nothing but the root next to live containers means a restored or
    // swapped pomtreed.sqlite (or another pomtreed's containers); killing them would destroy live work. Refuse unless the
    // operator opted in with adoptOrphans (agent.adoptOrphans).
    if (listed.length && !(await this.canReclaimOrphans())) {
      const root = await this.ctx.hub.root.root();
      await this.ctx
        .record(
          root,
          {
            kind: "host_error",
            component: "sandbox",
            message: `registry is empty but ${listed.length} container(s) exist; refusing to kill them (set POMTREED_AGENT_ADOPT_ORPHANS=1)`,
          },
          isSelected ? "host:orphans:sandbox" : `host:orphans:sandbox:${backend}`,
        )
        .catch(journalFailed(this.ctx.record, root, "sandbox"));
      return;
    }
    for (const s of listed) {
      if (this.live.has(s.agent)) continue;
      // Acts only on a sandbox whose own stamp names this host: an unstamped (null) or peer-host sandbox is reported by list but never
      // killed, stopped or bound here. The selected backend's legacy unstamped containers are refused at boot, so none is stranded.
      if (s.host !== this.ctx.deps.hostId) continue;
      // TODO(recon-adopt): revisit the unregistered-container kill. Current behavior: an owned container with no row is killed.
      // Safe only while spawn writes the registry row before sandbox.start; reordering would make this kill race spawn.
      const r = await this.ctx.deps.registry.get(s.agent);
      if (!r) {
        await sandbox.kill(s.id, sandboxOpKey("kill", s.id)).catch(() => {});
        continue;
      }
      if (r.state === "running" && r.host === this.ctx.deps.hostId) {
        if (r.sandbox === s.id) continue; // already adopted
        // The id start() recorded before its provider call is the key-derived one. An adapter whose ids are not derived names the
        // sandbox otherwise: link the listed sandbox that reports this record's generation and this host (both stamped by the adapter;
        // a sandbox reporting null for either is never linked), and only that one; a lower-generation sandbox of the same agent is
        // stale and falls through to the stop below.
        if (r.sandbox === sandboxIdForKey(`${r.id}:${r.generation}:start`) && s.generation === r.generation && s.host === this.ctx.deps.hostId) {
          await this.ctx.deps.registry
            .setSandbox(r.id, r.generation, s.id, `${r.id}:${r.generation}:adopt:${s.id}`)
            .catch(journalFailed(this.ctx.record, r, "adopt-bind"));
          continue;
        }
        if (r.sandbox !== null) {
          // A second container labelled for an already-adopted agent is superseded; keep the registry's sandbox.
          await sandbox.stop(s.id, this.ctx.deps.graceMs, sandboxOpKey("stop", s.id)).catch(() => {});
        } else if (s.generation !== r.generation) {
          // A lower generation is a stale leftover of an earlier run: stop it. A higher one means the record may be behind: leave it.
          if (s.generation !== null && s.generation < r.generation) await sandbox.stop(s.id, this.ctx.deps.graceMs, sandboxOpKey("stop", s.id)).catch(() => {});
        } else {
          // Links the live container's sandbox id into the registry (this host, this generation); reconcile() then re-adopts it via
          // Sandbox.attach (see adoptRunning) so a checkpoint-less running agent survives the restart.
          await this.ctx.deps.registry
            .setSandbox(r.id, r.generation, s.id, `${r.id}:${r.generation}:adopt:${s.id}`, backend)
            .catch(journalFailed(this.ctx.record, r, "adopt-bind"));
        }
        continue;
      }
      if (r.host !== this.ctx.deps.hostId) await sandbox.kill(s.id, sandboxOpKey("kill", s.id)).catch(() => {});
      else await sandbox.stop(s.id, this.ctx.deps.graceMs, sandboxOpKey("stop", s.id)).catch(() => {});
      if (r.sandbox === s.id)
        await this.ctx.deps.registry
          .setSandbox(r.id, r.generation, null, `${r.id}:${r.generation}:reconcile-clear`)
          .catch(journalFailed(this.ctx.record, r, "reconcile-clear"));
    }
  }

  // Positive ownership for a backend that may be a shared hosted account (every backend but the selected one): a peer daemon's
  // sandbox there can carry no store_id or a store_id this daemon has never heard of, so absence is not evidence of ownership.
  // The one predicate shared with the remote reconcile planner: `ownedByUs` (reconcile-remote.ts).
  private provablyOurs(s: Awaited<ReturnType<Sandbox["list"]>>[number]): boolean {
    return ownedByUs(s, sandboxOwner(this.ctx.deps, this.epoch)).owned;
  }

  private ownsSandbox(labels?: Record<string, string>): boolean {
    if (labels?.daemon_epoch === undefined) return false; // every sandbox pomtreed spawns is stamped; an unlabelled one is not ours
    if (labels.store_id !== undefined && this.ctx.deps.storeId !== undefined && labels.store_id !== this.ctx.deps.storeId) return false;
    const theirs = Number(labels.daemon_epoch);
    const mine = Number(this.epoch);
    return !(Number.isFinite(theirs) && Number.isFinite(mine) && theirs > mine); // a newer epoch owns it
  }

  // Remove egress sets (network + proxy) whose sandbox is gone; only safe before any spawn starts. Runs once.
  // Reclaimed on every reachable backend of the active set (activeBackends); one backend failing never skips the others.
  async reclaimEgressOrphans(): Promise<void> {
    if (this.egressReclaimed) return;
    this.egressReclaimed = true;
    const fail = (backend: string) => (e: unknown) =>
      console.error(`pomtreed: egress orphan reclaim failed on ${backend}: ${e instanceof Error ? e.message : String(e)}`);
    const targets = await this.targetsOrSelected("egress orphan reclaim");
    const done = new Set<Sandbox>();
    for (const [backend, sb] of targets) {
      if (done.has(sb)) continue;
      done.add(sb);
      await sb.reclaim(sandboxOwner(this.ctx.deps, this.epoch)).catch(fail(backend));
    }
  }

  // Unknown containers/worktrees may be reclaimed only when the registry knows some agent besides the root, or the
  // operator opted in (adoptOrphans). Otherwise an empty registry beside live resources is treated as suspect.
  private async canReclaimOrphans(): Promise<boolean> {
    if (this.ctx.deps.adoptOrphans) return true;
    const rootId = await this.tree.rootAgentId();
    return (await this.ctx.deps.registry.list()).some((a) => a.id !== rootId);
  }

  // Evict folders of agents the registry no longer tracks. Reaped agents' folders are evicted by sweepFolders
  // (the mirror's refs/agents/<id>/* are kept so a parent can pull them).
  private async reconcileWorktrees() {
    const trees = await this.ctx.deps.workspace.list();
    if (trees.length && !(await this.canReclaimOrphans())) {
      const root = await this.ctx.hub.root.root();
      await this.ctx
        .record(
          root,
          {
            kind: "host_error",
            component: "workspace",
            message: `registry is empty but ${trees.length} workspace folder(s) exist; refusing to evict them (set POMTREED_AGENT_ADOPT_ORPHANS=1)`,
          },
          "host:orphans:workspace",
        )
        .catch(journalFailed(this.ctx.record, root, "workspace"));
      return;
    }
    for (const agent of await this.ctx.deps.workspace.list()) {
      const r = await this.ctx.deps.registry.get(agent);
      if (!r) await this.ctx.deps.workspace.evict(agent).catch(() => {});
    }
  }

  // Stop (or kill) the sandbox the registry says an agent has, then clear it. For agents with no live handle here,
  // e.g. after a daemon restart.
  async reclaimSandbox(r: AgentRecord, force = false) {
    if (!r.sandbox) return;
    const d = this.ctx.deps;
    // The record's own backend decides where the sandbox is; one this build cannot reach is refused, never looked up elsewhere.
    const selected = d.sandbox.declaration.backend;
    const sandbox = r.sandboxBackend === null || r.sandboxBackend === selected ? d.sandbox : d.sandboxFor?.(r.sandboxBackend);
    if (!sandbox) throw new SandboxBackendMismatchError(r.sandbox, r.sandboxBackend ?? selected, selected, r.id);
    await (force ? sandbox.kill(r.sandbox, sandboxOpKey("kill", r.sandbox)) : sandbox.stop(r.sandbox, d.graceMs, sandboxOpKey("stop", r.sandbox))).catch(
      () => {},
    );
    await d.registry.setSandbox(r.id, r.generation, null, `${r.id}:${r.generation}:reclaim`).catch(journalFailed(this.ctx.record, r, "reclaim"));
  }
}
