// Budget escalation, grants and session deadlines of the Daemon: the budget_raise
// approval ladder around the drive loop, the grant hook, usage metering, the budget warning, and the wall-clock deadline
// map. Calls up into lifecycle go through `ctx.hub`; the `spawning` chain stays owned by lifecycle
// (`hub.lifecycle.exclusiveSpawn`). `rearmDeadlines`, `armDeadline` and `extendDeadline` stay on Daemon and reach
// `deadlines`/`deadlineLoaded` through its getter facades.

import type { AgentId, AgentRecord, Approval, HarnessEvent, Signal } from "@pomtree/core";
import {
  BUDGET_RAISE_KIND,
  DEFAULT_BUDGET_RAISE_MS,
  DEFAULT_BUDGET_RAISE_PCT,
  budgetRaiseTarget,
  budgetWakeText,
  parseBudgetRaiseTarget,
  requestedRaise,
} from "../budget-raise.ts";
import type { Live, SpawnRequest } from "../daemon-types.ts";
import { BUDGET_DENIED_KIND, BUDGET_ESCALATED_KIND, BUDGET_GRANTED_KIND, OP_KIND, containerSpec, isStoreDown, journalFailed } from "../daemon-util.ts";
import { LifecycleError, isDone } from "../lifecycle.ts";
import { settlementForUsage } from "../model-settlement.ts";
import { DEADLINE_KIND } from "../watchdog.ts";
import type { DaemonCtx } from "./ctx.ts";
import type { Escalation } from "./escalation.ts";
import type { Tree } from "./tree.ts";

export class Budget {
  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;
  private readonly escalation: Escalation;
  private readonly live: ReadonlyMap<AgentId, Live>;
  private readonly sessionDeadline: { defaultSessionMs: number; maxSessionMs: number } | null;
  // Per-agent wall-clock deadline (absolute epoch ms from SpawnRequest.deadlineMs). Runtime-only
  // arming for the hard kill; the durable deadline lives in a keyed journal entry (DEADLINE_KIND).
  readonly deadlines = new Map<AgentId, number>();
  // Agents whose durable deadline has been loaded into `deadlines`.
  readonly deadlineLoaded = new Set<AgentId>();

  constructor(
    ctx: DaemonCtx,
    tree: Tree,
    escalation: Escalation,
    live: ReadonlyMap<AgentId, Live>,
    sessionDeadline: { defaultSessionMs: number; maxSessionMs: number } | null,
  ) {
    this.ctx = ctx;
    this.tree = tree;
    this.escalation = escalation;
    this.live = live;
    this.sessionDeadline = sessionDeadline;
  }

  // Persist a spawn's wall-clock deadline (absolute `at`) and arm the runtime kill. The journal
  // entry is what watchdogSnapshot reads into `deadlineAt`; the in-memory map arms the hard kill.
  async spawnDeadline(rec: AgentRecord, req: SpawnRequest, requester: AgentRecord | null): Promise<void> {
    const existing = await this.deadlineAt(rec.id);
    if (existing !== undefined) {
      this.deadlines.set(rec.id, existing);
      return;
    }
    if (req.deadlineMs === undefined && !this.sessionDeadline) return;
    if (req.deadlineMs !== undefined && (!Number.isFinite(req.deadlineMs) || req.deadlineMs < 0)) {
      throw new LifecycleError(400, "deadlineMs must be a non-negative number");
    }
    // Zero deliberately differs from an omitted deadline: it opts out of the daemon's
    // default/max policy. A finite requester still bounds it below.
    const ownDeadlineAt =
      req.deadlineMs === 0
        ? Infinity
        : rec.createdAt + Math.min(req.deadlineMs ?? this.sessionDeadline!.defaultSessionMs, this.sessionDeadline?.maxSessionMs ?? Infinity);
    // A child cannot outlive the requester that paid for and authorized it. The durable
    // journal value, rather than only the in-memory timer map, survives daemon restarts.
    const parentDeadlineAt = requester ? await this.deadlineAt(requester.id) : undefined;
    const deadlineAt = Math.min(ownDeadlineAt, parentDeadlineAt ?? Infinity);
    if (deadlineAt === Infinity) return;
    this.deadlines.set(rec.id, deadlineAt);
    // An explicitly requested deadline that was cut short says so on the same entry (deadline-session-cap): `requestedMs` as
    // asked (0 = unlimited) and `clampedBy`, the bound that won ("maxSessionMs" policy, or the "requester"'s own deadline).
    const requestedAt = req.deadlineMs === undefined ? undefined : req.deadlineMs === 0 ? Infinity : rec.createdAt + req.deadlineMs;
    const clamp =
      requestedAt !== undefined && deadlineAt < requestedAt
        ? { requestedMs: req.deadlineMs, clampedBy: parentDeadlineAt !== undefined && parentDeadlineAt < ownDeadlineAt ? "requester" : "maxSessionMs" }
        : {};
    await this.ctx.record(rec, { kind: DEADLINE_KIND, at: deadlineAt, ...clamp }, `${rec.id}:deadline`);
  }

