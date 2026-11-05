// The channel contract (TODO(msg-authz)): ui, cli (operator token) and chat adapters are instances of one channel abstraction
// behind ONE action core (performAction). Operator rank: always allowed, always audited, exempt from rate limits and chat approval.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { issueToken, issueUiCookie } from "./auth.ts";
import { handle } from "./api.ts";
import { SECRET, op, setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const running = async (t: T, key: string): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
};
const received = async (t: T) =>
  (await t.journal.read({}))
    .filter((e: JournalEntry) => e.payload.kind === "message_received")
    .map((e) => e.payload as { channel: string; from: { channel: string; sender: string }; body: string });
const ask = async (t: T, key = "k") => {
  const a = await running(t, `a-${key}`);
  return (await t.daemon.ask(a.id, { question: "go?", generation: a.generation, idempotencyKey: key })).escalation;
};
const discord = { channel: "discord", sender: { channel: "discord", sender: "u1" } };
const denyAll = { authorizeInbound: async () => false, chatApproval: () => true };

test("operator-token routes are audited as cli:operator, even when the allowlist denies everyone and chat approval is on", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"], ...denyAll });
  const a = await running(t, "a");
  const esc = await ask(t);
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/message`, { body: "hi", idempotencyKey: "m1" })).status, 201);
  assert.equal((await t.operator("POST", `/v1/escalations/${esc.id}/answer`, { body: "yes", idempotencyKey: "an1" })).status, 201);
  assert.equal((await t.operator("POST", "/v1/agents", { name: "s", task: "go", idempotencyKey: "sp1" })).status, 201, "spawn is not held by chat approval");
  const b = await running(t, "b");
  assert.equal((await t.operator("POST", `/v1/agents/${b.id}/cancel`, { idempotencyKey: "c1" })).status, 202, "cancel is not held by chat approval");
  const rows = await received(t);
  assert.deepEqual(
    rows.map((r) => [r.channel, r.from.channel, r.from.sender, r.body]),
    [
      ["cli", "cli", "operator", "hi"],
      ["cli", "cli", "operator", "yes"],
      ["cli", "cli", "operator", "go"],
      ["cli", "cli", "operator", ""],
    ],
  );
  assert.deepEqual((await t.daemon.deps.escalations.get(esc.id))!.answeredBy, { channel: "cli", sender: "operator" });
});

test("the UI session cookie is ui:operator on the same routes, with no `ui` channel configured", async () => {
  const t = setup(async (c) => void (await c.stopped), {});
  const a = await running(t, "a");
  const cookie = issueUiCookie(SECRET, 60_000);
  const r = await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/message`, cookie, body: { body: "hi", idempotencyKey: "m1" } });
  assert.equal(r.status, 201);
  const rows = await received(t);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.channel, rows[0]!.from, rows[0]!.body], ["ui", { channel: "ui", sender: "operator" }, "hi"]);
});

test("operator rank is exempt from rate limits; chat rank keeps 20/min per sender", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await running(t, "a");
  for (let i = 0; i < 30; i++) assert.equal((await t.operator("POST", `/v1/agents/${a.id}/message`, { body: `m${i}`, idempotencyKey: `k${i}` })).status, 201);
  assert.equal((await received(t)).length, 30, "every operator action is audited");
  let last = "";
  for (let i = 0; i < 21; i++) {
    const r = await t.daemon.receiveMessage({ ...discord, to: a.id, body: "x", idempotencyKey: `d${i}` });
    last = r.kind === "rejected" ? r.reason : r.kind;
  }
  assert.match(last, /sender rate limit/);
});

test("chat rank cannot carry grantMicros; operator rank can", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const r = await t.daemon.performAction(discord.sender, { kind: "decide", id: "ap-x", decision: "approve", why: "", grantMicros: 5 }, "g1");
  assert.deepEqual(r, { kind: "rejected", reason: "grantMicros is operator-only", status: 403 });
  const chatRaw = await t.daemon.performAction(discord.sender, { kind: "cancel", to: "a" }, "g2", { raw: true });
  assert.equal(chatRaw.kind, "rejected", "the raw shape is operator rank only");
});

