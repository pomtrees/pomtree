import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLock, lockHeld, parseLock } from "./state-lock.ts";

const rec = { pid: 42, boot: "B1", start: "S1" };

test("lockHeld decision table", () => {
  assert.equal(lockHeld(rec, false, null, "B1"), false, "dead pid");
  assert.equal(lockHeld(rec, true, "S2", "B1"), false, "reused pid, different start time");
  assert.equal(lockHeld(rec, true, "S1", "B2"), false, "different boot");
  assert.equal(lockHeld(rec, true, "S1", "B1"), true, "same identity");
  assert.equal(lockHeld({ pid: 42, boot: null, start: null }, true, "S9", "B9"), true, "legacy: liveness only");
  assert.equal(lockHeld(rec, true, null, null), true, "probe failure is unknown, not mismatch");
});

test("lock format round-trips and parses legacy and corrupt files", () => {
  assert.deepEqual(parseLock(formatLock(rec)), rec);
  assert.deepEqual(parseLock("42\n"), { pid: 42, boot: null, start: null });
  assert.equal(parseLock(""), null);
  assert.equal(parseLock("junk\n"), null);
});
