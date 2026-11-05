// Host reads and writes of agent-writable trees (the bind-mounted session dir: session.jsonl, events.jsonl). The agent controls
// what sits at those paths, so a plain open by path follows a planted symlink to a sibling's session or /dev/zero, and blocks the
// daemon's only thread forever on a FIFO. Every such open goes through here: O_NOFOLLOW (a symlink is refused, never followed),
// O_NONBLOCK (a FIFO opens at once instead of waiting for a writer), then fstat on the open descriptor must say a regular file
// within the size bound. The policy (`checkOpen`) is pure; the fs calls are the thin shell below it.
// TODO(session-fs): the target design streams the session and events out of the container (like result-work.ts), so no host
// code opens agent-writable paths at all; current behavior: every host open of those paths goes through this guard.
import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";

export type FileKind = "file" | "directory" | "symlink" | "fifo" | "device" | "socket" | "other";
export type SafeOpenRefusal = "symlink" | "fifo" | "device" | "socket" | "directory" | "not-regular" | "oversize" | "hardlink";

// A conversation that outgrows this is refused rather than read into memory whole (it is read on every yield).
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export class SafeOpenError extends Error {
  readonly path: string;
  readonly refusal: SafeOpenRefusal;
  // What was found and why it is refused, without the path ("it is a FIFO (...)").
  readonly detail: string;
  constructor(path: string, refusal: SafeOpenRefusal, detail: string) {
    super(refusalMessage(path, detail));
    this.name = "SafeOpenError";
    this.path = path;
    this.refusal = refusal;
    this.detail = detail;
  }
  // The same refusal naming the file as `shownPath`: the agent is told its container path, never the host one.
  describe(shownPath: string): string {
    return refusalMessage(shownPath, this.detail);
  }
}

const ACTION =
  "the agent's session directory is agent-writable, so pomtreed refuses anything but a regular file there; remove the entry (or stop and re-spawn the agent) and retry";
const refusalMessage = (path: string, detail: string) => `refusing to open ${path}: ${detail}; ${ACTION}`;

// Pure policy: what an lstat/fstat result plus size means for an open of `path`. `maxBytes` undefined is no size bound. `nlink` is
// passed only by writers: a regular file with other hard links is refused, since writing it would modify the other linked file too.
export function checkOpen(path: string, kind: FileKind, size: number, maxBytes?: number, nlink?: number): { ok: true } | { ok: false; error: SafeOpenError } {
  const refuse = (refusal: SafeOpenRefusal, what: string) => ({ ok: false, error: new SafeOpenError(path, refusal, what) }) as const;
  switch (kind) {
    case "file":
      if (nlink !== undefined && nlink > 1) return refuse("hardlink", `it has ${nlink} hard links (writing it would also modify the other linked files)`);
      if (maxBytes !== undefined && size > maxBytes) return refuse("oversize", `it is ${size} bytes, over the ${maxBytes}-byte bound`);
      return { ok: true };
    case "symlink":
      return refuse("symlink", "it is a symbolic link (it could point at another agent's session or a device)");
    case "fifo":
      return refuse("fifo", "it is a FIFO (reading it would block the daemon)");
    case "device":
      return refuse("device", "it is a device node");
    case "socket":
      return refuse("socket", "it is a socket");
    case "directory":
      return refuse("directory", "it is a directory");
    default:
      return refuse("not-regular", "it is not a regular file");
  }
}

export function kindOf(st: Stats): FileKind {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isCharacterDevice() || st.isBlockDevice()) return "device";
  if (st.isSocket()) return "socket";
  return "other";
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const assertOk = (r: ReturnType<typeof checkOpen>): void => {
  if (!r.ok) throw r.error;
};

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const isLoop = (e: unknown) => code(e) === "ELOOP" || code(e) === "EMLINK";

