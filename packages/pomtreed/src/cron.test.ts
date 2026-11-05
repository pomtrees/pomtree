import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Schedule, SpawnIntent } from "@pomtree/core";
import { DEFAULT_MAX_CATCH_UP, jitterFor } from "@pomtree/sched";
import { openStore } from "@pomtree/store-sqlite";
import { FakeModelCatalog } from "@pomtree/testing";
import { handle } from "./api.ts";
import { createCronExtension } from "./builtin/cron.ts";
import { createExtensionRegistry } from "./extensions.ts";
import { setup } from "./test-setup.ts";

const T0 = Date.parse("2026-01-01T00:00:00Z");
// overlap "queue" serializes fires behind a live run, so these tests use agents that finish and sweep until
// the cron cursor stops moving (one fire per tick per run).
const sweepAll = async (t: ReturnType<typeof setup>): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    const snap = () => JSON.stringify([...t.fakes.schedules.lastFiredAt]);
    const before = snap() + (await children(t)).length;
    await t.cronExt.sweep();
    await t.orchestrator.idle();
    if (snap() + (await children(t)).length === before) return;
  }
};
const children = async (t: ReturnType<typeof setup>) => t.daemon.list({ parent: (await t.daemon.root()).id });

// The cron rules below that the real schedule store must also honour run over both the fake and the real
// store-sqlite schedule store. The cron extension is built here on the chosen store (the daemon's own
// stays on the fake), spawning through the daemon's spawn path; `poison` names a schedule whose spawn throws.
// The real store stamps createdAt with the wall clock, so the injected clock starts after the next minute boundary.
const stores = ["fake", "real"] as const;
const nextMinute = () => Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
const cronOn = (kind: (typeof stores)[number], start: number, poison?: string) => {
  let clock = start;
  const t = setup(async () => {}, { now: () => clock });
  const real = kind === "real" ? openStore() : undefined;
  const schedules = real ? real.schedules : t.fakes.schedules;
  const extensions = createExtensionRegistry({
    hostId: "h1",
    now: () => t.daemon.now(),
    registry: t.daemon.deps.registry,
    journal: t.daemon.deps.journal,
    mailbox: t.daemon.deps.mailbox,
    root: () => t.daemon.root(),
  });
  const cron = createCronExtension({
    schedules,
    cronTickMs: t.daemon.limits.cronTickMs,
    rootId: async () => (await t.daemon.root()).id,
    spawnRootChild: async (intent: SpawnIntent, idempotencyKey: string): Promise<AgentRecord> => {
      if (intent.name === poison) throw new Error("boom");
      return t.daemon.spawn((await t.daemon.root()).id, { name: intent.name, task: intent.task, idempotencyKey });
    },
    steerAgent: (agent, body, key) => t.daemon.messageAgent(agent, body, key, "queue"),
    wakeAgent: (agent, body, key) => t.daemon.resumeAgent(agent, body, {}, key),
    pendingSignals: (agent) => t.daemon.deps.mailbox.peek(agent),
  });
  extensions.registerBuiltin(cron);
  // Sweep until neither a cursor nor the child count moves (overlap queue releases one fire per settled run).
  const sweepAll = async (): Promise<void> => {
    const snap = async () => JSON.stringify(await Promise.all((await schedules.list()).map((s) => schedules.lastFired(s.id)))) + (await children(t)).length;
    for (let i = 0; i < 40; i++) {
      const before = await snap();
      await cron.sweep();
      await t.orchestrator.idle();
      if ((await snap()) === before) return;
    }
  };
  const add = (id: string, missed: "skip" | "run-one") =>
    schedules.upsert({ id, cron: "* * * * *", task: "t", missed, overlap: "queue", jitterMs: 0 }, `up-${id}`);
  return {
    t,
    schedules,
    sweepAll,
    add,
    setClock: (ms: number) => {
      clock = ms;
    },
    close: () => real?.close(),
  };
};

// A shared cron scenario: every-minute schedule, optionally fired once on-time (00:01:00), then a
// downtime jump to 00:05:30 (missed 00:02..00:04, on-time 00:05:00). overlap=queue so each kept fire
// actually spawns, isolating the missed-policy split from the overlap policy.
const run = async (missed: "skip" | "run-one" | "catch-up", prefire: boolean) => {
  let clock = T0;
  const t = setup(async () => {}, { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed, overlap: "queue" });
  if (prefire) {
    clock = T0 + 90_000; // 00:01:30 -> fires 00:01:00 (on-time)
    await sweepAll(t);
  }
  clock = T0 + 5 * 60_000 + 30_000; // 00:05:30
  await sweepAll(t);
  return { count: (await children(t)).length, lastFired: await t.fakes.schedules.lastFired("m") };
};

