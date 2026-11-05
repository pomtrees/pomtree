// Host-side audit for live runs: one record per host HTTP request. The record exists as soon as a request is dispatched
// (outcome "pending" until settled), so denied, thrown, cancelled and never-consumed requests are still counted. A record
// still "pending" at the end means the process died or its body was never consumed. Pure over an
// injected FetchFn; no transport is built here. URL policy reuses checkPublicUrl from article.mts.
//
// Privacy: records hold metadata only. The URL contributes its authority (hostname), port and a sha256 of the full
// URL string; never its path, query, bodies, or header values (other than the request id). The one exception is a model upstream call
// (our own configured API, via auditedModelFetch), which also records its path (no query) as `route` and the response status as `upstreamStatus`.
import { createHash } from "node:crypto";
import type { FetchFn, FetchResponse } from "../../packages/pomtreed/src/ext-gateway.ts";
import { checkPublicUrl } from "./article.mts";
import { DEFAULT_CONTENT_BOUNDS } from "./content-bounds.mts";

const REQUEST_ID_MAX = 200;

export type HostDenyReason = "dns" | "private" | "hard-class" | "not-allowlisted" | "reserved" | "resolver-limit";
export type HostErrorClass = "dial" | "reset" | "timeout" | "protocol" | "bound" | "internal";

export interface HostAuditRecord {
  stream: "host";
  sandbox: null; // always null for host records
  sequence: number;
  authority: string; // hostname
  port: number;
  dialled?: string; // the pinned address the dial was attempted against; NOT proof of a connection (set before the dial)
  peer?: string; // set only once the connection produced a response (status known)
  pinnedPeer?: string; // init.pin.address, set together with peer
  outcome: "pending" | "complete" | "denied" | "error" | "cancelled";
  bytes: number;
  status?: number;
  at: string; // ISO-8601 time the request was dispatched or denied
  durationMs: number; // set when the record reaches a terminal state (0 while open). Model upstream rows: time to response headers (the body is not consumed by the audited fetch); total latency is `latencyMs` in model-calls.json
  method: string;
  urlSha256: string; // sha256 hex of the full request URL string
  denyReason?: HostDenyReason;
  errorClass?: HostErrorClass;
  story?: string;
  agent?: string;
  requestId?: string;
  truncated?: boolean; // the consumer stopped reading at its own cap: outcome is `complete` and `bytes` is what it read
  // Model upstream calls only (our own configured API; never set for article or HN fetches, which stay metadata-only):
  route?: string; // request path without query string
  upstreamStatus?: number;
  model?: string; // passed through when the caller supplies it
}

export interface Attribution {
  story?: string;
  agent?: string;
}

export type AuditSink = (rec: Readonly<HostAuditRecord>, phase: "open" | "final") => void;

export interface AuditedFetchOptions {
  maxBodyBytes?: number;
  now?: () => number;
  sink?: AuditSink;
}

export interface AuditedFetch {
  fetch: FetchFn; // unattributed
  attributed(a: Attribution): FetchFn; // same recording, records carry story/agent
  records(): readonly HostAuditRecord[];
  count(): number;
  recordCall(c: { url: string; method: string; attribution?: Attribution; route?: string; requestId?: string }): {
    finish(r: {
      outcome: HostAuditRecord["outcome"];
      status?: number;
      upstreamStatus?: number;
      model?: string;
      bytes?: number;
      requestId?: string;
      errorClass?: HostErrorClass;
      denyReason?: HostDenyReason;
    }): void;
  };
}

// Hostname and effective port for a record. Unparseable URLs get an empty authority and port 0.
function targetOf(url: string): { authority: string; port: number } {
  try {
    const u = new URL(url);
    const defaultPort = u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 0;
    return { authority: u.hostname, port: Number(u.port) || defaultPort };
  } catch {
    return { authority: "", port: 0 };
  }
}

