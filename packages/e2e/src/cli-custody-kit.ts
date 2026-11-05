// Shared helpers of the cli-custody*.test.ts files (a .test.ts file cannot be imported). The CUS scenarios are split over several files so
// node --test runs them in parallel.
import assert from "node:assert/strict";
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

// The journal entry Lifecycle.stop writes on a live child when its parent's exit path cancels it (signal kind "cancel"), independent of
// how the child then ends.
export const cancelSignals = async (s: Stack, id: string) =>
  (await s.kinds(id, "signal")).filter((e) => (e.payload as unknown as { signal: { kind: string } }).signal?.kind === "cancel");

export const summaryOf = (a: AgentJson) => (a.result as { summary?: unknown } | null)?.summary;
export const toolOutputs = async (s: Stack, id: string) =>
  (await s.kinds(id, "tool_result")).map((e) => String((e.payload as unknown as { output: string }).output));
// Every line the agent's bash tool calls printed, for `KEY=value` observations.
export const toolLines = async (s: Stack, id: string) => (await toolOutputs(s, id)).flatMap((o) => o.split("\n"));
export const lineValue = (lines: string[], key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

// ---- shared pieces for CUS-6, CUS-1, CUS-9, CUS-10 and CUS-11 ----
// Every scripted agent runs ONE bash command per model turn (Pi runs the calls of one reply in parallel, and a signal injected between two
// tool calls would change the next request's shape); waits stay below wait.yieldMs (set high), so no agent yields and resumes.
export const SETTINGS = { "wait.yieldMs": "700000", "capacity.maxSessions": "6" };
export const RD = `const s=JSON.parse(require("fs").readFileSync(0,"utf8"));`; // JSON on stdin, for `node -e '...'` in the container (no single quotes inside)
export const nodeOf = (js: string) => `node -e '${RD}${js}'`;
export const waitView = (id: string) =>
  `pomtree --json wait ${id} --timeout 5000 | ${nodeOf(`console.log(s.record.state+"/"+s.record.exit+"/"+(s.record.result&&s.record.result.summary))`)}`;
export const reapView = (id: string) => `pomtree --json reap ${id} | ${nodeOf(`console.log(s.record.state+"/"+s.unusedMicros)`)}`;
export const spawnKidCmd = (tag: string, budget = 100_000) =>
  `pomtree spawn --task '[[scn:${tag}]] go' --name ${tag} --budget ${budget} --model ${MODEL_FLAG} > /tmp/${tag}; echo ${tag}=$(cat /tmp/${tag})`;
export const waitAllCmd = (...tags: string[]) =>
  `for T in ${tags.join(" ")}; do for i in $(seq 1 24); do pomtree wait $(cat /tmp/$T) --timeout 5000 > /dev/null && break; done; done`;
export const lateSignal: ScriptRule = { id: "late-signal", when: { lastUserIncludes: "[pomtree]" }, reply: textReply("STUB-LATE-SIGNAL") };
export const doneRule = (id: string): ScriptRule => ({ id, when: { toolResults: 1 }, reply: textReply("STUB-DONE") });
export const kidRule = (tag: string, summary: string): ScriptRule => ({
  id: `${tag}-result`,
  when: { lastUserIncludes: `[[scn:${tag}]]`, toolResults: 0 },
  reply: callReply(`pomtree result --summary '${summary}'`),
});

export const idsFromPs = async (s: Stack, parent: string): Promise<Record<string, AgentJson>> =>
  Object.fromEntries(
    (await s.pomtree(["ps"]))
      .json<AgentJson[]>()
      .filter((a) => a.parent === parent)
      .map((a) => [a.name, a]),
  );

export const answerAsk = async (s: Stack, agent: string, question: string, text: string) => {
  let id = "";
  await s.until(
    `the ask "${question}"`,
    async () => {
      id =
        (await s.pomtree(["escalations", "ls", "--agent", agent]))
          .json<{ id: string; question: string; state: string }[]>()
          .find((e) => e.state === "open" && e.question.includes(question))?.id ?? "";
      return id !== "";
    },
    90_000,
  );
  const r = await s.pomtree(["escalations", "answer", id, text]);
  assert.equal(r.code, 0, `answer ${id}: exit ${r.code}: ${r.err}`);
};
export const signalsOn = async (s: Stack, id: string): Promise<({ seq: number } & Record<string, unknown>)[]> =>
  (await s.kinds(id, "signal")).map((e) => ({ seq: e.seq, ...(e.payload as unknown as { signal: Record<string, unknown> }).signal }));
