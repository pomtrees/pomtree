import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LEASE_POLICY, type LeaseState, planLease } from "./lease.ts";

const MIN = 60_000;
const base: LeaseState = { startedAtMs: 0, expiresAtMs: 30 * MIN, maxTtlMs: null, canExtend: true, failedRenewals: 0 };

test("lease: before the renew-ahead point the renewal is planned for later at a third of the lease remaining", () => {
  const a = planLease(base, 1 * MIN);
  assert.deepEqual(a, { action: "renew", atMs: 20 * MIN, untilMs: 50 * MIN });
});

test("lease: inside the renew-ahead window it renews now for another full lease", () => {
  const a = planLease(base, 25 * MIN);
  assert.deepEqual(a, { action: "renew", atMs: 25 * MIN, untilMs: 55 * MIN });
});

test("lease: the lease length is measured from the last renewal", () => {
  const s = { ...base, startedAtMs: 0, lastRenewedAtMs: 40 * MIN, expiresAtMs: 50 * MIN };
  assert.deepEqual(planLease(s, 41 * MIN), { action: "renew", atMs: 50 * MIN - (10 * MIN) / 3, untilMs: 50 * MIN - (10 * MIN) / 3 + 10 * MIN });
});

test("lease: never requests an expiry past the provider's max TTL", () => {
  const s: LeaseState = { ...base, maxTtlMs: 70 * MIN, expiresAtMs: 60 * MIN, lastRenewedAtMs: 30 * MIN };
  assert.deepEqual(planLease(s, 55 * MIN), { action: "renew", atMs: 55 * MIN, untilMs: 70 * MIN });
  // sweep: no plan at any time ever asks for more than the cap
  for (let t = 30 * MIN; t < 59 * MIN; t += MIN) {
    const p = planLease(s, t);
    if (p.action === "renew") assert.ok(p.untilMs <= 70 * MIN);
  }
});

test("lease: renews up to the cap, then reprovisions at 80% of the max TTL rather than hitting the cap", () => {
  const s: LeaseState = { ...base, maxTtlMs: 40 * MIN, expiresAtMs: 30 * MIN, lastRenewedAtMs: 0 };
  // renewal point 20 min < rotation point 32 min: renew, capped at 40
  assert.deepEqual(planLease(s, 5 * MIN), { action: "renew", atMs: 20 * MIN, untilMs: 40 * MIN });
  // lease already at the cap: renewing gains nothing, so rotate at 32 min
  const atCap: LeaseState = { ...s, expiresAtMs: 40 * MIN, lastRenewedAtMs: 30 * MIN };
  assert.deepEqual(planLease(atCap, 31 * MIN), { action: "reprovision", atMs: 32 * MIN, reason: "max-ttl" });
  // past the rotation point: rotate now
  assert.deepEqual(planLease(atCap, 35 * MIN), { action: "reprovision", atMs: 35 * MIN, reason: "max-ttl" });
});

test("lease: without lease.extend it rotates at 80% of the lease and never plans a renewal", () => {
  const s = { ...base, canExtend: false };
  assert.deepEqual(planLease(s, 1 * MIN), { action: "reprovision", atMs: 24 * MIN, reason: "no-extend" });
  assert.deepEqual(planLease(s, 26 * MIN), { action: "reprovision", atMs: 26 * MIN, reason: "no-extend" });
  const capped = { ...s, maxTtlMs: 20 * MIN };
  assert.deepEqual(planLease(capped, 1 * MIN), { action: "reprovision", atMs: 16 * MIN, reason: "no-extend" });
});

test("lease: failing renewals rotate while the lease has time, and give up once too little is left to rotate", () => {
  assert.deepEqual(planLease({ ...base, failedRenewals: 3 }, 25 * MIN), { action: "reprovision", atMs: 25 * MIN, reason: "renewals-failing" });
  // exact boundary: remaining time == minRotateMs still rotates; one ms less gives up
  const edge = base.expiresAtMs - DEFAULT_LEASE_POLICY.minRotateMs;
  assert.equal(planLease({ ...base, failedRenewals: 3 }, edge).action, "reprovision");
  assert.deepEqual(planLease({ ...base, failedRenewals: 3 }, edge + 1), { action: "give-up", reason: "renewals-failing" });
});

