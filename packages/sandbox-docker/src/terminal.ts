import http from "node:http";
import type { Duplex } from "node:stream";
import { SandboxUnavailableError, type TerminalClose, type TerminalSession } from "@pomtree/core";

// Detach sequence for the attach stream (docker's default ctrl-p,ctrl-q collides with readline-style
// TUIs). Closing the attach only detaches; the container keeps running.
export const DETACH_KEYS = "ctrl-^";

// Output buffered in session memory before the socket is paused (TCP backpressure), and the level at
// which it resumes. Output is never dropped: a stalled consumer stalls the docker stream instead.
export const TERMINAL_HIGH_WATER_BYTES = 1024 * 1024;
export const TERMINAL_LOW_WATER_BYTES = 256 * 1024;

export interface EngineRequest {
  method: "POST";
  path: string;
  headers: Record<string, string>;
}

// The slice of a duplex the session needs; a fake Duplex satisfies it in tests.
export type TerminalSocket = Pick<Duplex, "on" | "write" | "destroy" | "pause" | "resume">;

export interface EngineResponse {
  status: number;
  body: string;
}

// The thin transport to the Docker Engine API (unix socket). Injected so the session logic and the
// DockerSandbox terminal path run offline.
export interface EngineApi {
  request(req: EngineRequest): Promise<EngineResponse>;
  // Sends `req` with Upgrade: tcp. Resolves on 101 with the raw socket and the bytes already read
  // past the response headers (`head`); rejects on any other status.
  upgrade(req: EngineRequest): Promise<{ socket: TerminalSocket; head: Uint8Array }>;
}

export function buildAttachRequest(container: string): EngineRequest {
  const q = new URLSearchParams({ stream: "1", stdin: "1", stdout: "1", stderr: "1", detachKeys: DETACH_KEYS });
  return {
    method: "POST",
    path: `/containers/${encodeURIComponent(container)}/attach?${q}`,
    headers: { Connection: "Upgrade", Upgrade: "tcp" },
  };
}

export function buildResizeRequest(container: string, cols: number, rows: number): EngineRequest {
  for (const [k, v] of [
    ["cols", cols],
    ["rows", rows],
  ] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new RangeError(`invalid terminal ${k}: ${v}`);
  }
  return { method: "POST", path: `/containers/${encodeURIComponent(container)}/resize?h=${rows}&w=${cols}`, headers: {} };
}

