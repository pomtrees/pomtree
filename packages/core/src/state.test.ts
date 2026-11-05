import assert from "node:assert/strict";
import test from "node:test";
import {
  memoKey,
  POMTREED_KINDS,
  STATE_DOC_BYTES_CEILING,
  STATE_DOC_BYTES_CONFIG_MAX,
  STATE_LIMITS_DEFAULT,
  STATE_OWNER_RE,
  type StateErrorKind,
  StateError,
  validStateKey,
} from "./index.ts";

const validKey = validStateKey;

test("state key table: accepted and rejected", () => {
  const ok = ["a", "seen/2026-10-20", "a.b_c-d/e", "0abc", "a".repeat(128), "x/y/z", "v1.2"];
  const bad = ["", "..", "a/../b", "a..b", "../a", "/a", "a/", "A", "a/B", "a b", "a\0b", ".hidden", "a/.hidden", "a//b", "a".repeat(129), "-a", "a\\b"];
  for (const k of ok) assert.ok(validKey(k), JSON.stringify(k));
  for (const k of bad) assert.ok(!validKey(k), JSON.stringify(k));
});

test("state owner regex", () => {
  assert.ok(STATE_OWNER_RE.test("hn-digest"));
  assert.ok(STATE_OWNER_RE.test("operator"));
  assert.ok(!STATE_OWNER_RE.test("Hn"));
  assert.ok(!STATE_OWNER_RE.test("a/b"));
  assert.ok(!STATE_OWNER_RE.test(""));
});

test("state constants are pinned", () => {
  assert.equal(STATE_DOC_BYTES_CEILING, 1_048_576);
  assert.ok(STATE_DOC_BYTES_CONFIG_MAX > STATE_LIMITS_DEFAULT.maxDocBytes && STATE_DOC_BYTES_CONFIG_MAX < STATE_DOC_BYTES_CEILING);
  assert.deepEqual(STATE_LIMITS_DEFAULT, { maxDocs: 1000, maxDocBytes: 131_072, maxOwnerBytes: 16_777_216, maxTombstones: 1000 });
  assert.ok(STATE_LIMITS_DEFAULT.maxDocBytes <= STATE_DOC_BYTES_CEILING);
  assert.equal(POMTREED_KINDS.stateOp, "ext.pomtreed.state_op");
});

test("StateError kinds are exhaustive", () => {
  const kinds = {
    "invalid-key": true,
    "invalid-value": true,
    "too-large": true,
    "quota-docs": true,
    "quota-owner-bytes": true,
    "idempotency-mismatch": true,
    "unknown-writer": true,
  } satisfies Record<StateErrorKind, true>;
  for (const kind of Object.keys(kinds) as StateErrorKind[]) {
    const e = new StateError(kind, "x");
    assert.equal(e.kind, kind);
    assert.equal(e.name, "StateError");
  }
});

test("memoKey is stable, order-insensitive, and sensitive to digest and code version", () => {
  const a = memoKey({ x: 1, y: [1, { p: 1, q: 2 }] }, "d1", "v1");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(validKey(a));
  assert.equal(a, memoKey({ y: [1, { q: 2, p: 1 }], x: 1 }, "d1", "v1"));
  assert.notEqual(a, memoKey({ x: 1, y: [1, { p: 1, q: 2 }] }, "d2", "v1"));
  assert.notEqual(a, memoKey({ x: 1, y: [1, { p: 1, q: 2 }] }, "d1", "v2"));
  assert.notEqual(a, memoKey({ x: 2, y: [1, { p: 1, q: 2 }] }, "d1", "v1"));
  assert.notEqual(memoKey("ab", "c", "d"), memoKey("a", "bc", "d"));
});
