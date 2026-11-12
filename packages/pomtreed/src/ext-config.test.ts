// Extension-contributed config (registry Phase 3): manifest params -> composed registry -> one resolve, the declared-only credential
// namespace, and the read-only config view an extension gets. A fixture extension stands in for hn-digest.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "@pomtree/testing";
import { formatConfigShow, loadDaemonConfig } from "./daemon-config.ts";
import { type ManifestScan, parseManifest, scanExtensionManifests } from "./extension-manifest.ts";
import { createExtensionRegistry } from "./extensions.ts";
import { setup } from "./test-setup.ts";

const SECRET = "sk-ext-config-sentinel";
const FIXTURE = {
  name: "fixture-ext",
  entry: "entry.mjs",
  credentials: ["api_token"],
  params: [
    {
      key: "sizeBytes",
      kind: "bytes",
      doc: "Size.",
      default: 1000,
      min: 1,
      relations: [{ op: "lte", key: "report.maxBytes" }],
    },
    { key: "mode", kind: "enum", doc: "Mode.", values: ["a", "b"], default: "a" },
  ],
};
const KEY = "ext.fixtureExt.sizeBytes";
const ENV = "POMTREED_EXT_FIXTURE_EXT_SIZE_BYTES";

function writeManifest(extDir: string, sub: string, manifest: unknown) {
  mkdirSync(join(extDir, sub), { recursive: true });
  writeFileSync(join(extDir, sub, "manifest.json"), JSON.stringify({ apiVersion: 2, capabilities: {}, deps: [], ...(manifest as object) }));
}

// A temp root holding the upstream key and an extensions dir; `load` runs the real loader with the real manifest scan.
function fixture(manifests: Record<string, unknown> = { "fixture-ext": FIXTURE }) {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-ext-config-"));
  const keyFile = join(dir, "upstream.key");
  writeFileSync(keyFile, `${SECRET}\n`, { mode: 0o600 });
  const extDir = join(dir, "extensions");
  mkdirSync(extDir);
  for (const [sub, m] of Object.entries(manifests)) writeManifest(extDir, sub, m);
  const base = {
    POMTREED_MODEL_BASE_URL: "http://127.0.0.1:1",
    POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile,
    POMTREED_PI_PROVIDER: "x",
    POMTREED_EXTENSIONS_DIR: extDir,
  };
  const load = (o: { env?: Record<string, string>; set?: string[]; file?: unknown; scan?: () => ManifestScan } = {}) => {
    let configFile: string | undefined;
    if (o.file !== undefined) {
      configFile = join(dir, "pomtreed.json");
      writeFileSync(configFile, JSON.stringify(o.file));
    }
    return loadDaemonConfig({
      env: { ...base, ...o.env },
      args: { set: o.set ?? [], ...(configFile !== undefined && { configFile }) },
      readFile: (p) => readFileSync(p, "utf8"),
      defaultStateDir: join(dir, "state"),
      scanExtensions: o.scan ?? scanExtensionManifests,
    });
  };
  const errors = (o: Parameters<typeof load>[0]): string[] => {
    const r = load(o);
    assert.equal(r.ok, false, "expected a refusal");
    return (r as { errors: string[] }).errors;
  };
  return { dir, extDir, load, errors, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a fixture extension's keys resolve with file < env < --set and origins; show lists them", () => {
  const f = fixture();
  try {
    const d = f.load();
    assert.ok(d.ok, JSON.stringify(d));
    assert.equal(d.resolved.values[KEY], 1000);
    assert.equal(d.extensionsDir, f.extDir);
    const r = f.load({ file: { ext: { fixtureExt: { sizeBytes: 2000, mode: "b" } } }, env: { [ENV]: "3000" }, set: [`${KEY}=4000`] });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.resolved.values[KEY], 4000);
    assert.equal(r.resolved.origins[KEY], "set");
    assert.equal(r.resolved.values["ext.fixtureExt.mode"], "b", "the file value stands where nothing overrides it");
    const show = formatConfigShow(r, { origin: true }).split("\n");
    assert.ok(show.includes(`${KEY}=4000  origin=set default=1000`), show.join("\n"));
    assert.ok(show.includes('ext.fixtureExt.mode="b"  origin=file default="a"'));
  } finally {
    f.cleanup();
  }
});

