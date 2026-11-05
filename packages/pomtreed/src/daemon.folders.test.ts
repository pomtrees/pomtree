import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord } from "@pomtree/core";
import { GitWorkspace } from "@pomtree/workspace-git";
import { fakeBundle, tmpDir } from "@pomtree/testing";
import { SESSION_FILE } from "./daemon-util.ts";
import { get, setup, spawnSpec, until } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const SESSION = `{"type":"session"}\n`;
const DAY = 24 * 3600 * 1000;

// Real-git tests need git >= 2.38 (the controller refuses ingest below it); probe once and skip with the reason otherwise.
function gitSkip(): string | false {
  try {
    const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
    if (!m) return "git --version unparseable";
    return Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38) ? false : `git ${m[1]}.${m[2]} < 2.38`;
  } catch {
    return "git is not installed";
  }
}
const SKIP = gitSkip();

function realWorkspace(): GitWorkspace {
  const repo = tmpDir("pomtreed-folders-repo-");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  const state = tmpDir("pomtreed-folders-state-");
  return new GitWorkspace({ repoDir: repo, mirrorDir: join(state, "mirror.git"), foldersRoot: join(state, "workspaces") });
}

const writeSession = (t: T, agent: string) => {
  mkdirSync(join(t.daemon.deps.sessionRoot, agent), { recursive: true });
  writeFileSync(join(t.daemon.deps.sessionRoot, agent, SESSION_FILE), SESSION);
};

async function yieldedAgent(t: T, key: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const a = await reg.create({ spec: spawnSpec, parent: root.id, name: key, task: "t", host: "h1", budgetMicros: 10_000, idempotencyKey: key });
  await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await t.daemon.deps.workspace.create(a.id, {});
  return reg.transition(a.id, a.generation, "yielded", { idempotencyKey: `${key}-y` });
}

test("OOM-killed container resumes in its folder with uncommitted edits (real clone)", { skip: SKIP }, async () => {
  const workspace = realWorkspace();
  const seen: string[] = [];
  const t = setup(
    async (c) => {
      const w = await workspace.create(c.agent, {});
      const folder = workspace.hostPath(w.workspace);
      if (c.wake === undefined) {
        writeFileSync(join(folder, "scratch.txt"), "uncommitted edit"); // untracked: no commit, no push
        writeFileSync(join(folder, "README.md"), "modified\n");
        writeSession(t, c.agent);
        await until(() => t.fakes.hooks.raw.sandbox.running.size === 1);
        t.fakes.hooks.exitSandbox([...t.fakes.hooks.raw.sandbox.running.keys()][0]!, 137, true);
        return;
      }
      seen.push(readFileSync(join(folder, "scratch.txt"), "utf8"), readFileSync(join(folder, "README.md"), "utf8"));
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
    },
    { workspace },
  );
  const a = await t.spawn();
  await until(async () => ["exited", "reaped"].includes((await get(t, a.id)).state), 8000);
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).exit, "succeeded");
  assert.deepEqual(seen, ["uncommitted edit", "modified\n"], "the resumed run found the dead run's edits in the same folder");
  const started = t.fakes.hooks.raw.sandbox.started;
  assert.equal(started.length, 2);
  const mount = (i: number) => started[i]!.mounts.find((m) => m.kind === "workspace");
  assert.equal((mount(0) as { workspace: string }).workspace, (mount(1) as { workspace: string }).workspace, "same folder id mounted both times");
  assert.match(started[0]!.env.POMTREE_BASE_COMMIT ?? "", /^[0-9a-f]{40}$/);
  assert.equal(started[1]!.env.POMTREE_BASE_COMMIT, started[0]!.env.POMTREE_BASE_COMMIT, "the base commit is re-supplied on resume");
  const msgs = (await t.journal.read({ agent: a.id })).map((e) => (e.payload as { message?: string }).message ?? "");
  assert.ok(msgs.some((m) => m.startsWith("auto-restart:")));
  assert.ok(!(await t.journal.read({ agent: a.id })).some((e) => e.payload.kind === "workspace_evicted"));
});

test("a forked child has the parent's untracked files (real clone)", { skip: SKIP }, async () => {
  const workspace = realWorkspace();
  let childSaw = "";
  const t = setup(
    async (c) => {
      const w = await workspace.create(c.agent, {});
      const folder = workspace.hostPath(w.workspace);
      if (c.prompt === "parent") {
        writeFileSync(join(folder, "notes.txt"), "from the parent, never committed");
        writeSession(t, c.agent);
        await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
        return;
      }
      if (c.wake === "child task") childSaw = readFileSync(join(folder, "notes.txt"), "utf8");
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
    },
    { workspace },
  );
  const parent = await t.spawn("p", { task: "parent" });
  await until(async () => (await get(t, parent.id)).state === "yielded", 8000);
  const kid = await t.daemon.spawn(parent.id, { name: "kid", task: "child task", idempotencyKey: "f1", fork: true, budgetMicros: 500 });
  await until(async () => ["exited", "reaped"].includes((await get(t, kid.id)).state), 8000);
  await t.orchestrator.idle();
  assert.equal(childSaw, "from the parent, never committed");
  assert.equal((await get(t, kid.id)).exit, "succeeded");
  assert.ok(existsSync(join(workspace.hostPath((await workspace.create(parent.id, {})).workspace), "notes.txt")), "the parent's folder is untouched");
});

