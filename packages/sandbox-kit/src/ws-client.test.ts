import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type TLSSocket, createServer as createTlsServer, type Server } from "node:tls";
import { test } from "node:test";
import { createRequest } from "./request.ts";
import { Opcode, ServerFrameDecoder, type WsClient, type WsMessage, acceptKey, connectWebSocket, encodeClientFrame } from "./ws-client.ts";

// ---- throwaway certificates, generated per run (no external tool, nothing checked in) ----

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [a * 40 + b];
  for (let v of rest) {
    const chunk = [v & 0x7f];
    for (v >>= 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const utc = (d: Date): Buffer => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`));
const name = (cn: string): Buffer => der(0x30, der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from(cn)))));

function selfSigned(cn: string): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sigAlg = der(0x30, oid("1.2.840.10045.4.3.2"));
  const san = der(0x30, der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1])));
  const ext = (id: string, value: Buffer, critical = false) => der(0x30, oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    sigAlg,
    name(cn),
    der(0x30, utc(new Date(Date.now() - 3_600_000)), utc(new Date(Date.now() + 86_400_000))),
    name(cn),
    Buffer.from(publicKey.export({ type: "spki", format: "der" })),
    der(0xa3, der(0x30, ext("2.5.29.17", san), ext("2.5.29.19", der(0x30, der(0x01, Buffer.from([0xff]))), true))),
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = der(0x30, tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

// ---- a minimal server-side peer over TLS that speaks just enough of RFC 6455 ----

const serverFrame = (opcode: number, payload: Uint8Array, fin = true): Buffer => {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n <= 0xffff ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (n < 126) head[1] = n;
  else if (n <= 0xffff) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
};

interface Peer {
  port: number;
  raw: Buffer[]; // every byte received after the handshake
  clientCert: string[]; // subject CN of the presented client certificate, one per connection
  sockets: Set<TLSSocket>;
  onConnect: (socket: TLSSocket) => void;
  tamperAccept: boolean;
  echoClose: boolean;
  halfOpen: boolean;
  handshakeExtra: string;
  server: Server;
}

const server = selfSigned("localhost");
const client = selfSigned("pomtree-client");

// Walks the masked client frames in one chunk (small frames, aligned to the chunk start) looking for a close.
function hasClose(chunk: Buffer): boolean {
  for (let i = 0; i + 6 <= chunk.length; ) {
    if ((chunk[i]! & 0x0f) === Opcode.close) return true;
    i += 6 + (chunk[i + 1]! & 0x7f);
  }
  return false;
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condition not reached in time");
}

async function startPeer(onConnect: Peer["onConnect"] = () => {}, tamperAccept = false): Promise<Peer> {
  const peer: Peer = {
    port: 0,
    raw: [],
    clientCert: [],
    sockets: new Set(),
    onConnect,
    tamperAccept,
    echoClose: true,
    halfOpen: false,
    handshakeExtra: "",
    server: undefined as unknown as Server,
  };
  peer.server = createTlsServer({ cert: server.cert, key: server.key, ca: [client.cert], requestCert: true, rejectUnauthorized: true }, (socket) => {
    peer.sockets.add(socket);
    socket.allowHalfOpen = peer.halfOpen;
    peer.clientCert.push((socket.getPeerCertificate().subject as { CN?: string } | undefined)?.CN ?? "");
    let head = Buffer.alloc(0);
    let upgraded = false;
    socket.on("error", () => {});
    socket.on("close", () => peer.sockets.delete(socket));
    socket.on("data", (chunk) => {
      if (upgraded) {
        peer.raw.push(chunk);
        if (peer.echoClose && hasClose(chunk)) socket.write(serverFrame(Opcode.close, Buffer.from([0x03, 0xe8])));
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const key = /sec-websocket-key: (.+)\r\n/i.exec(head.toString())?.[1]?.trim() ?? "";
      upgraded = true;
      const accept = peer.tamperAccept ? acceptKey("wrong") : acceptKey(key);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${peer.handshakeExtra}\r\n`,
      );
      const rest = head.subarray(end + 4);
      if (rest.length) peer.raw.push(Buffer.from(rest));
      peer.onConnect(socket);
    });
  });
  await new Promise<void>((resolve) => peer.server.listen(0, "127.0.0.1", resolve));
  peer.port = (peer.server.address() as AddressInfo).port;
  return peer;
}

