import assert from "node:assert/strict";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";
import { FrameDecoder, encodeFrame, encodeText, handshakeResponse, Opcode } from "./websocket.ts";
import type { AgentRecord } from "@pomtree/core";
import type { FakeByteStream, FakeSandbox } from "@pomtree/testing";
import { issueUiCookie } from "./auth.ts";
import { statusMessage, type BrowserRouteOpts } from "./browser-route.ts";
import { sanitizeText } from "./cdp-relay.ts";
import { makeServer } from "./server.ts";
import { SECRET, op, setup, spawnSpec, until } from "./test-setup.ts";

// ---- a websocket client that understands 16- and 64-bit lengths (JPEG frames are large) ----

const MASK = Buffer.from([1, 2, 3, 4]);
const clientFrame = (opcode: number, payload: Uint8Array): Buffer => encodeFrame(opcode, payload, true, MASK);

interface Frame {
  opcode: number;
  payload: Buffer;
}
interface Ws {
  socket: Socket;
  frames: Frame[];
  head: string;
  body: string;
  closed: Promise<void>;
  send(opcode: number, p: Uint8Array | string): void;
}

function wsConnect(port: number, path: string, headers: Record<string, string>): Promise<Ws> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const frames: Frame[] = [];
    let buf = Buffer.alloc(0);
    let head = "";
    let headDone = false;
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    const ws: Ws = {
      socket,
      frames,
      get head() {
        return head;
      },
      get body() {
        return buf.toString();
      },
      closed,
      send: (opcode, p) => socket.write(clientFrame(opcode, typeof p === "string" ? Buffer.from(p) : p)),
    } as Ws;
    socket.on("error", () => {});
    socket.on("connect", () => {
      const h = {
        host: `127.0.0.1:${port}`,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      };
      socket.write(
        `GET ${path} HTTP/1.1\r\n${Object.entries(h)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
    });
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headDone) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4);
        headDone = true;
        if (!head.startsWith("HTTP/1.1 101")) {
          socket.once("close", () => resolve(ws));
          return;
        }
        resolve(ws);
      }
      for (;;) {
        if (buf.length < 2) break;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) break;
        frames.push({ opcode: buf[0]! & 0x0f, payload: Buffer.from(buf.subarray(off, off + len)) });
        buf = buf.subarray(off + len);
      }
    });
  });
}

const status = (ws: Ws) => Number(/^HTTP\/1\.1 (\d+)/.exec(ws.head)?.[1]);
const texts = (ws: Ws) => ws.frames.filter((f) => f.opcode === Opcode.text).map((f) => JSON.parse(f.payload.toString()) as Record<string, unknown>);
const bins = (ws: Ws) => ws.frames.filter((f) => f.opcode === Opcode.binary).map((f) => f.payload);
// Never deepEqual Buffers: a failing diff over bytes grows superlinearly in Node 26. Report lengths and the first differing index only.
function sameBytes(actual: Uint8Array | undefined, expected: Uint8Array, msg: string): void {
  assert.ok(actual, `${msg}: no binary frame was received`);
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const e = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (Buffer.compare(a, e) === 0) return;
  let i = 0;
  while (i < a.length && i < e.length && a[i] === e[i]) i++;
  assert.ok(false, `${msg}: actual length ${a.length}, expected length ${e.length}, first difference at index ${i}`);
}
const jpeg = (n: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, n)]);

// ---- a scripted Chromium behind the FakeSandbox loopback facet ----

class FakeChrome {
  targets: unknown[] = [{ id: "AB12", type: "page", url: "https://example.test/", title: "Example" }];
  received: string[] = [];
  wsStreams: FakeByteStream[] = [];
  listCalls = 0;
  #seen = new Map<FakeByteStream, { n: number; phase: "http" | "ws"; buf: Buffer; dec: FrameDecoder }>();
  #timer: ReturnType<typeof setInterval>;
  readonly sb: FakeSandbox;
  readonly sid: string;
  constructor(sb: FakeSandbox, sid: string) {
    this.sb = sb;
    this.sid = sid;
    this.#timer = setInterval(() => this.#pump(), 2);
  }
  stop(): void {
    clearInterval(this.#timer);
  }
  emitFrame(data: Buffer, sessionId = 1): void {
    const msg = { method: "Page.screencastFrame", params: { data: data.toString("base64"), sessionId, metadata: { deviceWidth: 800, deviceHeight: 600 } } };
    for (const s of this.wsStreams) s.emit(encodeText(JSON.stringify(msg)));
  }
  #pump(): void {
    for (const s of this.sb.loopbackStreams.get(this.sid) ?? []) {
      let st = this.#seen.get(s);
      if (!st) {
        st = { n: 0, phase: "http", buf: Buffer.alloc(0), dec: new FrameDecoder({ role: "server" }) };
        this.#seen.set(s, st);
      }
      while (st.n < s.writes.length) {
        const w = s.writes[st.n++]!;
        if (st.phase === "http") {
          st.buf = Buffer.concat([st.buf, w]);
          if (!st.buf.includes("\r\n\r\n")) continue;
          const head = st.buf.toString();
          if (head.startsWith("GET /json/list ")) {
            this.listCalls++;
            const body = Buffer.from(JSON.stringify(this.targets));
            s.emit(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`), body]));
            s.end();
          } else {
            s.emit(Buffer.from(handshakeResponse(/Sec-WebSocket-Key: (\S+)/i.exec(head)![1]!)));
            st.phase = "ws";
            this.wsStreams.push(s);
          }
          continue;
        }
        for (const ev of st.dec.push(w)) if (ev.type === "text") this.received.push((JSON.parse(ev.text) as { method: string }).method);
      }
    }
  }
}

