import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  CONTAINER_CONFIG_ENV,
  CONTAINER_CONFIG_MAX_BYTES,
  ContainerConfigError,
  IMAGE_FACTS,
  canonicalContainerDoc,
  configEnvIgnore,
  containerConfigDoc,
  containerConfigEnv,
  containerConfigValues,
  containerContract,
  containerParams,
  containerReadSpec,
  defineRegistry,
  isExcludedEnv,
  readContainerDoc,
  resolveConfig,
} from "../index.ts";
import type { ContainerReadSpec, ParamDef } from "../index.ts";

const SPEC = containerReadSpec(CONFIG_REGISTRY);
const DOC = containerConfigDoc(CONFIG_REGISTRY, CONFIG_DEFAULTS);
const parsed = (): { contract: string; values: Record<string, unknown> } => JSON.parse(DOC);
const read = (raw: string | undefined, spec: ContainerReadSpec = SPEC, required = true) => readContainerDoc(raw, spec, { required });
const refuses = (raw: string | undefined, pattern: RegExp, spec: ContainerReadSpec = SPEC) =>
  assert.throws(
    () => read(raw, spec),
    (e: unknown) => e instanceof ContainerConfigError && e.message.startsWith(`${CONTAINER_CONFIG_ENV}: `) && pattern.test(e.message),
  );
// A document with one change, re-encoded canonically (so only the change is under test).
const withValues = (patch: Record<string, unknown>, drop: readonly string[] = []): string => {
  const d = parsed();
  const values: Record<string, unknown> = { ...d.values, ...patch };
  for (const k of drop) delete values[k];
  return canonicalContainerDoc(d.contract, values as Record<string, number | boolean>);
};

test("the producer writes the canonical document: the contract and exactly the delivered keys, sorted", () => {
  const d = parsed();
  assert.match(d.contract, /^[0-9a-f]{16}$/);
  assert.equal(d.contract, containerContract(CONFIG_REGISTRY));
  assert.deepEqual(Object.keys(d.values), [
    "browser.capture.deadlineMaxMs",
    "browser.capture.deadlineMinMs",
    "browser.capture.maxBytesCeiling",
    "browser.capture.rawAllocationMaxBytes",
    "browser.capture.screenshotMaxBytes",
    "browser.capture.textMaxBytes",
    "wait.yieldMs",
  ]);
  assert.deepEqual(containerConfigEnv(CONFIG_REGISTRY, CONFIG_DEFAULTS), { PTREE_CONFIG_JSON: DOC });
  assert.ok(Buffer.byteLength(DOC) < 1024, "about 0.3 KiB today, far under the 16 KiB cap");
  assert.deepEqual(containerConfigValues(CONFIG_REGISTRY, CONFIG_DEFAULTS), d.values);
  assert.ok(Object.isFrozen(containerConfigValues(CONFIG_REGISTRY, CONFIG_DEFAULTS)));
});

test("round trip over the real registry: resolve with env overrides, produce, read back the same values, frozen", () => {
  const r = resolveConfig(CONFIG_REGISTRY, {
    env: { POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "4096", POMTREED_BROWSER_CAPTURE_SCREENSHOT_MAX_BYTES: "524288", POMTREED_WAIT_YIELD_MS: "5000" },
  });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  const env = containerConfigEnv(CONFIG_REGISTRY, r.values);
  const got = read(env[CONTAINER_CONFIG_ENV]);
  assert.ok(Object.isFrozen(got));
  assert.equal(got["browser.capture.textMaxBytes"], 4096);
  assert.equal(got["browser.capture.screenshotMaxBytes"], 524_288);
  assert.equal(got["wait.yieldMs"], 5000);
  assert.deepEqual(got, containerConfigValues(CONFIG_REGISTRY, r.values));
});

test("a secret is never delivered: no sensitive value reaches the document", () => {
  const r = resolveConfig(CONFIG_REGISTRY, { env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: "/run/secrets/k" }, readFile: () => "sk-never-in-a-container" });
  assert.ok(r.ok);
  const doc = containerConfigDoc(CONFIG_REGISTRY, r.values);
  assert.ok(!doc.includes("sk-never"));
  assert.ok(!doc.includes("upstreamKey"));
  assert.equal(doc, DOC);
});

test("absent: required refuses; not required yields the defaults, frozen", () => {
  refuses(undefined, /not set; this process requires the resolved config document from the controller/);
  const d = read(undefined, SPEC, false);
  assert.ok(Object.isFrozen(d));
  assert.deepEqual(d, parsed().values);
});

