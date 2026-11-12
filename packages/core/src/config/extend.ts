// Extension-contributed config: an extension declares its keys statically in its manifest (`params`, the JSON-expressible subset of
// ParamDef), and `extendRegistry` composes the core registry with every loaded extension's keys under `ext.<segment>.<key>`, validated
// by the same checks as the core table. Pure: no env or fs access. Core never imports or names an extension key; it resolves
// without extensions, and the composed registry is a superset resolved in one pass (uniform origins, ceilings and relations).
import { CONFIG_ENV_PREFIXES, EXT_NAMESPACE, extensionCredentialEnv, extensionSegment } from "./env-name.ts";
import type { SandboxBackendConfigDecl } from "./sandbox-manifest.ts";
import { composeSandboxKeys, sandboxBackendClosedCheck } from "./sandbox-manifest.ts";
import type { BoolParam, ConfigRegistry, EnumParam, ListParam, NumericParam, ParamDef, ParamRelation, StringParam } from "./registry.ts";
import { buildRegistry, ConfigRegistryError } from "./registry.ts";

// A manifest declaration: a ParamDef without what the loader fills in (`path`, `scope`, `consumers`) or what an extension may not
// have in v1 (`env`, `container`, `sensitive`, `check`: functions and secrets are not JSON, and extension keys are host-side only).
// `key` is flat lowerCamel under the extension's segment. `ceiling` and relation `key`s name the extension's own keys bare
// (`textMaxBytes`) and core keys by path (`report.maxBytes`).
type Decl<P extends ParamDef> = P extends unknown
  ? Omit<P, "path" | "scope" | "consumers" | "env" | "container" | "check" | "sensitive" | "schema"> & { readonly key: string }
  : never;
export type ExtParamDecl = Decl<NumericParam | BoolParam | EnumParam | StringParam | ListParam>;

export interface ExtensionConfigDecl {
  readonly name: string; // the manifest name
  readonly params: readonly ExtParamDecl[];
  readonly credentials?: readonly string[]; // declared manifest credentials; their env names are owned, so no key may collide
}

