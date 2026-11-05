// Daemon behavior for escalations and human wake, approvals, publishing, reconcile placement sync, session integrity and
// metering.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, ExtensionSpec, SandboxSpec } from "@pomtree/core";
import { FakeExtensionGateway, FakeModelDebitStore, FakeModelGateway, FakeRatesSource } from "@pomtree/testing";
import { EXPIRED_ANSWER } from "./daemon.ts";
import { encodeGatewayCredential } from "./gateway.ts";
import { createPrice } from "./model-proxy/price.ts";
import { ModelProxy } from "./model-proxy/service.ts";
import { MODEL_SETTLEMENT_KIND, settlementSink } from "./model-settlement.ts";
import { PublishPinError } from "./publish-pin.ts";
import { get, runningAgent, SECRET, setup, spawnSpec, until } from "./test-setup.ts";
import { DEADLINE_KIND } from "./watchdog.ts";

const fetchSpec = { ...spawnSpec, extensions: ["web_fetch"] };
const specs: ExtensionSpec[] = [{ name: "web_fetch", description: "fetch", inputSchema: { type: "object" }, streaming: false }];

async function yieldedAgent(t: ReturnType<typeof setup>, key: string): Promise<AgentRecord> {
  const a = await runningAgent(t, key);
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: await t.fakes.sessions.put(new TextEncoder().encode(`{"a":1}\n`)),
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 500,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    `${key}-cp`,
  );
  return t.daemon.deps.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: `${key}-y` });
}

test("answering an escalation wakes a yielded asker; a reconcile replay does not wake it again", async () => {
  let wakes = 0;
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes++;
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
    },
    { messagingChannels: ["discord"], escalationChannels: ["discord"] },
  );
  const a = await yieldedAgent(t, "asker");
  const esc = await t.fakes.escalations.create({ id: "es-1", agent: a.id, host: "h1", generation: a.generation, question: "q?", options: [] }, "es-1");
  const answered = await t.daemon.answerEscalation(esc.id, "yes", { channel: "discord", sender: "u1" }, "k1");
  assert.equal(answered.state, "answered");
  await t.orchestrator.idle();
  assert.equal(wakes, 1, "the human answer resumed the yielded asker");
});

test("escalation expiry: an unanswered escalation expires, answers the asker, and a late reply loses", async () => {
  let clock = 1_000_000;
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    askTimeoutMs: 1_000,
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
  });
  const a = await runningAgent(t, "asker");
  const { escalation } = await t.daemon.ask(a.id, { question: "ok?", generation: a.generation, idempotencyKey: "k" });
  assert.deepEqual(await t.daemon.sweepEscalations(), [], "not yet due");
  clock += 2_000;
  assert.deepEqual(await t.daemon.sweepEscalations(), [escalation.id]);
  const done = await t.fakes.escalations.get(escalation.id);
  assert.equal(done?.state, "answered");
  assert.equal(done?.answer, EXPIRED_ANSWER);
  const signals = await t.fakes.mailbox.peek(a.id);
  assert.ok(
    signals.some((s) => s.kind === "human_answer" && s.body === EXPIRED_ANSWER),
    "the asker is told the ask expired",
  );
  const late = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "u" },
    body: "yes",
    replyTo: escalation.id,
    idempotencyKey: "late",
  });
  assert.equal(late.kind, "rejected");
});

test("message authorization: an unauthorized sender is rejected before any rate-limit slot is consumed", async () => {
  const t = setup(async (c) => void (await c.stopped), {
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    authorizeInbound: (m) => m.sender.sender === "good",
  });
  const a = await runningAgent(t, "a");
  for (let i = 0; i < 30; i++) {
    const r = await t.daemon.receiveMessage({
      channel: "discord",
      sender: { channel: "discord", sender: "bad" },
      body: "x",
      to: a.id,
      idempotencyKey: `b${i}`,
    });
    assert.equal(r.kind, "rejected");
  }
  const ok = await t.daemon.receiveMessage({ channel: "discord", sender: { channel: "discord", sender: "good" }, body: "hi", to: a.id, idempotencyKey: "g1" });
  assert.equal(ok.kind, "signaled");
});

