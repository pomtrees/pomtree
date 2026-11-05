import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordAdapter } from "./adapter.ts";
import type { AdapterDeps } from "./adapter.ts";
import { emptyOutboxState } from "./cursor.ts";
import { encodeAction } from "./render.ts";
import type {
  DiscordButton,
  DiscordInbound,
  DiscordInteraction,
  DiscordTransport,
  EditOptions,
  InboundBody,
  MessageReceipt,
  OutboxEntry,
  SendOptions,
} from "./types.ts";

// Adapter tests for ask/approval buttons over a scripted transport (no Discord library involved; discord.test.ts
// covers the real transport against the gateway and REST fakes).

const AP = `ap-${"a".repeat(32)}`;
const ES = `es-${"e".repeat(64)}`;

const ask = (seq: number, replyTo: string, extra: Partial<OutboxEntry["payload"]> = {}, agent = "a1"): OutboxEntry => ({
  seq,
  ts: seq,
  agent,
  payload: { kind: "message_sent", channel: "discord", purpose: "ask", subject: `question ${seq}`, replyTo, ...extra },
});

class ButtonTransport implements DiscordTransport {
  events: string[] = [];
  sent: { content: string; buttons?: readonly DiscordButton[] }[] = [];
  edits: { content: string; opts?: EditOptions }[] = [];
  editError: Error | null = null;
  async send(_c: string, content: string, opts?: SendOptions) {
    this.sent.push({ content, ...(opts?.buttons ? { buttons: opts.buttons } : {}) });
    return `bot-msg-${this.sent.length - 1}`;
  }
  onMessage(_h: (m: DiscordInbound) => void) {
    return () => {};
  }
  onInteraction(_h: (i: DiscordInteraction) => void) {
    return () => {};
  }
  async isBotAuthored() {
    return true;
  }
  async deferUpdate(i: DiscordInteraction) {
    this.events.push(`defer ${i.id}`);
  }
  async editInteraction(i: DiscordInteraction, content: string, opts?: EditOptions) {
    this.events.push(`edit ${i.id}`);
    if (this.editError) throw this.editError;
    this.edits.push({ content, ...(opts ? { opts } : {}) });
  }
}

// A pomtreed that remembers receipts per idempotency key (as pomtreed's receipt cache does) and decides each id once.
class DecidingPomtreed {
  posted: InboundBody[] = [];
  decided = new Map<string, string>();
  receipts = new Map<string, MessageReceipt>();
  gate: Promise<void> | null = null;
  fail: Error | null = null;
  events: string[] | null = null;
  async outbox(): Promise<OutboxEntry[]> {
    return this.entries;
  }
  entries: OutboxEntry[] = [];
  async postMessage(b: InboundBody): Promise<MessageReceipt> {
    this.events?.push("post");
    this.posted.push(b);
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    const cached = this.receipts.get(b.idempotencyKey);
    if (cached) return cached;
    const id = b.replyTo!;
    const r: MessageReceipt = this.decided.has(id) ? { kind: "rejected", reason: "already decided" } : { kind: "answered", escalation: id };
    if (!this.decided.has(id)) this.decided.set(id, b.body);
    if (r.kind !== "rejected") this.receipts.set(b.idempotencyKey, r);
    return r;
  }
  async hostRead() {
    return { status: 404, body: null };
  }
}

function setup(over: Partial<AdapterDeps> = {}) {
  const discord = new ButtonTransport();
  const pomtreed = new DecidingPomtreed();
  pomtreed.events = discord.events;
  const adapter = new DiscordAdapter({
    pomtreed,
    discord,
    outbox: { read: async () => emptyOutboxState(), write: async () => {} },
    channelId: "c",
    allowedSenders: ["u1", "u2"],
    ...over,
  });
  return { adapter, discord, pomtreed };
}

const press = (customId: string, userId = "u1", over: Partial<DiscordInteraction> = {}): DiscordInteraction => ({
  id: `i-${userId}-${customId.slice(-3)}`,
  userId,
  userName: userId === "u1" ? "Alice" : "Bob",
  customId,
  messageId: "bot-msg-0",
  channelId: "c",
  messageContent: "[ask] question 1",
  handle: {},
  ...over,
});

const approve = encodeAction({ id: AP, choice: { kind: "approve" } });
const deny = encodeAction({ id: AP, choice: { kind: "deny" } });

test("an approval renders Approve and Deny; subjectKind decides, the ap- prefix only when it is absent", async () => {
  const { adapter, discord, pomtreed } = setup();
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" }), ask(2, AP), ask(3, ES, { subjectKind: "ask" }), ask(4, AP, { subjectKind: "ask" })];
  await adapter.pollOnce();
  assert.deepEqual(
    discord.sent[0]!.buttons?.map((b) => [b.label, b.customId]),
    [
      ["Approve", approve],
      ["Deny", deny],
    ],
  );
  assert.deepEqual(discord.sent[1]!.buttons, discord.sent[0]!.buttons, "ap- prefix fallback when subjectKind is absent");
  assert.equal(discord.sent[2]!.buttons, undefined, "an ask without options is answered by text");
  assert.equal(discord.sent[3]!.buttons, undefined, "subjectKind 'ask' on an ap- id is not an approval and has no es- id");
});

