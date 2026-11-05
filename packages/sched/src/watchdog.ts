// In-process scheduling state; pomtreed drives it.
import type { WatchdogRung } from "@pomtree/core";

export type Rung = WatchdogRung;

export interface WatchdogSnapshot {
  now: number;
  startedAt: number;
  lastProgressAt: number; // newest journal event for the agent
  deadlineAt: number | null;
  budgetMicros: number;
  spentMicros: number;
  recentFailures: number;
  rung: Rung; // caller resets to "none" after a kill_resume
  lastActionAt: number | null;
  retries: number; // kill_resume count so far
  // Host-suspend gap (ms) that must not count as a stall: subtracted from now - lastProgressAt. Absent or <= 0 means no gap.
  // pomtreed's Sweeps feeds it (daemon/sweeps.ts) from an in-memory record of unwatched intervals, so it resets on a restart.
  clockGapMs?: number;
}

export interface WatchdogOptions {
  stallMs: number;
  budgetFraction: number; // trip when spent/budget reaches this
  maxBurnMicrosPerMin: number | null;
  failureLimit: number;
  maxRetries: number;
  graceMs: number; // wait after an action before climbing a rung
}

export const DEFAULT_WATCHDOG: WatchdogOptions = {
  stallMs: 10 * 60_000,
  budgetFraction: 0.9,
  maxBurnMicrosPerMin: null,
  failureLimit: 3,
  maxRetries: 2,
  graceMs: 2 * 60_000,
};

export type TripReason = "stalled" | "deadline" | "budget" | "burn_rate" | "failures";
// warnBudget is advisory and independent of the ladder; budgetThreshold is the fraction it was judged against.
export type WatchdogAction = (
  | { action: "none"; reasons: TripReason[] }
  | { action: "nudge" | "cancel" | "kill_resume" | "escalate" | "quarantine"; reasons: TripReason[] }
) & { warnBudget: boolean; budgetThreshold: number };

export function tripReasons(s: WatchdogSnapshot, o: WatchdogOptions): TripReason[] {
  const r: TripReason[] = [];
  if (s.now - s.lastProgressAt - Math.max(0, s.clockGapMs ?? 0) >= o.stallMs) r.push("stalled");
  if (s.deadlineAt !== null && s.now >= s.deadlineAt) r.push("deadline");
  if (s.budgetMicros > 0 && s.spentMicros / s.budgetMicros >= o.budgetFraction) r.push("budget");
  const mins = (s.now - s.startedAt) / 60_000;
  if (o.maxBurnMicrosPerMin !== null && mins > 0 && s.spentMicros / mins > o.maxBurnMicrosPerMin) r.push("burn_rate");
  if (s.recentFailures >= o.failureLimit) r.push("failures");
  return r;
}

// True when a reason other than the advisory "budget" is present. Callers reset the ladder only when this is false
// (a still-over-budget but recovered agent must reset); evaluate() uses the same test to decide whether to climb.
export function hasLadderReason(reasons: readonly TripReason[]): boolean {
  return reasons.some((r) => r !== "budget");
}

// Ladder: nudge -> cancel -> kill_resume (up to maxRetries) -> escalate -> quarantine.
// A passed deadline skips the nudge, since nudging a late agent is pointless.
// The "budget" reason is advisory only (warnBudget): it never climbs the ladder, alone or alongside
// other reasons; a co-occurring real trip climbs on its own. TODO(budget-warn-grace): warnBudget is
// level-triggered, true on every evaluation past the fraction; the caller dedupes the signal.
export function evaluate(s: WatchdogSnapshot, opts: Partial<WatchdogOptions> = {}): WatchdogAction {
  const o = { ...DEFAULT_WATCHDOG, ...opts };
  const reasons = tripReasons(s, o);
  const warnBudget = reasons.includes("budget");
  const out = <A extends WatchdogAction["action"]>(action: A) => ({
    action,
    reasons,
    warnBudget,
    budgetThreshold: o.budgetFraction,
  });
  if (!hasLadderReason(reasons)) return out("none");
  // A backward clock step (now < lastActionAt) counts as grace elapsed, else the watchdog would stay blind until the clock catches up.
  if (s.lastActionAt !== null && s.now >= s.lastActionAt && s.now - s.lastActionAt < o.graceMs) return out("none");
  switch (s.rung) {
    case "none":
      return out(reasons.includes("deadline") ? "cancel" : "nudge");
    case "nudged":
      return out("cancel");
    case "cancelled":
      return out(s.retries < o.maxRetries ? "kill_resume" : "escalate");
    case "escalated":
      return out("quarantine");
    case "quarantined":
      return out("none"); // terminal: the ladder never climbs past quarantine
  }
}
