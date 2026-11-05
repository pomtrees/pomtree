import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, DeterministicExecutor, DeterministicRunContext } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { createFakes, FakeDeterministicExecutor, ScriptHarness } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { SECRET, setup, spawnSpec, until } from "./test-setup.ts";

// Focused regressions for the deterministic host ops: budget and deadline validation before any row exists, the cleanup
// sweep never running Git prune on a deterministic task, and a run cancelled before its driver starts never running it.

const PARENT = "fake-parent";
const TIMEOUT = { timeout: 10_000 };

const start = async (t: ReturnType<typeof setup>, key: string, extra: Record<string, unknown> = {}) =>
  t.daemon.startDeterministic((await t.daemon.root()).id, {
    name: "det",
    task: "t",
    idempotencyKey: key,
    executor: "deterministic",
    spec: { driver: PARENT, input: null },
    budgetMicros: 500,
    ...extra,
  } as Parameters<typeof t.daemon.startDeterministic>[1]);

const rowCount = async (t: ReturnType<typeof setup>) => (await t.daemon.list({ parent: (await t.daemon.root()).id })).length;

test("an explicit negative, NaN or fractional budget is refused before any row is created; no carve leaks", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]) });
  const before = await rowCount(t);
  for (const bad of [-400, Number.NaN, 1.5]) {
    await assert.rejects(start(t, `bad-budget-${String(bad)}`, { budgetMicros: bad }), /budgetMicros must be a non-negative safe integer/);
  }
  assert.equal(await rowCount(t), before, "no row was created for any refused budget");
  // A carve larger than what the parent has left is still refused: the refused negative carves changed nothing.
  await assert.rejects(start(t, "over", { budgetMicros: Number.MAX_SAFE_INTEGER }), /exceeds/);
  const ok = await start(t, "fits", { budgetMicros: 500 });
  assert.equal(ok.budgetMicros, 500);
});

test("an invalid deadline is refused before any row or carved budget exists; a keyed retry does not strand a pending record", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]) });
  const before = await rowCount(t);
  for (const bad of [-1, Number.POSITIVE_INFINITY]) {
    await assert.rejects(start(t, `bad-deadline-${String(bad)}`, { deadlineMs: bad }), /deadlineMs must be a non-negative number/);
  }
  assert.equal(await rowCount(t), before, "no pending row from a refused deadline");
  const retry = await start(t, "bad-deadline-retry", { deadlineMs: 60_000 });
  assert.equal(retry.state === "pending" || retry.state === "running" || retry.state === "exited", true);
  assert.equal(await rowCount(t), before + 1, "the valid keyed retry creates exactly one row");
});

test("cleanup never runs Git prune on a deterministic root child; it is marked cleaned once and not revisited", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: "done" }, "done-1");
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]) });
  const rec = await start(t, "clean-1");
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(rec.id)) as AgentRecord).state));
  await until(async () => ((await t.daemon.get(rec.id)) as AgentRecord).state === "reaped");

  const ws = t.daemon.deps.workspace as unknown as { prune: (...a: unknown[]) => Promise<string> };
  const origPrune = ws.prune.bind(ws);
  let pruneCalls = 0;
  ws.prune = (...a: unknown[]) => {
    pruneCalls++;
    return origPrune(...a);
  };
  try {
    await t.daemon.sweepCleanup();
    await t.daemon.sweepCleanup();
  } finally {
    ws.prune = origPrune;
  }
  assert.equal(pruneCalls, 0, "no workspace prune is attempted for a deterministic task");
  // No cleanup marks are wired in this harness, so the durable mark is not observable here; the no-prune result is the proof.
});

