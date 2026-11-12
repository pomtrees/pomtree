// Hand-rolled RFC 6455 client WebSocket for providers that need a per-call CA and client certificate (Node's global
// WebSocket takes neither). The handshake rides on the kit's `request` with `upgrade: true`, so the User-Agent stamp and
// per-call TLS material apply exactly as for plain calls; this module only adds the frame codec and the connection state.
//
// Scope: no extensions (permessage-deflate), text and binary messages, fragmentation, ping/pong, the close handshake,
// frame and message size limits, and receive backpressure. A connection that drops without a close frame is an error to
// the reader, never a clean end of stream.

import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { redact } from "./redact.ts";
import type { RequestFn, TlsOptions } from "./request.ts";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
// Messages queued for a slow reader before the socket is paused.
const HIGH_WATER_MESSAGES = 64;

export const Opcode = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export const acceptKey = (key: string): string =>
  createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

// ---- frame encoder (client to server, always masked) ----

export function encodeClientFrame(opcode: number, payload: Uint8Array, mask: Uint8Array, fin = true): Buffer {
  if (mask.length !== 4) throw new RangeError("a websocket mask is exactly 4 bytes");
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(6) : n <= 0xffff ? Buffer.alloc(8) : Buffer.alloc(14);
  head[0] = (fin ? 0x80 : 0) | opcode;
  let off: number;
  if (n < 126) {
    head[1] = 0x80 | n;
    off = 2;
  } else if (n <= 0xffff) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
    off = 4;
  } else {
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
    off = 10;
  }
  head.set(mask, off);
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, body]);
}

// ---- frame decoder (server to client, never masked) ----

export type WsEvent =
  | { type: "text"; text: string }
  | { type: "binary"; data: Buffer }
  | { type: "ping"; data: Buffer }
  | { type: "pong"; data: Buffer }
  | { type: "close"; code: number | null; reason: string }
  | { type: "error"; code: 1002 | 1007 | 1009; reason: string };

const validCloseCode = (c: number): boolean => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeUtf8(b: Uint8Array): string | null {
  try {
    return utf8.decode(b);
  } catch {
    return null;
  }
}

interface Pending {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  filled: number;
}

// Incremental decoder. After an "error" event it is dead and ignores input; the caller sends a close with that code.
// `maxFrame` is checked from the header, before any payload is buffered; `maxMessage` bounds a reassembled message.
export class ServerFrameDecoder {
  readonly maxFrame: number;
  readonly maxMessage: number;
  #head: Buffer = Buffer.alloc(0);
  #cur: Pending | null = null;
  #frag: { binary: boolean; parts: Buffer[]; size: number } | null = null;
  #dead = false;

