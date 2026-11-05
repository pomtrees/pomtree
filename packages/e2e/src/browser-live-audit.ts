import { createHash } from "node:crypto";
import { CAPTURE_REPORT_NAMES } from "../../agent-image/src/browser-capture.ts";
import { BROWSER_INTERACTIVE_TOOLS } from "../../agent-image/src/browser-run.ts";
import { registrableDomain } from "./browser-live.ts";

// Pure checks over the evidence of one live browser run: the egress audit rows, the cost ledger, and the agent's tool-call trace.
// No I/O here; the live script reads the files and passes the rows in. Every evaluator runs all of its checks and returns them
// all, so a failure report shows the full picture rather than the first problem.

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  warning?: true; // ok stays true; the check reports something to look at that is not yet a failure
}

export interface AuditRow {
  agent: string;
  host: string;
  generation: number;
  authority: string;
  phase: string;
  outcome: string;
  [k: string]: unknown;
}

// Traffic Chromium emits on its own (component updates, safe-browsing lookups). It fires whether or not the article is reachable,
// so it is not evidence of page leakage; it is named exactly so that any other off-domain authority still fails.
export const BROWSER_BACKGROUND: ReadonlySet<string> = new Set(["android.clients.google.com:443", "update.googleapis.com:443", "edgedl.me.gvt1.com:80"]);

// The host's Chrome DevTools port on loopback. A page that tries to reach it is probing for a way to drive the host browser, so
// the egress policy must refuse it; a denial here is the expected outcome, and any other denial is a policy surprise.
export const LOOPBACK_CDP = "127.0.0.1:9222";

function result(checks: Check[]): { ok: boolean; checks: Check[] } {
  return { ok: checks.every((c) => c.ok), checks };
}

// Splits "host:port" at the last colon. Authorities here are DNS names or IPv4 addresses, so bracketed IPv6 is not handled.
function splitAuthority(authority: string): { hostname: string; port: string } {
  const i = authority.lastIndexOf(":");
  return i < 0 ? { hostname: authority, port: "" } : { hostname: authority.slice(0, i), port: authority.slice(i + 1) };
}

