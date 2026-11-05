// Custody of a dead parent's exited, unreaped descendants (TODO(guardian-reap)): they are never auto-reaped; the nearest live
// ancestor holds them as zombies and is notified, and a root custodian relays to the user, escalating past a bounded queue.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalEntry, Signal, WaitCondition } from "@pomtree/core";
import { budgetRaiseTarget } from "./budget-raise.ts";
import { Daemon } from "./daemon.ts";
import { YIELD_CTX_KIND } from "./daemon-util.ts";
import type { WaitCtx } from "./daemon-util.ts";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const withChannel = { escalationChannels: ["discord"] };
const sent = async (t: T, purpose: string) =>
  (await t.daemon.outbox({ channel: "discord" }))
    .map((e: JournalEntry) => e.payload as { kind: string; purpose: string; subject: string })
    .filter((p) => p.purpose === purpose)
    .map((p) => p.subject);
const tailOn = async (d: Daemon, r: AgentRecord, exit = "succeeded") =>
  (d as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail(r, exit);
const tail = (t: T, r: AgentRecord, exit = "succeeded") => tailOn(t.daemon, r, exit);
const running = async (t: T, key: string, parent?: string): Promise<AgentRecord> => {
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
};
const exitWith = async (t: T, a: AgentRecord, exit: "succeeded" | "failed" | "cancelled", result?: unknown) =>
  t.daemon.deps.registry.transition(a.id, a.generation, "exited", {
    exit,
    ...(result !== undefined && { result }),
    idempotencyKey: `${a.id}-exit-${a.generation}`,
  });
const state = async (t: T, a: AgentRecord) => (await t.daemon.get(a.id))!.state;
const exitedSignals = async (t: T, to: AgentRecord, child: AgentRecord) =>
  (await t.daemon.deps.mailbox.peek(to.id)).filter((s) => s.kind === "child_exited" && s.child === child.id) as Array<Signal & { handoff?: string }>;
const journaledSignals = async (t: T, on: AgentRecord, child: AgentRecord) =>
  (await t.journal.read({ agent: on.id })).filter(
    (e) => e.payload.kind === "signal" && (e.payload.signal as Signal).kind === "child_exited" && (e.payload.signal as { child: string }).child === child.id,
  );
const custodyMarks = async (t: T, z: AgentRecord) =>
  (await t.journal.read({ agent: z.id })).map((e) => e.payload as { kind: string; op?: string; delivered?: string }).filter((p) => p.op === "custody");

// root -> A -> B -> C, all running.
const chain = async (t: T) => {
  const a = await running(t, "A");
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id);
  return { a, b, c };
};
// T1's end state: C exited (handoff "leaf poem") and tailed while B was live; then B exited cancelled and tailed. A stays live.
const dead = async (t: T) => {
  const { a, b, c } = await chain(t);
  const c1 = await exitWith(t, c, "succeeded", { summary: "leaf poem" });
  await tail(t, c1);
  const b1 = await exitWith(t, b, "cancelled");
  await tail(t, b1, "cancelled");
  return { a, b: b1, c: c1 };
};

test("a dead middle parent: its exited child is held for the nearest live ancestor, not reaped, notified once", async () => {
  const t = setup(async () => {}, withChannel);
  const { a, b, c } = await dead(t);
  assert.equal(await state(t, c), "exited");
  assert.equal(((await t.daemon.get(c.id))!.result as { summary: string }).summary, "leaf poem");
  const sigs = await exitedSignals(t, a, c);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.handoff, "leaf poem");
  assert.equal((await journaledSignals(t, a, c)).length, 1);
  assert.equal(await state(t, b), "exited", "B is A's zombie, as before");
  for (let i = 0; i < 2; i++) {
    await tail(t, b, "cancelled");
    await tail(t, c);
  }
  assert.equal((await exitedSignals(t, a, c)).length, 1, "replays deliver nothing more");
  assert.equal((await journaledSignals(t, a, c)).length, 1);
  assert.equal(await state(t, c), "exited");
});

