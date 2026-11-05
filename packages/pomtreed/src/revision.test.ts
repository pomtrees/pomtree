import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildIdentity, buildVersion, gitSha, imageRevision, revisionMismatch } from "./revision.ts";

test("revisionMismatch is true only when both revisions are known and unequal", () => {
  assert.equal(revisionMismatch(undefined, undefined), false);
  assert.equal(revisionMismatch("abc", undefined), false);
  assert.equal(revisionMismatch(undefined, "abc"), false);
  assert.equal(revisionMismatch("abc", "abc"), false);
  assert.equal(revisionMismatch("abc", "def"), true);
});

test("imageRevision yields undefined when docker errors or the image is absent", () => {
  // A missing docker daemon or a missing image must never throw: both resolve to "unknown".
  assert.equal(imageRevision("pomtree/agent:revision-test-does-not-exist"), undefined);
});

test("gitSha returns a short sha (or undefined outside a checkout)", () => {
  const sha = gitSha();
  assert.ok(sha === undefined || (typeof sha === "string" && sha.length > 0));
});

test("buildVersion names the root package.json version and gitSha's bare revision", () => {
  const rootVersion = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const id = buildIdentity();
  assert.equal(id.version, rootVersion);
  assert.equal(id.revision, gitSha());
  assert.ok(!gitSha()?.includes("*"), "the mismatch comparand never carries the dirty flag");
  assert.match(buildVersion(), /^v\d+\.\d+\.\d+\*? \((?:[0-9a-f]{4,}|unknown revision)\)$/);
});
