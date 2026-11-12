import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, JournalPayload, Signal } from "@pomtree/core";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { setup, spawnSpec, until } from "./test-setup.ts";

test("result is durable and delivered while running; wrap-up stops before child_exited", async () => {
  let reported = false;
  let statuses: number[] = [];
  const t = setup(async (c) => {
    const responses = await Promise.all([
      c.api("POST", "/v1/agents/self/result", { result: { summary: "done", value: 42 }, idempotencyKey: "result" }),
      c.api("POST", "/v1/agents/self/result", { result: { summary: "done", value: 42 }, idempotencyKey: "result" }),
    ]);
    statuses = responses.map((r) => r.status);
    reported = true;
    await c.stopped;
  });
  const root = await t.daemon.root();
  const parent = await t.daemon.deps.registry.create({
    parent: root.id,
    spec: spawnSpec,
    host: "h1",
    task: "parent",
    name: "parent",
    budgetMicros: 100_000,
    idempotencyKey: "parent",
  });
  await t.daemon.deps.registry.transition(parent.id, 0, "running", { idempotencyKey: "parent-running" });
  const child = await t.daemon.spawn(parent.id, { name: "child", task: "child", idempotencyKey: "child", wrapupMs: 60 });
  await until(async () => reported);
  assert.deepEqual(statuses, [200, 200]);
  assert.equal((await t.daemon.get(child.id))!.state, "running");
  const rows = await t.journal.read({ agent: child.id });
  const results = rows.filter((r) => r.payload.kind === "ext.pomtreed.result");
  assert.equal(results.length, 1);
  assert.deepEqual((results[0]!.payload as { result?: unknown }).result, { summary: "done", value: 42 });
  assert.deepEqual(
    (await t.daemon.deps.mailbox.peek(parent.id)).map((s: Signal) => s.kind),
    ["child_result"],
  );
  await assert.rejects(t.daemon.reap(child.id), /reported but not yet exited/);
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(child.id))!.exit, "succeeded");
  assert.ok([...t.fakes.hooks.raw.sandbox.running.values()].every((s) => s.exitCode !== null));
  assert.deepEqual(
    (await t.daemon.deps.mailbox.peek(parent.id)).map((s: Signal) => s.kind),
    ["child_result", "child_exited"],
  );
});

test("recovery preserves a durable typed result instead of restarting or failing it", async () => {
  const t = setup(async () => assert.fail("reported work must not restart"));
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    parent: root.id,
    spec: spawnSpec,
    host: "h1",
    task: "done",
    name: "done",
    budgetMicros: 1000,
    idempotencyKey: "done",
  });
  await t.daemon.deps.registry.transition(a.id, 0, "running", { idempotencyKey: "running" });
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: 0,
    payload: { kind: "ext.pomtreed.result", status: "succeeded", result: { summary: "saved", hits: [1, 2] }, wrapupDeadlineAt: 0 },
    idempotencyKey: `${a.id}:0:result`,
  });
  await t.daemon.recover();
  const result = (await t.daemon.get(a.id)) as AgentRecord;
  assert.equal(result.exit, "succeeded");
  assert.deepEqual(result.result, { summary: "saved", hits: [1, 2] });
  await t.daemon.recover();
  assert.equal((await t.journal.read({ agent: a.id })).filter((r) => r.payload.kind === "exited").length, 1);
});

test("a reported result does not extend the hard session deadline", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "reported" } });
    await c.stopped;
  });
  const a = await t.spawn("deadline", { deadlineMs: 60, wrapupMs: 500 });
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(a.id))!.exit, "timed_out");
});

test("recovery retains the remaining wrap-up window of a live reported sandbox", async () => {
  const t = setup(async () => assert.fail("reported work must not restart"));
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    parent: root.id,
    spec: spawnSpec,
    host: "h1",
    task: "done",
    name: "done",
    budgetMicros: 1000,
    idempotencyKey: "live-done",
  });
  await t.daemon.deps.registry.transition(a.id, 0, "running", { idempotencyKey: "live-running" });
  const sandbox = await t.sandbox.start({ host: "h1", generation: 0, agent: a.id, image: "img", env: {}, mounts: [] }, "recovered-sandbox");
  await t.daemon.deps.registry.setSandbox(a.id, 0, sandbox.id, "sandbox");
  await t.journal.append({
    agent: a.id,
    host: "h1",
    generation: 0,
    payload: { kind: "ext.pomtreed.result", status: "succeeded", result: { summary: "saved" }, wrapupDeadlineAt: Date.now() + 80 },
    idempotencyKey: `${a.id}:0:result`,
  });
  await t.daemon.recover();
  assert.equal((await t.daemon.get(a.id))!.state, "running");
  await until(async () => (await t.daemon.get(a.id))!.state === "reaped");
  assert.equal((await t.daemon.get(a.id))!.exit, "succeeded");
  assert.equal((await t.sandbox.inspect(sandbox.id))!.running, false);
});

