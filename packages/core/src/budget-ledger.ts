import type { AgentId } from "./types.ts";

// The one hierarchical budget ledger (budget-nest): pure arithmetic over a snapshot of the agent tree, shared by the durable
// debit store (whose `reserve` enforces it in one transaction) and the daemon's tree reads (spawn carve, grants, remaining).
// Precedent: cgroups v2 and Kubernetes HierarchicalResourceQuota, where a child's usage counts against every ancestor.
//
// Each node has a budget (its carve; the root's is the operator-injected pool) and its own model use (settled spend plus
// in-flight reservations). A child holds against its parent:
//   live (not reaped):  max(carve, committed)   the whole carve stays out of the parent's reach while the child can spend it,
//                                               and anything beyond it (a provider overage) counts too;
//   reaped:             committed              the unused carve returns; an overage stays booked (the write-off).
// committed(n) = own use + the sum of what n's children hold; remaining(n) = budget(n) - committed(n), negative when n's
// subtree overran it. Invariant (over every node): sum over live non-root nodes of max(0, remaining) + the root's remaining
// (signed) + every node's own use = the root pool. Carving moves budget, it never duplicates it.
export interface LedgerNode {
  id: AgentId;
  parent: AgentId | null;
  budgetMicros: number;
  // Not reaped: the node's carve stays held against its parent.
  live: boolean;
  // Own settled spend plus own in-flight reservations (0 for the root and for a deterministic agent).
  usedMicros: number;
}

export interface LedgerView {
  node(id: AgentId): LedgerNode | undefined;
  committed(id: AgentId): number;
  remaining(id: AgentId): number;
  // What `id` holds against its parent (see above).
  held(id: AgentId): number;
  // The part of `id`'s committed beyond its budget: what its parent absorbs as a write-off.
  overage(id: AgentId): number;
}

export function budgetLedger(nodes: Iterable<LedgerNode>): LedgerView {
  const byId = new Map<AgentId, LedgerNode>();
  const children = new Map<AgentId, LedgerNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.parent !== null) (children.get(n.parent) ?? children.set(n.parent, []).get(n.parent)!).push(n);
  }
  const memo = new Map<AgentId, number>();
  // Iterative post-order so a deep tree cannot overflow the stack; a parent cycle (never produced by the registry, whose
  // parent is immutable) is cut at the revisit rather than looping.
  const committed = (id: AgentId): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const stack: { id: AgentId; expanded: boolean }[] = [{ id, expanded: false }];
    const onStack = new Set<AgentId>();
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (memo.has(top.id)) {
        stack.pop();
        continue;
      }
      const kids = children.get(top.id) ?? [];
      if (!top.expanded) {
        top.expanded = true;
        onStack.add(top.id);
        for (const k of kids) if (!memo.has(k.id) && !onStack.has(k.id)) stack.push({ id: k.id, expanded: false });
        continue;
      }
      let sum = byId.get(top.id)?.usedMicros ?? 0;
      for (const k of kids) sum += heldOf(k, memo.get(k.id) ?? 0);
      memo.set(top.id, sum);
      onStack.delete(top.id);
      stack.pop();
    }
    return memo.get(id) ?? 0;
  };
  const heldOf = (n: LedgerNode, c: number): number => (n.live ? Math.max(n.budgetMicros, c) : c);
  return {
    node: (id) => byId.get(id),
    committed,
    remaining: (id) => (byId.get(id)?.budgetMicros ?? 0) - committed(id),
    held: (id) => {
      const n = byId.get(id);
      return n ? heldOf(n, committed(id)) : 0;
    },
    overage: (id) => Math.max(0, committed(id) - (byId.get(id)?.budgetMicros ?? 0)),
  };
}

// The deepest ancestor chain a walk follows before it gives up. A registry tree is far shallower; a chain this long is
// treated as corrupt, not walked to the end.
export const LEDGER_MAX_DEPTH = 1024;

// Why a ledger walk refused: `exhausted` is an ordinary budget refusal; the others mean the tree snapshot is broken (a
// node or parent the snapshot lacks, a parent cycle, a chain past LEDGER_MAX_DEPTH), and the walk fails closed (SPEC
// rule 8) rather than admitting a commitment no ancestor checked.
export type LedgerRefusalCause = "exhausted" | "unknown-node" | "cycle" | "too-deep";
export interface LedgerRefusal {
  ok: false;
  at: AgentId;
  remainingMicros: number;
  cause: LedgerRefusalCause;
  reason: string;
}

// The chain from `id` up to its root (`id` first, the root last), or a refusal when the walk cannot reach a root: a missing
// node or parent, a cycle, or a chain deeper than LEDGER_MAX_DEPTH. Every ancestor walk over the ledger goes through here.
export function ledgerAncestry(view: LedgerView, id: AgentId): { ok: true; chain: LedgerNode[] } | LedgerRefusal {
  const chain: LedgerNode[] = [];
  const seen = new Set<AgentId>();
  let at: AgentId = id;
  for (;;) {
    const n = view.node(at);
    if (!n) {
      const reason =
        at === id
          ? `ledger has no node ${id}; refusing (fail closed)`
          : `ledger walk from ${id} reached ${chain[chain.length - 1]!.id}, whose parent ${at} is not in the ledger; refusing (fail closed): the agent tree is inconsistent, reconcile or reap the orphaned subtree`;
      return { ok: false, at, remainingMicros: 0, cause: "unknown-node", reason };
    }
    if (seen.has(at))
      return {
        ok: false,
        at,
        remainingMicros: 0,
        cause: "cycle",
        reason: `ledger walk from ${id} revisited ${at}: the parent chain has a cycle and reaches no root; refusing (fail closed): the agent tree is corrupt, repair the parent links`,
      };
    if (chain.length >= LEDGER_MAX_DEPTH)
      return {
        ok: false,
        at,
        remainingMicros: 0,
        cause: "too-deep",
        reason: `ledger walk from ${id} passed ${LEDGER_MAX_DEPTH} ancestors without reaching a root; refusing (fail closed): the agent tree is deeper than the ledger walks, flatten it`,
      };
    seen.add(at);
    chain.push(n);
    if (n.parent === null) return { ok: true, chain };
    at = n.parent;
  }
}

// Whether `id` may newly commit `amount` (a model reservation, or a carve to a new child): it must fit `id`'s own remaining,
// and wherever the growth spills past a live node's carve, that spill must fit the parent's remaining too, up to the root.
// `at` names the node that would overrun. A non-live (reaped) holder spills its whole growth upward. The whole chain must
// reach a root even when a carve absorbs the growth early (ledgerAncestry), so a broken tree never admits anything.
export function ledgerFits(view: LedgerView, id: AgentId, amount: number): { ok: true } | LedgerRefusal {
  const path = ledgerAncestry(view, id);
  if (!path.ok) return path;
  let delta = amount;
  for (const cur of path.chain) {
    if (delta <= 0) break;
    const remaining = view.remaining(cur.id);
    if (delta > remaining)
      return {
        ok: false,
        at: cur.id,
        remainingMicros: remaining,
        cause: "exhausted",
        reason: `${amount} micro-USD for ${id} does not fit: ${cur.id} has ${remaining} remaining`,
      };
    const c = view.committed(cur.id);
    delta = cur.live ? Math.max(cur.budgetMicros, c + delta) - Math.max(cur.budgetMicros, c) : delta;
  }
  return { ok: true };
}
