import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeterministicRunContext, ExecutorReapReceipt, Handoff } from "@pomtree/core";
import { FakeDeterministicExecutor } from "@pomtree/testing";
import { get, setup, until } from "./test-setup.ts";

// Offline regressions for mixed trees and races: a deterministic parent with real container children, cancel and
// failure with a live child, a queued spawn behind a gated spawn chain, and what a deterministic child's exit reports.
// Gates are explicit promises; nothing sleeps. Only public daemon ops, the registry port on daemon.deps and the harness are used.

const PARENT = "fake-parent";
const CHILD = "fake-child";
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 10_000 };

type Setup = ReturnType<typeof setup>;
const settled = async (t: Setup, id: string) => TERMINAL.includes((await get(t, id)).state);
const waitSettled = (t: Setup, id: string, ms = 4000) => until(() => settled(t, id), ms);
const rootId = async (t: Setup) => (await t.daemon.root()).id;
const start = async (t: Setup, key: string, driver = PARENT, budgetMicros = 5000) =>
  t.daemon.startDeterministic(await rootId(t), {
    name: "det",
    task: "t",
    idempotencyKey: key,
    executor: "deterministic",
    spec: { driver, input: null },
    budgetMicros,
  });
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "accepted",
    (e: Error) => `rejected: ${e.message}`,
  );
// A driver step that parks until its run is aborted; the host, not the driver, must end the task then.
const parked = (ctx: DeterministicRunContext) => new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));

// Records every gateway call with its agent, so a test can tell the task's own calls from a container child's.
const recordGateway = (t: Setup): [string, string][] => {
  const log: [string, string][] = [];
  const gw = t.daemon.deps.gateway as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ["issueKey", "spend", "revoke"]) {
    const orig = gw[m]!.bind(gw);
    gw[m] = (...a: unknown[]) => {
      log.push([m, String(a[0])]);
      return orig(...a);
    };
  }
  return log;
};

test(
  "a deterministic parent's container child spends and reports; the reap receipt carries the child's result and its unused budget after real spend",
  TIMEOUT,
  async () => {
    const seen: { child?: string; kinds?: string[]; exitSignal?: unknown; receipt?: ExecutorReapReceipt } = {};
    const exec = new FakeDeterministicExecutor(PARENT);
    exec.setHandler(async (ctx) => {
      seen.child = await ctx.ops.spawn({ name: "model", task: "spend", idempotencyKey: "mc-1", budgetMicros: 2000 });
      await until(async () => (await t.daemon.get(seen.child!))?.state === "exited");
      const inbox = await ctx.ops.peek();
      seen.kinds = inbox.map((d) => d.kind);
      seen.exitSignal = inbox.find((d) => d.kind === "child_exited");
      seen.receipt = await ctx.ops.reap(seen.child!, "mc-reap");
      await ctx.ops.submitResult({ summary: "mixed" }, "mc-res");
    });
    const t = setup(
      async (c) => {
        if (c.prompt === "spend") {
          c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 300 });
          return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
        }
      },
      { deterministicExecutors: new Map([[PARENT, exec] as const]) },
    );
    const gw = recordGateway(t);
    const rec = await start(t, "mixed");
    await waitSettled(t, rec.id);

    assert.equal((await get(t, rec.id)).exit, "succeeded");
    assert.ok(seen.kinds?.includes("child_exited"), "the parent sees its child's exit in the inbox");
    assert.equal((seen.exitSignal as { exit?: string }).exit, "succeeded");
    assert.equal(seen.receipt!.child, seen.child);
    assert.deepEqual(seen.receipt!.result, { summary: "ok", value: 1 }, "the receipt carries the child's full result");
    assert.equal(seen.receipt!.unusedMicros, 1700, "2000 carved minus the 300 the child really spent, once");
    assert.ok(
      gw.every(([, agent]) => agent !== rec.id),
      "the deterministic parent makes no gateway calls of its own",
    );
    assert.ok(
      gw.some(([m, agent]) => m === "spend" && agent === seen.child),
      "the container child's own spend is recorded against the child",
    );
  },
);

test("cancelling a deterministic parent with a live container child settles the child first; the child is terminal and not left running", TIMEOUT, async () => {
  const seen: { child?: string } = {};
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    seen.child = await ctx.ops.spawn({ name: "hold", task: "sleep", idempotencyKey: "hold-1", budgetMicros: 800 });
    await parked(ctx);
  });
  const t = setup(
    async (c) => {
      if (c.prompt === "sleep") return void (await c.stopped);
    },
    { deterministicExecutors: new Map([[PARENT, exec] as const]) },
  );
  const rec = await start(t, "cancel-live");
  await until(async () => seen.child !== undefined && (await get(t, seen.child)).state === "running");
  await t.daemon.cancel(rec.id, 5);
  await waitSettled(t, rec.id);
  await waitSettled(t, seen.child!);

  assert.equal((await get(t, rec.id)).exit, "cancelled");
  const child = await get(t, seen.child!);
  assert.ok(child.exit !== null, "the child has a durable exit before the parent is finished");
  assert.equal(child.budgetMicros, 800, "the child's carve is unchanged by the parent's cancel");
});

