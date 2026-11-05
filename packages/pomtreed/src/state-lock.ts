import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Identity of a process for stale-lock detection: the boot it ran in and its start time. Either may be
// null when the platform probe fails; a null on either side means "unknown", never "mismatch".
export type ProcIdentity = { boot: string | null; start: string | null };
export type LockRecord = { pid: number } & ProcIdentity;

export function formatLock(rec: LockRecord): string {
  let out = `${rec.pid}\n`;
  if (rec.boot !== null) out += `boot=${rec.boot}\n`;
  if (rec.start !== null) out += `start=${rec.start}\n`;
  return out;
}

// Parse a lock file: first line is the pid; optional `boot=`/`start=` lines. A file lacking the identity
// fields yields nulls (unknown identity, so the caller falls back to pid liveness alone).
export function parseLock(raw: string): LockRecord | null {
  const lines = raw.split("\n").map((l) => l.trim());
  const pid = Number(lines[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let boot: string | null = null;
  let start: string | null = null;
  for (const l of lines.slice(1)) {
    if (l.startsWith("boot=")) boot = l.slice(5) || null;
    else if (l.startsWith("start=")) start = l.slice(6) || null;
  }
  return { pid, boot, start };
}

// Pure decision: is the recorded holder still the live process that took the lock? `current` is the
// probed identity of the recorded pid right now (null when the pid is dead); `nowBoot` is this boot's id.
export function lockHeld(rec: LockRecord, alive: boolean, currentStart: string | null, nowBoot: string | null): boolean {
  if (!alive) return false;
  if (rec.boot !== null && nowBoot !== null && rec.boot !== nowBoot) return false;
  if (rec.start !== null && currentStart !== null && rec.start !== currentStart) return false;
  return true;
}

export function bootId(): string | null {
  try {
    if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    if (process.platform === "darwin") {
      return execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2000 }).trim() || null;
    }
  } catch {
    // unknown
  }
  return null;
}

export function processStart(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces/parens; fields after the last ')' start at state (field 3); starttime is field 22.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return rest[19] || null;
    }
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
        env: { ...process.env, LC_ALL: "C" },
      }).trim() || null
    );
  } catch {
    return null;
  }
}
