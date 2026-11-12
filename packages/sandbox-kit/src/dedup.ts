// Create deduplication for hosted sandbox adapters.
//
// A create can be lost after it was sent (timeout, 5xx, dropped connection), so the caller cannot tell whether the provider
// made the sandbox. `createOnce` never retries a create blindly: it reconciles first (looks the sandbox up again) and either
// adopts what it finds or raises SandboxOutcomeUnknownError carrying the derived id. Pure: every provider call, the sleep and
// the clock are injected.

import { SandboxOutcomeUnknownError, sandboxIdForKey } from "@pomtree/core";
import type { SandboxId } from "@pomtree/core";
import { type NameSchema, TagCodecError, decodeName, encodeName, matchesField } from "./tags.ts";

// A sandbox seen by `find`, with its tags already decoded (hashed values resolved by the adapter via decodeTags).
export interface FoundSandbox {
  id: SandboxId;
  // The resource name, when the provider has one.
  name?: string;
  tags: Readonly<Record<string, string>>;
}

export interface CreateRequest {
  // The caller's idempotency key and the id derived from it (sandboxIdForKey).
  key: string;
  derivedId: SandboxId;
  // Present for `unique-name` only: the validated resource name.
  name?: string;
  // Present for `native-token` only: the idempotency token to send with the create.
  token?: string;
}

// How the adapter classifies a failed create. `name-in-use` is the provider's duplicate-name answer; `unknown` means the
// request may have been applied (timeout, 5xx, connection drop after send); `failed` means it definitely was not (4xx,
// quota, auth), and the original error is rethrown unchanged.
export type CreateFailure = "name-in-use" | "unknown" | "failed";

export interface FindQuery {
  name?: string;
  // The encoded idempotency tag (tag-lookup) or any tag set to match.
  tags?: Readonly<Record<string, string>>;
}

