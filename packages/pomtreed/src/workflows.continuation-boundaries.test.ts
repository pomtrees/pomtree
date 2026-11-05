import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue, WorkflowDef, WorkflowRunContext } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { createFakes, ScriptHarness } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { get, scratch, SECRET, until } from "./test-setup.ts";
import { STATE_KIND, type WorkflowCapabilityServices } from "./workflow-capabilities.ts";
import { EXPIRED, raceUntil, WorkflowHost } from "./workflows.ts";

// Offline durability-boundary tests over a real SQLite file for a reviewed continuation workflow. The crash points are not
// process kills: each boundary is reached through the public registry transitions and generation bumps (the same calls the
// production resume path makes), and the boot that follows is a fresh Daemon on the same database. Independent harness.

const EXT = "contb";
const PARK = `${EXT}/park`;
const KID = `${EXT}/kid`;
const KEY = "kid-a";
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 15_000 };
const forever = () => new Promise<void>(() => {});

type Fakes = ReturnType<typeof createFakes>;
type Boot = { store: ReturnType<typeof openStore>; daemon: Daemon; host: WorkflowHost };

// One boot: a fresh daemon over the same store. The child driver is a committed, qualified workflow definition (not a foreign map).
function boot(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], services?: () => WorkflowCapabilityServices | undefined): Boot {
  const store = openStore(dbPath);
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const harness = new ScriptHarness(async (c) => {
    await c.stopped;
  });
  let daemon!: Daemon;
  const host = new WorkflowHost({
    registry: () => store.registry,
    reviewed: (o) => o === EXT,
    startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
    services,
  });
  host.commit(EXT, defs);
  daemon = new Daemon({
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
    approvals: store.approvals,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement,
    orchestrator: new LocalOrchestrator(),
    deterministicExecutors: host.executors,
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, daemon, host };
}

async function up(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], services?: () => WorkflowCapabilityServices | undefined): Promise<Boot> {
  const b = boot(dir, dbPath, fakes, defs, services);
  await new LocalNode({
    hostId: "h1",
    sandbox: fakes.sandbox,
    workspace: fakes.workspace,
    capacity: { maxSessions: 2 },
    bootEpoch: "1",
    workspacePath: (id) => `/fake/${id}`,
    sessionDir: (a) => join(dir, "sess", a),
  }).register(b.store.hosts);
  return b;
}

const rootId = async (b: { daemon: Daemon }) => (await b.daemon.root()).id;
const closeQuietly = (b: Boot | undefined) => {
  try {
    b?.store.close();
  } catch {
    // already closed by the test
  }
};

const kidDef: WorkflowDef = { name: "kid", validate: (input) => ({ ok: true, value: input }), run: () => forever() };
const waitFor = (child: string) => ({ kind: "child_exited" as const, children: [child], mode: "all" as const });
const startReq = (key: string) => ({ workflow: PARK, name: "w", task: "park", idempotencyKey: key, input: { run: 1 }, budgetMicros: 5000 });
const kidReq = { name: `kid-${KEY}`, task: "t", idempotencyKey: KEY, executor: "deterministic" as const, spec: { driver: KID, input: {} }, budgetMicros: 100 };

interface Seen {
  runs: { agent: string; generation: number; phase: number }[];
  spawned: string[];
  childState?: string;
  caught?: boolean;
}

// Phase 0 spawns the keyed child and parks on it.
// Phase 1 reaps the child and completes. With `gate`, the body catches the suspend sentinel and holds the body open until released.
function park(seen: Seen, gate?: Promise<void>): WorkflowDef {
  return {
    name: "park",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as { phase: number; child?: string };
      seen.runs.push({ agent: ctx.agent, generation: ctx.generation, phase: st.phase });
      if (st.phase === 0) {
        const child = await ctx.ops.spawn(kidReq);
        seen.spawned.push(child);
        const state = { phase: 1, child };
        if (gate === undefined) {
          await ctx.ops.suspend(state, waitFor(child), "park");
          return;
        }
        try {
          await ctx.ops.suspend(state, waitFor(child), "park");
        } catch {
          seen.caught = true;
          await gate;
        }
        return;
      }
      const c = await ctx.ops.findChild(KEY);
      seen.childState = c?.state;
      await ctx.ops.reap(c!.id, "reap-kid");
      await ctx.ops.submitResult({ summary: "done", child: c!.id }, "done");
    },
  };
}