test("fork of a running agent is refused with a clear error; a yielded parent needs its folder", async () => {
  const t = setup(async (c) => void (await c.stopped));
  const run = await t.spawn("r");
  await until(async () => (await get(t, run.id)).sandbox !== null);
  await assert.rejects(
    t.daemon.spawn(run.id, { name: "k", task: "t", idempotencyKey: "f", fork: true }),
    (e: { status?: number; message?: string }) => e.status === 409 && /no checkpoint/.test(e.message ?? ""),
  );
  const y = await yieldedAgent(t, "y");
  await t.daemon.deps.checkpoints.write(
    {
      agent: y.id,
      generation: y.generation,
      host: "h1",
      sessionRef: await t.fakes.sessions.put(new TextEncoder().encode(SESSION)),
      workspace: `ws-${y.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 500,
      imageDigest: "img",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    },
    "y-cp",
  );
  await t.daemon.deps.workspace.evict(y.id);
  await assert.rejects(
    t.daemon.spawn(y.id, { name: "k", task: "t", idempotencyKey: "f2", fork: true }),
    (e: { status?: number; message?: string }) => e.status === 409 && /evicted/.test(e.message ?? ""),
  );
  await t.daemon.cancel(run.id);
  await t.orchestrator.idle();
});

test("pause order: the container is stopped before the session is read and the checkpoint written; `pausing` is journaled first", async () => {
  const t = setup(async (c) => {
    if (c.wake !== undefined) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    writeSession(t, c.agent);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).state === "yielded");
  await t.orchestrator.idle();
  const order = t.fakes.calls
    .filter((c) => (c.port === "Sandbox" && c.method === "stop") || (c.port === "CheckpointStore" && c.method === "write"))
    .map((c) => `${c.port}.${c.method}`);
  assert.equal(order[0], "Sandbox.stop", `stop first: ${order.join(",")}`);
  assert.ok(order.indexOf("CheckpointStore.write") > order.indexOf("Sandbox.stop"));
  const kinds = (await t.journal.read({ agent: a.id })).map((e) => e.payload.kind);
  assert.ok(kinds.indexOf("pausing") !== -1 && kinds.indexOf("pausing") < kinds.indexOf("yielded"));
  const cp = await t.daemon.deps.checkpoints.latest(a.id);
  assert.equal(cp?.workspace, `ws-${a.id}`);
  assert.equal(cp?.node, "h1");
  assert.equal(cp?.ingested, null);
  assert.equal("commit" in (cp ?? {}), false);
  assert.ok(t.fakes.hooks.raw.workspace.workspaces.has(a.id), "the folder is kept on pause");
});

test("a crash between the container stop and the checkpoint write is completed by recovery, idempotently", async () => {
  const t = setup(async (c) => {
    writeSession(t, c.agent);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const real = t.daemon.deps.checkpoints.write.bind(t.daemon.deps.checkpoints);
  let crashed = false;
  t.daemon.deps.checkpoints.write = async (...args) => {
    if (!crashed) {
      crashed = true;
      throw new Error("simulated crash after the stop, before the checkpoint");
    }
    return real(...args);
  };
  const a = await t.spawn();
  await until(() => crashed);
  await t.orchestrator.idle();
  assert.equal((await get(t, a.id)).state, "running", "no checkpoint and no yielded transition yet");
  assert.equal(await t.daemon.deps.checkpoints.latest(a.id), null);
  assert.equal([...t.fakes.hooks.raw.sandbox.running.values()].filter((s) => s.exitCode === null).length, 0, "the container is already stopped");

  await t.daemon.recover(); // what a restarted daemon does
  const after = await get(t, a.id);
  assert.equal(after.state, "yielded");
  const cp = await t.daemon.deps.checkpoints.latest(a.id);
  assert.ok(cp && cp.generation === a.generation && cp.wait?.kind === "message");
  assert.equal(cp.workspace, `ws-${a.id}`);
  const ks = (await t.journal.read({ agent: a.id })).map((e) => e.payload.kind);
  assert.equal(ks.filter((k) => k === "yielded").length, 1);
  await t.daemon.recover();
  await t.daemon.recover();
  assert.equal((await t.daemon.deps.checkpoints.latest(a.id))?.id, cp.id, "a second recovery writes no second checkpoint");
  assert.equal((await t.journal.read({ agent: a.id })).filter((e) => e.payload.kind === "yielded").length, 1);
  assert.ok(t.fakes.hooks.raw.workspace.workspaces.has(a.id));
});

test("an evicted folder falls back to the last ingested ref on resume", async () => {
  let wakes = 0;
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes++;
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    await t.daemon.deps.workspace.ingest(
      c.agent,
      (async function* () {
        yield fakeBundle([{ name: `agent/${c.agent}`, commit: "ingested-abc" }]);
      })(),
      { maxBytes: 1 << 20 },
    );
    writeSession(t, c.agent);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).state === "yielded");
  await t.orchestrator.idle();
  const cp = await t.daemon.deps.checkpoints.latest(a.id);
  assert.deepEqual(cp?.ingested, { ref: `refs/agents/${a.id}/heads/agent/${a.id}`, commit: "ingested-abc" });

  await t.daemon.deps.workspace.evict(a.id); // the sweep took the idle folder
  assert.equal(await t.daemon.deps.workspace.has(a.id), false);
  await t.daemon.resumeAgent(a.id, "wake up");
  await t.orchestrator.idle();
  assert.equal(wakes, 1);
  assert.equal((await get(t, a.id)).exit, "succeeded");
  const creates = t.fakes.calls.filter((c) => c.port === "Workspace" && c.method === "create").map((c) => (c.args[1] as { fromCommit?: string }).fromCommit);
  assert.ok(creates.includes("ingested-abc"), `a fresh clone at the ingested commit: ${JSON.stringify(creates)}`);
  const msgs = (await t.journal.read({ agent: a.id })).map((e) => (e.payload as { message?: string }).message ?? "");
  assert.ok(msgs.some((m) => m.includes("workspace folder was evicted")));
});

test("with the folder present, resume mounts it as is (no re-create from a commit)", async () => {
  const t = setup(async (c) => {
    if (c.wake !== undefined) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    writeSession(t, c.agent);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const a = await t.spawn();
  await until(async () => (await get(t, a.id)).state === "yielded");
  await t.orchestrator.idle();
  await t.daemon.resumeAgent(a.id, "wake up");
  await t.orchestrator.idle();
  const withCommit = t.fakes.calls.filter(
    (c) => c.port === "Workspace" && c.method === "create" && (c.args[1] as { fromCommit?: string }).fromCommit !== undefined,
  );
  assert.equal(withCommit.length, 0);
});

test("sweepFolders evicts reaped and long-idle paused folders, journals workspace_evicted, never a running agent's", async () => {
  let clock = 1_000_000;
  const t = setup(async (c) => void (await c.stopped), { now: () => clock, folderIdleMs: 7 * DAY });
  const paused = await yieldedAgent(t, "paused");
  const fresh = await yieldedAgent(t, "fresh");
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const reaped = await reg.create({ spec: spawnSpec, parent: root.id, name: "r", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "r" });
  await reg.transition(reaped.id, reaped.generation, "running", { idempotencyKey: "r-run" });
  await reg.transition(reaped.id, reaped.generation, "exited", { exit: "succeeded", idempotencyKey: "r-x" });
  await reg.transition(reaped.id, reaped.generation, "reaped", { idempotencyKey: "r-reap" });
  await t.daemon.deps.workspace.create(reaped.id, {});
  const running = await t.spawn("live");
  await until(async () => (await get(t, running.id)).sandbox !== null);

  clock += 8 * DAY;
  const gone = await reg.create({ spec: spawnSpec, parent: root.id, name: "fresh2", task: "t", host: "h1", budgetMicros: 1, idempotencyKey: "fresh2" });
  void gone;
  // `fresh` was paused 8 days ago too; touch it so it is within the window: re-yield stamps updatedAt.
  await reg.transition(fresh.id, fresh.generation, "running", { idempotencyKey: "fresh-r2" }).catch(() => {});
  const evicted = await t.daemon.sweepFolders();
  assert.ok(evicted.includes(paused.id), "idle past retention");
  assert.ok(evicted.includes(reaped.id), "reaped");
  assert.ok(!evicted.includes(running.id), "a running agent's folder is never evicted");
  const ws = t.fakes.hooks.raw.workspace.workspaces;
  assert.equal(ws.has(paused.id), false);
  assert.equal(ws.has(reaped.id), false);
  assert.equal(ws.has(running.id), true);
  const ev = async (id: string) =>
    (await t.journal.read({ agent: id })).filter((e) => e.payload.kind === "workspace_evicted").map((e) => (e.payload as { reason: string }).reason);
  assert.deepEqual(await ev(paused.id), ["idle"]);
  assert.deepEqual(await ev(reaped.id), ["reaped"]);
  assert.deepEqual(await t.daemon.sweepFolders(), [], "idempotent");
  await t.daemon.cancel(running.id);
  await t.orchestrator.idle();
});

test("sweepFolders under disk pressure evicts the oldest reaped folders first, only while space is short", async () => {
  let clock = 1_000_000;
  let freed = 0;
  const t = setup(async (c) => void (await c.stopped), {
    now: () => clock,
    folderReapedGraceMs: DAY,
    folderMinFreeBytes: 1000,
    diskFreeBytes: async () => 100 + freed * 600,
  });
  const root = await t.daemon.root();
  const reg = t.daemon.deps.registry;
  const ws = t.fakes.hooks.raw.workspace;
  const realEvict = ws.evict.bind(ws);
  ws.evict = async (a) => {
    freed++;
    return realEvict(a);
  };
  const ids: string[] = [];
  for (const k of ["o", "m", "n"]) {
    const a = await reg.create({ spec: spawnSpec, parent: root.id, name: k, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: k });
    await reg.transition(a.id, a.generation, "running", { idempotencyKey: `${k}-run` });
    await reg.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${k}-x` });
    await reg.transition(a.id, a.generation, "reaped", { idempotencyKey: `${k}-reap` });
    await t.daemon.deps.workspace.create(a.id, {});
    ids.push(a.id);
    clock += 1000; // reaped in order o, m, n
  }
  const evicted = await t.daemon.sweepFolders();
  assert.deepEqual(evicted, [ids[0], ids[1]], "oldest first; stops once free space is back above the floor");
  assert.equal(ws.workspaces.has(ids[2]!), true);
  const reason = (await t.journal.read({ agent: ids[0]! })).find((e) => e.payload.kind === "workspace_evicted");
  assert.equal((reason!.payload as { reason: string }).reason, "disk_pressure");
});

