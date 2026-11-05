import assert from "node:assert/strict";
import { test } from "node:test";
import { EXTENSION_API_VERSION, MESSAGING_API_VERSION } from "./index.ts";

// The public contract versions start at 1 for the first release: pre-release bumps were reset, not carried as history
// (CLAUDE.md, no legacy version numbers). After the release, a deliberate incompatible change bumps a version and updates
// this pin together with every consumer (manifests, adapters' EXPECTED_MESSAGING_API, docs/extending.md).
test("the extension and messaging API versions are 1 for the first release", () => {
  assert.equal(EXTENSION_API_VERSION, 1);
  assert.equal(MESSAGING_API_VERSION, 1);
});
