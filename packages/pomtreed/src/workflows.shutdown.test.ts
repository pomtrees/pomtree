import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { AgentId, AgentRecord, DeterministicExecutor, WorkflowDef } from "@pomtree/core";
import { FakeDeterministicExecutor, tmpDir } from "@pomtree/testing";
import { createExtensionRegistry } from "./extensions.ts";
import { EXPIRED, raceUntil, sleepTick, WorkflowHost, type DrainOptions } from "./workflows.ts";
import { get, spawnSpec } from "./test-setup.ts";
import { setup, until } from "./test-setup.ts";

// Offline shutdown and fault-injection tests. No sleeps: the drain's race, tick and cancel are injected, and barriers are
// explicit promises. Only the existing cancel path (Daemon.cancel) and the lifecycle run for real.

type Hooks = {
  stops: string[];
  onRun?: (agent: AgentId) => void;
  earlyOut?: (out: Record<string, string>) => void;
  childOut?: (out: Record<string, string>) => void;
  drainGo?: () => void;
};
const hooks = (): Hooks => {
  const g = globalThis as { __wfShutdown?: Hooks };
  g.__wfShutdown = { stops: [] };
  return g.__wfShutdown;
};

const PARK = `
export default {
  manifest: { name: "ownera", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.workflow({
      name: "park",
      validate: (i) => ({ ok: true, value: i }),
      run: async (ctx) => {
        globalThis.__wfShutdown.onRun?.(ctx.agent);
        await new Promise((res) => ctx.signal.addEventListener("abort", res, { once: true }));
      },
    });
  },
  stop() { globalThis.__wfShutdown.stops.push("ownera"); },
};
`;

const PLAIN = `
export default {
  manifest: { name: "plain", entry: "entry.mjs", capabilities: {}, deps: [] },
  init() {},
  stop() { globalThis.__wfShutdown.stops.push("plain"); },
};
`;

const KIDS = `
export default {
  manifest: { name: "kids", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.workflow({
      name: "leaf",
      validate: (i) => (typeof i?.n === "number" ? { ok: true, value: { n: i.n } } : { ok: false, error: "n must be a number" }),
      run: async (ctx) => { await ctx.ops.submitResult({ summary: "leaf" }, ctx.agent + ":r"); },
    });
    host.workflow({
      name: "parent",
      validate: () => ({ ok: true, value: null }),
      run: async (ctx) => {
        const out = {};
        try {
          await ctx.ops.spawn({ name: "c", task: "t", idempotencyKey: "bad", budgetMicros: 100, executor: "deterministic", spec: { driver: "kids/leaf", input: { n: "x" } } });
        } catch (e) { out.invalid = String(e.message); }
        try {
          out.child = await ctx.ops.spawn({ name: "c", task: "t", idempotencyKey: "good", budgetMicros: 100, executor: "deterministic", spec: { driver: "kids/leaf", input: { n: 2, extra: 1 } } });
        } catch (e) { out.valid = String(e.message); }
        globalThis.__wfShutdown.earlyOut?.({ ...out });
        const drainGo = new Promise((res) => (globalThis.__wfShutdown.drainGo = res));
        await Promise.race([drainGo, new Promise((res) => ctx.signal.addEventListener("abort", res, { once: true }))]);
        try {
          await ctx.ops.spawn({ name: "c", task: "t", idempotencyKey: "late", budgetMicros: 100, executor: "deterministic", spec: { driver: "kids/leaf", input: { n: 3 } } });
          out.late = "admitted";
        } catch (e) { out.late = String(e.message); }
        globalThis.__wfShutdown.childOut?.(out);
        // Cancellation may already have landed during the refused spawn; do not miss its one-shot abort event.
        if (!ctx.signal.aborted) await new Promise((res) => ctx.signal.addEventListener("abort", res, { once: true }));
      },
    });
  },
  stop() { globalThis.__wfShutdown.stops.push("kids"); },
};
`;

type Setup = ReturnType<typeof setup>;

