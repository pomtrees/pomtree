import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JsonValue, WaitCondition, WorkflowDef, WorkflowRunContext } from "@pomtree/core";
import { setup, spawnSpec, until } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";
import type { Reconcile } from "./daemon/reconcile.ts";
import { CONTINUATION_KIND } from "./workflow-continuation.ts";
import { WorkflowHost } from "./workflows.ts";

// Reconcile recovery of deterministic runs: a reviewed continuation driver whose unreported run is recovered from
// its task-local snapshot, while an ordinary deterministic driver still fails on restart. Offline, over the test-setup fakes.

const EXT = "rec";
const PARK = `${EXT}/park`;
const PLAIN = `${EXT}/plain`;
const CHILD_WAIT = (child: string): WaitCondition => ({ kind: "child_exited", children: [child], mode: "all" });

type T = ReturnType<typeof setup>;
type RunRec = { generation: number; continuation: JsonValue | undefined };

// Shared per test: the committed definitions record each run, so tests can assert which runs the reconcile pass started.
function harness(runs: RunRec[], plainRuns: number[]) {
  let t!: T;
  const park: WorkflowDef = {
    name: "park",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      runs.push({ generation: ctx.generation, continuation: ctx.continuation as JsonValue | undefined });
      // The snapshot names the child it waited on; a result cannot be submitted while a child is unreaped.
      const child = (ctx.continuation as { child?: string } | undefined)?.child;
      if (child !== undefined) await ctx.ops.reap(child, `${ctx.agent}:reap`);
      await ctx.ops.submitResult({ summary: "resumed" }, `${ctx.agent}:done`);
    },
  };
  const plain: WorkflowDef = {
    name: "plain",
    validate: (input) => ({ ok: true, value: input }),
    run: async (ctx: WorkflowRunContext & { input: JsonValue }) => {
      plainRuns.push(ctx.generation);
      await new Promise<void>(() => {});
    },
  };
  const host = new WorkflowHost({
    registry: () => t.fakes.registry,
    reviewed: (o) => o === EXT,
    startDeterministic: (requester, req) => t.daemon.startDeterministic(requester, req),
  });
  host.commit(EXT, [park, plain]);
  t = setup(async (_c: Ctx) => {}, { deterministicExecutors: host.executors });
  return t;
}

// A deterministic agent created and moved to running, with no live driver (the state a crashed daemon leaves behind).
async function runningDet(t: T, key: string, driver: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.fakes.registry.create({
    executor: "deterministic",
    spec: { driver, input: {} },
    parent: root.id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 100,
    idempotencyKey: key,
  });
  return t.fakes.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
}

// A container child parked in yielded: non-terminal for the wait, and no live entry or driver for the reconcile pass to act on.
async function parkedChild(t: T, parent: string, key: string): Promise<string> {
  const reg = t.fakes.registry;
  const c = await reg.create({ spec: spawnSpec, parent, name: key, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: key });
  const r = await reg.transition(c.id, c.generation, "running", { idempotencyKey: `${key}-run` });
  await reg.transition(c.id, r.generation, "yielded", { idempotencyKey: `${key}-yield` });
  return c.id;
}

// The task-local snapshot a reviewed continuation writes through ops.suspend (journal kind CONTINUATION_KIND).
async function snapshot(t: T, id: string, generation: number, child: string, phase = 1): Promise<void> {
  await t.journal.append({
    agent: id,
    host: "h1",
    generation,
    payload: { kind: CONTINUATION_KIND, state: { phase, child }, wait: CHILD_WAIT(child), inbox: [] },
    idempotencyKey: `${id}:${generation}:snapshot`,
  });
}

async function yieldAgent(t: T, a: AgentRecord): Promise<void> {
  await t.fakes.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: `${a.id}:${a.generation}:yield` });
}

// Finishing a run reaps it, so a finished agent is `exited` or `reaped`.
const terminal = async (t: T, id: string) => {
  const r = await t.daemon.get(id);
  return r && (r.state === "exited" || r.state === "reaped") ? r : undefined;
};

const journalKinds = async (t: T, id: string) => (await t.journal.read({ agent: id, from: 0, limit: 500 })).map((e) => e.payload.kind);

test("a yielded continuation agent is re-armed through checkWorkflowWait: it stays yielded while its child is non-terminal", async () => {
  const runs: RunRec[] = [];
  const t = harness(runs, []);
  const a = await runningDet(t, "y-armed", PARK);
  const child = await parkedChild(t, a.id, "y-armed-kid");
  await snapshot(t, a.id, a.generation, child);
  await yieldAgent(t, a);

  const waits: WaitCondition[] = [];
  const orchestrator = t.orchestrator;
  const waitFor = orchestrator.waitFor.bind(orchestrator);
  orchestrator.waitFor = async (agent, wait) => {
    if (agent === a.id) waits.push(wait);
    return waitFor(agent, wait);
  };

  await t.daemon.reconcile();

  assert.equal((await t.daemon.get(a.id))?.state, "yielded");
  assert.deepEqual(runs, [], "no run starts while the child is non-terminal");
  // checkWorkflowWait arms the snapshot's wait with the message and deadline receivers; the checkpoint path would pass it through raw.
  assert.equal(waits.length, 1, "the agent is re-armed exactly once");
  assert.equal(waits[0]!.kind, "any");
  assert.deepEqual((waits[0] as { of: WaitCondition[] }).of[0], CHILD_WAIT(child));
});

