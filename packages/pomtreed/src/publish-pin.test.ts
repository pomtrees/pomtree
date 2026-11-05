import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPublishResolver, execGit, GitRunError, type GitRunOptions, PublishPinError } from "./publish-pin.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// operator repo `work` (branch main) and a bare mirror cloned from it; returns helpers to commit in `work` and re-sync the mirror.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pomtree-pubpin-"));
  const work = join(root, "work");
  const mirror = join(root, "mirror.git");
  mkdirSync(work);
  run(work, "init", "-q", "-b", "main");
  const commit = (file: string, body: string | null, msg: string) => {
    if (body === null) run(work, "rm", "-q", file);
    else {
      writeFileSync(join(work, file), body);
      run(work, "add", file);
    }
    run(work, "commit", "-q", "-m", msg);
    return run(work, "rev-parse", "HEAD");
  };
  const sync = () => {
    rmSync(mirror, { recursive: true, force: true });
    run(root, "clone", "-q", "--bare", work, mirror);
  };
  return { root, work, mirror, commit, sync, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const noAgent = async () => {
  throw new Error("not an agent branch");
};

test("default branch: every commit since the remote tip is checked, not just sha^..sha", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    f.commit(".env", "SECRET=1", "add secret");
    f.commit("src.txt", "x", "feature");
    f.commit(".env", null, "remove secret"); // net diff of the range no longer shows .env
    f.commit("last.txt", "y", "last");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    const pin = await resolve("a", "main", "origin/main");
    assert.deepEqual(pin.paths, [".env", "last.txt", "src.txt"]);
    assert.match(pin.summary, /^4 commits: /);
  } finally {
    f.cleanup();
  }
});

test("default branch with no known remote tip checks the whole reachable history", async () => {
  const f = fixture();
  try {
    f.commit(".env", "SECRET=1", "add secret");
    f.commit(".env", null, "remove secret");
    f.commit("last.txt", "y", "last");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    const pin = await resolve("a", "main", "origin/main");
    assert.deepEqual(pin.paths, [".env", "last.txt"]);
  } finally {
    f.cleanup();
  }
});

test("agent branch: a secret added then deleted inside the pushed range is still reported", async () => {
  const f = fixture();
  try {
    f.commit("README.md", "hi", "base");
    run(f.work, "checkout", "-q", "-b", "agent/a");
    f.commit("id_rsa", "KEY", "oops");
    f.commit("code.txt", "x", "work");
    const sha = f.commit("id_rsa", null, "remove key");
    run(f.work, "checkout", "-q", "main");
    f.sync();
    // stand-in for GitWorkspace.resolve: net diff against merge-base(HEAD, commit), as the real one computes
    const resolveAgentBranch = async () => {
      const names = run(f.mirror, "diff", "--name-only", "-z", "--no-renames", run(f.mirror, "merge-base", "HEAD", sha), sha);
      return { commit: sha, diffstat: "stat", subject: "s", paths: names.split("\0").filter(Boolean) };
    };
    assert.deepEqual((await resolveAgentBranch()).paths, ["code.txt"]); // the net diff alone misses id_rsa
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch });
    const pin = await resolve("a", "agent/a", "origin/main");
    assert.equal(pin.sha, sha);
    assert.deepEqual(pin.paths, ["README.md", "code.txt", "id_rsa"]); // no remote tip: the mirror-main ancestor is in range too
  } finally {
    f.cleanup();
  }
});

test("a git failure fails closed (rejects, never returns no paths) but is not a policy refusal", async () => {
  const f = fixture();
  try {
    f.commit("README.md", "hi", "base");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: join(f.root, "missing.git"), repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(resolve("a", "main", "origin/main"), (e: unknown) => !(e instanceof PublishPinError));
  } finally {
    f.cleanup();
  }
});

test("a missing default branch is a plain git failure (not a PublishPinError), so the daemon keeps its 409", async () => {
  const f = fixture();
  try {
    f.commit("README.md", "hi", "base");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "trunk", resolveAgentBranch: noAgent });
    await assert.rejects(resolve("a", "trunk", "origin/trunk"), (e: unknown) => {
      assert.ok(!(e instanceof PublishPinError), "not a policy refusal");
      return true;
    });
  } finally {
    f.cleanup();
  }
});

