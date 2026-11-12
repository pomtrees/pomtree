import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, JournalEntry, SandboxSpec, SpawnSpec } from "@pomtree/core";
import { FakeSandbox, TEST_MODEL } from "@pomtree/testing";
import { rig, seedCheckpoint, until } from "./harness.ts";
import type { Rig, RigOpts } from "./harness.ts";

// Restart / crash-recovery behaviors (pomtreed unit tests cover each over fakes) driven through the real
// store-sqlite + git workspace. Only the sandbox/harness are fakes. A "restart" is a second rig over the same
// repo + stateDir (+ the same FakeSandbox, which stands in for the container world that outlives the daemon).

const spec: SpawnSpec = {
  image: "img@sha256:e2e",
  envManifestHash: null,
  extensions: [],
  provider: TEST_MODEL.provider,
  model: TEST_MODEL.id,
  systemPrompt: null,
  egress: { kind: "none" },
};
const kindsOf = (es: JournalEntry[]) => es.map((e) => e.payload.kind);
const msgs = (es: JournalEntry[]) => es.map((e) => (e.payload as { message?: string }).message ?? "");
const sbSpec = (a: AgentRecord, labels?: Record<string, string>): SandboxSpec => ({
  agent: a.id,
  image: "img",
  env: {},
  mounts: [{ kind: "workspace", workspace: `ws-${a.id}`, containerPath: "/work" }],
  ...(labels && { labels }),
});
const cleanup = async (...rs: Rig[]) => {
  for (const r of rs) await r.orchestrator.idle().catch(() => {});
  for (const r of rs) r.store.close();
};

// A running agent with a real worktree, a committed checkpoint and (optionally) a still-registered container.
async function seedRunning(r: Rig, sb: FakeSandbox, name: string, o: { container?: "alive" | "dead" | "none"; cp?: boolean } = {}) {
  const root = await r.daemon.root();
  const reg = r.store.registry;
  const a = await reg.create({ parent: root.id, name, task: "t", host: "h1", budgetMicros: 1_000, idempotencyKey: name, spec });
  const ws = await r.workspace.create(a.id, {});
  writeFileSync(join(r.workspace.hostPath(ws.workspace), "kept.txt"), "checkpointed");
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
  let sandbox: string | undefined;
  if ((o.container ?? "none") !== "none") {
    const h = await sb.start(sbSpec(a), `${name}-sb`);
    await reg.setSandbox(a.id, a.generation, h.id, `${name}-set`);
    if (o.container === "dead") await sb.kill(h.id, `${h.id}:test-kill`);
    sandbox = h.id;
  }
  if (o.cp !== false) {
    await seedCheckpoint(r, a, `${name}-cp`, { workspace: ws.workspace });
  }
  writeFileSync(join(r.workspace.hostPath(ws.workspace), "dirty.txt"), "uncommitted work since the checkpoint");
  return { a, ws: r.workspace.hostPath(ws.workspace), sandbox };
}
const state = async (r: Rig, id: string) => (await r.daemon.get(id))!;
const terminal = (r: Rig, id: string) => async () => ["exited", "reaped"].includes((await state(r, id)).state);

test("restart ADOPTS a checkpointed running agent whose container is alive: no kill, no resume, no rollback", async () => {
  const sb = new FakeSandbox();
  const r1 = rig();
  const { a, ws, sandbox } = await seedRunning(r1, sb, "ad", { container: "alive" });
  const r2 = rig({ repo: r1.repo, stateDir: r1.stateDir, sandbox: sb });
  try {
    await r2.daemon.recover();
    assert.equal(sb.running.get(sandbox!)!.exitCode, null, "healthy container not killed");
    assert.equal(sb.started.length, 1, "no second container (no resume)");
    assert.equal((await state(r2, a.id)).generation, a.generation, "generation not bumped");
    assert.equal(readFileSync(join(ws, "dirty.txt"), "utf8"), "uncommitted work since the checkpoint", "worktree not rolled back");
    sb.exit(sandbox!, 0);
    await until(terminal(r2, a.id), "adopted agent finished");
    assert.equal((await state(r2, a.id)).exit, "succeeded");
  } finally {
    await cleanup(r1, r2);
  }
});

