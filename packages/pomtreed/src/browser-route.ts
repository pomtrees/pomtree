// GET /v1/agents/:id/browser (WebSocket upgrade): the thin socket shell around BrowserHub and websocket.ts. View-only.
// Server -> client: binary messages are one complete JPEG each (nothing else is ever binary); text messages are JSON,
// at most 4 KiB: {"type":"status","state",url?,title?,width?,height?} and, just before closing, {"type":"closed","reason":"ended|local|error"}.
// Client -> server: nothing but ping/pong/close; any text or binary data message closes the socket with 1008.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { LOOPBACK_PORTS, SandboxCapabilityError, SandboxUnavailableError, need } from "@pomtree/core";
import { BrowserHub } from "./browser-hub.ts";
import type { BrowserCloseReason, BrowserLease } from "./browser-hub.ts";
import { createCdpRelay } from "./cdp-relay.ts";
import type { RelayStatus } from "./cdp-relay.ts";
import type { Daemon } from "./daemon.ts";
import type { ReqCtx } from "./server.ts";
import { authorizeUpgrade, closeThenDestroy, completeHandshake, startKeepalive, writeFrames as guardWriteFrames } from "./upgrade-guard.ts";
import { CloseCode, WsConnection, encodeBinary, encodeText } from "./websocket.ts";

const PATH = /^\/v1\/agents\/([^/]+)\/browser$/;
// Client data messages are refused anyway; the cap just bounds what the decoder buffers before the verdict.
const MAX_CLIENT_FRAME = 4096;

export interface BrowserRouteOpts {
  pingMs?: number; // ping cadence (default 25s)
  idleMs?: number; // no inbound bytes (pongs count) for this long drops the viewer (default 75s)
  closeWaitMs?: number; // after our close frame, wait this long for the peer's before destroying (default 2s)
  maxViewers?: number; // per agent (default 8)
  aliveMs?: number; // how often a running agent is re-checked while viewed (default 2s)
  frameBacklogLimit?: number;
  pollMs?: number; // relay discovery cadence (default 2s)
}

interface Conn {
  shutdown(): void;
}
interface State {
  hub: BrowserHub;
  conns: Set<Conn>;
  closing: boolean;
}
const states = new WeakMap<Daemon, State>();

function stateFor(daemon: Daemon, opts: BrowserRouteOpts): State {
  let s = states.get(daemon);
  if (!s) {
    const hub = new BrowserHub({
      relay: (agent, listener) =>
        createCdpRelay(
          {
            // Every CDP exchange is a fresh loopback stream into the agent's own container; no CDP port is ever published.
            open: async () => {
              const r = await daemon.deps.registry.get(agent);
              if (!r?.sandbox) throw new SandboxUnavailableError();
              return need(daemon.deps.sandbox, "loopback").open(r.sandbox, LOOPBACK_PORTS[0]);
            },
            ...(opts.pollMs !== undefined && { pollMs: opts.pollMs }),
            onError: (where, e) => console.error(`pomtreed: browser ${agent} ${where}: ${e instanceof Error ? e.message : String(e)}`),
          },
          listener,
        ),
      alive: async (agent) => {
        const r = await daemon.get(agent);
        return r?.state === "running" && !!r.sandbox;
      },
      ...(opts.aliveMs !== undefined && { aliveMs: opts.aliveMs }),
      ...(opts.maxViewers !== undefined && { maxViewers: opts.maxViewers }),
      ...(opts.frameBacklogLimit !== undefined && { frameBacklogLimit: opts.frameBacklogLimit }),
      onError: (agent, where, e) => console.error(`pomtreed: browser ${agent} ${where}: ${e instanceof Error ? e.message : String(e)}`),
    });
    s = { hub, conns: new Set(), closing: false };
    states.set(daemon, s);
  }
  return s;
}

/** Daemon shutdown: tell every viewer "local", stop the relays and close the sockets (bounded wait for the peers). */
export function closeBrowsers(daemon: Daemon): void {
  const s = states.get(daemon);
  if (!s) return;
  s.closing = true;
  s.hub.closeAll();
  for (const c of [...s.conns]) c.shutdown();
}

/** True for a request path this route serves (the dispatcher in server.ts routes on it). */
export function isBrowserPath(url: string | undefined): boolean {
  return PATH.test(new URL(url ?? "/", "http://pomtreed").pathname);
}

