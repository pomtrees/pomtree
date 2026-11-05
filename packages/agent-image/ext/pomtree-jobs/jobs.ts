// Pure logic for the 'pomtree-jobs' Pi extension (TODO(background-jobs) v1). No Pi or process coupling:
// validation, ids/paths, status derivation from file contents, tail/ANSI strip, wrapper command construction.
export const JOBS_ROOT = "/workspace/.jobs";
export const WRAPPER = "pomtree-job-run";
export const MAX_LIVE_JOBS = 8;
export const MAX_TIMEOUT_S = 4 * 3600;
export const MAX_WAIT_MS = 25_000; // per-call slice: steering is only delivered between tool calls, so keep calls short; the agent loops
export const TAIL_MAX_LINES = 200;
export const TAIL_MAX_BYTES = 32 * 1024;

export interface JobMeta {
  id: string;
  name: string;
  cmd: string;
  startedAt: string;
  timeoutS: number;
}
export interface JobExit {
  code: number;
  signal: string;
  endedAt: string;
}
export type JobState = "running" | "exited" | "timeout" | "killed" | "lost";
export interface JobStatus {
  id: string;
  name: string;
  state: JobState;
  pid?: number;
  code?: number;
  signal?: string;
  startedAt?: string;
  endedAt?: string;
  timeoutS?: number;
}

