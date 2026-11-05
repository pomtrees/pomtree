// The producer side of container delivery. pomtreed (and any test that starts a worker directly) turns its resolved config into the
// PTREE_CONFIG_JSON document: `{"contract":"<16 hex>","values":{...}}` holding exactly the `container: true` keys, sorted.
// The contract digest covers what an image is built against (the delivered keys' kinds, bounds and relations among
// themselves, the env name, the size cap and the image facts) and deliberately not the defaults, so changing a default does not
// invalidate images; changing a bound, the delivered key set or a fact does. Pure apart from hashing.
import { createHash } from "node:crypto";
import { BROWSER_MAX_MS_RANGE, BROWSER_MAX_STEPS_RANGE } from "../template.ts";
import type { ContainerParamSpec, ContainerReadSpec } from "./container-reader.ts";
import { canonicalContainerDoc, readContainerDoc } from "./container-reader.ts";
import {
  CDP_PORT,
  CLI_POMTREE_MAIN,
  CLI_POMTREE_TIMEOUT_MS,
  EGRESS_BROWSER_PROXY_PORT,
  EGRESS_BROWSER_SOCKET_NAME,
  EGRESS_PROXY_PORT,
  EGRESS_SOCKET_DIR,
  EGRESS_SOCKET_NAME,
  FIXED_PATH,
  MAX_HANDOFF_BYTES,
  NODE_BIN,
  PI_BIN,
  PROXY_ENV_NAMES,
} from "./image-facts.ts";
import type { ConfigParams } from "./params.ts";
import type { ConfigRegistry, ParamDef, ParamValue } from "./registry.ts";
import { isNumericParam, paramEdges } from "./registry.ts";

export const CONTAINER_CONFIG_ENV = "PTREE_CONFIG_JSON";
export const CONTAINER_CONFIG_MAX_BYTES = 16 * 1024;

// Every image fact the generated module carries, in emit order. Part of the contract digest.
export const IMAGE_FACTS = {
  FIXED_PATH,
  CLI_POMTREE_MAIN,
  PROXY_ENV_NAMES,
  CDP_PORT,
  CLI_POMTREE_TIMEOUT_MS,
  EGRESS_PROXY_PORT,
  EGRESS_SOCKET_DIR,
  EGRESS_SOCKET_NAME,
  EGRESS_BROWSER_PROXY_PORT,
  EGRESS_BROWSER_SOCKET_NAME,
  NODE_BIN,
  PI_BIN,
  MAX_HANDOFF_BYTES,
  BROWSER_MAX_STEPS_RANGE,
  BROWSER_MAX_MS_RANGE,
} as const;

// The typed subset of CONFIG_REGISTRY delivered to containers.
type ContainerParam = Extract<ConfigParams[number], { readonly container: true }>;
export type ContainerConfigValues = { readonly [P in ContainerParam as P["path"]]: ParamValue<P> };

// The delivered keys of a registry, sorted by path.
export const containerParamDefs = (registry: ConfigRegistry): ParamDef[] =>
  registry.params.filter((p) => p.container === true).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// The reader's view of each delivered key: kind, bounds, and only the edges (ceiling as lte, then relations) whose other side is
// delivered too (the rest are checked on the host by the resolver, which sees every key).
export function containerParams(registry: ConfigRegistry): ContainerParamSpec[] {
  const defs = containerParamDefs(registry);
  const delivered = new Set(defs.map((p) => p.path));
  return defs.map((p) => {
    const spec: { -readonly [K in keyof ContainerParamSpec]: ContainerParamSpec[K] } = { path: p.path, kind: p.kind as ContainerParamSpec["kind"] };
    if (isNumericParam(p)) {
      if (p.min !== undefined) spec.min = p.min;
      if (p.max !== undefined) spec.max = p.max;
      const relations = paramEdges(p)
        .filter((r) => delivered.has(r.key))
        .map((r) => ({ op: r.op, key: r.key }));
      if (relations.length > 0) spec.relations = relations;
    }
    return spec;
  });
}

// The delivered keys' defaults, sorted by path.
export const containerDefaults = (registry: ConfigRegistry): Record<string, number | boolean> =>
  Object.fromEntries(containerParamDefs(registry).map((p) => [p.path, p.default as number | boolean]));

// Canonical JSON (keys sorted at every level) for hashing.
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : typeof v === "object" && v !== null
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

// The 16-hex contract digest of a registry's delivered set and the image facts (`facts` is a seam for the digest tests).
export const containerContract = (registry: ConfigRegistry, facts: Readonly<Record<string, unknown>> = IMAGE_FACTS): string =>
  createHash("sha256")
    .update(canonical({ env: CONTAINER_CONFIG_ENV, maxBytes: CONTAINER_CONFIG_MAX_BYTES, params: containerParams(registry), facts }))
    .digest("hex")
    .slice(0, 16);

// The reader spec an image built from `registry` carries (the generated module embeds the same values as literals).
export const containerReadSpec = (registry: ConfigRegistry): ContainerReadSpec => ({
  contract: containerContract(registry),
  env: CONTAINER_CONFIG_ENV,
  maxBytes: CONTAINER_CONFIG_MAX_BYTES,
  params: containerParams(registry),
  defaults: containerDefaults(registry),
});

// The document for `values` (a full resolved config or just the delivered subset; other keys are ignored). Throws on a missing
// delivered key, a value the reader would refuse (wrong type, out of range, a relation among delivered keys) or a document over
// CONTAINER_CONFIG_MAX_BYTES: the output is validated by the same reader the image runs.
export function containerConfigDoc(registry: ConfigRegistry, values: Readonly<Record<string, unknown>>): string {
  const spec = containerReadSpec(registry);
  const subset: Record<string, number | boolean> = {};
  for (const p of spec.params) {
    if (!Object.hasOwn(values, p.path)) throw new Error(`container config: missing value for ${p.path}`);
    subset[p.path] = values[p.path] as number | boolean;
  }
  const doc = canonicalContainerDoc(spec.contract, subset);
  readContainerDoc(doc, spec, { required: true });
  return doc;
}

// The env entry pomtreed sets on every container start (after any caller-supplied env, so it cannot be overridden).
export const containerConfigEnv = (registry: ConfigRegistry, values: Readonly<Record<string, unknown>>): { [CONTAINER_CONFIG_ENV]: string } => ({
  [CONTAINER_CONFIG_ENV]: containerConfigDoc(registry, values),
});

// The delivered subset of a resolved config, typed (for journal details and DaemonDeps.containerConfig).
export function containerConfigValues(registry: ConfigRegistry, values: Readonly<Record<string, unknown>>): ContainerConfigValues {
  const out: Record<string, unknown> = {};
  for (const p of containerParamDefs(registry)) {
    if (!Object.hasOwn(values, p.path)) throw new Error(`container config: missing value for ${p.path}`);
    out[p.path] = values[p.path];
  }
  return Object.freeze(out) as ContainerConfigValues;
}
