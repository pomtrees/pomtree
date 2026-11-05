import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, DeterministicExecutor, DeterministicRunContext, ExecutorReapReceipt, Handoff } from "@pomtree/core";
import { FakeDeterministicExecutor } from "@pomtree/testing";
import { get, kinds, setup, spawnSpec, until } from "./test-setup.ts";

// Offline acceptance tests for the first deterministic (non-container) runtime. The driver is a real injected
// DeterministicExecutor; the host (Daemon.startDeterministic and the ops it hands the driver) is the unit under test.

const PARENT = "fake-parent";
const CHILD = "fake-child";
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 10_000 };

type Setup = ReturnType<typeof setup>;
const settled = async (t: Setup, id: string) => TERMINAL.includes((await get(t, id)).state);
const waitSettled = (t: Setup, id: string, ms = 2000) => until(() => settled(t, id), ms);
const rootId = async (t: Setup) => (await t.daemon.root()).id;
const exitEntries = async (t: Setup, id: string) => kinds(await t.journal.read({ agent: id })).filter((k) => k.startsWith("exited"));
const childrenOf = async (t: Setup, id: string) => (await t.daemon.list({ parent: id })).length;

// Starts a deterministic task under the root. Extra fields only override the optional budget and deadline.
const start = async (t: Setup, key: string, extra: { budgetMicros?: number; deadlineMs?: number } = {}, driver = PARENT) =>
  t.daemon.startDeterministic(await rootId(t), {
    name: "det",
    task: "t",
    idempotencyKey: key,
    executor: "deterministic",
    spec: { driver, input: { x: 1 } },
    budgetMicros: 500,
    ...extra,
  });

// A harness with the given drivers registered by name; the container path is never exercised here.
const det = (...drivers: DeterministicExecutor[]) => setup(async () => {}, { deterministicExecutors: new Map(drivers.map((d) => [d.driver, d] as const)) });

// Wraps the real gateway's mutating methods so a deterministic path that issues, spends or revokes shows up in the returned log.
const spyGateway = (t: Setup): string[] => {
  const log: string[] = [];
  const gw = t.daemon.deps.gateway as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ["issueKey", "spend", "revoke"]) {
    const orig = gw[m]!.bind(gw);
    gw[m] = (...a: unknown[]) => {
      log.push(m);
      return orig(...a);
    };
  }
  return log;
};

// A driver that ignores its abort signal: run() waits on a gate it never reaches on its own, then tries a late completion.
const stubborn = (driver: string, gate: Promise<void>, seen: { deadlineAt?: number | null; late?: string }): DeterministicExecutor => ({
  driver,
  async run(ctx: DeterministicRunContext) {
    seen.deadlineAt = ctx.deadlineAt;
    await gate;
    try {
      await ctx.ops.submitResult({ summary: "late" }, "late-1");
      seen.late = "accepted";
    } catch {
      seen.late = "rejected";
    }
  },
});

// The host may write its own synthesized terminal handoff; what it must never store is driver-authored content.
const assertNoDriverResult = (r: AgentRecord) => {
  const res = r.result as { synthesized?: boolean } | null | undefined;
  assert.ok(res == null || res.synthesized === true, "no driver-authored result is stored");
};

// Resolves a driver-side op to "accepted" or its rejection message, so a test can read refusals without the driver throwing.
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "accepted",
    (e: Error) => `rejected: ${e.message}`,
  );

test("a deterministic task runs its driver and completes with a full structured result, touching no container, gateway or workspace", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: "done", items: [1, 2] }, "res-1");
  });
  const t = det(exec);
  const gw = spyGateway(t);
  const mark = t.fakes.calls.length;
  const rec = await start(t, "d1");
  await waitSettled(t, rec.id);
  const done = await get(t, rec.id);

  assert.equal(done.executor, "deterministic");
  assert.deepEqual(done.spec, { driver: PARENT, input: { x: 1 } });
  assert.equal(done.exit, "succeeded");
  assert.deepEqual(done.result, { summary: "done", items: [1, 2] });
  assert.equal(exec.runs.length, 1, "the driver ran once");
  assert.equal(exec.contexts.length, 1);
  assert.equal(exec.contexts[0]!.agent, rec.id, "the host stamps the run's identity; the driver does not choose it");
  assert.deepEqual(exec.contexts[0]!.input, { x: 1 });
  assert.equal(exec.contexts[0]!.deadlineAt, null);
  assert.deepEqual(gw, [], "no gateway issue, spend or revoke");
  assert.equal(t.fakes.hooks.raw.sandbox.started.length, 0, "no sandbox started");
  const touched = t.fakes.calls.slice(mark).filter((c) => c.port === "sandbox" || c.port === "workspace");
  assert.deepEqual(touched, [], "no sandbox or workspace calls in the deterministic path");
});

