// Journal-kind constants, deterministic ids and journal views.
import { createHash } from "node:crypto";

import { join } from "node:path";

import type {
  AgentId,
  AgentState,
  EscalationId,
  ExitCause,
  JournalEntry,
  JournalPayload,
  JsonValue,
  MessagingSender,
  Resources,
  Signal,
  AgentRecord,
  SpawnSpec,
  WorkspaceId,
} from "@pomtree/core";
import {
  boundToolDetails,
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  CONTAINER_CONFIG_ENV,
  type ContainerConfigValues,
  classifyExit,
  CODE_TEMPLATE_ID,
  containerConfigValues,
  EXIT_SIGNALS,
  isBrowserProfile,
  POMTREED_KINDS,
} from "@pomtree/core";
import type { ExitSignal, StateOpJournalPayload } from "@pomtree/core";
import { PI_SESSION_PATH } from "@pomtree/harness-pi";

import type { BackupPruneReport } from "@pomtree/store-sqlite";
import { oneLine } from "./accesslog.ts";
import type { DaemonDeps, JournalRow } from "./daemon-types.ts";
import { isResourceError } from "./lifecycle.ts";

// The body an asker receives when its escalation expired with no human answer.
export const EXPIRED_ANSWER = "expired: no human answered before the deadline; proceed with your documented default";
export const EXPIRED_BY: MessagingSender = { channel: "daemon", sender: "timeout" };
export const ESC_EXPIRED_KIND = POMTREED_KINDS.escalationExpired;
export const PROVIDER_DEGRADED_KIND = POMTREED_KINDS.providerDegraded;
export const FORK_KIND = POMTREED_KINDS.fork;
export const YIELD_INBOX_KIND = POMTREED_KINDS.yieldInbox;
export const YIELD_CTX_KIND = POMTREED_KINDS.yieldCtx;
// An operator interrupt message awaiting delivery as a resume prompt, and the marker that it was delivered.
export const INTERRUPT_KIND = POMTREED_KINDS.interrupt; // { key, body }
export const INTERRUPT_DONE_KIND = POMTREED_KINDS.interruptDone; // { keys, mode: "interrupted" | "woke" | "budget-grant" | "resume" } (InterruptMode)
export const OP_KIND = POMTREED_KINDS.op;
export const PUBLISHED_KIND = POMTREED_KINDS.published;
export const MERGED_KIND = POMTREED_KINDS.merged;
export const APPROVAL_KIND = POMTREED_KINDS.approval;
// Sandbox lifecycle on the agent's journal, so egress records (which carry a sandbox id) join to agents and gaps show:
// { phase: "started" | "exited", sandbox, agent, generation, host, exitCode?, oomKilled?, cause?, expected?, observedExitCode? }. Keyed per (agent, generation, phase, sandbox).
// `expected: true` marks a stop the daemon explains (the agent had already reported its result and the container then took the daemon's
// SIGTERM/SIGKILL): `exitCode` is then 0 (clean), `observedExitCode` keeps the real 143/137 for diagnosis, and no `cause` is set.
// TODO(identity): a core "sandbox_started"/"sandbox_exited" kind would replace this ext kind; the shape above is the proposal.
export const SANDBOX_LIFECYCLE_KIND = POMTREED_KINDS.sandbox;

// True when a 137/143 exit is the daemon's own stop of a container whose agent already reported its result: nothing failed and nothing
// needs restarting. An OOM kill is never expected. Any other code after a result (a crash) stays as observed.
export function stoppedAfterResult(o: { exitCode: number; oomKilled?: boolean; hasResult: boolean }): boolean {
  return o.hasResult && !o.oomKilled && (o.exitCode === 137 || o.exitCode === 143);
}

