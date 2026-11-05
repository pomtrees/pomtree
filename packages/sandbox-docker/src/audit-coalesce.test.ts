import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachProxy } from "./proxy.ts";
import {
  AUDIT_COALESCE_MAX_PENDING,
  AUDIT_COALESCE_WINDOW_MS,
  AUDIT_MAX_BYTES,
  CoalescingEgressAuditWriter,
  DiskEgressAudit,
  FileEgressAuditWriter,
  prepareEgressSpool,
  type CoalescingEgressAuditOptions,
  type EgressAuditEvent,
  type EgressAuditRecord,
  type EgressAuditWriter,
} from "./audit.ts";

const identity = { sandbox: "sb", agent: "worker", host: "host", generation: 1 };
const denied: EgressAuditEvent = {
  connection: "c0",
  phase: "admission",
  transport: "connect",
  authority: "blocked.example.test:443",
  outcome: "denied",
  denyReason: "not-allowlisted",
};
const allowed: EgressAuditEvent = {
  connection: "p0",
  phase: "admission",
  transport: "connect",
  authority: "blocked.example.test:443",
  outcome: "allowed",
  peer: "8.8.8.8",
};

// A clock the test steps by hand, starting in the past so lastAt <= the writer's real Date.now() `at`.
function fakeClock(start = Date.now() - 10_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
// Manual timers: fire() runs every live timer in creation order.
function manualTimers() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h: unknown) => {
      (h as { live: boolean }).live = false;
    },
    fire: () => {
      for (const t of timers) {
        if (!t.live) continue;
        t.live = false;
        t.fn();
      }
    },
    live: () => timers.filter((t) => t.live).length,
  };
}
function recorder(): { rows: EgressAuditEvent[]; writer: EgressAuditWriter } {
  const rows: EgressAuditEvent[] = [];
  return { rows, writer: { append: (e) => void rows.push(e) } };
}
function harness(opts: CoalescingEgressAuditOptions = {}, inner = recorder()) {
  const clock = fakeClock();
  const timers = manualTimers();
  const writer = new CoalescingEgressAuditWriter(inner.writer, { now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...opts });
  return { ...inner, writer, clock, timers };
}
function spool() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-audit-coalesce-")));
  const { logDir } = prepareEgressSpool(root, "sb", { allow: [], relay: [], hostAddresses: [], identity });
  return { root, logDir, disk: new DiskEgressAudit({ root }), clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("the first denial is appended unchanged; identical denials inside the window are folded into one summary at flush", () => {
  const h = harness();
  h.writer.append(denied);
  assert.deepEqual(h.rows, [denied], "first row has exactly today's shape");
  h.clock.advance(1000);
  h.writer.append({ ...denied, connection: "c1", durationMs: 5, admittedAt: "2026-10-24T00:00:00.000Z" });
  h.clock.advance(2000);
  h.writer.append({ ...denied, connection: "c2" });
  assert.equal(h.rows.length, 1, "suppressed denials are not written");
  const base = h.clock.now();
  h.writer.flush();
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.rows[1], { ...denied, connection: "c2", repeats: 2, firstAt: base - 2000, lastAt: base });
  assert.equal(h.timers.live(), 0, "flush cancels the window timers");
});

test("a window with no repeats writes nothing at its end or on flush", () => {
  const h = harness();
  h.writer.append(denied);
  h.timers.fire();
  h.writer.flush();
  assert.equal(h.rows.length, 1);
});

test("the timer ends the window and writes the summary; the next identical denial is a fresh first row opening a new window", () => {
  const h = harness({ windowMs: 100 });
  h.writer.append(denied);
  assert.equal(h.timers.timers[0]?.ms, 100);
  h.clock.advance(10);
  h.writer.append({ ...denied, connection: "c1" });
  h.clock.advance(100);
  h.timers.fire();
  assert.deepEqual(
    h.rows.map((r) => [r.connection, r.repeats]),
    [
      ["c0", undefined],
      ["c1", 1],
    ],
  );
  h.writer.append({ ...denied, connection: "c2" });
  assert.deepEqual(h.rows[2], { ...denied, connection: "c2" }, "unchanged first row again");
  h.clock.advance(5);
  h.writer.append({ ...denied, connection: "c3" });
  h.writer.flush();
  assert.deepEqual(
    h.rows.map((r) => [r.connection, r.repeats]),
    [
      ["c0", undefined],
      ["c1", 1],
      ["c2", undefined],
      ["c3", 1],
    ],
  );
});

test("an expired window is flushed by the next append even if its timer is late, before the new row", () => {
  const h = harness({ windowMs: 100 });
  h.writer.append(denied);
  h.clock.advance(50);
  h.writer.append({ ...denied, connection: "c1" });
  h.clock.advance(500); // the timer has not fired
  h.writer.append(allowed);
  assert.deepEqual(
    h.rows.map((r) => [r.connection, r.outcome, r.repeats]),
    [
      ["c0", "denied", undefined],
      ["c1", "denied", 1],
      ["p0", "allowed", undefined],
    ],
  );
});

