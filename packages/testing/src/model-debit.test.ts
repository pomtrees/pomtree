import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeGatewayCredential } from "@pomtree/core";
import { contract, FakeModelDebitStore, modelDebitContractBody } from "./index.ts";
import type { ModelDebitContractWorld } from "./index.ts";

const secret = "controller-secret";

contract<ModelDebitContractWorld>("ModelDebitStore", {
  fake: () => {
    let t = 1_000;
    const now = () => t;
    const debits = new FakeModelDebitStore({ secret, now });
    return {
      debits,
      secret,
      now,
      advance: (ms) => {
        t += ms;
      },
      callMeta: (agent, requestId) => debits.callMeta.get(JSON.stringify([agent, requestId])) ?? null,
    };
  },
})("reserve/settle/cancel/authorize/revoke", modelDebitContractBody);

test("FakeModelDebitStore.recordCall keeps cache tokens and replaces them on replay (omitted fields are cleared)", () => {
  const now = () => 1_000;
  const d = new FakeModelDebitStore({ secret, now });
  const k = encodeGatewayCredential(secret, { agent: "a", id: "a".repeat(32), budgetMicros: 100, expiresAt: 2_000, issuedAt: 1_000, models: [] });
  assert.equal(d.reserve(k, "r1", 10).ok, true);
  assert.equal(d.recordCall("a", "r1", { tokensIn: 4, cacheReadTokens: 1039, cacheWriteTokens: 12152 }), true);
  assert.deepEqual(d.callMeta.get(JSON.stringify(["a", "r1"])), { tokensIn: 4, cacheReadTokens: 1039, cacheWriteTokens: 12152 });
  assert.equal(d.recordCall("a", "r1", { tokensIn: 4, cacheReadTokens: 1039 }), true);
  assert.deepEqual(d.callMeta.get(JSON.stringify(["a", "r1"])), { tokensIn: 4, cacheReadTokens: 1039 });
});
