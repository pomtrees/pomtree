// The Kubernetes REST client: JSON over the kit's `createRequest` with per-call TLS, a bearer token or
// client certificate from a `KubeAuth`, and a fixed error map so the adapter reasons about outcomes, not status codes.
//
//   2xx            -> { kind: "ok" }
//   404            -> { kind: "not-found" }                       returned
//   409            -> { kind: "conflict", existing }              returned; the caller compares the spec hash (idempotent create)
//   401            -> re-read the credential once and retry once; still 401 -> SandboxUnavailableError("auth")
//   403            -> KubeForbiddenError                          thrown, names the missing permission
//   422 and other 4xx -> KubeInvalidError / KubeApiError          thrown
//   429            -> SandboxQuotaError via the kit's withRetry   thrown
//   5xx            -> KubeUnknownOutcomeError                     thrown; `applied` is "unknown" for a mutating call
//
// The Authorization value is never put in a message, a log field or an error property; messages are also passed through the kit's
// redaction with the live token as a literal.

import { SandboxQuotaError, SandboxUnavailableError } from "@pomtree/core";
import { redact, type KitResponse, type RequestFn } from "@pomtree/sandbox-kit";
import { type RetryPolicy, withRetry } from "@pomtree/sandbox-kit/retry";
import { BACKEND_ID } from "./pod.ts";
import type { KubeAuth, KubeCredentials } from "./auth.ts";

// The Status object the API server returns with an error.
export interface KubeStatus {
  kind?: string;
  status?: string;
  message?: string;
  reason?: string;
  code?: number;
  details?: Record<string, unknown>;
}

