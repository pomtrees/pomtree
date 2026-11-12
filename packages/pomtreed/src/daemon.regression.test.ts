import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { Daemon, sessionDeadlineConfig } from "./daemon.ts";
import { LifecycleError } from "./lifecycle.ts";
import { get, kinds, op, setup, spawnSpec, until } from "./test-setup.ts";
import { DEADLINE_KIND, HOST_HEALTH_KIND } from "./watchdog.ts";

test("exit never touches the clone: no host-side commit, the folder is kept for the sweep", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();

  const r = await get(t, a.id);
  assert.equal(r.exit, "succeeded");
  const verbs = t.fakes.calls.filter((c) => c.port === "Workspace").map((c) => c.method);
  for (const gone of ["commit", "checkout", "merge", "abortMerge", "clearLock", "remove"]) assert.ok(!verbs.includes(gone), `${gone} is no longer called`);
  assert.ok(t.fakes.hooks.raw.workspace.workspaces.has(a.id), "the folder survives the exit");
});

test("recover ADOPTS a checkpointed running agent whose container is still alive (no rollback to the checkpoint)", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  const live = await t.fakes.hooks.raw.sandbox.start(
    { agent: a.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }] },
    "live",
  );
  await reg.setSandbox(a.id, a.generation, live.id, "live-set");
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );

  await t.daemon.recover();
  await t.orchestrator.idle();

  assert.equal(t.fakes.hooks.raw.sandbox.running.get(live.id)!.exitCode, null, "the healthy container is not killed");
  assert.equal(t.fakes.hooks.raw.sandbox.started.length, 1, "no second container (no resume)");
  assert.equal((await get(t, a.id)).generation, a.generation, "generation not bumped");
  assert.ok(!t.fakes.calls.some((c) => c.port === "Workspace" && c.method === "checkout"), "worktree is not rolled back");
});

test("recover force-resumes a checkpointed running agent whose container is dead (reclaims the stale record)", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  // Persist a still-running container as if the daemon crashed mid-run.
  const stale = await t.fakes.hooks.raw.sandbox.start(
    { agent: a.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }] },
    "stale",
  );
  await reg.setSandbox(a.id, a.generation, stale.id, "stale-set");
  await t.fakes.hooks.raw.sandbox.kill(stale.id, `test-kill:${stale.id}`); // the container died with the daemon down
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );

  await t.daemon.recover();
  await t.orchestrator.idle();

  assert.ok(t.daemon.deps.registry && (await get(t, a.id)).generation > a.generation, "generation fenced by the forced resume");
  assert.ok(t.fakes.hooks.raw.sandbox.started.length >= 2, "a fresh container was started for the resumed run");
});

test("a second forced resume from one checkpoint bumps the generation again", async () => {
  const t = setup(async (c) => {
    await c.stopped;
  });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );

  const g0 = a.generation;
  await t.daemon.resumeAgent(a.id, undefined, { forced: true });
  const g1 = (await t.daemon.get(a.id))!.generation;
  await t.daemon.resumeAgent(a.id, undefined, { forced: true });
  const g2 = (await t.daemon.get(a.id))!.generation;

  assert.ok(g1 > g0, "first forced resume bumps the generation");
  assert.ok(g2 > g1, "a second forced resume from the same checkpoint bumps again (no key reuse)");
});

test("an agent ending without a result journals a silent-exit error", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "message", role: "assistant", text: "bye" });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();

  const r = await get(t, a.id);
  assert.equal(r.exit, "failed");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.ok(
    errs.some((e) => (e.payload as { message: string }).message.startsWith("agent ended without reporting a result")),
    "a silent exit journals the reason instead of failing with no journal line",
  );
});

test("a store write failure still tears down the runtime, sets degraded, and 503s spawn", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  const reg = Object.create(raw.registry) as typeof raw.registry;
  const baseTransition = raw.registry.transition.bind(raw.registry);
  let failOnce = true;
  reg.transition = async (id, gen, to, o) => {
    if (to === "exited" && failOnce) {
      failOnce = false;
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    }
    return baseTransition(id, gen, to, o);
  };
  const d = new Daemon({ ...t.daemon.deps, registry: reg });
  const a = (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: "k" } })).body as AgentRecord;
  await t.orchestrator.idle();

  const sb = [...raw.sandbox.running.values()].find((s) => s.agent === a.id);
  assert.ok(sb && sb.exitCode !== null, "the sandbox was stopped even though the store threw");
  assert.ok(!(await d.placementStatus()).running.includes(a.id), "the placement slot was released");
  assert.equal((await d.doctor()).live, 0, "the live handle was dropped");
  await assert.rejects(d.spawn((await d.root()).id, { name: "x", task: "t", idempotencyKey: "k2" }), (e: LifecycleError) => e.status === 503);
});

