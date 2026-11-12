// Crash-recovery and reconcile tests for recover/reconcile/settle/resume. Two kinds of test live here:
//   - convergence: seed the store as a crash at one await point would leave it, run recover() twice, assert the
//     second pass changes nothing and the final state is legal;
//   - races: inject delays and failures at checkpoint writes and yields to check one resume, one generation bump,
//     and correct restart accounting.
//
// Overlapping behavior already pinned elsewhere (not duplicated here): in-flight `live` placeholder and
// no generation storm (daemon.s2b.test.ts, daemon.regression.test.ts), resume dedupe and placement sync
// (daemon.s2.test.ts), lost-wake boot-only scan (daemon.restart.test.ts), pause order
// (daemon.folders.test.ts), adopt vs forced resume and fence-revoke-order (daemon.yield.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, CheckpointStore, JournalEntry } from "@pomtree/core";
import { get, kinds, setup, spawnSpec, until } from "./test-setup.ts";

type T = ReturnType<typeof setup>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = async (t: T, id: string) => ["exited", "reaped"].includes((await get(t, id)).state);
const finishes = async (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
const restarts = (es: JournalEntry[]) => es.filter((e) => e.payload.kind === "error" && (e.payload as { message: string }).message.startsWith("auto-restart:"));
const cpFor = (a: AgentRecord, gen: number, wait: unknown = { kind: "message" }) => ({
  agent: a.id,
  generation: gen,
  host: "h1",
  sessionRef: "sha256:fake",
  workspace: `ws-${a.id}`,
  node: "h1",
  ingested: null,
  wait: wait as never,
  remainingBudgetMicros: 50_000,
  imageDigest: "img@sha256:x",
  envManifestHash: null,
  template: "code",
  templateDigest: null,
  resumeLevel: "session" as const,
});

// A checkpoint store whose write can be gated or failed per key; bind() points it at the fake once setup() has built it.
function hookedCheckpoints(onWrite: (key: string) => Promise<void>) {
  let target!: CheckpointStore;
  const store: CheckpointStore = {
    async write(c, key) {
      await onWrite(key);
      return target.write(c, key);
    },
    latest: (agent) => target.latest(agent),
    read: (id) => target.read(id),
  };
  return {
    store,
    bind: (t: T) => {
      target = t.fakes.checkpoints;
    },
  };
}

async function seed(
  t: T,
  name: string,
  o: {
    state?: "running" | "yielded";
    cp?: boolean | { key: string };
    folder?: boolean;
    sandbox?: "alive" | "dead";
    marker?: { key: string };
    host?: string;
    parent?: string;
  } = {},
): Promise<AgentRecord> {
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const a0 = await reg.create({
    spec: spawnSpec,
    parent: o.parent ?? root.id,
    name,
    task: "t",
    host: o.host ?? "h1",
    budgetMicros: 100_000,
    idempotencyKey: name,
  });
  const a = await reg.transition(a0.id, a0.generation, "running", { idempotencyKey: `${name}-run` });
  if (o.folder) await t.daemon.deps.workspace.create(a.id, {});
  if (o.sandbox) {
    const h = await t.fakes.hooks.raw.sandbox.start(
      { agent: a.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }] },
      `${name}-sb`,
    );
    await reg.setSandbox(a.id, a.generation, h.id, `${name}-sb-set`);
    if (o.sandbox === "dead") await t.fakes.hooks.raw.sandbox.kill(h.id, `test-kill:${h.id}`);
  }
  if (o.marker)
    await t.journal.append({
      agent: a.id,
      host: "h1",
      generation: a.generation,
      payload: { kind: "pausing", reason: "yield", key: o.marker.key, attempt: "at0", wait: { kind: "message" }, inbox: [] },
      idempotencyKey: `${a.id}:${a.generation}:pausing:${o.marker.key}`,
    });
  if (o.cp) await t.daemon.deps.checkpoints.write(cpFor(a, a.generation), typeof o.cp === "object" ? o.cp.key : `${name}-cp`);
  if (o.state === "yielded") return reg.transition(a.id, a.generation, "yielded", { idempotencyKey: `${name}-y` });
  return get(t, a.id);
}

// Registry plus journal, in a form where "the pass changed nothing" is deepEqual.
async function snapshot(t: T) {
  const rows = await t.daemon.list();
  const agents = rows.map((a) => `${a.id}|${a.state}|g${a.generation}|${a.exit ?? "-"}|${a.sandbox ?? "-"}`).sort();
  const journal: string[] = [];
  for (const a of rows) for (const e of await t.journal.read({ agent: a.id })) journal.push(`${e.agent}#${e.generation}:${kinds([e])[0]}`);
  return { agents, journal };
}

const quiesce = async (t: T, idle: boolean) => (idle ? await t.orchestrator.idle() : await sleep(40));

// Run recover() twice; the second pass must change nothing. Returns the state after the first pass.
async function converge(t: T, idle = true) {
  await t.daemon.recover();
  await quiesce(t, idle);
  const first = await snapshot(t);
  await t.daemon.recover();
  await quiesce(t, idle);
  assert.deepEqual(await snapshot(t), first, "the second recover() changed the registry or journal");
  return first;
}

// Stop whatever the test left running. A double resume (the failure these tests guard against) can leave a superseded run that kill()
// does not reach, so exit every container and bound the wait instead of hanging the suite.
async function teardown(t: T, id: string) {
  await t.daemon.kill(id).catch(() => {});
  for (const [sb, v] of t.fakes.hooks.raw.sandbox.running) if (v.exitCode === null) t.fakes.hooks.exitSandbox(sb, 143);
  await Promise.race([t.orchestrator.idle(), sleep(1000)]);
}

const LEGAL = ["exited", "reaped", "yielded"];
const settledLegal = async (t: T, id: string) => assert.ok(LEGAL.includes((await get(t, id)).state), `illegal final state ${(await get(t, id)).state}`);

// ---- convergence per crash point ----------------------------------------------------------------------

test("crash after the running transition, before any container: restarted from scratch once, converges", async () => {
  const t = setup(finishes);
  const a = await seed(t, "c1");
  await converge(t);
  const after = await get(t, a.id);
  assert.equal(after.generation, a.generation + 1);
  await settledLegal(t, a.id);
  assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1);
});

test("crash after the running transition with a checkpoint and folder: force-resumed once, converges", async () => {
  const t = setup(finishes);
  const a = await seed(t, "c1b", { cp: true, folder: true });
  await converge(t);
  assert.equal((await get(t, a.id)).generation, a.generation + 1);
  await settledLegal(t, a.id);
});