// The ONE classification of a sandbox exit, shared by the settle path and the adopt path. Delegates to core `classifyExit`; the
// daemon-side rules on top are: an expected stop (a result was reported, then our 137/143) has no cause, an OOM needs exit 137, a
// cancel or timeout of ours explains the exit, and the endpoint-unreachable cause applies only while no result was reported.
// Beyond oom_killed / host_stopped / endpoint_unreachable, exec_failed (125-127) and signal (any other >128 code) surface only
// when no result was reported; a plain non-zero `app_exit` stays cause-less (the run is simply `failed`).
export function classifySandboxExit(o: {
  exitCode: number;
  oomKilled?: boolean;
  hasResult: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  endpointUnreachable?: boolean;
  overBudget?: boolean;
}): { expected: boolean; cause: ExitCause | undefined } {
  const expected = !o.overBudget && stoppedAfterResult(o);
  if (expected) return { expected, cause: undefined };
  const ours = !!(o.cancelled || o.timedOut);
  const cause = classifyExit({
    exitCode: o.exitCode,
    oomKilled: !!o.oomKilled && o.exitCode === 137,
    cancelledByUs: ours,
    endpointUnreachable: !!o.endpointUnreachable && !ours && !o.hasResult,
  });
  if (cause === "app_exit") return { expected, cause: undefined };
  if ((cause === "exec_failed" || cause === "signal") && o.hasResult) return { expected, cause: undefined };
  return { expected, cause };
}

// The `exited` journal detail for a sandbox exit: the observed code, or a clean 0 plus `expected` and `observedExitCode` for an expected stop.
// `signal` names the signal behind a 129/130/137/143 observed code, so the exit is readable without a separate error entry.
export function exitedDetail(
  w: { exitCode: number; oomKilled?: boolean },
  expected: boolean,
): { exitCode: number; oomKilled?: boolean; expected?: true; observedExitCode?: number; signal?: ExitSignal } {
  const signal = EXIT_SIGNALS[w.exitCode];
  if (expected) return { exitCode: 0, expected: true, observedExitCode: w.exitCode, ...(signal && { signal }) };
  return { exitCode: w.exitCode, ...(w.oomKilled && { oomKilled: true }), ...(signal && { signal }) };
}

// The closed cause token a failed tool left in its error text, `(cause=<token> [net=ERR_X])` at the very end (the browser_capture tool's
// fixed message). Metadata only: nothing else of the text is read. Null when the text carries no such suffix.
export function toolFailureCauseOf(output: string | null | undefined): string | null {
  const m = typeof output === "string" ? /\(cause=([a-z_]{1,32})(?: net=ERR_[A-Z0-9_]{1,64})?\)\s*$/.exec(output) : null;
  return m?.[1] ?? null;
}

// The cause token of the LAST failed tool result on a journal (oldest first), or null: what a worker's tool reported before it ended.
export function lastToolFailureCause(rows: readonly { payload: { kind: string; ok?: boolean; output?: string } }[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = rows[i]!.payload;
    if (p.kind === "tool_result" && p.ok === false) {
      const cause = toolFailureCauseOf(p.output);
      if (cause !== null) return cause;
    }
  }
  return null;
}
// One hop of a bubbled ask or approval: { escalation, idx, holder, hopDeadlineAt?, auto? } on the requester's journal.
export const ESC_HOP_KIND = POMTREED_KINDS.escalationHop;
// Budget escalation (docs/economy.md section 13), all on the asker's journal: the park (`{approval, requested, spent, budget}`),
// the grant (`{approval, amount, payer, newBudget}`), the refusal (`{approval, reason}`) and the keyed deadline shift.
export const BUDGET_ESCALATED_KIND = POMTREED_KINDS.budgetEscalated;
export const BUDGET_GRANTED_KIND = POMTREED_KINDS.budgetGranted;
export const BUDGET_DENIED_KIND = POMTREED_KINDS.budgetDenied;

// Deterministic so a retry or replay after restart reuses the key, while a new transition (other generation or target) never collides.
export const transitionKey = (id: AgentId, generation: number, to: AgentState) => `${id}:${generation}:${to}`;

// The wake text handed to the harness (Pi appends it to the restored conversation).
export const signalToWake = (signal: Signal): string => {
  switch (signal.kind) {
    case "message":
      return signal.body;
    case "human_message":
      return signal.body;
    case "child_result":
      return `child ${signal.child} reported ${signal.status}. Handoff: ${signal.handoff}`;
    case "child_exited":
      return `child ${signal.child} exited ${signal.exit}${signal.handoff ? `. Handoff: ${signal.handoff}` : ""}`;
    case "timeout":
      return "timer elapsed";
    case "budget_warning":
      return `budget warning: ${usd(signal.remainingMicros)} of ${usd(signal.budgetMicros)} left; run \`pomtree push\` now to save your work, then wrap up`;
    case "approval_decided":
      return `approval ${signal.approval} for ${signal.action.kind} ${signal.action.target} is ${signal.state}`;
    case "escalation":
      return `${signal.subject} escalation ${signal.escalation} from ${signal.from} awaits your decision: ${signal.body}`;
    default:
      return "woken";
  }
};

