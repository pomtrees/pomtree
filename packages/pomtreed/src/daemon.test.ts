import { tmpDir } from "@pomtree/testing";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, JournalEntry } from "@pomtree/core";
import { ENV_LAYER_PATH, emptyManifest, mountPlan } from "@pomtree/agent-image";
import { handle } from "./api.ts";
import { listen, listenAgents } from "./server.ts";
import { kinds, op, setup, spawnSpec } from "./test-setup.ts";
import { bearer, sockRequest } from "./test-http.ts";

test("end to end: spawn, run, typed result, events tailable", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "message", role: "assistant", text: "on it" });
    c.emit({ kind: "tool_call", tool: "bash", callId: "1", input: { cmd: "ls" } });
    c.emit({ kind: "usage", inputTokens: 5, outputTokens: 5, costMicros: 10 });
    const r = await c.api("POST", "/v1/agents/self/result", { status: "succeeded", result: { summary: "ok", answer: 42 } });
    assert.equal(r.status, 200);
  });
  const root = await t.daemon.root();
  const a = await t.spawn();
  assert.equal(a.parent, root.id);
  assert.equal(a.state, "pending");
  await t.orchestrator.idle();

  const done = (await t.operator("GET", `/v1/agents/${a.id}`)).body as AgentRecord;
  assert.equal(done.state, "reaped"); // root supervisor reaps its children at once
  assert.equal(done.exit, "succeeded");
  assert.deepEqual(done.result, { summary: "ok", answer: 42 });

  const ev = (await t.operator("GET", `/v1/agents/${a.id}/events`)).body as JournalEntry[];
  assert.deepEqual(kinds(ev).sort(), [
    "exited:succeeded",
    "ext.pomtreed.op", // reap
    "ext.pomtreed.op", // result: every API call is keyed, so the keyed result journals its op
    "ext.pomtreed.result",
    "ext.pomtreed.sandbox",
    "ext.pomtreed.sandbox",
    "message",
    "reaped",
    "spawned",
    "started",
    "tool_call",
    "usage",
  ]);
  const sb = ev.map((e) => e.payload as unknown as Record<string, unknown>).filter((p) => p.kind === "ext.pomtreed.sandbox");
  assert.deepEqual(sb.map((p) => p.phase).sort(), ["exited", "started"], "sandbox lifecycle is journaled");
  assert.ok(
    sb.every((p) => p.agent === a.id && p.generation === a.generation && p.host === "h1" && p.sandbox === sb[0]!.sandbox && typeof p.sandbox === "string"),
  );
  assert.equal(sb.find((p) => p.phase === "exited")!.exitCode, 0);
  assert.ok(ev.every((e) => e.host === "h1" && e.generation === a.generation));

  const tail = (await t.operator("GET", `/v1/agents/${a.id}/events?from=${ev[4]!.seq}`)).body as JournalEntry[];
  assert.deepEqual(
    tail.map((e) => e.seq),
    ev.slice(4).map((e) => e.seq),
  );
  assert.equal(t.fakes.hooks.raw.sandbox.started[0]!.env.POMTREE_AGENT_ID, a.id);
  // Reusing the now-terminal key must conflict, not silently return the reaped record.
  assert.equal((await t.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k1" })).status, 409);
  assert.equal((await t.operator("GET", "/v1/agents?state=exited")).body instanceof Array, true);
});

test("spawn is idempotent and long-poll wakes on new events", async () => {
  const t = setup(async (c) => {
    await new Promise((r) => setTimeout(r, 30));
    c.emit({ kind: "message", role: "assistant", text: "late" });
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  const a = await t.spawn("same");
  assert.equal((await t.spawn("same")).id, a.id);
  const first = (await t.operator("GET", `/v1/agents/${a.id}/events`)).body as JournalEntry[];
  const next = (await t.operator("GET", `/v1/agents/${a.id}/events?from=${first.at(-1)!.seq + 1}&waitMs=2000`)).body as JournalEntry[];
  assert.ok(next.length >= 1);
  await t.orchestrator.idle();
});

test("harness ending without a result fails the agent", async () => {
  const t = setup(async (c) => c.emit({ kind: "message", role: "assistant", text: "bye" }));
  const a = await t.spawn();
  await t.orchestrator.idle();
  const r = (await t.operator("GET", `/v1/agents/${a.id}`)).body as AgentRecord;
  assert.equal(r.exit, "failed");
});

test("result is accepted once", async () => {
  let second = 0;
  const t = setup(async (c) => {
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "a" } });
    second = (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "b" } })).status;
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(second, 409);
  assert.deepEqual(((await t.operator("GET", `/v1/agents/${a.id}`)).body as AgentRecord).result, { summary: "ok", value: "a" });
});

test("budget overrun ends the agent over_budget", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 5_000 });
    await c.stopped;
  });
  const a = await t.spawn("k", { budgetMicros: 100 });
  await t.orchestrator.idle();
  assert.equal(((await t.operator("GET", `/v1/agents/${a.id}`)).body as AgentRecord).exit, "over_budget");
});

