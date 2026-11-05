// Failure isolation for the reconcile pass: A throwing phase does not stop later
// phases, a store outage latches instead of journaling, a repeatedly failing agent is backed off with one alert and then
// recovers, and per-agent inspect counters are pruned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentRecord, CHECKPOINT_FORMAT, UnsupportedCheckpointVersion } from "@pomtree/core";
import { get, setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
type Peek = { degraded: boolean; reconciler: { inspectFailures: Map<string, number>; failures: Map<string, unknown> } };

const finishes = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Forwards every method to the late-bound target unless `fault` returns an error for that call.
function faulty<I extends object>(fault: (method: string, args: unknown[]) => unknown) {
  let target!: I;
  const proxy = new Proxy({} as I, {
    get: (_, k) =>
      typeof k === "symbol" || k === "then"
        ? undefined
        : (...args: unknown[]) => {
            const err = fault(String(k), args);
            if (err) return Promise.reject(err);
            return (target as Record<string, (...a: unknown[]) => unknown>)[String(k)]!.apply(target, args);
          },
  });
  return {
    proxy,
    bind: (x: I) => {
      target = x;
    },
  };
}

async function seedRunning(t: T, name: string): Promise<AgentRecord> {
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const a0 = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: name });
  return reg.transition(a0.id, a0.generation, "running", { idempotencyKey: `${name}-run` });
}

const rootErrors = async (t: T) => (await t.journal.read({ agent: (await t.daemon.root()).id })).filter((e) => e.payload.kind === "error");

test("a throwing phase does not stop the later phases, and is journaled once on the root", async () => {
  let yieldedLists = 0;
  const reg = faulty<T["fakes"]["registry"]>((m, args) =>
    m === "list" && (args[0] as { state?: string } | undefined)?.state === "yielded" && ++yieldedLists === 1 ? new Error("boom") : null,
  );
  const t = setup(finishes, { registry: reg.proxy });
  reg.bind(t.fakes.registry);
  const a = await seedRunning(t, "iso1"); // no checkpoint, no container: the running phase restarts it from scratch
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).generation, a.generation + 1, "the running phase still ran after the budget-decisions phase threw");
  const errs = (await rootErrors(t)).map((e) => (e.payload as { message: string }).message);
  assert.deepEqual(
    errs.filter((m) => m.startsWith("reconcile phase")),
    ["reconcile phase budget-decisions failed: boom"],
  );
  await t.daemon.reconcile(); // a failure-free pass journals nothing new
  assert.equal((await rootErrors(t)).length, errs.length);
  await t.daemon.kill(a.id).catch(() => {});
  await t.orchestrator.idle();
});

test("a store-outage phase failure latches degraded, is not journaled, and the other phases still run", async () => {
  let n = 0;
  const reg = faulty<T["fakes"]["registry"]>((m, args) =>
    m === "list" && (args[0] as { state?: string } | undefined)?.state === "yielded" && ++n === 1
      ? Object.assign(new Error("disk"), { code: "SQLITE_IOERR" })
      : null,
  );
  const t = setup(finishes, { registry: reg.proxy });
  reg.bind(t.fakes.registry);
  const a = await seedRunning(t, "iso2");
  const before = (await rootErrors(t)).length;
  await t.daemon.reconcile();
  await sleep(40); // admission is held by the latch, so the orchestrator never goes idle
  assert.equal((t.daemon as unknown as Peek).degraded, true, "the existing store-down latch is set");
  assert.equal((await rootErrors(t)).length, before, "nothing journaled to the failing store");
  assert.equal((await get(t, a.id)).generation, a.generation + 1, "later phases ran");
  await t.daemon.kill(a.id).catch(() => {});
  await sleep(40); // admission is held by the latch, so the orchestrator never goes idle
});

