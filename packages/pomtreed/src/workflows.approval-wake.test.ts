import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonValue, Signal, WorkflowDef, WorkflowRunContext } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { createFakes, ScriptHarness } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { latestContinuation } from "./workflow-continuation.ts";
import { DEADLINE_KIND } from "./watchdog.ts";
import { get, scratch, SECRET, until } from "./test-setup.ts";
import { WorkflowHost } from "./workflows.ts";

// Offline approval-wake durability tests over a real SQLite file. A reviewed continuation workflow opens a `publish` approval
// (target = sha256 hex), parks on a far-future timer and, on its next body, reads the approval back with getApproval. A
// terminal decision must wake the parked requester durably, whatever the crash point. Decisions go through the public
// Daemon.decideApproval facade; the store is touched only to simulate the decision->enqueue gap. Each boot is a fresh Daemon
// on the same database. Independent harness; nothing is imported from the other workflow test files.

const EXT = "apwf";
const PUBLISH = `${EXT}/publish`;
const SHA = "ab".repeat(32);
const FAR = 3_600_000; // the timer must never be the reason a wake happens
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 15_000 };

type Fakes = ReturnType<typeof createFakes>;
// A fault-injectable orchestrator: `failWakes` makes the next N wakes throw, after the decision is already durable in the mailbox.
class FlakyOrchestrator extends LocalOrchestrator {
  failWakes = 0;
  override async wake(agent: string, signal: Signal): Promise<void> {
    if (this.failWakes > 0) {
      this.failWakes -= 1;
      throw new Error("injected wake failure");
    }
    return super.wake(agent, signal);
  }
}
type Boot = { store: ReturnType<typeof openStore>; daemon: Daemon; host: WorkflowHost; orch: FlakyOrchestrator };

function boot(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], opts: { approvalTimeoutMs?: number } = {}): Boot {
  const store = openStore(dbPath);
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const orch = new FlakyOrchestrator();
  const harness = new ScriptHarness(async (c) => {
    await c.stopped;
  });
  let daemon!: Daemon;
  const host = new WorkflowHost({
    registry: () => store.registry,
    reviewed: (o) => o === EXT,
    startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
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
    orchestrator: orch,
    deterministicExecutors: host.executors,
    ...(opts.approvalTimeoutMs !== undefined && { approvalTimeoutMs: opts.approvalTimeoutMs }),
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, daemon, host, orch };
}

async function up(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], opts?: { approvalTimeoutMs?: number }): Promise<Boot> {
  const b = boot(dir, dbPath, fakes, defs, opts);
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
const startReq = (key: string) => ({ workflow: PUBLISH, name: "p", task: "publish", idempotencyKey: key, input: {}, budgetMicros: 5000 });

interface Seen {
  runs: { generation: number; phase: number }[];
  opened?: string;
  read?: { id?: string; target?: string; state?: string };
  published: string[];
}

// Phase 0 opens the publish approval, optionally holds before parking, then parks on a far timer. Phase 1 reads the approval
// back by id, acks the decision notification, publishes only when approved, and completes.
function publisher(seen: Seen, hold?: Promise<void>): WorkflowDef {
  return {
    name: "publish",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as { phase: number; approval?: string };
      seen.runs.push({ generation: ctx.generation, phase: st.phase });
      if (st.phase === 0) {
        const ap = await ctx.ops.openApproval("publish", SHA, "p1");
        seen.opened = ap.id;
        if (hold) await hold;
        await ctx.ops.suspend({ phase: 1, approval: ap.id }, { kind: "timer", at: Date.now() + FAR }, "park");
        return;
      }
      const ap = await ctx.ops.getApproval(st.approval!);
      seen.read = { id: ap?.id, target: ap?.action.target, state: ap?.state };
      await ctx.ops.ack(
        (await ctx.ops.peek()).map((d) => d.id),
        "ack",
      );
      if (ap?.state === "approved") seen.published.push(ap.id);
      await ctx.ops.submitResult({ summary: ap?.state ?? "missing" }, "done");
    },
  };
}

