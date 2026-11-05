// Escalations and approvals of the Daemon: answering and waiting on asks,
// expiry sweeps, the bubbled-ask hop machinery and the approval ladder. Calls up into budget,
// lifecycle and reconcile go through `ctx.hub`. Per-ask and per-ancestor locks live in the one shared Locks (`ctx.withLock`).
// `ask` itself stays on Daemon.

import { APPROVAL_KIND, ESC_EXPIRED_KIND, ESC_HOP_KIND, EXPIRED_ANSWER, EXPIRED_BY, isStoreDown, journalFailed, sleep } from "../daemon-util.ts";
import { ladderFor } from "@pomtree/core";
import type {
  AgentId,
  AgentRecord,
  Approval,
  ApprovalRank,
  ApprovalStore,
  Escalation as EscalationRow,
  EscalationId,
  MessagingSender,
  Signal,
} from "@pomtree/core";
import { approvalIdFor, settleApproval } from "../approvals.ts";
import { BUDGET_RAISE_KIND, budgetRaiseBody, parseBudgetRaiseTarget } from "../budget-raise.ts";
import { LifecycleError, isDone } from "../lifecycle.ts";
import type { DaemonCtx } from "./ctx.ts";
import type { Messaging } from "./messaging.ts";
import type { Tree } from "./tree.ts";

// Approval kinds an ancestor agent may decide (bubbling). Allowlist, default budget_raise only: publish, merge, extension,
// snapshot and anything unknown need a human (operator/owner) approver.
export const AGENT_APPROVABLE_KINDS: ReadonlySet<string> = new Set([BUDGET_RAISE_KIND]);

export class Escalation {
  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;
  private readonly messaging: Messaging;

  constructor(ctx: DaemonCtx, tree: Tree, messaging: Messaging) {
    this.ctx = ctx;
    this.tree = tree;
    this.messaging = messaging;
  }

