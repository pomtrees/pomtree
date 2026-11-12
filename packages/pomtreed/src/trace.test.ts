import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalEntry, JournalPayload } from "@pomtree/core";
import { providerExhaustedMessage, providerStopMessage } from "./daemon/lifecycle.ts";
import { encodeGatewayCredential } from "@pomtree/core";
import { issueToken } from "./auth.ts";
import { spawnedPayload } from "./daemon-util.ts";
import { DEFAULT_MAX_BYTES, formatTrace, redact, relTime, stripTerminal, truncate } from "./trace.ts";
import type { TraceInput } from "./trace.ts";
import { SECRET, op } from "./test-setup.ts";

const T0 = 1_700_000_000_000;
const agent: AgentRecord = {
  id: "a-1",
  parent: "root",
  name: "worker",
  task: "do the thing",
  state: "exited",
  exit: "failed",
  exitCause: "provider_error",
  result: null,
  host: "h1",
  generation: 2,
  sandbox: null,
  sandboxBackend: null,
  budgetMicros: 5_000_000,
  createdAt: T0,
  updatedAt: T0 + 90_000,
  executor: "container",
  spec: {
    image: "pomtree/agent:abc",
    envManifestHash: null,
    extensions: [],
    provider: "anthropic",
    model: "sonnet",
    systemPrompt: null,
    egress: { mode: "none" } as never,
  },
};
let seq = 0;
const ev = (dtMs: number, payload: JournalPayload | Record<string, unknown>, a = "a-1"): JournalEntry => ({
  seq: ++seq,
  ts: T0 + dtMs,
  agent: a,
  host: "h1",
  generation: 1,
  payload: payload as JournalPayload,
});
const facts = {
  now: T0 + 100_000,
  node: "v24",
  platform: "linux/x64",
  gitSha: "abc1234",
  hostId: "h1",
  endpoint: { bind: ["0.0.0.0:7000"], containerReachable: true, hostProbe: true },
  image: "img:1",
  steerExt: true,
  jobsExt: false,
  waitYieldMs: 20000,
};
const base = (events: JournalEntry[], extra: Partial<TraceInput> = {}): TraceInput => ({
  agent,
  events,
  spentMicros: 1_234_500,
  remainingMicros: 3_000_000,
  children: [{ id: "c-1", name: "kid", state: "exited", exit: "succeeded" }],
  parentName: "root",
  facts,
  ...extra,
});

function allKinds(): JournalEntry[] {
  seq = 0;
  return [
    // The spawned entry as production writes it (spawnedPayload); the real-spawn header test is in api.errors.test.ts.
    ev(0, spawnedPayload({ ...agent, spec: { ...(agent.spec as object), template: "tpl1" } } as AgentRecord)),
    ev(500, { kind: "ext.pomtreed.deadline", at: T0 + 600_000 }),
    ev(1000, { kind: "started" }),
    ev(2000, { kind: "message", role: "user", text: "hello ```fence``` inside" }),
    ev(3000, { kind: "usage", inputTokens: 10, outputTokens: 5, costMicros: 100 }),
    ev(4000, { kind: "message", role: "assistant", text: "thinking" }),
    ev(5000, { kind: "tool_call", tool: "bash", callId: "c1", input: { cmd: "ls" } }),
    ev(6000, { kind: "tool_result", callId: "c1", ok: true, output: "file1" }),
    ev(7000, { kind: "tool_call", tool: "bash", callId: "c2", input: { cmd: "false" } }),
    ev(8000, { kind: "tool_result", callId: "c2", ok: false, output: "boom" }),
    ev(8500, { kind: "tool_result", callId: "orphan", ok: true, output: "stray" }),
    ev(9000, { kind: "error", message: "harness blew up" }),
    ev(10_000, { kind: "provider_error", code: "rate_limit", message: "429", retryable: true }),
    ev(11_000, { kind: "signal", signal: { kind: "message", from: "root", body: "psst" } }),
    ev(12_000, { kind: "escalation_raised", escalation: "es-1", question: "which?" }),
    ev(13_000, { kind: "escalation_answered", escalation: "es-1", answeredBy: { channel: "discord", sender: "bob" }, answer: "left" }),
    ev(14_000, { kind: "message_sent", channel: "discord", purpose: "ask", subject: "which?" }),
    ev(15_000, { kind: "message_received", channel: "operator", from: { channel: "operator", sender: "op" }, to: "a-1", body: "stop", interrupt: true }),
    ev(16_000, { kind: "ext.pomtreed.approval", approval: "ap1", action: "publish", state: "approved" }),
    ev(18_000, { kind: "ext.pomtreed.merge_skipped", child: "c-1", exit: "failed" }),
    ev(19_000, { kind: "merge_failed", child: "c-1", code: "conflict", message: "conflict in x" }),
    ev(20_000, { kind: "yielded" }),
    ev(21_000, { kind: "resumed" }),
    ev(22_000, { kind: "host_error", component: "sandbox", message: "docker down" }),
    ev(23_000, { kind: "ext.pomtreed.host_health", ok: true, sweepsStale: false }),
    ev(24_000, { kind: "proxy_call", extension: "web_fetch", callId: "x1", input: { url: "u" } }),
    ev(25_000, { kind: "proxy_result", callId: "x1", ok: false, denied: true, reason: "egress" }),
    ev(26_000, { kind: "report_published", report: "r", name: "rep", sizeBytes: 9 }),
    ev(27_000, { kind: "exited", exit: "failed", cause: "provider_error" }),
  ];
}

