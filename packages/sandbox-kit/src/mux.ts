// Channel multiplexer over one asymmetric byte-stream pair (one direction in, one out), such as the exec stream a hosted provider
// gives. Pure: no sockets, timers or fs; the pair is injected. Many named connections share the pair, each with its own
// sequence numbers, bounded inbound buffer and independent close.
//
// Wire format, big-endian, 13-byte header then `length` payload bytes:
//   channel u32 | flag u8 (1 open, 2 data, 4 close, 8 reset) | seq u32 | length u32
// `seq` counts frames per connection and direction from 0 (the open frame, or the acceptor's open acknowledgement) and wraps at 2^32
// on both ends (a connection that long-lived keeps working; it does not die).
// Handshake: the opener sends open (payload = channel name); the acceptor answers open with an empty payload, or reset (payload = reason).
// Opener ids are odd for the "initiator" role and even for "acceptor", so both ends may open without colliding.
//
// Failure scopes (a stream of frames that loses sync cannot be resumed, so the scope follows what is still known):
//   - a bad sequence number, an overflowing inbound buffer, a peer reset, or input that ends in the middle of one connection's frame
//     fails only that connection; every other connection continues;
//   - a frame for an unknown channel id is rejected (the peer is sent a reset) and reported to `onProtocolError`; nothing else changes;
//   - a bad flag byte, an over-size declared length, or input that ends inside the first four header bytes (no connection can be named)
//     fails the whole mux, as does the pair throwing on either direction: every connection and pending open gets the same error;
//   - input that ends cleanly (the pair's output iterator completes) ends connections that the peer did not close: their output()
//     finishes after buffered data, writes reject, and closed reports "transport-ended".

export const MUX_HEADER_BYTES = 13;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
export const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_MAX_OUTBOUND_BYTES = 4 * 1024 * 1024;

const FLAG_BITS = { open: 1, data: 2, close: 4, reset: 8 } as const;
export type MuxFlag = keyof typeof FLAG_BITS;
const FLAG_NAMES = new Map<number, MuxFlag>(Object.entries(FLAG_BITS).map(([name, bit]) => [bit, name as MuxFlag]));

export interface MuxFrame {
  channel: number;
  flag: MuxFlag;
  seq: number;
  payload: Uint8Array;
}

export type MuxErrorCode =
  | "frame-too-large"
  | "bad-flag"
  | "truncated-frame"
  | "sequence"
  | "unknown-channel"
  | "buffer-overflow"
  | "open-refused"
  | "reset-by-peer"
  | "protocol"
  | "transport-failed"
  | "transport-ended"
  | "closed"
  | "limit"
  | "outbound-overflow"
  | "aborted";

