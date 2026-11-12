// LIVE composition of the hn-content workflow: real SQLite store, dir reports, git workspace, DockerSandbox with the audited-public egress
// spool, the Pi harness, the key-issuing OpenRouter model proxy (startLiveModel), the egress-audit collector and the reviewed hn-content
// extension. Nothing starts at import; nothing is spent or fetched unless a caller invokes openLiveContentRuntime. The upstream key is read
// by preflightLive from the secret file named by POMTREED_MODEL_UPSTREAM_KEY_FILE (no group or other mode bits), held in memory, and handed only to the proxy env object: it is never logged, journaled or written.
// Separate from model-runtime.mts (the hn-insight/deepseek path), which stays unchanged.
// Article method: static-http (default) runs the static adapter HOST-side (the image has no static-capture tool), so its fetches are audited
// by the host-fetch wrapper. browser runs a real model-driven Pi browsing worker (template capture-browser, audited-public egress, Chromium in
// the container); its capture is verified from the worker's journaled browser_capture call. A live run of the browser method is release
// gate EGR-2, defined in docs/validation.md; remaining gaps are tracked under TODO(web) (settle wait for JS-rendered pages, capture failure causes, worker exit code, background hosts).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALLOWLIST_PROFILE_TOOLS } from "../../packages/agent-image/src/allowlist-profiles.ts";
import { emptyManifest } from "../../packages/agent-image/src/index.ts";
import {
  type AgentId,
  type AgentRecord,
  CONFIG_REGISTRY,
  type ContainerConfigValues,
  containerParamDefs,
  type Harness,
  type HostId,
  type MountProvider,
  type ReportStore,
  resolveConfig,
  type Sandbox,
  type SandboxEgress,
  type SpawnSpec,
  type Template,
  type TemplateStore,
  type Workspace,
} from "../../packages/core/src/index.ts";
import { startLiveModel } from "../../packages/e2e/src/live-model.ts";
import { assertModelProxyReachable, type ModelRouteProbe, sandboxModelRouteProbe } from "../../packages/e2e/src/model-preflight.ts";
import { createPiHarness, fileTailSource, PI_SINK_FILE, PI_TTY_ENV } from "../../packages/harness-pi/src/index.ts";
import { type Io, run } from "../../packages/pomtree/src/cli.ts";
import { socketTransport } from "../../packages/pomtree/src/client.ts";
import { agentBindPlan, detectBridgeGateway } from "../../packages/pomtreed/src/agent-net.ts";
import { issueToken } from "../../packages/pomtreed/src/auth.ts";
import { createReportsExtension } from "../../packages/pomtreed/src/builtin/reports.ts";
import { wireCaptureBroker } from "../../packages/pomtreed/src/capture-wiring.ts";
import { buildChannelRegistry } from "../../packages/pomtreed/src/channels.ts";
import { Daemon } from "../../packages/pomtreed/src/daemon.ts";
import { openDaemonStore } from "../../packages/pomtreed/src/daemon-store.ts";
import type { DaemonDeps, InboundMessage, MessageReceipt } from "../../packages/pomtreed/src/daemon-types.ts";
import { egressPolicy } from "../../packages/pomtreed/src/egress.ts";
import { EGRESS_AUDIT_KIND, EgressAuditCollector, type EgressAuditReader } from "../../packages/pomtreed/src/egress-audit.ts";
import { defaultFetch, type FetchFn, isBlockedAddress } from "../../packages/pomtreed/src/ext-gateway.ts";
import { createExtensionRegistry, type ExtensionRegistryImpl } from "../../packages/pomtreed/src/extensions.ts";
import { harnessArgv } from "../../packages/pomtreed/src/harness-argv.ts";
import { wireLocalHost } from "../../packages/pomtreed/src/local-host.ts";
import { discoverCatalogDir, openPiCatalog, piAgentDir } from "../../packages/pomtreed/src/model-proxy/pi-catalog.ts";
import { LocalOrchestrator } from "../../packages/pomtreed/src/orchestrator.ts";
import { listen, listenAgents, listenHost } from "../../packages/pomtreed/src/server.ts";
import type { WorkflowCapabilityServices } from "../../packages/pomtreed/src/workflow-capabilities.ts";
import { raceUntil, sleepTick, WorkflowHost } from "../../packages/pomtreed/src/workflows.ts";
import { DirReportStore } from "../../packages/report-dir/src/index.ts";
import { DiskEgressAudit, DockerSandbox, type EgressAuditRecord } from "../../packages/sandbox-docker/src/index.ts";
import type { Store } from "../../packages/store-sqlite/src/index.ts";
import { ScriptHarness } from "../../packages/testing/src/test-harness.ts";
import { GitWorkspace } from "../../packages/workspace-git/src/index.ts";
import type { ArticleInput } from "./article.mts";
import { runStaticWorker } from "./article-worker.mts";
import { approvedBrowserWorker, createJournalCaptureAuthority } from "./content-authority.mts";
import { CONTENT_CONFIG_DEFAULTS, type ContentBounds, type ContentConfig, contentBounds } from "./content-bounds.mts";
import {
  type ArticleMethod,
  BROWSER_ARTICLE_BUDGET_MICROS,
  BROWSER_DEADLINE_MS,
  BROWSER_LIMITS,
  BROWSER_TEMPLATE,
  browserArgv,
} from "./content-browser-method.mts";
import type { CaptureReceipt } from "./content-evidence.mts";
import { createContentExtension } from "./content-extension.mts";
import { type Attribution, type AuditedFetch, auditedModelFetch, createAuditedFetch, type HostDenyReason } from "./content-live-fetch.mts";
import { catalogRouteEntry, liveUpstreamBaseUrl } from "./content-live-upstream.mts";
import { storyNumberOf } from "./content-story.mts";
import { APPROVED_IMAGE, joinLifecycle, modelCatalogEnv, SHUTDOWN_BOUND_MS, teardownPartialOpen, teardownResources } from "./model-runtime.mts";
import { boundedStep, type CloseLedger, redactMessage } from "./runtime.mts";
import { sandboxOpKey, sandboxOwner } from "../../packages/pomtreed/src/daemon/sandbox-ops.ts";

