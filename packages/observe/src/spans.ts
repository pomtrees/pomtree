import { createHash } from "node:crypto";
import type { AgentId, JournalEntry } from "@pomtree/core";
import { SeqDedupe } from "./seqDedupe.ts";

// Plain span records shaped after the OTel GenAI conventions; otlp.ts maps them onto the wire format.

export type AttributeValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: "agent" | "tool";
  agent: AgentId;
  startTs: number;
  endTs: number | null; // null while still open
  status: "ok" | "error" | "unset";
  attributes: Record<string, AttributeValue>;
}

export interface BuildSpansOptions {
  // Prompt/response/tool text is a common accident in trace stores, so it is off by default.
  includeContent?: boolean;
}

export const idHash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function parseTraceparent(tp: string | undefined): { traceId: string; spanId: string } | null {
  const m = tp ? TRACEPARENT.exec(tp) : null;
  return m ? { traceId: m[1]!, spanId: m[2]! } : null;
}

// The context an agent's own span has. Pass it as JournalEntry.traceparent on the child's entries
// so the child's spans nest under this agent's span.
export function agentTraceparent(agent: AgentId, parentTraceparent?: string): string {
  const traceId = parseTraceparent(parentTraceparent)?.traceId ?? idHash(`trace:${agent}`, 32);
  return `00-${traceId}-${idHash(`agent:${agent}`, 16)}-01`;
}

