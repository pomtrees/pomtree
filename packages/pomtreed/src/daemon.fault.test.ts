import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { Daemon } from "./daemon.ts";
import { get, runningAgent, setup, spawnSpec } from "./test-setup.ts";

test("a reconcile tick does not re-resume an agent whose resume is parked in admission (no generation storm)", async () => {
  let gate = false;
  const t = setup(async () => {}, { resourceGate: async () => ({ ok: !gate }) });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );
  gate = true; // admission stalls
  await t.daemon.reconcile();
  const g1 = (await get(t, a.id)).generation;
  await new Promise((r) => setTimeout(r, 20));
  await t.daemon.reconcile();
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).generation, g1, "later ticks skip the in-flight resume");
  await t.daemon.kill(a.id);
  await t.orchestrator.idle();
});

test("probeStore clears the journalFailed latch once a journal write succeeds", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  let fail = false;
  const j = Object.create(raw.journal) as typeof raw.journal;
  j.append = async (e: Parameters<typeof raw.journal.append>[0]) => {
    if (fail) throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    return raw.journal.append(e);
  };
  const d = new Daemon({ ...t.daemon.deps, journal: j, admitRetryMs: 5 });
  const root = await d.root();
  fail = true;
  await d.deps.journal
    .append({ agent: root.id, host: root.host, generation: root.generation, payload: { kind: "error", message: "x" }, idempotencyKey: "x" })
    .catch(() => {});
  await (d as unknown as { record: (r: AgentRecord, p: unknown, k: string) => Promise<unknown> })
    .record(root, { kind: "error", message: "x" }, "k")
    .catch(() => {});
  assert.equal((await d.doctor()).journalFailed, true);
  fail = false;
  await d.probeStore();
  assert.equal((await d.doctor()).journalFailed, false, "latch cleared by the probe");
});

test("reconcile wakes a yielded agent whose message was queued but never woken (lost wake)", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const root = await t.daemon.root();
  // The crash window: mailbox write landed, orchestrator.wake never ran.
  await t.daemon.deps.mailbox.send(aId, { kind: "message", from: root.id, body: "hi" }, "lost-wake-1");
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded", "still parked: wake was lost");
  await t.daemon.reconcile();
  await t.orchestrator.idle();
  assert.ok(
    (await t.journal.read({ agent: aId })).some((e) => e.payload.kind === "resumed"),
    "reconcile resumed it",
  );
});

// --- trust and review regressions ---
import { approvalIdFor } from "./approvals.ts";
import { parseTranscript } from "./transcript.ts";
import { clipText } from "./daemon-util.ts";

const apprSetup = (over: Record<string, unknown> = {}) => {
  const t = setup(async () => {}, { messagingChannels: ["discord"], escalationChannels: ["discord"], approvalWaitMs: 20, approvalTimeoutMs: 60_000, ...over });
  t.daemon.deps.approvals = t.fakes.approvals;
  return t;
};
const status = (s: number) => (e: { status?: number }) => e.status === s;

test("approval is bound to the target: the same key with a different target does not reuse an earlier approval", async () => {
  const t = apprSetup();
  const a = await runningAgent(t, "a");
  await assert.rejects(t.daemon.requireApproval(a, "publish", "agent/x->origin/main", "K"), status(409));
  await t.daemon.decideApproval(approvalIdFor(a.id, "publish", "agent/x->origin/main", "K"), "approve", "op", "", "d1");
  await t.daemon.requireApproval(a, "publish", "agent/x->origin/main", "K"); // approved target passes
  await assert.rejects(t.daemon.requireApproval(a, "publish", "agent/x->origin/evil", "K"), status(409), "different target needs its own approval");
});

