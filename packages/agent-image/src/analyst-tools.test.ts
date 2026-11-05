import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TOOL_DETAILS_BYTES } from "@pomtree/core";
import {
  AGENT_ID_PATTERN,
  ANALYST_CAUSES,
  ANALYST_EXT,
  ANALYST_TOOLS,
  PAGE_OUTPUT_MAX_BYTES,
  PAGE_WAIT_MS,
  PAGE_WAIT_TRIES,
  PAGES_MAX,
  RESULT_KEY,
  RESULT_MAX_BYTES,
  pageReportName,
} from "../ext/pomtree-analyst/analyst-contract.ts";
import {
  createAnalystTools,
  pageArgv,
  pageToolDetails,
  parsePage,
  resultArgv,
  serializeAnalysis,
  type PomtreeRun,
  type RunPomtree,
} from "../ext/pomtree-analyst/analyst.ts";
import { CLI_POMTREE_MAIN, PROXY_ENV_NAMES } from "../ext/pomtree-browser/container-contract.gen.ts";

const ENV = { POMTREE_AGENT_ID: "agent-1", POMTREE_TOKEN: "tok-SECRET-1234567890", POMTREE_API: "http://x", PATH: "/evil", HOME: "/h", HTTP_PROXY: "http://p" };
const NOT_FOUND: PomtreeRun = { ok: false, code: 3, signal: null, timedOut: false, overflow: false, stderr: "no such report" };
const failed = (over: Partial<Extract<PomtreeRun, { ok: false }>> = {}): PomtreeRun => ({
  ok: false,
  code: 1,
  signal: null,
  timedOut: false,
  overflow: false,
  stderr: "",
  ...over,
});
const page = (text = "[UNTRUSTED ARTICLE TEXT, page 1 of 1]\n\nhello") => ({ ok: true, stdout: Buffer.from(text) }) satisfies PomtreeRun;

function rig(outcomes: PomtreeRun[], env: Record<string, string | undefined> = ENV) {
  const calls: { file: string; argv: string[]; env: Record<string, string>; maxBuffer: number }[] = [];
  const sleeps: number[] = [];
  const run: RunPomtree = async (file, argv, e, maxBuffer) => {
    calls.push({ file, argv, env: e, maxBuffer });
    return outcomes.shift() ?? page();
  };
  const tools = createAnalystTools({ env, run, execPath: "/usr/local/bin/node", sleep: async (ms) => void sleeps.push(ms) });
  return { calls, sleeps, tools };
}

test("the analyst's tool list is exactly the page reader and the result tool: nothing a shell, file read or write could be", () => {
  assert.deepEqual([...ANALYST_TOOLS], ["article_page", "analysis_result"]);
  for (const forbidden of ["bash", "read", "write", "edit", "web_fetch", "web_search"])
    assert.ok(!(ANALYST_TOOLS as readonly string[]).includes(forbidden), forbidden);
  assert.ok(ANALYST_EXT.startsWith("/opt/pomtree/ext/"));
});

test("page argument: only a whole number 1..PAGES_MAX; strings, fractions, names, flags and out-of-range values are refused", async () => {
  assert.equal(parsePage(1), 1);
  assert.equal(parsePage(PAGES_MAX), PAGES_MAX);
  for (const bad of [
    0,
    -1,
    PAGES_MAX + 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
    "001",
    "article-page-001",
    "../x",
    "1; id",
    "-h",
    null,
    undefined,
    [],
    {},
    true,
  ])
    assert.equal(parsePage(bad), null, String(bad));
  const { calls, tools } = rig([]);
  for (const bad of [0, "1", "article-page-001 --out /etc/x", 1.5, undefined]) {
    const out = await tools.readPage(bad);
    assert.equal(out.ok, false);
    assert.match(out.text, /\(cause=invalid_page\)$/);
  }
  assert.equal(calls.length, 0, "an invalid page never reaches pomtree");
});

