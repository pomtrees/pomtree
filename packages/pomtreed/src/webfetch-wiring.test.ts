import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_HOST_KIND, type SpawnSpec } from "@pomtree/core";
import { type createExtGateway, webFetchScope } from "./ext-gateway.ts";
import { brokeredGateway } from "./test-capture.ts";
import type { FetchFn } from "./ext-gateway.ts";
import { createWebFetchApproval, createWiredWebFetchApproval } from "./webfetch-approval.ts";
import { setup } from "./test-setup.ts";

// Composition-level tests for the main.ts wiring the ext gateway plus
// createWiredWebFetchApproval (registry gate + generation fence) plus Daemon.notifyApprovalAsk
// (the journaled escalation-channel `message_sent`), all over the shared fakes — no Docker.

// Controllable clock for the approval module (the store's own clock only stamps journal entries).
let t = 0;
const now = () => t;

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

const scopeFetch =
  (log: string[]): FetchFn =>
  async (url) => {
    log.push(url);
    return {
      status: 200,
      headers: { get: () => "text/plain" },
      body: (async function* () {
        yield Buffer.from("ok");
      })(),
    };
  };

const spec = (egress: SpawnSpec["egress"]): SpawnSpec => ({ image: "img", envManifestHash: null, extensions: ["web_fetch"], systemPrompt: null, egress });

// Registers an agent (created state suffices: the gateway never consults the lifecycle state).
const addAgent = (fakes: ReturnType<typeof setup>["fakes"], id: string, egress: SpawnSpec["egress"]) =>
  fakes.registry.create({ spec: spec(egress), id, parent: null, name: id, task: "t", host: "h1", budgetMicros: 1, idempotencyKey: `mk-${id}` });

type Wired = ReturnType<typeof setup> & { log: string[] };
// The main.ts composition (see the createExtGateway construction site): per-agent scope from the
// registry, and the approval hook wired to the approval store with the daemon's journaled alert.
function wiredGateway(t: Wired) {
  const webFetchApprove = createWiredWebFetchApproval({
    store: t.fakes.approvals,
    registry: t.fakes.registry,
    host: "h1",
    now,
    waitMs: 0, // the first call asks and answers "pending"; the test decides, then retries with the same key
    notify: (ap) => t.daemon.notifyApprovalAsk(ap),
  });
  return brokeredGateway({
    fetch: scopeFetch(t.log),
    resolveDns: publicDns,
    webFetchAllowed: async (agent) => {
      try {
        const rec = await t.fakes.registry.get(agent);
        return rec === null || rec.executor !== "container" ? false : webFetchScope(rec.spec.egress);
      } catch {
        return false;
      }
    },
    webFetchApprove,
  });
}

const callFetch = (gw: ReturnType<typeof createExtGateway>, url: string, key = "k") =>
  gw.call("a", "web_fetch", { url }, key) as Promise<{ ok: boolean; denied?: boolean; reason?: string }>;

const alerts = async (t: Wired, agent: string) =>
  (await t.journal.read({ agent }))
    .filter((e) => e.payload.kind === "message_sent")
    .map((e) => e.payload as { channel: string; purpose: string; subject: string; replyTo?: string });

const setupWired = () => {
  const t = { ...setup(async () => {}, { escalationChannels: ["ops"] }), log: [] as string[] };
  return t;
};

