import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_ENV_EXCLUSIONS,
  CONFIG_ENV_PREFIXES,
  CONFIG_REGISTRY,
  ConfigRegistryError,
  camelHumps,
  defineRegistry,
  deriveEnvName,
  editDistance,
  nearestName,
} from "../index.ts";
import type { NumericParam, ParamDef } from "../index.ts";

const count = (path: string, extra: Record<string, unknown> = {}): ParamDef =>
  ({ path, kind: "count", default: 1, doc: "d", scope: "operator", consumers: ["x"], ...extra }) as ParamDef;

const errorsOf = (defs: readonly ParamDef[]): readonly string[] => {
  try {
    defineRegistry(defs);
  } catch (e) {
    assert.ok(e instanceof ConfigRegistryError, String(e));
    assert.equal(e.message, `invalid config registry: ${e.errors.join("; ")}`);
    return e.errors;
  }
  return [];
};

test("camelHumps and deriveEnvName: humps split at lower-to-upper, an acronym run keeps its last letter for the next hump", () => {
  assert.deepEqual(camelHumps("maxBytes"), ["max", "Bytes"]);
  assert.deepEqual(camelHumps("tlsCAFile"), ["tls", "CA", "File"]);
  assert.deepEqual(camelHumps("http2Port"), ["http2", "Port"]);
  assert.deepEqual(camelHumps("maxMB"), ["max", "MB"]);
  assert.deepEqual(camelHumps("x"), ["x"]);
  assert.equal(deriveEnvName("report.reports.maxBytes"), "POMTREED_REPORT_REPORTS_MAX_BYTES");
  assert.equal(deriveEnvName("report.tls.tlsCAFile"), "POMTREED_REPORT_TLS_TLS_CA_FILE");
  assert.equal(deriveEnvName("browser.capture.deadlineMinMs"), "POMTREED_BROWSER_CAPTURE_DEADLINE_MIN_MS");
  assert.equal(deriveEnvName("client.socket.path"), "POMTREE_CLIENT_SOCKET_PATH");
  assert.equal(deriveEnvName("nope.a"), null);
  assert.equal(deriveEnvName("toString.a"), null, "prototype names are not namespaces");
  // The forward mapping is lossy, which is why collisions are checked at definition time.
  assert.equal(deriveEnvName("report.a.tlsCAFile"), deriveEnvName("report.a.tlsCaFile"));
});

test("editDistance and nearestName", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("", "ab"), 2);
  assert.equal(
    nearestName("POMTREED_REPORT_REPORT_MAX_BYTES", ["POMTREED_REPORT_PUSH_MAX_BYTES", "POMTREED_REPORT_REPORTS_MAX_BYTES"]),
    "POMTREED_REPORT_REPORTS_MAX_BYTES",
  );
  assert.equal(nearestName("POMTREED_ZZZ", ["POMTREED_REPORT_REPORTS_MAX_BYTES"]), null);
});

test("nearestName: the edit threshold ignores the shared env prefix, so a long prefix does not loosen it", () => {
  const candidates = ["POMTREED_MERGE_DENY", "POMTREED_AGENT_MAX_DEPTH"];
  assert.equal(nearestName("POMTREED_MODEL_KEY", candidates), null);
  assert.equal(nearestName("POMTREED_MAX_DEPTH", candidates), null);
  assert.equal(nearestName("POMTREED_AGENT_MAX_DEPHT", candidates), "POMTREED_AGENT_MAX_DEPTH");
  // A dotted config key path has no env prefix: the threshold is unchanged.
  assert.equal(nearestName("report.maxBytse", ["report.maxBytes"]), "report.maxBytes");
});

test("the seed registry is valid and its prefixes come from the namespace table", () => {
  assert.ok(CONFIG_REGISTRY.params.length > 0);
  assert.deepEqual([...CONFIG_REGISTRY.prefixes].sort(), [...new Set(Object.values(CONFIG_ENV_PREFIXES))].sort());
  assert.ok(CONFIG_REGISTRY.envNames.has("POMTREED_MODEL_UPSTREAM_KEY_FILE"));
});

