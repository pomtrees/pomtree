// Standalone LIVE multi-agent crash-and-recovery harness (REC-1: REC-5 with a real model). The REAL production pomtreed
// (packages/pomtreed/src/main.ts) as a SEPARATE PROCESS on a temp POMTREED_STATE_DIR, real haiku agents on the real agent image, driven through
// the real `pomtree` CLI. One parent P is told to spawn two children (explicit small budgets, several slow bash steps each), wait for and
// reap each, and report; one unrelated top-level agent U runs the single-agent harness's task. Once P's two children exist, every agent runs
// in a container and the tree has a settled model call, pomtreed is SIGKILLed (the containers survive), restarted on the same state dir and
// ports, and the recovery promises are asserted (pure logic in crash-recovery-multi-decisions.ts; adopt variant only). After the restart the
// harness plays the operator: a child whose in-flight request at the kill was charged in full is refused by the proxy, escalates and parks on a
// budget_raise approval, and the decide step approves it (`pomtree decide`, a fixed refill grant, at most 3 per run) so the tree can finish.
//
//   node packages/e2e/src/crash-recovery-live-multi.ts --image <tag> --out <dir> [--budget-micros N] [--model PROVIDER/ID]
//        [--deadline-ms N] [--agent-listen HOST:PORT] [--dry-run]
// --dry-run runs the refusal, image and key-file checks, prints the plan and its spend cap, and exits 0 before starting pomtreed or any agent.
// Set POMTREED_MODEL_BASE_URL and POMTREED_MODEL_UPSTREAM_KEY_FILE (a 0600 file read in-process, never printed) per the live runbook in scripts/live/README.md
// ('Runbook: live runs'), so the upstream key never appears in a command line.
// Env (names only): POMTREED_MODEL_BASE_URL, POMTREED_MODEL_UPSTREAM_KEY_FILE (a mode-0600 key file, checked by core's secret-file rule and handed to the pomtreed child as is; the key is never in the env or argv), POMTREED_PI_PROVIDER (default openrouter),
// POMTREED_PI_CATALOG_DIR (optional). POMTREED_MODEL_BASE_URL must be https://openrouter.ai/api (no /v1), as for crash-recovery-live.ts.
// Spend: up to three haiku agents' worth of top-level budget plus two children carved from the parent. --budget-micros is the per-top-level-agent
// budget (default 100000, refused above 150000 or below what the parent needs to fund its children); the root budget is 3x it; each child gets 15000.
// Exit codes: 0 all assertions held (or a dry run passed its preflight); 2 refused before start; 3 tree never finished / deadline; 4 an assertion failed.
// Cleanup (always): pomtreed children SIGKILLed; this run's containers, egress sidecars, volumes and networks removed; temp dir deleted.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sanitizeJournal } from "./browser-live-audit.ts";
import { dumpDeadlineEvidence } from "./crash-recovery-evidence.ts";
import type { DebitRow } from "./browser-live-audit.ts";
import { SANDBOX_KIND, TASK } from "./crash-recovery-decisions.ts";
import type { AgentView, JEntry, Verdict } from "./crash-recovery-decisions.ts";
import {
  CHILD_BUDGET_MICROS,
  CHILD_COUNT,
  ROOT_BUDGET_FACTOR,
  decideArgs,
  decideStep,
  evaluateCampaign,
  evaluateMulti,
  newDecideState,
  parentTask,
  parseCampaignRows,
  parseMultiArgs,
  renderCampaign,
  renderPlan,
} from "./crash-recovery-multi-decisions.ts";
import type { AgentEvidence, ApprovalRow, MultiArgs, MultiEvidence, Role, WireDebitRow } from "./crash-recovery-multi-decisions.ts";
import { Deadline, Fatal, freePort, getSock, sh, sleep, until } from "./live-harness-util.ts";
import { pinnedImage, readUpstreamKeyFile } from "./live-model.ts";

const pomtreedMain = join(import.meta.dirname, "../../pomtreed/src/main.ts");
const pomtreeMain = join(import.meta.dirname, "../../pomtree/src/main.ts");

interface Pomtreed {
  child: ChildProcess;
  exited: Promise<void>;
  log: () => string;
}
type ShowAgent = AgentView & { id: string; name: string; parent: string | null };
interface Container {
  id: string; // docker container name
  running: boolean;
  sandbox: string;
}

const TERMINAL = (s: string) => s === "exited" || s === "reaped";

