// Inbound/outbound messaging of the Daemon: host-message routing, the inbound
// receipt cache and rate limits, agent-to-agent messages, the mailbox funnel (`toMailbox`) and the terminal/UI markers.
// Calls up into escalation/lifecycle go through `ctx.hub`; the user-bound `message_sent` writer (`sendToUser`) stays on Daemon.

import { randomUUID } from "node:crypto";
import {
  AWAIT_USER_KIND,
  MESSAGE_FAILED_JOURNAL_REASON_MAX,
  MESSAGE_FAILED_SUBJECT_MAX,
  STEERED_KIND,
  USER_ESC_KIND,
  initialSettle,
  settleStep,
} from "@pomtree/core";
import type {
  AgentId,
  AgentRecord,
  Delivered,
  Escalation,
  JournalEntry,
  JsonValue,
  MessageFailedBody,
  MessageKind,
  MessagingChannel,
  MessagingSender,
  OutboxEntry,
  Signal,
} from "@pomtree/core";
import { parseApprovalReply } from "../approvals.ts";
import type { ActionResult, ChannelAction, InboundMessage, MessageReceipt } from "../daemon-types.ts";
import { MAX_INBOUND_RECEIPTS, clipText, sleep } from "../daemon-util.ts";
import { LifecycleError, agentIdFor } from "../lifecycle.ts";
import { relayOf } from "../to-user.ts";
import type { DaemonCtx } from "./ctx.ts";
import type { Tree } from "./tree.ts";

// Qualified workflow name: <namespace>/<name>, lowercase, so one name maps to one registered definition.
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;
const LAUNCH_INPUT_MAX = 64 * 1024; // serialized UTF-8 bytes of a launch input (JSON.stringify does not escape non-ASCII)

