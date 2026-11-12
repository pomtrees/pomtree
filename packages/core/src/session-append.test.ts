import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyAppend,
  chainAfter,
  IdempotencyConflictError,
  initialSessionAppendState,
  MAX_SESSION_APPEND_BYTES,
  validateSessionAppendRequest,
  validateSessionAppendResponse,
} from "./index.ts";
import type { SessionAppendRequest } from "./index.ts";

const sha256OfBytes = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const fresh = (generation = 1) => initialSessionAppendState("ag-1", "events", generation);
const req = (text: string, offset: number, over: Partial<SessionAppendRequest> = {}): SessionAppendRequest => {
  const bytes = Buffer.from(text);
  return {
    agent: "ag-1",
    generation: 1,
    stream: "events",
    offset,
    data: bytes.toString("base64"),
    sha256: sha256OfBytes(bytes),
    idempotencyKey: `k-${offset}`,
    ...over,
  };
};

test("round trip: two appends advance the offset and chain, and the sender verifies each response", () => {
  let state = fresh();
  const a = req("hello\n", 0);
  const ra = applyAppend(state, a);
  assert.equal(ra.kind, "accepted");
  if (ra.kind !== "accepted") return;
  assert.equal(ra.response.ackedOffset, 6);
  assert.equal(Buffer.from(ra.bytes).toString(), "hello\n");
  const v = validateSessionAppendResponse(JSON.parse(JSON.stringify(ra.response)), { request: a, previousChain: state.chainSha256 });
  assert.equal(v.ok, true);
  state = ra.state;
  const b = req("world\n", 6);
  const rb = applyAppend(state, b);
  assert.equal(rb.kind, "accepted");
  if (rb.kind !== "accepted") return;
  assert.equal(rb.response.ackedOffset, 12);
  assert.equal(rb.response.chainSha256, chainAfter(chainAfter(fresh().chainSha256, a.sha256), b.sha256));
});

test("sha256 mismatch is rejected by the shared validator and by applyAppend, writing nothing", () => {
  const bad = req("hello", 0, { sha256: sha256OfBytes(Buffer.from("other")) });
  const v = validateSessionAppendRequest(bad);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.kind, "mismatch");
    assert.match(v.message, /nothing was written; re-read/);
  }
  const state = fresh();
  const r = applyAppend(state, bad);
  assert.equal(r.kind, "mismatch");
});

test("a response whose chain or offset disagrees with the sender is rejected", () => {
  const a = req("hello", 0);
  const state = fresh();
  const good = { ackedOffset: 5, chainSha256: chainAfter(state.chainSha256, a.sha256) };
  assert.equal(validateSessionAppendResponse(good, { request: a, previousChain: state.chainSha256 }).ok, true);
  const wrongChain = validateSessionAppendResponse({ ...good, chainSha256: "f".repeat(64) }, { request: a, previousChain: state.chainSha256 });
  assert.equal(wrongChain.ok, false);
  const wrongOffset = validateSessionAppendResponse({ ...good, ackedOffset: 4 }, { request: a, previousChain: state.chainSha256 });
  assert.equal(wrongOffset.ok, false);
});

test("a gap and an out-of-order offset are rejected with the acknowledged offset to resume from", () => {
  let state = fresh();
  const first = applyAppend(state, req("abc", 0));
  assert.equal(first.kind, "accepted");
  if (first.kind === "accepted") state = first.state;
  const gap = applyAppend(state, req("xyz", 10));
  assert.equal(gap.kind, "gap");
  if (gap.kind === "gap") {
    assert.equal(gap.ackedOffset, 3);
    assert.match(gap.message, /resend from 3/);
  }
  // Same bytes, new key, offset already acknowledged: not appended again.
  const behind = applyAppend(state, req("abc", 0, { idempotencyKey: "other" }));
  assert.equal(behind.kind, "outOfOrder");
  if (behind.kind === "outOfOrder") assert.match(behind.message, /resume from 3/);
});

test("an exact replay returns the original answer and adds no bytes; a reused key with other content conflicts", () => {
  const state = fresh();
  const a = req("abc", 0);
  const first = applyAppend(state, a);
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") return;
  const again = applyAppend(first.state, a);
  assert.equal(again.kind, "duplicate");
  if (again.kind === "duplicate") {
    assert.deepEqual(again.response, first.response);
    assert.equal(again.state, first.state);
    assert.equal("bytes" in again, false);
  }
  assert.throws(() => applyAppend(first.state, req("abd", 0, { idempotencyKey: a.idempotencyKey })), IdempotencyConflictError);
});

test("a stale generation is refused and a newer one is accepted", () => {
  const state = fresh(2);
  assert.equal(applyAppend(state, req("a", 0, { generation: 1 })).kind, "stale");
  const newer = applyAppend(state, req("a", 0, { generation: 3 }));
  assert.equal(newer.kind, "accepted");
  if (newer.kind === "accepted") assert.equal(newer.state.generation, 3);
});

