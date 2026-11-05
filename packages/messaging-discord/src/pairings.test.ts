import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DiscordAdapter } from "./adapter.ts";
import { loadConfig } from "./config.ts";
import { emptyOutboxState } from "./cursor.ts";
import { filePairingStore, formatPairings, parsePairings } from "./pairings.ts";
import type { PairingStore } from "./pairings.ts";
import type { DiscordInbound, InboundBody } from "./types.ts";

function withDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdpair-"));
    try {
      await fn(dir);
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// A store whose writes always fail (a full disk); reads see no pairings.
const failingStore = (): PairingStore => ({
  read: async () => [],
  write: async () => {
    throw new Error("disk full at /secret/path");
  },
});

function adapterFor(path: string | PairingStore, log: string[] = [], posted: InboundBody[] = []) {
  return new DiscordAdapter({
    pomtreed: {
      outbox: async () => [],
      hostRead: async () => ({ status: 404, body: null }),
      postMessage: async (b) => {
        posted.push(b);
        return { kind: "signaled", to: "a1" };
      },
    },
    discord: { send: async () => "m", onMessage: () => () => {}, isBotAuthored: async () => false },
    outbox: { read: async () => emptyOutboxState(), write: async () => {} },
    channelId: "c",
    allowedSenders: ["admin"],
    pairings: typeof path === "string" ? filePairingStore(path) : path,
    log: (l) => log.push(l),
  });
}

const reasonOf = (r: unknown) => (r as { reason: string }).reason;
const msg = (id: string, authorId: string, body: string): DiscordInbound => ({ id, authorId, body });

test(
  "pairings persist across restarts: approved sender may tell after a fresh adapter loads the file",
  withDir(async (dir) => {
    const path = join(dir, "pairings.json");
    const first = adapterFor(path);
    await first.handleInbound(msg("1", "bob", "!pair"));
    assert.equal(reasonOf(await first.handleInbound(msg("2", "admin", "!approve bob"))), "paired bob");
    const text = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(text), { version: 1, paired: ["bob"] });
    assert.equal(text, formatPairings(["bob"]));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
    );

    const posted: InboundBody[] = [];
    const second = adapterFor(path, [], posted);
    await second.handleInbound(msg("3", "bob", "!tell a1 hi"));
    assert.equal(posted.length, 1);
  }),
);

test(
  "a rewritten pairings file is mode 0600",
  { skip: process.platform === "win32" && "POSIX file modes do not apply on win32" },
  withDir(async (dir) => {
    const path = join(dir, "pairings.json");
    writeFileSync(path, formatPairings([]), { mode: 0o644 });
    chmodSync(path, 0o644);
    const a = adapterFor(path);
    await a.handleInbound(msg("1", "bob", "!pair"));
    await a.handleInbound(msg("2", "admin", "!approve bob"));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }),
);

test(
  "a missing pairings file means no pairings and is not an error",
  withDir(async (dir) => {
    const log: string[] = [];
    const posted: InboundBody[] = [];
    const a = adapterFor(join(dir, "none.json"), log, posted);
    await a.handleInbound(msg("1", "bob", "!tell a1 hi"));
    assert.equal(posted.length, 0);
    assert.ok(!log.some((l) => /pairings load failed/.test(l)));
  }),
);

test(
  "a corrupt pairings file fails closed: logged, no pairings admitted, approvals refused without overwriting it",
  withDir(async (dir) => {
    const path = join(dir, "pairings.json");
    writeFileSync(path, "{not json");
    const log: string[] = [];
    const posted: InboundBody[] = [];
    const a = adapterFor(path, log, posted);
    await a.handleInbound(msg("1", "bob", "!pair"));
    const reply = reasonOf(await a.handleInbound(msg("2", "admin", "!approve bob")));
    assert.match(reply, /could not be loaded; fix or remove the file and restart the adapter$/);
    await a.handleInbound(msg("3", "bob", "!tell a1 hi"));
    assert.equal(posted.length, 0);
    assert.equal(readFileSync(path, "utf8"), "{not json");
    assert.ok(log.some((l) => /pairings load failed/.test(l)));
  }),
);

test(
  "an unreadable pairings path (a directory, EISDIR) is a load failure, not an empty pairing set",
  withDir(async (dir) => {
    const path = join(dir, "is-a-dir");
    mkdirSync(path);
    const log: string[] = [];
    const posted: InboundBody[] = [];
    const a = adapterFor(path, log, posted);
    await a.handleInbound(msg("1", "bob", "!pair"));
    assert.match(reasonOf(await a.handleInbound(msg("2", "admin", "!approve bob"))), /restart the adapter$/);
    assert.ok(log.some((l) => /pairings load failed.*EISDIR/.test(l)));
    await a.handleInbound(msg("3", "bob", "!tell a1 hi"));
    assert.equal(posted.length, 0);
  }),
);

test("malformed pairings are rejected as corrupt", () => {
  assert.throws(() => parsePairings('{"version":2,"paired":[]}'), /version/);
  assert.throws(() => parsePairings('{"version":1,"paired":["ok",""]}'), /non-empty/);
  assert.throws(() => parsePairings('{"version":1,"paired":[1]}'), /non-empty/);
  assert.throws(() => parsePairings("[]"), /JSON object/);
  assert.throws(() => parsePairings(""), /JSON/);
  assert.deepEqual(parsePairings('{"version":1,"paired":["b","a","a"]}'), ["a", "b"]);
});

