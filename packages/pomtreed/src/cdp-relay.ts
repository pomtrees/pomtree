// Read-only screencast relay from an agent's headless Chromium, pure: every byte moves over an injected
// `open(): Promise<RelayStream>` (production: the sandbox loopback facet: loopback.open(id, 9222)), time over injected
// timers and clock. No sockets, no fs, no process.
//
// Trust model. Chromium's DevTools protocol (CDP) is shell-equivalent and everything it returns is
// agent-controlled, so this module is a one-way valve:
//   - OUT: the only CDP methods ever sent are ALLOWED_CDP_METHODS, and the only code that builds a CDP
//     command is buildCdpCommand, which throws on anything else. Session sends go through `send` below,
//     the single choke point; there is no other path from a caller or from Chromium data to the wire.
//   - IN: only `Page.screencastFrame` events and the reply to our own startScreencast id are read.
//     Everything else is dropped. A frame is validated (base64 length, decoded size, JPEG magic) before
//     any copy reaches the listener; the listener gets bytes and a small status object, never CDP JSON.
//   - Text from /json/list (url, title) is truncated and stripped of control characters; the target id
//     must match a strict pattern and the websocket path is built from it alone (the returned
//     webSocketDebuggerUrl is never used).

import type { WsEvent } from "./websocket.ts";
import { MAX_HANDSHAKE_HEAD, WsConnection, clientHandshakeRequest, encodeClientText, parseHandshakeResponse } from "./websocket.ts";

/** The CDP endpoint host header: the relay only ever talks to the container's own loopback Chromium. */
export const CDP_HOST = "127.0.0.1:9222";
/** The only CDP methods this module will ever send. Frozen; `buildCdpCommand` is the only reader. */
// TODO(browser-input-policy): the browser view is view-only, and a client data message closes the socket with 1008. Which input an operator may send (the Input.* set), whether the agent is paused or told, and the default per window are undecided, and a decision (SPEC.md and docs/safety-decisions.md) must come first because operator input lands in a page the agent reads. Trigger: operators must click into the page.
// TODO(browser-input-relay): no Input.* method is allowed, and only deviceWidth and deviceHeight are kept from the screencast frame metadata (offsetTop, pageScaleFactor and the scroll offsets, which click mapping may need on a scrolled or zoomed page, are dropped). Trigger: after browser-input-policy; add a separate write list behind the same choke point with validated numeric parameters and rate caps.
export const ALLOWED_CDP_METHODS: readonly string[] = Object.freeze(["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast"]);
export const SCREENCAST_DEFAULTS = Object.freeze({ format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });

export const MAX_LIST_RESPONSE = 256 * 1024;
export const MAX_CDP_MESSAGE = 4 * 1024 * 1024;
export const MAX_FRAME_BASE64 = Math.floor(2.8 * 1024 * 1024);
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT = 512;
export const MAX_DIMENSION = 16384;
const MAX_PENDING_ACKS = 16;
/** After a session is closed on purpose, the stream is dropped once its writes settle or after this long, whichever is first. */
export const CLOSE_GRACE_MS = 1000;
/** Unresolved stream writes tolerated per session (pongs, acks); above this the peer is not reading and the session ends. */
export const MAX_PENDING_WRITES = 64;
const TARGET_ID = /^[A-Za-z0-9]{1,64}$/;

export type RelayState = "connecting" | "live" | "no-browser";
export interface RelayStatus {
  state: RelayState;
  url?: string;
  title?: string;
  width?: number;
  height?: number;
}

/** Structural subset of core's ByteStream, so this module needs nothing but the shape. */
export interface RelayStream {
  write(data: Uint8Array): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  close(): void;
  closed: Promise<unknown>;
}

export interface RelayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RelayListener {
  /** One validated, complete JPEG. */
  frame(jpeg: Uint8Array): void;
  /** Called on every change of the status object (and once at start). */
  status(status: RelayStatus): void;
}

