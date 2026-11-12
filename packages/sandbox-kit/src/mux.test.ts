import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Mux,
  type MuxConnection,
  MuxError,
  type MuxFlag,
  type MuxFrame,
  MuxFrameParser,
  type MuxPair,
  MUX_HEADER_BYTES,
  advanceChannelId,
  createMux,
  encodeFrame,
} from "./mux.ts";

// In-memory asymmetric pipes with no timers: delivery order is queue order and every wait is on an event.
class Inbox {
  chunks: Uint8Array[] = [];
  wake: (() => void) | undefined;
  ended = false;
  error: Error | undefined;
  push(c: Uint8Array): void {
    this.chunks.push(c);
    this.signal();
  }
  end(): void {
    this.ended = true;
    this.signal();
  }
  fail(e: Error): void {
    this.error = e;
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
      if (this.error) throw this.error;
      if (this.ended) return;
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }
}

class End implements MuxPair {
  inbox = new Inbox();
  peer!: End;
  gate: Promise<void> | undefined;
  writeError: Error | undefined;
  async write(data: Uint8Array): Promise<void> {
    if (this.gate) await this.gate;
    if (this.writeError) throw this.writeError;
    this.peer.inbox.push(data);
  }
  output(): AsyncIterable<Uint8Array> {
    return this.inbox.iterate();
  }
  close(): void {
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

// A hand-driven peer: sends raw frames/bytes into the mux under test and reads the frames it answers with.
class Raw {
  parser = new MuxFrameParser(1 << 20);
  frames: MuxFrame[] = [];
  it: AsyncIterator<Uint8Array>;
  end: End;
  constructor(end: End) {
    this.end = end;
    this.it = end.output()[Symbol.asyncIterator]();
  }
  send(channel: number, flag: MuxFlag, seq: number, payload: Uint8Array | string = ""): Promise<void> {
    const p = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    return this.end.write(encodeFrame({ channel, flag, seq, payload: p }, 1 << 20));
  }
  async next(): Promise<MuxFrame> {
    for (;;) {
      const f = this.frames.shift();
      if (f) return f;
      const r = await bounded(this.it.next(), "a frame from the mux");
      assert.ok(!r.done, "the mux closed its output before the expected frame");
      this.frames.push(...this.parser.push(r.value));
    }
  }
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function readAll(c: MuxConnection): Promise<string> {
  let s = "";
  const it = c.output()[Symbol.asyncIterator]();
  for (;;) {
    const r = await bounded(it.next(), "the connection output to finish");
    if (r.done) return s;
    s += text(r.value);
  }
}

function nextOf(c: MuxConnection): { next(): Promise<IteratorResult<Uint8Array>> } {
  const it = c.output()[Symbol.asyncIterator]();
  return { next: () => bounded(it.next(), "connection output") };
}

async function incomingOf(mux: Mux, n: number): Promise<MuxConnection[]> {
  const out: MuxConnection[] = [];
  const it = mux.incoming()[Symbol.asyncIterator]();
  while (out.length < n) {
    const r = await bounded(it.next(), "an incoming channel");
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

// Bounds every wait on a mux so a mutated or broken mux fails the test instead of hanging until the runner's own timeout.
const BOUND_MS = 5000 * Number(process.env.POMTREE_TEST_TIMEOUT_SCALE ?? 1);
function bounded<T>(p: Promise<T>, what = "the awaited mux event"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${BOUND_MS}ms waiting for ${what}`)), BOUND_MS);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// An acceptor mux fed by a raw initiator that has already opened channels 1 ("x") and 3 ("y").
async function acceptorWithTwo(opts: { maxBufferedBytes?: number; maxFrameBytes?: number; maxOutboundBytes?: number } = {}) {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  const mux = createMux(a, { role: "acceptor", accept: ["x", "y"], onProtocolError: (e) => errors.push(e), ...opts });
  const raw = new Raw(b);
  await raw.send(1, "open", 0, "x");
  await raw.send(3, "open", 0, "y");
  const [c1, c3] = await incomingOf(mux, 2);
  assert.ok(c1 && c3);
  assert.equal((await raw.next()).flag, "open");
  assert.equal((await raw.next()).flag, "open");
  return { mux, raw, c1, c3, errors, a, b };
}

// Deterministic PRNG so the property test is reproducible.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("mux frames: random chunking of the byte stream yields identical frames", () => {
  const rand = prng(1234);
  const flags: MuxFlag[] = ["open", "data", "close", "reset"];
  for (let round = 0; round < 200; round++) {
    const frames: MuxFrame[] = [];
    const count = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < count; i++) {
      const payload = new Uint8Array(Math.floor(rand() * 120));
      for (let j = 0; j < payload.length; j++) payload[j] = Math.floor(rand() * 256);
      frames.push({ channel: Math.floor(rand() * 2 ** 32), flag: flags[Math.floor(rand() * 4)] as MuxFlag, seq: Math.floor(rand() * 2 ** 32), payload });
    }
    const wire = Buffer.concat(frames.map((f) => encodeFrame(f, 128)));
    const parser = new MuxFrameParser(128);
    const got: MuxFrame[] = [];
    for (let at = 0; at < wire.length; ) {
      const n = 1 + Math.floor(rand() * 40);
      got.push(...parser.push(wire.subarray(at, at + n)));
      at += n;
    }
    assert.deepEqual(got, frames, `round ${round}`);
    assert.deepEqual(parser.pending(), { bytes: 0, channel: null });
  }
});

test("mux frames: a declared length above the maximum is refused at the header, and the encoder refuses to build one", () => {
  const header = Buffer.alloc(MUX_HEADER_BYTES);
  header.writeUInt32BE(7, 0);
  header.writeUInt8(2, 4);
  header.writeUInt32BE(0, 5);
  header.writeUInt32BE(17, 9);
  const parser = new MuxFrameParser(16);
  assert.throws(
    () => parser.push(header),
    (e: unknown) => e instanceof MuxError && e.code === "frame-too-large" && e.channel === 7 && /reconnect/.test(e.message),
  );
  assert.throws(
    () => encodeFrame({ channel: 1, flag: "data", seq: 0, payload: new Uint8Array(17) }, 16),
    (e: unknown) => e instanceof MuxError && e.code === "frame-too-large" && /split/.test(e.message),
  );
  assert.equal(
    encodeFrame({ channel: 1, flag: "data", seq: 0, payload: new Uint8Array(16) }, 16).length,
    MUX_HEADER_BYTES + 16,
    "exactly at the maximum is legal",
  );
});

test("mux frames: an unknown flag byte is refused", () => {
  const header = Buffer.alloc(MUX_HEADER_BYTES);
  header.writeUInt8(3, 4);
  assert.throws(
    () => new MuxFrameParser().push(header),
    (e: unknown) => e instanceof MuxError && e.code === "bad-flag",
  );
});

test("mux: open handshake, bidirectional ordered data, and both ends closing", async () => {
  const { a, b } = pipe();
  const initiator = createMux(a, { role: "initiator", accept: ["egress"] });
  const acceptor = createMux(b, { role: "acceptor", accept: ["daemon-api", "workspace"] });
  const accepted = incomingOf(acceptor, 1);
  const client = await bounded(initiator.open("daemon-api"), "open");
  const [server] = await bounded(accepted);
  assert.ok(server);
  assert.equal(server.name, "daemon-api");
  assert.equal(client.id % 2, 1);
  await Promise.all(["one", "two", "three"].map((s) => client.write(s)));
  await server.write("reply");
  const incoming = nextOf(server);
  assert.equal(text((await incoming.next()).value as Uint8Array), "one");
  assert.equal(text((await incoming.next()).value as Uint8Array), "two");
  assert.equal(text((await incoming.next()).value as Uint8Array), "three");
  assert.equal(text((await nextOf(client).next()).value as Uint8Array), "reply");
  // The acceptor may open too, on its own (even) id range.
  const back = acceptor.open("egress");
  const [reverse] = await incomingOf(initiator, 1);
  const opened = await bounded(back);
  assert.equal(opened.id % 2, 0);
  assert.equal(reverse?.name, "egress");
  // Half close: the closer's peer sees EOF but can still write.
  client.close();
  client.close();
  assert.equal((await incoming.next()).done, true, "the closer's peer sees EOF after the buffered data");
  await server.write("late");
  await assert.rejects(client.write("x"), (e: unknown) => e instanceof MuxError && e.code === "closed" && /open a new channel/.test(e.message));
  server.close();
  assert.deepEqual(await bounded(client.closed, "closed"), { kind: "closed" });
  assert.deepEqual(await bounded(server.closed, "closed"), { kind: "closed" });
});

test("mux: a channel name the peer does not accept is refused with cause and action, and the mux stays usable", async () => {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  const initiator = createMux(a, { role: "initiator" });
  const acceptor = createMux(b, { role: "acceptor", accept: ["daemon-api"], onProtocolError: (e) => errors.push(e) });
  await assert.rejects(
    initiator.open("workspace"),
    (e: unknown) => e instanceof MuxError && e.code === "open-refused" && /not accepted/.test(e.message) && /check the channel name/.test(e.message),
  );
  assert.equal(errors[0]?.code, "open-refused");
  const accepted = incomingOf(acceptor, 1);
  const ok = await bounded(initiator.open("daemon-api"), "open");
  assert.equal((await bounded(accepted))[0]?.name, "daemon-api");
  assert.equal(ok.name, "daemon-api");
});

test("mux: a write larger than the frame maximum is split into frames within it, in sequence, and reassembles in order", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator", maxFrameBytes: 16 });
  const raw = new Raw(b);
  const opening = mux.open("x");
  const open = await raw.next();
  await raw.send(open.channel, "open", 0);
  const conn = await bounded(opening);
  const payload = "0123456789".repeat(4);
  await conn.write(payload);
  const frames = [await raw.next(), await raw.next(), await raw.next()];
  assert.deepEqual(
    frames.map((f) => [f.flag, f.seq, f.payload.length]),
    [
      ["data", 1, 16],
      ["data", 2, 16],
      ["data", 3, 8],
    ],
  );
  assert.equal(frames.map((f) => text(f.payload)).join(""), payload);
});

test("mux: an oversize declared length on the wire fails the whole mux, every channel with the same error", async () => {
  const { mux, raw, c1, c3 } = await acceptorWithTwo({ maxFrameBytes: 16 });
  const header = Buffer.alloc(MUX_HEADER_BYTES);
  header.writeUInt32BE(1, 0);
  header.writeUInt8(2, 4);
  header.writeUInt32BE(1, 5);
  header.writeUInt32BE(17, 9);
  await raw.end.write(header);
  const errors = await Promise.all([readAll(c1).catch((e) => e), readAll(c3).catch((e) => e), mux.closed]);
  assert.ok(errors[0] instanceof MuxError && errors[0].code === "frame-too-large");
  assert.equal(errors[1], errors[0]);
  assert.equal((errors[2] as { error?: MuxError }).error, errors[0]);
});

// NEG 1: input that ends inside one connection's frame fails only that connection.
test("mux NEG: a truncated frame fails only its own connection; the others keep their data and end cleanly", async () => {
  const { mux, raw, c1, c3, errors } = await acceptorWithTwo();
  await raw.send(1, "data", 1, "ab");
  await raw.send(3, "data", 1, "cd");
  const partial = encodeFrame({ channel: 1, flag: "data", seq: 2, payload: new TextEncoder().encode("12345") });
  await raw.end.write(partial.subarray(0, MUX_HEADER_BYTES + 2));
  raw.end.close();
  const first = nextOf(c1);
  assert.equal(text((await first.next()).value as Uint8Array), "ab");
  await assert.rejects(
    first.next(),
    (e: unknown) => e instanceof MuxError && e.code === "truncated-frame" && e.channel === 1 && /reopen the channel/.test(e.message),
  );
  assert.equal(await readAll(c3), "cd", "the other connection is not failed by the truncation");
  assert.deepEqual(await bounded(c3.closed, "closed"), { kind: "transport-ended" });
  assert.equal(((await bounded(c1.closed, "closed")) as { error: MuxError }).error.code, "truncated-frame");
  assert.deepEqual(await bounded(mux.closed, "closed"), {});
  assert.equal(errors.at(-1)?.code, "truncated-frame");
});

test("mux: control for the truncation check - the same bytes ending on a frame boundary fail nothing", async () => {
  const { raw, c1, c3 } = await acceptorWithTwo();
  await raw.send(1, "data", 1, "ab");
  await raw.send(3, "data", 1, "cd");
  raw.end.close();
  assert.equal(await readAll(c1), "ab");
  assert.equal(await readAll(c3), "cd");
  assert.deepEqual(await bounded(c1.closed, "closed"), { kind: "transport-ended" });
});

test("mux: input ending inside the channel id bytes cannot name a connection, so every connection fails with the same error", async () => {
  const { raw, c1, c3 } = await acceptorWithTwo();
  await raw.end.write(Buffer.from([0, 0, 0]));
  raw.end.close();
  const [e1, e3] = await Promise.all([readAll(c1).catch((e) => e), readAll(c3).catch((e) => e)]);
  assert.ok(e1 instanceof MuxError && e1.code === "truncated-frame");
  assert.equal(e3, e1);
});

// NEG 2: sequence numbers.
test("mux NEG: an out-of-order input write is detected, that channel is reset, and the other channel continues", async () => {
  const { raw, c1, c3, errors } = await acceptorWithTwo();
  await raw.send(1, "data", 1, "a");
  await raw.send(3, "data", 1, "c");
  await raw.send(1, "data", 3, "SKIPPED-2"); // frame 2 never arrived
  await raw.send(3, "data", 2, "d");
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag], [1, "reset"]);
  const first = nextOf(c1);
  assert.equal(text((await first.next()).value as Uint8Array), "a");
  await assert.rejects(
    first.next(),
    (e: unknown) => e instanceof MuxError && e.code === "sequence" && e.channel === 1 && /expected/.test(e.message) && /reopen it and retry/.test(e.message),
  );
  const second = nextOf(c3);
  assert.equal(text((await second.next()).value as Uint8Array), "c");
  assert.equal(text((await second.next()).value as Uint8Array), "d");
  assert.equal(errors.find((e) => e.code === "sequence")?.channel, 1);
  await c3.write("still writable");
  const echoed = await raw.next();
  assert.deepEqual([echoed.channel, echoed.flag], [3, "data"]);
});

test("mux NEG: a replayed (duplicate) frame is detected the same way", async () => {
  const { raw, c1 } = await acceptorWithTwo();
  await raw.send(1, "data", 1, "a");
  await raw.send(1, "data", 1, "a");
  const first = nextOf(c1);
  assert.equal(text((await first.next()).value as Uint8Array), "a");
  await assert.rejects(first.next(), (e: unknown) => e instanceof MuxError && e.code === "sequence");
});

// NEG 3: channel ids.
test("mux NEG: a frame for an unknown channel id is rejected with a reset and reported; open channels are untouched", async () => {
  const { raw, c1, errors } = await acceptorWithTwo();
  await raw.send(99, "data", 0, "stray");
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag, text(reset.payload)], [99, "reset", "unknown channel"]);
  const unknown = errors.find((e) => e.code === "unknown-channel");
  assert.equal(unknown?.channel, 99);
  assert.match(unknown?.message ?? "", /not open on this mux/);
  await raw.send(1, "data", 1, "fine");
  assert.equal(text((await nextOf(c1).next()).value as Uint8Array), "fine");
});

test("mux NEG: an open with an id from the wrong range is rejected, not accepted", async () => {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  createMux(a, { role: "acceptor", accept: ["x"], onProtocolError: (e) => errors.push(e) });
  const raw = new Raw(b);
  await raw.send(2, "open", 0, "x"); // even ids belong to the acceptor
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag], [2, "reset"]);
  assert.equal(errors[0]?.code, "unknown-channel");
});

test("mux: a late frame on a channel that was just closed is dropped without a reset reply or a report", async () => {
  const { raw, c1, c3, errors } = await acceptorWithTwo();
  c1.reset("done");
  assert.deepEqual([(await raw.next()).flag], ["reset"]);
  await raw.send(1, "data", 1, "in flight");
  await raw.send(3, "data", 1, "after");
  await nextOf(c3).next(); // frames are handled in order, so the late frame on channel 1 has been handled by now
  await c3.write("probe");
  const next = await raw.next();
  assert.deepEqual([next.channel, next.flag, text(next.payload)], [3, "data", "probe"], "no reset was sent for the late frame");
  assert.equal(errors.length, 0);
});

test("mux: a bad flag byte on the wire fails the whole mux loudly", async () => {
  const { mux, raw, c1, c3 } = await acceptorWithTwo();
  const bad = Buffer.alloc(MUX_HEADER_BYTES);
  bad.writeUInt32BE(1, 0);
  bad.writeUInt8(5, 4);
  await raw.end.write(bad);
  const [e1, e3] = await Promise.all([readAll(c1).catch((e) => e), readAll(c3).catch((e) => e)]);
  assert.ok(e1 instanceof MuxError && e1.code === "bad-flag");
  assert.equal(e3, e1);
  assert.equal(((await bounded(mux.closed, "closed")) as { error?: MuxError }).error, e1);
  await assert.rejects(bounded(mux.open("x"), "open"), (e: unknown) => e === e1);
});

test("mux: unread bytes past the buffer cap reset that channel only", async () => {
  const { raw, c1, c3 } = await acceptorWithTwo({ maxBufferedBytes: 30 });
  await raw.send(1, "data", 1, "123456");
  await raw.send(1, "data", 2, "789012");
  await raw.send(3, "data", 1, "ok");
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag], [1, "reset"]);
  assert.equal(((await bounded(c1.closed, "closed")) as { error: MuxError }).error.code, "buffer-overflow");
  assert.equal(text((await nextOf(c3).next()).value as Uint8Array), "ok");
});

test("mux: write waits for the transport to accept the bytes (backpressure) and keeps call order", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator" });
  const raw = new Raw(b);
  const opening = mux.open("x");
  await raw.send((await raw.next()).channel, "open", 0);
  const conn = await bounded(opening);
  let release!: () => void;
  a.gate = new Promise<void>((r) => {
    release = r;
  });
  let first = false;
  let second = false;
  const w1 = conn.write("first").then(() => {
    first = true;
  });
  const w2 = conn.write("second").then(() => {
    second = true;
  });
  await tick();
  await tick();
  assert.deepEqual([first, second], [false, false], "not accepted while the transport is blocked");
  release();
  await bounded(Promise.all([w1, w2]));
  const f1 = await raw.next();
  const f2 = await raw.next();
  assert.deepEqual([text(f1.payload), f1.seq, text(f2.payload), f2.seq], ["first", 1, "second", 2]);
});

test("mux: a peer reset surfaces its reason on that channel only", async () => {
  const { a, b } = pipe();
  const initiator = createMux(a, { role: "initiator" });
  const acceptor = createMux(b, { role: "acceptor", accept: ["x", "y"] });
  const accepted = incomingOf(acceptor, 2);
  const x = await bounded(initiator.open("x"), "open");
  const y = await bounded(initiator.open("y"), "open");
  const [sx, sy] = await bounded(accepted);
  assert.ok(sx && sy);
  x.reset("boom");
  await assert.rejects(readAll(sx), (e: unknown) => e instanceof MuxError && e.code === "reset-by-peer" && /boom/.test(e.message));
  await y.write("alive");
  assert.equal(text((await nextOf(sy).next()).value as Uint8Array), "alive");
});

test("mux: the transport input failing fails every channel, pending open and incoming() with the same error", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator", accept: ["z"] });
  const raw = new Raw(b);
  const first = mux.open("x");
  await raw.send((await raw.next()).channel, "open", 0);
  const conn = await bounded(first);
  const pendingOpen = mux.open("never-acked");
  const incoming = mux.incoming()[Symbol.asyncIterator]();
  const waiting = incoming.next();
  await raw.next();
  const cause = new Error("exec stream reset");
  a.inbox.fail(cause);
  const results = await Promise.all([readAll(conn).catch((e) => e), pendingOpen.catch((e) => e), waiting.catch((e) => e), mux.closed]);
  const writeError = await conn.write("x").catch((e) => e);
  const err = results[0];
  assert.ok(err instanceof MuxError && err.code === "transport-failed" && err.cause === cause && /reconnect/.test(err.message));
  assert.equal(results[1], err);
  assert.equal(results[2], err);
  assert.equal(writeError, err);
  assert.equal((results[3] as { error?: MuxError }).error, err);
});

test("mux: the transport output failing on write fails the whole mux and the write rejects with that error", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "acceptor", accept: ["x", "y"] });
  const raw = new Raw(b);
  await raw.send(1, "open", 0, "x");
  await raw.send(3, "open", 0, "y");
  const [c1, c3] = await incomingOf(mux, 2);
  assert.ok(c1 && c3);
  await raw.next();
  await raw.next();
  a.writeError = new Error("broken pipe");
  const err = await c1.write("boom").catch((e) => e);
  assert.ok(err instanceof MuxError && err.code === "transport-failed" && /broken pipe/.test(err.message));
  assert.equal(await readAll(c3).catch((e) => e), err);
});

test("mux: close() ends every channel without error and finishes incoming()", async () => {
  const { c1, c3, mux } = await acceptorWithTwo();
  const incoming = mux.incoming()[Symbol.asyncIterator]();
  const done = incoming.next();
  mux.close();
  assert.deepEqual(await bounded(c1.closed, "closed"), { kind: "mux-closed" });
  assert.deepEqual(await bounded(c3.closed, "closed"), { kind: "mux-closed" });
  assert.equal((await done).done, true);
  await assert.rejects(bounded(mux.open("x"), "open"), (e: unknown) => e instanceof MuxError && e.code === "closed");
});

test("mux: opening past the connection limit is refused with the limit named", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator", maxConnections: 1 });
  const raw = new Raw(b);
  const first = mux.open("x");
  await raw.send((await raw.next()).channel, "open", 0);
  await bounded(first);
  await assert.rejects(bounded(mux.open("y"), "open"), (e: unknown) => e instanceof MuxError && e.code === "limit" && /1 connections/.test(e.message));
});

test("mux: a flood of empty data frames counts against the buffer cap and resets that channel only", async () => {
  const { raw, c1, c3 } = await acceptorWithTwo({ maxBufferedBytes: 60 });
  for (let seq = 1; seq <= 10; seq++) await raw.send(1, "data", seq);
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag], [1, "reset"]);
  assert.equal(((await bounded(c1.closed)) as { error: MuxError }).error.code, "buffer-overflow");
  await raw.send(3, "data", 1, "ok");
  assert.equal(text((await nextOf(c3).next()).value as Uint8Array), "ok");
});

test("mux: channels the peer opens and resets while nobody reads incoming() are not kept", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "acceptor", accept: ["x"], maxConnections: 4 });
  const raw = new Raw(b);
  for (let i = 0; i < 200; i++) {
    const id = 2 * i + 1;
    await raw.send(id, "open", 0, "x");
    assert.equal((await raw.next()).flag, "open", `open ${i} is acknowledged, not refused`);
    await raw.send(id, "reset", 1, "gone");
  }
  mux.close();
  assert.deepEqual(await incomingOf(mux, 5), [], "none of the reset channels is handed out");
});

test("mux: opens past the connection limit are refused with a reset", async () => {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  createMux(a, { role: "acceptor", accept: ["x"], maxConnections: 2, onProtocolError: (e) => errors.push(e) });
  const raw = new Raw(b);
  for (const id of [1, 3]) {
    await raw.send(id, "open", 0, "x");
    assert.equal((await raw.next()).flag, "open");
  }
  await raw.send(5, "open", 0, "x");
  const refused = await raw.next();
  assert.deepEqual([refused.channel, refused.flag], [5, "reset"]);
  assert.match(text(refused.payload), /connection limit of 2/);
  assert.equal(errors.at(-1)?.code, "open-refused");
});

test("mux: a peer flooding frames that elicit resets while never reading kills the mux with a typed error", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "acceptor", maxOutboundBytes: 100 });
  const raw = new Raw(b);
  let release!: () => void;
  a.gate = new Promise<void>((r) => {
    release = r;
  });
  for (let i = 0; i < 20; i++) await raw.send(2 * i + 101, "data", 0, "stray");
  const closed = (await bounded(mux.closed, "the mux to die")) as { error?: MuxError };
  assert.ok(closed.error instanceof MuxError && closed.error.code === "outbound-overflow");
  assert.match(closed.error.message, /reconnect/);
  assert.ok(mux.pendingOutboundBytes <= 100 + 40, "the queue stopped growing at the cap");
  release();
});

test("mux: write builds frames only as the transport accepts them, so a stalled transport holds one frame, not the payload", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator", maxFrameBytes: 16 });
  const raw = new Raw(b);
  const opening = mux.open("x");
  await raw.send((await raw.next()).channel, "open", 0);
  const conn = await bounded(opening);
  let release!: () => void;
  a.gate = new Promise<void>((r) => {
    release = r;
  });
  const write = conn.write("0123456789".repeat(16)); // 160 bytes = 10 frames
  await tick();
  await tick();
  assert.ok(mux.pendingOutboundBytes > 0 && mux.pendingOutboundBytes <= MUX_HEADER_BYTES + 16, `queued ${mux.pendingOutboundBytes} bytes`);
  release();
  await bounded(write);
  const frames: MuxFrame[] = [];
  for (let i = 0; i < 10; i++) frames.push(await raw.next());
  assert.deepEqual(
    frames.map((f) => f.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(frames.map((f) => text(f.payload)).join(""), "0123456789".repeat(16));
});

test("mux: concurrent writes on one connection are not interleaved, and close() follows the pending data", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator", maxFrameBytes: 16 });
  const raw = new Raw(b);
  const opening = mux.open("x");
  await raw.send((await raw.next()).channel, "open", 0);
  const conn = await bounded(opening);
  const w1 = conn.write("A".repeat(40));
  const w2 = conn.write("B".repeat(40));
  conn.close();
  await bounded(Promise.all([w1, w2]));
  const frames: MuxFrame[] = [];
  for (let i = 0; i < 7; i++) frames.push(await raw.next());
  assert.deepEqual(
    frames.map((f) => f.flag),
    ["data", "data", "data", "data", "data", "data", "close"],
  );
  assert.equal(frames.map((f) => text(f.payload)).join(""), "A".repeat(40) + "B".repeat(40));
  assert.deepEqual(
    frames.map((f) => f.seq),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("mux: open() and incoming() give up on abort or timeout, and an aborted open resets the half-open channel", async () => {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  const mux = createMux(a, { role: "initiator", accept: ["s"], onProtocolError: (e) => errors.push(e) });
  const raw = new Raw(b);
  const ctl = new AbortController();
  const opening = mux.open("x", { signal: ctl.signal });
  const open = await raw.next();
  ctl.abort();
  await assert.rejects(bounded(opening), (e: unknown) => e instanceof MuxError && e.code === "aborted" && /retry/.test(e.message));
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag, text(reset.payload)], [open.channel, "reset", "open aborted"]);
  await raw.send(open.channel, "open", 0); // a late acknowledgement is dropped: no report, no reset
  await raw.send(2, "open", 0, "s");
  const sentinel = await raw.next();
  assert.deepEqual([sentinel.channel, sentinel.flag], [2, "open"], "the first reply is the sentinel's acknowledgement, not a reset for the late ack");
  assert.deepEqual(errors, []);
  await assert.rejects(bounded(mux.open("y", { signal: ctl.signal })), (e: unknown) => e instanceof MuxError && e.code === "aborted");
  await assert.rejects(bounded(mux.open("z", { timeoutMs: 1 })), (e: unknown) => e instanceof MuxError && e.code === "aborted");
  assert.equal((await incomingOf(mux, 1))[0]?.name, "s", "the sentinel channel is the only one handed out");
  const wait = new AbortController();
  const next = mux.incoming({ signal: wait.signal })[Symbol.asyncIterator]().next();
  wait.abort();
  await assert.rejects(bounded(next), (e: unknown) => e instanceof MuxError && e.code === "aborted");
});

test("mux: a write failing after a clean close() does not make incoming() throw or the mux report an error", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "initiator" });
  const raw = new Raw(b);
  const opening = mux.open("x");
  await raw.send((await raw.next()).channel, "open", 0);
  const conn = await bounded(opening);
  const incoming = mux.incoming()[Symbol.asyncIterator]();
  const waiting = incoming.next();
  let release!: () => void;
  a.gate = new Promise<void>((r) => {
    release = r;
  });
  a.writeError = new Error("broken pipe");
  const write = conn.write("x");
  await tick();
  mux.close();
  release();
  await assert.rejects(bounded(write), (e: unknown) => e instanceof MuxError && e.code === "transport-failed");
  assert.equal((await bounded(waiting)).done, true);
  assert.deepEqual(await bounded(mux.closed), {});
  // The failed write must not turn the settled mux into a dead one for later callers.
  assert.equal((await bounded(mux.incoming()[Symbol.asyncIterator]().next())).done, true);
  await assert.rejects(bounded(mux.open("y")), (e: unknown) => e instanceof MuxError && e.code === "closed");
});

test("mux: close() closes the pair, which ends the input iterator the pump reads", async () => {
  let ended!: () => void;
  const iteratorEnded = new Promise<void>((r) => {
    ended = r;
  });
  const inbox = new Inbox();
  const pair: MuxPair = {
    write: async () => {},
    output: () =>
      (async function* () {
        try {
          yield* inbox.iterate();
        } finally {
          ended();
        }
      })(),
    close: () => inbox.end(),
  };
  const mux = createMux(pair, { role: "initiator" });
  mux.close();
  await bounded(iteratorEnded, "the pump to stop reading");
});

test("mux: an initiator rejects an open that uses its own id range", async () => {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  createMux(a, { role: "initiator", accept: ["x"], onProtocolError: (e) => errors.push(e) });
  const raw = new Raw(b);
  await raw.send(3, "open", 0, "x"); // odd ids belong to the initiator
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag], [3, "reset"]);
  assert.equal(errors[0]?.code, "unknown-channel");
  await raw.send(2, "open", 0, "x");
  assert.equal((await raw.next()).flag, "open", "the peer's own range is accepted");
});

test("mux: sequence numbers wrap at 2^32 in both directions instead of failing", async () => {
  const { raw, c1 } = await acceptorWithTwo();
  c1.recvSeq = 0xffff_ffff;
  c1.sendSeq = 0xffff_ffff;
  await raw.send(1, "data", 0xffff_ffff, "a");
  await raw.send(1, "data", 0, "b");
  const it = nextOf(c1);
  assert.equal(text((await it.next()).value as Uint8Array), "a");
  assert.equal(text((await it.next()).value as Uint8Array), "b");
  await c1.write("x");
  await c1.write("y");
  assert.deepEqual([(await raw.next()).seq, (await raw.next()).seq], [0xffff_ffff, 0]);
});

test("mux: closed-channel tombstones are evicted past 256 entries, so only recent ids are dropped silently", async () => {
  const { a, b } = pipe();
  const errors: MuxError[] = [];
  createMux(a, { role: "acceptor", accept: ["x"], onProtocolError: (e) => errors.push(e) });
  const raw = new Raw(b);
  for (let i = 0; i < 300; i++) {
    await raw.send(2 * i + 1, "open", 0, "x");
    assert.equal((await raw.next()).flag, "open");
    await raw.send(2 * i + 1, "reset", 1, "gone");
  }
  await raw.send(599, "data", 0, "recent"); // the newest id is still remembered: silent
  await raw.send(1, "data", 0, "old"); // the oldest was evicted: unknown, so rejected
  const reset = await raw.next();
  assert.deepEqual([reset.channel, reset.flag], [1, "reset"]);
  assert.deepEqual(
    errors.filter((e) => e.code === "unknown-channel").map((e) => e.channel),
    [1],
  );
});

test("mux: channel ids advance by two within their range, wrap past 2^32 - 1, and never reach 0", () => {
  assert.equal(advanceChannelId(1), 3);
  assert.equal(advanceChannelId(2), 4);
  assert.equal(advanceChannelId(0xffff_ffff), 1);
  assert.equal(advanceChannelId(0xffff_fffe), 2);
  assert.equal(advanceChannelId(0xffff_fffd), 0xffff_ffff);
});

test("mux: honest data load alone never trips the outbound cap, while a reset flood still does", async () => {
  const { mux, raw, c1, c3, a } = await acceptorWithTwo({ maxFrameBytes: 16, maxOutboundBytes: 40 });
  let release!: () => void;
  a.gate = new Promise<void>((r) => {
    release = r;
  });
  const w1 = c1.write("a".repeat(16));
  const w3 = c3.write("b".repeat(16));
  await tick();
  assert.ok(mux.pendingOutboundBytes > 40, "queued data alone is over the cap");
  await raw.send(99, "data", 0, "stray"); // one routine reset on top of it
  await tick();
  release();
  await bounded(Promise.all([w1, w3]));
  const frames = [await raw.next(), await raw.next(), await raw.next()];
  assert.deepEqual(frames.map((f) => f.flag).sort(), ["data", "data", "reset"]);
  await bounded(c1.write("still alive"));
  a.gate = new Promise<void>(() => {});
  for (let i = 0; i < 10; i++) await raw.send(2 * i + 101, "data", 0, "stray");
  const closed = (await bounded(mux.closed, "the flood to kill the mux")) as { error?: MuxError };
  assert.equal(closed.error?.code, "outbound-overflow");
});

test("mux: an open acknowledgement that overflows the outbound cap kills the mux without handing out the connection", async () => {
  const { a, b } = pipe();
  const mux = createMux(a, { role: "acceptor", accept: ["x"], maxOutboundBytes: 5 });
  const raw = new Raw(b);
  await raw.send(1, "open", 0, "x");
  await assert.rejects(bounded(mux.incoming()[Symbol.asyncIterator]().next()), (e: unknown) => e instanceof MuxError && e.code === "outbound-overflow");
});

test("mux: closing after the peer closed resolves closed at once; a failed flush of the close frame fails the mux", async () => {
  const { mux, raw, c1, a } = await acceptorWithTwo();
  await raw.send(1, "close", 1);
  assert.equal(await readAll(c1), "");
  let release!: () => void;
  a.gate = new Promise<void>((r) => {
    release = r;
  });
  a.writeError = new Error("broken pipe");
  c1.close();
  assert.deepEqual(await bounded(c1.closed), { kind: "closed" }, "closed does not wait for the flush");
  release();
  const closed = (await bounded(mux.closed, "the flush failure")) as { error?: MuxError };
  assert.equal(closed.error?.code, "transport-failed");
});
