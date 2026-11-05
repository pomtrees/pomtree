import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The agent image builds with the repo ROOT as the Docker build context
// (scripts/build.ts passes `root`), so Docker reads the `.dockerignore` at the
// repo root. A `packages/agent-image/.dockerignore` would NOT be honored:
// Docker only reads the ignore file from the context root. This test guards the
// exclusion set that keeps the repo `node_modules`, `.git`, and other
// build-irrelevant paths out of the build context.
//
// Live check (needs Docker), from the repo root:
//   printf 'FROM busybox\nCOPY . /c\n' | docker build -f - -q -t ctx-probe . &&
//   docker run --rm ctx-probe sh -c 'test ! -e /c/node_modules && test ! -e /c/.git'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerignore = readFileSync(resolve(repoRoot, ".dockerignore"), "utf8");
const patterns = dockerignore
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

test("build-context .dockerignore excludes node_modules, .git, and other build-irrelevant paths", () => {
  assert.ok(patterns.includes("node_modules"), "root node_modules excluded");
  assert.ok(patterns.includes("**/node_modules"), "workspace node_modules excluded");
  assert.ok(patterns.includes(".git"), ".git excluded");
  assert.ok(patterns.includes("*.tsbuildinfo"), "root tsbuildinfo excluded");
  assert.ok(patterns.includes("**/*.tsbuildinfo"), "workspace tsbuildinfo excluded");
  assert.ok(patterns.includes(".pomtreed"), "root .pomtreed excluded");
  assert.ok(patterns.includes("**/.pomtreed"), "workspace .pomtreed excluded");
  assert.ok(patterns.includes("*.sqlite*"), "root sqlite excluded");
  assert.ok(patterns.includes("**/*.sqlite*"), "workspace sqlite excluded");
});