test("inbound to a yielded agent waiting on a message wakes it (human-wake)", async () => {
  let wake = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wake = c.wake;
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
    },
    { messagingChannels: ["discord"] },
  );
  const a = await yieldedAgent(t, "y");
  const r = await t.daemon.receiveMessage({ channel: "discord", sender: { channel: "discord", sender: "u" }, body: "wake up", to: a.id, idempotencyKey: "m1" });
  assert.equal(r.kind, "signaled");
  await t.orchestrator.idle();
  assert.equal(wake, "wake up");
});

test("replayed inbound spawn: a replayed completed inbound spawn returns the receipt, not a 409", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } })), {
    messagingChannels: ["discord"],
    messagingAllowSpawn: true,
  });
  const msg = { channel: "discord", sender: { channel: "discord", sender: "u" }, body: "do it", intent: "spawn" as const, idempotencyKey: "sp1" };
  const first = await t.daemon.receiveMessage(msg);
  assert.equal(first.kind, "spawned");
  await t.orchestrator.idle();
  (t.daemon as unknown as { inboundReceipts: Map<string, unknown> }).inboundReceipts.clear(); // a restart forgets the in-memory receipts
  const again = await t.daemon.receiveMessage(msg);
  assert.deepEqual(again, first);
});

test("approvals: a gated extension call is 409 pending, runs after a chat approve, and a deny is 403", async () => {
  const gw = new FakeExtensionGateway(specs);
  const t = setup(async () => {}, {
    extensions: gw,
    messagingChannels: ["discord"],
    escalationChannels: ["discord"],
    extApprovalRequired: () => true,
    approvalWaitMs: 20,
    approvalTimeoutMs: 60_000,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await runningAgent(t, "a", fetchSpec);
  await assert.rejects(t.daemon.extCall(a, "web_fetch", { url: "x" }, "k1"), (e: { status?: number }) => e.status === 409);
  const ask = (await t.daemon.outbox({ channel: "discord" })).find((e) => e.payload.kind === "message_sent")!.payload as { replyTo: string };
  const r = await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "op" },
    body: "approve",
    replyTo: ask.replyTo,
    idempotencyKey: "r1",
  });
  assert.equal(r.kind, "answered");
  const out = await t.daemon.extCall(a, "web_fetch", { url: "x" }, "k1");
  assert.ok(out.callId);
  // deny
  await assert.rejects(t.daemon.extCall(a, "web_fetch", { url: "y" }, "k2"), (e: { status?: number }) => e.status === 409);
  const ask2 = (await t.daemon.outbox({ channel: "discord" })).filter((e) => e.payload.kind === "message_sent").at(-1)!.payload as { replyTo: string };
  await t.daemon.receiveMessage({
    channel: "discord",
    sender: { channel: "discord", sender: "op" },
    body: "deny",
    replyTo: ask2.replyTo,
    idempotencyKey: "r2",
  });
  await assert.rejects(t.daemon.extCall(a, "web_fetch", { url: "y" }, "k2"), (e: { status?: number }) => e.status === 403);
});

test("approvals fail closed: an unanswered approval times out into a denial", async () => {
  let clock = 5_000_000;
  const t = setup(async () => {}, {
    now: () => clock,
    extensions: new FakeExtensionGateway(specs),
    extApprovalRequired: () => true,
    approvalWaitMs: 5,
    approvalTimeoutMs: 1_000,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await runningAgent(t, "a", fetchSpec);
  await assert.rejects(t.daemon.extCall(a, "web_fetch", {}, "k"), (e: { status?: number }) => e.status === 409);
  // Each elapsed rung window advances the ladder (a top-level agent's is operator, owner); past the top it denies.
  for (let i = 0; i < 1; i++) {
    clock += 2_000;
    await assert.rejects(t.daemon.extCall(a, "web_fetch", {}, "k"), (e: { status?: number }) => e.status === 409);
  }
  clock += 2_000;
  await assert.rejects(t.daemon.extCall(a, "web_fetch", {}, "k"), (e: { status?: number }) => e.status === 403);
});

const pin = async (_agent: string, branch: string) => ({ sha: "abc123def456", summary: `1 file changed on ${branch}`, paths: [] });

test("publish: only the agent's own branch to an allowed target; approval-gated; idempotent push of the pinned commit", async () => {
  const pushed: string[] = [];
  const t = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: false,
      resolve: pin,
      push: async (_a, b, tg, sha) => void pushed.push(`${b}->${tg}@${sha}`),
    },
  });
  const a = await runningAgent(t, "a");
  await assert.rejects(
    t.daemon.publish(a.id, { branch: "agent/other", target: "origin/main", idempotencyKey: "k" }),
    (e: { status?: number }) => e.status === 403,
  );
  await assert.rejects(
    t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/evil", idempotencyKey: "k" }),
    (e: { status?: number }) => e.status === 403,
  );
  await t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "k" });
  await t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "k" });
  assert.deepEqual(pushed, [`agent/${a.id}->origin/main@abc123def456`]);
  // gated: without an approval it does not push
  const t2 = setup(async () => {}, {
    publisher: { allowedTargets: ["origin/main"], resolve: pin, push: async () => void pushed.push("gated") },
    approvalWaitMs: 5,
  });
  t2.daemon.deps.approvals = t2.fakes.approvals;
  const b = await runningAgent(t2, "b");
  await assert.rejects(
    t2.daemon.publish(b.id, { branch: `agent/${b.id}`, target: "origin/main", idempotencyKey: "k" }),
    (e: { status?: number }) => e.status === 409,
  );
  assert.ok(!pushed.includes("gated"));
});

