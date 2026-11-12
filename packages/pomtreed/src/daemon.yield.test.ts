import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, CheckpointStore, WaitCondition } from "@pomtree/core";
import { FakeModelDebitStore } from "@pomtree/testing";
import { DEFAULT_CONTAINER_CONFIG, SANDBOX_LIFECYCLE_KIND } from "./daemon-util.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { get, kinds, SECRET, setup, spawnSpec, until } from "./test-setup.ts";

const journalKinds = async (t: ReturnType<typeof setup>, id: string) => kinds(await t.journal.read({ agent: id }));

test("yield writes a checkpoint, transitions to yielded, and keeps the branch", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();

  const rec = await get(t, aId);
  assert.equal(rec.state, "yielded");
  assert.equal(rec.exit, null);

  const cp = (await t.daemon.deps.checkpoints.latest(aId))!;
  assert.ok(cp, "checkpoint written");
  assert.equal(cp.agent, aId);
  assert.equal(cp.generation, rec.generation);
  assert.equal((cp.wait as WaitCondition).kind, "message");
  assert.equal(typeof cp.sessionRef, "string");
  assert.equal(typeof cp.imageDigest, "string");
  assert.equal(cp.imageDigest, "img@sha256:x@sha256:fake");
  assert.equal(cp.envManifestHash, null);

  const kindsSeen = await journalKinds(t, aId);
  assert.ok(kindsSeen.includes("yielded"));
  assert.ok(!kindsSeen.includes("exited:failed"), "no spurious exited after yield");
  // The branch is kept: yield commits but never removes the worktree.
  assert.ok(!t.fakes.calls.some((c) => c.port === "Workspace" && c.method === "remove"));
});

test("a message signal wakes and resumes from the checkpoint", async () => {
  let aId = "";
  let wakeSeen = "";
  const t = setup(async (c) => {
    if (c.wake) {
      wakeSeen = c.wake;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const genBefore = (await t.daemon.deps.checkpoints.latest(aId))!.generation;

  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "hello", root.generation, "m1");
  await t.orchestrator.idle();

  const after = await get(t, aId);
  assert.ok(after.generation > genBefore, "generation bumped on resume");
  assert.ok((await journalKinds(t, aId)).includes("resumed"));
  assert.equal(wakeSeen, "hello");
  assert.deepEqual(after.result, { summary: "ok", value: "woke" });
});

test("resume issues the key with the agent's TOTAL budget, not the remaining budget", async () => {
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const gateway = t.daemon.deps.gateway;
  const issued: { agent: string; budgetMicros: number }[] = [];
  const issue = gateway.issueKey.bind(gateway);
  gateway.issueKey = async (agent, budgetMicros, idempotencyKey) => {
    issued.push({ agent, budgetMicros });
    return issue(agent, budgetMicros, idempotencyKey);
  };
  const spend = gateway.spend.bind(gateway);
  gateway.spend = async (agent) => ({ ...(await spend(agent)), spentMicros: agent === aId ? 40 : 0 });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const total = (await get(t, aId)).budgetMicros;
  assert.ok(total > 40);
  assert.equal((await t.daemon.deps.checkpoints.latest(aId))!.remainingBudgetMicros, total - 40);

  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "hello", root.generation, "m1");
  await t.orchestrator.idle();

  const mine = issued.filter((m) => m.agent === aId);
  assert.deepEqual(
    mine.map((m) => m.budgetMicros),
    [total, total],
  );
});

test("resume passes the wake text (not the task) to the sandbox command", async () => {
  let aId = "";
  const seen: string[] = [];
  const t = setup(
    async (c) => {
      if (c.wake) {
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } }));
      }
      aId = c.agent;
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
    },
    { command: (task) => (seen.push(task), [task]) },
  );
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");

  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "hello", root.generation, "m1");
  await t.orchestrator.idle();

  // The fresh segment's sandbox command is the task; the resume segment's is the wake text.
  assert.deepEqual(seen, ["do it", "hello"]);
});

