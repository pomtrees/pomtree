import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentId, AgentRecord, DeterministicRunContext, JsonValue, WorkflowDef } from "@pomtree/core";
import { tmpDir } from "@pomtree/testing";
import { createExtensionRegistry } from "./extensions.ts";
import { get, setup, until } from "./test-setup.ts";
import { EXPIRED, WorkflowHost, type DrainOptions } from "./workflows.ts";

// Acceptance regressions for the registration slice: zero-owner drain, production shutdown ordering with real rows, boot-fatal
// builtin sync init, spawn rejection, receiver binding, init-only registration, keyed-replay conflicts and retained journal hooks.
// Offline only: fakes, injected race/tick, explicit promises, no wall-clock sleeps.

type Setup = ReturnType<typeof setup>;
const TERMINAL = ["exited", "reaped"];
const rootId = async (t: Setup) => (await t.daemon.root()).id;
const immediateTick = () => new Promise<void>((r) => setImmediate(r));
const opts = (t: Setup, extra: Partial<DrainOptions> = {}): DrainOptions => ({
  deadlineAt: Date.now() + 60_000,
  now: () => Date.now(),
  cancel: (id, g) => t.daemon.cancel(id, g).then(() => {}),
  tick: immediateTick,
  race: (p) => p,
  ...extra,
});
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const PARK = `
export default {
  manifest: { name: "ownera", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(host) {
    host.workflow({
      name: "park",
      validate: (i) => ({ ok: true, value: i }),
      run: async (ctx) => {
        globalThis.__acc.onRun?.(ctx.agent);
        await new Promise((res) => ctx.signal.addEventListener("abort", res, { once: true }));
      },
    });
  },
  stop() { globalThis.__acc.stops.push("ownera"); },
};`;
const PLAIN = (name: string) => `
export default {
  manifest: { name: "${name}", entry: "entry.mjs" },
  init(host) {
    host.onJournal((e) => { if (e.payload && e.payload.kind === "test.ping") globalThis.__acc.hits.push("${name}:" + e.payload.tag); });
  },
  stop() { globalThis.__acc.stops.push("${name}"); },
};`;
const acc = () => {
  const g = globalThis as { __acc?: { stops: string[]; hits: string[]; onRun?: (a: AgentId) => void; lateErr?: string } };
  g.__acc = { stops: [], hits: [] };
  return g.__acc;
};

function writeFixtures(entries: Array<[string, string]>): string {
  const root = tmpDir("pomtreed-acc-");
  for (const [dir, body] of entries) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, "manifest.json"),
      JSON.stringify({ apiVersion: 2, name: dir, entry: "entry.mjs", capabilities: { routes: true, hooks: { journal: true } }, deps: [] }),
    );
    writeFileSync(join(root, dir, "entry.mjs"), body);
  }
  return root;
}

function harness(opts2: { reviewed?: (o: string) => boolean; script?: (ctx: { stopped: Promise<void>; agent: AgentId }) => Promise<void> } = {}) {
  let t!: Setup;
  const host = new WorkflowHost({
    registry: () => t.fakes.registry,
    reviewed: opts2.reviewed ?? (() => true),
    startDeterministic: (r, q) => t.daemon.startDeterministic(r, q),
  });
  t = setup((opts2.script ?? (async () => {})) as never, { deterministicExecutors: host.executors });
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: () => t.daemon.now(),
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
    workflows: host,
  });
  return { t, host, registry };
}

// ---- 1. zero owners: the drain never reads the registry ----

test("a drain with no ever-committed owner returns complete without any registry read (throwing or never-settling list)", async () => {
  for (const mode of ["throw", "hang"] as const) {
    const { t, host } = harness();
    let calls = 0;
    const reg = t.fakes.registry as unknown as { list: (o?: unknown) => Promise<unknown> };
    reg.list = () => {
      calls += 1;
      if (mode === "throw") return Promise.reject(new Error("store down"));
      return new Promise(() => {});
    };
    const drained = await host.drain(opts(t, { race: () => Promise.resolve(EXPIRED) }));
    assert.deepEqual(drained, { complete: true, retained: [], live: [], errors: [] }, mode);
    assert.equal(calls, 0, `${mode}: registry.list must not be touched`);
  }
});