test("an inspect error with a pausing marker is unknown, never dead: the container is not killed and one error is journaled", async () => {
  const t = setup(async (c) => {
    writeSession(t, c.agent);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" });
  });
  const real = t.daemon.deps.checkpoints.write.bind(t.daemon.deps.checkpoints);
  let crashed = false;
  t.daemon.deps.checkpoints.write = async (...args) => {
    if (!crashed) {
      crashed = true;
      throw new Error("simulated crash");
    }
    return real(...args);
  };
  const a = await t.spawn();
  await until(() => crashed);
  await t.orchestrator.idle();
  // pretend the registry still names a container and the engine errors on inspect
  await t.daemon.deps.registry.setSandbox(a.id, a.generation, "sb-unknown", "set-unknown");
  t.daemon.deps.sandbox.inspect = async () => {
    throw new Error("docker daemon unreachable");
  };
  const kills = () => t.fakes.calls.filter((c) => c.port === "Sandbox" && c.method === "kill").length;
  for (let i = 0; i < 5; i++) await t.daemon.reconcile();
  assert.equal(kills(), 0, "no force-kill on an unknown container");
  assert.equal((await get(t, a.id)).state, "running", "pause not completed while liveness is unknown");
  const errs = (await t.journal.read({ agent: a.id })).filter((e) => (e.payload as { message?: string }).message?.includes("cannot tell whether container"));
  assert.equal(errs.length, 1, "journaled once after the bound");
});

