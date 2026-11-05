import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, NewAgent, Schedule } from "@pomtree/core";
import { handle } from "../api.ts";
import { LifecycleError } from "../lifecycle.ts";
import { setup } from "../test-setup.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const children = async (t: ReturnType<typeof setup>) => t.daemon.list({ parent: (await t.daemon.root()).id });
const errors = async (t: ReturnType<typeof setup>) =>
  (await t.daemon.deps.journal.read({ agent: (await t.daemon.root()).id })).filter((e) => e.payload.kind === "ext.cron.error");

test("a failed spawn does not lose the fire: the cursor stays and the next tick retries", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  const raw = t.fakes.hooks.raw.registry;
  const baseCreate = raw.create.bind(raw);
  let failing = true;
  raw.create = async (a: NewAgent): Promise<AgentRecord> => {
    if (failing && a.name === "m") throw new LifecycleError(503, "resource gate");
    return baseCreate(a);
  };
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "skip" });
  clock = T0 + 90_000;
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 0);
  assert.equal(await t.fakes.schedules.lastFired("m"), null);
  failing = false;
  clock += 10 * 60_000; // past the breaker backoff; 00:01 is now a missed fire, so use catch-up semantics below
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "catch-up", overlap: "queue" });
  await t.cronExt.sweep();
  assert.ok((await children(t)).length >= 1);
  assert.ok((await t.fakes.schedules.lastFired("m"))! >= T0 + 60_000); // queue serializes: one fire per live run
});

test("overlap skip checks any running child, not just the previous fire", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "skip" });
  clock = T0 + 90_000;
  await t.cronExt.sweep(); // 00:01 spawns and keeps running
  clock = T0 + 5 * 60_000 + 30_000; // 00:05: previous fire (00:04) never ran, but 00:01's child is alive
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 1);
  assert.equal(await t.fakes.schedules.lastFired("m"), T0 + 5 * 60_000); // settled, not retried forever
});

test("a backward clock step journals one keyed error and fires nothing", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "queue" });
  clock = T0 + 5 * 60_000 + 1000;
  await t.cronExt.sweep();
  const before = (await children(t)).length;
  clock = T0 + 60_000; // stepped back four minutes
  await t.cronExt.sweep();
  clock += 1000;
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, before);
  const errs = await errors(t);
  assert.equal(errs.length, 1);
  assert.match((errs[0]!.payload as { message: string }).message, /clock/);
  assert.equal(await t.fakes.schedules.lastFired("m"), T0 + 5 * 60_000); // cursor never moves backward
});

test("breaker: persistent spawn failure backs off and journals a bounded number of errors", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  const raw = t.fakes.hooks.raw.registry;
  let attempts = 0;
  const baseCreate = raw.create.bind(raw);
  raw.create = async (a: NewAgent): Promise<AgentRecord> => {
    if (a.name !== "m") return baseCreate(a);
    attempts++;
    throw new LifecycleError(422, "down");
  };
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "queue" });
  for (let i = 0; i < 1500; i++) {
    clock = T0 + 90_000 + i * 60_000;
    await t.cronExt.sweep();
  }
  assert.ok(attempts < 60, `attempts=${attempts}`); // backoff, not one per tick
  const errs = await errors(t);
  assert.equal(errs.length, 6); // 5 alerts (the 5th says circuit open) + one auto-pause alert
  assert.match((errs[4]!.payload as { message: string }).message, /circuit open/);
  assert.match((errs.at(-1)!.payload as { message: string }).message, /auto-paused/);
  const s = await t.fakes.schedules.get("m");
  assert.equal(s?.paused, true); // durable pause, and the failure counter is in the store
  assert.ok((s?.failures ?? 0) >= 20);
  const seen = attempts;
  clock += 10 * 3_600_000;
  await t.cronExt.sweep();
  assert.equal(attempts, seen); // paused: never probed again
});

test("paused schedules never fire; resume clears the breaker", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "skip" });
  await t.fakes.schedules.setPaused("m", true, "p");
  clock = T0 + 90_000;
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 0);
  await t.fakes.schedules.setPaused("m", false, "p2");
  clock += 60_000;
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 1);
});

test("overlap queue holds the fire (cursor) while a run is live instead of starting concurrently", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "queue" });
  clock = T0 + 90_000;
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 1);
  const cursor = await t.fakes.schedules.lastFired("m");
  clock = T0 + 5 * 60_000 + 30_000;
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 1); // held, not concurrent
  assert.equal(await t.fakes.schedules.lastFired("m"), cursor); // fire stays due
});