test("child_exited wakes a yielded parent", async () => {
  let pId = "";
  let cId = "";
  const t = setup(async (c) => {
    if (c.wake) {
      await c.api("POST", `/v1/agents/${cId}/reap`);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: c.wake } }));
    }
    if (c.prompt === "child") {
      cId = c.agent;
      // Exit only after the parent has yielded so the wake lands while it is yielded.
      await until(async () => (await get(t, pId)).state === "yielded");
      return void (await c.api("POST", "/v1/agents/self/result", { status: "failed", result: { summary: "ok", value: "boom" } }));
    }
    pId = c.agent;
    const kid = (await c.api("POST", "/v1/agents", { task: "child", idempotencyKey: "c1" })).body as AgentRecord;
    cId = kid.id;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "child_exited", children: [kid.id], mode: "any" }, idempotencyKey: "y1" });
  });
  await t.spawn("p", { task: "parent" });
  await t.orchestrator.idle();

  const p = await get(t, pId);
  assert.ok(p.generation > 0);
  assert.ok((await journalKinds(t, pId)).includes("resumed"));
  assert.equal((p.result as { value: string }).value, `child ${cId} exited failed. Handoff: ok`);
});

test("operator resume works", async () => {
  let aId = "";
  let wakeSeen = "";
  const t = setup(async (c) => {
    if (c.wake) {
      wakeSeen = c.wake;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const genBefore = (await t.daemon.deps.checkpoints.latest(aId))!.generation;

  const res = await t.operator("POST", `/v1/agents/${aId}/resume`);
  assert.equal(res.status, 200);
  await t.orchestrator.idle();

  const after = await get(t, aId);
  assert.ok(after.generation > genBefore);
  assert.equal(wakeSeen, "operator resumed you");
  assert.ok((await journalKinds(t, aId)).includes("resumed"));
});

test("operator can read an agent's checkpoint", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  const res = await t.operator("GET", `/v1/agents/${aId}/checkpoint`);
  assert.equal(res.status, 200);
  assert.equal((res.body as { agent: string }).agent, aId);
});

test("kill_resume resumes from a checkpoint", async () => {
  let clock = Date.now();
  const t = setup(
    async (c) => {
      if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "resumed" } }));
      await c.stopped;
    },
    { now: () => clock, watchdogOptions: { stallMs: 1_000, graceMs: 500, failureLimit: 100, maxRetries: 1 } },
  );
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );
  await t.fakes.watchdogs.set(a.id, { rung: "cancelled", lastActionAt: clock, retries: 0 }, "seed");
  clock += 2_000;
  await t.daemon.sweepWatchdogs();
  await t.orchestrator.idle();

  const after = await get(t, a.id);
  assert.ok(after.generation > 0, "generation bumped by the forced resume");
  assert.ok((await journalKinds(t, a.id)).includes("resumed"));
});

test("a wake landing while the yield teardown still holds the prior run is not dropped", async () => {
  let aId = "";
  let wakeSeen = "";
  const t = setup(async (c) => {
    if (c.wake) {
      wakeSeen = c.wake;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "resumed" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });

  // Hold settleYield's gateway.revoke so the prior drive run stays in the orchestrator's
  // in-flight set when the wake fires (the exact window where resume() used to bail). The first revoke is yield()'s own, before
  // `yielded`; settleYield's is the second.
  const gw = t.daemon.deps.gateway;
  const origRevoke = gw.revoke.bind(gw);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let revokes = 0;
  gw.revoke = async (agent) => {
    if (revokes++ === 1) await held;
    return origRevoke(agent);
  };

  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded", 30_000).catch(() => {
    throw new Error("agent never reached yielded within 30s");
  });
  await until(() => revokes === 2, 30_000).catch(() => {
    throw new Error("prior teardown never reached revoke within 30s");
  }); // the prior teardown is now parked inside revoke

  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "hello", root.generation, "m1");
  await new Promise((r) => setTimeout(r, 10)); // let the wake attempt the resume while still held
  release();
  await t.orchestrator.idle();

  assert.ok((await journalKinds(t, aId)).includes("resumed"), "resume must not be silently dropped");
  assert.equal(wakeSeen, "hello");
  assert.deepEqual((await get(t, aId)).result, { summary: "ok", value: "resumed" });
});

