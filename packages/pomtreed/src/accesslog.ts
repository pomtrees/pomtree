// Pure access-log formatting for pomtreed's foreground output: no fs, no sockets. One line per request.
// Never includes tokens, cookies, Authorization headers, or bodies.
import { MODEL_PROXY_CREDENTIAL_EXPIRED, redactPath } from "@pomtree/core";

export type AccessLogMode = "off" | "errors" | "all";
export type ListenerKind = "unix" | "agent-tcp" | "host-tcp" | "ui" | "model-proxy";
export type AccessSink = (line: string) => void;

// The effective mode of accessLog.mode (the registry refuses anything but auto, off, errors and all): auto is all on a TTY, else errors.
export function accessLogMode(mode: AccessLogMode | "auto", isTty: boolean): AccessLogMode {
  return mode === "auto" ? (isTty ? "all" : "errors") : mode;
}

export type PrincipalLike = { scope: "operator" } | { scope: "agent"; agent: string } | { scope: "host" } | { scope: "ext"; name: string } | null;

export function principalLabel(p: PrincipalLike): string {
  if (!p) return "anon";
  if (p.scope === "agent") return `agent:${p.agent}`;
  if (p.scope === "ext") return `ext:${p.name}`;
  return p.scope;
}

// `error` is the response's error code: a 401 whose code is MODEL_PROXY_CREDENTIAL_EXPIRED (the model proxy's expired key)
// is classed `credential-expired`, so an operator can tell a stale key from a wrong one.
export function authReason(status: number, hadCredential: boolean, error?: string): string | undefined {
  if (status === 401 && hadCredential && error === MODEL_PROXY_CREDENTIAL_EXPIRED) return MODEL_PROXY_CREDENTIAL_EXPIRED;
  if (status === 401) return hadCredential ? "invalid-credential" : "missing-credential";
  if (status === 403) return "forbidden-scope";
  return undefined;
}

export interface AccessEntry {
  at: Date;
  listener: ListenerKind;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  principal: PrincipalLike;
  hadCredential?: boolean;
  error?: string; // generic response error text
  detail?: string; // internal detail for 5xx (log only)
  note?: string; // e.g. "sse-open" / "sse-close"
  // Overrides the auth reason derived from status and credential (e.g. "missing-request-id").
  authReason?: string;
  // Model-proxy requests only (sanitized, bounded): the requested model, the upstream's status, micro-USD charged, the
  // upstream host and final path (no query), the call's error class and the upstream's scrubbed message.
  model?: string;
  upstreamStatus?: number;
  chargedMicros?: number;
  upstreamHost?: string;
  upstreamPath?: string;
  errorClass?: string;
  upstreamMessage?: string;
}

const clean = (s: string, n: number) => s.replace(/[\r\n]+/g, " ").slice(0, n);

// Single-line, bounded form of untrusted text for log lines: control characters become visible escapes.
export function oneLine(s: string, n = 500): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
  const t = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) =>
    c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

export function shouldLog(mode: AccessLogMode, status: number): boolean {
  return mode === "all" || (mode === "errors" && status >= 400);
}

export function formatAccessLine(e: AccessEntry): string {
  const parts = [
    e.at.toISOString(),
    e.listener,
    e.method.replace(/[^A-Z]/gi, "").slice(0, 10) || "?",
    redactPath(e.url),
    String(e.status),
    `${Math.round(e.durationMs)}ms`,
    principalLabel(e.principal),
  ];
  if (e.note) parts.push(e.note);
  if (e.model !== undefined) parts.push(`model=${JSON.stringify(clean(e.model, 80))}`);
  if (e.upstreamStatus !== undefined) parts.push(`upstream=${e.upstreamStatus}`);
  if (e.upstreamHost !== undefined) parts.push(`upstreamHost=${clean(e.upstreamHost, 255).replace(/[^A-Za-z0-9.:[\]-]/g, "_")}`);
  if (e.upstreamPath !== undefined) parts.push(`upstreamPath=${redactPath(e.upstreamPath)}`);
  if (e.chargedMicros !== undefined) parts.push(`charged=${e.chargedMicros}`);
  if (e.errorClass !== undefined) parts.push(`class=${e.errorClass.replace(/[^a-z0-9_]/g, "_").slice(0, 40)}`);
  if (e.upstreamMessage !== undefined) parts.push(`upstreamMessage=${JSON.stringify(clean(e.upstreamMessage, 200))}`);
  if (e.status >= 400) {
    const reason = e.authReason ?? authReason(e.status, e.hadCredential === true, e.error);
    if (reason && (e.status === 401 || e.status === 403)) parts.push(`auth=${reason}`);
    if (e.error) parts.push(`error=${JSON.stringify(clean(e.error, 200))}`);
    if (e.status >= 500 && e.detail) parts.push(`detail=${JSON.stringify(clean(e.detail, 500))}`);
  }
  return parts.join(" ");
}
