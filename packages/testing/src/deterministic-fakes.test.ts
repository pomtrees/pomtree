import { test } from "node:test";
import assert from "node:assert/strict";
import { StaleGenerationError } from "@pomtree/core";
import type { AgentRecord, ApprovalKind, JsonValue, NewAgent, SpawnSpec, WaitCondition } from "@pomtree/core";
import { FakeDeterministicExecutor, FakeDeterministicOps, FakeRegistry, FakeSuspension, fakeDeterministicContext } from "./fakes.ts";

const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } } as unknown as SpawnSpec;
const base = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 100 };
const reg = () => new FakeRegistry(() => 1000);

test("FakeRegistry: a container create defaults to executor container; a deterministic record has no container fields", async () => {
  const r = reg();
  const c = await r.create({ ...base, spec, idempotencyKey: "c" } as NewAgent);
  assert.equal(c.executor, "container");
  const d = await r.create({ ...base, executor: "deterministic", spec: { driver: "fetch", input: { n: 1 } }, idempotencyKey: "d" });
  assert.equal(d.executor, "deterministic");
  assert.deepEqual(d.spec, { driver: "fetch", input: { n: 1 } });
  assert.equal("image" in d.spec, false);
});

test("FakeRegistry: unknown executors and malformed deterministic specs fail closed and store nothing", async () => {
  const r = reg();
  await assert.rejects(r.create({ ...base, executor: "task", spec, idempotencyKey: "a" } as unknown as NewAgent), /unknown executor/);
  await assert.rejects(
    r.create({ ...base, executor: "deterministic", spec: { driver: "d" }, idempotencyKey: "b" } as unknown as NewAgent),
    /exactly driver and input/,
  );
  assert.equal(r.agents.size, 0);
});

test("FakeRegistry: a keyed repeat create returns the same record, and a stale generation is rejected", async () => {
  const r = reg();
  const a = { ...base, id: "x", executor: "deterministic" as const, spec: { driver: "d", input: null }, idempotencyKey: "k" };
  assert.deepEqual(await r.create(a), await r.create(a));
  assert.equal(r.agents.size, 1);
  await assert.rejects(r.transition("x", 3, "running", { idempotencyKey: "t" }), StaleGenerationError);
});

test("FakeDeterministicExecutor records contexts and returned runs, and a throwing handler rejects", async () => {
  const ex = new FakeDeterministicExecutor("fetch");
  await ex.run(fakeDeterministicContext({ agent: "a", generation: 2, input: { u: 1 } }));
  assert.equal(ex.contexts.length, 1);
  assert.deepEqual(ex.runs, [{ agent: "a", generation: 2, outcome: "returned" }]);
  ex.setHandler(() => {
    throw new Error("boom");
  });
  await assert.rejects(ex.run(fakeDeterministicContext()), /boom/);
  assert.equal(ex.runs.at(-1)?.outcome, "threw");
});

test("FakeDeterministicExecutor hold parks the run until release, and an abort rejects with the reason", async () => {
  const ex = new FakeDeterministicExecutor();
  ex.hold();
  let done = false;
  const p = ex.run(fakeDeterministicContext()).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false);
  ex.release();
  await p;
  assert.equal(done, true);

  ex.hold();
  const ac = new AbortController();
  const held = ex.run(fakeDeterministicContext({ signal: ac.signal }));
  ac.abort(new Error("cancelled"));
  await assert.rejects(held, /cancelled/);
  assert.equal(ex.runs.at(-1)?.outcome, "aborted");
  ex.release();
});

