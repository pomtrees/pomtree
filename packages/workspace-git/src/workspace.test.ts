import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpDir, workspaceContractBody } from "@pomtree/testing";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { IngestResult } from "@pomtree/core";
import { GitWorkspace, evaluateGitVersion } from "./workspace.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
// The ingest pipeline (and its tests) need git >= 2.38; below that the suite skips with this reason.
const skip: string | false = gitVersion.warning ? `real-git tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;

// Test-side git: plays the operator or the agent inside its container. Hooks and fsmonitor are forced off so
// planting hostile config in a folder never fires from the test's own commands.
const SAFE = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...SAFE, ...args], { cwd, encoding: "utf8" }).trim();
}
function gitIn(cwd: string, input: Buffer, ...args: string[]): string {
  return execFileSync("git", [...SAFE, ...args], { cwd, input, encoding: "utf8" }).trim();
}

function setup(
  opts: { maxObjects?: number; maxUnpackedBytes?: number; maxQuarantineBytes?: number; infoExclude?: string[]; allowLocalPublishRemotes?: boolean } = {},
) {
  const base = tmpDir("wsgit-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "one");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "init");
  const tmp = join(base, "tmp");
  const mirror = join(base, "mirror.git");
  const ws = new GitWorkspace({ repoDir: repo, mirrorDir: mirror, foldersRoot: join(base, "folders"), tmpRoot: tmp, ...opts });
  const baseCommit = git(repo, "rev-parse", "HEAD");
  let n = 0;
  // A scratch clone of the operator repo standing in for an agent's container clone.
  const scratch = () => {
    const d = join(base, `scratch-${++n}`);
    execFileSync("git", ["clone", "-q", repo, d]);
    return d;
  };
  const mirrorRefs = () => git(mirror, "for-each-ref", "--format=%(refname) %(objectname)");
  const mirrorPacks = () =>
    readdirSync(join(mirror, "objects", "pack"))
      .sort()
      .join(",");
  return { base, repo, tmp, mirror, ws, baseCommit, scratch, mirrorRefs, mirrorPacks };
}
type Env = ReturnType<typeof setup>;

const stream = (b: Uint8Array) =>
  (async function* () {
    yield b;
  })();

// Bundle of `branch` in `dir` on top of the operator base, like `pomtree push` builds it.
function bundleOf(env: Env, dir: string, branch: string): Uint8Array {
  const out = join(env.base, `b-${Math.random().toString(36).slice(2)}.bundle`);
  git(dir, "bundle", "create", out, branch, `^${env.baseCommit}`);
  return readFileSync(out);
}

// Commit `file` in a scratch clone and bundle it.
function work(env: Env, branch: string, files: Record<string, string>, dir = env.scratch()): { dir: string; bytes: Uint8Array; commit: string } {
  git(dir, "checkout", "-q", "-B", branch, env.baseCommit);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `work ${branch}`);
  return { dir, bytes: bundleOf(env, dir, branch), commit: git(dir, "rev-parse", "HEAD") };
}

function snapshot(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    out.push(prefix + e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...snapshot(join(dir, e.name), `${prefix}${e.name}/`));
  }
  return out.sort();
}

// What must hold after a refused ingest: nothing in the mirror moved, nothing recorded, quarantine gone.
async function assertRefused(env: Env, agent: string, r: IngestResult, code: string, before: { refs: string; packs: string }) {
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, code, r.message);
  assert.equal(env.mirrorRefs(), before.refs, "a foreign or own ref changed");
  assert.equal(env.mirrorPacks(), before.packs, "the mirror gained objects");
  assert.equal(await env.ws.ingested(agent), null);
  assert.deepEqual(readdirSync(env.tmp), [], "quarantine left behind");
}

async function refusedState(env: Env) {
  await env.ws.create("other", {});
  const o = work(env, "agent/other", { "o.txt": "o" });
  assert.equal((await env.ws.ingest("other", stream(o.bytes), { maxBytes: 1 << 20 })).ok, true);
  return { refs: env.mirrorRefs(), packs: env.mirrorPacks() };
}

test("contract: GitWorkspace passes the Workspace contract suite", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true }); // the suite publishes to a local bare repo
  const remote = join(env.base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  let seq = 0;
  await workspaceContractBody({
    ws: env.ws,
    remote,
    bundle: async (agent, name, o) => {
      const dir = env.ws.hostPath(env.ws.idFor(agent));
      const files = { [`${agent}.txt`]: `${agent} ${++seq}` };
      if (!o?.onTop) {
        const w = work(env, name, files, dir);
        return { bytes: w.bytes, commit: w.commit };
      }
      git(dir, "checkout", "-q", "-B", name, o.onTop);
      for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", `work ${name}`);
      const out = join(env.base, `b-${seq}.bundle`);
      git(dir, "bundle", "create", out, name, `^${env.baseCommit}`);
      return { bytes: readFileSync(out), commit: git(dir, "rev-parse", "HEAD") };
    },
    mainCommit: () => env.baseCommit,
  });
  assert.equal(git(remote, "rev-parse", "refs/heads/out").length, 40);
});

test("create makes a private full clone: no remote, own objects, per-agent identity, base in the mirror", { skip }, async () => {
  const env = setup();
  const a = await env.ws.create("a1", {});
  assert.deepEqual([a.branch, a.commit], ["agent/a1", env.baseCommit]);
  const dir = env.ws.hostPath(a.workspace);
  assert.equal(git(dir, "remote"), "");
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "agent/a1");
  assert.equal(
    execFileSync("git", ["config", "--file", join(dir, ".git", "config"), "user.email"])
      .toString()
      .trim(),
    "a1@agents.pomtree",
  );
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one");
  assert.equal(existsSync(join(dir, ".git", "objects", "info", "alternates")), false);
  assert.equal(existsSync(join(dir, ".git", "hooks")), false); // no template hooks
  assert.equal(git(env.mirror, "cat-file", "-t", a.commit), "commit");
  assert.deepEqual(await env.ws.create("a1", {}), a);
  await assert.rejects(env.ws.create("a1", { fromCommit: "0".repeat(40) }), /invalid reference/);
  for (const bad of ["", "a/b", "..", "-x", ".x"]) await assert.rejects(env.ws.create(bad, {}), /invalid agent id/);
  assert.deepEqual(readdirSync(env.ws.hostPath(a.workspace) + "/.."), ["a1"]); // no leftover temp folders
});

test("create: a repository with no commits says so and names the fix; a bad ref in a repository with commits keeps invalid reference", { skip }, async () => {
  const base = tmpDir("wsgit-empty-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const empty = new GitWorkspace({ repoDir: repo, mirrorDir: join(base, "mirror.git"), foldersRoot: join(base, "folders"), tmpRoot: join(base, "tmp") });
  await assert.rejects(
    empty.create("a1", {}),
    (e: Error) => /no commits/.test(e.message) && /git commit --allow-empty -m init/.test(e.message) && !e.message.includes(base),
  );
  const env = setup();
  await assert.rejects(env.ws.create("a2", { fromCommit: "0".repeat(40) }), (e: Error) => e.message === "invalid reference");
});

test("infoExclude: create and fork write a controller-authored .git/info/exclude, so a host-managed dir is not untracked work and real work still is", {
  skip,
}, async () => {
  const status = (d: string) => git(d, "status", "--porcelain=v1", "--untracked-files=all");
  const env = setup({ infoExclude: ["/.pi-session/"] });
  const p = await env.ws.create("p", {});
  const pd = env.ws.hostPath(p.workspace);
  assert.equal(readFileSync(join(pd, ".git", "info", "exclude"), "utf8"), "/.pi-session/\n");
  mkdirSync(join(pd, ".pi-session"));
  writeFileSync(join(pd, ".pi-session", "session.jsonl"), "{}\n");
  assert.equal(status(pd), ""); // only the session dir: clean
  git(pd, "add", "-A");
  assert.equal(git(pd, "diff", "--cached", "--name-only"), ""); // `git add -A` never stages it
  mkdirSync(join(pd, "sub", ".pi-session"), { recursive: true });
  writeFileSync(join(pd, "sub", ".pi-session", "x"), "work"); // anchored: a nested dir of that name is still work
  writeFileSync(join(pd, "real.txt"), "work");
  assert.equal(status(pd), "?? real.txt\n?? sub/.pi-session/x");
  // The child's exclude is rewritten after sanitising, whatever the parent's folder held.
  writeFileSync(join(pd, ".git", "info", "exclude"), "*\n");
  const c = await env.ws.fork("p", "c");
  const cd = env.ws.hostPath(c.workspace);
  assert.equal(readFileSync(join(cd, ".git", "info", "exclude"), "utf8"), "/.pi-session/\n");
  assert.match(status(cd), /\?\? real\.txt/);
  assert.doesNotMatch(status(cd), /^\?\? \.pi-session/m);
  // Absent option: no exclude file, the session dir is untracked (the pre-fix behaviour the option exists to change).
  const plain = setup();
  const qd = plain.ws.hostPath((await plain.ws.create("q", {})).workspace);
  assert.equal(existsSync(join(qd, ".git", "info", "exclude")), false);
  mkdirSync(join(qd, ".pi-session"));
  writeFileSync(join(qd, ".pi-session", "session.jsonl"), "{}\n");
  assert.equal(status(qd), "?? .pi-session/session.jsonl");
  for (const bad of [[""], ["a\nb"], ["  "]]) assert.throws(() => setup({ infoExclude: bad }), /non-blank single lines/);
});

test("create starts from operator commits made after the mirror was first built", { skip }, async () => {
  const env = setup();
  await env.ws.create("a1", {});
  writeFileSync(join(env.repo, "a.txt"), "two");
  git(env.repo, "commit", "-qam", "second");
  const b = await env.ws.create("a2", {});
  assert.equal(b.commit, git(env.repo, "rev-parse", "HEAD"));
  assert.equal(readFileSync(join(env.ws.hostPath(b.workspace), "a.txt"), "utf8"), "two");
});

test("fork copies the stopped parent's folder bytes: untracked and ignored files, symlinks as links, uncommitted edits", { skip }, async () => {
  const env = setup();
  const p = await env.ws.create("p", {});
  const pd = env.ws.hostPath(p.workspace);
  writeFileSync(join(pd, ".gitignore"), "ign.log\n");
  writeFileSync(join(pd, "ign.log"), "ignored");
  writeFileSync(join(pd, "untracked.txt"), "untracked");
  writeFileSync(join(pd, "a.txt"), "dirty edit");
  symlinkSync("/etc", join(pd, "lnk"));
  const f = await env.ws.fork("p", "c");
  const cd = env.ws.hostPath(f.workspace);
  assert.equal(f.commit, p.commit);
  assert.notEqual(cd, pd);
  assert.equal(readFileSync(join(cd, "ign.log"), "utf8"), "ignored");
  assert.equal(readFileSync(join(cd, "untracked.txt"), "utf8"), "untracked");
  assert.equal(readFileSync(join(cd, "a.txt"), "utf8"), "dirty edit");
  assert.equal(lstatSync(join(cd, "lnk")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(cd, "lnk")), "/etc");
  assert.equal(git(cd, "status", "--porcelain").includes("untracked.txt"), true); // a usable clone
  assert.deepEqual(await env.ws.fork("p", "c"), f); // idempotent
  await assert.rejects(env.ws.fork("ghost", "d"), /no workspace/);
});

test("fork gives the child its own agent/<child> branch at the fork point; the parent's branch is untouched; ingest and re-run are idempotent", {
  skip,
}, async () => {
  const env = setup();
  const p = await env.ws.create("p", {});
  const pd = env.ws.hostPath(p.workspace);
  writeFileSync(join(pd, "p.txt"), "parent local commit");
  git(pd, "add", "-A");
  git(pd, "commit", "-qm", "parent local");
  const forkPoint = git(pd, "rev-parse", "HEAD");
  const f = await env.ws.fork("p", "c");
  const cd = env.ws.hostPath(f.workspace);
  assert.deepEqual([f.branch, f.commit], ["agent/c", p.commit]);
  assert.equal(git(cd, "rev-parse", "--abbrev-ref", "HEAD"), "agent/c");
  assert.equal(git(cd, "rev-parse", "HEAD"), forkPoint);
  assert.equal(git(cd, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/agent/c\nrefs/heads/main");
  assert.equal(
    execFileSync("git", ["config", "--file", join(cd, ".git", "config"), "user.email"])
      .toString()
      .trim(),
    "c@agents.pomtree",
  );
  assert.equal(git(cd, "remote"), "");
  assert.equal(git(pd, "rev-parse", "--abbrev-ref", "HEAD"), "agent/p");
  assert.equal(git(pd, "rev-parse", "HEAD"), forkPoint);
  // The child commits and ships under its own branch name; ingest lands it in the child's namespace.
  writeFileSync(join(cd, "c.txt"), "c");
  git(cd, "add", "-A");
  git(cd, "commit", "-qm", "child work");
  const tip = git(cd, "rev-parse", "HEAD");
  const out = join(env.base, "fork-own-branch.bundle");
  git(cd, "bundle", "create", out, "refs/heads/agent/c", `^${p.commit}`);
  assert.deepEqual(await env.ws.ingest("c", stream(readFileSync(out)), { maxBytes: 1 << 20 }), {
    ok: true,
    refs: [{ ref: "refs/agents/c/heads/agent/c", commit: tip }],
  });
  assert.equal((await env.ws.ingested("c"))?.ref, "refs/agents/c/heads/agent/c");
  // Re-running fork for the same child neither fails nor moves its branch.
  assert.deepEqual(await env.ws.fork("p", "c"), f);
  assert.equal(git(cd, "rev-parse", "HEAD"), tip);
  assert.equal(git(cd, "rev-parse", "--abbrev-ref", "HEAD"), "agent/c");
  assert.equal(git(pd, "rev-parse", "--abbrev-ref", "HEAD"), "agent/p");
});

test("fork: the child's base anchor is seeded, so a child bundle built on a commit reachable only via refs/agents/* is ingested", { skip }, async () => {
  const env = setup();
  await env.ws.create("s0", {});
  const w = work(env, "agent/s0", { "s.txt": "s" }); // reachable only from refs/agents/s0/*
  assert.equal((await env.ws.ingest("s0", stream(w.bytes), { maxBytes: 1 << 20 })).ok, true);
  const p = await env.ws.create("sp", { fromCommit: w.commit });
  const f = await env.ws.fork("sp", "sc");
  assert.equal(git(env.mirror, "rev-parse", "--verify", `refs/agents/sc/base/${w.commit}`), w.commit);
  const dir = env.ws.hostPath(f.workspace);
  writeFileSync(join(dir, "c.txt"), "c");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "child work");
  const tip = git(dir, "rev-parse", "HEAD");
  const out = join(env.base, "fork-seed.bundle");
  git(dir, "bundle", "create", out, "agent/sc", `^${w.commit}`);
  assert.deepEqual(await env.ws.ingest("sc", stream(readFileSync(out)), { maxBytes: 1 << 20 }), {
    ok: true,
    refs: [{ ref: "refs/agents/sc/heads/agent/sc", commit: tip }],
  });
  assert.equal(p.commit, w.commit);
});

test("fork: a parent whose HEAD is off its branch keeps unshipped work: the parent branch name is dropped only when it is an ancestor of the fork point", {
  skip,
}, async () => {
  const env = setup();
  const p = await env.ws.create("op", {});
  const pd = env.ws.hostPath(p.workspace);
  // agent/op holds work; HEAD moves to another branch at the base: agent/op is not an ancestor of HEAD.
  writeFileSync(join(pd, "w.txt"), "w");
  git(pd, "add", "-A");
  git(pd, "commit", "-qm", "work on agent/op");
  const work = git(pd, "rev-parse", "HEAD");
  git(pd, "checkout", "-q", "-b", "side", p.commit);
  const f = await env.ws.fork("op", "oc");
  const cd = env.ws.hostPath(f.workspace);
  assert.equal(git(cd, "rev-parse", "--abbrev-ref", "HEAD"), "agent/oc");
  assert.equal(git(cd, "rev-parse", "HEAD"), p.commit);
  assert.equal(git(cd, "rev-parse", "refs/heads/agent/op"), work); // kept: dropping it would orphan the work
  assert.equal(git(pd, "rev-parse", "--abbrev-ref", "HEAD"), "side");
  // A missing parent branch ref is not an error.
  git(pd, "checkout", "-q", "--detach");
  git(pd, "branch", "-q", "-D", "agent/op");
  const f2 = await env.ws.fork("op", "od");
  assert.equal(git(env.ws.hostPath(f2.workspace), "rev-parse", "--abbrev-ref", "HEAD"), "agent/od");
});

// --- fork copies agent-written bytes: the copy is sanitised before any git runs ---------------------------------

// Byte digest of a tree (types, link targets, contents) to prove a victim is untouched.
function digest(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string, pre: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      h.update(`${pre}${e.name}:${e.isSymbolicLink() ? `L${readlinkSync(p)}` : e.isDirectory() ? "D" : "F"}\n`);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, `${pre}${e.name}/`);
      else h.update(readFileSync(p));
    }
  };
  walk(dir, "");
  return h.digest("hex");
}

async function forkRefused(env: Env, parent: string, child: string) {
  await assert.rejects(env.ws.fork(parent, child), { name: "UnsafeGitDirError" });
  assert.equal(await env.ws.has(child), false);
  assert.deepEqual(
    readdirSync(join(env.base, "folders")).filter((n) => n.includes(child)),
    [],
  );
}

function sentinelScripts(env: Env) {
  const dir = join(env.base, "sent");
  mkdirSync(dir);
  const mk = (n: string) => {
    const f = join(dir, `${n}.sh`);
    writeFileSync(f, `#!/bin/sh\necho ${n} >> ${join(dir, "fired")}\nexit 1\n`, { mode: 0o755 });
    return f;
  };
  return { fired: join(dir, "fired"), ssh: mk("ssh"), up: mk("up") };
}