// Fake credentials assembled at runtime; nothing credential-shaped is a literal in this file.
const fakeGithubToken = () => `${"gh"}${"p_"}${"aB3".repeat(12)}`;
const fakeAnthropicKey = () => `${"sk-"}${"ant-"}api03-${"aB3".repeat(30)}`;
const refusal = (re: RegExp, notRe: RegExp) => (e: unknown) => {
  assert.ok(e instanceof PublishPinError, "typed fail-closed error");
  assert.match((e as Error).message, re);
  assert.doesNotMatch((e as Error).message, notRe);
  return true;
};

test("content scan: a token added in a middle commit and deleted again is refused, naming commit+file+line but not the token", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    const token = fakeGithubToken();
    const bad = f.commit("config.ts", `export const a = 1;\nexport const t = "${token}";\n`, "add token");
    f.commit("config.ts", "export const a = 1;\n", "remove token"); // net diff is clean
    f.commit("last.txt", "y", "last");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(
      resolve("a", "main", "origin/main"),
      refusal(
        new RegExp(`failed closed: content scan refused: GitHub token in commit ${bad.slice(0, 12)} file config\\.ts line 2`),
        new RegExp(token.slice(4, 30)),
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("content scan: pre-existing secrets at or before the remote tip are not rescanned (range is tip..sha)", async () => {
  const f = fixture();
  try {
    f.commit("old.txt", `k = "${fakeGithubToken()}"\n`, "old secret, already on the remote");
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    f.commit("clean.txt", "fine", "clean");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    const pin = await resolve("a", "main", "origin/main");
    assert.deepEqual(pin.paths, ["clean.txt"]);
  } finally {
    f.cleanup();
  }
});

test("content scan: with no remote tip the whole reachable history is scanned", async () => {
  const f = fixture();
  try {
    const bad = f.commit("a.txt", `-----BEGIN ${"RSA"} PRIVATE KEY-----\nMIIB\n`, "key");
    f.commit("b.txt", "x", "later");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(
      resolve("a", "main", "origin/main"),
      refusal(new RegExp(`private key header in commit ${bad.slice(0, 12)} file a\\.txt line 1`), /MIIB/),
    );
  } finally {
    f.cleanup();
  }
});

test("content scan: agent branch secret added then deleted inside the range is refused", async () => {
  const f = fixture();
  try {
    f.commit("README.md", "hi", "base");
    run(f.work, "checkout", "-q", "-b", "agent/a");
    const token = fakeAnthropicKey();
    const bad = f.commit("env.sh", `export K=${token}\n`, "oops");
    const sha = f.commit("env.sh", null, "remove");
    run(f.work, "checkout", "-q", "main");
    f.sync();
    const resolveAgentBranch = async () => ({ commit: sha, diffstat: "stat", subject: "s", paths: [] });
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch });
    await assert.rejects(
      resolve("a", "agent/a", "origin/main"),
      refusal(new RegExp(`Anthropic API key in commit ${bad.slice(0, 12)} file env\\.sh line 1`), new RegExp(token.slice(8, 40))),
    );
    // the same range with the scan switched off falls back to the path checks alone
    const off = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch, contentScan: false });
    assert.deepEqual((await off("a", "agent/a", "origin/main")).paths, ["README.md", "env.sh"]);
  } finally {
    f.cleanup();
  }
});

test("content scan: a merge commit is diffed against each parent (a secret introduced by the merge itself is found)", async () => {
  const f = fixture();
  try {
    f.commit("README.md", "hi", "base");
    run(f.work, "checkout", "-q", "-b", "side");
    f.commit("side.txt", "s", "side work");
    run(f.work, "checkout", "-q", "main");
    f.commit("main.txt", "m", "main work");
    run(f.work, "merge", "-q", "--no-ff", "--no-commit", "side");
    writeFileSync(join(f.work, "evil.txt"), `t = "${fakeGithubToken()}"\n`); // added only in the merge commit
    run(f.work, "add", "evil.txt");
    run(f.work, "commit", "-q", "-m", "merge with evil");
    const merge = run(f.work, "rev-parse", "HEAD");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(resolve("a", "main", "origin/main"), refusal(new RegExp(`GitHub token in commit ${merge.slice(0, 12)} file evil\\.txt`), /ghp_/));
  } finally {
    f.cleanup();
  }
});