test("restart with a DEAD container resumes in the SAME kept folder: uncommitted work survives, nothing is rolled back or snapshotted", async () => {
  const sb = new FakeSandbox();
  const r1 = rig();
  const { a, ws } = await seedRunning(r1, sb, "dd", { container: "dead" });
  let wake = "";
  const r2 = rig({
    repo: r1.repo,
    stateDir: r1.stateDir,
    sandbox: sb,
    resume: (_a, w) => {
      wake = w;
      return { result: { status: "succeeded", result: "ok" } };
    },
  });
  try {
    await r2.daemon.recover();
    await r2.orchestrator.idle();
    const rec = await state(r2, a.id);
    assert.ok(rec.generation > a.generation, "forced resume fenced the dead instance");
    assert.notEqual(wake, "", "harness.resume ran");
    assert.equal(readFileSync(join(ws, "dirty.txt"), "utf8"), "uncommitted work since the checkpoint", "same folder re-mounted, edits intact");
    assert.ok(
      !msgs(await r2.daemon.events({ agent: a.id })).some((x) => x.includes("snapshotted") || x.includes("evicted")),
      "no snapshot or eviction fallback",
    );
  } finally {
    await cleanup(r1, r2);
  }
});

test("restart with a DEAD container and an EVICTED folder falls back to a fresh clone and journals that un-pushed work is gone", async () => {
  const sb = new FakeSandbox();
  const r1 = rig();
  const { a, ws } = await seedRunning(r1, sb, "ev", { container: "dead" });
  await r1.workspace.evict(a.id);
  const r2 = rig({ repo: r1.repo, stateDir: r1.stateDir, sandbox: sb, resume: () => ({ result: { status: "succeeded", result: "ok" } }) });
  try {
    await r2.daemon.recover();
    await r2.orchestrator.idle();
    assert.ok(
      msgs(await r2.daemon.events({ agent: a.id })).some((x) => x.includes("workspace folder was evicted")),
      "fallback journaled",
    );
    assert.ok(await r2.workspace.has(a.id), "a fresh folder was created");
    assert.ok(!existsSync(join(ws, "dirty.txt")), "evicted edits are gone");
  } finally {
    await cleanup(r1, r2);
  }
});

test("generation-storm guard: stalled admission + repeated reconcile neither re-resumes nor wipes the worktree", async () => {
  const sb = new FakeSandbox();
  let open = true;
  const r1 = rig();
  const { a, ws } = await seedRunning(r1, sb, "gs");
  const r2 = rig({ repo: r1.repo, stateDir: r1.stateDir, sandbox: sb, deps: { resourceGate: async () => ({ ok: open }) } });
  try {
    open = false; // admission stalls
    await r2.daemon.reconcile();
    const g1 = (await state(r2, a.id)).generation;
    assert.ok(g1 > a.generation, "first tick resumed once");
    await new Promise((res) => setTimeout(res, 30));
    await r2.daemon.reconcile();
    await r2.daemon.reconcile();
    assert.equal((await state(r2, a.id)).generation, g1, "later ticks skip the in-flight resume");
    assert.ok(existsSync(join(ws, "dirty.txt")), "worktree not wiped while parked in admission");
    assert.equal(sb.started.length, 0, "nothing started");
    await r2.daemon.kill(a.id);
  } finally {
    open = true;
    await cleanup(r1, r2);
  }
});

test("reap no longer merges: reconcile leaves a reaped succeeded child's work out of the parent's folder and writes no merge marker", async () => {
  const r = rig();
  try {
    const root = await r.daemon.root();
    const reg = r.store.registry;
    const p = await reg.create({ parent: root.id, name: "p", task: "t", host: "h1", budgetMicros: 100, idempotencyKey: "p", spec });
    const c = await reg.create({ parent: p.id, name: "c", task: "t", host: "h1", budgetMicros: 10, idempotencyKey: "c", spec });
    const pws = await r.workspace.create(p.id, {});
    const cws = await r.workspace.create(c.id, {});
    writeFileSync(join(r.workspace.hostPath(cws.workspace), "child.txt"), "from child");
    await reg.transition(p.id, p.generation, "running", { idempotencyKey: "p-run" });
    await reg.transition(c.id, c.generation, "running", { idempotencyKey: "c-run" });
    await reg.transition(c.id, c.generation, "exited", { exit: "succeeded", idempotencyKey: "c-x" });
    await reg.transition(c.id, c.generation, "reaped", { idempotencyKey: "c-r" });
    await reg.transition(p.id, p.generation, "yielded", { idempotencyKey: "p-y" });
    assert.ok(!existsSync(join(r.workspace.hostPath(pws.workspace), "child.txt")));
    const markers = async () => (await r.daemon.events({ agent: p.id })).filter((e) => e.payload.kind === "ext.pomtreed.merged").length;
    const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.workspace.hostPath(pws.workspace), encoding: "utf8" });
    const h0 = head();
    await r.daemon.reconcile();
    await r.daemon.reconcile();
    assert.ok(!existsSync(join(r.workspace.hostPath(pws.workspace), "child.txt")), "the child's file never reaches the parent without an explicit pull/merge");
    assert.equal(await markers(), 0, "no merge marker");
    assert.equal(head(), h0, "parent HEAD unchanged");
    assert.ok(await r.workspace.has(c.id), "the child's folder is kept for the sweep");
  } finally {
    await cleanup(r);
  }
});

