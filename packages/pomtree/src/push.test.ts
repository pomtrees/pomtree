import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EXIT, run } from "./cli.ts";
import type { Call, Reply } from "./client.ts";
import { gitTooOld } from "./git.ts";
import { harness as kitHarness } from "./test-kit.ts";

const ver = spawnSync("git", ["--version"], { encoding: "utf8" });
const skip = ver.status !== 0 ? "git is not installed" : (gitTooOld(ver.stdout) ?? false);

const GENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, ...GENV } });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-pushtest-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "agent/a1");
  return { dir, base };
}

function harness(dir: string, base: string | undefined, handler: (c: Call) => Reply | Promise<Reply>) {
  return kitHarness(handler, { cwd: dir, tmpRoot: ROOT, env: { ...GENV, ...(base ? { POMTREE_BASE_COMMIT: base } : {}) } });
}

const ROOT = mkdtempSync(join(tmpdir(), "pomtree-pushtest-root-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const pomtree = () => readdirSync(ROOT);

test("push bundles only commits beyond the base, posts octet-stream with a key, prints refs", { skip }, async () => {
  const { dir, base } = setup();
  try {
    writeFileSync(join(dir, "b.txt"), "new\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "work");
    const tip = git(dir, "rev-parse", "HEAD");
    const before = pomtree();
    const h = harness(dir, base, () => ({ status: 200, body: { ok: true, refs: [{ ref: "refs/agents/a1/heads/agent/a1", commit: tip }] } }));
    assert.equal(await run(["push", "--key", "k1"], h.io), EXIT.ok);
    const c = h.calls[0]!;
    assert.equal(c.method, "POST");
    assert.equal(c.path, "/v1/agents/self/push?key=k1");
    assert.ok(c.body instanceof Uint8Array);
    assert.deepEqual(h.out, [`refs/agents/a1/heads/agent/a1 ${tip}`]);
    assert.deepEqual(pomtree(), before); // temp dir removed
    // Prerequisite exclusion: the bundle lists the base as prerequisite and carries none of its objects.
    const f = join(dir, "got.bundle");
    writeFileSync(f, c.body as Uint8Array);
    assert.match(git(dir, "bundle", "list-heads", f), new RegExp(`${tip} refs/heads/agent/a1`));
    const v = spawnSync("git", ["bundle", "verify", f], { cwd: dir, encoding: "utf8", env: { ...process.env, ...GENV } });
    assert.match(v.stdout + v.stderr, new RegExp(base)); // base is the prerequisite
    // Unpack the bundle's pack into an EMPTY repo: it holds the new commit but not the base commit.
    const raw = Buffer.from(c.body as Uint8Array);
    const pack = raw.subarray(raw.indexOf("\n\n") + 2);
    const empty = mkdtempSync(join(tmpdir(), "pomtree-pushtest-"));
    try {
      git(empty, "init", "-q", "--bare");
      const u = spawnSync("git", ["unpack-objects", "-q"], { cwd: empty, input: pack, env: { ...process.env, ...GENV } });
      assert.equal(u.status, 0, String(u.stderr));
      const have = git(empty, "cat-file", "--batch-all-objects", "--batch-check");
      assert.match(have, new RegExp(`^${tip} commit`, "m"));
      assert.doesNotMatch(have, new RegExp(base));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push errors: no base, empty bundle, missing branch, 413, 4xx code", { skip }, async () => {
  const { dir, base } = setup();
  try {
    const none = harness(dir, undefined, () => ({ status: 200, body: {} }));
    assert.equal(await run(["push"], none.io), EXIT.usage);
    assert.match(none.err.join(), /POMTREE_BASE_COMMIT/);
    const empty = harness(dir, base, () => ({ status: 200, body: {} }));
    assert.equal(await run(["push"], empty.io), EXIT.error);
    assert.match(empty.err.join(), /nothing to push/);
    assert.equal(empty.calls.length, 0);
    const missing = harness(dir, base, () => ({ status: 200, body: {} }));
    assert.equal(await run(["push", "--branch", "nope"], missing.io), EXIT.error);
    assert.match(missing.err.join(), /does not exist/);
    writeFileSync(join(dir, "b.txt"), "x");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "w");
    const big = harness(dir, base, () => ({ status: 413, body: { error: "too big", code: "too_large" } }));
    assert.equal(await run(["push"], big.io), EXIT.usage);
    assert.match(big.err.join(), /too large/);
    const pre = harness(dir, base, () => ({ status: 422, body: { error: "x", code: "prerequisite" } }));
    assert.equal(await run(["push"], pre.io), EXIT.error);
    assert.match(pre.err.join(), /prerequisite/);
    assert.deepEqual(
      pomtree().filter((n) => n.startsWith("pomtree-push-")),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pull fetches a served bundle into refs/remotes/pomtreed*, cleans up, maps 403", { skip }, async () => {
  const { dir, base } = setup();
  const src = mkdtempSync(join(tmpdir(), "pomtree-pushtest-"));
  try {
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "base\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-q", "-m", "base");
    git(src, "update-ref", "refs/agents/a2/heads/agent/a2", "HEAD");
    const bundle = join(src, "s.bundle");
    git(src, "bundle", "create", bundle, "refs/heads/main", "refs/agents/a2/heads/agent/a2");
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(bundle);
    const h = harness(dir, base, () => ({ status: 200, body: bytes }));
    assert.equal(await run(["pull", "--from", "a2"], h.io), EXIT.ok);
    assert.deepEqual(h.calls[0], { method: "GET", path: "/v1/agents/self/pull?from=a2", raw: true });
    assert.ok(git(dir, "for-each-ref", "refs/remotes/pomtreed", "refs/remotes/pomtreed-agents").includes("refs/remotes/pomtreed-agents/a2/heads/agent/a2"));
    assert.ok(git(dir, "for-each-ref", "refs/remotes/pomtreed").includes("refs/remotes/pomtreed/main"));
    assert.deepEqual(
      pomtree().filter((n) => n.startsWith("pomtree-pull-")),
      [],
    );
    const denied = harness(dir, base, () => ({ status: 403, body: Buffer.from(JSON.stringify({ error: "forbidden" })) }));
    assert.equal(await run(["pull", "--from", "zz"], denied.io), EXIT.denied);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("push --force sends force=1; a 409 non_fast_forward exits 5 with a pull hint", { skip }, async () => {
  const { dir, base } = setup();
  try {
    writeFileSync(join(dir, "b.txt"), "new\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "work");
    const ok = harness(dir, base, () => ({ status: 200, body: { ok: true, refs: [] } }));
    assert.equal(await run(["push", "--force", "--key", "k2"], ok.io), EXIT.ok);
    assert.equal(ok.calls[0]!.path, "/v1/agents/self/push?key=k2&force=1");
    const nff = harness(dir, base, () => ({ status: 409, body: { ok: false, code: "non_fast_forward", error: "not a fast-forward" } }));
    assert.equal(await run(["push"], nff.io), EXIT.conflict);
    assert.equal(nff.calls[0]!.path.includes("force"), false);
    assert.match(nff.err.join(), /non_fast_forward/);
    assert.match(nff.err.join(), /pomtree pull/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
