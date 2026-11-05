// The real pomtreed binary (packages/pomtreed/src/main.ts) with its model upstream pointed at FakeModelUpstream, driven only through the real
// `pomtree` binary (packages/pomtree/src/main.ts --json) in subprocesses, the way an operator drives it after scripts/pomtree-up. Agents run the real
// agent image under the real DockerSandbox, so Pi's requests cross the real proxy, debit ledger and settlement sink. Test-side reads are
// limited to observation: the fake model's recorded calls and, where no pomtree verb exposes it, the debit ledger row (read-only).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { POMTREED_KINDS, secretFileEnv } from "@pomtree/core";
import { FakeModelUpstream, type ModelScript } from "@pomtree/testing";
import { envName } from "../../pomtreed/src/daemon-config.ts";
import { gitRepo } from "./harness.ts";
import { imageRevisionSkip } from "./image-gate.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pomtreedMain = join(ROOT, "packages/pomtreed/src/main.ts");
const pomtreeMain = join(ROOT, "packages/pomtree/src/main.ts");

// The model every scenario pins (spawn --model / the template): an OpenAI chat-completions provider in the pinned Pi catalog, so Pi speaks
// the stub's openai-completions wire and the proxy prices from the catalog.
export const PROVIDER = "deepseek";
export const MODEL = "deepseek-flash";

export const image = process.env.PTREE_E2E_IMAGE;

// The proxy prices the stub's token usage from a Pi model catalog. Left to discovery, pomtreed reads the catalog of whatever `pi` is on the
// developer's PATH; with none (a CI runner), it has no rates, refuses every stub response as unpriceable (502 malformed_response), and each
// agent only ever parks on its provider-error retry timer. So the stack pins `pi.catalogDir` to this fixture: one entry with the cost of
// deepseek-flash in the Pi catalog, so settlements match what a developer machine computed. The manifest's far-future `generatedAt` keeps a
// models-store.json overlay in the developer's ~/.pi/agent from repricing it (an overlay applies only when it is newer).
export const CATALOG_COST = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
export function writeCatalogFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".manifest.json"), JSON.stringify({ generatedAt: "9999-12-31T00:00:00.000Z" }));
  const entry = { id: MODEL, type: "chat", api: "openai-completions", provider: PROVIDER, cost: CATALOG_COST };
  writeFileSync(join(dir, `${PROVIDER}.json`), JSON.stringify({ "openai-completions": { [`chat:${MODEL}`]: entry } }));
}

const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

// Gate mirrors docker-proxy-path.test.ts: Docker tests opted in, an agent image named and present, built from this checkout.
export function cliScenarioSkip(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (lite run)";
  if (!image) return "PTREE_E2E_IMAGE unset";
  if (sh("docker", ["info"]) === undefined) return "docker daemon unreachable";
  if (sh("docker", ["image", "inspect", image]) === undefined) return `${image} unavailable (this test never pulls or builds)`;
  const revision = process.env.PTREE_AGENT_TEST_REVISION ?? sh("git", ["rev-parse", "--short", "HEAD"]);
  const paths = [":(top)packages/agent-image", ":(top)packages/sandbox-docker"];
  const dirty =
    sh("git", ["diff", "HEAD", "--stat", "--", ...paths]) !== "" || sh("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths]) !== "";
  return imageRevisionSkip(
    image,
    sh("docker", ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]),
    revision,
    dirty,
  );
}

export interface PomtreeRun {
  code: number | null;
  out: string;
  err: string;
  json<T = unknown>(): T;
}

export interface JournalEvent {
  seq: number;
  agent: string;
  generation: number;
  payload: { kind: string; [k: string]: unknown };
}