// Audit rows are compared by registrable domain, not by exact host, so that the article's own subdomains (CDNs, static hosts)
// pass while a lookalike such as "rfc-editor.org.attacker.test" does not.
export function evaluateAudit(o: {
  rows: AuditRow[];
  agent: string;
  host: string;
  generation: number;
  articleUrl: string;
  relayAuthorities: string[];
  extraAuthorities?: string[];
  // Negative runs only: authorities the policy is expected to DENY (a private/loopback article the browser listener must refuse). Denied rows for
  // them are expected and "article domain reached" becomes "article authority refused". Never set for a run meant to read a page.
  refusedAuthorities?: string[];
  hostConfig: { NetworkMode?: string; CapDrop?: string[] | null };
}): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const total = o.rows.length;

  checks.push({ name: "rows present", ok: total > 0, detail: `${total} audit row(s)` });

  // A row from another agent, host or generation means the log was shared or stale; the audit then says nothing about this run.
  const foreign = o.rows.filter((r) => r.agent !== o.agent || r.host !== o.host || r.generation !== o.generation);
  checks.push({
    name: "rows bound to this run",
    ok: foreign.length === 0,
    detail:
      foreign.length === 0
        ? `all ${total} row(s) are agent=${o.agent} host=${o.host} generation=${o.generation}`
        : `${foreign.length} row(s) not from agent=${o.agent} host=${o.host} generation=${o.generation}: ${foreign.map((r) => `${r.agent}/${r.host}/gen${r.generation}`).join(", ")}`,
  });

  const articleDomain = registrableDomain(new URL(o.articleUrl).hostname);
  const relay = new Set(o.relayAuthorities);
  const extra = new Set(o.extraAuthorities ?? []);
  const refused = new Set(o.refusedAuthorities ?? []);
  const acceptable = (authority: string): boolean =>
    registrableDomain(splitAuthority(authority).hostname) === articleDomain ||
    relay.has(authority) ||
    BROWSER_BACKGROUND.has(authority) ||
    extra.has(authority);
  // A denied loopback CDP probe is exempt here too: the policy refusing it is the proof, so it is not a flow the page reached.
  const expectedDenial = (r: AuditRow): boolean => r.outcome === "denied" && (r.authority === LOOPBACK_CDP || refused.has(r.authority));
  const offending = [...new Set(o.rows.filter((r) => !expectedDenial(r) && !acceptable(r.authority)).map((r) => r.authority))];
  checks.push({
    name: "authorities within allowed set",
    ok: offending.length === 0,
    detail:
      offending.length === 0
        ? `every authority is in ${articleDomain}, the relay, or the browser background set`
        : `unacceptable authorit${offending.length === 1 ? "y" : "ies"} (not ${articleDomain}, relay, background or extra): ${offending.join(", ")}`,
  });

  // Denials are only tolerated for the loopback CDP probe (see LOOPBACK_CDP). Any other denied flow means the page reached for
  // something the policy did not expect to be asked, which the run should surface rather than absorb. The browser listener has no
  // relay set, so a page on a private or loopback host (including host.docker.internal) is denied by design and is never expected in
  // a run that reads a page: only a negative run names it in refusedAuthorities.
  const denied = o.rows.filter((r) => r.outcome === "denied");
  const unexpectedDenied = [...new Set(denied.filter((r) => !expectedDenial(r)).map((r) => r.authority))];
  const allowedDenials = refused.size === 0 ? LOOPBACK_CDP : `${LOOPBACK_CDP} or the refused ${[...refused].join(", ")}`;
  checks.push({
    name: "denials only for loopback CDP",
    ok: unexpectedDenied.length === 0,
    detail:
      unexpectedDenied.length === 0
        ? `${denied.length} denied row(s), all ${allowedDenials}`
        : `${denied.length} denied row(s); unexpected denial(s) to: ${unexpectedDenied.join(", ")}`,
  });

  if (refused.size === 0) {
    // Without an allowed article-domain flow the run never reached the page, so a clean audit would be vacuous.
    const reached = o.rows.filter((r) => r.outcome === "allowed" && registrableDomain(splitAuthority(r.authority).hostname) === articleDomain);
    checks.push({
      name: "article domain reached",
      ok: reached.length >= 1,
      detail: `${reached.length} allowed row(s) for ${articleDomain}`,
    });
  } else {
    // The negative run is vacuous unless the refusal is on the record.
    const refusals = o.rows.filter((r) => r.outcome === "denied" && refused.has(r.authority));
    checks.push({
      name: "article authority refused",
      ok: refusals.length >= 1,
      detail: `${refusals.length} denied row(s) for ${[...refused].join(", ")}`,
    });
  }

  // Network mode "none" is what makes the egress sidecar the only route out; any other mode lets the worker bypass the audit.
  const networkMode = o.hostConfig.NetworkMode;
  checks.push({
    name: "network mode is none",
    ok: networkMode === "none",
    detail: `NetworkMode=${String(networkMode)}`,
  });

  // Dropping all capabilities is the baseline sandbox; an empty or missing CapDrop means the container keeps its defaults.
  const capDrop = o.hostConfig.CapDrop;
  const capDropOk = Array.isArray(capDrop) && capDrop.length === 1 && capDrop[0] === "ALL";
  checks.push({
    name: "capabilities dropped",
    ok: capDropOk,
    detail: `CapDrop=${JSON.stringify(capDrop ?? null)}`,
  });

  return result(checks);
}

export interface DebitRow {
  request_id: string;
  status: string;
  charged_micros: number | null;
  maximum_micros: number;
  created_at: number;
}

// Statuses a debit row may end in. "reserved" is the in-flight state; a row still reserved after the run means a call neither
// settled nor released its hold, so its cost is unknown.
const TERMINAL_OK = new Set(["settled", "released", "failed"]);

// Money is compared in integer micros throughout. The per-call tolerance is one micro because Pi reports cost as a float that
// the ledger rounds to micros; anything larger than that is a real divergence between the two accounts.
const PER_CALL_TOLERANCE_MICROS = 1;

