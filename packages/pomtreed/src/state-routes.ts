// HTTP handlers for /v1/state/* (SPEC workflow-store): a thin shell over the StateStore port and the pure state-policy. Keys carry
// slashes, so owner/key/prefix travel in the query or body, never the path. Every mutating or bulk call is store write, then one
// content-free `ext.pomtreed.state_op` journal entry (idempotent by key, so a retry replays both), then the ack.
// An agent never writes under the workflow-shared scope (SHARED_SCOPE, `ext/s/`), whatever its grants: a put or key removal there, an
// import with a key there, and a prefix removal whose prefix reaches the scope (any prefix of `ext/s/`, such as `e` or `ext/`) are all
// 403. So an agent cannot remove an owner's documents wholesale, even with a whole-owner rw grant: it removes by a prefix outside the
// scope, or key by key; only the operator (and the extension's workflows) may clear the shared scope.
import { randomUUID } from "node:crypto";
import {
  checkStateKey,
  checkStateListPrefix,
  checkStateOwner,
  checkStateRemove,
  clampStateListLimit,
  encodeStateValue,
  StaleGenerationError,
  StateError,
} from "@pomtree/core";
import type { AgentId, AgentRecord, ExtensionJournalPayload, JsonValue, StateStore, StateWriter } from "@pomtree/core";
import { IDEMPOTENCY_KEY_REQUIRED } from "./error-codes.ts";
import type { Principal } from "./auth.ts";
import { effectiveGrants, grantedOwners, mayState, reachesShared, redactionChangesIds, SHARED_SCOPE, stateOpPayload } from "./state-policy.ts";
import type { StatePolicy, StatePrincipal, StateVerb } from "./state-policy.ts";

export const STATE_IMPORT_MAX_DOCS = 1000;
const IDEM_MAX = 200;

export interface StateRouteDeps {
  store: StateStore;
  policy: StatePolicy;
  get(id: AgentId): Promise<AgentRecord | null>;
  root(): Promise<AgentRecord>;
  record(rec: AgentRecord, payload: ExtensionJournalPayload, key: string): Promise<unknown>;
  redactText(text: string): string;
}

export interface StateRouteRequest {
  principal: Principal;
  method: string;
  sub: string[]; // path segments after /v1/state
  query: URLSearchParams;
  body: unknown;
  fence(): Promise<void>; // the agent token's generation fence (throws StaleGenerationError)
}

export interface StateRouteResponse {
  status: number;
  body: unknown;
}

class Refusal extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const bodyObj = (b: unknown): Record<string, unknown> => {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Refusal(400, "body must be a JSON object");
  return b as Record<string, unknown>;
};

const idemOf = (o: Record<string, unknown> | URLSearchParams): string | undefined => {
  const v = o instanceof URLSearchParams ? (o.get("idempotencyKey") ?? undefined) : o.idempotencyKey;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "" || v.length > IDEM_MAX) throw new Refusal(400, `idempotencyKey must be 1-${IDEM_MAX} characters`);
  return v;
};

const requireIdem = (o: Record<string, unknown>): string => {
  const k = idemOf(o);
  if (k === undefined) throw new Refusal(400, IDEMPOTENCY_KEY_REQUIRED);
  return k;
};

const optNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "number") throw new Refusal(400, `${what} must be a number`);
  return v;
};

const queryStr = (q: URLSearchParams, k: string): string | undefined => {
  const v = q.get(k);
  return v === null || v === "" ? undefined : v;
};

// Maps a store/validation error to its HTTP status; anything else is not a policy outcome and propagates (500 upstream).
function refusalOf(e: unknown): Refusal | null {
  if (e instanceof Refusal) return e;
  if (e instanceof StaleGenerationError) return new Refusal(403, e.message);
  if (e instanceof StateError) {
    const status = e.kind === "invalid-key" || e.kind === "invalid-value" ? 400 : e.kind === "too-large" ? 413 : e.kind === "unknown-writer" ? 403 : 409;
    return new Refusal(status, e.message, { kind: e.kind });
  }
  return null;
}

export async function handleState(deps: StateRouteDeps, req: StateRouteRequest): Promise<StateRouteResponse> {
  try {
    return await dispatch(deps, req);
  } catch (e) {
    const r = refusalOf(e);
    if (!r) throw e;
    return { status: r.status, body: { error: r.message, ...r.extra } };
  }
}

