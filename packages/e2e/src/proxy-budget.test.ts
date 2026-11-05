// BUD (S0, in-process, no Docker): the budget rules against pomtreed's REAL model proxy server over the scripted fake model, wired to a
// real Daemon with the real credential gateway (proxy-rig.ts). Covers BUD-6 (depth-3 nested carve and settle), the current reading of
// open question 5 (exhaustion bounds the in-flight call and refuses the next), BUD-7 (replayed request id) and the agent half of
// BUD-5 (carve refusals through the API). Parking on the 402 is Pi behavior, out of scope at S0: the container half is
// cli-scenarios.test.ts. Run: node --test packages/e2e/src/proxy-budget.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_BUDGET_REFUSAL_MESSAGE, POMTREED_KINDS, modelRefusalCodeIn } from "@pomtree/core";
import type { AgentId, AgentRecord } from "@pomtree/core";
import { RESERVE_REFUSAL_MESSAGES, handle } from "@pomtree/pomtreed";
import type { ModelScript } from "@pomtree/testing";
import { until } from "./harness.ts";
import type { Api, Play } from "./harness.ts";
import { proxyRig } from "./proxy-rig.ts";
import type { ProxyRig } from "./proxy-rig.ts";

const text = (marker: string, input: number, output: number, times = 1) =>
  ({ id: marker, when: { marker }, times, reply: { kind: "text", text: marker.toUpperCase(), usage: { input, output } } }) as const;

const apiOf =
  (px: ProxyRig, agent: AgentId): Api =>
  (method, url, body) =>
    handle(px.r.daemon, { method, url, body, token: px.r.daemon.agentToken(agent) });

const bodyOf = (res: { body: unknown }) => res.body as { error?: string; code?: string };

// ---------------------------------------------------------------------------------------------------------------------------------
// BUD-6

const POOL = 100_000;
const TOP = 20_000;
const MID = 4_050; // a little above the leaf's carve, so the leaf's overage is above the mid's carve too
const LEAF = 4_000;
// The leaf's scripted charges at the rig's rate card (input 1, output 2 micros per token).
const CHARGES = { c1: 1_500, c2: 1_500, c3: 1_100 } as const; // 500+500*2, 500+500*2, 300+400*2

