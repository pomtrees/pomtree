import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleUpsertKey } from "./schedule-key.ts";

const A = { id: "s", cron: "* * * * *", task: "a", missed: "skip", overlap: "skip", jitterMs: 0 } as const;
const B = { ...A, task: "b" };

test("A -> B -> A produces three distinct keys; a retry dedupes", () => {
  const k1 = scheduleUpsertKey(A, null);
  const k2 = scheduleUpsertKey(B, A);
  const k3 = scheduleUpsertKey(A, B);
  assert.equal(new Set([k1, k2, k3]).size, 3);
  assert.equal(scheduleUpsertKey(B, A), k2);
});

test("an unset paused flag keys the same as paused:false; paused:true differs", () => {
  assert.equal(scheduleUpsertKey(A, null), scheduleUpsertKey({ ...A, paused: false }, null));
  assert.notEqual(scheduleUpsertKey(A, null), scheduleUpsertKey({ ...A, paused: true }, null));
});
