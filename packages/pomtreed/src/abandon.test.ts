import assert from "node:assert/strict";
import { test } from "node:test";
import { StaleGenerationError } from "@pomtree/core";
import type { AgentRecord, Sandbox } from "@pomtree/core";
import { createFakes } from "@pomtree/testing";
import { abandonAgent } from "./abandon.ts";
import { handle } from "./api.ts";
import { op, setup, spawnSpec, until } from "./test-setup.ts";
import { LifecycleError } from "./lifecycle.ts";

// `pomtree abandon` on the daemon: it kills the sandbox on the backend the record names, ends the run cancelled with cause
// `abandoned`, clears the pin and fences the old generation. The default test sandbox is the backend "fake".

type T = ReturnType<typeof setup>;
async function holder(t: T, name: string, sandbox: string | null, backend?: string) {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: name });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${name}-run` });
  if (sandbox !== null) await reg.setSandbox(a.id, a.generation, sandbox, `${name}-sb`, backend);
  return a;
}
const kills = (t: T) => t.fakes.hooks.raw.sandbox.killCalls;
const rec = async (t: T, id: string) => (await t.daemon.get(id))!;

test("abandon on the selected backend kills the sandbox once, ends the run cancelled/abandoned and clears the pin; a repeat kills nothing more", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-1", "fake");
  const first = await abandonAgent(t.daemon, a.id, { reason: "operator choice" });
  assert.equal(first.outcome, "released");
  assert.match(first.message, /sandbox sb-1 killed on fake/);
  const r = await rec(t, a.id);
  assert.deepEqual([r.state, r.exit, r.exitCause, r.sandbox, r.sandboxBackend], ["reaped", "cancelled", "abandoned", null, null]); // a root child is reaped as it exits (Lifecycle.finishTail)
  assert.ok(r.generation > a.generation, "the generation was bumped");
  assert.equal(kills(t).length, 1);
  const again = await abandonAgent(t.daemon, a.id);
  assert.equal(again.outcome, "already_abandoned");
  assert.match(again.message, /already abandoned/);
  assert.equal(kills(t).length, 1, "the repeat killed nothing");
});

test("concurrent abandons of one agent share one run and kill once", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-1", "fake");
  const [x, y] = await Promise.all([abandonAgent(t.daemon, a.id), abandonAgent(t.daemon, a.id)]);
  assert.equal(x, y);
  assert.equal(kills(t).length, 1);
});

test("an unreachable recorded backend reports 'left on X' with cause and action, kills nothing, and still abandons and clears the pin", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-d", "docker");
  const res = await abandonAgent(t.daemon, a.id); // no way to build docker here
  assert.equal(res.outcome, "left");
  assert.match(
    res.message,
    /sandbox sb-d left on docker: backend docker is not the selected backend \(fake\) and cannot be constructed in this daemon; it may still run and bill/,
  );
  assert.match(res.message, /remove it with docker's own tooling, or select docker \(sandbox\.backend\) and restart so boot reconcile lists it and stops it/);
  assert.equal(kills(t).length, 0, "the selected backend was never asked to kill a sandbox it does not own");
  const r = await rec(t, a.id);
  assert.deepEqual([r.state, r.exitCause, r.sandbox, r.sandboxBackend], ["reaped", "abandoned", null, null]);
});

test("a recorded backend that is constructible is the one that gets the kill, not the selected one; a backend that refuses the kill is reported left", async () => {
  const t = setup(async () => {});
  const other = createFakes({ host: "h1" }).hooks.raw.sandbox;
  const a = await holder(t, "a", "sb-d", "docker");
  t.daemon.deps.sandboxFor = (b) => (b === "docker" ? (other as unknown as Sandbox) : undefined);
  const res = await abandonAgent(t.daemon, a.id);
  assert.equal(res.outcome, "released");
  assert.deepEqual(
    other.killCalls.map((k) => k.id),
    ["sb-d"],
  );
  assert.equal(kills(t).length, 0);

  const b = await holder(t, "b", "sb-e", "docker");
  const down = {
    declaration: other.declaration,
    kill: async () => {
      throw new Error("docker engine is down");
    },
  } as unknown as Sandbox;
  t.daemon.deps.sandboxFor = () => down;
  const left = await abandonAgent(t.daemon, b.id);
  assert.equal(left.outcome, "left");
  assert.match(left.message, /left on docker: backend docker did not accept the kill \(.*engine is down.*\)/);
  assert.equal((await rec(t, b.id)).exitCause, "abandoned");
});

test("a late write from the old generation is fenced after abandon", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-1", "fake");
  const reg = t.daemon.deps.registry;
  // Control: before the abandon the old generation can still write.
  await reg.setSandbox(a.id, a.generation, "sb-1", "late-ok");
  await abandonAgent(t.daemon, a.id);
  await assert.rejects(() => reg.setSandbox(a.id, a.generation, "sb-late", "late-1", "fake"), StaleGenerationError);
  await assert.rejects(() => reg.transition(a.id, a.generation, "yielded", { idempotencyKey: "late-2" }), StaleGenerationError);
  await assert.rejects(
    () =>
      t.daemon.deps.journal.append({
        agent: a.id,
        host: "h1",
        generation: a.generation,
        payload: { kind: "error", message: "late" },
        idempotencyKey: "late-3",
      }),
    StaleGenerationError,
  );
  assert.equal((await rec(t, a.id)).sandbox, null, "the late write changed nothing");
});

test("a mismatched record is held at boot (the daemon boots), and abandon then resolves it and replays the exited tail", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-d", "docker");
  const errors = console.error;
  console.error = () => {};
  try {
    await t.daemon.recover(); // holds the agent instead of refusing to boot
  } finally {
    console.error = errors;
  }
  assert.equal((await rec(t, a.id)).state, "running", "held, untouched");
  assert.equal(kills(t).length, 0, "holding killed nothing");
  const res = await abandonAgent(t.daemon, a.id);
  assert.equal(res.outcome, "left");
  const entries = await t.daemon.deps.journal.read({ agent: a.id });
  assert.deepEqual(
    entries.filter((e) => e.payload.kind === "exited").map((e) => (e.payload as { cause?: string }).cause),
    ["abandoned"],
    "the lifecycle exit path wrote the exited row",
  );
  assert.ok(entries.some((e) => e.payload.kind === "error" && (e.payload as { message: string }).message.includes("left on docker")));
  await t.daemon.recover(); // and a later boot no longer holds it
  assert.deepEqual((t.daemon as unknown as { reconciler: { held(): string[] } }).reconciler.held(), []);
});

test("abandon of a run with no sandbox, a pending run, an unknown agent and an already finished one", async () => {
  const t = setup(async () => {});
  const none = await holder(t, "none", null);
  assert.equal((await abandonAgent(t.daemon, none.id)).outcome, "no_sandbox");
  assert.equal((await rec(t, none.id)).exitCause, "abandoned");

  const root = await t.daemon.root();
  const pending = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "p",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "p",
  });
  assert.equal((await abandonAgent(t.daemon, pending.id)).outcome, "no_sandbox");
  assert.equal((await rec(t, pending.id)).state, "reaped");

  await assert.rejects(
    () => abandonAgent(t.daemon, "nope"),
    (e: unknown) => e instanceof LifecycleError && e.status === 404 && /no such agent: nope/.test(e.message),
  );

  const done = await holder(t, "done", null);
  await t.daemon.deps.registry.transition(done.id, done.generation, "exited", { exit: "succeeded", idempotencyKey: "done-x" });
  await assert.rejects(
    () => abandonAgent(t.daemon, done.id),
    (e: unknown) => e instanceof LifecycleError && e.status === 409 && /nothing to abandon/.test(e.message),
  );
});

test("POST /v1/agents/:id/abandon is operator-only, validates the reason and returns the outcome", async () => {
  const t = setup(async () => {});
  const a = await holder(t, "a", "sb-1", "fake");
  const post = (id: string, body: object, token = op) =>
    handle(t.daemon, { method: "POST", url: `/v1/agents/${id}/abandon`, body: { idempotencyKey: "k", ...body }, token });
  assert.equal((await post(a.id, {}, t.daemon.agentToken(a.id, a.generation))).status, 403);
  assert.equal((await post("nope", {})).status, 404);
  assert.equal((await post(a.id, { reason: 5 })).status, 400);
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/abandon`, body: {}, token: op })).status,
    400,
    "a call without a key is refused",
  );
  assert.equal(kills(t).length, 0, "refused calls killed nothing");
  const ok = await post(a.id, { reason: "r" });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { outcome: string }).outcome, "released");
  const again = await post(a.id, {});
  assert.equal(again.status, 200);
  assert.equal((again.body as { outcome: string }).outcome, "already_abandoned");
  assert.equal(kills(t).length, 1);
});

