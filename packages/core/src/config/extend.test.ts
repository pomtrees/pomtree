import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_REGISTRY,
  ConfigRegistryError,
  buildRegistry,
  configJsonSchema,
  containerContract,
  defineRegistry,
  describeConfig,
  extendRegistry,
  extensionCredentialEnv,
  extensionSegment,
  parseExtensionParams,
  resolveConfig,
} from "../index.ts";
import type { ConfigRegistry, ExtParamDecl, ExtensionConfigDecl, ParamDef, ResolveInput } from "../index.ts";

// The fixture extension: a digest-like one whose keys relate to core keys (report.maxBytes) and to each other.
const DIGEST: ExtensionConfigDecl = {
  name: "hn-digest",
  credentials: ["api_token"],
  params: [
    {
      key: "articleCaptureBytes",
      kind: "bytes",
      doc: "Bytes captured per article.",
      default: 262144,
      min: 1,
      ceiling: "articleAuditBytes",
    },
    { key: "articleAuditBytes", kind: "bytes", doc: "Largest audited body.", default: 2097152, min: 1, relations: [{ op: "lte", key: "report.maxBytes" }] },
    { key: "mode", kind: "enum", doc: "Mode.", values: ["fast", "safe"], default: "safe" },
    { key: "enabled", kind: "bool", doc: "On.", default: true },
    { key: "label", kind: "string", doc: "A label.", default: "x" },
    { key: "hosts", kind: "list", doc: "Hosts.", default: [] },
  ] as ExtParamDecl[],
};

const compose = (...parts: ExtensionConfigDecl[]): ConfigRegistry => extendRegistry(CONFIG_REGISTRY, parts);
const refusal = (f: () => unknown): readonly string[] => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof ConfigRegistryError, String(e));
    return e.errors;
  }
  assert.fail("expected a ConfigRegistryError");
};
const resolve = (r: ConfigRegistry, input: ResolveInput) => resolveConfig(r, { ...input, env: { POMTREED_MODEL_UPSTREAM_KEY_FILE: undefined, ...input.env } });
const errorsOf = (r: ConfigRegistry, input: ResolveInput): string[] => {
  const out = resolve(r, input);
  assert.ok(!out.ok, "expected a refusal");
  return out.errors;
};
const REG = compose(DIGEST);
const KEY = "ext.hnDigest.articleCaptureBytes";
const ENV = "POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTES";
const ACTION = "; remove it, or use a name listed in docs/configuration.md";

test("naming: the segment is the camelCase of the name; credential env names follow POMTREED_EXT_<NAME>_<CRED>", () => {
  assert.equal(extensionSegment("hn-digest"), "hnDigest");
  assert.equal(extensionSegment("my_ext"), "myExt");
  assert.equal(extensionSegment("github"), "github");
  assert.equal(extensionSegment("1pass"), null, "a segment must start with a lowercase letter");
  assert.equal(extensionCredentialEnv("hn-digest", "api_token"), "POMTREED_EXT_HN_DIGEST_API_TOKEN");
  assert.equal(REG.envOf.get(KEY), ENV, "keys derive through the same deriveEnvName as core keys");
});

test("an extension that declares no params and no credentials owns no config: its name needs no segment and may share one", () => {
  const none = (name: string): ExtensionConfigDecl => ({ name, params: [] });
  const r = compose(none("9lives"), none("my-ext"), none("my_ext"), DIGEST);
  assert.deepEqual(
    r.extensions.map((e) => e.name),
    ["hn-digest"],
  );
  // A config-owning extension still needs a segment, and still may not share one.
  const withKey: ExtParamDecl[] = [{ key: "n", kind: "count", doc: "N.", default: 1 }];
  assert.match(refusal(() => compose({ name: "9lives", params: withKey }))[0] as string, /^extension 9lives: name has no config segment/);
  assert.match(refusal(() => compose({ name: "9lives", params: [], credentials: ["tok"] }))[0] as string, /^extension 9lives: name has no config segment/);
  assert.match(
    refusal(() => compose({ name: "my-ext", params: withKey }, { name: "my_ext", params: [], credentials: ["tok"] }))[0] as string,
    /^extension my_ext: config segment ext\.myExt\. collides with extension my-ext/,
  );
  const ok = compose({ name: "my-ext", params: withKey }, none("my_ext"));
  assert.deepEqual(
    ok.extensions.map((e) => e.name),
    ["my-ext"],
  );
});

