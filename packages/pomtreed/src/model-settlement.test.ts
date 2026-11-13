import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedPathsUnion, settlementForUsage, settlementKey, settlementPayload, settlementCallMeta, settlementSink } from "./model-settlement.ts";
import type { ProxySettlement } from "./model-proxy/service.ts";
import { DEFAULT_ALLOWED_PATHS } from "./model-proxy/service.ts";

test("allowedPathsUnion keeps defaults and normalizes extras", () => {
  assert.deepEqual(allowedPathsUnion(undefined), [...DEFAULT_ALLOWED_PATHS]);
  const u = allowedPathsUnion(" embeddings/, /v1/embeddings ,,/responses");
  assert.ok(u.includes("/embeddings") && u.includes("/v1/embeddings"));
  assert.equal(u.length, DEFAULT_ALLOWED_PATHS.length + 2);
});

test("a priced settlement journals its call metadata, keyed apart from other kinds", () => {
  const e = {
    agent: "a",
    requestId: "r",
    kind: "priced" as const,
    micros: 5,
    model: "m",
    tokensIn: 10,
    tokensOut: 4,
    upstreamStatus: 200,
    latencyMs: 31,
    finishReason: "stop",
  };
  assert.deepEqual(settlementPayload(e), {
    kind: "ext.pomtreed.model_settlement",
    settlement: "priced",
    micros: 5,
    requestId: "r",
    model: "m",
    tokensIn: 10,
    tokensOut: 4,
    upstreamStatus: 200,
    latencyMs: 31,
    finishReason: "stop",
  });
  assert.deepEqual(settlementCallMeta(e), { model: "m", tokensIn: 10, tokensOut: 4, upstreamStatus: 200, latencyMs: 31, finishReason: "stop" });
  assert.notEqual(settlementKey(e), settlementKey({ ...e, kind: "estimated" }));
});

test("settlement keys are stable and distinct per agent, request and kind", () => {
  const e = { agent: "a", requestId: "r", micros: 5, kind: "estimated" as const };
  assert.equal(settlementKey(e), settlementKey({ ...e, micros: 9 }));
  assert.notEqual(settlementKey(e), settlementKey({ ...e, kind: "reserve" }));
  assert.notEqual(settlementKey(e), settlementKey({ ...e, agent: "b" }));
  assert.notEqual(settlementKey(e), settlementKey({ ...e, requestId: "q" }));
  assert.deepEqual(settlementPayload({ ...e, model: "m" }), {
    kind: "ext.pomtreed.model_settlement",
    settlement: "estimated",
    micros: 5,
    requestId: "r",
    model: "m",
  });
});

test("a failed call journals its class and route, records them on the ledger metadata too, and is keyed apart", () => {
  const e = {
    agent: "a",
    requestId: "r",
    kind: "failed" as const,
    micros: 0,
    model: "m",
    upstreamStatus: 404,
    latencyMs: 7,
    errorClass: "upstream_4xx" as const,
    route: "messages" as const,
  };
  assert.deepEqual(settlementPayload(e), {
    kind: "ext.pomtreed.model_settlement",
    settlement: "failed",
    micros: 0,
    requestId: "r",
    model: "m",
    upstreamStatus: 404,
    latencyMs: 7,
    errorClass: "upstream_4xx",
    route: "messages",
  });
  assert.deepEqual(settlementCallMeta(e), { model: "m", upstreamStatus: 404, latencyMs: 7, errorClass: "upstream_4xx", route: "messages" });
  assert.notEqual(settlementKey(e), settlementKey({ ...e, kind: "priced" }));
  assert.deepEqual(settlementPayload({ agent: "a", requestId: "r", kind: "priced", micros: 1, route: "other" }).route, "other");
});

test("settlementPayload journals the upstream host, path and message; the ledger meta keeps none of them", () => {
  const e = {
    agent: "a",
    requestId: "r",
    kind: "failed" as const,
    micros: 0,
    upstreamStatus: 404,
    route: "chat_completions" as const,
    errorClass: "not_found" as const,
    upstreamHost: "openrouter.ai",
    upstreamPath: "/api/chat/completions",
    upstreamMessage: "Not Found",
  };
  assert.deepEqual(settlementPayload(e), {
    kind: "ext.pomtreed.model_settlement",
    settlement: "failed",
    micros: 0,
    requestId: "r",
    upstreamStatus: 404,
    route: "chat_completions",
    errorClass: "not_found",
    upstreamHost: "openrouter.ai",
    upstreamPath: "/api/chat/completions",
    upstreamMessage: "Not Found",
  });
  assert.deepEqual(settlementCallMeta(e), { upstreamStatus: 404, route: "chat_completions", errorClass: "not_found" });
  // Negative: absent facts add no keys.
  const bare = settlementPayload({ agent: "a", requestId: "r", kind: "priced", micros: 1 });
  assert.equal("upstreamHost" in bare || "upstreamPath" in bare || "upstreamMessage" in bare, false);
});

