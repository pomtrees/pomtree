// The capture broker's pure contract: closed vocabularies, records, outcomes and
// failures, the cache key and freshness rules, the RFC 9309 robots.txt evaluator, the Wayback availability reader, and the
// Table 1 messages. Pure: no fs, no network, no clock except where a caller may pass `now`. The storage port (CaptureIndex) and
// the parser port (CaptureParser) live in ports.ts; the journal kinds in kinds.ts.
import { createHash } from "node:crypto";
import { canonical } from "./template.ts";
import type { AgentId, ApprovalId, HostId, ReportId, SandboxId } from "./types.ts";

// ---- 4.1 Closed vocabularies and requests ---------------------------------------------------------------------------------

export const CAPTURE_ROLES = ["request", "capture", "view", "approve"] as const;
export type CaptureRole = (typeof CAPTURE_ROLES)[number];

export const FRESHNESS_CLASSES = ["immutable", "stable", "daily", "live"] as const; // section 7
export type FreshnessClass = (typeof FRESHNESS_CLASSES)[number];

export const ACQUISITION_SOURCES = ["cache", "api", "static", "browser", "wayback"] as const;
export type AcquisitionSource = (typeof ACQUISITION_SOURCES)[number];

export const CAPTURE_RENDERS = ["auto", "static", "browser"] as const;
export type CaptureRender = (typeof CAPTURE_RENDERS)[number];
// The render a cache key and a job carry: `auto` is resolved to one of these before the key is computed.
export type CaptureKeyRender = Exclude<CaptureRender, "auto">;

// The steps a job journals (CaptureStep): one per acquisition rung, plus the robots.txt fetch that precedes an origin dial.
export const CAPTURE_RUNGS = ["api", "robots", "static", "browser", "wayback"] as const;
export type CaptureRung = (typeof CAPTURE_RUNGS)[number];

export type CaptureId = string; // "cap-" + sha256 hex of the statement's canonical JSON (captureIdOf)
export type CaptureJobId = string; // "cj-" + sha256(cacheKey \0 createdAt) (captureJobIdOf); concurrent identical requests join it

export const CAPTURE_PURPOSE_MAX = 200;
export const CAPTURE_URL_MAX = 8192;

export interface CaptureRequest {
  url: string; // http or https, public host; the broker canonicalizes it (canonicalCaptureUrl)
  render?: CaptureRender; // default "auto"
  maxAgeMs?: number; // may only tighten the URL's freshness class, never loosen it
  purpose: string; // at most CAPTURE_PURPOSE_MAX characters, journaled, never sent upstream
}

// The reason a CaptureRequest is malformed, or null. Shape only: the URL's own rules are canonicalCaptureUrl's.
export function captureRequestProblem(r: unknown): string | null {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return "request must be an object {url, purpose, render?, maxAgeMs?}";
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["url", "render", "maxAgeMs", "purpose"].includes(k)) return `unknown request field ${JSON.stringify(k)}`;
  if (typeof o.url !== "string" || o.url === "") return "url must be a non-empty string";
  if (o.url.length > CAPTURE_URL_MAX) return `url is longer than ${CAPTURE_URL_MAX} characters`;
  if (o.render !== undefined && !(CAPTURE_RENDERS as readonly unknown[]).includes(o.render)) return `render must be one of ${CAPTURE_RENDERS.join(", ")}`;
  if (o.maxAgeMs !== undefined && (typeof o.maxAgeMs !== "number" || !Number.isSafeInteger(o.maxAgeMs) || o.maxAgeMs < 0))
    return "maxAgeMs must be a non-negative integer";
  if (typeof o.purpose !== "string" || o.purpose.trim() === "") return "purpose must be a non-empty string";
  if (o.purpose.length > CAPTURE_PURPOSE_MAX) return `purpose is longer than ${CAPTURE_PURPOSE_MAX} characters`;
  return null;
}

// ---- 4.2 Records and artifacts --------------------------------------------------------------------------------------------

export const CAPTURE_ARTIFACT_ROLES = ["wacz", "raw", "text", "screenshot", "robots"] as const;
export type CaptureArtifactRole = (typeof CAPTURE_ARTIFACT_ROLES)[number];

export interface CaptureArtifact {
  role: CaptureArtifactRole;
  mediaType: string;
  sizeBytes: number;
  sha256: string; // the address; verified by the broker on receipt, never trusted from the producer
  report: { agent: AgentId; id: ReportId }; // where ReportStore holds the bytes
}

// What the origin said, for every rung. WorkflowFetchResult (extension.ts) picks the same fields, so workflows and the broker share
// one shape.
export interface FetchMeta {
  requestedUrl: string;
  finalUrl: string;
  redirects: { url: string; status: number }[]; // every hop, in order, each re-checked against robots and the SSRF guard
  status: number;
  contentType: string | null;
  headers: Record<string, string>; // response headers on FETCH_HEADER_ALLOWLIST only (allowlistHeaders)
  fetchedAt: number;
  userAgent: string; // exactly what was sent
}

export interface RobotsEvidence {
  url: string; // the robots.txt that governed finalUrl's origin
  sha256: string | null; // null when it was absent (4xx: allow all, per RFC 9309)
  status: number;
  tokens: string[]; // the product tokens evaluated: ours and Claude-User (decision C3; robotsTokens)
  // unreachable (5xx, timeout, network): the origin is not dialed (RFC 9309 treats it as disallow), but the job settles as
  // `network`/`robots_unreachable`, not `blocked`, because it says nothing about the publisher's wishes (section 5).
  verdict: "allow" | "disallow" | "unreachable";
  rule: string | null; // the matched rule, e.g. "Disallow: /feed", clipped to ROBOTS_RULE_MAX characters
  fetchedAt: number;
}

export interface CaptureWorkerRef {
  agent: AgentId;
  generation: number;
  host: HostId;
  sandbox: SandboxId;
  imageDigest: string;
  egressChainHead: string | null; // null when pomtreed dialed (official API)
}

// The in-toto predicate. Requester-neutral: who asked is journaled, not signed, so one cached capture serves every requester.
export interface CapturePredicate {
  key: string; // cache key (captureCacheKey)
  source: Exclude<AcquisitionSource, "cache">;
  acquirer: string; // "edgar", "static", "browser", "wayback", ...
  freshness: FreshnessClass;
  fetch: FetchMeta;
  robots: RobotsEvidence | null; // null only for an official-API acquirer that declares its own terms
  archivedAt?: number; // the Wayback snapshot time; fetch.fetchedAt is when we read it
  revalidatedFrom?: CaptureId; // a 304 revalidation: the capture whose artifacts this one reuses (section 7)
  worker: CaptureWorkerRef; // the worker that parsed the body
  controller: { host: HostId; pomtreedVersion: string };
}

