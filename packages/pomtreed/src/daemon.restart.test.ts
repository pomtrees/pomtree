import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxBackendMismatchError, sandboxIdForKey } from "@pomtree/core";
import type { AgentRecord, JournalEntry, Sandbox, SandboxListing } from "@pomtree/core";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

const done = (t: ReturnType<typeof setup>, id: string) => async () => (await get(t, id)).state === "exited" || (await get(t, id)).state === "reaped";
const cpFor = (a: AgentRecord, gen: number) => ({
  agent: a.id,
  generation: gen,
  host: "h1",
  sessionRef: "sha256:fake",
  workspace: `ws-${a.id}`,
  node: "h1",
  ingested: null,
  wait: { kind: "message" as const },
  remainingBudgetMicros: 50_000,
  imageDigest: "img@sha256:x",
  envManifestHash: null,
  template: "code",
  templateDigest: null,
  resumeLevel: "session" as const,
});
const restarts = (es: JournalEntry[]) => es.filter((e) => e.payload.kind === "error" && (e.payload as { message: string }).message.startsWith("auto-restart:"));

test("daemon-epoch: spawn stamps daemon_epoch and store_id labels on the sandbox", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } })), {
    storeId: "store-1",
    epoch: "100",
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.deepEqual(t.fakes.hooks.raw.sandbox.started[0]!.labels, { daemon_epoch: "100", store_id: "store-1" });
});

