import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT_SIGNALS } from "@pomtree/core";
import type { SandboxHandle } from "@pomtree/core";
import { readFileSync } from "node:fs";
import {
  createPiHarness,
  events as piEvents,
  isSettled,
  lines,
  MAX_DRIFT_ERRORS,
  MAX_TOOL_OUTPUT_BYTES,
  normalize,
  piArgv,
  PI_ISOLATION_FLAGS,
  sessionRestorePlan,
  PI_SESSION_PATH,
  PI_GUIDE_PATH,
  PI_AUTH_PATH,
  PI_EXT_LOADOUT,
  PI_STEER_EXT,
  PI_JOBS_EXT,
  PI_EVENTS_EXT,
  truncateToolOutput,
  type TailSource,
} from "./index.ts";
import { normalizeRecord } from "./pi-format.ts";

const j = (o: unknown) => JSON.stringify(o);

// A sink that delivers each chunk on its own read, then reports no news.
const sinkOf = (chunks: string[]): TailSource => {
  let i = 0;
  let offset = 0;
  return {
    async read() {
      const text = chunks[i++] ?? "";
      offset += text.length;
      return { text, offset };
    },
  };
};
const noSleep = async () => {};
const harnessOf = (chunks: string[] = [], deps: { steer?: (a: string, m: string) => Promise<void> } = {}) =>
  createPiHarness({ ...deps, sink: () => sinkOf(chunks), sleep: noSleep });

test("normalize: assistant message with usage", () => {
  const ev = normalize(
    j({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 10, output: 2, cost: { total: 0.0015 } } },
    }),
  );
  assert.deepEqual(ev, [
    { kind: "message", role: "assistant", text: "hi" },
    { kind: "usage", inputTokens: 10, outputTokens: 2, costMicros: 1500 },
  ]);
});

test("normalize: user string content", () => {
  assert.deepEqual(normalize(j({ type: "message_end", message: { role: "user", content: "go" } })), [{ kind: "message", role: "user", text: "go" }]);
});

test("normalize: tool_result output is truncated to 64 KiB with a marker", () => {
  const big = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 4464);
  const ev = normalize(j({ type: "tool_execution_end", toolCallId: "c1", result: { content: [{ type: "text", text: big }] } }));
  assert.equal(ev.length, 1);
  const r = ev[0]!;
  assert.ok(r.kind === "tool_result");
  assert.ok(r.output.startsWith("x".repeat(MAX_TOOL_OUTPUT_BYTES)));
  assert.ok(r.output.endsWith("[pomtree: 4464 bytes of tool output truncated]"));
  assert.equal(r.output.length, MAX_TOOL_OUTPUT_BYTES + "[pomtree: 4464 bytes of tool output truncated]".length);
});

test("normalize: tool_result carries the tool's details, bounded: kept, dropped with a marker when oversize or non-JSON, absent is fine", () => {
  const end = (result: unknown) => normalize(j({ type: "tool_execution_end", toolCallId: "c1", result }))[0]!;
  const text = [{ type: "text", text: "ok" }];
  assert.deepEqual(end({ content: text, details: { page: 2, attempts: 3 } }), {
    kind: "tool_result",
    callId: "c1",
    ok: true,
    output: "ok",
    details: { page: 2, attempts: 3 },
  });
  assert.deepEqual(end({ content: text }), { kind: "tool_result", callId: "c1", ok: true, output: "ok" });
  assert.ok(!("details" in end({ content: text })));
  assert.deepEqual((end({ content: text, details: { x: "y".repeat(5000) } }) as { details: unknown }).details, { pomtree_dropped: "oversize" });
  assert.deepEqual((end({ content: text, details: "z".repeat(1024) }) as { details: unknown }).details, { pomtree_dropped: "oversize" });
  // JSONL cannot carry a non-JSON value, so a record reaching normalizeRecord directly is the non-JSON case.
  assert.deepEqual(
    (normalizeRecord({ type: "tool_execution_end", toolCallId: "c1", result: { content: text, details: new Date(0) } })[0] as { details: unknown }).details,
    {
      pomtree_dropped: "non_json",
    },
  );
});

test("truncateToolOutput: passes through under the cap and never splits a multibyte char", () => {
  assert.equal(truncateToolOutput("short"), "short");
  const atCap = "x".repeat(MAX_TOOL_OUTPUT_BYTES);
  assert.equal(truncateToolOutput(atCap), atCap);
  // 4-byte emoji; a cut landing mid-sequence must not produce a replacement character.
  const over = "😀".repeat(MAX_TOOL_OUTPUT_BYTES / 4 + 1); // one full emoji (4 bytes) over the cap
  const out = truncateToolOutput(over);
  assert.ok(out.startsWith("😀".repeat(MAX_TOOL_OUTPUT_BYTES / 4)));
  assert.ok(out.endsWith("[pomtree: 4 bytes of tool output truncated]"));
  assert.ok(!out.includes("\uFFFD"));
});

