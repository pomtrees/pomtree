import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { EXTENSION_API_VERSION, EXT_CREDENTIAL_RE, parseExtensionParams } from "@pomtree/core";
import type { ExtensionCapabilities, ExtensionConfigDecl, ExtensionDepName, ExtensionManifest } from "@pomtree/core";

// Extension names are token-safe, since they appear in `ext.<name>.<hmac>` tokens: no `.` (token separator), `/`, `..`, whitespace or control
// characters, and they must start with a lowercase letter or digit. Mirrors auth.ts's EXT_NAME_RE.
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Names whose `ext.<name>.*` journal kinds the daemon itself writes and trusts: `pomtreed` (daemon bookkeeping, core/kinds.ts) and
// `egress` (audit rows and quarantine markers the egress collector rebuilds cursors from). No extension may claim them. Kinds embed
// the whole name between dots, so only an exact match can forge them; `pomtreed-x` is a different, harmless name.
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["pomtreed", "egress"]);

// The dependencies an extension manifest may declare. `store` is accepted syntactically but rejected
// in load (TODO(extensions)) because the host does not provide an extension store yet.
const KNOWN_DEPS: readonly ExtensionDepName[] = ["registry", "journal", "record", "deliver", "authorize", "credentials", "store"];

// A manifest whose `params` declaration is invalid. Unlike every other manifest fault (which only fails that one extension's load),
// this is a startup configuration error: the declaration is what the operator's config is validated against.
export class ManifestParamsError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(errors.join("; "));
    this.errors = errors;
    this.name = "ManifestParamsError";
  }
}

// Throws unless `value` is exactly EXTENSION_API_VERSION. `undefined` is "missing" (a manifest that predates the field).
export function assertExtensionApiVersion(name: string, value: unknown): void {
  if (value === EXTENSION_API_VERSION) return;
  const want = `this host speaks extension API ${EXTENSION_API_VERSION}`;
  if (value === undefined) throw new Error(`extension ${name}: manifest.json has no "apiVersion"; ${want}`);
  throw new Error(`extension ${name}: manifest apiVersion ${JSON.stringify(value)} is not supported; ${want}`);
}

const CAPABILITY_KEYS = ["routes", "verbs", "journalKinds", "hooks"] as const;
const HOOK_KEYS = ["journal", "spawn"] as const;

// `capabilities` is required and strict: an object of booleans over the closed key set, `hooks` an object of booleans over its own.
// `{}` is valid (declares nothing); undefined is "missing" and refuses the extension, naming the field.
export function parseCapabilities(name: string, v: unknown): ExtensionCapabilities {
  if (v === undefined) throw new Error(`extension ${name}: manifest has no "capabilities" block (required; {} declares none)`);
  const bad = (why: string) => new Error(`extension ${name}: manifest "capabilities" ${why}`);
  const closed = (o: unknown, keys: readonly string[], where: string): Record<string, unknown> => {
    if (typeof o !== "object" || o === null || Array.isArray(o)) throw bad(`${where} must be an object`);
    for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`${where} has unknown key ${JSON.stringify(k)} (allowed: ${keys.join(", ")})`);
    return o as Record<string, unknown>;
  };
  const o = closed(v, CAPABILITY_KEYS, "block");
  const out: ExtensionCapabilities = {};
  for (const k of ["routes", "verbs", "journalKinds"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") throw bad(`${k} must be a boolean`);
    out[k] = o[k] as boolean;
  }
  if (o.hooks !== undefined) {
    const h = closed(o.hooks, HOOK_KEYS, "hooks");
    const hooks: NonNullable<ExtensionCapabilities["hooks"]> = {};
    for (const k of HOOK_KEYS) {
      if (h[k] === undefined) continue;
      if (typeof h[k] !== "boolean") throw bad(`hooks.${k} must be a boolean`);
      hooks[k] = h[k] as boolean;
    }
    out.hooks = hooks;
  }
  return out;
}

// `deps` is required: an array of distinct known dep names. `[]` is valid (declares none); undefined refuses the extension.
export function parseDeps(name: string, v: unknown): ExtensionDepName[] {
  if (v === undefined) throw new Error(`extension ${name}: manifest has no "deps" block (required; [] declares none)`);
  if (!Array.isArray(v) || v.some((d) => typeof d !== "string")) throw new Error(`extension ${name}: deps must be an array of strings`);
  for (const d of v as string[]) {
    if (!(KNOWN_DEPS as readonly string[]).includes(d)) throw new Error(`extension ${name}: unknown dep ${JSON.stringify(d)}`);
  }
  if (new Set(v).size !== v.length) throw new Error(`extension ${name}: deps must be distinct`);
  return v as ExtensionDepName[];
}

