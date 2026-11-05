import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { buildGitInvocation, type GitInvocationOptions } from "./git-env.ts";

const MAX_OUTPUT = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export class GitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stderr = stderr;
  }
}

export interface RunOptions extends GitInvocationOptions {
  cwd?: string;
  input?: Uint8Array | string;
  stdinFrom?: { path: string; start: number }; // stream a file (from `start`) to stdin instead of `input`
  maxOutput?: number;
  timeoutMs?: number;
  tmpdir?: string;
  // Exit codes besides 0 that are results rather than failures (e.g. 1 for `merge-base --is-ancestor`).
  okCodes?: number[];
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

// The single place a controller-side git process is spawned. `scrub` strips host paths from messages.
export function runGit(args: readonly string[], opts: RunOptions = {}, scrub: (s: string) => string = (s) => s): Promise<RunResult> {
  const inv = buildGitInvocation(args, { path: process.env.PATH ?? "/usr/bin:/bin", ...(opts.tmpdir !== undefined && { tmpdir: opts.tmpdir }) }, opts);
  const cap = opts.maxOutput ?? MAX_OUTPUT;
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(inv.file, inv.args, { cwd: opts.cwd, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    let stderr = "";
    let overflow = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(() => reject(new GitError(scrub(`git ${args[0]} timed out`), null, "")));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen > cap) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += String(d);
    });
    child.on("error", (err) => done(() => reject(new GitError(scrub(err.message), null, ""))));
    child.on("close", (code) =>
      done(() => {
        if (overflow) return reject(new GitError(scrub(`git ${args[0]} output exceeded ${cap} bytes`), code, stderr));
        if (code !== 0 && !(opts.okCodes ?? []).includes(code ?? -1))
          return reject(new GitError(scrub(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`), code, scrub(stderr)));
        resolve({ stdout: Buffer.concat(out), stderr, code: code ?? 0 });
      }),
    );
    child.stdin.on("error", () => undefined);
    if (opts.stdinFrom)
      createReadStream(opts.stdinFrom.path, { start: opts.stdinFrom.start })
        .on("error", () => child.stdin.end())
        .pipe(child.stdin);
    else child.stdin.end(opts.input);
  });
}

export async function gitText(args: readonly string[], opts: RunOptions = {}, scrub?: (s: string) => string): Promise<string> {
  return (await runGit(args, opts, scrub)).stdout.toString("utf8").trim();
}
