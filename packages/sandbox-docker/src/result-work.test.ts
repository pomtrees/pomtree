import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DockerSandbox } from "./docker.ts";
import { CONFIG_DEFAULTS } from "@pomtree/core";
import { collectResultWork, RESULT_WORK_SCRIPT } from "./result-work.ts";
import { IMAGE, gate, testEgressNetwork } from "./docker-gate.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";
const egressNetwork = testEgressNetwork();

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-result-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
  git("init", "-b", "work");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "file"), "base\n");
  git("add", "file");
  git("commit", "-m", "base");
  let base = git("rev-parse", "HEAD");
  const calls: string[][] = [];
  const sandbox = new DockerSandbox({
    mounts: stubMounts(() => dir),
    spawn: (command, args) => {
      // Stand in for the container process with an isolated fixture. The adapter itself may only
      // launch Docker; it never launches host Git or receives the fixture path.
      assert.equal(command, "docker");
      assert.deepEqual(args.slice(0, 4), ["exec", "pomtree-sandbox", "node", "-e"]);
      calls.push(args);
      return spawn(process.execPath, args.slice(3), { cwd: dir, env: { ...process.env, POMTREE_BASE_COMMIT: base } });
    },
  });
  return {
    dir,
    git,
    sandbox,
    calls,
    base: (value: string) => {
      base = value;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("result work inspects without mutation and binds approval to file contents", async () => {
  const f = fixture();
  try {
    const clean = await f.sandbox.resultWork("sandbox");
    assert.equal(clean.dirty, false);
    writeFileSync(join(f.dir, "file"), "change one\n");
    writeFileSync(join(f.dir, "new"), "new one\n");
    const dirty = await f.sandbox.resultWork("sandbox");
    assert.equal(dirty.dirty, true);
    const head = f.git("rev-parse", "HEAD");
    writeFileSync(join(f.dir, "new"), "new two\n");
    const changed = await f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: dirty.fingerprint });
    assert.equal(changed.dirty, true);
    assert.notEqual(changed.fingerprint, dirty.fingerprint);
    assert.equal(changed.bundle, undefined);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(f.git("diff", "--cached", "--name-only"), "");
  } finally {
    f.close();
  }
});

test("approved result work commits and streams a local bundle with hooks disabled", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "file"), "saved\n");
    const sentinel = join(f.dir, "hook-fired");
    const hook = join(f.dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, { mode: 0o755 });
    const dirty = await f.sandbox.resultWork("sandbox");
    const saved = await f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: dirty.fingerprint });
    assert.equal(saved.dirty, false);
    assert.ok(saved.bundle);
    const chunks: Uint8Array[] = [];
    for await (const chunk of saved.bundle) chunks.push(chunk);
    const file = join(f.dir, "saved.bundle");
    writeFileSync(file, Buffer.concat(chunks));
    f.git("bundle", "verify", file);
    assert.match(f.git("log", "-1", "--format=%s"), /Save remaining work/);
    assert.equal(readFileSync(join(f.dir, "file"), "utf8"), "saved\n");
    assert.equal(existsSync(sentinel), false);
  } finally {
    f.close();
  }
});

test("approval fingerprint detects index changes when the worktree and status are unchanged", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "file"), "index one\n");
    f.git("add", "file");
    writeFileSync(join(f.dir, "file"), "worktree\n");
    const before = await f.sandbox.resultWork("sandbox");
    const status = f.git("status", "--porcelain");
    writeFileSync(join(f.dir, "file"), "index two\n");
    f.git("add", "file");
    writeFileSync(join(f.dir, "file"), "worktree\n");
    assert.equal(f.git("status", "--porcelain"), status);
    const after = await f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: before.fingerprint });
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.equal(after.bundle, undefined);
  } finally {
    f.close();
  }
});

