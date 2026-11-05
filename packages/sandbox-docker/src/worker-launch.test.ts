import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_PATH, NODE_BIN, PI_BIN } from "./container-contract.gen.ts";
import { BROWSER_RUN, CAPTURE_WORKER, workerLaunch, type LaunchFs } from "./worker-ready.ts";

const fakeFs = (present: string[], links: Record<string, string> = {}): LaunchFs => ({
  realpath: (p) => links[p] ?? p,
  executable: (p) => present.includes(p),
});
const base = { browser: false, execPath: "/usr/local/bin/node", fixedPath: FIXED_PATH };

test("pi starts as NODE_BIN plus the realpath of PI_BIN, never by name", () => {
  const fs = fakeFs([], { [PI_BIN]: "/usr/local/lib/node_modules/pi/dist/cli.js" });
  assert.deepEqual(workerLaunch("pi", ["--x", "y"], { ...base, fs }), {
    file: NODE_BIN,
    args: ["/usr/local/lib/node_modules/pi/dist/cli.js", "--x", "y"],
  });
});

test("a bare name is looked up in the fixed path only, in order", () => {
  const fs = fakeFs(["/usr/bin/sleep", "/bin/sleep"]);
  assert.deepEqual(workerLaunch("sleep", ["1"], { ...base, fs }), { file: "/usr/bin/sleep", args: ["1"] });
  assert.throws(() => workerLaunch("nope", [], { ...base, fs }), /not found in the fixed path: nope/);
});

test("a name with a slash is used as written; the browser run uses the worker's node", () => {
  assert.deepEqual(workerLaunch("/opt/x", ["a"], { ...base, fs: fakeFs([]) }), { file: "/opt/x", args: ["a"] });
  assert.deepEqual(workerLaunch("pi", ["a"], { ...base, browser: true, fs: fakeFs([]) }), {
    file: "/usr/local/bin/node",
    args: [BROWSER_RUN, "pi", "a"],
  });
});

test("a browser worker starts the capture worker directly only for the exact node command", () => {
  const b = { ...base, browser: true, fs: fakeFs([]) };
  assert.deepEqual(workerLaunch(NODE_BIN, [CAPTURE_WORKER], b), { file: NODE_BIN, args: [CAPTURE_WORKER] });
  for (const [cmd, args] of [
    [NODE_BIN, [CAPTURE_WORKER, "--x"]],
    [NODE_BIN, ["/opt/other.ts"]],
    [NODE_BIN, ["capture-worker.ts"]],
    [NODE_BIN, []],
    ["/opt/x", [CAPTURE_WORKER]],
    ["node", [CAPTURE_WORKER]],
  ] as const)
    assert.deepEqual(workerLaunch(cmd, args, b), { file: "/usr/local/bin/node", args: [BROWSER_RUN, cmd, ...args] });
  // A non-browser worker is unaffected: the same command is the ordinary slash path.
  assert.deepEqual(workerLaunch(NODE_BIN, [CAPTURE_WORKER], { ...base, fs: fakeFs([]) }), { file: NODE_BIN, args: [CAPTURE_WORKER] });
});

// Negative variant, real filesystem: a shim planted in a writable directory that leads PATH is not started.
test("a planted shim in an agent-writable PATH directory is not chosen", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-launch-")));
  try {
    const writable = join(root, "workspace", ".env", "npm", "bin");
    const trusted = join(root, "usr", "bin");
    mkdirSync(writable, { recursive: true });
    mkdirSync(trusted, { recursive: true });
    for (const [dir, name] of [
      [writable, "pi"],
      [writable, "sleep"],
      [trusted, "sleep"],
    ] as const) {
      writeFileSync(join(dir, name), "#!/bin/sh\n");
      chmodSync(join(dir, name), 0o755);
    }
    const fs: LaunchFs = {
      realpath: realpathSync,
      executable: (p) => {
        try {
          accessSync(p, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    };
    const sleep = workerLaunch("sleep", [], { ...base, fixedPath: trusted, fs });
    assert.equal(sleep.file, join(trusted, "sleep"));
    const pi = workerLaunch("pi", [], { ...base, fs: { ...fs, realpath: () => join(root, "real-pi.js") } });
    assert.equal(pi.file, NODE_BIN);
    assert.ok(!pi.args.some((a) => a.startsWith(writable)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
