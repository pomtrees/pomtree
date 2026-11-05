// Shared pieces of the cli-lifecycle*.test.ts files (REC-8, YLD-3, YLD-5, BUD-8, CUS-4, GIT-3, SAF-6, OPS-2): the
// real pomtreed, real agent containers and FakeModelUpstream, driven through the real `pomtree` binary. Not a test file: the lifecycle tests are
// split over several files so node --test runs them in parallel (each builds its own stack: no shared ports, names or state).
// Late-signal rule (cli-operator.test.ts): after its final reply an agent can still receive pomtreed's injected `[pomtree] ...` turns, so
// every script keys its closing text reply on the tool-result count or on a unique wake text, never on the task text alone.
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { describeCall, type ModelScript, type ScriptRule } from "@pomtree/testing";
import { agentContainers, freePort, showAgent } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
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
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export async function spawnAgent(s: Stack, o: { task: string; name: string; budget: number; template?: string; deadline?: string }): Promise<AgentJson> {
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
    ...(o.deadline ? ["--deadline", o.deadline] : []),
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
const toolOutputs = async (s: Stack, id: string) => (await s.kinds(id, "tool_result")).map((e) => String((e.payload as unknown as { output: string }).output));
export const toolLines = async (s: Stack, id: string) => (await toolOutputs(s, id)).flatMap((o) => o.split("\n"));
export const lineValue = (lines: string[], key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
export const runningContainers = async (id: string) => (await agentContainers(id)).filter((c) => c.running).map((c) => c.name);

// ---- YLD-3 ----

// Strings in a checkpoint that look like a host path: it is meant to hold ids and hashes only (Checkpoint in packages/core/src/types.ts).
export function hostPathFindings(v: unknown, root: string, path = "checkpoint", out: string[] = []): string[] {
  if (typeof v === "string") {
    if (v.startsWith(root) || v.includes("/home/") || v.includes("/tmp/")) out.push(`${path}=${v}`);
  } else if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) hostPathFindings(x, root, `${path}[${i}]`, out);
  } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) hostPathFindings(x, root, `${path}.${k}`, out);
  return out;
}

interface Parked {
  id: string;
  containerBefore: string;
  gen: number;
  checkpoint: { wait: { kind: string; [k: string]: unknown } | null; [k: string]: unknown };
}

// Follow one agent from its first container to the park: the container name while it is running (scripts sleep a few seconds first so
// it is observable), then the yielded state with its checkpoint section from `pomtree --json show`.
export async function untilParked(s: Stack, id: string): Promise<Parked> {
  let containerBefore = "";
  await s.until(
    `${id} running in a container`,
    async () => {
      containerBefore = (await runningContainers(id))[0] ?? "";
      return containerBefore !== "";
    },
    120_000,
  );
  await release([containerBefore]); // the scripted call held the container up so it could be observed; now let it park
  let shown: { agent: AgentJson; checkpoint: Parked["checkpoint"] | null } | undefined;
  await s.until(
    `${id} yielded`,
    async () => {
      const r = await s.pomtree(["show", id]);
      if (r.code !== 0) return false;
      shown = r.json<{ agent: AgentJson; checkpoint: Parked["checkpoint"] | null }>();
      return shown.agent.state === "yielded" && shown.checkpoint !== null;
    },
    120_000,
  );
  return { id, containerBefore, gen: shown!.agent.generation, checkpoint: shown!.checkpoint! };
}

// The wake: exactly one stub request carries `ruleId`, exactly one `resumed` entry, generation + 1, a container that is not the first one.
export async function assertWokeOnce(s: Stack, p: Parked, ruleId: string, textRe: RegExp, t: { diagnostic(m: string): void }, label: string): Promise<void> {
  await s.until(`${label} woken`, async () => s.stub.calls.some((c) => c.matched === ruleId), 120_000);
  let now: AgentJson | undefined;
  await s.until(
    `${label} running again`,
    async () => {
      now = await showAgent(s, p.id);
      return now.state === "running" && now.generation === p.gen + 1 && (await runningContainers(p.id)).length === 1;
    },
    60_000,
  );
  await sleep(4000); // room for a second (wrong) wake to show up
  const wakes = s.stub.calls.filter((c) => c.matched === ruleId);
  t.diagnostic(`${label}: wake text ${JSON.stringify(wakes[0]?.lastUserText?.slice(0, 220))}`);
  assert.equal(wakes.length, 1, `${label}: exactly one wake request, got ${wakes.length}`);
  assert.match(wakes[0]!.lastUserText ?? "", textRe, `${label}: wake text`);
  assert.equal((await s.kinds(p.id, "resumed")).length, 1, `${label}: exactly one resumed entry`);
  assert.equal((await s.kinds(p.id, "yielded")).length, 1, `${label}: exactly one yielded entry`);
  const after = await runningContainers(p.id);
  t.diagnostic(`${label}: container ${p.containerBefore} -> ${after[0]}, generation ${p.gen} -> ${now!.generation}`);
  assert.notEqual(after[0], p.containerBefore, `${label}: the resume must run in a new container`);
  assert.equal((await agentContainers(p.id)).filter((c) => c.name === p.containerBefore).length, 0, `${label}: the first container must be gone`);
  assert.equal(now!.generation, p.gen + 1, `${label}: generation + 1`);
  const leaks = hostPathFindings(p.checkpoint, dirname(s.stateDir));
  assert.deepEqual(leaks, [], `${label}: the checkpoint must show ids and hashes, no host path`);
}