test("FakeDeterministicOps: keyed mutations replay without a second effect, and an empty summary is rejected", async () => {
  const ops = new FakeDeterministicOps(42);
  ops.deliver({ kind: "message", from: "p", body: "hi" }, "sig-1");
  assert.equal((await ops.peek()).length, 1);
  assert.deepEqual(await ops.ack(["sig-1", "nope"], "ack-1"), ["sig-1"]);
  assert.deepEqual(await ops.ack(["sig-1"], "ack-1"), ["sig-1"]);
  assert.equal((await ops.peek()).length, 0);

  await ops.message({ kind: "parent" }, "status", "m-1");
  await ops.message({ kind: "parent" }, "status", "m-1");
  assert.equal(ops.sent.length, 1);

  const child = { name: "c", task: "t", idempotencyKey: "spawn-1", executor: "deterministic" as const, spec: { driver: "d", input: null } };
  const id1 = await ops.spawn(child);
  assert.equal(await ops.spawn(child), id1);
  assert.equal(ops.children.length, 1);
  ops.exitChild(id1, { exit: null, result: null });
  assert.deepEqual(await ops.reap(id1, "reap-1"), { child: id1, state: "reaped", exit: null, result: null, unusedMicros: 42 });
  assert.deepEqual(await ops.reap(id1, "reap-1"), { child: id1, state: "reaped", exit: null, result: null, unusedMicros: 42 });
  assert.equal(ops.reaped.length, 1);

  const id2 = await ops.spawn({ ...child, idempotencyKey: "spawn-2" });
  assert.equal(ops.children.length, 2);
  ops.exitChild(id2, { exit: "failed", exitCause: "app_exit", result: { summary: "partial", rows: [1, 2] } });
  assert.deepEqual(await ops.reap(id2, "reap-2"), {
    child: id2,
    state: "reaped",
    exit: "failed",
    exitCause: "app_exit",
    result: { summary: "partial", rows: [1, 2] },
    unusedMicros: 42,
  });
  assert.equal(ops.reaped.length, 2);

  const id3 = await ops.spawn({ ...child, idempotencyKey: "spawn-3" });
  ops.exitChild(id3, { exit: "failed", exitCause: "app_exit", toolFailureCause: "timeout", result: null });
  const receipt = await ops.reap(id3, "reap-3");
  assert.equal(receipt.toolFailureCause, "timeout");
  assert.equal("toolFailureCause" in (await ops.reap(id1, "reap-1b")), false, "absent when not scripted");

  await assert.rejects(ops.submitResult({ summary: "  " }, "r-0"), /non-empty/);
  await ops.submitResult({ summary: "done", count: 2 }, "r-1");
  await ops.submitResult({ summary: "done", count: 2 }, "r-1");
  assert.equal(ops.results.length, 1);
  assert.equal(ops.calls.filter((c) => c.op === "submitResult").length, 3);
});

test("FakeDeterministicOps: reap rejects a child that is unknown, foreign or still running; a reaped child re-reaps by key", async () => {
  const ops = new FakeDeterministicOps();
  const other = new FakeDeterministicOps();
  const req = { name: "c", task: "t", idempotencyKey: "s", executor: "deterministic" as const, spec: { driver: "d", input: null } };
  const mine = await ops.spawn(req);
  const foreign = await other.spawn(req);

  await assert.rejects(ops.reap("never-spawned", "r-a"), /not a child of this run/);
  await assert.rejects(ops.reap(foreign, "r-b"), /not a child of this run/);
  await assert.rejects(ops.reap(mine, "r-c"), /has not exited/);
  assert.throws(() => ops.exitChild("never-spawned", { exit: null, result: null }), /unknown child/);
  ops.exitChild(mine, { exit: "succeeded", result: null });
  assert.throws(() => ops.exitChild(mine, { exit: "succeeded", result: null }), /already exited/);
  const first = await ops.reap(mine, "r-d");
  assert.deepEqual(ops.reaped, [mine]);
  // A different-key reap of an already-reaped own child succeeds and recomputes the same receipt, with no second effect.
  assert.deepEqual(await ops.reap(mine, "r-e"), first);
  assert.deepEqual(ops.reaped, [mine]);
});

test("FakeDeterministicOps: a message to a child must target one of this run's children", async () => {
  const ops = new FakeDeterministicOps();
  const child = await ops.spawn({ name: "c", task: "t", idempotencyKey: "s", executor: "deterministic", spec: { driver: "d", input: null } });
  await ops.message({ kind: "child", child }, "go", "m-child");
  await ops.message({ kind: "self" }, "note", "m-self");
  await assert.rejects(ops.message({ kind: "child", child: "stranger" }, "x", "m-bad"), /not a child of this run/);
  assert.deepEqual(
    ops.sent.map((m) => m.to),
    [{ kind: "child", child }, { kind: "self" }],
  );
});

