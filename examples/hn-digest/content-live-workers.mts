// Per-story article worker evidence for the live run's output directory (`workers/<story id>.json`). Pure: the live collector reads the
// agent record, the child's journal rows and its published reports, and this module reduces them to a bounded, secret-free, path-free
// file, so a dropped article stays diagnosable after the run's temp directory is gone.
//
// What is reachable from the daemon journal and report store: the sandbox exit status and closed exit cause, the tool calls and the
// (model-visible, already cause-only) tool errors, the harness error events, and any report the worker published (the navigation log).
// The browser extension's operator-only capture diagnostic (`browser-capture-failure`: stderr tail, net error name, pomtree failure) is also
// journaled, as a harness `error` event with the `operator-diagnostic` prefix (capture-diagnostic.ts, via the events sink); it is lifted out
// of `errors` into `diagnostics`, re-scrubbed here, so a `publish_failed` on a page that loaded stays diagnosable.
import { CAPTURE_STDERR_TAIL_CHARS, parseDiagnosticMessage, redactDiagnosticText } from "../../packages/agent-image/ext/pomtree-browser/capture-diagnostic.ts";
import type { JournalPayload } from "../../packages/core/src/index.ts";
import { toolFailureCauseOf } from "../../packages/pomtreed/src/daemon-util.ts";

export const WORKER_TEXT_MAX = 500; // characters kept of one tool error or error event
export const WORKER_ITEMS_MAX = 20; // tool results and errors kept
export const WORKER_NAVIGATION_MAX = 16384; // JSON bytes of a retained navigation log

export type WorkerEvidence = {
  storyId: number;
  child: string;
  generation: number;
  exit: string | null; // the sandbox exit status the daemon recorded
  exitCause: string | null; // its closed cause (for example "signal", "oom_killed"), when one was recorded
  tools: { tool: string; ok: boolean | null; output: string; outputBytes: number | null }[]; // output only of a failed result (a successful one may hold page text); ok/outputBytes are null for a call that never returned
  errors: string[]; // harness error events, redacted and clipped (operator diagnostics excluded)
  diagnostics: { name: string; detail: unknown }[]; // operator-only diagnostics the worker journaled, each string re-scrubbed and clipped
  reports: { name: string; mediaType: string; sizeBytes: number; sha256: string }[];
  navigation: unknown | null; // the worker's navigation log when it published one that parses and fits; else null
  navigationNote: string | null; // why navigation is null: "none published", "unreadable" or "oversize"
};