// ---- 2. production ordering: daemon.shutdown first, then the drain, with real owned rows and an unrelated container ----

test("shutdown then drain: running and pending owned rows end cancelled, an unrelated container stays adoptable, independents stop", async () => {
  const hk = acc();
  const root = writeFixtures([
    ["ownera", PARK],
    ["plain", PLAIN("plain")],
  ]);
  const { t, host, registry } = harness({
    script: async (ctx) => {
      await ctx.stopped;
    },
  });
  await registry.load(root);
  await registry.startAll();
  const ready = deferred<AgentId>();
  hk.onRun = (a) => ready.resolve(a);
  const running = await host.start(await rootId(t), { workflow: "ownera/park", name: "w", task: "t", idempotencyKey: "run1", input: null, budgetMicros: 500 });
  await ready.promise;
  const pending = await t.fakes.registry.create({
    parent: await rootId(t),
    name: "pend",
    task: "t",
    host: "h1",
    budgetMicros: 500,
    idempotencyKey: "pend1",
    executor: "deterministic",
    spec: { driver: "ownera/park", input: null },
  });
  const box = (await t.spawn("box1")) as AgentRecord;
  await until(async () => (await get(t, box.id)).state === "running", 5000);
  // The live sandbox handle for the unrelated container: the fake's running entry for this agent.
  const liveHandles = () => [...t.sandbox.running.entries()].filter(([, h]) => h.agent === box.id);
  const handles = liveHandles();
  assert.equal(handles.length, 1, "exactly one live fake sandbox for the container");
  const [sandboxId] = handles[0]!;
  const calls = { stop: 0, kill: 0 };
  const origStop = t.sandbox.stop.bind(t.sandbox);
  const origKill = t.sandbox.kill.bind(t.sandbox);
  t.sandbox.stop = (id, g, key) => {
    calls.stop += 1;
    return origStop(id, g, key);
  };
  t.sandbox.kill = (id, key) => {
    calls.kill += 1;
    return origKill(id, key);
  };
  try {
    await t.daemon.shutdown(Date.now() + 60_000); // production order: container admission closes first
    const drained = await host.drainSafe(opts(t));
    assert.equal(drained.complete, true, JSON.stringify(drained));
    await until(async () => TERMINAL.includes((await get(t, running.id)).state), 5000);
    await until(async () => TERMINAL.includes((await get(t, pending.id)).state), 5000);
    assert.equal((await get(t, running.id)).exit, "cancelled");
    assert.equal((await get(t, pending.id)).exit, "cancelled");
    // The container is adoptable: its live handle is still running, and no stop or kill reached it.
    assert.equal(t.sandbox.running.get(sandboxId)?.exitCode, null, "the live sandbox handle has no exit code");
    assert.equal((await get(t, box.id)).state, "running", "the container row is still running");
    assert.deepEqual(calls, { stop: 0, kill: 0 }, "no stop or kill was issued to the unrelated container");
    const res = await registry.stopForShutdown(drained.retained);
    assert.deepEqual(res.stopped.sort(), ["ownera", "plain"]);
    assert.deepEqual(hk.stops.sort(), ["ownera", "plain"], "independent extensions stop after the drain");
  } finally {
    // Cleanup after the proof: end the fake container's process so the test leaves nothing live.
    t.sandbox.exit(sandboxId, 0);
  }
});

// ---- 2b. registration status: a late registration in start degrades the owner, and a refused commit rolls back ----

