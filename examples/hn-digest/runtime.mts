// Real-stack runtime helper for the hn-digest example: SQLite store, dir reports, WorkflowHost, extension registry, Daemon, the
// unix socket the real `pomtree` CLI speaks, and the host-channel HTTP listener. Sandbox, harness, model gateway and workspace are
// fakes that record calls (see `unusedCalls`); nothing here reaches a network, a model, a provider or a git repo. Reviewed
// owners are explicit and default deny: an extension's workflows are admitted only when listed in `reviewedOwners`.
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import {
  type AgentRecord,
  CONFIG_REGISTRY,
  type Extension,
  type ExtensionJournalPayload,
  type FreshnessConfig,
  type Harness,
  type ReportStore,
  resolveConfig,
  type Template,
} from "../../packages/core/src/index.ts";
import { type Io, run } from "../../packages/pomtree/src/cli.ts";
import { socketTransport } from "../../packages/pomtree/src/client.ts";
import { issueToken } from "../../packages/pomtreed/src/auth.ts";
import { createReportsExtension } from "../../packages/pomtreed/src/builtin/reports.ts";
import { wireCaptureBroker } from "../../packages/pomtreed/src/capture-wiring.ts";
import { buildChannelRegistry } from "../../packages/pomtreed/src/channels.ts";
import { Daemon } from "../../packages/pomtreed/src/daemon.ts";
import type { DaemonDeps, InboundMessage, MessageReceipt } from "../../packages/pomtreed/src/daemon-types.ts";
import type { FetchFn } from "../../packages/pomtreed/src/ext-gateway.ts";
import { createExtensionRegistry, type ExtensionRegistryImpl } from "../../packages/pomtreed/src/extensions.ts";
import { ProxyCredentialGateway } from "../../packages/pomtreed/src/gateway.ts";
import { LocalOrchestrator } from "../../packages/pomtreed/src/orchestrator.ts";
import { listen, listenHost } from "../../packages/pomtreed/src/server.ts";
import type { WorkflowCapabilityServices } from "../../packages/pomtreed/src/workflow-capabilities.ts";
import { HN_DIGEST_DEFAULTS, HN_DIGEST_EXTENSION } from "./params.mts";
import { raceUntil, sleepTick, WorkflowHost } from "../../packages/pomtreed/src/workflows.ts";
import { DirReportStore } from "../../packages/report-dir/src/index.ts";
import { openStore, type Store } from "../../packages/store-sqlite/src/index.ts";
import { createFakes } from "../../packages/testing/src/fakes.ts";

export const HOST_ID = "h1";
export const CHANNEL = "discord";
export const CHAT_SENDER = "u1";
// Fakes whose calls are counted: any call means the runtime reached a model, sandbox, harness, workspace or gateway.
const UNUSED_PORTS = new Set(["Sandbox", "Harness", "ModelGateway", "Workspace"]);

// Close bound: one absolute deadline shared by every close step.
export const CLOSE_BOUND_MS = 5_000;

export interface CloseLedger {
  failures: string[];
  unjoined: boolean; // work is pending, or the deadline prevented proving resource cleanup
}

export function redactMessage(e: unknown, secrets: readonly string[]): string {
  let msg = e instanceof Error ? e.message : String(e);
  for (const x of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) msg = msg.split(x).join("[redacted]");
  return msg.slice(0, 300);
}

// Runs one step under the absolute deadline. Rejections and timeouts are recorded, never swallowed; a late rejection of an
// abandoned step is absorbed. A timeout marks the ledger unjoined so the store is not closed under pending work.
export async function boundedStep<T>(
  label: string,
  work: () => Promise<T>,
  deadline: number,
  ledger: CloseLedger,
  secrets: readonly string[] = [],
): Promise<T | undefined> {
  if (Date.now() >= deadline) {
    ledger.unjoined = true;
    ledger.failures.push(`${label}: skipped because the close deadline expired`);
    return undefined;
  }
  let p: Promise<{ value: T } | { error: unknown }>;
  try {
    p = work().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } catch (error) {
    ledger.failures.push(`${label}: ${redactMessage(error, secrets)}`);
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
  });
  const r = await Promise.race([p, timeout]);
  clearTimeout(timer);
  // Synchronous work cannot be interrupted, but must not be reported as on-time success after overrunning the deadline.
  if (r === "timeout" || Date.now() >= deadline) {
    ledger.unjoined = true;
    ledger.failures.push(`${label}: timed out`);
    return undefined;
  }
  if ("error" in r) {
    ledger.failures.push(`${label}: ${redactMessage(r.error, secrets)}`);
    return undefined;
  }
  return r.value;
}