  constructor(opts: { maxFrame?: number; maxMessage?: number } = {}) {
    this.maxFrame = opts.maxFrame ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxMessage = opts.maxMessage ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  get dead(): boolean {
    return this.#dead;
  }

  push(bytes: Uint8Array): WsEvent[] {
    const events: WsEvent[] = [];
    if (this.#dead) return events;
    let chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    while ((chunk.length > 0 || this.#cur !== null) && !this.#dead) {
      if (this.#cur === null) {
        const all = this.#head.length ? Buffer.concat([this.#head, chunk]) : chunk;
        const used = this.#parseHeader(all, events);
        if (used < 0) {
          this.#head = Buffer.from(all);
          return events;
        }
        this.#head = Buffer.alloc(0);
        chunk = all.subarray(used);
        if (this.#dead) break;
      }
      const cur = this.#cur;
      if (cur) {
        const take = Math.min(cur.payload.length - cur.filled, chunk.length);
        chunk.copy(cur.payload, cur.filled, 0, take);
        cur.filled += take;
        chunk = chunk.subarray(take);
        if (cur.filled < cur.payload.length) break;
        this.#cur = null;
        this.#complete(cur, events);
      }
    }
    return events;
  }

  #fail(events: WsEvent[], code: 1002 | 1007 | 1009, reason: string): number {
    this.#dead = true;
    this.#cur = null;
    this.#frag = null;
    events.push({ type: "error", code, reason });
    return 0;
  }

  // Returns bytes consumed, or -1 when more header bytes are needed.
  #parseHeader(b: Buffer, events: WsEvent[]): number {
    if (b.length < 2) return -1;
    const b0 = b[0]!;
    const b1 = b[1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if ((b0 & 0x70) !== 0) return this.#fail(events, 1002, "server frame has reserved bits set (an extension was not negotiated)");
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return this.#fail(events, 1002, `server frame has the unknown opcode ${opcode}`);
    if ((b1 & 0x80) !== 0) return this.#fail(events, 1002, "server frame is masked, which RFC 6455 forbids");
    const l7 = b1 & 0x7f;
    const isControl = opcode >= 8;
    if (isControl && (!fin || l7 > 125)) return this.#fail(events, 1002, "server sent a fragmented or oversized control frame");
    let off = 2;
    let len: number;
    if (l7 < 126) len = l7;
    else if (l7 === 126) {
      if (b.length < 4) return -1;
      len = b.readUInt16BE(2);
      off = 4;
      if (len < 126) return this.#fail(events, 1002, "server frame uses a non-minimal length");
    } else {
      if (b.length < 10) return -1;
      const big = b.readBigUInt64BE(2);
      off = 10;
      if (big >> 63n) return this.#fail(events, 1002, "server frame length has its high bit set");
      if (big <= 0xffffn) return this.#fail(events, 1002, "server frame uses a non-minimal length");
      if (big > BigInt(this.maxFrame)) return this.#fail(events, 1009, `server frame of ${big} bytes exceeds the ${this.maxFrame}-byte frame limit`);
      len = Number(big);
    }
    if (len > this.maxFrame) return this.#fail(events, 1009, `server frame of ${len} bytes exceeds the ${this.maxFrame}-byte frame limit`);
    if (!isControl) {
      if (opcode === 0 && !this.#frag) return this.#fail(events, 1002, "server sent a continuation frame with nothing to continue");
      if (opcode !== 0 && this.#frag) return this.#fail(events, 1002, "server started a new message inside a fragmented one");
      if (this.#frag && this.#frag.size + len > this.maxMessage) {
        return this.#fail(events, 1009, `server message exceeds the ${this.maxMessage}-byte message limit`);
      }
      if (!this.#frag && len > this.maxMessage) return this.#fail(events, 1009, `server message exceeds the ${this.maxMessage}-byte message limit`);
    }
    this.#cur = { fin, opcode, payload: Buffer.alloc(len), filled: 0 };
    return off;
  }

  #complete(f: Pending, events: WsEvent[]): void {
    const p = f.payload;
    switch (f.opcode) {
      case Opcode.ping:
        events.push({ type: "ping", data: p });
        return;
      case Opcode.pong:
        events.push({ type: "pong", data: p });
        return;
      case Opcode.close: {
        if (p.length === 0) {
          events.push({ type: "close", code: null, reason: "" });
          return;
        }
        if (p.length === 1) {
          this.#fail(events, 1002, "server close frame has a 1-byte body");
          return;
        }
        const code = p.readUInt16BE(0);
        if (!validCloseCode(code)) {
          this.#fail(events, 1002, `server close frame has the invalid code ${code}`);
          return;
        }
        const reason = decodeUtf8(p.subarray(2));
        if (reason === null) {
          this.#fail(events, 1007, "server close reason is not UTF-8");
          return;
        }
        events.push({ type: "close", code, reason });
        return;
      }
    }
    if (f.opcode !== Opcode.continuation) this.#frag = { binary: f.opcode === Opcode.binary, parts: [], size: 0 };
    const frag = this.#frag!;
    frag.parts.push(p);
    frag.size += p.length;
    if (!f.fin) return;
    this.#frag = null;
    const data = frag.parts.length === 1 ? frag.parts[0]! : Buffer.concat(frag.parts);
    if (frag.binary) {
      events.push({ type: "binary", data });
      return;
    }
    const text = decodeUtf8(data);
    if (text === null) {
      this.#fail(events, 1007, "server text message is not valid UTF-8");
      return;
    }
    events.push({ type: "text", text });
  }
}

// ---- connection ----

export type WsMessage = { type: "text"; text: string } | { type: "binary"; data: Uint8Array };

export interface WsClose {
  code: number;
  reason: string;
  // True when both sides completed the close handshake; false when the connection dropped or the protocol failed.
  clean: boolean;
}

export class WsError extends Error {
  // Set when the failure came from a received frame (the close code the client answered with), or the handshake HTTP status.
  code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "WsError";
    this.code = code;
  }
}

export interface WsClientOptions {
  // The kit's request function (`createRequest(...)`), which stamps the User-Agent and carries the per-call TLS material.
  request: RequestFn;
  headers?: Record<string, string>;
  protocols?: string[];
  tls?: TlsOptions;
  signal?: AbortSignal;
  maxFrameBytes?: number;
  maxMessageBytes?: number;
  handshakeTimeoutMs?: number;
  closeTimeoutMs?: number;
  // Tests inject randomness for the handshake key and frame masks.
  randomBytes?: (n: number) => Uint8Array;
}

export interface WsClient extends AsyncIterable<WsMessage> {
  readonly protocol: string;
  send(data: string | Uint8Array): Promise<void>;
  ping(data?: Uint8Array): Promise<void>;
  // Sends a close frame and waits for the server's, or destroys the socket after closeTimeoutMs.
  close(code?: number, reason?: string): Promise<WsClose>;
  // Settles when the connection has ended for any reason; it never rejects.
  readonly closed: Promise<WsClose>;
}

const toHttp = (url: string): string => {
  const u = new URL(url);
  if (u.protocol === "wss:") u.protocol = "https:";
  else if (u.protocol === "ws:") u.protocol = "http:";
  else throw new WsError(`websocket URL uses the unsupported scheme ${u.protocol}; use a ws: or wss: URL`);
  return u.toString();
};

const bodySnippet = (body: Uint8Array): string =>
  redact(Buffer.from(body.subarray(0, 200)).toString("utf8"))
    .replace(/\s+/g, " ")
    .trim();

export async function connectWebSocket(url: string, opts: WsClientOptions): Promise<WsClient> {
  const rand = opts.randomBytes ?? ((n: number) => randomBytes(n));
  const key = Buffer.from(rand(16)).toString("base64");
  const headers: Record<string, string> = {
    ...opts.headers,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
  };
  if (opts.protocols?.length) headers["Sec-WebSocket-Protocol"] = opts.protocols.join(", ");
  const httpUrl = toHttp(url);
  const res = await opts.request(httpUrl, {
    method: "GET",
    headers,
    upgrade: true,
    timeoutMs: opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ...(opts.tls === undefined ? {} : { tls: opts.tls }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  const refuse = (message: string, code?: number): never => {
    res.socket?.destroy();
    throw new WsError(message, code);
  };
  if (res.status !== 101 || res.socket === undefined) {
    const hint = res.status === 401 || res.status === 403 ? "check the credential and its permissions" : "check that the URL is a websocket endpoint";
    return refuse(
      `websocket handshake with ${new URL(url).host} was refused with HTTP ${res.status}${res.body.length ? ` (${bodySnippet(res.body)})` : ""}; ${hint}`,
      res.status,
    );
  }
  if (res.headers["sec-websocket-accept"] !== acceptKey(key)) {
    return refuse(
      `websocket handshake with ${new URL(url).host} returned a wrong Sec-WebSocket-Accept, so the peer is not a conforming websocket server (or a proxy altered the exchange); check the endpoint address and any intermediary`,
    );
  }
  const tokens = (v: string | undefined) =>
    (v ?? "")
      .toLowerCase()
      .split(",")
      .map((t) => t.trim());
  if (!tokens(res.headers.upgrade).includes("websocket") || !tokens(res.headers.connection).includes("upgrade")) {
    return refuse(
      `websocket handshake with ${new URL(url).host} did not answer Upgrade: websocket with Connection: Upgrade; check that the URL is a websocket endpoint`,
    );
  }
  if (res.headers["sec-websocket-extensions"] !== undefined) {
    return refuse(
      `websocket server enabled the extension "${redact(res.headers["sec-websocket-extensions"])}", which this client did not request and cannot decode; check the server or proxy configuration`,
    );
  }
  const protocol = res.headers["sec-websocket-protocol"] ?? "";
  if (protocol !== "" && !(opts.protocols ?? []).includes(protocol)) {
    return refuse(`websocket server chose the subprotocol "${redact(protocol)}", which this client did not offer; check the server configuration`);
  }
  return new Connection(res.socket, res.head, protocol, opts, rand);
}

class Connection implements WsClient {
  readonly protocol: string;
  readonly closed: Promise<WsClose>;
  #socket: Duplex;
  #rand: (n: number) => Uint8Array;
  #decoder: ServerFrameDecoder;
  #queue: WsMessage[] = [];
  #waiters: { resolve: (r: IteratorResult<WsMessage>) => void; reject: (e: unknown) => void }[] = [];
  #failure: WsError | null = null;
  #ended = false;
  #sentClose = false;
  #paused = false;
  #resolveClosed!: (c: WsClose) => void;
  #closeTimeoutMs: number;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingClose: WsClose | null = null;

  constructor(socket: Duplex, head: Uint8Array | undefined, protocol: string, opts: WsClientOptions, rand: (n: number) => Uint8Array) {
    this.protocol = protocol;
    this.#socket = socket;
    this.#rand = rand;
    this.#closeTimeoutMs = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#decoder = new ServerFrameDecoder({
      maxFrame: opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      maxMessage: opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    });
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (e) =>
      this.#finish({ code: 1006, reason: "", clean: false }, `websocket connection failed: ${redact(e.message)}; check network reachability and retry`),
    );
    // A peer that half-closes without a close frame is a drop, not a clean end.
    socket.on("end", () => {
      if (!this.#pendingClose) {
        this.#finish(
          { code: 1006, reason: "", clean: false },
          "websocket connection ended without a close frame, so the data may be incomplete; reconnect and repeat the operation",
        );
      }
    });
    socket.on("close", () =>
      this.#finish(
        this.#pendingClose ?? { code: 1006, reason: "", clean: false },
        this.#pendingClose ? null : "websocket connection dropped without a close frame, so the data may be incomplete; reconnect and repeat the operation",
      ),
    );
    opts.signal?.addEventListener("abort", () => this.#finish({ code: 1006, reason: "aborted", clean: false }, "websocket connection aborted by the caller"), {
      once: true,
    });
    if (head && head.length > 0) queueMicrotask(() => this.#onData(Buffer.from(head)));
  }

  #onData(chunk: Buffer): void {
    // Nothing after the peer's close frame is part of the conversation.
    if (this.#ended || this.#pendingClose) return;
    for (const ev of this.#decoder.push(chunk)) {
      switch (ev.type) {
        case "text":
          this.#deliver({ type: "text", text: ev.text });
          break;
        case "binary":
          this.#deliver({ type: "binary", data: ev.data });
          break;
        case "ping":
          if (!this.#sentClose) void this.#write(encodeClientFrame(Opcode.pong, ev.data, this.#rand(4)));
          break;
        case "pong":
          break;
        case "close": {
          const code = ev.code ?? 1005;
          const initiated = this.#sentClose;
          if (!this.#sentClose) {
            this.#sentClose = true;
            void this.#write(encodeClientFrame(Opcode.close, closeBody(ev.code ?? undefined, ""), this.#rand(4)));
          }
          this.#pendingClose = { code, reason: ev.reason, clean: true };
          if (initiated) {
            // Both close frames have crossed: the handshake is complete whether or not the peer ever closes its TCP side.
            this.#finish(this.#pendingClose, null);
            return;
          }
          // We only echoed: a peer that never closes its TCP side must not keep the process alive.
          if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
          this.#closeTimer = setTimeout(() => this.#finish(this.#pendingClose ?? { code, reason: ev.reason, clean: true }, null), this.#closeTimeoutMs);
          this.#socket.end();
          return;
        }
        case "error": {
          this.#sentClose = true;
          const err = new WsError(`websocket protocol error: ${ev.reason}; the connection was closed, check the server or raise the size limits`, ev.code);
          void this.#write(encodeClientFrame(Opcode.close, closeBody(ev.code, ev.reason.slice(0, 100)), this.#rand(4))).then(() =>
            this.#finish({ code: ev.code, reason: ev.reason, clean: false }, err.message, err.code),
          );
          return;
        }
      }
    }
  }

  #deliver(m: WsMessage): void {
    const w = this.#waiters.shift();
    if (w) {
      w.resolve({ value: m, done: false });
      return;
    }
    this.#queue.push(m);
    if (this.#queue.length >= HIGH_WATER_MESSAGES && !this.#paused) {
      this.#paused = true;
      this.#socket.pause();
    }
  }

  #write(frame: Buffer): Promise<void> {
    return new Promise((resolve) => {
      if (this.#socket.destroyed || !this.#socket.writable) return resolve();
      this.#socket.write(frame, () => resolve());
    });
  }

  #finish(close: WsClose, failure: string | null, code?: number): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#closeTimer !== undefined) clearTimeout(this.#closeTimer);
    this.#decoder = new ServerFrameDecoder();
    if (failure !== null && !close.clean) this.#failure = new WsError(failure, code);
    this.#socket.destroy();
    this.#resolveClosed(close);
    for (const w of this.#waiters.splice(0)) {
      if (this.#failure && this.#queue.length === 0) w.reject(this.#failure);
      else w.resolve({ value: undefined, done: true });
    }
  }

  async send(data: string | Uint8Array): Promise<void> {
    if (this.#ended || this.#sentClose) throw new WsError("cannot send on a closed websocket; reconnect first");
    const isText = typeof data === "string";
    const payload = isText ? Buffer.from(data, "utf8") : data;
    await this.#write(encodeClientFrame(isText ? Opcode.text : Opcode.binary, payload, this.#rand(4)));
  }

  async ping(data: Uint8Array = new Uint8Array(0)): Promise<void> {
    if (data.length > 125) throw new RangeError("a ping payload is at most 125 bytes; send less");
    if (this.#ended || this.#sentClose) throw new WsError("cannot ping a closed websocket; reconnect first");
    await this.#write(encodeClientFrame(Opcode.ping, data, this.#rand(4)));
  }

  async close(code = 1000, reason = ""): Promise<WsClose> {
    if (!validCloseCode(code)) {
      throw new RangeError(
        `close code ${code} cannot be sent (1004, 1005, 1006, 1015 and values outside 1000-4999 are reserved); use 1000 for a normal close or 3000-4999 for an application code`,
      );
    }
    if (!this.#ended && !this.#sentClose) {
      this.#sentClose = true;
      this.#closeTimer = setTimeout(() => this.#finish({ code: 1006, reason: "close timeout", clean: false }, null), this.#closeTimeoutMs);
      await this.#write(encodeClientFrame(Opcode.close, closeBody(code, reason), this.#rand(4)));
    }
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<WsMessage> {
    return {
      next: () => {
        const m = this.#queue.shift();
        if (m) {
          if (this.#paused && this.#queue.length < HIGH_WATER_MESSAGES / 2) {
            this.#paused = false;
            this.#socket.resume();
          }
          return Promise.resolve({ value: m, done: false });
        }
        if (this.#ended) return this.#failure ? Promise.reject(this.#failure) : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: async () => {
        await this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

function closeBody(code: number | undefined, reason: string): Buffer {
  if (code === undefined) return Buffer.alloc(0);
  let r = Buffer.from(reason, "utf8");
  if (r.length > 123) {
    let end = 123;
    while (end > 0 && (r[end]! & 0xc0) === 0x80) end--;
    r = r.subarray(0, end);
  }
  const body = Buffer.alloc(2 + r.length);
  body.writeUInt16BE(code, 0);
  r.copy(body, 2);
  return body;
}
