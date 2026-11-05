import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DeterministicExecutor, DeterministicRunContext, JsonValue, WorkflowDef, WorkflowRunContext } from "@pomtree/core";
import { isJsonValue } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { createFakes, FakeDeterministicExecutor, ScriptHarness } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { get, scratch, SECRET, until } from "./test-setup.ts";
import { WorkflowHost } from "./workflows.ts";

// Offline runtime tests for a reviewed WorkflowDef with `continuation: true`, over a real SQLite file. A workflow parks itself
// with ops.suspend(state, wait, key) and resumes on the same task id at generation + 1 with the snapshot as ctx.continuation.
// Each "boot" is a fresh Daemon on the same database; child drivers and the sandbox outlive it. Everything is under one
// scratch dir removed in finally.

const EXT = "cont";
const WF = `${EXT}/staged`;
const APPROVAL = `${EXT}/approval`;
const KID = "cont/kid";
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 15_000 };
const forever = () => new Promise<void>(() => {});

type Fakes = ReturnType<typeof createFakes>;
type Boot = { store: ReturnType<typeof openStore>; daemon: Daemon; host: WorkflowHost };

// One boot: a fresh daemon over the same store. The workflow host is rebuilt per boot, as at process start; its committed
// definitions are the reviewed ones passed in.
function boot(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], kids: DeterministicExecutor[]): Boot {
  const store = openStore(dbPath);
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const orchestrator = new LocalOrchestrator();
  const harness = new ScriptHarness(async (c) => {
    await c.stopped;
  });
  let daemon!: Daemon;
  const host = new WorkflowHost({
    registry: () => store.registry,
    reviewed: (o) => o === EXT,
    startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
    services: () => ({
      root: () => daemon.root(),
      agent: (id) => daemon.get(id),
      now: () => daemon.now(),
      redactText: (text) => text,
      readRoot: async (from, limit) => store.journal.read({ agent: (await daemon.root()).id, from, limit }),
      recordRoot: async (payload, key) => {
        const root = await daemon.root();
        return store.journal.append({ agent: root.id, host: root.host, generation: root.generation, payload, idempotencyKey: key });
      },
      publishRoot: async () => {
        throw new Error("unused");
      },
      sendToUser: async () => {
        throw new Error("unused");
      },
      ask: async () => {
        throw new Error("unused");
      },
    }),
  });
  host.commit(EXT, [
    ...defs,
    ...kids.map((k): WorkflowDef => ({ name: k.driver.split("/")[1]!, validate: (input) => ({ ok: true, value: input }), run: (ctx) => k.run(ctx) })),
  ]);
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
    orchestrator,
    deterministicExecutors: host.executors,
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, daemon, host };
}

