// Test-only composition of a capture broker over the @pomtree/testing fakes (FakeCaptureIndex, FakeCaptureParser,
// FakeQuotaCounters, FakeReportStore over a registry holding the root), for the broker's clients' tests (web_fetch, workflow fetch, the /v1/capture routes). The
// broker itself is the real one (capture/broker.ts); only its ports are fakes, and the transport is whatever the test passes
// (usually testFetchSeam over a FakeOrigin). Never imported by main.ts.
import type { AgentId, CaptureIndex, QuotaCounters, ReportStore } from "@pomtree/core";
import { FakeCaptureIndex, FakeCaptureParser, FakeQuotaCounters } from "@pomtree/testing";
import { createCaptureBroker } from "./capture/broker.ts";
import { rootedReports } from "./capture/test-harness.ts";
import type { CaptureBroker, CaptureBrokerConfig, CaptureBrokerDeps, CaptureJournalPayload, CaptureScope } from "./capture/types.ts";
import { defaultCaptureConfig } from "./capture-wiring.ts";
import type { ExtGatewayOptions, FetchFn } from "./ext-gateway.ts";
import { createExtGateway } from "./ext-gateway.ts";
import type { HostPace } from "./host-pacer.ts";

export const TEST_USER_AGENT = "pomtree-test test@example.invalid";
export const TEST_ROOT = "root";

export interface TestBroker {
  broker: CaptureBroker;
  index: CaptureIndex;
  parser: FakeCaptureParser;
  quota: QuotaCounters;
  reports: ReportStore;
  records: { agent: AgentId; payload: CaptureJournalPayload; key: string }[];
  logs: string[];
}

export function testBroker(
  o: {
    fetch: FetchFn;
    resolveDns?: (h: string) => Promise<{ address: string; family: number }[]>;
    userAgent?: string;
    config?: Partial<Omit<CaptureBrokerConfig, "userAgent">>;
    now?: () => number;
    quota?: QuotaCounters;
    index?: CaptureIndex;
    pace?: HostPace;
    generationOf?: CaptureBrokerDeps["generationOf"];
    scopeFor?: (who: Parameters<CaptureBrokerDeps["scopeFor"]>[0]) => Promise<CaptureScope>;
  } = { fetch: async () => Promise.reject(new Error("no transport")) },
): TestBroker {
  const now = o.now ?? Date.now;
  const index = o.index ?? new FakeCaptureIndex(now);
  const parser = new FakeCaptureParser();
  const quota = o.quota ?? new FakeQuotaCounters();
  const rooted = rootedReports(now); // the FakeRegistry create is async; root() and every report call await it
  const reports = lazyReports(rooted);
  const records: TestBroker["records"] = [];
  const logs: string[] = [];
  const broker = createCaptureBroker({
    index,
    parser,
    quota,
    ...(o.pace && { pace: o.pace }),
    reports,
    root: async () => (await rooted).root,
    generationOf: o.generationOf ?? (async () => 1),
    scopeFor: o.scopeFor ?? (async () => ({ allows: () => true })),
    record: async (agent, payload, key) => {
      records.push({ agent, payload, key });
    },
    log: (line) => logs.push(line),
    fetch: o.fetch,
    ...(o.resolveDns && { resolveDns: o.resolveDns }),
    hostId: "h",
    pomtreedVersion: "test",
    now,
    config: { ...defaultCaptureConfig(), ...o.config, userAgent: o.userAgent ?? TEST_USER_AGENT },
  });
  return { broker, index, parser, quota, reports, records, logs };
}

// A transport whose robots.txt reads answer 404 (allow all, RFC 9309) before `inner`, so a test's transport sees only page requests.
export const withRobots =
  (inner: FetchFn): FetchFn =>
  (url, init) =>
    new URL(url).pathname === "/robots.txt" ? Promise.resolve({ status: 404, headers: { get: () => null }, body: null }) : inner(url, init);

// An extension gateway whose web_fetch is a client of a real broker over fakes (testBroker), with `o.fetch` behind withRobots.
export function brokeredGateway(o: ExtGatewayOptions = {}, captureTimeoutMs?: number): ReturnType<typeof createExtGateway> {
  return createExtGateway({
    generationOf: async () => 1,
    ...o,
    capture: testBroker({
      fetch: withRobots(o.fetch ?? (async () => Promise.reject(new Error("no transport")))),
      resolveDns: o.resolveDns ?? (async () => [{ address: "93.184.216.34", family: 4 }]),
      ...(captureTimeoutMs !== undefined && { config: { timeoutMs: captureTimeoutMs } }),
    }).broker,
  });
}

// A ReportStore that forwards to the FakeReportStore once its root is registered (testBroker is synchronous).
function lazyReports(rooted: ReturnType<typeof rootedReports>): ReportStore {
  const at = async () => (await rooted).reports;
  return {
    write: async (r, k) => (await at()).write(r, k),
    list: async (a) => (await at()).list(a),
    read: async (a, id) => (await at()).read(a, id),
    remove: async (a, id) => (await at()).remove(a, id),
  };
}
