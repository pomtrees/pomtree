import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFlags } from "./flags.ts";

const spec = { bools: ["--json"], values: ["--repo"] };

test("parseFlags reads boolean flags and both value forms", () => {
  const p = parseFlags(["--json", "--repo", "/a", "--repo=/b"], spec);
  assert.deepEqual(p.errors, []);
  assert.ok(p.bools.has("--json"));
  assert.equal(p.values.get("--repo"), "/b");
});

test("parseFlags reports an unknown flag, a missing value, a value on a boolean and stray positionals", () => {
  const p = parseFlags(["--nope", "--repo", "--json=1", "extra"], spec);
  assert.deepEqual(p.errors, ["unknown option --nope", "--repo needs a value", "--json takes no value"]);
  assert.deepEqual(p.positional, ["extra"]);
});
