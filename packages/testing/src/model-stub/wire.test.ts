import assert from "node:assert/strict";
import { test } from "node:test";
import { planResponse } from "./faults.ts";
import type { Fault, Reply, StubUsage } from "./script.ts";
import { buildAnthropicSse, shapeAnthropicRequest } from "./wire-anthropic.ts";
import { buildOpenAiJson, buildOpenAiSse, DONE_FRAME, shapeOpenAiRequest } from "./wire-openai.ts";

const opts = { model: "m", id: "t" };

/** Parsed `data:` payloads of OpenAI SSE frames, excluding [DONE]. */
const payloads = (frames: string[]) => frames.filter((f) => f !== DONE_FRAME).map((f) => JSON.parse(f.replace(/^data: /, "")) as Record<string, unknown>);

const anthropicEvents = (frames: string[]) =>
  frames.map((f) => {
    const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(f);
    assert.ok(m, `bad anthropic frame ${f}`);
    return { event: m[1], data: JSON.parse(m[2] ?? "") as Record<string, unknown> };
  });

test("shapeOpenAiRequest extracts structure: turns, tool results, last tool by call id, tools, user text, max tokens", { timeout: 5000 }, () => {
  const s = shapeOpenAiRequest(
    {
      model: "m",
      stream: true,
      max_completion_tokens: 512,
      messages: [
        { role: "system", content: [{ type: "text", text: "[[stub:k]]" }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "ok" },
        { role: "user", content: [{ type: "text", text: "STEER now" }] },
      ],
      tools: [
        { type: "function", function: { name: "bash" } },
        { type: "function", function: { name: "read" } },
      ],
    },
    {},
  );
  assert.deepEqual(
    { ...s },
    {
      wire: "openai-completions",
      model: "m",
      stream: true,
      turn: 1,
      toolResults: 1,
      lastTool: "bash",
      lastToolIsError: null,
      offeredTools: ["bash", "read"],
      agentId: null,
      markers: ["k"],
      lastUserText: "STEER now",
      maxTokens: 512,
    },
  );
  // Garbage in: a neutral shape, never a throw.
  assert.equal(shapeOpenAiRequest(null, {}).turn, 0);
  assert.equal(shapeOpenAiRequest({ messages: "x", tools: 3 }, {}).offeredTools.length, 0);
});

test("shapeAnthropicRequest reads tool_use ids, is_error, system blocks", { timeout: 5000 }, () => {
  const s = shapeAnthropicRequest(
    {
      model: "c",
      stream: true,
      max_tokens: 100,
      system: [{ type: "text", text: "[[agent:a9]] [[stub:z]]" }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "boom" }] },
      ],
      tools: [{ name: "bash" }],
    },
    {},
  );
  assert.equal(s.turn, 1);
  assert.equal(s.toolResults, 1);
  assert.equal(s.lastTool, "bash");
  assert.equal(s.lastToolIsError, true);
  assert.equal(s.agentId, "a9");
  assert.deepEqual(s.markers, ["z"]);
  assert.equal(s.lastUserText, "go", "a tool_result-only user turn does not replace the last user text");
  assert.equal(s.maxTokens, 100);
});

test("OpenAI SSE text: content, finish, exact usage incl. cache tokens, then [DONE]", { timeout: 5000 }, () => {
  const frames = buildOpenAiSse({ kind: "text", text: "hello", usage: { input: 100, output: 7, cacheRead: 40, cacheWrite: 3 } }, opts);
  assert.equal(frames.at(-1), DONE_FRAME);
  const p = payloads(frames);
  const usage = p.at(-1)?.usage as Record<string, unknown>;
  assert.deepEqual(usage, {
    prompt_tokens: 143,
    completion_tokens: 7,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
  });
  const choices = p.flatMap((x) => (x.choices as { delta: { content?: string }; finish_reason: string | null }[]) ?? []);
  assert.equal(choices.map((c) => c.delta.content ?? "").join(""), "hello");
  assert.equal(choices.at(-1)?.finish_reason, "stop");
  const len = payloads(buildOpenAiSse({ kind: "text", text: "x", finish: "length" }, opts));
  assert.ok(len.some((x) => (x.choices as { finish_reason: string }[])[0]?.finish_reason === "length"));
});

test("OpenAI SSE tool calls: valid JSON args reassembled; finish tool_calls", { timeout: 5000 }, () => {
  const p = payloads(buildOpenAiSse({ kind: "tool_calls", calls: [{ name: "bash", arguments: { command: "ls" } }] }, opts));
  const deltas = p.flatMap((x) => (x.choices as { delta: { tool_calls?: { function: { name?: string; arguments: string } }[] } }[]) ?? []);
  const calls = deltas.flatMap((d) => d.delta.tool_calls ?? []);
  assert.equal(calls[0]?.function.name, "bash");
  assert.deepEqual(JSON.parse(calls.map((c) => c.function.arguments).join("")), { command: "ls" });
});

