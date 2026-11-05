import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openStore } from "./store.ts";
import { tmpDir } from "@pomtree/testing";

test("workspace cleanup markers are idempotent and survive a reopen", () => {
  const dir = tmpDir("store-cleanup-");
  const file = join(dir, "s.sqlite");
  let s = openStore(file);
  assert.deepEqual(s.workspaceCleanup.cleanedAgents(), new Set());
  s.workspaceCleanup.markPruned("a1", 1);
  s.workspaceCleanup.markCleaned("a1", 2);
  s.workspaceCleanup.markCleaned("a1", 2); // repeat is a no-op, not an error
  s.workspaceCleanup.markPruned("a2", 3);
  assert.deepEqual(s.workspaceCleanup.cleanedAgents(), new Set(["a1"]));
  assert.deepEqual(s.workspaceCleanup.prunedAgents(), new Set(["a2"]));
  s.workspaceCleanup.markCleaned("a2", 4);
  assert.deepEqual(s.workspaceCleanup.cleanedAgents(), new Set(["a1", "a2"]));
  assert.deepEqual(s.workspaceCleanup.prunedAgents(), new Set());
  s.close();

  s = openStore(file);
  assert.deepEqual(s.workspaceCleanup.cleanedAgents(), new Set(["a1", "a2"]));
  s.close();
});
