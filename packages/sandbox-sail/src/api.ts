// The Sailboxes REST surface the adapter uses, and nothing else. Every call goes through the injected requester (which stamps
// workflow.fetch.userAgent) wrapped in the kit's retry, so a 429 becomes SandboxQuotaError and transient failures of a repeatable call
// are retried. The API token is read per call through `token()` and never appears in an error or log line (redact), and neither does
// any `env` object a provider echoes back in an error body.
//
// Provenance of each endpoint (README.md, "Unverified", lists what is inferred):
//   POST   /sailboxes                         documented (create-a-sailbox; Idempotency-Key header; `sailbox_id` in the reply)
//   GET    /sailboxes/{id}                    documented page (retrieve-a-sailbox); the `status` values are inferred
//   GET    /sailboxes                         documented (list-sailboxes); the reply envelope `{ "sailboxes": [...] }` and paging are inferred
//   DELETE /sailboxes/{id}                    inferred: the docs name an idempotent terminate but its REST path was not read
//   POST   /sailboxes/{id}/exec               documented path, NDJSON reply whose first event is `started`; the field names are inferred
//   GET    /sailboxes/{id}/exec/{execId}      inferred: the docs list a wait endpoint whose path and shape were not read
//   GET    /sailboxes/{id}/tunnel?port=n      documented WebSocket carrying one TCP connection (binary frames, `{"type":"eof"}` half-close)

import { SandboxQuotaError, SandboxUnavailableError } from "@pomtree/core";
import type { SandboxRequester, SandboxResponse } from "@pomtree/core";
import { REDACTED, redact } from "@pomtree/sandbox-kit";
import { withRetry } from "@pomtree/sandbox-kit/retry";
import type { RetryPolicy } from "@pomtree/sandbox-kit/retry";

export const SAIL_BACKEND = "sail";

// A Sailbox as the API returns it. Only `sailbox_id` is documented; the rest is read defensively.
export interface SailboxRecord {
  sailbox_id: string;
  name?: string;
  status?: string;
  env?: Record<string, string>;
}

export interface ExecStatus {
  status: string;
  exitCode: number | null;
}

// A non-2xx answer the adapter does not map to a port error itself. `status` lets the caller classify it (a 5xx on a create leaves
// the outcome unknown). The message is already redacted.
export class SailHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SailHttpError";
    this.status = status;
  }
}

// Sorted-key JSON, so the same create always serialises to the same bytes: Sail deduplicates an Idempotency-Key on the body, and a
// retry with a different byte order would be refused as a different request.
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>)
              .filter(([, y]) => y !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, y]) => [k, norm(y)]),
          )
        : x;
  return JSON.stringify(norm(v));
}

export interface SailApiOptions {
  baseUrl: string;
  request: SandboxRequester;
  token: () => Promise<string>;
  // Retry tuning (tests inject a zero sleep); quotaError is always the adapter's own.
  retry?: Omit<RetryPolicy, "quotaError">;
  // Per-call timeout for plain requests.
  timeoutMs?: number;
}

const decoder = new TextDecoder();

export class SailApi {
  readonly #base: string;
  readonly #token: () => Promise<string>;
  readonly #request: SandboxRequester;
  readonly #retrying: (url: string, init: Parameters<SandboxRequester>[1]) => Promise<SandboxResponse>;
  readonly #once: (url: string, init: Parameters<SandboxRequester>[1]) => Promise<SandboxResponse>;
  readonly #timeoutMs: number | undefined;

  constructor(o: SailApiOptions) {
    const base = new URL(o.baseUrl); // throws on a malformed base URL, at construction
    // The API token travels in every request, so only TLS is accepted; plain http only to this machine (a local stub or proxy).
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
    if (!(base.protocol === "https:" || (base.protocol === "http:" && loopback))) {
      throw new Error(
        `sandbox.sail.baseUrl ${JSON.stringify(o.baseUrl)} is not an https URL (plain http is allowed only to a loopback address, since the API token is sent to it); set it to the https Sailboxes API address`,
      );
    }
    this.#base = o.baseUrl.replace(/\/+$/, "");
    this.#token = o.token;
    this.#request = o.request;
    this.#timeoutMs = o.timeoutMs;
    const quotaError = (scope: "rate" | "concurrency" | "plan", retryAfterMs: number | null) => new SandboxQuotaError(SAIL_BACKEND, scope, retryAfterMs);
    this.#retrying = withRetry(o.request, { ...o.retry, quotaError });
    // Creates are replayed by createOnce (inside the provider's key window), never inside the HTTP layer as well.
    this.#once = withRetry(o.request, { ...o.retry, maxAttempts: 1, quotaError });
  }

