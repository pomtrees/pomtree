// Real-model runtime factory for the hn-digest follow-on. It wires the production stack (SQLite store, dir reports, git workspace,
// DockerSandbox via wireLocalHost, Pi harness, the controller key-issuing model proxy from startLiveModel, the operator CLI socket
// and host-channel listener) for one direct DeepSeek route. This module never runs anything by itself: nothing starts at import, no
// Docker/provider/auth call happens unless a caller invokes openModelRuntime. The upstream key is held in memory only, is passed to
// the proxy env object and nowhere else, and is never read from an auth file here. The caller must pass a guarded fetch.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { type AgentId, type AgentRecord, CONFIG_DEFAULTS, type ReportStore, type Sandbox, userAgentReason } from "../../packages/core/src/index.ts";
import { type LiveModel, startLiveModel } from "../../packages/e2e/src/live-model.ts";
import { createPiHarness, fileTailSource, PI_AUTH_PATH, PI_SINK_FILE, PI_TTY_ENV, piArgv } from "../../packages/harness-pi/src/index.ts";
import { type Io, run } from "../../packages/pomtree/src/cli.ts";
import { socketTransport } from "../../packages/pomtree/src/client.ts";
import { issueToken } from "../../packages/pomtreed/src/auth.ts";
import { createReportsExtension } from "../../packages/pomtreed/src/builtin/reports.ts";
import { wireCaptureBroker } from "../../packages/pomtreed/src/capture-wiring.ts";
import { buildChannelRegistry } from "../../packages/pomtreed/src/channels.ts";
import { Daemon } from "../../packages/pomtreed/src/daemon.ts";
import { openDaemonStore } from "../../packages/pomtreed/src/daemon-store.ts";
import type { DaemonDeps, InboundMessage, MessageReceipt } from "../../packages/pomtreed/src/daemon-types.ts";
import type { FetchFn } from "../../packages/pomtreed/src/ext-gateway.ts";
import { createExtensionRegistry, type ExtensionRegistryImpl } from "../../packages/pomtreed/src/extensions.ts";
import { wireLocalHost } from "../../packages/pomtreed/src/local-host.ts";
import { openPiCatalog } from "../../packages/pomtreed/src/model-proxy/pi-catalog.ts";
import { LocalOrchestrator } from "../../packages/pomtreed/src/orchestrator.ts";
import { type PiCredentials, type ProxyModelOverride, proxyPiCredentials } from "../../packages/pomtreed/src/pi-auth.ts";
import { listen, listenAgents, listenHost } from "../../packages/pomtreed/src/server.ts";
import type { WorkflowCapabilityServices } from "../../packages/pomtreed/src/workflow-capabilities.ts";
import { raceUntil, sleepTick, WorkflowHost } from "../../packages/pomtreed/src/workflows.ts";
import { DirReportStore } from "../../packages/report-dir/src/index.ts";
import { DockerSandbox } from "../../packages/sandbox-docker/src/index.ts";
import type { Store } from "../../packages/store-sqlite/src/index.ts";
import { GitWorkspace } from "../../packages/workspace-git/src/index.ts";
import { boundedStep, type CloseLedger, redactMessage } from "./runtime.mts";

export const MODEL_PROVIDER = "deepseek";
export const MODEL_ID = "deepseek-flash";
export const MODEL_UPSTREAM = "https://api.deepseek.com";
export const MODEL_MAX_OUTPUT_TOKENS = 1024;
export const MODEL_BUDGET_MICROS = 100_000;
export const MODEL_DEADLINE_CAP_MS = 120_000;
// Immutable project agent image approved for the live path (digest, never a tag).
export const APPROVED_IMAGE = "pomtree/agent@sha256:37ac0cd17626a2ad50d2c64533039fa1c9fdbd252988df214d7abb9145fae2e2";
export const REVIEWED_OWNERS = ["hn-insight"] as const;
const CHANNEL = "discord";
const CHAT_SENDER = "u1";
// One absolute deadline for the whole close(): every step in it is bounded by the same instant (see boundedStep).
export const SHUTDOWN_BOUND_MS = 5_000;
const STORE_LABEL = "store close";
const EXTENSIONS_LABEL = "extensions stop"; // close() already ran stopForShutdown; stopAll is for the open-failure path only
const CANCEL_GRACE_MS = 1_000;
type SandboxRef = NonNullable<AgentRecord["sandbox"]>;