test("header carries identity, status, money in $ and µ$, relations, config footer", () => {
  const r = formatTrace(base(allKinds()));
  const t = r.text;
  assert.match(t, /^# Trace: worker \(a-1\)/);
  assert.match(t, /state: exited, exit: failed \(cause: provider_error\)/);
  assert.match(t, /model: anthropic\/sonnet/);
  assert.match(t, /budget: \$5\.00 \(5000000 µ\$\); spent: \$1\.2345 \(1234500 µ\$\); left: \$3\.00 \(3000000 µ\$\)/);
  assert.match(t, /parent: root \(root\)/);
  assert.match(t, /children: c-1 \(kid: exited\/succeeded\)/);
  assert.match(t, /workspace branch: agent\/a-1/);
  assert.match(t, /template: tpl1; deadline: 2023-11-14T22:23:20\.000Z/);
  assert.match(t, /generation: 2; resumes: 1/);
  assert.match(t, /harness image: pomtree\/agent:abc/);
  assert.match(t, /wall duration: 26s/);
  assert.match(t, /redacted: 0 values/);
  assert.match(t, /git abc1234; node v24; linux\/x64/);
  assert.match(
    t,
    /agent endpoint 0\.0\.0\.0:7000 \(container reachable, host probe ok\).*POMTREED_HARNESS_STEER_EXT on; POMTREED_HARNESS_JOBS_EXT off; wait-yield 20000ms/,
  );
});

test("every event kind is rendered chronologically with relative timestamps", () => {
  const t = formatTrace(base(allKinds())).text;
  for (const re of [
    /\+2\.0s #4 \*\*user\*\*/,
    /\*\*assistant\*\*/,
    /tool bash\*\* \(call c1\)[\s\S]*"cmd": "ls"[\s\S]*result ok \(1\.0s later/,
    /result \*\*ERROR\*\* \(1\.0s later[\s\S]*boom/,
    /tool result\*\* \(call orphan\) ok/,
    /\*\*ERROR\*\*\n```\nharness blew up/,
    /PROVIDER ERROR\*\* rate_limit \(retryable\)/,
    /signal \*\*message\*\*: .*psst/,
    /\*\*ask\*\* es-1/,
    /\*\*answer\*\* es-1 by discord:bob/,
    /message sent → discord \(ask\)/,
    /message from operator:op \*\*\(interrupt\)\*\*/,
    /ext\.pomtreed\.approval .*publish/,
    /ext\.pomtreed\.merge_skipped/,
    /MERGE FAILED\*\* child c-1 \(conflict\)/,
    /\*\*yielded\*\*/,
    /\*\*resumed\*\*/,
    /HOST ERROR\*\* sandbox/,
    /ext call web_fetch/,
    /ext result \(x1\) \*\*ERROR\*\* denied: egress/,
    /report published: rep/,
    /\*\*exited failed\*\* \(cause: provider_error\)/,
    /usage ×1: 10 in \/ 5 out tokens/,
    /1 routine host_health ok rows not shown/,
  ])
    assert.match(t, re);
  // paired result is not repeated standalone
  assert.equal((t.match(/call c1/g) ?? []).length, 1);
  // fence longer than backticks inside the text
  assert.match(t, /````\nhello ```fence``` inside\n````/);
  const order = ["spawned", "**started**", "thinking", "harness blew up", "**exited failed**"].map((s) => t.indexOf(s));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
});

test("usage rows collapse into one line per group", () => {
  seq = 0;
  const evs = Array.from({ length: 25 }, (_, i) => ev(i * 100, { kind: "usage", inputTokens: 1, outputTokens: 2, costMicros: 10 }));
  const t = formatTrace(base(evs)).text;
  assert.deepEqual(t.match(/usage ×\d+/g), ["usage ×10", "usage ×10", "usage ×5"]);
});

test("an unpriced (null-cost) usage event reads as unknown or a lower bound, never as $0", () => {
  seq = 0;
  const unpriced = { kind: "usage", inputTokens: 1, outputTokens: 2, costMicros: null };
  const allNull = formatTrace(base([ev(0, unpriced), ev(1, unpriced)])).text;
  assert.match(allNull, /journaled cost unknown/);
  assert.match(allNull, /usage ×2: 2 in \/ 4 out tokens, unknown/);
  const mixed = formatTrace(base([ev(0, { ...unpriced, costMicros: 10 }), ev(1, unpriced)])).text;
  assert.match(mixed, /journaled cost >=\S+ \(10 µ\$\), 1 unpriced/);
  assert.match(mixed, /usage ×2: 2 in \/ 4 out tokens, >=\S+ \(10 µ\$\), 1 unpriced/);
  const priced = formatTrace(base([ev(0, { ...unpriced, costMicros: 0 })])).text;
  assert.match(priced, /journaled cost \S+ \(0 µ\$\)\n/, "a known zero stays a priced $0");
});

test("tool input and output are truncated at ~4KB with an omission marker", () => {
  seq = 0;
  const big = "x".repeat(20_000);
  const evs = [
    ev(0, { kind: "tool_call", tool: "bash", callId: "c", input: { cmd: big } }),
    ev(1, { kind: "tool_result", callId: "c", ok: true, output: `HEAD${big}TAIL` }),
  ];
  const t = formatTrace(base(evs)).text;
  assert.match(t, /bytes omitted/);
  assert.match(t, /… \d+ bytes omitted …/);
  assert.match(t, /HEAD/);
  assert.match(t, /TAIL/);
  assert.ok(t.length < 12_000, `got ${t.length}`);
  const tr = truncate("é".repeat(5000));
  assert.ok(!tr.includes("\uFFFD"));
});

test("size cap drops middle events keeping head and tail with a marker", () => {
  seq = 0;
  const evs = Array.from({ length: 400 }, (_, i) => ev(i * 1000, { kind: "message", role: "assistant", text: `msg-${i} ${"y".repeat(500)}` }));
  const r = formatTrace(base(evs), { maxBytes: 30_000 });
  assert.ok(r.bytes <= 33_000, `bytes ${r.bytes}`);
  assert.ok(r.omitted > 100);
  assert.match(r.text, new RegExp(`… ${r.omitted} events omitted \\(#\\d+–#\\d+\\) …`));
  assert.match(r.text, /msg-0 /);
  assert.match(r.text, /msg-399 /);
  assert.ok(!r.text.includes("msg-200 "));
  assert.equal(formatTrace(base(evs.slice(0, 100))).omitted, 0);
  assert.equal(DEFAULT_MAX_BYTES, 200 * 1024);
});

test("short mode keeps header, last 40 events and error events", () => {
  seq = 0;
  const evs: JournalEntry[] = [ev(0, { kind: "error", message: "early failure" })];
  for (let i = 0; i < 100; i++) evs.push(ev(1000 + i, { kind: "message", role: "assistant", text: `m${i}` }));
  const r = formatTrace(base(evs), { short: true });
  assert.match(r.text, /early failure/);
  assert.match(r.text, /m99\b/);
  assert.match(r.text, /m60\b/);
  assert.ok(!/\bm59\b/.test(r.text));
  assert.equal(r.omitted, 60);
  assert.match(r.text, /60 events omitted/);
  assert.match(r.text, /view: SHORT/);
});

test("child traces are appended", () => {
  const r = formatTrace(base([]), {});
  assert.match(r.text, /\(no events\)/);
  const t = formatTrace(base([], { childTraces: [{ id: "c-1", text: "# Trace: kid (c-1)\n- state: exited" }] })).text;
  assert.match(t, /## Child trace: kid \(c-1\)/);
});

test("redaction patterns replace secrets and count them; raw skips", () => {
  const hex = "a1b2".repeat(16);
  const samples: [string, string][] = [
    [`op.${hex}`, "token"],
    [`ag.a-1.2.1700000000000.${hex}`, "token"],
    [`ht.discord.${hex}`, "token"],
    [`ext.web.${hex}`, "token"],
    ["pg1.eyJhZ2VudCI6ImEtMSJ9.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq", "token"],
    ["Bearer abcdef0123456789.xyz", "bearer"],
    ["sk-ant-api03-ABCDEFGHIJKLMNOP", "sk"],
    ["AKIAABCDEFGHIJKLMNOP", "aws"],
    [`ghp_${"A1".repeat(15)}`, "github"],
    ["xoxb-1234567890-abcdefghij", "slack"],
    ["eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", "jwt"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "private-key"],
  ];
  for (const [s, kind] of samples) {
    const r = redact(`x ${s} y`);
    assert.equal(r.count, 1, s);
    assert.equal(r.text, `x [REDACTED:${kind}] y`, s);
  }
  const a = redact(`API_KEY=supersecretvalue12345 and {"password": "hunter2hunter2hunter2"}`);
  assert.equal(a.text, `API_KEY=[REDACTED:secret] and {"password": "[REDACTED:secret]"}`);
  assert.equal(a.count, 2);

  seq = 0;
  const evs = [ev(0, { kind: "message", role: "assistant", text: `key sk-ant-api03-ABCDEFGHIJKLMNOP and op.${hex}` })];
  const red = formatTrace(base(evs));
  assert.ok(!red.text.includes("sk-ant"));
  assert.ok(!red.text.includes(hex));
  assert.equal(red.redacted, 2);
  assert.match(red.text, /redacted: 2 values/);
  const raw = formatTrace(base(evs), { raw: true });
  assert.ok(raw.text.includes("sk-ant-api03-ABCDEFGHIJKLMNOP"));
  assert.match(raw.text, /redacted: NO/);
});

// A new credential prefix must be added to this issuance list, so the class cannot regress silently.
test("every issued credential shape is fully redacted", () => {
  const gateway = encodeGatewayCredential(SECRET, {
    agent: "a-1",
    budgetMicros: 1_000_000,
    expiresAt: T0 + 3_600_000,
    issuedAt: T0,
    id: "cred-1",
    models: ["m-1"],
  });
  const issued = [
    op,
    issueToken(SECRET, { scope: "agent", agent: "a-1", generation: 2, expiry: T0 }),
    issueToken(SECRET, { scope: "host", channel: "discord" }),
    issueToken(SECRET, { scope: "ext", name: "web" }),
    gateway,
  ];
  for (const token of issued) {
    const r = redact(`before ${token} after`);
    assert.equal(r.text, "before [REDACTED:token] after", token.split(".")[0]);
    assert.equal(r.count, 1);
    for (const part of [token, ...token.split(".").slice(1)]) assert.ok(!r.text.includes(part), `${token.split(".")[0]} leaked a segment`);
  }
});

test("a gateway credential whose mac has no digit is still redacted", () => {
  const token = `pg1.eyJhIjoxfQ.${"abcdefghij".repeat(4)}`;
  assert.deepEqual(redact(token), { text: "[REDACTED:token]", count: 1 });
});

test("redaction false-positive sanity", () => {
  for (const s of [
    "ext.pomtreed.escalation_expired",
    "ext.pomtreed.watchdog_restart",
    "tokens: 1234567",
    "max_tokens=4096",
    "the secret is out",
    "inputTokens: 12345678901234567",
    "git sha 0123456789abcdef0123456789abcdef01234567",
    "task-1 and desktop.config",
    "password: [REDACTED:secret]",
    "see https://example.com/a/b?c=d",
    "sk-short",
    "Bearer x",
  ])
    assert.deepEqual(redact(s), { text: s, count: 0 }, s);
});

test("a secret in tool output is redacted before truncation can split it", () => {
  seq = 0;
  const hex = "b1c2".repeat(16);
  const evs = [
    ev(0, { kind: "tool_call", tool: "bash", callId: "c", input: { cmd: "env" } }),
    ev(1, { kind: "tool_result", callId: "c", ok: true, output: `${"z".repeat(2400)} op.${hex}${"z".repeat(9000)}` }),
  ];
  const t = formatTrace(base(evs)).text;
  assert.ok(!t.includes("op.b1c2"));
});

test("deterministic: same input yields identical output", () => {
  const a = formatTrace(base(allKinds()));
  const b = formatTrace(base(allKinds()));
  assert.equal(a.text, b.text);
  assert.equal(relTime(125_000), "+2m05s");
  assert.equal(relTime(3_900_000), "+1h05m");
  assert.equal(relTime(12_000), "+12s");
});

test("a deterministic task has no model, image or workspace lines and names its driver", () => {
  const det: AgentRecord = { ...agent, executor: "deterministic", spec: { driver: "fetch-diff", input: {} } };
  const t = formatTrace({ ...base(allKinds()), agent: det, facts: { ...facts, image: undefined } }).text;
  assert.match(t, /executor: deterministic \(driver fetch-diff\)/);
  assert.doesNotMatch(t, /- model:/);
  assert.doesNotMatch(t, /workspace branch/);
  assert.doesNotMatch(t, /harness image/);
  assert.match(t, /image n\/a/);
});

test("stripTerminal removes ANSI colors, spinner frames, OSC titles/links and other controls; plain text, newline and tab survive", () => {
  const spinner = "\u001b[?25l\r\u001b[2K\u001b[36m⠋\u001b[39m Installing\r\u001b[2K\u001b[36m⠙\u001b[39m Installing\u001b[?25h\n";
  assert.equal(stripTerminal(spinner), "⠋ Installing⠙ Installing\n");
  assert.equal(
    stripTerminal("\u001b]0;evil title\u0007ok \u001b]8;;https://x.example\u001b\\link\u001b]8;;\u001b\\ \u0000\u0008\u007f\u009b31m!"),
    "ok link !",
  );
  const plain = "plain text\twith tab\nand `code` ünïcødé";
  assert.equal(stripTerminal(plain), plain);
});

test("trace event text is rendered without terminal control sequences", () => {
  seq = 0;
  const events = [
    ev(0, { kind: "message", role: "assistant", text: "\u001b[31mred\u001b[0m done\r" }),
    ev(1, { kind: "tool_call", tool: "bash", callId: "c1", input: { cmd: "npm i" } }),
    ev(2, { kind: "tool_result", callId: "c1", ok: true, output: "\u001b[36m⠋\u001b[39m added 3 packages" }),
    ev(3, { kind: "error", message: "\u001b]0;title\u0007boom" }),
  ];
  const t = formatTrace(base(events)).text;
  const controls = [...t].filter((ch) => {
    const c = ch.charCodeAt(0);
    return ch !== "\n" && ch !== "\t" && (c < 0x20 || (c >= 0x7f && c <= 0x9f));
  });
  assert.deepEqual(controls, [], "no control characters reach the trace");
  assert.match(t, /red done/);
  assert.match(t, /⠋ added 3 packages/);
  assert.match(t, /\nboom\n/);
});

test("header says why a terminal agent ended, from the core glossary; a reaped agent also says reaped is a lifecycle state", () => {
  const t = formatTrace(base([])).text;
  assert.match(t, /- ended because: failed: .*cause provider_error: the model provider failed/);
  const timedOut = formatTrace(base([], { agent: { ...agent, exit: "timed_out", exitCause: undefined } })).text;
  assert.match(timedOut, /- ended because: timed_out: its session deadline passed .*respawn it with a longer `--deadline`/);
  assert.doesNotMatch(timedOut, /extend it with/);
  assert.doesNotMatch(timedOut, /lifecycle state/);
  const reaped = formatTrace(base([], { agent: { ...agent, state: "reaped" } })).text;
  assert.match(reaped, /- ended because: .*reaped is a lifecycle state; .*sandbox and clone were removed/);
});

test("negative control: a non-terminal agent gets no ended-because line", () => {
  for (const state of ["pending", "running", "yielded"] as const) {
    const t = formatTrace(base([], { agent: { ...agent, state, exit: null, exitCause: undefined } })).text;
    assert.doesNotMatch(t, /ended because/, state);
  }
});

test("workspace_evicted says the clone was deleted, unpushed work is gone, and how to recover", () => {
  const t = formatTrace(base([ev(1000, { kind: "workspace_evicted", workspace: "ws-1", reason: "disk_pressure" })])).text;
  assert.match(t, /workspace evicted\*\* ws-1 \(disk_pressure\): the clone was deleted and any unpushed work in it is gone/);
  assert.match(t, /`pomtree pull --from a-1`/);
});

test("a key echoed by the provider is redacted when the provider-stop and exhausted entries are rendered", () => {
  const key = `sk-ant-api03-${"A1b2C3d4E5".repeat(4)}`;
  const messages = [providerStopMessage("auth", `Incorrect API key provided: ${key}`), providerExhaustedMessage(3, "outage", `bad ${key}`)];
  // The journal stores the text as written (like provider_error entries); the trace redaction pass is the convention that protects it.
  for (const m of messages) assert.ok(m.includes(key));
  seq = 0;
  const t = formatTrace(base(messages.map((message, i) => ev(i, { kind: "error", message })))).text;
  assert.doesNotMatch(t, /sk-ant-api03/);
  assert.match(t, /\[REDACTED:sk\]/);
  assert.match(formatTrace(base(messages.map((message, i) => ev(i, { kind: "error", message }))), { raw: true }).text, /sk-ant-api03/); // negative control: raw skips it
});