test("missing_usage: no usage anywhere (negative: a normal reply has one)", { timeout: 5000 }, () => {
  const miss: Reply = { kind: "fault", fault: { type: "missing_usage" } };
  assert.ok(!payloads(buildOpenAiSse(miss, opts)).some((x) => "usage" in x));
  assert.ok(!("usage" in (buildOpenAiJson(miss, opts) as object)));
  assert.ok(!anthropicEvents(buildAnthropicSse(miss, opts)).some((e) => JSON.stringify(e.data).includes('"usage":')));
  assert.ok(payloads(buildOpenAiSse({ kind: "text", text: "x" }, opts)).some((x) => "usage" in x));
  assert.ok("usage" in (buildOpenAiJson({ kind: "text", text: "x" }, opts) as object));
});

test("malformed_tool_json: arguments really fail JSON.parse on every wire", { timeout: 5000 }, () => {
  const bad: Reply = { kind: "fault", fault: { type: "malformed_tool_json", name: "bash" } };
  const args = payloads(buildOpenAiSse(bad, opts))
    .flatMap((x) => (x.choices as { delta: { tool_calls?: { function: { arguments: string } }[] } }[]) ?? [])
    .flatMap((c) => c.delta.tool_calls ?? [])
    .map((c) => c.function.arguments)
    .join("");
  assert.throws(() => JSON.parse(args));
  const msg = (buildOpenAiJson(bad, opts) as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] }).choices[0]?.message;
  assert.throws(() => JSON.parse(msg?.tool_calls[0]?.function.arguments ?? "{}"));
  const partial = anthropicEvents(buildAnthropicSse(bad, opts))
    .map((e) => (e.data.delta as { partial_json?: string } | undefined)?.partial_json ?? "")
    .join("");
  assert.throws(() => JSON.parse(partial));
});

test("in_stream_error: an error frame after content and no [DONE] / message_stop", { timeout: 5000 }, () => {
  const f: Reply = { kind: "fault", fault: { type: "in_stream_error", message: "overloaded" } };
  const o = buildOpenAiSse(f, opts);
  assert.ok(!o.includes(DONE_FRAME));
  assert.deepEqual(payloads(o).at(-1), { error: { message: "overloaded", type: "server_error" } });
  const a = anthropicEvents(buildAnthropicSse(f, opts));
  assert.equal(a.at(-1)?.event, "error");
  assert.ok(!a.some((e) => e.event === "message_stop"));
});

test("empty, refusal, oversize and slow_stream wire output", { timeout: 5000 }, () => {
  const content = (r: Reply) =>
    payloads(buildOpenAiSse(r, opts))
      .flatMap((x) => (x.choices as { delta: { content?: string | null } }[]) ?? [])
      .map((c) => c.delta.content ?? "")
      .join("");
  assert.equal(content({ kind: "fault", fault: { type: "empty" } }), "");
  const refusal = payloads(buildOpenAiSse({ kind: "fault", fault: { type: "refusal", text: "no" } }, opts));
  assert.ok(refusal.some((x) => (x.choices as { delta: { refusal?: string } }[])[0]?.delta.refusal === "no"));
  assert.equal(content({ kind: "fault", fault: { type: "oversize", bytes: 4096 } }).length, 4096);
  const slow = buildOpenAiSse({ kind: "fault", fault: { type: "slow_stream", chunkDelayMs: 1, chunks: 5 } }, opts);
  assert.equal(content({ kind: "fault", fault: { type: "slow_stream", chunkDelayMs: 1, chunks: 5 } }), "sssss");
  assert.ok(slow.length >= 5 + 3);
  const ar = anthropicEvents(buildAnthropicSse({ kind: "fault", fault: { type: "refusal" } }, opts));
  assert.ok(ar.some((e) => (e.data.delta as { stop_reason?: string } | undefined)?.stop_reason === "refusal"));
});

