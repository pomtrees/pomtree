import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, JournalEntry, SpawnSpec } from "@pomtree/core";
import { FakeSandbox, TEST_MODEL } from "@pomtree/testing";
import { rig, seedCheckpoint, until } from "./harness.ts";
import type { Rig } from "./harness.ts";

// Crash and fault gaps (reap-crash, restart-rollback, journal-latch), driven through
// the real store-sqlite + git workspace. Fakes only for the sandbox and the harness. A "restart" is a second rig over the same
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
const state = async (r: Rig, id: string) => (await r.daemon.get(id))!;
const cleanup = async (...rs: Rig[]) => {
  for (const r of rs) await r.orchestrator.idle().catch(() => {});
  for (const r of rs) {
    r.store.close();
    rmSync(r.stateDir, { recursive: true, force: true });
    rmSync(r.repo, { recursive: true, force: true });
  }
};
const terminal = (r: Rig, id: string) => async () => ["exited", "reaped"].includes((await state(r, id)).state);

// A crash between the registry `reaped` transition and its journal row: pomtreed's boot recovery replays the missing row
// (and the gateway revoke, which reapNow runs after it). The assertion is the intended behavior and must not be weakened.
test("reap-crash: a crash after the reaped transition but before its journal row and revoke converges on restart", async () => {
  const r1 = rig();
  let r2: Rig | undefined;
  try {
    const root = await r1.daemon.root();
    const reg = r1.store.registry;
    const c = await reg.create({ parent: root.id, name: "rc", task: "t", host: "h1", budgetMicros: 100, idempotencyKey: "rc", spec });
    await r1.workspace.create(c.id, {}); // the child's folder, as a real spawn creates it (the sweep keeps it after reap)
    await reg.transition(c.id, c.generation, "running", { idempotencyKey: "rc-run" });
    await reg.transition(c.id, c.generation, "exited", { exit: "succeeded", idempotencyKey: "rc-x" });
    // The crash: the registry reaped transition lands, then the process dies before `record` and `gateway.revoke`.
    await reg.transition(c.id, c.generation, "reaped", { idempotencyKey: "rc-r" });
    r2 = rig({ repo: r1.repo, stateDir: r1.stateDir });
    await r2.daemon.recover();
    await r2.orchestrator.idle();
    await r2.daemon.reconcile();
    await r2.orchestrator.idle();
    assert.equal((await state(r2, c.id)).state, "reaped");
    const reapedRows = kindsOf(await r2.daemon.events({ agent: c.id })).filter((k) => k === "reaped");
    assert.equal(reapedRows.length, 1, "the reaped journal row is written exactly once after the crash");
    assert.ok(await r2.workspace.has(c.id), "the reaped child's folder is kept for the sweep");
  } finally {
    await cleanup(r1, ...(r2 ? [r2] : []));
  }
});