test("a child deterministic task is owned by its parent: keyed spawn once, overspend refused, reap returns its unused budget", TIMEOUT, async () => {
  const kid = new FakeDeterministicExecutor(CHILD);
  kid.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: "child", id: ctx.agent }, "kid-res");
  });
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen: { first?: string; dup?: string; over?: string; receipt?: ExecutorReapReceipt; reapAgain?: ExecutorReapReceipt; second?: string } = {};
  exec.setHandler(async (ctx) => {
    const req = (key: string, budgetMicros: number) => ({
      name: "kid",
      task: "t",
      executor: "deterministic" as const,
      spec: { driver: CHILD, input: null },
      budgetMicros,
      idempotencyKey: key,
    });
    seen.first = await ctx.ops.spawn(req("kid-1", 300));
    seen.dup = await ctx.ops.spawn(req("kid-1", 300));
    seen.over = await outcome(ctx.ops.spawn(req("kid-big", 900)));
    await until(async () => ((await t.daemon.get(seen.first!)) as AgentRecord).state === "exited");
    seen.receipt = await ctx.ops.reap(seen.first!, "reap-1");
    seen.reapAgain = await ctx.ops.reap(seen.first!, "reap-1");
    // 500 carved parent budget minus 300 spent on the first child; reaping returned the 300, so a 500 child now fits.
    seen.second = await ctx.ops.spawn(req("kid-2", 500));
    await until(async () => ((await t.daemon.get(seen.second!)) as AgentRecord).state === "exited");
    await ctx.ops.reap(seen.second!, "reap-2");
    await ctx.ops.submitResult({ summary: "parent done" }, "par-res");
  });
  const t = det(exec, kid);
  const rec = await start(t, "p1");
  await waitSettled(t, rec.id);
  const parentRec = await get(t, rec.id);

  assert.equal(parentRec.exit, "succeeded", "the parent completes once its children are reaped");
  assert.equal(seen.dup, seen.first, "a repeated spawn key returns the same child");
  assert.match(seen.over ?? "", /^rejected/, "a child larger than the parent's remaining budget is refused");
  assert.notEqual(seen.second, seen.first, "the second child is a new child");
  const child = await get(t, seen.first!);
  assert.equal(child.parent, rec.id, "the parent owns the child");
  assert.equal(child.budgetMicros, 300);
  assert.equal(child.executor, "deterministic");
  assert.equal(seen.receipt!.child, seen.first);
  assert.equal(seen.receipt!.state, "reaped");
  assert.equal(seen.receipt!.exit, "succeeded");
  assert.deepEqual(seen.receipt!.result, { summary: "child", id: seen.first });
  assert.equal(seen.receipt!.unusedMicros, 300, "the child spent nothing, so its whole carve comes back");
  assert.deepEqual(seen.reapAgain, seen.receipt, "a repeated reap key returns the same receipt");
  assert.equal(kid.contexts.length, 2, "each child runs exactly once");
});

test("a parent cannot submit its success while a child is exited but unreaped; the refusal is not a terminal", TIMEOUT, async () => {
  const kid = new FakeDeterministicExecutor(CHILD);
  kid.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: "child" }, "kid-res");
  });
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen: { refused?: string; accepted?: string } = {};
  exec.setHandler(async (ctx) => {
    const id = await ctx.ops.spawn({
      name: "kid",
      task: "t",
      executor: "deterministic",
      spec: { driver: CHILD, input: null },
      budgetMicros: 100,
      idempotencyKey: "u-1",
    });
    await until(async () => ((await t.daemon.get(id)) as AgentRecord).state === "exited");
    seen.refused = await outcome(ctx.ops.submitResult({ summary: "too early" }, "early-1"));
    await ctx.ops.reap(id, "u-reap");
    seen.accepted = await outcome(ctx.ops.submitResult({ summary: "parent done" }, "late-ok-1"));
  });
  const t = det(exec, kid);
  const rec = await start(t, "unreaped");
  await waitSettled(t, rec.id);
  assert.match(seen.refused ?? "", /^rejected/, "success with an unreaped child is refused");
  assert.equal(seen.accepted, "accepted", "the same submit succeeds once the child is reaped");
  const done = await get(t, rec.id);
  assert.equal(done.exit, "succeeded");
  assert.deepEqual(done.result, { summary: "parent done" }, "only the accepted result is stored");
});

