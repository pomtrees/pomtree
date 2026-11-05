// Pure state-access policy: operator configuration (POMTREED_STATE_GRANTS, POMTREED_STATE_LIMITS), delegation-safe grant algebra and the
// per-request decision. No fs, sockets or store coupling; every lookup (registry, templates) is injected.
import { checkStatePrefix, parseStateLimits, POMTREED_KINDS, STATE_OWNER_RE } from "@pomtree/core";
import type { AgentId, AgentRecord, ExtensionJournalPayload, StateLimits, StateOpJournalPayload } from "@pomtree/core";

// parseStateLimits (POMTREED_STATE_LIMITS) lives in core so standalone tools apply the same quotas; re-exported for the daemon's callers.
export { parseStateLimits };

export type StateMode = "r" | "rw";
// A grant names an owner, optionally narrowed to keys starting with `prefix` (a plain string prefix, so "memo/" covers memo/x and
// "memo" also covers "memory/x"), at read or read-write.
export interface StateGrant {
  owner: string;
  prefix?: string;
  mode: StateMode;
}
export type StateGrants = readonly StateGrant[];
// The operator (and the root supervisor acting for it) holds every grant; everyone else holds an explicit list. Default is deny.
export type StatePrincipal = { operator: true } | { grants: StateGrants };
export type StateVerb = "read" | "write";

// The extension-wide key scope of ctx.workflow.shared (workflow-capabilities buildRunOps). Only the extension's own workflows that
// declare `sharedStore: rw` and the operator write there: a record under it is trusted as workflow- or operator-written.
export const SHARED_SCOPE = "ext/s/";
// Whether a key or key prefix reaches the shared scope: it lies inside it, or ("" included) contains it.
export const reachesShared = (keyOrPrefix: string): boolean => keyOrPrefix.startsWith(SHARED_SCOPE) || SHARED_SCOPE.startsWith(keyOrPrefix);

const DRIVER_KEY = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/;
const TEMPLATE_KEY = /^[a-z0-9][a-z0-9_-]*$/;
const RANK: Record<StateMode, number> = { r: 1, rw: 2 };
const MAX_CHAIN = 64;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${name} JSON`);
  }
}

// `POMTREED_STATE_GRANTS`: {"<driver (ext/workflow) or template id>": [{owner, prefix?, mode: "r"|"rw"}]}. Malformed input throws (the
// daemon refuses to start). Container agents run from a template and are read-only (F2): a template key may not hold "rw". No
// grant may name the shared scope for writing: an rw grant whose prefix overlaps SHARED_SCOPE is refused. A whole-owner rw grant (no
// prefix) is kept, since it is the ordinary way to grant an owner; the /v1/state route refuses every agent write under the scope
// anyway (state-routes). Read grants there stay allowed: reading the shared scope forges nothing.
export function parseStateGrants(raw = "{}"): Map<string, StateGrant[]> {
  const value = parseJson("POMTREED_STATE_GRANTS", raw.trim() === "" ? "{}" : raw);
  if (!isPlain(value)) throw new Error("POMTREED_STATE_GRANTS must map drivers or templates to grant arrays");
  const out = new Map<string, StateGrant[]>();
  for (const [key, list] of Object.entries(value)) {
    const driver = DRIVER_KEY.test(key);
    if (!driver && !TEMPLATE_KEY.test(key)) throw new Error(`POMTREED_STATE_GRANTS: invalid driver or template id ${JSON.stringify(key)}`);
    if (!Array.isArray(list)) throw new Error(`POMTREED_STATE_GRANTS: grants for ${key} must be an array`);
    const grants: StateGrant[] = [];
    for (const g of list) {
      if (!isPlain(g) || Object.keys(g).some((k) => k !== "owner" && k !== "prefix" && k !== "mode"))
        throw new Error(`POMTREED_STATE_GRANTS: malformed grant for ${key}`);
      if (typeof g.owner !== "string" || !STATE_OWNER_RE.test(g.owner)) throw new Error(`POMTREED_STATE_GRANTS: invalid owner for ${key}`);
      if (g.mode !== "r" && g.mode !== "rw") throw new Error(`POMTREED_STATE_GRANTS: mode for ${key} must be "r" or "rw"`);
      if (!driver && g.mode === "rw") throw new Error(`POMTREED_STATE_GRANTS: template ${key} may not hold rw (container agents are read-only)`);
      if (g.prefix !== undefined) {
        try {
          checkStatePrefix(g.prefix);
        } catch {
          throw new Error(`POMTREED_STATE_GRANTS: invalid prefix for ${key}`);
        }
      }
      if (g.mode === "rw" && typeof g.prefix === "string" && g.prefix !== "" && reachesShared(g.prefix))
        throw new Error(
          `POMTREED_STATE_GRANTS: ${key} holds rw on ${g.owner} prefix ${JSON.stringify(g.prefix)}, which overlaps the workflow-shared scope ${SHARED_SCOPE}: only the extension's workflows (sharedStore: rw) and the operator write there; grant "r" or a prefix outside ${SHARED_SCOPE}`,
        );
      grants.push({ owner: g.owner, ...(g.prefix !== undefined && { prefix: g.prefix as string }), mode: g.mode });
    }
    out.set(key, grants);
  }
  return out;
}

// The key a registry record is granted under: a deterministic task by its driver, a container agent by its template.
export function grantKeyOf(rec: AgentRecord): string {
  return rec.executor === "deterministic" ? rec.spec.driver : (rec.spec.template ?? "code");
}