export interface RelayOpts {
  open: () => Promise<RelayStream>;
  now?: () => number;
  timers?: RelayTimers;
  pollMs?: number; // discovery cadence and retry delay (default 2 s)
  ackMinMs?: number; // minimum gap between screencast acks (default 100 ms, max 10 fps)
  minFrameMs?: number; // minimum gap between forwarded frames (default 100 ms); frames inside it are acked, held and flushed
  requestTimeoutMs?: number; // /json/list and websocket handshake deadline (default 5 s)
  onError?: (where: string, e: unknown) => void;
}

export interface CdpRelay {
  stop(): void;
}

const realTimers: RelayTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ---- outgoing: the allowlist choke point ----

/** The JSON text of a CDP command. Throws unless `method` is exactly one of ALLOWED_CDP_METHODS. */
export function buildCdpCommand(id: number, method: string, params: Record<string, unknown>): string {
  if (typeof method !== "string" || !ALLOWED_CDP_METHODS.includes(method)) {
    throw new RangeError(
      `CDP method ${JSON.stringify(String(method)).slice(0, 80)} is not allowed: the browser view may only send ${ALLOWED_CDP_METHODS.join(", ")}`,
    );
  }
  return JSON.stringify({ id, method, params });
}

// ---- sanitising and parsing (pure helpers, exported for tests) ----

// C0/C1 controls, DEL, line/paragraph separators and bidi overrides/isolates.
// Also zero-width characters (U+200B..U+200F, U+FEFF) and unpaired surrogates (6 bytes each once JSON-escaped).
const isStrippedChar = (c: number): boolean =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0xfeff ||
  (c >= 0xd800 && c <= 0xdfff); // `for...of` yields a surrogate only when it is unpaired

/** Untrusted display text: a string, control characters removed, at most MAX_TEXT characters. Undefined for anything else. */
export function sanitizeText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  let s = "";
  for (const ch of v) if (!isStrippedChar(ch.codePointAt(0)!)) s += ch;
  if (s.length > MAX_TEXT) {
    s = s.slice(0, MAX_TEXT);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // do not leave half a surrogate pair
  }
  return s;
}

export interface Target {
  id: string;
  url?: string;
  title?: string;
}

/** The first usable page in a /json/list body, or null. Never throws on hostile input. */
export function selectTarget(body: string): Target | null {
  let list: unknown;
  try {
    list = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (o.type !== "page" || typeof o.id !== "string" || !TARGET_ID.test(o.id)) continue;
    if (typeof o.url === "string" && (o.url.startsWith("devtools:") || o.url.startsWith("chrome-extension:"))) continue;
    const t: Target = { id: o.id };
    const url = sanitizeText(o.url);
    const title = sanitizeText(o.title);
    if (url !== undefined) t.url = url;
    if (title !== undefined) t.title = title;
    return t;
  }
  return null;
}

export type ListParse = { state: "need-more" } | { state: "ok"; body: string } | { state: "bad"; reason: string };

/** Parse an HTTP/1.1 reply to GET /json/list. `ended` is true once the peer closed. Capped at MAX_LIST_RESPONSE total bytes. */
export function parseListResponse(buf: Uint8Array, ended: boolean): ListParse {
  if (buf.length > MAX_LIST_RESPONSE) return { state: "bad", reason: `/json/list response exceeds ${MAX_LIST_RESPONSE} bytes` };
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.length);
  const end = b.indexOf("\r\n\r\n");
  if (end < 0)
    return ended || b.length > MAX_HANDSHAKE_HEAD ? { state: "bad", reason: "no complete HTTP head in /json/list response" } : { state: "need-more" };
  const lines = b.subarray(0, end).toString("latin1").split("\r\n");
  if (!/^HTTP\/1\.[01] 200(?: |$)/.test(lines[0]!)) return { state: "bad", reason: `/json/list answered "${lines[0]!.slice(0, 80)}"` };
  let length: number | null = null;
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i <= 0) continue;
    const name = l.slice(0, i).trim().toLowerCase();
    const val = l.slice(i + 1).trim();
    if (name === "transfer-encoding") return { state: "bad", reason: "/json/list used an unsupported transfer encoding" };
    if (name === "content-length") {
      if (!/^\d{1,9}$/.test(val)) return { state: "bad", reason: "/json/list content-length invalid" };
      length = Number(val);
    }
  }
  const body = b.subarray(end + 4);
  if (length !== null) {
    if (body.length >= length) return { state: "ok", body: body.subarray(0, length).toString("utf8") };
    return ended ? { state: "bad", reason: "/json/list response truncated" } : { state: "need-more" };
  }
  return ended ? { state: "ok", body: body.toString("utf8") } : { state: "need-more" };
}