test("decideApproval: a second decision with another key is 409, a replay of the settling decision is not", async () => {
  const t = apprSetup();
  const a = await runningAgent(t, "a");
  await assert.rejects(t.daemon.requireApproval(a, "publish", "T", "K"), status(409));
  const id = approvalIdFor(a.id, "publish", "T", "K");
  await t.daemon.decideApproval(id, "approve", "op", "", "d1");
  assert.equal((await t.daemon.decideApproval(id, "approve", "op", "", "d1b")).state, "approved", "same who+decision replays");
  await assert.rejects(t.daemon.decideApproval(id, "deny", "op2", "", "d2"), status(409));
});

test("publish pins the approved sha: the approval names it and push receives that sha, not the branch", async () => {
  const pushed: Array<[string, string, string]> = [];
  const t = apprSetup({
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: true,
      resolve: async () => ({ sha: "a".repeat(40), summary: "2 files changed", paths: [], exclude: [] }),
      push: async (_agent: string, b: string, tg: string, sha: string) => void pushed.push([b, tg, sha]),
    },
  });
  const a = await runningAgent(t, "a");
  await assert.rejects(t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "p1" }), status(409));
  const pend = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
  assert.match(pend.action.target, /@aaaaaaaaaaaa->origin\/main \(2 files changed\)/);
  await t.daemon.decideApproval(pend.id, "approve", "op", "", "d1");
  await t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "p1" });
  assert.deepEqual(pushed, [[`agent/${a.id}`, "origin/main", "a".repeat(40)]]);
});

test("ask text is control-stripped and capped with a marker before it reaches the escalation channel", async () => {
  const t = setup(async () => {}, { messagingChannels: ["discord"], escalationChannels: ["discord"] });
  const a = await runningAgent(t, "a");
  const long = `hi\u0007${"x".repeat(5000)}`;
  const { escalation } = await t.daemon.ask(a.id, {
    question: long,
    options: Array.from({ length: 30 }, () => "o".repeat(500)),
    generation: a.generation,
    idempotencyKey: "q1",
  });
  assert.ok(escalation.question.length < 2100 && escalation.question.includes("[truncated"), "capped with marker");
  assert.ok(!escalation.question.includes("\u0007"), "control chars stripped");
  assert.equal(escalation.options.length, 10);
  assert.equal(clipText("short", 10), "short");
});

test("messageFailed dedupes per channel and normalizes purpose/lengths; inbound receipts are scoped by channel", async () => {
  const t = setup(async () => {}, { messagingChannels: ["discord", "slack"], escalationChannels: ["discord"] });
  const root = await t.daemon.root();
  const f = { purpose: "alert" as const, subject: "s".repeat(900), reason: "r", idempotencyKey: "same" };
  await t.daemon.messageFailed({ ...f, channel: "discord" });
  await t.daemon.messageFailed({ ...f, channel: "slack" });
  await t.daemon.messageFailed({ ...f, channel: "slack", purpose: "bogus" as never });
  const ev = (await t.journal.read({ agent: root.id })).filter((e) => e.payload.kind === "message_failed");
  assert.equal(ev.length, 2, "one per channel, replay deduped");
  assert.ok((ev[0]!.payload as { subject: string }).subject.length < 600);
  const a = await runningAgent(t, "a");
  const base = { sender: { channel: "x", sender: "op" }, to: a.id, body: "status", idempotencyKey: "dup" };
  const r1 = await t.daemon.receiveMessage({ ...base, channel: "discord", sender: { channel: "discord", sender: "op" } });
  const r2 = await t.daemon.receiveMessage({ ...base, channel: "slack", sender: { channel: "slack", sender: "op" } });
  assert.notEqual(r1, r2, "channel B does not get channel A's cached receipt object");
});

test("parseTranscript keeps a complete final line without a trailing newline and still drops a torn one", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.equal(parseTranscript(enc('{"a":1}\n{"b":2}')).entries.length, 2);
  const torn = parseTranscript(enc('{"a":1}\n{"b":'));
  assert.equal(torn.entries.length, 1);
  assert.equal(torn.skipped, 0);
});