export interface CaptureRecord {
  id: CaptureId;
  predicate: CapturePredicate;
  artifacts: CaptureArtifact[];
  envelope: CaptureArtifact | null; // the signed DSSE envelope as a report (S3); null before S3
  timestamp: CaptureArtifact | null; // the RFC 3161 token as a report; null when no TSA is configured or it failed
  createdAt: number;
}

// ---- 4.3 Outcomes and failures --------------------------------------------------------------------------------------------

export const CAPTURE_FAILURE_CLASSES = [
  "invalid_request",
  "forbidden",
  "pending_approval",
  "denied",
  "quota",
  "blocked",
  "rate_limited",
  "not_found",
  "upstream_error",
  "timeout",
  "network",
  "too_large",
  "unsupported_type",
  "capture_failed",
  "unavailable",
] as const; // section 6 defines each
export type CaptureFailureClass = (typeof CAPTURE_FAILURE_CLASSES)[number];

// The closed reasons per class (CaptureFailure.reason). capture_failed carries a BROWSER_FAILURE_CAUSES token (agent-image), which
// is open here because agent-image cannot import core.
export const BLOCK_REASONS = ["robots", "challenge", "refused", "policy"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];
export const NETWORK_REASONS = ["dns", "tls", "robots_unreachable", "egress_denied"] as const;
export type NetworkReason = (typeof NETWORK_REASONS)[number];
export const UPSTREAM_REASONS = ["http", "reset", "malformed"] as const;
export type UpstreamReason = (typeof UPSTREAM_REASONS)[number];
export const TIMEOUT_PHASES = ["connect", "first_byte", "total"] as const;
export type TimeoutPhase = (typeof TIMEOUT_PHASES)[number];
export const QUOTA_REASONS = ["requests", "queue"] as const;
export const UNAVAILABLE_REASONS = ["index", "signer"] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface CaptureFailure {
  class: CaptureFailureClass;
  reason?: string; // closed per class: see the *_REASONS lists above
  status?: number;
  retryAfterMs?: number;
  rule?: string; // blocked/robots only: the matched rule, clipped and stripped of control characters
  approval?: ApprovalId; // pending_approval and denied
  retryable: boolean; // derived from the class (captureRetryable), never set by an acquirer
  fallbackTried: boolean; // whether Wayback ran
}

export type CaptureOutcome =
  | { state: "ok"; capture: CaptureRecord; servedFrom: AcquisitionSource; ageMs: number }
  | { state: "pending"; job: CaptureJobId } // the wait window ended; retry with the same idempotency key converges
  | { state: "failed"; job: CaptureJobId; failure: CaptureFailure; cached: boolean }; // cached: served from the negative cache

// A failure with `retryable` derived from its class and reason, so no caller sets it by hand.
export function captureFailure(f: Omit<CaptureFailure, "retryable" | "fallbackTried"> & { fallbackTried?: boolean }): CaptureFailure {
  return { ...f, retryable: captureRetryable(f.class, f.reason), fallbackTried: f.fallbackTried ?? false };
}

// Table 1's "Retry" column.
export function captureRetryable(cls: CaptureFailureClass, reason?: string): boolean {
  switch (cls) {
    case "pending_approval":
    case "quota":
    case "rate_limited":
    case "upstream_error":
    case "timeout":
    case "capture_failed":
      return true;
    case "network":
      return reason !== "egress_denied";
    default:
      return false;
  }
}

// Table 1's "Wayback" column (decision C2): only after a failure that says nothing about the publisher's wishes. Never after
// blocked or rate_limited, and never for egress_denied (our own policy refused the host).
export function waybackEligible(f: Pick<CaptureFailure, "class" | "reason">): boolean {
  switch (f.class) {
    case "not_found":
    case "upstream_error":
    case "timeout":
    case "capture_failed":
      return true;
    case "network":
      return f.reason !== "egress_denied";
    default:
      return false;
  }
}

// Section 6: the broker itself retries these once before it settles; rate_limited and quota never retry inside the request.
export function brokerRetriesOnce(f: Pick<CaptureFailure, "class" | "reason">): boolean {
  switch (f.class) {
    case "upstream_error":
    case "timeout":
    case "capture_failed":
      return true;
    case "network":
      return f.reason !== "egress_denied"; // dns, tls, robots_unreachable
    default:
      return false;
  }
}

export const ROBOTS_CACHE_MAX_MS = 24 * 3_600_000; // RFC 9309 section 2.4: a robots.txt is cached for at most 24 hours
export const RATE_LIMIT_DEFAULT_MS = 60_000; // a 429 with no usable Retry-After
export const RETRY_AFTER_MAX_MS = 24 * 3_600_000; // a Retry-After is honoured up to a day, never longer

// How long the negative cache holds a failure (section 6); 0 means it is not cached. Requester-specific failures (invalid_request,
// forbidden, approvals, quota) and per-capture ones (too_large, unsupported_type, unavailable) are never cached: the cache is
// shared, and those say nothing about the URL for another requester. blocked/policy is re-evaluated against the live denylist.
export function negativeTtlMs(f: Pick<CaptureFailure, "class" | "reason" | "retryAfterMs">, robotsTtlMs: number = ROBOTS_CACHE_MAX_MS): number {
  switch (f.class) {
    case "upstream_error":
    case "timeout":
    case "network":
    case "capture_failed":
      return 5 * 60_000;
    case "not_found":
      return 3_600_000;
    case "rate_limited":
      return Math.min(f.retryAfterMs ?? RATE_LIMIT_DEFAULT_MS, RETRY_AFTER_MAX_MS);
    case "blocked":
      if (f.reason === "robots") return Math.max(0, Math.min(robotsTtlMs, ROBOTS_CACHE_MAX_MS));
      if (f.reason === "challenge" || f.reason === "refused") return 6 * 3_600_000;
      return 0;
    default:
      return 0;
  }
}

// ---- Responses: allowlisted headers, challenge markers, HTTP status classes -------------------------------------------------

