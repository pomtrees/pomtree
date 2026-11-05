import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_REFUSED, EXIT_TRANSPORT, SPAWN_ATTEMPTS, spawnKidCmd, waitReapCmd } from "./rly4-spawn.ts";

// The RLY-4 flake: on a loaded runner `pomtree spawn` hit the CLI's 15 s response timeout (exit 6) after the daemon had created the child, so the
// id file stayed empty and every later `pomtree wait` ran without an id. These tests run the real snippets under `sh` with a fake `pomtree`
// whose spawn exit codes are scripted (no Docker, no daemon).

// The fake logs every call to calls.log; `spawn` answers with the next code of SPAWN_CODES (space separated) and prints the id only on exit 0
// (`done` once the codes run out); `wait` and `reap` succeed only when given an id.
function run(command: string, dir: string, spawnCodes: number[]): { out: string; calls: string[] } {
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(
    join(bin, "pomtree"),
    `#!/bin/sh
echo "$*" >> "${dir}/calls.log"
case "$1" in
  spawn)
    n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${dir}/n"
    code=$(echo "${spawnCodes.join(" ")}" | cut -d' ' -f$n); [ -n "$code" ] || code=0
    if [ "$code" = 0 ]; then echo agt-4; else echo "cannot reach pomtreed: no response within 15000ms" >&2; fi
    exit $code ;;
  wait|reap) [ -n "$2" ] && [ "$2" != "--timeout" ] ;;
esac
`,
  );
  chmodSync(join(bin, "pomtree"), 0o755);
  const r = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  } catch {}
  return { out: r.stdout, calls };
}

const opts = (dir: string) => ({ budget: 100000, model: "p/m", dir });
const withDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "rly4-spawn-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("rly4 spawn snippet: a transport timeout (exit 6) with no id is retried and the id is captured", () => {
  withDir((dir) => {
    const r = run(`${spawnKidCmd(4, opts(dir))}; ${waitReapCmd(4, dir)}`, dir, [EXIT_TRANSPORT, 0]);
    assert.match(r.out, /^SPAWN4=0$/m, r.out);
    assert.equal(readFileSync(join(dir, "kid4"), "utf8").trim(), "agt-4");
    assert.match(r.out, /^REAPED4=0$/m, r.out);
    assert.equal(r.calls.filter((c) => c.startsWith("spawn")).length, 2);
    // Every attempt names the same --key, so the daemon resolves a retry to the child it already created.
    const keys = new Set(r.calls.filter((c) => c.startsWith("spawn")).map((c) => /--key (\S+)/.exec(c)?.[1]));
    assert.equal(keys.size, 1);
    assert.ok(!keys.has(undefined), "spawn must pass --key");
  });
});

test("rly4 spawn snippet: the intended refusal (exit 5) is not retried and still reports SPAWN=5", () => {
  withDir((dir) => {
    const r = run(spawnKidCmd(3, opts(dir)), dir, [EXIT_REFUSED, 0]);
    assert.match(r.out, /^SPAWN3=5$/m, r.out);
    assert.equal(r.calls.filter((c) => c.startsWith("spawn")).length, 1);
  });
});

test("rly4 spawn snippet: retries are bounded and the last exit code is reported", () => {
  withDir((dir) => {
    const r = run(spawnKidCmd(4, opts(dir)), dir, Array(SPAWN_ATTEMPTS + 2).fill(EXIT_TRANSPORT));
    assert.match(r.out, /^SPAWN4=6$/m, r.out);
    assert.equal(r.calls.filter((c) => c.startsWith("spawn")).length, SPAWN_ATTEMPTS);
  });
});

test("rly4 wait snippet: a missing id is reported by name instead of running wait without one", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "kid4"), "");
    const r = run(waitReapCmd(4, dir), dir, []);
    assert.match(r.out, /^REAPED4=missing-id-kid4$/m, r.out);
    assert.deepEqual(r.calls, []);
  });
});
