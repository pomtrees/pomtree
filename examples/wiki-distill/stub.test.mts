// Offline guard for the zero-spend rehearsal of the wiki-distill pipeline: stub/wiki-distill.json plays every role on the scripted model stub, and stub/templates/*.json are the real templates with only the system prompt swapped for a stub marker.
// Nothing here starts the stub, Docker or a network connection; the scripts are exercised through the stub's own pure matcher.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  markersFrom,
  matchRule,
  type ModelScript,
  type RequestShape,
  type Reply,
  recordUse,
  validateModelScript,
} from "../../packages/testing/src/model-stub/script.ts";
import { tmpDir } from "../../packages/testing/src/tmp.ts";
import { DirTemplateStore } from "../../packages/template-dir/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "stub", "wiki-distill.json");
const IDS = ["wiki-reader", "wiki-orchestrator", "wiki-distiller"] as const;
const stubTemplate = (id: string) => join(HERE, "stub", "templates", `${id}.json`);
const realTemplate = (id: string) => join(HERE, "templates", `${id}.json`);
const TOKEN = "WIKI-SUMMARIZER-TASK";

const load = (): ModelScript => validateModelScript(JSON.parse(readFileSync(SCRIPT, "utf8")), SCRIPT);

function shape(over: Partial<RequestShape>): RequestShape {
  return {
    wire: "openai-completions",
    model: null,
    stream: true,
    turn: 0,
    toolResults: 0,
    lastTool: null,
    lastToolIsError: null,
    offeredTools: [],
    agentId: null,
    markers: [],
    lastUserText: null,
    maxTokens: null,
    ...over,
  };
}

interface Step {
  id: string;
  reply: Reply;
}

// Plays one agent against the script: a tool_calls reply advances the conversation by one tool result, a fault repeats the same request (the agent is re-prompted), a text reply ends it.
function play(script: ModelScript, base: Partial<RequestShape>): Step[] {
  const used = new Map<string, number>();
  const out: Step[] = [];
  let toolResults = 0;
  let lastTool: string | null = null;
  for (let i = 0; i < 40; i++) {
    const rule = matchRule(script, shape({ ...base, toolResults, lastTool, lastToolIsError: lastTool ? false : null }), used);
    if (!rule) {
      // After capture_finish (or a result call) the agent exits; no further request is expected.
      assert.ok(lastTool === "capture_finish", `no rule matched at toolResults=${toolResults}`);
      return out;
    }
    recordUse(used, rule);
    out.push({ id: rule.id, reply: rule.reply });
    if (rule.reply.kind === "text") return out;
    if (rule.reply.kind === "tool_calls") {
      toolResults += 1;
      lastTool = rule.reply.calls[0]?.name ?? null;
    }
  }
  assert.fail("agent never finished within 40 requests");
}

const READER = { markers: ["wiki-reader"], offeredTools: ["browser_navigate", "browser_snapshot", "capture_finish"] };
const ORCH = { markers: ["wiki-orchestrator"], offeredTools: ["bash"] };
const DIST = { markers: ["wiki-distiller"], offeredTools: ["bash"] };
const SUMM = { markers: [], offeredTools: ["bash"], lastUserText: `${TOKEN} block 2: condense` };

function calls(steps: Step[]): { name: string; args: Record<string, unknown> }[] {
  return steps.flatMap((s) =>
    s.reply.kind === "tool_calls" ? s.reply.calls.map((c) => ({ name: c.name, args: c.arguments as Record<string, unknown> })) : [],
  );
}

function bashCommands(script: ModelScript): string[] {
  return script.rules.flatMap((r) =>
    r.reply.kind === "tool_calls" ? r.reply.calls.filter((c) => c.name === "bash").map((c) => String((c.arguments as { command: string }).command)) : [],
  );
}

// Every probe request must hit only its own role's rules (or none): a marker role may match only its prefix, the unmarked summarizer only with its task token.
function crossMatches(script: ModelScript): string[] {
  const browser = [["browser_navigate", "browser_snapshot", "capture_finish"]];
  const shell = [["bash"], ["bash", "read", "write"]];
  const roles = [
    { markers: ["wiki-reader"], prefix: "reader-", tools: browser },
    { markers: ["wiki-orchestrator"], prefix: "orch-", tools: shell },
    { markers: ["wiki-distiller"], prefix: "dist-", tools: shell },
    { markers: [] as string[], prefix: "summarizer-", tools: [...shell, ...browser] },
  ];
  const bad: string[] = [];
  for (const role of roles)
    for (const toolResults of [0, 1, 2, 3])
      for (const lastTool of [null, "browser_navigate", "bash", "capture_finish"])
        for (const offered of role.tools)
          for (const withToken of [false, true]) {
            const req = shape({ markers: role.markers, toolResults, lastTool, offeredTools: offered, lastUserText: withToken ? `x ${TOKEN} y` : "plain task" });
            const hit = matchRule(script, req, new Map());
            if (!hit) continue;
            const mine = role.markers.length > 0 ? hit.id.startsWith(role.prefix) : hit.id.startsWith(role.prefix) && withToken;
            if (!mine) bad.push(`${role.prefix}* request (toolResults=${toolResults}, lastTool=${lastTool}, token=${withToken}) got ${hit.id}`);
          }
  return bad;
}

