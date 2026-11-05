// S1 crash-recovery and idempotency scenarios on the CLI harness (REC-3, REC-6); REC-4, REC-5, REC-7 are in cli-recovery-*.test.ts.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-recovery-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern 'REC-4' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { agentContainers, docker, showAgent } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import { callReply, SKIP, spawnAgent, sum, TIMEOUT, textReply, untilSettledAndRunning, waitDone, withStack } from "./cli-recovery-support.ts";
import type { AgentJson } from "./cli-scenarios-harness.ts";

// REC-6: a stale-generation writer is refused. `pomtree resume --force` needs a checkpoint, so the agent first yields and is woken (that run is
// generation 2); the container's token is then read, the forced resume bumps the generation, and the old token is replayed from the host.
test("cli recovery REC-6: after resume --force the old generation's token cannot write (refused, generation +1)", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async () => {
  const WAKE = "WAKE-rec6 stay busy";
  const script: ModelScript = {
    name: "rec6",
    rules: [
      { id: "woken", when: { lastUserIncludes: "WAKE-rec6" }, times: 1, reply: callReply("sleep 120; echo never") },
      { id: "yield", when: { toolResults: 0 }, times: 1, reply: callReply("pomtree yield --until message") },
      { id: "rest", when: {}, reply: textReply("STUB-REST") },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:rec6]] park, then stay busy", name: "fenced", budget: 500_000 });
    await s.until("the agent to yield", async () => (await showAgent(s, a.id)).state === "yielded", 120_000);
    const sent = await s.pomtree(["send", a.id, WAKE]);
    assert.equal(sent.code, 0, sent.err);
    await s.until(
      "the woken run to be busy",
      async () => s.stub.calls.filter((c) => c.matched === "woken").length === 1 && (await showAgent(s, a.id)).state === "running",
      120_000,
    );
    await untilSettledAndRunning(s, a.id, 2);
    const before = await showAgent(s, a.id);
    const container = `pomtree-${before.sandbox}`;
    // Read the old credential and endpoint inside this function only; neither is logged, and a failure message names no value.
    const read = async (name: string) => (await docker(["exec", container, "printenv", name])).trim();
    const oldToken = await read("POMTREE_TOKEN");
    const api = await read("POMTREE_API").catch(() => "");
    assert.ok(oldToken.length > 0, "the container must carry a POMTREE_TOKEN");
    assert.match(api, /^http:\/\//, "expected the container to reach pomtreed over an http POMTREE_API (the unix socket mount is a different seam)");
    // From the host the container's gateway address is not routable; the same listener answers on loopback at the same port.
    const url = new URL(api);
    const hostApi = `http://127.0.0.1:${url.port}`;

    const forced = await s.pomtree(["resume", a.id, "--force"]);
    assert.equal(forced.code, 0, `resume --force: exit ${forced.code}: ${forced.err}`);
    await s.until("the generation to increment", async () => (await showAgent(s, a.id)).generation === before.generation + 1, 60_000);
    assert.equal((await showAgent(s, a.id)).generation, before.generation + 1);

    // Replay a mutating call with the old token: the route `pomtree result` uses from inside the container.
    const res = await fetch(`${hostApi}/v1/agents/self/result`, {
      method: "POST",
      headers: { authorization: `Bearer ${oldToken}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "succeeded", result: { summary: "stale writer" }, idempotencyKey: "rec6-replay" }),
    });
    const body = await res.text();
    let code: string | undefined;
    try {
      code = (JSON.parse(body) as { code?: string }).code;
    } catch {
      // not JSON: the status assertion below prints the body
    }
    assert.equal((await s.kinds(a.id, POMTREED_KINDS.result)).length, 0, "the stale write must not record a result");
    assert.equal(res.status, 409, `expected the stale token refused with 409 stale_generation, got ${res.status} (code ${code}): ${body.slice(0, 300)}`);
    assert.equal(code, "stale_generation");
    assert.equal((await showAgent(s, a.id)).generation, before.generation + 1, "the refused write must not change the generation");
  });
});

// REC-3: idempotent retries through the CLI. Spawn, send and reap with a key are replay-safe; an unkeyed send is a new delivery each time
// (current behavior: the CLI issues a fresh key per invocation, so two intentional identical sends must not dedupe).
test("cli recovery REC-3: keyed spawn, send and reap replay to one effect; unkeyed sends are two deliveries", { skip: SKIP, timeout: TIMEOUT }, async () => {
  const script: ModelScript = {
    name: "rec3",
    rules: [
      { id: "busy", when: { toolResults: 0 }, times: 1, reply: callReply(holdUntilReleased("echo busy-done")) },
      { id: "result", when: { toolResults: 1 }, times: 1, reply: callReply("pomtree result --summary 'idempotent'") },
      { id: "late-signal", when: { lastUserIncludes: "[pomtree]" }, reply: textReply("STUB-LATE-SIGNAL") },
      { id: "done", when: {}, reply: textReply("STUB-DONE") },
    ],
  };
  await withStack({ script }, async (s) => {
    const budget = 500_000;
    const first = await spawnAgent(s, { task: "[[scn:rec3]] go", name: "keyed", budget, key: "k1" });
    const second = await spawnAgent(s, { task: "[[scn:rec3]] go", name: "keyed", budget, key: "k1" });
    assert.equal(second.id, first.id, "the same spawn key must return the same agent");
    const other = await s.pomtree(["--json", "ps"]);
    assert.equal(other.json<AgentJson[]>().filter((x) => x.parent !== null).length, 1, "a replayed spawn must not create a second agent");
    await untilSettledAndRunning(s, first.id, 1);
    assert.equal((await agentContainers(first.id)).length, 1, "a replayed spawn must start one container");

    const deliveries = async (body: string) =>
      (await s.events(first.id)).filter((e) => e.payload.kind === "message_received" && e.payload.body === body).length;
    for (const key of ["s1", "s1"]) {
      const r = await s.pomtree(["send", first.id, "keyed-hi", "--key", key]);
      assert.equal(r.code, 0, `send --key ${key}: exit ${r.code}: ${r.err}`);
    }
    for (const _ of [1, 2]) {
      const r = await s.pomtree(["send", first.id, "unkeyed-hi"]);
      assert.equal(r.code, 0, `send (no key): exit ${r.code}: ${r.err}`);
    }
    assert.equal(await deliveries("keyed-hi"), 1, "a keyed send replayed with the same key is delivered once");
    assert.equal(await deliveries("unkeyed-hi"), 2, "two unkeyed sends are two deliveries (current behavior)");

    await release([`pomtree-${(await showAgent(s, first.id)).sandbox}`]);
    const rec = await waitDone(s, first.id);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    const one = await s.pomtree(["reap", first.id, "--key", "r1"]);
    const two = await s.pomtree(["reap", first.id, "--key", "r1"]);
    assert.equal(one.code, 0, `reap: ${one.err}`);
    assert.equal(two.code, 0, `reap replay: ${two.err}`);
    const unused = (r: typeof one) => r.json<{ unusedMicros: number }>().unusedMicros;
    assert.equal(unused(two), unused(one), "a replayed reap must report the same unusedMicros");
    assert.equal(unused(one), budget - sum(await s.settlements(first.id)));
    assert.deepEqual(s.stub.unmatched, []);
  });
});