// `startOverride` replaces the daemon start (fault injection: a never-settling admission).
function harness(opts: { startOverride?: (requester: AgentId, req: never) => Promise<AgentRecord> } = {}) {
  let t!: Setup;
  const host = new WorkflowHost({
    registry: () => t.fakes.registry,
    reviewed: (o) => o === "ownera" || o === "kids",
    startDeterministic: (r, q) => (opts.startOverride ? opts.startOverride(r, q as never) : t.daemon.startDeterministic(r, q)),
  });
  // The daemon's lookup: the host's read-only view plus one foreign driver that only the Daemon knows about.
  const foreign = new FakeDeterministicExecutor("rogue/x");
  const lookup = {
    get: (k: string): DeterministicExecutor | undefined => host.executors.get(k) ?? (k === foreign.driver ? foreign : undefined),
    has: (k: string) => host.executors.has(k) || k === foreign.driver,
    get size() {
      return host.executors.size + 1;
    },
  } as unknown as ReadonlyMap<string, DeterministicExecutor>;
  t = setup(async () => {}, { deterministicExecutors: lookup });
  const root = tmpDir("pomtreed-wfs-");
  for (const [dir, body] of [
    ["ownera", PARK],
    ["plain", PLAIN],
    ["kids", KIDS],
  ] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "manifest.json"), JSON.stringify({ apiVersion: 2, name: dir, entry: "entry.mjs", capabilities: {}, deps: [] }));
    writeFileSync(join(root, dir, "entry.mjs"), body);
  }
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: () => t.daemon.now(),
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
    workflows: host,
  });
  return { t, host, registry, root, foreign };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const immediateTick = () => new Promise<void>((r) => setImmediate(r));
const drainOpts = (t: Setup, extra: Partial<DrainOptions> = {}): DrainOptions => ({
  deadlineAt: Date.now() + 60_000,
  now: () => Date.now(),
  cancel: (id, graceMs) => t.daemon.cancel(id, graceMs).then(() => {}),
  tick: immediateTick,
  race: (p) => p,
  ...extra,
});
const TERMINAL = ["exited", "reaped"];
const rootId = async (t: Setup) => (await t.daemon.root()).id;

test("an active owned task is cancelled through the existing cancel path; then the owner's extension stops", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const ready = new Promise<AgentId>((res) => (hk.onRun = res));
  const rec = await h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "a1", input: null, budgetMicros: 500 });
  await ready;
  const drained = await h.host.drain(drainOpts(h.t));
  assert.equal(drained.complete, true, JSON.stringify(drained));
  assert.deepEqual(drained.retained, []);
  await until(async () => TERMINAL.includes((await get(h.t, rec.id)).state), 5000);
  assert.equal((await get(h.t, rec.id)).exit, "cancelled");
  const res = await h.registry.stopForShutdown(drained.retained);
  assert.deepEqual(res.stopped.sort(), ["kids", "ownera", "plain"]);
  assert.ok(hk.stops.includes("ownera"), "ext.stop ran after the drain");
  assert.deepEqual(h.host.qualifiedNames(), [], "a stopped owner's workflows are withdrawn");
});

test("a drain closes admission at once: a named start and a child spawn from a live handler are refused", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const early = new Promise<Record<string, string>>((res) => (hk.earlyOut = res));
  const final = new Promise<Record<string, string>>((res) => (hk.childOut = res));
  const parent = await h.host.start(await rootId(h.t), {
    workflow: "kids/parent",
    name: "p",
    task: "t",
    idempotencyKey: "kp",
    input: null,
    budgetMicros: 2000,
  });
  const before = await early;
  assert.match(before.invalid ?? "", /invalid input: n must be a number/, "invalid child refused before any child row");
  assert.ok(before.child, `valid child admitted through the fenced spawn: ${JSON.stringify(before)}`);
  const child = await get(h.t, before.child!);
  assert.equal(child.executor, "deterministic");
  assert.deepEqual((child.spec as { input: unknown }).input, { n: 2 }, "the child persisted the normalized input");
  assert.equal((await h.t.daemon.list({ parent: parent.id })).length, 1, "only the valid child exists");

  let refusedNamed = "";
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async (id, g) => {
        refusedNamed = await h.host.start(parent.id, { workflow: "kids/leaf", name: "x", task: "t", idempotencyKey: "named", input: { n: 1 } }).then(
          () => "admitted",
          (e: Error) => e.message,
        );
        hk.drainGo?.();
        await h.t.daemon.cancel(id, g);
      },
    }),
  );
  assert.match(refusedNamed, /admission is closed/);
  const after = await final;
  assert.match(after.late ?? "", /admission is closed/, `child spawn after drain start refused: ${JSON.stringify(after)}`);
  assert.equal((await h.t.daemon.list({ parent: parent.id })).length, 1, "no child was created after the drain began");
  assert.equal(drained.complete, true, JSON.stringify(drained));
  await h.registry.stopForShutdown(drained.retained);
});

