// Standalone LIVE crash-and-recovery harness: the REAL production pomtreed (packages/pomtreed/src/main.ts) as a SEPARATE PROCESS on a temp
// POMTREED_STATE_DIR, a real haiku agent on the real agent image, driven through the real `pomtree` CLI. After the agent's first settled model
// call pomtreed is SIGKILLed (the container survives), pomtreed is restarted on the same state dir, and the daemon's recovery promises are
// asserted (pure logic in crash-recovery-decisions.ts). With --kill-container the container is killed too, exercising resume of a dead one.
//
//   node packages/e2e/src/crash-recovery-live.ts --image <tag> --out <dir> [--kill-container] [--budget-micros N] [--model PROVIDER/ID]
//        [--deadline-ms N] [--agent-listen HOST:PORT]
// Set POMTREED_MODEL_BASE_URL and POMTREED_MODEL_UPSTREAM_KEY_FILE (a 0600 file read in-process, never printed) per the live runbook in scripts/live/README.md
// ('Runbook: live runs'), so the upstream key never appears in a command line.
// Env (names only): POMTREED_MODEL_BASE_URL, POMTREED_MODEL_UPSTREAM_KEY_FILE (a mode-0600 key file, checked by core's secret-file rule and handed to the pomtreed child as is; the key is never in the env or argv), POMTREED_PI_PROVIDER (default openrouter),
// POMTREED_PI_CATALOG_DIR (optional). POMTREED_MODEL_BASE_URL must be https://openrouter.ai/api (no /v1): the Pi anthropic-messages catalog entry
// appends its own path (see examples/hn-digest/content-live-upstream.mts header). Spend: one haiku agent, budget capped at --budget-micros (default 100000, refused above 300000).
// Exit codes: 0 all assertions held; 2 refused before start; 3 agent never finished / deadline; 4 an assertion failed.
// Cleanup (always): pomtreed children SIGKILLed; this run's containers, egress sidecars, volumes and networks removed; temp dir deleted.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EngineProfile } from "@pomtree/sandbox-docker";
import { sanitizeJournal } from "./browser-live-audit.ts";
import type { DebitRow } from "./browser-live-audit.ts";
import { evaluateRecovery, parseArgs, TASK } from "./crash-recovery-decisions.ts";
import type { AgentView, Args, ContainerView, Evidence, JEntry } from "./crash-recovery-decisions.ts";
import { Deadline, Fatal, freePort, getSock, sh, sleep, until } from "./live-harness-util.ts";
import { engineEnv, liveEngine, pinnedImage, readUpstreamKeyFile } from "./live-model.ts";

const pomtreedMain = join(import.meta.dirname, "../../pomtreed/src/main.ts");
const pomtreeMain = join(import.meta.dirname, "../../pomtree/src/main.ts");

interface Pomtreed {
  child: ChildProcess;
  exited: Promise<void>;
  log: () => string;
}

