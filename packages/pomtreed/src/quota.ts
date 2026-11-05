// Shared helpers over core QuotaCounters for pomtreed's web acquisition quotas (ext-gateway.ts web_fetch/web_search, the workflow
// fetch request budget, the capture broker, host-pacer.ts). The scope names are the one definition both the producer and any reader (an audit, a test)
// use. Pure.
import type { QuotaCounters } from "@pomtree/core";

export const QUOTA_SCOPES = {
  webCalls: "web_fetch.calls", // key agent id, window webfetch.windowMs: web_fetch and web_search calls admitted (one shared bucket)
  webBytes: "web_fetch.bytes", // key agent id, window 0 (lifetime): response bytes charged plus in-flight reservations
  workflowFetchRequests: "workflow.fetch.requests", // key `<task>:<generation>`, window 0: requests sent against maxRequests
  workflowFetchCalls: "workflow.fetch.calls", // key `<task>:<generation>`, window 0: fetch calls made (the audit row's ordinal)
  // key registrable domain, window = one slot of workflow.fetch.minIntervalMs: 1 when the slot is taken. ONE scope for every fetch path
  // (agent web_fetch, workflow fetch and every capture broker rung: robots.txt, origin, Wayback, official API), so they share slots.
  domainPace: "fetch.domain_pace",
  captureRequests: "capture.requests", // key requester agent id, window capture.quota.windowMs: capture requests admitted (cache hits too)
} as const;

// The fixed window `t` falls in (windowMs > 0).
export const windowStart = (t: number, windowMs: number): number => Math.floor(t / windowMs) * windowMs;

// Process-local QuotaCounters with the store's semantics, the fallback when a caller injects no durable counters (unit tests and
// library use). main.ts injects the store-sqlite QuotaCounters into createExtGateway, the workflow capability services and
// hostPacer, so the running daemon's quotas survive a restart (SPEC rule 6); only an uninjected caller resets on restart.
// TODO(durable-quota): this fallback duplicates FakeQuotaCounters in @pomtree/testing; remove it once every caller injects counters.
export function memoryQuotaCounters(): QuotaCounters {
  const m = new Map<string, number>();
  const id = (scope: string, key: string, w: number) => JSON.stringify([scope, key, w]);
  const check = (...ns: number[]) => {
    for (const n of ns) if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`quota amounts and limits must be non-negative safe integers (got ${n})`);
  };
  return {
    take(scope, key, w, amount, limit) {
      check(amount, limit);
      const used = m.get(id(scope, key, w)) ?? 0;
      if (used + amount > limit) return { ok: false, used };
      m.set(id(scope, key, w), used + amount);
      return { ok: true, used: used + amount };
    },
    give(scope, key, w, amount) {
      check(amount);
      const next = Math.max(0, (m.get(id(scope, key, w)) ?? 0) - amount);
      m.set(id(scope, key, w), next);
      return next;
    },
    peek: (scope, key, w) => m.get(id(scope, key, w)) ?? 0,
  };
}