test("a stuck owned task past the absolute deadline retains its owner; independent owners still stop", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const ready = new Promise<AgentId>((res) => (hk.onRun = res));
  const rec = await h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "s1", input: null, budgetMicros: 500 });
  await ready;
  let expire = false;
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async () => {}, // the cancel is accepted but the handler never returns
      race: (p) => (expire ? Promise.resolve(EXPIRED) : p),
      tick: async () => {
        expire = true; // the deadline passes at the first wait after the cancel
      },
    }),
  );
  assert.equal(drained.complete, false);
  assert.deepEqual(drained.retained, ["ownera"]);
  assert.deepEqual(drained.live, [rec.id]);
  const res = await h.registry.stopForShutdown(drained.retained);
  assert.deepEqual(res.stopped.sort(), ["kids", "plain"], "independent owners stop despite one retained owner");
  assert.ok(!hooks().stops.includes("ownera"), "the retained owner is not stopped");
  assert.ok(h.host.executors.has("ownera/park"), "the retained owner keeps its handler");
  // Cleanup: the real cancel releases the parked handler so the test leaves nothing live.
  await h.t.daemon.cancel(rec.id, 0);
  await until(async () => TERMINAL.includes((await get(h.t, rec.id)).state), 5000);
});

test("a cancel that fails retains the owner and reports the error; the drain never reports complete", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const ready = new Promise<AgentId>((res) => (hk.onRun = res));
  const rec = await h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "f1", input: null, budgetMicros: 500 });
  await ready;
  let expire = false;
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async () => {
        throw new Error("cancel transport down");
      },
      race: (p) => (expire ? Promise.resolve(EXPIRED) : p),
      tick: async () => {
        expire = true;
      },
    }),
  );
  assert.equal(drained.complete, false);
  assert.deepEqual(drained.retained, ["ownera"]);
  assert.ok(drained.errors.some((e) => /cancel transport down/.test(e)));
  await h.t.daemon.cancel(rec.id, 0);
  await until(async () => TERMINAL.includes((await get(h.t, rec.id)).state), 5000);
});

test("an admission that never settles past the deadline retains its owner; nothing is cancelled blindly", async () => {
  const entered = deferred<void>();
  const never = new Promise<AgentRecord>(() => {});
  const h = harness({
    startOverride: () => {
      entered.resolve(); // the admission is inside the daemon start and never settles
      return never;
    },
  });
  await h.registry.load(h.root);
  await h.registry.startAll();
  h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "n1", input: null, budgetMicros: 500 }).catch(() => {});
  await entered.promise;
  const cancelled: string[] = [];
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async (id) => {
        cancelled.push(id);
      },
      race: () => Promise.resolve(EXPIRED), // the first wait (the admission gate) passes the deadline
    }),
  );
  assert.equal(drained.complete, false);
  assert.deepEqual(drained.retained, ["kids", "ownera"], "no owned snapshot succeeded, so every owner is conservatively retained");
  assert.deepEqual(cancelled, []);
  const res = await h.registry.stopForShutdown(drained.retained);
  assert.deepEqual(res.stopped, ["plain"]);
  assert.ok(h.host.executors.has("ownera/park"));
});

test("a foreign driver's live task neither blocks management close nor is cancelled by the drain", async () => {
  const h = harness();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const root = await rootId(h.t);
  h.foreign.hold();
  const foreignRec = await h.t.daemon.startDeterministic(root, {
    name: "rogue",
    task: "t",
    idempotencyKey: "rogue-1",
    executor: "deterministic",
    spec: { driver: "rogue/x", input: null },
    budgetMicros: 500,
  });
  await until(async () => (await get(h.t, foreignRec.id)).state === "running", 5000);
  const cancelled: string[] = [];
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async (id, g) => {
        cancelled.push(id);
        await h.t.daemon.cancel(id, g);
      },
    }),
  );
  assert.equal(drained.complete, true, JSON.stringify(drained));
  assert.deepEqual(cancelled, [], "the foreign row is not owned and is untouched");
  assert.equal((await get(h.t, foreignRec.id)).state, "running");
  h.foreign.release();
  await until(async () => TERMINAL.includes((await get(h.t, foreignRec.id)).state), 5000);
});

test("management close refuses only for owned live tasks, and a closed host restarts nothing", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const ready = new Promise<AgentId>((res) => (hk.onRun = res));
  const rec = await h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "c1", input: null, budgetMicros: 500 });
  await ready;
  await assert.rejects(h.registry.stopAll(), /refusing to stop: 1 deterministic task/);
  await h.t.daemon.cancel(rec.id, 0);
  await until(async () => TERMINAL.includes((await get(h.t, rec.id)).state), 5000);
  await h.registry.stopAll();
  await assert.rejects(h.registry.startAll(), /terminal after stop/);
});

