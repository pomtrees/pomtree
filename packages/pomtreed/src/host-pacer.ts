// Per-site request pacing for every fetch path (registry key workflow.fetch.minIntervalMs): agent web_fetch, the workflow fetch
// capability and every capture broker rung share one pacer: two sends to one registrable
// domain (registrable-domain.ts: data.sec.gov and www.sec.gov share sec.gov's bucket) are at least `minIntervalMs` apart, across
// every workflow and task on this daemon and across a daemon restart. Time is cut into slots of `minIntervalMs`; a send claims the
// first free slot that starts at or after now in QuotaCounters (scope QUOTA_SCOPES.domainPace, key the domain, window the slot start, limit
// 1) and waits until that slot starts, so sends to one domain go at distinct slot starts. The claim is synchronous before the wait,
// so concurrent callers queue in call order and never share a slot. A send between slot starts waits for the next one (at most one
// interval), and a slot is not handed back when its caller is aborted while waiting: both err toward slower, never faster. A send
// whose timer fires late re-books the slots up to its real wake time plus an interval, so a later claim is spaced from the actual
// send; only a caller that had already claimed the next slot before the late wake can sit closer, by that lateness.
import { setTimeout as delay } from "node:timers/promises";
import type { QuotaCounters } from "@pomtree/core";
import { memoryQuotaCounters, QUOTA_SCOPES } from "./quota.ts";
import { registrableDomain } from "./registrable-domain.ts";

// `opId` (optional): a claim a crash replay could repeat (a broker step) passes an id derived from the job and the step, so a replayed
// claim of the same slot is applied once (core QuotaCounters.take opId).
export type HostPace = (host: string, signal?: AbortSignal, opId?: string) => Promise<void>;

export interface HostPacerDeps {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; // rejects when the signal aborts
  // Durable slot claims. Absent: process-local counters (TODO(durable-quota) in quota.ts), so a restart starts every domain unpaced.
  quota?: QuotaCounters;
}

// Undefined when pacing is off (minIntervalMs 0): the caller sends unpaced.
export function hostPacer(minIntervalMs: number, deps: HostPacerDeps = {}): HostPace | undefined {
  if (!(minIntervalMs > 0)) return undefined;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, signal ? { signal } : {}));
  const quota = deps.quota ?? memoryQuotaCounters();
  return async (host, signal, opId) => {
    const key = registrableDomain(host);
    const t = now();
    let slot = Math.ceil(t / minIntervalMs) * minIntervalMs;
    while (!quota.take(QUOTA_SCOPES.domainPace, key, slot, 1, 1, opId).ok) slot += minIntervalMs;
    if (slot > t) await sleep(slot - t, signal);
    // Pace on the actual wake time: a timer that fired late (event-loop lag) also books every still-free slot that starts before
    // wake + interval, so the next send claimed after this one is at least an interval after it, not after the booked slot. A slot
    // another caller already holds is left to it (claimed earlier, it is not moved): that concurrent case keeps the lateness bound.
    const woke = now();
    for (let next = slot + minIntervalMs; next < woke + minIntervalMs; next += minIntervalMs)
      if (!quota.take(QUOTA_SCOPES.domainPace, key, next, 1, 1, opId === undefined ? undefined : `${opId}:late`).ok) break;
  };
}
