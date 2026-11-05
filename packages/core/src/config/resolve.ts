// Resolves a registry against its sources: default < JSON file ($POMTREED_CONFIG) < env < `--set key=value`. Pure: the caller
// injects the parsed file, the env and a file reader for `<ENV>_FILE` secrets. Fails closed: every error is collected and no
// values are returned when there is any. A sensitive value never appears in an error, an origin or a description.
import { isAbsolute } from "node:path";
import { CONFIG_FILE_ENV, EXT_ENV_PREFIX, EXT_NAMESPACE, didYouMean, extensionCredentialEnv, extensionEnvPrefix, secretFileEnv } from "./env-name.ts";
import type { ConfigRegistry, ConfigValues, ParamDef, ParamKind, ParamScope } from "./registry.ts";
import { checkReason, isIntegerKind, isNumericParam, isSensitive, paramEdges, relationHolds, relationSymbol } from "./registry.ts";

export type ConfigOrigin = "default" | "file" | "set" | `env:${string}` | `file-secret:${string}`;
export type ConfigPathOf<D extends readonly ParamDef[]> = D[number]["path"];

export interface ResolveInput {
  file?: unknown; // the parsed JSON config file, if any
  env: Readonly<Record<string, string | undefined>>;
  set?: readonly string[]; // repeatable `--set key=value`
  readFile?: (path: string) => string; // reads a `<ENV>_FILE` secret
  // The permission bits of a `<ENV>_FILE` secret; a file with any group/other bit is refused. Absent where the platform has no
  // POSIX modes (no check then). A throwing reader is reported like a failed read.
  fileMode?: (path: string) => number;
  // `<ENV>_FILE` names are recognized (never refused as unknown) but not read, and the sensitive keys keep their "" default: for
  // a process that shares the operator's env but must never open their secrets (the digest host).
  skipSecretFiles?: boolean;
  // Skips the unknown-name refusals: for the first of two passes over one env (pomtreed resolves the core keys to find
  // the extensions, then everything once more with the extensions' keys composed in, and the second pass reports).
  skipUnknownEnv?: boolean;
  ignoreEnv?: readonly string[]; // names under a registered prefix owned elsewhere (POMTREE_TOKEN, runtime-injected agent vars)
  ignoreEnvPrefixes?: readonly string[]; // name families owned elsewhere; see CONFIG_ENV_EXCLUSIONS
}

export interface ResolvedConfig<D extends readonly ParamDef[]> {
  ok: true;
  values: ConfigValues<D>;
  origins: Readonly<Record<ConfigPathOf<D>, ConfigOrigin>>;
}
export type ResolveResult<D extends readonly ParamDef[]> = ResolvedConfig<D> | { ok: false; errors: string[] };

export const REDACTED = "<redacted>";
const INT_RE = /^(0|[1-9][0-9]*)$/;
const RATIO_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const UNIT: Readonly<Partial<Record<ParamKind, string>>> = { bytes: " of bytes", ms: " of milliseconds", micros: " of micro-dollars" };
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Parsed = { ok: true; value: unknown } | { ok: false; why: string };

// A value from text (env or --set): strict, no trimming, no exponents, signs, fractions or leading zeros for integers.
function fromText(p: ParamDef, raw: string): Parsed {
  if (isIntegerKind(p.kind)) {
    const n = Number(raw);
    return INT_RE.test(raw) && Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: false, why: `expected a non-negative integer${UNIT[p.kind] ?? ""}` };
  }
  switch (p.kind) {
    case "ratio":
      return RATIO_RE.test(raw) ? { ok: true, value: Number(raw) } : { ok: false, why: "expected a decimal number in 0..1" };
    case "bool":
      return raw === "true" || raw === "1"
        ? { ok: true, value: true }
        : raw === "false" || raw === "0"
          ? { ok: true, value: false }
          : { ok: false, why: "expected true, false, 1 or 0" };
    case "list":
      return raw === "" ? { ok: true, value: [] } : fromJson(p, raw.split(","));
    case "json": {
      let v: unknown;
      try {
        v = JSON.parse(raw);
      } catch {
        return { ok: false, why: "expected JSON" };
      }
      return fromJson(p, v);
    }
    default:
      return fromJson(p, raw);
  }
}

