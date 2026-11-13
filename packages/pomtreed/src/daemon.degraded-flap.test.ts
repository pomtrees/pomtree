// Tests for the `degraded` latch under a transient or flapping store: a store-down error inside a reconcile phase or a
// per-agent step latches `degraded` (hub.store.markDown); Daemon.probeStore clears it (journal write), re-arms the lost-wake
// scan and fires one reconcile pass. Known residual: see TODO(degraded-flap).
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
type Peek = {
  degraded: boolean;
  reconciler: { failures: Map<string, unknown>; reconcileNow: (boot: boolean) => Promise<void> };
};

const finishes = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

// Proxies the registry; `fault` returns an error for a call or null to forward.
function faulty<I extends object>(fault: (method: string, args: unknown[]) => unknown) {
  let target!: I;
  const proxy = new Proxy({} as I, {
    get: (_, k) =>
      typeof k === "symbol" || k === "then"
        ? undefined
        : (...args: unknown[]) => {
            const err = fault(String(k), args);
            if (err) return Promise.reject(err);
            return (target as Record<string, (...a: unknown[]) => unknown>)[String(k)]!.apply(target, args);
          },
  });
  return {
    proxy,
    bind: (x: I) => {
      target = x;
    },
  };
}

const isYieldedList = (m: string, args: unknown[]) => m === "list" && (args[0] as { state?: string } | undefined)?.state === "yielded";

// A daemon whose registry fails `yielded` lists (the budget-decisions phase) while `s.failing` is true; counts reconcile passes.
function rig(over: Parameters<typeof setup>[1] = {}) {
  const s = { failing: false, passes: 0 };
  const reg = faulty<T["fakes"]["registry"]>((m, args) => (s.failing && isYieldedList(m, args) ? busy() : null));
  const t = setup(finishes, { registry: reg.proxy, ...over });
  reg.bind(t.fakes.registry);
  const rec = (t.daemon as unknown as Peek).reconciler;
  const orig = rec.reconcileNow.bind(rec);
  rec.reconcileNow = (boot) => {
    s.passes++;
    return orig(boot);
  };
  const peek = t.daemon as unknown as Peek;
  const spawn = (name: string) => t.daemon.spawn(rootId, { name, task: "t", idempotencyKey: name });
  let rootId = "";
  return {
    s,
    t,
    peek,
    spawn,
    init: async () => {
      rootId = (await t.daemon.root()).id;
    },
  };
}

const hostHealth = async (t: T) =>
  (await t.journal.read({ agent: (await t.daemon.root()).id })).filter((e) => e.payload.kind === "ext.pomtreed.host_health").length;

test("one transient SQLITE_BUSY in one phase latches degraded; spawns 503 until probeStore runs (not on its own, not on the next pass)", async () => {
  const r = rig();
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile();
  r.s.failing = false; // the store is already healthy again
  assert.equal(r.peek.degraded, true, "a single thrown SQLITE_BUSY latches");
  await assert.rejects(() => r.spawn("a"), /store is degraded/, "spawn is refused (503) while latched");
  await r.t.daemon.reconcile(); // a clean pass does not clear it
  await sleep(30); // no watchers are started in the harness: nothing probes
  assert.equal(r.peek.degraded, true, "only probeStore clears the latch; a healthy pass does not");
  await r.t.daemon.probeStore();
  assert.equal(r.peek.degraded, false);
  await r.t.orchestrator.idle();
  const kid = (await r.spawn("b")) as AgentRecord;
  assert.ok(kid.id, "spawn accepted after the probe");
  await r.t.daemon.kill(kid.id).catch(() => {});
  await r.t.orchestrator.idle();
});

test("with startWatchers the latch self-clears within ~admitRetryMs (production default 500ms): no operator action", async () => {
  const r = rig({ reconcileMs: 3_600_000 });
  await r.init();
  const stop = r.t.daemon.startWatchers();
  try {
    r.s.failing = true;
    await r.t.daemon.reconcile();
    r.s.failing = false;
    assert.equal(r.peek.degraded, true);
    const t0 = Date.now();
    while (r.peek.degraded && Date.now() - t0 < 2000) await sleep(2);
    assert.equal(r.peek.degraded, false, "cleared by the probe timer");
    assert.ok(Date.now() - t0 < 500, `window is bounded by the probe interval (here admitRetryMs=5), was ${Date.now() - t0}ms`);
    await sleep(30);
  } finally {
    stop();
  }
});

