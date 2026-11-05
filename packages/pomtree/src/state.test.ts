import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_KEY_MAX_LENGTH, STATE_KEY_RE, checkStateOwner, checkStatePrefix, validStateKey } from "@pomtree/core";
import {
  STATE_KEY_MAX_LENGTH_LOCAL,
  STATE_KEY_RE_LOCAL,
  parseExpectRev,
  chunkImportDocs,
  parseImportFile,
  parseOlderThan,
  stateErrorMessage,
  validKey,
  validOwner,
  validPrefix,
} from "./state.ts";

const accepts = (f: () => void) => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};

// state.ts keeps local copies of the state rules instead of importing core; they are pinned against core's definitions here.
test("local state key/owner/prefix rules agree with core's", () => {
  assert.equal(STATE_KEY_MAX_LENGTH_LOCAL, STATE_KEY_MAX_LENGTH);
  assert.equal(STATE_KEY_RE_LOCAL.source, STATE_KEY_RE.source);
  const table = [
    "a",
    "a/b",
    "a.b_c-d/e",
    "0x",
    "memo/abc123",
    "",
    "/a",
    "a/",
    "a//b",
    "A",
    "a b",
    "-a",
    ".a",
    "a/.b",
    "a/../b",
    "..",
    "a..b",
    "a\u0000b",
    "é",
    "a".repeat(128),
    "a".repeat(129),
    "x/".repeat(64).slice(0, 127),
  ];
  for (const k of table) assert.equal(validKey(k), validStateKey(k), `key ${JSON.stringify(k)}`);
  for (const o of ["operator", "hn-digest", "a_b", "", "A", "-x", "a/b", "a.b", "a".repeat(128), "a".repeat(129), "é"]) {
    assert.equal(
      validOwner(o),
      accepts(() => checkStateOwner(o)),
      `owner ${JSON.stringify(o)}`,
    );
  }
  for (const p of ["a", "a/", "a/b", "ab.c", "", "A", "a..b", "..", "a b", "a".repeat(128), "a".repeat(129), "/", "-"]) {
    assert.equal(
      validPrefix(p),
      accepts(() => checkStatePrefix(p)),
      `prefix ${JSON.stringify(p)}`,
    );
  }
});

test("parseOlderThan and parseExpectRev", () => {
  assert.equal(parseOlderThan("30d"), 30 * 86_400_000);
  assert.equal(parseOlderThan("12h"), 43_200_000);
  assert.equal(parseOlderThan("500"), 500);
  for (const bad of ["", "d", "-1d", "1.5h", "1w", "x"]) assert.throws(() => parseOlderThan(bad), /older-than/);
  assert.equal(parseExpectRev("none"), null);
  assert.equal(parseExpectRev("0"), 0);
  assert.equal(parseExpectRev("7"), 7);
  for (const bad of ["", "-1", "1.5", "abc"]) assert.throws(() => parseExpectRev(bad), /expect-rev/);
});

test("parseImportFile ignores owner and rev, rejects bad shapes", () => {
  assert.deepEqual(
    parseImportFile(
      JSON.stringify({
        owner: "x",
        docs: [
          { key: "a/b", rev: 9, value: { n: 1 } },
          { key: "c", value: null },
        ],
      }),
    ),
    [
      { key: "a/b", value: { n: 1 } },
      { key: "c", value: null },
    ],
  );
  for (const bad of [
    "nope",
    "[]",
    "{}",
    '{"docs":[]}',
    '{"docs":[{"key":"A","value":1}]}',
    '{"docs":[{"key":"a"}]}',
    '{"docs":[{"key":"a","value":1},{"key":"a","value":2}]}',
  ]) {
    assert.throws(() => parseImportFile(bad), Error, bad);
  }
  assert.throws(() => parseImportFile(JSON.stringify({ docs: Array.from({ length: 1001 }, (_, i) => ({ key: `k${i}`, value: i })) })), /1 to 1000/);
});

test("stateErrorMessage shows currentRev on conflict and strips control characters", () => {
  assert.match(stateErrorMessage(409, { error: "state revision conflict", reason: "conflict", currentRev: 4 }), /current rev is 4/);
  assert.match(stateErrorMessage(409, { error: "quota exceeded", kind: "quota" }), /quota exceeded \(quota\)/);
  assert.equal(stateErrorMessage(403, { error: "no write grant for x\u001b[31m" }), "no write grant for x");
  assert.equal(stateErrorMessage(500, null), "HTTP 500");
});

test("chunkImportDocs: batches stay under the byte budget and the doc cap, keep order, and never drop or split a doc", () => {
  const big = (i: number, bytes: number) => ({ key: `k${i}`, value: "x".repeat(bytes) });
  const docs = [big(0, 400), big(1, 400), big(2, 400), big(3, 50), big(4, 2000)];
  const out = chunkImportDocs(docs, 1000);
  assert.deepEqual(
    out.map((b) => b.map((d) => d.key)),
    [["k0", "k1"], ["k2", "k3"], ["k4"]],
  );
  assert.deepEqual(out.flat(), docs);
  for (const b of out.slice(0, 2)) assert.ok(b.reduce((n, d) => n + Buffer.byteLength(JSON.stringify(d)) + 1, 0) <= 1000);
  assert.deepEqual(chunkImportDocs([]), []);
  const many = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}`, value: i }));
  assert.equal(chunkImportDocs(many).length, 1);
  assert.equal(
    chunkImportDocs(many, 100).every((b) => b.length >= 1),
    true,
  );
});
