import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId, DeterministicExecutor, DeterministicOps, EscalationId, WorkflowDef } from "@pomtree/core";
import { createFakes, FakeDeterministicOps, FakeSuspension, fakeDeterministicContext } from "@pomtree/testing";
import { continuationBarrier, sleepTick, WorkflowHost } from "./workflows.ts";

// Offline unit coverage for the continuation additions in WorkflowHost: the `continuation` flag validation, the per-driver
// barrier registered in a WeakMap, and the ops wrappers (trackOps/guardOps) that forward and track the escalation, approval
// and child-discovery ops. Fakes come from @pomtree/testing; nothing here starts a daemon.

const EXT = "cov";
const TIMEOUT = { timeout: 5_000 };
const SHA = "a".repeat(64);
const ESC = "es-1" as EscalationId;

const noStart = async (): Promise<never> => {
  throw new Error("unused: these tests never start a workflow through the daemon");
};

function newHost() {
  const fakes = createFakes();
  const host = new WorkflowHost({ registry: () => fakes.registry, reviewed: (ext) => ext === EXT, startDeterministic: noStart });
  return { fakes, host };
}

const def = (name: string, extra: Partial<WorkflowDef> = {}): WorkflowDef => ({
  name,
  validate: (input) => ({ ok: true, value: input }),
  run: async () => {},
  ...extra,
});

function executorOf(host: WorkflowHost, q: string): DeterministicExecutor {
  const e = host.executors.get(q);
  assert.ok(e, `no executor registered for ${q}`);
  return e;
}

function barrierOf(host: WorkflowHost, q: string): (agent: AgentId) => Promise<void> {
  const b = continuationBarrier(executorOf(host, q));
  assert.ok(b, `no continuation barrier for ${q}`);
  return b;
}

// Holds every method call on the fake until `gate` opens, then runs the real method. A call is recorded only when it runs.
function heldOps(base: FakeDeterministicOps, gate: Promise<void>): DeterministicOps {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => gate.then(() => Reflect.apply(v, target, args));
    },
  });
}

test("a non-boolean continuation refuses the whole extension at commit: no driver is registered", TIMEOUT, () => {
  for (const bad of ["yes", 1, null, {}]) {
    const { host } = newHost();
    assert.throws(
      () => host.commit(EXT, [def("ok"), def("bad", { continuation: bad as never })]),
      /workflow cov\/bad: continuation must be boolean/,
      `continuation ${JSON.stringify(bad)}`,
    );
    assert.equal(host.executors.size, 0, `continuation ${JSON.stringify(bad)}: nothing from the extension is committed`);
  }
});

test("continuationBarrier is registered only for continuation: true; false, absent and undefined get none", TIMEOUT, () => {
  const { host } = newHost();
  host.commit(EXT, [def("on", { continuation: true }), def("off", { continuation: false }), def("plain"), def("undef", { continuation: undefined })]);
  assert.equal(typeof barrierOf(host, "cov/on"), "function");
  for (const q of ["cov/off", "cov/plain", "cov/undef"]) assert.equal(continuationBarrier(host.executors.get(q)), undefined, q);
  assert.equal(continuationBarrier(undefined), undefined);
});

test("the barrier resolves at once when its agent has no execution in flight", TIMEOUT, async () => {
  const { host } = newHost();
  host.commit(EXT, [def("on", { continuation: true })]);
  await barrierOf(host, "cov/on")("nobody" as AgentId);
});

test("the barrier waits for in-flight executions of its agent, loops over late arrivals, and ignores other agents", TIMEOUT, async () => {
  const { host } = newHost();
  const open = new Map<string, () => void>();
  host.commit(EXT, [
    def("hold", {
      continuation: true,
      run: (ctx) =>
        new Promise<void>((resolve) => {
          open.set(String(ctx.input), resolve);
        }),
    }),
  ]);
  const driver = executorOf(host, "cov/hold");
  const barrier = barrierOf(host, "cov/hold");
  const start = (agent: string, input: string) => driver.run(fakeDeterministicContext({ agent, input, ops: new FakeDeterministicOps(0, 0, agent) }));
  const release = (key: string) => {
    const f = open.get(key);
    assert.ok(f, `no open execution ${key}`);
    f();
  };

  const a1 = start("A", "a1");
  const a2 = start("A", "a2");
  const b1 = start("B", "b1");
  await sleepTick();
  let settled = false;
  const waiting = barrier("A" as AgentId).then(() => {
    settled = true;
  });

  release("b1");
  await b1;
  await sleepTick();
  assert.equal(settled, false, "another agent's completion does not release A's barrier");

  release("a1");
  await a1;
  const a3 = start("A", "a3"); // arrives while the barrier waits on a2
  await sleepTick();
  release("a2");
  await a2;
  await sleepTick();
  assert.equal(settled, false, "after a2 settles the barrier loops and still waits for a3");

  release("a3");
  await a3;
  await waiting;
  assert.equal(settled, true);
});

