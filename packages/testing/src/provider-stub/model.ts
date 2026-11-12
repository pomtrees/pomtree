import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClauseId } from "../sandbox-conformance.ts";
import { FaultPlan } from "./faults.ts";
import type { Fixture, FixtureEntry, StreamStep } from "./fixture-loader.ts";

// The pure core of the provider stub: a stateful model of one provider's resources plus a strict replay of fixture exchanges. No sockets, no fs; the
// loopback shell is server.ts. A request is answered by (1) a resource route (create / list / get / delete on a declared collection), else (2) the NEXT
// unconsumed fixture entry, else it is UNMATCHED: recorded, answered with a failure, and never given a default response.

/** What the model can do, keyed to the conformance clause each verb lets an adapter exercise. */
export type ModelVerb = "create" | "list" | "get" | "delete" | "connect";
export const MODEL_VERB_CLAUSES = {
  create: "idempotent-start",
  list: "list-by-owner",
  get: "attach-existing",
  delete: "stop-kill-keyed",
  connect: "channel-drop-throws",
} satisfies Record<ModelVerb, ClauseId>;

/** One declared collection of resources, for example `/sandboxes`. */
export interface ResourceSpec {
  readonly collection: string;
  /** Field holding the id in a stored resource (default `id`). */
  readonly idField?: string;
  readonly idPrefix?: string;
  /** Header carrying the create idempotency key (default `idempotency-key`, matched case-insensitively). */
  readonly idempotencyHeader?: string;
  /** A create without the key is refused when true (default true). */
  readonly requireKey?: boolean;
  /** Body field holding string tags (default `metadata`). */
  readonly tagsField?: string;
  /** List query parameter carrying `k=v` tag filters, repeated for AND (default: the tags field name). Any other query parameter is unmatched. */
  readonly filterParam?: string;
  /** Wrap the list in `{[listField]: [...]}`; omitted means a bare array. */
  readonly listField?: string;
}

export interface ModelRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly upgrade: boolean;
}

export type ModelOutcome =
  | { readonly kind: "respond"; readonly status: number; readonly headers: Record<string, string>; readonly body: string }
  | { readonly kind: "upgrade"; readonly headers: Record<string, string>; readonly steps: readonly StreamStep[] }
  | { readonly kind: "hang" }
  | { readonly kind: "unmatched"; readonly reason: string };

export interface RecordedRequest {
  readonly index: number;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  /** Header NAMES only: values can be credentials and are never retained. */
  readonly headerNames: readonly string[];
  readonly idempotencyKey: string | undefined;
  readonly rawBody: string;
  readonly upgrade: boolean;
  /** The verb or `fixture` it was served by, `fault:<name>`, or `UNMATCHED`. */
  readonly served: string;
}

export interface StoredResource {
  readonly [k: string]: unknown;
}

const json = (status: number, v: unknown, extra: Record<string, string> = {}): ModelOutcome => ({
  kind: "respond",
  status,
  headers: { "content-type": "application/json", ...extra },
  body: JSON.stringify(v),
});
const errorBody = (status: number, error: string, message: string, extra: Record<string, string> = {}): ModelOutcome => json(status, { error, message }, extra);

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;

