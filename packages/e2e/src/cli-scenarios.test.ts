// CLI scenarios: the real pomtreed binary through the real `pomtree` binary, with the model upstream replaced by the scripted fake model
// (@pomtree/testing FakeModelUpstream). Each test starts its own pomtreed on a fresh temp state dir, pointed at its own stub through
// model.baseUrl with the upstream key in a 0600 key file, and drives it only with `pomtree --json ...` subprocesses. Inside the container the
// real Pi runs the real agent image; the scripted replies make Pi call bash, and bash runs `pomtree` with the agent's token. Assertions are on
// pomtree exit codes and JSON, on journal entries `pomtree logs ID --json` prints, and on the stub's recorded calls (every one matched).
// A scenario that pins a known audit bug asserts the CORRECT behavior and carries `todo: "TODO(<tag>)"`; nothing is weakened to pass.
//
// Run: AGENT_IMAGE_TAG=pomtree/agent:smoke-<sha> node packages/agent-image/scripts/build.ts, then
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=pomtree/agent:smoke-<sha> node --test packages/e2e/src/cli-scenarios.test.ts
// The gate is cliScenarioSkip (cli-scenarios-harness.ts), the same as docker-proxy-path.test.ts. Nothing here spends money: the only
// upstream is the loopback stub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { type AgentJson, bash, MODEL, PROVIDER } from "./cli-scenarios-harness.ts";
import { BIG, MODEL_FLAG, reap, SKIP, spawnAgent, sum, TIMEOUT, toolOutputs, waitDone, withStack } from "./cli-scenarios-kit.ts";

