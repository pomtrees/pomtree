import assert from "node:assert/strict";
import { test } from "node:test";
import { contract, createFakes, FakePlacement, FakeQuotaCounters } from "./fakes.ts";
import {
  captureIndexContractBody,
  quotaCountersOpIdContractBody,
  type CaptureIndexContractWorld,
  harnessContractBody,
  idempotencyConflictContractBody,
  hangingSandbox,
  journalAppendContractBody,
  journalUsageIdentityContractBody,
  journalSubscribeContractBody,
  modelGatewayContractBody,
  modelGatewayRegisterOn,
  placementContractBody,
  quotaCountersContractBody,
  registryProviderAttemptsContractBody,
  registryRootPoolContractBody,
  sessionStoreContractBody,
  STATE_CONTRACT_LIMITS,
  stateStoreContractBody,
  templateStoreContractBody,
  watchdogStoreContractBody,
  type HarnessContractWorld,
  type IdempotencyConflictContractWorld,
  type JournalAppendContractWorld,
  type ModelGatewayContractWorld,
  type PlacementContractWorld,
  type QuotaCountersContractWorld,
  type SessionStoreContractWorld,
  type StateStoreContractWorld,
  type TemplateStoreContractWorld,
  type WatchdogStoreContractWorld,
} from "./port-contracts.ts";
import type { ModelGateway } from "@pomtree/core";

// The fake half of each shared port contract. The real halves are wired by the owning package (see TODO(contract-ports)).

const journal = contract<JournalAppendContractWorld>("Journal", { fake: () => createFakes() });
journal("append/read idempotency, fencing, filters", journalAppendContractBody);
journal("joined usage identity across keys and generations", journalUsageIdentityContractBody);
journal("subscribe replay, tail, close", journalSubscribeContractBody);

const registry = contract<JournalAppendContractWorld>("Registry", { fake: () => createFakes() });
registry("setRootPool: atomic top-up and withdrawal, refused in full past the unheld remainder", registryRootPoolContractBody);
registry("provider attempts: keyed bump, reset, per agent", registryProviderAttemptsContractBody);

const idempotencyConflicts = contract<IdempotencyConflictContractWorld>("Idempotency", {
  fake: () => {
    const f = createFakes();
    return { registry: f.registry, mailbox: f.mailbox, approvals: f.approvals };
  },
});
idempotencyConflicts("same key and body replays; same key and different body conflicts", idempotencyConflictContractBody);

const watchdogs = contract<WatchdogStoreContractWorld>("WatchdogStore", { fake: () => ({ watchdogs: createFakes().watchdogs }) });
watchdogs("get/set idempotency, upsert, copies, clear", watchdogStoreContractBody);

const sessions = contract<SessionStoreContractWorld>("SessionStore", { fake: () => ({ sessions: createFakes().sessions }) });
sessions("put/get content addressing, copies, unknown refs", sessionStoreContractBody);

const templates = contract<TemplateStoreContractWorld>("TemplateStore", {
  fake: () => {
    const known = [{ id: "code" }, { id: "web", name: "Web", extensions: ["x"], egress: { kind: "none" as const } }];
    return { templates: createFakes({ templates: known }).templates, known };
  },
});
templates("resolve/list/unknown/malformed/isolation", templateStoreContractBody);

// The fake half of the ModelGateway contract; the real half (ProxyCredentialGateway) is wired in packages/e2e/src/contract.test.ts
// over this same exported body, so a divergence between the two halves fails one of them.
const fakeGatewayWorld = (): ModelGatewayContractWorld => {
  const f = createFakes();
  return { gateway: f.gateway, register: modelGatewayRegisterOn(f.registry) };
};

const gateway = contract<ModelGatewayContractWorld>("ModelGateway", { fake: fakeGatewayWorld });
gateway("issue/replay per agent, spend/revoke without a credential, bad budgets and the four issue refusals", modelGatewayContractBody);

// Negative controls: the same body must FAIL against gateways that break a rule it checks. Each pattern names the single
// assertion it breaks, because a loose pattern would also pass if the body failed for an unrelated reason.
test("ModelGateway negative control: a gateway that ignores the idempotency key fails the body", async () => {
  const w = fakeGatewayWorld();
  let n = 0;
  const wrong: ModelGateway = {
    ...w.gateway,
    spend: (a) => w.gateway.spend(a),
    revoke: (a) => w.gateway.revoke(a),
    issueKey: async (a, b, k) => {
      const r = await w.gateway.issueKey(a, b, k);
      return { ...r, key: `${r.key}#${++n}` };
    },
  };
  await assert.rejects(() => modelGatewayContractBody({ ...w, gateway: wrong }), /Expected values to be strictly deep-equal/);
});