test("a resume that claims the agent first wins the race with the folder sweep: the folder is not evicted", async () => {
  let clock = 1_000_000;
  const t = setup(async () => {}, { now: () => clock, folderIdleMs: DAY });
  const y = await yieldedAgent(t, "race");
  await t.daemon.deps.checkpoints.write(
    {
      agent: y.id,
      generation: y.generation,
      host: "h1",
      sessionRef: await t.fakes.sessions.put(new TextEncoder().encode(SESSION)),
      workspace: `ws-${y.id}`,
      node: "h1",
      ingested: null,
      wait: { kind: "message" },
      remainingBudgetMicros: 500,
      imageDigest: "img",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    },
    "race-cp",
  );
  clock += 2 * DAY;
  // interleave: the resume starts right after the sweep has planned (it lists folders first)
  const ws = t.daemon.deps.workspace;
  const realList = ws.list.bind(ws);
  let resumed: Promise<unknown> | undefined;
  ws.list = async () => {
    const out = await realList();
    resumed = t.daemon.resumeAgent(y.id, "wake");
    return out;
  };
  const evicted = await t.daemon.sweepFolders();
  await resumed;
  assert.deepEqual(evicted, [], "never evict a folder a resume just claimed");
  assert.equal(await ws.has(y.id), true);
  await t.orchestrator.idle();
});
