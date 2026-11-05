import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Approval, JournalEntry, SpawnSpec } from "@pomtree/core";
import { handle } from "./api.ts";
import { parseBudgetRaiseTarget } from "./budget-raise.ts";
import { MODEL_BUDGET_EXHAUSTED } from "./model-proxy/service.ts";
import { get, op, setup, until } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

// Budget escalation: exhaustion parks the agent behind a budget_raise approval that climbs its ancestor chain; the grant
// hook carves the slice from the deciding ancestor and resumes the agent (docs/economy.md section 13).

type T = ReturnType<typeof setup>;
const clock = { v: Date.now() };
const kindsOf = async (t: T, id: string, kind: string): Promise<JournalEntry[]> => (await t.journal.read({ agent: id })).filter((e) => e.payload.kind === kind);
const raises = (t: T, id: string) => t.fakes.approvals.list({ requester: id }).then((l) => l.filter((a) => a.action.kind === "budget_raise"));
const requested = (a: Approval) => parseBudgetRaiseTarget(a.action.target)!.requestedMicros;
const remaining = async (t: T, id: string) => t.daemon.remainingMicros(await get(t, id));
const decide = (t: T, ap: Approval, decision: "approve" | "deny" | "pass", key: string, as: { agent?: string; grantMicros?: number } = {}) =>
  t.daemon.decideApproval(ap.id, decision, "operator", "", key, as);

function rig(script: (c: Ctx) => Promise<void>, over: Parameters<typeof setup>[1] = {}, approvals = true) {
  clock.v = Date.now();
  const t = setup(script, {
    now: () => clock.v,
    escAgentMs: 1_000,
    approvalTimeoutMs: 5_000,
    budgetRaiseMs: 50_000,
    approvalWaitMs: 5,
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    ...over,
  });
  if (approvals) t.daemon.deps.approvals = t.fakes.approvals;
  return t;
}

// A top-level agent that exhausts its budget (cost) on its first segment and reports on the wake.
function solo(cost = 1_500) {
  const wakes: string[] = [];
  const script = async (c: Ctx) => {
    if (c.wake) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "done" } }));
    }
    c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: cost });
    await c.stopped;
  };
  return { wakes, script };
}

const parkedAgent = async (t: T, key = "k", extra: object = {}) => {
  const a = await t.spawn(key, { budgetMicros: 1_000, ...extra });
  await until(async () => (await get(t, a.id)).state === "yielded" && (await raises(t, a.id)).length > 0);
  return a;
};

test("usage at the budget parks the agent behind a budget_raise approval (checkpoint with null wait, no exit, slot released)", async () => {
  const { script } = solo();
  const t = rig(script);
  const a = await parkedAgent(t);
  await t.orchestrator.idle();
  const rec = await get(t, a.id);
  assert.equal(rec.exit, null);
  assert.equal((await t.daemon.deps.checkpoints.latest(a.id))!.wait, null);
  const [ap] = await raises(t, a.id);
  assert.equal(ap!.state, "pending");
  assert.deepEqual(ap!.rungs, ["operator", "owner"]);
  assert.equal(ap!.deadlineAt - ap!.createdAt, 50_000, "human rungs use POMTREED_BUDGET_RAISE_MS");
  assert.equal(requested(ap!), 1_000, "the 500 overshoot plus 50% of the original budget");
  const esc = (await kindsOf(t, a.id, "ext.pomtreed.budget_escalated"))[0]!.payload as unknown as {
    approval: string;
    requested: number;
    spent: number;
    budget: number;
  };
  assert.deepEqual([esc.approval, esc.requested, esc.spent, esc.budget], [ap!.id, 1_000, 1_500, 1_000]);
  await until(async () => (await t.daemon.deps.placement.status()).every((h) => !h.running.includes(a.id))); // the admission slot is released
});

test("the overshoot sets the requested amount when it exceeds the percent; the percent is configurable", async () => {
  const big = rig(solo(3_000).script);
  const a = await parkedAgent(big);
  assert.equal(requested((await raises(big, a.id))[0]!), 2_500, "overshoot 2000 plus 50% of 1000 (budget-raise-headroom)");
  const pct = rig(solo(1_000).script, { budgetRaisePct: 200 });
  const b = await parkedAgent(pct);
  assert.equal(requested((await raises(pct, b.id))[0]!), 2_000, "200% of the original budget");
});