// The response headers FetchMeta keeps (section 4.2). An allowlist: anything not named is dropped, including Set-Cookie and every
// proxy or CDN header that could identify the operator.
export const FETCH_HEADER_ALLOWLIST = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "cache-control",
  "expires",
  "age",
  "date",
  "etag",
  "last-modified",
  "retry-after",
  "location",
  "x-robots-tag",
  "cf-mitigated",
  "x-amzn-waf-action",
] as const;
export const FETCH_HEADER_VALUE_MAX = 1024;

export type HeaderInput = Iterable<readonly [string, string]> | Readonly<Record<string, string | readonly string[] | undefined>>;

// Lowercased, allowlisted, control characters replaced, values clipped to FETCH_HEADER_VALUE_MAX; repeated headers joined by ", ".
export function allowlistHeaders(h: HeaderInput): Record<string, string> {
  const allowed: readonly string[] = FETCH_HEADER_ALLOWLIST;
  const out: Record<string, string> = {};
  const entries: Iterable<readonly [string, unknown]> = Symbol.iterator in h ? (h as Iterable<readonly [string, string]>) : Object.entries(h);
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!allowed.includes(name) || rawValue === undefined) continue;
    const value = (Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue)).replace(CONTROL_RE, " ");
    const joined = out[name] === undefined ? value : `${out[name]}, ${value}`;
    out[name] = joined.slice(0, FETCH_HEADER_VALUE_MAX);
  }
  return out;
}

const headerOf = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
};

// A bot-challenge marker in the response headers, as "<header>: <value>", or null. S1 reads headers only, because pomtreed never
// reads a body (decision C9). `status` is accepted for the S2 body rule and is not consulted yet.
// TODO(capture-broker): S2 body-marker detection (botChallengeMarker) runs in the worker
export function challengeMarkerOf(_status: number, headers: Readonly<Record<string, string>>): string | null {
  const cf = headerOf(headers, "cf-mitigated")?.trim().toLowerCase();
  if (cf === "challenge") return "cf-mitigated: challenge";
  const waf = headerOf(headers, "x-amzn-waf-action")?.trim().toLowerCase();
  if (waf === "challenge" || waf === "captcha") return `x-amzn-waf-action: ${waf}`;
  return null;
}

// Retry-After as milliseconds from `now`: delta-seconds or an HTTP-date (RFC 9110 10.2.3), capped at RETRY_AFTER_MAX_MS; null when
// absent or unparseable.
export function retryAfterMsOf(value: string | undefined, now: number = Date.now()): number | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Math.min(Number(v) * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(v);
  if (!Number.isFinite(at) || !/[a-z]/i.test(v)) return null;
  return Math.min(Math.max(0, at - now), RETRY_AFTER_MAX_MS);
}

export type HttpFailure = Pick<CaptureFailure, "class" | "reason" | "status" | "retryAfterMs">;

// The Table 1 class of an origin's final HTTP response, or null when it is a success (2xx, or 304 for a revalidation). A challenge
// marker wins over the status. 401/403/451 blocked/refused; 429 rate_limited (Retry-After, else RATE_LIMIT_DEFAULT_MS); 503 with a
// usable Retry-After rate_limited, without one upstream_error; 404/410 not_found; other 5xx upstream_error. Other 4xx, and a 1xx or
// 3xx that reached here (a redirect the caller did not follow), are upstream_error too: Table 1 names no class for them, and they
// say nothing about the publisher's wishes.
export function classifyHttpStatus(status: number, headers: Readonly<Record<string, string>>, now: number = Date.now()): HttpFailure | null {
  if (challengeMarkerOf(status, headers) !== null) return { class: "blocked", reason: "challenge", status };
  if ((status >= 200 && status < 300) || status === 304) return null;
  if (status === 401 || status === 403 || status === 451) return { class: "blocked", reason: "refused", status };
  const retryAfter = retryAfterMsOf(headerOf(headers, "retry-after"), now);
  if (status === 429) return { class: "rate_limited", status, retryAfterMs: retryAfter ?? RATE_LIMIT_DEFAULT_MS };
  if (status === 503 && retryAfter !== null) return { class: "rate_limited", status, retryAfterMs: retryAfter };
  if (status === 404 || status === 410) return { class: "not_found", status };
  return { class: "upstream_error", reason: status >= 100 && status <= 599 ? "http" : "malformed", status };
}

// ---- Section 7: canonical URLs and cache keys -----------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point (they are removed)
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// `s` without C0/C1 control characters: the one sanitizer for capture text that reaches a model, an operator or the journal.
export const stripControl = (s: string): string => s.replace(CONTROL_RE, "");
const TRACKING_PARAM_RE = /^(?:utm_[^=]*|gclid|fbclid)$/i;

