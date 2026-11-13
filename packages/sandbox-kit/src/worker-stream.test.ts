import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Duplex } from "node:stream";
import { MuxError, type MuxConnection, type MuxPair, createMux } from "./mux.ts";
import { CallOutcomeUnknownError, LinkDroppedError, type ReconnectEvent, ReconnectError, createReconnector } from "./reconnect.ts";
import { type ConnectAudit, type TerminatorOptions, assertDialRejectsPrivate, createConnectTerminator, ipLiteralDenial } from "./terminate.ts";
import { type ByteDuplex, createWorkerStream, fromNodeDuplex } from "./worker-stream.ts";

// In-memory asymmetric pipes with no timers: delivery order is queue order and every wait is on an event.
class Inbox {
  chunks: Uint8Array[] = [];
  wake: (() => void) | undefined;
  ended = false;
  push(c: Uint8Array): void {
    this.chunks.push(c);
    this.signal();
  }
  end(): void {
    this.ended = true;
    this.signal();
  }
  signal(): void {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }
  async *iterate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const c = this.chunks.shift();
      if (c) {
        yield c;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }
}

class End implements MuxPair, ByteDuplex {
  inbox = new Inbox();
  peer!: End;
  closedLocally = false;
  async write(data: Uint8Array): Promise<void> {
    this.peer.inbox.push(data);
  }
  output(): AsyncIterable<Uint8Array> {
    return this.inbox.iterate();
  }
  close(): void {
    this.closedLocally = true;
    this.inbox.end();
    this.peer.inbox.end();
  }
}

