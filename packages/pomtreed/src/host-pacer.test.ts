import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "@pomtree/store-sqlite";
import { hostPacer } from "./host-pacer.ts";
import { memoryQuotaCounters, QUOTA_SCOPES } from "./quota.ts";

// A scripted clock: sleep advances it and records each wait.
const clock = () => {
  let t = 1000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

test("hostPacer: 0 (the default) is off; a positive interval spaces sends to one host, hosts are paced independently", async () => {
  assert.equal(hostPacer(0), undefined);
  const c = clock();
  const pace = hostPacer(100, c)!;
  await pace("www.sec.gov");
  assert.deepEqual(c.waits, [], "the first send to a host goes at once");
  await pace("WWW.SEC.GOV"); // hostnames compare case-insensitively
  await pace("www.sec.gov");
  assert.deepEqual(c.waits, [100, 100]);
  await pace("data.example.org");
  assert.deepEqual(c.waits, [100, 100], "another host is not held back by sec.gov");
  c.advance(250); // t = 1450, between slot starts
  await pace("www.sec.gov");
  assert.deepEqual(c.waits, [100, 100, 50], "a send after the interval has passed waits only for the next slot start");
});

test("hostPacer: hostnames of one registrable domain share a bucket (data.sec.gov and www.sec.gov), other sites do not", async () => {
  const c = clock();
  const pace = hostPacer(100, c)!;
  await pace("data.sec.gov");
  await pace("www.sec.gov");
  await pace("efts.sec.gov");
  assert.deepEqual(c.waits, [100, 100], "three sec.gov hostnames are spaced as one site");
  await pace("www.example.co.uk");
  await pace("example.org");
  assert.deepEqual(c.waits, [100, 100], "another domain is not held back");
});

test("hostPacer: slot claims live in QuotaCounters, so a restarted pacer over the same counters does not send early", async () => {
  const quota = openStore(":memory:").quotaCounters(); // the durable store, shared across the restart
  const c = clock();
  const before = hostPacer(100, { ...c, quota })!;
  await Promise.all([before("www.sec.gov"), before("www.sec.gov")]); // claims the slots at 1000 and 1100
  assert.equal(quota.peek(QUOTA_SCOPES.domainPace, "sec.gov", 1100), 1, "keyed by the registrable domain and the slot start");
  const waits: number[] = [];
  const after = hostPacer(100, { now: () => 1000, sleep: async (ms) => void waits.push(ms), quota })!; // the clock has not moved
  await after("data.sec.gov");
  assert.deepEqual(waits, [200], "the restarted pacer takes the first slot nobody claimed");
  // Negative: without shared counters a fresh pacer sends at once (the pre-store behavior).
  const fresh: number[] = [];
  await hostPacer(100, { now: () => 1000, sleep: async (ms) => void fresh.push(ms) })!("data.sec.gov");
  assert.deepEqual(fresh, []);
});

test("hostPacer: concurrent callers reserve distinct slots in call order", async () => {
  const c = clock();
  const waits: number[] = [];
  const pace = hostPacer(100, { now: c.now, sleep: async (ms) => void waits.push(ms) })!; // the clock does not move while they wait
  await Promise.all([pace("h"), pace("h"), pace("h")]);
  assert.deepEqual(waits, [100, 200]);
});

test("hostPacer: an aborted wait rejects, so the fetch fails instead of sending", async () => {
  const pace = hostPacer(1000)!;
  await pace("h");
  const ac = new AbortController();
  const waiting = pace("h", ac.signal);
  ac.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("hostPacer: a late wake re-books up to the actual wake time, so the next claim is an interval after the real send", async () => {
  let t = 1_000;
  const quota = memoryQuotaCounters();
  const sends: number[] = [];
  const pace = hostPacer(100, {
    quota,
    now: () => t,
    sleep: async (ms) => {
      t += ms + 70; // the timer fires 70 ms late (event-loop lag)
    },
  });
  assert.ok(pace);
  t = 1_050;
  await pace("sec.gov"); // slot 1100, woke at 1170
  sends.push(t);
  await pace("sec.gov"); // claimed after the late send: slot 1200 is re-booked, so it takes 1300 (woke 1370)
  sends.push(t);
  assert.deepEqual(sends, [1170, 1370]);
  assert.ok((sends[1] as number) - (sends[0] as number) >= 100, "spaced from the actual send, not from the booked slot");
  // Negative: an on-time wake books nothing extra.
  const q2 = memoryQuotaCounters();
  let t2 = 50;
  const onTime = hostPacer(100, {
    quota: q2,
    now: () => t2,
    sleep: async (ms) => {
      t2 += ms;
    },
  });
  await onTime?.("sec.gov");
  assert.equal(q2.peek(QUOTA_SCOPES.domainPace, "sec.gov", 200), 0);
});