// Strict JSON only: plain objects, arrays, strings, booleans, null and finite numbers, bounded depth (a cycle fails the bound), so the
// input is storable exactly as sent. undefined, functions, NaN and Infinity are refused.
function isJsonValue(v: unknown, depth = 0): v is JsonValue {
  if (depth > 64) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

export class Messaging {
  // In-memory only; keys the user-escalation marker (with bootNonce).
  private signalSeq = 0;
  // TODO(rule6): per-boot nonce. signalSeq restarts at 0, so keys carry the nonce to avoid colliding with (and being
  // deduped against) pre-restart keys. Daemon reads it too (probe, adopt and pending-reason keys).
  readonly bootNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
  // TODO(rule6): cache of routed inbound outcomes so a retried inbound never double-routes; evicted at MAX_INBOUND_RECEIPTS.
  // Every routing step is keyed `msg:<channel>:<key>:*` in the stores, so after a restart a retry re-runs the same idempotent
  // steps and rebuilds the receipt. `inboundTimes` holds sliding-window timestamps for the three rate limits, pruned per key.
  readonly inboundReceipts = new Map<string, MessageReceipt>();
  private readonly inboundTimes = new Map<string, number[]>();

  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;

  constructor(ctx: DaemonCtx, tree: Tree) {
    this.ctx = ctx;
    this.tree = tree;
  }

  // Peek-only: the inbox is never consumed by a read. Signals leave it through Mailbox.ack (POST /inbox/ack).
  async inbox(id: AgentId, o: { waitMs?: number }): Promise<Delivered[]> {
    const m = this.ctx.deps.mailbox;
    const deadline = this.ctx.now() + Math.min(o.waitMs ?? 0, 30000);
    let kicked = false;
    const unkick = this.ctx.hub.kicks.onKick(id, () => (kicked = true));
    try {
      while (!kicked && this.ctx.now() < deadline && !(await m.peek(id)).length) await sleep(25);
    } finally {
      unkick();
    }
    return m.peek(id);
  }

  // `pomtree peers`: the agents the caller can address by default — itself, its parent, and its children.
  // Wider reach (siblings, the root supervisor, arbitrary ids) is a
  // policy decision left to TODO(authz-escalation). Only id/name/state are returned (no task/budget/sandbox).
  async peers(caller: AgentId): Promise<Pick<AgentRecord, "id" | "name" | "state">[]> {
    return (await this.tree.addressable(caller)).map((a) => ({ id: a.id, name: a.name, state: a.state }));
  }

  // A reaped agent's mailbox is closed (the store rejects the send as a plain Error, which would surface as a 500): refuse it as a 409.
  async assertReceivable(to: AgentId): Promise<void> {
    if ((await this.ctx.deps.registry.get(to))?.state === "reaped")
      throw new LifecycleError(409, `agent ${to} is reaped; it cannot receive messages (its work was collected), so message a live agent instead`);
  }

  // `pomtree send`: the caller supplies its own generation (reading it from the registry would compare the fence with
  // itself) so the mailbox rejects a stale sender. The recipient must be self/parent/child; the key includes the
  // recipient so the same body to two peers is not deduped.
  async sendMessage(from: AgentId, to: AgentId, body: string, generation: number, idempotencyKey: string): Promise<Signal> {
    const d = this.ctx.deps;
    if (!(await d.registry.get(from))) throw new LifecycleError(404, `no such sender: ${from}`);
    if (!(await d.registry.get(to))) throw new LifecycleError(404, `no such peer: ${to}`);
    if (!(await this.tree.canAddress(from, to))) throw new LifecycleError(404, `no such peer: ${to}`);
    await this.assertReceivable(to);
    const signal: Signal = { kind: "message", from, body };
    const sender = (await d.registry.get(from))!;
    if (!(await this.toMailbox(sender, to, signal, `${from}:${to}:${idempotencyKey}`, generation))) return signal; // relayed to the user: nobody to wake
    // Wake a yielded recipient whose wait condition is satisfied by this message.
    await d.orchestrator.wake(to, signal);
    return signal;
  }

  // A messaging adapter's dead-lettered outbound message: journaled on the root so the
  // daemon's audit trail shows it. Keyed by the caller's key so a replay adds no duplicate. The route accepts a reason up to
  // MESSAGE_FAILED_REASON_MAX characters; the journal keeps the first MESSAGE_FAILED_JOURNAL_REASON_MAX of it (core messaging.ts).
  async messageFailed(f: MessageFailedBody): Promise<void> {
    const root = await this.ctx.hub.root.root();
    const purpose: MessageKind = (["ask", "alert", "status", "report"] as const).includes(f.purpose) ? f.purpose : "alert";
    await this.ctx.record(
      root,
      {
        kind: "message_failed",
        channel: f.channel,
        purpose,
        subject: clipText(String(f.subject), MESSAGE_FAILED_SUBJECT_MAX),
        reason: clipText(String(f.reason), MESSAGE_FAILED_JOURNAL_REASON_MAX),
        ...(f.attempts !== undefined && { attempts: f.attempts }),
      },
      `message_failed:${f.channel}:${f.idempotencyKey}`,
    );
  }

  private rateLimited(key: string, limit: number, windowMs: number, now: number): boolean {
    const cutoff = now - windowMs;
    const kept = (this.inboundTimes.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= limit) {
      this.inboundTimes.set(key, kept);
      return true;
    }
    kept.push(now);
    this.inboundTimes.set(key, kept);
    return false;
  }

  // Adapter-facing entry: an inbound host message (POST /v1/messages, POST /v1/ui/reply) mapped onto the ONE action core.
  // Routing precedence is unchanged: replyTo, then to (intent cancel/status/signal), then intent=spawn. Never throws on a
  // routed failure: every outcome is a receipt (HTTP 201), rejected ones included.
  async receiveMessage(msg: InboundMessage): Promise<MessageReceipt> {
    // The message's channel is the channel of its sender: a mismatch is a spoof (e.g. a discord message claiming rank cli). Rejected
    // before any state change or audit row.
    if (msg.sender.channel !== msg.channel) return { kind: "rejected", reason: `sender channel ${msg.sender.channel} does not match channel ${msg.channel}` };
    let action: ChannelAction;
    if (msg.intent === "launch" && (msg.replyTo || msg.to)) return { kind: "rejected", reason: "launch takes no replyTo or to" };
    if (msg.intent === "launch") action = { kind: "launch", workflow: msg.workflow ?? "", input: msg.input ?? {} };
    else if (msg.replyTo) action = { kind: "answer", replyTo: msg.replyTo, body: msg.body, ...(msg.pass && { pass: true }) };
    else if (msg.to)
      action = { kind: msg.intent === "cancel" ? "cancel" : msg.intent === "status" ? "status" : "signal", to: msg.to, body: msg.body } as ChannelAction;
    else if (msg.intent === "spawn") action = { kind: "spawn", request: { name: "msg", task: msg.body } };
    else {
      // No route: nothing to authorize, but an unconfigured channel is still reported as such first.
      if (!this.ctx.deps.channels.inbound().includes(msg.channel)) return { kind: "rejected", reason: `channel ${msg.channel} is not configured` };
      return { kind: "rejected", reason: "no route: set replyTo, to, intent=spawn, or intent=launch" };
    }
    const out = await this.performAction(msg.sender, action, msg.idempotencyKey, { msg });
    return out.kind === "rejected" ? { kind: "rejected", reason: out.reason } : out.receipt;
  }

  // THE action core (TODO(msg-authz)): every WRITE a human makes (answer, pass, decide, signal, spawn, cancel, status), whatever the
  // channel (ui, cli = operator token, discord, ...), runs: validate -> authorize -> rate limit -> audit -> delegate to the
  // unchanged escalation/lifecycle/mailbox calls. Rank comes from the channel registry (channels.ts):
  //   operator rank (ui session, operator token): always allowed (no allowlist lookup), ALWAYS audited, exempt from the rate limits
  //   and from POMTREED_CHAT_APPROVAL (an emergency cancel is never throttled or held). THE OPERATOR TOKEN MUST NEVER BE GIVEN TO AN ADAPTER.
  //   chat rank: authorizeInbound allowlist, rate limits (20/min per sender, 100/min global, 10 ask-answers/hour per agent), chat approval.
  // `raw` is the operator REST shape (the five operator routes): the caller's key is used as-is for each step, the native
  // result comes back in `value`, and errors propagate (LifecycleError carries its status) instead of becoming rejected receipts;
  // non-raw (receiveMessage) is idempotent by key via remembered receipts and never throws on a routed failure. Rate limits run
  // after validation so a rejected attempt never consumes a slot; rejections are not remembered, so a rate-limited one can be
  // retried with the same key. Audit row: `message_received`, keyed `msg:<channel>:<key>` (channel-scoped, so a key reused by another
  // channel or route never dedupes this row away), journaled on the TARGET agent for a signal (the settle fold reads it as "a human
  // message to this agent") and on the root for every other action.
  async performAction(
    actor: MessagingSender,
    action: ChannelAction,
    key: string | undefined,
    opts: { raw?: boolean; msg?: InboundMessage } = {},
  ): Promise<ActionResult> {
    const d = this.ctx.deps;
    const raw = opts.raw === true;
    const rejected = (reason: string, status?: number): ActionResult => ({ kind: "rejected", reason, ...(status !== undefined && { status }) });
    const cacheKey = `${actor.channel}\0${key}`;
    // Launch never replays from the receipt cache: every retry re-runs sender auth, the toggle, rate limits and approval, and the
    // host callback decides (same key and same workflow/input is the host's replay; a different one is its 409 conflict).
    if (!raw && action.kind !== "launch") {
      const prior = this.inboundReceipts.get(cacheKey);
      if (prior) return { kind: "ok", receipt: prior };
    }
    const entry = d.channels.get(actor.channel);
    if (!entry || (!raw && !entry.inbound)) return rejected(`channel ${actor.channel} is not configured`);
    if (raw && entry.rank !== "operator") return rejected("the raw action shape is operator-rank only", 403);
    // Invariant: an adapter (chat-kind) entry is never operator rank. Operator rank is the in-daemon/operator entries only, and
    // those reach here through the raw operator routes or the ui/cli wrappers (receiveMessage with the ui channel).
    if (entry.rank === "operator" && entry.kind === "adapter") throw new Error(`channel ${actor.channel} is an adapter and cannot carry operator rank`);
    const operatorRank = entry.rank === "operator" && entry.kind !== "adapter";
    const route = action.kind === "decide" ? "answer" : action.kind;
    const scope = `msg:${actor.channel}:${key}`;
    const auditKey = `msg:${actor.channel}:${key ?? randomUUID()}`;
    const step = (suffix: string): string | undefined => (raw ? key : `${scope}${suffix}`);
    const mkey = raw ? `msg:${key}` : scope; // mailbox/wake keys: the operator (raw) keys are unchanged

    // TODO(channels-core-fail-closed): refuse chat-rank actions when no authorizeInbound hook is installed. Current behavior:
    // without the hook the per-sender check is skipped for chat rank (fail-open); only the main.ts boot check refuses.
    // Per-sender authorization runs before any rate-limit slot is taken, so unauthorized floods cannot lock out the real answer.
    // Operator rank skips the allowlist: the credential itself (operator token / UI cookie) is the authority.
    if (!operatorRank && d.authorizeInbound) {
      const synth: InboundMessage = opts.msg ?? {
        channel: actor.channel,
        sender: actor,
        body: "body" in action ? action.body : "",
        idempotencyKey: key ?? "",
        ...(action.kind === "answer" && { replyTo: action.replyTo }),
        ...("to" in action && { to: action.to }),
        ...(action.kind === "spawn" && { intent: "spawn" as const }),
        ...(action.kind === "cancel" && { intent: "cancel" as const }),
        ...(action.kind === "status" && { intent: "status" as const }),
        ...(action.kind === "launch" && { intent: "launch" as const, workflow: action.workflow, input: action.input }),
      };
      if (!(await d.authorizeInbound(synth, route))) return rejected(`sender ${actor.channel}:${actor.sender} is not authorized to ${route}`, 403);
    }
    if (!operatorRank && action.kind === "decide" && action.grantMicros !== undefined) return rejected("grantMicros is operator-only", 403);

    // Validate the route before consuming any rate-limit slot.
    let esc: Escalation | null = null;
    let approvalReply: { id: string; decision: "approve" | "deny" | "pass"; why: string; grantMicros?: number } | null = null;
    if (action.kind === "answer" || action.kind === "decide") {
      const id = action.kind === "answer" ? action.replyTo : action.id;
      // An escalation goes out on every escalation channel, so only those channels may answer it. The operator-token channel is
      // not a delivery channel and answers independent of channel configuration (a zero-channel config is answerable that way).
      if (!raw && entry.kind !== "operator" && !entry.outbound) {
        const out = d.channels.outbound();
        return rejected(`escalations are answered on channel ${out.join(", ") || "(none configured)"}`);
      }
      if (raw && action.kind === "answer" && !action.pass) esc = await d.escalations.get(id); // the late-answer refusal below; the route already 404s a missing ask
      if (!raw) {
        if (action.kind === "answer") esc = await d.escalations.get(id);
        if (!esc && d.approvals) {
          const ap = await d.approvals.get(id);
          if (ap) {
            const decision = action.kind === "decide" ? action.decision : action.pass ? "pass" : parseApprovalReply(action.body);
            if (!decision) return rejected("reply approve or deny");
            if (ap.state !== "pending") return rejected("already decided");
            approvalReply = {
              id: ap.id,
              decision,
              why: action.kind === "decide" ? action.why : action.body,
              ...(action.kind === "decide" && action.grantMicros !== undefined && { grantMicros: action.grantMicros }),
            };
          }
        }
        if (!esc && !approvalReply) return rejected(`unknown escalation ${id}`);
      } else if (action.kind === "decide") {
        approvalReply = { id, decision: action.decision, why: action.why, ...(action.grantMicros !== undefined && { grantMicros: action.grantMicros }) };
      }
      if (esc && esc.state === "answered" && action.kind === "answer") {
        // A replay of the winning answer still finishes its idempotent journal+send steps (a crash between
        // the store write and those steps must not lose the answer); a different answer loses.
        const by = esc.answeredBy;
        const replay = !action.pass && by != null && by.channel === actor.channel && by.sender === actor.sender && esc.answer === action.body;
        if (!replay)
          return raw
            ? rejected(
                `escalation ${id} was already answered by ${by ? `${by.channel}:${by.sender}` : "another sender"}; your answer was not applied and the asker never sees it. Send the agent a message if it needs more.`,
                409,
              )
            : rejected("already answered");
      }
    } else if (action.kind === "signal" || action.kind === "cancel" || action.kind === "status") {
      if (!(await d.registry.get(action.to))) {
        if (raw) throw new LifecycleError(404, `no such agent: ${action.to}`);
        return rejected("unknown agent");
      }
      if (raw && action.kind === "signal" && action.mode === "interrupt") {
        const t = (await d.registry.get(action.to))!;
        // A replay of an already-delivered message returns its recorded outcome even though the agent has since exited.
        if ((t.state === "exited" || t.state === "reaped") && !(await this.ctx.hub.ops.find(t.id, "msg", key)))
          throw new LifecycleError(409, `agent is ${t.state}; cannot interrupt`);
      }
    } else if (!raw && !operatorRank && !d.messagingAllowSpawn) {
      return rejected("spawn intent is not allowed");
    }

    // Launch: host validation applies to every rank (before any slot is taken); the chat allowlist (default deny) is chat-only.
    if (action.kind === "launch") {
      if (!WORKFLOW_NAME.test(action.workflow)) return rejected("workflow must be <namespace>/<name> (lowercase letters, digits, - or _)", 400);
      if (!isJsonValue(action.input) || Buffer.byteLength(JSON.stringify(action.input), "utf8") > LAUNCH_INPUT_MAX)
        return rejected(`input must be JSON no larger than ${LAUNCH_INPUT_MAX} bytes`, 400);
      if (action.budgetMicros !== undefined && !(Number.isInteger(action.budgetMicros) && action.budgetMicros >= 1))
        return rejected("budgetMicros must be a positive integer", 400);
      if (action.deadlineMs !== undefined && !(Number.isFinite(action.deadlineMs) && action.deadlineMs >= 0))
        return rejected("deadlineMs must be a non-negative number", 400);
      if (action.deadlineMs === 0 && !operatorRank) return rejected("an unlimited deadline requires operator scope", 403);
      if (!operatorRank && !(await d.allowChatWorkflow?.({ channel: actor.channel, sender: actor }, action.workflow)))
        return rejected(`workflow ${action.workflow} is not launchable from ${actor.channel}`, 403);
    }

    // Rate limits gate accepted routes of chat rank only (a rejected message never counts toward them).
    if (!operatorRank) {
      const now = this.ctx.now();
      if (this.rateLimited("global", 100, 60_000, now)) return rejected("global rate limit exceeded", 429);
      if (this.rateLimited(`sender:${actor.channel}:${actor.sender}`, 20, 60_000, now)) return rejected("sender rate limit exceeded", 429);
      if (esc && this.rateLimited(`ask:${esc.agent}`, 10, 3_600_000, now)) return rejected("ask rate limit exceeded", 429);
    }

    // Durable audit of every accepted action, every rank; keyed so a replay adds no duplicate entry.
    const auditBody =
      action.kind === "spawn"
        ? action.request.task
        : action.kind === "launch"
          ? action.workflow
          : action.kind === "decide"
            ? action.decision
            : "body" in action
              ? action.body
              : "";
    const to = action.kind === "answer" || action.kind === "decide" || action.kind === "spawn" || action.kind === "launch" ? null : action.to;
    const auditOn = action.kind === "signal" ? ((await d.registry.get(action.to)) as AgentRecord) : await this.ctx.hub.root.root();
    await this.ctx.record(
      auditOn,
      {
        kind: "message_received",
        channel: actor.channel,
        from: actor,
        to,
        body: auditBody,
        ...(action.kind === "signal" && action.mode === "interrupt" && { interrupt: true as const }),
      },
      auditKey,
    );

    const ok = (receipt: MessageReceipt, value?: unknown): ActionResult => ({
      kind: "ok",
      receipt: receipt.kind === "rejected" || raw || action.kind === "launch" ? receipt : this.rememberReceipt(cacheKey, receipt),
      ...(value !== undefined && { value }),
    });
    const fail = (e: unknown): ActionResult => {
      if (raw) throw e;
      return rejected(e instanceof Error ? e.message : String(e));
    };
    const who = `${actor.channel}:${actor.sender}`;

    if (approvalReply) {
      try {
        const ap = await this.ctx.hub.escalation.decideApproval(approvalReply.id, approvalReply.decision, who, approvalReply.why, step(":decide")!, {
          ...(approvalReply.grantMicros !== undefined && { grantMicros: approvalReply.grantMicros }),
        });
        return ok({ kind: "answered", escalation: approvalReply.id }, ap);
      } catch (e) {
        if (raw) throw e;
        // A decision that lost the race to another channel is the same "already decided" receipt as the pre-check.
        return rejected(
          e instanceof LifecycleError && e.status === 409 && /already/.test(e.message) ? "already decided" : e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (action.kind === "decide") return rejected(`unknown approval ${action.id}`);
    if (action.kind === "answer") {
      try {
        let value: Escalation;
        if (action.pass) value = await this.ctx.hub.escalation.passEscalation(action.replyTo, null, step(":pass")!);
        else {
          value = await this.ctx.hub.escalation.answerEscalation(action.replyTo, action.body, actor, step(":answer")!);
          // Two channels raced past the pre-check: the store kept the first answer, so the loser is told it lost.
          if (
            !raw &&
            value.answeredBy &&
            (value.answeredBy.channel !== actor.channel || value.answeredBy.sender !== actor.sender || value.answer !== action.body)
          )
            return rejected("already answered");
        }
        return ok({ kind: "answered", escalation: action.replyTo }, value);
      } catch (e) {
        return fail(e);
      }
    }
    if (action.kind === "status") {
      const target = (await d.registry.get(action.to))!;
      return ok({ kind: "status", agent: target.id, state: target.state, ...(target.exit ? { exit: target.exit } : {}) });
    }
    if (action.kind === "cancel") {
      try {
        if (!operatorRank && d.chatApproval?.("cancel"))
          await this.ctx.hub.escalation.requireApproval(await this.ctx.hub.root.root(), "chat_cancel", action.to, scope);
        await this.ctx.hub.lifecycle.cancel(action.to, action.graceMs, raw ? key : scope);
        return ok({ kind: "cancelled", agent: action.to });
      } catch (e) {
        return fail(e);
      }
    }
    if (action.kind === "signal") {
      if (action.mode !== undefined) {
        // The operator message route: queue or interrupt, with its own wake/steer semantics (audit already written above).
        const value = await this.ctx.hub.operator.messageAgent(action.to, action.body, key!, action.mode, { from: actor, audited: true });
        return ok({ kind: "signaled", to: action.to }, value);
      }
      const signal: Signal = { kind: "human_message", from: actor, body: action.body };
      try {
        await this.assertReceivable(action.to);
      } catch (e) {
        return fail(e);
      }
      await d.mailbox.send(action.to, signal, `${mkey}:signal`);
      // A yielded recipient waiting on a message is woken by the inbound too.
      await this.ctx.hub.escalation.safeWake(action.to, signal, await d.registry.get(action.to), `${mkey}:wake-error`);
      return ok({ kind: "signaled", to: action.to });
    }
    if (action.kind === "launch") {
      // The host callback admits the definition as a root child, keyed by the action scope (the operator key when raw), so a retry
      // is the same launch. Chat approval is the spawn approval (chatApproval("spawn")); operator rank is not held by it.
      const launch = d.launchWorkflow;
      if (!launch) return rejected("workflow launch is not configured", 503);
      const launchKey = raw && key !== undefined ? key : scope;
      try {
        if (!operatorRank && d.chatApproval?.("spawn"))
          await this.ctx.hub.escalation.requireApproval(await this.ctx.hub.root.root(), "chat_launch", action.workflow, launchKey);
        const agent = await launch(await this.tree.rootAgentId(), {
          workflow: action.workflow,
          input: action.input,
          idempotencyKey: launchKey,
          ...(action.budgetMicros !== undefined && { budgetMicros: action.budgetMicros }),
          ...(action.deadlineMs !== undefined && { deadlineMs: action.deadlineMs }),
        });
        return ok({ kind: "launched", agent: agent.id }, agent);
      } catch (e) {
        // Raw: LifecycleError propagates with its status; anything else is a generic 500 (the detail never reaches the caller).
        if (raw) throw e instanceof LifecycleError ? e : new LifecycleError(500, "workflow launch failed");
        // Non-raw: the host's refusal (or a pending/denied approval) is a rejection the caller can retry with the same key.
        if (e instanceof LifecycleError) return rejected(e.message, e.status);
        return rejected("workflow launch failed", 500);
      }
    }
    // spawn
    const rootId = await this.tree.rootAgentId();
    const parent = action.parent ?? rootId;
    const spawnKey = raw ? key! : scope;
    try {
      if (!operatorRank && d.chatApproval?.("spawn"))
        await this.ctx.hub.escalation.requireApproval(await this.ctx.hub.root.root(), "chat_spawn", action.request.task.slice(0, 200), spawnKey);
      const child = await this.ctx.hub.lifecycle.spawn(parent, { ...action.request, idempotencyKey: spawnKey });
      return ok({ kind: "spawned", agent: child.id }, child);
    } catch (e) {
      if (raw) throw e;
      // After a restart a replayed, already-completed inbound spawn is "already ran"
      // (409); the deterministic id still names the agent, so the retry gets its receipt, not an error.
      if (e instanceof LifecycleError && (e.status === 403 || e.status === 503 || (e.status === 409 && !e.message.startsWith("already ran")))) {
        return rejected(e.message); // approval denied or still pending: retryable with the same key
      }
      if (!(e instanceof LifecycleError && e.status === 409)) throw e;
      return ok({ kind: "spawned", agent: agentIdFor(parent, spawnKey) });
    }
  }

  private rememberReceipt(key: string, receipt: MessageReceipt): MessageReceipt {
    if (this.inboundReceipts.size >= MAX_INBOUND_RECEIPTS) {
      const oldest = this.inboundReceipts.keys().next().value;
      if (oldest !== undefined) this.inboundReceipts.delete(oldest);
    }
    this.inboundReceipts.set(key, receipt);
    return receipt;
  }

  // Outbox poll for adapters: `message_sent` journal entries for a channel with seq >= from (cursor), each a core OutboxEntry.
  // TODO(live-resilient): reads the whole journal per poll; needs an indexed `message_sent` read.
  async outbox(o: { channel: MessagingChannel; from?: number }): Promise<(JournalEntry & OutboxEntry)[]> {
    const entries = await this.ctx.deps.journal.read({ from: o.from ?? 0 });
    return entries.filter((e): e is JournalEntry & OutboxEntry => e.payload.kind === "message_sent" && e.payload.channel === o.channel);
  }

  // The terminal hub forwarded a bare Esc byte from a viewer: journal it (the settle fold's corroboration of a user abort).
  // Called only for writes that are exactly 0x1b, so the journal cost is one entry per Esc keypress.
  async userEsc(agent: AgentId): Promise<void> {
    const a = await this.ctx.deps.registry.get(agent);
    if (!a || a.state !== "running") return;
    await this.ctx.record(a, { kind: USER_ESC_KIND } as never, `${agent}:${a.generation}:user-esc:${this.bootNonce}:${++this.signalSeq}`);
  }

  // TODO(interactive-mode): replace await-user and ask --wait with a sticky mode. Current behavior: await-user is gated.
  // await-user is accepted only while a typed, chat or operator message is unanswered, so a fresh spawn task cannot use it.
  // `pomtree await-user`: the agent declares its next settle is a wait for the human's reply. Accepted only while an interactive
  // message (TTY-typed or operator) is unanswered (core `settleStep`); consumed by the settle that follows (or withdrawn by a
  // newer human message). A retry with the same key is accepted again without a second entry.
  async awaitUser(agent: AgentId, key: string): Promise<{ accepted: true }> {
    const a = await this.ctx.deps.registry.get(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (a.state !== "running") throw new LifecycleError(409, `agent is ${a.state}, not running`);
    let st = initialSettle;
    for (const e of await this.ctx.deps.journal.read({ agent })) {
      if (e.payload.kind === AWAIT_USER_KIND && (e.payload as { key?: string }).key === key) return { accepted: true };
      st = settleStep(st, e);
    }
    if (!st.human)
      throw new LifecycleError(
        409,
        "await-user refused: no unanswered message from a human (typed, chat or operator) since your last await-user or wait. Valid exits are: keep working, `pomtree result`, or `pomtree yield`.",
      );
    await this.ctx.record(a, { kind: AWAIT_USER_KIND, key } as never, `${agent}:${a.generation}:await-user:${key}`);
    return { accepted: true };
  }

  // The mailbox extension acked injected signals: the agent was handed work, which ends a wait before its first output.
  async steered(agent: AgentId, count: number, key: string): Promise<void> {
    const a = await this.ctx.deps.registry.get(agent);
    if (a) await this.ctx.record(a, { kind: STEERED_KIND, count } as never, `${agent}:steered:${key}`);
  }

  hasUserChannel(): boolean {
    return this.ctx.deps.channels.hasOutbound();
  }

  // The ONE place a signal is enqueued to an agent's mailbox (notifyParent, sendMessage). Root's inbox is a passthrough
  // to the user: a child_exited or message addressed to root is relayed as a keyed user message on the SENDER's journal
  // (the child is reaped right after) and never enqueued, so root's mailbox never accumulates. Returns false when relayed.
  // With no escalation channel configured sendToUser no-ops: the signal is dropped.
  // TODO(mainflow): relayed lines are unfiltered (no rate limit or push policy); every child exit and message to root reaches the user.
  async toMailbox(sender: AgentRecord, to: AgentId, signal: Signal, key: string, generation?: number): Promise<boolean> {
    const relay = to === (await this.tree.rootAgentId()) ? relayOf(signal) : undefined;
    if (!relay) {
      await this.ctx.deps.mailbox.send(to, signal, key, generation);
      return true;
    }
    const { purpose, subject, replyTo, ...extra } = relay;
    await this.ctx.hub.user.sendToUser(sender, purpose, subject, key, replyTo, extra);
    return false;
  }
}
