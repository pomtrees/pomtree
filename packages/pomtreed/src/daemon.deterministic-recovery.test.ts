import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, DeterministicExecutor, Handoff } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { createFakes, FakeDeterministicExecutor, ScriptHarness } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { get, scratch, SECRET, until } from "./test-setup.ts";

// Offline restart acceptance tests over a real SQLite file. Each "boot" is a fresh Daemon on the same database; the
// sandbox, workspace and driver objects outlive it, like containers and folders and code do. Every path the test
// creates (database, sessions) lives under one scratch dir that the test removes in its finally.

const PARENT = "fake-parent";
const CHILD = "fake-child";
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 15_000 };
const forever = () => new Promise<void>(() => {}); // a driver that never returns; the test ends it by restart

type Fakes = ReturnType<typeof createFakes>;
type Boot = { store: ReturnType<typeof openStore>; node: LocalNode; daemon: Daemon; orchestrator: LocalOrchestrator };

function boot(dir: string, dbPath: string, fakes: Fakes, drivers: DeterministicExecutor[]): Boot {
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
  const orchestrator = new LocalOrchestrator();
  const harness = new ScriptHarness(async (c) => {
    await c.stopped;
  });
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
    harness,
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
    orchestrator,
    deterministicExecutors: new Map(drivers.map((d) => [d.driver, d] as const)),
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, node, daemon, orchestrator };
}

// Opens a boot and registers its node. The caller keeps the handle so finally can close it even when an assertion fails.
async function up(dir: string, dbPath: string, fakes: Fakes, drivers: DeterministicExecutor[]): Promise<Boot> {
  const b = boot(dir, dbPath, fakes, drivers);
  await b.node.register(b.store.hosts);
  return b;
}

// One scratch dir per test: holds the sqlite file and every session path. Removed in finally.
const req = (key: string, driver = PARENT, budgetMicros = 500) => ({
  name: "det",
  task: "t",
  idempotencyKey: key,
  executor: "deterministic" as const,
  spec: { driver, input: { n: 1 } },
  budgetMicros,
});
const settled = async (b: { daemon: Daemon }, id: string) => TERMINAL.includes((await get(b, id)).state);
const rootId = async (b: { daemon: Daemon }) => (await b.daemon.root()).id;
const closeQuietly = (b: Boot | undefined) => {
  try {
    b?.store.close();
  } catch {
    // already closed by the test
  }
};

test("an unfinished deterministic task fails on restart without replay, and its children are not left running", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-det-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const parent = new FakeDeterministicExecutor(PARENT);
    const kid = new FakeDeterministicExecutor(CHILD);
    kid.setHandler(forever);
    const seen: { child?: string } = {};
    parent.setHandler(async (ctx) => {
      seen.child = await ctx.ops.spawn({
        name: "kid",
        task: "t",
        executor: "deterministic",
        spec: { driver: CHILD, input: null },
        budgetMicros: 100,
        idempotencyKey: "kid-1",
      });
      await forever();
    });

    one = await up(dir, dbPath, fakes, [parent, kid]);
    const rec = await one.daemon.startDeterministic(await rootId(one), req("unfinished"));
    await until(() => seen.child !== undefined && parent.contexts.length === 1);
    await until(async () => (await get(one!, seen.child!)).state === "running");
    closeQuietly(one);

    two = await up(dir, dbPath, fakes, [parent, kid]);
    await two.daemon.recover();
    await until(() => settled(two!, rec.id));

    const parentAfter = await get(two, rec.id);
    assert.equal(parentAfter.exit, "failed", "the interrupted task fails explicitly");
    assert.equal(parent.contexts.length, 1, "the driver is never replayed");
    assert.equal(kid.contexts.length, 1, "the child driver is never replayed");
    const childAfter = await get(two, seen.child!);
    assert.ok(!["pending", "running", "yielded"].includes(childAfter.state), "the child is not left running");
    assert.equal(childAfter.parent, rec.id);
    // Keyed start after the restart returns the same, now failed, record.
    const again = await two.daemon.startDeterministic(await rootId(two), req("unfinished"));
    assert.equal(again.id, rec.id);
    assert.equal(parent.contexts.length, 1, "the keyed retry does not run the driver again");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a result submitted before the restart is durable and preserved; the interrupted run is not replayed", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-det-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const parent = new FakeDeterministicExecutor(PARENT);
    const seen = { submitted: false };
    parent.setHandler(async (ctx) => {
      await ctx.ops.submitResult({ summary: "kept", n: 7 } as Handoff, "keep-1");
      seen.submitted = true;
      await forever();
    });

    one = await up(dir, dbPath, fakes, [parent]);
    const rec = await one.daemon.startDeterministic(await rootId(one), req("durable"));
    await until(() => seen.submitted);
    closeQuietly(one);

    two = await up(dir, dbPath, fakes, [parent]);
    await two.daemon.recover();
    await until(() => settled(two!, rec.id));
    const after = await get(two, rec.id);
    assert.deepEqual(after.result, { summary: "kept", n: 7 }, "the durable submitted result is preserved");
    assert.equal(after.exit, "succeeded", "a reported result finishes with the reported status");
    assert.equal(parent.contexts.length, 1, "the run is not replayed");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effects completed before the restart are not duplicated: child, reap and result stay single after recovery", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-det-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const parent = new FakeDeterministicExecutor(PARENT);
    const kid = new FakeDeterministicExecutor(CHILD);
    kid.setHandler(async (ctx) => {
      await ctx.ops.submitResult({ summary: "child" }, "kid-res");
    });
    const seen: { child?: string } = {};
    let live!: Daemon; // the boot this run belongs to; set before the driver can run
    parent.setHandler(async (ctx) => {
      seen.child = await ctx.ops.spawn({
        name: "kid",
        task: "t",
        executor: "deterministic",
        spec: { driver: CHILD, input: null },
        budgetMicros: 100,
        idempotencyKey: "kid-1",
      });
      await until(async () => ((await live.get(seen.child!)) as AgentRecord).state === "exited");
      await ctx.ops.reap(seen.child!, "reap-1");
      await ctx.ops.submitResult({ summary: "done" }, "done-1");
    });

    one = await up(dir, dbPath, fakes, [parent, kid]);
    live = one.daemon;
    const rec = await one.daemon.startDeterministic(await rootId(one), req("complete"));
    await until(() => settled(one!, rec.id));
    const childId = seen.child!;
    closeQuietly(one);

    two = await up(dir, dbPath, fakes, [parent, kid]);
    await two.daemon.recover();
    const after = await get(two, rec.id);
    assert.equal(after.exit, "succeeded");
    assert.deepEqual(after.result, { summary: "done" });
    assert.equal(parent.contexts.length, 1, "the parent driver ran once");
    assert.equal(kid.contexts.length, 1, "the child driver ran once");
    assert.equal((await get(two, childId)).state, "reaped");
    assert.equal((await two.daemon.list({ parent: rec.id })).length, 1, "no second child was created");
    const again = await two.daemon.startDeterministic(await rootId(two), req("complete"));
    assert.equal(again.id, rec.id, "a keyed start after completion returns the same record");
    assert.equal(parent.contexts.length, 1);
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});