export async function main(args: MultiArgs, env: NodeJS.ProcessEnv): Promise<{ exitCode: 0 | 2 | 3 | 4; message: string }> {
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
  if ((await sh("docker", ["image", "inspect", args.image], undefined, 15_000)).code !== 0)
    return refuse(`image ${args.image} unavailable (docker unreachable or not built; this never pulls)`);
  if (args.dryRun) return { exitCode: 0, message: renderPlan(args) };

  mkdirSync(args.out, { recursive: true });
  const out = realpathSync(args.out);
  const secrets = [upstreamKey];
  const scrubbed = (t: string) => secrets.filter((x) => x.length >= 8).reduce((acc, x) => acc.split(x).join("[redacted]"), t);
  const write = (name: string, v: unknown) => writeFileSync(join(out, name), scrubbed(typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`));

  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-crlm-")));
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
        ...(env.DOCKER_HOST && { DOCKER_HOST: env.DOCKER_HOST }),
        ...(env.POMTREED_PI_CATALOG_DIR && { POMTREED_PI_CATALOG_DIR: env.POMTREED_PI_CATALOG_DIR }),
        POMTREED_STATE_DIR: stateDir,
        POMTREED_SOCKET_PATH: sock,
        POMTREED_REPO_DIR: repo,
        POMTREED_REPO_DEFAULT_BRANCH: "main",
        POMTREED_AGENT_IMAGE: args.image,
        POMTREED_AGENT_EGRESS_PROXY_IMAGE: pinnedImage(args.image), // required: the sidecar runs the agent image, digest-pinned by its local id
        POMTREED_AGENT_UNTEMPLATED_EGRESS: "registry", // required; the prior behavior (untemplated agents reach package registries)
        POMTREED_EXTENSIONS_APPROVAL: "all", // required; what unset resolved to with the default ["ui"] escalation channel
        POMTREED_PI_PROVIDER: provider,
        POMTREED_MODEL_BASE_URL: env.POMTREED_MODEL_BASE_URL!,
        POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile,
        POMTREED_MODEL_PROXY_PORT: String(modelPort),
        POMTREED_BUDGET_ROOT_MICROS: String(args.budgetMicros * ROOT_BUDGET_FACTOR),
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
  // The same rows with the provider-wire columns the narrow DebitRow omits, for the live-only cost assertions and so a passing run's
  // artifacts carry `response_id`. The verdict path's own dump used to select five columns, so only a run that TIMED OUT (and so took
  // `dumpDeadlineEvidence`, which does `SELECT *`) ever left the wire columns behind.
  const wireDebitOf = (agent: string): WireDebitRow[] =>
    withDb(
      (db) =>
        db
          .prepare(
            "SELECT request_id, status, charged_micros, tokens_in, tokens_out, model, response_id, upstream_status FROM model_debit_requests WHERE agent=? ORDER BY created_at, request_id",
          )
          .all(agent) as unknown as WireDebitRow[],
    );
  const spentOf = (agent: string): number =>
    withDb(
      (db) => (db.prepare("SELECT spent_micros FROM model_debit_agents WHERE agent=?").get(agent) as { spent_micros: number } | undefined)?.spent_micros ?? 0,
    );
  const pendingApprovals = (): ApprovalRow[] =>
    withDb(
      (db) =>
        db
          .prepare("SELECT id, requester_id, action_kind, action_target, state FROM approvals WHERE state='pending' ORDER BY created_at, rowid")
          .all() as unknown as ApprovalRow[],
    );
  const maxSeqNow = () => withDb((db) => (db.prepare("SELECT MAX(seq) AS m FROM journal").get() as { m: number | null }).m ?? 0);
  const showOf = async (id: string): Promise<ShowAgent> => ((await pomtree("show", id)) as { agent: ShowAgent }).agent;
  const psOf = async (): Promise<{ id: string; parent: string | null }[]> => (await pomtree("ps")) as { id: string; parent: string | null }[];
  const storeId = () => {
    try {
      return readFileSync(join(stateDir, "store-id"), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  // Agent containers of this store (egress sidecars excluded: the agent container is named pomtree-<sandbox>).
  const containers = async (): Promise<Container[]> => {
    const sid = storeId();
    if (!sid) return [];
    const r = await sh("docker", ["ps", "-a", "--filter", `label=store_id=${sid}`, "--format", '{{.Names}}|{{.State}}|{{.Label "pomtree.sandbox"}}']);
    return r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [id, state, sandbox] = l.split("|");
        return { id: id!, running: state === "running", sandbox: sandbox! };
      })
      .filter((c) => c.id === `pomtree-${c.sandbox}`);
  };
  const seenSandboxes = new Set<string>();
  const samples: string[][] = [];
  const sample = async () => {
    const cs = await containers();
    for (const c of cs) seenSandboxes.add(c.sandbox);
    samples.push(cs.filter((c) => c.running).map((c) => c.sandbox));
    return cs;
  };

  let stopped = false;
  const stopPomtreeds = async () => {
    if (stopped) return;
    stopped = true;
    for (const [i, p] of children.entries()) {
      p.child.kill("SIGKILL");
      await p.exited.catch(() => {});
      try {
        write(`pomtreed-${i + 1}.log`, p.log());
      } catch {
        // out dir gone
      }
    }
  };
  // Remove this run's containers, sidecars, volumes and networks (found by the sandbox id: label, or name for networks). Idempotent.
  // Returns what a second look still finds; a failed docker query is reported as a leftover so the check fails closed.
  const removeDocker = async (): Promise<MultiEvidence["leftovers"]> => {
    await sample().catch(() => {});
    const ids = async (...a: string[]) => {
      const r = await sh("docker", a);
      return r.code === 0 ? r.out.split("\n").filter(Boolean) : [`docker ${a.slice(0, 2).join(" ")} failed: exit ${r.code}`];
    };
    const sweep = async (remove: boolean) => {
      const found: MultiEvidence["leftovers"] = { containers: [], volumes: [], networks: [] };
      for (const sb of seenSandboxes) {
        const cs = await ids("ps", "-aq", "--filter", `label=pomtree.sandbox=${sb}`);
        const named = await ids("ps", "-aq", "--filter", `name=pomtree-${sb}`);
        const vs = await ids("volume", "ls", "-q", "--filter", `label=pomtree.sandbox=${sb}`);
        const ns = [
          ...new Set([
            ...(await ids("network", "ls", "-q", "--filter", `label=pomtree.sandbox=${sb}`)),
            ...(await ids("network", "ls", "-q", "--filter", `name=${sb}`)),
          ]),
        ];
        if (remove) {
          if (cs.length || named.length) await sh("docker", ["rm", "-f", "-v", ...new Set([...cs, ...named])]);
          if (vs.length) await sh("docker", ["volume", "rm", "-f", ...vs]);
          if (ns.length) await sh("docker", ["network", "rm", ...ns]);
        } else {
          found.containers.push(...new Set([...cs, ...named]));
          found.volumes.push(...vs);
          found.networks.push(...ns);
        }
      }
      return found;
    };
    await sweep(true);
    return sweep(false);
  };

  const t0 = Date.now();
  const seconds = () => Math.round((Date.now() - t0) / 1000);
  const tree: { parent: string; solo: string; kids: string[] } = { parent: "", solo: "", kids: [] };
  const decide = newDecideState();
  try {
    let p1 = startPomtreed();
    await ready(p1);
    const spawnTop = async (task: string, name: string) =>
      (
        (await pomtree("spawn", "--task", task, "--name", name, "--budget", String(args.budgetMicros), "--model", args.model, "--deadline", "15m")) as {
          id: string;
        }
      ).id;
    tree.parent = await spawnTop(parentTask(args.model), "parent");
    tree.solo = await spawnTop(TASK, "solo");
    console.error(`spawned parent ${tree.parent} and solo ${tree.solo}; waiting for both children, all running with a settled model call`);

    // Wait for: the parent's two children, every agent running with a registered sandbox and a model call recorded, one of them settled.
    const pre = await until("the parent's two children and every agent running with a model call", 300_000, async () => {
      const kids = (await psOf()).filter((a) => a.parent === tree.parent).map((a) => a.id);
      if (kids.length > CHILD_COUNT) throw new Deadline(`the parent spawned ${kids.length} children, expected ${CHILD_COUNT}`);
      if (kids.length < CHILD_COUNT) {
        const p = await showOf(tree.parent);
        if (TERMINAL(p.state))
          throw new Deadline(`the parent reached ${p.state}/${p.exit} with ${kids.length} children (it failed early, or did not follow the task)`);
        return undefined;
      }
      const all = [tree.parent, ...kids, tree.solo];
      const views: ShowAgent[] = [];
      for (const id of all) {
        const a = await showOf(id);
        if (TERMINAL(a.state)) throw new Deadline(`${a.name} reached ${a.state}/${a.exit} before the kill (task too quick, or it failed early)`);
        if (a.state !== "running" || !a.sandbox) return undefined;
        if (debitOf(id).filter((r) => !r.request_id.endsWith(":probe")).length < 1) return undefined;
        views.push(a);
      }
      const settled = all.flatMap((id) => debitOf(id)).filter((r) => !r.request_id.endsWith(":probe") && r.status === "settled");
      if (settled.length < 1) return undefined;
      // The kill deliberately lands wherever the tree happens to be. An earlier version waited for a child to have a request in flight,
      // to force the budget stall; that does not work. The crash charges EVERY in-flight request at its full reservation, and a
      // reservation is clamped to the agent's whole remainder, so an agent mid-call at the kill is exhausted outright rather than merely
      // stalled. Waiting for one child to be mid-call picks a moment when the others are mid-call too: run 4 of 2026-11-03 caught the
      // parent and run 5 caught the solo agent, charging it its entire budget and failing it, at two to three times the usual spend.
      // The stall is therefore observed per run and gated across the campaign instead (`evaluateCampaign`).
      tree.kids = kids;
      return views;
    });
    await sample();
    const all = [tree.parent, ...tree.kids, tree.solo];

    // The crash: pomtreed dies without any shutdown handling; the agent containers are untouched.
    p1.child.kill("SIGKILL");
    await p1.exited;
    console.error("pomtreed SIGKILLed");
    await sleep(2_000);
    const maxSeq = maxSeqNow();
    const preSnap = new Map<string, AgentEvidence["pre"] & { journal: JEntry[] }>();
    for (const a of pre) {
      const insp = await sh("docker", ["inspect", "-f", "{{.State.Running}}", `pomtree-${a.sandbox}`]);
      preSnap.set(a.id, {
        agent: a,
        debit: debitOf(a.id),
        spentMicros: spentOf(a.id),
        containerRunningAfterKill: insp.out.trim() === "true",
        journal: journalOf(a.id),
      });
    }
    write("pre-kill.json", { maxSeq, secondsSinceStart: seconds(), agents: Object.fromEntries(preSnap) });

    // Recovery: same state dir, same ports.
    p1 = startPomtreed();
    await ready(p1);
    console.error("pomtreed restarted; waiting for the whole tree to finish (deciding any budget approval it raises)");
    const treeIds = new Set(all);
    const decideIo = {
      pending: pendingApprovals,
      decide: async (approval: string, grantMicros: number) => {
        await pomtree(...decideArgs(approval, grantMicros));
        console.error(`${seconds()}s: approved ${approval} (grant ${grantMicros} micros)`);
      },
    };
    await until("every agent to finish after the restart", args.deadlineMs, async () => {
      await sample();
      await decideStep(decideIo, treeIds, decide).catch((e) => console.error(`decide step: ${(e as Error).message}`)); // a read failure retries on the next poll
      const vs: ShowAgent[] = [];
      for (const id of all) {
        const a = await showOf(id);
        if (!TERMINAL(a.state)) return undefined;
        vs.push(a);
      }
      return vs;
    });
    await sleep(1_500); // settlement and teardown journal asynchronously
    const allContainers = await sample();

    let operatorApiOk = false;
    try {
      operatorApiOk = Array.isArray(await pomtree("ps"));
    } catch {
      // stays false
    }
    let workspaceDirs = 0;
    try {
      workspaceDirs = readdirSync(join(stateDir, "workspaces"), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    } catch {
      // none
    }
    const roleOf = (id: string): Role => (id === tree.parent ? "parent" : id === tree.solo ? "solo" : "child");
    const agents: AgentEvidence[] = [];
    for (const id of all) {
      const final = await showOf(id);
      const journal = journalOf(id);
      const started = new Set(journal.filter((e) => e.payload.kind === SANDBOX_KIND && e.payload.phase === "started").map((e) => String(e.payload.sandbox)));
      const { journal: preJournal, ...pre1 } = preSnap.get(id)!;
      agents.push({
        role: roleOf(id),
        id,
        name: final.name,
        parent: final.parent ?? null,
        capMicros: roleOf(id) === "child" ? CHILD_BUDGET_MICROS : args.budgetMicros,
        pre: pre1,
        preJournal,
        wireDebit: wireDebitOf(id),
        final: {
          agent: final,
          journal,
          debit: debitOf(id),
          spentMicros: spentOf(id),
          agentContainers: allContainers.filter((c) => started.has(c.sandbox)).map((c) => ({ id: c.id, running: c.running })),
          workspaceDirs,
          operatorApiOk,
        },
      });
    }

    // Cleanup comes before the verdict so "nothing left behind" is one of its checks; the finally block repeats it harmlessly.
    await stopPomtreeds();
    const leftovers = await removeDocker();
    // The root supervisor's id, taken from the parent's own parent: P is an operator spawn, so the daemon recorded the root as its parent.
    // Reading it here needs no extra API call, and the verdict rejects a value that is not a root id.
    const rootId = agents.find((a) => a.role === "parent")?.parent ?? "";
    const evidence: MultiEvidence = {
      parentId: tree.parent,
      rootId,
      maxSeq,
      totalCapMicros: args.budgetMicros * ROOT_BUDGET_FACTOR,
      agents,
      samples,
      leftovers,
      decisions: decide.records,
      skippedApprovals: [...decide.skipped],
    };
    const verdict = evaluateMulti(evidence);
    for (const a of agents) {
      write(`journal-${a.name}.json`, sanitizeJournal(a.final.journal, secrets));
      write(`debit-rows-${a.name}.json`, a.final.debit);
      // Kept separately from debit-rows-*.json so the verdict path also leaves the provider-wire columns, response_id among them,
      // which an invoice reconciliation needs (BUD-2).
      write(`debit-wire-${a.name}.json`, a.wireDebit);
    }
    write("assertions.json", {
      ok: verdict.ok,
      variant: "adopt",
      inputs: { image: args.image, model: args.model, budgetMicros: args.budgetMicros, agents: tree, agentListen },
      decisions: decide.records,
      skippedApprovals: [...decide.skipped],
      checks: verdict.checks,
      observations: verdict.observations,
    });
    write("report.txt", renderReport(args, tree, verdict, seconds()));
    const message =
      verdict.checks
        .filter((c) => !c.ok)
        .map((c) => `FAIL ${c.name}: ${c.detail}`)
        .join("\n") || "all assertions held";
    return { exitCode: verdict.ok ? 0 : 4, message };
  } catch (e) {
    if (e instanceof Deadline) {
      // Evidence before cleanup deletes the state dir: the spend and debit rows are the daemon's own accounting for the run.
      await stopPomtreeds(); // flushes the pomtreed logs (with the proxy's refusals) to the out dir
      const ev = dumpDeadlineEvidence(dbPath, (n, v) => write(n, n.startsWith("journal-") ? sanitizeJournal(v as JEntry[], secrets) : v));
      const spent = ev.spentMicrosTotal === null ? `unknown (${ev.error})` : String(ev.spentMicrosTotal);
      write(
        "report.txt",
        `tree never finished: ${e.message}\nparent=${tree.parent} children=${tree.kids.join(",")} solo=${tree.solo}\nspent_micros_total=${spent}\ndecisions=${JSON.stringify(decide.records)} undecided=${JSON.stringify([...decide.skipped])}\n`,
      );
      return { exitCode: 3, message: `${e.message}; spent_micros_total=${spent}` };
    }
    throw e;
  } finally {
    await stopPomtreeds();
    await removeDocker().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

function renderReport(args: MultiArgs, tree: { parent: string; solo: string; kids: string[] }, v: Verdict, seconds: number): string {
  return [
    `crash-recovery-live-multi: variant=adopt parent=${tree.parent} children=${tree.kids.join(",")} solo=${tree.solo} image=${args.image} model=${args.model} cap=${args.budgetMicros} micros per top-level agent wall=${seconds}s`,
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
  // `--campaign <results.md> --base <commit> [--base <commit>...]` evaluates the recorded SET of runs instead of starting one.
  // It spends nothing and touches no Docker: it reads the ledger's REC-1 rows and exits 0 or 4 on the campaign verdict, which is how
  // the stall guarantee is enforced now that it cannot be forced per run.
  const argv = process.argv.slice(2);
  const campaignAt = argv.indexOf("--campaign");
  if (campaignAt >= 0) {
    const path = argv[campaignAt + 1];
    const bases = argv.flatMap((a, i) => (a === "--base" && argv[i + 1] ? [argv[i + 1]!] : []));
    if (!path || bases.length === 0) {
      console.error("usage: --campaign <results.md> --base <commit> [--base <commit>...]");
      process.exit(2);
    }
    const rows = parseCampaignRows(readFileSync(path, "utf8"));
    const verdict = evaluateCampaign(rows, bases);
    console.error(renderCampaign(verdict, bases));
    process.exit(verdict.ok ? 0 : 4);
  }
  const args = parseMultiArgs(argv);
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
