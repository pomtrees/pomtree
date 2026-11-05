import type { EscalationId } from "@pomtree/core";
import type {
  DiscordButton,
  DiscordInteraction,
  DeadLetter,
  DiscordInbound,
  InboundBody,
  DiscordTransport,
  MessageReceipt,
  OutboxStore,
  PomtreedClient,
} from "./types.ts";
import { DiscordSendError } from "./types.ts";
import { nextCursor } from "./cursor.ts";
import { DEFAULT_ALERT_COALESCE_WINDOW_MS, DEFAULT_MAX_ATTEMPTS, MAX_DEAD_LETTERS, planOutbox } from "./outbox.ts";
import { actionBody, askButtons, choiceKey, decodeAction, isTruncatedLabel, renderHostBody, renderOutbound, renderReceipt, withStatus } from "./render.ts";
import { inboundBody } from "./routing.ts";
import { parseMessage } from "./grammar.ts";
import { errorCode, errorText } from "./pairings.ts";
import type { PairingStore } from "./pairings.ts";

export interface AdapterDeps {
  pomtreed: PomtreedClient;
  discord: DiscordTransport;
  outbox: OutboxStore;
  channelId: string;
  // Sender allowlist (Discord user ids). Empty/absent = deny everyone (default-deny); the
  // reply-target check still applies to whether a message counts as an escalation answer.
  allowedSenders?: readonly string[];
  // Per-agent answer/command allowlists (agent id -> Discord user ids). An agent with an entry
  // accepts answers, `!tell` and `!cancel` only from the listed senders; others fall back to
  // `allowedSenders` alone. TODO(messaging): pomtreed does not enforce this; adapter-side only. The
  // message->agent map is in memory: after a restart an unresolved reply owner is denied unless
  // the sender is on every list.
  agentAllowlists?: Readonly<Record<string, readonly string[]>>;
  // Persisted sender pairings (see pairings.ts). Absent = pairings live in memory only (tests).
  pairings?: PairingStore;
  // Render a Pass button on asks and approvals. TODO(mainflow): off by default until the live check; pomtreed's
  // POST /v1/messages reads `pass` (packages/pomtreed/src/api.ts).
  passButton?: boolean;
  maxAttempts?: number; // retry cap before dead-lettering an entry (default DEFAULT_MAX_ATTEMPTS)
  alertCoalesceWindowMs?: number; // alerts per agent coalesce within this window (default 60s)
  now?: () => number; // injectable clock for Retry-After and dead-letter timestamps
  log?: (line: string) => void;
}

export interface PollResult {
  sent: number;
  cursor: number;
  deadLettered: number;
}

// Orchestrates the two directions over injected boundaries (no fs, socket, or Discord coupling).
// The agent-id shape checked before a host read builds its URL: letters, digits, `_` and `-`, starting with an
// alphanumeric, at most 64 chars. Rejects `.`, `..`, empty and oversized ids without a network call.
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const isPairingButton = (customId: string): boolean => customId.startsWith("pair:");

export class DiscordAdapter {
  private readonly deps: AdapterDeps;
  // Discord message id -> escalation id for outbound messages that carried `replyTo`. An inbound
  // reply referencing one of these ids correlates directly, with no `es-…` text parse; the text
  // parse remains the fallback for messages not sent (or not yet seen) by this adapter.
  private readonly replyToById = new Map<string, EscalationId>();
  // Sender pairing: ids that asked `!pair` (pending) and ids approved by a configured sender.
  private readonly pending = new Map<string, string | undefined>();
  private readonly paired = new Set<string>();
  private readonly agentByMessage = new Map<string, string>(); // Discord message id -> owning agent
  private readonly optionsByMessage = new Map<string, string[]>(); // Discord message id -> the option buttons' answers
  // Pairing load (startup) and the serialized chain of pairing writes. A failed load fails closed:
  // no stored pairings are admitted, and approvals are refused so the unreadable file is not overwritten.
  private readonly ready: Promise<void>;
  private loadFailed = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(deps: AdapterDeps) {
    this.deps = deps;
    this.ready = deps.pairings ? this.loadPairings(deps.pairings) : Promise.resolve();
  }

