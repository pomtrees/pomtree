import type { MergePolicyCode, MergeRequest, Repo } from "@pomtree/core";
import { agentBranchOf, agentHeadsPrefix, checkEntry, validAgentId, validBranchName, type ParsedEntry } from "./ref-policy.ts";
import { DEFAULT_DENIED_PATHS, pathDenied } from "@pomtree/core";

// Pure helpers for the merge engine: parsing what git printed and deciding on a request. No git, no fs.

export interface Rejection {
  code: MergePolicyCode;
  message: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (s: string): boolean => HEX40.test(s);

// `git merge-tree --write-tree --name-only -z --no-messages` stdout: "<tree>\0" then one "<path>\0" per
// conflicted file. Null when the output does not start with a tree id (an error, not a merge result).
export function parseMergeTree(stdout: string): { tree: string; conflicts: string[] } | null {
  const parts = stdout.split("\0");
  const tree = parts[0] ?? "";
  if (!isOid(tree)) return null;
  const conflicts = [...new Set(parts.slice(1).filter((p) => p !== ""))];
  return { tree, conflicts };
}

// Shape checks on a request before any git runs. Ref names are controller-validated here, so no
// agent-controlled string reaches git as an option or an unexpected revision expression.
export function checkRequest(req: MergeRequest, repo: Repo): Rejection | null {
  if (req.repo !== repo.id) return { code: "bad_ref", message: `unknown repo ${JSON.stringify(req.repo)}` };
  if (!validAgentId(req.caller) || !validAgentId(req.child)) return { code: "bad_ref", message: "invalid agent id" };
  // `child === caller` is the top-level self-merge: the caller's own ingested branch into the default branch, under approval.
  if (req.caller === req.child && req.target !== `refs/heads/${repo.defaultBranch}`)
    return { code: "bad_ref", message: "an agent can merge itself only into the default branch" };
  if (agentBranchOf(req.child, req.source) === null)
    return { code: "bad_ref", message: `source ${JSON.stringify(req.source)} is not under ${agentHeadsPrefix(req.child)}` };
  if (req.target.startsWith("refs/heads/")) {
    if (!validBranchName(req.target.slice("refs/heads/".length))) return { code: "bad_ref", message: `invalid target ${JSON.stringify(req.target)}` };
    if (!req.approval) return { code: "approval_required", message: `merging into protected ${req.target} needs an approval` };
  } else if (agentBranchOf(req.caller, req.target) === null) {
    return { code: "bad_ref", message: `target ${JSON.stringify(req.target)} is neither the caller's branch nor a protected branch` };
  }
  if (req.expectSource !== undefined && !isOid(req.expectSource)) return { code: "bad_revision", message: "expectSource must be a full commit id" };
  return null;
}

// What the source introduces relative to the merge base: ingest rules again (defence in depth) plus the repo's denylist.
export function checkDiff(entries: readonly ParsedEntry[], deniedPaths: readonly string[] = DEFAULT_DENIED_PATHS): Rejection | null {
  for (const e of entries) {
    const bad = checkEntry(e);
    if (bad) return { code: bad.code === "submodule" ? "submodule" : "unsafe_path", message: bad.message };
    const hit = pathDenied(e.path, deniedPaths);
    if (hit !== null) return { code: "denied_path", message: `${JSON.stringify(e.path)} is under the denied path ${JSON.stringify(hit)}` };
  }
  return null;
}

// `git diff-tree -r -z --raw --no-renames` output as the full change set: adds, modifications, mode and type changes
// (destination mode) AND deletions (listed with a plain-file placeholder mode, so only the path rules apply).
export function parseChangeSet(out: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(fields[i]!.trim());
    if (!m) continue;
    const path = fields[++i];
    if (path === undefined) break;
    entries.push({ mode: m[5] === "D" ? "100644" : m[2]!, oid: m[4]!, path });
  }
  return entries;
}

// The candidate commit message: a subject plus `Pomtree-Agent: <caller id>` and `Pomtree-Merged: <child id> <source commit>` trailers.
export function candidateMessage(m: { caller: string; child: string; source: string; target: string }): string {
  const branch = m.target.replace(/^refs\/(agents\/[^/]+\/)?heads\//, "");
  return `Merge ${m.child} into ${branch}\n\nPomtree-Agent: ${m.caller}\nPomtree-Merged: ${m.child} ${m.source}\n`;
}