test("crash after the pausing marker with the container still alive: adopted, not parked or resumed", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await seed(t, "c2", { folder: true, sandbox: "alive", marker: { key: "y1" } });
  const sbId = (await get(t, a.id)).sandbox as string;
  await converge(t, false);
  const after = await get(t, a.id);
  assert.equal(after.state, "running");
  assert.equal(after.generation, a.generation);
  assert.equal(t.fakes.hooks.raw.sandbox.running.get(sbId)?.exitCode, null, "the live container is not killed");
  await t.daemon.cancel(a.id);
  await t.orchestrator.idle();
});

test("crash after the container stop (marker, no checkpoint, folder kept): the pause is completed, converges to yielded", async () => {
  const t = setup(finishes);
  const a = await seed(t, "c3", { folder: true, sandbox: "dead", marker: { key: "y1" } });
  await converge(t, false);
  const after = await get(t, a.id);
  assert.equal(after.state, "yielded");
  assert.equal(after.generation, a.generation);
  assert.ok(await t.daemon.deps.checkpoints.latest(a.id), "checkpoint written by completePause");
});

test("crash after the checkpoint, before `yielded`: the checkpoint is reused, converges to yielded", async () => {
  const t = setup(finishes);
  const a = await seed(t, "c4", { folder: true, sandbox: "dead", marker: { key: "y1" } });
  // The key yield() uses, so completePause's same-key write returns this very checkpoint.
  const pre = await t.daemon.deps.checkpoints.write(cpFor(a, a.generation), `${a.id}:${a.generation}:yield:y1`);
  await converge(t, false);
  assert.equal((await get(t, a.id)).state, "yielded");
  assert.equal((await t.daemon.deps.checkpoints.latest(a.id))?.id, pre.id, "no second checkpoint");
});

test("settle crashed after the sandbox stop and the auto-restart record: reconcile resumes, restart count stays within bounds", async () => {
  const t = setup(finishes, { maxRestarts: 3 });
  const a = await seed(t, "c5", { cp: true, folder: true });
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "error", message: "auto-restart: resuming after host_stopped (1/3)" },
    idempotencyKey: `${a.id}:${a.generation}:auto-restart`,
  });
  await converge(t);
  await settledLegal(t, a.id);
  assert.equal((await get(t, a.id)).generation, a.generation + 1);
  assert.ok(restarts(await t.journal.read({ agent: a.id })).length <= 3);
});

test("crash between `exited` and the tail: the tail is replayed once (reaped, exit journaled), converges", async () => {
  const t = setup(finishes);
  const a = await seed(t, "c6");
  await t.daemon.deps.registry.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: "c6-x" });
  await converge(t, false);
  assert.equal((await get(t, a.id)).state, "reaped");
  const ks = kinds(await t.journal.read({ agent: a.id }));
  assert.equal(ks.filter((k) => k === "exited:succeeded").length, 1);
});

test("crash after the generation bump, before runResumed: reconcile re-fences with exactly one more bump, converges", async () => {
  const t = setup(finishes);
  const a = await seed(t, "c7", { cp: true, state: "yielded" });
  const reg = t.daemon.deps.registry;
  const bumped = await reg.bumpGeneration(a.id, "h1", "c7-bump");
  await reg.transition(a.id, bumped.generation, "running", { idempotencyKey: "c7-run2" });
  await converge(t);
  await settledLegal(t, a.id);
  assert.equal((await get(t, a.id)).generation, bumped.generation + 1);
});

// ---- cancel wins over a yield in progress (characterization) ---------------------------------------------------

test("a cancel landing during the yield's checkpoint write wins: the agent is never parked, and recover() then changes nothing", async () => {
  let aId = "";
  const hook = hookedCheckpoints(async (key) => {
    if (key.includes(":yield:") && aId) {
      void t.daemon.cancel(aId);
      await sleep(30);
    }
  });
  const t = setup(
    async (c) => {
      aId = c.agent;
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
      await c.stopped;
    },
    { checkpoints: hook.store },
  );
  hook.bind(t);
  await t.spawn();
  await until(async () => aId !== "" && (await done(t, aId)));
  await t.orchestrator.idle();
  const ks = kinds(await t.journal.read({ agent: aId }));
  assert.ok(!ks.includes("yielded"), "a cancelled agent is not parked");
  assert.ok(ks.includes("exited:cancelled"));
  const before = await snapshot(t);
  await t.daemon.recover();
  await t.orchestrator.idle();
  assert.deepEqual(await snapshot(t), before);
});

// ---- races between settle, reconcile and operator resume -------------------------------------------------------

test("settle racing a reconcile tick: one resume, one generation bump, restarts accounted", async () => {
  let runs = 0;
  let gateOpen = false;
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const hook = hookedCheckpoints(async (key) => {
    if (key.endsWith(":auto-restart") && !gateOpen) {
      reached();
      await held;
    }
  });
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      if (++runs === 1) {
        const rec = await get(t, c.agent);
        await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), "cp-key");
        await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
        t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 143);
        return;
      }
      await c.stopped;
    },
    { checkpoints: hook.store, maxRestarts: 3 },
  );
  hook.bind(t);
  await t.spawn();
  await Promise.race([
    atGate, // settle is inside tryAutoRestart: live deleted, sandbox cleared, resume not yet issued
    sleep(1500).then(async () => {
      throw new Error(`settle never reached tryAutoRestart: ${JSON.stringify(kinds(await t.journal.read({ agent: aId })))}`);
    }),
  ]);
  await t.daemon.reconcile(); // a tick lands in that window
  gateOpen = true;
  release();
  await sleep(150);
  const after = await get(t, aId);
  const es = await t.journal.read({ agent: aId });
  try {
    // The tick finds the claim held by settle and skips, so settle's own auto-restart is the only resume.
    assert.equal(after.state, "running", "the resumed agent survives the stale settle");
    assert.equal(kinds(es).filter((k) => k === "resumed").length, 1, "one resume");
    assert.equal(after.generation, 1, "generation bumped once");
    assert.equal(after.generation, restarts(es).length, "every bump is charged to maxRestarts");
  } finally {
    await teardown(t, aId);
  }
});

