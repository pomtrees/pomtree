import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import {
  journalRetentionContractBody,
  journalAppendContractBody,
  journalSubscribeContractBody,
  approvalContractBody,
  contract,
  escalationContractBody,
  hangingSandbox,
  harnessContractBody,
  createFakes,
  modelGatewayContractBody,
  modelGatewayRegisterOn,
  captureIndexContractBody,
  quotaCountersContractBody,
  quotaCountersOpIdContractBody,
  sessionStoreContractBody,
  STATE_CONTRACT_LIMITS,
  stateStoreContractBody,
  templateStoreContractBody,
  watchdogStoreContractBody,
} from "@pomtree/testing";
import type {
  ApprovalContractWorld,
  CaptureIndexContractWorld,
  EscalationContractWorld,
  HarnessContractWorld,
  JournalAppendContractWorld,
  ModelGatewayContractWorld,
  ModelScript,
  QuotaCountersContractWorld,
  SessionStoreContractWorld,
  StateStoreContractWorld,
  TemplateStoreContractWorld,
  WatchdogStoreContractWorld,
} from "@pomtree/testing";
import type { SandboxHandle } from "@pomtree/core";
import { ProxyCredentialGateway } from "../../pomtreed/src/gateway.ts";
import { openStateStore, openStore } from "@pomtree/store-sqlite";
import { createPiHarness } from "@pomtree/harness-pi";
import { DirTemplateStore } from "../../template-dir/src/index.ts";
import { SECRET, tmp } from "./harness.ts";
import { proxyRig } from "./proxy-rig.ts";
import type { ProxyRig } from "./proxy-rig.ts";

// The shared port contract bodies, run against the real store-sqlite (the `real` half the fakes' own
// suite cannot wire). The fake halves run in @pomtree/testing (fakes.test.ts, port-contracts.test.ts).
// The Sandbox body is NOT wired to DockerSandbox: it starts image "i" with workspace "/p" (fake-only
// values), so it cannot run against real Docker without a parameterised world (testing/contract gap).
const realStore = () => openStore(join(tmp("contract"), "pomtreed.sqlite"));

const esc = contract<EscalationContractWorld>("EscalationStore", {
  real: () => {
    const s = realStore();
    return { escalations: s.escalations, registry: s.registry };
  },
});
esc("create/get/list/answer", escalationContractBody);

const apr = contract<ApprovalContractWorld>("ApprovalStore", {
  real: () => {
    const s = realStore();
    return { approvals: s.approvals, registry: s.registry };
  },
});
apr("create/decide/timeout ladder", approvalContractBody);

const wdg = contract<WatchdogStoreContractWorld>("WatchdogStore", { real: () => ({ watchdogs: realStore().watchdogs }) });
wdg("get/set idempotency, upsert, copies, clear", watchdogStoreContractBody);

const ses = contract<SessionStoreContractWorld>("SessionStore", { real: () => ({ sessions: realStore().sessions }) });
ses("put/get content addressing, copies, unknown refs", sessionStoreContractBody);

const jr = contract<import("@pomtree/testing").JournalContractWorld>("Journal", {
  real: () => {
    const s = realStore();
    return { journal: s.journal, registry: s.registry, checkpoints: s.checkpoints, age: (ms) => new Promise((r) => setTimeout(r, ms)) };
  },
});
jr("retention + spendFor", journalRetentionContractBody);

const ja = contract<JournalAppendContractWorld>("Journal", {
  real: () => {
    const s = realStore();
    return { journal: s.journal, registry: s.registry };
  },
});
ja("append/read idempotency, fencing, filters", journalAppendContractBody);
ja("subscribe replay, tail, close", journalSubscribeContractBody);

const qc = contract<QuotaCountersContractWorld>("QuotaCounters", {
  real: () => ({ quota: realStore().quotaCounters() }),
});
qc("take/give/peek windows, limits, argument checks", quotaCountersContractBody);
qc("take opId replay", quotaCountersOpIdContractBody);

const ci = contract<CaptureIndexContractWorld>("CaptureIndex", {
  real: () => ({ captures: realStore().captures }),
});
ci("join, idempotency, first-wins settle, negative cache, pauses, reads", captureIndexContractBody);

const ss = contract<StateStoreContractWorld>("StateStore", {
  real: () => {
    const dir = tmp("contract");
    const s = openStore(join(dir, "pomtreed.sqlite"));
    const st = openStateStore(join(dir, "state.sqlite"), { stateLimits: () => STATE_CONTRACT_LIMITS, generationOf: s.generationOf });
    return { state: st.state, registry: s.registry, limits: STATE_CONTRACT_LIMITS, age: (ms) => new Promise((r) => setTimeout(r, ms)) };
  },
});
ss("put/get/CAS/idempotency/remove/list/export/quotas/fencing", stateStoreContractBody);