const NUMERIC_KINDS: readonly string[] = ["bytes", "count", "ms", "micros", "ratio"];
const KINDS: readonly string[] = [...NUMERIC_KINDS, "bool", "enum", "string", "list"];
const COMMON = ["key", "kind", "doc", "default"];
const FIELDS: Readonly<Record<string, readonly string[]>> = { numeric: [...COMMON, "min", "max", "ceiling", "relations"], enum: [...COMMON, "values"] };
// Fields that exist on ParamDef but are not declarable in a manifest, each with the reason (a clearer message than "unknown field").
const FORBIDDEN: Readonly<Record<string, string>> = {
  path: "the loader derives the path from the extension name and key",
  scope: "extension keys are operator-scoped",
  consumers: "the loader sets the extension as the only consumer",
  env: "the env name is derived (POMTREED_EXT_<NAME>_<KEY>)",
  container: "extension keys are host-side only and never delivered to containers",
  sensitive: "secrets go through manifest credentials, not config keys",
  check: "a manifest is JSON and carries no functions",
  schema: "schema fragments are for core keys only",
};
export const EXT_CREDENTIAL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Validates a manifest's raw `params` array against the declarable subset. Shape only (types and allowed fields); defaults, ranges and
// relations are checked by extendRegistry against the whole table. Every problem is returned, each naming the extension and key.
export function parseExtensionParams(extension: string, raw: unknown): { ok: true; params: ExtParamDecl[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, errors: [`extension ${extension}: params must be an array`] };
  raw.forEach((item, i) => {
    const bad = (why: string) =>
      void errors.push(`extension ${extension}: params[${i}]${isPlain(item) && typeof item.key === "string" ? ` (${item.key})` : ""}: ${why}`);
    if (!isPlain(item)) {
      bad("must be an object");
      return;
    }
    if (typeof item.key !== "string" || item.key === "") bad("key must be a non-empty string");
    if (typeof item.kind !== "string" || !KINDS.includes(item.kind)) {
      bad(
        `kind must be one of ${KINDS.join(", ")}${item.kind === "path" || item.kind === "json" ? " (path and json keys are not supported in manifests)" : ""}`,
      );
      return;
    }
    if (typeof item.doc !== "string") bad("doc must be a string");
    if (item.default === undefined) bad("default is required");
    const allowed = FIELDS[NUMERIC_KINDS.includes(item.kind) ? "numeric" : item.kind] ?? COMMON;
    for (const field of Object.keys(item)) {
      if (allowed.includes(field)) continue;
      const why = FORBIDDEN[field];
      bad(why !== undefined ? `${field} is not allowed in a manifest: ${why}` : `unknown field ${JSON.stringify(field)} for kind ${item.kind}`);
    }
    if (item.kind === "enum" && (!Array.isArray(item.values) || item.values.some((x) => typeof x !== "string"))) bad("values must be an array of strings");
    if (NUMERIC_KINDS.includes(item.kind)) {
      for (const f of ["min", "max"] as const) if (item[f] !== undefined && typeof item[f] !== "number") bad(`${f} must be a number`);
      if (item.ceiling !== undefined && typeof item.ceiling !== "string") bad("ceiling must be a key name");
      if (item.relations !== undefined) {
        const okRel = (r: unknown) =>
          isPlain(r) && ["lte", "gte", "lt", "gt"].includes(r.op as string) && typeof r.key === "string" && Object.keys(r).length === 2;
        if (!Array.isArray(item.relations) || !item.relations.every(okRel))
          bad('relations must be an array of {"op": "lte"|"gte"|"lt"|"gt", "key": <key name>}');
      }
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, params: raw as ExtParamDecl[] };
}

// A reference in a declaration to the extension's own key (bare) or a core key (dotted path); another extension's key is refused.
function resolveRef(ref: string, segment: string): string | null {
  if (!ref.includes(".")) return `${EXT_NAMESPACE}.${segment}.${ref}`;
  return ref.split(".")[0] === EXT_NAMESPACE ? null : ref;
}

// The core registry plus every extension's keys, validated as one table. Throws ConfigRegistryError listing every problem; each
// names its extension. `core` must be an unextended registry (extend once, with all extensions).
export function extendRegistry(
  core: ConfigRegistry,
  extensions: readonly ExtensionConfigDecl[],
  prefixTable: Readonly<Record<string, string>> = CONFIG_ENV_PREFIXES,
): ConfigRegistry {
  return composeRegistry(core, { extensions }, prefixTable);
}

export interface RegistryComposition {
  readonly extensions?: readonly ExtensionConfigDecl[];
  // Every sandbox backend to compose under `sandbox.<id>.*`: the built-ins' shipped manifests and the extensions' `provides` entries.
  readonly sandboxBackends?: readonly SandboxBackendConfigDecl[];
}

// The core registry plus every extension's keys (`ext.<segment>.*`) and every sandbox backend's keys (`sandbox.<id>.*`), validated as
// one table; extendRegistry is the extensions-only case. Composing also closes `sandbox.backend` to `auto`, the built-in ids and the
// composed backends' ids. Throws ConfigRegistryError listing every problem; each names its extension or backend.
export function composeRegistry(
  core: ConfigRegistry,
  { extensions = [], sandboxBackends = [] }: RegistryComposition,
  prefixTable: Readonly<Record<string, string>> = CONFIG_ENV_PREFIXES,
): ConfigRegistry {
  if (core.extensions.length > 0) throw new ConfigRegistryError(["the registry is already extended; compose all extensions in one extendRegistry call"]);
  if (core.sandboxBackends.length > 0)
    throw new ConfigRegistryError(["the registry already has sandbox backends; compose all backends in one composeRegistry call"]);
  const errors: string[] = [];
  const extOf = new Map<string, string>();
  const params: ParamDef[] = [];
  const bySegment = new Map<string, string>();
  const names = new Set<string>();
  const composed: { name: string; segment: string; credentials: readonly string[] }[] = [];
  for (const e of extensions) {
    const bad = (why: string) => void errors.push(`extension ${e.name}: ${why}`);
    if (names.has(e.name)) {
      bad("declared twice (two extension directories carry this manifest name)");
      continue;
    }
    names.add(e.name);
    // An extension that declares neither params nor credentials owns no config: its name needs no segment and may share one.
    if (e.params.length === 0 && (e.credentials ?? []).length === 0) continue;
    const segment = extensionSegment(e.name);
    if (segment === null) {
      bad(`name has no config segment (it must start with a lowercase letter to own ${EXT_NAMESPACE}.<name>. keys)`);
      continue;
    }
    const clash = bySegment.get(segment);
    if (clash !== undefined) {
      bad(`config segment ${EXT_NAMESPACE}.${segment}. collides with extension ${clash}; rename one of them`);
      continue;
    }
    bySegment.set(segment, e.name);
    const credentials = e.credentials ?? [];
    for (const c of credentials) if (!EXT_CREDENTIAL_RE.test(c)) bad(`credential ${JSON.stringify(c)} is not a valid name`);
    if (new Set(credentials.map((c) => extensionCredentialEnv(e.name, c))).size !== credentials.length) bad("credentials map to the same env name");
    composed.push({ name: e.name, segment, credentials });
    for (const d of e.params) {
      const path = `${EXT_NAMESPACE}.${segment}.${d.key}`;
      const ref = (key: string, what: string): string => {
        const r = resolveRef(key, segment);
        if (r === null)
          bad(
            `${path} ${what} ${JSON.stringify(key)}: name core keys by path and the extension's own keys bare; extension keys of other extensions are not referenceable`,
          );
        return r ?? key;
      };
      const { key: _key, ...rest } = d as ExtParamDecl & { ceiling?: string; relations?: readonly ParamRelation[] };
      const def: Record<string, unknown> = { ...rest, path, scope: "operator", consumers: [e.name] };
      if (rest.ceiling !== undefined) def.ceiling = ref(rest.ceiling, "ceiling");
      if (rest.relations !== undefined) def.relations = rest.relations.map((r) => ({ op: r.op, key: ref(r.key, `relation ${r.op}`) }));
      extOf.set(path, e.name);
      params.push(def as unknown as ParamDef);
    }
  }
  const sandbox = composeSandboxKeys(core.byPath.keys(), sandboxBackends, (why) => void errors.push(why));
  const closeBackend = sandboxBackendClosedCheck(sandbox.backends);
  const coreParams = core.params.map((p) => (p.path === "sandbox.backend" ? ({ ...p, check: closeBackend } as ParamDef) : p));
  let registry: ConfigRegistry | undefined;
  try {
    registry = buildRegistry([...coreParams, ...params, ...sandbox.params], prefixTable, {
      extOf,
      extensions: composed,
      sandbox: { backendOf: sandbox.backendOf, backends: sandbox.backends },
    });
  } catch (e) {
    if (!(e instanceof ConfigRegistryError)) throw e;
    errors.push(...e.errors);
  }
  if (errors.length > 0 || registry === undefined) throw new ConfigRegistryError(errors);
  return registry;
}
