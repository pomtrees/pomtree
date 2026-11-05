// S0 of the capture broker across the fetch paths: agent web_fetch, the workflow fetch capability and the broker
// share one durable pacer and one User-Agent rule. Offline: scripted transports and the store-sqlite adapter under os.tmpdir().
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord, QuotaCounters } from "@pomtree/core";
import { FakeQuotaCounters } from "@pomtree/testing";
import { openStore } from "@pomtree/store-sqlite";
import { createExtGateway, type FetchFn, type FetchResponse } from "./ext-gateway.ts";
import { hostPacer } from "./host-pacer.ts";
import { QUOTA_SCOPES } from "./quota.ts";
import { brokeredGateway, testBroker, withRobots } from "./test-capture.ts";
import { buildRunOps, type WorkflowCapabilityServices } from "./workflow-capabilities.ts";

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const ok = (text = "ok", type = "application/json"): FetchResponse => ({
  status: 200,
  headers: { get: (n) => (n === "content-type" ? type : null) },
  body: (async function* () {
    yield Buffer.from(text);
  })(),
});

function tempStore(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-fetch-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "pomtreed.sqlite");
}

// A workflow task's services over a given broker (the shape main.ts builds).
function workflowServices(capture: WorkflowCapabilityServices["capture"], over: Partial<WorkflowCapabilityServices> = {}): WorkflowCapabilityServices {
  return {
    root: async () => ({ id: "root", generation: 1 }) as unknown as AgentRecord,
    agent: async (id) => ({ id, state: "running", generation: 1 }) as unknown as AgentRecord,
    readRoot: async () => [],
    recordRoot: async () => null,
    publishRoot: async () => {
      throw new Error("unused");
    },
    sendToUser: async () => {},
    redactText: (s) => s,
    ask: async () => ({ escalation: "e" }),
    now: () => Date.now(),
    ...(capture && { capture }),
    ...over,
  };
}
const workflowOps = (svc: WorkflowCapabilityServices, hosts: string[]) =>
  buildRunOps({
    workflow: "ext/flow",
    caps: { fetch: { hosts, maxRequests: 10, maxBytes: 10_000, timeoutMs: 5000 } },
    ctx: { agent: "t1", generation: 1, host: "h", input: {}, signal: new AbortController().signal, deadlineAt: null } as never,
    getServices: () => svc,
  });

test("a pomtreed restart (the sqlite store reopened) resets neither web_fetch's counters nor domain pacing", async (t) => {
  const path = tempStore(t);
  const transport: FetchFn = async () => ok("12345", "text/plain");
  let store = openStore(path);
  const opts = (quota: QuotaCounters) => ({ fetch: transport, resolveDns: PUBLIC, maxCallsPerWindow: 2, rateWindowMs: 3_600_000, quota });
  const before = brokeredGateway(opts(store.quotaCounters()));
  assert.equal((await before.call("a", "web_fetch", { url: "https://example.com/one" }, "k1")).ok, true);
  assert.equal((await before.call("a", "web_fetch", { url: "https://example.com/two" }, "k2")).ok, true);
  // Domain pacing: a slot claimed before the restart stays claimed after it.
  const slotMs = 3_600_000;
  const claimedAt: number[] = [];
  const pace = (quota: QuotaCounters) =>
    hostPacer(slotMs, {
      quota,
      now: () => 0,
      sleep: async (ms) => {
        claimedAt.push(ms);
      },
    });
  await pace(store.quotaCounters())?.("data.sec.gov");
  store.close();
  store = openStore(path); // the restart
  t.after(() => store.close());
  const after = brokeredGateway(opts(store.quotaCounters()));
  const r = (await after.call("a", "web_fetch", { url: "https://example.com/three" }, "k3")) as { ok: boolean; reason?: string };
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /rate limit exceeded \(2 calls per 3600000ms\)/);
  assert.equal(store.quotaCounters().peek(QUOTA_SCOPES.webBytes, "a", 0), 10, "the byte count survived");
  await pace(store.quotaCounters())?.("www.sec.gov");
  assert.deepEqual(claimedAt, [slotMs], "slot 0 was taken before the restart, so the next send waits for the next slot");
});

test("web_fetch and workflow fetch to data.sec.gov and www.sec.gov share one pacing bucket (sec.gov)", async () => {
  const quota = new FakeQuotaCounters();
  const sends: { url: string; at: number }[] = [];
  let clock = 1_000_000;
  const pace = hostPacer(1000, {
    quota,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.ok(pace);
  const transport: FetchFn = async (url) => {
    sends.push({ url, at: clock });
    return ok('{"filings":[]}');
  };
  // One broker, as main.ts wires it: web_fetch and the workflow fetch are both its clients.
  const tb = testBroker({ fetch: withRobots(transport), resolveDns: PUBLIC, pace, quota });
  const shared = createExtGateway({ capture: tb.broker, generationOf: async () => 1, quota });
  assert.equal((await shared.call("a", "web_fetch", { url: "https://www.sec.gov/cgi-bin/browse-edgar?action=x" }, "k1")).ok, true);
  const wf = await workflowOps(workflowServices(tb.broker), ["data.sec.gov"]).fetch("https://data.sec.gov/submissions/CIK0000320193.json");
  assert.equal(wf.status, 200);
  const keys = quota.calls.filter((c) => c.method === "take" && c.args[0] === QUOTA_SCOPES.domainPace).map((c) => c.args[1]);
  assert.ok(keys.length >= 2, JSON.stringify(quota.calls));
  assert.deepEqual([...new Set(keys)], ["sec.gov"], "every send of both paths claimed a slot in the sec.gov bucket");
  const ats = sends.map((s) => s.at);
  for (let i = 1; i < ats.length; i++) assert.ok((ats[i] as number) - (ats[i - 1] as number) >= 1000, `sends ${ats.join(", ")} closer than the interval`);
});

test("a replayed pacing take with the same opId charges once; another opId claims the next slot", async (t) => {
  const store = openStore(tempStore(t));
  t.after(() => store.close());
  const quota = store.quotaCounters();
  const waits: number[] = [];
  const pace = hostPacer(1000, {
    quota,
    now: () => 5_000,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.ok(pace);
  await pace("data.sec.gov", undefined, "cj-1:static:0");
  await pace("www.sec.gov", undefined, "cj-1:static:0"); // the crash replay of the same step: the same slot, nothing added
  assert.equal(quota.peek(QUOTA_SCOPES.domainPace, "sec.gov", 5_000), 1);
  assert.deepEqual(waits, [], "the replay took the slot it already held");
  await pace("www.sec.gov", undefined, "cj-1:static:1");
  assert.deepEqual(waits, [1000], "a new step waits for the next slot");
  // The same holds for the capture request quota (QuotaCounters.take opId, one definition in core).
  assert.deepEqual(quota.take(QUOTA_SCOPES.captureRequests, "a", 0, 1, 5, "req:k"), { ok: true, used: 1 });
  assert.deepEqual(quota.take(QUOTA_SCOPES.captureRequests, "a", 0, 1, 5, "req:k"), { ok: true, used: 1 });
  assert.equal(quota.peek(QUOTA_SCOPES.captureRequests, "a", 0), 1);
});