test("hostile fork: promisor/partialClone config with sshCommand and uploadpack never runs a command (CONFIRMED-EXPLOITABLE under plain git and the old hardened flags)", {
  skip,
}, async (t) => {
  const env = setup();
  const s = sentinelScripts(env);
  const p = await env.ws.create("pp", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  appendFileSync(
    join(gd, "config"),
    `[extensions]\n\tpartialClone = o\n[remote "o"]\n\turl = ${join(env.base, "nonexistent")}\n\tpromisor = true\n\tuploadpack = ${s.up}\n[remote "s"]\n\turl = ssh://h/x\n\tpromisor = true\n[core]\n\tsshCommand = ${s.ssh}\n[include]\n\tpath = /nonexistent\n`,
  );
  git(gd, "config", "core.repositoryformatversion", "1");
  // Control: the old fork flow (hardened flags, rev-parse of a missing HEAD commit) fires the sentinel.
  const ctl = join(env.base, "ctl");
  execFileSync("cp", ["-R", env.ws.hostPath(p.workspace), ctl]);
  writeFileSync(join(ctl, ".git", "HEAD"), `${"1".repeat(40)}\n`);
  try {
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "-C", ctl, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
  } catch {
    // expected failure; only the sentinel matters
  }
  const controlFired = existsSync(s.fired);
  rmSync(s.fired, { force: true });
  writeFileSync(join(gd, "HEAD"), `${"1".repeat(40)}\n`);
  await forkRefused(env, "pp", "pc");
  assert.equal(existsSync(s.fired), false, "a promisor fetch ran a controller-side command");
  // Informational: whether plain git fires the sentinel depends on its version; the hard assertion above is the defence.
  if (!controlFired) t.diagnostic("control: plain git did not fire the sentinel with this git version");
});

test("hostile fork: promisor, sshCommand and uploadpack config with NO extensions header and a MISSING HEAD object never fires (the overwrite is the defence)", {
  skip,
}, async (t) => {
  const env = setup();
  const s = sentinelScripts(env);
  const p = await env.ws.create("pm", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  appendFileSync(
    join(gd, "config"),
    `[remote "o"]\n\turl = ${join(env.base, "nonexistent")}\n\tpromisor = true\n\tuploadpack = ${s.up}\n[remote "s"]\n\turl = ssh://h/x\n\tpromisor = true\n[core]\n\tsshCommand = ${s.ssh}\n`,
  );
  // HEAD names an object the copy does not carry: the fork's first rev-parse would lazy-fetch it from the promisor remote.
  writeFileSync(join(gd, "HEAD"), `${"2".repeat(40)}\n`);
  // Fail-closed by existing semantics: the copy is sanitised, then rev-parse of the missing HEAD makes the fork throw a GitError.
  await assert.rejects(env.ws.fork("pm", "mc"), { name: "GitError" });
  assert.equal(await env.ws.has("mc"), false);
  assert.equal(existsSync(s.fired), false, "a lazy fetch ran a controller-side command");
  // Informational control: plain git with the same config and no hardening of its own.
  const ctl = join(env.base, "ctl-missing");
  execFileSync("cp", ["-R", env.ws.hostPath(p.workspace), ctl]);
  try {
    execFileSync("git", ["-C", ctl, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  } catch {
    // expected failure
  }
  if (!existsSync(s.fired)) t.diagnostic("control: plain git did not fire the sentinel with a missing HEAD and no [extensions]");
});

test("fork removes stale *.lock files under .git from the copy (a parent killed mid-git must not make the fork fail)", { skip }, async () => {
  const env = setup();
  const p = await env.ws.create("pl", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  mkdirSync(join(gd, "refs", "heads", "agent"), { recursive: true });
  for (const rel of ["HEAD.lock", "packed-refs.lock", "index.lock", "config.lock", "shallow.lock", "refs/heads/agent/lc.lock"])
    writeFileSync(join(gd, rel), "");
  const f = await env.ws.fork("pl", "lc");
  const cg = join(env.ws.hostPath(f.workspace), ".git");
  for (const rel of ["HEAD.lock", "packed-refs.lock", "index.lock", "config.lock", "shallow.lock", "refs/heads/agent/lc.lock"])
    assert.equal(existsSync(join(cg, rel)), false, rel);
  assert.equal(git(env.ws.hostPath(f.workspace), "rev-parse", "--abbrev-ref", "HEAD"), "agent/lc");
  assert.equal(existsSync(join(gd, "HEAD.lock")), true); // the parent's folder is never touched
});

test("fork: a refused copy (reftable) is cleaned up: no temp copy is left and the UnsafeGitDirError surfaces", { skip }, async () => {
  const env = setup();
  const p = await env.ws.create("rd", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  mkdirSync(join(gd, "reftable"));
  writeFileSync(join(gd, "reftable", "tables.list"), "");
  await forkRefused(env, "rd", "rdc");
});

test("fork: a failing copy's error message carries no host path (scrubbed like a GitError)", { skip }, async () => {
  const env = setup();
  const p = await env.ws.create("sc", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  rmSync(join(gd, "config"));
  mkdirSync(join(gd, "config")); // writing the controller-authored config then fails with EISDIR
  writeFileSync(join(gd, "config", "x"), "");
  const err = await env.ws.fork("sc", "scc").then(
    () => assert.fail("fork should throw"),
    (e: Error) => e,
  );
  assert.doesNotMatch(err.message, /\/folders\//);
  assert.match(err.message, /<workspaces>/);
  assert.equal(await env.ws.has("scc"), false);
  assert.deepEqual(
    readdirSync(join(env.base, "folders")).filter((n) => n.startsWith(".tmp-")),
    [],
  );
});

test("hostile fork: promisor config without the extensions header is overwritten, not honoured", { skip }, async () => {
  const env = setup();
  const s = sentinelScripts(env);
  const p = await env.ws.create("pq", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  appendFileSync(
    join(gd, "config"),
    `[remote "o"]\n\turl = ${join(env.base, "nonexistent")}\n\tpromisor = true\n\tuploadpack = ${s.up}\n[core]\n\tsshCommand = ${s.ssh}\n[url "ssh://evil/"]\n\tinsteadOf = /\n[credential]\n\thelper = !${s.ssh}\n`,
  );
  const f = await env.ws.fork("pq", "qc");
  const cfg = readFileSync(join(env.ws.hostPath(f.workspace), ".git", "config"), "utf8");
  assert.doesNotMatch(cfg, /promisor|sshCommand|uploadpack|insteadOf|helper|remote/);
  assert.equal(
    execFileSync("git", ["config", "--file", join(env.ws.hostPath(f.workspace), ".git", "config"), "user.email"])
      .toString()
      .trim(),
    "qc@agents.pomtree",
  );
  assert.equal(existsSync(s.fired), false);
});

test("hostile fork: .git/commondir pointing at a sibling agent's repo is deleted from the copy and the sibling stays byte-unchanged", { skip }, async () => {
  const env = setup();
  await env.ws.create("victim", {});
  const p = await env.ws.create("cp", {});
  const vgit = join(env.ws.hostPath((await env.ws.create("victim", {})).workspace), ".git");
  writeFileSync(join(env.ws.hostPath(p.workspace), ".git", "commondir"), "../../victim/.git\n");
  const before = digest(vgit);
  const f = await env.ws.fork("cp", "cc");
  assert.equal(existsSync(join(env.ws.hostPath(f.workspace), ".git", "commondir")), false);
  assert.equal(git(env.ws.hostPath(f.workspace), "rev-parse", "--abbrev-ref", "HEAD"), "agent/cc");
  assert.equal(digest(vgit), before);
});

const hostileGitDirs: [string, (d: string, v: string) => void][] = [
  [
    "a .git gitfile",
    (d, v) => {
      rmSync(join(d, ".git"), { recursive: true });
      writeFileSync(join(d, ".git"), `gitdir: ${v}\n`);
    },
  ],
  [
    "a .git symlink",
    (d, v) => {
      rmSync(join(d, ".git"), { recursive: true });
      symlinkSync(v, join(d, ".git"));
    },
  ],
  [
    "a symlinked .git/config",
    (d, v) => {
      rmSync(join(d, ".git", "config"));
      symlinkSync(join(v, "config"), join(d, ".git", "config"));
    },
  ],
  [
    "a symlinked .git/HEAD",
    (d, v) => {
      rmSync(join(d, ".git", "HEAD"));
      symlinkSync(join(v, "HEAD"), join(d, ".git", "HEAD"));
    },
  ],
  [
    "a symlinked .git/refs",
    (d, v) => {
      rmSync(join(d, ".git", "refs"), { recursive: true });
      symlinkSync(join(v, "refs"), join(d, ".git", "refs"));
    },
  ],
  [
    "a symlinked .git/packed-refs",
    (d, v) => {
      rmSync(join(d, ".git", "packed-refs"), { force: true });
      symlinkSync(join(v, "packed-refs"), join(d, ".git", "packed-refs"));
    },
  ],
  [
    "a deep symlink in .git/info",
    (d, v) => {
      mkdirSync(join(d, ".git", "info"), { recursive: true });
      symlinkSync(v, join(d, ".git", "info", "x"));
    },
  ],
  [
    "a reftable directory",
    (d) => {
      mkdirSync(join(d, ".git", "reftable"));
    },
  ],
];
for (const [name, mk] of hostileGitDirs) {
  test(`hostile fork: ${name} is refused and a sibling repo is byte-unchanged`, { skip }, async () => {
    const env = setup();
    const v = await env.ws.create("victim", {});
    const vgit = join(env.ws.hostPath(v.workspace), ".git");
    const p = await env.ws.create("pz", {});
    mk(env.ws.hostPath(p.workspace), vgit);
    const before = digest(vgit);
    await forkRefused(env, "pz", "pzc");
    assert.equal(digest(vgit), before);
  });
}

test("hostile fork: a symlinked .git/objects cannot make the alternates removal unlink a file outside the copy", { skip }, async () => {
  const env = setup();
  const p = await env.ws.create("po", {});
  const outside = join(env.base, "outside-objects");
  mkdirSync(join(outside, "info"), { recursive: true });
  writeFileSync(join(outside, "info", "alternates"), "/keep\n");
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  rmSync(join(gd, "objects"), { recursive: true });
  symlinkSync(outside, join(gd, "objects"));
  const before = digest(outside);
  await forkRefused(env, "po", "poc");
  assert.equal(digest(outside), before);
  assert.equal(readFileSync(join(outside, "info", "alternates"), "utf8"), "/keep\n");
});

test("hostile fork: planted worktrees, config.worktree, shallow, grafts, attributes, hooks, alternates and *.promisor are removed from the child", {
  skip,
}, async () => {
  const env = setup();
  const s = sentinelScripts(env);
  const p = await env.ws.create("pw", {});
  const gd = join(env.ws.hostPath(p.workspace), ".git");
  mkdirSync(join(gd, "worktrees", "w"), { recursive: true });
  writeFileSync(join(gd, "config.worktree"), `[core]\n\tsshCommand = ${s.ssh}\n`);
  writeFileSync(join(gd, "shallow"), `${p.commit}\n`);
  mkdirSync(join(gd, "info"), { recursive: true });
  writeFileSync(join(gd, "info", "grafts"), `${p.commit}\n`);
  writeFileSync(join(gd, "info", "attributes"), "* filter=x\n");
  mkdirSync(join(gd, "hooks"), { recursive: true });
  writeFileSync(join(gd, "hooks", "reference-transaction"), `#!/bin/sh\n${s.up}\n`, { mode: 0o755 });
  writeFileSync(join(gd, "objects", "info", "alternates"), "/nonexistent-alt\n");
  writeFileSync(join(gd, "objects", "pack", "pack-x.promisor"), "");
  const f = await env.ws.fork("pw", "wc");
  const cg = join(env.ws.hostPath(f.workspace), ".git");
  for (const rel of [
    "worktrees",
    "config.worktree",
    "shallow",
    "info/grafts",
    "info/attributes",
    "hooks",
    "objects/info/alternates",
    "objects/pack/pack-x.promisor",
  ])
    assert.equal(existsSync(join(cg, rel)), false, rel);
  assert.equal(git(env.ws.hostPath(f.workspace), "rev-parse", "HEAD"), p.commit);
  assert.equal(existsSync(s.fired), false);
  assert.equal(digest(gd) === digest(cg), false);
  assert.equal(existsSync(join(gd, "worktrees")), true); // the parent's folder is never touched
});

test("evicted folder falls back to the last ingested commit via create({fromCommit})", { skip }, async () => {
  const env = setup();
  await env.ws.create("r1", {});
  const w = work(env, "agent/r1", { "kept.txt": "kept" });
  await env.ws.ingest("r1", stream(w.bytes), { maxBytes: 1 << 20 });
  await env.ws.evict("r1");
  const again = await env.ws.create("r1", { fromCommit: (await env.ws.ingested("r1"))!.commit }); // reachable only via refs/agents/r1/*
  assert.equal(again.commit, w.commit);
  assert.equal(readFileSync(join(env.ws.hostPath(again.workspace), "kept.txt"), "utf8"), "kept");
  assert.equal(git(env.ws.hostPath(again.workspace), "rev-parse", "HEAD"), w.commit);
});

test("a forked child's first push is accepted: create({fromCommit}) seeds a base anchor, replay is idempotent, prune reaps it", { skip }, async () => {
  const env = setup();
  await env.ws.create("h1", {});
  const p = work(env, "agent/h1", { "p.txt": "p" }); // reachable only from refs/agents/h1/*
  assert.equal((await env.ws.ingest("h1", stream(p.bytes), { maxBytes: 1 << 20 })).ok, true);
  // The daemon's fork path: the child is created from the parent's ingested commit.
  const c = await env.ws.create("h2", { fromCommit: p.commit });
  assert.equal(c.commit, p.commit);
  assert.equal(git(env.mirror, "rev-parse", "--verify", `refs/agents/h2/base/${p.commit}`), p.commit);
  assert.deepEqual(await env.ws.create("h2", { fromCommit: p.commit }), c); // replay neither moves nor duplicates the anchor
  // New work in the child's own folder, bundled like `pomtree push` with the fork base as prerequisite.
  const dir = env.ws.hostPath(c.workspace);
  writeFileSync(join(dir, "c.txt"), "c");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "child work");
  const tip = git(dir, "rev-parse", "HEAD");
  const out = join(env.base, "fork-push.bundle");
  git(dir, "bundle", "create", out, "agent/h2", `^${p.commit}`);
  const r = await env.ws.ingest("h2", stream(readFileSync(out)), { maxBytes: 1 << 20 });
  assert.deepEqual(r, { ok: true, refs: [{ ref: "refs/agents/h2/heads/agent/h2", commit: tip }] });
  // The anchor is reaped with the rest of the namespace once h2's work is merged into a root's refs.
  git(dir, "checkout", "-q", "-B", "agent/r");
  writeFileSync(join(dir, "r.txt"), "r");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "root");
  assert.equal((await env.ws.ingest("r", stream(bundleOf(env, dir, "agent/r")), { maxBytes: 1 << 20 })).ok, true);
  assert.equal(await env.ws.prune("h2", { mergedInto: "r" }), "pruned");
  assert.doesNotMatch(env.mirrorRefs(), /refs\/agents\/h2\//);
});

test("hostile: a forked child naming another agent's commit it was never handed is still refused", { skip }, async () => {
  const env = setup();
  await env.ws.create("h1", {});
  const p = work(env, "agent/h1", { "p.txt": "p" });
  assert.equal((await env.ws.ingest("h1", stream(p.bytes), { maxBytes: 1 << 20 })).ok, true);
  await env.ws.create("h3", {});
  const q = work(env, "agent/h3", { "q.txt": "q" });
  assert.equal((await env.ws.ingest("h3", stream(q.bytes), { maxBytes: 1 << 20 })).ok, true);
  // Forked from h1's tip: the anchor entitles exactly that base and nothing else.
  await env.ws.create("h2", { fromCommit: p.commit });
  const before = { refs: env.mirrorRefs(), packs: env.mirrorPacks() };
  const dir = env.scratch();
  git(dir, "fetch", "-q", env.mirror, q.commit); // h3's tip, learned or guessed
  git(dir, "checkout", "-q", "-B", "agent/h2", q.commit);
  writeFileSync(join(dir, "x.txt"), "x");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "on foreign");
  const out = join(env.base, "fork-foreign.bundle");
  git(dir, "bundle", "create", out, "agent/h2", `^${q.commit}`);
  await assertRefused(env, "h2", await env.ws.ingest("h2", stream(readFileSync(out)), { maxBytes: 1 << 20 }), "prerequisite", before);
});

test("ingest writes only refs/agents/<id>/heads/*, records ingested, and is idempotent", { skip }, async () => {
  const env = setup();
  await env.ws.create("i1", {});
  const before = env.mirrorRefs();
  const w = work(env, "agent/i1", { "x.txt": "x" });
  const r1 = await env.ws.ingest("i1", stream(w.bytes), { maxBytes: 1 << 20 });
  assert.deepEqual(r1, { ok: true, refs: [{ ref: "refs/agents/i1/heads/agent/i1", commit: w.commit }] });
  const added = env
    .mirrorRefs()
    .split("\n")
    .filter((l) => !before.split("\n").includes(l));
  assert.deepEqual(added, [`refs/agents/i1/heads/agent/i1 ${w.commit}`]);
  assert.deepEqual(await env.ws.ingested("i1"), r1.refs[0]);
  assert.deepEqual(await env.ws.ingest("i1", stream(w.bytes), { maxBytes: 1 << 20 }), r1);
  assert.equal(env.mirrorRefs().split("\n").length, before.split("\n").length + 1);
  assert.deepEqual(readdirSync(env.tmp), []);
});

test("ingested tracks ingest order, not ref name", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const w1 = work(env, "agent/o1", { "1.txt": "1" });
  await env.ws.ingest("o1", stream(w1.bytes), { maxBytes: 1 << 20 });
  const w2 = work(env, "zzz/other", { "2.txt": "2" });
  await env.ws.ingest("o1", stream(w2.bytes), { maxBytes: 1 << 20 });
  assert.equal((await env.ws.ingested("o1"))?.ref, "refs/agents/o1/heads/zzz/other");
});

// A workspace over env's directories, as a restarted daemon would open it.
const reopen = (env: Env, o: Partial<ConstructorParameters<typeof GitWorkspace>[0]> = {}) =>
  new GitWorkspace({ repoDir: env.repo, mirrorDir: env.mirror, foldersRoot: join(env.base, "folders"), tmpRoot: env.tmp, ...o });
const crashAfterRefs = (env: Env) =>
  reopen(env, {
    observe: (e) => {
      if (e.phase === "ingest_refs_updated") throw new Error("simulated crash");
    },
  });

test("C2b-13: a crash between update-ref and the ingested record still reports the landed ref after reopening", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const w = work(env, "agent/k1", { "k.txt": "k" });
  const r = await crashAfterRefs(env).ingest("k1", stream(w.bytes), { maxBytes: 1 << 20 });
  assert.equal(r.ok, false); // the push failed from the caller's view...
  assert.match(env.mirrorRefs(), new RegExp(`refs/agents/k1/heads/agent/k1 ${w.commit}`)); // ...but the ref moved
  assert.equal(existsSync(join(env.mirror, "pomtree", "ingested", "k1")), false);
  assert.deepEqual(await reopen(env).ingested("k1"), { ref: "refs/agents/k1/heads/agent/k1", commit: w.commit });
  // the retried push is idempotent and replaces the intent with the record
  assert.equal((await reopen(env).ingest("k1", stream(w.bytes), { maxBytes: 1 << 20 })).ok, true);
  assert.equal(existsSync(join(env.mirror, "pomtree", "ingest-pending", "k1")), false);
  assert.deepEqual(await reopen(env).ingested("k1"), { ref: "refs/agents/k1/heads/agent/k1", commit: w.commit });
});

test("C2b-13: a stale record (an earlier push of another ref) does not hide a later crashed push", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const dir = env.scratch();
  const a = work(env, "feature", { "f.txt": "f" }, dir);
  assert.equal((await env.ws.ingest("k2", stream(a.bytes), { maxBytes: 1 << 20 })).ok, true);
  assert.equal((await env.ws.ingested("k2"))?.ref, "refs/agents/k2/heads/feature");
  const b = work(env, "agent/k2", { "g.txt": "g" }, dir);
  assert.equal((await crashAfterRefs(env).ingest("k2", stream(b.bytes), { maxBytes: 1 << 20 })).ok, false);
  assert.deepEqual(await reopen(env).ingested("k2"), { ref: "refs/agents/k2/heads/agent/k2", commit: b.commit });
});

test("C2b-13: an intent whose ref never moved (a crash before update-ref) is ignored; the previous record stands", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const a = work(env, "feature", { "f.txt": "f" });
  assert.equal((await env.ws.ingest("k3", stream(a.bytes), { maxBytes: 1 << 20 })).ok, true);
  const pending = join(env.mirror, "pomtree", "ingest-pending", "k3");
  mkdirSync(join(pending, ".."), { recursive: true });
  // the intent names a ref that does not exist yet (old value zero), as if the process died before the ref update
  writeFileSync(pending, `refs/agents/k3/heads/agent/k3 ${"a".repeat(40)} ${"0".repeat(40)}\n`);
  assert.deepEqual(await reopen(env).ingested("k3"), { ref: "refs/agents/k3/heads/feature", commit: a.commit });
  // and one whose ref still holds the old value
  writeFileSync(pending, `refs/agents/k3/heads/feature ${"b".repeat(40)} ${a.commit}\n`);
  assert.deepEqual(await reopen(env).ingested("k3"), { ref: "refs/agents/k3/heads/feature", commit: a.commit });
});

test("ingest-intent-overwrite: a later push that fails at update-ref does not lose an earlier crashed push that landed (its intent is finalized into the record)", {
  skip,
}, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const dir = env.scratch();
  const a = work(env, "agent/k5", { "a.txt": "a" }, dir);
  assert.equal((await crashAfterRefs(env).ingest("k5", stream(a.bytes), { maxBytes: 1 << 20 })).ok, false);
  const landed = { ref: "refs/agents/k5/heads/agent/k5", commit: a.commit };
  assert.deepEqual(await reopen(env).ingested("k5"), landed);
  const b = work(env, "feature", { "b.txt": "b" }, dir);
  // a held ref lock makes the second push's update-ref fail after its intent is written
  const lock = join(env.mirror, "refs", "agents", "k5", "heads", "feature.lock");
  mkdirSync(join(lock, ".."), { recursive: true });
  writeFileSync(lock, "");
  assert.equal((await reopen(env).ingest("k5", stream(b.bytes), { maxBytes: 1 << 20 })).ok, false);
  assert.equal(readdirSync(join(env.mirror, "pomtree", "ingest-pending")).includes("k5"), false, "the landed intent became the record");
  assert.equal(existsSync(join(env.mirror, "pomtree", "ingested", "k5")), true);
  assert.deepEqual(await reopen(env).ingested("k5"), landed);
  rmSync(lock);
  // negative: with no earlier crash, a failed push leaves no intent behind
  const c = work(env, "agent/k6", { "c.txt": "c" });
  const lock6 = join(env.mirror, "refs", "agents", "k6", "heads", "agent", "k6.lock");
  mkdirSync(join(lock6, ".."), { recursive: true });
  writeFileSync(lock6, "");
  assert.equal((await env.ws.ingest("k6", stream(c.bytes), { maxBytes: 1 << 20 })).ok, false);
  assert.equal(existsSync(join(env.mirror, "pomtree", "ingest-pending", "k6")), false);
  assert.equal(await env.ws.ingested("k6"), null);
});

// Two crashes in a row: push A lands its refs but dies before its record (first push, so no record exists), then push B dies after
// writing its own intent but before its update-ref. B's intent carries A's commit as its old value, so on its own it would hide A.
const crashBeforeRefs = (env: Env) =>
  reopen(env, {
    observe: (e) => {
      if (e.phase === "ingest_intent_written") throw new Error("simulated crash");
    },
  });

test("ingest-intent-overwrite: a crash after a later push wrote its intent does not hide an earlier crashed push that landed", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const dir = env.scratch();
  const a = work(env, "agent/k7", { "a.txt": "a" }, dir);
  assert.equal((await crashAfterRefs(env).ingest("k7", stream(a.bytes), { maxBytes: 1 << 20 })).ok, false);
  writeFileSync(join(dir, "b.txt"), "b");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "b");
  const b = { bytes: bundleOf(env, dir, "agent/k7"), commit: git(dir, "rev-parse", "HEAD") };
  assert.equal((await crashBeforeRefs(env).ingest("k7", stream(b.bytes), { maxBytes: 1 << 20 })).ok, false);
  assert.match(env.mirrorRefs(), new RegExp(`refs/agents/k7/heads/agent/k7 ${a.commit}`), "B never moved the ref");
  assert.deepEqual(await reopen(env).ingested("k7"), { ref: "refs/agents/k7/heads/agent/k7", commit: a.commit });
  // the retry of B then completes normally and replaces the intent with the record
  assert.equal((await reopen(env).ingest("k7", stream(b.bytes), { maxBytes: 1 << 20 })).ok, true);
  assert.deepEqual(await reopen(env).ingested("k7"), { ref: "refs/agents/k7/heads/agent/k7", commit: b.commit });
  assert.equal(existsSync(join(env.mirror, "pomtree", "ingest-pending", "k7")), false);
});

