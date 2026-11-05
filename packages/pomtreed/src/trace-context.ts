// Trace context for journal entries (SPEC: "spawning passes trace context to the child so spans nest across the tree"). The
// observe span builder reads `JournalEntry.traceparent` and nests an agent's span under the span it names; this module is the
// producer side, so every append carries its agent's context without per-call-site stamping.
//
// One trace per run: a child of the root supervisor (an operator spawn, a workflow task) starts its own trace, so the
// long-lived root does not collect every run into one endless trace; any deeper agent carries
// observe's agentTraceparent(parent, parent's traceparent), i.e. the run's trace id and its parent's span id. The context is a
// pure function of the immutable parent links in the registry, so nothing is stored; lookups are memoized per agent.
import type { AgentId, AgentRecord, Journal, JournalEntry, NewJournalEntry } from "@pomtree/core";
import { agentTraceparent } from "@pomtree/observe";

type ParentOf = (id: AgentId) => Promise<Pick<AgentRecord, "parent"> | null>;

const MEMO_MAX = 10_000;

export interface TraceContext {
  // The traceparent an agent's own entries carry; undefined for the root, its direct children (each a trace root) and an
  // agent the registry does not know.
  of(agent: AgentId): Promise<string | undefined>;
  // The memoized answer without a lookup: a string or null (no context) once known, undefined when not yet resolved.
  peek(agent: AgentId): string | null | undefined;
}

export function traceContext(get: ParentOf): TraceContext {
  const memo = new Map<AgentId, string | null>();
  const remember = (agent: AgentId, tp: string | null): void => {
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(agent, tp);
  };
  const of = async (agent: AgentId): Promise<string | undefined> => {
    const hit = memo.get(agent);
    if (hit !== undefined) return hit ?? undefined;
    const rec = await get(agent);
    if (!rec) return undefined; // unknown: not memoized (it may be created later)
    const parent = rec.parent;
    const grand = parent === null ? null : ((await get(parent))?.parent ?? null);
    const tp = parent === null || grand === null ? null : agentTraceparent(parent, await of(parent));
    remember(agent, tp);
    return tp ?? undefined;
  };
  return { of, peek: (agent) => memo.get(agent) };
}

// The journal with every append stamped with its agent's trace context (an entry that already carries one keeps it). Reads,
// subscriptions, retention and spend pass through unchanged. Appends keep their call order: once an agent's context is known
// the append is the inner journal's own promise (no extra await), and an append that needs a registry lookup, plus any append
// issued while one is pending, is chained behind the earlier ones. A failed lookup never blocks the append: the entry is
// journaled without context. Idempotent: a journal this function returned is returned as is, so every construction path (the
// Daemon constructor, openDaemonStore) may wrap without stacking lookups.
const TRACED = new WeakSet<Journal>();
export function tracedJournal(journal: Journal, get: ParentOf): Journal {
  if (TRACED.has(journal)) return journal;
  const context = traceContext(get);
  const stamp = (entry: NewJournalEntry, tp: string | null | undefined): NewJournalEntry => (entry.traceparent || !tp ? entry : { ...entry, traceparent: tp });
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const traced: Journal = {
    append(entry: NewJournalEntry): Promise<JournalEntry> {
      const known = entry.traceparent ? null : context.peek(entry.agent);
      if (queued === 0 && known !== undefined) return journal.append(stamp(entry, known));
      queued++;
      const p = chain.then(async () => journal.append(stamp(entry, entry.traceparent ? null : await context.of(entry.agent).catch(() => undefined))));
      chain = p.then(
        () => queued--,
        () => queued--,
      );
      return p;
    },
    read: (opts) => journal.read(opts),
    subscribe: (opts) => journal.subscribe(opts),
    pruneJournal: (opts) => journal.pruneJournal(opts),
    spendFor: (agent) => journal.spendFor(agent),
  };
  TRACED.add(traced);
  return traced;
}
