import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, DeterministicRunContext } from "@pomtree/core";
import { FakeDeterministicExecutor } from "@pomtree/testing";
import { setup, until } from "./test-setup.ts";

// Failure-boundary regressions for the deterministic run loop: the driver's signal is aborted when settling fails, a cancel
// that finds no live entry can never let the driver body start, a failed first registry read fails closed (no container
// admission), and the deadline timer is disposed on every exit. All gates are explicit barriers; there are no sleeps.

const DRV = "fake-parent";
const TIMEOUT = { timeout: 10_000 };
type T = ReturnType<typeof setup>;
type Any = { [k: string]: (...a: unknown[]) => unknown };

const startDet = async (t: T, key: string, extra: Record<string, unknown> = {}) =>
  t.daemon.startDeterministic((await t.daemon.root()).id, {
    name: "det",
    task: "t",
    idempotencyKey: key,
    executor: "deterministic",
    spec: { driver: DRV, input: null },
    budgetMicros: 500,
    ...extra,
  } as Parameters<typeof t.daemon.startDeterministic>[1]);

const gateOf = () => {
  let open = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const done = (r: AgentRecord | null) => !!r && (r.state === "exited" || r.state === "reaped");
const rec = async (t: T, id: string) => (await t.daemon.get(id)) as AgentRecord;

test("a failed settle still aborts the driver's signal", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(DRV);
  let signal: AbortSignal | undefined;
  exec.setHandler(async (ctx: DeterministicRunContext) => {
    signal = ctx.signal; // returns without a result: the run loop must settle it as failed
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[DRV, exec] as const]) });
  const reg = t.daemon.deps.registry as unknown as Any;
  const orig = reg.transition!.bind(reg);
  let refused = 0;
  reg.transition = async (...a: unknown[]) => {
    if (a[2] === "exited") {
      refused++;
      throw new Error("injected settle failure");
    }
    return orig(...a);
  };
  const r = await startDet(t, "settle-fail");
  await until(() => signal?.aborted === true);
  assert.ok(refused >= 1, "the terminal write was attempted and refused");
  assert.equal(signal!.aborted, true, "the driver's signal was aborted although settling failed");
  assert.notEqual((await rec(t, r.id)).state, "exited");
});

// Creates the task with the orchestrator's background start suppressed, so the test drives it explicitly through the public
// `daemon.drive` and installs its faults only after creation. `restore` puts the orchestrator back.
async function createHeld(t: T, key: string) {
  const orch = t.orchestrator as unknown as Any;
  const startOrig = orch.start!;
  const held: { id: string; gen: number }[] = [];
  orch.start = async (id: unknown, gen: unknown) => void held.push({ id: id as string, gen: gen as number });
  try {
    const r = await startDet(t, key);
    assert.deepEqual(held, [{ id: r.id, gen: r.generation }], "the background start was captured, not run");
    return { id: r.id, gen: r.generation };
  } finally {
    orch.start = startOrig;
  }
}

test("a cancel that found no live entry cannot let the driver body start (finish between running and exited)", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(DRV);
  let bodies = 0;
  exec.setHandler(async () => {
    bodies++;
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[DRV, exec] as const]) });
  const rootId = (await t.daemon.root()).id;
  const { id, gen } = await createHeld(t, "early-cancel");
  const reg = t.daemon.deps.registry as unknown as Any;
  const j = t.daemon.deps.journal as unknown as { append: (e: { agent: string; payload: { kind: string } }) => Promise<unknown> };
  const getOrig = reg.get!;
  const trOrig = reg.transition!;
  const jOrig = j.append;
  const staleRead = gateOf(); // holds the run loop's pre-`live` read
  const exitHold = gateOf(); // holds the cancel's finish between its running and exited steps
  let getCalls = 0;
  let staleHeld = false;
  let exitReached = false;
  let started = false;
  try {
    // Documented call sequence of `daemon.drive` for this id: read 1 is the executor check, read 2 is the run loop's own read
    // before it registers `live`. Hold read 2 after it has resolved, so the loop continues with a pending (pre-cancel) record.
    reg.get = async (...a: unknown[]) => {
      const v = await getOrig.apply(reg, a);
      if (a[0] === id && ++getCalls === 2) {
        staleHeld = true;
        await staleRead.p;
      }
      return v;
    };
    reg.transition = async (...a: unknown[]) => {
      if (a[0] === id && a[2] === "exited") {
        exitReached = true;
        await exitHold.p;
      }
      return trOrig.apply(reg, a);
    };
    j.append = async (e) => {
      const r = await jOrig.call(j, e);
      if (e.payload.kind === "started" && e.agent !== rootId) started = true;
      return r;
    };
    const driving = t.daemon.drive(id, gen);
    await until(() => staleHeld);
    const cancelling = t.daemon.cancel(id, 5); // no live entry yet: finishes the row itself
    await until(() => exitReached); // the row is running, not yet exited
    staleRead.open(); // the run loop proceeds with its stale pending read and reaches the start gate
    await until(() => started);
    exitHold.open();
    await cancelling;
    await driving;
    assert.equal(bodies, 0, "driver.run was never called for a cancelled record");
    assert.equal((await rec(t, id)).exit, "cancelled");
  } finally {
    staleRead.open();
    exitHold.open();
    reg.get = getOrig;
    reg.transition = trOrig;
    j.append = jOrig;
    await t.orchestrator.idle();
  }
});

