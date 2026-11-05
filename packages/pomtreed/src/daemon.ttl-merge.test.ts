// Hold-TTL expiry waits for the merge guard (the API reap's requireMergeSettled): a held child whose TTL passed but whose merge is
// unsettled stays held, with one hold_ttl_deferred journal row per exit; once the merge settles the next sweep expires it.
// reap-on-exit is unchanged (it reaps at exit, bypassing the guard).
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { AgentRecord, MergeReport, ResultDisposition } from "@pomtree/core";
import { LifecycleError } from "./lifecycle.ts";
import { setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const SETTLED: MergeReport = { state: "empty", merged: false, failedRounds: 0, settled: true };
const MERGED: MergeReport = { state: "merged", merged: true, failedRounds: 0, settled: true };
const CONFLICT: MergeReport = { state: "conflict", merged: false, failedRounds: 1, settled: false };

const rig = () => {
  const clock = { t: 1_000_000 };
  const t = setup(async () => {}, { now: () => clock.t });
  t.daemon.deps.repos = t.fakes.repos;
  return { t, clock };
};
const running = async (t: T, key: string, parent: string | undefined, disposition?: ResultDisposition): Promise<AgentRecord> => {
  const reg = t.daemon.deps.registry;
  const a = await reg.create({
    spec: { ...spawnSpec, ...(disposition && { disposition }) },
    parent: parent ?? (await t.daemon.root()).id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
};
const exitOk = (t: T, a: AgentRecord) =>
  t.daemon.deps.registry.transition(a.id, a.generation, "exited", { exit: "succeeded", result: { summary: "x" }, idempotencyKey: `${a.id}-exit` });
const tail = (t: T, r: AgentRecord) => (t.daemon as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail(r, "succeeded");
const sweep = (t: T) => (t.daemon as unknown as { sweepHoldTtl: () => Promise<string[]> }).sweepHoldTtl();
const state = async (t: T, a: AgentRecord) => (await t.daemon.get(a.id))!.state;
const deferrals = async (t: T, a: AgentRecord) =>
  (await t.daemon.deps.journal.read({ from: 1, agent: a.id, limit: 500 })).filter((e) => e.payload.kind === POMTREED_KINDS.holdTtlDeferred);
const held = async (t: T, report?: MergeReport) => {
  const p = await running(t, "P", undefined);
  const k = await running(t, "K", p.id, { mode: "hold", ttlMs: 5_000 });
  if (report) t.fakes.hooks.raw.repos.reports.set(k.id, report);
  const k1 = await exitOk(t, k);
  await tail(t, k1);
  return { p, k: k1 };
};

test("unsettled merge past the TTL: not reaped, one deferral journaled over two sweeps, then the next sweep after the merge settles expires it", async () => {
  const { t, clock } = rig();
  const { p, k } = await held(t); // no report: the fake reads it as "none", never merged
  clock.t += 5_000;
  assert.deepEqual(await sweep(t), []);
  assert.deepEqual(await sweep(t), []);
  assert.equal(await state(t, k), "exited", "stays held");
  const rows = await deferrals(t, k);
  assert.equal(rows.length, 1, "one row per exit, not one per sweep");
  const row = rows[0]!.payload as unknown as { ttlMs: number; mergeState: string; message: string };
  assert.equal(row.ttlMs, 5_000);
  assert.equal(row.mergeState, "none");
  assert.equal(
    row.message,
    `hold TTL of 5000ms passed but the merge of ${k.id} is unsettled (none); it stays held until the merge settles (a later sweep then expires it) or the custodian or operator reaps it (\`pomtree merge ${k.id}\`, then \`pomtree reap ${k.id}\`)`,
  );
  assert.equal(
    (await t.daemon.deps.mailbox.peek(p.id)).filter((s) => s.kind === "message").length,
    0,
    "the custodian is not told of a reap that did not happen",
  );
  t.fakes.hooks.raw.repos.reports.set(k.id, MERGED);
  assert.deepEqual(await sweep(t), [k.id]);
  assert.equal(await state(t, k), "reaped");
  assert.equal((await deferrals(t, k)).length, 1, "no further row");
});

test("a conflicted merge defers too, and names its state", async () => {
  const { t, clock } = rig();
  const { k } = await held(t, CONFLICT);
  clock.t += 5_000;
  assert.deepEqual(await sweep(t), []);
  assert.equal((await deferrals(t, k))[0] && ((await deferrals(t, k))[0]!.payload as unknown as { mergeState: string }).mergeState, "conflict");
});

test("negative control: a child with nothing to merge (or a settled merge) past the TTL expires as before, with no deferral row", async () => {
  const { t, clock } = rig();
  const { k } = await held(t, SETTLED);
  clock.t += 5_000;
  assert.deepEqual(await sweep(t), [k.id]);
  assert.equal(await state(t, k), "reaped");
  assert.equal((await deferrals(t, k)).length, 0);
});

test("before the TTL nothing is deferred or journaled even when the merge is unsettled", async () => {
  const { t, clock } = rig();
  const { k } = await held(t);
  clock.t += 4_999;
  assert.deepEqual(await sweep(t), []);
  assert.equal((await deferrals(t, k)).length, 0);
});

test("reap-on-exit is unchanged: the child is reaped at exit with unsettled work", async () => {
  const { t } = rig();
  const p = await running(t, "P", undefined);
  const k = await running(t, "K", p.id, { mode: "reap-on-exit" });
  const k1 = await exitOk(t, k);
  await tail(t, k1);
  assert.equal(await state(t, k1), "reaped");
});

test("an explicit guarded reap by the custodian/operator keeps its existing behavior: refused while unmerged, allowed once settled", async () => {
  const { t, clock } = rig();
  const { k } = await held(t);
  clock.t += 5_000;
  await sweep(t);
  const e = await t.daemon.reap(k.id, "r1", true).then(
    () => null,
    (x: unknown) => x,
  );
  assert.ok(e instanceof LifecycleError);
  assert.equal(e.status, 409);
  assert.equal(e.extra?.code, "unmerged");
  t.fakes.hooks.raw.repos.reports.set(k.id, MERGED);
  await t.daemon.reap(k.id, "r2", true);
  assert.equal(await state(t, k), "reaped");
});