export function sanitizeName(raw: string | undefined, fallback: string): string {
  const n = (raw ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return n || fallback;
}

export function newId(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

export const isValidId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{6}$/.test(id);
export const jobDir = (id: string, root = JOBS_ROOT) => `${root}/${id}`;

// Cap at the agent deadline (ISO in POMTREE_AGENT_DEADLINE_AT, if the daemon provides it) else 4h.
export function maxTimeoutS(env: Record<string, string | undefined>, nowMs: number): number {
  const d = Date.parse(env.POMTREE_AGENT_DEADLINE_AT ?? "");
  if (Number.isNaN(d)) return MAX_TIMEOUT_S;
  return Math.max(1, Math.min(MAX_TIMEOUT_S, Math.floor((d - nowMs) / 1000)));
}

export function validateStart(
  a: { cmd?: unknown; timeout_s?: unknown; name?: unknown },
  liveCount: number,
  env: Record<string, string | undefined>,
  nowMs: number,
): { ok: true; cmd: string; timeoutS: number; name?: string } | { ok: false; error: string } {
  if (typeof a.cmd !== "string" || !a.cmd.trim()) return { ok: false, error: "cmd is required" };
  if (typeof a.timeout_s !== "number" || !Number.isFinite(a.timeout_s) || a.timeout_s <= 0)
    return { ok: false, error: "timeout_s is required and must be a positive number" };
  if (liveCount >= MAX_LIVE_JOBS) return { ok: false, error: `too many live jobs (max ${MAX_LIVE_JOBS}); kill or wait for one first` };
  const cap = maxTimeoutS(env, nowMs);
  return { ok: true, cmd: a.cmd, timeoutS: Math.min(Math.ceil(a.timeout_s), cap), name: typeof a.name === "string" ? a.name : undefined };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The bash command that creates the job dir + meta and launches the wrapper (which prints the pid).
export function startCommand(meta: JobMeta, root = JOBS_ROOT): string {
  const dir = jobDir(meta.id, root);
  const metaJson = JSON.stringify(meta);
  return [
    `mkdir -p ${shellQuote(dir)}`,
    `{ [ -f ${shellQuote(root + "/.gitignore")} ] || printf '*\\n' > ${shellQuote(root + "/.gitignore")}; }`,
    `printf '%s\\n' ${shellQuote(metaJson)} > ${shellQuote(dir + "/meta.json")}`,
    `${WRAPPER} ${shellQuote(dir)} ${meta.timeoutS} ${shellQuote(meta.cmd)}`,
  ].join(" && ");
}

// TERM the job's process group (the wrapper is the session/group leader and TERMs/KILLs its command after 5s).
export function killCommand(pid: number): string {
  return `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null; true`;
}

export function parseMeta(text: string | undefined): JobMeta | undefined {
  try {
    const m = JSON.parse(text ?? "");
    if (m && typeof m.id === "string" && typeof m.cmd === "string")
      return { id: m.id, name: String(m.name ?? m.id), cmd: m.cmd, startedAt: String(m.startedAt ?? ""), timeoutS: Number(m.timeoutS) || 0 };
  } catch {
    /* fallthrough */
  }
  return undefined;
}

export function parseExit(text: string | undefined): JobExit | undefined {
  if (text === undefined) return undefined;
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  if (kv.code === undefined || !/^\d+$/.test(kv.code)) return undefined; // partial/garbled: treat as no exit file
  return { code: Number(kv.code), signal: kv.signal ?? "", endedAt: kv.endedAt ?? "" };
}

export function deriveStatus(id: string, f: { meta?: string; pid?: string; exit?: string }, alive: (pid: number) => boolean): JobStatus {
  const meta = parseMeta(f.meta);
  const base = { id, name: meta?.name ?? id, startedAt: meta?.startedAt, timeoutS: meta?.timeoutS };
  const pid = f.pid && /^\d+$/.test(f.pid.trim()) ? Number(f.pid.trim()) : undefined;
  const ex = parseExit(f.exit);
  if (ex) {
    const state: JobState = ex.signal === "TIMEOUT" ? "timeout" : ex.signal === "KILLED" ? "killed" : "exited";
    return { ...base, state, pid, code: ex.code, signal: ex.signal || undefined, endedAt: ex.endedAt };
  }
  if (pid !== undefined && alive(pid)) return { ...base, state: "running", pid };
  // No live pid and no exit file: died with the container (or before writing its pid). Never restarted.
  return { ...base, state: "lost", pid };
}

export function formatStatus(s: JobStatus): string {
  const parts = [`${s.id} ${s.name}: ${s.state === "lost" ? "lost (container restarted; not restarted)" : s.state}`];
  if (s.pid !== undefined) parts.push(`pid=${s.pid}`);
  if (s.code !== undefined) parts.push(`code=${s.code}`);
  if (s.signal) parts.push(`signal=${s.signal}`);
  if (s.startedAt) parts.push(`started=${s.startedAt}`);
  if (s.endedAt) parts.push(`ended=${s.endedAt}`);
  return parts.join(" ");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function tailText(raw: string, lines = 50): string {
  const n = Math.max(1, Math.min(TAIL_MAX_LINES, Math.floor(Number.isFinite(lines) ? lines : 50)));
  let out = stripAnsi(raw).replace(/\r\n?/g, "\n").split("\n");
  if (out[out.length - 1] === "") out.pop();
  out = out.slice(-n);
  let text = out.join("\n");
  if (Buffer.byteLength(text) > TAIL_MAX_BYTES) text = "[truncated]\n" + Buffer.from(text).subarray(-TAIL_MAX_BYTES).toString("utf8");
  return text;
}

export const clampWaitMs = (ms: unknown) => Math.max(0, Math.min(MAX_WAIT_MS, typeof ms === "number" && Number.isFinite(ms) ? ms : 0));

// Abortable poll: resolves "done" when isDone() turns true, "timeout" at ms (clamped), "interrupted" as soon as the
// signal aborts. Timers and the abort listener are always cleared on every exit path; nothing is held afterwards.
export function waitFor(
  isDone: () => boolean,
  ms: unknown,
  signal?: { aborted: boolean; addEventListener(t: "abort", f: () => void, o?: { once: boolean }): void; removeEventListener(t: "abort", f: () => void): void },
  pollMs = 250,
): Promise<"done" | "timeout" | "interrupted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve("interrupted");
    if (isDone()) return resolve("done");
    const end = Date.now() + clampWaitMs(ms);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: "done" | "timeout" | "interrupted") => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish("interrupted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const step = () => {
      if (isDone()) return finish("done");
      const left = end - Date.now();
      if (left <= 0) return finish("timeout");
      timer = setTimeout(step, Math.min(pollMs, left));
    };
    step();
  });
}