test("a throwing admit releases the placement slot and fails the pending agent", async () => {
  const t = setup(async () => {});
  const released: string[] = [];
  let fail = true;
  const placement = {
    admit: async (req: { agent: string; priority: number }) => {
      if (fail) {
        fail = false;
        throw new Error("placement down");
      }
      return { host: "h1" };
    },
    release: async (agent: string) => {
      released.push(agent);
    },
    status: async () => [{ host: "h1", maxConcurrent: 8, running: [], queue: [] }],
    sync: async () => {},
  };
  const d = new Daemon({ ...t.daemon.deps, placement });
  const a = (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: "k" } })).body as AgentRecord;
  await t.orchestrator.idle();

  assert.ok(released.includes(a.id), "the failed admission releases the placement slot");
  assert.equal((await d.get(a.id))!.exit, "failed");
});

test("a resumed agent goes through admission and releases its slot at settle", async () => {
  const t = setup(async () => {});
  const admits: string[] = [];
  const released: string[] = [];
  const placement = {
    admit: async (req: { agent: string; priority: number }) => {
      admits.push(req.agent);
      return { host: "h1" };
    },
    release: async (agent: string) => {
      released.push(agent);
    },
    status: async () => [{ host: "h1", maxConcurrent: 8, running: [], queue: [] }],
    sync: async () => {},
  };
  const d = new Daemon({ ...t.daemon.deps, placement });
  const root = await d.root();
  const reg = d.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await reg.transition(a.id, a.generation, "yielded", { idempotencyKey: "a-yield" });
  await d.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );

  await d.resumeAgent(a.id, undefined, { forced: true });
  await t.orchestrator.idle();

  assert.ok(admits.includes(a.id), "runResumed admitted the resumed agent");
  assert.ok(released.includes(a.id), "the resumed agent's slot was released at settle");
});

test("one throwing agent does not abort the watchdog sweep for the rest", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1000, graceMs: 500, failureLimit: 100 } });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  const b = await reg.create({ spec: spawnSpec, parent: root.id, name: "b", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "b" });
  await reg.transition(b.id, b.generation, "running", { idempotencyKey: "b-run" });

  const base = t.daemon.deps.gateway;
  const gw = {
    issueKey: (id: string, budget: number) => base.issueKey(id, budget),
    spend: async (id: string) => {
      if (id === a.id) throw new Error("boom");
      return base.spend(id);
    },
    revoke: (id: string) => base.revoke(id),
  };
  const d = new Daemon({ ...t.daemon.deps, gateway: gw });
  clock += 2_000;
  await d.sweepWatchdogs();

  assert.equal((await t.fakes.watchdogs.get(b.id))?.rung, "nudged", "the later agent was still evaluated");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.ok(
    errs.some((e) => (e.payload as { message: string }).message.startsWith("watchdog sweep failed")),
    "the throwing agent journaled a keyed sweep error",
  );
});

test("the watchdog re-reads the record and skips a stale snapshot", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1000, graceMs: 500, failureLimit: 100 } });
  const root = await t.daemon.root();
  const regRaw = t.fakes.hooks.raw.registry;
  const a = await regRaw.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await regRaw.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });

  const reg = Object.create(regRaw) as typeof regRaw;
  const baseList = regRaw.list.bind(regRaw);
  reg.list = async (o: Parameters<typeof regRaw.list>[0]) => {
    const recs = await baseList(o);
    return recs.map((r) => (o?.state === "running" && r.id === a.id ? { ...r, generation: r.generation + 999 } : r));
  };
  const d = new Daemon({ ...t.daemon.deps, registry: reg });
  clock += 2_000;
  await d.sweepWatchdogs();

  assert.equal(await t.fakes.watchdogs.get(a.id), null, "a stale snapshot is skipped, not acted on");
  assert.equal((await t.daemon.deps.mailbox.peek(a.id)).length, 0, "no nudge was delivered for a stale snapshot");
});

