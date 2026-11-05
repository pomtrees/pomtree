// Shared pieces of the cli-recovery*.test.ts files (REC-3 to REC-7). Not a test file: the recovery tests are split
// over several files so node --test runs them in parallel (each builds its own stack: no shared ports, names or state).
import assert from "node:assert/strict";
import { describeCall, type ScriptRule } from "@pomtree/testing";
import { freePort, showAgent } from "./cli-crash.ts";
import { type AgentJson, agentErrorDump, bash, cliScenarioSkip, MODEL, PROVIDER, type Stack, startStack } from "./cli-scenarios-harness.ts";

export const SKIP = cliScenarioSkip();
export const TIMEOUT = 280_000;
export const MODEL_FLAG = `${PROVIDER}/${MODEL}`;
export const BIG = { input: 100, output: 10 };
export const sum = (xs: { micros: number }[]) => xs.reduce((n, x) => n + x.micros, 0);

// Copy of the cli-relay.test.ts diagnostics (not importable from a .test.ts file): every agent's tool outputs, the fake model's calls and
// the pomtreed log tail on failure.
async function toolOutputDump(s: Stack): Promise<string> {
  try {
    const ps = await s.pomtree(["ps"], 20_000);
    if (ps.code !== 0) return `pomtree ps exit ${ps.code}: ${ps.err}`;
    const parts: string[] = [];
    for (const a of ps.json<AgentJson[]>().filter((x) => x.parent !== null)) {
      const outs = (await s.kinds(a.id, "tool_result")).map((e) => String((e.payload as unknown as { output: string }).output).slice(0, 1500));
      parts.push(`## ${a.name} ${a.id} state=${a.state} exit=${a.exit ?? "-"}\n${outs.join("\n--\n")}`);
    }
    return parts.join("\n");
  } catch (e) {
    return `could not collect tool outputs: ${(e as Error).message}`;
  }
}

export async function withStack(o: Parameters<typeof startStack>[0], fn: (s: Stack) => Promise<void>): Promise<void> {
  const s = await startStack({ ...o, set: { "model.proxy.port": String(await freePort()), ...o.set } });
  try {
    await fn(s);
  } catch (e) {
    const calls = s.stub.calls.map(describeCall);
    const outputs = await toolOutputDump(s);
    const errors = await agentErrorDump(s);
    throw new Error(
      `${(e as Error).message}\n--- tool outputs per agent\n${outputs}\n--- agent errors\n${errors}\n--- fake model calls\n${calls.join("\n")}\n--- pomtreed log tail\n${s.pomtreedLog().slice(-4000)}`,
      { cause: e },
    );
  } finally {
    await s.close();
  }
}

export async function spawnAgent(s: Stack, o: { task: string; name: string; budget: number; template?: string; key?: string }): Promise<AgentJson> {
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
    ...(o.key ? ["--key", o.key] : []),
  ]);
  assert.equal(r.code, 0, `spawn ${o.name}: exit ${r.code}: ${r.err} stdout: ${r.out}`);
  return r.json<AgentJson>();
}

export async function waitDone(s: Stack, id: string, ms = 150_000): Promise<AgentJson> {
  const w = await s.waitExited(id, ms);
  assert.equal(w.code, 0, `wait ${id}: exit ${w.code} ${w.out} ${w.err}`);
  const body = w.json<{ done: boolean; record: AgentJson }>();
  assert.equal(body.done, true);
  assert.ok(["exited", "reaped"].includes(body.record.state), body.record.state);
  return body.record;
}

export const summaryOf = (a: AgentJson) => (a.result as { summary?: unknown } | null)?.summary;
export const textReply = (text: string): ScriptRule["reply"] => ({ kind: "text", text, usage: BIG });
export const callReply = (...cmds: string[]): ScriptRule["reply"] => ({ kind: "tool_calls", calls: cmds.map((c) => bash(c)), usage: BIG });

// Settled at least `n` model calls for the agent while it is still running with a registered sandbox: the state the SIGKILL must hit.
export async function untilSettledAndRunning(s: Stack, id: string, n: number): Promise<void> {
  await s.until(
    `${id} running with ${n} settled model call(s)`,
    async () => {
      const a = await showAgent(s, id);
      if (["exited", "reaped"].includes(a.state))
        throw new Error(`agent ${id} reached ${a.state}/${a.exit} before the kill (the script is too quick, or it failed early)`);
      return a.state === "running" && !!a.sandbox && (await s.settlements(id)).length >= n;
    },
    150_000,
  );
}

// The journal of `id` before the kill must be an unchanged prefix of the journal after the restart, with strictly increasing seq.
export function assertPrefixPreserved(before: { seq: number; payload: unknown }[], after: { seq: number; payload: unknown }[], what: string): void {
  for (let i = 1; i < after.length; i++) assert.ok(after[i]!.seq > after[i - 1]!.seq, `${what}: journal seq not strictly increasing at ${after[i]!.seq}`);
  for (const [i, e] of before.entries()) {
    assert.equal(after[i]?.seq, e.seq, `${what}: pre-kill journal entry ${i} (seq ${e.seq}) moved or vanished`);
    assert.deepEqual(after[i]?.payload, e.payload, `${what}: pre-kill journal entry seq ${e.seq} was rewritten`);
  }
}

export const sandboxCount = (kinds: string[]) => kinds.filter((k) => k === "started").length;
