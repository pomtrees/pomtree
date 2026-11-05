import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { handle } from "./api.ts";
import { EXPIRED_ANSWER } from "./daemon-util.ts";
import { relayOf } from "./to-user.ts";
import { op, setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;

// A running agent created straight in the registry under `parent` (root when omitted), like escalation.test.ts.
async function agentUnder(t: T, name: string, parent?: string, budgetMicros = 1_000_000): Promise<AgentRecord> {
  const p = parent ?? (await t.daemon.root()).id;
  const a = await t.daemon.deps.registry.create({ spec: spawnSpec, parent: p, name, task: "t", host: "h1", budgetMicros, idempotencyKey: name });
  return t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
}

let clock = Date.now();
const rig = (script: Parameters<typeof setup>[0] = async (c) => void (await c.stopped), over: Parameters<typeof setup>[1] = {}) => {
  clock = Date.now();
  const t = setup(script, {
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    now: () => clock,
    approvalWaitMs: 5,
    escAgentMs: 1_000,
    approvalTimeoutMs: 5_000,
    ...over,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  return t;
};
const call = (t: T, token: string, url: string, body: unknown) => handle(t.daemon, { method: "POST", url, token, body });
const inbox = async (t: T, id: string) => (await t.daemon.deps.mailbox.peek(id)).filter((s) => s.kind === "escalation");
const outbox = async (t: T) => (await t.daemon.outbox({ channel: "discord" })).map((e) => e.payload as { purpose: string; subject: string; replyTo?: string });

async function chain3(t: T) {
  const a = await agentUnder(t, "a");
  const b = await agentUnder(t, "b", a.id, 10_000);
  const c = await agentUnder(t, "c", b.id, 1_000);
  return { a, b, c };
}

test("deliver: the key derives from the source event, so two daemon boots produce the same key", async () => {
  const keysOf = async () => {
    const t = setup(async () => {});
    const keys: string[] = [];
    const real = t.fakes.mailbox.send.bind(t.fakes.mailbox);
    t.fakes.mailbox.send = async (to, sig, key, gen) => (keys.push(key), real(to, sig, key, gen));
    const a = await agentUnder(t, "a");
    await t.daemon.deliver(a.id, { kind: "nudge" } as unknown as Signal, "0:watchdog-nudge:42");
    await t.daemon.deliver(a.id, { kind: "nudge" } as unknown as Signal, "0:watchdog-nudge:43");
    return keys;
  };
  const first = await keysOf();
  const second = await keysOf();
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 2, "a different source event is a different key");
});

test("depth-3 ask: grandchild asks, parent passes, grandparent answers, asker gets human_answer from the grandparent", async () => {
  const t = rig();
  const { a, b, c } = await chain3(t);
  const { escalation } = await t.daemon.ask(c.id, { question: "which db?", generation: c.generation, idempotencyKey: "k1" });
  assert.equal(escalation.holder, b.id);
  assert.equal((await inbox(t, b.id)).length, 1);
  assert.equal((await inbox(t, a.id)).length, 0);
  assert.equal((await outbox(t)).length, 0, "nothing reaches the user while ancestors hold it");

  // A non-holder (the grandparent, or the asker) may not answer or pass yet.
  const body = { body: "pg", idempotencyKey: "x1" };
  assert.equal((await call(t, t.daemon.agentToken(a.id), `/v1/escalations/${escalation.id}/answer`, body)).status, 403);
  assert.equal((await call(t, t.daemon.agentToken(c.id), `/v1/escalations/${escalation.id}/pass`, { idempotencyKey: "x2" })).status, 403);

  const pass = await call(t, t.daemon.agentToken(b.id), `/v1/escalations/${escalation.id}/pass`, { idempotencyKey: "p1" });
  assert.equal(pass.status, 201);
  assert.equal((await inbox(t, b.id)).length, 0, "the stale hop signal was acked off the parent");
  assert.equal((await inbox(t, a.id)).length, 1);
  // Replay of the pass key is a no-op: no second signal, still with the grandparent.
  assert.equal((await call(t, t.daemon.agentToken(b.id), `/v1/escalations/${escalation.id}/pass`, { idempotencyKey: "p1" })).status, 201);
  assert.equal((await inbox(t, a.id)).length, 1);
  assert.equal((await call(t, t.daemon.agentToken(b.id), `/v1/escalations/${escalation.id}/answer`, { body: "late", idempotencyKey: "x3" })).status, 403);

  const ans = await call(t, t.daemon.agentToken(a.id), `/v1/escalations/${escalation.id}/answer`, body);
  assert.equal(ans.status, 201);
  assert.equal((await call(t, t.daemon.agentToken(a.id), `/v1/escalations/${escalation.id}/answer`, body)).status, 201); // replay
  assert.equal((await call(t, t.daemon.agentToken(a.id), `/v1/escalations/${escalation.id}/answer`, { body: "again", idempotencyKey: "x4" })).status, 409); // a late answer under a new key
  const got = (await t.daemon.deps.mailbox.peek(c.id)).filter((s) => s.kind === "human_answer");
  assert.equal(got.length, 1);
  assert.deepEqual((got[0] as { from: unknown }).from, { channel: "agent", sender: a.id });
  assert.equal((got[0] as { body: string }).body, "pg");
  assert.equal((await inbox(t, a.id)).length, 0, "answering clears the holder's hop signal");
});

test("a lapsed agent hop advances to the next holder, then the user; the human top fails closed to EXPIRED_ANSWER", async () => {
  const t = rig(undefined, { askTimeoutMs: 100_000 });
  const { a, b, c } = await chain3(t);
  const { escalation } = await t.daemon.ask(c.id, { question: "q?", generation: c.generation, idempotencyKey: "k1" });
  await t.daemon.sweepEscalations();
  assert.equal((await inbox(t, b.id)).length, 1, "not yet due");
  clock += 1_001;
  await t.daemon.sweepEscalations();
  assert.equal((await inbox(t, b.id)).length, 0);
  assert.equal((await inbox(t, a.id)).length, 1);
  clock += 1_001;
  await t.daemon.sweepEscalations();
  assert.equal((await inbox(t, a.id)).length, 0);
  const out = await outbox(t);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.purpose, "ask");
  assert.equal(out[0]!.subject, `[from ${c.id}] q?`);
  assert.equal(out[0]!.replyTo, escalation.id);
  // The operator rung is the end of the line: past the ask TTL it expires with the documented default.
  clock += 100_000;
  await t.daemon.sweepEscalations();
  const done = await t.daemon.deps.escalations.get(escalation.id);
  assert.equal(done?.state, "answered");
  assert.equal(done?.answer, EXPIRED_ANSWER);
});

test("an exited ancestor is skipped (auto-advance, journaled)", async () => {
  const t = rig();
  const { a, b, c } = await chain3(t);
  await t.daemon.deps.registry.transition(b.id, b.generation, "exited", { exit: "failed", idempotencyKey: "b-exit" });
  const { escalation } = await t.daemon.ask(c.id, { question: "q?", generation: c.generation, idempotencyKey: "k1" });
  assert.equal(escalation.holder, b.id);
  assert.equal((await inbox(t, a.id)).length, 1, "went straight to the grandparent");
  const hops = (await t.journal.read({ agent: c.id })).filter((e) => e.payload.kind === "ext.pomtreed.escalation_hop");
  assert.equal(hops.length, 1);
  assert.equal((hops[0]!.payload as { auto?: string }).auto, undefined);
});

test("top-level ask is unchanged: straight to the user, no holder", async () => {
  const t = rig();
  const a = await agentUnder(t, "a");
  const { escalation } = await t.daemon.ask(a.id, { question: "approve?", generation: a.generation, idempotencyKey: "k1" });
  assert.equal(escalation.holder, null);
  const out = await outbox(t);
  assert.deepEqual(
    out.map((o) => [o.purpose, o.subject, o.replyTo]),
    [["ask", "approve?", escalation.id]],
  );
  clock += 50_000;
  await t.daemon.sweepEscalations();
  assert.equal((await t.daemon.deps.escalations.get(escalation.id))?.state, "open", "hop windows do not apply");
});

test("a yielded ancestor parked on child_exited only is woken by the escalation", async () => {
  let aId = "";
  let wakeSeen = "";
  const t = rig(async (c) => {
    if (c.wake !== undefined) {
      wakeSeen = c.wake;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "child_exited", children: ["nobody"], mode: "any" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  // idle() joins the first segment, which ends when the agent yields: no wall-clock bound to blow under load.
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(aId))?.state, "yielded");
  const c = await agentUnder(t, "c", aId);
  await t.daemon.ask(c.id, { question: "need a hand", generation: c.generation, idempotencyKey: "k1" });
  await t.orchestrator.idle();
  assert.match(wakeSeen, /escalation/);
  assert.match(wakeSeen, /need a hand/);
});

test("approvals bubble the ladder: parent decides, grandparent does not, replays are no-ops, operator can still decide", async () => {
  const t = rig();
  const { a, b, c } = await chain3(t);
  await assert.rejects(t.daemon.requireApproval(c, "budget_raise", "x", "k"), (e: { status?: number }) => e.status === 409);
  const ap = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
  assert.deepEqual(ap.rungs, [`agent:${b.id}`, `agent:${a.id}`, "operator", "owner"]);
  assert.deepEqual(ap.rungWindowsMs, [1_000, 1_000, 5_000, 5_000]);
  assert.equal((await inbox(t, b.id)).length, 1);
  const url = `/v1/approvals/${ap.id}/decide`;
  assert.equal((await call(t, t.daemon.agentToken(a.id), url, { decision: "approve", idempotencyKey: "d0" })).status, 403);
  assert.equal((await call(t, t.daemon.agentToken(c.id), url, { decision: "approve", idempotencyKey: "d0" })).status, 403);
  const passed = await call(t, t.daemon.agentToken(b.id), url, { decision: "pass", idempotencyKey: "d1" });
  assert.equal(passed.status, 201);
  assert.equal((passed.body as { rungIndex: number }).rungIndex, 1);
  assert.equal((await inbox(t, b.id)).length, 0);
  assert.equal((await inbox(t, a.id)).length, 1);
  assert.equal((await call(t, t.daemon.agentToken(b.id), url, { decision: "pass", idempotencyKey: "d1" })).status, 201); // replay
  assert.equal((await inbox(t, a.id)).length, 1);
  assert.equal((await t.fakes.approvals.get(ap.id))?.rungIndex, 1);
  const approved = await call(t, t.daemon.agentToken(a.id), url, { decision: "approve", why: "ok", grantMicros: 5, idempotencyKey: "d2" });
  assert.equal(approved.status, 201);
  assert.equal((approved.body as { state: string }).state, "approved");
  assert.equal((await inbox(t, a.id)).length, 0);
  // The requester's retry converges on the approval.
  assert.equal((await t.daemon.requireApproval(c, "budget_raise", "x", "k")).state, "approved");
});

test("approval: a lapsed agent window advances to the next holder, then the operator via root, and the human top denies", async () => {
  const t = rig();
  const { a, b, c } = await chain3(t);
  await assert.rejects(t.daemon.requireApproval(c, "budget_raise", "x", "k"), (e: { status?: number }) => e.status === 409);
  clock += 1_001;
  await t.daemon.sweepApprovals();
  assert.equal((await inbox(t, b.id)).length, 0);
  assert.equal((await inbox(t, a.id)).length, 1);
  clock += 1_001;
  await t.daemon.sweepApprovals();
  const out = await outbox(t);
  assert.equal(out.length, 1);
  assert.match(out[0]!.subject, new RegExp(`^\\[from ${c.id}\\] approve budget_raise x`));
  clock += 5_001;
  await t.daemon.sweepApprovals();
  clock += 5_001;
  await t.daemon.sweepApprovals();
  await assert.rejects(t.daemon.requireApproval(c, "budget_raise", "x", "k"), (e: { status?: number }) => e.status === 403);
});

test("a top-level agent's approval keeps today's ladder: operator, owner, alert straight to the user", async () => {
  const t = rig();
  const a = await agentUnder(t, "a");
  await assert.rejects(t.daemon.requireApproval(a, "publish", "x", "k"), (e: { status?: number }) => e.status === 409);
  const ap = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
  assert.deepEqual(ap.rungs, ["operator", "owner"]);
  assert.equal((await outbox(t))[0]!.subject, "approve publish x? reply approve or deny");
  assert.equal((await t.operator("POST", `/v1/approvals/${ap.id}/decide`, { decision: "approve", idempotencyKey: "o1" })).status, 201);
});

test("decide as an agent refuses a grant above the approver's remaining budget (409 insufficient_budget)", async () => {
  const t = rig();
  const a = await agentUnder(t, "a", undefined, 100);
  const c = await agentUnder(t, "c", a.id, 10);
  await assert.rejects(t.daemon.requireApproval(c, "budget_raise", "x", "k"), (e: { status?: number }) => e.status === 409);
  const ap = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
  const r = await call(t, t.daemon.agentToken(a.id), `/v1/approvals/${ap.id}/decide`, { decision: "approve", grantMicros: 10_000, idempotencyKey: "g1" });
  assert.equal(r.status, 409);
  assert.equal((r.body as { code?: string }).code, "insufficient_budget");
  assert.equal((await call(t, op, `/v1/approvals/${ap.id}/decide`, { decision: "nope", idempotencyKey: "g2" })).status, 400);
});

test("relayOf renders an escalation with replyTo, sender-prefixed; the outbox subject is sanitized", async () => {
  const sig: Signal = { kind: "escalation", escalation: "es-1", subject: "ask", from: "kid", body: "hi @everyone", deadlineAt: 1 };
  assert.deepEqual(relayOf(sig), { purpose: "ask", subject: "[from kid] hi @everyone", replyTo: "es-1", subjectKind: "ask" });
  assert.deepEqual(relayOf({ ...sig, options: ["y", "n"] }), {
    purpose: "ask",
    subject: "[from kid] hi @everyone",
    replyTo: "es-1",
    subjectKind: "ask",
    options: ["y", "n"],
  });
  for (const subject of ["approval", "budget_raise"] as const) assert.equal(relayOf({ ...sig, subject })?.subjectKind, "approval");
  const t = rig();
  const a = await agentUnder(t, "a");
  const c = await agentUnder(t, "c", a.id);
  await t.daemon.ask(c.id, { question: "ping @everyone", generation: c.generation, idempotencyKey: "k1" });
  await t.daemon.passEscalation((await t.daemon.deps.escalations.list())[0]!.id, a.id, "p");
  const out = await outbox(t);
  assert.equal(out.length, 1);
  assert.ok(!out[0]!.subject.includes("@everyone"), "mention broken by toUser");
});

test("budget_warning: emitted once per generation instead of a nudge; a budget trip alone does not climb the ladder", async () => {
  const t = rig(undefined, { watchdogOptions: { stallMs: 1e12 } });
  const a = await agentUnder(t, "a", undefined, 1_000);
  const gateway = t.daemon.deps.gateway as { spend: (id: string) => Promise<{ spentMicros: number; budgetMicros: number }> };
  gateway.spend = async () => ({ spentMicros: 950, budgetMicros: 1_000 });
  await t.daemon.sweepWatchdogs();
  await t.daemon.sweepWatchdogs();
  const box = await t.daemon.deps.mailbox.peek(a.id);
  assert.deepEqual(
    box.map((s) => s.kind),
    ["budget_warning"],
  );
  const w = box[0] as unknown as { remainingMicros: number; budgetMicros: number; thresholdFraction: number; id: string };
  assert.deepEqual([w.remainingMicros, w.budgetMicros, w.thresholdFraction, w.id], [50, 1_000, 0.9, `${a.id}:${a.generation}:budget_warning`]);
  assert.equal((await t.daemon.deps.watchdogs.get(a.id))?.rung ?? "none", "none");
  assert.equal((await t.daemon.get(a.id))?.state, "running");
});

test("no agent approver for external-effect or unknown kinds: ladder is operator, owner and a parent's decide is refused", async () => {
  for (const kind of ["publish", "merge", "extension", "snapshot", "made_up_kind"]) {
    const t = rig();
    const { a, b, c } = await chain3(t);
    await assert.rejects(t.daemon.requireApproval(c, kind, "x", "k"), (e: { status?: number }) => e.status === 409);
    const ap = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
    assert.deepEqual(ap.rungs, ["operator", "owner"], kind);
    assert.equal((await inbox(t, b.id)).length, 0);
    const url = `/v1/approvals/${ap.id}/decide`;
    for (const who of [b, a]) {
      const r = await call(t, t.daemon.agentToken(who.id), url, { decision: "approve", idempotencyKey: `d-${who.id}` });
      assert.equal(r.status, 403, `${kind} by ${who.name}`);
    }
    assert.equal((await t.fakes.approvals.get(ap.id))?.state, "pending");
    assert.equal((await t.operator("POST", url, { decision: "approve", idempotencyKey: "o1" })).status, 201);
  }
});

test("a legacy pending publish approval with agent rungs is not decidable by an agent (403); the operator still can", async () => {
  const t = rig();
  const { a, b, c } = await chain3(t);
  const ap = await t.fakes.approvals.create(
    {
      id: "legacy-publish",
      requester: { id: c.id, rank: "agent", generation: c.generation },
      action: { kind: "publish", target: "x" },
      host: "h1",
      deadlineAt: clock + 60_000,
      rungs: [`agent:${b.id}`, `agent:${a.id}`, "operator", "owner"],
      rungWindowsMs: [60_000, 60_000, 60_000, 60_000],
    },
    "legacy-k",
  );
  const url = `/v1/approvals/${ap.id}/decide`;
  const r = await call(t, t.daemon.agentToken(b.id), url, { decision: "approve", idempotencyKey: "d-b" });
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.body), /publish/);
  assert.equal((await t.fakes.approvals.get(ap.id))?.state, "pending");
  assert.equal((await t.operator("POST", url, { decision: "approve", idempotencyKey: "o1" })).status, 201);
});