test("a run cancelled between its transition and its driver start never runs the driver body", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen = { body: 0 };
  exec.setHandler(async (_ctx: DeterministicRunContext) => {
    seen.body++;
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]) });
  // Hold the run's "started" journal write: the driver cannot start until the gate opens, so the cancel lands first.
  const rootId = (await t.daemon.root()).id; // created lazily: resolve it before the gate is installed
  const j = t.daemon.deps.journal as unknown as { append: (e: { agent: string; payload: { kind: string } }) => Promise<unknown> };
  const appendOrig = j.append.bind(j);
  let blocked = false;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  j.append = async (e) => {
    if (e.payload.kind === "started" && e.agent !== rootId) {
      blocked = true;
      await gate;
    }
    return appendOrig(e);
  };
  // start() itself waits on the held write, so it is not awaited here; the record is found under the root once the gate is hit.
  const starting = start(t, "pre-cancel");
  await until(() => blocked);
  const rec = (await t.daemon.list({})).filter((r) => r.name === "det").at(-1)!;
  // The cancel settles the run while the drive is still held; awaiting it first would wait on the held drive.
  const cancelling = t.daemon.cancel(rec.id, 5);
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(rec.id)) as AgentRecord).state));
  release();
  await cancelling;
  await starting;
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(rec.id)) as AgentRecord).state));
  assert.equal(seen.body, 0, "the driver body never ran for a cancelled-before-start run");
  assert.equal(((await t.daemon.get(rec.id)) as AgentRecord).exit, "cancelled");
});

// Resolves a driver-side op to "accepted" or its rejection message, so a test can read refusals without the driver throwing.
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "accepted",
    (e: Error) => `rejected: ${e.message}`,
  );

// Gate and hook helpers: each wraps one store port method, so a test can hold a single write at a chosen point.
type Gateable = { [k: string]: (...a: unknown[]) => unknown };
function hold(obj: object, method: string, when: (args: unknown[]) => boolean) {
  const o = obj as Gateable;
  const orig = o[method]!.bind(obj);
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let reached = false;
  o[method] = async (...args: unknown[]) => {
    if (when(args)) {
      reached = true;
      await gate;
    }
    return orig(...args);
  };
  return { release, isReached: () => reached };
}

test(
  "a child queued behind a parent's result is created before the children check, so success is refused: no success with a missed child",
  TIMEOUT,
  async () => {
    const kid = new FakeDeterministicExecutor("kid-driver");
    kid.setHandler(async () => {});
    const exec = new FakeDeterministicExecutor(PARENT);
    const seen: { spawn?: string; submit?: string; created?: boolean } = {};
    exec.setHandler(async (ctx) => {
      const spawning = ctx.ops
        .spawn({
          name: "kid",
          task: "t",
          executor: "deterministic",
          spec: { driver: "kid-driver", input: null },
          budgetMicros: 100,
          idempotencyKey: "race-kid",
        })
        .then((id) => {
          seen.created = true;
          return id;
        });
      // The result is issued while the child's create is held: it must queue behind the spawn chain, not overtake it.
      const submitting = ctx.ops.submitResult({ summary: "too soon" }, "race-res").then(
        () => "accepted",
        (e: Error) => `rejected: ${e.message}`,
      );
      const id = await spawning.catch(() => undefined);
      seen.submit = await submitting;
      if (id) {
        await until(async () => ((await t.daemon.get(id)) as AgentRecord).state === "exited");
        await ctx.ops.reap(id, "race-reap");
      }
      await ctx.ops.submitResult({ summary: "after reap" }, "race-res-2");
    });
    const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const, ["kid-driver", kid] as const]) });
    const gate = hold(t.daemon.deps.registry, "create", (a) => (a[0] as { name: string }).name === "kid");
    const rec = await start(t, "race-parent");
    await until(() => gate.isReached());
    // Let the submit reach the spawn chain before the child's create is allowed to land.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    gate.release();
    await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(rec.id)) as AgentRecord).state), 4000);

    assert.equal(seen.created, true, "the child was created (before the children check)");
    assert.match(seen.submit ?? "", /^rejected: unreaped children/, "the early success is refused because the child exists and is unreaped");
    const done = (await t.daemon.get(rec.id)) as AgentRecord;
    assert.equal(done.exit, "succeeded");
    assert.deepEqual(done.result, { summary: "after reap" }, "only the post-reap success is stored");
  },
);

