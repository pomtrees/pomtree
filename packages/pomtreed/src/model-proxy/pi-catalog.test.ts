import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "@pomtree/testing";
import { CATALOG_DIR_ENV, discoverCatalogDir, loadPiCatalog, openPiCatalog, piAgentDir } from "./pi-catalog.ts";

const flash = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 };
const pro = { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 };
const catalogFile = { "openai-completions": { "chat:deepseek-flash": { type: "chat", id: "deepseek-flash", cost: flash } } };

function dataDir(): string {
  const dir = tmpDir("pomtreed-catalog-");
  writeFileSync(join(dir, "deepseek.json"), JSON.stringify(catalogFile));
  writeFileSync(join(dir, ".manifest.json"), JSON.stringify({ generatedAt: "2026-10-07T22:01:28.515Z" }));
  return dir;
}

// A managed-Pi lookalike: <agent>/bin/pi launcher, install/current-version, releases/<v>/.../data. `pi` on PATH is a symlink to it.
function managedPi(): { path: string; data: string } {
  const root = tmpDir("pomtreed-pi-");
  const agent = join(root, "agent");
  mkdirSync(join(agent, "bin"), { recursive: true });
  writeFileSync(join(agent, "bin", "pi"), "#!/bin/sh\n");
  chmodSync(join(agent, "bin", "pi"), 0o755);
  mkdirSync(join(agent, "install"), { recursive: true });
  writeFileSync(join(agent, "install", "current-version"), "1.5.1\n");
  const data = join(agent, "install", "releases", "1.5.1", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "deepseek.json"), JSON.stringify(catalogFile));
  const bin = join(root, "usr-bin");
  mkdirSync(bin);
  symlinkSync(join(agent, "bin", "pi"), join(bin, "pi"));
  return { path: bin, data };
}

test("discoverCatalogDir: the override env wins; else the managed launcher's realpath names the release", () => {
  const { path, data } = managedPi();
  assert.equal(discoverCatalogDir({ [CATALOG_DIR_ENV]: "/x/data", PATH: path }), "/x/data");
  // realpath of the temp dir may differ from tmpdir() (macOS /var -> /private/var), so compare resolved paths
  assert.equal(discoverCatalogDir({ PATH: `/nonexistent:${path}` })?.replace(/^\/private/, ""), data.replace(/^\/private/, ""));
});

test("discoverCatalogDir: no pi, or a pi outside the managed layout, is null (no other layouts)", () => {
  assert.equal(discoverCatalogDir({ PATH: tmpDir("pomtreed-empty-") }), null);
  assert.equal(discoverCatalogDir({}), null);
  const root = tmpDir("pomtreed-odd-");
  writeFileSync(join(root, "pi"), "#!/bin/sh\n");
  assert.equal(discoverCatalogDir({ PATH: root }), null);
});

test("loadPiCatalog reads the provider file and counts entries; the store overlay wins only when newer", () => {
  const dir = dataDir();
  const base = loadPiCatalog({ dir, providers: ["deepseek"] });
  assert.equal(base?.entries.get("deepseek"), 1);
  assert.deepEqual(base?.source.lookup("deepseek", "deepseek-flash"), flash);
  assert.equal(base?.source.lookup("deepseek", "deepseek-v4-pro"), null);

  const storePath = join(tmpDir("pomtreed-store-"), "models-store.json");
  const store = (lastModified: number) => ({
    deepseek: {
      models: [
        { id: "deepseek-v4-pro", cost: pro },
        { id: "deepseek-flash", cost: { ...flash, input: 9 } },
      ],
      lastModified,
    },
  });
  writeFileSync(storePath, JSON.stringify(store(Date.parse("2026-10-01T00:00:00Z"))));
  assert.equal(loadPiCatalog({ dir, providers: ["deepseek"], storePath })?.entries.get("deepseek"), 1, "older than built-in data: ignored");
  writeFileSync(storePath, JSON.stringify(store(Date.parse("2026-10-09T00:00:00Z"))));
  const merged = loadPiCatalog({ dir, providers: ["deepseek"], storePath });
  assert.equal(merged?.entries.get("deepseek"), 2);
  assert.deepEqual(merged?.source.lookup("deepseek", "deepseek-v4-pro"), pro);
  assert.equal(merged?.source.lookup("deepseek", "deepseek-flash")?.input, 9);
  writeFileSync(storePath, "not json");
  assert.equal(loadPiCatalog({ dir, providers: ["deepseek"], storePath })?.entries.get("deepseek"), 1, "broken overlay contributes nothing");
});

test("loadPiCatalog is null when the provider file is missing or unreadable", () => {
  assert.equal(loadPiCatalog({ dir: tmpDir("pomtreed-nodata-"), providers: ["deepseek"] }), null);
  const dir = dataDir();
  assert.equal(loadPiCatalog({ dir, providers: ["nope"] }), null);
});

test("openPiCatalog logs the location and count, or warns and knows no model", () => {
  const dir = dataDir();
  const ok = openPiCatalog({ [CATALOG_DIR_ENV]: dir }, "deepseek", "/nonexistent-home");
  assert.equal(ok.found, true);
  assert.match(ok.message, /1 deepseek models priced/);
  assert.deepEqual(ok.rates.lookup("deepseek", "deepseek-flash"), flash);

  const missing = openPiCatalog({ [CATALOG_DIR_ENV]: join(dir, "absent") }, "deepseek", "/nonexistent-home");
  assert.equal(missing.found, false);
  assert.match(missing.message, /WARNING: Pi model catalog not found at .*absent/);
  assert.equal(missing.rates.lookup("deepseek", "deepseek-flash"), null);

  const none = openPiCatalog({ PATH: tmpDir("pomtreed-empty-") }, "deepseek", "/nonexistent-home");
  assert.equal(none.found, false);
  assert.match(none.message, new RegExp(`set ${CATALOG_DIR_ENV}`));
});

test("piAgentDir honours PI_CODING_AGENT_DIR", () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/a" }, "/h"), "/a");
  assert.equal(piAgentDir({}, "/h"), "/h/.pi/agent");
});
