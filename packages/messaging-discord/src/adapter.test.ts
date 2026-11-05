import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EscalationId, MessageKind } from "@pomtree/core";
import { DiscordAdapter } from "./adapter.ts";
import { pomtreedClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { emptyOutboxState, fileOutboxStore, formatOutboxState, nextCursor, parseOutboxState } from "./cursor.ts";
import { deliverInbound } from "./discord.ts";
import { DEFAULT_MAX_ATTEMPTS, planOutbox } from "./outbox.ts";
import { MAX_OUTBOUND_LENGTH, parseEscalationId, renderAlertBatch, renderOutbound, renderReceipt } from "./render.ts";
import { inboundBody } from "./routing.ts";
import { createInFlightGate } from "./run.ts";
import { DiscordSendError } from "./types.ts";
import type {
  DiscordInbound,
  DiscordTransport,
  HostAgentsBody,
  HostBudgetBody,
  HostReportBody,
  InboundBody,
  MessageFailedBody,
  MessageReceipt,
  OutboxEntry,
  OutboxState,
  PomtreedClient,
} from "./types.ts";

const ESCALATION_ID = `es-${"0".repeat(64)}`;

const out = (seq: number, purpose: MessageKind, subject: string, replyTo?: EscalationId, agent = "a1", ts = seq * 1000): OutboxEntry => ({
  seq,
  ts,
  agent,
  payload: { kind: "message_sent", channel: "discord", purpose, subject, ...(replyTo ? { replyTo } : {}) },
});

// An in-memory outbox store whose last-written state is inspectable.
function memOutbox() {
  let state: OutboxState = emptyOutboxState();
  return {
    read: async () => state,
    write: async (s: OutboxState) => {
      state = s;
    },
    state: () => state,
  };
}

// A 200 host-read reply typed against core's body shape, so a stub that drifts from pomtreed's fails to compile.
const hostOk = <B extends HostAgentsBody | HostBudgetBody | HostReportBody>(body: B) => ({ status: 200, body });

class FakePomtreed implements PomtreedClient {
  outboxEntries: OutboxEntry[] = [];
  posted: InboundBody[] = [];
  receipts: MessageReceipt[] = [];
  postError: Error | null = null;
  hostReplies: { status: number; body: unknown }[] = [];
  hostCalls: { path: string; sender: string }[] = [];
  hostError: Error | null = null;
  messageFailed?: (b: MessageFailedBody) => Promise<void>;
  async outbox(from: number) {
    return this.outboxEntries.filter((e) => e.seq >= from);
  }
  async postMessage(body: InboundBody) {
    if (this.postError) throw this.postError;
    this.posted.push(body);
    return this.receipts.shift() ?? { kind: "rejected", reason: "no route" };
  }
  async hostRead(path: string, sender: string) {
    this.hostCalls.push({ path, sender });
    if (this.hostError) throw this.hostError;
    return this.hostReplies.shift() ?? { status: 200, body: { agents: [] } };
  }
}

class FakeDiscord implements DiscordTransport {
  sent: { channelId: string; content: string }[] = [];
  botAuthored = new Map<string, boolean>();
  isBotAuthoredCalls: { channelId: string; messageId: string }[] = [];
  private handlers: ((msg: DiscordInbound) => void | Promise<void>)[] = [];
  private calls = 0;
  failOn = new Set<number>(); // call indexes that fail with a generic error
  failWith = new Map<number, Error>(); // call indexes that fail with a specific error
  async send(channelId: string, content: string) {
    const i = this.calls++;
    const specific = this.failWith.get(i);
    if (specific) throw specific;
    if (this.failOn.has(i)) throw new Error("discord send failed");
    this.sent.push({ channelId, content });
    return `bot-msg-${i}`;
  }
  async isBotAuthored(channelId: string, messageId: string) {
    this.isBotAuthoredCalls.push({ channelId, messageId });
    return this.botAuthored.get(messageId) ?? false;
  }
  onMessage(handler: (msg: DiscordInbound) => void | Promise<void>) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  emit(msg: DiscordInbound) {
    return Promise.all(this.handlers.map((h) => h(msg)));
  }
}

test("renderOutbound includes purpose and subject", () => {
  assert.equal(renderOutbound("ask", "approve?"), "[ask] approve?");
  assert.equal(renderOutbound("alert", "zombie!"), "[alert] zombie!");
});

test("renderOutbound truncates a long subject to the Discord limit with a marker", () => {
  const rendered = renderOutbound("ask", "x".repeat(5000));
  assert.equal(rendered.length, MAX_OUTBOUND_LENGTH);
  assert.match(rendered, /\[truncated\]$/);
  assert.ok(rendered.startsWith("[ask] "));
});

test("renderAlertBatch joins subjects under one alert prefix", () => {
  assert.equal(renderAlertBatch(["zombie"]), "[alert] zombie");
  assert.equal(renderAlertBatch(["zombie", "stuck"]), "[alert] zombie\nstuck");
});

test("renderReceipt renders each receipt kind for the human ack", () => {
  assert.equal(renderReceipt({ kind: "answered", escalation: ESCALATION_ID }), `✓ answered ${ESCALATION_ID}`);
  assert.equal(renderReceipt({ kind: "signaled", to: "a1" }), "✓ signaled a1");
  assert.equal(renderReceipt({ kind: "spawned", agent: "a2" }), "✓ spawned a2");
  assert.equal(renderReceipt({ kind: "rejected", reason: "no route" }), "✗ rejected: no route");
});

test("parseEscalationId extracts the deterministic id and ignores non-ids", () => {
  assert.equal(parseEscalationId(`reply ${ESCALATION_ID} please`), ESCALATION_ID);
  assert.equal(parseEscalationId("no id here"), undefined);
  assert.equal(parseEscalationId(undefined), undefined);
});

test("nextCursor advances past the sent seq and never moves backwards", () => {
  assert.equal(nextCursor(0, 5), 6);
  assert.equal(nextCursor(4, 7), 8);
  assert.equal(nextCursor(10, 3), 10);
});

test("parseOutboxState round-trips JSON", () => {
  const state: OutboxState = {
    cursor: 42,
    attempts: { "7": 2 },
    retryAfter: 1234,
    deadLetters: [{ seqs: [7], agent: "a1", subject: "[alert] x", reason: "discord HTTP 400", at: 1000 }],
  };
  assert.deepEqual(parseOutboxState(formatOutboxState(state)), state);
  assert.deepEqual(parseOutboxState(" 42 \n"), emptyOutboxState());
  assert.deepEqual(parseOutboxState(""), emptyOutboxState());
  assert.deepEqual(parseOutboxState("{ not json"), emptyOutboxState());
});

test("planOutbox coalesces alerts per agent within the window and keeps asks separate", () => {
  const entries = [
    out(1, "alert", "zombie a", undefined, "a1", 1000),
    out(2, "alert", "zombie b", undefined, "a1", 1500),
    out(3, "alert", "zombie c", undefined, "a2", 2000),
    out(4, "ask", "approve?", ESCALATION_ID, "a1", 3000),
  ];
  const units = planOutbox(entries, 60_000);
  assert.deepEqual(
    units.map((u) => ({ seqs: u.seqs, content: u.content, replyTo: u.replyTo })),
    [
      { seqs: [1, 2], content: "[alert] zombie a\nzombie b", replyTo: undefined },
      { seqs: [3], content: "[alert] zombie c", replyTo: undefined },
      { seqs: [4], content: "[ask] approve?", replyTo: ESCALATION_ID },
    ],
  );

  // A gap larger than the window splits even the same agent's alerts.
  const split = planOutbox([out(1, "alert", "a", undefined, "a1", 0), out(2, "alert", "b", undefined, "a1", 120_000)], 60_000);
  assert.equal(split.length, 2);
});

test("planOutbox renders a status unit alone, never coalesced like alerts", () => {
  const units = planOutbox(
    [
      out(1, "alert", "a", undefined, "a1", 1000),
      out(2, "status", "s1", undefined, "a1", 1100),
      out(3, "status", "s2", undefined, "a1", 1200),
      out(4, "alert", "b", undefined, "a1", 1300),
    ],
    60_000,
  );
  assert.deepEqual(
    units.map((u) => ({ seqs: u.seqs, purpose: u.purpose, content: u.content })),
    [
      { seqs: [1], purpose: "alert", content: "[alert] a" },
      { seqs: [2], purpose: "status", content: "[status] s1" },
      { seqs: [3], purpose: "status", content: "[status] s2" },
      { seqs: [4], purpose: "alert", content: "[alert] b" },
    ],
  );
});

test("inboundBody builds the pomtreed POST shape and parses replyTo only from the reply text", () => {
  const base = { id: "m1", authorId: "u1", authorName: "Alice", body: "yes" };
  assert.deepEqual(inboundBody({ ...base, replyToText: `see ${ESCALATION_ID}` }), {
    channel: "discord",
    sender: { channel: "discord", sender: "u1", name: "Alice" },
    body: "yes",
    replyTo: ESCALATION_ID,
    idempotencyKey: "m1",
  });
  // A bare escalation id in the body is NOT an answer: replyTo is omitted.
  assert.deepEqual(inboundBody({ id: "m2", authorId: "u2", body: ESCALATION_ID }), {
    channel: "discord",
    sender: { channel: "discord", sender: "u2" },
    body: ESCALATION_ID,
    idempotencyKey: "m2",
  });
});

test("pollOnce sends outbox entries in order and persists the JSON cursor after each success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mdcursor-"));
  try {
    const cursorPath = join(dir, "cursor");
    const pomtreed = new FakePomtreed();
    const discord = new FakeDiscord();
    pomtreed.outboxEntries = [out(3, "ask", "approve?"), out(7, "alert", "zombie"), out(9, "status", "ok")];
    const adapter = new DiscordAdapter({
      pomtreed,
      discord,
      outbox: fileOutboxStore(cursorPath),
      channelId: "ch",
    });

    const r = await adapter.pollOnce();
    assert.equal(r.sent, 3);
    assert.equal(r.deadLettered, 0);
    assert.equal(r.cursor, 10);
    assert.deepEqual(discord.sent, [
      { channelId: "ch", content: "[ask] approve?" },
      { channelId: "ch", content: "[alert] zombie" },
      { channelId: "ch", content: "[status] ok" },
    ]);
    assert.equal(parseOutboxState(readFileSync(cursorPath, "utf8")).cursor, 10);

    // A second poll from the persisted cursor sends nothing new.
    assert.equal((await adapter.pollOnce()).sent, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pollOnce retries a failed send on the next poll without advancing past it", async () => {
  const store = memOutbox();
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  pomtreed.outboxEntries = [out(3, "ask", "a"), out(7, "alert", "b"), out(9, "status", "c")];
  discord.failOn = new Set([1]); // second send fails once
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: store, channelId: "ch" });

  const first = await adapter.pollOnce();
  assert.equal(first.sent, 1); // only seq 3 committed
  assert.equal(first.deadLettered, 0);
  assert.equal(first.cursor, 4);
  assert.equal(store.state().attempts["7"], 1); // one attempt logged, below the cap
  assert.equal(discord.sent.length, 1);

  // Retry resumes from seq 7 (entries are filtered by the persisted cursor).
  discord.failOn = new Set();
  const second = await adapter.pollOnce();
  assert.equal(second.sent, 2);
  assert.equal(second.cursor, 10);
  assert.equal(store.state().attempts["7"], undefined);
  assert.deepEqual(store.state().deadLetters, []);
});

