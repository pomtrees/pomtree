// All assumptions about Pi's `--mode json` JSONL format live in this file.
// Assumptions are checked against recorded real Pi output in src/fixtures/*.jsonl.
import { modelRefusalCodeIn } from "@pomtree/core";
import type { HarnessEvent } from "@pomtree/core";
import { stripControl } from "./control.ts";
import { detailsWithImages } from "./image-ref.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Every text field below passes through stripControl before it becomes an event: the journal never stores terminal
// control sequences (see control.ts). Structured fields (tool_call input, tool_result details) are JSON, not text, and
// stay as Pi sent them.
function textOf(content: unknown): string {
  if (typeof content === "string") return stripControl(content);
  if (!Array.isArray(content)) return "";
  return stripControl(
    content
      .filter((b): b is Obj => isObj(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(""),
  );
}

type ProviderErrorEvent = Extract<HarnessEvent, { kind: "provider_error" }>;

// Classifies a model-provider failure message into a `provider_error` event; returns null for agent/tool errors and anything
// else, which stays a generic `error`. Only rate_limit and outage are retryable: `auth` never is (core types.ts, provider_error),
// since a bad or expired credential is the operator's to fix. Checked in this order so e.g. a `403 rate limit exceeded` is
// rate_limit. A bare numeric status code is only a provider error in a status/HTTP context: at the start of
// the message ("429 Too Many Requests") or after a `status`/`HTTP` word ("HTTP 503"). A number in
// prose ("5000 tokens", "tried 503 times") is not a status code. Keywords stay substring matches, word-bounded where a looser
// match would hit ordinary words ("Author", "OAuth" are not auth failures).
// The input is always a structured Pi field (message_end errorMessage, auto_retry_end finalError), never terminal text.
const httpStatus = (codes: string): RegExp => new RegExp(`(?:^\\s*|\\b(?:status|http)\\b[^0-9]{0,16})\\b(?:${codes})\\b`, "i");

// An expired or invalid credential is `auth` (pomtreed stops the agent on it), and the message names which and what to
// do, keeping the provider's text after "provider said:". The credential lives on the host (agents reach the provider through
// the controller proxy), so the fix is the operator's.
const authMessage = (message: string): string => {
  if (/expired/i.test(message))
    return `provider credential expired: refresh the provider login on the host (the Pi auth.json pomtreed stages), then retry the run; provider said: ${message}`;
  if (/invalid[\s_-]?(?:credential|api[\s_-]?key|key)|credential[\s_-]?invalid/i.test(message))
    return `provider credential invalid: check or replace the provider key or login on the host (the Pi auth.json pomtreed stages), then retry the run; provider said: ${message}`;
  return `provider authentication failed: check the provider key or login on the host (the Pi auth.json pomtreed stages), then retry the run; provider said: ${message}`;
};

const AUTH_WORDS =
  /\bunauthori[sz]ed\b|\bauthenticat(?:e|ion)(?:[\s_-]?(?:error|failed|required))?\b|\bpermission[\s_-]?error\b|credential|\b(?:invalid|incorrect|missing)[\s_-]?api[\s_-]?key\b/i;
// Transport failures Pi reports with no status: a fetch timeout abort, undici's "terminated" (socket closed mid-body), a stream
// that closed before its terminal event, a refused or reset connection.
const TRANSPORT =
  /time(?:d)?[\s_-]?out|connection|operation was aborted|^\s*terminated\b|\bstream ended\b|ended without (?:a )?(?:terminal event|finish)|premature close|socket hang up|fetch failed|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+)\b|overloaded/i;

// An opaque JSON error body (`{"error":{"type":"overloaded_error",...}}`, `{"code":429,...}`): its type/code/status fields as words
// the classifiers below can match, so a body with no leading status is not left a generic error. Never throws.
function jsonErrorWords(message: string): string {
  const at = message.indexOf("{");
  if (at < 0) return "";
  let body: unknown;
  try {
    body = JSON.parse(message.slice(at));
  } catch {
    return "";
  }
  const words: string[] = [];
  const visit = (o: unknown, depth: number) => {
    if (!isObj(o) || depth > 2) return;
    for (const k of ["type", "code", "status"]) {
      const v = o[k];
      if (typeof v === "number") words.push(`status ${v}`);
      else if (typeof v === "string") words.push(/^\d{3}$/.test(v) ? `status ${v}` : v.replace(/_/g, " "));
    }
    visit(o.error, depth + 1);
  };
  visit(body, 0);
  return words.join("; ");
}

export function providerError(message: string, status?: number): ProviderErrorEvent | null {
  // The classified text: the message, the HTTP status Pi recorded beside it (when the message itself omits it), and the fields
  // of a JSON body in it. The event keeps the provider's own message.
  const json = jsonErrorWords(message);
  const text = [status !== undefined ? `status ${status}` : "", message, json].filter(Boolean).join("; ");
  if (httpStatus("429").test(text) || /rate[\s_-]?limit|too many requests/i.test(text))
    return { kind: "provider_error", code: "rate_limit", message, retryable: true };
  if (httpStatus("401|403").test(text) || AUTH_WORDS.test(text))
    return { kind: "provider_error", code: "auth", message: authMessage(message), retryable: false };
  if (httpStatus("5\\d\\d").test(text) || TRANSPORT.test(message) || /\bapi error\b|\bserver error\b|service unavailable/i.test(json))
    return { kind: "provider_error", code: "outage", message, retryable: true };
  return null;
}

// Upstream wording for an account out of funds, for a message without a 402 status. Any upstream 402 (Payment Required) is funding;
// only the controller proxy's own 402 (tagged model_budget_exhausted, core model-refusal.ts) is left untouched for pomtreed's budget
// escalation; pomtreed's budget-refusal-contract.test.ts pins the proxy's real body through this classifier.
const FUNDING = /\bcredits?\b|\bbilling\b|payment[\s_-]?required|insufficient[\s_-]?(?:funds|balance|quota)|\bbalance\b/i;
// A 400 is a configuration fault only when it names the model or a missing resource, never a context-length refusal.
const CONFIG_400 = /not[\s_-]?found|\bmodel\b|unknown|does not exist|unsupported/i;
const CONTEXT_LENGTH = /context|too long|maximum|tokens/i;

// A provider failure message as the journal event it becomes. Funding and configuration faults are non-retryable
// `provider_error`s (more credits or a corrected model id / base URL is an operator action; pomtreed stops the run at once and
// journals its own "provider funding: / provider config:" line) whose message is the advice, then the provider's text;
// everything else is `providerError` or a plain `error`.
// `status` is the HTTP status Pi recorded in a structured diagnostic beside the message (statusOf), when it did.
export function providerFailure(raw: string, status?: number): HarnessEvent {
  // A status the message does not already lead with is prefixed, so the journaled text and the classifiers both see it.
  const message = status !== undefined && !new RegExp(`^\\s*${status}\\b`).test(raw) ? `HTTP ${status}: ${raw}` : raw;
  const own = modelRefusalCodeIn(message) === "model_budget_exhausted";
  if (!own && !httpStatus("429").test(message) && (httpStatus("402").test(message) || (/insufficient|billing/i.test(message) && FUNDING.test(message))))
    return {
      kind: "provider_error",
      code: "funding",
      retryable: false,
      message: `the model provider account has no credits left or a billing problem: add credits with the provider or choose another model; retrying will not help; provider said: ${message}`,
    };
  if (httpStatus("404").test(message))
    return {
      kind: "provider_error",
      code: "config",
      retryable: false,
      message: `the provider has no such model or endpoint (HTTP 404): check the model id (pomtree models) and the provider base URL; retrying will not help; provider said: ${message}`,
    };
  if (httpStatus("400").test(message) && CONFIG_400.test(message) && !CONTEXT_LENGTH.test(message))
    return {
      kind: "provider_error",
      code: "config",
      retryable: false,
      message: `the provider rejected the request for this model (HTTP 400): check the model id (pomtree models) and its settings; retrying will not help; provider said: ${message}`,
    };
  return providerError(message) ?? { kind: "error", message };
}

// The HTTP status of a failed assistant message, from Pi's structured diagnostics (`diagnostics[].details.status`, recorded by
// e.g. the pi-messages API), when present.
function statusOf(m: Obj): number | undefined {
  if (!Array.isArray(m.diagnostics)) return undefined;
  for (const d of m.diagnostics) {
    const st = isObj(d) && isObj(d.details) ? d.details.status : undefined;
    if (typeof st === "number" && Number.isInteger(st) && st >= 100 && st <= 599) return st;
  }
  return undefined;
}

// Stored `tool_result.output` must stay bounded so a huge tool result cannot bloat the
// journal/registry. Truncate to 64 KiB of UTF-8 bytes with a marker.
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export function truncateToolOutput(output: string, max = MAX_TOOL_OUTPUT_BYTES): string {
  const total = utf8Bytes(output);
  if (total <= max) return output;
  // Cut on a code-point boundary: decode the first `max` bytes without flushing an incomplete
  // trailing sequence, so a multi-byte character is never split into a replacement char.
  const head = new TextDecoder().decode(new TextEncoder().encode(output).subarray(0, max), { stream: true });
  return `${head}[pomtree: ${total - utf8Bytes(head)} bytes of tool output truncated]`;
}

// The builder bounds the message to 16 KiB (agent-image DIAGNOSTIC_MAX_BYTES, pinned by a round-trip test); this is the backstop for a record that did not come from it.
export const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

// One usage event per assistant message. `costMicros` is null when Pi reported no cost (an absent cost is not a real zero: the
// daemon catalog-prices it). `responseId` is the provider's response id, the exact key the daemon joins the proxy's settlement on.
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? stripControl(v) : undefined);
function usageEvent(m: Obj): HarnessEvent[] {
  const usage = m.usage;
  if (!isObj(usage)) return [];
  const cost = isObj(usage.cost) ? num(usage.cost.total) : undefined;
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  const model = str(m.model);
  const provider = str(m.provider);
  const responseId = str(m.responseId);
  const stopReason = str(m.stopReason);
  return [
    {
      kind: "usage",
      inputTokens: num(usage.input) ?? 0,
      outputTokens: num(usage.output) ?? 0,
      costMicros: cost === undefined ? null : Math.round(cost * 1e6),
      ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
      ...(cacheWrite !== undefined && { cacheWriteTokens: cacheWrite }),
      ...(model !== undefined && { model }),
      ...(provider !== undefined && { provider }),
      ...(responseId !== undefined && { responseId }),
      ...(stopReason !== undefined && { stopReason }),
    },
  ];
}

