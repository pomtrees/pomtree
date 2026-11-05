import assert from "node:assert/strict";
import { test } from "node:test";
import type { Schedule } from "@pomtree/core";
import { cronError, renderScheduleTable } from "./sched.ts";

const sched = (o: Partial<Schedule> = {}): Schedule => ({
  id: "s1",
  cron: "*/5 * * * *",
  tz: "UTC",
  task: "do work",
  missed: "skip",
  overlap: "skip",
  jitterMs: 0,
  createdAt: 0,
  ...o,
});

test("cronError accepts 5-field expressions", () => {
  assert.equal(cronError("*/5 * * * *"), null);
  assert.equal(cronError("0 9 * * 1-5"), null);
  assert.equal(cronError("0 0 1 1 *"), null);
  assert.equal(cronError("  0  9  *  *  *  "), null);
  assert.equal(cronError("0,30 9-17 * * *"), null);
});

test("cronError rejects wrong field counts", () => {
  assert.match(cronError("")!, /5 fields/);
  assert.match(cronError("* * * *")!, /5 fields/);
  assert.match(cronError("* * * * * *")!, /5 fields/);
  assert.match(cronError("garbage")!, /5 fields/);
});

test("cronError accepts name-style fields and leaves semantics to the daemon", () => {
  // The daemon's parseCron is authoritative; pomtree only gates on the 5-field shape.
  assert.equal(cronError("0 9 * * MON"), null);
  assert.equal(cronError("0 0 1 JAN *"), null);
  assert.equal(cronError("0 9 * * ?"), null);
  assert.equal(cronError("0 9 * * 7#1"), null);
});

test("renderScheduleTable renders the header, rows and defaults", () => {
  const out = renderScheduleTable([sched()]);
  assert.match(out, /^ID\s+CRON\s+TZ\s+TASK\s+MISSED\s+OVERLAP\s+JITTER/);
  assert.match(out, /s1/);
  assert.match(out, /skip/);
  assert.match(out, /\*\/5 \* \* \* \*/);
  const noTz = renderScheduleTable([sched({ tz: undefined })]);
  assert.match(noTz, /-/);
  assert.equal(renderScheduleTable([]), "no schedules");
});

test("renderScheduleTable shows the wake target and marks an orphaned one", () => {
  const out = renderScheduleTable([sched({ agent: "a1" }), sched({ id: "s2", agent: "a2", orphaned: true }), sched({ id: "s3" })]);
  assert.match(out, /TARGET/);
  assert.match(out, /a1/);
  assert.match(out, /a2 \(orphaned\)/);
});
