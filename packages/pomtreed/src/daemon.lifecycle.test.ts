import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { handle } from "./api.ts";
import { Daemon } from "./daemon.ts";
import { agentIdFor } from "./lifecycle.ts";
import { get, kinds, op, setup, spawnSpec, until } from "./test-setup.ts";
import type { Ctx } from "./test-setup.ts";

const child = (c: Ctx, task: string, key = "c1", extra: object = {}) => c.api("POST", "/v1/agents", { task, idempotencyKey: key, ...extra });
const gate = () => {
  let open = () => {};
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

test("a failing child wakes its parent with child_exited in mailbox and journal", async () => {
  let got: Signal[] = [];
  const t = setup(async (c) => {
    if (c.prompt === "boom") return void (await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: "no" } }));
    const kid = (await child(c, "boom")).body as AgentRecord;
    const r = await c.api("GET", "/v1/agents/self/inbox?waitMs=2000");
    got = r.body as Signal[];
    await until(async () => (await t.daemon.get(kid.id))!.state === "exited");
    got = (await c.api("GET", "/v1/agents/self/inbox")).body as Signal[];
    await c.api("POST", `/v1/agents/${kid.id}/reap`);
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.deepEqual(
    got.map((s) => s.kind),
    ["child_result", "child_exited"],
  );
  assert.equal((got[1] as { exit: string }).exit, "failed");
  assert.ok(kinds(await t.journal.read({ agent: a.id })).includes("signal"));
  assert.equal((await get(t, a.id)).exit, "succeeded");
});

test("a dead parent's children are cancelled", async () => {
  const kidId = { v: "" };
  const t = setup(async (c) => {
    if (c.prompt === "sleep") return void (await c.stopped);
    kidId.v = ((await child(c, "sleep")).body as AgentRecord).id;
    await until(async () => ((await t.daemon.get(kidId.v)) as AgentRecord).state === "running");
    await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: "bye" } });
  });
  await t.spawn();
  await t.orchestrator.idle();
  const k = await get(t, kidId.v);
  assert.equal(k.exit, "cancelled");
  assert.ok(kinds(await t.journal.read({ agent: kidId.v })).includes("signal"));
});

test("result succeeded is refused while children are unreaped, and lists them", async () => {
  let refused: { status: number; body: any } | undefined;
  let after = 0;
  const t = setup(async (c) => {
    if (c.prompt === "quick") return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
    const kid = (await child(c, "quick")).body as AgentRecord;
    await c.api("GET", `/v1/agents/${kid.id}/wait?timeoutMs=2000`);
    refused = await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "early" } });
    await c.api("POST", `/v1/agents/${kid.id}/reap`);
    after = (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "late" } })).status;
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(refused!.status, 409);
  assert.equal(refused!.body.children.length, 1);
  assert.equal(after, 200);
  assert.deepEqual((await get(t, a.id)).result, { summary: "ok", value: "late" });
});

test("nested budgets are carved from the parent and returned on reap", async () => {
  let reaped: any;
  let over = 0;
  let kidId = "";
  const t = setup(async (c) => {
    if (c.prompt === "spend") {
      c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 300 });
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
    }
    over = (await child(c, "spend", "big", { budgetMicros: 99_999 })).status;
    const kid = (await child(c, "spend", "ok", { budgetMicros: 2_000 })).body as AgentRecord;
    kidId = kid.id;
    assert.equal(kid.budgetMicros, 2_000);
    await c.api("GET", `/v1/agents/${kid.id}/wait?timeoutMs=2000`);
    reaped = (await c.api("POST", `/v1/agents/${kid.id}/reap`)).body;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  await t.spawn("k", { budgetMicros: 5_000 });
  await t.orchestrator.idle();
  assert.equal(over, 409);
  assert.equal(reaped.unusedMicros, 1_700);
  assert.equal(reaped.record.id, kidId);
  assert.equal(reaped.record.state, "reaped");
});

test("fan-out and depth bounds are enforced at spawn", async () => {
  const statuses: number[] = [];
  const g = gate();
  const t = setup(
    async (c) => {
      if (c.prompt === "idle") return void (await c.stopped);
      if (c.prompt === "leaf") return void (await g.p);
      statuses.push((await child(c, "idle", "a")).status);
      statuses.push((await child(c, "idle", "b")).status);
      await g.p;
      await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: 0 } });
    },
    { limits: { maxDepth: 1, maxChildren: 1, zombieMs: 600_000, zombieSweepMs: 30_000 } },
  );
  await t.spawn();
  await until(() => statuses.length === 2);
  assert.deepEqual(statuses, [409, 409]); // depth 2 exceeds maxDepth 1
  g.open();
  await t.orchestrator.idle();

  const t2 = setup(
    async (c) => {
      if (c.prompt === "idle") return void (await c.stopped);
      statuses.length = 0;
      statuses.push((await child(c, "idle", "a")).status);
      statuses.push((await child(c, "idle", "b")).status);
      await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: 0 } });
    },
    { limits: { maxDepth: 4, maxChildren: 1, zombieMs: 600_000, zombieSweepMs: 30_000 } },
  );
  await t2.spawn();
  await t2.orchestrator.idle();
  assert.deepEqual(statuses, [201, 409]);
});

