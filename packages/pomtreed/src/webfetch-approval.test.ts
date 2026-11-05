import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_HOST_KIND, type AgentRecord, type Registry } from "@pomtree/core";
import { FakeApprovalStore } from "@pomtree/testing";
import { type createExtGateway, webFetchScope } from "./ext-gateway.ts";
import { brokeredGateway } from "./test-capture.ts";
import type { ExtGatewayOptions, FetchFn } from "./ext-gateway.ts";
import { createWebFetchApproval, createWiredWebFetchApproval, webFetchEscalatable } from "./webfetch-approval.ts";

// Controllable clock shared by the store and the approval module (rung deadlines settle by advancing t).
let t = 0;
const now = () => t;

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

const scopeFetch =
  (log: string[], redirectTo?: string): FetchFn =>
  async (url) => {
    log.push(url);
    if (redirectTo && log.length === 1) return { status: 302, headers: { get: (n) => (n === "location" ? redirectTo : null) }, body: null };
    return {
      status: 200,
      headers: { get: () => "text/plain" },
      body: (async function* () {
        yield Buffer.from("ok");
      })(),
    };
  };

const newStore = () => new FakeApprovalStore(now);
// waitMs 0: the first call asks and answers "pending"; the test then decides in the store and retries with
// the same idempotency key (the caller's retry converges on the same approval record).
const newRequest = (store: FakeApprovalStore) => createWebFetchApproval({ store, host: "h1", now, timeoutMs: 100, waitMs: 0 });

type Egress = { kind: string; hosts?: readonly string[] };

// The wiring the daemon applies (see the task report's integration snippet): the hook escalates only for
// policy kinds webFetchEscalatable admits, everything else refuses without asking.
const wiredGateway = (store: FakeApprovalStore, log: string[], egress: Egress, over: Partial<ExtGatewayOptions> = {}) =>
  brokeredGateway({
    fetch: scopeFetch(log),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope(egress),
    webFetchApprove: (agent, host, key) => {
      const request = newRequest(store);
      return Promise.resolve(webFetchEscalatable(egress) ? request(agent, host, key) : null);
    },
    ...over,
  });

const callFetch = (gw: ReturnType<typeof createExtGateway>, url: string, key = "k") =>
  gw.call("a", "web_fetch", { url }, key) as Promise<{ ok: boolean; denied?: boolean; reason?: string }>;

test("webFetchEscalatable: registry and allowlist may ask; none and unknown stay refused", () => {
  assert.equal(webFetchEscalatable({ kind: "registry" }), true);
  assert.equal(webFetchEscalatable({ kind: "allowlist" }), true);
  assert.equal(webFetchEscalatable({ kind: "none" }), false);
  assert.equal(webFetchEscalatable({ kind: "unknown" }), false);
  assert.equal(webFetchEscalatable(undefined), false);
});

test("approval: approved verdict is journaled and a retry with the same key converges on one record", async () => {
  t = 0;
  const store = newStore();
  const request = newRequest(store);
  const first = await request("a", "example.com", "k");
  assert.deepEqual(first, { state: "pending", approval: store.all[0]!.id });
  assert.equal(store.all[0]!.action.target, "https://example.com");
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "lgtm" }, "d1");
  const second = await request("a", "example.com", "k");
  assert.deepEqual(second, { state: "approved", approval: store.all[0]!.id });
  assert.equal(store.all.length, 1); // same key: no second approval
  assert.deepEqual(
    store.all[0]!.journal.map((j) => [j.who, j.decision]),
    [["op", "approve"]],
  );
  const again = await request("a", "example.com", "k2");
  assert.equal(again.state, "pending"); // a new call key needs its own approval
  assert.equal(store.all.length, 2);
});

test("approval: deny is a journaled refusal with the approver's reason", async () => {
  t = 0;
  const store = newStore();
  const request = newRequest(store);
  await request("a", "example.com", "k");
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "deny", why: "off limits" }, "d1");
  const v = await request("a", "example.com", "k");
  assert.deepEqual(v, { state: "denied", approval: store.all[0]!.id, reason: "off limits" });
});