// The yield teardown race (live YLD-1/BUD-1): the pump ends as soon as the yield stops the session, so settleYield runs alongside
// yield()'s own container stop. A wake landing right at `yielded` bumps the agent and stages the new generation's runtime while the
// old settleYield is still suspended in its stop; the late teardown must not unstage, revoke or release what the new generation owns.
// The fixture holds settleYield's container stop (the second stop of the first sandbox; the first is yield()'s own) until `release`.
function lateYieldSettle() {
  const staged = new Set<string>();
  const unstages: string[] = [];
  const credentials = {
    stage: (id: string) => {
      staged.add(id);
      return [];
    },
    unstage: (id: string) => {
      unstages.push(id);
      staged.delete(id);
    },
    providerIds: () => [],
  };
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) return void (await c.stopped); // the resumed generation stays running
      aId = c.agent;
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
    },
    { credentials: credentials as never },
  );
  // A durable debit store, so a revoke is per agent (every key issued before it), as in production.
  const d = t.daemon;
  const gw = new ProxyCredentialGateway({
    journal: d.deps.journal,
    registry: d.deps.registry,
    secret: SECRET,
    proxyBaseUrl: "http://m",
    tokenTtlMs: 3_600_000,
    debits: new FakeModelDebitStore({ secret: SECRET }),
  });
  (d.deps as unknown as { gateway: typeof gw }).gateway = gw;
  const keys: string[] = [];
  const issue = gw.issueKey.bind(gw);
  gw.issueKey = async (agent, budget, idem) => {
    const k = await issue(agent, budget, idem);
    keys.push(k.key);
    return k;
  };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first: string | null = null;
  let heldStops = 0;
  const realStop = t.sandbox.stop.bind(t.sandbox);
  t.sandbox.stop = async (id, graceMs, key) => {
    first ??= id;
    if (id === first && heldStops++ > 0) await held;
    return realStop(id, graceMs, key);
  };
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  const parked = async () => {
    await until(async () => aId !== "" && (await get(t, aId)).state === "yielded" && heldStops >= 2).catch(() => {
      throw new Error("the agent never yielded with settleYield's container stop held (stop order changed?)");
    });
  };
  const restore = () => {
    console.error = realError;
  };
  return { t, staged, unstages, keys, gw, release, errors, parked, id: () => aId, restore };
}

test("a wake at `yielded` while the old settleYield is still stopping leaves the new generation's credentials, key and slot intact", async () => {
  const f = lateYieldSettle();
  try {
    await f.t.spawn();
    await f.parked();
    const gen0 = (await get(f.t, f.id())).generation;
    const root = await f.t.daemon.root();
    await f.t.daemon.sendMessage(root.id, f.id(), "hello", root.generation, "m1");
    // The live order: gen+1 issues and stages before the late teardown resumes.
    await until(() => f.keys.length === 2 && f.staged.has(f.id())).catch(() => {
      throw new Error("the resume never issued and staged gen+1 while the old teardown was held");
    });
    f.release();
    await until(async () => {
      const r = await get(f.t, f.id());
      return r.state === "running" && r.generation > gen0 && f.keys.length === 2 && r.sandbox !== null;
    }).catch(() => {
      throw new Error("the resumed generation never reached running with a fresh key and container");
    });
    await new Promise((r) => setTimeout(r, 50)); // any late teardown of the old generation has run by now
    const r = await get(f.t, f.id());
    assert.equal(r.state, "running");
    assert.equal(r.generation, gen0 + 1);
    assert.ok(f.staged.has(f.id()), "the resumed generation's staged credentials survive the old teardown");
    assert.ok(f.gw.authorize(f.keys[1] ?? ""), "the resumed generation's model key survives the old teardown");
    assert.equal(f.gw.authorize(f.keys[0] ?? ""), null, "the yielded generation's key is revoked");
    assert.equal((await f.t.fakes.hosts.getReservation(f.id()))?.state, "running", "the resumed generation keeps its placement slot");
    assert.deepEqual(
      f.errors.filter((e) => e.includes("audit write failed")),
      [],
      "no stale-generation journal write from the old teardown",
    );
    await f.t.daemon.kill(f.id());
    await f.t.orchestrator.idle();
  } finally {
    f.restore();
  }
});

