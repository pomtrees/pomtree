import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IllegalTransitionError, SandboxUnavailableError, StaleGenerationError } from "@pomtree/core";
import { SandboxStartError } from "@pomtree/core";
import type { SpawnSpec, NewApproval, NewEscalation, NewReport, Schedule, Template, WatchdogState } from "@pomtree/core";
import {
  journalRetentionContractBody,
  type JournalContractWorld,
  approvalContractBody,
  contract,
  createFakes,
  escalationContractBody,
  FakeExtensionGateway,
  FakeQuotaCounters,
  FakeWorkspace,
  fakeBundle,
  workspaceContractBody,
  sandboxContractBody,
  scheduleContractBody,
  hostStoreContractBody,
  checkpointFenceContractBody,
  mailboxContractBody,
  mountProviderContractBody,
  raiseBudgetContractBody,
  registryListContractBody,
} from "./index.ts";
import type {
  CheckpointFenceContractWorld,
  HostStoreContractWorld,
  MailboxContractWorld,
  MountProviderContractWorld,
  RaiseBudgetContractWorld,
  RegistryListContractWorld,
  ApprovalContractWorld,
  EscalationContractWorld,
  SandboxContractWorld,
  ScheduleContractWorld,
} from "./index.ts";

const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };

const entry = (key: string, generation = 1) => ({
  idempotencyKey: key,
  agent: "a",
  host: "h",
  generation,
  payload: { kind: "spawned" as const },
});

test("journal: idempotent append, stale generation rejected, calls logged", async () => {
  const f = createFakes();
  const n = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" };
  await f.registry.create({ ...n, id: "a" });
  await f.registry.bumpGeneration("a", "h", "b1");
  await f.registry.bumpGeneration("a", "h", "b2");
  const e1 = await f.journal.append(entry("k1", 2));
  assert.equal((await f.journal.append(entry("k1", 2))).seq, e1.seq);
  assert.equal((await f.journal.read({})).length, 1);
  await assert.rejects(f.journal.append(entry("k2", 1)), StaleGenerationError);
  assert.deepEqual(
    f.calls.map((c) => `${c.port}.${c.method}`),
    ["Registry.create", "Registry.bumpGeneration", "Registry.bumpGeneration", "Journal.append", "Journal.append", "Journal.read", "Journal.append"],
  );
});

test("journal: subscribe replays then tails", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.journal.append(entry("k1", 0));
  const sub = f.journal.subscribe({ from: 1 });
  const it = sub[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.seq, 1);
  await f.journal.append(entry("k2", 0));
  assert.equal((await it.next()).value.seq, 2);
  sub.close();
  assert.equal((await it.next()).done, true);
});

test("registry: idempotent create, CAS transition, bump", async () => {
  const f = createFakes();
  const n = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" };
  const a = await f.registry.create(n);
  assert.equal((await f.registry.create(n)).id, a.id);
  await f.registry.transition(a.id, 0, "running", { idempotencyKey: "t1" });
  await f.registry.bumpGeneration(a.id, "h2", "b1");
  await assert.rejects(f.registry.transition(a.id, 0, "yielded", { idempotencyKey: "t2" }), StaleGenerationError);
  const r = await f.registry.transition(a.id, 1, "exited", { exit: "succeeded", result: { ok: 1 }, idempotencyKey: "t3" });
  assert.equal(r.exit, "succeeded");
  assert.equal((await f.registry.list({ state: "exited" })).length, 1);
});

test("registry: caller-chosen id, illegal transitions rejected after generation check", async () => {
  const f = createFakes();
  const a = await f.registry.create({ id: "root", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "r" });
  assert.equal(a.id, "root");
  assert.equal(a.state, "pending");
  await assert.rejects(f.registry.transition("root", 0, "exited", { idempotencyKey: "r1" }), IllegalTransitionError);
  await assert.rejects(f.registry.transition("root", 9, "exited", { idempotencyKey: "r2" }), StaleGenerationError);
  await f.registry.transition("root", 0, "running", { idempotencyKey: "r3" });
  assert.equal(a.state, "pending"); // returned records are copies
  await f.registry.transition("root", 0, "exited", { exit: "succeeded", idempotencyKey: "r4" });
  await assert.rejects(f.registry.transition("root", 0, "running", { idempotencyKey: "r5" }), IllegalTransitionError);
  await f.registry.transition("root", 0, "reaped", { idempotencyKey: "r6" });
});

test("registry: transition persists exitCause and bump clears it", async () => {
  const f = createFakes();
  const n = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" };
  const a = await f.registry.create({ ...n, id: "a" });
  await f.registry.transition("a", 0, "running", { idempotencyKey: "t1" });
  const done = await f.registry.transition("a", 0, "exited", { exit: "failed", exitCause: "oom_killed", idempotencyKey: "t2" });
  assert.equal(done.exitCause, "oom_killed");
  assert.equal((await f.registry.get("a"))?.exitCause, "oom_killed"); // round-trips through get
  // reaping keeps it
  await f.registry.transition("a", 0, "reaped", { idempotencyKey: "t3" });
  assert.equal((await f.registry.get("a"))?.exitCause, "oom_killed");

  const b = await f.registry.create({ ...n, id: "b", idempotencyKey: "y" });
  await f.registry.transition("b", 0, "running", { idempotencyKey: "u1" });
  await f.registry.transition("b", 0, "exited", { exit: "failed", exitCause: "host_stopped", idempotencyKey: "u2" });
  await f.registry.bumpGeneration("b", "h2", "b1"); // a later bump clears it
  assert.equal((await f.registry.get("b"))?.exitCause, undefined);

  const c = await f.registry.create({ ...n, id: "c", parent: "p1", idempotencyKey: "z" });
  await f.registry.transition("c", 0, "running", { idempotencyKey: "v1" });
  await f.registry.transition("c", 0, "exited", { exit: "failed", exitCause: "sandbox_unavailable", idempotencyKey: "v2" });
});

test("mailbox: receive consumes, peek doesn't, send idempotent", async () => {
  const f = createFakes();
  await mk(f, "a");
  const s = { kind: "cancel" as const, graceMs: 1 };
  await f.mailbox.send("a", s, "k");
  await f.mailbox.send("a", s, "k");
  assert.equal((await f.mailbox.peek("a")).length, 1);
  assert.equal((await f.mailbox.peek("a")).length, 1);
  assert.equal((await f.mailbox.receive("a", "r1")).length, 1);
  assert.equal((await f.mailbox.receive("a", "r2")).length, 0);
});

