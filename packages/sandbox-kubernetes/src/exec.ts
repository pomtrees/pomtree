// Kubernetes exec over the API server's WebSocket subprotocol `v5.channel.k8s.io`.
//
// Every message is binary: the first byte names a channel, the rest is that channel's payload.
//   0 stdin (client to server)   1 stdout   2 stderr   3 status (JSON Status object)   4 resize (client to server)
//   255 close (payload: one byte, the index of the channel that ended; the client sends [255, 0] to half-close stdin)
// The exit status is only ever read from channel 3: `Success` is exit 0, and `Failure` with reason `NonZeroExitCode` carries the
// code in details.causes[reason=ExitCode].message. A stream that ends without a status frame is a DROP, never an end of file:
// it raises, so a truncated or killed stream can never be mistaken for a command that finished with exit 0.
//
// The WebSocket itself is injected (`ConnectFn`), so this module holds no TLS, credential or socket code; the adapter wires
// it to the kit's `connectWebSocket` with the cluster's bearer token and CA.
//
// Argv is sent as repeated `command=` query parameters and is never joined into a shell string.

import { ExecOutputCapError, type ExecOutcome } from "@pomtree/sandbox-kit/result-work-exec";
import { redact } from "@pomtree/sandbox-kit/redact";
import { createMux, type Mux, type MuxOptions, type MuxPair } from "@pomtree/sandbox-kit/mux";
import type { WsClient, WsMessage } from "@pomtree/sandbox-kit/ws-client";

export const EXEC_SUBPROTOCOL = "v5.channel.k8s.io";
export const Channel = { stdin: 0, stdout: 1, stderr: 2, status: 3, resize: 4, close: 255 } as const;

export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
// After the status frame the server may still have output frames in flight (the status and the last output travel on separate
// streams in the kubelet), so the reader keeps going until the server closes, for at most this long.
export const DEFAULT_DRAIN_MS = 2000;
const STDIN_CHUNK = 32 * 1024;

export type ExecErrorKind = "dropped" | "aborted" | "protocol" | "subprotocol" | "usage";

// The exec stream broke, was malformed or negotiated the wrong protocol. `kind: "dropped"` means no exit status was received.
export class ExecStreamError extends Error {
  kind: ExecErrorKind;
  constructor(kind: ExecErrorKind, message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ExecStreamError";
    this.kind = kind;
  }
}

// The API server ran the exec but reported a failure that is not a command exit code (exec denied, container not found, ...).
export class ExecStatusError extends Error {
  reason: string;
  constructor(reason: string, detail: string) {
    super(
      `the API server failed the exec with reason ${reason}${detail ? `: ${redact(detail.slice(0, 300))}` : ""}; check that the pod is Running, the container name is right and the credential may \`create\` on pods/exec`,
    );
    this.name = "ExecStatusError";
    this.reason = reason;
  }
}

// ---- frame codec ----

export interface ExecFrame {
  channel: number;
  payload: Uint8Array;
}

export function encodeFrame(channel: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(1 + payload.length);
  out[0] = channel;
  out.set(payload, 1);
  return out;
}

export function decodeFrame(data: Uint8Array): ExecFrame {
  if (data.length === 0) {
    throw new ExecStreamError(
      "protocol",
      "received an empty exec message with no channel byte; the peer is not speaking v5.channel.k8s.io, so check the API server version and any proxy in between",
    );
  }
  return { channel: data[0] as number, payload: data.subarray(1) };
}

