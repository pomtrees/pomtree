import { chmodSync, closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import type { StreamConnection, StreamRouteDef } from "@pomtree/core";
import { handle } from "./api.ts";
import { issueUiCookie, verifyToken, verifyUiCookie } from "./auth.ts";
import type { Daemon } from "./daemon.ts";
import { redactPath } from "@pomtree/core";
import { formatAccessLine, oneLine, principalLabel, shouldLog } from "./accesslog.ts";
import type { AccessLogMode, AccessSink, ListenerKind, PrincipalLike } from "./accesslog.ts";
import { bootId, formatLock, lockHeld, parseLock, processStart } from "./state-lock.ts";
import type { LockRecord } from "./state-lock.ts";
import { renderLoginPage, renderUiShell, UI_COOKIE_TTL_MS } from "./ui.ts";
import { IDEMPOTENCY_EXT_KEY_REQUIRED, extensionKeyMissing } from "./error-codes.ts";
import { matchExtensionRoute, matchRoute, scopeAllows } from "./route-match.ts";
import type { AuthedExtensionRequest } from "./route-match.ts";
import { handleTransfer, matchTransfer } from "./transfer-route.ts";
import { egressAuditReport, evaluateReadiness } from "./health.ts";
import type { EgressAuditStatusLike, Readiness } from "./health.ts";
import { closeTerminals, handleTerminalUpgrade } from "./terminal-route.ts";
import type { TerminalRouteOpts } from "./terminal-route.ts";
import { closeBrowsers, handleBrowserUpgrade, isBrowserPath } from "./browser-route.ts";
import type { BrowserRouteOpts } from "./browser-route.ts";
import { VENDOR_URL_PREFIX, readInboxScript, readVendorAsset } from "./terminal-assets.ts";

// Every JSON body, /v1/state/* included. A state document PUT always fits because the configurable per-document maximum
// (STATE_DOC_BYTES_CONFIG_MAX in core) leaves room for the request envelope; the pomtree CLI batches imports under it.
export const MAX_BODY = 1 << 20;
// Explicit request/header timeouts: a slowloris on the operator socket or an agent
// endpoint must not pin a handler forever. The server-level defaults are set on every server in makeServer.
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
// TODO(fd-limits): connection and SSE caps are static; there is no per-token rate limit.
export const MAX_CONNECTIONS = 1024;
export const MAX_SSE_STREAMS = 64;
export const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_BUFFERED = 1 << 20;
let sseStreams = 0;

// Register an SSE stream against the global cap; returns a release fn, or null when at capacity.
function acquireSse(res: ServerResponse, req: IncomingMessage, heartbeatMs: number): (() => void) | null {
  if (sseStreams >= MAX_SSE_STREAMS) return null;
  sseStreams++;
  let released = false;
  const timer = setInterval(() => {
    // A client that is not draining (writable buffer past the cap) is dropped rather than buffered forever.
    if (res.writableLength > SSE_MAX_BUFFERED) {
      res.destroy();
      return;
    }
    try {
      res.write(": hb\n\n");
    } catch {
      /* client gone */
    }
  }, heartbeatMs);
  timer.unref();
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    sseStreams--;
  };
  req.on("close", release);
  res.on("close", release);
  return release;
}

// Writes to an SSE response; drops a slow consumer whose buffer has grown past the cap.
function sseWrite(res: ServerResponse, frame: string): void {
  if (res.writableLength > SSE_MAX_BUFFERED) {
    res.destroy();
    return;
  }
  try {
    res.write(frame);
  } catch {
    /* client gone */
  }
}

// Access log: process-wide default (set once by main from accessLog.mode; "off" until configured so
// library/test use stays quiet) with a per-server override for tests.
let defaultAccess: { mode: AccessLogMode; sink: AccessSink } = { mode: "off", sink: (l) => console.log(l) };
export function configureAccessLog(mode: AccessLogMode, sink?: AccessSink): void {
  defaultAccess = { mode, sink: sink ?? defaultAccess.sink };
}

// Per-request facts gathered along the way for the access line and error logging.
export interface ReqCtx {
  listener?: ListenerKind;
  startTime?: number;
  principal: PrincipalLike;
  hadCredential: boolean;
  error?: string;
  detail?: string;
  sse?: boolean;
  logged?: boolean;
}
export const ctxs = new WeakMap<ServerResponse | IncomingMessage, ReqCtx>();