export function normalizeRecord(rec: unknown): HarnessEvent[] {
  if (!isObj(rec) || typeof rec.type !== "string") return [];
  switch (rec.type) {
    case "message_end": {
      // message_end is the authoritative final message; deltas are ignored.
      const m = rec.message;
      if (!isObj(m)) return [];
      if (m.role === "user") return [{ kind: "message", role: "user", text: textOf(m.content) }];
      if (m.role !== "assistant") return [];
      const out: HarnessEvent[] = [];
      const text = textOf(m.content);
      if (text) out.push({ kind: "message", role: "assistant", text });
      out.push(...usageEvent(m));
      if (m.stopReason === "error" && typeof m.errorMessage === "string") {
        out.push(providerFailure(stripControl(m.errorMessage), statusOf(m)));
      }
      // A reply cut at the output-token limit (stopReason "length") that contains a tool call: the call's arguments may be truncated or
      // empty (Pi fails a call whose arguments text is cut, but a cut that still parses as an object runs), so say so where the operator
      // (journal) sees it; the model sees the tool's own result.
      if (m.stopReason === "length" && Array.isArray(m.content)) {
        const calls = m.content
          .filter((b): b is Obj => isObj(b) && b.type === "toolCall")
          .map((b) => (typeof b.name === "string" ? stripControl(b.name) : "?"));
        if (calls.length > 0)
          out.push({
            kind: "error",
            message: `the model's reply hit its output-token limit (stopReason length) while writing a call to ${calls.join(", ")}: the arguments may be truncated, so check that tool's result; raise the model's max output tokens or have the agent write large content in smaller steps`,
          });
      }
      // Malformed tool-call JSON is not caught here: Pi fails a cut arguments text (`{"command": "echo`) as an isError tool result
      // without a pomtree tag. The model proxy therefore replaces such a call's arguments with its tagged refusal (pomtreed
      // model-proxy/tool-args.ts), which Pi fails as an isError tool result; tool_execution_end below journals it.
      return out;
    }
    case "user_input": // sink-only: text the user typed in the TTY (the events extension drops mailbox-injected input)
      return typeof rec.text === "string" ? [{ kind: "user_input", text: stripControl(rec.text) }] : [];
    case "tool_execution_start":
      if (typeof rec.toolCallId !== "string" || typeof rec.toolName !== "string") return [];
      return [{ kind: "tool_call", tool: stripControl(rec.toolName), callId: rec.toolCallId, input: rec.args }];
    case "tool_execution_end": {
      if (typeof rec.toolCallId !== "string") return [];
      const result = isObj(rec.result) ? textOf(rec.result.content) : "";
      // `details` is the tool's structured metadata beside its text; bounded here (closed drop marker, never a clipped fragment).
      // Image content blocks join it as bounded references (image-ref.ts), never as the base64 payload.
      const details = isObj(rec.result) ? detailsWithImages(rec.result.details, rec.result.content) : undefined;
      const out: HarnessEvent[] = [
        {
          kind: "tool_result",
          callId: rec.toolCallId,
          ok: rec.isError !== true,
          output: truncateToolOutput(result),
          ...(details !== undefined && { details }),
        },
      ];
      // A call the model proxy refused for arguments that were not JSON (its refusal tag is in Pi's isError result): nothing ran,
      // and the model was told to re-issue it; the operator sees it in the journal too.
      if (rec.isError === true && modelRefusalCodeIn(result) === "malformed_tool_arguments") {
        const tool = typeof rec.toolName === "string" ? stripControl(rec.toolName) : "a tool";
        out.push({
          kind: "error",
          message: `the model sent a call to ${tool} whose arguments were not valid JSON (malformed_tool_arguments): the model proxy refused it, so nothing ran, and the model was told to re-issue the call with complete arguments; if it repeats, raise the model's max output tokens or choose another model`,
        });
      }
      return out;
    }
    case "auto_retry_end":
      if (rec.success === false) {
        return [providerFailure(typeof rec.finalError === "string" ? stripControl(rec.finalError) : "retries exhausted")];
      }
      return [];
    case "compaction_end":
      if (rec.aborted !== true && !rec.result && typeof rec.errorMessage === "string") {
        return [{ kind: "error", message: `compaction failed: ${stripControl(rec.errorMessage)}` }];
      }
      return [];
    case "operator_diagnostic": // sink-only: a bounded, redacted operator note from an in-image extension (agent-image capture-diagnostic.ts), journaled as an `error` event
      return typeof rec.message === "string" ? [{ kind: "error", message: truncateToolOutput(stripControl(rec.message), MAX_DIAGNOSTIC_BYTES) }] : [];
    case "session_compact_failed": // sink-mode counterpart of compaction_end{errorMessage}
      if (rec.aborted !== true && typeof rec.errorMessage === "string") {
        return [{ kind: "error", message: `compaction failed: ${stripControl(rec.errorMessage)}` }];
      }
      return [];
    default:
      return []; // session header, deltas, turn/agent markers, queue/state events
  }
}

