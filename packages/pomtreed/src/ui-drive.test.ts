import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { handle } from "./api.ts";
import { issueUiCookie } from "./auth.ts";
import { findJournalTail, isFreshCommand } from "./builtin/uiDrive.ts";
import { MAX_SSE_STREAMS, makeServer } from "./server.ts";
import { SECRET, op, setup, until } from "./test-setup.ts";

type T = ReturnType<typeof setup>;
const idle = async (c: { stopped: Promise<unknown> }) => void (await c.stopped);
const cmd = { cmd: "open", view: "terminal", agent: "a1" };
const post = (t: T, body: unknown) => t.operator("POST", "/v1/ui/command", body);
const uiRows = async (t: T) => (await t.journal.read({})).filter((e) => e.payload.kind === "ext.observe.ui_command");
const err = (r: { body: unknown }) => (r.body as { error: string }).error;

test("POST /v1/ui/command: no token 401, agent token 403", async () => {
  const t = setup(idle);
  const body = { idempotencyKey: "k", command: cmd };
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/ui/command", body })).status, 401);
  assert.equal((await handle(t.daemon, { method: "POST", url: "/v1/ui/command", body, token: t.daemon.agentToken("nobody") })).status, 403);
  assert.equal((await uiRows(t)).length, 0);
});

const bad: [string, unknown, RegExp][] = [
  // The platform's own idempotency rule answers these three before the handler runs (operator() would auto-add a key).
  ["non-object body", "nope", /idempotencyKey is required.*send/],
  ["array body", [], /idempotencyKey is required.*send/],
  ["missing key", { command: cmd }, /idempotencyKey is required.*send/],
  ["blank key", { idempotencyKey: "  ", command: cmd }, /idempotencyKey.*(non-blank|use|send)/i],
  ["129-char key", { idempotencyKey: "k".repeat(129), command: cmd }, /128.*(shorten|use)/i],
  ["unknown cmd", { idempotencyKey: "k", command: { cmd: "explode" } }, /explode/],
  ["bad view", { idempotencyKey: "k", command: { cmd: "open", view: "Bad View", agent: "a1" } }, /view/],
  ["unknown key", { idempotencyKey: "k", command: { cmd: "reset", extra: 1 } }, /extra/],
];
for (const [name, body, hint] of bad) {
  test(`POST /v1/ui/command: 400 for ${name}, naming cause and action`, async () => {
    const t = setup(idle);
    const r = await handle(t.daemon, { method: "POST", url: "/v1/ui/command", body, token: op });
    assert.equal(r.status, 400);
    assert.match(err(r), hint);
    assert.equal((await uiRows(t)).length, 0, "nothing journaled");
  });
}

test("POST /v1/ui/command: journals ext.observe.ui_command, replies {seq, tabs}, replay journals once", async () => {
  const t = setup(idle);
  const r1 = await post(t, { idempotencyKey: "k1", command: cmd });
  assert.equal(r1.status, 200);
  const rows = await uiRows(t);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.payload, { kind: "ext.observe.ui_command", command: cmd });
  assert.deepEqual(r1.body, { seq: rows[0]!.seq, tabs: 0 });
  const r2 = await post(t, { idempotencyKey: "k1", command: cmd });
  assert.deepEqual(r2.body, r1.body);
  assert.equal((await uiRows(t)).length, 1);
  assert.notEqual(((await post(t, { idempotencyKey: "k2", command: cmd })).body as { seq: number }).seq, (r1.body as { seq: number }).seq);
});

