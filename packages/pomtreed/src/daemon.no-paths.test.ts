import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentId, AgentRecord, Checkpoint } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { GitWorkspace } from "@pomtree/workspace-git";
import { FakeModelCatalog, ScriptHarness, createFakes, tmpDir } from "@pomtree/testing";
import { handle } from "./api.ts";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { SECRET, op, until } from "./test-setup.ts";

// Clone failures carry the folder path in git's own message.
class FlakyWorkspace extends GitWorkspace {
  failCreateRoot: string | null = null;
  override async create(agent: AgentId, o: { fromCommit?: string }) {
    if (this.failCreateRoot !== null) throw new Error(`fatal: could not create work tree dir '${join(this.failCreateRoot, agent)}': Permission denied`);
    return super.create(agent, o);
  }
}

test("no state-directory path reaches any journal or checkpoint row (clone failure, sandbox start failure, harness error, yield, exit)", async () => {
  const stateDir = tmpDir("pomtreed-state-");
  const real = realpathSync(stateDir);
  const repo = tmpDir("pomtreed-repo-");
  const realRepo = realpathSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");

  const dbPath = join(stateDir, "pomtreed.sqlite");
  const store = openStore(dbPath);
  const workspace = new FlakyWorkspace({ repoDir: repo, mirrorDir: join(stateDir, "mirror.git"), foldersRoot: join(stateDir, "workspaces") });
  const sessionRoot = join(stateDir, "sessions");
  const fakes = createFakes({ host: "h1" });
  const node = new LocalNode({
    hostId: "h1",
    sandbox: fakes.sandbox,
    workspace,
    capacity: { maxSessions: 4 },
    workspacePath: (id) => workspace.hostPath(id),
    sessionDir: (a) => join(sessionRoot, a),
  });
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1", ready: () => node.register(store.hosts) });
  const orchestrator = new LocalOrchestrator();
  let daemon!: Daemon;
  const harness = new ScriptHarness(async (c) => {
    const api = async (method: string, url: string, body?: unknown) =>
      handle(daemon, { method, url, body, token: daemon.agentToken(c.agent, (await daemon.get(c.agent))?.generation ?? 0) });
    if (c.wake) return void (await api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "woke" } }));
    if (c.prompt === "harness-error")
      return c.emit({ kind: "error", message: `ENOENT: no such file or directory, open '${stateDir}/sessions/x/session.jsonl'` });
    if (c.prompt === "repo-error") return c.emit({ kind: "error", message: `fatal: not a git repository: '${repo}/.git' (${realRepo})` });
    if (c.prompt === "yield") return void (await api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y1" }));
    await api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: 1 } });
  });
  daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: join(stateDir, "pomtreed.sock"),
    rootBudgetMicros: 10_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox: fakes.hooks.raw.sandbox,
    workspace,
    harness,
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    models: new FakeModelCatalog(),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot,
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement,
    orchestrator,
    redactRoots: [stateDir, repo],
  });
  const operator = async (name: string, task: string) => {
    const r = await handle(daemon, { method: "POST", url: "/v1/agents", token: op, body: { name, task, idempotencyKey: name } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body as AgentRecord).id;
  };

  // 1. The sandbox refuses to start with a message naming the state dir (as a docker bind error would).
  fakes.hooks.raw.sandbox.startErrors.push(
    new Error(`docker: Error response from daemon: invalid mount config: bind source ${stateDir}/workspaces/x does not exist (${real})`),
  );
  const startFail = await operator("start-fail", "plain");
  await orchestrator.idle();
  assert.equal(((await daemon.get(startFail)) as AgentRecord).exit, "failed");

  // 2. The clone fails with a git message that names the folder path.
  workspace.failCreateRoot = join(stateDir, "workspaces");
  const commitFail = await operator("clone-fail", "plain");
  await orchestrator.idle();
  workspace.failCreateRoot = null;
  assert.equal(((await daemon.get(commitFail)) as AgentRecord).exit, "failed");

  // 3. The harness reports an error naming a session file path.
  const harnessErr = await operator("harness-error", "harness-error");
  await orchestrator.idle();

  // 3b. The harness reports an error naming the repo directory (outside the state dir).
  const repoErr = await operator("repo-error", "repo-error");
  await orchestrator.idle();

  // 4. A yield (checkpoint) and a resumed exit.
  const yielded = await operator("yielder", "yield");
  await until(async () => ((await daemon.get(yielded)) as AgentRecord).state === "yielded");
  const root = await daemon.root();
  await daemon.sendMessage(root.id, yielded, "go", root.generation, "m1");
  await orchestrator.idle();
  assert.ok(["exited", "reaped"].includes(((await daemon.get(yielded)) as AgentRecord).state));

  // Scan: the journal and checkpoint tables read straight from SQLite, plus the port views.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const journalRows = db.prepare("SELECT * FROM journal").all();
  const checkpointRows = db.prepare("SELECT * FROM checkpoints").all();
  db.close();
  assert.ok(journalRows.length > 10 && checkpointRows.length >= 1, "the scan has rows to look at");
  const portJournal = await store.journal.read({ limit: 100_000 });
  const portCheckpoints = (await Promise.all([startFail, commitFail, harnessErr, repoErr, yielded].map((a) => store.checkpoints.latest(a)))).filter(
    (c): c is Checkpoint => c !== null,
  );
  for (const [what, rows] of [
    ["journal table", journalRows],
    ["checkpoint table", checkpointRows],
    ["journal port", portJournal],
    ["checkpoint port", portCheckpoints],
  ] as const) {
    const text = JSON.stringify(rows);
    for (const needle of [stateDir, real, repo, realRepo, join(stateDir, "pomtreed.sock")])
      assert.ok(!text.includes(needle), `${what} contains the configured host path ${needle}`);
  }

  // The scan has teeth: the errors were recorded, redacted, and the commit failure names the folder by id.
  const messages = portJournal
    .map((e) => e.payload)
    .filter((p) => p.kind === "error")
    .map((p) => (p as { message: string }).message);
  assert.ok(
    messages.some((m) => m.includes("<state>/workspaces/x")),
    `sandbox start failure recorded and redacted: ${messages.join(" | ")}`,
  );
  assert.ok(
    messages.some((m) => m.includes("<state>/x/session.jsonl")),
    `harness error recorded and redacted: ${messages.join(" | ")}`,
  );
  assert.ok(
    messages.some((m) => m === "fatal: not a git repository: '<state>/.git' (<state>)"),
    `repo dir redacted: ${messages.join(" | ")}`,
  );
  assert.ok(
    messages.some((m) => m.includes("could not create work tree dir '<state>/workspaces/") || m.includes("could not create work tree dir '<state>/")),
    `clone failure recorded and redacted: ${messages.join(" | ")}`,
  );
  store.close();
});