test("the script passes the stub's own validator", () => {
  const s = load();
  assert.equal(s.fallback?.kind, "text");
  assert.equal((s.fallback as { text: string }).text, "STUB-DONE");
});

test("reader: navigates to example.com, holds the stream, then finishes with canned notes", () => {
  const steps = play(load(), READER);
  // A lone reader drains the shared hold budget (times 4, sized for four readers); with four readers each normally holds once.
  const ids = steps.map((s) => s.id);
  assert.equal(ids[0], "reader-nav");
  assert.equal(ids.at(-1), "reader-finish");
  assert.ok(ids.length >= 3 && ids.slice(1, -1).every((id) => id === "reader-hold"), `unexpected sequence ${ids.join(",")}`);
  assert.equal(steps[1]?.reply.kind, "fault");
  const fault = steps[1]?.reply.kind === "fault" ? steps[1].reply.fault : null;
  assert.equal(fault?.type, "slow_stream");
  if (fault?.type === "slow_stream")
    assert.ok((fault.chunkDelayMs * fault.chunks) / 1000 >= 20 && (fault.chunkDelayMs * fault.chunks) / 1000 <= 30, "hold should last 20 to 30 seconds");
  const cs = calls(steps);
  assert.equal(cs[0]?.name, "browser_navigate");
  assert.equal(cs[0]?.args.url, "https://example.com/");
  assert.equal(cs[1]?.name, "capture_finish");
  assert.equal(cs[1]?.args.status, "succeeded");
  const summary = String(cs[1]?.args.summary);
  assert.equal(summary.split("\n").slice(0, 2).join("\n"), "=== NOTES r0 ===\nREV: 1000001");
  assert.ok(summary.trimEnd().endsWith("NOT READ: none"));
  assert.ok(Buffer.byteLength(summary) >= 400 && Buffer.byteLength(summary) <= 900, `notes are ${Buffer.byteLength(summary)} bytes`);
});

test("orchestrator: short delay, then one bash call that spawns, waits, reaps and reports four briefs", () => {
  const steps = play(load(), ORCH);
  assert.equal(steps[0]?.id, "orch-delay");
  assert.equal(steps[0]?.reply.kind === "fault" && steps[0].reply.fault.type, "slow_stream");
  const fault = steps[0]?.reply.kind === "fault" ? steps[0].reply.fault : null;
  if (fault?.type === "slow_stream") assert.ok((fault.chunkDelayMs * fault.chunks) / 1000 <= 10);
  assert.equal(steps[1]?.id, "orch-spawn");
  const cs = calls(steps);
  assert.equal(cs.length, 1);
  assert.equal(cs[0]?.name, "bash");
  const cmd = String(cs[0]?.args.command);
  for (const needle of [
    "pomtree spawn",
    "--name wiki-summarizer-",
    "--budget 60000",
    "--key wd-stub-sum-$ts-",
    TOKEN,
    "pomtree wait",
    "--timeout 15000",
    "pomtree reap",
    "pomtree result --summary-file /workspace/summary.txt",
    "<<'TASK'",
    '--task "$(cat /workspace/task-$i.txt)"',
    "<<'BRIEFS'",
  ])
    assert.ok(cmd.includes(needle), `command lacks ${needle}`);
  assert.ok(
    cmd.indexOf("pomtree spawn") < cmd.indexOf("pomtree wait") &&
      cmd.indexOf("pomtree wait") < cmd.indexOf("pomtree reap") &&
      cmd.indexOf("pomtree reap") < cmd.lastIndexOf("pomtree result --summary-file"),
  );
  let last = -1;
  for (let i = 1; i <= 4; i++) {
    const at = cmd.indexOf(`=== BRIEF ${i} ===`);
    assert.ok(at > last, `=== BRIEF ${i} === missing or out of order`);
    assert.ok(cmd.includes(`=== END BRIEF ${i} ===`));
    last = at;
  }
  assert.ok(!/--task '|--summary '/.test(cmd), "tasks and summaries go through files, never inline quotes");
  assert.equal(steps.at(-1)?.reply.kind, "text");
});

test("summarizer: matched by its task token, one result call, then a text finish", () => {
  const steps = play(load(), SUMM);
  assert.deepEqual(
    steps.map((s) => s.id),
    ["summarizer-brief", "summarizer-done"],
  );
  assert.equal(calls(steps)[0]?.name, "bash");
  const brief = String(calls(steps)[0]?.args.command);
  assert.ok(
    brief.startsWith("cat > /workspace/brief.txt <<'BRIEF'\n") && brief.endsWith("\nBRIEF\npomtree result --summary-file /workspace/brief.txt"),
    "brief goes through a file",
  );
  assert.equal(steps[1]?.reply.kind, "text");
});

