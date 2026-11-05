import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { AgentId, CaptureResponse, ExtensionGateway, ExtensionResult, ExtensionSpec, QuotaCounters } from "@pomtree/core";
import { CONFIG_DEFAULTS, captureFailure, captureMessages, capturePendingMessage, spotlight } from "@pomtree/core";
import type { CaptureApprovalVerdict, CaptureBroker, CaptureScope } from "./capture/types.ts";
import { memoryQuotaCounters, QUOTA_SCOPES, windowStart } from "./quota.ts";
import type { WebFetchApprovalVerdict } from "./webfetch-approval.ts";

// The default agent-side extension gateway (TODO(pi-ext)): `web_fetch` (an SSRF-guarded, size-capped
// HTTP(S) fetch) and `web_search` (an offline deny stub until a search provider is configured). The
// gateway is pure over injected `fetch`/`resolveDns` so it is testable without live network.

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
  // Releases an unread body (destroys the underlying response) so a redirect hop's socket is not held until the whole fetch ends.
  // Optional: a transport without it is released by closing its body iterator (see releaseBody).
  cancel?(): void;
}

// Releases a response whose body will not be read (a redirect hop). Never throws: releasing is best effort and must not mask the hop.
export function releaseBody(res: FetchResponse): void {
  try {
    if (res.cancel) res.cancel();
    else
      void res.body?.[Symbol.asyncIterator]()
        .return?.()
        ?.catch?.(() => {});
  } catch {
    // ignore: the shared abort in the caller's finally still tears the transport down
  }
}

export interface FetchInit {
  redirect: "manual";
  headers?: Record<string, string>;
  // Connect-time pin against DNS rebinding: the hostname and its validated address the fetch must connect
  // to. The default fetch honors it by pinning the socket lookup, so a DNS rebinding that answers the
  // pre-fetch resolve with a public IP and the connect-time lookup with a private one cannot land.
  pin?: { hostname: string; address: string; family: number };
  // Optional cancellation (additive): aborting destroys the pending request or response body.
  signal?: AbortSignal;
}

export type WebFetchScope = boolean | { hosts: readonly string[] };

// Maps a template's egress policy to the host-side web_fetch scope. web_fetch runs on the host network, so it
// must not exceed what the container could reach: `none` and `registry` (package registries only) get nothing,
// and `allowlist` gets exactly its hosts; any other policy is denied like the sandbox. Out-of-scope fetches for
// `registry` and `allowlist` agents may escalate one host-scoped fetch through the approval hook
// (`webFetchApprove`, see webfetch-approval.ts); `none` and unknown policies stay refused.
export function webFetchScope(egress: { kind: string; hosts?: readonly string[] } | undefined): WebFetchScope {
  if (egress?.kind === "allowlist" && egress.hosts) return { hosts: egress.hosts };
  return false;
}