test("container ownership: containers of another store or a newer epoch and unlabelled ones are left alone; own older-epoch ones are reconciled", async () => {
  const t = setup(async () => {}, { storeId: "mine", epoch: "100" });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const sb = t.fakes.hooks.raw.sandbox;
  const mk = async (name: string, labels?: Record<string, string>) => {
    const a = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: name });
    await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${name}-x` }).catch(() => {});
    const h = await sb.start(
      {
        host: "h1",
        generation: 0,
        agent: a.id,
        image: "img",
        env: {},
        mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }],
        ...(labels && { labels }),
      },
      name,
    );
    return h.id;
  };
  const foreign = await mk("foreign", { store_id: "other", daemon_epoch: "1" });
  const newer = await mk("newer", { store_id: "mine", daemon_epoch: "200" });
  const unlabelled = await mk("unlabelled");
  const own = await mk("own", { store_id: "mine", daemon_epoch: "50" });
  await t.daemon.recover();
  assert.equal(sb.running.get(foreign)!.exitCode, null, "foreign store untouched");
  assert.equal(sb.running.get(newer)!.exitCode, null, "newer epoch untouched");
  assert.equal(sb.running.get(unlabelled)!.exitCode, null, "unlabelled container untouched");
  assert.notEqual(sb.running.get(own)!.exitCode, null, "own older-epoch container reconciled");
});

test("container ownership: a daemon with no store id leaves a container labelled with another store alone, neither killing nor adopting it", async () => {
  const t = setup(async () => {}, { epoch: "100" }); // no storeId: list(owner) carries storeId "" and must still exclude another store's container
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const sb = t.fakes.hooks.raw.sandbox;
  // A registered agent besides the root, so reconcile is allowed to reclaim records-less containers at all.
  await reg.create({ spec: spawnSpec, parent: root.id, name: "bystander", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "bystander" });
  const mine = await sb.start(
    { host: "h1", generation: 0, agent: "ghost-mine", image: "img", env: {}, mounts: [], labels: { daemon_epoch: "50" } },
    "ghost-mine",
  );
  const foreign = await sb.start(
    { host: "h1", generation: 0, agent: "ghost-foreign", image: "img", env: {}, mounts: [], labels: { store_id: "other", daemon_epoch: "1" } },
    "ghost-foreign",
  );
  await t.daemon.recover();
  assert.notEqual(sb.running.get(mine.id)!.exitCode, null, "an unregistered container of this daemon is still killed as a stray");
  assert.equal(sb.running.get(foreign.id)!.exitCode, null, "another store's container is left running");
  assert.equal(
    sb.killCalls.some((k) => k.id === foreign.id),
    false,
    "no kill was sent for it",
  );
  assert.equal(
    sb.stopCalls.some((k) => k.id === foreign.id),
    false,
    "no stop was sent for it",
  );
});

test("egress-orphans: recover reclaims egress orphans once, before spawns", async () => {
  let calls = 0;
  const t = setup(async () => {});
  t.daemon.deps.sandbox.reclaim = async () => {
    calls++;
    return [];
  };
  await t.daemon.reclaimEgressOrphans();
  await t.daemon.recover();
  assert.equal(calls, 1);
});

test("exit-cause: a nonzero exit after a failed endpoint preflight is endpoint_unreachable", async () => {
  const t = setup(
    async () => {
      await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
      t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 1);
    },
    { agentApiUrl: () => "http://x", agentEndpointProbe: async () => false },
  );
  const a = await t.spawn();
  await t.orchestrator.idle();
  const ex = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "exited");
  assert.equal((ex!.payload as { cause?: string }).cause, "endpoint_unreachable");
});

test("spawn-crash: running with no runtime and no checkpoint restarts from scratch instead of failing", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } })));
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.recover();
  await t.orchestrator.idle();
  const after = await get(t, a.id);
  assert.ok(after.generation > a.generation);
  assert.equal(after.exit, "succeeded");
  assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1);
});

test("spawn-crash: restart-from-scratch is bounded by maxRestarts", async () => {
  const t = setup(async () => {}, { maxRestarts: 0 });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.recover();
  const after = await get(t, a.id);
  assert.equal(after.exit, "failed");
});

test("docker-cascade: a host_stopped checkpointed agent resumes instead of failing, bounded by maxRestarts", async () => {
  let runs = 0;
  const t = setup(async (c) => {
    runs++;
    if (runs === 1) {
      const rec = await get(t, c.agent);
      await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), "cp-key");
      await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
      t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 143);
      return;
    }
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
  });
  const a = await t.spawn();
  await until(done(t, a.id));
  await t.orchestrator.idle();
  const after = await get(t, a.id);
  assert.equal(after.exit, "succeeded");
  assert.equal(runs, 2);
  assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1);
});

test("docker-cascade: with restarts exhausted the host_stopped agent fails with restart_exhausted", async () => {
  let runs = 0;
  const t = setup(
    async (c) => {
      runs++;
      const rec = await get(t, c.agent);
      await t.daemon.deps.checkpoints.write(cpFor(rec, rec.generation), `cp-${rec.generation}`);
      const live = () => [...t.fakes.hooks.raw.sandbox.running].filter(([, v]) => v.exitCode === null).map(([k]) => k);
      await until(() => live().length === 1);
      t.fakes.hooks.exitSandbox(live()[0]!, 143);
    },
    { maxRestarts: 1 },
  );
  const a = await t.spawn();
  await until(done(t, a.id), 4000);
  await t.orchestrator.idle();
  const ex = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "exited");
  assert.equal((ex!.payload as { cause?: string }).cause, "restart_exhausted");
  assert.equal((await get(t, a.id)).exit, "failed");
  assert.equal(restarts(await t.journal.read({ agent: a.id })).length, 1);
  assert.equal(runs, 2);
});

// ---- review regressions ----
type T = ReturnType<typeof setup>;
async function runningWithCp(t: T, name: string, opts: { sandbox?: boolean } = {}) {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: name });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
  let sid = "";
  if (opts.sandbox) {
    const h = await t.fakes.hooks.raw.sandbox.start(
      { host: "h1", generation: 0, agent: a.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }] },
      `${name}-sb`,
    );
    await reg.setSandbox(a.id, a.generation, h.id, `${name}-set`);
    sid = h.id;
  }
  await t.daemon.deps.checkpoints.write(cpFor(a, a.generation), `${name}-cp`);
  return { a, sid };
}

test("runResumed: a stale generation does nothing (never kills or reclaims a newer run's container)", async () => {
  const t = setup(async () => {});
  const { a, sid } = await runningWithCp(t, "st", { sandbox: true });
  await t.daemon.runResumed(a.id, a.generation + 7, "stale wake");
  assert.equal(t.fakes.hooks.raw.sandbox.running.get(sid)!.exitCode, null, "container untouched");
  assert.ok(!t.fakes.calls.some((c) => c.port === "Workspace" && (c.method === "create" || c.method === "fork" || c.method === "evict")));
  assert.equal(t.fakes.hooks.raw.sandbox.started.length, 1);
});

test("runResumed: the in-flight marker is set before the resume starts (a reconcile mid-resume does not re-bump)", async () => {
  const t = setup(async () => {});
  const { a, sid } = await runningWithCp(t, "mk", { sandbox: true });
  await t.fakes.hooks.raw.sandbox.kill(sid, `test-kill:${sid}`);
  const ws = t.daemon.deps.workspace;
  const realCreate = ws.create.bind(ws);
  let gen1: number | undefined;
  ws.create = async (id, o) => {
    // mid-resume, a reconcile tick must see a live marker and leave the generation alone
    await t.daemon.reconcile();
    gen1 = (await get(t, a.id)).generation;
    return realCreate(id, o);
  };
  await t.daemon.recover();
  await t.orchestrator.idle();
  assert.equal(gen1, a.generation + 1, "no second bump while the first resume is in flight");
});

test("lost-wake scan runs only on the first pass after boot (no re-wake from a stale signal every tick)", async () => {
  const t = setup(async () => {});
  await t.daemon.reconcile(); // the boot pass
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "lw", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "lw" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "lw-run" });
  await t.daemon.deps.checkpoints.write(cpFor(a, a.generation), "lw-cp");
  await reg.transition(a.id, a.generation, "yielded", { idempotencyKey: "lw-y" });
  await t.daemon.deps.mailbox.send(a.id, { kind: "human_message", from: { channel: "c", sender: "s" }, body: "old" }, "m1");
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).state, "yielded");
});

test("lost-wake scan on the boot pass still wakes a yielded agent with a queued satisfying signal", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "lb", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "lb" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "lb-run" });
  await t.daemon.deps.checkpoints.write(cpFor(a, a.generation), "lb-cp");
  await reg.transition(a.id, a.generation, "yielded", { idempotencyKey: "lb-y" });
  await t.daemon.deps.mailbox.send(a.id, { kind: "human_message", from: { channel: "c", sender: "s" }, body: "hi" }, "m1");
  await t.daemon.recover();
  await t.orchestrator.idle();
  assert.ok((await get(t, a.id)).generation > a.generation, "resumed");
});

async function parentWithReapedKid(t: T, name: string) {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const p = await reg.create({ spec: spawnSpec, parent: root.id, name: `${name}-p`, task: "t", host: "h1", budgetMicros: 10, idempotencyKey: `${name}-p` });
  await reg.transition(p.id, p.generation, "running", { idempotencyKey: `${name}-p-run` });
  await t.daemon.deps.checkpoints.write(cpFor(p, p.generation), `${name}-pcp`);
  await reg.transition(p.id, p.generation, "yielded", { idempotencyKey: `${name}-p-y` });
  const c = await reg.create({ spec: spawnSpec, parent: p.id, name: `${name}-c`, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: `${name}-c` });
  await reg.transition(c.id, c.generation, "running", { idempotencyKey: `${name}-c-run` });
  await reg.transition(c.id, c.generation, "exited", { exit: "succeeded", idempotencyKey: `${name}-c-x` });
  await reg.transition(c.id, c.generation, "reaped", { idempotencyKey: `${name}-c-r` });
  return { p, c };
}

test("reconcile does not merge a reaped child into its live parent", async () => {
  const t = setup(async () => {});
  await parentWithReapedKid(t, "rm");
  for (let i = 0; i < 3; i++) await t.daemon.reconcile();
  assert.ok(!t.fakes.calls.some((c) => c.port === "Workspace" && c.method === "merge"));
});

test("probeStore: writes a unique probe row (never an idempotent replay) and clears the latches", async () => {
  const t = setup(async () => {});
  await t.daemon.root();
  const keys: string[] = [];
  const j = t.daemon.deps.journal;
  const real = j.append.bind(j);
  j.append = async (e) => {
    keys.push(e.idempotencyKey);
    return real(e);
  };
  const d = t.daemon as unknown as { degraded: boolean; journalFailed: boolean };
  d.degraded = true;
  await t.daemon.probeStore();
  d.journalFailed = true;
  await t.daemon.probeStore();
  const probes = keys.filter((k) => k.startsWith("host:probe:"));
  assert.equal(probes.length, 2);
  assert.notEqual(probes[0], probes[1]);
  assert.equal(d.degraded || d.journalFailed, false);
});

test("probeStore: a failing write keeps the latch", async () => {
  const t = setup(async () => {});
  await t.daemon.root();
  const j = t.daemon.deps.journal;
  j.append = async () => {
    throw Object.assign(new Error("full"), { code: "SQLITE_FULL" });
  };
  const d = t.daemon as unknown as { degraded: boolean };
  d.degraded = true;
  await t.daemon.probeStore();
  assert.equal(d.degraded, true);
});

const ok = (c: { api: (m: string, u: string, b?: unknown) => Promise<unknown> }) =>
  c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
// A running agent on this host whose record holds `sandbox`, pinned to `backend` (undefined: written through the fake's agents map, no pin).
async function holder(t: ReturnType<typeof setup>, name: string, sandbox: string, backend?: string, o: { host?: string; exited?: boolean } = {}) {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: o.host ?? "h1", budgetMicros: 100_000, idempotencyKey: name });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
  if (backend !== undefined) await reg.setSandbox(a.id, a.generation, sandbox, `${name}-sb`, backend);
  else (t.fakes.hooks.raw.registry.agents.get(a.id) as { sandbox: string | null }).sandbox = sandbox; // legacy: a sandbox with no backend
  if (o.exited) await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${name}-x` });
  return a;
}

