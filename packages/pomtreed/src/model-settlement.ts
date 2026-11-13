// Pure decisions for wiring the model proxy into the daemon: which extra upstream paths to allow and what a
// settlement journals. No fs, sockets or journal coupling.
//
// Journal entry `ext.pomtreed.model_settlement`, one per upstream call, keyed by (agent, requestId, settlement) so a replay
// is idempotent. Fields (metadata only: never bodies, headers, prompt content, queries, keys or raw agent request paths):
//   settlement    "priced" | "estimated" | "reserve" | "failed" (failed: nothing billable was produced, micros 0)
//   micros        the charge; 0 for "failed"
//   requestId     the debit ledger row's request id; the entry's agent is the journal agent
//   model         the request body's top-level `model` string, when it is JSON and names one
//   upstreamStatus  HTTP status; absent for a transport error or timeout
//   latencyMs     wall time of the upstream call
//   tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, finishReason  as reported by a 2xx response (cache counts omitted
//                 when the provider reported none; Anthropic tokensIn excludes cache tokens, see core ModelCallMeta)
//   route         "messages" | "chat_completions" | "other" (closed class of the request path), on every entry
//   basis         where the charge came from (core ModelPriceBasis), chosen once by the pricer and carried: "reported" (the provider's
//                 own cost, charged as reported), "catalog" (the local rate card applied to the provider's reported tokens),
//                 "estimated" (the byte-size fallback for a 2xx with no usable usage), "reserve" (the whole reservation, fail
//                 closed). On every "priced", "estimated" and "reserve" entry; absent on "failed" (nothing was priced)
//   errorClass    one of core MODEL_CALL_ERROR_CLASSES: on every "failed" entry (by status: not_found, auth_rejected,
//                 insufficient_funds, rate_limited, bad_request, redirect, else upstream_4xx/upstream_5xx; by a thrown
//                 cause code: dns, connect, tls, timeout, aborted, else transport); on a "reserve" entry for an unusable 2xx
//                 (malformed_response, response_too_large); stream_error on any 2xx stream that reported an error event
//   upstreamHost, upstreamPath  the upstream host and final path (configured base path plus request path, no query), on
//                 every entry whose call was addressed upstream (core ModelCallUpstream)
//   upstreamMessage  "failed" only: the upstream's error text, at most 200 characters, control characters stripped and
//                 key-shaped substrings and the configured upstream key removed
// A "failed" settlement for a call that never got response headers also journals a separate daemon-authored `error` entry
// (keyed `model-preheader:`) naming the cause and the reserved micro-USD released at charge 0; it is never put in `upstreamMessage`.
// The debit ledger row gets every field but kind, settlement, micros, requestId and the upstream* fields via recordCall
// (also for a cancelled "failed" call): model, tokens, upstreamStatus, latencyMs, finishReason, route, errorClass and basis
// (core ModelCallMeta).
import { createHash } from "node:crypto";
import {
  POMTREED_KINDS,
  type AgentId,
  type AgentRecord,
  type Journal,
  type JournalEntry,
  type ModelCallMeta,
  type ModelCallUpstream,
  type ModelSettlementJournalPayload,
} from "@pomtree/core";

import { DEFAULT_ALLOWED_PATHS, type ProxySettlement } from "./model-proxy/service.ts";

export const MODEL_SETTLEMENT_KIND = POMTREED_KINDS.modelSettlement;

// DEFAULT_ALLOWED_PATHS plus operator extras (POMTREED_MODEL_PROXY_EXTRA_PATHS, comma separated), normalized to a
// leading slash with no trailing slash and de-duplicated.
export function allowedPathsUnion(extra: string | undefined): string[] {
  const out = new Set<string>(DEFAULT_ALLOWED_PATHS);
  for (const raw of (extra ?? "").split(",")) {
    const p = raw.trim().replace(/\/+$/, "");
    if (p) out.add(p.startsWith("/") ? p : `/${p}`);
  }
  return [...out];
}

export function settlementKey(e: ProxySettlement): string {
  const h = createHash("sha256").update(`${e.agent}\0${e.requestId}\0${e.kind}`).digest("hex").slice(0, 32);
  return `model-settlement:${h}`;
}

// Journaled for every settlement kind, so cost joins to a call by `requestId` (the ledger row's key). Metadata only. The
// debit ledger stays the spend authority; this entry never charges anything. The shape is core's, plus the upstream facts.
// TODO(err-proxy): core's ModelSettlementJournalPayload (kinds.ts) does not yet extend ModelCallUpstream; until it does, the
// upstream fields are added here by intersection.
export type SettlementPayload = ModelSettlementJournalPayload & ModelCallUpstream;

