import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SANDBOX_CAPABILITIES, SANDBOX_PORT_VERSION } from "@pomtree/core";
import type { ExtensionManifest } from "@pomtree/core";
import { parseManifest } from "./extension-manifest.ts";
import { SandboxProviderLoader, installResolveGuard, measureExtensionTree, parseReviewedBackends } from "./sandbox-provider-load.ts";
import type { ResolveGuard, SandboxProviderLoaderOptions } from "./sandbox-provider-load.ts";

// The unit tests of pin and containment logic opt out of the hook explicitly; the guarded ones pass the real handle.
function newLoader(o: SandboxProviderLoaderOptions): SandboxProviderLoader {
  return new SandboxProviderLoader(o.guard === undefined ? { ...o, unguardedForTests: true } : o);
}

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pomtree-g3-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const capabilities = Object.fromEntries(SANDBOX_CAPABILITIES.map((c) => [c, false]));
function declaration(backend: string): string {
  return JSON.stringify({
    backend,
    capabilities,
    region: null,
    idempotency: "unique-name",
    idempotencyWindowMs: null,
    tagging: "metadata",
    output: "poll",
    maxLifetimeMs: null,
    preemptible: false,
    billing: { unit: "none", whileStopped: false, whilePaused: false },
  });
}
// A provider module that records its own construction in a global so a test can see whether `create` ever ran.
function providerSource(id: string, extra = "", portVersion: number = SANDBOX_PORT_VERSION): string {
  return `${extra}
export const portVersion = ${portVersion};
export const declaration = ${declaration(id)};
export function create(deps) { (globalThis.__g3created ??= []).push(${JSON.stringify(id)}); return {}; }
`;
}