const yielder = (key: string, before?: (r: () => Rig) => Promise<void>): { play: NonNullable<RigOpts["play"]>; get: (r: Rig) => void } => {
  let rr!: Rig;
  return {
    get: (r) => (rr = r),
    play: () => ({
      run: async (api) => {
        await before?.(() => rr);
        await api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: key });
      },
    }),
  };
};
const msg = (body: string) => ({ kind: "message", from: "someone", body }) as never;

test("lost wake after a crash: a message queued but never woken re-wakes the yielded agent on the boot reconcile", async () => {
  const y = yielder("y1");
  const r1 = rig({ play: y.play });
  y.get(r1);
  let wake = "";
  let r2!: Rig;
  try {
    const root = await r1.daemon.root();
    const a = await r1.daemon.spawn(root.id, { name: "lw", task: "t", idempotencyKey: "lw" });
    await until(async () => (await state(r1, a.id)).state === "yielded", "yielded");
    await r1.orchestrator.idle();
    await r1.store.mailbox.send(a.id, msg("hi"), "lost-1"); // mailbox write landed, wake never ran
    await r1.orchestrator.idle();
    assert.equal((await state(r1, a.id)).state, "yielded");
    r2 = rig({
      repo: r1.repo,
      stateDir: r1.stateDir,
      resume: (_a, w) => {
        wake = w;
        return { result: { status: "succeeded", result: "woke" } };
      },
    });
    await r2.daemon.recover();
    await r2.orchestrator.idle();
    assert.ok(kindsOf(await r2.daemon.events({ agent: a.id })).includes("resumed"));
    assert.ok(wake.length > 0);
    assert.equal((await state(r2, a.id)).exit, "succeeded");
  } finally {
    await cleanup(...[r1, r2].filter(Boolean));
  }
});

test("stale signal: a message already queued at yield time does not re-wake after restart; a later one does", async () => {
  let r1!: Rig;
  const y = yielder("y2", async (r) => {
    const a = (await r().daemon.list({ parent: (await r().daemon.root()).id }))[0]!;
    await r().store.mailbox.send(a.id, msg("old"), "stale-1"); // seen by the agent before it yields
  });
  r1 = rig({ play: y.play });
  y.get(r1);
  const rigs: Rig[] = [r1];
  try {
    const root = await r1.daemon.root();
    const a = await r1.daemon.spawn(root.id, { name: "st", task: "t", idempotencyKey: "st" });
    await until(async () => (await state(r1, a.id)).state === "yielded", "yielded");
    await r1.orchestrator.idle();
    const boot = () => {
      const r = rig({ repo: r1.repo, stateDir: r1.stateDir, resume: () => ({ result: { status: "succeeded", result: "woke" } }) });
      rigs.push(r);
      return r;
    };
    const r2 = boot();
    await r2.daemon.recover();
    await r2.orchestrator.idle();
    assert.equal((await state(r2, a.id)).state, "yielded", "stale signal did not re-wake");
    assert.ok(!kindsOf(await r2.daemon.events({ agent: a.id })).includes("resumed"));
    await r2.store.mailbox.send(a.id, msg("new"), "fresh-1");
    const r3 = boot();
    await r3.daemon.recover();
    await r3.orchestrator.idle();
    assert.ok(kindsOf(await r3.daemon.events({ agent: a.id })).includes("resumed"), "fresh signal woke it");
  } finally {
    await cleanup(...rigs);
  }
});