// Fixed container-side locations (Pi derives its session directory from the working directory).
export const PI_CWD = "/workspace";
export const PI_SESSION_PATH = "/workspace/.pi-session/session.jsonl";
// The image ships the guide here; Pi reads an existing path passed to --append-system-prompt as a file.
// The flag may repeat (Pi accumulates every value, in order), so a template's systemPrompt is a further flag added by pomtreed harnessArgv.
export const PI_GUIDE_PATH = "/opt/pomtree/agent-guide.md";
// The image user is uid 1000 (`node`, HOME=/home/node); Pi's config dir is ~/.pi/agent, set explicitly via PI_CODING_AGENT_DIR.
export const PI_AGENT_DIR = "/home/node/.pi/agent";
export const PI_AUTH_PATH = `${PI_AGENT_DIR}/auth.json`;

// In-image Pi extension loadout (TODO(pi-ext)): the agent image ships per-tool shims at
// /opt/pomtree/ext/<name> that forward calls to the host gateway via `pomtree ext call <name>`.
// Loaded with explicit `-e` paths so they never run from the agent-writable /workspace/.pi.
export const PI_EXT_LOADOUT: ReadonlyArray<{ name: string; path: string }> = [
  { name: "web_search", path: "/opt/pomtree/ext/web_search" },
  { name: "web_fetch", path: "/opt/pomtree/ext/web_fetch" },
];