test("C2b-13: prune removes a crashed push's intent with the record", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const w = work(env, "agent/k4", { "k.txt": "k" });
  assert.equal((await crashAfterRefs(env).ingest("k4", stream(w.bytes), { maxBytes: 1 << 20 })).ok, false);
  const pending = join(env.mirror, "pomtree", "ingest-pending", "k4");
  assert.equal(existsSync(pending), true);
  git(w.dir, "branch", "agent/k4root", w.commit);
  assert.equal((await env.ws.ingest("k4root", stream(bundleOf(env, w.dir, "agent/k4root")), { maxBytes: 1 << 20 })).ok, true);
  assert.equal(await env.ws.prune("k4", { mergedInto: "k4root" }), "pruned");
  assert.equal(existsSync(pending), false);
  assert.equal(await env.ws.ingested("k4"), null);
});

test("fork-git-version: construction sweeps stale `.tmp-<agent>-<hex>` copies only", { skip }, async () => {
  const env = setup();
  await env.ws.create("live", {});
  const folders = join(env.base, "folders");
  const stale = join(folders, ".tmp-dead-0123abcd");
  mkdirSync(join(stale, ".git", "objects"), { recursive: true });
  writeFileSync(join(stale, ".git", "objects", "x"), "x");
  chmodSync(join(stale, ".git", "objects"), 0o500); // read-only inside, like an agent-written copy
  writeFileSync(join(folders, ".tmp-file-89abcdef"), "x"); // a stray file with a copy's name
  mkdirSync(join(folders, ".tmp-notacopy")); // wrong shape: kept
  mkdirSync(join(folders, ".keep-me"));
  // a fresh copy is kept under the default age
  reopen(env);
  assert.equal(existsSync(stale), true);
  reopen(env, { staleTmpMs: 0 });
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(join(folders, ".tmp-file-89abcdef")), false);
  assert.deepEqual(readdirSync(folders).sort(), [".keep-me", ".tmp-notacopy", "live"]);
  assert.equal(await reopen(env).has("live"), true);
});