test("FakeDeterministicOps: terminate fences every op, including a replay of an earlier key", async () => {
  const ops = new FakeDeterministicOps();
  ops.deliver({ kind: "message", from: "p", body: "hi" }, "sig-1");
  await ops.message({ kind: "parent" }, "status", "m-1");
  const child = await ops.spawn({ name: "c", task: "t", idempotencyKey: "s", executor: "deterministic", spec: { driver: "d", input: null } });
  ops.exitChild(child, { exit: "succeeded", result: null });
  await ops.reap(child, "r-1");

  ops.terminate("cancelled");
  await assert.rejects(ops.peek(), /cancelled/);
  await assert.rejects(ops.ack(["sig-1"], "ack-1"), /cancelled/);
  await assert.rejects(ops.message({ kind: "parent" }, "status", "m-1"), /cancelled/);
  await assert.rejects(ops.message({ kind: "parent" }, "fresh", "m-2"), /cancelled/);
  await assert.rejects(ops.spawn({ name: "c", task: "t", idempotencyKey: "s", executor: "deterministic", spec: { driver: "d", input: null } }), /cancelled/);
  await assert.rejects(ops.reap(child, "r-1"), /cancelled/);
  await assert.rejects(ops.submitResult({ summary: "late" }, "r-late"), /cancelled/);
  assert.equal(ops.sent.length, 1);
  assert.equal(ops.results.length, 0);
  assert.equal(ops.calls.at(-1)?.op, "submitResult");
});

test("FakeDeterministicOps: supersede to a newer generation fences the run as a stale generation", async () => {
  const ops = new FakeDeterministicOps(0, 3);
  assert.equal(ops.generation, 3);
  await ops.submitResult({ summary: "gen3" }, "r-3");
  assert.throws(() => ops.supersede(3), /generation must advance/);
  ops.supersede(4);
  assert.equal(ops.generation, 4);
  await assert.rejects(ops.submitResult({ summary: "gen3 late" }, "r-3"), StaleGenerationError);
  await assert.rejects(ops.peek(), StaleGenerationError);
  assert.equal(ops.results.length, 1);
});

test("FakeDeterministicExecutor: a run whose ops are at another generation is rejected, not silently run", async () => {
  const ex = new FakeDeterministicExecutor();
  const ops = new FakeDeterministicOps(0, 5);
  await assert.rejects(ex.run(fakeDeterministicContext({ generation: 4, ops })), StaleGenerationError);
  assert.deepEqual(ex.runs, [{ agent: "det-1", generation: 4, outcome: "threw" }]);
  await ex.run(fakeDeterministicContext({ generation: 5, ops }));
  assert.equal(ex.runs.at(-1)?.outcome, "returned");
});

test("FakeDeterministicOps: suspend parks the run with its state and wait, a replay records once, and a fenced run cannot suspend", async () => {
  const ops = new FakeDeterministicOps();
  const wait: WaitCondition = { kind: "message" };
  await assert.rejects(ops.suspend({ phase: 2, input: { u: 1 } }, wait, "s-1"), (e) => e instanceof FakeSuspension && e.state !== null);
  await assert.rejects(ops.suspend({ phase: 2, input: { u: 1 } }, wait, "s-1"), FakeSuspension);
  assert.equal(ops.suspensions.length, 1);
  assert.deepEqual(ops.suspensions[0], { state: { phase: 2, input: { u: 1 } }, wait, key: "s-1" });
  ops.terminate();
  await assert.rejects(ops.suspend({ phase: 3 }, wait, "s-2"), /terminated/);
  assert.equal(ops.suspensions.length, 1);
});

