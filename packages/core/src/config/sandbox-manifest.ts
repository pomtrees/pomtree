// Sandbox backend configuration: the keys under `sandbox.<id>.*` are never written in the core table. Each backend (a built-in
// adapter package or an extension's `provides` entry) declares them statically in a manifest, and composeRegistry (extend.ts)
// mounts them beside the one standard key set every backend gets, validated by the same checks as the core table. Core never names
// a vendor. Pure: no env or fs access.
//
// Selection (`sandbox.backend`): a flat string key. The core table accepts any well-formed id (a provider's id is not known until
// its manifest is composed), config.schema.json lists the built-in ids and stays open to others, and composeRegistry closes the
// set: the composed key accepts `auto`, the built-in ids and the ids composed backends contribute, and refuses anything else with the list.
import { RESERVED_SANDBOX_BACKEND_IDS, validateBackendId } from "../sandbox-backend.ts";
import { SANDBOX_NAMESPACE, didYouMean, extensionSegment, sandboxCredentialEnv } from "./env-name.ts";
import type { ExtParamDecl } from "./extend.ts";
import { EXT_CREDENTIAL_RE, parseExtensionParams } from "./extend.ts";
import type { ParamDef } from "./registry.ts";

// The first-party backends: ids no extension may provide. `auto` is the selection keyword and is not a backend.
export const BUILTIN_SANDBOX_BACKEND_IDS: readonly string[] = RESERVED_SANDBOX_BACKEND_IDS.filter((id) => id !== "auto");
export const SANDBOX_BACKEND_AUTO = "auto";
export const SANDBOX_BACKEND_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

// A backend's declaration for composition. `owner` names who declared it in every error: the adapter package for a built-in, the
// extension for a contributed backend. Only a built-in may change the standard keys' defaults (`defaults`).
export interface SandboxBackendConfigDecl {
  readonly id: string;
  readonly owner: string;
  readonly builtin: boolean;
  readonly params: readonly ExtParamDecl[];
  readonly credentials?: readonly string[];
  readonly defaults?: Readonly<Record<string, number | string>>;
}

