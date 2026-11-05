// capacity.maxSessions: `auto` (default) or a positive integer. Pure; main.ts supplies host facts once at startup.

import { POMTREED_KINDS } from "@pomtree/core";

// Why AUTO is capped at 16: the binding limits at scale are provider rate limits and spend, not machine
// capacity (agents mostly wait on the model API). An explicit integer bypasses this cap.
export const AUTO_SESSIONS_HARD_MAX = 16;
// Agents mostly block on the model API, so CPU is oversubscribed relative to the per-container `--cpus` limit.
export const AUTO_CPU_OVERSUB = 3;
export const AUTO_MIN_SESSIONS = 2;

export interface AutoSessionsInput {
  cpus: number;
  memTotalBytes: number;
  memFreeBytes?: number; // informational; the memory bound uses total (a reservation, not a snapshot)
  containerMemBytes: number;
  containerCpus: number;
  memFraction: number;
  maxContainers: number;
  oversub?: number; // default AUTO_CPU_OVERSUB
  hardMax?: number; // default AUTO_SESSIONS_HARD_MAX
}

export function autoMaxSessions(i: AutoSessionsInput): number {
  const oversub = i.oversub ?? AUTO_CPU_OVERSUB;
  const hardMax = i.hardMax ?? AUTO_SESSIONS_HARD_MAX;
  const byMem = (i.memFraction * i.memTotalBytes) / i.containerMemBytes;
  const byCpu = (i.cpus / i.containerCpus) * oversub;
  const raw = Math.floor(Math.min(byMem, byCpu, i.maxContainers, hardMax));
  const ceiling = Math.max(1, Math.min(i.maxContainers, hardMax));
  const n = Number.isFinite(raw) ? raw : AUTO_MIN_SESSIONS;
  return Math.min(ceiling, Math.max(Math.min(AUTO_MIN_SESSIONS, ceiling), n));
}

export type MaxSessions = { value: number; mode: "auto" | "manual" };

// The session cap from capacity.maxSessions, which the registry has already checked is `auto` or a positive integer.
export function maxSessionsOf(value: string, auto: () => number): MaxSessions {
  return value === "auto" ? { value: auto(), mode: "auto" } : { value: Number(value), mode: "manual" };
}

// Pending-reason strings (journaled as ext.pomtreed.pending_reason and shown wherever a pending agent is listed).
export const PENDING_REASON_KIND = POMTREED_KINDS.pendingReason;
export const pendingReasons = {
  slot: (used: number, max: number) => `waiting for a session slot (${used} of ${max} in use)`,
  memory: "memory gate",
  disk: "disk gate",
  containers: "container limit",
  sandboxDown: "sandbox down",
  draining: "draining",
  degraded: (until: number) => `provider degraded (breaker open until ${new Date(until).toISOString().slice(11, 19)}Z)`,
  host: "host unhealthy (journal/store)",
};

// Maps a resourceGate refusal reason to a short pending reason.
export function gateReason(reason: string | undefined): string {
  const r = reason ?? "";
  if (/disk/i.test(r)) return pendingReasons.disk;
  if (/memory/i.test(r)) return pendingReasons.memory;
  if (/sandbox/i.test(r)) return pendingReasons.sandboxDown;
  if (/container limit/i.test(r)) return pendingReasons.containers;
  return r || "resource gate";
}