test("an operator resume finishing inside a reconcile tick's stopCheckpoint does not get a second bump", async () => {
  let gateOpen = false;
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const hook = hookedCheckpoints(async (key) => {
    if (key.endsWith(":recover") && !gateOpen) {
      reached();
      await held;
    }
  });
  const t = setup(async (c) => void (await c.stopped), { checkpoints: hook.store });
  hook.bind(t);
  const a = await seed(t, "b1b", { cp: true, folder: true });
  const tick = t.daemon.reconcile(); // reads running, no live, checkpoint -> parks in stopCheckpoint
  await atGate;
  await t.daemon.resumeAgent(a.id, "operator", { forced: true }); // starts and finishes inside the tick's window
  gateOpen = true;
  release();
  await tick;
  await sleep(50);
  try {
    assert.equal((await get(t, a.id)).generation, a.generation + 1, "the stale tick did not bump again");
  } finally {
    await teardown(t, a.id);
  }
});

// ---- a decider acting on a stale observed generation after another resume already claimed the agent -------------

// A gate that parks the first checkpoint write whose key ends with `suffix` until release() is called.
function gateCheckpoint(suffix: string) {
  let open = false;
  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const held = new Promise<void>((r) => (release = r));
  const hook = hookedCheckpoints(async (key) => {
    if (key.endsWith(suffix) && !open) {
      reached();
      await held;
    }
  });
  return {
    hook,
    atGate,
    release: () => {
      open = true;
      release();
    },
  };
}

const withTimeout = <T>(p: Promise<T>, what: string) => Promise.race([p, sleep(1500).then(() => Promise.reject(new Error(`never reached: ${what}`)))]);

test("an operator resume inside settle's tryAutoRestart checkpoint window: the resumed agent survives, one bump, no failed finish", async () => {
  const g = gateCheckpoint(":auto-restart");
  let runs = 0;
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      if (++runs === 1) {
        const rec = await get(t, c.agent);
        await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), "cp-key");
        await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
        t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 143);
        return;
      }
      await c.stopped;
    },
    { checkpoints: g.hook.store, maxRestarts: 3 },
  );
  g.hook.bind(t);
  await t.spawn();
  await withTimeout(g.atGate, "settle inside tryAutoRestart");
  await t.daemon.resumeAgent(aId, "operator resumed you", { forced: true }); // lands inside settle's checkpoint window
  g.release();
  await sleep(150);
  try {
    const after = await get(t, aId);
    const ks = kinds(await t.journal.read({ agent: aId }));
    assert.equal(after.state, "running", `the operator-resumed agent is not finished by the stale settle: ${JSON.stringify(ks)}`);
    assert.equal(after.generation, 1, "one bump (the operator's)");
    assert.ok(!ks.some((k) => k.startsWith("exited")), `no exit journaled: ${JSON.stringify(ks)}`);
  } finally {
    await teardown(t, aId);
  }
});

test("an operator resume inside settle's resumeInterrupted checkpoint window: the resumed agent survives, one bump, no failed finish", async () => {
  const g = gateCheckpoint(":interrupt");
  let runs = 0;
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      if (++runs === 1) {
        for (;;) {
          const peek = (await c.api("GET", "/v1/agents/self/inbox?peek=1")).body as { interrupt?: boolean }[];
          if (peek.some((x) => x.interrupt)) return; // the mailbox extension aborts; the process exits without settling
          await sleep(5);
        }
      }
      await c.stopped;
    },
    { checkpoints: g.hook.store },
  );
  g.hook.bind(t);
  await t.spawn();
  await until(() => aId !== "");
  const rec = await get(t, aId);
  await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), "cp-key");
  await t.operator("POST", `/v1/agents/${aId}/message`, { body: "change course", mode: "interrupt", idempotencyKey: "i1" });
  await withTimeout(g.atGate, "settle inside resumeInterrupted");
  await t.daemon.resumeAgent(aId, "operator resumed you", { forced: true });
  g.release();
  await sleep(150);
  try {
    const after = await get(t, aId);
    const ks = kinds(await t.journal.read({ agent: aId }));
    assert.equal(after.state, "running", `the operator-resumed agent is not finished by the stale settle: ${JSON.stringify(ks)}`);
    assert.equal(after.generation, 1, "one bump (the operator's)");
    assert.ok(!ks.some((k) => k.startsWith("exited")), `no exit journaled: ${JSON.stringify(ks)}`);
  } finally {
    await teardown(t, aId);
  }
});

// The watchdog's kill_resume decides on the record it listed, then awaits (restart timestamp write, checkpoint read) before it
// resumes. An operator resume that completes in that gap makes the decision stale.
test("a watchdog kill_resume decided before an operator resume completed does not bump again", async () => {
  let clock = Date.now();
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100, maxRetries: 3 },
  });
  const a = await seed(t, "r3b-wd", { cp: true, folder: true });
  const set = t.fakes.watchdogs.set.bind(t.fakes.watchdogs);
  t.fakes.watchdogs.set = async (id, st, key) => {
    if (key.includes("watchdog-restart")) {
      reached();
      await held;
    }
    return set(id, st, key);
  };
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  const sweep = t.daemon.sweepWatchdogs(); // kill_resume decided on generation G
  await withTimeout(atGate, "watchdog kill_resume");
  await t.daemon.resumeAgent(a.id, "operator resumed you", { forced: true }); // G -> G+1 inside the gap
  release();
  await sweep;
  await sleep(50);
  try {
    assert.equal((await get(t, a.id)).generation, a.generation + 1, "the stale watchdog decision did not bump again");
  } finally {
    await teardown(t, a.id);
  }
});

test("a forced resume carrying a stale observed generation is a no-op: no bump, no `resumed`", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await seed(t, "r3b-obs", { cp: true, folder: true });
  await t.daemon.resumeAgent(a.id, "first", { forced: true }); // G -> G+1
  const resumed = () => t.journal.read({ agent: a.id }).then((es) => kinds(es).filter((k) => k === "resumed").length);
  try {
    const rec = await t.daemon.resumeAgent(a.id, "stale", { forced: true, observedGeneration: a.generation });
    assert.equal(rec.generation, a.generation + 1, "returns the current record");
    assert.equal((await get(t, a.id)).generation, a.generation + 1, "no second bump");
    assert.equal(await resumed(), 1);
    const fresh = await t.daemon.resumeAgent(a.id, "fresh", { forced: true, observedGeneration: a.generation + 1 });
    assert.equal(fresh.generation, a.generation + 2, "a matching observed generation resumes");
  } finally {
    await teardown(t, a.id);
  }
});

