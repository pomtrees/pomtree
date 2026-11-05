import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isGitRepo, realIo } from "./cli.ts";
import { runInit } from "./init.ts";
import { checkTemplateFiles } from "./template-check.ts";

const facts = { nodeRange: ">=24", pnpmVersion: "10.19.0", minGit: "2.38.0", defaultImage: "pomtree/agent:dev" };
const config = {
  "model.baseUrl": "https://api.example.com/v1",
  "pi.provider": "openrouter",
  "agent.egressProxyImage": `sha256:${"a".repeat(64)}`,
  "agent.untemplatedEgress": "none",
  "extensions.approval": "all",
};

// The real filesystem adapter in a temp dir: the in-memory IO of init.test.ts cannot see directory creation, symlinks or modes.
async function withDir(f: (dir: string, go: (argv: string[], answers: object) => ReturnType<typeof runInit>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pomtreed-init-real-"));
  try {
    const go = (argv: string[], answers: object) =>
      runInit(argv, {
        io: realIo,
        defaultOut: join(dir, "default"),
        defaultStateDir: join(dir, "state"),
        checkout: join(dir, "checkout"),
        isGitRepo: () => true,
        node: process.execPath,
        uid: process.getuid?.() ?? null,
        readAnswers: () => JSON.stringify({ ...answers, config: { "repo.dir": join(dir, "repo"), ...(answers as { config?: object }).config } }),
        readServiceTemplate: () => "",
        facts,
        realpath: (p) => p,
        checkTemplates: checkTemplateFiles,
      });
    await f(dir, go);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const repo = { templates: [{ id: "review", egress: "none" }] };

test("realIo: --write with a template creates the templates directory, files are 0600, the key is created empty, and a second run is a no-op", async () => {
  await withDir(async (dir, go) => {
    const out = join(dir, "out");
    const answers = { config, keyFile: join(dir, "keys", "model.key"), repo };
    const first = await go(["--answers", "a", "--out", out, "--write"], answers);
    assert.equal(first.code, 0, first.lines.join("\n"));
    assert.equal(lstatSync(join(out, "templates", "review.json")).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(out, "pomtreed.env")).mode & 0o777, 0o600);
    assert.equal(readFileSync(answers.keyFile, "utf8"), "");
    assert.equal(lstatSync(answers.keyFile).mode & 0o777, 0o600);
    const second = await go(["--answers", "a", "--out", out, "--write"], answers);
    assert.equal(second.code, 0);
    assert.match(second.lines.join("\n"), /unchanged .*review\.json/);
  });
});

test("realIo: a dangling-symlink key file and a symlinked planned file are refused with nothing written", async () => {
  await withDir(async (dir, go) => {
    const out = join(dir, "out");
    mkdirSync(out);
    const key = join(dir, "key");
    symlinkSync(join(dir, "nowhere"), key);
    const r = await go(["--answers", "a", "--out", out, "--write"], { config, keyFile: key });
    assert.equal(r.code, 2);
    assert.match(r.lines.join("\n"), /symlink/);
    assert.throws(() => lstatSync(join(out, "pomtreed.env")));
    const target = join(dir, "victim");
    writeFileSync(target, "precious");
    symlinkSync(target, join(out, "pomtreed.env"));
    const r2 = await go(["--answers", "a", "--out", out, "--write", "--force"], { config, keyFile: join(dir, "k2") });
    assert.equal(r2.code, 2);
    assert.equal(readFileSync(target, "utf8"), "precious");
  });
});

test("realIo.readText: a path swapped for a symlink or another file after its lstat is refused, never read; the unchanged file is read", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "pomtreed.env");
    writeFileSync(path, "A=1\n");
    const seen = realIo.lstat(path);
    assert.ok(seen);
    assert.equal(realIo.readText(path, seen), "A=1\n", "negative control: the file lstat saw is read");
    // another file renamed over it; created while the original still holds its inode, so the inode cannot be reused
    writeFileSync(join(dir, "other"), "A=1\n");
    renameSync(join(dir, "other"), path);
    assert.throws(() => realIo.readText(path, seen), /no longer the regular file init checked/);
    const victim = join(dir, "victim");
    writeFileSync(victim, "precious");
    rmSync(path);
    symlinkSync(victim, path);
    assert.throws(() => realIo.readText(path, seen), /ELOOP|symbolic link/);
  });
});

test("realIo: a symlinked <out>/templates is refused with nothing read or written through it", async () => {
  await withDir(async (dir, go) => {
    const out = join(dir, "out");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(out);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(out, "templates"));
    const r = await go(["--answers", "a", "--out", out, "--write", "--force"], { config, keyFile: join(dir, "keys", "k"), repo });
    assert.equal(r.code, 2);
    assert.match(r.lines.join("\n"), /templates is a symlink/);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.throws(() => lstatSync(join(out, "pomtreed.env")));
  });
});

test("isGitRepo: a git repository is one, a plain directory is not", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "plain"));
    assert.equal(isGitRepo(join(dir, "plain")), false);
    execFileSync("git", ["init", "-q", join(dir, "repo")]);
    assert.equal(isGitRepo(join(dir, "repo")), true);
  });
});