test("agent spawn is idempotent per parent key", async () => {
  const ids: string[] = [];
  const t = setup(async (c) => {
    if (c.prompt === "idle") return void (await c.stopped);
    for (let i = 0; i < 2; i++) ids.push(((await child(c, "idle", "same")).body as AgentRecord).id);
    await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: 0 } });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal(ids[0], ids[1]);
  assert.equal((await t.daemon.deps.registry.list({})).filter((r) => r.parent === ids[0]).length, 0);
  assert.equal((await t.daemon.deps.registry.list({})).filter((r) => r.id === ids[0]).length, 1);
});

test("zombies raise one alert in the journal after the time limit", async () => {
  let now = Date.now();
  const g = gate();
  let kidId = "";
  const t = setup(
    async (c) => {
      if (c.prompt === "quick") return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
      const kid = (await child(c, "quick")).body as AgentRecord;
      kidId = kid.id;
      await c.api("GET", `/v1/agents/${kid.id}/wait?timeoutMs=2000`);
      await g.p;
      await c.api("POST", `/v1/agents/${kid.id}/reap`);
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
    },
    { now: () => now, limits: { maxDepth: 4, maxChildren: 8, zombieMs: 500, zombieSweepMs: 30_000 } },
  );
  await t.spawn();
  await until(async () => kidId !== "" && (await get(t, kidId)).state === "exited");
  assert.deepEqual(await t.daemon.sweepZombies(), []);
  now += 1_000;
  assert.deepEqual(await t.daemon.sweepZombies(), [kidId]);
  await t.daemon.sweepZombies();
  const alerts = (await t.journal.read({ agent: kidId })).filter((e) => e.payload.kind === "error");
  assert.equal(alerts.length, 1);
  g.open();
  await t.orchestrator.idle();
});

test("wait times out on a running agent and returns once it is done", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).state === "running");
  const early = (await t.operator("GET", `/v1/agents/${a.id}/wait?timeoutMs=30`)).body as { done: boolean };
  assert.equal(early.done, false);
  const pending = t.operator("GET", `/v1/agents/${a.id}/wait?timeoutMs=5000`);
  await t.daemon.kill(a.id);
  assert.equal(((await pending).body as { done: boolean }).done, true);
  await t.orchestrator.idle();
});

test("agents may address their own children but not others'", async () => {
  const out: Record<string, number> = {};
  const g = gate();
  let kidId = "";
  const t = setup(async (c) => {
    if (c.prompt === "kid") return void (await g.p);
    if (c.prompt === "peer") {
      await until(() => kidId !== "");
      out.peer = (await c.api("GET", `/v1/agents/${kidId}`)).status;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
    }
    kidId = ((await child(c, "kid")).body as AgentRecord).id;
    out.own = (await c.api("GET", `/v1/agents/${kidId}`)).status;
    await until(() => "peer" in out);
    g.open();
    await c.api("GET", `/v1/agents/${kidId}/wait?timeoutMs=2000`);
    await c.api("POST", `/v1/agents/${kidId}/reap`);
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  await t.spawn("p1");
  await t.operator("POST", "/v1/agents", { name: "peer", task: "peer", idempotencyKey: "p2" });
  await t.orchestrator.idle();
  assert.deepEqual(out, { own: 200, peer: 403 });
});

test("recover cancels live children whose parent is already done", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const p = await reg.create({ spec: spawnSpec, parent: root.id, name: "p", task: "t", host: "h1", budgetMicros: 10, idempotencyKey: "p" });
  await reg.transition(p.id, p.generation, "running", { idempotencyKey: "p-run" });
  await reg.transition(p.id, p.generation, "exited", { exit: "failed", idempotencyKey: "p-exit" });
  const k = await reg.create({ spec: spawnSpec, parent: p.id, name: "k", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "k" });
  await reg.transition(k.id, k.generation, "running", { idempotencyKey: "k-run" });
  await t.daemon.recover();
  await t.orchestrator.idle();
  const after = await get(t, k.id);
  assert.ok(after.state === "exited" || after.state === "reaped");
  assert.notEqual(after.exit, "succeeded");
});

test("root() is stable across calls and recover() works against a replaying create", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const reg = t.daemon.deps.registry;
  const first = await t.daemon.root();
  const original = { ...first, state: "pending" as const };
  // A real store replays the original pending snapshot on an idempotent create.
  const replay = Object.create(reg, { create: { value: async (o: Parameters<typeof reg.create>[0]) => (await reg.create(o), original) } });
  const d2 = new (t.daemon.constructor as typeof import("./daemon.ts").Daemon)({ ...t.daemon.deps, registry: replay });
  assert.equal((await d2.root()).state, "running");
  assert.equal((await d2.root()).id, first.id);
  await d2.recover();
  await t.orchestrator.idle();
});

