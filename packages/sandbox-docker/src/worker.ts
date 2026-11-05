// Byte bridge only: no HTTP parser, DNS, destination dial or connection limits in the network-none worker.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync, statfsSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  EGRESS_BROWSER_PROXY_PORT,
  EGRESS_BROWSER_SOCKET_NAME,
  EGRESS_PROXY_PORT,
  EGRESS_SOCKET_DIR,
  EGRESS_SOCKET_NAME,
  FIXED_PATH,
} from "./container-contract.gen.ts";
import { childExitCode, socketOwnershipProblem, workerLaunch } from "./worker-ready.ts";

export function attachByteBridge(socketPath: string, port = EGRESS_PROXY_PORT) {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    if (sockets.size >= 64) {
      client.destroy();
      return;
    }
    const upstream = connect(socketPath);
    sockets.add(client);
    sockets.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    // No idle or absolute timer here: the bridge cannot tell a relay stream from a public tunnel, so the sidecar proxy owns every
    // per-class limit and its teardown closes the upstream end, which closes this pair.
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 32;
  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
    close: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
    },
  };
}
export async function ready(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) {
      const dir = lstatSync(dirname(path));
      const socket = lstatSync(path);
      const problem = socketOwnershipProblem(
        { isDirectory: dir.isDirectory(), isSymbolicLink: dir.isSymbolicLink(), uid: dir.uid, gid: dir.gid, mode: dir.mode },
        statfsSync(dirname(path)).type,
        { isSocket: socket.isSocket(), uid: socket.uid, gid: socket.gid, mode: socket.mode },
      );
      if (problem !== undefined) throw new Error("unsupported or unsafe egress socket volume ownership");
      if ((socket.mode & 0o777) === 0o660) {
        await new Promise<void>((resolve, reject) => {
          const s = connect(path, () => {
            s.destroy();
            resolve();
          });
          s.once("error", reject);
        });
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("egress socket unavailable; Docker tmpfs UID/GID mapping or sidecar startup unsupported");
}
async function main(): Promise<void> {
  const socketPath = `${EGRESS_SOCKET_DIR}/${EGRESS_SOCKET_NAME}`;
  await ready(socketPath);
  const bridge = attachByteBridge(socketPath);
  await bridge.listen();
  // Chromium gets its own listener, whose sidecar side has no relay authorities.
  const browser = process.env.PTREE_BROWSER === "1";
  const browserBridge = browser ? attachByteBridge(`${EGRESS_SOCKET_DIR}/${EGRESS_BROWSER_SOCKET_NAME}`, EGRESS_BROWSER_PROXY_PORT) : undefined;
  if (browserBridge) {
    await ready(`${EGRESS_SOCKET_DIR}/${EGRESS_BROWSER_SOCKET_NAME}`);
    await browserBridge.listen();
  }
  let child: ChildProcess | undefined;
  let kill: NodeJS.Timeout | undefined;
  const stop = () => {
    bridge.close();
    browserBridge?.close();
    child?.kill("SIGTERM");
    kill ??= setTimeout(() => child?.kill("SIGKILL"), 1000);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    bridge.close();
    browserBridge?.close();
    throw new Error("worker requires an explicit command");
  }
  // Nothing is found through PATH: it starts with agent-writable /workspace/.env/*/bin (see workerLaunch).
  const launch = workerLaunch(cmd, args, {
    browser,
    execPath: process.execPath,
    fixedPath: FIXED_PATH,
    fs: {
      realpath: realpathSync,
      executable: (path) => {
        try {
          accessSync(path, constants.X_OK);
          return statSync(path).isFile();
        } catch {
          return false;
        }
      },
    },
  });
  const launched = spawn(launch.file, launch.args, { env: process.env, stdio: "inherit" });
  child = launched;
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      launched.once("exit", (code, signal) => resolve(childExitCode(code, signal)));
      launched.once("error", reject);
    });
  } finally {
    bridge.close();
    browserBridge?.close();
    if (kill) clearTimeout(kill);
  }
}
if (import.meta.main) await main();