// Registry-only steps: the same legal edges and keyed bumps production uses, applied through a live store handle.
async function setChild(store: Boot["store"], id: string, to: "yielded" | "exited", key: string) {
  const r = (await store.registry.get(id))!;
  await store.registry.transition(id, r.generation, to, { ...(to === "exited" ? { exit: "succeeded" as const } : {}), idempotencyKey: key });
}

test("a running same-generation snapshot recovers to yielded with the same task id and runs no downstream until the child is terminal", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-contb-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], spawned: [] };
    // The body never returns after the snapshot: the snapshot is journaled at gen 0 and the yielded edge is never committed.
    one = await up(dir, dbPath, fakes, [park(seen, forever()), kidDef]);
    const rec = await one.host.start(await rootId(one), startReq("boundary-1"));
    await until(() => seen.caught === true);
    assert.equal((await get(one, rec.id)).state, "running", "crash shape: running with a same-generation snapshot");
    const kid = seen.spawned[0]!;
    // The child is non-terminal (parked) when the process dies.
    await setChild(one.store, kid, "yielded", `test:${kid}:parked`);
    one.store.close();

    two = await up(dir, dbPath, fakes, [park(seen), kidDef]);
    await two.daemon.recover();
    const parked = await get(two, rec.id);
    assert.equal(parked.id, rec.id, "same task id");
    assert.equal(parked.state, "yielded");
    assert.equal(parked.generation, 0, "no bump: the snapshot generation is still current");
    assert.equal(parked.host, "h1", "custody stays on this host");
    assert.equal(seen.runs.length, 1, "no downstream run while the child is non-terminal");

    await setChild(two.store, kid, "exited", `test:${kid}:exited`);
    await two.daemon.recover();
    await until(async () => (await get(two!, rec.id)).state === "exited", 10_000);
    assert.deepEqual(
      seen.runs.map((r) => [r.agent, r.generation, r.phase]),
      [
        [rec.id, 0, 0],
        [rec.id, 1, 1],
      ],
    );
    assert.equal(seen.childState, "exited", "the wake resumed only after the child was terminal");
    assert.equal((await get(two, rec.id)).exit, "succeeded");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash after the resume generation bump (before yielded to running) recovers on the same id at gen 1 without a second bump", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-contb-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], spawned: [] };
    one = await up(dir, dbPath, fakes, [park(seen), kidDef]);
    const rec = await one.host.start(await rootId(one), startReq("boundary-2"));
    await until(async () => (await get(one!, rec.id)).state === "yielded");
    const kid = seen.spawned[0]!;
    await setChild(one.store, kid, "exited", `test:${kid}:exited`);
    // The resume's keyed bump landed at snapshot generation 0; the yielded -> running transition did not.
    const bumped = await one.store.registry.bumpGeneration(rec.id, "h1", `${rec.id}:0:workflow-resume`);
    assert.equal(bumped.generation, 1);
    one.store.close();

    two = await up(dir, dbPath, fakes, [park(seen), kidDef]);
    await two.daemon.recover();
    await until(async () => (await get(two!, rec.id)).state === "exited", 10_000);
    assert.deepEqual(
      seen.runs.map((r) => [r.agent, r.generation]),
      [
        [rec.id, 0],
        [rec.id, 1],
      ],
      "the replayed resume runs generation 1 exactly once",
    );
    assert.equal((await get(two, rec.id)).generation, 1, "the keyed bump returned the original generation: no gen 2");
    assert.equal(seen.childState, "exited");
    assert.equal((await two.daemon.list({ parent: rec.id })).length, 1, "no second spawn");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running gen-1 row with an older gen-0 snapshot is fenced to gen 2 with a fresh key and reuses the terminal keyed child", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-contb-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], spawned: [] };
    one = await up(dir, dbPath, fakes, [park(seen), kidDef]);
    const rec = await one.host.start(await rootId(one), startReq("boundary-3"));
    await until(async () => (await get(one!, rec.id)).state === "yielded");
    const kid = seen.spawned[0]!;
    await setChild(one.store, kid, "exited", `test:${kid}:exited`);
    // Resume reached running at gen 1 but no newer snapshot was journaled: the snapshot stays at gen 0.
    await one.store.registry.bumpGeneration(rec.id, "h1", `${rec.id}:0:workflow-resume`);
    await one.store.registry.transition(rec.id, 1, "running", { idempotencyKey: `test:${rec.id}:running1` });
    one.store.close();

    two = await up(dir, dbPath, fakes, [park(seen), kidDef]);
    await two.daemon.recover();
    await until(async () => (await get(two!, rec.id)).state === "exited", 10_000);
    assert.deepEqual(
      seen.runs.map((r) => [r.generation, r.phase]),
      [
        [0, 0],
        [2, 1],
      ],
      "gen 2 resumes from the journaled snapshot (phase 1) at a fresh generation",
    );
    assert.equal(seen.childState, "exited", "findChild discovers the terminal keyed child");
    assert.equal(seen.spawned.length, 1, "no new spawn on the fenced resume");
    assert.equal((await two.daemon.list({ parent: rec.id })).length, 1);
    assert.equal((await get(two, rec.id)).exit, "succeeded");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a driver that catches the suspend sentinel keeps the row running at gen 0 until its body is released, then parks", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-contb-");
  let one: Boot | undefined;
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: Seen = { runs: [], spawned: [] };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [park(seen, gate), kidDef]);
    const rec = await one.host.start(await rootId(one), startReq("boundary-4"));
    await until(() => seen.caught === true);
    assert.equal((await get(one, rec.id)).state, "running", "the body is still open: no yielded edge yet");
    assert.equal((await get(one, rec.id)).generation, 0);
    // Reconcile over a live run must not fence it or start a new generation while the body is held.
    await one.daemon.recover();
    assert.equal((await get(one, rec.id)).generation, 0, "no new generation until the body is released");
    assert.equal(seen.runs.length, 1);

    release();
    await until(async () => (await get(one!, rec.id)).state === "yielded", 10_000);
    const parked = await get(one, rec.id);
    assert.equal(parked.generation, 0, "parking after release keeps the snapshot generation");
    assert.equal(seen.runs.length, 1, "no downstream run: the child is still non-terminal");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Root services over a live boot, as the capability layer consumes them: the state effect writes the root journal through
