import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_CDP_METHODS,
  CLOSE_GRACE_MS,
  MAX_PENDING_WRITES,
  MAX_FRAME_BASE64,
  MAX_FRAME_BYTES,
  MAX_LIST_RESPONSE,
  MAX_TEXT,
  SCREENCAST_DEFAULTS,
  buildCdpCommand,
  createCdpRelay,
  parseListResponse,
  sanitizeText,
  selectTarget,
  validateFrameData,
  type RelayStatus,
  type RelayStream,
} from "./cdp-relay.ts";
import { FrameDecoder, encodeBinary, encodePing, encodeText, handshakeResponse } from "./websocket.ts";

// ---- scripted peers ----

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
};

class ScriptedStream implements RelayStream {
  onWrite: (data: Uint8Array) => void = () => {};
  closedByUs = false;
  #queue: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  closed: Promise<unknown>;
  #resolveClosed!: (v: unknown) => void;
  constructor() {
    this.closed = new Promise((r) => (this.#resolveClosed = r));
  }
  push(b: Uint8Array): void {
    this.#queue.push(b);
    this.#wake?.();
  }
  end(): void {
    this.#ended = true;
    this.#resolveClosed({ reason: "remote" });
    this.#wake?.();
  }
  async write(data: Uint8Array): Promise<void> {
    if (this.closedByUs) throw new Error("stream closed");
    this.onWrite(data);
  }
  close(): void {
    this.closedByUs = true;
    this.end();
  }
  async *output(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = null;
    }
  }
}

class FakeTimers {
  now = 1_000_000;
  #seq = 0;
  #pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.#pending.delete(h as number);
  };
  get pending(): number {
    return this.#pending.size;
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.#pending.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

interface Received {
  id: number;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

class Chrome {
  targets: unknown[] = [{ id: "AB12", type: "page", url: "https://example.test/", title: "Example", webSocketDebuggerUrl: "ws://evil.invalid:1/x" }];
  rawList: Uint8Array | null = null;
  openError: Error | null = null;
  badAccept = false;
  startError = false;
  opens = 0;
  lists = 0;
  wsPaths: string[] = [];
  handshakeHeads: string[] = [];
  received: Received[] = [];
  wsStreams: ScriptedStream[] = [];
  readonly timers: FakeTimers;
  constructor(timers: FakeTimers) {
    this.timers = timers;
  }
  open = async (): Promise<RelayStream> => {
    this.opens++;
    if (this.openError) throw this.openError;
    const s = new ScriptedStream();
    const dec = new FrameDecoder({ role: "server" });
    let phase: "http" | "ws" = "http";
    let buf = Buffer.alloc(0);
    s.onWrite = (data) => {
      if (phase === "http") {
        buf = Buffer.concat([buf, data]);
        if (!buf.includes("\r\n\r\n")) return;
        const head = buf.toString();
        if (head.startsWith("GET /json/list ")) {
          this.lists++;
          if (this.rawList) s.push(this.rawList);
          else {
            const body = Buffer.from(JSON.stringify(this.targets));
            s.push(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`), body]));
          }
          s.end();
          return;
        }
        this.wsPaths.push(/^GET (\S+) /.exec(head)![1]!);
        this.handshakeHeads.push(head);
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(head)![1]!;
        s.push(Buffer.from(handshakeResponse(this.badAccept ? "AAAAAAAAAAAAAAAAAAAAAA==" : key)));
        phase = "ws";
        this.wsStreams.push(s);
        return;
      }
      for (const ev of dec.push(data)) {
        if (ev.type !== "text") continue;
        const m = JSON.parse(ev.text) as { id: number; method: string; params: Record<string, unknown> };
        this.received.push({ ...m, at: this.timers.now });
        if (m.method === "Page.startScreencast" && this.startError) s.push(encodeText(JSON.stringify({ id: m.id, error: { code: -32000, message: "no" } })));
        else s.push(encodeText(JSON.stringify({ id: m.id, result: {} })));
      }
    };
    return s;
  };
  frame(data: unknown, sessionId: unknown = 1, metadata: unknown = { deviceWidth: 1280, deviceHeight: 720 }): void {
    this.wsStreams.at(-1)!.push(encodeText(JSON.stringify({ method: "Page.screencastFrame", params: { data, sessionId, metadata } })));
  }
  methods(): string[] {
    return this.received.map((r) => r.method);
  }
}

const jpeg = (n = 64, fill = 7): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

/** Byte equality for possibly large buffers. Never deepEqual a failing Buffer: Node builds a diff whose memory grows superlinearly (4 KiB costs ~200 MB, a 2 MiB frame took a machine down). The message reports lengths and the first differing index, never the bytes. */
function sameBytes(actual: Uint8Array, expected: Uint8Array, msg = "bytes differ"): void {
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const e = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (Buffer.compare(a, e) === 0) return;
  let i = 0;
  while (i < a.length && i < e.length && a[i] === e[i]) i++;
  assert.ok(false, `${msg}: actual length ${a.length}, expected length ${e.length}, first difference at index ${i}`);
}

function setup(over: { ackMinMs?: number; minFrameMs?: number } = {}) {
  const timers = new FakeTimers();
  const chrome = new Chrome(timers);
  const frames: Uint8Array[] = [];
  const statuses: RelayStatus[] = [];
  const errors: string[] = [];
  const relay = createCdpRelay(
    { open: chrome.open, now: () => timers.now, timers, onError: (w, e) => errors.push(`${w}: ${e instanceof Error ? e.message : String(e)}`), ...over },
    { frame: (f) => frames.push(f), status: (s) => statuses.push(s) },
  );
  return { timers, chrome, frames, statuses, errors, relay };
}

// ---- the allowlist ----

test("allowlist: exactly the three screencast methods, frozen", () => {
  assert.deepEqual([...ALLOWED_CDP_METHODS], ["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast"]);
  assert.ok(Object.isFrozen(ALLOWED_CDP_METHODS));
  assert.throws(() => (ALLOWED_CDP_METHODS as string[]).push("Runtime.evaluate"), TypeError);
  assert.ok(Object.isFrozen(SCREENCAST_DEFAULTS));
  for (const m of ALLOWED_CDP_METHODS) assert.equal(JSON.parse(buildCdpCommand(3, m, { a: 1 })).method, m);
});

test("allowlist: buildCdpCommand throws for every other method, including lookalikes and non-strings", () => {
  const bad = [
    "Page.navigate",
    "Runtime.evaluate",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Target.createTarget",
    "Browser.close",
    "Network.getAllCookies",
    "Page.captureScreenshot",
    "page.startScreencast",
    "Page.startScreencast ",
    " Page.startScreencast",
    "Page.startScreencast\n",
    "Page.startScreencast\u0000",
    "Page.startScreencastX",
    "Page.stopScreencas",
    "",
    "__proto__",
    "constructor",
    "toString",
    "length",
    "0",
  ];
  for (const m of bad) assert.throws(() => buildCdpCommand(1, m, {}), RangeError, JSON.stringify(m));
  for (const m of [5, null, undefined, {}, ["Page.startScreencast"], { toString: () => "Page.startScreencast" }]) {
    assert.throws(() => buildCdpCommand(1, m as unknown as string, {}), RangeError);
  }
});

test("allowlist: over a full session with hostile inbound traffic Chromium only ever receives allowlisted methods", async () => {
  const { chrome, timers, relay } = setup();
  await timers.advance(0);
  chrome.frame(b64(jpeg()), 1);
  const ws = chrome.wsStreams[0]!;
  // Chromium (the peer) tries to make us act: events and replies naming dangerous methods.
  ws.push(encodeText(JSON.stringify({ method: "Runtime.evaluate", params: { expression: "1" } })));
  ws.push(encodeText(JSON.stringify({ id: 99, method: "Page.navigate", params: { url: "file:///etc/passwd" } })));
  ws.push(encodeText(JSON.stringify({ method: "Inspector.targetCrashed", params: {} })));
  ws.push(encodeText("not json"));
  ws.push(encodeBinary(Buffer.from([1, 2, 3])));
  await timers.advance(500);
  relay.stop();
  await timers.advance(100);
  assert.ok(chrome.received.length >= 3);
  for (const r of chrome.received) assert.ok(ALLOWED_CDP_METHODS.includes(r.method), r.method);
  assert.deepEqual(chrome.methods().slice(0, 2), ["Page.startScreencast", "Page.screencastFrameAck"]);
  assert.equal(chrome.methods().at(-1), "Page.stopScreencast");
});

// ---- discovery, selection, sanitising ----

test("selectTarget: first usable page; skips devtools/extension/non-page/bad ids; path uses the id only", () => {
  const body = JSON.stringify([
    "junk",
    null,
    { id: "S1", type: "service_worker", url: "https://a/" },
    { id: "D1", type: "page", url: "devtools://devtools/bundled/inspector.html" },
    { id: "E1", type: "page", url: "chrome-extension://abc/page.html" },
    { id: "../x", type: "page", url: "https://a/" },
    { id: "a".repeat(65), type: "page", url: "https://a/" },
    { id: 7, type: "page", url: "https://a/" },
    { id: "GOOD1", type: "page", url: "https://ok/", title: "T", webSocketDebuggerUrl: "ws://evil:1/y" },
    { id: "LATER", type: "page", url: "https://later/" },
  ]);
  assert.deepEqual(selectTarget(body), { id: "GOOD1", url: "https://ok/", title: "T" });
  assert.equal(selectTarget("[]"), null);
  assert.equal(selectTarget("{}"), null);
  assert.equal(selectTarget("nope"), null);
});

test("sanitizeText: strips control characters, truncates to 512 without splitting a surrogate pair, rejects non-strings", () => {
  assert.equal(sanitizeText("a\u0000b\nc\u009fd\u202ee\u2028"), "abcde");
  assert.equal(sanitizeText("x".repeat(2000))!.length, MAX_TEXT);
  const pair = `${"x".repeat(MAX_TEXT - 1)}\u{1F600}`; // pair straddles the cut
  const cut = sanitizeText(pair)!;
  assert.equal(cut, "x".repeat(MAX_TEXT - 1));
  assert.equal(sanitizeText(42), undefined);
  assert.equal(sanitizeText({ toString: () => "x" }), undefined);
});

test("parseListResponse: need-more, content-length, until-close, cap, non-200, chunked and bad length rejected", () => {
  const head = (extra: string) => Buffer.from(`HTTP/1.1 200 OK\r\n${extra}\r\n\r\n`);
  assert.deepEqual(parseListResponse(Buffer.from("HTTP/1.1 200 OK\r\nContent-Le"), false), { state: "need-more" });
  assert.deepEqual(parseListResponse(Buffer.concat([head("Content-Length: 4"), Buffer.from("[]")]), false), { state: "need-more" });
  assert.deepEqual(parseListResponse(Buffer.concat([head("Content-Length: 2"), Buffer.from("[]xx")]), false), { state: "ok", body: "[]" });
  assert.equal(parseListResponse(Buffer.concat([head("Content-Length: 4"), Buffer.from("[]")]), true).state, "bad");
  assert.deepEqual(parseListResponse(Buffer.concat([head("Connection: close"), Buffer.from("[]")]), true), { state: "ok", body: "[]" });
  assert.equal(parseListResponse(Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n"), true).state, "bad");
  assert.equal(parseListResponse(Buffer.concat([head("Transfer-Encoding: chunked"), Buffer.from("2\r\n[]\r\n0\r\n\r\n")]), true).state, "bad");
  assert.equal(parseListResponse(head("Content-Length: -1"), true).state, "bad");
  const atCap = Buffer.concat([head("Connection: close"), Buffer.alloc(MAX_LIST_RESPONSE - head("Connection: close").length, 0x20)]);
  assert.equal(atCap.length, MAX_LIST_RESPONSE);
  assert.equal(parseListResponse(atCap, false).state, "need-more");
  assert.equal(parseListResponse(Buffer.concat([atCap, Buffer.from(" ")]), false).state, "bad");
});

test("an oversized /json/list reply is refused: no session, no-browser, error reported", async () => {
  const { chrome, timers, statuses, errors, relay } = setup();
  chrome.rawList = Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"), Buffer.alloc(MAX_LIST_RESPONSE + 1, 0x20)]);
  await timers.advance(0);
  assert.equal(chrome.wsStreams.length, 0);
  assert.equal(statuses.at(-1)!.state, "no-browser");
  assert.match(errors.join("\n"), /exceeds/);
  relay.stop();
});

// ---- session flow ----

test("flow: connecting, then the page's url/title, then live with the first frame and its size", async () => {
  const { chrome, timers, frames, statuses, relay } = setup();
  assert.deepEqual(statuses, [{ state: "connecting" }]);
  await timers.advance(0);
  assert.deepEqual(chrome.wsPaths, ["/devtools/page/AB12"]); // built from the id, not the returned ws url
  assert.ok(chrome.handshakeHeads[0]!.includes("Host: 127.0.0.1:9222\r\n"));
  assert.ok(!/origin/i.test(chrome.handshakeHeads[0]!));
  assert.deepEqual(statuses.at(-1), { state: "connecting", url: "https://example.test/", title: "Example" });
  assert.equal(chrome.received[0]!.method, "Page.startScreencast");
  assert.deepEqual(chrome.received[0]!.params, { ...SCREENCAST_DEFAULTS });
  const img = jpeg(100, 3);
  chrome.frame(b64(img), 11);
  await timers.advance(0);
  assert.equal(frames.length, 1);
  sameBytes(frames[0]!, img, "forwarded frame");
  assert.deepEqual(statuses.at(-1), { state: "live", url: "https://example.test/", title: "Example", width: 1280, height: 720 });
  assert.deepEqual(chrome.received[1]!.params, { sessionId: 11 });
  relay.stop();
});

test("listener only ever receives Uint8Array frames and status objects with known keys; hostile url/title are sanitised", async () => {
  const { chrome, timers, frames, statuses, relay } = setup();
  chrome.targets = [{ id: "AB12", type: "page", url: `https://x/\n${"u".repeat(1000)}`, title: `<b>\u0007${"t".repeat(1000)}`, extra: { cdp: true } }];
  await timers.advance(0);
  chrome.frame(b64(jpeg()), 1, { deviceWidth: 99999, deviceHeight: 3.5, pageScaleFactor: 1 });
  await timers.advance(0);
  for (const f of frames) assert.ok(f instanceof Uint8Array);
  for (const s of statuses) {
    assert.deepEqual(
      Object.keys(s).filter((k) => !["state", "url", "title", "width", "height"].includes(k)),
      [],
    );
    for (const k of ["url", "title"] as const) if (s[k] !== undefined) assert.ok(s[k]!.length <= MAX_TEXT && [...s[k]!].every((c) => c.charCodeAt(0) > 0x1f));
  }
  const last = statuses.at(-1)!;
  assert.equal(last.state, "live");
  assert.equal(last.width, undefined); // out-of-range or non-integer dimensions are dropped
  assert.equal(last.height, undefined);
  assert.ok(last.title!.startsWith("<b>")); // text is data; it is not interpreted here
  relay.stop();
});

// ---- frame validation ----

test("validateFrameData: boundaries of base64 length, decoded size and JPEG magic", () => {
  assert.equal(validateFrameData(b64(jpeg())).ok, true);
  const exact = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_FRAME_BYTES - 3, 1)]);
  assert.equal(exact.length, MAX_FRAME_BYTES);
  assert.equal(validateFrameData(b64(exact)).ok, true);
  const over = Buffer.concat([exact, Buffer.from([1])]);
  // Field-wise only: a deepEqual on a result that accepted a frame would diff the decoded bytes.
  const tooBig = validateFrameData(b64(over));
  if (tooBig.ok) assert.fail(`accepted, decoded length ${tooBig.jpeg.length}`);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, "decoded frame exceeds the size cap");
  const tooLong = validateFrameData("A".repeat(MAX_FRAME_BASE64 + 1));
  if (tooLong.ok) assert.fail(`accepted, decoded length ${tooLong.jpeg.length}`);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, "frame base64 exceeds the size cap");
  assert.equal(validateFrameData(b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).ok, false); // PNG
  assert.equal(validateFrameData(b64(Buffer.from([0xff, 0xd8, 0xfe, 0x00]))).ok, false); // near miss on the third byte
  assert.equal(validateFrameData(b64(Buffer.from([0xff, 0xd8]))).ok, false); // too short for the magic
  assert.equal(validateFrameData("").ok, false);
  assert.equal(validateFrameData("@@@@").ok, false);
  for (const v of [undefined, null, 5, {}, [b64(jpeg())]]) assert.equal(validateFrameData(v).ok, false);
});

test("invalid frames are dropped before the listener but still acked so the stream continues", async () => {
  // minFrameMs: 0 so a wrongly forwarded oversized frame cannot be masked by the throttle holding the later valid one.
  const { chrome, timers, frames, relay } = setup({ ackMinMs: 1, minFrameMs: 0 });
  await timers.advance(0);
  chrome.frame(b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])), 1); // PNG
  chrome.frame("A".repeat(MAX_FRAME_BASE64 + 1), 2); // too long to decode
  chrome.frame(b64(Buffer.concat([jpeg(), Buffer.alloc(MAX_FRAME_BYTES)])), 3); // decoded too big
  chrome.frame(12345, 4); // not a string
  chrome.frame(b64(jpeg()), "x"); // unnameable session: cannot ack, dropped
  chrome.frame(b64(jpeg()), 6);
  await timers.advance(0);
  await timers.advance(50);
  for (const f of frames) assert.ok(f.length <= MAX_FRAME_BYTES, `forwarded a frame of ${f.length} bytes, over the cap`);
  assert.equal(frames.length, 1);
  sameBytes(frames[0]!, jpeg(), "the only forwarded frame is frame 6");
  const acked = chrome.received.filter((r) => r.method === "Page.screencastFrameAck").map((r) => r.params.sessionId);
  assert.deepEqual(acked, [1, 2, 3, 4, 6]);
  relay.stop();
});