test("reaping keeps the folder; the cleanup sweep evicts it once and journals workspace_evicted", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const a = await t.spawn();
  await t.orchestrator.idle(); // root supervisor reaps at once
  const evicts = () => t.fakes.calls.filter((c) => c.port === "Workspace" && c.method === "evict");
  assert.equal(evicts().length, 0, "reap itself does not touch the folder");
  assert.ok(t.fakes.hooks.raw.workspace.workspaces.has(a.id));
  await t.daemon.reap(a.id);
  assert.equal((await get(t, a.id)).state, "reaped");
  await t.daemon.sweepCleanup();
  await t.daemon.sweepCleanup();
  assert.equal(evicts().length, 1, "evicted once; the second sweep finds no folder");
  assert.equal(t.fakes.hooks.raw.workspace.workspaces.has(a.id), false);
  const ev = (await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "workspace_evicted");
  assert.equal(ev.length, 1);
  assert.equal((ev[0]!.payload as { reason: string }).reason, "reaped");
});

test("wait ignores an exited entry from an earlier generation", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "gen" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.journal.append({ agent: a.id, host: "h1", generation: a.generation, payload: { kind: "exited", exit: "failed" }, idempotencyKey: "old-exit" });
  const bumped = await reg.bumpGeneration(a.id, "h1", "a-bump");
  assert.ok(bumped.generation > a.generation);
  const started = Date.now();
  const w = await t.daemon.waitDone(a.id, 120);
  assert.equal(w.done, false);
  assert.ok(Date.now() - started >= 100);
});

test("a root child is reaped; its exited leaf is held for the operator (custody), not reaped, and is not yet a zombie", async () => {
  const ids: string[] = [];
  const t = setup(async (c) => {
    if (c.prompt === "leaf") return void (await c.stopped);
    if (c.prompt === "mid") {
      ids.push(((await child(c, "leaf")).body as AgentRecord).id);
      await until(async () => ((await t.daemon.get(ids[0]!)) as AgentRecord).state === "running");
      return void (await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: 0 } }));
    }
  });
  const mid = await t.spawn("m", { task: "mid" });
  await t.orchestrator.idle();
  assert.equal((await get(t, mid.id)).state, "reaped");
  assert.equal((await get(t, ids[0]!)).state, "exited", "custody: the dead parent's exited leaf is held, never auto-reaped");
  assert.deepEqual(await t.daemon.sweepZombies(), []);
});

test("children that exited before their parent died are held for custody, not reaped with it", async () => {
  let kid = "";
  const t = setup(async (c) => {
    if (c.prompt === "quick") return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
    kid = ((await child(c, "quick")).body as AgentRecord).id;
    await c.api("GET", `/v1/agents/${kid}/wait?timeoutMs=2000`);
    await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: 0 } });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, kid)).state, "exited");
});

test("a queued agent is started when a slot frees, and a cancelled queued agent gives its slot back", async () => {
  const g = gate();
  const t = setup(
    async (c) => {
      if (c.prompt === "hold") return void (await g.p);
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: c.prompt } });
    },
    { admitRetryMs: 60_000 },
  );
  // setup's placement allows 8; fill it, then queue two more.
  for (let i = 0; i < 8; i++) await t.spawn(`h${i}`, { task: "hold" });
  await until(async () => ((await t.operator("GET", "/v1/agents?state=running")).body as unknown[]).length >= 9);
  const q1 = await t.spawn("q1", { task: "queued" });
  const q2 = await t.spawn("q2", { task: "queued" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await get(t, q1.id)).state, "pending");
  await t.daemon.stop(q2.id, 10); // cancelled while queued
  g.open();
  await t.orchestrator.idle();
  assert.deepEqual((await get(t, q1.id)).result, { summary: "ok", value: "queued" }); // promoted by the callback, not the 60s retry
  assert.equal((await get(t, q2.id)).exit, "cancelled");
});

