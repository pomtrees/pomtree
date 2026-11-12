// The kit's HTTP surface for adapters. Every request carries the project's fetch User-Agent (`workflow.fetch.userAgent`,
// injected here; adapters never invent their own string), and TLS material (`ca`, `cert`, `key`) is applied per call, never
// process-wide. Raw `node:https` and `node:tls` stay inside this package.

import type { Duplex } from "node:stream";
import { redact, redactUrl } from "./redact.ts";

// Default when no `workflow.fetch.userAgent` value is injected.
export const DEFAULT_USER_AGENT = "pomtree";

export interface TlsOptions {
  ca?: string;
  cert?: string;
  key?: string;
}

export interface RequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  // Applied to this call only. A second call without it carries none.
  tls?: TlsOptions;
  // Resolve on an HTTP upgrade (WebSocket handshake) with the raw socket in `socket`.
  upgrade?: boolean;
  signal?: AbortSignal;
  // Cap on the buffered response body; the socket is destroyed and the call rejected when exceeded. Default 16 MiB.
  maxBytes?: number;
  // Reject and destroy the socket when no complete response (or upgrade) arrives in time. Default 60 s for plain requests,
  // none for `upgrade` (a long-lived stream).
  timeoutMs?: number;
}

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface KitResponse {
  status: number;
  // Lower-cased names; repeated headers are joined with ", ".
  headers: Record<string, string>;
  body: Uint8Array;
  // Present only when `upgrade` was requested and the server switched protocols; `head` holds bytes read past the headers.
  socket?: Duplex;
  head?: Uint8Array;
}

// The stamped call a transport receives: the user-agent header is already set.
export type Transport = (url: string, init: RequestInit) => Promise<KitResponse>;
export type RequestFn = (url: string, init: RequestInit) => Promise<KitResponse>;

// TODO(kit-fetch-identity): one helper so any adapter's fetching uses `workflow.fetch.userAgent`; current behavior: createRequest takes the agent
// string as a parameter and falls back to DEFAULT_USER_AGENT, so each adapter must pass the configured value itself.
// TODO(kit-request-assignability): createRequest is not compile-checked against core's SandboxRequestFn types (the kit does not depend on core);
// the first task importing both adds the assignability check.
// What `createRequest` returns: the request function plus a WebSocket opener bound to the same User-Agent, so an adapter
// cannot forget the stamp. `wss` per-call TLS is not supported by the global WebSocket (it has no ca/cert/key options); an
// adapter that needs client certificates uses the hand-rolled client WebSocket over `request` with `upgrade` instead.
export interface Requester extends RequestFn {
  openWebSocket(url: string, init?: Omit<WebSocketInit, "userAgent">): WebSocket;
}

export interface CreateRequestOptions {
  userAgent?: string;
  // Tests inject a transport; the default is node:http(s).
  transport?: Transport;
  // Defaults applied to calls that do not set their own.
  maxBytes?: number;
  timeoutMs?: number;
}

const USER_AGENT_HEADER = "user-agent";

function stamp(headers: Record<string, string> | undefined, userAgent: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() !== USER_AGENT_HEADER) out[k] = v;
  out[USER_AGENT_HEADER] = userAgent;
  return out;
}

export function createRequest(opts: CreateRequestOptions = {}): Requester {
  const userAgent = opts.userAgent?.trim() ? opts.userAgent : DEFAULT_USER_AGENT;
  const transport = opts.transport ?? nodeTransport;
  const call: RequestFn = async (url, init) => {
    const stamped: RequestInit = {
      ...init,
      headers: stamp(init.headers, userAgent),
      maxBytes: init.maxBytes ?? opts.maxBytes ?? DEFAULT_MAX_BYTES,
    };
    const timeoutMs = init.timeoutMs ?? opts.timeoutMs ?? (init.upgrade ? undefined : DEFAULT_TIMEOUT_MS);
    if (timeoutMs !== undefined) stamped.timeoutMs = timeoutMs;
    return transport(url, stamped);
  };
  return Object.assign(call, {
    openWebSocket: (url: string, init: Omit<WebSocketInit, "userAgent"> = {}) => openWebSocket(url, { ...init, userAgent }),
  });
}

