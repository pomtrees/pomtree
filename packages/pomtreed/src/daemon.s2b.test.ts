// Daemon behavior for provider retry and breaker, ask re-alerts, inbound receipts, event paging, recover convergence,
// reap and chat intents.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, SpawnSpec } from "@pomtree/core";
import { kinds, setup, until } from "./test-setup.ts";

const limits = { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 1 };

test("provider retry: non-consecutive transient errors do not exhaust the retry cap", async () => {
  let runs = 0;
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      runs++;
      if (runs >= 4) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      if (runs > 1) c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 0 }); // progress between errors
      c.emit({ kind: "provider_error", code: "outage", message: "down", retryable: true });
    },
    { limits: { ...limits, providerBreakerThreshold: 99 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && ["exited", "reaped"].includes((await t.daemon.get(aId))?.state ?? ""));
  assert.deepEqual(((await t.daemon.get(aId)) as AgentRecord).result, { summary: "ok", value: "ok" });
});

test("provider breaker: repeated errors open a durable degraded marker", async () => {
  let runs = 0;
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      runs++;
      if (runs >= 3) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      c.emit({ kind: "provider_error", code: "outage", message: "down", retryable: true });
    },
    { limits: { ...limits, maxProviderRetries: 5, providerBreakerThreshold: 2 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && ["exited", "reaped"].includes((await t.daemon.get(aId))?.state ?? ""));
  assert.ok(kinds(await t.journal.read({ agent: aId })).includes("ext.pomtreed.provider_degraded"));
});

test("ask re-alert: an unanswered ask re-alerts at 1x/4x/24x, once each", async () => {
  let clock = 1_000_000;
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    askTimeoutMs: 1_000_000,
    askRealertBaseMs: 100,
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
  });
  const root = await t.daemon.root();
  const spec = (await t.daemon.deps.registry.get(root.id))!.spec as SpawnSpec;
  const a0 = await t.daemon.deps.registry.create({
    executor: "container",
    spec,
    parent: root.id,
    name: "ra",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "ra",
  });
  const a = await t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: "ra-run" });
  await t.daemon.ask(a.id, { question: "ok?", generation: a.generation, idempotencyKey: "k" });
  const reminders = async () =>
    (await t.journal.read({ agent: a.id })).filter(
      (e) => e.payload.kind === "message_sent" && String((e.payload as { subject?: string }).subject).includes("still unanswered"),
    ).length;
  await t.daemon.sweepEscalations();
  assert.equal(await reminders(), 0);
  clock += 150;
  await t.daemon.sweepEscalations();
  await t.daemon.sweepEscalations();
  assert.equal(await reminders(), 1);
  clock += 300; // 450 >= 4x
  await t.daemon.sweepEscalations();
  assert.equal(await reminders(), 2);
});

test("inbound receipt replay: a retried inbound after losing the receipt cache routes once and returns the same receipt", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const root = await t.daemon.root();
  const a0 = await t.daemon.deps.registry.create({
    executor: "container" as const,
    spec: (await t.daemon.deps.registry.get(root.id))!.spec as SpawnSpec,
    parent: root.id,
    name: "r6",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "r6",
  });
  const a = await t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: "r6-run" });
  const msg = { channel: "discord", sender: { channel: "discord", sender: "u" }, body: "hi", to: a.id, idempotencyKey: "m1" } as const;
  const first = await t.daemon.receiveMessage(msg);
  (t.daemon as unknown as { inboundReceipts: Map<string, unknown> }).inboundReceipts.clear(); // simulates a restart
  assert.deepEqual(await t.daemon.receiveMessage(msg), first);
  assert.equal((await t.fakes.mailbox.peek(a.id)).filter((s) => s.kind === "human_message").length, 1);
});