// --- SSE ---
const cookie = () => issueUiCookie(SECRET, 60_000);
const listen0 = async (t: T, heartbeatMs = 20) => {
  const server = makeServer(t.daemon, false, { heartbeatMs, maxConnections: 200 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port };
};
// Opens a stream; `text()` is everything received so far, `close()` destroys the connection.
const open = (port: number, path = "/live/ui") =>
  new Promise<{ status: number; text: () => string; close: () => void }>((resolve, reject) => {
    let s = "";
    const req = request({ host: "127.0.0.1", port, path, headers: { cookie: cookie() } }, (res) => {
      res.on("data", (d) => (s += d));
      if (res.statusCode !== 200) res.resume();
      resolve({ status: res.statusCode!, text: () => s, close: () => req.destroy() });
    });
    req.on("error", () => {});
    setTimeout(() => reject(new Error("open timeout")), 2000);
    req.end();
  });
const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((f) => f.includes("data: "))
    .map((f) => ({ id: Number(/^id: (\d+)$/m.exec(f)![1]), data: JSON.parse(/^data: (.*)$/m.exec(f)![1]!) }));
const waitFrames = (s: { text: () => string }, n: number) => until(() => frames(s.text()).length >= n);
const tabsNow = async (t: T) => ((await post(t, { idempotencyKey: "probe", command: { cmd: "reset" } })).body as { tabs: number }).tabs;
const cleanup = (server: { close(): void; closeAllConnections(): void }) => {
  server.close();
  server.closeAllConnections();
};

test("GET /live/ui: tabs gauge is 0, 1 with a stream, and back to 0 after close", async () => {
  const t = setup(idle);
  const { server, port } = await listen0(t);
  try {
    assert.equal(await tabsNow(t), 0);
    const s = await open(port);
    await until(() => s.text().startsWith(": connected"));
    assert.equal(await tabsNow(t), 1);
    s.close();
    await until(async () => (await tabsNow(t)) === 0);
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: no token 401; agent token 403", async () => {
  const t = setup(idle);
  const { server, port } = await listen0(t);
  const status = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/live/ui", headers }, (res) => {
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", () => {});
      req.end();
    });
  try {
    assert.equal(await status({}), 401);
    assert.equal(await status({ authorization: `Bearer ${t.daemon.agentToken("nobody")}` }), 403);
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: a fresh stream skips earlier commands, delivers a later one with id = seq", async () => {
  const t = setup(idle);
  await post(t, { idempotencyKey: "old", command: { cmd: "reset" } });
  const { server, port } = await listen0(t);
  try {
    const s = await open(port);
    await until(() => s.text().startsWith(": connected"));
    const r = await post(t, { idempotencyKey: "new", command: cmd });
    await waitFrames(s, 1);
    const f = frames(s.text());
    assert.equal(f.length, 1, "the pre-connect command is not replayed");
    const seq = (r.body as { seq: number }).seq;
    assert.equal(f[0]!.id, seq);
    assert.deepEqual({ ...f[0]!.data, ts: typeof f[0]!.data.ts }, { type: "command", seq, ts: "number", command: cmd });
    s.close();
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: lastEventId resumes with a missed fresh command and drops one older than the TTL", async () => {
  let clock = 1_000_000;
  const t = setup(idle, { now: () => clock });
  const first = (await post(t, { idempotencyKey: "a", command: { cmd: "reset" } })).body as { seq: number };
  clock += 100_000;
  await post(t, { idempotencyKey: "stale", command: { cmd: "arrange", preset: "grid" } });
  clock = 2_000_000;
  const fresh = (await post(t, { idempotencyKey: "fresh", command: cmd })).body as { seq: number };
  clock += 5_000;
  const { server, port } = await listen0(t);
  try {
    const s = await open(port, `/live/ui?lastEventId=${first.seq - 1}`);
    await waitFrames(s, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(
      frames(s.text()).map((f) => f.id),
      [fresh.seq],
      "only the command inside the TTL arrives",
    );
    s.close();
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: a spawned frame carries the parent; other journal kinds produce no frame", async () => {
  const t = setup(idle);
  const { server, port } = await listen0(t);
  try {
    const s = await open(port);
    await until(() => s.text().startsWith(": connected"));
    const rec = await t.spawn("kid");
    await post(t, { idempotencyKey: "after", command: { cmd: "reset" } });
    await waitFrames(s, 2);
    const f = frames(s.text());
    assert.deepEqual(
      f.map((x) => x.data.type),
      ["spawned", "command"],
      "spawn's other lifecycle rows are not framed",
    );
    assert.deepEqual({ ...f[0]!.data, seq: typeof f[0]!.data.seq }, { type: "spawned", seq: "number", agent: rec.id, parent: (await t.daemon.root()).id });
    s.close();
  } finally {
    cleanup(server);
  }
});

test("POST /v1/ui/command: a key reused for a different command is 409 naming key and fix; the same command stays a 200 replay", async () => {
  const t = setup(idle);
  const r1 = await post(t, { idempotencyKey: "dup", command: cmd });
  const r2 = await post(t, { idempotencyKey: "dup", command: { cmd: "reset" } });
  assert.equal(r2.status, 409);
  assert.match(err(r2), /idempotency key dup was already used for a different command \(seq \d+\); use a new --key, or omit it/);
  assert.match(err(r2), new RegExp(`seq ${(r1.body as { seq: number }).seq}\\)`));
  assert.equal((await uiRows(t)).length, 1, "the different command was not journaled");
  const r3 = await post(t, { idempotencyKey: "dup", command: cmd });
  assert.equal(r3.status, 200);
  assert.deepEqual(r3.body, r1.body);
});

test("GET /live/ui: a priming id-only frame follows `: connected`, and a reconnect with it delivers a command posted in the gap", async () => {
  const t = setup(idle);
  const base = (await post(t, { idempotencyKey: "base", command: { cmd: "reset" } })).body as { seq: number };
  const { server, port } = await listen0(t);
  try {
    const s = await open(port);
    await until(() => s.text().includes(`id: ${base.seq}\n\n`));
    assert.ok(s.text().startsWith(": connected\n\nid: " + base.seq + "\n\n"), "id frame right after connected");
    assert.equal(s.text().includes("data:"), false, "the priming frame has no data line");
    s.close();
    const gap = (await post(t, { idempotencyKey: "gap", command: cmd })).body as { seq: number };
    const s2 = await open(port, `/live/ui?lastEventId=${base.seq}`);
    await waitFrames(s2, 1);
    assert.deepEqual(
      frames(s2.text()).map((f) => f.id),
      [gap.seq],
    );
    s2.close();
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: the priming frame on an empty journal is id 0 and a reconnect from it delivers the first command", async () => {
  const t = setup(idle);
  const { server, port } = await listen0(t);
  try {
    const s = await open(port);
    await until(() => s.text().includes("id: 0\n\n"));
    assert.equal(s.text().includes("data:"), false);
    s.close();
    const gap = (await post(t, { idempotencyKey: "gap0", command: cmd })).body as { seq: number };
    const s2 = await open(port, "/live/ui?lastEventId=0");
    await waitFrames(s2, 1);
    assert.equal(frames(s2.text())[0]!.id, gap.seq);
    s2.close();
  } finally {
    cleanup(server);
  }
});

// A stream the server ended: the client sees "end" and the tab gauge falls (a dead open stream would keep both).
const ended = (port: number) =>
  new Promise<boolean>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/live/ui", headers: { cookie: cookie() } }, (res) => {
      res.resume();
      res.on("end", () => resolve(true));
    });
    req.on("error", () => resolve(true));
    setTimeout(() => reject(new Error("stream not ended by the server")), 2000);
    req.end();
  });

test("GET /live/ui: a throwing journal subscription ends the connection and the gauge falls", async () => {
  const t = setup(idle);
  t.fakes.journal.subscribe = () => {
    throw new Error("subscribe boom");
  };
  const { server, port } = await listen0(t);
  try {
    assert.equal(await ended(port), true);
    await until(async () => (await tabsNow(t)) === 0);
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: a throwing journal iteration ends the connection and the gauge falls", async () => {
  const t = setup(idle);
  t.fakes.journal.subscribe = () =>
    ({
      close() {},
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("iterate boom");
        },
      }),
    }) as never;
  const { server, port } = await listen0(t);
  try {
    assert.equal(await ended(port), true);
    await until(async () => (await tabsNow(t)) === 0);
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui: a failing getAgent skips that spawned frame and a later frame still arrives", async () => {
  const t = setup(idle);
  const { server, port } = await listen0(t);
  try {
    const s = await open(port);
    await until(() => s.text().startsWith(": connected"));
    const real = t.fakes.registry.get.bind(t.fakes.registry);
    let broken = false;
    t.fakes.registry.get = async (id) => {
      const rec = await real(id);
      if (broken && rec?.parent) throw new Error("lookup boom");
      return rec;
    };
    broken = true;
    await t.spawn("kid");
    await post(t, { idempotencyKey: "after-fail", command: { cmd: "reset" } });
    await waitFrames(s, 1);
    assert.deepEqual(
      frames(s.text()).map((f) => f.data.type),
      ["command"],
      "the spawned frame was skipped, the stream lived on",
    );
    assert.equal(await tabsNow(t), 1, "the tab is still connected");
    s.close();
  } finally {
    cleanup(server);
  }
});

