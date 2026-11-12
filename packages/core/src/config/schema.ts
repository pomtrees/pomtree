// JSON Schema (draft 2020-12) for the config file, generated from a registry. Pure. The checked-in copy
// (packages/core/config.schema.json, written by packages/core/scripts/gen-config.ts) is guarded by a test that
// regenerates it and compares. Sensitive keys are left out: the file may not carry them.
import { EXT_NAMESPACE, SANDBOX_NAMESPACE, secretFileEnv } from "./env-name.ts";
import type { ConfigRegistry, ParamDef } from "./registry.ts";
import { isIntegerKind, isNumericParam, isSensitive, relationSymbol } from "./registry.ts";

export const CONFIG_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const UNIT_DOC: Readonly<Record<string, string>> = { bytes: "bytes", ms: "milliseconds", micros: "micro-dollars (1000000 = $1)", count: "count" };

type Schema = Record<string, unknown>;

function leaf(registry: ConfigRegistry, p: ParamDef): Schema {
  const notes = [p.doc];
  if (UNIT_DOC[p.kind] !== undefined) notes.push(`Unit: ${UNIT_DOC[p.kind]}.`);
  notes.push(`Env: ${registry.envOf.get(p.path)}. Scope: ${p.scope}. Restart-only. Consumers: ${p.consumers.join(", ")}.`);
  if (isNumericParam(p)) {
    if (p.ceiling !== undefined) notes.push(`Refused above the ceiling ${p.ceiling}.`);
    for (const r of p.relations ?? []) notes.push(`Must be ${relationSymbol(r.op)} ${r.key}.`);
  }
  const s: Schema = { description: notes.join(" ") };
  if (isNumericParam(p)) {
    s.type = isIntegerKind(p.kind) ? "integer" : "number";
    s.minimum = p.min ?? 0;
    if (p.max !== undefined) s.maximum = p.max;
    else if (p.kind === "ratio") s.maximum = 1;
  } else if (p.kind === "bool") s.type = "boolean";
  else if (p.kind === "enum") s.enum = [...p.values];
  else if (p.kind === "list") s.type = "array";
  else if (p.kind === "json") s.type = ["object", "array"];
  else s.type = "string";
  if (p.kind === "list") s.items = { type: "string", minLength: 1 };
  if (p.kind === "string" && p.schema !== undefined) {
    // A fragment that carries `type` and `enum`-style keywords replaces the plain string type (anyOf cannot sit beside it usefully).
    delete s.type;
    Object.assign(s, p.schema);
  }
  s.default = p.default;
  return s;
}

const object = (): Schema => ({ type: "object", additionalProperties: false, properties: {} });

export function configJsonSchema(registry: ConfigRegistry): Schema {
  const root: Schema = {
    $schema: CONFIG_SCHEMA_DIALECT,
    title: "pomtree configuration",
    description: `The JSON config file named by $POMTREED_CONFIG. Precedence: default < this file < env < --set. Every key is restart-only. Sensitive keys are not accepted here; supply each through its ${secretFileEnv("<ENV>")} path env.`,
    ...object(),
  };
  (root.properties as Schema).$schema = { type: "string" };
  for (const p of registry.params) {
    if (isSensitive(p)) continue;
    const segments = p.path.split(".");
    let node = root;
    for (const seg of segments.slice(0, -1)) {
      const props = node.properties as Schema;
      props[seg] ??= object();
      node = props[seg] as Schema;
    }
    (node.properties as Schema)[segments[segments.length - 1] as string] = leaf(registry, p);
  }
  // The checked-in schema describes the core registry, which has no extension keys; the `ext` subtree is open there because
  // an extension's keys exist only while it is loaded (the daemon validates them against the loaded manifests at startup).
  // A schema generated from a composed registry (extendRegistry) has the exact subtree instead.
  (root.properties as Schema)[EXT_NAMESPACE] ??= {
    type: "object",
    description: `Extension-contributed keys, ${EXT_NAMESPACE}.<segment>.<key>, where <segment> is the camelCase of the extension's name. Declared by each extension's manifest and validated at startup against the loaded extensions; unknown or unloaded keys are refused.`,
    additionalProperties: { type: "object", description: "One extension's keys." },
  };
  // The same for `sandbox.<id>.*`: a backend's keys exist only while its manifest is composed, and a contributed backend's manifest is
  // not known to the checked-in schema. A schema generated from a composed registry has the exact subtrees instead.
  if (registry.sandboxBackends.length === 0) {
    const sandbox = (root.properties as Schema)[SANDBOX_NAMESPACE] as Schema;
    sandbox.additionalProperties = {
      type: "object",
      description: `One sandbox backend's keys, sandbox.<id>.<key>, where <id> is the camelCase of the backend id. Declared by the adapter's or extension's manifest and validated at startup against the composed backends; unknown ids are refused.`,
    };
  }
  return root;
}

// JSON in the repo formatter's layout (Biome, lineWidth 160), so the generated file passes `pnpm format:check` unchanged:
// objects always expanded, an array of scalars on one line when the whole line fits, any other array expanded.
const LINE_WIDTH = 160;
function layout(v: unknown, indent: string, lead: number): string {
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const flat = `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    if (v.every((x) => typeof x !== "object" || x === null) && lead + flat.length + 1 <= LINE_WIDTH) return flat;
    return `[\n${v.map((x) => `${inner}${layout(x, inner, inner.length)}`).join(",\n")}\n${indent}]`;
  }
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    const field = ([k, x]: [string, unknown]) => `${inner}${JSON.stringify(k)}: ${layout(x, inner, inner.length + JSON.stringify(k).length + 2)}`;
    return `{\n${entries.map(field).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(v);
}

// The exact bytes of the checked-in schema file.
export const configSchemaText = (registry: ConfigRegistry): string => `${layout(configJsonSchema(registry), "", 0)}\n`;

// The configuration reference (docs/configuration.md) is generated from the registry by scripts/config-docs.ts (run by `pnpm gen:config`).
