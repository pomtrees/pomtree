import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, classifyExit, ExitCause } from "@pomtree/core";
import { classifySandboxExit, SANDBOX_LIFECYCLE_KIND } from "./daemon-util.ts";
import { setup, spawnSpec, until } from "./test-setup.ts";

type Mode = "none" | "cancelled" | "timedOut";

// Raw classifyExit baseline for each code, with no result, no OOM and no daemon-requested cancel.
const raw: Record<number, ReturnType<typeof classifyExit>> = {
  0: undefined,
  1: "app_exit",
  2: "app_exit",
  3: "app_exit",
  125: "exec_failed",
  126: "exec_failed",
  127: "exec_failed",
  129: "signal",
  130: "signal",
  137: "host_stopped",
  139: "signal",
  143: "host_stopped",
  255: "signal",
};
const codes = Object.keys(raw).map(Number);

// Explicit expectation for classifySandboxExit, derived from the raw column plus the rules:
// - oom_killed wins for 137 with oomKilled, whatever the result or cancel mode.
// - a daemon-requested cancel or timeout suppresses every other cause (classifyExit returns undefined).
// - expected:true only for 137/143 with a result, no OOM and no overBudget (cause undefined).
// - app_exit is never a cause; with a result, exec_failed and signal are suppressed.
function want(code: number, hasResult: boolean, oom: boolean, mode: Mode): { expected: boolean; cause: ExitCause | undefined } {
  const expected = hasResult && !oom && (code === 137 || code === 143);
  if (oom && code === 137) return { expected, cause: "oom_killed" };
  if (expected) return { expected, cause: undefined };
  if (mode !== "none") return { expected, cause: undefined };
  const base = raw[code];
  if (base === undefined || base === "app_exit") return { expected, cause: undefined };
  if (hasResult && (base === "exec_failed" || base === "signal")) return { expected, cause: undefined };
  return { expected, cause: base };
}

test("classifySandboxExit matches the explicit table across codes x result x oom x cancel mode", () => {
  for (const code of codes)
    for (const hasResult of [true, false])
      for (const oom of [true, false])
        for (const mode of ["none", "cancelled", "timedOut"] as Mode[]) {
          const got = classifySandboxExit({
            exitCode: code,
            hasResult,
            oomKilled: oom,
            cancelled: mode === "cancelled",
            timedOut: mode === "timedOut",
          });
          assert.deepEqual(got, want(code, hasResult, oom, mode), `code=${code} hasResult=${hasResult} oom=${oom} mode=${mode}`);
        }
});

test("plain app exits (1,2,3) never get a cause; oom needs exit 137", () => {
  for (const code of [1, 2, 3]) assert.equal(classifySandboxExit({ exitCode: code, hasResult: false }).cause, undefined);
  assert.equal(classifySandboxExit({ exitCode: 1, hasResult: false, oomKilled: true }).cause, undefined);
  assert.equal(classifySandboxExit({ exitCode: 137, hasResult: false, oomKilled: true }).cause, "oom_killed");
  assert.equal(classifySandboxExit({ exitCode: 143, hasResult: false, oomKilled: true }).cause, "host_stopped");
});

// Both drivers report no result and no OOM, so the predicted cause is the no-result column.
const predicted = (code: number) => classifySandboxExit({ exitCode: code, hasResult: false }).cause;

type Observed = {
  // The cause written on the transition into `exited` (the record loses it on reap, so this is read off the transition).
  transitionCause?: ExitCause;
  // The cause on the journaled sandbox `exited` row: the durable record of the container exit.
  journalCause?: string;
  exitCode?: number;
  state: string;
  exit?: string;
};

// Records the cause passed to the transition into `exited`; the real store nulls exit_cause on reap.
function watchExited(t: ReturnType<typeof setup>): { causes: (ExitCause | undefined)[] } {
  const reg = t.daemon.deps.registry;
  const orig = reg.transition.bind(reg);
  const causes: (ExitCause | undefined)[] = [];
  reg.transition = async (id, gen, to, o) => {
    const r = await orig(id, gen, to, o);
    if (to === "exited") causes.push(r.exitCause);
    return r;
  };
  return { causes };
}

async function observe(t: ReturnType<typeof setup>, id: string, causes: (ExitCause | undefined)[]): Promise<Observed> {
  const rows = await t.journal.read({ agent: id });
  const ex = rows.find((e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { phase?: string }).phase === "exited");
  const sb = ex?.payload as { cause?: string; exitCode?: number } | undefined;
  const rec = (await t.daemon.get(id)) as AgentRecord;
  return { transitionCause: causes[causes.length - 1], journalCause: sb?.cause, exitCode: sb?.exitCode, state: rec.state, exit: rec.exit ?? undefined };
}

async function settleObserved(code: number, oom = false): Promise<Observed> {
  // The runner does nothing; the test stops the container while the agent is still running (no result reported).
  const t = setup(async () => {
    await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
    t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, code, oom);
  });
  const { causes } = watchExited(t);
  const a = await t.spawn();
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(a.id)) as AgentRecord).state));
  await t.orchestrator.idle();
  return observe(t, a.id, causes);
}

async function adoptObserved(code: number, oom = false): Promise<Observed> {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  const sb = await t.fakes.hooks.raw.sandbox.start(
    { host: "h1", generation: 0, agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
    "sb",
  );
  await reg.setSandbox(a.id, a.generation, sb.id, "sb-set");
  const { causes } = watchExited(t);
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  t.fakes.hooks.raw.sandbox.exit(sb.id, code, oom);
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(a.id)) as AgentRecord).state));
  await t.orchestrator.idle();
  return observe(t, a.id, causes);
}

for (const code of codes) {
  test(`exit ${code} with no result: settle and adopt paths record the same exitCause`, async () => {
    const s = await settleObserved(code);
    const d = await adoptObserved(code);
    assert.equal(s.transitionCause, predicted(code), "settle path cause vs classifier");
    assert.equal(d.transitionCause, predicted(code), "adopt path cause vs classifier");
    assert.equal(s.transitionCause, d.transitionCause, "settle and adopt disagree on exitCause");
  });
}

// Known divergence (finding, not yet fixed): the settle path journals the cause on the sandbox `exited` row, the adopt
// path journals only exitCode. Expected to fail for every nonzero non-app code until the adopt path journals the cause.
for (const code of codes) {
  test(`exit ${code} with no result: journaled sandbox exit cause matches across paths`, async () => {
    const s = await settleObserved(code);
    const d = await adoptObserved(code);
    assert.equal(s.journalCause, d.journalCause, "settle and adopt disagree on the journaled exit cause");
  });
}

test("exit 137 with oomKilled: both paths record oom_killed", async () => {
  const s = await settleObserved(137, true);
  const d = await adoptObserved(137, true);
  assert.equal(s.transitionCause, "oom_killed");
  assert.equal(d.transitionCause, "oom_killed");
});

test("exit 143 with no result: both paths record host_stopped and no auto-restart", async () => {
  const s = await settleObserved(143);
  const d = await adoptObserved(143);
  assert.equal(s.transitionCause, "host_stopped");
  assert.equal(d.transitionCause, "host_stopped");
  assert.equal(s.state, "reaped");
  assert.equal(d.state, "reaped");
});
