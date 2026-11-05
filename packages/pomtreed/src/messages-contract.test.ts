import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_FAILED_JOURNAL_REASON_MAX, MESSAGE_FAILED_REASON_MAX, MESSAGING_API_VERSION } from "@pomtree/core";
import type { AgentRecord, InboundIntent, InboundMessage, MessageSentPayload } from "@pomtree/core";
import { MESSAGING_API_HEADER, handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import type { MessageReceipt } from "./daemon-types.ts";
import { SECRET, setup, spawnSpec } from "./test-setup.ts";

// The messaging wire contract on pomtreed's side: `pass` on POST /v1/messages, the contract-version header, the message_failed
// limits, and the subjectKind/options a message_sent carries.
type T = ReturnType<typeof setup>;
const both = { messagingChannels: ["discord"], escalationChannels: ["discord"] };
const host = issueToken(SECRET, { scope: "host", channel: "discord" });
const post = (t: T, url: string, body: unknown) => handle(t.daemon, { method: "POST", url, token: host, body });
const message = (t: T, body: Record<string, unknown>) => post(t, "/v1/messages", { channel: "discord", sender: "u1", ...body });
const receipt = (r: { body: unknown }) => r.body as MessageReceipt;

async function running(t: T, key: string, parent?: string): Promise<AgentRecord> {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: parent ?? (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
}
// An ask from a grandchild, held by its parent (one rung below the user).
async function bubbled(t: T) {
  const mid = await running(t, "mid");
  const kid = await running(t, "kid", mid.id);
  const { escalation } = await t.daemon.ask(kid.id, { question: "q?", options: ["yes", "no"], generation: kid.generation, idempotencyKey: "kq" });
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.holder, mid.id);
  return { mid, kid, escalation };
}
const sent = async (t: T) => (await t.daemon.outbox({ channel: "discord" })).map((e) => e.payload as MessageSentPayload);

test("POST /v1/messages: pass with replyTo hands the ask up one rung (not an answer); body may be omitted", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const { escalation } = await bubbled(t);
  const r = await message(t, { replyTo: escalation.id, pass: true, idempotencyKey: "p1" });
  assert.equal(r.status, 201);
  assert.deepEqual(receipt(r), { kind: "answered", escalation: escalation.id });
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.holder, null, "now with the user");
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "open", "a pass is not an answer");
  assert.equal((await message(t, { replyTo: escalation.id, pass: "yes", idempotencyKey: "p2" })).status, 400, "pass must be a boolean");
  assert.equal((await message(t, { to: "x", pass: true, body: "b", idempotencyKey: "p3" })).status, 400, "pass requires replyTo");
  // pass: false is an ordinary answer.
  assert.deepEqual(receipt(await message(t, { replyTo: escalation.id, pass: false, body: "yes", idempotencyKey: "p4" })), {
    kind: "answered",
    escalation: escalation.id,
  });
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.state, "answered");
});

test("POST /v1/messages: a chat sender the authorizeInbound hook refuses cannot pass; the hook sees the pass", async () => {
  const seen: { pass?: boolean; route: InboundIntent }[] = [];
  const t = setup(async (c) => void (await c.stopped), {
    ...both,
    authorizeInbound: async (m: InboundMessage, route: InboundIntent) => {
      seen.push({ ...(m.pass !== undefined && { pass: m.pass }), route });
      return m.sender.sender !== "intruder";
    },
  });
  const { mid, escalation } = await bubbled(t);
  const r = await message(t, { sender: "intruder", replyTo: escalation.id, pass: true, idempotencyKey: "x1" });
  assert.deepEqual(receipt(r), { kind: "rejected", reason: "sender discord:intruder is not authorized to answer" });
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))!.holder, mid.id, "unchanged");
  assert.deepEqual(seen, [{ pass: true, route: "answer" }]);
  assert.equal(receipt(await message(t, { replyTo: escalation.id, pass: true, idempotencyKey: "x2" })).kind, "answered");
});

test("POST /v1/messages: pass on an approval abstains, like the UI's pass", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await running(t, "r");
  const ap = await t.fakes.approvals.create(
    {
      id: "ap-1",
      requester: { id: a.id, rank: "agent", generation: a.generation },
      action: { kind: "x", target: "t" },
      host: "h1",
      deadlineAt: Date.now() + 60_000,
      rungs: ["operator"],
    },
    "ap1",
  );
  assert.equal(receipt(await message(t, { replyTo: ap.id, pass: true, idempotencyKey: "u1" })).kind, "answered");
  assert.equal((await t.fakes.approvals.get(ap.id))!.journal.at(-1)!.decision, "abstain");
});