export function evaluateCost(o: { capMicros: number; spentMicros: number; debitRows: DebitRow[]; piCostsMicros: number[] }): {
  ok: boolean;
  checks: Check[];
} {
  const checks: Check[] = [];

  checks.push({
    name: "spend within cap",
    ok: o.spentMicros <= o.capMicros,
    detail: `spent ${o.spentMicros} micros, cap ${o.capMicros} micros`,
  });

  // The reported total must equal the sum of settled debits, recomputed here rather than trusted. A settled row without a charge
  // counts as a failure, not as zero, because a missing charge would otherwise silently understate spend.
  const settled = o.debitRows.filter((r) => r.status === "settled");
  const recomputed = settled.reduce((sum, r) => sum + (r.charged_micros ?? 0), 0);
  const settledNoCharge = settled.filter((r) => r.charged_micros === null).length;
  checks.push({
    name: "spend equals settled debits",
    ok: recomputed === o.spentMicros && settledNoCharge === 0,
    detail: `recomputed ${recomputed} micros from ${settled.length} settled row(s) (${settledNoCharge} without a charge), reported ${o.spentMicros} micros`,
  });

  const counts = new Map<string, number>();
  for (const r of o.debitRows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const lingering = [...counts.keys()].filter((s) => !TERMINAL_OK.has(s));
  const statusSummary = [...counts].map(([s, n]) => `${s}=${n}`).join(" ") || "no rows";
  checks.push({
    name: "no unresolved debit rows",
    ok: lingering.length === 0,
    detail: lingering.length === 0 ? `statuses: ${statusSummary}` : `unresolved status(es): ${lingering.join(", ")}; statuses: ${statusSummary}`,
  });

  // Per-call comparison pairs each settled debit with the matching Pi-reported cost by position, so both sides must be in the
  // order the calls happened. Ties on created_at fall back to request_id so the order is stable across reads.
  const charged = settled
    .filter((r) => (r.charged_micros ?? 0) > 0)
    .sort((a, b) => a.created_at - b.created_at || (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0));
  const pi = o.piCostsMicros.filter((c) => c > 0);
  const pairs = Math.min(charged.length, pi.length);
  const pairDetail: string[] = [];
  let pairsOk = true;
  for (let i = 0; i < pairs; i++) {
    const c = charged[i]?.charged_micros ?? 0;
    const p = pi[i] ?? 0;
    pairDetail.push(`${c}/${p}`);
    if (Math.abs(c - p) > PER_CALL_TOLERANCE_MICROS) pairsOk = false;
  }
  const countsEqual = charged.length === pi.length;
  checks.push({
    name: "per-call cost matches Pi",
    ok: countsEqual && pairsOk,
    detail: `${charged.length} charged call(s) vs ${pi.length} Pi cost(s); charged/pi: ${pairDetail.join(", ") || "none"} (tolerance ${PER_CALL_TOLERANCE_MICROS} micro)`,
  });

  return result(checks);
}

// Capture mode is a single fixed step, so anything other than exactly one browser_capture call is a broken run. Browse mode lets
// the agent drive the page, bounded by maxSteps; browser_capture may appear but at most once, since a second capture would
// double-count the page the run is meant to record.
// capture_finish ends the run and is not a browsing step, so it is not counted. bash, read, write and edit are not in the image's tool allowlist (BROWSER_TOOLS in agent-image browser-run.ts), so any call to them fails the run.
export const FORBIDDEN_WORKER_TOOLS: readonly string[] = ["bash", "read", "write", "edit"];
export function evaluateSteps(o: { mode: "capture" | "browse" | "interactive"; toolNames: string[]; maxSteps: number }): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const all = o.toolNames;
  const toolNames = all.filter((n) => n !== "capture_finish");
  o = { ...o, toolNames };
  const names = `[${o.toolNames.join(", ")}]`;
  const captures = o.toolNames.filter((n) => n === "browser_capture").length;
  const forbidden = all.filter((n) => FORBIDDEN_WORKER_TOOLS.includes(n));
  checks.push({ name: "no exec or write tool called", ok: forbidden.length === 0, detail: `forbidden=[${forbidden.join(", ")}]` });

  if (o.mode === "interactive") {
    // Interactive mode: every call (capture_finish included) spends the worker's step budget; only the profile's tools may appear.
    const offered = new Set<string>(BROWSER_INTERACTIVE_TOOLS);
    const outside = all.filter((n) => !offered.has(n));
    checks.push({
      name: "interactive step count within bound",
      ok: all.length >= 1 && all.length <= o.maxSteps,
      detail: `${all.length} call(s), bound 1..${o.maxSteps}; tools=[${all.join(", ")}]`,
    });
    checks.push({ name: "interactive calls only the profile's tools", ok: outside.length === 0, detail: `outside=[${outside.join(", ")}]` });
  } else if (o.mode === "capture") {
    checks.push({
      name: "capture mode runs exactly browser_capture",
      ok: o.toolNames.length === 1 && o.toolNames[0] === "browser_capture",
      detail: `tools=${names}`,
    });
  } else {
    const steps = o.toolNames.length;
    checks.push({
      name: "browse step count within bound",
      ok: steps >= 1 && steps <= o.maxSteps,
      detail: `${steps} step(s), bound 1..${o.maxSteps}; tools=${names}`,
    });
    checks.push({
      name: "browser_capture at most once",
      ok: captures <= 1,
      detail: `${captures} browser_capture call(s)`,
    });
  }

  return result(checks);
}