test("a provider_error is journaled and fails the agent", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "provider_error", code: "auth", message: "bad key", retryable: false });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(((await t.operator("GET", `/v1/agents/${a.id}`)).body as AgentRecord).exit, "failed");
  assert.ok(kinds(await t.journal.read({ agent: a.id })).includes("provider_error"));
});

test("spawning past the root budget cap is rejected with 409", async () => {
  const t = setup(async (c) => void (await c.stopped), { rootBudgetMicros: 1_000 });
  assert.equal((await t.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "big", budgetMicros: 2_000 })).status, 409);
  assert.equal((await t.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "ok", budgetMicros: 1_000 })).status, 201);
});

test("cancel signals the agent and ends it cancelled; kill force-stops", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await t.spawn("c");
  while (!((await t.daemon.get(a.id)) as AgentRecord).state.startsWith("run")) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/cancel`, {})).status, 202);
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(a.id)) as AgentRecord).exit, "cancelled");
  assert.ok(kinds(await t.journal.read({ agent: a.id })).includes("signal"));
  assert.equal((await t.operator("POST", `/v1/agents/${a.id}/kill`)).status, 409);

  const b = await t.spawn("k2");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await t.operator("POST", `/v1/agents/${b.id}/kill`)).status, 202);
  await t.orchestrator.idle();
  assert.equal(t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "kill").length, 1);
  assert.equal(((await t.daemon.get(b.id)) as AgentRecord).exit, "cancelled");
});

test("scopes are enforced server-side", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const a = await t.spawn();
  const agentTok = t.daemon.agentToken(a.id);
  const call = (token: string | undefined, method: string, url: string, body?: unknown) => handle(t.daemon, { method, url, token, body }).then((r) => r.status);

  assert.equal(await call(undefined, "GET", "/v1/agents"), 401);
  assert.equal(await call(op + "x", "GET", "/v1/agents"), 401);
  assert.equal(await call(agentTok.replace(a.id, "other"), "GET", "/v1/agents/other"), 401);
  assert.equal(await call(agentTok, "GET", "/v1/agents"), 403);
  assert.equal(await call(agentTok, "POST", `/v1/agents/${a.id}/kill`), 403);
  assert.equal(await call(agentTok, "GET", "/v1/agents/someone-else"), 403);
  assert.equal(await call(op, "POST", `/v1/agents/${a.id}/result`, { result: 1 }), 403);
  assert.equal(await call(op, "GET", "/v1/agents/self"), 400);
  assert.equal(await call(op, "GET", "/v1/agents/nope"), 404);
  assert.equal(await call(op, "POST", "/v1/agents", { task: "x" }), 400);
  assert.equal(await call(op, "GET", "/v1/agents?state=bogus"), 400);
  await t.daemon.kill(a.id);
  await t.orchestrator.idle();
});

test("agent-scoped spawn makes a child of the caller", async () => {
  const t = setup(async (c) => {
    if (c.prompt === "sub") return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "child done" } }));
    const r = await c.api("POST", "/v1/agents", { task: "sub", idempotencyKey: "child" });
    const child = r.body as AgentRecord;
    await c.api("GET", `/v1/agents/${child.id}/wait?timeoutMs=2000`);
    await c.api("POST", `/v1/agents/${child.id}/reap`);
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: child.parent === c.agent } });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.deepEqual(((await t.daemon.get(a.id)) as AgentRecord).result, { summary: "ok", value: true });
});

test("recover restarts pending and fails orphaned running agents", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } })), { maxRestarts: 0 });
  const reg = t.daemon.deps.registry;
  const root = await t.daemon.root();
  const orphan = await reg.create({ spec: spawnSpec, parent: root.id, name: "o", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "o" });
  await reg.transition(orphan.id, orphan.generation, "running", { idempotencyKey: "o-run" });
  const pending = await reg.create({ spec: spawnSpec, parent: root.id, name: "p", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "p" });
  await t.daemon.recover();
  await t.orchestrator.idle();
  assert.equal((await reg.get(orphan.id))!.exit, "failed");
  assert.equal((await reg.get(pending.id))!.exit, "succeeded");
  assert.equal((await reg.get(root.id))!.state, "running");
});

test("socket server speaks the same API", async () => {
  const t = setup(async () => {});
  const sock = join(tmpDir("pomtreed-"), "s.sock");
  const server = await listen(t.daemon, sock);
  const get = async (path: string, token?: string) => {
    const r = await sockRequest(sock, path, { headers: bearer(token) });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  try {
    assert.equal((await get("/v1/agents")).status, 401);
    const ok = await get("/v1/doctor", op);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.host, "h1");
  } finally {
    server.close();
  }
});

test("agent TCP endpoint rejects operator and anonymous tokens, serves agent tokens", async () => {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const { server, port } = await listenAgents(t.daemon, "127.0.0.1", 0);
  const get = (path: string, token?: string) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode! }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal((await get("/v1/doctor")).status, 401);
    assert.equal((await get("/v1/doctor", op)).status, 401);
    assert.equal((await get(`/v1/agents/${root.id}`, t.daemon.agentToken(root.id))).status, 200);
  } finally {
    server.close();
  }
});

test("with an agent API URL, agents get POMTREE_API and no socket mount", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })), {
    agentApiUrl: () => "http://host.docker.internal:7",
  });
  await t.spawn();
  await t.orchestrator.idle();
  const spec = t.fakes.hooks.raw.sandbox.started[0]!;
  const nonSession = (spec.mounts ?? []).filter((m) => m.kind === "bind");
  assert.deepEqual(nonSession, []);
  assert.ok((spec.mounts ?? []).some((m) => m.kind === "session" && m.containerPath === "/workspace/.pi-session"));
  assert.equal(spec.env.POMTREE_API, "http://host.docker.internal:7");
  assert.equal(spec.env.POMTREE_SOCKET, undefined);
});

test("events emitted after `pomtree result` land before exited, never after", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "message", role: "assistant", text: "before" });
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "r" } });
    c.emit({ kind: "message", role: "assistant", text: "after" });
    c.emit({ kind: "usage", inputTokens: 1, outputTokens: 1, costMicros: 1 });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const ev = await t.journal.read({ agent: a.id });
  const k = kinds(ev);
  assert.deepEqual(k.slice(-2), ["exited:succeeded", "reaped"]); // only the reap may follow exit
  assert.equal(k.filter((x) => x === "exited:succeeded").length, 1);
  assert.equal(k.filter((x) => x === "message").length, 2);
  assert.deepEqual(((await t.daemon.get(a.id)) as AgentRecord).result, { summary: "ok", value: "r" });
});

test("credentials are staged as a mount before start and removed at settle", async () => {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })), {
    credentials: {
      stage: (id) => (staged.push(id), [{ kind: "bind" as const, hostPath: "/host/auth", containerPath: "/c" }]),
      unstage: (id) => void unstaged.push(id),
    },
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const spec = t.fakes.hooks.raw.sandbox.started[0]!;
  assert.ok((spec.mounts ?? []).some((m) => m.kind === "bind" && m.hostPath === "/host/auth" && m.containerPath === "/c"));
  assert.deepEqual(staged, [a.id]);
  assert.deepEqual(unstaged, [a.id]);
});

test("sandbox is labelled with the agent and gets the daemon socket mounted", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  const a = await t.spawn();
  await t.orchestrator.idle();
  const spec = t.fakes.hooks.raw.sandbox.started[0]!;
  assert.equal(spec.agent, a.id);
  const nonSession = (spec.mounts ?? []).filter((m) => m.kind === "bind");
  assert.deepEqual(nonSession, [{ kind: "bind", hostPath: "/host/pomtreed.sock", containerPath: "/run/pomtreed.sock" }]);
  assert.ok((spec.mounts ?? []).some((m) => m.kind === "session" && m.agent === a.id && m.containerPath === "/workspace/.pi-session"));
  assert.ok((spec.mounts ?? []).some((m) => m.kind === "workspace" && m.containerPath === "/workspace"));
  assert.equal(spec.env.POMTREE_SOCKET, "/run/pomtreed.sock");
});

test("env layer mounts are added when deps.env is configured", async () => {
  const cacheRoot = realpathSync(tmpDir("env-cache-"));
  const manifest = emptyManifest();
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })), { env: { cacheRoot, manifest } });
  await t.spawn();
  await t.orchestrator.idle();
  const spec = t.fakes.hooks.raw.sandbox.started[0]!;
  const expected = mountPlan(manifest, { cacheRoot });
  const nonSession = (spec.mounts ?? []).filter((m) => m.kind === "bind");
  assert.deepEqual(nonSession, [{ kind: "bind", hostPath: "/host/pomtreed.sock", containerPath: "/run/pomtreed.sock" }, ...expected]);
  assert.equal(expected[0]!.containerPath, ENV_LAYER_PATH);
});

test("no env layer mounts when deps.env is absent", async () => {
  const t = setup(async (c) => void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } })));
  await t.spawn();
  await t.orchestrator.idle();
  const spec = t.fakes.hooks.raw.sandbox.started[0]!;
  assert.equal(
    (spec.mounts ?? []).some((m) => m.containerPath === ENV_LAYER_PATH),
    false,
  );
});

test("cancelling a never-started agent exits it via a legal transition", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const root = await t.daemon.root();
  const p = await t.daemon.deps.registry.create({ spec: spawnSpec, parent: root.id, name: "p", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "p" });
  await t.daemon.stop(p.id, 10);
  const r = (await t.daemon.get(p.id)) as AgentRecord;
  assert.equal(r.state, "reaped");
  assert.equal(r.exit, "cancelled");
});
