// Shared helpers of the cli-scenarios*.test.ts files (a .test.ts file cannot be imported): one stack per test, spawn/wait/reap over the
// real `pomtree` binary. The scenarios are split over several files so node --test runs them in parallel.
import assert from "node:assert/strict";
import { describeCall, type ModelScript } from "@pomtree/testing";
import { freePort } from "./cli-crash.ts";
import { type AgentJson, agentErrorDump, cliScenarioSkip, MODEL, PROVIDER, type Stack, startStack, type Template } from "./cli-scenarios-harness.ts";

export const SKIP = cliScenarioSkip();
export const TIMEOUT = 170_000; // one scenario fits the 3-minute bound on a single command
export const MODEL_FLAG = `${PROVIDER}/${MODEL}`;
export const BIG = { input: 100, output: 10 };

export async function withStack(o: { script: ModelScript; templates?: Record<string, Template> }, fn: (s: Stack) => Promise<void>): Promise<void> {
  // The registry default model-proxy port (18080) would collide between the concurrently running scenario files.
  const s = await startStack({ ...o, set: { "model.proxy.port": String(await freePort()) } });
  try {
    await fn(s);
  } catch (e) {
    // The daemon's own account and the model's view of the run are the first things a failing scenario needs.
    const calls = s.stub.calls.map(describeCall);
    const errors = await agentErrorDump(s);
    throw new Error(
      `${(e as Error).message}\n--- agent errors\n${errors}\n--- fake model calls\n${calls.join("\n")}\n--- pomtreed log tail\n${s.pomtreedLog().slice(-4000)}`,
      { cause: e },
    );
  } finally {
    await s.close();
  }
}

export async function spawnAgent(s: Stack, o: { task: string; name: string; budget: number; template?: string; wrapup?: string }): Promise<AgentJson> {
  const r = await s.pomtree([
    "spawn",
    "--task",
    o.task,
    "--name",
    o.name,
    "--budget",
    String(o.budget),
    "--model",
    MODEL_FLAG,
    ...(o.template ? ["--template", o.template] : []),
    ...(o.wrapup ? ["--wrapup", o.wrapup] : []),
  ]);
  assert.equal(r.code, 0, `spawn: exit ${r.code}: ${r.err} stdout: ${r.out}`);
  const a = r.json<AgentJson>();
  assert.match(a.id, /\S/);
  assert.equal(a.name, o.name);
  assert.equal(a.budgetMicros, o.budget);
  assert.ok(["pending", "running"].includes(a.state), a.state);
  return a;
}

export async function waitDone(s: Stack, id: string, ms = 120_000): Promise<AgentJson> {
  const w = await s.waitExited(id, ms);
  assert.equal(w.code, 0, `wait ${id}: exit ${w.code} ${w.out} ${w.err}`);
  const body = w.json<{ done: boolean; record: AgentJson }>();
  assert.equal(body.done, true);
  // Root's children are reaped as they exit (Lifecycle.finishTail), so a later wait can already see "reaped".
  assert.ok(["exited", "reaped"].includes(body.record.state), body.record.state);
  return body.record;
}

export async function reap(s: Stack, id: string): Promise<{ record: AgentJson; unusedMicros: number }> {
  const r = await s.pomtree(["reap", id]);
  assert.equal(r.code, 0, `reap ${id}: ${r.err}`);
  const body = r.json<{ record: AgentJson; unusedMicros: number }>();
  assert.equal(body.record.state, "reaped");
  return body;
}

export const sum = (xs: { micros: number }[]) => xs.reduce((n, x) => n + x.micros, 0);
export const toolOutputs = async (s: Stack, id: string) =>
  (await s.kinds(id, "tool_result")).map((e) => e.payload as unknown as { ok: boolean; output: string });