// Built-in deepseek-flash metadata from the approved image's Pi (1.1.0); the 1024 cap is the only output limit we allow.
// Reasoning stays on (no --thinking flag is added): the installed Pi 1.3.0 documents --thinking, but the approved image's Pi is
// not verifiable offline. Reasoning tokens count against max_tokens, so an empty or truncated answer is caught by the consumer's
// output validation, not by this factory.
export const DEEPSEEK_FLASH_OVERRIDE: ProxyModelOverride = {
  id: MODEL_ID,
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  compat: {
    maxTokensField: "max_tokens",
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: true,
  },
};

export interface ModelRuntimeOptions {
  stateDir: string; // private per-run state: pomtreed.sqlite, reports/, sessions/, mirror.git, workspaces/
  repoDir: string; // existing git repo used only as the clone base; never initialised, committed or pushed here
  extensionDir: string; // directory of extension subdirs (manifest + entry) loaded for real
  upstreamKey: string; // DeepSeek key, held in memory only; the caller reads it. Never written, logged or given to an agent
  fetch: typeof globalThis.fetch; // caller-guarded transport; forwarded to the model proxy; no default raw fetch
  image?: string; // defaults to the approved digest
  // Optional transport for workflow source GETs only (never the model upstream). Absent = explicit refusal, no ambient default.
  sourceFetch?: FetchFn;
  // The resolved workflow.fetch.userAgent for the capture broker. Never blank: config resolution maps unset or blank to the default, and an
  // empty or invalid value is an invariant violation refused here, before anything opens.
  fetchUserAgent: string;
}

export interface ModelRuntime {
  daemon: Daemon;
  stores: Store;
  host: WorkflowHost;
  extensions: ExtensionRegistryImpl;
  reports: ReturnType<typeof createReportsExtension>;
  sandbox: Sandbox;
  root: AgentRecord;
  modelBinding: { provider: string; model: string; image: string };
  cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }>;
  hostPost(body: InboundMessage): Promise<MessageReceipt>;
  // Drains the host-owned workflow tree, cancels every non-reaped agent recorded in this run's own store, kills only sandboxes
  // physically listed AND recorded on those agents, unstages their credentials, then closes extensions, HTTP, proxy and store.
  // Every step shares one absolute deadline. Idempotent: repeat calls return the first result. Throws an aggregate, redacted
  // error if any step failed or timed out; it never reports a clean close after a failed or unjoined step.
  close(): Promise<void>;
}

// Pure, no-side-effect validation of the caller's options. Throws before anything is opened or bound.
export function validateModelRuntimeOptions(o: ModelRuntimeOptions): void {
  for (const k of ["stateDir", "repoDir", "extensionDir"] as const) {
    if (typeof o[k] !== "string" || o[k].trim() === "") throw new Error(`openModelRuntime: ${k} must be a nonempty path`);
  }
  if (typeof o.upstreamKey !== "string" || o.upstreamKey.trim() === "") throw new Error("openModelRuntime: upstreamKey is required");
  if (typeof o.fetch !== "function") throw new Error("openModelRuntime: a caller-guarded fetch is required");
  if (o.image !== undefined && o.image !== APPROVED_IMAGE) throw new Error("openModelRuntime: only the approved agent image digest is accepted");
  if (o.sourceFetch !== undefined && typeof o.sourceFetch !== "function") throw new Error("openModelRuntime: sourceFetch must be a function when provided");
  const uaProblem = typeof o.fetchUserAgent !== "string" ? "not a string" : o.fetchUserAgent === "" ? "empty" : userAgentReason(o.fetchUserAgent);
  if (uaProblem !== null)
    throw new Error(
      `openModelRuntime: fetchUserAgent is ${uaProblem === "empty" || uaProblem === "not a string" ? uaProblem : `invalid: ${uaProblem}`}; pass the value resolved from workflow.fetch.userAgent (resolveConfig), which is never blank`,
    );
}

// Source-GET transport selector. Provided -> that function. Absent -> a refusing FetchFn that throws before any network use.
// It never falls back to the model fetch, the upstream key, or the gateway's ambient default.
export function selectSourceTransport(o: Pick<ModelRuntimeOptions, "sourceFetch">): FetchFn {
  if (o.sourceFetch !== undefined) return o.sourceFetch;
  return async () => {
    throw new Error("openModelRuntime: no source fetch transport configured; workflow source GETs are refused");
  };
}

