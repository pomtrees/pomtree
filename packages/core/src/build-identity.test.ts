import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBuildIdentity, resolveBuildIdentity } from "./build-identity.ts";

// A scripted git: answers by subcommand and records every call.
function fakeGit(answers: { revParse?: string; status?: string }) {
  const calls: string[][] = [];
  const git = (args: readonly string[]) => {
    calls.push([...args]);
    return args[0] === "rev-parse" ? answers.revParse : args[0] === "status" ? answers.status : undefined;
  };
  return { git, calls };
}

test("a clean checkout formats as v<version> (<sha>)", () => {
  const { git, calls } = fakeGit({ revParse: "abc1234\n", status: "" });
  const id = resolveBuildIdentity({ version: "0.1.0", stamped: undefined, git });
  assert.deepEqual(id, { version: "0.1.0", revision: "abc1234", dirty: false });
  assert.equal(formatBuildIdentity(id), "v0.1.0 (abc1234)");
  assert.deepEqual(calls, [
    ["rev-parse", "--short", "HEAD"],
    ["status", "--porcelain", "--untracked-files=no"],
  ]);
});

test("tracked changes mark the build dirty with an asterisk on the version", () => {
  const { git } = fakeGit({ revParse: "abc1234", status: " M packages/pomtreed/src/main.ts\n" });
  const id = resolveBuildIdentity({ version: "0.1.0", stamped: undefined, git });
  assert.equal(id.dirty, true);
  assert.equal(formatBuildIdentity(id), "v0.1.0* (abc1234)");
});

test("whitespace-only status output or a failed status is not dirty", () => {
  for (const status of ["  \n", undefined]) {
    const { git } = fakeGit({ revParse: "abc1234", status });
    assert.equal(resolveBuildIdentity({ version: "0.1.0", stamped: undefined, git }).dirty, false, JSON.stringify(status));
  }
});

test("a stamped revision wins over git, implies clean, and never runs git", () => {
  const { git, calls } = fakeGit({ revParse: "fff0000", status: " M x" });
  const id = resolveBuildIdentity({ version: "0.1.0", stamped: "def5678\n", git });
  assert.deepEqual(id, { version: "0.1.0", revision: "def5678", dirty: false });
  assert.equal(formatBuildIdentity(id), "v0.1.0 (def5678)");
  assert.deepEqual(calls, []);
});

test("a stamped file's first line is the revision; an empty stamp falls back to git", () => {
  assert.equal(resolveBuildIdentity({ version: "0.1.0", stamped: " def5678 \nignored\n", git: fakeGit({}).git }).revision, "def5678");
  const { git } = fakeGit({ revParse: "abc1234", status: "" });
  assert.equal(resolveBuildIdentity({ version: "0.1.0", stamped: "\n", git }).revision, "abc1234");
});

test("no stamp and no git yields an unknown revision", () => {
  const { git, calls } = fakeGit({});
  const id = resolveBuildIdentity({ version: "0.1.0", stamped: undefined, git });
  assert.deepEqual(id, { version: "0.1.0", revision: undefined, dirty: false });
  assert.equal(formatBuildIdentity(id), "v0.1.0 (unknown revision)");
  assert.deepEqual(calls, [["rev-parse", "--short", "HEAD"]], "no dirty check without a revision");
});

test("an unreadable version is named, not dropped", () => {
  assert.equal(formatBuildIdentity({ version: undefined, revision: "abc1234", dirty: true }), "unknown version* (abc1234)");
  assert.equal(resolveBuildIdentity({ version: " ", stamped: "abc1234", git: fakeGit({}).git }).version, undefined);
});
