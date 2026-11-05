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

test("refreshMirror reports a diverged operator branch; a stale push cannot erase the engine's merge commit", { skip }, async () => {
  const base = tmpDir("stale-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "one");
  const mirror = join(base, "mirror.git");
  const ws = new GitWorkspace({ repoDir: repo, mirrorDir: mirror, foldersRoot: join(base, "f"), tmpRoot: join(base, "t") });
  assert.deepEqual(await ws.refreshMirror(), { diverged: [] });
  const one = git(repo, "rev-parse", "HEAD");
  // diverge: the mirror's main moves (the engine), then the operator's main moves elsewhere
  const merged = git(mirror, "commit-tree", git(mirror, "rev-parse", `${one}^{tree}`), "-p", one, "-m", "engine");
  git(mirror, "update-ref", "refs/heads/main", merged, one);
  writeFileSync(join(repo, "a.txt"), "2");
  git(repo, "commit", "-qam", "two");
  assert.deepEqual(await ws.refreshMirror(), { diverged: ["refs/heads/main"] });
  assert.equal(git(mirror, "rev-parse", "refs/heads/main"), merged);
  // a stale push: the agent's old bundle arrives after the engine advanced its ref
  const dir = join(base, "clone");
  execFileSync("git", ["clone", "-q", repo, dir]);
  git(dir, "checkout", "-q", "-B", "agent/a", one);
  writeFileSync(join(dir, "w.txt"), "w");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "w");
  const bundle = join(base, "a.bundle");
  git(dir, "bundle", "create", bundle, "agent/a", `^${one}`);
  const bytes = readFileSync(bundle);
  const stream = () =>
    (async function* () {
      yield bytes;
    })();
  assert.equal((await ws.ingest("a", stream(), { maxBytes: 1 << 20 })).ok, true);
  const ref = "refs/agents/a/heads/agent/a";
  const tip = git(mirror, "rev-parse", ref);
  const engine = git(mirror, "commit-tree", git(mirror, "rev-parse", `${tip}^{tree}`), "-p", tip, "-m", "merge");
  git(mirror, "update-ref", ref, engine, tip);
  const again = await ws.ingest("a", stream(), { maxBytes: 1 << 20 });
  assert.equal(again.ok === false && again.code, "non_fast_forward");
  assert.equal(git(mirror, "rev-parse", ref), engine);
});