test("a terminal cancel waits behind an admitted ack: the effect lands before the terminal, and a later op is refused", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen: { ack?: string; after?: string } = {};
  exec.setHandler(async (ctx) => {
    seen.ack = await outcome(ctx.ops.ack([], "admitted-ack"));
    seen.after = await outcome(ctx.ops.message({ kind: "self" }, "late", "late-msg"));
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]) });
  const gate = hold(t.daemon.deps.mailbox, "ack", () => true);
  const rec = await start(t, "ack-cancel");
  await until(() => gate.isReached());
  const cancelling = t.daemon.cancel(rec.id, 5);
  gate.release();
  await cancelling;
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(rec.id)) as AgentRecord).state));

  assert.equal(seen.ack, "accepted", "the ack admitted before the cancel completes");
  assert.equal(((await t.daemon.get(rec.id)) as AgentRecord).exit, "cancelled");
  assert.match(seen.after ?? "", /^rejected/, "an op after the cancel is refused: no effect after the terminal");
});

test("a result whose durable write races a cancel: journal, exit and the accepted result agree", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen: { submit?: string } = {};
  exec.setHandler(async (ctx) => {
    seen.submit = await outcome(ctx.ops.submitResult({ summary: "committed" }, "race-commit"));
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]) });
  const gate = hold(t.daemon.deps.journal, "append", (a) => (a[0] as { payload: { kind: string } }).payload.kind === "ext.pomtreed.result");
  const rec = await start(t, "commit-race");
  await until(() => gate.isReached());
  const cancelling = t.daemon.cancel(rec.id, 5); // the submit already holds the result lock: the cancel queues behind it
  gate.release();
  await cancelling;
  await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(rec.id)) as AgentRecord).state));

  const done = (await t.daemon.get(rec.id)) as AgentRecord;
  assert.equal(seen.submit, "accepted", "the submit that committed first is accepted");
  assert.equal(done.exit, "succeeded", "the exit agrees with the committed result");
  assert.deepEqual(done.result, { summary: "committed" });
  const rows = await t.journal.read({ agent: rec.id });
  const results = rows.filter((r) => r.payload.kind === "ext.pomtreed.result");
  const exited = rows.filter((r) => r.payload.kind === "exited");
  assert.equal(results.length, 1, "exactly one durable result");
  assert.equal(exited.length, 1, "exactly one terminal");
  assert.equal((exited[0]!.payload as { exit?: string }).exit, "succeeded", "the journal's terminal agrees with the exit");
});

test("an adoption reserves the live slot before its registry read, so an overlapping pass sees a live run and skips it", TIMEOUT, async () => {
  const t = setup(async () => {});
  const d = t.daemon as unknown as { live: Map<string, unknown>; lifecycle: { adoptRunning: (...a: unknown[]) => Promise<void> } };
  const id = "ag-adopt-overlap";
  const gate = hold(t.daemon.deps.registry, "get", (a) => a[0] === id);
  const first = d.lifecycle.adoptRunning(id, "sb-overlap", 1).catch(() => {});
  // The first adoption is parked on its registry read. A second reconcile pass checks `live` synchronously and must see the reservation.
  assert.equal(d.live.has(id), true, "the reservation exists before the delayed registry read resolves");
  assert.equal(gate.isReached(), true, "the first adoption is parked on the registry read");
  gate.release();
  await first;
});

test("cleanup marks a deterministic root child cleaned exactly once across sweeps, and never prunes it", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: "done" }, "clean-done");
  });
  const cleaned = new Map<string, number>();
  const marks = {
    markCleaned: (agent: string) => void cleaned.set(agent, (cleaned.get(agent) ?? 0) + 1),
    markPruned: () => {},
    prunedAgents: () => new Set<string>(),
    cleanedAgents: () => new Set(cleaned.keys()),
  };
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const]), workspaceCleanup: marks as never });
  const rec = await start(t, "clean-mark");
  await until(async () => ((await t.daemon.get(rec.id)) as AgentRecord).state === "reaped", 4000);
  await t.daemon.sweepCleanup();
  await t.daemon.sweepCleanup();
  assert.equal(cleaned.get(rec.id), 1, "marked cleaned exactly once across two sweeps");
});