  // Blocks in <=30s chunks (the caller polls, like `pomtree ask --wait`) until the escalation is answered.
  async waitAsk(agent: AgentId, id: EscalationId, waitMs: number): Promise<EscalationRow> {
    const d = this.ctx.deps;
    let esc = await d.escalations.get(id);
    // An escalation belongs to its asker only; another agent must not read it by id (404 avoids revealing existence).
    if (!esc || esc.agent !== agent) throw new LifecycleError(404, `no such escalation: ${id}`);
    if (esc.state === "answered" || waitMs <= 0) return esc;
    const sub = d.journal.subscribe({ agent, from: 1 });
    const it = sub[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unkick = () => {};
    try {
      const timeout = new Promise<null>((res) => {
        timer = setTimeout(() => res(null), Math.min(waitMs, 30000));
        unkick = this.ctx.hub.kicks.onKick(agent, () => res(null));
      });
      for (;;) {
        const next = await Promise.race([it.next(), timeout]);
        if (!next || next.done) break;
        const p = next.value.payload;
        if (p.kind === "escalation_answered" && p.escalation === id) break;
      }
    } finally {
      clearTimeout(timer);
      unkick();
      sub.close();
    }
    return (await d.escalations.get(id)) ?? esc;
  }

  // Answers an escalation (first answer wins, via the store), journals it, and delivers the answer back
  // to the asker's mailbox as a `human_answer` signal. Idempotent by key at every step.
  async answerEscalation(id: EscalationId, answer: string, by: MessagingSender, key: string): Promise<EscalationRow> {
    const d = this.ctx.deps;
    const esc = await d.escalations.answer(id, answer, by, key);
    const answeredBy = esc.answeredBy ?? by;
    const body = esc.answer ?? answer;
    await this.deliverAnswer(esc, body, answeredBy, true);
    await this.clearAskHops(esc).catch(() => {}); // a stale holder must not still see the ask
    return esc;
  }

  // The journal + mailbox steps after an escalation is answered. Idempotent by key; reconcile() replays
  // them for an escalation whose store write landed but whose journal/send crashed.
  // `wake` is true only for a fresh answer: a reconcile replay must not wake a yielded asker again.
  async deliverAnswer(esc: EscalationRow, answer: string, answeredBy: MessagingSender, wake = false): Promise<void> {
    const d = this.ctx.deps;
    const a = await d.registry.get(esc.agent);
    if (a) await this.ctx.record(a, { kind: "escalation_answered", escalation: esc.id, answeredBy, answer }, `${esc.agent}:${esc.id}:answered`);
    const signal: Signal = { kind: "human_answer", escalation: esc.id, from: answeredBy, body: answer };
    await d.mailbox.send(esc.agent, signal, `${esc.agent}:${esc.id}:human_answer`);
    if (wake) await this.safeWake(esc.agent, signal, a, `${esc.id}:wake-error`);
  }

  // A wake that throws (e.g. a 409 after delivery) must not fail the already-durable delivery.
  async safeWake(agent: AgentId, signal: Signal, rec: AgentRecord | null, errKey: string): Promise<void> {
    try {
      await this.ctx.deps.orchestrator.wake(agent, signal);
    } catch (e) {
      if (rec)
        await this.ctx
          .record(rec, { kind: "error", message: `wake of ${agent} failed: ${String(e instanceof Error ? e.message : e)}` }, errKey)
          .catch(journalFailed(this.ctx.record, rec, "wake-error"));
    }
  }

  // Expires open escalations past their deadline (fail closed): the asker is answered with
  // EXPIRED_ANSWER by the daemon so it proceeds with a documented default instead of waiting forever (and being
  // killed as stalled). A late human reply then loses ("already answered"). Idempotent by key.
  async sweepEscalations(): Promise<EscalationId[]> {
    const d = this.ctx.deps;
    const ttl = d.askTimeoutMs ?? 24 * 3_600_000;
    const expired: EscalationId[] = [];
    for (const esc of await d.escalations.list({ state: "open" })) {
      const age = this.ctx.now() - esc.createdAt;
      if (age < ttl) {
        // A bubbled ask whose holder's hop window lapsed moves up; until it reaches the human rung nothing re-alerts the user.
        if (esc.holder !== null) {
          if (esc.hopDeadlineAt !== undefined && this.ctx.now() >= esc.hopDeadlineAt) await this.passAsk(esc.id, null, esc.holder);
          continue;
        }
        const base = d.askRealertBaseMs ?? 3_600_000;
        // Only rungs that land before expiry can fire (the expiry alert itself covers the rest, e.g. 24x under a 24h TTL).
        const due = [1, 4, 24].filter((m) => m * base < ttl && age >= m * base);
        if (this.messaging.hasUserChannel() && due.length > 0) {
          const m = due[due.length - 1]!;
          const a = await d.registry.get(esc.agent);
          if (a)
            await this.ctx.hub.user.sendToUser(a, "alert", `ask still unanswered after ${m}x: ${esc.question}`, `${esc.id}:realert:${m}`).catch((e) => {
              if (isStoreDown(e)) throw e;
              console.error(`pomtreed: ask re-alert not journaled: ${e instanceof Error ? e.message : String(e)}`);
            });
        }
        continue;
      }
      const a = await d.registry.get(esc.agent);
      if (a) await this.ctx.record(a, { kind: ESC_EXPIRED_KIND, escalation: esc.id, at: this.ctx.now() }, `${esc.id}:expired`);
      await this.answerEscalation(esc.id, EXPIRED_ANSWER, EXPIRED_BY, `expire:${esc.id}`);
      if (a && this.messaging.hasUserChannel()) {
        await this.ctx.hub.user.sendToUser(a, "alert", `ask expired unanswered: ${esc.question}`, `${esc.id}:expired:alert`);
      }
      expired.push(esc.id);
    }
    return expired;
  }

  // --- Bubbled escalations (asks and approvals climb the ancestor chain) ---

  escAgentMs(): number {
    return this.ctx.deps.escAgentMs ?? 600_000;
  }

  // Send one hop's `escalation` signal to an ancestor agent and wake it. "unavailable" (gone, exited, reaped or
  // quarantined) means the caller advances past it. The holder is woken only when this call enqueued the signal.
  // TODO(hop-hybrid): every hop wakes the holder; a mechanical or hybrid hop (a cheap rule or a small model deciding
  // before waking the full agent) is later. Current behavior: every hop wakes the holder.
  private async sendHop(requester: AgentRecord, holder: AgentId, signal: Signal, key: string): Promise<"sent" | "unavailable"> {
    const rec = await this.ctx.deps.registry.get(holder);
    // A holder parked on its own budget approval cannot act (nothing wakes it but its grant): the caller advances past it.
    if (!rec || isDone(rec) || (await this.ctx.hub.reconcile.isQuarantined(rec)) || (await this.ctx.hub.budget.isParked(rec))) return "unavailable";
    const queued = async () => (await this.ctx.deps.mailbox.peek(holder)).some((s) => s.id === key);
    const had = await queued();
    try {
      await this.messaging.toMailbox(requester, holder, signal, key);
    } catch (e) {
      if (isStoreDown(e)) throw e;
      return "unavailable"; // raced the holder's reap
    }
    await this.ctx.record(rec, { kind: "signal", signal }, `${key}:journal`).catch(journalFailed(this.ctx.record, rec, "signal-journal"));
    if (!had && (await queued())) {
      this.ctx.hub.kicks.kick(holder);
      await this.safeWake(holder, signal, rec, `${key}:wake-error`);
    }
    return "sent";
  }

  private async ackHop(holder: AgentId, id: string, idx: number): Promise<void> {
    await this.ctx.deps.mailbox.ack(holder, [`${id}:hop:${idx}`], `${id}:hop-ack:${idx}`).catch(() => {});
  }

  // Index of the ask's current holder in the asker's ancestor chain; chain.length = the user via root.
  private hopIdx(esc: EscalationRow, chain: AgentId[]): number {
    return esc.holder === null ? chain.length : chain.indexOf(esc.holder);
  }

  // Hand a bubbled ask to hop `from` of the chain (index chain.length = the user via root), skipping unavailable holders.
  async dispatchAskHop(esc: EscalationRow, asker: AgentRecord, chain: AgentId[], from: number): Promise<void> {
    for (let i = from; ; i++) {
      const holder = chain[i] ?? null;
      const hopDeadlineAt = holder === null ? undefined : this.ctx.now() + this.escAgentMs();
      if (i > 0) await this.ackHop(chain[i - 1]!, esc.id, i - 1);
      const signal: Signal = {
        kind: "escalation",
        escalation: esc.id,
        subject: "ask",
        from: esc.agent,
        body: esc.question,
        ...(esc.options.length > 0 && { options: esc.options }),
        deadlineAt: hopDeadlineAt ?? esc.createdAt + (this.ctx.deps.askTimeoutMs ?? 24 * 3_600_000),
      };
      const key = `${esc.id}:hop:${i}`;
      const unavailable = holder === null ? false : (await this.sendHop(asker, holder, signal, key)) === "unavailable";
      if (holder === null) await this.messaging.toMailbox(asker, await this.tree.rootAgentId(), signal, key);
      if (i > 0) await this.ctx.deps.escalations.advance(esc.id, holder, hopDeadlineAt, `${esc.id}:hop-state:${i}`);
      // Audit trail only: the store row holds the current hop; nothing reads this event back.
      if (i > 0)
        await this.ctx.record(
          asker,
          {
            kind: ESC_HOP_KIND,
            escalation: esc.id,
            idx: i,
            holder,
            ...(hopDeadlineAt !== undefined && { hopDeadlineAt }),
            ...(unavailable && { auto: "unavailable" }),
          } as never,
          `${esc.id}:hop-state:${i}`,
        );
      if (!unavailable) return;
    }
  }

  // Release every hop signal of an answered ask from its holders' inboxes.
  private async clearAskHops(esc: EscalationRow): Promise<void> {
    const asker = await this.ctx.deps.registry.get(esc.agent);
    if (!asker) return;
    const chain = await this.tree.ancestorChain(asker);
    const idx = this.hopIdx(esc, chain);
    for (let i = 0; i <= idx && i < chain.length; i++) await this.ackHop(chain[i]!, esc.id, i);
  }

  // Move a bubbled ask to its next holder. `agent` is the caller (must hold it); null = the operator or the hop sweep.
  // `expectHolder` (the sweep) makes this a no-op when the ask already moved.
  private passAsk(id: EscalationId, agent: AgentId | null, expectHolder?: AgentId): Promise<EscalationRow> {
    return this.ctx.withLock(`item:${id}`, async () => {
      const esc = await this.ctx.deps.escalations.get(id);
      if (!esc) throw new LifecycleError(404, `no such escalation: ${id}`);
      if (esc.state !== "open") return esc;
      if (expectHolder !== undefined && esc.holder !== expectHolder) return esc;
      if (agent !== null && esc.holder !== agent) throw new LifecycleError(403, `${agent} does not hold escalation ${id}`);
      if (esc.holder === null) throw new LifecycleError(409, "nothing above: the ask is already with the user");
      const asker = await this.ctx.deps.registry.get(esc.agent);
      if (!asker || isDone(asker)) {
        if (expectHolder !== undefined) return esc;
        throw new LifecycleError(409, "the asker is gone");
      }
      const chain = await this.tree.ancestorChain(asker);
      await this.dispatchAskHop(esc, asker, chain, this.hopIdx(esc, chain) + 1);
      return esc;
    });
  }

  // `POST /v1/escalations/:id/pass`: the holder (or the operator, with agent null) hands the ask up one hop. Keyed-idempotent.
  async passEscalation(id: EscalationId, agent: AgentId | null, key: string): Promise<EscalationRow> {
    const run = async () => {
      if (agent !== null && (await this.ctx.hub.ops.seen(agent, `pass:${id}`, key))) return this.passReplay(id);
      await this.passAsk(id, agent);
      if (agent !== null) await this.ctx.hub.ops.mark(await this.ctx.deps.registry.get(agent), `pass:${id}`, key);
      return this.passReplay(id);
    };
    return agent === null ? run() : this.ctx.withLock(`anc:${agent}`, run);
  }

  private async passReplay(id: EscalationId): Promise<EscalationRow> {
    const esc = await this.ctx.deps.escalations.get(id);
    if (!esc) throw new LifecycleError(404, `no such escalation: ${id}`);
    return esc;
  }

  // `POST /v1/escalations/:id/answer` by an ancestor agent holding the ask; the asker gets a human_answer from that agent.
  async answerEscalationAs(agent: AgentId, id: EscalationId, body: string, key: string): Promise<EscalationRow> {
    return this.ctx.withLock(`anc:${agent}`, () =>
      this.ctx.withLock(`item:${id}`, async () => {
        const esc = await this.ctx.deps.escalations.get(id);
        if (!esc) throw new LifecycleError(404, `no such escalation: ${id}`);
        if (await this.ctx.hub.ops.seen(agent, `answer:${id}`, key)) return esc;
        if (esc.state === "answered")
          throw new LifecycleError(
            409,
            `escalation ${id} was already answered; your answer was not applied and the asker never sees it. Send the agent a message if it needs more.`,
          );
        if (esc.holder !== agent) throw new LifecycleError(403, `${agent} does not hold escalation ${id}`);
        const out = await this.answerEscalation(id, body, { channel: "agent", sender: agent }, key);
        await this.ctx.hub.ops.mark(await this.ctx.deps.registry.get(agent), `answer:${id}`, key);
        return out;
      }),
    );
  }

  // Dispatch the current rung of a bubbled approval (an `agent:<id>` rung wakes that ancestor; the operator rung reaches
  // the user through root), auto-advancing past unavailable holders. A settled approval releases its hop signals.
  // Returns the approval it ended on. Ladders without agent rungs (top-level requesters, web_fetch) are not touched.
  private async dispatchApproval(ap: Approval): Promise<Approval> {
    const store = this.ctx.deps.approvals;
    if (!store || !ap.rungs.some((r) => r.startsWith("agent:"))) return ap;
    let cur = ap;
    for (;;) {
      const idx = cur.rungIndex;
      if (cur.state !== "pending") {
        for (let i = 0; i < Math.min(idx + 1, cur.rungs.length); i++) {
          const r = cur.rungs[i]!;
          if (r.startsWith("agent:")) await this.ackHop(r.slice("agent:".length), cur.id, i);
        }
        return cur;
      }
      const prev = idx > 0 ? cur.rungs[idx - 1]! : null;
      if (prev?.startsWith("agent:")) await this.ackHop(prev.slice("agent:".length), cur.id, idx - 1);
      const rung = cur.rungs[idx]!;
      const requester = await this.ctx.deps.registry.get(cur.requester.id);
      if (!requester) return cur;
      const signal = await this.approvalSignal(cur, requester);
      if (!rung.startsWith("agent:")) {
        if (rung === "operator") await this.messaging.toMailbox(requester, await this.tree.rootAgentId(), signal, `${cur.id}:hop:${idx}`);
        return cur;
      }
      const holder = rung.slice("agent:".length);
      if ((await this.sendHop(requester, holder, signal, `${cur.id}:hop:${idx}`)) === "sent") return cur;
      cur = await store.decide(
        cur.id,
        { who: "daemon", rank: "parent-agent", decision: "abstain", why: `holder ${holder} unavailable` },
        `${cur.id}:autoadv:${idx}`,
      );
      await this.ctx
        .record(
          requester,
          { kind: ESC_HOP_KIND, escalation: cur.id, idx: cur.rungIndex, holder: null, auto: "unavailable" } as never,
          `${cur.id}:hop-state:${cur.rungIndex}`,
        )
        .catch(journalFailed(this.ctx.record, requester, "hop-state"));
    }
  }

  private async settleHops(store: ApprovalStore, ap: Approval): Promise<Approval> {
    const settled = await this.ctx.withLock(`item:${ap.id}`, () => settleApproval(store, ap, this.ctx.now(), (a) => this.dispatchApproval(a)));
    await this.notifyApprovalDecision(settled);
    return settled;
  }

  // Store the notification before waking. Reconciliation replays settled approvals too, closing decision->enqueue and
  // enqueue->wake crash windows. A consumed keyed signal is never recreated, so a later unrelated wait is not re-woken.
  // Once the signal is enqueued and the wake attempted the approval is marked delivered (ApprovalStore.markNotified) and the
  // sweep stops replaying it, so a decision is not re-mailed after the idempotency table forgets its key (fixed: approval replay).
  // A crash before the mark replays through the same keys: no second signal, and a still-queued one is woken again.
  private async notifyApprovalDecision(ap: Approval): Promise<void> {
    if (ap.state === "pending" || ap.notifiedAt !== undefined) return;
    if (ap.action.kind === BUDGET_RAISE_KIND) return this.markDelivered(ap); // budget parks retain their existing grant hook: nothing to mail
    const requester = await this.ctx.deps.registry.get(ap.requester.id);
    // A missing or reaped requester can never read it (reaped is terminal and refuses mail): stamped so the sweep stops rescanning it.
    // An exited one can still resume, so its decision is mailed durably (below) but it is not woken.
    if (!requester || requester.state === "reaped") return this.markDelivered(ap);
    // TODO(steer): container requesters no longer wake on this signal, yet it is still mailed and stays unacked until the agent's next resume (and makes an inbox park return parked:false); skipping or acking container requesters is a product decision. Current behavior: mailed to all.
    const key = `${ap.id}:decision:${ap.state}`;
    const signal: Signal = { kind: "approval_decided", approval: ap.id, state: ap.state, action: { ...ap.action } };
    try {
      await this.ctx.deps.mailbox.send(requester.id, signal, key);
    } catch (e) {
      // The decision is already committed: a requester that vanished mid-flight must neither fail it nor skip other notifications. The keyed replay in sweepApprovals retries.
      if (isStoreDown(e)) throw e;
      await this.ctx
        .record(
          requester,
          { kind: "error", message: `approval_decided mail to ${requester.id} failed: ${String(e instanceof Error ? e.message : e)}` },
          `${key}:send-error`,
        )
        .catch(journalFailed(this.ctx.record, requester, "send-error"));
      return;
    }
    if (!isDone(requester) && (await this.ctx.deps.mailbox.peek(requester.id)).some((queued) => queued.id === key))
      await this.safeWake(requester.id, signal, requester, `${key}:wake-error`);
    await this.markDelivered(ap);
  }

  // A failed mark only means the next sweep replays this decision through its keys; the decision itself is already committed.
  private async markDelivered(ap: Approval): Promise<void> {
    try {
      await this.ctx.deps.approvals?.markNotified(ap.id, `${ap.id}:notified`);
    } catch (e) {
      if (isStoreDown(e)) throw e;
    }
  }

  // A workflow may inspect only its own request or the approval it currently holds. Settle expired rungs through
  // the same policy as reconciliation; reads never grant authority or transfer task-owned questions.
  async getApprovalFor(agent: AgentId, id: string): Promise<Approval | null> {
    const store = this.ctx.deps.approvals;
    if (!store) throw new LifecycleError(503, "approvals are not configured");
    const ap = await store.get(id);
    if (!ap) return null;
    if (ap.requester.id !== agent && ap.rungs[ap.rungIndex] !== `agent:${agent}`)
      throw new LifecycleError(403, "approval is not owned or held by this workflow");
    return this.settleHops(store, ap);
  }

  // --- Approvals (TODO(authz-escalation)) ---

  // Gate one action behind a durable approval: create (idempotent by key), alert the escalation channel once, then
  // wait up to approvalWaitMs for a decision. Approved returns; denied (including a fail-closed timeout) is 403; still
  // pending is 409 with the approval id, and a retry with the same key converges on the same record.
  async requireApproval(agent: AgentRecord, kind: string, target: string, key: string): Promise<Approval> {
    const d = this.ctx.deps;
    const store = d.approvals;
    if (!store) throw new LifecycleError(503, "approvals are not configured");
    let ap = await this.openApproval(agent, kind, target, key);
    const id = ap.id;
    const end = Date.now() + (d.approvalWaitMs ?? 20_000); // a real-time block bound, independent of the injected clock
    ap = (await store.get(id)) ?? ap; // create() is idempotent by key and may replay the record as first written (pending), so a decision made since a prior attempt must be read fresh before the wait bound is judged
    for (;;) {
      ap = await this.settleHops(store, ap);
      if (ap.state !== "pending") break;
      if (Date.now() >= end) throw new LifecycleError(409, `approval pending: ${id}`, { approval: id });
      await sleep(Math.min(d.admitRetryMs, 100));
      ap = (await store.get(id)) ?? ap;
    }
    await this.ctx
      .record(
        agent,
        { kind: APPROVAL_KIND, approval: id, action: kind, target, state: ap.state, requester_generation: ap.requester.generation ?? agent.generation },
        `${id}:${ap.state}`,
      )
      .catch(journalFailed(this.ctx.record, agent, "approval"));
    if (ap.state !== "approved") {
      const why = ap.journal.at(-1)?.why ?? "denied";
      throw new LifecycleError(403, `${kind} ${target} was denied (${why})`);
    }
    return ap;
  }

  // The non-blocking half of requireApproval: create the approval (idempotent by key) and dispatch its first rung, then
  // return it. `humanMs` overrides the human-rung window (a budget raise waits longer than a gated call).
  async openApproval(agent: AgentRecord, kind: string, target: string, key: string, humanMs?: number): Promise<Approval> {
    const d = this.ctx.deps;
    const store = d.approvals;
    if (!store) throw new LifecycleError(503, "approvals are not configured");
    const id = approvalIdFor(agent.id, kind, target, key);
    // The ladder is the requester's ancestor chain (nearest first, root excluded), then the operator and owner.
    // Only kinds in AGENT_APPROVABLE_KINDS may bubble through ancestor agents; every other (external-effect or unknown)
    // kind goes straight to operator, owner so no LLM ancestor can approve it (fail closed).
    const chain = AGENT_APPROVABLE_KINDS.has(kind) ? await this.tree.ancestorChain(agent) : [];
    const rungs = ladderFor(chain);
    const rungWindowsMs = rungs.map((r) => (r.startsWith("agent:") ? this.escAgentMs() : (humanMs ?? d.approvalTimeoutMs ?? 300_000)));
    let ap = await store.create(
      {
        id,
        requester: { id: agent.id, rank: "agent", generation: agent.generation },
        action: { kind, target },
        host: d.hostId,
        deadlineAt: this.ctx.now() + rungWindowsMs[0]!,
        rungs,
        rungWindowsMs,
      },
      `${agent.id}:${key}:approval:${kind}:${id}`,
    ); // id hashes the target: the same key with another target must not reuse this approval
    if (ap.state === "pending") {
      if (ap.rungs.some((r) => r.startsWith("agent:"))) ap = await this.ctx.withLock(`item:${id}`, () => this.dispatchApproval(ap));
      else await this.alertApproval(agent, ap);
    }
    await this.notifyApprovalDecision(ap);
    return ap;
  }

  // The `escalation` signal for one rung of an approval; a budget raise carries the amounts and its own text.
  private async approvalSignal(ap: Approval, requester: AgentRecord): Promise<Signal> {
    const raise = ap.action.kind === BUDGET_RAISE_KIND ? parseBudgetRaiseTarget(ap.action.target) : null;
    if (!raise)
      return {
        kind: "escalation",
        escalation: ap.id,
        subject: "approval",
        from: requester.id,
        body: `approve ${ap.action.kind} ${ap.action.target}? reply approve or deny`,
        options: ["approve", "deny", "pass"],
        deadlineAt: ap.deadlineAt,
      };
    const spent = (await this.ctx.deps.gateway.spend(requester.id)).spentMicros;
    return {
      kind: "escalation",
      escalation: ap.id,
      subject: "budget_raise",
      from: requester.id,
      body: budgetRaiseBody(requester.id, raise.requestedMicros),
      options: ["approve", "deny", "pass"],
      requestedMicros: raise.requestedMicros,
      spentMicros: spent,
      budgetMicros: requester.budgetMicros,
      deadlineAt: ap.deadlineAt,
    };
  }

  // One escalation-channel alert per approval, journaled on the requester's journal as a `message_sent`
  // (idempotent by `${id}:sent`, so a retry with the same key never double-alerts). Best-effort: a journal
  // failure never blocks the approval itself.
  private async alertApproval(agent: AgentRecord, ap: Approval): Promise<void> {
    const raise = ap.action.kind === BUDGET_RAISE_KIND ? parseBudgetRaiseTarget(ap.action.target) : null;
    const text = raise
      ? `${budgetRaiseBody(agent.id, raise.requestedMicros)} reply approve or deny`
      : `approve ${ap.action.kind} ${ap.action.target}? reply approve or deny`;
    await this.ctx.hub.user.sendToUser(agent, "ask", text, `${ap.id}:sent`, ap.id, { subjectKind: "approval" }).catch(() => {});
  }

  // Alert for a pending approval created outside requireApproval (the web_fetch escalation hook):
  // the same journaled escalation-channel `message_sent` as a requireApproval
  // ask, on the requester's journal. No-ops for a settled approval, no escalation channel, or a
  // requester no longer in the registry (fail closed stays with the approval path, not the alert).
  async notifyApprovalAsk(ap: Approval): Promise<void> {
    if (ap.state !== "pending" || !this.messaging.hasUserChannel()) return;
    const agent = await this.ctx.deps.registry.get(ap.requester.id);
    if (agent) await this.alertApproval(agent, ap);
  }

  // A decision on an approval: a human (the chat reply path or an operator route) decides at the operator rank; an ancestor
  // agent (`as.agent`) decides only the rung that names it. "pass" abstains and hands the approval up one rung.
  // Idempotent by key (an agent replay is recognized by its journaled op, since the rung has moved on).
  async decideApproval(
    id: string,
    decision: "approve" | "deny" | "pass",
    who: string,
    why: string,
    key: string,
    as: { agent?: AgentId; grantMicros?: number } = {},
  ): Promise<Approval> {
    const store = this.ctx.deps.approvals;
    if (!store) throw new LifecycleError(503, "approvals are not configured");
    const run = () =>
      this.ctx.withLock(`item:${id}`, async () => {
        const found = await store.get(id);
        if (!found) throw new LifecycleError(404, `no such approval: ${id}`);
        if (as.agent && (await this.ctx.hub.ops.seen(as.agent, `decide:${id}`, key))) return found;
        // A decision past the rung deadline is a timeout, not an approval: settle due rungs first.
        const pre = await settleApproval(store, found, this.ctx.now(), (a) => this.dispatchApproval(a));
        const stored = decision === "pass" ? "abstain" : decision;
        if (pre.state !== "pending") {
          const last = pre.journal.at(-1);
          if (last && (last.who ?? "") === (as.agent ?? who) && last.decision === stored) return pre; // replay of the decision that settled it
          throw new LifecycleError(409, `approval ${id} is already ${pre.state}`);
        }
        let rank: ApprovalRank = "operator";
        let by = who;
        const raise = pre.action.kind === BUDGET_RAISE_KIND ? parseBudgetRaiseTarget(pre.action.target) : null;
        if (as.agent) {
          // Defense in depth: an approval persisted before the allowlist may carry agent rungs for a kind agents cannot decide.
          if (!AGENT_APPROVABLE_KINDS.has(pre.action.kind)) throw new LifecycleError(403, `agents cannot decide ${pre.action.kind} approvals`);
          if (pre.rungs[pre.rungIndex] !== `agent:${as.agent}`) throw new LifecycleError(403, `${as.agent} does not hold approval ${id}`);
          rank = "parent-agent";
          by = as.agent;
        }
        // A budget approval's grant comes out of the deciding ancestor's remaining budget (a human decision draws from root's).
        // The amount is the explicit grant or the requested one; a payer who cannot cover it must pass it up (409 insufficient_budget).
        let grant = as.grantMicros;
        if (raise && decision === "approve") {
          grant ??= raise.requestedMicros;
          if (!Number.isSafeInteger(grant) || grant <= 0) throw new LifecycleError(400, "grantMicros must be a positive safe integer");
        }
        const payer = as.agent ? await this.ctx.deps.registry.get(as.agent) : raise && decision === "approve" ? await this.ctx.hub.root.root() : null;
        // The cover check charges what the grant costs the payer in the hierarchical ledger: an overage already booked against it
        // is not charged a second time (Tree.grantCostMicros), and a payer already overdrawn (signed remaining below zero) grants nothing.
        const cost = grant !== undefined && payer ? await this.tree.grantCostMicros(pre.requester.id, payer, grant) : 0;
        if (grant !== undefined && payer && cost > payer.budgetMicros - (await this.tree.consumed(payer)))
          throw new LifecycleError(409, `${payer.id} has less than ${cost} micros left to grant ${grant}`, { code: "insufficient_budget" });
        let out: Approval;
        try {
          out = await store.decide(id, { who: by, rank, decision: stored, why, ...(grant !== undefined && { grantMicros: grant }) }, key);
        } catch (e) {
          if (e instanceof LifecycleError || isStoreDown(e)) throw e;
          throw new LifecycleError(403, e instanceof Error ? e.message : String(e)); // rank/rung rejection
        }
        out = await this.dispatchApproval(out);
        if (as.agent) await this.ctx.hub.ops.mark(await this.ctx.deps.registry.get(as.agent), `decide:${id}`, key);
        return out;
      });
    const decided = await (as.agent ? this.ctx.withLock(`anc:${as.agent}`, run) : run());
    // The grant hook runs outside the locks above (it takes its own); a failure is retried by the next reconcile tick.
    if (decided.action.kind === BUDGET_RAISE_KIND) await this.ctx.hub.budget.applyDecision(decided.requester.id);
    await this.notifyApprovalDecision(decided);
    return decided;
  }

  // Sweeps pending approvals past their rung deadline (fail closed past the top rung).
  async sweepApprovals(): Promise<number> {
    const store = this.ctx.deps.approvals;
    if (!store) return 0;
    let n = 0;
    for (const ap of await store.list({ state: "pending" })) {
      const cur = await this.settleHops(store, ap);
      if (cur.state !== "pending") {
        n++;
        if (cur.action.kind === BUDGET_RAISE_KIND) await this.ctx.hub.budget.applyDecision(cur.requester.id);
      } else if (cur.rungs.some((r) => r.startsWith("agent:"))) await this.ctx.withLock(`item:${ap.id}`, () => this.dispatchApproval(cur)); // re-send a hop lost to a crash (keyed, wakes nobody twice)
    }
    // A crash can commit a terminal decision before notification. Replaying only pending rows would strand that requester.
    // Only decisions not yet marked delivered are listed, so the rescan is bounded by what is still owed, not by history.
    for (const state of ["approved", "denied"] as const) for (const ap of await store.list({ state, unnotified: true })) await this.notifyApprovalDecision(ap);
    return n;
  }
}