// The catch handler for an audit-relevant journal write whose failure must not abort the operation (control flow is unchanged:
// it resolves). It never reports the raw error or any payload: it logs one fixed-message line naming the call site (`what` is a
// fixed label, never data), and where the journal still accepts writes it records a `host_error` for the agent, keyed by
// (label, agent, generation) so a failure storm journals once. Used for the journal writes and registry sandbox-binding writes the audit trail relies on. If that write fails too, the log line is all that remains.
export type JournalRecord = (r: AgentRecord, payload: JournalPayload, idempotencyKey: string) => Promise<unknown>;
export const journalFailed =
  (record: JournalRecord, rec: AgentRecord, what: string): (() => Promise<void>) =>
  async () => {
    console.error(`pomtreed: audit write failed (${what})`);
    await record(
      rec,
      { kind: "host_error", component: "journal", message: `audit write failed: ${what}` },
      `host-error:journal:${what}:${rec.id}:${rec.generation}`,
    ).then(
      () => undefined,
      () => undefined,
    );
  };

export const clip = (s: string, n = 200) => {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// A short human-readable summary of a journal payload for the audit/chat views. Untrusted text is
// clipped, never HTML-escaped here (the panes paint via textContent).
export function journalSummary(payload: JournalPayload): string {
  switch (payload.kind) {
    case "message":
      return `${payload.role}: ${clip(payload.text)}`;
    case "tool_call":
      return `tool ${payload.tool}`;
    case "tool_result":
      return `result ${payload.ok ? "ok" : "error"}${payload.ok ? "" : `: ${clip(payload.output)}`}`;
    case "usage":
      return `${payload.inputTokens}→${payload.outputTokens} tok`;
    case "error":
      return `error: ${clip(payload.message)}`;
    case "provider_error":
      return `${payload.code}: ${clip(payload.message)}`;
    case "spawned":
      return "spawned";
    case "exited":
      return `exited ${payload.exit}`;
    case "signal":
      return `signal ${payload.signal.kind}`;
    case "escalation_raised":
      return `ask: ${clip(payload.question)}`;
    case "escalation_answered":
      return `answer: ${clip(payload.answer)}`;
    case "message_sent":
      return `${payload.purpose}: ${clip(payload.subject)}`;
    case "message_received":
      return `from ${payload.from.channel}:${payload.from.sender}: ${clip(payload.body)}`;
    case "report_published":
      return `report ${payload.name}`;
    case "provider_paused":
      return `provider paused (${payload.scope})`;
    case "provider_resumed":
      return `provider resumed (${payload.scope})`;
    case "host_error":
      return `${payload.component}: ${clip(payload.message)}`;
    case "merge_failed":
      return `${payload.code}: ${clip(payload.message)}`;
    case POMTREED_KINDS.stateOp: {
      const o = payload as unknown as StateOpJournalPayload; // metadata only: the entry never carries a value
      const at = o.key ?? (o.prefix !== undefined ? `${o.prefix}*` : "");
      return `state ${o.op} ${o.owner}${at ? `/${at}` : ""}${o.rev !== undefined ? ` rev ${o.rev}` : ""}${o.count !== undefined ? ` x${o.count}` : ""} by ${o.by}`;
    }
    default:
      return payload.kind;
  }
}

// Per-field cap on stored tool input/output (UTF-8 bytes); the audit summary stays one line.
export const MAX_TOOL_FIELD_BYTES = 16 * 1024;

// Cuts on a code-point boundary and appends a marker naming the original byte count.
export function capText(s: string, max = MAX_TOOL_FIELD_BYTES): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  const head = new TextDecoder().decode(buf.subarray(0, max), { stream: true });
  return `${head}\n[pomtree: truncated, ${buf.length} bytes originally]`;
}

