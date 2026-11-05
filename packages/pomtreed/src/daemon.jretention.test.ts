import assert from "node:assert/strict";
import { test } from "node:test";
import { get, setup, spawnSpec, until } from "./test-setup.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { parseJournalRetentionEnv } from "./daemon-util.ts";

test("gateway.spend is the journal.spendFor total plus the unpriced tokens at the rate table", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "sp",
    task: "t",
    host: "h1",
    budgetMicros: 99,
    idempotencyKey: "sp",
  });
  await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: "sp-run" });
  const evs = [
    { inputTokens: 1234, outputTokens: 567, costMicros: 0 },
    { inputTokens: 10, outputTokens: 3, costMicros: 42 },
    { inputTokens: 77, outputTokens: 91, costMicros: 0 },
  ];
  for (const [i, u] of evs.entries())
    await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "usage", ...u }, idempotencyKey: `u${i}` });
  const base = {
    journal: t.journal,
    registry: t.daemon.deps.registry,
    secret: "s",
    proxyBaseUrl: "http://m",
    tokenTtlMs: 60_000,
    rates: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
  };
  const spend = await new ProxyCredentialGateway(base).spend(a.id);
  assert.equal(spend.budgetMicros, 99);
  assert.equal(spend.spentMicros, 42 + Math.ceil((1311 * 3_000_000 + 658 * 15_000_000) / 1_000_000));
});

test("parseJournalRetentionEnv: off by default, validated fail-closed", () => {
  assert.equal(parseJournalRetentionEnv({}), null);
  assert.deepEqual(parseJournalRetentionEnv({ POMTREED_JOURNAL_RETENTION_MS: "1000", POMTREED_JOURNAL_KEEP_PER_AGENT: "5" }), {
    retentionMs: 1000,
    keepPerAgent: 5,
  });
  assert.throws(() => parseJournalRetentionEnv({ POMTREED_JOURNAL_RETENTION_MS: "abc" }));
  assert.throws(() => parseJournalRetentionEnv({ POMTREED_JOURNAL_RETENTION_MS: "0" }));
  assert.throws(() => parseJournalRetentionEnv({ POMTREED_JOURNAL_RETENTION_MS: "10", POMTREED_JOURNAL_KEEP_PER_AGENT: "-1" }));
  assert.throws(() => parseJournalRetentionEnv({ POMTREED_JOURNAL_KEEP_PER_AGENT: "5" }));
});

test("stale lost-wake signal: a signal queued before the yield checkpoint does not re-wake after restart; a later one does", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    aId = c.agent;
    const root = await t.daemon.root();
    await t.daemon.deps.mailbox.send(aId, { kind: "message", from: root.id, body: "old" }, "stale-1"); // already seen before yielding
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  await t.orchestrator.idle();
  const d = t.daemon as unknown as { lostWakeScanned: boolean };
  d.lostWakeScanned = false; // simulate a fresh boot
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded", "stale signal did not re-wake");
  const root = await t.daemon.root();
  await t.daemon.deps.mailbox.send(aId, { kind: "message", from: root.id, body: "new" }, "fresh-1");
  d.lostWakeScanned = false;
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.ok(
    (await t.journal.read({ agent: aId })).some((e) => e.payload.kind === "resumed"),
    "fresh signal woke it",
  );
});
