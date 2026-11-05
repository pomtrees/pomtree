import assert from "node:assert/strict";
import { test } from "node:test";
import { exitedDetail, SANDBOX_LIFECYCLE_KIND, stoppedAfterResult } from "./daemon-util.ts";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

const exited = async (t: ReturnType<typeof setup>, id: string) => {
  const rows = await t.journal.read({ agent: id });
  const ex = rows.find((e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { phase?: string }).phase === "exited");
  return { sandbox: ex?.payload as { exitCode?: number; cause?: string; expected?: boolean; observedExitCode?: number } | undefined, rows };
};
const restarts = (rows: { payload: { kind: string } }[]) =>
  rows.filter((e) => e.payload.kind === "error" && (e.payload as { message?: string }).message?.startsWith("auto-restart:"));
const result = { result: { summary: "ok", value: "done" } };

test("stoppedAfterResult: only 137/143 after a result, never OOM", () => {
  assert.equal(stoppedAfterResult({ exitCode: 143, hasResult: true }), true);
  assert.equal(stoppedAfterResult({ exitCode: 137, hasResult: true }), true);
  assert.equal(stoppedAfterResult({ exitCode: 143, hasResult: false }), false);
  assert.equal(stoppedAfterResult({ exitCode: 137, oomKilled: true, hasResult: true }), false);
  assert.equal(stoppedAfterResult({ exitCode: 1, hasResult: true }), false);
  assert.equal(stoppedAfterResult({ exitCode: 3, hasResult: true }), false);
});

test("exitedDetail: expected stop is journaled clean with the observed code kept", () => {
  assert.deepEqual(exitedDetail({ exitCode: 143 }, true), { exitCode: 0, expected: true, observedExitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(exitedDetail({ exitCode: 1, oomKilled: true }, false), { exitCode: 1, oomKilled: true });
});

test("a daemon stop after the agent reported its result journals a clean exit and never restarts", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", result)));
  t.fakes.hooks.raw.sandbox.stopPolicy = "sigterm";
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).exit, "succeeded");
  const { sandbox, rows } = await exited(t, a.id);
  assert.deepEqual(
    { exitCode: sandbox?.exitCode, expected: sandbox?.expected, observed: sandbox?.observedExitCode, cause: sandbox?.cause },
    { exitCode: 0, expected: true, observed: 143, cause: undefined },
  );
  assert.equal((await get(t, a.id)).exitCause, undefined);
  assert.equal(restarts(rows).length, 0);
});

test("an external kill before any result keeps host_stopped and the checkpointed auto-restart", async () => {
  let runs = 0;
  const t = setup(async (c) => {
    runs++;
    if (runs === 1) {
      const rec = await get(t, c.agent);
      await t.daemon.deps.checkpoints.write(
        {
          agent: rec.id,
          generation: rec.generation,
          host: "h1",
          sessionRef: "sha256:fake",
          workspace: `ws-${rec.id}`,
          node: "h1",
          ingested: null,
          wait: { kind: "message" },
          remainingBudgetMicros: 50_000,
          imageDigest: "img@sha256:x",
          envManifestHash: null,
          template: "code",
          templateDigest: null,
          resumeLevel: "session",
        },
        "cp-key",
      );
      await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
      t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 143);
      return;
    }
    await c.api("POST", "/v1/agents/self/result", result);
  });
  const a = await t.spawn();
  await until(async () => ["exited", "reaped"].includes((await get(t, a.id)).state));
  await t.orchestrator.idle();
  assert.equal(runs, 2);
  const { sandbox, rows } = await exited(t, a.id);
  assert.equal(sandbox?.expected, undefined);
  assert.equal(sandbox?.exitCode, 143);
  assert.equal(sandbox?.cause, "host_stopped");
  assert.equal(restarts(rows).length, 1);
});

test("a crash exit code (nonzero, not a stop signal) keeps its observed code and failed status", async () => {
  const t = setup(async () => {
    await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
    t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 3);
  }, {});
  const a = await t.spawn();
  await t.orchestrator.idle();
  const { sandbox, rows } = await exited(t, a.id);
  assert.equal(sandbox?.exitCode, 3);
  assert.equal(sandbox?.expected, undefined);
  assert.equal((await get(t, a.id)).exit, "failed");
  assert.equal(restarts(rows).length, 0);
});

test("adopt path: an exited container whose agent already reported success is not restarted and is journaled clean", async () => {
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
  // The old daemon recorded the result before it died: the adopt path reads it from the agent record's journal.
  await t.daemon.deps.journal.append({
    agent: a.id,
    generation: a.generation,
    host: "h1",
    payload: { kind: "ext.pomtreed.result", status: "succeeded", result: { summary: "ok", value: "done" }, wrapupDeadlineAt: Date.now() + 60_000 },
    idempotencyKey: "res-key",
  } as never);
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  t.fakes.hooks.raw.sandbox.exit(sb.id, 143);
  await until(async () => (await get(t, a.id)).state !== "running");
  const { sandbox, rows } = await exited(t, a.id);
  assert.equal(restarts(rows).length, 0);
  assert.equal((await get(t, a.id)).generation, a.generation);
  assert.equal(sandbox?.expected, true);
  assert.equal(sandbox?.exitCode, 0);
});