test("normalize: tool start/end", () => {
  assert.deepEqual(normalize(j({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } })), [
    { kind: "tool_call", tool: "bash", callId: "c1", input: { command: "ls" } },
  ]);
  assert.deepEqual(
    normalize(j({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a" }] }, isError: true })),
    [{ kind: "tool_result", callId: "c1", ok: false, output: "a" }],
  );
});

test("normalize: errors", () => {
  assert.deepEqual(normalize(j({ type: "auto_retry_end", success: false, finalError: "boom" })), [{ kind: "error", message: "boom" }]);
  assert.deepEqual(normalize(j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "x" } })), [
    { kind: "error", message: "x" },
  ]);
});

test("normalize: 429 message_end is a retryable rate_limit provider_error", () => {
  assert.deepEqual(
    normalize(j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Too Many Requests" } })),
    [{ kind: "provider_error", code: "rate_limit", message: "429 Too Many Requests", retryable: true }],
  );
});

test("normalize: 401 message_end is an auth provider_error", () => {
  assert.deepEqual(normalize(j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid token" } })), [
    {
      kind: "provider_error",
      code: "auth",
      message:
        "provider authentication failed: check the provider key or login on the host (the Pi auth.json pomtreed stages), then retry the run; provider said: 401 invalid token",
      retryable: false,
    },
  ]);
});

test("normalize: 5xx auto_retry_end is an outage provider_error", () => {
  assert.deepEqual(normalize(j({ type: "auto_retry_end", success: false, finalError: "503 Service Unavailable" })), [
    { kind: "provider_error", code: "outage", message: "503 Service Unavailable", retryable: true },
  ]);
});

test("normalize: tool error still yields error, not provider_error", () => {
  assert.deepEqual(
    normalize(
      j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "bash tool failed: permission denied" } }),
    ),
    [{ kind: "error", message: "bash tool failed: permission denied" }],
  );
});

test("normalize: token/5xx substrings are not provider errors", () => {
  const m = (errorMessage: string) => j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } });
  for (const msg of ["context exceeds 100000 tokens", "request used 5000 tokens", "tried 503 times and gave up"]) {
    assert.deepEqual(normalize(m(msg)), [{ kind: "error", message: msg }]);
  }
});

test("normalize: status/HTTP-prefixed codes are provider errors", () => {
  const m = (errorMessage: string) => j({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage } });
  assert.deepEqual(normalize(m("HTTP 503 Service Unavailable")), [
    { kind: "provider_error", code: "outage", message: "HTTP 503 Service Unavailable", retryable: true },
  ]);
  const [auth] = normalize(m("status code 401"));
  assert.ok(auth?.kind === "provider_error" && auth.code === "auth" && auth.retryable === false && auth.message.endsWith("provider said: status code 401"));
});

test("normalize: unknown, malformed, header, deltas map to nothing", () => {
  for (const l of [
    "",
    "not json",
    "{",
    "[]",
    "null",
    j({ type: "session", id: "x" }),
    j({ type: "message_update" }),
    j({ type: "wat" }),
    j({ type: "tool_execution_start" }),
  ]) {
    assert.deepEqual(normalize(l), []);
  }
});

test("normalize: tolerates CRLF", () => {
  assert.equal(normalize(j({ type: "tool_execution_start", toolCallId: "a", toolName: "t" }) + "\r").length, 1);
});

const fake = (chunks: string[]): SandboxHandle => ({
  id: "sb",
  async *output() {
    for (const c of chunks) yield { stream: "stdout" as const, chunk: c };
    yield { stream: "stderr" as const, chunk: j({ type: "tool_execution_start", toolCallId: "z", toolName: "t" }) + "\n" };
  },
  wait: async () => ({ exitCode: 0 }),
});

