import { mergeWake } from "@pomtree/core";
import type { AgentId, JournalEntry, MergeResult } from "@pomtree/core";
import { validBranchName } from "@pomtree/workspace-git";

// Pure rules for `POST /v1/agents/self/merge` and the ancestor resume that follows a conflict.
// No fs, git or registry coupling: the Daemon feeds these the facts and acts on the answers.

export interface MergeOutcome {
  result: MergeResult;
  target: string; // the full ref the merge targeted
  approval?: string; // id of the approval a protected target is waiting on or was granted
}

const short = (ref: string): string => ref.replace(/^refs\/heads\//, "").replace(/^refs\/agents\/[^/]+\/heads\//, "");

// The HTTP answer for a merge outcome. Failures carry {ok:false, code}; the pomtree CLI maps `code` to an exit status.
export function mergeHttp(o: MergeOutcome): { status: number; body: Record<string, unknown> } {
  const r = o.result;
  switch (r.status) {
    case "merged":
      return { status: 200, body: { ok: true, commit: r.commit, target: short(o.target), ...(r.alreadyMerged ? { alreadyMerged: true } : {}) } };
    case "conflict":
      return { status: 409, body: { ok: false, code: "conflict", paths: r.paths, targetTip: r.targetTip, sourceTip: r.sourceTip, round: r.round } };
    case "check_failed":
      return { status: 409, body: { ok: false, code: "check_failed", error: r.summary, round: r.round } };
    case "escalate":
      return {
        status: 409,
        body: {
          ok: false,
          code: "escalated",
          reason: r.reason,
          rounds: r.rounds,
          ...(r.paths ? { paths: r.paths } : {}),
          ...(r.summary !== undefined ? { error: r.summary } : {}),
        },
      };
    case "moved":
      return { status: 409, body: { ok: false, code: "moved", attempts: r.attempts } };
    case "policy_rejected":
      if ((r.code as string) === "key_reuse") return { status: 409, body: { ok: false, code: "key_reuse", error: r.message } };
      return {
        status: r.code === "approval_required" ? 409 : 422,
        body: { ok: false, code: "policy_rejected", reason: r.code, error: r.message, ...(o.approval ? { approval: o.approval } : {}) },
      };
  }
}

// The result with every engine- or check-derived string passed through `redact` (host paths out), before it is stored, returned,
// journaled or put in a question to the user.
export function scrubResult(r: MergeResult, redact: (s: string) => string): MergeResult {
  switch (r.status) {
    case "check_failed":
      return { ...r, summary: redact(r.summary) };
    case "escalate":
      return { ...r, ...(r.summary !== undefined && { summary: redact(r.summary) }), ...(r.paths && { paths: r.paths.map(redact) }) };
    case "conflict":
      return { ...r, paths: r.paths.map(redact) };
    case "policy_rejected":
      return { ...r, message: redact(r.message) };
    default:
      return r;
  }
}

export type TargetChoice = { ok: true; target: string; protectedTarget: boolean } | { ok: false; status: number; error: string };

// Where a merge by `agent` lands. Default is the caller's own newest ingested branch (`own`). `into` names another branch of
// the caller's, or (top-level agents only) the repo's default branch, which is protected and needs an approval.
export function mergeTarget(p: { agent: AgentId; topLevel: boolean; defaultBranch: string; into?: string; own: string | null }): TargetChoice {
  if (p.into === undefined) {
    return p.own === null
      ? { ok: false, status: 409, error: "you have no pushed branch to merge into; commit and run `pomtree push` first" }
      : { ok: true, target: p.own, protectedTarget: false };
  }
  const name = p.into.replace(/^refs\/heads\//, "");
  if (!validBranchName(name)) return { ok: false, status: 400, error: `invalid branch name: ${JSON.stringify(p.into)}` };
  if (name === p.defaultBranch) {
    if (!p.topLevel) return { ok: false, status: 403, error: `only the top-level agent may merge into ${p.defaultBranch}` };
    return { ok: true, target: `refs/heads/${p.defaultBranch}`, protectedTarget: true };
  }
  return { ok: true, target: `refs/agents/${p.agent}/heads/${name}`, protectedTarget: false };
}

export type MergeFailure = { kind: "conflict"; paths: string[]; targetTip: string; round: number } | { kind: "check_failed"; summary: string; round: number };

// The latest failed merge round for `child` in a caller's journal entries (oldest first); null when none or the child has since merged.
export function lastMergeFailure(entries: JournalEntry[], child: AgentId): MergeFailure | null {
  let last: MergeFailure | null = null;
  for (const e of entries) {
    const p = e.payload;
    if (p.kind === "merged" && p.child === child) last = null;
    else if (p.kind === "merge_conflict" && p.child === child) last = { kind: "conflict", paths: p.paths, targetTip: p.targetTip, round: p.round };
    else if (p.kind === "check_failed" && p.child === child) last = { kind: "check_failed", summary: p.summary, round: p.round };
  }
  return last;
}

// The synthetic message handed to a child resumed by an ancestor.
export function resumeWake(f: MergeFailure | null): string {
  if (!f) return "Your parent resumed you.";
  if (f.kind === "conflict") return mergeWake({ callerTip: f.targetTip, paths: f.paths, round: f.round });
  return [
    `The check failed on the merge of your branch into your parent's (round ${f.round}).`,
    `Check output: ${f.summary.slice(0, 2000)}`,
    "Fix it, commit, `pomtree push`, and report; your parent merges again.",
  ].join("\n");
}