test("messaging routes advertise the contract version, errors included; other routes do not", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const want = String(MESSAGING_API_VERSION);
  const ok = await handle(t.daemon, { method: "GET", url: "/v1/messages?channel=discord", token: host });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers?.[MESSAGING_API_HEADER], want);
  const bad = await message(t, { body: "b", idempotencyKey: "k" }); // no route
  assert.equal(bad.headers?.[MESSAGING_API_HEADER], want);
  const refused = await handle(t.daemon, { method: "POST", url: "/v1/messages/failed", token: host, body: {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.headers?.[MESSAGING_API_HEADER], want);
  const hostRead = await handle(t.daemon, { method: "GET", url: "/v1/host/agents?sender=u1", token: host });
  assert.equal(hostRead.headers?.[MESSAGING_API_HEADER], want);
  assert.equal((await t.operator("GET", "/v1/agents")).headers?.[MESSAGING_API_HEADER], undefined);
});

test("messages/failed: the route takes a reason up to MESSAGE_FAILED_REASON_MAX; the journal keeps MESSAGE_FAILED_JOURNAL_REASON_MAX", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  const reason = `${"r".repeat(MESSAGE_FAILED_JOURNAL_REASON_MAX)}TAIL${"s".repeat(MESSAGE_FAILED_REASON_MAX - MESSAGE_FAILED_JOURNAL_REASON_MAX - 4)}`;
  assert.equal(reason.length, MESSAGE_FAILED_REASON_MAX);
  const r = await post(t, "/v1/messages/failed", { channel: "discord", purpose: "alert", subject: "s", reason, idempotencyKey: "f1" });
  assert.equal(r.status, 201);
  const row = (await t.journal.read({ agent: (await t.daemon.root()).id })).find((e) => e.payload.kind === "message_failed");
  // The first MESSAGE_FAILED_JOURNAL_REASON_MAX characters, then clipText's visible truncation marker.
  assert.equal(
    (row!.payload as { reason: string }).reason,
    `${reason.slice(0, MESSAGE_FAILED_JOURNAL_REASON_MAX)}… [truncated ${MESSAGE_FAILED_REASON_MAX - MESSAGE_FAILED_JOURNAL_REASON_MAX} chars]`,
  );
  assert.equal(
    (await post(t, "/v1/messages/failed", { channel: "discord", purpose: "alert", subject: "s", reason: `${reason}x`, idempotencyKey: "f2" })).status,
    400,
  );
});

test("message_sent carries subjectKind and options: a direct ask, an approval alert, and an ask relayed to the user", async () => {
  const t = setup(async (c) => void (await c.stopped), both);
  t.daemon.deps.approvals = t.fakes.approvals;
  const top = await running(t, "top");
  const { escalation: direct } = await t.daemon.ask(top.id, {
    question: "pick",
    options: ["a", "b @everyone"],
    generation: top.generation,
    idempotencyKey: "d",
  });
  const plain = await t.daemon.ask(top.id, { question: "free", generation: top.generation, idempotencyKey: "f" });
  const ap = await t.fakes.approvals.create(
    {
      id: "ap-2",
      requester: { id: top.id, rank: "agent", generation: top.generation },
      action: { kind: "x", target: "t" },
      host: "h1",
      deadlineAt: Date.now() + 60_000,
      rungs: ["operator"],
    },
    "ap2",
  );
  await t.daemon.notifyApprovalAsk(ap);
  const { escalation: relayed } = await bubbled(t);
  await message(t, { replyTo: relayed.id, pass: true, idempotencyKey: "p" }); // reaches the user through the root relay
  const out = await sent(t);
  const of = (id: string) => out.filter((p) => p.replyTo === id);
  assert.deepEqual(
    of(direct.id).map((p) => [p.subjectKind, p.options]),
    [["ask", ["a", "b @​everyone"]]],
    "options sanitized like the subject",
  );
  assert.deepEqual(
    of(plain.escalation.id).map((p) => [p.subjectKind, p.options]),
    [["ask", undefined]],
    "no options: omitted",
  );
  assert.deepEqual(
    of(ap.id).map((p) => [p.subjectKind, p.options]),
    [["approval", undefined]],
  );
  assert.deepEqual(
    of(relayed.id).map((p) => [p.subjectKind, p.options]),
    [["ask", ["yes", "no"]]],
  );
  // An alert with no reply target carries neither.
  assert.ok(out.filter((p) => p.replyTo === undefined).every((p) => p.subjectKind === undefined && p.options === undefined));
});
