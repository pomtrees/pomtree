// A minimal raw websocket client for the Docker-gated browser-stream test: the daemon's websocket.ts is a server, and the test must
// not borrow production framing to check it. Server frames are unmasked; client frames (close only) are masked per RFC 6455.
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export interface WsMessage {
  opcode: number;
  payload: Buffer;
}

export const WS_OPCODE = { text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

// Splits `buf` into complete messages (continuation frames joined) and the unconsumed rest. Control frames pass through as messages.
export function parseServerFrames(buf: Buffer): { messages: WsMessage[]; rest: Buffer } {
  const messages: WsMessage[] = [];
  let pending: { opcode: number; parts: Buffer[] } | undefined;
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const b0 = buf[at]!;
    const b1 = buf[at + 1]!;
    let len = b1 & 0x7f;
    let off = at + 2;
    if (len === 126) {
      if (buf.length < off + 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    if (buf.length < off + len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    at = off + len;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if (opcode >= 8) messages.push({ opcode, payload });
    else if (opcode === 0) {
      if (!pending) throw new Error("websocket continuation frame with nothing to continue");
      pending.parts.push(payload);
      if (fin) {
        messages.push({ opcode: pending.opcode, payload: Buffer.concat(pending.parts) });
        pending = undefined;
      }
    } else if (fin) messages.push({ opcode, payload });
    else pending = { opcode, parts: [payload] };
  }
  return { messages, rest: Buffer.from(buf.subarray(at)) };
}

export interface BrowserWs {
  // The HTTP response head ("HTTP/1.1 101 ..." and headers); the socket is closed after a refusal.
  head: string;
  messages: WsMessage[];
  closed: Promise<void>;
  close(): void;
}

export function browserWsConnect(port: number, path: string, headers: Record<string, string>): Promise<BrowserWs> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, "127.0.0.1");
    const messages: WsMessage[] = [];
    let buf: Buffer = Buffer.alloc(0);
    let headDone = false;
    const key = randomBytes(16).toString("base64");
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    const ws: BrowserWs = {
      head: "",
      messages,
      closed,
      close() {
        // A masked close frame with status 1000, then the socket.
        const mask = randomBytes(4);
        const body = Buffer.from([0x03, 0xe8]);
        socket.write(Buffer.concat([Buffer.from([0x88, 0x82]), mask, Buffer.from(body.map((b, i) => b ^ mask[i % 4]!))]));
        socket.end();
      },
    };
    socket.once("error", (e) => {
      if (!headDone) reject(new Error(`websocket connect to 127.0.0.1:${port}${path} failed: ${e.message}; is pomtreed's UI endpoint listening?`));
    });
    socket.on("connect", () => {
      const h = {
        host: `127.0.0.1:${port}`,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
        ...headers,
      };
      socket.write(
        `GET ${path} HTTP/1.1\r\n${Object.entries(h)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
    });
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!headDone) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        ws.head = buf.subarray(0, i).toString();
        buf = buf.subarray(i + 4);
        headDone = true;
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        if (ws.head.startsWith("HTTP/1.1 101") && !ws.head.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
          socket.destroy();
          reject(new Error(`websocket handshake returned a wrong Sec-WebSocket-Accept: ${ws.head}`));
          return;
        }
        resolve(ws);
      }
      const parsed = parseServerFrames(buf);
      buf = parsed.rest;
      messages.push(...parsed.messages);
    });
  });
}

// Polls `messages` until `pick` finds one, or fails after `ms` with `what` and the message kinds seen so far.
export async function waitForMessage(ws: BrowserWs, what: string, pick: (m: WsMessage) => boolean, ms: number): Promise<WsMessage> {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 100))) {
    const hit = ws.messages.find(pick);
    if (hit) return hit;
    if (Date.now() > end)
      throw new Error(
        `no ${what} within ${ms} ms; saw ${ws.messages.map((m) => `${m.opcode === WS_OPCODE.binary ? "bin" : "txt"}:${m.payload.subarray(0, 120).toString("latin1")}`).join(" | ") || "nothing"}`,
      );
  }
}
