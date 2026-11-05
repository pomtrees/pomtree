import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordAdapter } from "./adapter.ts";
import { emptyOutboxState } from "./cursor.ts";
import { buttonRows, gatewayTransport, snowflakeAfter, toSendError } from "./discord.ts";
import { FakeGateway, fakeRest } from "./fakes.ts";
import type { RestCall, ScriptedReply } from "./fakes.ts";
import { encodeAction } from "./render.ts";
import { DiscordSendError } from "./types.ts";
import type { DiscordInbound, DiscordInteraction, InboundBody, MessageReceipt } from "./types.ts";

// The real gateway transport against the offline gateway and REST fakes (fakes.ts): no network.

const CH = "100";
const BOT = "999";
const AP = `ap-${"b".repeat(32)}`;

const query = (c: RestCall) => new URL(`http://x${c.path}`).searchParams;
const isList = (c: RestCall) => c.method === "GET" && c.path.startsWith(`/channels/${CH}/messages?`);

// A channel history the REST fake serves for prime (limit=1) and catch-up (after=, newest-first).
function channel(history: { id: string; content?: string; author?: { id: string; bot?: boolean } }[]) {
  const msgs = history.map((m) => ({ channel_id: CH, content: "", author: { id: "u1", username: "alice" }, ...m }));
  const respond = (c: RestCall): ScriptedReply => {
    if (isList(c)) {
      const q = query(c);
      const after = q.get("after");
      const limit = Number(q.get("limit") ?? 50);
      const sorted = [...msgs].sort((a, b) => (snowflakeAfter(a.id, b.id) ? -1 : 1)); // newest-first
      if (!after) return { status: 200, body: sorted.slice(0, limit) };
      return { status: 200, body: sorted.filter((m) => snowflakeAfter(m.id, after)).slice(-limit) };
    }
    if (c.method === "GET" && c.path === "/users/@me") return { status: 200, body: { id: BOT, username: "bot", bot: true } };
    if (c.method === "POST" && c.path === `/channels/${CH}/messages`) return { status: 200, body: { id: "555", channel_id: CH } };
    return { status: 204 };
  };
  return { msgs, respond };
}

function rig(history: Parameters<typeof channel>[0] = [{ id: "200" }], respond?: (c: RestCall) => ScriptedReply) {
  const ch = channel(history);
  const { rest, calls } = fakeRest(respond ?? ch.respond);
  const gateway = new FakeGateway();
  const logs: string[] = [];
  const transport = gatewayTransport({ token: "bot-token-secret", channelId: CH, gateway, rest, log: (l) => logs.push(l), retryMs: 60_000 });
  const delivered: DiscordInbound[] = [];
  let failOn: string | null = null;
  transport.onMessage(async (m) => {
    if (m.id === failOn) throw new Error("pomtreed down");
    delivered.push(m);
  });
  const fail = (id: string | null) => {
    failOn = id;
  };
  return { transport, gateway, calls, logs, delivered, history: ch.msgs, fail };
}

test("start primes the cursor at the newest message and connects; history is not replayed", async () => {
  const r = rig([{ id: "200" }, { id: "201" }]);
  await r.transport.start!();
  assert.equal(r.gateway.connects, 1);
  r.gateway.ready(BOT);
  await r.transport.idle();
  assert.deepEqual(r.delivered, []);
  assert.equal(query(r.calls.find(isList)!).get("limit"), "1");
  r.transport.stop!();
  assert.equal(r.gateway.destroys, 1);
});

test("MESSAGE_CREATE in the channel maps to an inbound message; other channels and bot messages are ignored", async () => {
  const r = rig();
  await r.transport.start!();
  r.gateway.ready(BOT);
  r.gateway.message({ id: "300", channel_id: "other", content: "elsewhere", author: { id: "u1" } });
  r.gateway.message({ id: "301", channel_id: CH, content: "bot talk", author: { id: BOT, bot: true } });
  r.gateway.message({
    id: "302",
    channel_id: CH,
    content: "yes",
    author: { id: "u1", username: "alice" },
    referenced_message: { id: "250", content: `q ${AP}`, author: { id: BOT, bot: true } },
  });
  await r.transport.idle();
  assert.deepEqual(r.delivered, [{ id: "302", authorId: "u1", authorName: "alice", body: "yes", replyToText: `q ${AP}`, replyToId: "250" }]);
});

