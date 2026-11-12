// REC-1: an agent adopted after a daemon restart has no drive loop reading the harness events, so the proxy's below-minimum 402
// never reached the budget escalation and the agent stalled silently. The proxy now reports the stall and the daemon escalates it
// through the existing budget_raise approval (docs/economy.md section 13).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JournalEntry } from "@pomtree/core";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const raises = (t: T, id: string) => t.fakes.approvals.list({ requester: id }).then((l) => l.filter((a) => a.action.kind === "budget_raise"));
const escalations = async (t: T, id: string): Promise<JournalEntry[]> =>
  (await t.journal.read({ agent: id })).filter((e) => e.payload.kind === "ext.pomtreed.budget_escalated");

async function adopted() {
  const t = setup(async () => {}, { approvalWaitMs: 5, budgetRaiseMs: 50_000, escAgentMs: 1_000, approvalTimeoutMs: 5_000 });
  t.daemon.deps.approvals = t.fakes.approvals;
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 15_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  const sb = await t.fakes.hooks.raw.sandbox.start(
    { host: "h1", generation: 0, agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
    "sb",
  );
  await reg.setSandbox(a.id, a.generation, sb.id, "sb-set");
  await t.daemon.deps.workspace.create(a.id, {}); // the agent's kept folder, which the yield checkpoints
  await t.daemon.recover();
  await until(async () => t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "attach"));
  return { t, a };
}

test("a stalled adopted agent raises exactly one budget escalation over repeated refused calls, parks, and a grant resumes it", async () => {
  const { t, a } = await adopted();
  await Promise.all([t.daemon.budgetStalled(a.id, 0, 8_381), t.daemon.budgetStalled(a.id, 0, 8_381)]);
  await t.daemon.budgetStalled(a.id, 0, 8_381);
  await until(async () => (await get(t, a.id)).state === "yielded");
  await t.daemon.budgetStalled(a.id, 0, 8_381); // after the park: the agent is no longer live, a no-op
  const aps = await raises(t, a.id);
  assert.equal(aps.length, 1, "one approval for the whole stall");
  const rows = await escalations(t, a.id);
  assert.equal(rows.length, 1, "one escalation row for the whole stall");
  const row = rows[0]!.payload as unknown as { remainingMicros: number; minimumMicros: number; message: string; approval: string };
  assert.equal(row.remainingMicros, 0);
  assert.equal(row.minimumMicros, 8_381);
  assert.equal(
    row.message,
    `${a.id} is out of budget: 0 micro-USD remain after in-flight requests, below the 8381 micro-USD minimum a model call needs, so the model proxy refuses its calls; it is parked behind budget approval ${aps[0]!.id}. Grant more with \`pomtree decide ${aps[0]!.id} approve --grant $USD\` (or deny it to end the agent)`,
  );
  assert.equal((await get(t, a.id)).exit, null, "parked, not exited");
  const before = (await get(t, a.id)).budgetMicros;
  await t.daemon.decideApproval(aps[0]!.id, "approve", "operator", "", "grant-1", { grantMicros: 10_000 });
  await until(async () => (await get(t, a.id)).generation === 1, 5_000);
  assert.equal((await get(t, a.id)).budgetMicros, before + 10_000, "the grant raised the budget, so the next model call can be served");
  await t.orchestrator.idle();
});

test("negative control: a stall report for an agent that is not live (already parked or exited) escalates nothing", async () => {
  const t = setup(async () => {});
  t.daemon.deps.approvals = t.fakes.approvals;
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "a",
  });
  await t.daemon.budgetStalled(a.id, 0, 100);
  assert.equal((await raises(t, a.id)).length, 0);
  assert.equal((await escalations(t, a.id)).length, 0);
});

test("approvals not configured: the stall fails closed visibly, one keyed error row over repeated reports, the agent is left running", async () => {
  const { t, a } = await adopted();
  t.daemon.deps.approvals = undefined;
  await Promise.all([t.daemon.budgetStalled(a.id, 0, 8_381), t.daemon.budgetStalled(a.id, 0, 8_381)]);
  await t.daemon.budgetStalled(a.id, 0, 8_381);
  const rows = (await t.journal.read({ agent: a.id })).filter(
    (e) => e.payload.kind === "error" && String((e.payload as { message: string }).message).includes("out of budget"),
  );
  assert.equal(rows.length, 1);
  assert.equal(
    (rows[0]!.payload as { message: string }).message,
    `${a.id} is out of budget (0 micro-USD remain, below the 8381 micro-USD minimum a model call needs) and approvals are not configured, so a budget stall cannot escalate; configure approvals and restart the daemon, or cancel the agent (\`pomtree cancel ${a.id}\`)`,
  );
  assert.equal((await get(t, a.id)).state, "running");
  assert.equal((await escalations(t, a.id)).length, 0);
});
