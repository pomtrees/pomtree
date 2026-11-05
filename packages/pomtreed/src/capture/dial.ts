// The broker's guarded GET: every hop goes through the urlPolicy SSRF guard and resolvePin
// (DNS resolved once, every address checked, the connect pinned), the request scope and the caller's per-hop check (robots.txt for
// a new origin), and is recorded in FetchMeta.redirects. Cross-host hops are followed when every check passes. One deadline covers
// every hop and the body; the body is capped while streaming. pomtreed reads only the status and the allowlisted headers here; the
// body is collected as opaque bytes and never decoded (decision C9).
// TODO(capture-broker): S2 moves origin dialing into the capture worker (static mode); pomtreed keeps only the official-API dial.
import { lookup } from "node:dns/promises";
import type { CaptureFailure, CaptureMessageContext, FetchMeta, TimeoutPhase } from "@pomtree/core";
import { allowlistHeaders, captureFailure, challengeMarkerOf, classifyHttpStatus, FETCH_HEADER_ALLOWLIST } from "@pomtree/core";
import type { FetchFn, FetchResponse } from "../ext-gateway.ts";
import { defaultFetch, releaseBody, resolvePin, stripHost, urlPolicy } from "../ext-gateway.ts";
import type { HostPace } from "../host-pacer.ts";

export const DEFAULT_MAX_REDIRECTS = 5;

export interface DialFailure {
  failure: CaptureFailure;
  ctx: Partial<CaptureMessageContext>; // evidence for the two messages (status, hops, ms, phase, marker, bytes, cap)
  meta: Partial<FetchMeta>; // what was learned before the failure (redirects so far, the last status and headers)
}

export type DialResult = { ok: true; meta: FetchMeta; bytes: Uint8Array; truncated: boolean } | ({ ok: false; aborted?: true } & DialFailure);

export interface DialOptions {
  url: string;
  userAgent: string;
  maxBytes: number;
  overflow: "fail" | "truncate"; // robots.txt reads only its first ROBOTS_PARSE_LIMIT_BYTES; everything else fails too_large
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal; // the broker's shutdown signal: an abort here is not a failure of the URL
  fetch?: FetchFn;
  resolveDns?: (h: string) => Promise<{ address: string; family: number }[]>;
  pace?: HostPace;
  opIdBase: string; // the pacing opId is `${opIdBase}:${hop}`, so a replayed step claims its slot once
  // The request scope, checked on every hop after the first (the caller admitted the first). Absent: every public host.
  allows?: (u: URL) => boolean;
  // Checked before every hop is dialed (robots.txt for the hop's origin); a failure stops the dial.
  beforeHop?: (u: URL, hop: number) => Promise<DialFailure | null>;
  conditional?: { etag?: string; lastModified?: string }; // sent on the first hop only; a 304 answer is a success
  rawStatus?: boolean; // return any final status as a success (robots.txt reads its status itself: robotsFetchVerdict)
  // Called synchronously right before each send (the first request and every redirect hop), after pacing: a failure stops the dial
  // and that hop is never sent (a requester's per-request budget, CaptureRequestOptions.takeRequest).
  beforeSend?: (hop: number) => DialFailure | null;
  now?: () => number;
}

const fail = (f: Omit<CaptureFailure, "retryable" | "fallbackTried">, ctx: Partial<CaptureMessageContext>, meta: Partial<FetchMeta>): DialResult => ({
  ok: false,
  failure: captureFailure(f),
  ctx,
  meta,
});

// The allowlisted response headers, read by name through the transport's get() (every FetchFn offers it).
export function responseHeaders(res: Pick<FetchResponse, "headers">): Record<string, string> {
  const entries: [string, string][] = [];
  for (const name of FETCH_HEADER_ALLOWLIST) {
    const v = res.headers.get(name);
    if (v !== null) entries.push([name, v]);
  }
  return allowlistHeaders(entries);
}