async function fixture(browser: BrowserRouteOpts = {}, restricted = false) {
  const t = setup(async () => {});
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: root.id,
    name: "a",
    task: "t",
    host: "h1",
    budgetMicros: 1_000,
    idempotencyKey: "k",
  });
  const running = await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: "k-run" });
  const h = await t.sandbox.start(
    { host: "host-test", generation: 0, agent: a.id, image: "i", env: {}, mounts: [{ kind: "workspace", workspace: "ws-test", containerPath: "/w" }] },
    "k-sb",
  );
  await t.daemon.deps.registry.setSandbox(a.id, running.generation, h.id, "k-set");
  const server: Server = makeServer(t.daemon, restricted, { browser: { pollMs: 20, aliveMs: 20, closeWaitMs: 100, ...browser } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const chrome = new FakeChrome(t.sandbox, h.id);
  const open = (extra: Record<string, string> = {}, path = `/v1/agents/${a.id}/browser`) =>
    wsConnect(port, path, { authorization: `Bearer ${op}`, origin: `http://127.0.0.1:${port}`, ...extra });
  const stop = () => {
    chrome.stop();
    server.closeAllConnections();
    server.close();
  };
  return { t, a: running as AgentRecord, h, server, port, chrome, open, sb: t.sandbox, stop };
}

test("browser ws: status then JPEG frames reach the viewer; only status/closed text and JPEG binary ever flow", async () => {
  const f = await fixture();
  try {
    const ws = await f.open();
    assert.equal(status(ws), 101);
    await until(() => f.chrome.wsStreams.length === 1);
    assert.equal(
      f.sb.loopbackCalls.every((c) => c.port === 9222),
      true,
    );
    await until(() => f.chrome.received.includes("Page.startScreencast"));
    f.chrome.emitFrame(jpeg(5));
    await until(() => bins(ws).length === 1);
    sameBytes(bins(ws)[0], jpeg(5), "first frame");
    for (const b of bins(ws)) assert.deepEqual([...b.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const ts = texts(ws);
    assert.deepEqual(ts[0], { type: "status", state: "connecting" });
    assert.deepEqual(ts.at(-1), { type: "status", state: "live", url: "https://example.test/", title: "Example", width: 800, height: 600 });
    for (const m of ts) assert.equal(m.type, "status");
    ws.socket.destroy();
  } finally {
    f.stop();
  }
});

test("browser ws: a joiner on an idle page gets the cached status and frame; the last leaver stops the screencast and closes streams", async () => {
  const f = await fixture();
  try {
    const w1 = await f.open();
    await until(() => f.chrome.wsStreams.length === 1);
    f.chrome.emitFrame(jpeg(9)); // a static page emits exactly one frame
    await until(() => bins(w1).length === 1);
    const w2 = await f.open();
    await until(() => bins(w2).length === 1);
    sameBytes(bins(w2)[0], jpeg(9), "replayed frame");
    assert.equal(texts(w2).at(-1)!.state, "live");
    assert.equal(f.chrome.wsStreams.length, 1); // one relay serves both
    w1.socket.destroy();
    await w1.closed;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(f.chrome.received.includes("Page.stopScreencast"), false);
    w2.socket.destroy();
    await until(() => f.chrome.received.includes("Page.stopScreencast"));
    await until(() => f.sb.loopbackStreams.get(f.h.id)!.every((s) => s.closes > 0));
    const opens = f.sb.loopbackCalls.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.sb.loopbackCalls.length, opens); // polling stopped with the last viewer
  } finally {
    f.stop();
  }
});

test("browser ws: any client text or binary message closes 1008; ping and close are fine", async () => {
  const f = await fixture();
  try {
    for (const [kind, op_, payload] of [
      ["text", Opcode.text, '{"cmd":"click"}'],
      ["binary", Opcode.binary, "x"],
    ] as const) {
      const ws = await f.open();
      assert.equal(status(ws), 101, kind);
      ws.send(op_, payload);
      await ws.closed;
      const close = ws.frames.find((fr) => fr.opcode === Opcode.close);
      assert.ok(close, kind);
      assert.equal(close.payload.readUInt16BE(0), 1008, kind);
    }
    const ok = await f.open();
    ok.send(Opcode.ping, "p");
    await until(() => ok.frames.some((fr) => fr.opcode === Opcode.pong));
    ok.socket.destroy();
    // nothing the viewer sent ever reached Chromium
    assert.equal(
      f.chrome.received.every((m) => ["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast"].includes(m)),
      true,
    );
  } finally {
    f.stop();
  }
});

test("browser ws: a client frame over 4096 bytes closes 1009 and a frame at the limit closes 1008 (it is data either way)", async () => {
  const f = await fixture();
  try {
    for (const [size, code] of [
      [4097, 1009],
      [4096, 1008],
    ] as const) {
      const ws = await f.open();
      assert.equal(status(ws), 101, String(size));
      ws.send(Opcode.binary, "x".repeat(size));
      await ws.closed;
      const close = ws.frames.find((fr) => fr.opcode === Opcode.close);
      assert.ok(close, String(size));
      assert.equal(close.payload.readUInt16BE(0), code, String(size));
    }
  } finally {
    f.stop();
  }
});

test("browser ws: the 9th viewer is refused 503 before the handshake; a freed slot admits again", async () => {
  const f = await fixture();
  try {
    const viewers: Ws[] = [];
    for (let i = 0; i < 8; i++) {
      const w = await f.open();
      assert.equal(status(w), 101);
      viewers.push(w);
    }
    const ninth = await f.open();
    assert.equal(status(ninth), 503);
    assert.ok(!ninth.head.includes("101"));
    viewers[0]!.socket.destroy();
    await viewers[0]!.closed;
    await until(async () => status(await f.open()) === 101);
    for (const v of viewers) v.socket.destroy();
  } finally {
    f.stop();
  }
});

test("browser ws: refusals (401/403/404/409) happen before upgrade and never open a loopback stream", async () => {
  const f = await fixture();
  try {
    assert.equal(status(await f.open({ authorization: "" })), 401);
    assert.equal(status(await f.open({ authorization: "Bearer garbage" })), 401);
    assert.equal(status(await f.open({ authorization: `Bearer ${f.t.daemon.agentToken(f.a.id, f.a.generation)}` })), 403);
    assert.equal(status(await f.open({ origin: "http://evil.example" })), 403);
    assert.equal(status(await wsConnect(f.port, `/v1/agents/${f.a.id}/browser`, { authorization: `Bearer ${op}` })), 403); // no Origin
    assert.equal(status(await f.open({}, "/v1/agents/nope/browser")), 404);
    const root = await f.t.daemon.root();
    const b = await f.t.daemon.deps.registry.create({
      spec: spawnSpec,
      parent: root.id,
      name: "b",
      task: "t",
      host: "h1",
      budgetMicros: 1,
      idempotencyKey: "kb",
    });
    assert.equal(status(await f.open({}, `/v1/agents/${b.id}/browser`)), 409);
    assert.equal(f.sb.loopbackCalls.length, 0);
    const ok = await f.open({ authorization: "", cookie: issueUiCookie(SECRET, 60_000) });
    assert.equal(status(ok), 101); // cookie auth with a matching Origin (negative control for the refusals above)
    ok.socket.destroy();
  } finally {
    f.stop();
  }
});

test("browser ws: a backend without the loopback facet is a 409 carrying the cause and action, not a 500 (negative control: a capable one upgrades)", async () => {
  const f = await fixture();
  try {
    const live = await f.open();
    assert.equal(status(live), 101);
    live.socket.destroy();
    for (const unsupported of [
      () => {
        f.sb.loopback = undefined; // declared but not provided: need() throws SandboxCapabilityError
      },
      () => {
        (f.sb.declaration.capabilities as Record<string, boolean>).loopback = false; // declared unsupported
      },
    ]) {
      unsupported();
      const calls = f.sb.loopbackCalls.length;
      const refused = await f.open();
      assert.equal(status(refused), 409);
      const body = JSON.parse(refused.body) as { error: string; state: string };
      assert.match(body.error, /this sandbox backend does not support the browser view \(fake provides no loopback facet\)/);
      assert.match(body.error, /use the Docker backend/);
      assert.equal(body.state, "running");
      assert.equal(f.sb.loopbackCalls.length, calls, "no loopback stream was opened");
    }
  } finally {
    f.stop();
  }
});

test("browser ws: restricted listeners answer 404", async () => {
  const f = await fixture({}, true);
  try {
    assert.equal(status(await f.open()), 404);
    assert.equal(f.sb.loopbackCalls.length, 0);
  } finally {
    f.stop();
  }
});

test("browser ws: no browser in the container reads no-browser; the agent exiting sends closed 'ended' then a close frame", async () => {
  const f = await fixture();
  try {
    f.chrome.targets = [];
    const ws = await f.open();
    await until(() => texts(ws).some((m) => m.state === "no-browser"));
    await f.t.daemon.deps.registry.transition(f.a.id, f.a.generation, "exited", { exit: "succeeded", idempotencyKey: "k-exit" });
    await ws.closed;
    assert.deepEqual(texts(ws).at(-1), { type: "closed", reason: "ended" });
    assert.ok(ws.frames.some((fr) => fr.opcode === Opcode.close));
  } finally {
    f.stop();
  }
});

test("browser ws: daemon shutdown (closeAllConnections) closes viewers with reason local", async () => {
  const f = await fixture();
  try {
    const ws = await f.open();
    await until(() => f.chrome.wsStreams.length === 1);
    f.server.closeAllConnections();
    await ws.closed;
    assert.deepEqual(texts(ws).at(-1), { type: "closed", reason: "local" });
    assert.ok(ws.frames.some((fr) => fr.opcode === Opcode.close));
  } finally {
    f.chrome.stop();
    f.server.close();
  }
});

test("statusMessage: copies only known fields and stays under 4 KiB at the worst-case url/title", () => {
  const worst = { state: "live" as const, url: '"'.repeat(512), title: "€".repeat(512), width: 16384, height: 16384 };
  assert.ok(Buffer.byteLength(statusMessage(worst)) <= 4096, String(Buffer.byteLength(statusMessage(worst))));
  const hostile = { state: "live", url: "u", extra: { cdp: 1 }, secret: "x" } as unknown as Parameters<typeof statusMessage>[0];
  assert.deepEqual(JSON.parse(statusMessage(hostile)), { type: "status", state: "live", url: "u" });
});

test("browser ws: after a policy close, further inbound chunks do not re-arm the destroy timer", async () => {
  const closeWaitMs = 4321; // distinctive, so only this route's destroy timers are counted
  const f = await fixture({ closeWaitMs });
  const realSetTimeout = globalThis.setTimeout;
  let armed = 0;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === closeWaitMs) armed++;
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout;
  try {
    const ws = await f.open();
    assert.equal(status(ws), 101);
    ws.socket.allowHalfOpen = true; // keep our side open after the server's FIN so later chunks still reach it
    ws.send(Opcode.text, "x");
    await until(() => armed >= 1);
    ws.send(Opcode.close, Buffer.from([0x03, 0xe8])); // the peer's close: later chunks all report end
    for (let i = 0; i < 5; i++) {
      ws.send(Opcode.ping, "p"); // separate chunks, each of which used to re-arm the timer
      await new Promise<void>((r) => realSetTimeout(r, 10));
    }
    assert.equal(armed, 1);
    ws.socket.destroy();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    f.stop();
  }
});

test("worst-case status message: hostile url and title stay within 4096 bytes of UTF-8", () => {
  const lone = "\ud800".repeat(600); // 6 bytes each if JSON escaped them
  const wide = "\u4e00".repeat(600); // 3 bytes each, kept
  const quotes = '"'.repeat(600); // 2 bytes each once escaped, kept
  for (const [url, title] of [
    [lone, lone],
    [wide, wide],
    [quotes, quotes],
    [lone + wide, quotes + lone],
  ] as const) {
    const msg = statusMessage({ state: "live", url: sanitizeText(url), title: sanitizeText(title), width: 1920, height: 1080 });
    assert.ok(Buffer.byteLength(msg, "utf8") <= 4096, `${Buffer.byteLength(msg, "utf8")} bytes`);
  }
});
