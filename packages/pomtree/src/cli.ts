import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abandonBody, abandonLeft, renderAbandon } from "./abandon.ts";
import { mergeOutcome, MERGE_EXIT } from "./merge.ts";
import { CaptureUsage, captureListRows, captureRequestOf, captureView, isCaptureResponse, renderCaptureRecord } from "./capture.ts";
import { bundleArgs, bundleFailure, effectivePushKey, fetchArgs, gitTooOld, isRefList, planBundle, pullPath, pushError, runGit } from "./git.ts";
import type { GitRunner } from "./git.ts";
import type {
  AgentRecord,
  CaptureListResponse,
  CaptureRequestBody,
  CaptureShowResponse,
  Checkpoint,
  Escalation,
  ExtensionSpec,
  JournalEntry,
  Report,
  Schedule,
  Template,
  WaitCondition,
} from "@pomtree/core";
import { TransportError } from "./client.ts";
import { ContainerConfigError, readContainerConfig } from "./container-contract.gen.ts";
import type { Transport } from "./client.ts";
import { CLEAR, pollTree, renderRows } from "./top.ts";
import type { DisplayRow } from "./top.ts";
import { effectiveAskKey, parseGeneration, parseOptions, renderBudget } from "./ask.ts";
import { effectiveReportKey, isTextMediaType, renderReport, reportPublishQuery } from "./reports.ts";
import { effectiveExtKey, parseInput, renderExtCallResult, renderExtFetchResult, renderExtList, renderExtSearchResult } from "./ext.ts";
import type { ExtCallResult } from "./ext.ts";
import { stripControl } from "./sanitize.ts";
import { effectiveSendKey } from "./send.ts";
import { buildUiCommand, formatUiResult } from "./uiCmd.ts";
import { effectiveYieldKey, parseYieldWait } from "./yield.ts";
import {
  parseExpectRev,
  chunkImportDocs,
  parseImportFile,
  parseOlderThan,
  renderStateDoc,
  renderStateList,
  stateErrorMessage,
  validKey,
  validOwner,
  validPrefix,
} from "./state.ts";
import {
  colorEnabled,
  doctorReasons,
  formatCost,
  formatMoney,
  parseBudgetFlag,
  smallBudgetWarning,
  SMALL_BUDGET_MICROS,
  isSummary,
  renderDoctor,
  transportHint,
  renderSummary,
  renderSummaryLine,
  transcriptLine,
  usageFor,
} from "./ux.ts";
import type { Summary } from "./ux.ts";
import { cronError, renderScheduleTable } from "./sched.ts";

export const EXIT = { ok: 0, error: 1, usage: 2, notFound: 3, denied: 4, conflict: 5, unreachable: 6, timeout: 7, partial: 13 } as const;

export interface Io {
  call: Transport;
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY?: boolean; // stdout is a terminal; `top` renders once and exits when it is not
  version: string; // reported by --version; read from this package's package.json
  sleep?: (ms: number) => Promise<void>; // injectable for retry backoff (default: setTimeout)
  now?: () => number; // injectable clock (drain deadline)
  env?: Record<string, string | undefined>; // NO_COLOR, POMTREED_STATE_DIR (error hints), POMTREE_BASE_COMMIT (push); default: none
  git?: GitRunner; // push/pull run git through this (default: the real git); test seam
  tmpRoot?: string; // root for temp bundle dirs (default: os.tmpdir()); test seam
  cwd?: string; // the clone push/pull operate on (default: process.cwd())
  confirm?: (question: string) => Promise<boolean>; // interactive y/N prompt (state rm); absent means non-interactive, so --yes is required
}

// `result` is the agent's last act; an unreachable daemon (e.g. host.docker.internal not yet
// routable) must not turn a finished run into a mute failure, so it is retried with backoff.
const RESULT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const STATE_RETRY_DELAYS_MS = [500, 1000, 2000];

const AGENT_HINT =
  "(this command is for the host operator; agents can use: spawn, wait, reap, inbox, peers, send, ask, budget, yield, await-user, result, whoami, ext, push, pull, merge, resume, report publish, sched, state, decide, answer, pass, capture)";

class Usage extends Error {}

