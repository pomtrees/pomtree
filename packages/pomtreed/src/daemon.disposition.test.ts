// Parent-declared result disposition (HANDOFF "Advisory results"; precedents POSIX SA_NOCLDWAIT, Kubernetes ttlSecondsAfterFinished):
// reap-on-exit children are reaped by the daemon once the parent has the exit signal, a hold may expire after ttlMs, root children are
// always reaped at exit, and the declaration resolves spawn request > template > absent.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalEntry, ResultDisposition, Signal, Template } from "@pomtree/core";
import { Daemon } from "./daemon.ts";
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
const running = async (t: T, key: string, parent?: string, disposition?: ResultDisposition): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: { ...spawnSpec, ...(disposition && { disposition }) },
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
  (await t.daemon.deps.mailbox.peek(to.id)).filter((s) => s.kind === "child_exited" && s.child === child.id) as Array<
    Extract<Signal, { kind: "child_exited" }>
  >;
const messages = async (t: T, to: AgentRecord) => (await t.daemon.deps.mailbox.peek(to.id)).filter((s) => s.kind === "message") as Array<{ body: string }>;
const reapOnExit: ResultDisposition = { mode: "reap-on-exit" };

test("reap-on-exit under a live non-root parent: the parent gets child_exited, the child is reaped at exit, its record and result stay readable", async () => {
  const t = setup(async () => {});
  const a = await running(t, "A");
  const k = await running(t, "K", a.id, reapOnExit);
  const k1 = await exitWith(t, k, "succeeded", { summary: "advisory" });
  await tail(t, k1);
  const sigs = await exitedSignals(t, a, k1);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.handoff, "advisory");
  assert.equal(sigs[0]!.custodyOf, undefined, "a normal parent notification never sets custodyOf");
  const rec = (await t.daemon.get(k.id))!;
  assert.equal(rec.state, "reaped");
  assert.equal((rec.result as { summary: string }).summary, "advisory");
  await tail(t, k1); // replay is harmless
  assert.equal((await exitedSignals(t, a, k1)).length, 1);
});

test("hold (absent or explicit) under a live parent is unchanged: the child stays exited", async () => {
  const t = setup(async () => {});
  const a = await running(t, "A");
  const k = await exitWith(t, await running(t, "K", a.id), "succeeded", { summary: "x" });
  const h = await exitWith(t, await running(t, "H", a.id, { mode: "hold" }), "succeeded", { summary: "x" });
  await tail(t, k);
  await tail(t, h);
  assert.equal(await state(t, k), "exited");
  assert.equal(await state(t, h), "exited");
});

test("root children are reaped at exit whatever they declare", async () => {
  const t = setup(async () => {});
  const k = await exitWith(t, await running(t, "K", undefined, { mode: "hold", ttlMs: 60_000 }), "succeeded", { summary: "x" });
  await tail(t, k);
  assert.equal(await state(t, k), "reaped");
});

test("reap-on-exit under a dead parent: the custodian gets child_exited with custodyOf, then the child is reaped", async () => {
  const t = setup(async () => {});
  const a = await running(t, "A");
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id, reapOnExit);
  const c1 = await exitWith(t, c, "succeeded", { summary: "leaf" });
  const b1 = await exitWith(t, b, "cancelled");
  await tail(t, b1, "cancelled");
  await tail(t, c1);
  const sigs = await exitedSignals(t, a, c1);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.custodyOf, b.id);
  assert.equal(sigs[0]!.handoff, "leaf");
  assert.equal(await state(t, c1), "reaped");
  assert.equal(((await t.daemon.get(c.id))!.result as { summary: string }).summary, "leaf");
  await tail(t, c1);
  assert.equal((await exitedSignals(t, a, c1)).length, 1, "replay delivers nothing more");
});