// A value from the JSON file (and the shared checks for text values once split).
function fromJson(p: ParamDef, v: unknown): Parsed {
  if (isIntegerKind(p.kind)) {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
      ? { ok: true, value: v }
      : { ok: false, why: `expected a non-negative integer${UNIT[p.kind] ?? ""}` };
  }
  switch (p.kind) {
    case "ratio":
      return typeof v === "number" && Number.isFinite(v) ? { ok: true, value: v } : { ok: false, why: "expected a number in 0..1" };
    case "bool":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, why: "expected a boolean" };
    case "string":
      return typeof v === "string" ? { ok: true, value: v } : { ok: false, why: "expected a string" };
    case "path":
      // "" is accepted only for a key whose default is "" (unset: the consumer derives the path).
      return typeof v === "string" && ((v === "" && p.default === "") || isAbsolute(v)) && !v.includes("\0")
        ? { ok: true, value: v }
        : { ok: false, why: "expected an absolute path" };
    case "enum":
      return typeof v === "string" && p.values.includes(v) ? { ok: true, value: v } : { ok: false, why: `expected one of ${p.values.join(", ")}` };
    case "list":
      return Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "")
        ? { ok: true, value: [...v] }
        : { ok: false, why: "expected a list of non-empty strings" };
    case "json":
      return typeof v === "object" && v !== null ? { ok: true, value: v } : { ok: false, why: "expected a JSON object or array" };
  }
  return { ok: false, why: `unsupported kind ${p.kind}` };
}

// Range checks shared by every source.
function inRange(p: ParamDef, value: unknown): string | null {
  if (!isNumericParam(p)) return null;
  const n = value as number;
  if (p.kind === "ratio" && (n < 0 || n > 1)) return "expected a number in 0..1";
  if (p.min !== undefined && n < p.min) return `is below its minimum ${p.min}`;
  if (p.max !== undefined && n > p.max) return `is above its maximum ${p.max}`;
  return null;
}

const show = (v: unknown): string => (typeof v === "string" || (typeof v === "object" && v !== null) ? JSON.stringify(v) : String(v));