async function up(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], kids: DeterministicExecutor[]): Promise<Boot> {
  const b = boot(dir, dbPath, fakes, defs, kids);
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
const settled = async (b: { daemon: Daemon }, id: string) => TERMINAL.includes((await get(b, id)).state);
const closeQuietly = (b: Boot | undefined) => {
  try {
    b?.store.close();
  } catch {
    // already closed by the test
  }
};

// Child spawn request for the staged workflow. Keys are fixed so a replayed spawn must return the same child.
const kid = (name: string) => ({
  name: `kid-${name}`,
  task: "t",
  idempotencyKey: `kid-${name}`,
  executor: "deterministic" as const,
  spec: { driver: KID, input: { n: name } },
  budgetMicros: 100,
});

type Phase = { phase: number; children?: string[]; reaped?: string[] };
interface Seen {
  runs: { agent: string; generation: number; continuation: JsonValue | undefined }[];
  stale?: DeterministicRunContext["ops"];
  beforeC?: string[];
  receipts?: string[];
  completeResults?: JsonValue[];
}

// Three stages: spawn a and b, park until both exit; reap them; spawn c, park until it exits; reap c and complete.
function staged(seen: Seen): WorkflowDef {
  return {
    name: "staged",
    continuation: true,
    capabilities: { state: true },
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as Phase;
      seen.runs.push({ agent: ctx.agent, generation: ctx.generation, continuation: ctx.continuation });
      if (st.phase === 0) {
        seen.stale = ctx.ops;
        const a = await ctx.ops.spawn(kid("a"));
        const b = await ctx.ops.spawn(kid("b"));
        await ctx.ops.suspend({ phase: 1, children: [a, b] }, { kind: "child_exited", children: [a, b], mode: "all" }, "park-1");
        return;
      }
      if (st.phase === 1) {
        const states: string[] = [];
        for (const key of ["kid-a", "kid-b"]) states.push((await ctx.ops.findChild(key))?.state ?? "missing");
        seen.beforeC = states;
        const reaped: string[] = [];
        const validated: JsonValue[] = [];
        for (const [i, key] of ["kid-a", "kid-b"].entries()) {
          const rec = await ctx.ops.findChild(key);
          const r = await ctx.ops.reap(rec!.id, `reap-${i}`);
          reaped.push(`${r.child}:${r.state}`);
          if (!isJsonValue(r.result)) throw new Error("invalid receipt result");
          validated.push({ child: r.child, generation: rec!.generation, result: r.result });
        }
        seen.completeResults = validated;
        // Persist validated complete results before ack or downstream admission. A restart can discover the reaped rows.
        await ctx.workflow.setState({ receipts: validated }, "capture-receipts");
        assert.deepEqual(await ctx.workflow.getState(), { receipts: validated });
        await ctx.ops.ack(
          (await ctx.ops.peek()).map((d) => d.id),
          "ack-1",
        );
        const c = await ctx.ops.spawn(kid("c"));
        await ctx.ops.suspend({ phase: 2, children: [c], reaped }, { kind: "child_exited", children: [c], mode: "all" }, "park-2");
        return;
      }
      const cRec = await ctx.ops.findChild("kid-c");
      await ctx.ops.reap(cRec!.id, "reap-c");
      seen.receipts = [...(st.reaped ?? []), `${cRec!.id}:reaped`];
      await ctx.ops.submitResult({ summary: "staged done", receipts: seen.receipts }, "done");
    },
  };
}

// The kid driver returns a structured result at once, so its exit is durable before any wake is armed.
function kidDriver(): FakeDeterministicExecutor {
  const k = new FakeDeterministicExecutor(KID);
  k.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: `kid ${String((ctx.input as { n: string }).n)}`, evidence: { fullBody: "x".repeat(4096) } }, `${ctx.agent}:res`);
  });
  return k;
}

const startReq = (key: string) => ({
  workflow: WF,
  name: "w",
  task: "stage",
  idempotencyKey: key,
  input: { instance: "test-run", run: 1 },
  budgetMicros: 5000,
});

