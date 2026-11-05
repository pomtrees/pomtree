import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { EXPIRED_ANSWER, EXPIRED_BY } from "./daemon-util.ts";
import { issueToken, issueUiCookie } from "./auth.ts";
import { SECRET, op, setup, spawnSpec } from "./test-setup.ts";

// A running, non-root agent created straight in the registry (no live drive handle), like the watchdog tests.
async function runningAgent(t: ReturnType<typeof setup>, key: string, budgetMicros = 1_000): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros, idempotencyKey: key });
  return t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
}

const host = (channel: string) => issueToken(SECRET, { scope: "host", channel });

test("ask creates an escalation, journals it, and writes the outbox", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const { escalation, delivered } = await t.daemon.ask(a.id, { question: "approve?", options: ["yes", "no"], generation: a.generation, idempotencyKey: "k1" });

  assert.equal(delivered, true);
  assert.equal(escalation.agent, a.id);
  assert.equal(escalation.question, "approve?");
  assert.deepEqual(escalation.options, ["yes", "no"]);
  assert.equal(escalation.state, "open");

  const entries = await t.journal.read({ agent: a.id });
  const kinds = entries.map((e) => e.payload.kind);
  assert.ok(kinds.includes("escalation_raised"));

  const outbox = await t.daemon.outbox({ channel: "discord" });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.payload.kind, "message_sent");
  assert.equal((outbox[0]!.payload as { purpose: string; subject: string }).purpose, "ask");
  assert.equal((outbox[0]!.payload as { subject: string }).subject, "approve?");
  assert.equal((outbox[0]!.payload as { replyTo?: string }).replyTo, escalation.id);
});

test("ask without an escalation channel reports not delivered and writes no outbox entry", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const { delivered } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });
  assert.equal(delivered, false);
  assert.equal((await t.daemon.outbox({ channel: "discord" })).length, 0);
});

test("ask with a stale generation surfaces as 409 on the route", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const res = await handle(t.daemon, {
    method: "POST",
    url: "/v1/agents/self/ask",
    token: t.daemon.agentToken(a.id),
    body: { question: "q?", generation: a.generation + 1, idempotencyKey: "k1" },
  });
  assert.equal(res.status, 409);
});

test("waitAsk blocks until answered, then returns the answered escalation", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const waiting = t.daemon.waitAsk(a.id, escalation.id, 2_000);
  setTimeout(() => {
    void t.daemon.answerEscalation(escalation.id, "yes", { channel: "discord", sender: "alice" }, "ak");
  }, 20);
  const esc = await waiting;
  assert.equal(esc.state, "answered");
  assert.equal(esc.answer, "yes");
});

test("answerEscalation journals escalation_answered and delivers a human_answer signal", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const esc = await t.daemon.answerEscalation(escalation.id, "yes", { channel: "discord", sender: "alice", name: "Alice" }, "ak");
  assert.equal(esc.state, "answered");

  const box = await t.daemon.deps.mailbox.peek(a.id);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "human_answer");
  assert.equal((box[0] as { body: string }).body, "yes");
  assert.equal((box[0] as { from: { sender: string } }).from.sender, "alice");

  const entries = await t.journal.read({ agent: a.id });
  const answered = entries.find((e) => e.payload.kind === "escalation_answered");
  assert.ok(answered);
  assert.equal((answered!.payload as { answer: string }).answer, "yes");
});

test("budget route returns remaining against the agent's carve", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "b", 1_000);
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 300 },
    idempotencyKey: "u1",
  });
  const res = await handle(t.daemon, { method: "GET", url: "/v1/agents/self/budget", token: t.daemon.agentToken(a.id) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { budgetMicros: 1_000, remainingMicros: 700 });
});

test("messages routes require a host credential", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const body = { channel: "discord", sender: "alice", body: "hi", to: a.id, idempotencyKey: "m1" };
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/messages", token: op, body })).status, 403);
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/messages", token: t.daemon.agentToken(a.id), body })).status, 403);
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/messages", body })).status, 401);
});

test("a valid host token posts and polls, and a wrong-channel token is rejected", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord", "slack"] });
  const a = await runningAgent(t, "a");
  const discordTok = host("discord");

  const ok = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    token: discordTok,
    body: { channel: "discord", sender: "alice", body: "hi", to: a.id, idempotencyKey: "m1" },
  });
  assert.equal(ok.status, 201);
  assert.equal((ok.body as { kind: string }).kind, "signaled");

  const wrong = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    token: discordTok,
    body: { channel: "slack", sender: "alice", body: "hi", to: a.id, idempotencyKey: "m2" },
  });
  assert.equal(wrong.status, 403);

  const out = await handle(t.daemon, { method: "GET", url: "/v1/messages?channel=discord&from=0", token: discordTok });
  assert.equal(out.status, 200);
});