test("fork-git-version: a copy whose timestamp reads newer than the clock (negative age) is still swept at staleTmpMs 0", { skip }, async () => {
  const env = setup();
  const copy = join(env.base, "folders", ".tmp-future-0123abcd");
  mkdirSync(copy);
  const future = new Date(Date.now() + 10 * 60 * 1000); // the later of mtime and ctime is this, whatever the timing
  utimesSync(copy, future, future);
  reopen(env); // default age: kept
  assert.equal(existsSync(copy), true);
  reopen(env, { staleTmpMs: 0 }); // age clamps to zero, which is >= 0
  assert.equal(existsSync(copy), false);
});

test("fork-git-version: a copy in flight in this process survives a concurrent construction sweep", { skip }, async () => {
  const env = setup();
  await env.ws.create("fp", {});
  let seen: string | undefined;
  const ws = reopen(env, {
    observe: (e) => {
      if (e.phase !== "fork_copied") return;
      seen = e.path;
      reopen(env, { staleTmpMs: 0 }); // another instance opening the same root mid-fork
      assert.equal(existsSync(e.path!), true);
    },
  });
  const f = await ws.fork("fp", "fc");
  assert.ok(seen && /\.tmp-fc-[0-9a-f]{8}$/.test(seen));
  assert.equal(git(ws.hostPath(f.workspace), "rev-parse", "--abbrev-ref", "HEAD"), "agent/fc");
});