test("a child that exits after its parent died is held for the live ancestor, not reaped", async () => {
  const t = setup(async () => {}, withChannel);
  const { a, b, c } = await chain(t);
  await exitWith(t, b, "failed");
  const c1 = await exitWith(t, c, "succeeded", { summary: "late" });
  await tail(t, c1);
  assert.equal(await state(t, c1), "exited");
  assert.equal((await exitedSignals(t, a, c1)).length, 1);
  await tail(t, c1);
  assert.equal((await exitedSignals(t, a, c1)).length, 1);
});

test("the custodian dies too: custody cascades to the root, which relays to the user once; only the root child is reaped", async () => {
  const t = setup(async () => {}, withChannel);
  const { a, b, c } = await dead(t);
  const a1 = await exitWith(t, a, "succeeded", { summary: "top" });
  await tail(t, a1);
  assert.equal(await state(t, a1), "reaped", "a root child is still reaped at exit");
  assert.equal(await state(t, b), "exited");
  assert.equal(await state(t, c), "exited");
  const status = await sent(t, "status");
  const held = status.filter((s) => s.includes(c.id) && s.includes("leaf poem"));
  assert.equal(held.length, 1);
  assert.match(held[0]!, /held for the operator: parent \S+ is gone/, "the line says why the user got it");
  assert.ok(held[0]!.includes(`pomtree reap ${c.id}`), "and what to do");
  assert.equal(status.filter((s) => s.startsWith(`${b.id} `)).length, 1);
  const before = (await sent(t, "status")).length;
  for (const r of [a1, b, c]) await tail(t, r, r.exit ?? "succeeded");
  assert.equal((await sent(t, "status")).length, before, "replays add no duplicate relay");
});

test("the root custody queue is bounded: past rootCustodyMax each further delivery is also escalated as an alert, once", async () => {
  const t = setup(async () => {}, { ...withChannel, limits: { rootCustodyMax: 1 } });
  const root = (await t.daemon.root()).id;
  const orphan = async (n: string) => {
    const p = await running(t, `P${n}`);
    const k = await running(t, `K${n}`, p.id);
    await exitWith(t, p, "failed");
    const k1 = await exitWith(t, k, "succeeded", { summary: `res ${n}` });
    await tail(t, k1);
    return k1;
  };
  assert.ok(root);
  const k1 = await orphan("1");
  assert.deepEqual(await sent(t, "alert"), [], "the first result fits the queue");
  const k2 = await orphan("2");
  const alerts = await sent(t, "alert");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /custody queue full/);
  assert.ok(alerts[0]!.includes(k2.id));
  assert.match(alerts[0]!, new RegExp(`pomtree reap ${k2.id}`));
  await tail(t, k2);
  await tail(t, k1);
  assert.equal((await sent(t, "alert")).length, 1, "replay adds no second alert");
  assert.equal(await state(t, k1), "exited");
  assert.equal(await state(t, k2), "exited");
});

test("no escalation channel: a root-custody zombie still stays exited, with the custody marker journaled on it", async () => {
  const t = setup(async () => {});
  const p = await running(t, "P");
  const k = await running(t, "K", p.id);
  await exitWith(t, p, "failed");
  const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
  await tail(t, k1);
  assert.equal(await state(t, k1), "exited", "never silently reaped");
  const marks = await custodyMarks(t, k1);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.delivered, (await t.daemon.root()).id);
});

