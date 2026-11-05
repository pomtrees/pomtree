import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, issueToken } from "@pomtree/pomtreed";
import { TEST_MODEL } from "@pomtree/testing";
import { SECRET, rig, seedCheckpoint, until } from "./harness.ts";

const kinds = (es: { payload: { kind: string; exit?: string } }[]) => es.map((e) => e.payload.kind + (e.payload.kind === "exited" ? `:${e.payload.exit}` : ""));

// The one e2e restart case (`e2e.test.ts`) only covers a *running* agent with no checkpoint being
// failed on restart. These two cover the yield/resume half: a durable checkpoint that lost its
// in-memory wait registration (timer arming), and a fully-yielded agent resumed through the real
// store + workspace after the daemon that yielded it is gone.

test("recover re-arms a timer wait lost between the yield checkpoint and wait registration", async () => {
  // Seed the durable half of a yield directly (checkpoint + yielded transition) with NO daemon ever
  // having armed an in-memory timer: exactly the crash window in Daemon.yield() between
  // checkpoints.write/registry.transition("yielded") and orchestrator.waitFor.
  const r = rig();
  let childId = "";
  let resumeWake = "";
  try {
    const root = await r.daemon.root();
    const created = await r.store.registry.create({
      parent: root.id,
      name: "w",
      task: "t",
      host: "h1",
      budgetMicros: 1_000,
      idempotencyKey: "w",
      spec: {
        image: "img@sha256:e2e",
        envManifestHash: null,
        extensions: [],
        provider: TEST_MODEL.provider,
        model: TEST_MODEL.id,
        systemPrompt: null,
        egress: { kind: "none" },
      },
    });
    childId = created.id;
    // A real worktree + commit and a content-addressed session so runResumed's checkout/restore succeed.
    const { workspace } = await r.workspace.create(created.id, {});
    await r.store.registry.transition(created.id, created.generation, "running", { idempotencyKey: "w-run" });
    await r.store.registry.transition(created.id, created.generation, "yielded", { idempotencyKey: "w-yield" });
    // past-due timer: must fire as soon as re-armed
    await seedCheckpoint(r, created, "w-cp", { workspace, wait: { kind: "timer", at: Date.now() - 1_000 } });

    // "Restart": a fresh daemon over the same stores; only its recover() can re-arm the wait.
    const r2 = rig({
      repo: r.repo,
      stateDir: r.stateDir,
      resume: (_agent, wake) => {
        resumeWake = wake;
        return { result: { status: "succeeded", result: wake } };
      },
    });
    try {
      await r2.daemon.recover();
      await until(async () => (await r2.daemon.events({ agent: childId })).some((e) => e.payload.kind === "resumed"), "agent resumed after re-arm");
      await r2.orchestrator.idle();

      const rec = (await r2.daemon.get(childId))!;
      assert.equal(rec.state, "reaped");
      assert.equal(rec.exit, "succeeded");
      assert.equal(rec.generation, 1, "resume bumps the generation");
      assert.deepEqual(rec.result, { summary: "ok", value: "timer elapsed" });
      assert.equal(resumeWake, "timer elapsed");
      assert.ok(kinds(await r2.daemon.events({ agent: childId })).includes("resumed"));
    } finally {
      r2.store.close();
    }
  } finally {
    r.store.close();
  }
});

test("a yielded agent survives a daemon restart and resumes from its checkpoint", async () => {
  // daemon 1: the agent yields through the real API with a timer wait far in the future, so its
  // in-memory timer is armed but never fires during the test (a real crash would lose it).
  const r1 = rig({
    play: (agent) => ({
      run: async (api) => {
        await api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: Date.now() + 120_000 }, idempotencyKey: "y1" });
      },
    }),
  });
  let childId = "";
  let resumeWake = "";
  try {
    const root = await r1.daemon.root();
    const a = await r1.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "w" });
    childId = a.id;
    await until(async () => (await r1.daemon.get(a.id))?.state === "yielded", "agent yielded");
    await r1.orchestrator.idle(); // let settleYield finish so no stale generation write races the restart

    // "Restart": a second daemon over the same stores sees the yielded agent and re-arms its wait.
    const r2 = rig({
      repo: r1.repo,
      stateDir: r1.stateDir,
      resume: (_agent, wake) => {
        resumeWake = wake;
        return { result: { status: "succeeded", result: wake } };
      },
    });
    try {
      await r2.daemon.recover();
      assert.equal((await r2.daemon.get(childId))?.state, "yielded", "recovery re-arms, does not resume a future timer wait");

      // Operator resume brings it back from the durable checkpoint.
      const res = await handle(r2.daemon, {
        method: "POST",
        url: `/v1/agents/${childId}/resume`,
        body: { idempotencyKey: "op-resume" },
        token: issueToken(SECRET, { scope: "operator" }),
      });
      assert.equal(res.status, 200);
      await r2.orchestrator.idle();

      const rec = (await r2.daemon.get(childId))!;
      assert.equal(rec.state, "reaped");
      assert.equal(rec.exit, "succeeded");
      assert.equal(rec.generation, 1);
      assert.deepEqual(rec.result, { summary: "ok", value: "operator resumed you" });
      assert.equal(resumeWake, "operator resumed you");
      assert.ok(kinds(await r2.daemon.events({ agent: childId })).includes("resumed"));
    } finally {
      r2.store.close();
    }
  } finally {
    r1.store.close();
  }
});