test("a late host.workflow from start() leaves the owner degraded with no definitions and its valid init registrations uncommitted", async () => {
  const hk = acc();
  const root = writeFixtures([
    [
      "late2",
      `export default {
  manifest: { name: "late2", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(h) {
    globalThis.__acc.host = h;
    h.workflow({ name: "ok", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
  },
  start() {
    try {
      globalThis.__acc.host.workflow({ name: "late", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
    } catch (e) {
      globalThis.__acc.lateErr = e.message;
    }
    throw new Error("start refused");
  },
  stop() { globalThis.__acc.stops.push("late2"); },
};`,
    ],
  ]);
  const { host, registry } = harness();
  await registry.load(root);
  await registry.startAll();
  assert.match(hk.lateErr ?? "", /only valid during init/, "the late registration in start threw");
  assert.deepEqual(host.qualifiedNames(), [], "a degraded owner exposes no definitions");
});

test("a refused commit (duplicate owning workflow) marks the later owner failed, stops it, hides its route, and leaves the prior owner intact", async () => {
  const hk = acc();
  const root = writeFixtures([
    [
      "aaa",
      `export default {
  manifest: { name: "aaa", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(h) {
    h.route({ method: "GET", path: "/v1/ext/aaa/a", scope: { kind: "operator" }, handler: () => ({ status: 200, body: {} }) });
    h.workflow({ name: "x", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
  },
  stop() { globalThis.__acc.stops.push("aaa"); },
};`,
    ],
    [
      "zzz",
      `export default {
  manifest: { name: "aaa", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(h) {
    h.route({ method: "GET", path: "/v1/ext/aaa/zz", scope: { kind: "operator" }, handler: () => ({ status: 200, body: {} }) });
    h.workflow({ name: "x", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
  },
  stop() { globalThis.__acc.stops.push("zzz"); },
};`,
    ],
  ]);
  // The duplicate claims the same extension name (writeFixtures would name it after its directory).
  writeFileSync(
    join(root, "zzz", "manifest.json"),
    JSON.stringify({ apiVersion: 2, name: "aaa", entry: "entry.mjs", capabilities: { routes: true }, deps: [] }),
  );
  const { host, registry } = harness();
  const loaded = await registry.load(root);
  assert.deepEqual(
    loaded.map((l) => `${l.status}${l.error ? `: ${l.error}` : ""}`),
    ["ok", "ok"],
    "both init cleanly; the duplicate is only detected at commit",
  );
  await registry.startAll();
  assert.deepEqual(host.qualifiedNames(), ["aaa/x"], "the prior owner's definition is intact; the refused one contributes none");
  assert.deepEqual(hk.stops, ["zzz"], "only the refused owner is stopped (rollback)");
  const paths = registry.routes().map((r) => r.path);
  assert.ok(paths.includes("/v1/ext/aaa/a"), "the prior owner's route stays");
  assert.ok(!paths.includes("/v1/ext/aaa/zz"), "the refused owner's partial route is not exposed");
});

// ---- 3. a sync builtin init throw stays boot-fatal, and the failed builtin exposes nothing ----

test("a synchronous builtin init throw propagates (boot-fatal) and leaves no route or workflow exposed", async () => {
  const { t, host, registry } = harness();
  void t;
  assert.throws(
    () =>
      registry.registerBuiltin({
        manifest: { name: "boom", entry: "x", capabilities: { routes: true }, deps: [] },
        init(h) {
          h.route({ method: "GET", path: "/boom", scope: { kind: "operator" }, handler: () => ({ status: 200, body: {} }) });
          throw new Error("sync boom");
        },
      }),
    /sync boom/,
  );
  assert.equal(registry.routes().filter((r) => r.path === "/boom").length, 0, "the failed builtin's partial route is not exposed");
  assert.deepEqual(host.qualifiedNames(), []);
});

