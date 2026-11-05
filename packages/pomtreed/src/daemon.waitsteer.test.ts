import assert from "node:assert/strict";
import { test } from "node:test";
import { get, setup, until, userAbort } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

// `waiting` (settled turn, no result, container up) is a queryable flag on a running agent, folded from the journal, and a
// message to a waiting agent is delivered as a steer through the mailbox extension rather than abort-and-resume.
type T = ReturnType<typeof setup>;
const sandboxUp = (t: T) => [...t.sandbox.running.values()].filter((s) => s.exitCode === null).length;
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const opGet = async (t: T, url: string) => (await t.operator("GET", url)).body as Record<string, unknown> & { waitingSince?: number };
const msgTo = (t: T, id: string, body: object) => t.operator("POST", `/v1/agents/${id}/message`, body);
const isWaiting = async (t: T, id: string) => typeof (await opGet(t, `/v1/agents/${id}`)).waitingSince === "number";
const hasMarker = async (t: T, id: string) => (await t.journal.read({ agent: id })).some((e) => e.payload.kind === "ext.pomtreed.waiting");

test("waiting is queryable on get, list, summary and tree, stays state running, and clears on agent activity, result and settle", async () => {
  let aId = "";
  let c!: Ctx;
  const t = setup(async (ctx) => {
    aId = ctx.agent;
    c = ctx;
    await userAbort(t, ctx);
    await ctx.stopped;
  });
  await t.spawn();
  await until(async () => aId !== "" && (await hasMarker(t, aId)));
  const marker = (await t.journal.read({ agent: aId })).find((e) => e.payload.kind === "ext.pomtreed.waiting")!;
  const rec = await opGet(t, `/v1/agents/${aId}`);
  assert.equal(rec.state, "running");
  assert.equal(rec.waitingSince, marker.ts);
  const list = (await t.operator("GET", "/v1/agents")).body as { id: string; waitingSince?: number }[];
  assert.equal(list.find((a) => a.id === aId)!.waitingSince, marker.ts);
  const sum = (await t.operator("GET", "/v1/summary")).body as { waiting: number; agentsByState: Record<string, number> };
  assert.equal(sum.waiting, 1);
  assert.ok(sum.agentsByState.running! >= 1 && !("waiting" in sum.agentsByState), "waiting is a subset of running, not a state");
  const rows = (await t.operator("GET", "/v1/tree")).body as { fullId: string; state: string; waitingSince?: number; activity: string }[];
  const row = rows.find((r) => r.fullId === aId)!;
  assert.deepEqual([row.state, row.waitingSince, row.activity], ["running", marker.ts, "waiting"], "live-view row");
  // Agent activity (a new turn's output) clears it; a second settled starts a fresh wait.
  c.emit({ kind: "message", role: "assistant", text: "working" });
  await until(async () => !(await isWaiting(t, aId)));
  assert.equal(((await t.operator("GET", "/v1/summary")).body as { waiting: number }).waiting, 0);
  const rows2 = (await t.operator("GET", "/v1/tree")).body as { fullId: string; waitingSince?: number }[];
  assert.equal(rows2.find((r) => r.fullId === aId)!.waitingSince, undefined);
  await userAbort(t, c);
  await until(() => isWaiting(t, aId));
  // A result + settle ends the run: the finished agent carries no flag.
  await c.api("POST", "/v1/agents/self/result", { result: { summary: "done", value: 1 } });
  await userAbort(t, c);
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  assert.equal((await opGet(t, `/v1/agents/${aId}`)).waitingSince, undefined);
});

