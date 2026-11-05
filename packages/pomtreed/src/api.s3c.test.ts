import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueToken } from "./auth.ts";
import { listenHost } from "./server.ts";
import { runningAgent, SECRET, setup } from "./test-setup.ts";

const agentTok = (t: ReturnType<typeof setup>, a: AgentRecord) => t.daemon.agentToken(a.id, a.generation);
const hostTok = (channel: string) => issueToken(SECRET, { scope: "host", channel });
const ext = issueToken(SECRET, { scope: "ext", name: "x" });

test("publish route: agent-only, own agent, validated, pushes", async () => {
  const pushed: string[] = [];
  const t = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: false,
      resolve: async () => ({ sha: "abc123", summary: "s", paths: [] }),
      push: async (_a, b, tg) => void pushed.push(`${b}->${tg}`),
    },
  });
  const a = await runningAgent(t, "a");
  const b = await runningAgent(t, "b");
  const body = { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "k" };
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/publish`, body)).status, 403);
  assert.equal((await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/publish`, token: ext, body })).status, 403);
  assert.equal((await handle(t.daemon, { method: "POST", url: `/v1/agents/${a.id}/publish`, token: agentTok(t, b), body })).status, 403);
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: `/v1/agents/self/publish`, token: agentTok(t, a), body: { target: "origin/main", idempotencyKey: "k" } }))
      .status,
    400,
  );
  assert.equal(
    (await handle(t.daemon, { method: "POST", url: `/v1/agents/self/publish`, token: agentTok(t, a), body: { ...body, target: "evil" } })).status,
    403,
  );
  const r = await handle(t.daemon, { method: "POST", url: `/v1/agents/self/publish`, token: agentTok(t, a), body });
  assert.equal(r.status, 201);
  assert.deepEqual(pushed, [`agent/${a.id}->origin/main`]);
});

test("approvals decide route: operator only, approves a pending approval", async () => {
  const t = setup(async () => {}, { approvalWaitMs: 5, approvalTimeoutMs: 60_000 });
  t.daemon.deps.approvals = t.fakes.approvals;
  const a = await runningAgent(t, "a");
  await assert.rejects(t.daemon.requireApproval(a, "publish", "x", "k1"), (e: { status?: number }) => e.status === 409);
  const pending = (await t.fakes.approvals.list?.({}))?.[0] ?? null;
  assert.ok(pending, "pending approval exists");
  const url = `/v1/approvals/${pending!.id}/decide`;
  const body = { decision: "approve", idempotencyKey: "d1" };
  assert.equal((await handle(t.daemon, { method: "POST", url, token: agentTok(t, a), body })).status, 403);
  assert.equal((await handle(t.daemon, { method: "POST", url, token: hostTok("discord"), body })).status, 403);
  assert.equal((await t.operator("POST", url, { idempotencyKey: "d1" })).status, 400);
  assert.equal((await t.operator("POST", "/v1/approvals/nope/decide", body)).status, 404);
  assert.equal((await t.operator("POST", url, body)).status, 201);
  assert.ok(await t.daemon.requireApproval(a, "publish", "x", "k1"));
});

test("message_failed route: host token, own channel only; TCP host endpoint allows it", async () => {
  const t = setup(async () => {}, { messagingChannels: ["discord"] });
  const body = { channel: "discord", purpose: "alert", subject: "s", reason: "dead", attempts: 3, idempotencyKey: "f1" };
  const post = (token: string, b: unknown) => handle(t.daemon, { method: "POST", url: "/v1/messages/failed", token, body: b });
  assert.equal((await post(t.daemon.agentToken("x", 0), body)).status, 403);
  assert.equal((await post(issueToken(SECRET, { scope: "operator" }), body)).status, 403);
  assert.equal((await post(hostTok("slack"), body)).status, 403);
  assert.equal((await post(hostTok("discord"), { ...body, reason: "" })).status, 400);
  assert.equal((await post(hostTok("discord"), body)).status, 201);
  assert.equal((await post(hostTok("discord"), body)).status, 201);
  const root = await t.daemon.root();
  const rows = (await t.journal.read({ agent: root.id })).filter((e) => e.payload.kind === "message_failed");
  assert.equal(rows.length, 1, "replay is idempotent");

  const { server, port } = await listenHost(t.daemon, "127.0.0.1", 0);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages/failed`, {
      method: "POST",
      headers: { authorization: `Bearer ${hostTok("discord")}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, idempotencyKey: "f2" }),
    });
    assert.equal(r.status, 201);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("idempotency key passes through result/cancel/kill/resume", async () => {
  const t = setup(async () => {});
  const calls: unknown[][] = [];
  const d = t.daemon as unknown as Record<string, (...a: unknown[]) => unknown>;
  const a = await runningAgent(t, "a");
  d.submitResult = async (...x) => (calls.push(["result", ...x]), { id: a.id });
  d.cancel = async (...x) => void calls.push(["cancel", ...x]);
  d.kill = async (...x) => void calls.push(["kill", ...x]);
  d.resumeAgent = async (...x) => (calls.push(["resume", ...x]), { id: a.id });
  await handle(t.daemon, { method: "POST", url: "/v1/agents/self/result", token: agentTok(t, a), body: { result: 1, idempotencyKey: "kr" } });
  await t.operator("POST", `/v1/agents/${a.id}/cancel`, { graceMs: 5, idempotencyKey: "kc" });
  await t.operator("POST", `/v1/agents/${a.id}/kill`, { idempotencyKey: "kk" });
  await t.operator("POST", `/v1/agents/${a.id}/resume`, { idempotencyKey: "ke" });
  assert.deepEqual(
    calls.map((c) => [c[0], c[0] === "result" ? c[4] : c.at(-1)]),
    [
      ["result", "kr"],
      ["cancel", "kc"],
      ["kill", "kk"],
      ["resume", "ke"],
    ],
  );
});

test("ext route fences a stale-generation agent token", async () => {
  const t = setup(async () => {});
  const a = await runningAgent(t, "a");
  const stale = t.daemon.agentToken(a.id, a.generation + 1);
  const r = await handle(t.daemon, { method: "GET", url: "/v1/ext", token: stale });
  assert.equal(r.status, 409);
  assert.equal((await handle(t.daemon, { method: "GET", url: "/v1/ext", token: agentTok(t, a) })).status, 200);
});

test("messages/failed validates purpose and caps subject/reason", async () => {
  const t = setup(async () => {}, { messagingChannels: ["discord"] });
  const tok = hostTok("discord");
  const base = { channel: "discord", purpose: "alert", subject: "s", reason: "r", idempotencyKey: "k" };
  const post = (b: object) => handle(t.daemon, { method: "POST", url: "/v1/messages/failed", token: tok, body: b });
  assert.equal((await post({ ...base, purpose: "bogus" })).status, 400);
  assert.equal((await post({ ...base, subject: "x".repeat(501) })).status, 400);
  assert.equal((await post({ ...base, reason: "x".repeat(2001) })).status, 400);
  assert.equal((await post(base)).status, 201);
});
