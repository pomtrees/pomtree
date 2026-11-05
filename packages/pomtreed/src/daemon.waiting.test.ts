import assert from "node:assert/strict";
import { test } from "node:test";
import { get, setup, until, userAbort } from "./test-setup.ts";

// Interactive-TTY harnesses emit `settled` after every turn while the process lives on. Without a recorded
// result that is `waiting` for the user (e.g. after an Esc abort): the container and session must survive.
const sandboxUp = (t: ReturnType<typeof setup>) => [...t.sandbox.running.values()].filter((s) => s.exitCode === null).length;
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("settled without a result is waiting: container kept, run stays running, not failed; a later result settles normally", async () => {
  let aId = "";
  let c!: Parameters<Parameters<typeof setup>[0]>[0];
  const t = setup(async (ctx) => {
    aId = ctx.agent;
    c = ctx;
    await userAbort(t, ctx);
    await ctx.stopped;
  });
  await t.spawn();
  await until(() => aId !== "");
  await pause();
  assert.equal((await get(t, aId)).state, "running");
  assert.equal(sandboxUp(t), 1, "container is still up");
  assert.deepEqual(t.fakes.harness.stopped, []);
  // The user steers, the agent finishes: a second settled is also waiting, until a result is recorded.
  c.emit({ kind: "message", role: "assistant", text: "working" });
  await userAbort(t, c);
  await pause();
  assert.equal((await get(t, aId)).state, "running");
  assert.equal(sandboxUp(t), 1);
  const r = await c.api("POST", "/v1/agents/self/result", { result: { summary: "done", value: 1 } });
  assert.equal(r.status < 300, true);
  await userAbort(t, c);
  await until(async () => (await get(t, aId)).state === "exited" || (await get(t, aId)).state === "reaped");
  const exited = (await t.journal.read({ agent: aId })).map((e) => e.payload).find((p) => p.kind === "exited") as { exit: string };
  assert.equal(exited.exit, "succeeded");
  assert.equal(sandboxUp(t), 0);
  assert.equal(
    (await t.journal.read({ agent: aId })).some((e) => (e.payload as { kind: string }).kind === "settled"),
    false,
    "settled is never journaled",
  );
});

test("settled with a result recorded keeps the old behavior: the run settles at once", async () => {
  let aId = "";
  const t = setup(async (ctx) => {
    aId = ctx.agent;
    await ctx.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
    ctx.emit({ kind: "settled" });
    await ctx.stopped; // the stream must end via the daemon (stop), not the script
  });
  await t.spawn();
  await until(async () => aId !== "" && ["exited", "reaped"].includes((await get(t, aId)).state));
  const exited = (await t.journal.read({ agent: aId })).map((e) => e.payload).find((p) => p.kind === "exited") as { exit: string };
  assert.equal(exited.exit, "succeeded");
  assert.equal(sandboxUp(t), 0);
});

test("the watchdog stall ladder does not nudge a waiting agent; a silent non-waiting agent is nudged (control)", async () => {
  let clock = Date.now();
  const ids: Record<string, string> = {};
  const t = setup(
    async (c) => {
      ids[c.prompt.includes("wait") ? "wait" : "quiet"] = c.agent;
      if (c.prompt.includes("wait")) await userAbort(t, c);
      await c.stopped;
    },
    { now: () => clock, watchdogOptions: { stallMs: 1000, graceMs: 500, failureLimit: 100 } },
  );
  await t.spawn("w", { task: "wait" });
  await t.spawn("q", { task: "quiet" });
  await until(() => ids.wait !== undefined && ids.quiet !== undefined);
  await until(async () => (await t.journal.read({ agent: ids.wait! })).some((e) => e.payload.kind === "ext.pomtreed.waiting"));
  clock += 5_000;
  await t.daemon.sweepWatchdogs();
  assert.equal((await t.fakes.watchdogs.get(ids.quiet!))?.rung, "nudged");
  assert.notEqual((await t.fakes.watchdogs.get(ids.wait!))?.rung, "nudged");
  assert.equal((await get(t, ids.wait!)).state, "running");
});

test("the stream ending while waiting (container exit) finalizes the run as failed with a no-result line", async () => {
  let aId = "";
  const t = setup(async (ctx) => {
    aId = ctx.agent;
    await userAbort(t, ctx);
    await pause(); /* the process exits */
  });
  await t.spawn();
  await until(async () => aId !== "" && ["exited", "reaped"].includes((await get(t, aId)).state));
  const ps = (await t.journal.read({ agent: aId })).map((e) => e.payload);
  assert.equal((ps.find((p) => p.kind === "exited") as { exit: string }).exit, "failed");
  assert.ok(ps.some((p) => p.kind === "error" && /without reporting a result/.test(p.message)));
});
