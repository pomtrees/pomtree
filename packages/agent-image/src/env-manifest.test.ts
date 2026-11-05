import test from "node:test";
import assert from "node:assert/strict";
import {
  ENV_LAYER_PATH,
  ENV_PARENT_PATH,
  cacheKey,
  emptyManifest,
  extend,
  hashManifest,
  mountPlan,
  normalize,
  parseSpec,
  registryAllowlist,
  type EnvManifest,
} from "./index.ts";

const base: EnvManifest = {
  ecosystems: { npm: { specs: ["left-pad@1.3.0", "@scope/pkg@2.0.0"] }, pip: { specs: ["requests==2.32.3"], lockfileHash: "abc" } },
};

test("parseSpec accepts pinned specs and rejects ranges and bare names", () => {
  assert.deepEqual(parseSpec("npm", "@scope/pkg@2.0.0"), { name: "@scope/pkg", version: "2.0.0" });
  assert.deepEqual(parseSpec("pip", "requests==2.32.3"), { name: "requests", version: "2.32.3" });
  assert.deepEqual(parseSpec("cargo", "serde@1.0.200"), { name: "serde", version: "1.0.200" });
  for (const bad of ["left-pad", "left-pad@^1.0.0", "left-pad@latest"]) assert.throws(() => parseSpec("npm", bad));
  assert.throws(() => parseSpec("pip", "requests>=2"));
});

test("hashManifest ignores order and duplicates, and changes with content", () => {
  const reordered: EnvManifest = {
    ecosystems: { pip: { lockfileHash: "abc", specs: ["requests==2.32.3", "requests==2.32.3"] }, npm: { specs: ["@scope/pkg@2.0.0", "left-pad@1.3.0"] } },
  };
  assert.equal(hashManifest(base), hashManifest(reordered));
  assert.match(hashManifest(base), /^[0-9a-f]{64}$/);
  assert.notEqual(hashManifest(base), hashManifest(emptyManifest()));
  assert.notEqual(hashManifest(base), hashManifest({ ...base, ecosystems: { ...base.ecosystems, pip: { specs: ["requests==2.32.3"], lockfileHash: "xyz" } } }));
});

test("normalize drops empty ecosystems and rejects conflicting pins", () => {
  assert.deepEqual(normalize({ ecosystems: { npm: { specs: [] } } }), emptyManifest());
  assert.throws(() => normalize({ ecosystems: { npm: { specs: ["a@1.0.0", "a@2.0.0"] } } }), /conflicting/);
});

test("extend inherits parent entries and reports overrides", () => {
  const { manifest, overrides } = extend(base, { npm: { specs: ["left-pad@1.4.0", "lodash@4.17.21"] }, cargo: { specs: ["serde@1.0.200"] } });
  assert.deepEqual(manifest.ecosystems.npm?.specs, ["@scope/pkg@2.0.0", "left-pad@1.4.0", "lodash@4.17.21"]);
  assert.deepEqual(manifest.ecosystems.cargo?.specs, ["serde@1.0.200"]);
  assert.deepEqual(manifest.ecosystems.pip, base.ecosystems.pip);
  assert.deepEqual(overrides, [{ ecosystem: "npm", name: "left-pad", from: "left-pad@1.3.0", to: "left-pad@1.4.0" }]);
});

test("extend keeps a parent lockfile hash only when nothing changed in that ecosystem", () => {
  assert.equal(extend(base, { pip: { specs: ["requests==2.32.3"] } }).manifest.ecosystems.pip?.lockfileHash, "abc");
  assert.equal(extend(base, { pip: { specs: ["rich==13.7.1"] } }).manifest.ecosystems.pip?.lockfileHash, undefined);
  assert.equal(extend(base, { pip: { specs: ["rich==13.7.1"], lockfileHash: "new" } }).manifest.ecosystems.pip?.lockfileHash, "new");
});

test("extend with no additions is a hash-identical inheritance", () => {
  const { manifest, overrides } = extend(base, {});
  assert.equal(hashManifest(manifest), hashManifest(base));
  assert.deepEqual(overrides, []);
});

test("cacheKey is stable, ecosystem-scoped, and requires a pinned spec", () => {
  assert.equal(cacheKey("npm", "left-pad@1.3.0"), cacheKey("npm", "left-pad@1.3.0"));
  assert.notEqual(cacheKey("npm", "left-pad@1.3.0"), cacheKey("cargo", "left-pad@1.3.0"));
  assert.match(cacheKey("pip", "requests==2.32.3"), /^pip\/[0-9a-f]{64}$/);
  assert.throws(() => cacheKey("pip", "requests"));
});

test("mountPlan: own layer read-write, parent layer read-only, keyed by manifest hash", () => {
  const { manifest: child } = extend(base, { npm: { specs: ["lodash@4.17.21"] } });
  const plan = mountPlan(child, { cacheRoot: "/cache/", parent: base });
  assert.deepEqual(plan, [
    { kind: "bind", hostPath: `/cache/${hashManifest(child)}`, containerPath: ENV_LAYER_PATH },
    { kind: "bind", hostPath: `/cache/${hashManifest(base)}`, containerPath: ENV_PARENT_PATH, readOnly: true },
  ]);
  assert.equal(mountPlan(base, { cacheRoot: "/cache" }).length, 1);
  assert.equal(mountPlan(base, { cacheRoot: "/cache", parent: null }).length, 1);
});

test("registryAllowlist covers only the ecosystems in use", () => {
  assert.deepEqual(registryAllowlist(emptyManifest()), []);
  assert.deepEqual(registryAllowlist(base), ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org"]);
  assert.ok(registryAllowlist({ ecosystems: { cargo: { specs: ["serde@1.0.200"] } } }).includes("static.crates.io"));
});