test("zero channels: valid config; an ask stays open and is answerable via the operator route", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: [], escalationChannels: [] });
  const esc = await ask(t);
  const r = await t.operator("POST", `/v1/escalations/${esc.id}/answer`, { body: "ok", idempotencyKey: "z1" });
  assert.equal(r.status, 201);
  assert.equal((await t.daemon.deps.escalations.get(esc.id))!.state, "answered");
  // a ui reply is still rejected: `ui` is not a configured channel here
  const ui = await t.operator("POST", "/v1/ui/reply", { replyTo: esc.id, body: "again", idempotencyKey: "z2" });
  assert.equal((ui.body as { kind: string }).kind, "rejected");
});

// --- Review fixes (audit integrity, rank spoof, stale host tokens, row relocation, operator-route audit rows) ---

const onAgent = async (t: T, agent: AgentRecord) =>
  (await t.journal.read({ agent: agent.id }))
    .filter((e: JournalEntry) => e.payload.kind === "message_received")
    .map((e) => e.payload as { channel: string; body: string });
const host = (t: T, channel: string, method: string, url: string, body?: unknown) =>
  handle(t.daemon, { method, url, body, token: issueToken(SECRET, { scope: "host", channel }) });

test("a chat idempotency key reused by an operator action does not suppress the operator's audit row", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await running(t, "a");
  assert.equal((await t.daemon.receiveMessage({ ...discord, to: a.id, body: "chat", idempotencyKey: "shared" })).kind, "signaled");
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/message`, { body: "op", idempotencyKey: "shared" })).status, 201);
  assert.deepEqual(
    (await received(t)).map((r) => [r.channel, r.body]),
    [
      ["discord", "chat"],
      ["cli", "op"],
    ],
  );
  // a true replay (same channel and key) still dedupes
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/message`, { body: "op", idempotencyKey: "shared" })).status, 201);
  assert.equal((await received(t)).length, 2);
});

test("a message whose channel does not match its sender's channel is rejected with no state change", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await running(t, "a");
  const r = await t.daemon.receiveMessage({ channel: "discord", sender: { channel: "cli", sender: "operator" }, to: a.id, body: "x", idempotencyKey: "spoof" });
  assert.equal(r.kind, "rejected");
  assert.equal((await received(t)).length, 0, "no audit row");
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0, "no signal");
});

test("a host token for a channel that is not configured is refused on every host route", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"], authorizeInbound: async () => true });
  const a = await running(t, "a");
  const gone = "slack";
  assert.equal((await host(t, gone, "GET", "/v1/host/agents?sender=u1")).status, 403);
  assert.equal((await host(t, gone, "GET", "/v1/messages?channel=slack")).status, 403);
  assert.equal((await host(t, gone, "POST", "/v1/messages", { channel: gone, sender: "u1", to: a.id, body: "x", idempotencyKey: "s1" })).status, 403);
  assert.equal((await received(t)).length, 0);
  // the configured adapter still works
  assert.equal((await host(t, "discord", "GET", "/v1/host/agents?sender=u1")).status, 200);
  assert.equal((await host(t, "discord", "GET", "/v1/messages?channel=discord")).status, 200);
});

test("zero chat channels: every host token is refused", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: [], escalationChannels: ["ui"], authorizeInbound: async () => true });
  for (const ch of ["discord", "ui", "cli"]) {
    assert.equal((await host(t, ch, "GET", "/v1/host/agents?sender=u1")).status, 403, ch);
    assert.equal((await host(t, ch, "GET", `/v1/messages?channel=${ch}`)).status, 403, ch);
  }
});

test("host tokens named ui, cli or operator are refused on /v1/messages and /v1/host", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"], authorizeInbound: async () => true });
  const a = await running(t, "a");
  for (const ch of ["ui", "cli", "operator"]) {
    assert.equal((await host(t, ch, "GET", `/v1/messages?channel=${ch}`)).status, 403, ch);
    assert.equal((await host(t, ch, "GET", "/v1/host/agents?sender=u1")).status, 403, ch);
    const r = await host(t, ch, "POST", "/v1/messages", { channel: ch, sender: "u1", to: a.id, body: "x", idempotencyKey: `h-${ch}` });
    assert.equal(r.status, 403, ch);
  }
  assert.equal((await received(t)).length, 0);
});

