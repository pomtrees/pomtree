// Regression: an agent whose only untracked path is its own Pi session dir (the `session` mount at SESSION_MOUNT_DIR, inside the
// workspace mount) must not be refused by `pomtree result` as "uncommitted work". The dirtiness is decided by the sandbox's in-container
// RESULT_WORK_SCRIPT over the folder GitWorkspace made; here the script runs on the host in that folder (the container stand-in), so
// the folder pomtreed's main.ts would create is checked end to end without Docker.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DockerSandbox } from "@pomtree/sandbox-docker";
import { tmpDir } from "@pomtree/testing";
import { GitWorkspace } from "@pomtree/workspace-git";
import { SESSION_FILE, SESSION_MOUNT_DIR, WORKSPACE_GIT_EXCLUDES, WORKSPACE_MOUNT_DIR } from "./daemon-util.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();

async function folder(infoExclude?: readonly string[]) {
  const base = tmpDir("pomtreed-result-session-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "one");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "init");
  const ws = new GitWorkspace({ repoDir: repo, mirrorDir: join(base, "mirror.git"), foldersRoot: join(base, "folders"), ...(infoExclude && { infoExclude }) });
  const made = await ws.create("agent-1", {});
  const dir = ws.hostPath(made.workspace);
  // What the session bind mount shows inside the container: Pi's session file and the events sink.
  const session = join(dir, SESSION_MOUNT_DIR.slice(WORKSPACE_MOUNT_DIR.length + 1));
  mkdirSync(session);
  writeFileSync(join(session, SESSION_FILE), '{"type":"session"}\n');
  writeFileSync(join(session, "events.jsonl"), "{}\n");
  // `docker exec <container> node -e SCRIPT ARGS`, run on the host with the folder as the container's working directory.
  const sandbox = new DockerSandbox({
    mounts: { resolve: () => Promise.reject(new Error("no mounts in this test")) },
    spawn: (cmd, args) => {
      assert.equal(cmd, "docker");
      return spawn(process.execPath, args.slice(3), { cwd: dir, env: { ...process.env, POMTREE_BASE_COMMIT: made.commit } });
    },
  });
  const work = (opts: { save?: boolean; expectedFingerprint?: string } = {}) => sandbox.resultWork("sandbox", { ...opts, maxBytes: 1024 * 1024 });
  return { dir, work };
}

test("WORKSPACE_GIT_EXCLUDES is the session mount, root-anchored, derived from SESSION_MOUNT_DIR", () => {
  assert.deepEqual(WORKSPACE_GIT_EXCLUDES, ["/.pi-session/"]);
  assert.equal(`${WORKSPACE_MOUNT_DIR}${WORKSPACE_GIT_EXCLUDES[0]}`, `${SESSION_MOUNT_DIR}/`);
});

test("pomtree result's dirtiness check: a folder whose only untracked path is the session dir is clean", async () => {
  const f = await folder(WORKSPACE_GIT_EXCLUDES);
  assert.equal((await f.work()).dirty, false);
});

test("without the exclude the session dir alone reads as uncommitted work (the live 409's cause)", async () => {
  const f = await folder();
  assert.equal((await f.work()).dirty, true);
});

test("real uncommitted work is still refused, and an approved save commits it without the session dir", async () => {
  const f = await folder(WORKSPACE_GIT_EXCLUDES);
  writeFileSync(join(f.dir, "notes.md"), "real work\n");
  const dirty = await f.work();
  assert.equal(dirty.dirty, true);
  const saved = await f.work({ save: true, expectedFingerprint: dirty.fingerprint });
  assert.ok(saved.bundle);
  for await (const _ of saved.bundle) {
    // drain the bundle so the script exits
  }
  assert.equal(git(f.dir, "show", "--name-only", "--format=", "HEAD"), "notes.md");
  assert.equal((await f.work()).dirty, false);
});