test("credential env names use the same prefix as key env names, digits included", () => {
  assert.equal(extensionCredentialEnv("a-1b", "tok"), "POMTREED_EXT_A1B_TOK");
  assert.equal(extensionCredentialEnv("a-b-1", "tok"), "POMTREED_EXT_A_B1_TOK");
  for (const name of ["a-1b", "a-b-1", "hn-digest", "my_ext", "github"]) {
    const r = compose({ name, params: [{ key: "n", kind: "count", doc: "N.", default: 1 }] as ExtParamDecl[], credentials: ["tok"] });
    const keyEnv = r.envOf.get(`ext.${extensionSegment(name)}.n`) as string;
    assert.equal(extensionCredentialEnv(name, "tok"), `${keyEnv.slice(0, -"N".length)}TOK`, name);
  }
  // A mis-attributed hint would name the wrong extension: the credential prefix of `a-1b` must not capture `a-1`'s keys.
  const r = compose(
    { name: "a-1b", params: [], credentials: ["tok"] },
    { name: "a", params: [{ key: "one", kind: "count", doc: "N.", default: 1 }] as ExtParamDecl[] },
  );
  const msg = errorsOf(r, { env: { POMTREED_EXT_A1B_TOKK: "x" } })[0] as string;
  assert.match(msg, /extension a-1b declares no such key or credential \(did you mean POMTREED_EXT_A1B_TOK\?\)/);
});

test("composition: keys are ext.<segment>.<key>, operator-scoped, consumed by the extension, never delivered to containers", () => {
  const p = REG.byPath.get(KEY) as ParamDef;
  assert.equal(p.scope, "operator");
  assert.deepEqual(p.consumers, ["hn-digest"]);
  assert.equal(p.container, undefined);
  assert.deepEqual(REG.extensions, [
    { name: "hn-digest", segment: "hnDigest", credentials: ["api_token"], paths: DIGEST.params.map((d) => `ext.hnDigest.${d.key}`) },
  ]);
  assert.ok(REG.envNames.has("POMTREED_EXT_HN_DIGEST_API_TOKEN"), "a declared credential owns its env name");
  assert.equal(REG.params.length, CONFIG_REGISTRY.params.length + DIGEST.params.length);
  assert.equal(containerContract(REG), containerContract(CONFIG_REGISTRY), "the container contract is static");
});

test("composition with no extensions is the core registry's table", () => {
  const r = compose();
  assert.equal(r.params.length, CONFIG_REGISTRY.params.length);
  assert.deepEqual(r.extensions, []);
});

test("resolution: default < file < env < --set, with origins, over the composed registry", () => {
  const dflt = resolve(REG, { env: {} });
  assert.ok(dflt.ok);
  assert.equal(dflt.values[KEY], 262144);
  assert.equal(dflt.origins[KEY], "default");
  const file = { ext: { hnDigest: { articleCaptureBytes: 100, mode: "fast" } } };
  const f = resolve(REG, { env: {}, file });
  assert.ok(f.ok && f.values[KEY] === 100 && f.origins[KEY] === "file" && f.values["ext.hnDigest.mode"] === "fast");
  const e = resolve(REG, { env: { [ENV]: "200" }, file });
  assert.ok(e.ok && e.values[KEY] === 200 && e.origins[KEY] === `env:${ENV}`);
  const s = resolve(REG, { env: { [ENV]: "200" }, file, set: [`${KEY}=300`] });
  assert.ok(s.ok && s.values[KEY] === 300 && s.origins[KEY] === "set");
  assert.ok(s.ok && s.values["ext.hnDigest.mode"] === "fast", "an untouched key keeps the file value");
});