function sinkRig(opts: { registryHas?: boolean; hostId?: string } = {}) {
  const recorded: Array<{ agent: string; requestId: string; meta: unknown }> = [];
  const seen = new Map<string, { agent: string; host: string; generation: number; payload: unknown }>();
  const sink = settlementSink({
    debits: {
      recordCall: (agent, requestId, meta) => {
        recorded.push({ agent, requestId, meta });
        return true;
      },
    },
    registry: { get: async (id) => (opts.registryHas === false ? null : ({ id, generation: 3, host: "rec-host" } as never)) },
    journal: {
      append: async (entry) => {
        seen.set(entry.idempotencyKey, entry as never); // keyed like the real journal: a replay overwrites
        return {} as never;
      },
    },
    ...(opts.hostId !== undefined && { host: opts.hostId }),
    log: () => {},
  });
  return { sink, recorded, seen };
}

test("settlementSink records the call once and journals one entry per settlement kind, idempotent on replay", async () => {
  const { sink, recorded, seen } = sinkRig({ hostId: "h1" });
  const base = { agent: "a", requestId: "r", model: "m", tokensIn: 1, tokensOut: 2, upstreamStatus: 200, latencyMs: 9, route: "messages" as const };
  const events: ProxySettlement[] = [
    { ...base, kind: "priced", micros: 5 },
    { ...base, kind: "estimated", micros: 4 },
    { ...base, kind: "reserve", micros: 50 },
    { ...base, kind: "failed", micros: 0, upstreamStatus: 502, errorClass: "upstream_5xx" },
  ];
  for (const e of events) await sink(e);
  assert.equal(recorded.length, 4);
  assert.deepEqual(recorded[0]?.meta, { model: "m", tokensIn: 1, tokensOut: 2, upstreamStatus: 200, latencyMs: 9, route: "messages" });
  assert.deepEqual(recorded[3]?.meta, {
    model: "m",
    tokensIn: 1,
    tokensOut: 2,
    upstreamStatus: 502,
    latencyMs: 9,
    route: "messages",
    errorClass: "upstream_5xx",
  });
  assert.equal(seen.size, 4);
  const payloads = [...seen.values()].map((v) => v.payload as Record<string, unknown>);
  assert.deepEqual(payloads.map((p) => p.settlement).sort(), ["estimated", "failed", "priced", "reserve"]);
  for (const v of seen.values()) assert.ok(v.agent === "a" && v.host === "h1" && v.generation === 3);
  const failed = payloads.find((p) => p.settlement === "failed");
  assert.equal(failed?.errorClass, "upstream_5xx");
  assert.equal(failed?.route, "messages");
  assert.equal(failed?.requestId, "r");
  for (const e of events) await sink(e); // replay: same keys
  assert.equal(seen.size, 4);
});

test("settlementSink defaults the journal host to the agent record's and survives failures", async () => {
  const a = sinkRig();
  await a.sink({ agent: "a", requestId: "r", kind: "priced", micros: 1 });
  assert.equal([...a.seen.values()][0]?.host, "rec-host");
  const none = sinkRig({ registryHas: false });
  await none.sink({ agent: "a", requestId: "r", kind: "priced", micros: 1 });
  assert.equal(none.seen.size, 0); // unknown agent: ledger still recorded, nothing journaled
  assert.equal(none.recorded.length, 1);
  const errs: string[] = [];
  const boom = settlementSink({
    debits: {
      recordCall: () => {
        throw new Error("x");
      },
    },
    registry: {
      get: async () => {
        throw new Error("y");
      },
    },
    journal: { append: async () => ({}) as never },
    log: (m) => errs.push(m),
  });
  await boom({ agent: "a", requestId: "r", kind: "priced", micros: 1 });
  assert.equal(errs.length, 2);
});

