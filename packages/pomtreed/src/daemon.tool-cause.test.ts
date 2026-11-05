import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, ExecutorReapReceipt } from "@pomtree/core";
import { FakeDeterministicExecutor } from "@pomtree/testing";
import { exitedDetail, lastToolFailureCause, SANDBOX_LIFECYCLE_KIND, toolFailureCauseOf } from "./daemon-util.ts";
import { setup, until } from "./test-setup.ts";

const CAPTURE_ERROR = "trusted browser capture failed; no receipt issued (cause=bound net=ERR_FAILED)";
const row = (ok: boolean, output: string) => ({ payload: { kind: "tool_result", ok, output } });

test("toolFailureCauseOf reads only a trailing closed (cause=token [net=ERR_X]) suffix", () => {
  assert.equal(toolFailureCauseOf(CAPTURE_ERROR), "bound");
  assert.equal(toolFailureCauseOf("capture failed (cause=non_html)"), "non_html");
  assert.equal(toolFailureCauseOf("capture failed (cause=deadline)\n"), "deadline");
  // negatives: absent, mid-text, uppercase, over-long, injected net name, non-string
  assert.equal(toolFailureCauseOf("capture failed"), null);
  assert.equal(toolFailureCauseOf("(cause=bound) and then more text"), null);
  assert.equal(toolFailureCauseOf("x (cause=BOUND)"), null);
  assert.equal(toolFailureCauseOf(`x (cause=${"a".repeat(33)})`), null);
  assert.equal(toolFailureCauseOf("x (cause=bound net=https://evil.example/?q=1)"), null);
  assert.equal(toolFailureCauseOf(undefined), null);
  assert.equal(toolFailureCauseOf(null), null);
});

test("lastToolFailureCause takes the last FAILED tool result with a cause; a successful result carrying the text is ignored", () => {
  assert.equal(lastToolFailureCause([row(false, "x (cause=deadline)"), row(false, CAPTURE_ERROR)]), "bound");
  assert.equal(lastToolFailureCause([row(false, "x (cause=deadline)"), row(false, "plain failure")]), "deadline");
  assert.equal(lastToolFailureCause([row(true, CAPTURE_ERROR)]), null);
  assert.equal(lastToolFailureCause([{ payload: { kind: "message" } }, row(false, "no cause")]), null);
  assert.equal(lastToolFailureCause([]), null);
});

test("exitedDetail names the signal behind 129/130/137/143, and no signal for other codes", () => {
  assert.deepEqual(exitedDetail({ exitCode: 143 }, false), { exitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(exitedDetail({ exitCode: 137, oomKilled: true }, false), { exitCode: 137, oomKilled: true, signal: "SIGKILL" });
  assert.deepEqual(exitedDetail({ exitCode: 130 }, false), { exitCode: 130, signal: "SIGINT" });
  assert.deepEqual(exitedDetail({ exitCode: 143 }, true), { exitCode: 0, expected: true, observedExitCode: 143, signal: "SIGTERM" });
  assert.deepEqual(exitedDetail({ exitCode: 1 }, false), { exitCode: 1 });
  assert.deepEqual(exitedDetail({ exitCode: 124 }, false), { exitCode: 124 });
});

const errors = async (t: ReturnType<typeof setup>, id: string) =>
  (await t.journal.read({ agent: id })).filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);

test("an agent that ends after a failed capture tool names that cause instead of saying it was silent", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "tool_call", callId: "k1", tool: "browser_capture", input: "{}" });
    c.emit({ kind: "tool_result", callId: "k1", ok: false, output: CAPTURE_ERROR });
    c.emit({ kind: "message", role: "assistant", text: "could not capture" });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(a.id)) as AgentRecord).exit, "failed");
  const msgs = await errors(t, a.id);
  assert.ok(
    msgs.some((m) => m.startsWith("agent ended after a failed tool call (cause=bound)")),
    msgs.join("|"),
  );
  assert.ok(!msgs.some((m) => m.includes("without reporting a result")), "no misleading silent-exit line");
});