const kinds = (es: { payload: { kind: string } }[]) => es.map((e) => e.payload.kind);

test("abandoning a child that a parent is waiting on notifies the parent (child_exited, cancelled) and a live driver is stopped", async () => {
  let got: { kind: string; exit?: string }[] = [];
  const kid = { id: "" };
  const t = setup(async (c) => {
    if (c.prompt === "sleep") return void (await c.stopped);
    kid.id = ((await c.api("POST", "/v1/agents", { task: "sleep", idempotencyKey: "c1" })).body as AgentRecord).id;
    got = (await c.api("GET", "/v1/agents/self/inbox?waitMs=5000")).body as typeof got;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
  });
  await t.spawn();
  await until(async () => kid.id !== "" && (await t.daemon.get(kid.id))?.state === "running" && (await t.daemon.get(kid.id))?.sandbox != null);
  const res = await abandonAgent(t.daemon, kid.id);
  assert.equal(res.outcome, "released");
  await t.orchestrator.idle(); // the child's driver returned (it was stopped) and the parent finished
  const k = await rec(t, kid.id);
  assert.deepEqual([k.exit, k.exitCause, k.sandbox], ["cancelled", "abandoned", null]);
  const exited = got.find((s) => s.kind === "child_exited");
  assert.equal(exited?.exit, "cancelled", "the waiting parent was woken with the child's exit");
  assert.ok(kinds(await t.journal.read({ agent: kid.id })).includes("exited"));
  const sb = t.fakes.hooks.raw.sandbox;
  assert.ok(
    [...sb.running.values()].every((r) => r.exitCode !== null),
    "no sandbox is left running",
  );
});