test("a continuation workflow runs three suspend/resume stages on one task id, reaping each child only after both exit", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-cont-");
  let one: Boot | undefined;
  try {
    const seen: Seen = { runs: [] };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [staged(seen)], [kidDriver()]);
    const rec = await one.host.start(await rootId(one), startReq("multi-1"));
    await until(() => settled(one!, rec.id), 10_000);

    const done = await get(one, rec.id);
    assert.equal(done.exit, "succeeded");
    assert.deepEqual(
      seen.runs.map((r) => [r.agent, r.generation]),
      [
        [rec.id, 0],
        [rec.id, 1],
        [rec.id, 2],
      ],
      "one task id, one generation per stage, no duplicate wake",
    );
    assert.equal((seen.runs[1]!.continuation as Phase).phase, 1, "stage 1 resumes from its snapshot");
    assert.equal((seen.runs[1]!.continuation as Phase).children?.length, 2);
    assert.equal((seen.runs[2]!.continuation as Phase).phase, 2);
    assert.deepEqual(seen.beforeC, ["exited", "exited"], "the next child starts only after both exits");
    assert.equal((await one.daemon.list({ parent: rec.id })).length, 3, "exactly three children, no replayed spawn");
    assert.equal(
      JSON.stringify(seen.completeResults).includes("x".repeat(4096)),
      true,
      "reap retains full structured evidence, not the clipped child_result handoff",
    );
    assert.deepEqual(done.result, { summary: "staged done", receipts: seen.receipts });
    await assert.rejects(seen.stale!.peek(), "ops captured in stage 0 are fenced after the task completes");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a parked continuation survives a restart on the same task id: children that fail on restart are reaped and the task resumes", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-cont-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [] };
    const k = new FakeDeterministicExecutor(KID);
    k.setHandler(forever);
    one = await up(dir, dbPath, fakes, [staged(seen)], [k]);
    const rec = await one.host.start(await rootId(one), startReq("restart-1"));
    await until(() => seen.runs.length === 1 && seen.stale !== undefined);
    await until(async () => (await get(one!, rec.id)).state === "yielded");
    closeQuietly(one);

    // Children were running when the process died. A non-continuation child fails on restart; the parent resumes.
    two = await up(dir, dbPath, fakes, [staged(seen)], [kidDriver()]);
    await two.daemon.recover();
    await until(() => settled(two!, rec.id), 10_000);

    const done = await get(two, rec.id);
    assert.equal(done.exit, "succeeded");
    assert.deepEqual(
      seen.runs.map((r) => r.generation),
      [0, 1, 2],
      "the resume is generation + 1 on the same task id",
    );
    assert.equal(
      seen.runs.every((r) => r.agent === rec.id),
      true,
    );
    assert.deepEqual(seen.beforeC, ["exited", "exited"], "the replacement child waits for both (failed) exits");
    assert.equal((await two.daemon.list({ parent: rec.id })).length, 3, "no second spawn for a or b on resume");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval ops are keyed: a replay returns the same approval, and getApproval reads it back pending", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-cont-");
  let one: Boot | undefined;
  try {
    const seen: { ids: string[]; state?: string } = { ids: [] };
    const def: WorkflowDef = {
      name: "approval",
      continuation: true,
      validate: (input) => ({ ok: true, value: input }),
      async run(ctx) {
        const a = await ctx.ops.openApproval("egress", "example.test:443", "ap-1");
        const again = await ctx.ops.openApproval("egress", "example.test:443", "ap-1");
        seen.ids.push(a.id, again.id);
        seen.state = (await ctx.ops.getApproval(a.id))?.state;
        await ctx.ops.submitResult({ summary: "asked" }, "asked");
      },
    };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [def], []);
    const rec = await one.host.start(await rootId(one), { ...startReq("ap-1"), workflow: APPROVAL });
    await until(() => settled(one!, rec.id), 10_000);
    assert.equal(seen.ids.length, 2);
    assert.equal(seen.ids[0], seen.ids[1], "a keyed replay returns the same approval id");
    assert.equal(seen.state, "pending");
    assert.equal((await get(one, rec.id)).exit, "succeeded");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A workflow has no prompt to carry an operator interrupt: one sent while it is parked wakes it (any wait) and is consumed by
// that resume (journaled delivered once, its flagged signal drained), so it never sits pending for a later resume to re-deliver.
test("an interrupt to a parked continuation workflow wakes it and is consumed by the resume, once", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-cont-");
  let one: Boot | undefined;
  try {
    const runs: number[] = [];
    const parker: WorkflowDef = {
      name: "staged",
      continuation: true,
      capabilities: { state: true },
      validate: (input) => ({ ok: true, value: input }),
      async run(ctx: WorkflowRunContext & { input: JsonValue }) {
        runs.push(ctx.generation);
        if (ctx.continuation === undefined) return void (await ctx.ops.suspend({ phase: 1 }, { kind: "timer", at: Date.now() + 3_600_000 }, "park"));
        await ctx.ops.submitResult({ summary: "woken" }, "done");
      },
    };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [parker], []);
    const rec = await one.host.start(await rootId(one), startReq("intr-1"));
    await until(async () => (await get(one!, rec.id)).state === "yielded", 10_000);
    const sent = await one.daemon.messageAgent(rec.id, "INT-WF stop", "i1", "interrupt");
    assert.equal(sent.delivered, "woke");
    await until(() => settled(one!, rec.id), 10_000);
    assert.equal((await get(one, rec.id)).exit, "succeeded");
    assert.deepEqual(runs, [0, 1], "one resume");
    const done = (await one.store.journal.read({ agent: rec.id })).filter((e) => e.payload.kind === "ext.pomtreed.interrupt_done");
    assert.deepEqual(
      done.map((e) => (e.payload as unknown as { keys: string[]; mode: string }).keys),
      [["i1"]],
    );
    assert.equal((done[0]!.payload as unknown as { mode: string }).mode, "woke");
    assert.equal(
      (await one.store.mailbox.peek(rec.id)).some((s) => (s as { interrupt?: boolean }).interrupt === true),
      false,
      "the flagged signal is drained",
    );
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});
