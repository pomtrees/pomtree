// Provisional local mirror of the capture broker's record shapes, so the model-free capture worker
// can build against them before S1 lands the real ones in packages/core.

// `dom` and `navigation` go beyond the doc's list: they carry the rendered DOM and the navigation log that the browser capture already publishes as companion evidence.
export const CAPTURE_ARTIFACT_ROLES = ["wacz", "raw", "dom", "text", "screenshot", "navigation", "robots"] as const;
export type CaptureArtifactRole = (typeof CAPTURE_ARTIFACT_ROLES)[number];

// TODO(capture-broker): adopt core types from S1; until then these are copies, so a drift between them and core is a bug to delete, not to reconcile.
export interface FetchMeta {
  requestedUrl: string;
  finalUrl: string;
  redirects: { url: string; status: number }[];
  status: number;
  contentType: string | null;
  headers: Record<string, string>;
  fetchedAt: number;
  userAgent: string;
}

export interface WorkerArtifact {
  role: CaptureArtifactRole;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  report: { id: string };
}

export interface CaptureWorkerReceipt {
  job: string;
  worker: string;
  generation: number;
  mode: "browser";
  captureMethod: "cdp";
  fetch: FetchMeta;
  artifacts: WorkerArtifact[];
}

// An allowlist, not a denylist: anything not named (Set-Cookie, proxy headers) is dropped.
export const FETCH_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "content-length",
  "content-language",
  "content-encoding",
  "last-modified",
  "etag",
  "cache-control",
  "expires",
  "date",
  "location",
  "retry-after",
  "x-robots-tag",
  "link",
  "vary",
];

export function allowlistHeaders(h: [string, string][] | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, value] of Array.isArray(h) ? h : Object.entries(h)) {
    const k = name.toLowerCase();
    if (!FETCH_HEADER_ALLOWLIST.includes(k)) continue;
    out[k] = k in out ? `${out[k]}, ${value}` : value;
  }
  return { ...out };
}
