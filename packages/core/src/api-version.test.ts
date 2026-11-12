import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTENSION_API_VERSION, MESSAGING_API_VERSION } from "./index.ts";

// The public contract versions are pinned here. A deliberate incompatible change bumps a version and updates this pin together
// with every consumer (manifests, adapters' EXPECTED_MESSAGING_API, docs/extending.md). The extension version is 2 because the
// manifest gained `provides` (a deliberate pre-release bump; 1 is not kept as a readable legacy version).
test("the extension API version is 2 (manifest `provides`) and the messaging API version is 1", () => {
  assert.equal(EXTENSION_API_VERSION, 2);
  assert.equal(MESSAGING_API_VERSION, 1);
});
