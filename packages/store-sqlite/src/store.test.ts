import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKPOINT_FORMAT, IdempotencyConflictError, IllegalTransitionError, StaleGenerationError, UnsupportedCheckpointVersion } from "@pomtree/core";
import type { ApprovalRequester, ExitCause, ExitStatus, Schedule, WatchdogState } from "@pomtree/core";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, STORE_APPLICATION_ID } from "./store.ts";
import {
  checkpointFenceContractBody,
  contract,
  hostStoreContractBody,
  mailboxContractBody,
  raiseBudgetContractBody,
  registryListContractBody,
  scheduleContractBody,
  tmpDir,
} from "@pomtree/testing";
import type {
  CheckpointFenceContractWorld,
  HostStoreContractWorld,
  MailboxContractWorld,
  RaiseBudgetContractWorld,
  RegistryListContractWorld,
  ScheduleContractWorld,
} from "@pomtree/testing";

contract<ScheduleContractWorld>("ScheduleStore", { real: () => openStore() })("upsert/pause/breaker/lastFired", scheduleContractBody);

contract<HostStoreContractWorld>("HostStore", {
  real: () => {
    const s = openStore();
    return { hosts: s.hosts, age: (ms) => new Promise((r) => setTimeout(r, ms)) };
  },
})("upsert/state/reserve/order/release", hostStoreContractBody);

contract<CheckpointFenceContractWorld>("CheckpointStore", { real: () => openStore() })("generation fence, replay, no path field", checkpointFenceContractBody);

contract<MailboxContractWorld>("Mailbox", { real: () => openStore() })("ids, level coalescing, ack", mailboxContractBody);

contract<RaiseBudgetContractWorld>("Registry", { real: () => openStore() })("raiseBudget idempotent by key", raiseBudgetContractBody);
contract<RegistryListContractWorld>("Registry", { real: () => openStore() })("list filters", registryListContractBody);

const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };
const newAgent = (key: string, parent: string | null = null) => ({ parent, name: "a", task: "t", host: "h1", budgetMicros: 100, idempotencyKey: key, spec });
const entry = (agent: string, generation: number, key: string) => ({
  agent,
  host: "h1",
  generation,
  idempotencyKey: key,
  payload: { kind: "started" as const },
});

test("registry.create is idempotent", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  const b = await s.registry.create(newAgent("k"));
  assert.equal(a.id, b.id);
  assert.equal((await s.registry.list()).length, 1);
  assert.equal(a.state, "pending");
});

test("registry.transition is fenced by generation", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  await s.registry.transition(a.id, 0, "running", { idempotencyKey: "t1" });
  const bumped = await s.registry.bumpGeneration(a.id, "h2", "t14");
  assert.equal(bumped.generation, 1);
  assert.equal(bumped.host, "h2");
  await assert.rejects(() => s.registry.transition(a.id, 0, "exited", { exit: "failed", idempotencyKey: "t2" }), StaleGenerationError);
  const done = await s.registry.transition(a.id, 1, "exited", { exit: "succeeded", result: { ok: 1 }, idempotencyKey: "t3" });
  assert.deepEqual(done.result, { ok: 1 });
  assert.equal(done.exit, "succeeded");
});

test("registry.create honors a caller-chosen id", async () => {
  const s = openStore();
  const a = await s.registry.create({ ...newAgent("k"), id: "root" });
  assert.equal(a.id, "root");
  assert.equal((await s.registry.get("root"))?.id, "root");
  assert.equal((await s.registry.create({ ...newAgent("k2") })).id.length > 0, true);
});

test("registry.transition rejects illegal edges after the generation check", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  await assert.rejects(() => s.registry.transition(a.id, 0, "exited", { idempotencyKey: "t4" }), IllegalTransitionError);
  await assert.rejects(() => s.registry.transition(a.id, 0, "reaped", { idempotencyKey: "t5" }), IllegalTransitionError);
  await s.registry.transition(a.id, 0, "running", { idempotencyKey: "t6" });
  await s.registry.transition(a.id, 0, "yielded", { idempotencyKey: "t7" });
  await s.registry.transition(a.id, 0, "running", { idempotencyKey: "t8" });
  await s.registry.transition(a.id, 0, "exited", { exit: "succeeded", idempotencyKey: "t9" });
  await assert.rejects(() => s.registry.transition(a.id, 0, "running", { idempotencyKey: "t10" }), IllegalTransitionError);
  await s.registry.transition(a.id, 0, "reaped", { idempotencyKey: "t11" });
  await assert.rejects(() => s.registry.transition(a.id, 0, "exited", { idempotencyKey: "t12" }), IllegalTransitionError);
  // stale generation wins over illegality
  await s.registry.bumpGeneration(a.id, "h1", "t15");
  await assert.rejects(() => s.registry.transition(a.id, 0, "exited", { idempotencyKey: "t13" }), StaleGenerationError);
  assert.equal((await s.registry.get(a.id))?.state, "reaped");
});

test("journal.read from is inclusive", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("a"));
  await s.journal.append(entry(a.id, 0, "1"));
  const e2 = await s.journal.append(entry(a.id, 0, "2"));
  await s.journal.append(entry(a.id, 0, "3"));
  const got = await s.journal.read({ from: e2.seq });
  assert.deepEqual(
    got.map((e) => e.seq),
    [e2.seq, e2.seq + 1],
  );
});

test("journal.append is idempotent and fenced", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  const e1 = await s.journal.append(entry(a.id, 0, "j1"));
  const e1b = await s.journal.append(entry(a.id, 0, "j1"));
  assert.equal(e1.seq, e1b.seq);
  assert.equal((await s.journal.read({})).length, 1);
  await s.registry.bumpGeneration(a.id, "h1", "t16");
  await assert.rejects(() => s.journal.append(entry(a.id, 0, "j2")), StaleGenerationError);
  assert.equal((await s.journal.read({})).length, 1);
  const e2 = await s.journal.append(entry(a.id, 1, "j3"));
  assert.ok(e2.seq > e1.seq);
});

test("journal usage events round-trip the model field", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("a"));
  await s.journal.append({
    agent: a.id,
    host: "h1",
    generation: 0,
    idempotencyKey: "u1",
    payload: { kind: "usage", inputTokens: 10, outputTokens: 5, costMicros: 42, model: "deepseek-v4-pro" },
  });
  const [e] = await s.journal.read({ agent: a.id });
  assert.equal(e?.payload.kind, "usage");
  if (e?.payload.kind === "usage") assert.equal(e.payload.model, "deepseek-v4-pro");
});

