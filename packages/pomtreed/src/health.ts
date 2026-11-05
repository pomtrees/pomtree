// Pure readiness evaluation for GET /readyz (liveness is /healthz: the process answers, nothing more).
// Served on the operator unix socket ONLY (mode 0600): never on the agent, host or UI TCP listeners, so an agent
// container or a browser network cannot probe it. The body names booleans and a short reason, never ids or secrets.

export interface ReadinessInput {
  /** The store answered a read (doctor() listing agents succeeded). */
  storeOpen: boolean;
  /** The sandbox (Docker) list call succeeded and the daemon has not latched it down. */
  sandboxUp: boolean;
  /** Journal writes failed / the SQLite degraded latch is set (writes are being refused). */
  journalFailed: boolean;
  degraded: boolean;
}

// Egress audit spool pressure (TODO(audit-spool-cap-dos)). Informational only: the cap itself already refuses new audited-public sandboxes,
// so nearing it is reported and logged, never a readiness reason (audit-unavailable likewise only closes public admission, not readiness).
export interface EgressAuditStatusLike {
  quarantined: string[];
  retention?: { spools: number; max: number; closed: number; open: string[] };
}
export interface EgressAuditReport {
  quarantined: number;
  retention?: { spools: number; max: number; closed: number; open: number };
  nearCap: boolean;
}

/** Spools that keep counting toward the cap with no automatic exit: never closed, or quarantined (quarantined are normally also open). */
export function stuckSpools(s: EgressAuditStatusLike): number {
  return new Set([...(s.retention?.open ?? []), ...s.quarantined]).size;
}

/** Alert threshold derived from the cap: two slots of headroom. Without a reader cap there is nothing to approach. */
export function nearCap(s: EgressAuditStatusLike): boolean {
  return s.retention !== undefined && stuckSpools(s) >= s.retention.max - 2;
}

/** The /readyz `egressAudit` field: counts only, no ids (the cap-refusal message and the operator procedure name the ids). */
export function egressAuditReport(s: EgressAuditStatusLike): EgressAuditReport {
  const { retention } = s;
  return {
    quarantined: s.quarantined.length,
    ...(retention && { retention: { spools: retention.spools, max: retention.max, closed: retention.closed, open: retention.open.length } }),
    nearCap: nearCap(s),
  };
}

/** One log line per transition into or out of near-cap, none while it is unchanged. */
export function nearCapTransition(prev: boolean, s: EgressAuditStatusLike): { nearCap: boolean; line?: string } {
  const now = nearCap(s);
  if (now === prev) return { nearCap: now };
  if (!now) return { nearCap: now, line: "pomtreed: egress audit spool pressure cleared" };
  const max = s.retention?.max ?? 0;
  return {
    nearCap: now,
    line: `pomtreed: egress audit spools nearing the cap (${stuckSpools(s)} never-closed or quarantined of ${max}); new audited-public sandboxes are refused at the cap; see the operator procedure above egressSpoolRetention in sandbox-docker audit.ts`,
  };
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

export function evaluateReadiness(i: ReadinessInput, opts: { allowSandboxDown?: boolean } = {}): Readiness {
  const reasons: string[] = [];
  if (!i.storeOpen) reasons.push("store unavailable");
  if (i.journalFailed || i.degraded) reasons.push("store degraded");
  if (!i.sandboxUp && !opts.allowSandboxDown) reasons.push("sandbox unavailable");
  return { ready: reasons.length === 0, reasons };
}