export interface TeardownStep {
  label: string;
  run: () => Promise<void>;
  store?: boolean; // closed only when no earlier step is still unjoined
  retainStoreOnFailure?: boolean; // a rejected stop can leave live resource work even without timing out
}

// Reverse-order teardown of resources this open created, bounded by one deadline. Returns the ledger; never throws.
export async function runTeardown(steps: TeardownStep[], ledger: CloseLedger, deadline: number, secrets: readonly string[] = []): Promise<void> {
  for (const t of steps.slice().reverse()) {
    if (t.store && ledger.unjoined) {
      ledger.failures.push(`${t.label}: skipped because cleanup is unjoined or unproven`);
      continue;
    }
    const complete = await boundedStep(t.label, () => t.run().then(() => true), deadline, ledger, secrets);
    if (complete !== true && t.retainStoreOnFailure) ledger.unjoined = true;
  }
}

// Freshness windows of 1 ms for offline scenario harnesses only (RuntimeOptions.captureFreshness): a fixture that changes between
// rounds is read afresh each round. Never passed by a live path, which keeps the registry's Table 2 defaults.
export const OFFLINE_CAPTURE_FRESHNESS: FreshnessConfig = { stableMs: 1, dailyMs: 1, liveMs: 1 };

// The offline test identity every offline test composition sends (a reserved .invalid contact: never a real one). A live path never
// sends it; it passes the value resolved from workflow.fetch.userAgent.
export const TEST_FETCH_USER_AGENT = "pomtree-test test@example.invalid";

const USER_AGENT_ENV = CONFIG_REGISTRY.envOf.get("workflow.fetch.userAgent") as string;

// hn-digest's own top level (the scenario CLI reads the env directly, not a full config) resolves the workflow fetch identity through
// the registry: unset or blank gives the registry default, a header-unsafe value is refused. `who` prefixes the refusal.
export function resolveFetchUserAgent(value: string | undefined, who: string): string {
  const r = resolveConfig(CONFIG_REGISTRY, { env: value === undefined ? {} : { [USER_AGENT_ENV]: value }, skipSecretFiles: true });
  if (!r.ok) {
    throw new Error(
      `${who}: workflow.fetch.userAgent is refused (${r.errors.join("; ")}): set it (env ${USER_AGENT_ENV}) to a product token, optionally with a contact, e.g. "hn-digest (+https://example.org/contact)", or leave it unset for the default`,
    );
  }
  return r.values["workflow.fetch.userAgent"] as string;
}

export interface RuntimeOptions {
  stateDir: string; // reused across close+reopen; holds pomtreed.sqlite, reports/, pomtreed.sock
  extensionDir: string; // directory of extension subdirs (manifest.json + entry), loaded for real
  reviewedOwners: readonly string[]; // required; default deny (no owner is reviewed unless listed)
  chatWorkflows?: readonly string[]; // qualified workflow names chat sender CHAT_SENDER may launch (default none)
  chatApproval?: boolean; // gate chat launches behind a durable spawn approval (default false)
  fetch?: FetchFn; // offline fixture transport for capability fetch
  fetchUserAgent?: string; // the resolved workflow.fetch.userAgent for the capture broker; default TEST_FETCH_USER_AGENT, so a caller with a live `fetch` must pass the resolved value
  resolveDns?: (h: string) => Promise<{ address: string; family: number }[]>;
  // The capture broker's freshness windows (capture.freshness.{stable,daily,live}Ms). Default: the registry values (doc Table 2),
  // which every live path keeps. An OFFLINE scenario harness whose fixture serves new bytes at one URL between rounds seconds
  // apart passes tiny windows (OFFLINE_CAPTURE_FRESHNESS) so each round reads the fixture afresh instead of round 1's cached capture.
  captureFreshness?: FreshnessConfig;
  publishAfterWrite?: () => Promise<void>; // runs after a report is written to the store (inject a crash here)
  workflowAfterRecord?: (payload: ExtensionJournalPayload) => Promise<void>; // offline process-crash boundary probe, after durable root write
  workflowBeforeRecord?: (payload: ExtensionJournalPayload) => Promise<void>; // offline probe for child dispatch before ID receipt persistence
  openStore?: typeof openStore; // offline test seam for observing partial-open store closure
  // Explicit offline worker seams; defaults remain the metadata-only zero-resource fake runtime.
  templates?: Template[];
  harness?: Harness;
  mayUseTemplate?: DaemonDeps["mayUseTemplate"];
  models?: DaemonDeps["models"];
  approvalTimeoutMs?: number;
  durableGateway?: boolean; // offline scoped-token/debit ledger only; starts no proxy server or upstream calls
  builtinExtensions?: (services: { store: Store; reports: ReportStore; root(): Promise<AgentRecord> }) => Extension[];
}

