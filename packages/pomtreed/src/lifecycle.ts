import { createHash } from "node:crypto";
import type { AgentId, AgentRecord } from "@pomtree/core";
import { budgetExceedsParentMessage } from "./error-codes.ts";

export interface Limits {
  maxDepth: number; // root is depth 0; operator-spawned agents are depth 1
  maxChildren: number; // unreaped children per non-root parent
  zombieMs: number; // exited-but-unreaped longer than this raises an alert
  zombieSweepMs: number;
  rootCustodyMax: number; // exited results held for the operator because their parent chain is dead up to the root; past this many, each further delivery is also escalated as an alert
  watchdogSweepMs: number; // how often the watchdog ladder evaluates each running agent
  watchdogBlockedMs: number; // a legitimately-blocked agent (open escalation / in-flight tool call) is exempt from the stall ladder for this long
  watchdogIntensityWindowMs: number; // window over which kill_resume restarts count toward the intensity budget
  watchdogStableMs: number; // a healthy stretch this long resets the intensity budget to zero
  cronTickMs: number; // how often the cron driver evaluates every schedule
  cleanupSweepMs: number; // how often reaped root branches are pruned and their reports GC'd
  providerBackoffMs: number; // base delay for a retryable provider_error (jittered exponential backoff)
  maxProviderBackoffMs: number; // cap on the provider-failure backoff delay
  maxProviderRetries: number; // consecutive retries before failing with provider_error
  providerBreakerThreshold: number; // retryable provider errors within the window that open the shared breaker
  providerBreakerWindowMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 4,
  maxChildren: 8,
  zombieMs: 600_000,
  zombieSweepMs: 30_000,
  rootCustodyMax: 32,
  watchdogSweepMs: 30_000,
  watchdogBlockedMs: 30 * 60_000,
  watchdogIntensityWindowMs: 60 * 60_000,
  watchdogStableMs: 30 * 60_000,
  cronTickMs: 60_000,
  cleanupSweepMs: 60_000,
  providerBackoffMs: 5_000,
  maxProviderBackoffMs: 300_000,
  maxProviderRetries: 3,
  providerBreakerThreshold: 3,
  providerBreakerWindowMs: 60_000,
};

// Jittered exponential backoff for a retryable provider_error: base * 2^attempt, capped, then
// full jitter (the returned wait is in [0, ceiling]) so a fleet of agents does not retry in
// lockstep. `random` returns [0, 1).
export function providerBackoffMs(attempt: number, opts: { providerBackoffMs: number; maxProviderBackoffMs: number }, random: () => number): number {
  const ceiling = Math.min(opts.maxProviderBackoffMs, opts.providerBackoffMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

// A refusal the caller can act on; the API maps it to its HTTP status.
export class LifecycleError extends Error {
  status: number;
  extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Deterministic id: a retried spawn finds its original without a key lookup in the registry.
export function agentIdFor(parent: AgentId, key: string): AgentId {
  return `ag-${createHash("sha256").update(`${parent}\0${key}`).digest("hex").slice(0, 26)}`;
}

export function checkFanout(limits: Limits, s: { depth: number; liveChildren: number; isRoot: boolean }): void {
  if (s.depth > limits.maxDepth) throw new LifecycleError(409, `spawn depth ${s.depth} exceeds the limit of ${limits.maxDepth}`);
  // Root fan-out is bounded by admission control, not by this cap.
  if (!s.isRoot && s.liveChildren >= limits.maxChildren) {
    throw new LifecycleError(409, `parent already has ${s.liveChildren} unreaped children (limit ${limits.maxChildren})`);
  }
}

export function carve(requested: number | undefined, defaultMicros: number, available: number): number {
  // An explicit amount must be a non-negative safe integer (0 stays allowed); a negative or fractional carve would lower the parent's
  // consumed total and over-carve it.
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 0))
    throw new LifecycleError(400, "budgetMicros must be a non-negative safe integer");
  const want = requested ?? Math.min(defaultMicros, available);
  if (want > available) throw new LifecycleError(409, budgetExceedsParentMessage(want, available), { code: "budget_exceeds_parent" });
  if (requested === undefined && want <= 0) throw new LifecycleError(409, "parent has no budget left to carve");
  return want;
}

export const isDone = (a: Pick<AgentRecord, "state">) => a.state === "exited" || a.state === "reaped";

// Host resource exhaustion (disk full / SQLite out of space / engine resource errors). These are
// not agent faults: the daemon stops admitting and classifies the exit as `resource_exhaustion`.
export function isResourceError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOSPC" || code === "SQLITE_FULL" || code === "SQLITE_IOERR") return true;
  const msg = (e instanceof Error ? e.message : typeof e === "string" ? e : "").toLowerCase();
  return msg.includes("no space left on device") || msg.includes("database or disk is full") || msg.includes("disk i/o error") || msg.includes("sqlite_full");
}

export const unreaped = (children: AgentRecord[]) => children.filter((c) => c.state !== "reaped");

export function findZombies(exited: AgentRecord[], now: number, zombieMs: number, rootId: AgentId): AgentRecord[] {
  return exited.filter((a) => a.state === "exited" && a.parent !== null && a.parent !== rootId && now - a.updatedAt >= zombieMs);
}