export const LIVE_PROVIDER = "openrouter";
export const LIVE_MODEL = "anthropic/claude-haiku-5.5";
export const LIVE_ROUTE = `${LIVE_PROVIDER}/${LIVE_MODEL}`;
export const LIVE_MAX_REQUEST_MICROS = 50_000;
export const LIVE_BUDGET_CEILING_MICROS = 1_000_000;
export const LIVE_DEFAULT_DEADLINE_MS = 600_000;
export const CAPTURE_TEMPLATE = "capture-static";
export const MODEL_TEMPLATE = "grounded-model";
export const LIVE_ARTICLE_BUDGET_MICROS = 1_000;
const CHANNEL = "discord";
const CHAT_SENDER = "u1";
const CANCEL_GRACE_MS = 1_000;
const STORE_LABEL = "store close";
const EXTENSIONS_LABEL = "extensions stop";
const ARTICLE_TASK_MARK = '{"kind":"hn-article-capture"';
type SandboxRef = NonNullable<AgentRecord["sandbox"]>;

// The clone base for a run without --repo-dir. Pi writes its session into the workspace at `.pi-session` (a container bind mount); an untracked
// `.pi-session/` makes `pomtree result` refuse with "uncommitted work", so the base repo ignores it from the first commit.
export function createLiveBaseRepo(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), ".pi-session/\n");
  execFileSync("git", ["-C", dir, "add", ".gitignore"]);
  execFileSync("git", ["-C", dir, "-c", "user.name=live", "-c", "user.email=live@invalid", "commit", "-q", "-m", "base"]);
}

// ---- Preflight: caps, pricing, auth. Every refusal happens before anything is opened or spent. ----

export interface LiveCaps {
  stories: number;
  modelBudgetMicros: number; // whole-run ceiling for paid workers (CONTENT.md); each story gets floor(whole / stories)
  rootBudgetMicros: number;
  maxRequestMicros: number;
  articleBudgetMicros: number;
}

// Defaults: 200000 per story (1 story 200000, 3 stories 600000); root 500000 for 1 story, 700000 for 3. An explicit
// --budget-micros above LIVE_BUDGET_CEILING_MICROS needs iKnowTheCap. The root keeps the same headroom over the model budget.
export function planCaps(o: { stories: number; budgetMicros?: number; iKnowTheCap?: boolean; articleMethod?: ArticleMethod }): LiveCaps {
  if (!Number.isInteger(o.stories) || o.stories < 1 || o.stories > 3) throw new Error("live content: --stories must be an integer 1..3");
  const defaultModel = 200_000 * o.stories;
  const defaultRoot = 500_000 + 100_000 * (o.stories - 1);
  const model = o.budgetMicros ?? defaultModel;
  if (!Number.isSafeInteger(model) || model <= 0) throw new Error("live content: --budget-micros must be a positive integer");
  if (model > LIVE_BUDGET_CEILING_MICROS && o.iKnowTheCap !== true)
    throw new Error(`live content: refusing --budget-micros ${model} above ${LIVE_BUDGET_CEILING_MICROS}; pass --i-know-the-cap to override`);
  const carve = Math.floor(model / o.stories);
  const articleBudgetMicros = o.articleMethod === "browser" ? BROWSER_ARTICLE_BUDGET_MICROS : LIVE_ARTICLE_BUDGET_MICROS;
  if (carve - articleBudgetMicros < LIVE_MAX_REQUEST_MICROS)
    throw new Error(
      `live content: per-story carve ${carve} cannot fund one ${LIVE_MAX_REQUEST_MICROS}-micro request after the ${articleBudgetMicros}-micro article reservation`,
    );
  return {
    stories: o.stories,
    modelBudgetMicros: model,
    rootBudgetMicros: model + (defaultRoot - defaultModel),
    maxRequestMicros: LIVE_MAX_REQUEST_MICROS,
    articleBudgetMicros,
  };
}

// The default wall-clock deadline of a run: a 10 minute base, plus one browser article deadline per story for the browser method (the browsing
// workers run before analysis). --deadline-ms overrides it. Per-spawn deadlines are separately clamped by pomtreed to the session cap (sessionMs).
export function liveDefaultDeadlineMs(stories: number, articleMethod: ArticleMethod = "static-http"): number {
  return articleMethod === "browser" ? LIVE_DEFAULT_DEADLINE_MS + BROWSER_DEADLINE_MS * stories : LIVE_DEFAULT_DEADLINE_MS;
}

// The daemon session cap (sessionMs) for a run with this wall-clock deadline: never below the deadline or the method's default. pomtreed clamps
// every spawn deadline to it without a note (spawnDeadline in packages/pomtreed/src/daemon/budget.ts) and the deadline then kills the agent, so
// a cap below the run deadline ended the agents early while the supervisor kept waiting (a browser story: 840000 ms against a fixed 600000).
export function liveSessionMs(deadlineMs: number, stories: number, articleMethod: ArticleMethod): number {
  return Math.ceil(Math.max(deadlineMs, liveDefaultDeadlineMs(stories, articleMethod)));
}

// Refuses unless Pi's own catalog resolves the route with a rate. Never charges the unpriced floor blindly.
export function requireLivePricing(env: Record<string, string | undefined>, home = homedir()): { input: number; output: number } {
  const catalog = openPiCatalog(modelCatalogEnv(env), LIVE_PROVIDER, home);
  if (!catalog.found) throw new Error(`live content: refusing to start, ${catalog.message}`);
  const rates = catalog.rates.lookup(LIVE_PROVIDER, LIVE_MODEL);
  if (!rates) throw new Error(`live content: refusing to start, ${LIVE_ROUTE} is not priced in the Pi catalog`);
  return { input: rates.input, output: rates.output };
}

// The model upstream base, from the Pi catalog entry of the route (its baseUrl), never hardcoded: Pi's request path is relative to that
// baseUrl. Refuses when the entry or its baseUrl is missing or not on openrouter.ai.
export function requireLiveUpstream(env: Record<string, string | undefined>, home = homedir()): string {
  const catalogEnv = modelCatalogEnv(env);
  const dir = discoverCatalogDir(catalogEnv);
  if (!dir) throw new Error("live content: refusing to start, Pi model catalog not found");
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  let builtin: unknown;
  try {
    builtin = readJson(join(dir, `${LIVE_PROVIDER}.json`));
  } catch {
    throw new Error(`live content: refusing to start, Pi catalog ${LIVE_PROVIDER}.json is unreadable`);
  }
  let generatedAt: number | undefined;
  try {
    const t = Date.parse((readJson(join(dir, ".manifest.json")) as { generatedAt?: string }).generatedAt ?? "");
    generatedAt = Number.isNaN(t) ? undefined : t;
  } catch {}
  let overlay: unknown;
  try {
    overlay = (readJson(join(piAgentDir(catalogEnv, home), "models-store.json")) as Record<string, unknown>)[LIVE_PROVIDER];
  } catch {}
  const entry = catalogRouteEntry({ builtin, overlay, ...(generatedAt !== undefined && { generatedAt }) }, LIVE_MODEL);
  if (!entry) throw new Error(`live content: refusing to start, ${LIVE_ROUTE} has no entry in the Pi catalog`);
  return liveUpstreamBaseUrl(entry);
}

