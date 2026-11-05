// The shared core of the closed paged-reader tool profiles (the digest analyst ../pomtree-analyst, the research specialist
// ../pomtree-specialist): read one of this agent's own page reports, polling while it is not yet published, and record one result,
// once. Pure of Pi so it is unit-testable; each profile's core supplies the names, bounds and validation.
// These agents have no shell, so untrusted page text never reaches one: every `pomtree` call here is Node by absolute path with a fixed argv
// built from validated values, a fixed PATH and a filtered env (as `capture_finish`, ../pomtree-browser/finish.ts).
// A tool's failure text carries only a closed `(cause=<token>)` and pomtree's exit code, never pomtree's stderr, so POMTREE_TOKEN cannot reach the model.
import { execFile } from "node:child_process";
import { pomtreeFailureDetail, pomtreeFailureNote, type PomtreeFailureDetail } from "../pomtree-browser/capture-diagnostic.ts";
import { CLI_POMTREE_MAIN, CLI_POMTREE_TIMEOUT_MS } from "../pomtree-browser/container-contract.gen.ts";
import { finishEnv } from "../pomtree-browser/finish.ts";
import { AGENT_ID_PATTERN, type PagedCause } from "./paged-contract.ts";

// `pomtree` exit code for a 404 (EXIT.notFound in packages/pomtree/src/cli.ts): the page is not published yet.
const pomtreeExitNotFound = 3;
// `pomtree` exit code for a 409 (EXIT.conflict): on `pomtree result`, a result is already recorded under the key (or the agent is not running).
const pomtreeExitConflict = 5;
// stdout bound of `pomtree result` (it prints one short acknowledgement line).
const RESULT_OUTPUT_MAX_BYTES = 64 * 1024;

// `attempts` (page reads only): how many times pomtree was asked, so a start-up poll for an unpublished page is visible (1 = read at once).
export type PagedOutcome<C extends string> =
  | { ok: true; text: string; attempts?: number }
  | { ok: false; text: string; cause: C; failure?: PomtreeFailureDetail };
export const failOutcome = <C extends string>(cause: C, what: string, failure?: PomtreeFailureDetail): PagedOutcome<C> => ({
  ok: false,
  cause,
  text: `${what} (cause=${cause})`,
  ...(failure && { failure }),
});

// The child's outcome. `overflow`: stdout passed maxBuffer. On failure: exit code (or Node's error code string), signal, whether the timeout killed it, raw stderr.
export type PomtreeRun =
  | { ok: true; stdout: Buffer }
  | { ok: false; code: number | string | null; signal: string | null; timedOut: boolean; overflow: boolean; stderr: string };
export type RunPomtree = (file: string, argv: string[], env: Record<string, string>, maxBuffer: number) => Promise<PomtreeRun>;
export const runPomtree: RunPomtree = (file, argv, env, maxBuffer) =>
  new Promise((resolve) =>
    execFile(file, argv, { env, timeout: CLI_POMTREE_TIMEOUT_MS, maxBuffer, encoding: "buffer" }, (err, stdout, stderr) =>
      resolve(
        err
          ? {
              ok: false,
              code: typeof err.code === "number" || typeof err.code === "string" ? err.code : null,
              signal: err.signal ?? null,
              timedOut: err.killed === true && typeof err.code !== "string",
              overflow: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              stderr: Buffer.from(stderr ?? "").toString("utf8"),
            }
          : { ok: true, stdout: Buffer.from(stdout) },
      ),
    ),
  );

// A page argument: a whole number 1..max, nothing else (no numeric strings, no fractions, no names).
export function parseWholePage(raw: unknown, max: number): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= max ? raw : null;
}

// The argv of the one `pomtree` call that reads a page: only the validated agent id and a report name built from a validated page number.
export const reportShowArgv = (agent: string, name: string): string[] => [CLI_POMTREE_MAIN, "report", "show", agent, name];
// The argv of the one `pomtree` call that records the result: a fixed key and the validated JSON, nothing else.
export const resultKeyArgv = (key: string, json: string): string[] => [CLI_POMTREE_MAIN, "result", "--key", key, json];

export interface PagedDeps {
  env?: Record<string, string | undefined>;
  execPath?: string;
  run?: RunPomtree;
  sleep?: (ms: number) => Promise<void>;
}
export interface PagedRuntime {
  env: Record<string, string | undefined>;
  run: RunPomtree;
  sleep: (ms: number) => Promise<void>;
  node: () => string;
}
export function pagedRuntime(deps: PagedDeps = {}): PagedRuntime {
  return {
    env: deps.env ?? process.env,
    run: deps.run ?? runPomtree,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    node: () => deps.execPath ?? process.execPath,
  };
}

// One page kind of a profile: its bounds, the report name a validated page number maps to, and the noun its failure text uses.
export interface PageSpec {
  pagesMax: number;
  reportName: (page: number) => string;
  outputMaxBytes: number;
  waitMs: number;
  waitTries: number;
  noun: string;
}