test("the proxy's 402 text parks the agent even when spend is under the cap", async () => {
  const t = rig(async (c) => {
    if (c.wake) return;
    c.emit({
      kind: "error",
      message: `402 ${MODEL_BUDGET_EXHAUSTED}: 3 micro-USD remain after in-flight requests, below the 80 micro-USD minimum for this request`,
    });
    await c.stopped;
  });
  const a = await parkedAgent(t);
  assert.equal(requested((await raises(t, a.id))[0]!), 500);
  assert.equal((await get(t, a.id)).state, "yielded");
});

test("a result already reported settles on the result: no yield, no approval", async () => {
  const t = rig(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "reported first" } });
    c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 5_000 });
    await c.stopped;
  });
  const a = await t.spawn("k", { budgetMicros: 1_000 });
  await t.orchestrator.idle();
  const rec = await get(t, a.id);
  assert.equal(rec.exit, "succeeded");
  assert.equal((await raises(t, a.id)).length, 0);
});

test("approvals not configured: fail closed to over_budget, nothing parked", async () => {
  const t = rig(solo().script, {}, false);
  const a = await t.spawn("k", { budgetMicros: 1_000 });
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).exit, "over_budget");
  assert.equal(await t.daemon.deps.checkpoints.latest(a.id), null);
});

test("a yield that fails before its checkpoint falls back to over_budget and withdraws the approval", async () => {
  const t = rig(solo().script);
  t.fakes.checkpoints.write = async () => {
    throw new Error("disk full");
  };
  const a = await t.spawn("k", { budgetMicros: 1_000 });
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).exit, "over_budget");
  const [ap] = await raises(t, a.id);
  assert.equal(ap!.state, "denied", "nobody can grant into an agent that already failed");
});

test("approval first, then yield: the approval exists when the yield starts, and a replayed escalation reuses it (key budget:<gen>)", async () => {
  const t = rig(solo().script);
  let seen = -1;
  const y = t.daemon.yield.bind(t.daemon);
  t.daemon.yield = async (agent, o) => {
    seen = (await raises(t, agent)).length;
    assert.deepEqual([o.wait, o.idempotencyKey], [null, "budget:0"]);
    return y(agent, o);
  };
  const a = await parkedAgent(t);
  assert.equal(seen, 1);
  const rec = await get(t, a.id);
  const priv = t.daemon as unknown as { openApproval(r: AgentRecord, kind: string, target: string, key: string): Promise<Approval> };
  const [ap] = await raises(t, a.id);
  assert.equal(
    (await priv.openApproval(rec, "budget_raise", ap!.action.target, "budget:0")).id,
    ap!.id,
    "deterministic id: one approval per agent per generation",
  );
  assert.equal((await raises(t, a.id)).length, 1);
  // A replayed park (same key) returns the checkpoint already written.
  const again = await t.daemon.yield(a.id, { wait: null, idempotencyKey: "budget:0" });
  assert.equal(again.id, (await t.daemon.deps.checkpoints.latest(a.id))!.id);
});

test("operator approve grants the requested amount out of root's remaining budget; the agent resumes at generation+1 with a fresh, larger key", async () => {
  const { script, wakes } = solo();
  const t = rig(script);
  const issued: number[] = [];
  const gw = t.daemon.deps.gateway;
  const issue = gw.issueKey.bind(gw);
  gw.issueKey = async (agent, budgetMicros, k) => (issued.push(budgetMicros), issue(agent, budgetMicros, k));
  const a = await parkedAgent(t);
  const root = await t.daemon.root();
  const before = await remaining(t, root.id);
  // Nothing resumes it meanwhile: a reconcile with the approval pending moves no money and wakes nobody.
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).state, "yielded");
  assert.equal(await remaining(t, root.id), before);

  const [ap] = await raises(t, a.id);
  await decide(t, ap!, "approve", "d1");
  await t.orchestrator.idle();
  const rec = await get(t, a.id);
  assert.equal(rec.exit, "succeeded");
  assert.equal(rec.generation, 1);
  assert.equal(rec.budgetMicros, 2_000);
  // overage-book: the 500 spent past the 1000 carve was booked against root as it happened (a live child holds max(carve,
  // consumed)), so the grant of 1000 (overshoot + 50% headroom) costs root only the 500 headroom, and that headroom came back
  // when the finished agent was reaped (a reaped child holds what it consumed).
  assert.equal(await remaining(t, root.id), before);
  assert.deepEqual(issued, [1_000, 2_000], "the resumed key carries the TOTAL raised budget");
  assert.match(
    wakes[0]!,
    /^Resumed: your budget \(\$0\.00 of \$0\.00\) was exhausted and you were parked\. the operator granted \+\$0\.00; budget is now \$0\.00 \(\$0\.00 left\)\. Tool calls in flight when you stopped were aborted and may have partly run; re-check workspace state before continuing\.$/,
  );
  const granted = (await kindsOf(t, a.id, "ext.pomtreed.budget_granted"))[0]!.payload as unknown as { amount: number; payer: string; newBudget: number };
  assert.deepEqual([granted.amount, granted.payer, granted.newBudget], [1_000, root.id, 2_000]);
  // Replays and later ticks never grant twice.
  await decide(t, ap!, "approve", "d1");
  await t.daemon.reconcile();
  await t.daemon.applyBudgetDecision(a.id);
  assert.equal((await get(t, a.id)).budgetMicros, 2_000);
  assert.equal(await remaining(t, root.id), before);
});