// One access line for a request or upgrade attempt, through the same formatter, filter and sink for both.
function accessEmitter(access: { mode: AccessLogMode; sink: AccessSink }, listener: ListenerKind, req: IncomingMessage, ctx: ReqCtx, t0: number) {
  return (status: number, note?: string): void => {
    if (!shouldLog(access.mode, status)) return;
    try {
      access.sink(
        formatAccessLine({
          at: new Date(),
          listener,
          method: req.method ?? "?",
          url: req.url ?? "/",
          status,
          durationMs: Date.now() - t0,
          principal: ctx.principal,
          hadCredential: ctx.hadCredential,
          ...(ctx.error !== undefined && { error: ctx.error }),
          ...(ctx.detail !== undefined && { detail: ctx.detail }),
          ...(note !== undefined && { note }),
        }),
      );
    } catch {
      /* logging must never affect a request */
    }
  };
}

export interface ExtractedError {
  name: string;
  message: string;
  code?: string;
  cause?: unknown;
  stack?: string;
}

export function isAbortError(e: unknown, depth = 0): boolean {
  if (!e || depth > 5) return false; // depth bound: a cyclic `cause` chain must not recurse forever
  if (typeof e === "string") {
    const s = e.toLowerCase();
    return s === "aborted" || s === "premature close";
  }
  if (typeof e === "object") {
    const err = e as { name?: string; message?: string; code?: string; cause?: unknown };
    if (err.name === "AbortError") return true;
    if (
      err.code === "ECONNRESET" ||
      err.code === "ECONNABORTED" ||
      err.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      err.code === "ECANCELED" ||
      err.code === "EPIPE" ||
      err.code === "ABORT_ERR" ||
      err.code === "UND_ERR_ABORTED" ||
      err.code === "ERR_HTTP_REQUEST_TIMEOUT" ||
      err.code === "HPE_INVALID_EOF_STATE"
    ) {
      return true;
    }
    if (typeof err.message === "string") {
      const msg = err.message.toLowerCase();
      if (msg === "aborted" || msg === "premature close" || msg === "the operation was aborted" || msg === "request aborted" || msg === "socket hang up") {
        return true;
      }
    }
    if (err.cause && isAbortError(err.cause, depth + 1)) return true;
  }
  return false;
}

const safeString = (v: unknown): string => {
  try {
    return String(v);
  } catch {
    return "(unprintable)";
  }
};

export function extractError(e: unknown): ExtractedError {
  if (e instanceof Error) {
    return {
      name: e.name || "Error",
      message: e.message,
      code: (e as NodeJS.ErrnoException).code,
      cause: (e as { cause?: unknown }).cause,
      stack: e.stack,
    };
  }
  if (typeof e === "object" && e !== null) {
    const obj = e as { name?: string; message?: string; code?: string; cause?: unknown; stack?: string };
    return {
      name: typeof obj.name === "string" ? obj.name : "Error",
      message: typeof obj.message === "string" ? obj.message : safeString(e),
      code: typeof obj.code === "string" ? obj.code : undefined,
      cause: obj.cause,
      stack: typeof obj.stack === "string" ? obj.stack : undefined,
    };
  }
  return {
    name: "Error",
    message: safeString(e),
  };
}

export function formatErrorDetail(err: ExtractedError): string {
  const parts: string[] = [];
  if (err.name && err.name !== "Error") {
    parts.push(err.name);
  }
  const msg = oneLine(err.message || "(no message)");
  if (parts.length > 0) {
    parts.push(`: ${msg}`);
  } else {
    parts.push(msg);
  }
  if (err.code) {
    parts.push(` [code=${oneLine(err.code, 60)}]`);
  }
  if (err.cause !== undefined) {
    let causeStr: string;
    if (err.cause instanceof Error) {
      const causeCode = (err.cause as NodeJS.ErrnoException).code;
      const base = err.cause.name !== "Error" ? `${err.cause.name}: ${err.cause.message}` : err.cause.message;
      causeStr = causeCode ? `${base} [code=${causeCode}]` : base;
    } else {
      causeStr = safeString(err.cause);
    }
    parts.push(` (cause: ${oneLine(causeStr)})`);
  }
  return parts.join("");
}

export function formatRequestContext(c?: ReqCtx, req?: IncomingMessage): string {
  const parts: string[] = [];
  if (c?.listener) parts.push(c.listener);
  if (req?.method) parts.push(oneLine(req.method, 10));
  if (req?.url) parts.push(redactPath(req.url));
  if (c?.startTime !== undefined) parts.push(`${Math.max(0, Math.round(Date.now() - c.startTime))}ms`);
  const princ = c?.principal ? ((c.principal as { id?: string }).id ?? principalLabel(c.principal)) : undefined;
  if (princ && princ !== "anon") parts.push(oneLine(princ, 100));
  return parts.join(" ");
}

