import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_DEFAULTS, type Template, type TemplateStore } from "@pomtree/core";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource } from "@pomtree/harness-pi";
import { Daemon, LocalOrchestrator, listen, listenAgents, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../pomtreed/src/channels.ts";
import { DirReportStore } from "@pomtree/report-dir";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { GitWorkspace } from "@pomtree/workspace-git";
import { gateEngine, gateExecFileSync, gateSandboxDeps, runtimeSkip } from "../../sandbox-docker/src/docker-gate.ts";
import { agentBindPlan, detectBridgeGateway } from "../../pomtreed/src/agent-net.ts";
import { harnessArgv } from "../../pomtreed/src/harness-argv.ts";
import { browseToolViolation, startModelStub } from "../../../examples/hn-digest/content-live-stub.mts";
import { SECRET, gitRepo } from "./harness.ts";
import { SANDBOX_BACKEND_ENV, startLiveModel } from "./live-model.ts";

// No-spend Docker smoke of the `browse` allowlist profile: the REAL agent image runs a REAL Pi, launched through
// pomtreed's own harnessArgv for a `browse` template, against a local stub upstream behind the real key-issuing proxy; the stub records the
// model request, whose declared tools must be exactly `web_fetch`. Nothing is spent and no page is fetched. Modelled on the analyst's smoke
// (examples/hn-digest/content-live-smoke.test.mts).
//
// Run: AGENT_IMAGE_TAG=pomtree/agent:smoke-<sha> node packages/agent-image/scripts/build.ts, then
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=pomtree/agent:smoke-<sha> node --test packages/e2e/src/docker-browse-smoke.test.ts
const image = process.env.PTREE_E2E_IMAGE;
const PROVIDER = "openrouter";
const MODEL = "anthropic/claude-haiku-5.5";

function dockerSkip(): string | false {
  const early = runtimeSkip("docker daemon unreachable");
  if (early) return early;
  if (!image) return "PTREE_E2E_IMAGE unset";
  try {
    gateExecFileSync(["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
  } catch {
    return `${image} unavailable (engine unreachable or image not built; this test never pulls)`;
  }
  return false;
}

const browse: Template = {
  id: "browse",
  provider: PROVIDER,
  model: MODEL,
  allowlist: "browse",
  extensions: ["web_fetch"],
  egress: { kind: "allowlist", hosts: ["example.com"] },
  budgetMicros: 200_000,
};
const templates: TemplateStore = {
  resolve: async (id) => structuredClone(id === browse.id ? browse : null),
  list: async () => [structuredClone(browse)],
};

test("smoke: a real Pi in a `browse` template's container declares exactly web_fetch to the model", { skip: dockerSkip(), timeout: 240_000 }, async () => {
  // Unix socket paths must stay short, so the state dir lives directly under the OS temp dir.
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "brs-")));
  const catalog = mkdtempSync(join(tmpdir(), "brs-cat-"));
  // The shape of the real catalog entry: Pi speaks anthropic-messages and requests /v1/messages relative to this baseUrl.
  const entry = {
    id: MODEL,
    type: "chat",
    api: "anthropic-messages",
    baseUrl: "https://openrouter.ai/api",
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  };
  writeFileSync(join(catalog, `${PROVIDER}.json`), JSON.stringify({ "anthropic-messages": { [`chat:${MODEL}`]: entry } }));
  const stub = await startModelStub({ respond: () => ({ kind: "text", text: "done" }), servePaths: ["/api/v1/messages"] });
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const sessionRoot = join(stateDir, "sessions");
  const egressAuditRoot = join(stateDir, "egress-audit");
  mkdirSync(egressAuditRoot, { recursive: true, mode: 0o700 });
  const workspace = new GitWorkspace({ repoDir: gitRepo(), mirrorDir: join(stateDir, "mirror.git"), foldersRoot: join(stateDir, "workspaces") });
  const { placement, sandbox } = wireLocalHost({
    hostId: "h1",
    hosts: store.hosts,
    workspace,
    sessionRoot,
    image: image!,
    capacity: { maxSessions: 1 },
    makeSandbox: (mounts) => new DockerSandbox({ mounts, egressAuditRoot, ...gateSandboxDeps() }),
  });
  const orchestrator = new LocalOrchestrator();
  const keyFile = join(stateDir, "upstream.key"); // the key as pomtreed takes it: a mode-0600 file, removed with stateDir
  writeFileSync(keyFile, "stub-upstream-key", { mode: 0o600 });
  const live = await startLiveModel({
    store,
    secret: SECRET,
    stateDir,
    provider: PROVIDER,
    env: {
      [SANDBOX_BACKEND_ENV]: gateEngine().profile.id,
      POMTREED_PI_CATALOG_DIR: catalog,
      POMTREED_MODEL_BASE_URL: `${new URL(stub.baseUrl).origin}/api`,
      POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile,
    },
  });
  let apiUrl: string | undefined;
  const socketPath = join(stateDir, "pomtreed.sock");
  const daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    fetchUserAgent: CONFIG_DEFAULTS["workflow.fetch.userAgent"], // the resolved value main.ts passes, at the registry default
    image: image!,
    sandboxSocketPath: "/run/pomtreed.sock",
    untemplatedEgress: "registry", // main.ts states it (boot refuses unset); registry keeps untemplated spawns reaching package registries
    socketHostPath: socketPath,
    command: (task, spec) =>
      harnessArgv(task, { provider: PROVIDER, model: MODEL, ...(spec?.allowlist && { allowlist: spec.allowlist }) }, { steerExt: true, jobsExt: false }),
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
    harness: createPiHarness({ sink: (agent) => fileTailSource(join(sessionRoot, agent, PI_SINK_FILE)) }),
    credentials: live.credentials,
    gateway: live.gateway,
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot,
    terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
    escalations: store.escalations,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry }),
    reportMaxBytes: 8 * 1024 * 1024,
    placement,
    orchestrator,
    templates,
    mayUseTemplate: () => true,
    models: { list: async () => ({ source: "pi", models: [{ provider: PROVIDER, id: MODEL }] }) },
  });
  const server = await listen(daemon, socketPath);
  // Bind where pomtreed binds its agent endpoint (loopback on Docker Desktop, the bridge gateway on Linux); containers use host.docker.internal.
  const { profile } = gateEngine();
  const plan = await agentBindPlan(
    process.platform,
    () => detectBridgeGateway(async (_binary, a) => gateExecFileSync(a, { timeout: 10_000 }), false, profile),
    profile,
  );
  const agents = await listenAgents(daemon, plan.host, 0);
  apiUrl = `http://host.docker.internal:${agents.port}`;
  try {
    const root = await daemon.root();
    const reader = await daemon.spawn(root.id, {
      name: "reader",
      task: "Say done.",
      idempotencyKey: "browse-smoke",
      template: "browse",
      requireAllowlist: "browse",
    });
    // A browse worker has no result tool, so its Pi session idles after the reply and never exits on its own: wait for the first completion, then stop it.
    const completionsOf = () => stub.requests.filter((r) => /\/messages$/.test(r.url.split("?")[0] ?? r.url));
    for (const deadline = Date.now() + 120_000; completionsOf().length === 0 && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 250));
    await daemon.kill(reader.id, "browse-smoke-kill");
    await orchestrator.idle();
    const completions = completionsOf();
    assert.ok(completions.length >= 1, `stub saw no completion request: ${JSON.stringify(stub.requests.map((r) => [r.method, r.url]))}`);
    for (const r of completions) assert.equal(browseToolViolation(r.body), null, "the browse worker's request declares exactly web_fetch");
  } finally {
    server.close();
    agents.server.close();
    await live.close();
    await stub.close();
    store.close();
    for (const d of [stateDir, catalog]) rmSync(d, { recursive: true, force: true });
  }
});
