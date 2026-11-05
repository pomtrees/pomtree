import { createHash } from "node:crypto";
import type { Approval, ApprovalStore } from "@pomtree/core";

// Deterministic approval id (stable, derived from content, no lookup): a retried gated call (same requester/action/key) converges on one record.
export const approvalIdFor = (requester: string, kind: string, target: string, key: string): string =>
  `ap-${createHash("sha256").update(`${requester}\0${kind}\0${target}\0${key}`).digest("hex").slice(0, 32)}`;

// Applies every due rung timeout (fail closed past the top rung). Keys carry the rung index so a
// replay is a no-op and each rung advances exactly once. `onAdvance` dispatches the new rung's hop and returns the approval it ended on. Terminates: each timeout advances rungIndex.
export async function settleApproval(
  store: ApprovalStore,
  a: Approval,
  now: number,
  onAdvance?: (a: Approval) => Promise<Approval | undefined>,
): Promise<Approval> {
  let cur = a;
  while (cur.state === "pending" && cur.deadlineAt <= now) {
    cur = await store.timeout(cur.id, `${cur.id}:timeout:${cur.rungIndex}`);
    cur = (await onAdvance?.(cur)) ?? cur; // dispatching the new hop may auto-advance past an unavailable holder
  }
  return cur;
}

// "approve"/"deny" parsed from a human chat reply; null when the reply is neither.
export function parseApprovalReply(body: string): "approve" | "deny" | null {
  const w =
    body
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, "") ?? "";
  if (["approve", "approved", "yes", "y", "allow", "ok"].includes(w)) return "approve";
  if (["deny", "denied", "no", "n", "reject"].includes(w)) return "deny";
  return null;
}