// Pi argv for the deepseek-flash child: the existing piArgv output with `--thinking off` inserted right after argv[0] ("pi"),
// before the "--" separator. Verified against the approved image's Pi 1.1.0 source: off maps to thinking:{type:"disabled"} for
// deepseek even when the model entry does not set thinkingLevelMap. Nothing is appended after "--", so the prompt stays positional.
export function modelPiCommand(prompt: string): string[] {
  const argv = piArgv({ prompt, provider: MODEL_PROVIDER, model: MODEL_ID });
  return [argv[0] ?? "pi", "--thinking", "off", ...argv.slice(1)];
}

// Daemon limits for this runtime. Session deadlines are capped at MODEL_DEADLINE_CAP_MS: a request may shorten, never exceed.
export function modelDaemonLimits(): {
  defaultSessionMs: number;
  maxSessionMs: number;
  rootBudgetMicros: number;
  defaultBudgetMicros: number;
} {
  return {
    defaultSessionMs: MODEL_DEADLINE_CAP_MS,
    maxSessionMs: MODEL_DEADLINE_CAP_MS,
    rootBudgetMicros: MODEL_BUDGET_MICROS,
    defaultBudgetMicros: MODEL_BUDGET_MICROS,
  };
}

// Only the non-secret catalog lookup fields. The upstream key never goes through here.
export function modelCatalogEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "POMTREED_PI_CATALOG_DIR", "PI_CODING_AGENT_DIR"] as const) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

// Refuses to start a paid child unless the pinned catalog resolves the model with a rate. No unpriced fallback.
export function requirePricedModel(env: Record<string, string | undefined>): void {
  const catalog = openPiCatalog(modelCatalogEnv(env), MODEL_PROVIDER);
  if (!catalog.found) throw new Error(`openModelRuntime: ${catalog.message}`);
  if (!catalog.rates.lookup(MODEL_PROVIDER, MODEL_ID)) throw new Error(`openModelRuntime: ${MODEL_PROVIDER}/${MODEL_ID} is not priced in the pi catalog`);
}

// Recorded state of the model path for the consumer's proof: what was staged, not any secret.
export function modelRuntimeCredentials(stateDir: string): PiCredentials {
  return proxyPiCredentials({ stateDir, containerAuthPath: PI_AUTH_PATH, provider: MODEL_PROVIDER, modelOverrides: [DEEPSEEK_FLASH_OVERRIDE] });
}

// Container drive/resume settlement, including revocation and finish-tail writes. This is NOT workflow executor settlement:
// deterministic cancellation detaches the body; WorkflowHost.drain separately joins actual workflow bodies and effects.
export async function joinLifecycle(
  orchestrator: Pick<LocalOrchestrator, "idle">,
  deadline: number,
  ledger: CloseLedger,
  secrets: readonly string[] = [],
): Promise<boolean> {
  const joined = await boundedStep("lifecycle settlement", () => orchestrator.idle().then(() => true), deadline, ledger, secrets);
  if (joined !== true) ledger.unjoined = true;
  return joined === true;
}

// Shared by close and partial-open teardown: reverse order, never close SQLite under unjoined work.
export async function teardownResources(
  steps: readonly { label: string; run: () => Promise<void>; retainStoreOnFailure?: boolean }[],
  deadline: number,
  ledger: CloseLedger,
  secrets: readonly string[] = [],
): Promise<void> {
  for (const t of steps.slice().reverse()) {
    if (t.label === STORE_LABEL && ledger.unjoined) {
      ledger.failures.push(`${STORE_LABEL}: skipped because cleanup is unjoined or unproven`);
      continue;
    }
    const complete = await boundedStep(t.label, () => t.run().then(() => true), deadline, ledger, secrets);
    if (complete !== true && t.retainStoreOnFailure) ledger.unjoined = true;
  }
}

// Partial-open failure teardown records only resources this open created and returns sanitized failures (empty = clean).
export async function teardownPartialOpen(
  steps: readonly { label: string; run: () => Promise<void>; retainStoreOnFailure?: boolean }[],
  secrets: readonly string[],
  boundMs = SHUTDOWN_BOUND_MS,
): Promise<string[]> {
  const ledger: CloseLedger = { failures: [], unjoined: false };
  await teardownResources(steps, Date.now() + boundMs, ledger, secrets);
  return ledger.failures;
}

