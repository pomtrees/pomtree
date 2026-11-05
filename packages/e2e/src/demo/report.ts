// Live demo: one root agent writes a short markdown file and publishes it as a report. Spends real money.
// Run: POMTREED_LIVE=1 POMTREED_PI_PROVIDER=... POMTREED_MODEL_BASE_URL=... POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/report.ts
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv } from "@pomtree/harness-pi";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { Daemon, LocalOrchestrator, listen, wireLocalHost } from "@pomtree/pomtreed";
import { createReportsExtension } from "../../../pomtreed/src/builtin/reports.ts";
import { buildChannelRegistry } from "../../../pomtreed/src/channels.ts";
import { createExtensionRegistry } from "../../../pomtreed/src/extensions.ts";
import { startLiveModel } from "../live-model.ts";
import { listenAgentEndpoint } from "./agent-endpoint.ts";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { DirReportStore } from "@pomtree/report-dir";
import { demoWorkspace } from "./demo-workspace.ts";

const env = process.env;
const timeoutMs = Number(env.POMTREED_DEMO_TIMEOUT_MS ?? 600_000);
const budgetMicros = Number(env.POMTREED_BUDGET_ROOT_MICROS ?? 2_000_000);
const image = env.POMTREED_AGENT_IMAGE ?? "pomtree/agent:dev";

const TASK = `Create a short markdown report at /workspace/report.md: a level-1 heading and one or two sentences of body text.
Then publish it by running exactly:
  pomtree report publish /workspace/report.md --name chapter-report --media-type text/markdown
Then confirm completion by running:
  pomtree result '{"published":"chapter-report"}'`;

console.log(`pomtree report demo: this will make LIVE model calls and spend real money.
  provider:   ${env.POMTREED_PI_PROVIDER ?? "(unset; POMTREED_PI_PROVIDER is required)"}
  image:      ${image}
  budget cap: $${(budgetMicros / 1_000_000).toFixed(2)}
  timeout:    ${Math.round(timeoutMs / 1000)}s
  steps:      temp git repo, one root agent that writes and publishes report.md`);
if (env.POMTREED_LIVE !== "1") {
  console.error("\nrefusing to run: set POMTREED_LIVE=1 to confirm this makes live model calls and spends real money.");
  process.exit(2);
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@pomtree", ...a], { cwd, encoding: "utf8" }).trim();

const tempDir = mkdtempSync(join(tmpdir(), "pomtree-report-"));
const repo = join(tempDir, "repo");
const stateDir = join(tempDir, "state");
mkdirSync(repo);
mkdirSync(stateDir, { mode: 0o700 });
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "seed.md"), "# seed\n");
git(repo, "add", "seed.md");
git(repo, "commit", "-q", "-m", "seed");