for (const applied of [true, false]) {
  test(`sandbox-backend: a start with an unknown outcome (sandbox ${applied ? "created" : "not created"}) yields exactly one sandbox and pins the backend while it runs`, async () => {
    let pinned: string | null | undefined;
    const t = setup(async (c) => {
      pinned = (await get(t, c.agent)).sandboxBackend;
      await ok(c);
    });
    t.fakes.hooks.raw.sandbox.faults.add("start", { kind: "unknown-outcome", applied });
    const a = await t.spawn();
    await t.orchestrator.idle();
    assert.equal((await get(t, a.id)).exit, "succeeded", "the run completes on the adopted or retried sandbox");
    assert.equal(t.fakes.hooks.raw.sandbox.started.length, 1, "no second sandbox");
    assert.equal(pinned, "fake", "the backend was recorded while the sandbox ran");
  });
}

test("sandbox-backend: a second unknown outcome keeps the recorded sandbox id (the sandbox may exist) instead of clearing it", async () => {
  const t = setup(async () => {});
  const sb = t.fakes.hooks.raw.sandbox;
  sb.faults.add("start", { kind: "unknown-outcome", applied: false }).add("start", { kind: "unknown-outcome", applied: true });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal(sb.started.length, 1, "the second attempt did create the sandbox");
  const cleared = t.fakes.calls.filter((c) => c.port === "Registry" && c.method === "setSandbox" && String(c.args[3]).endsWith(":sandbox-intent-clear"));
  assert.equal(cleared.length, 0, "the pointer to the possibly created sandbox was never cleared by startSandbox");
});