// ---- ack pacing ----

test("acks are paced to one per 100 ms, in order", async () => {
  const { chrome, timers, relay } = setup();
  await timers.advance(0);
  for (const id of [1, 2, 3]) chrome.frame(b64(jpeg()), id);
  await timers.advance(0);
  const acks = () => chrome.received.filter((r) => r.method === "Page.screencastFrameAck");
  assert.deepEqual(
    acks().map((a) => a.params.sessionId),
    [1],
  );
  await timers.advance(99);
  assert.equal(acks().length, 1);
  await timers.advance(1);
  assert.deepEqual(
    acks().map((a) => a.params.sessionId),
    [1, 2],
  );
  await timers.advance(100);
  assert.deepEqual(
    acks().map((a) => a.params.sessionId),
    [1, 2, 3],
  );
  assert.ok(acks()[1]!.at - acks()[0]!.at >= 100 && acks()[2]!.at - acks()[1]!.at >= 100);
  relay.stop();
});

// ---- retry, switching, stop ----

test("no browser: empty list and a failing open both read no-browser and retry every 2 s; a page appearing recovers", async () => {
  const { chrome, timers, statuses, relay } = setup();
  chrome.targets = [];
  await timers.advance(0);
  assert.equal(statuses.at(-1)!.state, "no-browser");
  assert.equal(chrome.lists, 1);
  await timers.advance(1999);
  assert.equal(chrome.lists, 1);
  await timers.advance(1);
  assert.equal(chrome.lists, 2);
  chrome.openError = new Error("sandbox gone");
  await timers.advance(2000);
  assert.equal(chrome.opens, 3);
  assert.equal(statuses.at(-1)!.state, "no-browser");
  chrome.openError = null;
  chrome.targets = [{ id: "NEW1", type: "page", url: "https://n/", title: "N" }];
  await timers.advance(2000);
  assert.deepEqual(chrome.wsPaths, ["/devtools/page/NEW1"]);
  assert.deepEqual(statuses.at(-1), { state: "connecting", url: "https://n/", title: "N" });
  relay.stop();
});