test("a store that fails for one pass then recovers: one refused spawn window, then probe clears and fires exactly one extra pass", async () => {
  const r = rig();
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile(); // pass 1 fails
  r.s.failing = false;
  let refused = 0;
  for (let i = 0; i < 3; i++) await r.spawn(`x${i}`).catch(() => void refused++);
  assert.equal(refused, 3, "every spawn between the failure and the probe is refused");
  const before = r.s.passes;
  await r.t.daemon.probeStore(); // clears and fires one pass
  assert.equal(r.peek.degraded, false);
  assert.equal(r.s.passes - before, 1, "exactly one post-recovery pass");
  await r.t.daemon.probeStore(); // not latched: a no-op, no write
  assert.equal(r.s.passes - before, 1);
});

test("probeStore resolves only after the post-recovery pass has ended", async () => {
  const r = rig();
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile(); // latches degraded
  r.s.failing = false;
  const rec = r.peek.reconciler;
  const inner = rec.reconcileNow.bind(rec);
  let ended = false;
  rec.reconcileNow = async (boot) => {
    await sleep(20); // a pass that outlives the probe's own write
    await inner(boot);
    ended = true;
  };
  await r.t.daemon.probeStore();
  assert.equal(ended, true, "the pass ended before probeStore resolved");
});

test("a new spawn while latched is refused outright (503), not queued", async () => {
  const r = rig();
  await r.init();
  const kid = (await r.spawn("q")) as AgentRecord;
  await r.t.orchestrator.idle();
  assert.ok(kid.id);
  // Latch while a fresh spawn is pending: admit loops on sleep(admitRetryMs) rather than failing the agent.
  r.s.failing = true;
  await r.t.daemon.reconcile();
  r.s.failing = false;
  assert.equal(r.peek.degraded, true);
  const k2 = await r.t.daemon.spawn((await r.t.daemon.root()).id, { name: "q2", task: "t", idempotencyKey: "q2" }).catch((e) => e);
  assert.ok(k2 instanceof Error, "a new spawn is refused, not queued, while latched");
  await r.t.daemon.probeStore();
  await r.t.orchestrator.idle();
});

test("with the backoff disabled (storeRecoveryBackoffMs=0) a store that fails EVERY pass flaps at probe cadence: a full extra pass plus a journal write per probe", async () => {
  const r = rig({ storeRecoveryBackoffMs: 0 });
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile();
  const cycles = 5;
  const p0 = r.s.passes;
  const h0 = await hostHealth(r.t);
  let relatched = 0;
  const log = mock.method(console, "error", () => {});
  try {
    for (let i = 0; i < cycles; i++) {
      const recovered = () => log.mock.calls.filter((c) => /store write recovered/.test(String(c.arguments[0]))).length;
      const before = recovered();
      await r.t.daemon.probeStore(); // journal write succeeds (the probe does not touch the failing registry.list): clears + runs a pass that relatches
      // The pass relatches before probeStore resolves, so the clear is proven by the probe's own log line, once per cycle.
      assert.equal(recovered() - before, 1, "the probe itself cleared the latch this cycle");
      if (r.peek.degraded) relatched++;
    }
  } finally {
    log.mock.restore();
  }
  assert.equal(relatched, cycles, "relatched after every recovery: degraded flaps");
  assert.equal(r.s.passes - p0, cycles, "one extra reconcile pass per probe tick (production: every 500ms instead of reconcileMs=30s)");
  assert.equal((await hostHealth(r.t)) - h0, cycles, "one host-health journal entry per probe, unbounded while the flap lasts");
  // No agent errors/alerts are journaled (store-down is neither journaled nor counted), so the storm is silent apart from stderr.
  assert.equal((r.t.daemon as unknown as Peek).reconciler.failures.size, 0);
});

const errorEntries = async (t: T) => (await t.journal.read({ agent: (await t.daemon.root()).id })).filter((e) => e.payload.kind === "error");

test("a recovery pass that re-latches does not trigger another recovery pass on the next probes (no pass-per-probe storm)", async () => {
  const r = rig({ storeRecoveryBackoffMs: 10_000 });
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile();
  const p0 = r.s.passes;
  for (let i = 0; i < 5; i++) {
    await r.t.daemon.probeStore();
  }
  assert.equal(r.s.passes - p0, 1, "exactly one recovery pass while the same failure persists");
});