// Gap: resumeAgent returns (claim released) before runResumed sets its `live` placeholder; the `starting` map covers it.
// Gate runResumed's own checkpoints.latest read (the second one of a resume) and land a reconcile tick in that gap.
test("a reconcile tick between resumeAgent's return and runResumed's live placeholder does not bump again", async () => {
  let latestCalls = 0;
  let armed = false;
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let target!: CheckpointStore;
  const store: CheckpointStore = {
    write: (c, key) => target.write(c, key),
    read: (id) => target.read(id),
    async latest(agent) {
      if (armed && ++latestCalls === 2) {
        reached();
        await held;
      }
      return target.latest(agent);
    },
  };
  const t = setup(async (c) => void (await c.stopped), { checkpoints: store });
  target = t.fakes.checkpoints;
  const a = await seed(t, "r3b-gap", { cp: true, folder: true });
  armed = true;
  await t.daemon.resumeAgent(a.id, "operator resumed you", { forced: true }); // returns with runResumed parked before its placeholder
  await withTimeout(atGate, "runResumed before its live placeholder");
  await t.daemon.reconcile(); // running, no live entry, claim free
  release();
  await sleep(100);
  try {
    assert.equal((await get(t, a.id)).generation, a.generation + 1, "the tick did not bump a resume that is still starting");
  } finally {
    await teardown(t, a.id);
  }
});

// No window: a wake (non-forced) re-reads the state inside the resume, so it cannot follow a resume that already ran, and
// concurrent resumes share one in-flight promise (daemon.s2.test.ts).
test("a wake that follows a completed resume is refused by the state check, not by a compare (no bump)", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await seed(t, "r3b-wake", { cp: true, folder: true });
  await t.daemon.resumeAgent(a.id, "operator", { forced: true });
  await assert.rejects(t.daemon.resumeAgent(a.id, "wake"), /not yielded/);
  try {
    assert.equal((await get(t, a.id)).generation, a.generation + 1);
  } finally {
    await teardown(t, a.id);
  }
});

// ---- yield that fails or is cancelled after its pausing marker: the agent must not be parked -----------------
test("a yield that throws after the pausing marker, then a crash with the container dead: the agent is not parked", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.stopped;
  });
  const a = (await t.spawn()) as AgentRecord;
  await until(() => aId !== "" && t.fakes.hooks.raw.sandbox.running.size === 1);
  // The marker append lands, then the caller sees a failure (a lost reply / a throw right after the write): the
  // yield aborts before it stops anything, so the agent keeps running with a stale marker.
  const j = t.daemon.deps.journal;
  const append = j.append.bind(j);
  j.append = async (e) => {
    const r = await append(e);
    if (e.payload.kind === "pausing") {
      j.append = append;
      throw new Error("injected: failure after the pausing marker was journaled");
    }
    return r;
  };
  await assert.rejects(t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" }));
  const ks = kinds(await t.journal.read({ agent: a.id }));
  assert.ok(ks.includes("pausing"), "precondition: the marker was journaled");
  assert.equal((await get(t, a.id)).state, "running", "precondition: the agent is still running after the failed yield");
  // Daemon crash with the container dead: no live entry, the container gone, the folder kept.
  const sb = (await get(t, a.id)).sandbox as string;
  (t.daemon as unknown as { live: Map<string, unknown> }).live.delete(a.id);
  await t.fakes.hooks.raw.sandbox.kill(sb, `test-kill:${sb}`);
  try {
    await t.daemon.recover();
    await sleep(50);
    assert.notEqual((await get(t, a.id)).state, "yielded", "a failed yield must not park the agent on recovery");
  } finally {
    await teardown(t, a.id);
  }
});

const pm = (t: T, a: AgentRecord) => (t.daemon as unknown as { pausingMarker(a: AgentRecord): Promise<unknown> }).pausingMarker(a);

const abortMsgs = async (t: T, id: string) =>
  (await t.journal.read({ agent: id })).flatMap((e) =>
    e.payload.kind === "error" && /^pause-aborted:/.test((e.payload as { message: string }).message) ? [e] : [],
  );

// Fail the journal append of the first `pausing` marker after it lands (the marker is journaled, the caller sees a throw).
function failAfterMarker(t: T) {
  const j = t.daemon.deps.journal;
  const append = j.append.bind(j);
  j.append = async (e) => {
    const r = await append(e);
    if (e.payload.kind === "pausing") {
      j.append = append;
      throw new Error("injected: failure after the pausing marker was journaled");
    }
    return r;
  };
}

async function crashDead(t: T, id: string) {
  const sb = (await get(t, id)).sandbox as string;
  (t.daemon as unknown as { live: Map<string, unknown> }).live.delete(id);
  await t.fakes.hooks.raw.sandbox.kill(sb, `test-kill:${sb}`);
}

async function startRunning(t: T) {
  const a = (await t.spawn()) as AgentRecord;
  await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
  return a;
}

test("a yield that throws after the marker journals a generation-scoped pause-aborted naming the attempt", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await startRunning(t);
  failAfterMarker(t);
  await assert.rejects(t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" }));
  try {
    const marker = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "pausing");
    const attempt = (marker?.payload as unknown as { attempt?: string } | undefined)?.attempt;
    assert.ok(attempt, "the marker carries an attempt id");
    const ab = await abortMsgs(t, a.id);
    assert.equal(ab.length, 1);
    assert.equal(ab[0]?.generation, a.generation);
    assert.equal((ab[0]?.payload as unknown as { message: string } | undefined)?.message, `pause-aborted: ${attempt}`);
  } finally {
    await teardown(t, a.id);
  }
});

test("a retried yield (same key) after an abort is a new attempt: its own marker, and the first abort does not end it", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await startRunning(t);
  failAfterMarker(t);
  await assert.rejects(t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" }));
  const m = await pm(t, await get(t, a.id));
  assert.equal(m, null, "the aborted attempt's marker is ended");
  // The retry journals a fresh marker (its own attempt) and then fails at the checkpoint write.
  const store = t.daemon.deps.checkpoints;
  const write = store.write.bind(store);
  store.write = async () => {
    store.write = write;
    throw new Error("injected: crash before the checkpoint write");
  };
  await assert.rejects(t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" }));
  const markers = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "pausing");
  assert.equal(markers.length, 2, "the retry is a new attempt with its own marker");
  const att = markers.map((m) => (m.payload as unknown as { attempt: string }).attempt);
  assert.notEqual(att[0], att[1]);
  assert.equal((await abortMsgs(t, a.id)).length, 1, "a throw after the stop began keeps the marker for completePause");
  assert.ok(await pm(t, await get(t, a.id)), "the second attempt's marker is live; the first abort did not end it");
  await teardown(t, a.id);
});

