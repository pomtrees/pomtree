import assert from "node:assert/strict";
import { test } from "node:test";
import { USER_ESC_KIND, USER_ESC_WINDOW_MS, AWAIT_USER_KIND, MAX_PASSIVE_SETTLES, PASSIVE_SETTLE_KIND, WAITING_KIND } from "@pomtree/core";
import { get, setup, until, userAbort } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

// Passive settle: a natural turn end with no result, yield or user abort is nudged through the steer path (mailbox);
// the MAX_PASSIVE_SETTLES-th consecutive one with no activity fails the run.
type T = ReturnType<typeof setup>;
const kinds = async (t: T, id: string) => (await t.journal.read({ agent: id })).map((e) => e.payload.kind as string);
const count = async (t: T, id: string, kind: string) => (await kinds(t, id)).filter((k) => k === kind).length;
const nudges = async (t: T, id: string) => (await t.fakes.mailbox.peek(id)).filter((s) => s.kind === "nudge");
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const tool = (c: Ctx, n: number) => c.emit({ kind: "tool_call", tool: "bash", callId: `c${n}`, input: {} });

test("a passive settle is nudged through the mailbox and the run stays running (no waiting marker)", async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    ctx.emit({ kind: "settled" });
    await ctx.stopped;
  });
  await t.spawn();
  await until(() => c !== undefined);
  await until(async () => (await nudges(t, c.agent)).length === 1);
  const [n] = await nudges(t, c.agent);
  assert.equal((n as { attempt: number }).attempt, 1);
  assert.match((n as { body: string }).body, /pomtree result/);
  assert.match((n as { body: string }).body, /pomtree yield/);
  assert.equal((await get(t, c.agent)).state, "running");
  assert.equal(await count(t, c.agent, WAITING_KIND), 0);
  assert.equal(await count(t, c.agent, PASSIVE_SETTLE_KIND), 1);
  assert.equal([...t.sandbox.running.values()].filter((s) => s.exitCode === null).length, 1, "container kept");
});

test("a tool call between settles resets the count: no cap however many settles in total", async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    await ctx.stopped;
  });
  await t.spawn();
  await until(() => c !== undefined);
  for (let i = 0; i < MAX_PASSIVE_SETTLES * 2; i++) {
    tool(c, i);
    c.emit({ kind: "settled" });
    await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === i + 1);
  }
  assert.equal((await get(t, c.agent)).state, "running");
  const marks = (await t.journal.read({ agent: c.agent }))
    .filter((e) => e.payload.kind === PASSIVE_SETTLE_KIND)
    .map((e) => (e.payload as { count?: number }).count);
  assert.deepEqual(marks, Array(MAX_PASSIVE_SETTLES * 2).fill(1));
});

test("a text-only reply to a nudge does not reset: the cap-th consecutive passive settle fails the run with a clear cause", async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    await ctx.stopped;
  });
  await t.spawn();
  await until(() => c !== undefined);
  for (let i = 1; i <= MAX_PASSIVE_SETTLES; i++) {
    c.emit({ kind: "message", role: "assistant", text: `still here ${i}` });
    c.emit({ kind: "usage", inputTokens: 10, outputTokens: 5, costMicros: 7 });
    c.emit({ kind: "settled" });
    if (i < MAX_PASSIVE_SETTLES) await until(async () => (await nudges(t, c.agent)).some((n) => (n as { attempt?: number }).attempt === i)); // nudge is a level kind: the latest supersedes
  }
  await until(async () => ["exited", "reaped"].includes((await get(t, c.agent)).state));
  const ps = (await t.journal.read({ agent: c.agent })).map((e) => e.payload);
  const exited = ps.find((p) => p.kind === "exited") as { exit: string; cause?: string };
  assert.deepEqual([exited.exit, exited.cause], ["failed", "passive_settle"]);
  assert.ok(ps.some((p) => p.kind === "error" && /passive settle cap/.test(p.message)));
  assert.deepEqual(
    (await nudges(t, c.agent)).map((n) => (n as { attempt?: number }).attempt),
    [MAX_PASSIVE_SETTLES - 1],
    "the failing settle is not nudged (nudges coalesce: only the latest remains)",
  );
  // Nudge cost is visible: the marker count per settle and the turns' usage are in the journal (and the gateway meter).
  assert.deepEqual(
    ps.filter((p) => p.kind === PASSIVE_SETTLE_KIND).map((p) => (p as unknown as { count: number }).count),
    [1, 2, 3],
  );
  assert.equal(ps.filter((p) => p.kind === "usage").length, MAX_PASSIVE_SETTLES);
  assert.equal([...t.sandbox.running.values()].filter((s) => s.exitCode === null).length, 0);
});

