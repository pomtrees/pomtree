// Shared helpers of the cli-relay*.test.ts files (a .test.ts file cannot be imported). The relays are split over several files so
// node --test runs them in parallel.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POMTREED_KINDS } from "@pomtree/core";
import { describeCall, type ModelScript, type ScriptRule } from "@pomtree/testing";
import { freePort } from "./cli-crash.ts";
import { type AgentJson, agentErrorDump, bash, cliScenarioSkip, MODEL, PROVIDER, type Stack, startStack } from "./cli-scenarios-harness.ts";

export const SKIP = cliScenarioSkip();
// Measured on the demo image: about 4 s per level (k=1 9 s, k=3 17 s, the 5-level control 20 s). The bound is kept generous for a cold
// image or a loaded host: 120 s of slack plus 60 s per level (420 s for 5 levels).
export const timeoutFor = (levels: number) => 120_000 + 60_000 * levels;
export const MODEL_FLAG = `${PROVIDER}/${MODEL}`;
export const BIG = { input: 100, output: 10 };
export const RESERVE = 80_000; // the per-level reserve
export const TOP_BUDGET = 1_000_000;
export const POEM = [
  "I feel steady,",
  "a small lamp in a long hall,",
  "passing light along.",
  "",
  "Nothing here is lost;",
  "each hand that held me",
  "gave me back whole.",
].join("\n");
export const REFUSAL = "spawn depth 5 exceeds the limit of 4";

// The relay task for one level. Plain prose (no quotes or shell metacharacters) so it travels through `pomtree spawn --task '...'` intact.
export const task = (leaf: number, level: number) =>
  `POEM RELAY. Leaf level: ${leaf}. Your level: ${level}. If your level is below the leaf level: run pomtree budget, then spawn exactly one child ` +
  "with pomtree spawn using a budget of your remaining budget minus 80000, wait until the child has exited, run pomtree reap on it, and take the poem " +
  "from the child handoff without changing it. If your level is the leaf level: write a poem of at most eight lines about how you feel right now. " +
  "If your level is 1: publish the poem as a minimal static HTML page named poem and ask the operator to release you. Finally run pomtree result with the poem unchanged.";

export const NODE_PARSE_BUDGET = `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).remainingMicros))`;
// After the child exited and was reaped: the child's summary becomes this level's poem, its exit decides this level's status.
export const NODE_FROM_REAP = `const fs=require("fs");const r=JSON.parse(fs.readFileSync("/tmp/reap.json","utf8")).record;fs.writeFileSync("/tmp/poem.txt",r.result&&typeof r.result.summary==="string"?r.result.summary:"");fs.writeFileSync("/tmp/status",r.exit==="succeeded"?"succeeded":"failed")`;
// After a refused spawn: the refusal message is this level's summary and the level fails.
export const NODE_FROM_REFUSAL = `const fs=require("fs");const e=fs.readFileSync("/tmp/spawn.err","utf8");const m=/spawn depth \\d+ exceeds the limit of \\d+/.exec(e);fs.writeFileSync("/tmp/poem.txt",m?m[0]:e.trim());fs.writeFileSync("/tmp/status","failed")`;
export const NODE_PAGE = `const fs=require("fs");fs.writeFileSync("/tmp/poem.html","<!doctype html><html><head><meta charset=utf-8><title>poem</title></head><body><pre>"+fs.readFileSync("/tmp/poem.txt","utf8")+"</pre></body></html>")`;

export const pageFor = (text: string) => `<!doctype html><html><head><meta charset=utf-8><title>poem</title></head><body><pre>${text}</pre></body></html>`;