test("an agent whose step throws every pass is backed off, alerts exactly once, then recovers and resets", async () => {
  let clock = 1_000_000;
  let failing = true;
  let starts = 0;
  const t = setup(finishes, {
    now: () => clock,
    reconcileFailureThreshold: 2,
    reconcileBackoffMs: 1000,
    reconcileBackoffMaxMs: 4000,
  });
  const real = t.daemon.deps.orchestrator;
  const origStart = real.start.bind(real);
  real.start = (async (...args: Parameters<typeof origStart>) => {
    starts++;
    if (failing) throw new Error("poisoned");
    return origStart(...args);
  }) as typeof real.start;
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "iso3",
    task: "t",
    host: "h1",
    budgetMicros: 100_000,
    idempotencyKey: "iso3",
  });
  const alerts = async () =>
    (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error" && (e.payload as { message: string }).message.includes("backing off"))
      .length;
  const peek = t.daemon as unknown as Peek;

  await t.daemon.reconcile(); // failure 1
  assert.equal(starts, 1);
  assert.equal(await alerts(), 0, "below the threshold: no alert");
  await t.daemon.reconcile(); // failure 2 = threshold
  assert.equal(starts, 2);
  assert.equal(await alerts(), 1, "one alert when the threshold is crossed");
  await t.daemon.reconcile();
  await t.daemon.reconcile();
  assert.equal(starts, 2, "inside the backoff window the agent is skipped");
  clock += 1000;
  await t.daemon.reconcile(); // window over: retried, fails again, window doubles
  assert.equal(starts, 3);
  clock += 1000;
  await t.daemon.reconcile();
  assert.equal(starts, 3, "the second window is longer");
  assert.equal(await alerts(), 1, "still exactly one alert");
  clock += 5000;
  failing = false;
  await t.daemon.reconcile(); // recovers
  await t.orchestrator.idle();
  assert.equal(starts, 4);
  assert.equal(peek.reconciler.failures.size, 0, "a successful pass resets the counter");
  await t.daemon.kill(a.id).catch(() => {});
  await t.orchestrator.idle();
  await sleep(10);
});

test("inspectFailures entries are pruned once the agent is no longer running", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await seedRunning(t, "iso4");
  await t.daemon.reconcile(); // restarts it from scratch: running with a live entry
  await sleep(40);
  assert.equal((await get(t, a.id)).state, "running");
  const counts = (t.daemon as unknown as Peek).reconciler.inspectFailures;
  counts.set("ghost", 2);
  counts.set(a.id, 2);
  await t.daemon.reconcile();
  assert.equal(counts.has("ghost"), false, "an id that is not running is dropped");
  assert.equal(counts.has(a.id), true, "a still-running agent keeps its count");
  await t.daemon.cancel(a.id);
  await t.orchestrator.idle();
  await t.daemon.reconcile();
  assert.equal(counts.has(a.id), false, "an agent that left running is pruned");
});

test("a refused (versionless) checkpoint is journaled on that agent with the action, and a healthy sibling is still recovered", async () => {
  let bad = "";
  const cps = faulty<T["fakes"]["checkpoints"]>((m, args) =>
    m === "latest" && args[0] === bad ? new UnsupportedCheckpointVersion(undefined, CHECKPOINT_FORMAT) : null,
  );
  const t = setup(finishes, { checkpoints: cps.proxy });
  cps.bind(t.fakes.checkpoints);
  const sick = await seedRunning(t, "iso5a");
  const well = await seedRunning(t, "iso5b");
  bad = sick.id;
  await t.daemon.reconcile(); // must not throw
  await t.orchestrator.idle();
  const errs = (await t.journal.read({ agent: sick.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /^reconcile failed: checkpoint has no format version.*remove or re-create the agent/);
  assert.equal((await get(t, sick.id)).generation, sick.generation, "the refused agent is left for the operator, not restarted");
  assert.equal((await get(t, well.id)).generation, well.generation + 1, "the sibling is recovered");
  const wellErrs = (await t.journal.read({ agent: well.id })).map((e) => (e.payload as { message?: string }).message ?? "");
  assert.equal(wellErrs.filter((m) => m.startsWith("reconcile failed")).length, 0);
  await t.daemon.kill(sick.id).catch(() => {});
  await t.daemon.kill(well.id).catch(() => {});
  await t.orchestrator.idle();
});
