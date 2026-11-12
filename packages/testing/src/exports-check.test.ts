import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as barrel from "./index.ts";
import { PUBLIC_SANDBOX_TOOLKIT_EXPORTS } from "./exports-check.ts";
import { scaled } from "./timing.ts";

const pkgDir = join(import.meta.dirname, "..");

test("every promised sandbox toolkit name is exported at runtime from the package barrel", () => {
  const missing = PUBLIC_SANDBOX_TOOLKIT_EXPORTS.filter((n) => typeof (barrel as Record<string, unknown>)[n] === "undefined");
  assert.deepEqual(
    missing,
    [],
    `${missing.join(", ")} missing from packages/testing/src/index.ts: restore its export line, or remove the name from exports-check.ts if the author docs no longer promise it`,
  );
  assert.equal(new Set(PUBLIC_SANDBOX_TOOLKIT_EXPORTS).size, PUBLIC_SANDBOX_TOOLKIT_EXPORTS.length, "a name is listed twice in PUBLIC_SANDBOX_TOOLKIT_EXPORTS");
});

test("the two fault plans are distinct classes under distinct names", () => {
  assert.notEqual(barrel.FaultPlan, barrel.ProviderFaultPlan);
});

test("the package's only entry point is the barrel", () => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports: Record<string, string> };
  assert.deepEqual(pkg.exports, { ".": "./src/index.ts" });
});

test("negative: a name missing from the barrel stops the type check with TS2305", () => {
  const root = join(pkgDir, "..", "..");
  const tsc = join(root, "node_modules", "typescript", "lib", "tsc.js");
  const r = spawnSync(process.execPath, [tsc, "--noEmit", "--incremental", "false", "-p", join(pkgDir, "tsconfig.exports-negative.json")], {
    cwd: root,
    encoding: "utf8",
    timeout: Math.min(scaled(30_000), 90_000),
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, `the fixture that reads an unexported name must not compile; tsc printed: ${out}`);
  assert.match(out, /exports-negative\.ts.*error TS2305/);
  assert.match(out, /notExportedByTheBarrel/);
});