test("pollOnce dead-letters a permanently failing entry and still sends later entries", async () => {
  const store = memOutbox();
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  pomtreed.outboxEntries = [out(3, "alert", "zombie"), out(7, "ask", "approve?")];
  discord.failWith = new Map([[0, new DiscordSendError(400, null, "discord send HTTP 400: bad request")]]);
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: store, channelId: "ch", maxAttempts: 1 });

  const r = await adapter.pollOnce();
  assert.equal(r.deadLettered, 1);
  assert.equal(r.sent, 1); // the later ask still goes out in the same poll
  assert.equal(r.cursor, 8);
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0]!.content, "[ask] approve?");
  assert.equal(store.state().deadLetters.length, 1);
  assert.equal(store.state().deadLetters[0]!.agent, "a1");
  assert.match(store.state().deadLetters[0]!.reason, /HTTP 400/);
  assert.equal(store.state().attempts["3"], undefined);

  // The dead-lettered entry never returns; a subsequent poll sends nothing.
  assert.equal((await adapter.pollOnce()).sent, 0);
});

test("pollOnce dead-letters only after maxAttempts and stops earlier on a transient failure", async () => {
  const store = memOutbox();
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  pomtreed.outboxEntries = [out(3, "ask", "a")];
  // Call 0 and 1 both fail (generic/transient), call 2 succeeds.
  discord.failOn = new Set([0, 1]);
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: store, channelId: "ch", maxAttempts: DEFAULT_MAX_ATTEMPTS });

  const first = await adapter.pollOnce();
  assert.equal(first.sent, 0);
  assert.equal(first.deadLettered, 0);
  assert.equal(store.state().attempts["3"], 1);

  const second = await adapter.pollOnce();
  assert.equal(second.sent, 0);
  assert.equal(second.deadLettered, 0);
  assert.equal(store.state().attempts["3"], 2);

  discord.failOn = new Set();
  const third = await adapter.pollOnce();
  assert.equal(third.sent, 1);
  assert.equal(store.state().deadLetters.length, 0);
});