test("Anthropic SSE: usage split across message_start and message_delta, cache fields exact", { timeout: 5000 }, () => {
  const ev = anthropicEvents(buildAnthropicSse({ kind: "text", text: "hi", usage: { input: 50, output: 9, cacheRead: 20, cacheWrite: 4 } }, opts));
  assert.deepEqual(
    ev.map((e) => e.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.deepEqual((ev[0]?.data.message as { usage?: unknown } | undefined)?.usage, {
    input_tokens: 50,
    output_tokens: 1,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 4,
  });
  assert.deepEqual(ev[4]?.data.usage, { output_tokens: 9 });
  const tool = anthropicEvents(buildAnthropicSse({ kind: "tool_calls", calls: [{ name: "bash", arguments: { a: 1 } }] }, opts));
  assert.equal((tool[1]?.data.content_block as { name?: string } | undefined)?.name, "bash");
  assert.deepEqual(JSON.parse((tool[2]?.data.delta as { partial_json?: string } | undefined)?.partial_json ?? ""), { a: 1 });
});

test("planResponse realises every transport fault", { timeout: 5000 }, () => {
  const plan = (fault: Fault, stream = true, wire: "openai-completions" | "anthropic-messages" = "openai-completions") =>
    planResponse({ kind: "fault", fault }, { wire, stream, model: "m", id: "t" });
  const r429 = plan({ type: "status", status: 429, retryAfterS: 2 });
  assert.equal(r429.status, 429);
  assert.equal(r429.headers["retry-after"], "2");
  assert.equal(r429.headers["content-type"], "application/json");
  assert.match(r429.frames[0] ?? "", /429/);
  assert.equal(plan({ type: "status", status: 500 }).headers["retry-after"], undefined);
  assert.equal(plan({ type: "status", status: 401, body: "raw" }).frames[0], "raw");
  assert.match(plan({ type: "status", status: 429 }, true, "anthropic-messages").frames[0] ?? "", /rate_limit_error/);
  assert.equal(plan({ type: "reset_before_headers" }).reset, true);
  assert.equal(plan({ type: "status", status: 502 }).reset, false);
  const cut = plan({ type: "cut_mid_stream", afterChunks: 1 });
  assert.equal(cut.cutAfter, 1);
  assert.ok(cut.frames.length > 1, "a cut plan has frames left unsent");
  const cutJson = plan({ type: "cut_mid_stream", afterChunks: 1 }, false);
  assert.throws(() => JSON.parse(cutJson.frames[0] ?? ""), "a non-stream cut is truncated JSON");
  assert.equal(plan({ type: "slow_stream", chunkDelayMs: 7, chunks: 2 }).chunkDelayMs, 7);
  assert.equal(plan({ type: "empty" }, false).headers["content-type"], "application/json");
  assert.equal(plan({ type: "empty" }).headers["content-type"], "text/event-stream");
  assert.equal(plan({ type: "empty" }, false, "anthropic-messages").status, 400);
});

/** The usage object as it appears on the wire for each of the three emitters, parsed from the emitted text. */
const wireUsages = (usage: StubUsage) => {
  const reply: Reply = { kind: "text", text: "hi", usage };
  const sse = payloads(buildOpenAiSse(reply, opts)).at(-1)?.usage as Record<string, unknown>;
  const json = (JSON.parse(JSON.stringify(buildOpenAiJson(reply, opts))) as { usage: Record<string, unknown> }).usage;
  const first = anthropicEvents(buildAnthropicSse(reply, opts)).at(0);
  assert.ok(first);
  const start = (first.data.message as { usage: Record<string, unknown> }).usage;
  return { sse, json, start };
};

test("usage cost absent: no `cost` key on any wire (negative: presence is by key, not value)", { timeout: 5000 }, () => {
  const u = wireUsages({ input: 5, output: 2 });
  for (const usage of [u.sse, u.json, u.start]) assert.equal("cost" in usage, false);
  assert.equal(u.sse.prompt_tokens, 5);
});

test("usage cost positive number: emitted exactly on OpenAI SSE, OpenAI JSON and Anthropic message_start", { timeout: 5000 }, () => {
  const u = wireUsages({ input: 5, output: 2, cost: 0.000123 });
  assert.equal(u.sse.cost, 0.000123);
  assert.equal(u.json.cost, 0.000123);
  assert.equal(u.start.cost, 0.000123);
});

test("usage cost 0 with nonzero tokens: emitted as 0, not swallowed", { timeout: 5000 }, () => {
  const u = wireUsages({ input: 5, output: 2, cost: 0 });
  for (const usage of [u.sse, u.json, u.start]) {
    assert.equal("cost" in usage, true);
    assert.equal(usage.cost, 0);
  }
});

test("usage cost 0 with zero tokens: emitted as 0 (a genuinely free call)", { timeout: 5000 }, () => {
  const u = wireUsages({ input: 0, output: 0, cost: 0 });
  for (const usage of [u.sse, u.json, u.start]) {
    assert.equal("cost" in usage, true);
    assert.equal(usage.cost, 0);
  }
});

test("usage cost malformed string: emitted verbatim as a JSON string", { timeout: 5000 }, () => {
  const u = wireUsages({ input: 5, output: 2, cost: "0.5" });
  for (const usage of [u.sse, u.json, u.start]) assert.equal(usage.cost, "0.5");
  assert.ok(buildOpenAiSse({ kind: "text", text: "hi", usage: { input: 1, output: 1, cost: "0.5" } }, opts).some((f) => f.includes('"cost":"0.5"')));
});