test("mailbox: receive is idempotent per key and replays consume nothing new", async () => {
  const f = createFakes();
  await mk(f, "a");
  await f.mailbox.send("a", { kind: "cancel", graceMs: 1 }, "s1");
  await f.mailbox.send("a", { kind: "timeout" }, "s2");
  const got = await f.mailbox.receive("a", "r1");
  assert.equal(got.length, 2);
  assert.equal((await f.mailbox.peek("a")).length, 0); // consumed
  assert.deepEqual(await f.mailbox.receive("a", "r1"), got); // replay: same signals, nothing new consumed
  assert.equal((await f.mailbox.peek("a")).length, 0);
  assert.equal((await f.mailbox.receive("a", "r2")).length, 0); // fresh key on empty box
});

test("checkpoints: idempotent write, latest", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  const c = {
    agent: "a",
    host: "h",
    generation: 0,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h",
    ingested: null,
    wait: null,
    remainingBudgetMicros: 1,
    imageDigest: "d",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  const w = await f.checkpoints.write(c, "k");
  assert.equal((await f.checkpoints.write(c, "k")).id, w.id);
  await f.registry.bumpGeneration("a", "h", "b");
  await f.checkpoints.write({ ...c, generation: 1, ingested: { ref: "refs/agents/a/heads/x", commit: "c2" } }, "k2");
  assert.equal((await f.checkpoints.latest("a"))?.generation, 1);
});

test("sandbox + harness scripted", async () => {
  const f = createFakes({ sandboxExitCodes: [3], harnessEvents: { a: [{ kind: "error", message: "x" }] } });
  const h = await f.sandbox.start({ agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-a", containerPath: "/w" }] }, "sb1");
  assert.deepEqual(await f.sandbox.list(), [{ id: h.id, agent: "a" }]);
  assert.deepEqual(await h.wait(), { exitCode: 3 });
  const h2 = await f.sandbox.start(
    { agent: "b", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-a", containerPath: "/w" }] },
    "sb2",
  );
  f.hooks.exitSandbox(h2.id, 5);
  assert.deepEqual(await h2.wait(), { exitCode: 5 });
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: false, exitCode: 3, status: "exited" });
  const s = await f.harness.start({ agent: "a", sandbox: h, prompt: "p" });
  const got = [];
  for await (const e of s.events()) got.push(e);
  assert.equal(got.length, 1);
});

const MODEL_SPEC = { image: "i", envManifestHash: null, extensions: [], provider: "p", model: "m", systemPrompt: null, egress: { kind: "registry" as const } };

test("gateway + placement + workspace", async () => {
  const f = createFakes({ placement: () => ({ queued: true, reason: "full" }) });
  // The fake gateway issues only for a registered container agent with a resolved model, as the real one does.
  await f.registry.create({ id: "a", parent: null, name: "a", task: "t", host: "h", budgetMicros: 100, idempotencyKey: "a", spec: MODEL_SPEC });
  await f.gateway.issueKey("a", 100);
  f.hooks.addSpend("a", 30);
  assert.equal((await f.gateway.revoke("a")).unusedMicros, 70);
  assert.deepEqual(await f.placement.admit({ agent: "a", priority: 1 }), { queued: true, reason: "full" });
  await f.workspace.create("a", {});
  assert.deepEqual(await f.workspace.list(), ["a"]);
  assert.equal(
    f.calls.some((c) => c.method === "exitSandbox" || c.method === "addSpend"),
    false,
  );
});

test("placement status: snapshots running/queue and is scriptable", async () => {
  const f = createFakes({
    placement: (req) => (req.agent === "a" ? { host: "h2" } : { queued: true }),
    placementMaxConcurrent: 2,
  });
  await f.placement.admit({ agent: "a", priority: 1 });
  await f.placement.admit({ agent: "b", priority: 9 });
  await f.placement.admit({ agent: "c", priority: 3 });
  assert.deepEqual(await f.placement.status(), [
    {
      host: "host-1",
      maxConcurrent: 2,
      running: ["a"],
      queue: [
        { agent: "b", priority: 9 },
        { agent: "c", priority: 3 },
      ],
    },
  ]);

  const g = createFakes({ placementStatus: () => ({ host: "s", maxConcurrent: 1, running: ["z"], queue: [] }) });
  assert.deepEqual(await g.placement.status(), [{ host: "s", maxConcurrent: 1, running: ["z"], queue: [] }]);
});

test("journal: generation checked against registry; unregistered agents are rejected", async () => {
  const f = createFakes();
  await assert.rejects(f.journal.append(entry("u1", 0)), /unknown agent a/);
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await assert.rejects(f.journal.append(entry("k1", 5)), StaleGenerationError);
  await f.journal.append(entry("k2", 0));
});

test("replays and reads return copies; limit 0 returns none; falsy results are written", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.registry.bumpGeneration("a", "h", "b"); // gen 1
  const e = await f.journal.append(entry("k1"));
  e.host = "mutated";
  (await f.journal.append(entry("k1"))).host = "mutated2";
  assert.equal((await f.journal.read({}))[0]!.host, "h");
  assert.deepEqual(await f.journal.read({ limit: 0 }), []);
  const c = {
    agent: "a",
    host: "h",
    generation: 1,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h",
    ingested: null,
    wait: null,
    remainingBudgetMicros: 1,
    imageDigest: "d",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  const w = await f.checkpoints.write(c, "k");
  w.node = "mutated";
  assert.equal((await f.checkpoints.write(c, "k")).node, "h");
  await f.registry.create({ id: "r", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "r" });
  await f.registry.transition("r", 0, "running", { idempotencyKey: "q1" });
  await f.registry.transition("r", 0, "exited", { exit: "succeeded", result: 0, idempotencyKey: "q2" });
  assert.equal((await f.registry.get("r"))!.result, 0);
});

test("sandbox: list keeps exited sandboxes (docker ps -a), inspect still works", async () => {
  const f = createFakes();
  const spec = { agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-a", containerPath: "/w" }] };
  const h = await f.sandbox.start(spec, "sb1");
  f.hooks.exitSandbox(h.id, 1);
  assert.deepEqual(await f.sandbox.list(), [{ id: h.id, agent: "a" }]);
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: false, exitCode: 1, status: "exited" });
});