function pipe(): { a: End; b: End } {
  const a = new End();
  const b = new End();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

// A half-closing variant for byte-stream tests: close() ends only what the peer reads (a graceful end of this side's writes).
class Half implements ByteDuplex {
  inbox = new Inbox();
  peer!: Half;
  closedLocally = false;
  events: string[] = [];
  async write(data: Uint8Array): Promise<void> {
    this.peer.inbox.push(data);
  }
  output(): AsyncIterable<Uint8Array> {
    return this.inbox.iterate();
  }
  close(): void {
    this.events.push("close");
    this.closedLocally = true;
    this.peer.inbox.end();
  }
  reset(): void {
    this.events.push("reset");
    this.resets++;
    this.closedLocally = true;
    this.inbox.end();
    this.peer.inbox.end();
  }
  resets = 0;
}

function halfPipe(): { a: Half; b: Half } {
  const a = new Half();
  const b = new Half();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Reads from an output() iterator with a carry-over buffer.
class Reader {
  it: AsyncIterator<Uint8Array>;
  buf = "";
  done = false;
  constructor(src: { output(): AsyncIterable<Uint8Array> }) {
    this.it = src.output()[Symbol.asyncIterator]();
  }
  async more(): Promise<boolean> {
    if (this.done) return false;
    const r = await this.it.next();
    if (r.done) {
      this.done = true;
      return false;
    }
    this.buf += dec.decode(r.value);
    return true;
  }
  async until(marker: string): Promise<string> {
    while (!this.buf.includes(marker)) assert.ok(await this.more(), `stream ended before ${JSON.stringify(marker)}; had ${JSON.stringify(this.buf)}`);
    const at = this.buf.indexOf(marker) + marker.length;
    const out = this.buf.slice(0, at);
    this.buf = this.buf.slice(at);
    return out;
  }
  async rest(): Promise<string> {
    while (await this.more());
    const out = this.buf;
    this.buf = "";
    return out;
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// Deadlines without real time: a sleep that resolves only when the test fires its duration, and rejects when its signal aborts.
class Clock {
  timers: Array<{ ms: number; resolve: () => void }> = [];
  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const t = { ms, resolve };
      this.timers.push(t);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((x) => x !== t);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    });
  pending(ms: number): number {
    return this.timers.filter((t) => t.ms === ms).length;
  }
  fire(ms: number): void {
    const hit = this.timers.filter((t) => t.ms === ms);
    this.timers = this.timers.filter((t) => t.ms !== ms);
    for (const t of hit) t.resolve();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// worker stream

async function wired(accept: readonly string[] = ["egress"], workerCap?: number) {
  const { a, b } = pipe();
  const worker = createWorkerStream({ pair: a, maxConnections: workerCap ?? 64 });
  const daemon = createMux(b, { role: "acceptor", accept });
  return { worker, daemon, a, b };
}

test("worker stream: a local connection is carried over a named channel both ways and closes cleanly", async () => {
  const { worker, daemon } = await wired();
  const { a: local, b: agent } = halfPipe();
  const bridged = worker.bridge(local, "egress");
  const [remote] = await collect(daemon, 1);
  assert.equal(remote?.name, "egress");
  await agent.write(enc.encode("from agent"));
  const remoteReader = new Reader(remote as MuxConnection);
  assert.equal(await remoteReader.until("agent"), "from agent");
  await remote?.write("from daemon");
  const agentReader = new Reader(agent);
  assert.equal(await agentReader.until("daemon"), "from daemon");
  agent.close();
  remote?.close();
  await bridged;
  assert.equal(await remoteReader.rest(), "");
  assert.equal(local.closedLocally, true, "the local side is closed once the channel finished");
  worker.close();
  daemon.close();
});

async function collect(mux: ReturnType<typeof createMux>, n: number): Promise<MuxConnection[]> {
  const out: MuxConnection[] = [];
  for await (const c of mux.incoming()) {
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

test("worker stream: after the stream is lost a new local connection fails fast and is closed", async () => {
  const { worker, a } = await wired();
  a.close();
  await worker.closed;
  const { a: local } = halfPipe();
  await assert.rejects(worker.bridge(local, "egress"), (e: unknown) => e instanceof MuxError && /closed|transport/.test(e.message));
  assert.equal(local.closedLocally, true);
});

test("worker stream: a channel name the daemon does not accept refuses the open and closes the local connection", async () => {
  const { worker, daemon } = await wired(["daemon-api"]);
  const { a: local } = halfPipe();
  await assert.rejects(worker.bridge(local, "egress"), (e: unknown) => e instanceof MuxError && e.code === "open-refused");
  assert.equal(local.closedLocally, true);
  worker.close();
  daemon.close();
});

test("worker stream: serve isolates a failed connection and keeps carrying the others", async () => {
  const { worker, daemon } = await wired(["egress"], 1);
  const first = halfPipe();
  const second = halfPipe();
  const errors: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  async function* source(): AsyncGenerator<ByteDuplex> {
    yield first.a;
    await collect(daemon, 1);
    yield second.a;
    await gate;
  }
  const served = worker.serve(source(), "egress", (e) => errors.push(e));
  while (errors.length === 0) await tick();
  assert.ok(errors[0] instanceof MuxError && errors[0].code === "limit", "the second connection hits the worker cap");
  assert.equal(second.a.closedLocally, true);
  assert.equal(first.a.closedLocally, false, "the first connection is untouched");
  release();
  worker.close();
  await served;
  assert.equal(first.a.resets, 1, "the surviving connection is reset when the stream ends under it");
  daemon.close();
});

test("worker stream: fromNodeDuplex writes, reads, half-closes and resets a node stream", async () => {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  const d = fromNodeDuplex(Duplex.from({ readable: fromPeer, writable: toPeer }));
  await d.write(enc.encode("out"));
  assert.equal(toPeer.read()?.toString(), "out");
  fromPeer.write("in");
  const it = d.output()[Symbol.asyncIterator]();
  assert.equal(dec.decode((await it.next()).value), "in");
  d.close();
  await tick();
  assert.equal(toPeer.writableEnded, true);
  fromPeer.end();
});

// ---------------------------------------------------------------------------------------------------------------------------
// CONNECT terminator

interface Harness {
  audits: ConnectAudit[];
  dialed: string[];
  upstreams: Half[];
  // The ends the terminator holds (the test holds the peers in `upstreams`).
  dialSides: Half[];
  clock: Clock;
  term: ReturnType<typeof createConnectTerminator>;
}

function terminator(allow: (h: string, p: number) => boolean, maxConnections = 4, extra: Partial<TerminatorOptions> & { dialError?: Error } = {}): Harness {
  const h: Harness = { audits: [], dialed: [], upstreams: [], dialSides: [], clock: new Clock(), term: undefined as never };
  let clock = 0;
  const { dialError, ...options } = extra;
  h.term = createConnectTerminator({
    allow,
    maxConnections,
    dial: async (host, port) => {
      h.dialed.push(`${host}:${port}`);
      if (dialError) throw dialError;
      const { a, b } = halfPipe();
      h.upstreams.push(b);
      h.dialSides.push(a);
      return a;
    },
    audit: (r) => h.audits.push(r),
    now: () => ++clock,
    sleep: h.clock.sleep,
    ...options,
  });
  return h;
}

const onlyExample = (host: string, port: number) => host === "example.com" && port === 443;
const allowAll = () => true;

async function connectTo(h: Harness, request: string) {
  const { a, b } = halfPipe();
  const handled = h.term.handle(a);
  await b.write(enc.encode(request));
  return { client: b, server: a, handled, reader: new Reader(b) };
}

// The refusal expectations for a host that is NOT on the allow-list. Run against the real allow-list it passes; run against an
// allow-all stub it must fail (checked below), so a permissive allow-list cannot satisfy the disallowed-host test.
async function expectDisallowedRefused(allow: (h: string, p: number) => boolean): Promise<void> {
  const h = terminator(allow);
  const c = await connectTo(h, "CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n");
  const head = await c.reader.until("\r\n\r\n");
  assert.match(head, /^HTTP\/1\.1 403 Forbidden/);
  assert.match(await c.reader.rest(), /not on the egress allow-list/);
  await c.handled;
  assert.deepEqual(h.dialed, [], "a disallowed host must never be dialed");
  assert.equal(h.audits.length, 1);
  assert.deepEqual(
    { outcome: h.audits[0]?.outcome, status: h.audits[0]?.status, host: h.audits[0]?.host, port: h.audits[0]?.port },
    { outcome: "refused", status: 403, host: "evil.test", port: 443 },
  );
  assert.match(h.audits[0]?.cause ?? "", /allow-list/);
}

test("terminator: a disallowed host is refused with 403 and an audit record, and is never dialed", async () => {
  await expectDisallowedRefused(onlyExample);
});

test("terminator negative control: an allow-all stub fails the disallowed-host expectations", async () => {
  await assert.rejects(expectDisallowedRefused(allowAll));
});

test("terminator: an allowed host gets 200, the bytes behind the header reach upstream, and both directions relay", async () => {
  const h = terminator(onlyExample);
  const c = await connectTo(h, "CONNECT Example.COM.:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nhello-hello");
  assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 200 Connection Established/);
  assert.deepEqual(h.dialed, ["example.com:443"], "host is lower-cased and its trailing dot dropped");
  const up = h.upstreams[0] as Half;
  const upReader = new Reader(up);
  assert.equal(await upReader.until("hello-hello"), "hello-hello");
  await up.write(enc.encode("pong"));
  assert.equal(await c.reader.until("pong"), "pong");
  await c.client.write(enc.encode("ping"));
  assert.equal(await upReader.until("ping"), "ping");
  c.client.close();
  up.close();
  await c.handled;
  assert.equal(h.term.active, 0);
  assert.deepEqual(
    h.audits.map((r) => [r.outcome, r.status, r.host, r.port, r.active]),
    [["allowed", 200, "example.com", 443, 0]],
  );
});

test("terminator: connections past the cap are refused with 503 naming the cap, and a freed slot is reusable", async () => {
  const h = terminator(allowAll, 2);
  const open = async () => {
    const c = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
    await c.reader.until("\r\n\r\n");
    return c;
  };
  const one = await open();
  const two = await open();
  assert.equal(h.term.active, 2);
  const third = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  const head = await third.reader.until("\r\n\r\n");
  assert.match(head, /^HTTP\/1\.1 503 Service Unavailable/);
  assert.match(await third.reader.rest(), /cap of 2 tunnels/);
  await third.handled;
  assert.equal(h.dialed.length, 2, "the refused connection was never dialed");
  const refusal = h.audits.at(-1);
  assert.deepEqual({ outcome: refusal?.outcome, status: refusal?.status, active: refusal?.active }, { outcome: "refused", status: 503, active: 2 });
  // Free one slot: the next connection is accepted.
  one.client.close();
  h.upstreams[0]?.close();
  await one.handled;
  const again = await open();
  assert.equal(h.term.active, 2);
  for (const c of [two, again]) c.client.close();
  for (const u of h.upstreams) u.close();
  await Promise.all([two.handled, again.handled]);
  assert.equal(h.term.active, 0);
});

test("terminator: a header past the size cap is refused with 431, whether or not the blank line arrived", async () => {
  const h = terminator(allowAll, 4, { maxHeaderBytes: 64 });
  const big = `CONNECT a.test:443 HTTP/1.1\r\nX-Pad: ${"x".repeat(200)}`;
  const noEnd = await connectTo(h, big);
  assert.match(await noEnd.reader.until("\r\n\r\n"), /^HTTP\/1\.1 431 /);
  await noEnd.handled;
  const withEnd = await connectTo(h, `${big}\r\n\r\n`);
  assert.match(await withEnd.reader.until("\r\n\r\n"), /^HTTP\/1\.1 431 /);
  await withEnd.handled;
  assert.deepEqual(h.dialed, []);
  assert.deepEqual(
    h.audits.map((r) => r.status),
    [431, 431],
  );
  // Control: the same request under the cap is served.
  const fits = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  assert.match(await fits.reader.until("\r\n\r\n"), /^HTTP\/1\.1 200 /);
  fits.client.close();
  h.upstreams[0]?.close();
  await fits.handled;
});

test("terminator: malformed requests, other methods, bad ports and early closes are refused with the cause", async () => {
  const h = terminator(allowAll);
  const cases: Array<[string, number, RegExp]> = [
    ["GET http://a.test/ HTTP/1.1\r\n\r\n", 405, /only CONNECT/],
    ["CONNECT a.test HTTP/1.1\r\n\r\n", 400, /host:port/],
    ["CONNECT a.test:0 HTTP/1.1\r\n\r\n", 400, /1 to 65535/],
    ["CONNECT a.test:70000 HTTP/1.1\r\n\r\n", 400, /1 to 65535/],
    ["CONNECT a.test:443\r\n\r\n", 400, /malformed/],
    ["CONNECT a@b.test:443 HTTP/1.1\r\n\r\n", 400, /host:port/],
  ];
  for (const [req, status, cause] of cases) {
    const c = await connectTo(h, req);
    assert.match(await c.reader.until("\r\n\r\n"), new RegExp(`^HTTP/1\\.1 ${status} `), req);
    assert.match(await c.reader.rest(), cause, req);
    await c.handled;
  }
  const early = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n");
  early.client.close();
  await early.handled;
  assert.equal(h.audits.at(-1)?.status, 400);
  assert.match(h.audits.at(-1)?.cause ?? "", /closed before sending/);
  assert.deepEqual(h.dialed, [], "nothing malformed is dialed");
  assert.equal(h.audits.length, cases.length + 1);
});

test("terminator: an allow-list that throws refuses the target (fails closed)", async () => {
  const h = terminator(() => {
    throw new Error("list unreadable");
  });
  const c = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 403 /);
  await c.handled;
  assert.deepEqual(h.dialed, []);
  assert.match(h.audits[0]?.cause ?? "", /allow-list check failed/);
});

test("terminator: a dial failure answers 502 with the cause and is audited as dial-failed", async () => {
  const h = terminator(allowAll, 4, { dialError: new Error("connection refused") });
  const c = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 502 /);
  assert.match(await c.reader.rest(), /connection refused/);
  await c.handled;
  assert.deepEqual(
    h.audits.map((r) => [r.outcome, r.status, r.host]),
    [
      ["allowed", 200, "a.test"],
      ["dial-failed", 502, "a.test"],
    ],
    "the allow decision is audited before the dial, the failure after",
  );
  assert.equal(h.term.active, 0);
});

test("terminator: maxConnections is required and must be a positive integer", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, undefined as unknown as number]) {
    assert.throws(
      () =>
        createConnectTerminator({
          allow: allowAll,
          maxConnections: bad,
          dial: async () => halfPipe().a,
          audit: () => {},
          now: () => 0,
          sleep: new Clock().sleep,
        }),
      /maxConnections must be a positive integer/,
    );
  }
});

