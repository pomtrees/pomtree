// Lease planner. Pure: the caller passes the clock reading and performs the action; no timers here.
//
// A lease is the provider-side deadline of a running sandbox. With `lease.extend` the daemon pushes it out before it lapses;
// without it (or near the provider's maximum lifetime) the daemon rotates: checkpoint, start a successor, stop the old one,
// at 80% of the lifetime. Renewal never requests an expiry past `startedAtMs + maxTtlMs`.
//
// Caller contract. (1) Use one monotonic clock for `nowMs` and every grant time: a reading earlier than the last grant is
// rejected with a RangeError on purpose, because planning from a clock that went backwards would delay a renewal past the
// deadline. (2) Nothing here caps the number of rotations. A successor whose renewals also fail is planned for rotation again
// (about two thirds of a lease per cycle), so the CALLER must keep a rotation budget per agent and stop rotating when it is spent.

export interface LeaseState {
  // When the sandbox started, and its current provider deadline.
  startedAtMs: number;
  expiresAtMs: number;
  // When the deadline was last pushed out (omit before the first renewal).
  lastRenewedAtMs?: number;
  // The provider's hard cap on total lifetime from start; null when none is declared.
  maxTtlMs: number | null;
  // Whether the backend declares `lease.extend`.
  canExtend: boolean;
  // Consecutive failed renewals, counted by the caller.
  failedRenewals: number;
}

export interface LeasePolicy {
  // Renew when the remaining time falls to this fraction of the granted lease (one third). In (0, 1].
  renewAheadFraction: number;
  // Rotate at this fraction of the lifetime (80%). In (0, 1].
  rotateFraction: number;
  // After this many consecutive failed renewals, stop renewing. An integer of at least 1.
  maxFailedRenewals: number;
  // The time a rotation needs (checkpoint, start the successor). With renewals failing, the planner rotates immediately while
  // at least this much of the lease remains, and gives up below it. Non-negative.
  minRotateMs: number;
}

export const DEFAULT_LEASE_POLICY: LeasePolicy = { renewAheadFraction: 1 / 3, rotateFraction: 0.8, maxFailedRenewals: 3, minRotateMs: 60_000 };

export type LeaseAction =
  // Call lease.extend at `atMs` (now or later) asking for `untilMs`; never beyond the provider's cap.
  | { action: "renew"; atMs: number; untilMs: number }
  // Checkpoint, start a successor, stop this sandbox, at `atMs` (now or later).
  | { action: "reprovision"; atMs: number; reason: "no-extend" | "max-ttl" | "renewals-failing" }
  // Stop renewing and rotating: the lease lapsed, or renewals failed and too little time is left to rotate. The caller treats
  // the sandbox as lost and resumes from the checkpoint.
  | { action: "give-up"; reason: "expired" | "renewals-failing" };

function bad(what: string, got: unknown, want: string, action: string): never {
  throw new RangeError(`${what} is ${String(got)} but must be ${want}; ${action}`);
}

