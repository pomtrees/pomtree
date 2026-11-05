import { createHash } from "node:crypto";
import { join } from "node:path";

// macOS caps sun_path at 104 bytes and Linux at 108; stay under both with room for the NUL.
export const MAX_SOCKET_PATH = 100;

export interface ResolvedSocket {
  path: string;
  fellBack: boolean;
}

// A too-long path would crash listen() with EINVAL; fall back to a short per-state-dir path under tmpdir.
export function resolveSocketPath(wanted: string, tmpdir: string, max = MAX_SOCKET_PATH): ResolvedSocket {
  if (Buffer.byteLength(wanted) <= max) return { path: wanted, fellBack: false };
  const tag = createHash("sha256").update(wanted).digest("hex").slice(0, 10);
  const path = join(tmpdir, `pomtreed-${tag}`, "pomtreed.sock");
  if (Buffer.byteLength(path) > max) {
    throw new Error(
      `socket path is ${Buffer.byteLength(wanted)} bytes (limit ${max}) and the tmpdir fallback ${path} is also too long; set POMTREED_SOCKET_PATH to a shorter path`,
    );
  }
  return { path, fellBack: true };
}