test("worker stream and terminator together: CONNECT over the mux is audited and the allow-list decides", async () => {
  const { worker, daemon } = await wired();
  const h = terminator(onlyExample);
  const handled: Promise<void>[] = [];
  const daemonLoop = (async () => {
    for await (const conn of daemon.incoming()) handled.push(h.term.handle(conn));
  })();
  for (const [target, status] of [
    ["example.com:443", 200],
    ["evil.test:443", 403],
  ] as const) {
    const { a: local, b: agent } = halfPipe();
    const bridged = worker.bridge(local, "egress");
    await agent.write(enc.encode(`CONNECT ${target} HTTP/1.1\r\n\r\n`));
    const r = new Reader(agent);
    assert.match(await r.until("\r\n\r\n"), new RegExp(`^HTTP/1\\.1 ${status} `));
    agent.close();
    h.upstreams.at(-1)?.close();
    await bridged;
  }
  assert.deepEqual(
    h.audits.map((r) => [r.host, r.status]),
    [
      ["example.com", 200],
      ["evil.test", 403],
    ],
  );
  worker.close();
  await daemonLoop;
  await Promise.all(handled);
});

// ---------------------------------------------------------------------------------------------------------------------------
// reconnect

type Fault = "drop-before-apply" | "drop-after-apply" | "partial-response";