// File extension for a stored report body, from the name the capture extension publishes it under. Media type is not relayed,
// so the name decides. The Record type makes this exhaustive: a new CAPTURE_REPORT_NAMES entry fails typecheck until mapped here.
type CaptureReportName = (typeof CAPTURE_REPORT_NAMES)[keyof typeof CAPTURE_REPORT_NAMES];
const CAPTURE_EXTENSIONS: Record<CaptureReportName, string> = {
  [CAPTURE_REPORT_NAMES.rawBody]: "html",
  [CAPTURE_REPORT_NAMES.dom]: "html",
  [CAPTURE_REPORT_NAMES.text]: "txt",
  [CAPTURE_REPORT_NAMES.screenshot]: "png",
  [CAPTURE_REPORT_NAMES.navigation]: "json",
};
const isCaptureReportName = (name: string): name is CaptureReportName => (Object.values(CAPTURE_REPORT_NAMES) as string[]).includes(name);
// An unknown name throws rather than guessing an extension: a guessed extension would store the body where the receipt check cannot find it.
export function reportExtension(name: string): string {
  const ext = reportExtensionOrNull(name);
  if (ext === null) throw new Error(`no file extension for report name ${JSON.stringify(name)}`);
  return ext;
}
export function reportExtensionOrNull(name: string): string | null {
  if (isCaptureReportName(name)) return CAPTURE_EXTENSIONS[name];
  if (/^browser-screenshot-\d+$/.test(name)) return "png";
  if (/^browser-action-\d+$/.test(name)) return "json";
  return null;
}

// Where each stored report body is written. The report relay accepts any agent-chosen name, so an unknown one must not abort the
// write-out after a run: it is stored as `.bin` and surfaced as an `unknown-report-name` warning in assertions.json.
export function reportFilePlan(
  ids: Iterable<string>,
  names: ReadonlyMap<string, string>,
): { file: Map<string, string>; warnings: { name: "unknown-report-name"; detail: string }[] } {
  const file = new Map<string, string>();
  const warnings: { name: "unknown-report-name"; detail: string }[] = [];
  for (const id of ids) {
    const name = names.get(id);
    const ext = name === undefined ? null : reportExtensionOrNull(name);
    if (ext === null)
      warnings.push({
        name: "unknown-report-name",
        detail: `report ${id} has ${name === undefined ? "no recorded name" : `unrecognised name ${JSON.stringify(name)}`}; stored as .bin`,
      });
    file.set(id, `reports/${id}.${ext ?? "bin"}`);
  }
  return { file, warnings };
}

