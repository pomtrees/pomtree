// Background sweeps of the Daemon: branch/report cleanup, folder eviction, zombie
// alerts and the watchdog ladder, plus the per-folder lock. Calls up go through `ctx.hub`: lifecycle's
// resume, finish and deliver, reconcile's sandbox reclaim and error journal, the host-health flags, and the one user-bound
// writer. The timers stay in `Daemon.startWatchers` and call the `Daemon` delegates, so the `watchdogSweep` and
// `cleanupSweep` chains are the only entry to the sweeps.

import type { AgentId, AgentRecord, JournalPayload, Signal, WatchdogState } from "@pomtree/core";
import { POMTREED_KINDS, waitingStep } from "@pomtree/core";
import { DEFAULT_WATCHDOG, evaluate, hasLadderReason, tripReasons } from "@pomtree/sched";
import type { Rung, WatchdogAction, WatchdogSnapshot } from "@pomtree/sched";
import type { Live } from "../daemon-types.ts";
import { folderId, isStoreDown, journalFailed } from "../daemon-util.ts";
import { LifecycleError, findZombies, isDone } from "../lifecycle.ts";
import { planEvictions, type FolderCandidate } from "../folder-retention.ts";
import { DEADLINE_KIND, HOST_HEALTH_KIND, QUARANTINED_KIND, foldBlocked, intensityRetries, newBlockedScan, openCallSince } from "../watchdog.ts";
import type { Budget } from "./budget.ts";
import { sandboxOpKey } from "./sandbox-ops.ts";
import { isTerminalExitMessage } from "./lifecycle.ts";
import type { DaemonCtx } from "./ctx.ts";
import type { Tree } from "./tree.ts";

// How many unwatched intervals Sweeps keeps for clockGapMs (the newest; older ones only matter to an agent silent since).
const MAX_CLOCK_GAPS = 16;

export class Sweeps {
  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;
  private readonly budget: Budget;
  private readonly live: ReadonlyMap<AgentId, Live>;
  private readonly resuming: ReadonlyMap<AgentId, unknown>;
  private watchdogSweep: Promise<unknown> = Promise.resolve(); // serializes sweeps so overlapping ticks can't lose an advance
  private cleanupSweep: Promise<unknown> = Promise.resolve(); // serializes prune/report-GC sweeps so overlapping ticks can't interleave
  private lastWatchdogSweepAt: number | null = null;
  // Unwatched intervals (host suspend, a forward clock jump, an event-loop stall) the sweep-gap check detected: [start, end]
  // with start = when the next sweep was due. Each still counts as WatchdogSnapshot.clockGapMs for an agent whose last
  // progress is before its end, so the gap inside now - lastProgressAt never reads as a stall. In memory like
  // lastWatchdogSweepAt: a restart forgets them (its own first sweep sets the baseline). Bounded to the newest few.
  // TODO(watchdog-suspend): persist the clock-gap record. Current behavior: kept in memory, newest MAX_CLOCK_GAPS only.
  // After a daemon restart the first sweep sets a new baseline.
  private clockGaps: { start: number; end: number }[] = [];

  constructor(ctx: DaemonCtx, tree: Tree, budget: Budget, live: ReadonlyMap<AgentId, Live>, resuming: ReadonlyMap<AgentId, unknown>) {
    this.ctx = ctx;
    this.tree = tree;
    this.budget = budget;
    this.live = live;
    this.resuming = resuming;
  }

  // Reaped root branches whose tips are ancestors of the root's merge target are pruned. Reports are GC'd after "pruned", and after
  // "nothing" only when the journal shows the refs were ingested (so they were pruned before); "refused" keeps both and is retried.
  sweepCleanup(): Promise<AgentId[]> {
    const run = this.cleanupSweep.then(() => this.sweepCleanupNow());
    this.cleanupSweep = run.catch(() => {});
    return run;
  }