test("serve bundles the default branch plus the scoped agent's refs only", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const a = work(env, "agent/s1", { "a.txt": "a2" });
  const b = work(env, "agent/s2", { "b.txt": "b" });
  await env.ws.ingest("s1", stream(a.bytes), { maxBytes: 1 << 20 });
  await env.ws.ingest("s2", stream(b.bytes), { maxBytes: 1 << 20 });
  const chunks: Uint8Array[] = [];
  for await (const c of await env.ws.serve("s1")) chunks.push(c);
  const file = join(env.base, "served.bundle");
  writeFileSync(file, Buffer.concat(chunks));
  const heads = git(env.base, "bundle", "list-heads", file);
  assert.match(heads, /refs\/heads\/main/);
  assert.match(heads, /refs\/agents\/s1\/heads\/agent\/s1/);
  assert.doesNotMatch(heads, /s2/);
  const into = env.scratch();
  git(into, "fetch", "-q", file, "+refs/agents/*:refs/remotes/pomtreed-agents/*");
  assert.equal(git(into, "rev-parse", "refs/remotes/pomtreed-agents/s1/heads/agent/s1"), a.commit);
  assert.deepEqual(readdirSync(env.tmp), []);
});

test("resolve pins an ingested ref; publish pushes exactly the pinned commit and refuses unreachable ones", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true });
  await env.ws.refreshMirror();
  const remote = join(env.base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const a = work(env, "agent/p1", { "a.txt": "a2\n" });
  const b = work(env, "agent/p2", { "b.txt": "b" });
  await env.ws.ingest("p1", stream(a.bytes), { maxBytes: 1 << 20 });
  await env.ws.ingest("p2", stream(b.bytes), { maxBytes: 1 << 20 });
  const pin = await env.ws.resolve("p1", "refs/agents/p1/heads/agent/p1");
  assert.equal(pin.commit, a.commit);
  assert.equal(pin.subject, "work agent/p1");
  assert.match(pin.diffstat, /a\.txt/);
  assert.deepEqual(pin.paths, ["a.txt"]);
  await assert.rejects(env.ws.resolve("p1", "refs/agents/p2/heads/agent/p2"));
  await assert.rejects(env.ws.resolve("p1", "refs/heads/main"));
  await assert.rejects(env.ws.publish("p1", { commit: b.commit, remote, target: "x" })); // p2's commit, not p1's
  await assert.rejects(env.ws.publish("p1", { commit: "agent/p1", remote, target: "x" })); // a ref, not a pin
  await assert.rejects(env.ws.publish("p1", { commit: a.commit, remote: "--upload-pack=x", target: "x" }));
  await assert.rejects(env.ws.publish("p1", { commit: a.commit, remote, target: "a..b" }));
  assert.equal(existsSync(join(remote, "refs", "heads")) ? readdirSync(join(remote, "refs", "heads")).length : 0, 0);
  await env.ws.publish("p1", { commit: a.commit, remote, target: "feature/x" });
  assert.equal(git(remote, "rev-parse", "refs/heads/feature/x"), a.commit);
});

