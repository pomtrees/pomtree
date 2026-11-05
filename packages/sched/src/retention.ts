import { JOURNAL_PRUNABLE_KINDS } from "@pomtree/core";

export interface JournalRetentionPolicy {
  retentionMs: number; // <= 0 disables pruning
  keepPerAgent: number;
  protectKinds?: string[];
}

export interface JournalRetentionPlan {
  olderThanMs: number;
  keepPerAgent: number;
  kinds: string[];
  protectKinds: string[];
}

// Pure: turns a policy into pruneJournal options, or null when retention is off. Audit kinds are
// never listed in `kinds`; `protectKinds` can only narrow the default prunable set further.
export function planJournalRetention(p: JournalRetentionPolicy): JournalRetentionPlan | null {
  if (!Number.isFinite(p.retentionMs) || p.retentionMs <= 0) return null;
  const protectKinds = [...new Set(p.protectKinds ?? [])];
  return {
    olderThanMs: p.retentionMs,
    keepPerAgent: Number.isFinite(p.keepPerAgent) ? Math.max(0, Math.floor(p.keepPerAgent)) : 0,
    kinds: JOURNAL_PRUNABLE_KINDS.filter((k) => !protectKinds.includes(k)),
    protectKinds,
  };
}
