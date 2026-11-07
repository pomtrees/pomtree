import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptKey,
  checkUpgrade,
  clientHandshakeRequest,
  encodeBinary,
  encodeClose,
  encodeClientText,
  encodeFrame,
  encodeMasked,
  encodePing,
  encodePong,
  encodeText,
  FrameDecoder,
  MAX_FRAGMENTS,
  handshakeResponse,
  originAllowed,
  parseHandshakeResponse,
  Opcode,
  WsConnection,
  type WsEvent,
} from "./websocket.ts";

const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

/** Build a masked client frame. */
function client(opcode: number, payload: Uint8Array, fin = true, mask: Buffer | null = MASK): Buffer {
  const n = payload.length;
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  const m = mask ? 0x80 : 0;
  if (n < 126) head.push(m | n);
  else if (n <= 0xffff) head.push(m | 126, n >> 8, n & 0xff);
  else {
    const l = Buffer.alloc(8);
    l.writeBigUInt64BE(BigInt(n));
    head.push(m | 127, ...l);
  }
  const body = Buffer.from(payload);
  if (mask) {
    head.push(...mask);
    for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i & 3]!;
  }
  return Buffer.concat([Buffer.from(head), body]);
}

/** Byte equality for possibly large buffers. Never deepEqual a failing Buffer: Node builds a diff whose memory grows superlinearly (4 KiB costs ~200 MB). The message reports lengths and the first differing index, never the bytes. */
function sameBytes(actual: Uint8Array, expected: Uint8Array, msg = "bytes differ"): void {
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const e = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (Buffer.compare(a, e) === 0) return;
  let i = 0;
  while (i < a.length && i < e.length && a[i] === e[i]) i++;
  assert.ok(false, `${msg}: actual length ${a.length}, expected length ${e.length}, first difference at index ${i}`);
}

const one = (events: WsEvent[]): WsEvent => {
  assert.equal(events.length, 1, JSON.stringify(events.map((e) => e.type)));
  return events[0]!;
};

test("RFC 6455 section 1.3 accept key", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  const res = handshakeResponse("dGhlIHNhbXBsZSBub25jZQ==", "tty");
  assert.match(res, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(res, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/);
  assert.match(res, /Sec-WebSocket-Protocol: tty\r\n/);
  assert.ok(res.endsWith("\r\n\r\n"));
});