test("prune deletes an agent's mirror refs only when merged into the target's refs", { skip }, async () => {
  const env = setup();
  await env.ws.refreshMirror();
  const child = work(env, "agent/c", { "c.txt": "c" });
  await env.ws.ingest("c", stream(child.bytes), { maxBytes: 1 << 20 });
  const unmerged = work(env, "agent/u", { "u.txt": "u" });
  await env.ws.ingest("u", stream(unmerged.bytes), { maxBytes: 1 << 20 });
  // root builds on the child's commit (as after `pomtree pull --from c` and a merge in its own clone)
  git(child.dir, "checkout", "-q", "-B", "agent/r");
  writeFileSync(join(child.dir, "r.txt"), "r");
  git(child.dir, "add", "-A");
  git(child.dir, "commit", "-qm", "root");
  assert.equal(await env.ws.prune("c", { mergedInto: "r" }), "refused"); // root has not been ingested yet
  await env.ws.ingest("r", stream(bundleOf(env, child.dir, "agent/r")), { maxBytes: 1 << 20 });
  assert.equal(await env.ws.prune("u", { mergedInto: "r" }), "refused");
  assert.notEqual(await env.ws.ingested("u"), null);
  assert.equal(await env.ws.prune("r", { mergedInto: "r" }), "refused");
  assert.equal(await env.ws.prune("c", { mergedInto: "r" }), "pruned");
  assert.equal(await env.ws.ingested("c"), null);
  assert.doesNotMatch(env.mirrorRefs(), /refs\/agents\/c\//);
  assert.equal(await env.ws.prune("c", { mergedInto: "r" }), "nothing"); // a replay after the prune
  assert.equal(await env.ws.prune("never", { mergedInto: "r" }), "nothing"); // never ingested
});

// --- hostile clones: each test asserts no host file outside the quarantine tmp, no process spawned
// (sentinels that a hook, fsmonitor or filter would create), and no ref or object moved in the mirror.

const SENTINELS = ["hook-fired", "fsmonitor-fired", "filter-fired", "hookspath-fired"];

function plantHostileClone(dir: string, sentinelDir: string) {
  const script = (name: string) => `#!/bin/sh\ntouch '${join(sentinelDir, name)}'\nexit 0\n`;
  const exe = (file: string, name: string) => {
    writeFileSync(file, script(name));
    chmodSync(file, 0o755);
  };
  const hooks = join(dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of [
    "pre-commit",
    "post-checkout",
    "post-merge",
    "reference-transaction",
    "pre-push",
    "post-commit",
    "pre-auto-gc",
    "post-update",
    "update",
    "pre-receive",
    "post-receive",
    "fsmonitor-watchman",
    "pre-rebase",
  ])
    exe(join(hooks, h), "hook-fired");
  const evilHooks = join(dir, "evil-hooks");
  mkdirSync(evilHooks);
  exe(join(evilHooks, "reference-transaction"), "hookspath-fired");
  exe(join(dir, "fsmonitor.sh"), "fsmonitor-fired");
  exe(join(dir, "filter.sh"), "filter-fired");
  const cfg = join(dir, ".git", "config");
  const fsm = join(dir, "fsmonitor.sh");
  const filter = join(dir, "filter.sh");
  writeFileSync(
    cfg,
    `${readFileSync(cfg, "utf8")}[core]\n\thooksPath = ${evilHooks}\n\tfsmonitor = ${fsm}\n[filter "x"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n[alias]\n\tlog = !${filter}\n[uploadpack]\n\tpackObjectsHook = ${filter}\n`,
  );
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "attributes"), "* filter=x\n");
  // alternates pointing outside, as a hostile agent could write
  writeFileSync(join(dir, ".git", "objects", "info", "alternates"), "/nonexistent-alt\n");
}

function assertNoSentinel(sentinelDir: string) {
  assert.deepEqual(
    readdirSync(sentinelDir).filter((n) => SENTINELS.includes(n)),
    [],
    "a hook, fsmonitor or filter ran",
  );
}

