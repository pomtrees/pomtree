import { test } from "node:test";
import assert from "node:assert/strict";
import { CronSchedule, nextFire, parseCron, prevFire } from "./cron.ts";

const utc = (s: string) => Date.parse(s);

test("every minute", () => {
  assert.equal(nextFire("* * * * *", utc("2026-01-01T00:00:00Z")), utc("2026-01-01T00:01:00Z"));
  assert.equal(nextFire("* * * * *", utc("2026-01-01T00:00:30Z")), utc("2026-01-01T00:01:00Z"));
});

test("strictly after", () => {
  assert.equal(nextFire("0 9 * * *", utc("2026-01-01T09:00:00Z")), utc("2026-01-02T09:00:00Z"));
});

test("day skip from 23:59 lands exactly on next midnight", () => {
  assert.equal(nextFire("0 0 2 * *", utc("2026-01-01T23:58:00Z")), utc("2026-01-02T00:00:00Z"));
});

test("hour skip lands on next allowed hour at minute zero", () => {
  assert.equal(nextFire("0 1 * * *", utc("2026-01-01T00:58:30Z")), utc("2026-01-01T01:00:00Z"));
});

test("steps, lists, ranges", () => {
  assert.equal(nextFire("*/15 * * * *", utc("2026-01-01T00:16:00Z")), utc("2026-01-01T00:30:00Z"));
  assert.equal(nextFire("5,10 1-2 * * *", utc("2026-01-01T01:10:00Z")), utc("2026-01-01T02:05:00Z"));
  assert.equal(nextFire("0 0 1-10/3 * *", utc("2026-01-02T00:00:00Z")), utc("2026-01-04T00:00:00Z"));
});

test("day-of-week, 7 is Sunday", () => {
  // 2026-01-01 is a Thursday; next Sunday is the 4th.
  assert.equal(nextFire("0 0 * * 7", utc("2026-01-01T00:00:00Z")), utc("2026-01-04T00:00:00Z"));
  assert.equal(nextFire("0 0 * * 0", utc("2026-01-01T00:00:00Z")), utc("2026-01-04T00:00:00Z"));
});

test("dom and dow both restricted match either", () => {
  // 15th OR Monday: Monday Jan 5 comes before Jan 15.
  assert.equal(nextFire("0 0 15 * 1", utc("2026-01-01T00:00:00Z")), utc("2026-01-05T00:00:00Z"));
});

test("month rollover and leap day", () => {
  assert.equal(nextFire("0 0 29 2 *", utc("2026-01-01T00:00:00Z")), utc("2028-02-29T00:00:00Z"));
  assert.equal(nextFire("0 0 1 1 *", utc("2026-06-01T00:00:00Z")), utc("2027-01-01T00:00:00Z"));
});

test("impossible date returns null", () => {
  assert.equal(nextFire("0 0 31 2 *", utc("2026-01-01T00:00:00Z")), null);
});

test("parse errors", () => {
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "a * * * *", "5-1 * * * *", "1,, * * * *"]) {
    assert.throws(() => parseCron(bad), Error, bad);
  }
});

test("rejects a field with more than one slash", () => {
  assert.throws(() => parseCron("*/2/3 * * * *"), Error);
  assert.throws(() => parseCron("1/2/3 * * * *"), Error);
  assert.throws(() => parseCron("0 0 1-10/3/2 * *"), Error);
});

test("time zone: wall clock in New York", () => {
  // 09:00 EST (UTC-5) in January.
  assert.equal(nextFire("0 9 * * *", utc("2026-01-15T00:00:00Z"), "America/New_York"), utc("2026-01-15T14:00:00Z"));
  // 09:00 EDT (UTC-4) in July.
  assert.equal(nextFire("0 9 * * *", utc("2026-07-15T00:00:00Z"), "America/New_York"), utc("2026-07-15T13:00:00Z"));
});