// Opens `path` read-only without following a final symlink or blocking on a FIFO, and checks the open descriptor. Returns the fd
// and its size, or null when nothing is there (ENOENT). Throws SafeOpenError on a refusal; the caller closes the fd.
export function safeOpenRead(path: string, maxBytes?: number): { fd: number; size: number } | null {
  // lstat first so a device or FIFO is refused without being opened at all; the fstat below is the authoritative check.
  let pre: Stats;
  try {
    pre = lstatSync(path);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    throw e;
  }
  assertOk(checkOpen(path, kindOf(pre), pre.size, maxBytes));
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    // Swapped for a symlink between the lstat and the open: O_NOFOLLOW fails with ELOOP (EMLINK on the BSDs).
    if (isLoop(e)) assertOk(checkOpen(path, "symlink", 0));
    throw e;
  }
  try {
    const st = fstatSync(fd);
    assertOk(checkOpen(path, kindOf(st), st.size, maxBytes));
    return { fd, size: st.size };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

// The whole file, or null when absent: the same lstat / O_NOFOLLOW|O_NONBLOCK / fstat checks as safeOpenRead, through an async
// FileHandle so a large session does not hold the event loop. Reads only up to the size fstat reported.
export async function safeReadFile(path: string, maxBytes: number): Promise<Uint8Array | null> {
  let pre: Stats;
  try {
    pre = await lstat(path);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    throw e;
  }
  assertOk(checkOpen(path, kindOf(pre), pre.size, maxBytes));
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, READ_FLAGS);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    if (isLoop(e)) assertOk(checkOpen(path, "symlink", 0));
    throw e;
  }
  try {
    const st = await fh.stat();
    assertOk(checkOpen(path, kindOf(st), st.size, maxBytes));
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, off);
  } finally {
    await fh.close();
  }
}

// Writes `bytes` to `path` without ever writing through what the agent planted there:
// - a regular file is rewritten in place (O_NOFOLLOW|O_NONBLOCK, fstat re-checked, then truncated), so it keeps its inode, owner
//   and mode exactly as writeFileSync did; the container user (uid 1000) can still append to the file it created;
// - nothing there: created O_EXCL|O_NOFOLLOW with mode 0o666 less the umask, the mode writeFileSync gives a new file;
// - a symlink, FIFO, device or socket: the entry itself is unlinked (never its target) and the file created fresh as above;
// - a regular file with other hard links (nlink > 1): refused before truncating, since the write would also change the other linked
//   file (unlink-and-recreate would avoid the refusal but changes the inode, owner and mode guarantee above);
// - a directory: refused.
export async function safeWriteFile(path: string, bytes: Uint8Array): Promise<void> {
  let kind: FileKind | null = null;
  try {
    kind = kindOf(await lstat(path));
  } catch (e) {
    if (code(e) !== "ENOENT") throw e;
  }
  if (kind === "directory") assertOk(checkOpen(path, "directory", 0));
  let fh: Awaited<ReturnType<typeof open>>;
  if (kind === "file") {
    try {
      fh = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e) {
      // Swapped between the lstat and the open: a symlink (ELOOP) or a FIFO with no reader (ENXIO) is refused, not followed.
      if (isLoop(e)) assertOk(checkOpen(path, "symlink", 0));
      if (code(e) === "ENXIO") assertOk(checkOpen(path, "fifo", 0));
      throw e;
    }
    try {
      const st = await fh.stat();
      assertOk(checkOpen(path, kindOf(st), 0, undefined, st.nlink)); // before truncating, so a hard-linked file is never touched
      await fh.truncate(0);
    } catch (e) {
      await fh.close();
      throw e;
    }
  } else {
    if (kind !== null) await unlink(path);
    try {
      fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
    } catch (e) {
      if (code(e) === "EEXIST") assertOk(checkOpen(path, "other", 0)); // re-planted between the unlink and the create
      throw e;
    }
  }
  try {
    let off = 0;
    while (off < bytes.length) off += (await fh.write(bytes, off, bytes.length - off, off)).bytesWritten;
  } finally {
    await fh.close();
  }
}