test("hostile: hooks, core.hooksPath, core.fsmonitor, filters and alternates in the agent clone never fire across the whole API", { skip }, async () => {
  const env = setup();
  const sentinels = join(env.base, "sentinels");
  mkdirSync(sentinels);
  const a = await env.ws.create("h1", {});
  const dir = env.ws.hostPath(a.workspace);
  const w = work(env, "agent/h1", { "h.txt": "h" }, dir);
  plantHostileClone(dir, sentinels); // after the agent-side git ran: only controller calls follow
  // Positive control: the planted config does fire when git is run in the clone with default settings.
  execFileSync("git", ["-C", dir, "status", "--short"]);
  execFileSync("git", ["-C", dir, "update-ref", "refs/heads/control", "HEAD"]);
  assert.ok(readdirSync(sentinels).length > 0, "control: hostile config should fire under plain git");
  for (const f of readdirSync(sentinels)) rmSync(join(sentinels, f));
  const outside = snapshot(env.repo).filter((p) => !p.startsWith(".git/"));
  assert.equal(await env.ws.has("h1"), true);
  assert.deepEqual(await env.ws.list(), ["h1"]);
  const r = await env.ws.ingest("h1", stream(w.bytes), { maxBytes: 1 << 20 });
  assert.equal(r.ok, true);
  const f = await env.ws.fork("h1", "h2");
  assert.equal(f.commit, a.commit);
  for await (const chunk of await env.ws.serve("h1")) void chunk;
  await env.ws.resolve("h1", "refs/agents/h1/heads/agent/h1");
  await env.ws.ingested("h1");
  await env.ws.evict("h1");
  await env.ws.evict("h2");
  assertNoSentinel(sentinels);
  assert.deepEqual(
    snapshot(env.repo).filter((p) => !p.startsWith(".git/")),
    outside,
  ); // operator checkout untouched
  assert.deepEqual(snapshot(sentinels), []);
  assert.deepEqual(readdirSync(env.tmp), []);
});

async function symlinkRefused(target: string, name: string) {
  const env = setup();
  const before = await refusedState(env);
  const dir = env.scratch();
  git(dir, "checkout", "-q", "-B", "agent/x", env.baseCommit);
  symlinkSync(target, join(dir, name));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "link");
  await assertRefused(env, "x", await env.ws.ingest("x", stream(bundleOf(env, dir, "agent/x")), { maxBytes: 1 << 20 }), "symlink", before);
}

test("hostile: a symlink escaping the tree is refused with code symlink", { skip }, () => symlinkRefused("../../../../etc/passwd", "escape"));
test("hostile: an absolute symlink target is refused with code symlink", { skip }, () => symlinkRefused("/etc/passwd", "abs"));
test("hostile: a symlink to .git is refused with code symlink", { skip }, () => symlinkRefused(".git", "gitlink"));

// A commit whose tree holds `entryName` (a raw tree entry git porcelain would never write).
function evilTreeBundle(env: Env, entryName: string): Uint8Array {
  const dir = env.scratch();
  const blob = gitIn(dir, Buffer.from("payload"), "hash-object", "-w", "--stdin");
  const entry = (mode: string, name: string, oid: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);
  const sub = gitIn(dir, entry("100644", "config", blob), "hash-object", "-w", "-t", "tree", "--stdin", "--literally");
  const keep = git(dir, "rev-parse", "HEAD:a.txt");
  const entries = [entry("40000", entryName, sub), entry("100644", "a.txt", keep)];
  const root = gitIn(dir, Buffer.concat(entries.sort((x, y) => Buffer.compare(x, y))), "hash-object", "-w", "-t", "tree", "--stdin", "--literally");
  const commit = git(dir, "commit-tree", root, "-p", env.baseCommit, "-m", "evil");
  git(dir, "update-ref", "refs/heads/agent/x", commit);
  return bundleOf(env, dir, "agent/x");
}

test("hostile: a .git-named tree entry (and .GIT) is refused with code unsafe_path", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  for (const name of [".git", ".GIT"]) {
    await assertRefused(env, "x", await env.ws.ingest("x", stream(evilTreeBundle(env, name)), { maxBytes: 1 << 20 }), "unsafe_path", before);
  }
});

test("hostile: an oversized bundle is cut off while streaming (cap enforced mid-stream, nothing written)", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  const big = work(env, "agent/x", { "big.bin": Array.from({ length: 5000 }, (_, i) => `line ${i * 7919}`).join("\n") });
  let pulled = 0;
  async function* endless() {
    for (;;) {
      pulled += 1024;
      yield new Uint8Array(1024);
      if (pulled > 10 * 1024 * 1024) throw new Error("cap not enforced while streaming");
    }
  }
  await assertRefused(env, "x", await env.ws.ingest("x", endless(), { maxBytes: 4096 }), "too_large", before);
  assert.ok(pulled <= 8192, `read ${pulled} bytes past a 4096 cap`);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(big.bytes), { maxBytes: 1000 }), "too_large", before);
});

test("hostile: a bundle over the object-count cap is refused with code too_large", { skip }, async () => {
  const env = setup({ maxObjects: 3 });
  await env.ws.create("seed", {}); // builds the mirror
  const before = { refs: env.mirrorRefs(), packs: env.mirrorPacks() };
  const w = work(env, "agent/x", { "1": "1", "2": "2", "3": "3", "4": "4" }); // commit + tree + 4 blobs
  await assertRefused(env, "x", await env.ws.ingest("x", stream(w.bytes), { maxBytes: 1 << 20 }), "too_large", before);
});

test("hostile: a bundle whose prerequisite the mirror lacks is refused with code prerequisite", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  const foreign = join(env.base, "foreign");
  execFileSync("git", ["init", "-q", "-b", "main", foreign]);
  writeFileSync(join(foreign, "f"), "1");
  git(foreign, "add", "f");
  git(foreign, "commit", "-qm", "c1");
  const c1 = git(foreign, "rev-parse", "HEAD");
  writeFileSync(join(foreign, "f"), "2");
  git(foreign, "commit", "-qam", "c2");
  const out = join(env.base, "foreign.bundle");
  git(foreign, "bundle", "create", out, "main", `^${c1}`);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(readFileSync(out)), { maxBytes: 1 << 20 }), "prerequisite", before);
});

test("hostile: a gitlink (submodule) is refused with code submodule", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  const dir = env.scratch();
  git(dir, "checkout", "-q", "-B", "agent/x", env.baseCommit);
  git(dir, "update-index", "--add", "--cacheinfo", `160000,${env.baseCommit},vendor/sub`);
  git(dir, "commit", "-qm", "gitlink");
  await assertRefused(env, "x", await env.ws.ingest("x", stream(bundleOf(env, dir, "agent/x")), { maxBytes: 1 << 20 }), "submodule", before);
});

test("hostile: a .gitmodules file is refused with code submodule", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  const w = work(env, "agent/x", { ".gitmodules": '[submodule "s"]\n\tpath = s\n\turl = ../s\n' });
  await assertRefused(env, "x", await env.ws.ingest("x", stream(w.bytes), { maxBytes: 1 << 20 }), "submodule", before);
});

test("hostile: refs outside refs/heads (tags, another agent's namespace) are refused with code bad_ref", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  const dir = env.scratch();
  git(dir, "checkout", "-q", "-B", "agent/x", env.baseCommit);
  writeFileSync(join(dir, "t.txt"), "t");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "t");
  git(dir, "update-ref", "refs/agents/other/heads/agent/other", "HEAD");
  const out = join(env.base, "refs.bundle");
  git(dir, "bundle", "create", out, "agent/x", "refs/agents/other/heads/agent/other", `^${env.baseCommit}`);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(readFileSync(out)), { maxBytes: 1 << 20 }), "bad_ref", before);
  git(dir, "tag", "v1");
  git(dir, "bundle", "create", out, "agent/x", "v1", `^${env.baseCommit}`);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(readFileSync(out)), { maxBytes: 1 << 20 }), "bad_ref", before);
});

test("hostile: garbage bytes and a truncated bundle are refused with code bad_bundle", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(new TextEncoder().encode("not a bundle")), { maxBytes: 1 << 20 }), "bad_bundle", before);
  const w = work(env, "agent/x", { "z.txt": Array.from({ length: 2000 }, (_, i) => `z${i * 104729}`).join("\n") });
  await assertRefused(env, "x", await env.ws.ingest("x", stream(w.bytes.subarray(0, w.bytes.length - 20)), { maxBytes: 1 << 20 }), "bad_bundle", before);
});

test("hostile: the same symlink blob is checked at every path (../../x passes at depth 2, fails at the root)", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  const dir = env.scratch();
  git(dir, "checkout", "-q", "-B", "agent/x", env.baseCommit);
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  symlinkSync("../../x", join(dir, "a", "b", "l"));
  symlinkSync("../../x", join(dir, "l"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "links");
  await assertRefused(env, "x", await env.ws.ingest("x", stream(bundleOf(env, dir, "agent/x")), { maxBytes: 1 << 20 }), "symlink", before);
});