test("cache token counts reach the journal payload and the ledger meta, and are omitted when unreported", () => {
  const e = { agent: "a", requestId: "r", kind: "priced" as const, micros: 5, tokensIn: 4, tokensOut: 2994, cacheReadTokens: 1039, cacheWriteTokens: 12152 };
  assert.deepEqual(settlementPayload(e), {
    kind: "ext.pomtreed.model_settlement",
    settlement: "priced",
    micros: 5,
    requestId: "r",
    tokensIn: 4,
    tokensOut: 2994,
    cacheReadTokens: 1039,
    cacheWriteTokens: 12152,
  });
  assert.deepEqual(settlementCallMeta(e), { tokensIn: 4, tokensOut: 2994, cacheReadTokens: 1039, cacheWriteTokens: 12152 });
  const bare = settlementPayload({ ...e, cacheReadTokens: undefined, cacheWriteTokens: undefined });
  assert.equal("cacheReadTokens" in bare || "cacheWriteTokens" in bare, false);
});

test("settlementForUsage: joins only the billable settlement carrying the event's response id; token counts never join (usage-join)", () => {
  const settle = (requestId: string, settlement: string, responseId?: string, micros = 7) => ({
    payload: {
      kind: "ext.pomtreed.model_settlement",
      settlement,
      requestId,
      micros,
      tokensIn: 2,
      tokensOut: 265,
      ...(responseId !== undefined && { responseId }),
    },
  });
  const entries = [
    settle("r-failed", "failed", "msg_f", 0),
    settle("r-1", "priced", "msg_1", 256),
    settle("r-2", "priced", "msg_2", 300),
    settle("r-none", "priced", undefined, 400),
  ] as never[];
  // Equal tokens everywhere: only the response id decides.
  assert.deepEqual(settlementForUsage(entries, { responseId: "msg_2" }), { requestId: "r-2", micros: 300 });
  assert.deepEqual(settlementForUsage(entries, { responseId: "msg_1" }), { requestId: "r-1", micros: 256 });
  // Unmatched stays unmatched: no id, an unknown id, or a failed settlement never join (no free[0] fallback).
  assert.equal(settlementForUsage(entries, {}), null);
  assert.equal(settlementForUsage(entries, { responseId: "msg_x" }), null);
  assert.equal(settlementForUsage(entries, { responseId: "msg_f" }), null);
});

test("settlementPayload and settlementCallMeta carry the provider response id", () => {
  const e = { agent: "a", requestId: "r", kind: "priced", micros: 5, responseId: "msg_9" } as never;
  assert.equal(settlementPayload(e).responseId, "msg_9");
  assert.equal(settlementCallMeta(e).responseId, "msg_9");
});

test("the pricing basis rides on the journal entry and survives into the ledger row's metadata, which omits the journal-only fields", () => {
  const e = {
    agent: "a",
    requestId: "r",
    kind: "priced",
    micros: 5,
    basis: "reported",
    upstreamHost: "h",
    upstreamPath: "/p",
    upstreamMessage: "m",
  } as unknown as ProxySettlement;
  assert.equal(settlementPayload(e).basis, "reported");
  assert.deepEqual(settlementCallMeta(e), { basis: "reported" });
  for (const field of ["kind", "settlement", "micros", "requestId", "upstreamHost", "upstreamPath", "upstreamMessage"])
    assert.equal(field in settlementCallMeta(e), false, field);
});

test("a settlement with no basis (failed) journals and records none", () => {
  const e = { agent: "a", requestId: "r", kind: "failed", micros: 0 } as unknown as ProxySettlement;
  assert.equal("basis" in settlementPayload(e), false);
  assert.equal("basis" in settlementCallMeta(e), false);
});

test("settlementSink journals a daemon-authored error record for a pre-header release, and none for other failures", async () => {
  const { sink, seen } = sinkRig();
  const base = { agent: "a", requestId: "r9", kind: "failed" as const, micros: 0, errorClass: "connect" as const, route: "messages" as const };
  await sink({ ...base, releasedMicros: 70 });
  await sink({ ...base, requestId: "r10", upstreamStatus: 502 });
  const payloads = [...seen.values()].map((v) => v.payload as Record<string, unknown>);
  const notes = payloads.filter((p) => p.kind === "error");
  assert.equal(notes.length, 1);
  assert.match(String(notes[0]?.message), /r9.*before response headers \(connect\).*70 micro-USD.*may still have billed.*retry/);
  assert.equal(payloads.filter((p) => p.settlement === "failed").length, 2, "both settlements are still journaled");
  assert.equal("releasedMicros" in (payloads.find((p) => p.settlement === "failed") ?? {}), false, "the settlement payload shape is unchanged");
  await sink({ ...base, releasedMicros: 70 }); // replay is idempotent
  assert.equal([...seen.values()].filter((v) => (v.payload as { kind?: string }).kind === "error").length, 1);
});
