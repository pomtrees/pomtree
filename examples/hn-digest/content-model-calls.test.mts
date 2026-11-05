import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkModelCalls, type JournalLike, modelCallRows, modelCallsFile } from "./content-model-calls.mts";
import { FEED_STORY, storyOfAuditRow } from "./content-live-run.mts";

const AGENTS = new Map<string, { name: string; parent?: string | null }>([
  ["root", { name: "hn-content", parent: null }],
  ["story-a", { name: "story-101", parent: "root" }],
  ["worker-a", { name: "analyst", parent: "story-a" }],
  ["orphan", { name: "scratch", parent: null }],
]);

const settlement = (agent: string, payload: Record<string, unknown>): JournalLike => ({
  agent,
  payload: { kind: "ext.pomtreed.model_settlement", ...payload },
});

const PRICED = settlement("worker-a", {
  settlement: "priced",
  micros: 1500,
  requestId: "req-1",
  model: "anthropic/claude-haiku-5.5",
  tokensIn: 120,
  tokensOut: 40,
  upstreamStatus: 200,
  latencyMs: 830,
  route: "messages",
  finishReason: "stop",
});
const ESTIMATED = settlement("worker-a", {
  settlement: "estimated",
  micros: 700,
  requestId: "req-2",
  upstreamStatus: 200,
  latencyMs: 410,
  route: "chat_completions",
});
const RESERVE = settlement("story-a", { settlement: "reserve", micros: 2000, requestId: "req-3", route: "other" });
const FAILED = settlement("story-a", {
  settlement: "failed",
  micros: 0,
  requestId: "req-4",
  model: "anthropic/claude-haiku-5.5",
  latencyMs: 90,
  route: "messages",
  errorClass: "upstream_5xx",
  upstreamStatus: 503,
});

