import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { HOST_LIMITER_KEYS_MAX, HostReadLimiter } from "./host-read.ts";
import { SECRET, setup, spawnSpec } from "./test-setup.ts";

// A host token is good only for a CONFIGURED adapter channel: the discord token needs discord in messagingChannels.
const CHAT = { messagingChannels: ["discord"] };
const host = issueToken(SECRET, { scope: "host", channel: "discord" });
const get = (t: ReturnType<typeof setup>, url: string, token = host) => handle(t.daemon, { method: "GET", url, token });

async function agent(t: ReturnType<typeof setup>, key: string, name = "worker"): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: { ...spawnSpec, env: { SECRET_ENV: "hunter2" } } as typeof spawnSpec,
    parent: root.id,
    name,
    task: "SECRET TASK PROMPT",
    host: "h1",
    budgetMicros: 5_000,
    idempotencyKey: key,
  });
  await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  return t.daemon.deps.registry.transition(a.id, a.generation, "exited", {
    exit: "succeeded",
    result: { summary: "done @everyone <@123>", secretish: "x" },
    idempotencyKey: `${key}-exit`,
  });
}

test("host list exposes only the safe projection, newest first, with sender required", async () => {
  const t = setup(async () => {}, CHAT);
  const a = await agent(t, "a");
  const res = await get(t, "/v1/host/agents?sender=u1");
  assert.equal(res.status, 200);
  const rows = (res.body as { agents: Array<Record<string, unknown>> }).agents;
  const row = rows.find((r) => r.id === a.id)!;
  assert.deepEqual(Object.keys(row).sort(), ["budgetMicros", "createdAt", "id", "name", "parent", "spentMicros", "state", "updatedAt"]);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("SECRET") && !text.includes("hunter2"));
  assert.equal(row.budgetMicros, 5_000);
  assert.equal(row.spentMicros, 0);
  assert.equal((await get(t, "/v1/host/agents")).status, 400);
  assert.equal((await get(t, "/v1/host/agents?sender=")).status, 400);
  assert.equal((await get(t, "/v1/host/agents?sender=a%0Ab")).status, 400);
  assert.equal((await get(t, "/v1/host/agents?sender=u1&state=bogus")).status, 400);
});

test("host budget and report: sanitized, 404 for unknown, reaped and self", async () => {
  const t = setup(async () => {}, CHAT);
  const a = await agent(t, "a");
  const b = await get(t, `/v1/host/agents/${a.id}/budget?sender=u1`);
  assert.equal(b.status, 200);
  assert.deepEqual(Object.keys(b.body as object).sort(), ["budgetMicros", "id", "remainingMicros", "spentMicros"]);
  const r = await get(t, `/v1/host/agents/${a.id}/report?sender=u1`);
  assert.equal(r.status, 200);
  const rep = (r.body as { report: string }).report;
  assert.ok(!rep.includes("@everyone") && !rep.includes("<@1"));
  assert.ok(!JSON.stringify(r.body).includes("secretish"));
  for (const id of ["ag-nope", "self"]) {
    const x = await get(t, `/v1/host/agents/${id}/report?sender=u1`);
    assert.equal(x.status, 404);
  }
  await t.daemon.deps.registry.transition(a.id, (await t.daemon.get(a.id))!.generation, "reaped", { idempotencyKey: "reap" });
  const list = (await get(t, "/v1/host/agents?sender=u1")).body as { agents: Array<{ id: string }> };
  assert.ok(!list.agents.some((x) => x.id === a.id));
  // reaped records resolve on the detail routes too, so list and detail agree on what exists
  assert.equal((await get(t, `/v1/host/agents/${a.id}/budget?sender=u1`)).status, 200);
  assert.equal((await get(t, `/v1/host/agents/${a.id}/report?sender=u1`)).status, 200);
  assert.equal((await get(t, "/v1/host/agents/ag-nope/budget?sender=u1")).status, 404);
  assert.equal((await get(t, "/v1/host/agents/self/budget?sender=u1")).status, 404);
});

test("host read routes reject extra or unknown path segments", async () => {
  const t = setup(async () => {}, CHAT);
  const a = await agent(t, "a");
  for (const url of [
    `/v1/host/agents/${a.id}/budget/junk?sender=u1`,
    `/v1/host/agents/${a.id}/report/junk?sender=u1`,
    `/v1/host/agents/${a.id}/x?sender=u1`,
    `/v1/host/agents/${a.id}?sender=u1`,
    "/v1/host/other?sender=u1",
    "/v1/host/agents/a/b/c/d?sender=u1",
  ])
    assert.equal((await get(t, url)).status, 404, url);
  assert.equal((await get(t, `/v1/host/agents/${a.id}/budget?sender=u1`)).status, 200);
});

