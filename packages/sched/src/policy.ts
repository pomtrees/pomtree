import type { MissedPolicy, OverlapPolicy, Schedule } from "@pomtree/core";

export type { MissedPolicy, OverlapPolicy, Schedule };

export const DEFAULT_MAX_CATCH_UP = 100;

export function taskKey(scheduleId: string, scheduledAt: number): string {
  return `${scheduleId}@${new Date(scheduledAt).toISOString()}`;
}

// FNV-1a over the id: stable across restarts and hosts, no randomness.
export function jitterFor(scheduleId: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < scheduleId.length; i++) {
    h ^= scheduleId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % maxMs;
}

export type OverlapDecision = "start" | "skip" | "queue";

export function onFire(policy: OverlapPolicy, previousStillRunning: boolean): OverlapDecision {
  return previousStillRunning ? policy : "start";
}
