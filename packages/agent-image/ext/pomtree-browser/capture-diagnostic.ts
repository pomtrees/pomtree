// Operator-only diagnostic for a failed trusted capture subprocess. Never model-visible:
// index.ts records it in the journal and throws the fixed model-facing message instead.
export const CAPTURE_STDERR_TAIL_CHARS = 2000;
// Env values shorter than this are too common to redact safely (e.g. "1", "true").
const MIN_ENV_SECRET_LENGTH = 8;

export interface CaptureSubprocessResult {
  code: number | null;
  signal?: string | null;
  stderr?: string | Uint8Array | null;
  // pi.exec's `killed`: the subprocess was killed at the tool's timeout (deadline plus CAPTURE_PROCESS_SLACK_MS). Pi then reports code 0.
  timedOut?: boolean;
}

// Closed set of failure causes, derived from the fixed messages of browser-capture.ts and Playwright's `net::ERR_*` names. The cause is
// metadata only (no URL, header or page text), so it may appear in the model-visible tool error and in the daemon journal.
export const CAPTURE_FAILURE_CAUSES = [
  "deadline",
  "killed",
  "bad_url",
  "non_html",
  "bound",
  "no_response",
  "navigation_changed",
  "navigation_error",
  "cdp_unavailable",
  "publish_failed",
  // The site served a bot-challenge interstitial (browser-capture.ts botChallengeMarker). Never solved or bypassed.
  "bot_challenge",
  // The main response's URL or headers hold characters a WARC header refuses (capture-worker.ts buildRecords), so no archive can hold it.
  "unarchivable",
  "other",
] as const;
export type CaptureFailureCause = (typeof CAPTURE_FAILURE_CAUSES)[number];

export interface CaptureFailureDiagnostic {
  code: number | null;
  signal: string | null;
  stderrTail: string;
  cause: CaptureFailureCause;
  // Chromium network error name (for example ERR_NAME_NOT_RESOLVED) when stderr carries one.
  netError?: string;
  // The in-container `pomtree report publish` failure, when browser-capture.ts reported one (pomtreeFailureMessage there).
  pomtree?: PomtreeFailureDetail;
  // Set when the tool's timeout killed the subprocess, so the operator can tell an external kill from the capture's own deadline.
  timedOut?: true;
  // Set when the subprocess exited 0 but its stdout was not a JSON receipt.
  unparsableReceipt?: true;
}

// A failed in-container `pomtree` child (report publish or result). `code` is the exit code, or Node's error code string when it never
// ran or overflowed its buffer (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER). stderrTail is operator-only: redacted, one line, bounded.
export const CLI_STDERR_TAIL_CHARS = 500;
export interface PomtreeFailureDetail {
  code: number | string | null;
  signal: string | null;
  timedOut: boolean;
  stderrTail: string;
}
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,16}$/;
export function pomtreeFailureDetail(
  r: { code?: unknown; signal?: unknown; timedOut?: boolean; stderr?: string | null },
  env: Record<string, string | undefined>,
): PomtreeFailureDetail {
  const code = typeof r.code === "number" && Number.isSafeInteger(r.code) ? r.code : typeof r.code === "string" && ERROR_CODE.test(r.code) ? r.code : null;
  const signal = typeof r.signal === "string" && SIGNAL.test(r.signal) ? r.signal : null;
  return { code, signal, timedOut: r.timedOut === true, stderrTail: diagnosticTail(r.stderr ?? "", env) };
}
// Operator-only text as one redacted line, its last CLI_STDERR_TAIL_CHARS code points. Redact first, then collapse and bound, so a secret
// is never cut at the tail boundary with its head removed.
export function diagnosticTail(text: string, env: Record<string, string | undefined>): string {
  const line = redactDiagnosticText(text, env)
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  const chars = Array.from(line);
  return chars.length <= CLI_STDERR_TAIL_CHARS ? line : chars.slice(-CLI_STDERR_TAIL_CHARS).join("");
}
// The model-visible part of a pomtree failure: exit code, signal, timeout or Node error code only, never stderr.
export function pomtreeFailureNote(d: Pick<PomtreeFailureDetail, "code" | "signal" | "timedOut">): string {
  if (d.timedOut) return "pomtree timed out";
  if (typeof d.code === "number") return `pomtree exit ${d.code}`;
  if (d.signal) return `pomtree killed by ${d.signal}`;
  return d.code ? `pomtree error ${d.code}` : "pomtree failed";
}
// browser-capture.ts pomtreeFailureMessage: `scoped report publication failed (pomtree code=C signal=S timedOut=B)[ stderr: LINE]`.
const PUBLISH_FAILURE = /scoped report publication failed \(pomtree code=(\S{1,64}) signal=(\S{1,32}) timedOut=(true|false)\)(?: stderr: ([^\n]*))?/;
export function parsePomtreeFailure(text: string, env: Record<string, string | undefined>): PomtreeFailureDetail | undefined {
  const m = PUBLISH_FAILURE.exec(text);
  if (!m) return undefined;
  const code = m[1] === "null" ? null : /^\d{1,9}$/.test(m[1] ?? "") ? Number(m[1]) : m[1];
  return pomtreeFailureDetail({ code, signal: m[2], timedOut: m[3] === "true", stderr: m[4] ?? "" }, env);
}