// The canonical form of a capture URL (section 7), or why it is refused (Table 1 invalid_request). Lowercases the scheme and host,
// converts the host to punycode, drops a default port and the fragment, upper-cases percent-escapes, and removes utm_*, gclid and
// fbclid query parameters, keeping every other parameter in its original order. Refused: anything but http and https, userinfo,
// a non-default port, an IP literal in a private or reserved range (ipAddressProblem), and localhost (RFC 6761). Hostnames are
// not resolved here: the SSRF guard checks resolved addresses at dial time.
export function canonicalCaptureUrl(raw: string): { url: string } | { problem: string } {
  if (raw.length > CAPTURE_URL_MAX) return { problem: `longer than ${CAPTURE_URL_MAX} characters` };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { problem: "not a parseable URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { problem: `scheme ${u.protocol.replace(/:$/, "")} is not http or https` };
  if (u.username !== "" || u.password !== "") return { problem: "userinfo present" };
  if (u.port !== "") return { problem: `non-default port ${u.port}` };
  const host = u.hostname;
  if (host === "") return { problem: "no host" };
  const ip = ipAddressProblem(host);
  if (ip !== null) return { problem: ip };
  const bare = host.replace(/\.$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) return { problem: "localhost is not a public host" };
  const upper = (s: string) => s.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
  const query = u.search === "" ? [] : u.search.slice(1).split("&");
  const kept = query.filter((p) => p !== "" && !TRACKING_PARAM_RE.test(decodeOr(p.split("=", 1)[0] as string)));
  const search = kept.length === 0 ? "" : `?${kept.map(upper).join("&")}`;
  return { url: `${u.protocol}//${host}${upper(u.pathname)}${search}` };
}

const decodeOr = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Why an IP-literal host is not a public address, or null (also null for a hostname that is not an IP literal). `host` is a URL
// hostname: dotted IPv4 (the WHATWG parser already normalized hex and short forms) or bracketed IPv6. Ranges: the IANA special-
// purpose registries for IPv4 and IPv6, and for IPv6 anything outside global unicast 2000::/3. IPv4-mapped IPv6 is judged by its
// embedded IPv4 address. No core address classifier existed before this one.
export function ipAddressProblem(host: string): string | null {
  const v4 = parseIpv4(host);
  if (v4 !== null) return ipv4Reserved(v4) ? `private or reserved address ${host}` : null;
  if (!host.startsWith("[")) return null;
  const v6 = parseIpv6(host.slice(1, -1));
  if (v6 === null) return `unparseable IPv6 address ${host}`;
  const isZero = (from: number, to: number) => v6.slice(from, to).every((x) => x === 0);
  if (isZero(0, 5) && v6[5] === 0xffff) {
    const a = ((v6[6] as number) << 16) | (v6[7] as number);
    return ipv4Reserved(a >>> 0) ? `private or reserved address ${host}` : null;
  }
  const w0 = v6[0] as number;
  const w1 = v6[1] as number;
  const reserved =
    (w0 & 0xe000) !== 0x2000 || // outside 2000::/3: ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96, 100::/64 and the rest
    (w0 === 0x2001 && w1 < 0x0200) || // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking)
    (w0 === 0x2001 && w1 === 0x0db8) || // 2001:db8::/32 documentation
    w0 === 0x2002 || // 2002::/16 6to4
    (w0 === 0x3fff && w1 < 0x1000); // 3fff::/20 documentation (RFC 9637)
  return reserved ? `private or reserved address ${host}` : null;
}

function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return (((parts[0] as number) << 24) | ((parts[1] as number) << 16) | ((parts[2] as number) << 8) | (parts[3] as number)) >>> 0;
}

const IPV4_RESERVED: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4Reserved(a: number): boolean {
  return IPV4_RESERVED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) >>> 0 === ((parseIpv4(base) as number) & mask) >>> 0;
  });
}

function parseIpv6(s: string): number[] | null {
  if (s.includes("%")) return null; // a zone id never names a public address
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const groups = part.split(":");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as string;
      if (i === groups.length - 1 && g.includes(".")) {
        const v4 = parseIpv4(g);
        if (v4 === null) return null;
        out.push(v4 >>> 16, v4 & 0xffff);
      } else if (/^[0-9a-f]{1,4}$/i.test(g)) out.push(Number.parseInt(g, 16));
      else return null;
    }
    return out;
  };
  const head = words(halves[0] as string);
  const tail = halves.length === 2 ? words(halves[1] as string) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

// The cache key (section 7): sha256 hex of the canonical JSON of the four fields. `resource` is the acquirer's resource id, or the
// canonical URL for acquirer "web".
export function captureCacheKey(k: { acquirer: string; resource: string; render: CaptureKeyRender; userAgentId: string }): string {
  return sha256Hex(JSON.stringify(canonical({ acquirer: k.acquirer, resource: k.resource, render: k.render, userAgentId: k.userAgentId })));
}

export const USER_AGENT_ID_HEX = 16;
// A short digest of the configured User-Agent, so a change of identity does not reuse captures taken under the old one.
export function userAgentIdOf(ua: string): string {
  return sha256Hex(ua).slice(0, USER_AGENT_ID_HEX);
}

// The job id of a job created for `cacheKey` at `createdAt` (CaptureIndex.begin).
export function captureJobIdOf(cacheKey: string, createdAt: number): CaptureJobId {
  return `cj-${sha256Hex(`${cacheKey}\0${createdAt}`)}`;
}

// The User-Agent's product token: its leading RFC 9110 token, without a "/version". Null when it does not start with one.
const PRODUCT_RE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:\/[\x21-\x7e]+)?(?:\s|$)/;
export function productTokenOf(ua: string): string | null {
  const m = PRODUCT_RE.exec(ua);
  return m === null ? null : (m[1] as string);
}

// ---- RFC 9309 robots.txt ---------------------------------------------------------------------------------------------------

export const ROBOTS_TOKENS_FIXED = ["Claude-User"] as const; // decision C3; ClaudeBot and anthropic-ai are deliberately absent
export const ROBOTS_PARSE_LIMIT_BYTES = 500 * 1024; // RFC 9309 section 2.5: parse at least the first 500 KiB
export const ROBOTS_RULE_MAX = 100;

// The product tokens a robots.txt is evaluated for (decision C3): ours (the User-Agent's product token) and Claude-User.
export function robotsTokens(ua: string): string[] {
  const ours = productTokenOf(ua);
  const out = ours === null ? [] : [ours];
  for (const t of ROBOTS_TOKENS_FIXED) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

// What to do with a robots.txt fetch's final status (RFC 9309 section 2.3.1): 2xx parse it; 4xx allow all (the evidence sha256 is
// null); 5xx and anything else (including a 3xx left after the redirect limit) unreachable, so the origin is not dialed.
export function robotsFetchVerdict(status: number): "parse" | "allow_all" | "unreachable" {
  if (status >= 200 && status < 300) return "parse";
  if (status >= 400 && status < 500) return "allow_all";
  return "unreachable";
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}
interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

function parseRobots(doc: string): RobotsGroup[] {
  const bytes = Buffer.from(doc, "utf8");
  const text = bytes.length > ROBOTS_PARSE_LIMIT_BYTES ? bytes.subarray(0, ROBOTS_PARSE_LIMIT_BYTES).toString("utf8") : doc;
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let inAgents = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = (rawLine.split("#", 1)[0] as string).trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!inAgents || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
        inAgents = true;
      }
      // Match on the product token only (letters, "_" and "-"), so "Foo/1.0" names Foo.
      const token = /^[A-Za-z_*-]+/.exec(value)?.[0];
      if (token !== undefined) current.agents.push(token.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inAgents = false;
      if (current === null || value === "") continue; // a rule before any group, or an empty path, matches nothing
      current.rules.push({ allow: key === "allow", pattern: normalizeOctets(value) });
    }
    // Other records (sitemap, crawl-delay, ...) are ignored and do not end a group.
  }
  return groups;
}

