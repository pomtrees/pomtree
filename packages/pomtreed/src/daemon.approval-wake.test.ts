import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { setup, until } from "./test-setup.ts";

const FAR = Date.now() + 3_600_000;

test("an approval decision does not wake a yielded container agent whose wait is unsatisfied", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
      aId = c.agent;
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: "y1" });
    },
    { approvalWaitMs: 5, approvalTimeoutMs: 60_000 },
  );
  t.daemon.deps.approvals = t.fakes.approvals;
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(aId)) as AgentRecord).state, "yielded");
  const before = (await t.daemon.get(aId)) as AgentRecord;

  const ap = await (t.daemon as unknown as { openApproval(a: AgentRecord, k: string, target: string, key: string): Promise<{ id: string }> }).openApproval(
    before,
    "publish",
    "x",
    "k1",
  );
  await t.daemon.decideApproval(ap.id, "approve", "op", "ok", "d1");
  await t.orchestrator.idle();

  const after = (await t.daemon.get(aId)) as AgentRecord;
  assert.equal(after.state, "yielded", "an unrelated approval decision must not resume the timer-waiting agent");
  assert.equal(after.generation, before.generation);
});
