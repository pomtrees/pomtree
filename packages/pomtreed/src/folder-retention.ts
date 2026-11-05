import type { AgentId, AgentState } from "@pomtree/core";

// Pure decision logic for the workspace-folder sweep: which kept folders to evict, and why. No fs, no clock.
// A folder is kept on pause so a resume finds uncommitted edits; it is evicted when the agent is reaped, when a paused
// agent has been idle past the retention window, or (reaped first, oldest first) when the disk is short on space.
// Only `reaped` and `yielded` agents are ever candidates: a running, pending or admitted agent's folder is never evicted.

export interface FolderCandidate {
  agent: AgentId;
  state: AgentState;
  since: number; // epoch ms the agent entered its current state (reaped / yielded)
  busy?: boolean; // a live run, an in-flight resume or an admission holds the folder
}

export interface RetentionPolicy {
  idleMs: number; // paused agents idle at least this long are evicted; 0 disables idle eviction
  reapedGraceMs: number; // a reaped agent's folder is kept this long (0 = evict at the next sweep)
  minFreeBytes: number; // 0 disables the disk-pressure pass
}

export type EvictReason = "reaped" | "idle" | "disk_pressure";
export interface Eviction {
  agent: AgentId;
  reason: EvictReason;
}

export interface RetentionPlan {
  due: Eviction[]; // evict all of these now
  pressure: Eviction[]; // evict in order only while free space stays below minFreeBytes (re-measure after each)
}

export function planEvictions(candidates: FolderCandidate[], now: number, policy: RetentionPolicy, freeBytes: number | null): RetentionPlan {
  const due: Eviction[] = [];
  const reapedKept: FolderCandidate[] = [];
  const eligible = candidates.filter((c) => !c.busy && (c.state === "reaped" || c.state === "yielded"));
  for (const c of [...eligible].sort((a, b) => a.since - b.since || a.agent.localeCompare(b.agent))) {
    if (c.state === "reaped") {
      if (now - c.since >= policy.reapedGraceMs) due.push({ agent: c.agent, reason: "reaped" });
      else reapedKept.push(c);
    } else if (policy.idleMs > 0 && now - c.since >= policy.idleMs) due.push({ agent: c.agent, reason: "idle" });
  }
  const pressured = policy.minFreeBytes > 0 && freeBytes !== null && freeBytes < policy.minFreeBytes;
  // Under pressure the reaped folders still inside their grace go too, oldest first. Paused agents' folders are never
  // evicted early: they hold un-pushed work that a resume would otherwise lose.
  const pressure: Eviction[] = pressured ? reapedKept.map((c) => ({ agent: c.agent, reason: "disk_pressure" as const })) : [];
  return { due, pressure };
}