export const noStray = (s: Stack) => {
  assert.equal(s.stub.calls.filter((c) => c.matched === "stray").length, 0, "no request fell through to the catch-all rule");
  assert.deepEqual(s.stub.unmatched, []);
};

// Child-exit waits. The parent spawns two children that park on `--until message`, then yields on the children; the operator lets exactly
// one (any) or both (all) finish. Children are named so the operator finds their ids from `pomtree ps --parent`.
export async function childIds(s: Stack, parent: string, names: string[], ms = 120_000): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  await s.until(
    `children ${names} of ${parent}`,
    async () => {
      const ps = (await s.pomtree(["ps", "--parent", parent])).json<AgentJson[]>();
      for (const n of names) {
        const a = ps.find((x) => x.name === n);
        if (a) ids[n] = a.id;
      }
      return names.every((n) => ids[n] !== undefined);
    },
    ms,
  );
  return ids;
}

export const kidRules = (tag: string, n: number): ScriptRule[] => [
  { id: `${tag}${n}-result`, when: { lastUserIncludes: `GO-${tag}${n}` }, times: 1, reply: callReply(`pomtree result --summary KIDDONE-${tag}${n}`) },
  { id: `${tag}${n}-end`, when: { lastUserIncludes: `GO-${tag}${n}` }, reply: textReply("STUB-KID-DONE") },
  { id: `${tag}${n}-park`, when: { lastUserIncludes: `[[scn:${tag}kid${n}]]`, toolResults: 0 }, times: 1, reply: callReply("pomtree yield --until message") },
  { id: `${tag}${n}-parked`, when: { lastUserIncludes: `[[scn:${tag}kid${n}]]`, toolResults: 1 }, reply: textReply("parked") },
];
export const spawnKid = (tag: string, n: number) =>
  `K${n}=$(pomtree spawn --task '[[scn:${tag}kid${n}]] park' --name ${tag}${n} --budget 150000 --model ${MODEL_FLAG})`;

export async function childWaitCase(
  tag: "any" | "all",
  until: (a: string, b: string) => string,
  run: (s: Stack, ids: { a: string; b: string }, parent: Parked, t: { diagnostic(m: string): void }) => Promise<void>,
  t: { diagnostic(m: string): void },
): Promise<void> {
  const script: ModelScript = {
    name: `yld3-${tag}`,
    rules: [
      { id: "parent-woken", when: { marker: "parent", lastUserIncludes: "KIDDONE-" }, times: 1, reply: callReply("sleep 300; echo parent-woke") },
      {
        id: "parent-spawn",
        when: { marker: "parent", lastUserIncludes: `[[scn:${tag}parent]]`, toolResults: 0 },
        reply: callReply(`${spawnKid(tag, 1)}; ${spawnKid(tag, 2)}; echo kids=$K1,$K2; ${holdUntilReleased(`pomtree yield --until ${until("$K1", "$K2")}`)}`),
      },
      ...kidRules(tag, 1),
      ...kidRules(tag, 2),
      { id: "stray", when: {}, reply: textReply("stray") },
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { "capacity.maxSessions": "6" } }, async (s) => {
    const p = await spawnAgent(s, { task: `[[scn:${tag}parent]] wait for kids`, name: `${tag}parent`, budget: 1_000_000, template: "scn-parent" });
    const parked = await untilParked(s, p.id);
    const kids = await childIds(s, p.id, [`${tag}1`, `${tag}2`]);
    await run(s, { a: kids[`${tag}1`]!, b: kids[`${tag}2`]! }, parked, t);
    noStray(s);
  });
}