// Bounds tool_call.input / tool_result.output before journaling so one giant payload cannot bloat the DB.
// An oversize input becomes its capped JSON text (a string), never silently dropped.
// TODO(tool-output-redaction): tool input/output is stored and shown raw (an agent may cat a credentials
// file); the journal and chat UI are operator-scoped, but nothing scrubs secrets yet.
export function capToolPayload(p: JournalPayload): JournalPayload {
  if (p.kind === "tool_result") {
    // `details` is bounded again here (a harness other than Pi's, or a fake, may emit any value): a closed drop marker, never a clipped fragment.
    const q = p.details === undefined ? p : { ...p, details: boundToolDetails(p.details) as JsonValue };
    return q.output && Buffer.byteLength(q.output) > MAX_TOOL_FIELD_BYTES ? { ...q, output: capText(q.output) } : q;
  }
  if (p.kind === "tool_call") {
    const json = JSON.stringify(p.input) ?? "";
    return Buffer.byteLength(json) > MAX_TOOL_FIELD_BYTES ? { ...p, input: capText(json) } : p;
  }
  return p;
}

// In-container git identity (docker exec terminals bypass the image ENTRYPOINT, so it is set in the container env).
// `safe.directory *`: the agent's clone is owned by the host user, not the container user.
// TODO(identity): the author is the agent id with a synthetic `@agents.pomtree` email; a configurable per-agent author needs a
// Workspace port extension so host-side commits carry it too.
export const gitIdentityEnv = (agent: AgentId): Record<string, string> => ({
  GIT_AUTHOR_NAME: agent,
  GIT_AUTHOR_EMAIL: `${agent}@agents.pomtree`,
  GIT_COMMITTER_NAME: agent,
  GIT_COMMITTER_EMAIL: `${agent}@agents.pomtree`,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
});

// The sandbox resources a persisted spec asks for; undefined when it names none.
// `defaultMemoryBytes` (capacity.containerMemoryBytes, passed by main.ts) applies when the spec names no memory, so the value
// the memory gate and the auto session cap plan for is also the container's real limit; absent = the sandbox's own default.
export function specResources(spec: SpawnSpec, defaultMemoryBytes?: number): Resources | undefined {
  const memoryBytes = spec.memoryBytes ?? defaultMemoryBytes;
  const r: Resources = {
    ...(spec.cpus !== undefined && { cpus: spec.cpus }),
    ...(memoryBytes !== undefined && { memoryBytes }),
    ...(spec.shmBytes !== undefined && { shmBytes: spec.shmBytes }),
    ...(spec.diskBytes !== undefined && { diskBytes: spec.diskBytes }),
  };
  return Object.keys(r).length > 0 ? r : undefined;
}

// Env the controller alone sets for a browser worker, from the persisted spec. Never taken from a spawn request or a global env.
export const BROWSER_ENV_KEYS = [
  "PTREE_BROWSER",
  "PTREE_BROWSER_MAX_STEPS",
  "PTREE_BROWSER_MAX_MS",
  "PTREE_BROWSER_USER_AGENT",
  "PTREE_BROWSER_PROFILE",
] as const;

// PTREE_BROWSER_PROFILE only when the spec names a profile (absent = the capture-only worker's exact four keys). An unknown
// profile on a persisted spec (corrupt or newer) throws rather than starting a capture worker in its place.
// PTREE_BROWSER_USER_AGENT is `userAgent`, the resolved workflow.fetch.userAgent (DaemonDeps.fetchUserAgent), which the browser
// capture appends to Chromium's own User-Agent. Config resolves blank to the default, so an absent or empty value is a wiring bug: it throws.
export function browserEnv(spec: SpawnSpec, userAgent: string | undefined): Record<string, string> {
  if (!spec.browser) return {};
  const profile: unknown = spec.browser.profile;
  if (profile !== undefined && !isBrowserProfile(profile)) throw new Error(`unknown browser profile ${JSON.stringify(profile)}`);
  if (userAgent === undefined || userAgent === "")
    throw new Error(
      "browser worker refused: no fetch identity (DaemonDeps.fetchUserAgent is unset or empty). Pass the resolved workflow.fetch.userAgent, which config resolves to a non-empty value; this is a pomtreed wiring bug",
    );
  return {
    PTREE_BROWSER: "1",
    PTREE_BROWSER_MAX_STEPS: String(spec.browser.maxSteps),
    PTREE_BROWSER_MAX_MS: String(spec.browser.maxMs),
    PTREE_BROWSER_USER_AGENT: userAgent,
    ...(profile !== undefined && { PTREE_BROWSER_PROFILE: profile }),
  };
}