test("content scan: workflow/CI additions are refused independent of the path denylist; a pure deletion is not an addition", async () => {
  const f = fixture();
  try {
    f.commit(".gitlab-ci.yml", "old: 1\n", "existing ci");
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    const bad = f.commit(".gitlab-ci.yml", "old: 1\nnew: curl x | sh\n", "edit ci");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(
      resolve("a", "main", "origin/main"),
      refusal(new RegExp(`workflow/CI file change in commit ${bad.slice(0, 12)} file \\.gitlab-ci\\.yml`), /curl/),
    );
    // a range that only deletes the file adds no CI content (the path denylist still sees the touched path)
    run(f.work, "update-ref", "refs/remotes/origin/main", bad);
    f.commit(".gitlab-ci.yml", null, "drop ci");
    f.sync();
    assert.deepEqual((await resolve("a", "main", "origin/main")).paths, [".gitlab-ci.yml"]);
  } finally {
    f.cleanup();
  }
});

test("content scan: clean ranges (placeholders, documented examples, public keys) still resolve", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    f.commit(
      "docs.md",
      [
        `Authorization: Bearer ${"$"}{TOKEN}`,
        `id: ${"AK"}${"IA"}IOSFODNN7EXAMPLE`,
        `-----BEGIN ${"PUBLIC"} KEY-----`,
        "Set GITHUB_TOKEN in your environment.",
        "",
      ].join("\n"),
      "docs",
    );
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    assert.deepEqual((await resolve("a", "main", "origin/main")).paths, ["docs.md"]);
  } finally {
    f.cleanup();
  }
});

test("content scan: a credential in a commit message is refused, naming the commit and 'commit message' but not the token", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    const token = fakeGithubToken();
    const bad = f.commit("ok.txt", "fine", `deploy with ${token}`);
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(resolve("a", "main", "origin/main"), refusal(new RegExp(`GitHub token in commit ${bad.slice(0, 12)} commit message line 1`), /ghp_/));
  } finally {
    f.cleanup();
  }
});

test("content scan: CRLF added lines are scanned and the line number is right", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    const bad = f.commit("win.ts", `const a = 1;\r\nconst t = "${fakeGithubToken()}";\r\n`, "crlf");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(resolve("a", "main", "origin/main"), refusal(new RegExp(`in commit ${bad.slice(0, 12)} file win\\.ts line 2`), /ghp_/));
  } finally {
    f.cleanup();
  }
});

test("content scan: a binary file with a token in it is refused (binary diffs are text to the scan)", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    writeFileSync(join(f.work, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(fakeGithubToken()), Buffer.from([0, 255])]));
    run(f.work, "add", "blob.bin");
    run(f.work, "commit", "-q", "-m", "binary");
    const bad = run(f.work, "rev-parse", "HEAD");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(resolve("a", "main", "origin/main"), refusal(new RegExp(`in commit ${bad.slice(0, 12)} file blob\\.bin line 1`), /ghp_/));
  } finally {
    f.cleanup();
  }
});

test("content scan: a quoted, unicode CI path is detected end to end", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    mkdirSync(join(f.work, ".github", "workflows"), { recursive: true });
    const bad = f.commit('.github/workflows/caf\u00e9 "q".yml', "on: push\n", "odd ci name");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(
      resolve("a", "main", "origin/main"),
      refusal(new RegExp(`workflow/CI file change in commit ${bad.slice(0, 12)} file \\.github/workflows/caf`), /on: push/),
    );
  } finally {
    f.cleanup();
  }
});

test("content scan: a hostile filename with a newline is sanitized in the refusal and the refusal stays one line", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    const bad = f.commit("bad\nname\u0007.txt", `t = "${fakeGithubToken()}"\n`, "hostile name");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(
      resolve("a", "main", "origin/main"),
      refusal(new RegExp(`GitHub token in commit ${bad.slice(0, 12)} file bad\\?name\\?\\.txt line 1`), /[^\x20-\x7e]|ghp_/),
    );
  } finally {
    f.cleanup();
  }
});

test("content scan: a diff over the scan size cap fails closed with PublishPinError (ENOBUFS path)", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    f.commit("big.txt", "clean line\n".repeat(20_000), "big");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent, scanMaxBytes: 4096 });
    await assert.rejects(resolve("a", "main", "origin/main"), (e: unknown) => e instanceof PublishPinError && /cannot be scanned/.test((e as Error).message));
  } finally {
    f.cleanup();
  }
});