test("an async builtin init rejection marks it failed without throwing (unchanged)", async () => {
  const { registry } = harness();
  registry.registerBuiltin({
    manifest: { name: "lateboom", entry: "x", capabilities: { routes: true }, deps: [] },
    async init(h) {
      h.route({ method: "GET", path: "/lateboom", scope: { kind: "operator" }, handler: () => ({ status: 200, body: {} }) });
      await Promise.resolve();
      throw new Error("async boom");
    },
  });
  await registry.startAll();
  assert.equal(registry.routes().filter((r) => r.path === "/lateboom").length, 0);
});

// ---- 4. malformed child spawn is a rejection, never a synchronous throw, and creates no row ----

test("a malformed child spawn rejects (never throws synchronously) and creates no row", async () => {
  const { t, host } = harness();
  const outcome: Record<string, string> = {};
  host.commit("sp", [
    {
      name: "parent",
      validate: () => ({ ok: true, value: null }),
      run: async (ctx: DeterministicRunContext) => {
        for (const [label, bad] of [
          ["nullReq", null],
          ["noSpec", { executor: "deterministic", name: "c", task: "t", idempotencyKey: "x", spec: null }],
        ] as const) {
          try {
            await (ctx.ops.spawn(bad as never) as Promise<unknown>).then(
              () => (outcome[label] = "admitted"),
              () => (outcome[label] = "rejected"),
            );
          } catch {
            outcome[label] = "sync-throw";
          }
        }
        await ctx.ops.submitResult({ summary: "done" }, `${ctx.agent}:r`).catch(() => {});
      },
    },
  ]);
  const parent = await host.start(await rootId(t), { workflow: "sp/parent", name: "p", task: "t", idempotencyKey: "sp1", input: null, budgetMicros: 2000 });
  await until(async () => TERMINAL.includes((await get(t, parent.id)).state), 5000);
  assert.deepEqual(outcome, { nullReq: "rejected", noSpec: "rejected" });
  assert.equal((await t.daemon.list({ parent: parent.id })).length, 0);
});

// ---- 5. the reviewed receiver is bound at commit: `this` works and later replacement changes nothing ----

test("committed validate and run keep their receiver and ignore later replacement (class and object definitions)", async () => {
  const { t, host } = harness();
  const ran: string[] = [];
  class Cls implements WorkflowDef {
    name = "cls";
    greeting = "hi";
    validate(i: JsonValue) {
      return { ok: true as const, value: { g: this.greeting, i } };
    }
    async run(ctx: DeterministicRunContext) {
      ran.push(`cls:${this.greeting}`);
      await ctx.ops.submitResult({ summary: "ok" }, `${ctx.agent}:r`);
    }
  }
  const cls = new Cls();
  const lit: WorkflowDef = {
    name: "lit",
    validate: (i) => ({ ok: true, value: i }),
    run: async (ctx) => {
      ran.push("lit:original");
      await ctx.ops.submitResult({ summary: "ok" }, `${ctx.agent}:r`);
    },
  };
  host.commit("bind", [cls, lit]);
  // Replace the methods and state after commit.
  cls.greeting = "changed";
  cls.run = async () => {
    ran.push("cls:swapped");
  };
  cls.validate = () => ({ ok: true as const, value: "swapped" as never });
  lit.run = async () => {
    ran.push("lit:swapped");
  };
  const a = await host.start(await rootId(t), { workflow: "bind/cls", name: "w", task: "t", idempotencyKey: "b1", input: 7, budgetMicros: 500 });
  await until(async () => TERMINAL.includes((await get(t, a.id)).state), 5000);
  const b = await host.start(await rootId(t), { workflow: "bind/lit", name: "w", task: "t", idempotencyKey: "b2", input: 8, budgetMicros: 500 });
  await until(async () => TERMINAL.includes((await get(t, b.id)).state), 5000);
  // The validator function is pinned (its original body ran); the receiver's STATE is not frozen, so the mutated field is read.
  assert.deepEqual((a.spec as { input: unknown }).input, { g: "changed", i: 7 }, "original validator body, live receiver state");
  assert.deepEqual(ran, ["cls:changed", "lit:original"], "pinned bodies run; receiver state is live, not frozen");
});