export function settlementPayload(e: ProxySettlement): SettlementPayload {
  return {
    kind: MODEL_SETTLEMENT_KIND,
    settlement: e.kind,
    micros: e.micros,
    requestId: e.requestId,
    ...(e.model && { model: e.model }),
    ...(e.tokensIn !== undefined && { tokensIn: e.tokensIn }),
    ...(e.tokensOut !== undefined && { tokensOut: e.tokensOut }),
    ...(e.cacheReadTokens !== undefined && { cacheReadTokens: e.cacheReadTokens }),
    ...(e.cacheWriteTokens !== undefined && { cacheWriteTokens: e.cacheWriteTokens }),
    ...(e.upstreamStatus !== undefined && { upstreamStatus: e.upstreamStatus }),
    ...(e.latencyMs !== undefined && { latencyMs: e.latencyMs }),
    ...(e.finishReason && { finishReason: e.finishReason }),
    ...(e.route && { route: e.route }),
    ...(e.errorClass && { errorClass: e.errorClass }),
    ...(e.basis && { basis: e.basis }),
    ...(e.responseId && { responseId: e.responseId }),
    ...(e.upstreamHost && { upstreamHost: e.upstreamHost }),
    ...(e.upstreamPath && { upstreamPath: e.upstreamPath }),
    ...(e.upstreamMessage && { upstreamMessage: e.upstreamMessage }),
  };
}

// The settlement a harness `usage` event reports, found among the agent's journaled settlements by the provider response id
// both carry (usage-join): an exact match on a billable settlement (not "failed"), never a guess by token counts. Null when
// the event has no response id or no settlement carries it: the event then keeps the harness's own figure, labeled as such.
// The daemon's fallback when no debit store is wired (the store answers the same question by an indexed lookup).
export function settlementForUsage(
  entries: readonly Pick<JournalEntry, "payload">[],
  usage: { responseId?: string },
): { requestId: string; micros: number } | null {
  if (!usage.responseId) return null;
  for (const e of entries) {
    const p = e.payload as unknown as Record<string, unknown>;
    if (p.kind !== MODEL_SETTLEMENT_KIND || p.settlement === "failed" || p.responseId !== usage.responseId) continue;
    const s = p as unknown as ModelSettlementJournalPayload;
    return { requestId: s.requestId, micros: s.micros };
  }
  return null;
}

// The ledger-side metadata of the same call (see core ModelCallMeta).
export function settlementCallMeta(e: ProxySettlement): ModelCallMeta {
  const { kind: _k, settlement: _s, micros: _m, requestId: _r, upstreamHost: _h, upstreamPath: _p, upstreamMessage: _g, ...meta } = settlementPayload(e);
  return meta;
}

// The settlement hook pomtreed and the live model path both install on their ModelProxy: record the call metadata on the debit
// ledger row and journal one `ext.pomtreed.model_settlement` entry. A failure of either is logged and never touches the
// response. `host` defaults to the agent record's host. The returned promise never rejects (callers may ignore it; tests
// await it).
export function settlementSink(o: {
  debits: { recordCall(agent: AgentId, requestId: string, meta: ModelCallMeta): boolean };
  registry: { get(id: AgentId): Promise<Pick<AgentRecord, "id" | "generation" | "host"> | null> };
  journal: Pick<Journal, "append">;
  host?: string;
  log?: (message: string) => void;
}): (e: ProxySettlement) => Promise<void> {
  const log = o.log ?? ((m: string) => console.error(m));
  return async (e) => {
    try {
      o.debits.recordCall(e.agent, e.requestId, settlementCallMeta(e));
    } catch {
      log("pomtreed: could not record model call metadata on the debit ledger");
    }
    try {
      const rec = await o.registry.get(e.agent);
      if (!rec) return;
      await o.journal.append({
        agent: rec.id,
        host: o.host ?? rec.host,
        generation: rec.generation,
        payload: settlementPayload(e),
        idempotencyKey: settlementKey(e),
      });
      // A call that failed before any response headers is charged nothing and its reservation released, yet the provider may still
      // have billed it. The daemon's own record of that, apart from the settlement entry (whose `upstreamMessage` is upstream text only).
      if (e.kind === "failed" && e.releasedMicros !== undefined) {
        const cause = e.errorClass ?? "transport";
        await o.journal.append({
          agent: rec.id,
          host: o.host ?? rec.host,
          generation: rec.generation,
          payload: {
            kind: "error",
            message: `model call ${e.requestId} failed before response headers (${cause}); the reserved ${e.releasedMicros} micro-USD were released and the call charged 0, but the provider may still have billed it; retry the call, and compare the provider's usage with the budget if this recurs`,
          },
          idempotencyKey: `model-preheader:${settlementKey(e)}`,
        });
      }
    } catch {
      log("pomtreed: could not journal model settlement");
    }
  };
}
