import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentId, AgentRecord, PlacementStatus } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { ScriptHarness, createFakes, tmpDir } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { SECRET, spawnSpec, until } from "./test-setup.ts";

// One "boot" of the daemon over a sqlite file; the sandbox and workspace fakes outlive it, like containers and folders do.
function boot(dbPath: string, fakes: ReturnType<typeof createFakes>, epoch: string) {
  const store = openStore(dbPath);
  const node = new LocalNode({
    hostId: "h1",
    sandbox: fakes.sandbox,
    workspace: fakes.workspace,
    capacity: { maxSessions: 2 },
    bootEpoch: epoch,
    workspacePath: (id) => `/fake/${id}`,
    sessionDir: (a) => join(tmpDir("sess-"), a),
  });
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const orchestrator = new LocalOrchestrator();
  const started: AgentId[] = [];
  const harness = new ScriptHarness(async (c) => {
    started.push(c.agent);
    await c.stopped;
  });
  const daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: "/host/pomtreed.sock",
    rootBudgetMicros: 10_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    epoch,
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox: fakes.hooks.raw.sandbox,
    workspace: fakes.hooks.raw.workspace,
    harness,
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: tmpDir("pomtreed-sess-"),
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement,
    orchestrator,
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, node, placement, orchestrator, daemon, started };
}

test("the running set and queue live in the store: a restarted daemon sees them, and recover() reconciles them with reality", async () => {
  const dbPath = join(tmpDir("pomtreed-pr-"), "pomtreed.sqlite");
  const fakes = createFakes({ host: "h1" });

  // Boot 1 leaves behind: L (running, live container), S (exited, but its slot was never released), Q (pending, queued).
  const one = boot(dbPath, fakes, "1");
  await one.node.register(one.store.hosts);
  const root = await one.daemon.root();
  const reg = one.store.registry;
  const mk = async (name: string) => reg.create({ spec: spawnSpec, parent: root.id, name, task: "t", host: "h1", budgetMicros: 100, idempotencyKey: name });
  const L = await mk("live");
  await reg.transition(L.id, L.generation, "running", { idempotencyKey: "l-run" });
  const sb = await fakes.hooks.raw.sandbox.start(
    { agent: L.id, image: "img", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/work" }] },
    "l-sb",
  );
  await reg.setSandbox(L.id, L.generation, sb.id, "l-set", "fake");
  const S = await mk("stale");
  await reg.transition(S.id, S.generation, "running", { idempotencyKey: "s-run" });
  await reg.transition(S.id, S.generation, "exited", { exit: "succeeded", idempotencyKey: "s-exit" });
  const Q = await mk("queued");
  for (const [agent, priority] of [
    [L.id, 1],
    [S.id, 1],
    [Q.id, 1],
  ] as const)
    await one.placement.admit({ agent, priority });
  const before: PlacementStatus[] = await one.placement.status();
  assert.deepEqual(before, [{ host: "h1", maxConcurrent: 2, running: [L.id, S.id], queue: [{ agent: Q.id, priority: 1 }] }]);
  one.store.close(); // the daemon and its placement are gone; only the file and the containers remain

  // Boot 2: a fresh placement over the same file already reports the same set, before recover() and with no admit having run.
  const two = boot(dbPath, fakes, "2");
  await two.node.register(two.store.hosts);
  assert.deepEqual(await two.placement.status(), before);
  assert.deepEqual(await two.daemon.placementStatus(), before[0]);

  // recover(): L keeps its slot (live container adopted), S's stale slot is released, and Q is promoted into it and started.
  await two.daemon.recover();
  await until(async () => ((await two.daemon.get(Q.id)) as AgentRecord).state === "running");
  assert.equal(((await two.daemon.get(L.id)) as AgentRecord).state, "running", "the adopted agent stays running");
  assert.equal(fakes.hooks.raw.sandbox.running.get(sb.id)!.exitCode, null, "its container was not touched");
  const after = await two.placement.status();
  assert.deepEqual(after[0]!.running.sort(), [L.id, Q.id].sort());
  assert.deepEqual(after[0]!.queue, []);
  assert.deepEqual(two.started, [Q.id]);

  // Boot 3 sees the reconciled set too.
  two.store.close();
  const three = boot(dbPath, fakes, "3");
  assert.deepEqual((await three.placement.status())[0]!.running.sort(), [L.id, Q.id].sort());
  three.store.close();
});
