import { SANDBOX_CAPABILITIES } from "@pomtree/core";
import type { SandboxCapability } from "@pomtree/core";
import { CLAUSE_IDS } from "./sandbox-conformance.ts";
import type { ClauseId, ClauseResult } from "./sandbox-conformance.ts";

// The suite floor's capability table: every capability the core declares is either exercised by named conformance clauses or
// explicitly deferred with a reason. A capability added to core without a row here fails `tsc` (the `satisfies` below), and the pure
// checks after the table fail a covered row that names a clause which does not exist, a deferral without a reason, and a backend
// that passes by declaring (or exercising) nothing.

export type CoverageEntry = { readonly clauses: readonly ClauseId[] } | { readonly deferred: string };

// Deferral reasons name the clause that would cover the capability and what is missing; no TODO tag is introduced for them.
const REACH =
  "would need a clause that reaches the sandbox from the host or the sandbox out to a listener and observes the result; no such clause exists, and the shared fake has no network to observe";
const EGRESS =
  "would need a clause that starts a sandbox with an egress policy and observes an allowed and a denied connection from inside it; no such clause exists, and the shared fake cannot observe a connection";
const ISOLATION =
  "would need a clause that observes the runtime class from inside the sandbox; only a real runtime (runsc or a VM) can show it, so it waits for a real-adapter lane";
const SECRETS =
  "would need a clause that delivers a secret and checks it reaches the process but not the image, template or list output; no such clause exists";

export const SANDBOX_CAPABILITY_COVERAGE = {
  terminal: { deferred: "would need a clause that opens a terminal on a started sandbox, writes a line and reads it back; not written yet" },
  connect: { clauses: ["channel-drop-throws"] },
  loopback: { clauses: ["loopback-stream"] },
  "files.put": { clauses: ["files-hash-mismatch", "files-partial-upload"] },
  "files.get": { clauses: ["files-hash-mismatch"] },
  "files.volume": { deferred: "would need a clause that stores a file in a volume, stops the sandbox and reads it back from a new one; not written yet" },
  "mounts.host": {
    deferred:
      "would need a clause that mounts a host path and sees a write on both sides; local-family adapters only, and the clause registry has no local-only gate yet",
  },
  "image.ociPull": {
    deferred:
      "would need a clause that pulls an OCI reference and starts from it; needs a registry-reachable reference the descriptor can supply (imageRef is the only hook today)",
  },
  "image.template": { deferred: "would need a clause that prepares a template and starts a sandbox from it; not written yet" },
  "image.digestAttest": {
    deferred: "would need a clause that checks the attested digest equals the digest the sandbox ran; resolve-digest checks stability only, not attestation",
  },
  // TODO(conformance-snapshot): no snapshot clause exists yet (create, start-from, fork); current behavior: a backend declaring these
  // passes the floor through this deferral and its snapshot facet is not exercised by any clause.
  "snapshot.disk": { deferred: "no snapshot clause yet, tracked as conformance-snapshot" },
  "snapshot.memory": { deferred: "no snapshot clause yet, tracked as conformance-snapshot" },
  fork: { deferred: "no snapshot clause yet, tracked as conformance-snapshot" },
  pause: { deferred: "would need a clause that pauses a running sandbox and resumes it with its state; not written yet" },
  // list-by-owner checks the filtering result (own, unlabelled, other store, newer epoch); whether the provider filtered server side is
  // not observable through the port, so the clause is the whole observable contract of the capability.
  "list.byTag": { clauses: ["list-by-owner"] },
  "egress.denyAll": { deferred: EGRESS },
  "egress.allowHost": { deferred: EGRESS },
  "egress.allowCidr": { deferred: EGRESS },
  "reach.outbound": { deferred: REACH },
  "reach.exposedPort": { deferred: REACH },
  "reach.hostAlias": { deferred: REACH },
  "secrets.env": { deferred: SECRETS },
  "secrets.proxySwap": {
    deferred:
      "would need a clause that shows the sandbox sees a placeholder while the provider proxy sends the real secret; needs a provider-side observer, so it waits for the provider stub",
  },
  "resources.limits": {
    deferred: "would need a clause that reads the enforced cpu, memory and pids limits from inside the sandbox; the shared fake cannot observe them",
  },
  "isolation.gvisor": { deferred: ISOLATION },
  "isolation.microvm": { deferred: ISOLATION },
  "lease.extend": { deferred: "would need a clause that extends the lease and sees the deadline move; not written yet" },
} as const satisfies Record<SandboxCapability, CoverageEntry>;