test("pollOnce honors Retry-After by pausing the whole outbox until the deadline", async () => {
  const store = memOutbox();
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  pomtreed.outboxEntries = [out(3, "ask", "a"), out(7, "ask", "b")];
  discord.failWith = new Map([[0, new DiscordSendError(429, 5000, "rate limited")]]);
  let fakeNow = 1000;
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: store, channelId: "ch", now: () => fakeNow });

  const first = await adapter.pollOnce();
  assert.equal(first.sent, 0);
  assert.equal(first.deadLettered, 0);
  assert.equal(store.state().retryAfter, 6000); // now(1000) + 5000ms

  // Before the deadline the poll does nothing and does not count another attempt.
  const before = await adapter.pollOnce();
  assert.equal(before.sent, 0);
  assert.equal(store.state().attempts["3"], undefined); // Retry-After does not count toward the cap
  assert.equal(discord.sent.length, 0);

  // Past the deadline the send retries and succeeds, and the expired backoff is cleared.
  fakeNow = 6500;
  const after = await adapter.pollOnce();
  assert.equal(after.sent, 2);
  assert.equal(after.cursor, 8);
  assert.equal(store.state().retryAfter, null);
});

test("handleInbound posts the message to pomtreed, acks the receipt, and returns it", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.receipts = [{ kind: "answered", escalation: ESCALATION_ID }];
  const discord = new FakeDiscord();
  discord.botAuthored.set("bot-msg", true);
  const logs: string[] = [];
  const adapter = new DiscordAdapter({
    pomtreed,
    discord,
    outbox: memOutbox(),
    channelId: "ch",
    allowedSenders: ["u1"],
    log: (l) => logs.push(l),
  });

  const receipt = await adapter.handleInbound({ id: "m9", authorId: "u1", authorName: "Bob", body: "yes", replyToText: ESCALATION_ID, replyToId: "bot-msg" });
  assert.equal(receipt.kind, "answered");
  assert.equal(pomtreed.posted.length, 1);
  assert.deepEqual(pomtreed.posted[0], {
    channel: "discord",
    sender: { channel: "discord", sender: "u1", name: "Bob" },
    body: "yes",
    replyTo: ESCALATION_ID,
    idempotencyKey: "m9",
  });
  assert.deepEqual(discord.isBotAuthoredCalls, [{ channelId: "ch", messageId: "bot-msg" }]);
  // The receipt is posted back to Discord as the ack.
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0]!.content, `✓ answered ${ESCALATION_ID}`);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /answered/);
});