test("adapter: reassembles lines split across chunks, ignores stderr", async () => {
  const a = j({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
  const b = j({ type: "message_end", message: { role: "user", content: "u x" } });
  const s = await harnessOf([a.slice(0, 10), a.slice(10) + "\n" + b.slice(0, 5), b.slice(5)]).start({ agent: "a1", sandbox: fake([]), prompt: "p" });
  const got = [];
  for await (const e of s.events()) got.push(e);
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { kind: "tool_call", tool: "bash", callId: "1", input: {} });
  assert.deepEqual(got[1], { kind: "message", role: "user", text: "u x" });
  assert.deepEqual(got[2], { kind: "error", message: "agent ended without reporting a result (exit 0, settled=false)" });
});

test("adapter: steer unsupported by default, delegates when injected; resume works", async () => {
  const h = harnessOf();
  const s = await h.resume({ agent: "a", sandbox: fake([]), sessionRef: "r", wake: "w" });
  await assert.rejects(s.steer("x"));
  const calls: string[] = [];
  const s2 = await harnessOf([], { steer: async (_a, m) => void calls.push(m) }).start({ agent: "a", sandbox: fake([]), prompt: "p" });
  await s2.steer("hey");
  assert.deepEqual(calls, ["hey"]);
});

test("piArgv runs the interactive TUI in regular mode with the fixed session path", () => {
  assert.deepEqual(piArgv({ prompt: "p" }).slice(0, 5), ["pi", "--tui-mode", "regular", "--session", "/workspace/.pi-session/session.jsonl"]);
  assert.equal(piArgv({ prompt: "p" }).includes("--mode"), false);
});

test("piArgv appends the agent guide to the system prompt", () => {
  const argv = piArgv({ prompt: "p" });
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], PI_GUIDE_PATH);
  assert.equal(argv.at(-1), "p");
});

test("piArgv: no tools/guide/extSet option leaves the default argv unchanged; tools, guide:false and extSet:events narrow it", () => {
  const base = piArgv({ prompt: "p", steerExt: true, jobsExt: false });
  assert.deepEqual(piArgv({ prompt: "p", steerExt: true, jobsExt: false, guide: undefined, tools: undefined, extSet: "default" }), base);
  assert.equal(base.includes("--tools"), false);
  const narrow = piArgv({ prompt: "p", steerExt: true, jobsExt: true, tools: ["browser_capture", "capture_finish"], guide: false, extSet: "events" });
  assert.equal(narrow.includes("--append-system-prompt"), false);
  assert.equal(narrow.includes(PI_GUIDE_PATH), false);
  assert.deepEqual(
    narrow.flatMap((a, i) => (a === "--extension" ? [narrow[i + 1]] : [])),
    [PI_EVENTS_EXT.path],
  );
  assert.equal(narrow[narrow.indexOf("--tools") + 1], "browser_capture,capture_finish");
  assert.ok(narrow.indexOf("--tools") < narrow.indexOf("--"));
  assert.deepEqual(narrow.slice(-2), ["--", "p"]);
  assert.throws(() => piArgv({ prompt: "p", tools: [] }), /at least one tool/);
  const custom = piArgv({ prompt: "p", guide: "/x/g.md" });
  assert.equal(custom[custom.indexOf("--append-system-prompt") + 1], "/x/g.md");
});

test("piArgv allowlist: only the named tools, the events sink and the named extension; isolation flags; no guide; before the prompt", () => {
  const argv = piArgv({ prompt: "p", provider: "x", model: "m", allowlist: { tools: ["a_tool", "b_tool"], extension: "/opt/pomtree/ext/ext-x" } });
  assert.equal(argv[argv.indexOf("--tools") + 1], "a_tool,b_tool");
  assert.equal(argv.filter((a) => a === "--tools").length, 1);
  assert.deepEqual(
    argv.flatMap((a, i) => (a === "--extension" ? [argv[i + 1]] : [])),
    [PI_EVENTS_EXT.path, "/opt/pomtree/ext/ext-x"],
  );
  for (const f of PI_ISOLATION_FLAGS) assert.ok(argv.indexOf(f) > 0 && argv.indexOf(f) < argv.indexOf("--"), f);
  assert.equal(argv.includes("--append-system-prompt"), false);
  assert.equal(
    argv.some((a) => /web_search|web_fetch|mailbox|jobs/.test(a)),
    false,
  );
  assert.deepEqual(argv.slice(-2), ["--", "p"]);
  // Negative variants: nothing may widen the tool list or the extension set.
  const allowlist = { tools: ["a_tool"], extension: "/opt/pomtree/ext/ext-x" };
  assert.throws(() => piArgv({ prompt: "p", allowlist, tools: ["bash"] }), /excludes/);
  assert.throws(() => piArgv({ prompt: "p", allowlist, extSet: "default" }), /excludes/);
  assert.throws(() => piArgv({ prompt: "p", allowlist, guide: "/g.md" }), /excludes/);
  assert.throws(() => piArgv({ prompt: "p", allowlist: { ...allowlist, tools: [] } }), /plain tool names/);
  assert.throws(() => piArgv({ prompt: "p", allowlist: { ...allowlist, tools: ["a,bash"] } }), /plain tool names/);
  assert.throws(() => piArgv({ prompt: "p", allowlist: { ...allowlist, tools: ["--x"] } }), /plain tool names/);
  for (const extension of ["/workspace/.pi/ext", "/opt/pomtree/ext/../x", "/opt/pomtree/ext/", "ext-x", "/opt/pomtree/extra"])
    assert.throws(() => piArgv({ prompt: "p", allowlist: { ...allowlist, extension } }), /in-image path/, extension);
});

