import { FakeModelCatalog, TEST_MODEL, keyed, tmpDir } from "@pomtree/testing";
import { createFakes } from "@pomtree/testing";
import type { AgentRecord, JournalEntry, SpawnSpec } from "@pomtree/core";
import type { OtlpExporterOptions } from "@pomtree/observe";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "./api.ts";
import { buildChannelRegistry } from "./channels.ts";
import type { ApiResponse } from "./api.ts";
import { issueToken } from "./auth.ts";
import { Daemon } from "./daemon.ts";
import type { DaemonDeps } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { HostPlacement } from "./placement.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { ScriptHarness } from "@pomtree/testing";
import type { ScriptCtx } from "@pomtree/testing";
import { createExtensionRegistry } from "./extensions.ts";
import { createObserveExtension } from "./builtin/observe.ts";
import { createReportsExtension } from "./builtin/reports.ts";
import { createCronExtension } from "./builtin/cron.ts";
import { TEST_USER_AGENT } from "./test-capture.ts";

export const SECRET = "test-secret";
export const op = issueToken(SECRET, { scope: "operator" });
// The default SpawnSpec for agents created straight in the registry in tests (NewAgent.spec is required). It names the test
// catalog's model, so a container start of such an agent can issue its model key (the gateway refuses a model-less issue).
export const spawnSpec: SpawnSpec = {
  image: "img",
  envManifestHash: null,
  extensions: [],
  provider: TEST_MODEL.provider,
  model: TEST_MODEL.id,
  systemPrompt: null,
  egress: { kind: "registry" },
};

export type Ctx = ScriptCtx & { api: (method: string, url: string, body?: unknown) => Promise<ApiResponse> };

// Observe builtin config for tests: OTLP stays out of DaemonDeps (the daemon no longer owns it).
export interface ObserveSetup {
  otlp?: OtlpExporterOptions;
}

// Reports builtin config for tests: reportMaxBytes moved from DaemonDeps to the reports extension.
export interface ReportsSetup {
  reportMaxBytes?: number;
}

// Test shorthand: channel names that setup() turns into the daemon's channel registry (an explicit `channels` still wins).
export type ChannelNames = { messagingChannels?: string[]; escalationChannels?: string[] };

export function setup(
  script: (ctx: Ctx) => Promise<void>,
  overrides: Partial<DaemonDeps> & ChannelNames = {},
  observe: ObserveSetup = {},
  reports: ReportsSetup = {},
) {
  const { messagingChannels, escalationChannels, ...over } = overrides;
  const fakes = createFakes({ host: "h1", now: over.now });
  const { registry, journal, mailbox, escalations, reportStore, schedules, watchdogs, sandbox, workspace, checkpoints, sessions, templates } = fakes;
  const reportMaxBytes = reports.reportMaxBytes ?? 8 << 20;
  const orchestrator = new LocalOrchestrator();
  let daemon!: Daemon;
  const sessionRoot = tmpDir("pomtreed-sess-");
  const harness = new ScriptHarness((ctx) =>
    script({
      ...ctx,
      api: async (method, url, body) =>
        handle(daemon, { method, url, body: keyed(method, body), token: daemon.agentToken(ctx.agent, (await daemon.get(ctx.agent))?.generation ?? 0) }),
    }),
  );
  const node = new LocalNode({
    hostId: "h1",
    sandbox,
    workspace,
    capacity: { maxSessions: 8 },
    workspacePath: (id) => join(sessionRoot, "ws", id),
    sessionDir: (agent) => join(sessionRoot, agent),
  });
  const placement = new HostPlacement({ hosts: fakes.hosts, host: "h1", ready: () => node.register(fakes.hosts) });
  const extensionsDir = tmpDir("pomtreed-ext-");
  const extensions = createExtensionRegistry({
    hostId: "h1",
    now: () => daemon.now(),
    registry,
    journal,
    mailbox,
    root: () => daemon.root(),
  });
  daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: "/host/pomtreed.sock",
    rootBudgetMicros: 1_000_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    registry,
    journal,
    mailbox,
    sandbox,
    workspace,
    harness,
    escalations,
    reportStore,
    reportMaxBytes,
    schedules,
    watchdogs,
    templates,
    checkpoints,
    sessions,
    sessionRoot,
    channels: buildChannelRegistry(messagingChannels ?? [], escalationChannels ?? []),
    gateway: new ProxyCredentialGateway({ journal, registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    placement: placement,
    orchestrator,
    extensionHost: extensions,
    // A spawn that names no model resolves the test catalog's default, as production resolves Pi's (main.ts wires piModelCatalog).
    models: new FakeModelCatalog(),
    // Production states it (agent.untemplatedEgress); the library default is none. Suites written against the old registry default keep it.
    untemplatedEgress: "registry",
    // Production passes the resolved workflow.fetch.userAgent (main.ts); a browser worker's start is refused without one.
    fetchUserAgent: TEST_USER_AGENT,
    ...over,
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  // The observe builtin gives every harness a live view; OTLP is opt-in via the `observe` param. The
  // reports and cron builtins own their stores and routes; cron's sweep spawns root children through the
  // daemon's spawn path via the narrow facades.
  extensions.registerBuiltin(createObserveExtension({ otlp: observe.otlp, waits: () => daemon.liveWaits() }));
  const reportsExt = createReportsExtension({ store: reportStore, reportMaxBytes });
  extensions.registerBuiltin(reportsExt);
  const cronExt = createCronExtension({
    schedules,
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
  });
  extensions.registerBuiltin(cronExt);
  const operator = (method: string, url: string, body?: unknown) => handle(daemon, { method, url, body: keyed(method, body), token: op });
  const spawn = async (key = "k1", extra: object = {}) =>
    (await operator("POST", "/v1/agents", { name: "w", task: "do it", idempotencyKey: key, ...extra })).body as AgentRecord;
  return { daemon, orchestrator, journal, sandbox, operator, spawn, fakes, extensions, extensionsDir, reportsExt, cronExt };
}

export const kinds = (es: JournalEntry[]) => es.map((e) => e.payload.kind + (e.payload.kind === "exited" ? `:${e.payload.exit}` : ""));

// A genuine user abort: the terminal hub journals the viewer's Esc (daemon.userEsc), then the sink reports an aborted settle.
export const userAbort = async (t: { daemon: Daemon }, c: ScriptCtx) => {
  await t.daemon.userEsc(c.agent);
  c.emit({ kind: "settled", aborted: true });
};

// The agent's current record; the daemon returns null only for an id that never existed, which no caller of this passes.
export const get = async (t: { daemon: Daemon }, id: string) => (await t.daemon.get(id)) as AgentRecord;

// A root child created straight in the registry and moved to running, without going through spawn.
export async function runningAgent(t: { daemon: Daemon }, key: string, spec: SpawnSpec = spawnSpec, parent?: string): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec,
    parent: parent ?? root.id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: key,
  });
  return t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
}

// One scratch dir for a test that reopens the same sqlite file; removed at process exit (tmpDir).
export function scratch(prefix: string) {
  const dir = tmpDir(prefix);
  return { dir, dbPath: join(dir, "pomtreed.sqlite") };
}

export const until = async (cond: () => Promise<boolean> | boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};
