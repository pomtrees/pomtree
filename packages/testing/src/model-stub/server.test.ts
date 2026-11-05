import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ModelScript, RecordedCall } from "./script.ts";
import { describeCall, FakeModelUpstream, unmatchedLine } from "./server.ts";

const script: ModelScript = {
  name: "server-test",
  rules: [
    { id: "r429", when: { marker: "429" }, times: 1, reply: { kind: "fault", fault: { type: "status", status: 429, retryAfterS: 3 } } },
    { id: "reset", when: { marker: "reset" }, reply: { kind: "fault", fault: { type: "reset_before_headers" } } },
    { id: "cut", when: { marker: "cut" }, reply: { kind: "fault", fault: { type: "cut_mid_stream", afterChunks: 1 } } },
    { id: "slow", when: { marker: "slow" }, reply: { kind: "fault", fault: { type: "slow_stream", chunkDelayMs: 20, chunks: 3 } } },
    { id: "tool", when: { toolResults: 0, offersTool: "bash" }, reply: { kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "ls" } }] } },
    { id: "done", when: { toolResults: 1, lastTool: "bash" }, reply: { kind: "text", text: "DONE", usage: { input: 11, output: 2, cacheRead: 5 } } },
  ],
};

let up: FakeModelUpstream;
before(async () => {
  up = await FakeModelUpstream.start({ script });
});
after(async () => {
  await up.close();
});