test("distinct keys never merge: authority, phase, method and denyReason each key a separate window", () => {
  const h = harness();
  const variants: EgressAuditEvent[] = [
    denied,
    { ...denied, authority: "other.example.test:443" },
    { ...denied, phase: "outcome" },
    { ...denied, denyReason: "dns" },
    { ...denied, transport: "http", method: "GET" },
    { ...denied, transport: "http", method: "POST" },
  ];
  for (const v of variants) h.writer.append(v);
  h.writer.flush();
  assert.equal(h.rows.length, variants.length, "six distinct keys: six first rows, no summaries");
  assert.ok(h.rows.every((r) => r.repeats === undefined));
  // Repeating two of them folds only those, in order of first suppression.
  const h2 = harness();
  for (const v of variants) h2.writer.append(v);
  h2.writer.append({ ...variants[3]!, connection: "x" });
  h2.writer.append({ ...variants[1]!, connection: "y" });
  h2.writer.flush();
  assert.deepEqual(
    h2.rows.slice(variants.length).map((r) => [r.connection, r.denyReason, r.authority, r.repeats]),
    [
      ["x", "dns", "blocked.example.test:443", 1],
      ["y", "not-allowlisted", "other.example.test:443", 1],
    ],
  );
});

test("pass-through events are appended synchronously and keep their order relative to summaries", () => {
  const h = harness();
  h.writer.append(denied);
  h.writer.append({ ...denied, connection: "c1" });
  h.writer.append(allowed);
  assert.deepEqual(
    h.rows.map((r) => r.connection),
    ["c0", "p0"],
    "the allowed row is in the inner writer before append returns",
  );
  h.writer.append(allowed);
  h.writer.append({ ...allowed, outcome: "complete", phase: "outcome" });
  assert.equal(h.rows.length, 4, "non-denied events are never coalesced, even when identical");
  h.writer.flush();
  assert.equal(h.rows[4]?.repeats, 1);
});

test("maxPending: a new key past the limit flushes the oldest pending window first; a zero-repeat oldest writes nothing", () => {
  const h = harness({ maxPending: 2 });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => ({ ...denied, authority: `${x}.example.test:443` }));
  h.writer.append(a!);
  h.writer.append({ ...a!, connection: "a1" });
  h.writer.append(b!);
  assert.equal(h.rows.length, 2);
  h.writer.append(c!); // evicts a: its summary is written before c's first row
  assert.deepEqual(
    h.rows.map((r) => [r.authority[0], r.connection, r.repeats]),
    [
      ["a", "c0", undefined],
      ["b", "c0", undefined],
      ["a", "a1", 1],
      ["c", "c0", undefined],
    ],
  );
  h.writer.append(d!); // evicts b, which had no repeats: nothing written for it
  assert.deepEqual(
    h.rows.slice(4).map((r) => r.authority[0]),
    ["d"],
  );
  assert.equal(AUDIT_COALESCE_MAX_PENDING, 1024);
  assert.equal(AUDIT_COALESCE_WINDOW_MS, 60_000);
});

test("a failing timer-driven summary calls onFailure instead of throwing; flush and pass-through surface the failure to the caller", () => {
  const failures: unknown[] = [];
  let broken = false;
  const rows: EgressAuditEvent[] = [];
  const h = harness(
    { onFailure: (e) => void failures.push(e) },
    {
      rows,
      writer: {
        append: (e) => {
          if (broken) throw new Error("egress audit unavailable");
          rows.push(e);
        },
      },
    },
  );
  h.writer.append(denied);
  h.writer.append({ ...denied, connection: "c1" });
  broken = true;
  assert.doesNotThrow(() => h.timers.fire());
  assert.equal(failures.length, 1);
  assert.match((failures[0] as Error).message, /unavailable/);
  assert.throws(() => h.writer.append(allowed), /unavailable/, "the inner failure still reaches the proxy's close path");
});