// Percent-encode non-ASCII and upper-case existing escapes, so a rule and a path compare as the same octets (RFC 9309 2.2.2).
function normalizeOctets(s: string): string {
  let out = "";
  for (const ch of s) out += ch.charCodeAt(0) > 0x7e || ch.charCodeAt(0) < 0x21 ? encodeURIComponent(ch) : ch;
  return out.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

// Whether `pattern` (with "*" any run and a trailing "$" end anchor) matches a prefix of `path`, or all of it when anchored.
// A linear-backtracking glob match, so a hostile pattern cannot cause exponential work.
function robotsMatch(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : `${pattern}*`;
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < path.length) {
    if (i < p.length && p[i] !== "*" && p[i] === path[j]) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star !== -1) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

const clipRule = (r: RobotsRule): string => `${r.allow ? "Allow" : "Disallow"}: ${r.pattern}`.replace(CONTROL_RE, "").slice(0, ROBOTS_RULE_MAX);

function verdictFor(groups: RobotsGroup[], token: string, path: string): { allow: boolean; rule: RobotsRule | null } {
  const t = token.toLowerCase();
  let chosen = groups.filter((g) => g.agents.includes(t));
  if (chosen.length === 0) chosen = groups.filter((g) => g.agents.includes("*"));
  let best: RobotsRule | null = null;
  for (const g of chosen)
    for (const r of g.rules) {
      if (!robotsMatch(r.pattern, path)) continue;
      if (best === null || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
    }
  return { allow: best === null || best.allow, rule: best };
}

// RFC 9309 evaluation for `path` (the URL's path plus its query) under each of `tokens`; the strictest wins. Groups match a
// product token case-insensitively; the "*" group applies to a token only when no group names it; matching groups combine; the
// longest matching rule wins and Allow wins a tie; "*" and a trailing "$" are supported; only the first ROBOTS_PARSE_LIMIT_BYTES
// are parsed; /robots.txt itself is always allowed. Any token's disallow is a disallow, reported with that rule (clipped to
// ROBOTS_RULE_MAX characters, control characters removed). A group naming only ClaudeBot binds neither token.
export function robotsVerdict(doc: string, tokens: readonly string[], path: string): Pick<RobotsEvidence, "verdict" | "rule"> {
  const p = normalizeOctets(path === "" ? "/" : path);
  if (p === "/robots.txt") return { verdict: "allow", rule: null };
  const groups = parseRobots(doc);
  let allowRule: string | null = null;
  for (const token of tokens) {
    const v = verdictFor(groups, token, p);
    if (!v.allow) return { verdict: "disallow", rule: v.rule === null ? null : clipRule(v.rule) };
    if (allowRule === null && v.rule !== null) allowRule = clipRule(v.rule);
  }
  return { verdict: "allow", rule: allowRule };
}

// ---- Wayback availability (read-only; Save Page Now is never used, decision C2) ---------------------------------------------

export const WAYBACK_AVAILABILITY_URL = "https://archive.org/wayback/available";
export const WAYBACK_ANSWER_MAX_BYTES = 64 * 1024;

// "YYYYMMDDhhmmss" (UTC) for `at`, the timestamp form the Wayback Machine uses.
export function waybackTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// The availability query for the snapshot of `url` closest to `at`.
export function waybackAvailabilityUrl(url: string, at: number): string {
  return `${WAYBACK_AVAILABILITY_URL}?url=${encodeURIComponent(url)}&timestamp=${waybackTimestamp(at)}`;
}

// The raw (unrewritten) snapshot: the `id_` form serves the archived bytes without the Wayback toolbar or link rewriting.
export function waybackSnapshotRawUrl(timestamp: string, url: string): string {
  if (!/^\d{14}$/.test(timestamp)) throw new Error(`wayback timestamp must be 14 digits, got ${JSON.stringify(timestamp)}`);
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

// The closest available snapshot in an /wayback/available answer: the archived URL, its 14-digit timestamp and that time in ms.
// Null for anything else: no snapshot, unavailable, a non-200 snapshot, an answer over WAYBACK_ANSWER_MAX_BYTES, malformed JSON
// or fields. Never throws.
export function parseWaybackAvailability(text: string): { url: string; timestamp: string; archivedAt: number } | null {
  try {
    if (typeof text !== "string" || text.length > WAYBACK_ANSWER_MAX_BYTES) return null;
    const doc: unknown = JSON.parse(text);
    const closest = (doc as { archived_snapshots?: { closest?: unknown } } | null)?.archived_snapshots?.closest;
    if (typeof closest !== "object" || closest === null) return null;
    const c = closest as Record<string, unknown>;
    if (c.available !== true) return null;
    if (c.status !== undefined && String(c.status) !== "200") return null;
    const ts = c.timestamp;
    if (typeof ts !== "string" || !/^\d{14}$/.test(ts)) return null;
    const archivedAt = Date.UTC(
      Number(ts.slice(0, 4)),
      Number(ts.slice(4, 6)) - 1,
      Number(ts.slice(6, 8)),
      Number(ts.slice(8, 10)),
      Number(ts.slice(10, 12)),
      Number(ts.slice(12, 14)),
    );
    if (!Number.isFinite(archivedAt) || waybackTimestamp(archivedAt) !== ts) return null;
    // The snapshot URL is web.archive.org/web/<ts>/<original>; fall back to the answer's own url field.
    const snap = typeof c.url === "string" ? c.url : "";
    const marker = `/web/${ts}/`;
    const at = snap.indexOf(marker);
    const original = at >= 0 ? snap.slice(at + marker.length) : (doc as { url?: unknown }).url;
    if (typeof original !== "string" || !/^https?:\/\//i.test(original) || original.length > CAPTURE_URL_MAX) return null;
    return { url: original, timestamp: ts, archivedAt };
  } catch {
    return null;
  }
}

// ---- Section 7: freshness ---------------------------------------------------------------------------------------------------

export interface FreshnessConfig {
  stableMs: number;
  dailyMs: number;
  liveMs: number;
}
export interface FreshnessRule {
  host: string; // exact lowercase hostname
  pathPrefix: string; // starts with "/"
  class: FreshnessClass;
}

const RULE_HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{1,63}$/;

// Why a `capture.freshness.rules` value is refused, or null: a JSON array of {host, pathPrefix, class}.
export function freshnessRulesReason(v: unknown): string | null {
  if (!Array.isArray(v)) return 'must be a JSON array of {"host": "<hostname>", "pathPrefix": "/<path>", "class": "<freshness class>"}';
  for (const [i, r] of v.entries()) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) return `rule ${i} must be an object {host, pathPrefix, class}`;
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["host", "pathPrefix", "class"].includes(k)) return `rule ${i} has unknown field ${JSON.stringify(k)}`;
    if (typeof o.host !== "string" || !RULE_HOST_RE.test(o.host)) return `rule ${i} host must be a lowercase hostname such as www.sec.gov`;
    if (typeof o.pathPrefix !== "string" || !o.pathPrefix.startsWith("/")) return `rule ${i} pathPrefix must start with "/"`;
    if (!(FRESHNESS_CLASSES as readonly unknown[]).includes(o.class)) return `rule ${i} class must be one of ${FRESHNESS_CLASSES.join(", ")}`;
  }
  return null;
}

// The rules from a resolved `capture.freshness.rules` value; throws with freshnessRulesReason's reason when malformed.
export function parseFreshnessRules(v: unknown): FreshnessRule[] {
  const why = freshnessRulesReason(v);
  if (why !== null) throw new Error(`capture.freshness.rules ${why}`);
  return (v as FreshnessRule[]).map((r) => ({ host: r.host, pathPrefix: r.pathPrefix, class: r.class }));
}

// The URL's freshness class: the acquirer's, else the first operator rule whose host equals the URL's and whose prefix starts its
// path, else daily.
export function freshnessOf(url: string, acquirerClass: FreshnessClass | null, rules: readonly FreshnessRule[]): FreshnessClass {
  if (acquirerClass !== null) return acquirerClass;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "daily";
  }
  const path = `${u.pathname}${u.search}`;
  return rules.find((r) => r.host === u.hostname && path.startsWith(r.pathPrefix))?.class ?? "daily";
}

