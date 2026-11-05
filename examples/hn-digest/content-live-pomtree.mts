// The `--approval pomtree` path: the harness itself runs the real `pomtree decide <id> approve` CLI as a child against the entry's own operator
// socket, so the decision is automatic (it exercises the operator CLI, not a human; approvals.json marks it decidedVia "pomtree"). The flag
// path (`--approval approve|deny`) decides in-process and records decidedBy "operator".
// The operator token and socket path reach the child only through its environment option: never argv, a file or a log line.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PomtreeCommand {
  command: string;
  args: string[]; // everything before the pomtree verb (the script path for a node entry)
}
// The repo's convention for running the CLI from source (see packages/pomtree/src/main.ts).
export const REAL_POMTREE: PomtreeCommand = {
  command: process.execPath,
  args: ["--experimental-strip-types", fileURLToPath(new URL("../../packages/pomtree/src/main.ts", import.meta.url))],
};

export const DECIDE_TIMEOUT_MS = 30_000;
export const DECIDE_OUTPUT_CAP = 300;

export interface ApprovalRow {
  id: string;
  state: string;
  action: { kind: string };
}

// The one pending publish approval, or null. More than one is ambiguous and also null: the entry never guesses which to approve.
export function pendingPublish<T extends ApprovalRow>(rows: readonly T[]): T | null {
  const pending = rows.filter((a) => a.state === "pending" && a.action.kind === "publish");
  return pending.length === 1 ? (pending[0] as T) : null;
}

// The pomtree arguments, after the node entry: no secret is ever part of them.
export function pomtreeDecideArgv(approvalId: string): string[] {
  return ["decide", approvalId, "approve", "--why", "live run approve via pomtree", "--key", `live-pomtree-${approvalId}`];
}

export function pomtreeChildEnv(operator: { POMTREE_SOCKET: string; POMTREE_TOKEN: string }, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...(base.PATH !== undefined && { PATH: base.PATH }), NO_COLOR: "1", POMTREE_SOCKET: operator.POMTREE_SOCKET, POMTREE_TOKEN: operator.POMTREE_TOKEN };
}

export const scrub = (text: string, secrets: readonly string[]): string => secrets.reduce((t, s) => (s === "" ? t : t.split(s).join("[redacted]")), text);

export interface ChildResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}
export type PomtreeSpawner = (cmd: PomtreeCommand, argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<ChildResult>;

export const spawnPomtree: PomtreeSpawner = (cmd, argv, env, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(cmd.command, [...cmd.args, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (b: Buffer) => {
      if (output.length < 4096) output += b.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, output: `spawn failed: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });

// Judges the approvals after the child exited 0: the target is approved and no other approval changed. Null when it holds.
export function pomtreeOutcomeProblem(before: readonly ApprovalRow[], after: readonly ApprovalRow[], targetId: string): string | null {
  const now = new Map(after.map((a) => [a.id, a.state]));
  const state = now.get(targetId);
  if (state === "pending") return `pomtree exited 0 but approval ${targetId} is still pending (it decided a different approval or none)`;
  if (state !== "approved") return `approval ${targetId} is ${state ?? "missing"} after pomtree decide, not approved`;
  const moved = before.filter((a) => a.id !== targetId && now.get(a.id) !== a.state);
  return moved.length > 0 ? `pomtree decided the wrong approval: ${moved.map((a) => a.id).join(", ")} changed besides ${targetId}` : null;
}

export interface PomtreeDecideDeps {
  list(): Promise<ApprovalRow[]>;
  operator: { POMTREE_SOCKET: string; POMTREE_TOKEN: string };
  command?: PomtreeCommand;
  spawner?: PomtreeSpawner;
  timeoutMs?: number;
  settleMs?: number; // how long to wait for the daemon to show the decision after a clean exit
  pollMs?: number;
}

// Runs `pomtree decide <id> approve` and waits until the daemon shows it. Throws a message-only Error (token scrubbed) on any failure.
export async function decideViaPomtree(targetId: string, d: PomtreeDecideDeps): Promise<void> {
  const secrets = [d.operator.POMTREE_TOKEN];
  const before = await d.list();
  const r = await (d.spawner ?? spawnPomtree)(
    d.command ?? REAL_POMTREE,
    pomtreeDecideArgv(targetId),
    pomtreeChildEnv(d.operator),
    d.timeoutMs ?? DECIDE_TIMEOUT_MS,
  );
  const tail = scrub(r.output.trim(), secrets).slice(0, DECIDE_OUTPUT_CAP);
  if (r.timedOut) throw new Error(`pomtree decide timed out after ${d.timeoutMs ?? DECIDE_TIMEOUT_MS}ms and was killed`);
  if (r.code !== 0) throw new Error(`pomtree decide exited ${r.code ?? "abnormally"}: ${tail}`);
  const until = Date.now() + (d.settleMs ?? 5_000);
  for (;;) {
    const after = await d.list();
    if (after.find((a) => a.id === targetId)?.state !== "pending" || Date.now() > until) {
      const problem = pomtreeOutcomeProblem(before, after, targetId);
      if (problem) throw new Error(problem);
      return;
    }
    await new Promise((res) => setTimeout(res, d.pollMs ?? 50));
  }
}
