import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const ROOT_VERSION = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string;

// Run the real `pomtree` entrypoint with a clean, unconfigured environment. `baked`, when given, writes the
// (temp) image revision file and, with `version`, its sibling version file, so the baked identity path can be exercised.
function pomtree(args: string[] = [], baked?: { revision: string; version?: string }) {
  const env = { ...process.env };
  delete env.POMTREE_TOKEN;
  delete env.POMTREE_API;
  delete env.POMTREE_SOCKET;
  env.POMTREED_STATE_DIR = mkdtempSync(join(tmpdir(), "pomtree-unconfigured-"));
  env.POMTREE_REVISION_FILE = join(env.POMTREED_STATE_DIR, "revision");
  if (baked !== undefined) writeFileSync(env.POMTREE_REVISION_FILE, baked.revision);
  if (baked?.version !== undefined) writeFileSync(join(env.POMTREED_STATE_DIR, "version"), baked.version);
  try {
    return spawnSync(process.execPath, [MAIN, ...args], { env, encoding: "utf8" });
  } finally {
    rmSync(env.POMTREED_STATE_DIR, { recursive: true, force: true });
  }
}

test("pomtree --help and a bare pomtree print usage and exit 0 without config", () => {
  for (const args of [["--help"], ["-h"], []]) {
    const r = pomtree(args);
    assert.equal(r.status, 0, `pomtree ${args.join(" ")}`);
    assert.match(r.stdout, /^usage: pomtree/, `pomtree ${args.join(" ")}`);
    assert.equal(r.stderr, "");
  }
});

test("pomtree --version from source prints the root version and the checkout's revision, exit 0 without config", () => {
  for (const args of [["--version"], ["-V"]]) {
    const r = pomtree(args);
    assert.equal(r.status, 0, `pomtree ${args.join(" ")}`);
    // The checkout's own revision; an asterisk when this worktree has tracked changes.
    assert.match(r.stdout, new RegExp(`^v${ROOT_VERSION.replaceAll(".", "\\.")}\\*? \\((?:[0-9a-f]{4,}|unknown revision)\\)\n$`));
    assert.equal(r.stderr, "");
  }
});

test("pomtree --version in the image reports the baked version and revision, never dirty", () => {
  for (const args of [["--version"], ["-V"]]) {
    const r = pomtree(args, { revision: "abc1234\n", version: "0.1.0" });
    assert.equal(r.status, 0, `pomtree ${args.join(" ")}`);
    assert.equal(r.stdout, "v0.1.0 (abc1234)\n");
    assert.equal(r.stderr, "");
  }
});

test("a baked revision without a baked version falls back to this package's version", () => {
  const r = pomtree(["--version"], { revision: "abc1234" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `v${VERSION} (abc1234)\n`);
});

test("a real command still errors clearly when unconfigured", () => {
  const r = pomtree(["ps"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not configured/);
  assert.match(r.stderr, /POMTREE_TOKEN/);
  assert.equal(r.stdout, "");
});

test("a help flag after the command word is not a help request", () => {
  const r = pomtree(["send", "p2", "--help"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not configured/);
  assert.equal(r.stdout, "");
});