test("the ui `to` message journals on the target and satisfies await-user", async () => {
  const t = setup(async (c) => void (await c.stopped), { escalationChannels: ["ui"] });
  const a = await running(t, "a");
  await assert.rejects(t.daemon.awaitUser(a.id, "w0"), /await-user refused/);
  const cookie = issueUiCookie(SECRET, 60_000);
  const r = await handle(t.daemon, { method: "POST", url: "/v1/ui/reply", cookie, body: { to: a.id, body: "hi", idempotencyKey: "u1" } });
  assert.equal(r.status, 201);
  assert.deepEqual(
    (await onAgent(t, a)).map((x) => x.channel),
    ["ui"],
  );
  assert.deepEqual(await t.daemon.awaitUser(a.id, "w1"), { accepted: true });
});

test("a chat `to` message journals on the target agent, satisfies await-user, and is idempotent by key", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: ["discord"], escalationChannels: ["discord"], authorizeInbound: async () => true });
  const a = await running(t, "a");
  await assert.rejects(t.daemon.awaitUser(a.id, "w0"), /await-user refused/);
  for (let i = 0; i < 2; i++) assert.equal((await t.daemon.receiveMessage({ ...discord, to: a.id, body: "hi", idempotencyKey: "c1" })).kind, "signaled");
  assert.deepEqual(
    (await onAgent(t, a)).map((x) => [x.channel, x.body]),
    [["discord", "hi"]],
  );
  assert.deepEqual((await received(t)).filter((x) => x.channel === "discord").length, 1, "root has no copy of the row");
  assert.deepEqual(await t.daemon.awaitUser(a.id, "w1"), { accepted: true });
});

test("a chat `to` message from a sender not on the allowlist leaves no row and no signal", async () => {
  const t = setup(async (c) => void (await c.stopped), {
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    authorizeInbound: async () => false,
  });
  const a = await running(t, "a");
  const r = await t.daemon.receiveMessage({ ...discord, to: a.id, body: "hi", idempotencyKey: "c2" });
  assert.equal(r.kind, "rejected");
  assert.equal((await onAgent(t, a)).length, 0);
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0);
});

test("a request carrying both the operator token and a ui cookie is attributed cli:operator", async () => {
  const t = setup(async (c) => void (await c.stopped), {});
  const a = await running(t, "a");
  const r = await handle(t.daemon, {
    method: "POST",
    url: `/v1/agents/${a.id}/message`,
    token: op,
    cookie: issueUiCookie(SECRET, 60_000),
    body: { body: "both", idempotencyKey: "b1" },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(
    (await received(t)).map((x) => [x.channel, x.from]),
    [["cli", { channel: "cli", sender: "operator" }]],
  );
});

test("the /pass route writes an audit row", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: [], escalationChannels: ["ui"] });
  const mid = await running(t, "mid");
  const reg = t.daemon.deps.registry;
  const leaf = await reg.create({ spec: spawnSpec, parent: mid.id, name: "leaf", task: "t", host: "h1", budgetMicros: 1_000, idempotencyKey: "leaf" });
  const leafRun = await reg.transition(leaf.id, leaf.generation, "running", { idempotencyKey: "leaf-run" });
  const esc = (await t.daemon.ask(leafRun.id, { question: "go?", generation: leafRun.generation, idempotencyKey: "p0" })).escalation;
  const pass = await t.operator("POST", `/v1/escalations/${esc.id}/pass`, { idempotencyKey: "pass1" });
  assert.equal(pass.status, 201, JSON.stringify(pass.body));
  const rows = await received(t);
  assert.deepEqual(
    rows.map((r) => [r.channel, r.from.sender, r.body]),
    [["cli", "operator", "pass"]],
  );
});

test("the approval decide route writes an audit row", async () => {
  const t = setup(async (c) => void (await c.stopped), { messagingChannels: [], escalationChannels: ["ui"] });
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await running(t, "a");
  await t.fakes.approvals.create(
    {
      id: "ap-2",
      requester: { id: a.id, rank: "agent", generation: a.generation },
      action: { kind: "x", target: "t" },
      host: "h1",
      deadlineAt: Date.now() + 60_000,
      rungs: ["operator"],
    },
    "k2",
  );
  assert.equal((await t.operator("POST", "/v1/approvals/ap-2/decide", { decision: "approve", idempotencyKey: "d1" })).status, 201);
  const rows = (await received(t)).filter((r) => r.body === "approve");
  assert.deepEqual(
    rows.map((r) => [r.channel, r.from.channel]),
    [["cli", "cli"]],
  );
});