// Whether `g` is covered by a single grant in `parent`: same owner, a key range inside it, no more privilege.
const covered = (g: StateGrant, parent: StateGrants): boolean =>
  parent.some((p) => p.owner === g.owner && (g.prefix ?? "").startsWith(p.prefix ?? "") && RANK[g.mode] <= RANK[p.mode]);

// Child grants are a subset of the parent's when each is covered by one parent grant. Conservative: a child grant that only the
// union of several parent grants would cover is refused.
export function grantSubset(child: StateGrants, parent: StateGrants): boolean {
  return child.every((g) => covered(g, parent));
}

// The grants held under both lists: same owner, the narrower prefix when one contains the other (disjoint prefixes drop), the lower mode.
export function intersectGrants(a: StateGrants, b: StateGrants): StateGrant[] {
  const out: StateGrant[] = [];
  for (const x of a)
    for (const y of b) {
      if (x.owner !== y.owner) continue;
      const px = x.prefix ?? "";
      const py = y.prefix ?? "";
      if (!px.startsWith(py) && !py.startsWith(px)) continue;
      const prefix = px.length >= py.length ? px : py;
      out.push({ owner: x.owner, ...(prefix !== "" && { prefix }), mode: RANK[x.mode] <= RANK[y.mode] ? x.mode : y.mode });
    }
  return out;
}

// An agent's own grants intersected with every non-root ancestor's, so a delegate never holds more than its chain. The root
// supervisor (parent null) stands for the operator and does not narrow. A missing ancestor or a runaway chain fails closed (no grants).
export async function effectiveGrants(
  grantsFor: (key: string) => StateGrants,
  rec: AgentRecord,
  get: (id: AgentId) => Promise<AgentRecord | null>,
): Promise<StateGrant[]> {
  let acc: StateGrant[] = [...grantsFor(grantKeyOf(rec))];
  let cur = rec;
  for (let depth = 0; cur.parent !== null; depth++) {
    if (depth >= MAX_CHAIN) return [];
    const p = await get(cur.parent);
    if (!p) return [];
    if (p.parent === null) break;
    acc = intersectGrants(acc, grantsFor(grantKeyOf(p)));
    cur = p;
  }
  return acc;
}

// `key` is a document key or a key prefix ("" = the whole owner): a prefix is allowed only when wholly inside a grant.
export function mayState(principal: StatePrincipal, verb: StateVerb, owner: string, key: string): boolean {
  if ("operator" in principal) return true;
  return principal.grants.some((g) => g.owner === owner && key.startsWith(g.prefix ?? "") && (verb === "read" || g.mode === "rw"));
}

// The owners a principal may list: every owner it holds any grant on.
export function grantedOwners(principal: StatePrincipal): string[] | "all" {
  return "operator" in principal ? "all" : [...new Set(principal.grants.map((g) => g.owner))].sort();
}

export class StatePolicy {
  private readonly grants: Map<string, StateGrant[]>;
  readonly limitsFor: (owner: string) => StateLimits;
  private readonly limitOwners: string[];
  constructor(grantsJson?: string, limitsJson?: string) {
    this.grants = parseStateGrants(grantsJson);
    const l = parseStateLimits(limitsJson);
    this.limitsFor = l.limitsFor;
    this.limitOwners = l.owners;
  }
  grantsFor = (key: string): StateGrants => this.grants.get(key) ?? [];
  // Boot-time check, like WorkflowRuntimePolicy.validate: every grant key names a registered driver or a resolvable template, every
  // owner is "operator" or a known extension. An unknown name refuses the start (fail closed).
  async validate(known: { owners: Iterable<string>; drivers: readonly string[]; template: (id: string) => Promise<unknown> }): Promise<void> {
    const owners = new Set<string>(["operator", ...known.owners]);
    for (const [key, list] of this.grants) {
      if (DRIVER_KEY.test(key)) {
        if (!known.drivers.includes(key)) throw new Error(`POMTREED_STATE_GRANTS names an unregistered driver: ${key}`);
      } else if (!(await known.template(key))) throw new Error(`POMTREED_STATE_GRANTS names an unknown template: ${key}`);
      for (const g of list) if (!owners.has(g.owner)) throw new Error(`POMTREED_STATE_GRANTS grants ${key} an unknown owner: ${g.owner}`);
    }
    for (const owner of this.limitOwners) if (!owners.has(owner)) throw new Error(`POMTREED_STATE_LIMITS names an unknown owner: ${owner}`);
  }
}

// The content-free journal payload: built only from the named fields, so a value can never reach it.
export function stateOpPayload(p: Omit<StateOpJournalPayload, "kind">): ExtensionJournalPayload {
  return {
    kind: POMTREED_KINDS.stateOp,
    op: p.op,
    owner: p.owner,
    ...(p.key !== undefined && { key: p.key }),
    ...(p.prefix !== undefined && { prefix: p.prefix }),
    ...(p.rev !== undefined && { rev: p.rev }),
    ...(p.bytes !== undefined && { bytes: p.bytes }),
    ...(p.count !== undefined && { count: p.count }),
    by: p.by,
    ...(p.workflow !== undefined && { workflow: p.workflow }),
    ...(p.instance !== undefined && { instance: p.instance }),
  };
}

// True when a state identifier would be altered by the journal's host-path redaction: such a key/prefix/owner is refused rather than journaled redacted.
export const redactionChangesIds = (redactText: (s: string) => string, ids: readonly (string | undefined)[]): boolean =>
  ids.some((s) => s !== undefined && redactText(s) !== s);
