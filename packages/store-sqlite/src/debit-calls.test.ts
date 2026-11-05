import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGatewayCredential } from "@pomtree/core";
import { openStore } from "./store.ts";

const secret = "calls-secret";
const key = (agent: string) =>
  encodeGatewayCredential(secret, { agent, id: "d".repeat(32), budgetMicros: 1_000, expiresAt: Date.now() + 3_600_000, issuedAt: 1, models: ["m"] });

test("stream-cut reclaim: expiry measures idleness since the last touch, so a long healthy stream is never expire-charged", () => {
  let clock = 1_000;
  const s = openStore();
  const debits = s.modelDebit({ secret, now: () => clock });
  const live = debits.reserve(key("a"), "live", 100);
  const stuck = debits.reserve(key("a"), "stuck", 100);
  assert.ok(live.ok && stuck.ok);
  for (let i = 0; i < 10; i++) {
    clock += 100;
    assert.equal(debits.touch(live.reservation), true);
  }
  // 1000 ms after the reservation, but `live` was touched 0 ms ago: only `stuck` (idle 1000 ms) expires at a 500 ms age.
  assert.equal(debits.expireReservations(500), 1);
  assert.equal(debits.spentFor("a"), 100, "only the idle reservation is charged");
  assert.deepEqual(debits.settle(live.reservation, 40), { ok: true, chargedMicros: 40, remainingMicros: 1_000 - 140 });
  assert.equal(debits.touch(live.reservation), false, "a settled reservation is not in flight");
  s.close();
});

test("usage-join: settledCall finds the settled call by provider response id, exactly, for the same agent only", () => {
  const s = openStore();
  const debits = s.modelDebit({ secret });
  const r1 = debits.reserve(key("a"), "req-1", 100);
  const r2 = debits.reserve(key("a"), "req-2", 100);
  const r3 = debits.reserve(key("a"), "req-3", 100);
  assert.ok(r1.ok && r2.ok && r3.ok);
  debits.settle(r1.reservation, 30);
  debits.settle(r2.reservation, 30); // equal charge and tokens: a token-count join could not tell these apart
  debits.recordCall("a", "req-1", { tokensOut: 5, responseId: "msg_1" });
  debits.recordCall("a", "req-2", { tokensOut: 5, responseId: "msg_2" });
  debits.recordCall("a", "req-3", { responseId: "msg_3" }); // still in flight
  assert.deepEqual(debits.settledCall("a", "msg_2"), { requestId: "req-2", chargedMicros: 30 });
  assert.deepEqual(debits.settledCall("a", "msg_1"), { requestId: "req-1", chargedMicros: 30 });
  assert.equal(debits.settledCall("a", "msg_3"), null, "an unsettled call never joins");
  assert.equal(debits.settledCall("a", "msg_x"), null, "an unknown id stays unmatched");
  assert.equal(debits.settledCall("b", "msg_1"), null, "another agent's call never joins");
  s.close();
});