test("result work trusts only its own workspace directory when git refuses a differently owned repository", async () => {
  const f = fixture();
  const bin = mkdtempSync(join(tmpdir(), "pomtree-result-bin-"));
  try {
    // A stand-in git that refuses like git's ownership check unless safe.directory names exactly the working directory.
    // (A real foreign owner needs root, so this asserts the argv instead; the Docker-gated test below covers a real container.)
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(bin, "git");
    writeFileSync(
      shim,
      `#!/bin/sh\nok=0\nfor a in "$@"; do\n  [ "$a" = "safe.directory=$PWD" ] && ok=1\n  [ "$a" = "safe.directory=*" ] && { echo "wildcard safe.directory" >&2; exit 2; }\ndone\n[ $ok = 1 ] || { echo "fatal: detected dubious ownership in repository at '$PWD'" >&2; exit 128; }\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    const run = (script: string) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, ["-e", script, JSON.stringify({ maxBytes: 1_000_000 })], {
          cwd: f.dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, POMTREE_BASE_COMMIT: f.git("rev-parse", "HEAD") },
        });
        let err = "";
        child.stderr.on("data", (c) => {
          err += c;
        });
        child.once("close", (code) => resolve({ code, err }));
      });
    const ok = await run(RESULT_WORK_SCRIPT);
    assert.equal(ok.code, 0, ok.err);
    // Negative control: without the scoped safe.directory the shim reproduces the CI failure.
    const without = await run(RESULT_WORK_SCRIPT.replace("'-c','safe.directory='+process.cwd(),", ""));
    assert.equal(without.code, 1);
    assert.match(without.err, /dubious ownership/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    f.close();
  }
});

test("disposing a bundle before reading cancels the collection process", { timeout: 2000 }, async () => {
  const child = spawn(process.execPath, [
    "-e",
    `process.stdout.write(JSON.stringify({dirty:false,fingerprint:'${"a".repeat(64)}',bundle:true})+'\\n');setInterval(()=>{},1000)`,
  ]);
  const closed = new Promise<NodeJS.Signals | null>((resolve) => child.once("close", (_code, signal) => resolve(signal)));
  try {
    const result = await collectResultWork(() => child, "sandbox", { save: true, expectedFingerprint: "a".repeat(64) });
    assert.ok(result.bundle);
    const iterator = result.bundle[Symbol.asyncIterator]();
    await iterator.return?.();
    assert.equal(await closed, "SIGTERM");
  } finally {
    child.kill();
  }
});

test("collection failure is surfaced and clean retry can collect the already-created commit", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "file"), "saved\n");
    const dirty = await f.sandbox.resultWork("sandbox");
    const base = f.git("rev-parse", "HEAD");
    f.base("invalid");
    await assert.rejects(f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: dirty.fingerprint }), /POMTREE_BASE_COMMIT/);
    assert.equal(f.git("status", "--porcelain"), "");
    const savedHead = f.git("rev-parse", "HEAD");
    f.base(base);
    const clean = await f.sandbox.resultWork("sandbox");
    const stale = await f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: dirty.fingerprint });
    assert.equal(stale.bundle, undefined);
    const retry = await f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: clean.fingerprint });
    assert.ok(retry.bundle);
    for await (const _chunk of retry.bundle) {
      /* consume the verified transport */
    }
    assert.equal(f.git("rev-parse", "HEAD"), savedHead);
  } finally {
    f.close();
  }
});

test("a failed approved commit preserves work and never returns a bundle", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "file"), "keep this\n");
    const head = f.git("rev-parse", "HEAD");
    const dirty = await f.sandbox.resultWork("sandbox");
    rmSync(join(f.dir, ".git", "COMMIT_EDITMSG"));
    mkdirSync(join(f.dir, ".git", "COMMIT_EDITMSG"));
    await assert.rejects(f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: dirty.fingerprint }), /workspace git commit failed/);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(f.dir, "file"), "utf8"), "keep this\n");
    assert.equal(f.git("diff", "--cached", "--name-only"), "file");
  } finally {
    f.close();
  }
});

test("the collection cap defaults to the push.maxBytes registry default and follows a caller's maxBytes", async () => {
  const f = fixture();
  try {
    await f.sandbox.resultWork("sandbox");
    assert.equal(JSON.parse(f.calls[0]![5]!).maxBytes, CONFIG_DEFAULTS["push.maxBytes"]);
    assert.equal(CONFIG_DEFAULTS["push.maxBytes"], 256 * 1024 * 1024);
    await f.sandbox.resultWork("sandbox", { maxBytes: 4096 });
    assert.equal(JSON.parse(f.calls[1]![5]!).maxBytes, 4096);
  } finally {
    f.close();
  }
});

test("negative: a 1-byte cap refuses a non-empty bundle and untracked work; a cap that fits collects", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, "file"), "saved\n");
    const dirty = await f.sandbox.resultWork("sandbox", { maxBytes: 1 });
    await assert.rejects(
      f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: dirty.fingerprint, maxBytes: 1 }),
      /result bundle exceeds collection limit/,
    );
    const clean = await f.sandbox.resultWork("sandbox", { maxBytes: 1 });
    const saved = await f.sandbox.resultWork("sandbox", { save: true, expectedFingerprint: clean.fingerprint, maxBytes: 1024 * 1024 });
    assert.ok(saved.bundle);
    for await (const _chunk of saved.bundle) {
      /* consume */
    }
    writeFileSync(join(f.dir, "untracked"), "two bytes or more\n");
    await assert.rejects(f.sandbox.resultWork("sandbox", { maxBytes: 1 }), /uncommitted work exceeds collection limit/);
  } finally {
    f.close();
  }
});

test("negative: the in-container script refuses a missing or invalid maxBytes before running git", () => {
  const dir = mkdtempSync(join(tmpdir(), "pomtree-result-cap-"));
  try {
    for (const opts of [{}, { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: "1" }, { maxBytes: 2 ** 53 }, { maxBytes: null }]) {
      const r = spawnSync(process.execPath, ["-e", RESULT_WORK_SCRIPT, JSON.stringify(opts)], { cwd: dir, encoding: "utf8", timeout: 10_000 });
      assert.equal(r.status, 1, JSON.stringify(opts));
      assert.match(r.stderr, /maxBytes must be a safe integer of at least 1/, JSON.stringify(opts));
      assert.equal(r.stdout, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Docker result collection uses the actual workspace and base environment", { skip: gate(), timeout: 120_000 }, async () => {
  const f = fixture();
  const sandbox = new DockerSandbox({ mounts: stubMounts(() => f.dir), egressNetwork });
  // Docker's sandbox uid differs from the host test uid; permit writes in this disposable fixture.
  const writable = (dir: string) => {
    chmodSync(dir, 0o777);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) writable(path);
      else chmodSync(path, 0o666);
    }
  };
  writable(f.dir);
  const handle = await sandbox.start(
    {
      agent: "result-work-live",
      image: IMAGE,
      env: { POMTREE_BASE_COMMIT: f.git("rev-parse", "HEAD") },
      cmd: ["sleep", "120"],
      mounts: [wsMount("/work")],
    },
    `result-work-live-${process.pid}-${Date.now()}`,
  );
  try {
    assert.equal((await sandbox.resultWork(handle.id)).dirty, false);
    writeFileSync(join(f.dir, "file"), "live collection\n");
    const dirty = await sandbox.resultWork(handle.id);
    assert.equal(dirty.dirty, true);
    const saved = await sandbox.resultWork(handle.id, { save: true, expectedFingerprint: dirty.fingerprint });
    assert.ok(saved.bundle);
    const chunks: Uint8Array[] = [];
    for await (const chunk of saved.bundle) chunks.push(chunk);
    const bundle = join(f.dir, "live.bundle");
    writeFileSync(bundle, Buffer.concat(chunks));
    f.git("bundle", "verify", bundle);
    assert.match(f.git("log", "-1", "--format=%s"), /Save remaining work/);
  } finally {
    await sandbox.kill(handle.id, `test-kill:${handle.id}`);
    f.close();
  }
});
