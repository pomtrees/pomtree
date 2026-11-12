import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_REGISTRY, configJsonSchema, configSchemaText, describeConfig, isNumericParam, isSensitive, resolveConfig } from "../index.ts";
import type { ConfigValues } from "../index.ts";

// A schema or file node, loosely typed for walking.
interface Node {
  [k: string]: unknown;
  type?: string;
  additionalProperties?: boolean;
  properties: Record<string, Node>;
}

const SCHEMA_FILE = join(import.meta.dirname, "..", "..", "config.schema.json");

test("the checked-in config.schema.json matches the registry (regenerate: pnpm gen:config)", () => {
  assert.equal(readFileSync(SCHEMA_FILE, "utf8"), configSchemaText(CONFIG_REGISTRY));
});

test("the schema is draft 2020-12, closed at every object, and leaves sensitive keys out", () => {
  const s = configJsonSchema(CONFIG_REGISTRY) as Node;
  assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
  const closed = (node: Node): void => {
    if (node.type !== "object") return;
    assert.equal(node.additionalProperties, false);
    for (const child of Object.values(node.properties)) closed(child);
  };
  const { ext, sandbox, ...core } = s.properties;
  closed({ ...s, properties: core });
  // Likewise `sandbox.<id>.*`: a backend's keys exist only while its manifest is composed, so the sandbox object admits one object per
  // backend id beside core's own sandbox keys, which stay closed leaves.
  assert.equal(sandbox?.type, "object");
  assert.equal((sandbox?.additionalProperties as { type?: string } | undefined)?.type, "object");
  for (const leaf of Object.values(sandbox?.properties ?? {})) assert.notEqual(leaf.type, "object", "core's sandbox keys are leaves");
  // The checked-in schema cannot know which extensions load, so the ext subtree is open at the extension level.
  assert.equal(ext?.type, "object");
  assert.deepEqual(ext?.additionalProperties, { type: "object", description: "One extension's keys." });
  assert.equal(s.properties.model?.properties.upstreamKey, undefined, "model.upstreamKey is sensitive");
  assert.equal(s.properties.search?.properties.key, undefined, "search.key is sensitive");
  assert.deepEqual(s.properties.state?.properties.limits?.type, ["object", "array"], "a json key admits an object or array");
  assert.deepEqual(s.properties.report?.properties.maxBytes, {
    description:
      "Cap on one agent report body (POST /v1/agents/self/reports). Unit: bytes. Env: POMTREED_REPORT_MAX_BYTES. Scope: operator. Restart-only. Consumers: @pomtree/pomtreed, examples/hn-digest.",
    type: "integer",
    minimum: 1,
    default: 8 * 1024 * 1024,
  });
});

test("every seeded default passes its own validators: resolving it back through file, env and --set is accepted unchanged", () => {
  const defaults = resolveConfig(CONFIG_REGISTRY, { env: {} });
  assert.ok(defaults.ok, defaults.ok ? "" : defaults.errors.join("\n"));
  type Tree = { [k: string]: unknown };
  const file: Tree = {};
  const env: Record<string, string> = {};
  const set: string[] = [];
  for (const p of CONFIG_REGISTRY.params) {
    assert.ok(p.consumers.length > 0, `${p.path} names its consumers`);
    if (isSensitive(p)) continue;
    const segs = p.path.split(".");
    let node = file;
    for (const s of segs.slice(0, -1)) {
      node[s] ??= {};
      node = node[s] as Tree;
    }
    node[segs[segs.length - 1] as string] = p.default;
    const text = p.kind === "json" ? JSON.stringify(p.default) : Array.isArray(p.default) ? p.default.join(",") : String(p.default);
    env[CONFIG_REGISTRY.envOf.get(p.path) as string] = text;
    set.push(`${p.path}=${text}`);
    if (isNumericParam(p)) {
      if (p.min !== undefined) assert.ok(p.default >= p.min, p.path);
      if (p.max !== undefined) assert.ok(p.default <= p.max, p.path);
    }
  }
  for (const input of [{ file, env: {} }, { env }, { env: {}, set }]) {
    const r = resolveConfig(CONFIG_REGISTRY, input);
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual(r.values, defaults.values);
  }
});

test("the seed carries one sensitive key, masked in its description, and a run-scope key under an operator ceiling", () => {
  const r = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "/run/secrets/model" }, readFile: () => "sk-seed" });
  assert.ok(r.ok);
  const values: ConfigValues<typeof CONFIG_REGISTRY.params> = r.values;
  assert.equal(values["model.upstreamKey"], "sk-seed");
  assert.ok(!JSON.stringify(describeConfig(CONFIG_REGISTRY, r)).includes("sk-seed"));
  const over = resolveConfig(CONFIG_REGISTRY, { env: {}, set: ["budget.topLevelMicros=10000001"] });
  assert.deepEqual(over.ok ? [] : over.errors, [
    "budget.topLevelMicros=10000001 (set) exceeds its ceiling budget.rootMicros=10000000 (default); refused, not clamped",
  ]);
  // The workflow ceiling is not bounded by any core key but report.maxBytes; the digest's own relations to it are pinned in
  // examples/hn-digest/params.test.mts.
  assert.ok(resolveConfig(CONFIG_REGISTRY, { env: {}, set: ["report.workflowMaxBytes=1024"] }).ok);
});