const post = (path: string, body: unknown) =>
  fetch(`${up.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sys = (marker: string) => [
  { role: "system", content: `[[stub:${marker}]]` },
  { role: "user", content: "x" },
];

test("baseUrl is loopback /v1 and GET /models answers", { timeout: 10_000 }, async () => {
  assert.match(up.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  const r = await fetch(`${up.baseUrl}/models`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { object: string }).object, "list");
});

test("stream: tool call, then text after the tool result, with exact usage", { timeout: 10_000 }, async () => {
  const before = up.calls.length;
  const tools = [{ type: "function", function: { name: "bash" } }];
  const r1 = await post("/chat/completions", { model: "m", stream: true, messages: [{ role: "user", content: "go" }], tools });
  assert.equal(r1.headers.get("content-type"), "text/event-stream");
  const t1 = await r1.text();
  assert.match(t1, /"name":"bash"/);
  assert.ok(t1.endsWith("data: [DONE]\n\n"));
  const r2 = await post("/chat/completions", {
    model: "m",
    stream: true,
    tools,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [{ id: "c0", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c0", content: "ok" },
    ],
  });
  const t2 = await r2.text();
  assert.match(t2, /"content":"DONE"/);
  assert.match(t2, /"prompt_tokens":16,"completion_tokens":2,"total_tokens":18,"prompt_tokens_details":\{"cached_tokens":5/);
  const calls = up.calls.slice(before);
  assert.deepEqual(
    calls.map((c) => [c.matched, c.turn, c.toolResults, c.lastTool, c.replyKind, c.path]),
    [
      ["tool", 0, 0, null, "tool_calls", "/v1/chat/completions"],
      ["done", 1, 1, "bash", "text", "/v1/chat/completions"],
    ],
  );
  // Non-stream variant of the same structure.
  const j = await post("/chat/completions", { model: "m", messages: [{ role: "user", content: "go" }], tools });
  const body = (await j.json()) as { choices: { finish_reason: string }[] };
  assert.equal(body.choices[0]?.finish_reason, "tool_calls");
});

test("429 carries retry-after once, then the rule is spent", { timeout: 10_000 }, async () => {
  const r = await post("/chat/completions", { model: "m", stream: true, messages: sys("429") });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "3");
  await r.text();
  const again = await post("/chat/completions", { model: "m", stream: true, messages: sys("429") });
  assert.equal(again.status, 200, "times: 1 → second request falls through to the fallback");
  await again.text();
});

test("reset_before_headers rejects fetch; cut_mid_stream errors the body read", { timeout: 10_000 }, async () => {
  await assert.rejects(post("/chat/completions", { model: "m", stream: true, messages: sys("reset") }));
  const r = await post("/chat/completions", { model: "m", stream: true, messages: sys("cut") });
  assert.equal(r.status, 200);
  await assert.rejects(r.text());
  const j = await post("/chat/completions", { model: "m", messages: sys("cut") });
  await assert.rejects(j.json(), "a non-stream cut drops the socket mid-body");
});

test("slow_stream paces frames", { timeout: 10_000 }, async () => {
  const t0 = Date.now();
  const r = await post("/chat/completions", { model: "m", stream: true, messages: sys("slow") });
  const t = await r.text();
  assert.ok(Date.now() - t0 >= 60, "at least 3 paced gaps");
  assert.ok(t.endsWith("data: [DONE]\n\n"));
});

test("unmatched requests get the fallback and are recorded; anthropic route served; waitForCalls", { timeout: 10_000 }, async () => {
  const n = up.unmatched.length;
  const r = await post("/chat/completions", { model: "zz", stream: true, messages: sys("nothing") });
  assert.match(await r.text(), /STUB-UNMATCHED/);
  assert.equal(up.unmatched.length, n + 1);
  assert.equal(up.unmatched.at(-1)?.model, "zz");
  assert.deepEqual(up.unmatched.at(-1)?.markers, ["nothing"]);
  const a = await post("/messages", { model: "c", stream: true, system: "[[stub:nothing]]", messages: [{ role: "user", content: "x" }] });
  assert.match(await a.text(), /event: message_stop/);
  assert.equal(up.calls.at(-1)?.wire, "anthropic-messages");
  const total = up.calls.length;
  assert.equal((await up.waitForCalls(total, 100)).length, total);
  await assert.rejects(up.waitForCalls(total + 1, 50), /waited 50ms/);
  assert.equal((await fetch(`${up.baseUrl}/nope`, { method: "POST" })).status, 404);
});

test("the unmatched line names the model and the quoted head of the last user text on one line", { timeout: 10_000 }, async () => {
  const long = `wake\n${"y".repeat(200)}`;
  const r = await post("/chat/completions", { model: "zz", stream: true, messages: [{ role: "user", content: long }] });
  await r.text();
  const line = unmatchedLine(up.unmatched.at(-1) as RecordedCall);
  assert.ok(!line.includes("\n"), "one line");
  assert.match(line, /^fake model: unmatched openai-completions call \d+ model=zz turn=0 /);
  assert.ok(line.endsWith(` lastUser=${JSON.stringify(long.slice(0, 120))}`), line);
  // Negative variant: a request with no user message prints null, not an empty string.
  const none = await post("/chat/completions", { model: "zz", stream: true, messages: [{ role: "system", content: "[[stub:nothing]]" }] });
  await none.text();
  assert.match(unmatchedLine(up.unmatched.at(-1) as RecordedCall), / lastUser=null$/);
});

test("describeCall names the matched rule or UNMATCHED and the same fields as the unmatched line", { timeout: 10_000 }, async () => {
  const r = await post("/chat/completions", { model: "m", stream: true, messages: sys("slow") });
  await r.text();
  const call = up.calls.at(-1) as RecordedCall;
  assert.equal(call.matched, "slow");
  assert.match(describeCall(call), new RegExp(`^${call.index} slow model=m turn=0 toolResults=0 .* markers=slow lastUser="x"$`));
  const miss = up.unmatched.at(-1) as RecordedCall;
  assert.ok(describeCall(miss).startsWith(`${miss.index} UNMATCHED model=zz `), describeCall(miss));
});

test("keyMatched: null when no expected key was configured", { timeout: 10_000 }, async () => {
  const before = up.calls.length;
  await (await post("/chat/completions", { model: "m", messages: sys("none") })).text();
  assert.equal(up.calls[before]?.keyMatched, null);
});

test("keyMatched: true for each accepted header form, false for a wrong or missing key", { timeout: 10_000 }, async () => {
  const key = "expected-key-0123456789";
  const keyed = await FakeModelUpstream.start({ script, expectKey: key });
  try {
    const send = async (path: string, headers: Record<string, string>) => {
      const body =
        path === "/messages"
          ? { model: "m", stream: true, system: "[[stub:x]]", messages: [{ role: "user", content: "x" }] }
          : { model: "m", messages: sys("x") };
      await (
        await fetch(`${keyed.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
      ).text();
    };
    await send("/chat/completions", { authorization: `Bearer ${key}` });
    await send("/messages", { "x-api-key": key });
    await send("/messages", { authorization: `Bearer ${key}` });
    await send("/chat/completions", { authorization: "Bearer wrong" });
    await send("/chat/completions", {});
    await send("/chat/completions", { "x-api-key": key }); // not accepted on the OpenAI wire
    await send("/messages", { "x-api-key": "wrong" });
    await send("/messages", {});
    assert.deepEqual(
      keyed.calls.map((c) => c.keyMatched),
      [true, true, true, false, false, false, false, false],
    );
    assert.equal(JSON.stringify(keyed.calls).includes(key), false, "the recorded calls must not hold the key");
  } finally {
    await keyed.close();
  }
});