test("backoff doubles per consecutive re-latch (capped) and resets after a recovery pass that does not re-latch", async () => {
  let clock = 1_000_000;
  const r = rig({ now: () => clock, storeRecoveryBackoffMs: 100, storeRecoveryBackoffMaxMs: 350, storeRelatchAlertAfter: 99 });
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile();
  const probe = async () => {
    if (!r.peek.degraded) await r.t.daemon.reconcile(); // a skipped recovery pass left it unlatched: the periodic pass relatches
    const p = r.s.passes;
    await r.t.daemon.probeStore();
    return r.s.passes - p;
  };
  assert.equal(await probe(), 1, "first recovery pass fires immediately"); // relatch 1: wait 200ms
  clock += 199;
  assert.equal(await probe(), 0, "inside the 200ms window");
  clock += 1;
  assert.equal(await probe(), 1); // relatch 2: wait min(400, 350)=350ms
  clock += 349;
  assert.equal(await probe(), 0, "capped window not yet elapsed");
  clock += 1;
  assert.equal(await probe(), 1); // relatch 3: still the 350ms cap
  clock += 350;
  r.s.failing = false; // the failure ends: this recovery pass is clean
  assert.equal(await probe(), 1);
  assert.equal(r.peek.degraded, false, "a clean recovery pass leaves the store unlatched");
  r.s.failing = true;
  await r.t.daemon.reconcile(); // latch again with no clock advance: the reset allows an immediate recovery pass
  assert.equal(await probe(), 1, "backoff was reset");
});

test("N consecutive re-latches raise exactly one deduplicated error entry per episode", async () => {
  let clock = 1_000_000;
  const r = rig({ now: () => clock, storeRecoveryBackoffMs: 10, storeRecoveryBackoffMaxMs: 10, storeRelatchAlertAfter: 3 });
  await r.init();
  r.s.failing = true;
  await r.t.daemon.reconcile();
  for (let i = 0; i < 8; i++) {
    clock += 100;
    await r.t.daemon.probeStore();
  }
  const errs = (await errorEntries(r.t)).filter((e) => /re-latched/.test(String((e.payload as { message?: string }).message)));
  assert.equal(errs.length, 1, "one alert for the whole episode");
  r.s.failing = false; // episode ends with a clean recovery pass
  clock += 100;
  await r.t.daemon.probeStore();
  r.s.failing = true;
  await r.t.daemon.reconcile();
  for (let i = 0; i < 4; i++) {
    clock += 100;
    await r.t.daemon.probeStore();
  }
  const all = (await errorEntries(r.t)).filter((e) => /re-latched/.test(String((e.payload as { message?: string }).message)));
  assert.equal(all.length, 2, "a new episode alerts once more");
});

test("a plain (non-store) phase error does NOT latch degraded", async () => {
  const r = rig();
  await r.init();
  const reg = r.t.fakes.registry as unknown as { list: (...a: unknown[]) => Promise<unknown> };
  const orig = reg.list.bind(reg);
  let once = true;
  // The facade proxies list; fail via the rig's registry by making a plain error on the yielded list.
  r.t.daemon.deps.registry.list = ((...a: unknown[]) => {
    if (once && isYieldedList("list", a)) {
      once = false;
      return Promise.reject(new Error("boom"));
    }
    return orig(...a);
  }) as typeof r.t.daemon.deps.registry.list;
  await r.t.daemon.reconcile();
  assert.equal(r.peek.degraded, false);
  await r.spawn("ok").then((a) => r.t.daemon.kill(a.id).catch(() => {}));
  await r.t.orchestrator.idle();
});

test("a per-agent step store-down error latches but is not counted toward the agent's backoff", async () => {
  let clock = 1_000_000;
  const r = rig({ now: () => clock, reconcileFailureThreshold: 2, reconcileBackoffMs: 1000 });
  await r.init();
  const real = r.t.daemon.deps.orchestrator;
  let starts = 0;
  const origStart = real.start.bind(real);
  real.start = (async (...args: Parameters<typeof origStart>) => {
    starts++;
    if (starts <= 4) throw busy();
    return origStart(...args);
  }) as typeof real.start;
  const root = await r.t.daemon.root();
  const a = await r.t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "pa",
    task: "t",
    host: "h1",
    budgetMicros: 100_000,
    idempotencyKey: "pa",
  });
  for (let i = 0; i < 4; i++) await r.t.daemon.reconcile();
  assert.equal(starts, 4, "never backed off: retried every pass despite 4 consecutive failures (threshold 2)");
  assert.equal(r.peek.reconciler.failures.size, 0, "store-down errors are not counted");
  assert.equal(r.peek.degraded, true);
  const errs = (await r.t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.equal(errs.length, 0, "no per-agent error or alert journaled");
  await r.t.daemon.probeStore();
  await r.t.daemon.reconcile();
  await r.t.orchestrator.idle();
  await r.t.daemon.kill(a.id).catch(() => {});
  await r.t.orchestrator.idle();
  await sleep(10);
});