// Any http(s) URL in the tail. Stops at whitespace, quotes, angle brackets and parentheses.
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`()]+/gi;
// Known-shape secrets in arbitrary text: bearer tokens, and key/value pairs with secret-looking names.
const BEARER = /\b(bearer)(\s+)\S+/gi;
const SECRET_PAIRS = /\b(authorization|cookie|token|secret|password|passwd|api[_-]?key)(\s*[:=]\s*)\S+/gi;

// Reduces a URL to scheme://host[:port]/[path-redacted]: userinfo, path, query and fragment are dropped.
// An authority that is not a clean host[:port] (e.g. "user:pa" cut off before its "@") is replaced whole.
function reduceUrl(url: string): string {
  const scheme = /^https?:\/\//i.exec(url)?.[0] ?? "";
  const rest = url.slice(scheme.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const host = /^(\[[^\]]*\]|[^\s:[\]()<>"'`,;]+)(:\d+)?/.exec(hostPort);
  const trailing = host ? hostPort.slice(host[0].length) : "";
  const clean = host !== null && (trailing === "" || /^[,;]/.test(trailing));
  return `${scheme}${clean ? host[0] : "[redacted]"}/[path-redacted]`;
}

export function redactDiagnosticText(text: string, env: Record<string, string | undefined>): string {
  let out = text.replace(URL_PATTERN, reduceUrl).replace(BEARER, "$1$2[redacted]").replace(SECRET_PAIRS, "$1$2[redacted]");
  // Exact environment values, longest first so a value containing another is fully replaced.
  const values = Object.values(env)
    .filter((v): v is string => typeof v === "string" && v.length >= MIN_ENV_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("[redacted-env]");
  return out;
}

// Redacts first, then bounds, so a secret is never cut at the tail boundary with its head removed.
export function captureFailureDiagnostic(result: CaptureSubprocessResult, env: Record<string, string | undefined>): CaptureFailureDiagnostic {
  const raw = result.stderr ?? "";
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const redacted = redactDiagnosticText(text, env);
  // Array.from splits by code point, so the tail never starts with a lone surrogate half.
  const chars = Array.from(redacted);
  const stderrTail = chars.length <= CAPTURE_STDERR_TAIL_CHARS ? redacted : chars.slice(-CAPTURE_STDERR_TAIL_CHARS).join("");
  const { cause, netError } = classifyCaptureFailure(result, text);
  const pomtree = parsePomtreeFailure(text, env);
  return {
    code: result.code ?? null,
    signal: result.signal ?? null,
    stderrTail,
    cause,
    ...(netError && { netError }),
    ...(pomtree && { pomtree }),
    ...(result.timedOut === true && { timedOut: true as const }),
  };
}

const NET_ERROR = /\bnet::(ERR_[A-Z0-9_]{1,64})\b/;
// Order matters: the most specific fixed message first. `text` is the (unredacted is fine: only fixed phrases and the net error name are read) stderr.
export function classifyCaptureFailure(result: CaptureSubprocessResult, text: string): { cause: CaptureFailureCause; netError?: string } {
  const netError = NET_ERROR.exec(text)?.[1];
  // Killed at the tool's timeout: the capture overran its own deadline, whatever it last wrote.
  if (result.timedOut === true) return { cause: "deadline", ...(netError && { netError }) };
  const rules: [RegExp, CaptureFailureCause][] = [
    [/served a bot challenge/, "bot_challenge"],
    [/main response cannot be archived/, "unarchivable"],
    [/browser capture deadline/, "deadline"],
    [/credential-free bounded HTTP\(S\) URL|Invalid URL/i, "bad_url"],
    [/requires an HTML main response/, "non_html"],
    [/exceeds capture bound|exceeds byte bound/, "bound"],
    [/missing main response/, "no_response"],
    // Playwright's evaluate after a reload or navigation replaced the document: "Execution context was destroyed, most likely because of a navigation".
    [/final URL changed during settle|page navigated after load|Execution context was destroyed/, "navigation_changed"],
    [/scoped report publication failed|report receipt mismatch|report hash mismatch/, "publish_failed"],
    [/connectOverCDP|ECONNREFUSED|Target page, context or browser has been closed|Browser has been closed/, "cdp_unavailable"],
    [/net::ERR_|Navigation|Timeout \d+ms exceeded/, "navigation_error"],
  ];
  const hit = rules.find(([re]) => re.test(text));
  if (hit) return { cause: hit[1], ...(netError && { netError }) };
  // No recognizable message: a signal means the subprocess was killed (the pi.exec timeout or the worker stop).
  return { cause: result.signal ? "killed" : "other", ...(netError && { netError }) };
}

// What the model is told for a cause it cannot act on by retrying. Fixed text, no page or URL content; other causes keep the bare message.
export const CAPTURE_FAILURE_HINTS: Readonly<Partial<Record<CaptureFailureCause, string>>> = {
  deadline: "the capture did not finish within its deadline and was stopped; retrying will not help, choose another source",
  navigation_changed:
    "the page navigated away after loading (a reload, redirect or consent page), so no stable document could be captured; retrying will not help",
  bot_challenge: "the site served a bot challenge; automated capture is not possible here; do not retry",
  unarchivable: "the page's URL or response headers cannot be stored in an archive; retrying will not help, choose another source",
};
// The model-visible tool error. The `(cause=...)` suffix stays last: pomtreed's toolFailureCauseOf parses it there. Never stderr.
export function captureFailureText(d: CaptureFailureDiagnostic): string {
  const hint = CAPTURE_FAILURE_HINTS[d.cause];
  return `trusted browser capture failed; no receipt issued${hint ? `; ${hint}` : ""}${d.pomtree ? `; ${pomtreeFailureNote(d.pomtree)}` : ""} (${captureFailureSuffix(d)})`;
}
// The browser_capture tool's reading of its pi.exec result. `aborted`: the tool call's signal fired (the worker stopped), which is a kill,
// not a timeout. A timeout kill (Pi reports code 0 with `killed`) and a clean exit whose stdout is not a JSON receipt are failures with
// a diagnostic, never a bare JSON parse error.
export type CaptureToolOutcome = { ok: true; receipt: unknown } | { ok: false; diagnostic: CaptureFailureDiagnostic; message: string };
export function captureToolOutcome(
  result: { code: number | null; killed?: boolean; stdout: string; stderr?: string | null },
  aborted: boolean,
  env: Record<string, string | undefined>,
): CaptureToolOutcome {
  const fail = (diagnostic: CaptureFailureDiagnostic): CaptureToolOutcome => ({ ok: false, diagnostic, message: captureFailureText(diagnostic) });
  if (result.killed === true)
    return fail(
      aborted
        ? { ...captureFailureDiagnostic({ code: result.code, stderr: result.stderr }, env), cause: "killed" }
        : captureFailureDiagnostic({ code: result.code, stderr: result.stderr, timedOut: true }, env),
    );
  if (result.code !== 0) return fail(captureFailureDiagnostic({ code: result.code, stderr: result.stderr }, env));
  try {
    return { ok: true, receipt: JSON.parse(result.stdout) };
  } catch {
    return fail({ ...captureFailureDiagnostic({ code: result.code, stderr: result.stderr }, env), cause: "other", unparsableReceipt: true });
  }
}

// The EXPERIMENTAL interactive profile's closed causes beyond the capture ones: a failed pi-browser tool (egress_denied, dns,
// element_not_found), a blocked call (budget, refused) and a failed capture_finish (finish_failed, uncommitted_work). Each parses as
// pomtreed's toolFailureCauseOf token ([a-z_]{1,32}); a test pins that.
export const BROWSER_FAILURE_CAUSES = [
  ...CAPTURE_FAILURE_CAUSES,
  "egress_denied",
  "dns",
  "element_not_found",
  "budget",
  "refused",
  "finish_failed",
  "uncommitted_work",
] as const;
export type BrowserFailureCause = (typeof BROWSER_FAILURE_CAUSES)[number];

// A failed interactive pi-browser tool's error text (Playwright's, passed through by pi-browser) classified into a closed cause and a short
// hint the model can act on. Order matters: the most specific first. Only fixed phrases and the net::ERR_* name are read; nothing of the
// text is returned. The egress proxy refusing a CONNECT surfaces in Chromium as a tunnel or proxy connection failure [knowledge-only].
export function classifyBrowserToolFailure(text: string): { cause: BrowserFailureCause; netError?: string; hint: string } {
  const netError = NET_ERROR.exec(text)?.[1];
  const net = netError ? { netError } : {};
  if (/^ERR_(?:TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)$/.test(netError ?? ""))
    return { cause: "egress_denied", ...net, hint: "host blocked or unreachable through the egress policy; do not retry the same host, choose another source" };
  if (netError === "ERR_NAME_NOT_RESOLVED") return { cause: "dns", ...net, hint: "the host name did not resolve; check its spelling or choose another source" };
  if (/Browser not connected|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i.test(text))
    return { cause: "cdp_unavailable", ...net, hint: "the browser is not connected; end the run with capture_finish status failed" };
  // The pinned pi-browser turns `ref` into the locator `aria/<ref>`, which Playwright does not register, and its snapshots carry no refs
  // to pass: only `selector` works. TODO(browser-causes): a closed cause for this would need a new token in core; it reuses
  // element_not_found with its own hint.
  if (/aria\/|Unknown engine "aria"/.test(text))
    return {
      cause: "element_not_found",
      ...net,
      hint: "ref does not work and snapshots carry no refs; pass selector (a CSS selector such as a[href=...]) instead",
    };
  if (/waiting for (?:locator|getBy\w+)\(|strict mode violation|element is not (?:attached|visible|enabled|stable)/i.test(text))
    return {
      cause: "element_not_found",
      ...net,
      hint: "element not found or not actionable; check the selector, or re-run browser_snapshot and pick a more specific one",
    };
  if (/Cannot navigate to invalid URL|Invalid URL/i.test(text)) return { cause: "bad_url", ...net, hint: "the URL is invalid; pass a full http(s) URL" };
  if (netError) return { cause: "navigation_error", ...net, hint: `the page failed to load (${netError}); try another URL or source` };
  if (/page\.goto|page\.goBack|Navigation|Timeout \d+ms exceeded/.test(text))
    return { cause: "navigation_error", hint: "the page did not load in time; try once more or choose another source" };
  return { cause: "other", hint: "the browser action failed; check its input or try a different action" };
}

// The model-visible, journaled tail of the tool error: `cause=<closed cause>` plus `net=<ERR_*>` when known.
export function captureFailureSuffix(d: { cause: BrowserFailureCause; netError?: string }): string {
  return `cause=${d.cause}${d.netError ? ` net=${d.netError}` : ""}`;
}

// The operator-only diagnostic's path to the journal. The browser extension appends one sink line of type DIAGNOSTIC_SINK_TYPE to the
// events sink (beside the Pi session entry, which stays); harness-pi's pi-format.ts reads that type (its copy of the constant is pinned
// by a round-trip test in examples/hn-digest) and journals the line's `message` as a harness `error` event. The message is
// `operator-diagnostic <name> <json>`: `name` is the Pi session entry name (for example `browser-capture-failure`), the JSON is the
// entry's data, already redacted and bounded by the builders above. It never reaches the model (the tool still throws its fixed text).
export const DIAGNOSTIC_SINK_TYPE = "operator_diagnostic";
export const DIAGNOSTIC_MESSAGE_PREFIX = "operator-diagnostic ";
export const DIAGNOSTIC_MAX_BYTES = 16384;
const DIAGNOSTIC_NAME = /^[a-z][a-z0-9-]{0,63}$/;

// A detail over DIAGNOSTIC_MAX_BYTES loses its stderr tails (the only unbounded-in-bytes part: 4-byte characters and JSON escapes) and says so.
export function diagnosticMessage(name: string, detail: Record<string, unknown>): string {
  if (!DIAGNOSTIC_NAME.test(name)) throw new Error("diagnostic name must be lower-case words joined by hyphens");
  let json = JSON.stringify(detail);
  if (Buffer.byteLength(json) > DIAGNOSTIC_MAX_BYTES) {
    const bare = JSON.parse(json, (key, value) => (key === "stderrTail" ? "" : value));
    json = JSON.stringify({ ...bare, clipped: true });
  }
  return `${DIAGNOSTIC_MESSAGE_PREFIX}${name} ${json}`;
}
export function diagnosticSinkLine(name: string, detail: Record<string, unknown>): string {
  return `${JSON.stringify({ type: DIAGNOSTIC_SINK_TYPE, message: diagnosticMessage(name, detail) })}\n`;
}
// Reads a journaled `error` message back; undefined for any other error (a message without the prefix, a bad name, JSON that is not an object).
export function parseDiagnosticMessage(message: string): { name: string; detail: Record<string, unknown> } | undefined {
  if (!message.startsWith(DIAGNOSTIC_MESSAGE_PREFIX)) return undefined;
  const rest = message.slice(DIAGNOSTIC_MESSAGE_PREFIX.length);
  const space = rest.indexOf(" ");
  if (space < 0 || !DIAGNOSTIC_NAME.test(rest.slice(0, space))) return undefined;
  try {
    const detail: unknown = JSON.parse(rest.slice(space + 1));
    if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return undefined;
    return { name: rest.slice(0, space), detail: detail as Record<string, unknown> };
  } catch {
    return undefined;
  }
}