describe("modelCallRows", () => {
  it("builds one exact row per settlement entry across priced, estimated, reserve and failed kinds", () => {
    const rows = modelCallRows([PRICED, ESTIMATED, RESERVE, FAILED], AGENTS);
    assert.deepEqual(rows, [
      {
        requestId: "req-1",
        agent: "worker-a",
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
      {
        requestId: "req-2",
        agent: "worker-a",
        story: "101",
        micros: 700,
        upstreamStatus: 200,
        latencyMs: 410,
        route: "chat_completions",
        settlement: "estimated",
        turn: 1,
        toolCalls: 0,
      },
      { requestId: "req-3", agent: "story-a", story: "101", micros: 2000, route: "other", settlement: "reserve", turn: 0, toolCalls: 0 },
      {
        requestId: "req-4",
        agent: "story-a",
        story: "101",
        model: "anthropic/claude-haiku-5.5",
        micros: 0,
        latencyMs: 90,
        route: "messages",
        errorClass: "upstream_5xx",
        upstreamStatus: 503,
        settlement: "failed",
        turn: 1,
        toolCalls: 0,
      },
    ]);
  });

  it("adds timestamps, a per-agent turn and the tool calls each response produced", () => {
    const at = (e: JournalLike, ts: number): JournalLike => ({ ...e, ts });
    const call = (agent: string, ts: number): JournalLike => ({
      agent,
      ts,
      payload: { kind: "tool_call", tool: "article_page", callId: `c${ts}`, input: { page: 1 } },
    });
    const rows = modelCallRows(
      [
        call("worker-a", 900),
        at(PRICED, 10_000),
        call("worker-a", 10_100),
        call("worker-a", 10_200),
        call("story-a", 10_250),
        at(ESTIMATED, 12_000),
        call("worker-a", 12_100),
      ],
      AGENTS,
    );
    // A call before the agent's first settlement belongs to no row; the other agent's call is not counted for worker-a.
    assert.deepEqual(
      rows.map((r) => [r.requestId, r.turn, r.toolCalls, r.settledAt, r.startedAt]),
      [
        ["req-1", 0, 2, "1970-01-01T00:00:10.000Z", "1970-01-01T00:00:09.170Z"],
        ["req-2", 1, 1, "1970-01-01T00:00:12.000Z", "1970-01-01T00:00:11.590Z"],
      ],
    );
    // Without journal times no timestamp is invented.
    const [bare] = modelCallRows([PRICED], AGENTS);
    assert.equal("settledAt" in (bare ?? {}) || "startedAt" in (bare ?? {}), false);
    // startedAt needs a latency: a settlement without one gets settledAt only.
    const [noLatency] = modelCallRows([at(RESERVE, 5000)], AGENTS);
    assert.deepEqual([noLatency?.settledAt, noLatency?.startedAt], ["1970-01-01T00:00:05.000Z", undefined]);
  });

  it("omits undefined keys for missing optional fields and keeps errorClass only on failed calls", () => {
    const [row] = modelCallRows([ESTIMATED], AGENTS);
    assert.ok(row);
    for (const key of ["model", "tokensIn", "tokensOut", "errorClass", "finishReason"]) assert.equal(key in row, false, key);
    assert.equal(Object.values(row).includes(undefined), false);
  });

  it("ignores entries of other kinds", () => {
    const other: JournalLike = { agent: "root", payload: { kind: "ext.pomtreed.workflow_state", value: { seen: [1] } } };
    assert.deepEqual(
      modelCallRows([other, PRICED, { agent: "root", payload: null }], AGENTS).map((r) => r.requestId),
      ["req-1"],
    );
  });

  it("resolves story from the registry and marks an agent with no story ancestor as unattributed", () => {
    const stray = settlement("orphan", { settlement: "priced", micros: 5, requestId: "req-5", route: "messages" });
    const unknown = settlement("ghost", { settlement: "priced", micros: 6, requestId: "req-6", route: "messages" });
    const rows = modelCallRows([stray, unknown], AGENTS);
    assert.deepEqual(
      rows.map((r) => [r.requestId, r.story]),
      [
        ["req-5", "unattributed"],
        ["req-6", "unattributed"],
      ],
    );
  });

  it("returns no rows for an empty journal", () => {
    assert.deepEqual(modelCallRows([], AGENTS), []);
  });

  it("carries cache read and write tokens when the settlement has both", () => {
    const cached = settlement("worker-a", {
      settlement: "priced",
      micros: 900,
      requestId: "req-7",
      tokensIn: 300,
      tokensOut: 20,
      cacheReadTokens: 256,
      cacheWriteTokens: 44,
      route: "messages",
    });
    const [row] = modelCallRows([cached], AGENTS);
    assert.equal(row?.cacheReadTokens, 256);
    assert.equal(row?.cacheWriteTokens, 44);
  });

  it("omits cache token keys when the settlement carries neither", () => {
    const [row] = modelCallRows([PRICED], AGENTS);
    assert.ok(row);
    for (const key of ["cacheReadTokens", "cacheWriteTokens"]) assert.equal(key in row, false, key);
  });

  it("carries finishReason from a 2xx settlement and omits it when the response reported none", () => {
    const [withReason] = modelCallRows([PRICED], AGENTS);
    assert.equal(withReason?.finishReason, "stop");
    const [withoutReason] = modelCallRows([FAILED], AGENTS);
    assert.equal("finishReason" in (withoutReason ?? {}), false);
  });

  it("carries only the cache token key that is present", () => {
    const readOnly = settlement("worker-a", { settlement: "priced", micros: 900, requestId: "req-8", cacheReadTokens: 12, route: "messages" });
    const [row] = modelCallRows([readOnly], AGENTS);
    assert.equal(row?.cacheReadTokens, 12);
    assert.equal("cacheWriteTokens" in (row ?? {}), false);
  });
});

describe("modelCallsFile", () => {
  it("carries a warning when the journal had no model settlement entries", () => {
    assert.deepEqual(modelCallsFile([]), {
      rows: [],
      warning: "journal had no ext.pomtreed.model_settlement entries",
    });
  });

  it("carries no warning key when there are rows", () => {
    const file = modelCallsFile(modelCallRows([PRICED], AGENTS));
    assert.equal(file.rows.length, 1);
    assert.equal("warning" in file, false);
  });
});

describe("checkModelCalls", () => {
  const rows = [
    { requestId: "a", micros: 1000 },
    { requestId: "b", micros: 500 },
  ];

  it("passes when the row micros sum to the ledger total and requestIds are unique", () => {
    const v = checkModelCalls(rows, 1500);
    assert.equal(v.ok, true);
    assert.equal(typeof v.detail, "string");
  });

  it("fails when the row micros sum differs from the ledger total", () => {
    const v = checkModelCalls(rows, 1501);
    assert.equal(v.ok, false);
    assert.match(v.detail, /1500/);
    assert.match(v.detail, /1501/);
  });

  it("fails on a duplicate requestId even when the sum matches", () => {
    const v = checkModelCalls([rows[0] as (typeof rows)[number], { requestId: "a", micros: 500 }], 1500);
    assert.equal(v.ok, false);
    assert.match(v.detail, /duplicate requestId a/);
  });

  it("passes with no rows only when the ledger total is zero", () => {
    const v = checkModelCalls([], 0);
    assert.equal(v.ok, true);
    assert.match(v.detail, /no model-call rows/);
  });

  it("fails with no rows when the ledger total is above zero (a broken settlement journal is not reconciled)", () => {
    const v = checkModelCalls([], 12345);
    assert.equal(v.ok, false);
    assert.match(v.detail, /no model-call rows .* 12345/);
  });
});

describe("storyOfAuditRow", () => {
  const modelStory = new Map([["req-1", "101"]]);
  const attribute = (r: Parameters<typeof storyOfAuditRow>[0]) => storyOfAuditRow(r, AGENTS, modelStory);

  it("keeps a story the record already carries", () => {
    assert.equal(attribute({ stream: "host", story: "7" }), "7");
  });

  it("takes the story of a resolvable agent", () => {
    assert.equal(attribute({ stream: "host", agent: "worker-a" }), "101");
  });

  it("marks a host feed or item fetch with no story and no resolvable agent as the feed", () => {
    assert.equal(FEED_STORY, "feed");
    assert.equal(attribute({ stream: "host", agent: "root" }), FEED_STORY);
    assert.equal(attribute({ stream: "host" }), FEED_STORY);
  });

  it("attributes a model-call egress row by requestId to the story of its model row", () => {
    assert.equal(attribute({ stream: "sb-1", route: "messages", requestId: "req-1" }), "101");
  });

  it("leaves a model-call row with an unknown requestId unattributed, not feed", () => {
    assert.equal(attribute({ stream: "host", route: "messages", requestId: "req-9" }), "unattributed");
  });

  it("leaves an unresolvable container row unattributed", () => {
    assert.equal(attribute({ stream: "sb-1", agent: "ghost" }), "unattributed");
  });
});