test("handleInbound default-denies when the allowlist is empty or absent", async () => {
  for (const allowedSenders of [undefined, []]) {
    const pomtreed = new FakePomtreed();
    const discord = new FakeDiscord();
    const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders });
    const receipt = await adapter.handleInbound({ id: "m1", authorId: "u1", body: "yes", replyToText: ESCALATION_ID });
    assert.equal(receipt.kind, "rejected");
    assert.equal((receipt as { reason: string }).reason, "sender not allowed");
    assert.equal(pomtreed.posted.length, 0);
    // The rejection is still acked back to the human.
    assert.equal(discord.sent.length, 1);
    assert.match(discord.sent[0]!.content, /sender not allowed/);
  }
});

test("handleInbound does not answer a bare escalation id in the body", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });

  const receipt = await adapter.handleInbound({ id: "m1", authorId: "u1", body: ESCALATION_ID });
  assert.equal(receipt.kind, "rejected");
  assert.equal(pomtreed.posted.length, 1);
  assert.equal(pomtreed.posted[0]!.replyTo, undefined);
  assert.equal(discord.isBotAuthoredCalls.length, 0);
});

test("handleInbound only answers when the reply target is bot-authored", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });

  // A reply to a non-bot message (defaults to not bot-authored) is not an answer.
  const rejected = await adapter.handleInbound({ id: "m2", authorId: "u1", body: "yes", replyToText: ESCALATION_ID, replyToId: "human-msg" });
  assert.equal(rejected.kind, "rejected");
  assert.equal(pomtreed.posted[0]!.replyTo, undefined);

  // The same reply to a bot-authored message answers.
  discord.botAuthored.set("bot-msg", true);
  pomtreed.receipts = [{ kind: "answered", escalation: ESCALATION_ID }];
  const answered = await adapter.handleInbound({ id: "m3", authorId: "u1", body: "yes", replyToText: ESCALATION_ID, replyToId: "bot-msg" });
  assert.equal(answered.kind, "answered");
  assert.equal(pomtreed.posted[1]!.replyTo, ESCALATION_ID);
});

test("outbound message_sent with replyTo correlates the inbound reply without text parsing", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.receipts = [{ kind: "answered", escalation: ESCALATION_ID }];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });

  // An outbound ask carrying `replyTo` is sent and its Discord message id is recorded.
  pomtreed.outboxEntries = [out(3, "ask", "approve?", ESCALATION_ID)];
  await adapter.pollOnce();
  assert.equal(discord.sent.length, 1);
  assert.equal(discord.sent[0]!.content, "[ask] approve?");

  // The inbound reply references the bot message id directly; its text contains no `es-…` id and
  // no `replyToText` is supplied, so the answer can only come from the recorded correlation.
  const receipt = await adapter.handleInbound({ id: "m10", authorId: "u1", body: "yes", replyToId: "bot-msg-0" });
  assert.equal(receipt.kind, "answered");
  assert.equal(pomtreed.posted.length, 1);
  assert.deepEqual(pomtreed.posted[0], {
    channel: "discord",
    sender: { channel: "discord", sender: "u1" },
    body: "yes",
    replyTo: ESCALATION_ID,
    idempotencyKey: "m10",
  });
  // Direct correlation needs no bot-authorship re-check (the map only holds the bot's own ids).
  assert.equal(discord.isBotAuthoredCalls.length, 0);
});