test("a user abort is waiting, not nudged, and resets the passive count", async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    await ctx.stopped;
  });
  await t.spawn();
  await until(() => c !== undefined);
  c.emit({ kind: "settled" });
  await until(async () => (await nudges(t, c.agent)).length === 1);
  await userAbort(t, c);
  await until(async () => (await count(t, c.agent, WAITING_KIND)) === 1);
  assert.equal((await nudges(t, c.agent)).length, 1, "the abort adds no nudge");
  assert.equal(typeof ((await t.operator("GET", `/v1/agents/${c.agent}`)).body as { waitingSince?: number }).waitingSince, "number");
  // After the abort the count starts over: MAX - 1 more passive settles are still only nudged.
  for (let i = 0; i < MAX_PASSIVE_SETTLES - 1; i++) {
    c.emit({ kind: "settled" });
    await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === 2 + i);
  }
  await pause();
  assert.equal((await get(t, c.agent)).state, "running");
});

const awaitUser = (c: Ctx, key: string) => c.api("POST", "/v1/agents/self/await-user", { idempotencyKey: key });
const start = async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    await ctx.stopped;
  });
  await t.spawn();
  await until(() => c !== undefined);
  return { t, c };
};
const operatorSays = (t: T, c: Ctx, key: string) => t.operator("POST", `/v1/agents/${c.agent}/message`, { body: "how is it going?", idempotencyKey: key });
const REFUSED = /Valid exits are: keep working, `pomtree result`, or `pomtree yield`/;

test("a human message alone does not make the next settle waiting: it is nudged (passive)", async () => {
  const { t, c } = await start();
  await operatorSays(t, c, "m1");
  c.emit({ kind: "message", role: "assistant", text: "fine" });
  c.emit({ kind: "settled" });
  await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === 1);
  assert.equal(await count(t, c.agent, WAITING_KIND), 0);
  assert.equal((await nudges(t, c.agent)).length, 1);
  assert.match(((await nudges(t, c.agent))[0] as { body: string }).body, /pomtree await-user/);
});

test("await-user is accepted after typed TTY input; the settle after it is waiting, and the declaration is consumed", async () => {
  const { t, c } = await start();
  c.emit({ kind: "user_input", text: "what is the status?" });
  await until(async () => (await count(t, c.agent, "user_input")) === 1);
  const r = await awaitUser(c, "a1");
  assert.equal(r.status, 201);
  assert.equal(await count(t, c.agent, AWAIT_USER_KIND), 1);
  c.emit({ kind: "settled" });
  await until(async () => (await count(t, c.agent, WAITING_KIND)) === 1);
  assert.equal(await count(t, c.agent, PASSIVE_SETTLE_KIND), 0);
  assert.equal((await nudges(t, c.agent)).length, 0);
  // Consumed: a second call with a fresh key and no new message is refused, and the next settle is passive.
  const again = await awaitUser(c, "a2");
  assert.equal(again.status, 409);
  assert.match((again.body as { error: string }).error, REFUSED);
  c.emit({ kind: "settled" });
  await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === 1);
});

test("await-user is accepted after an operator message; a retry with the same key is idempotent (one entry)", async () => {
  const { t, c } = await start();
  await operatorSays(t, c, "m1");
  assert.equal((await awaitUser(c, "k")).status, 201);
  assert.equal((await awaitUser(c, "k")).status, 201);
  assert.equal(await count(t, c.agent, AWAIT_USER_KIND), 1);
});

test("await-user is refused with no interactive message, and after a child_exited-only signal", async () => {
  const { t, c } = await start();
  const none = await awaitUser(c, "k0");
  assert.equal(none.status, 409);
  assert.match((none.body as { error: string }).error, REFUSED);
  await t.daemon.deliver(c.agent, { kind: "child_exited", child: "x", exit: "succeeded" }, "t1");
  await t.daemon.deliver(c.agent, { kind: "message", from: "peer", body: "psst" }, "t2");
  assert.equal((await awaitUser(c, "k1")).status, 409);
  assert.equal(await count(t, c.agent, AWAIT_USER_KIND), 0);
});

