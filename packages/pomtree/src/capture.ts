// Pure helpers for `pomtree capture request|wait|show|ls`: flag parsing, the exit mapping of a capture outcome, and the human text.
// The wire shapes are core's (CaptureRequestBody, CaptureResponse, CaptureShowResponse, CaptureListResponse); none are redeclared here.
import { CAPTURE_PURPOSE_MAX, CAPTURE_RENDERS, captureRequestProblem, captureRetryable } from "@pomtree/core";
import type { CaptureFailure, CaptureRecord, CaptureRender, CaptureRequest, CaptureResponse } from "@pomtree/core";

// Command-specific exit codes for a `failed` outcome, above the shared EXIT codes (0-7), pomtree merge's 8-12 (MERGE_EXIT) and the
// 13-14 that the capture broker reserves for `pomtree capture verify`. invalid_request and forbidden reuse the shared usage (2) and
// denied (4) codes, since they mean exactly that; a `pending` outcome is the shared timeout (7).
export const CAPTURE_EXIT = { retryLater: 15, unavailableSource: 16, approval: 17, brokerUnavailable: 18 } as const;

// One code per failure, by what the caller should do next. Retry policy is core's (captureRetryable, Table 1's "Retry" column).
export function captureFailureExit(f: Pick<CaptureFailure, "class" | "reason">): number {
  switch (f.class) {
    case "invalid_request":
      return 2;
    case "forbidden":
      return 4;
    case "pending_approval":
      return CAPTURE_EXIT.approval;
    case "unavailable":
      return CAPTURE_EXIT.brokerUnavailable;
    default:
      return captureRetryable(f.class, f.reason) ? CAPTURE_EXIT.retryLater : CAPTURE_EXIT.unavailableSource;
  }
}

export class CaptureUsage extends Error {}

// Builds the CaptureRequest from the CLI's words, refusing bad flags with a message that names the flag and the fix.
export function captureRequestOf(url: string | undefined, f: { render?: string; maxAge?: string; purpose?: string }): CaptureRequest {
  if (!url) throw new CaptureUsage("capture request needs a URL, e.g. pomtree capture request https://example.com/page --purpose TEXT");
  if (f.render !== undefined && !(CAPTURE_RENDERS as readonly string[]).includes(f.render))
    throw new CaptureUsage(`--render must be one of ${CAPTURE_RENDERS.join("|")}, got "${f.render}"`);
  let maxAgeMs: number | undefined;
  if (f.maxAge !== undefined) {
    maxAgeMs = /^\d+$/.test(f.maxAge) ? Number(f.maxAge) : NaN;
    if (!Number.isSafeInteger(maxAgeMs)) throw new CaptureUsage(`--max-age must be a non-negative integer of ms, got "${f.maxAge}"`);
  }
  if (f.purpose === undefined || f.purpose.trim() === "")
    throw new CaptureUsage("capture request needs --purpose TEXT: say in a few words why you need the page (journaled, never sent upstream)");
  if (f.purpose.length > CAPTURE_PURPOSE_MAX)
    throw new CaptureUsage(`--purpose is longer than ${CAPTURE_PURPOSE_MAX} characters (${f.purpose.length}); shorten it`);
  const request: CaptureRequest = {
    url,
    purpose: f.purpose,
    ...(f.render !== undefined && { render: f.render as CaptureRender }),
    ...(maxAgeMs !== undefined && { maxAgeMs }),
  };
  const problem = captureRequestProblem(request);
  if (problem) throw new CaptureUsage(problem);
  return request;
}

const sha = (s: string) => s.slice(0, 12);

const artifactLines = (c: CaptureRecord, clean: (s: string) => string): string[] =>
  c.artifacts.length ? c.artifacts.map((a) => `  ${clean(a.role)}  sha256:${clean(sha(a.sha256))}  ${clean(a.mediaType)}  ${a.sizeBytes} B`) : ["  (none)"];