function parseBody(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** sha256 hex of the canonical JSON body (sorted keys), or of the raw text when it is not JSON. This is the `requestBodySha256` of a fixture `match`. */
export function bodySha256(raw: string): string {
  const p = parseBody(raw);
  return createHash("sha256")
    .update(p.ok ? JSON.stringify(canonical(p.value)) : raw)
    .digest("hex");
}

const flatQuery = (q: Readonly<Record<string, readonly string[]>>): string[] =>
  Object.entries(q)
    .flatMap(([k, vs]) => vs.map((v) => `${k}=${v}`))
    .sort();

/** `bad` marks a request the model refused as malformed (a 400 the adapter caused): it is answered but also recorded as unmatched. */
interface RunResult {
  out: ModelOutcome;
  created?: { collection: string; key: string; bodyHash: string };
  bad?: string;
}

const badRequest = (error: string, message: string): RunResult => ({ out: errorBody(400, error, message), bad: `${error}: ${message}` });

interface Route {
  readonly verb: ModelVerb | "fixture";
  readonly run: () => RunResult;
}

interface PendingUnknown {
  readonly collection: string;
  readonly key: string;
  readonly bodyHash: string;
}

export class ProviderModel {
  readonly faults: FaultPlan;
  readonly requests: RecordedRequest[] = [];
  readonly unmatched: { readonly index: number; readonly reason: string }[] = [];
  readonly #specs: readonly ResourceSpec[];
  readonly #entries: readonly FixtureEntry[];
  #next = 0;
  readonly #store = new Map<string, Map<string, StoredResource>>();
  readonly #keys = new Map<string, { bodyHash: string; id: string }>();
  readonly #unknown: PendingUnknown[] = [];
  #counter = 0;

  readonly #requiredHeaders: readonly string[];

  constructor(opts: { fixture?: Fixture; resources?: readonly ResourceSpec[]; faults?: FaultPlan; requireHeaderNames?: readonly string[] } = {}) {
    this.#requiredHeaders = (opts.requireHeaderNames ?? []).map((h) => h.toLowerCase());
    this.#entries = opts.fixture?.entries ?? [];
    this.#specs = opts.resources ?? [];
    this.faults = opts.faults ?? new FaultPlan();
    for (const s of this.#specs) this.#store.set(s.collection, new Map());
  }

  /** The stored resources of a collection, in creation order. */
  resources(collection: string): StoredResource[] {
    return [...(this.#store.get(collection)?.values() ?? [])];
  }

  /** Fixture entries not yet consumed by a request. */
  remaining(): readonly FixtureEntry[] {
    return this.#entries.slice(this.#next);
  }

  /** Records a request the transport could not even deliver whole (oversize or aborted body) as unmatched, with the cause. */
  reject(req: ModelRequest, reason: string): void {
    const index = this.requests.length;
    this.requests.push(this.#recorded(index, req, "UNMATCHED"));
    this.unmatched.push({ index, reason: `${req.method} ${req.path}: ${reason}` });
  }

  #recorded(index: number, req: ModelRequest, served: string): RecordedRequest {
    return {
      index,
      method: req.method,
      path: req.path,
      query: flatQuery(req.query).join("&"),
      headerNames: Object.keys(req.headers).sort(),
      idempotencyKey: req.headers[(this.#specFor(req.path)?.idempotencyHeader ?? "idempotency-key").toLowerCase()],
      rawBody: req.rawBody,
      upgrade: req.upgrade,
      served,
    };
  }

  /** Answers one request and records it. Never throws and never invents a default response. */
  handle(req: ModelRequest): ModelOutcome {
    const index = this.requests.length;
    const record = (served: string) => this.requests.push(this.#recorded(index, req, served));
    const routed = this.#route(req);
    if (!("run" in routed)) {
      record("UNMATCHED");
      this.unmatched.push({ index, reason: routed.reason });
      return { kind: "unmatched", reason: routed.reason };
    }
    if (this.faults.take("timeout", req.method, req.path)) {
      record("fault:timeout");
      return { kind: "hang" };
    }
    const limited = this.faults.take("rate-limit", req.method, req.path);
    if (limited) {
      record("fault:rate-limit");
      return errorBody(429, "rate-limited", `stub rate limit: retry after ${limited.retryAfterS ?? 1} second(s)`, {
        "retry-after": String(limited.retryAfterS ?? 1),
      });
    }
    const { out, created, bad } = routed.run();
    if (out.kind === "unmatched" || bad !== undefined) {
      const reason = out.kind === "unmatched" ? out.reason : `${req.method} ${req.path}: ${bad}`;
      record("UNMATCHED");
      this.unmatched.push({ index, reason });
      return out;
    }
    const lost = this.faults.take("server-error-after-apply", req.method, req.path);
    if (lost) {
      record(`fault:server-error-after-apply(${routed.verb})`);
      if (created) this.#unknown.push(created);
      return errorBody(lost.status ?? 503, "server-error", "stub server error after the request was applied: its outcome is unknown to the caller");
    }
    record(routed.verb);
    return out;
  }

  #specFor(path: string): ResourceSpec | undefined {
    return this.#specs.find((s) => path === s.collection || (path.startsWith(`${s.collection}/`) && !path.slice(s.collection.length + 1).includes("/")));
  }

  #route(req: ModelRequest): Route | { reason: string } {
    const missing = this.#requiredHeaders.filter((h) => req.headers[h] === undefined);
    if (missing.length > 0) {
      return { reason: `${req.method} ${req.path}: missing required header(s) ${missing.join(", ")}; the adapter must send them on every call` };
    }
    const spec = this.#specFor(req.path);
    if (spec !== undefined && !req.upgrade) {
      const r = this.#resourceRoute(spec, req);
      if (r !== undefined) return r;
    }
    return this.#fixtureRoute(req);
  }

  #resourceRoute(spec: ResourceSpec, req: ModelRequest): Route | { reason: string } | undefined {
    const store = this.#store.get(spec.collection)!;
    const isCollection = req.path === spec.collection;
    const id = isCollection ? undefined : req.path.slice(spec.collection.length + 1);
    const tagsField = spec.tagsField ?? "metadata";
    const idField = spec.idField ?? "id";
    const unmatched = (why: string) => ({ reason: `${req.method} ${req.path}: ${why}` });
    if (isCollection && req.method === "POST") {
      if (Object.keys(req.query).length > 0)
        return unmatched(`create takes no query, got ?${flatQuery(req.query).join("&")}; drop the query or declare it in the fixture`);
      return { verb: "create", run: () => ({ ...this.#create(spec, req, store, idField) }) };
    }
    if (isCollection && req.method === "GET") {
      const param = spec.filterParam ?? tagsField;
      const extra = Object.keys(req.query).filter((k) => k !== param);
      if (extra.length > 0)
        return unmatched(`list query parameter(s) ${extra.join(", ")} are not declared (only "${param}" filters); remove them or extend the ResourceSpec`);
      const filters: [string, string][] = [];
      for (const f of req.query[param] ?? []) {
        const eq = f.indexOf("=");
        if (eq < 1) return { verb: "list", run: () => badRequest("bad-filter", `tag filter "${f}" must be k=v; send ${param}=key=value`) };
        filters.push([f.slice(0, eq), f.slice(eq + 1)]);
      }
      return {
        verb: "list",
        run: () => {
          const items = [...store.values()].filter((r) => filters.every(([k, v]) => (r[tagsField] as Record<string, string> | undefined)?.[k] === v));
          return { out: json(200, spec.listField === undefined ? items : { [spec.listField]: items }) };
        },
      };
    }
    if (id !== undefined && req.method === "GET") {
      if (Object.keys(req.query).length > 0) return unmatched("get takes no query");
      return {
        verb: "get",
        run: () => ({
          out: store.has(id) ? json(200, store.get(id)) : errorBody(404, "not-found", `no ${spec.collection} resource ${id}; list first or create it`),
        }),
      };
    }
    if (id !== undefined && req.method === "DELETE") {
      if (Object.keys(req.query).length > 0) return unmatched("delete takes no query");
      return {
        verb: "delete",
        run: () => {
          if (!store.delete(id)) return { out: errorBody(404, "not-found", `no ${spec.collection} resource ${id}; it is already gone`) };
          return { out: { kind: "respond", status: 204, headers: {}, body: "" } };
        },
      };
    }
    return undefined;
  }

  #create(spec: ResourceSpec, req: ModelRequest, store: Map<string, StoredResource>, idField: string): RunResult {
    const parsed = parseBody(req.rawBody);
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return badRequest("bad-request", "create needs a JSON object body; send the resource fields as JSON");
    }
    const body = parsed.value as Record<string, unknown>;
    const key = req.headers[(spec.idempotencyHeader ?? "idempotency-key").toLowerCase()];
    if (key === undefined && (spec.requireKey ?? true)) {
      return badRequest(
        "missing-idempotency-key",
        `create needs the ${spec.idempotencyHeader ?? "Idempotency-Key"} header; send one derived from the agent so a retry reuses it`,
      );
    }
    const bodyHash = bodySha256(req.rawBody);
    const ignoreKey = this.faults.take("idempotent-create", req.method, req.path) !== undefined;
    if (key !== undefined && !ignoreKey) {
      const slot = `${spec.collection}|${key}`;
      const prior = this.#keys.get(slot);
      if (prior !== undefined) {
        if (prior.bodyHash !== bodyHash) {
          return {
            out: errorBody(409, "idempotency-conflict", `idempotency key was already used with a different body; reuse the key only for the identical create`),
          };
        }
        const live = store.get(prior.id);
        if (live === undefined)
          return { out: errorBody(409, "key-consumed", "the resource created under this key was deleted; use a new key for a new create") };
        const at = this.#unknown.findIndex((p) => p.collection === spec.collection && p.key === key);
        if (at >= 0) this.#unknown.splice(at, 1);
        return { out: json(200, live) };
      }
      const fresh = this.#unknown.find((p) => p.collection === spec.collection && p.bodyHash === bodyHash && p.key !== key);
      if (fresh !== undefined && this.faults.take("fresh-key-retry", req.method, req.path) === undefined) {
        return {
          out: errorBody(
            409,
            "fresh-key-retry",
            "this create repeats one whose outcome is unknown but carries a new idempotency key, which could duplicate the resource; retry with the SAME key, or list by tag first",
          ),
        };
      }
    }
    this.#counter += 1;
    const id = `${spec.idPrefix ?? "res"}-${this.#counter}`;
    const stored: StoredResource = { ...body, [idField]: id };
    store.set(id, stored);
    if (key !== undefined && !ignoreKey) this.#keys.set(`${spec.collection}|${key}`, { bodyHash, id });
    return { out: json(201, stored), created: key === undefined ? undefined : { collection: spec.collection, key, bodyHash } };
  }

  #fixtureRoute(req: ModelRequest): Route | { reason: string } {
    const head = `${req.method} ${req.path}${req.rawBody === "" ? "" : " (with body)"}`;
    const entry = this.#entries[this.#next];
    if (entry === undefined) {
      const used = this.#entries.length === 0 ? "the stub has no fixture entries" : `all ${this.#entries.length} fixture entries are already consumed`;
      return { reason: `${head}: no resource route or fixture entry matches (${used}); add the exchange to the fixture or fix the adapter's request` };
    }
    const why = this.#mismatch(entry, req);
    if (why !== undefined) {
      const later = this.#entries.slice(this.#next + 1).find((e) => this.#mismatch(e, req) === undefined);
      const order = later === undefined ? "" : `; it matches entry seq ${later.seq}, which is out of order (the stub replays strictly in sequence)`;
      return { reason: `${head}: does not match the next fixture entry seq ${entry.seq} (${entry.method} ${entry.path}): ${why}${order}` };
    }
    return {
      verb: entry.stream === undefined ? "fixture" : "connect",
      run: () => {
        this.#next += 1;
        const headers = Object.fromEntries(Object.entries(entry.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        if (entry.stream !== undefined) return { out: this.#upgrade(entry, headers, req) };
        const b = entry.responseBody;
        if (b === undefined) return { out: { kind: "respond", status: entry.status, headers, body: "" } };
        if (typeof b === "string") return { out: { kind: "respond", status: entry.status, headers, body: b } };
        return { out: { kind: "respond", status: entry.status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) } };
      },
    };
  }

  #upgrade(entry: FixtureEntry, headers: Record<string, string>, req: ModelRequest): ModelOutcome {
    let steps: StreamStep[] = [...(entry.stream ?? [])];
    if (this.faults.take("out-of-order-frame", req.method, req.path)) {
      const at = steps.findIndex((s, i) => s.dir === "out" && steps[i + 1]?.dir === "out");
      if (at < 0) {
        const reason = `out-of-order-frame is armed but fixture entry seq ${entry.seq} has no two consecutive "out" frames to swap; give the stream two server frames in a row`;
        return { kind: "unmatched", reason };
      }
      steps = [...steps.slice(0, at), steps[at + 1]!, steps[at]!, ...steps.slice(at + 2)];
    }
    return { kind: "upgrade", headers, steps };
  }

  #mismatch(e: FixtureEntry, req: ModelRequest): string | undefined {
    if (e.method !== req.method) return `method is ${req.method}, expected ${e.method}`;
    if (e.path !== req.path) return `path is ${req.path}, expected ${e.path}`;
    const wantQ = flatQuery(Object.fromEntries(Object.entries(e.query ?? {}).map(([k, v]) => [k, [v]])));
    const gotQ = flatQuery(req.query);
    if (!isDeepStrictEqual(wantQ, gotQ)) return `query is ?${gotQ.join("&")}, expected ?${wantQ.join("&")}`;
    if ((e.stream !== undefined) !== req.upgrade)
      return e.stream === undefined ? "expected a plain HTTP request but got a websocket upgrade" : "expected a websocket upgrade but got a plain HTTP request";
    for (const [k, v] of Object.entries(e.match?.requestHeaders ?? {})) {
      const got = req.headers[k.toLowerCase()];
      if (got !== v)
        return got === undefined
          ? `header ${k} is missing, expected the fixture's value`
          : `header ${k} differs from the fixture's value (a retry must resend the same one)`;
    }
    if ("requestBody" in e) {
      const p = parseBody(req.rawBody);
      if (!p.ok || !isDeepStrictEqual(p.value, e.requestBody)) return "request body differs from the fixture's requestBody";
    }
    if (e.match?.requestBodySha256 !== undefined) {
      if (bodySha256(req.rawBody) !== e.match.requestBodySha256) return "request body sha256 differs from match.requestBodySha256";
    } else if (!("requestBody" in e) && req.rawBody !== "") {
      return "the request has a body but the fixture entry declares none (set requestBody or match.requestBodySha256)";
    }
    return undefined;
  }
}
