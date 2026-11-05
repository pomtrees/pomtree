import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready } from "./worker.ts";
import { childExitCode, socketOwnershipProblem, TMPFS_MAGIC, type DirStat, type SocketStat } from "./worker-ready.ts";

test("childExitCode keeps a real exit code, including 0", () => {
  assert.equal(childExitCode(0, null), 0);
  assert.equal(childExitCode(7, null), 7);
});

test("childExitCode maps a signal-killed child to 128 + signal number", () => {
  assert.equal(childExitCode(null, "SIGTERM"), 143);
  assert.equal(childExitCode(null, "SIGKILL"), 137);
  assert.equal(childExitCode(null, "SIGINT"), 130);
});

test("childExitCode falls back to 1 for an unknown signal name or no code and no signal", () => {
  assert.equal(childExitCode(null, "SIGNOTREAL"), 1);
  assert.equal(childExitCode(null, "toString"), 1);
  assert.equal(childExitCode(null, null), 1);
});

const goodDir: DirStat = { isDirectory: true, isSymbolicLink: false, uid: 1001, gid: 1000, mode: 0o40770 };
const goodSocket: SocketStat = { isSocket: true, uid: 1001, gid: 1000, mode: 0o140660 };

test("socketOwnershipProblem accepts a real tmpfs dir with a socket owned by the dir uid and gid 1000", () => {
  assert.equal(socketOwnershipProblem(goodDir, TMPFS_MAGIC, goodSocket), undefined);
});

test("socketOwnershipProblem rejects each unsafe input with its own reason", () => {
  const cases: Array<[string, DirStat, number, SocketStat, string]> = [
    ["dir not a directory", { ...goodDir, isDirectory: false }, TMPFS_MAGIC, goodSocket, "socket directory is not a directory"],
    ["dir is a symlink", { ...goodDir, isSymbolicLink: true }, TMPFS_MAGIC, goodSocket, "socket directory is a symbolic link"],
    ["dir owned by root", { ...goodDir, uid: 0 }, TMPFS_MAGIC, { ...goodSocket, uid: 0 }, "socket directory is owned by root"],
    ["dir gid 0", { ...goodDir, gid: 0 }, TMPFS_MAGIC, goodSocket, "socket directory gid is not 1000"],
    ["dir gid 1001", { ...goodDir, gid: 1001 }, TMPFS_MAGIC, goodSocket, "socket directory gid is not 1000"],
    ["dir mode 0755", { ...goodDir, mode: 0o40755 }, TMPFS_MAGIC, goodSocket, "socket directory mode is not 0770"],
    ["dir mode 0777", { ...goodDir, mode: 0o40777 }, TMPFS_MAGIC, goodSocket, "socket directory mode is not 0770"],
    ["fs not tmpfs (ext4 magic)", goodDir, 0xef53, goodSocket, "socket directory is not tmpfs"],
    ["egress path not a socket", goodDir, TMPFS_MAGIC, { ...goodSocket, isSocket: false }, "egress path is not a socket"],
    ["socket uid differs from dir", goodDir, TMPFS_MAGIC, { ...goodSocket, uid: 1002 }, "socket uid differs from directory uid"],
    ["socket gid not 1000", goodDir, TMPFS_MAGIC, { ...goodSocket, gid: 0 }, "socket gid is not 1000"],
  ];
  for (const [name, dir, fsType, socket, reason] of cases) {
    assert.equal(socketOwnershipProblem(dir, fsType, socket), reason, name);
  }
});

test("socketOwnershipProblem checks the masked permission bits, not file type bits", () => {
  // Regular directory type bits (0o40000) must not matter; only the 0o777 permission bits are compared.
  assert.equal(socketOwnershipProblem({ ...goodDir, mode: 0o770 }, TMPFS_MAGIC, goodSocket), undefined);
});

test("socketOwnershipProblem does not check the socket mode; ready() decides by mode and retries otherwise", () => {
  // Current behavior: a socket with mode other than 0660 passes this check and is then never probed.
  for (const mode of [0o140600, 0o140666, 0o140770]) {
    assert.equal(socketOwnershipProblem(goodDir, TMPFS_MAGIC, { ...goodSocket, mode }), undefined);
  }
});

test("ready() rejects a real socket in a temp dir it does not own with the unsafe-ownership error", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-ready-")));
  const path = join(root, "proxy.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    // The temp dir is not gid 1000 (and not tmpfs), so the first check fails before any probe connect.
    await assert.rejects(ready(path), { message: "unsupported or unsafe egress socket volume ownership" });
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
