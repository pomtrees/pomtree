import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "@pomtree/testing";
import { evaluateGitVersion } from "./git-env.ts";
import { RESULT_WORK_SCRIPT } from "./result-work-script.ts";
import { createSeedBundle, MIN_RESULT_GIT, SEED_APPLY_SCRIPT, SeedTransferError, verifyAndFetchResult } from "./seed.ts";
import { checkTarPath, createTarSeed, extractTarSeed, packEntries, parseTarSeed, TarSeedError, type TarEntry } from "./tar-seed.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gitVersion.warning ? `real-git seed tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;
if (skip) console.log(`# skip: ${skip}`);
// Result fetching needs the stricter git of MIN_RESULT_GIT; between 2.38 and that, only the result tests skip.
const haveGit = (gitVersion.version ?? "").split(".").map(Number);
const gitOlderThanResult = MIN_RESULT_GIT.map((n, i) => Math.sign((haveGit[i] ?? 0) - n)).find((d) => d !== 0) === -1;
const resultSkip: string | false =
  skip || (gitOlderThanResult ? `result fetch tests need git >= ${MIN_RESULT_GIT.join(".")} (found ${gitVersion.version ?? "unknown"})` : false);
if (resultSkip && !skip) console.log(`# skip: ${resultSkip}`);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV }).toString().trim();

function makeRepo(): string {
  const dir = tmpDir("pomtree-seed-repo-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const hashOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const file = (path: string, data = "x", mode = 0o644): TarEntry => ({ path, kind: "file", mode, data: Buffer.from(data), target: "" });
const link = (path: string, target: string): TarEntry => ({ path, kind: "symlink", mode: 0o777, data: Buffer.alloc(0), target });

test("RESULT_WORK_SCRIPT bytes are unchanged from the Docker adapter's original text", () => {
  assert.equal(hashOf(Buffer.from(RESULT_WORK_SCRIPT)), "bf540b30ca9523f1873a8ac8df9b7a535ebecc4608646d66f08340aa4fe782e4");
});

test("seed round trip: bundle, apply script, work in the sandbox, result bundle fetched to a private ref", { skip: resultSkip }, async () => {
  const repo = makeRepo();
  const seed = await createSeedBundle(repo);
  assert.equal(seed.size, seed.bytes.length);
  assert.equal(seed.seedCommit, seed.headCommit);
  const sandbox = tmpDir("pomtree-seed-sbx-");
  const bundlePath = join(sandbox, "seed.bundle");
  writeFileSync(bundlePath, seed.bytes);
  const dest = join(sandbox, "work");
  const applied = spawnSync(
    process.execPath,
    ["-e", SEED_APPLY_SCRIPT, JSON.stringify({ bundle: bundlePath, sha256: seed.sha256, size: seed.size, dest, branch: "main", ref: seed.ref })],
    { env: GIT_ENV, encoding: "utf8" },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stdout.trim(), seed.headCommit);
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "one\n");
  // The agent commits; the sandbox emits a result bundle on top of the seed.
  writeFileSync(join(dest, "b.txt"), "two\n");
  git(dest, "add", "b.txt");
  git(dest, "commit", "-q", "-m", "agent work");
  const resultFile = join(sandbox, "result.bundle");
  git(dest, "bundle", "create", resultFile, "refs/heads/main", `^${seed.headCommit}`);
  const result = readFileSync(resultFile);
  const sha = hashOf(result);
  const branchBefore = git(repo, "rev-parse", "main");
  const got = await verifyAndFetchResult(repo, result, { sha256: sha, size: result.length, ref: "refs/pomtree/result/t1" });
  assert.equal(got.ref, "refs/pomtree/result/t1");
  assert.equal(got.commit, git(dest, "rev-parse", "HEAD"));
  assert.equal(git(repo, "rev-parse", "main"), branchBefore, "the user's branch must not move");
  assert.equal(git(repo, "show", `${got.ref}:b.txt`), "two");
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/seed-"), "", "the private seed ref is removed after bundling");
  const second = await createSeedBundle(repo);
  assert.notEqual(second.ref, seed.ref, "the seed ref is per call");
});

const applySeed = (seed: { bytes: Uint8Array; sha256: string; size: number; ref: string }, cwd?: string) => {
  const sandbox = tmpDir("pomtree-seed-sbx-");
  writeFileSync(join(sandbox, "s.bundle"), seed.bytes);
  const dest = join(sandbox, "w");
  const r = spawnSync(
    process.execPath,
    ["-e", SEED_APPLY_SCRIPT, JSON.stringify({ bundle: join(sandbox, "s.bundle"), sha256: seed.sha256, size: seed.size, dest, branch: "main", ref: seed.ref })],
    { env: GIT_ENV, encoding: "utf8", ...(cwd && { cwd }) },
  );
  return { r, dest };
};

test("uncommitted tracked changes travel as a commit on a private ref; untracked files stay home; the user's branch, index and files are untouched", {
  skip,
}, async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.txt"), "edited\n");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  writeFileSync(join(repo, ".env"), "SECRET_TOKEN=abc\n");
  writeFileSync(join(repo, "server.pem"), "-----BEGIN KEY-----\n");
  const statusBefore = git(repo, "status", "--porcelain");
  const seed = await createSeedBundle(repo, { includeUncommitted: true });
  assert.notEqual(seed.seedCommit, seed.headCommit);
  assert.equal(git(repo, "rev-parse", "main"), seed.headCommit);
  assert.equal(git(repo, "status", "--porcelain"), statusBefore);
  const { r, dest } = applySeed(seed);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "edited\n");
  assert.equal(existsSync(join(dest, ".env")), false, "an untracked .env must not be shipped");
  assert.equal(existsSync(join(dest, "server.pem")), false);
  assert.equal(existsSync(join(dest, "new.txt")), false, "untracked files need the allowlist");
});

