import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSetupFacts } from "./facts.ts";
import type { SetupFacts } from "./steps.ts";

const PKG = '{"engines":{"node":">=24"},"packageManager":"pnpm@10.1.0"}';

test("defaultSetupFacts fills every SetupFacts field, optional ones included", () => {
  const facts = defaultSetupFacts(PKG);
  // Exhaustive over the interface: adding a field to SetupFacts fails to compile here until it is listed.
  const keys: Record<keyof SetupFacts, true> = {
    nodeRange: true,
    pnpmVersion: true,
    minGit: true,
    defaultImage: true,
    reapedGraceMs: true,
    sessionDefaultMs: true,
    egressProxyImageEnv: true,
    stateDirEnv: true,
  };
  for (const k of Object.keys(keys) as (keyof SetupFacts)[]) assert.notEqual(facts[k], undefined, k);
  assert.equal(facts.nodeRange, ">=24");
  assert.equal(facts.pnpmVersion, "10.1.0");
});

test("defaultSetupFacts names a missing package.json field", () => {
  assert.throws(() => defaultSetupFacts('{"packageManager":"pnpm@1.0.0"}'), /engines\.node/);
});
