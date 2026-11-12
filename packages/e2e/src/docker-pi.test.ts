import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv } from "@pomtree/harness-pi";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { Daemon, LocalOrchestrator, listen, listenAgents, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../pomtreed/src/channels.ts";
import { openStore } from "@pomtree/store-sqlite";
import { DirReportStore } from "@pomtree/report-dir";
import { GitWorkspace } from "@pomtree/workspace-git";
import { startLiveModel } from "./live-model.ts";
import { SECRET, gitRepo, tmp } from "./harness.ts";
import { join } from "node:path";
import { gateExecFileSync, gateSandboxDeps, runtimeSkip } from "../../sandbox-docker/src/docker-gate.ts";

const ok = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
};

const engineOk = (args: string[]) => {
  try {
    gateExecFileSync(args, { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
};

// Needs a running Docker daemon, `pi` on PATH, and an agent image that contains Pi (PTREE_E2E_IMAGE).
function skipReason(): string | false {
  const early = runtimeSkip("docker daemon unreachable");
  if (early) return early;
  const missing: string[] = [];
  if (!engineOk(["info"])) missing.push("docker daemon unreachable");
  if (!ok("pi", ["--version"])) missing.push("pi not usable");
  if (!process.env.PTREE_E2E_IMAGE) missing.push("PTREE_E2E_IMAGE unset");
  for (const k of ["POMTREED_PI_PROVIDER", "PTREE_E2E_MODEL_BASE_URL", "POMTREED_MODEL_UPSTREAM_KEY_FILE"]) {
    if (!process.env[k]) missing.push(`${k} unset (the model proxy needs it)`);
  }
  return missing.length ? missing.join("; ") : false;
}

// Optional PROVIDER/ID pin (split at the first slash; model ids may contain slashes).
const pin = (() => {
  const m = process.env.PTREE_E2E_MODEL ?? "";
  const slash = m.indexOf("/");
  return slash > 0 && slash < m.length - 1 ? { provider: m.slice(0, slash), id: m.slice(slash + 1) } : undefined;
})();

test("real Docker + Pi: one agent runs through pomtreed", { skip: skipReason(), timeout: 180000 }, async () => {
  const stateDir = tmp("state");
  const repo = gitRepo();
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const workspace = new GitWorkspace({ repoDir: repo, mirrorDir: join(stateDir, "mirror.git"), foldersRoot: join(stateDir, "workspaces") });
  const { placement, sandbox } = wireLocalHost({
    hostId: "h1",
    hosts: store.hosts,
    workspace,
    sessionRoot: join(stateDir, "sessions"),
    image: process.env.PTREE_E2E_IMAGE!,
    capacity: { maxSessions: 1 },
    makeSandbox: (mounts) => new DockerSandbox({ mounts, ...gateSandboxDeps() }),
  });
  const orchestrator = new LocalOrchestrator();
  const live = await startLiveModel({
    store,
    secret: SECRET,
    stateDir,
    provider: process.env.POMTREED_PI_PROVIDER,
    env: { ...process.env, POMTREED_MODEL_BASE_URL: process.env.PTREE_E2E_MODEL_BASE_URL },
  });
  let apiUrl: string | undefined;
  const socketPath = join(stateDir, "pomtreed.sock");
  const daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: process.env.PTREE_E2E_IMAGE!,
    sandboxSocketPath: "/run/pomtreed.sock",
    untemplatedEgress: "registry", // main.ts states it (boot refuses unset); registry keeps untemplated spawns reaching package registries
    socketHostPath: socketPath,
    // PTREE_E2E_MODEL=PROVIDER/ID (set by scripts/run-e2e-tests.sh) pins the model; unset keeps the daemon default.
    command: (task) => (pin ? piArgv({ prompt: task, provider: pin.provider, model: pin.id }) : piArgv({ prompt: task })),
    agentApiUrl: () => apiUrl,
    rootBudgetMicros: 10_000_000,
    defaultBudgetMicros: 1_000_000,
    graceMs: 10_000,
    admitRetryMs: 200,
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox,
    workspace,
    harness: createPiHarness({ sink: (agent) => fileTailSource(join(stateDir, "sessions", agent, PI_SINK_FILE)) }),
    credentials: live.credentials,
    gateway: live.gateway,
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: join(stateDir, "sessions"),
    terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry }),
    reportMaxBytes: 8 * 1024 * 1024,
    placement,
    orchestrator,
  });
  const server = await listen(daemon, socketPath);
  const agents = await listenAgents(daemon, "127.0.0.1", 0);
  apiUrl = `http://host.docker.internal:${agents.port}`;
  try {
    const root = await daemon.root();
    const a = await daemon.spawn(root.id, { name: "hi", task: "Reply with the single word: hi", idempotencyKey: "pi1", ...(pin && { model: pin }) });
    await orchestrator.idle();
    const ev = await daemon.events({ agent: a.id });
    const assistant = ev.filter((e) => e.payload.kind === "message" && e.payload.role === "assistant");
    assert.ok(assistant.length > 0, "expected an assistant message in the journal");
    const rec = (await daemon.get(a.id))!;
    assert.equal(rec.state, "reaped");
    assert.equal(rec.exit, "succeeded");
  } finally {
    server.close();
    agents.server.close();
    await live.close();
    store.close();
  }
});