test("reap-on-exit under a dead parent whose custodian is the root: the status line says reaped on exit, and it never counts toward rootCustodyMax", async () => {
  const t = setup(async () => {}, { ...withChannel, limits: { rootCustodyMax: 1 } });
  const orphan = async (n: string) => {
    const p = await running(t, `P${n}`);
    const k = await running(t, `K${n}`, p.id, reapOnExit);
    await exitWith(t, p, "failed");
    const k1 = await exitWith(t, k, "succeeded", { summary: `res ${n}` });
    await tail(t, k1);
    return k1;
  };
  const k1 = await orphan("1");
  const k2 = await orphan("2");
  const status = await sent(t, "status");
  const line = status.find((s) => s.includes(k1.id) && s.includes("res 1"))!;
  assert.match(line, /reaped on exit \(disposition reap-on-exit\): parent \S+ is gone/);
  assert.ok(line.includes(`pomtree show ${k1.id}`));
  assert.ok(!line.includes("held for the operator"));
  assert.equal(await state(t, k1), "reaped");
  assert.equal(await state(t, k2), "reaped");
  assert.deepEqual(await sent(t, "alert"), [], "two advisory orphans raise no custody alert at rootCustodyMax 1");
  await tail(t, k1);
  assert.equal((await sent(t, "status")).length, status.length, "replay sends nothing new");
});

test("custodyOf is set on a hold custody delivery and absent on the normal parent delivery", async () => {
  const t = setup(async () => {});
  const a = await running(t, "A");
  const b = await running(t, "B", a.id);
  const c = await running(t, "C", b.id);
  const d = await running(t, "D", a.id);
  const c1 = await exitWith(t, c, "succeeded", { summary: "c" });
  const d1 = await exitWith(t, d, "succeeded", { summary: "d" });
  await tail(t, d1);
  const b1 = await exitWith(t, b, "cancelled");
  await tail(t, b1, "cancelled");
  await tail(t, c1);
  assert.equal((await exitedSignals(t, a, c1))[0]!.custodyOf, b.id);
  assert.equal((await exitedSignals(t, a, d1))[0]!.custodyOf, undefined);
  assert.equal(await state(t, c1), "exited", "hold: still held");
});

const ttlSetup = (extra = {}) => {
  const clock = { t: 1_000_000 };
  const t = setup(async () => {}, { now: () => clock.t, ...extra });
  return { t, clock };
};
const sweepTtl = (t: T) => (t.daemon as unknown as { sweepHoldTtl: () => Promise<string[]> }).sweepHoldTtl();

test("TTL: a hold with ttlMs under a live parent is untouched before the TTL; after it the parent is told once, then the child is reaped", async () => {
  const { t, clock } = ttlSetup();
  const a = await running(t, "A");
  const k = await running(t, "K", a.id, { mode: "hold", ttlMs: 5_000 });
  const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
  await tail(t, k1);
  clock.t += 4_999;
  assert.deepEqual(await sweepTtl(t), []);
  assert.equal(await state(t, k1), "exited");
  assert.equal((await messages(t, a)).length, 0);
  clock.t += 1;
  assert.deepEqual(await sweepTtl(t), [k.id]);
  assert.equal(await state(t, k1), "reaped");
  const msgs = await messages(t, a);
  assert.equal(msgs.length, 1);
  assert.equal(
    msgs[0]!.body,
    `${k.id} was reaped: its hold expired after 5000ms (disposition hold, ttlMs); its record and result stay readable with \`pomtree show ${k.id}\`; branch agent/${k.id} keeps any pushed work (\`pomtree pull --from ${k.id}\`)`,
  );
  assert.deepEqual(await sweepTtl(t), [], "a replay finds nothing to do");
  assert.equal((await messages(t, a)).length, 1);
});

