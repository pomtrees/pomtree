import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INBOUND_INTENTS,
  MESSAGE_FAILED_JOURNAL_REASON_MAX,
  MESSAGE_FAILED_REASON_MAX,
  MESSAGE_FAILED_SUBJECT_MAX,
  MESSAGING_API_VERSION,
  RECEIPT_KINDS,
  type HostAgentsBody,
  type HostBudgetBody,
  type HostErrorBody,
  type HostReportBody,
  type InboundBody,
  type InboundMessage,
  type JournalPayload,
  type MessageFailedBody,
  type MessageReceipt,
  type MessageSentPayload,
  type OutboxEntry,
} from "./index.ts";

test("INBOUND_INTENTS and RECEIPT_KINDS: the declared sets, no duplicates", () => {
  assert.deepEqual([...INBOUND_INTENTS].sort(), ["answer", "cancel", "launch", "signal", "spawn", "status"]);
  assert.deepEqual([...RECEIPT_KINDS].sort(), ["answered", "cancelled", "launched", "rejected", "signaled", "spawned", "status"]);
  assert.equal(new Set(INBOUND_INTENTS).size, INBOUND_INTENTS.length);
  assert.equal(new Set(RECEIPT_KINDS).size, RECEIPT_KINDS.length);
});

test("MessageReceipt: an opaque-string instantiation accepts every kind; unknown kinds do not typecheck", () => {
  const all: MessageReceipt<string, string, string>[] = [
    { kind: "answered", escalation: "es-1" },
    { kind: "signaled", to: "a" },
    { kind: "spawned", agent: "a" },
    { kind: "launched", agent: "a" },
    { kind: "cancelled", agent: "a" },
    { kind: "status", agent: "a", state: "running", exit: null },
    { kind: "rejected", reason: "no" },
  ];
  assert.deepEqual(all.map((r) => r.kind).sort(), [...RECEIPT_KINDS].sort());
  // @ts-expect-error a kind outside the contract is a type error
  const bad: MessageReceipt = { kind: "nope" };
  assert.ok(bad);
});

test("messaging wire contract: a sample of each shape typechecks and survives a JSON round-trip unchanged", () => {
  const sender = { channel: "discord" as const, sender: "u1", name: "Ann" };
  const inbound: InboundMessage<"discord">[] = [
    { channel: "discord", sender, body: "yes", replyTo: "es-1", idempotencyKey: "m1" },
    { channel: "discord", sender, body: "", replyTo: "ap-1", pass: true, idempotencyKey: "m2" },
    { channel: "discord", sender, body: "", intent: "launch", workflow: "hn/digest", input: { n: 3 }, idempotencyKey: "m3" },
    { channel: "discord", sender, body: "", intent: "status", to: "a1", idempotencyKey: "m4" },
  ];
  const body: InboundBody = inbound[0]!; // the narrowed adapter form is a pomtreed-side InboundMessage
  const outbox: OutboxEntry<"discord">[] = [
    { seq: 4, ts: 1, agent: "a1", payload: { kind: "message_sent", channel: "discord", purpose: "alert", subject: "s" } },
    {
      seq: 5,
      ts: 2,
      agent: "a1",
      payload: { kind: "message_sent", channel: "discord", purpose: "ask", subject: "q?", replyTo: "es-1", subjectKind: "ask", options: ["a", "b"] },
    },
    {
      seq: 6,
      ts: 3,
      agent: "a1",
      payload: { kind: "message_sent", channel: "discord", purpose: "ask", subject: "approve?", replyTo: "ap-1", subjectKind: "approval" },
    },
  ];
  // An outbox payload is a journal payload: pomtreed can return its JournalEntry rows as OutboxEntry.
  const asJournal: JournalPayload = outbox[1]!.payload;
  const failed: MessageFailedBody<"discord"> = { channel: "discord", purpose: "ask", subject: "s", reason: "429", attempts: 5, idempotencyKey: "k" };
  const agents: HostAgentsBody = {
    agents: [{ id: "a1", state: "running", parent: null, name: "n", createdAt: 1, updatedAt: 2, spentMicros: 3, budgetMicros: 4 }],
  };
  const budget: HostBudgetBody = { id: "a1", budgetMicros: 4, spentMicros: 3, remainingMicros: 1 };
  const report: HostReportBody[] = [
    { id: "a1", state: "exited", exit: "succeeded", report: "done" },
    { id: "a2", state: "running", exit: null, report: null },
  ];
  const error: HostErrorBody = { error: "no such agent" };
  for (const sample of [inbound, body, outbox, asJournal, failed, agents, budget, report, error]) assert.deepEqual(JSON.parse(JSON.stringify(sample)), sample);
  assert.equal(typeof MESSAGING_API_VERSION, "number");
  assert.ok(MESSAGE_FAILED_SUBJECT_MAX <= MESSAGE_FAILED_REASON_MAX && MESSAGE_FAILED_JOURNAL_REASON_MAX <= MESSAGE_FAILED_REASON_MAX);

  // @ts-expect-error a sender from another channel does not fit a narrowed body
  const wrongSender: InboundMessage<"discord"> = { channel: "discord", sender: { channel: "slack", sender: "u" }, body: "", idempotencyKey: "x" };
  // @ts-expect-error subjectKind is a closed set
  const wrongKind: MessageSentPayload = { kind: "message_sent", channel: "c", purpose: "ask", subject: "s", subjectKind: "question" };
  // @ts-expect-error an unknown intent is refused
  const wrongIntent: InboundMessage = { channel: "c", sender: { channel: "c", sender: "u" }, body: "", intent: "reboot", idempotencyKey: "x" };
  // @ts-expect-error a report's exit is an ExitStatus, not a number
  const wrongExit: HostReportBody = { id: "a", state: "exited", exit: 0, report: null };
  assert.ok(wrongSender && wrongKind && wrongIntent && wrongExit);
});
