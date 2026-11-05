// Negative controls for scripts/coordinator-gate.sh, the script CLAUDE.md names as the gate for every commit and push.
// The gate is driven for real (CHECK_ONLY=1) inside a throwaway git repo with a scripted `pnpm` ahead of it on PATH, so each
// case pins the verdict the gate reaches for one combination of check exit codes and output. The crafted log in
// "a red non-pomtreed suite blocks" is the audit's: a failing e2e test whose title starts with "f", a failing title carrying a
// TODO tag, and a crashed core package. The gate that parsed titles answered VERDICT-OK to exactly that log.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./harness.ts";

const GATE = new URL("../../../scripts/coordinator-gate.sh", import.meta.url).pathname;

// A scripted pnpm: the first spec line whose extended regex matches the joined argv decides the exit code and the output.
const FAKE_PNPM = `#!/bin/sh
args="$*"
printf '%s\\n' "$args" >> "$GATE_FAKE_CALLS"
while IFS='\t' read -r rc pat out; do
  [ -n "$rc" ] || continue
  if printf '%s' "$args" | grep -Eq -- "$pat"; then
    [ -z "$out" ] || printf '%b\\n' "$out"
    exit "$rc"
  fi
done < "$GATE_FAKE_SPEC"
exit 0
`;

interface Spec {
  /** Extended regex matched against the joined pnpm argv. */
  pat: string;
  rc: number;
  out?: string;
}

