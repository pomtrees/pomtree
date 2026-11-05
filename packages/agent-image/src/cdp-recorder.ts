// Pure CDP network recorder for the model-free capture worker. It consumes Chromium's Network domain events through an injected
// session and rebuilds the HTTP exchanges of one page load: the main document's redirect chain (every hop, cross-host included) and
// the subresources. No fs, socket or Playwright import: capture-worker.ts hands it Playwright's CDPSession, tests a scripted fake.
//
// Decision: CDP by hand, not Playwright's recordHar. A HAR is written to a file only when the
// context closes, which is after our deadline-bounded teardown starts; it keeps redirects as separate entries with no body and no raw
// (ExtraInfo) headers, so the wire header order and Set-Cookie lines are lost; and its bodies are base64 in JSON with no per-body cap,
// so an over-cap body could not be refused before allocation. The CDP events give every hop under one requestId (redirectResponse),
// raw headers (requestWillBeSentExtraInfo, responseReceivedExtraInfo), and getResponseBody on our own schedule, within our caps.
//
// The record is reconstructed from what Chromium reports, not from wire bytes: header case and order are Chromium's, HTTP/2 framing
// is invisible, text bodies come back from getResponseBody already decoded to a string (re-encoded here as UTF-8), and redirect
// responses have no body.

// The slice of a CDP session the recorder uses. Playwright's CDPSession satisfies it.
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: never) => void): unknown;
}

export const RECORDED_EVENTS = [
  "Network.requestWillBeSent",
  "Network.requestWillBeSentExtraInfo",
  "Network.responseReceived",
  "Network.responseReceivedExtraInfo",
  "Network.dataReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
] as const;

// The subset of each CDP event's params that is read. Everything else Chromium sends is ignored.
type CdpHeaders = Record<string, string>;
interface CdpResponse {
  url: string;
  status: number;
  statusText?: string;
  headers: CdpHeaders;
  mimeType?: string;
  protocol?: string;
}
export interface RequestWillBeSent {
  requestId: string;
  loaderId?: string;
  frameId?: string;
  type?: string;
  wallTime?: number; // seconds since epoch
  request: { url: string; method: string; headers: CdpHeaders; postData?: string };
  redirectResponse?: CdpResponse;
}
export interface RequestExtraInfo {
  requestId: string;
  headers: CdpHeaders;
}
export interface ResponseReceived {
  requestId: string;
  type?: string;
  frameId?: string;
  response: CdpResponse;
}
export interface ResponseExtraInfo {
  requestId: string;
  statusCode?: number;
  headers: CdpHeaders;
}
export interface DataReceived {
  requestId: string;
  dataLength: number;
}
export interface LoadingFinished {
  requestId: string;
}
export interface LoadingFailed {
  requestId: string;
  errorText?: string;
  canceled?: boolean;
  blockedReason?: string;
}

// Why a response has no or only part of its body. A closed set: Chromium's error texts are never copied into the record.
export const BODY_OMISSIONS = [
  "redirect", // a redirect response carries no body in CDP
  "no_body", // HEAD, 204, 304, or a failed or unfinished load
  "not_retained", // getResponseBody failed: Chromium no longer holds the body (evicted, streamed, or never buffered)
  "over_allocation_bound", // the decoded body Chromium reported was larger than the per-body allocation bound, so it was not fetched
  "over_total_bound", // the recording's total body budget was already spent
] as const;
export type BodyOmission = (typeof BODY_OMISSIONS)[number];

export interface RecordedBody {
  // complete: every byte; truncated: the first `bytes.byteLength` bytes of `fullBytes` (cap reached); omitted: none, see `omission`.
  state: "complete" | "truncated" | "omitted";
  bytes: Uint8Array;
  fullBytes?: number;
  omission?: BodyOmission;
}
export interface RecordedResponse {
  url: string;
  status: number;
  statusText: string;
  protocol: string | null;
  mimeType: string | null;
  headers: [string, string][];
  headersSource: "raw" | "filtered";
}
export interface RecordedHop {
  url: string;
  method: string;
  requestHeaders: [string, string][];
  requestHeadersSource: "raw" | "filtered";
  postData: string | null;
  wallTimeMs: number | null;
  response: RecordedResponse | null;
  body: RecordedBody;
}
export interface RecordedExchange {
  requestId: string;
  frameId: string | null;
  resourceType: string | null;
  // Navigation requests carry requestId === loaderId in CDP; the main document is one of them on the main frame.
  navigation: boolean;
  // Every hop of this requestId, redirects first; the last one is the final request.
  hops: RecordedHop[];
  state: "finished" | "failed" | "unfinished";
  failure?: { canceled: boolean; blocked: boolean };
}
export interface RecorderLimits {
  // Bytes kept per body; a longer body is truncated to this.
  perBodyMaxBytes: number;
  // A body Chromium reported as larger than this is not fetched at all (and Chromium is told not to retain it).
  perBodyAllocationMaxBytes: number;
  // Total body bytes kept across the recording.
  totalMaxBytes: number;
}