test("the poll refreshes url/title and switches target when the page changes or goes away", async () => {
  const { chrome, timers, statuses, relay } = setup();
  await timers.advance(0);
  chrome.frame(b64(jpeg()), 1);
  await timers.advance(0);
  chrome.targets = [{ id: "AB12", type: "page", url: "https://example.test/next", title: "Next" }];
  await timers.advance(2000);
  assert.equal(chrome.wsPaths.length, 1); // same page, navigated
  assert.deepEqual(statuses.at(-1), { state: "live", url: "https://example.test/next", title: "Next", width: 1280, height: 720 });
  chrome.targets = [{ id: "ZZ99", type: "page", url: "https://other/", title: "O" }];
  await timers.advance(2000);
  assert.deepEqual(chrome.wsPaths, ["/devtools/page/AB12", "/devtools/page/ZZ99"]);
  assert.equal(chrome.methods().filter((m) => m === "Page.stopScreencast").length, 1); // the old page was stopped
  assert.equal(chrome.wsStreams[0]!.closedByUs, true);
  assert.equal(statuses.at(-1)!.width, undefined); // stale size cleared for the new page
  chrome.targets = [];
  await timers.advance(2000);
  assert.equal(statuses.at(-1)!.state, "no-browser");
  assert.equal(chrome.wsStreams[1]!.closedByUs, true);
  relay.stop();
});