// Reads manifest.json without executing any extension code. `params` is validated here (shape only; the registry composition
// checks values and relations), `credentials` must be names that are safe in an env name and a file name.
export function parseManifest(raw: string): ExtensionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("manifest.json must be a JSON object");
  const o = parsed as Record<string, unknown>;
  if (typeof o.name !== "string" || !NAME_RE.test(o.name)) {
    throw new Error(`invalid extension name ${JSON.stringify(o.name)}: must match ${NAME_RE}`);
  }
  if (RESERVED_NAMES.has(o.name)) throw new Error(`extension name ${JSON.stringify(o.name)} is reserved for the daemon`);
  // The extension contract version is mandatory and exact: a missing or different value is a load failure naming the extension.
  assertExtensionApiVersion(o.name, o.apiVersion);
  if (typeof o.entry !== "string" || o.entry === "") throw new Error(`extension ${o.name}: entry must be a non-empty string`);
  // Only the keyed state store is admitted (the extension owns the state owner named after it); the other stores stay unsupported.
  if (
    o.store !== undefined &&
    !(typeof o.store === "object" && o.store !== null && (o.store as { name?: unknown }).name === "state" && Object.keys(o.store).length === 1)
  )
    throw new Error(`extension ${o.name}: only store {"name":"state"} is supported (TODO(extensions))`);
  // Both blocks are mandatory (flag day, as apiVersion): undeclared means denied, and a missing block refuses the extension.
  const capabilities = parseCapabilities(o.name, o.capabilities);
  const deps = parseDeps(o.name, o.deps);
  if (o.credentials !== undefined) {
    if (!Array.isArray(o.credentials) || o.credentials.some((c) => typeof c !== "string" || !EXT_CREDENTIAL_RE.test(c)))
      throw new Error(`extension ${o.name}: credentials must be an array of names matching ${EXT_CREDENTIAL_RE}`);
    if (new Set(o.credentials).size !== o.credentials.length) throw new Error(`extension ${o.name}: credentials must be distinct`);
  }
  let params: ExtensionManifest["params"];
  if (o.params !== undefined) {
    const r = parseExtensionParams(o.name, o.params);
    if (!r.ok) throw new ManifestParamsError(r.errors);
    params = r.params;
  }
  return {
    apiVersion: EXTENSION_API_VERSION,
    name: o.name,
    entry: o.entry,
    ...(o.store !== undefined && { store: { name: "state" as const } }),
    capabilities,
    deps,
    ...(o.credentials !== undefined && { credentials: o.credentials as string[] }),
    ...(params !== undefined && { params }),
    ...(o.remote !== undefined && { remote: Boolean(o.remote) }),
  };
}

export interface ManifestScan {
  extensions: ExtensionConfigDecl[]; // every extension subdirectory whose manifest parsed, with its params and credentials
  errors: string[]; // invalid `params` declarations (config errors); other manifest faults only fail that extension's load
  unloaded?: string[]; // those other faults, one line per manifest (`<dir>: <why>`), so a config name that finds no owner can say why
}

// The boot-time scan behind config resolution: reads each `<dir>/<sub>/manifest.json` as JSON, executes nothing. A missing dir is
// no extensions. A manifest that is unreadable or invalid for any reason other than `params` contributes nothing here (the load
// later reports it as a failed extension) and is listed in `unloaded`; a subdirectory without a manifest.json is not an extension.
export function scanExtensionManifests(dir: string): ManifestScan {
  const out: ManifestScan & { unloaded: string[] } = { extensions: [], errors: [], unloaded: [] };
  let root: string;
  let subs: string[];
  try {
    root = realpathSync(dir);
    subs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") out.errors.push(`extensions dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  for (const sub of subs) {
    try {
      const m = parseManifest(readFileSync(join(realpathSync(join(root, sub)), "manifest.json"), "utf8"));
      out.extensions.push({ name: m.name, params: m.params ?? [], credentials: m.credentials ?? [] });
    } catch (e) {
      if (e instanceof ManifestParamsError) out.errors.push(...e.errors);
      else if ((e as NodeJS.ErrnoException).code !== "ENOENT") out.unloaded.push(`${sub}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
