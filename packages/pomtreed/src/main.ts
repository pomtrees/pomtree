#!/usr/bin/env node
// The only non-test file that imports real adapters.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, statfsSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { connect } from "node:net";
import { cpus, freemem, homedir, hostname, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { DEFAULT_CONTAINER_CPUS, DiskEgressAudit, DockerSandbox } from "@pomtree/sandbox-docker";
import { EgressAuditCollector, ingestEgressAuditSafely } from "./egress-audit.ts";
import { nearCapTransition } from "./health.ts";
import { openStateStore } from "@pomtree/store-sqlite";
import type { BackupPruneReport } from "@pomtree/store-sqlite";
import { planJournalRetention } from "@pomtree/sched";
import { wireLocalHost } from "./local-host.ts";
import { GitRepoStore, GitWorkspace, checkGitVersion } from "@pomtree/workspace-git";
import { emptyManifest } from "@pomtree/agent-image";
import { parseFreshnessRules, RootWithdrawalError, SandboxUnavailableError } from "@pomtree/core";
import { DirReportStore } from "@pomtree/report-dir";
import { DirTemplateStore } from "@pomtree/template-dir";
import { PI_AUTH_PATH, PI_SINK_FILE, PI_TTY_ENV, createPiHarness, fileTailSource } from "@pomtree/harness-pi";
import { openDaemonStore } from "./daemon-store.ts";
import { harnessArgv } from "./harness-argv.ts";
import { issueToken } from "./auth.ts";
import { buildChannelRegistry, messagingSendersError, type ChannelRegistry } from "./channels.ts";
import { accessLogMode } from "./accesslog.ts";
import { backupPruneLines, WORKSPACE_GIT_EXCLUDES } from "./daemon-util.ts";
import { Daemon, sessionDeadlineConfig } from "./daemon.ts";
import { CONFIG_EXIT, DAEMON_USAGE, fetchIdentityLine, formatConfigShow, loadDaemonConfig, parseDaemonArgv } from "./daemon-config.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { checkEgressImage } from "./image-check.ts";
import { buildVersion, gitSha, imageRevision, revisionMismatch } from "./revision.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { createExtGateway, webFetchCaptureScope, webFetchScope } from "./ext-gateway.ts";
import { wireCaptureBroker } from "./capture-wiring.ts";
import { createWiredWebFetchApproval } from "./webfetch-approval.ts";
import { createPublishResolver } from "./publish-pin.ts";
import { piModelCatalog } from "./model-catalog.ts";
import { proxyPiCredentials } from "./pi-auth.ts";
import { createModelProxyServer, ModelProxy } from "./model-proxy/service.ts";
import { openPiCatalog } from "./model-proxy/pi-catalog.ts";
import { buildModelProxyOptions, modelProxySettings, startReservationReclaim } from "./model-proxy-options.ts";
import {
  containerProbeArgs,
  containerReachable,
  firewallHint,
  detectBridgeGateway,
  planAgentListen,
  probeTarget,
  summarizeAgentEndpoint,
  unreachableMessage,
} from "./agent-net.ts";
import { autoMaxSessions, maxSessionsOf } from "./auto-sessions.ts";
import { memoryGate, memoryHolders, pinnedAgentPort, writeSecretFile } from "./host-guards.ts";
import { acquireStateLock, configureAccessLog, listen, listenAgents, listenHost, listenUi } from "./server.ts";
import { createExtensionRegistry } from "./extensions.ts";
import { scanExtensionManifests } from "./extension-manifest.ts";
import { raceUntil, sleepTick, WorkflowHost } from "./workflows.ts";
import { hostPacer } from "./host-pacer.ts";
import { WorkflowRuntimePolicy } from "./workflow-policy.ts";
import { createObserveExtension } from "./builtin/observe.ts";
import { createReportsExtension } from "./builtin/reports.ts";
import type { WorkflowCapabilityServices } from "./workflow-capabilities.ts";
import { testFetchSeam, testFetchWarning } from "./test-fetch.ts";
import { createCronExtension } from "./builtin/cron.ts";
import { resolveSocketPath } from "./socket-path.ts";
import { checkStateDir, isLoopbackListenHost, publishScanWarning, shortHash, stamp, uiChannelWarning } from "./config.ts";
import { dockerSandboxDeps } from "./sandbox-deps.ts";
import { realpathLoose, safetyBootErrors, untemplatedEgressNoneWarning } from "./safety-boot.ts";
import { formatStartupFailure } from "./startup-failure.ts";

// Until the drain handlers below are installed, an error thrown while starting prints one line (formatStartupFailure) and exits 1,
// instead of Node's default stack dump.
const onStartupFailure = (err: unknown): void => {
  for (const line of formatStartupFailure(err)) console.error(line);
  process.exit(1);
};
process.on("uncaughtException", onStartupFailure);

// Configuration: argv and the registry resolve (daemon-config.ts), once, before anything is created or bound. Every refusal
// prints one line per error and exits CONFIG_EXIT; `pomtreed config show` resolves the same way and prints instead of starting.
const argv = parseDaemonArgv(process.argv.slice(2));
if (!argv.ok) {
  for (const e of argv.errors) console.error(`pomtreed: ${e}`);
  console.error(DAEMON_USAGE);
  process.exit(CONFIG_EXIT);
}
if (argv.args.command === "help") {
  console.log(DAEMON_USAGE);
  process.exit(0);
}
if (argv.args.command === "version") {
  console.log(buildVersion());
  process.exit(0);
}
// Optional setup aids (onboard/): resolved before the config load because they run on a host that has no valid config yet.
if (argv.args.command === "preflight" || argv.args.command === "init") {
  const { runOnboardCommand } = await import("./onboard/cli.ts");
  process.exit(await runOnboardCommand(argv.args.command, argv.args.rest ?? []));
}
const loaded = loadDaemonConfig({
  env: process.env,
  args: { ...argv.args, ...(argv.args.configFile !== undefined && { configFile: resolvePath(argv.args.configFile) }) },
  readFile: (path) => readFileSync(path, "utf8"),
  // POSIX modes only: win32 reports a synthetic 0666 for every file, which would refuse every secret.
  ...(process.platform !== "win32" && { fileMode: (path: string) => statSync(realpathSync(path)).mode }),
  defaultStateDir: join(homedir(), ".pomtreed"),
  scanExtensions: scanExtensionManifests,
});
if (!loaded.ok) {
  for (const e of loaded.errors) console.error(`pomtreed: config: ${e}`);
  process.exit(CONFIG_EXIT);
}
if (argv.args.command === "config-show") {
  console.log(formatConfigShow(loaded, { origin: argv.args.origin, json: argv.args.json }));
  process.exit(0);
}
const cfg = loaded.config;
const stateDir = cfg["state.dir"] || join(homedir(), ".pomtreed");
const socket = resolveSocketPath(cfg["socket.path"] || join(stateDir, "pomtreed.sock"), tmpdir());
const socketPath = socket.path;
const sessionDeadline = sessionDeadlineConfig({ defaultSessionMs: cfg["session.defaultMs"], maxSessionMs: cfg["session.maxMs"] });
if (!sessionDeadline) throw new Error("session deadline policy is required");
const hostId = cfg["host.id"] || hostname();
// Inbound messaging channels, each getting a host token file. The escalation channel is where asks/alerts go OUT (it is also
// accepted for inbound answers): an ordered list; root broadcasts to every one (defaults to the in-daemon operator UI).
const messagingChannels = [...cfg["messaging.channels"]];
const escalationChannels = [...cfg["escalation.channels"]];
// The channel registry (channels.ts): built ONCE here; ui, the operator token (cli) and every adapter are entries of one type.
let channels: ChannelRegistry;
try {
  channels = buildChannelRegistry(messagingChannels, escalationChannels);
} catch (e) {
  console.error(`pomtreed: refusing to start: ${(e as Error).message}`);
  process.exit(1);
}
// Sender allowlist for inbound chat messages (TODO(msg-authz)): POMTREED_MESSAGING_SENDERS="channel:sender,..." scopes who may answer,
// signal, spawn or cancel. FAIL CLOSED: any enabled chat-rank channel with it unset/empty refuses to start; zero channels,
// `ui`-only and operator-only configs need none. Access control owned by its operator, deliberately not a registry key
// (core config/exclusions.ts), so it is read from the env here.
const messagingSenders = new Set(
  (process.env.POMTREED_MESSAGING_SENDERS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const sendersError = messagingSendersError(channels, messagingSenders);
if (sendersError) {
  console.error(sendersError);
  process.exit(1);
}
// "off" disables the agent TCP endpoint (agents then mount the unix socket); otherwise host:port, port 0 = ephemeral.
// Default (TODO(agent-endpoint)): Linux binds the docker bridge gateway (+ loopback), others loopback; see agent-net.ts.
// Planned before the safety check below: an explicit non-loopback host is compared with the detected gateway (detection is cached).
const dockerExec = (cmd: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 5000 }, (e, out) => (e ? rej(e) : res(out))));
const agentListenCfg = cfg["agent.listen"] === "" ? undefined : cfg["agent.listen"];
// An explicit host is gateway-independent in the plan, so it shows whether detection is needed.
const explicitListen = planAgentListen({ listen: agentListenCfg, platform: process.platform, gateway: undefined });
const needGateway =
  process.platform === "linux" && (agentListenCfg === undefined || (explicitListen.mode === "explicit" && !isLoopbackListenHost(explicitListen.host)));
const agentGateway = needGateway ? await detectBridgeGateway(dockerExec) : undefined;
const agentPlan = planAgentListen({ listen: agentListenCfg, platform: process.platform, gateway: agentGateway });
// Dangerous silent defaults refuse the start (TODO(safety-defaults)): every violation is listed at once, before any state is created.
// No merge check runner is wired (TODO(merge-checks)).
// Agent-writable host paths (self-modification guard): the workspace clones, the session dirs, the per-agent Pi dirs, the env layer cache and the daemon socket.
const safetyErrors = safetyBootErrors(cfg, {
  checkRunnerWired: false,
  agentListen: agentPlan,
  bridgeGateway: agentGateway,
  loadDirs: {
    templates: realpathLoose(cfg["templates.dir"] || join(stateDir, "templates")),
    extensions: realpathLoose(loaded.extensionsDir),
  },
  agentWritable: [
    { key: "state.dir", path: realpathLoose(join(stateDir, "workspaces")) },
    { key: "state.dir", path: realpathLoose(join(stateDir, "agents")) },
    { key: "session.dir", path: realpathLoose(cfg["session.dir"] || join(stateDir, "sessions")) },
    { key: "envCache.dir", path: realpathLoose(cfg["envCache.dir"] || join(stateDir, "env-cache")) },
    { key: "socket.path", path: realpathLoose(socketPath) },
  ],
});
if (safetyErrors.length > 0) {
  for (const e of safetyErrors) console.error(e);
  process.exit(1);
}
{
  const noneWarn = untemplatedEgressNoneWarning(cfg["agent.untemplatedEgress"]);
  if (noneWarn) console.error(noneWarn);
}
// After every boot refusal (POMTREED_MESSAGING_SENDERS and the safety checks above), so a refused start leaves no directory.
if (socket.fellBack) {
  console.error(`pomtreed: socket path too long for the OS limit; using ${socketPath} (clients: set POMTREE_SOCKET to it)`);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
}
const minDiskFreeBytes = cfg["capacity.minDiskFreeBytes"];
const maxContainers = cfg["capacity.maxContainers"];
const containerMemoryBytes = cfg["capacity.containerMemoryBytes"];
const memFraction = cfg["capacity.memoryFraction"];

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
{
  // mkdir's mode applies only on creation: a pre-existing 0755 dir would leave the DB/journal world-readable (S3).
  const real = realpathSync(stateDir);
  const st = statSync(real);
  const check = checkStateDir(real, { isDirectory: st.isDirectory(), uid: st.uid, mode: st.mode }, process.getuid?.());
  if (check.chmod) chmodSync(real, 0o700);
}
// Single-instance guard: an O_EXCL pidfile so a second pomtreed cannot claim the
// same state dir (and, via recover(), kill the first's containers). Released only if it still names us.
const releaseStateLock = acquireStateLock(stateDir);
const secretFile = join(stateDir, "secret");
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const secret = readFileSync(secretFile, "utf8").trim();
// Stable id of this state dir's store, stamped on every container; created once.
const storeIdFile = join(stateDir, "store-id");
if (!existsSync(storeIdFile)) writeFileSync(storeIdFile, randomBytes(8).toString("hex"), { mode: 0o600 });
const storeId = readFileSync(storeIdFile, "utf8").trim();
writeSecretFile(join(stateDir, "operator.token"), issueToken(secret, { scope: "operator" }));
// A host token per adapter channel (messaging plus escalation: answers come back over it). In-daemon and operator channels
// (ui, cli) have no adapter to hold one: the operator cookie/token is their credential.
for (const entry of channels.entries()) {
  if (entry.kind !== "adapter") continue;
  writeSecretFile(join(stateDir, `messaging.${entry.name}.token`), issueToken(secret, { scope: "host", channel: entry.name }));
}

// Operator state policy, parsed before the stores open (limits are a state store option); a malformed value refuses the start.
const statePolicy = loaded.statePolicy;
// Backup retention after a migrating open: one stderr line per backup kept, removed or not removed (backupPruneLines).
const logBackupPrune = (db: string) => (r: BackupPruneReport) => {
  for (const line of backupPruneLines(db, r)) console.error(line);
};
// openDaemonStore traces the store's journal (trace-context.ts), so every writer handed `journal` stamps each entry's trace context.
const stores = openDaemonStore(join(stateDir, "pomtreed.sqlite"), { onBackupPrune: logBackupPrune("pomtreed.sqlite") });
// durable-quota: one store-backed counter set (SPEC rule 6) for web_fetch caps, workflow fetch budgets and host pacing.
const quota = stores.quotaCounters();
const journal = stores.journal;
// Workflow state has its own file next to the production one, so standalone tools can open it without touching pomtreed.sqlite.
const stateDb = openStateStore(join(stateDir, "state.sqlite"), {
  stateLimits: statePolicy.limitsFor,
  generationOf: stores.generationOf,
  onBackupPrune: logBackupPrune("state.sqlite"),
});
const reportsDir = cfg["report.dir"] || join(stateDir, "reports");
const reportStore = new DirReportStore({ root: reportsDir, registry: stores.registry });
const reportMaxBytes = cfg["report.maxBytes"];
const templatesDir = cfg["templates.dir"] || join(stateDir, "templates");
const templates = new DirTemplateStore({ root: templatesDir });
const repoDir = cfg["repo.dir"] || process.cwd();
// Each agent works in a private full clone under <stateDir>/workspaces; the controller keeps one bare mirror (<stateDir>/mirror.git)
// fetched from repo.dir. Work crosses only as a bundle through Workspace.ingest (POST /v1/agents/:id/push).
const pushMaxBytes = cfg["push.maxBytes"];
// Folder retention (cleanup sweep): paused agents idle past folder.retentionMs lose their folder (0 = never); reaped agents'
// folders are kept folder.reapedGraceMs; below folder.minFreeBytes of free disk (0 = off) the remaining reaped folders go oldest first.
const folderIdleMs = cfg["folder.retentionMs"];
const folderReapedGraceMs = cfg["folder.reapedGraceMs"];
const folderMinFreeBytes = cfg["folder.minFreeBytes"];
const foldersRoot = join(stateDir, "workspaces");
const workspace = new GitWorkspace({ repoDir, mirrorDir: join(stateDir, "mirror.git"), foldersRoot, infoExclude: WORKSPACE_GIT_EXCLUDES });
{
  const gv = await checkGitVersion();
  if (gv.warning) console.error(`pomtreed: warning: ${gv.warning}`);
}
// Merge engine over the mirror. The mirror is created on first use, so refresh it now (best-effort: an unreachable operator
// repo leaves merging off with a log line, not a dead daemon). The repo's default branch is the operator repo's HEAD branch.
// merge.deny: the denylist of repo-relative path prefixes (default DEFAULT_DENIED_PATHS; empty = no denylist; a list REPLACES the
// default). Engine messages are redacted through the daemon before they are stored or shown.
// TODO(merge-checks): the check runner (throwaway no-network container) is not wired; boot refuses to start while merge.check is set (safety-boot.ts), so no merge runs a check.
const mirrorDir = join(stateDir, "mirror.git");
let defaultBranch = cfg["repo.defaultBranch"] || "main";
let repos: GitRepoStore | undefined;
try {
  await workspace.refreshMirror();
  if (cfg["repo.defaultBranch"] === "")
    defaultBranch =
      execFileSync("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      defaultBranch;
  repos = new GitRepoStore({
    mirrorDir,
    host: hostId,
    merges: stores.merges,
    redact: (t: string) => daemon.redactText(t),
    repo: {
      id: `repo-${createHash("sha256").update(realpathSync(repoDir)).digest("hex").slice(0, 12)}`,
      name: repoDir.split("/").filter(Boolean).at(-1) ?? "repo",
      defaultBranch,
      policy: {
        deniedPaths: [...cfg["merge.deny"]],
        check: cfg["merge.check"].trim() ? cfg["merge.check"].trim().split(/\s+/) : null,
      },
    },
  });
} catch (e) {
  console.error(`pomtreed: merging is off (pomtree merge answers 503): ${e instanceof Error ? e.message : String(e)}`);
}
const diskFreeBytes = async (): Promise<number | null> => {
  try {
    const st = statfsSync(foldersRoot);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
};
// Per-agent session JSONL files live outside the git worktrees; bind-mounted into each sandbox.
const sessionRoot = cfg["session.dir"] || join(stateDir, "sessions");
mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
// Interactive pi on a TTY: structured events are tail-followed from the sink file in the agent's session dir.
const harness = createPiHarness({ sink: (agent) => fileTailSource(join(sessionRoot, agent, PI_SINK_FILE)) });

// The durable single-owner debit/revocation store shared by the proxy gateway and the proxy server:
// authorize/revoke and reserve/settle consult the same transactional tables.
const modelDebits = stores.modelDebit({ secret });
const proxySettings = modelProxySettings(cfg);
const { upstreamTimeoutMs, tokenTtlMs: proxyTokenTtlMs } = proxySettings;
const modelProxyPort = cfg["model.proxy.port"];
// Containers reach the proxy through the host-gateway alias; the server binds the bridge gateway later.
const proxyBaseUrl = `http://host.docker.internal:${modelProxyPort}`;

// The provider the scoped proxy credential is written for (required by the config resolver, never inferred).
const proxyProvider = cfg["pi.provider"];
// Token prices come from Pi's own catalog (never operator-entered). A missing catalog is not fatal: every request then
// charges the provider-reported cost or the per-request maximum (fail closed), and zero-cost usage events stay unpriced.
const catalog = openPiCatalog(process.env, proxyProvider, homedir(), cfg["pi.catalogDir"]);
console.error(catalog.message);
// The controller-side model proxy is the only model path: the daemon issues per-agent scoped credentials and the
// proxy forwards through the durable debit/revocation store, so spend is a restart-safe hard cap.
const gateway = new ProxyCredentialGateway({
  journal,
  registry: stores.registry,
  secret,
  proxyBaseUrl,
  tokenTtlMs: proxyTokenTtlMs,
  sessionMaxMs: sessionDeadline.maxSessionMs,
  debits: modelDebits,
  catalog: { provider: proxyProvider, source: catalog.rates },
});
const agentListen = agentPlan.mode === "off" ? "off" : `${agentPlan.host}:${agentPlan.port}`;
let agentApiUrl: string | undefined;
let agentPort = 0;
let agentBound: string[] = []; // hosts actually bound
let containerProbe: boolean | undefined; // startup probe from a container's network perspective (Linux default plan only)
// The gateway for reachability analysis even when an explicit agent.listen skipped detection.
const reachGateway = async () => agentGateway ?? (process.platform === "linux" ? await detectBridgeGateway(dockerExec) : undefined);
const agentEndpointStatus = async () => {
  const gateway = await reachGateway();
  const target = probeTarget({ platform: process.platform, boundHosts: agentBound, gateway });
  const hostProbe = await new Promise<boolean>((resolve) => {
    const sock = connect({ host: target, port: agentPort }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(2000, () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => resolve(false));
  });
  return summarizeAgentEndpoint({
    platform: process.platform,
    boundHosts: agentBound,
    port: agentPort,
    apiUrl: agentApiUrl ?? "",
    gateway,
    hostProbe,
    containerProbe,
    hostUid: process.getuid?.() ?? undefined,
  });
};
const sandboxSocketPath = cfg["sandbox.socket"];
// Operator browser UI and host (messaging adapter; host-scoped tokens, /v1/messages only) TCP endpoints: "off" (default) or
// host:port, parsed and loopback-checked by loadDaemonConfig (null = off).
const uiListen = cfg["ui.listen"];
const uiSpec = loaded.uiSpec;
const hostSpec = loaded.hostSpec;
// Access log (one line per request on stdout): accessLog.mode; auto = all on a TTY, else errors.
const accessLog = accessLogMode(cfg["accessLog.mode"], process.stdout.isTTY === true);
configureAccessLog(accessLog);

// Environment layer cache (TODO(env)): layers are `<cacheRoot>/<manifestHash>`, created by the daemon at
// spawn. cacheRoot is realpathed because mountPlan is pure and resolves nothing.
const envCacheRoot = cfg["envCache.dir"] || join(stateDir, "env-cache");
mkdirSync(envCacheRoot, { recursive: true, mode: 0o700 });
const envCacheRootReal = realpathSync(envCacheRoot);

// Session cap: `auto` (default; computed once from host resources) or a positive integer (checked by the registry).
const maxSessions = maxSessionsOf(cfg["capacity.maxSessions"], () =>
  autoMaxSessions({
    cpus: cpus().length,
    memTotalBytes: totalmem(),
    memFreeBytes: freemem(),
    containerMemBytes: containerMemoryBytes,
    containerCpus: DEFAULT_CONTAINER_CPUS,
    memFraction,
    maxContainers,
  }),
);
console.log(
  maxSessions.mode === "auto"
    ? `max sessions: auto \u2192 ${maxSessions.value} (cpus=${cpus().length}, ram=${(totalmem() / 1024 ** 3).toFixed(1)} GiB)`
    : `max sessions: ${maxSessions.value} (manual)`,
);
const bootEpoch = String(Date.now());
const image = cfg["agent.image"];
const egressAuditRoot = join(realpathSync(stateDir), "egress-audit");
let egressAudit: EgressAuditCollector;
const { node, sandbox, placement } = wireLocalHost({
  hostId,
  hosts: stores.hosts,
  workspace,
  sessionRoot,
  image,
  bootEpoch,
  capacity: { maxSessions: maxSessions.value, cpus: cpus().length, memoryBytes: totalmem() },
  // egress-image: the daemon pins the egress-proxy image (agent.egressProxyImage, validated by the registry); relay traffic to the
  // daemon is capped at the push limit (relay-class).
  makeSandbox: (mounts) =>
    new DockerSandbox(dockerSandboxDeps({ mounts, egressAuditRoot, storeId, bootEpoch, cfg, warn: (message) => console.error(stamp(`pomtreed: ${message}`)) })),
  requires: async (id) => (await templates.resolve(id))?.requires ?? [],
});
// The host row is written before recovery so the first sync/admit sees it; the running set and queue live in the store.
await node.register(stores.hosts);
const orchestrator = new LocalOrchestrator();
// Extension host (TODO(extensions)): loaded from extensions.dir (empty by default), realpathed so every entry containment check compares real paths.
const extensionsDir = loaded.extensionsDir;
mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
const extensionsDirReal = realpathSync(extensionsDir);

// Host-level resource gate (consulted by spawnNow and admit): disk free above the floor, the
// sandbox reachable (list throws SandboxUnavailableError when down), and under the container cap.
// TODO(cleanup): pre-existing fail-closed admission logic lives in this untested shell; extract with injected statfs/sandbox/memory ports.
const resourceGate = async (): Promise<{ ok: boolean; reason?: string }> => {
  const stat = statfsSync(stateDir);
  if (stat.bavail * stat.bsize < minDiskFreeBytes) return { ok: false, reason: "insufficient disk space" };
  let listed: Awaited<ReturnType<typeof sandbox.list>>;
  try {
    listed = await sandbox.list();
  } catch (e) {
    if (e instanceof SandboxUnavailableError) return { ok: false, reason: "sandbox unavailable" };
    throw e;
  }
  const containers = listed.length;
  if (containers >= maxContainers) return { ok: false, reason: `container limit reached (${containers}/${maxContainers})` };
  // Exited and dead containers reserve no memory (held custody children would otherwise block admission); every other one does.
  // TODO(admission-capacity): check-then-start race. The gate counts containers Docker already lists, but an admitted spawn's
  // container appears only later (lifecycle.ts spawn and the daemon.ts admit loop call this, then start the container asynchronously),
  // so simultaneous spawns all pass at the limit (REC-5 ran 4 containers under a 3-container gate). Current behavior: the gate
  // can over-admit by the number of spawns in flight. Fix needs a reservation the gate hands out and the caller releases once
  // its container is listed or its start failed; a lock here alone cannot cover the asynchronous start.
  const running = await memoryHolders(listed, (id) => sandbox.inspect(id));
  return memoryGate({ running, perContainerBytes: containerMemoryBytes, totalBytes: totalmem(), fraction: memFraction });
};

// Gated actions (TODO(authz-escalation)): extensions.approval = none | all | comma list of extension names. Required: boot has
// already refused when it is unset (safety-boot.ts), so there is no default here.
const extApprovalSpec = cfg["extensions.approval"].trim();
const extApprovalNames = new Set(
  extApprovalSpec
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
);
const extApprovalRequired = (name: string): boolean => extApprovalSpec !== "none" && (extApprovalNames.has("all") || extApprovalNames.has(name));
if (!channels.hasOutbound() && extApprovalRequired("x"))
  console.error("pomtreed: warning: extension approval is required but no escalation channel is configured; gated calls will time out into denials");
const uiWarn = uiChannelWarning(channels, uiListen);
if (uiWarn) console.error(uiWarn);
// Host-side publish (TODO(publish)): publish.targets, remote/branch entries. Only the daemon pushes.
const publishTargets = [...cfg["publish.targets"]];
// Pins the agent's ingested branch to a commit and a one-line diffstat for the approval prompt (TODO(publish-pin)); the push then
// publishes exactly that commit from the mirror, never the moving tip. A branch the agent never pushed has nothing to pin.
// `paths` covers every commit the push would deliver (publish-pin.ts) so the daemon can refuse/flag dangerous changes; a git
// failure throws (fail closed) instead of returning an empty list.
const publishScanWarn = publishScanWarning(cfg["publish.scan"]);
if (publishScanWarn) console.error(publishScanWarn);
const publishResolve = createPublishResolver({
  mirrorDir,
  repoDir,
  defaultBranch,
  contentScan: cfg["publish.scan"],
  resolveAgentBranch: (agent, branch) => workspace.resolve(agent, `refs/agents/${agent}/heads/${branch}`),
});
const publishPush = async (agent: string, _branch: string, target: string, sha: string): Promise<void> => {
  const slash = target.indexOf("/");
  if (slash <= 0) throw new Error(`bad publish target ${target}; expected remote/branch`);
  await workspace.publish(agent, { commit: sha, remote: target.slice(0, slash), target: target.slice(slash + 1) });
};

let daemon!: Daemon;
// Explicit operator opt-ins; absent config admits no workflows and grants no child templates. Trust remains cooperative.
const workflowPolicy = loaded.workflowPolicy;
const workflows = new WorkflowHost({
  registry: () => stores.registry,
  reviewed: (owner) => workflowPolicy.reviewed(owner),
  startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
  log: (line) => console.error(stamp(`pomtreed: ${line}`)),
  services: () => workflowServices,
  reportCeilingBytes: Math.min(cfg["report.workflowMaxBytes"], cfg["report.maxBytes"]),
});
if (loaded.testMode) console.error("pomtreed: WARNING: TEST MODE is on (test.mode): test-only seams are admitted. Never run this in production");
const testFetch = loaded.testFetchHosts ? testFetchSeam(loaded.testFetchHosts) : undefined;
if (loaded.testFetchHosts) console.error(testFetchWarning(loaded.testFetchHosts));
// The one pacer of every fetch path (web_fetch, workflow fetch, every capture rung), keyed by registrable domain (host-pacer.ts).
const domainPace = hostPacer(cfg["workflow.fetch.minIntervalMs"], { quota });
// web_fetch's (and a /v1/capture agent's) request scope from the template's egress policy (webFetchScope): `none` and `registry`
// are refused, `allowlist` may fetch only its own hosts (https, re-checked per redirect). Lookup failure denies (fail closed).
// TODO(cleanup): pre-existing fail-closed lookup (throw => deny) is untested in this shell; extract with an injected registry.
const webFetchAllowedFor = async (agent: string) => {
  try {
    const rec = await stores.registry.get(agent);
    // A deterministic task has no egress policy of its own: web_fetch fails closed until its capability exists.
    return rec === null || rec.executor !== "container" ? false : webFetchScope(rec.spec.egress);
  } catch {
    return false;
  }
};
// Out-of-scope capture: a refused https host from a `registry`/`allowlist` agent asks once per (agent, host, call key) via the
// durable approval store (a capture_host approval, webfetch-approval.ts). Without an approvals store there is no hook and the
// refusal stands.
const captureHostApprove = stores.approvals
  ? createWiredWebFetchApproval({
      store: stores.approvals,
      registry: stores.registry,
      host: hostId,
      notify: (ap) => daemon.notifyApprovalAsk(ap),
      timeoutMs: cfg["approval.timeoutMs"],
    })
  : undefined;
// The capture broker: the only component that dials an origin on an agent's or a workflow's behalf.
const captureBroker = wireCaptureBroker({
  stores,
  quota,
  reports: reportStore,
  daemon: { root: () => daemon.root(), captureRecord: (agent, payload, key) => daemon.captureRecord(agent, payload, key) },
  hostId,
  userAgent: cfg["workflow.fetch.userAgent"],
  log: (line) => console.error(stamp(`pomtreed: ${line}`)),
  ...(domainPace && { pace: domainPace }),
  scopeFor: async (who) =>
    who.kind === "operator"
      ? { allows: () => true }
      : webFetchCaptureScope(await webFetchAllowedFor(who.agent), captureHostApprove && ((h, k) => captureHostApprove(who.agent, h, k))),
  // Test mode only (daemon-config.ts refuses test.fetchHosts otherwise): mapped hosts go to a loopback fixture (test-fetch.ts).
  ...testFetch,
  pomtreedVersion: gitSha() ?? "unknown",
  config: {
    waitMs: cfg["capture.waitMs"],
    timeoutMs: cfg["capture.timeoutMs"],
    maxBytes: cfg["capture.maxBytes"],
    freshness: { stableMs: cfg["capture.freshness.stableMs"], dailyMs: cfg["capture.freshness.dailyMs"], liveMs: cfg["capture.freshness.liveMs"] },
    freshnessRules: parseFreshnessRules(cfg["capture.freshness.rules"]),
    denylist: cfg["capture.denylist"],
    quota: { requests: cfg["capture.quota.requests"], windowMs: cfg["capture.quota.windowMs"] },
  },
});
// Generic capability services (no workflow-specific branch). Root-owned reports, root journal, root user outbox, the escalation ask.
// Fetches go through the capture broker; review/template grants never authorize daemon public fetching.
const workflowServices: WorkflowCapabilityServices = {
  root: () => daemon.root(),
  agent: (id) => daemon.get(id),
  readRoot: (from, limit) => daemon.workflowReadRoot(from, limit),
  recordRoot: (payload, key) => daemon.workflowRecord(payload, key),
  publishRoot: async (req) => {
    const root = await daemon.root();
    const { report } = await reportsBuiltin.publish(root.id, {
      name: req.name,
      mediaType: req.mediaType,
      generation: root.generation,
      key: req.key,
      content: req.content,
    });
    return report;
  },
  sendToUser: (body, key) => daemon.workflowMessage(body, key),
  state: stateDb.state,
  redactText: (text) => daemon.redactText(text),
  ask: async (agent, req) => ({ escalation: (await daemon.ask(agent, req)).escalation.id }),
  capture: captureBroker,
  quota,
  now: () => Date.now(),
};
const extensions = createExtensionRegistry({
  hostId,
  now: () => daemon.now(),
  registry: stores.registry,
  journal,
  mailbox: stores.mailbox,
  root: () => daemon.root(),
  redact: (p) => daemon.redact(p),
  workflows,
  config: loaded.extensionConfig,
});
const modelCatalog = piModelCatalog({ provider: proxyProvider });
daemon = new Daemon({
  hostId,
  secret,
  sandbox,
  workspace,
  harness,
  gateway,
  storeId,
  maxSessions,
  untemplatedEgress: cfg["agent.untemplatedEgress"] as "none" | "registry",
  ...(repos && { repos }),
  // Spawn preflight: can the host reach its own agent endpoint? (a dead listener makes every agent exit unreachable)
  agentEndpointProbe: async () => {
    if (!agentPort) return true;
    const st = await agentEndpointStatus();
    return st.hostProbe && st.containerReachable;
  },
  agentEndpointStatus: async () => (agentPort ? agentEndpointStatus() : { bind: [], apiUrl: "", containerReachable: true, hostProbe: true, probe: "" }),
  registry: stores.registry,
  journal,
  mailbox: stores.mailbox,
  escalations: stores.escalations,
  reportStore,
  workspaceCleanup: stores.workspaceCleanup,
  schedules: stores.schedules,
  watchdogs: stores.watchdogs,
  checkpoints: stores.checkpoints,
  sessions: stores.sessions,
  sessionRoot,
  terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
  channels,
  messagingAllowSpawn: cfg["messaging.allowSpawn"],
  reportMaxBytes,
  templates,
  image,
  epoch: bootEpoch,
  // Every host path this daemon is configured with that error text could echo (the daemon adds sessionRoot, socketHostPath and realpaths).
  redactRoots: [stateDir, repoDir, reportsDir, templatesDir, envCacheRoot, envCacheRootReal, extensionsDir, extensionsDirReal, socketPath],
  sandboxSocketPath,
  agentApiUrl: () => agentApiUrl,
  socketHostPath: socketPath,
  harnessExtensions: { steerExt: cfg["harness.steerExt"], jobsExt: cfg["harness.jobsExt"] },
  command: (task, spec) => harnessArgv(task, spec, { steerExt: cfg["harness.steerExt"], jobsExt: cfg["harness.jobsExt"] }),
  models: modelCatalog,
  provider: proxyProvider,
  folderIdleMs,
  folderReapedGraceMs,
  folderMinFreeBytes,
  diskFreeBytes,
  pushMaxBytes,
  containerMemoryBytes,
  env: { cacheRoot: envCacheRootReal, manifest: emptyManifest() },
  credentials: proxyPiCredentials({ stateDir, containerAuthPath: PI_AUTH_PATH, provider: proxyProvider }),
  rootBudgetMicros: cfg["budget.rootMicros"],
  defaultBudgetMicros: cfg["budget.defaultMicros"],
  topLevelBudgetMicros: cfg["budget.topLevelMicros"],
  ...sessionDeadline,
  agentTokenTtlMs: cfg["agent.tokenTtlMs"],
  reconcileMs: cfg["agent.reconcileSweepMs"],
  graceMs: 10_000,
  admitRetryMs: 500,
  resourceGate,
  placement,
  orchestrator,
  limits: {
    maxDepth: cfg["agent.maxDepth"],
    maxChildren: cfg["agent.maxChildren"],
    zombieMs: cfg["agent.zombieMs"],
    zombieSweepMs: cfg["agent.zombieSweepMs"],
    rootCustodyMax: cfg["agent.rootCustodyMax"],
    watchdogSweepMs: cfg["watchdog.sweepMs"],
    watchdogBlockedMs: cfg["watchdog.blockedMs"],
    watchdogIntensityWindowMs: cfg["watchdog.intensityWindowMs"],
    watchdogStableMs: cfg["watchdog.stableMs"],
    cronTickMs: cfg["cron.tickMs"],
    cleanupSweepMs: cfg["cleanup.sweepMs"],
  },
  watchdogOptions: { stallMs: cfg["watchdog.stallMs"] },
  approvals: stores.approvals,
  extApprovalRequired,
  approvalTimeoutMs: cfg["approval.timeoutMs"],
  askTimeoutMs: cfg["ask.timeoutMs"],
  escAgentMs: cfg["escalation.agentRungMs"],
  budgetRaiseMs: cfg["budget.raiseMs"],
  budgetRaisePct: cfg["budget.raisePct"],
  interruptGraceMs: cfg["agent.interruptGraceMs"],
  containerConfig: loaded.containerConfig,
  fetchUserAgent: cfg["workflow.fetch.userAgent"],
  // The allowlist applies to chat-rank senders only: performAction never consults it for operator rank (ui session, operator
  // token), which the registry marks and which no adapter can claim (POST /v1/messages refuses in-daemon channels).
  ...(messagingSenders.size > 0 && {
    authorizeInbound: (m: { sender: { channel: string; sender: string } }) => messagingSenders.has(`${m.sender.channel}:${m.sender.sender}`),
  }),
  ...(publishTargets.length > 0 && {
    publisher: { allowedTargets: publishTargets, push: publishPush, resolve: publishResolve, deniedPaths: cfg["publish.deny"] },
  }),
  adoptOrphans: cfg["agent.adoptOrphans"],
  // chat.approval (spawn, cancel): chat-initiated spawn/cancel wait for a human approval (needs an approvals store).
  chatApproval: (
    (set) => (route: "spawn" | "cancel") =>
      set.has(route)
  )(new Set(cfg["chat.approval"])),
  extensionHost: extensions,
  capture: captureBroker,
  captureWaitMs: cfg["capture.waitMs"],
  state: stateDb.state,
  stateGrants: statePolicy,
  // Canonical workflow launch (transports reach it through this dependency); admission stays default-deny via `reviewed`.
  launchWorkflow: (requester, req) => workflows.launch(requester, req),
  deterministicExecutors: workflows.executors,
  publicEgressReady: () => egressAudit?.healthy() ?? false,
  mayUseTemplate: async (caller, template) =>
    caller === (await daemon.root()).id || workflowPolicy.allows(await stores.registry.get(caller), template.id, workflows.qualifiedNames()),
  // The default agent extension gateway (web_fetch/web_search) with the SSRF guard and size caps;
  // gated by durable approvals (`extApprovalRequired` above), not an approveExtension hook.
  extensions: createExtGateway({
    searchProvider: cfg["search.provider"].trim() || undefined,
    searchKey: cfg["search.key"].trim() || undefined,
    // Exfiltration controls: web_fetch runs on the host network (bypassing container egress). webfetch.enabled=false disables
    // it globally; per-template opt-out is the template's `extensions` list (an agent without web_fetch cannot call it).
    webFetchEnabled: cfg["webfetch.enabled"],
    // web_fetch is a capture broker client; its scope and capture_host escalation are the ones the broker's scopeFor uses.
    capture: captureBroker,
    generationOf: async (agent) => (await stores.registry.get(agent))?.generation ?? null,
    fetchTimeoutMs: cfg["webfetch.timeoutMs"],
    webFetchAllowed: webFetchAllowedFor,
    ...(captureHostApprove && { webFetchApprove: captureHostApprove }),
    maxCallsPerWindow: cfg["webfetch.maxCalls"],
    rateWindowMs: cfg["webfetch.windowMs"],
    maxTotalBytes: cfg["webfetch.maxTotalBytes"],
    quota,
  }),
});

egressAudit = new EgressAuditCollector({
  reader: new DiskEgressAudit({ root: egressAuditRoot }),
  journal,
  root: () => daemon.root(),
  vacuumGraceMs: cfg["audit.spoolVacuumGraceMs"],
});
let egressNearCap = false;
const ingestEgressAudit = async () => {
  await ingestEgressAuditSafely(egressAudit, (line) => console.error(line));
  try {
    const t = nearCapTransition(egressNearCap, egressAudit.status());
    egressNearCap = t.nearCap;
    if (t.line) console.error(t.line);
  } catch {
    // retention() reads the spool root; an unreadable root is already reported by ingestion, so the alert just holds its last state.
  }
};
// Ingest retained/reaped-worker spools before recovery can start public workers. Source identities are never relabelled.
await ingestEgressAudit();
const egressAuditTimer = setInterval(() => {
  void ingestEgressAudit();
}, 1000);
egressAuditTimer.unref?.();

// Client/server revision skew (the image bakes `pomtree`; pomtreed runs from source): warn loudly at boot
// when the daemon's git sha and the image's baked revision are both known and differ.
{
  const sha = gitSha();
  const img = imageRevision(daemon.deps.image);
  if (revisionMismatch(sha, img)) {
    console.error(`pomtreed: WARNING: client/server revision mismatch: pomtreed git ${sha} vs agent image ${img} (rebuild the image)`);
  }
  await checkEgressImage(cfg["agent.egressProxyImage"]);
}

placement.onAdmit((agent) => daemon.admitted(agent));
await extensions.load(extensionsDirReal);
// The observe builtin is compiled in alongside file-loaded extensions; the OTLP exporter stays opt-in
// (otlp.endpoint) and is started by the extension's start().
extensions.registerBuiltin(
  createObserveExtension({
    otlp: cfg["otlp.endpoint"] ? { endpoint: cfg["otlp.endpoint"] } : undefined,
    waits: () => daemon.liveWaits(),
  }),
);
// The reports builtin owns the report store and report routes; the cron builtin owns the schedule store,
// the schedule routes, and the schedule sweep (its start()/stop() replace the daemon's cron interval).
// Spawning a schedule's root child stays a daemon capability, reached through these narrow facades.
const reportsBuiltin = createReportsExtension({ store: reportStore, reportMaxBytes });
extensions.registerBuiltin(reportsBuiltin);
extensions.registerBuiltin(
  createCronExtension({
    schedules: stores.schedules,
    cronTickMs: daemon.limits.cronTickMs,
    rootId: async () => (await daemon.root()).id,
    spawnRootChild: async (intent, idempotencyKey) =>
      daemon.spawn((await daemon.root()).id, {
        name: intent.name,
        task: intent.task,
        ...(intent.budgetMicros !== undefined && { budgetMicros: intent.budgetMicros }),
        ...(intent.deadlineMs !== undefined && { deadlineMs: intent.deadlineMs }),
        ...(intent.template !== undefined && { template: intent.template }),
        ...(intent.model !== undefined && { model: intent.model }),
        idempotencyKey,
      }),
    steerAgent: (agent, body, key) => daemon.messageAgent(agent, body, key, "queue"),
    wakeAgent: (agent, body, key) => daemon.resumeAgent(agent, body, {}, key),
    pendingSignals: (agent) => daemon.deps.mailbox.peek(agent),
    ...(daemon.deps.models && { models: daemon.deps.models }),
  }),
);
// root-id: before any listener (so before any spawn), the root exists under its stable id and its pool matches
// budget.rootMicros: a raise is a journaled operator top-up, a lowering a journaled withdrawal of at most the unheld remainder;
// a withdrawal past it refuses startup (fail closed) with the amounts and the action.
try {
  await daemon.reconcileRootPool();
} catch (e) {
  if (!(e instanceof RootWithdrawalError)) throw e;
  console.error(`pomtreed: config: ${e.message}`);
  process.exit(CONFIG_EXIT);
}
console.error(fetchIdentityLine(cfg["workflow.fetch.userAgent"]));
// Before any listener (so before any spawn): remove egress networks/proxies whose container is gone.
await daemon.reclaimEgressOrphans();
// Re-run merges a crash left open before any caller can retry or reap (the engine resumes each from its journaled phase).
await daemon.recoverMerges().then(
  (rs) => {
    if (rs.length) console.error(`pomtreed: recovered ${rs.length} open merge(s)`);
  },
  (e) => console.error(`pomtreed: merge recovery failed: ${e instanceof Error ? e.message : String(e)}`),
);
const server = await listen(daemon, socketPath, { readyzAllowSandboxDown: cfg["readyz.allowSandboxDown"], egressAuditStatus: () => egressAudit.status() });
let agentServer: Server | null = null;
let extraAgentServers: Server[] = [];
if (agentListen !== "off") {
  if (agentPlan.warning) console.error(`pomtreed: WARNING: ${agentPlan.warning}`);
  const pin = pinnedAgentPort(agentListen, join(stateDir, "agent-port"));
  const i = pin.listen.lastIndexOf(":");
  const host = pin.listen.slice(0, i);
  const a = await listenAgents(daemon, host, Number(pin.listen.slice(i + 1))).catch(() => listenAgents(daemon, host, 0)); // remembered port taken: fall back to a fresh one
  pin.remember(a.port);
  agentPort = a.port;
  agentBound = [host];
  agentApiUrl = `http://host.docker.internal:${a.port}`;
  agentServer = a.server;
  // Same handler on loopback too (best effort; adds no exposure): host-side tools and Docker Desktop paths keep working.
  const extra: Server[] = [];
  for (const h of agentPlan.extraHosts) {
    try {
      extra.push((await listenAgents(daemon, h, a.port)).server);
      agentBound.push(h);
    } catch {
      /* port busy on that address */
    }
  }
  extraAgentServers = extra;
  console.error(`pomtreed agent endpoint on ${agentBound.map((h) => `${h}:${a.port}`).join(", ")} (containers: POMTREE_API=${agentApiUrl})`);
  if (!containerReachable({ platform: process.platform, boundHosts: agentBound, gateway: await reachGateway() })) {
    console.error(
      `pomtreed: WARNING: ${unreachableMessage({ bind: agentBound.map((h) => `${h}:${a.port}`), apiUrl: agentApiUrl, probe: `${agentBound[0]}:${a.port}`, listenable: true })}`,
    );
  }
}
// Linux default plan: prove reachability from a real container (one short `docker run`, no egress; agent.probe=false skips).
// A host firewall that drops docker0 -> host ports defeats any bind address, so on failure fall back to the unix-socket mount.
if (agentServer && agentPlan.mode === "gateway" && cfg["agent.probe"]) {
  containerProbe = await new Promise<boolean>((res) => execFile("docker", containerProbeArgs(image, agentPort), { timeout: 30_000 }, (e) => res(!e)));
  console.error(`pomtreed: agent endpoint container probe ${containerProbe ? "ok" : "FAILED"}`);
  if (!containerProbe) {
    console.error(
      `pomtreed: WARNING: agent endpoint ${agentBound.map((h) => `${h}:${agentPort}`).join(", ")} is not reachable from containers. ${firewallHint(agentPort)}`,
    );
    for (const sv of [agentServer, ...extraAgentServers]) sv.close();
    agentServer = null;
    extraAgentServers = [];
    agentApiUrl = undefined;
    agentPort = 0;
    agentBound = [];
  }
}
let modelProxyServer: Server | null = null;
let reservationReclaim: ReturnType<typeof setInterval> | undefined;
const { proxy: proxyOptions } = buildModelProxyOptions({
  settings: proxySettings,
  provider: proxyProvider,
  upstream: { baseUrl: cfg["model.baseUrl"], key: cfg["model.upstreamKey"] },
  catalog,
  debits: modelDebits,
  registry: stores.registry,
  journal,
  host: hostId,
  onBudgetStall: (e) =>
    void daemon
      .budgetStalled(e.agent, e.remainingMicros, e.floorMicros)
      .catch((err) => console.error(`pomtreed: budget stall escalation failed: ${String(err instanceof Error ? err.message : err)}`)),
});
const proxy = new ModelProxy(proxyOptions);
if (!catalog.found) console.error("pomtreed: WARNING: no model rates; unreported-usage responses are charged the full reservation (no estimate)");
reservationReclaim = startReservationReclaim(modelDebits, upstreamTimeoutMs, (m) => console.error(m));
const proxyPlan = planAgentListen({ listen: undefined, platform: process.platform, gateway: await reachGateway() });
if (proxyPlan.warning) console.error(`pomtreed: WARNING: ${proxyPlan.warning}`);
const proxyHost = proxyPlan.mode === "off" ? "127.0.0.1" : proxyPlan.host;
const proxyServer = createModelProxyServer(proxy, {
  mode: accessLog,
  sink: (line) => console.log(line),
});
await new Promise<void>((resolve, reject) => {
  proxyServer.once("error", reject);
  proxyServer.listen(modelProxyPort, proxyHost, () => {
    proxyServer.off("error", reject);
    resolve();
  });
});
modelProxyServer = proxyServer;
console.error(`pomtreed model proxy on ${proxyHost}:${modelProxyPort} (containers: ${proxyBaseUrl})`);

let hostServer: Server | null = null;
if (hostSpec) {
  const h = await listenHost(daemon, hostSpec.host, hostSpec.port);
  hostServer = h.server;
  console.error(`pomtreed host (messaging) endpoint on ${hostSpec.host}:${h.port}`);
}
const uiServers: Server[] = [];
if (uiSpec) {
  const ui = await listenUi(daemon, uiSpec.host, uiSpec.port);
  uiServers.push(ui.server);
  console.error(`pomtreed ui endpoint on ${uiSpec.host}:${ui.port}`);
}
// Reviewed drivers must be committed before recovery decides whether an interrupted task can continue.
await extensions.startAll();
await workflowPolicy.validate(workflows.qualifiedNames(), async (id) => id === "code" || templates.resolve(id));
await statePolicy.validate({ owners: extensions.names(), drivers: workflows.qualifiedNames(), template: async (id) => id === "code" || templates.resolve(id) });
// Boot recovery runs after every listener is up so resumed agents get POMTREE_API, not the socket mount. It is best-effort: an unreachable repo or Docker (or a store outage) must not crash-loop
// the daemon — the serialized reconcile() timer retries the idempotent passes every ~30s.
try {
  await daemon.recover();
} catch (e) {
  console.error(`pomtreed: boot recovery failed (reconcile will retry): ${e instanceof Error ? e.message : String(e)}`);
}
// Capture jobs a previous pomtreed left open rerun their interrupted rung once (opIds keep quota and pacing charged once).
await captureBroker.recover().then(
  (n) => n > 0 && console.error(stamp(`pomtreed: capture recovery restarted ${n} open job(s)`)),
  (e) => console.error(stamp(`pomtreed: capture recovery failed: ${e instanceof Error ? e.message : String(e)}`)),
);
const stopWatchers = daemon.startWatchers();
// Retention (TODO(retention)): idempotency keys older than the window are pruned hourly. A replay of a mutating
// call older than the window is not deduplicated, so keep it well past any client retry horizon (default 30 days).
const idempotencyRetentionMs = cfg["idempotency.retentionMs"];
const retention = setInterval(() => {
  try {
    const n = stores.pruneIdempotency(idempotencyRetentionMs) + stateDb.pruneIdempotency(idempotencyRetentionMs);
    if (n > 0) console.error(`pomtreed: pruned ${n} idempotency key(s) older than ${idempotencyRetentionMs}ms`);
    // Quota windows end long before this: a window older than twice the longest one (the web_fetch window, a day floor) is
    // dead. A lifetime counter (window 0: a per-agent byte cap, a per-task fetch budget) goes only once untouched for the
    // idempotency retention, so a live subject's cap is never reset by the sweep.
    const now = Date.now();
    const q = stores.pruneQuotaCounters(now - 2 * Math.max(cfg["webfetch.windowMs"], 86_400_000), now - idempotencyRetentionMs);
    if (q > 0) console.error(`pomtreed: pruned ${q} expired quota counter(s)`);
  } catch (e) {
    console.error(`pomtreed: idempotency prune failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}, 3_600_000);
retention.unref?.();
// Journal retention (TODO(retention), off by default): prunes high-volume kinds older than the window, keeping the newest
// N per agent and everything after each agent's latest checkpoint. Consumers cursor by seq value, so gaps are fine.
// Cost evidence: the model debit ledger (store-sqlite model_debit_requests, joined to calls by request id) is the durable cost
// source of truth and is never pruned here. `usage` journal rows are prunable evidence under this policy, so cost and
// per-call audits must read the ledger, not the journal.
// TODO(cleanup): usage rows are prunable evidence; core JOURNAL_PRUNABLE_KINDS lists them, decide whether to protect them by default.
const journalPolicy = loaded.journal;
if (journalPolicy && journal.pruneJournal) {
  const plan = planJournalRetention(journalPolicy);
  if (plan) {
    const jr = setInterval(() => {
      journal.pruneJournal!(plan).then(
        (r) => {
          if (r.deleted > 0) console.error(`pomtreed: pruned ${r.deleted} journal row(s) older than ${plan.olderThanMs}ms`);
        },
        (e) => console.error(`pomtreed: journal prune failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }, 3_600_000);
    jr.unref?.();
  }
}
console.error(stamp(`pomtreed listening on ${socketPath} (host ${hostId}, ${buildVersion()})`));

// Graceful drain (request boundary and supervisor drain): a signal, unhandledRejection, or
// uncaughtException journals a host-level error, stops admission and the watchers, closes every listener,
// and then exits — rather than the default handler's immediate crash, which leaves containers unobserved
// and the next start failing every checkpoint-less agent. The error is journaled as a `host_error` with the
// "daemon" component and the full message.
let draining = false;
const drainTimeoutMs = cfg["drain.timeoutMs"];
// TODO(cleanup): shutdown ordering and boot-recovery/prune failure handling in this shell are untested (pre-existing apart from the egress-audit ingest calls).
const drain = (reason: string, exitCode: number, journalError = true): void => {
  if (draining) return;
  draining = true;
  console.error(stamp(`pomtreed: ${reason}; draining`));
  const deadline = Date.now() + drainTimeoutMs;
  // A drain that outlives its deadline is force-exited nonzero: an open
  // connection or a stuck handler must not leave a half-drained daemon running indefinitely.
  const failsafe = setTimeout(() => {
    console.error(stamp("pomtreed: drain deadline exceeded; exiting nonzero"));
    process.exit(1);
  }, drainTimeoutMs);
  failsafe.unref?.();
  void (async () => {
    if (journalError) {
      try {
        const root = await daemon.root();
        await journal.append({
          agent: root.id,
          host: hostId,
          generation: root.generation,
          payload: daemon.redact({ kind: "host_error", component: "daemon", message: `daemon: ${reason}` }),
          idempotencyKey: `host:daemon:${shortHash(reason, (x) => createHash("sha256").update(x).digest("hex"))}:${bootEpoch}`,
        });
      } catch (e) {
        console.error(`pomtreed: could not journal daemon error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      stopWatchers();
      clearInterval(retention);
      clearInterval(egressAuditTimer);
      await ingestEgressAudit();
      if (reservationReclaim) clearInterval(reservationReclaim);
    } catch {
      // watchers may already be stopped
    }
    // Daemon-side drain: stop admission, release queued work, abort kill timers, and leave running
    // containers adoptable (they are re-adopted by Sandbox.attach on the next boot).
    await daemon.shutdown(deadline).catch((e) => console.error(`pomtreed: daemon drain failed: ${e instanceof Error ? e.message : String(e)}`));
    // Open capture jobs stay open in the index; the next boot's recover() resumes them.
    await captureBroker.close().catch((e) => console.error(`pomtreed: capture broker close failed: ${e instanceof Error ? e.message : String(e)}`));
    // Shutdown order: daemon.shutdown closed container admission; the workflow drain then ends this host's owned tasks within the
    // same absolute deadline; extensions stop unless a retained owner still has a live task (its handlers stay).
    const drained = await workflows.drainSafe({
      deadlineAt: deadline,
      now: () => Date.now(),
      cancel: (id, graceMs) => daemon.cancel(id, graceMs).then(() => {}),
      tick: sleepTick,
      race: (p) => raceUntil(p, deadline),
    });
    if (!drained.complete)
      console.error(
        stamp(
          `pomtreed: workflow teardown incomplete: retained ${JSON.stringify(drained.retained)} live ${JSON.stringify(drained.live)} errors ${JSON.stringify(drained.errors)}`,
        ),
      );
    await extensions
      .stopForShutdown(drained.retained)
      .catch((e) => console.error(stamp(`pomtreed: extension stop failed: ${e instanceof Error ? e.message : String(e)}`)));
    // Close every listener and every open connection: a live SSE must not hang server.close().
    console.error(stamp("pomtreed: listeners stopping"));
    const servers = [server, agentServer, ...extraAgentServers, hostServer, ...uiServers, modelProxyServer].filter((s): s is Server => s !== null);
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((res) => {
            s.closeAllConnections();
            s.closeIdleConnections();
            s.close(() => res());
          }),
      ),
    );
    // Stop future journal dispatch before the stores are released. Callbacks already running are cooperative and not awaited.
    extensions.finishShutdown();
    try {
      stateDb.close();
      stores.close();
    } catch (e) {
      console.error(`pomtreed: store close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    releaseStateLock();
    clearTimeout(failsafe);
    process.exit(exitCode);
  })();
};

process.off("uncaughtException", onStartupFailure);
process.on("unhandledRejection", (reason) => {
  drain(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`, 1);
});
process.on("uncaughtException", (err) => {
  drain(`uncaught exception: ${err.stack ?? err.message}`, 1);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => drain(`received ${sig}`, 0, false));
}
