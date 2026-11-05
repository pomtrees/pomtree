import assert from "node:assert/strict";
import test from "node:test";
import { bakedIdentity } from "./build-revision.ts";

const noGit = () => undefined;
const gitAt = (sha: string) => (args: readonly string[]) => (args[0] === "rev-parse" ? `${sha}\n` : "");

test("a REVISION file wins over git and needs no git call", () => {
  const id = bakedIdentity({ version: "0.1.0", stamped: "abc1234\n", git: () => assert.fail("git must not run when REVISION exists") });
  assert.deepEqual(id, { revision: "abc1234", version: "0.1.0", notice: undefined });
});

test("without a REVISION file the revision comes from git, bare of any dirty flag", () => {
  const id = bakedIdentity({ version: "0.1.0", stamped: undefined, git: (a) => (a[0] === "status" ? " M x.ts\n" : "def5678\n") });
  assert.deepEqual(id, { revision: "def5678", version: "0.1.0", notice: undefined });
});

test("negative: neither REVISION nor git bakes an empty revision and names it in one line, without throwing", () => {
  const id = bakedIdentity({ version: "0.1.0", stamped: undefined, git: noGit });
  assert.equal(id.revision, "");
  assert.equal(id.version, "0.1.0");
  assert.match(id.notice ?? "", /^agent image: no revision available/);
  assert.equal(id.notice?.includes("\n"), false);
});

test("an empty or blank REVISION file falls through to git", () => {
  assert.equal(bakedIdentity({ version: "0.1.0", stamped: "\n", git: gitAt("1111111") }).revision, "1111111");
});