test("a failed first registry read fails closed: no admission, workspace, sandbox or gateway call", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(DRV);
  let bodies = 0;
  exec.setHandler(async () => {
    bodies++;
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[DRV, exec] as const]) });
  const { id, gen } = await createHeld(t, "read-fail");
  const calls: string[] = [];
  const restores: (() => void)[] = [];
  const spy = (obj: object, names: string[], label: string) => {
    for (const n of names) {
      const o = obj as Any;
      const orig = o[n]!;
      o[n] = (...a: unknown[]) => {
        calls.push(`${label}.${n}`);
        return orig.apply(obj, a);
      };
      restores.push(() => (o[n] = orig));
    }
  };
  const d = t.daemon.deps as unknown as Record<string, object>;
  const reg = t.daemon.deps.registry as unknown as Any;
  const getOrig = reg.get!;
  try {
    spy(d.placement!, ["admit"], "placement");
    spy(d.workspace!, ["create", "fork"], "workspace");
    spy(d.sandbox!, ["start"], "sandbox");
    spy(d.gateway!, ["issueKey"], "gateway");
    let failed = 0;
    reg.get = (...a: unknown[]) => {
      if (a[0] === id && failed === 0) {
        failed++; // the first read of this task by the drive
        return Promise.reject(new Error("injected registry read failure"));
      }
      return getOrig.apply(reg, a);
    };
    await assert.rejects(t.daemon.drive(id, gen), /injected registry read failure/);
    assert.equal(failed, 1);
    assert.deepEqual(calls, [], "no container admission, workspace, sandbox or gateway call");
    assert.equal(bodies, 0);
  } finally {
    reg.get = getOrig;
    for (const r of restores) r();
  }
  assert.equal((await rec(t, id)).state, "pending", "the record is left untouched for recovery");
});

test("the deadline timer is cleared after success, failure and cancel", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(DRV);
  const mode: { v: "ok" | "throw" | "hang" } = { v: "ok" };
  exec.setHandler(async (ctx: DeterministicRunContext) => {
    if (mode.v === "ok") await ctx.ops.submitResult({ summary: "ok" }, "k");
    else if (mode.v === "throw") throw new Error("boom");
    else await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[DRV, exec] as const]) });
  const DEADLINE = 3_456_789; // a distinctive delay so only the deadline timers are tracked
  const created = new Set<unknown>();
  const cleared = new Set<unknown>();
  const st = globalThis.setTimeout;
  const ct = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const h = (st as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    if (ms !== undefined && ms > DEADLINE - 5_000 && ms <= DEADLINE) created.add(h); // remaining time shrinks with clock drift
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => {
    cleared.add(h);
    return (ct as (h: unknown) => void)(h);
  }) as typeof clearTimeout;
  try {
    const ids: string[] = [];
    for (const m of ["ok", "throw", "hang"] as const) {
      mode.v = m;
      const r = await startDet(t, `timer-${m}`, { deadlineMs: DEADLINE });
      ids.push(r.id);
      if (m === "hang") {
        await until(() => created.size === 3);
        await t.daemon.cancel(r.id, 5);
      }
      await until(async () => done(await t.daemon.get(r.id)));
    }
    await t.orchestrator.idle();
    assert.equal(created.size, 3, "one deadline timer per run");
    for (const h of created) assert.ok(cleared.has(h), "every deadline timer was cleared when its run settled");
  } finally {
    globalThis.setTimeout = st;
    globalThis.clearTimeout = ct;
  }
});