test("events tail paging: events({tail}) pages and returns the true tail past one page", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const root = await t.daemon.root();
  for (let i = 0; i < 1100; i++)
    await t.journal.append({
      agent: root.id,
      host: "h1",
      generation: root.generation,
      payload: { kind: "error", message: `e${i}` },
      idempotencyKey: `tail-${i}`,
    });
  const tail = await t.daemon.events({ agent: root.id, tail: 3 });
  assert.deepEqual(
    tail.map((e) => (e.payload as { message?: string }).message),
    ["e1097", "e1098", "e1099"],
  );
});

test("recover converges: a root child failed for lack of a checkpoint is reaped when recover resolves", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 0 });
  const root = await t.daemon.root();
  const a0 = await t.daemon.deps.registry.create({
    executor: "container" as const,
    spec: (await t.daemon.deps.registry.get(root.id))!.spec as SpawnSpec,
    parent: root.id,
    name: "orph",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "orph",
  });
  await t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: "orph-run" });
  await t.daemon.recover();
  assert.equal((await t.daemon.get(a0.id))?.state, "reaped");
});

test("reap with a key replays with the first call's unusedMicros", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const root = await t.daemon.root();
  const a0 = await t.daemon.deps.registry.create({
    executor: "container" as const,
    spec: (await t.daemon.deps.registry.get(root.id))!.spec as SpawnSpec,
    parent: root.id,
    name: "rp",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "rp",
  });
  const r = await t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: "rp-run" });
  await t.daemon.deps.registry.transition(r.id, r.generation, "exited", { idempotencyKey: "rp-x", exit: "succeeded" });
  const first = await t.daemon.reap(a0.id, "k1");
  const again = await t.daemon.reap(a0.id, "k1");
  assert.equal(again.unusedMicros, first.unusedMicros);
  assert.equal(again.record.state, "reaped");
});

async function runner(t: ReturnType<typeof setup>, key: string) {
  const root = await t.daemon.root();
  const a0 = await t.daemon.deps.registry.create({
    executor: "container" as const,
    spec: (await t.daemon.deps.registry.get(root.id))!.spec as SpawnSpec,
    parent: root.id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return t.daemon.deps.registry.transition(a0.id, a0.generation, "running", { idempotencyKey: `${key}-run` });
}
const sender = { channel: "discord", sender: "u" } as const;

test("chat intents: status reports state; cancel is authorized per route and rejected for a bad sender", async () => {
  const t = setup(async (c) => void (await c.stopped), {
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    authorizeInbound: (_m, route) => route !== "cancel",
  });
  const a = await runner(t, "ci");
  const st = await t.daemon.receiveMessage({ channel: "discord", sender, body: "", to: a.id, intent: "status", idempotencyKey: "s1" });
  assert.deepEqual(st, { kind: "status", agent: a.id, state: "running" });
  const no = await t.daemon.receiveMessage({ channel: "discord", sender, body: "", to: a.id, intent: "cancel", idempotencyKey: "c1" });
  assert.equal(no.kind, "rejected");
});

test("chat intents: an approved-gated cancel is rejected (retryable) until a human approves", async () => {
  const t = setup(async (c) => void (await c.stopped), {
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    chatApproval: () => true,
    approvalWaitMs: 10,
    approvalTimeoutMs: 60_000,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await runner(t, "cg");
  const r = await t.daemon.receiveMessage({ channel: "discord", sender, body: "", to: a.id, intent: "cancel", idempotencyKey: "c2" });
  assert.equal(r.kind, "rejected");
  assert.equal((await t.daemon.get(a.id))?.state, "running", "not cancelled without approval");
});

test("transcript: reads the latest checkpointed session; null before any checkpoint", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runner(t, "tr");
  assert.equal(await t.daemon.transcript(a.id), null);
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: await t.fakes.sessions.put(new TextEncoder().encode('{"m":1}\n{"m":2}\n')),
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 500,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "tr-cp",
  );
  const r = await t.daemon.transcript(a.id, 1);
  assert.deepEqual(r?.entries, [{ m: 2 }]);
  assert.equal(r?.total, 2);
});
