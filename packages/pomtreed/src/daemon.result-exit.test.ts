import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentRecord, SandboxUnavailableError } from "@pomtree/core";
import { SANDBOX_LIFECYCLE_KIND } from "./daemon-util.ts";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

// A worker that recorded its result and then exited non-zero (the browser worker's 124 time-budget exit, a crash): the recorded
// result decides the run's exit and is the parent's handoff; the observed exit code stays on the sandbox `exited` entry.
const sandboxExit = async (t: ReturnType<typeof setup>, id: string) =>
  (await t.journal.read({ agent: id })).find((e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { phase?: string }).phase === "exited")
    ?.payload as { exitCode?: number; cause?: string; expected?: boolean } | undefined;
const exitAfter = (t: ReturnType<typeof setup>, code: number) => async () => {
  await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
  t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, code);
};
const summaryOf = (r: AgentRecord) => (r.result as { summary?: string } | undefined)?.summary ?? "";

test("a succeeded result then exit 124: the run is succeeded and the handoff is the recorded result", async () => {
  let t!: ReturnType<typeof setup>;
  t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "First IBM keyboard in 1981" } });
    await exitAfter(t, 124)();
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const r = await get(t, a.id);
  assert.equal(r.exit, "succeeded");
  assert.equal(summaryOf(r), "First IBM keyboard in 1981");
  assert.doesNotMatch(summaryOf(r), /no handoff was written/);
  assert.deepEqual({ code: (await sandboxExit(t, a.id))?.exitCode, cause: (await sandboxExit(t, a.id))?.cause }, { code: 124, cause: undefined });
});

test("a failed result then exit 1: the run is failed and the handoff is the recorded result (unchanged)", async () => {
  let t!: ReturnType<typeof setup>;
  t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "page never loaded" } });
    await exitAfter(t, 1)();
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const r = await get(t, a.id);
  assert.equal(r.exit, "failed");
  assert.equal(summaryOf(r), "page never loaded");
});

test("negative: exit 124 without a result is failed with the synthesized no-handoff text (unchanged)", async () => {
  let t!: ReturnType<typeof setup>;
  t = setup(async () => exitAfter(t, 124)());
  const a = await t.spawn();
  await t.orchestrator.idle();
  const r = await get(t, a.id);
  assert.equal(r.exit, "failed");
  assert.match(summaryOf(r), /^Child \S+ ended failed after \$[\d.]+ of \$[\d.]+; no handoff was written; its workspace folder is kept \(not merged\)/);
});

// Regression (live trace, interactive browser worker): a container adopted by a restarted daemon recorded its result after the
// adoption, then exited 124; the adopt path read only the result known at adoption, so the run ended failed with "no handoff was written".
const adopted = async () => {
  const t = setup(async () => {});
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
};

test("adopt path: a result recorded after adoption survives a non-zero exit (succeeded, the recorded handoff)", async () => {
  const { t, a, sb } = await adopted();
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  assert.notEqual(await t.daemon.submitResult(a.id, "succeeded", { summary: "found it" }), "conflict");
  t.fakes.hooks.raw.sandbox.exit(sb.id, 124);
  await until(async () => (await get(t, a.id)).state !== "running");
  const r = await get(t, a.id);
  assert.equal(r.exit, "succeeded");
  assert.equal(summaryOf(r), "found it");
});

test("negative, adopt path: no result and a non-zero exit stays failed with the no-handoff text", async () => {
  const { t, a, sb } = await adopted();
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  t.fakes.hooks.raw.sandbox.exit(sb.id, 124);
  await until(async () => (await get(t, a.id)).state !== "running");
  const r = await get(t, a.id);
  assert.equal(r.exit, "failed");
  assert.match(summaryOf(r), /no handoff was written/);
});