// The maximum age of a cached capture in the class; immutable is never refetched (Infinity).
export function maxAgeFor(cls: FreshnessClass, cfg: FreshnessConfig): number {
  return cls === "immutable" ? Number.POSITIVE_INFINITY : cls === "stable" ? cfg.stableMs : cls === "daily" ? cfg.dailyMs : cfg.liveMs;
}

const cacheDirectives = (cacheControl: string | null | undefined): Map<string, string | null> => {
  const out = new Map<string, string | null>();
  for (const part of (cacheControl ?? "").split(",")) {
    const [name, ...rest] = part.split("=");
    const n = (name as string).trim().toLowerCase();
    if (n !== "") out.set(n, rest.length === 0 ? null : rest.join("=").trim().replace(/^"|"$/g, ""));
  }
  return out;
};

// The age up to which a cached capture may be served: the class's max age, shortened (never lengthened) by the request's maxAgeMs
// and by the stored response's Cache-Control. no-cache gives 0; for a shared cache s-maxage takes precedence over max-age (RFC 9111
// 5.2.2.10); either only shortens.
export function effectiveMaxAgeMs(i: { class: FreshnessClass; cfg: FreshnessConfig; requestMaxAgeMs?: number; cacheControl?: string | null }): number {
  let age = maxAgeFor(i.class, i.cfg);
  if (i.requestMaxAgeMs !== undefined) age = Math.min(age, i.requestMaxAgeMs);
  const d = cacheDirectives(i.cacheControl);
  if (d.has("no-cache")) return 0;
  const secs = d.get("s-maxage") ?? d.get("max-age");
  if (secs !== undefined && secs !== null && /^\d+$/.test(secs)) age = Math.min(age, Number(secs) * 1000);
  return age;
}

// Whether a stored response may be served to another job from the shared cache: false on Cache-Control no-store or private
// (RFC 9111 3, 5.2.2.5, 5.2.2.7). Such a response is still archived as evidence for the job that fetched it.
export function cacheShareable(headers: Readonly<Record<string, string>>): boolean {
  const d = cacheDirectives(headerOf(headers, "cache-control"));
  return !d.has("no-store") && !d.has("private");
}

// The operator denylist entry `host` matches (equal to it, or a parent domain of it), or null.
export function denylistMatch(host: string, denylist: readonly string[]): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  return denylist.find((e) => h === e || h.endsWith(`.${e}`)) ?? null;
}

// Why a `capture.denylist` value is refused, or null: lowercase hostnames.
export function denylistReason(v: readonly string[]): string | null {
  const bad = v.find((e) => !RULE_HOST_RE.test(e));
  return bad === undefined ? null : `entry ${JSON.stringify(bad)} must be a lowercase hostname such as example.com (no scheme, port or path)`;
}

// ---- 4.5 The statement (unsigned until S3) -----------------------------------------------------------------------------------

export const CAPTURE_PREDICATE_TYPE = "https://pomtree.invalid/capture/v1"; // placeholder URI; the real one is fixed in S3
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

export interface CaptureStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: { name: string; digest: { sha256: string } }[]; // one per artifact, name = role + "/" + mediaType
  predicateType: typeof CAPTURE_PREDICATE_TYPE;
  predicate: CapturePredicate;
}

export function captureStatement(predicate: CapturePredicate, artifacts: readonly CaptureArtifact[]): CaptureStatement {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: artifacts.map((a) => ({ name: `${a.role}/${a.mediaType}`, digest: { sha256: a.sha256 } })),
    predicateType: CAPTURE_PREDICATE_TYPE,
    predicate: structuredClone(predicate),
  };
}

export function captureIdOf(statement: CaptureStatement): CaptureId {
  return `cap-${sha256Hex(JSON.stringify(canonical(statement)))}`;
}

// ---- Section 6: rendering and messages -----------------------------------------------------------------------------------

const clean = (s: string, max: number): string => s.replace(CONTROL_RE, "").slice(0, max);

