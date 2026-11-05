import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointOf } from "./checkpoint.ts";
import { UnsupportedCheckpointVersion } from "./errors.ts";
import { CHECKPOINT_FORMAT, isLevelKind, type Checkpoint } from "./types.ts";

const body = { id: "c1", agent: "a" } as unknown as Omit<Checkpoint, "version">;

test("checkpointOf refuses a checkpoint with no version, naming the cause and the action", () => {
  assert.throws(
    () => checkpointOf(body),
    (e) => e instanceof UnsupportedCheckpointVersion && e.version === undefined && /no format version.*remove or re-create the agent/.test(e.message),
  );
});

test("checkpointOf refuses a version other than CHECKPOINT_FORMAT, above or below", () => {
  for (const v of [CHECKPOINT_FORMAT + 1, CHECKPOINT_FORMAT - 1, 0])
    assert.throws(
      () => checkpointOf({ ...body, version: v }),
      (e) => e instanceof UnsupportedCheckpointVersion && e.version === v,
      String(v),
    );
});

test("checkpointOf accepts the current version and round-trips the body through JSON", () => {
  const cp = { ...body, version: CHECKPOINT_FORMAT } as Checkpoint;
  assert.deepEqual(checkpointOf(JSON.parse(JSON.stringify(cp))), cp);
});

test("isLevelKind classifies signal kinds", () => {
  for (const k of ["nudge", "cancel", "timeout", "pause", "budget_exceeded", "budget_warning"]) assert.equal(isLevelKind(k), true, k);
  for (const k of ["message", "human_message", "human_answer", "child_exited", "escalation"]) assert.equal(isLevelKind(k), false, k);
});