test("definition-time validation: duplicate path", () => {
  assert.deepEqual(errorsOf([count("report.a"), count("report.a")]), ["duplicate path report.a"]);
});

test("definition-time validation: path shape, namespace and nesting", () => {
  assert.deepEqual(errorsOf([count("report")]), ['invalid path "report": expected dotted lowerCamel segments, at least two']);
  assert.deepEqual(errorsOf([count("report.max_x")]), ['invalid path "report.max_x": expected dotted lowerCamel segments, at least two']);
  assert.deepEqual(errorsOf([count("nope.a")]), ["nope.a is in a namespace with no env prefix"]);
  assert.deepEqual(errorsOf([count("report.a"), count("report.a.b")]), ["report.a.b nests under the parameter report.a"]);
});

test("definition-time validation: doc, consumers, env shape, sensitive scope", () => {
  assert.deepEqual(errorsOf([count("report.a", { doc: " " })]), ["report.a has no doc"]);
  assert.deepEqual(errorsOf([count("report.a", { consumers: [] })]), ["report.a declares no consumers"]);
  assert.deepEqual(errorsOf([count("report.a", { env: "lower" })]), ['report.a env "lower" is not an UPPER_SNAKE name']);
  assert.deepEqual(errorsOf([{ path: "report.key", kind: "string", default: "", sensitive: true, doc: "d", scope: "run", consumers: ["x"] }]), [
    "report.key is sensitive, so its scope must be operator",
  ]);
  assert.deepEqual(errorsOf([{ path: "report.key", kind: "string", default: "hunter2", sensitive: true, doc: "d", scope: "operator", consumers: ["x"] }]), [
    'report.key is sensitive, so its default must be ""',
  ]);
});

test("definition-time validation: bad relation and ceiling targets", () => {
  assert.deepEqual(errorsOf([count("report.a", { relations: [{ op: "lte", key: "report.missing" }] })]), [
    "report.a relation lte names unknown key report.missing",
  ]);
  assert.deepEqual(errorsOf([count("report.a", { ceiling: "report.missing" })]), ["report.a ceiling names unknown key report.missing"]);
  assert.deepEqual(errorsOf([count("report.a", { scope: "run", ceiling: "report.b" }), count("report.b", { scope: "run", default: 2 })]), [
    "report.a ceiling report.b must be an operator key",
  ]);
  assert.deepEqual(errorsOf([count("report.a", { relations: [{ op: "lte", key: "report.bMs" }] }), { ...count("report.bMs"), kind: "ms" } as ParamDef]), [
    "report.a lte report.bMs compares count with ms",
  ]);
  assert.deepEqual(
    errorsOf([{ path: "report.on", kind: "bool", default: true, doc: "d", scope: "operator", consumers: ["x"], min: 1 } as unknown as ParamDef]),
    ["report.on is kind bool; only numeric kinds take min, max, ceiling or relations"],
  );
});

test("definition-time validation: relation cycles, including a self-edge", () => {
  assert.deepEqual(
    errorsOf([count("report.a", { relations: [{ op: "lte", key: "report.b" }] }), count("report.b", { relations: [{ op: "lte", key: "report.a" }] })]),
    ["relation cycle: report.a -> report.b -> report.a"],
  );
  assert.deepEqual(errorsOf([count("report.a", { relations: [{ op: "gte", key: "report.a" }] })]), ["relation cycle: report.a -> report.a"]);
  // A ceiling edge counts too.
  assert.deepEqual(errorsOf([count("report.a", { scope: "run", ceiling: "report.b" }), count("report.b", { relations: [{ op: "gte", key: "report.a" }] })]), [
    "relation cycle: report.a -> report.b -> report.a",
  ]);
});