// DirTemplateStore (template-dir has no @pomtree/testing dev dependency, so the wiring lives here).
// One <id>.json per template; `name` equals the file stem or is omitted.
const dirTemplates = (): TemplateStoreContractWorld => {
  const root = tmp("templates");
  const known = [{ id: "code" }, { id: "web", name: "web", extensions: ["web_fetch"], egress: { kind: "none" as const } }];
  for (const t of known) {
    const { id, ...rest } = t;
    writeFileSync(join(root, `${id}.json`), JSON.stringify(rest));
  }
  return { templates: new DirTemplateStore({ root }), known: known as TemplateStoreContractWorld["known"] };
};
test("TemplateStore [real] resolve/list/unknown/malformed/isolation", () => templateStoreContractBody(dirTemplates()));

test("TemplateStore [real] negative: name/stem mismatch, malformed JSON, symlinked file and traversal never resolve", async () => {
  const root = tmp("templates-neg");
  const outside = join(tmp("templates-out"), "evil.json");
  writeFileSync(outside, "{}");
  writeFileSync(join(root, "mismatch.json"), JSON.stringify({ name: "other" }));
  writeFileSync(join(root, "broken.json"), "{nope");
  symlinkSync(outside, join(root, "linked.json"));
  mkdirSync(join(root, "dir.json"));
  const s = new DirTemplateStore({ root });
  for (const id of ["mismatch", "broken"]) await assert.rejects(() => s.resolve(id), `${id} must be rejected`);
  let linked: unknown = null;
  try {
    linked = await s.resolve("linked");
  } catch {
    linked = null;
  }
  assert.equal(linked, null);
  assert.equal(await s.resolve("dir"), null);
});