// A daemon that dedups mutating calls by key, like the real server: the first request under a key applies, a repeat returns the
// same result without applying again. Request: `<key> <body>\n`; answer: `ok <applicationNumber>\n`.
class FakeServer {
  applications = 0;
  requests: string[] = [];
  results = new Map<string, number>();
  faults: Array<Fault | undefined> = [];
  alwaysFault: Fault | undefined;
  connects = 0;
  failConnects = 0;
  opened: string[][] = [];
  pairs: End[] = [];
  loops: Promise<void>[] = [];

  async connect(): Promise<MuxPair> {
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error("exec stream unavailable");
    }
    this.connects++;
    const { a, b } = pipe();
    this.pairs.push(b);
    const names: string[] = [];
    this.opened.push(names);
    const mux = createMux(b, { role: "acceptor", accept: ["daemon-api", "egress"] });
    this.loops.push(this.#serve(mux, b, names));
    return a;
  }

  async #serve(mux: ReturnType<typeof createMux>, end: End, names: string[]): Promise<void> {
    const handlers: Promise<void>[] = [];
    for await (const conn of mux.incoming()) {
      names.push(conn.name);
      if (conn.name === "daemon-api") handlers.push(this.#requests(conn, end));
    }
    await Promise.all(handlers);
  }

  async #requests(conn: MuxConnection, end: End): Promise<void> {
    const r = new Reader(conn);
    for (;;) {
      let line: string;
      try {
        line = await r.until("\n");
      } catch {
        return;
      }
      this.requests.push(line.trim());
      const key = line.split(" ")[0] ?? "";
      const fault = this.faults.shift() ?? this.alwaysFault;
      if (fault === "drop-before-apply") {
        end.close();
        return;
      }
      let n = this.results.get(key);
      if (n === undefined) {
        n = ++this.applications;
        this.results.set(key, n);
      }
      if (fault === "drop-after-apply") {
        end.close();
        return;
      }
      if (fault === "partial-response") {
        await conn.write("ok");
        end.close();
        return;
      }
      await conn.write(`ok ${n}\n`);
    }
  }
}

// The exchange used by the tests: one request line, one answer line; a stream that ends first is a dropped link.
async function exchange(conn: MuxConnection, key: string): Promise<string> {
  await conn.write(`${key} do-it\n`);
  const r = new Reader(conn);
  while (!r.buf.includes("\n")) if (!(await r.more())) throw new LinkDroppedError(`got ${JSON.stringify(r.buf)}`);
  const answer = r.buf.trim();
  if (!answer.startsWith("ok ")) throw new Error(`server said ${answer}`);
  return answer;
}