test("reconcile replays an answered escalation's journal and signal", async () => {
  const t = setup(async () => {});
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await reg.transition(a.id, a.generation, "yielded", { idempotencyKey: "a-yield" });
  await t.daemon.deps.escalations.create({ id: "es-1", agent: a.id, host: "h1", generation: a.generation, question: "q", options: [] }, "a:q");
  await t.daemon.deps.escalations.answer("es-1", "yes", { channel: "operator", sender: "operator" }, "answer-key");
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "escalation_answered").length, 0);

  await t.daemon.reconcile();

  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "escalation_answered").length, 1);
  const signals = await t.daemon.deps.mailbox.peek(a.id);
  assert.ok(signals.some((s) => s.kind === "human_answer" && (s as { escalation: string }).escalation === "es-1"));
});

test("a throwing wake in notifyParent does not skip cancelChildren and the custody hold", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  // A root-parented exit no longer signals root (it journals a user `status`), so the throwing wake needs a non-root owner.
  const gp = await reg.create({ spec: spawnSpec, parent: root.id, name: "gp", task: "t", host: "h1", budgetMicros: 20, idempotencyKey: "gp" });
  await reg.transition(gp.id, gp.generation, "running", { idempotencyKey: "gp-run" });
  await reg.transition(gp.id, gp.generation, "exited", { exit: "succeeded", idempotencyKey: "gp-exit" });
  const p = await reg.create({ spec: spawnSpec, parent: gp.id, name: "p", task: "t", host: "h1", budgetMicros: 10, idempotencyKey: "p" });
  await reg.transition(p.id, p.generation, "running", { idempotencyKey: "p-run" });
  const kid = await reg.create({ spec: spawnSpec, parent: p.id, name: "kid", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "kid" });
  await reg.transition(kid.id, kid.generation, "running", { idempotencyKey: "kid-run" });

  const base = t.daemon.deps.orchestrator;
  const orch = Object.create(base) as typeof base;
  orch.wake = async () => {
    throw new Error("wake 409");
  };
  const d = new Daemon({ ...t.daemon.deps, orchestrator: orch });

  await d.kill(p.id);
  await t.orchestrator.idle();

  assert.equal((await d.get(p.id))!.state, "exited", "the parent (its own parent gp is gone) is held for custody, not reaped, despite the throwing wake");
  const k = await d.get(kid.id);
  assert.ok(k && (k.state === "exited" || k.state === "reaped"), "cancelChildren still ran after the throwing wake");
  const errs = (await t.journal.read({ agent: gp.id })).filter((e) => e.payload.kind === "error");
  assert.ok(
    errs.some((e) => (e.payload as { message: string }).message.startsWith("wake of")),
    "the wake error was journaled on the owner",
  );
});

test("recover re-adopts a checkpoint-less running container instead of failing it", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  const sb = await t.fakes.hooks.raw.sandbox.start(
    { agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
    "sb",
  );
  await reg.setSandbox(a.id, a.generation, sb.id, "sb-set");

  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));

  assert.equal((await get(t, a.id)).state, "running", "a live container is adopted, not failed");
  assert.ok(!t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill"), "adoption must not kill the container");
  assert.equal(t.fakes.hooks.raw.sandbox.running.get(sb.id)!.exitCode, null);

  // When the container exits on its own, the agent finishes from that exit.
  t.fakes.hooks.raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "succeeded");
});

test("adopt finishes a checkpoint-less agent without touching its clone", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const raw = t.fakes.hooks.raw;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.deps.workspace.create(a.id, {}); // the old daemon's folder survives the restart
  const sb = await raw.sandbox.start({ agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] }, "sb");
  await reg.setSandbox(a.id, a.generation, sb.id, "sb-set");

  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");

  assert.equal((await get(t, a.id)).exit, "succeeded");
  assert.ok(!t.fakes.calls.some((c) => c.port === "Workspace" && (c.method === "commit" || c.method === "remove")));
  assert.ok(raw.workspace.workspaces.has(a.id), "the folder is kept");
});