test("workspace: ids validated, existing create can't be reset", async () => {
  const f = createFakes();
  for (const bad of ["", "a/b", "a\\b", "a\0b", "..", "a..b", "-x", ".x"]) {
    await assert.rejects(f.workspace.create(bad, {}), /invalid agent id/);
  }
  await f.workspace.create("a", { fromCommit: "abc" });
  assert.equal((await f.workspace.create("a", {})).commit, "abc");
  assert.equal((await f.workspace.create("a", { fromCommit: "abc" })).commit, "abc");
  await assert.rejects(f.workspace.create("a", { fromCommit: "def" }), /already exists/);
});

const mk = (f: ReturnType<typeof createFakes>, id: string) =>
  f.registry.create({ id, parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: `c-${id}` });

test("registry: transition and bumpGeneration are idempotent per key, keys scoped per operation", async () => {
  const f = createFakes();
  await mk(f, "a");
  const t1 = await f.registry.transition("a", 0, "running", { idempotencyKey: "k" });
  const t2 = await f.registry.transition("a", 0, "running", { idempotencyKey: "k" }); // would be illegal if re-applied
  assert.deepEqual(t2, t1);
  t2.state = "exited";
  assert.equal((await f.registry.get("a"))!.state, "running");
  const b1 = await f.registry.bumpGeneration("a", "h2", "k"); // same key, different op: applied
  assert.equal(b1.generation, 1);
  assert.deepEqual(await f.registry.bumpGeneration("a", "h3", "k"), b1);
  assert.equal((await f.registry.get("a"))!.generation, 1);
  assert.equal((await f.registry.get("a"))!.host, "h2");
});

test("registry: sandbox id defaults null, setSandbox is CAS on generation", async () => {
  const f = createFakes();
  const a = await mk(f, "a");
  assert.equal(a.sandbox, null);
  assert.equal((await f.registry.setSandbox("a", 0, "sbx-1", "k1")).sandbox, "sbx-1");
  assert.equal((await f.registry.setSandbox("a", 0, null, "k2")).sandbox, null);
  await f.registry.bumpGeneration("a", "h", "b");
  await assert.rejects(f.registry.setSandbox("a", 0, "sbx-2", "k3"), StaleGenerationError);
  assert.equal((await f.registry.get("a"))!.sandbox, null);
});

test("registry: setSandbox is idempotent per key and replays return the original snapshot", async () => {
  const f = createFakes();
  await mk(f, "a");
  const s1 = await f.registry.setSandbox("a", 0, "sbx-1", "k");
  assert.equal(s1.sandbox, "sbx-1");
  assert.deepEqual(await f.registry.setSandbox("a", 0, "sbx-1", "k"), s1);
  assert.equal((await f.registry.setSandbox("a", 0, null, "k2")).sandbox, null); // different key re-applies
  assert.equal((await f.registry.setSandbox("a", 0, null, "k")).sandbox, "sbx-1"); // replay returns original snapshot
  assert.equal((await f.registry.get("a"))!.sandbox, null);
});

test("mailbox: senderGeneration fences stale message senders only", async () => {
  const f = createFakes();
  await mk(f, "s");
  await mk(f, "t");
  await f.registry.bumpGeneration("s", "h", "b"); // sender now at generation 1
  const msg = { kind: "message" as const, from: "s", body: "hi" };
  await assert.rejects(f.mailbox.send("t", msg, "k1", 0), StaleGenerationError);
  assert.equal((await f.mailbox.peek("t")).length, 0);
  await f.mailbox.send("t", msg, "k2", 1);
  await f.mailbox.send("t", msg, "k3"); // daemon-originated style: no generation, unchecked
  await assert.rejects(f.mailbox.send("t", { kind: "message", from: "ghost", body: "x" }, "k4", 7), /unknown agent ghost/); // sender not in registry
  await f.mailbox.send("t", { kind: "cancel", graceMs: 1 }, "k5", 0); // non-message signals aren't fenced
  assert.equal((await f.mailbox.peek("t")).length, 3);
});

test("FakeWorkspace.evict drops the folder but keeps the ingested refs", async () => {
  const ws = new FakeWorkspace();
  await ws.create("k", {});
  const r = await ws.ingest(
    "k",
    (async function* () {
      yield fakeBundle([{ name: "agent/k", commit: "x1" }]);
    })(),
    { maxBytes: 1000 },
  );
  assert.equal(r.ok, true);
  await ws.evict("k");
  await ws.evict("k"); // idempotent
  assert.deepEqual(await ws.list(), []);
  assert.deepEqual(await ws.ingested("k"), { ref: "refs/agents/k/heads/agent/k", commit: "x1" });
});

test("FakeWorkspace.prune deletes only merged agents' refs", async () => {
  const ws = new FakeWorkspace();
  for (const id of ["root", "child", "unmerged"]) {
    await ws.create(id, {});
    await ws.ingest(
      id,
      (async function* () {
        yield fakeBundle([{ name: `agent/${id}`, commit: `c-${id}` }]);
      })(),
      { maxBytes: 1000 },
    );
  }
  ws.merged.add("child");
  assert.equal(await ws.prune("child", { mergedInto: "root" }), "pruned");
  assert.equal(await ws.ingested("child"), null);
  assert.equal(await ws.prune("unmerged", { mergedInto: "root" }), "refused");
  assert.notEqual(await ws.ingested("unmerged"), null);
  assert.equal(await ws.prune("ghost", { mergedInto: "root" }), "nothing");
  assert.equal(await ws.prune("child", { mergedInto: "root" }), "nothing"); // a replay after the prune
  assert.equal(await ws.prune("root", { mergedInto: "root" }), "refused");
});

test("FakeWorkspace scripts ingest failures and enforces the byte cap", async () => {
  const ws = new FakeWorkspace();
  await ws.create("a", {});
  ws.ingestResults.push({ ok: false, code: "symlink", message: "scripted" });
  const it = () =>
    (async function* () {
      yield new Uint8Array(10);
    })();
  assert.deepEqual(await ws.ingest("a", it(), { maxBytes: 100 }), { ok: false, code: "symlink", message: "scripted" });
  const big = await ws.ingest("a", it(), { maxBytes: 5 });
  assert.equal(big.ok === false && big.code, "too_large");
  assert.equal(await ws.ingested("a"), null);
});

test("FakeWorkspace passes the Workspace contract", async () => {
  let n = 0;
  const ws = new FakeWorkspace();
  ws.refs.set(ws.defaultRef, "m0");
  await workspaceContractBody({
    ws,
    remote: "fake-remote",
    bundle: async (_agent, name, o) => ({ bytes: fakeBundle([{ name, commit: `x${++n}`, ...(o?.onTop ? { parent: o.onTop } : {}) }]), commit: `x${n}` }),
    mainCommit: () => "m0",
    markMerged: (agent) => ws.merged.add(agent),
  });
});

