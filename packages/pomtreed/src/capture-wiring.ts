// The one composition of a capture broker over a daemon's stores, shared by main.ts and the in-process runtimes the examples build
// (examples/hn-digest/runtime.mts, a domain example's live-round runtime), so every runtime that fetches gets the same
// robots.txt, cache, pacing and provenance and none keeps a direct path. Config values not given are the registry defaults.
import type { AgentId, CaptureIndex, HostId, QuotaCounters, ReportStore } from "@pomtree/core";
import { CONFIG_DEFAULTS, parseFreshnessRules } from "@pomtree/core";
import { createCaptureBroker } from "./capture/broker.ts";
import { ProcessCaptureParser } from "./capture/process-parser.ts";
import type { CaptureBroker, CaptureBrokerConfig, CaptureBrokerDeps, CaptureJournalPayload, CaptureScope } from "./capture/types.ts";
import type { FetchFn } from "./ext-gateway.ts";
import type { HostPace } from "./host-pacer.ts";

export interface CaptureWiring {
  stores: { captures: CaptureIndex; registry: { get(id: AgentId): Promise<{ generation: number } | null> } };
  quota: QuotaCounters;
  reports: ReportStore;
  daemon: {
    root(): Promise<{ id: AgentId; generation: number; host: HostId }>;
    captureRecord(agent: AgentId, payload: CaptureJournalPayload, key: string): Promise<void>;
  };
  hostId: HostId;
  userAgent: string; // workflow.fetch.userAgent
  log: (line: string) => void;
  config?: Partial<Omit<CaptureBrokerConfig, "userAgent">>;
  // The request scope of a requester that passes none. Default: the operator any public host, an agent none (a workflow fetch
  // always passes its capability scope; main.ts passes web_fetch's).
  scopeFor?: CaptureBrokerDeps["scopeFor"];
  pace?: HostPace;
  fetch?: FetchFn;
  resolveDns?: (h: string) => Promise<{ address: string; family: number }[]>;
  pomtreedVersion?: string;
}

const NONE: CaptureScope = { allows: () => false };
const ANY: CaptureScope = { allows: () => true };

// The registry defaults of the broker's config keys.
export function defaultCaptureConfig(): Omit<CaptureBrokerConfig, "userAgent"> {
  return {
    waitMs: CONFIG_DEFAULTS["capture.waitMs"],
    timeoutMs: CONFIG_DEFAULTS["capture.timeoutMs"],
    maxBytes: CONFIG_DEFAULTS["capture.maxBytes"],
    freshness: {
      stableMs: CONFIG_DEFAULTS["capture.freshness.stableMs"],
      dailyMs: CONFIG_DEFAULTS["capture.freshness.dailyMs"],
      liveMs: CONFIG_DEFAULTS["capture.freshness.liveMs"],
    },
    freshnessRules: parseFreshnessRules(CONFIG_DEFAULTS["capture.freshness.rules"]),
    denylist: CONFIG_DEFAULTS["capture.denylist"],
    quota: { requests: CONFIG_DEFAULTS["capture.quota.requests"], windowMs: CONFIG_DEFAULTS["capture.quota.windowMs"] },
  };
}

export function wireCaptureBroker(w: CaptureWiring): CaptureBroker {
  return createCaptureBroker({
    index: w.stores.captures,
    // TODO(capture-broker): S2 replaces this with the agent-image capture worker (parse-only mode)
    parser: new ProcessCaptureParser(),
    quota: w.quota,
    ...(w.pace && { pace: w.pace }),
    reports: w.reports,
    root: async () => {
      const r = await w.daemon.root();
      return { id: r.id, generation: r.generation, host: r.host };
    },
    generationOf: async (agent) => (await w.stores.registry.get(agent))?.generation ?? null,
    scopeFor: w.scopeFor ?? (async (who) => (who.kind === "operator" ? ANY : NONE)),
    record: (agent, payload, key) => w.daemon.captureRecord(agent, payload, key),
    log: w.log,
    ...(w.fetch && { fetch: w.fetch }),
    ...(w.resolveDns && { resolveDns: w.resolveDns }),
    hostId: w.hostId,
    pomtreedVersion: w.pomtreedVersion ?? "unknown",
    config: { ...defaultCaptureConfig(), ...w.config, userAgent: w.userAgent },
  });
}