// The handoff a child left (record.result.summary), for wait/reap output; control characters stripped.
const handoffOf = (rec: AgentRecord): { summary: string; files: string[] } | null => {
  const r = rec.result as { summary?: unknown; files?: unknown } | null;
  if (r === null || typeof r !== "object" || typeof r.summary !== "string" || r.summary.trim() === "") return null;
  return { summary: r.summary, files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string") : [] };
};
const indent = (t: string) =>
  stripControl(t)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
const handoffBlock = (rec: AgentRecord, merge?: { status: string; detail: string }): string => {
  const h = handoffOf(rec);
  const lines = [
    ...(h ? ["handoff:", indent(h.summary), ...(h.files.length ? [`files: ${h.files.map(stripControl).join(", ")}`] : [])] : []),
    ...(merge ? [`branch: agent/${rec.id}`, `merge: ${merge.status}${merge.detail ? ` (${stripControl(merge.detail)})` : ""}`] : []),
  ];
  return lines.length ? `\n${lines.join("\n")}` : "";
};
// One inbox signal: JSON for most; a child_exited with a handoff reads as the handoff itself.
// Human output leads with the signal's short id (first 8 chars; the full id is in --json), then the signal minus its id.
const signalLine = (x: { kind: string; [k: string]: unknown }): string => {
  const { id, ...sig } = x;
  const tag = typeof id === "string" ? `[${id.slice(0, 8)}] ` : "";
  return tag + signalBody(sig as { kind: string; [k: string]: unknown });
};
const signalBody = (x: { kind: string; [k: string]: unknown }): string => {
  if (x.kind === "child_result" && typeof x.handoff === "string") return `child_result ${String(x.child)} ${String(x.status)}\nhandoff:\n${indent(x.handoff)}`;
  if (x.kind !== "child_exited" || typeof x.handoff !== "string") return JSON.stringify(x);
  const spent =
    typeof x.spentMicros === "number"
      ? ` spent ${formatMoney(x.spentMicros)}${typeof x.budgetMicros === "number" ? ` of ${formatMoney(x.budgetMicros)}` : ""}`
      : "";
  const files = Array.isArray(x.files) && x.files.length ? `\n  files: ${x.files.map((f) => stripControl(String(f))).join(", ")}` : "";
  return `child_exited ${String(x.child)} ${String(x.exit)}${x.cause ? ` (${String(x.cause)})` : ""}${spent}${typeof x.branch === "string" ? ` branch ${x.branch}` : ""}\nhandoff:\n${indent(x.handoff)}${files}`;
};
class Failure extends Error {
  code: number;
  hint?: string;
  constructor(code: number, message: string, hint?: string) {
    super(message);
    this.hint = hint;
    this.code = code;
  }
}

const USAGE = `usage: pomtree [--json] <command>
(commands marked "(operator)" or not marked "(agent)" below may need the host operator token; inside an agent container use:
 spawn, wait, reap, inbox, peers, send, ask, budget, yield, await-user, result, whoami, ext, push, pull, merge, resume, report publish, sched, state, decide, answer, pass, capture)
  (budgets: "\$5" or "\$0.50" are dollars; a bare number is raw micro-dollars µ$, 1,000,000 = \$1)
  spawn --task T [--name N] [--budget \$USD|MICROS] [--deadline DURATION|0 (0 = unlimited, operator only)] [--wrapup DURATION] [--disposition hold|reap-on-exit] [--ttl DURATION (hold only)] [--key K] [--template NAME] [--model PROVIDER/ID] [--fork] [--from-commit C] [--session S]   start a child agent
  workflow launch OWNER/NAME --input JSON [--key K] [--budget \$USD|MICROS] [--deadline DURATION|0]   launch a registered workflow (operator only; input defaults to {})
  result [--status succeeded|failed] [--summary TEXT | --summary-file PATH] [--save-uncommitted TOKEN] [--key K] [JSON]
                                                            report this agent's result; completing REQUIRES a handoff summary (what you did,
                                                            where the outputs are, what the parent must know); extra JSON keys (files, notes) are kept
  wait ID [--timeout MS]                                    wait until an agent exits (exit 7 on timeout); an agent's wait over ~20s yields instead
                                                            (you are resumed with the outcome; keep waits short to stay running)
  reap ID [--key K]                                         collect an exited child and return its budget. DELETES the child's clone: unpushed work
                                                            in it is lost; run pomtree pull --from ID first
  inbox [--peek] [--wait MS] [--key K]                      read this agent's signals (child_exited, ...) and consume them (acked by id after printing;
                                                            --peek reads without consuming); a long --wait yields and resumes on a message
  decide ID approve|deny|pass [--grant \$USD|MICROS] [--why TEXT] [--key K]
                                                            decide an approval (ID from an escalation signal): approve, deny, or pass it up to the
                                                            next ancestor. For a budget_raise, approve grants the requested amount unless --grant
                                                            sets another (approve only). An agent's grant comes out of its own remaining budget; if
                                                            it cannot cover it, "decide ID pass" sends the request up another layer. The operator's
                                                            grant draws on root's remaining budget (409 insufficient_budget when short). Exit 5 if
                                                            already decided or the budget cannot cover the grant (agent or operator)
  answer ID BODY [--key K]                                  answer an escalation (ID from an escalation signal; an ask from a descendant) (agent or operator)
  pass ID [--key K]                                         pass an escalation up to the next ancestor, ultimately the human; for an approval
                                                            id use "decide ID pass" (agent or operator)
  peers                                                     list the agents this agent can address
  send ID BODY [--interrupt] [--key K]                      send a message to a peer's mailbox; the operator's --interrupt stops the agent's
                                                            current work and delivers it now (agents may not interrupt)
  ui open|focus|close|maximize|minimize VIEW [AGENT [REPORT]] | ui close VIEW [AGENT [REPORT]] --others|--left|--right | ui close --all |
  ui close|maximize|minimize --focused [--others|--left|--right] |
  ui restore [VIEW [AGENT [REPORT]]] | ui focus --dir left|right|up|down | ui arrange single|columns|rows|grid | ui reset |
  ui follow on|off [--views terminal,browser] [--of AGENT] [--key K]
                                                            drive the operator web UI from a session (operator only; agents cannot use it).
                                                            VIEW is e.g. terminal, browser, report, tree; --others/--left/--right close the windows
                                                            around VIEW in the bar's order, --all closes every window, --focused targets the focused window; minimize keeps the window listed
                                                            in the bar; restore un-maximizes, or with VIEW brings that window back.
                                                            follow opens a window when a child spawns (--views 1-4 views, default terminal; --of limits it to children of AGENT).
                                                            It reaches only tabs connected to this daemon: exit 0 sent to at least one tab; exit 3
                                                            (not found) recorded but no tab is connected (nothing applied and a later tab will not replay it:
                                                            open /ui and run it again); exit 2 usage error or rejected by the daemon; exit 1 unexpected reply
  ask QUESTION [--options A,B] [--wait MS] [--key K] [--json]  raise a human escalation; a --wait over ~20s yields and resumes on the answer
  budget [--json]                                             show this agent's remaining budget
  yield --until COND [--key K] [--json]                     checkpoint and park until COND (agent)
  await-user [--key K] [--json]                             declare that you now wait for the human's reply; refused (exit 5) unless a human
                                                            message (typed or operator) is unanswered; otherwise use result, yield or keep working (agent)
  ps [--state S] [--parent ID]                              list agents (with a totals footer)
  tree [--json]                                             show the agent tree (nesting)
  spend [--json]                                            totals: agents by state, spend, open escalations (operator)
  escalations ls [--state open|answered] [--agent ID] [--json]  list human escalations (operator)
  escalations answer ID TEXT [--key K] [--json]             answer an open escalation (operator)
  show ID                                                   agent state and recent events
  top [--once] [--interval MS]                              live terminal view of the agent tree
  logs ID [-f] [--transcript [--limit N] [--raw]]                 event stream, or newest session transcript entries
  trace ID [--children] [--raw] [--short] [--out PATH]      full session trace as Markdown for pasting into a chat (operator; secrets redacted unless --raw)
  cancel ID [--grace MS] [--key K]                          ask an agent to stop
  kill ID [--key K]                                         force-stop an agent
  abandon ID [--reason TEXT]                                end a run whose sandbox backend is gone: kill its sandbox on the backend that holds it, or
                                                            say where it was left (operator)
  extend ID [--deadline DURATION] [--key K]                 extend an agent's session deadline (operator; default +one default session)
  resume ID [--force] [--key K]                             resume a yielded agent; --force overrides quarantine (operator). An agent may resume
                                                            an exited, unreaped child or descendant it started, to resolve a merge conflict
  drain [HOST] [--deadline MS] [--key K]                    stop admission, leave containers adoptable (operator; default deadline 30000)
  whoami                                                    preflight: check this agent's token and endpoint
  push [--branch NAME] [--force] [--key K] [--json]         bundle this clone's branch (default: current) beyond POMTREE_BASE_COMMIT and send it to
                                                            the daemon; prints the ingested refs. You must run this yourself before finishing (agent).
                                                            A non-fast-forward push is refused (exit 5, non_fast_forward): pomtree pull, then merge or
                                                            rebase. --force is operator-only; an agent's forced push is refused (exit 4).
  pull [--from AGENT] [--json]                              fetch the default branch and AGENT's (default: self) ingested branches into
                                                            refs/remotes/pomtreed/* and refs/remotes/pomtreed-agents/* (agent)
  merge CHILD [--into BRANCH] [--key K] [--json]            ask the controller to merge CHILD's pushed branch into your own branch (or --into
                                                            BRANCH, one of yours); then run pomtree pull. merge --into DEFAULT (no CHILD): the
                                                            top-level agent merges its own pushed branch into the default branch. Exit 0 merged; 5 conflict (paths printed);
                                                            8 check failed; 9 awaits the user's approval (merge into the default branch; retry the
                                                            same command later); 10 target moved (pull, retry); 11 escalated to the user after
                                                            three failed rounds (stop and wait); 12 refused by policy (denied path, stale source,
                                                            bad ref: retrying will not help); 2 usage or --key already used for a different merge;
                                                            4 denied; 3 unknown child; 1 other. --key retries the same call (agent)
  report publish PATH [--name N] [--key K] [--media-type M]  publish a static report (agent)
  report list [AGENT]                                        list reports
  report show AGENT REPORT [--out PATH]                      show a report's metadata and content
  report rm AGENT REPORT [--key K]                           delete a report (operator)
  sched ls [--json]                                         list cron schedules (agents: only their own)
  sched add ID CRON TASK [--tz T] [--missed skip|run-one|catch-up] [--overlap skip|queue] [--jitter MS] [--json]
                         [--agent ID | --budget \$USD|MICROS --deadline MS --template NAME --model PROVIDER/ID]
                                                            add or replace a schedule. With --agent ID each fire wakes that agent with TASK
                                                            (steer if running/waiting, resume if yielded); without it each fire spawns a root
                                                            child (the spawn flags apply). An agent's schedules always wake itself: no flags
                                                            besides the policy ones, at most 5, at least 1 minute apart
  sched rm ID [--key K] [--json]                             delete a schedule (agents: only their own)
  sched pause|resume ID [--key K] [--json]                  pause a schedule (never fires) / resume it (clears the breaker)
  state ls [--owner O] [--prefix P] [--after K] [--limit N] [--json]  list durable workflow-store documents (agents: without --owner, the owners you may read)
  state show OWNER KEY [--json]                             print one document with its revision
  state put OWNER KEY JSON|--file F [--expect-rev N|none] [--key K]   write a document; --expect-rev is compare-and-set (none = must not exist; exit 5 on conflict)
  state export OWNER [--prefix P] [--out FILE]              dump documents as {owner,docs:[{key,rev,value}]} (stdout, or FILE)
  state import OWNER FILE [--key K]                         write the documents of an export file (up to 1000, sent in batches under the daemon's body limit, not atomic; revs ignored)
  state rm OWNER KEY | OWNER --prefix P [--older-than 30d] [--expect-rev N] [--yes] [--key K]
                                                            remove one document, or all under a prefix (asks to confirm unless --yes)
  template ls [--json]                                      list available templates (operator)
  template show NAME [--json]                               show a template (operator)
  ext list [--json]                                         list this agent's extensions
  ext call NAME [--input JSON] [--key K] [--json]           call an extension (agent)
  ext search --query Q [--key K] [--json]                   web_search an extension call (agent)
  ext fetch URL [--key K] [--json]                          web_fetch an extension call (agent)
  capture request URL --purpose TEXT [--render auto|static|browser] [--max-age MS] [--wait MS] [--key K] [--json]
                                                            ask the capture broker for a public web page (agent): it prints the capture id, where it
                                                            was served from, the final URL, status, content type and artifacts. --purpose says why
                                                            (journaled, never sent upstream); --max-age only tightens freshness; --wait caps the
                                                            daemon's hold. Exit 0 captured; 7 still running (pomtree capture wait JOB, or retry with the
                                                            same --key); 15 failed, retry later (site error, timeout, rate limit, quota); 16 source
                                                            unavailable (blocked, robots, denied, not found, too large, unsupported type: do not retry,
                                                            choose another source); 17 awaits approval (retry with the same --key later or yield);
                                                            18 broker unavailable (tell the operator); 2 bad URL or flags; 4 not allowed
  capture wait JOB [--wait MS] [--json]                     wait on a capture job (from a still-running request); exit codes as capture request
  capture show CAPTURE [--json]                             show a stored capture's metadata and artifacts
  capture ls [--limit N] [--json]                           list stored captures, newest first
  models                                                    list the models Pi can use (default marked *)
  doctor [--json]                                           check the daemon: "ok" or "FAIL: <reason>"

exit codes: 0 ok; 1 other error (daemon 422/429/5xx: read the message); 2 usage (bad flags, or daemon 400/405/413); 3 not found;
  4 denied (401 token, 403 scope); 5 conflict (409: already done, stale, or uncommitted work; see the hint); 6 daemon unreachable;
  7 wait timed out; pomtree merge adds 8-12 (see merge above); pomtree capture adds 15-18 (see capture request above);
  13 is abandon (abandoned, but its sandbox was left on an unreachable backend and may still bill; the text says where)
global: --no-color (or NO_COLOR) disables colour; --help shows this text`;

// Agent-facing help omits the operator-only spawn flags (the daemon refuses them with 403).
export function agentUsage(u: string): string {
  return u
    .replace(" [--from-commit C] [--session S]", "")
    .replace("\n                         [--agent ID | --budget $USD|MICROS --deadline MS --template NAME --model PROVIDER/ID]", "");
}

const VALUE_FLAGS = new Set([
  "task",
  "name",
  "budget",
  "grant",
  "why",
  "key",
  "options",
  "status",
  "state",
  "parent",
  "grace",
  "from",
  "from-commit",
  "session",
  "timeout",
  "wait",
  "interval",
  "media-type",
  "out",
  "tz",
  "missed",
  "overlap",
  "jitter",
  "until",
  "template",
  "model",
  "input",
  "query",
  "deadline",
  "wrapup",
  "disposition",
  "ttl",
  "limit",
  "agent",
  "summary",
  "summary-file",
  "save-uncommitted",
  "branch",
  "into",
  "owner",
  "prefix",
  "after",
  "older-than",
  "expect-rev",
  "file",
  "render",
  "max-age",
  "purpose",
  "reason",
  "views",
  "of",
  "dir",
]);

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const pos: string[] = [];
  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (onlyPositional) pos.push(a);
    else if (a === "--") onlyPositional = true;
    else if (a === "-f") flags.set("follow", true);
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      if (VALUE_FLAGS.has(k)) {
        const v = argv[++i];
        if (v === undefined) throw new Usage(`--${k} needs a value`);
        flags.set(k, v);
      } else flags.set(k, true);
    } else pos.push(a);
  }
  const flag = (k: string) => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return { pos, flag, has: (k: string) => flags.has(k) };
}

// `--help`/`-h`/`--version`/`-V` are answered without config, but only when they appear among the
// leading flags (before the command word). After the command they belong to the command, so
// `pomtree send ID --help` is a send, not a help request. Mirrors parseArgs' `--` terminator.
export function metaAction(argv: string[]): "usage" | "version" | null {
  let commandSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      commandSeen = true;
      continue;
    }
    if (!commandSeen) {
      if (a === "--help" || a === "-h") return "usage";
      if (a === "--version" || a === "-V") return "version";
      if (a.startsWith("--") && VALUE_FLAGS.has(a.slice(2)))
        i++; // skip the flag's value
      else if (!a.startsWith("-")) commandSeen = true; // the command word; later flags belong to it
    }
  }
  return argv.length === 0 ? "usage" : null;
}

// Rejects "", whitespace, NaN, Infinity and negatives (Number("") is 0, which would pass silently).
// `unit` is appended as " of <unit>"; an empty string omits it (for counts and sequence numbers).
function nonNegative(name: string, raw: string | undefined, integer = false, unit = "ms"): number | undefined {
  if (raw === undefined) return undefined;
  const n = raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new Usage(`--${name} must be a non-negative ${integer ? "integer" : "number"}${unit ? ` of ${unit}` : ""}, got "${raw}"`);
  }
  return n;
}