test("publish pinned commit: publish refuses an unpinned push (no resolver, an empty pin, or nothing ingested)", async () => {
  const pushed: string[] = [];
  const push = async () => void pushed.push("pushed");
  const req = (id: string) => ({ branch: `agent/${id}`, target: "origin/main", idempotencyKey: "k" });
  // no resolver wired (a type violation, so cast): refused at runtime
  const t1 = setup(async () => {}, { publisher: { allowedTargets: ["origin/main"], requireApproval: false, push } as never });
  const a1 = await runningAgent(t1, "a1");
  await assert.rejects(t1.daemon.publish(a1.id, req(a1.id)), (e: { status?: number }) => e.status === 503);
  // the resolver answers without a commit
  const t2 = setup(async () => {}, {
    publisher: { allowedTargets: ["origin/main"], requireApproval: false, resolve: async () => ({ sha: "", summary: "", paths: [] }), push },
  });
  const a2 = await runningAgent(t2, "a2");
  await assert.rejects(t2.daemon.publish(a2.id, req(a2.id)), (e: { status?: number }) => e.status === 409);
  // the branch was never ingested: the resolver throws
  const t3 = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: false,
      resolve: async () => {
        throw new Error("unknown ref");
      },
      push,
    },
  });
  const a3 = await runningAgent(t3, "a3");
  await assert.rejects(t3.daemon.publish(a3.id, req(a3.id)), (e: { status?: number }) => e.status === 409);
  assert.deepEqual(pushed, []);
});

test("dead-lettered message: a dead-lettered outbound message is journaled once on the root", async () => {
  const t = setup(async () => {});
  const f = { channel: "discord", purpose: "alert" as const, subject: "s", reason: "429", attempts: 3, idempotencyKey: "m1" };
  await t.daemon.messageFailed(f);
  await t.daemon.messageFailed(f);
  const root = await t.daemon.root();
  const failed = (await t.journal.read({ agent: root.id })).filter((e) => e.payload.kind === "message_failed");
  assert.equal(failed.length, 1);
});

test("placement sync: reconcile tells the placement which agents run here", async () => {
  const t = setup(async (c) => void (await c.stopped));
  let seen: string[] = [];
  (t.daemon.deps.placement as { sync?: (ids: string[]) => Promise<void> }).sync = async (ids) => {
    seen = ids;
  };
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).sandbox !== null);
  await t.daemon.reconcile();
  assert.deepEqual(seen, [a.id]);
  await t.daemon.cancel(a.id);
  await t.orchestrator.idle();
});

