// The bounded, redacted line a failed deterministic driver leaves in its journal and in the daemon log. A driver's thrown value
// is untrusted text: it may quote a credential, a fetched body, a host path or terminal control bytes. So it is never recorded
// raw: control characters are replaced, known secret shapes are redacted (trace.ts `redact`, the trace view's one rule set), any
// absolute host path becomes [path], and the result is capped. The journal write then also redacts the configured roots
// (Daemon.record). No stack is kept. Pure.
import { LifecycleError } from "./lifecycle.ts";
import { redact } from "./trace.ts";

// The closed cause code, from the thrown value's shape (never its text). A LifecycleError is a host op refusing the driver
// (its status): bad_request 400/422, denied 401/403, not_found 404, conflict 409 (also a spent fetch budget), upstream 502
// (a failed fetch), unavailable 503 (also a driver that is not loaded); any other status is op_failed. A store outage is
// store_down; any other thrown Error is threw; a thrown non-Error is non_error.
export const DRIVER_ERROR_CAUSES = [
  "bad_request",
  "denied",
  "not_found",
  "conflict",
  "upstream",
  "unavailable",
  "op_failed",
  "store_down",
  "threw",
  "non_error",
] as const;
export type DriverErrorCause = (typeof DRIVER_ERROR_CAUSES)[number];

export const DRIVER_ERROR_TEXT_MAX = 600; // characters of error text kept, after redaction
const SCAN_MAX = 16 * 1024; // bounds the redaction regexes' input; far above the kept length, so a cut secret is cut again below
const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/; // a Node/system error code (ECONNREFUSED, SQLITE_BUSY), the only `cause` detail kept

function causeOf(err: unknown, storeDown: boolean): DriverErrorCause {
  if (storeDown) return "store_down";
  if (err instanceof LifecycleError) {
    const s = err.status;
    if (s === 400 || s === 422) return "bad_request";
    if (s === 401 || s === 403) return "denied";
    if (s === 404) return "not_found";
    if (s === 409) return "conflict";
    if (s === 502) return "upstream";
    if (s === 503) return "unavailable";
    return "op_failed";
  }
  return err instanceof Error ? "threw" : "non_error";
}

// ANSI CSI sequences are removed whole (as pomtree's sanitize.ts does for terminal output); every other control character (Cc: C0,
// DEL, C1) and format character (Cf: bidi overrides, zero-width, BOM) that can disguise text becomes one space; runs of
// whitespace collapse, so a multi-line message reads as one log line.
export function stripControl(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: ESC [ ... final byte 0x40-0x7E
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// An absolute POSIX path that starts a token (line start, after whitespace, a quote, `(`, `=` or `:`) with two or more segments.
// A URL's path follows its host, never one of those, so `https://data.sec.gov/api/x` is kept whole.
const HOST_PATH_RE = /(^|[\s"'(=:])\/(?:[^\s"'():/]+\/)+[^\s"'():]*/g;
export const redactHostPaths = (text: string): string => text.replace(HOST_PATH_RE, "$1[path]");

function capChars(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : `${cps.slice(0, max).join("")}… [${cps.length - max} characters omitted]`;
}

// `storeDown` is the daemon's own isStoreDown verdict on the same value (kept out of here: it depends on the store adapter).
export function describeDriverError(err: unknown, storeDown = false): { cause: DriverErrorCause; text: string; line: string } {
  const cause = causeOf(err, storeDown);
  let raw = "";
  if (err instanceof Error) {
    raw = err.message;
    const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && CODE_RE.test(code)) raw = `${raw} (code ${code})`;
  } else if (typeof err === "string") raw = err;
  else raw = `a thrown ${err === null ? "null" : typeof err}`; // an object's fields are never stringified
  const text = capChars(redactHostPaths(redact(stripControl(raw.slice(0, SCAN_MAX))).text), DRIVER_ERROR_TEXT_MAX) || "(empty error message)";
  return { cause, text, line: `deterministic driver failed [cause=${cause}]: ${text}` };
}