test("abandoning a running parent cancels its live children", async () => {
  const kid = { id: "" };
  const t = setup(async (c) => {
    if (c.prompt === "sleep") return void (await c.stopped);
    kid.id = ((await c.api("POST", "/v1/agents", { task: "sleep", idempotencyKey: "c1" })).body as AgentRecord).id;
    await c.stopped;
  });
  const parent = await t.spawn();
  await until(async () => kid.id !== "" && (await t.daemon.get(kid.id))?.state === "running");
  await abandonAgent(t.daemon, parent.id);
  await t.orchestrator.idle();
  assert.equal((await rec(t, parent.id)).exitCause, "abandoned");
  const k = await rec(t, kid.id);
  assert.ok(k.state === "exited" || k.state === "reaped");
  assert.equal(k.exit, "cancelled", "the child did not outlive its abandoned parent");
});

test("abandon while the sandbox start is in flight leaves no orphaned sandbox when the start completes late", async () => {
  let ran = false;
  const t = setup(async () => {
    ran = true;
  });
  const sb = t.fakes.hooks.raw.sandbox;
  const start = sb.start.bind(sb);
  let entered!: () => void;
  const inFlight = new Promise<void>((r) => (entered = r));
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  sb.start = async (spec, key) => {
    entered();
    await gate;
    return start(spec, key);
  };
  const a = await t.spawn();
  await inFlight;
  const mid = await abandonAgent(t.daemon, a.id);
  assert.equal(mid.outcome, "released", "a kill of a not-yet-existing id is an idempotent success, not a left outcome (exit 13)");
  open();
  await t.orchestrator.idle();
  assert.equal((await rec(t, a.id)).exitCause, "abandoned");
  assert.equal(sb.started.length, 1, "the late start did create a sandbox");
  assert.ok(
    [...sb.running.values()].every((r) => r.exitCode !== null),
    "the sandbox the late start created was killed or stopped, not orphaned",
  );
  assert.equal(ran, false, "the abandoned run's harness never ran");
});