// Reads one of this agent's own page reports. A page that is not published yet is polled for (waitTries x waitMs), because these agents
// have no sleep command to wait with.
export async function readOwnPage(rt: PagedRuntime, spec: PageSpec, pageRaw: unknown): Promise<PagedOutcome<PagedCause>> {
  const page = parseWholePage(pageRaw, spec.pagesMax);
  if (page === null) return failOutcome("invalid_page", `${spec.noun} must be a whole number 1..${spec.pagesMax}`);
  const agent = rt.env.POMTREE_AGENT_ID;
  if (agent === undefined || !AGENT_ID_PATTERN.test(agent)) return failOutcome("no_agent", "no usable agent id in the environment");
  for (let attempt = 1; ; attempt++) {
    const out = await rt.run(rt.node(), reportShowArgv(agent, spec.reportName(page)), finishEnv(rt.env), spec.outputMaxBytes);
    if (out.ok) return { ok: true, text: out.stdout.toString("utf8"), attempts: attempt };
    const failure = pomtreeFailureDetail(out, rt.env);
    const what = `${spec.noun} ${page}`;
    if (out.overflow) return failOutcome("too_large", `${what} is over ${spec.outputMaxBytes} bytes`, failure);
    if (out.timedOut) return failOutcome("timeout", `reading ${what} timed out`, failure);
    if (out.code !== pomtreeExitNotFound) return failOutcome("read_failed", `reading ${what} failed (${pomtreeFailureNote(failure)})`, failure);
    if (attempt >= spec.waitTries) return failOutcome("unavailable", `${what} is not published`, failure);
    await rt.sleep(spec.waitMs);
  }
}

// `pomtree` exits that mean the daemon did not record this call (packages/pomtree/src/cli.ts codeFor): 2 usage (a 400, or refused before
// sending), 3 not found (404), 4 denied (401/403), 5 conflict (409: not running, or a different result already recorded; a same-key
// replay of a recorded result is acknowledged, not 409). Exit 5 recorded nothing for this call, but oneShotResult closes the call on it.
const pomtreeDefiniteExits: readonly number[] = [2, 3, 4, 5];
// Whether a failed `pomtree result` left the daemon possibly holding the result. Definite (false) only when pomtree never ran (a spawn error,
// Node's string code, without a timeout or overflow) or it exited with one of the definite codes above and no signal. Everything else
// (killed by the timeout or a signal, stdout overflow after pomtree ran, exit 1 for a 5xx, 6 unreachable after pomtree's own transport retries,
// any other code) may have reached the daemon after it recorded the result.
export function maybeDelivered(out: Extract<PomtreeRun, { ok: false }>): boolean {
  if (out.timedOut || out.overflow || out.signal !== null) return true;
  if (typeof out.code === "string") return false;
  return !(typeof out.code === "number" && pomtreeDefiniteExits.includes(out.code));
}

// Records a result under `key`, once per agent. `validate` runs only while the call is still open, and a refusal there (before pomtree runs)
// never consumes the call. After a definite pomtree failure (maybeDelivered false) the call stays open for any corrected value. After an
// ambiguous one the daemon may already hold the value: the first value under a key stands, and a different value under the same key is
// refused with 409 idempotency_conflict (pomtreed daemon/lifecycle.ts submitResultLocked; pomtree exit 5). From then on only the byte-identical
// JSON is sent again (an idempotent replay) and a different one is already_submitted locally, without a round trip. A call while one is in flight is already_submitted. `tool` names the tool to call again.
// Exit 5 (409) closes the call for good: the daemon already holds a result (an attempt before a Pi restart, which this in-memory state
// does not survive, recorded a different value) or the agent is no longer running. Either way no retry can succeed, so the model is told
// the result is already submitted and to stop, rather than to call again.
export function oneShotResult(rt: PagedRuntime, key: string, tool: string) {
  let state: "open" | "inflight" | "recorded" = "open";
  let pinned: string | undefined; // the exact JSON of an attempt that may have reached the daemon
  return async <C extends string>(
    validate: () => { ok: true; json: string } | { ok: false; outcome: PagedOutcome<C> },
  ): Promise<PagedOutcome<C | PagedCause>> => {
    if (state === "recorded") return failOutcome("already_submitted", `${key} was already recorded`);
    if (state === "inflight") return failOutcome("already_submitted", `${key} is being recorded`);
    const v = validate();
    if (!v.ok) return v.outcome;
    if (pinned !== undefined && v.json !== pinned)
      return failOutcome("already_submitted", `an earlier attempt may have recorded ${key}: call ${tool} again only with exactly the same value`);
    state = "inflight";
    const out = await rt.run(rt.node(), resultKeyArgv(key, v.json), finishEnv(rt.env), RESULT_OUTPUT_MAX_BYTES);
    if (out.ok) {
      state = "recorded";
      return { ok: true, text: "result recorded" };
    }
    if (out.code === pomtreeExitConflict && out.signal === null && !out.timedOut) {
      state = "recorded";
      return failOutcome(
        "already_submitted",
        `${key} is already submitted (pomtree exit 5: a result was recorded earlier); do not call ${tool} again`,
        pomtreeFailureDetail(out, rt.env),
      );
    }
    state = "open";
    if (pinned === undefined && maybeDelivered(out)) pinned = v.json;
    // Redacted against the full process env (a superset of the child's), so POMTREE_TOKEN never survives into the tail.
    const failure = pomtreeFailureDetail(out, rt.env);
    const again = pinned === undefined ? `call ${tool} again` : `call ${tool} again with exactly the same value`;
    return failOutcome("submit_failed", `recording the result failed (${pomtreeFailureNote(failure)}); ${again}`, failure);
  };
}

// The structured `details` of a page-read result (journaled beside the text, never shown to the model): the page asked for and how many
// reads it took. Plain JSON, far under core's MAX_TOOL_DETAILS_BYTES.
export const pageToolDetails = (page: number, outcome: PagedOutcome<string>): { page: number; attempts?: number } => ({
  page,
  ...(outcome.ok && outcome.attempts !== undefined && { attempts: outcome.attempts }),
});
