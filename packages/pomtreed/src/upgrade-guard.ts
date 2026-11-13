// The shared front half of every authenticated WebSocket upgrade route (terminal, browser): the security policy lives here once.
// Order of checks: path match, upgrade headers, credentials, operator scope, Origin, agent lookup, running-with-sandbox.
// Also the route-independent connection plumbing (handshake settings, keepalive, close-frame-then-destroy).

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { AgentRecord } from "@pomtree/core";
import { verifyToken, verifyUiCookie } from "./auth.ts";
import type { Daemon } from "./daemon.ts";
import type { ReqCtx } from "./server.ts";
import { CloseCode, checkUpgrade, encodePing, handshakeResponse, originAllowed } from "./websocket.ts";
import type { WsConnection } from "./websocket.ts";

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  426: "Upgrade Required",
  500: "Internal Server Error",
};

function reject(socket: Duplex, status: number, message: string, extra: Record<string, unknown> = {}): void {
  const body = JSON.stringify({ error: message, ...extra });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/**
 * Writes the refusal (JSON body `{error, ...extra}`), records `message` in `ctx.error` and returns `status` for the access line.
 * Usable after authorisation too, for route-specific refusals such as a failed terminal acquisition.
 */
export type Refuse = (status: number, message: string, extra?: Record<string, unknown>) => number;

/** An agent record that is running and has a sandbox id (the guard guarantees both). */
export type RunningAgent = AgentRecord & { sandbox: NonNullable<AgentRecord["sandbox"]> };

export type UpgradeVerdict =
  | { ok: false; status: number } // the refusal is already written to the socket and recorded in ctx; return `status` as the access-line status
  | { ok: true; id: string; rec: RunningAgent; key: string; refuse: Refuse }; // `key` is the Sec-WebSocket-Key for `completeHandshake`

/**
 * Authorises a WebSocket upgrade for an operator on a running agent. Swallows socket errors, so a reset mid-handshake cannot crash the process.
 * `path` captures the agent id (url-encoded) as group 1; `notAvailable(id, state)` is the route's 409 message for an agent that is not running or has no sandbox
 * (the body also carries `state`). Records `ctx.hadCredential`, `ctx.principal` and, on refusal, `ctx.error`. Restricted listeners refuse with 404.
 */
export async function authorizeUpgrade(
  daemon: Daemon,
  path: RegExp,
  notAvailable: (id: string, state: string) => string,
  restricted: boolean,
  req: IncomingMessage,
  socket: Duplex,
  ctx: ReqCtx,
): Promise<UpgradeVerdict> {
  socket.on("error", () => {}); // a reset mid-handshake must not crash the process
  const refuse: Refuse = (status, message, extra = {}) => {
    ctx.error = message;
    reject(socket, status, message, extra);
    return status;
  };
  const deny = (status: number, message: string, extra?: Record<string, unknown>): UpgradeVerdict => ({ ok: false, status: refuse(status, message, extra) });
  const m = path.exec(new URL(req.url ?? "/", "http://pomtreed").pathname);
  if (restricted || !m || m[1] === undefined) return deny(404, "not found"); // a route regex without an id capture fails closed
  const up = checkUpgrade(req.headers, req.method);
  if (!up.ok) return deny(up.status, up.reason);

  // Same credentials as handleRequest: Bearer token or UI session cookie; these streams are shell-equivalent, so operator only.
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  ctx.hadCredential = token !== undefined || req.headers.cookie !== undefined;
  let principal = token ? verifyToken(daemon.deps.secret, token, () => daemon.now()) : null;
  if (!principal && req.headers.cookie !== undefined && verifyUiCookie(daemon.deps.secret, req.headers.cookie, () => daemon.now()))
    principal = { scope: "operator" };
  ctx.principal = principal;
  if (!principal) return deny(401, "missing or invalid token");
  if (principal.scope !== "operator") return deny(403, "operator scope required");
  // Browsers always send Origin on a WebSocket handshake and cookies ride along cross-site, so it must match Host.
  const hostOk = (o: string) => {
    try {
      return new URL(o).host === req.headers.host;
    } catch {
      return false;
    }
  };
  if (!originAllowed(req.headers.origin, hostOk)) return deny(403, "origin not allowed");

  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return deny(404, "not found"); // malformed % escape: no agent can have this id
  }
  const rec = await daemon.get(id);
  if (!rec) return deny(404, `no such agent: ${id}`);
  if (rec.state !== "running" || !rec.sandbox) return deny(409, notAvailable(id, rec.state), { state: rec.state });
  return { ok: true, id, rec: rec as RunningAgent, key: up.key, refuse };
}

/** Writes frames, skipping a destroyed socket. */
export function writeFrames(socket: Duplex, frames: Buffer[]): void {
  for (const f of frames) if (!socket.destroyed) socket.write(f);
}

/** Post-authorisation handshake: disables the socket timeout, enables TCP_NODELAY and writes the 101 response. */
export function completeHandshake(socket: Duplex, key: string): void {
  (socket as Partial<Pick<Socket, "setTimeout" | "setNoDelay">>).setTimeout?.(0);
  (socket as Partial<Pick<Socket, "setTimeout" | "setNoDelay">>).setNoDelay?.(true);
  socket.write(handshakeResponse(key));
}

export interface KeepaliveOpts {
  pingMs?: number; // ping cadence (default 25s)
  idleMs?: number; // no inbound bytes (pongs count) for this long drops the peer (default 75s)
  lastSeen: () => number; // Date.now() of the last inbound bytes
  busy?: () => boolean; // true while input is outstanding: the peer is not idle even when silent
}

/** Starts the unref'd ping timer; on idle it sends a going-away close, ends the socket and destroys it 500 ms later. Caller clears the returned timer on cleanup. */
export function startKeepalive(socket: Duplex, conn: WsConnection, o: KeepaliveOpts): ReturnType<typeof setInterval> {
  const ping = setInterval(() => {
    if (!o.busy?.() && Date.now() - o.lastSeen() > (o.idleMs ?? 75_000)) {
      writeFrames(socket, [conn.close(CloseCode.goingAway, "idle timeout") ?? Buffer.alloc(0)]);
      socket.end();
      setTimeout(() => socket.destroy(), 500).unref();
      return;
    }
    writeFrames(socket, [encodePing()]);
  }, o.pingMs ?? 25_000);
  ping.unref();
  return ping;
}

/**
 * Server-initiated close: writes `before` (route-specific frames such as a "closed" notice), then a normal close frame, and destroys the socket after `waitMs`
 * unless the peer is gone sooner. Returns the unref'd destroy timer for the caller to clear on cleanup.
 */
export function closeThenDestroy(socket: Duplex, conn: WsConnection, waitMs: number, before: Buffer[] = []): ReturnType<typeof setTimeout> {
  const close = conn.close(CloseCode.normal);
  writeFrames(socket, [...before, ...(close ? [close] : [])]);
  const t = setTimeout(() => socket.destroy(), waitMs);
  t.unref();
  return t;
}