test("a driver reads its queued messages by peek, acks by id, and the ack replays idempotently", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  // The driver waits on an explicit gate; the test queues the message first and only then opens it, so peek cannot race the send.
  let openGate = () => {};
  const gate = new Promise<void>((r) => (openGate = r));
  exec.setHandler(async (ctx) => {
    await gate;
    const seen = await ctx.ops.peek();
    const ids = seen.map((d) => d.id);
    const acked = await ctx.ops.ack(ids, "ack-1");
    const replay = await ctx.ops.ack(ids, "ack-1");
    const after = await ctx.ops.peek();
    await ctx.ops.submitResult(
      { summary: "inbox", peeked: seen.map((d) => (d.kind === "message" ? d.body : d.kind)), acked, replay, remaining: after.length } as Handoff,
      "res-inbox",
    );
  });
  const t = det(exec);
  const rec = await start(t, "m1");
  await t.daemon.deps.mailbox.send(rec.id, { kind: "message", from: await rootId(t), body: "hello" }, "msg-1");
  openGate();
  await waitSettled(t, rec.id);
  const result = (await get(t, rec.id)).result as Handoff & { peeked: string[]; acked: string[]; replay: string[]; remaining: number };
  assert.equal(result.summary, "inbox");
  assert.deepEqual(result.peeked, ["hello"], "the queued message is visible to peek");
  assert.equal(result.acked.length, 1);
  assert.deepEqual(result.replay, result.acked, "a repeated ack key returns the original result");
  assert.equal(result.remaining, 0, "acked signals are gone from the inbox");
});

test("a driver may message only self, its parent or its own children; an existing non-child and an unknown child are both refused", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen: { stranger?: string; unknown?: string; self?: string } = {};
  const t = det(exec);
  // A real, existing agent that is not this driver's child: the host must refuse it on ownership, not on existence.
  const stranger = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: await rootId(t),
    name: "stranger",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "stranger-1",
  });
  exec.setHandler(async (ctx) => {
    seen.stranger = await outcome(ctx.ops.message({ kind: "child", child: stranger.id }, "x", "bad-1"));
    seen.unknown = await outcome(ctx.ops.message({ kind: "child", child: "not-my-child" }, "y", "bad-2"));
    seen.self = await outcome(ctx.ops.message({ kind: "self" }, "note", "self-1"));
    await ctx.ops.submitResult({ summary: "addressed" }, "res-addr");
  });
  const rec = await start(t, "a1");
  await waitSettled(t, rec.id);
  assert.match(seen.stranger ?? "", /^rejected/, "an existing agent that is not my child is refused");
  assert.match(seen.unknown ?? "", /^rejected/, "an unknown child id is refused");
  assert.equal(seen.self, "accepted", "a message to self is allowed");
  assert.deepEqual(await t.daemon.deps.mailbox.peek(stranger.id), [], "the refused message reaches no one");
  assert.equal((await get(t, rec.id)).exit, "succeeded");
});

test("a keyed duplicate start before completion, and after it, yields one record and one run", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(async (ctx) => {
    await ctx.ops.submitResult({ summary: "once" }, "once-1");
  });
  exec.hold();
  const t = det(exec);
  const a = await start(t, "dup");
  const b = await start(t, "dup");
  assert.equal(b.id, a.id, "a duplicate start while pending returns the same record");
  exec.release();
  await waitSettled(t, a.id);

  const c = await start(t, "dup");
  assert.equal(c.id, a.id, "a duplicate start after completion returns the same record, not a conflict");
  assert.equal((await get(t, a.id)).exit, "succeeded");
  assert.equal(exec.contexts.length, 1, "the driver ran exactly once");
});