test("content scan: a symlink at a CI path is refused (its target is an added line), a symlink elsewhere is not", async () => {
  const f = fixture();
  try {
    const tip = f.commit("README.md", "hi", "base");
    run(f.work, "update-ref", "refs/remotes/origin/main", tip);
    mkdirSync(join(f.work, ".github", "workflows"), { recursive: true });
    symlinkSync("../../evil.sh", join(f.work, ".github", "workflows", "ci.yml"));
    run(f.work, "add", ".github/workflows/ci.yml");
    run(f.work, "commit", "-q", "-m", "ci symlink");
    const bad = run(f.work, "rev-parse", "HEAD");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent });
    await assert.rejects(
      resolve("a", "main", "origin/main"),
      refusal(new RegExp(`workflow/CI file change in commit ${bad.slice(0, 12)} file \\.github/workflows/ci\\.yml`), /evil/),
    );
  } finally {
    f.cleanup();
  }
});

test("agent branch with no known remote tip scans mirror-main ancestors (a secret there is refused)", async () => {
  const f = fixture();
  try {
    const bad = f.commit("a.txt", `export K=${fakeAnthropicKey()}\n`, "main secret");
    f.commit("b.txt", "x", "main later");
    run(f.work, "checkout", "-q", "-b", "agent/a");
    const sha = f.commit("c.txt", "agent work", "agent");
    run(f.work, "checkout", "-q", "main");
    f.sync();
    const resolveAgentBranch = async () => ({ commit: sha, diffstat: "stat", subject: "s", paths: ["c.txt"] });
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch });
    await assert.rejects(
      resolve("a", "agent/a", "origin/main"),
      refusal(new RegExp(`Anthropic API key in commit ${bad.slice(0, 12)} file a\\.txt line 1`), /sk-ant-/),
    );
    // contentScan:false drops only the content scan; the path list still covers the ancestors
    const off = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch, contentScan: false });
    assert.deepEqual((await off("a", "agent/a", "origin/main")).paths, ["a.txt", "b.txt", "c.txt"]);
  } finally {
    f.cleanup();
  }
});

test("agent branch with no known remote tip: a denied path in a mirror-main ancestor is reported even with contentScan:false", async () => {
  const f = fixture();
  try {
    f.commit("README.md", "hi", "base");
    mkdirSync(join(f.work, ".github", "workflows"), { recursive: true });
    f.commit(".github/workflows/x.yml", "on: push\n", "workflow on main");
    run(f.work, "checkout", "-q", "-b", "agent/a");
    const sha = f.commit("c.txt", "agent work", "agent");
    run(f.work, "checkout", "-q", "main");
    f.sync();
    const resolveAgentBranch = async () => ({ commit: sha, diffstat: "stat", subject: "s", paths: ["c.txt"] });
    const on = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch });
    await assert.rejects(on("a", "agent/a", "origin/main"), refusal(/workflow\/CI file change .*\.github\/workflows\/x\.yml/, /on: push/));
    const off = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch, contentScan: false });
    assert.ok((await off("a", "agent/a", "origin/main")).paths.includes(".github/workflows/x.yml"), "path list still reports the ancestor");
  } finally {
    f.cleanup();
  }
});

// Deterministic stub runner: no repository and no child process. Each call's argv is matched against the first handler whose
// predicate holds; a handler yields stdout or throws. Every call is recorded with its options so tests can assert bounds.
type Handler = [(args: string[]) => boolean, (opts: GitRunOptions) => string];
function stubGit(handlers: Handler[]) {
  const calls: { args: string[]; opts: GitRunOptions }[] = [];
  const run = async (args: string[], opts: GitRunOptions): Promise<string> => {
    calls.push({ args, opts });
    const h = handlers.find(([match]) => match(args));
    if (!h) throw new Error(`unscripted git call: ${args.join(" ")}`);
    return h[1](opts);
  };
  return { run, calls };
}
const isScan = (a: string[]) => a.includes("-p");
const isMessages = (a: string[]) => a.includes("-z") && a.some((x) => x.startsWith("--format=%H%x00"));
// A healthy default-branch resolution with no remote tip: head sha, its parent, one clean commit.
const healthy = (scan: Handler[] = []): Handler[] => [
  ...scan,
  [
    (a) => a.includes("rev-parse") && a.includes("-C"),
    () => {
      throw new GitRunError("EGIT", "no ref");
    },
  ],
  [(a) => a.includes("rev-parse") && a.includes("refs/heads/main^{commit}"), () => "b".repeat(40)],
  [(a) => a.includes("rev-parse") && a.includes(`${"b".repeat(40)}^`), () => "a".repeat(40)],
  [(a) => a.includes("--stat"), () => " 1 file changed"],
  [(a) => a.includes("--name-only") && a.includes("-z") && !a.includes("log"), () => "clean.txt\0"],
  [(a) => a.includes("log") && a.includes("--name-only"), () => "clean.txt\0"],
  [(a) => a.includes("rev-list"), () => "1\n"],
  [isScan, () => ""],
  [isMessages, () => ""],
];
const SHA = "b".repeat(40);
const stubResolve = (run: (args: string[], opts: GitRunOptions) => Promise<string>, extra: Partial<Parameters<typeof createPublishResolver>[0]> = {}) =>
  createPublishResolver({
    mirrorDir: "/nonexistent/mirror.git",
    repoDir: "/nonexistent/work",
    defaultBranch: "main",
    resolveAgentBranch: noAgent,
    runGit: run,
    ...extra,
  });