// ---- 6. host.workflow only during init: late registration throws and changes nothing ----

test("host.workflow after init settles throws for file-loaded and builtin extensions; admitted definitions are not replaced", async () => {
  const captured: { host?: { workflow(d: WorkflowDef): void } } = {};
  const fileRoot = writeFixtures([
    [
      "late",
      `export default { manifest: { name: "late", entry: "entry.mjs", capabilities: {}, deps: [] }, init(h) { globalThis.__lateHost = h; h.workflow({ name: "one", validate: (i) => ({ ok: true, value: i }), run: async () => {} }); } };`,
    ],
  ]);
  const { host, registry } = harness();
  let builtinHost: { workflow(d: WorkflowDef): void } | undefined;
  await registry.load(fileRoot);
  registry.registerBuiltin({
    manifest: { name: "bi", entry: "x", capabilities: {}, deps: [] },
    init(hh) {
      builtinHost = hh;
    },
  });
  await registry.startAll();
  const h = (globalThis as { __lateHost?: { workflow(d: WorkflowDef): void } }).__lateHost!;
  captured.host = h;
  assert.throws(() => h.workflow({ name: "two", validate: (i) => ({ ok: true, value: i }), run: async () => {} }), /only valid during init/);
  assert.deepEqual(host.qualifiedNames(), ["late/one"], "the late attempt did not add or replace a definition");
  assert.throws(() => builtinHost!.workflow({ name: "late", validate: (i) => ({ ok: true, value: i }), run: async () => {} }), /only valid during init/);
});

// ---- 6b. registration window: a sync init's microtask is refused; an async init registering before it settles is admitted ----

test("a microtask queued by a sync file init cannot register late; a definition registered before an async init settles is admitted", async () => {
  const hk = acc();
  const root = writeFixtures([
    [
      "micro",
      `export default {
  manifest: { name: "micro", entry: "entry.mjs", capabilities: {}, deps: [] },
  init(h) {
    h.workflow({ name: "orig", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
    queueMicrotask(() => {
      try {
        h.workflow({ name: "late", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
      } catch (e) {
        globalThis.__acc.lateErr = e.message;
      }
    });
  },
};`,
    ],
    [
      "asyncy",
      `export default {
  manifest: { name: "asyncy", entry: "entry.mjs", capabilities: {}, deps: [] },
  async init(h) {
    h.workflow({ name: "before", validate: (i) => ({ ok: true, value: i }), run: async () => {} });
    await Promise.resolve();
  },
};`,
    ],
  ]);
  const { host, registry } = harness();
  await registry.load(root);
  await registry.startAll();
  assert.match(hk.lateErr ?? "", /only valid during init/, "the sync init's microtask was refused");
  assert.deepEqual(host.qualifiedNames(), ["asyncy/before", "micro/orig"], "only the original and the pre-settlement definitions are admitted");
});

// ---- 7. keyed-replay conflict: durable, before any create or carve ----

test("keyed replay: same key with other input or other workflow is refused; exact and reordered retries converge; -0 equals 0", async () => {
  const { t, host } = harness();
  const ident = (i: JsonValue) => ({ ok: true as const, value: i });
  const noop = async () => {};
  host.commit("rp", [
    { name: "echo", validate: ident, run: noop },
    { name: "other", validate: ident, run: noop },
  ]);
  const root = await rootId(t);
  const start = (w: string, key: string, input: JsonValue) =>
    host.start(root, { workflow: w, name: "w", task: "t", idempotencyKey: key, input, budgetMicros: 500 });
  const count = async () => (await t.daemon.list({ parent: root })).length;

  const first = await start("rp/echo", "k1", { a: 1, b: 2 });
  const before = await count();
  await assert.rejects(start("rp/echo", "k1", { a: 2 }), /already bound to a different input/);
  await assert.rejects(start("rp/other", "k1", { a: 1, b: 2 }), /already bound to workflow "rp\/echo"/);
  assert.equal(await count(), before, "a conflict creates no row and carves nothing");

  const same = await start("rp/echo", "k1", { a: 1, b: 2 });
  assert.equal(same.id, first.id, "an exact retry converges");
  const reordered = await start("rp/echo", "k1", { b: 2, a: 1 });
  assert.equal(reordered.id, first.id, "object property order is not a conflict");

  const [x, y] = await Promise.all([start("rp/echo", "k2", { n: 1 }), start("rp/echo", "k2", { n: 1 })]);
  assert.equal(x.id, y.id, "concurrent retries under the gate converge on one row");

  const z = await start("rp/echo", "k3", { n: -0 });
  const w = await start("rp/echo", "k3", { n: 0 });
  assert.equal(z.id, w.id, "numeric -0 and 0 are the same persisted JSON value");
});