  private async sweepCleanupNow(): Promise<AgentId[]> {
    const rootId = await this.tree.rootAgentId();
    const pruned: AgentId[] = [];
    const marks = this.ctx.deps.workspaceCleanup;
    // Cleaned agents (durable across restarts) have nothing left to do. Pruned agents only owe the report GC: their refs are gone,
    // so a second prune would return "nothing". Reports stay until the branch is merged, so the GC follows a
    // successful prune and is never run before it.
    const cleaned = marks?.cleanedAgents() ?? new Set<AgentId>();
    const owed = marks?.prunedAgents() ?? new Set<AgentId>();
    // One agent's failure must not starve the others or the folder sweep: the first error is kept and rethrown after them.
    let firstError: unknown;
    let failed = false;
    for (const a of await this.ctx.deps.registry.list({ state: "reaped" })) {
      // Only the root supervisor's own reaped children; the root itself has no parent and
      // is never a candidate, but the explicit guard keeps agent/<rootId> safe regardless.
      if (a.id === rootId || a.parent !== rootId || cleaned.has(a.id)) continue;
      try {
        // A deterministic task has no workspace branch: nothing to prune, so it is marked cleaned at once and never revisited.
        if (a.executor === "deterministic") {
          marks?.markCleaned(a.id, this.ctx.now());
          continue;
        }
        let reported = true; // the returned list names agents whose branch this or an earlier sweep pruned, not "nothing" outcomes
        if (!owed.has(a.id)) {
          // TODO(cleanup): a branch whose tip was only partially cherry-picked is never pruned (prune requires the tip to be an
          // ancestor of the merge target), so it and its reports leak forever.
          // "pruned" owes the report GC and is marked. "nothing" (no refs) is either a branch pruned by a sweep that crashed before
          // marking (the journal has an `ingested` entry: marked, GC finished) or one that never pushed (no entry: marked cleaned, reports kept).
          // "refused" (tip not merged, or no refs on the root yet) stays unmarked and is retried every sweep: no backoff, since the
          // mirror check is cheap and a later merge must be picked up promptly.
          const outcome = await this.ctx.deps.workspace.prune(a.id, { mergedInto: rootId });
          if (outcome === "refused") continue;
          reported = outcome === "pruned";
          if (outcome === "nothing" && !(await this.everIngested(a.id))) {
            // TODO(root-child-reports): the reports of a root child that never pushed are the operator's only full copy (only the clipped
            // handoff is relayed). Current behavior: kept until the operator deletes them (`pomtree report rm`); a time-to-live waits for the
            // round-2 spawn disposition (TODO(guardian-reap)).
            marks?.markCleaned(a.id, this.ctx.now());
            continue;
          }
          // Recorded before the GC: if the GC or the final mark throws, the next sweep finishes the GC without pruning again.
          marks?.markPruned(a.id, this.ctx.now());
        }
        if (reported) pruned.push(a.id);
        for (const r of await this.ctx.deps.reportStore.list(a.id)) {
          await this.ctx.deps.reportStore.remove(a.id, r.id);
        }
        marks?.markCleaned(a.id, this.ctx.now());
      } catch (e) {
        if (isStoreDown(e)) throw e;
        if (!failed) firstError = e;
        failed = true;
      }
    }
    await this.sweepFolders().catch((e) => {
      if (isStoreDown(e)) throw e;
    });
    if (failed) throw firstError;
    return pruned;
  }