async function dispatch(deps: StateRouteDeps, req: StateRouteRequest): Promise<StateRouteResponse> {
  const { principal: p } = req;
  // Host and extension tokens never reach state over HTTP (an extension uses its host facade); only the operator and live agents do.
  if (p.scope !== "operator" && p.scope !== "agent") throw new Refusal(403, "operator or agent scope required");
  let actor: StatePrincipal;
  let journalOn: AgentRecord;
  let writer: StateWriter;
  let by: "operator" | "agent";
  if (p.scope === "operator") {
    actor = { operator: true };
    journalOn = await deps.root();
    writer = { operator: true };
    by = "operator";
  } else {
    await req.fence();
    const rec = await deps.get(p.agent);
    if (!rec || rec.state !== "running") throw new Refusal(403, "agent is not running");
    actor = { grants: await effectiveGrants(deps.policy.grantsFor, rec, deps.get) };
    journalOn = rec;
    // The token's generation, not the registry's: the store's fence compares it with the registry's, so a stale token is refused there too.
    writer = { agent: rec.id, host: rec.host, generation: p.generation };
    by = "agent";
  }
  // `key` is a document key, or with `prefix` a key prefix ("" = the whole owner).
  const allow = (verb: StateVerb, owner: string, key: string, prefix = false): void => {
    if (!mayState(actor, verb, owner, key)) throw new Refusal(403, `no ${verb === "read" ? "read" : "write"} grant for ${owner}`);
    // Defense in depth over the grant parser: whatever its grants, an agent never writes a key under the workflow-shared scope nor
    // removes by a prefix reaching it, so a doc there is always workflow- or operator-written. Reads stay grant-governed.
    if (verb === "write" && by === "agent" && (prefix ? reachesShared(key) : key.startsWith(SHARED_SCOPE)))
      throw new Refusal(403, `agents may not write under ${SHARED_SCOPE}: only the extension's workflows (sharedStore: rw) and the operator write there`);
  };
  // Mutating and bulk calls refuse identifiers the journal would redact (a host path inside a key), before any write.
  const journalSafe = (...ids: (string | undefined)[]): void => {
    if (redactionChangesIds((t) => deps.redactText(t), ids)) throw new Refusal(400, "state identifiers must not contain host paths");
  };
  // The store de-duplicates journal entries by key alone, so a mutating key folds in the owner (two owners may reuse one caller key), and a
  // read (idem undefined) gets a fresh key: the caller's key never suppresses another export's audit row.
  const journal = async (idem: string | undefined, payload: Parameters<typeof stateOpPayload>[0]): Promise<void> => {
    await deps.record(journalOn, stateOpPayload(payload), `state:${payload.op}:${idem === undefined ? randomUUID() : `${payload.owner}:${idem}`}`);
  };
  const [verb] = req.sub;
  const m = req.method;
  const q = req.query;

  if (verb === undefined && m === "GET") {
    const owner = queryStr(q, "owner");
    if (owner === undefined) {
      if (by === "operator") throw new Refusal(400, "owner is required");
      return { status: 200, body: { owners: grantedOwners(actor) } };
    }
    const prefix = queryStr(q, "prefix");
    const after = queryStr(q, "after");
    checkStateOwner(owner);
    checkStateListPrefix(prefix);
    if (after !== undefined) checkStateKey(after);
    allow("read", owner, prefix ?? "");
    const limit = clampStateListLimit(q.has("limit") ? Number(q.get("limit")) : undefined);
    const docs = await deps.store.list(owner, { ...(prefix !== undefined && { prefix }), ...(after !== undefined && { after }), limit });
    return { status: 200, body: { docs, ...(docs.length === limit && { next: docs[docs.length - 1]?.key }) } };
  }

  if (verb === "doc" && req.sub.length === 1 && m === "GET") {
    const owner = queryStr(q, "owner");
    const key = queryStr(q, "key");
    checkStateOwner(owner);
    checkStateKey(key);
    allow("read", owner as string, key as string);
    const doc = await deps.store.get(owner as string, key as string);
    if (!doc) throw new Refusal(404, "no such state document");
    return { status: 200, body: { doc } };
  }

  if (verb === "doc" && req.sub.length === 1 && m === "PUT") {
    const b = bodyObj(req.body);
    const idem = requireIdem(b);
    const { owner, key } = b;
    checkStateOwner(owner);
    checkStateKey(key);
    if (!("value" in b)) throw new Refusal(400, "value is required");
    const expectRev = b.expectRev === null ? null : optNum(b.expectRev, "expectRev");
    allow("write", owner as string, key as string);
    journalSafe(owner as string, key as string);
    const res = await deps.store.put(
      { owner: owner as string, key: key as string, value: b.value as JsonValue, ...(expectRev !== undefined && { expectRev }), writer },
      idem,
    );
    if (!res.ok) throw new Refusal(409, "state revision conflict", { reason: "conflict", currentRev: res.currentRev });
    await journal(idem, { op: "put", owner: res.doc.owner, key: res.doc.key, rev: res.doc.rev, bytes: res.doc.bytes, by });
    return { status: 200, body: { doc: res.doc } };
  }

  if (verb === "rm" && req.sub.length === 1 && m === "POST") {
    const b = bodyObj(req.body);
    const idem = requireIdem(b);
    const rm = {
      owner: b.owner as string,
      ...(b.key !== undefined && { key: b.key as string }),
      ...(b.prefix !== undefined && { prefix: b.prefix as string }),
      ...(b.olderThanMs !== undefined && { olderThanMs: b.olderThanMs as number }),
      ...(b.expectRev !== undefined && { expectRev: b.expectRev as number }),
      writer,
    };
    checkStateRemove(rm);
    allow("write", rm.owner, rm.key ?? rm.prefix ?? "", rm.key === undefined);
    journalSafe(rm.owner, rm.key, rm.prefix);
    const res = await deps.store.remove(rm, idem);
    if (!res.ok) throw new Refusal(409, "state revision conflict", { reason: "conflict", currentRev: res.currentRev });
    await journal(idem, {
      op: "rm",
      owner: rm.owner,
      ...(rm.key !== undefined && { key: rm.key }),
      ...(rm.prefix !== undefined && { prefix: rm.prefix }),
      count: res.removed,
      by,
    });
    return { status: 200, body: { removed: res.removed, keys: res.keys } };
  }

  if (verb === "export" && req.sub.length === 1 && m === "GET") {
    const owner = queryStr(q, "owner");
    const prefix = queryStr(q, "prefix");
    checkStateOwner(owner);
    checkStateListPrefix(prefix);
    allow("read", owner as string, prefix ?? "");
    journalSafe(owner, prefix);
    const docs = await deps.store.export(owner as string, prefix !== undefined ? { prefix } : {});
    idemOf(q); // still validated, but never the journal key: each export is its own audit entry
    await journal(undefined, { op: "export", owner: owner as string, ...(prefix !== undefined && { prefix }), count: docs.length, by });
    return { status: 200, body: { owner, docs: docs.map((d) => ({ key: d.key, rev: d.rev, value: d.value })) } };
  }

  if (verb === "import" && req.sub.length === 1 && m === "POST") {
    const b = bodyObj(req.body);
    const idem = requireIdem(b);
    const { owner } = b;
    checkStateOwner(owner);
    if (!Array.isArray(b.docs) || b.docs.length < 1 || b.docs.length > STATE_IMPORT_MAX_DOCS)
      throw new Refusal(400, `docs must be an array of 1 to ${STATE_IMPORT_MAX_DOCS}`);
    const docs: { key: string; value: JsonValue }[] = [];
    const seen = new Set<string>();
    for (const d of b.docs as unknown[]) {
      const o = bodyObj(d);
      checkStateKey(o.key);
      if (!("value" in o)) throw new Refusal(400, "every doc needs a value");
      if (seen.has(o.key as string)) throw new Refusal(400, `duplicate key ${o.key as string}`);
      seen.add(o.key as string);
      encodeStateValue(o.value); // validates the whole batch before the first write
      docs.push({ key: o.key as string, value: o.value as JsonValue });
    }
    for (const d of docs) allow("write", owner as string, d.key);
    journalSafe(owner as string, ...docs.map((d) => d.key));
    // Pre-validate the aggregate against the owner quota (new document slots, net byte delta vs the live docs) so a quota or size refusal
    // writes nothing. Residual non-atomic window: a concurrent writer racing the check, or a crash mid-loop, can leave a prefix written;
    // each put is idempotent under a key derived from the import key, so a retry converges.
    // TODO(state-import-atomic): no store-level multi-document transaction; the residual window above remains, and `pomtree state import` sends
    // large files as several calls (each pre-validated here against the quota as it then stands), so a quota refusal on a later batch leaves earlier ones written.
    const limits = deps.policy.limitsFor(owner as string);
    const usage = await deps.store.usage(owner as string);
    let newDocs = 0;
    let byteDelta = 0;
    for (const d of docs) {
      const bytes = encodeStateValue(d.value).bytes;
      if (bytes > limits.maxDocBytes) throw new StateError("too-large", `document ${d.key} exceeds ${limits.maxDocBytes} bytes`);
      const cur = await deps.store.get(owner as string, d.key);
      if (cur === null) newDocs++;
      byteDelta += bytes - (cur?.bytes ?? 0);
    }
    if (usage.docs + newDocs > limits.maxDocs) throw new StateError("quota-docs", `owner ${owner as string} would exceed its ${limits.maxDocs} document limit`);
    if (usage.bytes + byteDelta > limits.maxOwnerBytes)
      throw new StateError("quota-owner-bytes", `owner ${owner as string} would exceed its ${limits.maxOwnerBytes} byte limit`);
    for (const d of docs) await deps.store.put({ owner: owner as string, key: d.key, value: d.value, writer }, `${idem}:import:${d.key}`);
    await journal(idem, { op: "import", owner: owner as string, count: docs.length, by });
    return { status: 200, body: { imported: docs.length } };
  }

  throw new Refusal(404, "not found");
}