test("an ask renders one button per option, up to 25 in rows; more options or an empty one degrade to text", async () => {
  const { adapter, discord, pomtreed } = setup();
  const many = Array.from({ length: 26 }, (_, n) => `opt${n}`);
  pomtreed.entries = [
    ask(1, ES, { subjectKind: "ask", options: ["yes", "no"] }),
    ask(2, ES, { options: many.slice(0, 25) }),
    ask(3, ES, { options: many }),
    ask(4, ES, { options: ["ok", " "] }),
    { ...ask(5, ES, { options: ["x"] }), payload: { ...ask(5, ES, { options: ["x"] }).payload, purpose: "status" } },
  ];
  await adapter.pollOnce();
  assert.deepEqual(
    discord.sent[0]!.buttons?.map((b) => b.label),
    ["yes", "no"],
  );
  assert.equal(discord.sent[1]!.buttons?.length, 25);
  assert.equal(discord.sent[2]!.buttons, undefined, "more than 25 options degrade to text");
  assert.equal(discord.sent[3]!.buttons, undefined, "an empty option degrades to text");
  assert.equal(discord.sent[4]!.buttons, undefined, "only asks carry buttons");
});

test("Pass renders only behind the passButton flag and posts pass:true", async () => {
  const off = setup();
  off.pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await off.adapter.pollOnce();
  assert.ok(!off.discord.sent[0]!.buttons?.some((b) => b.label === "Pass"));
  const on = setup({ passButton: true });
  on.pomtreed.entries = [ask(1, AP, { subjectKind: "approval" }), ask(2, ES)];
  await on.adapter.pollOnce();
  assert.deepEqual(
    on.discord.sent[0]!.buttons?.map((b) => b.label),
    ["Approve", "Deny", "Pass"],
  );
  assert.deepEqual(
    on.discord.sent[1]!.buttons?.map((b) => b.label),
    ["Pass"],
  );
  await on.adapter.handleInteraction(press(on.discord.sent[0]!.buttons![2]!.customId));
  assert.equal(on.pomtreed.posted[0]!.pass, true);
  assert.equal(on.pomtreed.posted[0]!.body, "pass");
});

test("a transport without interactions gets no buttons", async () => {
  const { discord, pomtreed } = setup();
  const plain: DiscordTransport = { send: discord.send.bind(discord), onMessage: () => () => {}, isBotAuthored: async () => true };
  const adapter = new DiscordAdapter({ pomtreed, discord: plain, outbox: { read: async () => emptyOutboxState(), write: async () => {} }, channelId: "c" });
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await adapter.pollOnce();
  assert.equal(discord.sent[0]!.buttons, undefined);
});