test("stub: a clean default-branch resolution pins the exact head sha and its paths", async () => {
  const g = stubGit(healthy());
  const pin = await stubResolve(g.run)("a", "main", "origin/main");
  assert.equal(pin.sha, SHA);
  assert.deepEqual(pin.paths, ["clean.txt"]);
  assert.ok(
    g.calls.every((c) => c.opts.timeoutMs <= 180_000 && c.opts.maxBytes > 0),
    "every call is bounded",
  );
});

test("stub: a credential in the scanned diff is a PublishPinError that never echoes the matched text", async () => {
  const token = fakeGithubToken();
  const diff = `\u0001${SHA}\ndiff --git a/k.txt b/k.txt\n--- /dev/null\n+++ b/k.txt\n@@ -0,0 +1 @@\n+k = "${token}"\n`;
  const g = stubGit(healthy([[isScan, () => diff]]));
  await assert.rejects(stubResolve(g.run)("a", "main", "origin/main"), (e: unknown) => {
    assert.ok(e instanceof PublishPinError);
    assert.match((e as Error).message, /GitHub token/);
    assert.ok(!(e as Error).message.includes(token));
    return true;
  });
});

test("stub: with no remote tip the scan reads the whole reachable history (the head alone, no ^exclude)", async () => {
  const g = stubGit(healthy());
  await stubResolve(g.run)("a", "main", "origin/main");
  const scans = g.calls.filter((c) => isScan(c.args));
  assert.equal(scans.length, 1);
  const range = scans[0]?.args.slice(-1);
  assert.deepEqual(range, [SHA], "no `^tip` exclusion: every ancestor is in range");
  assert.ok(!scans[0]?.args.some((x) => x.startsWith("^")));
});

test("stub: a timed-out scan is a plain failure (409), not a policy refusal, and the bound is capped at 180 s", async () => {
  const g = stubGit(
    healthy([
      [
        isScan,
        () => {
          throw new GitRunError("ETIMEOUT", "git call timed out");
        },
      ],
    ]),
  );
  await assert.rejects(stubResolve(g.run, { gitTimeoutMs: 10_000_000 })("a", "main", "origin/main"), (e: unknown) => {
    assert.ok(e instanceof GitRunError && e.code === "ETIMEOUT");
    assert.ok(!(e instanceof PublishPinError));
    return true;
  });
  assert.ok(g.calls.every((c) => c.opts.timeoutMs === 180_000));
});

test("stub: an aborted call propagates the caller's signal to the runner and fails closed", async () => {
  const ac = new AbortController();
  const g = stubGit(
    healthy([
      [
        isScan,
        () => {
          throw new GitRunError("EABORT", "git call aborted");
        },
      ],
    ]),
  );
  await assert.rejects(stubResolve(g.run)("a", "main", "origin/main", ac.signal), (e: unknown) => e instanceof GitRunError && e.code === "EABORT");
  assert.ok(g.calls.some((c) => c.opts.signal === ac.signal));
});

test("stub: an over-cap scan output is a refusal (403), never a pass", async () => {
  const g = stubGit(
    healthy([
      [
        isScan,
        () => {
          throw new GitRunError("EOVERFLOW", "git output exceeded");
        },
      ],
    ]),
  );
  await assert.rejects(stubResolve(g.run)("a", "main", "origin/main"), (e: unknown) => e instanceof PublishPinError && /exceeds/.test((e as Error).message));
});

