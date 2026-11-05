import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeHostStore } from "@pomtree/testing";
import { handle } from "./api.ts";
import { Daemon } from "./daemon.ts";
import { HostPlacement } from "./placement.ts";
import { op, setup, until } from "./test-setup.ts";

test("a spawn beyond the session cap shows a pending reason, then clears when admitted", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const hosts = new FakeHostStore(Date.now);
  await hosts.upsertHost({ id: "h1", labels: {}, capacity: { maxSessions: 1 }, images: [], state: "ready" }, "h1");
  const placement = new HostPlacement({ host: "h1", hosts });
  const d = new Daemon({ ...t.daemon.deps, placement, maxSessions: { value: 1, mode: "auto" } });
  placement.onAdmit((agent) => d.admitted(agent));
  const spawn = async (k: string) =>
    (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: k } })).body as { id: string };

  const a = await spawn("a");
  await until(async () => (await d.get(a.id))?.state === "running");
  const b = await spawn("b");
  const reason = "waiting for a session slot (1 of 1 in use)";
  await until(async () => (await d.pendingReason(b.id)) === reason);

  const got = (await handle(d, { method: "GET", url: `/v1/agents/${b.id}`, token: op })).body as { state: string; pendingReason?: string };
  assert.equal(got.state, "pending");
  assert.equal(got.pendingReason, reason);
  const list = (await handle(d, { method: "GET", url: "/v1/agents?state=pending", token: op })).body as { id: string; pendingReason?: string }[];
  assert.equal(list.find((x) => x.id === b.id)?.pendingReason, reason);
  const sum = (await handle(d, { method: "GET", url: "/v1/summary", token: op })).body as { sessions: { used: number; max: number; mode: string } };
  assert.deepEqual(sum.sessions, { used: 1, max: 1, mode: "auto" });
  assert.deepEqual((await d.doctor()).maxSessions, { value: 1, mode: "auto" });

  // The reason is journaled once (not once per admit retry).
  await new Promise((r) => setTimeout(r, 40));
  const rows = (await d.deps.journal.read({ agent: b.id })).filter((e) => e.payload.kind === "ext.pomtreed.pending_reason");
  assert.equal(rows.length, 1);

  await d.kill(a.id);
  await until(async () => (await d.get(b.id))?.state === "running");
  assert.equal(await d.pendingReason(b.id), "", "cleared once admitted");
  assert.equal(((await handle(d, { method: "GET", url: `/v1/agents/${b.id}`, token: op })).body as { pendingReason?: string }).pendingReason, undefined);

  await d.kill(b.id);
  await t.orchestrator.idle();
});
