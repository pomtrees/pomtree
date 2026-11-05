import { createHash } from "node:crypto";
import type { Schedule } from "@pomtree/core";

type Fields = Omit<Schedule, "createdAt">;

const canonical = (s: Fields | null): string =>
  JSON.stringify(s === null ? null : [s.id, s.cron, s.tz ?? null, s.task, s.missed, s.overlap, s.jitterMs, s.paused ?? false]);

// Idempotency key for `schedules.upsert`. Keyed on the requested fields AND the schedule's
// current stored state, so A -> B -> A is three distinct writes (a key from fields alone would
// replay the cached A result and silently skip the revert), while a retry of the same request
// against the same stored state still dedupes. Pure.
export function scheduleUpsertKey(next: Fields, current: Fields | null): string {
  return createHash("sha256")
    .update(`${canonical(next)}|${canonical(current)}`)
    .digest("hex");
}