const REPORT_KEYS = ["rawBodyReport", "domReport", "textReport", "screenshotReport", "navigationReport"];

// Recomputes the sha256 of each of the receipt's five reports from the saved body (`readBody` returns the bytes read back from the
// output directory) and compares it with the hash the receipt claims.
export function recomputeReports(
  receipt: Record<string, { id?: string; sha256?: string } | undefined>,
  readBody: (id: string) => Uint8Array | undefined,
): Check {
  const bad: string[] = [];
  for (const k of REPORT_KEYS) {
    const ref = receipt[k];
    const body = ref?.id === undefined ? undefined : readBody(ref.id);
    if (!body || createHash("sha256").update(body).digest("hex") !== ref?.sha256) bad.push(k);
  }
  return {
    name: "reports-recompute",
    ok: bad.length === 0,
    detail:
      bad.length === 0
        ? `${REPORT_KEYS.length} of ${REPORT_KEYS.length} report hashes recomputed from the saved bodies`
        : `${REPORT_KEYS.length - bad.length} of ${REPORT_KEYS.length} recomputed; mismatch/missing: ${bad.join(",")}`,
  };
}

// Tags each egress row with the relay endpoint it reached (exact authority match, i.e. host and port), else null.
export function labelRelay<T extends { authority: string }>(
  rows: T[],
  relays: { model: string; report: string },
): (T & { relay: "model" | "report" | null })[] {
  return rows.map((r) => ({ ...r, relay: r.authority === relays.model ? "model" : r.authority === relays.report ? "report" : null }));
}

// The requestId of the model call that issued assistant turn `turn`: the turn-th settlement. Only valid when every assistant message
// had exactly one settled model call, so a count mismatch (retries, failed calls) yields null rather than a wrong link.
export function followsModelCall(turn: number | null, requestIds: string[], turnCount: number): string | null {
  if (turn === null || requestIds.length !== turnCount) return null;
  return requestIds[turn] ?? null;
}

const MAX_JOURNAL_STRING = 2048;
const CREDENTIAL_KEY = /^(authorization|password|secret|api[_-]?key|credentials?|token|access[_-]?token|bearer)$/i;

// Journal entries reduced for audit output: strings over 2 KB are cut with a marker, credential-named keys are replaced, and any
// literal occurrence of a known secret value is scrubbed (values shorter than 8 characters are ignored as too ambiguous).
export function sanitizeJournal<T extends { payload: unknown }>(entries: T[], secrets: string[]): T[] {
  const live = secrets.filter((x) => x.length >= 8);
  const scrub = (v: unknown, key = ""): unknown => {
    if (CREDENTIAL_KEY.test(key)) return "[redacted]";
    if (typeof v === "string") {
      let t = v;
      for (const x of live) t = t.split(x).join("[redacted]");
      return t.length > MAX_JOURNAL_STRING ? `${t.slice(0, MAX_JOURNAL_STRING)}[truncated ${t.length - MAX_JOURNAL_STRING} chars]` : t;
    }
    if (Array.isArray(v)) return v.map((x) => scrub(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
    return v;
  };
  return entries.map((e) => ({ ...e, payload: scrub(e.payload) }));
}

// Whether the last `ext.pomtreed.sandbox` exited entry is a clean stop (exitCode 0, expected true). A warning rather than a failure
// until proven on real runs; the check is always ok.
export function evaluateSandboxStop(entries: { payload: unknown }[]): Check {
  const name = "sandbox-clean-stop";
  const exited = entries
    .map((e) => e.payload as { kind?: string; phase?: string; exitCode?: number; expected?: boolean; observedExitCode?: number })
    .filter((p) => p.kind === "ext.pomtreed.sandbox" && p.phase === "exited");
  const last = exited.at(-1);
  if (!last) return { name, ok: true, warning: true, detail: "no ext.pomtreed.sandbox exited entry in the journal" };
  const detail = `exitCode=${last.exitCode} expected=${last.expected} observedExitCode=${last.observedExitCode}`;
  return last.exitCode === 0 && last.expected === true ? { name, ok: true, detail } : { name, ok: true, warning: true, detail };
}