function logRequestErrorUnsafe(agentOnly: boolean, e: unknown, req?: IncomingMessage, res?: ServerResponse): void {
  const c = (res && ctxs.get(res)) || (req && ctxs.get(req));
  const err = extractError(e);
  const msg = err.message;
  if (c && !c.detail) c.detail = msg;
  if (c?.logged) return;

  const isAbort = isAbortError(e);
  if (c?.sse && (isAbort || req?.destroyed)) {
    if (c) c.logged = true;
    return;
  }
  if (c) c.logged = true;

  const endpoint = agentOnly ? "agent" : "operator";
  const action = isAbort ? "request aborted" : "request failed";
  const ctxStr = formatRequestContext(c, req);
  const header = ctxStr ? `pomtreed: ${endpoint} ${action} (${ctxStr})` : `pomtreed: ${endpoint} ${action}`;
  const detail = formatErrorDetail(err);
  const line = `${header}: ${detail}`;

  if (!isAbort && err.stack) {
    // Indent continuation lines so a message carrying newlines cannot forge a `pomtreed:` log line.
    console.error(`${line}\n  ${err.stack.replace(/\r?\n/g, "\n  ")}`);
  } else {
    console.error(line);
  }
}

// Logging must never throw (it runs in error paths and socket hooks): any failure here is swallowed.
export function logRequestError(agentOnly: boolean, e: unknown, req?: IncomingMessage, res?: ServerResponse): void {
  try {
    logRequestErrorUnsafe(agentOnly, e, req, res);
  } catch {
    /* logging must never affect a request */
  }
}

// 'clientError' hands us only a socket; node keeps the in-flight request/response in private fields, so
// probe them defensively (shape may change across node versions) and fall back to no context.
export function socketRequestContext(socket: unknown): { req?: IncomingMessage; res?: ServerResponse } {
  try {
    const s = socket as { parser?: { incoming?: unknown }; _httpMessage?: unknown } | null;
    const req = s?.parser?.incoming;
    const res = s?._httpMessage;
    return {
      ...(typeof req === "object" && req !== null && { req: req as IncomingMessage }),
      ...(typeof res === "object" && res !== null && { res: res as ServerResponse }),
    };
  } catch {
    return {};
  }
}

// Send a JSON (or pre-serialized raw) response, but never write to a response that has already begun or
// been torn down — an error path can race the normal one (e.g. a body read abort firing `req.on("error")`
// while the async listener is also rejecting).
function sendJson(res: ServerResponse, status: number, body: unknown, contentType?: string, headers?: Record<string, string>): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const c = ctxs.get(res);
  if (c && status >= 400 && typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string")
    c.error = (body as { error: string }).error;
  res.writeHead(status, { "content-type": contentType ?? "application/json", ...(headers ?? {}) });
  res.end(contentType !== undefined ? (body as Buffer) : JSON.stringify(body));
}

type BodyResult = { body: unknown } | { error: { status: number; body: unknown } };

// Read the body once: raw bytes (capped) for rawBody extension routes, JSON otherwise.
async function readBody(req: IncomingMessage, o: { raw: boolean; maxBytes: number }): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > o.maxBytes) return { error: { status: 413, body: { error: o.raw ? "report too large" : "body too large" } } };
    chunks.push(c as Buffer);
  }
  if (o.raw) return { body: Buffer.concat(chunks) };
  if (chunks.length === 0) return { body: undefined };
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: { status: 400, body: { error: "invalid JSON" } } };
  }
}

