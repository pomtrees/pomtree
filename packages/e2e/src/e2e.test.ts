import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { StaleGenerationError } from "@pomtree/core";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { handle, issueToken } from "@pomtree/pomtreed";
import { TEST_MODEL, keyed } from "@pomtree/testing";
import { SECRET, branches, mirrorRefs, rig, until } from "./harness.ts";
import type { Rig } from "./harness.ts";

const kinds = (es: JournalEntry[]) => es.map((e) => e.payload.kind + (e.payload.kind === "exited" ? `:${e.payload.exit}` : ""));
const operator = (r: Rig, method: string, url: string, body?: unknown) =>
  handle(r.daemon, { method, url, body: keyed(method, body), token: issueToken(SECRET, { scope: "operator" }) });
const stateOf = async (r: Rig, id: string) => (await r.daemon.get(id))?.state;
const gate = () => {
  let open = () => {};
  const hold = new Promise<void>((res) => (open = res));
  return { hold, open };
};

test("agent runs, returns a typed result, journal is tailable", async () => {
  const r = rig({
    deps: { escalationChannels: ["discord"] },
    play: () => ({
      events: [
        { kind: "message", role: "assistant", text: "on it" },
        { kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 5 },
      ],
      result: { status: "succeeded", result: { answer: 42 } },
    }),
  });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "do it", idempotencyKey: "k1" });
    await r.orchestrator.idle();

    // The root supervisor reaps its children as soon as they exit.
    const done = (await r.daemon.get(a.id))!;
    assert.equal(done.state, "reaped");
    assert.equal(done.exit, "succeeded");
    assert.deepEqual(done.result, { summary: "ok", value: { answer: 42 } });
    assert.equal(done.parent, root.id);

    const ev = await r.daemon.events({ agent: a.id });
    assert.deepEqual(kinds(ev), [
      "spawned",
      "started",
      "ext.pomtreed.sandbox",
      "message",
      "usage",
      "ext.pomtreed.result",
      "message_sent",
      "ext.pomtreed.op",
      "ext.pomtreed.sandbox",
      "exited:succeeded",
      "message_sent",
      "reaped",
    ]);
    const sb = ev.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === "ext.pomtreed.sandbox");
    assert.deepEqual(
      sb.map((p) => p.phase),
      ["started", "exited"],
      "sandbox lifecycle: started then exited",
    );
    assert.equal(sb[0]!.sandbox, sb[1]!.sandbox, "both sandbox entries name the same sandbox");
    assert.equal(typeof sb[0]!.sandbox, "string");
    assert.ok(ev.every((e) => e.host === "h1" && e.generation === a.generation));

    const tail = await r.daemon.events({ agent: a.id, from: ev[3]!.seq });
    assert.deepEqual(
      tail.map((e) => e.seq),
      ev.slice(3).map((e) => e.seq),
    );

    const status = ev.filter((e) => e.payload.kind === "message_sent" && e.payload.purpose === "status");
    assert.equal(status.length, 2, "a root child's report and exit are status messages on its own journal");
    assert.deepEqual(await r.store.mailbox.peek(root.id), [], "root's mailbox gets no child_exited");
  } finally {
    r.store.close();
  }
});

test("restart mid-flight rebuilds from the stores (no state in daemon memory)", async () => {
  const g = gate();
  const r1 = rig({ play: () => ({ events: [{ kind: "message", role: "assistant", text: "working" }], hold: g.hold }) });
  const r2 = rig({
    repo: r1.repo,
    stateDir: r1.stateDir,
    play: () => ({ result: { status: "succeeded", result: "ok" } }),
  });
  try {
    const root = await r1.daemon.root();
    const running = await r1.daemon.spawn(root.id, { name: "long", task: "t", idempotencyKey: "long" });
    await until(async () => (await r1.daemon.events({ agent: running.id })).some((e) => e.payload.kind === "message"), "agent running");

    // An agent that was accepted but never started when the first daemon died.
    const pending = await r1.store.registry.create({
      parent: root.id,
      name: "pend",
      task: "t",
      host: "h1",
      budgetMicros: 1_000,
      idempotencyKey: "pend",
      spec: {
        image: "img@sha256:e2e",
        envManifestHash: null,
        extensions: [],
        provider: TEST_MODEL.provider,
        model: TEST_MODEL.id,
        systemPrompt: null,
        egress: { kind: "none" },
      },
    });

    // "Restart": a second daemon over the same stores; daemon 1 is abandoned (its in-memory handles are lost).
    await r2.daemon.recover();
    await r2.orchestrator.idle();

    const lost = (await r2.daemon.get(running.id))!;
    assert.equal(lost.exit, "failed");
    assert.equal(lost.state, "reaped");
    const lostEvents = await r2.daemon.events({ agent: running.id });
    assert.ok(lostEvents.some((e) => e.payload.kind === "error" && /restarted/.test(e.payload.message)));

    const restarted = (await r2.daemon.get(pending.id))!;
    assert.equal(restarted.exit, "succeeded");
    assert.equal(restarted.state, "reaped");
    assert.equal((await r2.daemon.get(root.id))!.state, "running");
  } finally {
    g.open();
    await r1.orchestrator.idle();
    r1.store.close();
    r2.store.close();
  }
});