test("failure paths: bad values, relation to a core key, an old env name, undeclared env, unloaded extension keys", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.errors({ env: { [ENV]: "big" } }), [`${KEY}="big" (env:${ENV}): expected a non-negative integer of bytes`]);
    assert.deepEqual(f.errors({ set: ["ext.fixtureExt.mode=c"] }), ['ext.fixtureExt.mode="c" (set): expected one of a, b']);
    assert.deepEqual(f.errors({ file: { ext: { fixtureExt: { sizeBytes: 1.5 } } } }), [`${KEY}=1.5 (file): expected a non-negative integer of bytes`]);
    // The extension's key is bounded by a core key, checked at startup over the resolved values and their origins.
    assert.deepEqual(f.errors({ set: [`${KEY}=9999999`] }), [`${KEY}=9999999 (set) must be <= report.maxBytes=8388608 (default)`]);
    assert.deepEqual(f.errors({ env: { POMTREED_FIXTURE_SIZE: "1" } }), [
      "unknown env POMTREED_FIXTURE_SIZE; remove it, or use a name listed in docs/configuration.md",
    ]);
    assert.match(
      f.errors({ env: { POMTREED_EXT_FIXTURE_EXT_SIZE_BYTE: "1" } })[0] as string,
      /extension fixture-ext declares no such key or credential \(did you mean POMTREED_EXT_FIXTURE_EXT_SIZE_BYTES\?\)/,
    );
    assert.match(
      f.errors({ env: { POMTREED_EXT_FIXTURE_EXT_API_TOKN: "t" } })[0] as string,
      /declares no such key or credential \(did you mean POMTREED_EXT_FIXTURE_EXT_API_TOKEN\?\)/,
    );
    assert.match(f.errors({ env: { POMTREED_EXT_OTHER_TOKEN: "t" } })[0] as string, /names no loaded extension \(loaded: fixture-ext\)/);
    assert.match(f.errors({ file: { ext: { other: { x: 1 } } } })[0] as string, /^config file: unknown key ext\.other: no loaded extension owns ext\.other\./);
    assert.match(f.errors({ set: ["ext.other.x=1"] })[0] as string, /^--set: unknown key ext\.other\.x: no loaded extension owns ext\.other\./);
    const ok = f.load({ env: { POMTREED_EXT_FIXTURE_EXT_API_TOKEN: "t" } });
    assert.ok(ok.ok, "a declared credential env name is accepted");
  } finally {
    f.cleanup();
  }
});