// Wraps an established raw (Tty=true, so no multiplex header) attach socket as a TerminalSession.
export function createTerminalSession(
  socket: TerminalSocket,
  head: Uint8Array,
  resizeFn: (cols: number, rows: number) => Promise<void>,
  initial?: { cols: number; rows: number },
  limits: { highWater?: number; lowWater?: number } = {},
): TerminalSession {
  const highWater = limits.highWater ?? TERMINAL_HIGH_WATER_BYTES;
  const lowWater = limits.lowWater ?? TERMINAL_LOW_WATER_BYTES;
  const queue: Uint8Array[] = [];
  let queued = 0;
  let paused = false;
  let ended = false;
  let failure: Error | undefined;
  let size = initial;
  let wake: (() => void) | undefined;
  let drainWaiters: { ok: () => void; fail: (e: Error) => void }[] = [];
  let settle!: (c: TerminalClose) => void;
  const closed = new Promise<TerminalClose>((r) => (settle = r));

  const finish = (close: TerminalClose) => {
    if (ended) return;
    ended = true;
    if (close.error) failure = close.error;
    settle(close);
    for (const w of drainWaiters.splice(0)) w.fail(new Error("terminal closed"));
    wake?.();
  };
  const push = (b: Uint8Array) => {
    if (ended || b.length === 0) return;
    queue.push(b);
    queued += b.length;
    if (!paused && queued >= highWater) {
      paused = true;
      socket.pause();
    }
    wake?.();
  };

  push(head);
  socket.on("data", (b: Buffer) => push(b));
  socket.on("end", () => finish({ reason: "remote" }));
  socket.on("close", () => finish({ reason: "remote" }));
  socket.on("error", (e: Error) => finish({ reason: "error", error: e }));
  socket.on("drain", () => {
    for (const w of drainWaiters.splice(0)) w.ok();
  });

  const resize = async (cols: number, rows: number) => {
    if (ended) return;
    await resizeFn(cols, rows);
    size = { cols, rows };
  };

  return {
    closed,
    write(data) {
      if (ended) return Promise.reject(new Error("terminal closed"));
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      if (socket.write(buf)) return Promise.resolve();
      return new Promise<void>((ok, fail) => drainWaiters.push({ ok, fail }));
    },
    resize,
    async redraw() {
      if (!size) throw new Error("terminal size unknown: call resize(cols, rows) first");
      // Same-size resizes are no-ops to the pty (no SIGWINCH), so nudge one column wider first.
      const { cols, rows } = size;
      await resize(cols + 1, rows);
      await resize(cols, rows);
    },
    async *output() {
      while (true) {
        const next = queue.shift();
        if (next) {
          queued -= next.length;
          if (paused && queued <= lowWater && !ended) {
            paused = false;
            socket.resume();
          }
          yield next;
        } else if (ended) {
          if (failure) throw failure;
          return;
        } else await new Promise<void>((r) => (wake = r));
      }
    },
    close() {
      if (ended) return;
      finish({ reason: "local" });
      queue.length = 0;
      queued = 0;
      socket.destroy();
    },
  };
}

// Resolves the Engine API unix socket path from DOCKER_HOST (unix:// only) or the default.
export function engineSocketPath(dockerHost: string | undefined = process.env.DOCKER_HOST): string {
  if (!dockerHost) return "/var/run/docker.sock";
  if (dockerHost.startsWith("unix://")) return dockerHost.slice("unix://".length);
  // TODO(docker-host-tcp): only unix-socket DOCKER_HOST is supported for terminals; tcp/ssh hosts throw (the CLI paths still work).
  throw new SandboxUnavailableError();
}

const UNREACHABLE_CODES = new Set(["ENOENT", "ECONNREFUSED", "EACCES"]);
const asUnavailable = (e: unknown): Error =>
  e instanceof Error && UNREACHABLE_CODES.has((e as NodeJS.ErrnoException).code ?? "") ? new SandboxUnavailableError() : (e as Error);

const statusError = (req: EngineRequest, status: number, body: string) =>
  new Error(`docker api ${req.path.split("?")[0]} -> ${status}${status === 404 ? " no such container" : ""}: ${body.trim().slice(0, 200)}`);

// Real transport: node:http over the Engine API unix socket.
export function realEngineApi(socketPath: string = engineSocketPath()): EngineApi {
  return {
    request: (req) =>
      new Promise((resolve, reject) => {
        const r = http.request({ socketPath, method: req.method, path: req.path, headers: req.headers }, (res) => {
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
          res.on("error", reject);
        });
        r.on("error", (e) => reject(asUnavailable(e)));
        r.end();
      }),
    upgrade: (req) =>
      new Promise((resolve, reject) => {
        const r = http.request({ socketPath, method: req.method, path: req.path, headers: req.headers, agent: false });
        r.on("upgrade", (_res, socket, head) => resolve({ socket, head }));
        r.on("response", (res) => {
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("end", () => reject(statusError(req, res.statusCode ?? 0, Buffer.concat(parts).toString("utf8"))));
          res.on("error", reject);
        });
        r.on("error", (e) => reject(asUnavailable(e)));
        r.end();
      }),
  };
}

// POST via the engine, mapping non-2xx to a thrown Error.
export async function engineCall(api: EngineApi, req: EngineRequest): Promise<void> {
  const res = await api.request(req);
  if (res.status < 200 || res.status >= 300) throw statusError(req, res.status, res.body);
}
