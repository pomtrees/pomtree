import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { AgentRecord, DeterministicRunContext, JsonValue, WorkflowDef, WorkflowRunOps } from "@pomtree/core";

// Stub capability facade for fixtures that declare no capabilities: every workflow operation throws "not declared". No daemon, store or credential is reachable.
const undeclaredWorkflowOps = (): WorkflowRunOps => {
  const refuse = (): never => {
    throw new Error("workflow capability not declared");
  };
  return {
    instance: "",
    runKey: "undeclared",
    store: { get: async () => refuse(), put: async () => refuse(), list: async () => refuse(), rm: async () => refuse() },
    shared: { get: async () => refuse(), put: async () => refuse(), list: async () => refuse(), rm: async () => refuse() },
    getState: async () => refuse(),
    setState: async () => refuse(),
    fetch: async () => refuse(),
    publishReport: async () => refuse(),
    sendToUser: async () => refuse(),
    ask: async () => refuse(),
  };
};
import { fakeDeterministicContext, FakeDeterministicOps, tmpDir } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { createExtensionRegistry } from "./extensions.ts";
import { get, kinds, setup, until } from "./test-setup.ts";
import { WorkflowHost } from "./workflows.ts";

// Offline integration and portability regressions for the workflow host. Public surface only: WorkflowDef, the handler's
// DeterministicRunContext, WorkflowHost (commit/start/executors/close) and the registry load/startAll/stopAll. Every fixture
// lives under os tmpdir and is removed on exit; every barrier is resolved in finally so nothing leaks into later tests.
//
// The portable handler is a real .mts module that imports ONLY types from @pomtree/core (erased at load, so it resolves
// with no workspace link). The same module is loaded as a file extension and also imported directly for the scripted host.

const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 15_000 };

type Setup = ReturnType<typeof setup>;

const PORTABLE = `
import type { DeterministicRunContext, JsonValue, WorkflowDef } from "@pomtree/core";

export const echo: WorkflowDef = {
  name: "echo",
  validate(input: JsonValue) {
    if (typeof input === "object" && input !== null && !Array.isArray(input) && typeof input.msg === "string") {
      return { ok: true, value: { msg: input.msg } };
    }
    return { ok: false, error: "msg must be a string" };
  },
  async run(ctx: DeterministicRunContext) {
    const msg = (ctx.input as { msg: string }).msg;
    await ctx.ops.submitResult({ summary: "echo:" + msg }, ctx.agent + ":result");
  },
};

export default {
  manifest: { name: "portable", entry: "entry.mts", capabilities: {}, deps: [] },
  init(host: { workflow(def: WorkflowDef): void }) {
    host.workflow(echo);
  },
};
`;

// A pair of deferred values used as explicit barriers (no timers).
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const settled = async (t: Setup, id: string) => TERMINAL.includes((await get(t, id)).state);
const rootId = async (t: Setup) => (await t.daemon.root()).id;
const childCount = async (t: Setup) => (await t.daemon.list({ parent: await rootId(t) })).length;
const exitEntries = async (t: Setup, id: string) => kinds(await t.journal.read({ agent: id })).filter((k) => k.startsWith("exited"));

// Wraps every method of an object (own and prototype) so a call is logged. Used as a spy for model, sandbox and workspace paths.
function spy(obj: object, label: string, log: string[]): void {
  const names = new Set<string>([...Object.getOwnPropertyNames(obj), ...Object.getOwnPropertyNames(Object.getPrototypeOf(obj) ?? {})]);
  const rec = obj as Record<string, unknown>;
  for (const k of names) {
    if (k === "constructor") continue;
    let v: unknown;
    try {
      v = rec[k];
    } catch {
      continue;
    }
    if (typeof v !== "function") continue;
    const orig = v as (...a: unknown[]) => unknown;
    rec[k] = (...a: unknown[]) => {
      log.push(`${label}.${k}`);
      return orig.apply(obj, a);
    };
  }
}

// A daemon with a WorkflowHost wired in, plus a file-loading registry over the same fakes. `reviewed` decides admission.
function harness(reviewed: (owner: string) => boolean) {
  let t!: Setup;
  const host = new WorkflowHost({
    registry: () => t.fakes.registry,
    reviewed,
    startDeterministic: (requester, req) => t.daemon.startDeterministic(requester, req),
  });
  t = setup(async () => {}, { deterministicExecutors: host.executors });
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

function writeExtension(root: string, dir: string, manifest: object, entry: string | null): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "manifest.json"), JSON.stringify({ apiVersion: 1, capabilities: {}, deps: [], ...manifest }));
  if (entry !== null) writeFileSync(join(root, dir, "entry.mts"), entry);
}