test("BUD-6: depth-3 nested carve and settle through the real proxy: clamp, own 402, exact charges, ancestor holds, overage, drawdown", {
  timeout: 60_000,
}, async () => {
  const script: ModelScript = {
    name: "bud-6",
    rules: [
      {
        id: "up402",
        when: { marker: "up402" },
        times: 1,
        reply: { kind: "fault", fault: { type: "status", status: 402, body: "UPSTREAM-PROVIDER-402-NO-FUNDS" } },
      },
      text("c1", 500, 500),
      text("c2", 500, 500),
      text("c3", 300, 400),
      text("c4", 1, 1), // must never be reached: the proxy refuses before forwarding
    ],
  };
  const ids: Partial<Record<"top" | "mid" | "leaf", AgentId>> = {};
  const errors: string[] = [];
  let releaseLeaf = () => {};
  const leafHold = new Promise<void>((r) => (releaseLeaf = r));
  const carveFor = { top: MID, mid: LEAF } as const;
  const childOf = { top: "mid", mid: "leaf" } as const;

  const px: ProxyRig = await proxyRig({
    script,
    rootBudgetMicros: POOL,
    play: (agent, prompt): Play => {
      const role = /ROLE=(top|mid|leaf)/.exec(prompt)?.[1] as "top" | "mid" | "leaf" | undefined;
      assert.ok(role, `the harness prompt must carry ROLE=<top|mid|leaf>; got: ${prompt.slice(0, 80)}`);
      ids[role] = agent;
      if (role === "leaf") return { hold: leafHold, result: { status: "succeeded", result: null } };
      return {
        result: { status: "succeeded", result: null },
        run: async (api) => {
          try {
            const child = childOf[role];
            const sp = await api("POST", "/v1/agents", { name: child, task: `ROLE=${child}`, idempotencyKey: child, budgetMicros: carveFor[role] });
            assert.equal(sp.status, 201, `${role} spawn of ${child}: expected 201, got ${sp.status} ${JSON.stringify(sp.body)}`);
            const id = (sp.body as AgentRecord).id;
            for (let i = 0; i < 40; i++) {
              const w = await api("GET", `/v1/agents/${id}/wait?timeoutMs=5000`);
              assert.equal(w.status, 200, `${role} wait on ${child}: expected 200, got ${w.status}`);
              if ((w.body as { done: boolean }).done) break;
            }
            const rp = await api("POST", `/v1/agents/${id}/reap`, { idempotencyKey: `reap-${id}` });
            assert.equal(rp.status, 200, `${role} reap of ${child}: expected 200, got ${rp.status} ${JSON.stringify(rp.body)}`);
          } catch (e) {
            errors.push(`${role}: ${(e as Error).message}`);
            throw e;
          }
        },
      };
    },
  });
  try {
    const root = await px.r.daemon.root();
    const top = await px.r.daemon.spawn(root.id, { name: "top", task: "ROLE=top", idempotencyKey: "top", budgetMicros: TOP });
    await until(
      () => (errors.length ? Promise.reject(new Error(errors.join("; "))) : ids.leaf !== undefined && px.keysOf(ids.leaf).length > 0),
      "the leaf to start with a credential",
    );
    const [mid, leaf] = [ids.mid!, ids.leaf!];
    assert.equal(ids.top, top.id);
    const key = px.keyOf(leaf);

    // Every ancestor holds max(child carve, child consumed) for its live child; nothing moves unless the child's consumption does.
    const assertHolds = (when: string) => {
      const [l, m, t] = [px.ledger(leaf), px.ledger(mid), px.ledger(top.id)];
      assert.equal(
        m.committedMicros,
        Math.max(LEAF, l.committedMicros),
        `${when}: mid's committed must equal the leaf's hold max(${LEAF}, ${l.committedMicros}); ledgers ${JSON.stringify({ l, m, t })}`,
      );
      assert.equal(
        t.committedMicros,
        Math.max(MID, m.committedMicros),
        `${when}: top's committed must equal the mid's hold max(${MID}, ${m.committedMicros}); ledgers ${JSON.stringify({ l, m, t })}`,
      );
      return l;
    };
    assert.equal(assertHolds("before any call").committedMicros, 0);

    // An upstream 402 is the provider's, not the proxy's: passed through, charged 0, and it carries no refusal tag.
    const up = await px.call(key, { requestId: "r-up402", marker: "up402", maxTokens: 100 });
    assert.equal(up.status, 402, up.text);
    assert.ok(up.text.includes("UPSTREAM-PROVIDER-402-NO-FUNDS"), `the upstream 402 body must reach the caller; got ${up.text.slice(0, 200)}`);
    assert.equal(modelRefusalCodeIn(up.text), undefined, "an upstream 402 must not carry the proxy's budget-refusal tag");
    const sUp = await px.settlement(leaf, "r-up402");
    assert.deepEqual([sUp.settlement, sUp.micros, sUp.upstreamStatus], ["failed", 0, 402]);
    assertHolds("after the upstream 402");

    // Two requests the budget affords whole: forwarded unchanged, charged exactly what the stub reported.
    for (const [i, marker] of (["c1", "c2"] as const).entries()) {
      const res = await px.call(key, { requestId: `r-${marker}`, marker, maxTokens: 1000 });
      assert.equal(res.status, 200, res.text);
      const s = await px.settlement(leaf, `r-${marker}`);
      assert.deepEqual([s.settlement, s.micros], ["priced", CHARGES[marker]], `${marker}: ${JSON.stringify(s)}`);
      assert.equal(px.stub.calls.at(-1)!.maxTokens, 1000, `${marker}: an affordable request is forwarded unchanged`);
      assert.equal(assertHolds(`after ${marker}`).committedMicros, CHARGES.c1 * (i + 1));
    }

    // The third asks for more output than the remainder affords: the reservation is the remainder and max_tokens is rewritten down.
    const remaining = px.ledger(leaf).remainingMicros;
    assert.equal(remaining, LEAF - CHARGES.c1 - CHARGES.c2);
    const est = px.estimate({ marker: "c3", maxTokens: 1000 });
    assert.ok(est.reserveMicros > remaining, `the test needs the full reservation (${est.reserveMicros}) above the remainder (${remaining})`);
    const expectedClamp = Math.max(1, Math.floor((remaining - est.promptMicros) / est.microsPerToken));
    const c3 = await px.call(key, { requestId: "r-c3", marker: "c3", maxTokens: 1000 });
    assert.equal(c3.status, 200, c3.text);
    const forwarded = px.stub.calls.at(-1)!.maxTokens;
    assert.ok(forwarded !== null && forwarded < 1000, `the forwarded max_tokens must be rewritten below the 1000 asked; the stub saw ${forwarded}`);
    assert.equal(
      forwarded,
      expectedClamp,
      `forwarded max_tokens must be what the ${remaining} micro remainder affords after the ${est.promptMicros} prompt estimate`,
    );
    const s3 = await px.settlement(leaf, "r-c3");
    assert.deepEqual([s3.settlement, s3.micros], ["priced", CHARGES.c3]);

    // The stub reported more than the clamped reservation (the stub ignores max_tokens), so the leaf overran its carve by under one request.
    const leafNow = assertHolds("after c3 (overage)");
    const consumed = CHARGES.c1 + CHARGES.c2 + CHARGES.c3;
    assert.deepEqual([leafNow.committedMicros, leafNow.overageMicros], [consumed, consumed - LEAF]);
    assert.ok(
      leafNow.overageMicros > 0 && leafNow.overageMicros <= est.reserveMicros,
      `overage ${leafNow.overageMicros} must be positive and at most one request (${est.reserveMicros})`,
    );

    // Nothing fits: the PROXY refuses with its own 402 (tagged, no upstream call, no settlement), distinct from the upstream 402 above.
    const callsBefore = px.stub.calls.length;
    const c4 = await px.call(key, { requestId: "r-c4", marker: "c4", maxTokens: 1000 });
    assert.equal(c4.status, 402, c4.text);
    assert.ok(
      c4.error?.startsWith(MODEL_BUDGET_REFUSAL_MESSAGE),
      `the proxy's 402 must lead with "${MODEL_BUDGET_REFUSAL_MESSAGE}"; got ${c4.text.slice(0, 200)}`,
    );
    assert.equal(
      modelRefusalCodeIn(c4.error ?? ""),
      "model_budget_exhausted",
      `the proxy's 402 must carry the budget-refusal tag; got ${c4.text.slice(0, 200)}`,
    );
    assert.equal(px.stub.calls.length, callsBefore, "a refused call must not reach the upstream");
    assert.ok(!(await px.settlements(leaf)).some((s) => s.requestId === "r-c4"), "a refused call must not settle");
    assertHolds("after the proxy 402");
    // The leaf parking on this 402 (an escalation, then resume) is Pi behavior; S0 stops at the refusal.

    // Per-call settlements are exactly the scripted charges.
    assert.deepEqual(
      (await px.settlements(leaf)).map((s) => [s.requestId, s.micros]),
      [
        ["r-up402", 0],
        ["r-c1", CHARGES.c1],
        ["r-c2", CHARGES.c2],
        ["r-c3", CHARGES.c3],
      ],
    );
    assert.deepEqual(px.stub.unmatched, [], "every forwarded call must match a scripted rule");

    // Unwind: the leaf ends, the mid reaps it, the top reaps the mid, the root reaps the top.
    releaseLeaf();
    await px.r.orchestrator.idle();
    if (errors.length) assert.fail(errors.join("; "));
    for (const id of [top.id, mid, leaf]) assert.equal((await px.r.daemon.get(id))?.state, "reaped", `${id} must be reaped after the chain unwinds`);

    // Overages are booked on the parent as journaled write-offs, once each, of at most one request.
    const overageOf = async (parent: AgentId) =>
      (await px.journalOf(parent)).map((e) => e.payload as Record<string, unknown>).filter((p) => p.kind === POMTREED_KINDS.budgetOverage);
    assert.deepEqual(
      (await overageOf(mid)).map((p) => [p.child, p.carve, p.consumed, p.overage]),
      [[leaf, LEAF, consumed, consumed - LEAF]],
      "the mid's journal must hold the leaf's budget_overage",
    );
    assert.deepEqual(
      (await overageOf(top.id)).map((p) => [p.child, p.carve, p.consumed, p.overage]),
      [[mid, MID, consumed, consumed - MID]],
      "the top's journal must hold the mid's budget_overage",
    );

    // After all reaps: spend equals the sum of settlements, and the root's drawdown is that sum (unused carves came back).
    let settled = 0;
    for (const id of [top.id, mid, leaf]) settled += (await px.settlements(id)).reduce((n, s) => n + s.micros, 0);
    assert.equal(settled, consumed);
    assert.equal(px.debits.spentFor(leaf), consumed, "the debit ledger's spend must equal the sum of the leaf's settlements");
    const rootLedger = px.ledger(root.id);
    assert.equal(rootLedger.budgetMicros - rootLedger.remainingMicros, consumed, `root drawdown must equal total spend; ledger ${JSON.stringify(rootLedger)}`);
  } finally {
    releaseLeaf();
    await px.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Open question 5: "Exhaustion cuts the stream"

test("exhaustion today: the in-flight call is bounded by the clamp and runs to its end, the NEXT call is refused 402 (no mid-stream cut)", {
  timeout: 60_000,
}, async () => {
  // Records the CURRENT behavior only. Whether a mid-stream cut on exhaustion is also expected is open question 5 and is NOT asserted:
  // a stream is cut only by deadlines, resets or cancels (BUD-4), then charged.
  const BUDGET = 1_000;
  const px: ProxyRig = await proxyRig({ script: { name: "oq5", rules: [text("big", 300, 200)] }, rootBudgetMicros: POOL, play: () => ({ hold: px.hold() }) });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: BUDGET });
    await until(() => px.keysOf(a.id).length > 0, "the agent to start with a credential");
    const key = px.keyOf(a.id);
    const est = px.estimate({ marker: "big", maxTokens: 5_000 });
    assert.ok(est.reserveMicros > BUDGET, "the request must ask for more than the budget affords");
    const first = await px.call(key, { requestId: "r-big", marker: "big", maxTokens: 5_000 });
    assert.equal(first.status, 200, first.text);
    assert.ok(first.text.includes("BIG") && first.text.includes("data: [DONE]"), `the in-flight call must run to its end; got ${first.text.slice(0, 300)}`);
    const forwarded = px.stub.calls[0]!.maxTokens!;
    assert.ok(forwarded < 5_000, `the in-flight call is bounded by the clamp: forwarded max_tokens ${forwarded} must be below the 5000 asked`);
    assert.ok(est.promptMicros + forwarded * est.microsPerToken <= BUDGET, `the clamped call must fit the ${BUDGET} micro budget at the proxy's own rates`);
    const s = await px.settlement(a.id, "r-big");
    assert.deepEqual([s.settlement, s.micros], ["priced", 700]);

    const next = await px.call(key, { requestId: "r-next", marker: "big", maxTokens: 5_000 });
    assert.equal(next.status, 402, next.text);
    assert.equal(
      modelRefusalCodeIn(next.error ?? ""),
      "model_budget_exhausted",
      `the next call must be the proxy's tagged 402; got ${next.text.slice(0, 200)}`,
    );
    assert.equal(px.stub.calls.length, 1, "the refused call must not reach the upstream");
  } finally {
    await px.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// BUD-7

test("BUD-7: the same request id sent twice with one issued credential: the second is 409, one upstream call, one settlement", {
  timeout: 60_000,
}, async () => {
  const px: ProxyRig = await proxyRig({
    script: { name: "bud-7", rules: [text("c1", 500, 500, 2)] },
    rootBudgetMicros: POOL,
    play: () => ({ hold: px.hold() }),
  });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: 10_000 });
    await until(() => px.keysOf(a.id).length > 0, "the agent to start with a credential");
    const key = px.keyOf(a.id);
    const first = await px.call(key, { requestId: "dup", marker: "c1" });
    assert.equal(first.status, 200, first.text);
    await px.settlement(a.id, "dup");
    const second = await px.call(key, { requestId: "dup", marker: "c1" });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.error, RESERVE_REFUSAL_MESSAGES["idempotency-conflict"]);
    assert.equal(px.stub.calls.length, 1, "the replay must not reach the upstream");
    assert.equal((await px.settlements(a.id)).filter((s) => s.requestId === "dup").length, 1, "a replayed id must settle once");
    assert.equal(px.debits.spentFor(a.id), 1_500, "the replay must not be charged");
    // Negative control: a fresh id with the same credential is served, so the 409 above is the replay guard and not a dead credential.
    const fresh = await px.call(key, { requestId: "fresh", marker: "c1" });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(px.stub.calls.length, 2);
  } finally {
    await px.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// BUD-5, agent part

test("BUD-5 (agent): an over-remainder carve is 409 budget_exceeds_parent, a negative or fractional one is 400, an empty parent refuses an unspecified carve", {
  timeout: 60_000,
}, async () => {
  const px: ProxyRig = await proxyRig({ script: { name: "bud-5", rules: [text("all", 400, 300)] }, rootBudgetMicros: POOL, play: () => ({ hold: px.hold() }) });
  try {
    const root = await px.r.daemon.root();
    const top = await px.r.daemon.spawn(root.id, { name: "top", task: "t", idempotencyKey: "top", budgetMicros: 1_000 });
    await until(() => px.keysOf(top.id).length > 0, "the agent to start with a credential");
    const api = apiOf(px, top.id);
    const spawn = (key: string, budgetMicros?: number) =>
      api("POST", "/v1/agents", { name: key, task: "t", idempotencyKey: key, ...(budgetMicros !== undefined && { budgetMicros }) });

    const over = await spawn("over", 1_001);
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(bodyOf(over).code, "budget_exceeds_parent");
    for (const [name, amount] of [
      ["negative", -5],
      ["fractional", 1.5],
    ] as const) {
      const bad = await spawn(name, amount);
      assert.equal(bad.status, 400, `${name} carve ${amount}: expected 400, got ${bad.status} ${JSON.stringify(bad.body)}`);
    }
    assert.equal((await px.r.daemon.deps.registry.list({ parent: top.id })).length, 0, "no refused spawn may create a child");

    // The agent spends its whole budget through the proxy: 400 + 300*2 = 1000 micros, so nothing is left to carve.
    const used = await px.call(px.keyOf(top.id), { requestId: "spend-all", marker: "all", maxTokens: 100 });
    assert.equal(used.status, 200, used.text);
    await px.settlement(top.id, "spend-all");
    assert.equal(px.ledger(top.id).remainingMicros, 0);
    const none = await spawn("none");
    assert.equal(none.status, 409, JSON.stringify(none.body));
    const tiny = await spawn("tiny", 1);
    assert.equal(tiny.status, 409, JSON.stringify(tiny.body));
    assert.equal(bodyOf(tiny).code, "budget_exceeds_parent");
    assert.equal((await px.r.daemon.deps.registry.list({ parent: top.id })).length, 0, "no refused spawn may create a child");
  } finally {
    await px.close();
  }
});
