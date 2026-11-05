import { createHash } from "node:crypto";
import type { AgentId } from "@pomtree/core";
import { CAPTURE_ARTIFACT_ROLES } from "@pomtree/core";

// Pure helpers for report naming, typing, and id derivation. No fs/socket coupling, so
// they are unit-testable on the host. `pomtree` deliberately does none of this client-side:
// the daemon is authoritative for the slug, media type, size, and hash.

// A report name is a slug: 1-64 chars over [A-Za-z0-9._-], with no leading dot (so `.` and
// `..` and hidden names can never collide with store-internal names or escape a directory).
//
// One exception, the capture worker's artifacts: a name under the `capture/` prefix is `capture/<job>/<role>` (CAPTURE_REPORT_RE)
// and is validated as it stands, never rewritten, so each role of a job keeps its own name and idempotency key.
export function slugifyReportName(name: string): string {
  if (typeof name !== "string") throw new Error("report name must be a string");
  if (name.startsWith(CAPTURE_PREFIX)) return captureReportName(name);
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, "-") // collapse runs of non-slug characters to one hyphen
    .replace(/^\.+/, "") // no leading dots
    .slice(0, 64); // cap length
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug) || slug === "." || slug === "..") {
    throw new Error(`report name slugifies to nothing: ${JSON.stringify(name)}`);
  }
  return slug;
}

const CAPTURE_PREFIX = "capture/";
const CAPTURE_JOB_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// The longest capture artifact name: "capture/" + a 128-character job + "/" + the longest role.
export const CAPTURE_REPORT_NAME_MAX = CAPTURE_PREFIX.length + 128 + 1 + Math.max(...CAPTURE_ARTIFACT_ROLES.map((r) => r.length));

// A `capture/<job>/<role>` name, checked segment by segment; the refusal names the cause and the fix.
function captureReportName(name: string): string {
  const fix = `name a capture artifact capture/<job>/<role>, with <job> matching ${CAPTURE_JOB_RE} and <role> one of ${CAPTURE_ARTIFACT_ROLES.join(", ")}`;
  if (name.length > CAPTURE_REPORT_NAME_MAX) throw new Error(`capture report name is ${name.length} characters, over ${CAPTURE_REPORT_NAME_MAX}: ${fix}`);
  const segs = name.slice(CAPTURE_PREFIX.length).split("/");
  if (segs.some((x) => x === "")) throw new Error(`capture report name ${JSON.stringify(name)} has an empty segment: ${fix}`);
  if (segs.some((x) => x === "." || x === "..")) throw new Error(`capture report name ${JSON.stringify(name)} has a "." or ".." segment: ${fix}`);
  if (segs.length !== 2) throw new Error(`capture report name ${JSON.stringify(name)} has ${segs.length} segments after capture/, not 2: ${fix}`);
  const [job, role] = segs as [string, string];
  if (!CAPTURE_JOB_RE.test(job)) throw new Error(`capture report name ${JSON.stringify(name)} has an invalid job id: ${fix}`);
  if (!(CAPTURE_ARTIFACT_ROLES as readonly string[]).includes(role))
    throw new Error(`capture report name ${JSON.stringify(name)} has an unknown role ${JSON.stringify(role)}: ${fix}`);
  return name;
}

// Extension -> media type allowlist. The default for a name with no extension is text/plain;
// any explicit extension outside this list is rejected so agents cannot smuggle arbitrary
// types through the publish path.
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown",
  html: "text/html",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

export function inferMediaType(name: string): string {
  const ext = extensionOf(name);
  if (!ext) return "text/plain";
  const mediaType = EXTENSION_MEDIA_TYPES[ext];
  if (!mediaType) throw new Error(`unsupported report extension: .${ext}`);
  return mediaType;
}

const ALLOWED_MEDIA_TYPES = new Set<string>(["text/plain", ...new Set(Object.values(EXTENSION_MEDIA_TYPES))]);

// An explicitly-supplied media type must also be on the allowlist; the caller can override
// the inferred type but not invent one. application/zip is allowed only for a capture WACZ (`capture/<job>/wacz`), so `name`
// (the slug) decides it; without a name it is refused.
export function isAllowedMediaType(mediaType: string, name?: string): boolean {
  if (mediaType === "application/zip") return name !== undefined && name.startsWith(CAPTURE_PREFIX) && name.endsWith("/wacz");
  return ALLOWED_MEDIA_TYPES.has(mediaType);
}

export function sha256hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// Deterministic id: a retried publish of the same (agent, name, key) finds
// its original without a key lookup, and cross-agent keys never collide.
export function reportIdFor(agent: AgentId, name: string, key: string): string {
  return createHash("sha256").update(`${agent}\0${name}\0${key}`).digest("hex");
}