export type FetchFn = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface ExtGatewayOptions {
  fetch?: FetchFn;
  resolveDns?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  maxBodyBytes?: number;
  // Whole-call deadline (registry key webfetch.timeoutMs, default DEFAULT_FETCH_TIMEOUT_MS): web_search is aborted past it and fails
  // naming the timeout; web_fetch waits this long on its capture and then answers pending (a retry with the same key converges).
  fetchTimeoutMs?: number;
  // The capture broker web_fetch is a client of (capture/types.ts). Absent: web_fetch refuses (WEB_FETCH_UNWIRED); there is no
  // direct path.
  capture?: CaptureBroker;
  // The agent's current registry generation (null when unknown), for the broker's requester fence.
  generationOf?: (agent: AgentId) => Promise<number | null>;
  // `web_search` provider: a URL template with a `{q}` placeholder, plus an optional bearer key.
  // When unset, web_search degrades to a deny (no provider) rather than a silent stub.
  searchProvider?: string;
  searchKey?: string;
  // Exfiltration controls. web_fetch runs from the host network, so it bypasses
  // container egress policy. `webFetchEnabled` is the global switch; `webFetchAllowed` is the
  // per-agent (e.g. per-template) predicate; both must pass. Denials are `denied: true` with a reason.
  webFetchEnabled?: boolean;
  // Async per-template opt-out: resolve true to allow web_fetch for this agent. A template resolved with
  // `egress:none` (or without web_fetch in its `spec.extensions` allowlist) must resolve false here. A
  // sync boolean return is accepted; a throw/reject fails closed (deny), it never allows the fetch.
  // An object scope ({ hosts }) allows web_fetch only to those exact hostnames over https (port 443), re-checked
  // after every redirect: it is the agent's egress allowlist applied to the host-network fetch.
  webFetchAllowed?: (agent: AgentId) => Promise<WebFetchScope> | WebFetchScope;
  // Out-of-scope escalation: when the scope refuses a fetch, this hook asks for a one-off, host-scoped
  // approval (see webfetch-approval.ts). It gets the bare lowercase host and the call's idempotency key and
  // returns the verdict, or null to refuse without asking. Unset or throwing fails closed to the plain
  // refusal. An approved call is pinned to that host (https:443, re-checked per redirect).
  webFetchApprove?: (agent: AgentId, host: string, idempotencyKey: string) => Promise<WebFetchApprovalVerdict | null>;
  // Per-agent caps, shared by web_fetch and web_search: calls per fixed window of rateWindowMs (QUOTA_SCOPES.webCalls) and total
  // response bytes over the agent's life (QUOTA_SCOPES.webBytes). Defaults are the registry keys webfetch.maxCalls,
  // webfetch.windowMs and webfetch.maxTotalBytes.
  maxCallsPerWindow?: number;
  rateWindowMs?: number;
  maxTotalBytes?: number;
  now?: () => number;
  // Durable counters for the caps above (SPEC rule 6). Absent: process-local counters that reset on restart (TODO(durable-quota) in
  // quota.ts).
  quota?: QuotaCounters;
}

const DEFAULT_MAX_BODY_BYTES = 1 << 20;
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
// The per-agent web_fetch caps default to their registry keys (webfetch.maxCalls, webfetch.windowMs, webfetch.maxTotalBytes).

const SPECS: ExtensionSpec[] = [
  {
    name: "web_fetch",
    description: "Fetch a URL over HTTP(S) through the host proxy (SSRF-guarded, size-capped, text media only)",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    streaming: false,
  },
  {
    name: "web_search",
    description: "Search the web through the host proxy (configurable provider; deny when unconfigured)",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    streaming: false,
  },
];

// IPv4 -> unsigned 32-bit integer, or null when the string is not a canonical dotted quad.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (p === "" || !/^\d+$/.test(p) ? null : Number(p)));
  if (bytes.some((b) => b === null || (b as number) < 0 || (b as number) > 255)) return null;
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

// Private, loopback, link-local, CGNAT, benchmarking, multicast, and reserved IPv4 space (SSRF guard).
// net.BlockList canonicalizes non-canonical dotted quads (e.g. "127.1") before checking, so a URL that
// WHATWG parsing leaves in short form still matches the right range.
const BLOCKED_IPV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network / unspecified
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT shared address space
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved incl. broadcast
] as const)
  BLOCKED_IPV4.addSubnet(net, prefix, "ipv4");

function isBlockedIpv4(ip: string): boolean {
  return BLOCKED_IPV4.check(ip, "ipv4");
}

