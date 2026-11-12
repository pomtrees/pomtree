import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
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
      { agent: a.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }], ...(labels && { labels }) },
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
  const mine = await sb.start({ agent: "ghost-mine", image: "img", env: {}, mounts: [], labels: { daemon_epoch: "50" } }, "ghost-mine");
  const foreign = await sb.start(
    { agent: "ghost-foreign", image: "img", env: {}, mounts: [], labels: { store_id: "other", daemon_epoch: "1" } },
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
      { agent: a.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }] },
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