export async function main(args: Args, env: NodeJS.ProcessEnv): Promise<{ exitCode: 0 | 2 | 3 | 4; message: string }> {
  const refuse = (message: string) => ({ exitCode: 2 as const, message });
  const provider = env.POMTREED_PI_PROVIDER || "openrouter";
  if (!env.POMTREED_MODEL_BASE_URL)
    return refuse("POMTREED_MODEL_BASE_URL is required (set it and POMTREED_MODEL_UPSTREAM_KEY_FILE per scripts/live/README.md, 'Runbook: live runs')");
  let upstreamKey: string;
  try {
    upstreamKey = readUpstreamKeyFile(env);
  } catch (e) {
    return refuse(`${(e as Error).message} (set POMTREED_MODEL_UPSTREAM_KEY_FILE to a 0600 key file per scripts/live/README.md, 'Runbook: live runs')`);
  }
  let engine: EngineProfile;
  try {
    engine = liveEngine(env);
  } catch (e) {
    return refuse((e as Error).message);
  }
  if ((await sh(engine.binary, ["image", "inspect", args.image], undefined, 15_000)).code !== 0)
    return refuse(`image ${args.image} unavailable (${engine.binary} unreachable or not built; this never pulls)`);

  mkdirSync(args.out, { recursive: true });
  const out = realpathSync(args.out);
  const secrets = [upstreamKey];
  const scrubbed = (t: string) => secrets.filter((x) => x.length >= 8).reduce((acc, x) => acc.split(x).join("[redacted]"), t);
  const write = (name: string, v: unknown) => writeFileSync(join(out, name), scrubbed(typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`));

  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-crl-")));
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  const sock = join(root, "p.sock");
  mkdirSync(repo);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "crl",
    GIT_AUTHOR_EMAIL: "crl@example.invalid",
    GIT_COMMITTER_NAME: "crl",
    GIT_COMMITTER_EMAIL: "crl@example.invalid",
  };
  for (const a of [
    ["init", "-q", "-b", "main"],
    ["commit", "-q", "--allow-empty", "-m", "base"],
  ])
    await sh("git", ["-C", repo, ...a], gitEnv, 15_000);
  const keyFile = realpathSync(env.POMTREED_MODEL_UPSTREAM_KEY_FILE as string); // the caller's file, already checked; contents are never logged
  const modelPort = await freePort();
  const agentListen = args.agentListen ?? (process.platform === "darwin" ? `127.0.0.1:${await freePort()}` : undefined);

  const children: Pomtreed[] = [];
  const startPomtreed = (): Pomtreed => {
    const child = spawn(process.execPath, [pomtreedMain], {
      env: {
        PATH: env.PATH ?? "",
        HOME: env.HOME ?? homedir(),
        // The engine selection and the sockets pomtreed discovers it by; pomtreed's env is scrubbed, so each is forwarded only when set.
        ...engineEnv(env),
        ...(env.POMTREED_PI_CATALOG_DIR && { POMTREED_PI_CATALOG_DIR: env.POMTREED_PI_CATALOG_DIR }),
        POMTREED_STATE_DIR: stateDir,
        POMTREED_SOCKET_PATH: sock,
        POMTREED_REPO_DIR: repo,
        POMTREED_REPO_DEFAULT_BRANCH: "main",
        POMTREED_AGENT_IMAGE: args.image,
        POMTREED_AGENT_EGRESS_PROXY_IMAGE: pinnedImage(args.image, engine), // required: the sidecar runs the agent image, digest-pinned by its local id
        POMTREED_AGENT_UNTEMPLATED_EGRESS: "registry", // required; the prior behavior (untemplated agents reach package registries)
        POMTREED_EXTENSIONS_APPROVAL: "all", // required; what unset resolved to with the default ["ui"] escalation channel
        POMTREED_PI_PROVIDER: provider,
        POMTREED_MODEL_BASE_URL: env.POMTREED_MODEL_BASE_URL!,
        POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile,
        POMTREED_MODEL_PROXY_PORT: String(modelPort),
        POMTREED_BUDGET_ROOT_MICROS: String(args.budgetMicros * 2),
        POMTREED_BUDGET_TOP_LEVEL_MICROS: String(args.budgetMicros),
        POMTREED_BUDGET_DEFAULT_MICROS: String(args.budgetMicros),
        POMTREED_UI_LISTEN: "off",
        POMTREED_HOST_LISTEN: "off",
        ...(agentListen && { POMTREED_AGENT_LISTEN: agentListen }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const cap = (d: Buffer) => {
      log = (log + String(d)).slice(-200_000);
    };
    child.stdout!.on("data", cap);
    child.stderr!.on("data", cap);
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const p = { child, exited, log: () => log };
    children.push(p);
    return p;
  };
  const ready = (p: Pomtreed) =>
    until("pomtreed /readyz", 90_000, async () => {
      if (p.child.exitCode !== null) throw new Fatal(`pomtreed exited early: ${scrubbed(p.log()).slice(-400)}`);
      return (await getSock(sock, "/readyz")) === 200 ? true : undefined;
    });

  const pomtreeEnv = { PATH: env.PATH ?? "", HOME: env.HOME ?? homedir(), POMTREED_STATE_DIR: stateDir, POMTREE_SOCKET: sock };
  const pomtree = async (...a: string[]): Promise<unknown> => {
    const r = await sh(process.execPath, [pomtreeMain, ...a, "--json"], pomtreeEnv, 60_000);
    if (r.code !== 0) throw new Error(`pomtree ${a[0]} exited ${r.code}: ${scrubbed(r.err).slice(0, 300)}`);
    return JSON.parse(r.out);
  };
  const dbPath = join(stateDir, "pomtreed.sqlite");
  const withDb = <T>(f: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return f(db);
    } finally {
      db.close();
    }
  };
  const journalOf = (agent: string): JEntry[] =>
    withDb((db) =>
      (
        db.prepare("SELECT seq, generation, payload FROM journal WHERE agent=? ORDER BY seq").all(agent) as {
          seq: number;
          generation: number;
          payload: string;
        }[]
      ).map((r) => ({
        seq: r.seq,
        generation: r.generation,
        payload: JSON.parse(r.payload),
      })),
    );
  const debitOf = (agent: string): DebitRow[] =>
    withDb(
      (db) =>
        db
          .prepare(
            "SELECT request_id, status, charged_micros, maximum_micros, created_at FROM model_debit_requests WHERE agent=? ORDER BY created_at, request_id",
          )
          .all(agent) as unknown as DebitRow[],
    );
  const spentOf = (agent: string): number =>
    withDb(
      (db) => (db.prepare("SELECT spent_micros FROM model_debit_agents WHERE agent=?").get(agent) as { spent_micros: number } | undefined)?.spent_micros ?? 0,
    );
  const agentOf = async (id: string): Promise<AgentView & { exitCause?: string }> => {
    const r = (await pomtree("show", id)) as { agent: AgentView & { exitCause?: string } };
    return r.agent;
  };
  const storeId = () => {
    try {
      return readFileSync(join(stateDir, "store-id"), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  const containers = async (): Promise<(ContainerView & { sandbox: string })[]> => {
    const sid = storeId();
    if (!sid) return [];
    const r = await sh(engine.binary, ["ps", "-a", "--filter", `label=store_id=${sid}`, "--format", '{{.Names}}|{{.State}}|{{.Label "pomtree.sandbox"}}']);
    return r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [id, state, sandbox] = l.split("|");
        return { id: id!, running: state === "running", sandbox: sandbox! };
      });
  };
  const seenSandboxes = new Set<string>();
  const trackSandboxes = async () => {
    for (const c of await containers()) seenSandboxes.add(c.sandbox);
  };

  const t0 = Date.now();
  let verdictMessage = "";
  let exitCode: 0 | 3 | 4 = 3;
  let agentId = "";
  try {
    let p1 = startPomtreed();
    await ready(p1);
    const spawned = (await pomtree(
      "spawn",
      "--task",
      TASK,
      "--name",
      "crash-recovery",
      "--budget",
      String(args.budgetMicros),
      "--model",
      args.model,
      "--deadline",
      "15m",
    )) as { id: string };
    agentId = spawned.id;
    console.error(`spawned ${agentId}; waiting for a running container with a settled model call`);

    // Wait for: a registered sandbox, the agent still running, and at least one settled (non-probe) debit row.
    const pre = await until("a running container with one settled model call", 240_000, async () => {
      const a = await agentOf(agentId);
      if (TERMINAL(a.state)) throw new Deadline(`agent reached ${a.state}/${a.exit} before the kill (task too quick, or it failed early)`);
      const settled = debitOf(agentId).filter((r) => !r.request_id.endsWith(":probe") && r.status === "settled");
      return a.sandbox && a.state === "running" && settled.length >= 1 ? a : undefined;
    });
    await trackSandboxes();

    // The crash: pomtreed dies without any shutdown handling; the agent container is untouched.
    p1.child.kill("SIGKILL");
    await p1.exited;
    console.error("pomtreed SIGKILLed");
    const sandbox = pre.sandbox!;
    if (args.variant === "dead-container") await sh(engine.binary, ["kill", `pomtree-${sandbox}`]);
    await sleep(2_000);
    const insp = await sh(engine.binary, ["inspect", "-f", "{{.State.Running}}", `pomtree-${sandbox}`]);
    const containerRunningAfterKill = insp.out.trim() === "true";
    const maxSeq = withDb((db) => (db.prepare("SELECT MAX(seq) AS m FROM journal").get() as { m: number | null }).m ?? 0);
    const preSnap = { agent: pre as AgentView, maxSeq, debit: debitOf(agentId), spentMicros: spentOf(agentId), containerRunningAfterKill };
    write("pre-kill.json", { ...preSnap, secondsSinceStart: Math.round((Date.now() - t0) / 1000) });

    // Recovery: same state dir, same ports.
    p1 = startPomtreed();
    await ready(p1);
    console.error("pomtreed restarted; waiting for the agent to finish");
    const final = await until("the agent to finish after the restart", args.deadlineMs, async () => {
      await trackSandboxes();
      const a = await agentOf(agentId);
      return TERMINAL(a.state) ? a : undefined;
    });
    await sleep(1_500); // settlement and teardown journal asynchronously
    await trackSandboxes();

    let operatorApiOk = false;
    try {
      operatorApiOk = Array.isArray(await pomtree("ps"));
    } catch {
      // stays false
    }
    const all = await containers();
    const wsRoot = join(stateDir, "workspaces");
    let workspaceDirs = 0;
    try {
      workspaceDirs = readdirSync(wsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    } catch {
      // none
    }
    let show: unknown = null;
    try {
      show = await pomtree("show", agentId);
    } catch {
      // leave null
    }
    const journal = journalOf(agentId);
    const evidence: Evidence = {
      variant: args.variant,
      capMicros: args.budgetMicros,
      pre: preSnap,
      final: {
        agent: final,
        journal,
        debit: debitOf(agentId),
        spentMicros: spentOf(agentId),
        agentContainers: all.map((c) => ({ id: c.id, running: c.running })),
        workspaceDirs,
        operatorApiOk,
      },
    };
    const verdict = evaluateRecovery(evidence);
    write("journal.json", sanitizeJournal(journal, secrets));
    write("debit-rows.json", evidence.final.debit);
    write("final-show.json", show);
    write("assertions.json", {
      ok: verdict.ok,
      variant: args.variant,
      inputs: { image: args.image, model: args.model, budgetMicros: args.budgetMicros, agent: agentId, agentListen },
      checks: verdict.checks,
      observations: verdict.observations,
    });
    write("report.txt", renderReport(args, agentId, verdict, Math.round((Date.now() - t0) / 1000)));
    exitCode = verdict.ok ? 0 : 4;
    verdictMessage =
      verdict.checks
        .filter((c) => !c.ok)
        .map((c) => `FAIL ${c.name}: ${c.detail}`)
        .join("\n") || "all assertions held";
    return { exitCode, message: verdictMessage };
  } catch (e) {
    if (e instanceof Deadline) {
      write("report.txt", `agent never finished: ${e.message}\nagent=${agentId}\n`);
      return { exitCode: 3, message: e.message };
    }
    throw e;
  } finally {
    for (const [i, p] of children.entries()) {
      p.child.kill("SIGKILL");
      await p.exited.catch(() => {});
      try {
        write(`pomtreed-${i + 1}.log`, p.log());
      } catch {
        // out dir gone
      }
    }
    await trackSandboxes().catch(() => {});
    const ids = async (...a: string[]) => (await sh(engine.binary, a)).out.split("\n").filter(Boolean);
    for (const sb of seenSandboxes) {
      // agent container, egress sidecar, egress volume and network are all found by the sandbox id (label, or name for networks)
      const cs = await ids("ps", "-aq", "--filter", `label=pomtree.sandbox=${sb}`);
      if (cs.length) await sh(engine.binary, ["rm", "-f", "-v", ...cs]);
      await sh(engine.binary, ["rm", "-f", "-v", `pomtree-${sb}`]);
      const vs = await ids("volume", "ls", "-q", "--filter", `label=pomtree.sandbox=${sb}`);
      if (vs.length) await sh(engine.binary, ["volume", "rm", "-f", ...vs]);
      const ns = [
        ...new Set([
          ...(await ids("network", "ls", "-q", "--filter", `label=pomtree.sandbox=${sb}`)),
          ...(await ids("network", "ls", "-q", "--filter", `name=${sb}`)),
        ]),
      ];
      if (ns.length) await sh(engine.binary, ["network", "rm", ...ns]);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const TERMINAL = (s: string) => s === "exited" || s === "reaped";

function renderReport(args: Args, agent: string, v: ReturnType<typeof evaluateRecovery>, seconds: number): string {
  return [
    `crash-recovery-live: variant=${args.variant} agent=${agent} image=${args.image} model=${args.model} cap=${args.budgetMicros} micros wall=${seconds}s`,
    "",
    "ASSERTIONS",
    ...v.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`),
    "",
    "OBSERVATIONS (not pass/fail)",
    ...v.observations.map((o) => `-    ${o.name}: ${o.detail}`),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if ("refusal" in args) {
    console.error(`refused: ${args.refusal}`);
    process.exit(2);
  }
  try {
    const r = await main(args, process.env);
    console.error(r.message);
    process.exit(r.exitCode);
  } catch (e) {
    console.error(`error before a verdict: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