test("wired: an out-of-scope fetch asks once, alerts once across retries, and an approved retry fetches pinned to the host", async () => {
  t = 0;
  const w = setupWired();
  const rec = await addAgent(w.fakes, "a", { kind: "registry" });
  const gw = wiredGateway(w);
  const pending = await callFetch(gw, "https://example.com/");
  assert.equal(pending.ok, false);
  assert.equal(pending.denied, undefined);
  assert.match(String(pending.reason), /^capture of example\.com\/ awaits approval \S+; retry with the same key or yield$/);
  assert.equal(w.log.length, 0); // nothing fetched before approval
  assert.equal(w.fakes.approvals.all.length, 1);
  const ap = w.fakes.approvals.all[0]!;
  assert.equal(ap.action.kind, CAPTURE_HOST_KIND);
  assert.equal(ap.action.target, "https://example.com");
  assert.equal(ap.requester.generation, rec.generation); // the generation fence is carried
  // Exactly one journaled escalation-channel alert, on the agent's own journal.
  const first = await alerts(w, "a");
  assert.equal(first.length, 1);
  assert.equal(first[0]!.channel, "ops");
  assert.equal(first[0]!.purpose, "ask");
  assert.equal(first[0]!.replyTo, ap.id);
  assert.equal(first[0]!.subject, `approve ${CAPTURE_HOST_KIND} https://example.com? reply approve or deny`);
  // A retry with the same key converges on the same approval and does not re-alert.
  const again = await callFetch(gw, "https://example.com/");
  assert.match(String(again.reason), /^capture of example\.com\/ awaits approval \S+; retry with the same key or yield$/);
  assert.equal(w.fakes.approvals.all.length, 1);
  assert.equal((await alerts(w, "a")).length, 1);
  await w.fakes.approvals.decide(ap.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  const allowed = await callFetch(gw, "https://example.com/");
  assert.equal(allowed.ok, true);
  assert.deepEqual(w.log, ["https://example.com/"]);
  assert.equal((await alerts(w, "a")).length, 1);
});

test("wired: a denied approval refuses without fetching", async () => {
  t = 0;
  const w = setupWired();
  await addAgent(w.fakes, "a", { kind: "registry" });
  const gw = wiredGateway(w);
  await callFetch(gw, "https://example.com/");
  await w.fakes.approvals.decide(w.fakes.approvals.all[0]!.id, { who: "op", rank: "operator", decision: "deny", why: "no" }, "d1");
  const r = await callFetch(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.match(String(r.reason), /^capture of example\.com\/ denied \(approval \S+\); choose another source$/);
  assert.equal(w.log.length, 0);
});

test("wired: non-escalatable policies and unknown agents refuse without asking or alerting", async () => {
  t = 0;
  const w = setupWired();
  await addAgent(w.fakes, "a", { kind: "none" });
  const gw = wiredGateway(w);
  const r = await callFetch(gw, "https://example.com/");
  assert.deepEqual([r.ok, r.denied], [false, true]);
  assert.match(String(r.reason), /egress policy blocks this host/);
  assert.equal(w.fakes.approvals.all.length, 0);
  assert.equal((await alerts(w, "a")).length, 0);
  assert.equal(w.log.length, 0);
  // An unregistered agent's lookup returns null: the same plain refusal, no approval.
  const r2 = await callFetch(gw, "https://example.com/", "k2");
  assert.equal(r2.ok, false);
  assert.equal(w.fakes.approvals.all.length, 0);
});

test("wired: an allowlist agent escalates an off-list host; its own hosts never ask", async () => {
  t = 0;
  const w = setupWired();
  await addAgent(w.fakes, "a", { kind: "allowlist", hosts: ["docs.example.com"] });
  const gw = wiredGateway(w);
  assert.equal((await callFetch(gw, "https://docs.example.com/x")).ok, true);
  assert.equal(w.fakes.approvals.all.length, 0);
  const pending = await callFetch(gw, "https://other.example.com/");
  assert.match(String(pending.reason), /^capture of other\.example\.com\/ awaits approval \S+; retry with the same key or yield$/);
  assert.equal(w.fakes.approvals.all.length, 1);
  await w.fakes.approvals.decide(w.fakes.approvals.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  assert.equal((await callFetch(gw, "https://other.example.com/")).ok, true);
  assert.deepEqual(w.log, ["https://docs.example.com/x", "https://other.example.com/"]);
});

test("fence: a create carrying a stale requester generation is rejected (fail closed)", async () => {
  t = 0;
  const w = setupWired();
  await addAgent(w.fakes, "a", { kind: "registry" });
  const ask = createWebFetchApproval({ store: w.fakes.approvals, host: "h1", now, waitMs: 0 });
  const ok = await ask("a", "example.com", "k1", 0);
  assert.equal(ok.state, "pending");
  assert.equal(w.fakes.approvals.all[0]!.requester.generation, 0);
  await w.fakes.registry.bumpGeneration("a", "h1", "bump-1"); // agent restarted: generation now 1
  const stale = await ask("a", "example.com", "k2", 0);
  assert.equal(stale.state, "denied");
  assert.match(stale.state === "denied" ? stale.reason : "", /stale requester generation/);
  assert.equal(w.fakes.approvals.all.length, 1); // no record created
  const fresh = await ask("a", "example.com", "k2", 1);
  assert.equal(fresh.state, "pending");
});

test("wired: a notify failure never blocks the verdict", async () => {
  t = 0;
  const w = setupWired();
  await addAgent(w.fakes, "a", { kind: "registry" });
  let notifyCalls = 0;
  const webFetchApprove = createWiredWebFetchApproval({
    store: w.fakes.approvals,
    registry: w.fakes.registry,
    host: "h1",
    now,
    waitMs: 0,
    notify: async () => {
      notifyCalls++;
      throw new Error("journal down");
    },
  });
  const gw = brokeredGateway({ fetch: scopeFetch(w.log), resolveDns: publicDns, webFetchAllowed: () => false, webFetchApprove });
  const pending = await callFetch(gw, "https://example.com/");
  assert.match(String(pending.reason), /^capture of example\.com\/ awaits approval \S+; retry with the same key or yield$/);
  assert.equal(notifyCalls, 1);
  await w.fakes.approvals.decide(w.fakes.approvals.all[0]!.id, { who: "op", rank: "operator", decision: "approve", why: "ok" }, "d1");
  assert.equal((await callFetch(gw, "https://example.com/")).ok, true);
  assert.deepEqual(w.log, ["https://example.com/"]);
});

test("wired: the daemon alert no-ops without an escalation channel or for a gone requester", async () => {
  t = 0;
  const w = setup(async () => {}, {}); // no escalationChannel
  await addAgent(w.fakes, "a", { kind: "registry" });
  const ask = createWebFetchApproval({ store: w.fakes.approvals, host: "h1", now, waitMs: 0 });
  const ap = await w.fakes.approvals.get((await ask("a", "example.com", "k")).approval);
  await w.daemon.notifyApprovalAsk(ap!);
  assert.equal((await w.journal.read({ agent: "a" })).filter((e) => e.payload.kind === "message_sent").length, 0);
});