test("receiveMessage routes to a human_message signal and is idempotent", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const msg = { channel: "discord", sender: { channel: "discord", sender: "alice" }, body: "hi", to: a.id, idempotencyKey: "m1" };

  const r1 = await t.daemon.receiveMessage(msg);
  assert.deepEqual(r1, { kind: "signaled", to: a.id });
  const r2 = await t.daemon.receiveMessage(msg); // replay: same receipt, no double route
  assert.deepEqual(r2, r1);

  const box = await t.daemon.deps.mailbox.peek(a.id);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "human_message");
  assert.equal((box[0] as { body: string }).body, "hi");
});

test("receiveMessage answers an escalation via replyTo", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const receipt = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "alice" },
    body: "yes",
    replyTo: escalation.id,
    idempotencyKey: "m1",
  });
  assert.deepEqual(receipt, { kind: "answered", escalation: escalation.id });
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "answered");
});

test("receiveMessage spawns a root child only when allowed", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], messagingAllowSpawn: true });
  const receipt = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "alice" },
    body: "do work",
    intent: "spawn",
    idempotencyKey: "m1",
  });
  assert.equal(receipt.kind, "spawned");
  const child = await t.daemon.get((receipt as { agent: string }).agent);
  assert.ok(child);
  assert.equal(child!.task, "do work");

  const t2 = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"] });
  const r2 = await t2.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "alice" },
    body: "do work",
    intent: "spawn",
    idempotencyKey: "m1",
  });
  assert.equal(r2.kind, "rejected");
});

test("receiveMessage rejects an unconfigured channel and an unroutable message", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"] });
  const unconfigured = await t.daemon.receiveMessage({ channel: "slack", sender: { channel: "slack", sender: "bob" }, body: "x", idempotencyKey: "m1" });
  assert.equal(unconfigured.kind, "rejected");

  const unroutable = await t.daemon.receiveMessage({ channel: "discord", sender: { channel: "discord", sender: "bob" }, body: "x", idempotencyKey: "m2" });
  assert.equal(unroutable.kind, "rejected");
});

test("outbox poll filters by channel and cursor", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord", "slack"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  await t.daemon.ask(a.id, { question: "one", generation: a.generation, idempotencyKey: "k1" });
  await t.daemon.ask(a.id, { question: "two", generation: a.generation, idempotencyKey: "k2" });

  const discord = await t.daemon.outbox({ channel: "discord" });
  assert.equal(discord.length, 2);
  assert.ok(discord.every((e) => (e.payload as { channel: string }).channel === "discord"));

  const fromSecond = await t.daemon.outbox({ channel: "discord", from: discord[1]!.seq });
  assert.deepEqual(
    fromSecond.map((e) => e.seq),
    [discord[1]!.seq],
  );

  assert.equal((await t.daemon.outbox({ channel: "slack" })).length, 0);
});

test("message_sent alert outbox entries are journaled for zombie and watchdog actions", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100, maxRetries: 0 },
  });
  const a = await runningAgent(t, "a");
  // Drive an escalated watchdog action (maxRetries 0 -> escalate after cancel).
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();

  const outbox = await t.daemon.outbox({ channel: "discord" });
  const alerts = outbox.filter((e) => (e.payload as { purpose: string }).purpose === "alert");
  assert.equal(alerts.length, 1);
  assert.match((alerts[0]!.payload as { subject: string }).subject, /watchdog escalated/);
});

test("a rate-limit rejection is not cached, so the same key is retryable", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], now: () => clock });
  const a = await runningAgent(t, "a");
  const msg = (key: string) => ({ channel: "discord", sender: { channel: "discord", sender: "alice" }, body: "hi", to: a.id, idempotencyKey: key });

  // Exhaust the 20/min per-sender window.
  for (let i = 0; i < 20; i++) assert.equal((await t.daemon.receiveMessage(msg(`m${i}`))).kind, "signaled");
  const rejected = await t.daemon.receiveMessage(msg("m20"));
  assert.deepEqual(rejected, { kind: "rejected", reason: "sender rate limit exceeded" });

  // Once the window clears, the same key routes instead of replaying the cached rejection.
  clock += 61_000;
  assert.deepEqual(await t.daemon.receiveMessage(msg("m20")), { kind: "signaled", to: a.id });
});

