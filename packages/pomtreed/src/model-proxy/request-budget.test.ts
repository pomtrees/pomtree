import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeGatewayCredential } from "../gateway.ts";
import { RequestBudget } from "./request-budget.ts";

function credential(secret: string, id: string, budgetMicros = 100, agent = "agent-1"): string {
  return encodeGatewayCredential(secret, { agent, id, budgetMicros, expiresAt: 2_000, issuedAt: 1_000, models: [] });
}

test("request budget verifies credentials and rejects expired or malformed credentials", () => {
  const budget = new RequestBudget({ secret: "signing-secret", now: () => 1_000 });
  assert.equal(budget.reserve("not-a-token", "r1", 1).ok, false);
  assert.deepEqual(budget.reserve(credential("signing-secret", "a".repeat(32)), "r1", 30), {
    ok: true,
    reservation: { agent: "agent-1", credentialId: "a".repeat(32), requestId: "r1" },
    remainingMicros: 70,
  });
  const expired = encodeGatewayCredential("signing-secret", {
    agent: "agent-2",
    id: "b".repeat(32),
    budgetMicros: 10,
    expiresAt: 1_000,
    issuedAt: 0,
    models: [],
  });
  assert.deepEqual(budget.reserve(expired, "r2", 1), { ok: false, reason: "invalid-credential" });
  // checkCredential tells the refusals apart (reserve reports both as invalid-credential).
  assert.deepEqual(budget.checkCredential(expired), { ok: false, reason: "expired" });
  assert.deepEqual(budget.checkCredential("not-a-token"), { ok: false, reason: "invalid" });
  assert.equal(budget.checkCredential(credential("signing-secret", "a".repeat(32))).ok, true);
});

test("request budget reserves before forwarding and releases the unused upper bound at settlement", () => {
  const budget = new RequestBudget({ secret: "signing-secret", now: () => 1_000 });
  const first = budget.reserve(credential("signing-secret", "a".repeat(32)), "r1", 60);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(budget.reserve(credential("signing-secret", "b".repeat(32)), "r2", 41), { ok: false, reason: "budget-exhausted" });
  assert.deepEqual(budget.settle(first.reservation, 12), { ok: true, chargedMicros: 12, remainingMicros: 88 });
  assert.deepEqual(budget.reserve(credential("signing-secret", "a".repeat(32)), "r2", 88).ok, true);
});

