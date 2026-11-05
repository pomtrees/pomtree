// Pure host-level guards used by main.ts (TODO(admission-capacity), TODO(host-misc)).
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { CONFIG_DEFAULTS, type SandboxId } from "@pomtree/core";

// The registry default of capacity.containerMemoryBytes (one source); main.ts also passes it as the containers' real --memory.
export const DEFAULT_CONTAINER_MEMORY_BYTES = CONFIG_DEFAULTS["capacity.containerMemoryBytes"];

// Admission by reserved memory: one more container must fit in `fraction` of host memory
// (TODO(admission-capacity): host RAM stands in for `docker info` MemTotal; they differ only with a remote Docker).
export function memoryGate(o: { running: number; perContainerBytes: number; totalBytes: number; fraction: number }): { ok: boolean; reason?: string } {
  const need = (o.running + 1) * o.perContainerBytes;
  const limit = o.totalBytes * o.fraction;
  if (!(need <= limit)) return { ok: false, reason: `memory reservation exceeded (${o.running + 1} x ${o.perContainerBytes} > ${Math.floor(limit)} bytes)` };
  return { ok: true };
}

// Runtime statuses (Sandbox.inspect `status`) that prove a container holds no memory.
const NO_MEMORY_STATUSES: ReadonlySet<string> = new Set(["exited", "dead"]);

// How many listed containers hold memory for the memory gate. Fail safe: every container counts except one whose state proves
// it holds none, i.e. status exited or dead (a held custody child, a finished agent awaiting reap) or already removed (inspect
// null). Created (about to start), running, paused, restarting, removing, an unrecognized or absent status (`running: false`
// alone cannot tell created from exited), and an unreadable state (inspect throws) all count.
export async function memoryHolders(
  listed: readonly { id: SandboxId }[],
  inspect: (id: SandboxId) => Promise<{ running: boolean; status?: string } | null>,
): Promise<number> {
  const held = await Promise.all(
    listed.map((c) =>
      inspect(c.id).then(
        (s) => s !== null && !(s.status !== undefined && NO_MEMORY_STATUSES.has(s.status)),
        () => true,
      ),
    ),
  );
  return held.filter(Boolean).length;
}

// A secret file readable by group/other is a leak (TODO(host-misc)). Returns the offending mode or null.
export function looseMode(path: string): number | null {
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o077) !== 0 ? mode : null;
}

// Writes a secret file at 0600, tightening a pre-existing file's mode first, and refuses if it stays loose.
export function writeSecretFile(path: string, data: string): void {
  if (existsSync(path)) chmodSync(path, 0o600);
  writeFileSync(path, data, { mode: 0o600 });
  const bad = looseMode(path);
  if (bad !== null) throw new Error(`${path} is mode ${bad.toString(8)}; refusing to start with a group/other-readable secret`);
}

// Pins the agent endpoint port across restarts: a ":0" listen reuses the last chosen port
// recorded in `file`, so POMTREE_API baked into surviving containers stays valid. An explicit port is untouched.
export function pinnedAgentPort(listen: string, file: string): { listen: string; remember: (port: number) => void } {
  const i = listen.lastIndexOf(":");
  const host = listen.slice(0, i);
  const port = Number(listen.slice(i + 1));
  if (port !== 0) return { listen, remember: () => {} };
  let saved = 0;
  try {
    saved = Number(readFileSync(file, "utf8").trim());
  } catch {
    /* first start */
  }
  return {
    listen: Number.isInteger(saved) && saved > 0 && saved < 65536 ? `${host}:${saved}` : listen,
    remember: (p) => {
      try {
        writeFileSync(file, String(p), { mode: 0o600 });
      } catch {
        /* best-effort */
      }
    },
  };
}
