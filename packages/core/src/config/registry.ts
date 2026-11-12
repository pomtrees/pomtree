// The declaration side of the config registry: parameter definitions and `defineRegistry`, which validates a table once at
// definition time so a malformed table fails at module load, not at the first lookup. Pure: no env or fs access.
// Every parameter is restart-only: a value is read once at process start and a change takes effect on the next start.
import { isAbsolute } from "node:path";
import {
  CONFIG_ENV_PREFIXES,
  CONFIG_FILE_ENV,
  EXT_NAMESPACE,
  SANDBOX_NAMESPACE,
  camelHumps,
  deriveEnvName,
  extensionCredentialEnv,
  sandboxCredentialEnv,
  secretFileEnv,
} from "./env-name.ts";

// Integer kinds carry their unit, which the key name must also carry (`...Bytes`, `...Ms`, `...Micros`). Values are plain
// non-negative integers in that unit: no suffix parsing. `micros` is micro-dollars (1_000_000 = $1), as in budgetMicros.
export type IntegerKind = "bytes" | "count" | "ms" | "micros";
export type NumericKind = IntegerKind | "ratio";
// `json` is a structured value (an object or array) whose semantics an existing parser owns: the registry checks JSON syntax
// and delegates the rest to the key's `check`, so the parser and the registry cannot fork.
export type ParamKind = NumericKind | "bool" | "string" | "path" | "enum" | "list" | "json";

// `operator`: set by whoever starts the process. `run`: a default a run may override, up to its `ceiling`.
// TODO(config-run-scope): nothing applies per-run overrides yet; a run-scope key is resolved like an operator key and its ceiling
// is checked only against the resolved operator value.
export type ParamScope = "operator" | "run";
export type RelationOp = "lte" | "gte" | "lt" | "gt";

// `{ op: "lte", key: "b" }` on parameter a requires a <= b on the resolved values. Both sides are numeric of the same kind.
export interface ParamRelation {
  readonly op: RelationOp;
  readonly key: string;
}

interface ParamBase {
  readonly path: string; // dotted lowerCamel segments; the first is the namespace (CONFIG_ENV_PREFIXES)
  readonly doc: string;
  readonly scope: ParamScope;
  readonly consumers: readonly string[]; // packages that read the value (documentation; must be non-empty)
  readonly env?: string; // explicit env name, only for external or irregular names; otherwise derived from the path
  // Delivered to agent containers in the PTREE_CONFIG_JSON document (container.ts), and its bounds are part of the image
  // contract. Only integer and bool kinds, never sensitive or path keys: containers get no secrets and no host paths.
  readonly container?: true;
}

export interface NumericParam extends ParamBase {
  readonly kind: NumericKind;
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly ceiling?: string; // an operator key bounding this one; exceeding it is refused, never clamped
  readonly relations?: readonly ParamRelation[];
}
export interface BoolParam extends ParamBase {
  readonly kind: "bool";
  readonly default: boolean;
}
export interface StringParam extends ParamBase {
  readonly kind: "string";
  readonly default: string;
  // Masked in every description and error; settable only through `<ENV>_FILE`, never the JSON file, env or --set. Default "".
  readonly sensitive?: boolean;
  readonly check?: (value: string) => string | null; // extra validation: the reason a value is refused, or null
  // An explicit "" from any layer (file, env, --set) resolves to the default, before `check` runs; for keys whose default is a real value.
  readonly blankIsDefault?: true;
  // Extra JSON Schema keywords merged into this key's schema leaf (config.schema.json), for a shape the kind alone cannot say. Core
  // keys only; a manifest may not carry it. `sandbox.backend` uses it to list the built-in ids while accepting any provider's id.
  readonly schema?: Readonly<Record<string, unknown>>;
}
export interface PathParam extends ParamBase {
  readonly kind: "path";
  readonly default: string; // absolute, or "" for unset
}
export interface EnumParam extends ParamBase {
  readonly kind: "enum";
  readonly values: readonly string[];
  readonly default: string;
}
export interface ListParam extends ParamBase {
  readonly kind: "list";
  readonly default: readonly string[];
  readonly check?: (value: readonly string[]) => string | null;
}
export interface JsonParam extends ParamBase {
  readonly kind: "json";
  readonly default: unknown; // a JSON object or array
  readonly check?: (value: unknown) => string | null; // delegates to the parser that owns the value's semantics
}
export type ParamDef = NumericParam | BoolParam | StringParam | PathParam | EnumParam | ListParam | JsonParam;