test("a stale generation is rejected by the real store", async () => {
  const r = rig();
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
    await r.orchestrator.idle();
    const bumped = await r.store.registry.bumpGeneration(a.id, "h2", "bump-h2");
    assert.equal(bumped.generation, a.generation + 1);

    const stale = { agent: a.id, host: "h1", generation: a.generation, payload: { kind: "message", role: "assistant", text: "zombie" } } as const;
    await assert.rejects(r.store.journal.append({ ...stale, idempotencyKey: "z1" }), StaleGenerationError);
    await assert.rejects(r.store.registry.transition(a.id, a.generation, "running", { idempotencyKey: "stale-run" }), StaleGenerationError);
    const ok = await r.store.journal.append({ ...stale, generation: bumped.generation, host: "h2", idempotencyKey: "z2" });
    assert.ok(ok.seq > 0);
  } finally {
    r.store.close();
  }
});

test("each agent gets a private clone folder while it runs; the operator's repo gets no agent branch; reap keeps the folder for the sweep", async () => {
  const g = gate();
  const r = rig({ play: () => ({ hold: g.hold, result: { status: "succeeded", result: null } }) });
  try {
    const root = await r.daemon.root();
    const a = await r.daemon.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
    const b = await r.daemon.spawn(root.id, { name: "w2", task: "t", idempotencyKey: "k2" });
    await until(async () => (await r.workspace.list()).length === 2, "both workspaces created");
    assert.deepEqual((await r.workspace.list()).sort(), [a.id, b.id].sort());
    assert.deepEqual(branches(r.repo), [], "agents work in private clones, never in the operator's repo");

    g.open();
    await r.orchestrator.idle();
    assert.equal(await stateOf(r, a.id), "reaped");
    assert.deepEqual(branches(r.repo), []);
    assert.deepEqual((await r.workspace.list()).sort(), [a.id, b.id].sort(), "reap does not remove the folder; the cleanup sweep evicts it");
    assert.deepEqual(mirrorRefs(r.stateDir), [], "nothing was ingested, so the mirror has no agent refs");
  } finally {
    r.store.close();
  }
});

test("workspace survives exit and reap (reap does not merge or evict); the parent's reap leaves the repo untouched", async () => {
  const parentGate = gate();
  let childId = "";
  const r = rig({
    play: (_agent, task) =>
      task === "parent"
        ? {
            hold: parentGate.hold,
            run: async (api) => {
              const res = await api("POST", "/v1/agents", { name: "kid", task: "child", idempotencyKey: "kid" });
              assert.equal(res.status, 201);
              childId = (res.body as AgentRecord).id;
            },
            result: { status: "succeeded", result: null },
          }
        : { result: { status: "succeeded", result: "kid done" } },
  });
  try {
    const root = await r.daemon.root();
    const parent = await r.daemon.spawn(root.id, { name: "p", task: "parent", idempotencyKey: "p" });
    await until(async () => !!childId && (await stateOf(r, childId)) === "exited", "child exited, unreaped");

    // Exited but not yet reaped by its (agent) parent: the folder is still there.
    assert.ok((await r.workspace.list()).includes(childId));
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.repo, encoding: "utf8" });

    const reaped = await operator(r, "POST", `/v1/agents/${childId}/reap`);
    assert.equal(reaped.status, 200);
    assert.equal(await stateOf(r, childId), "reaped");
    assert.ok((await r.workspace.list()).includes(childId), "reap keeps the folder; only the sweep evicts it");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.repo, encoding: "utf8" }), headBefore, "reap merges nothing into the repo");
    assert.deepEqual(branches(r.repo), []);

    parentGate.open();
    await r.orchestrator.idle();
    assert.equal(await stateOf(r, parent.id), "reaped");
    assert.deepEqual(mirrorRefs(r.stateDir), [], "no ingest, no agent refs");
  } finally {
    r.store.close();
  }
});

