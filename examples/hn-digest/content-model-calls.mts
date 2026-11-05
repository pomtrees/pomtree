// Per-call model rows for one live run, built from the journal's `ext.pomtreed.model_settlement` entries (one per upstream call, see
// packages/pomtreed/src/model-settlement.ts for the payload). Pure: no fs, network or clock access. The ledger stays the spend authority;
// these rows are the per-call view that must sum to it.
import { storyNumberOf, UNATTRIBUTED } from "./content-story.mts";

export const MODEL_SETTLEMENT = "ext.pomtreed.model_settlement";

// The journal entry fields this module reads: the envelope agent and the opaque payload.
export interface JournalLike {
  agent: string;
  payload: unknown;
  ts?: number; // the journal's append time, epoch ms; the row timestamps below are present only when it is
}

export interface ModelCallRow {
  requestId: string;
  agent: string;
  story: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number; // payload field cacheReadTokens; present only when the settlement carries it
  cacheWriteTokens?: number; // payload field cacheWriteTokens; present only when the settlement carries it
  micros: number;
  upstreamStatus?: number;
  latencyMs?: number;
  route?: string;
  errorClass?: string; // failed calls only
  finishReason?: string; // payload field finishReason; present only when a 2xx response reported one
  settlement: string;
  turn: number; // 0-based ordinal among this agent's settlements in journal order (Pi's turnIndex when no call failed)
  toolCalls: number; // tool calls this agent journaled after this settlement and before its next one: the calls this response produced
  settledAt?: string; // ISO time the settlement was journaled, which ends the upstream call
  startedAt?: string; // settledAt minus latencyMs: when the request began; present with both settledAt and latencyMs
}

type Registry = ReadonlyMap<string, { name: string; parent?: string | null }>;

const isSettlement = (p: unknown): p is Record<string, unknown> => typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === MODEL_SETTLEMENT;

// Turn attribution shared by the model-call rows and the analyst evidence: a journal row of one agent belongs to the turn of the latest
// settlement journaled before it (the response that produced it), and to no turn before the first. [heuristic: a tool call is journaled
// after its response's settlement; the proxy settles when the upstream stream ends, before Pi runs the tool.]
export function turnCounter() {
  const settled = new Map<string, number>();
  return {
    settle(agent: string): number {
      const turn = settled.get(agent) ?? 0;
      settled.set(agent, turn + 1);
      return turn;
    },
    current(agent: string): number | null {
      const n = settled.get(agent) ?? 0;
      return n === 0 ? null : n - 1;
    },
  };
}

const isToolCall = (p: unknown): boolean => typeof p === "object" && p !== null && (p as { kind?: unknown }).kind === "tool_call";

export function modelCallRows(entries: readonly JournalLike[], agents: Registry): ModelCallRow[] {
  const rows: ModelCallRow[] = [];
  const turns = turnCounter();
  const lastRow = new Map<string, ModelCallRow>();
  for (const e of entries) {
    if (!isSettlement(e.payload)) {
      if (isToolCall(e.payload)) {
        const last = lastRow.get(e.agent);
        if (last) last.toolCalls++;
      }
      continue;
    }
    const p = e.payload;
    const row: ModelCallRow = {
      requestId: p.requestId as string,
      agent: e.agent,
      story: storyNumberOf(agents, e.agent) ?? UNATTRIBUTED,
      micros: p.micros as number,
      settlement: p.settlement as string,
      turn: turns.settle(e.agent),
      toolCalls: 0,
    };
    if (typeof e.ts === "number" && Number.isFinite(e.ts)) {
      row.settledAt = new Date(e.ts).toISOString();
      if (typeof p.latencyMs === "number") row.startedAt = new Date(e.ts - p.latencyMs).toISOString();
    }
    lastRow.set(e.agent, row);
    if (p.model !== undefined) row.model = p.model as string;
    if (p.tokensIn !== undefined) row.tokensIn = p.tokensIn as number;
    if (p.tokensOut !== undefined) row.tokensOut = p.tokensOut as number;
    if (p.cacheReadTokens !== undefined) row.cacheReadTokens = p.cacheReadTokens as number;
    if (p.cacheWriteTokens !== undefined) row.cacheWriteTokens = p.cacheWriteTokens as number;
    if (p.upstreamStatus !== undefined) row.upstreamStatus = p.upstreamStatus as number;
    if (p.latencyMs !== undefined) row.latencyMs = p.latencyMs as number;
    if (p.route !== undefined) row.route = p.route as string;
    if (p.errorClass !== undefined) row.errorClass = p.errorClass as string;
    if (p.finishReason !== undefined) row.finishReason = p.finishReason as string;
    rows.push(row);
  }
  return rows;
}

// The visible `model-calls.json`. An empty journal is reported in-file, not silently written as an empty list.
export function modelCallsFile(rows: ModelCallRow[]): { rows: ModelCallRow[]; warning?: string } {
  return { rows, ...(rows.length === 0 && { warning: "journal had no ext.pomtreed.model_settlement entries" }) };
}

// With no rows it passes only when the ledger total is zero: spend with no settlement rows means the journal is broken, not reconciled.
// Otherwise the row micros must sum to the ledger total and each requestId must be unique (one settlement
// per upstream call; a repeated id means a call was counted twice).
export function checkModelCalls(rows: readonly { requestId: string; micros: number }[], ledgerTotalMicros: number): { ok: boolean; detail: string } {
  if (rows.length === 0)
    return ledgerTotalMicros > 0
      ? { ok: false, detail: `no model-call rows but the ledger total is ${ledgerTotalMicros} micros` }
      : { ok: true, detail: "no model-call rows and a zero ledger total" };
  const problems: string[] = [];
  const sum = rows.reduce((n, r) => n + r.micros, 0);
  if (sum !== ledgerTotalMicros) problems.push(`model-call micros sum ${sum} != ledger total ${ledgerTotalMicros}`);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.requestId)) problems.push(`duplicate requestId ${r.requestId}`);
    seen.add(r.requestId);
  }
  if (problems.length > 0) return { ok: false, detail: problems.join("; ") };
  return { ok: true, detail: `${rows.length} model calls sum to ledger total ${ledgerTotalMicros} micros` };
}
