import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "@pomtree/testing";
import { buildGitInvocation, evaluateGitVersion } from "./git-env.ts";
import { runGit } from "./git-runner.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gitVersion.warning ? `real-git tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;

test("hardened builder allows the file transport but never ext, and callers cannot weaken either", () => {
  const inv = buildGitInvocation(["status"], { path: "/usr/bin" });
  const args = inv.args.join(" ");
  assert.match(args, /protocol\.file\.allow=always/);
  assert.match(args, /protocol\.ext\.allow=never/);
  assert.throws(() => buildGitInvocation(["status"], { path: "/usr/bin" }, { config: ["protocol.file.allow=never"] }), /fixed by the hardened/);
  assert.throws(() => buildGitInvocation(["status"], { path: "/usr/bin" }, { config: ["protocol.ext.allow=always"] }), /fixed by the hardened/);
});

test("real git: the file transport works under the hardened builder while ext:: is refused before it runs", { skip }, async () => {
  const base = tmpDir("wsgit-env-");
  execFileSync("git", ["init", "-q", "--bare", join(base, "m.git")]);
  await runGit(["ls-remote", join(base, "m.git")], { tmpdir: base }); // a local path needs protocol.file.allow=always
  const pwned = join(base, "pwned");
  await assert.rejects(runGit(["ls-remote", `ext::touch% ${pwned}`], { tmpdir: base }));
  assert.equal(existsSync(pwned), false);
});

test("evaluateGitVersion reports a two-part version with patch 0, and keeps a reported patch level", () => {
  assert.deepEqual(evaluateGitVersion("git version 2.40"), { version: "2.40.0", warning: null });
  assert.deepEqual(evaluateGitVersion("git version 2.40.3"), { version: "2.40.3", warning: null });
  assert.match(evaluateGitVersion("git version 2.34").warning ?? "", /^git 2\.34\.0 is older than 2\.38\.0/);
});
