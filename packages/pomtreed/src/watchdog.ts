import { POMTREED_KINDS, type JournalEntry } from "@pomtree/core";

// Journal payload kinds authored by the watchdog itself, carried as extension kinds
// (`ext.${string}`) so the daemon can persist facts the core WatchdogStore cannot
// hold (its WatchdogState union has no timestamps or quarantine flag).
// Restart timestamps and the quarantine flag live in WatchdogState (the store is authoritative);
// QUARANTINED_KIND is journaled as the audit marker (and honored when seeded there).
export const QUARANTINED_KIND = POMTREED_KINDS.quarantined;
// A spawn's wall-clock deadline (absolute `at` ms) and the coarse per-tick host-health
// heartbeat, journaled by the daemon as extension kinds so the facts are durable without
// widening the core WatchdogState/AgentRecord contracts.
export const DEADLINE_KIND = POMTREED_KINDS.deadline;
export const HOST_HEALTH_KIND = POMTREED_KINDS.hostHealth;
// The agent settled a turn with no result recorded and its container lives on: it is `waiting` for the user. The entry's
// `ts` is when it began waiting (idle time = now - ts while no later entry exists). Defined with its fold (`waitingStep`)
// in core so observe reads the same facts; re-exported here.
export { WAITING_KIND } from "@pomtree/core";

// The timestamp since which an agent is legitimately blocked — waiting on a human
// escalation, or on a tool_call whose result has not arrived — or null when it is not
// blocked. A blocked agent is exempt from the stall watchdog for `blockedMs` instead of
// the ordinary `stallMs`, so `pomtree ask --wait`, `pomtree wait`, or a long tool call cannot
// be nudged/cancelled as if stalled.
//
// The scan is a fold (`foldBlocked`) over journal pages so a caller can page through a large
// journal without materializing it: the only retained state is the set of still-open callIds,
// not the entries themselves.
export interface BlockedScan {
  openCalls: Map<string, number>; // callId -> the ts blocking began
}

export function newBlockedScan(): BlockedScan {
  return { openCalls: new Map() };
}

// Fold one page of journal entries into the scan state: a tool_call opens a call (recorded at its
// ts), a tool_result closes it.
export function foldBlocked(scan: BlockedScan, entries: JournalEntry[]): void {
  for (const e of entries) {
    const p = e.payload;
    if (p.kind === "tool_call") scan.openCalls.set(p.callId, e.ts);
    else if (p.kind === "tool_result") scan.openCalls.delete(p.callId);
  }
}

// The earliest still-open tool_call ts, or null when none are open.
export function openCallSince(scan: BlockedScan): number | null {
  let since: number | null = null;
  for (const ts of scan.openCalls.values()) since = since === null ? ts : Math.min(since, ts);
  return since;
}

export function blockedSince(entries: JournalEntry[], openEscalationAt: number | null): number | null {
  if (openEscalationAt !== null) return openEscalationAt;
  // A tool_call whose callId has no later tool_result is still in flight: the agent is
  // waiting on that call. The earliest still-open call is when blocking began.
  const scan = newBlockedScan();
  foldBlocked(scan, entries);
  return openCallSince(scan);
}

// The number of kill_resume restarts within the intensity window, reset to zero once the
// agent has been stable (no restart) for `stableMs`. OTP-style intensity: a flapping agent
// exhausts its restart budget and escalates; a healthy stretch clears it.
export function intensityRetries(restarts: number[], now: number, windowMs: number, stableMs: number): number {
  if (restarts.length === 0) return 0;
  const last = Math.max(...restarts);
  if (now - last >= stableMs) return 0;
  const cutoff = now - windowMs;
  return restarts.filter((t) => t > cutoff).length;
}