test("a failing child wakes its parent; a dead parent's children are cancelled", async () => {
  // 1. Failure is pushed: the parent finds child_exited in its mailbox without polling the child.
  const parentGate = gate();
  let failedId = "";
  const r = rig({
    play: (_agent, task) => {
      if (task === "parent")
        return {
          hold: parentGate.hold,
          run: async (api) => {
            failedId = ((await api("POST", "/v1/agents", { name: "bad", task: "fail", idempotencyKey: "bad" })).body as AgentRecord).id;
          },
          result: { status: "succeeded", result: null },
        };
      if (task === "fail") return { result: { status: "failed", result: "boom" } };
      return {};
    },
  });
  const orphanGate = gate();
  try {
    const root = await r.daemon.root();
    const parent = await r.daemon.spawn(root.id, { name: "p", task: "parent", idempotencyKey: "p" });
    await until(async () => !!failedId && (await stateOf(r, failedId)) === "exited", "child failed");

    const inbox = await r.store.mailbox.peek(parent.id);
    assert.deepEqual(
      inbox.map((s) => s.kind),
      ["child_result", "child_exited"],
    );
    assert.deepEqual(
      { ...inbox[1], spentMicros: undefined, budgetMicros: undefined },
      {
        kind: "child_exited",
        child: failedId,
        exit: "failed",
        handoff: "ok",
        branch: `agent/${failedId}`,
        spentMicros: undefined,
        budgetMicros: undefined,
        id: `${failedId}:0:child_exited`,
      },
    );
    assert.ok((await r.daemon.events({ agent: parent.id })).some((e) => e.payload.kind === "signal" && e.payload.signal.kind === "child_exited"));

    // The parent may not finish successfully while the child is unreaped.
    const early = await handle(r.daemon, {
      method: "POST",
      url: "/v1/agents/self/result",
      body: { status: "succeeded", result: { summary: "early" }, idempotencyKey: "early" },
      token: r.daemon.agentToken(parent.id),
    });
    assert.equal(early.status, 409);
    await operator(r, "POST", `/v1/agents/${failedId}/reap`);
    parentGate.open();
    await r.orchestrator.idle();

    // 2. A parent that dies takes its running children with it (cancel, grace, kill).
    let orphanId = "";
    const r2 = rig({
      repo: r.repo,
      hostId: "h2",
      play: (_agent, task) =>
        task === "doomed"
          ? {
              run: async (api) => {
                orphanId = ((await api("POST", "/v1/agents", { name: "orphan", task: "orphan", idempotencyKey: "o" })).body as AgentRecord).id;
                await until(async () => !!(await r2.daemon.get(orphanId)) && (await r2.daemon.get(orphanId))!.state === "running", "orphan running");
              },
              result: { status: "failed", result: "dying" },
            }
          : { events: [{ kind: "message", role: "assistant", text: "still going" }], hold: orphanGate.hold },
    });
    try {
      const root2 = await r2.daemon.root();
      await r2.daemon.spawn(root2.id, { name: "d", task: "doomed", idempotencyKey: "d" });
      await r2.orchestrator.idle();
      const orphan = (await r2.daemon.get(orphanId))!;
      assert.equal(orphan.exit, "cancelled");
      assert.ok(["exited", "reaped"].includes(orphan.state));
      assert.ok((await r2.daemon.events({ agent: orphanId })).some((e) => e.payload.kind === "signal" && e.payload.signal.kind === "cancel"));
    } finally {
      r2.store.close();
    }
  } finally {
    orphanGate.open();
    r.store.close();
  }
});