// A transport error's class: TLS, a reset or refused connection, or a DNS failure the transport hit itself.
function transportFailure(e: unknown): { class: "network" | "upstream_error"; reason: string } {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = e instanceof Error ? e.message : String(e);
  if (/^ERR_TLS|^ERR_SSL|CERT|^EPROTO$|^UNABLE_TO|^DEPTH_ZERO|^SELF_SIGNED/.test(code) || /\b(TLS|SSL|certificate)\b/i.test(msg))
    return { class: "network", reason: "tls" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { class: "network", reason: "dns" };
  if (code === "HPE_INVALID_CONSTANT" || code.startsWith("HPE_")) return { class: "upstream_error", reason: "malformed" };
  return { class: "upstream_error", reason: "reset" };
}

export async function dial(o: DialOptions): Promise<DialResult> {
  const now = o.now ?? Date.now;
  const fetchFn = o.fetch ?? defaultFetch;
  const resolveDns = o.resolveDns ?? ((h: string) => lookup(h, { all: true }));
  const maxRedirects = o.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const redirects: { url: string; status: number }[] = [];
  const controller = new AbortController();
  let timedOut = false;
  let phase: TimeoutPhase = "first_byte";
  // The deadline starts with the first dial, after the first hop's robots.txt check (which has its own deadline), so a slow
  // robots.txt is reported as robots_unreachable, not as this dial's timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer ??= setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, o.timeoutMs);
  };
  const onAbort = () => controller.abort();
  if (o.signal?.aborted) controller.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => {});
  const stopped = (meta: Partial<FetchMeta>): DialResult => {
    if (timedOut) return fail({ class: "timeout", reason: phase }, { ms: o.timeoutMs, phase, hops: redirects.length }, { redirects: [...redirects], ...meta });
    return { ok: false, aborted: true, failure: captureFailure({ class: "capture_failed", reason: "killed" }), ctx: {}, meta };
  };
  const work = async (): Promise<DialResult> => {
    const first = urlPolicy(o.url);
    if (!first.ok) return fail({ class: "invalid_request" }, { problem: first.reason }, {});
    let u = first.url;
    for (let hop = 0; ; hop++) {
      if (hop > 0 && o.allows && !o.allows(u))
        return fail(
          { class: "network", reason: "egress_denied" },
          { host: u.host, egressRow: `scope refused hop ${hop} to ${u.host}`, hops: hop },
          { redirects: [...redirects] },
        );
      if (o.beforeHop) {
        const refused = await o.beforeHop(u, hop);
        if (refused !== null) return { ok: false, ...refused, meta: { redirects: [...redirects], ...refused.meta } };
        if (controller.signal.aborted) return stopped({});
      }
      arm();
      const host = stripHost(u.hostname);
      const pin = await resolvePin(host, resolveDns);
      if (!pin.ok)
        return pin.cause === "dns"
          ? fail({ class: "network", reason: "dns" }, { host: u.host, hops: hop }, { redirects: [...redirects] })
          : fail({ class: "network", reason: "egress_denied" }, { host: u.host, egressRow: pin.reason, hops: hop }, { redirects: [...redirects] });
      await o.pace?.(host.toLowerCase(), controller.signal, `${o.opIdBase}:${hop}`);
      if (controller.signal.aborted) return stopped({});
      const headers: Record<string, string> = { "user-agent": o.userAgent };
      if (hop === 0 && o.conditional?.etag) headers["if-none-match"] = o.conditional.etag;
      if (hop === 0 && o.conditional?.lastModified) headers["if-modified-since"] = o.conditional.lastModified;
      const budget = o.beforeSend?.(hop) ?? null;
      if (budget !== null) return { ok: false, ...budget, meta: { redirects: [...redirects], ...budget.meta } };
      phase = "first_byte";
      let res: FetchResponse;
      try {
        res = await fetchFn(u.toString(), { redirect: "manual", signal: controller.signal, headers, ...(pin.pin ? { pin: pin.pin } : {}) });
      } catch (e) {
        if (controller.signal.aborted) return stopped({});
        const t = transportFailure(e);
        return fail({ class: t.class, reason: t.reason }, { host: u.host, hops: hop, errorClass: t.reason }, { redirects: [...redirects] });
      }
      const status = res.status;
      const rh = responseHeaders(res);
      if (status >= 300 && status < 400 && status !== 304) {
        releaseBody(res);
        const location = res.headers.get("location");
        const failMeta = { redirects: [...redirects], status, headers: rh };
        if (!location) return fail({ class: "upstream_error", reason: "malformed", status }, { hops: hop }, failMeta);
        if (hop >= maxRedirects) return fail({ class: "upstream_error", reason: "http", status }, { hops: hop }, failMeta);
        let target: URL;
        try {
          target = new URL(location, u);
        } catch {
          return fail({ class: "upstream_error", reason: "malformed", status }, { hops: hop }, failMeta);
        }
        const next = urlPolicy(target.toString());
        if (!next.ok || target.username !== "" || target.password !== "")
          return fail(
            { class: "network", reason: "egress_denied" },
            { host: target.host, egressRow: next.ok ? "credentials in the location" : next.reason, hops: hop + 1 },
            failMeta,
          );
        next.url.hash = "";
        redirects.push({ url: u.toString(), status });
        u = next.url;
        continue;
      }
      const meta: FetchMeta = {
        requestedUrl: o.url,
        finalUrl: u.toString(),
        redirects: [...redirects],
        status,
        contentType: rh["content-type"] ?? null,
        headers: rh,
        fetchedAt: now(),
        userAgent: o.userAgent,
      };
      if (status === 0) {
        releaseBody(res);
        return fail({ class: "upstream_error", reason: "malformed" }, { hops: hop }, meta);
      }
      const classified = o.rawStatus ? null : classifyHttpStatus(status, rh, now());
      if (classified !== null) {
        releaseBody(res);
        const marker = challengeMarkerOf(status, rh);
        return fail(classified, { status, hops: redirects.length, host: u.host, ...(marker !== null && { marker }) }, meta);
      }
      phase = "total";
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;
      try {
        if (res.body !== null)
          for await (const chunk of res.body) {
            if (total + chunk.byteLength > o.maxBytes) {
              if (o.overflow === "fail") {
                releaseBody(res);
                return fail({ class: "too_large" }, { bytes: total + chunk.byteLength, cap: o.maxBytes }, meta);
              }
              chunks.push(chunk.subarray(0, o.maxBytes - total));
              total = o.maxBytes;
              truncated = true;
              releaseBody(res);
              break;
            }
            total += chunk.byteLength;
            chunks.push(chunk);
          }
      } catch (e) {
        if (controller.signal.aborted) return stopped(meta);
        const t = transportFailure(e);
        return fail({ class: t.class, reason: t.reason }, { host: u.host, hops: redirects.length, errorClass: t.reason }, meta);
      }
      return { ok: true, meta, bytes: Buffer.concat(chunks), truncated };
    }
  };
  try {
    return await Promise.race([work(), aborted]);
  } catch {
    return stopped({});
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