test("includeUntracked ships exactly the allowlisted files", { skip }, async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "new.txt"), "untracked\n");
  writeFileSync(join(repo, "other.txt"), "not listed\n");
  const seed = await createSeedBundle(repo, { includeUntracked: ["src/new.txt"] });
  const { r, dest } = applySeed(seed);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dest, "src", "new.txt"), "utf8"), "untracked\n");
  assert.equal(existsSync(join(dest, "other.txt")), false);
});

test("includeUntracked refuses secrets, bad paths and missing files, naming the cause and the action", { skip }, async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "d"));
  for (const f of [".env", ".env.local", "k.pem", "d/id_rsa", ".npmrc", ".netrc", "credentials.json", "x.p12", "d/server.key"])
    writeFileSync(join(repo, f), "s");
  symlinkSync("a.txt", join(repo, "ln"));
  for (const bad of [".env", ".env.local", "k.pem", "d/id_rsa", ".npmrc", ".netrc", "credentials.json", "x.p12", "d/server.key", ".git/config"])
    await assert.rejects(
      createSeedBundle(repo, { includeUntracked: [bad] }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /secret|deny|\.git/i.test(e.message) && /remove|rename/i.test(e.message),
      bad,
    );
  for (const bad of ["/etc/passwd", "../x", "a/../../x", "missing.txt", "d", "ln", "", "-n"])
    await assert.rejects(
      createSeedBundle(repo, { includeUntracked: [bad] }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid",
      JSON.stringify(bad),
    );
});