test("kill while admitted but before the sandbox starts finishes cancelled without running the harness", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  const g = gate();
  let reached = false;
  const blocking = Object.create(raw.sandbox) as typeof raw.sandbox;
  blocking.start = async (spec: Parameters<typeof raw.sandbox.start>[0], key: Parameters<typeof raw.sandbox.start>[1]) => {
    reached = true;
    await g.p;
    return raw.sandbox.start(spec, key);
  };
  const d = new Daemon({ ...t.daemon.deps, sandbox: blocking });
  const a = (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: "k" } })).body as AgentRecord;
  await until(() => reached);
  await d.kill(a.id); // admitted, no sandbox yet: must set cancelled and let settle finish
  g.open();
  await t.orchestrator.idle();
  const r = (await d.get(a.id))!;
  assert.equal(r.exit, "cancelled");
  assert.equal(raw.harness.starts.length, 0); // the exited agent never started a session
});

test("a pending retry re-runs the keyed spawned entry and start", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const root = await t.daemon.root();
  const id = agentIdFor(root.id, "k");
  await t.daemon.deps.registry.create({
    spec: spawnSpec,
    id,
    parent: root.id,
    name: "w",
    task: "t",
    host: "h1",
    budgetMicros: 10,
    idempotencyKey: "root:k",
  });
  assert.equal((await t.journal.read({ agent: id })).length, 0); // crashed between create and journal/start
  const a = await t.spawn("k");
  assert.equal(a.id, id);
  assert.ok(kinds(await t.journal.read({ agent: id })).includes("spawned")); // replayed
  await t.orchestrator.idle();
  assert.equal((await t.daemon.get(id))!.exit, "succeeded"); // orchestrator.start drove it
});

test("recover replays the finish tail for exited-but-unreaped agents", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await reg.transition(a.id, a.generation, "exited", { exit: "failed", idempotencyKey: "a-exit" });
  assert.equal((await t.journal.read({ agent: a.id })).length, 0); // crashed right after the transition
  await t.daemon.recover();
  const r = (await reg.get(a.id))!;
  assert.equal(r.state, "reaped");
  assert.ok(kinds(await t.journal.read({ agent: a.id })).includes("exited:failed"));
});

test("settle falls back to a failed finish on a non-fence throw", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  const reg = Object.create(raw.registry) as typeof raw.registry;
  const baseTransition = raw.registry.transition.bind(raw.registry);
  let boom = true;
  reg.transition = async (id, gen, to, o) => {
    if (to === "exited" && boom) {
      boom = false;
      throw new Error("journal unwritable");
    }
    return baseTransition(id, gen, to, o);
  };
  const d = new Daemon({ ...t.daemon.deps, registry: reg });
  const a = (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: "k" } })).body as AgentRecord;
  await t.orchestrator.idle();
  const r = (await d.get(a.id))!;
  assert.equal(r.exit, "failed"); // not left running with no sandbox
  assert.equal(r.state, "reaped");
});

test("top-level default budget applies to operator spawns without a budget, not to agent spawns", async () => {
  let kid: AgentRecord | undefined;
  const t = setup(
    async (c) => {
      if (c.prompt === "quick") return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } }));
      kid = (await child(c, "quick")).body as AgentRecord;
      await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: 0 } });
    },
    { rootBudgetMicros: 1_000_000, defaultBudgetMicros: 1_000, topLevelBudgetMicros: 50_000 },
  );
  const a = await t.spawn();
  assert.equal(a.budgetMicros, 50_000);
  await t.orchestrator.idle();
  assert.equal(kid!.budgetMicros, 1_000);
  const b = (await t.operator("POST", "/v1/agents", { name: "x", task: "quick", idempotencyKey: "e", budgetMicros: 7_000 })).body as AgentRecord;
  assert.equal(b.budgetMicros, 7_000);
});

test("a failed provider-attempt reset on exit is logged with its cause and does not block the exit", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void logged.push(a.join(" ")));
  const s = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const raw = s.fakes.hooks.raw;
  const reg = Object.create(raw.registry) as typeof raw.registry;
  reg.resetProviderAttempts = async () => {
    throw new Error("attempt-store-unreachable");
  };
  const d = new Daemon({ ...s.daemon.deps, registry: reg });
  const a = (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: "k" } })).body as AgentRecord;
  await s.orchestrator.idle();
  assert.ok(["exited", "reaped"].includes((await d.get(a.id))!.state));
  const hits = logged.filter((m) => m.includes(a.id) && m.includes("attempt-store-unreachable"));
  assert.equal(hits.length, 1, logged.join("\n"));
});
