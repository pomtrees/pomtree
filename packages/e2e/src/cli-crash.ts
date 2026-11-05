// Helpers for the S1 crash and credential scenarios (cli-recovery.test.ts, cli-credentials.test.ts) beside the CLI scenario harness
// (cli-scenarios-harness.ts): a real SIGKILL of the stack's pomtreed, read-only views of the debit store, and `docker` queries by label.
// Observation only; nothing here drives pomtreed except by killing it.
import { ChildProcess, execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { DebitRow } from "./browser-live-audit.ts";
import type { AgentJson, Stack } from "./cli-scenarios-harness.ts";
import type { AgentView, ContainerView } from "./crash-recovery-decisions.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A free loopback port, for `--set model.proxy.port=<n>`: the registry default (18080) would collide between concurrently running gated files.
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

export async function docker(args: string[], timeoutMs = 30_000): Promise<string> {
  const r = await execFileP("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout.trim();
}

// The pid pomtreed recorded in <state>/pomtreed.lock (first line; acquireStateLock in pomtreed/src/server.ts).
export function pomtreedPid(stack: Pick<Stack, "stateDir">): number {
  const pid = Number(readFileSync(join(stack.stateDir, "pomtreed.lock"), "utf8").split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pomtreed.lock in ${stack.stateDir} holds no pid; the stack's pomtreed is not running`);
  return pid;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// TODO(harness-sigkill): Stack should expose kill('SIGKILL'). Its restart() only SIGTERMs, and its stop() decides "already exited" from
// ChildProcess.exitCode alone, which stays null for a signal death while the 'exit' event has already fired, so restart() after an
// external SIGKILL would wait for that event forever. Until the harness changes: the pid comes from pomtreed.lock, the Stack's own
// ChildProcess is found among the process's active handles (before the kill, while it is live), and its exitCode is set once the pid is gone
// so that restart() skips the stop and boots pomtreed on the same state dir.
export async function sigkillPomtreed(stack: Pick<Stack, "stateDir">): Promise<number> {
  const pid = pomtreedPid(stack);
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  const child = handles.find((h): h is ChildProcess => h instanceof ChildProcess && h.pid === pid);
  if (!child) throw new Error(`no live child process with pomtreed's pid ${pid} in this test process; was pomtreed started by this stack?`);
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 15_000;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`pomtreed pid ${pid} still alive 15s after SIGKILL; kill it by hand and check the state dir lock`);
    await sleep(50);
  }
  await sleep(300); // let the 'exit' event land before exitCode is overwritten
  (child as { exitCode: number | null }).exitCode = 137;
  return pid;
}

function withDb<T>(stack: Pick<Stack, "stateDir">, f: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(stack.stateDir, "pomtreed.sqlite"), { readOnly: true });
  try {
    return f(db);
  } finally {
    db.close();
  }
}

export const debitRows = (stack: Pick<Stack, "stateDir">, agent: string): DebitRow[] =>
  withDb(
    stack,
    (db) =>
      db
        .prepare(
          "SELECT request_id, status, charged_micros, maximum_micros, created_at FROM model_debit_requests WHERE agent=? ORDER BY created_at, request_id",
        )
        .all(agent) as unknown as DebitRow[],
  );

export const spentMicros = (stack: Pick<Stack, "stateDir">, agent: string): number =>
  withDb(
    stack,
    (db) => (db.prepare("SELECT spent_micros FROM model_debit_agents WHERE agent=?").get(agent) as { spent_micros: number } | undefined)?.spent_micros ?? 0,
  );

export const maxJournalSeq = (stack: Pick<Stack, "stateDir">): number =>
  withDb(stack, (db) => (db.prepare("SELECT MAX(seq) AS m FROM journal").get() as { m: number | null }).m ?? 0);

// Containers (running or not) labelled with this agent id; the egress sidecar carries only the sandbox label, so it is not counted.
export async function agentContainers(agent: string): Promise<(ContainerView & { name: string })[]> {
  const out = await docker(["ps", "-a", "--filter", `label=pomtree.agent=${agent}`, "--format", "{{.Names}}|{{.State}}"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, state] = l.split("|");
      return { id: name!, name: name!, running: state === "running" };
    });
}

export async function containerRunning(name: string): Promise<boolean> {
  try {
    return (await docker(["inspect", "-f", "{{.State.Running}}", name])) === "true";
  } catch {
    return false;
  }
}

export const showAgent = async (s: Stack, id: string): Promise<AgentJson & { sandbox?: string | null }> => {
  const r = await s.pomtree(["show", id]);
  if (r.code !== 0) throw new Error(`pomtree show ${id}: exit ${r.code}: ${r.err}`);
  return r.json<{ agent: AgentJson & { sandbox?: string | null } }>().agent;
};

export const agentView = (a: AgentJson & { sandbox?: string | null }): AgentView => ({
  state: a.state,
  exit: a.exit ?? null,
  generation: a.generation,
  sandbox: a.sandbox ?? null,
});

// Containers and volumes left behind with the framework's labels (for the final leak check of a run).
export function leftovers(): string[] {
  const run = (a: string[]) => execFileSync("docker", a, { encoding: "utf8", timeout: 20_000 }).trim();
  return [
    ...run(["ps", "-a", "--filter", "label=pomtree=1", "--format", "{{.Names}}"]).split("\n"),
    ...run(["ps", "-a", "--filter", "label=pomtree.egress=1", "--format", "{{.Names}}"]).split("\n"),
    ...run(["volume", "ls", "-q", "--filter", "label=pomtree.egress=1"]).split("\n"),
  ].filter(Boolean);
}