test("malformed validator verdicts are refused before any row exists", async () => {
  const h = harness();
  const bad = (name: string, validate: WorkflowDef["validate"]): WorkflowDef => ({ name, validate, run: async () => {} });
  h.host.commit("ownera", [
    bad("nonobj", () => "ok" as never),
    bad("arr", () => [] as never),
    bad("okstr", () => ({ ok: "yes", value: null }) as never),
    bad("novalue", () => ({ ok: true }) as never),
    bad("nonjson", () => ({ ok: true, value: undefined }) as never),
    bad("emptyerr", () => ({ ok: false, error: "" }) as never),
  ]);
  const root = await rootId(h.t);
  const before = (await h.t.daemon.list({ parent: root })).length;
  for (const n of ["nonobj", "arr", "okstr", "novalue", "nonjson", "emptyerr"]) {
    await assert.rejects(
      h.host.start(root, { workflow: `ownera/${n}`, name: "w", task: "t", idempotencyKey: `m-${n}`, input: null, budgetMicros: 500 }),
      /malformed|missing|invalid input|non-JSON/,
    );
  }
  assert.equal((await h.t.daemon.list({ parent: root })).length, before);
});

// ---- Fault injection: every registry read of the drain is bounded and fails closed. ----

// Makes the registry's state-filtered list hang once `hangNow` is set, and reports that the first hung call has begun.
function hangableList(h: ReturnType<typeof harness>) {
  const reg = h.t.fakes.registry as unknown as { list: (o?: unknown) => Promise<AgentRecord[]> };
  const orig = reg.list.bind(reg);
  const hung = deferred();
  let hangNow = false;
  reg.list = (o?: unknown) => {
    if (hangNow && o && typeof o === "object" && "state" in o) {
      hung.resolve();
      return new Promise<AgentRecord[]>(() => {});
    }
    return orig(o as never);
  };
  return { hung, arm: () => (hangNow = true) };
}

test("a registry list that hangs on a later snapshot returns an incomplete drain by the deadline; the owner and its handler stay", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const ready = new Promise<AgentId>((res) => (hk.onRun = res));
  const rec = await h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "hl1", input: null, budgetMicros: 500 });
  await ready;
  const hang = hangableList(h);
  const barrier = deferred();
  const d = h.host.drainSafe(
    drainOpts(h.t, {
      tick: async () => {
        hang.arm(); // the next snapshot hangs
      },
      race: <T>(p: Promise<T>) => Promise.race<T | typeof EXPIRED>([p, barrier.promise.then(() => EXPIRED)]),
    }),
  );
  await hang.hung.promise;
  barrier.resolve(); // the deadline passes while the list is still pending
  const drained = await d;
  assert.equal(drained.complete, false);
  assert.deepEqual(drained.retained, ["ownera"], "the last successful snapshot's owner is retained");
  assert.deepEqual(drained.live, [rec.id]);
  assert.ok(
    drained.errors.some((e) => /owned snapshot exceeded the drain deadline/.test(e)),
    JSON.stringify(drained.errors),
  );
  const res = await h.registry.stopForShutdown(drained.retained);
  assert.deepEqual(res.stopped, ["kids", "plain"]);
  assert.ok(!hooks().stops.includes("ownera"));
  assert.ok(h.host.executors.has("ownera/park"));
  await h.t.daemon.cancel(rec.id, 0);
  await until(async () => TERMINAL.includes((await get(h.t, rec.id)).state), 5000);
});

test("a registry list that hangs on the first snapshot retains every owner; nothing is known and nothing is stopped", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const hang = hangableList(h);
  hang.arm(); // the very first snapshot hangs
  const barrier = deferred();
  const d = h.host.drainSafe(
    drainOpts(h.t, {
      race: <T>(p: Promise<T>) => Promise.race<T | typeof EXPIRED>([p, barrier.promise.then(() => EXPIRED)]),
    }),
  );
  await hang.hung.promise;
  barrier.resolve();
  const drained = await d;
  assert.equal(drained.complete, false);
  assert.deepEqual(drained.retained, ["kids", "ownera"]);
  const res = await h.registry.stopForShutdown(drained.retained);
  assert.deepEqual(res.stopped, ["plain"]);
  assert.ok(!hk.stops.includes("ownera") && !hk.stops.includes("kids"));
  assert.ok(h.host.executors.has("ownera/park"));
});

