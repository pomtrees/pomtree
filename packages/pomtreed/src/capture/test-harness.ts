// Test-only harness for the broker tests in this directory: a broker over the @pomtree/testing fakes and a FakeOrigin reached
// through pomtreed's testFetchSeam, so no test touches the network. Unmapped hosts fail DNS (ENOTFOUND) instead of resolving for real.
import type { AgentId } from "@pomtree/core";
import { FakeCaptureIndex, FakeCaptureParser, FakeOrigin, FakeQuotaCounters, FakeRegistry, FakeReportStore } from "@pomtree/testing";
import { testFetchSeam } from "../test-fetch.ts";
import type { FetchFn } from "../ext-gateway.ts";
import type { HostPace } from "../host-pacer.ts";
import { createCaptureBroker } from "./broker.ts";
import type { CaptureBroker, CaptureBrokerConfig, CaptureBrokerDeps, CaptureJournalPayload, CaptureScope } from "./types.ts";

export const UA = "pomtree-test/1.0 ops@example.org";
export const AGENT = "ag-1";
export const ROOT = { id: "root", host: "h1" }; // the root rootedReports registers (its generation is the registry's)
const HOSTS = [
  "example.com",
  "www.example.com",
  "other.example.org",
  "tls.example.com",
  "archive.org",
  "web.archive.org",
  "data.sec.gov",
  "www.sec.gov",
  "hacker-news.firebaseio.com",
];

// The report store of the broker tests: @pomtree/testing's FakeReportStore over a FakeRegistry that holds the root, the publisher of
// every capture artifact (the fake fences writes on the publisher's registered generation, as the adapters do).
export async function rootedReports(now: () => number): Promise<{ reports: FakeReportStore; root: { id: AgentId; generation: number; host: string } }> {
  const registry = new FakeRegistry(now);
  const rec = await registry.create({
    spec: { image: "img", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
    id: "root",
    parent: null,
    name: "root",
    task: "root",
    host: "h1",
    budgetMicros: 0,
    idempotencyKey: "root",
  });
  return { reports: new FakeReportStore(now, registry), root: { id: rec.id, generation: rec.generation, host: rec.host } };
}

export interface Harness {
  origin: FakeOrigin;
  broker: CaptureBroker;
  index: FakeCaptureIndex;
  parser: FakeCaptureParser;
  quota: FakeQuotaCounters;
  reports: FakeReportStore;
  rows: { agent: AgentId; payload: CaptureJournalPayload; key: string }[];
  logs: string[];
  clock: { t: number };
  generations: Map<AgentId, number>;
  deps: CaptureBrokerDeps;
  rebuild(over?: Partial<CaptureBrokerDeps>): CaptureBroker; // a second broker over the same stores (a pomtreed restart)
  close(): Promise<void>;
}

const anyScope: CaptureScope = { allows: () => true };

export async function harness(
  o: {
    config?: Partial<CaptureBrokerConfig>;
    scope?: CaptureScope;
    dns?: Record<string, string>; // host -> address, for SSRF tests (a private address is refused)
    fetch?: (base: FetchFn) => FetchFn;
    pace?: HostPace;
    deps?: Partial<CaptureBrokerDeps>;
    origin?: FakeOrigin;
  } = {},
): Promise<Harness> {
  const origin = o.origin ?? (await FakeOrigin.start());
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const index = new FakeCaptureIndex(now);
  const parser = new FakeCaptureParser();
  const quota = new FakeQuotaCounters();
  const { reports, root } = await rootedReports(now);
  const rows: Harness["rows"] = [];
  const logs: string[] = [];
  const generations = new Map<AgentId, number>([[AGENT, 1]]);
  const notFound = async (h: string): Promise<{ address: string; family: number }[]> => {
    if (o.dns?.[h] !== undefined) return [{ address: o.dns[h] as string, family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" });
  };
  const seam = testFetchSeam(origin.hostsMap(...HOSTS), { resolveDns: notFound });
  const deps: CaptureBrokerDeps = {
    index,
    parser,
    quota,
    reports,
    root: async () => root,
    generationOf: async (a) => generations.get(a) ?? null,
    scopeFor: async () => o.scope ?? anyScope,
    record: async (agent, payload, key) => {
      if (!rows.some((r) => r.key === key && r.agent === agent)) rows.push({ agent, payload, key });
    },
    log: (line) => logs.push(line),
    fetch: o.fetch ? o.fetch(seam.fetch) : seam.fetch,
    resolveDns: async (h) => (o.dns?.[h] !== undefined ? [{ address: o.dns[h] as string, family: 4 }] : seam.resolveDns(h)),
    hostId: "h1",
    pomtreedVersion: "test",
    now,
    config: {
      userAgent: UA,
      waitMs: 5_000,
      timeoutMs: 2_000,
      maxBytes: 1024 * 1024,
      freshness: { stableMs: 7 * 86_400_000, dailyMs: 86_400_000, liveMs: 600_000 },
      freshnessRules: [],
      denylist: [],
      quota: { requests: 100, windowMs: 3_600_000 },
      ...o.config,
    },
    ...(o.pace && { pace: o.pace }),
    ...o.deps,
  };
  const brokers: CaptureBroker[] = [];
  const rebuild = (over: Partial<CaptureBrokerDeps> = {}) => {
    const b = createCaptureBroker({ ...deps, ...over });
    brokers.push(b);
    return b;
  };
  const broker = rebuild();
  return {
    origin,
    broker,
    index,
    parser,
    quota,
    reports,
    rows,
    logs,
    clock,
    generations,
    deps,
    rebuild,
    close: async () => {
      parser.releaseHung();
      for (const b of brokers) await b.close();
      await origin.close();
    },
  };
}

export const agent = (generation = 1) => ({ kind: "agent" as const, agent: AGENT, generation });
export const req = (url: string, extra: Record<string, unknown> = {}) => ({ url, purpose: "test", ...extra });