function reconnector(server: FakeServer, extra: Partial<Parameters<typeof createReconnector>[0]> = {}) {
  const sleeps: number[] = [];
  const events: ReconnectEvent[] = [];
  let clock = 0;
  const r = createReconnector({
    connect: () => server.connect(),
    channels: ["daemon-api", "egress"],
    mux: { role: "initiator" },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock,
    random: () => 0,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { r, sleeps, events, advance: (ms: number) => (clock += ms) };
}

test("reconnect: attempts back off exponentially with jitter, capped, and success resets the cycle", async () => {
  const server = new FakeServer();
  server.failConnects = 3;
  const plain = reconnector(server);
  await plain.r.start();
  assert.deepEqual(plain.sleeps, [500, 1000, 2000]);
  plain.r.close();

  const server2 = new FakeServer();
  server2.failConnects = 3;
  const jittered = reconnector(server2, { random: () => 1, backoff: { baseMs: 1000, maxMs: 2500 } });
  await jittered.r.start();
  assert.deepEqual(jittered.sleeps, [1250, 2500, 2500], "jitter adds up to 25 percent, then the cap applies");
  jittered.r.close();
});

test("reconnect: giving up names the cause and the action, and later calls fail the same way instead of hanging", async () => {
  const server = new FakeServer();
  server.failConnects = 99;
  const { r, sleeps, events } = reconnector(server, { backoff: { maxAttempts: 3 } });
  await assert.rejects(
    r.start(),
    (e: unknown) =>
      e instanceof ReconnectError &&
      /after 3 attempt/.test(e.message) &&
      /exec stream unavailable/.test(e.message) &&
      /start the reconnector again/.test(e.message),
  );
  assert.equal(sleeps.length, 2);
  assert.equal(events.at(-1)?.kind, "gave-up");
  await assert.rejects(r.call({ channel: "daemon-api", key: "k", exchange }), ReconnectError);
  assert.equal(server.requests.length, 0);
});

test("reconnect: a retried mutating call is applied exactly once, under the original key, when the link drops after the apply", async () => {
  const server = new FakeServer();
  server.faults = ["drop-after-apply"];
  const { r } = reconnector(server);
  await r.start();
  const answer = await r.call({ channel: "daemon-api", key: "mut-1", exchange });
  assert.equal(answer, "ok 1");
  assert.equal(server.applications, 1, "applied once");
  assert.deepEqual(server.requests, ["mut-1 do-it", "mut-1 do-it"], "the same key was sent on both attempts");
  assert.equal(server.connects, 2);
  r.close();
});

test("reconnect: a call lost before the apply is applied once on the retry", async () => {
  const server = new FakeServer();
  server.faults = ["drop-before-apply"];
  const { r } = reconnector(server);
  await r.start();
  assert.equal(await r.call({ channel: "daemon-api", key: "mut-2", exchange }), "ok 1");
  assert.equal(server.applications, 1);
  assert.equal(server.requests.length, 2);
  r.close();
});

test("reconnect: the named channels are reopened on the new session and usable", async () => {
  const server = new FakeServer();
  server.faults = ["drop-after-apply"];
  const { r } = reconnector(server);
  await r.start();
  const before = r.channel("egress");
  await r.call({ channel: "daemon-api", key: "mut-3", exchange });
  assert.deepEqual(server.opened, [
    ["daemon-api", "egress"],
    ["daemon-api", "egress"],
  ]);
  const after = r.channel("egress");
  assert.notEqual(after, before, "the channel is a fresh connection on the new session");
  await after.write("still works");
  r.close();
});

test("reconnect: a link that drops mid-request never reads as success, including a half-written response", async () => {
  for (const fault of ["drop-before-apply", "drop-after-apply", "partial-response"] as const) {
    const server = new FakeServer();
    server.alwaysFault = fault;
    const { r } = reconnector(server);
    await r.start();
    let outcome: unknown = "resolved";
    await r.call({ channel: "daemon-api", key: "mut-4", exchange, maxAttempts: 2 }).then(
      (v) => {
        outcome = v;
      },
      (e) => {
        outcome = e;
      },
    );
    assert.ok(outcome instanceof CallOutcomeUnknownError, `${fault}: expected an unknown-outcome error, got ${String(outcome)}`);
    assert.match((outcome as Error).message, /mut-4/);
    assert.match((outcome as Error).message, /same key/);
    assert.equal(server.requests.length, 2, `${fault}: two sends`);
    assert.equal(server.applications, fault === "drop-before-apply" ? 0 : 1, `${fault}: never applied twice`);
    r.close();
  }
});

test("reconnect: an answer from the server is not a link failure and is not retried", async () => {
  const server = new FakeServer();
  const { r } = reconnector(server);
  await r.start();
  await assert.rejects(
    r.call({
      channel: "daemon-api",
      key: "mut-5",
      exchange: async () => {
        throw new Error("server said 409 conflict");
      },
    }),
    /409 conflict/,
  );
  assert.equal(server.requests.length, 0);
  assert.equal(server.connects, 1, "no reconnect for an application error");
  r.close();
});

test("reconnect: a session lost soon after it was established waits before the next attempt; a stable one does not", async () => {
  for (const [lived, expected] of [
    [100, [500]],
    [60_000, []],
  ] as const) {
    const server = new FakeServer();
    const { r, sleeps, advance } = reconnector(server);
    await r.start();
    advance(lived);
    server.faults = ["drop-after-apply"];
    await r.call({ channel: "daemon-api", key: `mut-6-${lived}`, exchange });
    assert.deepEqual(sleeps, expected, `session lived ${lived} ms`);
    r.close();
  }
});

test("reconnect: after close() calls are refused and no further connection is made", async () => {
  const server = new FakeServer();
  const { r } = reconnector(server);
  await r.start();
  r.close();
  await assert.rejects(r.call({ channel: "daemon-api", key: "k", exchange }), /closed/);
  assert.equal(server.connects, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------
// hardening: deadlines, audit order, teardown, IP literals

const TIMES = { headerTimeoutMs: 1111, dialTimeoutMs: 2222, idleTimeoutMs: 3333 };

async function openTunnel(h: Harness, target = "a.test:443") {
  const c = await connectTo(h, `CONNECT ${target} HTTP/1.1\r\n\r\n`);
  assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 200 /);
  await tick();
  return { ...c, up: h.upstreams.at(-1) as Half };
}

test("terminator: a client that never finishes the CONNECT line loses its slot at the header deadline, and a later tunnel works", async () => {
  const h = terminator(allowAll, 1, TIMES);
  const slow = await connectTo(h, "CONNECT a.test:4");
  assert.equal(h.term.active, 1);
  const blocked = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  assert.match(await blocked.reader.until("\r\n\r\n"), /^HTTP\/1\.1 503 /, "the slowloris client really holds the only slot");
  await blocked.handled;
  h.clock.fire(TIMES.headerTimeoutMs);
  assert.match(await slow.reader.until("\r\n\r\n"), /^HTTP\/1\.1 408 /);
  await slow.handled;
  assert.equal(h.term.active, 0);
  assert.match(h.audits.at(-1)?.cause ?? "", /not complete within 1111 ms/);
  const ok = await openTunnel(h);
  ok.client.close();
  ok.up.close();
  await ok.handled;
});

test("terminator: a tunnel with no bytes for the idle deadline is cut, and traffic keeps it alive", async () => {
  const h = terminator(allowAll, 4, TIMES);
  const busy = await openTunnel(h);
  let done = false;
  void busy.handled.then(() => {
    done = true;
  });
  await busy.client.write(enc.encode("x"));
  await new Reader(busy.up).until("x");
  h.clock.fire(TIMES.idleTimeoutMs);
  await tick();
  assert.equal(done, false, "bytes within the window keep the tunnel open");
  assert.equal(h.clock.pending(TIMES.idleTimeoutMs), 1, "the watcher re-arms for the next window");
  h.clock.fire(TIMES.idleTimeoutMs);
  await busy.handled;
  assert.equal(h.dialSides[0]?.resets, 1, "the upstream is reset");
  const cut = h.audits.at(-1);
  assert.deepEqual([cut?.outcome, cut?.status, cut?.host], ["tunnel-cut", 200, "a.test"]);
  assert.match(cut?.cause ?? "", /idle limit/);
  assert.equal(h.term.active, 0);
});

test("terminator: a half-open tunnel (one side closed, the other silent) ends at the idle deadline", async () => {
  const h = terminator(allowAll, 4, TIMES);
  const t = await openTunnel(h);
  t.client.close();
  await tick();
  let done = false;
  void t.handled.then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false, "the silent upstream keeps a half-closed tunnel waiting");
  h.clock.fire(TIMES.idleTimeoutMs);
  await t.handled;
  assert.equal(h.dialSides[0]?.resets, 1);
  assert.match(h.audits.at(-1)?.cause ?? "", /idle limit/);
  assert.equal(h.term.active, 0);
});

test("terminator: a dial that exceeds its timeout is answered with 504, and a late stream is closed", async () => {
  let finish!: (d: Half) => void;
  const h = terminator(allowAll, 4, {
    ...TIMES,
    dial: () =>
      new Promise<Half>((resolve) => {
        finish = resolve;
      }),
  });
  const c = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  await tick();
  h.clock.fire(TIMES.dialTimeoutMs);
  assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 504 /);
  assert.match(await c.reader.rest(), /longer than 2222 ms/);
  await c.handled;
  assert.deepEqual(
    h.audits.map((r) => [r.outcome, r.status]),
    [
      ["allowed", 200],
      ["dial-failed", 504],
    ],
  );
  const late = halfPipe();
  finish(late.a);
  await tick();
  assert.equal(late.a.closedLocally, true, "the stream that arrived after the deadline was closed");
  assert.equal(h.term.active, 0);
});

test("terminator: a tunnel past the per-tunnel byte cap is cut and audited", async () => {
  const h = terminator(allowAll, 4, { ...TIMES, maxTunnelBytes: 10 });
  const t = await openTunnel(h);
  await t.client.write(enc.encode("x".repeat(20)));
  await t.handled;
  assert.ok((h.dialSides[0]?.resets ?? 0) >= 1, "the upstream is reset");
  assert.match(h.audits.at(-1)?.cause ?? "", /per-tunnel cap/);
  assert.equal(h.audits.at(-1)?.outcome, "tunnel-cut");
  assert.equal(h.term.active, 0);
});

test("terminator: an audit sink that throws before the dial stops the request undialed, closes the client and frees the slot", async () => {
  const h = terminator(allowAll, 1, {
    audit: () => {
      throw new Error("sink down");
    },
  });
  const c = await connectTo(h, "CONNECT a.test:443 HTTP/1.1\r\n\r\n");
  await assert.rejects(c.handled, /sink down/);
  assert.deepEqual(h.dialed, [], "nothing was dialed without an audit record of the allow decision");
  assert.equal(c.server.closedLocally, true);
  assert.equal(h.term.active, 0);
});

test("terminator: a failure after the dial closes both ends", async () => {
  const h = terminator(allowAll, 4, TIMES);
  const { a, b } = halfPipe();
  a.write = async () => {
    throw new Error("client gone");
  };
  const handled = h.term.handle(a);
  await b.write(enc.encode("CONNECT a.test:443 HTTP/1.1\r\n\r\n"));
  await assert.rejects(handled, /client gone/);
  assert.equal(h.dialSides[0]?.closedLocally, true, "the upstream is closed");
  assert.equal(a.closedLocally, true, "the client is closed");
  assert.equal(h.term.active, 0);
});

test("terminator: a client stream that throws while the header is read is closed", async () => {
  const h = terminator(allowAll, 4, TIMES);
  const { a } = halfPipe();
  a.output = () =>
    (async function* () {
      yield enc.encode("CONNECT a.te");
      throw new Error("socket error");
    })();
  await assert.rejects(h.term.handle(a), /socket error/);
  assert.equal(a.closedLocally, true);
  assert.equal(h.term.active, 0);
});

test("terminator: loopback, link-local, unspecified, mapped and odd-spelled IP literals are refused even when the allow-list says yes", async () => {
  const denied = [
    "127.0.0.1",
    "127.1",
    "0x7f.1",
    "0x7f000001",
    "2130706433",
    "017700000001",
    "0177.0.0.1",
    "01.2.3.4",
    "169.254.169.254",
    "0.0.0.0",
    "0",
    "[::1]",
    "[::]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[::ffff:8.8.8.8]",
    "[::127.0.0.1]",
    "[fe80::1]",
    "[febf::1]",
  ];
  for (const host of denied) {
    const h = terminator(allowAll);
    const c = await connectTo(h, `CONNECT ${host}:80 HTTP/1.1\r\n\r\n`);
    assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 403 /, host);
    await c.handled;
    assert.deepEqual(h.dialed, [], host);
    assert.equal(h.audits.length, 1, host);
    assert.equal(h.audits[0]?.status, 403, host);
  }
});

const PRIVATE_LITERALS = [
  "10.0.0.1",
  "10.255.255.255",
  "172.16.0.1",
  "172.31.255.254",
  "192.168.1.1",
  "100.64.0.1",
  "100.127.255.254",
  "192.0.0.8",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "fc00::1",
  "fd12:3456::1",
  "64:ff9b::808:808",
  "64:ff9b:1::1",
  "ff02::1",
];

test("terminator: private-range IP literals are denied by default, in every spelling", async () => {
  for (const host of PRIVATE_LITERALS) {
    assert.match(ipLiteralDenial(host) ?? "", /private|CGNAT|NAT64|multicast|reserved|broadcast/, host);
  }
  // Non-canonical spellings of 10.0.0.1 and 192.168.1.1 (decimal, hex, octal, short) are refused too.
  for (const host of ["167772161", "0xa000001", "012.0.0.1", "10.1", "3232235777", "0xc0.0xa8.1.1"]) {
    assert.match(ipLiteralDenial(host) ?? "", /non-canonical/, host);
  }
  for (const host of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "192.167.1.1", "11.0.0.1", "fe00::1", "64:ff9a::1"]) {
    assert.equal(ipLiteralDenial(host), undefined, host);
  }
  const h = terminator(allowAll);
  const c = await connectTo(h, "CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n");
  assert.match(await c.reader.until("\r\n\r\n"), /^HTTP\/1\.1 403 /);
  await c.handled;
  assert.deepEqual(h.dialed, []);
  assert.match(h.audits[0]?.cause ?? "", /private[^;]*; .*allowPrivate/);
});