// Always loaded: mirrors Pi's extension events to the sink file the harness reads (replaces `--mode json` stdout).
export const PI_EVENTS_EXT = { name: "pomtree-events", path: "/opt/pomtree/ext/pomtree-events" } as const;
// Beside PI_SESSION_PATH, i.e. inside the bind-mounted session dir the daemon already holds on the host
// (daemon.ts sessionHostDir/<SINK_FILE>): no new mount. The extension truncates it on load.
export const PI_SINK_PATH = `${PI_SESSION_PATH.slice(0, PI_SESSION_PATH.lastIndexOf("/"))}/events.jsonl`;
export const PI_SINK_FILE = "events.jsonl";

// Env for the pi process so the TUI renders sanely in an xterm.js terminal. The harness does not build the
// container env itself (pomtreed/main.ts passes SandboxSpec.env), so the caller merges this in.
export const PI_TTY_ENV: Readonly<Record<string, string>> = { TERM: "xterm-256color", COLORTERM: "truecolor" };

// Loaded by default because a waiting agent only sees messages through it; disable with opts.steerExt=false (pomtreed passes the registry key harness.steerExt).
// TODO(steer): its Pi API calls are read from Pi's source, not run live.
export const PI_STEER_EXT = { name: "pomtree-mailbox", path: "/opt/pomtree/ext/pomtree-mailbox" } as const;

