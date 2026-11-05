import type { AgentId, ApprovalDecision, ApprovalOutcome, ApprovalRank, ApprovalRung } from "./types.ts";

// Pure approval policy: the fixed authority chain behind `ApprovalStore`. Rank order is
// agent < parent-agent < operator < owner; the escalation ladder of approver rungs is
// parent-agent -> operator -> owner. Approver rank must strictly exceed requester rank;
// deny is final; abstain/escalate/timeout advance a rung; past the top rung the result is
// deny (fail closed). Which kinds may bubble to agent rungs is policy in pomtreed (`AGENT_APPROVABLE_KINDS`, budget_raise only);
// external-effect kinds are decided by operator/owner only.

export const RANK_ORDER: readonly ApprovalRank[] = ["agent", "parent-agent", "operator", "owner"];
export const RUNG_ORDER: readonly ApprovalRung[] = ["parent-agent", "operator", "owner"];

export function rankIndex(rank: ApprovalRank): number {
  const i = RANK_ORDER.indexOf(rank);
  if (i < 0) throw new Error(`unknown rank ${rank}`);
  return i;
}

export function rungIndexOf(rung: ApprovalRung): number {
  const i = RUNG_ORDER.indexOf(rung);
  if (i < 0) throw new Error(`unknown rung ${rung}`);
  return i;
}

// Approver rank must strictly exceed requester rank: no peer or subordinate may approve.
export function exceeds(approver: ApprovalRank, requester: ApprovalRank): boolean {
  return rankIndex(approver) > rankIndex(requester);
}

// The escalation ladder of approver rungs above a requester's rank, lowest first. A
// requester at the top (owner) has no rung above them and therefore cannot be approved.
export function rungsAbove(requester: ApprovalRank): ApprovalRung[] {
  return RUNG_ORDER.filter((r) => rankIndex(rankOfRung(r)) > rankIndex(requester));
}

// The rank of the authority deciding at `rung`: a specific ancestor (`agent:<id>`) ranks parent-agent.
export function rankOfRung(rung: ApprovalRung): ApprovalRank {
  return rung.startsWith("agent:") ? "parent-agent" : (rung as ApprovalRank);
}

// The bubbled ladder for an escalation: each ancestor nearest-first, then the operator and owner. `chain`
// excludes root (a top-level agent's chain is empty, giving `operator, owner`).
export function ladderFor(chain: AgentId[]): ApprovalRung[] {
  return [...chain.map((a): ApprovalRung => `agent:${a}`), "operator", "owner"];
}

// The next rung after `rung`, or null when `rung` is already the top (owner).
export function nextRung(rung: ApprovalRung): ApprovalRung | null {
  return RUNG_ORDER[rungIndexOf(rung) + 1] ?? null;
}

// Apply a decision at `rungs[rungIndex]` for a requester of `requesterRank`. `approverRank` is the
// deciding authority's rank (for a timeout it is the rung's own rank). Deny is final;
// approve settles; abstain/escalate/timeout advance to the next rung and, past the top
// rung, deny (fail closed). An approver who does not out-rank the requester is rejected.
export function applyDecision(
  requesterRank: ApprovalRank,
  approverRank: ApprovalRank,
  rungs: readonly ApprovalRung[],
  rungIndex: number,
  decision: ApprovalDecision,
): { ok: true; outcome: ApprovalOutcome } | { ok: false; reason: string } {
  if (!exceeds(approverRank, requesterRank)) {
    return { ok: false, reason: `approver rank ${approverRank} does not exceed requester rank ${requesterRank}` };
  }
  switch (decision) {
    case "approve":
      return { ok: true, outcome: { state: "approved", nextRung: null, failClosed: false } };
    case "deny":
      return { ok: true, outcome: { state: "denied", nextRung: null, failClosed: false } };
    case "abstain":
    case "escalate":
    case "timeout": {
      const next = rungs[rungIndex + 1] ?? null;
      if (next === null) return { ok: true, outcome: { state: "denied", nextRung: null, failClosed: true } };
      return { ok: true, outcome: { state: "pending", nextRung: next, failClosed: false } };
    }
  }
}