export type FrameCheck = { ok: true; jpeg: Buffer } | { ok: false; reason: string };

/** Validate a screencast frame's base64 payload before any copy: string, length cap, decoded cap, JPEG magic. */
export function validateFrameData(data: unknown): FrameCheck {
  if (typeof data !== "string") return { ok: false, reason: "frame data is not a string" };
  if (data.length > MAX_FRAME_BASE64) return { ok: false, reason: "frame base64 exceeds the size cap" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return { ok: false, reason: "frame data is not base64" };
  const jpeg = Buffer.from(data, "base64");
  if (jpeg.length > MAX_FRAME_BYTES) return { ok: false, reason: "decoded frame exceeds the size cap" };
  if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return { ok: false, reason: "frame is not a JPEG" };
  return { ok: true, jpeg };
}

const dim = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION ? v : undefined);

// ---- the relay ----

interface Session {
  id: string; // target id
  dead: boolean;
  stream: RelayStream | null;
  ws: WsConnection | null;
  cmdId: number;
  startId: number;
  lastAckAt: number;
  acks: number[];
  ackTimer: unknown;
  hsTimer: unknown;
  lastFwdAt: number;
  held: { jpeg: Buffer; width?: number; height?: number } | null;
  fwdTimer: unknown;
  pending: number; // unresolved stream writes
  streamClosed: boolean;
  capReported: boolean; // the pending-write cap was reported to the operator
  graceTimer: unknown;
}