test("an explicit --grant overrides the request; a grant beyond root's remaining is 409 insufficient_budget and moves nothing", async () => {
  // Carve 1000 of 1700, consumed 1500: the 500 overage is already booked, so root has 200 left and a grant costs root only what
  // it adds past the 1500 the agent consumed (overage-book).
  const t = rig(solo().script, { rootBudgetMicros: 1_700 });
  const a = await parkedAgent(t);
  const [ap] = await raises(t, a.id);
  await assert.rejects(
    decide(t, ap!, "approve", "d1", { grantMicros: 701 }),
    (e: { status?: number; extra?: { code?: string } }) => e.status === 409 && e.extra?.code === "insufficient_budget",
  ); // costs 201 > 200
  await assert.rejects(decide(t, ap!, "approve", "d2", { grantMicros: 900 }), (e: { extra?: { code?: string } }) => e.extra?.code === "insufficient_budget");
  assert.equal((await t.fakes.approvals.get(ap!.id))!.state, "pending");
  const r = await handle(t.daemon, {
    method: "POST",
    url: `/v1/approvals/${ap!.id}/decide`,
    token: op,
    body: { decision: "approve", grantMicros: 650, idempotencyKey: "d3" },
  });
  assert.equal(r.status, 201);
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).budgetMicros, 1_650);
  assert.equal((await get(t, a.id)).exit, "succeeded");
});

test("a payer already overdrawn by a booked overage cannot grant, not even a raise that only covers the overage", async () => {
  const t = rig(solo().script, { rootBudgetMicros: 1_200 }); // carve 1000, consumed 1500: root is 300 over
  const a = await parkedAgent(t);
  const [ap] = await raises(t, a.id);
  await assert.rejects(
    decide(t, ap!, "approve", "d1"),
    (e: { status?: number; extra?: { code?: string } }) => e.status === 409 && e.extra?.code === "insufficient_budget",
  );
  assert.equal((await t.fakes.approvals.get(ap!.id))!.state, "pending");
  assert.equal((await get(t, a.id)).budgetMicros, 1_000);
});

test("a non-positive or unsafe grant is a 400", async () => {
  const t = rig(solo().script);
  const a = await parkedAgent(t);
  const [ap] = await raises(t, a.id);
  await assert.rejects(decide(t, ap!, "approve", "d1", { grantMicros: 0 }), (e: { status?: number }) => e.status === 400);
  await assert.rejects(decide(t, ap!, "approve", "d2", { grantMicros: 1.5 }), (e: { status?: number }) => e.status === 400);
});

test("GET /v1/approvals lists kind and requestedMicros for a budget_raise", async () => {
  const t = rig(solo().script);
  const a = await parkedAgent(t);
  const r = await handle(t.daemon, { method: "GET", url: "/v1/approvals", token: op });
  const row = (r.body as { requester: string; kind: string; requestedMicros?: number }[]).find((x) => x.requester === a.id)!;
  assert.deepEqual([row.kind, row.requestedMicros], ["budget_raise", 1_000]);
});