// The value type a parameter resolves to.
export type ParamValue<P extends ParamDef> = P extends { kind: NumericKind }
  ? number
  : P extends { kind: "bool" }
    ? boolean
    : P extends { kind: "enum"; values: infer V extends readonly string[] }
      ? V[number]
      : P extends { kind: "list" }
        ? readonly string[]
        : P extends { kind: "json" }
          ? unknown
          : string;

export type ConfigValues<D extends readonly ParamDef[]> = { readonly [P in D[number] as P["path"]]: ParamValue<P> };

export interface ConfigRegistry<D extends readonly ParamDef[] = readonly ParamDef[]> {
  readonly params: D;
  readonly byPath: ReadonlyMap<string, ParamDef>;
  readonly envOf: ReadonlyMap<string, string>; // path -> env name (explicit or derived)
  readonly envNames: ReadonlySet<string>; // every owned name: each env name, plus `<ENV>_FILE` for sensitive keys
  readonly prefixes: readonly string[]; // distinct registered env prefixes
  readonly extensions: readonly RegistryExtension[]; // the extensions composed in by extendRegistry (empty for the core registry)
  readonly credentialEnv: ReadonlyMap<string, string>; // a declared credential's env name (the `_FILE` name for a sandbox backend's) -> "<owner> credential <name>"
  readonly sandboxBackends: readonly RegistrySandboxBackend[]; // the sandbox backends composed in by composeRegistry (empty for the core registry)
}

// One sandbox backend composed into a registry: the camelCase `sandbox.<segment>.` namespace its keys live under, who declared it
// (`owner`: a package name for a built-in, the extension name for a contributed one), its declared credentials and its key paths.
export interface RegistrySandboxBackend {
  readonly id: string;
  readonly owner: string;
  readonly builtin: boolean;
  readonly segment: string;
  readonly credentials: readonly string[];
  readonly paths: readonly string[];
}

// One extension composed into a registry (extendRegistry): the camelCase `ext.<segment>.` namespace it owns, its declared credentials
// and the paths of its keys.
export interface RegistryExtension {
  readonly name: string;
  readonly segment: string;
  readonly credentials: readonly string[];
  readonly paths: readonly string[];
}

// What buildRegistry needs to validate extension-contributed keys: which paths belong to which extension, and the extensions themselves.
export interface ExtensionBuild {
  readonly extOf: ReadonlyMap<string, string>; // key path -> extension name
  readonly extensions: readonly Omit<RegistryExtension, "paths">[];
  // The sandbox backends' keys (sandbox-manifest.ts): which paths belong to which backend id, and the backends themselves.
  readonly sandbox?: { readonly backendOf: ReadonlyMap<string, string>; readonly backends: readonly Omit<RegistrySandboxBackend, "paths">[] };
}

export class ConfigRegistryError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`invalid config registry: ${errors.join("; ")}`);
    this.errors = errors;
    this.name = "ConfigRegistryError";
  }
}

const NUMERIC: readonly string[] = ["bytes", "count", "ms", "micros", "ratio"];
export const isNumericParam = (p: ParamDef): p is NumericParam => NUMERIC.includes(p.kind);
export const isIntegerKind = (k: ParamKind): k is IntegerKind => k === "bytes" || k === "count" || k === "ms" || k === "micros";
export const isSensitive = (p: ParamDef): boolean => p.kind === "string" && p.sensitive === true;

