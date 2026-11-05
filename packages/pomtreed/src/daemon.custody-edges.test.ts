// Edge cases of custody (TODO(guardian-reap)): a failing hold must not leave live children running, every wake failure is journaled,
// a resumed parent is told of the children held while it was dead, a root hold with no channel is visible, and the walk is bounded.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { Daemon } from "./daemon.ts";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const withChannel = { escalationChannels: ["discord"] };
const tailOn = async (d: Daemon, r: AgentRecord, exit = "succeeded") =>
  (d as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail(r, exit);
const tail = (t: T, r: AgentRecord, exit = "succeeded") => tailOn(t.daemon, r, exit);
const running = async (t: T, key: string, parent?: string, budgetMicros = 1_000): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: parent ?? (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros,
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
  (await t.daemon.deps.mailbox.peek(to.id)).filter((s) => s.kind === "child_exited" && s.child === child.id);
const custodyMarks = async (t: T, z: AgentRecord) =>
  (await t.journal.read({ agent: z.id })).map((e) => e.payload as { kind: string; op?: string; delivered?: string }).filter((p) => p.op === "custody");
const errors = async (t: T, r: AgentRecord) =>
  (await t.journal.read({ agent: r.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
const wrapOrchestrator = (t: T, over: Partial<{ wake: unknown; cancel: unknown; resume: unknown }>) => {
  const orch = Object.create(t.daemon.deps.orchestrator) as typeof t.daemon.deps.orchestrator;
  Object.assign(orch, over);
  return orch;
};
const chain = async (t: T) => {
  const a = await running(t, "A");
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id);
  return { a, b, c };
};

test("a custodian whose mailbox rejects the hold does not stop the parent's live children being cancelled; the error is journaled and a retry delivers once", async () => {
  const t = setup(async () => {}, withChannel);
  const { a, b, c } = await chain(t);
  const dChild = await running(t, "D", b.id);
  const cancels: string[] = [];
  const orch = wrapOrchestrator(t, {
    cancel: async (id: string) => {
      cancels.push(id);
    },
  });
  let failures = 1;
  const mailbox = Object.create(t.daemon.deps.mailbox) as typeof t.daemon.deps.mailbox;
  mailbox.send = async (to, signal: Signal, key, gen) => {
    if (to === a.id && signal.kind === "child_exited" && signal.child === c.id && failures-- > 0) throw new Error("mailbox down");
    return t.daemon.deps.mailbox.send(to, signal, key, gen);
  };
  const d = new Daemon({ ...t.daemon.deps, mailbox, orchestrator: orch });
  const c1 = await exitWith(t, c, "succeeded", { summary: "leaf" });
  await tailOn(d, c1);
  const b1 = await exitWith(t, b, "cancelled");
  await tailOn(d, b1, "cancelled");
  assert.deepEqual(cancels, [dChild.id], "the live child is still cancelled although holding its exited sibling failed");
  const errs = await errors(t, b1);
  assert.ok(
    errs.some((m) => m.includes(c.id) && m.includes("mailbox down") && /next reconcile pass/.test(m)),
    `custody failure journaled on the dying parent, got ${JSON.stringify(errs)}`,
  );
  assert.equal((await exitedSignals(t, a, c1)).length, 0);
  assert.equal((await custodyMarks(t, c1)).length, 0, "no marker before a delivery");
  // The retry (the reconcile pass reruns finishTail for every exited agent) delivers exactly once.
  for (let i = 0; i < 2; i++) await tailOn(d, c1);
  assert.equal((await exitedSignals(t, a, c1)).length, 1);
  assert.equal((await custodyMarks(t, c1)).filter((m) => m.delivered === a.id).length, 1);
});

test("negative control: one throwing hold does not stop the walk reaching the other exited children", async () => {
  const t = setup(async () => {}, withChannel);
  const a = await running(t, "A");
  const b = await running(t, "B", a.id);
  const c1 = await running(t, "C1", b.id);
  const c2 = await running(t, "C2", b.id);
  await tail(t, await exitWith(t, c1, "succeeded"));
  await tail(t, await exitWith(t, c2, "succeeded"));
  const mailbox = Object.create(t.daemon.deps.mailbox) as typeof t.daemon.deps.mailbox;
  mailbox.send = async (to, signal: Signal, key, gen) => {
    if (to === a.id && signal.kind === "child_exited" && signal.child === c1.id) throw new Error("mailbox down");
    return t.daemon.deps.mailbox.send(to, signal, key, gen);
  };
  const d = new Daemon({ ...t.daemon.deps, mailbox });
  await tailOn(d, await exitWith(t, b, "cancelled"), "cancelled");
  assert.equal((await exitedSignals(t, a, c2)).length, 1, "C2 was held although C1 failed");
  assert.equal((await exitedSignals(t, a, c1)).length, 0);
});

test("custody wake failures are journaled per generation and per custodian: a new custodian is journaled too", async () => {
  const t = setup(async () => {}, withChannel);
  const wake = async () => {
    throw new Error("wake 409");
  };
  const d = new Daemon({ ...t.daemon.deps, orchestrator: wrapOrchestrator(t, { wake }) });
  const top = await running(t, "T");
  const a = await running(t, "A", top.id);
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id);
  const c1 = await exitWith(t, c, "succeeded", { summary: "leaf" });
  await tailOn(d, c1);
  await tailOn(d, await exitWith(t, b, "failed"), "failed"); // custody of C: A
  await tailOn(d, await exitWith(t, a, "failed"), "failed"); // A dies: custody of C moves to T
  const custodyWake = (errs: string[]) => errs.filter((m) => m.includes(`custody of ${c.id}`) && m.includes("wake 409"));
  assert.equal(custodyWake(await errors(t, a)).length, 1, "the first custodian's failed wake");
  assert.equal(custodyWake(await errors(t, top)).length, 1, "the second custodian's failed wake");
  assert.equal((await exitedSignals(t, top, c1)).length, 1);
});

test("a parent resumed after its child was held for an ancestor has exactly one child_exited for it; replays add none and custody is B's again", async () => {
  const t = setup(async () => {});
  t.daemon.deps.repos = t.fakes.repos;
  const { a, b, c } = await chain(t);
  await t.daemon.deps.workspace.create(b.id, {});
  const resumes: string[] = [];
  (t.orchestrator as unknown as { resume: (a: string) => Promise<void> }).resume = async (agent) => void resumes.push(agent);
  await exitWith(t, b, "failed");
  const c1 = await exitWith(t, c, "succeeded", { summary: "late" });
  await tail(t, c1);
  assert.equal(await t.daemon.custodianOf(c.id), a.id);
  assert.equal((await exitedSignals(t, a, c1)).length, 1);
  const resumed = await t.daemon.resumeChild(a.id, a.generation, b.id);
  assert.equal(resumed.state, "running");
  assert.deepEqual(resumes, [b.id]);
  assert.equal((await exitedSignals(t, resumed, c1)).length, 1, "B is told once");
  assert.equal(await t.daemon.custodianOf(c.id), b.id, "custody returned to the live parent");
  await t.daemon.resumeChild(a.id, a.generation, b.id).catch(() => {});
  await tail(t, c1);
  assert.equal((await exitedSignals(t, resumed, c1)).length, 1, "a replay adds none");
  assert.equal(
    (await t.journal.read({ agent: b.id })).filter((e) => e.payload.kind === "signal" && (e.payload.signal as { child?: string }).child === c.id).length,
    1,
  );
});

test("a root hold with no user channel journals a visible error once; with a channel there is none", async () => {
  const orphan = async (t: T) => {
    const p = await running(t, "P");
    const k = await running(t, "K", p.id);
    await exitWith(t, p, "failed");
    const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
    for (let i = 0; i < 2; i++) await tail(t, k1);
    return k1;
  };
  const bare = setup(async () => {});
  const k = await orphan(bare);
  const mine = (await errors(bare, k)).filter((m) => m.startsWith("custody: held for the operator, but no user channel"));
  assert.equal(mine.length, 1);
  assert.ok(mine[0]!.includes(`pomtree show ${k.id}`) && mine[0]!.includes(`pomtree reap ${k.id}`), mine[0]);
  const wired = setup(async () => {}, withChannel);
  const k2 = await orphan(wired);
  assert.deepEqual(
    (await errors(wired, k2)).filter((m) => m.includes("no user channel")),
    [],
  );
});

test("a parent cycle in the registry ends at the root (the seen guard)", async () => {
  const t = setup(async () => {});
  const { b, c } = await chain(t);
  const reg = t.daemon.deps.registry;
  const wrapped = Object.create(reg) as typeof reg;
  wrapped.get = async (id) => {
    const r = await reg.get(id);
    if (r && id === b.id) return { ...r, parent: c.id, state: "exited" } as AgentRecord;
    return r;
  };
  const d = new Daemon({ ...t.daemon.deps, registry: wrapped });
  const cur = (await reg.get(c.id))!;
  const root = await t.daemon.root();
  const got = await (d as unknown as { tree: { custodian: (a: AgentRecord) => Promise<AgentRecord> } }).tree.custodian(cur);
  assert.equal(got.id, root.id);
});

test("maxChildren counts only a custodian's own unreaped children, not the zombies it holds", async () => {
  const t = setup(async () => {}, { limits: { maxChildren: 1 } });
  const a = await running(t, "A", undefined, 100_000);
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id);
  await tail(t, await exitWith(t, c, "succeeded", { summary: "leaf" }));
  await tail(t, await exitWith(t, b, "cancelled"), "cancelled");
  assert.equal(await t.daemon.custodianOf(c.id), a.id, "A holds C");
  await t.daemon.reap(b.id);
  const child = await t.daemon.spawn(a.id, { name: "n", task: "go", idempotencyKey: "n1", budgetMicros: 100 });
  assert.equal(child.parent, a.id);
  await assert.rejects(t.daemon.spawn(a.id, { name: "m", task: "go", idempotencyKey: "m1", budgetMicros: 100 }), /unreaped children/);
});
