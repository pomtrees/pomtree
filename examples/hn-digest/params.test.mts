// The digest's config table (params.mts): equal to manifest.json, composes under ext.hnDigest, and the relation graph it owns,
// edge by edge at the defaults. The core graph is pinned in packages/core/src/config/registry.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONFIG_REGISTRY,
  extendRegistry,
  extensionSegment,
  type NumericParam,
  type ParamDef,
  parseExtensionParams,
  resolveConfig,
} from "../../packages/core/src/index.ts";
import { HN_DIGEST_DEFAULTS, HN_DIGEST_EXTENSION, HN_DIGEST_PARAMS, HN_DIGEST_SEGMENT } from "./params.mts";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")) as { name: string; params: unknown };
const composed = extendRegistry(CONFIG_REGISTRY, [{ name: HN_DIGEST_EXTENSION, params: HN_DIGEST_PARAMS }]);
const P = (key: string): NumericParam => composed.byPath.get(`ext.${HN_DIGEST_SEGMENT}.${key}`) as NumericParam;

test("manifest.json carries exactly the params table (the daemon reads the manifest, the code reads params.mts)", () => {
  assert.equal(manifest.name, HN_DIGEST_EXTENSION);
  assert.deepEqual(manifest.params, JSON.parse(JSON.stringify(HN_DIGEST_PARAMS)));
  const parsed = parseExtensionParams(manifest.name, manifest.params);
  assert.ok(parsed.ok, JSON.stringify(parsed));
});

test("the segment constant is core's segment of the extension name; every key composes as ext.hnDigest.<key> and is owned by hn-digest", () => {
  assert.equal(extensionSegment(HN_DIGEST_EXTENSION), HN_DIGEST_SEGMENT);
  assert.deepEqual(Object.keys(HN_DIGEST_DEFAULTS).sort(), HN_DIGEST_PARAMS.map((p) => `ext.${HN_DIGEST_SEGMENT}.${p.key}`).sort());
  for (const [path, value] of Object.entries(HN_DIGEST_DEFAULTS)) {
    const def = composed.byPath.get(path) as ParamDef;
    assert.deepEqual(def.consumers, [HN_DIGEST_EXTENSION], path);
    assert.equal(def.default, value, path);
    assert.equal("container" in def && def.container, false, `${path} is host-side only`);
    assert.ok((composed.envOf.get(path) ?? "").startsWith("POMTREED_EXT_HN_DIGEST_"), path);
  }
});

// [key, op, target (bare = the digest's own key, dotted = a core key), the key's default, the target's default]
const EDGES: readonly (readonly [string, string, string, number, number])[] = [
  ["articleBrowserCaptureDeadlineMs", "gte", "browser.capture.deadlineMinMs", 60_000, 1000],
  ["articleBrowserCaptureDeadlineMs", "lte", "browser.capture.deadlineMaxMs", 60_000, 120_000],
  ["articleCaptureBytes", "lte", "browser.capture.maxBytesCeiling", 262_144, 1_048_576],
  ["articleCaptureBytes", "lte", "articleAuditBodyMaxBytes", 262_144, 2_097_152],
  ["articleTextMaxBytes", "lte", "report.maxBytes", 1_048_576, 8_388_608],
  ["articleTextMaxBytes", "gte", "browser.capture.textMaxBytes", 1_048_576, 1_048_576],
  ["articlePageMaxBytes", "lte", "articleAnalystReadMaxBytes", 16_384, 262_144],
  ["articlePageMaxBytes", "lte", "report.maxBytes", 16_384, 8_388_608],
  ["reportMaxBytes", "lte", "report.workflowMaxBytes", 65_536, 262_144],
];
const full = (k: string): string => (k.includes(".") ? k : `ext.${HN_DIGEST_SEGMENT}.${k}`);

test("the digest's relation graph, edge by edge at the defaults; the browser text edge is declared here, not in core", () => {
  for (const [a, op, b, da, db] of EDGES) {
    assert.ok(
      P(a).relations?.some((r) => r.op === op && r.key === full(b)),
      `${a} ${op} ${b} is declared`,
    );
    assert.equal(P(a).default, da, `${a} default`);
    assert.equal((composed.byPath.get(full(b)) as NumericParam).default, db, `${b} default`);
  }
  for (const a of new Set(EDGES.map((e) => e[0]))) {
    const declared = (P(a).relations ?? []).map((r) => `${r.op} ${r.key}`).sort();
    const listed = EDGES.filter((e) => e[0] === a)
      .map((e) => `${e[1]} ${full(e[2])}`)
      .sort();
    assert.deepEqual(declared, listed, a);
  }
  assert.equal(P("articleAnalystReadMaxBytes").max, 1_048_576, "the read budget is hard-capped (a larger value is refused, never clamped)");
  assert.equal(P("articleTextMaxBytes").max, undefined, "the stored text bound is not capped by it");
});

test("the paging keys refuse a page larger than the read budget and a read budget above its maximum", () => {
  const errorsWith = (key: string, value: number): string[] => {
    const params = HN_DIGEST_PARAMS.map((p) => (p.key === key ? { ...p, default: value } : p));
    try {
      extendRegistry(CONFIG_REGISTRY, [{ name: HN_DIGEST_EXTENSION, params }]);
      return [];
    } catch (e) {
      return (e as { errors: string[] }).errors;
    }
  };
  assert.deepEqual(errorsWith("articlePageMaxBytes", 16_384), []);
  const page = errorsWith("articlePageMaxBytes", 524_288);
  assert.equal(page.length, 1);
  assert.match(page[0] ?? "", /articlePageMaxBytes default 524288 violates .* <= .*articleAnalystReadMaxBytes/);
  const read = errorsWith("articleAnalystReadMaxBytes", 2_097_152);
  assert.equal(read.length, 1);
  assert.match(read[0] ?? "", /articleAnalystReadMaxBytes default 2097152 is above its maximum 1048576/);
});

test("resolved over the composed registry: the workflow ceiling bounds reportMaxBytes, and the audit body bounds the capture", () => {
  const ceiling = resolveConfig(composed, { env: {}, set: ["report.workflowMaxBytes=1024"] });
  assert.deepEqual(ceiling.ok ? [] : ceiling.errors, ["ext.hnDigest.reportMaxBytes=65536 (default) must be <= report.workflowMaxBytes=1024 (set)"]);
  assert.ok(resolveConfig(composed, { env: {}, set: ["report.workflowMaxBytes=65536"] }).ok, "a workflow ceiling below the capture bytes resolves");
  const audit = resolveConfig(composed, { env: {}, set: ["ext.hnDigest.articleAuditBodyMaxBytes=1000"] });
  assert.deepEqual(audit.ok ? [] : audit.errors, [
    "ext.hnDigest.articleCaptureBytes=262144 (default) must be <= ext.hnDigest.articleAuditBodyMaxBytes=1000 (set)",
  ]);
});