test("approval: rung timeouts fail closed past the top rung", async () => {
  t = 0;
  const store = newStore();
  const request = newRequest(store);
  assert.equal((await request("a", "example.com", "k")).state, "pending");
  t = 150; // rung 0 deadline (100) passed; timeout re-bases to 250
  assert.equal((await request("a", "example.com", "k")).state, "pending");
  t = 300; // rung 1
  assert.equal((await request("a", "example.com", "k")).state, "pending");
  t = 450; // rung 2 (top): past it the record settles denied
  const v = await request("a", "example.com", "k");
  assert.equal(v.state, "denied");
  assert.equal(v.reason, "rung deadline passed");
  assert.equal(store.all[0]!.state, "denied");
  assert.equal(store.all[0]!.journal.filter((j) => j.decision === "timeout").length, 3);
});

test("approval: a store failure fails closed", async () => {
  const request = createWebFetchApproval({
    store: {
      create: async () => {
        throw new Error("store down");
      },
    } as unknown as FakeApprovalStore,
    host: "h1",
    waitMs: 0,
  });
  const v = await request("a", "example.com", "k");
  assert.equal(v.state, "denied");
  assert.match(v.reason, /approval store unavailable/);
});

test("gateway: a registry agent's out-of-scope fetch asks, and an approved retry fetches pinned to that host", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  const gw = wiredGateway(store, log, { kind: "registry" });
  const pending = await callFetch(gw, "https://example.com/");
  assert.equal(pending.ok, false);
  assert.equal(pending.denied, undefined); // pending is not a denial
  assert.match(String(pending.reason), /awaits approval \S+; retry with the same key or yield$/);
  assert.equal(log.length, 0); // nothing fetched before approval
  assert.equal(store.all.length, 1);
  assert.equal(store.all[0]!.action.kind, CAPTURE_HOST_KIND);
  assert.equal(store.all[0]!.action.target, "https://example.com");
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  const allowed = await callFetch(gw, "https://example.com/");
  assert.equal(allowed.ok, true);
  assert.deepEqual(log, ["https://example.com/"]);
});

test("gateway: an approved fetch stays scoped (redirect off the approved host is blocked)", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  const gw = wiredGateway(store, log, { kind: "registry" }, { fetch: scopeFetch(log, "https://evil.test/steal") });
  await callFetch(gw, "https://example.com/");
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  const r = await callFetch(gw, "https://example.com/");
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /egress policy blocks this host/);
  assert.deepEqual(log, ["https://example.com/"]);
});

test("gateway: a denied approval refuses without fetching", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  const gw = wiredGateway(store, log, { kind: "registry" });
  await callFetch(gw, "https://example.com/");
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "deny", why: "no" }, "d1");
  const r = await callFetch(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.match(String(r.reason), /^capture of example\.com\/ denied \(approval \S+\); choose another source$/);
  assert.equal(log.length, 0);
});

test("gateway: an unanswered approval times out refused (fail closed)", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  const gw = wiredGateway(store, log, { kind: "registry" });
  await callFetch(gw, "https://example.com/");
  for (const at of [150, 300, 450]) {
    t = at;
    await callFetch(gw, "https://example.com/");
  }
  const r = await callFetch(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.match(String(r.reason), /^capture of example\.com\/ denied \(approval \S+\); choose another source$/);
  assert.equal(log.length, 0);
});

test("gateway: an approval is scoped to the one host; another host asks again", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  const gw = wiredGateway(store, log, { kind: "registry" });
  await callFetch(gw, "https://example.com/", "k1");
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  assert.equal((await callFetch(gw, "https://example.com/", "k1")).ok, true);
  const other = await callFetch(gw, "https://other.example.com/", "k2");
  assert.equal(other.ok, false);
  assert.match(String(other.reason), /awaits approval \S+; retry with the same key or yield$/);
  assert.equal(store.all.length, 2);
  assert.equal(store.all[1]!.action.target, "https://other.example.com");
  assert.deepEqual(log, ["https://example.com/"]);
});