// The scripted model for a relay with `leaf` as the leaf level: rules keyed on the level text in the task plus the tool-result count.
export function relayScript(leaf: number): ModelScript {
  const rules: ScriptRule[] = [];
  const turn = (id: string, level: number, toolResults: number, reply: ScriptRule["reply"]) =>
    rules.push({ id, when: { lastUserIncludes: `Leaf level: ${leaf}. Your level: ${level}.`, toolResults }, reply });
  const calls = (...cmds: string[]) => ({ kind: "tool_calls" as const, calls: cmds.map((c) => bash(c)), usage: BIG });
  const text = (t: string) => ({ kind: "text" as const, text: t, usage: BIG });
  const finish = 'pomtree result --status "$(cat /tmp/status)" --summary-file /tmp/poem.txt; rc=$?; touch /tmp/finished; echo result-exit=$rc';

  for (let level = 1; level < leaf; level++) {
    turn(
      `l${level}-spawn`,
      level,
      0,
      calls(
        `REM=$(pomtree --json budget | node -e '${NODE_PARSE_BUDGET}'); CB=$((REM-${RESERVE})); echo BUDGET=$REM,$CB; ` +
          `pomtree spawn --task '${task(leaf, level + 1)}' --name relay-${level + 1} --budget $CB --model ${MODEL_FLAG} > /tmp/kid 2> /tmp/spawn.err; echo $? > /tmp/spawn.rc; ` +
          "echo SPAWN-EXIT=$(cat /tmp/spawn.rc); echo KID=$(cat /tmp/kid); echo SPAWN-ERR=$(cat /tmp/spawn.err)",
      ),
    );
    turn(
      `l${level}-wait-reap`,
      level,
      1,
      calls(
        'if [ "$(cat /tmp/spawn.rc)" = 0 ]; then KID=$(cat /tmp/kid); ' +
          "for i in $(seq 1 24); do pomtree wait $KID --timeout 15000 && break; done; " +
          "pomtree --json reap $KID > /tmp/reap.json; echo REAP=$(cat /tmp/reap.json); " +
          `node -e '${NODE_FROM_REAP}'; else node -e '${NODE_FROM_REFUSAL}'; fi; echo POEM-LEN=$(wc -c < /tmp/poem.txt)`,
      ),
    );
    if (level === 1) {
      turn(
        "l1-publish-ask",
        1,
        2,
        calls(
          `node -e '${NODE_PAGE}'; pomtree report publish /tmp/poem.html --name poem --media-type text/html; echo publish-exit=$?; ` +
            'pomtree ask "poem published; reply OK to finish" --wait 600000; echo ask-exit=$?',
        ),
      );
      turn("l1-result", 1, 3, calls(finish));
      turn("l1-done", 1, 4, text("STUB-LEVEL-1-DONE"));
    } else {
      turn(`l${level}-result`, level, 2, calls(finish));
      turn(`l${level}-done`, level, 3, text(`STUB-LEVEL-${level}-DONE`));
    }
  }
  turn("leaf-result", leaf, 0, calls(`printf '%s' '${POEM}' > /tmp/poem.txt; pomtree result --summary-file /tmp/poem.txt; echo result-exit=$?`));
  turn("leaf-done", leaf, 1, text(`STUB-LEVEL-${leaf}-DONE`));
  // After its final reply an agent can still receive pomtreed's late signals ("[pomtree] Child agent ... exited", the answer to its ask), each
  // of which starts another model turn whose last user text is no longer the task. Those turns get a closing text reply; a turn that is not
  // one of these injected messages still falls through to unmatched, which the tests assert is empty.
  // Level 1 is the exception: a signal can land as the last user turn right after its ask returns, so the task text is gone and `l1-result`
  // cannot match; that turn must still run the result, or the top never finishes. Level 2+ shares this request shape (tool-result count 3) only
  // after its result, so the same reply is guarded by /tmp/finished and is a no-op there.
  rules.push({
    id: "late-signal-result",
    when: { lastUserIncludes: "[pomtree]", toolResults: 3 },
    reply: calls(`[ -e /tmp/finished ] || { ${finish}; }`),
  });
  for (const done of new Set([1, 4])) {
    rules.push({ id: `late-signal-${done}`, when: { lastUserIncludes: "[pomtree]", toolResults: done }, reply: text("STUB-LATE-SIGNAL") });
  }
  return { name: `relay-${leaf}`, rules };
}

// Every agent's in-container command output (trimmed), so a failing relay shows what `pomtree` printed inside the container.
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