// Canonical 16 bytes for an IPv6 literal (including IPv4-mapped ::ffff:a.b.c.d), or null when unparseable.
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = ipv4ToInt(mapped[1]!);
    if (v4 === null) return null;
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, (v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff];
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isBlockedIpv6(bytes: number[]): boolean {
  const v4 = (o: number) => `${bytes[o]}.${bytes[o + 1]}.${bytes[o + 2]}.${bytes[o + 3]}`;
  const zero = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  // IPv4-embedded forms: check the embedded address against the v4 block list.
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isBlockedIpv4(v4(12)); // ::ffff:0:0/96 mapped
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return isBlockedIpv4(v4(12)); // 64:ff9b::/96 NAT64
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isBlockedIpv4(v4(2)); // 2002::/16 6to4
  if (zero(0, 12)) return isBlockedIpv4(v4(12)); // ::/96 IPv4-compatible (deprecated): ::, ::1, ::7f00:1
  const b0 = bytes[0]!;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (b0 === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b0 === 0xff) return true; // ff00::/8 multicast
  if (b0 === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true; // 2001::/32 Teredo
  return false;
}

// Pure SSRF guard on an IP literal (no DNS): loopback, RFC1918, link-local (incl. metadata), and ULA.
export function isBlockedAddress(ip: string): boolean {
  let s = ip.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const fam = isIP(s);
  if (fam === 4) return isBlockedIpv4(s);
  if (fam === 6) {
    // Text isIP accepts but this parser cannot read is refused (fail closed): an address the guard cannot classify is never fetched.
    const bytes = ipv6Bytes(s);
    return bytes === null || isBlockedIpv6(bytes);
  }
  return false;
}

export type UrlPolicyResult = { ok: true; url: URL } | { ok: false; reason: string };

// Pure SSRF guard on a URL string: http/https only, and reject literal loopback/private/link-local/
// metadata/ULA hosts. Hostnames that are not IP literals pass here and are re-checked against their
// resolved addresses by web_fetch (the "reject after DNS resolve" step).
export function urlPolicy(input: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme ${url.protocol.replace(":", "")}` };
  }
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") {
    return { ok: false, reason: "loopback host" };
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    return { ok: false, reason: "blocked address" };
  }
  return { ok: true, url };
}

const TEXT_MEDIA = ["application/json", "application/xml", "application/xhtml+xml", "application/javascript", "application/ld+json", "application/graphql"];

export function isTextMedia(contentType: string | null): boolean {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return base.startsWith("text/") || TEXT_MEDIA.includes(base);
}

export function stripHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

// `cause` separates a name that did not resolve (dns) from one the SSRF guard refused after resolution (blocked).
export type ResolvePin = { ok: true; pin?: { hostname: string; address: string; family: number } } | { ok: false; reason: string; cause: "dns" | "blocked" };

// Resolve a hostname once, verify every address is unblocked, and return the address to pin the connect
// to (DNS rebinding defence). Literal IPs need no pin: urlPolicy already vetted them.
export async function resolvePin(host: string, resolveDns: (h: string) => Promise<{ address: string; family: number }[]>): Promise<ResolvePin> {
  if (isIP(host) !== 0) return { ok: true };
  let addrs: { address: string; family: number }[];
  try {
    addrs = await resolveDns(host);
  } catch {
    return { ok: false, reason: `DNS resolution failed for ${host}`, cause: "dns" };
  }
  if (addrs.length === 0) return { ok: false, reason: `DNS resolution returned no addresses for ${host}`, cause: "dns" };
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) return { ok: false, reason: `${host} resolves to a blocked address`, cause: "blocked" };
  }
  const first = addrs[0]!;
  return { ok: true, pin: { hostname: host, address: first.address, family: first.family } };
}

// The default fetch honors the SSRF pin: when init.pin is present the socket lookup is fixed to the
// validated address (while Host/servername stay on the original hostname, so TLS SNI/cert and virtual
// hosting are unaffected). A global fetch would re-resolve and defeat the pre-fetch check.
export const defaultFetch: FetchFn = (url, init) =>
  new Promise<FetchResponse>((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.pin) headers.host = u.host; // keep the original Host when connecting to the pinned IP
    const req = (isHttps ? httpsRequest : httpRequest)(
      u,
      {
        method: "GET",
        headers,
        // Node may ask for every address (`all: true`, autoSelectFamily): answer in the shape it requested.
        lookup: init.pin
          ? (_hostname, opts, cb) => {
              const { address, family } = init.pin!;
              if (opts?.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
              else cb(null, address, family);
            }
          : undefined,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name) => {
              const v = res.headers[name.toLowerCase()];
              return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
            },
          },
          body: (async function* () {
            for await (const chunk of res) yield chunk as Uint8Array;
          })(),
          cancel: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error("aborted"));
      else init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    req.end();
  });

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array | { over: true }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return { over: true };
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Allowlist scope check for one URL (initial and every redirect hop): https, default port, exact hostname.
export function scopeDenial(u: URL, hosts: readonly string[] | undefined): string | null {
  if (hosts === undefined) return null;
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443")) return `${u.host} is not allowlisted (https port 443 only)`;
  const host = stripHost(u.hostname).toLowerCase();
  return hosts.some((h) => h.toLowerCase() === host) ? null : `${host} is not in the egress allowlist`;
}

// Runs one gateway call under a deadline: `work` gets the signal to pass to every fetch, and the call resolves to a timeout failure
// when the deadline passes first (whatever `work` is awaiting: DNS, headers or the body). The signal is aborted when the call
// ends either way, so a late transport is torn down rather than left reading.
async function withDeadline(timeoutMs: number, what: string, work: (signal: AbortSignal) => Promise<ExtensionResult>): Promise<ExtensionResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ExtensionResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: `${what} timed out after ${timeoutMs}ms: the upstream did not answer in time; retry later or try another source` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
}

// Normalizes a search-provider JSON body to the gateway's stable item shape. Providers differ on the
// array key and the field names, so the common shapes (items/results/web.results/data) and field
// spellings (title/name, url/link/href, snippet/description/content/summary) are accepted.
function parseSearchItems(body: string): SearchItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const arrays: unknown[][] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) {
      arrays.push(v);
      return;
    }
    if (isObj(v)) {
      for (const key of ["items", "results", "data"]) {
        const found = v[key];
        if (Array.isArray(found)) arrays.push(found);
        else if (isObj(found)) collect(found); // e.g. `web: { results: [...] }` (Brave)
      }
    }
  };
  collect(parsed);
  const candidates = arrays.find((a) => a.some(isObj));
  if (!candidates) return null;
  const first = (o: Record<string, unknown>, keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v !== "") return v;
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const items: SearchItem[] = [];
  for (const e of candidates) {
    if (!isObj(e)) continue;
    const title = first(e, ["title", "name", "heading"]);
    const url = first(e, ["url", "link", "href", "uri"]);
    const snippet = first(e, ["snippet", "description", "content", "summary", "abstract"]);
    if (!title || !url) continue;
    items.push({ title, url, snippet });
  }
  return items.length > 0 ? items : null;
}

async function webSearch(
  input: unknown,
  o: {
    fetch: FetchFn;
    resolveDns: (h: string) => Promise<{ address: string; family: number }[]>;
    maxBodyBytes: number;
    provider?: string;
    key?: string;
    signal: AbortSignal;
  },
): Promise<ExtensionResult> {
  const query = typeof input === "string" ? input : (input as { query?: unknown } | null)?.query;
  if (typeof query !== "string" || query === "") return { ok: false, reason: "web_search requires a query" };
  if (!o.provider) return { ok: false, denied: true, reason: "search provider not configured" };
  const url = o.provider.replace("{q}", encodeURIComponent(query));
  const policy = urlPolicy(url);
  if (!policy.ok) return { ok: false, reason: `search provider blocked: ${policy.reason}` };
  const host = stripHost(policy.url.hostname);
  const pin = await resolvePin(host, o.resolveDns);
  if (!pin.ok) return { ok: false, reason: pin.reason };
  const init: FetchInit = { redirect: "manual", signal: o.signal, ...(pin.pin ? { pin: pin.pin } : {}) };
  if (o.key) init.headers = { authorization: /^bearer /i.test(o.key) ? o.key : `Bearer ${o.key}` };
  let res: FetchResponse;
  try {
    res = await o.fetch(policy.url.toString(), init);
  } catch (e) {
    return { ok: false, reason: `search failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status >= 300) return { ok: false, reason: `upstream status ${res.status}` };
  const contentType = res.headers.get("content-type");
  if (!isTextMedia(contentType)) return { ok: false, reason: `unsupported content type ${contentType ?? "(none)"}` };
  let bytes: Uint8Array | { over: true };
  try {
    bytes = res.body === null ? new Uint8Array(0) : await readCapped(res.body, o.maxBodyBytes);
  } catch (e) {
    return { ok: false, reason: `search failed while reading the body: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!(bytes instanceof Uint8Array)) return { ok: false, reason: `response body exceeds ${o.maxBodyBytes} bytes` };
  const body = Buffer.from(bytes).toString("utf8");
  const items = parseSearchItems(body);
  if (items === null) return { ok: false, reason: "search provider returned no results" };
  return {
    ok: true,
    result: { items },
    summary: { bytes: bytes.byteLength, mediaType: contentType ?? "text/plain", sha256: createHash("sha256").update(body).digest("hex") },
  };
}

// The request scope web_fetch hands the capture broker (L4: the agent's egress host allowlist, as before the broker): `true` any
// public host; `{ hosts }` exactly those hosts over https:443 (scopeDenial), re-checked on every redirect hop; `false` none. A host
// outside it asks `approve` (webfetch-approval.ts, a capture_host approval) when one is wired; a hook that throws or answers null
// refuses (fail closed). main.ts builds the broker's own scopeFor (the /v1/capture routes) from this same function.
export function webFetchCaptureScope(
  allowed: WebFetchScope,
  approve?: (host: string, idempotencyKey: string) => Promise<WebFetchApprovalVerdict | null>,
): CaptureScope {
  const hosts = typeof allowed === "object" ? allowed.hosts : undefined;
  return {
    allows: (u) => (allowed === true ? true : hosts !== undefined && scopeDenial(u, hosts) === null),
    ...(approve && {
      approve: async (host: string, key: string): Promise<CaptureApprovalVerdict | null> => {
        let v: WebFetchApprovalVerdict | null;
        try {
          v = await approve(host, key);
        } catch {
          v = null; // a broken approval path refuses without asking, never allows
        }
        if (v === null) return null;
        if (v.state === "denied") return { state: "denied", approval: v.approval, decision: /time/i.test(v.reason) ? "timed out" : "denied" };
        return { state: v.state, approval: v.approval };
      },
    }),
  };
}

// The refusal when the gateway was built without a capture broker: web_fetch has no other path (one policy owner, SPEC rule 9).
export const WEB_FETCH_UNWIRED =
  "web_fetch is unavailable: this daemon's extension gateway has no capture broker wired (ExtGatewayOptions.capture); report this to the operator";

export function createExtGateway(opts: ExtGatewayOptions = {}): ExtensionGateway {
  const fetch = opts.fetch ?? defaultFetch;
  const resolveDns = opts.resolveDns ?? ((hostname: string) => lookup(hostname, { all: true }));
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const searchProvider = opts.searchProvider?.trim() || undefined;
  const searchKey = opts.searchKey?.trim() || undefined;
  const webFetchEnabled = opts.webFetchEnabled ?? true;
  const maxCalls = opts.maxCallsPerWindow ?? CONFIG_DEFAULTS["webfetch.maxCalls"];
  const windowMs = opts.rateWindowMs ?? CONFIG_DEFAULTS["webfetch.windowMs"];
  const maxTotal = opts.maxTotalBytes ?? CONFIG_DEFAULTS["webfetch.maxTotalBytes"];
  const now = opts.now ?? Date.now;
  const quota = opts.quota ?? memoryQuotaCounters();
  // Returns a denial reason, or null after recording the call. Each admitted call reserves maxBodyBytes (its worst case) in the
  // agent's byte counter until it settles, so concurrent calls cannot overshoot the quota; account() hands back what the call did not
  // use. A daemon that dies mid-call keeps the whole reservation charged: bounded by one body cap per crash, and toward stricter.
  const admit = (agent: AgentId): string | null => {
    if (quota.peek(QUOTA_SCOPES.webBytes, agent, 0) >= maxTotal) return `byte quota exceeded (${maxTotal} bytes)`;
    if (!quota.take(QUOTA_SCOPES.webCalls, agent, windowStart(now(), windowMs), 1, maxCalls).ok)
      return `rate limit exceeded (${maxCalls} calls per ${windowMs}ms)`;
    quota.take(QUOTA_SCOPES.webBytes, agent, 0, maxBodyBytes, Number.MAX_SAFE_INTEGER);
    return null;
  };
  const account = async (agent: AgentId, p: Promise<ExtensionResult>): Promise<ExtensionResult> => {
    let charged = 0;
    try {
      const r = await p;
      // An over-cap response was read up to the cap: charge that, not zero.
      const b = r.ok
        ? (r.summary as { bytes?: number } | undefined)?.bytes
        : typeof r.reason === "string" && r.reason.startsWith("response body exceeds")
          ? maxBodyBytes
          : undefined;
      if (typeof b === "number") charged = Math.min(b, maxBodyBytes);
      return r;
    } finally {
      quota.give(QUOTA_SCOPES.webBytes, agent, 0, maxBodyBytes - charged);
    }
  };
  // web_fetch's scope, from the template predicate (fail closed: a throw denies) and the approval hook.
  const scopeOf = async (agent: AgentId): Promise<CaptureScope> => {
    let allowed: WebFetchScope = true;
    if (opts.webFetchAllowed) {
      try {
        allowed = await Promise.resolve(opts.webFetchAllowed(agent));
      } catch {
        allowed = false;
      }
    }
    const hook = opts.webFetchApprove;
    return webFetchCaptureScope(allowed, hook && ((host, key) => hook(agent, host, key)));
  };
  // web_fetch is a capture broker client: the broker owns robots.txt, the cache, pacing, the
  // User-Agent, redirects and the failure classes; this keeps the tool's interface, its per-agent call and byte caps, the text-media
  // rule and the spotlit body.
  const webFetchViaBroker = async (
    broker: CaptureBroker,
    agent: AgentId,
    input: unknown,
    idempotencyKey: string,
    refundCall: () => void,
  ): Promise<ExtensionResult> => {
    const urlStr = typeof input === "string" ? input : (input as { url?: unknown } | null)?.url;
    if (typeof urlStr !== "string" || urlStr === "") return { ok: false, reason: "web_fetch requires a url" };
    const generation = opts.generationOf ? await opts.generationOf(agent).catch(() => null) : null;
    if (generation === null) return { ok: false, denied: true, reason: "web_fetch denied: the calling agent is unknown to the registry" };
    // A call with no key gets a fresh one (no replay to converge on); a keyed call is namespaced by agent and URL, so it never meets
    // another client's key and a reused tool-call key with another URL is a new request, as it was before the broker.
    const urlTag = createHash("sha256").update(urlStr).digest("hex").slice(0, 16);
    const key = `web_fetch:${agent}:${idempotencyKey === "" ? randomUUID() : idempotencyKey}:${urlTag}`;
    let resp: CaptureResponse;
    try {
      resp = await broker.request({ kind: "agent", agent, generation }, { url: urlStr, render: "static", purpose: "web_fetch" }, key, {
        waitMs: fetchTimeoutMs,
        scope: await scopeOf(agent),
      });
    } catch (e) {
      return { ok: false, reason: `web_fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    const o = resp.outcome;
    if (o.state === "pending") return { ok: false, reason: resp.message ?? capturePendingMessage(o.job) };
    if (o.state === "failed") {
      // An approval still open, or decided, is not a fetch: as before the broker, it does not spend a call of the agent's rate cap.
      if (o.failure.class === "pending_approval" || o.failure.class === "denied") refundCall();
      const denied = DENIED_CLASSES.has(o.failure.class) || (o.failure.class === "network" && o.failure.reason === "egress_denied");
      return { ok: false, ...(denied && { denied: true }), reason: resp.message ?? o.failure.class };
    }
    const meta = o.capture.predicate.fetch;
    const ctx = { url: meta.finalUrl, rung: "web_fetch" };
    if (!isTextMedia(meta.contentType)) {
      const f = captureFailure({ class: "unsupported_type" });
      return { ok: false, reason: captureMessages(f, { ...ctx, type: meta.contentType ?? "(none)" }).model };
    }
    const raw = o.capture.artifacts.find((a) => a.role === "raw");
    if (raw === undefined) return { ok: false, reason: `web_fetch failed: capture ${o.capture.id} has no raw body` };
    if (raw.sizeBytes > maxBodyBytes) {
      const f = captureFailure({ class: "too_large" });
      return { ok: false, reason: `response body exceeds ${maxBodyBytes} bytes: ${captureMessages(f, { ...ctx, cap: maxBodyBytes }).model}` };
    }
    let bytes: Uint8Array;
    try {
      bytes = await broker.read(raw);
    } catch (e) {
      return { ok: false, reason: `web_fetch failed reading capture ${o.capture.id}: ${e instanceof Error ? e.message : String(e)}` };
    }
    // The body reaches the model only inside the spotlighting boundary, with a fresh nonce per call.
    const body = spotlight(Buffer.from(bytes).toString("utf8"), randomBytes(6).toString("hex"), { capture: o.capture.id, url: meta.finalUrl });
    return {
      ok: true,
      result: { url: meta.finalUrl, status: meta.status, contentType: meta.contentType ?? "", body, capture: o.capture.id, servedFrom: o.servedFrom },
      summary: { bytes: raw.sizeBytes, mediaType: meta.contentType ?? "text/plain", sha256: raw.sha256 },
    };
  };
  return {
    async list(): Promise<ExtensionSpec[]> {
      return SPECS.map((s) => ({ ...s, inputSchema: structuredClone(s.inputSchema) }));
    },
    async call(agent: AgentId, extension: string, input: unknown, idempotencyKey = ""): Promise<ExtensionResult> {
      if (extension === "web_fetch") {
        if (!webFetchEnabled) return { ok: false, denied: true, reason: "web_fetch disabled by policy" };
        const broker = opts.capture;
        if (!broker) return { ok: false, reason: WEB_FETCH_UNWIRED };
        const window = windowStart(now(), windowMs);
        const denial = admit(agent);
        if (denial) return { ok: false, denied: true, reason: `web_fetch denied: ${denial}` };
        const refund = () => quota.give(QUOTA_SCOPES.webCalls, agent, window, 1);
        return account(agent, webFetchViaBroker(broker, agent, input, idempotencyKey, refund));
      }
      // TODO(ext-idem): pass the idempotency key to the search provider. Current behavior: web_search drops the key.
      // A retry with the same key queries the provider again; web_fetch already passes the key to the capture broker.
      if (extension === "web_search") {
        const denial = admit(agent);
        if (denial) return { ok: false, denied: true, reason: `web_search denied: ${denial}` };
        return account(
          agent,
          withDeadline(fetchTimeoutMs, "web_search", (signal) =>
            webSearch(input, { fetch, resolveDns, maxBodyBytes, provider: searchProvider, key: searchKey, signal }),
          ),
        );
      }
      return { ok: false, reason: `unknown extension ${extension}` };
    },
  };
}

// Failure classes web_fetch reports as a policy denial (ExtensionResult.denied) rather than an upstream error (network/egress_denied
// too: the request scope refused the host).
const DENIED_CLASSES: ReadonlySet<string> = new Set(["invalid_request", "forbidden", "denied", "blocked", "quota"]);