// `env` without the keys only the controller sets: the browser keys, so a global env (the terminal's) cannot turn a container
// into a browser worker, and the container config document, so a caller cannot supply its own bounds.
export function withoutControllerEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out = { ...env };
  for (const k of [...BROWSER_ENV_KEYS, CONTAINER_CONFIG_ENV]) delete out[k];
  return out;
}

// The delivered (container) subset at the registry defaults: DaemonDeps.containerConfig when absent (tests, embedders).
export const DEFAULT_CONTAINER_CONFIG: ContainerConfigValues = containerConfigValues(CONFIG_REGISTRY, CONFIG_DEFAULTS);

// The template fields a checkpoint records, from the agent's persisted spec (rows written before templates were recorded read as the built-in `code` template).
export const checkpointTemplate = (spec: SpawnSpec) => ({
  template: spec.template ?? CODE_TEMPLATE_ID,
  templateDigest: spec.templateDigest ?? null,
  resumeLevel: spec.resume ?? ("session" as const),
});

export const STATE_PLACEHOLDER = "<state>";

// Replace every occurrence of a configured host path root (state dir, repo dir, session root, socket, ... and their
// realpaths) in `text` with a placeholder, so an exception message that carries an absolute path never reaches a
// journal row. Longest root first; a match must
// sit on a path boundary (root `/t/x` matches `/t/x`, `/t/x/` and `/t/x/sub` but not `/t/xyz` or `/a/t/x`).
// Roots of "" or "/" are ignored.
export function pathRedactor(roots: readonly string[]): (text: string) => string {
  const sorted = [...new Set(roots.map((r) => r.replace(/\/+$/, "")).filter((r) => r.length > 1))].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return (text) => text;
  const alt = sorted.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_.~-])(?:${alt})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "g");
  return (text) => text.replace(re, STATE_PLACEHOLDER);
}

export const redactPaths = (text: string, roots: readonly string[]): string => pathRedactor(roots)(text);

// Every string anywhere in a journal payload (message text, error text, tool input/output, nested signals) with
// configured host paths redacted; the payload is returned unchanged (same reference) when nothing matched.
export function redactPayload(p: JournalPayload, roots: readonly string[]): JournalPayload {
  const redact = pathRedactor(roots);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v);
    if (Array.isArray(v)) {
      const out = v.map(walk);
      return out.some((x, i) => x !== v[i]) ? out : v;
    }
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        const y = walk(x);
        if (y !== x) changed = true;
        out[k] = y;
      }
      return changed ? out : v;
    }
    return v;
  };
  return walk(p) as JournalPayload;
}

export function journalRow(e: JournalEntry): JournalRow {
  const row: JournalRow = { seq: e.seq, ts: e.ts, agent: e.agent, kind: e.payload.kind, summary: journalSummary(e.payload) };
  // Structured tool view for the chat pane (operator routes only); callId pairs call with result.
  if (e.payload.kind === "tool_call") row.tool = { callId: e.payload.callId, tool: e.payload.tool, input: e.payload.input };
  else if (e.payload.kind === "tool_result") row.tool = { callId: e.payload.callId, ok: e.payload.ok, output: e.payload.output };
  if (e.payload.kind === "signal" && e.payload.signal.kind === "child_exited" && e.payload.signal.handoff) {
    const s = e.payload.signal;
    row.handoff = {
      child: s.child,
      exit: s.exit,
      text: s.handoff!,
      ...(s.branch !== undefined && { branch: s.branch }),
      ...(s.spentMicros !== undefined && { spentMicros: s.spentMicros }),
      ...(s.budgetMicros !== undefined && { budgetMicros: s.budgetMicros }),
      ...(s.files && { files: s.files }),
    };
  }
  return row;
}