test("gateway: an allowlist agent escalates an off-list host; its own hosts never ask", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  let asked = 0;
  const request = newRequest(store);
  const gw = brokeredGateway({
    fetch: scopeFetch(log),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope({ kind: "allowlist", hosts: ["docs.example.com"] }),
    webFetchApprove: (agent, host, key) => {
      asked++;
      return request(agent, host, key);
    },
  });
  assert.equal((await callFetch(gw, "https://docs.example.com/a")).ok, true);
  assert.equal(asked, 0); // in-scope fetches do not escalate
  const pending = await callFetch(gw, "https://other.example.com/");
  assert.equal(pending.ok, false);
  assert.match(String(pending.reason), /awaits approval \S+; retry with the same key or yield$/);
  assert.equal(asked, 1);
  await store.decide(store.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  assert.equal((await callFetch(gw, "https://other.example.com/")).ok, true);
  assert.deepEqual(log, ["https://docs.example.com/a", "https://other.example.com/"]);
});

test("gateway: a non-escalatable policy (none) and a hook refusal keep the plain refusal, no approval", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  const gw = wiredGateway(store, log, { kind: "none" });
  const r = await callFetch(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.match(String(r.reason), /egress policy blocks this host/);
  assert.equal(store.all.length, 0);
  assert.equal(log.length, 0);
  // An allowlist agent whose hook returns null keeps the plain scope refusal.
  const gw2 = brokeredGateway({
    fetch: scopeFetch(log),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope({ kind: "allowlist", hosts: ["docs.example.com"] }),
    webFetchApprove: async () => null,
  });
  const r2 = await callFetch(gw2, "https://other.example.com/");
  assert.deepEqual([r2.ok, r2.denied], [false, true]);
  assert.match(String(r2.reason), /egress policy blocks this host/);
});

test("gateway: a throwing hook fails closed", async () => {
  const log: string[] = [];
  const gw = brokeredGateway({
    fetch: scopeFetch(log),
    resolveDns: publicDns,
    webFetchAllowed: () => webFetchScope({ kind: "registry" }),
    webFetchApprove: async () => {
      throw new Error("approval path broken");
    },
  });
  const r = await callFetch(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.equal(log.length, 0);
});

test("gateway: the kill switch and the caps are unchanged by the escalation path", async () => {
  t = 0;
  const log: string[] = [];
  const store = newStore();
  let asked = 0;
  const off = wiredGateway(
    store,
    log,
    { kind: "registry" },
    {
      webFetchEnabled: false,
      webFetchApprove: async () => {
        asked++;
        return null;
      },
    },
  );
  const r = await callFetch(off, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.equal(asked, 0); // disabled by policy never reaches the hook
  assert.equal(store.all.length, 0);
  // An approved fetch still passes through the per-agent rate cap.
  t = 0;
  const store2 = newStore();
  const gw = wiredGateway(store2, log, { kind: "registry" }, { maxCallsPerWindow: 1, rateWindowMs: 1000, now });
  await callFetch(gw, "https://example.com/", "k1");
  await store2.decide(store2.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  assert.equal((await callFetch(gw, "https://example.com/", "k1")).ok, true);
  // The cap is checked before the broker (and so before any approval): the next call is refused without asking.
  const capped = await callFetch(gw, "https://example.com/", "k2");
  assert.deepEqual([capped.ok, capped.denied], [false, true]);
  assert.match(String(capped.reason), /rate limit exceeded/);
  assert.equal(store2.all.length, 1);
});

test("deterministic agent: a web_fetch approval refuses without asking or alerting (fail closed)", async () => {
  const store = newStore();
  let alerts = 0;
  const det = {
    id: "d1",
    parent: "root",
    name: "d",
    task: "t",
    state: "running",
    exit: null,
    result: null,
    host: "h1",
    generation: 1,
    sandbox: null,
    budgetMicros: 1,
    createdAt: 0,
    updatedAt: 0,
    executor: "deterministic",
    spec: { driver: "fetch-diff", input: {} },
  } as unknown as AgentRecord;
  const hook = createWiredWebFetchApproval({
    store,
    registry: { get: async () => det } as unknown as Registry,
    host: "h1",
    now,
    timeoutMs: 100,
    waitMs: 0,
    notify: async () => {
      alerts++;
    },
  });
  assert.equal(await hook("d1", "example.com", "k"), null);
  assert.equal(alerts, 0);
});