export function resolveConfig<D extends readonly ParamDef[]>(registry: ConfigRegistry<D>, input: ResolveInput): ResolveResult<D> {
  const errors: string[] = [];
  const values = new Map<string, unknown>();
  const origins = new Map<string, ConfigOrigin>();
  const failed = new Set<string>();
  for (const p of registry.params) {
    values.set(p.path, p.default);
    origins.set(p.path, "default");
  }
  const paths = [...registry.byPath.keys()];
  // Extension-contributed names. A key or env name under `ext` is valid only for an extension composed into this registry
  // (extendRegistry); the refusals say which extensions are, since an unloaded extension's names would otherwise silently do nothing.
  const loadedList = registry.extensions.length === 0 ? "none" : registry.extensions.map((e) => e.name).join(", ");
  const extBySegment = new Map(registry.extensions.map((e) => [e.segment, e]));
  const unknownKey = (path: string): string => {
    const [root, segment = ""] = path.split(".");
    if (root !== EXT_NAMESPACE) return `unknown key ${path}${didYouMean(path, paths)}`;
    const e = extBySegment.get(segment);
    if (e === undefined)
      return `unknown key ${path}: no loaded extension owns ${EXT_NAMESPACE}.${segment}. (loaded: ${loadedList}); an extension's keys are valid only while it is loaded`;
    return `unknown key ${path}: extension ${e.name} declares no such key${didYouMean(path, e.paths)}`;
  };
  const isNode = (path: string): boolean =>
    paths.some((q) => q.startsWith(`${path}.`)) ||
    path === EXT_NAMESPACE ||
    (path.startsWith(`${EXT_NAMESPACE}.`) && !path.slice(4).includes(".") && extBySegment.has(path.slice(4)));
  const unknownEnv = (name: string): string => {
    if (!name.startsWith(EXT_ENV_PREFIX)) return `unknown env ${name}${didYouMean(name, known)}`;
    // Longest matching extension prefix wins (`a` vs `a-b`): POMTREED_EXT_<NAME>_, shared by keys and credentials.
    let owner: (typeof registry.extensions)[number] | undefined;
    let best = 0;
    for (const e of registry.extensions) {
      const prefix = extensionEnvPrefix(e.name);
      if (name.startsWith(prefix) && prefix.length > best) {
        owner = e;
        best = prefix.length;
      }
    }
    if (owner === undefined)
      return `unknown env ${name}: it names no loaded extension (loaded: ${loadedList}); extension env names are valid only while the extension is loaded`;
    const own = [...owner.paths.map((p) => registry.envOf.get(p) as string), ...owner.credentials.map((c) => extensionCredentialEnv(owner.name, c))];
    return `unknown env ${name}: extension ${owner.name} declares no such key or credential${didYouMean(name, own)}`;
  };
  const secretHint = (p: ParamDef) => `set ${secretFileEnv(registry.envOf.get(p.path) as string)} to a file holding it`;
  // `shown` is the value as written, for the message; never called for a sensitive key.
  const accept = (p: ParamDef, parsed0: Parsed, origin: ConfigOrigin, shown: string) => {
    // blankIsDefault: the one place a blank is mapped to the default; the origin stays the layer that supplied the blank.
    const parsed: Parsed = parsed0.ok && p.kind === "string" && p.blankIsDefault === true && parsed0.value === "" ? { ok: true, value: p.default } : parsed0;
    const why = parsed.ok ? (inRange(p, parsed.value) ?? checkReason(p, parsed.value)) : parsed.why;
    if (why !== null) {
      errors.push(`${p.path}=${shown} (${origin}): ${why}`);
      failed.add(p.path);
      return;
    }
    values.set(p.path, (parsed as { value: unknown }).value);
    origins.set(p.path, origin);
  };

  // 1. The JSON file: nested objects by path segment, plus an optional top-level "$schema".
  if (input.file !== undefined) {
    const walk = (obj: Record<string, unknown>, prefix: string): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (prefix === "" && k === "$schema") {
          if (typeof v !== "string") errors.push("config file: $schema must be a string");
          continue;
        }
        const path = prefix === "" ? k : `${prefix}.${k}`;
        const p = registry.byPath.get(path);
        if (p !== undefined) {
          if (isSensitive(p)) {
            errors.push(`config file: ${path} is sensitive and may not be set in the file; ${secretHint(p)}`);
            failed.add(path);
          } else accept(p, fromJson(p, v), "file", show(v));
        } else if (isNode(path)) {
          if (isPlain(v)) walk(v, path);
          else errors.push(`config file: ${path} must be an object`);
        } else errors.push(`config file: ${unknownKey(path)}`);
      }
    };
    if (isPlain(input.file)) walk(input.file, "");
    else errors.push("config file: must be a JSON object");
  }

  // 2. The env, then the unknown names under our prefixes.
  const env = input.env;
  for (const p of registry.params) {
    const name = registry.envOf.get(p.path) as string;
    const raw = env[name];
    if (!isSensitive(p)) {
      if (raw !== undefined) accept(p, fromText(p, raw), `env:${name}`, JSON.stringify(raw));
      continue;
    }
    if (raw !== undefined) {
      errors.push(`${name} may not carry the sensitive ${p.path}; ${secretHint(p)}`);
      failed.add(p.path);
    }
    const fileName = secretFileEnv(name);
    const file = env[fileName];
    if (file === undefined || input.skipSecretFiles === true) continue;
    const fail = (why: string) => {
      errors.push(`${fileName}: ${why}`);
      failed.add(p.path);
    };
    if (!isAbsolute(file)) fail(`expected an absolute path, got ${JSON.stringify(file)}`);
    else if (input.readFile === undefined) fail("set, but no file reader was supplied");
    else {
      let text: string;
      try {
        const mode = input.fileMode?.(file);
        if (mode !== undefined && (mode & 0o077) !== 0) {
          fail(`${file} is readable by group/other; run chmod 600 ${file}`);
          continue;
        }
        text = input.readFile(file);
      } catch (e) {
        // The reader's message names the path (fs errors do), never the contents, which were not read.
        fail(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const secret = text.replace(/\r?\n$/, "");
      if (secret === "") fail(`${file} is empty`);
      else {
        values.set(p.path, secret);
        origins.set(p.path, `file-secret:${fileName}`);
      }
    }
  }
  const ignored = new Set(input.ignoreEnv ?? []);
  const ignoredPrefixes = input.ignoreEnvPrefixes ?? [];
  const known = [...registry.envNames];
  for (const [name, v] of input.skipUnknownEnv === true ? [] : Object.entries(env)) {
    if (v === undefined || name === CONFIG_FILE_ENV || registry.envNames.has(name)) continue;
    if (ignored.has(name) || ignoredPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (registry.prefixes.some((prefix) => name.startsWith(prefix)))
      errors.push(`${unknownEnv(name)}; remove it, or use a name listed in docs/configuration.md`);
  }

  // 3. `--set key=value`, last wins.
  for (const entry of input.set ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      errors.push(eq === 0 ? "--set entry has no key" : `--set ${entry}: expected key=value`);
      continue;
    }
    const path = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);
    const p = registry.byPath.get(path);
    if (p === undefined) errors.push(`--set: ${unknownKey(path)}`);
    else if (isSensitive(p)) {
      errors.push(`--set may not carry the sensitive ${path}; ${secretHint(p)}`);
      failed.add(path);
    } else accept(p, fromText(p, raw), "set", JSON.stringify(raw));
  }

  // 4. Ceilings and relations on the resolved values. A ceiling is refused, never clamped.
  for (const p of registry.params) {
    if (!isNumericParam(p) || failed.has(p.path)) continue;
    const v = values.get(p.path) as number;
    const side = (path: string) => `${path}=${show(values.get(path))} (${origins.get(path)})`;
    for (const r of paramEdges(p)) {
      if (failed.has(r.key) || relationHolds(r.op, v, values.get(r.key) as number)) continue;
      errors.push(
        r.key === p.ceiling
          ? `${side(p.path)} exceeds its ceiling ${side(r.key)}; refused, not clamped`
          : `${side(p.path)} must be ${relationSymbol(r.op)} ${side(r.key)}`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, values: Object.fromEntries(values) as ConfigValues<D>, origins: Object.fromEntries(origins) as ResolvedConfig<D>["origins"] };
}

export interface ConfigRow {
  path: string;
  value: unknown; // REDACTED for a sensitive key that is set
  origin: ConfigOrigin;
  default: unknown;
  kind: ParamKind;
  scope: ParamScope;
  env: string;
  ceiling?: string;
}

// The effective config as rows, in registry order, for `config show --origin`. `changedOnly` drops rows still at their default.
export function describeConfig<D extends readonly ParamDef[]>(
  registry: ConfigRegistry<D>,
  resolved: ResolvedConfig<D>,
  opts: { changedOnly?: boolean } = {},
): ConfigRow[] {
  const values = resolved.values as Readonly<Record<string, unknown>>;
  const origins = resolved.origins as Readonly<Record<string, ConfigOrigin>>;
  const rows: ConfigRow[] = [];
  for (const p of registry.params) {
    const origin = origins[p.path] ?? "default";
    if (opts.changedOnly && origin === "default") continue;
    rows.push({
      path: p.path,
      value: isSensitive(p) && origin !== "default" ? REDACTED : values[p.path],
      origin,
      default: p.default,
      kind: p.kind,
      scope: p.scope,
      env: registry.envOf.get(p.path) as string,
      ...(isNumericParam(p) && p.ceiling !== undefined && { ceiling: p.ceiling }),
    });
  }
  return rows;
}
