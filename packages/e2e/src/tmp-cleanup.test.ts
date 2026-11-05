import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { test } from "node:test";

// Guards that the harness tmp dirs (tmp, gitRepo, hence rig callers) are removed at process exit.
const childPath = new URL("./tmp-cleanup-child.ts", import.meta.url).pathname;
const run = (script: string): string[] => JSON.parse(execFileSync(process.execPath, [script], { encoding: "utf8" }));

test("harness tmp dirs (tmp, gitRepo) exist while the process runs and are removed when it exits", () => {
  const dirs = run(childPath);
  assert.equal(dirs.length, 2);
  for (const d of dirs) {
    assert.match(d, /pomtree-e2e-(repo|state)-/);
    assert.equal(existsSync(d), false, `${d} leaked: the harness tmp helper must register cleanup`);
  }
});

test("negative control: a plain mkdtempSync dir survives its process, so the leak check can fail", () => {
  const dir = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `const {mkdtempSync}=require("node:fs");const {tmpdir}=require("node:os");const {join}=require("node:path");console.log(JSON.stringify(mkdtempSync(join(tmpdir(),"pomtree-e2e-ctl-"))))`,
      ],
      { encoding: "utf8" },
    ),
  ) as string;
  try {
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