  // Whether the daemon ever journaled an ingest of this agent's refs (Daemon.ingest), i.e. whether they existed before a prune read "nothing".
  private async everIngested(agent: AgentId): Promise<boolean> {
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent, limit: 500 });
      if (page.some((e) => e.payload.kind === "ingested")) return true;
      const last = page.at(-1);
      if (!last || page.length < 500) return false;
      from = last.seq + 1;
    }
  }

  private readonly folderLocks = new Map<AgentId, Promise<unknown>>();
  async withFolderLock<T>(agent: AgentId, fn: () => Promise<T>): Promise<T> {
    const prev = this.folderLocks.get(agent) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.folderLocks.set(agent, tail);
    try {
      return await run;
    } finally {
      if (this.folderLocks.get(agent) === tail) this.folderLocks.delete(agent);
    }
  }

  // Evicts kept workspace folders per planEvictions (reaped, paused-and-idle, disk pressure); never a running or admitted
  // agent's. Journals `workspace_evicted`. An evicted paused agent's resume falls back to its last ingested ref.
  // TODO(clone-store): the folder-size cap and per-folder quota accounting are not enforced; pressure is measured as free bytes only.
  async sweepFolders(): Promise<AgentId[]> {
    const d = this.ctx.deps;
    const now = this.ctx.now();
    const have = new Set(await d.workspace.list());
    if (have.size === 0) return [];
    const cands: FolderCandidate[] = [];
    const recs = new Map<AgentId, AgentRecord>();
    for (const a of have) {
      const r = await this.ctx.deps.registry.get(a);
      if (!r) continue; // folders of unknown agents are reconcileWorktrees' business
      recs.set(a, r);
      cands.push({ agent: a, state: r.state, since: r.updatedAt, busy: this.live.has(a) || this.resuming.has(a) });
    }
    const policy = { idleMs: d.folderIdleMs ?? 0, reapedGraceMs: d.folderReapedGraceMs ?? 0, minFreeBytes: d.folderMinFreeBytes ?? 0 };
    const free = (await d.diskFreeBytes?.().catch(() => null)) ?? null;
    const plan = planEvictions(cands, now, policy, free);
    const evicted: AgentId[] = [];
    const evict = async (agent: AgentId, reason: "reaped" | "idle" | "disk_pressure") => {
      const r = recs.get(agent)!;
      // Under the agent's folder lock, which a resume also holds across its running transition: re-read, and evict only if the
      // agent is still in the state the plan saw and nothing has claimed the folder, so a resume never loses a folder it just took.
      await this.withFolderLock(agent, async () => {
        const cur = await this.ctx.deps.registry.get(agent);
        if (!cur || cur.state !== r.state || cur.generation !== r.generation || this.live.has(agent) || this.resuming.has(agent)) return;
        const ws = await folderId(this.ctx.deps, agent);
        await d.workspace.evict(agent);
        evicted.push(agent);
        if (ws !== null)
          await this.ctx
            .record(cur, { kind: "workspace_evicted", workspace: ws, reason }, `${agent}:${cur.generation}:evicted`)
            .catch(journalFailed(this.ctx.record, cur, "evicted"));
      });
    };
    for (const e of plan.due) await evict(e.agent, e.reason).catch((err) => this.ctx.hub.reconcile.journalError(recs.get(e.agent)!, err).catch(() => {}));
    for (const e of plan.pressure) {
      const now2 = (await d.diskFreeBytes?.().catch(() => null)) ?? null;
      if (now2 === null || now2 >= policy.minFreeBytes) break;
      await evict(e.agent, e.reason).catch((err) => this.ctx.hub.reconcile.journalError(recs.get(e.agent)!, err).catch(() => {}));
    }
    return evicted;
  }

  // Alerts once per zombie (the key dedups) on the zombie's own journal, and journals a message_sent to the
  // escalation channel (when configured) so the outbox carries the alert alongside the error entry.
  async sweepZombies(): Promise<AgentId[]> {
    const z = findZombies(await this.ctx.deps.registry.list({ state: "exited" }), this.ctx.now(), this.ctx.limits.zombieMs, await this.tree.rootAgentId());
    for (const a of z) {
      const secs = Math.round((this.ctx.now() - a.updatedAt) / 1000);
      const parent = a.parent ? await this.ctx.deps.registry.get(a.parent) : null;
      // A gone parent is not to blame: the result is held by the nearest live ancestor (tree.custodian).
      const message =
        !parent || isDone(parent)
          ? `zombie: exited ${a.exit} and unreaped; held for ${(await this.tree.custodian(a)).id} (parent ${a.parent} is gone) for ${secs}s`
          : `zombie: exited ${a.exit} and unreaped by parent ${a.parent} for ${secs}s`;
      await this.ctx.record(a, { kind: "error", message }, `${a.id}:${a.generation}:zombie`);
      await this.ctx.hub.user.sendToUser(a, "alert", message, `${a.id}:${a.generation}:zombie:alert`);
    }
    return z.map((a) => a.id);
  }

  // Parent-declared hold expiry (SpawnSpec.disposition { mode: "hold", ttlMs }): an exited, non-root child held past its ttlMs is
  // reaped, unless its merge is unsettled (then it stays held and one hold_ttl_deferred row says why). The custodian (the parent while it lives) is told first, then the agent is reaped, so a crash between the two cannot lose
  // the notice (the keys make the replay safe). Root children never get here: they are reaped at exit. Deterministic agents carry no
  // disposition. One agent's failure is journaled on it and does not stop the sweep.
  async sweepHoldTtl(): Promise<AgentId[]> {
    const rootId = await this.tree.rootAgentId();
    const now = this.ctx.now();
    const reaped: AgentId[] = [];
    for (const listed of await this.ctx.deps.registry.list({ state: "exited" })) {
      if (listed.executor !== "container" || listed.parent === null || listed.parent === rootId) continue;
      const d = listed.spec.disposition;
      if (d?.mode !== "hold" || d.ttlMs === undefined) continue;
      try {
        // updatedAt moves after the exit (a restart's sandbox reclaim, a budget raise), so the TTL runs from the exit entry.
        const exitedAt = (await this.exitedAt(listed)) ?? listed.updatedAt; // no entry (a pre-journal exit): updatedAt is the best bound
        if (now - exitedAt < d.ttlMs) continue;
        // Re-read: a resume between the list and the tell must neither be told it was reaped nor be reaped.
        const a = await this.ctx.deps.registry.get(listed.id);
        if (!a || a.state !== "exited" || a.generation !== listed.generation) continue;
        // The same merge guard as the API reap: an unsettled merge defers the expiry (the child stays held; a later sweep expires it once the merge
        // settles, or the custodian/operator reaps it). One journal row per child per exit, not one per sweep: the key dedupes the replays.
        try {
          await this.ctx.hub.lifecycle.requireMergeSettled(a.id);
        } catch (e) {
          if (!(e instanceof LifecycleError) || e.extra?.code !== "unmerged") throw e;
          const message = `hold TTL of ${d.ttlMs}ms passed but the merge of ${a.id} is unsettled (${String(e.extra.state)}); it stays held until the merge settles (a later sweep then expires it) or the custodian or operator reaps it (\`pomtree merge ${a.id}\`, then \`pomtree reap ${a.id}\`)`;
          await this.ctx.record(
            a,
            {
              kind: POMTREED_KINDS.holdTtlDeferred,
              ttlMs: d.ttlMs,
              mergeState: e.extra.state,
              failedRounds: e.extra.failedRounds,
              message,
            } as unknown as JournalPayload,
            `${a.id}:${a.generation}:ttl-deferred`,
          );
          continue;
        }
        const custodian = await this.tree.custodian(a);
        // The reap is non-destructive (refs and record stay) and the merge is settled by now; say where the work is.
        const text = `${a.id} was reaped: its hold expired after ${d.ttlMs}ms (disposition hold, ttlMs); its record and result stay readable with \`pomtree show ${a.id}\`; branch agent/${a.id} keeps any pushed work (\`pomtree pull --from ${a.id}\`)`;
        if (custodian.id === rootId) await this.ctx.hub.user.sendToUser(a, "status", text, `${a.id}:${a.generation}:ttl-reap`);
        else {
          const signal: Signal = { kind: "message", from: rootId, body: text };
          await this.ctx.hub.lifecycle.deliver(custodian.id, signal, `${a.generation}:ttl-reap:${a.id}`);
          await this.ctx.record(custodian, { kind: "signal", signal }, `${a.id}:${a.generation}:ttl-reap:journal`);
        }
        await this.ctx.hub.lifecycle.reap(a.id);
        reaped.push(a.id);
      } catch (e) {
        await this.ctx
          .record(
            listed,
            { kind: "error", message: `hold-ttl sweep failed: ${String(e instanceof Error ? e.message : e)}` },
            `${listed.id}:${listed.generation}:ttl-reap-error`,
          )
          .catch(journalFailed(this.ctx.record, listed, "ttl-reap-error"));
      }
    }
    return reaped;
  }

  // Timestamp of the newest `exited` entry of the agent's current generation, or null when the journal has none.
  private async exitedAt(a: AgentRecord): Promise<number | null> {
    let at: number | null = null;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: a.id, limit: 500 });
      for (const e of page) if (e.payload.kind === "exited" && e.generation === a.generation) at = e.ts;
      const last = page.at(-1);
      if (!last || page.length < 500) return at;
      from = last.seq + 1;
    }
  }

  // Watchdog ladder (SPEC "Watchdogs"): drive evaluate() over each running agent, building the snapshot from the
  // stores. The ladder position (rung/retries/lastActionAt) lives in deps.watchdogs and resets when an agent recovers.
  // Serialized behind a promise chain so overlapping setInterval ticks cannot interleave advanceWatchdog's
  // async read-modify-write and lose an update.
  sweepWatchdogs(): Promise<void> {
    const run = this.watchdogSweep.then(() => this.sweepWatchdogsNow());
    this.watchdogSweep = run.catch(() => {});
    return run;
  }

  private async sweepWatchdogsNow(): Promise<void> {
    const rootId = await this.tree.rootAgentId();
    const opts = this.ctx.deps.watchdogOptions ?? {};
    const full = { ...DEFAULT_WATCHDOG, ...opts };
    const now = this.ctx.now();
    // A sweep gap (an event-loop stall or a long pause between ticks) leaves stall/blocked ages stale:
    // grant one grace window so a delayed sweep cannot trip every agent at once on its return.
    const sweepsStale = this.sweepsStale(now);
    const sweepGap = this.lastWatchdogSweepAt !== null && now - this.lastWatchdogSweepAt > 2 * this.ctx.limits.watchdogSweepMs;
    if (sweepGap && this.lastWatchdogSweepAt !== null) {
      this.clockGaps.push({ start: this.lastWatchdogSweepAt + this.ctx.limits.watchdogSweepMs, end: now });
      if (this.clockGaps.length > MAX_CLOCK_GAPS) this.clockGaps.shift();
    }
    this.lastWatchdogSweepAt = now;
    // A coarse keyed host-health heartbeat per tick so a stalled/errored sweep is observable
    // in the journal (and in doctor().ok), not only on stderr.
    await this.journalHostHealth(rootId, now, sweepsStale).catch(() => {});
    if (sweepGap) return;
    for (const a of await this.ctx.deps.registry.list({ state: "running" })) {
      if (a.id === rootId || a.host !== this.ctx.deps.hostId || a.executor === "deterministic") continue;
      try {
        // Re-read before acting so a stale snapshot (the agent exited, was resumed, or its generation
        // moved since the list) is never acted on; only a still-running agent at the same generation is.
        const cur = await this.ctx.deps.registry.get(a.id);
        if (!cur || cur.state !== "running" || cur.generation !== a.generation) continue;
        const raw = await this.watchdogSnapshot(cur, rootId);
        const snap = { ...raw, clockGapMs: this.clockGapSince(raw.lastProgressAt, raw.now) };
        // A legitimately blocked agent (waiting on an open escalation or an in-flight tool call) is
        // exempt from the stall ladder for `blockedMs`; only after that does it climb like a stalled
        // agent. Anchoring on max(block, lastProgress) means real progress since the block still counts
        // as progress; the exemption applies only when `stalled` is the sole trip reason.
        const blocked = await this.blockedSince(cur);
        const effSnap = blocked !== null ? this.anchoredAt(snap, Math.max(blocked, snap.lastProgressAt)) : snap;
        const reasons = tripReasons(effSnap, full);
        const blockedExempt =
          blocked !== null && snap.now - blocked < this.ctx.limits.watchdogBlockedMs && (snap.deadlineAt === null || snap.now < snap.deadlineAt);
        if (blockedExempt && reasons.every((r) => r === "stalled")) {
          if (snap.rung !== "none" || snap.retries !== 0) {
            await this.setWatchdog(cur.id, { rung: "none", lastActionAt: snap.lastActionAt, retries: 0 }, `${cur.id}:reset:${snap.now}`);
          }
          continue;
        }
        // A waiting agent (settled, no result, container alive: the user is steering) is not stalled; deadline, budget and
        // failure trips still apply. TODO(idle): no upper bound on waiting.
        if (snap.waitingSince !== null && reasons.every((r) => r === "stalled")) {
          if (snap.rung !== "none" || snap.retries !== 0) {
            await this.setWatchdog(cur.id, { rung: "none", lastActionAt: snap.lastActionAt, retries: 0 }, `${cur.id}:reset:${snap.now}`);
          }
          continue;
        }
        if (!hasLadderReason(reasons)) {
          // A recovered agent's ladder resets to the bottom so a later stall climbs from "none" again. "budget" alone is
          // advisory (it never climbs), so an agent past the budget fraction but otherwise healthy resets too; its warning
          // still goes out below.
          // lastActionAt is KEPT: it anchors the recentFailures window (watchdogSnapshot uses it as `since`),
          // so one stale error cannot reopen the window to creation time and re-trip forever.
          if (snap.rung !== "none" || snap.retries !== 0) {
            await this.setWatchdog(cur.id, { rung: "none", lastActionAt: snap.lastActionAt, retries: 0 }, `${cur.id}:reset:${snap.now}`);
          }
          if (reasons.includes("budget")) await this.budget.warnBudget(cur, snap.spentMicros, full.budgetFraction);
          continue;
        }
        const action = evaluate(snap, opts);
        // Budget is advisory: a warning signal, never a ladder step.
        if (action.warnBudget) await this.budget.warnBudget(cur, snap.spentMicros, action.budgetThreshold);
        if (action.action === "none") continue; // grace period still holds the ladder
        await this.applyWatchdogAction(cur, action, rootId, snap.now);
        // A cancel/kill_resume finishes the agent (and finish() clears its ladder state); only advance while it still runs.
        if ((await this.ctx.deps.registry.get(cur.id))?.state === "running") await this.advanceWatchdog(cur.id, action, snap.now);
      } catch (e) {
        // One throwing agent must not abort the sweep or starve the agents after it in creation order.
        await this.ctx
          .record(
            a,
            { kind: "error", message: `watchdog sweep failed: ${String(e instanceof Error ? e.message : e)}` },
            `${a.id}:${a.generation}:watchdog-sweep-error`,
          )
          .catch(journalFailed(this.ctx.record, a, "watchdog-sweep-error"));
      }
    }
  }

  // The part of the recorded unwatched intervals that lies inside (since, now]: what tripReasons subtracts from now - since.
  private clockGapSince(since: number, now: number): number {
    let ms = 0;
    for (const g of this.clockGaps) ms += Math.max(0, Math.min(g.end, now) - Math.max(g.start, since));
    return ms;
  }

  private anchoredAt<S extends WatchdogSnapshot>(snap: S, lastProgressAt: number): S {
    return { ...snap, lastProgressAt, clockGapMs: this.clockGapSince(lastProgressAt, snap.now) };
  }

  // True when the last sweep is older than three watchdog intervals: the periodic sweep is stalled
  // (event-loop blockage, a throwing tick, or the daemon timer died), so the host is not being watched.
  sweepsStale(now: number): boolean {
    return this.lastWatchdogSweepAt !== null && now - this.lastWatchdogSweepAt > 3 * this.ctx.limits.watchdogSweepMs;
  }

  // Coarse keyed host-health heartbeat journaled once per watchdog tick on the root agent.
  private async journalHostHealth(rootId: AgentId, now: number, sweepsStale: boolean): Promise<void> {
    const root = await this.ctx.deps.registry.get(rootId);
    if (!root) return;
    const tick = Math.floor(now / this.ctx.limits.watchdogSweepMs);
    const ok = !sweepsStale && this.ctx.hub.store.hostUp();
    await this.ctx.record(root, { kind: HOST_HEALTH_KIND, ok, sweepsStale }, `host:health:${tick}`);
  }

  // Snapshot from the stores only: lastProgressAt is the newest journal event (fallback to record creation),
  // startedAt the registry createdAt, spentMicros the gateway's running total, budgetMicros the registry record.
  // deadlineAt comes from a spawn's keyed DEADLINE_KIND entry (null when none); recentFailures counts harness error events.
  private async watchdogSnapshot(a: AgentRecord, rootId: AgentId): Promise<WatchdogSnapshot & { waitingSince: number | null }> {
    const st = await this.ctx.deps.watchdogs.get(a.id);
    // recentFailures is windowed to error events since the last action (or start), so a recovered agent's
    // old failures do not pile onto the next ladder climb.
    const since = st?.lastActionAt ?? a.createdAt;
    let lastTs: number | undefined;
    let deadlineAt: number | null = null;
    let failures = 0;
    let waitingSince: number | null = null;
    // Page through the agent journal (no descending read in the Journal port) to find the newest ts,
    // count error events since `since`, and read the spawn's deadline. The watchdog's own entries are excluded so a nudge/alert cannot look
    // like progress or a failure.
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: a.id, limit: 500 });
      for (const e of page) {
        if (e.payload.kind === DEADLINE_KIND) {
          const at = (e.payload as { at?: number }).at;
          if (typeof at === "number" && (deadlineAt === null || at > deadlineAt)) deadlineAt = at;
        }
        if (this.isWatchdogEntry(e.payload, rootId)) continue;
        lastTs = e.ts;
        waitingSince = waitingStep(waitingSince, e);
        // A terminal exit's own reason entry (provider stop, retries exhausted, timed out) is not a live failure: a resumed
        // agent whose window reaches back to it must not start its new run with a failure already counted.
        if (e.payload.kind === "error" && e.ts >= since && !isTerminalExitMessage(e.payload.message)) failures++;
      }
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    const spent = await this.ctx.deps.gateway.spend(a.id);
    const now = this.ctx.now();
    // kill_resume retries are derived from the persisted restart timestamps (an intensity window), not the
    // single WatchdogStore.retries counter, which the resume journals reset on the next sweep.
    const restarts = st?.restarts ?? [];
    const retries = intensityRetries(restarts, now, this.ctx.limits.watchdogIntensityWindowMs, this.ctx.limits.watchdogStableMs);
    return {
      now,
      startedAt: a.createdAt,
      lastProgressAt: lastTs ?? a.createdAt,
      deadlineAt,
      budgetMicros: a.budgetMicros,
      spentMicros: spent.spentMicros,
      recentFailures: failures,
      rung: st?.rung ?? "none",
      lastActionAt: st?.lastActionAt ?? null,
      retries,
      waitingSince,
    };
  }

  // The timestamp since which an agent is legitimately blocked (an open escalation or an in-flight
  // tool call), or null when not blocked. Feeds the stall-ladder exemption in sweepWatchdogsNow.
  // Bounded: an open escalation short-circuits before any journal read, and the tool-call scan folds
  // each page into a small map of still-open callIds instead of materializing the whole journal.
  private async blockedSince(a: AgentRecord): Promise<number | null> {
    const open = await this.ctx.deps.escalations.list({ agent: a.id, state: "open" });
    const openEscalationAt = open.length ? Math.min(...open.map((e) => e.createdAt)) : null;
    if (openEscalationAt !== null) return openEscalationAt; // escalation wins; no journal scan
    const scan = newBlockedScan();
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: a.id, limit: 500 });
      foldBlocked(scan, page);
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    return openCallSince(scan);
  }

  // The watchdog's own journal entries (nudge message, escalate/quarantine error+alert) must not count as
  // agent progress or agent failures in the snapshot, or a stuck agent escapes the ladder via its own nudge.
  private isWatchdogEntry(p: JournalPayload, rootId: AgentId): boolean {
    if (p.kind === "signal") return p.signal.kind === "message" && p.signal.from === rootId;
    if (p.kind === "error") return p.message.startsWith("watchdog ");
    if (p.kind === "message_sent") return p.purpose === "alert" && p.subject.startsWith("watchdog ");
    if (p.kind === QUARANTINED_KIND) return true;
    return false;
  }

  // Read-modify-write on the durable ladder state preserving the fields the caller does not patch
  // (restart timestamps and the quarantine flag live in WatchdogState, not the journal).
  async setWatchdog(id: AgentId, patch: Partial<WatchdogState>, key: string): Promise<void> {
    const cur = (await this.ctx.deps.watchdogs.get(id)) ?? { rung: "none" as Rung, lastActionAt: null, retries: 0 };
    await this.ctx.deps.watchdogs.set(id, { ...cur, ...patch }, key);
  }

  private async advanceWatchdog(id: AgentId, action: WatchdogAction, now: number): Promise<void> {
    const st = (await this.ctx.deps.watchdogs.get(id)) ?? { rung: "none" as Rung, lastActionAt: null, retries: 0 };
    st.lastActionAt = now;
    switch (action.action) {
      case "nudge":
        st.rung = "nudged";
        break;
      case "cancel":
        st.rung = "cancelled";
        break;
      case "kill_resume":
        st.retries++;
        st.rung = "none";
        break; // reset so a resumed agent climbs from the bottom
      case "escalate":
        st.rung = "escalated";
        break;
      case "quarantine":
        // Terminal: evaluate() never acts on "quarantined", so the quarantine does not re-fire (and rewrite this row) every
        // graceMs while the agent still runs. A recovery resets the ladder like any other rung.
        st.rung = "quarantined";
        break;
    }
    await this.ctx.deps.watchdogs.set(id, st, `${id}:${action.action}:${now}`);
  }

  private async applyWatchdogAction(a: AgentRecord, action: WatchdogAction, rootId: AgentId, now: number): Promise<void> {
    switch (action.action) {
      case "nudge": {
        const signal: Signal = { kind: "message", from: rootId, body: `watchdog: ${action.reasons.join(", ")}` };
        await this.ctx.hub.lifecycle.deliver(a.id, signal, `${a.generation}:watchdog-nudge:${now}`);
        await this.ctx.record(a, { kind: "signal", signal }, `${a.id}:${a.generation}:nudge:${now}`);
        break;
      }
      case "cancel":
        await this.ctx.deps.orchestrator.cancel(a.id, this.ctx.deps.graceMs);
        break;
      case "kill_resume": {
        // Persist the restart timestamp durably so the next sweep counts
        // it within the intensity window instead of resetting retries to 0 on the resume's `resumed` entry.
        const prior = (await this.ctx.deps.watchdogs.get(a.id))?.restarts ?? [];
        await this.setWatchdog(a.id, { restarts: [...prior, now] }, `${a.id}:${a.generation}:watchdog-restart:${now}`).catch(() => {});
        const cp = await this.ctx.deps.checkpoints.latest(a.id);
        if (cp) {
          // A checkpoint exists: force-resume from it (fences the live instance and starts a fresh sandbox).
          await this.ctx.hub.lifecycle.forceResume(a, a.generation, "watchdog");
        } else {
          // A checkpoint-less running agent (it never yielded) has nothing to resume from; kill it and finish failed.
          const e = this.live.get(a.id);
          if (e) {
            // A driven agent exits through its own settle(); mark it failed here and stop its sandbox/session so
            // settle finishes "failed" instead of racing a direct finish() against its own "cancelled".
            e.result = { status: "failed", result: undefined };
            e.cancelled = true;
            if (e.sandbox) await this.ctx.deps.sandbox.kill(e.sandbox.id, sandboxOpKey("kill", e.sandbox.id)).catch(() => {});
            await e.session?.stop().catch(() => {});
          } else {
            await this.ctx.hub.reconcile.reclaimSandbox(a, true);
            await this.ctx.hub.lifecycle.finish(a.id, "failed");
          }
        }
        break;
      }
      case "escalate": {
        // Journal an error plus an alert on the escalation channel (when configured). Keyed once per (agent, generation, rung),
        // so re-sweeps after graceMs do not re-alert. A human-answerable ask is a separate feature (TODO(authz-escalation)).
        const subject = `watchdog escalated: ${action.reasons.join(", ")}`;
        await this.ctx.record(a, { kind: "error", message: subject }, `${a.id}:${a.generation}:escalate`);
        await this.ctx.hub.user.sendToUser(a, "alert", subject, `${a.id}:${a.generation}:escalate:alert`);
        break;
      }
      case "quarantine": {
        // A durable marker (per generation) that resume()/recover() refuse
        // without --force, plus an alert keyed once per rung instead of once per sweep.
        const subject = `watchdog quarantined: ${action.reasons.join(", ")}`;
        await this.setWatchdog(a.id, { quarantined: true }, `${a.id}:${a.generation}:quarantine:flag`).catch(() => {});
        await this.ctx.record(a, { kind: QUARANTINED_KIND, at: now }, `${a.id}:${a.generation}:quarantine:marker`);
        await this.ctx.record(a, { kind: "error", message: subject }, `${a.id}:${a.generation}:quarantine`);
        await this.ctx.hub.user.sendToUser(a, "alert", subject, `${a.id}:${a.generation}:quarantine:alert`);
        break;
      }
    }
  }
}