interface Fixture {
  dir: string;
  manifest: ExtensionManifest;
}
function manifestFor(name: string, id: string, portVersion = SANDBOX_PORT_VERSION, entry = "provider.mjs"): ExtensionManifest {
  return parseManifest(
    JSON.stringify({
      apiVersion: 2,
      name,
      entry: "entry.mjs",
      capabilities: {},
      deps: [],
      provides: [{ kind: "sandbox", id, entry, portVersion, credentials: ["apiKey"] }],
    }),
  );
}
function makeExtension(name: string, id: string, files: Record<string, string> = {}, opts: { portVersion?: number; modulePort?: number } = {}): Fixture {
  const dir = join(tmp(), name);
  mkdirSync(dir, { recursive: true });
  const all: Record<string, string> = { "entry.mjs": "export default {};\n", "provider.mjs": providerSource(id, "", opts.modulePort), ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return { dir, manifest: manifestFor(name, id, opts.portVersion ?? SANDBOX_PORT_VERSION) };
}
function pinOf(f: Fixture, id: string): string {
  return `${id}=${measureExtensionTree(f.dir).hash}`;
}
function spyImport() {
  const urls: string[] = [];
  return {
    urls,
    importModule: (u: string) => {
      urls.push(u);
      return import(u);
    },
  };
}

describe("pin", () => {
  test("a pinned directory loads: the loader fills id, params and credentials from the manifest and never calls create", async () => {
    const f = makeExtension("toybox", "toybox");
    const loader = newLoader({ extensions: [f], reviewedBackends: [pinOf(f, "toybox")] });
    const l = await loader.load("toybox");
    assert.equal(l.provider.id, "toybox");
    assert.deepEqual(l.provider.credentials, ["apiKey"]);
    assert.deepEqual(l.provider.params, []);
    assert.equal(l.extension, "toybox");
    assert.equal(l.run, false);
    assert.ok(!((globalThis as { __g3created?: string[] }).__g3created ?? []).includes("toybox"), "load must not construct the provider");
  });

  test("the same directory content pins the same wherever it is copied", () => {
    const a = makeExtension("toybox", "toybox");
    const b = makeExtension("toybox", "toybox");
    assert.equal(measureExtensionTree(a.dir).hash, measureExtensionTree(b.dir).hash);
  });

  for (const [what, mutate, pattern] of [
    ["one changed byte", (d: string) => writeFileSync(join(d, "entry.mjs"), "export default { };\n"), /does not match its pin/],
    ["an added file", (d: string) => writeFileSync(join(d, "extra.mjs"), ""), /does not match its pin/],
    ["a renamed file", (d: string) => renameSync(join(d, "entry.mjs"), join(d, "entry2.mjs")), /does not match its pin/],
    ["a removed file", (d: string) => rmSync(join(d, "entry.mjs")), /does not match its pin/],
  ] as const) {
    test(`${what} breaks the pin and nothing is imported`, async () => {
      const f = makeExtension("toybox", "toybox");
      const pin = pinOf(f, "toybox");
      const spy = spyImport();
      const loader = newLoader({ extensions: [f], reviewedBackends: [pin], importModule: spy.importModule });
      mutate(f.dir);
      await assert.rejects(loader.load("toybox"), (e: Error) => {
        assert.match(e.message, pattern);
        assert.match(e.message, /sha256:[0-9a-f]{64}/);
        assert.match(e.message, /replace the pin with toybox=sha256:/); // the action
        return true;
      });
      assert.deepEqual(spy.urls, []);
    });
  }

  test("negative control: the unchanged directory loads with the same pin", async () => {
    const f = makeExtension("toybox", "toybox");
    const spy = spyImport();
    const loader = newLoader({ extensions: [f], reviewedBackends: [pinOf(f, "toybox")], importModule: spy.importModule });
    await loader.load("toybox");
    assert.equal(spy.urls.length, 1);
  });

  test("a symlink inside the extension directory is refused, even one pointing inside it", async () => {
    const f = makeExtension("toybox", "toybox", { "real.mjs": "export const x = 1;\n" });
    symlinkSync(join(f.dir, "real.mjs"), join(f.dir, "link.mjs"));
    const spy = spyImport();
    const loader = newLoader({ extensions: [f], reviewedBackends: [`toybox=sha256:${"0".repeat(64)}`], importModule: spy.importModule });
    await assert.rejects(loader.load("toybox"), /contains the symlink link\.mjs.*replace the link/);
    assert.deepEqual(spy.urls, []);
  });

  test("an unpinned backend is refused with the hash to add", async () => {
    const f = makeExtension("toybox", "toybox");
    const loader = newLoader({ extensions: [f], reviewedBackends: [] });
    await assert.rejects(loader.load("toybox"), (e: Error) => {
      assert.match(e.message, /sandbox backend toybox is not reviewed/);
      assert.ok(e.message.includes(`add ${pinOf(f, "toybox")} to sandbox.reviewedBackends`));
      return true;
    });
  });

  test("a tree over the file-count or total-size cap is refused with cause and action", () => {
    const f = makeExtension("toybox", "toybox", { "a.txt": "12345", "b.txt": "12345" });
    assert.throws(() => measureExtensionTree(f.dir, undefined, { maxFiles: 2, maxTotalBytes: 1e9 }), /more than 2 files.*remove build output/);
    assert.throws(() => measureExtensionTree(f.dir, undefined, { maxFiles: 100, maxTotalBytes: 20 }), /more than 20 bytes \(at .*\).*bundle the code/);
    assert.doesNotThrow(() => measureExtensionTree(f.dir));
  });

  test("parseReviewedBackends maps id to pin", () => {
    assert.deepEqual(
      [...parseReviewedBackends(["a=sha256:x", "b=sha256:y"])],
      [
        ["a", "sha256:x"],
        ["b", "sha256:y"],
      ],
    );
  });
});

describe("the guard is not optional", () => {
  test("a loader without an installed handle is refused with cause and action", () => {
    const f = makeExtension("toybox", "toybox");
    const rule = /needs the handle returned by installResolveGuard.*call installResolveGuard\(\) at boot and pass it as guard/;
    assert.throws(() => new SandboxProviderLoader({ extensions: [f], reviewedBackends: [] }), rule);
    assert.throws(() => new SandboxProviderLoader({ extensions: [f], reviewedBackends: [], guard: { pin() {}, deregister() {} } }), rule);
  });

  test("a real handle is accepted, and a deregistered one is not", () => {
    const f = makeExtension("toybox", "toybox");
    const g = installResolveGuard();
    assert.doesNotThrow(() => new SandboxProviderLoader({ extensions: [f], reviewedBackends: [], guard: g }));
    g.deregister();
    assert.throws(() => new SandboxProviderLoader({ extensions: [f], reviewedBackends: [], guard: g }), /needs the handle/);
  });
});

describe("tree measurement", () => {
  test("native addons and WebAssembly in the tree are refused", () => {
    for (const name of ["x.node", "lib/y.wasm"]) {
      const f = makeExtension("toybox", "toybox", { [name]: "bytes" });
      assert.throws(
        () => measureExtensionTree(f.dir),
        new RegExp(`contains ${name}; native addons and WebAssembly cannot be served from the pinned bytes.*pure JavaScript`),
      );
    }
  });

  test("directory-count and nesting-depth caps are refused with cause and action", () => {
    const f = makeExtension("toybox", "toybox", { "a/1.txt": "x", "b/1.txt": "x", "c/d/e/1.txt": "x" });
    assert.throws(() => measureExtensionTree(f.dir, undefined, { maxDirs: 2 }), /more than 2 directories.*bundle the code/);
    assert.throws(() => measureExtensionTree(f.dir, undefined, { maxDepth: 2 }), /nests deeper than 2 levels \(at c\/d\).*flatten it/);
    assert.doesNotThrow(() => measureExtensionTree(f.dir));
  });

  test("the cap counts the bytes actually read, not the size lstat reported", () => {
    const fs = {
      realpath: (p: string) => p,
      lstat: (p: string) => ({ size: 0, isFile: () => p.endsWith("big"), isDirectory: () => !p.endsWith("big"), isSymbolicLink: () => false }),
      readdir: (p: string) => (p === "/root" ? ["big"] : []),
      readFile: () => new Uint8Array(10),
    };
    assert.throws(() => measureExtensionTree("/root", fs, { maxTotalBytes: 5 }), /more than 5 bytes \(at big\)/);
    assert.doesNotThrow(() => measureExtensionTree("/root", fs, { maxTotalBytes: 10 }));
  });
});

describe("containment, version and ids", () => {
  test("an entry that escapes the directory by realpath is refused before the pin or any import", async () => {
    const f = makeExtension("toybox", "toybox");
    const outside = join(tmp(), "outside.mjs");
    writeFileSync(outside, providerSource("toybox"));
    symlinkSync(outside, join(f.dir, "linked.mjs"));
    const manifest = manifestFor("toybox", "toybox", SANDBOX_PORT_VERSION, "linked.mjs");
    const spy = spyImport();
    const loader = newLoader({ extensions: [{ dir: f.dir, manifest }], reviewedBackends: [], importModule: spy.importModule });
    await assert.rejects(loader.load("toybox"), /entry "linked\.mjs" escapes the extension directory .* through a symlink.*keep the provider module inside it/);
    assert.deepEqual(spy.urls, []);
  });

  test("a lexically escaping entry (hand-built manifest) is refused", async () => {
    const f = makeExtension("toybox", "toybox");
    const manifest = manifestFor("toybox", "toybox");
    ((manifest.provides as { entry: string }[])[0] as { entry: string }).entry = "../outside.mjs";
    const loader = newLoader({ extensions: [{ dir: f.dir, manifest }], reviewedBackends: [] });
    await assert.rejects(loader.load("toybox"), /escapes the extension directory/);
  });

  test("a manifest portVersion the daemon does not speak is refused with cause and action, before any import", async () => {
    const f = makeExtension("toybox", "toybox", {}, { portVersion: SANDBOX_PORT_VERSION + 1 });
    const spy = spyImport();
    const loader = newLoader({ extensions: [f], reviewedBackends: [pinOf(f, "toybox")], importModule: spy.importModule });
    await assert.rejects(loader.load("toybox"), (e: Error) => {
      assert.match(e.message, new RegExp(`port version ${SANDBOX_PORT_VERSION + 1}; this daemon speaks ${SANDBOX_PORT_VERSION}`));
      assert.match(e.message, /update the backend/);
      return true;
    });
    assert.deepEqual(spy.urls, []);
  });

  test("a module whose own portVersion differs from the daemon's is refused after the import", async () => {
    const f = makeExtension("toybox", "toybox", {}, { modulePort: SANDBOX_PORT_VERSION + 1 });
    const loader = newLoader({ extensions: [f], reviewedBackends: [pinOf(f, "toybox")] });
    await assert.rejects(loader.load("toybox"), /speaks port version 2; this daemon speaks 1; update the backend/);
  });

  test("two extensions providing one id are refused naming both", () => {
    const a = makeExtension("toybox", "toybox-x");
    const manifestB = manifestFor("toybox-x", "toybox-x");
    const b = { dir: join(tmp(), "second-copy"), manifest: manifestB };
    assert.throws(
      () => newLoader({ extensions: [a, b], reviewedBackends: [] }),
      (e: Error) => {
        assert.match(e.message, /sandbox backend toybox-x is provided by both extension toybox \(.*\) and extension toybox-x \(.*second-copy\)/);
        assert.match(e.message, /rename one id or remove one extension/);
        return true;
      },
    );
  });

  test("a built-in id is never loaded through this path", () => {
    const manifest: ExtensionManifest = {
      ...manifestFor("toybox", "toybox"),
      provides: [{ kind: "sandbox", id: "docker", entry: "provider.mjs", portVersion: 1 }],
    };
    assert.throws(() => newLoader({ extensions: [{ dir: "/x", manifest }], reviewedBackends: [] }), /sandbox backend id "docker" is reserved/);
    const g = makeExtension("toybox", "toybox");
    assert.throws(() => newLoader({ extensions: [g], reviewedBackends: [], builtinIds: ["toybox"] }), /is a built-in backend; rename the id/);
  });

  test("an unknown id lists what is contributed", async () => {
    const f = makeExtension("toybox", "toybox");
    const loader = newLoader({ extensions: [f], reviewedBackends: [] });
    await assert.rejects(loader.load("nope"), /no installed extension provides sandbox backend nope \(contributed: toybox\)/);
    assert.deepEqual(loader.ids(), [{ id: "toybox", extension: "toybox" }]);
  });

  test("deps other than run are refused", async () => {
    const f = makeExtension("toybox", "toybox");
    ((f.manifest.provides as { deps?: string[] }[])[0] as { deps?: string[] }).deps = ["journal"];
    const loader = newLoader({ extensions: [f], reviewedBackends: [] });
    await assert.rejects(loader.load("toybox"), /may declare only "run"; remove it/);
  });

  test("a module whose declaration names another backend, or is invalid, is refused", async () => {
    const f = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("other") });
    const loader = newLoader({ extensions: [f], reviewedBackends: [pinOf(f, "toybox")] });
    await assert.rejects(loader.load("toybox"), /declaration names backend "other"; set declaration\.backend to "toybox"/);
    const g = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox").replace('"unique-name"', '"none"') });
    const loader2 = newLoader({ extensions: [g], reviewedBackends: [pinOf(g, "toybox")] });
    await assert.rejects(loader2.load("toybox"), /invalid declaration/);
  });
});