export type CapabilityTable = Partial<Record<SandboxCapability, CoverageEntry>>;

// Findings (each names cause and action) for the table itself: a missing row, a covered row with no or unknown clause ids, a
// deferral with a blank reason. [] = the table satisfies the floor.
export function coverageTableFindings(table: CapabilityTable, clauseIds: readonly string[] = CLAUSE_IDS): string[] {
  const out: string[] = [];
  for (const c of SANDBOX_CAPABILITIES) {
    const row = table[c];
    if (row === undefined) {
      out.push(`capability ${c} has no row in the coverage table; list the clauses that exercise it, or defer it with a reason`);
    } else if ("deferred" in row) {
      if (row.deferred.trim() === "") {
        out.push(`capability ${c} is deferred without a reason; say why no clause covers it (and the tag that tracks it), or add a clause`);
      }
    } else if (row.clauses.length === 0) {
      out.push(`capability ${c} is covered by no clause ids; list the clauses that exercise it, or defer it with a reason`);
    } else {
      for (const id of row.clauses) {
        if (!clauseIds.includes(id)) out.push(`capability ${c} names clause ${id}, which is not in the clause registry; fix the id or add the clause`);
      }
    }
  }
  return out;
}

// Findings for one run: the backend must have actually exercised something, and every capability it declares must be deferred in
// the table or have at least one of its clauses passed. A skipped or gated clause does not count, so declaring a capability and
// skipping or gating its only clause is caught; `declared` should be the effective set (declared, narrowed by the probe).
export function suiteFloorFindings(input: {
  name: string;
  declared: Iterable<SandboxCapability>;
  results: readonly ClauseResult[];
  table: CapabilityTable;
  // The clauses the run registered; the declaration and probe checks are results too but are not clauses and prove nothing here.
  clauseIds: readonly string[];
}): string[] {
  const { name, table } = input;
  const results = input.results.filter((r) => input.clauseIds.includes(r.id));
  const out: string[] = [];
  const ran = new Set(results.filter((r) => r.status === "passed").map((r) => r.id));
  if (ran.size === 0) {
    out.push(
      `backend ${name} ran no clause: every check was skipped or gated, or none was registered; declare its capabilities and register the clauses, so the run proves something`,
    );
  }
  for (const c of input.declared) {
    const row = table[c];
    if (row === undefined) {
      out.push(`backend ${name} declares ${c}, which has no row in the coverage table; add a row, or defer it with a reason`);
    } else if (!("deferred" in row) && !row.clauses.some((id) => ran.has(id))) {
      out.push(`backend ${name} declares ${c}, but none of its clauses (${row.clauses.join(", ")}) passed; run them, or declare ${c} false`);
    }
  }
  return out;
}

// Capabilities the table defers, in core's order, and the table-wide counts the floor prints.
export function deferredCapabilities(table: CapabilityTable = SANDBOX_CAPABILITY_COVERAGE): SandboxCapability[] {
  return SANDBOX_CAPABILITIES.filter((c) => {
    const row = table[c];
    return row !== undefined && "deferred" in row;
  });
}

export function coverageCounts(table: CapabilityTable = SANDBOX_CAPABILITY_COVERAGE): { covered: number; deferred: number } {
  const deferred = deferredCapabilities(table).length;
  return { covered: SANDBOX_CAPABILITIES.filter((c) => table[c] !== undefined).length - deferred, deferred };
}

// Ceiling on deferred capabilities: lower it as clauses land; raising it requires a reason in the commit that raises it.
// TODO(conformance-deferral-ceiling): most capabilities are deferred in this table (the ceiling below is the count); lower it as clauses land.
// Also open: `probe-subset` is redundant with `probe-widening-fails`, `files-hash-mismatch` overlaps `files-partial-upload`, `list.byTag` counts as
// covered by the owner-listing clause, and the shared fake stamps no host or generation so its listing-tag checks are optional.
export const MAX_DEFERRED_CAPABILITIES = 22;

export function deferralCeilingFindings(table: CapabilityTable = SANDBOX_CAPABILITY_COVERAGE, max = MAX_DEFERRED_CAPABILITIES): string[] {
  const n = deferredCapabilities(table).length;
  return n > max
    ? [
        `${n} capabilities are deferred, above the ceiling of ${max}; add the clause that covers the new deferral, or raise MAX_DEFERRED_CAPABILITIES with a stated reason`,
      ]
    : [];
}