// The node:http(s) options for one call. Pure. Only `ca`, `cert` and `key` are copied out of `tls` (each must be a string), so
// a loose caller cannot pass `agent`, `rejectUnauthorized` or `headers` through it; `agent: false` (a connection of its own,
// so TLS material cannot reach a pooled socket) and the stamped headers are set last.
export function buildHttpOptions(init: RequestInit): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["ca", "cert", "key"] as const) {
    const v = (init.tls as Record<string, unknown> | undefined)?.[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") throw new Error(`tls.${k} must be a non-empty PEM string; pass the PEM text, not a path or buffer`);
    out[k] = v;
  }
  return { ...out, method: init.method, signal: init.signal, agent: false, headers: init.headers };
}

async function nodeTransport(url: string, init: RequestInit): Promise<KitResponse> {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(`request to ${redactUrl(url)} uses the unsupported scheme ${target.protocol}; use an http: or https: URL`);
  }
  if (target.protocol === "http:" && init.tls !== undefined) {
    throw new Error(`request to ${redactUrl(url)} passes TLS options over plain http; use an https: URL or drop the tls option`);
  }
  const options = buildHttpOptions(init);
  const mod = target.protocol === "https:" ? await import("node:https") : await import("node:http");
  const where = redactUrl(url);
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise<KitResponse>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    const fail = (e: unknown, action = "Check the endpoint address, network reachability and TLS settings, then retry.") =>
      done(() => {
        req.destroy();
        reject(new Error(`request ${init.method} ${where} failed: ${redact(e instanceof Error ? e.message : String(e))}. ${action}`));
      });
    const req = mod.request(target, options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          fail(
            `response body exceeded ${maxBytes} bytes`,
            "Raise maxBytes if this response is expected to be large, or check that the endpoint is the right one.",
          );
          return;
        }
        chunks.push(c);
      });
      res.on("error", fail);
      res.on("end", () => done(() => resolve({ status: res.statusCode ?? 0, headers: flatten(res.headers), body: Buffer.concat(chunks) })));
    });
    if (init.timeoutMs !== undefined) {
      timer = setTimeout(
        () => fail(`no complete response within ${init.timeoutMs} ms`, "Check that the endpoint is reachable and responsive, or raise timeoutMs."),
        init.timeoutMs,
      );
    }
    req.on("error", fail);
    if (init.upgrade) {
      req.on("upgrade", (res, socket, head) =>
        done(() => resolve({ status: res.statusCode ?? 101, headers: flatten(res.headers), body: new Uint8Array(), socket, head })),
      );
    }
    req.end(init.body);
  });
}

function flatten(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

// ---- WebSocket with headers ----

export interface WebSocketInit {
  headers?: Record<string, string>;
  protocols?: string | string[];
  userAgent?: string;
  // Tests inject a constructor; the default is Node's global WebSocket, whose second argument accepts `headers` (an undici
  // extension, not a browser standard, so it is wrapped here in one place).
  WebSocketImpl?: WebSocketCtor;
}

export type WebSocketCtor = new (url: string, options?: { headers?: Record<string, string>; protocols?: string | string[] }) => WebSocket;

export function openWebSocket(url: string, init: WebSocketInit = {}): WebSocket {
  const Impl = init.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
  if (Impl === undefined) throw new Error("this runtime has no global WebSocket; run on Node 22 or newer, or inject WebSocketImpl");
  const headers = stamp(init.headers, init.userAgent?.trim() ? init.userAgent : DEFAULT_USER_AGENT);
  return new Impl(url, init.protocols === undefined ? { headers } : { headers, protocols: init.protocols });
}