test("an oversized chunk is rejected before decoding, and the exact limit is accepted", () => {
  const big = Buffer.alloc(MAX_SESSION_APPEND_BYTES + 1, 1);
  const over = validateSessionAppendRequest({ ...req("x", 0), data: big.toString("base64"), sha256: sha256OfBytes(big) });
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.message, /split the chunk/);
  // The pre-decode bound: a string longer than the encoding of the limit is refused before it is decoded.
  const long = validateSessionAppendRequest({ ...req("x", 0), data: "A".repeat(Math.ceil(MAX_SESSION_APPEND_BYTES / 3) * 4 + 1) });
  assert.equal(long.ok, false);
  if (!long.ok) assert.match(long.message, /longer than \d+ base64 characters/);
  const edge = Buffer.alloc(MAX_SESSION_APPEND_BYTES, 1);
  assert.equal(validateSessionAppendRequest({ ...req("x", 0), data: edge.toString("base64"), sha256: sha256OfBytes(edge) }).ok, true);
});

test("strict shape: unknown fields, bad enums, empty and non-canonical data are rejected with cause and action", () => {
  const ok = req("a", 0);
  const cases: Array<[string, unknown, RegExp]> = [
    ["unknown field", { ...ok, path: "/tmp/x" }, /unknown field\(s\) "path"/],
    ["non-object", null, /must be an object/],
    ["stream", { ...ok, stream: "other" }, /stream must be one of/],
    ["agent", { ...ok, agent: "" }, /agent must be/],
    ["generation", { ...ok, generation: -1 }, /generation must be/],
    ["offset", { ...ok, offset: 1.5 }, /offset must be/],
    ["key", { ...ok, idempotencyKey: "" }, /idempotencyKey must be/],
    ["sha format", { ...ok, sha256: "ABC" }, /64 lowercase hex/],
    ["empty data", { ...ok, data: "" }, /non-empty base64/],
    ["base64", { ...ok, data: "!!!" }, /canonical padded base64/],
  ];
  for (const [name, value, re] of cases) {
    const v = validateSessionAppendRequest(value);
    assert.equal(v.ok, false, name);
    if (!v.ok) {
      assert.equal(v.kind, "invalid", name);
      assert.match(v.message, re, name);
    }
  }
  assert.equal(validateSessionAppendResponse({ ackedOffset: 1, chainSha256: "a".repeat(64), extra: 1 }).ok, false);
  assert.equal(validateSessionAppendResponse({ ackedOffset: -1, chainSha256: "a".repeat(64) }).ok, false);
  assert.equal(validateSessionAppendResponse({ ackedOffset: 1, chainSha256: "zz" }).ok, false);
});

test("a higher generation continues the stream at the acknowledged offset and keeps the chain", () => {
  const a = applyAppend(fresh(1), req("abc", 0));
  assert.equal(a.kind, "accepted");
  if (a.kind !== "accepted") return;
  const b = req("def", 3, { generation: 2 });
  const rb = applyAppend(a.state, b);
  assert.equal(rb.kind, "accepted");
  if (rb.kind !== "accepted") return;
  assert.equal(rb.state.generation, 2);
  assert.equal(rb.response.chainSha256, chainAfter(a.response.chainSha256, b.sha256));
  // A higher generation that restarts at 0 while bytes are held resyncs the sender instead of rewriting the stream.
  const restart = applyAppend(a.state, req("zzz", 0, { generation: 2, idempotencyKey: "r" }));
  assert.equal(restart.kind, "outOfOrder");
  if (restart.kind === "outOfOrder") assert.equal(restart.ackedOffset, 3);
});

test("only the last append replays: an earlier retry is outOfOrder and a retry from an older generation is stale", () => {
  const a = req("abc", 0);
  const ra = applyAppend(fresh(1), a);
  assert.equal(ra.kind, "accepted");
  if (ra.kind !== "accepted") return;
  const rb = applyAppend(ra.state, req("def", 3));
  assert.equal(rb.kind, "accepted");
  if (rb.kind !== "accepted") return;
  const early = applyAppend(rb.state, a);
  assert.equal(early.kind, "outOfOrder");
  if (early.kind === "outOfOrder") assert.equal(early.ackedOffset, 6);
  const gen2 = applyAppend(rb.state, req("ghi", 6, { generation: 2 }));
  assert.equal(gen2.kind, "accepted");
  if (gen2.kind !== "accepted") return;
  assert.equal(applyAppend(gen2.state, req("def", 3)).kind, "stale");
});

test("a request for another agent or stream is refused with cause and action", () => {
  const state = fresh();
  for (const over of [{ agent: "ag-2" }, { stream: "session" as const }]) {
    const r = applyAppend(state, req("a", 0, over));
    assert.equal(r.kind, "invalid");
    if (r.kind === "invalid") assert.match(r.message, /route the append to its own stream/);
  }
});

test("echoed text is clipped and printing never throws; non-plain objects are refused", () => {
  const long = "x".repeat(500);
  const v = validateSessionAppendRequest({ ...req("a", 0), [long]: 1 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.message.length < 400, String(v.message.length));
  const big = validateSessionAppendRequest({ ...req("a", 0), generation: 10n });
  assert.equal(big.ok, false);
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.equal(validateSessionAppendRequest({ ...req("a", 0), offset: cyc }).ok, false);
  assert.equal(validateSessionAppendRequest(new Map()).ok, false);
  assert.equal(validateSessionAppendRequest(new (class X {})()).ok, false);
  assert.equal(validateSessionAppendResponse(new Map()).ok, false);
});

test("malformed chain digests are refused", () => {
  const a = req("a", 0);
  assert.equal(validateSessionAppendResponse({ ackedOffset: 1, chainSha256: "a".repeat(64) }, { request: a, previousChain: "nope" }).ok, false);
  assert.throws(() => applyAppend({ ...fresh(), chainSha256: "nope" }, a), /not 64 lowercase hex/);
});
