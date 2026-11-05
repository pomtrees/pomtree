// Per-story analyst evidence for the live run's output directory (`workers/<story id>.analysis.json`). Pure: the live collector hands over
// the analysis child's journal rows, its model-call rows and the page plan, and this module reduces them to a bounded, secret-free,
// path-free, article-text-free file (the companion of content-live-workers.mts, which covers the article worker).
//
// Reachable from the journal: each tool call and result with the journal's append times (so a duration is the span between the two
// appends, a few milliseconds coarser than the tool's own clock), the model settlements (one per turn), and the lifecycle rows.
// NOT reachable: how many times `article_page` polled for a page that was not yet published. The tool retries inside one call and reports
// nothing; a long first read is the only trace of it (TODO(analyst-poll-count): the tool should put the attempt count in its result).
import { ANALYST_CAUSES, ANALYST_TOOLS, PAGES_MAX, PAGE_TOOL, PAGE_WAIT_TRIES } from "../../packages/agent-image/ext/pomtree-analyst/analyst-contract.ts";
import type { JournalPayload } from "../../packages/core/src/index.ts";
import { turnCounter, type ModelCallRow } from "./content-model-calls.mts";
import { workerText } from "./content-live-workers.mts";

export const ANALYST_CALLS_MAX = 64; // tool calls kept; the count of all calls is kept beyond it
export const ANALYST_TOOL_NAME_MAX = 64; // characters kept of a tool name

// What the page plan says was offered; the sizes are the text bytes of each page (not the published report, which adds a banner).
export type PagingPlan = { pageBytes: readonly number[]; totalBytes: number; offeredBytes: number; pageMaxBytes: number; readMaxBytes: number };

export type AnalystToolCall = {
  turn: number | null; // the model call that produced it (content-model-calls turnCounter); null before the first settlement
  tool: string;
  page: number | null; // article_page only: the requested page when it is a whole number 1..PAGES_MAX
  ok: boolean | null; // null for a call that never returned
  at: string | null; // ISO journal time of the call
  durationMs: number | null; // call to result, null for a call that never returned
  attempts: number | null; // article_page only: reads of the page it took (1 = at once; more = it polled for the unpublished page); null when the result carried none (a failed call, a dropped or malformed details)
  cause: string | null; // a failed call's closed cause token (analyst-contract ANALYST_CAUSES); "other" when the text carried none
};
export type AnalystTurn = {
  turn: number;
  startedAt: string | null; // the model request's start (settlement time minus its latency)
  endedAt: string | null; // the later of the settlement and the last tool result this turn produced
  latencyMs: number | null;
  finishReason: string | null;
  settlement: string;
  toolCalls: number;
};
export type AnalystPaging = {
  pagesOffered: number;
  pagesRead: number; // distinct offered pages whose read succeeded
  pagesReadList: number[];
  offeredBytes: number;
  totalBytes: number;
  unreadBytes: number; // totalBytes - offeredBytes: text no page offers
  textBytesRead: number; // text bytes of the pages read
  readMaxBytes: number;
  readBudgetFraction: number; // textBytesRead / readMaxBytes, 4 decimals
};
export type AnalystEvidence = {
  storyId: number;
  child: string;
  generation: number;
  exit: string | null;
  exitCause: string | null;
  startedAt: string | null; // the child's `started` journal row, else its creation time
  endedAt: string | null; // its `exited` journal row; null while it never exited
  wallMs: number | null;
  stopReason: string | null; // finishReason of the last settled model call that reported one
  modelCalls: number; // settlements, failed ones included
  turns: AnalystTurn[];
  toolCallCount: number; // all calls, including any beyond ANALYST_CALLS_MAX
  tools: AnalystToolCall[];
  offAllowlist: string[]; // distinct called names outside ANALYST_TOOLS (all calls, not only the kept ones), clipped; empty when the allowlist held
  paging: AnalystPaging | null; // null when the story had no article text to page
};

const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const CAUSES: ReadonlySet<string> = new Set(ANALYST_CAUSES);

// The `(cause=token)` suffix the tool puts on every failure, accepted only when it is one of the closed tokens.
export function causeOf(output: string): string {
  const m = /\(cause=([a-z_]+)\)\s*$/.exec(output);
  return m && CAUSES.has(m[1] as string) ? (m[1] as string) : "other";
}

// The poll count the tool reported in its result `details` ({page, attempts}); anything but a whole number 1..PAGE_WAIT_TRIES (a drop marker, a
// forged or malformed value) is null, so the evidence never carries an unbounded or non-numeric count.
export function attemptsOf(details: unknown): number | null {
  const n = typeof details === "object" && details !== null && !Array.isArray(details) ? (details as { attempts?: unknown }).attempts : undefined;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= PAGE_WAIT_TRIES ? n : null;
}

function pageOf(input: unknown): number | null {
  const page = typeof input === "object" && input !== null ? (input as { page?: unknown }).page : undefined;
  return typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= PAGES_MAX ? page : null;
}

export function pagingOf(plan: PagingPlan, readPages: readonly number[]): AnalystPaging {
  const read = [...new Set(readPages)].filter((p) => p >= 1 && p <= plan.pageBytes.length).sort((a, b) => a - b);
  const textBytesRead = read.reduce((n, p) => n + (plan.pageBytes[p - 1] as number), 0);
  return {
    pagesOffered: plan.pageBytes.length,
    pagesRead: read.length,
    pagesReadList: read,
    offeredBytes: plan.offeredBytes,
    totalBytes: plan.totalBytes,
    unreadBytes: plan.totalBytes - plan.offeredBytes,
    textBytesRead,
    readMaxBytes: plan.readMaxBytes,
    readBudgetFraction: Math.round((textBytesRead / plan.readMaxBytes) * 10000) / 10000,
  };
}