test("piArgv loads the in-image extension loadout with explicit --extension paths", () => {
  const argv = piArgv({ prompt: "p" });
  const flags: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--extension") flags.push(argv[i + 1]!);
  });
  assert.deepEqual(flags.sort(), [...PI_EXT_LOADOUT, PI_EVENTS_EXT, PI_STEER_EXT].map((e) => e.path).sort());
  for (const e of [...PI_EXT_LOADOUT, PI_EVENTS_EXT, PI_STEER_EXT]) {
    assert.ok(argv.indexOf(e.path) < argv.indexOf("--"), `--extension for ${e.name} must precede the prompt separator`);
  }
  assert.equal(
    PI_EXT_LOADOUT.map((e) => e.name)
      .sort()
      .join(","),
    "web_fetch,web_search",
  );
});

test("mailbox steering extension is on by default; steerExt:false disables it; POMTREED_STEER_EXT no longer matters", () => {
  const prev = process.env.POMTREED_STEER_EXT;
  try {
    delete process.env.POMTREED_STEER_EXT;
    const on = piArgv({ prompt: "p" });
    assert.ok(on.indexOf(PI_STEER_EXT.path) > 0 && on.indexOf(PI_STEER_EXT.path) < on.indexOf("--"));
    process.env.POMTREED_STEER_EXT = "0";
    assert.deepEqual(piArgv({ prompt: "p" }), on);
    assert.ok(piArgv({ prompt: "p", steerExt: true }).includes(PI_STEER_EXT.path));
    assert.equal(piArgv({ prompt: "p", steerExt: false }).includes(PI_STEER_EXT.path), false);
  } finally {
    if (prev === undefined) delete process.env.POMTREED_STEER_EXT;
    else process.env.POMTREED_STEER_EXT = prev;
  }
});

test("sessionRestorePlan targets the fixed session path", () => {
  assert.deepEqual(sessionRestorePlan("ref1"), { ref: "ref1", dest: PI_SESSION_PATH, dir: "/workspace/.pi-session" });
});

const fixture = (n: string) =>
  readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8")
    .split("\n")
    .flatMap(normalize);

test("fixture (recorded real Pi): plain reply yields user, assistant text, real usage", () => {
  const ev = fixture("plain.jsonl");
  assert.deepEqual(
    ev.map((e) => e.kind),
    ["message", "message", "usage"],
  );
  assert.deepEqual(ev[1], { kind: "message", role: "assistant", text: "Hi! 👋 How can I help you today?" });
  // Every usage field the recorded message carries, including the provider's response id the daemon joins settlements on.
  assert.deepEqual(ev[2], {
    kind: "usage",
    inputTokens: 1786,
    outputTokens: 24,
    costMicros: 2453,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: "deepseek-v4-pro",
    provider: "deepseek",
    responseId: "ea9b9c98-deb5-4181-82f0-4a1e10afeca1",
    stopReason: "stop",
  });
});

test("fixture (recorded real Pi): bash tool call, result, toolResult message ignored", () => {
  const ev = fixture("tool.jsonl");
  assert.deepEqual(
    ev.map((e) => e.kind),
    ["message", "usage", "tool_call", "tool_result", "message", "usage"],
  );
  assert.deepEqual(ev[3], { kind: "tool_result", callId: ev[2] && "callId" in ev[2] ? ev[2].callId : "", ok: true, output: "pomtree-ok\n" });
});

