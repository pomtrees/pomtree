import type { MessageKind, Signal } from "@pomtree/core";
import { clipText } from "./daemon-util.ts";

// Pure sanitizer for ALL user-bound text (Discord posts, approver-facing questions, handoff
// summaries). Agent-influenced text must not hide itself from an approver (bidi / zero-width
// tricks) nor ping the channel (@everyone, role and user mentions).

// Discord's own message limit. render.ts prepends `[purpose] ` and truncates the whole at 2000 itself, so a
// maximal text is cut there with that renderer's marker.
export const USER_TEXT_MAX = 2000;

const ZWSP = "\u200b";
// Bidi controls, zero-width chars, and the Unicode line separators (NEL, LS, PS).
const INVISIBLE_RE = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u200b-\u200d\u2060\ufeff\u0085\u2028\u2029]/g;
const MARKER_RESERVE = 40; // "… [truncated N chars]" with a generous digit allowance

// Inserts a ZWSP after the '@' of @everyone/@here/@word and after the '<' of <@id>, <@!id>,
// <@&id>, <#id>, so Discord no longer parses them. Also breaks an escalation id (es-<64 hex>) so
// quoted agent text cannot make a user's reply to it parse as an answer to that escalation.
function breakMentions(s: string): string {
  return s
    .replace(/<(?=[@#])/g, `<${ZWSP}`)
    .replace(/@(?=\w)/g, `@${ZWSP}`)
    .replace(/es-(?=[0-9a-f]{64})/g, `es-${ZWSP}`);
}

function finish(clean: string, budget: number): string {
  let body = clean;
  if (clean.length > budget) {
    const keep = Math.max(0, budget - MARKER_RESERVE);
    body = `${clean.slice(0, keep)}… [truncated ${clean.length - keep} chars]`;
    if (body.length > budget) body = body.slice(0, budget);
  }
  return breakMentions(body);
}

export function toUser(text: string, max: number = USER_TEXT_MAX): string {
  // clipText strips control/ANSI characters; the cap is applied here so the marker is not itself cut.
  const clean = clipText(text, Number.MAX_SAFE_INTEGER).replace(INVISIBLE_RE, "");
  let budget = max;
  for (;;) {
    const out = finish(clean, budget);
    // Mention-breaking only grows the text; shrink the pre-break budget by the overshoot.
    if (out.length <= max || budget <= 0) return out.slice(0, max);
    budget -= out.length - max;
  }
}

export interface StatusSubjectInput {
  id: string;
  exit: string;
  cause?: string;
  handoff?: string;
  spentMicros?: number; // micro-dollars: 1_000_000 = $1 (units note: "micros" are micro-dollars)
  budgetMicros?: number;
  branch?: string;
}

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

// `<id> <exit>[ (<cause>)]: <handoff|no handoff>[ | spent $x/$y][ | branch <b>]`. Does NOT
// sanitize: callers pass the result through toUser.
export function statusSubject(s: StatusSubjectInput): string {
  const parts = [`${s.id} ${s.exit}${s.cause ? ` (${s.cause})` : ""}: ${s.handoff?.trim() ? s.handoff : "no handoff"}`];
  if (s.spentMicros !== undefined) {
    parts.push(`spent ${dollars(s.spentMicros)}${s.budgetMicros !== undefined ? `/${dollars(s.budgetMicros)}` : ""}`);
  } else if (s.budgetMicros !== undefined) {
    parts.push(`budget ${dollars(s.budgetMicros)}`);
  }
  if (s.branch) parts.push(`branch ${s.branch}`);
  return parts.join(" | ");
}

// A signal addressed to root is relayed to the user instead of enqueued (daemon.ts toMailbox). Returns the
// message purpose and subject, or undefined for a signal kind that is not relayed. Every line leads with the
// sender id (`<id> ...` for an exit, `[from <id>] ...` for a message); a real ask/approval prompt never has that
// shape. Does NOT sanitize: sendToUser passes the subject through toUser.
// A relayed escalation also says what its reply decides (`subjectKind`: an ask, or an approval/budget raise) and carries an
// ask's offered `options` (core MessageSentPayload).
export function relayOf(
  signal: Signal,
): { purpose: MessageKind; subject: string; replyTo?: string; subjectKind?: "ask" | "approval"; options?: string[] } | undefined {
  if (signal.kind === "child_result") return { purpose: "status", subject: `${signal.child} reported ${signal.status}: ${signal.handoff}` };
  if (signal.kind === "child_exited") {
    return {
      purpose: "status",
      subject: statusSubject({
        id: signal.child,
        exit: signal.exit,
        ...(signal.cause !== undefined && { cause: signal.cause }),
        ...(signal.handoff !== undefined && { handoff: signal.handoff }),
        ...(signal.spentMicros !== undefined && { spentMicros: signal.spentMicros }),
        ...(signal.budgetMicros !== undefined && { budgetMicros: signal.budgetMicros }),
        ...(signal.branch !== undefined && { branch: signal.branch }),
      }),
    };
  }
  if (signal.kind === "message") return { purpose: "report", subject: `[from ${signal.from}] ${signal.body}` };
  // A bubbled ask or approval that reached the operator rung: the user's reply to `replyTo` answers or decides it.
  if (signal.kind === "escalation")
    return {
      purpose: "ask",
      subject: `[from ${signal.from}] ${signal.body}`,
      replyTo: signal.escalation,
      subjectKind: signal.subject === "ask" ? "ask" : "approval",
      ...(signal.options !== undefined && signal.options.length > 0 && { options: signal.options }),
    };
  return undefined;
}