/** Run a gate script over the scripted pnpm in a fresh throwaway repo. Returns the verdict, the exit code and every pnpm argv. */
const runGate = (gate: string, specs: Spec[]): { rc: number; out: string; calls: string[] } => {
  // The harness's own files live outside the repo: the gate aborts on an untracked file, which is its first line of defence.
  const root = tmp("gate");
  const dir = join(root, "repo");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "packages", "pomtreed"), { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "packages", "pomtreed", "a.txt"), "base\n");
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  copyFileSync(gate, join(dir, "scripts", "coordinator-gate.sh"));
  chmodSync(join(dir, "scripts", "coordinator-gate.sh"), 0o755);
  git("add", "--", "tracked.txt", "packages/pomtreed/a.txt", "scripts/coordinator-gate.sh");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pnpm"), FAKE_PNPM);
  chmodSync(join(bin, "pnpm"), 0o755);
  const specFile = join(root, "spec.tsv");
  writeFileSync(specFile, `${specs.map((s) => `${s.rc}\t${s.pat}\t${(s.out ?? "").replaceAll("\n", "\\n")}`).join("\n")}\n`);

  writeFileSync(join(dir, "tracked.txt"), "changed\n");
  const msg = join(root, "msg.txt");
  writeFileSync(msg, "area: imperative summary\n");
  const callsFile = join(root, "calls.txt");
  writeFileSync(callsFile, "");
  const r = spawnSync("bash", [join(dir, "scripts", "coordinator-gate.sh"), "--branch", "origin/main", msg, "tracked.txt"], {
    cwd: dir,
    encoding: "utf8",
    // TMPDIR outside the repo too: the gate creates its log directory before it checks for untracked files. The concurrency is
    // pinned so the recorded re-run argv cannot depend on the caller's environment.
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CHECK_ONLY: "1",
      GATE_FAKE_SPEC: specFile,
      GATE_FAKE_CALLS: callsFile,
      TMPDIR: root,
      WORKSPACE_TEST_CONCURRENCY: "6",
    },
  });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}`, calls: readFileSync(callsFile, "utf8").split("\n").filter(Boolean) };
};

// The whole-tree test leg, and the legs the gate re-runs to classify a failure. Patterns are matched in order.
const TEST_LITE = "(^| )test:lite( |$)";
const REST = "filter !@pomtree/pomtreed";
const POMTREED_ALONE = "filter @pomtree/pomtreed";
const EXAMPLES = "test:examples";
const RELEASE_EXPORT = "test:release-export";

// The audit's crafted log: a red e2e test whose title starts with "f" (the old title filter's `[^f]` dropped it), a red title
// carrying a TODO tag (its `grep -v 'TODO('` dropped it), a crashed core package (no title at all), and one named pomtreed failure,
// which was all the old fail-closed fallback asked for before it answered VERDICT-OK to the whole log.
const CRAFTED = [
  "packages/e2e test: ✖ fence holds across generations (12.3ms)",
  "packages/e2e test: ✖ custody refuses a foreign host TODO(identity) (4.1ms)",
  "packages/core test: node:internal/modules/run_main SyntaxError: Unexpected token",
  "packages/core test:  ELIFECYCLE  Command failed with exit code 1.",
  "packages/pomtreed test: ✖ follower resumes after a restart (900ms)",
].join("\n");

test("gate: an all-green tree ships", () => {
  const r = runGate(GATE, [{ pat: ".", rc: 0 }]);
  assert.match(r.out, /^VERDICT-OK/m, r.out);
  assert.equal(r.rc, 0);
});

// Finding 7 was that the gate executed LESS than check:lite while claiming to run every check. A verdict test cannot catch that,
// because a leg the gate never runs can never be red: this pins the legs themselves, so dropping one fails here.
test("gate: a green run invokes every leg of check:lite, so the gate cannot execute less than it", () => {
  const r = runGate(GATE, [{ pat: ".", rc: 0 }]);
  assert.deepEqual(r.calls, ["format:check", "lint", "typecheck", "test:lite"], r.calls.join(" | "));
});

// The tolerance is a load-flake state, not a package: exit codes cannot say which package failed the first run (naming it would
// need the title parser back), so a non-pomtreed flake that does not reproduce ships under the same caveat. Pinned deliberately.
test("gate: a first-run failure anywhere that does not reproduce ships under the load caveat, naming no culprit", () => {
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1, out: "packages/core test: ✖ budget nests (10ms)" },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^VERDICT-OK CAVEAT: .*did not reproduce when re-run split up.*TODO\(load-flakes\)/m, r.out);
  assert.match(r.out, /cannot say which package was at fault/, r.out);
  assert.equal(r.rc, 0);
});

test("gate: a failing static leg blocks, and names the leg", () => {
  const r = runGate(GATE, [
    { pat: "(^| )lint( |$)", rc: 1 },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^NOT-SHIPPED: static checks failed: lint/m, r.out);
  assert.equal(r.rc, 1);
});

test("gate: a red non-pomtreed suite blocks, whatever its title looks like", () => {
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1, out: CRAFTED },
    { pat: REST, rc: 1, out: CRAFTED },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^NOT-SHIPPED: tests failed outside pomtreed: packages-except-pomtreed/m, r.out);
  assert.equal(r.rc, 1);
});

test("gate: a red release-export scan blocks (it is part of the test leg the gate runs)", () => {
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1, out: "denylist-scan: FAIL credential: 1 hits in 1 files" },
    { pat: RELEASE_EXPORT, rc: 1, out: "denylist-scan: FAIL credential: 1 hits in 1 files" },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^NOT-SHIPPED: tests failed outside pomtreed: release-export/m, r.out);
  assert.equal(r.rc, 1);
});

test("gate: a red example blocks", () => {
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1 },
    { pat: EXAMPLES, rc: 1, out: "examples test: ✖ digest renders" },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^NOT-SHIPPED: tests failed outside pomtreed: examples/m, r.out);
  assert.equal(r.rc, 1);
});

test("gate: pomtreed red under load but green alone ships with the caveat", () => {
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1, out: "packages/pomtreed test: ✖ follower resumes after a restart (900ms)" },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^VERDICT-OK CAVEAT: .*whole-tree parallel test run failed.*TODO\(load-flakes\)/m, r.out);
  assert.match(r.out, /pomtreed passes alone/, r.out);
  assert.deepEqual(
    r.calls.slice(4),
    ["-r --no-bail --workspace-concurrency=6 --filter !@pomtree/pomtreed test", "test:examples", "test:release-export", "--filter @pomtree/pomtreed test"],
    r.calls.join(" | "),
  );
  assert.equal(r.rc, 0);
});

test("gate: pomtreed red alone too blocks", () => {
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1 },
    { pat: POMTREED_ALONE, rc: 1, out: "packages/pomtreed test: ✖ follower resumes after a restart" },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^NOT-SHIPPED: pomtreed fails alone too/m, r.out);
  assert.equal(r.rc, 1);
});

test("gate: a test leg that fails with no failing test named still blocks", () => {
  // Fail closed: nothing in the output resembles a test title, so a parser would have had nothing to name.
  const r = runGate(GATE, [
    { pat: TEST_LITE, rc: 1, out: "Killed" },
    { pat: REST, rc: 137, out: "Killed" },
    { pat: ".", rc: 0 },
  ]);
  assert.match(r.out, /^NOT-SHIPPED: tests failed outside pomtreed/m, r.out);
  assert.equal(r.rc, 1);
});