// Maps a checkPublicUrl error to a closed deny reason. Only the loopback/private/literal-IP host rule is "private";
// every other URL refusal (scheme, port, credentials, syntax, length) and any unknown message is "reserved".
export function denyReasonOf(error: string): HostDenyReason {
  return /host is loopback, private, local, literal IP or single-label/.test(error) ? "private" : "reserved";
}

// Marker code on the error thrown when a body exceeds its byte bound; classifyError maps it to "bound".
export const BODY_BOUND_CODE = "AUDIT_BODY_BOUND";
// Errors inspected per thrown value: the error itself and up to three causes. undici wraps a socket failure as a
// TypeError "fetch failed" whose cause carries the code.
const CAUSE_DEPTH_MAX = 4;
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const DIAL_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const PROTOCOL_CODE = /^(HPE_|ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_)|^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;
// Message fallback for errors without a structured code. Whole-word code tokens only, so "connect" or "reset" alone
// in prose never classifies.
const MESSAGE_TOKENS: [RegExp, HostErrorClass][] = [
  [/\bETIMEDOUT\b|\btimed out\b/, "timeout"],
  [/\bECONNRESET\b|\bEPIPE\b|\bsocket hang up\b/, "reset"],
  [/\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/, "dial"],
  [/\bHPE_[A-Z_]+\b|\bERR_(TLS|SSL|OSSL)_[A-Z_]+\b|\bCERT_[A-Z_]+\b/, "protocol"],
];