test("bad values name the key and its origin and fail closed", () => {
  assert.deepEqual(errorsOf(REG, { env: { [ENV]: "12x" } }), [`${KEY}="12x" (env:${ENV}): expected a non-negative integer of bytes`]);
  assert.deepEqual(errorsOf(REG, { env: {}, set: ["ext.hnDigest.mode=slow"] }), ['ext.hnDigest.mode="slow" (set): expected one of fast, safe']);
  assert.deepEqual(errorsOf(REG, { env: {}, file: { ext: { hnDigest: { enabled: "yes" } } } }), ['ext.hnDigest.enabled="yes" (file): expected a boolean']);
});

test("ceilings and relations resolve over the merged table: own key, core key, uniform error format", () => {
  const own = errorsOf(REG, { env: {}, set: [`${KEY}=3000000`] });
  assert.deepEqual(own, [`${KEY}=3000000 (set) exceeds its ceiling ext.hnDigest.articleAuditBytes=2097152 (default); refused, not clamped`]);
  const core = errorsOf(REG, { env: {}, set: ["report.maxBytes=1000"] });
  assert.ok(
    core.some((m) => m === "ext.hnDigest.articleAuditBytes=2097152 (default) must be <= report.maxBytes=1000 (set)"),
    core.join("\n"),
  );
});

test("a relation to a core key whose default is violated is refused at composition, naming the extension and key", () => {
  const bad: ExtensionConfigDecl = {
    name: "greedy",
    params: [{ key: "bigBytes", kind: "bytes", doc: "d", default: 2 ** 40, relations: [{ op: "lte", key: "report.maxBytes" }] }] as ExtParamDecl[],
  };
  assert.deepEqual(
    refusal(() => compose(bad)),
    [`extension greedy: ext.greedy.bigBytes default ${2 ** 40} violates ext.greedy.bigBytes <= report.maxBytes (default 8388608)`],
  );
});

test("references: another extension's keys and ext paths are refused; unknown own keys are named", () => {
  const other: ExtensionConfigDecl = { name: "other", params: [{ key: "xBytes", kind: "bytes", doc: "d", default: 1 }] as ExtParamDecl[] };
  const peer = (ref: string): ExtensionConfigDecl => ({
    name: "peer",
    params: [{ key: "yBytes", kind: "bytes", doc: "d", default: 1, ceiling: ref }] as ExtParamDecl[],
  });
  const cross = refusal(() => compose(other, peer("ext.other.xBytes")));
  assert.ok(
    cross.some((m) => m.startsWith('extension peer: ext.peer.yBytes ceiling "ext.other.xBytes": name core keys by path')),
    cross.join("\n"),
  );
  const unknown = refusal(() => compose(peer("nopeBytes")));
  assert.deepEqual(unknown, ["extension peer: ext.peer.yBytes ceiling names unknown key ext.peer.nopeBytes"]);
  // Defense in depth below the declaration layer: a hand-built table with a cross-extension edge is refused too.
  const defs = [
    { path: "ext.a.xBytes", kind: "bytes", default: 1, doc: "d", scope: "operator", consumers: ["a"] },
    { path: "ext.b.yBytes", kind: "bytes", default: 1, doc: "d", scope: "operator", consumers: ["b"], relations: [{ op: "lte", key: "ext.a.xBytes" }] },
  ] as ParamDef[];
  const built = refusal(() =>
    buildRegistry(
      defs,
      { ext: "POMTREED_" },
      {
        extOf: new Map([
          ["ext.a.xBytes", "a"],
          ["ext.b.yBytes", "b"],
        ]),
        extensions: [
          { name: "a", segment: "a", credentials: [] },
          { name: "b", segment: "b", credentials: [] },
        ],
      },
    ),
  );
  assert.deepEqual(built, [
    "extension b: ext.b.yBytes lte ext.a.xBytes: relates to a key of extension a; extensions may relate only to core keys and their own",
  ]);
});

