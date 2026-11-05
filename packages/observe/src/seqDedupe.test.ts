import assert from "node:assert/strict";
import { test } from "node:test";
import { SeqDedupe } from "./seqDedupe.ts";

test("a large out-of-order stream still dedupes correctly while the seen set stays bounded", () => {
  const d = new SeqDedupe();
  const N = 2000;
  // Swapped pairs (2,1,4,3,...): every seq exactly once, each at most one position out
  // of order, so the retained set should never exceed a single pending seq.
  const seqs: number[] = [];
  for (let i = 1; i <= N; i += 2) seqs.push(i + 1, i);
  let maxSeen = 0;
  for (const s of seqs) {
    assert.equal(d.accept(s), true, `first delivery of seq ${s} should apply`);
    maxSeen = Math.max(maxSeen, d.size);
  }
  assert.ok(maxSeen <= 1, `seen set stays bounded (max retained ${maxSeen})`);
  assert.equal(d.size, 0);
  // Re-delivering any seq, including ones long dropped below the low-water mark, is a dup.
  for (const s of seqs) assert.equal(d.accept(s), false, `re-delivery of seq ${s} should be a duplicate`);
});

test("a duplicate inside the retained out-of-order tail is rejected", () => {
  const d = new SeqDedupe();
  assert.equal(d.accept(3), true);
  assert.equal(d.accept(3), false);
  assert.equal(d.size, 1);
});