test("schedule API: upsert, list, remove round-trip with defaults", async () => {
  const t = setup(async () => {});
  const put = await t.operator("PUT", "/v1/schedules/nightly", { cron: "0 3 * * *", task: "backup" });
  assert.equal(put.status, 200);
  const s = put.body as Schedule;
  assert.equal(s.id, "nightly");
  assert.equal(s.cron, "0 3 * * *");
  assert.equal(s.task, "backup");
  assert.equal(s.missed, "skip");
  assert.equal(s.overlap, "skip");
  assert.equal(s.jitterMs, 0);
  assert.equal(s.tz, undefined);
  assert.ok(s.createdAt > 0);

  const list = (await t.operator("GET", "/v1/schedules")).body as Schedule[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, "nightly");

  assert.deepEqual((await t.operator("DELETE", "/v1/schedules/nightly?key=d1")).body, { removed: true });
  assert.equal(((await t.operator("GET", "/v1/schedules")).body as Schedule[]).length, 0);
  assert.deepEqual((await t.operator("DELETE", "/v1/schedules/nightly?key=d2")).body, { removed: false });
});

test("schedule API: upsert replaces by id, preserving createdAt", async () => {
  const t = setup(async () => {});
  const first = (await t.operator("PUT", "/v1/schedules/s", { cron: "0 3 * * *", task: "a" })).body as Schedule;
  const second = (await t.operator("PUT", "/v1/schedules/s", { cron: "0 4 * * *", task: "b" })).body as Schedule;
  assert.equal(second.id, "s");
  assert.equal(second.cron, "0 4 * * *");
  assert.equal(second.task, "b");
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(((await t.operator("GET", "/v1/schedules")).body as Schedule[]).length, 1);
});

test("schedule API: A→B→A re-applies A rather than replaying a cached result", async () => {
  const t = setup(async () => {});
  const a = { cron: "0 3 * * *", task: "a" };
  const b = { cron: "0 4 * * *", task: "b" };
  await t.operator("PUT", "/v1/schedules/s", a);
  assert.equal(((await t.operator("PUT", "/v1/schedules/s", b)).body as Schedule).task, "b");
  const third = (await t.operator("PUT", "/v1/schedules/s", a)).body as Schedule;
  assert.equal(third.cron, "0 3 * * *");
  assert.equal(third.task, "a");
  const stored = await t.fakes.schedules.get("s");
  assert.equal(stored?.cron, "0 3 * * *");
  assert.equal(stored?.task, "a");
});

// Agent scope is now allowed (self-targeted schedules only; see builtin/cron.target.test.ts), so a credential for an
// agent that does not exist is refused as stale instead of 403.
test("schedule routes require operator or a live agent credential", async () => {
  const t = setup(async () => {});
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/schedules" })).status, 401);
  const agent = t.daemon.agentToken("ghost");
  for (const req of [
    { method: "GET", url: "/v1/schedules" },
    { method: "PUT", url: "/v1/schedules/x", body: { cron: "* * * * *", task: "t", idempotencyKey: "k" } },
    { method: "DELETE", url: "/v1/schedules/x?key=k" },
  ]) {
    assert.equal((await handle(t.daemon, { ...req, token: agent })).status, 409);
  }
  assert.equal(((await t.operator("GET", "/v1/schedules")).body as Schedule[]).length, 0);
});

test("schedule PUT validates cron and policies with 400 before any store write", async () => {
  const t = setup(async () => {});
  const bad = async (body: unknown) => (await t.operator("PUT", "/v1/schedules/x", body)).status;
  assert.equal(await bad({ cron: "* * * *", task: "t" }), 400); // 4 fields, not 5
  assert.equal(await bad({ cron: "60 * * * *", task: "t" }), 400); // minute out of range
  assert.equal(await bad({ cron: "* * * * *", task: "t", missed: "nope" }), 400);
  assert.equal(await bad({ cron: "* * * * *", task: "t", overlap: "nope" }), 400);
  assert.equal(await bad({ cron: "* * * * *", task: "t", jitterMs: -1 }), 400);
  assert.equal(await bad({ cron: "* * * * *" }), 400); // missing task
  assert.equal(await bad({ task: "t" }), 400); // missing cron
  assert.equal(((await t.operator("GET", "/v1/schedules")).body as Schedule[]).length, 0);
});

