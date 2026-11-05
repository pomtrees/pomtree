import type { AgentId, IngestFailCode } from "@pomtree/core";

// Pure ingest policy: ref names, namespace mapping, and path/mode/symlink/submodule rules over a parsed
// tree listing. No git, no fs. The workspace feeds it what git printed; it only decides.

export interface PolicyViolation {
  code: IngestFailCode;
  message: string;
}

// --- ref names -------------------------------------------------------------------------------

// `refs/heads/<name>` validity per git-check-ref-format, plus: not "HEAD", bounded length, printable ASCII only.
export function validBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200 || name === "HEAD" || name === "@") return false;
  if (!/^[\x21-\x7e]+$/.test(name)) return false; // no space, control or non-ASCII
  if (/[~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.startsWith("-")) return false;
  return name.split("/").every((c) => c.length > 0 && !c.startsWith(".") && !c.endsWith(".lock"));
}

// Agent ids become path segments and ref components; this mirrors the folder-name guard.
export function validAgentId(agent: AgentId): boolean {
  return (
    agent.length > 0 &&
    !/[\/\\\0]/.test(agent) &&
    !agent.includes("..") &&
    !agent.startsWith("-") &&
    !agent.startsWith(".") &&
    /^[\x21-\x7e]+$/.test(agent) &&
    !/[~^:?*[@{]/.test(agent) &&
    !agent.endsWith(".lock")
  );
}

export const agentHeadsPrefix = (agent: AgentId): string => `refs/agents/${agent}/heads/`;

// Controller-seeded entitlement anchors (fork/resume bases handed to the agent at create({fromCommit})).
// Only the controller writes here; ingest accepts a prerequisite reachable from it, which heads/* alone
// would refuse. Agents cannot create these refs: bundle refs map into heads/* only.
export const agentBasePrefix = (agent: AgentId): string => `refs/agents/${agent}/base/`;

// `refs/heads/x` -> `refs/agents/<id>/heads/x`; null when the source is not a valid refs/heads ref.
export function mapToAgentRef(agent: AgentId, ref: string): string | null {
  if (!ref.startsWith("refs/heads/")) return null;
  const name = ref.slice("refs/heads/".length);
  return validBranchName(name) ? agentHeadsPrefix(agent) + name : null;
}

// Branch name inside the agent namespace, or null when `ref` is not in it.
export function agentBranchOf(agent: AgentId, ref: string): string | null {
  const p = agentHeadsPrefix(agent);
  if (!ref.startsWith(p)) return null;
  const name = ref.slice(p.length);
  return validBranchName(name) ? name : null;
}

// A branch set must not contain a name that is a directory prefix of another (git cannot store both).
export function hasRefClash(names: readonly string[]): string | null {
  const set = new Set(names);
  for (const n of names) {
    const parts = n.split("/");
    for (let i = 1; i < parts.length; i++) if (set.has(parts.slice(0, i).join("/"))) return n;
  }
  return null;
}

// What a bundle may carry: `refs/heads/<valid>` only (a `HEAD` entry is ignored, not stored).
export function checkBundleRefs(refs: readonly string[], existing: readonly string[] = []): PolicyViolation | { branches: string[] } {
  const branches: string[] = [];
  for (const r of refs) {
    if (r === "HEAD") continue;
    if (!r.startsWith("refs/heads/") || !validBranchName(r.slice("refs/heads/".length)))
      return { code: "bad_ref", message: `bundle ref not allowed: ${JSON.stringify(r)}` };
    branches.push(r.slice("refs/heads/".length));
  }
  if (branches.length === 0) return { code: "bad_ref", message: "bundle carries no refs/heads/* ref" };
  const clash = hasRefClash([...new Set([...branches, ...existing])]);
  if (clash) return { code: "bad_ref", message: `ref name clashes with another ref: ${JSON.stringify(clash)}` };
  return { branches };
}

// --- paths -----------------------------------------------------------------------------------

// HFS+ ignores these code points when comparing names.
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

function normComponent(c: string): string {
  return c
    .replace(HFS_IGNORABLE, "")
    .toLowerCase()
    .replace(/[ .]+$/, "");
}

// `.git` in any form git's own fsck treats as the git dir on some filesystem: case variants, HFS ignorable
// characters, NTFS trailing dots/spaces, 8.3 short name `git~1`, NTFS alternate data stream suffixes.
export function isDotGit(component: string): boolean {
  const n = normComponent(component.split(":")[0]!);
  return n === ".git" || /^git~\d+$/.test(n);
}

export function isDotGitmodules(component: string): boolean {
  const n = normComponent(component.split(":")[0]!);
  return n === ".gitmodules" || /^gitmod~\d+$/.test(n);
}

const splitPath = (p: string): string[] => p.split(/[\/\\]/);

export type EntryKind = "blob" | "exec" | "symlink" | "gitlink" | "tree" | "other";
export const modeKind = (mode: string): EntryKind =>
  mode === "100644"
    ? "blob"
    : mode === "100755"
      ? "exec"
      : mode === "120000"
        ? "symlink"
        : mode === "160000"
          ? "gitlink"
          : mode === "040000" || mode === "40000"
            ? "tree"
            : "other";

// A path introduced by an ingested commit. Symlink targets are checked separately (checkSymlinkTarget).
export function checkEntry(e: { mode: string; path: string }): PolicyViolation | null {
  const parts = splitPath(e.path);
  for (const c of parts) {
    if (c === "" || c === "." || c === "..") return { code: "unsafe_path", message: `path component not allowed in ${JSON.stringify(e.path)}` };
    if (isDotGit(c)) return { code: "unsafe_path", message: `.git-named path component in ${JSON.stringify(e.path)}` };
    if (c.includes("\0")) return { code: "unsafe_path", message: "NUL in path" };
  }
  if (parts.some(isDotGitmodules)) return { code: "submodule", message: `.gitmodules is not allowed (${JSON.stringify(e.path)})` };
  const kind = modeKind(e.mode);
  if (kind === "gitlink") return { code: "submodule", message: `submodule (gitlink) at ${JSON.stringify(e.path)}` };
  if (kind === "other") return { code: "unsafe_path", message: `unsupported file mode ${e.mode} at ${JSON.stringify(e.path)}` };
  return null;
}

// A symlink may point inside the tree only: no absolute target, nothing that resolves above the
// repository root from its own directory, nothing naming the git dir.
export function checkSymlinkTarget(path: string, target: string): PolicyViolation | null {
  const bad = (why: string): PolicyViolation => ({ code: "symlink", message: `symlink ${JSON.stringify(path)} ${why}` });
  if (target.length === 0 || target.includes("\0")) return bad("has an empty or NUL target");
  if (/^[\/\\]/.test(target) || /^[A-Za-z]:/.test(target)) return bad("has an absolute target");
  let depth = splitPath(path).length - 1; // directories above the link
  for (const c of splitPath(target)) {
    if (c === "" || c === ".") continue;
    if (isDotGit(c)) return bad("points into .git");
    if (c === "..") {
      if (--depth < 0) return bad("escapes the tree");
    } else depth++;
  }
  return null;
}

export interface ParsedEntry {
  mode: string;
  oid: string;
  path: string;
}
export const NULL_OID = /^0+$/;

// Parses `git diff-tree --stdin -r -z --raw --no-commit-id` output for added/modified entries (dst mode/oid); deletions are skipped.
export function parseRawZ(out: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(fields[i]!.trim());
    if (!m) continue;
    const path = fields[++i];
    if (path === undefined) break;
    if (m[5] === "D" || NULL_OID.test(m[4]!)) continue;
    entries.push({ mode: m[2]!, oid: m[4]!, path });
  }
  return entries;
}