export class MuxError extends Error {
  readonly code: MuxErrorCode;
  readonly channel?: number;
  constructor(code: MuxErrorCode, message: string, opts: { channel?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "MuxError";
    this.code = code;
    if (opts.channel !== undefined) this.channel = opts.channel;
  }
}

export function encodeFrame(frame: MuxFrame, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  if (frame.payload.length > maxFrameBytes) {
    throw new MuxError(
      "frame-too-large",
      `frame payload of ${frame.payload.length} bytes exceeds the ${maxFrameBytes}-byte maximum; split the write into smaller frames`,
      { channel: frame.channel },
    );
  }
  const out = Buffer.alloc(MUX_HEADER_BYTES + frame.payload.length);
  out.writeUInt32BE(frame.channel >>> 0, 0);
  out.writeUInt8(FLAG_BITS[frame.flag], 4);
  out.writeUInt32BE(frame.seq >>> 0, 5);
  out.writeUInt32BE(frame.payload.length, 9);
  out.set(frame.payload, MUX_HEADER_BYTES);
  return out;
}

// Incremental frame decoder: any chunking of the same bytes yields the same frames.
export class MuxFrameParser {
  #buf: Buffer = Buffer.alloc(0);
  readonly maxFrameBytes: number;
  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  // Throws MuxError("bad-flag" | "frame-too-large") as soon as the offending header is complete, before any payload is buffered.
  push(chunk: Uint8Array): MuxFrame[] {
    this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk]);
    const frames: MuxFrame[] = [];
    while (this.#buf.length >= MUX_HEADER_BYTES) {
      const channel = this.#buf.readUInt32BE(0);
      const flag = FLAG_NAMES.get(this.#buf.readUInt8(4));
      const seq = this.#buf.readUInt32BE(5);
      const length = this.#buf.readUInt32BE(9);
      if (flag === undefined) {
        throw new MuxError(
          "bad-flag",
          `frame for channel ${channel} has flag byte ${this.#buf.readUInt8(4)}, which is not open, data, close or reset; the stream is out of sync, so the mux is closed: check that both ends run the same mux version and reconnect`,
          { channel },
        );
      }
      if (length > this.maxFrameBytes) {
        throw new MuxError(
          "frame-too-large",
          `frame for channel ${channel} declares ${length} payload bytes, above the ${this.maxFrameBytes}-byte maximum; the stream is out of sync, so the mux is closed: check that both ends use the same frame limit and reconnect`,
          { channel },
        );
      }
      if (this.#buf.length < MUX_HEADER_BYTES + length) break;
      frames.push({ channel, flag, seq, payload: Uint8Array.from(this.#buf.subarray(MUX_HEADER_BYTES, MUX_HEADER_BYTES + length)) });
      this.#buf = this.#buf.subarray(MUX_HEADER_BYTES + length);
    }
    return frames;
  }

  // What an input end would leave behind: leftover bytes, and the channel they belong to once its four id bytes arrived.
  pending(): { bytes: number; channel: number | null } {
    return { bytes: this.#buf.length, channel: this.#buf.length >= 4 ? this.#buf.readUInt32BE(0) : null };
  }
}

// The id that follows `id` in its parity range (odd for the initiator, even for the acceptor), wrapping past 2^32 - 1 and never 0.
export function advanceChannelId(id: number): number {
  return id + 2 > 0xffff_ffff ? id % 2 || 2 : id + 2;
}

// The asymmetric pair. Structurally a ByteChannel from @pomtree/core without its `closed`.
// `close()` must end the iterator returned by `output()` (after any buffered chunks): the mux relies on that to stop reading.
export interface MuxPair {
  write(data: Uint8Array): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  close(): void;
}

export interface MuxWaitOptions {
  signal?: AbortSignal;
  // Convenience for AbortSignal.timeout(timeoutMs).
  timeoutMs?: number;
}

export interface MuxOptions {
  role: "initiator" | "acceptor";
  maxFrameBytes?: number;
  // Per-connection cap on received-but-unread bytes; exceeding it resets that connection only.
  maxBufferedBytes?: number;
  maxConnections?: number;
  // Cap on bytes of replies the mux generates itself (resets, open acknowledgements) that are queued for a transport that has not
  // accepted them yet. Past it the mux dies, since only a peer that floods frames and never reads gets there. Data from write()
  // is not counted: each writer holds one frame at a time and waits for the transport (backpressure).
  maxOutboundBytes?: number;
  // Channel names this end accepts when the peer opens one; any other name is refused. Default: accept none.
  accept?: readonly string[];
  // Non-fatal protocol problems (unknown channel ids, sequence breaks, overflows), for the operator's log.
  onProtocolError?: (error: MuxError) => void;
}

export type MuxClose = { kind: "closed" } | { kind: "reset" | "error"; error: MuxError } | { kind: "transport-ended" | "mux-closed" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MuxConnection {
  readonly id: number;
  readonly name: string;
  readonly closed: Promise<MuxClose>;
  #resolveClosed!: (c: MuxClose) => void;
  #mux: Mux;
  #queue: Uint8Array[] = [];
  #queued = 0;
  #wake: (() => void) | undefined;
  #localClosed = false;
  #remoteClosed = false;
  #ended = false;
  #failure: MuxError | undefined;
  #done = false;
  #writeTail: Promise<void> = Promise.resolve();
  sendSeq = 0;
  recvSeq = 0;

  constructor(mux: Mux, id: number, name: string) {
    this.#mux = mux;
    this.id = id;
    this.name = name;
    this.closed = new Promise((r) => {
      this.#resolveClosed = r;
    });
  }

  // Resolves once the transport has accepted every frame of this write (so it waits on the pair's backpressure); rejects if the
  // connection or mux has failed or this end closed it.
  async write(data: Uint8Array | string): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#localClosed || this.#ended || this.#done) {
      throw this.#closedError();
    }
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const max = this.#mux.maxFrameBytes;
    // Writes on one connection run one at a time, and each frame is built only once the previous one was accepted, so a slow
    // transport holds one frame per writer in memory rather than the whole payload.
    const run = this.#writeTail.then(async () => {
      for (let at = 0; at < bytes.length; at += max) {
        if (this.#failure) throw this.#failure;
        if (this.#ended) throw this.#closedError();
        await this.#mux.sendFrame(this, "data", bytes.subarray(at, at + max));
      }
    });
    this.#writeTail = run.catch(() => {});
    await run;
  }

  #closedError(): MuxError {
    return new MuxError("closed", `channel "${this.name}" (${this.id}) is closed, so the write was refused; open a new channel before writing`, {
      channel: this.id,
    });
  }

  // Single consumer. Delivers everything received before an end or failure, then finishes (peer close, transport end) or throws.
  async *output(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        this.#queued -= next.length + MUX_HEADER_BYTES;
        yield next;
        continue;
      }
      if (this.#failure) throw this.#failure;
      if (this.#remoteClosed || this.#ended) return;
      await new Promise<void>((r) => {
        this.#wake = r;
      });
    }
  }

  // Graceful: tells the peer this end will write no more. Idempotent. The connection is gone once both ends have closed, and `closed`
  // resolves then, without waiting for the close frame to flush; a flush failure is not lost, it fails the mux (transport-failed).
  close(): void {
    if (this.#localClosed || this.#done || this.#ended) return;
    this.#localClosed = true;
    // Queued behind this connection's pending writes so the peer sees close after the data.
    this.#writeTail = this.#writeTail
      .then(() => (this.#failure || this.#ended ? undefined : this.#mux.sendFrame(this, "close", new Uint8Array(0))))
      .catch(() => {});
    this.#complete();
  }

  // Abort: tells the peer why and fails this end. Idempotent.
  reset(reason: string): void {
    if (this.#done) return;
    this.#mux.sendReset(this.id, this.sendSeq, reason);
    this.fail(new MuxError("closed", `channel "${this.name}" (${this.id}) was reset locally: ${reason}`, { channel: this.id }), "error");
  }

  // Mux-internal below.
  deliver(payload: Uint8Array): boolean {
    // Each frame costs its header too, so a flood of empty frames cannot grow the queue past the cap.
    const cost = payload.length + MUX_HEADER_BYTES;
    if (this.#queued + cost > this.#mux.maxBufferedBytes) return false;
    this.#queue.push(payload);
    this.#queued += cost;
    this.#signal();
    return true;
  }

  remoteClose(): void {
    this.#remoteClosed = true;
    this.#signal();
    this.#complete();
  }

  get remoteClosedFlag(): boolean {
    return this.#remoteClosed;
  }

  fail(error: MuxError, kind: "reset" | "error"): void {
    if (this.#done) return;
    this.#done = true;
    this.#failure = error;
    this.#mux.forget(this);
    this.#signal();
    this.#resolveClosed({ kind, error });
  }

  endWith(kind: "transport-ended" | "mux-closed"): void {
    if (this.#done) return;
    this.#done = true;
    this.#ended = true;
    this.#mux.forget(this);
    this.#signal();
    this.#resolveClosed({ kind });
  }

  #complete(): void {
    if (this.#done || !this.#localClosed || !this.#remoteClosed) return;
    this.#done = true;
    this.#mux.forget(this);
    this.#resolveClosed({ kind: "closed" });
  }

  #signal(): void {
    const w = this.#wake;
    this.#wake = undefined;
    w?.();
  }
}

interface PendingOpen {
  resolve(c: MuxConnection): void;
  reject(e: MuxError): void;
}

export class Mux {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly closed: Promise<{ error?: MuxError }>;
  #resolveClosed!: (c: { error?: MuxError }) => void;
  #pair: MuxPair;
  #opts: MuxOptions;
  #maxConnections: number;
  #maxOutbound: number;
  #outBytes = 0;
  #generatedBytes = 0;
  #conns = new Map<number, MuxConnection>();
  #pending = new Map<number, PendingOpen>();
  #gone = new Set<number>();
  #nextId: number;
  #out: Promise<void> = Promise.resolve();
  #dead: MuxError | undefined;
  #finished = false;
  #incoming: MuxConnection[] = [];
  #incomingWake: (() => void) | undefined;

  constructor(pair: MuxPair, opts: MuxOptions) {
    this.#pair = pair;
    this.#opts = opts;
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.#maxOutbound = opts.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES;
    this.#nextId = opts.role === "initiator" ? 1 : 2;
    this.closed = new Promise((r) => {
      this.#resolveClosed = r;
    });
    void this.#pump();
  }

  // Frame bytes queued for the transport and not yet accepted by it.
  get pendingOutboundBytes(): number {
    return this.#outBytes;
  }

  // Opens a named channel and waits for the peer's acknowledgement; abort or timeout gives up on it and resets the half-open channel.
  async open(name: string, opts: MuxWaitOptions = {}): Promise<MuxConnection> {
    if (this.#dead) throw this.#dead;
    const signal = waitSignal(opts);
    if (signal?.aborted) throw abortedError(`opening channel "${name}"`);
    if (this.#finished) throw new MuxError("closed", "the mux is closed, so the channel was not opened; create a new mux over a fresh pair");
    const nameBytes = encoder.encode(name);
    if (nameBytes.length === 0 || nameBytes.length > this.maxFrameBytes) {
      throw new MuxError(
        "protocol",
        `channel name must be 1 to ${this.maxFrameBytes} bytes, got ${nameBytes.length}; use a short fixed name such as "daemon-api"`,
      );
    }
    if (this.#conns.size >= this.#maxConnections) {
      throw new MuxError("limit", `the mux already carries ${this.#maxConnections} connections; close one before opening "${name}"`);
    }
    const id = this.#allocateId();
    const conn = new MuxConnection(this, id, name);
    this.#conns.set(id, conn);
    const ack = new Promise<MuxConnection>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.sendFrame(conn, "open", nameBytes).catch(() => {});
    if (!signal) return ack;
    return new Promise<MuxConnection>((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        this.sendReset(id, conn.sendSeq, "open aborted");
        const error = abortedError(`opening channel "${name}"`);
        conn.fail(error, "error");
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ack.then(
        (c) => {
          signal.removeEventListener("abort", onAbort);
          resolve(c);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  // Connections the peer opened and this end accepted, in arrival order. Ends when the mux ends; throws if it died.
  // `timeoutMs` is one deadline for the whole iterator, not per connection.
  async *incoming(opts: MuxWaitOptions = {}): AsyncGenerator<MuxConnection> {
    const signal = waitSignal(opts);
    for (;;) {
      const next = this.#incoming.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#dead) throw this.#dead;
      if (this.#finished) return;
      if (signal?.aborted) throw abortedError("waiting for the peer to open a channel");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.#incomingWake = undefined;
          reject(abortedError("waiting for the peer to open a channel"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#incomingWake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }
  }

  // Ends every connection locally and closes the pair. Idempotent.
  close(): void {
    if (this.#finished || this.#dead) return;
    this.#finish("mux-closed");
  }

  // Mux-internal below.
  // `generated` marks replies the mux makes on its own initiative (they count toward the outbound cap).
  sendFrame(conn: MuxConnection, flag: MuxFlag, payload: Uint8Array, generated = false): Promise<void> {
    const seq = conn.sendSeq;
    conn.sendSeq = (conn.sendSeq + 1) >>> 0;
    return this.#enqueue(MUX_HEADER_BYTES + payload.length, () => encodeFrame({ channel: conn.id, flag, seq, payload }, this.maxFrameBytes), generated);
  }

  sendReset(channel: number, seq: number, reason: string): void {
    const payload = encoder.encode(reason).subarray(0, this.maxFrameBytes);
    this.#enqueue(MUX_HEADER_BYTES + payload.length, () => encodeFrame({ channel, flag: "reset", seq, payload }, this.maxFrameBytes), true).catch(() => {});
  }

  forget(conn: MuxConnection): void {
    const queued = this.#incoming.indexOf(conn);
    if (queued >= 0) this.#incoming.splice(queued, 1);
    this.#conns.delete(conn.id);
    this.#gone.add(conn.id);
    if (this.#gone.size > 256) this.#gone.delete(this.#gone.values().next().value as number);
  }

  #allocateId(): number {
    for (let tries = 0; tries < 0x8000_0000; tries++) {
      const id = this.#nextId;
      this.#nextId = advanceChannelId(this.#nextId);
      if (id !== 0 && !this.#conns.has(id)) return id;
    }
    throw new MuxError("limit", "no free channel id is left; close connections or create a new mux");
  }

  #enqueue(size: number, build: () => Uint8Array, generated: boolean): Promise<void> {
    if (this.#dead) return Promise.reject(this.#dead);
    if (generated && this.#generatedBytes + size > this.#maxOutbound) {
      return Promise.reject(
        this.#die(
          new MuxError(
            "outbound-overflow",
            `more than ${this.#maxOutbound} bytes of replies (resets, acknowledgements) are queued for a transport that is not accepting writes, as happens when a peer floods frames and never reads; the mux is closed: reconnect, and check the transport drains writes`,
          ),
        ),
      );
    }
    this.#outBytes += size;
    if (generated) this.#generatedBytes += size;
    const p = this.#out.then(async () => {
      try {
        if (this.#dead) throw this.#dead;
        await this.#pair.write(build());
      } finally {
        this.#outBytes -= size;
        if (generated) this.#generatedBytes -= size;
      }
    });
    this.#out = p.catch(() => {});
    return p.catch((e) => {
      throw (
        this.#dead ??
        this.#die(
          new MuxError("transport-failed", `writing to the transport failed (${describe(e)}); the mux is closed: reconnect and reopen the channels`, {
            cause: e,
          }),
        )
      );
    });
  }

  async #pump(): Promise<void> {
    const parser = new MuxFrameParser(this.maxFrameBytes);
    try {
      for await (const chunk of this.#pair.output()) {
        if (this.#dead || this.#finished) return;
        let frames: MuxFrame[];
        try {
          frames = parser.push(chunk);
        } catch (e) {
          this.#die(e as MuxError);
          return;
        }
        for (const f of frames) {
          this.#dispatch(f);
          if (this.#dead || this.#finished) return;
        }
      }
    } catch (e) {
      this.#die(
        new MuxError("transport-failed", `reading from the transport failed (${describe(e)}); the mux is closed: reconnect and reopen the channels`, {
          cause: e,
        }),
      );
      return;
    }
    if (this.#dead || this.#finished) return;
    this.#inputEnded(parser.pending());
  }

  #report(error: MuxError): void {
    this.#opts.onProtocolError?.(error);
  }

  #dispatch(f: MuxFrame): void {
    const conn = this.#conns.get(f.channel);
    if (!conn) {
      this.#dispatchUnknown(f);
      return;
    }
    if (f.flag === "reset") {
      const reason = decoder.decode(f.payload);
      const error = new MuxError(
        "reset-by-peer",
        `the peer reset channel "${conn.name}" (${conn.id})${reason ? `: ${reason}` : ""}; retry the operation on a new channel`,
        { channel: conn.id },
      );
      const pending = this.#pending.get(conn.id);
      if (pending) {
        this.#pending.delete(conn.id);
        pending.reject(
          new MuxError(
            "open-refused",
            `the peer refused channel "${conn.name}"${reason ? `: ${reason}` : ""}; check the channel name is one the peer accepts`,
            { channel: conn.id },
          ),
        );
      }
      conn.fail(error, "reset");
      return;
    }
    if (f.seq !== conn.recvSeq) {
      this.#sequenceBreak(conn, f.seq);
      return;
    }
    conn.recvSeq = (conn.recvSeq + 1) >>> 0;
    const pending = this.#pending.get(conn.id);
    if (pending) {
      if (f.flag !== "open") {
        this.#protocolBreak(conn, `expected the open acknowledgement but got a ${f.flag} frame`);
        return;
      }
      this.#pending.delete(conn.id);
      pending.resolve(conn);
      return;
    }
    if (f.flag === "open" || conn.remoteClosedFlag) {
      this.#protocolBreak(conn, f.flag === "open" ? "got a second open frame" : `got a ${f.flag} frame after the peer closed`);
      return;
    }
    if (f.flag === "close") {
      conn.remoteClose();
      return;
    }
    if (!conn.deliver(f.payload)) {
      const error = new MuxError(
        "buffer-overflow",
        `channel "${conn.name}" (${conn.id}) has more than ${this.maxBufferedBytes} unread bytes buffered; read output() faster or raise maxBufferedBytes`,
        { channel: conn.id },
      );
      this.#report(error);
      this.sendReset(conn.id, conn.sendSeq, "receiver buffer overflow");
      conn.fail(error, "error");
    }
  }

  #dispatchUnknown(f: MuxFrame): void {
    const peerParity = this.#opts.role === "initiator" ? 0 : 1;
    // A closed id is dropped silently, except that the peer may legitimately reuse one of its own ids for a new open; an open on
    // one of our ids is only ever a late acknowledgement (e.g. for an aborted open()).
    const ownId = f.channel % 2 !== peerParity;
    if (f.flag === "reset" || (this.#gone.has(f.channel) && (f.flag !== "open" || ownId))) return;
    if (f.flag === "open" && f.channel !== 0 && f.channel % 2 === peerParity && f.seq === 0) {
      this.#acceptOpen(f);
      return;
    }
    this.#report(
      new MuxError(
        "unknown-channel",
        `a ${f.flag} frame arrived for channel ${f.channel}, which is not open on this mux; the frame was dropped and the peer reset: check the peer only writes to channels it opened or was acknowledged`,
        {
          channel: f.channel,
        },
      ),
    );
    this.sendReset(f.channel, 0, "unknown channel");
  }

  #acceptOpen(f: MuxFrame): void {
    const name = decoder.decode(f.payload);
    const refuse = (why: string) => {
      this.#report(new MuxError("open-refused", `refused open of channel "${name}" (${f.channel}): ${why}`, { channel: f.channel }));
      this.sendReset(f.channel, 0, why);
    };
    if (!this.#opts.accept?.includes(name)) {
      refuse(`channel name "${name}" is not accepted here`);
      return;
    }
    if (this.#conns.size >= this.#maxConnections) {
      refuse(`connection limit of ${this.#maxConnections} reached`);
      return;
    }
    const conn = new MuxConnection(this, f.channel, name);
    conn.recvSeq = 1;
    this.#conns.set(f.channel, conn);
    this.sendFrame(conn, "open", new Uint8Array(0), true).catch(() => {});
    if (this.#dead) return; // the acknowledgement overflowed the outbound cap; never hand out a dead connection
    this.#incoming.push(conn);
    this.#wakeIncoming();
  }

  #sequenceBreak(conn: MuxConnection, got: number): void {
    const error = new MuxError(
      "sequence",
      `channel "${conn.name}" (${conn.id}) received frame ${got} where ${conn.recvSeq} was expected, so a write was lost, duplicated or reordered; the channel was reset: reopen it and retry`,
      { channel: conn.id },
    );
    this.#report(error);
    this.#failConn(conn, error, "sequence break");
  }

  #protocolBreak(conn: MuxConnection, what: string): void {
    const error = new MuxError("protocol", `channel "${conn.name}" (${conn.id}): ${what}; the channel was reset: reopen it`, { channel: conn.id });
    this.#report(error);
    this.#failConn(conn, error, what);
  }

  #failConn(conn: MuxConnection, error: MuxError, reason: string): void {
    const pending = this.#pending.get(conn.id);
    if (pending) {
      this.#pending.delete(conn.id);
      pending.reject(error);
    }
    this.sendReset(conn.id, conn.sendSeq, reason);
    conn.fail(error, "error");
  }

  #inputEnded(left: { bytes: number; channel: number | null }): void {
    if (left.bytes > 0) {
      const conn = left.channel === null ? undefined : this.#conns.get(left.channel);
      const message = (who: string) =>
        `the transport ended in the middle of a frame (${left.bytes} bytes of it arrived)${who}; the data of that frame is lost: reopen the channel and resend`;
      if (left.channel === null) {
        this.#die(new MuxError("truncated-frame", message(" before its channel id"), {}));
        return;
      }
      const error = new MuxError("truncated-frame", message(` on channel ${left.channel}`), { channel: left.channel });
      this.#report(error);
      if (conn) {
        const pending = this.#pending.get(conn.id);
        if (pending) {
          this.#pending.delete(conn.id);
          pending.reject(error);
        }
        conn.fail(error, "error");
      }
    }
    this.#finish("transport-ended");
  }

  // Ends every remaining connection without error and resolves `closed`; used for a clean input end and for close().
  #finish(kind: "transport-ended" | "mux-closed"): void {
    this.#finished = true;
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(
        new MuxError("transport-ended", `the transport ended before the peer acknowledged channel ${id}; reconnect and reopen it`, { channel: id }),
      );
    }
    for (const conn of [...this.#conns.values()]) conn.endWith(kind);
    this.#wakeIncoming();
    this.#pair.close();
    this.#resolveClosed({});
  }

  // The whole mux fails: every connection, pending open and the incoming iterator get this same error.
  #die(error: MuxError): MuxError {
    if (this.#dead) return this.#dead;
    // After a clean end or close() the mux is already settled; a late write failure only fails that write.
    if (this.#finished) return error;
    this.#dead = error;
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(error);
    }
    for (const conn of [...this.#conns.values()]) conn.fail(error, "error");
    this.#wakeIncoming();
    try {
      this.#pair.close();
    } catch {
      // The pair is already failing; the error above is the one that matters.
    }
    this.#resolveClosed({ error });
    return error;
  }

  #wakeIncoming(): void {
    const w = this.#incomingWake;
    this.#incomingWake = undefined;
    w?.();
  }
}

export function createMux(pair: MuxPair, opts: MuxOptions): Mux {
  return new Mux(pair, opts);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function waitSignal(opts: MuxWaitOptions): AbortSignal | undefined {
  const signals = [opts.signal, opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs)].filter((x): x is AbortSignal => !!x);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

function abortedError(what: string): MuxError {
  return new MuxError("aborted", `${what} was aborted or timed out before the peer answered; check that the peer end is running and attached, then retry`);
}