test("checkpoints: write requires a registry row and rejects stale generations", async () => {
  const f = createFakes();
  const c = {
    agent: "a",
    host: "h",
    generation: 0,
    sessionRef: "s",
    workspace: "ws-a",
    node: "h",
    ingested: null,
    wait: null,
    remainingBudgetMicros: 1,
    imageDigest: "d",
    envManifestHash: null,
    template: "code",
    templateDigest: null,
    resumeLevel: "session" as const,
  };
  await assert.rejects(f.checkpoints.write(c, "k0"), /unknown agent a/);
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.registry.bumpGeneration("a", "h", "b"); // gen 1
  await assert.rejects(f.checkpoints.write(c, "k1"), StaleGenerationError);
  const ok = await f.checkpoints.write({ ...c, generation: 1 }, "k2");
  assert.equal((await f.checkpoints.latest("a"))?.id, ok.id);
});

const rep = (over: Partial<NewReport> = {}): NewReport => ({
  id: "r1",
  agent: "a",
  generation: 0,
  host: "h",
  name: "n",
  mediaType: "text/plain",
  sizeBytes: 1,
  sha256: "s",
  content: new TextEncoder().encode("x"),
  ...over,
});

test("reportStore: idempotent by id, blobs recorded, stale/unknown fenced", async () => {
  const f = createFakes();
  await assert.rejects(f.reportStore.write(rep(), "k0"), /unknown agent a/);
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.registry.bumpGeneration("a", "h", "b"); // gen 1
  await assert.rejects(f.reportStore.write(rep({ generation: 0 }), "k1"), StaleGenerationError);
  const r = await f.reportStore.write(rep({ generation: 1 }), "k2");
  const again = await f.reportStore.write(rep({ generation: 1, content: new TextEncoder().encode("y") }), "k3");
  assert.equal(again.createdAt, r.createdAt); // idempotent by id, not key
  assert.equal(new TextDecoder().decode(f.reportStore.blobs.get("r1")!), "x");
  assert.deepEqual(
    (await f.reportStore.list("a")).map((x) => x.id),
    ["r1"],
  );
  assert.equal((await f.reportStore.read("a", "r1"))!.report.id, "r1");
  assert.equal(await f.reportStore.read("a", "nope"), null);
  assert.equal(await f.reportStore.remove("a", "r1"), true);
  assert.equal(await f.reportStore.remove("a", "r1"), false);
  assert.ok(f.calls.some((c) => c.port === "ReportStore" && c.method === "write"));
});

test("schedules: fake mirrors upsert/replace/get/list/remove/cursor and logs calls", async () => {
  const f = createFakes();
  const base: Omit<Schedule, "createdAt"> = { id: "s1", cron: "0 0 * * *", task: "run", missed: "skip", overlap: "skip", jitterMs: 0 };
  const a = await f.schedules.upsert(base, "k1");
  assert.deepEqual(await f.schedules.upsert(base, "k1"), a);
  const replaced = await f.schedules.upsert({ ...base, cron: "1 2 3 4 5", tz: "UTC" }, "k2");
  assert.equal(replaced.createdAt, a.createdAt);
  assert.equal(replaced.cron, "1 2 3 4 5");
  assert.equal(replaced.tz, "UTC");
  assert.equal((await f.schedules.get("s1"))?.cron, "1 2 3 4 5");
  assert.deepEqual(
    (await f.schedules.list()).map((x) => x.id),
    ["s1"],
  );
  await f.schedules.setLastFired("s1", 42, "f1");
  await f.schedules.setLastFired("s1", 999, "f1"); // replay: ignored
  assert.equal(await f.schedules.lastFired("s1"), 42);
  assert.equal(await f.schedules.remove("s1"), true);
  assert.equal(await f.schedules.remove("s1"), false);
  assert.equal(await f.schedules.lastFired("s1"), null);
  // scriptable state is reachable through hooks.raw
  f.hooks.raw.schedules.all = [];
  f.hooks.raw.schedules.lastFiredAt.clear();
  assert.deepEqual(await f.schedules.list(), []);
  assert.ok(f.calls.some((c) => c.port === "ScheduleStore" && c.method === "upsert"));
});

test("watchdogs: scripted state is readable through hooks.raw and calls are logged (the port behavior is the contract body)", async () => {
  const f = createFakes();
  const st: WatchdogState = { rung: "nudged", lastActionAt: 10, retries: 0 };
  f.hooks.raw.watchdogs.state.set("b", st);
  assert.deepEqual(await f.watchdogs.get("b"), st);
  await f.watchdogs.set("a", st, "k1");
  assert.ok(f.calls.some((c) => c.port === "WatchdogStore" && c.method === "set"));
});

const esc = (over: Partial<NewEscalation> = {}): NewEscalation => ({
  id: "es-1",
  agent: "a",
  generation: 0,
  host: "h",
  question: "q",
  options: ["yes", "no"],
  ...over,
});

test("escalations: create is fenced on the registry (unknown agent, stale generation); scripted state and calls are logged", async () => {
  const f = createFakes();
  await assert.rejects(f.escalations.create(esc(), "k0"), /unknown agent a/);
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.registry.bumpGeneration("a", "h", "b"); // gen 1
  await assert.rejects(f.escalations.create(esc({ generation: 0 }), "k1"), StaleGenerationError);
  assert.equal((await f.escalations.create(esc({ generation: 1 }), "k2")).state, "open");
  // scriptable state is reachable through hooks.raw
  f.hooks.raw.escalations.all = [];
  assert.deepEqual(await f.escalations.list(), []);
  assert.ok(f.calls.some((c) => c.port === "EscalationStore" && c.method === "create"));
});

const newAp = (over: Partial<NewApproval> = {}): NewApproval => ({
  id: "ap-1",
  requester: { id: "a", rank: "agent", generation: 0 },
  action: { kind: "extension", target: "ext-1" },
  host: "h",
  deadlineAt: 1000,
  ...over,
});