test("handleInbound rejects senders outside the allowlist and still applies the reply-target check", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  discord.botAuthored.set("bot-msg", true);
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });

  const blocked = await adapter.handleInbound({ id: "m4", authorId: "u2", body: "yes", replyToText: ESCALATION_ID, replyToId: "bot-msg" });
  assert.equal(blocked.kind, "rejected");
  assert.equal((blocked as { reason: string }).reason, "sender not allowed");
  assert.equal(pomtreed.posted.length, 0);
  assert.equal(discord.isBotAuthoredCalls.length, 0);

  // Allowed sender, but the reply target is not bot-authored: still no answer.
  const allowed = await adapter.handleInbound({ id: "m5", authorId: "u1", body: "yes", replyToText: ESCALATION_ID, replyToId: "human-msg" });
  assert.equal(allowed.kind, "rejected");
  assert.equal(pomtreed.posted.length, 1);
  assert.equal(pomtreed.posted[0]!.replyTo, undefined);
});

test("handleInbound rethrows a failed pomtreed POST so the transport does not advance its cursor", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.postError = new Error("pomtreed down");
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });

  await assert.rejects(() => adapter.handleInbound({ id: "m1", authorId: "u1", body: "yes" }), /pomtreed down/);
  // Nothing was acked because pomtreed never returned a receipt.
  assert.equal(discord.sent.length, 0);

  // `listen` rethrows after logging, so a real transport can avoid advancing lastId.
  const logs: string[] = [];
  const listening = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"], log: (l) => logs.push(l) });
  const off = listening.listen();
  // Capture the registered handler and invoke it directly.
  const emitted = discord.emit({ id: "m2", authorId: "u1", body: "hi" });
  await assert.rejects(() => emitted, /pomtreed down/);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /inbound m2 failed/);
  off();
});

test("deliverInbound advances the inbound cursor only after a handler succeeds", async () => {
  // Discord returns newest-first; deliverInbound reverses to oldest-first.
  const list = [
    { id: "d2", content: "yo", author: { id: "u2", username: "B" } },
    { id: "d1", content: "hi", author: { id: "u1", username: "A" } },
  ];
  let fail = true;
  const delivered: string[] = [];
  const handler = async (msg: DiscordInbound) => {
    delivered.push(msg.id);
    if (fail && msg.id === "d1") throw new Error("pomtreed down");
  };

  // d1 throws: the cursor stays at d0 and d2 is never reached.
  await assert.rejects(() => deliverInbound(list, "d0", [handler]), /pomtreed down/);
  assert.deepEqual(delivered, ["d1"]);

  // On success both messages are delivered in order and the cursor advances to d2.
  fail = false;
  const cursor = await deliverInbound(list, "d0", [handler]);
  assert.equal(cursor, "d2");
  assert.deepEqual(delivered, ["d1", "d1", "d2"]);
});