  private async loadPairings(store: PairingStore): Promise<void> {
    try {
      for (const id of await store.read()) this.paired.add(id);
    } catch (e) {
      this.loadFailed = true;
      this.deps.log?.(`pairings load failed; no stored pairings admitted: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // Poll once: read the outbox state, fetch the outbox, send each planned delivery in seq order.
  // A successful send advances the cursor past all its seqs; a failed send increments per-seq
  // attempt counters and either dead-letters the entry (after the cap) so later entries still
  // send, or stops the poll to retry next time. A Discord Retry-After backoff pauses the whole
  // outbox until the deadline.
  async pollOnce(): Promise<PollResult> {
    const d = this.deps;
    const now = this.now();
    const maxAttempts = d.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const windowMs = d.alertCoalesceWindowMs ?? DEFAULT_ALERT_COALESCE_WINDOW_MS;

    const state = await d.outbox.read();
    // Honor an outstanding Retry-After backoff before sending anything.
    if (state.retryAfter !== null && state.retryAfter > now) {
      return { sent: 0, cursor: state.cursor, deadLettered: 0 };
    }

    const entries = [...(await d.pomtreed.outbox(state.cursor))].sort((a, b) => a.seq - b.seq);
    const units = planOutbox(entries, windowMs);

    let sent = 0;
    let deadLettered = 0;
    let cursor = state.cursor;
    // A past deadline has expired: clear it (and persist the cleared value below).
    let retryAfter: number | null = null;
    const attempts = { ...state.attempts };
    const deadLetters = [...state.deadLetters];
    let dirty = state.retryAfter !== null;

    for (const unit of units) {
      if (retryAfter !== null && retryAfter > now) break;

      try {
        // Buttons ride only on asks, and only when the transport can receive the presses.
        const buttons = unit.purpose === "ask" && d.discord.onInteraction ? askButtons(unit, d.passButton) : [];
        const messageId = await d.discord.send(d.channelId, unit.content, ...(buttons.length ? [{ buttons }] : []));
        if (unit.replyTo && messageId) this.replyToById.set(messageId, unit.replyTo);
        if (unit.agent && messageId) this.agentByMessage.set(messageId, unit.agent);
        if (unit.options && messageId && buttons.some((b) => decodeAction(b.customId)?.choice.kind === "option"))
          this.optionsByMessage.set(messageId, unit.options);
        for (const seq of unit.seqs) delete attempts[String(seq)];
        cursor = nextCursor(cursor, unit.seqs[unit.seqs.length - 1]!);
        sent += 1;
        dirty = true;
      } catch (e) {
        const err = e instanceof DiscordSendError ? e : new DiscordSendError(0, null, e instanceof Error ? e.message : String(e));
        if (err.retryAfterMs !== null) {
          // Discord asked us to back off: honor it and stop. This does not count toward the retry cap.
          retryAfter = now + err.retryAfterMs;
          dirty = true;
          d.log?.(`outbound retry-after ${err.retryAfterMs}ms (status ${err.status})`);
          break;
        }
        for (const seq of unit.seqs) attempts[String(seq)] = (attempts[String(seq)] ?? 0) + 1;
        dirty = true;
        const maxCount = Math.max(...unit.seqs.map((seq) => attempts[String(seq)] ?? 0));
        if (maxCount >= maxAttempts) {
          const dead: DeadLetter = {
            seqs: unit.seqs,
            agent: unit.agent ?? "",
            subject: unit.content,
            reason: err.status !== 0 ? `discord HTTP ${err.status}: ${err.message}` : err.message,
            at: now,
          };
          deadLetters.push(dead);
          if (deadLetters.length > MAX_DEAD_LETTERS) deadLetters.splice(0, deadLetters.length - MAX_DEAD_LETTERS);
          for (const seq of unit.seqs) delete attempts[String(seq)];
          cursor = nextCursor(cursor, unit.seqs[unit.seqs.length - 1]!);
          deadLettered += 1;
          d.log?.(`message_failed ${JSON.stringify(dead)}`);
          if (d.pomtreed.messageFailed) {
            // Best effort: the dead letter is already durable in the cursor file; a failed report must not wedge the poll.
            try {
              await d.pomtreed.messageFailed({
                channel: "discord",
                purpose: unit.purpose,
                subject: unit.content.slice(0, 1000),
                reason: dead.reason,
                attempts: maxCount,
                idempotencyKey: `dl:${unit.seqs[0]}-${unit.seqs[unit.seqs.length - 1]}`,
              });
            } catch (re) {
              d.log?.(`message_failed report failed: ${re instanceof Error ? re.message : String(re)}`);
            }
          }
        } else {
          // Below the retry cap: leave the cursor before this entry and retry on the next poll.
          break;
        }
      }
    }

    if (dirty) await d.outbox.write({ cursor, attempts, retryAfter, deadLetters });
    return { sent, cursor, deadLettered };
  }

  // Handle one inbound Discord message: push it to pomtreed, post the receipt back to Discord, and
  // return the receipt. A failed pomtreed POST rethrows so the transport does not advance its inbound
  // cursor and the message is re-delivered (at-least-once, idempotent by message id).
  async handleInbound(msg: DiscordInbound): Promise<MessageReceipt> {
    const d = this.deps;
    await this.ready;
    if (msg.body.trim() === "!pair" && !msg.replyToId && !this.isAllowedSender(msg.authorId)) {
      return this.requestPairing(msg);
    }
    const approve = /^!approve\s+(\S+)\s*$/.exec(msg.body.trim());
    if (approve && this.isConfiguredSender(msg.authorId)) {
      const r = await this.approve(approve[1]!);
      return this.reject(msg, r);
    }
    if (!this.isAllowedSender(msg.authorId)) {
      const receipt: MessageReceipt = { kind: "rejected", reason: "sender not allowed" };
      await this.ack(receipt);
      d.log?.(`inbound ${msg.id}: ${JSON.stringify(receipt)}`);
      return receipt;
    }
    const direct = msg.replyToId ? this.replyToById.get(msg.replyToId) : undefined;
    const target = msg.replyToId ? this.agentByMessage.get(msg.replyToId) : undefined;
    if (target && !this.mayAddress(target, msg.authorId)) {
      return this.reject(msg, `sender not allowed to answer ${target}`);
    }
    // Fail closed (see agentAllowlists above): after a restart a reply's owner is unknown.
    if (msg.replyToId && !target && !this.mayAddressAny(msg.authorId)) {
      return this.reject(msg, "sender not allowed to answer (reply owner unknown)");
    }
    // A fresh (non-reply) message starting with `!` is an operator command routed via pomtreed's
    // existing inbound routes: spawn -> intent=spawn, tell -> to+intent=signal.
    if (!msg.replyToId && msg.body.trimStart().startsWith("!")) {
      const parsed = parseMessage(msg.body);
      if (parsed.kind === "invalid") return this.reject(msg, `!${parsed.command}: ${parsed.reason}`);
      if (parsed.kind === "command") {
        const i = parsed.intent;
        if (i.kind === "spawn") {
          return this.forward(msg, { ...inboundBody(msg), body: i.task, intent: "spawn" });
        }
        if (i.kind === "tell") {
          if (!this.mayAddress(i.agent, msg.authorId)) return this.reject(msg, `sender not allowed to address ${i.agent}`);
          return this.forward(msg, { ...inboundBody(msg), body: i.body, to: i.agent, intent: "signal" });
        }
        if (i.kind === "cancel") {
          if (!this.mayAddress(i.agent, msg.authorId)) return this.reject(msg, `sender not allowed to address ${i.agent}`);
          return this.forward(msg, { ...inboundBody(msg), body: msg.body.trim(), to: i.agent, intent: "cancel" });
        }
        if (i.kind === "status") {
          if (!i.agent) return this.reject(msg, "!status needs an agent: !status AGENT");
          return this.forward(msg, { ...inboundBody(msg), body: msg.body.trim(), to: i.agent, intent: "status" });
        }
        // No workflow logic here: the daemon checks the chat allowlist, approval and rate limits.
        if (i.kind === "launch") {
          return this.forward(msg, { ...inboundBody(msg), body: msg.body.trim(), intent: "launch", workflow: i.workflow, input: { instance: i.instance } });
        }
        if (i.kind === "ps") return this.hostRead(msg, "ps", "/agents");
        if (!i.agent) return this.reject(msg, `!${i.kind} needs an agent: !${i.kind} AGENT`);
        if (!AGENT_ID_RE.test(i.agent)) return this.reject(msg, `!${i.kind}: bad agent id (use: !${i.kind} AGENT_ID)`);
        if (!this.mayAddress(i.agent, msg.authorId)) return this.reject(msg, `sender not allowed to address ${i.agent}`);
        return this.hostRead(msg, i.kind, `/agents/${encodeURIComponent(i.agent)}/${i.kind}`);
      }
    }
    const body = inboundBody(msg, direct);
    // Only a reply to a bot-authored message may carry `replyTo`; anything else is not an
    // escalation answer, so the id is stripped before it reaches pomtreed. A direct map hit is
    // bot-authored by construction (the map only holds ids the bot itself sent), so the check is
    // needed only for the text-parsed fallback.
    if (body.replyTo && !direct && !(await this.isEscalationAnswer(msg))) {
      delete body.replyTo;
    }
    return this.forward(msg, body);
  }

  private async forward(msg: DiscordInbound, body: InboundBody): Promise<MessageReceipt> {
    const receipt = await this.deps.pomtreed.postMessage(body);
    await this.ack(receipt);
    this.deps.log?.(`inbound ${msg.id}: ${JSON.stringify(receipt)}`);
    return receipt;
  }

  private async reject(msg: DiscordInbound, reason: string): Promise<MessageReceipt> {
    const receipt: MessageReceipt = { kind: "rejected", reason };
    await this.ack(receipt);
    this.deps.log?.(`inbound ${msg.id}: ${JSON.stringify(receipt)}`);
    return receipt;
  }

  // Read-only host queries (`!ps`, `!budget`, `!report`); the sender is already allowlisted and
  // pomtreed re-checks it. The output is the message itself (no separate receipt), so the human sees
  // it once; the returned receipt is a local-answer marker, like the pairing reply.
  private async hostRead(msg: DiscordInbound, verb: "ps" | "budget" | "report", path: string): Promise<MessageReceipt> {
    const d = this.deps;
    let text: string;
    try {
      const res = await d.pomtreed.hostRead(path, msg.authorId);
      if (res.status === 200) {
        text = renderHostBody(verb, res.body);
      } else {
        const e = (res.body as { error?: unknown } | null)?.error;
        const detail = typeof e === "string" ? e.slice(0, 200) : res.status === 404 ? "no such agent" : "";
        text = `✗ !${verb} failed: ${res.status}${detail ? ` ${detail}` : ""}`;
      }
    } catch (e) {
      d.log?.(`inbound ${msg.id} !${verb} failed: ${e instanceof Error ? e.message : String(e)}`);
      text = `✗ !${verb} failed: pomtreed unreachable`;
    }
    try {
      await d.discord.send(d.channelId, renderOutbound(verb === "report" ? "report" : "status", text));
    } catch (e) {
      d.log?.(`ack failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    d.log?.(`inbound ${msg.id}: !${verb} answered locally`);
    return { kind: "rejected", reason: `!${verb} answered locally` };
  }

  private mayAddressAny(authorId: string): boolean {
    const lists = Object.values(this.deps.agentAllowlists ?? {});
    return lists.every((l) => l.includes(authorId));
  }

  private mayAddress(agent: string, authorId: string): boolean {
    const list = this.deps.agentAllowlists?.[agent];
    return list === undefined || list.includes(authorId);
  }

  // Best-effort: post the receipt back to Discord so the human sees the outcome. A failed ack
  // must not un-commit an already-delivered message, so it is logged and swallowed.
  private async ack(receipt: MessageReceipt): Promise<void> {
    try {
      await this.deps.discord.send(this.deps.channelId, renderReceipt(receipt));
    } catch (e) {
      this.deps.log?.(`ack failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private isConfiguredSender(authorId: string): boolean {
    return !!this.deps.allowedSenders?.includes(authorId);
  }

  // An unlisted sender asks to be paired: post an Approve/Deny prompt for a configured sender.
  private async requestPairing(msg: DiscordInbound): Promise<MessageReceipt> {
    this.pending.set(msg.authorId, msg.authorName);
    const who = msg.authorName ? `${msg.authorName} (${msg.authorId})` : msg.authorId;
    try {
      await this.deps.discord.send(this.deps.channelId, `pairing request from ${who}; approve with the button or \`!approve ${msg.authorId}\``, {
        buttons: [
          { customId: `pair:approve:${msg.authorId}`, label: "Approve", style: "success" },
          { customId: `pair:deny:${msg.authorId}`, label: "Deny", style: "danger" },
        ],
      });
    } catch (e) {
      this.deps.log?.(`pairing prompt failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { kind: "rejected", reason: "pairing requested; awaiting approval" };
  }

  // Persist before admitting: a failed write leaves the sender pending and unpaired. The channel
  // reply carries only the errno code (or "write failed"); the full reason goes to the operator log.
  private async approve(id: string): Promise<string> {
    await this.ready;
    if (!this.pending.has(id)) return `no pending pairing for ${id}`;
    const store = this.deps.pairings;
    if (!store) {
      this.pending.delete(id);
      this.paired.add(id);
      return `paired ${id}`;
    }
    if (this.loadFailed) return `pairing not saved for ${id}: the pairings file could not be loaded; fix or remove the file and restart the adapter`;
    // Writes are serialized so concurrent approvals cannot overwrite each other's pairing.
    const job = this.saving.then(() => this.commitPairing(store, id));
    this.saving = job.then(
      () => {},
      () => {},
    );
    try {
      return await job;
    } catch (e) {
      this.deps.log?.(`pairing save failed for ${id}: ${errorText(e)}`);
      return `pairing not saved for ${id} (${errorCode(e)}); still pending`;
    }
  }

  // Runs inside the write chain. A deny that lands while the write is in flight removes the pending
  // entry; the write has already listed the id, so the file is rewritten without it before denying.
  private async commitPairing(store: PairingStore, id: string): Promise<string> {
    if (!this.pending.has(id)) return `denied ${id}`;
    await store.write([...this.paired, id]);
    if (!this.pending.has(id)) {
      try {
        await store.write([...this.paired]);
      } catch (e) {
        this.deps.log?.(`pairing undo failed for ${id}; the file may still list it: ${errorText(e)}`);
        return `denied ${id}, but the pairings file could not be rewritten (${errorCode(e)}); remove ${id} from it before restarting`;
      }
      return `denied ${id}`;
    }
    this.pending.delete(id);
    this.paired.add(id);
    return `paired ${id}`;
  }

  // A button press. It is acknowledged first (Discord fails the press after 3 s), then routed: a pairing button
  // (`pair:approve|deny:<id>`) or an ask/approval button (render.ts encodeAction). Returns the outcome for the log.
  async handleInteraction(i: DiscordInteraction): Promise<string> {
    try {
      await this.deps.discord.deferUpdate?.(i);
    } catch (e) {
      // The press still counts: the decision is idempotent, and a failed edit below is logged too.
      this.deps.log?.(`interaction ${i.id} defer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (isPairingButton(i.customId)) return this.handlePairingButton(i);
    return this.handleActionButton(i);
  }

  // An Approve/Deny/Pass/option press on an outbound ask. The presser must be an allowed sender who may address the
  // ask's agent (the same rules as a text reply); custom_id names only the id and the choice. The decision goes to
  // pomtreed as the reply a human would type, keyed per message, presser and choice, so a double press is one decision
  // and pomtreed answers a second presser's conflicting choice with "already decided".
  private async handleActionButton(i: DiscordInteraction): Promise<string> {
    const d = this.deps;
    await this.ready;
    const action = decodeAction(i.customId);
    if (!action) return "unknown action";
    if (!this.isAllowedSender(i.userId)) return "not allowed";
    const agent = this.agentByMessage.get(i.messageId);
    if (agent ? !this.mayAddress(agent, i.userId) : !this.mayAddressAny(i.userId)) return `not allowed to answer ${agent ?? "(owner unknown)"}`;
    // After a restart the in-memory maps are empty: the id comes from custom_id and pomtreed validates it.
    const known = this.replyToById.get(i.messageId);
    if (known && known !== action.id) return "button does not match its message";
    // An option press answers with the option's text: from memory, or after a restart from the pressed button's label
    // on the (bot-authored) message, unless the label was cut to fit.
    const options = this.optionsByMessage.get(i.messageId);
    const fromLabel = i.buttonLabel && !isTruncatedLabel(i.buttonLabel) ? i.buttonLabel : undefined;
    const body = action.choice.kind === "option" && !options ? fromLabel : actionBody(action.choice, options);
    if (body === undefined) {
      await this.editOutcome(i, "option text unavailable after a restart; reply with text", undefined);
      return "option unavailable";
    }
    const inbound: InboundBody = {
      channel: "discord",
      sender: { channel: "discord", sender: i.userId, ...(i.userName ? { name: i.userName } : {}) },
      body,
      replyTo: action.id,
      ...(action.choice.kind === "pass" ? { pass: true } : {}),
      idempotencyKey: `btn:${i.messageId}:${i.userId}:${choiceKey(action.choice)}`,
    };
    let receipt: MessageReceipt;
    try {
      receipt = await d.pomtreed.postMessage(inbound);
    } catch (e) {
      d.log?.(`interaction ${i.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.editOutcome(i, "failed, press again", undefined);
      return "failed";
    }
    const who = i.userName ?? i.userId;
    if (receipt.kind === "rejected") {
      const decided = /^already (decided|answered)$/.test(receipt.reason);
      await this.editOutcome(i, decided ? "already decided" : `✗ ${receipt.reason} (${who})`, decided ? [] : undefined);
      return `rejected: ${receipt.reason}`;
    }
    await this.editOutcome(i, `${action.choice.kind === "option" ? body : action.choice.kind} by ${who}`, []);
    return `${receipt.kind} ${action.id}`;
  }

  // Edits the pressed message to show the outcome; `buttons` [] removes them, undefined keeps them. Best-effort.
  private async editOutcome(i: DiscordInteraction, status: string, buttons: readonly DiscordButton[] | undefined): Promise<void> {
    try {
      await this.deps.discord.editInteraction?.(i, withStatus(i.messageContent, status), buttons ? { buttons } : {});
    } catch (e) {
      this.deps.log?.(`interaction ${i.id} edit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Only configured (not merely paired) senders may approve or deny pairing.
  private async handlePairingButton(i: DiscordInteraction): Promise<string> {
    if (!this.isConfiguredSender(i.userId)) return "not allowed";
    const m = /^pair:(approve|deny):(.+)$/.exec(i.customId);
    if (!m) return "unknown action";
    if (m[1] === "deny") {
      await this.ready;
      return this.pending.delete(m[2]!) ? `denied ${m[2]}` : `no pending pairing for ${m[2]}`;
    }
    return this.approve(m[2]!);
  }

  private isAllowedSender(authorId: string): boolean {
    if (this.paired.has(authorId)) return true;
    const allowed = this.deps.allowedSenders;
    // Default-deny: an empty or absent allowlist admits no one.
    return !!allowed && allowed.length > 0 && allowed.includes(authorId);
  }

  private async isEscalationAnswer(msg: DiscordInbound): Promise<boolean> {
    if (!msg.replyToId) return false;
    return (await this.deps.discord.isBotAuthored(this.deps.channelId, msg.replyToId)) === true;
  }

  // Wire the transport's inbound messages into handleInbound (rethrow semantics: see handleInbound).
  listen(): () => void {
    const offI = this.deps.discord.onInteraction?.(async (i) => {
      let r: string;
      try {
        r = await this.handleInteraction(i);
      } catch (e) {
        r = `failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      this.deps.log?.(`interaction ${i.id}: ${r}`);
      // A pairing outcome is posted to the channel; an ask button reports by editing its own message.
      if (!isPairingButton(i.customId)) return;
      try {
        await this.deps.discord.send(this.deps.channelId, r);
      } catch {
        // best-effort
      }
    });
    const off = this.deps.discord.onMessage(async (msg) => {
      try {
        await this.handleInbound(msg);
      } catch (e) {
        this.deps.log?.(`inbound ${msg.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    });
    return () => {
      off();
      offI?.();
    };
  }
}
