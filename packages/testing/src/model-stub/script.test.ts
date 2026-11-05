import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import {
  agentIdFrom,
  BUILTIN_SCRIPTS_DIR,
  type Fault,
  loadModelScript,
  markersFrom,
  type ModelScript,
  matchRule,
  type RequestShape,
  recordUse,
  validateModelScript,
} from "./script.ts";
import { shapeOpenAiRequest } from "./wire-openai.ts";

const shape = (over: Partial<RequestShape> = {}): RequestShape => ({
  wire: "openai-completions",
  model: "m",
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
});

const text = (t: string) => ({ kind: "text" as const, text: t });

test("matchRule: first rule in order whose every given field matches", { timeout: 5000 }, () => {
  const script: ModelScript = {
    name: "s",
    rules: [
      { id: "a", when: { turn: 1, lastTool: "bash" }, reply: text("a") },
      { id: "b", when: { offersTool: "bash", marker: "x" }, reply: text("b") },
      { id: "c", when: { agentId: "ag", lastUserIncludes: "STEER" }, reply: text("c") },
      { id: "d", when: { model: "m2", toolResults: 2, lastToolIsError: true }, reply: text("d") },
    ],
  };
  const used = new Map<string, number>();
  assert.equal(matchRule(script, shape({ turn: 1, lastTool: "bash" }), used)?.id, "a");
  // Negative: one mismatched field rejects the rule.
  assert.equal(matchRule(script, shape({ turn: 1, lastTool: "read" }), used), null);
  assert.equal(matchRule(script, shape({ offeredTools: ["read", "bash"], markers: ["x"] }), used)?.id, "b");
  assert.equal(matchRule(script, shape({ offeredTools: ["bash"], markers: ["y"] }), used), null);
  assert.equal(matchRule(script, shape({ agentId: "ag", lastUserText: "please STEER now" }), used)?.id, "c");
  assert.equal(matchRule(script, shape({ agentId: "other", lastUserText: "STEER" }), used), null);
  assert.equal(matchRule(script, shape({ model: "m2", toolResults: 2, lastToolIsError: true }), used)?.id, "d");
  assert.equal(matchRule(script, shape({ model: "m2", toolResults: 2, lastToolIsError: null }), used), null);
});

test("matchRule honours times and is pure (recordUse is the only mutation)", { timeout: 5000 }, () => {
  const script: ModelScript = {
    name: "s",
    rules: [
      { id: "once", when: {}, reply: text("1"), times: 1 },
      { id: "rest", when: {}, reply: text("2") },
    ],
  };
  const used = new Map<string, number>();
  const r1 = matchRule(script, shape(), used);
  assert.equal(r1?.id, "once");
  assert.equal(matchRule(script, shape(), used)?.id, "once", "no mutation without recordUse");
  assert.ok(r1);
  recordUse(used, r1);
  assert.equal(matchRule(script, shape(), used)?.id, "rest");
  assert.equal(matchRule({ name: "e", rules: [] }, shape(), used), null);
});

test("agentIdFrom prefers the header, else the [[agent:<id>]] token; markersFrom dedupes", { timeout: 5000 }, () => {
  assert.equal(agentIdFrom("x [[agent:a1]] y", {}), "a1");
  assert.equal(agentIdFrom("x [[agent:a1]]", { "x-pomtree-agent": "h" }), "h");
  assert.equal(agentIdFrom("no token [[agent:]]", {}), null);
  assert.deepEqual(markersFrom("[[stub:a]] [[stub:b]] [[stub:a]] [[stub: c]]"), ["a", "b"]);
  // Shaped from a real request body: markers only come from the system prompt, not user text.
  const s = shapeOpenAiRequest(
    {
      messages: [
        { role: "system", content: "[[stub:parent]] [[agent:p1]]" },
        { role: "user", content: "[[stub:child]]" },
      ],
    },
    {},
  );
  assert.deepEqual(s.markers, ["parent"]);
  assert.equal(s.agentId, "p1");
});

test("every built-in script loads and validates; bad scripts fail loudly", { timeout: 5000 }, () => {
  const names = readdirSync(BUILTIN_SCRIPTS_DIR).map((f) => f.replace(/\.json$/, ""));
  for (const want of ["happy-tool", "single-429", "passive-settle", "tree", "slow-stream", "steer"])
    assert.ok(names.includes(want), `missing built-in ${want}`);
  for (const n of names) assert.equal(loadModelScript(n).name, n);
  assert.throws(() => loadModelScript("no-such-script"), /cannot read/);
  assert.throws(() => validateModelScript({ name: "x", rules: [{ id: "a", when: { turns: 1 }, reply: text("t") }] }), /unknown match field turns/);
  assert.throws(() => validateModelScript({ name: "x", rules: [{ id: "a", when: {}, reply: { kind: "nope" } }] }), /unknown reply kind/);
  assert.throws(
    () =>
      validateModelScript({
        name: "x",
        rules: [
          { id: "a", when: {}, reply: text("t") },
          { id: "a", when: {}, reply: text("t") },
        ],
      }),
    /duplicate id/,
  );
});

test("script validation rejects an unknown fault type and accepts every Fault member", { timeout: 5000 }, () => {
  const faults: Record<Fault["type"], Fault> = {
    status: { type: "status", status: 429 },
    reset_before_headers: { type: "reset_before_headers" },
    cut_mid_stream: { type: "cut_mid_stream", afterChunks: 1 },
    in_stream_error: { type: "in_stream_error", message: "m" },
    missing_usage: { type: "missing_usage" },
    oversize: { type: "oversize", bytes: 1 },
    slow_stream: { type: "slow_stream", chunkDelayMs: 1, chunks: 1 },
    malformed_tool_json: { type: "malformed_tool_json", name: "bash" },
    empty: { type: "empty" },
    refusal: { type: "refusal" },
  };
  for (const fault of Object.values(faults)) validateModelScript({ name: "x", rules: [{ id: "a", when: {}, reply: { kind: "fault", fault } }] });
  assert.throws(
    () => validateModelScript({ name: "x", rules: [{ id: "a", when: {}, reply: { kind: "fault", fault: { type: "slow_steam" } } }] }),
    /rule a: unknown fault type slow_steam; use one of status, .*refusal/,
  );
  assert.throws(
    () => validateModelScript({ name: "x", rules: [], fallback: { kind: "fault", fault: { type: "bogus" } } }),
    /fallback: unknown fault type bogus/,
  );
});

test("happy-tool script drives one tool call then text by structure", { timeout: 5000 }, () => {
  const s = loadModelScript("happy-tool");
  const used = new Map<string, number>();
  assert.equal(matchRule(s, shape({ offeredTools: ["bash"] }), used)?.reply.kind, "tool_calls");
  assert.equal(matchRule(s, shape({ turn: 1, toolResults: 1, lastTool: "bash", offeredTools: ["bash"] }), used)?.reply.kind, "text");
});