test("a retried yield that completes parks the agent normally after an earlier aborted attempt", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await startRunning(t);
  failAfterMarker(t);
  await assert.rejects(t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" }));
  const cp = await t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" });
  assert.ok(cp.id);
  assert.equal((await get(t, a.id)).state, "yielded");
  await teardown(t, a.id);
});

test("an unaborted marker of the live attempt is still completed (crash between marker and abort, no execution evidence)", async () => {
  const t = setup(async () => {});
  const a = await seed(t, "b2-live", { folder: true, sandbox: "dead", marker: { key: "y1" } });
  await t.daemon.recover();
  await sleep(50);
  assert.equal((await get(t, a.id)).state, "yielded");
});

test("a legitimately completed pause is unaffected (no abort record, marker ends the run as yielded)", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await startRunning(t);
  await t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" });
  try {
    assert.equal((await get(t, a.id)).state, "yielded");
    assert.equal((await abortMsgs(t, a.id)).length, 0);
  } finally {
    await teardown(t, a.id);
  }
});

test("read-time guard: a marker followed by the agent's own action (lost abort write) is ignored", async () => {
  const t = setup(async () => {});
  const a = await seed(t, "b2-guard", { folder: true, sandbox: "dead", marker: { key: "y1" } });
  const rec = await get(t, a.id);
  assert.ok(await pm(t, rec), "precondition: the marker is live");
  assert.ok(await pm(t, rec), "precondition: the marker is live");
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "message_sent", channel: "discord", purpose: "status", subject: "s" } as never,
    idempotencyKey: "act",
  });
  assert.equal(await pm(t, rec), null);
  await t.daemon.recover();
  await sleep(50);
  assert.notEqual((await get(t, a.id)).state, "yielded");
});

test("cancel-wins: a cancel during yield's checkpoint write never parks, and the aborted marker survives a later crash", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await startRunning(t);
  const store = t.daemon.deps.checkpoints;
  const write = store.write.bind(store);
  store.write = async (c, k) => {
    await t.daemon.cancel(a.id).catch(() => {});
    return write(c, k);
  };
  await assert.rejects(t.daemon.yield(a.id, { wait: { kind: "message" }, idempotencyKey: "y1" }));
  try {
    assert.notEqual((await get(t, a.id)).state, "yielded");
    assert.equal((await abortMsgs(t, a.id)).length, 1);
    assert.equal(await pm(t, await get(t, a.id)), null);
  } finally {
    await teardown(t, a.id);
  }
});

// ---- reconcile pass scheduling: no unbounded queueing, timer re-arm ------------------------------------------
test("reconcile passes do not queue without bound when a pass outlasts the interval", async () => {
  const t = setup(async () => {});
  const reg = t.daemon.deps.registry;
  const list = reg.list.bind(reg);
  let passes = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  reg.list = async (q) => {
    if (q?.state === "pending" && ++passes === 1) await held; // first pass is slow
    return list(q);
  };
  const calls = Array.from({ length: 5 }, () => t.daemon.reconcile());
  await sleep(20);
  release();
  await Promise.all(calls);
  assert.ok(passes <= 2, `${passes} passes ran for 5 overlapping triggers; want at most one running and one pending`);
});

// Counts reconcile passes (one `pending` list per pass); the first `gate` passes block until released.
function countPasses(t: T, gate = 0) {
  const reg = t.daemon.deps.registry;
  const list = reg.list.bind(reg);
  const c = { started: 0, running: 0, maxRunning: 0, fail: false, release: () => {} };
  const held = new Promise<void>((r) => (c.release = r));
  reg.list = async (q) => {
    if (q?.state === "pending") {
      const n = ++c.started;
      c.maxRunning = Math.max(c.maxRunning, ++c.running);
      try {
        if (n <= gate) await held;
        if (c.fail) throw new Error("injected: pass failure");
      } finally {
        c.running--;
      }
    }
    return list(q);
  };
  return c;
}

test("a trigger during a running pass queues exactly one follow-up that starts after it", async () => {
  const t = setup(async () => {});
  const c = countPasses(t, 1);
  const first = t.daemon.reconcile();
  await sleep(20);
  const second = t.daemon.reconcile();
  await sleep(20);
  assert.equal(c.started, 1, "the follow-up waits for the running pass");
  c.release();
  await Promise.all([first, second]);
  assert.equal(c.started, 2);
  assert.equal(c.maxRunning, 1);
});

test("triggers while a pass is queued share the queued promise", async () => {
  const t = setup(async () => {});
  const c = countPasses(t, 1);
  const first = t.daemon.reconcile();
  await sleep(20);
  const q1 = t.daemon.reconcile();
  const q2 = t.daemon.reconcile();
  assert.strictEqual(q1, q2);
  assert.notStrictEqual(q1, first);
  c.release();
  await Promise.all([first, q1]);
  assert.equal(c.started, 2);
  const later = t.daemon.reconcile(); // idle again: a fresh pass, not the settled one
  assert.notStrictEqual(later, q1);
  await later;
  assert.equal(c.started, 3);
});

test("the periodic timer does not fire during a running pass and re-arms after it ends", async () => {
  const t = setup(async () => {}, { reconcileMs: 20 });
  const c = countPasses(t, 1);
  const stop = t.daemon.startWatchers();
  try {
    await sleep(150); // several intervals elapse while pass 1 is held
    assert.equal(c.started, 1, "no tick stacks behind the running pass");
    c.release();
    await until(async () => c.started >= 3, 2000);
    assert.equal(c.maxRunning, 1);
  } finally {
    stop();
  }
});

test("stopping the watchers cancels the reconcile timer", async () => {
  const t = setup(async () => {}, { reconcileMs: 20 });
  const c = countPasses(t);
  const stop = t.daemon.startWatchers();
  await until(async () => c.started >= 1, 2000);
  stop();
  await sleep(30); // let an in-flight pass finish
  const n = c.started;
  await sleep(100);
  assert.equal(c.started, n, "no pass after stop");
});