  async #call(
    method: string,
    path: string,
    opts: { body?: string; key?: string; once?: boolean; contentType?: string } = {},
  ): Promise<{ res: SandboxResponse; token: string }> {
    const token = await this.#token();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json, application/x-ndjson" };
    if (opts.body !== undefined) headers["content-type"] = opts.contentType ?? "application/json";
    if (opts.key !== undefined) headers["idempotency-key"] = opts.key;
    const init = {
      method,
      headers,
      ...(opts.body !== undefined && { body: opts.body }),
      ...(this.#timeoutMs !== undefined && { timeoutMs: this.#timeoutMs }),
    };
    try {
      const res = await (opts.once ? this.#once : this.#retrying)(`${this.#base}${path}`, init);
      return { res, token };
    } catch (e) {
      if (e instanceof SandboxQuotaError) throw e;
      // A transport failure: keep the text for the operator, without the token.
      const err = new Error(`Sailboxes API ${method} ${template(path)} failed: ${redact(e instanceof Error ? e.message : String(e), { secrets: [token] })}`);
      (err as Error & { code?: unknown }).code = (e as { code?: unknown } | null)?.code;
      throw err;
    }
  }

  // Maps a non-2xx answer to the port's error. 401/403 = bad credential, 404 handled by callers that expect it.
  #fail(method: string, path: string, res: SandboxResponse, token: string): never {
    const text = redact(withoutEnv(decoder.decode(res.body)).slice(0, 500), { secrets: [token] });
    const where = `Sailboxes API ${method} ${template(path)} answered HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new SandboxUnavailableError(
        "auth",
        `${where} (${text}); the API token was refused: check the file named by the sandbox.sail apiToken credential and that the key is org-scoped (tunnels need one)`,
      );
    }
    throw new SailHttpError(
      res.status,
      `${where}: ${text}; ${res.status >= 500 ? "the provider failed, retry later" : "fix the request or the configuration it came from"}`,
    );
  }

  #json(method: string, path: string, res: SandboxResponse, token: string): unknown {
    const text = decoder.decode(res.body);
    // NDJSON (exec) is read up to its first event; a plain JSON body is a single line.
    const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
    try {
      return JSON.parse(first);
    } catch {
      throw new SailHttpError(
        res.status,
        `Sailboxes API ${method} ${template(path)} answered HTTP ${res.status} with a body that is not JSON (${redact(first.slice(0, 120), { secrets: [token] })}); check sandbox.sail.baseUrl points at the Sailboxes API`,
      );
    }
  }

  async create(body: string, idempotencyKey: string): Promise<SailboxRecord> {
    const path = "/sailboxes";
    const { res, token } = await this.#call("POST", path, { body, key: idempotencyKey, once: true });
    if (res.status !== 200 && res.status !== 201) this.#fail("POST", path, res, token);
    return record(this.#json("POST", path, res, token), "POST /sailboxes");
  }

  async get(sailboxId: string): Promise<SailboxRecord | null> {
    const path = `/sailboxes/${encodeURIComponent(sailboxId)}`;
    const { res, token } = await this.#call("GET", path);
    if (res.status === 404) return null;
    if (res.status !== 200) this.#fail("GET", path, res, token);
    return record(this.#json("GET", path, res, token), "GET /sailboxes/{id}");
  }

  // One unparameterised request. A reply that may be partial (a full page, or any next-page marker) is refused with
  // SailListTruncatedError rather than read as complete, because a box missing from it would be treated as gone (never killed or
  // reconciled, still billing).
  // TODO(sail-list-paging): follow the documented `limit`/`offset` paging once its envelope is recorded. Current behavior: an account
  // with SAIL_LIST_PAGE_SIZE or more sailboxes visible to the key makes list, attach, stop and kill fail loudly.
  async list(): Promise<SailboxRecord[]> {
    const path = "/sailboxes";
    const { res, token } = await this.#call("GET", path);
    if (res.status !== 200) this.#fail("GET", path, res, token);
    const v = this.#json("GET", path, res, token);
    const items = Array.isArray(v) ? v : (v as { sailboxes?: unknown } | null)?.sailboxes;
    if (!Array.isArray(items)) {
      throw new SailHttpError(200, "Sailboxes API GET /sailboxes answered without a sailboxes array; the API shape changed, so update the adapter");
    }
    const envelope = Array.isArray(v) ? {} : (v as Record<string, unknown>);
    const marker = NEXT_MARKERS.find((k) => envelope[k] !== undefined && envelope[k] !== null && envelope[k] !== false);
    if (items.length >= SAIL_LIST_PAGE_SIZE || marker !== undefined) throw new SailListTruncatedError(items.length, marker);
    return items.map((i) => record(i, "GET /sailboxes"));
  }

  // Terminate is idempotent on the provider; an already-gone box (404) is success too.
  async terminate(sailboxId: string): Promise<void> {
    const path = `/sailboxes/${encodeURIComponent(sailboxId)}`;
    const { res, token } = await this.#call("DELETE", path);
    if (res.status === 404 || (res.status >= 200 && res.status < 300)) return;
    this.#fail("DELETE", path, res, token);
  }

  // Starts `argv` in the background and returns the exec id from the `started` event.
  async exec(sailboxId: string, argv: readonly string[], idempotencyKey: string): Promise<string> {
    const path = `/sailboxes/${encodeURIComponent(sailboxId)}/exec`;
    const body = canonicalJson({ command: argv, background: true });
    const { res, token } = await this.#call("POST", path, { body, key: idempotencyKey, once: true });
    if (res.status !== 200 && res.status !== 201) this.#fail("POST", path, res, token);
    const ev = this.#json("POST", path, res, token) as { type?: unknown; exec_id?: unknown } | null;
    if (ev?.type !== "started" || typeof ev.exec_id !== "string" || ev.exec_id === "") {
      throw new SailHttpError(res.status, "Sailboxes API POST /sailboxes/{id}/exec did not start with a started event carrying exec_id; update the adapter");
    }
    return ev.exec_id;
  }

  async execStatus(sailboxId: string, execId: string): Promise<ExecStatus | null> {
    const path = `/sailboxes/${encodeURIComponent(sailboxId)}/exec/${encodeURIComponent(execId)}`;
    const { res, token } = await this.#call("GET", path);
    if (res.status === 404) return null;
    if (res.status !== 200) this.#fail("GET", path, res, token);
    const v = this.#json("GET", path, res, token) as { status?: unknown; exit_code?: unknown } | null;
    return { status: typeof v?.status === "string" ? v.status : "unknown", exitCode: typeof v?.exit_code === "number" ? v.exit_code : null };
  }

  // Opens the documented port tunnel. Resolves once the WebSocket is open; rejects (token redacted) when it cannot be opened.
  async tunnel(sailboxId: string, port: number): Promise<WebSocket> {
    const token = await this.#token();
    const url = new URL(`${this.#base}/sailboxes/${encodeURIComponent(sailboxId)}/tunnel`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("port", String(port));
    const ws = this.#request.openWebSocket(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onError);
      };
      const onOpen = () => {
        done();
        resolve();
      };
      const onError = () => {
        done();
        reject(
          new SandboxUnavailableError(
            "provider-outage",
            `Sailboxes tunnel to port ${port} of sailbox ${sailboxId} could not be opened; check the sandbox is running, that the worker listens on that port and that the API key is org-scoped`,
          ),
        );
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onError);
    });
    return ws;
  }
}