test("core may never reference an extension key", () => {
  const core = { doc: "d", scope: "operator", consumers: ["x"] } as const;
  const viaDefine = refusal(() =>
    defineRegistry([{ ...core, path: "report.aBytes", kind: "bytes", default: 1, relations: [{ op: "lte", key: "ext.foo.bar" }] } as ParamDef]),
  );
  assert.deepEqual(viaDefine, ["report.aBytes lte ext.foo.bar: core keys may not reference extension keys"]);
  const defs = [
    { ...core, path: "report.aBytes", kind: "bytes", default: 1, relations: [{ op: "lte", key: "ext.foo.barBytes" }] },
    { ...core, path: "ext.foo.barBytes", kind: "bytes", default: 1, consumers: ["foo"] },
  ] as ParamDef[];
  const built = refusal(() =>
    buildRegistry(
      defs,
      { report: "POMTREED_", ext: "POMTREED_" },
      { extOf: new Map([["ext.foo.barBytes", "foo"]]), extensions: [{ name: "foo", segment: "foo", credentials: [] }] },
    ),
  );
  assert.deepEqual(built, ["report.aBytes lte ext.foo.barBytes: core keys may not reference extension keys"]);
});

test("a literal ext. key in a core table is refused", () => {
  assert.deepEqual(
    refusal(() => defineRegistry([{ path: "ext.x.yBytes", kind: "bytes", default: 1, doc: "d", scope: "operator", consumers: ["x"] }])),
    ["ext.x.yBytes is under ext., which only extendRegistry fills with extension-contributed keys"],
  );
});

test("segment, name and registry-level collisions are refused", () => {
  // Each owns config (a credential), since an extension declaring nothing owns no segment (see the test above).
  const e = (name: string): ExtensionConfigDecl => ({ name, params: [], credentials: ["tok"] });
  assert.deepEqual(
    refusal(() => compose(e("my-ext"), e("my_ext"))),
    ["extension my_ext: config segment ext.myExt. collides with extension my-ext; rename one of them"],
  );
  assert.deepEqual(
    refusal(() => compose(e("a"), e("a"))),
    ["extension a: declared twice (two extension directories carry this manifest name)"],
  );
  assert.deepEqual(
    refusal(() => compose(e("9lives"))),
    ["extension 9lives: name has no config segment (it must start with a lowercase letter to own ext.<name>. keys)"],
  );
  assert.deepEqual(
    refusal(() => extendRegistry(REG, [e("again")])),
    ["the registry is already extended; compose all extensions in one extendRegistry call"],
  );
  // Different names, same derived env name: ext "a" key "bC" and ext "a-b" key "c" both derive POMTREED_EXT_A_B_C.
  const k = (key: string): ExtParamDecl[] => [{ key, kind: "count", doc: "d", default: 1 }] as ExtParamDecl[];
  const envs = refusal(() => compose({ name: "a", params: k("bC") }, { name: "a-b", params: k("c") }));
  assert.deepEqual(envs, ["env name POMTREED_EXT_A_B_C is claimed by both ext.a.bC (extension a) and ext.aB.c (extension a-b)"]);
});

test("a key may not collide with a declared credential's env name; undeclared credential names stay free", () => {
  const clash: ExtensionConfigDecl = {
    name: "foo",
    credentials: ["bar_baz"],
    params: [{ key: "barBaz", kind: "count", doc: "d", default: 1 }] as ExtParamDecl[],
  };
  assert.deepEqual(
    refusal(() => compose(clash)),
    ["env name POMTREED_EXT_FOO_BAR_BAZ is claimed by both ext.foo.barBaz (extension foo) and extension foo credential bar_baz"],
  );
  assert.ok(compose({ ...clash, credentials: ["other"] }).envNames.has("POMTREED_EXT_FOO_OTHER"));
  assert.deepEqual(
    refusal(() => compose({ name: "foo", credentials: ["../etc"], params: [] })),
    ['extension foo: credential "../etc" is not a valid name'],
  );
});