async function handleRequest(
  daemon: Daemon,
  agentOnly: boolean,
  hostOnly: boolean,
  heartbeatMs: number,
  vendorDir: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const send = (status: number, body: unknown, contentType?: string, headers?: Record<string, string>) => sendJson(res, status, body, contentType, headers);

  // Live view and reports are served by the built-in observe extension; the operator UI (/ui) is a
  // core route special-cased below. The URL is parsed up front so the auth/
  // route/stream logic below is shared.
  const url = new URL(req.url ?? "/", "http://pomtreed");

  // Verify the Authorization header BEFORE buffering the body, so an unauthenticated caller cannot force
  // a large read on the agent TCP endpoint. A valid UI session cookie also grants operator scope, so the
  // operator browser's inline fetches authenticate without a Bearer header.
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  let principal = token ? verifyToken(daemon.deps.secret, token) : null;
  let viaCookie = false;
  const rc = ctxs.get(res);
  if (rc) rc.hadCredential = token !== undefined || req.headers.cookie !== undefined;
  if (!principal && req.headers.cookie !== undefined && verifyUiCookie(daemon.deps.secret, req.headers.cookie)) {
    principal = { scope: "operator" };
    viaCookie = true;
  }
  if (rc && principal) rc.principal = principal as PrincipalLike;
  // Cookie-authenticated state changes must come from this origin (SameSite=Strict alone is weak across
  // ports on one host): a present Origin header whose host differs from Host is refused.
  if (principal && viaCookie && req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed */
      }
      if (originHost !== req.headers.host) return send(403, { error: "cross-origin request refused" });
    }
  }

  // UI write routes also need a custom header: a cross-origin page cannot set it without a CORS preflight, which pomtreed never grants.
  if (principal && req.method === "POST" && url.pathname.startsWith("/v1/ui/") && req.headers["x-pomtree-ui"] !== "1") {
    return send(403, { error: "X-Pomtree-UI: 1 header required" });
  }

  // The host (messaging adapter) TCP endpoint: host credentials on /v1/messages (and /v1/messages/failed), and the three
  // GET host read shapes (/v1/host/agents, /v1/host/agents/:id/budget|report) only.
  if (hostOnly) {
    if (principal?.scope !== "host") return send(401, { error: "this endpoint accepts host credentials only" });
    const hostRead = /^\/v1\/host\/agents(?:\/[^/]+\/(?:budget|report))?$/.test(url.pathname) && req.method === "GET";
    if (url.pathname !== "/v1/messages" && url.pathname !== "/v1/messages/failed" && !hostRead) return send(404, { error: "not found" });
    const hb = await readBody(req, { raw: false, maxBytes: MAX_BODY });
    if ("error" in hb) return send(hb.error.status, hb.error.body);
    const hout = await handle(daemon, { method: req.method ?? "GET", url: req.url ?? "/", body: hb.body, token });
    if (rc && hout.detail) rc.detail = hout.detail;
    return send(hout.status, hout.body, hout.contentType, hout.headers);
  }

  // The agent TCP endpoint accepts agent credentials only; public extension routes are operator-socket only.
  if (agentOnly && principal?.scope !== "agent") {
    return send(401, { error: "this endpoint accepts agent credentials only" });
  }

  // Operator browser login: accepts the operator token (Bearer or a JSON `token` body), verifies
  // operator scope, and sets the HttpOnly UI session cookie.
  if (!agentOnly && req.method === "POST" && url.pathname === "/ui/login") {
    let loginToken = token;
    if (!loginToken) {
      const bodyResult = await readBody(req, { raw: false, maxBytes: MAX_BODY });
      if ("error" in bodyResult) return send(bodyResult.error.status, bodyResult.error.body);
      const b = (typeof bodyResult.body === "object" && bodyResult.body !== null && !Array.isArray(bodyResult.body) ? bodyResult.body : {}) as Record<
        string,
        unknown
      >;
      if (typeof b.token === "string" && b.token) loginToken = b.token;
    }
    const loginPrincipal = loginToken ? verifyToken(daemon.deps.secret, loginToken) : null;
    if (loginPrincipal?.scope !== "operator") {
      return send(loginPrincipal ? 403 : 401, { error: loginPrincipal ? "operator scope required" : "missing or invalid token" });
    }
    const secure = (req.socket as { encrypted?: boolean }).encrypted === true || req.headers["x-forwarded-proto"] === "https";
    const cookie = issueUiCookie(daemon.deps.secret, UI_COOKIE_TTL_MS);
    return send(200, { ok: true }, undefined, { "set-cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}` });
  }

  // Logout: expire the session cookie (same attributes as login). A present cross-origin Origin is refused
  // so a third-party page cannot sign the operator out.
  if (!agentOnly && req.method === "POST" && url.pathname === "/ui/logout") {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed */
      }
      if (originHost !== req.headers.host) return send(403, { error: "cross-origin request refused" });
    }
    const secure = (req.socket as { encrypted?: boolean }).encrypted === true || req.headers["x-forwarded-proto"] === "https";
    return send(200, { ok: true }, undefined, { "set-cookie": `pomtreed_ui=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}` });
  }

  // The Inbox pane's script (script-src 'self'): operator session only, never cached so it tracks the daemon build.
  if (!agentOnly && req.method === "GET" && readInboxScript(url.pathname)) {
    if (principal?.scope !== "operator") return send(principal ? 403 : 401, { error: principal ? "operator scope required" : "missing or invalid token" });
    const script = readInboxScript(url.pathname)!;
    return send(200, script.body, script.contentType, { "x-content-type-options": "nosniff", "cache-control": "no-store" });
  }

  // xterm.js and its addons for the terminal view: a fixed whitelist, operator session only.
  if (!agentOnly && req.method === "GET" && url.pathname.startsWith(VENDOR_URL_PREFIX)) {
    if (principal?.scope !== "operator") return send(principal ? 403 : 401, { error: principal ? "operator scope required" : "missing or invalid token" });
    const asset = readVendorAsset(url.pathname, vendorDir);
    if (!asset) return send(404, { error: "not found" });
    return send(200, asset.body, asset.contentType, { "x-content-type-options": "nosniff", "cache-control": "public, max-age=31536000, immutable" });
  }

  // The operator UI: the shell for an operator session (cookie or Bearer), otherwise a minimal login page
  // (an unauthenticated browser would only see 401s from the shell's data calls).
  if (!agentOnly && req.method === "GET" && url.pathname === "/ui") {
    // TODO(ui-hardening): 'unsafe-inline' is needed until the shell's inline scripts move to static files.
    return send(200, principal?.scope === "operator" ? renderUiShell() : renderLoginPage(), "text/html; charset=utf-8", {
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
  }

  // Extension routes run ahead of the core handle. Scope (including the operator-or-agent case, where
  // two routes share a path with different scopes) is resolved before the body is read.
  const ext = matchExtensionRoute(daemon.deps.extensionHost?.routes() ?? [], req.method ?? "GET", url.pathname, principal, agentOnly);
  if (ext.kind === "denied") {
    return send(principal ? 403 : 401, { error: principal ? "forbidden" : "missing or invalid token" });
  }
  if (ext.kind === "match") {
    const bodyResult = await readBody(req, { raw: ext.def.rawBody === true, maxBytes: ext.def.maxBodyBytes ?? MAX_BODY });
    if ("error" in bodyResult) return send(bodyResult.error.status, bodyResult.error.body);
    if (extensionKeyMissing(req.method ?? "GET", bodyResult.body, url.searchParams)) return send(400, { error: IDEMPOTENCY_EXT_KEY_REQUIRED });
    const extReq: AuthedExtensionRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      params: ext.params,
      query: url.searchParams,
      body: bodyResult.body,
      principal,
    };
    try {
      const out = await ext.def.handler(extReq);
      return send(out.status, out.body, out.contentType, out.headers);
    } catch (e) {
      logRequestError(agentOnly, e, req, res);
      return send(500, { error: "internal error" });
    }
  }

  // SSE stream routes: matched like ordinary routes, but instead of a response body the handler writes
  // frames over a StreamConnection. The token/scope is checked first (token-before-body: no body is read
  // for a stream), then the SSE headers go out and the handler owns the connection until it ends it or
  // the client closes.
  const extStreams = daemon.deps.extensionHost?.streams() ?? [];
  const stream = matchRoute(extStreams, req.method ?? "GET", url.pathname);
  if (stream) {
    if (!scopeAllows(stream.def.scope, principal, agentOnly)) {
      return send(principal ? 403 : 401, { error: principal ? "forbidden" : "missing or invalid token" });
    }
    if (!acquireSse(res, req, heartbeatMs)) return send(503, { error: "too many streams" });
    if (rc) rc.sse = true;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const conn: StreamConnection = {
      write: (frame) => sseWrite(res, frame),
      end: () => {
        res.end();
      },
      onClose: (cb) => {
        req.on("close", cb);
        res.on("close", cb);
      },
    };
    // EventSource resumes with a Last-Event-ID header (not a URL change); streams read it as the `lastEventId` query value.
    const lastEventId = req.headers["last-event-id"];
    if (typeof lastEventId === "string") url.searchParams.set("lastEventId", lastEventId);
    const extReq: AuthedExtensionRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      params: stream.params,
      query: url.searchParams,
      body: undefined,
      principal,
    };
    try {
      await stream.def.handler(extReq, conn);
    } catch (e) {
      logRequestError(agentOnly, e, req, res);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  if (!principal) return send(401, { error: "missing or invalid token" });

  // `pomtree push` / `pomtree pull` stream raw bundle bytes, so they bypass the JSON body reader below.
  const transfer = matchTransfer(req.method ?? "GET", url.pathname);
  if (transfer) return handleTransfer(daemon, principal, transfer, url, req, res);

  // The extension verb table, for `pomtree` autocomplete / help (operator only).
  if (req.method === "GET" && url.pathname === "/v1/ext/commands") {
    if (principal.scope !== "operator") return send(403, { error: "operator scope required" });
    return send(200, daemon.deps.extensionHost?.verbs() ?? []);
  }

  // Report publish is an extension route (rawBody); only the generic JSON body reader
  // remains before the core handler.
  const bodyResult = await readBody(req, { raw: false, maxBytes: MAX_BODY });
  if ("error" in bodyResult) return send(bodyResult.error.status, bodyResult.error.body);
  const out = await handle(daemon, {
    method: req.method ?? "GET",
    url: req.url ?? "/",
    body: bodyResult.body,
    token,
    cookie: req.headers.cookie,
  });
  if (rc && out.detail) rc.detail = out.detail;
  send(out.status, out.body, out.contentType, out.headers);
}

async function probe(
  daemon: Daemon,
  path: string,
  allowSandboxDown: boolean,
  egressAuditStatus: (() => EgressAuditStatusLike) | undefined,
  res: ServerResponse,
): Promise<void> {
  if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
  let r: Readiness;
  let backend: Awaited<ReturnType<Daemon["doctor"]>>["backend"];
  try {
    const d = await daemon.doctor();
    r = evaluateReadiness({ storeOpen: true, sandboxUp: d.sandboxUp, journalFailed: d.journalFailed, degraded: d.degraded }, { allowSandboxDown });
    backend = d.backend && { id: d.backend.id, ...(d.backend.engine && { engine: { binary: d.backend.engine.binary } }) }; // unauthenticated: no socket path, source or via
  } catch {
    r = evaluateReadiness({ storeOpen: false, sandboxUp: false, journalFailed: false, degraded: false }, { allowSandboxDown });
  }
  // Next to the reasons, informational: omitted when no collector is wired (audit disabled).
  let egressAudit: ReturnType<typeof egressAuditReport> | undefined;
  try {
    egressAudit = egressAuditStatus && egressAuditReport(egressAuditStatus());
  } catch {
    // an unreadable spool root must not break the probe; ingestion reports it
  }
  sendJson(res, r.ready ? 200 : 503, {
    status: r.ready ? "ready" : "unready",
    reasons: r.reasons,
    ...(backend && { backend }),
    ...(egressAudit && { egressAudit }),
  });
}

export function makeServer(
  daemon: Daemon,
  agentOnly: boolean,
  opts: {
    requestTimeoutMs?: number;
    headersTimeoutMs?: number;
    hostOnly?: boolean;
    maxConnections?: number;
    heartbeatMs?: number;
    listener?: ListenerKind;
    accessLog?: { mode: AccessLogMode; sink: AccessSink };
    terminal?: TerminalRouteOpts;
    browser?: BrowserRouteOpts;
    vendorDir?: string;
    /** /readyz stays 200 while Docker is down (an explicit operator choice; readyz.allowSandboxDown). */
    readyzAllowSandboxDown?: boolean;
    /** The egress audit collector's status() for the /readyz body; omit when audit is disabled. */
    egressAuditStatus?: () => EgressAuditStatusLike;
  } = {},
): Server {
  const listener: ListenerKind = opts.listener ?? (opts.hostOnly ? "host-tcp" : agentOnly ? "agent-tcp" : "unix");
  const server = createServer();
  server.maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
  server.requestTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  server.headersTimeout = opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;

  // Malformed HTTP (a bad request line or headers) never reaches the request listener; node emits
  // 'clientError' instead and, by default, destroys the socket. Answer a 400 where possible and log, so
  // a garbage connection cannot take the process down or pass silently.
  server.on("clientError", (err, socket) => {
    const { req, res } = socketRequestContext(socket);
    logRequestError(agentOnly, err, req, res);
    if ((err as NodeJS.ErrnoException).code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    try {
      socket.end(`HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ error: "malformed request" })}`);
    } catch {
      socket.destroy();
    }
  });

  // Terminal and browser-view websockets (GET /v1/agents/:id/terminal and /browser): one access line per attempt (101 on success, the refusal status otherwise). Upgraded sockets leave
  // node's http connection tracking, so closeAllConnections (the shutdown path) is extended to close them too.
  server.on("upgrade", (req, socket, head) => {
    const t0 = Date.now();
    const ctx: ReqCtx = { listener, startTime: t0, principal: null, hadCredential: false };
    ctxs.set(req, ctx);
    const emit = accessEmitter(opts.accessLog ?? defaultAccess, listener, req, ctx, t0);
    const restricted = agentOnly || opts.hostOnly === true;
    void (
      isBrowserPath(req.url)
        ? handleBrowserUpgrade(daemon, opts.browser ?? {}, restricted, req, socket, head, ctx)
        : handleTerminalUpgrade(daemon, opts.terminal ?? {}, restricted, req, socket, head, ctx)
    )
      .then(emit)
      .catch((e) => {
        logRequestError(agentOnly, e, req);
        ctx.error = "internal error";
        emit(500);
        socket.destroy();
      });
  });
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    closeTerminals(daemon);
    closeBrowsers(daemon);
    closeAll();
  };

  server.on("request", (req, res) => {
    const access = opts.accessLog ?? defaultAccess;
    const t0 = Date.now();
    const ctx: ReqCtx = { listener, startTime: t0, principal: null, hadCredential: false };
    ctxs.set(res, ctx);
    ctxs.set(req, ctx);
    const emit = accessEmitter(access, listener, req, ctx, t0);
    // SSE: one line at open (headers flushed) and one at close; heartbeats are never logged.
    const origWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
    (res as { writeHead: unknown }).writeHead = (...a: unknown[]) => {
      const r = origWriteHead(...a);
      if (ctx.sse) emit(res.statusCode, "sse-open");
      return r;
    };
    res.once("close", () => emit(res.statusCode, ctx.sse ? "sse-close" : undefined));
    // An 'error' on the request stream (e.g. an aborted body read) is an unhandled-event crash by
    // default; swallow it here. The async listener rejection below is what sends the HTTP error.
    req.on("error", (e) => {
      logRequestError(agentOnly, e, req, res);
      if (!res.headersSent && !res.writableEnded) res.destroy();
    });
    // The async listener's rejection is NOT handled by node's http layer, so a throw in routing (a
    // malformed URL or percent-encoding), a body read (client abort), or a stream handler would
    // otherwise surface as an unhandledRejection and exit pomtreed. Map it to 400 (parse errors) or 500,
    // when headers are still unsent; a connection already streaming is just torn down.
    // Probes: unix socket only (mode 0600), unauthenticated, before any auth/body handling; see health.ts.
    if (listener === "unix" && req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) {
      void probe(daemon, req.url, opts.readyzAllowSandboxDown === true, opts.egressAuditStatus, res);
      return;
    }
    void handleRequest(daemon, agentOnly, opts.hostOnly === true, opts.heartbeatMs ?? SSE_HEARTBEAT_MS, opts.vendorDir, req, res).catch((e) => {
      logRequestError(agentOnly, e, req, res);
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      const isParseError = e instanceof URIError || (e instanceof TypeError && (e as NodeJS.ErrnoException).code === "ERR_INVALID_URL");
      try {
        sendJson(res, isParseError ? 400 : 500, { error: isParseError ? "malformed request" : "internal error" });
      } catch {
        res.destroy();
      }
    });
  });

  return server;
}

// Whether a unix socket is currently accepting connections (a live daemon). Used before unlinking the
// socket so a second pomtreed never steals the path out from under a live one (the pidfile lock is the
// primary guard; this check is the second guard against stealing a live socket).
function socketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(socketPath);
    let settled = false;
    const finish = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    s.once("connect", () => {
      finish(true);
      s.destroy();
    });
    s.once("error", () => finish(false));
  });
}