test("definition-time validation: a default violating its own bounds, relations or ceiling", () => {
  assert.deepEqual(errorsOf([count("report.a", { default: 0, min: 1 })]), ["report.a default 0 is below its minimum 1"]);
  assert.deepEqual(errorsOf([count("report.a", { default: 9, max: 8 })]), ["report.a default 9 is above its maximum 8"]);
  assert.deepEqual(errorsOf([count("report.a", { min: 3, max: 2, default: 2 })]), [
    "report.a min 3 exceeds max 2",
    "report.a default 2 is below its minimum 3",
  ]);
  assert.deepEqual(errorsOf([count("report.a", { default: 1.5 })]), ["report.a default must be a non-negative integer"]);
  assert.deepEqual(errorsOf([{ ...count("report.share"), kind: "ratio", default: 2 } as ParamDef]), ["report.share default must be a number in 0..1"]);
  assert.deepEqual(errorsOf([count("report.a", { default: 5, relations: [{ op: "lt", key: "report.b" }] }), count("report.b", { default: 5 })]), [
    "report.a default 5 violates report.a < report.b (default 5)",
  ]);
  assert.deepEqual(errorsOf([count("report.a", { scope: "run", default: 5, ceiling: "report.b" }), count("report.b", { default: 4 })]), [
    "report.a default 5 violates report.a <= report.b (default 4)",
  ]);
  assert.deepEqual(errorsOf([{ path: "report.mode", kind: "enum", values: ["a", "b"], default: "c", doc: "d", scope: "operator", consumers: ["x"] }]), [
    'report.mode default "c" is not one of its values',
  ]);
  assert.deepEqual(errorsOf([{ path: "report.dir", kind: "path", default: "rel/dir", doc: "d", scope: "operator", consumers: ["x"] }]), [
    'report.dir default must be an absolute path or ""',
  ]);
});

test("definition-time validation: the key name's unit hump agrees with the kind", () => {
  assert.deepEqual(errorsOf([{ ...count("report.timeout"), kind: "ms" } as ParamDef]), ["report.timeout is kind ms but its name lacks the Ms unit"]);
  assert.deepEqual(errorsOf([{ ...count("report.size"), kind: "bytes" } as ParamDef]), ["report.size is kind bytes but its name lacks the Bytes unit"]);
  assert.deepEqual(errorsOf([{ ...count("report.cap"), kind: "micros" } as ParamDef]), ["report.cap is kind micros but its name lacks the Micros unit"]);
  assert.deepEqual(errorsOf([count("report.maxBytes")]), ["report.maxBytes names the Bytes unit but is kind count"]);
  // The unit may sit inside the last segment (maxBytesCeiling) but not in a parent segment.
  assert.deepEqual(errorsOf([{ ...count("report.maxBytesCeiling"), kind: "bytes" } as ParamDef]), []);
  assert.deepEqual(errorsOf([{ ...count("report.waitMs.value"), kind: "ms" } as ParamDef]), ["report.waitMs.value is kind ms but its name lacks the Ms unit"]);
  assert.deepEqual(errorsOf([count("report.maxMsgs")]), [], "Msgs is not the Ms hump");
});

test("definition-time validation: derived and explicit env-name collisions", () => {
  assert.deepEqual(errorsOf([count("report.tlsCAFile"), count("report.tlsCaFile")]), [
    "env name POMTREED_REPORT_TLS_CA_FILE is claimed by both report.tlsCAFile and report.tlsCaFile",
  ]);
  assert.deepEqual(errorsOf([count("report.a", { env: "DOCKER_HOST" }), count("report.b", { env: "DOCKER_HOST" })]), [
    "env name DOCKER_HOST is claimed by both report.a and report.b",
  ]);
  assert.deepEqual(errorsOf([count("report.a", { env: "POMTREED_CONFIG" })]), [
    "env name POMTREED_CONFIG is claimed by both the config file (POMTREED_CONFIG) and report.a",
  ]);
  assert.deepEqual(
    errorsOf([
      { path: "model.key", kind: "string", default: "", sensitive: true, doc: "d", scope: "operator", consumers: ["x"] },
      { path: "model.keyFile", kind: "path", default: "", doc: "d", scope: "operator", consumers: ["x"] },
    ]),
    ["env name POMTREED_MODEL_KEY_FILE is claimed by both model.key (secret file) and model.keyFile"],
  );
});