export interface DedupDeps {
  create(req: CreateRequest): Promise<{ id: SandboxId }>;
  find(query: FindQuery): Promise<FoundSandbox[]>;
  classify(err: unknown): CreateFailure;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ProbePolicy {
  // Lookups after an unknown outcome, spaced by `intervalMs` (3 probes over about 10 seconds by default).
  probes: number;
  intervalMs: number;
}

export const DEFAULT_PROBE_POLICY: ProbePolicy = { probes: 3, intervalMs: 3500 };

interface Common {
  key: string;
  // Tags every adopted sandbox must carry with these exact (decoded) values: the owner tags (host, generation, ...).
  ownerTags: Readonly<Record<string, string>>;
  probe?: ProbePolicy;
}

export type DedupStrategy =
  | (Common & {
      mechanism: "unique-name";
      // Name format: `<prefix>-<first idChars hex of the derived id>`; limits are the backend's own.
      names: { schema: NameSchema; idChars: number };
    })
  | (Common & {
      mechanism: "native-token";
      token: string;
      // Tag set that finds this key's sandbox once the provider's token window has passed.
      lookupTags: Readonly<Record<string, string>>;
      // The provider only replays a token for this long after the first send; later it is a fresh create.
      idempotencyWindowMs: number;
      // Create attempts (the first plus replays) while unknown, all inside the window.
      maxAttempts?: number;
    })
  | (Common & {
      mechanism: "tag-lookup";
      // The encoded idempotency tag set (it must include the derived id) the created sandbox is stamped with.
      lookupTags: Readonly<Record<string, string>>;
    });

export interface CreateOnceResult {
  id: SandboxId;
  // True when an existing sandbox was taken over instead of created by this call.
  adopted: boolean;
}

export class DedupError extends Error {
  override name = "DedupError";
}

// Keys of the expected tags the found sandbox lacks or carries with another value.
function differing(found: FoundSandbox, expected: Readonly<Record<string, string>>): string[] {
  return Object.entries(expected)
    .filter(([k, v]) => found.tags[k] !== v)
    .map(([k]) => k);
}

function refuse(found: FoundSandbox, why: string): never {
  throw new DedupError(
    `sandbox ${found.id} already exists for this key but ${why}; it belongs to someone else, so it was not adopted: use a different idempotency key or remove the sandbox by hand`,
  );
}

// Adoption verifies ownership first: a same-key sandbox of another owner (or with a foreign name) is refused, never adopted.
// Policy question: a leftover sandbox of an earlier generation of the same key (generation tag differs, host matches) is
// refused today; whether to adopt it, replace it or keep refusing is the maintainer's decision.
function adopt(found: FoundSandbox, s: DedupStrategy, derivedId: SandboxId): CreateOnceResult {
  const owner = differing(found, s.ownerTags);
  if (owner.length > 0) refuse(found, `its owner tags differ from this daemon's (differing tags: ${owner.join(", ")})`);
  // A sloppy adapter selector must not adopt a stranger: the sandbox must carry the lookup tags it was found by.
  if (s.mechanism !== "unique-name") {
    const lookup = differing(found, s.lookupTags);
    if (lookup.length > 0) refuse(found, `it does not carry the lookup tags (missing or different: ${lookup.join(", ")})`);
  }
  if (s.mechanism === "unique-name") {
    if (found.name === undefined) refuse(found, "it has no resource name to verify");
    try {
      const fields = decodeName(s.names.schema, found.name);
      if (!matchesField(s.names.schema, fields.sandbox as string, derivedId.slice(0, s.names.idChars))) refuse(found, "its name encodes a different key");
    } catch (e) {
      if (e instanceof TagCodecError) refuse(found, `its name is foreign or damaged (${e.message})`);
      throw e;
    }
  }
  return { id: found.id, adopted: true };
}

// More than one sandbox matches one key. It is an unknown outcome for callers (they cannot pick one), but it is not a lost
// reply, so the message says what happened.
export class AmbiguousMatchError extends SandboxOutcomeUnknownError {
  constructor(derivedId: SandboxId, key: string, ids: string[]) {
    super(derivedId, key);
    this.name = "AmbiguousMatchError";
    this.message = `${ids.length} sandboxes match idempotency key ${key} (${ids.join(", ")}), so none was adopted; stop the extra sandboxes by hand, then retry`;
  }
}

function pickOne(found: FoundSandbox[], derivedId: SandboxId, key: string): FoundSandbox | undefined {
  if (found.length > 1) {
    throw new AmbiguousMatchError(
      derivedId,
      key,
      found.map((f) => f.id),
    );
  }
  return found[0];
}

function lookupQuery(s: DedupStrategy, name: string | undefined): FindQuery {
  return s.mechanism === "unique-name" ? { name } : { tags: s.lookupTags };
}

// Looks up the sandbox up to `probes` times; returns the first non-empty answer, or [] when every probe was empty.
async function probe(s: DedupStrategy, name: string | undefined, deps: DedupDeps): Promise<FoundSandbox[]> {
  const policy = s.probe ?? DEFAULT_PROBE_POLICY;
  for (let i = 0; i < policy.probes; i++) {
    if (i > 0) await deps.sleep(policy.intervalMs);
    const found = await deps.find(lookupQuery(s, name));
    if (found.length > 0) return found;
  }
  return [];
}

// A failing lookup after an unknown create leaves the outcome unknown: keep the derived id and name the find error as the cause.
async function probeOrUnknown(s: DedupStrategy, name: string | undefined, deps: DedupDeps, derivedId: SandboxId): Promise<FoundSandbox[]> {
  try {
    return await probe(s, name, deps);
  } catch (e) {
    throw new SandboxOutcomeUnknownError(derivedId, s.key, e);
  }
}

export function derivedName(s: Extract<DedupStrategy, { mechanism: "unique-name" }>, derivedId: SandboxId): string {
  // encodeName throws TagCodecError for an over-length or illegal name; the adapter fixes its schema.
  return encodeName(s.names.schema, { sandbox: derivedId.slice(0, s.names.idChars) });
}

export async function createOnce(s: DedupStrategy, deps: DedupDeps): Promise<CreateOnceResult> {
  const policy = s.probe ?? DEFAULT_PROBE_POLICY;
  if (!Number.isInteger(policy.probes) || policy.probes < 1) {
    throw new RangeError(
      `probe policy probes is ${policy.probes} but must be an integer of at least 1; with none, an unknown outcome could never be reconciled, so set at least one lookup`,
    );
  }
  if (!(Number.isFinite(policy.intervalMs) && policy.intervalMs >= 0)) {
    throw new RangeError(
      `probe policy intervalMs is ${policy.intervalMs} but must be a finite number of milliseconds, 0 or more; set the wait between lookups`,
    );
  }
  const derivedId = sandboxIdForKey(s.key);
  const name = s.mechanism === "unique-name" ? derivedName(s, derivedId) : undefined;
  const req: CreateRequest = { key: s.key, derivedId };
  if (name !== undefined) req.name = name;
  if (s.mechanism === "native-token") req.token = s.token;

  // tag-lookup and native-token: an earlier attempt (possibly from a crashed run, past the provider's token window) may
  // already have made it. A failing lookup here happens before any create, so it propagates unchanged.
  if (s.mechanism !== "unique-name") {
    const existing = pickOne(await deps.find(lookupQuery(s, name)), derivedId, s.key);
    if (existing !== undefined) return adopt(existing, s, derivedId);
  }

  const startedAt = deps.now();
  const maxAttempts = s.mechanism === "native-token" ? (s.maxAttempts ?? 3) : 1;
  let lastUnknown: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { id: (await deps.create(req)).id, adopted: false };
    } catch (err) {
      const kind = deps.classify(err);
      if (kind === "failed") throw err;
      if (kind === "name-in-use") {
        if (s.mechanism !== "unique-name") throw err;
        // Listings can lag, so look for the holder with the bounded probe policy before calling the name foreign.
        const hit = pickOne(await probeOrUnknown(s, name, deps, derivedId), derivedId, s.key);
        if (hit === undefined) {
          throw new SandboxOutcomeUnknownError(
            derivedId,
            s.key,
            new DedupError(
              `the provider says the name ${name} is in use but listing finds no such sandbox after ${(s.probe ?? DEFAULT_PROBE_POLICY).probes} lookups; a foreign or hidden resource holds the name, so remove it or change the name prefix`,
            ),
          );
        }
        return adopt(hit, s, derivedId);
      }
      lastUnknown = err;
      // native-token: the provider replays the same token to the same result, but only inside its window.
      if (s.mechanism === "native-token" && attempt < maxAttempts && deps.now() - startedAt < s.idempotencyWindowMs) continue;
      break;
    }
  }

  // Unknown outcome: look again before anything else. Never create a second time.
  const found = pickOne(await probeOrUnknown(s, name, deps, derivedId), derivedId, s.key);
  if (found !== undefined) return adopt(found, s, derivedId);
  throw new SandboxOutcomeUnknownError(derivedId, s.key, lastUnknown);
}
