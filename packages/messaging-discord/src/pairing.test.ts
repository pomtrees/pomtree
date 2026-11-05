import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordAdapter } from "./adapter.ts";
import { buttonJson } from "./discord.ts";
import { emptyOutboxState } from "./cursor.ts";
import type { DiscordInbound, DiscordInteraction, DiscordTransport, InboundBody, SendOptions } from "./types.ts";

function setup() {
  const sent: { content: string; opts?: SendOptions }[] = [];
  let ih: ((i: DiscordInteraction) => void | Promise<void>) | undefined;
  const transport: DiscordTransport = {
    async send(_c, content, opts) {
      sent.push({ content, ...(opts ? { opts } : {}) });
      return "m";
    },
    onMessage: () => () => {},
    isBotAuthored: async () => false,
    onInteraction(h) {
      ih = h;
      return () => {};
    },
  };
  const posted: InboundBody[] = [];
  const adapter = new DiscordAdapter({
    pomtreed: {
      outbox: async () => [],
      postMessage: async (b) => (posted.push(b), { kind: "signaled", to: "a1" }),
      hostRead: async () => ({ status: 404, body: null }),
    },
    discord: transport,
    outbox: { read: async () => emptyOutboxState(), write: async () => {} },
    channelId: "c",
    allowedSenders: ["admin"],
  });
  adapter.listen();
  const msg = (id: string, authorId: string, body: string): DiscordInbound => ({ id, authorId, body });
  const press = (i: Pick<DiscordInteraction, "id" | "userId" | "customId">) => ih!({ messageId: "m", channelId: "c", handle: {}, ...i });
  return { adapter, sent, posted, msg, press };
}

test("pairing: unlisted sender is rejected, then approved by button and may tell", async () => {
  const { adapter, sent, posted, msg, press } = setup();
  const r = await adapter.handleInbound(msg("1", "bob", "!pair"));
  assert.equal(r.kind, "rejected");
  const prompt = sent.find((s) => s.opts?.buttons);
  assert.deepEqual(
    prompt?.opts?.buttons?.map((b) => b.customId),
    ["pair:approve:bob", "pair:deny:bob"],
  );
  await adapter.handleInbound(msg("2", "bob", "!tell a1 hi"));
  assert.equal(posted.length, 0);
  await press({ id: "i1", userId: "bob", customId: "pair:approve:bob" }); // not configured: ignored
  await adapter.handleInbound(msg("3", "bob", "!tell a1 hi"));
  assert.equal(posted.length, 0);
  await press({ id: "i2", userId: "admin", customId: "pair:approve:bob" });
  await adapter.handleInbound(msg("4", "bob", "!tell a1 hi"));
  assert.equal(posted.length, 1);
});

test("pairing: deny, unrequested approve, and paired senders cannot approve others", async () => {
  const { adapter, posted, msg, press } = setup();
  await adapter.handleInbound(msg("1", "bob", "!pair"));
  await press({ id: "i", userId: "admin", customId: "pair:deny:bob" });
  await adapter.handleInbound(msg("2", "admin", "!approve bob")); // no longer pending
  await adapter.handleInbound(msg("3", "bob", "!tell a1 hi"));
  assert.equal(posted.length, 0);
  await adapter.handleInbound(msg("4", "bob", "!pair"));
  await adapter.handleInbound(msg("5", "admin", "!approve bob"));
  await adapter.handleInbound(msg("6", "eve", "!pair"));
  await adapter.handleInbound(msg("7", "bob", "!approve eve")); // paired, not configured
  await adapter.handleInbound(msg("8", "eve", "!tell a1 hi"));
  assert.equal(posted.length, 0);
});

test("buttonJson maps to a Discord component", () => {
  assert.deepEqual(buttonJson({ customId: "x", label: "X", style: "danger" }), { type: 2, style: 4, label: "X", custom_id: "x" });
});

test("restart: reply to an unknown-owner bot message is denied unless sender is on every allowlist", async () => {
  const posted: InboundBody[] = [];
  const mk = () =>
    new DiscordAdapter({
      pomtreed: {
        outbox: async () => [],
        postMessage: async (b) => (posted.push(b), { kind: "signaled", to: "a1" }),
        hostRead: async () => ({ status: 404, body: null }),
      },
      discord: { send: async () => "m", onMessage: () => () => {}, isBotAuthored: async () => false },
      outbox: { read: async () => emptyOutboxState(), write: async () => {} },
      channelId: "c",
      allowedSenders: ["u1", "u2"],
      agentAllowlists: { a1: ["u1"], a2: ["u1", "u2"] },
    });
  const reply = (authorId: string): DiscordInbound => ({ id: authorId, authorId, body: "yes", replyToId: "old-bot-msg" });
  const a = mk(); // fresh instance = post-restart: agentByMessage is empty
  assert.equal((await a.handleInbound(reply("u2"))).kind, "rejected");
  assert.equal(posted.length, 0);
  await a.handleInbound(reply("u1"));
  assert.equal(posted.length, 1);
});