test("an agent cannot read another agent's escalation by id", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const b = await runningAgent(t, "b");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const res = await handle(t.daemon, { method: "GET", url: `/v1/agents/self/ask/${escalation.id}?waitMs=0`, token: t.daemon.agentToken(b.id) });
  assert.equal(res.status, 404);
});

test("receiveMessage rejects a signal to an unknown agent", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"] });
  const receipt = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "alice" },
    body: "hi",
    to: "nobody",
    idempotencyKey: "m1",
  });
  assert.deepEqual(receipt, { kind: "rejected", reason: "unknown agent" });
});

test("a second answer to an answered escalation is rejected, not answered", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const first = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "alice" },
    body: "yes",
    replyTo: escalation.id,
    idempotencyKey: "m1",
  });
  assert.deepEqual(first, { kind: "answered", escalation: escalation.id });

  const second = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "bob" },
    body: "no",
    replyTo: escalation.id,
    idempotencyKey: "m2",
  });
  assert.deepEqual(second, { kind: "rejected", reason: "already answered" });
});

test("budget route reflects children's carve and clamps at zero", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a", 1_000);
  const c1 = await t.daemon.deps.registry.create({ spec: spawnSpec, parent: a.id, name: "c1", task: "t", host: "h1", budgetMicros: 300, idempotencyKey: "c1" });
  await t.daemon.deps.registry.transition(c1.id, c1.generation, "running", { idempotencyKey: "c1-run" });
  const res = await handle(t.daemon, { method: "GET", url: "/v1/agents/self/budget", token: t.daemon.agentToken(a.id) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { budgetMicros: 1_000, remainingMicros: 700 });

  const b = await runningAgent(t, "b", 100);
  const c2 = await t.daemon.deps.registry.create({ spec: spawnSpec, parent: b.id, name: "c2", task: "t", host: "h1", budgetMicros: 300, idempotencyKey: "c2" });
  await t.daemon.deps.registry.transition(c2.id, c2.generation, "running", { idempotencyKey: "c2-run" });
  const over = await handle(t.daemon, { method: "GET", url: "/v1/agents/self/budget", token: t.daemon.agentToken(b.id) });
  assert.deepEqual(over.body, { budgetMicros: 100, remainingMicros: 0 });
});

test("two agents asking the same question get distinct escalations (keys are agent-scoped)", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const b = await runningAgent(t, "b");
  const ea = await t.daemon.ask(a.id, { question: "same?", generation: a.generation, idempotencyKey: "same" });
  const eb = await t.daemon.ask(b.id, { question: "same?", generation: b.generation, idempotencyKey: "same" });
  assert.notEqual(ea.escalation.id, eb.escalation.id);
  assert.equal(ea.escalation.agent, a.id);
  assert.equal(eb.escalation.agent, b.id);
  assert.equal((await t.daemon.waitAsk(b.id, eb.escalation.id, 0)).agent, b.id);
});

test("a partial answer (store written, send failed) is completed on retry", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"], now: () => clock });
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const rawMailbox = t.fakes.hooks.raw.mailbox;
  const base = rawMailbox.send.bind(rawMailbox);
  let failed = false;
  rawMailbox.send = async (to, signal, key, gen) => {
    if (!failed && signal.kind === "human_answer") {
      failed = true;
      throw new Error("boom");
    }
    return base(to, signal, key, gen);
  };

  const msg = { channel: "discord", sender: { channel: "discord", sender: "alice" }, body: "yes", replyTo: escalation.id, idempotencyKey: "m1" };
  const first = await t.daemon.receiveMessage(msg);
  assert.equal(first.kind, "rejected"); // the send threw after the store+journal wrote
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "answered");
  assert.equal((await rawMailbox.peek(a.id)).length, 0);

  // A retry of the same message re-runs the idempotent journal+send and delivers the answer.
  const retry = await t.daemon.receiveMessage(msg);
  assert.deepEqual(retry, { kind: "answered", escalation: escalation.id });
  const box = await rawMailbox.peek(a.id);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "human_answer");
});