// An extension's `provides` entries (kind sandbox) as backend declarations. Shapes are not checked here: the caller validates `params`
// with parseExtensionParams first (composeRegistry then checks ids, keys and defaults).
export function contributedBackends(
  extension: string,
  provides: readonly { kind: string; id: string; params?: readonly ExtParamDecl[]; credentials?: readonly string[] }[] | undefined,
): SandboxBackendConfigDecl[] {
  return (provides ?? [])
    .filter((p) => p.kind === "sandbox")
    .map((p) => ({ id: p.id, owner: extension, builtin: false, params: p.params ?? [], credentials: p.credentials ?? [] }));
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// The shipped manifest of a built-in adapter package (`packages/sandbox-<name>/manifest.json`): `{ "sandboxBackends": [{ "id", "params",
// "credentials"?, "defaults"? }] }`, one entry per backend id the package provides (the docker package provides docker and podman). Shape only; ids,
// keys and defaults are checked when composed. Every problem is returned, each naming the package.
export function parseSandboxManifest(owner: string, raw: unknown): { ok: true; backends: SandboxBackendConfigDecl[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const bad = (why: string) => void errors.push(`sandbox manifest ${owner}: ${why}`);
  if (!isPlain(raw) || !Array.isArray(raw.sandboxBackends)) return { ok: false, errors: [`sandbox manifest ${owner}: must be {"sandboxBackends": [...]}`] };
  for (const k of Object.keys(raw)) if (k !== "sandboxBackends") bad(`unknown field ${JSON.stringify(k)}; only sandboxBackends is allowed`);
  const backends: SandboxBackendConfigDecl[] = [];
  for (const [i, item] of (raw.sandboxBackends as unknown[]).entries()) {
    if (!isPlain(item) || typeof item.id !== "string") {
      bad(`sandboxBackends[${i}] must be an object with a string id`);
      continue;
    }
    for (const k of Object.keys(item))
      if (!["id", "params", "credentials", "defaults"].includes(k)) bad(`sandboxBackends[${i}] (${item.id}): unknown field ${JSON.stringify(k)}`);
    const params = parseExtensionParams(`${owner} backend ${item.id}`, item.params ?? []);
    if (!params.ok) errors.push(...params.errors);
    const credentials = item.credentials ?? [];
    if (!Array.isArray(credentials) || credentials.some((c) => typeof c !== "string")) {
      bad(`sandboxBackends[${i}] (${item.id}): credentials must be an array of names`);
      continue;
    }
    let defaults: Record<string, number | string> | undefined;
    if (item.defaults !== undefined) {
      if (!isPlain(item.defaults)) {
        bad(`sandboxBackends[${i}] (${item.id}): defaults must be an object of standard key -> value`);
        continue;
      }
      for (const [k, v] of Object.entries(item.defaults)) {
        const why = standardDefaultReason(k, v);
        if (why !== null) bad(`sandboxBackends[${i}] (${item.id}): defaults.${why}`);
      }
      defaults = item.defaults as Record<string, number | string>;
    }
    if (params.ok)
      backends.push({
        id: item.id,
        owner,
        builtin: true,
        params: params.params,
        credentials: credentials as string[],
        ...(defaults !== undefined && { defaults }),
      });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, backends };
}

// The reason `value` is not a valid default for the standard key `key`, or null: the key's kind, minimum and check, as the registry will apply them.
export function standardDefaultReason(key: string, value: unknown): string | null {
  const std = STANDARD_SANDBOX_KEYS.find((k) => k.key === key);
  if (std === undefined) return `${JSON.stringify(key)} is not a standard key (${STANDARD_SANDBOX_KEYS.map((k) => k.key).join(", ")})`;
  if (std.kind === "string") {
    if (typeof value !== "string") return `${key} must be a string`;
    return std.check?.(value) ?? null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return `${key} must be a non-negative integer`;
  if (std.min !== undefined && value < std.min) return `${key} ${value} is below its minimum ${std.min}`;
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const rateAsOfReason = (v: string): string | null =>
  v === "" || (DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v))
    ? null
    : `${JSON.stringify(v)} is not an ISO date; set it to the day you read the provider's price page, as YYYY-MM-DD (or leave it unset)`;

// `sandbox.backend`: the shape check of the core table (any well-formed id; the set is closed by composeRegistry).
export const sandboxBackendShapeReason = (v: string): string | null =>
  v === SANDBOX_BACKEND_AUTO || SANDBOX_BACKEND_ID_RE.test(v)
    ? null
    : `${JSON.stringify(v)} is not a sandbox backend id; use auto, a built-in id (${BUILTIN_SANDBOX_BACKEND_IDS.join(", ")}) or the id an installed extension provides (${SANDBOX_BACKEND_ID_RE.source})`;

// `sandbox.backend` in a composed registry: only `auto`, the built-in ids and the composed backends' ids.
export function sandboxBackendClosedCheck(backends: readonly { id: string; owner: string; builtin: boolean }[]): (v: string) => string | null {
  const contributed = backends.filter((b) => !b.builtin);
  const allowed = [SANDBOX_BACKEND_AUTO, ...BUILTIN_SANDBOX_BACKEND_IDS, ...contributed.map((b) => b.id)];
  const list = [SANDBOX_BACKEND_AUTO, ...BUILTIN_SANDBOX_BACKEND_IDS, ...contributed.map((b) => `${b.id} (extension ${b.owner})`)].join(", ");
  return (v) => {
    const shape = sandboxBackendShapeReason(v);
    if (shape !== null) return shape;
    if (allowed.includes(v)) return null;
    return `${JSON.stringify(v)} is not a known sandbox backend${didYouMean(v, allowed)}; allowed: ${list}. Set one of them, or install the extension that provides ${JSON.stringify(v)} in extensions.dir`;
  };
}

// `sandbox.reviewedBackends`: entries `<id>=sha256:<64 lowercase hex>`, one per contributed backend. Built-in ids need no pin.
export const REVIEWED_PIN_RE = /^sha256:[0-9a-f]{64}$/;
export function reviewedBackendsReason(entries: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const shown = JSON.stringify(entry);
    const hint = "write <id>=sha256:<64 lowercase hex>, the pin the extension's conformance command prints";
    if (eq <= 0) return `${shown} is not <id>=sha256:<hex>; ${hint}`;
    const id = entry.slice(0, eq);
    const pin = entry.slice(eq + 1);
    try {
      validateBackendId(id);
    } catch (e) {
      return `${shown}: ${e instanceof Error ? e.message : String(e)}; a built-in backend is never pinned`;
    }
    if (!REVIEWED_PIN_RE.test(pin)) return `${shown}: ${JSON.stringify(pin)} is not sha256:<64 lowercase hex>; ${hint}`;
    if (seen.has(id)) return `${shown}: ${id} is pinned twice; keep one pin per backend`;
    seen.add(id);
  }
  return null;
}

// The standard cost and capacity keys every backend gets (semantics: docs/economy.md and the placement design; money in micros,
// rates per hour so sub-micro per-second prices stay exact). Adapters may change defaults only, through `defaults`. Keys are relative
// to `sandbox.<id>.`; a dotted key sits in a group.
interface StandardKey {
  readonly key: string;
  readonly kind: "count" | "ms" | "micros" | "string";
  readonly default: number | string;
  readonly min?: number;
  readonly check?: (value: string) => string | null;
  readonly doc: string;
}
export const STANDARD_SANDBOX_KEYS: readonly StandardKey[] = [
  {
    key: "maxSandboxes",
    kind: "count",
    default: 0,
    doc: "Concurrent sandboxes on this backend; admission holds beyond it. 0 = no daemon-side ceiling (the provider's own limit applies).",
  },
  {
    key: "leaseMs",
    kind: "ms",
    default: 900_000,
    min: 1,
    doc: "Lease length that budget reserve-and-settle charges against; a backend that cannot extend its deadline also rotates the sandbox at 80% of it.",
  },
  {
    key: "region",
    kind: "string",
    default: "",
    doc: "The provider region sandboxes are created in. Unset: the backend has no regions, or the probe reports the problem and the action.",
  },
  {
    key: "rate.cpuHourMicros",
    kind: "micros",
    default: 0,
    doc: "Operator-stated price of one vCPU-hour in micro-dollars. 0 = unset; a billed backend with unset rates refuses boot.",
  },
  { key: "rate.memoryGibHourMicros", kind: "micros", default: 0, doc: "Operator-stated price of one GiB-hour of memory in micro-dollars. 0 = unset." },
  {
    key: "rate.storedGibHourMicros",
    kind: "micros",
    default: 0,
    doc: "Operator-stated price of one GiB-hour of state kept while a sandbox is stopped or paused. 0 = unset or free.",
  },
  { key: "rate.createMicros", kind: "micros", default: 0, doc: "Operator-stated fee for creating one sandbox, in micro-dollars. 0 = none." },
  { key: "rate.minBilledMs", kind: "ms", default: 0, doc: "Shortest lifetime the provider bills for, in milliseconds. 0 = none." },
  {
    key: "rate.asOf",
    kind: "string",
    default: "",
    check: rateAsOfReason,
    doc: "ISO date (YYYY-MM-DD) the rates above were read from the provider's price page, so stale prices are visible. Unset: no date.",
  },
  {
    key: "maxDayMicros",
    kind: "micros",
    default: 0,
    doc: "Daily runtime spend ceiling for this backend, in micro-dollars. 0 = a billed backend admits nothing until the operator sets it; unbilled local backends ignore it.",
  },
  { key: "maxRunMicros", kind: "micros", default: 0, doc: "Most one agent may spend on this backend over all its generations, in micro-dollars. 0 = unset." },
];

export interface SandboxBackendBuild {
  readonly params: ParamDef[];
  readonly backendOf: Map<string, string>; // key path -> backend id
  readonly backends: { id: string; owner: string; builtin: boolean; segment: string; credentials: readonly string[] }[];
}

// A key named like a secret must be declared as a credential (a mode-checked `_FILE`), never as a config key whose value would sit in env or the JSON file.
const CREDENTIAL_LIKE_KEY_RE = /^(key|token|secret|password|passwd|passphrase|credentials?)$|(token|secret|password|passwd|passphrase|apikey|privatekey)$/i;
const FLAT_KEY_RE = /^[a-z][a-zA-Z0-9]*$/;

// Composes every backend's keys: the standard set, then the manifest's own keys, as ParamDefs under `sandbox.<segment>.`. `corePaths`
// are the core registry's paths (a backend segment may not shadow a core `sandbox.<key>`). Every problem goes to `bad`, naming the
// backend and its owner; a refused backend contributes nothing.
export function composeSandboxKeys(corePaths: Iterable<string>, decls: readonly SandboxBackendConfigDecl[], bad: (why: string) => void): SandboxBackendBuild {
  const out: SandboxBackendBuild = { params: [], backendOf: new Map(), backends: [] };
  const coreLeaves = new Set([...corePaths].filter((p) => p.startsWith(`${SANDBOX_NAMESPACE}.`)).map((p) => p.split(".")[1] as string));
  const byId = new Map<string, SandboxBackendConfigDecl>();
  const bySegment = new Map<string, string>();
  const standardKeys = new Set(STANDARD_SANDBOX_KEYS.map((k) => k.key));
  const standardGroups = new Set(STANDARD_SANDBOX_KEYS.filter((k) => k.key.includes(".")).map((k) => k.key.split(".")[0] as string));
  for (const d of decls) {
    const fail = (why: string) => void bad(`sandbox backend ${d.id} (${d.builtin ? "built-in" : "extension"} ${d.owner}): ${why}`);
    const prior = byId.get(d.id);
    if (prior !== undefined) {
      bad(
        `sandbox backend ${JSON.stringify(d.id)} is provided by both ${prior.builtin ? "built-in" : "extension"} ${prior.owner} and ${d.builtin ? "built-in" : "extension"} ${d.owner}; ids are unique, so remove one of them or rename it`,
      );
      continue;
    }
    byId.set(d.id, d);
    if (d.builtin) {
      if (!BUILTIN_SANDBOX_BACKEND_IDS.includes(d.id)) {
        fail(`is not a built-in id (${BUILTIN_SANDBOX_BACKEND_IDS.join(", ")}); a backend an extension provides is declared in its manifest provides list`);
        continue;
      }
    } else {
      try {
        validateBackendId(d.id);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
        continue;
      }
    }
    const segment = extensionSegment(d.id);
    if (segment === null) {
      fail("has no config segment");
      continue;
    }
    if (coreLeaves.has(segment)) {
      fail(`its config segment sandbox.${segment}. collides with the core key sandbox.${segment}; rename the backend`);
      continue;
    }
    const clash = bySegment.get(segment);
    if (clash !== undefined) {
      fail(`its config segment sandbox.${segment}. collides with backend ${clash}; rename one of them`);
      continue;
    }
    bySegment.set(segment, d.id);
    const credentials = d.credentials ?? [];
    for (const c of credentials) if (!EXT_CREDENTIAL_RE.test(c)) fail(`credential ${JSON.stringify(c)} is not a valid name`);
    if (new Set(credentials.map((c) => sandboxCredentialEnv(d.id, c))).size !== credentials.length) fail("credentials map to the same env name");
    const path = (key: string) => `${SANDBOX_NAMESPACE}.${segment}.${key}`;
    const add = (key: string, def: Record<string, unknown>, consumers: string[]) => {
      out.params.push({ ...def, path: path(key), scope: "operator", consumers } as unknown as ParamDef);
      out.backendOf.set(path(key), d.id);
    };
    for (const k of Object.keys(d.defaults ?? {})) {
      if (!d.builtin) fail(`only a built-in backend may change the standard key defaults (got ${k})`);
      else if (!standardKeys.has(k)) fail(`defaults names ${JSON.stringify(k)}, which is not a standard key (${[...standardKeys].join(", ")})`);
    }
    for (const std of STANDARD_SANDBOX_KEYS) {
      const { key, ...rest } = std;
      const override = d.builtin ? d.defaults?.[key] : undefined;
      const def: Record<string, unknown> = override !== undefined ? { ...rest, default: override } : rest;
      add(key, def, ["@pomtree/pomtreed"]);
    }
    // A declared key is flat, may not take a standard key's name or its group's, and sees only its own keys (bare) and core keys.
    const ref = (key: string, what: string, keyName: string): string => {
      if (!key.includes(".")) return path(key);
      const [root, second] = key.split(".");
      if (root === "ext" || (root === SANDBOX_NAMESPACE && second !== undefined && bySegment.has(second))) {
        fail(
          `${path(keyName)} ${what} ${JSON.stringify(key)}: name core keys by path and the backend's own keys bare; other extensions' or backends' keys are not referenceable`,
        );
      }
      return key;
    };
    for (const decl of d.params) {
      const { key, ...rest } = decl as ExtParamDecl & { ceiling?: string; relations?: readonly { op: string; key: string }[] };
      if (typeof key !== "string" || !FLAT_KEY_RE.test(key)) {
        fail(`param key ${JSON.stringify(key)} must be flat lowerCamel`);
        continue;
      }
      if (CREDENTIAL_LIKE_KEY_RE.test(key)) {
        fail(`param ${key} looks like a credential; declare it in credentials (supplied only as a mode-checked file path), not as a config key`);
        continue;
      }
      if (standardKeys.has(key) || standardGroups.has(key)) {
        fail(`param ${key} is a standard key declared for every backend; remove it from params (an adapter may change only the defaults)`);
        continue;
      }
      if (out.backendOf.has(path(key))) {
        fail(`param ${key} is declared twice`);
        continue;
      }
      const def: Record<string, unknown> = { ...rest };
      if (rest.ceiling !== undefined) def.ceiling = ref(rest.ceiling, "ceiling", key);
      if (rest.relations !== undefined) def.relations = rest.relations.map((r) => ({ op: r.op, key: ref(r.key, `relation ${r.op}`, key) }));
      add(key, def, [d.owner]);
    }
    out.backends.push({ id: d.id, owner: d.owner, builtin: d.builtin, segment, credentials });
  }
  return out;
}