test("stub: a failing default-branch lookup is a plain failure, not a PublishPinError", async () => {
  const g = stubGit(
    healthy([
      [
        (a) => a.includes("refs/heads/main^{commit}"),
        () => {
          throw new GitRunError("EGIT", "bad ref");
        },
      ],
    ]),
  );
  await assert.rejects(stubResolve(g.run)("a", "main", "origin/main"), (e: unknown) => e instanceof GitRunError && !(e instanceof PublishPinError));
});

test("real git: a scan over the byte cap is refused (403) rather than skipped", async () => {
  const f = fixture();
  try {
    const token = fakeGithubToken();
    f.commit("a.txt", `k = "${token}"\n`, "x");
    f.sync();
    const resolve = createPublishResolver({ mirrorDir: f.mirror, repoDir: f.work, defaultBranch: "main", resolveAgentBranch: noAgent, scanMaxBytes: 16 });
    await assert.rejects(resolve("a", "main", "origin/main"), (e: unknown) => e instanceof PublishPinError && /exceeds 16 bytes/.test((e as Error).message));
  } finally {
    f.cleanup();
  }
});

test("stub: gitTimeoutMs must be a positive safe integer; invalid values are rejected at construction with no git call", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const g = stubGit([]);
    assert.throws(() => stubResolve(g.run, { gitTimeoutMs: bad }), /gitTimeoutMs must be a positive safe integer/, String(bad));
    assert.equal(g.calls.length, 0);
  }
});

test("stub: a valid gitTimeoutMs below the cap is used as given; the default is 120 s", async () => {
  const g = stubGit(healthy());
  await stubResolve(g.run, { gitTimeoutMs: 5_000 })("a", "main", "origin/main");
  assert.ok(g.calls.every((c) => c.opts.timeoutMs === 5_000));
  const d = stubGit(healthy());
  await stubResolve(d.run)("a", "main", "origin/main");
  assert.ok(d.calls.every((c) => c.opts.timeoutMs === 120_000));
});

test("execGit (real git, no repository): output over maxBytes is EOVERFLOW", async () => {
  await assert.rejects(execGit(["--version"], { maxBytes: 1, timeoutMs: 10_000 }), (e: unknown) => e instanceof GitRunError && e.code === "EOVERFLOW");
});

test("execGit (real git): a failing command is a sanitized EGIT with no argv, stderr or output", async () => {
  const bogus = "no-such-subcommand-xyz";
  await assert.rejects(execGit([bogus], { maxBytes: 1024, timeoutMs: 10_000 }), (e: unknown) => {
    assert.ok(e instanceof GitRunError && e.code === "EGIT");
    assert.doesNotMatch((e as Error).message, new RegExp(bogus));
    assert.match((e as Error).message, /exit/);
    return true;
  });
});

test("execGit (real git): a signal aborted before the call is EABORT, not a plain failure", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    execGit(["--version"], { maxBytes: 1024, timeoutMs: 10_000, signal: ac.signal }),
    (e: unknown) => e instanceof GitRunError && e.code === "EABORT",
  );
});

// Real process-boundary tests for execGit. A fake `git` (a Node script run through its shebang, so no shell descendant)
// is first on PATH for one test; its mode is passed by environment. The fake always records its PID first, then reports
// ready (the ignore-term mode only, after its SIGTERM handler is installed). Every call is watched from the moment it
// starts: its outcome promise has a handler attached at once, the abort controller is always aborted and the call is
// always awaited (with a bounded cap) in cleanup, and the fake's recorded PID is killed if it is still alive, whether or
// not readiness succeeded. All child timeouts are under one second; readiness waits are bounded below them.
const FAKE_GIT = `#!${process.execPath}
const fs = require("node:fs");
const mode = process.env.FAKE_GIT_MODE;
const write = (file, text) => {
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
};
write(process.env.FAKE_GIT_PID, String(process.pid));
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  write(process.env.FAKE_GIT_READY, "1");
  setInterval(() => {}, 1000);
} else if (mode === "silent") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "exit") {
  process.exit(3);
} else if (mode === "stdout-big") {
  process.stdout.write("x".repeat(1 << 16));
} else if (mode === "stderr-big") {
  process.stderr.write("e".repeat(1 << 16));
} else {
  process.stdout.write("fake-git-ok\\n");
}
`;

const CHILD_TIMEOUT_MS = 750; // every real child timeout in this section is under one second
const READY_WAIT_MS = 500; // readiness is awaited for less than the child timeout
const SETTLE_CAP_MS = 2_000; // cleanup never waits longer than this for a call to settle