test("approvals: create is fenced on the registry (unknown agent, stale generation); unknown ids; scripted state and calls are logged", async () => {
  const f = createFakes();
  await assert.rejects(f.approvals.create(newAp(), "k0"), /unknown agent a/);
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.registry.bumpGeneration("a", "h", "b"); // gen 1
  await assert.rejects(f.approvals.create(newAp({ requester: { id: "a", rank: "agent", generation: 0 } }), "k1"), StaleGenerationError);
  const ap = await f.approvals.create(newAp({ requester: { id: "a", rank: "agent", generation: 1 } }), "k2");
  assert.equal(ap.state, "pending");
  assert.equal(await f.approvals.get("nope"), null);
  await assert.rejects(f.approvals.decide("nope", { who: "owner", rank: "owner", decision: "approve", why: "y" }, "d3"), /unknown approval nope/);
  f.hooks.raw.approvals.all = [];
  assert.deepEqual(await f.approvals.list(), []);
  assert.ok(f.calls.some((c) => c.port === "ApprovalStore" && c.method === "create"));
});

test("approvals: fake timeout advances rungs and fails closed past the top", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.approvals.create(newAp({ id: "ap-2" }), "k1");
  const t1 = await f.approvals.timeout("ap-2", "t1");
  assert.equal(t1.state, "pending");
  assert.equal(t1.rungIndex, 1);
  assert.equal(t1.journal[0]!.decision, "timeout");
  assert.equal(t1.journal[0]!.who, null);
  const t2 = await f.approvals.timeout("ap-2", "t2");
  assert.equal(t2.state, "pending");
  assert.equal(t2.rungIndex, 2);
  const t3 = await f.approvals.timeout("ap-2", "t3");
  assert.equal(t3.state, "denied");
  assert.equal(t3.rungIndex, 3);
  assert.deepEqual(await f.approvals.timeout("ap-2", "t3"), t3); // replay
});

test("approvals: create replay returns the original pending snapshot after decide", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.approvals.create(newAp({ id: "ap-3" }), "k1");
  await f.approvals.decide("ap-3", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1");
  const replay = await f.approvals.create(newAp({ id: "ap-3" }), "k1");
  assert.equal(replay.state, "pending");
  assert.deepEqual(replay.journal, []);
  assert.equal((await f.approvals.get("ap-3"))!.state, "denied");
});

test("approvals: id replay with a new key returns the live (stored) record, defensively", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  await f.approvals.create(newAp({ id: "ap-4" }), "k1");
  await f.approvals.decide("ap-4", { who: "owner", rank: "owner", decision: "deny", why: "no" }, "d1");
  const replay = await f.approvals.create(newAp({ id: "ap-4" }), "k2"); // same id, new key
  assert.equal(replay.state, "denied");
  assert.equal(replay.journal.length, 1);
  replay.requester.id = "mutated";
  assert.equal((await f.approvals.get("ap-4"))!.requester.id, "a"); // defensive copy
});

test("sessions: scripted blobs are readable through hooks.raw and calls are logged (the port behavior is the contract body)", async () => {
  const f = createFakes();
  await f.sessions.put(new TextEncoder().encode("hello"));
  assert.equal(f.hooks.raw.sessions.blobs.size, 1);
  f.hooks.raw.sessions.blobs.set("pre", new Uint8Array([1]));
  assert.deepEqual([...(await f.sessions.get("pre"))!], [1]);
  assert.ok(f.calls.some((c) => c.port === "SessionStore" && c.method === "put"));
});

test("registry: list filters by parent", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: "root", name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "c-a" });
  await f.registry.create({ id: "b", parent: "a", name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "c-b" });
  assert.deepEqual(
    (await f.registry.list({ parent: "a" })).map((x) => x.id),
    ["b"],
  );
  assert.equal((await f.registry.list()).length, 2);
});

test("templates: scripted resolve/list and call-logged", async () => {
  const tpl: Template = { id: "t1", image: "img" };
  const f = createFakes({ templates: [tpl] });
  assert.deepEqual(await f.templates.resolve("t1"), tpl);
  assert.equal(await f.templates.resolve("nope"), null);
  assert.deepEqual(
    (await f.templates.list()).map((t) => t.id),
    ["t1"],
  );
  f.hooks.raw.templates.templates.set("t2", { id: "t2" });
  assert.deepEqual(
    (await f.templates.list()).map((t) => t.id),
    ["t1", "t2"],
  );
  assert.ok(f.calls.some((c) => c.port === "TemplateStore" && c.method === "resolve"));
});

test("sandbox: inspect reports running/exited status and scripted runtime statuses without changing the lifecycle", async () => {
  const f = createFakes();
  const h = await f.sandbox.start({ agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-a", containerPath: "/w" }] }, "sb1");
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: true, exitCode: null, status: "running" });
  for (const [status, running] of [
    ["created", false],
    ["paused", true],
    ["restarting", true],
    ["dead", false],
  ] as const) {
    f.sandbox.statuses.set(h.id, status);
    assert.deepEqual(await f.sandbox.inspect(h.id), { running, exitCode: null, status }, status);
  }
  f.sandbox.statuses.set(h.id, "frobbing");
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: true, exitCode: null, status: "frobbing" }, "unrecognized: running follows the lifecycle");
  f.sandbox.statuses.set(h.id, null);
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: true, exitCode: null }, "null omits status");
  f.sandbox.statuses.delete(h.id);
  await f.sandbox.attach(h.id, "a"); // a scripted status left the sandbox live (attach throws otherwise)
  f.sandbox.inspectErrors.set(h.id, new Error("engine timeout"));
  await assert.rejects(f.sandbox.inspect(h.id), /engine timeout/);
});

test("sandbox: wait/inspect surface oomKilled only when scripted", async () => {
  const f = createFakes();
  const h = await f.sandbox.start({ agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-a", containerPath: "/w" }] }, "sb1");
  f.hooks.exitSandbox(h.id, 137, true);
  assert.deepEqual(await h.wait(), { exitCode: 137, oomKilled: true });
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: false, exitCode: 137, oomKilled: true, status: "exited" });
});

test("registry: create replay returns the original snapshot, not the live record", async () => {
  const f = createFakes();
  const n = { parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" };
  const a = await f.registry.create(n);
  await f.registry.transition(a.id, 0, "running", { idempotencyKey: "t1" });
  const replay = await f.registry.create(n);
  assert.equal(replay.state, "pending"); // original snapshot, not "running"
  assert.equal((await f.registry.get(a.id))!.state, "running");
});

test("escalations: create replay returns the original open snapshot after answer", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  const e = await f.escalations.create(esc({ generation: 0 }), "k1");
  await f.escalations.answer(e.id, "yes", { channel: "discord", sender: "u" }, "a1");
  const replay = await f.escalations.create(esc({ generation: 0 }), "k1");
  assert.equal(replay.state, "open");
  assert.equal(replay.answer, null);
  assert.equal((await f.escalations.get(e.id))!.state, "answered");
});

