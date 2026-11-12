// Regenerates everything derived from the config registry: packages/core/config.schema.json, every generated
// container-contract.gen.ts copy (SHIPPED_CONTRACT_COPIES) and the parameter reference tables in docs/configuration.md (between the
// CONFIG_DOCS_BEGIN and CONFIG_DOCS_END markers, composed with the examples/hn-digest manifest). Run `pnpm gen:config` (node packages/core/scripts/gen-config.ts).
// The regenerate-and-compare tests (core src/config/schema.test.ts and container-gen.test.ts, e2e config-docs-drift.test.ts, plus one per owning package) fail
// until the checked-in files match. A file whose bytes already match is left untouched, so a second run changes nothing.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTAINER_READER_SOURCE_PATH, SHIPPED_CONTRACT_COPIES, containerContractText } from "../src/config/container-gen.ts";
import { CONFIG_ENV_EXCLUSIONS } from "../src/config/exclusions.ts";
import { CONFIG_REGISTRY } from "../src/config/params.ts";
import { configSchemaText } from "../src/config/schema.ts";
import { parseSandboxManifest } from "../src/config/sandbox-manifest.ts";
import { composeManifests, configDocsText, spliceConfigDocs } from "./config-docs.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const write = (path: string, text: string): void => {
  let prior: string | null = null;
  try {
    prior = readFileSync(path, "utf8");
  } catch {}
  if (prior === text) {
    console.log(`unchanged ${path}`);
    return;
  }
  writeFileSync(path, text);
  console.log(`wrote ${path}`);
};

write(join(import.meta.dirname, "..", "config.schema.json"), configSchemaText(CONFIG_REGISTRY));
const contract = containerContractText(CONFIG_REGISTRY, readFileSync(CONTAINER_READER_SOURCE_PATH, "utf8"));
for (const copy of SHIPPED_CONTRACT_COPIES) write(join(root, copy), contract);

// Built-in sandbox backends declare their keys in packages/sandbox-<name>/manifest.json (parseSandboxManifest); a package without one declares none.
const backends = readdirSync(join(root, "packages"))
  .filter((dir) => dir.startsWith("sandbox-"))
  .sort()
  .flatMap((dir) => {
    let text: string;
    try {
      text = readFileSync(join(root, "packages", dir, "manifest.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`cannot read packages/${dir}/manifest.json: ${e instanceof Error ? e.message : String(e)}; fix its permissions or remove it`);
    }
    const parsed = parseSandboxManifest(`@pomtree/${dir}`, JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.backends;
  });
const manifest = JSON.parse(readFileSync(join(root, "examples", "hn-digest", "manifest.json"), "utf8"));
const docsPath = join(root, "docs", "configuration.md");
const docs = configDocsText(CONFIG_REGISTRY, composeManifests(CONFIG_REGISTRY, [manifest]), CONFIG_ENV_EXCLUSIONS, backends);
write(docsPath, spliceConfigDocs(readFileSync(docsPath, "utf8"), docs));