export async function openModelRuntime(o: ModelRuntimeOptions): Promise<ModelRuntime> {
  validateModelRuntimeOptions(o);
  requirePricedModel(process.env);
  const image = o.image ?? APPROVED_IMAGE;
  const hostId = `model-${randomBytes(6).toString("hex")}`; // fresh per open: no collision with other daemons, no adoption of orphans
  // Open-failure teardown only; close() runs its own ordered, deadline-bounded steps.
  const teardown: { label: string; run: () => Promise<void>; retainStoreOnFailure?: boolean }[] = [];
  const secret = randomBytes(32).toString("hex"); // ephemeral: consumed here, the CLI and host get issued tokens
  const openSecrets = [secret, o.upstreamKey, o.stateDir, o.repoDir, o.extensionDir];
  try {
    mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
    const store = openDaemonStore(join(o.stateDir, "pomtreed.sqlite"));
    teardown.push({ label: STORE_LABEL, run: async () => store.close() });
    const socketPath = join(o.stateDir, `m-${randomBytes(4).toString("hex")}.sock`);
    const sessionRoot = join(o.stateDir, "sessions");

    const workspace = new GitWorkspace({
      repoDir: o.repoDir,
      mirrorDir: join(o.stateDir, "mirror.git"),
      foldersRoot: join(o.stateDir, "workspaces"),
    });
    const reportStore: ReportStore = new DirReportStore({ root: join(o.stateDir, "reports"), registry: store.registry });
    // report.maxBytes at its registry default: this runtime takes no --config (the content live entry is the one that resolves).
    const reports = createReportsExtension({ store: reportStore, reportMaxBytes: CONFIG_DEFAULTS["report.maxBytes"] });

    // The only model route: the existing key-issuing proxy, pinned to the direct DeepSeek origin. The key stays in this env object.
    const live: LiveModel = await startLiveModel({
      store,
      secret,
      stateDir: o.stateDir,
      provider: MODEL_PROVIDER,
      env: {
        ...modelCatalogEnv(process.env),
        POMTREED_MODEL_BASE_URL: MODEL_UPSTREAM,
        POMTREED_MODEL_PROXY_MAX_REQUEST_MICROS: "50000",
      },
      // The key already read from its key file, in memory only: never an env entry a child could inherit.
      upstreamKey: o.upstreamKey,
      fetch: o.fetch,
    });
    teardown.push({ label: "model proxy close", run: () => live.close() });
    const credentials = modelRuntimeCredentials(o.stateDir);

    // The same capture broker pomtreed wires (capture-wiring.ts): robots.txt, the shared cache and provenance, over this store.
    const capture = wireCaptureBroker({
      stores: store,
      quota: store.quotaCounters(),
      reports: reportStore,
      daemon: { root: () => daemon.root(), captureRecord: (agent, payload, key) => daemon.captureRecord(agent, payload, key) },
      hostId,
      userAgent: o.fetchUserAgent,
      log: (line) => console.error(`model-runtime: capture: ${line}`),
      fetch: selectSourceTransport(o),
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
    const reviewed = new Set<string>(REVIEWED_OWNERS);
    const host = new WorkflowHost({
      registry: () => store.registry,
      reviewed: (ext) => reviewed.has(ext),
      startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
      log: (line) => console.error(`model-runtime: ${line}`),
      services: () => services,
    });
    const extensions = createExtensionRegistry({
      hostId: hostId,
      now: () => daemon.now(),
      registry: store.registry,
      journal: store.journal,
      mailbox: store.mailbox,
      root: () => daemon.root(),
      workflows: host,
      log: (line) => console.error(`model-runtime: ${line}`),
    });

    let apiUrl: string | undefined;
    const { placement, sandbox } = wireLocalHost({
      hostId: hostId,
      hosts: store.hosts,
      workspace,
      sessionRoot,
      image,
      capacity: { maxSessions: 1 },
      makeSandbox: (mounts) => new DockerSandbox({ mounts }),
    });
    const orchestrator = new LocalOrchestrator();
    const deps: DaemonDeps = {
      hostId: hostId,
      secret,
      fetchUserAgent: o.fetchUserAgent, // checked non-empty and valid above; the browser workers' identity, as the capture broker's
      image,
      ...modelDaemonLimits(),
      sandboxSocketPath: "/run/pomtreed.sock",
      socketHostPath: socketPath,
      agentApiUrl: () => apiUrl,
      registry: store.registry,
      journal: store.journal,
      mailbox: store.mailbox,
      sandbox,
      workspace,
      harness: createPiHarness({ sink: (agent) => fileTailSource(join(sessionRoot, agent, PI_SINK_FILE)) }),
      gateway: live.gateway,
      command: (task) => modelPiCommand(task),
      credentials,
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
      reportMaxBytes: CONFIG_DEFAULTS["report.maxBytes"],
      placement,
      orchestrator,
      deterministicExecutors: host.executors,
      extensionHost: extensions,
      launchWorkflow: (requester, req) => host.launch(requester, req),
      allowChatWorkflow: () => false,
      authorizeInbound: (msg) => msg.sender.sender === CHAT_SENDER,
      chatApproval: () => false,
    };
    daemon = new Daemon(deps);
    teardown.push({ label: "lifecycle settlement", run: () => orchestrator.idle(), retainStoreOnFailure: true });
    placement.onAdmit((agent) => daemon.admitted(agent));
    teardown.push({ label: EXTENSIONS_LABEL, run: () => extensions.stopAll({ throwOnStopFailure: true }), retainStoreOnFailure: true });
    await extensions.load(o.extensionDir);
    await extensions.startAll();

    const agents = await listenAgents(daemon, "127.0.0.1", 0);
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

    // Agents this run recorded in its own store; the only ids close() is allowed to cancel, kill or unstage.
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
      // An unknown drain result (timeout or failure) means ownership is unproven: fail closed, never release any extension.
      if (drained === undefined) ledger.unjoined = true;
      else if (!drained.complete) ledger.failures.push(`drain: incomplete (retained ${JSON.stringify(drained.retained)})`);
      if (drained && drained.retained.length > 0) ledger.unjoined = true; // retained owners keep live tasks: keep the store open

      const snapshot = await step("list recorded agents", recordedAgents);
      if (snapshot === undefined) ledger.unjoined = true; // unknown ownership cannot prove lifecycle cleanup
      const recorded = snapshot ?? [];
      // Physical sandboxes recorded on this run's own agents, captured before cancel clears them.
      const recordedSandboxes = new Set<SandboxRef>(recorded.map((a) => a.sandbox).filter((s): s is SandboxRef => s != null));

      await Promise.all(recorded.map((a) => step(`cancel ${a.id}`, () => daemon.cancel(a.id, CANCEL_GRACE_MS))));
      if (recordedSandboxes.size > 0) {
        // A failed list is a recorded failure and leaves nothing killed: we cannot prove which containers are ours.
        const listed = await step("list sandboxes", () => sandbox.list());
        if (listed) {
          const physical = new Set<string>(listed.map((s) => s.id));
          for (const id of recordedSandboxes) {
            if (physical.has(id)) await step(`kill ${id}`, () => sandbox.kill(id));
          }
        }
      }
      const joined = await joinLifecycle(orchestrator, deadline, ledger, secrets);
      if (drained !== undefined && joined) {
        // The registry disables future dispatch, invokes permitted stop hooks, THEN joins callbacks (stop can release a hook).
        const stopped = await step("extensions shutdown", () =>
          extensions.stopForShutdown(drained.retained, { throwOnStopFailure: true, deadlineAt: deadline }),
        );
        if (stopped === undefined) ledger.unjoined = true; // a failed stop does not prove the extension released its resources
      } else ledger.failures.push("extensions shutdown: skipped because drain ownership or lifecycle settlement is unknown");
      if (joined) {
        for (const a of recorded) {
          // Synchronous filesystem cleanup is checked before/after, not claimed to be interruptible.
          await step(`unstage ${a.id}`, async () => credentials.unstage(a.id as AgentId));
        }
      } else ledger.failures.push("credentials cleanup: skipped because lifecycle settlement is unknown");
      await teardownResources(
        teardown.filter((t) => t.label !== EXTENSIONS_LABEL && t.label !== "lifecycle settlement"),
        deadline,
        ledger,
        secrets,
      );
      if (ledger.failures.length > 0) throw new Error(`model runtime close had failures: ${ledger.failures.join("; ")}`);
    };

    const rt: ModelRuntime = {
      daemon,
      stores: store,
      host,
      extensions,
      reports,
      sandbox,
      root,
      modelBinding: { provider: MODEL_PROVIDER, model: MODEL_ID, image },
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