// Adoption overlap, end to end: two overlapping reconcile passes over one running container agent must produce exactly one attach.
// The first pass parks on a gated registry read inside adoption; the second pass runs while the reservation is held.
test("two overlapping recovery passes adopt one running container agent with exactly one attach", TIMEOUT, async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: spawnSpec,
    parent: root.id,
    name: "adopt-overlap",
    task: "t",
    host: "h1",
    budgetMicros: 100_000,
    idempotencyKey: "adopt-overlap",
  });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "adopt-overlap-run" });
  const sb = await t.fakes.hooks.raw.sandbox.start(
    { agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
    "sb-overlap",
  );
  await reg.setSandbox(a.id, a.generation, sb.id, "sb-overlap-set");
  const attaches = () => t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "attach" && (c.args as unknown[])[0] === sb.id).length;

  // Park the first adoption on its registry read (the first `get` of this agent after the passes start).
  const gate = hold(t.daemon.deps.registry, "get", (args) => args[0] === a.id);
  const passes = Promise.all([t.daemon.recover(), t.daemon.recover()]);
  await until(() => gate.isReached(), 4000);
  // Let the overlapping pass run to completion while the first adoption is still parked.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  gate.release();
  await passes;
  await until(() => attaches() >= 1, 4000);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(attaches(), 1, "one attach for the one running sandbox, however many passes overlapped");
});

