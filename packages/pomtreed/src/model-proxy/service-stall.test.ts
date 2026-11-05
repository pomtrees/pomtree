// A call refused 402 because the remainder is below the minimum reports a budget stall (the daemon escalates on it); the
// expired-charged accounting that leads to such a stall is unchanged (a reservation in flight at a crash is charged in full).
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeRatesSource } from "@pomtree/testing";
import { encodeGatewayCredential } from "../gateway.ts";
import { createRequestEstimate } from "./price.ts";
import { RequestBudget } from "./request-budget.ts";
import { ModelProxy } from "./service.ts";
import type { ModelProxyOptions } from "./service.ts";

const secret = "controller-secret";
let clock = 1_000;
const now = () => clock;
const key = (budgetMicros: number, id = "a".repeat(32)) =>
  encodeGatewayCredential(secret, { agent: "agent-1", id, budgetMicros, expiresAt: 10_000_000, issuedAt: 1_000, models: ["ds"] });
const enc = (s: string) => new TextEncoder().encode(s);
const rates = new FakeRatesSource({ p: { ds: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 } } });

function rig(over: Partial<ModelProxyOptions> = {}) {
  const budget = new RequestBudget({ secret, now });
  const stalls: Array<{ agent: string; remainingMicros: number | null; floorMicros: number }> = [];
  const proxy = new ModelProxy({
    upstream: { baseUrl: "https://provider.example/v1", key: "provider-secret" },
    budget,
    maximumRequestMicros: 50,
    price: () => ({ micros: 20, basis: "catalog" }),
    estimate: createRequestEstimate(rates, "p"),
    fetch: async () => new Response("{}"),
    onBudgetStall: (e) => void stalls.push(e),
    ...over,
  });
  const call = (credential: string, requestId: string, body = '{"model":"ds","max_tokens":384000}') =>
    proxy.forward({ credential, requestId, path: "/chat/completions", body: enc(body) });
  return { proxy, budget, stalls, call };
}

test("a below-minimum refusal reports the stall with the agent, the remainder and the minimum, on every refused call", async () => {
  const { stalls, call } = rig();
  assert.equal((await call(key(100), "r1")).status, 402);
  assert.equal((await call(key(100), "r2")).status, 402);
  assert.deepEqual(stalls, [
    { agent: "agent-1", remainingMicros: 100, floorMicros: 256 },
    { agent: "agent-1", remainingMicros: 100, floorMicros: 256 },
  ]);
});

test("negative control: a call the budget covers reports no stall", async () => {
  const { stalls, call } = rig();
  assert.equal((await call(key(256), "r1")).status, 200);
  assert.deepEqual(stalls, []);
});

test("an observer that throws does not change the refusal", async () => {
  const { call } = rig({
    onBudgetStall: () => {
      throw new Error("boom");
    },
  });
  const r = await call(key(100), "r1");
  assert.equal(r.status, 402);
  assert.match("error" in r ? r.error : "", /100 micro-USD remain.*below the 256 micro-USD minimum/);
});

test("the thinking-budget clamp 402 is not a stall (the agent can fix it by lowering thinking)", async () => {
  const { stalls, call } = rig();
  const r = await call(key(300), "r1", '{"model":"ds","max_tokens":384000,"thinking":{"type":"enabled","budget_tokens":200000}}');
  assert.equal(r.status, 402);
  assert.deepEqual(stalls, []);
});

test("expired-charged accounting is unchanged: a reservation in flight at a crash is charged in full, and the next call stalls", async () => {
  const { budget, stalls, call } = rig();
  const cred = key(1_000);
  // The in-flight request at the crash reserved the whole remainder (a small agent's first call).
  assert.equal(budget.reserve(cred, "in-flight", 1_000).ok, true);
  assert.equal((await call(cred, "during")).status, 402, "before the expiry the agent has 0 remaining");
  clock += 600;
  assert.equal(budget.expireReservations(500), 1);
  assert.deepEqual(budget.reserve(cred, "after", 1), { ok: false, reason: "budget-exhausted" }, "the whole 1000 was charged, not just what the call used");
  assert.equal((await call(cred, "next")).status, 402);
  assert.equal(stalls.length, 2);
  assert.equal(stalls[1]!.remainingMicros, 0);
});