test("fixture (recorded real Pi): a wrong model id surfaces as a provider config error keeping the provider's text", () => {
  const ev = fixture("error.jsonl");
  assert.ok(
    ev.some(
      (e) =>
        e.kind === "provider_error" && e.code === "config" && !e.retryable && /check the model id/.test(e.message) && /provider said: 400: \{/.test(e.message),
    ),
  );
});

const collectEvents = async (h: SandboxHandle, sinkText = "") => {
  const s = await harnessOf([sinkText]).start({ agent: "a", sandbox: h, prompt: "p" });
  const got = [];
  for await (const e of s.events()) got.push(e);
  return got;
};
const out = (chunks: { stream: "stdout" | "stderr"; chunk: string }[], exitCode: number): SandboxHandle => ({
  id: "sb",
  async *output() {
    yield* chunks;
  },
  wait: async () => ({ exitCode }),
});
const so = (chunk: string) => ({ stream: "stdout" as const, chunk });

test("lines: over-long line is dropped with a marker, later lines survive", async () => {
  async function* src() {
    yield "x".repeat(50);
    yield "yyy\nok\n";
  }
  const got = [];
  for await (const l of lines(src(), 10)) got.push(l);
  assert.deepEqual(got, [{ oversize: true }, "ok"]);
});

test("events: oversize line becomes an error event, stream continues", async () => {
  const good = j({ type: "tool_execution_start", toolCallId: "1", toolName: "t" });
  async function* src() {
    yield "z".repeat(300) + "\n" + good + "\n";
  }
  const got = [];
  for await (const e of piEvents(src(), 200)) got.push(e);
  assert.equal(got[0]?.kind, "error");
  assert.equal(got[1]?.kind, "tool_call");
});

test("events: unparseable final line (truncated stream) emits error; clean final line does not", async () => {
  const good = j({ type: "tool_execution_start", toolCallId: "1", toolName: "t" });
  async function* truncated() {
    yield good + "\n" + good.slice(0, 8);
  }
  const a = [];
  for await (const e of piEvents(truncated())) a.push(e);
  assert.deepEqual(
    a.map((e) => e.kind),
    ["tool_call", "error"],
  );
  async function* clean() {
    yield good;
  }
  const b = [];
  for await (const e of piEvents(clean())) b.push(e);
  assert.deepEqual(
    b.map((e) => e.kind),
    ["tool_call"],
  );
});

test("events: agent_settled yields a settled event and no no-result error follows the exit", async () => {
  const good = j({ type: "tool_execution_start", toolCallId: "1", toolName: "t" });
  const h: SandboxHandle = {
    id: "sb",
    async *output() {
      yield so("terminal noise");
    },
    wait: async () => ({ exitCode: 0 }),
  };
  assert.deepEqual(
    (await collectEvents(h, good + "\n" + j({ type: "agent_settled" }) + "\n")).map((e) => e.kind),
    ["tool_call", "settled"],
  );
  assert.equal(isSettled({ type: "agent_settled" }), true);
});

test("events: malformed lines emit a rate-limited error", async () => {
  const good = j({ type: "tool_execution_start", toolCallId: "1", toolName: "t" });
  async function* src() {
    yield `bad1\nbad2\n${good}\n`;
  }
  const got = [];
  for await (const e of piEvents(src())) got.push(e);
  assert.deepEqual(
    got.map((e) => e.kind),
    ["error", "error", "tool_call"],
  );
});

test("events: malformed-line errors stop after MAX_DRIFT_ERRORS", async () => {
  async function* src() {
    yield "x\n".repeat(MAX_DRIFT_ERRORS + 5);
  }
  const got = [];
  for await (const e of piEvents(src())) got.push(e);
  assert.equal(got.length, MAX_DRIFT_ERRORS);
  assert.ok(got.every((e) => e.kind === "error"));
});

test("events: unknown record types are counted and reported at the end of the stream", async () => {
  const good = j({ type: "tool_execution_start", toolCallId: "1", toolName: "t" });
  async function* src() {
    yield `${j({ type: "reasoning_update" })}\n${j({ type: "reasoning_update" })}\n${j({ type: "turn_x" })}\n${good}\n`;
  }
  const got = [];
  for await (const e of piEvents(src())) got.push(e);
  assert.deepEqual(
    got.map((e) => e.kind),
    ["tool_call", "error"],
  );
  const e = got[1]!;
  assert.ok(e.kind === "error" && e.message.includes('"reasoning_update" (x2)') && e.message.includes('"turn_x" (x1)'));
});

test("events: unknown record types are listed in sorted order, not arrival order", async () => {
  async function* src() {
    yield `${j({ type: "zeta_x" })}\n${j({ type: "alpha_x" })}\n`;
  }
  const got = [];
  for await (const e of piEvents(src())) got.push(e);
  assert.equal(got.length, 1);
  const e = got[0]!;
  assert.ok(e.kind === "error" && e.message.endsWith('"alpha_x" (x1), "zeta_x" (x1)'));
});

test("events: unknown record types are reported even when the stream settles", async () => {
  async function* src() {
    yield `${j({ type: "reasoning_update" })}\n${j({ type: "agent_settled" })}\n`;
  }
  const got = [];
  for await (const e of piEvents(src())) got.push(e);
  assert.equal(got.length, 1);
  const e = got[0]!;
  assert.ok(e.kind === "error" && e.message.includes('"reasoning_update" (x1)'));
});

test("events: nonzero exit emits one error with a bounded stderr tail; zero exit reports no result", async () => {
  const noise = "E".repeat(5000) + "boom";
  const got = await collectEvents(out([{ stream: "stderr", chunk: noise }], 3));
  assert.equal(got.length, 1);
  const e = got[0]!;
  assert.ok(e.kind === "error" && e.message.startsWith("pi exited with code 3: ") && e.message.endsWith("boom") && e.message.length < 2100);
  assert.deepEqual(await collectEvents(out([], 0)), [{ kind: "error", message: "agent ended without reporting a result (exit 0, settled=false)" }]);
});

test("events: clean exit without a settle emits an error after the stream's events", async () => {
  const good = j({ type: "tool_execution_start", toolCallId: "1", toolName: "t" });
  const got = await collectEvents(out([], 0), good + "\n");
  assert.deepEqual(
    got.map((e) => e.kind),
    ["tool_call", "error"],
  );
  assert.deepEqual(got[1], { kind: "error", message: "agent ended without reporting a result (exit 0, settled=false)" });
});

test("events: a nonzero exit's terminal tail is never classified as a provider error (error-class)", async () => {
  // Page or tool text in the TUI tail ("Author:", "OAuth", "credential", "429") must not turn a crash into an auth stop or a backoff.
  for (const tailText of ["connection refused", "Author: Jane Doe", "Sign in with OAuth", "credentials page loaded", "HTTP 429 from page"]) {
    const got = await collectEvents(out([{ stream: "stderr", chunk: tailText }], 1));
    assert.deepEqual(got, [{ kind: "error", message: `pi exited with code 1: ${tailText}` }], tailText);
  }
  // A SIGKILL (the OOM killer's signal) with auth-looking page text stays a plain exit error naming the signal.
  const killed = await collectEvents(out([{ stream: "stderr", chunk: "Author: OAuth credential docs" }], 137));
  assert.equal(killed.length, 1);
  assert.ok(killed[0]?.kind === "error" && /^pi exited with code 137 \[signal=SIGKILL\]/.test(killed[0].message), JSON.stringify(killed));
});

test("events: page text in the exit tail never becomes a non-retryable funding/config stop", async () => {
  for (const tailText of ["page said HTTP 404 Not Found", "status 400: model unknown", "insufficient balance, add credits", "402 Payment Required"]) {
    const got = await collectEvents(out([{ stream: "stderr", chunk: tailText }], 1));
    assert.deepEqual(got, [{ kind: "error", message: `pi exited with code 1: ${tailText}` }], tailText);
  }
});

test("events: an escape sequence split across output chunks and an unterminated DCS keep the tail and cause suffix", async () => {
  const got = await collectEvents(
    out(
      [
        { stream: "stderr", chunk: "a\u001b[3" },
        { stream: "stderr", chunk: "1mb \u001bP hide" },
      ],
      137,
    ),
  );
  const e = got[0]!;
  assert.ok(e.kind === "error" && /\[cause=/.test(e.message) && e.message.endsWith(": ab  hide"), JSON.stringify(e));
});

test("piArgv passes provider and model before the prompt separator, omits them when unset", () => {
  assert.equal(piArgv({ prompt: "p" }).includes("--model"), false);
  const a = piArgv({ prompt: "p", provider: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(a.slice(a.indexOf("--provider")), ["--provider", "deepseek", "--model", "deepseek-chat", "--", "p"]);
  const b = piArgv({ prompt: "p", model: "anthropic/sonnet" });
  assert.deepEqual(b.slice(b.indexOf("--model")), ["--model", "anthropic/sonnet", "--", "p"]);
  assert.equal(b.includes("--provider"), false);
});

test("piArgv rejects a provider without a model", () => {
  assert.throws(() => piArgv({ prompt: "p", provider: "deepseek" }), /provider requires model/);
});

test("PI_AUTH_PATH is under Pi's agent dir", () => {
  assert.equal(PI_AUTH_PATH, "/home/node/.pi/agent/auth.json");
});

test("auth-perms: an unreadable auth.json on exit is named in the error", async () => {
  const got = await collectEvents(out([{ stream: "stderr", chunk: "Error: EACCES: permission denied, open '/home/node/.pi/agent/auth.json'" }], 1));
  const e = got[0]!;
  assert.ok((e.kind === "error" || e.kind === "provider_error") && /auth\.json is not readable by the container user/.test(e.message));
});

test("exit-cause: signal, exec_failed and oom exits carry classifyExit's cause; app_exit stays bare", async () => {
  const msg = async (code: number, oom?: boolean) => {
    const h: SandboxHandle = { id: "sb", async *output() {}, wait: async () => ({ exitCode: code, ...(oom ? { oomKilled: true } : {}) }) };
    const e = (await collectEvents(h))[0]!;
    return e.kind === "error" ? e.message : "";
  };
  assert.match(await msg(139), /\[cause=signal\]/);
  assert.match(await msg(127), /\[cause=exec_failed\]/);
  assert.match(await msg(137, true), /\[cause=oom_killed\]/);
  assert.doesNotMatch(await msg(2), /cause=/);
});

test("piArgv places provider/model before the prompt, including slash ids", () => {
  const a = piArgv({ prompt: "go", provider: "baseten", model: "zai-org/GLM-5", steerExt: false });
  const i = a.indexOf("--provider");
  assert.deepEqual(a.slice(i, i + 4), ["--provider", "baseten", "--model", "zai-org/GLM-5"]);
  assert.equal(a.at(-1), "go");
});

test("guide: agents commit in a private clone, pomtree push, and merge children via pomtree merge", async () => {
  const { readFileSync } = await import("node:fs");
  const g = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");
  assert.match(g, /private, full Git clone/);
  assert.match(g, /pomtree push/);
  assert.match(g, /pomtree pull --from/);
  assert.match(g, /pomtree merge <child-id>/);
  assert.doesNotMatch(g, /You merge your children's work yourself/);
  assert.doesNotMatch(g, /mounted read-only|Read-only\s+file system|daemon merges/);
  assert.doesNotMatch(g, /Commit small and often|git merge agent|git add -A|cherry-pick <commit>|merge --abort|Commit before you yield/);
});

test("fixture (recorded real Pi): tool_call keeps tool name, callId and structured input", () => {
  const call = fixture("tool.jsonl").find((e) => e.kind === "tool_call");
  assert.ok(call && call.kind === "tool_call");
  assert.equal(call.tool, "bash");
  assert.deepEqual(call.input, { command: "echo pomtree-ok", timeout: 10 });
  assert.match(call.callId, /^call_/);
});

test("piArgv loads the jobs extension only when opted in via jobsExt; POMTREED_JOBS_EXT no longer matters", () => {
  const prev = process.env.POMTREED_JOBS_EXT;
  try {
    delete process.env.POMTREED_JOBS_EXT;
    const off = piArgv({ prompt: "p" });
    assert.equal(off.includes(PI_JOBS_EXT.path), false);
    const on = piArgv({ prompt: "p", jobsExt: true });
    assert.ok(on.indexOf(PI_JOBS_EXT.path) > 0 && on.indexOf(PI_JOBS_EXT.path) < on.indexOf("--"));
    process.env.POMTREED_JOBS_EXT = "1";
    assert.deepEqual(piArgv({ prompt: "p" }), off);
    assert.equal(piArgv({ prompt: "p", jobsExt: false }).includes(PI_JOBS_EXT.path), false);
  } finally {
    if (prev === undefined) delete process.env.POMTREED_JOBS_EXT;
    else process.env.POMTREED_JOBS_EXT = prev;
  }
});

test("guide: background jobs section states the hard facts and the safe manual pattern", () => {
  const g = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");
  assert.match(g, /## Background jobs/);
  assert.match(g, /job_start/);
  assert.match(g, /nohup/);
  assert.match(g, /pomtree yield/);
  assert.match(g, /512/);
});

test("normalize: aborted assistant message and 'Command aborted' tool result are sane", () => {
  const abortedMsg = normalize(j({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" } }));
  assert.ok(abortedMsg.some((e) => e.kind === "message" && e.text === "partial"));
  assert.deepEqual(
    normalize(
      j({
        type: "tool_execution_end",
        toolCallId: "c9",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "out\n\nCommand aborted" }] },
      }),
    ),
    [{ kind: "tool_result", callId: "c9", ok: false, output: "out\n\nCommand aborted" }],
  );
});

test("adapter: exit 143 and clean exit without agent_settled have stable machine-distinguishable messages", async () => {
  const { PI_EXIT_PREFIX, PI_NO_RESULT_PREFIX } = await import("./index.ts");
  const mk = (exitCode: number): SandboxHandle =>
    ({ output: async function* () {}, wait: async () => ({ exitCode, oomKilled: false }) }) as unknown as SandboxHandle;
  const run = async (code: number) => {
    const out: any[] = [];
    for await (const e of (await harnessOf().start({ agent: "a", sandbox: mk(code), prompt: "p" })).events()) out.push(e);
    return out;
  };
  const [e143] = await run(143);
  assert.ok(e143.message.startsWith(PI_EXIT_PREFIX + "143") && e143.message.includes("[signal=SIGTERM]"));
  const [e0] = await run(0);
  assert.ok(e0.message.startsWith(PI_NO_RESULT_PREFIX));
});

test("adapter: every EXIT_SIGNALS code is labelled with its signal; unknown and zero codes carry no signal label", async () => {
  const mk = (exitCode: number): SandboxHandle =>
    ({ output: async function* () {}, wait: async () => ({ exitCode, oomKilled: false }) }) as unknown as SandboxHandle;
  const msg = async (code: number): Promise<string> => {
    for await (const e of (await harnessOf().start({ agent: "a", sandbox: mk(code), prompt: "p" })).events()) return (e as any).message;
    throw new Error("no event");
  };
  const entries = Object.entries(EXIT_SIGNALS);
  assert.ok(entries.length >= 4);
  for (const [code, name] of entries) assert.ok((await msg(Number(code))).includes(`[signal=${name}]`), `exit ${code}`);
  for (const code of [0, 1, 3, 139, 200]) assert.ok(!(await msg(code)).includes("[signal="), `exit ${code}`);
});

test("guide: interrupt guidance", async () => {
  const { readFileSync } = await import("node:fs");
  const g = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");
  assert.match(g, /## Interrupts/);
  assert.match(g, /Never retry `pomtree yield`/);
});

test("guide: spawn flags for agents; --from-commit/--session are operator-only", () => {
  const g = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");
  assert.match(g, /Spawn flags for agents/);
  assert.match(g, /Do not pass\s+`--from-commit` or `--session`/);
  assert.match(g, /repository's HEAD/);
});

test("guide: the What exists today command list names the state verbs the Durable state section documents", () => {
  const g = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");
  const list = g.slice(g.indexOf("## What exists today"), g.indexOf("## Who you are"));
  const durable = g.slice(g.indexOf("## Durable state"), g.indexOf("## Background jobs"));
  assert.match(list, /`pomtree state ls\|show\|put\|export\|import\|rm`/);
  for (const verb of ["ls", "show", "put", "export", "import", "rm"]) {
    assert.match(durable, new RegExp(`pomtree state ${verb}\\b`), verb);
    assert.match(list, new RegExp(`\\b${verb}\\b`), verb);
  }
});

test("guide: recipes section covers the common agent tasks", () => {
  const g = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");
  assert.match(g, /## Recipes/);
  for (const re of [
    /pomtree report publish/,
    /pomtree result --status succeeded/,
    /pomtree pull --from/,
    /--key child-/,
    /pomtree ask "/,
    /pomtree send <ID>/,
    /pomtree yield --until timer:/,
    /pomtree ext search/,
    /pomtree ext fetch/,
    /pomtree budget/,
    /pomtree whoami/,
    /nohup/,
  ]) {
    assert.match(g, re);
  }
});

// The daemon's interrupt backstop (Lifecycle.armInterrupt) kills the sandbox and calls session.stop() so the event stream ends
// even if the kill is slow or fails: stop() must end events() while the container lives (YLD-4 flake lead).
test("adapter: session.stop() ends events() while the container is still alive", async () => {
  let parked = false;
  const sleep = (ms: number) => (parked ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, ms)));
  const alive: SandboxHandle = { id: "sb", async *output() {}, wait: () => new Promise(() => {}) }; // never exits: the kill failed
  const h = createPiHarness({ sink: () => sinkOf([j({ type: "agent_settled" }) + "\n"]), sleep, sinkPollMs: 5 });
  const s = await h.start({ agent: "a", sandbox: alive, prompt: "p" });
  const it = s.events()[Symbol.asyncIterator]();
  assert.equal((await it.next()).value?.kind, "settled");
  await s.stop();
  const end = await Promise.race([it.next(), new Promise<"hung">((r) => setTimeout(() => r("hung"), 200))]);
  parked = true; // park the tail loop so a hung stream leaves no timer behind
  assert.notEqual(end, "hung", "events() must end after stop()");
  assert.equal((end as IteratorResult<unknown>).done, true);
});

// An unsettled run (the interrupt case: Pi aborted mid-turn and stays open) also ends on stop(), after draining what the sink
// already holds, with no exit-classification error (the container never exited; the daemon classifies it in settle).
test("adapter: stop() before the turn settles drains the sink and ends events() with no exit error", async () => {
  let parked = false;
  const sleep = (ms: number) => (parked ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, ms)));
  const alive: SandboxHandle = { id: "sb", async *output() {}, wait: () => new Promise(() => {}) };
  const h = createPiHarness({ sink: () => sinkOf([j({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" }) + "\n"]), sleep, sinkPollMs: 5 });
  const s = await h.start({ agent: "a", sandbox: alive, prompt: "p" });
  await s.stop(); // before events() is even read, as the daemon does for a run cancelled during start
  const got: string[] = [];
  const drained = (async () => {
    for await (const e of s.events()) got.push(e.kind);
    return "done";
  })();
  const end = await Promise.race([drained, new Promise<"hung">((r) => setTimeout(() => r("hung"), 200))]);
  parked = true;
  assert.equal(end, "done", "events() must end after stop()");
  assert.ok(!got.includes("error"), `no exit error for a stopped session: ${got.join(",")}`);
  assert.ok(got.length > 0, "records written before the stop are still delivered");
});
