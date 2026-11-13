import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "@pomtree/testing";
import { GitWorkspace, PublishRefusedError, evaluateGitVersion } from "./workspace.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gitVersion.warning ? `real-git tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;

const SAFE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...SAFE, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}
const has = (repo: string, oid: string) => {
  try {
    git(repo, "cat-file", "-e", `${oid}^{commit}`);
    return true;
  } catch {
    return false;
  }
};
const heads = (bare: string) => git(bare, "for-each-ref", "--format=%(refname)");

function setup(o: { allowLocalPublishRemotes?: boolean } = {}) {
  const base = tmpDir("wspub-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "one");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "init");
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const tmp = join(base, "tmp");
  const mirror = join(base, "mirror.git");
  const open = (extra: Partial<ConstructorParameters<typeof GitWorkspace>[0]> = {}) =>
    new GitWorkspace({ repoDir: repo, mirrorDir: mirror, foldersRoot: join(base, "folders"), tmpRoot: tmp, ...o, ...extra });
  return { base, repo, remote, tmp, mirror, ws: open(), open, baseCommit: git(repo, "rev-parse", "HEAD") };
}
type Env = ReturnType<typeof setup>;

const stream = (b: Uint8Array) =>
  (async function* () {
    yield b;
  })();

// The agent commits on top of `from` in a clone of the operator repo and pushes (ingests) its branch.
async function agentCommit(env: Env, agent: string, from: string, file: string): Promise<string> {
  const dir = join(env.base, `clone-${agent}`);
  execFileSync("git", ["clone", "-q", env.repo, dir]);
  git(dir, "checkout", "-q", "-B", `agent/${agent}`, from);
  writeFileSync(join(dir, file), agent);
  git(dir, "add", file);
  git(dir, "commit", "-qm", `work ${agent}`);
  const out = join(env.base, `${agent}.bundle`);
  git(dir, "bundle", "create", out, `agent/${agent}`, `^${env.baseCommit}`);
  const r = await env.ws.ingest(agent, stream(readFileSync(out)), { maxBytes: 1 << 20 });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  return git(dir, "rev-parse", "HEAD");
}

// A commit on the operator's `feature` branch that reached the remote, was fetched (origin/feature), then deleted remotely.
function staleFeature(env: Env): string {
  git(env.repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(env.repo, "secret.txt"), "unreviewed");
  git(env.repo, "add", "secret.txt");
  git(env.repo, "commit", "-qm", "feature");
  const s = git(env.repo, "rev-parse", "HEAD");
  git(env.repo, "push", "-q", "origin", "feature");
  git(env.repo, "fetch", "-q", "origin");
  git(env.repo, "checkout", "-q", "main");
  execFileSync("git", ["--git-dir", env.remote, "update-ref", "-d", "refs/heads/feature"]);
  execFileSync("git", ["--git-dir", env.remote, "gc", "-q", "--prune=now"]);
  return s;
}

test("publish-pin: a stale remote-tracking ref cannot smuggle unreviewed commits; the remote is untouched", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true });
  const s = staleFeature(env);
  await env.ws.refreshMirror();
  const c = await agentCommit(env, "a1", s, "work.txt");
  assert.equal(has(env.remote, s), false, "precondition: the remote no longer holds the feature commit");
  // The pin's boundary the remote no longer holds is refused: the push would deliver commits the review did not cover.
  await assert.rejects(env.ws.publish("a1", { commit: c, remote: "origin", target: "feature", reviewed: { exclude: [s] } }), (e: Error) => {
    assert.ok(e instanceof PublishRefusedError);
    assert.match(e.message, /1 commit\(s\) the publish review did not cover.*fetch the remote and request the publish again/);
    return true;
  });
  assert.equal(heads(env.remote), "refs/heads/main");
  assert.equal(has(env.remote, c), false);
  assert.equal(has(env.remote, s), false);
  // An explicitly empty boundary says the whole history was reviewed (the workspace derives none from the operator's remote-tracking
  // refs): the same push is not refused and goes out.
  await env.ws.publish("a1", { commit: c, remote: "origin", target: "feature", reviewed: { exclude: [] } });
  assert.equal(git(env.remote, "rev-parse", "refs/heads/feature"), c);
  // An explicit full-history review, and a boundary the remote does hold, both pass; a replay is up to date.
  await env.ws.publish("a1", { commit: c, remote: "origin", target: "feature", reviewed: { exclude: [] } });
  await env.ws.publish("a1", { commit: c, remote: "origin", target: "feature", reviewed: { exclude: [env.baseCommit] } });
  await assert.rejects(env.ws.publish("a1", { commit: c, remote: "origin", target: "x", reviewed: { exclude: ["main"] } }), /full commit ids/);
});