test("declaration errors name the extension and the key: unit humps, bad defaults, flat keys", () => {
  const one = (d: Record<string, unknown>) => compose({ name: "foo", params: [d] as unknown as ExtParamDecl[] });
  assert.deepEqual(
    refusal(() => one({ key: "size", kind: "bytes", doc: "d", default: 1 })),
    ["extension foo: ext.foo.size is kind bytes but its name lacks the Bytes unit"],
  );
  assert.deepEqual(
    refusal(() => one({ key: "sizeBytes", kind: "bytes", doc: "d", default: -1 })),
    ["extension foo: ext.foo.sizeBytes default must be a non-negative integer"],
  );
  assert.deepEqual(
    refusal(() => one({ key: "a.b", kind: "count", doc: "d", default: 1 })),
    ["extension foo: ext.foo.a.b must be ext.foo.<key> with a flat lowerCamel key"],
  );
  assert.deepEqual(
    refusal(() => one({ key: "n", kind: "count", doc: " ", default: 1 })),
    ["extension foo: ext.foo.n has no doc"],
  );
});

test("the manifest declaration subset: forbidden and unknown fields, kinds and shapes are refused with the extension and key", () => {
  const parse = (raw: unknown) => parseExtensionParams("foo", raw);
  const ok = parse([{ key: "sizeBytes", kind: "bytes", doc: "d", default: 1, min: 1 }]);
  assert.ok(ok.ok);
  const errors = (raw: unknown): string[] => {
    const r = parse(raw);
    assert.ok(!r.ok);
    return r.errors;
  };
  assert.deepEqual(errors({}), ["extension foo: params must be an array"]);
  assert.deepEqual(errors([1]), ["extension foo: params[0]: must be an object"]);
  assert.deepEqual(errors([{ key: "k", kind: "path", doc: "d", default: "" }]), [
    "extension foo: params[0] (k): kind must be one of bytes, count, ms, micros, ratio, bool, enum, string, list (path and json keys are not supported in manifests)",
  ]);
  assert.deepEqual(errors([{ key: "k", kind: "count", doc: "d", default: 1, container: true }]), [
    "extension foo: params[0] (k): container is not allowed in a manifest: extension keys are host-side only and never delivered to containers",
  ]);
  assert.match(
    errors([{ key: "k", kind: "string", doc: "d", default: "", sensitive: true }])[0] as string,
    /sensitive is not allowed in a manifest: secrets go through manifest credentials/,
  );
  assert.match(
    errors([{ key: "k", kind: "string", doc: "d", default: "", check: "fn" }])[0] as string,
    /check is not allowed in a manifest: a manifest is JSON/,
  );
  assert.match(errors([{ key: "k", kind: "count", doc: "d", default: 1, env: "X" }])[0] as string, /env is not allowed/);
  assert.match(errors([{ key: "k", kind: "count", doc: "d", default: 1, scope: "run" }])[0] as string, /scope is not allowed/);
  assert.deepEqual(errors([{ key: "k", kind: "count", doc: "d", default: 1, typo: 1 }]), ['extension foo: params[0] (k): unknown field "typo" for kind count']);
  assert.deepEqual(errors([{ key: "k", kind: "bool", doc: "d", default: true, min: 1 }]), ['extension foo: params[0] (k): unknown field "min" for kind bool']);
  assert.deepEqual(errors([{ key: "k", kind: "count", doc: "d" }]), ["extension foo: params[0] (k): default is required"]);
  assert.deepEqual(errors([{ key: "k", kind: "enum", doc: "d", default: "a" }]), ["extension foo: params[0] (k): values must be an array of strings"]);
  assert.match(errors([{ key: "k", kind: "count", doc: "d", default: 1, relations: [{ op: "eq", key: "x" }] }])[0] as string, /relations must be an array/);
});

test("a manifest key carrying renamedFrom is refused as an unknown field naming the key; an old env name is an unknown env", () => {
  const parse = parseExtensionParams("foo", [{ key: "k", kind: "count", doc: "d", default: 1, renamedFrom: ["POMTREED_OLD_K"] }]);
  assert.deepEqual(parse.ok ? [] : parse.errors, ['extension foo: params[0] (k): unknown field "renamedFrom" for kind count']);
  const old = errorsOf(REG, { env: { POMTREED_DIGEST_OLD_CAPTURE_BYTES: "1" } });
  assert.deepEqual(old, [`unknown env POMTREED_DIGEST_OLD_CAPTURE_BYTES${ACTION}`]);
});