test("a newer human message after an accepted await-user withdraws the declaration until it is called again", async () => {
  const { t, c } = await start();
  c.emit({ kind: "user_input", text: "one" });
  await until(async () => (await count(t, c.agent, "user_input")) === 1);
  await awaitUser(c, "k1");
  c.emit({ kind: "user_input", text: "two" });
  await until(async () => (await count(t, c.agent, "user_input")) === 2);
  c.emit({ kind: "settled" });
  await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === 1);
  assert.equal(await count(t, c.agent, WAITING_KIND), 0);
  assert.equal((await awaitUser(c, "k2")).status, 201, "still unanswered after the passive settle");
});

test("Esc (aborted settle) is waiting with no await-user call", async () => {
  const { t, c } = await start();
  await userAbort(t, c);
  await until(async () => (await count(t, c.agent, WAITING_KIND)) === 1);
  assert.equal(await count(t, c.agent, PASSIVE_SETTLE_KIND), 0);
});

test("a settle with a pending interrupt is not nudged (the interrupt resume path owns it)", async () => {
  let c!: Ctx;
  const t = setup(
    async (ctx) => {
      c = ctx;
      await ctx.stopped;
    },
    { interruptGraceMs: 10_000 },
  );
  await t.spawn();
  await until(() => c !== undefined);
  await t.operator("POST", `/v1/agents/${c.agent}/message`, { body: "stop that", idempotencyKey: "i1", mode: "interrupt" });
  c.emit({ kind: "settled" });
  await pause(150);
  assert.equal(await count(t, c.agent, PASSIVE_SETTLE_KIND), 0);
  assert.equal(await count(t, c.agent, WAITING_KIND), 0);
});

test("a result recorded before the settle is a normal settle: no nudge, exits succeeded", async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    await ctx.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    ctx.emit({ kind: "settled" });
    await ctx.stopped;
  });
  await t.spawn();
  await until(async () => c !== undefined && ["exited", "reaped"].includes((await get(t, c.agent)).state));
  assert.equal(await count(t, c.agent, PASSIVE_SETTLE_KIND), 0);
  assert.equal((await nudges(t, c.agent)).length, 0);
  assert.equal(((await t.journal.read({ agent: c.agent })).map((e) => e.payload).find((p) => p.kind === "exited") as { exit: string }).exit, "succeeded");
});

test("a settle after a yield is unchanged: the agent ends yielded, with no nudge", async () => {
  let c!: Ctx;
  const t = setup(async (ctx) => {
    c = ctx;
    await ctx.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
    ctx.emit({ kind: "settled" });
    await ctx.stopped;
  });
  await t.spawn();
  await until(async () => c !== undefined && (await get(t, c.agent)).state === "yielded");
  assert.equal(await count(t, c.agent, PASSIVE_SETTLE_KIND), 0);
  assert.equal(await count(t, c.agent, WAITING_KIND), 0);
});

test("a forged aborted flag with no daemon-observed Esc is a normal passive settle (nudged), never waiting", async () => {
  const { t, c } = await start();
  c.emit({ kind: "settled", aborted: true });
  await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === 1);
  assert.equal(await count(t, c.agent, WAITING_KIND), 0);
  assert.equal((await nudges(t, c.agent)).length, 1);
});

test("aborted + a viewer Esc inside the window is waiting; an Esc older than the window does not corroborate", async () => {
  let clock = Date.now();
  let c!: Ctx;
  const t = setup(
    async (ctx) => {
      c = ctx;
      await ctx.stopped;
    },
    { now: () => clock },
  );
  await t.spawn();
  await until(() => c !== undefined);
  await t.daemon.userEsc(c.agent);
  assert.equal(await count(t, c.agent, USER_ESC_KIND), 1);
  clock += USER_ESC_WINDOW_MS - 1;
  c.emit({ kind: "settled", aborted: true });
  await until(async () => (await count(t, c.agent, WAITING_KIND)) === 1);
  // A fresh Esc, then the settle arrives after the window: passive.
  await t.daemon.userEsc(c.agent);
  clock += USER_ESC_WINDOW_MS + 1;
  c.emit({ kind: "settled", aborted: true });
  await until(async () => (await count(t, c.agent, PASSIVE_SETTLE_KIND)) === 1);
  assert.equal(await count(t, c.agent, WAITING_KIND), 1);
});