test("publish-pin: never forced; a non-fast-forward target is rejected and keeps its tip", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true });
  await env.ws.refreshMirror();
  const c = await agentCommit(env, "f1", env.baseCommit, "f.txt");
  const other = join(env.base, "other");
  execFileSync("git", ["clone", "-q", env.remote, other]);
  writeFileSync(join(other, "o.txt"), "o");
  git(other, "add", "o.txt");
  git(other, "commit", "-qm", "theirs");
  git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
  const theirs = git(other, "rev-parse", "HEAD");
  await assert.rejects(env.ws.publish("f1", { commit: c, remote: env.remote, target: "main", reviewed: { exclude: [] } }), (e: Error) => {
    assert.doesNotMatch(e.message, new RegExp(env.base), "the remote path is redacted");
    assert.match(e.message, /<remote>/);
    return true;
  });
  assert.equal(git(env.remote, "rev-parse", "refs/heads/main"), theirs);
});

test("publish-pin: the operator's push.followTags and url rewrites cannot add tags or change the transport", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true });
  await env.ws.refreshMirror();
  const c = await agentCommit(env, "t1", env.baseCommit, "t.txt");
  execFileSync("git", ["--git-dir", env.mirror, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", "v1", "-m", "tag", c]);
  const home = join(env.base, "home");
  mkdirSync(home);
  const sentinel = join(env.base, "pwned");
  writeFileSync(
    join(home, ".gitconfig"),
    `[push]\n\tfollowTags = true\n[url "ext::sh -c touch% ${sentinel}"]\n\tinsteadOf = https://evil.invalid/\n[url "${env.remote}"]\n\tinsteadOf = https://local.invalid/\n`,
  );
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    // Control: a plain push honouring that config does follow the tag, so the assertion below is meaningful.
    const ctl = join(env.base, "control.git");
    execFileSync("git", ["init", "-q", "--bare", ctl]);
    execFileSync("git", ["--git-dir", env.mirror, "-c", "core.hooksPath=/dev/null", "push", "-q", ctl, `${c}:refs/heads/x`], {
      env: { ...process.env, HOME: home },
    });
    assert.match(git(ctl, "for-each-ref", "--format=%(refname)"), /refs\/tags\/v1/);

    await env.ws.publish("t1", { commit: c, remote: env.remote, target: "t", reviewed: { exclude: [] } });
    assert.equal(heads(env.remote), "refs/heads/main\nrefs/heads/t", "no tag, no other ref");

    await assert.rejects(env.ws.publish("t1", { commit: c, remote: "https://evil.invalid/x", target: "t" }));
    assert.equal(existsSync(sentinel), false, "an ext:: url rewrite never runs");
    const strict = env.open({ allowLocalPublishRemotes: false });
    await assert.rejects(strict.publish("t1", { commit: c, remote: "https://local.invalid/x", target: "u" }));
    assert.equal(heads(env.remote), "refs/heads/main\nrefs/heads/t", "a rewrite to a local path is refused when local remotes are off");
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

test("abs-remote: local paths, embedded credentials and option-like hosts are refused with cause and action", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const c = await agentCommit(env, "r1", env.baseCommit, "r.txt");
  const refuse = async (remote: string, why: RegExp) => {
    await assert.rejects(env.ws.publish("r1", { commit: c, remote, target: "x", reviewed: { exclude: [] } }), (e: Error) => {
      assert.match(e.message, /^invalid publish remote: /);
      assert.match(e.message, why);
      assert.doesNotMatch(e.message, /s3cret/);
      return true;
    });
  };
  await refuse(env.remote, /a local path; publish to an https:\/\/.*allowLocalPublishRemotes/);
  await refuse("origin", /a local path/); // a NAME that resolves to a local path
  await refuse("https://bob:s3cret@example.invalid/r.git", /credentials embedded in the URL; configure a credential helper/);
  await refuse("ssh://-oProxyCommand=touch%20x/r", /host must start with/);
  await refuse("git@-oProxyCommand=x:r", /only https:\/\//);
  await refuse("file:///tmp/r.git", /only https:\/\//);
  await refuse("ext::sh -c x", /whitespace/);
  await refuse("ext::sh", /only https:\/\//);
  await refuse("../r.git", /only https:\/\//);
  await refuse("https://example.invalid/a b", /whitespace/);
  assert.equal(heads(env.remote), "refs/heads/main");
});

test("fork: a parent folder that changes while it is copied fails the fork closed; a retry after it settles succeeds", { skip }, async () => {
  const env = setup();
  await env.ws.create("p", {});
  const parentDir = join(env.base, "folders", "p");
  let mutate = true;
  const ws = env.open({
    observe: (e) => {
      if (e.phase === "fork_copied" && mutate) writeFileSync(join(parentDir, "late.txt"), "written while stopping");
    },
  });
  await assert.rejects(ws.fork("p", "c"), /the parent's folder changed while it was being copied.*stop the parent and retry the fork/);
  assert.equal(await ws.has("c"), false);
  assert.deepEqual(
    readdirSync(join(env.base, "folders")).filter((n) => n.startsWith(".tmp-")),
    [],
  );
  mutate = false;
  const f = await ws.fork("p", "c");
  assert.equal(existsSync(join(ws.hostPath(f.workspace), "late.txt")), true);
});

test("construction sweeps stale ingest/serve scratch and the mirror's half-written temp files only", { skip }, async () => {
  const env = setup();
  await env.ws.create("live", {});
  const scratch = ["wsq-abc123", "wss-XYZ789"].map((n) => join(env.tmp, n));
  for (const d of scratch) mkdirSync(join(d, "q.git"), { recursive: true });
  const keepTmp = ["wsq-toolong1", "other-dir"].map((n) => join(env.tmp, n));
  for (const d of keepTmp) mkdirSync(d);
  const pack = join(env.mirror, "objects", "pack");
  const strayPack = join(pack, "tmp_0123abcd_pack-abcdef.pack");
  writeFileSync(strayPack, "x");
  const strayMeta = join(env.mirror, "pomtree", "folders", "live.json.0123abcd.tmp");
  writeFileSync(strayMeta, "{");
  const packsBefore = readdirSync(pack).filter((n) => n !== "tmp_0123abcd_pack-abcdef.pack");
  env.open(); // default age: everything fresh is kept
  for (const p of [...scratch, strayPack, strayMeta]) assert.equal(existsSync(p), true, p);
  const ws = env.open({ staleTmpMs: 0 });
  for (const p of [...scratch, strayPack, strayMeta]) assert.equal(existsSync(p), false, p);
  for (const p of keepTmp) assert.equal(existsSync(p), true, p);
  assert.deepEqual(readdirSync(pack), packsBefore);
  assert.equal(await ws.has("live"), true);
});

test("publish-pin: a publish without the pin's reviewed boundary is refused, naming the action; nothing is pushed", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true });
  await env.ws.refreshMirror();
  const c = await agentCommit(env, "n1", env.baseCommit, "n.txt");
  await assert.rejects(env.ws.publish("n1", { commit: c, remote: "origin", target: "feature" }), (e: Error) => {
    assert.ok(e instanceof PublishRefusedError);
    assert.match(e.message, /no reviewed boundary.*pass the publish pin's reviewed boundary; use \{ exclude: \[\] \} when the whole history was reviewed/);
    return true;
  });
  assert.equal(heads(env.remote), "refs/heads/main");
  assert.equal(has(env.remote, c), false);
  await env.ws.publish("n1", { commit: c, remote: "origin", target: "feature", reviewed: { exclude: [] } });
  assert.equal(git(env.remote, "rev-parse", "refs/heads/feature"), c);
});