test("fork: a spawn honors fromCommit and sessionRef (create at the commit + resumed session); an unknown session is 404", async () => {
  let wake = "";
  const t = setup(async (c) => {
    wake = c.wake ?? "";
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
  });
  const ref = await t.fakes.sessions.put(new TextEncoder().encode(`{"type":"session"}\n`));
  const root = await t.daemon.root();
  await assert.rejects(
    t.daemon.spawn(root.id, { name: "f", task: "go", idempotencyKey: "f0", sessionRef: "nope" }),
    (e: { status?: number }) => e.status === 404,
  );
  const a = await t.daemon.spawn(root.id, { name: "f", task: "go", idempotencyKey: "f1", fromCommit: "c1", sessionRef: ref });
  await t.orchestrator.idle();
  assert.equal(wake, "go", "the forked session resumes with the task as its wake text");
  assert.ok(t.fakes.calls.some((c) => c.port === "Workspace" && c.method === "create" && (c.args[1] as { fromCommit?: string }).fromCommit === "c1"));
  assert.equal((await get(t, a.id)).exit, "succeeded");
});

test("idempotency keys on CLI actions: a replayed submitResult/cancel/resume with the same key is not a conflict", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await runningAgent(t, "a");
  const first = await t.daemon.submitResult(a.id, "succeeded", { summary: "r" }, "key-1");
  assert.notEqual(first, "conflict");
  const replay = await t.daemon.submitResult(a.id, "succeeded", { summary: "r" }, "key-1");
  assert.notEqual(replay, "conflict", "same key replays to the current record");
  assert.equal(await t.daemon.submitResult(a.id, "succeeded", { summary: "r" }, "key-2"), "conflict", "a different key is a new (conflicting) op");
});

test("concurrent resume: concurrent resumes of one yielded agent run one generation", async () => {
  let starts = 0;
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      starts++;
      await c.stopped;
    }
  });
  const a = await yieldedAgent(t, "y");
  const [x, y] = await Promise.all([t.daemon.resumeAgent(a.id), t.daemon.resumeAgent(a.id)]);
  assert.equal(x.generation, y.generation);
  await until(async () => starts >= 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(starts, 1);
  await t.daemon.cancel(a.id);
  await t.orchestrator.idle();
});

test("reap: reap never merges a child's branch into its parent", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const p = await runningAgent(t, "p");
  const kid = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: p.id,
    name: "k",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "k",
  });
  await t.daemon.deps.registry.transition(kid.id, kid.generation, "running", { idempotencyKey: "k-run" });
  await t.daemon.deps.registry.transition(kid.id, kid.generation, "exited", { exit: "failed", idempotencyKey: "k-exit" });
  await t.daemon.reap(kid.id);
  assert.ok(!t.fakes.calls.some((c) => c.port === "Workspace" && c.method === "merge"));
});

test("parked-agent deadline: a yielded agent parked past its journaled deadline is finished timed_out by reconcile", async () => {
  let clock = 10_000;
  const t = setup(async () => {}, { now: () => clock });
  const a = await yieldedAgent(t, "y");
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: DEADLINE_KIND, at: 20_000 }, idempotencyKey: "dl" });
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).state, "yielded", "not past the deadline yet");
  clock = 30_000;
  await t.daemon.reconcile();
  assert.equal((await get(t, a.id)).exit, "timed_out");
});

test("orphan adoption: an empty registry beside live containers is not killed without adoptOrphans", async () => {
  const spec = (agent: string): SandboxSpec => ({
    agent,
    image: "img",
    mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/workspace" }],
    env: {},
    labels: { daemon_epoch: "0" },
  });
  const t = setup(async () => {});
  const ghost = await t.fakes.sandbox.start(spec("ghost"), "sb-ghost");
  await t.daemon.recover();
  assert.ok(!t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill" && c.args[0] === ghost.id), "refused to kill");
  const root = await t.daemon.root();
  assert.ok((await t.journal.read({ agent: root.id })).some((e) => e.payload.kind === "host_error"));
  t.daemon.deps.adoptOrphans = true;
  await t.daemon.recover();
  assert.ok(
    t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill" && c.args[0] === ghost.id),
    "killed once the operator opted in",
  );
});

test("session integrity: a corrupt stored session refuses to restore; a torn tail is trimmed at yield", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "c");
  const badRef = await t.fakes.sessions.put(new TextEncoder().encode("not json"));
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: badRef,
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 5,
      imageDigest: "img",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "bad-cp",
  );
  await t.daemon.deps.registry.transition(a.id, a.generation, "yielded", { idempotencyKey: "c-y" });
  await t.daemon.resumeAgent(a.id);
  await t.orchestrator.idle();
  const r = await get(t, a.id);
  assert.equal(r.exit, "failed");
  assert.ok((await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === "error" && /integrity/.test((e.payload as { message: string }).message)));
});