test("lease: gives up when the lease has already lapsed", () => {
  assert.deepEqual(planLease({ ...base, failedRenewals: DEFAULT_LEASE_POLICY.maxFailedRenewals - 1 }, 25 * MIN).action, "renew");
  assert.deepEqual(planLease(base, 30 * MIN), { action: "give-up", reason: "expired" });
  assert.deepEqual(planLease({ ...base, canExtend: false }, 31 * MIN), { action: "give-up", reason: "expired" });
});

test("lease: an impossible state is rejected with the cause and the action", () => {
  assert.throws(() => planLease({ ...base, expiresAtMs: 0 }, 0), /after its grant time.*pass the provider's real deadline/);
  assert.throws(() => planLease({ ...base, maxTtlMs: 0 }, 0), /maxTtlMs is 0 but must be positive and finite, or null/);
});

test("lease: the plan depends only on the arguments (same inputs, same plan)", () => {
  assert.deepEqual(planLease(base, 7 * MIN), planLease(base, 7 * MIN));
});

test("lease: without lease.extend a short lease under a long cap rotates before the lease lapses", () => {
  const s: LeaseState = { ...base, canExtend: false, expiresAtMs: 30 * MIN, maxTtlMs: 100 * MIN };
  assert.deepEqual(planLease(s, 1 * MIN), { action: "reprovision", atMs: 24 * MIN, reason: "no-extend" });
});

test("lease: exact boundaries of the renewal and rotation points", () => {
  // now == renewAt (20 min of a 30 min lease): renew now, not later
  assert.deepEqual(planLease(base, 20 * MIN), { action: "renew", atMs: 20 * MIN, untilMs: 50 * MIN });
  // renewAt == rotateAt (cap 40 min, rotate at 50% = 20 min, renewAt 20 min): rotation wins
  const half = { ...DEFAULT_LEASE_POLICY, rotateFraction: 0.5 };
  const tie: LeaseState = { ...base, maxTtlMs: 40 * MIN };
  assert.deepEqual(planLease(tie, 1 * MIN, half), { action: "reprovision", atMs: 20 * MIN, reason: "max-ttl" });
  // renewAt just before rotateAt: renew
  assert.equal(planLease(tie, 1 * MIN, { ...half, rotateFraction: 0.5 + 1e-6 }).action, "renew");
  // now == rotateAt: rotate now
  assert.deepEqual(planLease(tie, 20 * MIN, half), { action: "reprovision", atMs: 20 * MIN, reason: "max-ttl" });
});

test("lease: a clock before the last grant is rejected", () => {
  const s: LeaseState = { ...base, lastRenewedAtMs: 10 * MIN, expiresAtMs: 40 * MIN };
  assert.throws(() => planLease(s, 9 * MIN), /nowMs is .* at or after the last grant.*clock went backwards/);
  assert.equal(planLease(s, 10 * MIN).action, "renew");
});

test("lease: nowMs and the policy are validated with the cause and the action", () => {
  assert.throws(() => planLease(base, Number.NaN), /nowMs is NaN but must be a finite number.*epoch milliseconds/);
  assert.throws(() => planLease(base, -1), /nowMs is -1 but must be non-negative/);
  const p = DEFAULT_LEASE_POLICY;
  assert.throws(() => planLease(base, 1, { ...p, rotateFraction: 0 }), /rotateFraction is 0 but must be in \(0, 1\]/);
  assert.throws(() => planLease(base, 1, { ...p, renewAheadFraction: 1.5 }), /renewAheadFraction is 1.5 but must be in \(0, 1\]/);
  assert.throws(() => planLease(base, 1, { ...p, maxFailedRenewals: -1 }), /maxFailedRenewals is -1 but must be an integer of at least 1.*before rotating/);
  // 0 would rotate a fresh sandbox before any renewal was tried
  assert.throws(() => planLease(base, 1, { ...p, maxFailedRenewals: 0 }), /maxFailedRenewals is 0 but must be an integer of at least 1/);
  assert.equal(planLease(base, 25 * MIN, { ...p, maxFailedRenewals: 1 }).action, "renew");
  assert.throws(() => planLease(base, 1, { ...p, minRotateMs: -5 }), /minRotateMs is -5/);
  assert.throws(() => planLease({ ...base, expiresAtMs: Number.NaN }, 1), /expiresAtMs is NaN/);
  // a valid edge: fractions of exactly 1 are accepted
  assert.equal(planLease(base, 1, { ...p, rotateFraction: 1, renewAheadFraction: 1 }).action, "renew");
});