// Spawn and extend deadlines share one small, unambiguous duration grammar. A bare integer remains
// milliseconds, consistent with the rest of the CLI. A zero (`0`, `0s`, ...) is explicit unlimited for
// spawn (`allowZero`; the daemon accepts it for operator scope only) and a usage error for extend,
// which cannot extend to unlimited or by nothing.
// `name` is the flag being parsed (deadline or wrapup), so the error names the flag the user actually passed.
function deadlineDuration(raw: string | undefined, allowZero: boolean, name = "deadline"): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw);
  if (!match) throw new Usage(`--${name} must be a duration such as 4h or 90m${allowZero && name === "deadline" ? " (0 = unlimited)" : ""}, got "${raw}"`);
  const factor = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const ms = Number(match[1]) * factor;
  if (!Number.isSafeInteger(ms)) throw new Usage(`--${name} is out of range, got "${raw}"`);
  if (ms === 0 && !allowZero) {
    throw new Usage("--deadline 0 is not supported for extend (cannot extend to unlimited); omit --deadline to extend by the daemon's default session length");
  }
  return ms;
}

// The body `pomtree spawn` sends for --disposition/--ttl, or undefined when neither flag is given. These checks are
// the client-side mirror of core's `dispositionError` (the authority the daemon applies); disposition.test.ts proves
// they refuse exactly the same inputs.
export function spawnDisposition(modeFlag: string | undefined, ttlFlag: string | undefined): { mode: "hold" | "reap-on-exit"; ttlMs?: number } | undefined {
  const ttlMs = deadlineDuration(ttlFlag, true, "ttl");
  if (ttlMs === 0)
    throw new Usage(
      "--ttl 0 is not a valid TTL; pass a positive duration such as 30m or 2h, or omit --ttl to hold the exited child until its parent collects it",
    );
  const mode = modeFlag;
  if (mode !== undefined && mode !== "hold" && mode !== "reap-on-exit") throw new Usage(`--disposition must be "hold" or "reap-on-exit", got "${mode}"`);
  if (ttlMs !== undefined && mode === "reap-on-exit") throw new Usage("--ttl applies only to --disposition hold; drop --ttl or use hold");
  if (mode === undefined && ttlMs === undefined) return undefined;
  return { mode: mode ?? "hold", ...(ttlMs !== undefined && { ttlMs }) };
}

// Who is calling, read from the environment main.ts builds the transport from: inside an agent container pomtreed injects
// POMTREE_AGENT_GENERATION and the agent's POMTREE_TOKEN; an explicit POMTREE_TOKEN elsewhere is a token the caller chose;
// otherwise the operator token file POMTREED_STATE_DIR/operator.token was used. The token itself is never echoed.
function callerKind(env: Record<string, string | undefined> | undefined): "agent" | "env" | "operator" {
  return env?.POMTREE_AGENT_GENERATION !== undefined ? "agent" : env?.POMTREE_TOKEN ? "env" : "operator";
}

// The stderr hint for a refused call, chosen by cause class. Exit codes come from the status alone (codeFor);
// `body.code` is the daemon's optional machine cause (uncommitted_work, stale_generation, token_revoked,
// idempotency_conflict) and only refines the advice, so an older daemon without it still gets a useful hint.
// The caller kind decides the 401 advice; advice about one kind is wrong for the others.
// `command` is the pomtree subcommand when the hint depends on it: for `result` a repeated key with another value means a result is already recorded.
export function failureHint(status: number, body: unknown, env: Record<string, string | undefined> | undefined, command?: string): string | undefined {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof b.code === "string" ? b.code : undefined;
  const caller = callerKind(env);
  if (status === 401) {
    if (caller === "agent")
      return code === "token_revoked"
        ? "this agent's token was revoked (the agent exited, was cancelled, killed or reaped); retrying will not help: stop"
        : "this agent's POMTREE_TOKEN was not accepted: it is revoked once the agent exits or is reaped, and a container of a superseded generation keeps a stale one; retrying will not help: stop";
    if (caller === "env")
      return `the POMTREE_TOKEN in your environment was not accepted${code === "token_revoked" ? " (revoked)" : ""}: unset it to use POMTREED_STATE_DIR/operator.token, or set a current token`;
    return `token ${code === "token_revoked" ? "revoked" : "missing/invalid"}: check POMTREED_STATE_DIR and operator.token`;
  }
  if (status === 409) {
    if (code === "uncommitted_work" || (code === undefined && typeof b.fingerprint === "string"))
      return "the workspace has uncommitted changes: commit them and run pomtree push, then pomtree result again; or retry with the --save-uncommitted token named above";
    if (code === "stale_generation") return "this container belongs to a superseded generation of the agent; a newer run owns it: stop";
    if (code === "idempotency_conflict" && command === "result")
      return "a result was already recorded for this run with a different value: the result cannot be changed, so stop: retrying with another key will not replace it";
    if (code === "idempotency_conflict") return "this --key was already used for a different request: pass a new --key (or omit it)";
  }
  return undefined;
}

function codeFor(status: number): number {
  if (status === 400 || status === 405 || status === 413) return EXIT.usage;
  if (status === 401 || status === 403) return EXIT.denied;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  return EXIT.error;
}