test("a press is deferred before pomtreed answers, then the message is edited with the outcome and the buttons removed", async () => {
  const { adapter, discord, pomtreed } = setup();
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await adapter.pollOnce();
  let release!: () => void;
  pomtreed.gate = new Promise<void>((r) => (release = r));
  const done = adapter.handleInteraction(press(approve));
  for (let n = 0; n < 50 && pomtreed.posted.length === 0; n++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(discord.events, [`defer i-u1-${approve.slice(-3)}`, "post"], "deferred first; no edit while pomtreed is pending");
  release();
  assert.equal(await done, `answered ${AP}`);
  assert.deepEqual(pomtreed.posted[0], {
    channel: "discord",
    sender: { channel: "discord", sender: "u1", name: "Alice" },
    body: "approve",
    replyTo: AP,
    idempotencyKey: "btn:bot-msg-0:u1:a",
  });
  assert.equal(discord.edits[0]!.content, "[ask] question 1\n— approve by Alice");
  assert.deepEqual(discord.edits[0]!.opts, { buttons: [] });
});

test("a double press by the same user is one decision (same idempotency key)", async () => {
  const { adapter, discord, pomtreed } = setup();
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await adapter.pollOnce();
  await Promise.all([adapter.handleInteraction(press(approve)), adapter.handleInteraction(press(approve))]);
  assert.equal(pomtreed.posted.length, 2);
  assert.equal(pomtreed.posted[0]!.idempotencyKey, pomtreed.posted[1]!.idempotencyKey);
  assert.equal(pomtreed.decided.size, 1);
  assert.ok(discord.edits.every((e) => e.content.endsWith("approve by Alice")));
});

test("a second user's conflicting press is told 'already decided' and the buttons are removed", async () => {
  const { adapter, discord, pomtreed } = setup();
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await adapter.pollOnce();
  await adapter.handleInteraction(press(approve, "u1"));
  const r = await adapter.handleInteraction(press(deny, "u2", { messageContent: discord.edits[0]!.content }));
  assert.equal(r, "rejected: already decided");
  assert.equal(pomtreed.posted[1]!.idempotencyKey, "btn:bot-msg-0:u2:d");
  assert.equal(discord.edits[1]!.content, "[ask] question 1\n— already decided", "the old status line is replaced, not stacked");
  assert.deepEqual(discord.edits[1]!.opts, { buttons: [] });
});

test("an unlisted user, or one who may not address the ask's agent, makes no pomtreed call and no edit", async () => {
  const { adapter, discord, pomtreed } = setup({ agentAllowlists: { a1: ["u1"] } });
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" }, "a1")];
  await adapter.pollOnce();
  assert.equal(await adapter.handleInteraction(press(approve, "eve")), "not allowed");
  assert.equal(await adapter.handleInteraction(press(approve, "u2")), "not allowed to answer a1");
  assert.equal(pomtreed.posted.length, 0);
  assert.equal(discord.edits.length, 0);
  assert.equal(discord.events.filter((e) => e.startsWith("defer")).length, 2, "every press is still acknowledged");
});

test("a malformed, foreign or oversized custom_id is rejected without a pomtreed call", async () => {
  const { adapter, pomtreed } = setup();
  const bad = [
    `pm1:ap-${"a".repeat(31)}:a`,
    `pm2:${AP}:a`,
    `pm1:${AP}:x`,
    `pm1:${ES}:a`, // approve on an ask
    `pm1:${AP}:o1`, // an option on an approval
    `pm1:${ES}:o25`, // past the button limit
    `pm1:${ES}:o01`,
    `pm1:${AP}:a `,
    `pm1:${ES}:o1${"0".repeat(100)}`,
    "x".repeat(101),
    "",
  ];
  for (const c of bad) assert.equal(await adapter.handleInteraction(press(c)), "unknown action", c);
  assert.equal(pomtreed.posted.length, 0);
});

test("a pomtreed failure edits the message to 'failed, press again' and keeps the buttons", async () => {
  const { adapter, discord, pomtreed } = setup();
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await adapter.pollOnce();
  pomtreed.fail = new Error("pomtreed down");
  assert.equal(await adapter.handleInteraction(press(approve)), "failed");
  assert.equal(discord.edits[0]!.content, "[ask] question 1\n— failed, press again");
  assert.deepEqual(discord.edits[0]!.opts, {}, "no buttons field: the message keeps its buttons");
  pomtreed.fail = null;
  assert.equal(await adapter.handleInteraction(press(approve)), `answered ${AP}`, "pressing again works");
});

test("after a restart the id comes from custom_id and an option's text from the button label", async () => {
  const { adapter, discord, pomtreed } = setup(); // fresh adapter: no outbound message is known
  await adapter.handleInteraction(press(approve, "u1", { messageId: "old" }));
  assert.equal(pomtreed.posted[0]!.replyTo, AP);
  const opt = encodeAction({ id: ES, choice: { kind: "option", index: 1 } });
  await adapter.handleInteraction(press(opt, "u1", { messageId: "old2", buttonLabel: "no" }));
  assert.deepEqual([pomtreed.posted[1]!.replyTo, pomtreed.posted[1]!.body], [ES, "no"]);
  const cut = `${"y".repeat(79)}…`;
  assert.equal(await adapter.handleInteraction(press(opt, "u1", { messageId: "old3", buttonLabel: cut })), "option unavailable");
  assert.equal(pomtreed.posted.length, 2, "a truncated label is not sent as the answer");
  assert.match(discord.edits.at(-1)!.content, /reply with text$/);
});

test("after a restart a press is denied unless the presser is on every agent allowlist", async () => {
  const { adapter, pomtreed } = setup({ agentAllowlists: { a1: ["u1"], a2: ["u1", "u2"] } });
  assert.equal(await adapter.handleInteraction(press(approve, "u2", { messageId: "old" })), "not allowed to answer (owner unknown)");
  await adapter.handleInteraction(press(approve, "u1", { messageId: "old" }));
  assert.equal(pomtreed.posted.length, 1);
});

test("an option press answers with the option text kept in memory, and a button for another id is refused", async () => {
  const { adapter, discord, pomtreed } = setup();
  pomtreed.entries = [ask(1, ES, { options: ["ship it", "hold"] })];
  await adapter.pollOnce();
  await adapter.handleInteraction(press(discord.sent[0]!.buttons![0]!.customId, "u1", { buttonLabel: "tampered" }));
  assert.equal(pomtreed.posted[0]!.body, "ship it");
  assert.equal(discord.edits[0]!.content, "[ask] question 1\n— ship it by Alice");
  assert.equal(await adapter.handleInteraction(press(approve)), "button does not match its message");
  assert.equal(pomtreed.posted.length, 1);
});

test("a failed edit is logged and does not throw", async () => {
  const logs: string[] = [];
  const { adapter, discord, pomtreed } = setup({ log: (l) => logs.push(l) });
  pomtreed.entries = [ask(1, AP, { subjectKind: "approval" })];
  await adapter.pollOnce();
  discord.editError = new Error("Unknown interaction");
  assert.equal(await adapter.handleInteraction(press(approve)), `answered ${AP}`);
  assert.ok(logs.some((l) => /edit failed: Unknown interaction/.test(l)));
});