test("a refused startScreencast, a bad handshake accept and an over-cap CDP message each end the session and the poll retries", async () => {
  const a = setup();
  a.chrome.startError = true;
  await a.timers.advance(0);
  assert.equal(a.chrome.wsStreams[0]!.closedByUs, true);
  assert.equal(a.statuses.at(-1)!.state, "connecting");
  a.chrome.startError = false;
  await a.timers.advance(2000);
  assert.equal(a.chrome.wsStreams.length, 2);
  a.relay.stop();

  const b = setup();
  b.chrome.badAccept = true;
  await b.timers.advance(0);
  assert.match(b.errors.join("\n"), /Sec-WebSocket-Accept/);
  assert.equal(b.frames.length, 0);
  b.relay.stop();

  const c = setup();
  await c.timers.advance(0);
  // a server frame header declaring a message beyond the 4 MiB cap
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(4 * 1024 * 1024 + 1), 2);
  c.chrome.wsStreams[0]!.push(head);
  await c.timers.advance(0);
  assert.equal(c.chrome.wsStreams[0]!.closedByUs, true);
  c.relay.stop();
});

test("a silent Chromium is abandoned at the request deadline", async () => {
  const timers = new FakeTimers();
  const hung = new ScriptedStream();
  const errors: string[] = [];
  const relay = createCdpRelay(
    { open: async () => hung, now: () => timers.now, timers, requestTimeoutMs: 5000, onError: (w) => errors.push(w) },
    { frame() {}, status() {} },
  );
  await timers.advance(0);
  await timers.advance(4999);
  assert.equal(hung.closedByUs, false);
  await timers.advance(1);
  assert.equal(hung.closedByUs, true);
  relay.stop();
});

