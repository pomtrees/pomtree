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
    { host: "h1", generation: 0, agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
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

test("an adopted running sandbox whose spec fails template admission is killed and reported with cause and action", async () => {
  const refusal = "template code needs egress.allowHost, which the podman backend does not declare";
  const { t, a, sb } = await adoptable({ admitSpec: () => [refusal] });
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill" && JSON.stringify(c.args).includes(sb.id)));
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "cancelled");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  const report = errs.find((m) => m.includes(refusal));
  assert.ok(report, `an admission refusal is journaled, got ${JSON.stringify(errs)}`);
  assert.match(report, /stopped adopted sandbox/, "names what happened");
  assert.match(report, /change the template|restart/, "names the action");
});

test("an adopted running sandbox whose spec passes template admission keeps running", async () => {
  const { t, a, sb } = await adoptable({ admitSpec: () => [] });
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  assert.ok(!t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill"), "no kill for an admitted spec");
  assert.equal((await get(t, a.id)).state, "running");
  t.fakes.hooks.raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");
});

test("an adopted sandbox that cannot be killed is reported with cause and action, never journaled as stopped, and its agent ends failed", async () => {
  const { t, a, sb } = await adoptable({ admitSpec: () => ["template code needs egress.allowHost"] });
  const real = t.daemon.deps.sandbox;
  (t.daemon.deps as unknown as { sandbox: unknown }).sandbox = Object.assign(Object.create(real), {
    kill: async () => {
      throw new Error("engine socket closed");
    },
  });
  await t.daemon.recover();
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "failed");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  assert.ok(!errs.some((m) => m.startsWith("stopped adopted sandbox")), `no false "stopped": ${JSON.stringify(errs)}`);
  const report = errs.find((m) => m.startsWith("could not stop adopted sandbox"));
  assert.ok(report, JSON.stringify(errs));
  assert.match(report, /engine socket closed/, "names the cause");
  assert.ok(report.includes(sb.id) && /remove command/.test(report), "names the operator action engine-neutrally when the engine is unknown");
  assert.ok(!report.includes("docker rm"), "no hard-coded docker command");
});

test("a throw from admitSpec during adoption frees the reservation so the next pass adopts the agent", async () => {
  let calls = 0;
  const { t, a, sb } = await adoptable({
    admitSpec: () => {
      if (calls++ === 0) throw new Error("admission blew up");
      return [];
    },
  });
  await t.daemon.recover().catch(() => {});
  await t.daemon.recover().catch(() => {});
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  assert.ok(calls >= 2, "admission ran again, so the live entry was released");
  t.fakes.hooks.raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");
});

test("a failed kill names the selected engine's CLI in the operator action (podman, not docker)", async () => {
  const { t, a, sb } = await adoptable({ admitSpec: () => ["needs egress.allowHost"] });
  (t.daemon.deps as unknown as { backend: unknown }).backend = { id: "podman", engine: { binary: "podman" } };
  const real = t.daemon.deps.sandbox;
  (t.daemon.deps as unknown as { sandbox: unknown }).sandbox = Object.assign(Object.create(real), {
    kill: async () => {
      throw new Error("down");
    },
  });
  await t.daemon.recover();
  await until(async () => (await get(t, a.id)).state !== "running");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  const report = errs.find((m) => m.startsWith("could not stop adopted sandbox")) ?? "";
  assert.ok(report.includes(`\`podman rm -f ${sb.id}\``), report);
  assert.ok(!report.includes("docker"), report);
});

test("an adopted sandbox with no agent record is treated as unadmitted: killed and reported with cause and action", async () => {
  const { t, a, sb } = await adoptable({ admitSpec: () => [] });
  const reg = t.daemon.deps.registry;
  (t.daemon.deps as unknown as { registry: unknown }).registry = Object.assign(Object.create(reg), { get: async () => null });
  const logged: string[] = [];
  const real = console.error;
  console.error = (...x: unknown[]) => void logged.push(x.join(" "));
  try {
    const d = t.daemon as unknown as { lifecycle: { adoptRunning: (...x: unknown[]) => Promise<void> } };
    await d.lifecycle.adoptRunning(a.id, sb.id, a.generation);
    await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill" && JSON.stringify(c.args).includes(sb.id)));
  } finally {
    console.error = real;
  }
  const line = logged.find((l) => l.includes("no agent record")) ?? "";
  assert.match(line, /stopped adopted sandbox/, "names what happened");
  assert.match(line, /change the template or the backend/, "names the action");
});