test("the seed apply script works from a cwd that is not a repository", { skip }, async () => {
  const repo = makeRepo();
  const seed = await createSeedBundle(repo);
  const { r, dest } = applySeed(seed, tmpDir("pomtree-seed-cwd-"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "one\n");
});

test("the seed apply script leaves nothing behind when git rejects a bundle whose hash and size are honest", { skip }, async () => {
  const garbage = Buffer.from("# v2 git bundle\n\nnot a pack\n");
  const { r, dest } = applySeed(
    { bytes: garbage, sha256: hashOf(garbage), size: garbage.length, ref: "refs/pomtree/seed-0123456789abcdef" },
    tmpDir("pomtree-seed-cwd-"),
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /seed git (bundle verify|fetch) failed/);
  assert.equal(existsSync(dest), false);
});

test("no host path appears in the seed payload", { skip }, async () => {
  const repo = makeRepo();
  const planted = join(repo, "planted-host-marker");
  writeFileSync(join(repo, "notes.txt"), "plain\n");
  git(repo, "add", "notes.txt");
  git(repo, "commit", "-q", "-m", "second");
  const seed = await createSeedBundle(repo, { includeUncommitted: true });
  assert.equal(Buffer.from(seed.bytes).includes(Buffer.from(repo)), false);
  assert.equal(Buffer.from(seed.bytes).includes(Buffer.from(planted)), false);
  const tar = createTarSeed(repo);
  assert.equal(Buffer.from(tar.bytes).includes(Buffer.from(repo)), false);
  // Control: the check can fail. A file that embeds the path shows up in the (uncompressed) archive.
  writeFileSync(join(repo, "leak.txt"), repo);
  assert.equal(Buffer.from(createTarSeed(repo).bytes).includes(Buffer.from(repo)), true);
});

test("a seed over the cap is refused, naming the cap and the action", { skip }, async () => {
  const repo = makeRepo();
  await assert.rejects(
    createSeedBundle(repo, { maxBytes: 10 }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "too-large" && /raise the cap/.test(e.message),
  );
});

test("a repository without a commit cannot be seeded", { skip }, async () => {
  const dir = tmpDir("pomtree-seed-empty-");
  git(dir, "init", "-q", "-b", "main");
  await assert.rejects(createSeedBundle(dir), (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /tar transfer/.test(e.message));
});

async function resultFixture() {
  const repo = makeRepo();
  const seed = await createSeedBundle(repo);
  const sandbox = tmpDir("pomtree-seed-sbx-");
  writeFileSync(join(sandbox, "s.bundle"), seed.bytes);
  const dest = join(sandbox, "w");
  git(sandbox, "init", "-q", "-b", "main", dest);
  git(dest, "fetch", "-q", join(sandbox, "s.bundle"), `${seed.ref}:${seed.ref}`);
  git(dest, "checkout", "-q", "-B", "main", seed.ref);
  writeFileSync(join(dest, "big.bin"), Buffer.from(Array.from({ length: 20000 }, (_, i) => (i * 7919) % 251)));
  git(dest, "add", "big.bin");
  git(dest, "commit", "-q", "-m", "work");
  git(dest, "bundle", "create", join(sandbox, "r.bundle"), "refs/heads/main", `^${seed.headCommit}`);
  const bytes = readFileSync(join(sandbox, "r.bundle"));
  return { repo, bytes, sha: hashOf(bytes) };
}

test("a truncated result bundle is rejected before anything is applied (declared hash and size match the truncated bytes)", { skip: resultSkip }, async () => {
  const { repo, bytes } = await resultFixture();
  const cut = bytes.subarray(0, bytes.length - 40);
  const sha = hashOf(cut);
  // The sender lied or hashed after truncation: only git verification can catch it.
  await assert.rejects(
    verifyAndFetchResult(repo, cut, { sha256: sha, size: cut.length, ref: "refs/pomtree/result/x" }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "partial",
  );
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/"), "", "no ref was created");
});

test("truncation is caught by the hash layer alone: the size claim is honest about the cut bytes but the declared sha256 is the original's", {
  skip: resultSkip,
}, async () => {
  const { repo, bytes, sha } = await resultFixture();
  const cut = bytes.subarray(0, bytes.length - 40);
  await assert.rejects(
    verifyAndFetchResult(repo, cut, { sha256: sha, size: cut.length, ref: "refs/pomtree/result/x" }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "hash-mismatch",
  );
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/"), "");
});

test("a truncated bundle against the true declared size and hash is rejected as partial", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  await assert.rejects(
    verifyAndFetchResult(repo, bytes.subarray(0, bytes.length - 5), { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/x" }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "partial",
  );
});

test("a bundle with one flipped byte is rejected as a hash mismatch (control: the unflipped bundle is accepted)", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 0xff;
  await assert.rejects(
    verifyAndFetchResult(repo, flipped, { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/x" }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "hash-mismatch",
  );
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/"), "");
  const ok = await verifyAndFetchResult(repo, bytes, { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/x" });
  assert.equal(ok.ref, "refs/pomtree/result/x");
});

test("the seed apply script refuses a flipped or truncated seed and leaves the destination absent", { skip }, async () => {
  const repo = makeRepo();
  const seed = await createSeedBundle(repo);
  const sandbox = tmpDir("pomtree-seed-sbx-");
  const run = (bytes: Uint8Array, name: string) => {
    writeFileSync(join(sandbox, `${name}.bundle`), bytes);
    const dest = join(sandbox, name);
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        SEED_APPLY_SCRIPT,
        JSON.stringify({ bundle: join(sandbox, `${name}.bundle`), sha256: seed.sha256, size: seed.size, dest, branch: "main", ref: seed.ref }),
      ],
      { env: GIT_ENV, encoding: "utf8" },
    );
    return { r, dest };
  };
  const flipped = Buffer.from(seed.bytes);
  flipped[flipped.length - 10] = flipped[flipped.length - 10]! ^ 0xff;
  const a = run(flipped, "flip");
  assert.notEqual(a.r.status, 0);
  assert.match(a.r.stderr, /sha256 does not match/);
  assert.equal(existsSync(a.dest), false);
  const b = run(seed.bytes.subarray(0, seed.size - 10), "cut");
  assert.notEqual(b.r.status, 0);
  assert.match(b.r.stderr, /truncated/);
  assert.equal(existsSync(b.dest), false);
});

test("a result ref outside refs/pomtree/ is refused", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  for (const ref of ["refs/heads/main", "refs/pomtree/../heads/main", "HEAD"])
    await assert.rejects(
      verifyAndFetchResult(repo, bytes, { sha256: sha, size: bytes.length, ref }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid",
    );
});

test("a result over maxBytes is refused as too-large", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  await assert.rejects(
    verifyAndFetchResult(repo, bytes, { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/x", maxBytes: 100 }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "too-large",
  );
});

function withRefName(bytes: Uint8Array, name: string): Buffer {
  const buf = Buffer.from(bytes);
  const off = buf.indexOf("PACK");
  const head = buf
    .subarray(0, off)
    .toString("latin1")
    .replace(/^([0-9a-f]{40}) .+$/m, `$1 ${name}`);
  return Buffer.concat([Buffer.from(head, "latin1"), buf.subarray(off)]);
}

test("a source ref name that could widen the refspec is refused before git sees it", { skip: resultSkip }, async () => {
  const { repo, bytes } = await resultFixture();
  const accepted = withRefName(bytes, "refs/heads/feature-1.x");
  const ok = await verifyAndFetchResult(repo, accepted, { sha256: hashOf(accepted), size: accepted.length, ref: "refs/pomtree/result/ok" });
  assert.equal(ok.ref, "refs/pomtree/result/ok");
  for (const name of [
    "refs/heads/a:b",
    "refs/heads/*",
    "refs/heads/a?b",
    "refs/heads/a..b",
    "refs/heads/x.lock",
    "refs/heads/x/",
    "refs/other/x",
    "HEAD",
    "refs/heads/a b",
  ]) {
    const evil = withRefName(bytes, name);
    await assert.rejects(
      verifyAndFetchResult(repo, evil, { sha256: hashOf(evil), size: evil.length, ref: "refs/pomtree/result/bad" }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /ref/.test(e.message),
      name,
    );
  }
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/result/bad"), "");
});

test("a bundle claiming more objects than the cap is refused before fetching", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  await assert.rejects(
    verifyAndFetchResult(repo, bytes, { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/x", maxObjects: 1 }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "too-large" && /object/.test(e.message),
  );
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/"), "");
});

// A bundle whose commit holds a tree that git's own fsck refuses (a `.git` entry, a `.gitmodules` symlink). `git bundle verify` and
// `git fetch` accept it, so only the strict index-pack pass in the scratch repository stops it before it reaches the user's objects.
function evilBundle(kind: "dotgit" | "gitmodules-symlink") {
  const repo = makeRepo();
  const work = tmpDir("pomtree-evil-");
  git(work, "clone", "-q", repo, "w");
  const w = join(work, "w");
  const run = (args: string[], input?: Buffer) =>
    execFileSync("git", args, { cwd: w, env: GIT_ENV, ...(input && { input }) })
      .toString()
      .trim();
  const base = run(["rev-parse", "HEAD"]);
  const emptyTree = run(["hash-object", "-t", "tree", "-w", "--stdin"], Buffer.alloc(0));
  const blob = run(["hash-object", "-w", "--stdin"], Buffer.from("x"));
  const entry = (mode: string, name: string, oid: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);
  const raw =
    kind === "dotgit"
      ? Buffer.concat([entry("40000", ".git", emptyTree), entry("100644", "zz", blob)])
      : Buffer.concat([entry("120000", ".gitmodules", blob), entry("100644", "zz", blob)]);
  const tree = run(["hash-object", "-t", "tree", "-w", "--literally", "--stdin"], raw);
  const commit = run(["commit-tree", tree, "-p", base, "-m", "evil"]);
  run(["update-ref", "refs/heads/main", commit]);
  run(["bundle", "create", join(work, "evil.bundle"), "refs/heads/main", `^${base}`]);
  const bundlePath = join(work, "evil.bundle");
  const bytes = readFileSync(bundlePath);
  return { repo, bytes, bundlePath, tree, commit };
}

for (const kind of ["dotgit", "gitmodules-symlink"] as const)
  test(`a bundle carrying a ${kind} tree is refused by the strict pass and no object reaches the user's repository`, { skip: resultSkip }, async () => {
    const { repo, bytes, bundlePath, tree, commit } = evilBundle(kind);
    // Control: git itself accepts the bundle, so the refusal below is ours.
    execFileSync("git", ["bundle", "verify", "-q", bundlePath], { cwd: repo, env: GIT_ENV });
    await assert.rejects(
      verifyAndFetchResult(repo, bytes, { sha256: hashOf(bytes), size: bytes.length, ref: "refs/pomtree/result/evil" }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /strict|fsck|unsafe/i.test(e.message),
    );
    assert.equal(git(repo, "for-each-ref", "refs/pomtree/"), "");
    for (const oid of [tree, commit]) assert.throws(() => git(repo, "cat-file", "-e", oid), `${oid} must not be in the user's object store`);
  });

// ---- tar fallback ----

test("tar round trip is deterministic and restores files, modes, directories and an inside symlink", () => {
  const src = tmpDir("pomtree-tar-src-");
  mkdirSync(join(src, "d"));
  writeFileSync(join(src, "d", "f.txt"), "hello");
  writeFileSync(join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("d/f.txt", join(src, "alias"));
  mkdirSync(join(src, ".git"));
  writeFileSync(join(src, ".git", "config"), "skipped");
  const a = createTarSeed(src);
  const b = createTarSeed(src);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.fileCount, 2);
  const dest = tmpDir("pomtree-tar-dst-");
  extractTarSeed(a.bytes, dest, a);
  assert.equal(readFileSync(join(dest, "d", "f.txt"), "utf8"), "hello");
  assert.equal(lstatSync(join(dest, "run.sh")).mode & 0o111, 0o111);
  assert.equal(readlinkSync(join(dest, "alias")), "d/f.txt");
  assert.deepEqual(readdirSync(dest).sort(), ["alias", "d", "run.sh"]);
});

test("tar paths: absolute, parent, dot, backslash and NUL entries are rejected (control: a plain path passes)", () => {
  assert.equal(checkTarPath("a/b.txt"), "a/b.txt");
  for (const bad of ["/etc/passwd", "../x", "a/../../x", "a/./b", "a\\b", "a\0b", "", "a//b"])
    assert.throws(() => checkTarPath(bad), TarSeedError, JSON.stringify(bad));
});

test("a hostile archive is refused as a whole and nothing is extracted", () => {
  const dest = tmpDir("pomtree-tar-dst-");
  const cases: [string, TarEntry[]][] = [
    ["traversal", [file("ok.txt"), file("../escape.txt")]],
    ["absolute", [file("ok.txt"), file("/abs.txt")]],
    ["absolute symlink", [file("ok.txt"), link("l", "/etc")]],
    ["escaping symlink", [file("ok.txt"), link("l", "../../outside")]],
    ["escaping nested symlink", [file("ok.txt"), link("d/l", "../../x")]],
    ["write through symlink", [link("l", "d"), file("l/pwn.txt")]],
    ["duplicate", [file("ok.txt"), file("ok.txt")]],
  ];
  for (const [name, entries] of cases) {
    // packEntries sorts entries, so the archive is not in hostile order; every case must be refused by validation alone, whatever the order.
    const bytes = packEntries(entries);
    const sha = hashOf(bytes);
    assert.throws(() => extractTarSeed(bytes, dest, { sha256: sha, size: bytes.length }), TarSeedError, name);
    assert.deepEqual(readdirSync(dest), [], `${name}: nothing extracted`);
  }
});

test("device nodes, hard links and extended headers are refused", () => {
  for (const type of ["1", "3", "4", "6", "x", "g"]) {
    const bytes = packEntries([file("n")]);
    bytes[156] = type.charCodeAt(0);
    const sum = [...bytes.subarray(0, 512)].reduce((a, c, i) => a + (i >= 148 && i < 156 ? 0x20 : c), 0);
    bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    assert.throws(
      () => parseTarSeed(bytes),
      (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe",
      `type ${type}`,
    );
  }
});

test("creating an archive refuses an escaping symlink and a device-like entry names the action", () => {
  const src = tmpDir("pomtree-tar-src-");
  symlinkSync("../../etc", join(src, "out"));
  assert.throws(
    () => createTarSeed(src),
    (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe" && /remove the link/.test(e.message),
  );
});

test("tar truncation and a flipped byte are rejected; the unflipped archive is the control", () => {
  const src = tmpDir("pomtree-tar-src-");
  writeFileSync(join(src, "f.txt"), "content ".repeat(200));
  const t = createTarSeed(src);
  const dest = () => tmpDir("pomtree-tar-dst-");
  assert.throws(
    () => extractTarSeed(t.bytes.subarray(0, t.size - 600), dest(), t),
    (e: unknown) => e instanceof TarSeedError && e.reason === "partial",
  );
  const flipped = Buffer.from(t.bytes);
  flipped[600] = flipped[600]! ^ 0xff;
  assert.throws(
    () => extractTarSeed(flipped, dest(), t),
    (e: unknown) => e instanceof TarSeedError && e.reason === "hash-mismatch",
  );
  assert.equal(extractTarSeed(t.bytes, dest(), t).fileCount, 1);
  // Declared hash matches truncated bytes: the parser itself must catch it.
  const cut = t.bytes.subarray(0, t.size - 600);
  assert.throws(
    () => extractTarSeed(cut, dest(), { sha256: hashOf(cut), size: cut.length }),
    (e: unknown) => e instanceof TarSeedError && e.reason === "partial",
  );
});

test("tar large file and total caps are enforced on create and extract", () => {
  const src = tmpDir("pomtree-tar-src-");
  writeFileSync(join(src, "big.bin"), Buffer.alloc(4096, 1));
  assert.throws(
    () => createTarSeed(src, { maxBytes: 1 << 20, maxFileBytes: 1000, maxEntries: 1000 }),
    (e: unknown) => e instanceof TarSeedError && e.reason === "too-large" && /per-file cap/.test(e.message),
  );
  assert.throws(
    () => createTarSeed(src, { maxBytes: 2000, maxFileBytes: 1 << 20, maxEntries: 1000 }),
    (e: unknown) => e instanceof TarSeedError && e.reason === "too-large",
  );
  const ok = createTarSeed(src);
  assert.throws(
    () => extractTarSeed(ok.bytes, tmpDir("pomtree-tar-dst-"), ok, { maxBytes: 1 << 20, maxFileBytes: 1000, maxEntries: 1000 }),
    (e: unknown) => e instanceof TarSeedError && e.reason === "too-large",
  );
});

const sumFix = (b: Buffer, at = 0) => {
  const sum = [...b.subarray(at, at + 512)].reduce((a, c, i) => a + (i >= 148 && i < 156 ? 0x20 : c), 0);
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, at + 148, "latin1");
};
const dir = (path: string): TarEntry => ({ path, kind: "dir", mode: 0o755, data: Buffer.alloc(0), target: "" });
const tryExtract = (entries: TarEntry[], dest = tmpDir("pomtree-tar-dst-")) => {
  const bytes = packEntries(entries);
  return { dest, run: () => extractTarSeed(bytes, dest, { sha256: hashOf(bytes), size: bytes.length }) };
};

test("symlinks are resolved through in-archive links: a chain that leaves the root is refused, a harmless chain is accepted", () => {
  const chain = tryExtract([dir("x"), link("x/y", ".."), link("z", "x/y/..")]);
  assert.throws(
    () => chain.run(),
    (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe" && /escapes/.test(e.message),
  );
  assert.deepEqual(readdirSync(chain.dest), []);
  const fine = tryExtract([dir("x"), file("x/f"), link("x/y", ".."), link("w", "x/y/x/f")]);
  assert.equal(fine.run().fileCount, 1);
});

test("a symlink loop is refused", () => {
  const loop = tryExtract([link("a", "b"), link("b", "a"), link("c", "a/d")]);
  assert.throws(
    () => loop.run(),
    (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe" && /loop|too many/.test(e.message),
  );
  const self = tryExtract([link("s", "s/x")]);
  assert.throws(() => self.run(), TarSeedError);
});

test("case-folded and NFC/NFD name collisions are refused, including a file shadowing a directory", () => {
  const nfc = "caf\u00e9.txt";
  const nfd = "cafe\u0301.txt";
  for (const [name, entries] of [
    ["case", [file("Readme"), file("README")]],
    ["shadow", [file("z"), file("Z/evil")]],
    ["nfc-nfd", [file(nfc), file(nfd)]],
  ] as const) {
    const t = tryExtract([...entries]);
    assert.throws(
      () => t.run(),
      (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe",
      name,
    );
    assert.deepEqual(readdirSync(t.dest), [], `${name}: nothing extracted`);
  }
});

test("a path below a non-directory entry is refused before anything is written (structural conflict)", () => {
  const t = tryExtract([file("ok.txt"), file("a"), file("a/b")]);
  assert.throws(
    () => t.run(),
    (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe" && /not a directory/.test(e.message),
  );
  assert.deepEqual(readdirSync(t.dest), [], "ok.txt must not have been written");
});

test("extraction needs an existing, empty directory and names the action otherwise", () => {
  const bytes = packEntries([file("f")]);
  const expect = { sha256: hashOf(bytes), size: bytes.length };
  const full = tmpDir("pomtree-tar-dst-");
  writeFileSync(join(full, "old"), "x");
  assert.throws(
    () => extractTarSeed(bytes, full, expect),
    (e: unknown) => e instanceof TarSeedError && /not empty/.test(e.message) && /empty directory/.test(e.message),
  );
  assert.throws(
    () => extractTarSeed(bytes, join(full, "missing"), expect),
    (e: unknown) => e instanceof TarSeedError && /create/.test(e.message),
  );
  assert.throws(() => extractTarSeed(bytes, join(full, "old"), expect), TarSeedError);
  assert.deepEqual(readdirSync(full), ["old"]);
});

test("a header without the ustar magic is refused", () => {
  const bytes = packEntries([file("n")]);
  bytes.write("GNU  \0", 257, "latin1");
  sumFix(bytes);
  assert.throws(
    () => parseTarSeed(bytes),
    (e: unknown) => e instanceof TarSeedError && /ustar/.test(e.message),
  );
});

test("nested .git directories are not carried", () => {
  const src = tmpDir("pomtree-tar-src-");
  mkdirSync(join(src, "vendor", "lib", ".git"), { recursive: true });
  writeFileSync(join(src, "vendor", "lib", ".git", "config"), "[core]\nhooksPath=evil");
  writeFileSync(join(src, "vendor", "lib", "code.txt"), "ok");
  const names = parseTarSeed(createTarSeed(src).bytes).map((e) => e.path);
  assert.deepEqual(names, ["vendor", "vendor/lib", "vendor/lib/code.txt"]);
});

test("extraction refuses entries that write into repository metadata, including look-alike names", () => {
  const refuse = (entries: TarEntry[], name: string) => {
    const t = tryExtract(entries);
    assert.throws(
      () => t.run(),
      (e: unknown) => e instanceof TarSeedError && e.reason === "unsafe" && /git/.test(e.message) && /exclude|refused/.test(e.message),
      name,
    );
    assert.deepEqual(readdirSync(t.dest), [], `${name}: nothing extracted`);
  };
  refuse([file(".git/config")], ".git/config");
  refuse([file(".git/hooks/pre-commit", "#!/bin/sh", 0o755)], ".git/hooks/pre-commit");
  refuse([file("a/.GIT/x")], "a/.GIT/x");
  refuse([file("GIT~1/x")], "GIT~1/x");
  refuse([file(".git /x")], "trailing space");
  refuse([file(".git./x")], "trailing dot");
  refuse([file(".g\u200bit/x")], "zero-width space");
  refuse([link(".gitmodules", "other"), file("other")], ".gitmodules symlink");
  refuse([link("sub/.GITMODULES", "../other"), file("other")], "folded .gitmodules symlink");
  // Controls: near names and a regular .gitmodules file are fine.
  const ok = tryExtract([file(".github/workflows/ci.yml"), file("gitx/y"), file(".gitmodules", "[submodule]"), file(".gitignore")]);
  assert.equal(ok.run().fileCount, 4);
});

test("includeUntracked folds and de-obfuscates the .git check", { skip }, async () => {
  const repo = makeRepo();
  for (const bad of [".GIT/config", ".Git/hooks/x", "a/.g\u200bit/x", "GIT~1/x", ".git /x"])
    await assert.rejects(
      createSeedBundle(repo, { includeUntracked: [bad] }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /\.git/.test(e.message),
      bad,
    );
});

test("the extended deny list refuses secret-looking names and directories at any depth (a guard rail; the allowlist is the control)", { skip }, async () => {
  const repo = makeRepo();
  const names = [
    "a.pfx",
    "a.keystore",
    "a.jks",
    "a.p8",
    "a.ppk",
    "a.gpg",
    "a.asc",
    ".git-credentials",
    ".pypirc",
    ".pgpass",
    ".htpasswd",
    ".dockercfg",
    ".vault-token",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "prod.tfvars",
    "my_secret_notes.txt",
    "service-account.json",
    "kubeconfig",
    "auth.json",
    "config/.env.local",
  ];
  const dirs = [".ssh/config", ".KUBE/config", "x/.aws/credentials-file", ".gnupg/pubring", ".docker/config.json"];
  for (const p of [...names, ...dirs]) {
    mkdirSync(join(repo, p.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    writeFileSync(join(repo, p), "s");
    await assert.rejects(
      createSeedBundle(repo, { includeUntracked: [p] }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /secret|deny/i.test(e.message),
      p,
    );
  }
  writeFileSync(join(repo, "notes.md"), "fine");
  await createSeedBundle(repo, { includeUntracked: ["notes.md"] });
});

test("tracked secrets that would ship are reported by path in warnings (never contents)", { skip }, async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, ".env"), "TOKEN=old\n");
  git(repo, "add", ".env");
  git(repo, "commit", "-q", "-m", "tracked env");
  assert.deepEqual((await createSeedBundle(repo, { includeUncommitted: true })).warnings, []);
  writeFileSync(join(repo, ".env"), "TOKEN=SUPERSECRETVALUE\n");
  writeFileSync(join(repo, "a.txt"), "edited\n");
  const seed = await createSeedBundle(repo, { includeUncommitted: true });
  assert.deepEqual(seed.warnings, [".env"]);
  assert.equal(JSON.stringify(seed.warnings).includes("SUPERSECRET"), false);
});

test("result verification fails closed on a git older than the required minimum, naming both versions", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  const base = { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/v" };
  for (const old of ["git version 2.44.0", "git version 2.39.5 (Apple Git-154)", "unparseable"])
    await assert.rejects(
      verifyAndFetchResult(repo, bytes, { ...base, gitVersion: old }),
      (e: unknown) => e instanceof SeedTransferError && e.reason === "git-too-old" && /2\.45\.1/.test(e.message) && /upgrade git/i.test(e.message),
      old,
    );
  assert.equal(git(repo, "for-each-ref", "refs/pomtree/result/v"), "");
  const ok = await verifyAndFetchResult(repo, bytes, { ...base, gitVersion: "git version 2.45.1" });
  assert.equal(ok.ref, "refs/pomtree/result/v");
});

test("the seed apply script refuses option-looking paths and an unreadable bundle cleanly", { skip }, async () => {
  const repo = makeRepo();
  const seed = await createSeedBundle(repo);
  const run = (bundle: string, dest: string) =>
    spawnSync(
      process.execPath,
      ["-e", SEED_APPLY_SCRIPT, JSON.stringify({ bundle, sha256: seed.sha256, size: seed.size, dest, branch: "main", ref: seed.ref })],
      {
        env: GIT_ENV,
        encoding: "utf8",
        cwd: tmpDir("pomtree-seed-cwd-"),
      },
    );
  const sbx = tmpDir("pomtree-seed-sbx-");
  const dash = run("--upload-pack=x", join(sbx, "d1"));
  assert.notEqual(dash.status, 0);
  assert.match(dash.stderr, /must not start with/);
  const dashDest = run(join(sbx, "none.bundle"), "-bad");
  assert.match(dashDest.stderr, /must not start with/);
  const missing = run(join(sbx, "none.bundle"), join(sbx, "d2"));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /cannot read the seed bundle/);
  assert.doesNotMatch(missing.stderr, /at Object|node:internal/);
});

test("a result ref that already exists is refused, not overwritten, and the existing ref keeps its commit", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  const expect = { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/dup" };
  const first = await verifyAndFetchResult(repo, bytes, expect);
  await assert.rejects(
    verifyAndFetchResult(repo, bytes, expect),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /already exists/.test(e.message) && /choose a new|different/i.test(e.message),
  );
  assert.equal(git(repo, "rev-parse", expect.ref), first.commit);
  // The seed namespace is not exempt: an existing seed-* ref is refused too.
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/pomtree/seed-0123456789abcdef", head);
  await assert.rejects(
    verifyAndFetchResult(repo, bytes, { ...expect, ref: "refs/pomtree/seed-0123456789abcdef" }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid",
  );
  assert.equal(git(repo, "rev-parse", "refs/pomtree/seed-0123456789abcdef"), head);
});

test("includeUntracked refuses a file reached through a symlinked directory, naming the cause and the action", { skip }, async () => {
  const repo = makeRepo();
  const outside = tmpDir("pomtree-seed-outside-");
  writeFileSync(join(outside, "x.txt"), "x");
  symlinkSync(outside, join(repo, "dlink"));
  await assert.rejects(
    createSeedBundle(repo, { includeUntracked: ["dlink/x.txt"] }),
    (e: unknown) => e instanceof SeedTransferError && e.reason === "invalid" && /symlink/.test(e.message) && /list individual regular files/.test(e.message),
  );
});

test("the seed apply script refuses a relative dest and a dest that is a file, naming the cause and the action", { skip }, async () => {
  const repo = makeRepo();
  const seed = await createSeedBundle(repo);
  const sbx = tmpDir("pomtree-seed-sbx-");
  writeFileSync(join(sbx, "s.bundle"), seed.bytes);
  writeFileSync(join(sbx, "afile"), "x");
  const run = (dest: string) =>
    spawnSync(
      process.execPath,
      ["-e", SEED_APPLY_SCRIPT, JSON.stringify({ bundle: join(sbx, "s.bundle"), sha256: seed.sha256, size: seed.size, dest, branch: "main", ref: seed.ref })],
      { env: GIT_ENV, encoding: "utf8", cwd: sbx },
    );
  const rel = run("relative/dir");
  assert.notEqual(rel.status, 0);
  assert.match(rel.stderr, /absolute/);
  assert.equal(existsSync(join(sbx, "relative")), false);
  const onFile = run(join(sbx, "afile"));
  assert.notEqual(onFile.status, 0);
  assert.match(onFile.stderr, /not a directory/);
  assert.doesNotMatch(onFile.stderr, /at Object|node:internal/);
});

test("a tar archive over the entry cap is refused on create and on extract; at the cap it is accepted", () => {
  const src = tmpDir("pomtree-tar-src-");
  for (const n of ["a", "b", "c"]) writeFileSync(join(src, n), n);
  const limits = { maxBytes: 1 << 20, maxFileBytes: 1 << 20, maxEntries: 3 };
  const ok = createTarSeed(src, limits);
  assert.equal(ok.fileCount, 3);
  assert.equal(extractTarSeed(ok.bytes, tmpDir("pomtree-tar-dst-"), ok, limits).fileCount, 3);
  writeFileSync(join(src, "d"), "d");
  assert.throws(
    () => createTarSeed(src, limits),
    (e: unknown) => e instanceof TarSeedError && e.reason === "too-large" && /entry cap/.test(e.message),
  );
  const bytes = packEntries(["a", "b", "c", "d"].map((n) => file(n)));
  assert.throws(
    () => parseTarSeed(bytes, limits),
    (e: unknown) => e instanceof TarSeedError && e.reason === "too-large" && /entry cap/.test(e.message),
  );
});

test("an I/O error part-way through extraction empties the destination again and names the action", () => {
  const entries = [file("a", "1"), file("b", "2"), file("c", "3")];
  const bytes = packEntries(entries);
  const expect = { sha256: hashOf(bytes), size: bytes.length };
  const dest = tmpDir("pomtree-tar-dst-");
  const real = fs.writeFileSync;
  let calls = 0;
  mock.method(fs, "writeFileSync", (...args: Parameters<typeof real>) => {
    if (++calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return real(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => extractTarSeed(bytes, dest, expect),
      (e: unknown) => e instanceof TarSeedError && e.reason === "partial" && /ENOSPC/.test(e.message) && /retry/.test(e.message),
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(calls >= 2, "the failing write was reached after a first file was written");
  assert.deepEqual(readdirSync(dest), [], "no half-extracted files remain");
  assert.equal(extractTarSeed(bytes, dest, expect).fileCount, 3, "the same directory can be reused");
});

test("a git failure while preparing the strict check names no scratch path", { skip: resultSkip }, async () => {
  const { repo, bytes, sha } = await resultFixture();
  const shims = tmpDir("pomtree-git-shim-");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(shims, "git"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = init ] && { echo "fatal: cannot init $*" >&2; exit 128; }; done\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${shims}:${oldPath}`;
  try {
    await assert.rejects(
      verifyAndFetchResult(repo, bytes, { sha256: sha, size: bytes.length, ref: "refs/pomtree/result/leak" }),
      (e: unknown) =>
        e instanceof SeedTransferError && e.reason === "partial" && !/pomtree-result|strict\.git|\/tmp/.test(e.message) && /collect again/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
  }
});