// The operator endpoint: a unix socket at mode 0600. The listen() call is wrapped in a tightened umask so
// the socket is created 0600 from the start (no world-readable window before the chmodSync), and a live
// socket is never unlinked (see socketLive).
export async function listen(
  daemon: Daemon,
  socketPath: string,
  opts: { readyzAllowSandboxDown?: boolean; egressAuditStatus?: () => EgressAuditStatusLike } = {},
): Promise<Server> {
  if (await socketLive(socketPath)) {
    throw new Error(`pomtreed: another daemon is already listening on ${socketPath}; refusing to steal the socket`);
  }
  rmSync(socketPath, { force: true });
  const server = makeServer(daemon, false, { listener: "unix", ...opts });
  const prev = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(prev);
  }
  chmodSync(socketPath, 0o600);
  return server;
}

// Agent-facing TCP endpoint for sandboxes that cannot mount the unix socket (Docker Desktop).
// Operator tokens are rejected here, so a leaked bind address never exposes operator power.
// Bind 127.0.0.1 by default; on Linux, containers reach the host via the docker bridge, so 0.0.0.0 (or the bridge IP) must be configured explicitly.
export async function listenAgents(daemon: Daemon, host: string, port: number): Promise<{ server: Server; port: number }> {
  const server = makeServer(daemon, true);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}