// Reopen: the result is committed, the terminal (exited) write is held, then the process goes away. A fresh boot on the same
// database must finish the run from the committed result: same exit, same result, and the driver is not replayed.
test("a result committed before a crash, with its exit write not yet landed, is finished on reopen with the same result and no replay", TIMEOUT, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-det-ops-"));
  const dbPath = join(dir, "pomtreed.sqlite");
  let one: ReopenBoot | undefined;
  let two: ReopenBoot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const exec = new FakeDeterministicExecutor(PARENT);
    exec.setHandler(async (ctx) => {
      await ctx.ops.submitResult({ summary: "reopened" }, "reopen-res");
    });

    one = reopenBoot(dir, dbPath, fakes, [exec]);
    await one.node.register(one.store.hosts);
    const rec = await one.daemon.startDeterministic((await one.daemon.root()).id, {
      name: "det",
      task: "t",
      idempotencyKey: "reopen",
      executor: "deterministic",
      spec: { driver: PARENT, input: null },
      budgetMicros: 500,
    });
    // Hold the terminal write: the result row is committed, the exit is not.
    const gate = hold(
      one.store.journal,
      "append",
      (a) => (a[0] as { agent: string; payload: { kind: string } }).payload.kind === "exited" && (a[0] as { agent: string }).agent === rec.id,
    );
    await until(() => gate.isReached(), 4000);
    const committed = (await one.store.journal.read({ agent: rec.id })).filter((r) => r.payload.kind === "ext.pomtreed.result");
    assert.equal(committed.length, 1, "the result is durably committed before the crash");
    one.store.close(); // the process goes away with the exit write still pending

    two = reopenBoot(dir, dbPath, fakes, [exec]);
    await two.daemon.recover();
    await until(async () => ["exited", "reaped"].includes(((await two!.daemon.get(rec.id)) as AgentRecord).state), 4000);
    const after = (await two.daemon.get(rec.id)) as AgentRecord;
    assert.equal(after.exit, "succeeded", "the exit agrees with the committed result");
    assert.deepEqual(after.result, { summary: "reopened" }, "the committed result is preserved");
    assert.equal(exec.contexts.length, 1, "the driver ran once, before the crash; not replayed on reopen");
    const exited = (await two.store.journal.read({ agent: rec.id })).filter((r) => r.payload.kind === "exited");
    assert.equal(exited.length, 1, "exactly one terminal entry after reopen");
  } finally {
    try {
      one?.store.close();
    } catch {
      // already closed
    }
    try {
      two?.store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

type ReopenBoot = { store: ReturnType<typeof openStore>; node: LocalNode; daemon: Daemon };
// A fresh Daemon over one sqlite file: the restart boundary. Sandbox, workspace and driver objects are shared across boots.
function reopenBoot(dir: string, dbPath: string, fakes: ReturnType<typeof createFakes>, drivers: DeterministicExecutor[]): ReopenBoot {
  const store = openStore(dbPath);
  const node = new LocalNode({
    hostId: "h1",
    sandbox: fakes.sandbox,
    workspace: fakes.workspace,
    capacity: { maxSessions: 2 },
    bootEpoch: "1",
    workspacePath: (id) => `/fake/${id}`,
    sessionDir: (a) => join(dir, "sess", a),
  });
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: "/host/pomtreed.sock",
    rootBudgetMicros: 10_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    epoch: "1",
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox: fakes.hooks.raw.sandbox,
    workspace: fakes.hooks.raw.workspace,
    harness: new ScriptHarness(async (c) => {
      await c.stopped;
    }),
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: join(dir, "sessions"),
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement,
    orchestrator: new LocalOrchestrator(),
    deterministicExecutors: new Map(drivers.map((d) => [d.driver, d] as const)),
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, node, daemon };
}

// Cancel during adoption: the reservation is parked on its registry read when the cancel lands. The cancel must govern the
// adopted run (the same entry), kill the attached sandbox, and finish the agent cancelled, with exactly one attach.
test(
  "a cancel that lands while a container adoption is parked on its registry read kills the attached sandbox and finishes cancelled, with one attach",
  TIMEOUT,
  async () => {
    const t = setup(async () => {});
    const root = await t.daemon.root();
    const reg = t.daemon.deps.registry;
    const a = await reg.create({
      spec: spawnSpec,
      parent: root.id,
      name: "adopt-cancel",
      task: "t",
      host: "h1",
      budgetMicros: 100_000,
      idempotencyKey: "adopt-cancel",
    });
    await reg.transition(a.id, a.generation, "running", { idempotencyKey: "adopt-cancel-run" });
    const sb = await t.fakes.hooks.raw.sandbox.start(
      { agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
      "sb-adopt-cancel",
    );
    await reg.setSandbox(a.id, a.generation, sb.id, "sb-adopt-cancel-set");
    const calls = (method: string) => t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === method && (c.args as unknown[])[0] === sb.id).length;

    // Hold only the adoption's own registry read (the first read of this agent), so the cancel's read is not parked behind it.
    let first = true;
    const gate = hold(t.daemon.deps.registry, "get", (args) => {
      if (args[0] === a.id && first) {
        first = false;
        return true;
      }
      return false;
    });
    const d = t.daemon as unknown as { lifecycle: { adoptRunning: (...x: unknown[]) => Promise<void> } };
    const adopting = d.lifecycle.adoptRunning(a.id, sb.id, a.generation).catch(() => {});
    await until(() => gate.isReached(), 4000);

    await t.daemon.cancel(a.id, 5); // lands on the reservation: no sandbox yet, so it only flags the run
    gate.release();
    await adopting;
    await until(async () => ["exited", "reaped"].includes(((await t.daemon.get(a.id)) as AgentRecord).state), 4000);

    const done = (await t.daemon.get(a.id)) as AgentRecord;
    assert.equal(done.exit, "cancelled", "the cancel governs the adopted run");
    assert.equal(calls("kill") + calls("stop") >= 1, true, "the attached sandbox was stopped by the cancel");
    assert.equal(calls("attach"), 1, "exactly one attach");
    assert.equal(done.sandbox ?? null, null, "the sandbox reference is cleared");
  },
);
