import assert from "node:assert/strict";
import { test } from "node:test";
import type { Server } from "node:http";
import { listenHost, issueToken } from "@pomtree/pomtreed";
import { MESSAGING_WIRE_CLAUSES, brokenBootDaemon, messagingWireSuite, runMessagingWireClause, stubWireAdapter } from "@pomtree/testing";
import type { MessagingWireAdapter, MessagingWireClauseId, MessagingWireDaemon, MessagingWireFixture } from "@pomtree/testing";
import { messagingSendersError, buildChannelRegistry } from "../../pomtreed/src/channels.ts";
import { pomtreedClient } from "../../messaging-discord/src/client.ts";
import { stdioClient } from "../../messaging-stdio/src/client.ts";
import { SECRET, rig, until } from "./harness.ts";

// The adapter-agnostic wire contract (packages/testing messaging-wire-contract.ts) against the REAL pomtreed handlers over a real host
// TCP listener and real store-sqlite: the Discord adapter's wire client, the stdio adapter, and the reference stub must all pass,
// and a stub broken on each clause must fail that clause. Offline and Docker-free. An adapter that is not in this repo adds one
// `messagingWireSuite(...)` line here, or runs the same suite in its own repository against its own pomtreed.

const daemon: MessagingWireDaemon = {
  async start({ channel, senders }): Promise<MessagingWireFixture> {
    let release!: () => void;
    const hold = new Promise<void>((res) => (release = res));
    const allowed = new Set(senders);
    const r = rig({
      play: () => ({ hold, result: { status: "succeeded", result: null } }),
      deps: {
        messagingChannels: [channel],
        escalationChannels: [channel],
        // TODO(seam-allowlist-hook): mirrors the inline authorizeInbound lambda in pomtreed main.ts; pomtreed should export the hook builder so this fixture uses the real one. Current behavior: a copy of the one-line check.
        authorizeInbound: (m) => allowed.has(`${m.sender.channel}:${m.sender.sender}`),
      },
    });
    let server: Server | undefined;
    const close = async () => {
      server?.close();
      server?.closeAllConnections();
      release();
      await r.orchestrator.idle();
      r.store.close();
    };
    try {
      const a = await r.daemon.spawn((await r.daemon.root()).id, { name: "w", task: "t", idempotencyKey: "w" });
      await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");
      const l = await listenHost(r.daemon, "127.0.0.1", 0);
      server = l.server;
      return {
        baseUrl: `http://127.0.0.1:${l.port}`,
        token: (kind, ch = channel) =>
          kind === "host"
            ? issueToken(SECRET, { scope: "host", channel: ch })
            : kind === "operator"
              ? issueToken(SECRET, { scope: "operator" })
              : kind === "agent"
                ? r.daemon.agentToken(a.id, a.generation)
                : "garbage",
        agent: a.id,
        ask: async (question, idempotencyKey) => (await r.daemon.ask(a.id, { question, generation: a.generation, idempotencyKey })).escalation.id,
        failedCount: async () => (await r.daemon.events({ agent: (await r.daemon.root()).id })).filter((e) => e.payload.kind === "message_failed").length,
        close,
      };
    } catch (e) {
      await close();
      throw e;
    }
  },
  bootError: ({ channels, senders }) => messagingSendersError(buildChannelRegistry(channels, channels), new Set(senders)),
};

// Glue only: the adapters' own client types are narrower (channel "discord") than the suite's generic wire client, so cast here.
const discordAdapter: MessagingWireAdapter = {
  name: "discord",
  channel: "discord",
  connect: (baseUrl, token) => {
    const c = pomtreedClient(baseUrl, token);
    const messageFailed = c.messageFailed;
    assert.ok(messageFailed, "the discord pomtreedClient must implement messageFailed");
    return {
      outbox: (from) => c.outbox(from),
      postMessage: (b) => c.postMessage(b as never),
      messageFailed: (b) => messageFailed(b as never),
      hostRead: (p, s) => c.hostRead(p, s),
    };
  },
};

const stdioAdapter: MessagingWireAdapter = { name: "stdio", channel: "stdio", connect: (baseUrl, token) => stdioClient(baseUrl, token, "stdio") };

messagingWireSuite(discordAdapter, daemon);
messagingWireSuite(stdioAdapter, daemon);
messagingWireSuite(stubWireAdapter("stub"), daemon);

// The INNER failure each control must produce (the clause's own assertion, carried as `cause`), so a crash or a network error in the
// stub or the fixture cannot pass as the expected violation.
const EXPECTED_INNER: Record<MessagingWireClauseId, RegExp> = {
  "version-handshake": /another messaging API version must be refused/,
  "host-token-scope": /must reject a .* token/,
  "outbox-cursor": /from=seq\+1 excludes the entry/,
  "post-idempotent": /a replayed key returns the remembered receipt/,
  "sender-allowlist-boot": /an empty allowlist must refuse to boot/,
  "unknown-sender": /a sender off the allowlist must get a rejected receipt/,
  "outbox-redelivery": /the same key is journaled once/,
  "host-read": /a hostRead with a sender is served/,
};

for (const { id } of MESSAGING_WIRE_CLAUSES) {
  test(`negative control [${id}]: a stub broken on ${id} fails that clause with a clear message`, async () => {
    const run =
      id === "sender-allowlist-boot"
        ? runMessagingWireClause(id, stubWireAdapter("stub"), brokenBootDaemon(daemon))
        : runMessagingWireClause(id, stubWireAdapter("stub", id), daemon);
    await assert.rejects(run, (e: Error) => {
      assert.match(e.message, new RegExp(`^messaging wire contract \\[${id}\\] violated by `));
      assert.ok(e.message.includes(" Fix: "), e.message);
      assert.match((e.cause as Error).message, EXPECTED_INNER[id]);
      return true;
    });
  });
}