test("definition-time validation collects every error", () => {
  assert.deepEqual(errorsOf([count("report.a", { consumers: [], doc: "" }), count("report.a")]), [
    "duplicate path report.a",
    "report.a has no doc",
    "report.a declares no consumers",
  ]);
});

test("definition-time validation: the ext. namespace is filled only by extendRegistry, never by a literal table", () => {
  assert.deepEqual(errorsOf([count("ext.github.maxCalls")]), [
    "ext.github.maxCalls is under ext., which only extendRegistry fills with extension-contributed keys",
  ]);
});

test("definition-time validation: checks only on string, list and json kinds, and every default passes its own check", () => {
  assert.deepEqual(errorsOf([count("report.a", { check: () => null })]), ["report.a is kind count; only string, list and json kinds take a check"]);
  const json = (extra: Record<string, unknown>) =>
    ({ path: "state.j", kind: "json", doc: "d", scope: "operator", consumers: ["x"], ...extra }) as unknown as ParamDef;
  assert.deepEqual(errorsOf([json({ default: 5 })]), ["state.j default must be a JSON object or array"]);
  assert.deepEqual(errorsOf([json({ default: {}, check: () => "nope" })]), ["state.j default fails its check: nope"]);
  assert.deepEqual(
    errorsOf([
      json({
        default: [],
        check: () => {
          throw new Error("thrown");
        },
      }),
    ]),
    ["state.j default fails its check: thrown"],
  );
  const str = { path: "model.k", kind: "string", default: "", sensitive: true, check: () => null, doc: "d", scope: "operator", consumers: ["x"] } as ParamDef;
  assert.deepEqual(errorsOf([str]), ["model.k is sensitive, so it takes no check (a refusal would describe the secret)"]);
});

test("the combined registry: unique derived names, and no excluded name is live", () => {
  const live = [...CONFIG_REGISTRY.envOf.values()];
  assert.equal(new Set(live).size, live.length);
  for (const e of CONFIG_ENV_EXCLUSIONS) assert.ok(!CONFIG_REGISTRY.envNames.has(e.name), `${e.name} is excluded, so it is not a live name`);
  for (const p of CONFIG_REGISTRY.params) assert.ok(Object.hasOwn(CONFIG_ENV_PREFIXES, p.path.split(".")[0] as string), p.path);
});

test("definition-time validation: the container flag is refused on sensitive, path and non-integer, non-bool keys", () => {
  const base = { doc: "d", scope: "operator", consumers: ["x"], container: true } as const;
  assert.deepEqual(errorsOf([{ path: "model.k", kind: "string", default: "", sensitive: true, ...base } as ParamDef]), [
    "model.k is sensitive, so it may not be delivered to containers",
  ]);
  assert.deepEqual(errorsOf([{ path: "state.dir", kind: "path", default: "", ...base } as ParamDef]), [
    "state.dir is a host path, so it may not be delivered to containers",
  ]);
  for (const p of [
    { path: "report.name", kind: "string", default: "a" },
    { path: "report.share", kind: "ratio", default: 0.5 },
    { path: "report.mode", kind: "enum", values: ["a"], default: "a" },
    { path: "report.tags", kind: "list", default: [] },
    { path: "report.shape", kind: "json", default: {} },
  ])
    assert.deepEqual(errorsOf([{ ...p, ...base } as unknown as ParamDef]), [
      `${p.path} is kind ${p.kind}; only integer kinds and bool may be delivered to containers`,
    ]);
  assert.deepEqual(errorsOf([count("report.a", { container: false })]), ["report.a container must be true or omitted"]);
  assert.deepEqual(errorsOf([count("report.a", { container: true }), { path: "report.on", kind: "bool", default: true, ...base } as ParamDef]), []);
});