const secret = randomBytes(32).toString("hex");
const socketPath = join(stateDir, "pomtreed.sock");
const store = openStore(join(stateDir, "pomtreed.sqlite"));
const workspace = demoWorkspace({ repoDir: repo, stateDir });
const provider = env.POMTREED_PI_PROVIDER; // required (startLiveModel refuses without it)
const model = env.POMTREED_DEMO_MODEL ?? "deepseek-flash"; // optional; the resolved spec model each key allows
const reportStore = new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry });
const live = await startLiveModel({ store, secret, stateDir, provider, env });
let apiUrl: string | undefined;
const { placement, sandbox } = wireLocalHost({
  hostId: "demo",
  hosts: store.hosts,
  workspace,
  sessionRoot: join(stateDir, "sessions"),
  image,
  capacity: { maxSessions: 1 },
  makeSandbox: (mounts) => new DockerSandbox({ mounts }),
});
// The built-in reports extension as main.ts registers it: `pomtree report publish` is a rawBody extension route.
const reportMaxBytes = CONFIG_DEFAULTS["report.maxBytes"];
const extensions = createExtensionRegistry({
  hostId: "demo",
  now: () => daemon.now(),
  registry: store.registry,
  journal: store.journal,
  mailbox: store.mailbox,
  root: () => daemon.root(),
});
extensions.registerBuiltin(createReportsExtension({ store: reportStore, reportMaxBytes }));
const daemon = new Daemon({
  hostId: "demo",
  secret,
  image,
  sandboxSocketPath: "/run/pomtreed.sock",
  untemplatedEgress: "registry", // main.ts states it (boot refuses unset); registry keeps untemplated spawns reaching package registries
  socketHostPath: socketPath,
  agentApiUrl: () => apiUrl,
  registry: store.registry,
  journal: store.journal,
  mailbox: store.mailbox,
  sandbox,
  workspace,
  harness: createPiHarness({ sink: (agent) => fileTailSource(join(stateDir, "sessions", agent, PI_SINK_FILE)) }),
  gateway: live.gateway,
  command: (task) => piArgv({ prompt: task, provider, model }),
  // The Daemon's default spec model is the one Pi is told to call, so the gateway signs it into each key's model allowlist.
  ...(provider && { provider }),
  model,
  credentials: live.credentials,
  rootBudgetMicros: budgetMicros,
  defaultBudgetMicros: Math.floor(budgetMicros / 2),
  graceMs: 10_000,
  admitRetryMs: 500,
  checkpoints: store.checkpoints,
  sessions: store.sessions,
  sessionRoot: join(stateDir, "sessions"),
  terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
  escalations: store.escalations,
  channels: buildChannelRegistry([], []),
  watchdogs: store.watchdogs,
  schedules: store.schedules,
  reportStore,
  reportMaxBytes,
  extensionHost: extensions,
  placement,
  orchestrator: new LocalOrchestrator(),
});
placement.onAdmit((agent) => daemon.admitted(agent));
const server = await listen(daemon, socketPath);
const endpoint = await listenAgentEndpoint(daemon);
apiUrl = endpoint.apiUrl;

let exitCode = 0;
try {
  const top = await daemon.root();
  const root = await daemon.spawn(top.id, { name: "author", task: TASK, idempotencyKey: "report-root" });
  const deadline = Date.now() + timeoutMs;
  let waited = await daemon.waitDone(root.id, timeoutMs);
  while (!waited.done && Date.now() < deadline) waited = await daemon.waitDone(root.id, deadline - Date.now());
  if (!waited.done) {
    exitCode = 1;
    await daemon.cancel(root.id, 10_000).catch(() => {});
    console.error("TIMED OUT waiting for the root agent; no report verified.");
  } else {
    const record = (await daemon.get(root.id))!;
    const reports = await reportStore.list(root.id);
    const report = reports.find((r) => r.name === "chapter-report") ?? null;
    if (!report) {
      exitCode = 1;
      console.error(`no "chapter-report" found; got ${reports.map((r) => r.name).join(", ") || "(none)"}`);
    } else {
      const entry = await reportStore.read(root.id, report.id);
      const content = entry ? new TextDecoder().decode(entry.content) : "";
      const okType = report.mediaType === "text/markdown";
      const okSize = report.sizeBytes > 0;
      const okContent = content.trim().length > 0;
      if (!(okType && okSize && okContent)) exitCode = 1;
      console.log(`\nreport result: agent ${root.id} ${record.exit}
  id:        ${report.id}
  name:      ${report.name}
  mediaType: ${report.mediaType}${okType ? " ✓" : " ✗ (expected text/markdown)"}
  sizeBytes: ${report.sizeBytes}${okSize ? " ✓" : " ✗ (expected > 0)"}
  sha256:    ${report.sha256}
  content:   ${okContent ? "readable text ✓" : "✗ (empty or unreadable)"}
  preview:   ${JSON.stringify(content.slice(0, 120))}`);
    }
  }
} catch (e) {
  exitCode = 1;
  console.error(`report demo failed: ${e instanceof Error ? e.message : String(e)}`);
  console.error(`temp dir: ${tempDir}`);
} finally {
  for (const s of await sandbox.list().catch(() => [])) await sandbox.kill(s.id).catch(() => {});
  for (const id of await workspace.list().catch(() => [])) await workspace.evict(id).catch(() => {});
  server.close();
  endpoint.close();
  store.close();
  rmSync(socketPath, { force: true });
  console.log(`\ncleaned up containers and worktrees; temp dir kept at ${tempDir}`);
}
process.exit(exitCode);
