import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { EXPIRED_ANSWER } from "@pomtree/pomtreed";
import { agentPush, gitSkip, mirrorRefs, rig, until } from "./harness.ts";
import type { Rig } from "./harness.ts";

// Lifecycle features (the ones in the tests below) driven through the real store-sqlite + git workspace
// (only sandbox/harness are fakes). The pomtreed unit tests cover these over fakes; this is the real-store half.

const discord = { messagingChannels: ["discord"], escalationChannels: ["discord"] };
const human = (body: string, extra: object, key: string) =>
  ({ channel: "discord", sender: { channel: "discord", sender: "op" }, body, idempotencyKey: key, ...extra }) as never;
const status = (e: unknown) => (e as { status?: number }).status;

async function heldAgent(r: Rig, hold: Promise<void>, name = "a"): Promise<AgentRecord> {
  const root = await r.daemon.root();
  const a = await r.daemon.spawn(root.id, { name, task: "t", idempotencyKey: name });
  await until(async () => (await r.daemon.get(a.id))?.state === "running", "agent running");
  return a;
}

test("ask-timeout: an unanswered escalation expires in the real store, tells the asker, and a late reply is rejected", async () => {
  let clock = Date.now();
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const r = rig({ now: () => clock, play: () => ({ hold, result: { status: "succeeded", result: null } }), deps: { ...discord, askTimeoutMs: 1_000 } });
  try {
    const a = await heldAgent(r, hold);
    const { escalation } = await r.daemon.ask(a.id, { question: "ok?", generation: a.generation, idempotencyKey: "ask1" });
    assert.deepEqual(await r.daemon.sweepEscalations(), []);
    clock += 5_000;
    assert.deepEqual(await r.daemon.sweepEscalations(), [escalation.id]);
    assert.deepEqual(await r.daemon.sweepEscalations(), [], "expiry is once-only");
    const done = await r.store.escalations.get(escalation.id);
    assert.equal(done?.answer, EXPIRED_ANSWER);
    assert.ok((await r.store.mailbox.peek(a.id)).some((s) => s.kind === "human_answer" && s.body === EXPIRED_ANSWER));
    const late = await r.daemon.receiveMessage(human("yes", { replyTo: escalation.id }, "late"));
    assert.equal(late.kind, "rejected");
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("human-wake: a human answer resumes a yielded asker through the real checkpoint store, exactly once", async () => {
  const wakes: string[] = [];
  const r = rig({
    play: () => ({ run: async (api) => void (await api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" })) }),
    resume: (_a, wake) => (wakes.push(wake), { result: { status: "succeeded", result: "woke" } }),
    deps: discord,
  });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "asker", task: "t", idempotencyKey: "asker" });
    await until(async () => (await r.daemon.get(a.id))?.state === "yielded", "asker yielded");
    const cur = (await r.daemon.get(a.id))!;
    const esc = await r.store.escalations.create({ id: "es-1", agent: a.id, host: "h1", generation: cur.generation, question: "q?", options: [] }, "es-1");
    const out = await r.daemon.receiveMessage(human("yes", { replyTo: esc.id }, "r1"));
    assert.equal(out.kind, "answered");
    await r.orchestrator.idle();
    assert.equal(wakes.length, 1);
    assert.deepEqual((await r.daemon.get(a.id))?.result, { summary: "ok", value: "woke" });
    // a replay of the same inbound does not wake it again
    await r.daemon.receiveMessage(human("yes", { replyTo: esc.id }, "r1")).catch(() => {});
    await r.orchestrator.idle();
    assert.equal(wakes.length, 1);
  } finally {
    r.store.close();
  }
});

test("publish is approval-gated end to end: 409 pending, one push after a chat approve, 403 after deny", async () => {
  const pushed: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  const r = rig({
    play: () => ({ hold, result: { status: "succeeded", result: null } }),
    deps: {
      ...discord,
      approvalWaitMs: 20,
      approvalTimeoutMs: 60_000,
      publisher: {
        allowedTargets: ["origin/main"],
        resolve: async () => ({ sha: "a".repeat(40), summary: "1 file changed", paths: [] }),
        push: async (_a, b, t, sha) => void pushed.push(`${b}->${t}@${sha}`),
      },
    },
  });
  r.daemon.deps.approvals = r.store.approvals;
  try {
    const a = await heldAgent(r, hold);
    const req = { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "p1" };
    await assert.rejects(r.daemon.publish(a.id, req), (e) => status(e) === 409);
    assert.deepEqual(pushed, [], "nothing pushed before approval");
    const ask = (await r.daemon.outbox({ channel: "discord" })).find((e) => e.payload.kind === "message_sent")!.payload as { replyTo: string };
    assert.equal((await r.daemon.receiveMessage(human("approve", { replyTo: ask.replyTo }, "ap1"))).kind, "answered");
    await r.daemon.publish(a.id, req);
    await r.daemon.publish(a.id, req);
    assert.deepEqual(pushed, [`agent/${a.id}->origin/main@${"a".repeat(40)}`], "idempotent push of the pinned sha");

    const req2 = { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "p2" };
    await assert.rejects(r.daemon.publish(a.id, req2), (e) => status(e) === 409);
    const ask2 = (await r.daemon.outbox({ channel: "discord" })).filter((e) => e.payload.kind === "message_sent").at(-1)!.payload as { replyTo: string };
    await r.daemon.receiveMessage(human("deny", { replyTo: ask2.replyTo }, "ap2"));
    await assert.rejects(r.daemon.publish(a.id, req2), (e) => status(e) === 403);
    assert.equal(pushed.length, 1);
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("fork: sessionRef and fromCommit are journaled on the child; an unknown session is 404 and spawns nothing", async () => {
  const r = rig();
  try {
    const root = await r.daemon.root();
    const sessionRef = await r.store.sessions.put(new TextEncoder().encode(`{"type":"session"}\n`));
    const { commit } = await r.workspace.create(root.id, {}); // a base commit that exists in the mirror
    const child = await r.daemon.spawn(root.id, { name: "fk", task: "t", idempotencyKey: "fk", sessionRef, fromCommit: commit });
    await r.orchestrator.idle();
    const fork = (await r.daemon.events({ agent: child.id })).find((e) => e.payload.kind === "ext.pomtreed.fork")?.payload as
      | { sessionRef?: string; commit?: string }
      | undefined;
    assert.equal(fork?.sessionRef, sessionRef);
    assert.equal(fork?.commit, commit);
    await assert.rejects(
      r.daemon.spawn(root.id, { name: "bad", task: "t", idempotencyKey: "bad", sessionRef: "sha256:" + "0".repeat(64) }),
      (e) => status(e) === 404,
    );
    assert.equal((await r.daemon.list({ parent: root.id })).filter((k) => k.name === "bad").length, 0);
  } finally {
    r.store.close();
  }
});

test("retention: reap leaves a child's ingested work at refs/agents/<id>/heads/*; the sweep prunes it once the root holds it", {
  skip: gitSkip(),
}, async () => {
  const r = rig({ deps: { folderReapedGraceMs: 3_600_000 } }); // keep the reaped child's folder so the root can pull from it
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "done", task: "t", idempotencyKey: "done" });
    await r.orchestrator.idle();
    await r.daemon.reap(a.id).catch(() => {}); // the child may already be auto-reaped by its settle
    const [childRef] = await agentPush(r, a.id, "child.txt", "from child");
    assert.equal(childRef?.ref, `refs/agents/${a.id}/heads/agent/${a.id}`);
    assert.deepEqual(await r.daemon.sweepCleanup(), [], "reap did not merge: the root has not integrated the child's work, so nothing is pruned");
    assert.deepEqual(mirrorRefs(r.stateDir), [childRef!.ref], "the child's work stays on its own ref");
    // The root integrates the child's work in its own clone (pull + merge) and ingests it; only then is the child's ref prunable.
    const [rootRef] = await agentPush(r, root.id, "root.txt", "from root", a.id);
    assert.ok(rootRef);
    assert.deepEqual(await r.daemon.sweepCleanup(), [a.id]);
    assert.deepEqual(await r.daemon.sweepCleanup(), [], "second sweep is a no-op");
    assert.deepEqual(mirrorRefs(r.stateDir), [rootRef!.ref], "only the root's ref remains in the mirror");
  } finally {
    r.store.close();
  }
});

test("event pump: a slow journal append does not lose the tail; every event and the exit are journaled", async () => {
  const r = rig({
    play: () => ({
      events: Array.from({ length: 30 }, (_, i) => ({ kind: "message" as const, role: "assistant" as const, text: `m${i}` })),
      result: { status: "succeeded", result: "tail" },
    }),
  });
  const append = r.store.journal.append.bind(r.store.journal);
  r.store.journal.append = async (e) => {
    if (e.payload.kind === "message") await new Promise((res) => setTimeout(res, 3));
    return append(e);
  };
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "p", task: "t", idempotencyKey: "p" });
    await r.orchestrator.idle();
    const evs = await r.daemon.events({ agent: a.id });
    assert.equal(evs.filter((e) => e.payload.kind === "message").length, 30);
    assert.ok(evs.some((e) => e.payload.kind === "exited"));
    assert.deepEqual((await r.daemon.get(a.id))?.result, { summary: "ok", value: "tail" });
  } finally {
    r.store.close();
  }
});