const clip = (v: unknown, n = 80) => {
  const s = String(v ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// Journal payload text is agent- or model-supplied: control sequences are stripped before clipping (so a clip never
// splits an escape and the length counts printable text), and the whole line once more as a backstop.
const payloadText = (v: unknown, n?: number) => clip(stripControl(String(v ?? "")), n);
export function describe(e: JournalEntry): string {
  const p = e.payload;
  switch (p.kind) {
    case "message":
      return stripControl(`message(${p.role}) ${payloadText(p.text)}`);
    case "tool_call":
      return stripControl(`tool_call ${p.tool} ${payloadText(JSON.stringify(p.input), 60)}`);
    case "tool_result":
      return stripControl(`tool_result ${p.ok ? "ok" : "error"} ${payloadText(p.output, 60)}`);
    case "usage":
      return `usage in=${p.inputTokens} out=${p.outputTokens} cost=${p.costMicros === null ? "unknown" : p.costMicros}`;
    case "error":
      return stripControl(`error ${p.message}`);
    case "exited":
      return `exited ${p.exit}${p.cause ? ` (${stripControl(p.cause)})` : ""}`;
    case "signal":
      return stripControl(`signal ${p.signal.kind}`);
    default:
      return stripControl(String(p.kind));
  }
}

// describe() already strips payload text; seq and ts are numbers, so the line carries no agent-supplied controls.
const eventLine = (e: JournalEntry) => `${String(e.seq).padStart(5)}  ${new Date(e.ts).toISOString()}  ${describe(e)}`;

function table(rows: string[][]): string {
  const cells = rows.map((r) => r.map((c) => String(c ?? "")));
  const cols = Math.max(0, ...cells.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  return cells
    .map((r) =>
      r
        .map((c, i) => c.padEnd(w[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const age = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

// A session deadline as the operator sees it: absolute ISO plus remaining time; null = no deadline.
const renderDeadline = (at: number | null, now: number): string => {
  if (at === null) return "none (unlimited)";
  const s = Math.max(0, Math.floor((at - now) / 1000));
  const remain = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  return `${new Date(at).toISOString()} (in ${remain})`;
};

// Returns a process exit code; all I/O goes through `io`.
export async function run(argv: string[], io: Io): Promise<number> {
  let json = false;
  let cmdWord: string | undefined;
  try {
    // Help/version/bare invocations are answered without touching the daemon or config (leading flags only; see metaAction).
    const meta = metaAction(argv);
    if (meta === "usage") {
      io.out(process.env.POMTREE_AGENT_GENERATION !== undefined ? agentUsage(USAGE) : USAGE);
      return EXIT.ok;
    }
    if (meta === "version") {
      io.out(io.version);
      return EXIT.ok;
    }
    const { pos, flag, has } = parseArgs(argv);
    json = has("json");
    const [cmd, ...rest] = pos;
    cmdWord = cmd;
    const color = colorEnabled({ isTTY: io.isTTY, noColorFlag: has("no-color"), env: io.env });
    // Best-effort totals footer: never fails the command it decorates.
    const footer = async (): Promise<string> => {
      try {
        const s = await api("GET", "/v1/summary");
        return isSummary(s) ? `\n${renderSummaryLine(s)}` : "";
      } catch {
        return "";
      }
    };
    // `block` marks calls the daemon holds open on purpose; they get no client-side timeout.
    const failure = (status: number, body: unknown, command?: string) => {
      const msg = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      return new Failure(
        codeFor(status),
        typeof msg === "string" &&
          status === 403 &&
          // An Io without env cannot tell the caller (callerKind(undefined) reads as operator), so it keeps the hint; only a known operator skips it.
          !(io.env !== undefined && callerKind(io.env) === "operator") &&
          (msg === "operator scope required" || msg === "forbidden" || /operator/.test(msg)) &&
          !/agents can use/.test(msg)
          ? `${msg} ${AGENT_HINT}`
          : typeof msg === "string" && msg
            ? msg
            : `HTTP ${status}`,
        failureHint(status, body, io.env, command),
      );
    };
    const api = async (method: string, path: string, body?: unknown, block = false, command?: string) => {
      const r = await io.call({ method, path, body, ...(block && { timeoutMs: 0 }) });
      if (r.status >= 400) throw failure(r.status, r.body, command);
      return r.body;
    };
    const rawGet = async (path: string): Promise<Buffer> => {
      const r = await io.call({ method: "GET", path, raw: true });
      if (r.status >= 400) {
        let parsed: unknown;
        try {
          parsed = JSON.parse((r.body as Buffer).toString("utf8"));
        } catch {
          /* not JSON */
        }
        throw failure(r.status, parsed);
      }
      return r.body as Buffer;
    };
    const print = (data: unknown, human: string) => io.out(json ? JSON.stringify(data) : human);
    const id = () => {
      if (!rest[0]) throw new Usage(`${cmd} needs an agent id`);
      return encodeURIComponent(rest[0]);
    };
    // Every mutating call carries an idempotency key: `--key` if given (so a lost reply can be retried
    // without duplicating), else fresh per invocation (two intentional identical calls must not dedupe).
    // Exception: `sched rm` / `report rm` send none (delete is naturally idempotent; TODO(rule6)).
    const idemKey = () => flag("key") ?? randomUUID();
    // Park a long wait: yield instead of blocking (one key per invocation, so a retry returns the same
    // checkpoint). Returns true when the agent is parked: its container is about to stop and it resumes with the outcome.
    // The yield threshold comes from the container config document pomtreed injects (PTREE_CONFIG_JSON). `pomtree` also runs on operator
    // machines with no document, where the generated defaults apply; a present but invalid or mismatched document fails closed (exit 2).
    // The generated copy, not an import of core, keeps the trusted parse in one dependency-free file beside pomtree (no reliance on pomtree's dependency list).
    const waitYieldMs = (): number => {
      try {
        return readContainerConfig(process.env, { required: false })["wait.yieldMs"];
      } catch (e) {
        if (e instanceof ContainerConfigError) throw new Failure(EXIT.usage, e.message);
        throw e;
      }
    };
    const park = async (on: unknown, timeoutMs: number): Promise<boolean> => {
      if (parseGeneration(process.env.POMTREE_AGENT_GENERATION) === null) return false;
      if (timeoutMs <= waitYieldMs()) return false; // short waits skip the round trip (the daemon re-checks)
      const r: { parked: boolean } = await api("POST", "/v1/agents/self/park", { on, timeoutMs, idempotencyKey: parkKey });
      return r.parked;
    };
    const parkKey = randomUUID();

    switch (cmd) {
      case "spawn": {
        const task = flag("task");
        if (!task) throw new Usage("spawn needs --task");
        const budget = parseBudgetFlag(flag("budget"));
        if (budget === null)
          throw new Usage(`--budget must be a positive dollar amount like $5 or $0.50, or raw micro-dollars (µ$; 1000000 = $1), got "${flag("budget")}"`);
        if (budget !== undefined && budget < SMALL_BUDGET_MICROS) io.err(smallBudgetWarning(budget));
        const deadlineMs = deadlineDuration(flag("deadline"), true);
        const wrapupMs = deadlineDuration(flag("wrapup"), true, "wrapup");
        if (wrapupMs === 0) throw new Usage("--wrapup must be positive");
        const disposition = spawnDisposition(flag("disposition"), flag("ttl"));
        const modelFlag = flag("model");
        const slash = modelFlag === undefined ? -1 : modelFlag.indexOf("/");
        if (modelFlag !== undefined && (slash < 1 || slash === modelFlag.length - 1)) throw new Usage("--model must be PROVIDER/ID (see `pomtree models`)");
        const a: AgentRecord = await api("POST", "/v1/agents", {
          name: flag("name"),
          task,
          budgetMicros: budget,
          ...(deadlineMs !== undefined && { deadlineMs }),
          ...(wrapupMs !== undefined && { wrapupMs }),
          ...(flag("template") !== undefined && { template: flag("template") }),
          ...(disposition !== undefined && { disposition }),
          ...(modelFlag !== undefined && { model: { provider: modelFlag.slice(0, slash), id: modelFlag.slice(slash + 1) } }),
          // pomtreed's spawn route honors fork/fromCommit/sessionRef: it cuts a branch from `fromCommit`
          // and inherits `sessionRef` (Pi parentSession).
          ...(has("fork") && { fork: true }),
          ...(flag("from-commit") !== undefined && { fromCommit: flag("from-commit") }),
          ...(flag("session") !== undefined && { sessionRef: flag("session") }),
          idempotencyKey: idemKey(),
        });
        print(a, a.id);
        return EXIT.ok;
      }
      case "workflow": {
        if (rest[0] !== "launch") throw new Usage("usage: pomtree workflow launch OWNER/NAME --input JSON [--key K]");
        const workflow = rest[1];
        if (workflow === undefined || !/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(workflow))
          throw new Usage(`workflow launch needs a qualified name like owner/name, got "${workflow ?? ""}"`);
        const inputFlag = flag("input");
        let input: unknown = {};
        if (inputFlag !== undefined) {
          try {
            input = JSON.parse(inputFlag);
          } catch {
            throw new Usage("--input must be valid JSON");
          }
        }
        const budget = parseBudgetFlag(flag("budget"));
        if (budget === null)
          throw new Usage(`--budget must be a positive dollar amount like $5 or $0.50, or raw micro-dollars (µ$; 1000000 = $1), got "${flag("budget")}"`);
        const deadlineMs = deadlineDuration(flag("deadline"), true);
        const r: { kind: string; agent: string } = await api("POST", "/v1/workflows/launch", {
          workflow,
          input,
          idempotencyKey: idemKey(),
          ...(budget !== undefined && { budgetMicros: budget }),
          ...(deadlineMs !== undefined && { deadlineMs }),
        });
        print(r, r.agent);
        return EXIT.ok;
      }
      case "result": {
        const status = flag("status") ?? "succeeded";
        if (status !== "succeeded" && status !== "failed") throw new Usage("--status must be succeeded or failed");
        let result: unknown = null;
        if (rest[0] !== undefined) {
          try {
            result = JSON.parse(rest[0]);
          } catch {
            throw new Usage("result must be valid JSON");
          }
        }
        if (flag("summary") !== undefined && flag("summary-file") !== undefined) throw new Usage("pass --summary or --summary-file, not both");
        let summary = flag("summary");
        if (flag("summary-file") !== undefined) {
          try {
            summary = readFileSync(flag("summary-file")!, "utf8");
          } catch (e) {
            throw new Usage(`cannot read ${flag("summary-file")}: ${(e as Error).message}`);
          }
        }
        if (summary !== undefined) {
          const base = result !== null && typeof result === "object" && !Array.isArray(result) ? result : result === null ? {} : { value: result };
          result = { ...base, summary };
        }
        const body = {
          status,
          result,
          ...(flag("save-uncommitted") !== undefined && { saveUncommitted: flag("save-uncommitted") }),
          idempotencyKey: idemKey(),
        }; // one key across retries
        const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        let a: AgentRecord;
        for (let attempt = 0; ; attempt++) {
          try {
            a = await api("POST", "/v1/agents/self/result", body, flag("save-uncommitted") !== undefined, "result");
            break;
          } catch (e) {
            if (!(e instanceof TransportError) || attempt >= RESULT_RETRY_DELAYS_MS.length) throw e;
            await sleep(RESULT_RETRY_DELAYS_MS[attempt]!);
          }
        }
        print(a, `recorded ${status}; wrapping up`);
        return EXIT.ok;
      }
      case "wait": {
        const t = nonNegative("timeout", flag("timeout")) ?? 30000;
        if (await park({ kind: "child", child: rest[0] }, t)) {
          print({ parked: true }, "yielded: you will be resumed when the wait ends");
          return EXIT.ok;
        }
        const w: { done: boolean; record: AgentRecord } = await api("GET", `/v1/agents/${id()}/wait?timeoutMs=${t}`, undefined, true);
        print(
          w,
          w.done ? `${w.record.id} ${w.record.state} ${w.record.exit ?? ""}`.trimEnd() + handoffBlock(w.record) : `${w.record.id} still ${w.record.state}`,
        );
        return w.done ? EXIT.ok : EXIT.timeout;
      }
      case "reap": {
        const r: { record: AgentRecord; unusedMicros: number; merge?: { status: string; detail: string } } = await api("POST", `/v1/agents/${id()}/reap`, {
          idempotencyKey: idemKey(),
        });
        print(r, `reaped ${r.record.id} (${formatMoney(r.unusedMicros)} returned)${handoffBlock(r.record, r.merge)}`);
        return EXIT.ok;
      }
      case "inbox": {
        const w = nonNegative("wait", flag("wait"));
        if (w !== undefined && !has("peek") && (await park({ kind: "inbox" }, w))) {
          print({ parked: true }, "yielded: you will be resumed when a message arrives or the wait ends");
          return EXIT.ok;
        }
        const q = new URLSearchParams();
        if (w !== undefined) q.set("waitMs", String(w));
        const sigs: { kind: string; [k: string]: unknown }[] = await api("GET", `/v1/agents/self/inbox${q.size ? `?${q}` : ""}`, undefined, w !== undefined);
        print(sigs, sigs.length ? sigs.map((x) => signalLine(x)).join("\n") : "no signals");
        // The daemon always peeks; reading is consuming for this reader, so ack exactly the ids printed (after printing: a lost ack redelivers).
        const ids = has("peek") ? [] : sigs.flatMap((x) => (typeof x.id === "string" ? [x.id] : []));
        if (ids.length) await api("POST", "/v1/agents/self/inbox/ack", { ids, idempotencyKey: idemKey() });
        return EXIT.ok;
      }
      case "decide": {
        const decision = rest[1];
        if (!rest[0]) throw new Usage("decide needs an approval id");
        if (decision !== "approve" && decision !== "deny" && decision !== "pass") throw new Usage("decide needs approve, deny or pass after the id");
        const grant = parseBudgetFlag(flag("grant"));
        if (grant === null)
          throw new Usage(`--grant must be a positive dollar amount like $5 or $0.50, or raw micro-dollars (µ$; 1000000 = $1), got "${flag("grant")}"`);
        if (grant !== undefined && decision !== "approve") throw new Usage("--grant only applies to approve");
        const d = await api("POST", `/v1/approvals/${encodeURIComponent(rest[0])}/decide`, {
          decision,
          ...(grant !== undefined && { grantMicros: grant }),
          ...(flag("why") !== undefined && { why: flag("why") }),
          idempotencyKey: idemKey(),
        });
        print(d, `${decision === "pass" ? "passed" : `${decision}d`} ${rest[0]}`);
        return EXIT.ok;
      }
      case "answer": {
        if (!rest[0]) throw new Usage("answer needs an escalation id");
        if (rest[1] === undefined) throw new Usage("answer needs answer text");
        const a = await api("POST", `/v1/escalations/${encodeURIComponent(rest[0])}/answer`, { body: rest.slice(1).join(" "), idempotencyKey: idemKey() });
        print(a, `answered ${rest[0]}`);
        return EXIT.ok;
      }
      case "pass": {
        if (!rest[0]) throw new Usage("pass needs an escalation id");
        const a = await api("POST", `/v1/escalations/${encodeURIComponent(rest[0])}/pass`, { idempotencyKey: idemKey() });
        print(a, `passed ${rest[0]}`);
        return EXIT.ok;
      }
      case "peers": {
        // The daemon returns only {id, name, state} (no parent/host), so that is all we render.
        const list: Pick<AgentRecord, "id" | "name" | "state">[] = await api("GET", "/v1/peers");
        print(list, list.length ? table([["ID", "NAME", "STATE"], ...list.map((a) => [a.id, a.name, a.state])]) : "no peers");
        return EXIT.ok;
      }
      case "send": {
        if (!rest[0]) throw new Usage("send needs a peer id");
        if (rest[1] === undefined) throw new Usage("send needs a message body");
        const body = rest.slice(1).join(" ");
        // An agent (POMTREE_AGENT_GENERATION set) messages a peer's mailbox; the operator posts to /message and may --interrupt.
        const asAgent = process.env.POMTREE_AGENT_GENERATION !== undefined;
        if (!asAgent) {
          const out = await api("POST", `/v1/agents/${encodeURIComponent(rest[0])}/message`, {
            body,
            mode: has("interrupt") ? "interrupt" : "queue",
            idempotencyKey: effectiveSendKey(flag("key")),
          });
          print(out, `sent to ${rest[0]} (${(out as { delivered?: string } | null)?.delivered ?? "queued"})`);
          return EXIT.ok;
        }
        const generation = parseGeneration(process.env.POMTREE_AGENT_GENERATION);
        if (generation === null) throw new Usage("POMTREE_AGENT_GENERATION must be a non-negative integer");
        const signal = await api("POST", `/v1/peers/${encodeURIComponent(rest[0])}/send`, {
          body,
          generation,
          idempotencyKey: effectiveSendKey(flag("key")),
          ...(has("interrupt") && { interrupt: true }),
        });
        print(signal, `sent to ${rest[0]}`);
        return EXIT.ok;
      }
      case "ps": {
        const q = new URLSearchParams();
        for (const k of ["state", "parent"]) if (flag(k)) q.set(k, flag(k)!);
        const list: (AgentRecord & { pendingReason?: string; waitingSince?: number })[] = await api("GET", `/v1/agents${q.size ? `?${q}` : ""}`);
        const why = list.some((a) => a.pendingReason || a.waitingSince !== undefined); // a trailing WHY column only when something is queued or waiting
        const whyOf = (a: (typeof list)[number]) =>
          a.pendingReason ? `queued \u2014 ${stripControl(a.pendingReason)}` : a.waitingSince !== undefined ? `waiting ${age(a.waitingSince)}` : "";
        print(
          list,
          list.length
            ? table([
                ["ID", "NAME", "STATE", "EXIT", "AGE", "HOST", ...(why ? ["WHY"] : [])],
                ...list.map((a) => [a.id, a.name, a.state, a.exit ?? "-", age(a.createdAt), a.host, ...(why ? [whyOf(a)] : [])]),
              ])
            : "no agents",
        );
        if (!json) {
          const f = await footer();
          if (f) io.out(f.slice(1));
        }
        return EXIT.ok;
      }
      case "tree": {
        const rows: DisplayRow[] = await api("GET", "/v1/tree");
        print(rows, renderRows(rows, { color }));
        if (!json) {
          const f = await footer();
          if (f) io.out(f.slice(1));
        }
        return EXIT.ok;
      }
      case "spend": {
        const s = await api("GET", "/v1/summary");
        if (!isSummary(s)) throw new Failure(EXIT.error, "daemon returned an unexpected summary");
        print(s, renderSummary(s));
        return EXIT.ok;
      }
      case "escalations": {
        const sub = rest[0];
        if (sub === "ls") {
          const q = new URLSearchParams();
          if (flag("state")) q.set("state", flag("state")!);
          if (flag("agent")) q.set("agent", flag("agent")!);
          const list: Escalation[] = await api("GET", `/v1/escalations${q.size ? `?${q}` : ""}`);
          print(
            list,
            list.length
              ? table([
                  ["ID", "AGENT", "STATE", "AGE", "QUESTION"],
                  ...list.map((e) => [e.id, e.agent, e.state, age(e.createdAt), stripControl(clip(e.question, 60))]),
                ])
              : "no escalations",
          );
          return EXIT.ok;
        }
        if (sub === "answer") {
          const eid = rest[1];
          if (!eid) throw new Usage("escalations answer needs an escalation id");
          if (rest[2] === undefined) throw new Usage("escalations answer needs answer text");
          const e: Escalation = await api("POST", `/v1/escalations/${encodeURIComponent(eid)}/answer`, {
            body: rest.slice(2).join(" "),
            idempotencyKey: idemKey(),
          });
          print(e, `answered ${e.id}`);
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown escalations command: ${sub}` : "escalations needs a subcommand (ls|answer)");
      }
      case "ui": {
        const built = buildUiCommand(rest, {
          views: flag("views"),
          of: flag("of"),
          dir: flag("dir"),
          others: has("others"),
          left: has("left"),
          right: has("right"),
          all: has("all"),
          focused: has("focused"),
        });
        if (!built.ok) throw new Usage(built.error);
        const reply = (await api("POST", "/v1/ui/command", { idempotencyKey: idemKey(), command: built.command }, false, "ui")) as {
          seq: number;
          tabs: number;
        };
        const o = formatUiResult(reply, EXIT);
        if (o.code === EXIT.ok) {
          io.out(o.out);
          return EXIT.ok;
        }
        throw new Failure(o.code, o.err);
      }
      case "top": {
        const interval = nonNegative("interval", flag("interval"), true) ?? 1000;
        const once = has("once") || !(io.isTTY ?? false);
        if (!once && interval === 0) throw new Usage("--interval must be at least 1 ms");
        if (once) {
          const rows: DisplayRow[] = await api("GET", "/v1/tree");
          print(rows, renderRows(rows, { color }));
          if (!json) {
            const f = await footer();
            if (f) io.out(f.slice(1));
          }
          return EXIT.ok;
        }
        for await (const rows of pollTree(api, { intervalMs: interval })) {
          io.out(CLEAR + renderRows(rows, { color }) + (await footer()));
        }
        return EXIT.ok; // pollTree never finishes; stop via Ctrl+C
      }
      case "show": {
        const a: AgentRecord & { pendingReason?: string; waitingSince?: number } = await api("GET", `/v1/agents/${id()}`);
        const events: JournalEntry[] = await api("GET", `/v1/agents/${id()}/events?tail=10`);
        let cp: Checkpoint | null = null;
        try {
          cp = await api("GET", `/v1/agents/${id()}/checkpoint`);
        } catch (e) {
          if (!(e instanceof Failure) || e.code !== EXIT.notFound) throw e;
        }
        let dl: { deadlineAt: number | null } | null = null;
        try {
          dl = await api("GET", `/v1/agents/${id()}/deadline`);
        } catch (e) {
          // 404 (the agent vanished since the fetch above, or a daemon without the deadline route): omit the line.
          if (!(e instanceof Failure) || e.code !== EXIT.notFound) throw e;
        }
        print(
          { agent: a, events, checkpoint: cp, deadline: dl },
          [
            `id:         ${a.id}`,
            `name:       ${a.name}`,
            `parent:     ${a.parent ?? "-"}`,
            `state:      ${a.state}${a.exit ? ` (${a.exit})` : ""}${a.exitCause ? ` (${stripControl(a.exitCause)})` : ""}`,
            `host:       ${a.host} gen ${a.generation}`,
            ...(a.pendingReason ? [`pending:    queued \u2014 ${stripControl(a.pendingReason)}`] : []),
            ...(a.waitingSince !== undefined ? [`waiting:    ${age(a.waitingSince)} (settled turn, no result; container up)`] : []),
            `budget:     ${formatMoney(a.budgetMicros)}`,
            ...(dl ? [`deadline:   ${renderDeadline(dl.deadlineAt, (io.now ?? Date.now)())}`] : []),
            `task:       ${a.task}`,
            ...(a.result != null ? [`result:     ${JSON.stringify(a.result)}`] : []),
            ...(cp
              ? [
                  `checkpoint: ${cp.id}`,
                  `  wait:       ${cp.wait ? JSON.stringify(cp.wait) : "-"}`,
                  `  ingested:   ${cp.ingested ? `${stripControl(cp.ingested.ref)} ${cp.ingested.commit}` : "-"}`,
                  `  sessionRef: ${cp.sessionRef}`,
                  `  remaining:  ${formatMoney(cp.remainingBudgetMicros)}`,
                  `  image:      ${cp.imageDigest}`,
                ]
              : []),
            "recent events:",
            ...events.map((e) => `  ${eventLine(e)}`),
          ].join("\n"),
        );
        return EXIT.ok;
      }
      case "logs": {
        if (has("transcript")) {
          const lim = nonNegative("limit", flag("limit"), true, "");
          const t: { entries: unknown[]; skipped: number; total: number; commit: string } = await api(
            "GET",
            `/v1/agents/${id()}/transcript${lim !== undefined ? `?limit=${lim}` : ""}`,
          );
          if (json) io.out(JSON.stringify(t));
          else {
            if (t.skipped) io.out(`(${t.skipped} unreadable entries skipped; ${t.total} total)`);
            for (const e of t.entries) io.out(has("raw") ? stripControl(JSON.stringify(e)) : transcriptLine(e));
          }
          return EXIT.ok;
        }
        let from = nonNegative("from", flag("from"), true, "") ?? 1;
        for (;;) {
          // Check state first: a terminal agent gets one non-blocking read, then we return.
          const terminal = has("follow") && ["exited", "reaped"].includes(((await api("GET", `/v1/agents/${id()}`)) as AgentRecord).state);
          const evs: JournalEntry[] = await api(
            "GET",
            `/v1/agents/${id()}/events?from=${from}${has("follow") && !terminal ? "&waitMs=25000" : ""}`,
            undefined,
            has("follow"),
          );
          for (const e of evs) io.out(json ? JSON.stringify(e) : eventLine(e));
          if (evs.length) from = evs.at(-1)!.seq + 1;
          if (!has("follow")) return EXIT.ok;
          if (terminal && !evs.length) return EXIT.ok;
        }
      }
      case "trace": {
        const q = `?format=${json ? "json" : "md"}${has("short") ? "&short=1" : ""}${has("children") ? "&include=children" : ""}${has("raw") ? "&raw=1" : ""}`;
        const path = `/v1/agents/${id()}/trace${q}`;
        let text: string;
        if (json) {
          const r: { markdown: string } = await api("GET", path);
          text = JSON.stringify(r);
        } else text = (await rawGet(path)).toString("utf8");
        const outPath = flag("out");
        if (outPath) {
          try {
            writeFileSync(outPath, text);
          } catch (e) {
            throw new Failure(EXIT.error, `cannot write ${outPath}: ${(e as Error).message}`);
          }
          io.out(`wrote ${Buffer.byteLength(text)} bytes to ${outPath}`);
          return EXIT.ok;
        }
        io.out(json ? text : stripControl(text.replace(/\n$/, "")));
        return EXIT.ok;
      }
      case "cancel": {
        const g = nonNegative("grace", flag("grace"));
        await api("POST", `/v1/agents/${id()}/cancel`, { ...(g !== undefined && { graceMs: g }), idempotencyKey: idemKey() });
        print({ accepted: true }, "cancel requested");
        return EXIT.ok;
      }
      case "ask": {
        const question = rest[0];
        if (question === undefined) throw new Usage("ask needs a question");
        const options = parseOptions(flag("options"));
        const generation = parseGeneration(process.env.POMTREE_AGENT_GENERATION);
        if (generation === null) throw new Usage("POMTREE_AGENT_GENERATION must be a non-negative integer");
        const waitMs = nonNegative("wait", flag("wait"), true) ?? 0;
        const key = effectiveAskKey(flag("key"));
        const res: { escalation: Escalation; delivered: boolean } = await api("POST", "/v1/agents/self/ask", {
          question,
          ...(options.length ? { options } : {}),
          generation,
          idempotencyKey: key,
        });
        if (!res.delivered) io.err(`escalation ${res.escalation.id} was not delivered to a human channel`);
        if (waitMs === 0) {
          print(res.escalation, res.escalation.id);
          return EXIT.ok;
        }
        if (res.escalation.state !== "answered" && (await park({ kind: "ask", escalation: res.escalation.id }, waitMs))) {
          print({ parked: true }, "yielded: you will be resumed when the question is answered or the wait ends");
          return EXIT.ok;
        }
        const chunk = Math.min(waitMs, 30_000);
        const deadline = Date.now() + waitMs;
        let esc = res.escalation;
        while (esc.state !== "answered") {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const pollMs = Math.min(chunk, remaining);
          esc = await api("GET", `/v1/agents/self/ask/${encodeURIComponent(esc.id)}?waitMs=${pollMs}`, undefined, true);
        }
        if (esc.state === "answered") {
          print(esc, esc.answer ?? "");
          return EXIT.ok;
        }
        print(esc, `${esc.id} still ${esc.state}`);
        io.err("a late answer will land in your inbox");
        return EXIT.timeout;
      }
      case "budget": {
        const b: { budgetMicros: number; remainingMicros: number } = await api("GET", "/v1/agents/self/budget");
        print(b, renderBudget(b));
        return EXIT.ok;
      }
      case "yield": {
        const raw = flag("until");
        if (raw === undefined) throw new Usage("yield needs --until");
        let wait: WaitCondition;
        try {
          wait = parseYieldWait(raw);
        } catch (e) {
          throw new Usage((e as Error).message);
        }
        const cp: Checkpoint = await api("POST", "/v1/agents/self/yield", { wait, idempotencyKey: effectiveYieldKey(flag("key")) });
        print(cp, `yielded ${cp.id}`);
        return EXIT.ok;
      }
      case "await-user": {
        // Mutating, so keyed per invocation (`--key` to retry). The daemon refuses (409, exit 5) unless a human message is unanswered.
        await api("POST", "/v1/agents/self/await-user", { idempotencyKey: idemKey() });
        print({ accepted: true }, "await-user accepted: end your turn now; you wait for the user's next message");
        return EXIT.ok;
      }
      case "abandon": {
        const reply: unknown = await api("POST", `/v1/agents/${id()}/abandon`, abandonBody(flag("reason"), idemKey()));
        print(reply, renderAbandon(reply));
        return abandonLeft(reply) ? EXIT.partial : EXIT.ok;
      }
      case "kill":
        await api("POST", `/v1/agents/${id()}/kill`, { idempotencyKey: idemKey() });
        print({ accepted: true }, "kill requested");
        return EXIT.ok;
      // Session-deadline verbs (TODO(session-length)). Wire contract, served by pomtreed:
      //
      //   GET  /v1/agents/:id/deadline
      //     operator or the agent itself (same access as GET /v1/agents/:id)
      //     → 200 { deadlineAt: number | null }   // absolute epoch ms; null = no deadline (unlimited)
      //
      //   POST /v1/agents/:id/deadline
      //     operator-only (403 otherwise)
      //     body: { deadlineMs?: number, idempotencyKey: string }
      //       deadlineMs: relative extension in ms, added to the current deadline (or now when none);
      //       omitted = the daemon's default session length (POMTREED_SESSION_DEFAULT_MS).
      //     → 200 { deadlineAt: number | null, previousDeadlineAt: number | null }
      //     idempotent on idempotencyKey: replaying a key returns the original outcome without extending again.
      case "extend": {
        const deadlineMs = deadlineDuration(flag("deadline"), false);
        const r: { deadlineAt: number | null; previousDeadlineAt: number | null } = await api("POST", `/v1/agents/${id()}/deadline`, {
          ...(deadlineMs !== undefined && { deadlineMs }),
          idempotencyKey: idemKey(),
        });
        print(r, `deadline extended to ${renderDeadline(r.deadlineAt, (io.now ?? Date.now)())}`);
        return EXIT.ok;
      }
      case "resume": {
        const a: AgentRecord = await api("POST", `/v1/agents/${id()}/resume`, { ...(has("force") && { force: true }), idempotencyKey: idemKey() });
        print(a, `resumed ${a.id}`);
        return EXIT.ok;
      }
      case "drain": {
        // TODO(multi-host): pomtreed's drain route is host-local and ignores HOST; a named remote host needs routing.
        const ms = nonNegative("deadline", flag("deadline")) ?? 30_000;
        const deadline = (io.now ?? Date.now)() + ms;
        const r = await api("POST", "/v1/drain", { deadline, idempotencyKey: idemKey() });
        print(r, `draining (deadline in ${ms}ms)`);
        return EXIT.ok;
      }
      case "whoami": {
        // Reads the caller's own record (GET /v1/agents/self). pomtreed also serves GET /v1/whoami, which adds the agent endpoint the
        // usage line promises; switching to it is TODO(cli-gaps).
        const a: AgentRecord = await api("GET", "/v1/agents/self");
        print(a, `${a.id} ${a.name} ${a.state} gen ${a.generation} host ${a.host}`);
        return EXIT.ok;
      }
      case "sched": {
        const sub = rest[0];
        if (sub === "ls") {
          const list: Schedule[] = await api("GET", "/v1/schedules");
          print(list, renderScheduleTable(list));
          return EXIT.ok;
        }
        if (sub === "add") {
          const sid = rest[1];
          if (!sid) throw new Usage("sched add needs a schedule id");
          const cron = rest[2];
          if (!cron) throw new Usage("sched add needs a cron expression");
          const task = rest[3];
          if (task === undefined) throw new Usage("sched add needs a task");
          const problem = cronError(cron);
          if (problem) throw new Usage(problem);
          const missed = flag("missed") ?? "skip";
          if (missed !== "skip" && missed !== "run-one" && missed !== "catch-up") throw new Usage("--missed must be skip, run-one or catch-up");
          const overlap = flag("overlap") ?? "skip";
          if (overlap !== "skip" && overlap !== "queue") throw new Usage("--overlap must be skip or queue");
          const jitterMs = nonNegative("jitter", flag("jitter"), true) ?? 0;
          const tz = flag("tz");
          // Spawn flags mirror `pomtree spawn` (a spawning schedule only); --agent makes the schedule a wakeup of that agent.
          const budget = parseBudgetFlag(flag("budget"));
          if (budget === null)
            throw new Usage(`--budget must be a positive dollar amount like $5 or $0.50, or raw micro-dollars (µ$; 1000000 = $1), got "${flag("budget")}"`);
          const modelFlag = flag("model");
          const slash = modelFlag === undefined ? -1 : modelFlag.indexOf("/");
          if (modelFlag !== undefined && (slash < 1 || slash === modelFlag.length - 1)) throw new Usage("--model must be PROVIDER/ID (see `pomtree models`)");
          const deadlineMs = nonNegative("deadline", flag("deadline"), true);
          const target = flag("agent");
          if (target !== undefined && (budget !== undefined || deadlineMs !== undefined || flag("template") !== undefined || modelFlag !== undefined)) {
            throw new Usage("--agent wakes an existing agent; --budget, --deadline, --template and --model apply only to spawning schedules");
          }
          const s: Schedule = await api("PUT", `/v1/schedules/${encodeURIComponent(sid)}`, {
            idempotencyKey: idemKey(),
            cron,
            ...(tz !== undefined && { tz }),
            task,
            missed,
            overlap,
            jitterMs,
            ...(target !== undefined && { agent: target }),
            ...(budget !== undefined && { budgetMicros: budget }),
            ...(deadlineMs !== undefined && { deadlineMs }),
            ...(flag("template") !== undefined && { template: flag("template") }),
            ...(modelFlag !== undefined && { model: { provider: modelFlag.slice(0, slash), id: modelFlag.slice(slash + 1) } }),
          });
          print(s, `added ${sid}`);
          return EXIT.ok;
        }
        if (sub === "rm") {
          const sid = rest[1];
          if (!sid) throw new Usage("sched rm needs a schedule id");
          const r: { removed: boolean } = await api("DELETE", `/v1/schedules/${encodeURIComponent(sid)}?key=${encodeURIComponent(idemKey())}`);
          print(r, `removed ${sid}`);
          return EXIT.ok;
        }
        if (sub === "pause" || sub === "resume") {
          const sid = rest[1];
          if (!sid) throw new Usage(`sched ${sub} needs a schedule id`);
          const s: Schedule = await api("POST", `/v1/schedules/${encodeURIComponent(sid)}/${sub}`, { idempotencyKey: idemKey() });
          print(s, `${sub === "pause" ? "paused" : "resumed"} ${sid}`);
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown sched command: ${sub}` : "sched needs a subcommand (ls|add|rm|pause|resume)");
      }
      case "state": {
        const sub = rest[0];
        // Mutating and bulk calls retry transport failures with the one idempotency key issued for this invocation, so a lost reply cannot duplicate.
        const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        const stateCall = async (method: string, path: string, body?: unknown, retry = false): Promise<any> => {
          for (let attempt = 0; ; attempt++) {
            let r: Awaited<ReturnType<Transport>>;
            try {
              r = await io.call({ method, path, body });
            } catch (e) {
              if (!retry || !(e instanceof TransportError) || attempt >= STATE_RETRY_DELAYS_MS.length) throw e;
              await sleep(STATE_RETRY_DELAYS_MS[attempt]!);
              continue;
            }
            if (r.status >= 400) throw new Failure(codeFor(r.status), stateErrorMessage(r.status, r.body), failureHint(r.status, r.body, io.env));
            return r.body;
          }
        };
        const owner = (v: string | undefined, what = "an owner"): string => {
          if (!v) throw new Usage(`state ${sub} needs ${what}`);
          if (!validOwner(v)) throw new Usage(`invalid state owner "${v}" (lowercase letters, digits, "_" and "-")`);
          return v;
        };
        const key = (v: string | undefined): string => {
          if (!v) throw new Usage(`state ${sub} needs a key`);
          if (!validKey(v)) throw new Usage(`invalid state key "${v}" (lowercase segments of [a-z0-9._-] joined by "/", at most 128 chars, no "..")`);
          return v;
        };
        const prefix = (v: string | undefined): string | undefined => {
          if (v === undefined) return undefined;
          if (!validPrefix(v)) throw new Usage(`invalid state prefix "${v}"`);
          return v;
        };
        const readJsonFile = (p: string): string => {
          try {
            const resolved = realpathSync(p);
            if (!statSync(resolved).isFile()) throw new Usage(`${resolved} is not a regular file`);
            return readFileSync(resolved, "utf8");
          } catch (e) {
            if (e instanceof Usage) throw e;
            throw new Usage(`cannot read ${p}: ${(e as Error).message}`);
          }
        };
        const q = (o: Record<string, string | undefined>) =>
          Object.entries(o)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
            .join("&");
        if (sub === "ls") {
          const o = flag("owner");
          if (o !== undefined) owner(o);
          const limit = nonNegative("limit", flag("limit"), true, "");
          const after = flag("after");
          if (after !== undefined) {
            if (o === undefined) throw new Usage("--after applies only with --owner");
            key(after);
          }
          const r = await stateCall(
            "GET",
            `/v1/state?${q({ owner: o, prefix: prefix(flag("prefix")), after, limit: limit === undefined ? undefined : String(limit) })}`,
          );
          if (Array.isArray(r?.owners)) {
            print(r, r.owners.length ? r.owners.map((x: string) => stripControl(x)).join("\n") : "no readable state owners");
            return EXIT.ok;
          }
          print(r, renderStateList(r.docs, r.next, table, age));
          return EXIT.ok;
        }
        if (sub === "show") {
          const o = owner(rest[1]);
          const k = key(rest[2]);
          const r = await stateCall("GET", `/v1/state/doc?${q({ owner: o, key: k })}`);
          print(r.doc, renderStateDoc(r.doc));
          return EXIT.ok;
        }
        if (sub === "put") {
          const o = owner(rest[1]);
          const k = key(rest[2]);
          const file = flag("file");
          if ((file === undefined) === (rest[3] === undefined)) throw new Usage("state put needs exactly one of a JSON argument or --file");
          let value: unknown;
          try {
            value = JSON.parse(file !== undefined ? readJsonFile(file) : (rest[3] as string));
          } catch (e) {
            if (e instanceof Usage) throw e;
            throw new Usage(`state put value is not valid JSON: ${(e as Error).message}`);
          }
          let expectRev: number | null | undefined;
          try {
            expectRev = flag("expect-rev") === undefined ? undefined : parseExpectRev(flag("expect-rev") as string);
          } catch (e) {
            throw new Usage((e as Error).message);
          }
          const r = await stateCall(
            "PUT",
            "/v1/state/doc",
            { owner: o, key: k, value, ...(expectRev !== undefined && { expectRev }), idempotencyKey: idemKey() },
            true,
          );
          print(r.doc, `wrote ${o}/${k} rev ${r.doc.rev}`);
          return EXIT.ok;
        }
        if (sub === "export") {
          const o = owner(rest[1]);
          const r = await stateCall("GET", `/v1/state/export?${q({ owner: o, prefix: prefix(flag("prefix")) })}`);
          const text = JSON.stringify({ owner: r.owner, docs: r.docs }, null, 2);
          const outPath = flag("out");
          if (outPath === undefined) {
            io.out(text);
            return EXIT.ok;
          }
          try {
            writeFileSync(outPath, `${text}\n`);
          } catch (e) {
            throw new Failure(EXIT.error, `cannot write ${outPath}: ${(e as Error).message}`);
          }
          print({ exported: r.docs.length, out: outPath }, `exported ${r.docs.length} documents to ${outPath}`);
          return EXIT.ok;
        }
        if (sub === "import") {
          const o = owner(rest[1]);
          if (!rest[2]) throw new Usage("state import needs a file");
          let docs: ReturnType<typeof parseImportFile>;
          try {
            docs = parseImportFile(readJsonFile(rest[2]));
          } catch (e) {
            if (e instanceof Usage) throw e;
            throw new Usage((e as Error).message);
          }
          // One request per batch (the daemon caps a JSON body at 1 MiB), each under a key derived from the invocation's one key, so a retry
          // or a re-run with the same --key replays finished batches. Batches are separate calls: a refusal part way leaves earlier ones written.
          const base = idemKey();
          const batches = chunkImportDocs(docs);
          let imported = 0;
          for (const [i, batch] of batches.entries()) {
            try {
              const r = await stateCall(
                "POST",
                "/v1/state/import",
                { owner: o, docs: batch, idempotencyKey: batches.length === 1 ? base : `${base}:b${i}` },
                true,
              );
              imported += r.imported;
            } catch (e) {
              if (e instanceof Failure && imported > 0) {
                throw new Failure(
                  e.code,
                  `${e.message} (${imported} of ${docs.length} documents were already imported; re-run with --key ${base} to resume)`,
                  e.hint,
                );
              }
              throw e;
            }
          }
          print({ imported }, `imported ${imported} documents into ${o}`);
          return EXIT.ok;
        }
        if (sub === "rm") {
          const o = owner(rest[1]);
          const p = prefix(flag("prefix"));
          if ((p === undefined) === (rest[2] === undefined)) throw new Usage("state rm needs exactly one of a KEY or --prefix");
          if (rest[2] !== undefined) key(rest[2]);
          if (p === undefined && has("older-than")) throw new Usage("--older-than applies only to --prefix");
          if (p !== undefined && has("expect-rev")) throw new Usage("--expect-rev applies only to a single KEY");
          let olderThanMs: number | undefined;
          let expectRev: number | null | undefined;
          try {
            if (flag("older-than") !== undefined) olderThanMs = parseOlderThan(flag("older-than") as string);
            if (flag("expect-rev") !== undefined) expectRev = parseExpectRev(flag("expect-rev") as string);
          } catch (e) {
            throw new Usage((e as Error).message);
          }
          if (expectRev === null)
            throw new Usage('--expect-rev takes a revision number for state rm ("none" has no meaning for a removal; 0 means the key must be absent)');
          if (!has("yes")) {
            const what =
              p === undefined
                ? `${o}/${rest[2]}`
                : `every document under ${o}/${p}${olderThanMs !== undefined ? ` not updated for ${flag("older-than")}` : ""}`;
            if (!io.confirm) throw new Usage(`state rm removes ${what}; pass --yes to confirm`);
            if (!(await io.confirm(`remove ${what}?`))) {
              print({ removed: 0, keys: [] }, "aborted");
              return EXIT.ok;
            }
          }
          const r = await stateCall(
            "POST",
            "/v1/state/rm",
            {
              owner: o,
              ...(p === undefined ? { key: rest[2] } : { prefix: p }),
              ...(olderThanMs !== undefined && { olderThanMs }),
              ...(expectRev !== undefined && { expectRev }),
              idempotencyKey: idemKey(),
            },
            true,
          );
          print(r, `removed ${r.removed} document${r.removed === 1 ? "" : "s"}`);
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown state command: ${sub}` : "state needs a subcommand (ls|show|put|export|import|rm)");
      }
      case "template": {
        const sub = rest[0];
        if (sub === "ls") {
          const list: Template[] = await api("GET", "/v1/templates");
          print(
            list,
            list.length
              ? table([
                  ["ID", "IMAGE", "PROVIDER", "MODEL", "BUDGET"],
                  ...list.map((t) => [
                    t.id,
                    t.image ?? "-",
                    t.provider ?? "-",
                    t.model ?? "-",
                    t.budgetMicros === undefined ? "-" : formatMoney(t.budgetMicros),
                  ]),
                ])
              : "no templates",
          );
          return EXIT.ok;
        }
        if (sub === "show") {
          const name = rest[1];
          if (!name) throw new Usage("template show needs a name");
          const tpl: Template = await api("GET", `/v1/templates/${encodeURIComponent(name)}`);
          print(tpl, JSON.stringify(tpl, null, 2));
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown template command: ${sub}` : "template needs a subcommand (ls|show)");
      }
      case "ext": {
        const sub = rest[0];
        const invoke = (name: string, input: unknown, key?: string): Promise<ExtCallResult> =>
          api("POST", `/v1/ext/${encodeURIComponent(name)}/call`, { input, idempotencyKey: effectiveExtKey(key) });
        if (sub === "list") {
          const r: { extensions: ExtensionSpec[] } = await api("GET", "/v1/ext");
          print(r, renderExtList(r.extensions));
          return EXIT.ok;
        }
        if (sub === "call") {
          const name = rest[1];
          if (!name) throw new Usage("ext call needs an extension name");
          const raw = flag("input") ?? rest[2];
          let input: unknown = null;
          if (raw !== undefined) {
            try {
              input = parseInput(raw);
            } catch (e) {
              throw new Usage((e as Error).message);
            }
          }
          const res = await invoke(name, input, flag("key"));
          print(res, renderExtCallResult(res));
          return EXIT.ok;
        }
        if (sub === "search") {
          const query = flag("query");
          if (query === undefined) throw new Usage("ext search needs --query");
          const res = await invoke("web_search", { query }, flag("key"));
          print(res, renderExtSearchResult(res));
          return EXIT.ok;
        }
        if (sub === "fetch") {
          const url = rest[1];
          if (url === undefined) throw new Usage("ext fetch needs a URL");
          const res = await invoke("web_fetch", { url }, flag("key"));
          print(res, renderExtFetchResult(res));
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown ext command: ${sub}` : "ext needs a subcommand (list|call|search|fetch)");
      }
      case "models": {
        const r = await api("GET", "/v1/models");
        const models: Array<{ provider: string; id: string; default?: boolean }> = Array.isArray(r?.models) ? r.models : [];
        const lines = models.map((m) => `${m.default ? "*" : " "} ${m.provider}/${m.id}`);
        if (r?.source !== "pi") lines.push(`(source: ${r?.source ?? "none"}${r?.reason ? ` \u2014 ${r.reason}` : ""})`);
        print(r, lines.length ? lines.join("\n") : "no models");
        return EXIT.ok;
      }
      case "doctor": {
        const d = await api("GET", "/v1/doctor");
        print({ ...d, reasons: doctorReasons(d) }, renderDoctor(d, io.version));
        return d.ok ? EXIT.ok : EXIT.error;
      }
      // TODO(pomtree-publish-verb): no top-level `publish` verb here (only `report publish` below); the daemon publish route exists.
      case "report": {
        const sub = rest[0];
        if (sub === "publish") {
          const p = rest[1];
          if (!p) throw new Usage("report publish needs a path");
          let content: Buffer;
          try {
            const resolved = realpathSync(p);
            if (!statSync(resolved).isFile()) throw new Usage(`${resolved} is not a regular file`);
            content = readFileSync(resolved);
          } catch (e) {
            if (e instanceof Usage) throw e;
            throw new Usage(`cannot read ${p}: ${(e as Error).message}`);
          }
          const key = effectiveReportKey(flag("key"));
          const q = reportPublishQuery({ name: flag("name"), mediaType: flag("media-type"), generation: process.env.POMTREE_AGENT_GENERATION, key });
          const res: { report: Report; replayed: boolean } = await api("POST", `/v1/agents/self/reports?${q}`, content);
          const report = res.report;
          print(report, `${res.replayed === true ? "already published" : "published"} ${report.id}`);
          return EXIT.ok;
        }
        if (sub === "list") {
          const a = rest[1];
          // /v1/reports returns {report, agent}[]; the per-agent route returns Report[].
          const raw: (Report | { report: Report })[] = await api("GET", a ? `/v1/agents/${encodeURIComponent(a)}/reports` : "/v1/reports");
          const list: Report[] = raw.map((x) => ("report" in x ? x.report : x));
          print(
            list,
            list.length
              ? table([
                  ["ID", "AGENT", "NAME", "TYPE", "SIZE", "AGE"],
                  ...list.map((r) => [String(r.id), String(r.agent), String(r.name), String(r.mediaType), String(r.sizeBytes), age(r.createdAt)]),
                ])
              : "no reports",
          );
          return EXIT.ok;
        }
        if (sub === "show") {
          const a = rest[1];
          const rid = rest[2];
          if (!a) throw new Usage("report show needs an agent id");
          if (!rid) throw new Usage("report show needs a report id");
          const base = `/v1/agents/${encodeURIComponent(a)}/reports/${encodeURIComponent(rid)}`;
          const report: Report = await api("GET", base);
          print(report, stripControl(renderReport(report)));
          const outPath = flag("out");
          if (outPath) {
            const bytes = await rawGet(`${base}?raw=1`);
            try {
              writeFileSync(outPath, bytes);
            } catch (e) {
              throw new Failure(EXIT.error, `cannot write ${outPath}: ${(e as Error).message}`);
            }
            return EXIT.ok;
          }
          if (!json && isTextMediaType(report.mediaType)) io.out(stripControl((await rawGet(`${base}?raw=1`)).toString("utf8")));
          return EXIT.ok;
        }
        if (sub === "rm") {
          const a = rest[1];
          const rid = rest[2];
          if (!a) throw new Usage("report rm needs an agent id");
          if (!rid) throw new Usage("report rm needs a report id");
          await api("DELETE", `/v1/agents/${encodeURIComponent(a)}/reports/${encodeURIComponent(rid)}?key=${encodeURIComponent(idemKey())}`);
          print({ removed: rid }, `removed ${rid}`);
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown report command: ${sub}` : "report needs a subcommand (publish|list|show|rm)");
      }
      case "push": {
        const cwd = io.cwd ?? process.cwd();
        const git = io.git ?? runGit;
        const env = io.env ?? {};
        const ver = await git(["--version"], { cwd });
        const old = ver.code === 0 ? gitTooOld(ver.stdout) : `cannot run git: ${ver.stderr.trim()}`;
        if (old) throw new Failure(EXIT.error, old);
        const cur = await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
        const plan = planBundle({ baseCommit: env.POMTREE_BASE_COMMIT, branch: flag("branch"), current: cur.code === 0 ? cur.stdout.trim() : undefined });
        if (!plan.ok) throw new Failure(EXIT.usage, plan.message);
        const key = effectivePushKey(flag("key"));
        // TODO(push-on-exit): no automatic push at exit; the agent must run `pomtree push` itself before it finishes.
        const dir = mkdtempSync(join(io.tmpRoot ?? tmpdir(), "pomtree-push-"));
        try {
          const file = join(dir, "push.bundle");
          const b = await git(bundleArgs(file, plan.branch, plan.base), { cwd });
          if (b.code !== 0) throw new Failure(EXIT.error, bundleFailure(plan.branch, b));
          const bytes = readFileSync(file);
          if (bytes.length === 0) throw new Failure(EXIT.error, "nothing to push: the bundle is empty");
          const r = await io.call({
            method: "POST",
            path: `/v1/agents/self/push?key=${encodeURIComponent(key)}${has("force") ? "&force=1" : ""}`,
            body: bytes,
          });
          if (r.status >= 400) throw new Failure(codeFor(r.status), pushError(r.status, r.body));
          const refs = r.body?.refs;
          if (!isRefList(refs)) throw new Failure(EXIT.error, "daemon sent an unexpected push reply");
          print(r.body, refs.map((x) => `${stripControl(x.ref)} ${stripControl(x.commit)}`).join("\n") || "pushed (no refs)");
          return EXIT.ok;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      case "merge": {
        const child = rest[0];
        const into = flag("into");
        if (has("into") && !into) throw new Usage("--into needs a branch name");
        if (!child && !into) throw new Usage("merge needs a child agent id, or --into BRANCH to merge your own branch into it");
        const key = idemKey();
        const r = await io.call({
          method: "POST",
          path: `/v1/agents/self/merge?key=${encodeURIComponent(key)}`,
          body: { ...(child && { child }), ...(into && { into }) },
        });
        const o = mergeOutcome(r.status, r.body, child, stripControl);
        if (!o) throw failure(r.status, r.body);
        if (json) io.out(JSON.stringify(r.body));
        else if (o.ok) io.out(o.text);
        else
          io.err(
            `pomtree: ${o.text}${o.code === MERGE_EXIT.approval ? `\nretry later with: pomtree merge ${child ? `${child} ` : ""}${into ? `--into ${into} ` : ""}--key ${key}` : ""}`,
          );
        return o.code;
      }
      case "capture": {
        const sub = rest[0];
        if (sub === "request" || sub === "wait") {
          let path: string;
          let body: CaptureRequestBody | undefined;
          let retry: string | undefined;
          const waitMs = nonNegative("wait", flag("wait"), true);
          const waitQ = waitMs === undefined ? "" : `?waitMs=${waitMs}`;
          if (sub === "request") {
            let request: CaptureRequestBody["request"];
            try {
              request = captureRequestOf(rest[1], { render: flag("render"), maxAge: flag("max-age"), purpose: flag("purpose") });
            } catch (e) {
              if (e instanceof CaptureUsage) throw new Usage(e.message);
              throw e;
            }
            const key = idemKey();
            // TODO(capture-broker): CaptureRequestBody has no wait field, so --wait travels as ?waitMs= on the POST, as on the jobs route.
            path = `/v1/capture${waitQ}`;
            body = { request, idempotencyKey: key };
            retry = `the same pomtree capture request with --key ${key}`;
          } else {
            const job = rest[1];
            if (!job) throw new Usage("capture wait needs a job id (cj-...) from a still-running capture request");
            path = `/v1/capture/jobs/${encodeURIComponent(job)}${waitQ}`;
          }
          // TODO(capture-broker): a long --wait blocks on the daemon (which caps it at capture.waitMs) rather than yielding on the job;
          // there is no capture-job yield condition yet.
          const r: unknown = await api(body ? "POST" : "GET", path, body, true);
          if (!isCaptureResponse(r)) throw new Failure(EXIT.error, "daemon returned an unexpected capture reply");
          const v = captureView(r, stripControl, retry);
          if (json) io.out(JSON.stringify(r));
          else {
            if (v.out !== undefined) io.out(v.out);
            if (v.err !== undefined) io.err(`pomtree: ${v.err}`);
          }
          return v.code;
        }
        if (sub === "show") {
          const cid = rest[1];
          if (!cid) throw new Usage("capture show needs a capture id (cap-...)");
          const r: CaptureShowResponse = await api("GET", `/v1/capture/${encodeURIComponent(cid)}`);
          print(r, renderCaptureRecord(r.capture, stripControl));
          return EXIT.ok;
        }
        if (sub === "ls") {
          const limit = nonNegative("limit", flag("limit"), true, "");
          const r: CaptureListResponse = await api("GET", `/v1/capture${limit === undefined ? "" : `?limit=${limit}`}`);
          print(r, r.captures.length ? table(captureListRows(r.captures, stripControl, age)) : "no captures");
          return EXIT.ok;
        }
        throw new Usage(sub ? `unknown capture command: ${sub}` : "capture needs a subcommand (request|wait|show|ls)");
      }
      case "pull": {
        const cwd = io.cwd ?? process.cwd();
        const git = io.git ?? runGit;
        const ver = await git(["--version"], { cwd });
        const old = ver.code === 0 ? gitTooOld(ver.stdout) : `cannot run git: ${ver.stderr.trim()}`;
        if (old) throw new Failure(EXIT.error, old);
        const from = flag("from");
        const dir = mkdtempSync(join(io.tmpRoot ?? tmpdir(), "pomtree-pull-"));
        try {
          const file = join(dir, "pull.bundle");
          const r = await io.call({ method: "GET", path: pullPath(from), raw: true });
          if (r.status >= 400) {
            let parsed: unknown;
            try {
              parsed = JSON.parse((r.body as Buffer).toString("utf8"));
            } catch {
              /* not JSON */
            }
            throw failure(r.status, parsed);
          }
          writeFileSync(file, r.body as Buffer);
          const f = await git(fetchArgs(file), { cwd });
          if (f.code !== 0) throw new Failure(EXIT.error, `git fetch failed: ${f.stderr.trim().split("\n")[0] ?? "unknown error"}`);
          print(
            { fetched: true, from: from ?? "self" },
            `fetched into refs/remotes/pomtreed/* and refs/remotes/pomtreed-agents/*${from ? ` (from ${stripControl(from)})` : ""}`,
          );
          return EXIT.ok;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      // TODO(cli-verbs): `pomtree hosts` (see multi-host) is not built, so there is no verb to list or inspect hosts, and
      // there is no distinct fork verb: `spawn --fork` only cuts a branch from --from-commit and passes --session as sessionRef.
      // Current behavior: an unknown verb is a usage error.
      default:
        throw new Usage(cmd ? `unknown command: ${cmd}` : "no command given");
    }
  } catch (e) {
    const jsonError = (m: string) => io.out(JSON.stringify({ error: m }));
    if (e instanceof Usage) {
      if (json) jsonError(e.message);
      else {
        const u = usageFor(process.env.POMTREE_AGENT_GENERATION !== undefined ? agentUsage(USAGE) : USAGE, cmdWord);
        io.err(`pomtree: ${e.message}\n${u ?? ""}${u ? "\n" : ""}run 'pomtree --help' for all commands`);
      }
      return EXIT.usage;
    }
    if (e instanceof Failure) {
      if (json) jsonError(e.message);
      else io.err(`pomtree: ${e.message}${e.hint ? `\nhint: ${e.hint}` : ""}`);
      return e.code;
    }
    if (e instanceof TransportError) {
      const dir = io.env?.POMTREED_STATE_DIR ?? "~/.pomtreed";
      if (json) jsonError(e.message);
      else io.err(`pomtree: ${e.message}\nhint: ${transportHint(e.message, dir)}`);
      return EXIT.unreachable;
    }
    // Unexpected failure: one line, no stack unless POMTREE_CLIENT_DEBUG=1.
    if (io.env?.POMTREE_CLIENT_DEBUG === "1") throw e;
    const m = e instanceof Error ? e.message : String(e);
    if (json) jsonError(`internal error: ${m}`);
    else io.err(`pomtree: internal error: ${m}`);
    return 1;
  }
}