test("ModelGateway negative control: a gateway that caches a credential by idempotency key alone fails the body", async () => {
  const w = fakeGatewayWorld();
  const byKeyAlone = new Map<string, { key: string; baseUrl: string }>();
  const wrong: ModelGateway = {
    ...w.gateway,
    spend: (a) => w.gateway.spend(a),
    revoke: (a) => w.gateway.revoke(a),
    issueKey: async (a, b, k) => {
      const prior = k === undefined ? undefined : byKeyAlone.get(k);
      if (prior) return { ...prior };
      const r = await w.gateway.issueKey(a, b, k);
      if (k !== undefined) byKeyAlone.set(k, r);
      return r;
    },
  };
  // The cross-agent assertion, and only it: a second agent replaying another agent's key must not get that agent's credential.
  await assert.rejects(() => modelGatewayContractBody({ ...w, gateway: wrong }), /not to be strictly deep-equal/);
});

test("ModelGateway negative control: a gateway that throws for an agent holding no credential fails the body", async () => {
  const w = fakeGatewayWorld();
  const held = new Set<string>();
  const wrong: ModelGateway = {
    ...w.gateway,
    issueKey: async (a, b, k) => {
      const r = await w.gateway.issueKey(a, b, k);
      held.add(a);
      return r;
    },
    spend: async (a) => {
      if (!held.has(a)) throw new Error(`no key for ${a}`);
      return w.gateway.spend(a);
    },
    revoke: async (a) => {
      if (!held.has(a)) throw new Error(`no key for ${a}`);
      return w.gateway.revoke(a);
    },
  };
  // The key-less spend assertion, and only it: it must answer zeros rather than throw.
  await assert.rejects(() => modelGatewayContractBody({ ...w, gateway: wrong }), /no key for gw-/);
});

test("ModelGateway negative control: a gateway whose second revoke forgets the budget fails the body", async () => {
  const w = fakeGatewayWorld();
  const revoked = new Set<string>();
  const wrong: ModelGateway = {
    ...w.gateway,
    issueKey: (a, b, k) => w.gateway.issueKey(a, b, k),
    spend: (a) => w.gateway.spend(a),
    revoke: async (a) => {
      const first = !revoked.has(a);
      revoked.add(a);
      return first ? w.gateway.revoke(a) : { unusedMicros: 0 };
    },
  };
  // The revoke-idempotence assertion, and only it: a repeated revoke answers the same number rather than forgetting the budget.
  await assert.rejects(() => modelGatewayContractBody({ ...w, gateway: wrong }), /Expected values to be strictly deep-equal/);
});

test("ModelGateway negative control: a gateway that invents a budget for an unknown agent fails the body", async () => {
  const w = fakeGatewayWorld();
  const wrong: ModelGateway = {
    ...w.gateway,
    issueKey: (a, b, k) => w.gateway.issueKey(a, b, k),
    revoke: (a) => w.gateway.revoke(a),
    spend: async (a) => {
      const s = await w.gateway.spend(a);
      return s.budgetMicros === 0 ? { spentMicros: 0, budgetMicros: 1 } : s;
    },
  };
  // The unknown-agent assertion, and only it: an agent no registry knows has no cap to report.
  await assert.rejects(() => modelGatewayContractBody({ ...w, gateway: wrong }), /budgetMicros: 1/);
});

test("ModelGateway negative control: a gateway that issues for an unregistered agent fails the body", async () => {
  const w = fakeGatewayWorld();
  const wrong: ModelGateway = {
    issueKey: async (a, b, k) => await w.gateway.issueKey(a, b, k).catch(() => ({ key: "k", baseUrl: "http://x" })),
    spend: (a) => w.gateway.spend(a),
    revoke: (a) => w.gateway.revoke(a),
  };
  // The refusal assertion, and only it: the body must fail because no rejection came, not for any other reason.
  await assert.rejects(() => modelGatewayContractBody({ ...w, gateway: wrong }), /Missing expected rejection/);
});