test("sandbox-backend: a definite start failure clears the recorded id and with it the backend pin", async () => {
  const t = setup(async () => {});
  t.fakes.hooks.raw.sandbox.faults.add("start", { kind: "error", error: new Error("boom") });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const cleared = t.fakes.calls.filter((c) => c.port === "Registry" && c.method === "setSandbox" && String(c.args[3]).endsWith(":sandbox-intent-clear"));
  assert.equal(cleared.length, 1);
  assert.deepEqual([(await get(t, a.id)).sandbox, (await get(t, a.id)).sandboxBackend], [null, null]);
});

test("sandbox-backend: restart between persisting the backend and the create (sandbox never created) starts at most one sandbox and ends the run", async () => {
  const t = setup(async () => {});
  const sb = t.fakes.hooks.raw.sandbox;
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await reg.setSandbox(a.id, a.generation, sandboxIdForKey(`${a.id}:${a.generation}:start`), "intent", "fake");
  await t.daemon.recover();
  await t.orchestrator.idle();
  const after = await get(t, a.id);
  assert.ok(sb.started.length <= 1, `at most one sandbox: ${sb.started.length}`);
  assert.ok(after.state === "exited" || after.state === "reaped" || after.generation > a.generation, `not stuck: ${after.state}`);
});

test("sandbox-backend: restart after the create (before the real id was recorded) links the listed sandbox of this generation only", async () => {
  const t = setup(async () => {});
  const sb = t.fakes.hooks.raw.sandbox;
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  const b = await reg.bumpGeneration(a.id, "h1", "a-bump"); // generation 1
  await reg.transition(b.id, b.generation, "running", { idempotencyKey: "a-run" });
  await reg.setSandbox(b.id, b.generation, sandboxIdForKey(`${b.id}:${b.generation}:start`), "intent", "fake");
  // The stamps are the ones the adapter writes from the spec: only a sandbox of this host AND this generation is linked.
  const spec = { agent: b.id, image: "img", env: {}, mounts: [], labels: { daemon_epoch: "0" } };
  const stale = await sb.start({ ...spec, host: "h1", generation: 0 }, "stale-gen0"); // listed first: the previous generation's leftover
  const otherHost = await sb.start({ ...spec, host: "h2", generation: 1 }, "other-host"); // right generation, another host's
  const right = await sb.start({ ...spec, host: "h1", generation: 1 }, `${b.id}:1:start`);
  await t.daemon.recover();
  assert.equal((await get(t, b.id)).sandbox, right.id, "bound to the sandbox of this generation");
  assert.notEqual(sb.running.get(stale.id)!.exitCode, null, "the stale lower-generation sandbox was stopped");
  assert.equal(sb.running.get(right.id)!.exitCode, null, "the correct sandbox was kept running");
  assert.equal((await get(t, b.id)).sandbox === otherHost.id, false, "another host's sandbox is never linked");
});