test("metering: a zero-cost usage event is priced from the rate table so the budget cannot fail open", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "m");
  const usage = { kind: "usage" as const, inputTokens: 1_000_000, outputTokens: 500_000, costMicros: 0 };
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: usage, idempotencyKey: "u1" });
  const { ProxyCredentialGateway } = await import("./gateway.ts");
  const base = { journal: t.journal, registry: t.daemon.deps.registry, secret: "s", proxyBaseUrl: "http://m", tokenTtlMs: 60_000 };
  assert.equal((await new ProxyCredentialGateway(base).spend(a.id)).spentMicros, 0, "no table: unchanged");
  const priced = new ProxyCredentialGateway({ ...base, rates: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 } });
  assert.equal((await priced.spend(a.id)).spentMicros, 3_000_000 + 7_500_000);
});

test("usage model: usage events are journaled with the run's model and the catalog price for zero-cost calls", async () => {
  const gateway = new FakeModelGateway();
  gateway.priceUsageResults.push(10_500_000, null); // first zero-cost call priced, second unknown
  const t = setup(
    async (c) => {
      c.emit({ kind: "usage", inputTokens: 1_000_000, outputTokens: 500_000, costMicros: 0 });
      c.emit({ kind: "usage", inputTokens: 7, outputTokens: 3, costMicros: 9 });
      c.emit({ kind: "usage", inputTokens: 5, outputTokens: 5, costMicros: 0 });
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    },
    // No catalog, so the second spawn below stays model-less (the fake gateway issues for it; the real one refuses).
    { gateway, models: undefined },
  );
  const a = await t.spawn("k", { budgetMicros: 1_000, model: { provider: "deepseek", id: "m1" } });
  await t.orchestrator.idle();
  const usages = (await t.journal.read({ agent: a.id })).flatMap((e) => (e.payload.kind === "usage" ? [e.payload] : []));
  assert.deepEqual(
    usages.map((u) => [u.inputTokens, u.costMicros, u.model]),
    [
      [1_000_000, 10_500_000, "m1"], // zero-cost: catalog-priced, model stamped
      [7, 9, "m1"], // provider-priced: untouched except the stamp
      [5, 0, "m1"], // no catalog price (gateway returned null): stays unpriced
    ],
  );
  // Only zero-cost events with nonzero tokens are priced, and the stamp names the spec model.
  assert.deepEqual(gateway.priceUsageCalls, [
    { model: "m1", inputTokens: 1_000_000, outputTokens: 500_000 },
    { model: "m1", inputTokens: 5, outputTokens: 5 },
  ]);

  // A model-less spawn journals no stamp and offers no model to the pricer.
  const b = await t.spawn("k2", { budgetMicros: 1_000 });
  await t.orchestrator.idle();
  const busages = (await t.journal.read({ agent: b.id })).flatMap((e) => (e.payload.kind === "usage" ? [e.payload] : []));
  assert.deepEqual(
    busages.map((u) => [u.costMicros, u.model]),
    [
      [0, undefined],
      [9, undefined],
      [0, undefined],
    ],
  );
  assert.deepEqual(gateway.priceUsageCalls.at(-2), { inputTokens: 1_000_000, outputTokens: 500_000 });
});

test("spend source: the over-budget stop reads the proxy debit store, not journaled Pi cost", async () => {
  const debits = new FakeModelDebitStore({ secret: SECRET });
  const issued = (agent: string) =>
    encodeGatewayCredential(SECRET, { agent, budgetMicros: 100, expiresAt: Date.now() + 3_600_000, issuedAt: Date.now(), id: "f".repeat(32), models: [] });
  // A ModelGateway whose spend reads the debit store's settled charges (as ProxyCredentialGateway does with `debits`).
  const gateway = {
    issueKey: (agent: string) => Promise.resolve({ key: issued(agent), baseUrl: "http://m" }),
    spend: (agent: string) => Promise.resolve({ spentMicros: debits.spentFor(agent), budgetMicros: 100 }),
    revoke: (agent: string) => Promise.resolve({ unusedMicros: Math.max(0, 100 - debits.spentFor(agent)) }),
  };
  const t = setup(
    async (c) => {
      if (c.prompt === "stop") {
        // Settled provider charges past the budget: the next usage event stops the run, even though the
        // journaled Pi cost totals almost nothing.
        const r = debits.reserve(issued(c.agent), "req-1", 100);
        assert.ok(r.ok);
        if (!r.ok) return;
        debits.settle(r.reservation, 150);
        c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 1 });
        return void (await c.stopped);
      }
      // Journaled Pi cost far past the budget is informational only: the debit store says 0, no stop.
      c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 5_000 });
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    },
    { gateway },
  );
  const a = await t.spawn("k-stop", { task: "stop", budgetMicros: 100 });
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).exit, "over_budget");
  const b = await t.spawn("k-fin", { task: "finish", budgetMicros: 100 });
  await t.orchestrator.idle();
  assert.equal((await get(t, b.id)).exit, "succeeded");
});