test("checkUpgrade accepts a valid request and rejects each defect", () => {
  const good = {
    upgrade: "WebSocket",
    connection: "keep-alive, Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  assert.deepEqual(checkUpgrade(good), { ok: true, key: "dGhlIHNhbXBsZSBub25jZQ==" });
  const bad = (patch: Record<string, string | undefined>, method?: string) => checkUpgrade({ ...good, ...patch }, method);
  assert.equal(bad({ upgrade: "h2c" }).ok, false);
  assert.equal(bad({ connection: "close" }).ok, false);
  const v = bad({ "sec-websocket-version": "8" });
  assert.ok(!v.ok && v.status === 426);
  assert.equal(bad({ "sec-websocket-key": undefined }).ok, false);
  assert.equal(bad({ "sec-websocket-key": "short" }).ok, false);
  assert.equal(bad({ "sec-websocket-key": Buffer.alloc(15).toString("base64") }).ok, false);
  const m = bad({}, "POST");
  assert.ok(!m.ok && m.status === 405);
});

test("originAllowed: matcher decides; missing/null origin rejected", () => {
  const allow = (o: string) => o === "http://localhost:8787";
  assert.equal(originAllowed("http://localhost:8787", allow), true);
  assert.equal(originAllowed("http://evil.example", allow), false);
  assert.equal(
    originAllowed(undefined, () => true),
    false,
  );
  assert.equal(
    originAllowed("null", () => true),
    false,
  );
  assert.equal(
    originAllowed("", () => true),
    false,
  );
  assert.equal(
    originAllowed(["http://localhost:8787"], () => true),
    false,
  );
});

test("section 5.7: masked 'Hello' decodes", () => {
  const bytes = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  assert.deepEqual(one(new FrameDecoder().push(bytes)), { type: "text", text: "Hello" });
});

test("section 5.7: unmasked 'Hello' encodes", () => {
  assert.deepEqual(encodeText("Hello"), Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
});

test("section 5.7: fragmented 'Hel' + 'lo' reassembles", () => {
  const d = new FrameDecoder();
  assert.deepEqual(d.push(client(Opcode.text, Buffer.from("Hel"), false)), []);
  assert.deepEqual(one(d.push(client(Opcode.continuation, Buffer.from("lo"), true))), {
    type: "text",
    text: "Hello",
  });
});

test("section 5.7: ping 'Hello' decodes, pong encodes", () => {
  const ping = Buffer.from([0x89, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  const ev = one(new FrameDecoder().push(ping));
  assert.equal(ev.type, "ping");
  assert.equal((ev as { data: Buffer }).data.toString(), "Hello");
  assert.deepEqual(encodePong(Buffer.from("Hello")), Buffer.from([0x8a, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  assert.deepEqual(encodePing(Buffer.from("Hello")), Buffer.from([0x89, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
});

test("section 5.7: 256-byte and 64KiB binary frames (16- and 64-bit lengths)", () => {
  for (const [n, lenBytes] of [
    [256, 4],
    [65536, 10],
  ] as const) {
    const payload = Buffer.alloc(n, 0xab);
    const enc = encodeBinary(payload);
    assert.equal(enc.length, lenBytes + n);
    assert.equal(enc[1], n === 256 ? 126 : 127);
    const ev = one(new FrameDecoder().push(client(Opcode.binary, payload)));
    assert.equal(ev.type, "binary");
    assert.ok((ev as { data: Buffer }).data.equals(payload));
  }
});

test("byte-at-a-time and split pushes give identical results", () => {
  const frames = Buffer.concat([
    client(Opcode.text, Buffer.from("héllo")),
    client(Opcode.binary, Buffer.alloc(300, 7)),
    client(Opcode.ping, Buffer.from("p")),
    client(Opcode.text, Buffer.alloc(0)),
  ]);
  const d = new FrameDecoder();
  const evs: WsEvent[] = [];
  for (const byte of frames) evs.push(...d.push(Uint8Array.of(byte)));
  assert.deepEqual(
    evs.map((e) => e.type),
    ["text", "binary", "ping", "text"],
  );
  assert.equal((evs[0] as { text: string }).text, "héllo");
  assert.equal((evs[3] as { text: string }).text, "");
  for (const cut of [1, 5, 7, 100, frames.length - 1]) {
    const d2 = new FrameDecoder();
    const got = [...d2.push(frames.subarray(0, cut)), ...d2.push(frames.subarray(cut))];
    assert.deepEqual(
      got.map((e) => e.type),
      ["text", "binary", "ping", "text"],
    );
  }
});

test("zero-length frame with chunk ending exactly at header", () => {
  const d = new FrameDecoder();
  const f = client(Opcode.binary, new Uint8Array(0));
  assert.deepEqual(one(d.push(f)), { type: "binary", data: Buffer.alloc(0) });
});

test("oversize: declared length beyond max yields 1009 without buffering", () => {
  const d = new FrameDecoder({ maxMessage: 100 });
  const head = Buffer.from([0x82, 0xfe, 0x01, 0x00, ...MASK]); // 256 > 100
  const ev = one(d.push(head));
  assert.equal(ev.type, "error");
  assert.equal((ev as { code: number }).code, 1009);
  assert.deepEqual(d.push(client(Opcode.text, Buffer.from("x"))), []); // dead
});

test("oversize: fragments summing past max yield 1009", () => {
  const d = new FrameDecoder({ maxMessage: 10 });
  assert.deepEqual(d.push(client(Opcode.binary, Buffer.alloc(6), false)), []);
  const ev = one(d.push(client(Opcode.continuation, Buffer.alloc(6), true)));
  assert.equal((ev as { code: number }).code, 1009);
});

test("default max is 1 MiB", () => {
  assert.equal(new FrameDecoder().maxMessage, 1024 * 1024);
  const ev = one(new FrameDecoder().push(Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 1, ...MASK])));
  assert.equal((ev as { code: number }).code, 1009);
});

test("protocol errors: unmasked, reserved bits, bad opcode, control rules, sequencing", () => {
  const code = (b: Buffer, o = {}) => {
    const ev = one(new FrameDecoder(o).push(b));
    assert.equal(ev.type, "error");
    return (ev as { code: number }).code;
  };
  assert.equal(code(client(Opcode.text, Buffer.from("x"), true, null)), 1002);
  const rsv = client(Opcode.text, Buffer.from("x"));
  rsv[0] = rsv[0]! | 0x40;
  assert.equal(code(rsv), 1002);
  const badop = client(Opcode.text, Buffer.from("x"));
  badop[0] = 0x83;
  assert.equal(code(badop), 1002);
  assert.equal(code(client(Opcode.ping, Buffer.from("x"), false)), 1002);
  assert.equal(code(client(Opcode.ping, Buffer.alloc(126))), 1002);
  assert.equal(code(client(Opcode.continuation, Buffer.from("x"))), 1002);
  const d = new FrameDecoder();
  d.push(client(Opcode.text, Buffer.from("a"), false));
  assert.equal(one(d.push(client(Opcode.text, Buffer.from("b")))).type, "error");
  // non-minimal 16-bit length
  assert.equal(code(Buffer.from([0x82, 0xfe, 0x00, 0x05, ...MASK, 1, 2, 3, 4, 5])), 1002);
});

test("control frames may interleave with a fragmented message", () => {
  const d = new FrameDecoder();
  const evs = [
    ...d.push(client(Opcode.text, Buffer.from("ab"), false)),
    ...d.push(client(Opcode.ping, Buffer.from("!"))),
    ...d.push(client(Opcode.continuation, Buffer.from("cd"))),
  ];
  assert.deepEqual(
    evs.map((e) => e.type),
    ["ping", "text"],
  );
  assert.equal((evs[1] as { text: string }).text, "abcd");
});

test("invalid UTF-8 text yields 1007; binary is not validated", () => {
  const ev = one(new FrameDecoder().push(client(Opcode.text, Buffer.from([0xff, 0xfe]))));
  assert.equal((ev as { code: number }).code, 1007);
  assert.equal(one(new FrameDecoder().push(client(Opcode.binary, Buffer.from([0xff])))).type, "binary");
});

test("UTF-8 split across fragments is valid", () => {
  const euro = Buffer.from("€");
  const d = new FrameDecoder();
  d.push(client(Opcode.text, euro.subarray(0, 1), false));
  assert.deepEqual(one(d.push(client(Opcode.continuation, euro.subarray(1)))), { type: "text", text: "€" });
});

test("close frame round trip", () => {
  const enc = encodeClose(1000, "bye");
  assert.deepEqual([...enc.subarray(0, 4)], [0x88, 5, 0x03, 0xe8]);
  const ev = one(new FrameDecoder().push(client(Opcode.close, enc.subarray(2))));
  assert.deepEqual(ev, { type: "close", code: 1000, reason: "bye" });
  assert.deepEqual(one(new FrameDecoder().push(client(Opcode.close, Buffer.alloc(0)))), {
    type: "close",
    code: null,
    reason: "",
  });
  assert.equal(encodeClose().length, 2);
  // long reason truncated to fit 125-byte control limit
  assert.ok(encodeClose(1000, "€".repeat(100)).length <= 2 + 125);
});

test("close frame validation", () => {
  const bad = (payload: Buffer) => (one(new FrameDecoder().push(client(Opcode.close, payload))) as { code: number }).code;
  assert.equal(bad(Buffer.from([0x03])), 1002);
  assert.equal(bad(Buffer.from([0x03, 0xed])), 1002); // 1005 reserved
  assert.equal(bad(Buffer.from([0x03, 0xe8, 0xff])), 1007);
});

test("encoder: control payload limit and 126-byte boundary", () => {
  assert.throws(() => encodePing(Buffer.alloc(126)), RangeError);
  assert.equal(encodeFrame(Opcode.binary, Buffer.alloc(125)).length, 127);
  assert.equal(encodeFrame(Opcode.binary, Buffer.alloc(126)).length, 130);
});

test("WsConnection: auto-pong, messages, echoed close, ignores data after end", () => {
  const c = new WsConnection();
  let r = c.receive(Buffer.concat([client(Opcode.ping, Buffer.from("k")), client(Opcode.text, Buffer.from("hi"))]));
  assert.deepEqual(r.events, [{ type: "text", text: "hi" }]);
  assert.deepEqual(r.out, [encodePong(Buffer.from("k"))]);
  assert.equal(r.end, false);
  const closeBody = encodeClose(1001, "").subarray(2);
  r = c.receive(Buffer.concat([client(Opcode.close, closeBody), client(Opcode.text, Buffer.from("late"))]));
  assert.deepEqual(r.out, [encodeClose(1001, "")]);
  assert.equal(r.events.length, 1);
  assert.equal(r.end, true);
  const after = c.receive(client(Opcode.text, Buffer.from("x")));
  assert.deepEqual(after.events, []);
  assert.equal(after.end, true);
});

test("WsConnection: protocol error sends matching close and ends", () => {
  const c = new WsConnection({ maxMessage: 4 });
  const r = c.receive(client(Opcode.binary, Buffer.alloc(8)));
  assert.equal(r.end, true);
  assert.equal(r.out.length, 1);
  assert.equal(r.out[0]!.readUInt16BE(2), 1009);
  assert.equal(r.events[0]!.type, "error");
});

test("WsConnection: server-initiated close, then peer reply ends without a second close", () => {
  const c = new WsConnection();
  assert.deepEqual(c.close(1000, "done"), encodeClose(1000, "done"));
  assert.equal(c.close(), null);
  const r = c.receive(Buffer.concat([client(Opcode.text, Buffer.from("x")), client(Opcode.close, encodeClose(1000).subarray(2))]));
  assert.deepEqual(r.out, []);
  assert.deepEqual(
    r.events.map((e) => e.type),
    ["close"],
  );
  assert.equal(r.end, true);
});

// ---- client mode ----

test("client frames: encodeFrame with the RFC 5.7 key reproduces the masked 'Hello' bytes", () => {
  assert.deepEqual(encodeFrame(Opcode.text, Buffer.from("Hello"), true, MASK), Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]));
  assert.throws(() => encodeFrame(Opcode.text, Buffer.from("x"), true, Buffer.alloc(3)), /4 bytes/);
});

test("client frames: encodeMasked sets the mask bit, uses a random key, does not mutate the payload, and a server decoder reads it back", () => {
  const payload = Buffer.from("hello world");
  const a = encodeMasked(Opcode.text, payload);
  const b = encodeMasked(Opcode.text, payload);
  assert.equal(payload.toString(), "hello world");
  assert.ok((a[1]! & 0x80) !== 0);
  assert.notDeepEqual(a.subarray(2, 6), b.subarray(2, 6)); // 2^-32 flake bound
  assert.deepEqual(one(new FrameDecoder().push(a)), { type: "text", text: "hello world" });
  const big = Buffer.alloc(70_000, 7);
  const bigEv = one(new FrameDecoder().push(encodeMasked(Opcode.binary, big)));
  assert.equal(bigEv.type, "binary");
  sameBytes((bigEv as { data: Buffer }).data, big, "masked binary payload");
  assert.deepEqual(one(new FrameDecoder().push(encodeClientText("héllo"))), { type: "text", text: "héllo" });
});

test("client decoder accepts unmasked server frames and rejects masked ones; server decoder still rejects unmasked", () => {
  assert.deepEqual(one(new FrameDecoder({ role: "client" }).push(encodeText("hi"))), { type: "text", text: "hi" });
  const big = Buffer.alloc(300, 9);
  const bigEv = one(new FrameDecoder({ role: "client" }).push(encodeBinary(big)));
  assert.equal(bigEv.type, "binary");
  sameBytes((bigEv as { data: Buffer }).data, big, "unmasked binary payload");
  const bad = new FrameDecoder({ role: "client" }).push(encodeMasked(Opcode.text, Buffer.from("x")));
  assert.deepEqual(one(bad), { type: "error", code: 1002, reason: "server frame masked" });
  const srv = new FrameDecoder().push(encodeText("x"));
  assert.deepEqual(one(srv), { type: "error", code: 1002, reason: "client frame not masked" });
});

test("client WsConnection answers ping with a masked pong and closes with masked frames", () => {
  const c = new WsConnection({ role: "client" });
  const r = c.receive(encodePing(Buffer.from("p")));
  assert.equal(r.out.length, 1);
  assert.ok((r.out[0]![1]! & 0x80) !== 0);
  assert.deepEqual(one(new FrameDecoder().push(r.out[0]!)), { type: "pong", data: Buffer.from("p") });
  const close = c.close(1000);
  assert.ok(close && (close[1]! & 0x80) !== 0);
  assert.deepEqual(one(new FrameDecoder().push(close)), { type: "close", code: 1000, reason: "" });
  const e = new WsConnection({ role: "client" }).receive(encodeMasked(Opcode.text, Buffer.from("x")));
  assert.equal(e.end, true);
  assert.ok((e.out[0]![1]! & 0x80) !== 0); // the 1002 close is masked too
});

test("client handshake request carries the key and no Origin; rejects CR/LF injection", () => {
  const { request, key } = clientHandshakeRequest({ path: "/devtools/page/AB12", host: "127.0.0.1:9222" });
  assert.match(request, /^GET \/devtools\/page\/AB12 HTTP\/1\.1\r\nHost: 127\.0\.0\.1:9222\r\n/);
  assert.ok(request.endsWith("\r\n\r\n"));
  assert.ok(!/origin/i.test(request));
  assert.match(request, new RegExp(`Sec-WebSocket-Key: ${key.replace(/[+/=]/g, "\\$&")}\r\n`));
  assert.equal(Buffer.from(key, "base64").length, 16);
  assert.throws(() => clientHandshakeRequest({ path: "/a\r\nX: y", host: "h" }), RangeError);
  assert.throws(() => clientHandshakeRequest({ path: "/a b", host: "h" }), RangeError);
});

test("parseHandshakeResponse: verifies accept, splits trailing bytes, waits for more, rejects defects", () => {
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const good = Buffer.concat([Buffer.from(handshakeResponse(key)), Buffer.from([0x81, 0x00])]);
  const ok = parseHandshakeResponse(good, key);
  assert.equal(ok.state, "ok");
  if (ok.state === "ok") assert.deepEqual(ok.rest, Buffer.from([0x81, 0x00]));
  assert.deepEqual(parseHandshakeResponse(good.subarray(0, 20), key), { state: "need-more" });
  const other = parseHandshakeResponse(Buffer.from(handshakeResponse("AAAAAAAAAAAAAAAAAAAAAA==")), key);
  assert.deepEqual(other, { state: "bad", reason: "Sec-WebSocket-Accept does not match the key" });
  const notUpgrade = parseHandshakeResponse(Buffer.from("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n"), key);
  assert.equal(notUpgrade.state, "bad");
  assert.equal(parseHandshakeResponse(Buffer.from("HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: x\r\n\r\n"), key).state, "bad");
  assert.equal(parseHandshakeResponse(Buffer.alloc(9000, 97), key).state, "bad"); // unbounded head
});

/** A text message of `parts` frames: one text start, then empty continuations, the last with FIN. `fin` false leaves the last one open. */
function fragmented(role: "server" | "client", parts: number, fin: boolean): Buffer[] {
  const make = (opcode: number, f: boolean): Buffer => (role === "server" ? client(opcode, new Uint8Array(0), f) : encodeFrame(opcode, new Uint8Array(0), f));
  const frames = [make(Opcode.text, false)];
  for (let i = 1; i < parts; i++) frames.push(make(Opcode.continuation, i === parts - 1 ? fin : false));
  return frames;
}

for (const role of ["server", "client"] as const) {
  test(`fragment cap (${role}): more than MAX_FRAGMENTS empty parts yield 1009`, () => {
    const d = new FrameDecoder({ role });
    const events = fragmented(role, MAX_FRAGMENTS + 1, false).flatMap((f) => d.push(f));
    const ev = one(events);
    assert.equal(ev.type, "error");
    assert.equal((ev as { code: number }).code, 1009);
    assert.equal((ev as { reason: string }).reason, "message has too many fragments");
    assert.equal(d.dead, true);
  });

  test(`fragment cap (${role}): exactly MAX_FRAGMENTS parts still decodes`, () => {
    const d = new FrameDecoder({ role });
    const events = fragmented(role, MAX_FRAGMENTS, true).flatMap((f) => d.push(f));
    assert.deepEqual(one(events), { type: "text", text: "" });
  });
}