test("a due fire spawns exactly one root child, idempotent on re-tick", async () => {
  let clock = T0;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "tick", missed: "catch-up" });
  clock = T0 + 90_000; // 00:01:30 -> one due fire at 00:01:00
  await t.cronExt.sweep();
  let kids = await children(t);
  assert.equal(kids.length, 1);
  assert.equal(kids[0]!.name, "m");
  assert.equal(kids[0]!.task, "tick");
  // Same clock re-tick: the cursor advanced, so no second child.
  await t.cronExt.sweep();
  kids = await children(t);
  assert.equal(kids.length, 1);
});

test("cursor advances so later ticks fire only new scheduled times", async () => {
  let clock = T0;
  const t = setup(async () => {}, { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "catch-up", overlap: "queue" });
  clock = T0 + 90_000;
  await sweepAll(t);
  assert.equal(await t.fakes.schedules.lastFired("m"), T0 + 60_000);
  clock = T0 + 3 * 60_000 + 30_000; // 00:03:30 -> new fires at 00:02:00 and 00:03:00 only
  await sweepAll(t);
  assert.equal(await t.fakes.schedules.lastFired("m"), T0 + 3 * 60_000);
  assert.equal((await children(t)).length, 3); // 00:01:00 + 00:02:00 + 00:03:00, never a re-fire of 00:01:00
});

// After downtime (prefire at 00:01:00, then a sweep at 00:05:30), each missed policy fires a different set.
for (const c of [
  { title: "skip after downtime fires only the on-time fire and drops older missed ones", missed: "skip", count: 2 }, // 00:01:00 (prefire) + 00:05:00 (on-time); 00:02..00:04 dropped
  { title: "run-one after downtime fires the newest missed plus on-time", missed: "run-one", count: 3 }, // prefire 00:01:00 + newest missed 00:04:00 + on-time 00:05:00
  { title: "catch-up after downtime fires all", missed: "catch-up", count: 5 }, // prefire 00:01:00 + 00:02..00:05
] as const) {
  test(c.title, async () => {
    const r = await run(c.missed, true);
    assert.equal(r.count, c.count);
    assert.equal(r.lastFired, T0 + 5 * 60_000);
  });
}

test("a freshly-created schedule with a past createdAt applies the policy to its backfill window", async () => {
  assert.equal((await run("skip", false)).count, 1); // only the on-time 00:05:00
  assert.equal((await run("run-one", false)).count, 2); // newest missed 00:04:00 + on-time 00:05:00
  assert.equal((await run("catch-up", false)).count, 5); // 00:01..00:05
});

test("overlap skip drops a fire while the previous is still running; queue starts it", async () => {
  const run = async (overlap: "skip" | "queue") => {
    let clock = T0;
    const t = setup(overlap === "skip" ? async (c) => void (await c.stopped) : async () => {}, { now: () => clock });
    await t.operator("PUT", "/v1/schedules/h", { cron: "0 * * * *", task: "t", missed: "catch-up", overlap });
    clock = T0 + 2 * 3600_000 + 1; // two missed fires; the first's child is still running
    if (overlap === "skip") await t.cronExt.sweep();
    else await sweepAll(t);
    return (await children(t)).length;
  };
  assert.equal(await run("skip"), 1);
  assert.equal(await run("queue"), 2);
});

test("a single late due fire fires under every policy", async () => {
  for (const missed of ["skip", "run-one", "catch-up"] as const) {
    let clock = T0;
    const t = setup(async () => {}, { now: () => clock });
    await t.operator("PUT", "/v1/schedules/h", { cron: "0 * * * *", task: "t", missed, overlap: "queue" });
    clock = T0 + 1 * 3600_000 + 30_000; // 01:00:30 -> prefire 01:00
    await sweepAll(t);
    clock = T0 + 2 * 3600_000 + 30 * 60_000; // 02:30 -> only 02:00 is due, 30 minutes late
    await sweepAll(t);
    assert.equal((await children(t)).length, 2, `missed=${missed}`);
  }
});

