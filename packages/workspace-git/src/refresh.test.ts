import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "@pomtree/testing";
import { evaluateGitVersion } from "./git-env.ts";
import { GitWorkspace } from "./workspace.ts";

const gv = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gv.warning ? `needs git >= 2.38 (found ${gv.version ?? "unknown"})` : false;
const SAFE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
const git = (cwd: string, ...a: string[]) => execFileSync("git", [...SAFE, ...a], { cwd, encoding: "utf8" }).trim();

test("refreshMirror fast-forwards from the operator but never rewinds a branch the merge engine advanced", { skip }, async () => {
  const base = tmpDir("refresh-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "one");
  const mirror = join(base, "mirror.git");
  const ws = new GitWorkspace({ repoDir: repo, mirrorDir: mirror, foldersRoot: join(base, "f"), tmpRoot: join(base, "t") });
  await ws.refreshMirror();
  const one = git(repo, "rev-parse", "HEAD");
  assert.equal(git(mirror, "rev-parse", "refs/heads/main"), one);
  // the operator commits: a fast-forward flows in, alongside a new branch
  writeFileSync(join(repo, "a.txt"), "2");
  git(repo, "commit", "-qam", "two");
  git(repo, "branch", "feature");
  await ws.refreshMirror();
  const two = git(repo, "rev-parse", "HEAD");
  assert.deepEqual([git(mirror, "rev-parse", "refs/heads/main"), git(mirror, "rev-parse", "refs/heads/feature")], [two, two]);
  // the engine advances main in the mirror (an approved top-level merge); a refresh must keep it
  const tree = git(mirror, "rev-parse", `${two}^{tree}`);
  const merged = git(mirror, "commit-tree", tree, "-p", two, "-m", "engine merge");
  git(mirror, "update-ref", "refs/heads/main", merged, two);
  await ws.refreshMirror();
  assert.equal(git(mirror, "rev-parse", "refs/heads/main"), merged);
  // other refs still update in the same refresh, and a deleted operator branch is pruned
  writeFileSync(join(repo, "a.txt"), "3");
  git(repo, "checkout", "-q", "feature");
  git(repo, "commit", "-qam", "three");
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-D", "feature");
  git(repo, "branch", "other", "main");
  await ws.refreshMirror();
  assert.equal(git(mirror, "rev-parse", "refs/heads/main"), merged);
  assert.equal(git(mirror, "rev-parse", "refs/heads/other"), two);
  assert.equal(git(mirror, "for-each-ref", "refs/heads/feature"), "");
});
