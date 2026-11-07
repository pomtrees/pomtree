// RFC 6455 WebSocket server-side protocol, pure: Buffers in, Buffers out, no
// net/http coupling. A thin shell owns the socket: it feeds socket data to
// `WsConnection.receive`, writes every returned `out` frame, and ends the
// socket when `end` is true.
//
// Backpressure is the shell's job: this module never buffers outbound data.
// The shell should check `socket.write()`'s return / `writableLength`, pause
// the producer (and drop or close slow viewers) rather than queue unboundedly;
// and may `socket.pause()` while the downstream sink is saturated.
//
// Scope: no extensions (permessage-deflate), no subprotocol negotiation
// beyond echoing a chosen one. The upgrade route is wired in terminal-route.ts and server.ts.
//
// Client mode (role "client", used by cdp-relay.ts to talk to a server we dial): outgoing frames are
// masked with a fresh random key, incoming frames must be unmasked, and the handshake is built and
// verified by clientHandshakeRequest / parseHandshakeResponse. Server behaviour is the default.

import { createHash, randomBytes } from "node:crypto";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const DEFAULT_MAX_MESSAGE = 1024 * 1024;
/** Most frames one fragmented message may span. The byte cap alone cannot bound empty continuation frames, each of which still costs a retained part. */
export const MAX_FRAGMENTS = 1024;

export const Opcode = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export const CloseCode = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  invalidPayload: 1007,
  policy: 1008,
  tooBig: 1009,
  internalError: 1011,
} as const;

// ---- handshake ----

export type HeaderBag = Record<string, string | string[] | undefined>;

export type UpgradeCheck = { ok: true; key: string } | { ok: false; status: 400 | 405 | 426; reason: string };

function header(h: HeaderBag, name: string): string | undefined {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v.join(",") : v;
}

const tokens = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** Validate a client upgrade request. `headers` are node-style (lowercase) names. */
export function checkUpgrade(headers: HeaderBag, method = "GET"): UpgradeCheck {
  if (method !== "GET") return { ok: false, status: 405, reason: "method must be GET" };
  if (!tokens(header(headers, "upgrade")).includes("websocket")) {
    return { ok: false, status: 400, reason: "Upgrade: websocket required" };
  }
  if (!tokens(header(headers, "connection")).includes("upgrade")) {
    return { ok: false, status: 400, reason: "Connection: Upgrade required" };
  }
  if (header(headers, "sec-websocket-version")?.trim() !== "13") {
    return { ok: false, status: 426, reason: "Sec-WebSocket-Version: 13 required" };
  }
  const key = header(headers, "sec-websocket-key")?.trim();
  if (!key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16) {
    return { ok: false, status: 400, reason: "Sec-WebSocket-Key must be 16 bytes base64" };
  }
  return { ok: true, key };
}

export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