test("a throwing wake of the custodian still delivers the signal, journals the failure on the custodian and does not abort the tail", async () => {
  const t = setup(async () => {}, withChannel);
  const orch = Object.create(t.daemon.deps.orchestrator) as typeof t.daemon.deps.orchestrator;
  orch.wake = async () => {
    throw new Error("wake 409");
  };
  const d = new Daemon({ ...t.daemon.deps, orchestrator: orch });
  const { a, b, c } = await chain(t);
  const c1 = await exitWith(t, c, "succeeded", { summary: "leaf poem" });
  await tailOn(d, c1);
  const b1 = await exitWith(t, b, "cancelled");
  await tailOn(d, b1, "cancelled");
  assert.equal(await state(t, c1), "exited");
  assert.equal((await exitedSignals(t, a, c1)).length, 1);
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  assert.ok(
    errs.some((m) => m.includes(`wake of ${a.id} failed`) && m.includes(c1.id) && m.includes("wake 409")),
    `custody wake failure journaled on the custodian, got ${JSON.stringify(errs)}`,
  );
});

test("a reconcile pass leaves a held result exited, names the custodian in the marker, and is idempotent", async () => {
  const t = setup(async () => {});
  const { a, b, c } = await dead(t);
  const y = await t.daemon.deps.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: "A-y" }); // live, quiescent custodian
  for (let i = 0; i < 2; i++) {
    await t.daemon.reconcile();
    assert.equal(await state(t, c), "exited", `pass ${i + 1}`);
    assert.equal(await state(t, b), "exited");
    assert.equal(await state(t, y), "yielded");
    assert.equal((await exitedSignals(t, y, c)).length, 1);
    const marks = await custodyMarks(t, c);
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.delivered, a.id);
  }
});

test("an exited grandchild under a reaped node is not walked by the parent's exit, but one reconcile pass moves its custody to the root, once", async () => {
  const t = setup(async () => {}, withChannel);
  const { a, b, c } = await dead(t);
  await t.daemon.reap(b.id);
  assert.equal(await state(t, b), "reaped");
  const a1 = await exitWith(t, a, "succeeded", { summary: "top" });
  await tail(t, a1);
  assert.equal(await state(t, c), "exited", "never reaped");
  const rootId = (await t.daemon.root()).id;
  assert.equal((await custodyMarks(t, c)).filter((m) => m.delivered === rootId).length, 0, "the exit did not walk the reaped node");
  for (let i = 0; i < 2; i++) await t.daemon.reconcile();
  assert.equal(await state(t, c), "exited");
  const marks = (await custodyMarks(t, c)).filter((m) => m.delivered === rootId);
  assert.equal(marks.length, 1);
  assert.equal((await sent(t, "status")).filter((s) => s.includes(c.id) && s.includes("held for the operator")).length, 1);
});

test("negative control: a child exiting under a live parent gets no custody marker and only the normal child_exited", async () => {
  const t = setup(async () => {}, withChannel);
  const p = await running(t, "P");
  const k = await exitWith(t, await running(t, "K", p.id), "succeeded", { summary: "ok" });
  await tail(t, k);
  await tail(t, k);
  assert.deepEqual(await custodyMarks(t, k), []);
  assert.equal((await exitedSignals(t, p, k)).length, 1);
  assert.equal((await journaledSignals(t, p, k)).length, 1);
});

test("a missing parent record falls back to the root as custodian", async () => {
  const t = setup(async () => {}, withChannel);
  const { b, c } = await chain(t);
  const reg = t.daemon.deps.registry;
  const wrapped = Object.create(reg) as typeof reg;
  wrapped.get = async (id) => (id === b.id ? null : reg.get(id));
  const d = new Daemon({ ...t.daemon.deps, registry: wrapped });
  const c1 = await exitWith(t, c, "succeeded", { summary: "orphaned" });
  await tailOn(d, c1);
  assert.equal(await state(t, c1), "exited");
  const marks = await custodyMarks(t, c1);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.delivered, (await t.daemon.root()).id);
  assert.equal((await sent(t, "status")).filter((s) => s.includes(c1.id) && s.includes("held for the operator")).length, 1);
});