// (1) Happy path: spawn -> tool call -> result -> wait -> reap; spend equals the sum of the settlements everywhere it is reported.
test("cli scenario 1: happy path spawn, tool, result, wait, reap; spend is the sum of settlements", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const script: ModelScript = {
    name: "cli-happy",
    rules: [
      { id: "tool", when: { toolResults: 0 }, reply: { kind: "tool_calls", calls: [bash("echo stub-tool-ran")], usage: BIG } },
      { id: "result", when: { toolResults: 1 }, reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'stub happy done'")], usage: BIG } },
      { id: "done", when: { toolResults: 2 }, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
    ],
  };
  await withStack({ script }, async (s) => {
    const budget = 500_000;
    const a = await spawnAgent(s, { task: "[[scn:happy]] run the scripted steps", name: "happy", budget });
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    assert.equal((rec.result as { summary?: string }).summary, "stub happy done");

    const outs = await toolOutputs(s, a.id);
    assert.ok(
      outs.some((o) => o.ok && o.output.includes("stub-tool-ran")),
      JSON.stringify(outs),
    );
    assert.equal((await s.kinds(a.id, POMTREED_KINDS.result)).length, 1);

    const settled = await s.settlements(a.id);
    assert.ok(s.stub.calls.length >= 2, `calls ${s.stub.calls.length}`);
    assert.equal(settled.length, s.stub.calls.length, JSON.stringify(settled));
    assert.ok(
      settled.every((x) => x.settlement === "priced" && x.upstreamStatus === 200 && x.micros > 0),
      JSON.stringify(settled),
    );
    const spent = sum(settled);
    const reaped = await reap(s, a.id);
    assert.equal(reaped.unusedMicros, budget - spent);
    const summary = await s.pomtree(["spend"]);
    assert.equal(summary.code, 0, summary.err);
    assert.equal(summary.json<{ totalSpendMicros: number }>().totalSpendMicros, spent);
    assert.deepEqual(s.debit(a.id), { budget, spent, reserved: 0 });
    assert.deepEqual(
      s.stub.calls.slice(0, 2).map((c) => c.matched),
      ["tool", "result"],
    );
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (3) One upstream 429: exactly one rate_limited settlement and exactly one retry ladder. Today pomtreed yields on the provider_error while
// Pi's own auto-retry stays on (FINDINGS `retry-ladder`): one 429 must cost one extra request and at most one yield, never both ladders.
// On the pinned Pi this passes (FINDINGS `retry-ladder` was SUSPECTED); the diagnostic names the ladder that ran.
test("cli scenario 3: a single 429 yields one rate_limited settlement and runs exactly one retry ladder", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "cli-429",
    rules: [
      { id: "rate-limited", when: { toolResults: 0 }, times: 1, reply: { kind: "fault", fault: { type: "status", status: 429, retryAfterS: 1 } } },
      { id: "result", when: { toolResults: 0 }, reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'after 429'")], usage: BIG } },
      { id: "done", when: { toolResults: 1 }, reply: { kind: "text", text: "STUB-DONE", usage: BIG } },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:r429]] finish", name: "r429", budget: 500_000 });
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    const settled = await s.settlements(a.id);
    const limited = settled.filter((x) => x.errorClass === "rate_limited");
    assert.equal(limited.length, 1, JSON.stringify(settled));
    assert.equal(limited[0]!.settlement, "failed");
    assert.equal(limited[0]!.micros, 0);
    assert.equal(limited[0]!.upstreamStatus, 429);
    assert.equal(s.stub.calls.filter((c) => c.replyKind === "fault:status").length, 1);
    // One ladder: the 429 cost exactly one extra request ("result" served once), and at most one yield/resume cycle.
    assert.equal(s.stub.calls.filter((c) => c.matched === "result").length, 1, JSON.stringify(s.stub.calls.map((c) => c.matched)));
    const yields = (await s.kinds(a.id, "yielded")).length;
    assert.equal(yields, 1, `yields ${yields}, calls ${s.stub.calls.map((c) => c.matched).join(",")}`);
    assert.equal((await s.kinds(a.id, "started")).length + (await s.kinds(a.id, "resumed")).length, 2);
    assert.equal(settled.length, s.stub.calls.length);
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (5) Three text-only replies: three passive settles (nudged twice), then the run fails with cause passive_settle.
test("cli scenario 5: three text-only replies fail the run as passive_settle", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const script: ModelScript = {
    name: "cli-passive",
    rules: [{ id: "chat", when: {}, reply: { kind: "text", text: "just chatting, no tools", usage: BIG } }],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:passive]] do the task", name: "passive", budget: 500_000 });
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "failed");
    assert.equal(rec.exitCause, "passive_settle");
    const passive = (await s.kinds(a.id, POMTREED_KINDS.passiveSettle)).map((e) => e.payload as unknown as { count: number; max: number });
    assert.deepEqual(
      passive.map((p) => [p.count, p.max]),
      [
        [1, 3],
        [2, 3],
        [3, 3],
      ],
    );
    assert.equal(s.stub.calls.length, 3);
    assert.equal((await s.settlements(a.id)).length, 3);
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (6) Parent/child: the parent (template marker `parent`) spawns a child, tries to finish early (refused, exit 5: unreaped child), waits
// for and reaps the child (its unused budget returns), then finishes. The child is told apart by its task text.
test("cli scenario 6: parent/child tree, early result refused with exit 5, reap returns the child's budget", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const CHILD_BUDGET = 200_000;
  const kid = "$(cat /tmp/kid)";
  const script: ModelScript = {
    name: "cli-tree",
    rules: [
      {
        id: "parent-spawn",
        when: { marker: "parent", toolResults: 0 },
        reply: {
          kind: "tool_calls",
          calls: [
            bash(`pomtree spawn --task '[[scn:child]] finish at once' --name kid --budget ${CHILD_BUDGET} --model ${MODEL_FLAG} > /tmp/kid && cat /tmp/kid`),
          ],
          usage: BIG,
        },
      },
      {
        id: "parent-early",
        when: { marker: "parent", toolResults: 1 },
        reply: { kind: "tool_calls", calls: [bash("pomtree result --summary early; echo early-exit=$?")], usage: BIG },
      },
      {
        id: "parent-reap",
        when: { marker: "parent", toolResults: 2 },
        reply: {
          kind: "tool_calls",
          calls: [bash(`for i in 1 2 3 4 5 6 7 8; do pomtree wait ${kid} --timeout 15000 && break; done; echo REAP=$(pomtree --json reap ${kid})`)],
          usage: BIG,
        },
      },
      {
        id: "parent-result",
        when: { marker: "parent", toolResults: 3 },
        reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'parent done'; echo final-exit=$?")], usage: BIG },
      },
      { id: "parent-done", when: { marker: "parent", toolResults: 4 }, reply: { kind: "text", text: "STUB-PARENT-DONE", usage: BIG } },
      {
        id: "child-result",
        when: { lastUserIncludes: "[[scn:child]]", toolResults: 0 },
        reply: { kind: "tool_calls", calls: [bash("pomtree result --summary 'child done'")], usage: BIG },
      },
      { id: "child-done", when: { toolResults: 1 }, reply: { kind: "text", text: "STUB-CHILD-DONE", usage: BIG } },
    ],
  };
  const templates = { "scn-parent": { provider: PROVIDER, model: MODEL, systemPrompt: "Scripted test parent. [[stub:parent]]", egress: { kind: "registry" } } }; // a template without egress denies all
  await withStack({ script, templates }, async (s) => {
    const p = await spawnAgent(s, { task: "[[scn:parent]] run the tree", name: "parent", budget: 1_000_000, template: "scn-parent" });
    const rec = await waitDone(s, p.id, 140_000);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));

    const outs = (await toolOutputs(s, p.id)).map((o) => o.output);
    assert.ok(
      outs.some((o) => o.includes("early-exit=5")),
      `early result was not refused with exit 5: ${JSON.stringify(outs)}`,
    );
    assert.ok(
      outs.some((o) => o.includes("final-exit=0")),
      JSON.stringify(outs),
    );
    const reapLine = outs.flatMap((o) => o.split("\n")).find((l) => l.startsWith("REAP="));
    assert.ok(reapLine, JSON.stringify(outs));
    const reaped = JSON.parse(reapLine.slice("REAP=".length)) as { record: AgentJson; unusedMicros: number };
    assert.equal(reaped.record.state, "reaped");
    assert.equal(reaped.record.exit, "succeeded");
    assert.equal(reaped.record.parent, p.id);
    const childSpent = sum(await s.settlements(reaped.record.id));
    assert.ok(childSpent > 0);
    assert.equal(reaped.unusedMicros, CHILD_BUDGET - childSpent);
    // Exactly one result per agent: the early one was not recorded.
    assert.equal((await s.kinds(p.id, POMTREED_KINDS.result)).length, 1);
    assert.equal(((await s.kinds(p.id, POMTREED_KINDS.result))[0]!.payload.result as { summary: string }).summary, "parent done");
    await reap(s, p.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// (10) Cancel while the model streams slowly: the run ends cancelled and the reservation is released. The partial stream already
// crossed a 2xx, so the provider bills it and the settlement charges it as stream_cut, never as a free failure (stream-cut). The agent
// going away aborts the upstream fetch and settles at once rather than holding the reservation until the stream ends (proxy-abort).
test("cli scenario 10: cancel during a slow stream releases the reservation", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const STREAM_MS = 40_000;
  const script: ModelScript = {
    name: "cli-cancel-slow",
    rules: [{ id: "slow", when: { toolResults: 0 }, reply: { kind: "fault", fault: { type: "slow_stream", chunkDelayMs: 1000, chunks: STREAM_MS / 1000 } } }],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:cancel]] think slowly", name: "slow", budget: 500_000 });
    await s.stub.waitForCalls(1, 120_000);
    await new Promise((r) => setTimeout(r, 3000)); // a few chunks are out: the response is past its 2xx headers
    const c = await s.pomtree(["cancel", a.id]);
    assert.equal(c.code, 0, c.err);
    assert.deepEqual(c.json(), { accepted: true });
    const cancelledAt = Date.now();
    // Timed from the cancel, beside the wait: when the settlement (and with it the reservation release) first shows up.
    let settledAfterMs = Number.POSITIVE_INFINITY;
    const settledWatch = s
      .until(
        "the slow call's settlement",
        async () => {
          const done = (await s.settlements(a.id)).length === 1;
          if (done) settledAfterMs = Date.now() - cancelledAt;
          return done;
        },
        STREAM_MS + 20_000,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "cancelled");
    // Whatever the abort path, the reservation must not outlive the upstream stream.
    const watchError = await settledWatch;
    if (watchError) throw watchError;
    t.diagnostic(`settlement journaled ${settledAfterMs} ms after the cancel (stream length ${STREAM_MS} ms)`);
    await t.test("the cancel aborts the upstream call and settles it within 10 s", () => {
      assert.ok(settledAfterMs <= 10_000, `settled ${settledAfterMs} ms after the cancel`);
    });
    await t.test("no reservation stays open", async () => {
      const d = s.debit(a.id);
      assert.ok(d, "no debit row");
      assert.equal(d.reserved, 0);
      assert.equal(d.spent, sum(await s.settlements(a.id)));
    });
    await t.test("the cut stream is charged, not settled as free", async () => {
      const [x] = await s.settlements(a.id);
      assert.notEqual(x!.settlement, "failed", JSON.stringify(x));
      assert.ok(x!.micros >= 1, JSON.stringify(x));
    });
    await reap(s, a.id);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