test("an escalation can only be answered on its escalation channel", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord", "slack"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });
  const cross = await t.daemon.receiveMessage({
    channel: "slack",
    sender: { channel: "slack", sender: "bob" },
    body: "yes",
    replyTo: escalation.id,
    idempotencyKey: "m1",
  });
  assert.equal(cross.kind, "rejected");
  assert.match((cross as { reason: string }).reason, /escalations are answered on channel discord/);
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "open");
});

test("rejected inbound messages do not consume rate-limit slots", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"], now: () => clock });
  const a = await runningAgent(t, "a");
  // A flood of invalid replies (unknown escalation) must not throttle the real message.
  for (let i = 0; i < 30; i++) {
    const r = await t.daemon.receiveMessage({
      channel: "discord",
      sender: { channel: "discord", sender: "alice" },
      body: "x",
      replyTo: "es-unknown",
      idempotencyKey: `bad${i}`,
    });
    assert.equal(r.kind, "rejected");
  }
  const ok = await t.daemon.receiveMessage({ channel: "discord", sender: { channel: "discord", sender: "alice" }, body: "hi", to: a.id, idempotencyKey: "m1" });
  assert.deepEqual(ok, { kind: "signaled", to: a.id });
});

test("POST /v1/escalations/:id/answer answers via the operator scope", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  // Host and agent credentials cannot answer: the route is operator-scoped.
  const hostTok = host("discord");
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: `/v1/escalations/${escalation.id}/answer`, token: hostTok, body: { body: "yes", idempotencyKey: "h1" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await handle(t.daemon, {
        method: "POST",
        url: `/v1/escalations/${escalation.id}/answer`,
        token: t.daemon.agentToken(a.id),
        body: { body: "yes", idempotencyKey: "a1" },
      })
    ).status,
    403,
  );

  const res = await handle(t.daemon, {
    method: "POST",
    url: `/v1/escalations/${escalation.id}/answer`,
    token: op,
    body: { body: "yes", idempotencyKey: "op1" },
  });
  assert.equal(res.status, 201);
  const esc = res.body as { state: string; answer: string; answeredBy: { channel: string; sender: string } };
  assert.equal(esc.state, "answered");
  assert.equal(esc.answer, "yes");
  assert.deepEqual(esc.answeredBy, { channel: "cli", sender: "operator" });

  // The answer reaches the asker as a human_answer signal from the operator.
  const box = await t.daemon.deps.mailbox.peek(a.id);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.kind, "human_answer");
  assert.equal((box[0] as { from: { channel: string; sender: string } }).from.sender, "operator");
});

test("POST /v1/escalations/:id/answer refuses a late answer to an already answered ask with 409 and leaves the first answer in place", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });
  const answer = (body: string, idempotencyKey: string) =>
    handle(t.daemon, { method: "POST", url: `/v1/escalations/${escalation.id}/answer`, token: op, body: { body, idempotencyKey } });

  assert.equal((await answer("first", "op1")).status, 201);
  // Negative control: a replay of the winning answer (same key and text) is still the idempotent 201.
  assert.equal((await answer("first", "op1")).status, 201);

  const late = await answer("late", "op2");
  assert.equal(late.status, 409);
  assert.match((late.body as { error: string }).error, /already answered.*not applied.*message/s);
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))?.answer, "first");
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).filter((s) => s.kind === "human_answer").length, 1, "the late answer is never delivered");
});

test("an operator answer after the ask expired is refused with 409 (the expiry answer stands)", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });
  await t.daemon.answerEscalation(escalation.id, EXPIRED_ANSWER, EXPIRED_BY, `expire:${escalation.id}`);
  const late = await handle(t.daemon, {
    method: "POST",
    url: `/v1/escalations/${escalation.id}/answer`,
    token: op,
    body: { body: "alpha-1", idempotencyKey: "op1" },
  });
  assert.equal(late.status, 409);
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))?.answer, EXPIRED_ANSWER);
});

test("POST /v1/escalations/:id/answer authenticates with a UI cookie and 404s unknown ids", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "q?", generation: a.generation, idempotencyKey: "k1" });

  const res = await handle(t.daemon, {
    method: "POST",
    url: `/v1/escalations/${escalation.id}/answer`,
    cookie: issueUiCookie(SECRET, 60_000),
    body: { body: "ok", idempotencyKey: "c1" },
  });
  assert.equal(res.status, 201);
  assert.equal((res.body as { answer: string }).answer, "ok");

  assert.equal(
    (await handle(t.daemon, { method: "POST", url: "/v1/escalations/nope/answer", token: op, body: { body: "x", idempotencyKey: "u1" } })).status,
    404,
  );
});
