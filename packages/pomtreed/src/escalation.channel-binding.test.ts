// TODO(msg-authz): an escalation or approval is answerable only through a channel it was fanned out to (the configured escalation
// channels), over the real host-token HTTP route. A host token of a channel that is configured only for inbound traffic (or
// not configured at all) must fail closed: a typed `rejected` receipt, no state change, no journal or mailbox side effects.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import type { MessageReceipt } from "./daemon-types.ts";
import { op, runningAgent, SECRET, setup } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const host = (channel: string) => issueToken(SECRET, { scope: "host", channel });
// discord and ops are escalation channels (asks fan out to both); slack is inbound-only; mail is not configured at all.
const cfg = { messagingChannels: ["discord", "ops", "slack"], escalationChannels: ["discord", "ops"] };

// POST /v1/messages exactly as an adapter does, with the channel's own host token.
async function post(t: T, channel: string, body: Record<string, unknown>, key: string, token = host(channel)) {
  const res = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    token,
    body: { channel, sender: { sender: "u" }, idempotencyKey: key, ...body },
  });
  return { status: res.status, receipt: res.body as MessageReceipt };
}

const sideEffects = async (t: T, agent: AgentRecord) => ({
  journal: (await t.journal.read({})).filter((e) => e.payload.kind === "message_received" || e.payload.kind === "escalation_answered").length,
  mailbox: (await t.daemon.deps.mailbox.peek(agent.id)).length,
});

test("an inbound-only channel's host token cannot answer an ask: rejected, ask untouched, no side effects", async () => {
  const t = setup(async (c) => void (await c.stopped), cfg);
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "go?", generation: a.generation, idempotencyKey: "k1" });
  const before = await sideEffects(t, a);

  for (const [i, extra] of [{ body: "yes" }, { body: "no", intent: "answer" }].entries()) {
    const r = await post(t, "slack", { replyTo: escalation.id, ...extra }, `s${i}`);
    assert.equal(r.status, 201); // the route reports the outcome as a typed receipt, not an HTTP error
    assert.equal(r.receipt.kind, "rejected");
    assert.match((r.receipt as { reason: string }).reason, /escalations are answered on channel discord, ops/);
  }
  const after = await t.daemon.deps.escalations.get(escalation.id);
  assert.equal(after!.state, "open");
  assert.equal(after!.answer, null);
  assert.equal(after!.answeredBy, null);
  assert.deepEqual(await sideEffects(t, a), before);
});

test("an inbound-only channel's host token cannot decide an approval: rejected, approval still pending", async () => {
  const t = setup(async (c) => void (await c.stopped), cfg);
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await runningAgent(t, "a");
  const ap = await t.fakes.approvals.create(
    {
      id: "ap-x",
      requester: { id: a.id, rank: "agent", generation: a.generation },
      action: { kind: "publish", target: "t" },
      host: "h1",
      deadlineAt: Date.now() + 60_000,
      rungs: ["operator"],
    },
    "ap-x",
  );
  await t.daemon.notifyApprovalAsk(ap);

  for (const [i, body] of ["approve", "deny"].entries()) {
    const r = await post(t, "slack", { replyTo: ap.id, body }, `s${i}`);
    assert.equal(r.receipt.kind, "rejected");
    assert.match((r.receipt as { reason: string }).reason, /escalations are answered on channel discord, ops/);
  }
  const now = (await t.fakes.approvals.get(ap.id))!;
  assert.equal(now.state, "pending");
  assert.equal(now.rungIndex, 0);
  assert.equal(now.journal.length, 0);

  // control: a channel the approval was alerted on can decide it
  const ok = await post(t, "ops", { replyTo: ap.id, body: "approve" }, "o1");
  assert.deepEqual(ok.receipt, { kind: "answered", escalation: ap.id });
  assert.equal((await t.fakes.approvals.get(ap.id))!.state, "approved");
});

test("a host token is bound to its own channel: it cannot claim another channel (even an escalation channel) to answer", async () => {
  const t = setup(async (c) => void (await c.stopped), cfg);
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "go?", generation: a.generation, idempotencyKey: "k1" });
  const before = await sideEffects(t, a);

  const r = await handle(t.daemon, {
    method: "POST",
    url: "/v1/messages",
    token: host("slack"),
    body: { channel: "discord", sender: { sender: "u" }, body: "yes", replyTo: escalation.id, idempotencyKey: "x1" },
  });
  assert.equal(r.status, 403);
  assert.match((r.body as { error: string }).error, /host token is for channel slack, not discord/);
  // an unlisted channel's well-formed token is refused outright (not a configured adapter), and a forged one is a 401
  const unlisted = await post(t, "mail", { replyTo: escalation.id, body: "yes" }, "m1");
  assert.equal(unlisted.status, 403);
  assert.deepEqual(await sideEffects(t, a), before);
  const forged = await post(t, "discord", { replyTo: escalation.id, body: "yes" }, "f1", `ht.discord.${"0".repeat(64)}`);
  assert.equal(forged.status, 401);
  // the ui channel is in-daemon: no host token may claim it
  const ui = await post(t, "ui", { replyTo: escalation.id, body: "yes" }, "u1", host("ui"));
  assert.equal(ui.status, 403);

  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "open");
  assert.deepEqual(await sideEffects(t, a), before);
});

test("every escalation channel the ask fanned out to may answer (first wins); the operator override still works", async () => {
  const t = setup(async (c) => void (await c.stopped), cfg);
  const a = await runningAgent(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "go?", generation: a.generation, idempotencyKey: "k1" });
  // the ask reached exactly the escalation channels, none else
  for (const ch of ["discord", "ops"]) assert.equal((await t.daemon.outbox({ channel: ch })).length, 1, `${ch} outbox`);
  assert.equal((await t.daemon.outbox({ channel: "slack" })).length, 0);

  const first = await post(t, "ops", { replyTo: escalation.id, body: "yes" }, "o1");
  assert.equal(first.receipt.kind, "answered");
  const late = await post(t, "discord", { replyTo: escalation.id, body: "no" }, "d1");
  assert.deepEqual(late.receipt, { kind: "rejected", reason: "already answered" });
  const viaOperator = await handle(t.daemon, {
    method: "POST",
    url: `/v1/escalations/${escalation.id}/answer`,
    token: op,
    body: { body: "later", idempotencyKey: "op1" },
  });
  assert.equal(viaOperator.status, 409); // the operator route is not channel-bound, but a late answer is refused (ops-late-answer); the first answer stands
  const stored = (await t.daemon.deps.escalations.get(escalation.id))!;
  assert.equal(stored.answer, "yes");
  assert.deepEqual(stored.answeredBy, { channel: "ops", sender: "u" });
});
