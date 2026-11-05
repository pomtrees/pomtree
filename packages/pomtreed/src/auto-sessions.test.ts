import { test } from "node:test";
import assert from "node:assert/strict";
import { autoMaxSessions, maxSessionsOf, gateReason, AUTO_SESSIONS_HARD_MAX } from "./auto-sessions.ts";

const G = 1024 ** 3;
const base = { containerMemBytes: 2 * G, containerCpus: 2, memFraction: 0.9, maxContainers: 32 };

test("autoMaxSessions table", () => {
  assert.equal(autoMaxSessions({ ...base, cpus: 8, memTotalBytes: 16 * G }), 7); // laptop: mem 7.2
  assert.equal(autoMaxSessions({ ...base, cpus: 32, memTotalBytes: 94 * G }), AUTO_SESSIONS_HARD_MAX); // this host
  assert.equal(autoMaxSessions({ ...base, cpus: 1, memTotalBytes: 64 * G }), 2); // tiny cpu: min 2
  assert.equal(autoMaxSessions({ ...base, cpus: 2, memTotalBytes: 1 * G }), 2); // tiny ram: min 2
  assert.equal(autoMaxSessions({ ...base, cpus: 64, memTotalBytes: 512 * G, maxContainers: 8 }), 8); // maxContainers clamp
  assert.equal(autoMaxSessions({ ...base, cpus: 64, memTotalBytes: 512 * G, maxContainers: 1 }), 1); // never above maxContainers
  assert.equal(autoMaxSessions({ ...base, cpus: 6, memTotalBytes: 64 * G }), 9); // cpu bound 6/2*3
  assert.equal(autoMaxSessions({ ...base, cpus: NaN, memTotalBytes: 64 * G }), 2);
});

test("maxSessionsOf: auto computes once, an integer is manual (bypasses the auto cap)", () => {
  const auto = () => 11;
  assert.deepEqual(maxSessionsOf("auto", auto), { value: 11, mode: "auto" });
  assert.deepEqual(maxSessionsOf("40", auto), { value: 40, mode: "manual" });
});

test("gateReason maps resource gate refusals", () => {
  assert.equal(gateReason("insufficient disk space"), "disk gate");
  assert.equal(gateReason("memory reservation exceeded (3 x 1 > 2 bytes)"), "memory gate");
  assert.equal(gateReason("sandbox unavailable"), "sandbox down");
});