test("deny finishes over_budget with the folder kept; so does a swept timeout past the top rung", async () => {
  const denied = rig(solo().script);
  const a = await parkedAgent(denied);
  await decide(denied, (await raises(denied, a.id))[0]!, "deny", "d1");
  assert.equal((await get(denied, a.id)).exit, "over_budget");
  assert.equal(await denied.daemon.deps.workspace.has(a.id), true, "folder kept");
  assert.ok(await denied.daemon.deps.checkpoints.latest(a.id), "checkpoint kept");
  assert.equal((await kindsOf(denied, a.id, "ext.pomtreed.budget_denied")).length, 1);

  const timed = rig(solo().script);
  const b = await parkedAgent(timed);
  await timed.daemon.sweepApprovals();
  assert.equal((await get(timed, b.id)).state, "yielded", "not yet due");
  clock.v += 50_001; // operator rung lapses
  await timed.daemon.sweepApprovals();
  assert.equal((await get(timed, b.id)).state, "yielded");
  clock.v += 50_001; // owner rung lapses: fail closed
  await timed.daemon.sweepApprovals();
  const rec = await get(timed, b.id);
  assert.equal(rec.exit, "over_budget");
  assert.equal(await timed.daemon.deps.workspace.has(b.id), true);
});

test("at most one budget approval per generation; a second exhaustion after the grant opens one for the next generation", async () => {
  let segments = 0;
  const t = rig(async (c) => {
    segments++;
    if (segments === 3) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "done" } }));
    c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: segments === 1 ? 1_500 : 3_000 });
    await c.stopped;
  });
  const a = await parkedAgent(t);
  const [first] = await raises(t, a.id);
  await decide(t, first!, "approve", "d1");
  await until(async () => (await raises(t, a.id)).length === 2 && (await get(t, a.id)).state === "yielded");
  const both = await raises(t, a.id);
  assert.notEqual(both[0]!.id, both[1]!.id);
  assert.deepEqual(
    both.map((x) => x.requester.generation),
    [0, 1],
  );
  assert.equal(requested(both[1]!), 3_000, "overshoot (spent 4500 of 2000) plus 50% of the original 1000");
});

test("a stale generation is fenced: an approval for an old generation moves no money", async () => {
  const t = rig(solo().script);
  const a = await parkedAgent(t);
  const [ap] = await raises(t, a.id);
  await t.daemon.deps.registry.bumpGeneration(a.id, "h1", "stale-bump"); // the agent moved on (a forced resume, say)
  await decide(t, ap!, "approve", "d1");
  assert.equal((await get(t, a.id)).budgetMicros, 1_000);
  const denied = (await kindsOf(t, a.id, "ext.pomtreed.budget_denied"))[0]!.payload as unknown as { reason: string };
  assert.equal(denied.reason, "stale generation");
});

test("a parked agent is not resumed by `pomtree resume`, a message, an interrupt or a timer; the message stays queued", async () => {
  const t = rig(solo().script);
  const a = await parkedAgent(t);
  const r = await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/resume`, token: op, body: { idempotencyKey: "r1" } });
  assert.equal(r.status, 409);
  assert.equal((r.body as { code?: string }).code, "budget_pending");
  const forced = await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/resume`, token: op, body: { idempotencyKey: "r2", force: true } });
  assert.equal(forced.status, 409);
  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, a.id, "hello", root.generation, "m1");
  await t.daemon.messageAgent(a.id, "wake up", "m2", "interrupt");
  await t.orchestrator.wake(a.id, { kind: "timeout" });
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).state, "yielded");
  assert.equal((await get(t, a.id)).generation, 0);
  assert.ok(
    (await t.daemon.deps.mailbox.peek(a.id)).some((s) => s.kind === "message"),
    "the message stays queued",
  );
});

test("parked-agent interrupt: an interrupt journaled while parked rides in the grant's wake text once; the plain message stays queued", async () => {
  const { script, wakes } = solo();
  const t = rig(script);
  const a = await parkedAgent(t);
  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, a.id, "hello", root.generation, "m1");
  await t.daemon.messageAgent(a.id, "stop and report", "m2", "interrupt");
  assert.equal((await get(t, a.id)).state, "yielded", "still parked");
  await decide(t, (await raises(t, a.id))[0]!, "approve", "d1");
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!, /^Resumed: your budget .* Operator message received while you were parked: stop and report$/);
  const done = await kindsOf(t, a.id, "ext.pomtreed.interrupt_done");
  assert.equal(done.length, 1);
  assert.deepEqual((done[0]!.payload as unknown as { keys: string[] }).keys, ["m2"]);
  const queued = await t.daemon.deps.mailbox.peek(a.id);
  assert.ok(
    queued.some((s) => s.kind === "message"),
    "the plain message stays queued",
  );
  assert.ok(!queued.some((s) => (s as { interrupt?: boolean }).interrupt === true), "the delivered interrupt signal is drained");
  // A replayed hook neither re-delivers nor duplicates the done entry.
  await t.daemon.applyBudgetDecision(a.id);
  assert.equal((await kindsOf(t, a.id, "ext.pomtreed.interrupt_done")).length, 1);
  assert.equal(wakes.length, 1);
});