test("restart-rollback: a failed sandbox start on a dead-container resume is terminal, journaled once, and never rolls back the kept worktree", async () => {
  const sb = new FakeSandbox();
  const r1 = rig();
  const root = await r1.daemon.root();
  const reg = r1.store.registry;
  const a = await reg.create({ parent: root.id, name: "rb", task: "t", host: "h1", budgetMicros: 1_000, idempotencyKey: "rb", spec });
  const ws = await r1.workspace.create(a.id, {});
  const dir = r1.workspace.hostPath(ws.workspace);
  writeFileSync(join(dir, "kept.txt"), "checkpointed");
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "rb-run" });
  const dead = await sb.start({ agent: a.id, image: "img", env: {}, mounts: [] }, "rb-sb");
  await reg.setSandbox(a.id, a.generation, dead.id, "rb-set", "fake");
  await sb.kill(dead.id, `${dead.id}:test-kill`);
  await seedCheckpoint(r1, a, "rb-cp", { workspace: ws.workspace });
  writeFileSync(join(dir, "dirty.txt"), "uncommitted work since the checkpoint");
  const seeded = sb.started.length;
  sb.startErrors.push(new Error("transient: docker daemon busy"));
  const r2 = rig({ repo: r1.repo, stateDir: r1.stateDir, sandbox: sb, resume: () => ({ result: { status: "succeeded", result: "ok" } }) });
  try {
    await r2.daemon.recover();
    await r2.orchestrator.idle();
    await until(terminal(r2, a.id), "resumed agent finished", 10_000);
    await r2.orchestrator.idle();
    const rec = await state(r2, a.id);
    // pomtreed does not retry a failed start on the restart path (the retry lives in the sandbox, `TODO(spawn-fail)`): the
    // agent ends failed, once, with the start error journaled. The invariants that must hold are the rollback ones below.
    assert.equal(rec.exit, "failed", "a failed start is terminal for this resume");
    assert.equal(sb.started.length, seeded, "no container was started by the failed resume");
    const evs = await r2.daemon.events({ agent: a.id });
    assert.equal(kindsOf(evs).filter((k) => k === "exited").length, 1, "one exit, not one per attempt");
    assert.ok(msgs(evs).includes("transient: docker daemon busy"), "the start error is journaled");
    assert.equal(readFileSync(join(dir, "dirty.txt"), "utf8"), "uncommitted work since the checkpoint", "worktree not rolled back");
    assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "checkpointed");
    await r2.daemon.reconcile();
    await r2.orchestrator.idle();
    assert.equal(kindsOf(await r2.daemon.events({ agent: a.id })).filter((k) => k === "exited").length, 1, "a later reconcile does not re-exit it");
  } finally {
    await cleanup(r1, r2);
  }
});

test("journal-latch: a failed journal append during spawn refuses new admissions and, after recovery, a retried spawn creates exactly one agent", async () => {
  let fail = false;
  const r = rig();
  const real = r.store.journal;
  const j = Object.create(real) as typeof real;
  j.append = async (e) => {
    if (fail) throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    return real.append(e);
  };
  const d = new (r.daemon.constructor as new (deps: unknown) => typeof r.daemon)({ ...r.daemon.deps, journal: j, admitRetryMs: 5 });
  try {
    const root = await d.root();
    fail = true;
    await d.spawn(root.id, { name: "jl", task: "t", idempotencyKey: "jl" }).catch(() => {});
    assert.equal((await d.doctor()).journalFailed, true, "the failed append latches journalFailed");
    fail = false;
    await d.probeStore();
    assert.equal((await d.doctor()).journalFailed, false, "latch cleared before the record check, so it must latch by itself");
    fail = true;
    await (d as unknown as { record: (a: AgentRecord, p: unknown, k: string) => Promise<unknown> })
      .record(root, { kind: "error", message: "x" }, "jf")
      .catch(() => {});
    assert.equal((await d.doctor()).journalFailed, true, "a resource-error append through record latches too");
    await d.probeStore(); // still failing: stays latched
    assert.equal((await d.doctor()).journalFailed, true, "a failing probe keeps the latch");
    await assert.rejects(() => d.spawn(root.id, { name: "jl2", task: "t", idempotencyKey: "jl2" }), "a new spawn is refused while latched");
    fail = false;
    await d.probeStore();
    assert.equal((await d.doctor()).journalFailed, false, "latch cleared once a write lands");
    assert.ok(kindsOf(await real.read({ agent: root.id })).includes("ext.pomtreed.host_health"), "probe row landed in the real store");
    const first = await d.spawn(root.id, { name: "jl", task: "t", idempotencyKey: "jl" });
    const again = await d.spawn(root.id, { name: "jl", task: "t", idempotencyKey: "jl" });
    assert.equal(again.id, first.id, "the same key returns the same agent");
    const named = (await d.list({ parent: root.id })).filter((a: AgentRecord) => a.name === "jl");
    assert.equal(named.length, 1, "no duplicate child from the failed attempt");
  } finally {
    await cleanup(r);
  }
});
