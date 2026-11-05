import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tmpModule = fileURLToPath(new URL("./tmp.ts", import.meta.url));

// Run a child that makes a tmpDir, then ends via `how`; resolve to the dir it printed.
function run(how: "exit" | "SIGTERM" | "SIGINT"): Promise<string> {
  const body = `import { tmpDir } from ${JSON.stringify(tmpModule)};
    console.log(tmpDir("pomtreed-tmp-test-"));
    ${how === "exit" ? "" : "setInterval(() => {}, 1000);"}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", body], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
      if (how !== "exit" && out.includes("\n")) child.kill(how);
    });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

for (const how of ["exit", "SIGTERM", "SIGINT"] as const) {
  test(`tmpDir: dir is removed after child ${how === "exit" ? "exits normally" : `receives ${how}`}`, async () => {
    const dir = await run(how);
    assert.match(dir, /pomtreed-tmp-test-/);
    assert.equal(existsSync(dir), false);
  });
}