test("schedules: upsert replaces and clears tz when omitted", async () => {
  const f = createFakes();
  const base: Omit<Schedule, "createdAt"> = { id: "s1", cron: "0 0 * * *", task: "run", missed: "skip", overlap: "skip", jitterMs: 0 };
  await f.schedules.upsert({ ...base, tz: "UTC" }, "k1");
  await f.schedules.upsert(base, "k2"); // no tz: real store replaces and drops the old tz
  const s = await f.schedules.get("s1");
  assert.ok(!("tz" in s!));
  assert.equal((await f.schedules.get("s1"))!.cron, "0 0 * * *");
});

test("sandbox: resolveImageDigest is deterministic, scriptable, and call-logged", async () => {
  const f = createFakes();
  assert.equal(await f.sandbox.resolveImageDigest("alpine:3"), "alpine:3@sha256:fake");
  f.hooks.raw.sandbox.imageDigests.set("alpine:3", "alpine@sha256:real");
  assert.equal(await f.sandbox.resolveImageDigest("alpine:3"), "alpine@sha256:real");
  assert.equal(await f.sandbox.resolveImageDigest("other"), "other@sha256:fake");
  assert.equal(f.calls.filter((c) => c.port === "Sandbox" && c.method === "resolveImageDigest").length, 3);
});

test("extension gateway: scripted results and call logging", async () => {
  const specs = [{ name: "web_fetch", description: "d", inputSchema: {}, streaming: false }];
  const gw = new FakeExtensionGateway(specs, [{ ok: true, result: "r1" }]);
  assert.deepEqual(
    (await gw.list()).map((s) => s.name),
    ["web_fetch"],
  );
  assert.deepEqual(await gw.call("a", "web_fetch", { url: "x" }, "k1"), { ok: true, result: "r1" });
  assert.deepEqual(gw.calls, [{ agent: "a", extension: "web_fetch", input: { url: "x" }, idempotencyKey: "k1" }]);
  // exhausted script falls back to a failing stub
  assert.equal((await gw.call("a", "web_fetch", {}, "k2")).ok, false);
});

test("extension gateway: createFakes wires the fake into the call log", async () => {
  const f = createFakes();
  await f.extensions.list();
  await f.extensions.call("a", "web_fetch", {}, "k");
  assert.ok(f.calls.some((c) => c.port === "ExtensionGateway" && c.method === "list"));
  assert.ok(f.calls.some((c) => c.port === "ExtensionGateway" && c.method === "call"));
  assert.equal(f.hooks.raw.extensions.calls.length, 1);
});