test("page read runs exactly node main.ts report show <own agent id> article-page-NNN, with the filtered env and no PATH from the caller", async () => {
  const { calls, tools } = rig([]);
  const out = await tools.readPage(7);
  assert.deepEqual(out, { ok: true, text: "[UNTRUSTED ARTICLE TEXT, page 1 of 1]\n\nhello", attempts: 1 });
  assert.equal(calls[0]?.file, "/usr/local/bin/node");
  assert.deepEqual(calls[0]?.argv, [CLI_POMTREE_MAIN, "report", "show", "agent-1", "article-page-007"]);
  assert.deepEqual(pageArgv("a", 256), [CLI_POMTREE_MAIN, "report", "show", "a", "article-page-256"]);
  assert.equal(pageReportName(12), "article-page-012");
  assert.equal(calls[0]?.maxBuffer, PAGE_OUTPUT_MAX_BYTES);
  const env = calls[0]!.env;
  assert.equal(env.POMTREE_TOKEN, ENV.POMTREE_TOKEN, "pomtree needs its own token");
  assert.equal(env.PATH?.startsWith("/evil"), false, "the PATH is the image's fixed one");
  assert.equal(env.HOME, undefined);
  for (const k of Object.keys(env))
    assert.ok(k === "PATH" || k.startsWith("POMTREE_") || k === "PTREE_CONFIG_JSON" || (PROXY_ENV_NAMES as readonly string[]).includes(k), k);
});

test("a missing or malformed agent id is refused before pomtree runs (never passed on as an argument)", async () => {
  for (const id of [undefined, "", "a b", "a;id", "-x/..", "../x", "a\nb", "x".repeat(129)]) {
    const { calls, tools } = rig([], { ...ENV, POMTREE_AGENT_ID: id });
    const out = await tools.readPage(1);
    assert.equal(out.ok, false, String(id));
    assert.match(out.text, /\(cause=no_agent\)$/);
    assert.equal(calls.length, 0);
  }
  assert.ok(AGENT_ID_PATTERN.test("agent-1.x_2"));
});

test("an unpublished page is polled for, then read; after the wait budget it is unavailable", async () => {
  const wait = rig([NOT_FOUND, NOT_FOUND, page("late")]);
  const late = await wait.tools.readPage(1);
  assert.deepEqual(late, { ok: true, text: "late", attempts: 3 });
  assert.deepEqual(pageToolDetails(1, late), { page: 1, attempts: 3 });
  assert.deepEqual(wait.sleeps, [PAGE_WAIT_MS, PAGE_WAIT_MS]);
  const never = rig(Array.from({ length: PAGE_WAIT_TRIES + 3 }, () => NOT_FOUND));
  const out = await never.tools.readPage(1);
  assert.equal(out.ok, false);
  assert.match(out.text, /\(cause=unavailable\)$/);
  assert.equal(never.calls.length, PAGE_WAIT_TRIES);
  assert.equal(never.sleeps.length, PAGE_WAIT_TRIES - 1);
});

test("pageToolDetails: attempts only from a successful read; a failure or an outcome without a count carries the page alone", async () => {
  assert.deepEqual(pageToolDetails(5, { ok: true, text: "t", attempts: 1 }), { page: 5, attempts: 1 });
  assert.deepEqual(pageToolDetails(5, { ok: true, text: "t" }), { page: 5 });
  assert.deepEqual(pageToolDetails(5, { ok: false, text: "x", cause: "unavailable" }), { page: 5 });
  assert.ok(
    new TextEncoder().encode(JSON.stringify(pageToolDetails(256, { ok: true, text: "t", attempts: PAGE_WAIT_TRIES }))).length <= MAX_TOOL_DETAILS_BYTES,
  );
});