test("reconcile acts only on sandboxes stamped with this host: a peer-host or unstamped sandbox is never killed, stopped or bound (each branch)", async () => {
  const t = setup(async () => {});
  const sb = t.fakes.hooks.raw.sandbox;
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const labels = { daemon_epoch: "0" };
  const base = { image: "img", env: {}, mounts: [], labels };
  // No record: an own-host ghost is killed (control); a peer-host one is left.
  const ghostOwn = await sb.start({ ...base, agent: "ghost-own", host: "h1", generation: 0 }, "g1");
  const ghostPeer = await sb.start({ ...base, agent: "ghost-peer", host: "h2", generation: 0 }, "g2");
  // Record on another host: an own-host-stamped sandbox is killed (control); a peer-stamped one is left.
  const moved = await reg.create({ spec: spawnSpec, parent: root.id, name: "m", task: "t", host: "h2", budgetMicros: 100_000, idempotencyKey: "m" });
  const movedOwn = await sb.start({ ...base, agent: moved.id, host: "h1", generation: 0 }, "m1");
  const movedPeer = await sb.start({ ...base, agent: moved.id, host: "h2", generation: 0 }, "m2");
  // Running record with no sandbox id yet and a non-derived id: only the same host AND generation is bound.
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  const b = await reg.bumpGeneration(a.id, "h1", "a-bump");
  await reg.transition(b.id, b.generation, "running", { idempotencyKey: "a-run" });
  const stale = await sb.start({ ...base, agent: b.id, host: "h1", generation: 0 }, "s0");
  const peerGen = await sb.start({ ...base, agent: b.id, host: "h2", generation: b.generation }, "s1");
  await t.daemon.recover();
  const alive = (id: string) => sb.running.get(id)!.exitCode === null;
  assert.equal(alive(ghostOwn.id), false, "control: an own-host ghost is killed");
  assert.equal(alive(ghostPeer.id), true, "a peer-host ghost is left");
  assert.equal(alive(movedOwn.id), false, "control: an own-host sandbox of a record on another host is killed");
  assert.equal(alive(movedPeer.id), true, "a peer-host sandbox is left");
  const after = await get(t, b.id);
  assert.notEqual(after.sandbox, peerGen.id, "a peer-host sandbox of the right generation is never bound");
  assert.notEqual(after.sandbox, stale.id, "a stale-generation sandbox is never bound");
  assert.equal(alive(stale.id), false, "the stale-generation sandbox of this host is stopped");
  assert.equal(alive(peerGen.id), true, "the peer-host sandbox is left running");
});