test("journal.subscribe replays then tails; filters by agent", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("a"));
  const b = await s.registry.create(newAgent("b"));
  await s.journal.append(entry(a.id, 0, "1"));
  await s.journal.append(entry(b.id, 0, "2"));
  const sub = s.journal.subscribe({ from: 0, agent: a.id });
  const it = sub[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.value.agent, a.id);
  const pending = it.next();
  await s.journal.append(entry(b.id, 0, "3"));
  await s.journal.append(entry(a.id, 0, "4"));
  const second = await pending;
  assert.equal(second.value.agent, a.id);
  assert.equal(second.value.seq, 4);
  sub.close();
  assert.equal((await it.next()).done, true);
});

test("subscribe from a later seq skips earlier entries", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("a"));
  await s.journal.append(entry(a.id, 0, "1"));
  const e2 = await s.journal.append(entry(a.id, 0, "2"));
  const sub = s.journal.subscribe({ from: e2.seq });
  const r = await sub[Symbol.asyncIterator]().next();
  assert.equal(r.value.seq, e2.seq);
  sub.close();
});

test("mailbox: peek leaves, receive consumes, send is idempotent", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("mk"), id: "x" });
  await s.mailbox.send("x", { kind: "cancel", graceMs: 1 }, "m1");
  await s.mailbox.send("x", { kind: "cancel", graceMs: 1 }, "m1");
  await s.mailbox.send("x", { kind: "timeout" }, "m2");
  assert.equal((await s.mailbox.peek("x")).length, 2);
  assert.equal((await s.mailbox.peek("x")).length, 2);
  const got = await s.mailbox.receive("x", "r1", { limit: 1 });
  assert.deepEqual(got, [{ kind: "cancel", graceMs: 1, id: "m1" }]);
  assert.deepEqual(await s.mailbox.receive("x", "r2"), [{ kind: "timeout", id: "m2" }]);
  assert.deepEqual(await s.mailbox.receive("x", "r3"), []);
});

test("checkpoints: latest, read, idempotent write", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const base = {
    agent: "a",
    host: "h1",
    generation: 0,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h1",
    ingested: { ref: "refs/agents/a/heads/agent/a", commit: "c1" },
    wait: null,
    remainingBudgetMicros: 5,
    imageDigest: "sha256:x",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  const c1 = await s.checkpoints.write(base, "k1");
  const c1b = await s.checkpoints.write(base, "k1");
  assert.equal(c1.id, c1b.id);
  const c2 = await s.checkpoints.write({ ...base, ingested: { ref: "refs/agents/a/heads/agent/a", commit: "c2" } }, "k2");
  assert.equal((await s.checkpoints.latest("a"))?.id, c2.id);
  assert.equal((await s.checkpoints.read(c1.id))?.ingested?.commit, "c1");
  assert.equal(await s.checkpoints.latest("none"), null);
});