test("POST /v1/schedules/:id/pause|resume: operator only, keyed, 404 unknown, resume clears the breaker", async () => {
  const t = setup(async (c) => void (await c.stopped));
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t" });
  const agent = t.daemon.agentToken("ghost");
  for (const a of ["pause", "resume"]) {
    assert.equal((await handle(t.daemon, { method: "POST", url: `/v1/schedules/m/${a}`, body: { idempotencyKey: "k" } })).status, 401);
    assert.equal((await handle(t.daemon, { method: "POST", url: `/v1/schedules/m/${a}`, body: { idempotencyKey: "k" }, token: agent })).status, 403);
    const keyless = await t.operator("POST", `/v1/schedules/m/${a}`, { idempotencyKey: undefined });
    assert.equal(keyless.status, 400);
    assert.match((keyless.body as { error: string }).error, /^idempotencyKey is required/);
  }
  assert.equal((await t.operator("POST", "/v1/schedules/nope/pause", { idempotencyKey: "k" })).status, 404);
  const p = await t.operator("POST", "/v1/schedules/m/pause", { idempotencyKey: "k1" });
  assert.equal(p.status, 200);
  assert.equal((p.body as Schedule).paused, true);
  assert.equal((await t.fakes.schedules.get("m"))?.paused, true);
  await t.fakes.schedules.recordFailure("m", T0 + 999, "f1");
  const r = await t.operator("POST", "/v1/schedules/m/resume", { idempotencyKey: "k2" });
  assert.ok(!(r.body as Schedule).paused);
  const s = await t.fakes.schedules.get("m");
  assert.ok(!s?.failures && s?.retryAt === undefined);
});

test("transient host conditions (503) never feed the breaker", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  const raw = t.fakes.hooks.raw.registry;
  const baseCreate = raw.create.bind(raw);
  raw.create = async (a: NewAgent): Promise<AgentRecord> => {
    if (a.name !== "m") return baseCreate(a);
    throw new LifecycleError(503, "draining");
  };
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "queue" });
  for (let i = 0; i < 30; i++) {
    clock = T0 + 90_000 + i * 60_000;
    await t.cronExt.sweep();
  }
  const s = await t.fakes.schedules.get("m");
  assert.equal(s?.paused ?? false, false);
  assert.equal(s?.failures ?? 0, 0);
  assert.equal((await errors(t)).length, 0);
});

test("concurrent sweeps are serialized: overlap queue spawns once", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "catch-up", overlap: "queue" });
  clock = T0 + 5 * 60_000 + 1000;
  await Promise.all([t.cronExt.sweep(), t.cronExt.sweep(), t.cronExt.sweep()]);
  assert.equal((await children(t)).length, 1);
});

test("a cursor far in the future (bad-RTC boot) is rewound with one alert, then the schedule fires again", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "skip", overlap: "skip" });
  const future = T0 + 3 * 3_600_000;
  t.fakes.hooks.raw.schedules.lastFiredAt.set("m", future);
  clock = T0 + 90_000;
  await t.cronExt.sweep();
  await t.cronExt.sweep();
  assert.equal(await t.fakes.schedules.lastFired("m"), T0 + 90_000);
  assert.equal((await children(t)).length, 0);
  const errs = await errors(t);
  assert.equal(errs.length, 1);
  assert.match((errs[0]!.payload as { message: string }).message, /rewound/);
  clock = T0 + 150_000; // 00:02 is due and fires exactly once
  await t.cronExt.sweep();
  assert.equal((await children(t)).length, 1);
});

test("an invalid tz is rejected with 400 at PUT (operator scope)", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const r = await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", tz: "Mars/Olympus", task: "t" });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /invalid tz/);
});

test("a schedule with a bad persisted tz is paused with one error entry across many sweeps", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.fakes.schedules.upsert({ id: "m", cron: "* * * * *", tz: "Mars/Olympus", task: "t", missed: "skip", overlap: "skip" } as never, "k1");
  for (let i = 1; i <= 5; i++) {
    clock = T0 + i * 60_000;
    await t.cronExt.sweep();
  }
  assert.equal((await errors(t)).length, 1);
  assert.equal((await t.fakes.schedules.get("m"))!.paused, true);
});

test("a resumed schedule whose tz is still bad is auto-paused again with a fresh alert", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.fakes.schedules.upsert({ id: "m", cron: "* * * * *", tz: "Mars/Olympus", task: "t", missed: "skip", overlap: "skip" } as never, "k1");
  clock = T0 + 60_000;
  await t.cronExt.sweep();
  assert.equal((await t.fakes.schedules.get("m"))!.paused, true);
  await t.fakes.schedules.setPaused("m", false, "resume-1");
  clock = T0 + 120_000;
  await t.cronExt.sweep();
  assert.equal((await t.fakes.schedules.get("m"))!.paused, true);
  assert.equal((await errors(t)).length, 2);
});

test("a recurring identical far-future cursor is rewound each time it recurs", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.fakes.schedules.upsert({ id: "m", cron: "0 0 1 1 *", task: "t", missed: "skip", overlap: "skip" } as never, "k1");
  const bad = T0 + 10 * 86_400_000;
  for (const [i, now] of [T0 + 60_000, T0 + 120_000].entries()) {
    await t.fakes.schedules.setLastFired("m", bad, `seed-${i}`);
    clock = now;
    await t.cronExt.sweep();
    assert.equal(await t.fakes.schedules.lastFired("m"), now);
  }
  assert.equal((await errors(t)).length, 2);
});
