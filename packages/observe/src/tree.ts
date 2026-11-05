import { POMTREED_KINDS, WAITING_KIND, waitingStep } from "@pomtree/core";
import type { AgentId, AgentRecord, AgentState, ExitStatus, JournalEntry, WaitCondition } from "@pomtree/core";
import { dedupeAndSort } from "./spans.ts";

export interface AgentStats {
  tokens: number;
  costMicros: number; // sum of the known costs only
  costUnknown: number; // usage events whose cost is unknown (costMicros null); nonzero = costMicros is a lower bound
  activity: string | null;
  lastSeq: number;
  lastTs: number | null; // ts of the newest journal entry for the agent
  pendingReason: string; // latest ext.pomtreed.pending_reason ("" = none/cleared)
  waitingSince: number | null; // ts of the ext.pomtreed.waiting marker while no non-passive entry followed (see core waitingStep)
  deadlineAt: number | null; // wall-clock session deadline (absolute epoch ms); null = none (unlimited)
}

export interface Row {
  id: AgentId;
  name: string;
  depth: number;
  state: AgentState;
  exit: ExitStatus | null;
  ageMs: number;
  activity: string | null;
  tokens: number;
  costMicros: number; // known spend; a lower bound when costPartial
  costPartial: boolean; // some usage reported no cost (unknown is not zero), so costMicros and remainingBudgetMicros are bounds
  remainingBudgetMicros: number; // an upper bound when costPartial
  wait: WaitCondition | null;
  host: string;
  lastTs: number | null;
  model: string;
  deadlineAt: number | null; // wall-clock session deadline (absolute epoch ms); null = none (unlimited)
  pendingReason: string; // why a pending agent is queued; "" otherwise
  waitingSince: number | null; // running agent idle after a settled turn (the state stays running); null otherwise
}

export interface TreeOptions {
  now: number;
  waits?: ReadonlyMap<AgentId, WaitCondition>; // from checkpoints; yielded agents show theirs
  includeContent?: boolean; // message/error text in the activity column; off by default, like spans
}

const clip = (s: string, n = 60) => {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

function activityOf(e: JournalEntry, includeContent: boolean): string | null {
  const p = e.payload;
  switch (p.kind) {
    case "message":
      return includeContent ? `${p.role}: ${clip(p.text)}` : `${p.role} message`;
    case "tool_call":
      return `tool ${p.tool}`;
    case "tool_result":
      return `result ${p.ok ? "ok" : "error"}`;
    case "error":
      return includeContent ? `error: ${clip(p.message)}` : "error";
    case "exited":
      return `exited ${p.exit}`;
    case "signal":
      return `signal ${p.signal.kind}`;
    case "usage":
      return null;
    case POMTREED_KINDS.pendingReason:
      return null; // surfaced via Row.pendingReason, not the activity column
    case WAITING_KIND:
      return "waiting";
    case POMTREED_KINDS.deadline:
      return null; // surfaced via Row.deadlineAt, not the activity column
    default:
      return p.kind;
  }
}

// Callers dedupe by seq; token and cost sums are not idempotent.
export function applyEntry(stats: Map<AgentId, AgentStats>, e: JournalEntry, includeContent = false): void {
  let s = stats.get(e.agent);
  if (!s) {
    s = { tokens: 0, costMicros: 0, costUnknown: 0, activity: null, lastSeq: -1, lastTs: null, pendingReason: "", waitingSince: null, deadlineAt: null };
    stats.set(e.agent, s);
  }
  if (s.lastTs === null || e.ts > s.lastTs) s.lastTs = e.ts;
  s.waitingSince = waitingStep(s.waitingSince, e);
  const p = e.payload;
  if (p.kind === "usage") {
    s.tokens += p.inputTokens + p.outputTokens;
    if (p.costMicros === null) s.costUnknown += 1;
    else s.costMicros += p.costMicros;
  }
  if (p.kind === POMTREED_KINDS.pendingReason) {
    const r = (p as { reason?: unknown }).reason;
    s.pendingReason = typeof r === "string" ? r : "";
  }
  if (p.kind === POMTREED_KINDS.deadline) {
    // The newest deadline wins (an extend appends a later deadline entry; a spawn writes one).
    const at = (p as { at?: unknown }).at;
    if (typeof at === "number" && Number.isFinite(at) && (s.deadlineAt === null || at > s.deadlineAt)) s.deadlineAt = at;
  }
  const a = activityOf(e, includeContent);
  if (a !== null && e.seq >= s.lastSeq) {
    s.activity = a;
    s.lastSeq = e.seq;
  }
}

export function foldEntries(entries: Iterable<JournalEntry>, includeContent = false): Map<AgentId, AgentStats> {
  const stats = new Map<AgentId, AgentStats>();
  for (const e of dedupeAndSort(entries)) applyEntry(stats, e, includeContent);
  return stats;
}

export function rowsFrom(agents: readonly AgentRecord[], stats: ReadonlyMap<AgentId, AgentStats>, opts: TreeOptions): Row[] {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<AgentId | null, AgentRecord[]>();
  for (const a of agents) {
    // An agent whose parent is unknown is shown as a root rather than dropped.
    const key = a.parent !== null && ids.has(a.parent) ? a.parent : null;
    const list = children.get(key);
    if (list) list.push(a);
    else children.set(key, [a]);
  }
  for (const list of children.values()) list.sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));

  const rows: Row[] = [];
  const visited = new Set<AgentId>();
  const walk = (key: AgentId | null, depth: number) => {
    for (const a of children.get(key) ?? []) {
      if (visited.has(a.id)) continue;
      visited.add(a.id);
      const s = stats.get(a.id);
      const done = a.state === "exited" || a.state === "reaped";
      const cost = s?.costMicros ?? 0;
      rows.push({
        id: a.id,
        name: a.name,
        depth,
        state: a.state,
        exit: a.exit,
        ageMs: Math.max(0, (done ? a.updatedAt : opts.now) - a.createdAt),
        activity: s?.activity ?? null,
        tokens: s?.tokens ?? 0,
        costMicros: cost,
        costPartial: (s?.costUnknown ?? 0) > 0,
        remainingBudgetMicros: a.budgetMicros - cost,
        wait: a.state === "yielded" ? (opts.waits?.get(a.id) ?? null) : null,
        host: a.host,
        lastTs: s?.lastTs ?? null,
        model: a.executor === "container" ? (a.spec.model ?? "") : "",
        deadlineAt: s?.deadlineAt ?? null,
        pendingReason: a.state === "pending" ? (s?.pendingReason ?? "") : "",
        waitingSince: a.state === "running" ? (s?.waitingSince ?? null) : null,
      });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function buildTree(agents: readonly AgentRecord[], journal: Iterable<JournalEntry>, opts: TreeOptions): Row[] {
  return rowsFrom(agents, foldEntries(journal, opts.includeContent), opts);
}