test(
  "a failed pairings write is reported without the fs message; the sender stays pending and unpaired",
  withDir(async () => {
    const log: string[] = [];
    const posted: InboundBody[] = [];
    const a = adapterFor(failingStore(), log, posted);
    await a.handleInbound(msg("1", "bob", "!pair"));
    const reply = reasonOf(await a.handleInbound(msg("2", "admin", "!approve bob")));
    assert.equal(reply, "pairing not saved for bob (write failed); still pending");
    assert.ok(log.some((l) => /pairing save failed for bob: disk full at \/secret\/path/.test(l)));
    await a.handleInbound(msg("3", "bob", "!tell a1 hi"));
    assert.equal(posted.length, 0);
  }),
);

test(
  "a real write failure (read-only directory, EACCES) leaves no temp file and the sender pending",
  {
    skip:
      process.platform === "win32" ? "directory permissions do not apply on win32" : process.getuid?.() === 0 ? "root bypasses directory permissions" : false,
  },
  withDir(async (dir) => {
    const path = join(dir, "pairings.json");
    writeFileSync(path, formatPairings(["admin-paired"]));
    const log: string[] = [];
    const posted: InboundBody[] = [];
    const a = adapterFor(path, log, posted);
    await a.handleInbound(msg("1", "bob", "!pair"));
    chmodSync(dir, 0o555);
    const reply = reasonOf(await a.handleInbound(msg("2", "admin", "!approve bob")));
    chmodSync(dir, 0o755);
    assert.equal(reply, "pairing not saved for bob (EACCES); still pending");
    assert.ok(!reply.includes(dir));
    assert.ok(log.some((l) => /pairing save failed for bob: .*EACCES/.test(l)));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
    );
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, paired: ["admin-paired"] });
    await a.handleInbound(msg("3", "bob", "!tell a1 hi"));
    assert.equal(posted.length, 0);
  }),
);

test(
  "a button approval that fails to persist is reported in the channel without the fs message",
  withDir(async () => {
    const sent: string[] = [];
    const a = new DiscordAdapter({
      pomtreed: { outbox: async () => [], hostRead: async () => ({ status: 404, body: null }), postMessage: async () => ({ kind: "signaled", to: "a1" }) },
      discord: {
        send: async (_c, content) => {
          sent.push(content);
          return "m";
        },
        onMessage: () => () => {},
        isBotAuthored: async () => false,
      },
      outbox: { read: async () => emptyOutboxState(), write: async () => {} },
      channelId: "c",
      allowedSenders: ["admin"],
      pairings: failingStore(),
    });
    await a.handleInbound(msg("1", "bob", "!pair"));
    const reply = await a.handleInteraction({ id: "i", userId: "admin", customId: "pair:approve:bob", messageId: "m", channelId: "c", handle: {} });
    assert.equal(reply, "pairing not saved for bob (write failed); still pending");
  }),
);

test(
  "concurrent approvals of two ids both persist and neither is lost",
  withDir(async (dir) => {
    const path = join(dir, "pairings.json");
    const a = adapterFor(path);
    await a.handleInbound(msg("1", "bob", "!pair"));
    await a.handleInbound(msg("2", "eve", "!pair"));
    const [rb, re] = await Promise.all([a.handleInbound(msg("3", "admin", "!approve bob")), a.handleInbound(msg("4", "admin", "!approve eve"))]);
    assert.equal(reasonOf(rb), "paired bob");
    assert.equal(reasonOf(re), "paired eve");
    assert.deepEqual(await filePairingStore(path).read(), ["bob", "eve"]);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
    );
  }),
);

// A store whose first write waits for `release`, so a deny can race an in-flight approval write.
function gatedStore() {
  const s = {
    file: [] as string[],
    writes: [] as string[][],
    hold: undefined as Promise<void> | undefined,
    release: () => {},
    read: async () => [...s.file],
    write: async (ids: readonly string[]) => {
      s.writes.push([...ids]);
      const h = s.hold;
      s.hold = undefined;
      if (h) await h;
      s.file = [...ids];
    },
  };
  return s;
}

test("a deny that races an in-flight approve write wins: sender not paired and not left in the file", async () => {
  const store = gatedStore();
  const posted: InboundBody[] = [];
  const a = adapterFor(store, [], posted);
  await a.handleInbound(msg("1", "bob", "!pair"));
  store.hold = new Promise<void>((resolve) => {
    store.release = resolve;
  });
  const approving = a.handleInbound(msg("2", "admin", "!approve bob"));
  for (let i = 0; i < 100 && store.writes.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(store.writes.length, 1, "approve write should be in flight");
  assert.equal(await a.handleInteraction({ id: "i", userId: "admin", customId: "pair:deny:bob", messageId: "m", channelId: "c", handle: {} }), "denied bob");
  store.release();
  assert.match(reasonOf(await approving), /denied/);
  assert.deepEqual(store.file, []);
  await a.handleInbound(msg("3", "bob", "!tell a1 hi"));
  assert.equal(posted.length, 0);
});

test("loadConfig defaults the pairings file and reads DISCORD_PAIRINGS_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "mdcfg-"));
  try {
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "ht.discord.tok");
    const env: NodeJS.ProcessEnv = { POMTREED_MESSAGING_TOKEN: tokenPath, DISCORD_TOKEN: "dt", DISCORD_CHANNEL_ID: "ch" };
    assert.equal(loadConfig(env).pairingsPath, "./messaging.discord.pairings.json");
    env.DISCORD_PAIRINGS_FILE = "/tmp/x.json";
    assert.equal(loadConfig(env).pairingsPath, "/tmp/x.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