test("the portable handler loads as a file extension and runs unchanged to a structured result on a real deterministic task", TIMEOUT, async () => {
  const { t, host, registry } = harness((o) => o === "portable");
  const root = tmpDir("pomtreed-wfi-");
  writeExtension(root, "portable", { name: "portable", entry: "entry.mts" }, PORTABLE);
  const net: string[] = [];
  spy(t.fakes.sandbox, "sandbox", net);
  spy(t.fakes.workspace, "workspace", net);
  spy(t.daemon.deps.gateway, "gateway", net);
  try {
    const [loaded] = await registry.load(root);
    assert.equal(loaded?.status, "ok", loaded?.error);
    await registry.startAll();
    assert.deepEqual(host.qualifiedNames(), ["portable/echo"]);
    const r = await rootId(t);
    const rec = await host.start(r, {
      workflow: "portable/echo",
      name: "w",
      task: "t",
      idempotencyKey: "p1",
      input: { msg: "hi", extra: "dropped" },
      budgetMicros: 500,
    });
    await until(() => settled(t, rec.id), 5000);
    const done = await get(t, rec.id);
    assert.equal(done.executor, "deterministic");
    assert.deepEqual(done.result, { summary: "echo:hi" });
    assert.deepEqual(net, [], "a deterministic workflow touches no model, sandbox or workspace path");
  } finally {
    await registry.stopAll();
  }
});

test("the same exported handler runs against a scripted host: validated input, public ops only, and a structured result", async () => {
  const root = tmpDir("pomtreed-wfs-");
  writeExtension(root, "portable", { name: "portable", entry: "entry.mts" }, PORTABLE);
  const mod = (await import(pathToFileURL(join(root, "portable", "entry.mts")).href)) as { default: { init: unknown }; echo: WorkflowDef };
  const def = mod.echo;
  const v = def.validate({ msg: "hi", extra: 1 });
  assert.deepEqual(v, { ok: true, value: { msg: "hi" } });
  const ops = new FakeDeterministicOps(0, 3);
  const ctx = fakeDeterministicContext({ agent: "wf-1", generation: 3, host: "h9", input: v.ok ? v.value : null, ops });
  await def.run({ ...ctx, workflow: undeclaredWorkflowOps() });
  assert.deepEqual(ops.results, [{ summary: "echo:hi" }]);
  assert.deepEqual(
    ops.calls.map((c) => c.op),
    ["submitResult"],
    "the handler uses only the submitResult public op",
  );
  assert.equal(ctx.agent, "wf-1");
  assert.equal(ctx.generation, 3);
});

test("a validated value is what the handler receives; the rejected extra key never reaches run", TIMEOUT, async () => {
  const seen: JsonValue[] = [];
  const def: WorkflowDef = {
    name: "norm",
    validate: (i) => ({ ok: true, value: { n: (i as { n: number }).n } }),
    run: async (ctx) => {
      seen.push(ctx.input);
      await ctx.ops.submitResult({ summary: "ok" }, `${ctx.agent}:r`);
    },
  };
  const { t, host } = harness(() => true);
  host.commit("norm", [def]);
  try {
    const rec = await host.start(await rootId(t), {
      workflow: "norm/norm",
      name: "w",
      task: "t",
      idempotencyKey: "n1",
      input: { n: 2, junk: true },
      budgetMicros: 500,
    });
    await until(() => settled(t, rec.id), 5000);
    assert.deepEqual(seen, [{ n: 2 }]);
  } finally {
    host.withdraw("norm");
  }
});

// A validator that is not idempotent must be called once; the run receives the value admitted at start.
test("a non-idempotent validator is normalized once; run gets the admitted value", TIMEOUT, async () => {
  let calls = 0;
  const seen: JsonValue[] = [];
  const def: WorkflowDef = {
    name: "once",
    validate: () => ({ ok: true, value: { call: ++calls } }),
    run: async (ctx) => {
      seen.push(ctx.input);
      await ctx.ops.submitResult({ summary: "ok" }, `${ctx.agent}:r`);
    },
  };
  const { t, host } = harness(() => true);
  host.commit("once", [def]);
  try {
    const rec = await host.start(await rootId(t), {
      workflow: "once/once",
      name: "w",
      task: "t",
      idempotencyKey: "o1",
      input: null,
      budgetMicros: 500,
    });
    await until(() => settled(t, rec.id), 5000);
    assert.equal(calls, 1, "validate runs once per admission");
    assert.deepEqual(seen, [{ call: 1 }], "run receives the value admitted at start");
    assert.deepEqual((await get(t, rec.id)).result, { summary: "ok" });
  } finally {
    host.withdraw("once");
  }
});