test("env under a loaded extension: undeclared names are refused with a hint; declared keys and credentials are accepted", () => {
  const typo = errorsOf(REG, { env: { POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTE: "1" } });
  assert.deepEqual(typo, [
    `unknown env POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTE: extension hn-digest declares no such key or credential (did you mean ${ENV}?)${ACTION}`,
  ]);
  const cred = errorsOf(REG, { env: { POMTREED_EXT_HN_DIGEST_OTHER_TOKEN: "t" } });
  assert.match(cred[0] as string, /^unknown env POMTREED_EXT_HN_DIGEST_OTHER_TOKEN: extension hn-digest declares no such key or credential/);
  assert.ok(resolve(REG, { env: { POMTREED_EXT_HN_DIGEST_API_TOKEN: "t" } }).ok, "a declared credential is recognized, not read, by the resolver");
});

test("env of an extension that is not loaded is refused, and names which are", () => {
  const out = errorsOf(REG, { env: { POMTREED_EXT_GITHUB_TOKEN: "t" } });
  assert.deepEqual(out, [
    `unknown env POMTREED_EXT_GITHUB_TOKEN: it names no loaded extension (loaded: hn-digest); extension env names are valid only while the extension is loaded${ACTION}`,
  ]);
});

test("file and --set keys of an unloaded extension, or undeclared under a loaded one, are refused", () => {
  assert.deepEqual(errorsOf(REG, { env: {}, file: { ext: { github: { maxCalls: 1 } } } }), [
    "config file: unknown key ext.github: no loaded extension owns ext.github. (loaded: hn-digest); an extension's keys are valid only while it is loaded",
  ]);
  assert.deepEqual(errorsOf(REG, { env: {}, set: ["ext.github.maxCalls=1"] }), [
    "--set: unknown key ext.github.maxCalls: no loaded extension owns ext.github. (loaded: hn-digest); an extension's keys are valid only while it is loaded",
  ]);
  assert.deepEqual(errorsOf(REG, { env: {}, file: { ext: { hnDigest: { articleCaptureByte: 1 } } } }), [
    "config file: unknown key ext.hnDigest.articleCaptureByte: extension hn-digest declares no such key (did you mean ext.hnDigest.articleCaptureBytes?)",
  ]);
  assert.deepEqual(errorsOf(CONFIG_REGISTRY as ConfigRegistry, { env: {}, file: { ext: { hnDigest: {} } } }), [
    "config file: unknown key ext.hnDigest: no loaded extension owns ext.hnDigest. (loaded: none); an extension's keys are valid only while it is loaded",
  ]);
  assert.deepEqual(errorsOf(REG, { env: {}, file: { ext: 3 } }), ["config file: ext must be an object"]);
});

test("describeConfig lists extension keys with origins in registry order, after the core keys", () => {
  const r = resolve(REG, { env: { [ENV]: "5" } });
  assert.ok(r.ok);
  const rows = describeConfig(REG, r);
  assert.deepEqual(
    rows.slice(-DIGEST.params.length).map((x) => x.path),
    DIGEST.params.map((d) => `ext.hnDigest.${d.key}`),
  );
  const row = rows.find((x) => x.path === KEY);
  assert.equal(row?.origin, `env:${ENV}`);
  assert.equal(row?.env, ENV);
  assert.equal(row?.ceiling, "ext.hnDigest.articleAuditBytes");
});

test("a schema generated from the composed registry carries the exact ext subtree", () => {
  const schema = configJsonSchema(REG) as {
    properties: Record<string, { properties?: Record<string, { additionalProperties?: boolean; properties: Record<string, unknown> }> }>;
  };
  const digest = schema.properties.ext?.properties?.hnDigest;
  assert.equal(digest?.additionalProperties, false);
  assert.deepEqual(
    Object.keys(digest?.properties ?? {}),
    DIGEST.params.map((d) => d.key),
  );
});