test("sweepZombies names the custodian for a dead-parent zombie and keeps the live-parent wording", async () => {
  const t = setup(async () => {}, { ...withChannel, limits: { zombieMs: 0 } });
  const { a, b, c } = await dead(t);
  await t.daemon.sweepZombies();
  const errs = async (r: AgentRecord) =>
    (await t.journal.read({ agent: r.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  const [cm] = (await errs(c)).filter((m) => m.startsWith("zombie:"));
  assert.ok(cm!.includes(`held for ${a.id}`) && cm!.includes(`parent ${b.id} is gone`), cm);
  const [bm] = (await errs(b)).filter((m) => m.startsWith("zombie:"));
  assert.match(bm!, new RegExp(`^zombie: exited cancelled and unreaped by parent ${a.id} for \\d+s$`));
  const alerts = await sent(t, "alert");
  assert.ok(alerts.some((m) => m.includes(`held for ${a.id}`)));
});

test("a resumed zombie that exits again (new generation) is delivered to the custodian again", async () => {
  const t = setup(async () => {}, withChannel);
  const { a, c } = await dead(t);
  const reg = t.daemon.deps.registry;
  const bumped = await reg.bumpGeneration(c.id, "h1", "c-g1");
  await reg.transition(c.id, bumped.generation, "running", { resume: true, idempotencyKey: "c-resume" });
  const c2 = await reg.transition(c.id, bumped.generation, "exited", { exit: "succeeded", result: { summary: "second poem" }, idempotencyKey: "c-exit-2" });
  await tail(t, c2);
  await tail(t, c2);
  const sigs = await exitedSignals(t, a, c);
  assert.equal(sigs.length, 2);
  assert.ok(sigs.some((x) => x.handoff === "second poem"));
  assert.equal((await custodyMarks(t, c2)).length, 2);
});

test("regression guard: a direct root child is still reaped at exit", async () => {
  const t = setup(async () => {}, withChannel);
  const r = await exitWith(t, await running(t, "R"), "succeeded", { summary: "ok" });
  await tail(t, r);
  assert.equal(await state(t, r), "reaped");
});

// A custody hand-up wakes a yielded custodian (satisfied() in @pomtree/sched), except through an all-mode child_exited
// join, an ask park or a budget park. The custodian A is yielded with a real checkpoint before B (the middle) dies.
const wakeOf = (wakes: string[]) => async (c: { wake?: string; api: (m: string, u: string, b?: unknown) => Promise<unknown> }) => {
  if (c.wake === undefined) return;
  wakes.push(c.wake);
  await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
};
const yieldedChain = async (t: T, yieldWith: (a: AgentRecord) => Promise<unknown>) => {
  const { a, b, c } = await chain(t);
  const c1 = await exitWith(t, c, "succeeded", { summary: "leaf poem" });
  await tail(t, c1);
  await yieldWith(a);
  assert.equal(await state(t, a), "yielded");
  const b1 = await exitWith(t, b, "cancelled");
  await tail(t, b1, "cancelled");
  await t.orchestrator.idle();
  return { a, b: b1, c: c1 };
};
// Park the running custodian `a` as `yield` would, without a live sandbox: a checkpoint with the wait, the optional
// yield-context journal row, then the yielded transition.
const yieldOn = (t: T, wait: WaitCondition | null, ctx?: WaitCtx) => async (a: AgentRecord) => {
  const cp = await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait,
      remainingBudgetMicros: 500,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    `cp-${a.id}`,
  );
  if (ctx)
    await t.journal.append({
      agent: a.id,
      host: "h1",
      generation: a.generation,
      payload: { kind: YIELD_CTX_KIND, checkpoint: cp.id, ctx } as never,
      idempotencyKey: `ctx-${a.id}`,
    });
  await t.daemon.deps.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: `${a.id}-yielded` });
};

test("a custodian yielded on a message resumes exactly once when a dead middle's leaf is handed up; a second reconcile pass changes nothing", async () => {
  const wakes: string[] = [];
  const t = setup(wakeOf(wakes));
  const { a, c } = await yieldedChain(t, yieldOn(t, { kind: "message" }));
  const after = (await t.daemon.get(a.id))!;
  assert.equal(after.generation, a.generation + 1, "resumed once");
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0]!.includes(c.id) && /held for you/.test(wakes[0]!), wakes[0]);
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(a.id))!.generation, after.generation, "the replay resumes nothing more");
  assert.equal(wakes.length, 1);
});