export class KubeApiError extends Error {
  override name = "KubeApiError";
  status: number;
  method: string;
  path: string;
  constructor(message: string, status: number, method: string, path: string) {
    super(message);
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

// 403: the service account lacks the verb on the resource.
export class KubeForbiddenError extends KubeApiError {
  override name = "KubeForbiddenError";
}

// 422 and other client errors: the object was rejected as invalid.
export class KubeInvalidError extends KubeApiError {
  override name = "KubeInvalidError";
}

// 5xx or a lost reply on a mutating call: the API server may or may not have applied it. The caller reconciles by name (a retried
// create answers 409, which `call` returns as a conflict). For a read, `applied` is "no".
export class KubeUnknownOutcomeError extends Error {
  override name = "KubeUnknownOutcomeError";
  applied: "unknown" | "no";
  status: number | null;
  method: string;
  path: string;
  constructor(message: string, applied: "unknown" | "no", status: number | null, method: string, path: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.applied = applied;
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export type KubeResult<T = unknown> =
  | { kind: "ok"; status: number; body: T }
  | { kind: "not-found"; status: 404; message: string }
  // `existing` is the live object when the call was a create of a named object and a follow-up read found it; null otherwise.
  | { kind: "conflict"; status: 409; message: string; reason: string | undefined; existing: unknown | null };

export interface KubeCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // Absolute API path (see `nsPath`), no query.
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  // Default application/json; patches pass e.g. application/merge-patch+json.
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface KubeClientOptions {
  auth: KubeAuth;
  // The kit's `createRequest(...)` result, so every call carries the project's fetch User-Agent.
  request: RequestFn;
  // The configured sandbox namespace (not the one the credential names).
  namespace: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
  timeoutMs?: number;
  retry?: Partial<Pick<RetryPolicy, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "now" | "random">>;
}

export interface KubeClient {
  readonly namespace: string;
  call<T = unknown>(call: KubeCall): Promise<KubeResult<T>>;
  // `/api/v1/namespaces/<ns>/<resource>[/<name>]` for a core resource; pass group "apis/<group>/<version>" for others.
  nsPath(resource: string, name?: string, group?: string): string;
}

const DNS_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function checkName(what: string, v: string): string {
  if (v.length > 253 || !DNS_NAME.test(v))
    throw new Error(`${what} ${JSON.stringify(v)} is not a valid Kubernetes name (lowercase letters, digits, '-' and '.'); fix the configuration or the id`);
  return v;
}

function statusOf(res: KitResponse): KubeStatus {
  try {
    const v: unknown = JSON.parse(Buffer.from(res.body).toString("utf8"));
    return typeof v === "object" && v !== null ? (v as KubeStatus) : {};
  } catch {
    return {};
  }
}

export function createKubeClient(o: KubeClientOptions): KubeClient {
  const namespace = checkName("namespace", o.namespace);
  const retried = withRetry(o.request, {
    quotaError: (scope, retryAfterMs) => new SandboxQuotaError(BACKEND_ID, scope, retryAfterMs),
    ...o.retry,
  });
  const log = o.log ?? (() => {});

  const scrub = (text: string, creds: KubeCredentials) => redact(text, { secrets: [creds.token, creds.key] });

  async function send(creds: KubeCredentials, c: KubeCall): Promise<KitResponse> {
    const qs = c.query === undefined || Object.keys(c.query).length === 0 ? "" : `?${new URLSearchParams(c.query).toString()}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (c.body !== undefined) headers["content-type"] = c.contentType ?? "application/json";
    if (creds.token !== undefined) headers.authorization = `Bearer ${creds.token}`;
    const tls: { ca?: string; cert?: string; key?: string } = {};
    if (creds.ca !== undefined) tls.ca = creds.ca;
    if (creds.cert !== undefined) tls.cert = creds.cert;
    if (creds.key !== undefined) tls.key = creds.key;
    return retried(`${creds.baseUrl}${c.path}${qs}`, {
      method: c.method,
      headers,
      ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
      ...(Object.keys(tls).length === 0 ? {} : { tls }),
      timeoutMs: c.timeoutMs ?? o.timeoutMs,
      ...(c.signal === undefined ? {} : { signal: c.signal }),
    });
  }

  async function attempt(creds: KubeCredentials, c: KubeCall): Promise<KitResponse> {
    // Aborted before anything was sent: nothing can have been applied, so the caller's own reason passes through.
    const aborted = () => c.signal?.aborted === true;
    if (aborted()) throw c.signal?.reason;
    try {
      return await send(creds, c);
    } catch (e) {
      if (e instanceof SandboxQuotaError || !MUTATING.has(c.method)) throw e;
      const text = e instanceof Error ? e.message : String(e);
      // A transport failure, an abort or an oversize reply after a mutating request may have been sent leaves its outcome unknown.
      // Failures that cannot have reached the server (TLS verification, bad option) are rethrown untouched.
      if (aborted() || /\b(ECONNRESET|EPIPE|ECONNABORTED)\b|socket hang up|no complete response within|response body exceeded/.test(text))
        throw new KubeUnknownOutcomeError(
          `${c.method} ${c.path} lost its reply (${scrub(text, creds)}); the API server may have applied it, so read the object by name before repeating`,
          "unknown",
          null,
          c.method,
          c.path,
          e,
        );
      throw e;
    }
  }

  const sameCreds = (a: KubeCredentials, b: KubeCredentials) =>
    a.token === b.token && a.cert === b.cert && a.key === b.key && a.ca === b.ca && a.baseUrl === b.baseUrl;

  async function call<T = unknown>(c: KubeCall): Promise<KubeResult<T>> {
    let creds = o.auth.read();
    let res = await attempt(creds, c);
    if (res.status === 401) {
      // Rotation: the token file may have been rewritten since it was read. Retry once with the fresh credential; never loop.
      const fresh = o.auth.read();
      if (!sameCreds(creds, fresh)) {
        log("kubernetes.auth-reread", { method: c.method, path: c.path });
        creds = fresh;
        res = await attempt(creds, c);
      }
      if (res.status === 401)
        throw new SandboxUnavailableError("auth", `the Kubernetes API server rejected the credential from ${o.auth.describe} (401); ${o.auth.reissueHint}`);
    }
    log("kubernetes.response", { method: c.method, path: c.path, status: res.status });
    const status = statusOf(res);
    const message = scrub(status.message ?? "", creds);
    if (res.status >= 200 && res.status < 300) {
      const text = Buffer.from(res.body).toString("utf8");
      if (text === "") return { kind: "ok", status: res.status, body: undefined as T };
      try {
        return { kind: "ok", status: res.status, body: JSON.parse(text) as T };
      } catch {
        throw new KubeApiError(
          `${c.method} ${c.path} answered ${res.status} with a body that is not JSON; check that the address is the Kubernetes API server`,
          res.status,
          c.method,
          c.path,
        );
      }
    }
    if (res.status === 404) return { kind: "not-found", status: 404, message };
    if (res.status === 409) {
      let existing: unknown | null = null;
      const name = (c.body as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (c.method === "POST" && typeof name === "string") {
        const got = await call({ method: "GET", path: `${c.path}/${checkName("object name", name)}`, signal: c.signal });
        existing = got.kind === "ok" ? got.body : null;
      }
      return { kind: "conflict", status: 409, message, reason: status.reason, existing };
    }
    if (res.status === 403)
      throw new KubeForbiddenError(
        `${c.method} ${c.path} was forbidden (403): ${message || "no detail"}; grant the pomtreed service account that verb on the resource in its Role (deploy/kubernetes)`,
        403,
        c.method,
        c.path,
      );
    if (res.status >= 500)
      throw new KubeUnknownOutcomeError(
        `${c.method} ${c.path} failed on the API server (${res.status}): ${message || "no detail"}; ${
          MUTATING.has(c.method) ? "it may have been applied, so read the object by name before repeating" : "repeat the read"
        }`,
        MUTATING.has(c.method) ? "unknown" : "no",
        res.status,
        c.method,
        c.path,
      );
    const Err = res.status === 422 ? KubeInvalidError : KubeApiError;
    throw new Err(
      `${c.method} ${c.path} was rejected (${res.status}${status.reason === undefined ? "" : ` ${status.reason}`}): ${message || "no detail"}; ${
        res.status === 422 ? "fix the object the adapter built (this is an adapter bug)" : "check the request against the Kubernetes API reference"
      }`,
      res.status,
      c.method,
      c.path,
    );
  }

  return {
    namespace,
    call,
    nsPath(resource, name, group = "api/v1") {
      checkName("resource", resource);
      return `/${group}/namespaces/${namespace}/${resource}${name === undefined ? "" : `/${checkName("object name", name)}`}`;
    },
  };
}
