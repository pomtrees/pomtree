// Shared helpers of the cli-operator*.test.ts files (a .test.ts file cannot be imported). The scenarios are split over several files so
// node --test runs them in parallel.
import assert from "node:assert/strict";
import { request } from "node:http";
import { describeCall, type ScriptRule } from "@pomtree/testing";
import { freePort } from "./cli-crash.ts";
import { type AgentJson, agentErrorDump, bash, cliScenarioSkip, MODEL, PROVIDER, type Stack, startStack } from "./cli-scenarios-harness.ts";

export const SKIP = cliScenarioSkip();
export const TIMEOUT = 280_000;
export const MODEL_FLAG = `${PROVIDER}/${MODEL}`;
export const BIG = { input: 100, output: 10 };
export const TEMPLATES = {
  "scn-parent": { provider: PROVIDER, model: MODEL, systemPrompt: "Scripted test parent. [[stub:parent]]", egress: { kind: "registry" } },
}; // a template without egress denies all

export const textReply = (text: string): ScriptRule["reply"] => ({ kind: "text", text, usage: BIG });
export const callReply = (...cmds: string[]): ScriptRule["reply"] => ({ kind: "tool_calls", calls: cmds.map((c) => bash(c)), usage: BIG });
// Copy of the cli-relay.test.ts diagnostics (not importable from a .test.ts file): every agent's tool outputs, the fake model's calls and
// the pomtreed log tail on failure.
export async function toolOutputDump(s: Stack): Promise<string> {
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

export async function spawnAgent(s: Stack, o: { task: string; name: string; budget: number; template?: string }): Promise<AgentJson> {
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
export const toolOutputs = async (s: Stack, id: string) =>
  (await s.kinds(id, "tool_result")).map((e) => String((e.payload as unknown as { output: string }).output));
// Every line the agent's bash tool calls printed, for `KEY=value` observations.
export const toolLines = async (s: Stack, id: string) => (await toolOutputs(s, id)).flatMap((o) => o.split("\n"));
export const lineValue = (lines: string[], key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

// GET over the operator unix socket (the probe routes are served there only).
export function socketGet(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

export interface Esc {
  id: string;
  agent: string;
  state: string;
  question: string;
  options?: string[];
  answer?: string;
}
export const openEscalation = async (s: Stack, agent: string): Promise<Esc | undefined> => {
  const r = await s.pomtree(["escalations", "ls", "--agent", agent]);
  assert.equal(r.code, 0, `escalations ls: exit ${r.code}: ${r.err}`);
  return r.json<Esc[]>().find((e) => e.state === "open");
};

// Waits for the agent's open escalation and returns it.
export async function untilEscalation(s: Stack, agent: string): Promise<Esc> {
  let found: Esc | undefined;
  await s.until(
    "the open escalation",
    async () => {
      found = await openEscalation(s, agent);
      return found !== undefined;
    },
    120_000,
  );
  return found!;
}