test("hostile: a bundle naming a mirror object it does not carry (another agent's blob) is refused", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env); // agent "other" ingested o.txt
  const dir = env.scratch();
  const oBlob = git(env.mirror, "rev-parse", "refs/agents/other/heads/agent/other:o.txt");
  const tree = gitIn(
    dir,
    Buffer.concat([Buffer.from("100644 o.txt\0"), Buffer.from(oBlob, "hex")]),
    "hash-object",
    "-w",
    "-t",
    "tree",
    "--stdin",
    "--literally",
  );
  const commit = git(dir, "commit-tree", tree, "-p", env.baseCommit, "-m", "steal");
  git(dir, "update-ref", "refs/heads/agent/x", commit);
  // Hand-built bundle: a pack of just the commit and tree (the blob is deliberately left out).
  const pack = execFileSync("git", ["pack-objects", "--stdout", "-q"], { cwd: dir, input: `${commit}\n${tree}\n` });
  const out = join(env.base, "steal.bundle");
  writeFileSync(out, Buffer.concat([Buffer.from(`# v2 git bundle\n-${env.baseCommit} base\n${commit} refs/heads/agent/x\n\n`), pack]));
  const r = await env.ws.ingest("x", stream(readFileSync(out)), { maxBytes: 1 << 20 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.code, /prerequisite|bad_bundle/);
  assert.equal(env.mirrorRefs(), before.refs);
  assert.equal(await env.ws.ingested("x"), null);
});

test("hostile: an inflated-size cap refuses a bundle whose objects expand past it", { skip }, async () => {
  const env = setup({ maxUnpackedBytes: 10_000 });
  await env.ws.create("seed", {});
  const before = { refs: env.mirrorRefs(), packs: env.mirrorPacks() };
  const w = work(env, "agent/x", { "z.txt": "a".repeat(200_000) }); // compresses to a few hundred bytes
  assert.ok(w.bytes.length < 5000);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(w.bytes), { maxBytes: 1 << 20 }), "too_large", before);
});

test("hostile: a zlib bomb (small pack, huge inflation) is refused by the pre-index pack scan", { skip }, async () => {
  const env = setup({ maxUnpackedBytes: 4 * 1024 * 1024 });
  const before = await refusedState(env);
  const w = work(env, "agent/x", { "zeros.bin": Buffer.alloc(64 * 1024 * 1024).toString("latin1") }); // ~64 KiB compressed
  assert.ok(w.bytes.length < 4 * 1024 * 1024);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(w.bytes), { maxBytes: 1 << 24 }), "too_large", before);
});

test("hostile: quarantine disk use is capped (fail closed with too_large)", { skip }, async () => {
  const env = setup();
  const before = await refusedState(env);
  // Same directories, a quarantine disk cap a legit bundle already exceeds.
  const capped = new GitWorkspace({
    repoDir: env.repo,
    mirrorDir: env.mirror,
    foldersRoot: join(env.base, "folders"),
    tmpRoot: env.tmp,
    maxQuarantineBytes: 1,
  });
  const w = work(env, "agent/x", { "x.txt": "x" });
  await assertRefused(env, "x", await capped.ingest("x", stream(w.bytes), { maxBytes: 1 << 20 }), "too_large", before);
});

test("hostile: a prerequisite outside the agent's own lineage and the operator's branches is refused", { skip }, async () => {
  const env = setup();
  await env.ws.create("other", {});
  const o = work(env, "agent/other", { "o.txt": "o" });
  assert.equal((await env.ws.ingest("other", stream(o.bytes), { maxBytes: 1 << 20 })).ok, true);
  const before = { refs: env.mirrorRefs(), packs: env.mirrorPacks() };
  // An agent that learned another agent's commit id fetches it from the mirror and builds on it.
  const dir = env.scratch();
  git(dir, "fetch", "-q", env.mirror, o.commit);
  git(dir, "checkout", "-q", "-B", "agent/x", o.commit);
  writeFileSync(join(dir, "x.txt"), "x");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "on foreign");
  const out = join(env.base, "foreign-prereq.bundle");
  git(dir, "bundle", "create", out, "agent/x", `^${o.commit}`);
  await assertRefused(env, "x", await env.ws.ingest("x", stream(readFileSync(out)), { maxBytes: 1 << 20 }), "prerequisite", before);
  // ...but the owner of that commit may build on its own ingested tip.
  git(dir, "checkout", "-q", "-B", "agent/other", o.commit);
  writeFileSync(join(dir, "o2.txt"), "o2");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "own work");
  git(dir, "bundle", "create", out, "agent/other", `^${o.commit}`);
  const own = await env.ws.ingest("other", stream(readFileSync(out)), { maxBytes: 1 << 20 });
  assert.equal(own.ok, true);
});

// A pack entry: type+size header, optional middle (ref-delta base id), zlib-deflated content.
function packEntry(type: number, content: Buffer, mid?: Buffer): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (content.length & 0x0f);
  let rest = Math.floor(content.length / 16);
  while (rest > 0) {
    bytes.push((b | 0x80) & 0xff);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(b & 0xff);
  return Buffer.concat([Buffer.from(bytes), ...(mid ? [mid] : []), deflateSync(content)]);
}

function packOf(entries: Buffer[]): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const body = Buffer.concat([head, ...entries]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

// A hand-built bundle whose pack carries a commit, a tree and one ref-delta against `baseBlob` (result: the
// base's content plus "!", so it is a new object), forcing index-pack --fix-thin to adopt the base from the
// alternate. Sizes stay below 128 so every delta varint and opcode is a single byte.
function deltaBundle(env: Env, dir: string, baseBlob: string, baseContent: Buffer): Buffer {
  const content = Buffer.concat([baseContent, Buffer.from("!")]);
  const resultOid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  const ent = Buffer.concat([Buffer.from(`100644 stolen.txt\0`), Buffer.from(resultOid, "hex")]);
  const tree = gitIn(dir, ent, "hash-object", "-w", "-t", "tree", "--stdin", "--literally");
  const commit = git(dir, "commit-tree", tree, "-p", env.baseCommit, "-m", "crafted");
  const raw = (type: string, oid: string) => execFileSync("git", [...SAFE, "cat-file", type, oid], { cwd: dir });
  const delta = Buffer.concat([Buffer.from([baseContent.length, content.length, 0x90, baseContent.length, 0x01, 0x21])]); // copy base, insert "!"
  const pack = packOf([packEntry(1, raw("commit", commit)), packEntry(2, raw("tree", tree)), packEntry(7, delta, Buffer.from(baseBlob, "hex"))]);
  return Buffer.concat([Buffer.from(`# v2 git bundle\n-${env.baseCommit} base\n${commit} refs/heads/agent/x\n\n`), pack]);
}

test("hostile: a ref-delta against a foreign blob (guessed sha) is refused, an entitled base is adopted", { skip }, async () => {
  const env = setup();
  await env.ws.create("other", {});
  const o = work(env, "agent/other", { "o.txt": "o" });
  assert.equal((await env.ws.ingest("other", stream(o.bytes), { maxBytes: 1 << 20 })).ok, true);
  const before = { refs: env.mirrorRefs(), packs: env.mirrorPacks() };
  const dir = env.scratch();
  const foreignBlob = git(env.mirror, "rev-parse", "refs/agents/other/heads/agent/other:o.txt");
  // The attack: a thin pack that deltas against the foreign blob, which --fix-thin would adopt from the mirror.
  const evil = deltaBundle(env, dir, foreignBlob, Buffer.from("o"));
  await assertRefused(env, "x", await env.ws.ingest("x", stream(evil), { maxBytes: 1 << 20 }), "prerequisite", before);
  // The same trick against a blob in the bundle's own prerequisite history is the legitimate thin-pack path.
  const aBlob = git(dir, "rev-parse", `${env.baseCommit}:a.txt`); // content "one"
  const good = deltaBundle(env, dir, aBlob, Buffer.from("one"));
  const ok = await env.ws.ingest("x", stream(good), { maxBytes: 1 << 20 });
  assert.equal(ok.ok, true);
  assert.equal(git(env.mirror, "cat-file", "blob", "refs/agents/x/heads/agent/x:stolen.txt"), "one!");
});

test("publish resolves a remote NAME from the operator repo only; unknown or unsafe names are refused", { skip }, async () => {
  const env = setup({ allowLocalPublishRemotes: true });
  await env.ws.refreshMirror();
  const remote = join(env.base, "named-remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(env.repo, "remote", "add", "origin", remote);
  git(env.repo, "remote", "add", "evil", "ext::sh -c touch% /tmp/pwned");
  const a = work(env, "agent/n1", { "n.txt": "n" });
  await env.ws.ingest("n1", stream(a.bytes), { maxBytes: 1 << 20 });
  await env.ws.publish("n1", { commit: a.commit, remote: "origin", target: "main" });
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), a.commit);
  await assert.rejects(env.ws.publish("n1", { commit: a.commit, remote: "nonesuch", target: "x" }), /unknown publish remote/);
  await assert.rejects(env.ws.publish("n1", { commit: a.commit, remote: "evil", target: "x" }), /invalid publish remote/);
  await assert.rejects(env.ws.publish("n1", { commit: a.commit, remote: "file:///tmp/x", target: "x" }), /invalid publish remote/);
});