test("a delayed sweep still fires the newest due fire", async () => {
  let clock = T0;
  const t = setup(async () => {}, { now: () => clock });
  await t.operator("PUT", "/v1/schedules/h", { cron: "0 * * * *", task: "t", missed: "skip", overlap: "queue" });
  clock = T0 + 5 * 3600_000 + 30 * 60_000; // 05:30 -> due 01:00..05:00, newest is 05:00 (30 min late)
  await sweepAll(t);
  const kids = await children(t);
  assert.equal(kids.length, 1); // only the newest due fire; 01:00..04:00 are missed and skipped
  assert.equal(kids[0]!.name, "h");
});

for (const kind of stores) {
  for (const c of [
    { title: "an outage longer than the catch-up cap still fires only the newest due fire", missed: "skip", count: 1 },
    { title: "an outage longer than the catch-up cap under run-one fires the newest missed plus the on-time fire", missed: "run-one", count: 2 },
  ] as const) {
    test(`${c.title} [${kind}]`, async () => {
      const start = nextMinute();
      const w = cronOn(kind, start);
      try {
        await w.add("m", c.missed);
        w.setClock(start + (DEFAULT_MAX_CATCH_UP + 55) * 60_000 + 30_000); // far past the cap
        await w.sweepAll();
        assert.equal((await children(w.t)).filter((k) => k.name === "m").length, c.count);
        // The cursor must jump to the newest due fire, not the cap-th oldest (stale) fire.
        assert.equal(await w.schedules.lastFired("m"), start + (DEFAULT_MAX_CATCH_UP + 55) * 60_000);
      } finally {
        w.close();
      }
    });
  }

  test(`a throwing schedule does not starve later schedules [${kind}]`, async () => {
    const start = nextMinute();
    const w = cronOn(kind, start, "poison");
    try {
      // The sweep must isolate the failing spawn (journal it on the root) and keep firing the next schedule.
      await w.add("poison", "skip");
      await w.add("ok", "skip");
      w.setClock(start + 90_000);
      await w.sweepAll(); // must not throw
      const kids = await children(w.t);
      assert.equal(kids.filter((k) => k.name === "ok").length, 1);
      assert.equal(kids.filter((k) => k.name === "poison").length, 0);
      const rootRec = await w.t.daemon.root();
      const errs = (await w.t.daemon.deps.journal.read({ agent: rootRec.id })).filter((e) => e.payload.kind === "ext.cron.error");
      assert.equal(errs.length, 1);
      assert.match((errs[0]!.payload as { message: string }).message, /cron schedule poison spawn failed/);
    } finally {
      w.close();
    }
  });
}

test("jitter is a durable due-gate: the fire waits until t+jitter without holding the sweep", async () => {
  let clock = T0;
  const t = setup(async () => {}, { now: () => clock });
  await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "t", missed: "catch-up", overlap: "queue", jitterMs: 20_000 });
  const j = jitterFor("m", 20_000);
  assert.ok(j > 0);
  clock = T0 + 60_000 + j - 1; // 00:01 fire is due but its jitter has not elapsed
  await sweepAll(t);
  assert.equal((await children(t)).length, 0);
  clock = T0 + 60_000 + j;
  await sweepAll(t);
  assert.equal((await children(t)).length, 1);
  assert.equal(await t.fakes.schedules.lastFired("m"), T0 + 60_000);
});

// Daemon.spawn resolves a model-less spawn's model (lifecycle.ts defaultModelPick), so a cron fire that names none must get it too.
// Cheapest branch: the catalog's resolved (Pi settings) default over the first listed, since the fake catalog takes the default as an argument.
test("a cron fire naming no model gets the catalog's resolved default through Daemon.spawn, not the first listed", async () => {
  const models = [
    { provider: "p", id: "first" },
    { provider: "p", id: "settings-default" },
  ];
  const modelOf = async (catalog: FakeModelCatalog): Promise<string | undefined> => {
    let clock = T0;
    const t = setup(async (c) => void (await c.stopped), { now: () => clock, models: catalog });
    await t.operator("PUT", "/v1/schedules/m", { cron: "* * * * *", task: "tick", missed: "catch-up" });
    clock = T0 + 90_000;
    await t.cronExt.sweep();
    const [kid] = await children(t);
    assert.ok(kid && kid.executor === "container");
    return kid.spec.model;
  };
  assert.equal(await modelOf(new FakeModelCatalog(models, models[1])), "settings-default");
  // Negative: when the catalog's default is the first listed, that one is used, so the assertion above depends on the default being applied.
  assert.equal(await modelOf(new FakeModelCatalog(models, models[0])), "first");
});
