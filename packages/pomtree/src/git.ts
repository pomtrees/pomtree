import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Pure planning for `pomtree push` / `pomtree pull`; the thin shell (runGit, below) is the only part that spawns git.

export const MIN_GIT: readonly [number, number] = [2, 38];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[], opts: { cwd: string }) => Promise<GitResult>;

export const effectivePushKey = (key?: string): string => key ?? randomUUID();

// Validates the push inputs. `branch` defaults to the clone's current branch (`agent/<id>`).
export function planBundle(o: {
  baseCommit: string | undefined;
  branch: string | undefined;
  current: string | undefined;
}): { ok: true; branch: string; base: string } | { ok: false; message: string } {
  const base = o.baseCommit?.trim();
  if (!base)
    return {
      ok: false,
      message: "POMTREE_BASE_COMMIT is not set: pomtree push only works inside an agent sandbox (the bundle excludes history reachable from it)",
    };
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)) return { ok: false, message: `POMTREE_BASE_COMMIT is not a full commit id: ${base}` };
  const branch = (o.branch ?? o.current ?? "").trim().replace(/^refs\/heads\//, "");
  if (!branch || branch === "HEAD") return { ok: false, message: "no branch to push: HEAD is detached; pass --branch NAME" };
  if (branch.startsWith("-")) return { ok: false, message: `invalid branch name: ${branch}` };
  return { ok: true, branch, base };
}

export const bundleArgs = (file: string, branch: string, base: string): string[] => ["bundle", "create", file, `refs/heads/${branch}`, `^${base}`];

// git exits 128 with "Refusing to create empty bundle." when nothing is new relative to the base.
export function bundleFailure(branch: string, r: GitResult): string {
  const msg = `${r.stderr} ${r.stdout}`;
  if (/empty bundle/i.test(msg)) return `nothing to push: branch ${branch} has no commits beyond the base (commit your work first)`;
  if (/not a valid ref|bad revision|unknown revision|invalid revision|does not exist|not a valid object/i.test(msg))
    return `branch ${branch} does not exist in this clone (or the base commit is missing)`;
  return `git bundle failed: ${msg.trim().split("\n")[0] ?? "unknown error"}`;
}

export function pushError(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; code?: unknown };
  const detail = typeof b.error === "string" && b.error ? b.error : `HTTP ${status}`;
  const code = typeof b.code === "string" ? b.code : "";
  if (status === 413 || code === "too_large") return `bundle too large for the daemon's push limit: ${detail} (push fewer or smaller commits)`;
  if (code === "non_fast_forward")
    return `push refused (non_fast_forward): your branch does not contain what the daemon already has for it${detail === `HTTP ${status}` ? "" : ` (${detail})`}; run pomtree pull, then merge or rebase and push again`;
  if (status === 409) return `push refused (stale generation or conflicting key): ${detail}`;
  const hint: Record<string, string> = {
    prerequisite: "the bundle depends on commits the daemon does not have (do not pull in outside history)",
    bad_bundle: "the bundle is malformed",
    bad_ref: "ref name rejected (push only branches under refs/heads)",
    unsafe_path: "a path in the pushed tree is unsafe (e.g. a .git component)",
    symlink: "a symlink in the pushed tree escapes the tree",
    submodule: "submodules are not allowed",
    git_version: "the daemon's git is too old to ingest safely",
  };
  return code ? `push rejected (${code}): ${detail}${hint[code] ? `; ${hint[code]}` : ""}` : detail;
}

export interface IngestedRef {
  ref: string;
  commit: string;
}
export const isRefList = (v: unknown): v is IngestedRef[] => Array.isArray(v) && v.every((x) => x && typeof x.ref === "string" && typeof x.commit === "string");

export const pullPath = (from?: string): string => `/v1/agents/self/pull${from === undefined ? "" : `?from=${encodeURIComponent(from)}`}`;

export const fetchArgs = (file: string): string[] => [
  "fetch",
  "--no-tags",
  file,
  "+refs/heads/*:refs/remotes/pomtreed/*",
  "+refs/agents/*:refs/remotes/pomtreed-agents/*",
];

export function gitTooOld(versionOut: string): string | null {
  const m = /git version (\d+)\.(\d+)/.exec(versionOut);
  if (!m) return "cannot determine the git version";
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_GIT[0] || (maj === MIN_GIT[0] && min >= MIN_GIT[1]) ? null : `git ${maj}.${min} is too old; pomtree push/pull need >= ${MIN_GIT.join(".")}`;
}

// Thin shell: runs the agent's own git in its clone (the agent owns this clone; environment is inherited).
export const runGit: GitRunner = (args, { cwd }) =>
  new Promise((resolve) => {
    const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