const gens = (seen: Seen) => seen.runs.map((r) => [r.generation, r.phase]);
const awaitOpened = (seen: Seen) => until(() => seen.opened !== undefined, 5_000);
const awaitYielded = (b: Boot, id: string) => until(async () => (await get(b, id)).state === "yielded", 5_000);
const awaitTerminal = (b: Boot, id: string) => until(async () => TERMINAL.includes((await get(b, id)).state), 10_000);

test("a decision after the requester yields wakes it at once: gen 1 reads the approval by id and publishes once, long before the timer", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  try {
    const seen: Seen = { runs: [], published: [] };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [publisher(seen)]);
    const rec = await one.host.start(await rootId(one), startReq("aw-1"));
    await awaitOpened(seen);
    await awaitYielded(one, rec.id);
    const started = Date.now();
    await one.daemon.decideApproval(seen.opened!, "approve", "op", "ok", "d1");
    await awaitTerminal(one, rec.id);
    assert.ok(Date.now() - started < FAR / 10, "woken by the decision, not the timer");
    assert.deepEqual(gens(seen), [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(seen.read, { id: seen.opened, target: SHA, state: "approved" }, "exact id and target, terminal state");
    assert.deepEqual(seen.published, [seen.opened]);
    assert.equal((await get(one, rec.id)).exit, "succeeded");

    // A replayed decision and a sweep add nothing: no second signal, generation or publication.
    await one.daemon.decideApproval(seen.opened!, "approve", "op", "ok", "d1");
    await one.daemon.sweepApprovals();
    await one.daemon.recover();
    assert.deepEqual(gens(seen).length, 2, "replays do not start another generation");
    assert.equal(seen.published.length, 1, "replays do not publish again");
    assert.equal((await one.store.mailbox.peek(rec.id)).length, 0, "the decision was acked");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a decision recorded while the body is held before its park is not lost: the snapshot parks and the wake still happens", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  try {
    const seen: Seen = { runs: [], published: [] };
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [publisher(seen, hold)]);
    const rec = await one.host.start(await rootId(one), startReq("aw-2"));
    await awaitOpened(seen);
    // Decision lands while the body is still running (before the suspend snapshot is registered).
    await one.daemon.decideApproval(seen.opened!, "approve", "op", "ok", "d2");
    assert.equal((await get(one, rec.id)).state, "running", "no yield while the body is held");
    release();
    await awaitTerminal(one, rec.id);
    assert.deepEqual(gens(seen), [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(seen.read, { id: seen.opened, target: SHA, state: "approved" });
    assert.deepEqual(seen.published, [seen.opened]);
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash between the mailbox enqueue and the wake is recovered on a new boot: resumes once and publishes once", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], published: [] };
    one = await up(dir, dbPath, fakes, [publisher(seen)]);
    const rec = await one.host.start(await rootId(one), startReq("aw-3"));
    await awaitOpened(seen);
    await awaitYielded(one, rec.id);
    one.orch.failWakes = 1; // the enqueue is durable; the wake fails once
    await one.daemon.decideApproval(seen.opened!, "approve", "op", "ok", "d3");
    assert.equal((await get(one, rec.id)).state, "yielded", "the wake failed: still parked");
    assert.equal((await one.store.mailbox.peek(rec.id)).length, 1, "the decision signal is queued durably");
    one.store.close();

    two = await up(dir, dbPath, fakes, [publisher(seen)]);
    await two.daemon.recover();
    await awaitTerminal(two, rec.id);
    assert.deepEqual(gens(seen), [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(seen.published, [seen.opened], "one publication");
    assert.equal((await get(two, rec.id)).generation, 1);
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal decision committed before its notification is recovered by the terminal sweep and wakes the parked requester", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], published: [] };
    one = await up(dir, dbPath, fakes, [publisher(seen)]);
    const rec = await one.host.start(await rootId(one), startReq("aw-4"));
    await awaitOpened(seen);
    await awaitYielded(one, rec.id);
    // Simulate the gap: the store commits the decision, the process dies before the mailbox enqueue.
    await one.store.approvals!.decide(seen.opened!, { who: "op", rank: "operator", decision: "approve", why: "gap" }, "d4");
    assert.equal((await one.store.mailbox.peek(rec.id)).length, 0, "no enqueue yet");
    one.store.close();

    two = await up(dir, dbPath, fakes, [publisher(seen)]);
    await two.daemon.recover();
    await awaitTerminal(two, rec.id);
    assert.deepEqual(gens(seen), [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(seen.published, [seen.opened]);
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a denial wakes the same task without publishing", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  try {
    const seen: Seen = { runs: [], published: [] };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [publisher(seen)]);
    const rec = await one.host.start(await rootId(one), startReq("aw-5"));
    await awaitOpened(seen);
    await awaitYielded(one, rec.id);
    await one.daemon.decideApproval(seen.opened!, "deny", "op", "no", "d5");
    await awaitTerminal(one, rec.id);
    assert.deepEqual(gens(seen), [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(seen.read, { id: seen.opened, target: SHA, state: "denied" });
    assert.deepEqual(seen.published, [], "a denial publishes nothing");
    assert.equal((await get(one, rec.id)).exit, "succeeded");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rung timeout is a fail-closed terminal decision: the sweep wakes the same task and it publishes nothing", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  try {
    const seen: Seen = { runs: [], published: [] };
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [publisher(seen)], { approvalTimeoutMs: 40 });
    const rec = await one.host.start(await rootId(one), startReq("aw-6"));
    await awaitOpened(seen);
    await awaitYielded(one, rec.id);
    // Each rung times out in turn (operator, then owner); only the top rung's timeout is terminal.
    await until(async () => {
      await new Promise((r) => setTimeout(r, 60));
      await one!.daemon.sweepApprovals();
      return TERMINAL.includes((await get(one!, rec.id)).state);
    }, 10_000);
    assert.deepEqual(gens(seen), [
      [0, 0],
      [1, 1],
    ]);
    assert.notEqual(seen.read?.state, "approved", "a timeout never approves");
    assert.deepEqual(seen.published, [], "no publication on timeout");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired durable session deadline beats an approved decision at restart: the task times out and publishes nothing", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-apwf-");
  let one: Boot | undefined;
  let two: Boot | undefined;
  try {
    const fakes = createFakes({ host: "h1" });
    const seen: Seen = { runs: [], published: [] };
    one = await up(dir, dbPath, fakes, [publisher(seen)]);
    const rec = await one.host.start(await rootId(one), startReq("aw-7"));
    await awaitOpened(seen);
    await awaitYielded(one, rec.id);
    // Durable deadline already in the past (latest DEADLINE_KIND entry wins), then an approval committed with no enqueue.
    await one.store.journal.append({
      agent: rec.id,
      host: "h1",
      generation: 0,
      payload: { kind: DEADLINE_KIND, at: Date.now() - 1_000, previousAt: null } as never,
      idempotencyKey: `${rec.id}:deadline:expired`,
    });
    await one.store.approvals!.decide(seen.opened!, { who: "op", rank: "operator", decision: "approve", why: "late" }, "d7");
    one.store.close();

    two = await up(dir, dbPath, fakes, [publisher(seen)]);
    await two.daemon.recover();
    await awaitTerminal(two, rec.id);
    assert.deepEqual(gens(seen), [[0, 0]], "no body starts after the deadline");
    assert.deepEqual(seen.published, [], "no publication past the deadline");
    assert.equal((await get(two, rec.id)).exit, "timed_out");
  } finally {
    closeQuietly(one);
    closeQuietly(two);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Gen 1 reads the terminal approval canonically, then parks on a message WITHOUT acking the decision notification.
test(
  "a terminal approval read then parked without ack does not re-wake on sweep, recover or a duplicate wake; the notification stays in the inbox until acked",
  TIMEOUT,
  async () => {
    const { dir, dbPath } = scratch("pomtreed-apwf-");
    let one: Boot | undefined;
    try {
      const seen: Seen = { runs: [], published: [] };
      const driver: WorkflowDef = {
        name: "publish",
        continuation: true,
        validate: (input) => ({ ok: true, value: input }),
        async run(ctx: WorkflowRunContext & { input: JsonValue }) {
          const st = (ctx.continuation ?? { phase: 0 }) as { phase: number; approval?: string };
          seen.runs.push({ generation: ctx.generation, phase: st.phase });
          if (st.phase === 0) {
            const ap = await ctx.ops.openApproval("publish", SHA, "p1");
            seen.opened = ap.id;
            await ctx.ops.suspend({ phase: 1 }, { kind: "timer", at: Date.now() + FAR }, "park");
            return;
          }
          if (st.phase === 1) {
            // Canonical read of the terminal approval, then an intentional park on a message with no ack of the notification.
            const ap = await ctx.ops.getApproval(seen.opened!);
            seen.read = { id: ap?.id, target: ap?.action.target, state: ap?.state };
            if (ap?.state === "approved") seen.published.push(ap.id);
            await ctx.ops.suspend({ phase: 2 }, { kind: "message" }, "await-go");
            return;
          }
          await ctx.ops.ack(
            (await ctx.ops.peek()).map((d) => d.id),
            "ack",
          );
          await ctx.ops.submitResult({ summary: seen.read?.state ?? "missing" }, "done");
        },
      };
      one = await up(dir, dbPath, createFakes({ host: "h1" }), [driver]);
      const rec = await one.host.start(await rootId(one), startReq("aw-8"));
      await awaitOpened(seen);
      await awaitYielded(one, rec.id);
      await one.daemon.decideApproval(seen.opened!, "approve", "op", "ok", "d8");
      await until(async () => (await get(one!, rec.id)).generation === 1 && (await get(one!, rec.id)).state === "yielded", 5_000);
      assert.deepEqual(gens(seen), [
        [0, 0],
        [1, 1],
      ]);
      assert.deepEqual(seen.read, { id: seen.opened, target: SHA, state: "approved" });
      assert.deepEqual(seen.published, [seen.opened]);

      // The notification is still queued (no ack), and the parked snapshot's inbox includes it.
      const queued = await one.store.mailbox.peek(rec.id);
      const decision = queued.find((q) => q.kind === "approval_decided");
      assert.ok(decision, "the decision notification is still queued");
      assert.ok((await latestContinuation(one.store.journal, rec.id))?.inbox.includes(decision.id), "the snapshot inbox includes the notification");

      // Terminal sweep, recover and a direct duplicate wake must not resume the message park.
      await one.daemon.sweepApprovals();
      await one.daemon.recover();
      await one.daemon.wakeResume(rec.id, decision);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal((await get(one, rec.id)).generation, 1, "no gen 2 from replayed notifications");
      assert.equal((await get(one, rec.id)).state, "yielded");
      assert.equal(seen.runs.length, 2, "no extra body run");
      assert.equal(seen.published.length, 1, "no duplicate publication");

      // A real new message is what resumes gen 2; gen 2 acks the queued notifications and completes.
      const root = await one.daemon.root();
      await one.daemon.sendMessage(root.id, rec.id, "go", root.generation, "go-1");
      await awaitTerminal(one, rec.id);
      assert.deepEqual(gens(seen), [
        [0, 0],
        [1, 1],
        [2, 2],
      ]);
      assert.equal((await get(one, rec.id)).exit, "succeeded");
      assert.equal((await one.store.mailbox.peek(rec.id)).length, 0, "gen 2 acked the notifications");
      assert.equal(seen.published.length, 1, "still one publication");
    } finally {
      closeQuietly(one);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