test("stop: stopScreencast sent, streams closed, polling ceases, listener silent afterwards", async () => {
  const { chrome, timers, frames, statuses, relay } = setup();
  await timers.advance(0);
  chrome.frame(b64(jpeg()), 1);
  await timers.advance(0);
  const nStatuses = statuses.length;
  relay.stop();
  await timers.advance(0);
  assert.equal(chrome.methods().at(-1), "Page.stopScreencast");
  assert.equal(chrome.wsStreams[0]!.closedByUs, true);
  const opens = chrome.opens;
  chrome.frame(b64(jpeg()), 2); // a straggler after stop
  await timers.advance(10_000);
  assert.equal(chrome.opens, opens);
  assert.equal(frames.length, 1);
  assert.equal(statuses.length, nStatuses);
  assert.equal(timers.pending, 0);
  relay.stop(); // idempotent
});

test("stop during discovery or before the websocket opens leaks nothing", async () => {
  const { chrome, timers, relay } = setup();
  relay.stop(); // before the first list reply resolves
  await timers.advance(5000);
  assert.equal(chrome.wsStreams.length, 0);
  assert.equal(timers.pending, 0);
});

test("rate cap: a burst at 10 ms spacing forwards at most one frame per 100 ms, acks every frame, and the newest dropped frame is flushed", async () => {
  const { chrome, timers, frames, relay } = setup();
  await timers.advance(0);
  const fwdTimes: number[] = [];
  for (let i = 1; i <= 30; i++) {
    chrome.frame(b64(jpeg(8, i)), i);
    await timers.advance(10);
    while (fwdTimes.length < frames.length) fwdTimes.push(timers.now);
  }
  await timers.advance(3000);
  while (fwdTimes.length < frames.length) fwdTimes.push(timers.now);
  assert.ok(frames.length >= 3 && frames.length <= 4, `forwarded ${frames.length}`);
  for (let i = 1; i < fwdTimes.length; i++) assert.ok(fwdTimes[i]! - fwdTimes[i - 1]! >= 90, `gap ${fwdTimes[i]! - fwdTimes[i - 1]!}`); // 10 ms sampling slack
  assert.equal(frames.at(-1)![frames.at(-1)!.length - 1], 30); // the last frame of the burst was not lost
  const acked = chrome.received.filter((r) => r.method === "Page.screencastFrameAck").map((r) => r.params.sessionId);
  assert.deepEqual(
    acked.slice(0, 16),
    Array.from({ length: 16 }, (_, i) => i + 1),
  ); // paced, in order, none skipped (queue cap 16)
  relay.stop();
});