// createPiHarness over a sandbox that has already exited: no output, exit 0. The adapter then reports the missing
// result as an error event, which the body only checks for well-formedness. steer is unwired in pomtreed, so it must reject.
const exitedSandbox = (): SandboxHandle => ({ id: "sb-exited", async *output() {}, wait: async () => ({ exitCode: 0 }) });
const piWorld = (steer?: (a: string, m: string) => Promise<void>): HarnessContractWorld => ({
  harness: createPiHarness({
    sink: () => ({ read: async () => ({ text: "", offset: 0 }) }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    ...(steer ? { steer } : {}),
  }),
  agent: "hc-agent",
  sandbox: exitedSandbox(),
  steerSupported: !!steer,
  liveSandbox: () => hangingSandbox(),
});
test("Harness [real] start/resume, well-formed events, steer, idempotent stop (pi, steer unwired)", () => harnessContractBody(piWorld()));

test("Harness [pi] steer wired: contract holds with steerSupported true; unwired steer rejects", async () => {
  const calls: string[] = [];
  await harnessContractBody(piWorld(async (_a, m) => void calls.push(m)));
  assert.deepEqual(calls, ["nudge", "nudge"]);
  const unwired = piWorld();
  await assert.rejects(async () => (await unwired.harness.start({ agent: "a", sandbox: unwired.sandbox, prompt: "p" })).steer("x"), /steer unsupported/);
});

// ModelGateway: the shared contract body (packages/testing/src/port-contracts.ts, where the fake's own suite runs its fake half)
// against the real ProxyCredentialGateway. The real half is built directly over a real sqlite store, not the daemon rig: the port's
// surface (issue a credential, read spend, revoke) never touches the model upstream, so it needs the real registry, journal and
// durable debit ledger but no socket.
const mg = contract<ModelGatewayContractWorld>("ModelGateway", {
  real: () => {
    const store = realStore();
    const now = () => Date.now();
    const gateway = new ProxyCredentialGateway({
      registry: store.registry,
      journal: store.journal,
      debits: store.modelDebit({ secret: SECRET, now }),
      secret: SECRET,
      proxyBaseUrl: "http://127.0.0.1:1", // never fetched
      tokenTtlMs: 3_600_000,
      now,
    });
    return { gateway, register: modelGatewayRegisterOn(store.registry) };
  },
});
mg("issue/replay per agent, spend/revoke without a credential, bad budgets and the four issue refusals", modelGatewayContractBody);

// ---------------------------------------------------------------------------------------------------------------------------------
// ModelGateway settlement pricing: WHICH branch priced the call (TODO(cost-live-verify)).
//
// The ModelGateway port carries no pricing outcome (core ports.ts: issueKey/spend/revoke), so the world above cannot reach the
// branch that charges a provider-reported `usage.cost`. That branch lives in the proxy's settle path (pomtreed model-proxy/price.ts,
// `reportedMicros`), and it was unreachable offline until the scripted upstream could emit a `cost` at all: every offline test
// exercised only the local-catalog branch, so a change in `usage.cost`'s shape would have silently fallen back to catalog pricing
// with every test still green. proxyRig is the real proxy server, the real credential gateway and the real durable debit ledger
// over the scripted upstream on loopback: the whole path is real except the provider itself.
//
// Asserting a charge above zero would pass under exactly that silent fallback, so each case pins both the charge and the recorded
// pricing basis (the settlement's `basis`, which names WHERE the number came from). The micros check says the right number was
// charged; the basis check says it came from the right place, so a change in `usage.cost`'s shape that silently fell back to catalog
// pricing fails on the basis even where the two figures coincide (the free call). The `settlement` field is "priced" for the
// reported AND the catalog branch, so it cannot tell them apart; it only rules out the fail-closed branches.
const COST_CASES = [
  // The baseline that gives the reported case its meaning: identical tokens, no `cost` field, so the catalog prices it.
  { marker: "cost-absent", usage: { input: 500, output: 500 }, micros: 1_500, basis: "catalog" },
  // A finite provider cost in USD is charged as reported: 0.000777 USD = 777 micros, which the catalog cannot produce here.
  { marker: "cost-reported", usage: { input: 500, output: 500, cost: 0.000777 }, micros: 777, basis: "reported" },
  // A reported 0 with nonzero tokens is "unreported" (an unpriced model), not a free call: the catalog prices it.
  { marker: "cost-zero-tokens", usage: { input: 500, output: 500, cost: 0 }, micros: 1_500, basis: "catalog" },
  // A malformed cost (a string) is ignored and the catalog prices it. This pins the CURRENT policy, which is also the silent
  // fallback that hid the gap: the point of the case is that a change to it now shows up offline.
  { marker: "cost-malformed", usage: { input: 500, output: 500, cost: "0.000777" }, micros: 1_500, basis: "catalog" },
  // A reported 0 with zero tokens is a genuinely free call, charged 0 rather than failing closed. The catalog also prices zero
  // tokens at 0, so the micros cannot tell the branches apart here; the recorded basis does: a reported 0 is the provider's own figure.
  { marker: "cost-free", usage: { input: 0, output: 0, cost: 0 }, micros: 0, basis: "reported" },
] as const;

test("ModelGateway [real] settlement prices a provider-reported cost, and falls back to the catalog for an absent, zero or malformed one", {
  timeout: 60_000,
}, async () => {
  const script: ModelScript = {
    name: "cost-branches",
    rules: COST_CASES.map((c) => ({ id: c.marker, when: { marker: c.marker }, times: 1, reply: { kind: "text", text: "OK", usage: c.usage } })),
  };
  const statuses: number[] = [];
  let called!: () => void;
  const callsDone = new Promise<void>((r) => (called = r));
  const px: ProxyRig = await proxyRig({
    script,
    rootBudgetMicros: 200_000,
    play: (agent) => ({
      run: async () => {
        for (const c of COST_CASES) {
          // maxTokens well above the scripted output so every reservation covers its charge; the charge under test is the settlement's.
          statuses.push((await px.call(px.keyOf(agent), { requestId: c.marker, marker: c.marker, maxTokens: 2_000 })).status);
        }
        called();
      },
      hold: px.hold(),
      result: { status: "succeeded", result: null },
    }),
  });
  try {
    const root = await px.r.daemon.root();
    const a = await px.r.daemon.spawn(root.id, { name: "a", task: "t", idempotencyKey: "a", budgetMicros: 50_000 });
    await callsDone;
    assert.deepEqual(
      statuses,
      COST_CASES.map(() => 200),
      "every scripted call must be answered 200 by the real proxy",
    );
    for (const c of COST_CASES) {
      const s = await px.settlement(a.id, c.marker);
      assert.equal(s.micros, c.micros, `${c.marker} (${c.basis}): expected ${c.micros} micros, got ${s.micros}`);
      // "priced" covers both the reported and the catalog branch; it rules out the fail-closed branches (estimated from byte sizes, or
      // the whole reservation). The basis is the separate fact of which priced branch produced the charge.
      assert.equal(s.settlement, "priced", `${c.marker}: must be priced, not a fail-closed estimate or the whole reservation`);
      assert.equal(
        s.basis,
        c.basis,
        `${c.marker}: the settlement must record basis "${c.basis}", got "${s.basis}"; the charge came from a different pricing branch than this case expects`,
      );
      assert.equal(s.tokensIn, c.usage.input, `${c.marker}: the settled row must record the reported input tokens`);
      assert.equal(s.tokensOut, c.usage.output, `${c.marker}: the settled row must record the reported output tokens`);
    }
  } finally {
    await px.close();
  }
});