test("terminator: 6to4, Teredo and SIIT literals are denied by the IPv4 they embed (Teredo always)", () => {
  for (const host of [
    "2002:0a00:0001::1",
    "2002:7f00:0001::",
    "2002:c0a8:0101::5",
    "2002:a9fe:a9fe::1",
    "::ffff:0:10.0.0.1",
    "::ffff:0:7f00:1",
    "::ffff:0:a9fe:a9fe",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001::1",
  ]) {
    assert.ok(ipLiteralDenial(host), host);
  }
  for (const host of ["2002:0808:0808::1", "::ffff:0:8.8.8.8", "2001:1::1", "2001:db8::1"]) {
    assert.equal(ipLiteralDenial(host), undefined, host);
  }
  // allowPrivate exempts an embedded private IPv4, never a loopback or Teredo one.
  assert.equal(ipLiteralDenial("2002:0a00:0001::1", ["10.0.0.0/8"]), undefined);
  assert.ok(ipLiteralDenial("2002:7f00:0001::", ["0.0.0.0/0"]));
  assert.ok(ipLiteralDenial("2001::1", ["::/0"]));
});

test("terminator: allowPrivate opts a listed CIDR in, and only private ranges", async () => {
  assert.equal(ipLiteralDenial("10.1.2.3", ["10.0.0.0/8"]), undefined);
  assert.equal(ipLiteralDenial("fd00::5", ["fd00::/8"]), undefined);
  assert.equal(ipLiteralDenial("10.1.2.3", ["192.168.0.0/16"]) === undefined, false, "an unrelated CIDR does not opt in");
  assert.equal(ipLiteralDenial("192.168.1.1", ["10.0.0.0/8"]) === undefined, false);
  // The opt-in never overrides loopback, link-local or unspecified, even when the CIDR covers them.
  for (const host of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.ok(ipLiteralDenial(host, ["0.0.0.0/0", "::/0"]), host);
  }
  const h = terminator(allowAll, 4, { allowPrivate: ["10.0.0.0/8"] });
  const open = await openTunnel(h, "10.0.0.7:443");
  assert.deepEqual(h.dialed, ["10.0.0.7:443"]);
  open.client.close();
  open.up.close();
  await open.handled;
  const other = await connectTo(h, "CONNECT 192.168.0.1:443 HTTP/1.1\r\n\r\n");
  assert.match(await other.reader.until("\r\n\r\n"), /^HTTP\/1\.1 403 /);
  await other.handled;
});