test("DST spring-forward: skipped local time does not fire that day", () => {
  // 2026-03-08 02:30 does not exist in New York; next fire is the following day (EDT, UTC-4).
  assert.equal(nextFire("30 2 * * *", utc("2026-03-08T00:00:00Z"), "America/New_York"), utc("2026-03-09T06:30:00Z"));
});

test("DST fall-back: repeated local time fires once, at the first instant", () => {
  // 2026-11-01 01:30 happens at 05:30Z (EDT) and 06:30Z (EST); the second is a repeat.
  const first = nextFire("30 1 * * *", utc("2026-11-01T00:00:00Z"), "America/New_York");
  assert.equal(first, utc("2026-11-01T05:30:00Z"));
  // The repeat at 06:30Z is skipped; the next fire is the following day (EST).
  assert.equal(nextFire("30 1 * * *", first!, "America/New_York"), utc("2026-11-02T06:30:00Z"));
});

test("DST spring-forward: 03:00 right after the gap fires that day", () => {
  // 2026-03-08 02:00 EST jumps to 03:00 EDT at 07:00Z; 03:00 EDT is the first instant of that wall time.
  assert.equal(nextFire("0 3 * * *", utc("2026-03-08T00:00:00Z"), "America/New_York"), utc("2026-03-08T07:00:00Z"));
});

test("day skip does not miss midnight after spring-forward", () => {
  // Sunday 2026-03-08 00:30 EST is the invalid day for a Monday-only schedule.
  // DST starts at 02:00 that day, so the next fire is Monday 2026-03-09 00:00 EDT.
  assert.equal(nextFire("0 0 * * 1", utc("2026-03-08T05:30:00Z"), "America/New_York"), utc("2026-03-09T04:00:00Z"));
});

test("DST fall-back: 02:00 after the repeat fires once, on the same day", () => {
  // 2026-11-01 02:00 EST happens once, at 07:00Z, three hours after the 01:00 EST repeat began.
  assert.equal(nextFire("0 2 * * *", utc("2026-11-01T00:00:00Z"), "America/New_York"), utc("2026-11-01T07:00:00Z"));
});

test("nextFire: no fire within five years returns null", () => {
  // Feb 29 falls on no year from 2099 to 2103 (2100 is not a leap year); the next is 2104.
  assert.equal(nextFire("0 0 29 2 *", utc("2098-03-01T00:00:00Z")), null);
});

test("CronSchedule exposes the expression it was built from", () => {
  assert.equal(new CronSchedule("0 9 * * *").expr, "0 9 * * *");
});

test("*/n in dom and dow is a star, not restricted (vixie)", () => {
  assert.equal(parseCron("0 0 */2 * *").domRestricted, false);
  assert.equal(parseCron("0 0 * * */2").dowRestricted, false);
  // dom */2 = odd days; as a star it ANDs with dow (Monday), not ORs.
  assert.equal(nextFire("0 0 */2 * 1", utc("2026-01-01T00:00:00Z")), utc("2026-01-05T00:00:00Z"));
  // dow */2 = Sun/Tue/Thu/Sat; ANDs with the 15th.
  assert.equal(nextFire("0 0 15 * */2", utc("2026-01-01T00:00:00Z")), utc("2026-01-15T00:00:00Z"));
});

test("DST fall-back with a 30-minute shift fires once (Lord Howe)", () => {
  // Lord Howe falls back 30 minutes on 2026-04-05: 01:45 occurs at 14:45Z (+11) and 15:15Z (+10:30).
  const first = nextFire("45 1 * * *", utc("2026-04-04T00:00:00Z"), "Australia/Lord_Howe");
  assert.equal(first, utc("2026-04-04T14:45:00Z"));
  assert.equal(nextFire("45 1 * * *", first!, "Australia/Lord_Howe"), utc("2026-04-05T15:15:00Z"));
});

test("prevFire finds the largest fire strictly before", () => {
  assert.equal(prevFire("0 0 * * *", utc("2026-01-02T00:00:00Z")), utc("2026-01-01T00:00:00Z"));
  assert.equal(prevFire("0 0 29 2 *", utc("2026-01-01T00:00:00Z")), utc("2024-02-29T00:00:00Z"));
});