test("validators returning non-JSON or throwing are refused before any row or carve exists", TIMEOUT, async () => {
  const bad: WorkflowDef[] = [
    { name: "undef", validate: () => ({ ok: true, value: { a: undefined } as unknown as JsonValue }), run: async () => {} },
    { name: "fn", validate: () => ({ ok: true, value: (() => 1) as unknown as JsonValue }), run: async () => {} },
    {
      name: "throws",
      validate: () => {
        throw new Error("nope");
      },
      run: async () => {},
    },
  ];
  const { t, host } = harness(() => true);
  host.commit("bad", bad);
  try {
    const r = await rootId(t);
    const before = await childCount(t);
    for (const name of ["undef", "fn", "throws"]) {
      await assert.rejects(
        host.start(r, { workflow: `bad/${name}`, name: "w", task: "t", idempotencyKey: `k-${name}`, input: null, budgetMicros: 500 }),
        /non-JSON|not JSON|validat|nope/,
      );
    }
    assert.equal(await childCount(t), before, "no row was created for any refused start");
  } finally {
    host.withdraw("bad");
  }
});

test("unknown, foreign-namespace and unreviewed owners are refused with zero rows and zero carved budget", TIMEOUT, async () => {
  const { t, host } = harness((o) => o === "reviewed");
  host.commit("reviewed", [{ name: "w", validate: () => ({ ok: true, value: null }), run: async () => {} }]);
  host.commit("hidden", [{ name: "w", validate: () => ({ ok: true, value: null }), run: async () => {} }]);
  try {
    const r = await rootId(t);
    const before = await childCount(t);
    const base = { name: "w", task: "t", budgetMicros: 500, input: null };
    await assert.rejects(host.start(r, { ...base, workflow: "reviewed/missing", idempotencyKey: "a" }), /unknown or unavailable/);
    await assert.rejects(host.start(r, { ...base, workflow: "hidden/w", idempotencyKey: "b" }), /unknown or unavailable/);
    await assert.rejects(host.start(r, { ...base, workflow: "reviewed", idempotencyKey: "c" }), /unknown or unavailable/);
    assert.equal(await childCount(t), before);
  } finally {
    host.withdraw("reviewed");
    host.withdraw("hidden");
  }
});

test("cancel of a parked named workflow: one terminal, the late op is refused, and the handler is released", TIMEOUT, async () => {
  const started = deferred();
  const late = deferred<string>();
  const def: WorkflowDef = {
    name: "park",
    validate: (i) => ({ ok: true, value: i }),
    run: async (ctx: DeterministicRunContext) => {
      started.resolve();
      await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }));
      try {
        await ctx.ops.submitResult({ summary: "late" }, `${ctx.agent}:late`);
        late.resolve("accepted");
      } catch {
        late.resolve("rejected");
      }
    },
  };
  const { t, host } = harness(() => true);
  host.commit("cx", [def]);
  let id: string | undefined;
  try {
    const rec = await host.start(await rootId(t), {
      workflow: "cx/park",
      name: "w",
      task: "t",
      idempotencyKey: "cx1",
      input: null,
      budgetMicros: 500,
    });
    id = rec.id;
    await started.promise;
    await t.daemon.cancel(rec.id, 5);
    assert.equal(await late.promise, "rejected", "a submit after cancel is refused");
    await until(() => settled(t, rec.id), 5000);
    const done = await get(t, rec.id);
    assert.equal(done.exit, "cancelled");
    assert.equal((await exitEntries(t, rec.id)).length, 1, "exactly one terminal outcome");
  } finally {
    host.withdraw("cx");
    if (id !== undefined) await until(() => settled(t, id!), 5000);
  }
});