// Reads the upstream API key from the file named by POMTREED_MODEL_UPSTREAM_KEY_FILE (the same key file pomtreed takes), through core's
// secret-file rule exactly as pomtreed's main.ts wires it (resolveConfig: absolute path, no group/other mode bits, non-empty), so the
// two can never disagree on what a valid key file is. Only that one variable is passed in; errors name it and the path, never the contents.
export function readUpstreamKey(env: Record<string, string | undefined>): string {
  const path = env.POMTREED_MODEL_UPSTREAM_KEY_FILE;
  if (!path) throw new Error("live content: POMTREED_MODEL_UPSTREAM_KEY_FILE is required: set it to a file holding the upstream API key");
  const r = resolveConfig(CONFIG_REGISTRY, {
    env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: path },
    readFile: (p) => readFileSync(p, "utf8"),
    ...(process.platform !== "win32" && { fileMode: (p: string) => statSync(realpathSync(p)).mode }),
  });
  if (!r.ok) throw new Error(`live content: upstream key file refused: ${r.errors.join("; ")}`);
  const key = r.values["model.upstreamKey"];
  if (typeof key !== "string" || key.trim() === "") throw new Error(`live content: upstream key file ${path} (POMTREED_MODEL_UPSTREAM_KEY_FILE) is empty`);
  return key;
}

export interface Preflight {
  caps: LiveCaps;
  upstreamKey: string;
  rates: { input: number; output: number };
  upstreamBaseUrl: string; // the catalog baseUrl of the route; what the model proxy forwards to
}

export function preflightLive(o: {
  env: Record<string, string | undefined>;
  stories: number;
  budgetMicros?: number;
  iKnowTheCap?: boolean;
  articleMethod?: ArticleMethod;
  home?: string;
}): Preflight {
  const caps = planCaps({
    stories: o.stories,
    ...(o.budgetMicros !== undefined && { budgetMicros: o.budgetMicros }),
    ...(o.iKnowTheCap && { iKnowTheCap: true }),
    ...(o.articleMethod !== undefined && { articleMethod: o.articleMethod }),
  });
  const rates = requireLivePricing(o.env, o.home);
  const upstreamBaseUrl = requireLiveUpstream(o.env, o.home);
  const upstreamKey = readUpstreamKey(o.env);
  return { caps, upstreamKey, rates, upstreamBaseUrl };
}

// Workflow launch input: reviewed templates and explicit route; the article template and method follow articleMethod.
export function liveLaunchInput(
  caps: LiveCaps,
  instance: string,
  seen: readonly number[] = [],
  articleMethod: ArticleMethod = "static-http",
  pick: readonly number[] = [],
) {
  return {
    instance,
    limit: caps.stories,
    ...(seen.length > 0 && { seen: [...seen] }),
    ...(pick.length > 0 && { pick: [...pick] }),
    workers: {
      articleTemplate: articleMethod === "browser" ? BROWSER_TEMPLATE : CAPTURE_TEMPLATE,
      articleMethod,
      publicEgressAuthorization: "live-operator-run",
      modelTemplate: MODEL_TEMPLATE,
      modelRoute: LIVE_ROUTE,
      modelBudgetMicros: caps.modelBudgetMicros,
      articleBudgetMicros: caps.articleBudgetMicros,
      modelAuthorization: "live-operator-run",
    },
  };
}

// Chromium needs more shared memory than Docker's 64 MB default /dev/shm [knowledge-only: Chromium's documented container requirement].
const BROWSER_SHM_BYTES = 256 * 1024 * 1024;

// Reviewed templates for one article method: the static capture template, or the browser worker template (with its browser budgets and
// shared memory). The model template is the same either way.
export function liveTemplates(articleMethod: ArticleMethod = "static-http"): Template[] {
  const article: Template[] =
    articleMethod === "browser"
      ? [
          {
            id: BROWSER_TEMPLATE,
            provider: LIVE_PROVIDER,
            model: LIVE_MODEL,
            egress: { kind: "audited-public" },
            browser: { ...BROWSER_LIMITS },
            shmBytes: BROWSER_SHM_BYTES,
          },
        ]
      : [{ id: CAPTURE_TEMPLATE, provider: LIVE_PROVIDER, model: LIVE_MODEL, egress: { kind: "audited-public" } }];
  return [
    ...article,
    // TODO(model-egress): `registry` with the empty manifest is the relay-only egress: pomtreed's egressPolicy then grants exactly the node relay
    // endpoints (the agent API and the scoped model proxy) and no registry or public host. `none` is wrong here: it resolves to no relay, so the
    // worker cannot reach the model proxy ("Connection error."). An explicit model-only egress kind is a core contract decision, not made.
    { id: MODEL_TEMPLATE, provider: LIVE_PROVIDER, model: LIVE_MODEL, egress: { kind: "registry" }, allowlist: "analyst" },
  ];
}

// The egress a worker of reviewed template `id` gets: pomtreed's own resolution (egressPolicy, empty env manifest as the live daemon runs
// it) over the template's policy, the agent API and the scoped model proxy. `host`/`generation` matter only for audited-public templates.
export function workerEgress(
  id: string,
  o: { apiUrl?: string; modelBaseUrl: string; host?: HostId; generation?: number; templates?: Template[] },
): SandboxEgress {
  const template = (o.templates ?? liveTemplates()).find((t) => t.id === id);
  if (!template?.egress) throw new Error(`live content: unknown template ${id}`);
  return egressPolicy({
    policy: template.egress,
    manifest: emptyManifest(),
    modelBaseUrl: o.modelBaseUrl,
    ...(o.apiUrl !== undefined && { agentApiUrl: o.apiUrl }),
    ...(o.host !== undefined && { host: o.host }),
    ...(o.generation !== undefined && { generation: o.generation }),
  });
}

function templateStore(templates: Template[]): TemplateStore {
  return {
    resolve: async (id) => structuredClone(templates.find((t) => t.id === id) ?? null),
    list: async () => structuredClone(templates),
  };
}

// ---- Harness: article workers run the static adapter host-side; everything else is Pi. ----

const storyAttribution = (story: string | undefined): Attribution => (story === undefined ? {} : { story });

async function storyOf(daemon: Daemon, agent: AgentRecord): Promise<string | undefined> {
  const byId = new Map<string, { name: string; parent?: string | null }>();
  for (let cur: AgentRecord | null | undefined = agent; cur; cur = cur.parent ? await daemon.get(cur.parent) : undefined) byId.set(cur.id, cur);
  return storyNumberOf(byId, agent.id);
}