test("sandbox-backend: a live sandbox recorded under another backend is held and the daemon boots with one journaled finding; nothing is killed", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-docker-1", "docker");
  const errors = console.error;
  console.error = () => {};
  try {
    await t.daemon.recover();
  } finally {
    console.error = errors;
  }
  const sb = t.fakes.hooks.raw.sandbox;
  assert.equal(sb.started.length, 0);
  assert.equal(sb.killCalls.length + sb.stopCalls.length, 0, "the held agent's sandbox was neither killed nor stopped");
  const rec = await get(t, a.id);
  assert.deepEqual([rec.state, rec.sandbox, rec.sandboxBackend], ["running", "sb-docker-1", "docker"]);
  const root = await t.daemon.root();
  const held = (await t.daemon.deps.journal.read({ agent: root.id })).filter(
    (e) => e.payload.kind === "host_error" && (e.payload as { message: string }).message.includes(a.id),
  );
  assert.equal(held.length, 1);
  assert.match((held[0]!.payload as { message: string }).message, new RegExp(`select docker again \\(sandbox\\.backend\\), or run pomtree abandon ${a.id}`));
});

test("sandbox-backend: a record of another host, or a finished one, on another backend does not refuse boot; the selected backend boots (controls)", async () => {
  const t = setup(async () => {});
  await holder(t, "elsewhere", "sb-d-1", "docker", { host: "h2" });
  await holder(t, "finished", "sb-d-2", "docker", { exited: true });
  await holder(t, "mine", "sb-f-1", "fake");
  await t.daemon.recover();
});

test("sandbox-backend: a record that holds a sandbox but names no backend refuses boot with cause and action", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-legacy");
  await assert.rejects(
    () => t.daemon.recover(),
    (e: unknown) =>
      e instanceof Error &&
      e.message.includes(`agent ${a.id} holds sandbox sb-legacy but its record names no sandbox backend`) &&
      e.message.includes("move the database file aside and restart"),
  );
});

test("sandbox-backend: the fake registry pins the backend while a sandbox is held and clears the pin with the sandbox, as the store does", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "a" });
  assert.equal((await reg.setSandbox(a.id, 0, "s1", "k1", "docker")).sandboxBackend, "docker");
  assert.equal((await reg.setSandbox(a.id, 0, "s1", "k1b", "docker")).sandboxBackend, "docker", "same backend is idempotent");
  await assert.rejects(
    () => reg.setSandbox(a.id, 0, "s2", "k2", "podman"),
    (e: unknown) => e instanceof SandboxBackendMismatchError && e.recorded === "docker" && e.selected === "podman",
  );
  assert.equal((await reg.setSandbox(a.id, 0, null, "k3")).sandboxBackend, null, "clearing the sandbox clears the pin");
  assert.equal((await reg.setSandbox(a.id, 0, "s3", "k4", "podman")).sandboxBackend, "podman", "a cleared run may start under another backend");
});