test("GET /live/ui counts against the SSE cap", async () => {
  const t = setup(idle);
  const { server, port } = await listen0(t, 5_000);
  const opened: { close: () => void }[] = [];
  try {
    for (let i = 0; i < MAX_SSE_STREAMS; i++) opened.push(await open(port));
    assert.equal((await open(port)).status, 503);
  } finally {
    for (const o of opened) o.close();
    cleanup(server);
  }
});

// --- pure helpers ---
// A journal read over the given seqs: the first row with seq >= from, as the real read({from, limit: 1}) does.
const fakeRead = (seqs: number[]) => {
  let reads = 0;
  const read = async (o: { from: number; limit: number }) => {
    reads++;
    return seqs
      .filter((s) => s >= o.from)
      .slice(0, o.limit)
      .map((seq) => ({ seq }));
  };
  return { read, reads: () => reads };
};
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
// The wrong approach: walk from seq 1 and stop at the first missing exact seq. A pruned gap ends it early.
const wrongLinear = async (read: (o: { from: number; limit: number }) => Promise<{ seq: number }[]>) => {
  let n = 0;
  while ((await read({ from: n + 1, limit: 1 })).at(0)?.seq === n + 1) n++;
  return n === 0 ? null : n;
};

test("findJournalTail: empty -> null, single row, N rows, gaps from pruning", async () => {
  assert.equal(await findJournalTail(fakeRead([]).read), null);
  assert.equal(await findJournalTail(fakeRead([1]).read), 1);
  assert.equal(await findJournalTail(fakeRead([7]).read), 7);
  for (const n of [2, 3, 8, 9, 100, 1000]) assert.equal(await findJournalTail(fakeRead(range(n)).read), n, `${n} rows`);
  const gap = [1, 2, 3, 10, 11, 40];
  assert.equal(await findJournalTail(fakeRead(gap).read), 40);
  const pruned = [500, 501, 502];
  assert.equal(await findJournalTail(fakeRead(pruned).read), 502);
  // the wrong linear walk differs on a gap: it stops at 3 where the tail is 40
  assert.equal(await wrongLinear(fakeRead(gap).read), 3);
  assert.equal(await wrongLinear(fakeRead(pruned).read), null);
});

test("findJournalTail: logarithmic reads", async () => {
  const f = fakeRead(range(100_000));
  assert.equal(await findJournalTail(f.read), 100_000);
  assert.ok(f.reads() <= 40, `reads: ${f.reads()}`);
});

test("isFreshCommand: age is judged on the daemon clock; the boundary is inclusive", () => {
  assert.equal(isFreshCommand(100_000, 100_000), true);
  assert.equal(isFreshCommand(100_000 + 30_000, 100_000), true);
  assert.equal(isFreshCommand(100_000 + 30_001, 100_000), false);
});
