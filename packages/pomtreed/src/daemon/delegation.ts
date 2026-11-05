// Delegation is narrowing only: a non-root spawn is refused when the child's effective egress or resource limits exceed its
// parent's (the operator, the root parent, is unbounded). Pure: no fs, Docker or clock. spawnNow (lifecycle.ts) calls it with the
// persisted parent spec and the child's resolved spec; budget is bounded separately by `carve`.
import type { EgressPolicy, SpawnSpec } from "@pomtree/core";

export type EgressGrant = { egress: EgressPolicy; envManifestHash: string | null };

// Conservative "child is no wider than parent" (refuses when unsure; manifests are not resolved at spawn):
//   none      within anything; nothing but none within none (a none parent has no relay, so even a relay-only child widens it)
//   registry  within registry iff the child's manifest hash is null or equal to the parent's; within allowlist iff the hash is null
//   allowlist within allowlist iff every host is in the parent's; within registry iff its host list is empty
//   anything within audited-public; audited-public within only audited-public
export function egressWithin(child: EgressGrant, parent: EgressGrant): boolean {
  const c = child.egress;
  const p = parent.egress;
  if (c.kind === "none") return true;
  if (p.kind === "none") return false;
  if (p.kind === "audited-public") return true;
  if (c.kind === "audited-public") return false;
  if (c.kind === "registry")
    return p.kind === "registry" ? child.envManifestHash === null || child.envManifestHash === parent.envManifestHash : child.envManifestHash === null;
  // c is an allowlist
  if (p.kind === "allowlist") return c.hosts.every((h) => p.hosts.includes(h));
  return c.hosts.length === 0;
}

export type ResourceField = "memoryBytes" | "cpus" | "shmBytes" | "diskBytes";
export const RESOURCE_FIELDS: readonly ResourceField[] = ["memoryBytes", "cpus", "shmBytes", "diskBytes"];

// What a field means when a spec leaves it unset, where pomtreed knows it: memory falls back to capacity.containerMemoryBytes. The
// other fields' unset meaning is the sandbox adapter's own (cpus 2, shm docker's, disk unbounded), unknown here.
export type ResourceDefaults = { memoryBytes?: number };

// The first field of the child that exceeds the parent's, or null. A parent field with no known limit does not bound it; a parent
// limit with the child unset is exceeded (the unset child is unbounded or runs at a default pomtreed cannot compare).
export function resourcesExceeded(child: SpawnSpec, parent: SpawnSpec, defaults: ResourceDefaults = {}): ResourceField | null {
  for (const f of RESOURCE_FIELDS) {
    const limit = parent[f] ?? defaults[f as keyof ResourceDefaults];
    if (limit === undefined) continue;
    const mine = child[f] ?? defaults[f as keyof ResourceDefaults];
    if (mine === undefined || mine > limit) return f;
  }
  return null;
}

export function describeEgress(e: EgressPolicy): string {
  return e.kind === "allowlist" ? `allowlist [${e.hosts.join(", ")}]` : e.kind;
}

function fixFor(template: string | null): string {
  return template === null
    ? "spawn it from the operator, or have the operator set agent.untemplatedEgress=none"
    : `the operator must spawn template ${template} itself, or choose a template whose egress is within the parent's`;
}

// null when the child is within the parent; otherwise the refusal text, naming the cause and the action. `template` is null for
// an untemplated child.
export function delegationProblem(child: SpawnSpec, parent: SpawnSpec | undefined, template: string | null, defaults: ResourceDefaults = {}): string | null {
  // A parent record with no persisted egress reads as none (fail closed).
  const parentEgress: EgressPolicy = parent?.egress ?? { kind: "none" };
  if (
    !egressWithin({ egress: child.egress, envManifestHash: child.envManifestHash }, { egress: parentEgress, envManifestHash: parent?.envManifestHash ?? null })
  )
    return `spawn refused: the child's egress ${describeEgress(child.egress)} exceeds the parent's egress ${describeEgress(parentEgress)} (a child may only narrow its parent's network reach); ${fixFor(template)}`;
  if (!parent) return null;
  const f = resourcesExceeded(child, parent, defaults);
  if (f === null) return null;
  const mine = child[f] ?? defaults[f as keyof ResourceDefaults];
  const theirs = parent[f] ?? defaults[f as keyof ResourceDefaults];
  const state = mine === undefined ? "unset (unbounded or a default this daemon cannot compare)" : String(mine);
  const fix =
    template === null
      ? "spawn it from the operator, or use a template that sets it within the parent's limit"
      : `the operator must spawn template ${template} itself, or choose a template that sets ${f} at or below the parent's`;
  return `spawn refused: the child's ${f} ${state} exceeds the parent's ${f} ${theirs} (a child may only narrow its parent's resource limits); ${fix}`;
}