export function noBrowserMessage(id: string, state: string): string {
  return state === "running" ? `agent ${id} is running but has no browser view yet; retry shortly` : `no browser view: agent ${id} is ${state}`;
}

/** The status text message. Only the four known fields are copied; url/title are already sanitised and capped by the relay. */
export function statusMessage(s: RelayStatus): string {
  return JSON.stringify({
    type: "status",
    state: s.state,
    ...(s.url !== undefined && { url: s.url }),
    ...(s.title !== undefined && { title: s.title }),
    ...(s.width !== undefined && { width: s.width }),
    ...(s.height !== undefined && { height: s.height }),
  });
}

export async function handleBrowserUpgrade(
  daemon: Daemon,
  opts: BrowserRouteOpts,
  restricted: boolean,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  ctx: ReqCtx,
): Promise<number> {
  const g = await authorizeUpgrade(daemon, PATH, noBrowserMessage, restricted, req, socket, ctx);
  if (!g.ok) return g.status;
  const { id, rec, refuse } = g;

  // A backend without the loopback facet (a fixed property of the configuration) can never show the browser view: refuse before the
  // handshake with the cause and the action, as the terminal route does for a missing terminal facet.
  try {
    need(daemon.deps.sandbox, "loopback");
  } catch (e) {
    if (e instanceof SandboxCapabilityError) {
      return refuse(
        409,
        `this sandbox backend does not support the browser view (${e.backend} provides no loopback facet); use the Docker backend or another backend that declares loopback`,
        { state: rec.state },
      );
    }
    console.error(`pomtreed: browser ${id} capability check failed: ${e instanceof Error ? e.message : String(e)}`);
    return refuse(500, "internal error");
  }

  const st = stateFor(daemon, opts);
  let gone = socket.destroyed;
  socket.once("close", () => {
    gone = true;
  });
  // The viewer limit is enforced before the handshake, so the 9th viewer gets a plain HTTP refusal.
  const lease: BrowserLease | null = st.hub.acquire(id);
  if (!lease) return refuse(503, `agent ${id} already has the maximum number of browser viewers; close one and retry`);
  if (gone) {
    lease.detach();
    ctx.error = "client closed before the handshake";
    return 499;
  }

  const conn = new WsConnection({ maxMessage: MAX_CLIENT_FRAME });
  completeHandshake(socket, g.key);

  let lastSeen = Date.now();
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const closeWait = opts.closeWaitMs ?? 2000;
  const writeFrames = (frames: Buffer[]) => guardWriteFrames(socket, frames);

  // Server-initiated close: the "closed" text frame, then a close frame; give the peer closeWait to answer.
  const finish = (reason: BrowserCloseReason, wait = st.closing ? 500 : closeWait) => {
    if (done || conn.closeSent) return;
    closeTimer = closeThenDestroy(socket, conn, wait, [encodeText(JSON.stringify({ type: "closed", reason }))]);
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

  const ping = startKeepalive(socket, conn, { pingMs: opts.pingMs, idleMs: opts.idleMs, lastSeen: () => lastSeen });

  // The destroy deadline is armed once; input after that (a repeat message, the peer's close, more chunks) changes nothing.
  let destroyArmed = false;
  const armDestroy = () => {
    destroyArmed = true;
    setTimeout(() => socket.destroy(), closeWait).unref();
  };
  const feed = (bytes: Uint8Array) => {
    if (destroyArmed) return;
    lastSeen = Date.now();
    const r = conn.receive(bytes);
    writeFrames(r.out);
    // View-only: the UI sends nothing. Any data message is a policy violation; ping/pong/close are handled by WsConnection.
    if (r.events.some((ev) => ev.type === "text" || ev.type === "binary")) {
      writeFrames([conn.close(CloseCode.policy, "view only: this stream accepts no messages") ?? Buffer.alloc(0)]);
      socket.end();
      armDestroy();
      return;
    }
    if (r.end) {
      socket.end();
      armDestroy();
    }
  };

  socket.on("data", feed);
  socket.on("drain", () => lease.drained());
  socket.once("close", cleanup);
  socket.once("end", () => socket.end());
  lease.start({
    status: (s) => {
      if (!conn.closeSent && !socket.destroyed) socket.write(encodeText(statusMessage(s)));
    },
    frame: (jpeg) => {
      if (!conn.closeSent && !socket.destroyed) socket.write(encodeBinary(jpeg));
    },
    backlog: () => socket.writableLength,
    close: (reason) => finish(reason),
  });
  if (head.length) feed(head);
  return 101;
}