export const isArticleTask = (task: string): boolean => task.includes(ARTICLE_TASK_MARK);

// The analyst may call only its page reader and its result tool (TODO(analyst-allowlist)): no bash, read, write, edit, web or jobs tools.
// The table entry is the one definition (agent-image ALLOWLIST_PROFILE_TOOLS); the template names it (`allowlist: "analyst"`) and pomtreed's harnessArgv resolves it.
export const ANALYST_ALLOWLIST = ALLOWLIST_PROFILE_TOOLS.analyst;
// Pi argv for analysis workers, through the same resolution pomtreed uses; article workers get an inert container command (no model, no Pi).
// An analysis spec whose template lacks the analyst profile is refused here too (the default loadout has a shell).
export function liveCommand(task: string, spec?: Pick<SpawnSpec, "allowlist">): string[] {
  if (isArticleTask(task)) return ["sleep", "3600"];
  if (spec?.allowlist !== "analyst") throw new Error("live content: the analysis worker's template does not carry the analyst allowlist profile");
  return harnessArgv(task, { provider: LIVE_PROVIDER, model: LIVE_MODEL, allowlist: spec.allowlist }, { steerExt: true, jobsExt: false });
}

export function createLiveHarness(o: {
  pi: Harness;
  daemon: () => Daemon;
  reports: ReturnType<typeof createReportsExtension>;
  transport: Parameters<typeof runStaticWorker>[1]["transport"];
  transportFor?: (a: Attribution & { agent: string }) => Parameters<typeof runStaticWorker>[1]["transport"]; // attributed host audit; overrides transport
  receipts: Map<string, CaptureReceipt>;
  bounds: ContentBounds; // the static worker's input ceiling and text bound
  articleMethod?: ArticleMethod; // browser: every task, article included, runs in Pi; static-http: article tasks run the static adapter
}): Harness {
  const script = new ScriptHarness(async (c) => {
    const daemon = o.daemon();
    const agent = await daemon.get(c.agent);
    if (!agent) throw new Error("article worker agent missing");
    const abort = new AbortController();
    void c.stopped.then(() => abort.abort());
    let task: { input: ArticleInput };
    try {
      task = JSON.parse(c.prompt.slice(c.prompt.indexOf(ARTICLE_TASK_MARK))) as { input: ArticleInput };
    } catch {
      // TODO(web): a restarted static worker has no prompt to re-read; it fails closed and the story shows as unavailable.
      await daemon.submitResult(c.agent, "failed", { summary: "static article worker cannot resume without its task" }, "article-failed");
      return;
    }
    try {
      const result = await runStaticWorker(task.input, {
        worker: c.agent,
        generation: agent.generation,
        signal: abort.signal,
        profile: "audited-public",
        transport: o.transportFor ? o.transportFor({ agent: c.agent, ...storyAttribution(await storyOf(daemon, agent)) }) : o.transport,
        publish: async (name, bytes) => {
          const got = await o.reports.publish(c.agent, {
            name,
            ...(name.endsWith(".md") && { mediaType: "text/plain" }),
            content: bytes,
            generation: agent.generation,
            key: name,
          });
          return { id: got.report.id, sha256: got.report.sha256 };
        },
        record: async (receipt) => {
          o.receipts.set(`${c.agent}:${agent.generation}`, receipt);
        },
        bounds: o.bounds,
      });
      await daemon.submitResult(c.agent, "succeeded", result, "article-result");
    } catch (e) {
      await daemon.submitResult(
        c.agent,
        "failed",
        { summary: `static article capture failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` },
        "article-failed",
      );
    }
  });
  const hostsArticles = o.articleMethod !== "browser";
  return {
    start: (opts) => (hostsArticles && isArticleTask(opts.prompt) ? script.start(opts) : o.pi.start(opts)),
    resume: (opts) => (hostsArticles && opts.sessionRef.startsWith("sess-") ? script.resume(opts) : o.pi.resume(opts)),
  };
}

// Article transport: resolve, refuse any blocked address, pin the connection to the validated address, record via the audited fetch.
// onDeny records a refusal that happens before the audited fetch is reached (otherwise it would leave no host audit record).
export function pinnedTransport(
  audited: FetchFn,
  resolveDns: (h: string) => Promise<{ address: string; family: number }[]>,
  onDeny?: (url: string, reason: HostDenyReason) => void,
): Parameters<typeof runStaticWorker>[1]["transport"] {
  return async (url, init) => {
    const hostname = new URL(url).hostname;
    let addrs: { address: string; family: number }[];
    try {
      addrs = await resolveDns(hostname);
    } catch (e) {
      onDeny?.(url, "dns");
      throw e;
    }
    const first = addrs[0];
    if (!first || addrs.some((a) => isBlockedAddress(a.address))) {
      onDeny?.(url, first ? "private" : "dns");
      throw new Error(`article host ${hostname} resolves to a blocked or empty address set`);
    }
    return audited(url, { redirect: "manual", signal: init.signal, pin: { hostname, address: first.address, family: first.family } });
  };
}

// ---- Browser image: the pieces the browser worker starts from, checked in a short container before any model request. ----

export const BROWSER_IMAGE_PATHS = {
  chromium: "/usr/bin/chromium", // Debian's chromium package (packages/agent-image/Dockerfile); browser-run.ts spawns `chromium`
  extension: "/opt/pomtree/ext/pomtree-browser/index.ts",
  runner: "/opt/pomtree/browser-run.ts",
} as const;

// The check command: the first missing piece is named on stdout and the command exits 1; all present prints BROWSER-IMAGE-OK.
export function browserImageCheckCommand(): string[] {
  const checks: [string, string][] = [
    ["-x", BROWSER_IMAGE_PATHS.chromium],
    ["-f", BROWSER_IMAGE_PATHS.extension],
    ["-f", BROWSER_IMAGE_PATHS.runner],
  ];
  const script = `${checks.map(([flag, path]) => `(test ${flag} ${path} || { echo "MISSING ${path}"; exit 1; })`).join(" && ")} && echo BROWSER-IMAGE-OK`;
  return ["sh", "-c", script];
}

export type BrowserImageProbe = (cmd: string[]) => Promise<{ code: number; output: string }>;

// ---- Runtime ----

// The delivered (`container: true`) subset of one resolved value set: what the embedded Daemon writes into each container as
// PTREE_CONFIG_JSON, so the browser worker runs with exactly the bounds the host verifier checks.
export function liveContainerConfig(config: ContentConfig): ContainerConfigValues {
  return Object.fromEntries(containerParamDefs(CONFIG_REGISTRY).map((p) => [p.path, config[p.path as keyof ContentConfig]])) as ContainerConfigValues;
}