test("a late completion from a finished run is rejected and does not change the result", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  let late: DeterministicRunContext["ops"] | undefined;
  exec.setHandler(async (ctx) => {
    late = ctx.ops;
    await ctx.ops.submitResult({ summary: "first" }, "first-1");
  });
  const t = det(exec);
  const rec = await start(t, "late");
  await waitSettled(t, rec.id);
  const result = await outcome(late!.submitResult({ summary: "second" }, "second-1"));
  assert.match(result, /^rejected/, "a finished run cannot submit again");
  assert.deepEqual((await get(t, rec.id)).result, { summary: "first" });
});

test(
  "a stale generation is fenced: after a bump, the old run's submit, spawn, message and ack are all refused and leave nothing durable",
  TIMEOUT,
  async () => {
    const exec = new FakeDeterministicExecutor(PARENT);
    const seen: { ctx?: DeterministicRunContext; results?: Record<string, string> } = {};
    let openGate = () => {};
    const gate = new Promise<void>((r) => (openGate = r));
    exec.setHandler(async (ctx) => {
      seen.ctx = ctx;
      await gate; // parked while the test bumps the generation under it
      const results: Record<string, string> = {};
      results.submit = await outcome(ctx.ops.submitResult({ summary: "stale" }, "stale-res"));
      results.spawn = await outcome(
        ctx.ops.spawn({
          name: "stale-kid",
          task: "t",
          executor: "deterministic",
          spec: { driver: CHILD, input: null },
          budgetMicros: 100,
          idempotencyKey: "stale-kid",
        }),
      );
      results.message = await outcome(ctx.ops.message({ kind: "self" }, "stale-note", "stale-msg"));
      results.ack = await outcome(ctx.ops.ack([], "stale-ack"));
      seen.results = results;
    });
    const t = det(exec);
    const rec = await start(t, "stale");
    await until(() => seen.ctx !== undefined);
    const before = (await get(t, rec.id)).generation;
    await t.daemon.deps.registry.bumpGeneration(rec.id, "h1", "stale-bump-1");
    assert.equal((await get(t, rec.id)).generation, before + 1, "the registry generation moved under the active run");
    openGate();
    await until(() => seen.results !== undefined);
    for (const [op, r] of Object.entries(seen.results!)) assert.match(r, /^rejected/, `${op} from the old generation is refused`);
    assert.equal((await get(t, rec.id)).result ?? null, null, "no durable result from the old generation");
    assert.equal(await childrenOf(t, rec.id), 0, "no child from the old generation");
    assert.deepEqual(await t.daemon.deps.mailbox.peek(rec.id), [], "no message from the old generation");
  },
);