// A child process that holds `file`'s write lock (BEGIN IMMEDIATE). Resolves only once the child reports the lock is held,
// and rejects with the child's stderr when it exits first (cannot open the file, crashed), so a broken helper fails the test
// as a helper failure instead of letting a product assertion run against an unlocked database. (It used to signal nothing and
// the test slept 150 ms instead: on a loaded CI runner the child started later than that, the busy_timeout=0 write found no
// lock, and the child then hit the removed temp dir: "unable to open database file".) The child commits when release() ends
// its stdin, or by itself after holdMs: a caller whose write waits on the lock blocks its own event loop (node:sqlite is
// synchronous), so it cannot call release() meanwhile. release() resolves to the wall-clock ms at which the child began its
// COMMIT, so a caller can check that its write was issued while the lock was still held.
const holdLock = async (file: string, holdMs = 0) => {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    let timer;
    const release = () => {
      if (!db.isTransaction) return;
      clearTimeout(timer);
      process.stdout.write("released " + Date.now() + "\\n");
      db.exec("COMMIT");
      db.close();
      process.stdin.destroy();
    };
    process.stdin.on("end", release);
    process.stdin.resume();
    const holdMs = Number(process.argv[2]);
    if (holdMs > 0) timer = setTimeout(release, holdMs);
  `;
  const child = spawn(process.execPath, ["-e", script, file, String(holdMs)], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  // Ending stdin of a child that already exited raises EPIPE on the stream; the exit code below reports that case.
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((res, rej) => {
    child.on("error", rej);
    child.on("exit", (code) => res(code));
  });
  const failure = (what: string, code: number | null) =>
    new Error(`lock-holder child ${what} (exit code ${code}) on ${file}; fix the test helper or the environment. Child stderr: ${err.trim() || "(empty)"}`);
  await new Promise<void>((res, rej) => {
    const onData = () => {
      if (!out.includes("locked\n")) return;
      child.stdout.off("data", onData);
      res();
    };
    child.stdout.on("data", onData);
    exited.then((code) => rej(failure("exited before it held the lock", code)), rej);
  });
  const release = async (): Promise<number> => {
    child.stdin.end();
    const code = await exited;
    const released = /released (\d+)/.exec(out);
    if (code !== 0 || !released) throw failure("did not release the lock cleanly", code);
    return Number(released[1]);
  };
  return { release, kill: () => child.kill() };
};

test("busy_timeout: a write waits for another process's lock instead of failing", async () => {
  const dir = tmpDir("store-busy-");
  const holders: Array<{ kill(): void }> = [];
  try {
    const file = join(dir, "s.sqlite");
    const a = openStore(file);
    const b = openStore(file, { busyTimeoutMs: 0 });
    await a.registry.create({ id: "x", parent: null, name: "x", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "cx", spec });
    const entry = (k: string) => ({ idempotencyKey: k, agent: "x", host: "h", generation: 0, payload: { kind: "spawned" as const } });
    // Negative control: with busy_timeout 0 a write while another process holds the lock is refused at once.
    const held1 = await holdLock(file);
    holders.push(held1);
    await assert.rejects(b.journal.append(entry("k0")), /locked|busy/i);
    await held1.release();
    // The default busy_timeout waits: the child commits by itself after 500 ms while this write blocks on the lock.
    const held2 = await holdLock(file, 500);
    holders.push(held2);
    const issuedAt = Date.now();
    assert.equal((await a.journal.append(entry("k1"))).seq, 1);
    const releasedAt = await held2.release();
    assert.ok(issuedAt < releasedAt, `the write must be issued while the lock is held (issued ${issuedAt}, released ${releasedAt})`);
    a.close();
    b.close();
  } finally {
    for (const h of holders) h.kill();
  }
});

test("holdLock helper: a child that cannot open the database fails loudly with its stderr, not as a product assertion", async () => {
  // The CI failure's shape: the child's directory is gone, so SQLite cannot create the file.
  await assert.rejects(
    holdLock(join(tmpDir("store-busy-"), "missing", "s.sqlite")),
    /exited before it held the lock \(exit code 1\).*unable to open database file/s,
  );
});

test("close() ends live subscriptions cleanly, consumed or not", async () => {
  const s = openStore();
  const sub = s.journal.subscribe({ from: 1 });
  const it = sub[Symbol.asyncIterator]();
  const pending = it.next();
  const unconsumed = s.journal.subscribe({});
  s.close();
  assert.equal((await pending).done, true);
  assert.equal((await it.next()).done, true);
  assert.equal((await unconsumed[Symbol.asyncIterator]().next()).done, true);
});

test("registry.transition is idempotent: a retried key does not re-apply, even after later changes", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  const first = await s.registry.transition(a.id, 0, "running", { idempotencyKey: "r1" });
  await s.registry.transition(a.id, 0, "exited", { exit: "succeeded", idempotencyKey: "r2" });
  // replaying r1 would be illegal (exited -> running) and stale after a bump, yet must return the original
  await s.registry.bumpGeneration(a.id, "h2", "b0");
  const replay = await s.registry.transition(a.id, 0, "running", { idempotencyKey: "r1" });
  assert.deepEqual(replay, first);
  const now = await s.registry.get(a.id);
  assert.equal(now?.state, "exited");
  assert.equal(now?.generation, 1);
});

test("registry.transition: a failed attempt leaves its key unused", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  await assert.rejects(() => s.registry.transition(a.id, 0, "exited", { idempotencyKey: "x" }), IllegalTransitionError);
  assert.equal((await s.registry.transition(a.id, 0, "running", { idempotencyKey: "x" })).state, "running");
});

test("registry.bumpGeneration is idempotent: a retried resume bumps once", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  const b1 = await s.registry.bumpGeneration(a.id, "h2", "resume-1");
  const b2 = await s.registry.bumpGeneration(a.id, "h2", "resume-1");
  assert.equal(b1.generation, 1);
  assert.deepEqual(b2, b1);
  assert.equal((await s.registry.get(a.id))?.generation, 1);
  assert.equal((await s.registry.bumpGeneration(a.id, "h3", "resume-2")).generation, 2);
});

test("idempotency keys are scoped per operation", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("same"));
  await s.registry.transition(a.id, 0, "running", { idempotencyKey: "same" });
  assert.equal((await s.registry.bumpGeneration(a.id, "h2", "same")).generation, 1);
});

test("registry.setSandbox records and clears the sandbox id, fenced by generation", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  assert.equal(a.sandbox, null);
  assert.equal((await s.registry.setSandbox(a.id, 0, "sb1", "s1")).sandbox, "sb1");
  assert.equal((await s.registry.get(a.id))?.sandbox, "sb1");
  await s.registry.bumpGeneration(a.id, "h2", "b");
  await assert.rejects(() => s.registry.setSandbox(a.id, 0, null, "s2"), StaleGenerationError);
  assert.equal((await s.registry.setSandbox(a.id, 1, null, "s3")).sandbox, null);
  await assert.rejects(() => s.registry.setSandbox("nope", 0, "x", "s4"), /unknown agent/);
});

test("mailbox.send rejects unknown and reaped targets; fences a stale message sender; daemon signals skip the sender check", async () => {
  const s = openStore();
  const a = await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.registry.create({ ...newAgent("t"), id: "t" });
  await s.registry.bumpGeneration("a", "h2", "b");
  const msg = { kind: "message" as const, from: "a", body: "hi" };

  // unknown target is rejected (nothing accumulates)
  await assert.rejects(() => s.mailbox.send("nope", msg, "m0", 1), /unknown agent nope/);

  // stale sender fence
  await assert.rejects(() => s.mailbox.send("t", msg, "m1", 0), StaleGenerationError);
  assert.equal((await s.mailbox.peek("t")).length, 0);
  await s.mailbox.send("t", msg, "m2", 1);
  // unknown sender is rejected
  await assert.rejects(() => s.mailbox.send("t", { ...msg, from: "ghost-sender" }, "m3", 7), /unknown agent ghost-sender/);
  // daemon-originated signals (no senderGeneration) skip the sender check
  await s.mailbox.send("t", { kind: "cancel", graceMs: 1 }, "m4");
  await s.mailbox.send("t", msg, "m5"); // no senderGeneration: daemon-originated, unchecked
  assert.equal((await s.mailbox.peek("t")).length, 3);
  // a retry of an accepted send replays even though the sender's generation has since moved
  await s.registry.bumpGeneration("a", "h3", "b2");
  await s.mailbox.send("t", msg, "m2", 1);
  assert.equal((await s.mailbox.peek("t")).length, 3);

  // a reaped target is rejected and nothing new accumulates
  await s.registry.transition("t", 0, "running", { idempotencyKey: "r1" });
  await s.registry.transition("t", 0, "exited", { exit: "succeeded", idempotencyKey: "r2" });
  await s.registry.transition("t", 0, "reaped", { idempotencyKey: "r3" });
  await assert.rejects(() => s.mailbox.send("t", msg, "m6", 1), /reaped agent t/);
  assert.equal((await s.mailbox.peek("t")).length, 3);

  assert.equal(a.generation, 0);
});

test("journal.append rejects agents with no registry row", async () => {
  const s = openStore();
  await assert.rejects(() => s.journal.append(entry("ghost", 0, "j1")), /unknown agent ghost/);
  assert.equal((await s.journal.read({})).length, 0);
  // a failed append leaves its idempotency key unused: the same key succeeds once the agent exists
  await s.registry.create({ ...newAgent("g"), id: "ghost" });
  const e = await s.journal.append(entry("ghost", 0, "j1"));
  assert.ok(e.seq > 0);
});

test("checkpoint.write requires a registry row and rejects stale generations", async () => {
  const s = openStore();
  const base = {
    agent: "a",
    host: "h1",
    generation: 0,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h1",
    ingested: { ref: "refs/agents/a/heads/agent/a", commit: "c1" },
    wait: null,
    remainingBudgetMicros: 5,
    imageDigest: "sha256:x",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  await assert.rejects(() => s.checkpoints.write(base, "k0"), /unknown agent a/);
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const c1 = await s.checkpoints.write(base, "k1");
  await s.registry.bumpGeneration("a", "h2", "b");
  await assert.rejects(() => s.checkpoints.write({ ...base, ingested: { ref: "refs/agents/a/heads/agent/a", commit: "c2" } }, "k2"), StaleGenerationError);
  const c3 = await s.checkpoints.write({ ...base, generation: 1, ingested: null }, "k3");
  assert.equal((await s.checkpoints.latest("a"))?.id, c3.id);
  // a replay of an accepted write returns the original even after the generation has since moved
  await s.registry.bumpGeneration("a", "h3", "b2");
  assert.equal((await s.checkpoints.write(base, "k1")).id, c1.id);
});

const sched = (id: string, over: Partial<Omit<Schedule, "id" | "createdAt">> = {}): Omit<Schedule, "createdAt"> => ({
  id,
  cron: "0 0 * * *",
  task: "run",
  missed: "skip",
  overlap: "skip",
  jitterMs: 0,
  ...over,
});

test("schedules: upsert creates then replaces preserving createdAt, idempotent replay", async () => {
  const s = openStore();
  const first = await s.schedules.upsert(sched("s1"), "k1");
  const replay = await s.schedules.upsert(sched("s1"), "k1");
  assert.deepEqual(replay, first);
  assert.ok(first.createdAt > 0);
  const replaced = await s.schedules.upsert(sched("s1", { cron: "1 2 3 4 5", task: "t2", missed: "run-one", overlap: "queue", tz: "UTC", jitterMs: 7 }), "k2");
  assert.equal(replaced.createdAt, first.createdAt);
  assert.equal(replaced.cron, "1 2 3 4 5");
  assert.equal(replaced.task, "t2");
  assert.equal(replaced.missed, "run-one");
  assert.equal(replaced.overlap, "queue");
  assert.equal(replaced.tz, "UTC");
  assert.equal(replaced.jitterMs, 7);
  assert.equal((await s.schedules.list()).length, 1);
});

test("schedules: get/list round-trip fields and omit tz when absent", async () => {
  const s = openStore();
  await s.schedules.upsert(sched("s1", { tz: "Europe/London" }), "k1");
  await s.schedules.upsert(sched("s2"), "k2");
  const got = await s.schedules.get("s1");
  assert.equal(got?.tz, "Europe/London");
  assert.equal(got?.missed, "skip");
  assert.equal((await s.schedules.get("s2"))?.tz, undefined);
  assert.equal(await s.schedules.get("nope"), null);
  assert.deepEqual(
    (await s.schedules.list()).map((x) => x.id),
    ["s1", "s2"],
  );
});

test("schedules: remove returns existence and clears the last-fired cursor", async () => {
  const s = openStore();
  await s.schedules.upsert(sched("s1"), "k1");
  await s.schedules.setLastFired("s1", 100, "f1");
  assert.equal(await s.schedules.lastFired("s1"), 100);
  assert.equal(await s.schedules.remove("s1"), true);
  assert.equal(await s.schedules.remove("s1"), false);
  assert.equal(await s.schedules.lastFired("s1"), null);
  assert.equal((await s.schedules.list()).length, 0);
});

test("schedules: lastFired/setLastFired round-trip and idempotency", async () => {
  const s = openStore();
  assert.equal(await s.schedules.lastFired("s1"), null);
  await s.schedules.setLastFired("s1", 10, "f1");
  await s.schedules.setLastFired("s1", 999, "f1"); // replay: ignored
  assert.equal(await s.schedules.lastFired("s1"), 10);
  await s.schedules.setLastFired("s1", 20, "f2");
  assert.equal(await s.schedules.lastFired("s1"), 20);
});

// Watchdog get/set/clear are the shared WatchdogStore contract body (e2e contract.test.ts); this helper serves the store-specific cases.
const wd = (rung: WatchdogState["rung"], over: Partial<WatchdogState> = {}): WatchdogState => ({ rung, lastActionAt: null, retries: 0, ...over });

const newEsc = (id: string, agent: string, generation: number) => ({
  id,
  agent,
  host: "h1",
  generation,
  question: "q",
  options: ["a", "b"],
});

test("escalations: create is idempotent by key and id, fenced by generation", async () => {
  const s = openStore();
  await assert.rejects(() => s.escalations.create(newEsc("es-1", "ghost", 0), "k0"), /unknown agent ghost/);
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const e1 = await s.escalations.create(newEsc("es-1", "a", 0), "k1");
  assert.equal(e1.state, "open");
  assert.equal(e1.answer, null);
  assert.deepEqual(e1.options, ["a", "b"]);
  assert.deepEqual(await s.escalations.create(newEsc("es-1", "a", 0), "k1"), e1); // key replay
  assert.equal((await s.escalations.create(newEsc("es-1", "a", 0), "k2")).id, e1.id); // id replay, new key
  assert.equal((await s.escalations.list()).length, 1);
  await s.registry.bumpGeneration("a", "h2", "b");
  await assert.rejects(() => s.escalations.create(newEsc("es-2", "a", 0), "k3"), StaleGenerationError);
  const e2 = await s.escalations.create(newEsc("es-2", "a", 1), "k4");
  assert.equal(e2.generation, 1);
  assert.equal((await s.escalations.list()).length, 2);
});

test("escalations: get and list filter by agent and state", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.registry.create({ ...newAgent("b"), id: "b" });
  await s.escalations.create(newEsc("es-1", "a", 0), "k1");
  await s.escalations.create(newEsc("es-2", "b", 0), "k2");
  assert.equal((await s.escalations.get("es-1"))?.agent, "a");
  assert.equal(await s.escalations.get("nope"), null);
  assert.deepEqual(
    (await s.escalations.list({ agent: "a" })).map((x) => x.id),
    ["es-1"],
  );
  assert.deepEqual(
    (await s.escalations.list({ state: "open" })).map((x) => x.id),
    ["es-1", "es-2"],
  );
  await s.escalations.answer("es-1", "yes", { channel: "discord", sender: "u" }, "a1");
  assert.deepEqual(
    (await s.escalations.list({ state: "answered" })).map((x) => x.id),
    ["es-1"],
  );
  assert.deepEqual(await s.escalations.list({ agent: "a", state: "open" }), []);
});

test("escalations: answer first-answer-wins and is idempotent", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.escalations.create(newEsc("es-1", "a", 0), "k1");
  const by1 = { channel: "discord", sender: "u1" };
  const by2 = { channel: "slack", sender: "u2" };
  const a1 = await s.escalations.answer("es-1", "yes", by1, "a1");
  assert.equal(a1.state, "answered");
  assert.equal(a1.answer, "yes");
  assert.deepEqual(a1.answeredBy, by1);
  assert.ok(a1.answeredAt !== null);
  const a2 = await s.escalations.answer("es-1", "no", by2, "a2"); // first answer wins
  assert.equal(a2.answer, "yes");
  assert.deepEqual(a2.answeredBy, by1);
  assert.deepEqual(await s.escalations.answer("es-1", "yes", by1, "a1"), a1); // replay of the same request
  // A replay of key a1 with a different answer is a conflict, not the first result (idem-fingerprint).
  await assert.rejects(() => s.escalations.answer("es-1", "again", by2, "a1"), IdempotencyConflictError);
  await assert.rejects(() => s.escalations.answer("nope", "x", by1, "a3"), /unknown escalation nope/);
  assert.equal((await s.escalations.get("es-1"))?.answer, "yes");
});

const newAp = (id: string, requester: ApprovalRequester, action: { kind: string; target: string } = { kind: "extension", target: "ext-1" }) => ({
  id,
  requester,
  action,
  host: "h1",
  deadlineAt: 10_000,
});

test("approvals: create is idempotent by key and id, fenced by generation", async () => {
  const s = openStore();
  await assert.rejects(() => s.approvals.create(newAp("ap-1", { id: "ghost", rank: "agent", generation: 0 }), "k0"), /unknown agent ghost/);
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const a1 = await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1");
  assert.equal(a1.state, "pending");
  assert.deepEqual(a1.rungs, ["parent-agent", "operator", "owner"]);
  assert.equal(a1.rungIndex, 0);
  assert.deepEqual(a1.journal, []);
  assert.deepEqual(await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1"), a1); // key replay
  assert.equal((await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k2")).id, a1.id); // id replay, new key
  assert.equal((await s.approvals.list()).length, 1);
  await s.registry.bumpGeneration("a", "h2", "b");
  await assert.rejects(() => s.approvals.create(newAp("ap-2", { id: "a", rank: "agent", generation: 0 }), "k3"), StaleGenerationError);
  const a2 = await s.approvals.create(newAp("ap-2", { id: "a", rank: "agent", generation: 1 }), "k4");
  assert.equal(a2.requester.generation, 1);
  assert.equal((await s.approvals.list()).length, 2);
});

test("approvals: get and list filter by requester and state", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.registry.create({ ...newAgent("b"), id: "b" });
  await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1");
  await s.approvals.create(newAp("ap-2", { id: "b", rank: "agent", generation: 0 }), "k2");
  assert.equal((await s.approvals.get("ap-1"))?.requester.id, "a");
  assert.equal(await s.approvals.get("nope"), null);
  assert.deepEqual(
    (await s.approvals.list({ requester: "a" })).map((x) => x.id),
    ["ap-1"],
  );
  assert.deepEqual(
    (await s.approvals.list({ state: "pending" })).map((x) => x.id),
    ["ap-1", "ap-2"],
  );
  await s.approvals.decide("ap-1", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1");
  assert.deepEqual(
    (await s.approvals.list({ state: "denied" })).map((x) => x.id),
    ["ap-1"],
  );
});

test("approvals: deny is final and decide is idempotent", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1");
  const denied = await s.approvals.decide("ap-1", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1");
  assert.equal(denied.state, "denied");
  assert.equal(denied.journal.length, 1);
  assert.equal(denied.journal[0]!.decision, "deny");
  assert.equal(denied.journal[0]!.who, "owner");
  assert.ok(denied.decidedAt !== null);
  assert.deepEqual(await s.approvals.decide("ap-1", { who: "owner", rank: "owner", decision: "approve", why: "yes" }, "d2"), denied); // settled: replay
  assert.deepEqual(await s.approvals.decide("ap-1", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1"), denied); // key replay
  await assert.rejects(() => s.approvals.decide("nope", { who: "owner", rank: "owner", decision: "approve", why: "y" }, "d3"), /unknown approval nope/);
});

test("approvals: abstain/escalate/timeout advance rungs and fail closed past the top", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1");
  const afterAbstain = await s.approvals.decide("ap-1", { who: "p", rank: "parent-agent", decision: "abstain", why: "not mine" }, "d1");
  assert.equal(afterAbstain.state, "pending");
  assert.equal(afterAbstain.rungIndex, 1);
  assert.equal(afterAbstain.journal[0]!.rung, "parent-agent");
  const afterEscalate = await s.approvals.decide("ap-1", { who: "op", rank: "operator", decision: "escalate", why: "too big" }, "d2");
  assert.equal(afterEscalate.state, "pending");
  assert.equal(afterEscalate.rungIndex, 2);
  const afterTimeout = await s.approvals.timeout("ap-1", "t1");
  assert.equal(afterTimeout.state, "denied"); // owner rung timed out -> fail closed
  assert.equal(afterTimeout.journal[2]!.decision, "timeout");
  assert.equal(afterTimeout.journal[2]!.who, null);
  assert.equal(afterTimeout.rungIndex, 3); // past the top
});

test("approvals: timeout is idempotent and no-op on a settled record", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1");
  const t1 = await s.approvals.timeout("ap-1", "t1");
  assert.equal(t1.state, "pending");
  assert.equal(t1.rungIndex, 1);
  assert.deepEqual(await s.approvals.timeout("ap-1", "t1"), t1); // replay
  const approved = await s.approvals.decide("ap-1", { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  assert.equal(approved.state, "approved");
  assert.equal((await s.approvals.timeout("ap-1", "t2")).state, "approved"); // no-op on settled
});

test("approvals: approver rank must exceed requester rank", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  await s.approvals.create(newAp("ap-1", { id: "a", rank: "agent", generation: 0 }), "k1");
  await assert.rejects(() => s.approvals.decide("ap-1", { who: "peer", rank: "agent", decision: "approve", why: "y" }, "d1"), /does not exceed/);
  const approved = await s.approvals.decide("ap-1", { who: "op", rank: "operator", decision: "approve", why: "y" }, "d2");
  assert.equal(approved.state, "approved");

  const apOp = await s.approvals.create(newAp("ap-2", { id: "op1", rank: "operator" }), "k2");
  assert.deepEqual(apOp.rungs, ["owner"]);
  await assert.rejects(() => s.approvals.decide("ap-2", { who: "op2", rank: "operator", decision: "approve", why: "y" }, "d3"), /does not exceed/);
  const approvedOwner = await s.approvals.decide("ap-2", { who: "owner", rank: "owner", decision: "approve", why: "y" }, "d4");
  assert.equal(approvedOwner.state, "approved");

  const apOwner = await s.approvals.create(newAp("ap-3", { id: "o", rank: "owner" }), "k3");
  assert.deepEqual(apOwner.rungs, []);
});

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("sessions: put returns the sha256 ref and is idempotent (single row)", async () => {
  const dir = tmpDir("store-sess-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  const bytes = new TextEncoder().encode("session bytes");
  const ref = await s.sessions.put(bytes);
  assert.equal(ref, sha256hex(bytes));
  assert.equal(ref.length, 64);
  assert.equal(await s.sessions.put(bytes), ref);
  const check = new DatabaseSync(file);
  const rows = check.prepare("SELECT ref, body FROM sessions").all() as { ref: string; body: Uint8Array }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ref, ref);
  assert.deepEqual([...rows[0]!.body], [...bytes]);
  check.close();
  s.close();
});

test("checkpoints: a missing version reads as 1, a future version throws", async () => {
  const dir = tmpDir("store-cpv-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const base = {
    agent: "a",
    host: "h1",
    generation: 0,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h1",
    ingested: null,
    wait: null,
    remainingBudgetMicros: 5,
    imageDigest: "sha256:x",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  const cp = await s.checkpoints.write(base, "k1");
  assert.equal(cp.version, CHECKPOINT_FORMAT);
  const raw = new DatabaseSync(file);
  const body = JSON.parse((raw.prepare("SELECT body FROM checkpoints WHERE id=?").get(cp.id) as { body: string }).body) as Record<string, unknown>;
  assert.equal(body.version, CHECKPOINT_FORMAT); // the version lives in the JSON body
  const put = (v: unknown) => raw.prepare("UPDATE checkpoints SET body=? WHERE id=?").run(JSON.stringify(v), cp.id);
  const { version: _v, ...legacy } = body;
  put(legacy);
  await assert.rejects(() => s.checkpoints.read(cp.id), UnsupportedCheckpointVersion); // a versionless body is refused
  await assert.rejects(() => s.checkpoints.latest("a"), UnsupportedCheckpointVersion);
  put(body);
  assert.equal((await s.checkpoints.read(cp.id))?.version, CHECKPOINT_FORMAT); // negative control: the stamped body reads
  put({ ...body, version: CHECKPOINT_FORMAT + 1 });
  await assert.rejects(() => s.checkpoints.read(cp.id), UnsupportedCheckpointVersion);
  await assert.rejects(() => s.checkpoints.latest("a"), UnsupportedCheckpointVersion);
  raw.close();
  s.close();
});

test("registry.create stores spec and defaults exitCause to absent", async () => {
  const s = openStore();
  const a = await s.registry.create({
    ...newAgent("k"),
    id: "c",
    parent: "root",
    spec: { image: "i", envManifestHash: "h", extensions: ["x"], systemPrompt: "p", egress: { kind: "none" } },
  });
  assert.deepEqual(a.spec, { image: "i", envManifestHash: "h", extensions: ["x"], systemPrompt: "p", egress: { kind: "none" } });
  assert.equal(a.exitCause, undefined);
});

test("registry.transition keeps exitCause when an exited agent is reaped", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  await s.registry.transition(a.id, 0, "running", { idempotencyKey: "t1" });
  await s.registry.transition(a.id, 0, "exited", { exit: "failed", exitCause: "oom_killed", idempotencyKey: "t2" });
  const reaped = await s.registry.transition(a.id, 0, "reaped", { idempotencyKey: "t3" });
  assert.equal(reaped.exitCause, "oom_killed");
  assert.equal((await s.registry.get(a.id))?.exitCause, "oom_killed");
});

test("registry.transition persists exitCause and bump clears it", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  await s.registry.transition(a.id, 0, "running", { idempotencyKey: "t1" });
  const done = await s.registry.transition(a.id, 0, "exited", { exit: "failed", exitCause: "oom_killed", idempotencyKey: "t2" });
  assert.equal(done.exitCause, "oom_killed");
  assert.equal((await s.registry.get(a.id))?.exitCause, "oom_killed"); // round-trips through get
  const b = await s.registry.create(newAgent("k2"));
  await s.registry.transition(b.id, 0, "running", { idempotencyKey: "u1" });
  await s.registry.transition(b.id, 0, "exited", { exit: "failed", exitCause: "host_stopped", idempotencyKey: "u2" });
  assert.equal((await s.registry.get(b.id))?.exitCause, "host_stopped");
  await s.registry.bumpGeneration(b.id, "h2", "b1"); // a later bump clears it
  assert.equal((await s.registry.get(b.id))?.exitCause, undefined);

  const c = await s.registry.create({ ...newAgent("k3"), id: "c", parent: "p1" });
  await s.registry.transition(c.id, 0, "running", { idempotencyKey: "v1" });
  await s.registry.transition(c.id, 0, "exited", { exit: "failed", exitCause: "sandbox_unavailable", idempotencyKey: "v2" });
  assert.equal((await s.registry.get(c.id))?.exitCause, "sandbox_unavailable");

  for (const cause of ["restart_exhausted", "quarantined"] as const) {
    const d = await s.registry.create({ ...newAgent(`k-${cause}`), id: `d-${cause}`, parent: "p1" });
    await s.registry.transition(d.id, 0, "running", { idempotencyKey: `${cause}-1` });
    await s.registry.transition(d.id, 0, "exited", { exit: "failed", exitCause: cause, idempotencyKey: `${cause}-2` });
    assert.equal((await s.registry.get(d.id))?.exitCause, cause);
  }
});

test("registry.list filters by parent", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("k1"), id: "a", parent: null });
  await s.registry.create({ ...newAgent("k2"), id: "b", parent: "a" });
  await s.registry.create({ ...newAgent("k3"), id: "c", parent: "b" });
  assert.deepEqual(
    (await s.registry.list({ parent: "a" })).map((x) => x.id),
    ["b"],
  );
  assert.deepEqual(
    (await s.registry.list({ parent: "b" })).map((x) => x.id),
    ["c"],
  );
  assert.equal((await s.registry.list({})).length, 3);
});

test("checkpoint.write stores envManifestHash", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const c = await s.checkpoints.write(
    {
      agent: "a",
      host: "h1",
      generation: 0,
      sessionRef: "s",
      workspace: "ws-a",
      node: "h1",
      ingested: { ref: "refs/agents/a/heads/agent/a", commit: "c1" },
      wait: null,
      remainingBudgetMicros: 5,
      imageDigest: "sha256:x",
      envManifestHash: "mh-1",
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    },
    "k1",
  );
  assert.equal(c.envManifestHash, "mh-1");
  assert.equal((await s.checkpoints.read(c.id))?.envManifestHash, "mh-1");
});

test("pruneIdempotency removes only entries older than the cutoff, never the identity-bearing scopes", async () => {
  const dir = tmpDir("store-prune-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  const a = await s.registry.create(newAgent("spawn-a"));
  await s.registry.raiseBudget(a.id, 5, "raise-a");
  await s.mailbox.receive(a.id, "k1");
  await s.mailbox.receive(a.id, "k2");
  await s.mailbox.receive(a.id, "k3");
  // Backdate everything but k3 so only those rows fall below the cutoff.
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE idempotency SET created_at = ? WHERE key <> 'k3'").run(Date.now() - 100_000);
  raw.close();
  assert.equal(s.pruneIdempotency(50_000), 2, "only the two old mailbox.receive rows go");
  // registry.create and registry.raiseBudget rows are kept (IDEMPOTENCY_KEPT_SCOPES): a replay past the window still replays.
  assert.equal((await s.registry.create(newAgent("spawn-a"))).id, a.id);
  assert.equal((await s.registry.raiseBudget(a.id, 5, "raise-a")).budgetMicros, a.budgetMicros + 5);
  // Pruned keys insert fresh rows again rather than replaying.
  await s.mailbox.receive(a.id, "k1");
  const check = new DatabaseSync(file);
  assert.equal((check.prepare("SELECT COUNT(*) AS n FROM idempotency").get() as { n: number }).n, 4);
  check.close();
  s.close();
});

test("mailbox.receive is idempotent: a repeated key returns the same signals and consumes none", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("x"), id: "x" });
  await s.mailbox.send("x", { kind: "cancel", graceMs: 1 }, "m1");
  await s.mailbox.send("x", { kind: "timeout" }, "m2");
  const first = await s.mailbox.receive("x", "r1");
  assert.deepEqual(first, [
    { kind: "cancel", graceMs: 1, id: "m1" },
    { kind: "timeout", id: "m2" },
  ]);
  assert.deepEqual(await s.mailbox.peek("x"), []); // consumed
  await s.mailbox.send("x", { kind: "pause", reason: "later" }, "m3");
  const replay = await s.mailbox.receive("x", "r1");
  assert.deepEqual(replay, first); // the previously-consumed signals, not the new one
  assert.deepEqual(await s.mailbox.peek("x"), [{ kind: "pause", reason: "later", id: "m3" }]); // repeat consumed nothing new
  assert.deepEqual(await s.mailbox.receive("x", "r2"), [{ kind: "pause", reason: "later", id: "m3" }]);
  assert.deepEqual(await s.mailbox.peek("x"), []);
});

test("registry.setSandbox is idempotent: a repeated key is a no-op replay", async () => {
  const s = openStore();
  const a = await s.registry.create(newAgent("k"));
  const first = await s.registry.setSandbox(a.id, 0, "sb1", "s1");
  assert.equal(first.sandbox, "sb1");
  // a different value under the same key is ignored: the stored record is replayed
  assert.deepEqual(await s.registry.setSandbox(a.id, 0, "sb2", "s1"), first);
  assert.equal((await s.registry.get(a.id))?.sandbox, "sb1");
  // even after the generation moves, the replay returns the original without re-applying or fencing
  await s.registry.bumpGeneration(a.id, "h2", "b");
  assert.deepEqual(await s.registry.setSandbox(a.id, 0, "sb3", "s1"), first);
  assert.equal((await s.registry.get(a.id))?.sandbox, "sb1");
});

test("checkpoints round-trip host through write/latest/read", async () => {
  const s = openStore();
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const base = {
    agent: "a",
    host: "h7",
    generation: 0,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h1",
    ingested: { ref: "refs/agents/a/heads/agent/a", commit: "c1" },
    wait: null,
    remainingBudgetMicros: 5,
    imageDigest: "sha256:x",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  const c1 = await s.checkpoints.write(base, "k1");
  assert.equal(c1.host, "h7");
  assert.equal((await s.checkpoints.latest("a"))?.host, "h7");
  assert.equal((await s.checkpoints.read(c1.id))?.host, "h7");
  const c2 = await s.checkpoints.write({ ...base, host: "h8", ingested: null }, "k2");
  assert.equal((await s.checkpoints.latest("a"))?.host, "h8");
  assert.equal((await s.checkpoints.read(c1.id))?.host, "h7");
  assert.equal((await s.checkpoints.read(c2.id))?.host, "h8");
});

test("watchdogs: restarts and quarantined persist; quarantined rung round-trips", async () => {
  const s = openStore();
  const st = wd("quarantined", { lastActionAt: 5, retries: 2, restarts: [10, 20], quarantined: true });
  assert.deepEqual(await s.watchdogs.set("a", st, "k1"), st);
  assert.deepEqual(await s.watchdogs.get("a"), st);
  const plain = await s.watchdogs.set("a", wd("none"), "k2"); // update clears them
  assert.deepEqual(plain, wd("none"));
});

test("schedules: setPaused pauses without removing; upsert preserves paused", async () => {
  const s = openStore();
  const base = { id: "s1", cron: "* * * * *", task: "t", missed: "skip" as const, overlap: "skip" as const, jitterMs: 0 };
  await s.schedules.upsert(base, "u1");
  assert.equal(await s.schedules.setPaused("nope", true, "p0"), null);
  assert.equal((await s.schedules.setPaused("s1", true, "p1"))?.paused, true);
  assert.equal((await s.schedules.upsert({ ...base, task: "t2" }, "u2")).paused, true); // preserved
  assert.equal((await s.schedules.get("s1"))?.task, "t2");
  assert.equal((await s.schedules.setPaused("s1", false, "p2"))?.paused, undefined);
  assert.equal((await s.schedules.get("s1"))?.paused, undefined);
});

test("approvals: an owner requester is denied at create (fail closed); decide/timeout replay it", async () => {
  const s = openStore();
  const a = await s.approvals.create(newAp("ap-o", { id: "o", rank: "owner" }), "k1");
  assert.equal(a.state, "denied");
  assert.deepEqual(a.rungs, []);
  assert.ok(a.decidedAt !== null);
  assert.equal((await s.approvals.timeout("ap-o", "t1")).state, "denied");
});

test("approvals: a pending record with no rung left is denied by decide/timeout", async () => {
  const dir = tmpDir("store-ap-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  await s.approvals.create(newAp("ap-x", { id: "o", rank: "operator" }), "k1");
  s.close();
  const raw = new DatabaseSync(file);
  raw.exec("UPDATE approvals SET rungs='[]'"); // a pre-existing row that is pending with an empty ladder
  raw.close();
  const s2 = openStore(file);
  assert.equal((await s2.approvals.timeout("ap-x", "t1")).state, "denied");
  s2.close();
});

test("approvals: decide and timeout idempotency keys are scoped separately", async () => {
  const s = openStore();
  await s.approvals.create(newAp("ap-s", { id: "o", rank: "agent" }), "k1");
  const d = await s.approvals.decide("ap-s", { who: "p", rank: "parent-agent", decision: "abstain", why: "w" }, "same");
  assert.equal(d.rungIndex, 1);
  const t = await s.approvals.timeout("ap-s", "same"); // reused key: a distinct op, applied
  assert.equal(t.rungIndex, 2);
});

test("approvals: deadlineAt is re-based on each rung advance", async () => {
  const s = openStore();
  const now = Date.now();
  const a = await s.approvals.create({ ...newAp("ap-d", { id: "o", rank: "agent" }), deadlineAt: now + 60_000 }, "k1");
  assert.ok(a.rungMs! > 59_000 && a.rungMs! <= 60_000);
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  const b = await s.approvals.timeout("ap-d", "t1");
  assert.equal(b.rungIndex, 1);
  assert.ok(b.deadlineAt >= t0 + b.rungMs!, "deadline measured from the advance");
  assert.ok(b.deadlineAt > a.deadlineAt);
});

test("journal.subscribe wakes on a write from another connection", async () => {
  const dir = tmpDir("store-sub-");
  const file = join(dir, "s.sqlite");
  const reader = openStore(file, { subscribePollMs: 20 });
  const writer = openStore(file);
  await writer.registry.create({ ...newAgent("a"), id: "a" });
  const sub = reader.journal.subscribe({});
  const it = sub[Symbol.asyncIterator]();
  const next = it.next();
  await new Promise((r) => setTimeout(r, 50));
  await writer.journal.append(entry("a", 0, "j1"));
  const got = await Promise.race([next, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("subscriber stalled")), 2000))]);
  assert.equal(got.value.agent, "a");
  sub.close();
  reader.close();
  writer.close();
});

test("schedules: durable breaker state survives reopen; setPaused(false) clears it; idempotent", async () => {
  const dir = tmpDir("store-brk-");
  const file = join(dir, "s.sqlite");
  let s = openStore(file);
  const base = { id: "s1", cron: "* * * * *", task: "t", missed: "skip" as const, overlap: "skip" as const, jitterMs: 0 };
  await s.schedules.upsert(base, "u1");
  assert.equal(await s.schedules.recordFailure("nope", 5, "f0"), null);
  assert.equal((await s.schedules.recordFailure("s1", 100, "f1"))?.failures, 1);
  assert.equal((await s.schedules.recordFailure("s1", 100, "f1"))?.failures, 1); // idempotent
  assert.equal((await s.schedules.recordFailure("s1", 200, "f2"))?.retryAt, 200);
  s.close();
  s = openStore(file);
  const g = await s.schedules.get("s1");
  assert.equal(g?.failures, 2);
  assert.equal(g?.retryAt, 200);
  await s.schedules.setPaused("s1", true, "p1");
  assert.equal((await s.schedules.get("s1"))?.failures, 2);
  const r = await s.schedules.setPaused("s1", false, "p2");
  assert.equal(r?.failures, undefined);
  assert.equal(r?.retryAt, undefined);
  await s.schedules.recordFailure("s1", 9, "f3");
  await s.schedules.clearFailures("s1", "c1");
  assert.equal((await s.schedules.get("s1"))?.failures, undefined);
  s.close();
});

test("16 concurrent first-opens across several fresh stores never fail with 'database is locked'", async () => {
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  for (let round = 0; round < 3; round++) {
    const dir = tmpDir("store-race-");
    const file = join(dir, "s.sqlite");
    const open = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const c = spawn(
          process.execPath,
          ["--input-type=module", "-e", `import { openStore } from ${JSON.stringify(storeUrl)}; openStore(process.argv[1]).close();`, file],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let err = "";
        c.stderr.on("data", (d: Buffer) => {
          err += d.toString();
        });
        c.on("error", reject);
        c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${err}`))));
      });
    await Promise.all(Array.from({ length: 16 }, open));
  }
});

