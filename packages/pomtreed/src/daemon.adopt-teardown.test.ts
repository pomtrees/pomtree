import assert from "node:assert/strict";
import { test } from "node:test";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

async function adoptable(over: Parameters<typeof setup>[1] = {}) {
  const t = setup(async () => {}, over);
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  const sb = await t.fakes.hooks.raw.sandbox.start(
    { agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
    "sb",
  );
  await reg.setSandbox(a.id, a.generation, sb.id, "sb-set");
  return { t, a, sb };
}

function spy(t: ReturnType<typeof setup>, revokeFails = false) {
  const log: string[] = [];
  const d = t.daemon.deps as unknown as { gateway: { revoke: (a: string) => Promise<unknown> }; placement: { release: (a: string) => Promise<void> } };
  const gw = d.gateway;
  const pl = d.placement;
  d.gateway = Object.assign(Object.create(gw), {
    revoke: async (a: string) => {
      log.push("revoke");
      if (revokeFails) throw new Error("store down");
      return gw.revoke(a);
    },
  });
  d.placement = Object.assign(Object.create(pl), {
    release: async (a: string) => {
      log.push("release");
      return pl.release(a);
    },
  });
  return log;
}

test("adopted checkpoint-less agent exit revokes the key, unstages auth and releases placement", async () => {
  const unstaged: string[] = [];
  const { t, a, sb } = await adoptable({ credentials: { stage: () => [], unstage: (id: string) => void unstaged.push(id), providerIds: () => [] } as never });
  const log = spy(t);
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  t.fakes.hooks.raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "succeeded");
  assert.ok(log.includes("revoke"), "gateway key revoked");
  assert.ok(log.includes("release"), "placement released");
  assert.deepEqual(unstaged, [a.id], "auth unstaged");
});

test("a failed post-exit gateway revoke is journaled, not swallowed or thrown", async () => {
  const { t, a, sb } = await adoptable();
  spy(t, true);
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  t.fakes.hooks.raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "succeeded");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error");
  assert.ok(errs.some((e) => (e.payload as { message: string }).message.includes("revoke failed")));
});

test("two concurrent forced keyed resumes share one run: one new generation", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return;
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const g0 = (await get(t, aId)).generation;
  // The registry's generation-bump key also collapses a second bump, so the generation alone cannot tell a shared run from two
  // runs; count the segment launches, which only the in-flight share (Lifecycle.resuming) keeps from doubling.
  const launches: number[] = [];
  const resume = t.orchestrator.resume.bind(t.orchestrator);
  t.orchestrator.resume = (agent, generation, wake) => {
    launches.push(generation);
    return resume(agent, generation, wake);
  };
  const [r1, r2] = await Promise.all([t.daemon.resumeAgent(aId, "w", { forced: true }, "k-a"), t.daemon.resumeAgent(aId, "w", { forced: true }, "k-b")]);
  assert.equal(r1.generation, g0 + 1);
  assert.equal(r2.generation, g0 + 1);
  assert.equal((await get(t, aId)).generation, g0 + 1, "no second bump");
  assert.deepEqual(launches, [g0 + 1], "one segment launch for the shared run");
});