// Regression: an adopt error after a result was recorded (container vanished, or adoption failed twice) finished with the stale
// adopt-time `reported`, dropping the recorded result and ending the run failed.
test("adopt path: a result recorded after adoption survives a SandboxUnavailable error from wait", async () => {
  const { t, a, sb } = await adopted();
  const raw = t.fakes.hooks.raw.sandbox;
  const attach = raw.attach.bind(raw);
  let fail!: () => void;
  raw.attach = async (id, agent) => ({
    ...(await attach(id, agent)),
    wait: () => new Promise<never>((_, rej) => (fail = () => rej(new SandboxUnavailableError()))),
  });
  await t.daemon.recover();
  await until(async () => fail !== undefined);
  assert.notEqual(await t.daemon.submitResult(a.id, "succeeded", { summary: "found it" }), "conflict");
  fail();
  await until(async () => (await get(t, a.id)).state !== "running");
  const r = await get(t, a.id);
  assert.equal(r.exit, "succeeded");
  assert.equal(summaryOf(r), "found it");
  assert.ok(sb.id);
});

test("adopt path: a result recorded after adoption survives a second adoption failure", async () => {
  const { t, a } = await adopted();
  const raw = t.fakes.hooks.raw.sandbox;
  const attach = raw.attach.bind(raw);
  let fail!: () => void;
  let attaches = 0;
  raw.attach = async (id, agent) => ({
    ...(await attach(id, agent)),
    wait: () => {
      attaches++;
      return new Promise<never>((_, rej) => (fail = () => rej(new Error("boom"))));
    },
  });
  await t.daemon.recover();
  await until(async () => attaches === 1);
  fail();
  await until(async () => t.daemon.deps.registry.get(a.id).then(() => true));
  await t.daemon.recover();
  await until(async () => attaches === 2);
  assert.notEqual(await t.daemon.submitResult(a.id, "succeeded", { summary: "found it" }), "conflict");
  fail();
  await until(async () => (await get(t, a.id)).state !== "running");
  const r = await get(t, a.id);
  assert.equal(r.exit, "succeeded");
  assert.equal(summaryOf(r), "found it");
});

// The attach-time branch: the container is gone by the time the restarted daemon re-attaches, so attach itself throws
// SandboxUnavailable. The run is journalled as restarted-with-no-container and finishes failed.
const errorMessages = async (t: ReturnType<typeof setup>, id: string) =>
  (await t.journal.read({ agent: id })).flatMap((e) => (e.payload.kind === "error" ? [(e.payload as { message: string }).message] : []));

test("adopt path: a container gone at attach time journals the restart and finishes the run failed", async () => {
  const { t, a, sb } = await adopted();
  t.fakes.hooks.raw.sandbox.exit(sb.id, 1);
  await t.daemon.recover();
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "failed");
  assert.ok((await errorMessages(t, a.id)).some((m) => /daemon restarted while running; container is gone/.test(m)));
  assert.equal(
    (await errorMessages(t, a.id)).some((m) => /adoption failed/.test(m)),
    false,
    "not the generic adoption-failure path",
  );
});

test("negative, adopt path: a live container at attach time does not journal the container-gone error", async () => {
  const { t, a, sb } = await adopted();
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  t.fakes.hooks.raw.sandbox.exit(sb.id, 0);
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal(
    (await errorMessages(t, a.id)).some((m) => /container is gone/.test(m)),
    false,
  );
});

// Scripted through FakeSandbox.waitErrors instead of a stubbed attach: wait() rejects while the container is still attached.
test("adopt path: a wait() that fails SandboxUnavailable with no result journals the stop and finishes the run failed", async () => {
  const { t, a, sb } = await adopted();
  t.fakes.hooks.raw.sandbox.waitErrors.set(sb.id, new SandboxUnavailableError());
  await t.daemon.recover();
  await until(async () => (await get(t, a.id)).state !== "running");
  assert.equal((await get(t, a.id)).exit, "failed");
  assert.ok((await errorMessages(t, a.id)).some((m) => m === "adopted container stopped unexpectedly"));
});