const sbSpec = (agent = "a") => ({ agent, image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-a", containerPath: "/w" }] });

test("escalations: id replay with a new key returns the live (stored) record, defensively", async () => {
  const f = createFakes();
  await f.registry.create({ id: "a", parent: null, name: "n", task: "t", host: "h", budgetMicros: 1, spec, idempotencyKey: "x" });
  const e = await f.escalations.create(esc({ generation: 0 }), "k1");
  await f.escalations.answer(e.id, "yes", { channel: "discord", sender: "u" }, "a1");
  const replay = await f.escalations.create(esc({ generation: 0 }), "k2"); // same id, new key
  assert.equal(replay.state, "answered"); // the live record, matching the real store
  assert.equal(replay.answer, "yes");
  replay.answer = "mutated";
  assert.equal((await f.escalations.get(e.id))!.answer, "yes"); // returns a defensive copy
});

test("sandbox: stop honors stopPolicy and graceMs (graceful 0, sigterm 143, sigkill 137)", async () => {
  const graceful = createFakes();
  const hg = await graceful.sandbox.start(sbSpec(), "g");
  await graceful.sandbox.stop(hg.id, 100);
  assert.deepEqual(await hg.wait(), { exitCode: 0 });

  const sigterm = createFakes({ sandboxStop: "sigterm" });
  const hs = await sigterm.sandbox.start(sbSpec(), "s");
  await sigterm.sandbox.stop(hs.id, 100);
  assert.deepEqual(await hs.wait(), { exitCode: 143 });

  const sigkill = createFakes({ sandboxStop: "sigkill" });
  const hk = await sigkill.sandbox.start(sbSpec(), "k");
  const before = Date.now();
  await sigkill.sandbox.stop(hk.id, 25);
  assert.deepEqual(await hk.wait(), { exitCode: 137 });
  assert.ok(Date.now() - before >= 20); // SIGKILL only after graceMs
});

test("sandbox: stop/kill never overwrite an already-scripted exit", async () => {
  const f = createFakes();
  const h = await f.sandbox.start(sbSpec(), "sb1");
  f.hooks.exitSandbox(h.id, 143);
  await f.sandbox.stop(h.id, 10); // already exited: no-op, like Docker
  assert.deepEqual(await h.wait(), { exitCode: 143 });
  assert.deepEqual(await f.sandbox.inspect(h.id), { running: false, exitCode: 143, status: "exited" });
});

test("sandbox: attach throws SandboxUnavailableError for unknown and exited ids", async () => {
  const f = createFakes();
  await assert.rejects(f.sandbox.attach("nope", "a"), SandboxUnavailableError);
  const h = await f.sandbox.start(sbSpec(), "sb1");
  f.hooks.exitSandbox(h.id, 0);
  await assert.rejects(f.sandbox.attach(h.id, "a"), SandboxUnavailableError);
});

// Shared contract bodies run against the fake; adapter packages wire the optional `real` half.
const sandboxCases = contract<SandboxContractWorld>("Sandbox", { fake: () => createFakes() });
sandboxCases("start/list/attach/wait/inspect/kill", sandboxContractBody);

test("sandbox contract: a world's cmd reaches every spec the body starts, and none is added without one", async () => {
  const starts = (f: ReturnType<typeof createFakes>) =>
    f.calls.filter((c) => c.port === "Sandbox" && c.method === "start").map((c) => (c.args[0] as { cmd?: string[] }).cmd);
  const plain = createFakes();
  await sandboxContractBody(plain);
  assert.ok(starts(plain).length > 0 && starts(plain).every((c) => c === undefined));
  const withCmd = createFakes();
  await sandboxContractBody({ sandbox: withCmd.sandbox, cmd: ["sleep", "300"] });
  assert.ok(starts(withCmd).length > 0 && starts(withCmd).every((c) => c?.join(" ") === "sleep 300"));
});

test("contract() refuses an adapter set with neither a fake nor a real adapter", () => {
  assert.throws(() => contract("Nothing", {}), /supply a fake, a real adapter, or both/);
});

const scheduleCases = contract<ScheduleContractWorld>("ScheduleStore", { fake: () => createFakes() });
scheduleCases("upsert/pause/breaker/lastFired", scheduleContractBody);

const escalationCases = contract<EscalationContractWorld>("EscalationStore", { fake: () => createFakes() });
escalationCases("create/get/list/answer", escalationContractBody);

const approvalCases = contract<ApprovalContractWorld>("ApprovalStore", { fake: () => createFakes() });
approvalCases("create/decide/timeout ladder", approvalContractBody);

test("mailbox: strictMailboxTargets rejects an unknown or reaped target (mirrors the store)", async () => {
  const f = createFakes({ strictMailboxTargets: true });
  await mk(f, "a");
  await assert.rejects(f.mailbox.send("ghost", { kind: "timeout" }, "k1"), /unknown agent ghost/);
  await f.registry.transition("a", 0, "running", { idempotencyKey: "r1" });
  await f.registry.transition("a", 0, "exited", { exit: "failed", idempotencyKey: "r2" });
  await f.registry.transition("a", 0, "reaped", { idempotencyKey: "r3" });
  await assert.rejects(f.mailbox.send("a", { kind: "timeout" }, "k2"), /reaped agent a/);
});

test("FakeSandbox.startErrors scripts typed start failures; ModelGateway.issueKey replays by key", async () => {
  const f = createFakes();
  f.hooks.raw.sandbox.startErrors.push(new SandboxStartError("pull_failed", "net", true), null);
  const spec = { agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-x", containerPath: "/w" }] };
  await assert.rejects(f.sandbox.start(spec, "k"), (e: SandboxStartError) => e.kind === "pull_failed" && e.retryable);
  assert.ok(await f.sandbox.start(spec, "k"));
  // The fake gateway issues only for a registered container agent with a resolved model, as the real one does.
  await f.registry.create({ id: "a", parent: null, name: "a", task: "t", host: "h", budgetMicros: 100, idempotencyKey: "a", spec: MODEL_SPEC });
  await f.gateway.issueKey("a", 100, "m1");
  f.hooks.addSpend("a", 40);
  await f.gateway.issueKey("a", 100, "m1"); // replay: no reset
  assert.equal((await f.gateway.spend("a")).spentMicros, 40);
});

test("FakeSandbox.waitErrors scripts a failing wait() on start and attach handles; other sandboxes still resolve at exit", async () => {
  const f = createFakes();
  const raw = f.hooks.raw.sandbox;
  const spec = { agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-x", containerPath: "/w" }] };
  const h = await f.sandbox.start(spec, "k1");
  const other = await f.sandbox.start(spec, "k2");
  const attached = await f.sandbox.attach(h.id, "a");
  raw.exit(h.id, 3);
  raw.exit(other.id, 7);
  raw.waitErrors.set(h.id, new SandboxUnavailableError());
  await assert.rejects(h.wait(), SandboxUnavailableError);
  await assert.rejects(attached.wait(), SandboxUnavailableError);
  assert.deepEqual(await other.wait(), { exitCode: 7 });
  raw.waitErrors.delete(h.id);
  assert.deepEqual(await h.wait(), { exitCode: 3 });
});

test("FakeSandbox.resultWork records every call with its opts, maxBytes included, even when the sandbox is gone", async () => {
  const f = createFakes();
  const spec = { agent: "a", image: "i", env: {}, mounts: [{ kind: "workspace" as const, workspace: "ws-x", containerPath: "/w" }] };
  const h = await f.sandbox.start(spec, "k");
  await f.sandbox.resultWork(h.id, { save: true, expectedFingerprint: "fp", maxBytes: 1024 });
  await f.sandbox.resultWork(h.id, { maxBytes: 2048 });
  await assert.rejects(f.sandbox.resultWork("sbx-missing", { maxBytes: 1 }), SandboxUnavailableError);
  assert.deepEqual(f.hooks.raw.sandbox.resultWorkCalls, [
    { id: h.id, opts: { save: true, expectedFingerprint: "fp", maxBytes: 1024 } },
    { id: h.id, opts: { maxBytes: 2048 } },
    { id: "sbx-missing", opts: { maxBytes: 1 } },
  ]);
});

test("FakePlacement.sync reconciles", async () => {
  const f = createFakes({ placementMaxConcurrent: 1 });
  await f.placement.admit({ agent: "a", priority: 1 });
  await f.placement.sync!(["x"]);
  assert.deepEqual((await f.placement.status())[0]!.running, ["x"]);
});

const journalCases = contract<JournalContractWorld>("Journal", {
  fake: () => {
    let t = 1_000_000;
    const f = createFakes({ now: () => t });
    return {
      journal: f.journal,
      registry: f.registry,
      checkpoints: f.checkpoints,
      age: async (ms) => {
        t += ms;
      },
    };
  },
});
journalCases("retention + spendFor", journalRetentionContractBody);

const hostCases = contract<HostStoreContractWorld>("HostStore", {
  fake: () => {
    let t = 1_000_000;
    const f = createFakes({ now: () => t });
    return {
      hosts: f.hosts,
      age: async (ms) => {
        t += ms;
      },
    };
  },
});
hostCases("upsert/state/reserve/order/release", hostStoreContractBody);

const checkpointFenceCases = contract<CheckpointFenceContractWorld>("CheckpointStore", { fake: () => createFakes() });
checkpointFenceCases("generation fence, replay, no path field", checkpointFenceContractBody);

const mailboxCases = contract<MailboxContractWorld>("Mailbox", { fake: () => createFakes() });
mailboxCases("ids, level coalescing, ack", mailboxContractBody);

const raiseBudgetCases = contract<RaiseBudgetContractWorld>("Registry", { fake: () => createFakes() });
raiseBudgetCases("raiseBudget idempotent by key", raiseBudgetContractBody);
contract<RegistryListContractWorld>("Registry", { fake: () => createFakes() })("list filters", registryListContractBody);

const mountCases = contract<MountProviderContractWorld>("MountProvider", { fake: () => createFakes() });
mountCases("resolve kinds", mountProviderContractBody);

test("FakeHostStore: scripted errors are consumed per fresh call and replays skip them", async () => {
  const f = createFakes();
  const h = { id: "h", labels: {}, capacity: { maxSessions: 1 }, images: [], state: "ready" as const };
  await f.hosts.upsertHost(h, "k1");
  f.hooks.raw.hosts.errors.push(new Error("boom"));
  await f.hosts.upsertHost(h, "k1"); // replay: error not consumed
  await assert.rejects(() => f.hosts.upsertHost(h, "k2"), /boom/);
  await f.hosts.upsertHost(h, "k2");
  assert.ok(f.calls.some((c) => c.port === "HostStore" && c.method === "upsertHost"));
});

test("FakeMountProvider: deterministic roots, recorded calls, scripted ENOSPC and revoked mounts", async () => {
  const f = createFakes();
  const r = await f.mounts.resolve("a", { kind: "workspace", workspace: "ws-a", containerPath: "/work" });
  assert.deepEqual(r, { type: "bind", hostPath: "/fake/workspace/ws-a", containerPath: "/work", readOnly: false });
  assert.equal(f.hooks.raw.mounts.resolved.length, 1);
  f.hooks.raw.mounts.errors.push(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
  await assert.rejects(() => f.mounts.resolve("a", { kind: "scratch", containerPath: "/tmp" }), /no space/);
  f.hooks.raw.mounts.revoked.add("ws-a");
  await assert.rejects(() => f.mounts.resolve("a", { kind: "workspace", workspace: "ws-a", containerPath: "/work" }), /revoked/);
  assert.equal(f.hooks.raw.mounts.resolved.length, 1); // failed resolves record nothing
});

test("FakeWorkspace returns a deterministic opaque workspace id, never a path", async () => {
  const f = createFakes();
  assert.equal((await f.workspace.create("a", {})).workspace, "ws-a");
  assert.equal((await f.workspace.fork("a", "b")).workspace, "ws-b");
});

test("FakeStateStore: a workflow writer round-trips, and a stale-generation fence refuses put and remove without effect", async () => {
  const f = createFakes();
  const spec = { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } } as SpawnSpec;
  const a = await f.registry.create({ parent: null, name: "wf", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "wf-a", spec });
  const repaired = await f.registry.create({ parent: null, name: "wf2", task: "t", host: "h", budgetMicros: 1, idempotencyKey: "wf-b", spec });
  const writer = { workflow: "ext/digest", instance: "i1" };
  const fence = { agent: a.id, generation: a.generation };
  const put = await f.state.put({ owner: "wf", key: "k", value: 1, writer, fence }, "wf-1");
  assert.ok(put.ok && JSON.stringify(put.doc.writer) === JSON.stringify(writer));
  assert.deepEqual((await f.state.get("wf", "k"))?.writer, writer);
  // The fence is not in the fingerprint: a repaired task (another agent id, same workflow, instance and key) replays the first result.
  assert.deepEqual(await f.state.put({ owner: "wf", key: "k", value: 1, writer, fence: { agent: repaired.id, generation: repaired.generation } }, "wf-1"), put);
  await f.registry.bumpGeneration(a.id, "h", "wf-bump");
  await assert.rejects(() => f.state.put({ owner: "wf", key: "k", value: 2, writer, fence }, "wf-2"), StaleGenerationError);
  await assert.rejects(() => f.state.remove({ owner: "wf", key: "k", writer, fence }, "wf-3"), StaleGenerationError);
  assert.equal((await f.state.get("wf", "k"))?.value, 1, "a stale fence changed nothing");
  await assert.rejects(() => f.state.put({ owner: "wf", key: "k", value: 2, writer, fence: { agent: "nope", generation: 0 } }, "wf-4"), /unknown agent/);
  await assert.rejects(() => f.state.put({ owner: "wf", key: "k", value: 2, writer, fence: { agent: a.id } as never }, "wf-5"), /fence must be/);
  const fresh = { agent: a.id, generation: a.generation + 1 };
  assert.ok((await f.state.put({ owner: "wf", key: "k", value: 3, writer, fence: fresh }, "wf-6")).ok);
});

test("FakeQuotaCounters: scripted take results short-circuit the logic; every call is recorded", () => {
  const q = new FakeQuotaCounters();
  q.takeResults.push({ ok: false, used: 7 });
  assert.deepEqual(q.take("calls", "a", 0, 1, 10), { ok: false, used: 7 });
  assert.equal(q.peek("calls", "a", 0), 0, "a scripted result changes no state");
  assert.deepEqual(q.take("calls", "a", 0, 1, 10), { ok: true, used: 1 });
  assert.equal(q.give("calls", "a", 0, 1), 0);
  assert.deepEqual(
    q.calls.map((c) => c.method),
    ["take", "peek", "take", "give"],
  );
  assert.deepEqual(q.calls[0]!.args, ["calls", "a", 0, 1, 10]);
});

// Negative controls for the contract() gating floor: each spawns node --test on the fixture so a failure is observable as an exit code.
function runContractFixture(scenario: string, nodeArgs: string[] = []) {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "contract-negative.fixture.ts");
  const clean = { ...process.env };
  delete clean.NODE_TEST_CONTEXT; // a child node --test must not think it runs inside this runner
  const r = spawnSync(process.execPath, ["--test", ...nodeArgs, fixture], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...clean, CONTRACT_NEGATIVE_SCENARIO: scenario },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test("contract(): a real adapter that throws a non-gate error fails the case instead of skipping it", () => {
  const r = runContractFixture("throw");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /boom/);
  assert.match(r.out, /✖ NegThrow \[real\] body/);
});

test("contract(): a port with a real adapter and no registered cases fails the coverage hook", () => {
  const r = runContractFixture("no-cases");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /NegNoCases/);
  assert.match(r.out, /no contract cases were registered/);
});

test("contract(): an all-gated port passes loudly by default and fails when the port sets requireReal", () => {
  const open = runContractFixture("gated");
  assert.equal(open.code, 0, open.out);
  assert.match(open.out, /CONTRACT GATED: NegGated: all 2 real-adapter case\(s\) skipped.*negative control gate closed/);
  const strict = runContractFixture("gated-require-real");
  assert.notEqual(strict.code, 0, strict.out);
  assert.match(strict.out, /NegGated: requireReal is set/);
});

test("contract(): two sites sharing a port label do not mask each other; the empty site is named by its index", () => {
  const r = runContractFixture("shared-label");
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /NegShared #1: a real adapter was supplied but no contract cases were registered/);
  assert.doesNotMatch(r.out, /NegShared #2: /);
});

test("contract(): a filtered run relaxes the unrun-case accounting, says so, and still passes", () => {
  const r = runContractFixture("gated", ["--test-name-pattern=NegGated \\[real\\] one"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CONTRACT FLOOR RELAXED/);
});