test("an unexpected drain failure is caught by drainSafe: every owner is retained, no owner is stopped", async () => {
  const h = harness();
  const hk = hooks();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const ready = new Promise<AgentId>((res) => (hk.onRun = res));
  const rec = await h.host.start(await rootId(h.t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "uf1", input: null, budgetMicros: 500 });
  await ready;
  const drained = await h.host.drainSafe(
    drainOpts(h.t, {
      now: () => {
        throw new Error("clock broke");
      },
      cancel: async () => {},
    }),
  );
  assert.equal(drained.complete, false);
  assert.deepEqual(drained.retained, ["kids", "ownera"]);
  assert.ok(drained.errors.some((e) => /drain failed unexpectedly: clock broke/.test(e)));
  const res = await h.registry.stopForShutdown(drained.retained);
  assert.deepEqual(res.stopped, ["plain"]);
  assert.ok(!hk.stops.includes("ownera"));
  assert.ok(h.host.executors.has("ownera/park"));
  await h.t.daemon.cancel(rec.id, 0);
  await until(async () => TERMINAL.includes((await get(h.t, rec.id)).state), 5000);
});

test("a same-prefix unknown driver is foreign: never cancelled, and it does not block close", async () => {
  const h = harness();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const root = await rootId(h.t);
  const ghost = await h.t.fakes.registry.create({
    parent: root,
    name: "ghost",
    task: "t",
    host: "h1",
    budgetMicros: 500,
    idempotencyKey: "ghost-1",
    executor: "deterministic",
    spec: { driver: "ownera/ghost", input: null },
  });
  const cancelled: string[] = [];
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async (id) => {
        cancelled.push(id);
      },
    }),
  );
  assert.equal(drained.complete, true, JSON.stringify(drained));
  assert.deepEqual(cancelled, []);
  assert.equal((await get(h.t, ghost.id)).state, "pending");
  await h.host.close();
});

test("a real pending owned row is cancelled through the existing Daemon.cancel path; a container row is untouched", async () => {
  const h = harness();
  await h.registry.load(h.root);
  await h.registry.startAll();
  const root = await rootId(h.t);
  const pending = await h.t.fakes.registry.create({
    parent: root,
    name: "pend",
    task: "t",
    host: "h1",
    budgetMicros: 500,
    idempotencyKey: "pend-1",
    executor: "deterministic",
    spec: { driver: "ownera/park", input: null },
  });
  const container = await h.t.fakes.registry.create({
    parent: root,
    name: "box",
    task: "t",
    host: "h1",
    budgetMicros: 500,
    idempotencyKey: "box-1",
    spec: spawnSpec,
  });
  const cancelled: string[] = [];
  const drained = await h.host.drain(
    drainOpts(h.t, {
      cancel: async (id, g) => {
        cancelled.push(id);
        await h.t.daemon.cancel(id, g);
      },
    }),
  );
  assert.deepEqual(cancelled, [pending.id], "only the owned deterministic row is cancelled");
  assert.equal(drained.complete, true, JSON.stringify(drained));
  await until(async () => TERMINAL.includes((await get(h.t, pending.id)).state), 5000);
  assert.equal((await get(h.t, pending.id)).exit, "cancelled");
  assert.equal((await get(h.t, container.id)).state, "pending", "the container row was not touched");
});

test("raceUntil: success, rejection, expiry, and an already reached deadline (even with a settled input)", async () => {
  const at = 1000;
  let clock = 0;
  const now = () => clock;
  assert.equal(await raceUntil(Promise.resolve(7), at, now), 7);
  await assert.rejects(raceUntil(Promise.reject(new Error("boom")), at, now), /boom/);
  const never = new Promise<number>(() => {});
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const expired = raceUntil(never, at, now);
    mock.timers.tick(at);
    assert.equal(await expired, EXPIRED);
    clock = at;
    assert.equal(await raceUntil(Promise.resolve(9), at, now), EXPIRED, "a reached deadline wins over a settled input");
    clock = 0;
    const settled = raceUntil(Promise.resolve(3), 5_000, now);
    assert.equal(await settled, 3);
    mock.timers.tick(10_000);
  } finally {
    mock.timers.reset();
  }
});

test("sleepTick resolves only after its 25ms timer (mock timers, no wall clock)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const p = sleepTick().then(() => (done = true));
    mock.timers.tick(24);
    await new Promise((r) => queueMicrotask(() => queueMicrotask(() => r(undefined))));
    assert.equal(done, false);
    mock.timers.tick(1);
    await p;
    assert.equal(done, true);
  } finally {
    mock.timers.reset();
  }
});