function validate(state: LeaseState, nowMs: number, policy: LeasePolicy): void {
  const finite = (what: string, v: number) => {
    if (!Number.isFinite(v)) bad(what, v, "a finite number of milliseconds", "pass the clock reading or the provider's deadline in epoch milliseconds");
  };
  finite("nowMs", nowMs);
  if (nowMs < 0) bad("nowMs", nowMs, "non-negative", "pass the clock reading in epoch milliseconds");
  finite("startedAtMs", state.startedAtMs);
  finite("expiresAtMs", state.expiresAtMs);
  if (state.lastRenewedAtMs !== undefined) finite("lastRenewedAtMs", state.lastRenewedAtMs);
  if (state.maxTtlMs !== null && !(state.maxTtlMs > 0 && Number.isFinite(state.maxTtlMs))) {
    bad("maxTtlMs", state.maxTtlMs, "positive and finite, or null", "pass the provider's documented cap, or null when it has none");
  }
  if (!Number.isInteger(state.failedRenewals) || state.failedRenewals < 0)
    bad("failedRenewals", state.failedRenewals, "a non-negative integer", "count consecutive failed renewals");
  const grantedFrom = state.lastRenewedAtMs ?? state.startedAtMs;
  if (!(state.expiresAtMs > grantedFrom)) {
    bad("lease expiry", state.expiresAtMs, `after its grant time ${grantedFrom}`, "pass the provider's real deadline and the time it was granted");
  }
  if (nowMs < grantedFrom)
    bad("nowMs", nowMs, `at or after the last grant at ${grantedFrom}`, "the clock went backwards; use one monotonic wall clock for planning");
  const fraction = (what: string, v: number) => {
    if (!(v > 0 && v <= 1)) bad(what, v, "in (0, 1]", "set a fraction of the lease or lifetime");
  };
  fraction("renewAheadFraction", policy.renewAheadFraction);
  fraction("rotateFraction", policy.rotateFraction);
  // At least 1: with 0, a fresh sandbox (0 failures) would already count as failed and rotate before any renewal was tried.
  if (!Number.isInteger(policy.maxFailedRenewals) || policy.maxFailedRenewals < 1)
    bad("maxFailedRenewals", policy.maxFailedRenewals, "an integer of at least 1", "set how many consecutive failures to tolerate before rotating");
  if (!(policy.minRotateMs >= 0 && Number.isFinite(policy.minRotateMs)))
    bad("minRotateMs", policy.minRotateMs, "non-negative and finite", "set the time a rotation needs");
}

export function planLease(state: LeaseState, nowMs: number, policy: LeasePolicy = DEFAULT_LEASE_POLICY): LeaseAction {
  validate(state, nowMs, policy);
  const leaseMs = state.expiresAtMs - (state.lastRenewedAtMs ?? state.startedAtMs);
  if (nowMs >= state.expiresAtMs) return { action: "give-up", reason: "expired" };

  // The rotation point is a fraction of the lifetime the sandbox can have: the provider's cap, bounded by the granted lease
  // when nothing can extend it (so a 30 min lease under a 100 min cap still rotates before 30 min).
  const grantedLifetime = state.expiresAtMs - state.startedAtMs;
  const rotateBasis = state.canExtend ? state.maxTtlMs : Math.min(state.maxTtlMs ?? Number.POSITIVE_INFINITY, grantedLifetime);
  const rotateAtMs = rotateBasis === null ? null : state.startedAtMs + policy.rotateFraction * rotateBasis;
  const reason = state.canExtend ? "max-ttl" : "no-extend";
  if (rotateAtMs !== null && nowMs >= rotateAtMs) return { action: "reprovision", atMs: nowMs, reason };
  if (!state.canExtend) return { action: "reprovision", atMs: rotateAtMs as number, reason };

  // Renewals keep failing: the lease still has time, so rotate now while a rotation can finish; give up only below that.
  if (state.failedRenewals >= policy.maxFailedRenewals) {
    return state.expiresAtMs - nowMs >= policy.minRotateMs
      ? { action: "reprovision", atMs: nowMs, reason: "renewals-failing" }
      : { action: "give-up", reason: "renewals-failing" };
  }

  const renewAtMs = state.expiresAtMs - policy.renewAheadFraction * leaseMs;
  if (rotateAtMs !== null && renewAtMs >= rotateAtMs) return { action: "reprovision", atMs: rotateAtMs, reason };

  const atMs = Math.max(nowMs, renewAtMs);
  const capMs = state.maxTtlMs === null ? Number.POSITIVE_INFINITY : state.startedAtMs + state.maxTtlMs;
  const untilMs = Math.min(atMs + leaseMs, capMs);
  // Already at the provider's cap: a renewal would gain nothing, so rotate at the rotation point instead.
  if (untilMs <= state.expiresAtMs) return { action: "reprovision", atMs: Math.max(nowMs, rotateAtMs as number), reason };
  return { action: "renew", atMs, untilMs };
}
