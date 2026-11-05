import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LifecycleError } from "./lifecycle.ts";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

test("shutdown stops admission: spawn 503s and a pending agent is never started", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  await t.daemon.shutdown(Date.now() + 10_000);

  await assert.rejects(
    () => t.daemon.spawn(root.id, { name: "x", task: "t", idempotencyKey: "k" }),
    (e: unknown) => e instanceof LifecycleError && e.status === 503,
  );

  const pending = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "p",
    task: "t",
    host: "h1",
    budgetMicros: 10,
    idempotencyKey: "pending",
  });
  await t.daemon.drive(pending.id, pending.generation);
  assert.equal((await get(t, pending.id)).state, "pending", "draining admission must not start queued work");
});

test("shutdown leaves a running container adoptable instead of killing it", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).state === "running" && (await get(t, a.id)).sandbox !== null);
  assert.ok((await get(t, a.id)).sandbox, "driven agent owns a live sandbox");

  await t.daemon.shutdown(Date.now() + 10_000);
  // No kill was issued, and the container is still live for the next daemon's Sandbox.attach.
  assert.ok(!t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill"), "drain must not SIGKILL containers");

  // Clean up the still-driven agent.
  await t.daemon.kill(a.id);
  await t.orchestrator.idle();
});

test("supervisor units ship launchd KeepAlive{SuccessfulExit=false}+ThrottleInterval and hardened systemd restart caps", () => {
  const dir = fileURLToPath(new URL("../../../deploy", import.meta.url));
  const plist = readFileSync(`${dir}/io.github.pomtrees.pomtreed.plist`, "utf8");
  assert.match(plist, /<key>KeepAlive<\/key>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<\/dict>\s*<key>ThrottleInterval<\/key>/, "ThrottleInterval is top-level");

  const service = readFileSync(`${dir}/pomtreed.service`, "utf8");
  assert.match(service, /Restart=on-failure/);
  assert.match(service, /RestartSec=/);
  assert.match(service, /KillSignal=SIGTERM/);
  assert.match(service, /TimeoutStopSec=/);
  assert.match(service, /\[Unit\][^[]*StartLimitIntervalSec=/);
  assert.match(service, /User=pomtreed/);
  assert.match(service, /EnvironmentFile=\/etc\/pomtreed\/env/);
  assert.match(service, /NoNewPrivileges=yes/);
  assert.match(service, /UMask=0077/);
});