// recordRoot. `gate` holds the first state write open (the service effect), and `entered` reports that it has started.
function rootServices(b: Boot, gate?: Promise<void>, entered?: () => void): WorkflowCapabilityServices {
  return {
    redactText: (text: string) => text,
    root: () => b.daemon.root(),
    agent: (id: string) => b.daemon.get(id),
    readRoot: async (from: number, limit: number) => b.store.journal.read({ agent: (await b.daemon.root()).id, from, limit }),
    recordRoot: async (payload: import("@pomtree/core").ExtensionJournalPayload, key: string) => {
      if (payload.kind === STATE_KIND && gate) {
        entered?.();
        await gate;
      }
      const root = await b.daemon.root();
      return b.store.journal.append({ agent: root.id, host: root.host, generation: root.generation, payload, idempotencyKey: key });
    },
    now: () => b.daemon.now(),
  } as unknown as WorkflowCapabilityServices;
}

// Capability effect not awaited by the handler: the snapshot is written and the body suspends while the root service effect is
// still held open. The host must not park (yield) nor start a new generation until that effect settles.
test(
  "a detached state effect held open by the root service settles before the snapshot yields; the timer resumes gen 1 only after release",
  TIMEOUT,
  async () => {
    const { dir, dbPath } = scratch("pomtreed-contb-");
    let one: Boot | undefined;
    try {
      const seen: { runs: { generation: number; phase: number }[]; entered: boolean; effectError?: string } = { runs: [], entered: false };
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const held: WorkflowDef = {
        name: "held",
        continuation: true,
        capabilities: { state: true },
        validate: (input) => ({ ok: true, value: input }),
        async run(ctx: WorkflowRunContext & { input: JsonValue }) {
          const st = (ctx.continuation ?? { phase: 0 }) as { phase: number };
          seen.runs.push({ generation: ctx.generation, phase: st.phase });
          if (st.phase === 0) {
            void ctx.workflow.setState({ ticked: true }, "tick").catch((e: unknown) => {
              seen.effectError = String(e);
            });
            await ctx.ops.suspend({ phase: 1 }, { kind: "timer", at: Date.now() + 30 }, "tick");
            return;
          }
          await ctx.ops.submitResult({ summary: "ticked" }, "done");
        },
      };
      // The services are read per effect, so they bind to this boot once it exists (no effect runs before start).
      let cur: Boot | undefined;
      one = await up(dir, dbPath, createFakes({ host: "h1" }), [held], () => (cur ? rootServices(cur, gate, () => (seen.entered = true)) : undefined));
      cur = one;
      const rec = await cur.host.start(await rootId(cur), { ...startReq("boundary-5"), workflow: `${EXT}/held`, input: { instance: "i1" } });
      await until(() => seen.entered, 5_000);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await get(cur, rec.id)).state, "running", "the effect is open: no yielded edge");
      assert.equal((await get(cur, rec.id)).generation, 0, "no new generation while the effect is held");
      assert.deepEqual(seen.runs, [{ generation: 0, phase: 0 }], "the timer did not wake a second body");

      release();
      await until(async () => TERMINAL.includes((await get(cur, rec.id)).state), 10_000);
      assert.deepEqual(seen.runs, [
        { generation: 0, phase: 0 },
        { generation: 1, phase: 1 },
      ]);
      assert.equal(seen.effectError, undefined, "the detached effect succeeded");
      assert.equal((await get(cur, rec.id)).exit, "succeeded");
    } finally {
      closeQuietly(one);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Hard deadline over a held detached state effect: the body has suspended and unwound, but the effect keeps the continuation barrier
// pending. The session deadline must still settle the task `timed_out` before any release, and no continuation generation may start.
test(
  "a held state effect after suspend cannot defeat the hard deadline: the task times out before the effect is released and gen 1 never starts",
  TIMEOUT,
  async () => {
    const { dir, dbPath } = scratch("pomtreed-contb-");
    let one: Boot | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let released = false;
    const free = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      const seen: { runs: { generation: number; phase: number }[]; entered: boolean } = { runs: [], entered: false };
      const held: WorkflowDef = {
        name: "held",
        continuation: true,
        capabilities: { state: true },
        validate: (input) => ({ ok: true, value: input }),
        async run(ctx: WorkflowRunContext & { input: JsonValue }) {
          const st = (ctx.continuation ?? { phase: 0 }) as { phase: number };
          seen.runs.push({ generation: ctx.generation, phase: st.phase });
          if (st.phase === 0) {
            void ctx.workflow.setState({ ticked: true }, "tick").catch(() => {});
            await ctx.ops.suspend({ phase: 1 }, { kind: "timer", at: Date.now() + 30 }, "tick");
            return;
          }
          await ctx.ops.submitResult({ summary: "ticked" }, "done");
        },
      };
      let cur: Boot | undefined;
      one = await up(dir, dbPath, createFakes({ host: "h1" }), [held], () => (cur ? rootServices(cur, gate, () => (seen.entered = true)) : undefined));
      cur = one;
      const rec = await cur.host.start(await rootId(cur), { ...startReq("boundary-7"), workflow: `${EXT}/held`, input: { instance: "i2" }, deadlineMs: 300 });
      await until(() => seen.entered, 5_000);
      // The 300ms deadline expires while the effect is held open. The task must reach a terminal state without any release.
      await until(async () => TERMINAL.includes((await get(cur!, rec.id)).state), 5_000);
      assert.equal((await get(cur, rec.id)).exit, "timed_out", "the hard deadline settles the blocked task timed_out before release");
      assert.deepEqual(seen.runs, [{ generation: 0, phase: 0 }], "no continuation generation starts while the effect is held");

      // The effect is still tracked: idle must not report settled, and drain must not declare the owner clear.
      const idleSettled = await raceUntil(
        cur.host.idle().then(() => true),
        Date.now() + 100,
      );
      assert.equal(idleSettled, EXPIRED, "a held late effect keeps the host busy");
      const drainDeadline = Date.now() + 300;
      const drained = await cur.host.drain({
        deadlineAt: drainDeadline,
        now: () => Date.now(),
        cancel: (id, graceMs) => cur!.daemon.cancel(id, graceMs).then(() => {}),
        tick: () => sleep(10),
        race: (p) => raceUntil(p, drainDeadline),
      });
      assert.equal(drained.complete, false, JSON.stringify(drained));
      assert.ok(drained.retained.includes(EXT), "the late effect retains its owner until release");

      // Release: the join completes, idle finishes, and still no continuation generation ever starts.
      free();
      assert.equal(
        await raceUntil(
          cur.host.idle().then(() => true),
          Date.now() + 5_000,
        ),
        true,
        "idle after release",
      );
      await sleep(100);
      assert.deepEqual(seen.runs, [{ generation: 0, phase: 0 }], "no continuation after release either");
      assert.equal((await get(cur, rec.id)).generation, 0);
    } finally {
      // Release and join the held effect before the store closes, even when an assertion above failed.
      free();
      if (one) await one.host.idle();
      closeQuietly(one);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// Duplicate wakes for one parked message wait: two racing wakeResume calls for the same signal must start exactly one body.
test("two racing wakeResume calls for one signal start exactly one generation of a parked message wait", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-contb-");
  let one: Boot | undefined;
  try {
    const seen: { runs: { generation: number; phase: number }[] } = { runs: [] };
    const waiter: WorkflowDef = {
      name: "waiter",
      continuation: true,
      validate: (input) => ({ ok: true, value: input }),
      async run(ctx: WorkflowRunContext & { input: JsonValue }) {
        const st = (ctx.continuation ?? { phase: 0 }) as { phase: number };
        seen.runs.push({ generation: ctx.generation, phase: st.phase });
        if (st.phase === 0) {
          await ctx.ops.suspend({ phase: 1 }, { kind: "message" }, "wait");
          return;
        }
        await ctx.ops.submitResult({ summary: "woke" }, "done");
      },
    };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [waiter]);
    const root = await one.daemon.root();
    const rec = await one.host.start(root.id, { ...startReq("boundary-6"), workflow: `${EXT}/waiter` });
    await until(async () => (await get(one!, rec.id)).state === "yielded", 5_000);
    const sig = await one.daemon.sendMessage(root.id, rec.id, "wake", root.generation, "msg-1");
    await Promise.all([one.daemon.wakeResume(rec.id, sig), one.daemon.wakeResume(rec.id, sig)]);
    await until(async () => TERMINAL.includes((await get(one!, rec.id)).state), 10_000);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(
      seen.runs,
      [
        { generation: 0, phase: 0 },
        { generation: 1, phase: 1 },
      ],
      "exactly one resumed generation",
    );
    assert.equal((await get(one, rec.id)).generation, 1);
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Spawns the keyed child and messages it; the first run then hangs (the crash window after the send), the replay completes.
function messenger(seen: Seen): WorkflowDef {
  return {
    name: "park",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as { phase: number; child?: string };
      seen.runs.push({ agent: ctx.agent, generation: ctx.generation, phase: st.phase });
      const child = await ctx.ops.spawn(kidReq);
      seen.spawned.push(child);
      await ctx.ops.message({ kind: "child", child }, "hello", "msg-1");
      if (seen.runs.length === 1) return forever();
      await ctx.ops.submitResult({ summary: "replayed", child }, "done");
    },
  };
}

test("a crash after a workflow message send replays the segment in a new generation without re-sending", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-contb-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], spawned: [] };
    one = await up(dir, dbPath, fakes, [messenger(seen), kidDef]);
    const rec = await one.host.start(await rootId(one), startReq("boundary-msg"));
    await until(async () => seen.runs.length === 1 && (await one!.store.mailbox.peek(seen.spawned[0] ?? "")).length === 1);
    one.store.close();

    two = await up(dir, dbPath, fakes, [messenger(seen), kidDef]);
    await two.daemon.recover();
    await until(async () => TERMINAL.includes((await get(two!, rec.id)).state), 10_000);
    assert.ok(seen.runs[1] && seen.runs[1].generation > seen.runs[0]!.generation, "the segment replayed at a newer generation");
    const kid = seen.spawned[0]!;
    assert.equal(seen.spawned.at(-1), kid, "the keyed child is reused");
    assert.equal((await two.store.mailbox.peek(kid)).filter((s) => s.kind === "message").length, 1, "the replayed send is idempotent");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});