test("a yielded continuation agent resumes through checkWorkflowWait once its child is terminal, from the snapshot state", async () => {
  const runs: RunRec[] = [];
  const t = harness(runs, []);
  const a = await runningDet(t, "y-resume", PARK);
  const child = await parkedChild(t, a.id, "y-resume-kid");
  await snapshot(t, a.id, a.generation, child, 7);
  await yieldAgent(t, a);
  const c = (await t.daemon.get(child))!;
  await t.fakes.registry.transition(c.id, c.generation, "exited", { exit: "succeeded", idempotencyKey: "y-resume-kid-exit" });

  await t.daemon.reconcile();

  await until(async () => (await terminal(t, a.id)) !== undefined, 10_000);
  assert.equal((await t.daemon.get(a.id))?.exit, "succeeded");
  assert.deepEqual(runs, [{ generation: a.generation + 1, continuation: { phase: 7, child } }], "the resume is one generation later with the snapshot state");
});

test("an unreported continuation run whose snapshot is current is recovered to yielded, not replayed", async () => {
  const runs: RunRec[] = [];
  const t = harness(runs, []);
  const a = await runningDet(t, "rec-current", PARK);
  const child = await parkedChild(t, a.id, "rec-current-kid");
  await snapshot(t, a.id, a.generation, child);

  await t.daemon.reconcile();

  const after = (await t.daemon.get(a.id))!;
  assert.equal(after.state, "yielded", "recoverWorkflow completes the snapshot -> yielded edge");
  assert.equal(after.generation, a.generation, "no generation bump on the current snapshot");
  assert.deepEqual(runs, [], "the driver body is not replayed while the child is non-terminal");
});

test("an unreported continuation run with a snapshot from another generation is resumed forced at generation + 1", async () => {
  const runs: RunRec[] = [];
  const t = harness(runs, []);
  const a = await runningDet(t, "rec-stale", PARK);
  const child = await parkedChild(t, a.id, "rec-stale-kid");
  // The snapshot is journaled at the old generation; a later bump (a restart that moved the agent on) leaves it stale.
  await snapshot(t, a.id, a.generation, child, 3);
  await t.fakes.registry.bumpGeneration(a.id, "h1", "rec-stale-bump");

  await t.daemon.reconcile();

  await until(async () => (await terminal(t, a.id)) !== undefined, 10_000);
  assert.deepEqual(runs, [{ generation: a.generation + 2, continuation: { phase: 3, child } }], "the forced resume runs at the bumped generation + 1");
});

test("an unreported ordinary deterministic run fails explicitly on restart and cancels its children, without replay", async () => {
  const plainRuns: number[] = [];
  const t = harness([], plainRuns);
  const a = await runningDet(t, "plain-restart", PLAIN);
  const child = await parkedChild(t, a.id, "plain-restart-kid");

  await t.daemon.reconcile();

  const after = (await terminal(t, a.id))!;
  assert.equal(after.exit, "failed");
  assert.equal(after.generation, a.generation, "no restart generation for a deterministic run");
  assert.deepEqual(plainRuns, [], "the driver is not replayed");
  const errors = (await t.journal.read({ agent: a.id, from: 0, limit: 500 })).filter((e) => e.payload.kind === "error");
  assert.ok(
    errors.some((e) => (e.payload as { message?: string }).message?.includes("not replayed") === true),
    "the restart failure is journaled",
  );
  const kid = (await t.daemon.get(child))!;
  assert.ok(kid.state === "exited" || kid.state === "reaped", `child is cancelled and reaped by the finish tail, got ${kid.state}`);
});

test("a reported continuation run finishes as reported, even with a snapshot present, and does not recover to yielded", async () => {
  const runs: RunRec[] = [];
  const t = harness(runs, []);
  const a = await runningDet(t, "rep-cont", PARK);
  const child = await parkedChild(t, a.id, "rep-cont-kid");
  await snapshot(t, a.id, a.generation, child);
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "ext.pomtreed.result", status: "succeeded", result: { summary: "reported" }, wrapupDeadlineAt: 0 },
    idempotencyKey: `${a.id}:${a.generation}:reported`,
  });

  await t.daemon.reconcile();

  const after = (await terminal(t, a.id))!;
  assert.equal(after.exit, "succeeded");
  assert.deepEqual(runs, [], "a reported run is not recovered or replayed");
});

test("a reported ordinary deterministic run finishes with its reported status, not as a restart failure", async () => {
  const t = harness([], []);
  const a = await runningDet(t, "rep-plain", PLAIN);
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "ext.pomtreed.result", status: "failed", result: { summary: "gave up" }, wrapupDeadlineAt: 0 },
    idempotencyKey: `${a.id}:${a.generation}:reported`,
  });

  await t.daemon.reconcile();

  const after = (await terminal(t, a.id))!;
  assert.equal(after.exit, "failed", "the reported status is kept");
  const kinds = await journalKinds(t, a.id);
  assert.equal(kinds.includes("error"), false, "no restart error is journaled for a reported run");
});

test("restartFresh never restarts a deterministic run, even one that ran nothing", async () => {
  const t = harness([], []);
  const a = await runningDet(t, "rf-det", PLAIN);
  const reconcile = (t.daemon as unknown as { reconciler: Reconcile }).reconciler;

  assert.equal(await reconcile.restartFresh(a), false);
  assert.equal((await t.daemon.get(a.id))?.generation, a.generation, "no generation bump");
});
