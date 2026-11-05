// `capture_finish` core: the model's only way to end a browser run. Pure of Pi so it is unit-testable; index.ts registers it as a tool.
// It runs `pomtree result` with a fixed argv and env (no PATH lookup, no result JSON, no --summary-file, no --save-uncommitted), and its
// outcome text never carries the child's stdout/stderr, so POMTREE_TOKEN (in the child's env) cannot reach the model. A failure's exit code
// or timeout is model-visible; its redacted, bounded stderr tail is returned separately for the operator-only failure entry.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { pomtreeFailureDetail, pomtreeFailureNote, type PomtreeFailureDetail } from "./capture-diagnostic.ts";
// The image facts come from this directory's generated copy of the container contract (core image-facts.ts); MAX_HANDOFF_BYTES is
// the daemon's handoff summary cap, so a summary this sanitizer keeps is one the daemon accepts.
import { CLI_POMTREE_MAIN, CONTAINER_CONFIG_ENV, FIXED_PATH, MAX_HANDOFF_BYTES, PROXY_ENV_NAMES } from "./container-contract.gen.ts";

export const FINISH_STATUSES = ["succeeded", "failed"] as const;
export type FinishStatus = (typeof FINISH_STATUSES)[number];
export const FINISH_TIMEOUT_MS = 30_000;

// Strips C0/C1 control characters (newline and tab included) and caps at 8 KiB of UTF-8 without splitting a code point.
export function sanitizeSummary(raw: string): string {
  const clean = raw.replace(/\p{Cc}/gu, " ");
  const bytes = new TextEncoder().encode(clean);
  if (bytes.length <= MAX_HANDOFF_BYTES) return clean;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, MAX_HANDOFF_BYTES)).replace(/�+$/u, "");
}

// Fixed PATH, POMTREE_* and the egress proxy selectors: the sandbox is --network none, so `pomtree` reaches the daemon only through that proxy.
// The container config document (CONTAINER_CONFIG_ENV) passes too, so `pomtree` reads the operator's values, not image defaults.
export function finishEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { PATH: FIXED_PATH };
  const keep = (k: string) => k.startsWith("POMTREE_") || k === CONTAINER_CONFIG_ENV || (PROXY_ENV_NAMES as readonly string[]).includes(k);
  for (const [k, v] of Object.entries(env)) if (keep(k) && v !== undefined) out[k] = v;
  return out;
}

// One idempotency key per (status, summary): a retry of the same call (e.g. after a timeout that fired once the daemon had recorded the
// result) replays the recorded answer instead of conflicting, while a different status or summary is a different request.
export function finishKey(status: FinishStatus, summary: string): string {
  return `capture-finish-${createHash("sha256").update(`${status}\0${summary}`).digest("hex").slice(0, 32)}`;
}
export function finishArgv(status: FinishStatus, summary: string): string[] {
  return [CLI_POMTREE_MAIN, "result", "--status", status, "--summary", summary, "--key", finishKey(status, summary)];
}

// The child's outcome. On failure: exit code (or Node's error code string), signal, whether execFile's timeout killed it, raw stderr.
export type FinishRun = { ok: true } | { ok: false; code: number | string | null; signal: string | null; timedOut: boolean; stderr: string };
export type RunFinish = (file: string, argv: string[], env: Record<string, string>) => Promise<FinishRun>;
const runFinish: RunFinish = (file, argv, env) =>
  new Promise((resolve) =>
    execFile(file, argv, { env, timeout: FINISH_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, _stdout, stderr) =>
      resolve(
        err
          ? {
              ok: false,
              code: typeof err.code === "number" || typeof err.code === "string" ? err.code : null,
              signal: err.signal ?? null,
              // execFile also kills on a buffer overflow, but then reports a string code, not a timeout.
              timedOut: err.killed === true && typeof err.code !== "string",
              stderr: String(stderr ?? ""),
            }
          : { ok: true },
      ),
    ),
  );

// `pomtree` exit code for a 409 (EXIT.conflict in packages/pomtree/src/cli.ts) and the daemon's fixed refusal text for a dirty workspace
// (submitResultNow in packages/pomtreed/src/daemon/lifecycle.ts), as pomtree prints it on stderr.
const pomtreeExitConflict = 5;
const UNCOMMITTED_WORK = /^pomtree: uncommitted work: /m;
const isUncommittedWork = (r: Extract<FinishRun, { ok: false }>) => r.code === pomtreeExitConflict && UNCOMMITTED_WORK.test(r.stderr);