test("an ask-parked custodian stays yielded when a dead middle's leaf is handed up", async () => {
  const wakes: string[] = [];
  const t = setup(wakeOf(wakes));
  const at = Date.now() + 60_000;
  const { a } = await yieldedChain(
    t,
    yieldOn(t, { kind: "any", of: [{ kind: "message" }, { kind: "timer", at }] }, { kind: "ask", escalation: "e1", timeoutMs: 60_000, at }),
  );
  assert.equal(await state(t, a), "yielded");
  assert.equal((await t.daemon.get(a.id))!.generation, a.generation);
  assert.equal(wakes.length, 0);
});

test("a budget-parked custodian stays yielded when a dead middle's leaf is handed up, with no budget_pending error", async () => {
  const wakes: string[] = [];
  const t = setup(wakeOf(wakes));
  t.daemon.deps.approvals = t.fakes.approvals;
  const priv = t.daemon as unknown as { openApproval(r: AgentRecord, kind: string, target: string, key: string): Promise<unknown> };
  const { a } = await yieldedChain(t, async (a0) => {
    await priv.openApproval(a0, "budget_raise", budgetRaiseTarget(a0.id, a0.generation, 500), "budget:0");
    await yieldOn(t, null)(a0);
  });
  assert.equal(await state(t, a), "yielded");
  assert.equal((await t.daemon.get(a.id))!.generation, a.generation);
  assert.equal(wakes.length, 0);
  const errs = (await t.journal.read({ agent: a.id })).map((e) => e.payload as { kind: string; message?: string; code?: string });
  assert.ok(!errs.some((p) => p.kind === "error" && /budget_pending|parked on a budget/.test(`${p.message ?? ""}${p.code ?? ""}`)), JSON.stringify(errs));
});

test("a custodian on an all-mode child_exited join with a child still running stays yielded on a hand-up", async () => {
  const wakes: string[] = [];
  const t = setup(wakeOf(wakes));
  const other = await running(t, "other");
  const { a } = await yieldedChain(t, yieldOn(t, { kind: "child_exited", children: [other.id], mode: "all" }));
  assert.equal(await state(t, a), "yielded");
  assert.equal((await t.daemon.get(a.id))!.generation, a.generation);
  assert.equal(wakes.length, 0);
});

test("the wake text for a custody hand-up is the custody line for every resume context, not a timeout or an exit of the awaited child", async () => {
  const t = setup(async () => {});
  const { a, c } = await dead(t);
  const handUp: Signal = { kind: "child_exited", child: c.id, exit: "succeeded", custodyOf: "B-gone" };
  const text = (ctx: WaitCtx | null, signal: Signal) =>
    (
      (t.daemon as unknown as { lifecycle: object }).lifecycle as unknown as { resumeText(a: string, c: WaitCtx | null, s: Signal): Promise<string> }
    ).resumeText(a.id, ctx, signal);
  const at = Date.now() + 1000;
  const ctxs: WaitCtx[] = [
    { kind: "inbox", timeoutMs: 30_000, at },
    { kind: "child", child: "other", timeoutMs: 30_000, at },
    { kind: "ask", escalation: "e1", timeoutMs: 30_000, at },
  ];
  for (const ctx of [null, ...ctxs]) {
    const s = await text(ctx, handUp);
    assert.match(s, new RegExp(`${c.id} exited under B-gone, which is gone, and is now held for you`), s);
    assert.ok(s.includes(`pomtree wait ${c.id}`) && s.includes(`pomtree reap ${c.id}`), s);
    assert.doesNotMatch(s, /timed out|still /, s);
  }
  // negative control: the same child context without custodyOf keeps the timeout wording
  assert.match(await text(ctxs[1]!, { kind: "timeout" }), /wait for child other timed out after 30 s/);
});