test("terminator: a malformed allowPrivate entry is refused at construction, naming the entry and the fix", () => {
  for (const bad of ["10.0.0.0", "10.0.0.0/33", "nope/8", "fd00::/129", "10.0.0.0/x"]) {
    assert.throws(() => terminator(allowAll, 4, { allowPrivate: [bad] }), new RegExp(`allowPrivate.*${bad.replace(/[./]/g, "\\$&")}.*CIDR`), bad);
  }
});

test("terminator: public IP literals and names pass the built-in deny, and denyIpLiterals:false turns it off", async () => {
  for (const host of ["93.184.216.34", "[2001:db8::1]", "example.com", "169.255.1.1", "[fec0::1]"]) {
    assert.equal(ipLiteralDenial(host.replace(/^\[|\]$/g, "")), undefined, host);
  }
  const h = terminator(allowAll);
  const open = await openTunnel(h, "93.184.216.34:443");
  open.client.close();
  open.up.close();
  await open.handled;
  const off = terminator(allowAll, 4, { denyIpLiterals: false });
  const t = await openTunnel(off, "127.0.0.1:80");
  assert.deepEqual(off.dialed, ["127.0.0.1:80"]);
  t.client.close();
  t.up.close();
  await t.handled;
});

test("assertDialRejectsPrivate: a dial that refuses private targets passes, one that connects fails naming the host", async () => {
  const guarded = async (host: string): Promise<ByteDuplex> => {
    if (ipLiteralDenial(host) || host === "localhost") throw new Error("private target");
    return halfPipe().a;
  };
  await assertDialRejectsPrivate(guarded);
  const leaky = async (host: string): Promise<ByteDuplex> => {
    if (host === "localhost") throw new Error("private target");
    return halfPipe().a;
  };
  await assert.rejects(assertDialRejectsPrivate(leaky), /dial connected to 127\.0\.0\.1/);
});