test("distiller: writes the HTML, publishes it, then reports, in that order", () => {
  const steps = play(load(), DIST);
  assert.deepEqual(
    steps.map((s) => s.id),
    ["dist-write", "dist-result", "dist-done"],
  );
  const [write, result] = calls(steps);
  const w = String(write?.args.command);
  assert.ok(w.includes("pomtree report publish /workspace/distillation.html"));
  assert.ok(w.includes("--name distillation.html"));
  assert.ok(w.includes("--key wd-stub-$(date +%s)"));
  assert.ok(w.indexOf("cat > /workspace/distillation.html") < w.indexOf("pomtree report publish"));
  assert.ok(!w.includes("pomtree result"), "result must come in its own later call");
  assert.equal(result?.args.command, "pomtree result --summary 'published distillation.html'");
  const html = w.slice(w.indexOf("<!doctype html>"), w.indexOf("</html>") + 7);
  assert.ok(html.includes("<style>"));
  assert.ok(!/<script|<link|<img|src=|href=|https?:/i.test(html), "the report must be static with no external assets or scripts");
});

test("roles never cross-match, and the check can fail (negative control)", () => {
  assert.deepEqual(crossMatches(load()), []);
  const mutated = structuredClone(load());
  const nav = mutated.rules.find((r) => r.id === "reader-nav");
  assert.ok(nav);
  delete nav.when.marker;
  const bad = crossMatches(mutated);
  assert.ok(bad.length > 0, "removing a rule marker must be detected as a cross-match");
  assert.ok(bad.some((b) => b.includes("got reader-nav")));
  assert.equal(matchRule(load(), shape({ offeredTools: ["bash"], lastUserText: "plain task" }), new Map()), null);
});

test("script and stub templates carry no secrets, machine paths or URL other than example.com", () => {
  const files = [SCRIPT, ...IDS.map(stubTemplate)];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/\/home|\/tmp|secret|token|password|api[_-]?key|innerHTML|m[i]nt/i.test(text.replaceAll(TOKEN, "")), `${f} mentions a forbidden word or path`);
    assert.ok(!/key/i.test(text.replaceAll("--key", "")), `${f} mentions a key outside the --key flag`);
    for (const url of text.match(/https?:\/\/[^\s"'\\]+/g) ?? []) assert.equal(url, "https://example.com/", `${f} names another URL`);
  }
  assert.ok(/key/i.test("x --key y key".replaceAll("--key", "")), "control: the key filter can fire");
});

test("every canned bash command is syntactically valid, and the check can fail", () => {
  const cmds = bashCommands(load());
  assert.ok(cmds.length >= 4);
  for (const c of cmds) {
    const r = spawnSync("bash", ["-n"], { input: c, encoding: "utf8" });
    assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
  }
  assert.notEqual(spawnSync("bash", ["-n"], { input: "if true; then", encoding: "utf8" }).status, 0);
});

test("stub templates: ids are file stems, the prompt is exactly the marker, and the real loader accepts them", async () => {
  const root = tmpDir("wd-stub-templates-");
  for (const id of IDS) {
    const raw = readFileSync(stubTemplate(id), "utf8");
    const t = JSON.parse(raw) as { systemPrompt: string };
    assert.equal(t.systemPrompt, `[[stub:${id}]] rehearsal`);
    assert.deepEqual(markersFrom(t.systemPrompt), [id]);
    writeFileSync(join(root, `${id}.json`), raw);
  }
  const store = new DirTemplateStore({ root });
  for (const id of IDS) {
    const t = await store.resolve(id);
    assert.ok(t, `${id} did not load`);
    assert.equal(t.id, id);
    assert.equal(t.systemPrompt, `[[stub:${id}]] rehearsal`);
  }
  assert.deepEqual((await store.list()).map((t) => t.id).sort(), [...IDS].sort());
  writeFileSync(join(root, "wiki-reader.json"), JSON.stringify({ egress: { kind: "registry" }, browser: { profile: "interactive" } }));
  await assert.rejects(
    () => new DirTemplateStore({ root }).resolve("wiki-reader"),
    /browser/,
    "control: the loader refuses a browser template without audited-public egress",
  );
});

for (const id of IDS)
  test(`parity: stub ${id} equals the real template in every field except systemPrompt`, () => {
    assert.ok(existsSync(realTemplate(id)), `real template ${realTemplate(id)} is missing; parity cannot be checked, restore it`);
    const stub = JSON.parse(readFileSync(stubTemplate(id), "utf8")) as Record<string, unknown>;
    const real = JSON.parse(readFileSync(realTemplate(id), "utf8")) as Record<string, unknown>;
    const { systemPrompt: stubPrompt, ...stubRest } = stub;
    const { systemPrompt: realPrompt, ...realRest } = real;
    assert.deepEqual(stubRest, realRest);
    assert.notEqual(stubPrompt, realPrompt, "the stub prompt must be the marker, not the real prompt");
  });
