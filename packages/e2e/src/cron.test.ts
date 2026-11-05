import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtensionRegistry } from "@pomtree/pomtreed";
import type { AgentRecord, SpawnIntent } from "@pomtree/core";
// Contract gap: `createCronExtension` lives in pomtreed/src/builtin/cron.ts but is not re-exported from
// @pomtree/pomtreed's public index, so e2e cannot construct the cron builtin through the package.
// TODO(tests-gaps): export the builtin factories (cron/reports/observe) so e2e reaches them via the
// public API instead of this relative path.
import { createCronExtension } from "../../pomtreed/src/builtin/cron.ts";
import { rig } from "./harness.ts";

// The real store stamps `createdAt` with Date.now(), so the injected clock must start strictly after
// that stamp for the missed-run cursor to be behind the first due fire. Use the next minute boundary.
const nextMinute = () => Math.floor(Date.now() / 60_000) * 60_000 + 60_000;

type SpawnRootChild = (intent: SpawnIntent, idempotencyKey: string) => Promise<AgentRecord>;

// Build the cron builtin over the real store-sqlite schedule store and the real daemon's spawn path,
// with an injectable clock. `wrap` lets a test make one schedule's spawn throw while the rest keep
// delegating to the daemon.
const cronRig = (clock: () => number, wrap?: (base: SpawnRootChild) => SpawnRootChild) => {
  const r = rig({ now: clock });
  const base: SpawnRootChild = async (intent, idempotencyKey) =>
    r.daemon.spawn((await r.daemon.root()).id, {
      name: intent.name,
      task: intent.task,
      ...(intent.budgetMicros !== undefined && { budgetMicros: intent.budgetMicros }),
      idempotencyKey,
    });
  const extensions = createExtensionRegistry({
    hostId: "h1",
    now: () => r.daemon.now(),
    registry: r.daemon.deps.registry,
    journal: r.daemon.deps.journal,
    mailbox: r.daemon.deps.mailbox,
    root: () => r.daemon.root(),
  });
  const cronExt = createCronExtension({
    schedules: r.store.schedules,
    cronTickMs: r.daemon.limits.cronTickMs,
    rootId: async () => (await r.daemon.root()).id,
    spawnRootChild: wrap ? wrap(base) : base,
    steerAgent: (agent, body, key) => r.daemon.messageAgent(agent, body, key, "queue"),
    wakeAgent: (agent, body, key) => r.daemon.resumeAgent(agent, body, {}, key),
    pendingSignals: (agent) => r.daemon.deps.mailbox.peek(agent),
  });
  extensions.registerBuiltin(cronExt);
  return { r, cronExt };
};

test("a failed spawn leaves the cursor behind and the next tick past the breaker backoff retries the same fire", async () => {
  const start = nextMinute();
  let clock = start;
  let fail = true;
  const { r, cronExt } = cronRig(
    () => clock,
    (base) => async (intent, key) => {
      if (fail) throw new Error("spawn down");
      return base(intent, key);
    },
  );
  try {
    await r.store.schedules.upsert({ id: "retry", cron: "* * * * *", task: "t", missed: "skip", overlap: "queue", jitterMs: 0 }, "up-retry");
    clock = start + 90_000;
    await cronExt.sweep();
    assert.equal(await r.store.schedules.lastFired("retry"), null, "cursor not advanced by a failed spawn");
    fail = false;
    await cronExt.sweep(); // still inside the breaker backoff: no spawn
    const root = await r.daemon.root();
    assert.equal((await r.daemon.list({ parent: root.id })).filter((k) => k.name === "retry").length, 0);
    clock += 10 * 60_000; // past any backoff; the fire is still the newest due one
    await cronExt.sweep();
    await r.orchestrator.idle();
    assert.equal((await r.daemon.list({ parent: root.id })).filter((k) => k.name === "retry").length, 1, "retried once");
    assert.ok((await r.store.schedules.lastFired("retry"))! >= start + 60_000, "cursor advanced after the retry");
  } finally {
    r.store.close();
  }
});