export function dedupeAndSort(entries: Iterable<JournalEntry>): JournalEntry[] {
  const bySeq = new Map<number, JournalEntry>();
  for (const e of entries) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

interface AgentTrack {
  agent: AgentId;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sawTraceparent: boolean;
  startTs: number;
  endTs: number | null;
  status: Span["status"];
  closed: boolean; // agent span was closed by an exit
  settled: boolean; // trace context is final enough to hand out spans: spawned seen, traceparent seen, or exited
  heldTools: Set<string>; // completed tool spans waiting for `settled`
  emitted: string | null; // fingerprint of the agent span as last handed out
  attrs: Record<string, AttributeValue>;
  tools: Map<string, Span>;
  returnedTools: Set<string>; // tool spans already handed out by apply()
}

const copySpan = (s: Span): Span => ({ ...s, attributes: { ...s.attributes } });

// A tool still open once its agent has exited was interrupted; closed at the exit, in the copy only,
// so a late tool_result can still close the real span.
function toolView(a: AgentTrack, t: Span): Span {
  const c = copySpan(t);
  if (c.endTs === null && a.closed) {
    c.endTs = a.endTs;
    c.status = "error";
    c.attributes["pomtree.interrupted"] = true;
  }
  return c;
}

const fingerprint = (s: Span) => JSON.stringify([s.startTs, s.endTs, s.status, s.traceId, s.parentSpanId, s.attributes]);

function agentSpanOf(a: AgentTrack): Span {
  return {
    traceId: a.traceId,
    spanId: a.spanId,
    parentSpanId: a.parentSpanId,
    name: `invoke_agent ${a.agent}`,
    kind: "agent",
    agent: a.agent,
    startTs: a.startTs,
    endTs: a.endTs,
    status: a.status,
    attributes: { ...a.attrs },
  };
}

// Incremental counterpart of buildSpans: fold entries as they stream in and hand out each
// span as it completes. Read either the spans apply() returns or the final snapshot(), not both.
// Spans the stream cannot finish on its own (open agents, tools interrupted by an exit, an agent
// span changed by entries after its exit) are handed out by `reaped` or by drain().
export class SpanTracker {
  readonly #agents = new Map<AgentId, AgentTrack>();
  readonly #dedupe = new SeqDedupe(); // bounded low-water-mark dedupe by seq
  readonly #includeContent: boolean;

  constructor(opts: BuildSpansOptions = {}) {
    this.#includeContent = opts.includeContent ?? false;
  }

  // Number of applied seqs still retained above the low-water mark (bounded by reorder depth).
  get seenSeqCount(): number {
    return this.#dedupe.size;
  }

  // Fold one entry; returns copies of the spans it completed ([] for a duplicate seq).
  apply(e: JournalEntry): Span[] {
    if (!this.#dedupe.accept(e.seq)) return [];
    let a = this.#agents.get(e.agent);
    if (!a) {
      a = {
        agent: e.agent,
        traceId: idHash(`trace:${e.agent}`, 32),
        spanId: idHash(`agent:${e.agent}`, 16),
        parentSpanId: null,
        sawTraceparent: false,
        startTs: e.ts,
        endTs: null,
        status: "unset",
        closed: false,
        settled: false,
        heldTools: new Set(),
        emitted: null,
        tools: new Map(),
        returnedTools: new Set(),
        attrs: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.id": e.agent,
          "gen_ai.usage.input_tokens": 0,
          "gen_ai.usage.output_tokens": 0,
          "pomtree.cost_micros": 0,
          "pomtree.yields": 0,
          "pomtree.resumes": 0,
          "pomtree.messages": 0,
        },
      };
      this.#agents.set(e.agent, a);
    }
    a.startTs = Math.min(a.startTs, e.ts);
    // The traceparent normally arrives on the first (spawned) entry; the first valid one
    // sticks. Completed tool spans are held until that context is settled (spawned seen,
    // traceparent seen, or exit) so none is handed out on a trace it will not end up on.
    if (!a.sawTraceparent) {
      const tp = parseTraceparent(e.traceparent);
      if (tp) {
        a.sawTraceparent = true;
        a.traceId = tp.traceId;
        a.parentSpanId = tp.spanId;
        for (const t of a.tools.values()) t.traceId = tp.traceId;
      }
    }

    if (e.payload.kind === "spawned") a.settled = true;
    const done: Span[] = [];
    const emitTool = (callId: string) => {
      if (a.returnedTools.has(callId)) return;
      a.returnedTools.add(callId);
      done.push(toolView(a, a.tools.get(callId)!));
    };
    const attrs = a.attrs;
    const bump = (k: string, by: number) => {
      attrs[k] = (attrs[k] as number) + by;
    };
    attrs["pomtree.host"] = e.host;
    attrs["pomtree.generation"] = Math.max(e.generation, (attrs["pomtree.generation"] as number | undefined) ?? 0);
    const p = e.payload;
    switch (p.kind) {
      case "yielded":
        bump("pomtree.yields", 1);
        break;
      case "resumed":
        bump("pomtree.resumes", 1);
        break;
      case "exited": {
        a.endTs = e.ts;
        a.status = p.exit === "succeeded" ? "ok" : "error";
        attrs["pomtree.exit"] = p.exit;
        a.settled = true;
        if (!a.closed) {
          a.closed = true;
          done.push(this.#emitAgent(a));
        }
        break;
      }
      case "reaped":
        if (a.closed) done.push(...this.#finish(a));
        break;
      case "message":
        bump("pomtree.messages", 1);
        break;
      case "usage":
        bump("gen_ai.usage.input_tokens", p.inputTokens);
        bump("gen_ai.usage.output_tokens", p.outputTokens);
        // Unknown is not zero: cost_micros sums the known costs, and cost_unknown_events (present only when nonzero)
        // counts usage without a cost, which marks cost_micros as a lower bound.
        if (p.costMicros === null) attrs["pomtree.cost_unknown_events"] = ((attrs["pomtree.cost_unknown_events"] as number | undefined) ?? 0) + 1;
        else bump("pomtree.cost_micros", p.costMicros);
        break;
      case "tool_call":
        if (!a.tools.has(p.callId)) {
          const ta: Record<string, AttributeValue> = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": p.tool,
            "gen_ai.tool.call.id": p.callId,
          };
          if (this.#includeContent) ta["gen_ai.tool.call.arguments"] = JSON.stringify(p.input);
          const t: Span = {
            traceId: a.traceId,
            spanId: idHash(`tool:${e.agent}:${p.callId}`, 16),
            parentSpanId: a.spanId,
            name: `execute_tool ${p.tool}`,
            kind: "tool",
            agent: e.agent,
            startTs: e.ts,
            endTs: null,
            status: "unset",
            attributes: ta,
          };
          a.tools.set(p.callId, t);
        }
        break;
      case "tool_result": {
        const t = a.tools.get(p.callId);
        if (t && t.endTs === null) {
          t.endTs = e.ts;
          t.status = p.ok ? "ok" : "error";
          if (this.#includeContent) t.attributes["gen_ai.tool.call.result"] = p.output;
          a.heldTools.add(p.callId);
        }
        break;
      }
      default:
        break;
    }
    if (a.settled) {
      for (const callId of a.heldTools) emitTool(callId);
      a.heldTools.clear();
    }
    return done;
  }

  #emitAgent(a: AgentTrack): Span {
    const s = agentSpanOf(a);
    a.emitted = fingerprint(s);
    return s;
  }

  // Tools interrupted by the exit, plus the agent span again if entries after the exit changed it.
  #finish(a: AgentTrack): Span[] {
    const out: Span[] = [];
    for (const [callId, t] of a.tools) {
      if (!a.returnedTools.has(callId)) {
        a.returnedTools.add(callId);
        out.push(toolView(a, t));
      }
    }
    a.heldTools.clear();
    if (a.emitted !== fingerprint(agentSpanOf(a))) out.unshift(this.#emitAgent(a));
    return out;
  }

  // Final flush for a stream that has ended: spans a live stream could not finish. Exited agents
  // get their interrupted tools and, if changed since they were handed out, their agent span
  // again (same spanId, updated attributes). Agents still open are handed out as open spans
  // (endTs null), with the tools that completed; their still-open tools are not.
  // Each span is handed out once per change, so repeating drain() returns [].
  drain(): Span[] {
    const out: Span[] = [];
    for (const a of this.#agents.values()) {
      a.settled = true;
      if (a.closed) {
        out.push(...this.#finish(a));
        continue;
      }
      if (a.emitted !== fingerprint(agentSpanOf(a))) out.push(this.#emitAgent(a));
      for (const callId of a.heldTools) {
        if (!a.returnedTools.has(callId)) {
          a.returnedTools.add(callId);
          out.push(toolView(a, a.tools.get(callId)!));
        }
      }
      a.heldTools.clear();
    }
    return out;
  }

  // All spans known so far, open and closed, per agent: agent span first, then its tools.
  snapshot(): Span[] {
    const out: Span[] = [];
    for (const a of this.#agents.values()) out.push(agentSpanOf(a), ...[...a.tools.values()].map((t) => toolView(a, t)));
    return out;
  }
}

export function buildSpans(entries: Iterable<JournalEntry>, opts: BuildSpansOptions = {}): Span[] {
  const tracker = new SpanTracker(opts);
  for (const e of dedupeAndSort(entries)) tracker.apply(e);
  return tracker.snapshot();
}
