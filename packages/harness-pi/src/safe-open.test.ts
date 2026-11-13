import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessEvent, SandboxHandle } from "@pomtree/core";
import {
  checkOpen,
  createPiHarness,
  fileTailSource,
  MAX_SESSION_BYTES,
  PI_SINK_PATH,
  PI_SINK_REFUSED_PREFIX,
  piArgv,
  SafeOpenError,
  safeReadFile,
  safeWriteFile,
} from "./index.ts";

const SAFE_OPEN = fileURLToPath(new URL("./safe-open.ts", import.meta.url));
const SINK_FS = fileURLToPath(new URL("./sink-fs.ts", import.meta.url));

// A refusal case run in a child process with a hard timeout: a regression that blocks on a FIFO (or reads /dev/zero) blocks the
// whole event loop, which an in-process test timeout cannot interrupt. Prints the SafeOpenError refusal, or the other outcome.
function inChild(body: string): string {
  const src = `import { safeReadFile, SafeOpenError } from ${JSON.stringify(SAFE_OPEN)}; import { fileTailSource } from ${JSON.stringify(SINK_FS)};
try { ${body}; console.log("no-refusal"); } catch (e) { console.log(e instanceof SafeOpenError ? "refused:" + e.refusal + ":" + e.message : "threw:" + e.message); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.signal, null, `child hung (killed by ${r.signal}); stderr: ${r.stderr}`);
  return r.stdout.trim();
}

const withDir = async (f: (dir: string) => void | Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "safe-open-"));
  try {
    await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("checkOpen policy: a regular file within the bound is ok; every other kind and an oversize file is refused with path and action", () => {
  assert.deepEqual(checkOpen("/s/a", "file", 10, 10), { ok: true });
  assert.deepEqual(checkOpen("/s/a", "file", 1e12), { ok: true }); // no bound given
  for (const [kind, refusal] of [
    ["symlink", "symlink"],
    ["fifo", "fifo"],
    ["device", "device"],
    ["socket", "socket"],
    ["directory", "directory"],
    ["other", "not-regular"],
  ] as const) {
    const r = checkOpen("/s/a/session.jsonl", kind, 0, 10);
    assert.ok(!r.ok && r.error.refusal === refusal && r.error.path === "/s/a/session.jsonl", kind);
    assert.match(r.ok ? "" : r.error.message, /^refusing to open \/s\/a\/session\.jsonl: .*; .*remove the entry .* and retry$/);
  }
  const big = checkOpen("/s/a", "file", 11, 10);
  assert.ok(!big.ok && big.error.refusal === "oversize");
  assert.match(big.ok ? "" : big.error.message, /11 bytes, over the 10-byte bound/);
});

test("safeReadFile: reads a regular file, null when absent, refuses an oversize one", () =>
  withDir(async (dir) => {
    const p = join(dir, "session.jsonl");
    assert.equal(await safeReadFile(p, MAX_SESSION_BYTES), null);
    writeFileSync(p, "abc\n");
    assert.equal(Buffer.from((await safeReadFile(p, MAX_SESSION_BYTES))!).toString(), "abc\n");
    await assert.rejects(
      () => safeReadFile(p, 3),
      (e) => e instanceof SafeOpenError && e.refusal === "oversize",
    );
  }));

test("a FIFO planted as the session file or sink is refused without blocking the event loop", { timeout: 30_000 }, () =>
  withDir(async (dir) => {
    const fifo = join(dir, "events.jsonl");
    execFileSync("mkfifo", [fifo]);
    assert.match(inChild(`await safeReadFile(${JSON.stringify(fifo)}, 1024)`), /^refused:fifo:refusing to open .*events\.jsonl: it is a FIFO/);
    // The tail source the harness polls (pomtreed main.ts wires fileTailSource): every reopen is refused, none blocks.
    assert.match(inChild(`const s = fileTailSource(${JSON.stringify(fifo)}); await s.read(0)`), /^refused:fifo:/);
  }),
);

test("a symlink to a sibling agent's session is refused on read and replaced (not written through) on write", () =>
  withDir(async (dir) => {
    mkdirSync(join(dir, "agentA"));
    mkdirSync(join(dir, "agentB"));
    const sibling = join(dir, "agentB", "session.jsonl");
    writeFileSync(sibling, "sibling conversation\n");
    const link = join(dir, "agentA", "session.jsonl");
    symlinkSync("../agentB/session.jsonl", link);
    await assert.rejects(
      () => safeReadFile(link, MAX_SESSION_BYTES),
      (e) => e instanceof SafeOpenError && e.refusal === "symlink" && /another agent's session/.test(e.message),
    );
    await safeWriteFile(link, new TextEncoder().encode("restored\n"));
    assert.equal(readFileSync(sibling, "utf8"), "sibling conversation\n");
    assert.ok(lstatSync(link).isFile());
    assert.equal(readFileSync(link, "utf8"), "restored\n");
  }));

test("a symlink to /dev/zero is refused without reading it", { timeout: 30_000 }, () =>
  withDir((dir) => {
    const link = join(dir, "session.jsonl");
    symlinkSync("/dev/zero", link);
    assert.match(inChild(`await safeReadFile(${JSON.stringify(link)}, 1 << 30)`), /^refused:symlink:/);
    assert.match(inChild(`await fileTailSource(${JSON.stringify(link)}).read(0)`), /^refused:symlink:/);
  }),
);

test("safeWriteFile replaces a planted FIFO and refuses a directory naming the path", { timeout: 30_000 }, () =>
  withDir(async (dir) => {
    const p = join(dir, "session.jsonl");
    execFileSync("mkfifo", [p]);
    await safeWriteFile(p, new TextEncoder().encode("x\n"));
    assert.ok(lstatSync(p).isFile());
    assert.equal(readFileSync(p, "utf8"), "x\n");
    const d = join(dir, "d.jsonl");
    mkdirSync(d);
    await assert.rejects(
      () => safeWriteFile(d, new Uint8Array(1)),
      (e) => e instanceof SafeOpenError && e.refusal === "directory" && e.describe("/workspace/x") === e.message.replace(d, "/workspace/x"),
    );
  }),
);

test("safeWriteFile keeps an existing session file's inode, owner and mode (the container user must still append to it)", () =>
  withDir(async (dir) => {
    const p = join(dir, "session.jsonl");
    writeFileSync(p, "old conversation, longer than the new one\n");
    chmodSync(p, 0o640);
    const before = statSync(p);
    await safeWriteFile(p, new TextEncoder().encode("new\n"));
    const after = statSync(p);
    assert.equal(readFileSync(p, "utf8"), "new\n", "truncated, then written");
    assert.equal(after.ino, before.ino, "rewritten in place, not replaced by a new file");
    assert.equal(after.mode & 0o7777, 0o640);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
  }));

test("checkOpen refuses a regular file with other hard links when nlink is given, and accepts nlink 1", () => {
  assert.deepEqual(checkOpen("/s/a", "file", 0, undefined, 1), { ok: true });
  const r = checkOpen("/s/a/session.jsonl", "file", 0, undefined, 2);
  assert.ok(!r.ok && r.error.refusal === "hardlink");
  assert.match(r.ok ? "" : r.error.message, /^refusing to open \/s\/a\/session\.jsonl: it has 2 hard links .*; .*remove the entry .* and retry$/);
});

test("safeWriteFile refuses a hard-linked target before truncating, leaving the other linked file unchanged", () =>
  withDir(async (dir) => {
    const other = join(dir, "other-agent-session.jsonl");
    const p = join(dir, "session.jsonl");
    writeFileSync(other, "sibling conversation\n");
    linkSync(other, p);
    await assert.rejects(
      safeWriteFile(p, new TextEncoder().encode("new\n")),
      (e) => e instanceof SafeOpenError && e.refusal === "hardlink" && /hard links/.test(e.message),
    );
    assert.equal(readFileSync(other, "utf8"), "sibling conversation\n", "not truncated or written through the link");
    assert.equal(readFileSync(p, "utf8"), "sibling conversation\n");
  }));

test("safeWriteFile creates a missing file with writeFileSync's mode (0o666 less the umask)", () =>
  withDir(async (dir) => {
    const p = join(dir, "session.jsonl");
    await safeWriteFile(p, new TextEncoder().encode("x\n"));
    const ref = join(dir, "ref");
    writeFileSync(ref, "x\n");
    assert.equal(statSync(p).mode & 0o7777, statSync(ref).mode & 0o7777);
  }));

test(
  "a FIFO planted as the event sink ends the harness stream with one fatal error naming the container path (the daemon then stops the sandbox)",
  { timeout: 30_000 },
  () =>
    withDir(async (dir) => {
      const fifo = join(dir, "events.jsonl");
      execFileSync("mkfifo", [fifo]);
      // The container never exits on its own: the stream must end anyway, not wait on wait().
      const sandbox = {
        id: "sb",
        async *output() {},
        wait: () => new Promise<never>(() => {}),
      } as unknown as SandboxHandle;
      const session = await createPiHarness({ sink: () => fileTailSource(fifo) }).start({ agent: "a", sandbox, prompt: "p" } as never);
      const got: HarnessEvent[] = [];
      for await (const ev of session.events()) got.push(ev);
      assert.equal(got.length, 1, JSON.stringify(got));
      const [e] = got;
      assert.ok(e?.kind === "error" && e.message.startsWith(`${PI_SINK_REFUSED_PREFIX}: refusing to open ${PI_SINK_PATH}: it is a FIFO`), JSON.stringify(e));
      assert.ok(e?.kind === "error" && !e.message.includes(dir), "no host path reaches the journal the agent's tree reads");
    }),
);

test("piArgv passes --no-approve on every launch (trust.json is agent-writable), once", () => {
  for (const argv of [
    piArgv({ prompt: "p" }),
    piArgv({ prompt: "p", extSet: "events" }),
    piArgv({ prompt: "p", tools: ["read"] }),
    piArgv({ prompt: "p", allowlist: { tools: ["fetch"], extension: "/opt/pomtree/ext/analyst" } }),
  ]) {
    assert.equal(argv.filter((a) => a === "--no-approve").length, 1, argv.join(" "));
    assert.ok(argv.indexOf("--no-approve") < argv.indexOf("--"));
  }
});

// Written for Linux, where opening a running executable for writing fails with ETXTBSY. Reported to fail on macOS (cause unconfirmed:
// a different error code, or the copied system binary not running), so it is skipped there with a printed reason until reproduced on a Mac.
const etxtbsySkip: string | false =
  process.platform === "darwin" ? "ETXTBSY from writing a running copy of /bin/sh is Linux behavior; unconfirmed on macOS (#665)" : false;

test("safeWriteFile preserves a non-ENXIO open error instead of refusing it as a FIFO", { skip: etxtbsySkip }, () =>
  withDir(async (dir) => {
    const shell = ["/bin/sh", "/usr/bin/sh"].find((p) => existsSync(p));
    assert.ok(shell);
    const busy = join(dir, "sh");
    copyFileSync(shell, busy);
    chmodSync(busy, 0o755);

    // A running executable cannot be opened for writing: the open fails with ETXTBSY, not ENXIO.
    const child = spawn(busy, ["-c", "read x"], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });

      let thrown: unknown;
      try {
        await safeWriteFile(busy, new Uint8Array([1, 2, 3]));
      } catch (e) {
        thrown = e;
      }

      assert.ok(thrown instanceof Error, "expected safeWriteFile to reject");
      assert.equal(thrown instanceof SafeOpenError, false);
      assert.equal((thrown as { code?: string }).code, "ETXTBSY");
    } finally {
      child.stdin?.destroy();
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }),
);