test("usage cost: a settled call is journaled once and unmatched usage stays distinct from the ledger", async () => {
  const debits = new FakeModelDebitStore({ secret: SECRET });
  const issued = (agent: string) =>
    encodeGatewayCredential(SECRET, { agent, budgetMicros: 1_000, expiresAt: Date.now() + 3_600_000, issuedAt: Date.now(), id: "e".repeat(32), models: ["m"] });
  const gateway = {
    issueKey: (agent: string) => Promise.resolve({ key: issued(agent), baseUrl: "http://m" }),
    spend: (agent: string) => Promise.resolve({ spentMicros: debits.spentFor(agent), budgetMicros: 1_000 }),
    revoke: (agent: string) => Promise.resolve({ unusedMicros: Math.max(0, 1_000 - debits.spentFor(agent)) }),
  };
  // 1 in + 1 out at $1 / $2.4 per MTok is 3.4 micros: the proxy charges ceil (4), Pi reports round (3), the smoke run's 255/256.
  const rates = new FakeRatesSource({ p: { m: { input: 1, output: 2.4, cacheRead: 0, cacheWrite: 0 } } });
  // The join is exact on the provider response id (usage-join): the third event names an id no settlement carries (equal
  // tokens to the first), so it stays unmatched and keeps the harness figure rather than claiming a settlement.
  const usage = [
    { input: 1, output: 1, pi: 3, id: "msg_0", says: "msg_0" },
    { input: 1, output: 2, pi: 6, id: "msg_1", says: "msg_1" },
    { input: 1, output: 1, pi: 3, id: "msg_2", says: "msg_other" },
  ];
  let calls = 0;
  let t: ReturnType<typeof setup> | undefined;
  t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        const u = usage[0]!;
        c.emit({ kind: "usage", inputTokens: u.input, outputTokens: u.output, costMicros: u.pi, responseId: u.says });
        await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
        return;
      }
      const pending: Promise<void>[] = [];
      const sink = settlementSink({ debits, registry: t!.daemon.deps.registry, journal: t!.journal, log: () => {} });
      // The scripted proxy: a real ModelProxy over a scripted Anthropic-shaped upstream, settling through the real sink.
      const proxy = new ModelProxy({
        upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
        budget: debits,
        maximumRequestMicros: 100,
        price: createPrice(rates, "p"),
        onSettlement: (e) => void pending.push(sink(e)),
        fetch: async () => {
          const u = usage[calls++]!;
          return new Response(
            JSON.stringify({ id: u.id, type: "message", stop_reason: "end_turn", usage: { input_tokens: u.input, output_tokens: u.output } }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        },
      });
      for (const [i, u] of usage.entries()) {
        const body = new TextEncoder().encode(JSON.stringify({ model: "m", max_tokens: 8, messages: [] }));
        assert.equal((await proxy.forward({ credential: issued(c.agent), requestId: `req-${i}`, path: "/messages", body })).status, 200);
        await Promise.all(pending);
        c.emit({ kind: "usage", inputTokens: u.input, outputTokens: u.output, costMicros: u.pi, responseId: u.says });
        if (i === 0) c.emit({ kind: "usage", inputTokens: u.input, outputTokens: u.output, costMicros: u.pi, responseId: u.says });
      }
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "usage-checkpoint" });
    },
    { gateway },
  );
  const a = await t.spawn("k-join", { budgetMicros: 1_000 });
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).state, "yielded");
  await t.daemon.resumeAgent(a.id, "continue");
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).generation, 1);
  const payloads = (await t.journal.read({ agent: a.id })).map((e) => e.payload as unknown as Record<string, unknown>);
  const settlements = payloads.filter((p) => p.kind === MODEL_SETTLEMENT_KIND).map((p) => [p.requestId, p.micros]);
  assert.deepEqual(settlements, [
    ["req-0", 4],
    ["req-1", 6],
    ["req-2", 4],
  ]);
  const usages = payloads.filter((p) => p.kind === "usage").map((p) => [p.requestId, p.costMicros, p.costSource, p.harnessCostMicros]);
  assert.deepEqual(usages, [
    ["req-0", 4, "settled", 3],
    ["req-1", 6, "settled", 6],
    [undefined, 3, "harness", undefined],
  ]);
  // Spend totals: the ledger is the authority (14); the journal's meter counts the two joined events at their settled figure
  // and the unmatched one at the harness's own figure (4 + 6 + 3).
  assert.equal(debits.spentFor(a.id), 14);
  assert.equal((await t.journal.spendFor(a.id)).costMicros, 13);
});

