import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxSpec } from "@pomtree/core";
import { TEST_OWNER, get, setup, spawnSpec, until } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

const child = (c: Ctx, task: string, key = "c1", extra: object = {}) => c.api("POST", "/v1/agents", { task, idempotencyKey: key, ...extra });
const spec = (agent: string): SandboxSpec => ({
  host: "h1",
  generation: 0,
  agent,
  image: "i",
  env: {},
  mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }],
  labels: { daemon_epoch: "0" },
});

test("the sandbox id is recorded in the registry while running and cleared at exit", async () => {
  let during: string | null | undefined;
  const t = setup(async (c) => {
    during = (await t.daemon.get(c.agent))?.sandbox;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const started = [
    ...(await t.fakes.sandbox.list(TEST_OWNER)).map((s) => ({ id: s.id as string })),
    ...t.fakes.calls.filter((x) => x.method === "stop").map((x) => ({ id: x.args[0] as string })),
  ];
  assert.ok(during, "registry carries the sandbox id while the agent runs");
  assert.ok(started.some((s) => s.id === during));
  assert.equal((await get(t, a.id)).sandbox, null);
});

test("transition and bump keys are deterministic: agent id, generation, target state", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const a = await t.spawn();
  await t.orchestrator.idle();
  const keys = t.fakes.calls
    .filter((c) => c.port === "Registry" && c.method === "transition")
    .map((c) => (c.args[3] as { idempotencyKey: string }).idempotencyKey);
  assert.ok(keys.includes(`${a.id}:${a.generation}:running`));
  assert.ok(keys.includes(`${a.id}:${a.generation}:exited`));
  assert.equal(new Set(keys).size, keys.length - keys.filter((k) => k.endsWith(":running")).length + new Set(keys.filter((k) => k.endsWith(":running"))).size);
  // A second root() (restart) replays the same key instead of re-running the transition.
  const r1 = await t.daemon.root();
  const r2 = await t.daemon.root();
  assert.equal(r1.state, "running");
  assert.equal(r2.generation, r1.generation);
});

test("recover re-adopts a running agent's sandbox by registry id", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const o = await reg.create({ spec: spawnSpec, parent: root.id, name: "o", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "o" });
  await reg.transition(o.id, o.generation, "running", { idempotencyKey: "o-run" });
  const sb = await t.fakes.sandbox.start(spec(o.id), "sb-reclaim");
  await reg.setSandbox(o.id, o.generation, sb.id, "set-reclaim");
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  assert.ok(!t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "stop" && c.args[0] === sb.id), "an adopted container is not stopped");
  assert.equal((await get(t, o.id)).state, "running", "a checkpoint-less running agent is adopted, not failed");
  t.fakes.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, o.id)).state !== "running");
  assert.equal((await get(t, o.id)).exit, "succeeded");
});

test("recover adopts a labelled container for a running agent and kills a foreign one", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const o = await reg.create({ spec: spawnSpec, parent: root.id, name: "o", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "o" });
  await reg.transition(o.id, o.generation, "running", { idempotencyKey: "o-run" });
  const stray = await t.fakes.sandbox.start(spec(o.id), "sb-stray"); // crash between sandbox.start and setSandbox
  const ghost = await t.fakes.sandbox.start(spec("no-such-agent"), "sb-ghost");
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  const kills = t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "kill").map((c) => c.args[0]);
  assert.ok(kills.includes(ghost.id)); // foreign: no registry record points at it
  assert.equal((await get(t, o.id)).sandbox, stray.id, "the labelled container was adopted into the registry");
  assert.ok(
    t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach" && c.args[0] === stray.id),
    "the adopted container is re-attached, not stopped",
  );
  t.fakes.sandbox.exit(stray.id, 0);
  await until(async () => (await get(t, o.id)).state !== "running");
});

test("recover kills a container whose record is on another host", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const o = await reg.create({ spec: spawnSpec, parent: root.id, name: "o", task: "t", host: "h2", budgetMicros: 1, idempotencyKey: "o" });
  await reg.transition(o.id, o.generation, "running", { idempotencyKey: "o-run" });
  const sb = await t.fakes.sandbox.start(spec(o.id), "sb-foreign");
  await t.daemon.recover();
  const kills = t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "kill").map((c) => c.args[0]);
  assert.ok(kills.includes(sb.id));
  assert.equal((await get(t, o.id)).state, "running"); // on another host, so recover leaves it alone
});

test("recover stops a second container labelled for an already-adopted agent", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const o = await reg.create({ spec: spawnSpec, parent: root.id, name: "o", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "o" });
  await reg.transition(o.id, o.generation, "running", { idempotencyKey: "o-run" });
  const sb1 = await t.fakes.sandbox.start(spec(o.id), "sb-1");
  await reg.setSandbox(o.id, o.generation, sb1.id, "set-1");
  const sb2 = await t.fakes.sandbox.start(spec(o.id), "sb-2"); // a second container, same label
  await t.daemon.recover();
  await t.orchestrator.idle();
  const stops = t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "stop").map((c) => c.args[0]);
  assert.ok(stops.includes(sb2.id)); // superseded by the already-adopted sb1
  const adopted = t.fakes.calls.filter((c) => c.port === "Registry" && c.method === "setSandbox" && c.args[2] === sb2.id);
  assert.equal(adopted.length, 0); // sb2 is never adopted over sb1
});

test("recover evicts folders of gone agents; the sweep evicts reaped agents' folders", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const reaped = await reg.create({ spec: spawnSpec, parent: root.id, name: "r", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "r" });
  await reg.transition(reaped.id, reaped.generation, "running", { idempotencyKey: "r-run" });
  await reg.transition(reaped.id, reaped.generation, "exited", { exit: "succeeded", idempotencyKey: "r-exit" });
  await reg.transition(reaped.id, reaped.generation, "reaped", { idempotencyKey: "r-reap" });
  await t.daemon.deps.workspace.create(reaped.id, {});
  await t.daemon.deps.workspace.create("gone-agent", {});
  assert.deepEqual([...(await t.daemon.deps.workspace.list())].sort(), ["gone-agent", reaped.id].sort());
  await t.daemon.recover();
  assert.deepEqual(await t.daemon.deps.workspace.list(), [reaped.id], "only the unknown agent's folder goes at recovery");
  await t.daemon.sweepCleanup();
  assert.deepEqual(await t.daemon.deps.workspace.list(), []);
});

test("kill after a restart uses the registry's sandbox id", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const o = await reg.create({ spec: spawnSpec, parent: root.id, name: "o", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "o" });
  await reg.transition(o.id, o.generation, "running", { idempotencyKey: "o-run" });
  const sb = await t.fakes.sandbox.start(spec(o.id), "sb-kill");
  await reg.setSandbox(o.id, o.generation, sb.id, "set-kill");
  await t.daemon.kill(o.id);
  const kills = t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "kill").map((c) => c.args[0]);
  assert.deepEqual(kills, [sb.id]);
  const after = await get(t, o.id);
  assert.equal(after.sandbox, null);
  assert.equal(after.exit, "cancelled");
});
