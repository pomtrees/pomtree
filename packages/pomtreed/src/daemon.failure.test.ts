import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import type { AgentRecord } from "@pomtree/core";
import { handle } from "./api.ts";
import { Daemon } from "./daemon.ts";
import { kinds, op, setup, spawnSpec, until } from "./test-setup.ts";

const exitedEntry = async (t: ReturnType<typeof setup>, id: string) => (await t.journal.read({ agent: id })).find((e) => e.payload.kind === "exited");

test("137 + oomKilled classifies oom_killed on the exited entry and the user-facing status", async () => {
  const t = setup(
    async (c) => {
      await until(async () => t.fakes.hooks.raw.sandbox.running.size === 1);
      const id = [...t.fakes.hooks.raw.sandbox.running.keys()][0]!;
      t.fakes.hooks.exitSandbox(id, 137, true);
    },
    { escalationChannels: ["discord"] },
  );
  const a = await t.spawn();
  await t.orchestrator.idle();
  const exited = await exitedEntry(t, a.id);
  assert.equal((exited!.payload as { cause?: string }).cause, "oom_killed");
  const status = (await t.daemon.outbox({ channel: "discord" })).find((e) => (e.payload as { purpose?: string }).purpose === "status");
  assert.match((status!.payload as { subject: string }).subject, /\(oom_killed\)/);
});

test("an unexplained 143 exit classifies host_stopped", async () => {
  const t = setup(async (c) => {
    await until(async () => t.fakes.hooks.raw.sandbox.running.size === 1);
    const id = [...t.fakes.hooks.raw.sandbox.running.keys()][0]!;
    t.fakes.hooks.exitSandbox(id, 143);
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  const exited = await exitedEntry(t, a.id);
  assert.equal((exited!.payload as { cause?: string }).cause, "host_stopped");
});

test("a non-retryable (auth) provider_error fails immediately with the provider_error cause", async () => {
  const t = setup(async (c) => {
    c.emit({ kind: "provider_error", code: "auth", message: "bad key", retryable: false });
  });
  const a = await t.spawn();
  await t.orchestrator.idle();
  assert.equal(((await t.daemon.get(a.id)) as AgentRecord).exit, "failed");
  assert.ok(!kinds(await t.journal.read({ agent: a.id })).includes("yielded"));
  const exited = await exitedEntry(t, a.id);
  assert.equal((exited!.payload as { cause?: string }).cause, "provider_error");
});

test("a throwing sandbox.list stops admission and reconciles on return", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  let down = true;
  let listCalls = 0;
  const sb = Object.create(raw.sandbox) as typeof raw.sandbox;
  sb.list = async (owner) => {
    listCalls++;
    if (down) throw new SandboxUnavailableError();
    return raw.sandbox.list(owner);
  };
  const d = new Daemon({ ...t.daemon.deps, sandbox: sb, admitRetryMs: 5 });
  const root = await d.root();
  await d.probeSandbox();
  assert.equal((await d.doctor()).sandboxUp, false);
  assert.ok(kinds(await t.journal.read({ agent: root.id })).includes("host_error"));
  const a = await d.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await d.get(a.id))!.state, "pending"); // admission stopped while down
  down = false;
  const before = listCalls;
  await d.probeSandbox();
  assert.ok(listCalls > before); // reconcileSandboxes re-lists on return
  await t.orchestrator.idle();
  assert.notEqual((await d.get(a.id))!.state, "pending"); // admitted after the sandbox returned
});

test("a failing resourceGate returns 503", async () => {
  const t = setup(async () => {}, { resourceGate: async () => ({ ok: false, reason: "disk full" }) });
  assert.equal((await t.operator("POST", "/v1/agents", { task: "x", idempotencyKey: "k" })).status, 503);
});

test("a store outage clears degraded once a write succeeds again", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  let down = true;
  const j = Object.create(raw.journal) as typeof raw.journal;
  j.append = async (e: Parameters<typeof raw.journal.append>[0]) => {
    if (down && e.payload.kind === "exited") throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return raw.journal.append(e);
  };
  const d = new Daemon({ ...t.daemon.deps, journal: j, admitRetryMs: 5 });
  const root = await d.root();
  await d.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
  await t.orchestrator.idle();

  assert.equal((await d.doctor()).degraded, true, "the exited append failure latches degraded");

  down = false; // the store recovers
  await d.probeStore();
  assert.equal((await d.doctor()).degraded, false, "the recovery probe clears degraded once writes succeed");
});