test("keyed replay for a child spawn: same key with different input is refused by the handler, the first child is unchanged", async () => {
  const { t, host } = harness();
  const out: Record<string, string> = {};
  const noop = async () => {};
  host.commit("cp", [
    {
      name: "leaf",
      validate: (i) => ({ ok: true, value: i }),
      run: async (ctx) => {
        await ctx.ops.submitResult({ summary: "leaf" }, `${ctx.agent}:r`);
      },
    },
    {
      name: "parent",
      validate: () => ({ ok: true, value: null }),
      run: async (ctx) => {
        const first = await ctx.ops.spawn({
          name: "c",
          task: "t",
          idempotencyKey: "c",
          budgetMicros: 100,
          executor: "deterministic",
          spec: { driver: "cp/leaf", input: { n: 1 } },
        });
        out.first = first;
        await ctx.ops
          .spawn({ name: "c", task: "t", idempotencyKey: "c", budgetMicros: 100, executor: "deterministic", spec: { driver: "cp/leaf", input: { n: 2 } } })
          .then(
            () => (out.second = "admitted"),
            (e: Error) => (out.second = e.message),
          );
        await ctx.ops.submitResult({ summary: "p" }, `${ctx.agent}:r`).catch(() => {});
      },
    },
  ]);
  void noop;
  const p = await host.start(await rootId(t), { workflow: "cp/parent", name: "p", task: "t", idempotencyKey: "cpp", input: null, budgetMicros: 2000 });
  await until(async () => TERMINAL.includes((await get(t, p.id)).state), 5000);
  assert.match(out.second ?? "", /already bound to a different input/);
  assert.equal((await t.daemon.list({ parent: p.id })).length, 1, "only the first child exists");
});

// ---- 8. retained owners keep their journal hooks; stopped owners receive none; final cleanup closes the subscription ----

test("stopForShutdown keeps a retained owner's journal hook live and stops a stopped owner's; finishShutdown closes the subscription", async () => {
  const hk = acc();
  const root = writeFixtures([
    ["keep", PLAIN("keep")],
    ["gone", PLAIN("gone")],
  ]);
  const { t, registry } = harness();
  await registry.load(root);
  await registry.startAll();
  const rootRec = await rootId(t);
  const ping = (tag: string) =>
    t.fakes.journal.append({ agent: rootRec, host: "h1", generation: 0, payload: { kind: "test.ping", tag } as never, idempotencyKey: `ping-${tag}` });
  await ping("before");
  await until(() => hk.hits.includes("keep:before") && hk.hits.includes("gone:before"), 2000);

  const res = await registry.stopForShutdown(["keep"]);
  assert.deepEqual(res.stopped, ["gone"]);
  await ping("during");
  await until(() => hk.hits.includes("keep:during"), 2000);
  assert.ok(!hk.hits.includes("gone:during"), "the stopped owner receives no hook");

  registry.finishShutdown();
  await ping("after");
  await new Promise((r) => queueMicrotask(() => queueMicrotask(() => r(undefined))));
  assert.ok(!hk.hits.includes("keep:after"), "final cleanup closed the subscription");
});