// The yield contract (YLD-1): `yielded` visible implies the yielding generation's container is stopped, its exit journaled, its
// credentials unstaged, its model key revoked and its placement slot released. Snapshotted the instant the transition lands, with
// settleYield's own container stop still held, and a wake delivered right then must find them already released.
test("`yielded` becomes visible only after the yielding generation's exit is journaled and its credentials, key and slot are released", async () => {
  const f = lateYieldSettle();
  try {
    const reg = f.t.daemon.deps.registry;
    const transition = reg.transition.bind(reg);
    let seen: { keyLive: boolean; slot: string | null; exited: number; staged: boolean } | null = null;
    reg.transition = async (id, gen, state, o) => {
      const r = await transition(id, gen, state, o);
      if (state === "yielded" && id === f.id() && seen === null) {
        const rows = await f.t.journal.read({ agent: id });
        seen = {
          keyLive: f.gw.authorize(f.keys[0] ?? "") !== null,
          slot: (await f.t.fakes.hosts.getReservation(id))?.state ?? null,
          exited: rows.filter((e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { cause?: string }).cause === "yielded").length,
          staged: f.staged.has(id),
        };
        const root = await f.t.daemon.root();
        await f.t.daemon.sendMessage(root.id, id, "hello", root.generation, "m1");
      }
      return r;
    };
    await f.t.spawn();
    await f.parked().catch(() => {}); // the wake may already have resumed it past `yielded`
    f.release();
    await until(() => f.keys.length === 2 && f.staged.has(f.id())).catch(() => {
      throw new Error("the wake at `yielded` never resumed the agent with a fresh key");
    });
    assert.deepEqual(seen, { keyLive: false, slot: null, exited: 1, staged: false }, "torn down before `yielded` was visible");
    await new Promise((r) => setTimeout(r, 50)); // the late settleYield has run by now
    assert.ok(f.gw.authorize(f.keys[1] ?? ""), "the resumed generation's key survives the late settle");
    assert.ok(f.staged.has(f.id()), "the resumed generation's credentials survive the late settle");
    assert.equal((await f.t.fakes.hosts.getReservation(f.id()))?.state, "running", "the resumed generation keeps its slot");
    assert.deepEqual(
      f.errors.filter((e) => e.includes("audit write failed")),
      [],
    );
    await f.t.daemon.kill(f.id());
    await f.t.orchestrator.idle();
  } finally {
    f.restore();
  }
});

test("a late settleYield with no newer generation still runs its teardown, which leaves the yield's in place (negative control)", async () => {
  const f = lateYieldSettle();
  try {
    await f.t.spawn();
    await f.parked();
    const gen0 = (await get(f.t, f.id())).generation;
    assert.deepEqual(f.unstages, [f.id()], "yield() unstaged before `yielded`; settleYield is still held");
    f.release();
    await f.t.orchestrator.idle();
    await until(() => f.unstages.length === 2).catch(() => {
      throw new Error("the late settleYield, owning its entry, never ran its own unstage");
    });
    assert.ok(!f.staged.has(f.id()));
    const r = await get(f.t, f.id());
    assert.equal(r.state, "yielded");
    assert.equal(r.generation, gen0);
    assert.equal(f.gw.authorize(f.keys[0] ?? ""), null, "the yielded generation's key is revoked");
    assert.equal(await f.t.fakes.hosts.getReservation(f.id()), null, "the placement slot is released");
    const exited = (await f.t.journal.read({ agent: f.id() })).filter(
      (e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { phase?: string }).phase === "exited",
    );
    assert.equal(exited.length, 1, "the yielded generation's sandbox exit is journaled");
    assert.equal((exited[0]?.payload as { cause?: string } | undefined)?.cause, "yielded");
    assert.deepEqual(
      f.errors.filter((e) => e.includes("audit write failed")),
      [],
    );
  } finally {
    f.restore();
  }
});

// The fence at its narrowest: a yield teardown that starts after a resume already replaced the live entry (a settle that read the
// generation before the bump, or the adopt path, which calls settleYield with no generation check) skips every id-keyed action.
test("a yield teardown that starts after a resume replaced the live entry unstages, revokes and releases nothing", async () => {
  const unstaged: string[] = [];
  const t = setup(async (c) => void (await c.stopped), {
    credentials: { stage: () => [], unstage: (id: string) => void unstaged.push(id), providerIds: () => [] } as never,
  });
  const log: string[] = [];
  const d = t.daemon.deps as unknown as { gateway: { revoke: (a: string) => Promise<unknown> }; placement: { release: (a: string) => Promise<void> } };
  const gw = d.gateway;
  const pl = d.placement;
  d.gateway = Object.assign(Object.create(gw), {
    revoke: async (a: string) => {
      log.push("revoke");
      return gw.revoke(a);
    },
  });
  d.placement = Object.assign(Object.create(pl), {
    release: async (a: string) => {
      log.push("release");
      return pl.release(a);
    },
  });
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).sandbox !== null);
  const inner = t.daemon as unknown as {
    live: Map<string, { yielding?: boolean }>;
    lifecycle: { settleYield: (id: string, e: unknown, gen: number) => Promise<void> };
  };
  const old = inner.live.get(a.id)!;
  old.yielding = true; // the pump-end settle this stop causes also goes through settleYield
  const newer = { cancelled: false };
  inner.live.set(a.id, newer as never);
  await inner.lifecycle.settleYield(a.id, old, a.generation);
  await new Promise((r) => setTimeout(r, 50)); // the pump-end settle of the stopped run
  assert.deepEqual(unstaged, [], "no unstage");
  assert.deepEqual(log, [], "no revoke or release");
  assert.equal(inner.live.get(a.id), newer, "the newer entry is kept");
  inner.live.delete(a.id);
});