const harness = contract<HarnessContractWorld>("Harness", {
  fake: async () => {
    const f = createFakes({
      harnessEvents: {
        "hc-agent": [
          { kind: "message", role: "assistant", text: "hi" },
          { kind: "tool_call", tool: "t", callId: "c1", input: {} },
          { kind: "tool_result", callId: "c1", ok: true, output: "o" },
          { kind: "usage", inputTokens: 1, outputTokens: 2, costMicros: 3 },
        ],
      },
    });
    const sandbox = await f.sandbox.start({ agent: "hc-agent", image: "i", env: {}, mounts: [] }, "hc");
    return { harness: f.harness, agent: "hc-agent", sandbox, steerSupported: true };
  },
});
harness("start/resume, well-formed events, steer, idempotent stop", harnessContractBody);

// A stub harness over a live sandbox. `mode` picks how its session reacts: conforming = stop() ends events() quietly;
// ignoresStop = stop() leaves events() open; endsAlone = events() ends without stop(); errorsOnStop = stop() ends it with an error event.
type StopMode = "conforming" | "ignoresStop" | "endsAlone" | "errorsOnStop";
const stubHarness = (mode: StopMode): HarnessContractWorld["harness"] => {
  const open = async ({ sandbox }: { sandbox: { id: string } }) => {
    const live = sandbox.id === "sb-live"; // an exited sandbox ends events() by itself, as the first half of the body expects
    let stopped!: () => void;
    const gate = new Promise<void>((r) => (stopped = r));
    return {
      session: "s",
      events: async function* () {
        if (!live || mode === "endsAlone") return;
        await (mode === "ignoresStop" ? new Promise<never>(() => {}) : gate);
        if (mode === "errorsOnStop") yield { kind: "error" as const, message: "sandbox exited" };
      },
      steer: async () => {},
      stop: async () => stopped(),
    };
  };
  return { start: open, resume: open };
};
const stopWorld = (mode: StopMode): HarnessContractWorld => ({
  harness: stubHarness(mode),
  agent: "hc-agent",
  sandbox: { id: "sb-exited", async *output() {}, wait: async () => ({ exitCode: 0 }) },
  steerSupported: true,
  liveSandbox: () => hangingSandbox("sb-live"),
});

test("Harness contract: stop() ends events() while the sandbox lives (conforming stub passes)", () => harnessContractBody(stopWorld("conforming")));
test("Harness contract negative: a stop() that leaves events() open fails", async () => {
  await assert.rejects(() => harnessContractBody(stopWorld("ignoresStop")), /stop\(\) must end events\(\)/);
});
test("Harness contract negative: events() ending without stop() fails the control", async () => {
  await assert.rejects(() => harnessContractBody(stopWorld("endsAlone")), /must not end while the sandbox lives/);
});
test("Harness contract negative: stop() ending events() with an error event fails", async () => {
  await assert.rejects(() => harnessContractBody(stopWorld("errorsOnStop")), /without an exit error/);
});

const placement = contract<PlacementContractWorld>("Placement", {
  fake: () => {
    const max = 2;
    const p: FakePlacement = new FakePlacement(
      () => (p.admitted.size >= max ? { queued: true, reason: "waiting for a session slot" } : { host: "h1" }),
      "h1",
      max,
    );
    return { placement: p, host: "h1", maxConcurrent: max };
  },
});
placement("admit/queue/release/sync", placementContractBody);

const quota = contract<QuotaCountersContractWorld>("QuotaCounters", { fake: () => ({ quota: new FakeQuotaCounters() }) });
quota("take/give/peek windows, limits, argument checks", quotaCountersContractBody);
quota("take opId replay", quotaCountersOpIdContractBody);

// createFakes' CaptureIndex too, so the call-logged view behaves like the bare fake.
const captures = contract<CaptureIndexContractWorld>("CaptureIndex", { fake: () => ({ captures: createFakes().captures }) });
captures("join, idempotency, first-wins settle, negative cache, pauses, reads", captureIndexContractBody);

const stateStore = contract<StateStoreContractWorld>("StateStore", {
  fake: () => {
    let t = 1_000_000;
    const f = createFakes({ now: () => t, stateLimits: () => STATE_CONTRACT_LIMITS });
    return {
      state: f.state,
      registry: f.registry,
      limits: STATE_CONTRACT_LIMITS,
      age: async (ms) => {
        t += ms;
      },
    };
  },
});
stateStore("put/get/CAS/idempotency/remove/list/export/quotas/fencing", stateStoreContractBody);