async function stopPeer(peer: Peer): Promise<void> {
  for (const s of peer.sockets) s.destroy();
  await new Promise<void>((resolve) => peer.server.close(() => resolve()));
}

const request = createRequest();
const tls = { ca: server.cert, cert: client.cert, key: client.key };
const open = (peer: Peer, extra: Partial<Parameters<typeof connectWebSocket>[1]> = {}) =>
  connectWebSocket(`wss://localhost:${peer.port}/exec`, { request, tls, closeTimeoutMs: 1000, ...extra });

async function collect(c: WsClient, n: number): Promise<WsMessage[]> {
  const out: WsMessage[] = [];
  for await (const m of c) {
    out.push(m);
    if (out.length === n) break;
  }
  return out;
}

test("ws-client: wss loopback with a per-call CA and a client certificate, text and binary round trip", async () => {
  const peer = await startPeer((s) => {
    s.write(serverFrame(Opcode.text, Buffer.from("hello")));
    s.write(serverFrame(Opcode.binary, Buffer.from([1, 2, 3])));
  });
  try {
    const c = await open(peer);
    const got = await collect(c, 2);
    assert.deepEqual(got[0], { type: "text", text: "hello" });
    assert.deepEqual([...(got[1] as { data: Uint8Array }).data], [1, 2, 3]);
    assert.deepEqual(peer.clientCert, ["pomtree-client"], "the server saw the client certificate");
    await c.close();
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client NEG: without the per-call CA the handshake is refused with a cause and an action, not trusted silently", async () => {
  const peer = await startPeer();
  try {
    await assert.rejects(
      connectWebSocket(`wss://localhost:${peer.port}/`, { request, tls: { cert: client.cert, key: client.key } }),
      /Check the endpoint address, network reachability and TLS settings/,
    );
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: a 70,001-byte message arrives intact when the server fragments it with a ping in between", async () => {
  const big = Buffer.alloc(70_001);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const peer = await startPeer((s) => {
    s.write(serverFrame(Opcode.binary, big.subarray(0, 30_000), false));
    s.write(serverFrame(Opcode.ping, Buffer.from("p")));
    s.write(serverFrame(Opcode.continuation, big.subarray(30_000, 60_000), false));
    s.write(serverFrame(Opcode.continuation, big.subarray(60_000)));
  });
  try {
    const c = await open(peer);
    const [m] = await collect(c, 1);
    assert.equal(m?.type, "binary");
    const data = (m as { data: Uint8Array }).data;
    assert.equal(data.length, 70_001);
    assert.ok(Buffer.from(data).equals(big));
    await c.close();
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: a bad Sec-WebSocket-Accept is refused with the cause and the action, and the socket is released", async () => {
  const peer = await startPeer(() => {}, true);
  try {
    await assert.rejects(open(peer), /wrong Sec-WebSocket-Accept.*check the endpoint address and any intermediary/s);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client NEG: a non-101 answer is refused with the status", async () => {
  const peer = await startPeer();
  peer.server.removeAllListeners("secureConnection");
  peer.server.on("secureConnection", (s: TLSSocket) => {
    s.on("error", () => {});
    s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  });
  try {
    await assert.rejects(open(peer), /refused with HTTP 403.*check the credential/s);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: a frame over the frame limit is refused (close 1009) before it is buffered, with cause and action", async () => {
  const peer = await startPeer((s) => s.write(serverFrame(Opcode.binary, Buffer.alloc(2_000))));
  try {
    const c = await open(peer, { maxFrameBytes: 1_000 });
    await assert.rejects(collect(c, 1), /2000 bytes exceeds the 1000-byte frame limit.*raise the size limits/s);
    const closed = await c.closed;
    assert.equal(closed.clean, false);
    assert.equal(closed.code, 1009);
    await waitFor(() => Buffer.concat(peer.raw).length >= 8);
    const sent = Buffer.concat(peer.raw);
    assert.equal(sent[0], 0x88, "a close frame was sent");
    assert.equal(Buffer.from(sent.subarray(6, 8).map((b, i) => b ^ sent[2 + (i & 3)]!)).readUInt16BE(0), 1009);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: a fragmented message over the message limit is refused", async () => {
  const peer = await startPeer((s) => {
    s.write(serverFrame(Opcode.binary, Buffer.alloc(600), false));
    s.write(serverFrame(Opcode.continuation, Buffer.alloc(600)));
  });
  try {
    const c = await open(peer, { maxMessageBytes: 1_000 });
    await assert.rejects(collect(c, 1), /1000-byte message limit/);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: client frames are masked (mask bit set, wire bytes differ from the payload) and unmask to the payload", async () => {
  const peer = await startPeer();
  try {
    const c = await open(peer);
    await c.send("secret-payload");
    await c.ping(Buffer.from("x"));
    await c.close(1000, "bye");
    await waitFor(() => Buffer.concat(peer.raw).length >= 6 + 14 + 6 + 1 + 6 + 5);
    const raw = Buffer.concat(peer.raw);
    assert.equal(raw[0], 0x81);
    assert.ok((raw[1]! & 0x80) !== 0, "mask bit set on the text frame");
    const len = raw[1]! & 0x7f;
    const mask = raw.subarray(2, 6);
    const wire = raw.subarray(6, 6 + len);
    assert.notEqual(wire.toString(), "secret-payload");
    assert.equal(Buffer.from(wire.map((b, i) => b ^ mask[i & 3]!)).toString(), "secret-payload");
    const second = raw.subarray(6 + len);
    assert.equal(second[0], 0x89, "ping");
    assert.ok((second[1]! & 0x80) !== 0);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: encodeClientFrame masks every frame size class and round-trips through an unmasking check", () => {
  for (const n of [0, 125, 126, 65_535, 65_536]) {
    const payload = Buffer.alloc(n, 0xab);
    const f = encodeClientFrame(Opcode.binary, payload, Buffer.from([1, 2, 3, 4]));
    const l7 = f[1]! & 0x7f;
    const off = l7 < 126 ? 2 : l7 === 126 ? 4 : 10;
    assert.ok((f[1]! & 0x80) !== 0);
    const body = f.subarray(off + 4).map((b, i) => b ^ [1, 2, 3, 4][i & 3]!);
    assert.equal(Buffer.from(body).equals(payload), true, `size ${n}`);
  }
  assert.throws(() => encodeClientFrame(Opcode.text, Buffer.alloc(1), Buffer.alloc(3)), /exactly 4 bytes/);
});

test("ws-client: a server ping is answered with a masked pong carrying the same payload", async () => {
  const peer = await startPeer((s) => s.write(serverFrame(Opcode.ping, Buffer.from("beat"))));
  try {
    const c = await open(peer);
    for (let i = 0; i < 100 && Buffer.concat(peer.raw).length < 10; i++) await new Promise((r) => setTimeout(r, 10));
    const raw = Buffer.concat(peer.raw);
    assert.equal(raw[0], 0x8a);
    assert.ok((raw[1]! & 0x80) !== 0);
    assert.equal(Buffer.from(raw.subarray(6, 10).map((b, i) => b ^ raw[2 + (i & 3)]!)).toString(), "beat");
    await c.close();
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: the close handshake completes in both directions and the iterator ends cleanly", async () => {
  // client-initiated
  const a = await startPeer();
  try {
    const c = await open(a);
    const res = await c.close(1000, "done");
    assert.deepEqual(res, { code: 1000, reason: "", clean: true });
    assert.equal((await c[Symbol.asyncIterator]().next()).done, true);
  } finally {
    await stopPeer(a);
  }
  // server-initiated: the client echoes the close
  const b = await startPeer((s) => s.write(serverFrame(Opcode.close, Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from("going")]))));
  try {
    const c = await open(b);
    const res = await c.closed;
    assert.deepEqual(res, { code: 1001, reason: "going", clean: true });
    assert.equal(Buffer.concat(b.raw)[0], 0x88, "the close was echoed");
  } finally {
    await stopPeer(b);
  }
});

test("ws-client NEG: a connection dropped without a close frame rejects the reader, never reads as a clean end", async () => {
  const peer = await startPeer((s) => {
    s.write(serverFrame(Opcode.text, Buffer.from("partial")));
    setTimeout(() => s.destroy(), 20);
  });
  try {
    const c = await open(peer);
    const it = c[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: { type: "text", text: "partial" }, done: false });
    await assert.rejects(it.next(), /without a close frame.*reconnect/s);
    assert.equal((await c.closed).clean, false);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: close() without a server reply destroys the socket after closeTimeoutMs", async () => {
  const peer = await startPeer();
  peer.echoClose = false;
  try {
    const c = await open(peer, { closeTimeoutMs: 50 });
    const res = await c.close();
    assert.equal(res.clean, false);
    assert.equal(res.code, 1006);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: the decoder rejects masked, reserved-bit and orphan-continuation server frames", () => {
  const masked = new ServerFrameDecoder().push(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0]));
  assert.deepEqual(masked[0], { type: "error", code: 1002, reason: "server frame is masked, which RFC 6455 forbids" });
  assert.equal(new ServerFrameDecoder().push(Buffer.from([0xc1, 0x00]))[0]?.type, "error");
  assert.equal(new ServerFrameDecoder().push(Buffer.from([0x80, 0x00]))[0]?.type, "error");
  const chunked = new ServerFrameDecoder();
  const frame = serverFrame(Opcode.text, Buffer.from("split"));
  const events = [...frame].flatMap((b) => chunked.push(Buffer.from([b])));
  assert.deepEqual(events, [{ type: "text", text: "split" }]);
});

test("ws-client: a text message and a close reason starting with U+FEFF keep it (no BOM stripping)", async () => {
  const peer = await startPeer((s) => {
    s.write(serverFrame(Opcode.text, Buffer.from("\uFEFFhello")));
    s.write(serverFrame(Opcode.close, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("\uFEFFwhy")])));
  });
  try {
    const c = await open(peer);
    const [m] = await collect(c, 1);
    assert.deepEqual(m, { type: "text", text: "\uFEFFhello" });
    assert.deepEqual(await c.closed, { code: 1000, reason: "\uFEFFwhy", clean: true });
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client NEG: close() refuses reserved or out-of-range codes with cause and action, and sends nothing", async () => {
  const peer = await startPeer();
  try {
    const c = await open(peer);
    for (const code of [1005, 1006, 1015, 999, 5000, 1004]) await assert.rejects(c.close(code), /cannot be sent.*use 1000 for a normal close/s, String(code));
    assert.equal(Buffer.concat(peer.raw).length, 0);
    assert.equal((await c.close(4000, "app")).clean, true);
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: a completed close handshake is clean even when the server keeps the TCP connection open", async () => {
  const peer = await startPeer();
  peer.halfOpen = true;
  try {
    const c = await open(peer, { closeTimeoutMs: 30_000 });
    const started = Date.now();
    assert.deepEqual(await c.close(1000, "done"), { code: 1000, reason: "", clean: true });
    assert.ok(Date.now() - started < 5_000, "finished on the server's close frame, not on a timer");
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client: after the server's close frame, a lingering TCP connection ends clean by timer", async () => {
  const peer = await startPeer((s) => s.write(serverFrame(Opcode.close, Buffer.from([0x03, 0xe8]))));
  peer.halfOpen = true;
  try {
    const c = await open(peer, { closeTimeoutMs: 50 });
    assert.deepEqual(await c.closed, { code: 1000, reason: "", clean: true });
  } finally {
    await stopPeer(peer);
  }
});

test("ws-client NEG: a 101 without Connection: Upgrade (Node itself declines the upgrade), or with an unrequested extension, is refused", async () => {
  const noConn = await startPeer();
  noConn.server.removeAllListeners("secureConnection");
  noConn.server.on("secureConnection", (s: TLSSocket) => {
    s.on("error", () => {});
    s.once("data", (d: Buffer) => {
      const key = /sec-websocket-key: (.+)\r\n/i.exec(d.toString())?.[1]?.trim() ?? "";
      s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    });
  });
  try {
    await assert.rejects(open(noConn), /refused with HTTP 101/);
  } finally {
    await stopPeer(noConn);
  }
  const ext = await startPeer();
  ext.handshakeExtra = "Sec-WebSocket-Extensions: permessage-deflate\r\n";
  try {
    await assert.rejects(open(ext), /enabled the extension "permessage-deflate".*did not request/s);
  } finally {
    await stopPeer(ext);
  }
});

test("ws-client NEG: a server that half-closes without a close frame surfaces as an error to the reader", async () => {
  const peer = await startPeer((s) => {
    s.write(serverFrame(Opcode.text, Buffer.from("partial")));
    setTimeout(() => s.end(), 20);
  });
  peer.halfOpen = true;
  try {
    const c = await open(peer);
    const it = c[Symbol.asyncIterator]();
    await it.next();
    await assert.rejects(it.next(), /without a close frame/);
    assert.equal((await c.closed).clean, false);
  } finally {
    await stopPeer(peer);
  }
});