test("loadConfig parses the sender allowlist from DISCORD_ALLOWED_SENDERS", () => {
  const dir = mkdtempSync(join(tmpdir(), "mdcfg-"));
  try {
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "ht.discord.tok");
    const env: NodeJS.ProcessEnv = {
      POMTREED_MESSAGING_TOKEN: tokenPath,
      DISCORD_TOKEN: "dt",
      DISCORD_CHANNEL_ID: "ch",
      DISCORD_ALLOWED_SENDERS: "u1, u2 ,, u3",
    };
    assert.deepEqual(loadConfig(env).allowedSenders, ["u1", "u2", "u3"]);
    delete env.DISCORD_ALLOWED_SENDERS;
    // An empty/absent list is default-deny (the adapter admits no one).
    assert.deepEqual(loadConfig(env).allowedSenders, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInFlightGate skips overlapping polls until the previous one leaves", () => {
  const gate = createInFlightGate();
  assert.equal(gate.tryEnter(), true);
  assert.equal(gate.tryEnter(), false); // a tick while in flight is skipped
  assert.equal(gate.tryEnter(), false);
  gate.leave();
  assert.equal(gate.tryEnter(), true);
});

test("fileOutboxStore reads an empty state when missing and round-trips under tmpdir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mdcursor-"));
  try {
    const store = fileOutboxStore(join(dir, "nested", "cursor"));
    assert.deepEqual(await store.read(), emptyOutboxState());
    const state: OutboxState = { cursor: 1234, attempts: { "5": 1 }, retryAfter: null, deadLetters: [] };
    await store.write(state);
    assert.deepEqual(await store.read(), state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pomtreedClient sends the host token as a Bearer header and polls/posts the messages routes", async () => {
  const received: { method?: string; url?: string; auth?: string; body?: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "x-pomtree-messaging-api": "1" });
        res.end(JSON.stringify([out(3, "ask", "approve?")]));
      } else {
        res.writeHead(201, { "content-type": "application/json", "x-pomtree-messaging-api": "1" });
        res.end(JSON.stringify({ kind: "answered", escalation: "es-x" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const client = pomtreedClient(`http://127.0.0.1:${port}`, "ht.discord.tok");
    const outbox = await client.outbox(0);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]!.payload.subject, "approve?");
    assert.equal(received[0]!.auth, "Bearer ht.discord.tok");
    assert.equal(received[0]!.url, "/v1/messages?from=0&channel=discord");

    const receipt = await client.postMessage({
      channel: "discord",
      sender: { channel: "discord", sender: "u1" },
      body: "hi",
      idempotencyKey: "m1",
    });
    assert.equal(receipt.kind, "answered");
    assert.equal(received[1]!.auth, "Bearer ht.discord.tok");
    assert.deepEqual(received[1]!.body, {
      channel: "discord",
      sender: { channel: "discord", sender: "u1" },
      body: "hi",
      idempotencyKey: "m1",
    });
    await client.messageFailed!({ channel: "discord", purpose: "ask", subject: "s", reason: "r", idempotencyKey: "dl:1-1" });
    assert.equal(received[2]!.url, "/v1/messages/failed");
    assert.equal(received[2]!.auth, "Bearer ht.discord.tok");
    assert.equal((received[2]!.body as { idempotencyKey: string }).idempotencyKey, "dl:1-1");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("handleInbound routes !spawn and !tell to pomtreed intents; unsupported/invalid commands are rejected locally", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.receipts = [
    { kind: "spawned", agent: "a9" },
    { kind: "signaled", to: "a1" },
  ];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  await adapter.handleInbound({ id: "c1", authorId: "u1", body: "!spawn fix the bug" });
  await adapter.handleInbound({ id: "c2", authorId: "u1", body: "!tell a1 hello there" });
  assert.equal(pomtreed.posted[0]!.intent, "spawn");
  assert.equal(pomtreed.posted[0]!.body, "fix the bug");
  assert.equal(pomtreed.posted[1]!.intent, "signal");
  assert.equal(pomtreed.posted[1]!.to, "a1");
  assert.equal(pomtreed.posted[1]!.body, "hello there");
  const r1 = await adapter.handleInbound({ id: "c3", authorId: "u1", body: "!ps" });
  const r2 = await adapter.handleInbound({ id: "c4", authorId: "u1", body: "!spawn" });
  assert.equal(r1.kind, "rejected");
  assert.equal(r2.kind, "rejected");
  assert.equal(pomtreed.posted.length, 2);
});

test("handleInbound forwards !workflow launch as intent launch with the workflow, instance and channel identity", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.receipts = [{ kind: "launched", agent: "a5" }];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  const r = await adapter.handleInbound({ id: "w1", authorId: "u1", authorName: "Ann", body: "  !workflow launch hn/digest daily " });
  assert.deepEqual(r, { kind: "launched", agent: "a5" });
  const body = pomtreed.posted[0]!;
  assert.equal(body.intent, "launch");
  assert.equal(body.workflow, "hn/digest");
  assert.deepEqual(body.input, { instance: "daily" });
  assert.equal(body.body, "!workflow launch hn/digest daily");
  assert.equal(body.idempotencyKey, "w1");
  assert.deepEqual(body.sender, { channel: "discord", sender: "u1", name: "Ann" });
  assert.equal(body.channel, "discord");
  assert.equal(body.to, undefined);
  assert.deepEqual(discord.sent[0], { channelId: "ch", content: "✓ launched a5" });
});

test("handleInbound rejects an unlisted sender and invalid !workflow input without calling pomtreed", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  const denied = await adapter.handleInbound({ id: "x1", authorId: "u9", body: "!workflow launch hn/digest daily" });
  assert.deepEqual(denied, { kind: "rejected", reason: "sender not allowed" });
  const bad = await adapter.handleInbound({ id: "x2", authorId: "u1", body: "!workflow launch hn/digest" });
  assert.deepEqual(bad, { kind: "rejected", reason: "!workflow: missing instance" });
  assert.equal(pomtreed.posted.length, 0);
});

test("per-agent allowlists gate !tell and answers for that agent only", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.receipts = [
    { kind: "signaled", to: "a1" },
    { kind: "signaled", to: "a2" },
  ];
  const adapter = new DiscordAdapter({
    pomtreed,
    discord: new FakeDiscord(),
    outbox: memOutbox(),
    channelId: "ch",
    allowedSenders: ["u1", "u2"],
    agentAllowlists: { a1: ["u1"] },
  });
  assert.equal((await adapter.handleInbound({ id: "d1", authorId: "u2", body: "!tell a1 hi" })).kind, "rejected");
  assert.equal((await adapter.handleInbound({ id: "d2", authorId: "u1", body: "!tell a1 hi" })).kind, "signaled");
  assert.equal((await adapter.handleInbound({ id: "d3", authorId: "u2", body: "!tell a2 hi" })).kind, "signaled");
});