// Table 1's `<u>`: host plus a path clipped to 80 characters, the query and fragment dropped, control characters removed.
export function renderCaptureUrl(url: string): string {
  try {
    const u = new URL(url);
    return clean(`${u.host}${clean(u.pathname, 80)}`, 400);
  } catch {
    return clean(url.split(/[?#]/, 1)[0] as string, 80);
  }
}

// Token-shaped path segments (op.<hex>, ag.<...>.<hex>, ht./ext., pg1.<payload>.<mac>) are masked, as pomtreed's access log masks them.
const TOKEN_SEG = /^(op|ag|ht|ext|pg1)\.[A-Za-z0-9._-]{16,}$/;

// A URL as an audit row shows it: scheme, host and path, the query and fragment dropped, token-shaped segments masked, whitespace
// replaced and the path clipped to 300 characters. The one definition for the capture journal kinds and workflow_fetch.
// TODO(capture-broker): pomtreed's auditUrl (workflow-capabilities.ts) and redactPath (accesslog.ts) should import these instead.
export function redactPath(url: string): string {
  const q = url.search(/[?#]/);
  const path = q === -1 ? url : url.slice(0, q);
  return path
    .split("/")
    .map((s) => (TOKEN_SEG.test(s) ? "[redacted]" : s))
    .join("/")
    .replace(/[\r\n\s]/g, "_")
    .slice(0, 300);
}
export function auditUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${redactPath(u.pathname)}`;
  } catch {
    return redactPath(raw);
  }
}

// What a message names. Every field is optional; an absent one renders as "?" (or the documented default). Strings are cleaned of
// control characters and clipped. Model text carries no page text except the clipped, quoted robots rule.
export interface CaptureMessageContext {
  job?: CaptureJobId;
  agent?: AgentId;
  generation?: number;
  template?: string;
  url?: string;
  host?: string;
  domain?: string; // the registrable domain a Retry-After pauses
  render?: string;
  lacks?: string; // forbidden: the role or render the agent lacks
  approval?: ApprovalId;
  decision?: "denied" | "timed out";
  used?: number;
  limit?: number;
  windowMs?: number;
  queueDepth?: number;
  status?: number;
  ms?: number;
  phase?: string;
  rung?: string;
  cap?: number;
  bytes?: number;
  key?: string; // the config key of a cap (too_large)
  type?: string; // the content type (unsupported_type)
  cause?: string; // capture_failed: a BROWSER_FAILURE_CAUSES token
  sandbox?: SandboxId;
  logs?: string; // the id `pomtree logs` takes
  robotsUrl?: string;
  robotsSha256?: string | null;
  tokens?: readonly string[];
  marker?: string; // challenge marker (challengeMarkerOf)
  screenshot?: ReportId;
  denylistEntry?: string;
  retryAfterMs?: number;
  pausedUntil?: number;
  hops?: number;
  errorClass?: string;
  egressRow?: string; // the egress audit row of a denied connection
  wayback?: "none" | "too old";
  problem?: string; // invalid_request: canonicalCaptureUrl's problem
  reason?: string; // overrides failure.reason in the text
  fix?: string; // unavailable: the config key or store to fix
}

const UNAVAILABLE_FIX: Readonly<Record<string, string>> = {
  index: "the capture index store",
  signer: "the capture signing key",
};

// A duration as the messages show it: whole hours, whole minutes, else seconds rounded up.
export function formatCaptureDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.ceil(ms / 1000)} s`;
}

const NETWORK_TEXT: Readonly<Record<string, string>> = {
  dns: "the host name did not resolve",
  tls: "TLS failed",
  robots_unreachable: "the site's robots.txt could not be read, so the site was not contacted",
  egress_denied: "the egress policy blocks this host",
};

// Both Table 1 messages for a failure. The model text is one line of fixed text with bounded fields, ending with what to do next;
// the operator text names the job, the agent, the rendered URL and the evidence.
export function captureMessages(f: CaptureFailure, ctx: CaptureMessageContext = {}): { model: string; operator: string } {
  const s = (v: string | undefined, max = 120): string => (v === undefined || v === "" ? "?" : clean(v, max));
  const n = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? "?" : String(v));
  const u = ctx.url === undefined ? "?" : renderCaptureUrl(ctx.url);
  const j = s(ctx.job, 80);
  const agent = s(ctx.agent, 80);
  const host = s(ctx.host ?? (ctx.url === undefined ? undefined : hostOf(ctx.url)), 253);
  const reason = ctx.reason ?? f.reason;
  const status = ctx.status ?? f.status;
  const approval = s(ctx.approval ?? f.approval, 80);
  const retryAfter = ctx.retryAfterMs ?? f.retryAfterMs;
  const t = retryAfter === undefined ? "?" : formatCaptureDuration(retryAfter);
  switch (f.class) {
    case "invalid_request":
      return {
        model: `capture refused: ${u} is not a public http(s) URL; fix the URL`,
        operator: `capture ${j} refused for ${agent}: invalid url (${s(ctx.problem ?? reason, 200)})`,
      };
    case "forbidden":
      return {
        model: `capture refused: this agent may not request ${s(ctx.render ?? "any", 20)} captures; ask your parent`,
        operator: `capture ${j}: ${agent} gen ${n(ctx.generation)} lacks ${s(ctx.lacks ?? ctx.render, 40)} (template ${s(ctx.template, 80)})`,
      };
    case "pending_approval":
      return {
        model: `capture of ${u} awaits approval ${approval}; retry with the same key or yield`,
        operator: `capture ${j}: approval ${approval} open for host ${host} requested by ${agent}`,
      };
    case "denied":
      return {
        model: `capture of ${u} denied (approval ${approval}); choose another source`,
        operator: `capture ${j}: approval ${approval} ${ctx.decision ?? "denied"} at rung ${s(ctx.rung, 20)}`,
      };
    case "quota":
      return {
        model: `capture quota exhausted (${n(ctx.used)}/${n(ctx.limit)} per ${ctx.windowMs === undefined ? "?" : formatCaptureDuration(ctx.windowMs)}); retry after ${t} or reuse a cached capture`,
        operator: `capture ${j}: ${agent} quota ${n(ctx.used)}/${n(ctx.limit)}; queue depth ${n(ctx.queueDepth ?? 0)}`,
      };
    case "blocked": {
      if (reason === "robots") {
        const rule = s(f.rule, ROBOTS_RULE_MAX).replace(/"/g, "'");
        return {
          model: `capture blocked: ${host} robots.txt disallows this path for our user agent ("${rule}"); do not retry or work around it; report the source as unavailable`,
          operator: `capture ${j} blocked by robots: ${s(ctx.robotsUrl, 300)} sha256 ${ctx.robotsSha256 ?? "none"} rule "${rule}" tokens ${(ctx.tokens ?? []).map((x) => clean(x, 40)).join(",") || "?"}`,
        };
      }
      if (reason === "challenge")
        return {
          model: `capture blocked: ${host} served a bot challenge; it is not solved or bypassed; report the source as unavailable`,
          operator: `capture ${j} blocked: challenge marker ${s(ctx.marker, 80)} at ${u}; screenshot report ${ctx.screenshot ?? "none"}`,
        };
      if (reason === "policy")
        return {
          model: `capture blocked by operator policy for ${host}; choose another source`,
          operator: `capture ${j}: ${host} matches denylist entry ${s(ctx.denylistEntry, 253)}`,
        };
      return {
        model: `capture blocked: ${host} refused the request (HTTP ${n(status)}); do not retry; report the source as unavailable`,
        operator: `capture ${j} blocked: HTTP ${n(status)} from ${u} after ${n(ctx.hops ?? 0)} hops`,
      };
    }
    case "rate_limited":
      return {
        model: `capture of ${u} rate limited by the site; retry after ${t}; the broker paces the whole domain until then`,
        operator: `capture ${j}: ${n(status)} from ${s(ctx.domain ?? ctx.host, 253)}, Retry-After ${t}; domain paused until ${ctx.pausedUntil === undefined ? "?" : new Date(ctx.pausedUntil).toISOString()}`,
      };
    case "not_found":
      return {
        model: `capture of ${u} not found (HTTP ${n(status)})${f.fallbackTried ? "; no archived copy" : ""}`,
        operator: `capture ${j}: HTTP ${n(status)}; wayback ${ctx.wayback ?? "none"}`,
      };
    case "upstream_error":
      return {
        model: `capture of ${u} failed: the site returned an error (${status !== undefined ? status : s(reason ?? "reset", 20)}); retry later or choose another source`,
        operator: `capture ${j}: upstream ${status !== undefined ? status : s(ctx.errorClass ?? reason, 40)} at hop ${n(ctx.hops ?? 0)}`,
      };
    case "timeout":
      return {
        model: `capture of ${u} timed out after ${n(ctx.ms)} ms; retry later or choose another source`,
        operator: `capture ${j}: ${s(ctx.phase ?? reason, 20)} timeout ${n(ctx.ms)} ms at rung ${s(ctx.rung, 20)}`,
      };
    case "network": {
      const what = NETWORK_TEXT[reason ?? ""] ?? "the network failed";
      const next = reason === "egress_denied" ? "choose another source" : "retry later or choose another source";
      const evidence =
        reason === "robots_unreachable"
          ? `${s(ctx.robotsUrl, 300)} status ${status ?? "none"}`
          : reason === "egress_denied"
            ? `egress row ${s(ctx.egressRow, 200)}`
            : `host ${host}`;
      return { model: `capture of ${u} failed: ${what}; ${next}`, operator: `capture ${j}: network ${s(reason, 40)}; ${evidence}` };
    }
    case "too_large":
      return {
        model: `capture of ${u} exceeds ${n(ctx.cap)} bytes; request a more specific page`,
        operator: `capture ${j}: ${n(ctx.bytes)} > cap ${n(ctx.cap)} (${s(ctx.key ?? "capture.maxBytes", 80)})`,
      };
    case "unsupported_type": {
      const type = s(ctx.type === undefined ? undefined : ctx.type.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~/;= -]/g, ""), 100);
      return {
        model: `capture of ${u} returned ${type}, which is not supported; choose another source`,
        operator: `capture ${j}: content type ${type} refused by ${s(ctx.rung, 20)}`,
      };
    }
    case "capture_failed":
      return {
        model: `capture of ${u} failed in the browser (${s(ctx.cause ?? reason, 40)}); retry once later`,
        operator: `capture ${j}: worker ${agent} gen ${n(ctx.generation)} cause ${s(ctx.cause ?? reason, 40)}; sandbox ${s(ctx.sandbox, 80)}; logs ${s(ctx.logs, 80)}`,
      };
    case "unavailable":
      return {
        model: `capture unavailable: the broker cannot run (${s(reason, 40)}); report this to the operator and do not retry`,
        operator: `capture ${j}: broker unavailable: ${s(reason, 40)}; fix ${s(ctx.fix ?? UNAVAILABLE_FIX[reason ?? ""], 120)}`,
      };
  }
}

// The model-facing text of a `pending` outcome (CaptureResponse.message).
export function capturePendingMessage(job: CaptureJobId): string {
  return `capture ${clean(job, 80)} is still running; retry with the same key or wait on the job`;
}

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

// ---- Section 10.3: spotlighting ---------------------------------------------------------------------------------------------

const SPOT_OPEN = "<<untrusted-page";
const SPOT_CLOSE = "<<end-untrusted-page";
const SPOT_RE = /<<(?:end-)?untrusted-page/gi;

// Wraps untrusted page text in a per-call boundary (the delimiting form of spotlighting). Every occurrence of either boundary
// string is removed from the text first, repeatedly, so a page cannot print a closing marker. `nonce` is the caller's per-call
// random hex (at least 6 digits); `meta` names the capture and the rendered URL in the opening marker.
export function spotlight(text: string, nonce: string, meta: { capture?: CaptureId; url?: string } = {}): string {
  if (!/^[0-9a-f]{6,64}$/.test(nonce)) throw new Error("spotlight nonce must be 6 to 64 lowercase hex digits");
  let body = text;
  for (let prev = ""; prev !== body; ) {
    prev = body;
    body = body.replace(SPOT_RE, "");
  }
  const attr = (k: string, v: string | undefined) => (v === undefined ? "" : ` ${k}=${v.replace(/[\s<>]/g, "").slice(0, 300)}`);
  const open = `${SPOT_OPEN} nonce=${nonce}${attr("capture", meta.capture)}${attr("url", meta.url === undefined ? undefined : renderCaptureUrl(meta.url))}>>`;
  return `${open}\n${body}\n${SPOT_CLOSE} nonce=${nonce}>>`;
}

// ---- Approval kind and the HTTP wire types (one definition, consumed by pomtreed and pomtree) ---------------------------------------

export const CAPTURE_HOST_KIND = "capture_host"; // ApprovalKind for a host outside the requester's capture scope

export const CAPTURE_LIST_LIMIT_DEFAULT = 50;
export const CAPTURE_LIST_LIMIT_MAX = 200;

// POST /v1/capture
export interface CaptureRequestBody {
  request: CaptureRequest;
  idempotencyKey: string;
}
// POST /v1/capture and GET /v1/capture/jobs/:job?waitMs=. `message` is the model-facing text for failed and pending, else null.
export interface CaptureResponse {
  outcome: CaptureOutcome;
  message: string | null;
}
// GET /v1/capture/:id
export interface CaptureShowResponse {
  capture: CaptureRecord;
}
// GET /v1/capture?limit= (newest first)
export interface CaptureListResponse {
  captures: CaptureRecord[];
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
