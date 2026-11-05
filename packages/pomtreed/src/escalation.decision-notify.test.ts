import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Approval, Signal } from "@pomtree/core";
import { LifecycleError } from "./lifecycle.ts";
import { runningAgent, setup } from "./test-setup.ts";

// Approval decision notification and getApprovalFor, through the public Daemon facades over the shared fakes. A decision
// must leave a keyed `approval_decided` signal in the requester's mailbox before any wake; a wake happens only while that
// signal is still queued. Budget raises and missing or reaped requesters are not mailed; an exited requester is mailed without a wake. Every one of these is stamped delivered.

const WINDOW = 100;
const SIGNAL_KEY = (id: string, state: string) => `${id}:decision:${state}`;

type Wake = { agent: string; signal: Signal; queued: boolean };
type Probe = { escalation: { getApprovalFor(agent: string, id: string): Promise<Approval | null> } };

// A running, non-root agent created straight in the registry (no live drive handle).
async function exitedAgent(t: ReturnType<typeof setup>, key: string): Promise<AgentRecord> {
  const a = await runningAgent(t, key);
  return t.daemon.deps.registry.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${key}-exit` });
}

// Records every wake and whether the decision signal was still queued at the moment of the wake. Replaces the
// orchestrator's wake on this instance only (the real wake would drive a harness run); `fail` makes it throw.
function recordWakes(t: ReturnType<typeof setup>, fail = false): Wake[] {
  const wakes: Wake[] = [];
  t.orchestrator.wake = async (agent: string, signal: Signal) => {
    const queued = (await t.fakes.mailbox.peek(agent)).some((m) => m.kind === "approval_decided");
    wakes.push({ agent, signal, queued });
    if (fail) throw new Error("boom");
  };
  return wakes;
}

type ApprovalDecided = Extract<Signal, { kind: "approval_decided" }>;
const decisionSignals = async (t: ReturnType<typeof setup>, agent: string) =>
  (await t.fakes.mailbox.peek(agent)).filter((m) => m.kind === "approval_decided") as ApprovalDecided[];

function withApprovals(t: ReturnType<typeof setup>) {
  t.daemon.deps.approvals = t.fakes.approvals;
  return t;
}

// Opens a publish approval for a real requester (operator ladder, no agent rungs), as the gated-call path does.
async function openPublish(t: ReturnType<typeof setup>, requester: AgentRecord, key: string): Promise<Approval> {
  return (t.daemon as unknown as { openApproval(a: AgentRecord, kind: string, target: string, key: string): Promise<Approval> }).openApproval(
    requester,
    "publish",
    "ab".repeat(32),
    key,
  );
}

// A requester-less approval row (no generation, so the fake store does not check the registry) with a given ladder.
async function rawApproval(
  t: ReturnType<typeof setup>,
  o: { id: string; requester: string; kind?: string; target?: string; rungs: string[]; windows: number[]; deadlineAt: number },
): Promise<Approval> {
  return t.fakes.approvals.create(
    {
      id: o.id,
      requester: { id: o.requester, rank: "agent" },
      action: { kind: o.kind ?? "publish", target: o.target ?? "ab".repeat(32) },
      host: "h1",
      deadlineAt: o.deadlineAt,
      rungs: o.rungs as Approval["rungs"],
      rungWindowsMs: o.windows,
    },
    `create:${o.id}`,
  );
}

test("getApprovalFor throws 503 when approvals are not configured", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const probe = t.daemon as unknown as Probe;
  await assert.rejects(probe.escalation.getApprovalFor("any", "ap-x"), (e: unknown) => e instanceof LifecycleError && e.status === 503);
});

test("getApprovalFor returns null for an unknown approval id", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  assert.equal(await (t.daemon as unknown as Probe).escalation.getApprovalFor("any", "ap-missing"), null);
});

test("getApprovalFor is 403 unless the caller is the requester or the agent holding the current rung", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped), { now: () => 1_000_000 }));
  const req = await runningAgent(t, "req");
  const holder = await runningAgent(t, "holder");
  const ap = await rawApproval(t, {
    id: "ap-403",
    requester: req.id,
    rungs: [`agent:${holder.id}`, "operator"],
    windows: [WINDOW, WINDOW],
    deadlineAt: 1_000_000 + WINDOW,
  });
  const probe = t.daemon as unknown as Probe;

  await assert.rejects(probe.escalation.getApprovalFor("stranger", ap.id), (e: unknown) => e instanceof LifecycleError && e.status === 403);
  const asRequester = await probe.escalation.getApprovalFor(req.id, ap.id);
  assert.equal(asRequester?.id, ap.id);
  const asHolder = await probe.escalation.getApprovalFor(holder.id, ap.id);
  assert.equal(asHolder?.id, ap.id);
});

test("getApprovalFor settles an expired rung before returning and notifies the requester on the terminal decision", async () => {
  let clock = 1_000_000;
  const t = withApprovals(setup(async (c) => void (await c.stopped), { now: () => clock }));
  const wakes = recordWakes(t);
  const req = await runningAgent(t, "req");
  const holder = await runningAgent(t, "holder");
  const ap = await rawApproval(t, {
    id: "ap-expire",
    requester: req.id,
    rungs: [`agent:${holder.id}`, "operator"],
    windows: [WINDOW, WINDOW],
    deadlineAt: clock + WINDOW,
  });
  const probe = t.daemon as unknown as Probe;

  clock += WINDOW + 1;
  const moved = await probe.escalation.getApprovalFor(req.id, ap.id);
  assert.equal(moved?.state, "pending", "the first rung lapsed; the approval moves to the operator rung, still open");
  assert.equal(moved?.rungIndex, 1);
  assert.equal((await decisionSignals(t, req.id)).length, 0, "no terminal decision, so nothing is mailed to the requester");

  clock += WINDOW + 1;
  const denied = await probe.escalation.getApprovalFor(req.id, ap.id);
  assert.equal(denied?.state, "denied", "the top rung lapsed: fail closed");
  const queued = await decisionSignals(t, req.id);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.approval, ap.id);
  assert.equal(queued[0]!.state, "denied");
  assert.deepEqual(
    wakes.map((w) => [w.agent, w.queued]),
    [[req.id, true]],
  );
});

test("a pending approval does not notify its requester", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-pending");
  assert.equal(ap.state, "pending");
  assert.equal((await decisionSignals(t, req.id)).length, 0);
});

test("a budget_raise decision is not notified through the approval_decided signal", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await runningAgent(t, "req");
  const target = `${req.id}:${req.generation}:1:500`;
  await rawApproval(t, {
    id: "ap-budget",
    requester: req.id,
    kind: "budget_raise",
    target,
    rungs: ["operator"],
    windows: [WINDOW],
    deadlineAt: Date.now() + WINDOW,
  });
  const decided = await t.daemon.decideApproval("ap-budget", "deny", "op", "no", "d-budget");
  assert.equal(decided.state, "denied");
  assert.equal((await decisionSignals(t, req.id)).length, 0);
  assert.equal(wakes.length, 0);
});

test("a decision for a requester missing from the registry is not mailed and is stamped once, so it leaves the unnotified list", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  await rawApproval(t, { id: "ap-ghost", requester: "ghost", rungs: ["operator"], windows: [WINDOW], deadlineAt: Date.now() + WINDOW });
  const decided = await t.daemon.decideApproval("ap-ghost", "approve", "op", "ok", "d-ghost");
  assert.equal(decided.state, "approved");
  assert.equal((await t.fakes.mailbox.peek("ghost")).length, 0);
  assert.equal(wakes.length, 0);
  assert.notEqual((await t.fakes.approvals.get("ap-ghost"))!.notifiedAt, undefined, "nobody to deliver to: stamped");
  assert.deepEqual(await t.fakes.approvals.list({ unnotified: true }), [], "a later sweep does not rescan it");
});

test("a decision for a reaped requester is not mailed and is stamped once", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await exitedAgent(t, "req");
  const ap = await rawApproval(t, { id: "ap-reaped", requester: req.id, rungs: ["operator"], windows: [WINDOW], deadlineAt: Date.now() + WINDOW });
  await t.fakes.approvals.decide(ap.id, { who: "op", rank: "operator", decision: "approve", why: "late" }, "late-reaped");
  await t.daemon.deps.registry.transition(req.id, req.generation, "reaped", { idempotencyKey: "req-reap" });
  await t.daemon.sweepApprovals();
  assert.equal((await decisionSignals(t, req.id)).length, 0);
  assert.equal(wakes.length, 0);
  assert.notEqual((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined);
  assert.deepEqual(await t.fakes.approvals.list({ unnotified: true }), []);
});

test("a decision for an exited requester is mailed without a wake (an exited agent can resume) and stamped once", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await exitedAgent(t, "req");
  const ap = await rawApproval(t, { id: "ap-done", requester: req.id, rungs: ["operator"], windows: [WINDOW], deadlineAt: Date.now() + WINDOW });
  const decided = await t.daemon.decideApproval(ap.id, "approve", "op", "ok", "d-done");
  assert.equal(decided.state, "approved");
  assert.equal((await decisionSignals(t, req.id)).length, 1, "durable for the resumed requester");
  assert.equal(wakes.length, 0, "an exited agent is not woken");
  assert.notEqual((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined);
  assert.deepEqual(await t.fakes.approvals.list({ unnotified: true }), []);
});

test("a decision stores the keyed approval_decided signal before waking the requester, and wakes once", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-approve");
  const decided = await t.daemon.decideApproval(ap.id, "approve", "op", "ok", "d-approve");
  assert.equal(decided.state, "approved");

  const key = SIGNAL_KEY(ap.id, "approved");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.agent, req.id);
  assert.equal(wakes[0]!.queued, true, "the signal is durable in the mailbox when the wake fires");
  assert.deepEqual(wakes[0]!.signal, { kind: "approval_decided", approval: ap.id, state: "approved", action: { kind: "publish", target: "ab".repeat(32) } });
  const queued = await decisionSignals(t, req.id);
  assert.equal(queued.length, 1);
  assert.ok((await t.fakes.mailbox.peek(req.id)).some((m) => m.id === key));
});

test("a consumed decision signal is not re-created and does not re-wake on replay", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-consumed");
  await t.daemon.decideApproval(ap.id, "approve", "op", "ok", "d-consumed");
  assert.equal(wakes.length, 1);

  await t.fakes.mailbox.ack(req.id, [SIGNAL_KEY(ap.id, "approved")], "ack-consumed");
  assert.equal((await decisionSignals(t, req.id)).length, 0);

  await t.daemon.sweepApprovals();
  assert.equal((await decisionSignals(t, req.id)).length, 0, "the consumed keyed signal is not re-created");
  assert.equal(wakes.length, 1, "a later sweep does not re-wake the requester");
});

test("a failed wake leaves the durable decision signal and records a wake error, and the decision still resolves", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t, true);
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-wake-fail");
  const decided = await t.daemon.decideApproval(ap.id, "deny", "op", "no", "d-wake-fail");
  assert.equal(decided.state, "denied");

  assert.equal(wakes.length, 1);
  assert.equal((await decisionSignals(t, req.id)).length, 1, "the signal survives the failed wake");
  const errors = (await t.journal.read({ agent: req.id })).filter((e) => e.payload.kind === "error");
  assert.ok(
    errors.some((e) => e.payload.kind === "error" && e.payload.message.includes(`wake of ${req.id} failed: boom`)),
    "the failed wake is journaled on the requester",
  );
});

test("reconcile replays the notification of an approved or denied row whose decision committed before notification", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await runningAgent(t, "req");
  const approved = await openPublish(t, req, "k-crash-a");
  const denied = await openPublish(t, req, "k-crash-d");
  // Simulate the crash: the store commits the terminal decisions, but no notification runs.
  await t.fakes.approvals.decide(approved.id, { who: "op", rank: "operator", decision: "approve", why: "crash" }, "crash-a");
  await t.fakes.approvals.decide(denied.id, { who: "op", rank: "operator", decision: "deny", why: "crash" }, "crash-d");
  assert.equal((await decisionSignals(t, req.id)).length, 0, "precondition: the crash left no notification");

  await t.daemon.reconcile();

  const states = (await decisionSignals(t, req.id)).map((s) => [s.approval, s.state]).sort();
  assert.deepEqual(
    states,
    [
      [approved.id, "approved"],
      [denied.id, "denied"],
    ].sort(),
  );
  assert.equal(wakes.length, 2);
  assert.ok(wakes.every((w) => w.agent === req.id && w.queued));
});

test("getApprovalFor is 403 for a holder of a rung that is no longer current", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped), { now: () => 1_000_000 }));
  const req = await runningAgent(t, "req");
  const first = await runningAgent(t, "first");
  const second = await runningAgent(t, "second");
  const ap = await rawApproval(t, {
    id: "ap-rung",
    requester: req.id,
    rungs: [`agent:${first.id}`, `agent:${second.id}`, "operator"],
    windows: [WINDOW, WINDOW, WINDOW],
    deadlineAt: 1_000_000 + WINDOW,
  });
  const probe = t.daemon as unknown as Probe;
  assert.equal((await probe.escalation.getApprovalFor(first.id, ap.id))?.id, ap.id, "the current holder reads");
  await assert.rejects(
    probe.escalation.getApprovalFor(second.id, ap.id),
    (e: unknown) => e instanceof LifecycleError && e.status === 403,
    "a later rung holder is not yet current",
  );
  // Advance past the first rung; the first holder is now a past rung.
  await t.fakes.approvals.decide(ap.id, { who: first.id, rank: "parent-agent", decision: "abstain", why: "pass" }, "pass-first");
  assert.equal((await t.fakes.approvals.get(ap.id))?.rungIndex, 1);
  await assert.rejects(
    probe.escalation.getApprovalFor(first.id, ap.id),
    (e: unknown) => e instanceof LifecycleError && e.status === 403,
    "a past rung holder is refused",
  );
  assert.equal((await probe.escalation.getApprovalFor(second.id, ap.id))?.id, ap.id);
});

test("a mailbox failure after the decision commits does not fail the decision or skip other requesters", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const bad = await runningAgent(t, "bad");
  const good = await runningAgent(t, "good");
  const apBad = await openPublish(t, bad, "k-bad");
  const apGood = await openPublish(t, good, "k-good");
  const realSend = t.fakes.mailbox.send.bind(t.fakes.mailbox);
  t.fakes.mailbox.send = (async (to: string, ...rest: unknown[]) => {
    if (to === bad.id) throw new Error("requester gone");
    return (realSend as (...a: unknown[]) => Promise<unknown>)(to, ...rest);
  }) as typeof t.fakes.mailbox.send;

  const decided = await t.daemon.decideApproval(apBad.id, "approve", "op", "ok", "d-bad");
  assert.equal(decided.state, "approved", "a committed decision is reported as made");
  assert.equal((await t.fakes.approvals.get(apBad.id))?.state, "approved");

  await t.fakes.approvals.decide(apGood.id, { who: "op", rank: "operator", decision: "approve", why: "x" }, "d-good");
  await t.daemon.sweepApprovals();
  assert.equal((await decisionSignals(t, good.id)).length, 1, "one requester's failure does not skip another's notification");
  assert.equal(wakes.filter((w) => w.agent === good.id).length, 1);
});

// Fixed: approval replay. A delivered decision is marked on the approval row, and the sweep never re-sends a marked one, even
// when the idempotency table no longer remembers the send key (simulated by counting sends: a forgotten key would send again).
function countSends(t: ReturnType<typeof setup>): string[] {
  const sent: string[] = [];
  const send = t.fakes.mailbox.send.bind(t.fakes.mailbox);
  t.fakes.mailbox.send = async (agent, signal, key) => {
    if (signal.kind === "approval_decided") sent.push(key);
    return send(agent, signal, key);
  };
  return sent;
}

test("a delivered decision is marked notified and later sweeps send nothing for it", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const sent = countSends(t);
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-marked");
  assert.equal((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined);
  await t.daemon.decideApproval(ap.id, "approve", "op", "ok", "d-marked");
  assert.notEqual((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined, "marked once the signal is enqueued and the wake attempted");
  assert.deepEqual(sent, [SIGNAL_KEY(ap.id, "approved")]);
  await t.daemon.sweepApprovals();
  await t.daemon.sweepApprovals();
  assert.deepEqual(sent, [SIGNAL_KEY(ap.id, "approved")], "no replay, so an expired idempotency key cannot cause a re-mail");
  assert.equal(wakes.length, 1);
  assert.deepEqual(await t.fakes.approvals.list({ unnotified: true }), []);
});

test("an unmarked decision (crash before the mark) is replayed through its keys exactly once and then marked", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  const wakes = recordWakes(t);
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-crash-mark");
  const markNotified = t.fakes.approvals.markNotified.bind(t.fakes.approvals);
  let crash = true;
  t.fakes.approvals.markNotified = async (id, key) => {
    if (crash) throw new Error("crash before the mark");
    return markNotified(id, key);
  };
  const decided = await t.daemon.decideApproval(ap.id, "deny", "op", "no", "d-crash-mark");
  assert.equal(decided.state, "denied", "a failed mark never fails the committed decision");
  assert.equal((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined);
  crash = false;
  await t.daemon.sweepApprovals();
  assert.notEqual((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined);
  assert.equal((await decisionSignals(t, req.id)).length, 1, "the keyed send is not duplicated by the replay");
  assert.equal(wakes.length, 2, "the signal was still queued, so the replay wakes again (as before the marker existed)");
});

test("a decision that could not be delivered stays owed: a failed send is not marked", async () => {
  const t = withApprovals(setup(async (c) => void (await c.stopped)));
  recordWakes(t);
  const req = await runningAgent(t, "req");
  const ap = await openPublish(t, req, "k-owed");
  const send = t.fakes.mailbox.send.bind(t.fakes.mailbox);
  let down = true;
  t.fakes.mailbox.send = async (agent, signal, key) => {
    if (down && signal.kind === "approval_decided") throw new Error("mailbox unavailable");
    return send(agent, signal, key);
  };
  await t.daemon.decideApproval(ap.id, "approve", "op", "ok", "d-owed");
  assert.equal((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined, "a failed send is not marked delivered");
  assert.deepEqual(
    (await t.fakes.approvals.list({ unnotified: true })).map((a) => a.id),
    [ap.id],
  );
  down = false;
  await t.daemon.sweepApprovals();
  assert.notEqual((await t.fakes.approvals.get(ap.id))!.notifiedAt, undefined, "the next sweep delivers and marks it");
});