test("100k identical denials stay far under the caps and are accounted exactly; the spool rescans clean with an intact chain", async () => {
  const f = spool();
  try {
    const inner = new FileEgressAuditWriter(f.logDir, identity);
    const clock = fakeClock();
    const timers = manualTimers();
    const writer = new CoalescingEgressAuditWriter(inner, { now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      writer.append({ ...denied, connection: `c${i}`, durationMs: i % 7 });
      clock.advance(6); // 600 s of fake time: ten 60 s windows
    }
    writer.flush();
    const bytes = statSync(join(f.logDir, "events.jsonl")).size;
    assert.ok(bytes < AUDIT_MAX_BYTES / 100, `${bytes} bytes is far under AUDIT_MAX_BYTES`);
    new FileEgressAuditWriter(f.logDir, identity); // rescans: sequence, validation and chain all verify
    const rows = await f.disk.read("sb", 0, 256);
    assert.ok(rows.length < 100, `${rows.length} rows is far under MAX_RECORDS`);
    const firsts = rows.filter((r) => r.repeats === undefined);
    const summaries = rows.filter((r) => r.repeats !== undefined);
    assert.equal(firsts.length, summaries.length, "every window has a first row and a summary");
    assert.equal(firsts.length + summaries.reduce((n, r) => n + (r.repeats ?? 0), 0), N, "every denial is accounted for");
    const {
      chain: _c,
      sequence: _s,
      eventId: _e,
      at: _a,
      kind: _k,
      sandbox: _sb,
      agent: _ag,
      host: _h,
      generation: _g,
      ...firstShape
    } = firsts[0] as EgressAuditRecord;
    assert.deepEqual(firstShape, { ...denied, connection: "c0", durationMs: 0 }, "the first row is unchanged");
    for (const r of summaries) assert.ok(r.firstAt! <= r.lastAt! && r.lastAt! <= r.at);
    assert.deepEqual(
      rows.map((r) => r.sequence),
      rows.map((_, i) => i + 1),
    );
  } finally {
    f.clean();
  }
});

test("through attachProxy: a loop of denied requests keeps the proxy open and the spool rows coalesce", { timeout: 20000 }, async () => {
  const f = spool();
  const inner = new FileEgressAuditWriter(f.logDir, identity);
  const writer = new CoalescingEgressAuditWriter(inner);
  const server = createServer();
  const control = attachProxy(server, new Set(), {
    auditedPublic: writer,
    hostAddresses: new Set<string>(),
    resolve: async () => ["10.0.0.5"], // private: every request is denied
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = () =>
    new Promise<number | undefined>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "http://blocked.example.test/", agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", () => resolve(undefined));
      req.end();
    });
  try {
    const N = 150;
    for (let i = 0; i < N; i++) await get();
    const statuses = await get();
    assert.notEqual(statuses, undefined, "the proxy still answers after the denial loop");
    writer.flush();
    const rows = await f.disk.read("sb", 0, 256);
    const total = N + 1;
    const admissions = rows.filter((r) => r.phase === "admission");
    assert.ok(rows.length < 10, `${rows.length} rows for ${total} denied requests`);
    assert.equal(
      admissions.filter((r) => r.repeats === undefined).length + admissions.reduce((n, r) => n + (r.repeats ?? 0), 0),
      total,
      "every denied admission is accounted for",
    );
    assert.ok(rows.every((r) => r.outcome === "denied" && r.denyReason === "private"));
  } finally {
    control.close();
    server.closeAllConnections();
    server.close();
    f.clean();
  }
});

test("a clock stepping back between repeats never leaves a summary with firstAt > lastAt", async () => {
  const f = spool();
  try {
    const clock = fakeClock();
    const timers = manualTimers();
    const writer = new CoalescingEgressAuditWriter(new FileEgressAuditWriter(f.logDir, identity), {
      now: clock.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    writer.append(denied);
    clock.advance(100);
    writer.append({ ...denied, connection: "c1" });
    clock.advance(-50); // NTP step back
    writer.append({ ...denied, connection: "c2" });
    assert.doesNotThrow(() => writer.flush());
    const rows = await f.disk.read("sb", 0, 256);
    assert.equal(rows[1]?.repeats, 2);
    assert.ok(rows[1]!.firstAt! <= rows[1]!.lastAt!);
  } finally {
    f.clean();
  }
});

test("the file writer's at never precedes a summary's lastAt, even when the coalescer clock is ahead of Date.now()", async () => {
  const f = spool();
  try {
    const timers = manualTimers();
    const writer = new CoalescingEgressAuditWriter(new FileEgressAuditWriter(f.logDir, identity), {
      now: () => Date.now() + 60_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    writer.append(denied);
    writer.append({ ...denied, connection: "c1" });
    assert.doesNotThrow(() => writer.flush());
    const rows = await f.disk.read("sb", 0, 256);
    assert.ok(rows[1]!.at >= rows[1]!.lastAt!);
    // Negative: the file writer still rejects a hand-built summary whose lastAt is after its own firstAt ordering.
    assert.throws(() => new FileEgressAuditWriter(f.logDir, identity).append({ ...denied, repeats: 1, firstAt: 5, lastAt: 4 }), /repeat summary/);
  } finally {
    f.clean();
  }
});

test("after the inner writer throws, every later append rethrows, including a suppressed repeat", () => {
  let broken = false;
  const h = harness(
    {},
    {
      rows: [],
      writer: {
        append: () => {
          if (broken) throw new Error("egress audit unavailable");
        },
      },
    },
  );
  h.writer.append(denied);
  broken = true;
  assert.throws(() => h.writer.append(allowed), /unavailable/);
  broken = false; // even if the inner writer recovered, the coalescer stays latched
  assert.throws(() => h.writer.append({ ...denied, connection: "c1" }), /unavailable/, "a suppressed repeat no longer returns silently");
  assert.throws(() => h.writer.flush(), /unavailable/);
});