export function analystEvidenceOf(input: {
  storyId: number;
  agent: { id: string; generation: number; exit: string | null; exitCause?: string; createdAt: number };
  entries: readonly { ts: number; payload: JournalPayload }[]; // this agent's journal rows, in order
  calls: readonly ModelCallRow[]; // this agent's model-call rows
  plan: PagingPlan | null;
  env: Record<string, string | undefined>;
}): AnalystEvidence {
  const turns = turnCounter();
  const open = new Map<string, { tool: string; page: number | null; turn: number | null; at: number; seq: number }>();
  const tools: (AnalystToolCall & { seq: number })[] = [];
  const lastResultAt = new Map<number, number>();
  const readPages: number[] = [];
  const offAllowlist = new Set<string>();
  let started: number | null = null;
  let ended: number | null = null;
  let toolCallCount = 0;
  const record = (callId: string, result: { ts: number; ok: boolean; output: string; details?: unknown } | null): void => {
    const call = open.get(callId);
    if (!call) return;
    open.delete(callId);
    if (result && call.turn !== null) lastResultAt.set(call.turn, Math.max(lastResultAt.get(call.turn) ?? 0, result.ts));
    if (result?.ok && call.tool === PAGE_TOOL && call.page !== null) readPages.push(call.page);
    if (tools.length >= ANALYST_CALLS_MAX) return;
    tools.push({
      turn: call.turn,
      tool: workerText(call.tool, input.env, ANALYST_TOOL_NAME_MAX),
      page: call.tool === PAGE_TOOL ? call.page : null,
      ok: result ? result.ok : null,
      at: iso(call.at),
      durationMs: result ? Math.max(0, result.ts - call.at) : null,
      attempts: result?.ok && call.tool === PAGE_TOOL ? attemptsOf(result.details) : null,
      cause: result && !result.ok ? causeOf(result.output) : null,
      seq: call.seq,
    });
  };
  for (const e of input.entries) {
    const p = e.payload;
    if (p.kind === "ext.pomtreed.model_settlement") turns.settle(input.agent.id);
    else if (p.kind === "started" && started === null) started = e.ts;
    else if (p.kind === "exited") ended = e.ts;
    else if (p.kind === "tool_call") {
      toolCallCount++;
      open.set(p.callId, {
        tool: p.tool,
        page: p.tool === PAGE_TOOL ? pageOf(p.input) : null,
        turn: turns.current(input.agent.id),
        at: e.ts,
        seq: toolCallCount,
      });
      if (!(ANALYST_TOOLS as readonly string[]).includes(p.tool)) offAllowlist.add(workerText(p.tool, input.env, ANALYST_TOOL_NAME_MAX));
    } else if (p.kind === "tool_result") record(p.callId, { ts: e.ts, ok: p.ok, output: p.output, details: p.details });
  }
  // A call that never returned is listed after the returned ones, as in the article worker's evidence.
  for (const id of [...open.keys()]) record(id, null);
  // Call order, not the order the results arrived in: by journal time, ties (parallel calls journaled in one millisecond) by journal position.
  tools.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.seq - b.seq);
  const startedAt = started ?? input.agent.createdAt;
  const settled = input.calls.filter((c) => c.settlement !== "failed" && c.finishReason !== undefined);
  return {
    storyId: input.storyId,
    child: input.agent.id,
    generation: input.agent.generation,
    exit: input.agent.exit,
    exitCause: input.agent.exitCause ?? null,
    startedAt: iso(startedAt),
    endedAt: iso(ended),
    wallMs: ended === null ? null : Math.max(0, ended - startedAt),
    stopReason: settled.at(-1)?.finishReason ?? null,
    modelCalls: input.calls.length,
    turns: input.calls.slice(0, ANALYST_CALLS_MAX).map((c) => ({
      turn: c.turn,
      startedAt: c.startedAt ?? null,
      endedAt: iso(Math.max(c.settledAt ? Date.parse(c.settledAt) : 0, lastResultAt.get(c.turn) ?? 0) || null),
      latencyMs: c.latencyMs ?? null,
      finishReason: c.finishReason ?? null,
      settlement: c.settlement,
      toolCalls: c.toolCalls,
    })),
    toolCallCount,
    tools: tools.map(({ seq: _seq, ...t }) => t),
    offAllowlist: [...offAllowlist],
    paging: input.plan ? pagingOf(input.plan, readPages) : null,
  };
}

// The one line provenance.json keeps per article: how the analyst ended, how long it took, and what it read.
export function analystSummaryOf(a: AnalystEvidence): {
  exit: string | null;
  exitCause: string | null;
  stopReason: string | null;
  wallMs: number | null;
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  pagesOffered: number | null;
  pagesRead: number | null;
} {
  return {
    exit: a.exit,
    exitCause: a.exitCause,
    stopReason: a.stopReason,
    wallMs: a.wallMs,
    modelCalls: a.modelCalls,
    toolCalls: a.toolCallCount,
    failedToolCalls: a.tools.filter((t) => t.ok === false).length,
    pagesOffered: a.paging?.pagesOffered ?? null,
    pagesRead: a.paging?.pagesRead ?? null,
  };
}