test("!cancel and !status map to cancel/status intents with the agent in `to`; allowlists gate cancel", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.receipts = [
    { kind: "cancelled", agent: "a1" },
    { kind: "status", agent: "a1", state: "running" },
  ];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({
    pomtreed,
    discord,
    outbox: memOutbox(),
    channelId: "ch",
    allowedSenders: ["u1", "u2"],
    agentAllowlists: { a1: ["u1"] },
  });
  assert.equal((await adapter.handleInbound({ id: "x0", authorId: "u2", body: "!cancel a1" })).kind, "rejected");
  assert.equal(pomtreed.posted.length, 0);
  assert.equal((await adapter.handleInbound({ id: "x1", authorId: "u1", body: "!cancel a1" })).kind, "cancelled");
  assert.equal((await adapter.handleInbound({ id: "x2", authorId: "u1", body: "!status a1" })).kind, "status");
  assert.equal(pomtreed.posted[0]!.intent, "cancel");
  assert.equal(pomtreed.posted[0]!.to, "a1");
  assert.equal(pomtreed.posted[1]!.intent, "status");
  assert.equal(pomtreed.posted[1]!.to, "a1");
  assert.equal((await adapter.handleInbound({ id: "x3", authorId: "u1", body: "!status" })).kind, "rejected");
  assert.equal(pomtreed.posted.length, 2);
  assert.ok(discord.sent.some((s) => s.content === "✓ cancelled a1"));
  assert.ok(discord.sent.some((s) => s.content === "a1: running"));
});

test("a dead-lettered send is reported to pomtreed (message-failed); a failing report does not wedge the poll", async () => {
  for (const reportFails of [false, true]) {
    const store = memOutbox();
    const pomtreed = new FakePomtreed();
    const reported: MessageFailedBody[] = [];
    pomtreed.messageFailed = async (b) => {
      reported.push(b);
      if (reportFails) throw new Error("pomtreed down");
    };
    const discord = new FakeDiscord();
    pomtreed.outboxEntries = [out(3, "ask", "approve?"), out(7, "status", "ok")];
    discord.failWith = new Map([[0, new DiscordSendError(400, null, "bad request")]]);
    const adapter = new DiscordAdapter({ pomtreed, discord, outbox: store, channelId: "ch", maxAttempts: 1 });
    const r = await adapter.pollOnce();
    assert.equal(r.deadLettered, 1);
    assert.equal(r.sent, 1);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.channel, "discord");
    assert.equal(reported[0]!.purpose, "ask");
    assert.equal(reported[0]!.idempotencyKey, "dl:3-3");
    assert.match(reported[0]!.reason, /HTTP 400/);
  }
});

test("!ps, !budget and !report read pomtreed's host routes as the sender and reply with the data", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.hostReplies = [
    hostOk<HostAgentsBody>({
      agents: [{ id: "a1", state: "running", parent: null, name: "worker", createdAt: 1, updatedAt: 2, spentMicros: 500_000, budgetMicros: 1_000_000 }],
    }),
    hostOk<HostBudgetBody>({ id: "a1", budgetMicros: 1_000_000, spentMicros: 500_000, remainingMicros: 500_000 }),
    hostOk<HostReportBody>({ id: "a1", state: "exited", exit: "succeeded", report: "all good" }),
  ];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  await adapter.handleInbound({ id: "h1", authorId: "u1", body: "!ps" });
  await adapter.handleInbound({ id: "h2", authorId: "u1", body: "!budget a1" });
  await adapter.handleInbound({ id: "h3", authorId: "u1", body: "!report a1" });
  assert.deepEqual(pomtreed.hostCalls, [
    { path: "/agents", sender: "u1" },
    { path: "/agents/a1/budget", sender: "u1" },
    { path: "/agents/a1/report", sender: "u1" },
  ]);
  assert.equal(discord.sent[0]!.content, "[status] a1 running $0.50/$1.00 worker");
  assert.equal(discord.sent[1]!.content, "[status] a1: spent $0.50 of $1.00, remaining $0.50");
  assert.equal(discord.sent[2]!.content, "[report] a1 exited(succeeded): all good");
});

test("!report renders hostile pomtreed text inside the capped message, and a long report is truncated", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.hostReplies = [hostOk<HostReportBody>({ id: "a1", state: "exited", exit: "failed", report: `@everyone ${"x".repeat(5000)}` })];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  await adapter.handleInbound({ id: "r1", authorId: "u1", body: "!report a1" });
  const content = discord.sent[0]!.content;
  assert.ok(content.length <= MAX_OUTBOUND_LENGTH);
  assert.match(content, /\[truncated\]$/);
  assert.ok(content.startsWith("[report] a1 exited(failed): @everyone xxx"));
});

