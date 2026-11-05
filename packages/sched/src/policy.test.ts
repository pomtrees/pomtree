import { test } from "node:test";
import assert from "node:assert/strict";
import { jitterFor, onFire, taskKey } from "./policy.ts";

const utc = (s: string) => Date.parse(s);
const hourly = { cron: "0 * * * *" };

test("taskKey is stable and time-addressed", () => {
  assert.equal(taskKey("nightly", utc("2026-01-01T00:00:00Z")), "nightly@2026-01-01T00:00:00.000Z");
});

test("jitter is deterministic, bounded, and spread across ids", () => {
  assert.equal(jitterFor("a", 1000), jitterFor("a", 1000));
  assert.equal(jitterFor("a", 0), 0);
  const seen = new Set<number>();
  for (let i = 0; i < 50; i++) {
    const j = jitterFor(`sched-${i}`, 60_000);
    assert.ok(j >= 0 && j < 60_000);
    seen.add(j);
  }
  assert.ok(seen.size > 40);
});

test("jitterFor is FNV-1a 32-bit over every character of the id", () => {
  // policy.ts declares FNV-1a. FNV-1a 32-bit of "a" is 0xe40c292c = 3826002220, so mod 1000 it is 220.
  assert.equal(jitterFor("a", 1000), 0xe40c292c % 1000);
});

test("overlap policy", () => {
  assert.equal(onFire("skip", false), "start");
  assert.equal(onFire("queue", false), "start");
  assert.equal(onFire("skip", true), "skip");
  assert.equal(onFire("queue", true), "queue");
});
