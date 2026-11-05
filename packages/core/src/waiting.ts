import { POMTREED_KIND_PREFIX, POMTREED_KINDS } from "./kinds.ts";

// `waiting` is a flag on a running agent, not a lifecycle state: its turn settled with no recorded result and its
// container lives on (interactive TTY). It is derived from the journal, never stored: the `ext.pomtreed.waiting` marker
// carries the timestamp, and any later entry that is not passive ends the wait. Pure, so pomtreed (watchdog, API) and
// observe (live view) fold it identically.
export const WAITING_KIND = POMTREED_KINDS.waiting;
// Journaled by the daemon when the mailbox extension acks an injected steer: the agent was handed work, so the wait ends
// before its first output arrives.
export const STEERED_KIND = POMTREED_KINDS.steered;

// Entries that happen TO a waiting agent without ending the wait: operator or peer messages and signals queued for it,
// and daemon bookkeeping (`ext.pomtreed.*`: pending reason, interrupt marker, watchdog, host health), except STEERED_KIND.
export const isPassiveForWaiting = (kind: string): boolean =>
  kind === "message_received" || kind === "signal" || (kind.startsWith(POMTREED_KIND_PREFIX) && kind !== STEERED_KIND && kind !== WAITING_KIND);

// Fold one journal entry (in seq order) into the running `waitingSince` (null = not waiting).
export function waitingStep(prev: number | null, e: { ts: number; payload: { kind: string } }): number | null {
  const k = e.payload.kind;
  if (k === WAITING_KIND) return e.ts;
  return isPassiveForWaiting(k) ? prev : null;
}