// The unit hump each unit-bearing kind requires in its key's last segment, and that no other kind may use.
export const UNIT_HUMPS: Readonly<Partial<Record<ParamKind, string>>> = { bytes: "Bytes", ms: "Ms", micros: "Micros" };

const PATH_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const OP_SYMBOL: Readonly<Record<RelationOp, string>> = { lte: "<=", gte: ">=", lt: "<", gt: ">" };
export const relationSymbol = (op: RelationOp): string => OP_SYMBOL[op];
export const relationHolds = (op: RelationOp, a: number, b: number): boolean => (op === "lte" ? a <= b : op === "gte" ? a >= b : op === "lt" ? a < b : a > b);

// The env name of a validated parameter.
export const paramEnvName = (p: ParamDef, prefixes: Readonly<Record<string, string>> = CONFIG_ENV_PREFIXES): string | null =>
  p.env ?? deriveEnvName(p.path, prefixes);

// The reason `value` fails a key's `check`, or null. A check that throws is a refusal too, with its message.
export function checkReason(p: ParamDef, value: unknown): string | null {
  const check = (p as { check?: (v: unknown) => string | null }).check;
  if (check === undefined) return null;
  try {
    return check(value);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function checkHook(p: ParamDef, bad: (why: string) => void): void {
  const why = checkReason(p, p.default);
  if (why !== null) bad(`${p.path} default fails its check: ${why}`);
}

function checkDefault(p: ParamDef, bad: (why: string) => void): void {
  const d: unknown = p.default; // checked at runtime: a table built outside TypeScript may carry anything
  switch (p.kind) {
    case "bool":
      if (typeof d !== "boolean") bad(`${p.path} default must be a boolean`);
      return;
    case "string":
      if (typeof d !== "string") bad(`${p.path} default must be a string`);
      else if (p.sensitive && p.default !== "") bad(`${p.path} is sensitive, so its default must be ""`);
      else if (p.sensitive && p.check !== undefined) bad(`${p.path} is sensitive, so it takes no check (a refusal would describe the secret)`);
      else checkHook(p, bad);
      return;
    case "path":
      if (typeof p.default !== "string" || (p.default !== "" && !isAbsolute(p.default))) bad(`${p.path} default must be an absolute path or ""`);
      return;
    case "enum":
      if (p.values.length === 0 || new Set(p.values).size !== p.values.length) bad(`${p.path} enum values must be non-empty and distinct`);
      if (!p.values.includes(p.default)) bad(`${p.path} default ${JSON.stringify(p.default)} is not one of its values`);
      return;
    case "list":
      if (!Array.isArray(p.default) || p.default.some((x) => typeof x !== "string" || x === "")) bad(`${p.path} default must be a list of non-empty strings`);
      else checkHook(p, bad);
      return;
    case "json":
      if (typeof d !== "object" || d === null) bad(`${p.path} default must be a JSON object or array`);
      else checkHook(p, bad);
      return;
  }
  const int = isIntegerKind(p.kind);
  const okNum = (n: number) => (int ? Number.isSafeInteger(n) && n >= 0 : Number.isFinite(n) && n >= 0 && n <= 1);
  const what = int ? "a non-negative integer" : "a number in 0..1";
  for (const [name, n] of [
    ["default", p.default],
    ["min", p.min],
    ["max", p.max],
  ] as const) {
    if (n !== undefined && !okNum(n)) bad(`${p.path} ${name} must be ${what}`);
  }
  if (p.min !== undefined && p.max !== undefined && p.min > p.max) bad(`${p.path} min ${p.min} exceeds max ${p.max}`);
  if (p.min !== undefined && p.default < p.min) bad(`${p.path} default ${p.default} is below its minimum ${p.min}`);
  if (p.max !== undefined && p.default > p.max) bad(`${p.path} default ${p.default} is above its maximum ${p.max}`);
}

// The `a op b` edges of a numeric parameter: its ceiling as `lte`, then its relations.
export const paramEdges = (p: NumericParam): ParamRelation[] => [
  ...(p.ceiling === undefined ? [] : [{ op: "lte" as const, key: p.ceiling }]),
  ...(p.relations ?? []),
];

// Validates the table and indexes it. Throws ConfigRegistryError listing every problem found. Built-in keys only: the `ext.`
// namespace is filled by extendRegistry (extend.ts), never by a literal table.
export function defineRegistry<const D extends readonly ParamDef[]>(
  params: D,
  prefixTable: Readonly<Record<string, string>> = CONFIG_ENV_PREFIXES,
): ConfigRegistry<D> {
  return buildRegistry(params, prefixTable) as ConfigRegistry<D>;
}

const EXT_PATH_RE = /^ext\.[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
// `sandbox.<segment>.<key>` or `sandbox.<segment>.<group>.<key>` (the standard rate group).
const SANDBOX_BACKEND_PATH_RE = /^sandbox\.[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)?$/;

// The shared validator behind defineRegistry and extendRegistry; call those. With `ext`, the params under `ext.` are the
// extensions' keys and are validated as such (flat `ext.<segment>.<key>`, relations only to core keys or the same extension's
// keys), and every error about one names its extension.
export function buildRegistry(params: readonly ParamDef[], prefixTable: Readonly<Record<string, string>>, ext?: ExtensionBuild): ConfigRegistry {
  const errors: string[] = [];
  const bad = (why: string) => void errors.push(why);
  const extOf = ext?.extOf ?? new Map<string, string>();
  const segmentOf = new Map((ext?.extensions ?? []).map((e) => [e.name, e.segment]));
  const backendOf = ext?.sandbox?.backendOf ?? new Map<string, string>();
  const backendInfo = new Map((ext?.sandbox?.backends ?? []).map((b) => [b.id, b]));
  // The owner of a key: an extension or a sandbox backend (distinct namespaces, so the same name in both never compares equal).
  const ownerOfPath = (path: string): string | undefined =>
    extOf.has(path) ? `extension ${extOf.get(path)}` : backendOf.has(path) ? `sandbox backend ${backendOf.get(path)}` : undefined;
  // An error about an extension's or backend's key names it; a core key's stays bare.
  const badFor = (p: ParamDef) => {
    const owner = ownerOfPath(p.path);
    return owner === undefined ? bad : (why: string) => bad(`${owner}: ${why}`);
  };
  const labelOf = (p: ParamDef) => (ownerOfPath(p.path) === undefined ? p.path : `${p.path} (${ownerOfPath(p.path)})`);
  const byPath = new Map<string, ParamDef>();
  for (const p of params) {
    if (p.path.split(".")[0] === EXT_NAMESPACE) {
      if (!extOf.has(p.path)) bad(`${p.path} is under ${EXT_NAMESPACE}., which only extendRegistry fills with extension-contributed keys`);
      else if (!EXT_PATH_RE.test(p.path) || p.path.split(".")[1] !== segmentOf.get(extOf.get(p.path) as string))
        badFor(p)(`${p.path} must be ext.${segmentOf.get(extOf.get(p.path) as string)}.<key> with a flat lowerCamel key`);
      else if (!Object.hasOwn(prefixTable, EXT_NAMESPACE)) badFor(p)(`${p.path} is in a namespace with no env prefix`);
    } else if (backendOf.has(p.path)) {
      const info = backendInfo.get(backendOf.get(p.path) as string);
      if (!SANDBOX_BACKEND_PATH_RE.test(p.path) || p.path.split(".")[1] !== info?.segment)
        badFor(p)(`${p.path} must be ${SANDBOX_NAMESPACE}.${info?.segment}.<key> (or .<group>.<key>) with lowerCamel segments`);
    } else if (!PATH_RE.test(p.path)) bad(`invalid path ${JSON.stringify(p.path)}: expected dotted lowerCamel segments, at least two`);
    else if (!Object.hasOwn(prefixTable, p.path.split(".")[0] as string)) bad(`${p.path} is in a namespace with no env prefix`);
    if (byPath.has(p.path)) bad(`duplicate path ${p.path}`);
    else byPath.set(p.path, p);
  }
  const paths = [...byPath.keys()];
  for (const p of byPath.values()) {
    const bad = badFor(p); // shadows the outer: an extension key's errors name its extension
    const parent = paths.find((q) => p.path.startsWith(`${q}.`));
    if (parent !== undefined) bad(`${p.path} nests under the parameter ${parent}`);
    if (p.doc.trim() === "") bad(`${p.path} has no doc`);
    if (p.consumers.length === 0) bad(`${p.path} declares no consumers`);
    if (p.env !== undefined && !ENV_RE.test(p.env)) bad(`${p.path} env ${JSON.stringify(p.env)} is not an UPPER_SNAKE name`);
    if (p.kind === "string" && p.sensitive && p.scope !== "operator") bad(`${p.path} is sensitive, so its scope must be operator`);
    const container: unknown = p.container;
    if (container !== undefined) {
      if (container !== true) bad(`${p.path} container must be true or omitted`);
      else if (isSensitive(p)) bad(`${p.path} is sensitive, so it may not be delivered to containers`);
      else if (p.kind === "path") bad(`${p.path} is a host path, so it may not be delivered to containers`);
      else if (!isIntegerKind(p.kind) && p.kind !== "bool") bad(`${p.path} is kind ${p.kind}; only integer kinds and bool may be delivered to containers`);
    }
    const humps = camelHumps(p.path.slice(p.path.lastIndexOf(".") + 1));
    for (const [kind, hump] of Object.entries(UNIT_HUMPS)) {
      const named = humps.includes(hump as string);
      if (p.kind === kind && !named) bad(`${p.path} is kind ${kind} but its name lacks the ${hump} unit`);
      if (p.kind !== kind && named) bad(`${p.path} names the ${hump} unit but is kind ${p.kind}`);
    }
    checkDefault(p, bad);
    if ((p as { check?: unknown }).check !== undefined && p.kind !== "string" && p.kind !== "list" && p.kind !== "json")
      bad(`${p.path} is kind ${p.kind}; only string, list and json kinds take a check`);
    if (!isNumericParam(p)) {
      const q = p as unknown as Partial<NumericParam>;
      if (q.min !== undefined || q.max !== undefined || q.ceiling !== undefined || q.relations !== undefined)
        bad(`${p.path} is kind ${p.kind}; only numeric kinds take min, max, ceiling or relations`);
      continue;
    }
    if (p.ceiling !== undefined) {
      const c = byPath.get(p.ceiling);
      if (c !== undefined && c.scope !== "operator") bad(`${p.path} ceiling ${p.ceiling} must be an operator key`);
    }
    const owned = ownerOfPath(p.path);
    for (const r of paramEdges(p)) {
      const t = byPath.get(r.key);
      const targetOwner = ownerOfPath(r.key);
      // Core resolves without extensions, so it may never depend on an extension's key; an extension may relate to core keys and
      // its own, never to another extension's (they load independently).
      if (owned === undefined && (targetOwner !== undefined || r.key.split(".")[0] === EXT_NAMESPACE))
        bad(`${p.path} ${r.op} ${r.key}: core keys may not reference ${targetOwner?.startsWith("sandbox backend") ? "sandbox backend" : "extension"} keys`);
      else if (owned !== undefined && targetOwner !== undefined && targetOwner !== owned)
        bad(
          `${p.path} ${r.op} ${r.key}: relates to a key of ${targetOwner}; ${owned.startsWith("sandbox backend") ? "backends" : "extensions"} may relate only to core keys and their own`,
        );
      else if (t === undefined) bad(`${p.path} ${r.key === p.ceiling ? "ceiling" : `relation ${r.op}`} names unknown key ${r.key}`);
      else if (!isNumericParam(t) || t.kind !== p.kind) bad(`${p.path} ${r.op} ${r.key} compares ${p.kind} with ${t.kind}`);
      else if (!relationHolds(r.op, p.default, t.default))
        bad(`${p.path} default ${p.default} violates ${p.path} ${relationSymbol(r.op)} ${r.key} (default ${t.default})`);
    }
  }
  // Cycles over ceiling and relation edges (a self-edge is a cycle of one).
  const state = new Map<string, "open" | "done">();
  const reported = new Set<string>();
  const visit = (path: string, stack: string[]): void => {
    if (state.get(path) === "done") return;
    if (state.get(path) === "open") {
      const cycle = [...stack.slice(stack.indexOf(path)), path];
      const key = [...cycle.slice(0, -1)].sort().join(",");
      if (!reported.has(key)) bad(`relation cycle: ${cycle.join(" -> ")}`);
      reported.add(key);
      return;
    }
    state.set(path, "open");
    const p = byPath.get(path);
    if (p !== undefined && isNumericParam(p)) for (const r of paramEdges(p)) if (byPath.has(r.key)) visit(r.key, [...stack, path]);
    state.set(path, "done");
  };
  for (const path of paths) visit(path, []);
  // Env names: one owner each, including the `_FILE` names of sensitive keys and the reserved config-file name.
  const envOf = new Map<string, string>();
  const owner = new Map<string, string>([[CONFIG_FILE_ENV, `the config file (${CONFIG_FILE_ENV})`]]);
  const claim = (name: string, by: string) => {
    const prior = owner.get(name);
    if (prior !== undefined)
      bad(
        `env name ${name} is claimed by both ${prior} and ${by}${
          prior.includes("sandbox backend") || by.includes("sandbox backend")
            ? "; two names derive to the same env variable, so rename the credential, the key or the backend id"
            : ""
        }`,
      );
    else owner.set(name, by);
  };
  for (const p of byPath.values()) {
    const name = paramEnvName(p, prefixTable);
    if (name === null) continue;
    envOf.set(p.path, name);
    claim(name, labelOf(p));
    if (isSensitive(p)) claim(secretFileEnv(name), `${labelOf(p)} (secret file)`);
  }
  // A declared extension credential owns its env name too, so a key can never shadow it (and the resolver recognizes it).
  const credentialEnv = new Map<string, string>();
  // A sandbox backend's credential is supplied only as a path, in `<POMTREED_SANDBOX_<ID>_<CRED>>_FILE`; that name is owned (so the
  // resolver recognizes it) and the bare name is not (a value in the environment is refused as an unknown name).
  for (const b of ext?.sandbox?.backends ?? []) {
    for (const c of b.credentials) {
      const name = secretFileEnv(sandboxCredentialEnv(b.id, c));
      credentialEnv.set(name, `sandbox backend ${b.id} credential ${c}`);
      claim(name, `sandbox backend ${b.id} credential ${c}`);
    }
  }
  for (const e of ext?.extensions ?? []) {
    for (const c of e.credentials) {
      const name = extensionCredentialEnv(e.name, c);
      credentialEnv.set(name, `extension ${e.name} credential ${c}`);
      claim(name, `extension ${e.name} credential ${c}`);
    }
  }
  if (errors.length > 0) throw new ConfigRegistryError(errors);
  const prefixes = [...new Set(Object.values(prefixTable))];
  owner.delete(CONFIG_FILE_ENV);
  const extensions = (ext?.extensions ?? []).map((e) => ({ ...e, paths: params.filter((p) => extOf.get(p.path) === e.name).map((p) => p.path) }));
  const sandboxBackends = (ext?.sandbox?.backends ?? []).map((b) => ({
    ...b,
    paths: params.filter((p) => backendOf.get(p.path) === b.id).map((p) => p.path),
  }));
  return { params, byPath, envOf, envNames: new Set(owner.keys()), prefixes, extensions, credentialEnv, sandboxBackends };
}