test("rate cap is its own window, independent of ack pacing: fast acks still forward one frame per 100 ms", async () => {
  const { chrome, timers, frames, relay } = setup({ ackMinMs: 1 });
  await timers.advance(0);
  for (let i = 1; i <= 5; i++) {
    chrome.frame(b64(jpeg(8, i)), i);
    await timers.advance(10);
  }
  assert.equal(frames.length, 1);
  await timers.advance(100);
  assert.equal(frames.length, 2);
  assert.equal(frames[1]![frames[1]!.length - 1], 5);
  relay.stop();
});

test("a single static frame is forwarded at once and stays available to the hub; a held frame is dropped on stop", async () => {
  const { chrome, timers, frames, relay } = setup();
  await timers.advance(0);
  chrome.frame(b64(jpeg(8, 1)), 1);
  chrome.frame(b64(jpeg(8, 2)), 2);
  await timers.advance(0);
  assert.equal(frames.length, 1);
  relay.stop();
  await timers.advance(500);
  assert.equal(frames.length, 1);
});

// ---- review fixes ----

const hang = (): Promise<void> => new Promise<void>(() => {});

test("close cannot hang: a stream whose writes never settle is still closed after CLOSE_GRACE_MS, once", async () => {
  assert.equal(CLOSE_GRACE_MS, 1000);
  const { chrome, timers, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  let closes = 0;
  const realClose = ws.close.bind(ws);
  ws.close = () => {
    closes++;
    realClose();
  };
  ws.write = hang;
  relay.stop();
  await timers.advance(CLOSE_GRACE_MS - 1);
  assert.equal(ws.closedByUs, false);
  await timers.advance(1);
  assert.equal(ws.closedByUs, true);
  await timers.advance(5000);
  assert.equal(closes, 1);
});

test("close does not wait for the grace period when the writes settle, and leaves no timer behind", async () => {
  const { chrome, timers, relay } = setup();
  await timers.advance(0);
  relay.stop();
  await timers.advance(0);
  assert.equal(chrome.wsStreams[0]!.closedByUs, true);
  assert.equal(timers.pending, 0);
});

test("unbounded pong writes: more than MAX_PENDING_WRITES unresolved writes end the session", async () => {
  assert.equal(MAX_PENDING_WRITES, 64);
  const { chrome, timers, errors, statuses, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES + 1; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(ws.closedByUs, true);
  assert.ok(
    errors.some((e) => e.startsWith("write")),
    errors.join("|"),
  );
  assert.equal(statuses.at(-1)!.state, "connecting");
  relay.stop();
});

test("pending writes at the cap do not end the session (negative control)", async () => {
  const { chrome, timers, errors, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(ws.closedByUs, false);
  assert.deepEqual(errors, []);
  relay.stop();
});

test("no timer is armed on a dead session: the ack flush that hits the write cap does not re-arm the ack timer", async () => {
  const { chrome, timers, errors, statuses, relay } = setup({ ackMinMs: 100 });
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  chrome.frame(b64(jpeg(8, 1)), 1); // acked at once
  chrome.frame(b64(jpeg(8, 2)), 2); // acks 2 and 3 queue behind the ack timer
  chrome.frame(b64(jpeg(8, 3)), 3);
  await timers.advance(0);
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(ws.closedByUs, false); // exactly at the cap: still alive
  await timers.advance(100); // the ack timer fires; its write is the one over the cap
  assert.ok(
    errors.some((e) => e.startsWith("write")),
    errors.join("|"),
  );
  assert.equal(statuses.at(-1)!.state, "connecting");
  assert.equal(timers.pending, 1); // only the poll tick; no ack or forward timer on the dead session
  relay.stop();
});

test("no timer is armed on a dead session: a frame whose ack flush hits the write cap does not hold or arm the forward timer", async () => {
  const { chrome, timers, errors, relay } = setup({ ackMinMs: 50, minFrameMs: 200 });
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  chrome.frame(b64(jpeg(8, 1)), 1); // acked and forwarded at once
  await timers.advance(0);
  await timers.advance(50); // the ack window is open again, the forward window (200 ms) is not
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(ws.closedByUs, false);
  chrome.frame(b64(jpeg(8, 2)), 2); // queueAck flushes at once, over the cap
  await timers.advance(0);
  assert.ok(
    errors.some((e) => e.startsWith("write")),
    errors.join("|"),
  );
  assert.equal(timers.pending, 1); // only the poll tick
  relay.stop();
});

test("a hung open() is abandoned at requestTimeoutMs and the poll tries again; a late stream is closed", async () => {
  const timers = new FakeTimers();
  const chrome = new Chrome(timers);
  let attempts = 0;
  let late!: (s: RelayStream) => void;
  const statuses: RelayStatus[] = [];
  const errors: string[] = [];
  const relay = createCdpRelay(
    {
      open: () => {
        attempts++;
        if (attempts === 1) return new Promise<RelayStream>((r) => (late = r));
        return chrome.open();
      },
      now: () => timers.now,
      timers,
      requestTimeoutMs: 5000,
      pollMs: 2000,
      onError: (w) => errors.push(w),
    },
    { frame() {}, status: (s) => statuses.push(s) },
  );
  await timers.advance(4999);
  assert.equal(attempts, 1);
  await timers.advance(1);
  assert.equal(statuses.at(-1)!.state, "no-browser");
  assert.ok(errors.includes("discover"));
  await timers.advance(2000);
  assert.ok(attempts >= 2, `attempts ${attempts}`);
  const stray = new ScriptedStream();
  late(stray);
  await flush();
  assert.equal(stray.closedByUs, true);
  relay.stop();
});

test("sanitizeText: strips lone surrogates and zero-width characters, keeps real pairs", () => {
  assert.equal(sanitizeText("a\ud800b\udc00c"), "abc");
  assert.equal(sanitizeText("a\u200b\u200c\u200d\u200e\u200f\ufeffb"), "ab");
  assert.equal(sanitizeText("x\u{1F600}y"), "x\u{1F600}y");
  assert.equal(sanitizeText("\ud800".repeat(600)), "");
  assert.equal(sanitizeText("\u200a\u2010"), "\u200a\u2010"); // neighbours of the ranges stay
});

test("no frame reaches the listener after stop, even for events in the same chunk", async () => {
  const timers = new FakeTimers();
  const chrome = new Chrome(timers);
  const frames: Uint8Array[] = [];
  let relay!: ReturnType<typeof createCdpRelay>;
  relay = createCdpRelay(
    { open: chrome.open, now: () => timers.now, timers },
    {
      frame: (f) => frames.push(f),
      status: (s) => {
        if (s.state === "live") relay.stop();
      },
    },
  );
  await timers.advance(0);
  chrome.frame(b64(jpeg()), 1);
  await timers.advance(0);
  assert.equal(frames.length, 0);
});

test("closing with the pending writes already at the cap closes the stream exactly once", async () => {
  const { chrome, timers, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  let closes = 0;
  const realClose = ws.close.bind(ws);
  ws.close = () => {
    closes++;
    realClose();
  };
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(closes, 0);
  relay.stop();
  await timers.advance(5000);
  assert.equal(closes, 1);
});

for (const n of [0, 1, 62, 63, 64, 65]) {
  test(`stop with ${n} unresolved pong writes closes the stream exactly once and leaves no timer`, async () => {
    const { chrome, timers, relay } = setup();
    await timers.advance(0);
    const ws = chrome.wsStreams[0]!;
    let closes = 0;
    const realClose = ws.close.bind(ws);
    ws.close = () => {
      closes++;
      realClose();
    };
    ws.write = hang;
    for (let i = 0; i < n; i++) ws.push(encodePing());
    await timers.advance(0);
    relay.stop();
    await timers.advance(CLOSE_GRACE_MS + 1);
    assert.equal(closes, 1, `n=${n}`);
    assert.equal(timers.pending, 0, `n=${n}`);
  });
}

test("a stop() from a frame callback mid-chunk arms no ack or forward timer and forwards at most one frame", async () => {
  const timers = new FakeTimers();
  const chrome = new Chrome(timers);
  const frames: Uint8Array[] = [];
  let relay!: ReturnType<typeof createCdpRelay>;
  relay = createCdpRelay(
    { open: chrome.open, now: () => timers.now, timers },
    {
      frame: (f) => {
        frames.push(f);
        relay.stop();
      },
      status() {},
    },
  );
  await timers.advance(0);
  const msg = (sessionId: number) =>
    encodeText(
      JSON.stringify({ method: "Page.screencastFrame", params: { data: b64(jpeg()), sessionId, metadata: { deviceWidth: 1280, deviceHeight: 720 } } }),
    );
  chrome.wsStreams[0]!.push(Buffer.concat([msg(1), msg(2)]));
  await timers.advance(0);
  assert.ok(frames.length <= 1, `frames ${frames.length}`);
  await timers.advance(CLOSE_GRACE_MS + 1); // past the close grace, so the count does not depend on the order promises settle in
  assert.equal(timers.pending, 0);
});

test("an open() that throws synchronously leaves no deadline timer armed", async () => {
  const timers = new FakeTimers();
  const errors: string[] = [];
  const relay = createCdpRelay(
    {
      open: () => {
        throw new Error("boom");
      },
      now: () => timers.now,
      timers,
      onError: (w) => errors.push(w),
    },
    { frame() {}, status() {} },
  );
  await timers.advance(0);
  assert.ok(errors.includes("discover"), errors.join("|"));
  relay.stop();
  assert.equal(timers.pending, 0);
});

for (const n of [63, 64]) {
  test(`stop with ${n} unresolved writes reports the write cap to the operator once, and closes the stream once`, async () => {
    const { chrome, timers, errors, relay } = setup();
    await timers.advance(0);
    const ws = chrome.wsStreams[0]!;
    let closes = 0;
    const realClose = ws.close.bind(ws);
    ws.close = () => {
      closes++;
      realClose();
    };
    ws.write = hang;
    for (let i = 0; i < n; i++) ws.push(encodePing());
    await timers.advance(0);
    assert.deepEqual(errors, [], `n=${n}: nothing reported below the cap`);
    relay.stop();
    await timers.advance(CLOSE_GRACE_MS + 1);
    assert.equal(errors.length, 1, `n=${n}: ${errors.join("|")}`);
    assert.match(errors[0]!, new RegExp(`^write: .*${MAX_PENDING_WRITES}.*peer stopped reading`));
    assert.equal(closes, 1, `n=${n}`);
  });
}

test("stop with 62 unresolved writes fits both goodbye writes and reports nothing (negative control)", async () => {
  const { chrome, timers, errors, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  ws.write = hang;
  for (let i = 0; i < 62; i++) ws.push(encodePing());
  await timers.advance(0);
  relay.stop();
  await timers.advance(CLOSE_GRACE_MS + 1);
  assert.deepEqual(errors, []);
});

test("discovery against a stream that never answers closes it exactly once, at the request deadline", async () => {
  const timers = new FakeTimers();
  const hung = new ScriptedStream();
  let closes = 0;
  const realClose = hung.close.bind(hung);
  hung.close = () => {
    closes++;
    realClose();
  };
  const errors: string[] = [];
  const relay = createCdpRelay(
    { open: async () => hung, now: () => timers.now, timers, requestTimeoutMs: 5000, onError: (w) => errors.push(w) },
    { frame() {}, status() {} },
  );
  await timers.advance(0);
  await timers.advance(4999);
  assert.equal(closes, 0);
  await timers.advance(1);
  assert.deepEqual(errors, ["discover"]); // the discovery ended on the deadline
  assert.equal(closes, 1);
  relay.stop();
});

test("an invalid frame whose ack write ends the session is not reported as a frame error", async () => {
  const { chrome, timers, errors, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(errors.length, 0);
  chrome.frame(42, 1); // not a string: invalid; its ack flushes at once, over the cap, and ends the session
  await timers.advance(0);
  assert.equal(errors.length, 1, errors.join("|"));
  assert.ok(errors[0]!.startsWith("write"), errors[0]);
  relay.stop();
});

test("an invalid frame on a live session is reported as a frame error (negative control)", async () => {
  const { chrome, timers, errors, relay } = setup();
  await timers.advance(0);
  chrome.frame(42, 1);
  await timers.advance(0);
  assert.equal(errors.length, 1, errors.join("|"));
  assert.ok(errors[0]!.startsWith("frame"), errors[0]);
  relay.stop();
});

test("a session killed mid-chunk parses none of the chunk's remaining events", async () => {
  const { chrome, timers, errors, frames, relay } = setup();
  await timers.advance(0);
  const ws = chrome.wsStreams[0]!;
  ws.write = hang;
  for (let i = 0; i < MAX_PENDING_WRITES; i++) ws.push(encodePing());
  await timers.advance(0);
  assert.equal(errors.length, 0);
  // The first invalid frame's ack flush hits the write cap and ends the session; 50 more invalid frames follow in the same chunk.
  const one = Buffer.from(encodeText(JSON.stringify({ method: "Page.screencastFrame", params: { data: 42, sessionId: 1 } })));
  const chunk = Buffer.concat(Array.from({ length: 51 }, () => one));
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...a: Parameters<typeof JSON.parse>) => {
    parses++;
    return realParse(...a);
  };
  try {
    ws.push(chunk);
    await timers.advance(0);
  } finally {
    JSON.parse = realParse;
  }
  assert.equal(parses, 1, "only the event that killed the session is parsed");
  assert.equal(errors.length, 1, errors.join("|"));
  assert.ok(errors[0]!.startsWith("write"), errors[0]);
  assert.equal(frames.length, 0);
  relay.stop();
});