const EMPTY = new Uint8Array(0);
const omitted = (omission: BodyOmission): RecordedBody => ({ state: "omitted", bytes: EMPTY, omission });

// CDP joins a repeated header (Set-Cookie, Link) into one value with "\n"; split it back into one line each. HTTP/2 pseudo-headers
// (`:authority`, `:path`) are not HTTP/1.1 header lines and are dropped; the request line carries method and path, and Host is added
// from the URL when absent. A value that still holds CR or NUL is left for the WARC writer to refuse (a recorded omission upstream).
export function headerLines(h: CdpHeaders): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(h)) {
    if (name.startsWith(":")) continue;
    for (const v of String(value).split("\n")) out.push([name, v]);
  }
  return out;
}

function withHost(lines: [string, string][], url: string): [string, string][] {
  if (lines.some(([k]) => k.toLowerCase() === "host")) return lines;
  try {
    return [["Host", new URL(url).host], ...lines];
  } catch {
    return lines;
  }
}

const recordable = (url: string): boolean => /^https?:\/\//i.test(url);

export interface CdpRecorder {
  // Subscribes and enables the Network domain. Call before the navigation starts.
  start(): Promise<void>;
  // Stops recording, waits for body fetches already in flight, and returns every exchange in first-request order.
  finish(): Promise<RecordedExchange[]>;
}