export interface Runtime {
  daemon: Daemon;
  stores: Store;
  host: WorkflowHost;
  extensions: ExtensionRegistryImpl;
  reports: ReturnType<typeof createReportsExtension>;
  reportStore: ReportStore;
  root: AgentRecord;
  cli(argv: string[]): Promise<{ code: number; out: string[]; err: string[] }>;
  hostPost(body: InboundMessage): Promise<MessageReceipt>;
  close(): Promise<void>;
  readonly unusedCalls: string[];
}

// Wraps the dir store so `publishAfterWrite` runs once the report row and file are durable (the crash window the probe tests).
function hookedReportStore(inner: DirReportStore, afterWrite?: () => Promise<void>): ReportStore {
  return {
    write: async (r, key) => {
      const out = await inner.write(r, key);
      await afterWrite?.();
      return out;
    },
    list: (agent) => inner.list(agent),
    read: (agent, id) => inner.read(agent, id),
    remove: (agent, id) => inner.remove(agent, id),
  };
}

export async function openRuntime(o: RuntimeOptions): Promise<Runtime> {
  const teardown: TeardownStep[] = [];
  const secret = randomBytes(32).toString("hex"); // ephemeral: consumed here only, the CLI and host get issued tokens
  const secrets = [secret, o.stateDir, o.extensionDir];
  try {
    const store = (o.openStore ?? openStore)(join(o.stateDir, "pomtreed.sqlite"));
    teardown.push({ label: "store close", run: async () => store.close(), store: true });
    const fakes = createFakes({ host: HOST_ID, ...(o.templates && { templates: o.templates }) });
    // Ledger reads (`spend`) for agents with no key answer zero instead of throwing; they are not starts and are not counted.
    fakes.hooks.raw.gateway.lenientSpend = true;
    const reviewed = new Set(o.reviewedOwners);
    const chatWorkflows = new Set(o.chatWorkflows ?? []);
    const sockPath = join(o.stateDir, `pomtreed-${randomBytes(4).toString("hex")}.sock`); // unique per open: a reused path hung after reopen
    const sessionRoot = join(o.stateDir, "sessions");

    const dirReports = new DirReportStore({ root: join(o.stateDir, "reports"), registry: store.registry });
    const reportStore = hookedReportStore(dirReports, o.publishAfterWrite);
    const reports = createReportsExtension({ store: reportStore, reportMaxBytes: 1 << 20 });

    // The same capture broker pomtreed wires (capture-wiring.ts): robots.txt, the shared cache and provenance, over this store.
    const capture = wireCaptureBroker({
      stores: store,
      quota: store.quotaCounters(),
      // The plain store: publishAfterWrite injects crashes after a workflow's report publish, not after a capture artifact write.
      reports: dirReports,
      daemon: { root: () => daemon.root(), captureRecord: (agent, payload, key) => daemon.captureRecord(agent, payload, key) },
      hostId: HOST_ID,
      userAgent: o.fetchUserAgent ?? TEST_FETCH_USER_AGENT,
      log: (line) => console.error(`runtime: ${line}`),
      ...(o.fetch && { fetch: o.fetch }),
      ...(o.resolveDns && { resolveDns: o.resolveDns }),
      ...(o.captureFreshness && { config: { freshness: o.captureFreshness } }),
    });
    teardown.push({ label: "capture broker close", run: () => capture.close() });
    let daemon!: Daemon;
    const services: WorkflowCapabilityServices = {
      root: () => daemon.root(),
      agent: (id) => daemon.get(id),
      readRoot: (from, limit) => daemon.workflowReadRoot(from, limit),
      recordRoot: async (payload, key) => {
        await o.workflowBeforeRecord?.(payload);
        const recorded = await daemon.workflowRecord(payload, key);
        await o.workflowAfterRecord?.(payload);
        return recorded;
      },
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
      capture,
      now: () => daemon.now(),
      redactText: (text) => daemon.redactText(text),
    };
    const host = new WorkflowHost({
      registry: () => store.registry,
      reviewed: (ext) => reviewed.has(ext),
      startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
      log: (line) => console.error(`runtime: ${line}`),
      services: () => services,
    });
    const extensions = createExtensionRegistry({
      hostId: HOST_ID,
      now: () => daemon.now(),
      registry: store.registry,
      journal: store.journal,
      mailbox: store.mailbox,
      root: () => daemon.root(),
      workflows: host,
      // The loaded hn-digest extension reads its own keys through host.config, as under pomtreed: here at their defaults.
      config: (name) => Object.freeze(name === HN_DIGEST_EXTENSION ? { ...HN_DIGEST_DEFAULTS } : {}),
      log: (line) => console.error(`runtime: ${line}`),
    });

    const orchestrator = new LocalOrchestrator();
    const deps: DaemonDeps = {
      hostId: HOST_ID,
      secret,
      fetchUserAgent: o.fetchUserAgent ?? TEST_FETCH_USER_AGENT, // the browser workers' identity, the same value the capture broker sends
      image: `img@sha256:${"ab".repeat(32)}`,
      sandboxSocketPath: "/run/pomtreed.sock",
      socketHostPath: sockPath,
      rootBudgetMicros: 10_000,
      defaultBudgetMicros: 1_000,
      graceMs: 20,
      admitRetryMs: 5,
      registry: store.registry,
      journal: store.journal,
      mailbox: store.mailbox,
      checkpoints: store.checkpoints,
      sessions: store.sessions,
      sessionRoot,
      escalations: store.escalations,
      approvals: store.approvals,
      watchdogs: store.watchdogs,
      schedules: store.schedules,
      reportStore,
      reportMaxBytes: 1 << 20,
      channels: buildChannelRegistry([CHANNEL], [CHANNEL]),
      ...(o.approvalTimeoutMs !== undefined && { approvalTimeoutMs: o.approvalTimeoutMs }),
      messagingAllowSpawn: true,
      sandbox: fakes.sandbox,
      workspace: fakes.workspace,
      harness: o.harness ?? fakes.harness,
      ...(o.templates && { templates: fakes.templates }),
      ...(o.mayUseTemplate && { mayUseTemplate: o.mayUseTemplate }),
      ...(o.models && { models: o.models }),
      gateway: o.durableGateway
        ? new ProxyCredentialGateway({
            journal: store.journal,
            registry: store.registry,
            secret,
            proxyBaseUrl: "http://offline-model.invalid",
            tokenTtlMs: 3600000,
            debits: store.modelDebit({ secret }),
          })
        : fakes.gateway,
      placement: fakes.placement,
      orchestrator,
      deterministicExecutors: host.executors,
      extensionHost: extensions,
      // Canonical launch: the host owns key replay and definition checks; this is only the admission seam.
      launchWorkflow: (requester, req) => host.launch(requester, req),
      allowChatWorkflow: (actor, workflow) => actor.sender.sender === CHAT_SENDER && chatWorkflows.has(workflow),
      authorizeInbound: (msg) => msg.sender.sender === CHAT_SENDER,
      chatApproval: (route) => route === "spawn" && o.chatApproval === true,
    };
    daemon = new Daemon(deps);
    teardown.push({ label: "lifecycle settlement", run: () => orchestrator.idle(), retainStoreOnFailure: true });

    extensions.registerBuiltin(reports);
    for (const extension of o.builtinExtensions?.({ store, reports: reportStore, root: () => daemon.root() }) ?? []) extensions.registerBuiltin(extension);
    teardown.push({ label: "extensions stop", run: () => extensions.stopAll({ throwOnStopFailure: true }), retainStoreOnFailure: true });
    await extensions.load(o.extensionDir);
    await extensions.startAll();
    const root = await daemon.root();

    const socket = await listen(daemon, sockPath);
    teardown.push({ label: "operator socket close", run: () => closeServer(socket) });
    const hostListen = await listenHost(daemon, "127.0.0.1", 0);
    teardown.push({ label: "host server close", run: () => closeServer(hostListen.server) });

    const operatorToken = issueToken(secret, { scope: "operator" });
    const hostToken = issueToken(secret, { scope: "host", channel: CHANNEL });

    let closing: Promise<void> | undefined;
    const runClose = async (): Promise<void> => {
      const ledger: CloseLedger = { failures: [], unjoined: false };
      const deadline = Date.now() + CLOSE_BOUND_MS;
      const closeSecrets = [...secrets, operatorToken, hostToken];
      const step = <T,>(label: string, work: () => Promise<T>) => boundedStep(label, work, deadline, ledger, closeSecrets);
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
      if (drained === undefined) {
        // Unknown ownership: fail closed. Extensions are not released and the store stays open under possibly live tasks.
        ledger.unjoined = true;
      } else if (!drained.complete) {
        ledger.failures.push(
          `drain: incomplete (${redactMessage(`retained ${JSON.stringify(drained.retained)}; ${drained.errors.join("; ")}`, closeSecrets)})`,
        );
      }
      // The host drain joins actual workflow bodies/effects; this additional join covers daemon finish-tail work.
      const joined = await step("lifecycle settlement", () => orchestrator.idle().then(() => true));
      if (joined !== true) ledger.unjoined = true;
      // Retained owners still hold live tasks: the store and their journal dispatch must stay open for them as well.
      if (drained && drained.retained.length > 0) ledger.unjoined = true;
      if (drained !== undefined && joined === true) {
        // The registry disables future dispatch, invokes permitted stop hooks, THEN joins callbacks (stop can release a hook).
        const stopped = await step("extensions shutdown", () =>
          extensions.stopForShutdown(drained.retained, { throwOnStopFailure: true, deadlineAt: deadline }),
        );
        if (stopped === undefined) ledger.unjoined = true; // a failed stop does not prove the extension released its resources
      } else ledger.failures.push("extensions shutdown: skipped because drain ownership or lifecycle settlement is unknown");
      await runTeardown(
        teardown.filter((t) => t.label !== "extensions stop" && t.label !== "lifecycle settlement"), // already stopped/joined above
        ledger,
        deadline,
        closeSecrets,
      );
      if (ledger.failures.length > 0) throw new Error(`runtime close had failures: ${ledger.failures.join("; ")}`);
    };

    const rt: Runtime = {
      daemon,
      stores: store,
      host,
      extensions,
      reports,
      reportStore,
      root,
      async cli(argv) {
        const out: string[] = [];
        const err: string[] = [];
        const io: Io = {
          call: socketTransport(sockPath, operatorToken),
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
        // Same HTTP route a messaging adapter uses; the host token is bound to CHANNEL.
        const res = await fetch(`http://127.0.0.1:${hostListen.port}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (!res.ok) return { kind: "rejected", reason: `${res.status}: ${text}` };
        return JSON.parse(text) as MessageReceipt;
      },
      get unusedCalls() {
        return fakes.calls.filter((c) => UNUSED_PORTS.has(c.port) && c.method !== "spend").map((c) => `${c.port}.${c.method}`);
      },
      close() {
        closing ??= runClose();
        return closing;
      },
    };
    return rt;
  } catch (e) {
    // Partial-open teardown: only what this open created, one deadline, original failure preserved, secrets redacted.
    const ledger: CloseLedger = { failures: [], unjoined: false };
    await runTeardown(teardown.splice(0), ledger, Date.now() + CLOSE_BOUND_MS, secrets);
    const base = redactMessage(e, secrets);
    throw new Error(ledger.failures.length > 0 ? `${base}; teardown failures: ${ledger.failures.join("; ")}` : base);
  }
}

async function closeServer(s: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    s.closeAllConnections();
    s.close(() => resolve());
  });
}

export type { AgentRecord };
