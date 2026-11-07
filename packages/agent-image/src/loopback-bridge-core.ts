// Pure core of the in-container loopback bridge (shell: loopback-bridge.ts). The daemon runs
// `node /opt/pomtree/loopback-bridge.ts <port>` through a non-TTY docker exec and speaks raw bytes over its stdin and stdout to a
// service on container loopback (Chromium's DevTools port). The only argument is a port, and only ports in the image's
// LOOPBACK_PORTS allowlist are served; there is no host, no env and no other option.
//
// Exit codes: 0 normal end (also when the daemon side went away with EPIPE), 64 bad usage or a port that is not allowed, 69 the connect failed,
// 70 a stream error after connect (socket, stdin or stdout). One reason line on stderr for each non-zero exit.
import type { Readable, Writable } from "node:stream";

export const BRIDGE_EXIT_OK = 0;
export const BRIDGE_EXIT_USAGE = 64;
export const BRIDGE_EXIT_UNAVAILABLE = 69;
export const BRIDGE_EXIT_STREAM = 70;
export const BRIDGE_HOST = "127.0.0.1";

export type BridgeArgs = { port: number } | { exit: typeof BRIDGE_EXIT_USAGE; reason: string };

export function parseBridgeArgs(argv: readonly string[], allowed: readonly number[]): BridgeArgs {
  const list = allowed.join(", ");
  if (argv.length !== 1 || argv[0] === undefined) {
    return { exit: BRIDGE_EXIT_USAGE, reason: `loopback-bridge takes exactly one argument, a port; run it as "loopback-bridge <port>" with one of: ${list}` };
  }
  const text = argv[0];
  const port = /^(?:0|[1-9][0-9]{0,4})$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || !allowed.includes(port)) {
    return { exit: BRIDGE_EXIT_USAGE, reason: `loopback-bridge port "${text}" is not allowed; use one of: ${list}` };
  }
  return { port };
}

/** The slice of a net.Socket the bridge uses; a test supplies a fake. */
export type BridgeSocket = Readable &
  Writable & {
    once(event: "connect", listener: () => void): unknown;
  };
export type BridgeConnect = (port: number, host: string) => BridgeSocket;
export interface BridgeIo {
  stdin: Readable;
  stdout: Writable;
  stderr: { write(line: string): unknown };
  connect: BridgeConnect;
}

/** Runs one bridge and resolves to the process exit code. stdin ends the socket's write side; the socket's end ends stdout after it flushes. */
export function runBridge(argv: readonly string[], allowed: readonly number[], io: BridgeIo): Promise<number> {
  const parsed = parseBridgeArgs(argv, allowed);
  if ("exit" in parsed) {
    io.stderr.write(`${parsed.reason}\n`);
    return Promise.resolve(parsed.exit);
  }
  const { port } = parsed;
  return new Promise<number>((resolve) => {
    const socket = io.connect(port, BRIDGE_HOST);
    let connected = false;
    let settled = false;
    const finish = (code: number, reason?: string) => {
      if (settled) return;
      settled = true;
      if (reason) io.stderr.write(`${reason}\n`);
      socket.destroy();
      resolve(code);
    };
    socket.once("connect", () => {
      connected = true;
      io.stdin.pipe(socket, { end: true });
      // Half-close: stdout ends (and flushes) when the socket's read side ends, whatever stdin is still doing.
      socket.pipe(io.stdout, { end: false });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected) {
        finish(
          BRIDGE_EXIT_UNAVAILABLE,
          `loopback-bridge cannot reach ${BRIDGE_HOST}:${port} (${error.code ?? error.message}); is the service running in this container? Start it, then retry`,
        );
      } else {
        finish(
          BRIDGE_EXIT_STREAM,
          `loopback-bridge connection to ${BRIDGE_HOST}:${port} failed after connect (${error.code ?? error.message}); the stream was closed`,
        );
      }
    });
    // The daemon dropping the exec closes stdout (EPIPE) or errors stdin: EPIPE is a peer that went away, so a clean end; anything else is a stream error.
    const onStdio = (name: string) => (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return finish(BRIDGE_EXIT_OK);
      finish(BRIDGE_EXIT_STREAM, `loopback-bridge ${name} failed (${error.code ?? error.message}); the stream was closed, so retry the exec`);
    };
    io.stdin.on("error", onStdio("stdin"));
    io.stdout.on("error", onStdio("stdout"));
    // Resolve only after stdout has taken every byte the socket delivered.
    socket.on("end", () => io.stdout.write("", () => finish(BRIDGE_EXIT_OK)));
    socket.on("close", () => {
      if (!connected) return;
      io.stdout.write("", () => finish(BRIDGE_EXIT_OK));
    });
  });
}
