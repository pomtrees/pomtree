// Contract between pomtreed's model settlement journal entries (producer) and hn-digest's per-call model rows (consumer). The entries are
// the real output of settlementSink over a real store-sqlite journal; nothing here hand-writes a payload.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { encodeGatewayCredential } from "@pomtree/core";
import { MODEL_SETTLEMENT, modelCallRows, type JournalLike } from "../../../examples/hn-digest/content-model-calls.mts";
import { MODEL_SETTLEMENT_KIND, settlementSink } from "../../pomtreed/src/model-settlement.ts";
import type { ProxySettlement } from "../../pomtreed/src/model-proxy/service.ts";
import { openStore } from "@pomtree/store-sqlite";

const SECRET = "contract-secret";

const SPEC = { image: "img@sha256:contract", envManifestHash: null, extensions: [] as string[], systemPrompt: null, egress: { kind: "none" as const } };

test("the consumer's literal settlement kind is the kind pomtreed journals", () => {
  assert.equal(MODEL_SETTLEMENT, MODEL_SETTLEMENT_KIND);
});

test("model-call rows built from real settlement sink output match the producer payloads for every settlement kind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-settlement-"));
  const store = openStore(join(dir, "pomtreed.sqlite"));
  try {
    const root = await store.registry.create({
      parent: null,
      name: "hn-content",
      task: "t",
      host: "h1",
      budgetMicros: 1_000_000,
      idempotencyKey: "root",
      spec: SPEC,
    });
    const story = await store.registry.create({
      parent: root.id,
      name: "story-101",
      task: "t",
      host: "h1",
      budgetMicros: 500_000,
      idempotencyKey: "story",
      spec: SPEC,
    });
    const worker = await store.registry.create({
      parent: story.id,
      name: "analyst",
      task: "t",
      host: "h1",
      budgetMicros: 200_000,
      idempotencyKey: "worker",
      spec: SPEC,
    });

    // The real debit ledger, so the call metadata is read back from the row settlementSink wrote (not from a stub).
    const debits = store.modelDebit({ secret: SECRET, now: () => 1_000 });
    const keyOf = (agent: string) =>
      encodeGatewayCredential(SECRET, {
        agent,
        id: "a".repeat(32),
        budgetMicros: 1_000_000,
        expiresAt: 2_000,
        issuedAt: 1_000,
        models: ["anthropic/claude-haiku-5.5"],
      });
    const sink = settlementSink({
      debits,
      registry: store.registry,
      journal: store.journal,
      host: "h1",
      log: () => {},
    });
    const base = { route: "messages" as const, model: "anthropic/claude-haiku-5.5", upstreamStatus: 200, latencyMs: 830 };
    const events: ProxySettlement[] = [
      { ...base, agent: worker.id, requestId: "req-priced", kind: "priced", micros: 1500, tokensIn: 120, tokensOut: 40, finishReason: "stop" },
      { agent: worker.id, requestId: "req-estimated", kind: "estimated", micros: 700, route: "chat_completions", upstreamStatus: 200, latencyMs: 410 },
      { agent: story.id, requestId: "req-reserve", kind: "reserve", micros: 2000, route: "other" },
      {
        agent: worker.id,
        requestId: "req-cached",
        kind: "priced",
        micros: 900,
        ...base,
        tokensIn: 300,
        tokensOut: 20,
        cacheReadTokens: 256,
        cacheWriteTokens: 44,
        finishReason: "end_turn",
      },
      { agent: story.id, requestId: "req-failed", kind: "failed", micros: 0, ...base, upstreamStatus: 503, latencyMs: 90, errorClass: "upstream_5xx" },
    ];
    for (const e of events) assert.equal(debits.reserve(keyOf(e.agent), e.requestId, 1).ok, true, `reserve ${e.requestId}`);
    for (const e of events) await sink(e);

    // Producer to ledger: route and errorClass reach the debit row (a sink that dropped either fails here).
    const raw = new DatabaseSync(join(dir, "pomtreed.sqlite"));
    try {
      const ledger = (id: string) =>
        raw
          .prepare("SELECT route, error_class AS errorClass, upstream_status AS upstreamStatus FROM model_debit_requests WHERE request_id=?")
          .get(id) as Record<string, unknown>;
      assert.deepEqual({ ...ledger("req-priced") }, { route: "messages", errorClass: null, upstreamStatus: 200 });
      assert.deepEqual({ ...ledger("req-estimated") }, { route: "chat_completions", errorClass: null, upstreamStatus: 200 });
      assert.deepEqual({ ...ledger("req-reserve") }, { route: "other", errorClass: null, upstreamStatus: null });
      assert.deepEqual({ ...ledger("req-failed") }, { route: "messages", errorClass: "upstream_5xx", upstreamStatus: 503 });
    } finally {
      raw.close();
    }

    // Read the journal back the way hn-digest's collectRun does: all entries, then the registry for story attribution.
    const entries: JournalLike[] = (await store.journal.read({ limit: 100_000 })).map((e) => ({ agent: e.agent, payload: e.payload }));
    const agents = new Map((await store.registry.list()).map((a) => [a.id as string, { name: a.name, parent: a.parent ?? null }]));
    const rows = modelCallRows(entries, agents).sort((a, b) => a.requestId.localeCompare(b.requestId));

    assert.equal(entries.filter((e) => (e.payload as { kind?: string }).kind === MODEL_SETTLEMENT_KIND).length, events.length);
    assert.deepEqual(rows, [
      {
        requestId: "req-cached",
        agent: worker.id,
        story: "101",
        model: "anthropic/claude-haiku-5.5",
        tokensIn: 300,
        tokensOut: 20,
        cacheReadTokens: 256,
        cacheWriteTokens: 44,
        micros: 900,
        upstreamStatus: 200,
        latencyMs: 830,
        route: "messages",
        finishReason: "end_turn",
        settlement: "priced",
        turn: 2,
        toolCalls: 0,
      },
      {
        requestId: "req-estimated",
        agent: worker.id,
        story: "101",
        micros: 700,
        upstreamStatus: 200,
        latencyMs: 410,
        route: "chat_completions",
        settlement: "estimated",
        turn: 1,
        toolCalls: 0,
      },
      {
        requestId: "req-failed",
        agent: story.id,
        story: "101",
        model: "anthropic/claude-haiku-5.5",
        micros: 0,
        upstreamStatus: 503,
        latencyMs: 90,
        route: "messages",
        errorClass: "upstream_5xx",
        settlement: "failed",
        turn: 1,
        toolCalls: 0,
      },
      {
        requestId: "req-priced",
        agent: worker.id,
        story: "101",
        model: "anthropic/claude-haiku-5.5",
        tokensIn: 120,
        tokensOut: 40,
        micros: 1500,
        upstreamStatus: 200,
        latencyMs: 830,
        route: "messages",
        finishReason: "stop",
        settlement: "priced",
        turn: 0,
        toolCalls: 0,
      },
      { requestId: "req-reserve", agent: story.id, story: "101", micros: 2000, route: "other", settlement: "reserve", turn: 0, toolCalls: 0 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
