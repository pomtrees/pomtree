// Live demo: one root agent drafts chapter 1 of a book by spawning two helpers. Spends real money.
// Run: POMTREED_LIVE=1 POMTREED_PI_PROVIDER=... POMTREED_MODEL_BASE_URL=... POMTREED_MODEL_UPSTREAM_KEY_FILE=<0600 key file> node packages/e2e/src/demo/chapters.ts
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource, piArgv } from "@pomtree/harness-pi";
import { Daemon, LocalOrchestrator, listen, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../../pomtreed/src/channels.ts";
import { startLiveModel } from "../live-model.ts";
import { listenAgentEndpoint } from "./agent-endpoint.ts";
import { agentHeadsPrefix } from "@pomtree/workspace-git";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { openStore } from "@pomtree/store-sqlite";
import { DirReportStore } from "@pomtree/report-dir";
import { demoWorkspace } from "./demo-workspace.ts";
import { OUTLINE, REFUSAL, ROOT_TASK, describePlan, formatReport, formatTree, parseAgentRefs } from "./chapters-text.ts";

const env = process.env;
const timeoutMs = Number(env.POMTREED_DEMO_TIMEOUT_MS ?? 600_000);
const budgetMicros = Number(env.POMTREED_BUDGET_ROOT_MICROS ?? 2_000_000);
const image = env.POMTREED_AGENT_IMAGE ?? "pomtree/agent:dev";

console.log(
  describePlan({
    provider: env.POMTREED_PI_PROVIDER ?? "(unset; POMTREED_PI_PROVIDER is required)",
    image,
    budgetMicros,
    timeoutMs,
  }),
);
if (env.POMTREED_LIVE !== "1") {
  console.error(`\n${REFUSAL}`);
  process.exit(2);
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@pomtree", ...a], { cwd, encoding: "utf8" }).trim();

const tempDir = mkdtempSync(join(tmpdir(), "pomtree-demo-"));
const repo = join(tempDir, "repo");
const stateDir = join(tempDir, "state");
mkdirSync(repo);
mkdirSync(stateDir, { mode: 0o700 });
git(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "outline.md"), OUTLINE);
git(repo, "add", "outline.md");
git(repo, "commit", "-q", "-m", "outline");

const secret = randomBytes(32).toString("hex");
const socketPath = join(stateDir, "pomtreed.sock");
const store = openStore(join(stateDir, "pomtreed.sqlite"));
const workspace = demoWorkspace({ repoDir: repo, stateDir });
const provider = env.POMTREED_PI_PROVIDER; // required (startLiveModel refuses without it)
const model = env.POMTREED_DEMO_MODEL ?? "deepseek-flash"; // optional; the resolved spec model each key allows
const live = await startLiveModel({ store, secret, stateDir, provider, env });
let apiUrl: string | undefined;
const { placement, sandbox } = wireLocalHost({
  hostId: "demo",
  hosts: store.hosts,
  workspace,
  sessionRoot: join(stateDir, "sessions"),
  image,
  capacity: { maxSessions: 4 },
  makeSandbox: (mounts) => new DockerSandbox({ mounts }),
});
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
  defaultBudgetMicros: Math.floor(budgetMicros / 4),
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
  reportStore: new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry }),
  reportMaxBytes: 8 * 1024 * 1024,
  placement,
  orchestrator: new LocalOrchestrator(),
});
placement.onAdmit((agent) => daemon.admitted(agent));
const server = await listen(daemon, socketPath);
const endpoint = await listenAgentEndpoint(daemon);
apiUrl = endpoint.apiUrl;
daemon.startWatchers();

let exitCode = 0;
try {
  const top = await daemon.root();
  const root = await daemon.spawn(top.id, { name: "author", task: ROOT_TASK, idempotencyKey: "chapters-root" });
  // waitDone caps each call at 30s, so poll until the deadline.
  const deadline = Date.now() + timeoutMs;
  let waited = await daemon.waitDone(root.id, timeoutMs);
  while (!waited.done && Date.now() < deadline) waited = await daemon.waitDone(root.id, deadline - Date.now());
  if (!waited.done) {
    exitCode = 1;
    await daemon.cancel(root.id, 10_000).catch(() => {});
  }
  const record = (await daemon.get(root.id))!;
  const agents = (await daemon.list()).filter((a) => a.id !== top.id);
  // Ingested agent refs land in the daemon's bare mirror, never in the operator's source repo.
  const mirror = join(stateDir, "mirror.git");
  const branches = parseAgentRefs(git(mirror, "for-each-ref", "refs/agents/", "--format=%(refname) %(objectname)"));
  let chapterPath: string | null = null;
  try {
    const chapter = git(mirror, "show", `${agentHeadsPrefix(root.id)}agent/${root.id}:chapter1.md`);
    chapterPath = join(tempDir, "chapter1.md");
    writeFileSync(chapterPath, `${chapter}\n`);
  } catch {
    exitCode = 1;
  }
  console.log(
    `\n${formatReport({
      result: record.result ?? null,
      tree: formatTree(
        agents.map((a) => ({ id: a.id, name: a.name, parent: a.parent === top.id ? null : (a.parent ?? null), state: a.state, exit: a.exit })),
        root.id,
      ),
      branches,
      chapterPath,
      tempDir,
      timedOut: !waited.done,
    })}`,
  );
} catch (e) {
  exitCode = 1;
  console.error(`demo failed: ${e instanceof Error ? e.message : String(e)}`);
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
