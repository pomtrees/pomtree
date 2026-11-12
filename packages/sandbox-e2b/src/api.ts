// The E2B REST client: JSON over the injected request facade (which stamps workflow.fetch.userAgent), the API key read from the
// declared credential file on every call, and a fixed error map so the adapter reasons about outcomes, not status codes.
//
// Endpoints and their provenance (README, "Provenance"):
//   POST   /sandboxes             create            inferred (the notes call it deprecated for /v2; README); body checked against the vendored, inferred schema
//   GET    /v2/sandboxes          list, metadata    documented (list-sandboxes-v2, `metadata` = URL-encoded `k=v&k=v`)
//   GET    /sandboxes/{id}        get one           inferred
//   DELETE /sandboxes/{id}        kill              inferred
//   header X-API-Key                                inferred
//
// Outcomes:
//   2xx       -> parsed body
//   404       -> null (get) or success (kill: already gone)
//   401, 403  -> SandboxUnavailableError("auth")
//   429       -> SandboxQuotaError (the kit's withRetry; a GET is retried first, a POST is not)
//   other 4xx -> E2BApiError, applied = "no"
//   5xx       -> E2BApiError, applied = "unknown" for a create (the caller reconciles), "no" for a read
//   transport -> rethrown with credentials redacted; for a create the outcome is unknown
//
// The API key is never put in a message, a log field or an error property: every message passes the kit's redaction with the key
// as a literal.

import { SandboxQuotaError, SandboxUnavailableError, sandboxCredentialEnv, secretFileEnv } from "@pomtree/core";
import { type KitResponse, type RequestFn, redact, redactUrl } from "@pomtree/sandbox-kit";
import { type RetryPolicy, withRetry } from "@pomtree/sandbox-kit/retry";
import { BACKEND_ID, metadataQuery } from "./metadata.ts";

export const API_KEY_CREDENTIAL = "apiKey";
// The variable the daemon reads the key file path from, derived by core's naming rule (never spelled out here).
export const API_KEY_FILE_ENV = secretFileEnv(sandboxCredentialEnv(BACKEND_ID, API_KEY_CREDENTIAL));
const API_KEY_HEADER = "x-api-key";

// Inferred, not documented: the most entries one v2 list page returns. A page this full may be truncated.
export const E2B_LIST_PAGE_SIZE = 100;

// A list answer that may be missing entries. Fails closed: reconcile and dedup must never act on a partial listing.
export class E2BListTruncatedError extends SandboxUnavailableError {
  override name = "E2BListTruncatedError";
  constructor(count: number) {
    super(
      "provider-outage",
      `E2B returned ${count} sandboxes in one list page, the most one page holds (${E2B_LIST_PAGE_SIZE}, inferred), so the listing may be truncated and pomtree refuses to act on it; kill sandboxes this account no longer needs until fewer than ${E2B_LIST_PAGE_SIZE} carry pomtree metadata`,
    );
  }
}

export class E2BApiError extends Error {
  override name = "E2BApiError";
  status: number;
  // Whether the provider may have applied the call: only a create answered with a 5xx is "unknown".
  applied: "no" | "unknown";
  constructor(message: string, status: number, applied: "no" | "unknown") {
    super(message);
    this.status = status;
    this.applied = applied;
  }
}

// The create body (POST /sandboxes). Field names follow the documented create page; `timeout` is in seconds.
export interface E2BCreateBody {
  templateID: string;
  timeout: number;
  metadata: Record<string, string>;
  envVars: Record<string, string>;
}

// One sandbox as the get and list calls return it. Only the fields the adapter reads are named.
export interface E2BSandboxInfo {
  sandboxID: string;
  state: string;
  metadata: Record<string, unknown>;
}

