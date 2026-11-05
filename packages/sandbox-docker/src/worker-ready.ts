import { constants } from "node:os";
import { NODE_BIN, PI_BIN } from "./container-contract.gen.ts";

// Pure ownership decision for the egress socket volume. Inputs are plain stat values so this runs without fs.
export const TMPFS_MAGIC = 0x01021994;
export const EGRESS_GID = 1000;

export type DirStat = { isDirectory: boolean; isSymbolicLink: boolean; uid: number; gid: number; mode: number };
export type SocketStat = { isSocket: boolean; uid: number; gid: number; mode: number };

// Returns the first failed check, or undefined when the socket volume is safe to use.
export function socketOwnershipProblem(dir: DirStat, fsType: number, socket: SocketStat): string | undefined {
  if (!dir.isDirectory) return "socket directory is not a directory";
  if (dir.isSymbolicLink) return "socket directory is a symbolic link";
  if (dir.uid === 0) return "socket directory is owned by root";
  if (dir.gid !== EGRESS_GID) return "socket directory gid is not 1000";
  if ((dir.mode & 0o777) !== 0o770) return "socket directory mode is not 0770";
  if (fsType !== TMPFS_MAGIC) return "socket directory is not tmpfs";
  if (!socket.isSocket) return "egress path is not a socket";
  if (socket.uid !== dir.uid) return "socket uid differs from directory uid";
  if (socket.gid !== EGRESS_GID) return "socket gid is not 1000";
  return undefined;
}

// Exit code the worker reports for its child. A real exit code wins. A signal-killed child (e.g. the
// daemon's `docker stop` SIGTERM) maps to the shell convention 128 + signal number. Anything else is 1.
export function childExitCode(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  if (signal === null || !Object.hasOwn(constants.signals, signal)) return 1;
  return 128 + constants.signals[signal as keyof typeof constants.signals];
}

// What the worker starts. The image's PATH begins with agent-writable /workspace/.env/*/bin, so no command is found through it:
// Pi runs as NODE_BIN plus the realpath of PI_BIN (as browser-run.ts does), any other bare name is looked up in FIXED_PATH only,
// and the browser run goes through browser-run.ts under the worker's own node. A name with a slash is taken as the operator wrote it.
export const BROWSER_RUN = "/opt/pomtree/browser-run.ts";
// The model-free capture worker (agent-image). The one command a browser worker may start without browser-run.ts, matched exactly.
export const CAPTURE_WORKER = "/opt/pomtree/capture-worker.ts";
export type LaunchFs = { realpath: (path: string) => string; executable: (path: string) => boolean };
export function workerLaunch(
  cmd: string,
  args: readonly string[],
  opts: { browser: boolean; execPath: string; fixedPath: string; fs: LaunchFs },
): { file: string; args: string[] } {
  if (opts.browser && cmd === NODE_BIN && args.length === 1 && args[0] === CAPTURE_WORKER) return { file: NODE_BIN, args: [CAPTURE_WORKER] };
  if (opts.browser) return { file: opts.execPath, args: [BROWSER_RUN, cmd, ...args] };
  if (cmd === "pi") return { file: NODE_BIN, args: [opts.fs.realpath(PI_BIN), ...args] };
  if (cmd.includes("/")) return { file: cmd, args: [...args] };
  for (const dir of opts.fixedPath.split(":")) {
    const candidate = `${dir}/${cmd}`;
    if (opts.fs.executable(candidate)) return { file: candidate, args: [...args] };
  }
  throw new Error(`worker command not found in the fixed path: ${cmd}`);
}