test("FakeDeterministicOps: suspend rejects non-JSON state, oversized state, and a wait naming an unowned child", async () => {
  const ops = new FakeDeterministicOps();
  const wait: WaitCondition = { kind: "message" };
  await assert.rejects(ops.suspend({ a: undefined } as unknown as JsonValue, wait, "s-1"), /invalid workflow suspension/);
  await assert.rejects(ops.suspend(Number.NaN as unknown as JsonValue, wait, "s-2"), /invalid workflow suspension/);
  await assert.rejects(ops.suspend("x".repeat(65537), wait, "s-3"), /invalid workflow suspension/);
  const stranger: WaitCondition = { kind: "child_exited", children: ["stranger"], mode: "all" };
  await assert.rejects(ops.suspend(null, stranger, "s-4"), /workflow wait must name an owned child/);
  const nested: WaitCondition = { kind: "any", of: [{ kind: "message" }, stranger] };
  await assert.rejects(ops.suspend(null, nested, "s-5"), /workflow wait must name an owned child/);
  assert.equal(ops.suspensions.length, 0);
});

test("FakeDeterministicOps: suspend accepts a wait naming one of this run's children, including nested in any", async () => {
  const ops = new FakeDeterministicOps();
  const child = await ops.spawn({ name: "c", task: "t", idempotencyKey: "s", executor: "deterministic", spec: { driver: "d", input: null } });
  const direct: WaitCondition = { kind: "child_exited", children: [child], mode: "any" };
  await assert.rejects(ops.suspend({ phase: 1 }, direct, "s-owned"), FakeSuspension);
  const nested: WaitCondition = { kind: "any", of: [{ kind: "timer", at: 5 }, direct] };
  await assert.rejects(ops.suspend({ phase: 2 }, nested, "s-nested"), FakeSuspension);
  assert.equal(ops.suspensions.length, 2);
});

test("FakeDeterministicOps: openApproval requester is the constructor agent id, defaulting to deterministic-run", async () => {
  const named = new FakeDeterministicOps(0, 0, "agent-x");
  const a = await named.openApproval("egress" as ApprovalKind, "example.com", "o-1");
  assert.equal(a.requester.id, "agent-x");
  const dflt = new FakeDeterministicOps();
  const b = await dflt.openApproval("egress" as ApprovalKind, "example.com", "o-1");
  assert.equal(b.requester.id, "deterministic-run");
});

test("FakeDeterministicOps: findChild returns the scripted record or null; escalation answers and passes replay by key", async () => {
  const ops = new FakeDeterministicOps();
  assert.equal(await ops.findChild("k"), null);
  const rec = { id: "c-1", state: "running" } as unknown as AgentRecord;
  ops.scriptChild("k", rec);
  assert.deepEqual(await ops.findChild("k"), rec);
  assert.equal(ops.calls.filter((c) => c.op === "findChild").length, 2);

  await ops.answerEscalation("es-1", "yes", "a-1");
  await ops.answerEscalation("es-1", "yes", "a-1");
  await ops.passEscalation("es-1", "p-1");
  await ops.passEscalation("es-1", "p-1");
  assert.equal(ops.escalationAnswers.length, 1);
  assert.equal(ops.escalationPasses.length, 1);
});

test("FakeDeterministicOps: openApproval is keyed and getApproval reads it back; a fenced run gets no approval", async () => {
  const ops = new FakeDeterministicOps(0, 4);
  const a = await ops.openApproval("egress" as ApprovalKind, "example.com", "o-1");
  assert.equal(a.state, "pending");
  await assert.rejects(ops.openApproval("publish", "bad-draft", "bad"), /sha256/);
  const draft = await ops.openApproval("publish", "a".repeat(64), "publish");
  const changed = await ops.openApproval("publish", "b".repeat(64), "publish");
  assert.notEqual(draft.id, changed.id, "approval cannot be reused for a different draft hash");
  assert.deepEqual(draft.rungs, ["operator", "owner"]);
  assert.deepEqual(await ops.openApproval("egress" as ApprovalKind, "example.com", "o-1"), a);
  assert.deepEqual(await ops.getApproval(a.id), a);
  assert.equal(await ops.getApproval("ap-missing"), null);
  ops.supersede(5);
  await assert.rejects(ops.getApproval(a.id), StaleGenerationError);
});

test("fakeDeterministicContext carries a continuation only when given", () => {
  assert.equal("continuation" in fakeDeterministicContext(), false);
  assert.deepEqual(fakeDeterministicContext({ input: { u: 1 } }).continuation, undefined);
  assert.deepEqual(fakeDeterministicContext({ continuation: { phase: 2 } as JsonValue }).continuation, { phase: 2 });
});
