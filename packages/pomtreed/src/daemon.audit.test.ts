import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalIdFor } from "./approvals.ts";
import { runningAgent, setup } from "./test-setup.ts";

const apprSetup = () => {
  const t = setup(async () => {}, { messagingChannels: ["discord"], escalationChannels: ["discord"], approvalWaitMs: 20, approvalTimeoutMs: 60_000 });
  t.daemon.deps.approvals = t.fakes.approvals;
  return t;
};
const status = (s: number) => (e: { status?: number }) => e.status === s;

test("the requester-side approval journal entry carries the requester generation and the action target", async () => {
  const t = apprSetup();
  const a = await runningAgent(t, "a");
  await assert.rejects(t.daemon.requireApproval(a, "publish", "agent/x->origin/main", "K"), status(409));
  await t.daemon.decideApproval(approvalIdFor(a.id, "publish", "agent/x->origin/main", "K"), "approve", "op", "", "d1");
  await t.daemon.requireApproval(a, "publish", "agent/x->origin/main", "K");
  const entry = (await t.journal.read({ agent: a.id })).find(
    (e) => e.payload.kind === "ext.pomtreed.approval" && (e.payload as { state?: string }).state === "approved",
  );
  assert.ok(entry, "approval entry journaled");
  const p = entry!.payload as unknown as Record<string, unknown>;
  assert.equal(p.requester_generation, a.generation);
  assert.equal(p.target, "agent/x->origin/main");
  assert.equal(p.action, "publish");
});

test("a failed audit-relevant journal write is surfaced (fixed log line, host_error) and the operation still completes", async () => {
  const t = apprSetup();
  const raw = t.fakes.hooks.raw;
  const orig = raw.journal.append.bind(raw.journal);
  raw.journal.append = async (e: Parameters<typeof orig>[0]) => {
    if (e.payload.kind === "ext.pomtreed.approval") throw new Error("secret-detail /host/path");
    return orig(e);
  };
  const a = await runningAgent(t, "a");
  await assert.rejects(t.daemon.requireApproval(a, "publish", "T", "K"), status(409));
  await t.daemon.decideApproval(approvalIdFor(a.id, "publish", "T", "K"), "approve", "op", "", "d1");
  const lines: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const ap = await t.daemon.requireApproval(a, "publish", "T", "K"); // the approved action proceeds despite the lost journal entry
    assert.equal(ap.state, "approved");
  } finally {
    console.error = log;
  }
  assert.ok(lines.includes("pomtreed: audit write failed (approval)"), lines.join("|"));
  assert.ok(!lines.some((l) => l.includes("secret-detail")), "no raw error text is logged");
  const es = await t.journal.read({ agent: a.id });
  const he = es.find((e) => e.payload.kind === "host_error");
  assert.deepEqual(he && { ...(he.payload as object) }, { kind: "host_error", component: "journal", message: "audit write failed: approval" });
  assert.ok(!es.some((e) => JSON.stringify(e.payload).includes("secret-detail")));
});