// The human view of a stored capture (`show`, and the body of an `ok` outcome).
export function renderCaptureRecord(c: CaptureRecord, clean: (s: string) => string, servedFrom?: string): string {
  const f = c.predicate.fetch;
  return [
    `capture ${clean(c.id)}`,
    servedFrom !== undefined ? `served from: ${clean(servedFrom)} (source ${clean(c.predicate.source)})` : `source: ${clean(c.predicate.source)}`,
    `url: ${clean(f.finalUrl)}`,
    `status: ${f.status}`,
    `content type: ${clean(f.contentType ?? "unknown")}`,
    "artifacts:",
    ...artifactLines(c, clean),
  ].join("\n");
}

// A shape check on the daemon's reply, so a malformed one is a plain error rather than a crash in the renderer.
export function isCaptureResponse(v: unknown): v is CaptureResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { outcome?: unknown; message?: unknown };
  if (!(r.message === null || typeof r.message === "string") || typeof r.outcome !== "object" || r.outcome === null) return false;
  const o = r.outcome as { state?: unknown; capture?: unknown; job?: unknown; failure?: unknown };
  if (o.state === "ok") {
    const c = o.capture as { id?: unknown; artifacts?: unknown; predicate?: { fetch?: unknown } } | null;
    return typeof c === "object" && c !== null && typeof c.id === "string" && Array.isArray(c.artifacts) && typeof c.predicate?.fetch === "object";
  }
  if (o.state === "pending") return typeof o.job === "string";
  if (o.state === "failed") return typeof o.job === "string" && typeof (o.failure as { class?: unknown } | null)?.class === "string";
  return false;
}

export interface CaptureView {
  code: number; // 0 ok, 7 pending, else captureFailureExit
  out?: string; // stdout
  err?: string; // stderr, without the "pomtree: " prefix
}

// The exit code and text for a CaptureResponse. `retry` is the command that converges on the same job (pending only).
export function captureView(r: CaptureResponse, clean: (s: string) => string, retry?: string): CaptureView {
  const o = r.outcome;
  if (o.state === "ok") return { code: 0, out: renderCaptureRecord(o.capture, clean, o.servedFrom) };
  if (o.state === "pending") {
    const job = clean(o.job);
    return {
      code: 7,
      out: [
        r.message !== null ? clean(r.message) : `capture ${job} is still running`,
        `wait with: pomtree capture wait ${job} [--wait MS]`,
        ...(retry ? [`or retry with: ${retry}`] : []),
      ].join("\n"),
    };
  }
  const f = o.failure;
  const detail = [
    `class ${clean(f.class)}`,
    ...(f.reason !== undefined ? [`reason ${clean(f.reason)}`] : []),
    ...(f.status !== undefined ? [`HTTP ${f.status}`] : []),
    ...(f.retryAfterMs !== undefined ? [`retry after ${f.retryAfterMs} ms`] : []),
    ...(f.approval !== undefined ? [`approval ${clean(f.approval)}`] : []),
    `job ${clean(o.job)}`,
    ...(o.cached ? ["cached"] : []),
  ].join(", ");
  // The server's message is the model-facing line; it is printed as sent (control characters stripped, as for all daemon text).
  return { code: captureFailureExit(f), err: `${r.message !== null ? clean(r.message) : `capture failed (${clean(f.class)})`}\n${detail}` };
}

export function captureListRows(cs: readonly CaptureRecord[], clean: (s: string) => string, age: (ms: number) => string): string[][] {
  return [
    ["ID", "SOURCE", "STATUS", "TYPE", "AGE", "URL"],
    ...cs.map((c) => [
      clean(c.id),
      clean(c.predicate.source),
      String(c.predicate.fetch.status),
      clean(c.predicate.fetch.contentType ?? "-"),
      age(c.createdAt),
      clean(c.predicate.fetch.finalUrl),
    ]),
  ];
}