test("abandoning a run with a live driver releases its credentials, model key and placement slot at once", async () => {
  const unstaged: string[] = [];
  const t = setup(async (c) => void (await c.stopped), {
    credentials: { stage: () => [], unstage: (id: string) => void unstaged.push(id), providerIds: () => [] },
  });
  const released: string[] = [];
  const release = t.daemon.deps.placement.release.bind(t.daemon.deps.placement);
  t.daemon.deps.placement.release = async (id) => {
    released.push(id);
    return release(id);
  };
  const revoked: string[] = [];
  const revoke = t.daemon.deps.gateway.revoke.bind(t.daemon.deps.gateway);
  t.daemon.deps.gateway.revoke = async (id) => {
    revoked.push(id);
    return revoke(id);
  };
  const a = await t.spawn();
  await until(async () => (await t.daemon.get(a.id))?.sandbox != null);
  released.length = 0;
  unstaged.length = 0;
  revoked.length = 0;
  await abandonAgent(t.daemon, a.id);
  assert.deepEqual(
    [unstaged.includes(a.id), released.includes(a.id), revoked.includes(a.id)],
    [true, true, true],
    "released by the abandon itself, before the driver settles",
  );
  await t.orchestrator.idle();
});

test("the root supervisor cannot be abandoned: 409 with the cause and the action, over the API too", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  await assert.rejects(
    () => abandonAgent(t.daemon, root.id),
    (e: unknown) => e instanceof LifecycleError && e.status === 409 && /root supervisor.*cannot be abandoned.*abandon the child agents/.test(e.message),
  );
  const r = await handle(t.daemon, { method: "POST", url: `/v1/agents/${root.id}/abandon`, body: { idempotencyKey: "k" }, token: op });
  assert.equal(r.status, 409);
  assert.equal((await rec(t, root.id)).state, "running", "the root is untouched");
});

// A held agent (its sandbox is on a backend this daemon cannot reach) is never force-resumed, watchdog-restarted or key-revoked.
async function heldWorld() {
  let clock = Date.now();
  const t = setup(async () => {}, { now: () => clock, watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100, maxRetries: 3 } });
  const a = await holder(t, "h", "sb-d", "docker");
  const quiet = console.error;
  console.error = () => {};
  try {
    await t.daemon.recover();
  } finally {
    console.error = quiet;
  }
  await t.daemon.deps.workspace.create(a.id, {});
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "s",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: null,
      remainingBudgetMicros: 1,
      imageDigest: "i",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    } as never,
    "cp",
  );
  const revoked: string[] = [];
  const revoke = t.daemon.deps.gateway.revoke.bind(t.daemon.deps.gateway);
  t.daemon.deps.gateway.revoke = async (id) => {
    revoked.push(id);
    return revoke(id);
  };
  return {
    t,
    a,
    revoked,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a held agent is skipped by forceResume and refused by an operator forced resume; its key is not revoked", async () => {
  const { t, a, revoked } = await heldWorld();
  assert.equal(await t.daemon.forceResume(await rec(t, a.id), a.generation, "watchdog"), "skipped");
  await assert.rejects(
    () => t.daemon.resumeAgent(a.id, undefined, { forced: true, operator: true }),
    (e: unknown) => e instanceof LifecycleError && e.status === 409 && /held.*pomtree abandon/.test(e.message),
  );
  assert.deepEqual(revoked, []);
  assert.equal((await rec(t, a.id)).generation, a.generation);
  assert.equal(kills(t).length + t.fakes.hooks.raw.sandbox.stopCalls.length, 0);
});

test("a watchdog sweep leaves a held agent alone", async () => {
  const { t, a, revoked, advance } = await heldWorld();
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: Date.now(), retries: 0 }, "seed");
  advance(2_000);
  await t.daemon.sweepWatchdogs();
  assert.equal(((await t.fakes.watchdogs.get(a.id))?.restarts ?? []).length, 0, "no restart was recorded for it");
  assert.deepEqual(revoked, []);
  const r = await rec(t, a.id);
  assert.deepEqual([r.state, r.generation, r.sandbox], ["running", a.generation, "sb-d"]);
  assert.equal(kills(t).length + t.fakes.hooks.raw.sandbox.stopCalls.length, 0);
});

test("doctor lists the held agents by id, and nothing once they are abandoned", async () => {
  const { t, a } = await heldWorld();
  assert.deepEqual((await t.daemon.doctor()).heldAgents, [a.id]);
  await abandonAgent(t.daemon, a.id);
  await t.daemon.recover();
  assert.equal("heldAgents" in (await t.daemon.doctor()), false);
});