test("TTL: a root custodian is told with one status line; sweepZombies still never reaps; a hold without ttlMs is never expired", async () => {
  const { t, clock } = ttlSetup({ ...withChannel, limits: { zombieMs: 0 } });
  const p = await running(t, "P");
  const k = await running(t, "K", p.id, { mode: "hold", ttlMs: 1_000 });
  const plain = await running(t, "Plain", p.id);
  await exitWith(t, p, "failed");
  const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
  const p1 = await exitWith(t, plain, "succeeded", { summary: "y" });
  await tail(t, k1);
  await tail(t, p1);
  clock.t += 10_000;
  await t.daemon.sweepZombies();
  assert.equal(await state(t, k1), "exited", "the zombie sweep is alert-only");
  assert.deepEqual(await sweepTtl(t), [k.id]);
  assert.equal(await state(t, k1), "reaped");
  assert.equal(await state(t, p1), "exited");
  await sweepTtl(t);
  const lines = (await sent(t, "status")).filter((s) => s.includes("hold expired"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.startsWith(`${k.id} was reaped: its hold expired after 1000ms`));
});

test("resolution: the spawn request beats the template, which beats absent; the spec persists the result", async () => {
  const t = setup(async () => {});
  const stored: Template = { id: "adv", disposition: { mode: "hold", ttlMs: 9_000 } };
  t.fakes.hooks.raw.templates.templates.set("adv", stored);
  // Templates are operator-only, so these go through the operator API (the body parser is exercised too).
  const spec = async (key: string, req: object) => {
    const r = await t.spawn(key, req);
    const rec = (await t.daemon.deps.registry.get(r.id))!;
    return rec.executor === "container" ? rec.spec.disposition : "deterministic";
  };
  assert.equal(await spec("k0", {}), undefined);
  assert.deepEqual(await spec("k1", { template: "adv" }), { mode: "hold", ttlMs: 9_000 });
  assert.deepEqual(await spec("k2", { template: "adv", disposition: reapOnExit }), reapOnExit);
  assert.deepEqual(await spec("k3", { disposition: { mode: "hold", ttlMs: 1_000 } }), { mode: "hold", ttlMs: 1_000 });
});

test("spawn validation: reap-on-exit with ttlMs and an unknown mode are refused with a 400 naming the field", async () => {
  const t = setup(async () => {});
  const a = await running(t, "A");
  const spawn = (key: string, disposition: unknown) =>
    t.daemon.spawn(a.id, { name: "w", task: "t", idempotencyKey: key, disposition: disposition as ResultDisposition });
  await assert.rejects(
    spawn("v1", { mode: "reap-on-exit", ttlMs: 1000 }),
    (e: { status?: number; message: string }) => e.status === 400 && /ttlMs applies only to mode hold/.test(e.message),
  );
  await assert.rejects(
    spawn("v2", { mode: "keep" }),
    (e: { status?: number; message: string }) => e.status === 400 && /disposition\.mode must be "hold" or "reap-on-exit"/.test(e.message),
  );
  await assert.rejects(
    spawn("v3", { mode: "hold", ttlMs: 0 }),
    (e: { status?: number; message: string }) => e.status === 400 && /ttlMs must be a positive safe integer/.test(e.message),
  );
  assert.ok(await spawn("v4", { mode: "hold", ttlMs: 1000 }), "a valid declaration is accepted");
});

test("a template built in code with an invalid disposition refuses the spawn with a 422 template_error naming the template", async () => {
  const t = setup(async () => {});
  t.fakes.hooks.raw.templates.templates.set("bogus", { id: "bogus", disposition: { mode: "bogus" } as unknown as ResultDisposition });
  const r = await t.operator("POST", "/v1/agents", { name: "w", task: "t", idempotencyKey: "b1", template: "bogus" });
  assert.equal(r.status, 422);
  assert.match(JSON.stringify(r.body), /template_error/);
  assert.match(JSON.stringify(r.body), /template bogus: disposition\.mode must be/);
});

test("TTL: the clock runs from the exit, so a later updated_at bump (a restart's sandbox reclaim) does not restart it", async () => {
  const { t, clock } = ttlSetup();
  const a = await running(t, "A");
  const k = await running(t, "K", a.id, { mode: "hold", ttlMs: 5_000 });
  const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
  await tail(t, k1);
  clock.t += 4_000;
  await t.daemon.deps.registry.setSandbox(k.id, k1.generation, null, "reclaim-1");
  assert.ok((await t.daemon.get(k.id))!.updatedAt >= k1.updatedAt + 4_000, "updatedAt moved after the exit");
  clock.t += 1_000;
  assert.deepEqual(await sweepTtl(t), [k.id], "5000ms after the exit, not after the bump");
  assert.equal(await state(t, k1), "reaped");
});

test("TTL: negative control, an updated_at bump alone does not reap before the exit-based TTL", async () => {
  const { t, clock } = ttlSetup();
  const a = await running(t, "A");
  const k = await running(t, "K", a.id, { mode: "hold", ttlMs: 5_000 });
  const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
  await tail(t, k1);
  clock.t += 4_999;
  await t.daemon.deps.registry.setSandbox(k.id, k1.generation, null, "reclaim-2");
  assert.deepEqual(await sweepTtl(t), []);
  assert.equal(await state(t, k1), "exited");
});

test("TTL: an agent resumed between the sweep's list and its tell is not told and not reaped", async () => {
  const { t, clock } = ttlSetup();
  const a = await running(t, "A");
  const k = await running(t, "K", a.id, { mode: "hold", ttlMs: 5_000 });
  const k1 = await exitWith(t, k, "succeeded", { summary: "x" });
  await tail(t, k1);
  clock.t += 5_000;
  const reg = t.daemon.deps.registry;
  const wrapped = Object.create(reg) as typeof reg;
  wrapped.get = async (id) => {
    const r = await reg.get(id);
    return r && id === k.id ? ({ ...r, state: "running", generation: r.generation + 1 } as AgentRecord) : r;
  };
  const d = new Daemon({ ...t.daemon.deps, registry: wrapped });
  assert.deepEqual(await (d as unknown as { sweepHoldTtl: () => Promise<string[]> }).sweepHoldTtl(), []);
  assert.equal((await messages(t, a)).length, 0, "no reaped notice for a resumed agent");
  assert.equal(await state(t, k1), "exited");
});

test("TTL: the notice tells the custodian that the branch keeps any pushed work", async () => {
  const { t, clock } = ttlSetup();
  const a = await running(t, "A");
  const k = await running(t, "K", a.id, { mode: "hold", ttlMs: 5_000 });
  await tail(t, await exitWith(t, k, "succeeded", { summary: "x" }));
  clock.t += 5_000;
  await sweepTtl(t);
  const body = (await messages(t, a))[0]!.body;
  assert.ok(body.endsWith(`; branch agent/${k.id} keeps any pushed work (\`pomtree pull --from ${k.id}\`)`), body);
});

test("spawn body validation: a disposition that is not an object, has no mode, or carries a non-numeric or fractional ttlMs is a 400 through the route", async () => {
  const t = setup(async () => {});
  const post = (key: string, disposition: unknown) => t.operator("POST", "/v1/agents", { name: "w", task: "t", idempotencyKey: key, disposition });
  for (const [key, bad, re] of [
    ["d1", "hold", /disposition must be an object/],
    ["d2", [], /disposition must be an object/],
    ["d3", null, /disposition must be an object/],
    ["d4", {}, /mode must be a non-empty string/],
    ["d5b", { mode: "hold", ttlMs: "abc" }, /disposition\.ttlMs/],
    ["d5c", { mode: "hold", ttlMs: 1.5 }, /disposition\.ttlMs must be a positive integer/],
  ] as const) {
    const r = await post(key, bad);
    assert.equal(r.status, 400, key);
    assert.match(JSON.stringify(r.body), re, key);
  }
  assert.equal((await post("d6", { mode: "hold", ttlMs: 5000 })).status, 201);
});