test("an erroring pass still reschedules the timer", async () => {
  const t = setup(async () => {}, { reconcileMs: 20 });
  const c = countPasses(t);
  c.fail = true;
  const stop = t.daemon.startWatchers();
  const log = console.error;
  console.error = () => {};
  try {
    await until(async () => c.started >= 3, 2000);
  } finally {
    console.error = log;
    stop();
  }
});

// ---- lost-wake scan retry after per-agent or store failure ---------------------------------------------------
test("a per-agent wake failure does not mark the lost-wake scan done: the next pass retries", async () => {
  const t = setup(finishes);
  const a = await seed(t, "b4", { cp: true, state: "yielded" });
  await t.daemon.deps.mailbox.send(a.id, { kind: "human_message", from: { channel: "c", sender: "s" }, body: "hi" }, "b4-m");
  const reg = t.daemon.deps.registry;
  const bump = reg.bumpGeneration.bind(reg);
  let failed = false;
  reg.bumpGeneration = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("injected: store hiccup during wake");
    }
    return bump(...args);
  };
  await t.daemon.recover(); // boot pass: the wake fails and is swallowed
  assert.equal((await get(t, a.id)).state, "yielded", "precondition: the wake was lost");
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.ok((await get(t, a.id)).generation > a.generation, "the lost wake is retried");
});

async function queuedYielded(t: T, name: string) {
  const a = await seed(t, name, { cp: true, state: "yielded" });
  await t.daemon.deps.mailbox.send(a.id, { kind: "human_message", from: { channel: "c", sender: "s" }, body: "hi" }, `${name}-m`);
  return a;
}

function scanned(t: T): boolean {
  return (t.daemon as unknown as { lostWakeScanned: boolean }).lostWakeScanned;
}

test("a partial scan failure keeps the scan pending and retries only the failed agent; a full scan is not repeated", async () => {
  const t = setup(finishes);
  const ok = await queuedYielded(t, "b4-ok");
  const bad = await queuedYielded(t, "b4-bad");
  const reg = t.daemon.deps.registry;
  const bump = reg.bumpGeneration.bind(reg);
  const bumped: string[] = [];
  let failBad = true;
  reg.bumpGeneration = async (id, ...rest) => {
    if (id === bad.id && failBad) {
      failBad = false;
      throw new Error("injected: store hiccup during wake");
    }
    bumped.push(id);
    return bump(id, ...rest);
  };
  await t.daemon.recover();
  assert.equal(scanned(t), false, "scan stays pending after a per-agent failure");
  assert.ok(!bumped.includes(bad.id));
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.ok((await get(t, bad.id)).generation > bad.generation, "failed agent woken on retry");
  assert.equal(bumped.filter((id) => id === ok.id).length, 1, "the already-woken agent is not woken again");
  assert.equal(scanned(t), true, "scan done once a pass completes without failure");
  // A later queued signal is not picked up by ordinary ticks.
  const late = await seed(t, "b4-late", { cp: true, state: "yielded" });
  await t.daemon.deps.mailbox.send(late.id, { kind: "human_message", from: { channel: "c", sender: "s" }, body: "x" }, "b4-late-m");
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.equal((await get(t, late.id)).state, "yielded", "no scan on ordinary ticks");
});

test("a store down->up transition re-arms exactly one lost-wake scan and triggers a pass", async () => {
  const t = setup(finishes);
  await t.daemon.reconcile(); // boot scan done
  assert.equal(scanned(t), true);
  const a = await queuedYielded(t, "b4-rec"); // wake lost while the store was down
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).state, "yielded", "precondition: ordinary tick does not rescan");
  const d = t.daemon as unknown as { degraded: boolean };
  await t.daemon.probeStore(); // healthy: no-op, no re-arm
  assert.equal(scanned(t), true);
  d.degraded = true;
  await t.daemon.probeStore(); // recovery
  await t.daemon.reconcile(); // joins/queues behind the triggered pass
  await t.orchestrator.idle();
  assert.ok((await get(t, a.id)).generation > a.generation, "recovery rescan woke the lost wake");
  assert.equal(scanned(t), true, "scan completed and is one-shot again");
});

// ---- multi-host: loops act only on this host's agents --------------------------------------------------------
// Each loop is driven once per host: the h2 row is the refusal, the local h1 row is its negative control.
const pendingLoopStarts = async (host: string, key: string) => {
  const t = setup(async () => {});
  const started: string[] = [];
  const orig = t.orchestrator.start.bind(t.orchestrator);
  t.orchestrator.start = async (id, gen) => {
    started.push(id);
    return orig(id, gen);
  };
  const root = await t.daemon.root();
  const rec = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: key,
    task: "t",
    host,
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  await t.daemon.reconcile();
  return started.includes(rec.id);
};

const yieldedLoopArms = async (key: string, host?: string) => {
  const t = setup(async () => {});
  const armed: string[] = [];
  const orig = t.orchestrator.waitFor.bind(t.orchestrator);
  t.orchestrator.waitFor = async (id, w) => {
    armed.push(id);
    return orig(id, w);
  };
  const a = await seed(t, key, host ? { host } : {});
  await t.daemon.deps.checkpoints.write(cpFor(a, a.generation, { kind: "timer", at: Date.now() + 60_000 }), `${key}-cp`);
  await t.daemon.deps.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: `${key}-y` });
  await t.daemon.reconcile();
  return armed.includes(a.id);
};

test("the pending loop does not start another host's agent", async () => {
  assert.ok(!(await pendingLoopStarts("h2", "far")), "h1 started an h2 agent");
});

test("the yielded loop does not re-arm another host's timer wait", async () => {
  assert.ok(!(await yieldedLoopArms("far-y", "h2")), "h1 armed an h2 agent's timer");
});

test("the pending loop still starts a local-host agent", async () => {
  assert.ok(await pendingLoopStarts("h1", "near"), "h1 starts its own pending agent");
});

test("the yielded loop still re-arms a local-host timer wait", async () => {
  assert.ok(await yieldedLoopArms("near-y"), "h1 re-arms its own yielded agent");
});

test("the running loop leaves another host's agent untouched", async () => {
  const t = setup(async () => {});
  const a = await seed(t, "far-r", { host: "h2", cp: true });
  await t.daemon.reconcile();
  const after = await get(t, a.id);
  assert.equal(after.state, "running");
  assert.equal(after.generation, a.generation, "no resume of an h2 agent");
});