// Copies of the cli-scenarios.test.ts helpers (not importable from a .test.ts file).
export async function withStack(o: Parameters<typeof startStack>[0], fn: (s: Stack) => Promise<void>): Promise<void> {
  const s = await startStack({ ...o, set: { "model.proxy.port": String(await freePort()), ...o.set } });
  try {
    await fn(s);
  } catch (e) {
    // The daemon's own account and the model's view of the run are the first things a failing relay needs.
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

export async function spawnTop(s: Stack, leaf: number): Promise<AgentJson> {
  const r = await s.pomtree([
    "spawn",
    "--task",
    task(leaf, 1),
    "--name",
    "relay-1",
    "--budget",
    String(TOP_BUDGET),
    "--model",
    MODEL_FLAG,
    "--template",
    "relay-top",
  ]);
  assert.equal(r.code, 0, `spawn of the top agent: expected exit 0, got ${r.code}: ${r.err} stdout: ${r.out}`);
  return r.json<AgentJson>();
}

export const showAgent = async (s: Stack, id: string): Promise<AgentJson> => {
  const r = await s.pomtree(["show", id]);
  assert.equal(r.code, 0, `show ${id}: expected exit 0, got ${r.code}: ${r.err}`);
  return r.json<{ agent: AgentJson }>().agent;
};

export interface LevelFacts {
  id: string;
  level: number;
  lines: string[];
  resultSeq: number;
  reapSeq?: number;
}

// Observation of one agent through its journal: every line its bash tool calls printed, and where the reap line and the result sit.
export async function levelFacts(s: Stack, id: string, level: number): Promise<LevelFacts> {
  const outs = (await s.kinds(id, "tool_result")).map((e) => ({ seq: e.seq, output: String((e.payload as unknown as { output: string }).output) }));
  const reap = outs.find((o) => o.output.split("\n").some((l) => l.startsWith("REAP=")));
  const results = await s.kinds(id, POMTREED_KINDS.result);
  assert.equal(results.length, 1, `level ${level} (${id}): expected exactly one recorded result, got ${results.length}`);
  return { id, level, lines: outs.flatMap((o) => o.output.split("\n")), resultSeq: results[0]!.seq, reapSeq: reap?.seq };
}

export const lineValue = (f: LevelFacts, key: string): string | undefined => f.lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

// Runs one relay to the end: spawns the top, releases it only after fetching its report, and returns the facts per level.
export async function runRelay(s: Stack, leaf: number): Promise<{ top: AgentJson; levels: LevelFacts[]; fetched: string; topStateAtFetch: string }> {
  const levelsBudgetMs = timeoutFor(leaf) - 20_000;
  const top = await spawnTop(s, leaf);
  let escalation = "";
  await s.until(
    "the top agent's release ask",
    async () => {
      const r = await s.pomtree(["escalations", "ls", "--agent", top.id]);
      assert.equal(r.code, 0, `escalations ls: expected exit 0, got ${r.code}: ${r.err}`);
      const open = r.json<{ id: string; question: string; state: string }[]>().find((e) => e.state === "open" && e.question.includes("poem published"));
      escalation = open?.id ?? "";
      return escalation !== "";
    },
    levelsBudgetMs,
  );

  // The report must be retrievable before the top agent finishes; the top agent is parked on its ask.
  const topStateAtFetch = (await showAgent(s, top.id)).state;
  const list = await s.pomtree(["report", "list", top.id]);
  assert.equal(list.code, 0, `report list ${top.id}: expected exit 0, got ${list.code}: ${list.err}`);
  const reports = list.json<{ id: string; name: string; mediaType: string }[]>();
  assert.equal(reports.length, 1, `expected exactly one report from the top agent, got ${JSON.stringify(reports)}`);
  assert.equal(reports[0]!.name, "poem", `report name: expected poem, got ${reports[0]!.name}`);
  assert.equal(reports[0]!.mediaType, "text/html", `report media type: expected text/html, got ${reports[0]!.mediaType}`);
  const outDir = mkdtempSync(join(tmpdir(), "relay-"));
  let fetched: string;
  try {
    const shown = await s.pomtree(["report", "show", top.id, reports[0]!.id, "--out", join(outDir, "poem.html")]);
    assert.equal(shown.code, 0, `report show --out: expected exit 0, got ${shown.code}: ${shown.err}`);
    fetched = readFileSync(join(outDir, "poem.html"), "utf8");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  const ans = await s.pomtree(["answer", escalation, "OK"]);
  assert.equal(ans.code, 0, `answer ${escalation}: expected exit 0, got ${ans.code}: ${ans.err}`);
  const w = await s.waitExited(top.id, levelsBudgetMs);
  assert.equal(w.code, 0, `wait on the top agent: expected exit 0, got ${w.code}: ${w.out} ${w.err}`);

  // Walk the chain top-down through the KID= lines each parent printed.
  const levels: LevelFacts[] = [];
  let id: string | undefined = top.id;
  for (let level = 1; id; level++) {
    const f = await levelFacts(s, id, level);
    levels.push(f);
    id = lineValue(f, "SPAWN-EXIT") === "0" ? lineValue(f, "KID") : undefined;
  }
  return { top: await showAgent(s, top.id), levels, fetched, topStateAtFetch };
}

export const summaryOf = (a: AgentJson) => (a.result as { summary?: unknown } | null)?.summary;

// The top agent runs from a template that grants registry egress (a template without egress denies all); its children are spawned
// without a template, as in cli scenario 6.
export function relayTemplates() {
  return { "relay-top": { provider: PROVIDER, model: MODEL, systemPrompt: "Scripted relay agent. [[stub:relay]]", egress: { kind: "registry" } } };
}

// Room for a five-agent chain (the default session cap is auto), and waits that never yield: a yield would resume the agent with a wake
// message and change the next request's shape (docs/demo.md, "Wait yields"). `pomtree ask --wait 600000` and the 15 s waits stay below it.
export function relaySettings(): Record<string, string> {
  return { "capacity.maxSessions": "6", "wait.yieldMs": "700000" };
}