type Settled = { ok: true; v: string } | { ok: false; e: unknown };

// Installs the fake first on PATH in `mode`. `restore` puts back PATH and the FAKE_GIT_* variables and removes the fixture.
function installFake(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-fakegit-"));
  writeFileSync(join(dir, "git"), FAKE_GIT);
  chmodSync(join(dir, "git"), 0o755);
  const keys = ["PATH", "FAKE_GIT_MODE", "FAKE_GIT_READY", "FAKE_GIT_PID"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PATH = `${dir}:${saved.PATH ?? ""}`;
  process.env.FAKE_GIT_MODE = mode;
  process.env.FAKE_GIT_READY = join(dir, "ready");
  process.env.FAKE_GIT_PID = join(dir, "pid");
  const restore = () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { ready: join(dir, "ready"), pidFile: join(dir, "pid"), restore };
}

// Resolves the call's outcome, or undefined if it has not settled within `ms`. Never rejects.
async function boundedSettle(call: Promise<Settled>, ms: number): Promise<Settled | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([call, cap]);
  } finally {
    clearTimeout(timer);
  }
}

const readPid = (file: string): number | undefined => (existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

interface FakeRun {
  settled: Settled | undefined; // undefined only if the call did not settle within the cleanup cap (a test failure)
  readyError?: Error; // set when readiness failed (missing ready file, or the fake exited before reporting)
  pid?: number; // the fake's PID as it recorded it
  leaked: boolean; // the recorded PID was still alive after the call settled (it has been killed here)
}

// Starts one real execGit call against the fake. If `abortAfterReady`, the call is aborted once the fake is ready;
// otherwise the child timeout is what ends it. Cleanup always aborts a call that has not settled and awaits it.
async function fakeGit(mode: string, timeoutMs: number, abortAfterReady: boolean): Promise<FakeRun> {
  const fake = installFake(mode);
  const ac = new AbortController();
  let done = false;
  const call: Promise<Settled> = execGit(["x"], { maxBytes: 1024, timeoutMs, signal: ac.signal }).then(
    (v) => {
      done = true;
      return { ok: true as const, v };
    },
    (e: unknown) => {
      done = true;
      return { ok: false as const, e };
    },
  );
  let settled: Settled | undefined;
  let readyError: Error | undefined;
  let result: FakeRun | undefined;
  try {
    const end = Date.now() + READY_WAIT_MS;
    while (!existsSync(fake.ready)) {
      if (done) throw new Error(`fake git (${mode}) settled before reporting ready`);
      if (Date.now() > end) throw new Error(`fake git (${mode}) never reported ready`);
      await new Promise((r) => setTimeout(r, 10));
    }
    if (abortAfterReady) ac.abort();
    settled = await boundedSettle(call, CHILD_TIMEOUT_MS + SETTLE_CAP_MS);
  } catch (e) {
    readyError = e as Error;
  } finally {
    if (settled === undefined) {
      ac.abort();
      settled = await boundedSettle(call, SETTLE_CAP_MS);
    }
    const pid = readPid(fake.pidFile);
    const leaked = pid !== undefined && alive(pid);
    if (leaked) process.kill(pid, "SIGKILL");
    fake.restore();
    if (settled !== undefined) result = { settled, pid, leaked, ...(readyError && { readyError }) };
  }
  if (result === undefined) throw new Error("the git call did not settle within the cleanup bound");
  return result;
}

// Runs `fn` with the fake first on PATH in `mode` for calls that need no abort or timeout handle.
async function withFakeOnPath(mode: string, fn: () => Promise<void>): Promise<void> {
  const fake = installFake(mode);
  try {
    await fn();
  } finally {
    fake.restore();
  }
}

const TEST_TIMEOUT = { timeout: 5_000 };

test("execGit (real process): small output is returned as the child's stdout", TEST_TIMEOUT, async () => {
  await withFakeOnPath("ok", async () => {
    assert.equal(await execGit(["status"], { maxBytes: 1024, timeoutMs: CHILD_TIMEOUT_MS }), "fake-git-ok\n");
  });
});

test("execGit (real process): stdout over maxBytes is EOVERFLOW", TEST_TIMEOUT, async () => {
  await withFakeOnPath("stdout-big", async () => {
    await assert.rejects(execGit(["x"], { maxBytes: 1024, timeoutMs: CHILD_TIMEOUT_MS }), (e: unknown) => e instanceof GitRunError && e.code === "EOVERFLOW");
  });
});

test("execGit (real process): stderr over maxBytes is EOVERFLOW, not a silent success", TEST_TIMEOUT, async () => {
  await withFakeOnPath("stderr-big", async () => {
    await assert.rejects(execGit(["x"], { maxBytes: 1024, timeoutMs: CHILD_TIMEOUT_MS }), (e: unknown) => e instanceof GitRunError && e.code === "EOVERFLOW");
  });
});

test("execGit (real process): a SIGTERM-ignoring git is SIGKILLed by the 750 ms timeout, reaped, and reported ETIMEOUT", TEST_TIMEOUT, async () => {
  const before = process.env.PATH;
  const r = await fakeGit("ignore-term", CHILD_TIMEOUT_MS, false);
  assert.equal(r.readyError, undefined, "readiness succeeded before the timeout");
  assert.ok(r.settled && !r.settled.ok && r.settled.e instanceof GitRunError && r.settled.e.code === "ETIMEOUT", "ETIMEOUT");
  assert.doesNotMatch((r.settled.e as Error).message, /fake-git|\bx\b/, "no argv in the message");
  assert.ok(r.pid !== undefined, "the child recorded its PID");
  assert.equal(r.leaked, false, "the SIGTERM-ignoring child was gone once the call settled");
  assert.equal(process.env.PATH, before, "PATH restored");
});

test("execGit (real process): a SIGTERM-ignoring git is SIGKILLed by an abort after readiness and reported EABORT", TEST_TIMEOUT, async () => {
  const before = process.env.PATH;
  const r = await fakeGit("ignore-term", CHILD_TIMEOUT_MS, true);
  assert.equal(r.readyError, undefined, "readiness succeeded before the abort");
  assert.ok(r.settled && !r.settled.ok && r.settled.e instanceof GitRunError && r.settled.e.code === "EABORT", "EABORT");
  assert.ok(r.pid !== undefined, "the child recorded its PID");
  assert.equal(r.leaked, false, "the SIGTERM-ignoring child was gone once the call settled");
  assert.equal(process.env.PATH, before, "PATH restored");
});

test(
  "execGit (real process): a git that never reports ready fails readiness cleanly; cleanup aborts, reaps the child and restores PATH",
  TEST_TIMEOUT,
  async () => {
    const before = process.env.PATH;
    const r = await fakeGit("silent", CHILD_TIMEOUT_MS, false);
    assert.match((r.readyError as Error).message, /never reported ready/, "missing ready file is an ordinary readiness failure");
    assert.ok(r.settled && !r.settled.ok && r.settled.e instanceof GitRunError && r.settled.e.code === "EABORT", "cleanup aborted the call");
    assert.ok(r.pid !== undefined, "the child recorded its PID before readiness failed");
    assert.equal(r.leaked, false, "no child left after cleanup");
    assert.equal(process.env.PATH, before, "PATH restored");
    assert.equal(process.env.FAKE_GIT_MODE, undefined, "fake mode variable removed");
  },
);

test(
  "execGit (real process): a git that exits before reporting ready fails readiness at once; the call settles EGIT and PATH is restored",
  TEST_TIMEOUT,
  async () => {
    const before = process.env.PATH;
    const r = await fakeGit("exit", CHILD_TIMEOUT_MS, false);
    assert.match((r.readyError as Error).message, /settled before reporting ready/);
    assert.ok(r.settled && !r.settled.ok && r.settled.e instanceof GitRunError && r.settled.e.code === "EGIT", "non-zero exit is EGIT");
    assert.equal(r.leaked, false);
    assert.equal(process.env.PATH, before, "PATH restored");
  },
);

test("execGit (real process): a missing git executable is a sanitized EGIT (spawn error, no PATH or argv echoed)", TEST_TIMEOUT, async () => {
  const oldPath = process.env.PATH;
  const empty = mkdtempSync(join(tmpdir(), "pomtree-nogit-"));
  process.env.PATH = empty;
  try {
    await assert.rejects(execGit(["status"], { maxBytes: 1024, timeoutMs: CHILD_TIMEOUT_MS }), (e: unknown) => {
      assert.ok(e instanceof GitRunError && e.code === "EGIT");
      assert.doesNotMatch((e as Error).message, new RegExp(empty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(empty, { recursive: true, force: true });
  }
});