test("resume refuses a quarantined agent without --force, and --force clears it for the new generation", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const r = await get(t, aId);
  await t.journal.append({
    agent: aId,
    host: "h1",
    generation: r.generation,
    payload: { kind: "ext.pomtreed.quarantined", at: Date.now() },
    idempotencyKey: "q",
  });

  await assert.rejects(() => t.daemon.resumeAgent(aId), /quarantined/);
  assert.equal((await get(t, aId)).state, "yielded", "a refused resume leaves the agent parked");

  const resumed = await t.daemon.resumeAgent(aId, "forced", { forced: true });
  assert.ok(resumed.generation > r.generation, "--force bumps the generation");
  await t.orchestrator.idle();
  assert.deepEqual((await get(t, aId)).result, { summary: "ok", value: "woke" });
});

test("recover refuses to auto-resume a quarantined running agent", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: "ext.pomtreed.quarantined", at: Date.now() },
    idempotencyKey: "q",
  });

  await t.daemon.recover();
  await t.orchestrator.idle();

  const after = await get(t, a.id);
  assert.equal(after.exit, "failed");
  const ex = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "exited"); // the root reaps it, which clears the record's cause
  assert.equal((ex!.payload as { cause?: string }).cause, "quarantined");
  assert.ok(
    (await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === "error" && (e.payload as { message: string }).message.includes("quarantined")),
  );
});

test("a spawn deadline is journaled and enforced as timed_out by the hard kill", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  const root = await t.daemon.root();
  const before = clock;
  const a = await t.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k", deadlineMs: 30 });
  await until(async () => (await get(t, a.id)).state === "running");

  // The deadline is durable (a keyed journal entry) and armed as a hard kill, not a watchdog sweep.
  const deadline = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === DEADLINE_KIND);
  assert.ok(deadline, "the deadline is journaled at spawn");
  assert.equal((deadline!.payload as { at?: number }).at, before + 30);

  clock += 30_000; // move the clock past the deadline so the armed timer's re-check sees it expired
  await until(async () => {
    const s = (await get(t, a.id)).state;
    return s === "exited" || s === "reaped";
  });
  assert.equal((await get(t, a.id)).exit, "timed_out");
  await t.orchestrator.idle();
});

test("session deadlines default, cap explicit requests, and never outlive the requester", async () => {
  let clock = Date.now();
  const deadlineDeps = { defaultSessionMs: 40, maxSessionMs: 50 };
  const t = setup(async () => {}, { now: () => clock, ...deadlineDeps });
  const root = await t.daemon.root();

  const parent = await t.daemon.spawn(root.id, { name: "parent", task: "t", idempotencyKey: "parent", budgetMicros: 10_000 });
  const capped = await t.daemon.spawn(root.id, { name: "capped", task: "t", idempotencyKey: "capped", deadlineMs: 10_000 });
  const child = await t.daemon.spawn(parent.id, { name: "child", task: "t", idempotencyKey: "child", deadlineMs: 10_000 });
  const unlimited = await t.daemon.spawn(root.id, { name: "unlimited", task: "t", idempotencyKey: "unlimited", deadlineMs: 0 });
  const cappedUnlimitedChild = await t.daemon.spawn(parent.id, { name: "capped-unlimited", task: "t", idempotencyKey: "capped-unlimited", deadlineMs: 0 });
  const deadline = async (id: string) =>
    (await t.journal.read({ agent: id })).find((e) => e.payload.kind === DEADLINE_KIND)!.payload as unknown as { at: number };

  assert.equal((await deadline(parent.id)).at, clock + 40, "an omitted request uses the configured default");
  assert.equal((await deadline(capped.id)).at, clock + 50, "an explicit request is capped by the configured maximum");
  assert.equal((await deadline(child.id)).at, clock + 40, "the parent deadline bounds an explicit request more than the configured maximum");
  assert.equal(
    (await t.journal.read({ agent: unlimited.id })).some((e) => e.payload.kind === DEADLINE_KIND),
    false,
    "an explicit unlimited request is not an immediate expiry",
  );
  assert.equal((await deadline(cappedUnlimitedChild.id)).at, clock + 40, "an explicit unlimited child remains capped by its finite parent");
});

// Asserts that with no session-deadline policy configured (sessionDeadlineConfig returns null) an omitted deadline journals none.
test("an omitted deadline journals no deadline when no session-deadline policy is configured", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const a = await t.daemon.spawn(root.id, { name: "legacy", task: "t", idempotencyKey: "legacy" });
  assert.equal(
    (await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === DEADLINE_KIND),
    false,
  );
});