function chainOf(e: unknown): unknown[] {
  const links: unknown[] = [];
  let cur: unknown = e;
  while (cur !== undefined && cur !== null && links.length < CAUSE_DEPTH_MAX) {
    links.push(cur);
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return links;
}

function classifyLink(link: unknown): HostErrorClass | undefined {
  if (typeof link !== "object") return undefined;
  const { code, name } = link as { code?: unknown; name?: unknown };
  if (typeof code === "string") {
    if (code === BODY_BOUND_CODE) return "bound";
    if (TIMEOUT_CODES.has(code)) return "timeout";
    if (RESET_CODES.has(code)) return "reset";
    if (DIAL_CODES.has(code)) return "dial";
    if (PROTOCOL_CODE.test(code)) return "protocol";
  }
  // A caller's own abort is an AbortError and is not a timeout; only the timer's TimeoutError is.
  if (name === "TimeoutError") return "timeout";
  return undefined;
}

// Maps a thrown error to a closed error class. Structured codes win over message text, and the message fallback
// runs only when no link carries a known code. Anything unrecognised is "internal".
export function classifyError(e: unknown): HostErrorClass {
  const links = chainOf(e);
  for (const link of links) {
    const hit = classifyLink(link);
    if (hit !== undefined) return hit;
  }
  for (const link of links) {
    const text = link instanceof Error ? link.message : typeof link === "string" ? link : "";
    for (const [pattern, cls] of MESSAGE_TOKENS) if (pattern.test(text)) return cls;
  }
  return "internal";
}

// Counts bytes as the caller consumes them and finalizes the record when the source completes. Anything else
// (oversize, a source error, the consumer stopping early) leaves the record as "cancelled" or "error". A body that is
// never iterated never runs this generator, so its record stays "pending".
async function* countedBody(
  source: AsyncIterable<Uint8Array>,
  rec: HostAuditRecord,
  signal: AbortSignal | undefined,
  maxBytes: number,
  settle: () => void,
): AsyncGenerator<Uint8Array> {
  let finished = false;
  let failed = false;
  try {
    for await (const chunk of source) {
      rec.bytes += chunk.byteLength;
      if (rec.bytes > maxBytes) {
        rec.errorClass = "bound";
        throw Object.assign(new Error(`audited fetch: body exceeds ${maxBytes} bytes`), { code: BODY_BOUND_CODE });
      }
      yield chunk;
    }
    finished = true;
    rec.outcome = "complete";
  } catch (e) {
    failed = true;
    if (rec.errorClass === undefined && !signal?.aborted) rec.errorClass = classifyError(e);
    throw e;
  } finally {
    if (!finished) {
      if (!failed && !signal?.aborted && rec.bytes > 0) {
        // The consumer released the body after reading some of it (the article worker stops at its byte cap): a bounded read, not a failure.
        rec.outcome = "complete";
        rec.truncated = true;
      } else {
        rec.outcome = signal?.aborted ? "cancelled" : "error";
        if (rec.outcome === "cancelled") delete rec.errorClass;
      }
    }
    settle();
  }
}

export function createAuditedFetch(inner: FetchFn, opts: AuditedFetchOptions = {}): AuditedFetch {
  // ext.hnDigest.articleAuditBodyMaxBytes: the live runtime injects its resolved value; the default is the registry default, never a copy.
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_CONTENT_BOUNDS.auditBodyMaxBytes;
  const now = opts.now ?? Date.now;
  const sink = opts.sink;
  const log: HostAuditRecord[] = [];
  const starts = new WeakMap<HostAuditRecord, number>();

  const emit = (rec: HostAuditRecord, phase: "open" | "final") => {
    if (!sink) return;
    try {
      sink({ ...rec }, phase);
    } catch {
      // A failing sink must never break a fetch; the in-memory record is still kept.
    }
  };

  // Creates a record without publishing it, so callers can fill in fields before the "open" snapshot is emitted.
  const begin = (url: string, method: string, attribution?: Attribution, requestId?: string): HostAuditRecord => {
    const { authority, port } = targetOf(url);
    const start = now();
    const rec: HostAuditRecord = {
      stream: "host",
      sandbox: null,
      sequence: 0,
      authority,
      port,
      outcome: "pending",
      bytes: 0,
      at: new Date(start).toISOString(),
      durationMs: 0,
      method: method.toUpperCase(),
      urlSha256: createHash("sha256").update(url, "utf8").digest("hex"),
    };
    if (attribution?.story !== undefined) rec.story = attribution.story;
    if (attribution?.agent !== undefined) rec.agent = attribution.agent;
    if (requestId !== undefined) rec.requestId = requestId.slice(0, REQUEST_ID_MAX);
    starts.set(rec, start);
    return rec;
  };

  const publish = (rec: HostAuditRecord) => {
    rec.sequence = log.length + 1;
    log.push(rec);
    emit(rec, "open");
  };

  const settle = (rec: HostAuditRecord) => {
    rec.durationMs = now() - (starts.get(rec) ?? now());
    emit(rec, "final");
  };

  const fetchWith = async (url: string, init: Parameters<FetchFn>[1], attribution?: Attribution): Promise<FetchResponse> => {
    const verdict = checkPublicUrl(url);
    if (!verdict.ok) {
      const rec = begin(url, "GET", attribution);
      rec.outcome = "denied";
      rec.denyReason = denyReasonOf(verdict.error);
      publish(rec);
      settle(rec);
      throw new Error(`audited fetch denied: ${verdict.error}`);
    }
    const rec = begin(url, "GET", attribution);
    if (init.pin) {
      rec.dialled = init.pin.address;
    }
    publish(rec);
    if (init.signal?.aborted) {
      rec.outcome = "cancelled";
      settle(rec);
      throw new Error("audited fetch cancelled before dispatch");
    }
    let res: FetchResponse;
    try {
      res = await inner(url, init);
    } catch (e) {
      if (init.signal?.aborted) {
        rec.outcome = "cancelled";
      } else {
        rec.outcome = "error";
        rec.errorClass = classifyError(e);
      }
      settle(rec);
      throw e;
    }
    rec.status = res.status;
    if (init.pin) {
      rec.peer = init.pin.address;
      rec.pinnedPeer = init.pin.address;
    }
    if (res.body === null) {
      rec.outcome = "complete";
      settle(rec);
      return res;
    }
    return { ...res, body: countedBody(res.body, rec, init.signal, maxBodyBytes, () => settle(rec)) };
  };

  return {
    fetch: (url, init) => fetchWith(url, init),
    attributed: (a) => (url, init) => fetchWith(url, init, a),
    records: () => log.map((r) => ({ ...r })),
    count: () => log.length,
    recordCall: (c) => {
      const rec = begin(c.url, c.method, c.attribution, c.requestId);
      if (c.route !== undefined) rec.route = c.route;
      publish(rec);
      let done = false;
      return {
        finish: (r) => {
          if (done) return;
          done = true;
          rec.outcome = r.outcome;
          if (r.status !== undefined) rec.status = r.status;
          if (r.upstreamStatus !== undefined) rec.upstreamStatus = r.upstreamStatus;
          if (r.model !== undefined) rec.model = r.model;
          rec.bytes = r.bytes ?? 0;
          if (r.requestId !== undefined) rec.requestId = r.requestId.slice(0, REQUEST_ID_MAX);
          if (r.denyReason !== undefined) rec.denyReason = r.denyReason;
          if (r.errorClass !== undefined && r.outcome !== "cancelled") rec.errorClass = r.errorClass;
          settle(rec);
        },
      };
    },
  };
}

// The request path of a model call, without query or fragment ("" when unparseable).
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

// The calling agent and request of a model call, as the model proxy passes them to its upstream fetch.
export interface ModelFetchCtx {
  agent: string;
  requestId: string;
}

// The upstream fetch a model proxy calls: global-fetch-shaped, with the optional ctx as a third argument.
export type ModelFetchInner = (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit, ctx?: ModelFetchCtx) => Promise<Response>;

// Global-fetch-shaped for callers that pass two arguments, and ctx-aware for the model proxy.
export type AuditedModelFetch = typeof globalThis.fetch & ModelFetchInner;

// Attribution of a call that names its agent through ctx: the agent is ctx's; the story is the attribution's when it has
// one, else the resolver's for ctx.agent.
function attributionOfCall(a: Attribution | undefined, ctx: ModelFetchCtx, resolveStory?: (agent: string) => string | undefined): Attribution {
  const story = a?.story ?? resolveStory?.(ctx.agent);
  return { ...a, agent: ctx.agent, ...(story !== undefined && { story }) };
}

// Wraps a global-fetch-shaped function for model calls. Records metadata at response headers and never reads or
// tees the response body. The attribution callback is consulted per call. With a ctx, the row carries its agent and
// request id from the open snapshot on; the response's x-request-id header is used only when ctx names no request id.
export function auditedModelFetch(
  audit: AuditedFetch,
  inner: ModelFetchInner,
  attribution?: () => Attribution | undefined,
  resolveStory?: (agent: string) => string | undefined,
): AuditedModelFetch {
  return async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit, ctx?: ModelFetchCtx) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const a = attribution?.();
    const call = audit.recordCall({
      url,
      method,
      attribution: ctx === undefined ? a : attributionOfCall(a, ctx, resolveStory),
      route: pathOf(url),
      ...(ctx?.requestId !== undefined && { requestId: ctx.requestId }),
    });
    if (signal?.aborted) {
      call.finish({ outcome: "cancelled" });
      throw signal.reason ?? new Error("model fetch cancelled before dispatch");
    }
    let res: Response;
    try {
      res = ctx === undefined ? await inner(input, init) : await inner(input, init, ctx);
    } catch (e) {
      call.finish(signal?.aborted ? { outcome: "cancelled" } : { outcome: "error", errorClass: classifyError(e) });
      throw e;
    }
    // TODO(hn-insights): bytesIn on model-call rows is the response Content-Length header (0 when absent, e.g. chunked/streamed); streamed bytes are not counted because the audited fetch never tees the body
    const len = res.headers.get("content-length");
    const bytes = len !== null && /^\d+$/.test(len) ? Number(len) : 0;
    const requestId = ctx?.requestId === undefined ? (res.headers.get("x-request-id") ?? undefined) : undefined;
    call.finish(
      res.ok
        ? { outcome: "complete", status: res.status, upstreamStatus: res.status, bytes, requestId }
        : { outcome: "error", status: res.status, upstreamStatus: res.status, bytes, requestId, errorClass: "protocol" },
    );
    return res;
  };
}