test("cancel aborts a cooperative driver and reaches exactly one terminal", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  const seen = { started: false };
  exec.setHandler(async (ctx) => {
    seen.started = true;
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const t = det(exec);
  const rec = await start(t, "cancel-1");
  await until(() => seen.started);
  await t.daemon.cancel(rec.id, 5);
  await waitSettled(t, rec.id);

  assert.equal((await get(t, rec.id)).exit, "cancelled");
  assert.equal(exec.contexts[0]!.signal.aborted, true, "the driver's signal is aborted");
  assert.deepEqual(
    exec.runs.map((r) => r.outcome),
    ["aborted"],
  );
  assert.equal((await exitEntries(t, rec.id)).length, 1, "exactly one terminal is journaled");
});

test("cancel reaches one terminal even when the driver ignores its abort, and its later completion is rejected", TIMEOUT, async () => {
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const seen: { deadlineAt?: number | null; late?: string } = {};
  const t = det(stubborn(PARENT, gate, seen));
  const rec = await start(t, "stub-1");
  await until(() => seen.deadlineAt !== undefined);
  await t.daemon.cancel(rec.id, 5);
  await waitSettled(t, rec.id);
  assert.equal((await get(t, rec.id)).exit, "cancelled", "the host finishes the task without driver cooperation");
  open();
  await until(() => seen.late !== undefined);
  assert.equal(seen.late, "rejected", "a completion after the abort is refused");
  assertNoDriverResult(await get(t, rec.id));
  assert.equal((await exitEntries(t, rec.id)).length, 1, "exactly one terminal is journaled");
});

test("a deadline aborts a driver that ignores its abort, ends it timed_out, and gives it a deadlineAt", TIMEOUT, async () => {
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const seen: { deadlineAt?: number | null; late?: string } = {};
  const t = det(stubborn(PARENT, gate, seen));
  const before = Date.now();
  const rec = await start(t, "dl-1", { deadlineMs: 30 });
  await waitSettled(t, rec.id, 4000);
  assert.equal((await get(t, rec.id)).exit, "timed_out");
  assert.equal(typeof seen.deadlineAt, "number");
  assert.ok((seen.deadlineAt as number) >= before, "deadlineAt is an epoch deadline");
  open();
  await until(() => seen.late !== undefined);
  assert.equal(seen.late, "rejected");
  assert.equal((await exitEntries(t, rec.id)).length, 1);
});

test("a thrown driver error fails the task; its redacted, bounded text reaches the journal and the daemon log", TIMEOUT, async (tt) => {
  const logged: string[] = [];
  tt.mock.method(console, "error", (...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(() => {
    throw new Error("boom: upstream status 502 for https://data.sec.gov/x key sk-SECRET1234567890abcdef at /Users/x/.env\n\u001b[2Jnext");
  });
  const t = det(exec);
  const rec = await start(t, "throw-1");
  await waitSettled(t, rec.id);
  const done = await get(t, rec.id);
  assert.equal(done.exit, "failed");
  const journal = await t.journal.read({ agent: rec.id });
  const dump = JSON.stringify([done, journal]);
  assert.ok(!dump.includes("sk-SECRET1234567890abcdef"), "the secret never reaches the record or journal");
  assert.ok(!dump.includes("/Users/x"), "no host path reaches the record or journal");
  const expected = "deterministic driver failed [cause=threw]: boom: upstream status 502 for https://data.sec.gov/x key [REDACTED:sk] at [path] next";
  const errors = journal.filter((e) => e.payload.kind === "error").map((e) => (e.payload as { message: string }).message);
  assert.deepEqual(errors, [expected], "the journal says why the round failed");
  const line = logged.find((l) => l.includes(rec.id));
  assert.equal(line, `pomtreed: agent ${rec.id} generation ${rec.generation}: ${expected}`, "the daemon log says the same, as journaled");
});

test("a driver that returns without submitting a result fails the task", TIMEOUT, async () => {
  const exec = new FakeDeterministicExecutor(PARENT);
  exec.setHandler(() => {});
  const t = det(exec);
  const rec = await start(t, "noresult");
  await waitSettled(t, rec.id);
  const done = await get(t, rec.id);
  assert.equal(done.exit, "failed");
  assertNoDriverResult(done);
});

test("an unknown or unavailable driver is refused before any record is created", TIMEOUT, async () => {
  const t = det(); // no drivers registered: the requested driver is unavailable
  const before = await childrenOf(t, await rootId(t));
  await assert.rejects(start(t, "unavail-1"));
  assert.equal(await childrenOf(t, await rootId(t)), before, "no record was created");

  const t2 = det(new FakeDeterministicExecutor(PARENT));
  const before2 = await childrenOf(t2, await rootId(t2));
  await assert.rejects(start(t2, "unknown-1", {}, "no-such-driver"));
  assert.equal(await childrenOf(t2, await rootId(t2)), before2, "no record for an unknown driver");

  const malformed = t2.daemon.startDeterministic(await rootId(t2), {
    name: "det",
    task: "t",
    idempotencyKey: "bad-spec",
    executor: "deterministic",
    spec: { driver: PARENT, input: null, extra: 1 } as unknown as { driver: string; input: null },
    budgetMicros: 500,
  });
  await assert.rejects(malformed);
  assert.equal(await childrenOf(t2, await rootId(t2)), before2, "a malformed spec creates no record");
});

test("container spawns keep their sandbox, template and gateway fixture unchanged", TIMEOUT, async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const a = await t.spawn("cont-1");
  await t.orchestrator.idle();
  const done = await get(t, a.id);
  assert.equal(done.executor, "container");
  assert.equal(done.exit, "succeeded");
  assert.equal(t.fakes.hooks.raw.sandbox.started.length, 1, "a container spawn still starts exactly one sandbox");
});