test("every READY catches up from the last delivered id over REST, without delivering anything twice", async () => {
  const r = rig([{ id: "200" }]);
  await r.transport.start!();
  r.gateway.ready(BOT);
  r.gateway.message({ id: "201", channel_id: CH, content: "live", author: { id: "u1" } });
  await r.transport.idle();
  // The connection drops; 202 and 203 are posted while it is down; a fresh identify does not replay them.
  r.history.push({ id: "201", channel_id: CH, content: "live", author: { id: "u1", username: "alice" } });
  r.history.push({ id: "202", channel_id: CH, content: "missed a", author: { id: "u1", username: "alice" } });
  r.history.push({ id: "203", channel_id: CH, content: "missed b", author: { id: "u2", username: "bob" } });
  r.gateway.ready(BOT);
  r.gateway.message({ id: "203", channel_id: CH, content: "missed b", author: { id: "u2" } }); // a replayed event
  await r.transport.idle();
  assert.deepEqual(
    r.delivered.map((m) => m.id),
    ["201", "202", "203"],
  );
  const catchUp = r.calls.filter(isList).at(-1)!;
  assert.equal(query(catchUp).get("after"), "201");
});

test("a failed delivery stalls live delivery; the next event catches up from the cursor in order", async () => {
  const r = rig([{ id: "200" }]);
  await r.transport.start!();
  r.gateway.ready(BOT);
  r.fail("201");
  r.gateway.message({ id: "201", channel_id: CH, content: "a", author: { id: "u1" } });
  await r.transport.idle();
  assert.ok(r.logs.some((l) => /delivery failed: pomtreed down/.test(l)));
  r.fail(null);
  r.history.push({ id: "201", channel_id: CH, content: "a", author: { id: "u1", username: "alice" } });
  r.history.push({ id: "202", channel_id: CH, content: "b", author: { id: "u1", username: "alice" } });
  r.gateway.message({ id: "202", channel_id: CH, content: "b", author: { id: "u1" } });
  await r.transport.idle();
  assert.deepEqual(
    r.delivered.map((m) => m.id),
    ["201", "202"],
  );
  r.transport.stop!();
});

const pressPayload = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) => {
  const customId = encodeAction({ id: AP, choice: { kind: "approve" } });
  return {
    id: "inter1",
    application_id: "app1",
    type: 3,
    token: "interaction-token-secret",
    version: 1,
    channel_id: CH,
    channel: { id: CH, type: 0 },
    member: { user: { id: "u1", username: "alice", global_name: "Alice" } },
    data: { custom_id: customId, component_type: 2 },
    message: {
      id: "m1",
      channel_id: CH,
      content: "[ask] approve publish?",
      author: { id: BOT, bot: true },
      components: [{ type: 1, components: [{ type: 2, style: 3, label: "Approve", custom_id: customId }] }],
      ...message,
    },
    ...over,
  };
};

test("INTERACTION_CREATE: a button press on the bot's own message in the channel is emitted without its token", async () => {
  const r = rig();
  const seen: DiscordInteraction[] = [];
  r.transport.onInteraction!((i) => {
    seen.push(i);
  });
  await r.transport.start!();
  r.gateway.ready(BOT);
  r.gateway.interaction(pressPayload({ channel_id: "other", channel: { id: "other", type: 0 } }));
  r.gateway.interaction(pressPayload({}, { author: { id: "someone-else", bot: true } }));
  r.gateway.interaction(pressPayload({ type: 2 })); // a slash command, not a component
  r.gateway.interaction(pressPayload({ data: { custom_id: "x", component_type: 3 } })); // a select menu
  r.gateway.interaction(pressPayload());
  await r.transport.idle();
  assert.equal(seen.length, 1);
  const i = seen[0]!;
  assert.deepEqual(
    { ...i, handle: undefined },
    {
      id: "inter1",
      userId: "u1",
      userName: "Alice",
      customId: encodeAction({ id: AP, choice: { kind: "approve" } }),
      messageId: "m1",
      channelId: CH,
      buttonLabel: "Approve",
      messageContent: "[ask] approve publish?",
      handle: undefined,
    },
  );
  assert.ok(!JSON.stringify(i).includes("interaction-token-secret"));
});

test("the bot id falls back to users/@me before READY", async () => {
  const r = rig();
  const seen: DiscordInteraction[] = [];
  r.transport.onInteraction!((i) => {
    seen.push(i);
  });
  r.gateway.interaction(pressPayload());
  await r.transport.idle();
  assert.equal(seen.length, 1);
  assert.ok(r.calls.some((c) => c.path === "/users/@me"));
});