describe("laziness", () => {
  test("an unselected provider's module is never imported and no provider is constructed", async () => {
    const a = makeExtension("alpha", "alpha");
    const b = makeExtension("bravo", "bravo");
    const spy = spyImport();
    const created = () => ((globalThis as { __g3created?: string[] }).__g3created ?? []).filter((x) => x === "alpha" || x === "bravo");
    const before = created().length;
    const loader = newLoader({ extensions: [a, b], reviewedBackends: [pinOf(a, "alpha"), pinOf(b, "bravo")], importModule: spy.importModule });
    assert.deepEqual(spy.urls, []); // indexing alone imports nothing
    await loader.load("bravo");
    assert.equal(spy.urls.length, 1);
    assert.match(String(spy.urls[0]), /bravo\/provider\.mjs$/);
    assert.equal(created().length, before);
  });

  test("a second load of one id imports once", async () => {
    const f = makeExtension("toybox", "toybox");
    const spy = spyImport();
    const loader = newLoader({ extensions: [f], reviewedBackends: [pinOf(f, "toybox")], importModule: spy.importModule });
    const [x, y] = await Promise.all([loader.load("toybox"), loader.load("toybox")]);
    assert.equal(x, y);
    assert.equal(spy.urls.length, 1);
  });
});

describe("resolve hook", () => {
  let guard: ResolveGuard;
  before(() => {
    guard = installResolveGuard();
  });
  after(() => guard.deregister());

  async function load(f: Fixture, id: string, withGuard: boolean, importModule?: (u: string) => Promise<unknown>) {
    const loader = newLoader({
      extensions: [f],
      reviewedBackends: [pinOf(f, id)],
      ...(withGuard && { guard }),
      ...(importModule && { importModule }),
    });
    return loader.load(id);
  }

  test("an import outside the directory is stopped by the hook; without the hook it succeeds (control)", async () => {
    // The fixture sits next to its sibling `outside.mjs` so the relative specifier reaches it.
    const root = tmp();
    writeFileSync(join(root, "outside.mjs"), "export const leaked = true;\n");
    const mk = (name: string): Fixture => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "entry.mjs"), "export default {};\n");
      writeFileSync(join(dir, "provider.mjs"), providerSource("toybox", 'import { leaked } from "../outside.mjs";\nexport { leaked };'));
      return { dir, manifest: manifestFor("toybox", "toybox") };
    };
    await load(mk("noguard"), "toybox", false); // the control: the import reaches the outside file
    await assert.rejects(load(mk("guarded"), "toybox", true), (e: Error) => {
      assert.match(e.message, /may not import "\.\.\/outside\.mjs".*outside the pinned extension directory.*move the code inside the directory/);
      return true;
    });
  });

  test("a bare package that is not shipped by the daemon is refused", async () => {
    const f = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox", 'import "left-pad";') });
    await assert.rejects(load(f, "toybox", true), /may not import "left-pad".*only node: builtins and the packages the daemon ships/);
  });

  test("the daemon's own internals are refused by package name and by path", async () => {
    const byName = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox", 'import "@pomtree/pomtreed";') });
    await assert.rejects(load(byName, "toybox", true), /may not import "@pomtree\/pomtreed"/);
    const internal = new URL("./auth.ts", import.meta.url).href;
    const byPath = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox", `import ${JSON.stringify(internal)};`) });
    await assert.rejects(load(byPath, "toybox", true), /outside the pinned extension directory/);
  });

  test("allowed imports: node builtins (bare and prefixed), shipped packages, and listed files in subdirectories", async () => {
    const f = makeExtension("toybox", "toybox", {
      "lib/util.mjs": "export const util = 1;\n",
      "provider.mjs": providerSource(
        "toybox",
        'import "node:path";\nimport "fs";\nimport "@pomtree/core";\nimport "@pomtree/sandbox-kit";\nimport "./lib/util.mjs";',
      ),
    });
    const l = await load(f, "toybox", true);
    assert.equal(l.provider.id, "toybox");
  });

  test("a non-file scheme (data:) import is refused", async () => {
    const f = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox", 'import "data:text/javascript,export default 1";') });
    await assert.rejects(load(f, "toybox", true), /may not import "data:text\/javascript/);
  });

  // The swapped bytes set the marker to "swapped"; the verified ones to "original". The unguarded control shows the swap lands.
  const marker = (key: string) => (globalThis as Record<string, unknown>)[key];

  test("the entry swapped after measurement and before import: the verified bytes run, not the swapped ones", async () => {
    const key = "__g3entry";
    const src = (v: string) => providerSource("toybox", `globalThis.${key} = ${JSON.stringify(v)};`);
    const run = async (withGuard: boolean) => {
      const f = makeExtension("toybox", "toybox", { "provider.mjs": src("original") });
      const swap = async (u: string) => {
        writeFileSync(join(f.dir, "provider.mjs"), src("swapped"));
        return import(u);
      };
      await load(f, "toybox", withGuard, swap);
      return marker(key);
    };
    assert.equal(await run(false), "swapped"); // without the hook the swap runs
    assert.equal(await run(true), "original");
  });

  test("a non-entry file swapped after measurement: the verified bytes run", async () => {
    const key = "__g3lib";
    const lib = (v: number) => `export const util = ${v};\n`;
    const run = async (withGuard: boolean) => {
      const f = makeExtension("toybox", "toybox", {
        "lib/util.mjs": lib(1),
        "provider.mjs": providerSource("toybox", `import { util } from "./lib/util.mjs";\nglobalThis.${key} = util;`),
      });
      const swap = async (u: string) => {
        writeFileSync(join(f.dir, "lib/util.mjs"), lib(2));
        return import(u);
      };
      await load(f, "toybox", withGuard, swap);
      return marker(key);
    };
    assert.equal(await run(false), 2);
    assert.equal(await run(true), 1);
  });

  test("the verified bytes are served in each supported module format (.js by package type, .json, .cjs)", async () => {
    const key = "__g3fmt";
    const f = makeExtension("toybox", "toybox", {
      "package.json": '{"type":"module"}',
      "lib/a.js": "export const a = 1;\n",
      "lib/b.cjs": "module.exports = { b: 2 };\n",
      "lib/c.json": '{"c":3}',
      "provider.mjs": providerSource(
        "toybox",
        `import { a } from "./lib/a.js";\nimport b from "./lib/b.cjs";\nimport c from "./lib/c.json" with { type: "json" };\nglobalThis.${key} = a + b.b + c.c;`,
      ),
    });
    await load(f, "toybox", true);
    assert.equal(marker(key), 6);
  });

  test("swapped .cjs and .json files are served verified; so are ?query and #fragment aliases, dynamic import() and require", async () => {
    const key = "__g3alias";
    const files = (v: number) => ({
      "lib/c.cjs": `module.exports = { c: ${v} };\n`,
      "lib/j.json": `{"j":${v}}`,
      "lib/q.mjs": `export const q = ${v};\n`,
      "lib/d.mjs": `export const d = ${v};\n`,
      "lib/r.cjs": `module.exports = { r: require("./req.cjs").r };\n`,
      "lib/req.cjs": `module.exports = { r: ${v} };\n`,
    });
    const source = [
      'import c from "./lib/c.cjs";',
      'import j from "./lib/j.json" with { type: "json" };',
      'import { q } from "./lib/q.mjs?x=1";',
      'import { q as q2 } from "./lib/q.mjs#frag";',
      'import r from "./lib/r.cjs";',
      'const { d } = await import("./lib/d.mjs");',
      `globalThis.${key} = [c.c, j.j, q, q2, r.r, d].join(",");`,
    ].join("\n");
    const run = async (withGuard: boolean) => {
      const f = makeExtension("toybox", "toybox", { ...files(1), "provider.mjs": providerSource("toybox", source) });
      const swap = async (u: string) => {
        for (const [rel, text] of Object.entries(files(2))) writeFileSync(join(f.dir, rel), text);
        return import(u);
      };
      await load(f, "toybox", withGuard, swap);
      return marker(key);
    };
    assert.equal(await run(false), "2,2,2,2,2,2"); // control: without the hook every swap lands
    assert.equal(await run(true), "1,1,1,1,1,1");
  });

  test("TypeScript files: .mts and .cts load from verified bytes; .ts follows the pinned package.json (commonjs when absent)", async () => {
    const key = "__g3ts";
    const f = makeExtension("toybox", "toybox", {
      "lib/m.mts": "export const m: number = 7;\n",
      "lib/c.cts": "const c: number = 8;\nmodule.exports = { c };\n",
      "lib/t.ts": "const t: number = 9;\nmodule.exports = { t };\n",
      "provider.mjs": providerSource(
        "toybox",
        `import { m } from "./lib/m.mts";\nimport c from "./lib/c.cts";\nimport t from "./lib/t.ts";\nglobalThis.${key} = [m, c.c, t.t].join(",");`,
      ),
    });
    await load(f, "toybox", true);
    assert.equal(marker(key), "7,8,9");
  });

  test("a require of a native addon is refused before it can reach process.dlopen; so is any unsupported extension", async () => {
    const f = makeExtension("toybox", "toybox", {
      "lib/r.cjs": 'module.exports = require("./x.node");\n',
      "provider.mjs": providerSource("toybox", 'import "./lib/r.cjs";'),
    });
    const addon = async (u: string) => {
      writeFileSync(join(f.dir, "lib/x.node"), "not really an addon"); // appears after the pin check
      return import(u);
    };
    await assert.rejects(load(f, "toybox", true, addon), /may not import "\.\/x\.node": \.node files cannot be served from the pinned bytes/);
    const g = makeExtension("toybox", "toybox", {
      "notes.txt": "hello",
      "lib/r.cjs": 'module.exports = require("../notes.txt");\n',
      "provider.mjs": providerSource("toybox", 'import "./lib/r.cjs";'),
    });
    await assert.rejects(load(g, "toybox", true), /may not import "\.\.\/notes\.txt": notes\.txt has the unsupported extension ".txt"/);
  });

  for (const name of ["child_process", "vm", "worker_threads", "module", "cluster", "inspector"]) {
    for (const spec of [`node:${name}`, name]) {
      test(`${spec} is refused with the action`, async () => {
        const f = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox", `import ${JSON.stringify(spec)};`) });
        await assert.rejects(load(f, "toybox", true), (e: Error) => {
          assert.match(e.message, new RegExp(`may not import "${spec}": node:${name} is not available.*use the run dep`));
          return true;
        });
      });
    }
  }

  test("module.registerHooks missing (an older Node) fails the guard install with cause and action", () => {
    assert.throws(
      () => installResolveGuard({ moduleApi: {} }),
      /has no module\.registerHooks.*Node 22\.15\+, 23\.5\+ or 24\+\); run the daemon on Node 24 or later/,
    );
  });

  test("an unlisted file inside the directory is refused", async () => {
    const f = makeExtension("toybox", "toybox", { "provider.mjs": providerSource("toybox", 'import "./late.mjs";') });
    const loader = newLoader({
      extensions: [f],
      reviewedBackends: [pinOf(f, "toybox")], // measured without late.mjs ...
      guard,
      importModule: async (u) => {
        writeFileSync(join(f.dir, "late.mjs"), "export const late = 1;\n"); // ... which appears before the import
        return import(u);
      },
    });
    await assert.rejects(loader.load("toybox"), /late\.mjs was not in the reviewed listing/);
  });

  test("the hook is silent for importers outside pinned directories", async () => {
    const root = tmp();
    writeFileSync(join(root, "a.mjs"), 'import "./b.mjs"; export const ok = 1;\n');
    writeFileSync(join(root, "b.mjs"), "export {};\n");
    const m = await import(join(root, "a.mjs"));
    assert.equal(m.ok, 1);
  });
});