test("report with no summary exposes no agent-authored fields", async () => {
  const t = setup(async () => {}, CHAT);
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "quiet",
    task: "t",
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: "quiet",
  });
  await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: "quiet-run" });
  await t.daemon.deps.registry.transition(a.id, a.generation, "exited", {
    exit: "succeeded",
    result: { notes: "LEAKME-NOTES", secretish: "LEAKME-EXTRA" },
    idempotencyKey: "quiet-exit",
  });
  const r = await get(t, `/v1/host/agents/${a.id}/report?sender=u1`);
  assert.equal(r.status, 200);
  assert.equal((r.body as { report: string }).report, "no summary");
  assert.ok(!JSON.stringify(r.body).includes("LEAKME"));
});

test("authorizeInbound gates the host read routes and returns no data", async () => {
  const seen: string[] = [];
  const t = setup(async () => {}, {
    ...CHAT,
    authorizeInbound: (m, route) => {
      seen.push(`${m.sender.channel}:${m.sender.sender}:${route}`);
      return m.sender.sender === "ok";
    },
  });
  const a = await agent(t, "a");
  const denied = await get(t, `/v1/host/agents/${a.id}/report?sender=evil`);
  assert.equal(denied.status, 403);
  assert.ok(!JSON.stringify(denied.body).includes(a.id));
  assert.equal((await get(t, "/v1/host/agents?sender=evil")).status, 403);
  assert.equal((await get(t, "/v1/host/agents?sender=ok")).status, 200);
  assert.deepEqual(seen.slice(-1), ["discord:ok:status"]);
});

test("host read routes are rate limited per sender", async () => {
  const t = setup(async () => {}, CHAT);
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await get(t, "/v1/host/agents?sender=spam")).status;
  assert.equal(last, 429);
  assert.equal((await get(t, "/v1/host/agents?sender=other")).status, 200);
});

test("the limiter: a sender past its cap does not consume global budget for other senders", async () => {
  const t = setup(async () => {}, CHAT);
  for (let i = 0; i < 31; i++) await get(t, "/v1/host/agents?sender=spam");
  // 31 requests from one sender, 30 admitted; a second sender still gets its full allowance
  for (let i = 0; i < 60; i++) assert.equal((await get(t, `/v1/host/agents?sender=ok${i}`)).status, 200, `ok${i}`);
});

test("the limiter does not grow with many distinct sender strings and drops expired windows", () => {
  let now = 0;
  const limiter = new HostReadLimiter();
  for (let i = 0; i < 5000; i++) limiter.limited("discord", `s${i}`, now);
  assert.ok((limiter as unknown as { times: Map<string, number[]> }).times.size <= HOST_LIMITER_KEYS_MAX);
  now = 120_000; // every window has elapsed
  assert.equal(limiter.limited("discord", "fresh", now), false);
  assert.ok((limiter as unknown as { times: Map<string, number[]> }).times.size <= 2);
});

test("host scope is not widened: still 403 on operator and agent routes, others 403/404 on /v1/host", async () => {
  const t = setup(async () => {}, CHAT);
  const a = await agent(t, "a");
  const cases: Array<[string, string]> = [
    ["GET", "/v1/agents"],
    ["GET", "/v1/summary"],
    ["GET", `/v1/agents/${a.id}`],
    ["GET", `/v1/agents/${a.id}/budget`],
    ["GET", "/v1/agents/self/budget"],
    ["POST", "/v1/agents"],
    ["POST", `/v1/agents/${a.id}/cancel`],
    ["POST", `/v1/agents/${a.id}/reap`],
    ["POST", "/v1/agents/self/result"],
  ];
  for (const [method, url] of cases)
    assert.equal(
      (await handle(t.daemon, { method, url, token: host, body: { task: "x", idempotencyKey: "k", result: {}, status: "succeeded" } })).status,
      403,
      `${method} ${url}`,
    );
  for (const method of ["POST", "DELETE"])
    assert.equal((await handle(t.daemon, { method, url: "/v1/host/agents?sender=u1", token: host, body: {} })).status, 404);
  assert.equal((await get(t, `/v1/host/agents/${a.id}?sender=u1`)).status, 404);
  assert.equal((await get(t, `/v1/host/agents/${a.id}/events?sender=u1`)).status, 404);
  // operator and agent tokens do not get the host routes
  const op = issueToken(SECRET, { scope: "operator" });
  assert.equal((await get(t, "/v1/host/agents?sender=u1", op)).status, 403);
  assert.equal((await get(t, "/v1/host/agents?sender=u1", issueToken(SECRET, { scope: "ext", name: "x" }))).status, 403);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/host/agents?sender=u1" })).status, 401);
});