test("!ps caps the list at 20 lines with a count of the rest", async () => {
  const pomtreed = new FakePomtreed();
  const agents = Array.from({ length: 22 }, (_, n) => ({
    id: `a${n}`,
    state: "running",
    parent: null,
    name: "",
    createdAt: 1,
    updatedAt: 1,
    spentMicros: 0,
    budgetMicros: 0,
  }));
  pomtreed.hostReplies = [{ status: 200, body: { agents } }];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  await adapter.handleInbound({ id: "p1", authorId: "u1", body: "!ps" });
  const lines = discord.sent[0]!.content.split("\n");
  assert.equal(lines.length, 21);
  assert.equal(lines[20], "… 2 more");
});

test("!ps, !budget and !report from an unlisted sender are refused and never reach pomtreed", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  for (const body of ["!ps", "!budget a1", "!report a1"]) {
    assert.equal((await adapter.handleInbound({ id: body, authorId: "u9", body })).kind, "rejected");
  }
  assert.equal(pomtreed.hostCalls.length, 0);
});

test("!budget and !report reject malformed agent ids before any pomtreed call", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  const long = "a".repeat(65);
  for (const body of ["!budget .", "!budget ..", "!report ..", `!budget ${long}`, "!report a/b", "!budget a%2e%2e"]) {
    const r = await adapter.handleInbound({ id: body, authorId: "u1", body });
    assert.equal(r.kind, "rejected", body);
  }
  assert.equal(pomtreed.hostCalls.length, 0);
  assert.match(discord.sent[0]!.content, /bad agent id/);
  // a well-formed id still reaches pomtreed
  pomtreed.hostReplies = [{ status: 404, body: { error: "no such agent" } }];
  await adapter.handleInbound({ id: "ok", authorId: "u1", body: "!budget ag-0123abcd" });
  assert.deepEqual(pomtreed.hostCalls, [{ path: "/agents/ag-0123abcd/budget", sender: "u1" }]);
});

test("pomtreed host errors (403/404/429) are shown as short errors", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.hostReplies = [
    { status: 403, body: { error: "sender not authorized" } },
    { status: 404, body: { error: "no such agent" } },
    { status: 429, body: { error: "x".repeat(300) } },
  ];
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  await adapter.handleInbound({ id: "e1", authorId: "u1", body: "!budget a1" });
  await adapter.handleInbound({ id: "e2", authorId: "u1", body: "!budget a1" });
  await adapter.handleInbound({ id: "e3", authorId: "u1", body: "!ps" });
  assert.equal(discord.sent[0]!.content, "[status] ✗ !budget failed: 403 sender not authorized");
  assert.equal(discord.sent[1]!.content, "[status] ✗ !budget failed: 404 no such agent");
  assert.equal(discord.sent[2]!.content, `[status] ✗ !ps failed: 429 ${"x".repeat(200)}`);
});

test("a transport error to pomtreed is logged and reported as unreachable, not rethrown", async () => {
  const pomtreed = new FakePomtreed();
  pomtreed.hostError = new Error("ECONNREFUSED");
  const discord = new FakeDiscord();
  const logs: string[] = [];
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"], log: (l) => logs.push(l) });
  await adapter.handleInbound({ id: "t1", authorId: "u1", body: "!ps" });
  assert.equal(discord.sent[0]!.content, "[status] ✗ !ps failed: pomtreed unreachable");
  assert.ok(logs.some((l) => l.includes("ECONNREFUSED")));
});

test("!budget and !report without an agent id are refused locally", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({ pomtreed, discord, outbox: memOutbox(), channelId: "ch", allowedSenders: ["u1"] });
  assert.equal((await adapter.handleInbound({ id: "m1", authorId: "u1", body: "!budget" })).kind, "rejected");
  assert.equal((await adapter.handleInbound({ id: "m2", authorId: "u1", body: "!report" })).kind, "rejected");
  assert.ok(discord.sent.some((s) => s.content === "✗ rejected: !budget needs an agent: !budget AGENT"));
  assert.equal(pomtreed.hostCalls.length, 0);
});

test("!budget and !report honour agentAllowlists like !tell", async () => {
  const pomtreed = new FakePomtreed();
  const discord = new FakeDiscord();
  const adapter = new DiscordAdapter({
    pomtreed,
    discord,
    outbox: memOutbox(),
    channelId: "ch",
    allowedSenders: ["u1", "u2"],
    agentAllowlists: { a1: ["u1"] },
  });
  assert.equal((await adapter.handleInbound({ id: "g1", authorId: "u2", body: "!report a1" })).kind, "rejected");
  assert.equal((await adapter.handleInbound({ id: "g2", authorId: "u2", body: "!budget a1" })).kind, "rejected");
  assert.equal(pomtreed.hostCalls.length, 0);
  await adapter.handleInbound({ id: "g3", authorId: "u1", body: "!budget a1" });
  assert.equal(pomtreed.hostCalls.length, 1);
});