// The interactive profile's cap on failed `pomtree result` runs per worker; the extension also lets capture_finish run past the step budget
// until this many calls in total (browser.ts), so a failure on the last budgeted step is recoverable. Mirrors INTERACTIVE_FINISH_MAX_ATTEMPTS
// in src/browser-run.ts (the preamble states it; a test pins them equal).
export const FINISH_MAX_ATTEMPTS = 3;
// pomtree's exit codes (EXIT in packages/pomtree/src/cli.ts) by class. `retry`: a later call can succeed (the daemon unreachable or slow, or an
// unclassified error); the others are a 4xx refusal the daemon repeats for the same call, so the model is told to stop.
const FINISH_EXIT_CLASSES: Readonly<Record<number, { name: string; retry: boolean }>> = {
  1: { name: "daemon_error", retry: true },
  2: { name: "usage", retry: false },
  3: { name: "not_found", retry: false },
  4: { name: "denied", retry: false },
  5: { name: "conflict", retry: false },
  6: { name: "unreachable", retry: true },
  7: { name: "timeout", retry: true },
};
// What a model whose result cannot be recorded does instead (browser.ts reuses it for an exhausted budget).
export const END_IN_TEXT = "end the run with your full answer as plain assistant text";
// The interactive profile's model-visible text for a failed `pomtree result`: the exit class, what to do, and the closed `(cause=...)` LAST
// (pomtreed's toolFailureCauseOf parses it there). Exit code, class and attempt count only; never stderr.
function interactiveFailureText(r: Extract<FinishRun, { ok: false }>, failure: PomtreeFailureDetail, attempt: number): { text: string; stop: boolean } {
  const cls = typeof r.code === "number" ? FINISH_EXIT_CLASSES[r.code] : undefined;
  const what = `recording the result failed (${pomtreeFailureNote(failure)}${cls ? `: ${isUncommittedWork(r) ? "uncommitted_work" : cls.name}` : ""})`;
  if (isUncommittedWork(r))
    return {
      stop: true,
      text: `${what}: the workspace has changes this worker cannot commit, so every retry fails the same way; ${END_IN_TEXT} (cause=uncommitted_work)`,
    };
  if (cls && !cls.retry)
    return { stop: true, text: `${what}: the daemon refuses this call the same way every time; do not retry: ${END_IN_TEXT} (cause=finish_failed)` };
  if (attempt >= FINISH_MAX_ATTEMPTS)
    return { stop: true, text: `${what} on attempt ${attempt} of ${FINISH_MAX_ATTEMPTS}; capture_finish gives up: ${END_IN_TEXT} (cause=finish_failed)` };
  // A timeout (pomtree's own, exit 7, or this runner's) may have recorded the result before it fired; a retry then tells the model so.
  const maybe = failure.timedOut || r.code === 7 ? "the result may or may not be recorded; " : "";
  return {
    stop: false,
    text: `${what}: ${maybe}call capture_finish again with the same arguments (attempt ${attempt} of ${FINISH_MAX_ATTEMPTS}) (cause=finish_failed)`,
  };
}

// The interactive profile's finish marker, read by the worker (src/browser-run.ts INTERACTIVE_FINISH_MARKER and readFinishMarker; a test
// pins the paths equal and round-trips the shape): once `pomtree result` succeeded, the worker ends the run with the recorded outcome's
// exit code instead of waiting out its time budget (and never reports such a run as a 124 timeout).
export const FINISH_MARKER_PATH = "/tmp/pomtree-browser-finish.json";
// Written whole (temp file, then rename), so the worker never reads a partial marker. `pending` marks the intent written BEFORE `pomtree
// result` runs: the call may have recorded the result even if its outcome is lost (a timeout, or a failed settled write), so the worker's
// exit code honors a pending marker, but only a settled one starts the finish grace (a pending call may still be in flight).
export function writeFinishMarker(status: FinishStatus, path: string = FINISH_MARKER_PATH, pending = false): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pending ? { status, pending: true } : { status }), { mode: 0o600 });
  renameSync(tmp, path);
}
export function clearFinishMarker(path: string = FINISH_MARKER_PATH): void {
  rmSync(path, { force: true });
}