// Host (messaging adapter) TCP endpoint: host-scoped credentials on /v1/messages only, so an adapter that
// cannot reach the operator unix socket can still poll/post. Operator and agent tokens are rejected.
export async function listenHost(daemon: Daemon, host: string, port: number): Promise<{ server: Server; port: number }> {
  const server = makeServer(daemon, false, { hostOnly: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}

// Operator browser UI TCP endpoint (POMTREED_UI_LISTEN): the full operator surface (shell, login, and the
// cookie-authenticated read/write routes) over TCP so a browser can reach it without the unix socket.
export async function listenUi(daemon: Daemon, host: string, port: number): Promise<{ server: Server; port: number }> {
  const server = makeServer(daemon, false, { listener: "ui" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}

// --- single-instance pidfile lock ---
// The pidfile + socket checks close the "second pomtreed steals the state dir" hole, but a stale takeover
// that races a still-draining first daemon can still let reconcile() touch containers a newer epoch owns.
// Containers are stamped with daemon_epoch/store_id labels and reconcile filters on them (daemon.ts ownsSandbox),
// which bounds that race.

function readLock(lockPath: string): LockRecord | null {
  try {
    return parseLock(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the pid exists but is owned by someone else; still alive for our purposes.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Take an exclusive O_EXCL pidfile lock on the state dir at startup. A live holder aborts startup; a
// stale lock (dead pid, empty/corrupt file) is taken over. Returns a release function that only unlinks
// the lock if it still names this process (so a stale takeover never removes a successor's lock).
export function acquireStateLock(stateDir: string, hooks: { afterJudgedStale?: () => void } = {}): () => void {
  const lockPath = join(stateDir, "pomtreed.lock");
  for (let attempt = 0; ; attempt++) {
    // Publish the pid atomically: write a private temp file, then hard-link it into place (EEXIST if
    // held). A reader never sees an empty lock, so an empty/corrupt lock really is stale.
    const tmp = `${lockPath}.${process.pid}.${attempt}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, formatLock({ pid: process.pid, boot: bootId(), start: processStart(process.pid) }));
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, lockPath);
    } catch (e) {
      unlinkSync(tmp);
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held only if the pid is alive AND is the same process (same boot, same start time) that took the
      // lock; a reused pid after reboot/kill -9 is stale. Missing identity fields = unknown, so fall back
      // to pid liveness alone.
      let raw: string | null = null;
      try {
        raw = readFileSync(lockPath, "utf8");
      } catch {
        // vanished between link and read: retry the exclusive create
      }
      const holder = raw === null ? null : parseLock(raw);
      if (raw !== null && holder !== null) {
        const alive = processAlive(holder.pid);
        if (alive && lockHeld(holder, alive, processStart(holder.pid), bootId())) {
          throw new Error(`pomtreed: state dir ${stateDir} is locked by another pomtreed (pid ${holder.pid}, lock ${lockPath})`);
        }
      }
      if (raw !== null) {
        hooks.afterJudgedStale?.();
        // Take over by atomically renaming the file aside, then verify we moved exactly the bytes we judged
        // stale. Never unlink by path: another starter may have replaced the lock since we read it.
        const tomb = `${lockPath}.${process.pid}.${attempt}.stale`;
        try {
          renameSync(lockPath, tomb);
          if (readFileSync(tomb, "utf8") === raw) {
            unlinkSync(tomb);
          } else {
            // We displaced a live successor's lock: put it back (link fails if a third starter already
            // took the path; that starter's own lock then stands). Either way we retry, never delete it.
            try {
              linkSync(tomb, lockPath);
            } catch {
              // path already re-taken
            }
            unlinkSync(tomb);
          }
        } catch {
          // lock vanished or raced with another starter; retry the exclusive create
        }
      }
      if (attempt >= 5) throw new Error(`pomtreed: could not acquire the state lock ${lockPath}`);
      continue;
    }
    unlinkSync(tmp);
    return () => {
      if (readLock(lockPath)?.pid === process.pid) {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      }
    };
  }
}