// Deterministically reproduces the first-open race: the child's existsSync() sees no file, then, just before the exclusive
// create, a rival process creates the file (a real SQLite DB with a marker table). The hook wraps fs.openSync so the
// interleaving is forced rather than timing-dependent; the real openSync then fails with EEXIST as it would in production.
const firstOpenInterleaving = async (mode: "winner" | "eacces" | "symlink" | "directory"): Promise<{ out: string; kind: string; target: string | null }> => {
  const storeUrl = new URL("./store.ts", import.meta.url).href;
  const dir = tmpDir("store-toctou-");
  const file = join(dir, "s.sqlite");
  // A sentinel next to the path: a symlink winner points here, so it must come out untouched.
  writeFileSync(`${file}.target`, "sentinel");
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    import { openStore } from ${JSON.stringify(storeUrl)};
    const [file, mode] = process.argv.slice(1);
    const real = fs.openSync;
    fs.openSync = (p, flags, m) => {
      if (p === file && flags === "wx") {
        if (mode === "eacces") {
          const e = new Error("EACCES: permission denied, open '" + p + "'");
          e.code = "EACCES";
          throw e;
        }
        if (mode === "symlink") {
          fs.symlinkSync(file + ".target", file);
          return real(p, flags, m);
        }
        if (mode === "directory") {
          fs.mkdirSync(file);
          return real(p, flags, m);
        }
        const w = new DatabaseSync(file);
        w.exec("CREATE TABLE winner (x INTEGER); INSERT INTO winner VALUES (42); PRAGMA application_id = ${STORE_APPLICATION_ID}");
        w.close();
      }
      return real(p, flags, m);
    };
    syncBuiltinESMExports();
    try {
      openStore(file).close();
      console.log("OK");
    } catch (e) {
      console.log("ERR " + e.code);
    }
    if (mode === "winner") {
      const check = new DatabaseSync(file);
      console.log("ROWS " + check.prepare("SELECT x FROM winner").get().x);
      check.close();
    }`;
  return await new Promise<{ out: string; kind: string; target: string | null }>((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script, file, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    c.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    c.on("error", reject);
    c.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
      // Inspect what the path and the sentinel look like after the child exits, before the fixture is removed.
      const st = lstatSync(file, { throwIfNoEntry: false });
      const kind = !st ? "absent" : st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "file";
      const t = `${file}.target`;
      const target = lstatSync(t, { throwIfNoEntry: false }) ? readFileSync(t, "utf8") : null;
      resolve({ out, kind, target });
    });
  });
};

test("first open loses the exclusive create to a concurrent creator: EEXIST is benign and the winner's DB is kept", async () => {
  const r = await firstOpenInterleaving("winner");
  assert.equal(r.out, "OK\nROWS 42\n");
  assert.equal(r.kind, "file");
});

test("first open: a non-EEXIST error from the exclusive create still propagates", async () => {
  const r = await firstOpenInterleaving("eacces");
  assert.equal(r.out, "ERR EACCES\n");
});

test("first open: a winner that leaves a symlink at the path is refused with EEXIST and the link target is untouched", async () => {
  const r = await firstOpenInterleaving("symlink");
  assert.equal(r.out, "ERR EEXIST\n");
  assert.equal(r.kind, "symlink");
  assert.equal(r.target, "sentinel");
});

test("first open: a winner that leaves a directory at the path is refused with EEXIST and nothing inside is touched", async () => {
  const r = await firstOpenInterleaving("directory");
  assert.equal(r.out, "ERR EEXIST\n");
  assert.equal(r.kind, "directory");
  assert.equal(r.target, "sentinel");
});

test("checkpoints: the folder fields round-trip", async () => {
  const dir = tmpDir("store-cp-");
  const file = join(dir, "s.sqlite");
  const s = openStore(file);
  await s.registry.create({ ...newAgent("a"), id: "a" });
  const c = await s.checkpoints.write(
    {
      agent: "a",
      host: "h1",
      generation: 0,
      sessionRef: "s",
      workspace: "ws-a",
      node: "h1",
      ingested: null,
      wait: null,
      remainingBudgetMicros: 5,
      imageDigest: "d",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    },
    "k1",
  );
  const back = await s.checkpoints.read(c.id);
  assert.equal(back?.workspace, "ws-a");
  assert.equal(back?.node, "h1");
  assert.equal(back?.ingested, null);
  assert.equal("commit" in (back ?? {}), false);
  s.close();
});