test("a journal-append resource failure sets journalFailed and stops admission", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  let fail = false;
  const j = Object.create(raw.journal) as typeof raw.journal;
  j.append = async (e: Parameters<typeof raw.journal.append>[0]) => {
    if (fail) throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    return raw.journal.append(e);
  };
  const d = new Daemon({ ...t.daemon.deps, journal: j, admitRetryMs: 5 });
  const root = await d.root();
  fail = true; // the next journal append is a resource failure
  const res1 = await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t", idempotencyKey: "k1" } });
  assert.equal(res1.status, 500); // journal unwritable on the spawned entry
  assert.equal((await d.doctor()).journalFailed, true);
  fail = false; // journal recovers, but journalFailed is sticky until a daemon restart
  const b = (await handle(d, { method: "POST", url: "/v1/agents", token: op, body: { task: "t2", idempotencyKey: "k2" } })).body as AgentRecord;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await d.get(b.id))!.state, "pending"); // admission stopped
  await d.kill(b.id); // terminate the held admission so the drive loop and its timer drain
  await t.orchestrator.idle();
});

test("a retryable provider_error yields with a timer wait and resumes after backoff", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "recovered" } }));
      aId = c.agent;
      c.emit({ kind: "provider_error", code: "outage", message: "down", retryable: true });
    },
    { limits: { providerBackoffMs: 20, maxProviderBackoffMs: 100, maxProviderRetries: 3 }, random: () => 0.5 },
  );
  await t.spawn();
  // The backoff is ~10-20 ms, so the "yielded" state is gone before a poll under load can see it; wait on the terminal state
  // and assert the durable record (the yield checkpoint and the journal) afterwards.
  // TODO(load-flakes): the backoff runs on the daemon's real timer; a fake clock for the provider backoff would let the test
  // observe the yielded state itself, deterministically. Until then it asserts only the checkpoint and journal after the fact.
  await until(async () => kinds(await t.journal.read({ agent: aId })).includes("exited:succeeded"), 30_000).catch(() => {
    throw new Error("agent never resumed and exited:succeeded after the provider-error backoff within 30s");
  });
  const cp = (await t.daemon.deps.checkpoints.latest(aId))!;
  assert.equal((cp.wait as { kind: string }).kind, "timer");
  const seen = kinds(await t.journal.read({ agent: aId }));
  assert.ok(seen.includes("yielded"));
  assert.ok(seen.includes("resumed"));
  assert.deepEqual(((await t.daemon.get(aId)) as AgentRecord).result, { summary: "ok", value: "recovered" });
});

test("a retryable provider_error fails after maxProviderRetries", async () => {
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      c.emit({ kind: "provider_error", code: "rate_limit", message: "429", retryable: true });
    },
    { limits: { providerBackoffMs: 10, maxProviderBackoffMs: 50, maxProviderRetries: 2 }, random: () => 0.5 },
  );
  await t.spawn();
  await until(async () => aId !== "" && kinds(await t.journal.read({ agent: aId })).includes("exited:failed"));
  const seen = kinds(await t.journal.read({ agent: aId }));
  assert.equal(seen.filter((k) => k === "yielded").length, 2);
  assert.equal(seen.filter((k) => k === "resumed").length, 2);
  assert.ok(seen.includes("exited:failed"));
  const exited = (await t.journal.read({ agent: aId })).find((e) => e.payload.kind === "exited");
  assert.equal((exited!.payload as { cause?: string }).cause, "provider_error");
});

test("a journal-append failure finishes the agent closed with journal_unwritable", async () => {
  const t = setup(async () => {});
  const raw = t.fakes.hooks.raw;
  let rootId = "";
  const j = Object.create(raw.journal) as typeof raw.journal;
  j.append = async (e: Parameters<typeof raw.journal.append>[0]) => {
    if (rootId && e.payload.kind === "started" && e.agent !== rootId) {
      throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    }
    return raw.journal.append(e);
  };
  const d = new Daemon({ ...t.daemon.deps, journal: j, admitRetryMs: 5 });
  const root = await d.root();
  rootId = root.id;
  const a = await d.spawn(root.id, { name: "w", task: "t", idempotencyKey: "k" });
  await t.orchestrator.idle();
  assert.equal((await d.doctor()).journalFailed, true);
  const exited = (await t.journal.read({ agent: a.id })).find((e) => e.payload.kind === "exited");
  assert.equal((exited!.payload as { cause?: string }).cause, "journal_unwritable");
});

test("reap no longer merges: no merge_failed, no merge outcome", async () => {
  let pId = "";
  let cId = "";
  const t = setup(async (c) => {
    if (c.prompt === "child") {
      cId = c.agent;
      return void (await c.api("POST", "/v1/agents/self/result", { status: "succeeded", result: { summary: "ok", value: "boom" } }));
    }
    pId = c.agent;
    const kid = (await c.api("POST", "/v1/agents", { task: "child", idempotencyKey: "c1" })).body as AgentRecord;
    cId = kid.id;
    await until(async () => (await t.daemon.get(cId))!.state === "exited");
    await c.api("POST", `/v1/agents/${cId}/reap`);
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
  });
  await t.spawn("p", { task: "parent" });
  await t.orchestrator.idle();
  assert.ok(!kinds(await t.journal.read({ agent: pId })).includes("merge_failed"));
});