test("session deadline configuration rejects an unsafe or inverted policy", () => {
  assert.throws(() => sessionDeadlineConfig({ defaultSessionMs: 0 }), /defaultSessionMs/);
  assert.throws(() => sessionDeadlineConfig({ maxSessionMs: 1.5 }), /maxSessionMs/);
  assert.throws(() => sessionDeadlineConfig({ defaultSessionMs: 2, maxSessionMs: 1 }), /must not exceed/);
});

test("the watchdog trips a journaled deadline even with no stall", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, watchdogOptions: { stallMs: 1_000_000, graceMs: 0, failureLimit: 100 } });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: a.generation,
    payload: { kind: DEADLINE_KIND, at: a.createdAt + 1_000 },
    idempotencyKey: "deadline",
  });

  clock += 2_000; // past the deadline, still far under stallMs
  await t.daemon.sweepWatchdogs();

  assert.equal((await get(t, a.id)).exit, "cancelled", "the deadlineAt liveness check trips even with no stdout/stall");
});

test("a resumed agent that overran its deadline while yielded is killed as timed_out", async () => {
  let clock = Date.now();
  const t = setup(
    async (c) => {
      if (c.wake) return void (await c.stopped); // the resumed segment parks until the deadline kill
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
    },
    { now: () => clock },
  );
  const root = await t.daemon.root();
  const a = await t.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k", deadlineMs: 10_000 });
  await until(async () => (await get(t, a.id)).state === "yielded");
  clock += 20_000; // overrun the deadline while parked
  await t.daemon.resumeAgent(a.id, "wake");
  await until(async () => {
    const s = (await get(t, a.id)).state;
    return s === "exited" || s === "reaped";
  });
  assert.equal((await get(t, a.id)).exit, "timed_out");
  await t.orchestrator.idle();
});

test("a keyed spawn replay returns 409 once the agent is terminal", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } })));
  const root = await t.daemon.root();
  const a = await t.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
  await t.orchestrator.idle();
  const after = await get(t, a.id);
  assert.ok(after.state === "exited" || after.state === "reaped");

  await assert.rejects(
    () => t.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" }),
    (e: unknown) =>
      e instanceof LifecycleError &&
      e.status === 409 &&
      e.message === `already ran: ${after.state}/${after.exit}; this idempotency key names a finished agent (use a new key to spawn again)` &&
      e.extra?.code === "idempotency_conflict",
  );
});

test("doctor reports a stale sweep and journals a keyed host_health heartbeat", async () => {
  let clock = Date.now();
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, limits: { watchdogSweepMs: 100 } });
  const root = await t.daemon.root();
  await t.daemon.sweepWatchdogs(); // first tick: healthy
  assert.equal((await t.daemon.doctor()).ok, true);
  assert.ok((await t.journal.read({ agent: root.id })).some((e) => e.payload.kind === HOST_HEALTH_KIND && (e.payload as { ok?: boolean }).ok === true));

  clock += 3 * 100 + 1; // > 3 intervals without a sweep
  assert.equal((await t.daemon.doctor()).ok, false);
  assert.equal((await t.daemon.doctor()).sweepsStale, true);

  await t.daemon.sweepWatchdogs(); // journals the stale heartbeat and skips the work (sweep gap)
  assert.ok((await t.journal.read({ agent: root.id })).some((e) => e.payload.kind === HOST_HEALTH_KIND && (e.payload as { ok?: boolean }).ok === false));
});

test("doctor does not 500 when sandbox.list throws a generic error", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const root = await t.daemon.root();
  const raw = t.fakes.hooks.raw;
  const sb = Object.create(raw.sandbox) as typeof raw.sandbox;
  sb.list = async () => {
    throw new Error("docker daemon exploded");
  };
  const d = new Daemon({ ...t.daemon.deps, sandbox: sb });

  const doc = await d.doctor(); // must not throw
  assert.equal(doc.ok, false);
  assert.equal(doc.sandboxUp, true, "a generic list error does not flip the admission down flag");
  assert.ok((await t.journal.read({ agent: root.id })).some((e) => e.payload.kind === "host_error"));
});