test("terminator: control characters in the method never reach the audit cause or the reply", async () => {
  const h = terminator(allowAll);
  const c = await connectTo(h, "G\x01E\x1b[31mT a.test:443 HTTP/1.1\r\n\r\n");
  await c.reader.until("\r\n\r\n");
  const body = await c.reader.rest();
  await c.handled;
  for (const text of [body, h.audits[0]?.cause ?? ""]) {
    for (const ch of text) assert.ok(ch === "\n" || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f), `control character in ${JSON.stringify(text)}`);
  }
  assert.match(h.audits[0]?.cause ?? "", /only CONNECT/);
});

test("worker stream: when the stream dies the local connection is reset, never half-closed as if it ended cleanly", async () => {
  const { worker, daemon, a } = await wired();
  const { a: local, b: agent } = halfPipe();
  const bridged = worker.bridge(local, "egress");
  const [remote] = await collect(daemon, 1);
  await remote?.write("partial resp");
  await new Reader(agent).until("partial resp");
  a.close();
  await assert.rejects(bridged, (e: unknown) => e instanceof MuxError && e.code === "transport-ended");
  assert.deepEqual(local.events, ["reset"], "no close (a clean EOF to the agent) before the reset");
});

test("worker stream: maxConnections is required", () => {
  for (const bad of [undefined, 0, 1.5]) {
    assert.throws(() => createWorkerStream({ pair: pipe().a, maxConnections: bad as never }), /maxConnections must be a positive integer/);
  }
});

test("reconnect: once a call was sent, losing the link for good is reported as an unknown outcome with the key", async () => {
  const server = new FakeServer();
  server.faults = ["drop-after-apply"];
  const { r } = reconnector(server);
  await r.start();
  server.failConnects = 99;
  await assert.rejects(
    r.call({ channel: "daemon-api", key: "mut-7", exchange }),
    (e: unknown) => e instanceof CallOutcomeUnknownError && e.key === "mut-7" && /could not re-establish/.test(e.message),
  );
  assert.equal(server.applications, 1);
});

test("reconnect: a failure before the first send is thrown as is, not as an unknown outcome", async () => {
  const server = new FakeServer();
  server.failConnects = 99;
  const { r } = reconnector(server, { backoff: { maxAttempts: 2 } });
  await assert.rejects(r.start(), ReconnectError);
  await assert.rejects(
    r.call({ channel: "daemon-api", key: "mut-8", exchange }),
    (e: unknown) => e instanceof ReconnectError && !(e instanceof CallOutcomeUnknownError),
  );
});

test("reconnect: close() during the backoff gives a typed error, and start() afterwards connects with a live abort signal", async () => {
  const server = new FakeServer();
  server.failConnects = 99;
  const clock = new Clock();
  const { r } = reconnector(server, { sleep: clock.sleep });
  const starting = r.start();
  starting.catch(() => {});
  await tick();
  assert.equal(clock.timers.length, 1, "the first retry is waiting out its backoff");
  r.close();
  await assert.rejects(starting, (e: unknown) => e instanceof ReconnectError && /closed or restarted/.test(e.message));

  const seen: boolean[] = [];
  const server2 = new FakeServer();
  server2.failConnects = 1;
  const again = reconnector(server2, {
    sleep: async (_ms, signal) => {
      seen.push(signal?.aborted ?? false);
    },
  });
  await again.r.start();
  again.r.close();
  server2.failConnects = 1;
  await again.r.start();
  assert.deepEqual(seen, [false, false], "a restarted reconnector does not reuse the aborted signal");
  again.r.close();
});

test("reconnect: start() on a running reconnector closes the old session", async () => {
  const server = new FakeServer();
  const { r } = reconnector(server);
  await r.start();
  const old = r.channel("egress");
  let closed = false;
  void old.closed.then(() => {
    closed = true;
  });
  await r.start();
  await tick();
  assert.equal(closed, true, "the first session's channels are closed");
  assert.equal(server.connects, 2);
  assert.notEqual(r.channel("egress"), old);
  r.close();
});
