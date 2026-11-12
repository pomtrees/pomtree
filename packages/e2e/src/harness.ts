import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DEFAULTS, type AgentId, type Harness, type HarnessEvent, type HarnessSession, type ModelGateway } from "@pomtree/core";
import { Daemon, ProxyCredentialGateway, LocalOrchestrator, handle, wireLocalHost } from "@pomtree/pomtreed";
import { buildChannelRegistry } from "../../pomtreed/src/channels.ts";
import type { ApiResponse, DaemonDeps } from "@pomtree/pomtreed";
import { FakeModelCatalog, createFakes, keyed, tmpDir, until as pollUntil } from "@pomtree/testing";
import { openStore } from "@pomtree/store-sqlite";
import type { Store } from "@pomtree/store-sqlite";
import { DirReportStore } from "@pomtree/report-dir";
import { GitWorkspace } from "@pomtree/workspace-git";

export const SECRET = "e2e-secret";

// Removed when the test process exits (tmpDir in @pomtree/testing).
export const tmp = (p: string) => tmpDir(`pomtree-e2e-${p}-`);

export function gitRepo(): string {
  const dir = tmp("repo");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

export type Api = (method: string, url: string, body?: unknown) => Promise<ApiResponse>;

export interface Play {
  events?: HarnessEvent[];
  run?: (api: Api) => Promise<void>; // acts as the agent through the real API with its own credential
  result?: { status: "succeeded" | "failed"; result: unknown };
  hold?: Promise<void>; // keep the session open until released (simulates a long-running agent)
}

// TODO(harness-dup): @pomtree/testing's ScriptHarness is a second scripted Harness. It cannot replace this one: Play drives the
// daemon (`handle`, `submitResult`) and testing must not depend on pomtreed. Unify by giving ScriptHarness injectable daemon hooks.
// Plays the agent: emits scripted events, optionally holds open, then submits a typed result through the daemon.
// `resumePlay` (when given) plays the resume segment (the wake text is handed to the harness); without it resume throws.
export function playHarness(
  getDaemon: () => Daemon,
  play: (agent: AgentId, prompt: string) => Play,
  resumePlay?: (agent: AgentId, wake: string) => Play,
): Harness {
  const open = (agent: AgentId, p: Play): HarnessSession => {
    const queue = [...(p.events ?? [])];
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const finished = (async () => {
      const d = getDaemon();
      await p.run?.((method, url, body) => handle(d, { method, url, body: keyed(method, body), token: d.agentToken(agent) }));
      await p.hold;
      // Scripted results are wrapped into the handoff convention (summary required) unless they already carry one.
      const hr = p.result?.result as { summary?: unknown } | null | undefined;
      if (p.result) await getDaemon().submitResult(agent, p.result.status, typeof hr?.summary === "string" ? hr : { summary: "ok", value: p.result.result });
    })();
    return {
      session: `sess-${agent}`,
      async *events() {
        while (queue.length) yield queue.shift()!;
        await Promise.race([finished, gate]);
      },
      steer: async () => {},
      stop: async () => release(),
    };
  };
  return {
    async start({ agent, prompt }): Promise<HarnessSession> {
      return open(agent, play(agent, prompt));
    },
    async resume({ agent, wake }): Promise<HarnessSession> {
      if (!resumePlay) throw new Error("resume not supported");
      return open(agent, resumePlay(agent, wake));
    },
  };
}

export interface Rig {
  daemon: Daemon;
  orchestrator: LocalOrchestrator;
  store: Store;
  workspace: GitWorkspace;
  repo: string;
  stateDir: string;
  sandbox: ReturnType<typeof createFakes>["sandbox"];
}

export interface RigOpts {
  repo?: string;
  stateDir?: string;
  hostId?: string;
  maxSessions?: number; // the local host's session cap (default 4)
  play?: (agent: AgentId, prompt: string) => Play;
  resume?: (agent: AgentId, wake: string) => Play;
  harness?: Harness;
  sandbox?: DaemonDeps["sandbox"];
  gateway?: ModelGateway;
  now?: () => number;
  deps?: Partial<DaemonDeps> & { messagingChannels?: string[]; escalationChannels?: string[] }; // extra/override Daemon deps (messaging channels, approvals, publisher, ...)
}

// Real store-sqlite (file db) and workspace-git; fakes only for sandbox/harness unless overridden.
export function rig(o: RigOpts = {}): Rig {
  const { messagingChannels, escalationChannels, ...deps } = o.deps ?? {};
  const repo = o.repo ?? gitRepo();
  const stateDir = o.stateDir ?? tmp("state");
  const hostId = o.hostId ?? "h1";
  const store = openStore(join(stateDir, "pomtreed.sqlite"));
  const workspace = new GitWorkspace({ repoDir: repo, mirrorDir: join(stateDir, "mirror.git"), foldersRoot: join(stateDir, "workspaces") });
  const fakes = createFakes({ host: hostId });
  const orchestrator = new LocalOrchestrator();
  const sessionRoot = join(stateDir, "sessions");
  // The fake sandbox ignores mounts; the node and placement are the same wiring pomtreed's main uses.
  const { placement, sandbox } = wireLocalHost({
    hostId,
    hosts: store.hosts,
    workspace,
    sessionRoot,
    image: "img@sha256:e2e",
    capacity: { maxSessions: o.maxSessions ?? 4 },
    makeSandbox: () => o.sandbox ?? fakes.sandbox,
  });
  let daemon!: Daemon;
  const harness = o.harness ?? playHarness(() => daemon, o.play ?? (() => ({ result: { status: "succeeded", result: null } })), o.resume);
  daemon = new Daemon({
    hostId,
    secret: SECRET,
    image: "img@sha256:e2e",
    fetchUserAgent: CONFIG_DEFAULTS["workflow.fetch.userAgent"], // the resolved value main.ts passes, at the registry default
    untemplatedEgress: "registry", // the prior untemplated egress; production states it (agent.untemplatedEgress)
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: join(stateDir, "pomtreed.sock"),
    rootBudgetMicros: 10_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    now: o.now,
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox,
    workspace,
    harness,
    gateway:
      o.gateway ??
      new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    // A spawn that names no model resolves the test catalog's default (the gateway refuses a model-less issue); `deps.models` overrides.
    models: new FakeModelCatalog(),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot,
    escalations: store.escalations,
    channels: buildChannelRegistry(messagingChannels ?? [], escalationChannels ?? []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: new DirReportStore({ root: join(stateDir, "reports"), registry: store.registry }),
    reportMaxBytes: CONFIG_DEFAULTS["report.maxBytes"],
    placement,
    orchestrator,
    ...deps,
  });
  return { daemon, orchestrator, store, workspace, repo, stateDir, sandbox: fakes.sandbox };
}

export const until = (cond: () => Promise<boolean> | boolean, what: string, ms = 20_000): Promise<void> => pollUntil(cond, ms, { what, intervalMs: 10 });

// Real-git tests need git >= 2.38 (the workspace refuses to ingest below it); returns a skip reason, or false when usable.
export function gitSkip(): string | false {
  try {
    const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
    if (!m) return "cannot parse `git --version`";
    return Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38) ? false : `git ${m[1]}.${m[2]} < 2.38`;
  } catch {
    return "git is not available";
  }
}

const folderGit = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();

// Acts as the agent inside its own clone: commits `file` on its branch, bundles beyond the base commit and ingests the bundle
// (what `pomtree push` does through the API, minus HTTP). `fetchFrom` first pulls another agent's branch and fast-forwards onto it.
export async function agentPush(r: Rig, agent: AgentId, file: string, text: string, fetchFrom?: AgentId): Promise<{ ref: string; commit: string }[]> {
  const created = await r.workspace.create(agent, {}); // idempotent: returns the existing folder's branch and base commit
  const dir = r.workspace.hostPath(created.workspace);
  if (fetchFrom) {
    const src = r.workspace.hostPath(r.workspace.idFor(fetchFrom));
    folderGit(dir, "fetch", "-q", src, `agent/${fetchFrom}`);
    folderGit(dir, "merge", "-q", "--ff-only", "FETCH_HEAD");
  }
  writeFileSync(join(dir, file), text);
  folderGit(dir, "add", file);
  folderGit(dir, "commit", "-q", "-m", `add ${file}`);
  const bundle = join(r.stateDir, `${agent}.bundle`);
  folderGit(dir, "bundle", "create", bundle, created.branch, `^${created.commit}`);
  try {
    const bytes = readFileSync(bundle);
    const out = await r.workspace.ingest(
      agent,
      (async function* () {
        yield bytes;
      })(),
      { maxBytes: 16 * 1024 * 1024 },
    );
    if (!out.ok) throw new Error(`ingest failed: ${out.code}: ${out.message}`);
    return out.refs;
  } finally {
    rmSync(bundle, { force: true });
  }
}

// Refs the controller's bare mirror holds for agents (ingested work): refs/agents/<id>/heads/<name>.
export const mirrorRefs = (stateDir: string): string[] =>
  execFileSync("git", ["--git-dir", join(stateDir, "mirror.git"), "for-each-ref", "refs/agents/", "--format=%(refname)"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

export const branches = (repo: string): string[] =>
  execFileSync("git", ["branch", "--list", "agent/*", "--format=%(refname:short)"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);

// Writes a durable checkpoint for `agent` through the real checkpoint and session stores (the seed a restart test needs before a
// second rig recovers over the same stateDir). `key` is the write's idempotency key; `session` is the stored session file body.
export async function seedCheckpoint(
  r: Rig,
  agent: { id: AgentId; generation: number },
  key: string,
  o: { workspace: string; wait?: { kind: "message" } | { kind: "timer"; at: number }; session?: string },
): Promise<void> {
  const sessionRef = await r.store.sessions.put(new TextEncoder().encode(o.session ?? `{"type":"session"}\n`));
  await r.store.checkpoints.write(
    {
      agent: agent.id,
      generation: agent.generation,
      host: "h1",
      sessionRef,
      workspace: o.workspace,
      node: "h1",
      ingested: null,
      wait: o.wait ?? { kind: "message" },
      remainingBudgetMicros: 500,
      imageDigest: "img@sha256:e2e",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session" as const,
    },
    key,
  );
}