// OPT-IN and UNVERIFIED against a real Pi (TODO(background-jobs)): loaded only with opts.jobsExt (pomtreed passes the registry key harness.jobsExt).
export const PI_JOBS_EXT = { name: "pomtree-jobs", path: "/opt/pomtree/ext/pomtree-jobs" } as const;

// `--session <path>` creates the file (and missing parent dirs) or resumes it.
// On resume the prompt is the wake message, appended to the restored conversation.
// `provider` selects among providers when matching `model`, so Pi requires a model whenever a provider is given.
// `extSet: "events"` loads only the sink extension: a worker that must not have the web/mailbox/jobs tools (the jobs tools run `sh -c`, bash by another name).
// `tools` is a Pi `--tools` allowlist; `guide: false` omits the appended agent guide.
// `allowlist` is a worker that may call only the named tools, all provided by one in-image extension (TODO(analyst-allowlist); the browser
// worker gets the same shape inside its image from browser-run.ts): it loads the events sink and that extension only, turns off MCP, skills,
// prompt templates, context files and project-local resources, and omits the guide (which teaches shell commands). It cannot be combined
// with `tools`, `extSet` or `guide`, so the tool list in the argv is always exactly `allowlist.tools`.
export interface PiAllowlist {
  tools: readonly string[];
  extension: string;
}
// Pi flags (verified in Pi's CLI help) that keep a tool-restricted worker from loading anything but its allowlisted extension.
export const PI_ISOLATION_FLAGS: readonly string[] = ["--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"];
export interface PiArgvOptions {
  prompt: string;
  provider?: string;
  model?: string;
  steerExt?: boolean;
  jobsExt?: boolean;
  tools?: string[];
  guide?: string | false;
  extSet?: "default" | "events";
  allowlist?: PiAllowlist;
}
export function piArgv(opts: PiArgvOptions): string[] {
  if (opts.provider && !opts.model) throw new Error("piArgv: provider requires model");
  const choice = opts.model ? [...(opts.provider ? ["--provider", opts.provider] : []), "--model", opts.model] : [];
  const steer = opts.steerExt ?? true;
  const jobs = opts.jobsExt ?? false;
  const allow = opts.allowlist;
  if (allow !== undefined) {
    if (opts.tools !== undefined || opts.extSet !== undefined || opts.guide !== undefined)
      throw new Error("piArgv: allowlist excludes tools, extSet and guide");
    if (allow.tools.length === 0 || allow.tools.some((t) => !/^[a-z][a-z0-9_]*$/.test(t))) throw new Error("piArgv: allowlist tools must be plain tool names");
    if (!allow.extension.startsWith("/opt/pomtree/ext/") || allow.extension.endsWith("/") || allow.extension.split("/").includes(".."))
      throw new Error("piArgv: allowlist extension must be an in-image path under /opt/pomtree/ext/");
  }
  const exts =
    allow !== undefined
      ? [PI_EVENTS_EXT, { name: "allowlist", path: allow.extension }]
      : opts.extSet === "events"
        ? [PI_EVENTS_EXT]
        : [...PI_EXT_LOADOUT, PI_EVENTS_EXT, ...(steer ? [PI_STEER_EXT] : []), ...(jobs ? [PI_JOBS_EXT] : [])];
  if (opts.tools?.length === 0) throw new Error("piArgv: tools must name at least one tool");
  const tools = allow?.tools ?? opts.tools;
  const guide = allow !== undefined ? false : opts.guide === undefined ? PI_GUIDE_PATH : opts.guide;
  // Interactive TUI on a TTY: stdout is the terminal, so structured events come from the
  // pomtree-events sink extension. `regular` avoids the alternate screen buffer and mouse modes.
  return [
    "pi",
    "--tui-mode",
    "regular",
    "--session",
    PI_SESSION_PATH,
    ...(guide === false ? [] : ["--append-system-prompt", guide]),
    ...exts.flatMap((e) => ["--extension", e.path]),
    ...(tools ? ["--tools", tools.join(",")] : []),
    // `--no-approve` on every launch (Pi docs/cli.md: ignore trust-gated project-local files): trust.json lives in the
    // agent-writable ~/.pi/agent, so a recorded approval there must never load /workspace/.pi resources. Allowlist mode has it in
    // PI_ISOLATION_FLAGS.
    ...(allow !== undefined ? PI_ISOLATION_FLAGS : ["--no-approve"]),
    ...choice,
    "--",
    opts.prompt,
  ];
}

