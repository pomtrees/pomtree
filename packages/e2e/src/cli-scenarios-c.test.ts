// Scenarios 7, 8 and 12 of cli-scenarios.test.ts (same harness and header; split so node --test runs the files in parallel).
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelRefusalCodeIn } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import { type AgentJson, bash } from "./cli-scenarios-harness.ts";
import { BIG, reap, SKIP, spawnAgent, sum, TIMEOUT, toolOutputs, waitDone, withStack } from "./cli-scenarios-kit.ts";

// (7) Yield then wake: the agent parks on `pomtree yield --until message`; an operator message wakes it with a bumped generation.
test("cli scenario 7: yield then wake by message bumps the generation", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const WAKE = "WAKE-91c2 finish now";
  const script: ModelScript = {
    name: "cli-yield",
    rules: [
      {
        id: "woken",
        when: { lastUserIncludes: "WAKE-91c2" },
        times: 1,
        reply: { kind: "tool_calls", calls: [bash("pomtree result --summary woken")], usage: BIG },
      },
      { id: "after-wake", when: { lastUserIncludes: "WAKE-91c2" }, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
      { id: "yield", when: { toolResults: 0 }, times: 1, reply: { kind: "tool_calls", calls: [bash("pomtree yield --until message")], usage: BIG } },
      { id: "parked", when: { toolResults: 1 }, reply: { kind: "text", text: "parked", usage: BIG } },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:yield]] park until told", name: "sleeper", budget: 500_000 });
    let gen = -1;
    await s.until(
      "agent yielded",
      async () => {
        const r = (await s.pomtree(["show", a.id])).json<{ agent: AgentJson }>().agent;
        gen = r.generation;
        return r.state === "yielded";
      },
      120_000,
    );
    const sent = await s.pomtree(["send", a.id, WAKE]);
    assert.equal(sent.code, 0, sent.err);
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    assert.equal(rec.generation, gen + 1);
    assert.equal((await s.kinds(a.id, "yielded")).length, 1);
    assert.equal((await s.kinds(a.id, "resumed")).length, 1);
    assert.equal(s.stub.calls.filter((c) => c.matched === "woken").length, 1);
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (8) A length-truncated reply and a tool call with malformed JSON arguments: both settle priced and the run still finishes.
test("cli scenario 8: length truncation and malformed tool arguments are survivable and priced", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const script: ModelScript = {
    name: "cli-length-badargs",
    rules: [
      // Pi drops a length-stopped assistant message from the next request's context, so the rules count firings, not turns.
      { id: "truncated", when: { toolResults: 0 }, times: 1, reply: { kind: "text", text: "this answer was cut", finish: "length", usage: BIG } },
      { id: "bad-args", when: { toolResults: 0 }, times: 1, reply: { kind: "fault", fault: { type: "malformed_tool_json", name: "bash" } } },
      { id: "result", when: { toolResults: 1 }, reply: { kind: "tool_calls", calls: [bash("pomtree result --summary survived")], usage: BIG } },
      { id: "done", when: {}, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:length]] go", name: "trunc", budget: 500_000 });
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    const settled = await s.settlements(a.id);
    assert.equal(settled[0]?.finishReason, "length", JSON.stringify(settled));
    assert.ok(settled.every((x) => x.settlement === "priced"));
    // The proxy rewrites the call's unparsable arguments to its tagged refusal (model-proxy/tool-args.ts): Pi fails the call before
    // running it, the model reads the cause and action, the settlement is priced and classed, and the journal names the tool.
    await t.test("malformed tool arguments are refused, not executed", async () => {
      const outs = await toolOutputs(s, a.id);
      assert.equal(outs[0]?.ok, false, JSON.stringify(outs));
      assert.equal(modelRefusalCodeIn(outs[0]?.output ?? ""), "malformed_tool_arguments", JSON.stringify(outs));
      assert.match(outs[0]?.output ?? "", /re-issue the call with complete arguments/);
      assert.equal(settled.filter((x) => x.errorClass === "malformed_tool_arguments").length, 1, JSON.stringify(settled));
      const errors = (await s.kinds(a.id, "error")).map((e) => String(e.payload.message));
      assert.ok(
        errors.some((m) => m.includes("call to bash whose arguments were not valid JSON")),
        JSON.stringify(errors),
      );
    });
    assert.deepEqual(
      s.stub.calls.slice(0, 3).map((c) => c.matched),
      ["truncated", "bad-args", "result"],
    );
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (12) pomtreed restarts while the agent runs a tool: the new daemon adopts the container, the run finishes, every model call is settled
// exactly once and nothing stays reserved.
test("cli scenario 12: daemon restart mid-run adopts the agent and settles each call once", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const script: ModelScript = {
    name: "cli-restart",
    rules: [
      { id: "long-tool", when: { toolResults: 0 }, reply: { kind: "tool_calls", calls: [bash(holdUntilReleased("echo after-restart"))], usage: BIG } },
      { id: "result", when: { toolResults: 1 }, reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'survived restart'")], usage: BIG } },
      { id: "done", when: { toolResults: 2 }, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
    ],
  };
  await withStack({ script }, async (s) => {
    // TODO(e2e-time-adopt-exit): an adopted agent whose Pi has finished stays up until the wrap-up deadline (default 30 s after the result, measured
    // ~30 s of the 55 s run), so the test shortens that window with --wrapup 5s; the final reply is settled <1 s after the result.
    const a = await spawnAgent(s, { task: "[[scn:restart]] go", name: "survivor", budget: 500_000, wrapup: "5s" });
    await s.stub.waitForCalls(1, 120_000);
    const sandbox = (await showAgent(s, a.id)).sandbox;
    await s.restart();
    await release([`pomtree-${sandbox}`]);
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    assert.equal((rec.result as { summary?: string }).summary, "survived restart");
    const settled = await s.settlements(a.id);
    assert.equal(new Set(settled.map((x) => x.requestId)).size, settled.length, "a settlement was journaled twice");
    assert.equal(settled.length, s.stub.calls.length);
    assert.deepEqual(s.debit(a.id), { budget: 500_000, spent: sum(settled), reserved: 0 });
    assert.equal(s.stub.calls.filter((c) => c.matched === "long-tool").length, 1, "the tool turn was replayed after the restart");
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