// Cap on the in-memory inbound receipt cache. The underlying stores are idempotent, so evicting an old
// receipt only re-runs a no-op write on a very-late retry (no double-route).
export const MAX_INBOUND_RECEIPTS = 10_000;

// Canonical JSON for env-manifest hashing: object keys are sorted recursively so two templates that
// describe the same env hash equal regardless of key order in the file.
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

// The env manifest hash for a template's `env` overlay. TODO(env): only persisted on SpawnSpec;
// the per-spawn env layer mounting is still deferred, so nothing mounts this yet.
export const envManifestHashOf = (env: unknown): string => createHash("sha256").update(stableJson(env)).digest("hex");

// The session file and its container-side parent, derived from harness-pi's PI_SESSION_PATH so the
// bind mount always matches the `--session` path Pi is started with. The host side lives under
// deps.sessionRoot/<agent> so the JSONL is outside the git worktree (never in a checkpoint path).
export const SESSION_MOUNT_DIR = PI_SESSION_PATH.slice(0, PI_SESSION_PATH.lastIndexOf("/"));
export const SESSION_FILE = PI_SESSION_PATH.slice(PI_SESSION_PATH.lastIndexOf("/") + 1);

// Where the agent's working folder appears in the container (the `workspace` mount's containerPath).
export const WORKSPACE_MOUNT_DIR = "/workspace";

// The session mount sits inside the workspace mount, so every folder's `.git/info/exclude` (GitWorkspace infoExclude, main.ts) ignores it
// as a root-anchored directory: Pi's session and event sink are host-managed runtime files, never uncommitted work for `pomtree result`'s
// check (Sandbox.resultWork) or an approved save's `git add -A`. Derived from SESSION_MOUNT_DIR, so a moved mount moves the pattern.
if (!SESSION_MOUNT_DIR.startsWith(`${WORKSPACE_MOUNT_DIR}/`)) throw new Error("the session mount must sit inside the workspace mount");
export const WORKSPACE_GIT_EXCLUDES: readonly string[] = [`${SESSION_MOUNT_DIR.slice(WORKSPACE_MOUNT_DIR.length)}/`];

// Deterministic escalation id from (agent, key): a replayed ask finds its escalation without a key lookup.
export const escalationIdFor = (agent: AgentId, key: string): EscalationId => `es-${createHash("sha256").update(`${agent}\0${key}`).digest("hex")}`;

// Deterministic extension-call id: a replayed call (same agent/extension/key) reuses the journaled
// proxy_call entry and its callId, so the proxy_call/proxy_result pair stays linked across retries.
export const extCallIdFor = (agent: AgentId, extension: string, key: string): string =>
  `ext-${createHash("sha256").update(`${agent}\0${extension}\0${key}`).digest("hex").slice(0, 24)}`;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Truncates agent- or host-supplied text for a human-facing channel: control characters (other than newline/tab) are
// stripped and an over-length value is cut with a visible marker.
export function clipText(text: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return clean.length <= max ? clean : `${clean.slice(0, max)}… [truncated ${clean.length - max} chars]`;
}

// Bidi controls, zero-width chars, and the Unicode line separators (NEL, LS, PS).
export const INVISIBLE_RE = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\u200b-\u200d\u2060\ufeff\u0085\u2028\u2029]/g;

// For agent-bound text: strips invisible characters, then clips; does no mention-breaking (Discord-specific, in toUser).
export function clipAgentText(text: string, max: number): string {
  return clipText(text.replace(INVISIBLE_RE, ""), max);
}

// Handoff convention (pomtree result): a non-blank `summary` string, <= MAX_HANDOFF_BYTES (core config/image-facts.ts).
export const HANDOFF_REQUIRED = 'A handoff is required: pass --summary "what you did, where the outputs are, anything the parent must know"';
export const SIGNAL_HANDOFF_CHARS = 2048;

// The result as a handoff object when it carries a non-blank summary, else null.
export function handoffOf(result: unknown): (Record<string, unknown> & { summary: string }) | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const s = (result as { summary?: unknown }).summary;
  return typeof s === "string" && s.trim() !== "" ? (result as Record<string, unknown> & { summary: string }) : null;
}