test("a pump ending during a slow checkpoint write still settles yielded, not exited", async () => {
  let aId = "";
  const slow = { on: true };
  let cpTarget: CheckpointStore | null = null;
  const cps: CheckpointStore = {
    async write(c, key) {
      if (slow.on) await new Promise((r) => setTimeout(r, 40));
      return cpTarget!.write(c, key);
    },
    latest: (agent) => cpTarget!.latest(agent),
    read: (id) => cpTarget!.read(id),
  };
  const t = setup(
    async (c) => {
      aId = c.agent;
      // Fire the yield but return immediately so the pump ends while yield() is mid-write.
      void c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
    },
    { checkpoints: cps },
  );
  cpTarget = t.fakes.checkpoints;

  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  await t.orchestrator.idle();

  const rec = await get(t, aId);
  assert.equal(rec.state, "yielded");
  assert.ok(!(await journalKinds(t, aId)).includes("exited:failed"), "no spurious exited after a racing pump end");
  assert.ok(await t.daemon.deps.checkpoints.latest(aId), "checkpoint still written");
});

test("recover resumes a yielded agent whose timer wait is past-due", async () => {
  const t = setup(async (c) => {
    if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "recovered" } }));
    await c.stopped;
  });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await reg.transition(a.id, a.generation, "yielded", { idempotencyKey: "a-yield" });
  await t.daemon.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "timer", at: Date.now() - 1_000 },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );

  await t.daemon.recover();
  await until(async () => (await journalKinds(t, a.id)).includes("resumed"));
  await t.orchestrator.idle();

  const after = await get(t, a.id);
  assert.ok(after.generation > 0);
  assert.ok((await journalKinds(t, a.id)).includes("resumed"));
});