// The orphan-by-dead-parent loop is controller-wide, not host-filtered (parent and child may sit on different hosts), so
// it still acts on an h2 child of a finished h1 parent.
test("the orphan loop stays controller-wide: an h2 child of a finished parent is cancelled", async () => {
  const t = setup(async () => {});
  const cancelled: string[] = [];
  const orig = t.orchestrator.cancel.bind(t.orchestrator);
  t.orchestrator.cancel = async (id, grace) => {
    cancelled.push(id);
    return orig(id, grace);
  };
  const p = await seed(t, "orph-p");
  const c = await seed(t, "orph-c", { host: "h2", parent: p.id });
  await t.daemon.deps.registry.transition(p.id, p.generation, "exited", { exit: "succeeded", idempotencyKey: "orph-p-x" });
  await t.daemon.reconcile();
  assert.ok(cancelled.includes(c.id), "orphan decision is not host-filtered");
});

// ---- the four forced-resume callers (reconcile running-loop, tryAutoRestart, resumeInterrupted, watchdog kill_resume) ----
// Checkpoint keys, wake text and journal effects of each caller.

function spyResume(t: T) {
  const wakes: string[] = [];
  const orch = t.daemon.deps.orchestrator;
  const resume = orch.resume.bind(orch);
  orch.resume = ((agent: string, gen: number, wake: string) => {
    wakes.push(wake);
    return resume(agent, gen, wake);
  }) as typeof orch.resume;
  return wakes;
}

const messagesOf = (es: JournalEntry[]) => es.filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);

test("reconcile's running-loop resume: `:recover` checkpoint, default wake, one auto-restart entry (counts as one restart)", async () => {
  const keys: string[] = [];
  const hook = hookedCheckpoints(async (k) => void keys.push(k));
  const t = setup(async (c) => void (await c.stopped), { checkpoints: hook.store });
  hook.bind(t);
  const wakes = spyResume(t);
  const a = await seed(t, "r4a-rec", { cp: true, folder: true });
  keys.length = 0;
  await t.daemon.reconcile();
  try {
    assert.deepEqual(keys, [`${a.id}:${a.generation}:recover`]);
    assert.deepEqual(wakes, ["operator resumed you"]);
    assert.equal((await get(t, a.id)).generation, a.generation + 1);
    assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1);
  } finally {
    await teardown(t, a.id);
  }
});

test("tryAutoRestart: journals `auto-restart:` first, `:auto-restart` checkpoint, host-fault wake", async () => {
  const keys: string[] = [];
  const hook = hookedCheckpoints(async (k) => void keys.push(k));
  let runs = 0;
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      if (++runs === 1) {
        const rec = await get(t, c.agent);
        await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), "cp-key");
        await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
        t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 143);
        return;
      }
      await c.stopped;
    },
    { checkpoints: hook.store, maxRestarts: 3 },
  );
  hook.bind(t);
  const wakes = spyResume(t);
  await t.spawn();
  await until(() => wakes.length === 1);
  try {
    assert.deepEqual(
      keys.filter((k) => k.endsWith(":auto-restart")),
      [`${aId}:0:auto-restart`],
    );
    assert.deepEqual(wakes, ["your container was stopped (host_stopped); resuming from your last checkpoint"]);
    const es = await t.journal.read({ agent: aId });
    assert.deepEqual(messagesOf(es), ["auto-restart: resuming after host_stopped (1/3)"]);
    const ks = kinds(es);
    assert.ok(ks.indexOf("error") < ks.indexOf("resumed"), "auto-restart is journaled before the resume");
  } finally {
    await teardown(t, aId);
  }
});

test("resumeInterrupted: `:interrupt` checkpoint, interrupt wake, no auto-restart entry", async () => {
  const keys: string[] = [];
  const hook = hookedCheckpoints(async (k) => void keys.push(k));
  let runs = 0;
  let aId = "";
  const harnessWakes: string[] = [];
  const t = setup(
    async (c) => {
      aId = c.agent;
      if (c.wake !== undefined) harnessWakes.push(c.wake);
      if (++runs === 1) {
        for (;;) {
          const peek = (await c.api("GET", "/v1/agents/self/inbox?peek=1")).body as { interrupt?: boolean }[];
          if (peek.some((x) => x.interrupt)) return;
          await sleep(5);
        }
      }
      await c.stopped;
    },
    { checkpoints: hook.store },
  );
  hook.bind(t);
  const wakes = spyResume(t);
  await t.spawn();
  await until(() => aId !== "");
  const rec = await get(t, aId);
  await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), "cp-key");
  await t.operator("POST", `/v1/agents/${aId}/message`, { body: "change course", mode: "interrupt", idempotencyKey: "i1" });
  await until(() => wakes.length === 1);
  try {
    assert.deepEqual(
      keys.filter((k) => k.endsWith(":interrupt")),
      [`${aId}:${rec.generation}:interrupt`],
    );
    // The forced resume carries the interrupted note; its run appends the pending message (takeInterrupts), so the harness
    // receives both.
    assert.match(wakes[0]!, /^Your previous turn was interrupted by the operator \(.*\)\.$/s);
    await until(() => harnessWakes.length === 1);
    assert.match(harnessWakes[0]!, /^Your previous turn was interrupted by the operator .*Operator message: change course$/s);
    const es = await t.journal.read({ agent: aId });
    assert.deepEqual(
      es.filter((e) => e.payload.kind === "ext.pomtreed.interrupt_done").map((e) => (e.payload as unknown as { mode: string }).mode),
      ["interrupted"],
    );
    assert.equal(restarts(es).length, 0);
    assert.ok(kinds(es).includes("resumed"));
  } finally {
    await teardown(t, aId);
  }
});

test("watchdog kill_resume: no checkpoint write, default wake, no auto-restart entry, one bump", async () => {
  let clock = Date.now();
  const keys: string[] = [];
  const hook = hookedCheckpoints(async (k) => void keys.push(k));
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    checkpoints: hook.store,
    watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100, maxRetries: 3 },
  });
  hook.bind(t);
  const wakes = spyResume(t);
  const a = await seed(t, "r4a-wd", { cp: true, folder: true });
  keys.length = 0;
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  try {
    assert.deepEqual(keys, []);
    assert.deepEqual(wakes, ["operator resumed you"]);
    assert.equal((await get(t, a.id)).generation, a.generation + 1);
    assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 0);
  } finally {
    await teardown(t, a.id);
  }
});