/** The full 101 response head (ends with a blank line). `protocol` must be one the client offered. */
export function handshakeResponse(key: string, protocol?: string): string {
  const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

/**
 * Origin check predicate. A missing Origin is rejected (browsers always send
 * one; a non-browser client has no business on a shell-equivalent endpoint
 * unless the caller authenticates it and handles that case itself). The
 * policy (which origins) is the caller's `allowed` matcher.
 */
export function originAllowed(origin: string | string[] | undefined, allowed: (origin: string) => boolean): boolean {
  if (typeof origin !== "string" || origin === "" || origin === "null") return false;
  return allowed(origin);
}

// ---- encoder (server -> client, unmasked; client -> server when a mask key is given) ----

/** `mask` (4 bytes) makes this a client frame: the mask bit is set and the payload XORed with the key. */
export function encodeFrame(opcode: number, payload: Uint8Array = new Uint8Array(0), fin = true, mask?: Uint8Array): Buffer {
  if (mask && mask.length !== 4) throw new RangeError("mask key must be 4 bytes");
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  const m = mask ? 0x80 : 0;
  if (n < 126) head[1] = m | n;
  else if (n <= 0xffff) {
    head[1] = m | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = m | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  if (!mask) return Buffer.concat([head, payload]);
  const body = Buffer.from(payload); // copy: never mutate the caller's bytes
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}

/** A client frame with a fresh random mask key (RFC 6455 section 5.3). */
export const encodeMasked = (opcode: number, payload: Uint8Array = new Uint8Array(0), fin = true): Buffer => encodeFrame(opcode, payload, fin, randomBytes(4));

export const encodeText = (s: string): Buffer => encodeFrame(Opcode.text, Buffer.from(s, "utf8"));
export const encodeBinary = (b: Uint8Array): Buffer => encodeFrame(Opcode.binary, b);

function control(opcode: number, payload: Uint8Array, masked = false): Buffer {
  if (payload.length > 125) throw new RangeError("control frame payload exceeds 125 bytes");
  return masked ? encodeMasked(opcode, payload) : encodeFrame(opcode, payload);
}
export const encodePing = (p: Uint8Array = new Uint8Array(0)): Buffer => control(Opcode.ping, p);
export const encodePong = (p: Uint8Array = new Uint8Array(0)): Buffer => control(Opcode.pong, p);

/** Close frame; reason is truncated at a char boundary to fit 123 bytes. No code -> empty body. */
export function encodeClose(code?: number, reason = "", masked = false): Buffer {
  if (code === undefined) return control(Opcode.close, new Uint8Array(0), masked);
  let r = Buffer.from(reason, "utf8");
  if (r.length > 123) {
    let end = 123;
    while (end > 0 && (r[end]! & 0xc0) === 0x80) end--;
    r = r.subarray(0, end);
  }
  const body = Buffer.alloc(2 + r.length);
  body.writeUInt16BE(code, 0);
  r.copy(body, 2);
  return control(Opcode.close, body, masked);
}

/** Client-side text message (masked). */
export const encodeClientText = (s: string): Buffer => encodeMasked(Opcode.text, Buffer.from(s, "utf8"));

// ---- client handshake ----

export const MAX_HANDSHAKE_HEAD = 8 * 1024;

/** The upgrade request a client sends. No Origin header is ever sent. */
export function clientHandshakeRequest(opts: { path: string; host: string; key?: string }): { request: string; key: string } {
  if (/[\r\n ]/.test(opts.path) || /[\r\n]/.test(opts.host)) throw new RangeError("handshake path/host must not contain whitespace or CR/LF");
  const key = opts.key ?? randomBytes(16).toString("base64");
  const request = [
    `GET ${opts.path} HTTP/1.1`,
    `Host: ${opts.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ].join("\r\n");
  return { request: request + "\r\n\r\n", key };
}

export type HandshakeReply = { state: "need-more" } | { state: "ok"; rest: Buffer } | { state: "bad"; reason: string };

/** Parse and verify a server's 101 reply to `clientHandshakeRequest`; `rest` is any websocket bytes that followed the head. */
export function parseHandshakeResponse(buf: Uint8Array, key: string): HandshakeReply {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  const end = b.indexOf("\r\n\r\n");
  if (end < 0) {
    return b.length > MAX_HANDSHAKE_HEAD ? { state: "bad", reason: "handshake response head too large" } : { state: "need-more" };
  }
  if (end > MAX_HANDSHAKE_HEAD) return { state: "bad", reason: "handshake response head too large" };
  const lines = b.subarray(0, end).toString("latin1").split("\r\n");
  if (!/^HTTP\/1\.1 101(?: |$)/.test(lines[0]!)) return { state: "bad", reason: `expected 101 Switching Protocols, got "${lines[0]!.slice(0, 80)}"` };
  const h: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  if (!tokens(h.upgrade).includes("websocket") || !tokens(h.connection).includes("upgrade"))
    return { state: "bad", reason: "response is not a websocket upgrade" };
  if (h["sec-websocket-accept"] !== acceptKey(key)) return { state: "bad", reason: "Sec-WebSocket-Accept does not match the key" };
  return { state: "ok", rest: Buffer.from(b.subarray(end + 4)) };
}

// ---- decoder (client -> server, masked) ----

export type WsEvent =
  | { type: "text"; text: string }
  | { type: "binary"; data: Buffer }
  | { type: "ping"; data: Buffer }
  | { type: "pong"; data: Buffer }
  | { type: "close"; code: number | null; reason: string }
  | { type: "error"; code: 1002 | 1007 | 1009; reason: string };

const validCloseCode = (c: number): boolean => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);

const utf8 = new TextDecoder("utf-8", { fatal: true });
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
  mask: Buffer | null;
  payload: Buffer;
  filled: number;
}

/**
 * Incremental frame decoder. `push` accepts arbitrary chunking and returns the
 * events completed by that chunk. After an "error" event the decoder is dead
 * and ignores further input; the caller sends a close with that code.
 * `maxMessage` bounds both a single frame and a reassembled fragmented message.
 */
export class FrameDecoder {
  readonly maxMessage: number;
  readonly #expectMasked: boolean;
  #head: Buffer = Buffer.alloc(0);
  #cur: Pending | null = null;
  #frag: { binary: boolean; parts: Buffer[]; size: number } | null = null;
  #dead = false;

  /** `role` is the side this decoder runs on: a "server" requires masked input (the default), a "client" requires unmasked. */
  constructor(opts: { maxMessage?: number; role?: "server" | "client" } = {}) {
    this.maxMessage = opts.maxMessage ?? DEFAULT_MAX_MESSAGE;
    this.#expectMasked = (opts.role ?? "server") === "server";
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
        // Header is at most 14 bytes, so concatenating while incomplete is cheap.
        const all = this.#head.length ? Buffer.concat([this.#head, chunk]) : chunk;
        const used = this.#parseHeader(all, events);
        if (used < 0) {
          this.#head = Buffer.from(all); // copy: caller may reuse its buffer
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

  #fail(events: WsEvent[], code: 1002 | 1007 | 1009, reason: string): void {
    this.#dead = true;
    this.#cur = null;
    this.#frag = null;
    events.push({ type: "error", code, reason });
  }

  /** Returns bytes consumed, or -1 when more header bytes are needed. A zero-length payload completes immediately. */
  #parseHeader(b: Buffer, events: WsEvent[]): number {
    if (b.length < 2) return -1;
    const b0 = b[0]!;
    const b1 = b[1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if ((b0 & 0x70) !== 0) return this.#failH(events, 1002, "reserved bits set");
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return this.#failH(events, 1002, `bad opcode ${opcode}`);
    const masked = (b1 & 0x80) !== 0;
    if (masked !== this.#expectMasked) return this.#failH(events, 1002, masked ? "server frame masked" : "client frame not masked");
    const l7 = b1 & 0x7f;
    const isControl = opcode >= 8;
    if (isControl && (!fin || l7 > 125)) return this.#failH(events, 1002, "bad control frame");
    let off = 2;
    let len: number;
    if (l7 < 126) len = l7;
    else if (l7 === 126) {
      if (b.length < 4) return -1;
      len = b.readUInt16BE(2);
      off = 4;
      if (len < 126) return this.#failH(events, 1002, "non-minimal length");
    } else {
      if (b.length < 10) return -1;
      const big = b.readBigUInt64BE(2);
      off = 10;
      if (big >> 63n) return this.#failH(events, 1002, "length high bit set");
      if (big <= 0xffffn) return this.#failH(events, 1002, "non-minimal length");
      if (big > BigInt(this.maxMessage)) return this.#failH(events, 1009, "message too big");
      len = Number(big);
    }
    if (len > this.maxMessage) return this.#failH(events, 1009, "message too big");
    if (!isControl) {
      if (opcode === 0 && !this.#frag) return this.#failH(events, 1002, "unexpected continuation");
      if (opcode !== 0 && this.#frag) return this.#failH(events, 1002, "expected continuation");
      if (this.#frag && this.#frag.size + len > this.maxMessage) {
        return this.#failH(events, 1009, "message too big");
      }
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (b.length < off + 4) return -1;
      mask = Buffer.from(b.subarray(off, off + 4));
      off += 4;
    }
    this.#cur = { fin, opcode, mask, payload: Buffer.alloc(len), filled: 0 };
    return off;
  }

  #failH(events: WsEvent[], code: 1002 | 1007 | 1009, reason: string): number {
    this.#fail(events, code, reason);
    return 0;
  }

  #complete(f: Pending, events: WsEvent[]): void {
    const p = f.payload;
    const mask = f.mask;
    if (mask) for (let i = 0; i < p.length; i++) p[i] = p[i]! ^ mask[i & 3]!;
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
          this.#fail(events, 1002, "close body of 1 byte");
          return;
        }
        const code = p.readUInt16BE(0);
        if (!validCloseCode(code)) {
          this.#fail(events, 1002, `bad close code ${code}`);
          return;
        }
        const reason = decodeUtf8(p.subarray(2));
        if (reason === null) {
          this.#fail(events, 1007, "close reason not UTF-8");
          return;
        }
        events.push({ type: "close", code, reason });
        return;
      }
    }
    // data frame: text, binary or continuation
    if (f.opcode !== Opcode.continuation) {
      this.#frag = { binary: f.opcode === Opcode.binary, parts: [], size: 0 };
    }
    const frag = this.#frag!;
    if (frag.parts.length >= MAX_FRAGMENTS) {
      this.#fail(events, 1009, "message has too many fragments");
      return;
    }
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
      this.#fail(events, 1007, "text not valid UTF-8");
      return;
    }
    events.push({ type: "text", text });
  }
}

// ---- connection state machine ----

export interface ReceiveResult {
  /** Application events: text, binary, pong, close (pings are answered internally). */
  events: WsEvent[];
  /** Encoded frames to write to the socket, in order. */
  out: Buffer[];
  /** True once the shell should end the socket after flushing `out`. */
  end: boolean;
}

/**
 * Server-side connection logic: decodes input, auto-answers pings, completes
 * the close handshake (echo the peer's close, or on protocol error send the
 * matching code), and refuses data after closing.
 */
export class WsConnection {
  readonly decoder: FrameDecoder;
  readonly #masked: boolean;
  #closeSent = false;
  #ended = false;

  /** `role: "client"` masks every outgoing frame and expects unmasked input; the default is the server side. */
  constructor(opts: { maxMessage?: number; role?: "server" | "client" } = {}) {
    this.decoder = new FrameDecoder(opts);
    this.#masked = opts.role === "client";
  }

  get closeSent(): boolean {
    return this.#closeSent;
  }
  get ended(): boolean {
    return this.#ended;
  }

  receive(bytes: Uint8Array): ReceiveResult {
    const res: ReceiveResult = { events: [], out: [], end: this.#ended };
    if (this.#ended) return res;
    for (const ev of this.decoder.push(bytes)) {
      if (this.#ended) break;
      switch (ev.type) {
        case "ping":
          if (!this.#closeSent) res.out.push(this.#masked ? control(Opcode.pong, ev.data, true) : encodePong(ev.data));
          break;
        case "close":
          if (!this.#closeSent) {
            res.out.push(encodeClose(ev.code ?? undefined, "", this.#masked));
            this.#closeSent = true;
          }
          this.#ended = true;
          res.events.push(ev);
          break;
        case "error":
          if (!this.#closeSent) {
            res.out.push(encodeClose(ev.code, ev.reason, this.#masked));
            this.#closeSent = true;
          }
          this.#ended = true;
          res.events.push(ev);
          break;
        default:
          if (!this.#closeSent) res.events.push(ev);
      }
    }
    res.end = this.#ended;
    return res;
  }

  /**
   * Begin a server-initiated close. Returns the frame to write (null if one was
   * already sent). The shell should then wait for the peer's close (a
   * `receive` with end=true) with its own timeout, and destroy the socket.
   */
  close(code: number = CloseCode.normal, reason = ""): Buffer | null {
    if (this.#closeSent) return null;
    this.#closeSent = true;
    return encodeClose(code, reason, this.#masked);
  }

  /** Mark the transport gone (socket closed/errored) so later input is ignored. */
  markEnded(): void {
    this.#ended = true;
  }
}