// A forced resume of a running agent revokes the old
// model key before issuing the new one, even when the old container's kill fails.
async function forcedResumeFixture(sameMs: boolean) {
  const clock = 5_000_000;
  let tick = 0;
  const nowFn = () => (sameMs ? clock : clock + tick++);
  const t = setup(async (c) => void (await c.stopped), { now: nowFn });
  const d = t.daemon;
  const debits = new FakeModelDebitStore({ secret: SECRET, now: nowFn });
  const gw = new ProxyCredentialGateway({
    journal: d.deps.journal,
    registry: d.deps.registry,
    secret: SECRET,
    proxyBaseUrl: "http://m",
    tokenTtlMs: 3_600_000,
    now: nowFn,
    debits,
  });
  const keys: string[] = [];
  const issue = gw.issueKey.bind(gw);
  gw.issueKey = async (agent, budget, idem) => {
    const k = await issue(agent, budget, idem);
    keys.push(k.key);
    return k;
  };
  (d.deps as unknown as { gateway: typeof gw }).gateway = gw;
  const a = (await t.spawn()) as AgentRecord;
  await until(() => keys.length === 1);
  await d.deps.checkpoints.write(
    {
      agent: a.id,
      generation: a.generation,
      host: "h1",
      sessionRef: "sha256:fake",
      workspace: `ws-${a.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 50_000,
      imageDigest: "img@sha256:x",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    "cp-key",
  );
  // The old container's kill fails (partitioned/dead daemon socket): the best-effort kill is swallowed.
  const realKill = t.sandbox.kill.bind(t.sandbox);
  t.sandbox.kill = async () => {
    throw new Error("kill failed");
  };
  return {
    t,
    gw,
    keys,
    a,
    restoreKill: () => {
      t.sandbox.kill = realKill;
    },
  };
}

for (const sameMs of [false, true]) {
  test(`forced resume of a running agent revokes the old model key even when the kill fails (${sameMs ? "same" : "later"} millisecond issue)`, async () => {
    const { t, gw, keys, a, restoreKill } = await forcedResumeFixture(sameMs);
    await t.daemon.resumeAgent(a.id, "wake", { forced: true });
    await until(() => keys.length === 2);
    assert.equal(gw.authorize(keys[0] ?? ""), null, "the superseded key is rejected");
    assert.ok(gw.authorize(keys[1] ?? ""), "the fresh key works");
    // The superseded run's settle (its session was stopped) skips revocation, so it must not kill the fresh key.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(gw.authorize(keys[1] ?? ""), "the fresh key survives the superseded run's settle");
    restoreKill();
    await t.daemon.kill(a.id);
    await t.orchestrator.idle();
  });
}

// ---- signals that land while the yield is pausing (journal `pausing` written, container stopping, not yet `yielded`) ----
// The signal's own wake runs while the agent is still `running` and is dropped, so the yield must wake for it once parked.

// Run `during` inside the yield's first container stop: the window between the `pausing` marker and the `yielded` transition.
function duringPause(t: ReturnType<typeof setup>, during: () => Promise<unknown>): void {
  const realStop = t.sandbox.stop.bind(t.sandbox);
  let fired = false;
  t.sandbox.stop = async (id, graceMs, key) => {
    if (!fired) {
      fired = true;
      await during();
    }
    return realStop(id, graceMs, key);
  };
}

const resumedCount = async (t: ReturnType<typeof setup>, id: string) => (await journalKinds(t, id)).filter((k) => k === "resumed").length;

test("an answer delivered while an ask park is pausing resumes the agent exactly once (lost-wake regression)", async () => {
  const wakes: string[] = [];
  let aId = "";
  let escId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      const gen = (await t.daemon.get(c.agent))!.generation;
      const ask = (await c.api("POST", "/v1/agents/self/ask", { question: "ok?", generation: gen, idempotencyKey: "q" })).body as {
        escalation: { id: string };
      };
      escId = ask.escalation.id;
      await c.api("POST", "/v1/agents/self/park", { on: { kind: "ask", escalation: escId }, timeoutMs: 60_000, idempotencyKey: "pk" });
    },
    { containerConfig: { ...DEFAULT_CONTAINER_CONFIG, "wait.yieldMs": 20 } },
  );
  duringPause(t, () => t.daemon.answerEscalation(escId, "yes", { channel: "operator", sender: "op" }, "ans"));
  await t.spawn();
  await until(() => wakes.length > 0).catch(() => {
    throw new Error("the answer that landed during the pause never resumed the agent (lost wake)");
  });
  await t.orchestrator.idle();
  assert.deepEqual(wakes, ["Resumed: your question was answered: yes"]);
  assert.equal(await resumedCount(t, aId), 1, "exactly one resume");
  assert.deepEqual((await get(t, aId)).result, { summary: "ok", value: "ok" });
});

test("a message delivered while a yield is pausing resumes the agent exactly once (lost-wake regression)", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  duringPause(t, async () => {
    const root = await t.daemon.root();
    await t.daemon.sendMessage(root.id, aId, "hello", root.generation, "m1");
  });
  await t.spawn();
  await until(() => wakes.length > 0).catch(() => {
    throw new Error("the message that landed during the pause never resumed the agent (lost wake)");
  });
  await t.orchestrator.idle();
  assert.deepEqual(wakes, ["hello"]);
  assert.equal(await resumedCount(t, aId), 1, "exactly one resume");
});

test("a message delivered while an ask park is pausing does not release it; the later answer does, once", async () => {
  const wakes: string[] = [];
  let aId = "";
  let escId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      const gen = (await t.daemon.get(c.agent))!.generation;
      const ask = (await c.api("POST", "/v1/agents/self/ask", { question: "ok?", generation: gen, idempotencyKey: "q" })).body as {
        escalation: { id: string };
      };
      escId = ask.escalation.id;
      await c.api("POST", "/v1/agents/self/park", { on: { kind: "ask", escalation: escId }, timeoutMs: 60_000, idempotencyKey: "pk" });
    },
    { containerConfig: { ...DEFAULT_CONTAINER_CONFIG, "wait.yieldMs": 20 } },
  );
  duringPause(t, async () => {
    const root = await t.daemon.root();
    await t.daemon.sendMessage(root.id, aId, "chatter", root.generation, "m1");
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded", "a plain message does not release an ask park");
  assert.equal(wakes.length, 0);
  await t.daemon.answerEscalation(escId, "yes", { channel: "operator", sender: "op" }, "ans");
  await t.orchestrator.idle();
  assert.deepEqual(wakes, ["Resumed: your question was answered: yes"]);
  assert.equal(await resumedCount(t, aId), 1, "exactly one resume");
});

test("a message queued before the yield was requested does not wake the parked agent (unchanged); a later one does", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    aId = c.agent;
    const root = await t.daemon.root();
    await t.daemon.sendMessage(root.id, aId, "before", root.generation, "m0"); // visible to the agent before it yields
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded", "the pre-yield message counts as seen");
  assert.equal(wakes.length, 0);
  const root = await t.daemon.root();
  await t.daemon.sendMessage(root.id, aId, "after", root.generation, "m1");
  await t.orchestrator.idle();
  assert.deepEqual(wakes, ["after"]);
  assert.equal(await resumedCount(t, aId), 1);
});

// Crash recovery of a pause (completePause): the `pausing` marker carries the inbox seen at the yield request, so a signal that
// arrived during the pause wakes the agent once the pause is completed; one the marker lists does not.
for (const listed of [false, true]) {
  test(`a crash mid-pause: a message that ${listed ? "the marker lists as seen does not wake" : "arrived during the pause wakes"} the completed pause`, async () => {
    const wakes: string[] = [];
    const t = setup(async (c) => {
      if (c.wake !== undefined) wakes.push(c.wake);
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
    });
    const reg = t.daemon.deps.registry;
    const root = await t.daemon.root();
    const a0 = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
    const a = await reg.transition(a0.id, a0.generation, "running", { idempotencyKey: "a-run" });
    await t.daemon.deps.workspace.create(a.id, {});
    const sb = await t.fakes.hooks.raw.sandbox.start({ host: "h1", generation: 0, agent: a.id, image: "img", env: {}, mounts: [] }, "a-sb");
    await reg.setSandbox(a.id, a.generation, sb.id, "a-sb-set");
    await t.fakes.hooks.raw.sandbox.kill(sb.id, `test-kill:${sb.id}`); // the daemon died after the stop
    await t.daemon.deps.mailbox.send(a.id, { kind: "message", from: root.id, body: "hello" }, "m1");
    const msgId = (await t.daemon.deps.mailbox.peek(a.id))[0]!.id;
    await t.journal.append({
      agent: a.id,
      host: "h1",
      generation: a.generation,
      payload: { kind: "pausing", reason: "yield", key: "y1", wait: { kind: "message" }, attempt: "at1", inbox: listed ? [msgId] : [] },
      idempotencyKey: `${a.id}:${a.generation}:pausing:at1`,
    });
    await t.daemon.recover();
    await t.orchestrator.idle();
    await t.daemon.recover(); // the boot lost-wake scan must not add a second resume
    await t.orchestrator.idle();
    if (listed) {
      assert.equal((await get(t, a.id)).state, "yielded", "a signal seen before the yield does not wake it");
      assert.equal(await resumedCount(t, a.id), 0);
    } else {
      assert.deepEqual(wakes, ["hello"]);
      assert.equal(await resumedCount(t, a.id), 1, "exactly one resume");
    }
  });
}

// Crash recovery's pause completion (completePause) released the model key and placement slot only after the `yielded` transition,
// so a wake landing right at that transition resumed the agent first and the late revoke and release hit the resumed generation.
// `wakeAtYielded` delivers a message as soon as the transition lands and holds completePause there until gen+1 has issued and admitted.
for (const wakeAtYielded of [true, false]) {
  test(`a completed pause ${wakeAtYielded ? "overtaken by a wake at `yielded` leaves the resumed generation's key and slot intact" : "with no wake still revokes and releases (negative control)"}`, async () => {
    const staged = new Set<string>();
    const credentials = {
      stage: (id: string) => {
        staged.add(id);
        return [];
      },
      unstage: (id: string) => void staged.delete(id),
      providerIds: () => [],
    };
    const t = setup(
      async (c) => {
        if (c.wake !== undefined) await c.stopped; // the resumed generation stays running
      },
      { credentials: credentials as never },
    );
    const d = t.daemon;
    const gw = new ProxyCredentialGateway({
      journal: d.deps.journal,
      registry: d.deps.registry,
      secret: SECRET,
      proxyBaseUrl: "http://m",
      tokenTtlMs: 3_600_000,
      debits: new FakeModelDebitStore({ secret: SECRET }),
    });
    (d.deps as unknown as { gateway: typeof gw }).gateway = gw;
    const keys: string[] = [];
    const issue = gw.issueKey.bind(gw);
    gw.issueKey = async (agent, budget, idem) => {
      const k = await issue(agent, budget, idem);
      keys.push(k.key);
      return k;
    };
    const reg = d.deps.registry;
    const root = await d.root();
    const a0 = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
    const a = await reg.transition(a0.id, a0.generation, "running", { idempotencyKey: "a-run" });
    await d.deps.workspace.create(a.id, {});
    const sb = await t.fakes.hooks.raw.sandbox.start({ host: "h1", generation: 0, agent: a.id, image: "img", env: {}, mounts: [] }, "a-sb");
    await reg.setSandbox(a.id, a.generation, sb.id, "a-sb-set");
    await t.fakes.hooks.raw.sandbox.kill(sb.id, `test-kill:${sb.id}`); // the daemon died after the stop
    // The crashed run's key, staged credentials and slot, live at the crash: completing the pause must release them.
    const old = await gw.issueKey(a.id, 100_000);
    staged.add(a.id);
    await t.fakes.hosts.reserve({ agent: a.id, host: "h1", state: "running", priority: 0, resources: {}, template: null }, "a-slot");
    await t.journal.append({
      agent: a.id,
      host: "h1",
      generation: a.generation,
      payload: { kind: "pausing", reason: "yield", key: "y1", wait: { kind: "message" }, attempt: "at1", inbox: [] },
      idempotencyKey: `${a.id}:${a.generation}:pausing:at1`,
    });
    const transition = reg.transition.bind(reg);
    let seen: { keyLive: boolean; slot: string | null; exited: number; staged: boolean } | null = null;
    reg.transition = async (id, gen, state, o) => {
      const r = await transition(id, gen, state, o);
      if (id === a.id && state === "yielded" && seen === null) {
        // The yield contract holds for a completed pause too: torn down before `yielded` is visible.
        const rows = await t.journal.read({ agent: id });
        seen = {
          keyLive: gw.authorize(old.key) !== null,
          slot: (await t.fakes.hosts.getReservation(id))?.state ?? null,
          exited: rows.filter((e) => e.payload.kind === SANDBOX_LIFECYCLE_KIND && (e.payload as { cause?: string }).cause === "yielded").length,
          staged: staged.has(id),
        };
      }
      if (wakeAtYielded && id === a.id && state === "yielded") {
        await d.sendMessage(root.id, a.id, "hello", root.generation, "m1");
        await until(async () => keys.length === 2 && (await t.fakes.hosts.getReservation(a.id))?.state === "running").catch(() => {
          throw new Error("the wake at `yielded` never issued and admitted gen+1");
        });
      }
      return r;
    };
    await d.recover();
    if (wakeAtYielded) {
      await until(async () => (await get(t, a.id)).sandbox !== null && (await get(t, a.id)).generation === a.generation + 1);
      await new Promise((r) => setTimeout(r, 50)); // the rest of completePause has run by now
      const r = await get(t, a.id);
      assert.equal(r.state, "running");
      assert.equal(r.generation, a.generation + 1);
      assert.ok(gw.authorize(keys[1] ?? ""), "the resumed generation's model key survives the completed pause");
      assert.equal((await t.fakes.hosts.getReservation(a.id))?.state, "running", "the resumed generation keeps its placement slot");
      await d.kill(a.id);
    } else {
      await t.orchestrator.idle();
      assert.equal((await get(t, a.id)).state, "yielded");
      assert.equal(await t.fakes.hosts.getReservation(a.id), null, "the placement slot is released");
    }
    assert.equal(gw.authorize(old.key), null, "the crashed run's key is revoked");
    assert.deepEqual(seen, { keyLive: false, slot: null, exited: 1, staged: false }, "torn down before `yielded` was visible");
    await t.orchestrator.idle();
  });
}