// Exit code from a channel-3 payload.
export function parseStatus(payload: Uint8Array): number {
  let status: { status?: unknown; reason?: unknown; message?: unknown; details?: { causes?: { reason?: unknown; message?: unknown }[] } };
  try {
    status = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch (e) {
    throw new ExecStreamError("protocol", "the exec status frame on channel 3 is not valid JSON; check the API server version", { cause: e });
  }
  if (status === null || typeof status !== "object") {
    throw new ExecStreamError("protocol", "the exec status frame on channel 3 is not a JSON object; check the API server version");
  }
  if (status.status === "Success") return 0;
  if (status.status === "Failure") {
    if (status.reason === "NonZeroExitCode") {
      const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
      const code = typeof cause?.message === "string" && /^\d{1,3}$/.test(cause.message) ? Number(cause.message) : -1;
      if (code < 0 || code > 255) {
        throw new ExecStreamError("protocol", "the exec status says NonZeroExitCode but carries no ExitCode cause; check the API server version");
      }
      return code;
    }
    throw new ExecStatusError(
      typeof status.reason === "string" && status.reason !== "" ? status.reason : "Failure",
      typeof status.message === "string" ? status.message : "",
    );
  }
  throw new ExecStreamError("protocol", "the exec status frame on channel 3 is neither Success nor Failure; check the API server version");
}

// ---- URL ----

export interface ExecTarget {
  // API server base, for example https://10.0.0.1:6443 (a path prefix is kept).
  server: string;
  namespace: string;
  pod: string;
  container?: string;
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

// Names are put into the URL path, so they must be valid Kubernetes names: "." and ".." would be resolved as path segments and
// redirect the request to another API path.
function checkName(what: string, value: unknown, kind: "label" | "subdomain"): string {
  const max = kind === "label" ? 63 : 253;
  if (typeof value !== "string" || value.length === 0 || value.length > max || !(kind === "label" ? DNS_LABEL : DNS_SUBDOMAIN).test(value)) {
    throw new ExecStreamError(
      "usage",
      `the ${what} name "${String(value)
        .replace(/[^\x20-\x7e]/g, "?")
        .slice(
          0,
          80,
        )}" is not a valid Kubernetes DNS-1123 ${kind} (lowercase letters, digits and "-"${kind === "subdomain" ? ' and "."' : ""}, at most ${max} characters); pass the name exactly as the cluster reports it`,
    );
  }
  return value;
}

export function execUrl(target: ExecTarget, argv: readonly string[], opts: { stdin: boolean; tty?: boolean }): string {
  if (argv.length === 0 || argv.some((a) => typeof a !== "string" || a.includes("\0"))) {
    throw new ExecStreamError("usage", "exec needs a non-empty argv of strings without NUL bytes; pass the program and its arguments as separate elements");
  }
  const namespace = checkName("namespace", target.namespace, "label");
  const pod = checkName("pod", target.pod, "subdomain");
  const container = target.container === undefined ? undefined : checkName("container", target.container, "label");
  const u = new URL(target.server);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/v1/namespaces/${namespace}/pods/${pod}/exec`;
  const q = new URLSearchParams();
  if (container !== undefined) q.set("container", container);
  for (const a of argv) q.append("command", a);
  const tty = opts.tty ?? false;
  q.set("stdin", String(opts.stdin));
  q.set("stdout", "true");
  q.set("stderr", String(!tty));
  q.set("tty", String(tty));
  u.search = q.toString();
  return u.toString();
}

// ---- session ----

// The slice of the kit's WsClient that exec uses.
export type ExecWs = Pick<WsClient, "protocol" | "send" | "close"> & AsyncIterable<WsMessage>;
export type ConnectFn = (url: string, opts: { protocols: string[]; signal?: AbortSignal }) => Promise<ExecWs>;

export type ExecEvent = { type: "stdout"; data: Uint8Array } | { type: "stderr"; data: Uint8Array } | { type: "exit"; exitCode: number };

export interface ExecSession {
  // Single use. Yields output as it arrives and ends after exactly one `exit` event; a stream that ends any other way throws,
  // except after close() was called locally, when it ends quietly.
  events(): AsyncGenerator<ExecEvent>;
  // Writes stdin in bounded chunks, each awaiting the socket (backpressure). Writes are ordered.
  write(data: Uint8Array): Promise<void>;
  // Half-close: tells the process its stdin ended (channel 255, index 0). Later writes throw.
  closeStdin(): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

const droppedMessage = (why: string): string =>
  `the exec stream ended without an exit status (${why}), so the command's outcome is unknown and its output may be truncated; check the pod and the API server connection, then rerun the command`;

export async function openExec(
  connect: ConnectFn,
  target: ExecTarget,
  argv: readonly string[],
  opts: { stdin?: boolean; tty?: boolean; signal?: AbortSignal; drainMs?: number } = {},
): Promise<ExecSession> {
  const url = execUrl(target, argv, { stdin: opts.stdin ?? false, ...(opts.tty === undefined ? {} : { tty: opts.tty }) });
  const ws = await connect(url, { protocols: [EXEC_SUBPROTOCOL], ...(opts.signal === undefined ? {} : { signal: opts.signal }) });
  if (ws.protocol !== EXEC_SUBPROTOCOL) {
    await ws.close().catch(() => undefined);
    throw new ExecStreamError(
      "subprotocol",
      `the API server negotiated the subprotocol "${redact(ws.protocol) || "(none)"}" instead of ${EXEC_SUBPROTOCOL}; the cluster is older than Kubernetes 1.30 or a proxy dropped the header, so upgrade the cluster or connect without the proxy`,
    );
  }
  return new Session(ws, opts.stdin ?? false, opts.signal, opts.drainMs ?? DEFAULT_DRAIN_MS);
}

class Session implements ExecSession {
  #ws: ExecWs;
  #hasStdin: boolean;
  #stdinClosed = false;
  #closedLocally = false;
  #used = false;
  #signal: AbortSignal | undefined;
  #drainMs: number;
  #chain: Promise<void> = Promise.resolve();

  constructor(ws: ExecWs, hasStdin: boolean, signal: AbortSignal | undefined, drainMs: number) {
    this.#ws = ws;
    this.#hasStdin = hasStdin;
    this.#signal = signal;
    this.#drainMs = drainMs;
  }

  #lost(why: string, cause?: unknown): ExecStreamError {
    if (this.#signal?.aborted) {
      return new ExecStreamError(
        "aborted",
        "the exec was cancelled by the caller's abort signal before it reported an exit status, so its outcome is unknown; start a new exec if the command still needs to run",
        cause === undefined ? {} : { cause },
      );
    }
    return new ExecStreamError("dropped", droppedMessage(why), cause === undefined ? {} : { cause });
  }

  async *events(): AsyncGenerator<ExecEvent> {
    if (this.#used) {
      throw new ExecStreamError("usage", "events() of an exec session can be consumed once; keep the first iterator, or open a new exec to read again");
    }
    this.#used = true;
    const it = this.#ws[Symbol.asyncIterator]();
    let exitCode: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: Promise<"timeout"> | undefined;
    try {
      for (;;) {
        let step: IteratorResult<WsMessage> | "timeout";
        const next = it.next();
        try {
          step = deadline === undefined ? await next : await Promise.race([next, deadline]);
        } catch (e) {
          if (e instanceof ExecStreamError) throw e;
          if (exitCode !== undefined) break; // the status was received; a late socket error loses nothing that was promised
          if (this.#closedLocally && !this.#signal?.aborted) return;
          throw this.#lost(e instanceof Error ? redact(e.message) : "socket error", e);
        }
        if (step === "timeout" || step.done) break;
        const m = step.value;
        if (m.type !== "binary") {
          throw new ExecStreamError("protocol", "received a text message on a v5 exec stream; check the API server version and any proxy in between");
        }
        const f = decodeFrame(m.data);
        if (f.channel === Channel.stdout || f.channel === Channel.stderr) {
          if (f.payload.length > 0) yield { type: f.channel === Channel.stdout ? "stdout" : "stderr", data: f.payload };
        } else if (f.channel === Channel.status) {
          if (exitCode !== undefined) throw new ExecStreamError("protocol", "received a second exec status frame; check the API server version");
          exitCode = parseStatus(f.payload);
          deadline = new Promise<"timeout">((r) => {
            timer = setTimeout(() => r("timeout"), this.#drainMs);
          });
        } else if (f.channel !== Channel.close) {
          throw new ExecStreamError("protocol", `received a frame on the unexpected channel ${f.channel}; check the API server version`);
        }
      }
      if (exitCode !== undefined) {
        yield { type: "exit", exitCode };
        return;
      }
      if (this.#closedLocally && !this.#signal?.aborted) return;
      throw this.#lost("the socket closed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await this.close();
    }
  }

  #send(frame: Uint8Array): Promise<void> {
    const next = this.#chain.then(() =>
      this.#ws.send(frame).catch((e: unknown) => {
        throw new ExecStreamError(
          "dropped",
          `writing to the exec stream failed (${e instanceof Error ? redact(e.message) : "socket error"}); the connection is gone, so reopen the exec`,
          { cause: e },
        );
      }),
    );
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.#hasStdin) throw new ExecStreamError("usage", "this exec was opened without stdin; open it with { stdin: true } to write");
    if (this.#stdinClosed) throw new ExecStreamError("usage", "stdin was already closed (half-closed) on this exec; open a new exec to send more input");
    for (let off = 0; off < data.length; off += STDIN_CHUNK) {
      await this.#send(encodeFrame(Channel.stdin, data.subarray(off, off + STDIN_CHUNK)));
    }
  }

  async closeStdin(): Promise<void> {
    if (!this.#hasStdin) throw new ExecStreamError("usage", "this exec was opened without stdin; open it with { stdin: true } to close it");
    if (this.#stdinClosed) return;
    this.#stdinClosed = true;
    await this.#send(encodeFrame(Channel.close, Uint8Array.of(Channel.stdin)));
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 65535 || rows > 65535) {
      throw new ExecStreamError("usage", `terminal size ${cols}x${rows} is invalid; pass positive integers up to 65535`);
    }
    await this.#send(encodeFrame(Channel.resize, Buffer.from(JSON.stringify({ Width: cols, Height: rows }))));
  }

  async close(): Promise<void> {
    if (this.#closedLocally) return;
    this.#closedLocally = true;
    await this.#ws.close().catch(() => undefined);
  }
}

// ---- one-shot exec ----

export interface ExecRunOptions {
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  stdin?: Uint8Array;
  signal?: AbortSignal;
  // How long to keep reading after the status frame for trailing output (default DEFAULT_DRAIN_MS).
  drainMs?: number;
}

// The last `max` bytes of `b`, starting on a UTF-8 character boundary.
function tailUtf8(b: Buffer, max: number): string {
  let start = Math.max(0, b.length - max);
  while (start < b.length && start > 0 && ((b[start] as number) & 0xc0) === 0x80) start++;
  return b.subarray(start).toString("utf8");
}

// Runs argv to completion. Stdout past `maxStdoutBytes` throws ExecOutputCapError (exactly the cap is allowed) and closes the
// stream. Stderr keeps only its last `maxStderrBytes`. A non-zero exit is a result, not an exception.
export async function exec(connect: ConnectFn, target: ExecTarget, argv: readonly string[], opts: ExecRunOptions): Promise<ExecOutcome> {
  if (!Number.isSafeInteger(opts.maxStdoutBytes) || opts.maxStdoutBytes < 0) {
    throw new ExecStreamError("usage", "maxStdoutBytes must be a non-negative safe integer; pass the output size you can accept");
  }
  const maxErr = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const session = await openExec(connect, target, argv, {
    stdin: opts.stdin !== undefined,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.drainMs === undefined ? {} : { drainMs: opts.drainMs }),
  });
  const out: Uint8Array[] = [];
  let outBytes = 0;
  const err: Uint8Array[] = [];
  let errBytes = 0;
  const stdin = opts.stdin;
  const writer =
    stdin === undefined
      ? undefined
      : (async () => {
          await session.write(stdin);
          await session.closeStdin();
        })();
  let writeError: unknown;
  writer?.catch((e: unknown) => {
    writeError = e;
  });
  try {
    for await (const ev of session.events()) {
      if (ev.type === "stdout") {
        outBytes += ev.data.length;
        if (outBytes > opts.maxStdoutBytes) throw new ExecOutputCapError(opts.maxStdoutBytes);
        out.push(ev.data);
      } else if (ev.type === "stderr") {
        err.push(ev.data);
        errBytes += ev.data.length;
        while (errBytes > maxErr && err.length > 1) errBytes -= (err.shift() as Uint8Array).length;
      } else {
        const joined = Buffer.concat(err);
        return {
          exitCode: ev.exitCode,
          stdout: Buffer.concat(out),
          stderr: tailUtf8(joined, maxErr),
        };
      }
    }
  } catch (e) {
    if (e instanceof ExecStreamError && e.kind === "dropped" && writer !== undefined) {
      // A failed stdin write is the root cause of the drop it provoked; let its rejection handler run before deciding.
      await new Promise((r) => setImmediate(r));
      if (writeError !== undefined) throw writeError;
    }
    throw e;
  }
  throw new ExecStreamError("dropped", droppedMessage("no exit event"));
}

// The kit's ExecFn shape (with optional stdin), bound to one pod.
export type ExecWithStdinFn = (argv: string[], opts: { maxStdoutBytes: number; stdin?: Uint8Array }) => Promise<ExecOutcome>;

export function createExecFn(
  connect: ConnectFn,
  target: ExecTarget,
  base: { signal?: AbortSignal; maxStderrBytes?: number; drainMs?: number } = {},
): ExecWithStdinFn {
  return (argv, opts) =>
    exec(connect, target, argv, {
      maxStdoutBytes: opts.maxStdoutBytes,
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      ...(base.signal === undefined ? {} : { signal: base.signal }),
      ...(base.maxStderrBytes === undefined ? {} : { maxStderrBytes: base.maxStderrBytes }),
      ...(base.drainMs === undefined ? {} : { drainMs: base.drainMs }),
    });
}

// ---- mux carrier ----

// A MuxPair over an exec'd relay process: mux bytes go to its stdin and come back on its stdout. The relay is a long-lived
// process in the pod; its stderr goes to `onStderr`. The output ends cleanly when the relay exits 0 or the pair is closed, and
// throws when the relay exits non-zero or the stream drops (the mux then fails every connection and the adapter re-execs).
export function execMuxPair(session: ExecSession, opts: { onStderr?: (text: string) => void } = {}): MuxPair {
  let used = false;
  return {
    write: (data) => session.write(data),
    output: () => {
      if (used) throw new ExecStreamError("usage", "the exec mux pair's output can be read once; open a new relay exec for a new mux");
      used = true;
      return (async function* () {
        for await (const ev of session.events()) {
          if (ev.type === "stdout") yield ev.data;
          else if (ev.type === "stderr") opts.onStderr?.(Buffer.from(ev.data).toString("utf8"));
          else if (ev.exitCode !== 0) {
            throw new ExecStreamError(
              "dropped",
              `the relay process in the pod exited with code ${ev.exitCode}, so the sandbox link is down; check the relay command and image, then reattach`,
            );
          }
        }
      })();
    },
    close: () => {
      void session.close();
    },
  };
}

// Opens the relay exec and starts a mux on it. `argv` is the worker image's relay entry.
export async function openExecMux(
  connect: ConnectFn,
  target: ExecTarget,
  argv: readonly string[],
  muxOpts: MuxOptions,
  opts: { signal?: AbortSignal; onStderr?: (text: string) => void } = {},
): Promise<Mux> {
  const session = await openExec(connect, target, argv, { stdin: true, ...(opts.signal === undefined ? {} : { signal: opts.signal }) });
  return createMux(execMuxPair(session, opts.onStderr === undefined ? {} : { onStderr: opts.onStderr }), muxOpts);
}
