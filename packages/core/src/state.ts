import { StateError } from "./errors.ts";
import { STATE_LIST_LIMIT_MAX } from "./ports.ts";
import type { StateRemoveRequest } from "./ports.ts";
import { canonical } from "./template.ts";
import { STATE_DOC_BYTES_CONFIG_MAX, STATE_KEY_MAX_LENGTH, STATE_LIMITS_DEFAULT, STATE_OWNER_RE, STATE_TOMBSTONES_CEILING, validStateKey } from "./types.ts";
import type { StateLimits, StateWriter } from "./types.ts";

// The single definition of state-request validation, shared by every StateStore realization and by the daemon and CLI.
// Pure: every function either returns or throws StateError.

export const STATE_VALUE_MAX_DEPTH = 64;
const PREFIX_RE = /^[a-z0-9._/-]+$/;

const bad = (what: string): never => {
  throw new StateError("invalid-key", what);
};

export function checkStateOwner(owner: unknown): void {
  if (typeof owner !== "string" || owner.length > STATE_KEY_MAX_LENGTH || !STATE_OWNER_RE.test(owner)) bad(`invalid state owner ${JSON.stringify(owner)}`);
}

export function checkStateKey(key: unknown): void {
  if (typeof key !== "string" || !validStateKey(key)) bad(`invalid state key ${JSON.stringify(key)}`);
}

// A non-empty key prefix (not necessarily a whole segment): same alphabet as keys plus no "..", at most the key length bound.
export function checkStatePrefix(prefix: unknown): void {
  if (typeof prefix !== "string" || prefix.length > STATE_KEY_MAX_LENGTH || prefix.includes("..") || !PREFIX_RE.test(prefix)) {
    bad(`invalid state prefix ${JSON.stringify(prefix)}`);
  }
}

// A list/export prefix: absent or empty means no filter.
export function checkStateListPrefix(prefix: unknown): void {
  if (prefix !== undefined && prefix !== "") checkStatePrefix(prefix);
}

export function checkStateExpectRev(e: unknown): void {
  if (e !== undefined && e !== null && !(typeof e === "number" && Number.isSafeInteger(e) && e >= 0)) {
    throw new StateError("invalid-value", "expectRev must be null or a non-negative integer");
  }
}

// Remove takes exactly one of key or prefix; expectRev applies only to a key, olderThanMs only to a prefix.
export function checkStateRemove(req: Pick<StateRemoveRequest, "owner" | "key" | "prefix" | "expectRev" | "olderThanMs">): void {
  checkStateOwner(req.owner);
  if ((req.key === undefined) === (req.prefix === undefined)) bad("remove takes exactly one of key or prefix");
  if (req.key !== undefined) {
    checkStateKey(req.key);
    if (req.olderThanMs !== undefined) bad("olderThanMs applies only to a prefix removal");
  } else {
    checkStatePrefix(req.prefix);
    if (req.expectRev !== undefined) bad("expectRev applies only to a single-key removal");
  }
  checkStateExpectRev(req.expectRev);
  if (req.expectRev === (null as unknown))
    throw new StateError("invalid-value", "expectRev for a removal must be a non-negative integer (0 = must be absent), not null");
  if (req.olderThanMs !== undefined && !(typeof req.olderThanMs === "number" && Number.isFinite(req.olderThanMs) && req.olderThanMs >= 0)) {
    throw new StateError("invalid-value", "olderThanMs must be a non-negative number");
  }
}

// Clamps to 1..STATE_LIST_LIMIT_MAX; absent or non-finite means the maximum.
export function clampStateListLimit(limit: number | undefined): number {
  return typeof limit === "number" && Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), STATE_LIST_LIMIT_MAX) : STATE_LIST_LIMIT_MAX;
}

// Strict JSON check (no undefined, NaN/Infinity, functions, class instances, cycles; depth capped) then the canonical encoding
// (object keys sorted recursively) and its UTF-8 byte length.
export function encodeStateValue(value: unknown): { json: string; bytes: number } {
  const check = (v: unknown, depth: number): void => {
    if (depth > STATE_VALUE_MAX_DEPTH) throw new StateError("invalid-value", `value nests deeper than ${STATE_VALUE_MAX_DEPTH} levels`);
    if (v === null || typeof v === "boolean" || typeof v === "string") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new StateError("invalid-value", "value contains a non-finite number");
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) check(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new StateError("invalid-value", "value contains a non-plain object");
      for (const x of Object.values(v as object)) check(x, depth + 1);
      return;
    }
    throw new StateError("invalid-value", `value contains a ${typeof v}`);
  };
  check(value, 0);
  const json = JSON.stringify(canonical(value));
  return { json, bytes: Buffer.byteLength(json) };
}

const WRITER_WORKFLOW_RE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/; // a qualified workflow name, `<ext>/<workflow>`
const WRITER_INSTANCE_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63})?$/; // a workflow instance, or "" for one that declares none

