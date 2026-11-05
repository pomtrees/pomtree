import { createHash } from "node:crypto";
import type { AgentId, HostId, JournalPayload } from "./types.ts";

// Merging: the controller merges a child's branch into
// the caller's own branch. These are the pure types and rules; the ports are RepoStore, MergeStore and
// CheckRunner in ports.ts. Everything here is dependency-free so the daemon and the adapters share one model.

export type RepoId = string;
export type MergeId = string; // opaque

// Three failed rounds (conflict or failed check) per source child escalate to the user.
export const MAX_MERGE_ROUNDS = 3;
// How often one request restarts from the top because the target moved under it before it reports `moved`.
export const MAX_MERGE_ATTEMPTS = 5;

export interface RepoPolicy {
  // Path prefixes (repo-relative, "/"-separated; a trailing "/" is optional) a merge may not add, change, delete or
  // retype; matched case-insensitively on NFC-normalized paths. Undefined means DEFAULT_DENIED_PATHS; an explicit
  // empty list disables the denylist.
  deniedPaths?: string[];
  // Argv of the optional check command, run by the CheckRunner on the exact candidate commit. null = no check.
  check: string[] | null;
}

// A Repo backs one mirror. A swarm run uses one repo (cross-repo merging is not supported).
export interface Repo {
  id: RepoId;
  name: string;
  defaultBranch: string;
  policy: RepoPolicy;
}

export interface MergeRequest {
  repo: RepoId;
  host: HostId; // the writing host's id (every durable record carries one)
  caller: AgentId; // the merging parent; the only agent whose ref (or, with approval, main) is moved
  callerGeneration: number; // fenced: a stale generation is rejected (StaleGenerationError)
  child: AgentId;
  // Full refs in the controller mirror. `source` must lie under refs/agents/<child>/heads/. `target` is
  // refs/agents/<caller>/heads/<name>, or refs/heads/<name> (a protected branch) which needs `approval`.
  source: string;
  target: string;
  // Optional pins: the commit the approver or caller saw. A source that moved since is refused (stale_source).
  expectSource?: string;
  approval?: string; // id of the granted approval; required for a refs/heads/* target
}

export type MergePolicyCode =
  | "bad_revision"
  | "bad_ref"
  | "no_target"
  | "no_source"
  | "unrelated_history"
  | "unsafe_path"
  | "submodule"
  | "denied_path"
  | "too_large"
  | "approval_required"
  | "stale_source"
  | "check_unavailable"
  | "git_version"
  | "key_reuse"; // the idempotency key was already used with a different request (policy_rejected; nothing replayed)

export type MergeResult =
  | { status: "merged"; commit: string; base: string; source: string; alreadyMerged?: true }
  // The merge conflicts. `targetTip` is the caller's tip and `sourceTip` the child's, pinned for this round.
  | { status: "conflict"; paths: string[]; targetTip: string; sourceTip: string; round: number }
  | { status: "check_failed"; summary: string; candidate: string; targetTip: string; sourceTip: string; round: number }
  // Three failed rounds: the user is asked. `paths`/`summary` carry the last failure.
  | { status: "escalate"; reason: "conflict" | "check_failed"; rounds: number; targetTip: string; sourceTip: string; paths?: string[]; summary?: string }
  // The target kept moving for MAX_MERGE_ATTEMPTS restarts; nothing was written. Not a failed round: call again.
  | { status: "moved"; attempts: number; targetTip: string }
  | { status: "policy_rejected"; code: MergePolicyCode; message: string };

export type MergePhase = "begun" | "pinned" | "candidate" | "checked" | "done";

export interface MergeRecord {
  id: MergeId;
  repo: RepoId;
  host: HostId;
  generation: number; // the caller's generation (fence)
  caller: AgentId;
  child: AgentId;
  request: MergeRequest;
  idempotencyKey: string; // per invocation
  phase: MergePhase;
  attempts: number; // restarts used so far (1 on the first pass)
  base: string | null; // the caller's tip pinned by the current attempt (the merge base side)
  source: string | null; // the child's tip pinned by the current attempt
  candidate: string | null; // the candidate commit once written
  startedAt: number; // epoch seconds fixed at begin; the candidate's author/committer date, so a rewrite is byte-identical
  result: MergeResult | null; // set when phase is "done"
  createdAt: number;
  updatedAt: number;
}

export type NewMergeRecord = Pick<MergeRecord, "repo" | "host" | "request" | "startedAt">;

export type MergeStep = {
  phase: Exclude<MergePhase, "begun" | "done">;
  attempts?: number;
  base?: string | null;
  source?: string | null;
  candidate?: string | null;
};