for (const c of [
  {
    op: "findChild",
    call: (o: DeterministicOps) => o.findChild("spawn-1"),
    expected: { op: "findChild", arg: "spawn-1" },
  },
  {
    op: "suspend",
    call: (o: DeterministicOps) => o.suspend(null, { kind: "message" }, "susp-1"),
    expected: { op: "suspend", key: "susp-1", arg: { state: null, wait: { kind: "message" } } },
  },
  {
    op: "answerEscalation",
    call: (o: DeterministicOps) => o.answerEscalation(ESC, "yes", "ans-1"),
    expected: { op: "answerEscalation", key: "ans-1", arg: { id: ESC, answer: "yes" } },
  },
  {
    op: "passEscalation",
    call: (o: DeterministicOps) => o.passEscalation(ESC, "pass-1"),
    expected: { op: "passEscalation", key: "pass-1", arg: ESC },
  },
  {
    op: "openApproval",
    call: (o: DeterministicOps) => o.openApproval("publish", SHA, "ap-1"),
    expected: { op: "openApproval", key: "ap-1", arg: { kind: "publish", target: SHA } },
  },
  {
    op: "getApproval",
    call: (o: DeterministicOps) => o.getApproval("ap-1"),
    expected: { op: "getApproval", arg: "ap-1" },
  },
] as const) {
  test(`${c.op} reaches the underlying ops with its arguments, and a shutdown drain waits for the call`, TIMEOUT, async () => {
    const { host } = newHost();
    host.commit(EXT, [
      def("ops", {
        run: async (ctx) => {
          // The handler sees the tracked, guarded wrapper; the case is selected by the input the test passes in.
          if (ctx.input !== c.op) throw new Error(`unexpected input ${JSON.stringify(ctx.input)}`);
          await c.call(ctx.ops);
        },
      }),
    ]);
    const base = new FakeDeterministicOps(0, 0, "A");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = executorOf(host, "cov/ops");
    const outcome = driver.run(fakeDeterministicContext({ agent: "A", input: c.op, ops: heldOps(base, gate) })).then(
      () => null,
      (e: unknown) => e,
    );
    await sleepTick();

    let drained = false;
    const waited = host.idle().then(() => {
      drained = true;
    });
    await sleepTick();
    assert.equal(drained, false, "the held call keeps its execution open for the shutdown barrier");
    assert.deepEqual(base.calls, [], "nothing is forwarded before the call is released");

    release();
    const err = await outcome;
    await waited;
    assert.deepEqual(base.calls, [c.expected]);
    if (c.op === "suspend") assert.ok(err instanceof FakeSuspension, "suspend parks the run");
    else assert.equal(err, null, "the call resolves with the fake's result");
  });
}

test("drain cancels an owned yielded row, not only pending and running ones", TIMEOUT, async () => {
  const { fakes, host } = newHost();
  host.commit(EXT, [def("park")]);
  const reg = fakes.registry;
  const row = await reg.create({
    parent: "root",
    name: "parked",
    task: "t",
    host: "h1",
    budgetMicros: 500,
    idempotencyKey: "park-1",
    executor: "deterministic",
    spec: { driver: "cov/park", input: null },
  });
  await reg.transition(row.id, row.generation, "running", { idempotencyKey: "park-run" });
  await reg.transition(row.id, row.generation, "yielded", { idempotencyKey: "park-yield" });

  const cancelled: AgentId[] = [];
  const drained = await host.drain({
    deadlineAt: Date.now() + 60_000,
    now: () => Date.now(),
    tick: sleepTick,
    race: (p) => p,
    cancel: async (id) => {
      cancelled.push(id);
      await reg.transition(id, row.generation, "exited", { exit: "cancelled", idempotencyKey: `cancel-${id}` });
    },
  });
  assert.deepEqual(cancelled, [row.id], "the yielded owned row is cancelled");
  assert.equal(drained.complete, true, JSON.stringify(drained));
  assert.deepEqual(drained.retained, []);
});
