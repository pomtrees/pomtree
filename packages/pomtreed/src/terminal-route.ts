// GET /v1/agents/:id/terminal (WebSocket upgrade): the thin socket shell around TerminalHub and websocket.ts.
// Binary frames both ways are raw terminal bytes; client text frames are JSON control ({"type":"resize",cols,rows});
// the server sends one text frame {"type":"closed","reason":"local|remote|error"} just before closing.

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { SandboxCapabilityError, SandboxUnavailableError, need } from "@pomtree/core";
import type { Daemon } from "./daemon.ts";
import type { ReqCtx } from "./server.ts";
import { verifyToken, verifyUiCookie } from "./auth.ts";
import { CloseCode, WsConnection, checkUpgrade, encodeBinary, encodePing, encodeText, handshakeResponse, originAllowed } from "./websocket.ts";
import type { WsEvent } from "./websocket.ts";
import { DEFAULT_TERMINAL_SIZE, TerminalHub, clampSize } from "./terminal-hub.ts";
import type { TerminalCloseReason, TerminalLease } from "./terminal-hub.ts";

const PATH = /^\/v1\/agents\/([^/]+)\/terminal$/;

export interface TerminalRouteOpts {
  pingMs?: number; // ping cadence (default 25s)
  idleMs?: number; // no inbound bytes (pongs count) for this long drops the viewer (default 75s)
  closeWaitMs?: number; // after our close frame, wait this long for the peer's before destroying (default 2s)
  maxMessage?: number; // largest accepted client frame (default 1 MiB)
  ringCapacity?: number;
  maxViewerBacklog?: number;
}

interface Conn {
  shutdown(): void;
}
interface State {
  hub: TerminalHub;
  conns: Set<Conn>;
  closing: boolean;
}
const states = new WeakMap<Daemon, State>();

function stateFor(daemon: Daemon, opts: TerminalRouteOpts): State {
  let s = states.get(daemon);
  if (!s) {
    const hub = new TerminalHub({
      // The sandbox id is durable on the registry record, so the hub keys on the agent id alone.
      open: async (agent, size) => {
        const r = await daemon.deps.registry.get(agent);
        if (!r?.sandbox) throw new SandboxUnavailableError();
        return need(daemon.deps.sandbox, "terminal").open(r.sandbox, size);
      },
      onEsc: (agent) => daemon.userEsc(agent),
      ...(opts.ringCapacity !== undefined && { ringCapacity: opts.ringCapacity }),
      ...(opts.maxViewerBacklog !== undefined && { maxViewerBacklog: opts.maxViewerBacklog }),
      onError: (agent, where, e) => console.error(`pomtreed: terminal ${agent} ${where}: ${e instanceof Error ? e.message : String(e)}`),
    });
    s = { hub, conns: new Set(), closing: false };
    states.set(daemon, s);
  }
  return s;
}

/** Daemon shutdown: tell every viewer "local", close the sessions and the sockets (bounded wait for the peers). */
export function closeTerminals(daemon: Daemon): void {
  const s = states.get(daemon);
  if (!s) return;
  s.closing = true; // shorten the peers' close-handshake wait
  s.hub.closeAll();
  for (const c of [...s.conns]) c.shutdown();
}