// Redacts what the capture diagnostic redacts (URLs to origin, bearer tokens, secret pairs, long environment values), then host-style
// absolute paths, collapses whitespace and clips by code point.
export function workerText(text: string, env: Record<string, string | undefined>, max = WORKER_TEXT_MAX): string {
  const line = redactDiagnosticText(text, env)
    .replace(/(?<![\w:/.-])\/(?=[\w.@~+-])(?:[\w.@~+-]+(?: [\w.@~+-]+)*\/)*[\w.@~+-]*/g, "[path]")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max).join("")}...`;
}

// Applies workerText to every string of a parsed JSON value (a navigation log carries URLs).
function scrub(value: unknown, env: Record<string, string | undefined>, max = 1000): unknown {
  if (typeof value === "string") return workerText(value, env, max);
  if (Array.isArray(value)) return value.map((v) => scrub(v, env, max));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [workerText(k, env, 200), scrub(v, env, max)]));
  return value;
}

export function workerEvidenceOf(input: {
  storyId: number;
  agent: { id: string; generation: number; exit: string | null; exitCause?: string };
  payloads: readonly JournalPayload[];
  reports: readonly { name: string; mediaType: string; sizeBytes: number; sha256: string; content?: Uint8Array }[];
  env: Record<string, string | undefined>;
}): WorkerEvidence {
  const { env } = input;
  const calls = new Map<string, string>();
  const tools: WorkerEvidence["tools"] = [];
  const errors: string[] = [];
  const diagnostics: WorkerEvidence["diagnostics"] = [];
  for (const p of input.payloads) {
    if (p.kind === "tool_call") calls.set(p.callId, p.tool);
    else if (p.kind === "tool_result" && tools.length < WORKER_ITEMS_MAX)
      tools.push({ tool: calls.get(p.callId) ?? "unknown", ok: p.ok, output: p.ok ? "" : workerText(p.output, env), outputBytes: Buffer.byteLength(p.output) });
    else if (p.kind === "error") {
      const diagnostic = parseDiagnosticMessage(p.message);
      if (diagnostic) {
        if (diagnostics.length < WORKER_ITEMS_MAX)
          diagnostics.push({ name: diagnostic.name, detail: scrub(diagnostic.detail, env, CAPTURE_STDERR_TAIL_CHARS + 100) });
      } else if (errors.length < WORKER_ITEMS_MAX) errors.push(workerText(p.message, env));
    }
  }
  const resultIds = new Set(input.payloads.flatMap((p) => (p.kind === "tool_result" ? [p.callId] : [])));
  for (const [id, tool] of calls) if (!resultIds.has(id) && tools.length < WORKER_ITEMS_MAX) tools.push({ tool, ok: null, output: "", outputBytes: null });
  const nav = input.reports.find((r) => r.name === "browser-navigation");
  let navigation: unknown | null = null;
  let navigationNote: string | null = nav ? null : "none published";
  if (nav) {
    if (nav.content === undefined) navigationNote = "unreadable";
    else if (nav.content.byteLength > WORKER_NAVIGATION_MAX) navigationNote = "oversize";
    else {
      try {
        const scrubbed = scrub(JSON.parse(Buffer.from(nav.content).toString("utf8")), env);
        if (Buffer.byteLength(JSON.stringify(scrubbed)) > WORKER_NAVIGATION_MAX) navigationNote = "oversize";
        else navigation = scrubbed;
      } catch {
        navigationNote = "unreadable";
      }
    }
  }
  return {
    storyId: input.storyId,
    child: input.agent.id,
    generation: input.agent.generation,
    exit: input.agent.exit,
    exitCause: input.agent.exitCause ?? null,
    tools,
    errors,
    diagnostics,
    reports: input.reports.map(({ name, mediaType, sizeBytes, sha256 }) => ({ name, mediaType, sizeBytes, sha256 })),
    navigation,
    navigationNote,
  };
}

// The closed capture cause the worker reported (the host-read `(cause=<token>)` suffix of its last failed tool error, else the cause of its
// journaled operator diagnostic), and a closed `reason` where the cause alone hides what happened: "runtime-error" is cause "other" with a
// non-empty stderr tail (the capture subprocess crashed rather than reported a classified failure; the tail itself stays in workers/<id>.json).
export type WorkerFailureReason = "runtime-error";
export function workerFailureOf(w: WorkerEvidence): { cause: string | null; reason: WorkerFailureReason | null } {
  const failed = w.tools.filter((t) => t.ok === false).at(-1);
  const diagnostic = w.diagnostics.find((d) => d.name === "browser-capture-failure");
  const detail = diagnostic?.detail as { cause?: unknown; stderrTail?: unknown } | undefined;
  const cause = (failed ? toolFailureCauseOf(failed.output) : null) ?? (typeof detail?.cause === "string" ? detail.cause : null);
  return { cause, reason: cause === "other" && typeof detail?.stderrTail === "string" && detail.stderrTail !== "" ? "runtime-error" : null };
}

// TODO(capture-fail-detail): add byte sizes, timeout values and a bounded stderr tail for other failure kinds. Current behavior:
// it keeps exit, exitCause, failure, captureCause and captureReason.
// The one line provenance.json keeps per article: the exit, its cause, the last failed tool's error, and the capture failure cause and reason.
export function workerSummaryOf(w: WorkerEvidence): {
  exit: string | null;
  exitCause: string | null;
  failure: string | null;
  captureCause: string | null;
  captureReason: WorkerFailureReason | null;
} {
  const failed = w.tools.filter((t) => t.ok === false).at(-1);
  const { cause, reason } = workerFailureOf(w);
  return { exit: w.exit, exitCause: w.exitCause, failure: failed ? failed.output : (w.errors.at(-1) ?? null), captureCause: cause, captureReason: reason };
}