test("the reader refuses a malformed document", () => {
  refuses("", /not valid JSON/);
  refuses("{", /not valid JSON/);
  refuses("[]", /not a JSON object/);
  refuses("null", /not a JSON object/);
  refuses(JSON.stringify({ contract: parsed().contract }), /expected exactly the keys contract and values, got contract/);
  refuses(JSON.stringify({ ...parsed(), extra: 1 }), /expected exactly the keys contract and values, got contract, extra, values/);
  refuses(JSON.stringify({ contract: parsed().contract, values: [] }), /values must be a JSON object/);
  refuses(JSON.stringify({ contract: "ABCDEF0123456789", values: parsed().values }), /contract must be 16 lowercase hex digits/);
});

test("the reader refuses a tampered or foreign contract digest with the rebuild hint", () => {
  const d = parsed();
  refuses(
    canonicalContainerDoc("0000000000000000", d.values as Record<string, number>),
    /agent image contract [0-9a-f]{16} does not match daemon contract 0000000000000000: .*rebuild the image/,
  );
});

test("the reader refuses missing, extra and wrongly typed keys", () => {
  refuses(withValues({}, ["wait.yieldMs"]), /missing key wait\.yieldMs/);
  refuses(withValues({ "browser.capture.extra": 1 }), /unknown key "browser\.capture\.extra"/);
  refuses(withValues({ "model.upstreamKey": "sk" }), /unknown key "model\.upstreamKey"/);
  refuses(withValues({ "wait.yieldMs": "20000" }), /wait\.yieldMs must be a non-negative integer/);
  refuses(withValues({ "wait.yieldMs": 1.5 }), /wait\.yieldMs must be a non-negative integer/);
  refuses(withValues({ "wait.yieldMs": -1 }), /wait\.yieldMs must be a non-negative integer/);
  refuses(withValues({ "wait.yieldMs": true }), /wait\.yieldMs must be a non-negative integer/);
  refuses(withValues({ "wait.yieldMs": 2 ** 53 }), /wait\.yieldMs must be a non-negative integer/);
  refuses(withValues({ "wait.yieldMs": null }), /wait\.yieldMs must be a non-negative integer/);
});

test("the reader refuses out-of-range values and a broken relation among delivered keys", () => {
  refuses(withValues({ "browser.capture.textMaxBytes": 0 }), /browser\.capture\.textMaxBytes=0 is below its minimum 1/);
  refuses(withValues({ "browser.capture.deadlineMinMs": 120_000 }), /browser\.capture\.deadlineMinMs=120000 must be < browser\.capture\.deadlineMaxMs=120000/);
  refuses(
    withValues({ "browser.capture.maxBytesCeiling": 9 * 1024 * 1024 }),
    /browser\.capture\.maxBytesCeiling=9437184 must be <= browser\.capture\.rawAllocationMaxBytes=8388608/,
  );
});

test("the reader refuses a non-canonical encoding: whitespace, key order and duplicate keys", () => {
  refuses(JSON.stringify(parsed(), null, 1), /not in canonical form/);
  const d = parsed();
  refuses(JSON.stringify({ values: d.values, contract: d.contract }), /not in canonical form/);
  refuses(DOC.replace('"wait.yieldMs":20000', '"wait.yieldMs":1,"wait.yieldMs":20000'), /not in canonical form/);
  refuses(DOC.replace('"wait.yieldMs":20000', '"wait.yieldMs":2e4'), /not in canonical form/);
});

test("the reader and the producer refuse a document over the cap", () => {
  const huge = `${DOC.slice(0, -2)}${" ".repeat(CONTAINER_CONFIG_MAX_BYTES)}}}`;
  refuses(huge, /bytes exceeds the 16384-byte cap/);
  const many = Array.from({ length: 600 }, (_, i) => ({
    path: `browser.capture.limit${String(i).padStart(4, "0")}LongerNameToFillTheDocumentMs`,
    kind: "ms",
    default: 1_000_000_000,
    doc: "d",
    scope: "operator",
    consumers: ["x"],
    container: true,
  })) as ParamDef[];
  const big = defineRegistry(many);
  const values = Object.fromEntries(many.map((p) => [p.path, p.default]));
  assert.throws(() => containerConfigDoc(big, values), /exceeds the 16384-byte cap/);
});