test("request budget is idempotent and cannot multiply an agent cap with another token", () => {
  const budget = new RequestBudget({ secret: "signing-secret", now: () => 1_000 });
  const firstKey = credential("signing-secret", "a".repeat(32), 100);
  const first = budget.reserve(firstKey, "request-1", 80);
  assert.equal(first.ok, true);
  // A request id is single-use: neither an in-flight nor a settled replay re-authorizes an upstream call.
  assert.deepEqual(budget.reserve(firstKey, "request-1", 80), { ok: false, reason: "idempotency-conflict" });
  if (first.ok) assert.equal(budget.settle(first.reservation, 5).ok, true);
  assert.deepEqual(budget.reserve(firstKey, "request-1", 80), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(budget.reserve(firstKey, "request-1", 81), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(budget.reserve(credential("signing-secret", "b".repeat(32), 100), "request-1", 80), { ok: false, reason: "idempotency-conflict" });
  assert.deepEqual(budget.reserve(credential("signing-secret", "b".repeat(32), 100), "request-2", 96), { ok: false, reason: "budget-exhausted" });
});

test("expireReservations charges stale unsettled reservations in full and leaves the rest", () => {
  let t = 1_000;
  const budget = new RequestBudget({ secret: "signing-secret", now: () => t });
  const key = credential("signing-secret", "a".repeat(32));
  const stale = budget.reserve(key, "stale", 40);
  const settled = budget.reserve(key, "settled", 30);
  assert.ok(stale.ok && settled.ok);
  if (!stale.ok || !settled.ok) return;
  budget.settle(settled.reservation, 10);
  assert.equal(budget.expireReservations(400), 0);
  t += 500;
  assert.equal(budget.reserve(key, "fresh", 10).ok, true);
  assert.equal(budget.expireReservations(400), 1);
  assert.equal(budget.cancel(stale.reservation), false);
  assert.deepEqual(budget.reserve(key, "stale", 1), { ok: false, reason: "idempotency-conflict" }); // id not reusable
  // spent 10 + 40 charged on expiry, 10 reserved: 40 remain, so 41 is refused.
  assert.deepEqual(budget.reserve(key, "after", 41), { ok: false, reason: "budget-exhausted" });
  assert.equal(budget.reserve(key, "after2", 40).ok, true);
});

test("a late settle after expiry never re-charges the reserved amount and tops up only an overage", () => {
  let t = 1_000;
  const budget = new RequestBudget({ secret: "signing-secret", now: () => t });
  const key = credential("signing-secret", "a".repeat(32), 100);
  const a = budget.reserve(key, "a", 40);
  const b = budget.reserve(key, "b", 20);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  t += 500;
  assert.equal(budget.expireReservations(400), 2);
  assert.deepEqual(budget.settle(a.reservation, 15), { ok: true, chargedMicros: 40, remainingMicros: 40, expiredCharged: true });
  assert.deepEqual(budget.settle(a.reservation, 15), { ok: true, chargedMicros: 40, remainingMicros: 40, expiredCharged: true }); // idempotent
  assert.deepEqual(budget.settle(b.reservation, 35), { ok: true, chargedMicros: 35, remainingMicros: 25, expiredCharged: true }); // 15 overage
});

test("an overcharge is recorded in full and exhausts the agent budget", () => {
  const budget = new RequestBudget({ secret: "signing-secret", now: () => 1_000 });
  const key = credential("signing-secret", "a".repeat(32));
  const reserved = budget.reserve(key, "r1", 50);
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.deepEqual(budget.settle(reserved.reservation, 120), { ok: true, chargedMicros: 120, remainingMicros: -20 });
  assert.deepEqual(budget.reserve(key, "r2", 1), { ok: false, reason: "budget-exhausted" });
});

test("only a late settle after expiry is marked expiredCharged", () => {
  let t = 1_000;
  const budget = new RequestBudget({ secret: "signing-secret", now: () => t });
  const key = credential("signing-secret", "a".repeat(32), 100);
  const late = budget.reserve(key, "late", 40);
  assert.ok(late.ok);
  if (!late.ok) return;
  t += 500;
  assert.equal(budget.expireReservations(400), 1);
  const normal = budget.reserve(key, "normal", 10);
  assert.ok(normal.ok);
  if (!normal.ok) return;
  assert.deepEqual(budget.settle(normal.reservation, 5), { ok: true, chargedMicros: 5, remainingMicros: 55 });
  assert.deepEqual(budget.settle(normal.reservation, 5), { ok: true, chargedMicros: 5, remainingMicros: 55 }); // replay: unmarked
  assert.deepEqual(budget.settle(late.reservation, 15), { ok: true, chargedMicros: 40, remainingMicros: 55, expiredCharged: true });
});

test("cancellation releases only unforwarded work", () => {
  const budget = new RequestBudget({ secret: "signing-secret", now: () => 1_000 });
  const key = credential("signing-secret", "a".repeat(32));
  const cancelled = budget.reserve(key, "r3", 50);
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(budget.cancel(cancelled.reservation), true);
  assert.equal(budget.reserve(key, "r4", 50).ok, true);
});

test("repeated late settles after expiry top up cumulatively like the durable store", () => {
  let t = 1_000;
  const budget = new RequestBudget({ secret: "signing-secret", now: () => t });
  const key = credential("signing-secret", "a".repeat(32), 1000);
  const r = budget.reserve(key, "a", 50);
  assert.ok(r.ok);
  if (!r.ok) return;
  t += 500;
  assert.equal(budget.expireReservations(400), 1);
  assert.deepEqual(budget.settle(r.reservation, 25), { ok: true, chargedMicros: 50, remainingMicros: 950, expiredCharged: true });
  assert.deepEqual(budget.settle(r.reservation, 55), { ok: true, chargedMicros: 55, remainingMicros: 945, expiredCharged: true });
  assert.deepEqual(budget.settle(r.reservation, 99), { ok: true, chargedMicros: 99, remainingMicros: 901, expiredCharged: true });
  assert.deepEqual(budget.settle(r.reservation, 60), { ok: true, chargedMicros: 99, remainingMicros: 901, expiredCharged: true });
});