// The default page size of GET /sailboxes. INFERRED: the documentation names `limit` and `offset` but not the default, so a reply
// this long is assumed to be cut.
export const SAIL_LIST_PAGE_SIZE = 100;
// Envelope fields that would announce another page. INFERRED: the reply envelope is undocumented.
const NEXT_MARKERS = ["next", "next_offset", "next_cursor", "has_more"];

// The list reply may be missing sailboxes, so nothing can be concluded from a box's absence.
export class SailListTruncatedError extends Error {
  constructor(count: number, marker: string | undefined) {
    super(
      `Sailboxes API GET /sailboxes may have returned only the first page (${count} sailboxes${marker === undefined ? "" : `, next-page marker "${marker}"`}), so a sandbox missing from it may exist beyond the first page or be gone; the sail backend reads one page only (README "Limits"): terminate sailboxes the key no longer needs, or use a key scoped to fewer than ${SAIL_LIST_PAGE_SIZE}`,
    );
    this.name = "SailListTruncatedError";
  }
}

// Replaces every `env` object in an echoed JSON body (at any depth) before it is shown: a create-time env may hold values the
// operator did not mean to log. A body that is not JSON is returned unchanged (the token redaction still applies).
export function withoutEnv(text: string): string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return text;
  }
  const strip = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(strip)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, k === "env" ? REDACTED : strip(y)]))
        : x;
  return JSON.stringify(strip(v));
}

// `/sailboxes/abc/exec/x` -> `/sailboxes/{id}/exec/{execId}`, so messages and logs name the endpoint without ids.
function template(path: string): string {
  const p = path.split("/");
  if (p[1] === "sailboxes" && p[2] !== undefined) p[2] = "{id}";
  if (p[3] === "exec" && p[4] !== undefined) p[4] = "{execId}";
  return p.join("/");
}

function record(v: unknown, what: string): SailboxRecord {
  const o = v as Record<string, unknown> | null;
  if (o === null || typeof o !== "object" || typeof o.sailbox_id !== "string" || o.sailbox_id === "") {
    throw new SailHttpError(200, `Sailboxes API ${what} returned a record without a sailbox_id; the API shape changed, so update the adapter`);
  }
  const env = o.env !== null && typeof o.env === "object" && !Array.isArray(o.env) ? (o.env as Record<string, unknown>) : undefined;
  return {
    sailbox_id: o.sailbox_id,
    ...(typeof o.name === "string" && { name: o.name }),
    ...(typeof o.status === "string" && { status: o.status }),
    ...(env !== undefined && { env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")) }),
  };
}