  private async deadlineAt(agent: AgentId): Promise<number | undefined> {
    const armed = this.deadlines.get(agent);
    if (armed !== undefined) return armed;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent, limit: 500 });
      for (const entry of page) {
        const at = (entry.payload as { kind?: string; at?: unknown }).kind === DEADLINE_KIND ? (entry.payload as { at?: unknown }).at : undefined;
        if (typeof at === "number" && Number.isFinite(at)) return at;
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return undefined;
      from = last.seq + 1;
    }
  }

  // Current durable session deadline (absolute epoch ms; null = none). The latest DEADLINE_KIND
  // journal entry wins (an extension appends a newer entry); within a process the armed map is
  // authoritative. Exposed for GET /v1/agents/:id/deadline and used by extendDeadline.
  async sessionDeadlineAt(agent: AgentId): Promise<number | null> {
    const armed = this.deadlines.get(agent);
    if (armed !== undefined) return armed;
    let latest: number | undefined;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent, limit: 500 });
      for (const entry of page) {
        const at = (entry.payload as { kind?: string; at?: unknown }).kind === DEADLINE_KIND ? (entry.payload as { at?: unknown }).at : undefined;
        if (typeof at === "number" && Number.isFinite(at)) latest = at;
      }
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    return latest ?? null;
  }

  // The agent's budget_raise approvals, oldest generation first.
  async budgetApprovals(id: AgentId): Promise<Approval[]> {
    const all = (await this.ctx.deps.approvals?.list({ requester: id })) ?? [];
    return all
      .filter((a) => a.action.kind === BUDGET_RAISE_KIND)
      .sort((x, y) => (x.requester.generation ?? 0) - (y.requester.generation ?? 0) || x.createdAt - y.createdAt);
  }

  // Parked on a budget approval: yielded, with a budget_raise approval for its current generation. Only the grant hook may resume it.
  async isBudgetParked(r: AgentRecord): Promise<boolean> {
    return r.state === "yielded" && (await this.budgetApprovals(r.id)).some((a) => a.requester.generation === r.generation);
  }

  // Sum of the amounts granted to the agent so far (the journaled BUDGET_GRANTED_KIND entries).
  private async budgetGranted(id: AgentId): Promise<number> {
    let sum = 0;
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: id, limit: 500 });
      for (const e of page) if (e.payload.kind === BUDGET_GRANTED_KIND) sum += Number((e.payload as { amount?: number }).amount) || 0;
      const last = page.at(-1);
      if (!last || page.length < 500) return sum;
      from = last.seq + 1;
    }
  }

  // The drive loop hit the budget (usage at or past it, or the proxy's 402): open the approval FIRST, then park, because a
  // crash after a parked-without-approval yield would strand the agent (nothing wakes a null wait). True = parked or
  // parking; false = fail closed (the caller sets overBudget): approvals unconfigured, or a failure before the checkpoint.
  // The proxy refused a call 402 because the agent's remainder is below the minimum a call needs. A running drive loop sees that 402 as
  // a harness error event and escalates itself; an adopted agent (re-attached after a daemon restart, no session) has no such loop, so
  // it stalled silently (REC-1). Escalate it here, through the same escalateBudget: its open-approval reuse and the yield key make
  // every repeated refusal after the first a no-op, and once it is parked it is no longer live. Nothing is held in memory.
  async escalateStalled(id: AgentId, remainingMicros: number | null, floorMicros: number): Promise<void> {
    // The proxy reports every refused call, and calls overlap: serialize per agent and re-check inside, so exactly one escalation parks it.
    await this.ctx.withLock(`budget-stall:${id}`, async () => {
      const entry = this.live.get(id);
      // No sandbox yet = an admission placeholder or the adopt reservation before its attach: nothing to park, and a yield would leave the container running.
      // TODO(proxy-reserve-restart): escalate refusals seen before an adopted agent is live. Current behavior: they are dropped.
      // A refusal with no live entry, no sandbox yet or while admitting returns here; only the next refused call reports
      // it again, so an adopted agent that makes no further call stays unescalated.
      if (!entry || !entry.sandbox || entry.admitting || entry.session || entry.yielding || entry.cancelled || entry.timedOut || entry.result) return;
      if (await this.escalateBudget(id, entry, { remainingMicros, floorMicros })) return;
      // Fail closed visibly. The drive loop ends a run over_budget here; an adopted agent's container is not ours to tear down from a
      // proxy callback, so it keeps running with refused calls and one keyed error row (once per generation) says why and what to do.
      const r = await this.ctx.deps.registry.get(id);
      if (!r) return;
      const cause = this.ctx.deps.approvals
        ? "the budget escalation could not be opened or the agent could not be parked (see the daemon log)"
        : "approvals are not configured, so a budget stall cannot escalate";
      await this.ctx
        .record(
          r,
          {
            kind: "error",
            message: `${id} is out of budget (${remainingMicros === null ? "none remains" : `${remainingMicros} micro-USD remain`}, below the ${floorMicros} micro-USD minimum a model call needs) and ${cause}; configure approvals and restart the daemon, or cancel the agent (\`pomtree cancel ${id}\`)`,
          },
          `${id}:${r.generation}:budget-stall-unescalated`,
        )
        .catch(journalFailed(this.ctx.record, r, "budget-stall-unescalated"));
    });
  }

  async escalateBudget(id: AgentId, entry: Live, stall?: { remainingMicros: number | null; floorMicros: number }): Promise<boolean> {
    const d = this.ctx.deps;
    if (!d.approvals) return false;
    let ap: Approval | undefined;
    let gen = 0;
    try {
      const r = await d.registry.get(id);
      if (!r || r.state !== "running") return false;
      gen = r.generation;
      const spent = (await d.gateway.spend(id)).spentMicros;
      // At most one budget approval per agent per generation: reuse the open one rather than issuing another.
      ap = (await this.budgetApprovals(id)).find((a) => a.requester.generation === gen);
      if (!ap) {
        const pct = d.budgetRaisePct !== undefined && d.budgetRaisePct > 0 && Number.isFinite(d.budgetRaisePct) ? d.budgetRaisePct : DEFAULT_BUDGET_RAISE_PCT;
        const requested = requestedRaise(pct, r.budgetMicros - (await this.budgetGranted(id)), Math.max(0, spent - r.budgetMicros));
        ap = await this.escalation.openApproval(
          r,
          BUDGET_RAISE_KIND,
          budgetRaiseTarget(id, gen, requested),
          `budget:${gen}`,
          d.budgetRaiseMs ?? DEFAULT_BUDGET_RAISE_MS,
        );
      }
      const requested = parseBudgetRaiseTarget(ap.action.target)?.requestedMicros;
      const stalled =
        stall === undefined
          ? {}
          : {
              remainingMicros: stall.remainingMicros,
              minimumMicros: stall.floorMicros,
              message: `${id} is out of budget: ${stall.remainingMicros === null ? "none remains" : `${stall.remainingMicros} micro-USD remain`} after in-flight requests, below the ${stall.floorMicros} micro-USD minimum a model call needs, so the model proxy refuses its calls; it is parked behind budget approval ${ap.id}. Grant more with \`pomtree decide ${ap.id} approve --grant $USD\` (or deny it to end the agent)`,
            };
      await this.ctx.record(r, { kind: BUDGET_ESCALATED_KIND, approval: ap.id, requested, spent, budget: r.budgetMicros, ...stalled }, `${ap.id}:escalated`);
    } catch (e) {
      if (isStoreDown(e)) this.ctx.hub.store.markDown(e);
      return false;
    }
    try {
      await this.ctx.hub.lifecycle.yield(id, { wait: null, idempotencyKey: `budget:${gen}` });
    } catch {
      if (entry.yielding) return true;
      // Yield failed before checkpointing: withdraw the approval so nobody grants into an agent that is about to fail.
      await d.approvals
        .decide(ap.id, { who: "daemon", rank: "operator", decision: "deny", why: "agent could not be parked" }, `${ap.id}:withdraw`)
        .catch(() => {});
      return false;
    }
    return true;
  }

  // The grant hook. Idempotent and safe to call from anywhere (decide tail, settleYield, sweep, reconcile): it acts only
  // on the agent's latest budget approval, and only once the agent is fully parked (yielded, runtime released).
  async applyBudgetDecision(id: AgentId): Promise<void> {
    const latest = (await this.budgetApprovals(id)).at(-1);
    if (latest) await this.ctx.withLock(`budget:${latest.id}`, () => this.applyBudgetLocked(id, latest.id));
  }

  private async applyBudgetLocked(id: AgentId, approval: string): Promise<void> {
    const ap = await this.ctx.deps.approvals?.get(approval);
    const asker = await this.ctx.deps.registry.get(id);
    if (!ap || !asker || ap.state === "pending") return;
    if (isDone(asker) || asker.generation !== ap.requester.generation) {
      // The asker is gone or has moved on: an approved raise moves no money (unless it was already granted).
      if (ap.state === "approved" && !(await this.ctx.hub.ops.seen(id, "budget-granted", ap.id)))
        await this.ctx.record(
          asker,
          { kind: BUDGET_DENIED_KIND, approval: ap.id, reason: isDone(asker) ? "asker exited" : "stale generation" },
          `${ap.id}:denied`,
        );
      return;
    }
    if (asker.state !== "yielded" || this.live.has(id)) return; // still parking (settleYield re-runs the hook) or running
    if (ap.state === "denied") return this.denyBudget(asker, ap, ap.journal.at(-1)?.why ?? "denied");
    await this.ctx.hub.lifecycle.exclusiveSpawn(() => this.grantBudget(asker, ap)); // serializes against spawn carves of the same budget
  }

  private async denyBudget(asker: AgentRecord, ap: Approval, reason: string): Promise<void> {
    await this.ctx.record(asker, { kind: BUDGET_DENIED_KIND, approval: ap.id, reason }, `${ap.id}:denied`);
    await this.ctx.hub.lifecycle.finish(asker.id, "over_budget");
  }

  // Carve the approved slice out of the deciding ancestor's own remaining budget and resume the asker. Every step is keyed, so a
  // crash anywhere replays to completion (a crash mid-raise leaves harmless slack). Runs inside the `spawning` chain.
  private async grantBudget(asker: AgentRecord, ap: Approval): Promise<void> {
    const d = this.ctx.deps;
    const raise = parseBudgetRaiseTarget(ap.action.target);
    const dec = [...ap.journal].reverse().find((j) => j.decision === "approve");
    if (!raise || !dec) return this.denyBudget(asker, ap, "malformed approval");
    const amount = dec.grantMicros ?? raise.requestedMicros;
    const root = await this.ctx.hub.root.root();
    const payer = dec.rank === "parent-agent" && dec.who ? await d.registry.get(dec.who) : root;
    const chain = await this.tree.ancestorChain(asker);
    if (!payer || isDone(payer) || (payer.id !== root.id && !chain.includes(payer.id))) return this.denyBudget(asker, ap, "payer is not a live ancestor");
    // Only the payer's remaining falls; each agent below it up to the asker gets the same raise (its carve inside the payer's).
    const path: AgentRecord[] = [asker];
    for (const aid of chain) {
      if (aid === payer.id) break;
      const a = await d.registry.get(aid);
      if (a) path.push(a);
    }
    // After the first raise the payer's remaining is already lower, so the cover check runs once, before it (marked durably).
    if (!(await this.ctx.hub.ops.seen(asker.id, "budget-granting", ap.id))) {
      // Signed: a payer already overdrawn by a booked overage cannot grant even a zero-cost raise.
      if (payer.budgetMicros - (await this.tree.consumed(payer)) < (await this.tree.grantCostMicros(asker.id, payer, amount)))
        return this.denyBudget(asker, ap, "insufficient budget");
      await this.ctx.record(asker, { kind: OP_KIND, op: "budget-granting", key: ap.id }, `${asker.id}:op:budget-granting:${ap.id}`);
    }
    for (const a of path.reverse()) await d.registry.raiseBudget(a.id, amount, `${ap.id}:raise:${a.id}`);
    const raised = (await d.registry.get(asker.id)) ?? asker;
    await this.ctx.record(raised, { kind: BUDGET_GRANTED_KIND, approval: ap.id, amount, payer: payer.id, newBudget: raised.budgetMicros }, `${ap.id}:granted`);
    // The wall-clock paused while parked: shift the session deadline by the parked time (keyed; a replay keeps the first shift).
    await this.shiftDeadline(raised, this.ctx.now() - ap.createdAt, `${ap.id}:deadline`);
    await this.ctx.hub.ops.mark(raised, "budget-granted", ap.id);
    const spent = (await d.gateway.spend(asker.id)).spentMicros;
    const holder = payer.id === root.id ? "the operator" : payer.id;
    // Interrupt messages journaled while parked ride in the grant's wake text (the resumed run appends and delivers them, mode
    // "budget-grant"); plain queued messages stay in the mailbox for the extension.
    const wake = budgetWakeText({ spent, budget: raised.budgetMicros - amount, holder, amount, newBudget: raised.budgetMicros });
    await this.ctx.hub.lifecycle.resumeAgent(asker.id, wake, { grant: true, interruptMode: "budget-grant" }, `${ap.id}:resume`);
  }

  private async shiftDeadline(a: AgentRecord, byMs: number, key: string): Promise<void> {
    const prev = await this.sessionDeadlineAt(a.id);
    if (prev === null || !(byMs > 0)) return;
    const entry = await this.ctx.record(a, { kind: DEADLINE_KIND, at: prev + byMs, previousAt: prev }, key);
    const at = (entry.payload as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    this.deadlines.set(a.id, at);
    this.deadlineLoaded.add(a.id);
  }

  // Tell a running agent it is near its budget. Keyed once per generation; budget_warning is a level kind.
  async warnBudget(a: AgentRecord, spentMicros: number, thresholdFraction: number): Promise<void> {
    const signal: Signal = {
      kind: "budget_warning",
      remainingMicros: Math.max(0, a.budgetMicros - spentMicros),
      budgetMicros: a.budgetMicros,
      thresholdFraction,
    };
    const key = `${a.id}:${a.generation}:budget_warning`;
    await this.ctx.deps.mailbox.send(a.id, signal, key);
    await this.ctx.record(a, { kind: "signal", signal }, key);
  }

  // Usage events are informational only (the proxy debit store is the spend authority): stamp the run's
  // resolved model so the event can be priced per model. When the model proxy settled the same call (usage-join: exact on the
  // provider response id the event and the settlement both carry), the event carries that settlement's request id and settled
  // charge as `costMicros`, keeping the harness's own figure as `harnessCostMicros`, so the journal has one authoritative cost
  // per request. An event without a response id, or whose id no settlement carries, stays unjoined. Otherwise, when the harness
  // reported no cost (null) or zero cost for nonzero tokens, substitute the gateway's catalog price (null = model-less or
  // unknown: stays unpriced). `costSource` names which figure `costMicros` is (core UsageCostSource).
  async meterUsage(rec: AgentRecord, ev: Extract<HarnessEvent, { kind: "usage" }>): Promise<Extract<HarnessEvent, { kind: "usage" }>> {
    const model = containerSpec(rec).model;
    const stamped = { ...ev, ...(model !== undefined && { model }) };
    const settled = await this.settlementFor(rec, ev.responseId);
    if (settled)
      return {
        ...stamped,
        costMicros: settled.micros,
        costSource: "settled",
        requestId: settled.requestId,
        ...(ev.costMicros !== null && { harnessCostMicros: ev.costMicros }),
      };
    const priced =
      (ev.costMicros === null || ev.costMicros === 0) && (ev.inputTokens > 0 || ev.outputTokens > 0)
        ? await this.ctx.deps.gateway.priceUsage?.({ ...(model !== undefined && { model }), inputTokens: ev.inputTokens, outputTokens: ev.outputTokens })
        : undefined;
    return priced != null && priced > 0 ? { ...stamped, costMicros: priced, costSource: "catalog" } : { ...stamped, costSource: "harness" };
  }

  // The indexed debit-store lookup when the gateway has one; else (no store: library use and unit tests) a scan of the agent's
  // journal for the settlement carrying the same response id. No response id: nothing to join, and no read at all.
  private async settlementFor(rec: AgentRecord, responseId: string | undefined): Promise<{ requestId: string; micros: number } | null> {
    if (!responseId) return null;
    const g = this.ctx.deps.gateway;
    if (g.settledCall) {
      const hit = await g.settledCall(rec.id, responseId);
      return hit ? { requestId: hit.requestId, micros: hit.chargedMicros } : null;
    }
    return settlementForUsage(await this.ctx.deps.journal.read({ agent: rec.id }), { responseId });
  }
}