export function createCdpRecorder(session: CdpSessionLike, limits: RecorderLimits): CdpRecorder {
  for (const v of Object.values(limits)) if (!Number.isSafeInteger(v) || v < 1) throw new Error("recorder limits must be positive integers");
  const exchanges = new Map<string, RecordedExchange>();
  // ExtraInfo events can arrive before or after their requestWillBeSent / responseReceived; Chromium sends one per hop, in hop order.
  const requestExtra = new Map<string, CdpHeaders[]>();
  const responseExtra = new Map<string, ResponseExtraInfo[]>();
  const decoded = new Map<string, number>();
  const pending: Promise<void>[] = [];
  let stopped = false;
  let kept = 0;

  const lastHop = (ex: RecordedExchange): RecordedHop => ex.hops[ex.hops.length - 1] as RecordedHop;
  const applyRequestExtra = (ex: RecordedExchange) => {
    const queue = requestExtra.get(ex.requestId) ?? [];
    for (let i = 0; i < ex.hops.length; i++) {
      const hop = ex.hops[i] as RecordedHop;
      const raw = queue[i];
      if (raw && hop.requestHeadersSource === "filtered") {
        hop.requestHeaders = withHost(headerLines(raw), hop.url);
        hop.requestHeadersSource = "raw";
      }
    }
  };
  const applyResponseExtra = (ex: RecordedExchange) => {
    const queue = responseExtra.get(ex.requestId) ?? [];
    let n = 0;
    for (const hop of ex.hops) {
      if (!hop.response) continue;
      const raw = queue[n++];
      // A status that disagrees means the queue is out of step with the hops: keep the filtered headers rather than misattribute.
      if (raw && hop.response.headersSource === "filtered" && (raw.statusCode === undefined || raw.statusCode === hop.response.status)) {
        hop.response.headers = headerLines(raw.headers);
        hop.response.headersSource = "raw";
      }
    }
  };
  const response = (r: CdpResponse): RecordedResponse => ({
    url: r.url,
    status: r.status,
    statusText: r.statusText ?? "",
    protocol: r.protocol ?? null,
    mimeType: r.mimeType ?? null,
    headers: headerLines(r.headers ?? {}),
    headersSource: "filtered",
  });
  const hop = (e: RequestWillBeSent): RecordedHop => ({
    url: e.request.url,
    method: e.request.method,
    requestHeaders: withHost(headerLines(e.request.headers ?? {}), e.request.url),
    requestHeadersSource: "filtered",
    postData: typeof e.request.postData === "string" ? e.request.postData : null,
    wallTimeMs: typeof e.wallTime === "number" && Number.isFinite(e.wallTime) ? Math.round(e.wallTime * 1000) : null,
    response: null,
    body: omitted("no_body"),
  });

  const fetchBody = async (ex: RecordedExchange, h: RecordedHop): Promise<void> => {
    const status = h.response?.status ?? 0;
    if (h.method === "HEAD" || status === 204 || status === 304 || (status >= 100 && status < 200)) return;
    if ((decoded.get(ex.requestId) ?? 0) > limits.perBodyAllocationMaxBytes) {
      h.body = omitted("over_allocation_bound");
      return;
    }
    if (kept >= limits.totalMaxBytes) {
      h.body = omitted("over_total_bound");
      return;
    }
    let got: { body?: unknown; base64Encoded?: unknown };
    try {
      got = (await session.send("Network.getResponseBody", { requestId: ex.requestId })) as typeof got;
    } catch {
      h.body = omitted("not_retained");
      return;
    }
    if (typeof got?.body !== "string") {
      h.body = omitted("not_retained");
      return;
    }
    const full = got.base64Encoded === true ? Buffer.from(got.body, "base64") : Buffer.from(got.body, "utf8");
    if (full.byteLength > limits.perBodyAllocationMaxBytes) {
      h.body = omitted("over_allocation_bound");
      return;
    }
    const room = limits.totalMaxBytes - kept;
    if (room <= 0) {
      h.body = omitted("over_total_bound");
      return;
    }
    const cap = Math.min(limits.perBodyMaxBytes, room);
    const bytes = full.byteLength <= cap ? new Uint8Array(full) : new Uint8Array(full.subarray(0, cap));
    kept += bytes.byteLength;
    h.body = bytes.byteLength === full.byteLength ? { state: "complete", bytes } : { state: "truncated", bytes, fullBytes: full.byteLength };
  };

  const handlers: Record<(typeof RECORDED_EVENTS)[number], (p: never) => void> = {
    "Network.requestWillBeSent": (e: RequestWillBeSent) => {
      if (!recordable(e.request?.url ?? "")) return;
      const ex = exchanges.get(e.requestId);
      if (ex) {
        // The same requestId again: CDP's redirect. redirectResponse is the previous hop's response, which has no body.
        const prev = lastHop(ex);
        if (e.redirectResponse) {
          prev.response = response(e.redirectResponse);
          prev.body = omitted("redirect");
        }
        ex.hops.push(hop(e));
      } else {
        exchanges.set(e.requestId, {
          requestId: e.requestId,
          frameId: e.frameId ?? null,
          resourceType: e.type ?? null,
          navigation: e.loaderId !== undefined && e.loaderId === e.requestId,
          hops: [hop(e)],
          state: "unfinished",
        });
      }
      const cur = exchanges.get(e.requestId) as RecordedExchange;
      applyRequestExtra(cur);
      applyResponseExtra(cur);
    },
    "Network.requestWillBeSentExtraInfo": (e: RequestExtraInfo) => {
      const queue = requestExtra.get(e.requestId) ?? [];
      queue.push(e.headers ?? {});
      requestExtra.set(e.requestId, queue);
      const ex = exchanges.get(e.requestId);
      if (ex) applyRequestExtra(ex);
    },
    "Network.responseReceived": (e: ResponseReceived) => {
      const ex = exchanges.get(e.requestId);
      if (!ex) return;
      lastHop(ex).response = response(e.response);
      if (e.type && !ex.resourceType) ex.resourceType = e.type;
      applyResponseExtra(ex);
    },
    "Network.responseReceivedExtraInfo": (e: ResponseExtraInfo) => {
      const queue = responseExtra.get(e.requestId) ?? [];
      queue.push(e);
      responseExtra.set(e.requestId, queue);
      const ex = exchanges.get(e.requestId);
      if (ex) applyResponseExtra(ex);
    },
    "Network.dataReceived": (e: DataReceived) => {
      if (Number.isFinite(e.dataLength) && e.dataLength > 0) decoded.set(e.requestId, (decoded.get(e.requestId) ?? 0) + e.dataLength);
    },
    "Network.loadingFinished": (e: LoadingFinished) => {
      const ex = exchanges.get(e.requestId);
      if (ex?.state !== "unfinished") return;
      ex.state = "finished";
      const h = lastHop(ex);
      if (h.response) pending.push(fetchBody(ex, h));
    },
    "Network.loadingFailed": (e: LoadingFailed) => {
      const ex = exchanges.get(e.requestId);
      if (ex?.state !== "unfinished") return;
      ex.state = "failed";
      ex.failure = { canceled: e.canceled === true, blocked: typeof e.blockedReason === "string" };
    },
  };

  return {
    async start() {
      for (const name of RECORDED_EVENTS) {
        const handle = handlers[name] as (p: unknown) => void;
        session.on(name, ((p: unknown) => {
          if (!stopped && p && typeof p === "object" && typeof (p as { requestId?: unknown }).requestId === "string") handle(p);
        }) as (p: never) => void);
      }
      // Chromium keeps bodies only up to these buffers; a body it did not keep is recorded as not_retained, never refetched.
      await session.send("Network.enable", {
        maxResourceBufferSize: limits.perBodyAllocationMaxBytes,
        maxTotalBufferSize: Math.max(limits.totalMaxBytes, limits.perBodyAllocationMaxBytes),
      });
    },
    async finish() {
      stopped = true;
      await Promise.all(pending);
      return [...exchanges.values()];
    },
  };
}

// The main document's exchange: a navigation request on the main frame, preferring the one whose final hop reached `finalUrl` (a
// later client-side navigation, if any, is a different requestId). Undefined when the recording saw no such request.
export function mainDocument(exchanges: readonly RecordedExchange[], mainFrameId: string | null, finalUrl: string): RecordedExchange | undefined {
  const docs = exchanges.filter((ex) => ex.navigation && (mainFrameId === null || ex.frameId === mainFrameId) && ex.hops.some((h) => h.response));
  const noFragment = (u: string) => u.split("#")[0];
  return docs.find((ex) => noFragment(ex.hops[ex.hops.length - 1]?.response?.url ?? "") === noFragment(finalUrl)) ?? docs[0];
}