test("parked-agent interrupt: a denied agent drops the pending interrupt harmlessly (over_budget, no resume)", async () => {
  const t = rig(solo().script);
  const a = await parkedAgent(t);
  await t.daemon.messageAgent(a.id, "stop and report", "m2", "interrupt");
  await decide(t, (await raises(t, a.id))[0]!, "deny", "d1");
  await t.orchestrator.idle();
  const rec = await get(t, a.id);
  assert.equal(rec.exit, "over_budget");
  assert.equal(rec.generation, 0);
  assert.equal((await kindsOf(t, a.id, "ext.pomtreed.interrupt_done")).length, 0);
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).exit, "over_budget");
});

test("a budget-parked ancestor is unavailable as a hop: the approval auto-advances past it (journaled)", async () => {
  const t = rig(solo().script);
  const p = await parkedAgent(t);
  const kid = await t.daemon.deps.registry.create({
    executor: "container",
    spec: (await get(t, p.id)).spec as SpawnSpec,
    parent: p.id,
    name: "kid",
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: "kid",
  });
  const running = await t.daemon.deps.registry.transition(kid.id, kid.generation, "running", { idempotencyKey: "kid-run" });
  await assert.rejects(t.daemon.requireApproval(running, "budget_raise", "x", "k1"), (e: { status?: number }) => e.status === 409); // pending, not hung
  const [ap] = await t.fakes.approvals.list({ requester: kid.id });
  assert.equal(ap!.rungIndex, 1, "advanced past the parked parent to the operator");
  assert.equal((await t.daemon.deps.mailbox.peek(p.id)).filter((s) => s.kind === "escalation").length, 0, "the parked parent was never woken");
  const hops = (await kindsOf(t, kid.id, "ext.pomtreed.escalation_hop"))[0]!.payload as unknown as { auto?: string };
  assert.equal(hops.auto, "unavailable");
});

test("the wall-clock is paused while parked and shifted by the parked time on a grant", async () => {
  const { script } = solo();
  const t = rig(script);
  const a = await parkedAgent(t, "k", { deadlineMs: 5_000 });
  const d0 = (await t.daemon.sessionDeadlineAt(a.id))!;
  clock.v = d0 + 10_000; // far past the deadline while parked
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).state, "yielded", "rearmDeadlines does not time out a budget-parked agent");
  const [ap] = await raises(t, a.id);
  const parked = clock.v - ap!.createdAt;
  await decide(t, ap!, "approve", "d1");
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), d0 + parked);
  const shifts = (await kindsOf(t, a.id, "ext.pomtreed.deadline")).map((e) => (e.payload as unknown as { at: number }).at);
  assert.equal(shifts.at(-1), d0 + parked);
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).exit, "succeeded");
  // A replay of the shift keeps the first one.
  await t.daemon.applyBudgetDecision(a.id);
  assert.equal(await t.daemon.sessionDeadlineAt(a.id), d0 + parked);
});

test("a decision that lands while the agent is still parking is applied once settleYield finishes", async () => {
  const { script } = solo();
  const t = rig(script);
  const place = t.daemon.deps.placement;
  const release = place.release.bind(place);
  let slow = true;
  place.release = async (id) => {
    if (slow) await new Promise((r) => setTimeout(r, 150));
    return release(id);
  };
  const a = await t.spawn("k", { budgetMicros: 1_000 });
  await until(async () => (await raises(t, a.id)).length > 0);
  slow = true;
  await decide(t, (await raises(t, a.id))[0]!, "approve", "d1"); // before the teardown ends: the hook defers
  assert.equal((await get(t, a.id)).budgetMicros, 1_000, "nothing carved while the runtime is still being released");
  slow = false;
  await until(async () => (await get(t, a.id)).exit === "succeeded", 4000);
  assert.equal((await get(t, a.id)).budgetMicros, 2_000);
  assert.equal((await get(t, a.id)).generation, 1);
});