test("a recorded failed result after a failed tool call journals no 'without a result' error", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "tool_call", callId: "k1", tool: "browser_capture", input: "{}" });
    c.emit({ kind: "tool_result", callId: "k1", ok: false, output: CAPTURE_ERROR });
    await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "could not capture", value: "x" } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(a.id)) as AgentRecord).exit, "failed");
  const msgs = await errors(t, a.id);
  assert.ok(!msgs.some((m) => m.includes("without a result") || m.includes("without reporting a result")), msgs.join("|"));
});

test("a failed tool without a closed cause keeps the silent-exit line", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "tool_call", callId: "k1", tool: "bash", input: "{}" });
    c.emit({ kind: "tool_result", callId: "k1", ok: false, output: "boom" });
    c.emit({ kind: "message", role: "assistant", text: "bye" });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.ok((await errors(t, a.id)).some((m) => m.startsWith("agent ended without reporting a result")));
});

test("the reap receipt of a container child carries toolFailureCause, and omits it when no tool failed that way", async () => {
  const exec = new FakeDeterministicExecutor("cause-parent");
  const seen: Record<string, ExecutorReapReceipt> = {};
  const exits: Record<string, string | null> = {};
  let t!: ReturnType<typeof setup>;
  t = setup(
    async (c) => {
      if (((await t.daemon.get(c.agent)) as AgentRecord).name === "bad") {
        c.emit({ kind: "tool_call", callId: "k1", tool: "browser_capture", input: "{}" });
        c.emit({ kind: "tool_result", callId: "k1", ok: false, output: CAPTURE_ERROR });
      }
      // Reports success after the failed tool, as the browser worker's model did in a real run.
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "capture failed", value: "x" } });
    },
    { deterministicExecutors: new Map([["cause-parent", exec]]) },
  );
  exec.setHandler(async (ctx) => {
    for (const name of ["bad", "good"]) {
      const id = await ctx.ops.spawn({ name, task: "t", budgetMicros: 100, idempotencyKey: name });
      await until(async () => ((await t.daemon.get(id)) as AgentRecord).state === "exited", 5000);
      seen[name] = await ctx.ops.reap(id, `reap-${name}`);
      exits[name] = seen[name]!.exit;
    }
    await ctx.ops.submitResult({ summary: "done" }, "res");
  });
  const root = await t.daemon.root();
  await t.daemon.startDeterministic(root.id, {
    name: "det",
    task: "t",
    idempotencyKey: "cause-1",
    executor: "deterministic",
    spec: { driver: "cause-parent", input: null },
    budgetMicros: 500,
  });
  await until(() => Object.keys(seen).length === 2, 8000);
  assert.equal(seen.bad!.toolFailureCause, "bound");
  assert.equal(exits.bad, "succeeded", "the receipt reports the status the child itself submitted");
  assert.equal("toolFailureCause" in seen.good!, false);
});

test("the exited sandbox entry says stop=cancelled for a daemon cancel, and carries no stop for a plain exit", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await t.spawn("c1");
  await until(async () => ((await t.daemon.get(a.id)) as AgentRecord).state === "running");
  await t.daemon.cancel(a.id, 5);
  await t.orchestrator.idle();
  const stopOf = async (id: string) =>
    (
      (await t.journal.read({ agent: id })).find((e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { phase?: string }).phase === "exited")
        ?.payload as { stop?: string } | undefined
    )?.stop;
  assert.equal(await stopOf(a.id), "cancelled");
  const t2 = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const b = await t2.spawn("c2");
  await t2.orchestrator.idle();
  const exited = (await t2.journal.read({ agent: b.id })).find(
    (e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { phase?: string }).phase === "exited",
  );
  assert.ok(exited && !("stop" in exited.payload), "no stop on a self-completed run");
});