export interface E2BApiOptions {
  baseUrl: string;
  // The facade's request function (deps.request).
  request: RequestFn;
  // Reads the API key; called on every request, so a rotated key is picked up without a restart.
  apiKey: () => Promise<string>;
  // Per-call timeout for plain requests (default 30 s). A create that times out has an unknown outcome.
  timeoutMs?: number;
  // Overrides for the kit's retry wrapper (tests shorten the waits).
  retry?: Omit<RetryPolicy, "quotaError">;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class E2BApi {
  readonly #base: string;
  readonly #request: RequestFn;
  readonly #apiKey: () => Promise<string>;
  readonly #timeoutMs: number;
  // The last key read, kept only to redact it from provider text.
  #lastKey: string | undefined;

  constructor(o: E2BApiOptions) {
    this.#base = o.baseUrl.replace(/\/+$/, "");
    this.#apiKey = o.apiKey;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#request = withRetry(o.request, {
      ...o.retry,
      quotaError: (scope, retryAfterMs) => new SandboxQuotaError(BACKEND_ID, scope, retryAfterMs),
    });
  }

  #redact(text: string): string {
    return redact(text, { secrets: [this.#lastKey] });
  }

  async #call(method: string, path: string, body?: unknown): Promise<KitResponse> {
    const key = await this.#apiKey();
    this.#lastKey = key;
    const headers: Record<string, string> = { [API_KEY_HEADER]: key, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.#request(`${this.#base}${path}`, {
        method,
        headers,
        timeoutMs: this.#timeoutMs,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      if (e instanceof SandboxQuotaError || e instanceof SandboxUnavailableError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`E2B ${method} ${redactUrl(path)} got no reply: ${this.#redact(msg)}; check sandbox.e2b.baseUrl and network reachability, then retry`, {
        cause: e,
      });
    }
  }

  // Maps a non-2xx response to its error. `create` marks a 5xx as an unknown outcome.
  #fail(method: string, path: string, res: KitResponse, create = false): never {
    const text = this.#redact(Buffer.from(res.body).toString("utf8").slice(0, 500));
    const where = `E2B ${method} ${path}`;
    if (res.status === 401 || res.status === 403) {
      throw new SandboxUnavailableError(
        "auth",
        `${where} was refused with ${res.status} (${text || "no detail"}); write a valid E2B API key into the file the apiKey credential names (${API_KEY_FILE_ENV})`,
      );
    }
    if (res.status >= 500) {
      throw new E2BApiError(
        `${where} failed with ${res.status} (${text || "no detail"}); ${create ? "the sandbox may or may not exist, so the adapter reconciles by its metadata before anything else" : "retry later"}`,
        res.status,
        create ? "unknown" : "no",
      );
    }
    throw new E2BApiError(`${where} was rejected with ${res.status} (${text || "no detail"}); fix the request or the template named in it`, res.status, "no");
  }

  #json(method: string, path: string, res: KitResponse): unknown {
    try {
      return JSON.parse(Buffer.from(res.body).toString("utf8"));
    } catch {
      throw new Error(`E2B ${method} ${path} answered ${res.status} with a body that is not JSON; check that sandbox.e2b.baseUrl points at the E2B API`);
    }
  }

  #info(method: string, path: string, v: unknown): E2BSandboxInfo {
    if (!isObject(v) || typeof v.sandboxID !== "string" || v.sandboxID === "") {
      throw new Error(`E2B ${method} ${path} returned a sandbox without a sandboxID; check that sandbox.e2b.baseUrl points at the E2B API`);
    }
    return { sandboxID: v.sandboxID, state: typeof v.state === "string" ? v.state : "unknown", metadata: isObject(v.metadata) ? v.metadata : {} };
  }

  async create(body: E2BCreateBody): Promise<{ sandboxID: string }> {
    const path = "/sandboxes";
    const res = await this.#call("POST", path, body);
    if (res.status < 200 || res.status > 299) this.#fail("POST", path, res, true);
    const v = this.#json("POST", path, res);
    if (!isObject(v) || typeof v.sandboxID !== "string" || v.sandboxID === "") {
      throw new E2BApiError(
        `E2B POST ${path} answered ${res.status} without a sandboxID; the sandbox may exist, so the adapter reconciles by its metadata`,
        res.status,
        "unknown",
      );
    }
    return { sandboxID: v.sandboxID };
  }

  // Every sandbox whose metadata carries all of `selector`.
  // TODO(e2b-list-pagination): the research notes do not document the v2 list's paging fields; current behavior: one page is read,
  // and a full page (E2B_LIST_PAGE_SIZE entries) fails closed with E2BListTruncatedError, since entries may be missing.
  async list(selector: Readonly<Record<string, string>>): Promise<E2BSandboxInfo[]> {
    const path = "/v2/sandboxes";
    const res = await this.#call("GET", `${path}?metadata=${encodeURIComponent(metadataQuery(selector))}`);
    if (res.status < 200 || res.status > 299) this.#fail("GET", path, res);
    const v = this.#json("GET", path, res);
    if (!Array.isArray(v)) {
      throw new E2BApiError(
        `E2B GET ${path} did not return a bare JSON array (the shape this adapter reads; a paged envelope would hide entries); check sandbox.e2b.baseUrl, or update the adapter to the paged list format`,
        res.status,
        "no",
      );
    }
    if (v.length >= E2B_LIST_PAGE_SIZE) throw new E2BListTruncatedError(v.length);
    return v.map((item) => this.#info("GET", path, item));
  }

  async get(sandboxID: string): Promise<E2BSandboxInfo | null> {
    const path = `/sandboxes/${encodeURIComponent(sandboxID)}`;
    const res = await this.#call("GET", path);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status > 299) this.#fail("GET", path, res);
    return this.#info("GET", path, this.#json("GET", path, res));
  }

  // Already gone is success.
  async kill(sandboxID: string): Promise<void> {
    const path = `/sandboxes/${encodeURIComponent(sandboxID)}`;
    const res = await this.#call("DELETE", path);
    if (res.status === 404 || (res.status >= 200 && res.status <= 299)) return;
    this.#fail("DELETE", path, res);
  }
}
