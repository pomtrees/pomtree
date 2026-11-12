import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIG_ENV_EXCLUSIONS, CONFIG_REGISTRY, isSensitive, parseSandboxManifest, secretFileEnv } from "@pomtree/core";
import { CONFIG_DOCS_BEGIN, CONFIG_DOCS_END, composeManifests, configDocsText, spliceConfigDocs } from "../../core/scripts/config-docs.ts";
import { ROOT } from "./env-scan.ts";

const DOC = readFileSync(join(ROOT, "docs", "configuration.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "examples", "hn-digest", "manifest.json"), "utf8"));
const composed = composeManifests(CONFIG_REGISTRY, [manifest]);
// The built-in sandbox backends, read from packages/sandbox-<name>/manifest.json exactly as scripts/gen-config.ts reads them.
const backends = readdirSync(join(ROOT, "packages"))
  .filter((dir) => dir.startsWith("sandbox-"))
  .sort()
  .flatMap((dir) => {
    let text: string;
    try {
      text = readFileSync(join(ROOT, "packages", dir, "manifest.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const parsed = parseSandboxManifest(`@pomtree/${dir}`, JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.backends;
  });
const generated = configDocsText(CONFIG_REGISTRY, composed, CONFIG_ENV_EXCLUSIONS, backends);

test("the docs/configuration.md parameter reference matches the registry and the hn-digest manifest (regenerate: pnpm gen:config)", () => {
  assert.equal(DOC, spliceConfigDocs(DOC, generated));
});

test("the docs carry a section per built-in sandbox backend; a doc without one is stale", () => {
  assert.ok(backends.length >= 2, "the docker and podman manifests are read");
  for (const b of backends) assert.ok(DOC.includes(`##### \`sandbox.${b.id}\``), `${b.id} has a section`);
  const stale = DOC.replace(/##### `sandbox\.podman`[\s\S]*?(?=\n#### |\n##### |\n<!-- END)/, "");
  assert.notEqual(stale, DOC);
  assert.notEqual(stale, spliceConfigDocs(stale, generated));
});

test("the generated reference names every core key, extension key, secret file and documented exclusion", () => {
  const section = DOC.slice(DOC.indexOf(CONFIG_DOCS_BEGIN), DOC.indexOf(CONFIG_DOCS_END));
  for (const p of composed.params) {
    const env = composed.envOf.get(p.path) as string;
    assert.ok(section.includes(`| \`${p.path}\` |`), `${p.path} has a row`);
    assert.ok(section.includes(`\`${isSensitive(p) ? secretFileEnv(env) : env}\``), `${p.path} shows its env name`);
  }
  for (const x of CONFIG_ENV_EXCLUSIONS) assert.ok(section.includes(`\`${x.prefix ? `${x.name}*` : x.name}\``), `${x.name} is listed`);
  for (const name of ["POMTREED_STATE_GRANTS", "POMTREED_STATE_LIMITS"]) assert.ok(section.includes(`\`${name}\``), `${name} is listed`);
});

test("the splice refuses a document without ordered markers", () => {
  assert.throws(() => spliceConfigDocs("no markers", generated));
  assert.throws(() => spliceConfigDocs(`${CONFIG_DOCS_END}\n${CONFIG_DOCS_BEGIN}`, generated));
});