test("dirty work needs explicit snapshot approval and collection before the report", async () => {
  const calls: Array<{ save?: boolean; expectedFingerprint?: string; maxBytes?: number } | undefined> = [];
  let refused = false;
  // Recorded inside the harness callback and asserted after it returns: the daemon catches a throw there as an agent failure, not a test failure.
  let first: { status: number; body: unknown } | undefined;
  let resultRowsBeforeApproval = -1;
  let approved: { status: number; body: unknown } | undefined;
  const t = setup(async (c) => {
    const body = { result: { summary: "saved result" }, idempotencyKey: "result" };
    first = await c.api("POST", "/v1/agents/self/result", body);
    resultRowsBeforeApproval = (await t.journal.read({ agent: c.agent })).filter((r) => r.payload.kind === "ext.pomtreed.result").length;
    refused = true;
    approved = await c.api("POST", "/v1/agents/self/result", { ...body, saveUncommitted: "snapshot" });
  });
  const original = t.sandbox.resultWork.bind(t.sandbox);
  t.sandbox.resultWork = async (id, opts) => {
    calls.push(opts);
    return original(id, opts);
  };
  t.sandbox.resultWorkResults.push(
    { dirty: true, fingerprint: "snapshot" },
    { dirty: true, fingerprint: "snapshot" },
    {
      dirty: false,
      fingerprint: "saved",
      bundle: (async function* () {
        yield Buffer.from("bundle");
      })(),
    },
  );
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(refused, true);
  assert.ok(first && approved);
  assert.equal(first.status, 409);
  assert.match((first.body as { error: string }).error, /--save-uncommitted snapshot/);
  // The prefix capture_finish classifies as cause=uncommitted_work (UNCOMMITTED_WORK in agent-image ext/pomtree-browser/finish.ts).
  assert.match((first.body as { error: string }).error, /^uncommitted work: /);
  assert.match((first.body as { error: string }).error, /only if every uncommitted file \(see git status\) is meant to be in the result$/);
  assert.deepEqual(
    { code: (first.body as { code?: string }).code, uncommitted: (first.body as { uncommitted?: boolean }).uncommitted },
    { code: "uncommitted_work", uncommitted: true },
  );
  assert.equal(resultRowsBeforeApproval, 0);
  assert.equal(approved.status, 200);
  assert.equal((approved.body as { code?: string }).code, undefined); // negative: an accepted result carries no code
  const maxBytes = CONFIG_DEFAULTS["push.maxBytes"];
  assert.deepEqual(calls, [{ maxBytes }, { maxBytes }, { save: true, expectedFingerprint: "snapshot", maxBytes }]);
  const kinds = (await t.journal.read({ agent: a.id })).map((r) => r.payload.kind);
  assert.ok(kinds.indexOf("ext.pomtreed.result_save_approved") < kinds.indexOf("ingested"));
  assert.ok(kinds.indexOf("ingested") < kinds.indexOf("ext.pomtreed.result"));
  assert.equal((await t.daemon.get(a.id))!.exit, "succeeded");
});

test("a failed approved save leaves the result unreported and can be retried", async () => {
  // Recorded inside the harness callback and asserted after it returns: the daemon catches a throw there as an agent failure, not a test failure.
  const statuses: number[] = [];
  let stateAfterFailure: string | undefined;
  let resultRowsAfterFailure = -1;
  const t = setup(async (c) => {
    const body = { result: { summary: "save" }, idempotencyKey: "result", saveUncommitted: "snapshot" };
    statuses.push((await c.api("POST", "/v1/agents/self/result", body)).status);
    stateAfterFailure = (await t.daemon.get(c.agent))!.state;
    resultRowsAfterFailure = (await t.journal.read({ agent: c.agent })).filter((r) => r.payload.kind === "ext.pomtreed.result").length;
    statuses.push((await c.api("POST", "/v1/agents/self/result", body)).status);
    statuses.push((await c.api("POST", "/v1/agents/self/result", { ...body, saveUncommitted: "clean" })).status);
  });
  t.sandbox.resultWorkResults.push(
    { dirty: true, fingerprint: "snapshot" },
    new Error("commit failed"),
    { dirty: false, fingerprint: "clean" },
    { dirty: false, fingerprint: "clean" },
    {
      dirty: false,
      fingerprint: "saved",
      bundle: (async function* () {
        yield Buffer.from("bundle");
      })(),
    },
  );
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.deepEqual(statuses, [409, 409, 200]);
  assert.equal(stateAfterFailure, "running");
  assert.equal(resultRowsAfterFailure, 0);
  assert.equal((await t.daemon.get(a.id))!.exit, "succeeded");
});