test("a queue message to a waiting agent is a plain (unflagged) steer signal; it keeps waiting until the extension acks, which clears it", async () => {
  let aId = "";
  let c!: Ctx;
  const t = setup(async (ctx) => {
    aId = ctx.agent;
    c = ctx;
    await userAbort(t, ctx);
    await ctx.stopped;
  });
  await t.spawn();
  await until(async () => aId !== "" && (await isWaiting(t, aId)));
  const r = await msgTo(t, aId, { body: "carry on", idempotencyKey: "q1" });
  assert.equal((r.body as { delivered: string }).delivered, "steered");
  assert.equal(await isWaiting(t, aId), true, "queued, not yet injected: the message_received row does not end the wait");
  const peek = (await c.api("GET", "/v1/agents/self/inbox?peek=1")).body as { id: string; kind: string; body?: string; interrupt?: boolean }[];
  assert.equal(peek.length, 1);
  assert.equal(peek[0]!.interrupt, undefined);
  assert.equal(peek[0]!.body, "carry on");
  const ack = await c.api("POST", "/v1/agents/self/inbox/ack", { ids: peek.map((x) => x.id), idempotencyKey: "ack-1" });
  assert.equal((ack.body as { acked: number }).acked, 1);
  assert.equal(await isWaiting(t, aId), false, "an acked injection starts a turn and ends the wait");
  assert.equal((await get(t, aId)).state, "running");
  assert.equal(
    (await t.journal.read({ agent: aId })).some((e) => e.payload.kind === "ext.pomtreed.steered"),
    true,
  );
});

test("an interrupt to a waiting agent is a steer: no flag, no interrupt marker, no abort-and-resume, container kept", async () => {
  const wakes: string[] = [];
  let aId = "";
  let c!: Ctx;
  const t = setup(
    async (ctx) => {
      if (ctx.wake !== undefined) {
        wakes.push(ctx.wake);
        return;
      }
      aId = ctx.agent;
      c = ctx;
      await userAbort(t, ctx);
      await ctx.stopped;
    },
    { interruptGraceMs: 30 },
  );
  await t.spawn();
  await until(async () => aId !== "" && (await isWaiting(t, aId)));
  const r = await msgTo(t, aId, { body: "change course", mode: "interrupt", idempotencyKey: "i1" });
  assert.deepEqual(
    { mode: (r.body as { mode: string }).mode, delivered: (r.body as { delivered: string }).delivered },
    { mode: "interrupt", delivered: "steered" },
  );
  await pause(120); // longer than the interrupt grace backstop
  assert.deepEqual(wakes, []);
  assert.equal((await get(t, aId)).state, "running");
  assert.equal(sandboxUp(t), 1, "no backstop kill");
  assert.equal(
    t.fakes.calls.some((x) => x.port === "Sandbox" && x.method === "kill"),
    false,
  );
  const kinds = (await t.journal.read({ agent: aId })).map((e) => e.payload.kind);
  assert.equal(kinds.includes("ext.pomtreed.interrupt"), false);
  const peek = (await c.api("GET", "/v1/agents/self/inbox?peek=1")).body as { interrupt?: boolean; body?: string }[];
  assert.deepEqual(
    peek.map((s) => [s.body, s.interrupt]),
    [["change course", undefined]],
  );
  const again = await msgTo(t, aId, { body: "change course", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal((again.body as { delivered: string }).delivered, "steered", "replay returns the first outcome");
});

test("once the wait has ended, a queue message is plain queued and an interrupt takes the abort path (regression)", async () => {
  let aId = "";
  let c!: Ctx;
  const t = setup(
    async (ctx) => {
      aId = ctx.agent;
      c = ctx;
      await userAbort(t, ctx);
      await ctx.stopped;
    },
    { interruptGraceMs: 10_000 },
  );
  await t.spawn();
  await until(async () => aId !== "" && (await isWaiting(t, aId)));
  c.emit({ kind: "message", role: "assistant", text: "busy again" });
  await until(async () => !(await isWaiting(t, aId)));
  assert.equal(((await msgTo(t, aId, { body: "a", idempotencyKey: "q" })).body as { delivered: string }).delivered, "queued");
  assert.equal(((await msgTo(t, aId, { body: "b", mode: "interrupt", idempotencyKey: "i" })).body as { delivered: string }).delivered, "interrupting");
});
