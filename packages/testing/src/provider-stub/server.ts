import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse, STATUS_CODES } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { type FaultName, FaultPlan } from "./faults.ts";
import type { Fixture, StreamStep } from "./fixture-loader.ts";
import { type ModelOutcome, type ModelRequest, ProviderModel, type RecordedRequest, type ResourceSpec } from "./model.ts";

// Thin node:http shell over the pure ProviderModel: a loopback hosted-provider on 127.0.0.1 for adapter tests. It answers plain HTTP and the HTTP
// `upgrade` (a WebSocket, RFC 6455, spoken here over node:http and node:net so @pomtree/testing stays dependency-free). An adapter's base URL is
// `baseUrl`; a websocket URL is `wsUrl(path)`.

/** Default cap on request bodies and websocket messages; above it a request is refused with 413 (a runaway upload is a test bug). */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** After the script ends the server waits this long for the client's close reply before dropping the socket. */
const CLOSE_GRACE_MS = 2000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = { cont: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : Buffer.alloc(10);
  if (n >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

interface ClientFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** A websocket protocol violation: `code` is the close code to answer with. */
class WsError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Incremental client-frame parser. Throws `WsError` on a protocol violation (unmasked frame, reserved bits, bad control frame, oversize). */
class ClientFrameReader {
  #buf = Buffer.alloc(0);
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  push(chunk: Buffer): ClientFrame[] {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const out: ClientFrame[] = [];
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return out;
      const b0 = b[0]!;
      const b1 = b[1]!;
      if ((b0 & 0x70) !== 0) throw new WsError(1002, "client frame sets reserved bits (no extension was negotiated)");
      if ((b1 & 0x80) === 0) throw new WsError(1002, "client frame is not masked, which RFC 6455 requires of a client");
      if ((b0 & 0x0f) >= 8 && ((b0 & 0x80) === 0 || (b1 & 0x7f) > 125))
        throw new WsError(1002, "client control frame is fragmented or longer than 125 bytes, which RFC 6455 forbids");
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return out;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return out;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.#max)) throw new WsError(1009, "client frame is larger than the stub accepts");
        len = Number(big);
        off = 10;
      }
      if (len > this.#max) throw new WsError(1009, "client frame is larger than the stub accepts");
      if (b.length < off + 4 + len) return out;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      out.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
      this.#buf = b.subarray(off + 4 + len);
    }
  }
}

const closeFrame = (code: number, reason = ""): Buffer => encodeFrame(OP.close, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]));
const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}...` : s);

export interface ProviderStubOptions {
  readonly fixture?: Fixture;
  readonly resources?: readonly ResourceSpec[];
  /** Faults armed for the whole run (use `server.faults.arm` for counted or filtered ones). */
  readonly faults?: readonly FaultName[];
  /** Header names (any case; names only, never values) every request must carry, or it is unmatched: an adapter that drops Authorization must not still match. */
  readonly requireHeaderNames?: readonly string[];
  /** Cap on a request body and on a websocket message in bytes (default 16 MiB). */
  readonly maxBodyBytes?: number;
}

export class ProviderStub {
  readonly model: ProviderModel;
  readonly faults: FaultPlan;
  readonly baseUrl: string;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #open = new Set<ServerResponse>();
  readonly #maxBytes: number;
  #closed = false;

  private constructor(model: ProviderModel, faults: FaultPlan, server: Server, port: number, maxBytes: number) {
    this.#maxBytes = maxBytes;
    this.model = model;
    this.faults = faults;
    this.#server = server;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** Binds 127.0.0.1 on an ephemeral port. Call `close()` when done (idempotent). */
  static async start(opts: ProviderStubOptions = {}): Promise<ProviderStub> {
    const faults = new FaultPlan();
    for (const f of opts.faults ?? []) faults.arm(f, { times: Number.POSITIVE_INFINITY });
    const model = new ProviderModel({ fixture: opts.fixture, resources: opts.resources, faults, requireHeaderNames: opts.requireHeaderNames });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const stub = new ProviderStub(model, faults, server, (server.address() as AddressInfo).port, opts.maxBodyBytes ?? DEFAULT_MAX_BYTES);
    server.on("connection", (s) => {
      stub.#sockets.add(s);
      s.on("close", () => stub.#sockets.delete(s));
    });
    server.on("request", (req, res) => {
      stub.#onRequest(req, res).catch((e) => stub.#failed(req, res, e));
    });
    server.on("upgrade", (req, socket, head) => {
      try {
        stub.#onUpgrade(req, socket as Socket, head);
      } catch (e) {
        stub.#failed(req, undefined, e);
        socket.destroy();
      }
    });
    return stub;
  }

  /** `ws://` URL of `path` on this stub. */
  wsUrl(path: string): string {
    return `ws://127.0.0.1:${new URL(this.baseUrl).port}${path}`;
  }

  /** Every request received so far, in order. */
  requests(): readonly RecordedRequest[] {
    return this.model.requests;
  }

  /** Fails (AssertionError naming every offender and the action) when any request or stream step matched nothing. Call at the end of each test. */
  assertNoUnmatched(): void {
    const u = this.model.unmatched;
    assert.equal(
      u.length,
      0,
      `provider stub received ${u.length} unmatched request(s); each got an error response, never a default:\n${u.map((x) => `  #${x.index} ${x.reason}`).join("\n")}\nfix the adapter's request or add the exchange to the fixture`,
    );
  }

  /** Fails when fixture entries were never requested (the adapter skipped an exchange the fixture says it makes). */
  assertFixtureConsumed(): void {
    const left = this.model.remaining();
    assert.equal(
      left.length,
      0,
      `fixture entries never requested: ${left.map((e) => `seq ${e.seq} ${e.method} ${e.path}`).join("; ")}; the adapter did not make these calls`,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const r of this.#open) r.destroy();
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #request(req: IncomingMessage, rawBody: string, upgrade: boolean): ModelRequest {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) {
      const vs = query[k] ?? [];
      vs.push(v);
      query[k] = vs;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
    return { method: (req.method ?? "GET").toUpperCase(), path: url.pathname, query, headers, rawBody, upgrade };
  }

  /** A request that errored in the stub (client abort mid-body, a bug here) is recorded as unmatched with the cause; never an unhandled rejection. */
  #failed(req: IncomingMessage, res: ServerResponse | undefined, e: unknown): void {
    const why = (e as Error)?.message ?? String(e);
    this.model.reject(
      this.#request(req, "", false),
      `the request failed before it could be answered (${why}); the client may have aborted mid-body, otherwise report this as a stub bug`,
    );
    if (res !== undefined && !res.headersSent && !res.destroyed) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "provider-stub-failed", message: `the stub could not process the request: ${why}` }));
    } else res?.destroy();
  }

  async #onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.#open.add(res);
    res.on("close", () => this.#open.delete(res));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > this.#maxBytes) {
        const message = `request body exceeds ${this.#maxBytes} bytes; send less`;
        this.model.reject(this.#request(req, "", false), message);
        res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "too-large", message }));
        return;
      }
      chunks.push(c as Buffer);
    }
    if (this.#closed) return;
    const out = this.model.handle(this.#request(req, Buffer.concat(chunks).toString("utf8"), false));
    this.#reply(res, out);
  }

  #reply(res: ServerResponse, out: ModelOutcome): void {
    switch (out.kind) {
      case "hang":
        return; // never answered; close() destroys the socket
      case "unmatched":
        res.writeHead(501, { "content-type": "application/json" }).end(JSON.stringify({ error: "provider-stub-unmatched", message: out.reason }));
        return;
      case "upgrade":
        res
          .writeHead(426, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "upgrade-required", message: "this exchange is a websocket; connect with an Upgrade: websocket request" }));
        return;
      case "respond":
        res.writeHead(out.status, out.headers).end(out.body);
    }
  }

  #onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const key = req.headers["sec-websocket-key"];
    const refuse = (status: string, why: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
    };
    const isWs =
      req.headers.upgrade?.toLowerCase() === "websocket" &&
      typeof key === "string" &&
      Buffer.from(key, "base64").length === 16 &&
      req.headers["sec-websocket-version"] === "13";
    if (!isWs) {
      const why = "not a websocket handshake: send Upgrade: websocket, Sec-WebSocket-Version: 13 and a Sec-WebSocket-Key of 16 random bytes in base64";
      this.model.reject(this.#request(req, "", false), why);
      refuse("400 Bad Request", why);
      return;
    }
    const out = this.model.handle(this.#request(req, "", true));
    if (out.kind === "hang") return;
    if (out.kind === "unmatched") {
      refuse("501 Not Implemented", out.reason);
      return;
    }
    if (out.kind === "respond") {
      // A fault (429, 5xx after apply) answers the handshake itself: write the model's real status, headers and body.
      const lines = Object.entries({ ...out.headers, "content-length": String(Buffer.byteLength(out.body)), connection: "close" }).map(
        ([k, v]) => `${k}: ${v}\r\n`,
      );
      socket.end(`HTTP/1.1 ${out.status} ${STATUS_CODES[out.status] ?? "Status"}\r\n${lines.join("")}\r\n${out.body}`);
      return;
    }
    if (out.kind !== "upgrade") {
      refuse("426 Upgrade Required", "this path is a plain HTTP exchange, not a websocket");
      return;
    }
    const offered = (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const chosen = out.headers["sec-websocket-protocol"];
    if (chosen !== undefined && !offered.includes(chosen)) {
      this.model.unmatched.push({
        index: this.model.requests.length - 1,
        reason: `upgrade ${req.url}: the fixture selects subprotocol "${chosen}" but the client offered [${offered.join(", ")}]; offer it`,
      });
      refuse("400 Bad Request", `subprotocol "${chosen}" not offered`);
      return;
    }
    const accept = createHash("sha1")
      .update((key as string) + WS_GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${chosen === undefined ? "" : `Sec-WebSocket-Protocol: ${chosen}\r\n`}\r\n`,
    );
    this.#runStream(socket, out.steps, req.url ?? "", head);
  }

  /** Plays the fixture's frame script on an upgraded socket: send `out` steps, wait for `in` steps, handle ping/close and fragmentation. */
  #runStream(socket: Socket, steps: readonly StreamStep[], url: string, head: Buffer): void {
    const reader = new ClientFrameReader(this.#maxBytes);
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let msgBytes = 0;
    let pos = 0;
    let message: { binary: boolean; parts: Buffer[] } | undefined;
    let ended = false;
    const bug = (reason: string, code: number) => {
      this.model.unmatched.push({ index: this.model.requests.length - 1, reason: `upgrade ${url}: ${reason}` });
      finish(code, reason);
    };
    const finish = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      socket.write(closeFrame(code, clip(reason)));
      const t = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
      t.unref();
      socket.once("close", () => clearTimeout(t));
    };
    const payload = (s: StreamStep) => (s.binary ? Buffer.from(s.data, "base64") : Buffer.from(s.data, "utf8"));
    const advance = () => {
      while (!ended && pos < steps.length && steps[pos]!.dir === "out") {
        const s = steps[pos++]!;
        socket.write(encodeFrame(s.binary ? OP.binary : OP.text, payload(s)));
      }
      if (!ended && pos >= steps.length) finish(1000, "done");
    };
    const onMessage = (binary: boolean, data: Buffer) => {
      if (!binary) {
        try {
          utf8.decode(data);
        } catch {
          return finish(1007, "text frame is not valid UTF-8");
        }
      }
      const want = steps[pos];
      if (want === undefined || want.dir !== "in")
        return bug(
          `unexpected client frame "${clip(data.toString("utf8"))}" with no \`in\` step due; the script expects the adapter to wait for the server`,
          1008,
        );
      if (Boolean(want.binary) !== binary || !payload(want).equals(data)) {
        return bug(
          `client frame ${binary ? "(binary) " : ""}"${clip(data.toString(binary ? "base64" : "utf8"))}" differs from the fixture's step ${pos} ("${clip(want.data)}"); send exactly the frame the fixture records`,
          1008,
        );
      }
      pos += 1;
      advance();
    };
    const onData = (chunk: Buffer) => {
      let frames: ClientFrame[];
      try {
        frames = reader.push(chunk);
      } catch (e) {
        return finish(e instanceof WsError ? e.code : 1002, (e as Error).message);
      }
      for (const f of frames) {
        if (ended && f.opcode !== OP.close) continue;
        switch (f.opcode) {
          case OP.ping:
            socket.write(encodeFrame(OP.pong, f.payload));
            break;
          case OP.pong:
            break;
          case OP.close:
            if (!ended) {
              if (pos < steps.length)
                this.model.unmatched.push({
                  index: this.model.requests.length - 1,
                  reason: `upgrade ${url}: the client closed after ${pos} of ${steps.length} steps; the adapter must play the whole exchange`,
                });
              ended = true;
              socket.write(encodeFrame(OP.close, f.payload.subarray(0, 2)));
            }
            socket.end();
            break;
          case OP.text:
          case OP.binary:
            if (message) return finish(1002, "a new data frame began inside a fragmented message");
            message = { binary: f.opcode === OP.binary, parts: [f.payload] };
            msgBytes = f.payload.length;
            if (f.fin) {
              const m = message;
              message = undefined;
              onMessage(m.binary, Buffer.concat(m.parts));
            }
            break;
          case OP.cont:
            if (!message) return finish(1002, "continuation frame with nothing to continue");
            msgBytes += f.payload.length;
            if (msgBytes > this.#maxBytes) return finish(1009, "reassembled message is larger than the stub accepts");
            message.parts.push(f.payload);
            if (f.fin) {
              const m = message;
              message = undefined;
              onMessage(m.binary, Buffer.concat(m.parts));
            }
            break;
          default:
            return finish(1002, `unknown opcode ${f.opcode}`);
        }
      }
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
    // The upgrade socket is half-open: a client FIN arrives as "end" and "close" waits for us to end our side too.
    const gone = () => {
      if (!ended && pos < steps.length) {
        this.model.unmatched.push({
          index: this.model.requests.length - 1,
          reason: `upgrade ${url}: the connection dropped after ${pos} of ${steps.length} steps; the adapter must play the whole exchange`,
        });
      }
      ended = true;
      socket.end();
    };
    socket.on("end", gone);
    socket.on("close", gone);
    advance();
    // Bytes the client sent in the same packet as the handshake arrive as `head`, not as a "data" event.
    if (head.length > 0) onData(head);
  }
}
