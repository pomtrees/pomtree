// The configuration reference tables in docs/configuration.md, generated from the config registry (pnpm gen:config; see gen-config.ts).
// Pure: no env or fs access. The registry (and, for the extension section, the real extendRegistry composition) is the only
// source of every fact rendered here; docs/configuration.md carries the output between CONFIG_DOCS_BEGIN and CONFIG_DOCS_END.
import {
  CONFIG_FILE_ENV,
  EXT_NAMESPACE,
  composeRegistry,
  extendRegistry,
  sandboxCredentialEnv,
  sandboxEnvPrefix,
  secretFileEnv,
  extensionCredentialEnv,
  isNumericParam,
  isSensitive,
  parseExtensionParams,
  relationSymbol,
  STANDARD_SANDBOX_KEYS,
} from "../src/index.ts";
import type { ConfigRegistry, EnvExclusion, ParamDef, SandboxBackendConfigDecl } from "../src/index.ts";

export const CONFIG_DOCS_BEGIN = "<!-- BEGIN GENERATED: config-reference (pnpm gen:config; do not edit by hand) -->";
export const CONFIG_DOCS_END = "<!-- END GENERATED: config-reference -->";

const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (s: string): string => `\`${s.replaceAll("`", "'")}\``;

function defaultOf(p: ParamDef): string {
  const d = p.default;
  if (p.kind === "list") return (d as readonly string[]).length === 0 ? "none" : code((d as readonly string[]).join(","));
  if (p.kind === "json") return code(JSON.stringify(d));
  if (typeof d === "string") return d === "" ? "unset" : code(d);
  return code(String(d));
}

function limitsOf(p: ParamDef): string {
  const parts: string[] = [];
  if (isNumericParam(p)) {
    if (p.min !== undefined) parts.push(`min ${p.min}`);
    if (p.max !== undefined) parts.push(`max ${p.max}`);
    else if (p.kind === "ratio") parts.push("max 1");
    if (p.ceiling !== undefined) parts.push(`<= ${code(p.ceiling)} (ceiling)`);
    for (const r of p.relations ?? []) parts.push(`${relationSymbol(r.op)} ${code(r.key)}`);
  } else if (p.kind === "enum") parts.push(p.values.map(code).join(", "));
  else if (p.kind === "path") parts.push("absolute");
  return parts.length === 0 ? "" : parts.join("; ");
}

function row(registry: ConfigRegistry, p: ParamDef): string {
  const env = registry.envOf.get(p.path);
  const envCell = env === undefined ? "" : isSensitive(p) ? `${code(secretFileEnv(env))} (secret)` : code(env);
  const scope = [p.scope, ...(p.container === true ? ["container"] : [])].join(", ");
  return `| ${[code(p.path), envCell, p.kind, defaultOf(p), limitsOf(p), scope, p.doc].map(cell).join(" | ")} |`;
}

const HEAD = "| Key | Environment variable | Kind | Default | Limits | Scope | Description |\n| --- | --- | --- | --- | --- | --- | --- |";

// One table per namespace (a path's first segment for core, the extension segment for extension keys), in registry order.
function tables(registry: ConfigRegistry, params: readonly ParamDef[], level: string, nsOf: (p: ParamDef) => string): string[] {
  const groups = new Map<string, ParamDef[]>();
  for (const p of params) groups.set(nsOf(p), [...(groups.get(nsOf(p)) ?? []), p]);
  return [...groups].map(([ns, ps]) => `${level} ${code(ns)}\n\n${HEAD}\n${ps.map((p) => row(registry, p)).join("\n")}`);
}

// The sandbox backend section: the standard key set once (rendered from a stand-in backend, so the rows are the real definitions with
// `<id>` in place of the id), then each shipped backend's own keys and credentials, composed exactly as the daemon composes them.
function sandboxBackendDocs(core: ConfigRegistry, backends: readonly SandboxBackendConfigDecl[]): string[] {
  const registry = composeRegistry(core, {
    sandboxBackends: [{ id: "id", owner: "template", builtin: false, params: [] }, ...backends],
  });
  const standard = new Set(STANDARD_SANDBOX_KEYS.map((k) => k.key));
  const out: string[] = ["#### Sandbox backend keys"];
  out.push(
    "A backend's keys live under `sandbox.<id>.*`, where `<id>` is the backend id in camelCase (`my-box` is `myBox`), and its env names are `POMTREED_SANDBOX_<ID>_<KEY>`. Each backend declares its own keys in a manifest (a built-in adapter package ships `manifest.json`; an extension lists its backend in `provides`), and the daemon composes them at start with the standard keys below, which every backend gets with the same names. A built-in adapter may change the defaults; keys exist only while the backend is composed. A credential is a declared name, never a config key: it is supplied only as a path in `POMTREED_SANDBOX_<ID>_<CREDENTIAL>_FILE` to a file that is not group- or world-accessible (checked on the opened file; on Windows, which has no POSIX modes, the check is skipped).",
  );
  const template = registry.sandboxBackends.find((b) => b.id === "id");
  const generic = (v: string) =>
    v.replace("sandbox.id.", "sandbox.<id>.").replace(sandboxEnvPrefix("id"), `${sandboxEnvPrefix("id").replace("_ID_", "_")}<ID>_`);
  const rows = (template?.paths ?? []).map((path) => row(registry, registry.byPath.get(path) as ParamDef));
  out.push(`##### ${code("sandbox.<id>")} (every backend)\n\n${HEAD}\n${rows.map(generic).join("\n")}`);
  for (const b of registry.sandboxBackends) {
    if (b.id === "id") continue;
    const own = b.paths.filter((path) => !standard.has(path.split(".").slice(2).join(".")));
    if (own.length > 0)
      out.push(
        `##### ${code(`sandbox.${b.segment}`)} (${b.builtin ? "built-in" : "extension"} ${code(b.owner)}, backend ${code(b.id)})\n\n${HEAD}\n${own.map((path) => row(registry, registry.byPath.get(path) as ParamDef)).join("\n")}`,
      );
    for (const c of b.credentials) out.push(`Declared credential of ${code(b.id)}: ${code(secretFileEnv(sandboxCredentialEnv(b.id, c)))} (secret file).`);
  }
  return out;
}