test("a deterministic parent failing with a live container child settles and accounts the child; the child is not left running", TIMEOUT, async () => {
  const seen: { child?: string } = {};
  let goFail = () => {};
  const failGate = new Promise<void>((r) => (goFail = r));
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    seen.child = await ctx.ops.spawn({ name: "hold", task: "sleep", idempotencyKey: "hold-2", budgetMicros: 800 });
    await failGate; // the test opens this only once the child is running, so the failure happens with a live child
    throw new Error("parent failed with a live child");
  });
  const t = setup(
    async (c) => {
      if (c.prompt === "sleep") return void (await c.stopped);
    },
    { deterministicExecutors: new Map([[PARENT, exec] as const]) },
  );
  const rec = await start(t, "fail-live");
  await until(async () => seen.child !== undefined && (await get(t, seen.child)).state === "running");
  goFail();
  await waitSettled(t, rec.id);
  await waitSettled(t, seen.child!);

  assert.equal((await get(t, rec.id)).exit, "failed");
  assert.notEqual((await get(t, seen.child!)).exit, null, "the child reached a durable exit");
});

// Parks a deterministic parent, holds the spawn chain with a blocker, has the parent issue a deterministic child spawn behind
// it, then runs `fence` (cancel or a generation bump) before the gate opens. Reads on the registry are logged so the test can
// tell whether the queued request reached a guard while the chain was held, instead of assuming it did.
const drain = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};
async function queuedStaleSpawn(mode: "cancel" | "bump") {
  let openChain = () => {};
  const chain = new Promise<void>((r) => (openChain = r));
  let releaseParent = () => {};
  const parentStart = new Promise<void>((r) => (releaseParent = r));
  const seen: { issued?: boolean; spawn?: string } = {};
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    await parentStart;
    seen.issued = true;
    seen.spawn = await outcome(
      ctx.ops.spawn({
        name: "queued",
        task: "t",
        executor: "deterministic",
        spec: { driver: CHILD, input: null },
        budgetMicros: 100,
        idempotencyKey: "queued-1",
      }),
    );
    await parked(ctx);
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const, [CHILD, new FakeDeterministicExecutor(CHILD)] as const]) });

  const reg = t.daemon.deps.registry;
  const created: string[] = [];
  const createOrig = reg.create.bind(reg);
  reg.create = (...args: Parameters<typeof reg.create>) => {
    created.push(args[0].name);
    return args[0].name === "blocker" ? chain.then(() => createOrig(...args)) : createOrig(...args);
  };
  const reads: string[] = [];
  const rec0 = reg as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ["get", "list"]) {
    const o = rec0[m]!.bind(reg);
    rec0[m] = (...a: unknown[]) => {
      reads.push(`${m}:${JSON.stringify(a[0])}`);
      return o(...a);
    };
  }

  const rec = await start(t, `queued-${mode}`);
  const blocker = t.daemon.spawn(await rootId(t), { name: "blocker", task: "t", budgetMicros: 100, idempotencyKey: `blocker-${mode}` });
  releaseParent();
  await until(() => seen.issued === true);
  await drain(); // let the queued request run any guard reads it makes before the fence
  const readsWhileHeld = reads.filter((r) => r.includes(rec.id)).length;

  if (mode === "cancel") await t.daemon.cancel(rec.id, 5);
  else await t.daemon.deps.registry.bumpGeneration(rec.id, "h1", `bump-${mode}`);
  await drain();
  openChain();
  await blocker.catch(() => {});
  await until(() => seen.spawn !== undefined);
  if (mode === "cancel") await waitSettled(t, rec.id);
  return { t, rec, seen, created, readsWhileHeld };
}

test("a spawn queued behind a gated spawn chain is refused once its parent is cancelled; no child is created", TIMEOUT, async () => {
  const { t, rec, seen, created, readsWhileHeld } = await queuedStaleSpawn("cancel");
  assert.ok(readsWhileHeld > 0, "the queued request reached a registry guard while the chain was held (else the fence is not exercised)");
  assert.match(seen.spawn!, /^rejected/, "a spawn issued before cancellation but queued behind the chain is refused");
  assert.ok(!created.includes("queued"), "the refused spawn never reached registry.create");
  assert.equal((await t.daemon.list({ parent: rec.id })).length, 0, "no child was created for the cancelled parent");
  assert.equal((await get(t, rec.id)).exit, "cancelled");
});

test("a spawn queued behind a gated chain is refused after its parent's generation is bumped; no child is created", TIMEOUT, async () => {
  const { t, rec, seen, created, readsWhileHeld } = await queuedStaleSpawn("bump");
  assert.ok(readsWhileHeld > 0, "the queued request reached a registry guard while the chain was held (else the fence is not exercised)");
  assert.match(seen.spawn!, /^rejected/, "a spawn fenced to the old generation is refused");
  assert.ok(!created.includes("queued"), "the refused spawn never reached registry.create");
  assert.equal((await t.daemon.list({ parent: rec.id })).length, 0, "no child was created from the superseded generation");
  // Separate claim, reported on its own: a parent whose generation was bumped must still be cancellable to a terminal.
  // Its parked driver is the only run left, so this also cleans up.
  await t.daemon.cancel(rec.id, 5).catch(() => {});
  await waitSettled(t, rec.id);
});

