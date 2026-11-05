import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  CONFIG_DEFAULTS,
  CONFIG_REGISTRY,
  CONTAINER_READER_SOURCE_PATH,
  IMAGE_FACTS,
  SHIPPED_CONTRACT_COPIES,
  containerConfigEnv,
  containerContract,
  containerContractText,
  containerDefaults,
  containerParams,
} from "../index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const READER = readFileSync(CONTAINER_READER_SOURCE_PATH, "utf8");
const TEXT = containerContractText(CONFIG_REGISTRY, READER);

test("every shipped container-contract.gen.ts copy matches the registry byte for byte (regenerate: pnpm gen:config)", () => {
  assert.equal(SHIPPED_CONTRACT_COPIES.length, 4);
  for (const copy of SHIPPED_CONTRACT_COPIES) assert.equal(readFileSync(join(ROOT, copy), "utf8"), TEXT, `${copy} is stale: run pnpm gen:config`);
});

test("the generated module embeds the reader verbatim and imports nothing", () => {
  assert.ok(TEXT.includes(READER.trimEnd()));
  assert.ok(!/^import /m.test(TEXT), "no imports: each copy must resolve inside its own COPY set");
  assert.ok(!/^import /m.test(READER));
});

test("the generated module, loaded as the image loads it, carries the registry's contract, facts, bounds and defaults, and reads the producer's document", async () => {
  const gen = (await import(pathToFileURL(join(ROOT, SHIPPED_CONTRACT_COPIES[2])).href)) as Record<string, unknown> & {
    readContainerConfig: (env: Readonly<Record<string, string | undefined>>, opts: { required: boolean }) => Record<string, unknown>;
  };
  assert.equal(gen.CONTAINER_CONTRACT, containerContract(CONFIG_REGISTRY));
  for (const [name, v] of Object.entries(IMAGE_FACTS)) assert.deepEqual(gen[name], v, name);
  assert.deepEqual(gen.CONTAINER_PARAMS, containerParams(CONFIG_REGISTRY));
  assert.deepEqual(gen.CONTAINER_DEFAULTS, containerDefaults(CONFIG_REGISTRY));
  const env = containerConfigEnv(CONFIG_REGISTRY, { ...CONFIG_DEFAULTS, "browser.capture.textMaxBytes": 4096 });
  assert.equal(gen.readContainerConfig(env, { required: true })["browser.capture.textMaxBytes"], 4096);
  assert.deepEqual(gen.readContainerConfig({}, { required: false }), containerDefaults(CONFIG_REGISTRY));
  assert.throws(() => gen.readContainerConfig({}, { required: true }), /PTREE_CONFIG_JSON: not set/);
  const tampered = env.PTREE_CONFIG_JSON.replace(/"contract":"[0-9a-f]{16}"/, '"contract":"0123456789abcdef"');
  assert.throws(() => gen.readContainerConfig({ PTREE_CONFIG_JSON: tampered }, { required: false }), /rebuild the image/);
});