// Depth 3: a (budget 1000) under p1 (1200) under p2, under root.
function chain(p2Budget: number) {
  const ids: Record<string, string> = {};
  const wakes: string[] = [];
  const script = async (c: Ctx) => {
    const name = (await c.api("GET", "/v1/agents/self")).body as AgentRecord;
    const spawn = async (child: string, budgetMicros: number) => {
      ids[child] = ((await c.api("POST", "/v1/agents", { name: child, task: child, budgetMicros, idempotencyKey: child })).body as AgentRecord).id;
    };
    if (name.name === "p2") await spawn("p1", 1_200);
    else if (name.name === "p1") await spawn("a", 1_000);
    else if (c.wake) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "done" } }));
    } else if (name.name === "a") c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 1_500 });
    await c.stopped;
  };
  const start = async (t: T) => {
    ids.p2 = (await t.spawn("p2", { name: "p2", budgetMicros: p2Budget })).id;
    await until(async () => ids.a !== undefined && (await get(t, ids.a)).state === "yielded" && (await raises(t, ids.a)).length > 0);
    return (await raises(t, ids.a!))[0]!;
  };
  return { ids, wakes, script, start };
}

test("depth-3 chain: p1 has no money and passes, p2 grants; only p2's remaining falls, p1's is unchanged, a resumes at generation+1", async () => {
  const c = chain(2_200);
  const t = rig(c.script);
  const ap = await c.start(t);
  assert.deepEqual(ap.rungs, [`agent:${c.ids.p1}`, `agent:${c.ids.p2}`, "operator", "owner"]);
  // a consumed 1500 of its 1000 carve: the 500 overage is booked up the chain, so p1 (1200) is overdrawn by 300 and p2
  // (2200) holds max(1200, 1500) for p1, leaving 700.
  const p1Rem = await remaining(t, c.ids.p1!);
  const p2Rem = await remaining(t, c.ids.p2!);
  assert.equal(p1Rem, 0);
  assert.equal(p2Rem, 700);
  // p1 cannot cover the 1000 (500 overshoot + 500 headroom): 409 insufficient_budget, and it hands the request up with `pass`.
  await assert.rejects(decide(t, ap, "approve", "d1", { agent: c.ids.p1! }), (e: { extra?: { code?: string } }) => e.extra?.code === "insufficient_budget");
  await decide(t, ap, "pass", "d2", { agent: c.ids.p1! });
  assert.equal((await get(t, c.ids.a!)).state, "yielded");
  await decide(t, ap, "approve", "d3", { agent: c.ids.p2! });
  await until(async () => (await get(t, c.ids.a!)).exit === "succeeded");
  // Raising p1 and a by 1000 costs p2 only the 700 by which p1's hold grows (1500 -> 2200): the rest covers the booked overage.
  assert.equal(await remaining(t, c.ids.p2!), 0);
  assert.equal(await remaining(t, c.ids.p1!), 200, "p1's carve for a grew with a's budget: its own 200 is whole again");
  const a = await get(t, c.ids.a!);
  assert.deepEqual([a.budgetMicros, a.generation], [2_000, 1]);
  assert.equal((await get(t, c.ids.p1!)).budgetMicros, 2_200);
  assert.match(c.wakes[0]!, new RegExp(`${c.ids.p2} granted \\+`));
  assert.equal((await get(t, c.ids.p1!)).state, "running", "the middle layer was never woken or resumed by the park");
});

test("hook crash after the first raise, then replay: no double raise and the cover check is not re-run against a lowered balance", async () => {
  const c = chain(2_200); // p2 has exactly the 700 the grant costs: after the first raise it has 0
  const t = rig(c.script);
  const ap = await c.start(t);
  await decide(t, ap, "pass", "d1", { agent: c.ids.p1! });
  const reg = t.daemon.deps.registry;
  const raise = reg.raiseBudget.bind(reg);
  let calls = 0;
  reg.raiseBudget = async (id, delta, k) => {
    if (++calls === 2) throw new Error("crash after the first raise");
    return raise(id, delta, k);
  };
  await decide(t, ap, "approve", "d2", { agent: c.ids.p2! }); // the hook failure is swallowed (reconcile retries)
  assert.equal((await get(t, c.ids.p1!)).budgetMicros, 2_200, "the first raise landed");
  assert.equal((await get(t, c.ids.a!)).budgetMicros, 1_000, "the second did not");
  assert.equal((await get(t, c.ids.a!)).state, "yielded");
  await t.daemon.reconcile(); // replay
  await until(async () => (await get(t, c.ids.a!)).exit === "succeeded");
  assert.equal((await get(t, c.ids.p1!)).budgetMicros, 2_200, "not raised twice");
  assert.equal((await get(t, c.ids.a!)).budgetMicros, 2_000);
  assert.equal(await remaining(t, c.ids.p2!), 0);
  assert.equal((await kindsOf(t, c.ids.a!, "ext.pomtreed.budget_granted")).length, 1);
});