// `core` is the unextended registry; `composed` is the same registry after extendRegistry with the loaded example extensions.
// `backends` are the shipped sandbox backend manifests, composed for the sandbox section.
export function configDocsText(
  core: ConfigRegistry,
  composed: ConfigRegistry,
  exclusions: readonly EnvExclusion[],
  backends: readonly SandboxBackendConfigDecl[] = [],
): string {
  const out: string[] = [];
  out.push("#### Core keys");
  out.push(
    "Generated from the registry. Kinds `bytes`, `count`, `ms` and `micros` are plain non-negative integers in that unit; `ratio` is a number from 0 to 1. A value above its ceiling or violating a relation is refused, never clamped. A secret key is supplied only through the `_FILE` variable shown. `container` marks a key delivered to agent containers.",
  );
  out.push(...tables(core, core.params, "#####", (p) => p.path.split(".")[0] as string));
  out.push(...sandboxBackendDocs(core, backends));
  const extParams = composed.params.filter((p) => p.path.split(".")[0] === EXT_NAMESPACE);
  for (const e of composed.extensions) {
    out.push(`#### Extension keys: ${code(e.name)}`);
    out.push(
      `Composed with \`extendRegistry\` from \`examples/${e.name}/manifest.json\`, exactly as the daemon composes a present extension, so these are the names and bounds it resolves. Keys exist only while the extension is present in \`extensions.dir\`; extension keys are host-side only and never sensitive.`,
    );
    out.push(
      ...tables(
        composed,
        extParams.filter((p) => e.paths.includes(p.path)),
        "#####",
        () => `${EXT_NAMESPACE}.${e.segment}`,
      ),
    );
    for (const c of e.credentials) out.push(`Declared credential: ${code(extensionCredentialEnv(e.name, c))}.`);
  }
  out.push("#### Environment names that are deliberately not parameters");
  out.push(
    `The resolver ignores these names under our prefixes (\`POMTREED_\`, \`POMTREE_\`, \`PTREE_\`) instead of refusing them as unknown. The config-file path ${code(CONFIG_FILE_ENV)} is reserved separately. A trailing \`*\` marks a family prefix.`,
  );
  out.push(
    `| Name | Reason | Why |\n| --- | --- | --- |\n${exclusions.map((x) => `| ${[code(x.prefix ? `${x.name}*` : x.name), x.reason, x.why].map(cell).join(" | ")} |`).join("\n")}`,
  );
  return `${out.join("\n\n")}\n`;
}

// Composes the core registry with the extension manifest(s) the way pomtreed does (parseExtensionParams, then one extendRegistry).
export function composeManifests(
  core: ConfigRegistry,
  manifests: readonly { name: string; params?: unknown; credentials?: readonly string[] }[],
): ConfigRegistry {
  const decls = manifests.map((m) => {
    const parsed = parseExtensionParams(m.name, m.params);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return { name: m.name, params: parsed.params, credentials: m.credentials };
  });
  return extendRegistry(core, decls);
}

// The document with its generated section replaced (the markers stay); throws if the markers are missing or out of order.
export function spliceConfigDocs(doc: string, generated: string): string {
  const b = doc.indexOf(CONFIG_DOCS_BEGIN);
  const e = doc.indexOf(CONFIG_DOCS_END);
  if (b < 0 || e < b) throw new Error(`docs/configuration.md needs ${CONFIG_DOCS_BEGIN} before ${CONFIG_DOCS_END}`);
  return `${doc.slice(0, b + CONFIG_DOCS_BEGIN.length)}\n\n${generated}\n${doc.slice(e)}`;
}