export function createCdpRelay(opts: RelayOpts, listener: RelayListener): CdpRelay {
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? realTimers;
  const pollMs = opts.pollMs ?? 2000;
  const ackMinMs = opts.ackMinMs ?? 100;
  const minFrameMs = opts.minFrameMs ?? 100;
  const reqMs = opts.requestTimeoutMs ?? 5000;
  const onError = (where: string, e: unknown) => opts.onError?.(where, e);

  let stopped = false;
  let tickTimer: unknown;
  let session: Session | null = null;
  let status: RelayStatus = { state: "connecting" };
  let lastJson = "";

  const setStatus = (patch: Partial<RelayStatus>, clear: ("url" | "title" | "width" | "height")[] = []) => {
    const next: RelayStatus = { ...status, ...patch };
    for (const k of clear) delete next[k];
    const json = JSON.stringify(next);
    if (json === lastJson || stopped) return;
    lastJson = json;
    status = next;
    listener.status({ ...next });
  };

  // opts.open() raced against requestTimeoutMs; a stream that arrives after the deadline is closed, not leaked.
  function openWithDeadline(): Promise<RelayStream> {
    return new Promise<RelayStream>((resolve, reject) => {
      let settled = false;
      const timer = timers.setTimeout(() => {
        settled = true;
        reject(new Error(`opening the browser stream timed out after ${reqMs} ms; the poll will retry`));
      }, reqMs);
      Promise.resolve()
        .then(() => opts.open()) // a synchronous throw becomes a rejection that clears the timer
        .then(
          (stream) => {
            timers.clearTimeout(timer);
            if (settled) stream.close();
            else {
              settled = true;
              resolve(stream);
            }
          },
          (e) => {
            timers.clearTimeout(timer);
            if (!settled) {
              settled = true;
              reject(e);
            }
          },
        );
    });
  }

  // ---- discovery: GET /json/list over a fresh stream ----
  async function discover(): Promise<Target | null> {
    const stream = await openWithDeadline();
    let timer: unknown;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stream.close();
    };
    try {
      timer = timers.setTimeout(close, reqMs);
      await stream.write(Buffer.from(`GET /json/list HTTP/1.1\r\nHost: ${CDP_HOST}\r\nConnection: close\r\n\r\n`));
      let acc = Buffer.alloc(0);
      for await (const chunk of stream.output()) {
        acc = Buffer.concat([acc, chunk]);
        const r = parseListResponse(acc, false);
        if (r.state === "bad") throw new Error(r.reason);
        if (r.state === "ok") return selectTarget(r.body);
      }
      const r = parseListResponse(acc, true);
      if (r.state !== "ok") throw new Error(r.state === "bad" ? r.reason : "/json/list response ended early");
      return selectTarget(r.body);
    } finally {
      timers.clearTimeout(timer);
      close();
    }
  }

  // ---- session: websocket to /devtools/page/<id> ----

  // The single choke point for CDP commands: buildCdpCommand throws on any method outside the allowlist.
  function send(s: Session, method: string, params: Record<string, unknown>): Promise<void> {
    return s.dead ? Promise.resolve() : sendCommand(s, method, params);
  }

  // closeSession marks the session dead before its goodbye writes, so it sends through here.
  function sendCommand(s: Session, method: string, params: Record<string, unknown>): Promise<void> {
    if (!s.stream || !s.ws) return Promise.resolve();
    const text = buildCdpCommand(s.cmdId + 1, method, params); // throws before any state changes when not allowed
    s.cmdId++;
    if (method === "Page.startScreencast") s.startId = s.cmdId;
    return write(s, encodeClientText(text)).catch((e) => endSession(s, "write", e));
  }

  // Every session write goes through here: a peer that stops reading leaves writes pending, so past MAX_PENDING_WRITES the session ends.
  function write(s: Session, data: Uint8Array): Promise<void> {
    if (!s.stream) return Promise.resolve();
    if (s.pending >= MAX_PENDING_WRITES) {
      const e = new Error(`more than ${MAX_PENDING_WRITES} stream writes unresolved; the peer stopped reading`);
      if (!s.capReported) {
        s.capReported = true;
        // A dead session is already closing on purpose (closeStream stays the only closer): report it, leave the status to whoever started the close.
        if (s.dead) onError("write", e);
        else endSession(s, "write", e);
      }
      return Promise.resolve();
    }
    s.pending++;
    const p = s.stream.write(data);
    const done = () => void s.pending--;
    p.then(done, done);
    return p;
  }

  // The only place a session's stream is closed; idempotent.
  function closeStream(s: Session): void {
    if (s.streamClosed) return;
    s.streamClosed = true;
    timers.clearTimeout(s.graceTimer);
    s.graceTimer = undefined;
    s.stream?.close();
  }

  function endSession(s: Session, where?: string, e?: unknown): void {
    if (s.dead) return;
    s.dead = true;
    if (where) onError(where, e);
    timers.clearTimeout(s.ackTimer);
    timers.clearTimeout(s.hsTimer);
    timers.clearTimeout(s.fwdTimer);
    closeStream(s);
    if (session === s) {
      session = null;
      // The poll reopens within pollMs; until then the viewers see the gap as reconnecting.
      if (!stopped) setStatus({ state: "connecting" });
    }
  }

  // The only place a per-session timer is armed: none on a dead session (stop() ends the live session, so a stopped relay has none).
  // endSession and closeSession clear every armed timer, so a callback never runs on a dead session.
  function armSessionTimer(s: Session, fn: () => void, ms: number): unknown {
    return s.dead ? undefined : timers.setTimeout(fn, ms);
  }

  const flushAck = (s: Session) => {
    s.ackTimer = undefined;
    const sessionId = s.acks.shift();
    if (sessionId === undefined) return;
    s.lastAckAt = now();
    send(s, "Page.screencastFrameAck", { sessionId });
    if (s.acks.length) s.ackTimer = armSessionTimer(s, () => flushAck(s), ackMinMs);
  };
  // Acks are the backpressure: at most one per ackMinMs, in order, whether or not the frame was valid.
  const queueAck = (s: Session, sessionId: number) => {
    if (s.acks.length >= MAX_PENDING_ACKS) return;
    s.acks.push(sessionId);
    if (s.ackTimer !== undefined) return;
    const wait = Math.max(0, s.lastAckAt + ackMinMs - now());
    if (wait === 0) flushAck(s);
    else s.ackTimer = armSessionTimer(s, () => flushAck(s), wait);
  };

  function onMessage(s: Session, text: string): void {
    if (s.dead) return; // an earlier event in this chunk ended the session: parse nothing more
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // not JSON: drop
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (m.method === undefined) {
      // A reply: only the one to our own startScreencast matters, and only when it failed.
      if (m.id === s.startId && s.startId !== 0 && m.error !== undefined) endSession(s, "start", new Error("Chromium refused Page.startScreencast"));
      return;
    }
    if (m.method !== "Page.screencastFrame") return;
    const p = m.params;
    if (typeof p !== "object" || p === null) return;
    const params = p as Record<string, unknown>;
    const sessionId = params.sessionId;
    if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId < 0) return; // cannot ack what we cannot name
    const check = validateFrameData(params.data);
    queueAck(s, sessionId);
    if (s.dead) return; // the ack write ended the session
    if (!check.ok) {
      onError("frame", new Error(check.reason));
      return;
    }
    const meta = typeof params.metadata === "object" && params.metadata !== null ? (params.metadata as Record<string, unknown>) : {};
    const width = dim(meta.deviceWidth);
    const height = dim(meta.deviceHeight);
    const frame = { jpeg: check.jpeg, ...(width !== undefined && height !== undefined && { width, height }) };
    // Chromium keeps a few frames in flight, so ack pacing (ackMinMs) alone does not cap the rate: a frame inside the window after the
    // last forwarded one is held (newest wins) and forwarded when the window ends, so a final static frame is never lost.
    const wait = s.lastFwdAt + minFrameMs - now();
    if (wait <= 0) {
      forward(s, frame);
      return;
    }
    s.held = frame;
    if (s.fwdTimer === undefined) {
      s.fwdTimer = armSessionTimer(
        s,
        () => {
          s.fwdTimer = undefined;
          const h = s.held;
          s.held = null;
          if (h) forward(s, h);
        },
        wait,
      );
    }
  }

  function forward(s: Session, f: { jpeg: Buffer; width?: number; height?: number }): void {
    if (stopped || s.dead) return;
    s.lastFwdAt = now();
    s.held = null;
    setStatus({ state: "live", ...(f.width !== undefined && f.height !== undefined && { width: f.width, height: f.height }) });
    if (stopped || s.dead) return; // a status callback may have stopped the relay
    listener.frame(f.jpeg);
  }

  function onWsEvent(s: Session, ev: WsEvent): void {
    if (ev.type === "text") onMessage(s, ev.text);
    // binary, pong, close and error carry nothing for us; WsConnection already answered ping/close.
  }

  async function runSession(s: Session): Promise<void> {
    try {
      const stream = await openWithDeadline();
      if (s.dead) return stream.close();
      s.stream = stream;
      s.hsTimer = armSessionTimer(s, () => endSession(s, "handshake", new Error("websocket handshake timed out")), reqMs);
      const { request, key } = clientHandshakeRequest({ path: `/devtools/page/${s.id}`, host: CDP_HOST });
      await stream.write(Buffer.from(request));
      let acc = Buffer.alloc(0);
      const feed = (bytes: Uint8Array) => {
        const ws = s.ws!;
        const r = ws.receive(bytes);
        for (const f of r.out) if (!s.dead) write(s, f).catch(() => {});
        for (const ev of r.events) onWsEvent(s, ev);
        if (r.end) endSession(s);
      };
      for await (const chunk of stream.output()) {
        if (s.dead) break;
        if (s.ws) {
          feed(chunk);
          continue;
        }
        acc = Buffer.concat([acc, chunk]);
        const h = parseHandshakeResponse(acc, key);
        if (h.state === "need-more") continue;
        if (h.state === "bad") throw new Error(h.reason);
        timers.clearTimeout(s.hsTimer);
        s.ws = new WsConnection({ role: "client", maxMessage: MAX_CDP_MESSAGE });
        send(s, "Page.startScreencast", { ...SCREENCAST_DEFAULTS });
        if (h.rest.length) feed(h.rest);
      }
    } catch (e) {
      endSession(s, "session", e);
    } finally {
      endSession(s);
    }
  }

  function closeSession(s: Session): void {
    if (s.dead) return;
    if (s.ws && s.stream) {
      // Best effort: stop the screencast, say goodbye, then drop the stream once the writes settled.
      // Dead first, so a write that hits the pending cap below cannot end the session a second time.
      s.dead = true;
      timers.clearTimeout(s.ackTimer);
      timers.clearTimeout(s.hsTimer);
      timers.clearTimeout(s.fwdTimer);
      if (session === s) session = null;
      const writes: Promise<void>[] = [sendCommand(s, "Page.stopScreencast", {})];
      const close = s.ws.close(1000);
      if (close) writes.push(write(s, close).catch(() => {}));
      // The writes resolve on drain, so a peer that stopped reading would keep them pending: close after CLOSE_GRACE_MS regardless.
      s.graceTimer = timers.setTimeout(() => closeStream(s), CLOSE_GRACE_MS);
      void Promise.allSettled(writes).then(() => closeStream(s));
      return;
    }
    endSession(s);
  }

  // ---- poll loop ----
  async function tick(): Promise<void> {
    tickTimer = undefined;
    if (stopped) return;
    try {
      const target = await discover();
      if (stopped) return;
      if (!target) {
        if (session) closeSession(session);
        setStatus({ state: "no-browser" }, ["url", "title", "width", "height"]);
      } else {
        if (session && session.id !== target.id) closeSession(session);
        const sameTarget = session !== null;
        if (!session) {
          session = {
            id: target.id,
            dead: false,
            stream: null,
            ws: null,
            cmdId: 0,
            startId: 0,
            lastAckAt: -Infinity,
            acks: [],
            ackTimer: undefined,
            hsTimer: undefined,
            lastFwdAt: -Infinity,
            held: null,
            fwdTimer: undefined,
            pending: 0,
            streamClosed: false,
            capReported: false,
            graceTimer: undefined,
          };
          void runSession(session);
        }
        const patch: Partial<RelayStatus> = {};
        if (target.url !== undefined) patch.url = target.url;
        if (target.title !== undefined) patch.title = target.title;
        const clear: ("url" | "title" | "width" | "height")[] = [];
        if (target.url === undefined) clear.push("url");
        if (target.title === undefined) clear.push("title");
        if (!sameTarget) clear.push("width", "height"); // a new page: the old size is stale until its first frame
        // Leaving "no-browser" for a found page is "connecting" until its first frame.
        if (status.state === "no-browser") patch.state = "connecting";
        setStatus(patch, clear);
      }
    } catch (e) {
      if (stopped) return;
      onError("discover", e);
      if (!session) setStatus({ state: "no-browser" }, ["url", "title", "width", "height"]);
    }
    if (!stopped) tickTimer = timers.setTimeout(() => void tick(), pollMs);
  }

  listener.status({ ...status });
  lastJson = JSON.stringify(status);
  void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearTimeout(tickTimer);
      if (session) closeSession(session);
    },
  };
}