export interface LiveWiring {
  sandbox: Sandbox;
  placement: DaemonDeps["placement"];
  workspace: Workspace;
  onAdmit?: (f: (agent: AgentId, host: string) => void) => void; // HostPlacement admission hook; fakes have none
}

const dockerBridgeGateway = () => detectBridgeGateway(async (c, a) => execFileSync(c, a, { encoding: "utf8", timeout: 10_000 }));

export interface LiveContentOptions {
  stateDir: string; // private per-run state: pomtreed.sqlite, reports/, sessions/, mirror.git, workspaces/, egress-audit/
  repoDir: string; // existing git repo used only as the clone base
  caps: LiveCaps;
  upstreamKey: string; // OpenRouter key from preflightLive; in memory only
  modelFetch: typeof globalThis.fetch; // transport to the model upstream (the proxy forwards through it)
  sourceFetch?: FetchFn; // inner transport for HN and article GETs; default is the DNS-pinning defaultFetch
  resolveDns?: (h: string) => Promise<{ address: string; family: number }[]>;
  image?: string;
  templates?: Template[]; // test seam: replaces liveTemplates() (the negative smoke test reintroduces egress `none`)
  upstreamBaseUrl: string; // model upstream the proxy forwards to: the catalog baseUrl (preflightLive), or a local stub in tests
  sessionMs?: number;
  log?: (line: string) => void;
  // Test seams (offline composition): replace the Pi harness, the Docker/git wiring and the egress spool reader.
  piHarness?: (deps: { sessionRoot: string }) => Harness;
  wire?: (a: { hostId: string; store: Store; sessionRoot: string; image: string; egressAuditRoot: string }) => LiveWiring;
  egressReader?: EgressAuditReader;
  hostAuditLog?: string; // visible JSONL file; host audit records are appended as they occur so a crash keeps them
  bridgeGateway?: () => Promise<string | undefined>; // test seam: the Linux docker bridge gateway to bind (default asks the Docker CLI); offline tests inject one so they need no Docker
  articleMethod?: ArticleMethod; // default static-http; browser routes article tasks to Pi with the capture-browser template
  // The resolved registry values (content-live.mts resolveLiveConfig); default the registry defaults. workflow.fetch.userAgent arrives
  // resolved (never blank; the capture broker refuses an invalid one at construction). The content bounds, the daemon's
  // report limits and the container document all come from this one set.
  config?: ContentConfig;
}

export interface SpendSummary {
  totalMicros: number;
  byAgent: { agent: string; name: string; parent: string | null; spentMicros: number | null; budgetMicros: number | null }[]; // null: the read failed (see errors)
  byStory: Record<string, number>;
  unattributedMicros: number; // spend by agents not under any story-N agent (the root, workflow agents)
  errors: { agent: string; name: string; error: string }[]; // spend reads that failed; never counted as 0
}

export interface LiveContentRuntime {
  daemon: Daemon;
  stores: Store;
  host: WorkflowHost;
  extensions: ExtensionRegistryImpl;
  reportStore: ReportStore;
  root: AgentRecord;
  hostAudit: AuditedFetch;
  bounds: ContentBounds; // the bounds every content check of this runtime uses (from LiveContentOptions.config)
  // The node relay ports this run grants workers (agent API, scoped model proxy) at the Docker host alias; the no-private-ranges
  // assertion exempts exactly these.
  relayPorts: readonly number[];
  cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }>;
  // The environment a spawned real `pomtree` needs to reach this runtime's operator socket (POMTREE_SOCKET, POMTREE_TOKEN). The token is a secret: it goes
  // only into a child's env option, never argv, a file or a log line (it is also in the redaction list).
  operatorEnv(): { POMTREE_SOCKET: string; POMTREE_TOKEN: string };
  hostPost(body: InboundMessage): Promise<MessageReceipt>;
  // Fails with `model proxy unreachable from container via <url>: <reason>` unless a container with the grounded-model worker's network shape
  // reaches the scoped model proxy (no credential, no model call, no spend). Run it before launching; `probe` defaults to a short container.
  assertModelRoute(probe?: ModelRouteProbe, template?: string): Promise<void>;
  // Fails with `browser image <image> is not ready: <what is missing>` unless the image has the browser worker's Chromium and runner files.
  // `probe` runs browserImageCheckCommand in a short container with no egress and one empty workspace directory (default: DockerSandbox).
  assertBrowserImage(probe?: BrowserImageProbe): Promise<void>;
  ingestEgress(): Promise<void>;
  egressRecords(): Promise<EgressAuditRecord[]>;
  spend(): Promise<SpendSummary>;
  close(): Promise<void>;
}