test("the producer refuses a missing key or a value the image would refuse", () => {
  const { "wait.yieldMs": _drop, ...rest } = CONFIG_DEFAULTS;
  assert.throws(() => containerConfigDoc(CONFIG_REGISTRY, rest), /container config: missing value for wait\.yieldMs/);
  assert.throws(() => containerConfigValues(CONFIG_REGISTRY, rest), /container config: missing value for wait\.yieldMs/);
  assert.throws(() => containerConfigDoc(CONFIG_REGISTRY, { ...CONFIG_DEFAULTS, "browser.capture.textMaxBytes": 0 }), /below its minimum 1/);
});

test("only delivered-to-delivered edges ship; host-only edges stay with the resolver", () => {
  const byPath = new Map(containerParams(CONFIG_REGISTRY).map((p) => [p.path, p]));
  assert.deepEqual(byPath.get("browser.capture.maxBytesCeiling")?.relations, [{ op: "lte", key: "browser.capture.rawAllocationMaxBytes" }]);
  assert.equal(
    byPath.get("browser.capture.textMaxBytes")?.relations,
    undefined,
    "its edge targets report.maxBytes (the digest's edge to it is declared by the extension)",
  );
  assert.equal(byPath.get("browser.capture.rawAllocationMaxBytes")?.relations, undefined, "its edge targets capacity.containerMemoryBytes");
});

// A copy of the delivered part of the registry for digest tests: two delivered keys and one host key.
const mini = (patch: { a?: Partial<ParamDef>; b?: Partial<ParamDef>; extra?: boolean } = {}) =>
  defineRegistry([
    { path: "browser.capture.aMs", kind: "ms", default: 10, min: 1, doc: "d", scope: "operator", consumers: ["x"], container: true, ...patch.a } as ParamDef,
    {
      path: "wait.bMs",
      kind: "ms",
      default: 20,
      doc: "d",
      scope: "operator",
      consumers: ["x"],
      ...(patch.extra ? { container: true } : {}),
      ...patch.b,
    } as ParamDef,
  ]);

test("the contract digest changes with a bound or the delivered key set, not with a default or a host-only key", () => {
  const base = containerContract(mini());
  assert.equal(containerContract(mini({ a: { default: 11 } })), base, "a default is not part of the contract");
  assert.equal(containerContract(mini({ b: { default: 30, min: 5 } })), base, "a host-only key is not part of the contract");
  assert.notEqual(containerContract(mini({ a: { max: 100 } })), base, "a bound is");
  assert.notEqual(containerContract(mini({ a: { min: 2 } })), base, "a bound is");
  assert.notEqual(containerContract(mini({ extra: true })), base, "the delivered key set is");
  assert.notEqual(containerContract(mini({ a: { kind: "count", path: "browser.capture.aCount" } as Partial<ParamDef> })), base, "a kind (and path) is");
  assert.equal(containerContract(mini(), IMAGE_FACTS), base);
  assert.notEqual(containerContract(mini(), { ...IMAGE_FACTS, CDP_PORT: 9223 }), base, "an image fact is");
});

test("a document produced against looser bounds is refused by an image built with the operator's tighter ones", () => {
  // The daemon side had max 100 (looser); the image was built with max 50. The bound change changed the digest, so the image
  // refuses on the contract before it could accept a value its own bound forbids.
  const loose = mini({ a: { max: 100 } });
  const tight = mini({ a: { max: 50 } });
  const doc = containerConfigDoc(loose, { "browser.capture.aMs": 80 });
  refuses(doc, /does not match daemon contract/, containerReadSpec(tight));
  // Same contract, value over the image's bound: refused by the bound itself.
  const forged = canonicalContainerDoc(containerContract(tight), { "browser.capture.aMs": 80 });
  refuses(forged, /browser\.capture\.aMs=80 is above its maximum 50/, containerReadSpec(tight));
});

test("PTREE_CONFIG_JSON is an excluded, runtime-injected name, and host resolvers pass it through", () => {
  assert.equal(isExcludedEnv(CONTAINER_CONFIG_ENV)?.reason, "runtime-injected");
  assert.ok(resolveConfig(CONFIG_REGISTRY, { env: { [CONTAINER_CONFIG_ENV]: DOC }, ...configEnvIgnore() }).ok);
});

test("CONFIG_DEFAULTS is frozen and carries every registry default", () => {
  assert.ok(Object.isFrozen(CONFIG_DEFAULTS));
  for (const p of CONFIG_REGISTRY.params) assert.deepEqual((CONFIG_DEFAULTS as Record<string, unknown>)[p.path], p.default, p.path);
  assert.equal(CONFIG_DEFAULTS["wait.yieldMs"], 20_000);
});