test("a wrap-up timer expiring during harness start still stops the attached session", async () => {
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "early" } });
    await c.stopped;
  });
  const start = t.daemon.deps.harness.start.bind(t.daemon.deps.harness);
  t.daemon.deps.harness.start = async (opts) => {
    const session = await start(opts);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return session;
  };
  const a = await t.spawn("early", { wrapupMs: 10 });
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(a.id))!.exit, "succeeded");
});

test("failed early result delivery is replayed before child_exited after settlement", async () => {
  let status: number | undefined;
  const t = setup(async (c) => {
    status = (await c.api("POST", "/v1/agents/self/result", { result: { summary: "durable" } })).status;
  });
  const root = await t.daemon.root();
  const parent = await t.daemon.deps.registry.create({
    parent: root.id,
    spec: spawnSpec,
    host: "elsewhere",
    task: "parent",
    name: "parent",
    budgetMicros: 100_000,
    idempotencyKey: "delivery-parent",
  });
  await t.daemon.deps.registry.transition(parent.id, 0, "running", { idempotencyKey: "delivery-parent-running" });
  const send = t.daemon.deps.mailbox.send.bind(t.daemon.deps.mailbox);
  let failures = 2;
  t.daemon.deps.mailbox.send = async (...args) => {
    if (args[1].kind === "child_result" && failures-- > 0) throw new Error("mailbox unavailable");
    return send(...args);
  };
  const child = await t.daemon.spawn(parent.id, { name: "child", task: "child", idempotencyKey: "delivery-child" });
  await t.orchestrator.idle();
  assert.equal(status, 500);
  assert.equal((await t.daemon.get(child.id))!.state, "exited");
  assert.deepEqual(await t.daemon.deps.mailbox.peek(parent.id), []);
  await t.daemon.recover();
  assert.deepEqual(
    (await t.daemon.deps.mailbox.peek(parent.id)).map((s) => s.kind),
    ["child_result", "child_exited"],
  );
  await t.daemon.recover();
  assert.deepEqual(
    (await t.daemon.deps.mailbox.peek(parent.id)).map((s) => s.kind),
    ["child_result", "child_exited"],
  );
});

test("an approved bundle is disposed when collection replays an already ingested save", async () => {
  let disposed = false;
  const bundle: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          assert.fail("a replay must not consume a new bundle");
        },
        return: async () => {
          disposed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  let status: number | undefined;
  const t = setup(async (c) => {
    await t.journal.append({
      agent: c.agent,
      host: "h1",
      generation: 0,
      payload: { kind: "ingested", key: "result-save:snapshot:saved", refs: [{ ref: "saved", commit: "commit" }] } as JournalPayload,
      idempotencyKey: "previous-save",
    });
    status = (await c.api("POST", "/v1/agents/self/result", { result: { summary: "saved" }, saveUncommitted: "snapshot" })).status;
  });
  t.sandbox.resultWorkResults.push({ dirty: true, fingerprint: "snapshot" }, { dirty: false, fingerprint: "saved", bundle });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(status, 200);
  assert.equal((await t.daemon.get(a.id))!.exit, "succeeded");
  assert.equal(disposed, true);
});

test("a same-key result with a different value is refused 409 idempotency_conflict; an identical replay (even one the journal redacts) succeeds", async () => {
  const seen: { status: number; code?: unknown; error?: unknown }[] = [];
  let t!: ReturnType<typeof setup>;
  t = setup(async (c) => {
    // A host path in the value: the journal write redacts it, so only a digest of the submitted value can tell an identical replay.
    const first = { summary: "done", path: `${t.daemon.deps.sessionRoot}/notes.txt` };
    const post = async (result: unknown, status?: "failed") => {
      const r = await c.api("POST", "/v1/agents/self/result", { result, idempotencyKey: "r1", ...(status && { status }) });
      const body = r.body as { code?: unknown; error?: unknown };
      seen.push({ status: r.status, ...(r.status !== 200 && { code: body.code, error: body.error }) });
    };
    await post(first);
    await post(first);
    await post({ summary: "done, but different" });
    await post(first, "failed");
    await post({ path: first.path, summary: "done" }); // same value, other key order
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.deepEqual(
    seen.map((s) => s.status),
    [200, 200, 409, 409, 200],
  );
  for (const s of [seen[2]!, seen[3]!]) {
    assert.equal(s.code, "idempotency_conflict");
    assert.match(String(s.error), /different result was already reported under idempotency key r1; the first result stands/);
  }
  const r = (await t.daemon.get(a.id)) as AgentRecord;
  assert.equal(r.exit, "succeeded");
  assert.equal((r.result as { summary?: string }).summary, "done");
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "ext.pomtreed.result").length, 1);
});
