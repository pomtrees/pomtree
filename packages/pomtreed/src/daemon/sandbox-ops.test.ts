import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostId, SandboxId } from "@pomtree/core";
import { sandboxOpKey, sandboxOwner } from "./sandbox-ops.ts";

const deps = { hostId: "h1" as HostId, storeId: "s1" };

test("sandboxOwner: a numeric epoch string becomes the owner's epoch; a missing storeId is empty", () => {
  assert.deepEqual(sandboxOwner(deps, "1700000000000"), { host: "h1", storeId: "s1", epoch: 1_700_000_000_000 });
  assert.equal(sandboxOwner({ hostId: deps.hostId }, "5").storeId, "");
});

test("sandboxOwner: a non-numeric epoch throws with the cause and the action instead of yielding NaN", () => {
  for (const bad of ["", "abc", "12x", "-1", "1.5", " 7", "NaN"]) {
    assert.throws(
      () => sandboxOwner(deps, bad),
      (e: unknown) => e instanceof Error && /daemon epoch/.test(e.message) && /non-negative integer/.test(e.message) && /restart/.test(e.message),
      bad,
    );
  }
});

test("sandboxOpKey: names the sandbox and the operation, so two sandboxes or two operations never share a key", () => {
  const a = "sb-a" as SandboxId;
  const b = "sb-b" as SandboxId;
  assert.equal(sandboxOpKey("kill", a), "sandbox:sb-a:kill");
  assert.notEqual(sandboxOpKey("kill", a), sandboxOpKey("kill", b));
  assert.notEqual(sandboxOpKey("kill", a), sandboxOpKey("stop", a));
});