// The real examples/hn-digest manifest through the real loader: its keys, the refusal of its old core names and the inverted browser-text relation.
test("the real hn-digest manifest: ext.hnDigest keys resolve, the old POMTREED_ARTICLE_* names are refused as unknown, and its browser-text relation holds", () => {
  const real = JSON.parse(readFileSync(new URL("../../../examples/hn-digest/manifest.json", import.meta.url), "utf8")) as unknown;
  assert.equal((real as { apiVersion?: unknown }).apiVersion, 2, "the real manifest declares the extension API version");
  const f = fixture({ "hn-digest": real });
  try {
    const d = f.load();
    assert.ok(d.ok, JSON.stringify(d));
    assert.equal(d.resolved.values["ext.hnDigest.articleCaptureBytes"], 262_144);
    assert.equal(d.extensionConfig("hn-digest")["ext.hnDigest.reportMaxBytes"], 65_536);
    assert.equal("ext.hnDigest.reportMaxBytes" in d.extensionConfig("other"), false);
    assert.equal(d.config["browser.capture.textMaxBytes"], 1_048_576);
    const viaEnv = f.load({ env: { POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTES: "131072" } });
    assert.ok(
      viaEnv.ok &&
        viaEnv.resolved.values["ext.hnDigest.articleCaptureBytes"] === 131_072 &&
        viaEnv.resolved.origins["ext.hnDigest.articleCaptureBytes"] === "env:POMTREED_EXT_HN_DIGEST_ARTICLE_CAPTURE_BYTES",
    );
    for (const old of ["POMTREED_ARTICLE_CAPTURE_BYTES", "POMTREED_DIGEST_REPORT_MAX_BYTES"]) {
      const errors = f.errors({ env: { [old]: "1" } });
      assert.equal(errors.length, 1, old);
      assert.ok((errors[0] ?? "").startsWith(`unknown env ${old}`), errors[0]);
      assert.ok((errors[0] ?? "").endsWith("remove it, or use a name listed in docs/configuration.md"), errors[0]);
    }
    // The relation is declared by the extension: raising the browser clip above the digest's stored-text bound is refused.
    const raised = f.errors({ env: { POMTREED_BROWSER_CAPTURE_TEXT_MAX_BYTES: "2097152" } });
    assert.equal(raised.length, 1);
    assert.match(raised[0] ?? "", /ext\.hnDigest\.articleTextMaxBytes=1048576 \(default\) must be >= browser\.capture\.textMaxBytes=2097152 \(env:/);
  } finally {
    f.cleanup();
  }
});

test("without the hn-digest extension on disk, its keys and its old names are unknown to the daemon", () => {
  const f = fixture({});
  try {
    assert.ok(f.load().ok);
    assert.ok(f.errors({ env: { POMTREED_ARTICLE_CAPTURE_BYTES: "1" } }).some((e) => /POMTREED_ARTICLE_CAPTURE_BYTES/.test(e)));
    assert.ok(f.errors({ set: ["ext.hnDigest.articleCaptureBytes=1"] }).some((e) => /ext\.hnDigest\.articleCaptureBytes/.test(e)));
  } finally {
    f.cleanup();
  }
});

test("an extension that is not on disk owns no names: its keys and env are refused with nothing loaded", () => {
  const f = fixture({});
  try {
    assert.ok(f.load().ok);
    assert.match(f.errors({ env: { [ENV]: "1" } })[0] as string, /names no loaded extension \(loaded: none\)/);
    assert.match(f.errors({ set: [`${KEY}=1`] })[0] as string, /no loaded extension owns ext\.fixtureExt\./);
    assert.match(f.errors({ file: { ext: { fixtureExt: {} } } })[0] as string, /unknown key ext\.fixtureExt: no loaded extension owns/);
  } finally {
    f.cleanup();
  }
});

test("a bad params declaration is a config error naming the extension and key, not a silent failed load", () => {
  const bad = { ...FIXTURE, params: [{ key: "sizeBytes", kind: "bytes", doc: "d", default: 1, container: true }] };
  const f = fixture({ "fixture-ext": bad });
  try {
    assert.deepEqual(f.errors({}), [
      "extension fixture-ext: params[0] (sizeBytes): container is not allowed in a manifest: extension keys are host-side only and never delivered to containers",
    ]);
  } finally {
    f.cleanup();
  }
  const g = fixture({ "fixture-ext": { ...FIXTURE, params: [{ key: "size", kind: "bytes", doc: "d", default: 1 }] } });
  try {
    assert.deepEqual(g.errors({}), ["extension fixture-ext: ext.fixtureExt.size is kind bytes but its name lacks the Bytes unit"]);
  } finally {
    g.cleanup();
  }
});

test("composition faults refuse the start: segment collision, duplicate name, key colliding with a declared credential", () => {
  const f = fixture({ one: { name: "my-ext", entry: "e.mjs", credentials: ["a"] }, two: { name: "my_ext", entry: "e.mjs", credentials: ["b"] } });
  try {
    assert.deepEqual(f.errors({}), ["extension my_ext: config segment ext.myExt. collides with extension my-ext; rename one of them"]);
  } finally {
    f.cleanup();
  }
  const g = fixture({ one: { name: "same", entry: "e.mjs" }, two: { name: "same", entry: "e.mjs" } });
  try {
    assert.match(g.errors({})[0] as string, /extension same: declared twice/);
  } finally {
    g.cleanup();
  }
  const h = fixture({ x: { name: "foo", entry: "e.mjs", credentials: ["bar_baz"], params: [{ key: "barBaz", kind: "count", doc: "d", default: 1 }] } });
  try {
    assert.match(
      h.errors({})[0] as string,
      /^env name POMTREED_EXT_FOO_BAR_BAZ is claimed by both ext\.foo\.barBaz \(extension foo\) and extension foo credential bar_baz$/,
    );
  } finally {
    h.cleanup();
  }
});

test("a manifest that fails for another reason contributes nothing and does not refuse the start", () => {
  const f = fixture({ broken: { name: "Bad Name", entry: "e.mjs", params: [{ key: "x" }] }, fine: { name: "fine", entry: "e.mjs", credentials: ["tok"] } });
  try {
    const r = f.load();
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(
      r.registry.extensions.map((e) => e.name),
      ["fine"],
    );
  } finally {
    f.cleanup();
  }
});

test("extensions that declare no params or credentials never refuse the start, whatever their names (9lives, my-ext beside my_ext)", () => {
  const f = fixture({
    a: { name: "9lives", entry: "e.mjs" },
    b: { name: "my-ext", entry: "e.mjs" },
    c: { name: "my_ext", entry: "e.mjs" },
    d: FIXTURE,
  });
  try {
    const r = f.load();
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(
      r.registry.extensions.map((e) => e.name),
      ["fixture-ext"],
    );
  } finally {
    f.cleanup();
  }
});

test("a manifest refused for a non-params reason is named when the operator's ext config finds no owner, from the file, --set and env", () => {
  // Missing apiVersion, missing capabilities, and missing deps each hide the extension from the scan.
  const f = fixture({
    old: { name: "old", entry: "e.mjs", apiVersion: undefined },
    nocaps: { name: "nocaps", entry: "e.mjs", capabilities: undefined },
    nodeps: { name: "nodeps", entry: "e.mjs", deps: undefined },
  });
  try {
    for (const o of [{ file: { ext: { old: { x: 1 } } } }, { set: ["ext.old.x=1"] }, { env: { POMTREED_EXT_OLD_X: "1" } }]) {
      const errs = f.errors(o);
      assert.match(errs.join("\n"), /no loaded extension|names no loaded extension/);
      const all = errs.join("\n");
      assert.match(all, /extension manifest not loaded: old: extension old: manifest\.json has no "apiVersion"/);
      assert.match(all, /extension manifest not loaded: nocaps: extension nocaps: manifest has no "capabilities" block/);
      assert.match(all, /extension manifest not loaded: nodeps: extension nodeps: manifest has no "deps" block/);
    }
    assert.ok(f.load().ok, "without ext config the start is unaffected, as before");
  } finally {
    f.cleanup();
  }
});

test("core-phase errors are reported before extensions are scanned, and ext inputs are not double-counted", () => {
  const f = fixture();
  try {
    let scans = 0;
    const scan = () => {
      scans++;
      return scanExtensionManifests(f.extDir);
    };
    const errs = f.errors({ env: { POMTREED_AGENT_MAX_DEPTH: "x" }, set: [`${KEY}=1`], scan });
    assert.equal(errs.length, 1, errs.join("\n"));
    assert.match(errs[0] as string, /agent\.maxDepth/);
    assert.equal(scans, 0);
  } finally {
    f.cleanup();
  }
});

test("manifest scan reads JSON only, tolerates a missing dir, and parseManifest validates credentials", () => {
  assert.deepEqual(scanExtensionManifests(join(tmpdir(), "pomtreed-ext-config-absent")), { extensions: [], errors: [], unloaded: [] });
  assert.throws(
    () => parseManifest(JSON.stringify({ apiVersion: 2, name: "a", entry: "e", capabilities: {}, deps: [], credentials: ["../x"] })),
    /credentials must be an array of names/,
  );
  assert.throws(() => parseManifest(JSON.stringify({ apiVersion: 2, name: "a", entry: "e", capabilities: {}, deps: [], credentials: ["x", "x"] })), /distinct/);
  assert.equal(parseManifest(JSON.stringify({ apiVersion: 2, name: "a", entry: "e", capabilities: {}, deps: [], params: [], x: 1 })).params?.length, 0);
  assert.throws(() => parseManifest(JSON.stringify({ capabilities: {}, deps: [], name: "a", entry: "e" })), /extension a: manifest\.json has no "apiVersion"/);
  assert.throws(
    () => parseManifest(JSON.stringify({ apiVersion: 3, capabilities: {}, deps: [], name: "a", entry: "e" })),
    /extension a: manifest apiVersion 3 is not supported/,
  );
  assert.throws(
    () => parseManifest(JSON.stringify({ apiVersion: 1, capabilities: {}, deps: [], name: "a", entry: "e" })),
    /^Error: extension a: manifest apiVersion 1 is not supported; this host speaks extension API 2$/,
  );
  assert.equal(parseManifest(JSON.stringify({ apiVersion: 2, capabilities: {}, deps: [], name: "a", entry: "e" })).apiVersion, 2);
});

test("host.config is a frozen view of the extension's own keys plus non-sensitive core keys; host.deps.credential is declared-only", async () => {
  const f = fixture();
  const t = setup(async () => {});
  try {
    const r = f.load({ set: [`${KEY}=4000`] });
    assert.ok(r.ok, JSON.stringify(r));
    const registry = createExtensionRegistry({
      hostId: "h1",
      now: Date.now,
      registry: t.fakes.registry,
      journal: t.fakes.journal,
      mailbox: t.fakes.mailbox,
      root: () => t.daemon.root(),
      config: r.extensionConfig,
    });
    const seen: Record<string, unknown>[] = [];
    const reads: string[] = [];
    registry.registerBuiltin({
      manifest: { name: "fixture-ext", entry: "builtin", capabilities: {}, deps: ["credentials"], credentials: ["api_token"] },
      init(host) {
        seen.push(host.config as Record<string, unknown>);
        reads.push(host.deps.credential("api_token").name);
        assert.throws(() => host.deps.credential("other"), /credential "other" is not declared in manifest\.credentials/);
      },
    });
    registry.registerBuiltin({
      manifest: { name: "plain", entry: "builtin", capabilities: {}, deps: [] },
      init: (host) => void seen.push(host.config as Record<string, unknown>),
    });
    const [own, plain] = seen as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(own[KEY], 4000);
    assert.equal(own["report.maxBytes"], 8 * 1024 * 1024, "core keys are visible");
    assert.equal(own["model.upstreamKey"], undefined, "sensitive core keys are not");
    assert.equal(plain[KEY], undefined, "another extension's keys are not");
    assert.equal(plain["report.maxBytes"], 8 * 1024 * 1024);
    assert.ok(Object.isFrozen(own));
    assert.throws(() => {
      (own as Record<string, unknown>)[KEY] = 1;
    }, TypeError);
    assert.deepEqual(reads, ["api_token"]);
    assert.ok(!JSON.stringify([own, plain]).includes(SECRET));
  } finally {
    f.cleanup();
  }
});

test("a declared credential reads POMTREED_EXT_<NAME>_<CRED> first, then the extension's credentials file", async () => {
  const dir = tmpDir("pomtreed-ext-cred-");
  const t = setup(async () => {});
  writeManifest(dir, "cred-ext", { name: "cred-ext", entry: "entry.mjs", deps: ["credentials"], credentials: ["api_token"] });
  writeFileSync(
    join(dir, "cred-ext", "entry.mjs"),
    "export default { manifest: { name: 'cred-ext', entry: 'entry.mjs', credentials: ['api_token'] }, init(host) { globalThis.__cred = host.deps.credential('api_token'); } };",
  );
  const registry = createExtensionRegistry({
    hostId: "h1",
    now: Date.now,
    registry: t.fakes.registry,
    journal: t.fakes.journal,
    mailbox: t.fakes.mailbox,
    root: () => t.daemon.root(),
  });
  const loaded = await registry.load(dir);
  assert.equal(loaded[0]?.status, "ok", loaded[0]?.error);
  const cred = (globalThis as { __cred?: { read(): string | undefined } }).__cred;
  assert.ok(cred);
  assert.equal(cred.read(), undefined);
  writeFileSync(join(dir, "cred-ext", "credentials.api_token"), "from-file\n");
  assert.equal(cred.read(), "from-file");
  process.env.POMTREED_EXT_CRED_EXT_API_TOKEN = "from-env";
  try {
    assert.equal(cred.read(), "from-env");
  } finally {
    delete process.env.POMTREED_EXT_CRED_EXT_API_TOKEN;
    delete (globalThis as { __cred?: unknown }).__cred;
  }
});