test("deferUpdate sends DEFERRED_UPDATE_MESSAGE; editInteraction edits @original, removing or keeping buttons", async () => {
  const r = rig();
  const seen: DiscordInteraction[] = [];
  r.transport.onInteraction!((i) => {
    seen.push(i);
  });
  r.gateway.ready(BOT);
  r.gateway.interaction(pressPayload());
  await r.transport.idle();
  const i = seen[0]!;
  await r.transport.deferUpdate!(i);
  const cb = r.calls.at(-1)!;
  assert.equal(cb.method, "POST");
  assert.ok(cb.path.startsWith("/interactions/inter1/interaction-token-secret/callback"));
  assert.deepEqual(cb.body, { type: 6 });
  await r.transport.editInteraction!(i, "done", { buttons: [] });
  const edit = r.calls.at(-1)!;
  assert.equal(edit.method, "PATCH");
  assert.ok(edit.path.startsWith("/webhooks/app1/interaction-token-secret/messages/@original"));
  assert.deepEqual(edit.body, { content: "done", allowed_mentions: { parse: [] }, components: [] });
  await r.transport.editInteraction!(i, "failed, press again", {});
  assert.deepEqual(r.calls.at(-1)!.body, { content: "failed, press again", allowed_mentions: { parse: [] } });
  await assert.rejects(() => r.transport.deferUpdate!({ ...i, handle: {} }), /unknown interaction/);
});

test("send posts allowed_mentions parse:[] and lays buttons out in rows of five", async () => {
  const r = rig();
  assert.equal(await r.transport.send(CH, "@everyone hi"), "555");
  const buttons = Array.from({ length: 7 }, (_, n) => ({ customId: `c${n}`, label: `L${n}` }));
  await r.transport.send(CH, "ask", { buttons });
  const [plain, withButtons] = r.calls.filter((c) => c.method === "POST");
  assert.deepEqual(plain!.body, { content: "@everyone hi", allowed_mentions: { parse: [] } });
  const rows = (withButtons!.body as { components: { components: unknown[] }[] }).components;
  assert.deepEqual(
    rows.map((row) => row.components.length),
    [5, 2],
  );
  assert.equal(buttonRows(Array.from({ length: 30 }, (_, n) => ({ customId: `c${n}`, label: "x" }))).length, 5);
});

test("REST failures map to DiscordSendError: API error, rate limit, network, and the token is scrubbed", async () => {
  const forbidden = fakeRest(() => ({ status: 403, body: { code: 50001, message: "Missing Access" } }));
  const t1 = gatewayTransport({ token: "t", channelId: CH, gateway: new FakeGateway(), rest: forbidden.rest });
  await assert.rejects(
    () => t1.send(CH, "hi"),
    (e: unknown) => e instanceof DiscordSendError && e.status === 403 && e.retryAfterMs === null && /Missing Access/.test(e.message),
  );

  const limited = fakeRest(() => ({ status: 429, body: { message: "slow", retry_after: 7, global: false }, headers: { "retry-after": "7" } }), {
    rejectOnRateLimit: () => true,
  });
  const t2 = gatewayTransport({ token: "t", channelId: CH, gateway: new FakeGateway(), rest: limited.rest });
  await assert.rejects(
    () => t2.send(CH, "hi"),
    (e: unknown) => e instanceof DiscordSendError && e.status === 429 && e.retryAfterMs !== null && e.retryAfterMs >= 7000,
  );

  const down = fakeRest(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const t3 = gatewayTransport({ token: "t", channelId: CH, gateway: new FakeGateway(), rest: down.rest });
  await assert.rejects(
    () => t3.send(CH, "hi"),
    (e: unknown) => e instanceof DiscordSendError && e.status === 0 && /ECONNREFUSED/.test(e.message),
  );

  assert.equal(toSendError(new Error("bad /interactions/1/tok-123/callback"), "tok-123").message, "bad /interactions/1/[redacted]/callback");
  const already = new DiscordSendError(400, null, "x");
  assert.equal(toSendError(already), already);
});

test("end to end: a press through the real transport is deferred before pomtreed answers, then edited", async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const posted: InboundBody[] = [];
  const adapter = new DiscordAdapter({
    pomtreed: {
      outbox: async () => [],
      hostRead: async () => ({ status: 404, body: null }),
      postMessage: async (b): Promise<MessageReceipt> => {
        posted.push(b);
        await gate;
        return { kind: "answered", escalation: AP };
      },
    },
    discord: r.transport,
    outbox: { read: async () => emptyOutboxState(), write: async () => {} },
    channelId: CH,
    allowedSenders: ["u1"],
  });
  adapter.listen();
  r.gateway.ready(BOT);
  r.gateway.interaction(pressPayload());
  for (let n = 0; n < 100 && posted.length === 0; n++) await new Promise((res) => setImmediate(res));
  assert.equal(posted.length, 1);
  assert.ok(
    r.calls.some((c) => c.path.includes("/callback")),
    "deferred while pomtreed is pending",
  );
  assert.ok(!r.calls.some((c) => c.method === "PATCH"));
  release();
  await r.transport.idle();
  const edit = r.calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(edit.body, { content: "[ask] approve publish?\n— approve by Alice", allowed_mentions: { parse: [] }, components: [] });
  assert.equal(posted[0]!.idempotencyKey, "btn:m1:u1:a");
});
