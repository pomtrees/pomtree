import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ALLOWLIST_PROFILES } from "@pomtree/core";
import { SPECIALIST_EXT, SPECIALIST_TOOLS } from "../ext/pomtree-specialist/specialist-contract.ts";
import { ALLOWLIST_PROFILE_TOOLS } from "./allowlist-profiles.ts";

const EXT_DIR = "/opt/pomtree/ext/";

test("every closed profile names an extension the image ships: the Dockerfile copies ext/ to /opt/pomtree/ext whole", () => {
  assert.deepEqual(Object.keys(ALLOWLIST_PROFILE_TOOLS).sort(), [...ALLOWLIST_PROFILES].sort());
  for (const profile of ALLOWLIST_PROFILES) {
    const { extension, tools } = ALLOWLIST_PROFILE_TOOLS[profile];
    assert.ok(extension.startsWith(EXT_DIR), profile);
    const name = extension.slice(EXT_DIR.length);
    assert.match(name, /^[a-z_-]+$/, profile);
    assert.ok(existsSync(join(import.meta.dirname, "..", "ext", name, "index.ts")), `${profile}: ext/${name}/index.ts`);
    assert.ok(tools.length > 0 && tools.every((t) => !["bash", "read", "write", "edit"].includes(t)), profile);
  }
});

test("the specialist profile is exactly its three tools from its own extension", () => {
  assert.deepEqual(ALLOWLIST_PROFILE_TOOLS.specialist, { tools: SPECIALIST_TOOLS, extension: SPECIALIST_EXT });
  assert.deepEqual([...ALLOWLIST_PROFILE_TOOLS.specialist.tools], ["thread_page", "source_page", "post_draft"]);
  assert.equal(ALLOWLIST_PROFILE_TOOLS.specialist.extension, "/opt/pomtree/ext/pomtree-specialist");
});