test("page read failures carry a closed cause and never pomtree's stderr or the token", async () => {
  const stderr = `boom POMTREE_TOKEN=${ENV.POMTREE_TOKEN} secret page text`;
  const cases: [PomtreeRun, string][] = [
    [failed({ code: 1, stderr }), "read_failed"],
    [failed({ code: 4, stderr }), "read_failed"],
    [failed({ code: "ENOENT", stderr }), "read_failed"],
    [failed({ code: null, timedOut: true, signal: "SIGTERM", stderr }), "timeout"],
    [failed({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", overflow: true, stderr }), "too_large"],
  ];
  for (const [outcome, cause] of cases) {
    const { calls, tools } = rig([outcome]);
    const out = await tools.readPage(1);
    assert.equal(out.ok, false);
    assert.match(out.text, new RegExp(`\\(cause=${cause}\\)$`), cause);
    assert.equal(calls.length, 1, "only a missing page is retried");
    assert.ok(!out.text.includes(ENV.POMTREE_TOKEN) && !out.text.includes("secret page text") && !out.text.includes("boom"));
    if (!out.ok) assert.ok(!JSON.stringify(out.failure).includes(ENV.POMTREE_TOKEN), "the operator detail is redacted too");
  }
  assert.ok(
    ANALYST_CAUSES.every((c) => /^[a-z_]{1,32}$/.test(c)),
    "causes match the daemon's (cause=...) parser",
  );
});

test("analysis_result runs exactly node main.ts result --key hn-content-analysis <json> and nothing else", async () => {
  const analysis = { summary: "s", claims: [] };
  const { calls, tools } = rig([{ ok: true, stdout: Buffer.alloc(0) }]);
  assert.deepEqual(await tools.submit(analysis), { ok: true, text: "result recorded" });
  assert.deepEqual(calls[0]?.argv, [CLI_POMTREE_MAIN, "result", "--key", RESULT_KEY, JSON.stringify(analysis)]);
  assert.deepEqual(resultArgv("{}"), [CLI_POMTREE_MAIN, "result", "--key", "hn-content-analysis", "{}"]);
  assert.ok(!calls[0]?.argv.some((a) => /summary-file|save-uncommitted|--status/.test(a)));
  // The same analysis given as its JSON text is the same call.
  const text = rig([{ ok: true, stdout: Buffer.alloc(0) }]);
  await text.tools.submit(JSON.stringify(analysis));
  assert.deepEqual(text.calls[0]?.argv, calls[0]?.argv);
});

test("analysis validation: a plain object with a summary within the byte bound; everything else is refused without running pomtree", async () => {
  const big = { summary: "s", pad: "x".repeat(RESULT_MAX_BYTES) };
  for (const bad of [
    undefined,
    null,
    5,
    true,
    [],
    [{ summary: "s" }],
    "not json",
    "[1]",
    "5",
    {},
    { summary: "" },
    { summary: "  " },
    { summary: 3 },
    big,
    JSON.stringify(big),
  ]) {
    const { calls, tools } = rig([]);
    const out = await tools.submit(bad);
    assert.equal(out.ok, false, JSON.stringify(bad)?.slice(0, 40));
    assert.match(out.text, /\(cause=invalid_result\)$/);
    assert.equal(calls.length, 0);
  }
  assert.equal(serializeAnalysis({ summary: "é".repeat(RESULT_MAX_BYTES / 2 - 20) }).ok, true, "the bound is bytes of the JSON text");
  assert.equal(serializeAnalysis({ summary: "é".repeat(RESULT_MAX_BYTES / 2) }).ok, false);
});

test("analysis_result is callable once; a failed attempt does not consume the call; the model sees only the closed cause", async () => {
  const ok = rig([{ ok: true, stdout: Buffer.alloc(0) }]);
  const [a, b] = await Promise.all([ok.tools.submit({ summary: "one" }), ok.tools.submit({ summary: "two" })]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  assert.match((await ok.tools.submit({ summary: "three" })).text, /\(cause=already_submitted\)$/);
  assert.equal(ok.calls.length, 1);
  const bad = rig([failed({ code: 4, stderr: `denied ${ENV.POMTREE_TOKEN}` }), { ok: true, stdout: Buffer.alloc(0) }]);
  const first = await bad.tools.submit({ summary: "x" });
  assert.equal(first.ok, false);
  assert.match(first.text, /pomtree exit 4.*\(cause=submit_failed\)$/);
  assert.ok(!first.text.includes(ENV.POMTREE_TOKEN) && !first.text.includes("denied"));
  assert.equal((await bad.tools.submit({ summary: "x" })).ok, true);
  assert.equal(bad.calls.length, 2);
});

test("analysis_result after a timeout: the identical analysis is replayed under the same key, a different one is already_submitted", async () => {
  const r = rig([failed({ code: null, timedOut: true, signal: "SIGTERM" }), { ok: true, stdout: Buffer.alloc(0) }]);
  assert.match((await r.tools.submit({ summary: "x" })).text, /pomtree timed out.*exactly the same value \(cause=submit_failed\)$/);
  assert.match((await r.tools.submit({ summary: "y" })).text, /\(cause=already_submitted\)$/);
  assert.equal(r.calls.length, 1, "a different analysis never reaches pomtree");
  assert.deepEqual(await r.tools.submit(JSON.stringify({ summary: "x" })), { ok: true, text: "result recorded" });
  assert.deepEqual(r.calls[1]?.argv, r.calls[0]?.argv);
});