// ---- restart accounting by cause ----------------------------------------------------------------------------------
// Restarts charged against the budget per cause: boot recovery 0; operator resume 0 and resets the lifetime count;
// host_fault 1; reconcile_orphan 1; interrupted 0; watchdog 0.

const priorRestart = (t: T, a: AgentRecord, n: number) =>
  t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "error", message: `auto-restart: resuming after host_stopped (${n}/3)` },
    idempotencyKey: `${a.id}:prior:${n}`,
  });

test("reconcile_orphan (a steady-state tick) is charged: one `auto-restart:` entry per resume", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 3 });
  const a = await seed(t, "r4b-orph", { cp: true, folder: true });
  await t.daemon.reconcile();
  try {
    assert.equal((await get(t, a.id)).generation, a.generation + 1);
    assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1);
  } finally {
    await teardown(t, a.id);
  }
});

test("reconcile_orphan over budget takes the host_fault exhaustion path: finish(failed, restart_exhausted), no resume", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 1 });
  const a = await seed(t, "r4b-exh", { cp: true, folder: true });
  await priorRestart(t, a, 1);
  await t.daemon.reconcile();
  await sleep(40);
  try {
    const after = await get(t, a.id);
    assert.ok(["exited", "reaped"].includes(after.state), `state ${after.state}`);
    assert.equal(after.exit, "failed");
    const ex = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "exited"); // the root reaps it, which clears the record's cause
    assert.equal((ex!.payload as { cause?: string }).cause, "restart_exhausted");
    assert.equal(after.generation, a.generation, "no bump");
    assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1, "no new charge");
  } finally {
    await teardown(t, a.id);
  }
});

test("boot recovery charges 0 and ignores an exhausted budget", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 1 });
  const a = await seed(t, "r4b-boot", { cp: true, folder: true });
  await priorRestart(t, a, 1);
  await t.daemon.recover();
  try {
    assert.equal((await get(t, a.id)).generation, a.generation + 1);
    assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1, "boot adds no entry");
  } finally {
    await teardown(t, a.id);
  }
});

test("an operator resume resets the lifetime count; a plain wake of a yielded agent does not", async () => {
  for (const operator of [true, false]) {
    let runs = 0;
    const t = setup(
      async (c) => {
        runs++;
        await until(() => t.fakes.hooks.raw.sandbox.running.size >= 1);
        t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()].at(-1)!, 143); // host fault
      },
      { maxRestarts: 1 },
    );
    const a = await seed(t, `r4b-op-${operator}`, { cp: true, folder: true, state: "yielded" });
    await priorRestart(t, a, 1);
    try {
      if (operator) await t.operator("POST", `/v1/agents/${a.id}/resume`, {});
      else await t.daemon.resumeAgent(a.id, "wake", {});
      await until(async () => ["exited", "reaped"].includes((await get(t, a.id)).state));
      const after = await get(t, a.id);
      assert.equal(after.exit, "failed");
      const es = await t.journal.read({ agent: a.id });
      if (operator) {
        assert.equal(runs, 2, "the reset budget (1) allowed one fault restart, then was spent");
        assert.equal(restarts(es).length, 2, "prior entry plus the one charged after the reset");
        assert.equal(after.generation, a.generation + 2);
      } else {
        assert.equal(runs, 1, "no reset: the budget was already spent");
        assert.equal(restarts(es).length, 1);
        assert.equal(after.generation, a.generation + 1);
      }
    } finally {
      await teardown(t, a.id);
    }
  }
});

// ---- restart exhaustion and quarantine-refusal each fail the agent with a distinct cause -----------------------------
// The parent sees them as child_exited with cause restart_exhausted / quarantined (an agent that cannot be auto-restarted
// is failed, not held).

const quarantine = (t: T, a: AgentRecord) =>
  t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "ext.pomtreed.quarantined", at: Date.now() },
    idempotencyKey: `q-${a.id}`,
  });
const exitedCauseSeenBy = async (t: T, parent: string) => {
  const sig = (await t.journal.read({ agent: parent })).flatMap((e) =>
    e.payload.kind === "signal" && e.payload.signal.kind === "child_exited" ? [e.payload.signal] : [],
  );
  return sig.map((s) => [s.exit, s.cause]);
};

test("quarantine-refuse with a checkpoint: failed with cause quarantined, no resume; the parent is told", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 1 });
  const p = await seed(t, "r9-qp", { cp: true, folder: true, state: "yielded" });
  const a = await seed(t, "r9-q", { cp: true, folder: true, parent: p.id });
  await quarantine(t, a);
  const resumes = spyResume(t);
  try {
    await t.daemon.recover();
    await sleep(40);
    const after = await get(t, a.id);
    assert.ok(["exited", "reaped"].includes(after.state), `state ${after.state}`);
    assert.deepEqual([after.exit, after.exitCause], ["failed", "quarantined"]);
    assert.equal(resumes.length, 0);
    assert.ok(messagesOf(await t.journal.read({ agent: a.id })).some((m) => m.includes("refusing to auto-resume")));
    assert.deepEqual(await exitedCauseSeenBy(t, p.id), [["failed", "quarantined"]]);
  } finally {
    await teardown(t, p.id);
  }
});

test("quarantined with NO checkpoint still fails (the earlier failure cause is kept, not `quarantined`)", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 1 });
  const a = await seed(t, "r9-nocp", { folder: true });
  await quarantine(t, a);
  await t.daemon.recover();
  await sleep(40);
  const after = await get(t, a.id);
  assert.equal(after.exit, "failed");
  assert.notEqual(after.exitCause, "quarantined");
});

test("reconcile_orphan over budget fails with restart_exhausted and journals the reason; the parent is told", async () => {
  const t = setup(async (c) => void (await c.stopped), { maxRestarts: 1 });
  const p = await seed(t, "r9-xp", { cp: true, folder: true, state: "yielded" });
  const a = await seed(t, "r9-exh", { cp: true, folder: true, parent: p.id });
  await priorRestart(t, a, 1);
  try {
    await t.daemon.reconcile();
    await sleep(40);
    const after = await get(t, a.id);
    assert.deepEqual([after.exit, after.exitCause], ["failed", "restart_exhausted"]);
    assert.equal(after.generation, a.generation);
    assert.ok(messagesOf(await t.journal.read({ agent: a.id })).some((m) => m.includes("restart budget exhausted")));
    assert.deepEqual(await exitedCauseSeenBy(t, p.id), [["failed", "restart_exhausted"]]);
  } finally {
    await teardown(t, p.id);
  }
});
