// Malformed tool-call arguments: the proxy answers a completed call whose arguments are not a JSON object with a tagged refusal
// in their place (tool-args.ts), on both wires, streamed or not; valid calls pass through byte for byte; the charge still settles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelRefusalCodeIn } from "@pomtree/core";
import { encodeGatewayCredential } from "../gateway.ts";
import { RequestBudget } from "./request-budget.ts";
import { ModelProxy, proxyMetaOf } from "./service.ts";
import type { ProxySettlement } from "./service.ts";
import { malformedToolArgumentsRefusal, refuseMalformedToolCalls, toolArgumentsValid } from "./tool-args.ts";

const BAD = '{"command": "echo';
const GOOD = '{"command": "echo hi"}';
const sseHeaders = new Headers({ "content-type": "text/event-stream" });
const jsonHeaders = new Headers({ "content-type": "application/json" });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const frame = (o: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(o)}\n\n`;

// OpenAI chat-completions SSE: the call's id and name, then its arguments split across two deltas.
function openAiSse(args: string): string {
  const half = Math.ceil(args.length / 2);
  return [
    frame({
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "" } }] } }],
    }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    "data: [DONE]\n\n",
  ].join("");
}
function anthropicSse(args: string): string {
  const half = Math.ceil(args.length / 2);
  return [
    frame({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 1 } } }, "message_start"),
    frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "bash", input: {} } }, "content_block_start"),
    frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, half) } }, "content_block_delta"),
    frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(half) } }, "content_block_delta"),
    frame({ type: "content_block_stop", index: 0 }, "content_block_stop"),
    frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } }, "message_delta"),
    frame({ type: "message_stop" }, "message_stop"),
  ].join("");
}
const openAiJson = (args: string) =>
  JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: args } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });
const anthropicJson = (input: unknown) =>
  JSON.stringify({ id: "msg_1", content: [{ type: "tool_use", id: "t1", name: "bash", input }], usage: { input_tokens: 3, output_tokens: 4 } });

// The arguments text Pi accumulates for each call of a returned SSE body.
function sseArgs(text: string, route: "chat_completions" | "messages"): string[] {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const d = JSON.parse(line.slice(6));
    if (route === "chat_completions")
      for (const c of d.choices ?? [])
        for (const t of c.delta?.tool_calls ?? []) out.set(String(t.index), (out.get(String(t.index)) ?? "") + (t.function?.arguments ?? ""));
    else if (d.type === "content_block_delta" && d.delta?.type === "input_json_delta")
      out.set(String(d.index), (out.get(String(d.index)) ?? "") + d.delta.partial_json);
  }
  return [...out.values()];
}
const isRefusal = (args: string) => {
  const v = JSON.parse(args) as unknown;
  return typeof v === "string" && modelRefusalCodeIn(v) === "malformed_tool_arguments" && v === malformedToolArgumentsRefusal("bash");
};

test("arguments are valid when empty or a JSON object, after the lexical repairs pinned Pi applies; anything else is malformed", () => {
  for (const ok of ["", "  ", "{}", GOOD, '{"command": "printf \'a\nb\'"}', '{"path": "C:\\dir"}']) assert.equal(toolArgumentsValid(ok), true, ok);
  for (const bad of [BAD, "{", '{"a":1', "[1]", '"text"', "null", "42", "not json"]) assert.equal(toolArgumentsValid(bad), false, bad);
});

test("the refusal names the tool, the cause and the action, and carries the malformed_tool_arguments tag", () => {
  const m = malformedToolArgumentsRefusal("bash");
  assert.equal(modelRefusalCodeIn(m), "malformed_tool_arguments");
  assert.match(m, /arguments of this bash tool call were not valid JSON .*did not run it; re-issue the call with complete arguments$/);
});

test("OpenAI streaming: a call whose accumulated arguments do not parse is rewritten to the refusal; other frames are unchanged", () => {
  const r = refuseMalformedToolCalls(enc(openAiSse(BAD)), sseHeaders, "chat_completions");
  assert.ok(r);
  assert.deepEqual(r.refused, ["bash"]);
  const out = dec(r.body);
  const [args] = sseArgs(out, "chat_completions");
  assert.ok(args !== undefined && isRefusal(args), args);
  assert.ok(out.endsWith(`${frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } })}data: [DONE]\n\n`), "usage and [DONE] untouched");
  assert.ok(out.includes('"name":"bash"'), "the call keeps its id and name");
});

test("Anthropic streaming: input_json_delta fragments are judged whole and rewritten; event lines are kept", () => {
  const r = refuseMalformedToolCalls(enc(anthropicSse(BAD)), sseHeaders, "messages");
  assert.ok(r);
  const out = dec(r.body);
  const [args] = sseArgs(out, "messages");
  assert.ok(args !== undefined && isRefusal(args), args);
  assert.equal((out.match(/^event: content_block_delta$/gm) ?? []).length, 2);
  assert.ok(out.includes(frame({ type: "content_block_stop", index: 0 }, "content_block_stop")));
});

test("non-streaming: an OpenAI arguments string that does not parse, or an Anthropic input that is not an object, is replaced", () => {
  const o = refuseMalformedToolCalls(enc(openAiJson(BAD)), jsonHeaders, "chat_completions");
  assert.ok(o);
  assert.ok(isRefusal(JSON.parse(dec(o.body)).choices[0].message.tool_calls[0].function.arguments));
  const a = refuseMalformedToolCalls(enc(anthropicJson("garbled")), jsonHeaders, "messages");
  assert.ok(a);
  assert.equal(JSON.parse(dec(a.body)).content[0].input, malformedToolArgumentsRefusal("bash"));
});

test("negative control: valid, empty and text-only replies on both wires pass through untouched (null)", () => {
  const cases: [string, Headers, "chat_completions" | "messages"][] = [
    [openAiSse(GOOD), sseHeaders, "chat_completions"],
    [openAiSse(""), sseHeaders, "chat_completions"],
    [anthropicSse(GOOD), sseHeaders, "messages"],
    [anthropicSse(""), sseHeaders, "messages"],
    [openAiJson(GOOD), jsonHeaders, "chat_completions"],
    [anthropicJson({ command: "ls" }), jsonHeaders, "messages"],
    [frame({ choices: [{ index: 0, delta: { content: "hi" } }] }), sseHeaders, "chat_completions"],
    ["not json at all", jsonHeaders, "chat_completions"],
  ];
  for (const [body, headers, route] of cases) assert.equal(refuseMalformedToolCalls(enc(body), headers, route), null, body);
  assert.equal(refuseMalformedToolCalls(enc(openAiSse(BAD)), sseHeaders, "other"), null, "other routes are not checked");
});

test("only the malformed call of several is refused, and an Anthropic index reused after its block stopped is a new call", () => {
  const two = [
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: GOOD } }] } }] }),
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "bash", arguments: BAD } }] } }] }),
  ].join("");
  const r = refuseMalformedToolCalls(enc(two), sseHeaders, "chat_completions");
  assert.deepEqual(r?.refused, ["bash"]);
  const [first, second] = sseArgs(dec(r?.body ?? new Uint8Array()), "chat_completions");
  assert.equal(first, GOOD);
  assert.ok(second !== undefined && isRefusal(second));
  const reuse = anthropicSse(GOOD) + anthropicSse(BAD).split("\n\n").slice(1, 5).join("\n\n");
  assert.deepEqual(refuseMalformedToolCalls(enc(`${reuse}\n\n`), sseHeaders, "messages")?.refused, ["bash"]);
});

// Through the proxy: the refused body is what the agent gets, the charge is priced from what the upstream produced, and the
// settlement and access meta carry malformed_tool_arguments; a valid call is forwarded byte for byte with no class.
const secret = "controller-secret";
const key = encodeGatewayCredential(secret, { agent: "agent-1", id: "a".repeat(32), budgetMicros: 1000, expiresAt: 2_000, issuedAt: 1_000, models: ["m"] });
async function viaProxy(upstreamBody: string, path: string, headers: Headers) {
  const events: ProxySettlement[] = [];
  const priced: string[] = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://upstream.example/v1", key: "sk-upstream-0123456789" },
    budget: new RequestBudget({ secret, now: () => 1_000 }),
    maximumRequestMicros: 50,
    price: (body) => {
      priced.push(dec(body));
      return { micros: 7, basis: "catalog" };
    },
    fetch: async () => new Response(upstreamBody, { headers }),
    onSettlement: (e) => events.push(e),
  });
  const r = await proxy.forward({ credential: key, requestId: "r1", path, body: enc('{"model":"m","max_tokens":10}') });
  return { r, events, priced };
}

test("through the proxy, both wires x streamed/not: refused, priced from the upstream's own body, classed malformed_tool_arguments", async () => {
  for (const [body, path, headers] of [
    [openAiSse(BAD), "/chat/completions", sseHeaders],
    [anthropicSse(BAD), "/v1/messages", sseHeaders],
    [openAiJson(BAD), "/chat/completions", jsonHeaders],
    [anthropicJson([1]), "/v1/messages", jsonHeaders],
  ] as const) {
    const { r, events, priced } = await viaProxy(body, path, headers);
    assert.ok("body" in r && r.status === 200, path);
    assert.notEqual(dec(r.body), body, "the agent gets the rewritten body");
    assert.match(dec(r.body), /pomtree-refusal:malformed_tool_arguments/);
    assert.deepEqual(priced, [body], "priced from the bytes the upstream produced");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "priced");
    assert.equal(events[0]?.micros, 7);
    assert.equal(events[0]?.errorClass, "malformed_tool_arguments");
    assert.equal(proxyMetaOf(r)?.errorClass, "malformed_tool_arguments");
  }
});

test("through the proxy, negative control: valid arguments pass byte-identical with no error class", async () => {
  for (const [body, path, headers] of [
    [openAiSse(GOOD), "/chat/completions", sseHeaders],
    [anthropicSse(GOOD), "/v1/messages", sseHeaders],
    [openAiJson(GOOD), "/chat/completions", jsonHeaders],
  ] as const) {
    const { r, events } = await viaProxy(body, path, headers);
    assert.ok("body" in r);
    assert.equal(dec(r.body), body);
    assert.equal(events[0]?.errorClass, undefined);
    assert.equal(proxyMetaOf(r)?.errorClass, undefined);
  }
});