test("a held container child's carve stays with the parent while it is live, even after it spends (no early refund)", TIMEOUT, async () => {
  const seen: { child?: string } = {};
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    seen.child = await ctx.ops.spawn({ name: "hold", task: "spend-hold", idempotencyKey: "carve-1", budgetMicros: 800 });
    await parked(ctx);
  });
  const t = setup(
    async (c) => {
      if (c.prompt === "spend-hold") {
        c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 300 });
        return void (await c.stopped);
      }
    },
    { deterministicExecutors: new Map([[PARENT, exec] as const]) },
  );
  const rec = await start(t, "carve", PARENT, 5000);
  await until(() => seen.child !== undefined);
  // The child's own remaining shows its real spend (800 - 300); the parent view must not refund it while the child is live.
  await until(async () => (await t.daemon.remainingMicros(await get(t, seen.child!))) === 500, 4000);
  assert.equal(await t.daemon.remainingMicros(await get(t, rec.id)), 4200, "the parent still holds the full 800 carve while the child is live");
  await t.daemon.cancel(rec.id, 5);
  await waitSettled(t, rec.id);
  await waitSettled(t, seen.child!);
  assert.equal((await get(t, seen.child!)).budgetMicros, 800);
});

test("cancel and no-result synthesized handoffs of a deterministic task carry no workspace, folder, branch or worktree wording", TIMEOUT, async () => {
  const wording = /workspace|folder|branch|worktree|merged|pushed/i;
  const parked1 = { started: false };
  const cancelExec = new FakeDeterministicExecutor(PARENT);
  cancelExec.setHandler(async (ctx) => {
    parked1.started = true;
    await parked(ctx);
  });
  const t1 = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, cancelExec] as const]) });
  const cancelled = await start(t1, "wording-cancel");
  await until(() => parked1.started);
  await t1.daemon.cancel(cancelled.id, 5);
  await waitSettled(t1, cancelled.id);
  const c = await get(t1, cancelled.id);
  assert.equal(c.exit, "cancelled");
  const cs = c.result as Handoff | null;
  assert.equal(cs?.synthesized, true, "a cancelled task gets a host-written handoff");
  assert.ok(!wording.test(cs!.summary), `cancel handoff claims nothing about a workspace: ${cs!.summary}`);

  const noResExec = new FakeDeterministicExecutor(PARENT);
  noResExec.setHandler(() => {});
  const t2 = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, noResExec] as const]) });
  const nores = await start(t2, "wording-noresult");
  await waitSettled(t2, nores.id);
  const n = await get(t2, nores.id);
  assert.equal(n.exit, "failed");
  const ns = n.result as Handoff | null;
  assert.equal(ns?.synthesized, true, "a no-result task gets a host-written handoff");
  assert.ok(!wording.test(ns!.summary), `no-result handoff claims nothing about a workspace: ${ns!.summary}`);
});

test("a deterministic child that fails reports child_exited with no workspace or branch wording in its signal or synthesized handoff", TIMEOUT, async () => {
  const seen: { child?: string; signal?: unknown; receipt?: ExecutorReapReceipt } = {};
  const kid = new FakeDeterministicExecutor(CHILD);
  kid.setHandler(() => {
    throw new Error("child failed");
  });
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    seen.child = await ctx.ops.spawn({
      name: "kid",
      task: "t",
      executor: "deterministic",
      spec: { driver: CHILD, input: null },
      budgetMicros: 100,
      idempotencyKey: "kid-x",
    });
    await until(async () => (await t.daemon.get(seen.child!))?.state === "exited");
    const inbox = await ctx.ops.peek();
    seen.signal = inbox.find((d) => d.kind === "child_exited");
    seen.receipt = await ctx.ops.reap(seen.child!, "kid-reap");
    await ctx.ops.submitResult({ summary: "parent saw the failure" }, "kid-parent-res");
  });
  const t = setup(async () => {}, { deterministicExecutors: new Map([[PARENT, exec] as const, [CHILD, kid] as const]) });
  const rec = await start(t, "kid-parent");
  await waitSettled(t, rec.id);

  assert.equal((seen.signal as { exit?: string } | undefined)?.exit, "failed", "the parent is told the child failed");
  const wording = /workspace|folder|branch|worktree/i;
  assert.ok(!wording.test(JSON.stringify(seen.signal)), "the child_exited signal does not claim a workspace");
  assert.equal(seen.receipt!.exit, "failed");
  const childSummary = (seen.receipt!.result as Handoff | null)?.summary ?? "";
  assert.ok(!wording.test(childSummary), "the synthesized failure handoff does not claim a workspace or branch");
});