// Callable once per run. A failed attempt does not consume the call, so the model may retry. `interactive` (the EXPERIMENTAL interactive
// profile) classifies the failure, ends the text with a closed `(cause=...)` and gives up after a refusal or FINISH_MAX_ATTEMPTS failed
// runs; absent keeps the capture worker's texts exactly. `onRecorded` runs once, interactive only, after `pomtree result` succeeded (index.ts
// writes the finish marker and asks Pi to shut down there); never after a failed attempt, so a retryable failure keeps the run going.
// `onPending` runs before each `pomtree result` call and `onUnrecorded` after a failure that cannot have recorded the result (anything but a
// timeout), so a timeout leaves the pending intent standing. The cap counts every call past the closed-status checks, a rejected one
// included, matching the extension's own count of capture_finish calls (browser.ts).
export function createFinish(
  opts: {
    execPath?: string;
    env?: Record<string, string | undefined>;
    run?: RunFinish;
    interactive?: boolean;
    onRecorded?: (status: FinishStatus) => void;
    onPending?: (status: FinishStatus) => void;
    onUnrecorded?: () => void;
  } = {},
) {
  let done = false;
  let attempts = 0;
  let gaveUp = false;
  const run = opts.run ?? runFinish;
  const env = opts.env ?? process.env;
  return async function finish(
    statusRaw: unknown,
    summaryRaw: unknown,
  ): Promise<{ ok: boolean; text: string; failure?: PomtreeFailureDetail; cause?: "finish_failed" | "uncommitted_work" }> {
    if (done) return { ok: false, text: "capture_finish was already called" };
    if (gaveUp)
      return {
        ok: false,
        text: `capture_finish gave up after a failed attempt and runs no more; ${END_IN_TEXT} (cause=finish_failed)`,
        cause: "finish_failed",
      };
    const attempt = ++attempts;
    // A rejected call still spends an attempt; the last one's text says the cap is reached.
    const rejected = (text: string) => {
      if (!opts.interactive || attempt < FINISH_MAX_ATTEMPTS) return { ok: false, text };
      gaveUp = true;
      return {
        ok: false,
        text: `${text}; capture_finish gives up after ${FINISH_MAX_ATTEMPTS} calls: ${END_IN_TEXT} (cause=finish_failed)`,
        cause: "finish_failed" as const,
      };
    };
    if (!FINISH_STATUSES.includes(statusRaw as FinishStatus)) return rejected(`status must be one of ${FINISH_STATUSES.join(", ")}`);
    if (typeof summaryRaw !== "string") return rejected("summary must be a string");
    done = true;
    if (opts.interactive) opts.onPending?.(statusRaw as FinishStatus);
    const outcome = await run(opts.execPath ?? process.execPath, finishArgv(statusRaw as FinishStatus, sanitizeSummary(summaryRaw)), finishEnv(env));
    if (outcome.ok) {
      if (opts.interactive) opts.onRecorded?.(statusRaw as FinishStatus);
      return { ok: true, text: "result recorded" };
    }
    done = false;
    if (opts.interactive && !(outcome.timedOut || outcome.code === 7)) opts.onUnrecorded?.();
    // Redacted against the full process env (a superset of the child's), so POMTREE_TOKEN never survives into the tail.
    const failure = pomtreeFailureDetail(outcome, env);
    if (opts.interactive) {
      const { text, stop } = interactiveFailureText(outcome, failure, attempt);
      gaveUp = stop;
      return { ok: false, text, failure, cause: isUncommittedWork(outcome) ? "uncommitted_work" : "finish_failed" };
    }
    // A closed cause, never the stderr itself: this worker has no shell to commit with, so a retry of that refusal fails the same way.
    if (isUncommittedWork(outcome))
      return {
        ok: false,
        text: `recording the result failed (${pomtreeFailureNote(failure)}, cause=uncommitted_work): the workspace has changes this worker cannot commit, so calling capture_finish again fails the same way; end the run`,
        failure,
      };
    return { ok: false, text: `recording the result failed (${pomtreeFailureNote(failure)}); call capture_finish again`, failure };
  };
}