export type MergeStatusState = "none" | "conflict" | "check_failed" | "escalated" | "merged";

// Durable per-(repo, child) merge status and failed-round counter; updated atomically with `settle`.
export interface MergeStatus {
  repo: RepoId;
  child: AgentId;
  state: MergeStatusState;
  failedRounds: number;
  lastMerge: MergeId | null;
  host: HostId | null;
  generation: number | null;
  updatedAt: number | null;
}

// What the daemon asks before `reap`: the git-derived view on top of MergeStatus.
export interface MergeReport {
  // "empty": the child has no ingested refs, so there is nothing to merge.
  state: MergeStatusState | "empty";
  merged: boolean; // every ingested tip of the child is reachable from the target
  failedRounds: number;
  // reap may proceed: merged, escalated to the user, or nothing to merge.
  settled: boolean;
}

export type CheckResult = { ok: boolean; summary: string };

export const mergeSettled = (state: MergeReport["state"], merged: boolean): boolean => merged || state === "escalated" || state === "empty";

// Stable key for facts about one pinned pair of tips (caller, child, base = caller's tip, source = child's tip).
export function mergeTipKey(p: { caller: AgentId; child: AgentId; base: string; source: string }): string {
  return createHash("sha256").update(`merge-tips\0${p.caller}\0${p.child}\0${p.base}\0${p.source}`).digest("hex");
}

// Idempotency key for waking a child to fix a conflict: one per (child, generation, merge round), so a replayed wake is not delivered twice.
export const mergeResumeKey = (child: AgentId, generation: number, round: number): string => `merge-resume:${child}:${generation}:${round}`;

// Wake message for a child resumed to resolve a conflict: the paths and the caller's tip to merge from.
export function mergeWake(w: { callerTip: string; paths: string[]; round: number; rounds?: number }): string {
  const list = w.paths
    .slice(0, 50)
    .map((p) => `  ${JSON.stringify(p)}`)
    .join("\n");
  const more = w.paths.length > 50 ? `\n  ... and ${w.paths.length - 50} more` : "";
  return [
    `Your branch conflicts with your parent's branch (round ${w.round} of ${w.rounds ?? MAX_MERGE_ROUNDS}).`,
    `Parent tip: ${w.callerTip}`,
    `Conflicted paths:\n${list}${more}`,
    "Run `pomtree pull`, merge the parent tip into your branch, resolve the conflicts, commit, `pomtree push`, and report; your parent merges again.",
  ].join("\n");
}

// The journal row the daemon appends for a merge result (null for results returned to the caller but not journaled).
export function mergeJournalPayload(child: AgentId, target: string, r: MergeResult): JournalPayload | null {
  switch (r.status) {
    case "merged":
      return { kind: "merged", child, target, commit: r.commit, ...(r.alreadyMerged ? { alreadyMerged: true as const } : {}) };
    case "conflict":
      return { kind: "merge_conflict", child, paths: r.paths, targetTip: r.targetTip, sourceTip: r.sourceTip, round: r.round };
    case "check_failed":
      return { kind: "check_failed", child, summary: r.summary, candidate: r.candidate, round: r.round };
    case "escalate":
      return {
        kind: "merge_escalated",
        child,
        reason: r.reason,
        rounds: r.rounds,
        ...(r.paths ? { paths: r.paths } : {}),
        ...(r.summary !== undefined ? { summary: r.summary } : {}),
      };
    default:
      return null; // moved and policy_rejected are returned to the caller, not journaled as outcomes
  }
}

// Applied when RepoPolicy.deniedPaths is undefined.
export const DEFAULT_DENIED_PATHS: readonly string[] = [".github/workflows/", ".github/actions/", ".gitmodules"];

const foldPath = (s: string): string => s.normalize("NFC").toLowerCase();

// Whether `path` is under a denied prefix. Both sides compare as "/"-separated, NFC-normalized and case-insensitively
// (a case-variant path must not slip past on a case-insensitive checkout).
export function pathDenied(path: string, denied: readonly string[]): string | null {
  const q = foldPath(path);
  for (const d of denied) {
    const p = foldPath(d).replace(/\/+$/, "");
    if (p === "") continue;
    if (q === p || q.startsWith(p + "/")) return d;
  }
  return null;
}

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;

// Whether two requests are the same request (key order and undefined fields ignored). An idempotency key reused
// with a different request must not replay the old outcome.
export const sameMergeRequest = (a: MergeRequest, b: MergeRequest): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