test("the combined registry: the delivered set is exactly the browser capture limits and wait.yieldMs", () => {
  const delivered = (CONFIG_REGISTRY.params as readonly ParamDef[]).filter((p) => p.container === true).map((p) => p.path);
  assert.deepEqual(delivered.sort(), [
    "browser.capture.deadlineMaxMs",
    "browser.capture.deadlineMinMs",
    "browser.capture.maxBytesCeiling",
    "browser.capture.rawAllocationMaxBytes",
    "browser.capture.screenshotMaxBytes",
    "browser.capture.textMaxBytes",
    "wait.yieldMs",
  ]);
});

// The captured-content chain (registry Phase 2), every core edge with both defaults. The digest's own edges (ext.hnDigest.*) are
// declared by its manifest and pinned in examples/hn-digest/params.test.mts. A changed edge or default fails here first.
const CONTENT_EDGES: readonly (readonly [string, string, string, number, number])[] = [
  ["browser.capture.deadlineMinMs", "lt", "browser.capture.deadlineMaxMs", 1000, 120_000],
  ["browser.capture.maxBytesCeiling", "lte", "browser.capture.rawAllocationMaxBytes", 1_048_576, 8_388_608],
  ["browser.capture.maxBytesCeiling", "lte", "report.maxBytes", 1_048_576, 8_388_608],
  ["browser.capture.rawAllocationMaxBytes", "lte", "capacity.containerMemoryBytes", 8_388_608, 2_147_483_648],
  ["browser.capture.screenshotMaxBytes", "lte", "report.maxBytes", 1_048_576, 8_388_608],
  ["browser.capture.textMaxBytes", "lte", "report.maxBytes", 1_048_576, 8_388_608],
  ["report.workflowMaxBytes", "lte", "report.maxBytes", 262_144, 8_388_608],
];

test("the combined registry: the captured-content relation graph, edge by edge at the defaults", () => {
  const byPath = CONFIG_REGISTRY.byPath;
  const contentKeys = new Set(CONTENT_EDGES.map((e) => e[0]));
  for (const [a, op, b, da, db] of CONTENT_EDGES) {
    const p = byPath.get(a) as NumericParam;
    assert.ok(
      p.relations?.some((r) => r.op === op && r.key === b),
      `${a} ${op} ${b} is declared`,
    );
    assert.equal(p.default, da, `${a} default`);
    assert.equal((byPath.get(b) as NumericParam).default, db, `${b} default`);
  }
  // No other relation on those keys, and no core key names an extension key.
  for (const a of contentKeys) {
    const declared = ((byPath.get(a) as NumericParam).relations ?? []).map((r) => `${r.op} ${r.key}`).sort();
    const listed = CONTENT_EDGES.filter((e) => e[0] === a)
      .map((e) => `${e[1]} ${e[2]}`)
      .sort();
    assert.deepEqual(declared, listed, a);
  }
  for (const p of CONFIG_REGISTRY.params as readonly ParamDef[]) {
    const refs = [...("relations" in p ? (p.relations ?? []).map((r) => r.key) : []), ...("ceiling" in p && p.ceiling ? [p.ceiling] : [])];
    for (const r of refs) assert.ok(!r.startsWith("ext."), `${p.path} references extension key ${r}`);
  }
});

test("the Pi auth path is gone from the registry: pi.auth is not a parameter and no POMTREED_PI_AUTH is derived", () => {
  assert.equal(CONFIG_REGISTRY.byPath.has("pi.auth"), false);
  assert.equal(CONFIG_REGISTRY.envNames.has("POMTREED_PI_AUTH"), false);
});
