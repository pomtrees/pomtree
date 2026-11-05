import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "@pomtree/testing";
import { GitWorkspace, evaluateGitVersion } from "./workspace.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
// The ingest pipeline needs git >= 2.38; below that the suite skips with this reason.
const skip: string | false = gitVersion.warning ? `real-git tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;

const SAFE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...SAFE, ...args], { cwd, encoding: "utf8" }).trim();
}
const stream = (b: Uint8Array) =>
  (async function* () {
    yield b;
  })();

// An agent whose branch is in the mirror, the mirror ref then advanced to a commit the controller wrote (standing in for a
// merge commit), and a second bundle for the same branch that does not descend from that commit.
async function diverged() {
  const base = tmpDir("wsgit-force-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "one");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "init");
  const mirror = join(base, "mirror.git");
  const ws = new GitWorkspace({ repoDir: repo, mirrorDir: mirror, foldersRoot: join(base, "folders"), tmpRoot: join(base, "tmp") });
  const baseCommit = git(repo, "rev-parse", "HEAD");
  let n = 0;
  const work = (file: string) => {
    const dir = join(base, `scratch-${++n}`);
    execFileSync("git", ["clone", "-q", repo, dir]);
    git(dir, "checkout", "-q", "-B", "agent/a1", baseCommit);
    writeFileSync(join(dir, file), file);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `work ${file}`);
    const out = join(base, `b-${n}.bundle`);
    git(dir, "bundle", "create", out, "agent/a1", `^${baseCommit}`);
    return { bytes: readFileSync(out), commit: git(dir, "rev-parse", "HEAD") };
  };
  await ws.create("a1", {});
  const first = work("first.txt");
  assert.equal((await ws.ingest("a1", stream(first.bytes), { maxBytes: 1 << 20 })).ok, true);
  const ref = "refs/agents/a1/heads/agent/a1";
  assert.equal(git(mirror, "rev-parse", ref), first.commit);
  // The controller's commit: a child of the agent's tip, written straight into the mirror.
  const controller = git(mirror, "commit-tree", `${first.commit}^{tree}`, "-p", first.commit, "-m", "controller merge");
  git(mirror, "update-ref", ref, controller, first.commit);
  const divergent = work("second.txt");
  return { ws, mirror, ref, controller, divergent };
}

test("ingest without force refuses a non-descendant update and the controller's commit stays the tip", { skip }, async () => {
  const d = await diverged();
  const r = await d.ws.ingest("a1", stream(d.divergent.bytes), { maxBytes: 1 << 20 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "non_fast_forward", r.message);
  assert.equal(git(d.mirror, "rev-parse", d.ref), d.controller);
  git(d.mirror, "cat-file", "-e", d.controller); // throws if the object is gone
  assert.equal(git(d.mirror, "rev-list", "--all").includes(d.divergent.commit), false, "the refused push landed nothing in the mirror");
});

test("ingest with force moves the ref and reports the overwritten tip exactly", { skip }, async () => {
  const d = await diverged();
  const r = await d.ws.ingest("a1", stream(d.divergent.bytes), { maxBytes: 1 << 20, force: true });
  assert.equal(r.ok, true);
  if (!r.ok || !r.forced) return assert.fail("expected a forced success");
  assert.deepEqual(r.forcedFrom, [{ ref: d.ref, from: d.controller, to: d.divergent.commit }]);
  assert.equal(git(d.mirror, "rev-parse", d.ref), d.divergent.commit);
  // What `forcedFrom` is for: no ref names the controller's commit any more, and the mirror keeps no reflog of the ref
  // (bare repo, and every controller git call runs with gc.auto=0), so its object survives but only a record can name it.
  assert.equal(git(d.mirror, "rev-list", "--all").includes(d.controller), false, "the controller's commit is unreachable after the force");
  git(d.mirror, "cat-file", "-e", d.controller); // the object itself survives: recoverable from `from`
});
