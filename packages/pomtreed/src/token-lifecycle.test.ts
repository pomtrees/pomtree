import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { keyed } from "@pomtree/testing";
import { SECRET, setup, spawnSpec } from "./test-setup.ts";

// A stale container (an earlier generation, fenced by kill_resume) must not be able to
// submitResult/yield/reap with its old token; the token's generation is compared against the
// registry record, and an expired token is rejected structurally.

test("a stale-generation agent token is rejected after kill_resume bumps the generation", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });

  const stale = issueToken(SECRET, { scope: "agent", agent: a.id, generation: 0, expiry: Date.now() + 60_000 });
  await reg.bumpGeneration(a.id, "h1", "a-resume");

  const res = await handle(t.daemon, { method: "POST", url: "/v1/agents/self/result", body: keyed("POST", { status: "succeeded", result: 1 }), token: stale });
  assert.equal(res.status, 409);
});

test("an expired agent token is rejected", async () => {
  const t = setup(async () => {});
  const expired = issueToken(SECRET, { scope: "agent", agent: "a", generation: 0, expiry: Date.now() - 1000 });
  const res = await handle(t.daemon, { method: "GET", url: "/v1/agents/self/inbox", token: expired });
  assert.equal(res.status, 401);
});

test("a current-generation agent token still works", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: "a", task: "t", host: "h1", budgetMicros: 100_000, idempotencyKey: "a" });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: "a-run" });
  await reg.bumpGeneration(a.id, "h1", "a-resume");

  const cur = t.daemon.agentToken(a.id, (await t.daemon.get(a.id))!.generation);
  const res = await handle(t.daemon, {
    method: "POST",
    url: "/v1/agents/self/result",
    body: keyed("POST", { status: "succeeded", result: { summary: "ok" } }),
    token: cur,
  });
  assert.equal(res.status, 200);
});