export interface Settlement {
  kind: string;
  settlement: "priced" | "estimated" | "reserve" | "failed";
  micros: number;
  requestId: string;
  upstreamStatus?: number;
  errorClass?: string;
  finishReason?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface AgentJson {
  id: string;
  name: string;
  parent?: string | null;
  state: string;
  exit?: string;
  exitCause?: string;
  generation: number;
  budgetMicros: number;
  result?: unknown;
}

export interface Template {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  budgetMicros?: number;
  egress?: { kind: string };
}

export interface Stack {
  stateDir: string;
  stub: FakeModelUpstream;
  pomtree(args: string[], timeoutMs?: number): Promise<PomtreeRun>;
  // `pomtree wait` in bounded slices until the agent exits or `totalMs` passes; the last wait's output.
  waitExited(id: string, totalMs: number): Promise<PomtreeRun>;
  events(id: string): Promise<JournalEvent[]>;
  kinds(id: string, kind: string): Promise<JournalEvent[]>;
  settlements(id: string): Promise<Settlement[]>;
  until(what: string, ok: () => Promise<boolean>, timeoutMs: number): Promise<void>;
  // The debit ledger row (no pomtree verb shows reserved micros); read-only, beside the live daemon.
  debit(agent: string): { budget: number; spent: number; reserved: number } | null;
  restart(): Promise<void>;
  // Signals pomtreed and waits for it to exit, leaving the state dir in place so restart() boots on it.
  kill(signal: NodeJS.Signals): Promise<void>;
  pomtreedLog(): string;
  close(): Promise<void>;
}

// Signals `p` and waits for it to exit, escalating to SIGKILL after `graceMs`. A child that already died, by exit code or by signal, returns
// at once: its 'exit' event has fired and will not fire again, and a signal death leaves exitCode null.
export async function stopChild(p: ChildProcess, signal: NodeJS.Signals, graceMs: number): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise<void>((r) => p.once("exit", () => r()));
  p.kill(signal);
  const t = setTimeout(() => p.kill("SIGKILL"), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(t);
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startStack(o: { script: ModelScript; templates?: Record<string, Template>; set?: Record<string, string> }): Promise<Stack> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pcli-")));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const templatesDir = join(root, "templates");
  mkdirSync(templatesDir);
  for (const [name, t] of Object.entries(o.templates ?? {})) writeFileSync(join(templatesDir, `${name}.json`), JSON.stringify(t));
  const repo = gitRepo();
  const keyFile = join(root, "upstream.key");
  const upstreamKey = "stub-upstream-key-not-real";
  writeFileSync(keyFile, `${upstreamKey}\n`, { mode: 0o600 });
  const socket = join(root, "pomtreed.sock"); // short: unix socket paths are limited to ~100 bytes
  const stub = await FakeModelUpstream.start({ script: o.script, expectKey: upstreamKey });
  const uiPort = await freePort();
  const catalogDir = join(root, "pi-catalog");
  writeCatalogFixture(catalogDir);

  const agentImageId = (image && sh("docker", ["image", "inspect", "--format", "{{.Id}}", image])) || image || "";
  const sets: Record<string, string> = {
    "state.dir": stateDir,
    "repo.dir": repo,
    "socket.path": socket,
    "templates.dir": templatesDir,
    "ui.listen": `127.0.0.1:${uiPort}`,
    // TODO(egress-image): the egress sidecar image must be digest-pinned, so pass the image id; use sandbox-docker's pinnedImage() once exported.
    "agent.image": agentImageId,
    // The sidecar runs the agent image; pomtreed refuses to start while this is empty (a dummy id when no image is named: the gate skips then).
    "agent.egressProxyImage": agentImageId.startsWith("sha256:") ? agentImageId : `sha256:${"0".repeat(64)}`,
    "agent.untemplatedEgress": "registry", // required; registry keeps the prior behavior (untemplated agents reach package registries)
    "extensions.approval": "all", // required; what unset resolved to with the default ["ui"] escalation channel
    "model.baseUrl": stub.baseUrl,
    "pi.provider": PROVIDER,
    "pi.catalogDir": catalogDir,
    // The hosted CI runner has ~8 GB (2 vCPUs), and the memory gate counts the running agent containers of every daemon on the
    // Docker host (two test files run at once there). At the 2 GiB default it admits 3 containers host-wide, fewer than one relay,
    // custody or recovery tree needs. This is also each container's real --memory limit: stub-driven agents peaked at ~262 MiB
    // (docker stats, relay, custody and recovery files), so 512 MiB keeps about 2x headroom and admits 13 on that runner.
    "capacity.containerMemoryBytes": String(512 * 1024 ** 2),
    ...o.set,
  };
  // The operator's own POMTREED_*/POMTREE_* settings must not leak into the stack under test; the key arrives only through its 0600 file.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("POMTREED_") && !k.startsWith("POMTREE_")));
  const pomtreedEnv = { ...baseEnv, [secretFileEnv(envName("model.upstreamKey"))]: keyFile };
  const pomtreeEnv = { ...baseEnv, POMTREED_STATE_DIR: stateDir, POMTREE_SOCKET: socket };

  let child: ChildProcess | undefined;
  let log = "";
  const pomtree = (args: string[], timeoutMs = 60_000): Promise<PomtreeRun> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [pomtreeMain, "--json", ...args], { env: pomtreeEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (c: Buffer) => (out += c.toString()));
      p.stderr.on("data", (c: Buffer) => (err += c.toString()));
      const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          out,
          err,
          json<T>() {
            try {
              return JSON.parse(out) as T;
            } catch {
              throw new Error(`pomtree ${args.join(" ")} printed no JSON (exit ${code}): ${out.slice(0, 500)} ${err.slice(0, 500)}`);
            }
          },
        });
      });
    });

  const startOnce = async () => {
    const argv = [pomtreedMain, ...Object.entries(sets).flatMap(([k, v]) => ["--set", `${k}=${v}`])];
    const p = spawn(process.execPath, argv, { env: pomtreedEnv, stdio: ["ignore", "ignore", "pipe"] });
    child = p;
    let thisRun = "";
    p.stderr?.on("data", (c: Buffer) => {
      log = (log + c.toString()).slice(-200_000);
      thisRun = (thisRun + c.toString()).slice(-20_000);
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (p.exitCode !== null) throw new Error(`pomtreed exited during startup (${p.exitCode}):\n${log.slice(-3000)}`);
      // Ready means the socket answers AND pomtreed has logged its UI bind: the socket exists long before the model-proxy and UI binds,
      // where a port taken since freePort() closed its probe socket surfaces as EADDRINUSE and a dead pomtreed.
      if (existsSync(socket) && existsSync(join(stateDir, "operator.token")) && thisRun.includes("pomtreed ui endpoint on")) {
        const d = await pomtree(["doctor"], 15_000);
        if (d.code === 0) return;
      }
      if (Date.now() > deadline) throw new Error(`pomtreed not ready after 60s:\n${log.slice(-3000)}`);
      await sleep(100);
    }
  };
  // A port picked with freePort() can be taken between the probe and pomtreed's bind (parallel test files share the ephemeral range):
  // retry that failure class with fresh ports; anything else is a real startup failure and surfaces unchanged.
  const start = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await startOnce();
      } catch (e) {
        if (attempt >= 3 || !String(e).includes("EADDRINUSE")) throw e;
        await stop();
        rmSync(socket, { force: true });
        log = "";
        sets["ui.listen"] = `127.0.0.1:${await freePort()}`;
        if (sets["model.proxy.port"] !== undefined) sets["model.proxy.port"] = String(await freePort());
      }
    }
  };
  const stop = async () => {
    if (child) await stopChild(child, "SIGTERM", 30_000);
  };

  try {
    await start();
  } catch (e) {
    await stop();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    throw e;
  }

  const events = async (id: string): Promise<JournalEvent[]> => {
    const r = await pomtree(["logs", id]);
    if (r.code !== 0) throw new Error(`pomtree logs ${id} exit ${r.code}: ${r.err}`);
    return r.out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as JournalEvent);
  };
  const kinds = async (id: string, kind: string) => (await events(id)).filter((e) => e.payload.kind === kind);
  const until = async (what: string, ok: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await ok())) {
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n--- pomtreed log tail\n${log.slice(-3000)}`);
      await sleep(200);
    }
  };

  return {
    stateDir,
    stub,
    pomtree,
    async waitExited(id, totalMs) {
      const deadline = Date.now() + totalMs;
      for (;;) {
        const left = Math.max(1000, Math.min(20_000, deadline - Date.now()));
        const w = await pomtree(["wait", id, "--timeout", String(left)], left + 30_000);
        if (w.code !== 7 || Date.now() >= deadline) return w;
      }
    },
    events,
    kinds,
    settlements: async (id) => (await kinds(id, POMTREED_KINDS.modelSettlement)).map((e) => e.payload as unknown as Settlement),
    until,
    debit(agent) {
      const db = new DatabaseSync(join(stateDir, "pomtreed.sqlite"), { readOnly: true });
      try {
        const r = db.prepare("SELECT budget_micros, spent_micros, reserved_micros FROM model_debit_agents WHERE agent=?").get(agent) as
          | Record<string, number>
          | undefined;
        return r ? { budget: r.budget_micros!, spent: r.spent_micros!, reserved: r.reserved_micros! } : null;
      } finally {
        db.close();
      }
    },
    async restart() {
      await stop();
      await start();
    },
    async kill(signal) {
      if (child) await stopChild(child, signal, 30_000);
    },
    pomtreedLog: () => log,
    async close() {
      try {
        // SIGTERM drains and leaves containers adoptable, so stop every live agent first: no container outlives the test.
        if (child?.exitCode === null && child.signalCode === null) {
          const ps = await pomtree(["ps"], 20_000);
          const live = ps.code === 0 ? ps.json<AgentJson[]>().filter((a) => !["exited", "reaped"].includes(a.state) && a.parent !== null) : [];
          for (const a of live) await pomtree(["kill", a.id], 20_000);
          const deadline = Date.now() + 30_000;
          for (const a of live) {
            while (Date.now() < deadline) {
              const s = await pomtree(["show", a.id], 20_000);
              if (s.code !== 0 || ["exited", "reaped"].includes(s.json<{ agent: AgentJson }>().agent.state)) break;
              await sleep(500);
            }
          }
        }
      } finally {
        await stop();
        await stub.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    },
  };
}

// Bash tool calls the scripted model makes; Pi runs them inside the container, where `pomtree` talks to pomtreed with the agent's token.
export const bash = (command: string) => ({ name: "bash", arguments: { command } });

// Journal kinds a failure dump lists per agent: a model call that failed in transit becomes a provider_error, which pomtreed answers by
// parking the agent on a short timer and resuming it with a wake text that no task rule matches, so it shows up only as unmatched calls.
const ERROR_KINDS = new Set(["error", "provider_error"]);

// Pure: one line per error entry of one agent's journal (kind, code, generation, the message's first 300 characters, JSON-quoted), and
// one per failed model settlement (the proxy's error class and upstream status tell a proxy-side failure from one past the proxy).
export function errorLines(agent: { id: string; name: string }, events: readonly JournalEvent[]): string[] {
  const head = (e: JournalEvent) => `${agent.name} ${agent.id} gen ${e.generation} ${e.payload.kind}`;
  return events.flatMap((e) => {
    if (ERROR_KINDS.has(e.payload.kind)) {
      const code = typeof e.payload.code === "string" ? ` ${e.payload.code}` : "";
      return [`${head(e)}${code}: ${JSON.stringify(String(e.payload.message ?? "").slice(0, 300))}`];
    }
    if (e.payload.kind === POMTREED_KINDS.modelSettlement && e.payload.settlement === "failed")
      return [`${head(e)} failed: errorClass=${e.payload.errorClass} upstreamStatus=${e.payload.upstreamStatus}`];
    return [];
  });
}

// Every listed agent's error entries for a failure dump, or why they could not be read; "(none)" when there are none. It is also written
// to stderr at once, so a run that is killed before node:test prints its failure details still shows them.
export async function agentErrorDump(s: Stack): Promise<string> {
  let out: string;
  try {
    const ps = await s.pomtree(["ps"], 20_000);
    if (ps.code !== 0) out = `pomtree ps exit ${ps.code}: ${ps.err}`;
    else {
      const lines: string[] = [];
      for (const a of ps.json<AgentJson[]>()) lines.push(...errorLines(a, await s.events(a.id)));
      out = lines.length > 0 ? lines.join("\n") : "(none)";
    }
  } catch (e) {
    out = `could not collect agent errors: ${(e as Error).message}`;
  }
  process.stderr.write(`e2e failure: agent errors:\n${out}\n`);
  return out;
}