// Where a yielded session must be placed before `piArgv` runs. `ref` is the opaque CheckpointStore
// sessionRef; the caller fetches its bytes and writes them to `dest` (creating `dir`).
export interface SessionRestorePlan {
  ref: string;
  dest: string;
  dir: string;
}

export function sessionRestorePlan(sessionRef: string): SessionRestorePlan {
  return { ref: sessionRef, dest: PI_SESSION_PATH, dir: PI_SESSION_PATH.slice(0, PI_SESSION_PATH.lastIndexOf("/")) };
}

// Every `--mode json` record type Pi emits (session header, agent/turn, message, tool,
// queue/state, compaction, and retry events; see the canonical list in Pi's docs/json.md).
// Anything outside this set is protocol drift — a Pi upgrade added a record we do not
// understand — and must be surfaced rather than silently dropped.
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "session",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  // Extension-API-only names the pomtree-events sink writes (no JSON-mode equivalent).
  "thinking_level_select",
  "session_compact",
  "session_compact_failed",
  "user_input",
  "operator_diagnostic",
]);

// The record's `type` when it is not a known JSON-mode type, else undefined. Malformed records
// (non-object, or missing a `type` string) are not "unknown types" and return undefined.
export function unknownType(rec: unknown): string | undefined {
  if (!isObj(rec) || typeof rec.type !== "string") return undefined;
  return KNOWN_TYPES.has(rec.type) ? undefined : rec.type;
}

// Agent is finished (no automatic retries/compaction pending) when this record arrives.
export const isSettled = (rec: unknown): boolean => isObj(rec) && rec.type === "agent_settled";
export { isObj };
