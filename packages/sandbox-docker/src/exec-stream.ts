import { SandboxUnavailableError, type TerminalClose } from "@pomtree/core";
import { createExecDemuxer } from "./exec-demux.ts";
import type { EngineApi, EngineRequest, TerminalSocket } from "./terminal.ts";

// Same watermarks as the terminal: demuxed output buffered before the socket pauses (TCP backpressure), and where it resumes.
export const EXEC_HIGH_WATER_BYTES = 1024 * 1024;
export const EXEC_LOW_WATER_BYTES = 256 * 1024;
// The last stderr bytes kept for error messages.
export const EXEC_STDERR_TAIL_BYTES = 2048;

// A bidirectional raw byte stream to a process exec'd in a container: write goes to its stdin, output() yields its stdout.
// Structurally the same as core's ByteStream.
export interface ExecStream {
  write(data: Uint8Array): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  close(): void;
  closed: Promise<TerminalClose>;
  // The most recent stderr bytes (at most EXEC_STDERR_TAIL_BYTES), decoded as UTF-8, for error messages.
  stderrTail(): string;
}

export function buildExecCreateRequest(container: string, cmd: string[]): EngineRequest {
  if (cmd.length === 0) throw new RangeError("exec command must not be empty");
  return {
    method: "POST",
    path: `/containers/${encodeURIComponent(container)}/exec`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd }),
  };
}

export function buildExecStartRequest(execId: string): EngineRequest {
  return {
    method: "POST",
    path: `/exec/${encodeURIComponent(execId)}/start`,
    headers: { "Content-Type": "application/json", Connection: "Upgrade", Upgrade: "tcp" },
    body: JSON.stringify({ Detach: false, Tty: false }),
  };
}

// Wraps an established non-TTY exec socket (multiplexed frames) as an ExecStream.
export function createExecStream(
  socket: TerminalSocket,
  head: Uint8Array,
  limits: { highWater?: number; lowWater?: number; maxFrame?: number } = {},
): ExecStream {
  const highWater = limits.highWater ?? EXEC_HIGH_WATER_BYTES;
  const lowWater = limits.lowWater ?? EXEC_LOW_WATER_BYTES;
  const demux = createExecDemuxer(limits.maxFrame);
  const queue: Uint8Array[] = [];
  let queued = 0;
  let paused = false;
  let ended = false;
  let failure: Error | undefined;
  let stderr = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let drainWaiters: { ok: () => void; fail: (e: Error) => void }[] = [];
  let settle!: (c: TerminalClose) => void;
  const closed = new Promise<TerminalClose>((r) => (settle = r));

  const finish = (close: TerminalClose) => {
    if (ended) return;
    ended = true;
    if (close.error) failure = close.error;
    settle(close);
    for (const w of drainWaiters.splice(0)) w.fail(new Error("exec stream closed"));
    wake?.();
  };
  const feed = (b: Uint8Array) => {
    if (ended) return;
    try {
      const { stdout, stderr: err } = demux.push(b);
      for (const e of err) stderr = Buffer.concat([stderr, e]).subarray(-EXEC_STDERR_TAIL_BYTES);
      for (const o of stdout) {
        queue.push(o);
        queued += o.length;
      }
      if (!paused && queued >= highWater) {
        paused = true;
        socket.pause();
      }
      wake?.();
    } catch (e) {
      finish({ reason: "error", error: e as Error });
      socket.destroy();
    }
  };

  // A remote close with bridge stderr means the bridge failed; the error carries its last words so the caller sees the cause.
  const remoteClose = (): TerminalClose => {
    const tail = stderr.toString("utf8").trim();
    if (tail === "") return { reason: "remote" };
    return {
      reason: "remote",
      error: new Error(`loopback bridge in the container ended with: ${tail}; check that the target port is listening inside the sandbox`),
    };
  };

  feed(head);
  socket.on("data", (b: Buffer) => feed(b));
  socket.on("end", () => finish(remoteClose()));
  socket.on("close", () => finish(remoteClose()));
  socket.on("error", (e: Error) => finish({ reason: "error", error: e }));
  socket.on("drain", () => {
    for (const w of drainWaiters.splice(0)) w.ok();
  });

  return {
    closed,
    stderrTail: () => stderr.toString("utf8"),
    write(data) {
      if (ended) return Promise.reject(new Error("exec stream closed"));
      if (socket.write(data)) return Promise.resolve();
      return new Promise<void>((ok, fail) => drainWaiters.push({ ok, fail }));
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
    // TODO(loopback-exec-orphan): close() ends only the attach socket; the bridge process exits when it sees stdin EOF, so a container-side peer that ignores the half-close can leave the node bridge running in the container until the container stops.
    close() {
      if (ended) return;
      finish({ reason: "local" });
      queue.length = 0;
      queued = 0;
      socket.destroy();
    },
  };
}

// Creates an exec of `cmd` in `container` and hijacks its start connection. The container must be running; a refused create
// (404 no such container, 409 not running) throws with the engine's reason.
export async function openExecStream(api: EngineApi, container: string, cmd: string[]): Promise<ExecStream> {
  const create = buildExecCreateRequest(container, cmd);
  const res = await api.request(create);
  if (res.status !== 201) {
    if (res.status === 404 || res.status === 409) throw new SandboxUnavailableError();
    throw new Error(`docker api exec create -> ${res.status}: ${res.body.trim().slice(0, 200)}; check the engine is healthy and retry`);
  }
  let id: unknown;
  try {
    id = (JSON.parse(res.body) as { Id?: unknown }).Id;
  } catch {}
  if (typeof id !== "string" || id === "") throw new Error(`docker api exec create returned no exec id: ${res.body.trim().slice(0, 200)}`);
  const { socket, head } = await api.upgrade(buildExecStartRequest(id));
  return createExecStream(socket, head);
}