test("CronSchedule prevFire/nextFire match the pure functions", () => {
  const s = new CronSchedule("0 9 * * *");
  const probes = [
    utc("2026-01-01T00:00:00Z"),
    utc("2026-01-01T09:00:00Z"),
    utc("2026-01-01T10:00:00Z"),
    utc("2026-01-05T08:59:00Z"),
    utc("2026-01-05T09:00:00Z"),
    utc("2026-01-10T00:00:00Z"),
  ];
  for (const t of probes) {
    assert.equal(s.prevFire(t), prevFire("0 9 * * *", t), `prevFire ${t}`);
    assert.equal(s.nextFire(t), nextFire("0 9 * * *", t), `nextFire ${t}`);
  }
});

// Scripted search primitives over `fires` that count their calls, to prove cached queries never rescan.
function countingSchedule(fires: number[]) {
  const calls = { next: 0, prev: 0 };
  const s = new CronSchedule("0 0 * * *", {
    nextFire: (_spec, after) => {
      calls.next++;
      return fires.find((f) => f > after) ?? null;
    },
    prevFire: (_spec, before) => {
      calls.prev++;
      return [...fires].reverse().find((f) => f < before) ?? null;
    },
  });
  return { s, calls };
}

test("CronSchedule caches unchanged queries so they do not rescan", () => {
  const { s, calls } = countingSchedule([1000, 2000, 3000, 4000]);
  assert.equal(s.prevFire(1500), 1000);
  const scans = { ...calls };
  // Same gap, later ticks: cached, no new scans.
  assert.equal(s.prevFire(1501), 1000);
  assert.equal(s.prevFire(1999), 1000);
  assert.deepEqual(calls, scans);
  // Crossing the next fire advances the chain by exactly one nextFire scan.
  assert.equal(s.prevFire(2500), 2000);
  assert.deepEqual(calls, { next: scans.next + 1, prev: scans.prev });
});

test("CronSchedule nextFire is cached within a gap", () => {
  const { s, calls } = countingSchedule([1000, 2000, 3000]);
  assert.equal(s.nextFire(1500), 2000);
  const scans = { ...calls };
  assert.equal(s.nextFire(1501), 2000);
  assert.equal(s.nextFire(1999), 2000);
  assert.deepEqual(calls, scans);
  assert.equal(s.nextFire(2000), 3000);
  assert.deepEqual(calls, { next: scans.next + 1, prev: scans.prev });
});

test("CronSchedule caches a schedule whose first fire is still ahead", () => {
  const { s, calls } = countingSchedule([3000, 4000]);
  assert.equal(s.prevFire(1000), null);
  const scans = { ...calls };
  // Still before the first fire: cached null, no rescans.
  assert.equal(s.prevFire(2000), null);
  assert.equal(s.prevFire(2999), null);
  assert.deepEqual(calls, scans);
  // Crossing the first fire advances by exactly one nextFire scan.
  assert.equal(s.prevFire(3001), 3000);
  assert.deepEqual(calls, { next: scans.next + 1, prev: scans.prev });
});

test("CronSchedule seeds the chain from the next fire without another prevFire scan", () => {
  const { s, calls } = countingSchedule([1000]);
  assert.equal(s.prevFire(1000), null);
  const scans = { ...calls };
  // 1001 is past the fire at 1000: its answer is 1000, found from the cached chain, not by a new prevFire scan.
  assert.equal(s.prevFire(1001), 1000);
  assert.equal(calls.prev, scans.prev);
});

test("CronSchedule rescans once a cached fire is past the search window", () => {
  const { s, calls } = countingSchedule([1000]);
  assert.equal(s.prevFire(1500), 1000);
  const scans = { ...calls };
  // Beyond the five-year window the cached fire no longer answers, so prevFire must rescan.
  assert.equal(s.prevFire(1000 + 366 * 5 * 24 * 60 * 60_000 + 1), 1000);
  assert.equal(calls.prev, scans.prev + 1);
});