test("a deadline aborts the parked handler; the late op is refused and the single terminal is timed_out", TIMEOUT, async () => {
  const started = deferred();
  const late = deferred<string>();
  const def: WorkflowDef = {
    name: "dl",
    validate: (i) => ({ ok: true, value: i }),
    run: async (ctx: DeterministicRunContext) => {
      started.resolve();
      await new Promise<void>((res) => ctx.signal.addEventListener("abort", () => res(), { once: true }));
      try {
        await ctx.ops.submitResult({ summary: "late" }, `${ctx.agent}:late`);
        late.resolve("accepted");
      } catch {
        late.resolve("rejected");
      }
    },
  };
  const { t, host } = harness(() => true);
  host.commit("dlx", [def]);
  let id: string | undefined;
  try {
    const rec = await host.start(await rootId(t), {
      workflow: "dlx/dl",
      name: "w",
      task: "t",
      idempotencyKey: "dl1",
      input: null,
      budgetMicros: 500,
      deadlineMs: 30,
    });
    id = rec.id;
    await started.promise;
    assert.equal(await late.promise, "rejected");
    await until(() => settled(t, rec.id), 5000);
    const done = await get(t, rec.id);
    assert.equal(done.exit, "timed_out");
    assert.equal((await exitEntries(t, rec.id)).length, 1);
  } finally {
    host.withdraw("dlx");
    if (id !== undefined) await until(() => settled(t, id!), 5000);
  }
});

test("a pending or running workflow row whose definition disappeared fails explicitly on restart and is never replayed", TIMEOUT, async () => {
  const started = deferred();
  const release = deferred();
  let runs = 0;
  const def: WorkflowDef = {
    name: "gone",
    validate: (i) => ({ ok: true, value: i }),
    run: async () => {
      runs += 1;
      started.resolve();
      await release.promise;
    },
  };
  const { t, host } = harness(() => true);
  host.commit("ghost", [def]);
  try {
    const rec = await host.start(await rootId(t), {
      workflow: "ghost/gone",
      name: "w",
      task: "t",
      idempotencyKey: "g1",
      input: null,
      budgetMicros: 500,
    });
    await started.promise;
    // Restart: a new daemon over the same registry and journal, with the definition unavailable (no executor map entry).
    const restarted = new Daemon({ ...t.daemon.deps, deterministicExecutors: new Map() });
    await restarted.reconcile();
    const after = (await restarted.get(rec.id)) as AgentRecord;
    assert.ok(TERMINAL.includes(after.state), `expected terminal after restart, got ${after.state}`);
    assert.equal(after.exit, "failed", "reconcile fails the interrupted run explicitly");
    assert.equal(runs, 1, "the interrupted run was not replayed");
    await assert.rejects(
      restarted.startDeterministic(await rootId(t), {
        name: "w",
        task: "t",
        idempotencyKey: "g2",
        executor: "deterministic",
        spec: { driver: "ghost/gone", input: null },
        budgetMicros: 500,
      }),
      /unknown|driver/i,
    );
  } finally {
    release.resolve();
    host.withdraw("ghost");
  }
});

// Probe of the read-only executor view: a caller cannot install a driver through it, and the daemon refuses an unknown driver.
test("the executor map is not mutable by a caller; an installed driver is refused", TIMEOUT, async () => {
  const { t, host } = harness(() => true);
  const rogue = { driver: "rogue/evil", run: async () => {} };
  try {
    const mutable = host.executors as unknown as Map<string, unknown>; // test-only probe of the runtime boundary
    assert.throws(() => mutable.set("rogue/evil", rogue), TypeError, "a caller cannot install a driver");
    await assert.rejects(
      t.daemon.startDeterministic(await rootId(t), {
        name: "w",
        task: "t",
        idempotencyKey: "rogue-1",
        executor: "deterministic",
        spec: { driver: "rogue/evil", input: null },
        budgetMicros: 500,
      }),
      /unknown|driver/i,
    );
    assert.equal(await childCount(t), 0);
  } finally {
    host.withdraw("rogue");
  }
});

// Definitions are snapshotted at commit: reassigning run on the object afterwards does not change the executing code.
test("committed run is pinned; reassigning the definition after commit has no effect", TIMEOUT, async () => {
  const ran: string[] = [];
  const def: WorkflowDef = {
    name: "pin",
    validate: (i) => ({ ok: true, value: i }),
    run: async (ctx) => {
      ran.push("original");
      await ctx.ops.submitResult({ summary: "ok" }, `${ctx.agent}:r`);
    },
  };
  const { t, host } = harness(() => true);
  host.commit("pinx", [def]);
  try {
    def.run = async () => {
      ran.push("swapped");
    };
    const rec = await host.start(await rootId(t), { workflow: "pinx/pin", name: "w", task: "t", idempotencyKey: "pin1", input: null, budgetMicros: 500 });
    await until(() => settled(t, rec.id), 5000);
    assert.deepEqual(ran, ["original"]);
  } finally {
    host.withdraw("pinx");
  }
});