export const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

// TODO(config-registry): only the e2e drift test (config-registry-drift.test.ts) and daemon.jretention.test.ts still call this
// env-map parser; pomtreed resolves journal.retentionMs/keepPerAgent in daemon-config.ts. Delete it with that drift row.
// POMTREED_JOURNAL_RETENTION_MS / POMTREED_JOURNAL_KEEP_PER_AGENT: retention is off unless the first is set. Fail closed:
// a set-but-invalid value throws rather than silently running with (or without) pruning.
export function parseJournalRetentionEnv(env: Record<string, string | undefined>): { retentionMs: number; keepPerAgent: number } | null {
  const num = (k: string, min: number): number | undefined => {
    const raw = env[k];
    if (raw === undefined || raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${k} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
    return n;
  };
  const retentionMs = num("POMTREED_JOURNAL_RETENTION_MS", 1);
  const keep = num("POMTREED_JOURNAL_KEEP_PER_AGENT", 0);
  if (retentionMs === undefined) {
    if (keep !== undefined) throw new Error("POMTREED_JOURNAL_KEEP_PER_AGENT requires POMTREED_JOURNAL_RETENTION_MS");
    return null;
  }
  return { retentionMs, keepPerAgent: keep ?? 1000 };
}

// Why an agent yielded under the hood (a long `pomtree wait` / `inbox --wait` / `ask --wait`): journaled beside the
// checkpoint so the resume can tell the agent what happened.
export type WaitCtx =
  | { kind: "child"; child: AgentId; timeoutMs: number; at: number }
  | { kind: "inbox"; timeoutMs: number; at: number }
  | { kind: "ask"; escalation: string; timeoutMs: number; at: number };

// Whether a store write failed in a way the daemon should treat as a store outage (fail closed).
export function isStoreDown(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "SQLITE_FULL" || code === "SQLITE_IOERR" || code === "SQLITE_CORRUPT" || code === "SQLITE_BUSY") return true;
  return isResourceError(e);
}

// The id of the agent's kept folder, or null when it is not on this node. `create` on an existing folder returns its id.
export async function folderId(d: Pick<DaemonDeps, "workspace">, agent: AgentId): Promise<WorkspaceId | null> {
  return (await d.workspace.has(agent)) ? (await d.workspace.create(agent, {})).workspace : null;
}

// Conservative credential-like basenames flagged on the publish approval target (flag-only, never silently pushed).
export function credentialPath(name: string): boolean {
  const b = name.toLowerCase();
  return (
    /^\.env(\..*)?$/.test(b) ||
    b === "auth.json" ||
    b.endsWith(".pem") ||
    b.endsWith(".key") ||
    b.startsWith("id_rsa") ||
    b.startsWith("credentials") ||
    b === ".netrc" ||
    b === ".npmrc" ||
    b.endsWith(".p12") ||
    b.endsWith(".pfx")
  );
}

// The container spec of an agent. Only container code paths read it: a deterministic record has no SpawnSpec and fails here.
export function containerSpec(r: AgentRecord): SpawnSpec {
  if (r.executor !== "container") throw new Error(`agent ${r.id} is not a container agent`);
  return r.spec;
}

// The stderr lines for a store's backup-retention report after a migrating open (store-sqlite BackupPruneReport): one per
// backup kept, removed, or not removed. Paths and the error message only, never file contents.
export function backupPruneLines(db: string, r: BackupPruneReport): string[] {
  return [
    `pomtreed: ${db} migration backup kept: ${r.kept}`,
    ...r.removed.map((path) => `pomtreed: ${db} older migration backup removed: ${path}`),
    ...r.errors.map((e) => `pomtreed: WARNING: ${db} older migration backup not removed: ${e.path}: ${oneLine(e.message, 300)}`),
  ];
}

// The `spawned` journal entry: the template the agent was resolved with (its spec records it at create), so the audit trail and the
// trace header name it. A deterministic task has no template and journals the bare entry.
export function spawnedPayload(r: AgentRecord): { kind: "spawned"; template?: string } {
  return r.executor === "container" && r.spec.template !== undefined ? { kind: "spawned", template: r.spec.template } : { kind: "spawned" };
}