// A writer is exactly { operator: true }, the full agent shape { agent, host, generation }, or the workflow shape
// { workflow, instance }: nothing partial, nothing extra.
export function checkStateWriter(writer: unknown): void {
  const w = writer as Record<string, unknown> | null;
  const keys = typeof w === "object" && w !== null && !Array.isArray(w) ? Object.keys(w).sort().join(",") : "";
  const ok =
    keys === "operator"
      ? w?.operator === true
      : keys === "instance,workflow"
        ? typeof w?.workflow === "string" && WRITER_WORKFLOW_RE.test(w.workflow) && typeof w.instance === "string" && WRITER_INSTANCE_RE.test(w.instance)
        : keys === "agent,generation,host" &&
          typeof w?.agent === "string" &&
          w.agent !== "" &&
          typeof w.host === "string" &&
          w.host !== "" &&
          typeof w.generation === "number" &&
          Number.isSafeInteger(w.generation) &&
          w.generation >= 0;
  if (!ok) throw new StateError("invalid-value", "writer must be { operator: true }, { agent, host, generation } or { workflow, instance }");
}

// A request's fence is absent or exactly { agent, generation }. A workflow writer carries no task of its own, so it must carry a fence
// (the task it runs as): without one it would be written unfenced. Call after checkStateWriter.
export function checkStateFence(writer: StateWriter, fence: unknown): void {
  if (fence === undefined) {
    if ("workflow" in writer) throw new StateError("invalid-value", "a workflow writer requires fence { agent, generation } (the task it runs as)");
    return;
  }
  const f = fence as Record<string, unknown> | null;
  const ok =
    typeof f === "object" &&
    f !== null &&
    Object.keys(f).sort().join(",") === "agent,generation" &&
    typeof f.agent === "string" &&
    f.agent !== "" &&
    Number.isSafeInteger(f.generation) &&
    (f.generation as number) >= 0;
  if (!ok) throw new StateError("invalid-value", "fence must be { agent, generation }");
}

// The writer's identity in an idempotency fingerprint, so principals never collide on a key. A workflow writer is identified by
// workflow + instance, never by the task (the fence), so a repaired task replays its predecessor's write.
export const stateWriterId = (w: StateWriter): string =>
  "agent" in w ? `agent:${w.agent}` : "workflow" in w ? `workflow:${w.workflow}:${w.instance}` : "operator";

// The effective limits: maxDocBytes and maxTombstones may only be lower than their ceilings. Applied by every realization and by the config parser.
export const clampStateLimits = (l: StateLimits): StateLimits => ({
  ...l,
  maxDocBytes: Math.min(l.maxDocBytes, STATE_DOC_BYTES_CONFIG_MAX),
  maxTombstones: Math.min(l.maxTombstones, STATE_TOMBSTONES_CEILING),
});

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LIMIT_FIELDS = ["maxDocs", "maxDocBytes", "maxOwnerBytes", "maxTombstones"] as const;

function parseLimits(where: string, v: unknown, base: StateLimits): StateLimits {
  if (!isPlain(v)) throw new Error(`POMTREED_STATE_LIMITS: ${where} must be an object`);
  const out = { ...base };
  for (const [k, n] of Object.entries(v)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(k)) throw new Error(`POMTREED_STATE_LIMITS: unknown field ${k} in ${where}`);
    const min = k === "maxTombstones" ? 0 : 1;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < min) {
      throw new Error(`POMTREED_STATE_LIMITS: ${where}.${k} must be ${min === 0 ? "a non-negative" : "a positive"} integer`);
    }
    out[k as (typeof LIMIT_FIELDS)[number]] = n;
  }
  return clampStateLimits(out);
}

// `POMTREED_STATE_LIMITS`: {default?: Limits, owners?: {name: Limits}}; unset fields inherit (the default, then the core defaults).
// Shared by the daemon and standalone tools so both apply the same quotas from the same env value.
export function parseStateLimits(raw = "{}"): { limitsFor: (owner: string) => StateLimits; owners: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    throw new Error("invalid POMTREED_STATE_LIMITS JSON");
  }
  if (!isPlain(value)) throw new Error("POMTREED_STATE_LIMITS must be an object");
  for (const k of Object.keys(value)) if (k !== "default" && k !== "owners") throw new Error(`POMTREED_STATE_LIMITS: unknown key ${k}`);
  const base = parseLimits("default", value.default ?? {}, STATE_LIMITS_DEFAULT);
  const owners = new Map<string, StateLimits>();
  if (value.owners !== undefined) {
    if (!isPlain(value.owners)) throw new Error("POMTREED_STATE_LIMITS: owners must be an object");
    for (const [name, l] of Object.entries(value.owners)) {
      if (!STATE_OWNER_RE.test(name)) throw new Error(`POMTREED_STATE_LIMITS: invalid owner ${JSON.stringify(name)}`);
      owners.set(name, parseLimits(`owners.${name}`, l, base));
    }
  }
  return { limitsFor: (owner) => owners.get(owner) ?? base, owners: [...owners.keys()] };
}