function reject(socket: Duplex, status: number, message: string, extra: Record<string, unknown> = {}): void {
  const text =
    {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      409: "Conflict",
      426: "Upgrade Required",
      500: "Internal Server Error",
    }[status] ?? "Error";
  const body = JSON.stringify({ error: message, ...extra });
  socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/** The 409 text for an agent with no live terminal; the UI shows its own label from the `state` field, API clients get this. */
export function noTerminalMessage(id: string, state: string): string {
  if (state === "yielded") return `agent ${id} is yielded: it is waiting and has no live terminal; it resumes on its wait condition`;
  if (state === "pending") return `agent ${id} is pending: no live terminal yet; retry once it is running`;
  if (state === "running") return `agent ${id} is running but has no attachable terminal yet; retry shortly`;
  return `no live terminal: agent ${id} is ${state}`;
}

export async function handleTerminalUpgrade(
  daemon: Daemon,
  opts: TerminalRouteOpts,
  restricted: boolean,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  ctx: ReqCtx,
): Promise<number> {
  socket.on("error", () => {}); // a reset mid-handshake must not crash the process
  // Resolves to the status for the access line (101 on handshake), recording the refusal reason, credential and principal in ctx.
  const refuse = (status: number, message: string, extra: Record<string, unknown> = {}): number => {
    ctx.error = message;
    reject(socket, status, message, extra);
    return status;
  };
  const m = PATH.exec(new URL(req.url ?? "/", "http://pomtreed").pathname);
  if (restricted || !m) return refuse(404, "not found");
  const up = checkUpgrade(req.headers, req.method);
  if (!up.ok) return refuse(up.status, up.reason);

  // Same credentials as handleRequest: Bearer token or UI session cookie; a terminal is shell-equivalent, so operator only.
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  ctx.hadCredential = token !== undefined || req.headers.cookie !== undefined;
  let principal = token ? verifyToken(daemon.deps.secret, token) : null;
  if (!principal && req.headers.cookie !== undefined && verifyUiCookie(daemon.deps.secret, req.headers.cookie)) principal = { scope: "operator" };
  ctx.principal = principal;
  if (!principal) return refuse(401, "missing or invalid token");
  if (principal.scope !== "operator") return refuse(403, "operator scope required");
  // Browsers always send Origin on a WebSocket handshake and cookies ride along cross-site, so it must match Host.
  const hostOk = (o: string) => {
    try {
      return new URL(o).host === req.headers.host;
    } catch {
      return false;
    }
  };
  if (!originAllowed(req.headers.origin, hostOk)) return refuse(403, "origin not allowed");

  const id = decodeURIComponent(m[1]!);
  const rec = await daemon.get(id);
  if (!rec) return refuse(404, `no such agent: ${id}`);
  if (rec.state !== "running" || !rec.sandbox) return refuse(409, noTerminalMessage(id, rec.state), { state: rec.state });

  const st = stateFor(daemon, opts);
  let gone = socket.destroyed;
  socket.once("close", () => {
    gone = true;
  });
  let lease: TerminalLease;
  try {
    lease = await st.hub.acquire(id, DEFAULT_TERMINAL_SIZE);
  } catch (e) {
    if (e instanceof SandboxUnavailableError) return refuse(409, `agent ${id} has no attachable terminal`, { state: rec.state });
    // The backend cannot give this agent a terminal (a fixed property of the configuration): the message names the cause and the action.
    if (e instanceof SandboxCapabilityError) return refuse(409, e.message, { state: rec.state });
    console.error(`pomtreed: terminal ${id} open failed: ${e instanceof Error ? e.message : String(e)}`);
    return refuse(500, "internal error");
  }
  if (gone) {
    lease.detach();
    ctx.error = "client closed before the handshake"; // socket already gone: nothing to write, only the log line
    return 499;
  }

  const conn = new WsConnection({ maxMessage: opts.maxMessage });
  (socket as Partial<Pick<Socket, "setTimeout" | "setNoDelay">>).setTimeout?.(0);
  (socket as Partial<Pick<Socket, "setTimeout" | "setNoDelay">>).setNoDelay?.(true);
  socket.write(handshakeResponse(up.key));

  let lastSeen = Date.now();
  let pendingInput = 0;
  let chain: Promise<void> = Promise.resolve();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const closeWait = opts.closeWaitMs ?? 2000;

  const writeFrames = (frames: Buffer[]) => {
    for (const f of frames) if (!socket.destroyed) socket.write(f);
  };
  // Server-initiated close: the "closed" text frame, then a close frame; give the peer closeWait to answer.
  const finish = (reason: TerminalCloseReason, wait = st.closing ? 500 : closeWait) => {
    if (done || conn.closeSent) return;
    const close = conn.close(CloseCode.normal);
    writeFrames([encodeText(JSON.stringify({ type: "closed", reason })), ...(close ? [close] : [])]);
    closeTimer = setTimeout(() => socket.destroy(), wait);
    closeTimer.unref();
  };
  const cleanup = () => {
    if (done) return;
    done = true;
    clearInterval(ping);
    clearTimeout(closeTimer);
    conn.markEnded();
    st.conns.delete(handle);
    lease.detach();
  };
  const handle: Conn = { shutdown: () => finish("local", 500) };
  st.conns.add(handle);

  const ping = setInterval(() => {
    if (pendingInput === 0 && Date.now() - lastSeen > (opts.idleMs ?? 75_000)) {
      writeFrames([conn.close(CloseCode.goingAway, "idle timeout") ?? Buffer.alloc(0)]);
      socket.end();
      setTimeout(() => socket.destroy(), 500).unref();
      return;
    }
    writeFrames([encodePing()]);
  }, opts.pingMs ?? 25_000);
  ping.unref();

  const control = (text: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      writeFrames([conn.close(CloseCode.unsupported, "bad control frame") ?? Buffer.alloc(0)]);
      return;
    }
    const o = (typeof msg === "object" && msg !== null ? msg : {}) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (o.type !== "resize") return; // unknown control types are ignored (forward compatibility)
    const size = clampSize(o.cols, o.rows);
    if (size) void lease.resize(size).catch((e) => console.error(`pomtreed: terminal ${id} resize failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  // Keystrokes are written in order; the socket is paused while writes are outstanding so a stalled pty
  // backpressures the browser (TCP) instead of growing a queue here.
  const input = (data: Buffer) => {
    pendingInput += data.length;
    socket.pause();
    chain = chain
      .then(() => lease.write(data))
      .catch(() => {})
      .then(() => {
        pendingInput -= data.length;
        if (pendingInput === 0 && !done) socket.resume();
      });
  };
  const onEvent = (ev: WsEvent) => {
    if (ev.type === "text") control(ev.text);
    else if (ev.type === "binary") input(ev.data);
  };
  const feed = (bytes: Uint8Array) => {
    lastSeen = Date.now();
    const r = conn.receive(bytes);
    writeFrames(r.out);
    r.events.forEach(onEvent);
    if (r.end) {
      socket.end();
      setTimeout(() => socket.destroy(), closeWait).unref();
    }
  };

  socket.on("data", feed);
  socket.once("close", cleanup);
  socket.once("end", () => socket.end());
  lease.start({
    send: (chunk) => {
      if (!conn.closeSent && !socket.destroyed) socket.write(encodeBinary(chunk));
    },
    backlog: () => socket.writableLength,
    close: (reason) => finish(reason),
  });
  if (head.length) feed(head);
  return 101;
}