test("cancel yielded parent: cancelling a yielded parent cancels its running child", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const p = await yieldedAgent(t, "yp");
  const kid = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: p.id,
    name: "k",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "yk",
  });
  await t.daemon.deps.registry.transition(kid.id, kid.generation, "running", { idempotencyKey: "yk-run" });
  await t.daemon.cancel(p.id);
  await until(async () => ["exited", "reaped"].includes((await get(t, p.id)).state));
  await until(async () => (await get(t, kid.id)).state !== "running");
  assert.notEqual((await get(t, kid.id)).state, "running", "the child did not outlive its yielded parent");
});

test("publish pinned commit: the push carries the sha pinned at approval; a moved tip needs a new approval; an agent with no ingested commit gets a typed 409", async () => {
  let tip = "a".repeat(40);
  const pushed: string[] = [];
  const t = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      resolve: async () => ({ sha: tip, summary: "s", paths: [] }),
      push: async (_a, _b, _t, sha) => void pushed.push(sha),
    },
    approvalWaitMs: 5,
  });
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await runningAgent(t, "a");
  const req = { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "p" };
  await assert.rejects(t.daemon.publish(a.id, req), (e: { status?: number }) => e.status === 409);
  const first = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
  await t.daemon.decideApproval(first.id, "approve", "op", "", "d1");
  tip = "b".repeat(40); // the ref moved after approval
  await assert.rejects(t.daemon.publish(a.id, req), (e: { status?: number }) => e.status === 409, "the approval for the old sha does not cover the new tip");
  assert.deepEqual(pushed, []);
  const second = (await t.fakes.approvals.list({ state: "pending" }))[0]!;
  assert.notEqual(second.id, first.id);
  await t.daemon.decideApproval(second.id, "approve", "op", "", "d2");
  await t.daemon.publish(a.id, req);
  assert.deepEqual(pushed, ["b".repeat(40)]);
  // nothing is ingested under agent/<child> yet, so the resolver throws and the publish is refused with a 409
  const t2 = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: false,
      resolve: async () => {
        throw new Error("unknown ref");
      },
      push: async () => {
        throw new Error("must not push");
      },
    },
  });
  const k = await runningAgent(t2, "kid");
  await assert.rejects(
    t2.daemon.publish(k.id, { branch: `agent/${k.id}`, target: "origin/main", idempotencyKey: "p" }),
    (e: { status?: number; message?: string }) => e.status === 409 && /nothing to publish/.test(e.message ?? ""),
  );
});

test("publish: a pin refused by the content scan is a 403 publish refused, not the 409 nothing-to-publish", async () => {
  const t = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: false,
      resolve: async () => {
        throw new PublishPinError("commit abc123 carries a credential in src/x.ts");
      },
      push: async () => {
        throw new Error("must not push");
      },
    },
  });
  const k = await runningAgent(t, "scanned");
  await assert.rejects(
    t.daemon.publish(k.id, { branch: `agent/${k.id}`, target: "origin/main", idempotencyKey: "p" }),
    (e: { status?: number; message?: string }) =>
      e.status === 403 &&
      /^publish refused: publish pin failed closed: commit abc123 carries a credential/.test(e.message ?? "") &&
      !/nothing to publish/.test(e.message ?? ""),
  );
});