export async function openLiveContentRuntime(o: LiveContentOptions): Promise<LiveContentRuntime> {
  const log = o.log ?? ((line: string) => console.error(`live-content: ${line}`));
  const image = o.image ?? APPROVED_IMAGE;
  const articleMethod: ArticleMethod = o.articleMethod ?? "static-http";
  const config = o.config ?? CONTENT_CONFIG_DEFAULTS;
  const bounds = contentBounds(config);
  const hostId = `live-${randomBytes(6).toString("hex")}`;
  const teardown: { label: string; run: () => Promise<void>; retainStoreOnFailure?: boolean }[] = [];
  const secret = randomBytes(32).toString("hex");
  const openSecrets = [secret, o.upstreamKey, o.stateDir, o.repoDir];
  try {
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    const store = openDaemonStore(join(o.stateDir, "pomtreed.sqlite"));
    teardown.push({ label: STORE_LABEL, run: async () => store.close() });
    const socketPath = join(o.stateDir, `l-${randomBytes(4).toString("hex")}.sock`);
    const sessionRoot = join(o.stateDir, "sessions");
    mkdirSync(join(o.stateDir, "egress-audit"), { recursive: true, mode: 0o700 });
    const egressAuditRoot = join(realpathSync(o.stateDir), "egress-audit"); // the spool reader refuses symlinked paths (macOS tmpdir)
    const extensionDir = join(o.stateDir, "extensions");
    mkdirSync(extensionDir, { recursive: true });

    const reportStore: ReportStore = new DirReportStore({ root: join(o.stateDir, "reports"), registry: store.registry });
    const reports = createReportsExtension({ store: reportStore, reportMaxBytes: bounds.reportMaxBytes });

    let auditLogFailed = false;
    const hostAudit = createAuditedFetch(o.sourceFetch ?? defaultFetch, {
      maxBodyBytes: bounds.auditBodyMaxBytes,
      sink: (rec, phase) => {
        if (o.hostAuditLog === undefined) return;
        try {
          mkdirSync(dirname(o.hostAuditLog), { recursive: true });
          appendFileSync(o.hostAuditLog, `${JSON.stringify({ ...rec, phase })}\n`);
        } catch (e) {
          if (!auditLogFailed) log(`host audit log ${o.hostAuditLog} is not writable (${redactMessage(e, openSecrets)}); records stay in memory only`);
          auditLogFailed = true;
        }
      },
    });
    // One detection serves the model proxy and the agent endpoint (Linux only; elsewhere both bind loopback).
    const bridge = process.platform === "linux" ? await (o.bridgeGateway ?? dockerBridgeGateway)() : undefined;
    const live = await startLiveModel({
      ...(bridge !== undefined && { gateway: bridge }),
      store,
      secret,
      stateDir: o.stateDir,
      provider: LIVE_PROVIDER,
      env: {
        ...modelCatalogEnv(process.env),
        POMTREED_MODEL_BASE_URL: o.upstreamBaseUrl,
        POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS: String(o.caps.maxRequestMicros),
      },
      // The key already read from its key file, in memory only: never an env entry a child could inherit.
      upstreamKey: o.upstreamKey,
      // TODO(identity): the model proxy's ctx carries agent and requestId, which the rows take, but the story is not resolved
      // here: the agent registry is async, so no sync resolver is passed. Current behavior: model rows have no story at open;
      // the outputs resolve it afterwards by storyNumberOf over the registry.
      fetch: auditedModelFetch(hostAudit, o.modelFetch),
    });
    teardown.push({ label: "model proxy close", run: () => live.close() });

    const resolveDns = o.resolveDns ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => ({ address: a.address, family: a.family })));
    const receipts = new Map<string, CaptureReceipt>();

    // The same capture broker pomtreed wires (capture-wiring.ts): robots.txt, the shared cache and provenance, over this store.
    const capture = wireCaptureBroker({
      stores: store,
      quota: store.quotaCounters(),
      reports: reportStore,
      daemon: { root: () => daemon.root(), captureRecord: (agent, payload, key) => daemon.captureRecord(agent, payload, key) },
      hostId,
      userAgent: config["workflow.fetch.userAgent"],
      log: (line) => log(`capture: ${line}`),
      fetch: hostAudit.fetch,
      ...(o.resolveDns && { resolveDns: o.resolveDns }),
    });
    teardown.push({ label: "capture broker close", run: () => capture.close() });
    let daemon!: Daemon;
    const services: WorkflowCapabilityServices = {
      root: () => daemon.root(),
      agent: (id) => daemon.get(id),
      readRoot: (from, limit) => daemon.workflowReadRoot(from, limit),
      recordRoot: (payload, key) => daemon.workflowRecord(payload, key),
      publishRoot: async (req) => {
        const root = await daemon.root();
        const { report } = await reports.publish(root.id, {
          name: req.name,
          ...(req.mediaType !== undefined && { mediaType: req.mediaType }),
          generation: root.generation,
          key: req.key,
          content: req.content,
        });
        return report;
      },
      sendToUser: (body, key) => daemon.workflowMessage(body, key),
      ask: async (agent, req) => ({ escalation: (await daemon.ask(agent, req)).escalation.id }),
      now: () => daemon.now(),
      redactText: (text) => daemon.redactText(text),
      capture,
    };
    const host = new WorkflowHost({
      reportCeilingBytes: bounds.reportCeilingBytes,
      registry: () => store.registry,
      reviewed: (ext) => ext === "hn-content",
      startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
      log: (line) => log(`workflow: ${line}`),
      services: () => services,
    });
    const extensions = createExtensionRegistry({
      hostId,
      now: () => daemon.now(),
      registry: store.registry,
      journal: store.journal,
      mailbox: store.mailbox,
      root: () => daemon.root(),
      workflows: host,
      log: (line) => log(`extensions: ${line}`),
    });

    let apiUrl: string | undefined;
    const wiring: LiveWiring =
      o.wire?.({ hostId, store, sessionRoot, image, egressAuditRoot }) ??
      (() => {
        const workspace = new GitWorkspace({ repoDir: o.repoDir, mirrorDir: join(o.stateDir, "mirror.git"), foldersRoot: join(o.stateDir, "workspaces") });
        const w = wireLocalHost({
          hostId,
          hosts: store.hosts,
          workspace,
          sessionRoot,
          image,
          capacity: { maxSessions: 4 },
          makeSandbox: (mounts) => new DockerSandbox({ mounts, egressAuditRoot }),
        });
        return { sandbox: w.sandbox, placement: w.placement, workspace, onAdmit: (f) => w.placement.onAdmit(f) };
      })();
    const reader = o.egressReader ?? new DiskEgressAudit({ root: egressAuditRoot });
    const collector = new EgressAuditCollector({ reader, journal: store.journal, root: () => daemon.root() });
    const templates = o.templates ?? liveTemplates(articleMethod);
    const orchestrator = new LocalOrchestrator();
    const piHarness = o.piHarness?.({ sessionRoot }) ?? createPiHarness({ sink: (agent) => fileTailSource(join(sessionRoot, agent, PI_SINK_FILE)) });
    const sessionMs = o.sessionMs ?? LIVE_DEFAULT_DEADLINE_MS;
    const deps: DaemonDeps = {
      hostId,
      secret,
      fetchUserAgent: config["workflow.fetch.userAgent"], // the browser workers' identity, the same value the capture broker sends
      image,
      defaultSessionMs: sessionMs,
      maxSessionMs: sessionMs,
      rootBudgetMicros: o.caps.rootBudgetMicros,
      defaultBudgetMicros: Math.floor(o.caps.modelBudgetMicros / o.caps.stories),
      sandboxSocketPath: "/run/pomtreed.sock",
      socketHostPath: socketPath,
      agentApiUrl: () => apiUrl,
      registry: store.registry,
      journal: store.journal,
      mailbox: store.mailbox,
      sandbox: wiring.sandbox,
      workspace: wiring.workspace,
      harness: createLiveHarness({
        pi: piHarness,
        daemon: () => daemon,
        reports,
        transport: pinnedTransport(hostAudit.fetch, resolveDns),
        transportFor: (a) =>
          pinnedTransport(hostAudit.attributed(a), resolveDns, (url, denyReason) =>
            hostAudit.recordCall({ url, method: "GET", attribution: a }).finish({ outcome: "denied", denyReason }),
          ),
        receipts,
        bounds,
        articleMethod,
      }),
      gateway: live.gateway,
      command: (task, spec) =>
        articleMethod === "browser" && isArticleTask(task) ? browserArgv(task, { provider: LIVE_PROVIDER, model: LIVE_MODEL }) : liveCommand(task, spec),
      credentials: live.credentials,
      graceMs: 10_000,
      admitRetryMs: 500,
      checkpoints: store.checkpoints,
      sessions: store.sessions,
      sessionRoot,
      terminal: { size: { cols: 80, rows: 24 }, env: PI_TTY_ENV, sinkFile: PI_SINK_FILE },
      escalations: store.escalations,
      approvals: store.approvals,
      channels: buildChannelRegistry([CHANNEL], [CHANNEL]),
      messagingAllowSpawn: false,
      watchdogs: store.watchdogs,
      schedules: store.schedules,
      reportStore,
      reportMaxBytes: bounds.reportMaxBytes,
      containerConfig: liveContainerConfig(config),
      placement: wiring.placement,
      orchestrator,
      templates: templateStore(templates),
      mayUseTemplate: (_caller, t) => templates.some((x) => x.id === t.id),
      models: { list: async () => ({ source: "pi", models: [{ provider: LIVE_PROVIDER, id: LIVE_MODEL }] }) },
      publicEgressReady: () => collector.healthy(),
      deterministicExecutors: host.executors,
      extensionHost: extensions,
      launchWorkflow: (requester, req) => host.launch(requester, req),
      allowChatWorkflow: () => false,
      authorizeInbound: (msg) => msg.sender.sender === CHAT_SENDER,
      chatApproval: () => false,
    };
    daemon = new Daemon(deps);
    teardown.push({ label: "lifecycle settlement", run: () => orchestrator.idle(), retainStoreOnFailure: true });
    wiring.onAdmit?.((agent) => daemon.admitted(agent));

    extensions.registerBuiltin(reports);
    extensions.registerBuiltin(
      createContentExtension({
        registry: store.registry,
        reports: reportStore,
        root: () => daemon.root(),
        bounds,
        authority:
          articleMethod === "browser"
            ? createJournalCaptureAuthority({
                registry: store.registry,
                journal: store.journal,
                approvedWorker: (a) => approvedBrowserWorker(a, image),
                bounds,
              })
            : { receipt: async (worker, generation) => receipts.get(`${worker}:${generation}`) ?? null },
      }),
    );
    teardown.push({ label: EXTENSIONS_LABEL, run: () => extensions.stopAll({ throwOnStopFailure: true }), retainStoreOnFailure: true });
    await extensions.load(extensionDir);
    await extensions.startAll();

    // Bind where pomtreed binds its agent endpoint (loopback on Docker Desktop, the bridge gateway on Linux); containers use host.docker.internal.
    const plan = await agentBindPlan(process.platform, async () => bridge);
    const agents = await listenAgents(daemon, plan.host, 0);
    apiUrl = `http://host.docker.internal:${agents.port}`;
    teardown.push({ label: "agent server close", run: () => closeServer(agents.server) });
    const socket = await listen(daemon, socketPath);
    teardown.push({ label: "operator socket close", run: () => closeServer(socket) });
    const hostListen = await listenHost(daemon, "127.0.0.1", 0);
    teardown.push({ label: "host server close", run: () => closeServer(hostListen.server) });

    const root = await daemon.root();
    const operatorToken = issueToken(secret, { scope: "operator" });
    const hostToken = issueToken(secret, { scope: "host", channel: CHANNEL });
    const secrets = [...openSecrets, operatorToken, hostToken];

    const ingestEgress = async () => {
      try {
        await collector.ingest();
      } catch (e) {
        log(`egress audit ingestion failed; new public worker admission is closed (${redactMessage(e, secrets)})`);
      }
    };
    await ingestEgress();
    const timer = setInterval(() => void ingestEgress(), 1000);
    timer.unref?.();
    teardown.push({ label: "egress audit timer", run: async () => clearInterval(timer) });

    const recordedAgents = async (): Promise<AgentRecord[]> => store.registry.list({ excludeState: "reaped" });
    let closing: Promise<void> | undefined;
    const runClose = async (): Promise<void> => {
      const ledger: CloseLedger = { failures: [], unjoined: false };
      const deadline = Date.now() + SHUTDOWN_BOUND_MS;
      const step = <T,>(label: string, work: () => Promise<T>) => boundedStep(label, work, deadline, ledger, secrets);
      await step("daemon shutdown", () => daemon.shutdown(deadline));
      const drained = await step("drain", () =>
        host.drainSafe({
          deadlineAt: deadline,
          now: () => Date.now(),
          cancel: (id, graceMs) => daemon.cancel(id, graceMs).then(() => {}),
          tick: sleepTick,
          race: (p) => raceUntil(p, deadline),
        }),
      );
      if (drained === undefined) ledger.unjoined = true;
      else if (!drained.complete) ledger.failures.push(`drain: incomplete (retained ${JSON.stringify(drained.retained)})`);
      if (drained && drained.retained.length > 0) ledger.unjoined = true;
      const snapshot = await step("list recorded agents", recordedAgents);
      if (snapshot === undefined) ledger.unjoined = true;
      const recorded = snapshot ?? [];
      const recordedSandboxes = new Set<SandboxRef>(recorded.map((a) => a.sandbox).filter((s): s is SandboxRef => s != null));
      await Promise.all(recorded.map((a) => step(`cancel ${a.id}`, () => daemon.cancel(a.id, CANCEL_GRACE_MS))));
      if (recordedSandboxes.size > 0) {
        const listed = await step("list sandboxes", () => wiring.sandbox.list(sandboxOwner({ hostId, storeId: "" }, daemon.epoch)));
        if (listed) {
          const physical = new Set<string>(listed.map((s) => s.id));
          for (const id of recordedSandboxes) if (physical.has(id)) await step(`kill ${id}`, () => wiring.sandbox.kill(id, sandboxOpKey("kill", id)));
        }
      }
      const joined = await joinLifecycle(orchestrator, deadline, ledger, secrets);
      await step("final egress ingest", ingestEgress);
      if (drained !== undefined && joined) {
        const stopped = await step("extensions shutdown", () =>
          extensions.stopForShutdown(drained.retained, { throwOnStopFailure: true, deadlineAt: deadline }),
        );
        if (stopped === undefined) ledger.unjoined = true;
      } else ledger.failures.push("extensions shutdown: skipped because drain ownership or lifecycle settlement is unknown");
      if (joined) for (const a of recorded) await step(`unstage ${a.id}`, async () => live.credentials.unstage(a.id as AgentId));
      else ledger.failures.push("credentials cleanup: skipped because lifecycle settlement is unknown");
      await teardownResources(
        teardown.filter((t) => t.label !== EXTENSIONS_LABEL && t.label !== "lifecycle settlement"),
        deadline,
        ledger,
        secrets,
      );
      if (ledger.failures.length > 0) throw new Error(`live content close had failures: ${ledger.failures.join("; ")}`);
    };

    const rt: LiveContentRuntime = {
      daemon,
      stores: store,
      host,
      extensions,
      reportStore,
      root,
      hostAudit,
      bounds,
      relayPorts: [agents.port, live.bind.port],
      async cli(argv) {
        const out: string[] = [];
        const err: string[] = [];
        const io: Io = {
          call: socketTransport(socketPath, operatorToken),
          out: (s) => out.push(s),
          err: (s) => err.push(s),
          isTTY: false,
          version: "0.0.0",
          cwd: o.stateDir,
        };
        const code = await run(argv, io);
        return { code, out, err };
      },
      operatorEnv: () => ({ POMTREE_SOCKET: socketPath, POMTREE_TOKEN: operatorToken }),
      async hostPost(body) {
        const res = await fetch(`http://127.0.0.1:${hostListen.port}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) return { kind: "rejected", reason: `${res.status}: ${text}` };
        return JSON.parse(text) as MessageReceipt;
      },
      async assertModelRoute(probe, template = MODEL_TEMPLATE) {
        const baseUrl = `http://host.docker.internal:${live.bind.port}`;
        // audited-public needs immutable host and generation attribution to resolve; the probe is not a worker, so its generation is 0.
        const egress = workerEgress(template, {
          ...(apiUrl !== undefined && { apiUrl }),
          modelBaseUrl: baseUrl,
          templates,
          host: hostId,
          generation: 0,
        });
        // The default probe runs its own short DockerSandbox: the wired one resolves workspace mounts only for admitted agents.
        const dockerProbe: ModelRouteProbe = async (url) => {
          const work = mkdtempSync(join(tmpdir(), "hn-route-"));
          try {
            chmodSync(work, 0o755);
            const mounts: MountProvider = {
              resolve: async (_a, m) => ({ type: "bind", hostPath: work, containerPath: m.kind === "workspace" ? m.containerPath : "/work", readOnly: false }),
            };
            const spec = {
              agent: "live-model-pre" as AgentId,
              image,
              mounts: [{ kind: "workspace" as const, workspace: "route-probe", containerPath: "/work" }],
              egress,
            };
            return await sandboxModelRouteProbe(new DockerSandbox({ mounts, egressAuditRoot }), spec)(url);
          } finally {
            rmSync(work, { recursive: true, force: true });
          }
        };
        await assertModelProxyReachable({ platform: process.platform, bind: live.bind, baseUrl, egress, probe: probe ?? dockerProbe });
      },
      async assertBrowserImage(probe) {
        const run: BrowserImageProbe =
          probe ??
          (async (cmd) => {
            // The sandbox spec requires exactly one workspace mount; an empty throwaway directory serves, as in the model-route probe.
            const work = mkdtempSync(join(tmpdir(), "hn-image-"));
            try {
              chmodSync(work, 0o755);
              const mounts: MountProvider = {
                resolve: async (_a, m) => ({
                  type: "bind",
                  hostPath: work,
                  containerPath: m.kind === "workspace" ? m.containerPath : "/work",
                  readOnly: false,
                }),
              };
              const sandbox = new DockerSandbox({ mounts, egressAuditRoot });
              const h = await sandbox.start(
                {
                  host: "host-test",
                  generation: 0,
                  agent: "live-browser-image-pre" as AgentId,
                  image,
                  mounts: [{ kind: "workspace" as const, workspace: "image-probe", containerPath: "/work" }],
                  egress: { allow: [] },
                  env: {},
                  cmd,
                },
                `browser-image-check:${Date.now()}`,
              );
              let output = "";
              try {
                for await (const part of h.output()) output += part.chunk;
                const { exitCode } = await h.wait();
                return { code: exitCode, output };
              } finally {
                await sandbox.kill(h.id, sandboxOpKey("kill", h.id)).catch(() => {});
              }
            } finally {
              rmSync(work, { recursive: true, force: true });
            }
          });
        const result = await run(browserImageCheckCommand());
        if (result.code !== 0 || !result.output.includes("BROWSER-IMAGE-OK"))
          throw new Error(`browser image ${image} is not ready: ${result.output.trim().slice(0, 200) || `exit ${result.code}`}`);
      },
      ingestEgress,
      async egressRecords() {
        const out: EgressAuditRecord[] = [];
        for (let from = 0; ; ) {
          const page = await store.journal.read({ agent: root.id, from, limit: 500 });
          for (const e of page) if (e.payload.kind === EGRESS_AUDIT_KIND) out.push(e.payload.source as unknown as EgressAuditRecord);
          const last = page.at(-1);
          if (page.length < 500 || !last) return out;
          from = last.seq + 1;
        }
      },
      async spend() {
        const all = await store.registry.list();
        const byAgent: SpendSummary["byAgent"] = [];
        const errors: SpendSummary["errors"] = [];
        for (const a of all) {
          try {
            const s = await live.gateway.spend(a.id);
            byAgent.push({ agent: a.id, name: a.name, parent: a.parent ?? null, spentMicros: s.spentMicros, budgetMicros: s.budgetMicros });
          } catch (e) {
            byAgent.push({ agent: a.id, name: a.name, parent: a.parent ?? null, spentMicros: null, budgetMicros: null });
            errors.push({ agent: a.id, name: a.name, error: redactMessage(e, openSecrets).slice(0, 200) });
          }
        }
        const byId = new Map(all.map((a) => [a.id as string, a]));
        const byStory: Record<string, number> = {};
        let unattributedMicros = 0;
        for (const row of byAgent) {
          if (row.spentMicros === null) continue;
          const story = storyNumberOf(byId, row.agent);
          if (story === undefined) unattributedMicros += row.spentMicros;
          else byStory[story] = (byStory[story] ?? 0) + row.spentMicros;
        }
        // TODO(hn-insights): per-call rows (model, tokens) need the debit table to carry them; it has request ids only today.
        return { totalMicros: byAgent.reduce((n, r) => n + (r.spentMicros ?? 0), 0), byAgent, byStory, unattributedMicros, errors };
      },
      close() {
        closing ??= runClose();
        return closing;
      },
    };
    return rt;
  } catch (e) {
    const failures = await teardownPartialOpen(teardown.splice(0), openSecrets);
    const base = redactMessage(e, openSecrets);
    throw new Error(failures.length > 0 ? `${base}; teardown failures: ${failures.join("; ")}` : base);
  }
}

async function closeServer(s: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  });
}
