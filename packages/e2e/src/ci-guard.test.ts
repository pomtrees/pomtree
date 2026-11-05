import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT } from "./env-scan.ts";

// The Docker CI job runs scripts/ci/skip-guard.py, which fails when a title in its group's `required` list
// (scripts/ci/docker-groups.json) does not appear as a passing line in the test log. A renamed test therefore breaks CI only on
// Linux with Docker, which nobody runs locally (five of the eight names once went dead in a rewrite of
// packages/sandbox-docker/src/docker.test.ts). This lite test keeps the lists honest: every required name is a full test title
// defined in exactly one test file, and the job runs the gated suites with the variables their gates read.

const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const SKIP_GUARD = join(ROOT, "scripts", "ci", "skip-guard.py");

// Every group's required titles, from scripts/ci/docker-groups.json.
const allRequiredNames = (): string[] => Object.values(dockerGroups()).flatMap((g) => g.required);

// Titles of test(...) / it(...) calls (including t.test subtests), in any quote style, possibly on the next line.
export function testTitles(source: string): string[] {
  return [...source.matchAll(/\b(?:test|it)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2] ?? "");
}

// One job's block: from `  <name>:` to the next job key or EOF.
export function jobBlock(yml: string, job: string): string {
  const start = yml.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`no job ${job}`);
  const rest = yml.slice(start + 1);
  const next = /\n {2}[A-Za-z0-9_-]+:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

// YAML `KEY: value` inside a block (env entries), unquoted.
const yamlValue = (block: string, key: string) => new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(block)?.[1];

function testFiles(): string[] {
  const out: string[] = [];
  for (const top of ["packages", "examples"])
    for (const rel of readdirSync(join(ROOT, top), { recursive: true }) as string[])
      if (/\.test\.m?ts$/.test(rel) && !rel.split(/[\\/]/).includes("node_modules")) out.push(join(top, rel));
  return out.sort();
}

test("testTitles parses the shapes it meets (negative variants included)", () => {
  const src = 'test("one", () => {});\ntest(\n  "two; (x)",\n  { skip },\n);\nit(`three`);\nt.test(\'four\');\nconst contest = "test(nope";\nmytest("five");';
  assert.deepEqual(testTitles(src), ["one", "two; (x)", "three", "four"]);
});

test("every CI skip-guard name is a full test title defined in exactly one test file, and no other title contains it", () => {
  const names = allRequiredNames();
  assert.ok(names.length > 0, "the guard requires at least one test");
  const titles = testFiles().flatMap((file) => testTitles(readFileSync(join(ROOT, file), "utf8")).map((title) => ({ file, title })));
  const problems: string[] = [];
  for (const name of names) {
    const exact = new Set(titles.filter((t) => t.title === name).map((t) => t.file));
    // The guard matches the title exactly, so a second title containing the name no longer satisfies it; this check stays so
    // that a log a human reads names one test per required title.
    const containing = titles.filter((t) => t.title.includes(name) && t.title !== name);
    if (exact.size !== 1) problems.push(`${name}: defined in ${exact.size} files${exact.size ? ` (${[...exact].join(", ")})` : ""}`);
    if (containing.length) problems.push(`${name}: also contained in ${containing.map((t) => `${t.file}: ${t.title}`).join("; ")}`);
  }
  assert.deepEqual(problems, [], "update `required` in scripts/ci/docker-groups.json to the current titles");
  assert.equal(new Set(names).size, names.length, "duplicate names in the required list");
});

// The jobs of a workflow, in order.
export const jobNames = (yml: string): string[] => [...yml.slice(yml.indexOf("\njobs:\n")).matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1] ?? "");

// The step of a job whose text contains `needle`.
const stepWith = (job: string, needle: string) => steps(job).find((x) => x.includes(needle)) ?? "";

const TEST_RUN = 'pnpm test:docker:"$DOCKER_GROUP" 2>&1 | tee test-docker.log';

test("the CI image job builds and caches the image, and each docker group loads it and runs its script with the variables the Docker gates read", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const image = jobBlock(yml, "image");
  const docker = jobBlock(yml, "docker");
  const build = image.indexOf("build:image");
  const save = image.indexOf("run: docker save ");
  assert.ok(build >= 0 && save > build && image.indexOf("actions/cache/save@") > save, "the image job builds, saves and caches the image in that order");
  const tag = yamlValue(image, "AGENT_IMAGE_TAG");
  assert.ok(tag, "the image build names its tag");
  assert.match(stepWith(image, "run: docker save "), new RegExp(`docker save ${tag} \\| zstd `), "the saved image is the one built");
  // The cache entry the image job saves is the one every group restores, and a miss fails instead of testing nothing.
  const savedKey = yamlValue(stepWith(image, "actions/cache/save@"), "key");
  assert.match(savedKey ?? "", /\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}$/);
  const restore = stepWith(docker, "actions/cache/restore@");
  assert.equal(yamlValue(restore, "key"), savedKey);
  assert.equal(yamlValue(restore, "path"), yamlValue(stepWith(image, "actions/cache/save@"), "path"));
  assert.equal(yamlValue(restore, "fail-on-cache-miss"), "true");
  const load = docker.indexOf("| docker load");
  const run = docker.indexOf(TEST_RUN);
  assert.ok(
    docker.indexOf("actions/cache/restore@") < load && load < run,
    "the group restores and loads the image before its tests, whose output is teed to the log the guard reads",
  );
  // One matrix entry per group of scripts/ci/docker-groups.json, and the guard checks that group's log.
  const groups = /^ {8}group: \[([^\]]*)\]$/m
    .exec(docker)?.[1]
    ?.split(",")
    .map((g) => g.trim());
  assert.deepEqual(groups, Object.keys(dockerGroups()), "the docker matrix lists every group in scripts/ci/docker-groups.json, in order");
  assert.match(docker, /^ {6}fail-fast: false$/m, "one failing group does not cancel the others");
  assert.match(yamlValue(stepWith(docker, TEST_RUN), "DOCKER_GROUP") ?? "", /^\$\{\{ matrix\.group \}\}$/);
  const guard = stepWith(docker, "python3 scripts/ci/skip-guard.py");
  assert.ok(docker.indexOf("python3 scripts/ci/skip-guard.py") > run, "the skip guard runs after the tests");
  assert.match(guard, /skip-guard\.py --group "\$DOCKER_GROUP" test-docker\.log\n/, "the guard checks this group against the log the test step writes");
  assert.match(yamlValue(guard, "DOCKER_GROUP") ?? "", /^\$\{\{ matrix\.group \}\}$/);
  // e2e suites use PTREE_E2E_IMAGE; sandbox-docker suites use PTREE_AGENT_TEST_IMAGE, defaulting to docker-gate.ts IMAGE.
  assert.equal(yamlValue(docker, "PTREE_E2E_IMAGE"), tag);
  const gateSrc = readFileSync(join(ROOT, "packages", "sandbox-docker", "src", "docker-gate.ts"), "utf8");
  const defaultImage = /PTREE_AGENT_TEST_IMAGE \?\? "([^"]+)"/.exec(gateSrc)?.[1];
  assert.equal(yamlValue(docker, "PTREE_AGENT_TEST_IMAGE") ?? defaultImage, tag, "sandbox-docker gates test the image CI built");
  // docker-gate.ts gate() skips without an explicit revision; it must be the checkout the image was built from.
  assert.match(yamlValue(docker, "PTREE_AGENT_TEST_REVISION") ?? "", /^\$\{\{ github\.sha \}\}$/);
  for (const job of [image, docker]) assert.ok(!/fetch-depth|ref:/.test(job), "both checkouts stay at GITHUB_SHA, the revision build.ts labels the image with");
  // PTREE_DOCKER_TESTS=1 comes from the root scripts, not the workflow; test:full stays the local umbrella that runs everything.
  const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.match(scripts["test:full"] ?? "", /^PTREE_DOCKER_TESTS=1 /);
  assert.match(scripts["test:full"] ?? "", /; PTREE_DOCKER_TESTS=1 pnpm test:examples /, "the example smoke tests get the Docker gate variable too");
  assert.ok(!yml.includes("pnpm test:full"), "CI runs the groups, not test:full, so test-lite's suites do not run twice");
});

test("the CI jobs run in parallel except the docker groups, which need only the image job, and cleanup after them (negative variants included)", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  assert.deepEqual(jobNames(yml), ["format", "lint", "typecheck", "test-lite", "image", "docker", "cleanup"]);
  for (const name of ["format", "lint", "typecheck", "test-lite", "image"]) {
    assert.ok(!/^ {4}needs:/m.test(jobBlock(yml, name)), `${name} must not declare needs; serialising jobs puts the Docker jobs after the cheap ones`);
  }
  assert.deepEqual(/^ {4}needs: (.*)$/m.exec(jobBlock(yml, "docker"))?.[1], "[image]", "the docker groups wait only for the image they test");
  assert.deepEqual(/^ {4}needs: (.*)$/m.exec(jobBlock(yml, "cleanup"))?.[1], "[docker]", "cleanup waits for every docker group");
  // Negative controls: the matcher fires on a serialised job, and the docker check sees a different edge.
  assert.ok(/^ {4}needs:/m.test(jobBlock("\n  a:\n    needs: [b]\n    runs-on: x\n", "a")));
  assert.notEqual(/^ {4}needs: (.*)$/m.exec(jobBlock("\n  docker:\n    needs: [image, lint]\n", "docker"))?.[1], "[image]");
  assert.deepEqual(jobNames("on: x\njobs:\n  a:\n    steps:\n  b:\n"), ["a", "b"]);
});

// `ubuntu-latest` resolves to a different Ubuntu release part way through GitHub's migration, so the gate would run on whichever
// image the label happened to mean (decision: TODO(ci-image-gate)). Every job names the image instead.
test("every CI job pins its runner image rather than the floating ubuntu-latest label (negative control)", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const label = (job: string) => /^ {4}runs-on: (.*)$/m.exec(jobBlock(yml, job))?.[1];
  assert.deepEqual([...new Set(jobNames(yml).map(label))], ["ubuntu-26.04"], "every job runs on the one pinned image");
  assert.ok(!/^ {4}runs-on: .*latest/m.test(yml), "no job falls back to a floating label");
  assert.equal(
    /^ {4}runs-on: (.*)$/m.exec(jobBlock("\n  a:\n    runs-on: ubuntu-latest\n", "a"))?.[1],
    "ubuntu-latest",
    "negative control: the matcher reads the label it is given",
  );
});

test("the cleanup job deletes this run's image tarball after the docker groups, whatever their outcome, and only it may write to the Actions API", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  const cleanup = jobBlock(yml, "cleanup");
  // `always()` so a failed or skipped docker group still frees the cache; the fork check because a fork PR's token cannot
  // delete it and the job would go red (the workflow comment says why that is not fixed with pull_request_target).
  assert.match(
    cleanup,
    /^ {4}if: always\(\) && github\.event\.pull_request\.head\.repo\.fork != true$/m,
    "it runs after failed or skipped docker groups, except on a fork PR",
  );
  assert.equal(yamlValue(cleanup, "KEY"), yamlValue(stepWith(jobBlock(yml, "image"), "actions/cache/save@"), "key"), "it deletes the key the image job saved");
  assert.ok(cleanup.includes('gh cache delete "$KEY"'));
  assert.match(cleanup, /grep -Fxq -- "\$KEY"/, "an absent key is tolerated, not an error");
  assert.match(cleanup, /^ {4}permissions:\n {6}actions: write\n(?! {6})/m, "cleanup gets actions: write and nothing else");
  assert.match(yml, /^permissions:\n {2}contents: read\n/m, "every other job keeps the workflow's contents: read");
  for (const name of jobNames(yml).filter((j) => j !== "cleanup")) assert.ok(!/^ {4}permissions:/m.test(jobBlock(yml, name)), `${name} adds no permissions`);
});

// The e2e package reads its file concurrency from E2E_TEST_CONCURRENCY (default 6); the 2-vCPU hosted runner sets it lower.
export function e2eConcurrency(script: string, env: Record<string, string>): number | undefined {
  const m = /--test-concurrency=\$\{E2E_TEST_CONCURRENCY:-(\d+)\}/.exec(script);
  if (!m) return undefined;
  return Number(env.E2E_TEST_CONCURRENCY || m[1]);
}

test("the e2e test concurrency comes from E2E_TEST_CONCURRENCY and the docker job sets it to 2 (negative variants included)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "e2e", "package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = pkg.scripts.test ?? "";
  assert.equal(e2eConcurrency(script, {}), 6, "local runs keep the default of 6 files at a time");
  assert.equal(e2eConcurrency(script, { E2E_TEST_CONCURRENCY: "2" }), 2);
  assert.equal(e2eConcurrency(script, { E2E_TEST_CONCURRENCY: "" }), 6, "an empty value falls back to the default, as the shell's :- expansion does");
  assert.equal(e2eConcurrency("node --test --test-concurrency=6 x", {}), undefined, "a fixed value ignores the variable");
  assert.equal(yamlValue(jobBlock(readFileSync(WORKFLOW, "utf8"), "docker"), "E2E_TEST_CONCURRENCY"), '"2"');
});

// The argv `sh` builds for the node command of a package test script, with `env` applied (pnpm runs scripts through sh).
export function scriptArgs(script: string, env: Record<string, string>): string[] {
  const r = spawnSync("sh", ["-c", `set -- ${script.replace(/^node /, "")}; printf '%s\\n' "$@"`], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  return r.stdout.split("\n").slice(0, -1);
}

test("the e2e test script expands to separate --test-concurrency and --test-timeout arguments (negative variant included)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "e2e", "package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = pkg.scripts.test ?? "";
  for (const [env, n] of [
    [{}, "6"],
    [{ E2E_TEST_CONCURRENCY: "2" }, "2"],
    [{ E2E_TEST_CONCURRENCY: "" }, "6"],
  ] as const) {
    const args = scriptArgs(script, env);
    assert.ok(args.includes(`--test-concurrency=${n}`), `--test-concurrency=${n} is its own argument: ${JSON.stringify(args)}`);
    assert.ok(args.includes("--test-timeout=120000"), `--test-timeout=120000 is its own argument: ${JSON.stringify(args)}`);
  }
  // Negative control: the fused shape (no space after the expansion) yields one argument, which this check rejects.
  const fused = scriptArgs("node --test --test-concurrency=${E2E_TEST_CONCURRENCY:-6}--test-timeout=120000 x", {});
  assert.ok(!fused.includes("--test-timeout=120000"), `the fused string must not tokenize cleanly: ${JSON.stringify(fused)}`);
});

// The root test scripts read their package concurrency from WORKSPACE_TEST_CONCURRENCY (default 6), like the e2e package above.
export function workspaceConcurrency(script: string, env: Record<string, string>): number | undefined {
  const m = /--workspace-concurrency=\$\{WORKSPACE_TEST_CONCURRENCY:-(\d+)\}(?=\s)/.exec(script);
  if (!m) return undefined;
  return Number(env.WORKSPACE_TEST_CONCURRENCY || m[1]);
}

test("the root test scripts take their package concurrency from WORKSPACE_TEST_CONCURRENCY and CI sets it to 2 (negative variants included)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["test:lite", "test:full"]) {
    const script = pkg.scripts[name] ?? "";
    assert.equal(workspaceConcurrency(script, {}), 6, `${name}: local runs keep the default of 6 packages at a time`);
    assert.equal(workspaceConcurrency(script, { WORKSPACE_TEST_CONCURRENCY: "2" }), 2, name);
    assert.equal(workspaceConcurrency(script, { WORKSPACE_TEST_CONCURRENCY: "" }), 6, `${name}: an empty value falls back to the default, as :- does`);
  }
  assert.equal(workspaceConcurrency("pnpm -r --workspace-concurrency=6 test", {}), undefined, "a fixed value ignores the variable");
  assert.equal(
    workspaceConcurrency("pnpm -r --workspace-concurrency=${WORKSPACE_TEST_CONCURRENCY:-6}test", {}),
    undefined,
    "no space after the expansion glues the next word on",
  );
  const yml = readFileSync(WORKFLOW, "utf8");
  for (const name of ["test-lite", "docker"]) {
    assert.equal(yamlValue(jobBlock(yml, name), "WORKSPACE_TEST_CONCURRENCY"), '"2"', `${name} runs on the 2-vCPU hosted runner`);
  }
  assert.equal(yamlValue(jobBlock(yml, "lint"), "WORKSPACE_TEST_CONCURRENCY"), undefined, "negative control: a job that sets nothing reads undefined");
});

// A job's steps, each from its `      - ` line up to the next (comments before a step stay with the step above).
const steps = (job: string): string[] => job.split(/\n(?= {6}- )/);

// pomtreed must run as uid 1000 (deploy/INSTALL.md; TODO(auth-perms)) and the hosted runner user is uid 1001, so each docker group prepares a
// uid-1000 user and hands it the checkout, runs the suites as that user, and always hands the checkout back to the runner user.
export function runsTestsAsUid1000(job: string): boolean {
  const s = steps(job);
  const at = (needle: string) => s.findIndex((x) => x.includes(needle));
  const prep = at("useradd -m -u 1000");
  const run = at(TEST_RUN);
  const back = at('sudo chown -R "$(id -u):$(id -g)" "$GITHUB_WORKSPACE"');
  return (
    prep >= 0 &&
    (s[prep] ?? "").includes('sudo chown -R 1000 "$GITHUB_WORKSPACE"') &&
    run > prep &&
    (s[run] ?? "").includes('sudo -u "$E2E_USER"') &&
    back > run &&
    /^ {8}if: always\(\)$/m.test(s[back] ?? "")
  );
}

// Env keys of a step that its command does not pass through sudo as KEY="$KEY" (sudo resets the environment).
export function unforwardedEnv(step: string): string[] {
  const env = /\n {8}env:\n((?: {10}.*(?:\n|$))*)/.exec(step)?.[1] ?? "";
  return [...env.matchAll(/^ {10}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1] ?? "").filter((k) => !step.includes(`${k}="$${k}"`));
}

test("each docker group runs its suites as uid 1000 with every step variable, hands the checkout back, and still guards after a failure (negative variants included)", () => {
  const job = jobBlock(readFileSync(WORKFLOW, "utf8"), "docker");
  assert.ok(runsTestsAsUid1000(job), "prepare a uid-1000 user, run the group as it, then return the checkout with if: always()");
  const run = stepWith(job, TEST_RUN);
  assert.ok(/\n {8}env:\n/.test(run), "the test step sets its variables in env");
  assert.deepEqual(unforwardedEnv(run), [], "every env variable of the test step is passed through sudo");
  const guard = steps(job).find((x) => x.includes("- name: Guard against skipped Docker/image tests")) ?? "";
  assert.match(guard, /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m, "the guard also runs after a failed test step");

  const ok = [
    '      - name: Prepare\n        run: |\n          sudo useradd -m -u 1000 x\n          sudo chown -R 1000 "$GITHUB_WORKSPACE"\n',
    `      - name: Test\n        run: sudo -u "$E2E_USER" env A="$A" bash -c '${TEST_RUN}'\n        env:\n          # why\n          A: "1"\n`,
    '      - name: Back\n        if: always()\n        run: sudo chown -R "$(id -u):$(id -g)" "$GITHUB_WORKSPACE"\n',
  ];
  const [prep = "", testStep = "", back = ""] = ok;
  assert.ok(runsTestsAsUid1000(ok.join("")), "the positive shape passes");
  assert.deepEqual(unforwardedEnv(testStep), []);
  assert.ok(!runsTestsAsUid1000(testStep + back), "no uid-1000 user");
  assert.ok(!runsTestsAsUid1000(prep.replace(/ {10}sudo chown.*\n/, "") + testStep + back), "the checkout is not handed over");
  assert.ok(!runsTestsAsUid1000(prep + testStep.replace('sudo -u "$E2E_USER" env A="$A" ', "") + back), "tests run as the runner user");
  assert.ok(!runsTestsAsUid1000(prep + testStep + back.replace("        if: always()\n", "")), "the hand-back is skipped after a failure");
  assert.ok(!runsTestsAsUid1000(prep + back + testStep), "the hand-back runs before the tests");
  assert.deepEqual(unforwardedEnv(`${testStep}          B: x\n`), ["B"], "a variable the sudo line drops is reported");
});

// Real-git tests skip below git 2.38 (harness.ts gitSkip) and the skip guard's `required` list does not cover them, so each
// job that runs them has a step that fails on an old git, reading the floor from workspace-git's git-env.ts.
export function hasGitFloorStep(job: string): boolean {
  const step = job.indexOf("git --version");
  return step >= 0 && job.includes("MIN_SAFE_GIT") && job.includes("git-env.ts") && job.indexOf("pnpm test:", step) > step;
}

test("test-lite and each docker group fail on a git below the floor before running tests (negative variants included)", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  for (const name of ["test-lite", "docker"]) assert.ok(hasGitFloorStep(jobBlock(yml, name)), `${name} checks the git version before its tests`);
  assert.ok(!hasGitFloorStep("steps:\n  - run: pnpm test:lite\n"), "no version step");
  assert.ok(!hasGitFloorStep("  - run: pnpm test:lite\n  - run: git --version # MIN_SAFE_GIT git-env.ts\n"), "step after the tests");
  assert.ok(!hasGitFloorStep("  - run: git --version\n  - run: pnpm test:lite\n"), "no floor source");
  assert.match(readFileSync(join(ROOT, "packages", "workspace-git", "src", "git-env.ts"), "utf8"), /MIN_SAFE_GIT = \[\d+, \d+/);
});

// Runs scripts/ci/skip-guard.py for `groups` against a log; the synthetic line shapes below are what node:test prints (verified on
// node 24), and the test after them feeds it real node:test output.
function runGuard(log: string, groups: string[] = Object.keys(dockerGroups())): { rc: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "ci-guard-"));
  try {
    writeFileSync(join(dir, "test.log"), log);
    const args = [SKIP_GUARD, ...groups.flatMap((g) => ["--group", g]), "test.log"];
    const r = spawnSync("python3", args, { cwd: dir, encoding: "utf8", timeout: 20_000 });
    return { rc: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const spec = (names: string[]) => names.map((n) => `  ✔ ${n} (12.5ms)\n`).join("");
const tap = (names: string[]) => names.map((n, i) => `    ok ${i + 1} - ${n}\n      ---\n      duration_ms: 1.2\n      ...\n`).join("");
const prefixed = (log: string, pkg = "packages/sandbox-docker test: ") =>
  log
    .split("\n")
    .map((l) => (l ? pkg + l : l))
    .join("\n");
const colour = (log: string) => log.replace(/✔/g, "\x1b[32m✔\x1b[39m");

test("the skip guard accepts spec, TAP, pnpm-prefixed and coloured passing lines, and rejects a skip or a missing test (negative controls)", () => {
  const names = allRequiredNames();
  const other = "  ✔ an unrelated test (1ms)\n";
  for (const [label, log] of [
    ["spec", spec(names)],
    ["spec with ANSI colour", colour(spec(names))],
    ["spec with pnpm prefix", prefixed(spec(names))],
    ["TAP", tap(names)],
    ["TAP with pnpm prefix", prefixed(tap(names))],
  ] as const) {
    const r = runGuard(other + log);
    assert.equal(r.rc, 0, `${label}: ${r.out}`);
  }
  const [first = "", ...rest] = names;
  const missing = runGuard(spec(rest));
  assert.equal(missing.rc, 1, "a required test with no line fails the guard");
  // Each cause is named, and only that cause (a timeout leaves "absent", a red test "failed", a skip "skipped").
  const cause = (out: string) => /NOT RUN\/PASSED \([^)]*\): .*: (absent \(not reached\)|failed|skipped)$/m.exec(out)?.[1];
  assert.equal(cause(missing.out), "absent (not reached)");
  const mentioned = runGuard(`${spec(rest)}Error: waiting for ${first}\n`);
  assert.equal(mentioned.rc, 1, "a line that only mentions the title is not a result");
  assert.equal(cause(mentioned.out), "absent (not reached)");
  const specSkip = runGuard(`${spec(rest)}  ﹣ ${first} (0.1ms) # no docker\n`);
  assert.equal(specSkip.rc, 1, "a skipped test fails the guard (spec)");
  assert.equal(cause(specSkip.out), "skipped");
  const tapSkip = runGuard(`${tap(rest)}    ok 99 - ${first} # SKIP no docker\n`);
  assert.equal(tapSkip.rc, 1, "a skipped test fails the guard (TAP)");
  assert.equal(cause(tapSkip.out), "skipped");
  const failing = runGuard(`${spec(rest)}  ✖ ${first} (3ms)\n`);
  assert.equal(failing.rc, 1, "a failing test fails the guard");
  assert.equal(cause(failing.out), "failed");
  const tapFailing = runGuard(`${tap(rest)}not ok 99 - ${first}\n`);
  assert.equal(tapFailing.rc, 1, "a failing test fails the guard (TAP: `not ok` is not a pass)");
  assert.equal(cause(tapFailing.out), "failed");
  assert.equal(cause(runGuard(spec(names)).out), undefined, "negative control: all passing names no cause");
});

// The guard matched a required title by substring until 2026-11-03, so a longer title that contains it satisfied it: the required
// test could be absent from the log and its group still went green. (Same family as the `[a-z-]+` package pattern that once hid
// every e2e failure; CLAUDE.md, Lessons.) The title must match exactly, trailers aside.
test("the skip guard matches a required title exactly, so a longer title containing it does not satisfy it (negative controls)", () => {
  const names = allRequiredNames();
  const [first = "", ...rest] = names;
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const absent = new RegExp(`^NOT RUN/PASSED \\([^)]*\\): ${escapeRe(first)}: absent \\(not reached\\)$`, "m");
  const longer = `${first} and then some`;
  const prefixedTitle = `before ${first}`;
  for (const [label, log] of [
    ["spec, a longer title passes", spec([...rest, longer])],
    ["spec, the title is a suffix of a passing one", spec([...rest, prefixedTitle])],
    ["spec with ANSI colour", colour(spec([...rest, longer]))],
    ["spec with pnpm prefix", prefixed(spec([...rest, longer]))],
    ["TAP, a longer title passes", tap([...rest, longer])],
    ["TAP with pnpm prefix", prefixed(tap([...rest, longer]))],
  ] as const) {
    const r = runGuard(log);
    assert.equal(r.rc, 1, `${label}: a title containing the required one must not satisfy it: ${r.out}`);
    assert.match(r.out, absent, `${label}: the required test is absent, not passed`);
  }
  // A result line is a whole line, not a fragment of one: each of these names the required title while reporting no result of
  // it (a pnpm-style prefix that is not one, a stack frame, a diff line, another test's line or comment).
  for (const line of [
    `console: ok 3 - ${first}`,
    `    at run (file.ts:1:1) ✔ ${first}`,
    `+ ✔ ${first}`,
    `  ✖ A ✔ ${first} (0.1ms)`,
    `  ✖ A ok 1 - ${first}`,
    `  not ok 1 - x ok 2 - ${first}`,
    `  ✔ ${first} #2 (0.1ms)`,
    `  ✔ ${first} # not a skip marker`,
  ]) {
    const r = runGuard(`${spec(rest)}${line}\n`);
    assert.equal(r.rc, 1, `a line that is not a result of the required test must not satisfy it: ${line}: ${r.out}`);
    assert.match(r.out, absent, `${line}: the required test is absent, not passed`);
  }
  // Positive controls: the guard is not simply always-red. The exact title passes, whether or not the longer one is also in the log.
  assert.equal(runGuard(spec(names)).rc, 0, "the exact titles pass");
  assert.equal(runGuard(spec([...names, longer, prefixedTitle])).rc, 0, "the exact title passes beside titles that contain it");
  assert.equal(runGuard(tap([...names, longer])).rc, 0, "the exact title passes beside a longer one (TAP)");
  // The TAP reporter escapes `#` and `\` in a description and the exact match does not undo that, so no required title may hold one.
  assert.deepEqual(
    names.filter((n) => /[#\\]/.test(n)),
    [],
    "a required title holding # or \\ is escaped in TAP output, where it would never match",
  );
});

test("the skip guard checks only the named groups, and refuses an unknown group or a missing log (negative variants included)", () => {
  const groups = dockerGroups();
  const sandbox = spec(groups.sandbox?.required ?? []);
  assert.equal(runGuard(sandbox, ["sandbox"]).rc, 0, "a group's own names suffice for that group");
  const other = runGuard(sandbox, ["e2e-custody"]);
  assert.equal(other.rc, 1, "another group's names do not satisfy a group");
  assert.match(other.out, /NOT RUN\/PASSED \(e2e-custody\)/);
  const unknown = runGuard(sandbox, ["nope"]);
  assert.equal(unknown.rc, 2);
  assert.match(unknown.out, /unknown group nope; expected one of sandbox, /);
  const r = spawnSync("python3", [SKIP_GUARD, "--group", "sandbox", join(tmpdir(), "ci-guard-no-such-log")], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2, "a missing log is a usage error, not a pass");
  assert.match(r.stderr, /cannot read the test log .*the test step did not write it/);
});

test("the skip guard fails when a group's log has more skipped tests than its maxSkips, naming the count and the limit (negative control)", () => {
  const groups = dockerGroups();
  for (const [name, g] of Object.entries(groups)) {
    assert.ok(Number.isInteger(g.maxSkips) && g.maxSkips >= 0, `${name}: maxSkips is a count`);
    assert.ok((g.maxSkipsWhy ?? "").length > 0, `${name}: maxSkipsWhy names the by-design skips`);
  }
  const skips = (n: number) => Array.from({ length: n }, (_, i) => `  \uFE63 by-design skip ${i} (0.1ms) # PTREE_NET_TESTS not set\n`).join("");
  const lifecycle = groups["e2e-lifecycle"];
  assert.ok(lifecycle && lifecycle.maxSkips > 0, "the lifecycle group has by-design skips to count against");
  const atLimit = runGuard(spec(lifecycle.required) + skips(lifecycle.maxSkips), ["e2e-lifecycle"]);
  assert.equal(atLimit.rc, 0, `skips up to the limit pass: ${atLimit.out}`);
  const over = runGuard(spec(lifecycle.required) + skips(lifecycle.maxSkips + 1), ["e2e-lifecycle"]);
  assert.equal(over.rc, 1, "one skip over the limit fails the guard");
  assert.match(over.out, new RegExp(`TOO MANY SKIPS \\(e2e-lifecycle\\): ${lifecycle.maxSkips + 1} skipped tests, more than maxSkips ${lifecycle.maxSkips} `));
  assert.match(over.out, /by-design skip 0/, "the skipped tests are listed");
  const custody = groups["e2e-custody"];
  const none = runGuard(spec(custody?.required ?? []) + skips(1), ["e2e-custody"]);
  assert.equal(none.rc, 1, "a group with maxSkips 0 fails on any skip");
  assert.match(none.out, /1 skipped tests, more than maxSkips 0 /);
  assert.doesNotMatch(none.out, /NOT RUN\/PASSED/, "its required tests passed: the skip limit alone fails it");
});

// Real node:test output for a file whose tests are named like `names`; `skip` names one to skip and `fail` one to fail.
function realOutput(dir: string, names: string[], reporter: "spec" | "tap", opts: { skip?: string; fail?: string } = {}): string {
  const file = join(dir, `${reporter}.test.mjs`);
  const body = names.map((n) => {
    const o = n === opts.skip ? ', { skip: "no docker" }' : "";
    return `test(${JSON.stringify(n)}${o}, () => { ${n === opts.fail ? 'throw new Error("boom");' : ""} });`;
  });
  writeFileSync(file, `import { test } from "node:test";\n${body.join("\n")}\n`);
  const r = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, file], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  return `${r.stdout}${r.stderr}`;
}

// Poll `until` every 50 ms until it holds or `ms` elapse; returns whether it held.
async function waitFor(until: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) return false;
    await delay(50);
  }
  return true;
}

// Pids of processes whose command line mentions `dir` (portable: `ps` on macOS and Linux).
function procsMentioning(dir: string): string[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
  return ps.split("\n").filter((l) => l.includes(dir) && Number(l.trim().split(/\s+/)[0]) !== process.pid);
}

test("the skip guard reports a required test that a killed run never finished as absent (not reached), not failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-guard-killed-"));
  try {
    const [first = "", second = ""] = dockerGroups()["e2e-lifecycle"]?.required ?? [];
    const file = join(dir, "hang.test.mjs");
    const hang = "await new Promise(() => setInterval(() => {}, 1000));";
    writeFileSync(
      file,
      `import { test } from "node:test";\ntest(${JSON.stringify(first)}, () => {});\ntest(${JSON.stringify(second)}, async () => { ${hang} });\n`,
    );
    // As a CI step timeout does: the runner is killed mid-test. The TAP reporter writing to a file keeps the lines already
    // reported (piped spec output can be lost with the process), which is why the docker groups also write one.
    const tapFile = join(dir, "out.tap");
    // `node --test` forks a runner child per file, so killing only the parent leaves the child orphaned: run the whole tree in
    // its own process group and SIGKILL the group.
    const run = spawn(process.execPath, ["--test", "--test-reporter=tap", `--test-reporter-destination=${tapFile}`, file], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "" },
    });
    const exited = new Promise((resolve) => run.once("exit", resolve));
    try {
      // Kill only once the first test is reported, so the second is mid-test (an event, not a fixed delay).
      const reported = await waitFor(() => existsSync(tapFile) && readFileSync(tapFile, "utf8").includes(`ok 1 - ${first}`), 30_000);
      assert.ok(reported, "the runner reported the first test before being killed; re-run the test");
    } finally {
      if (run.pid !== undefined) {
        try {
          process.kill(-run.pid, "SIGKILL");
        } catch {
          // the group is already gone
        }
      }
      await exited;
    }
    assert.ok(await waitFor(() => procsMentioning(dir).length === 0, 10_000), `no process outlives the test: ${procsMentioning(dir).join("; ")}`);
    const out = runGuard(readFileSync(tapFile, "utf8"), ["e2e-lifecycle"]);
    assert.equal(out.rc, 1);
    assert.match(out.out, new RegExp(`: ${second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: absent \\(not reached\\)$`, "m"));
    assert.doesNotMatch(out.out, new RegExp(`${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`), "the finished test passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the skip guard passes real node:test spec and TAP output and fails a real skip or failure of a required test (negative controls)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-guard-real-"));
  try {
    for (const [group, g] of Object.entries(dockerGroups())) {
      const [first = ""] = g.required;
      for (const reporter of ["spec", "tap"] as const) {
        const ok = runGuard(realOutput(dir, g.required, reporter), [group]);
        assert.equal(ok.rc, 0, `${group} ${reporter}: ${ok.out}`);
        const skipped = runGuard(realOutput(dir, g.required, reporter, { skip: first }), [group]);
        assert.equal(skipped.rc, 1, `${group} ${reporter}: a real skip fails the guard`);
        assert.match(skipped.out, /: skipped$/m);
        assert.doesNotMatch(skipped.out, /: (failed|absent)/);
        const failed = runGuard(realOutput(dir, g.required, reporter, { fail: first }), [group]);
        assert.equal(failed.rc, 1, `${group} ${reporter}: a real failure fails the guard`);
        assert.match(failed.out, /: failed$/m);
        assert.doesNotMatch(failed.out, /: (skipped|absent)/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Docker-gated tests run in CI as groups, one docker matrix job each (scripts/ci/docker-groups.json, the single definition).
// A gated file that no group lists never runs in CI and nothing says so, so this lint derives the gated files from the sources and
// requires each to be in exactly one group.
const GROUPS = join(ROOT, "scripts", "ci", "docker-groups.json");

interface DockerGroup {
  runs: { cwd: string; files: string[] }[];
  required: string[];
  maxSkips: number;
  maxSkipsWhy: string;
}

// Docker-gated test files that never pass in CI by design, with the reason (scripts/ci/docker-groups.json `exempt`).
export const dockerExempt = (): Record<string, string> => (JSON.parse(readFileSync(GROUPS, "utf8")) as { exempt?: Record<string, string> }).exempt ?? {};

export const dockerGroups = (): Record<string, DockerGroup> => (JSON.parse(readFileSync(GROUPS, "utf8")) as { groups: Record<string, DockerGroup> }).groups;

// A group's file patterns relative to the repo root.
export const groupPatterns = (group: DockerGroup): string[] => group.runs.flatMap((r) => r.files.map((f) => (r.cwd === "." ? f : `${r.cwd}/${f}`)));

// `*` matches within one path segment; every other character is literal.
export const globMatch = (pattern: string, path: string): boolean =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  ).test(path);

// Source without whole-line comments: prose mentions the gate variable without reading it.
const codeOf = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");

// A read of a gate variable itself, not a mention in a string: `env.X`, `env["X"]`, or `const { X } = process.env`. The variables
// are PTREE_DOCKER_TESTS and PTREE_E2E_IMAGE (the agent image an e2e suite needs, which is a gate on its own).
const envRead = (name: string) =>
  new RegExp(`\\benv(?:\\.${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\])|\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*(?:process\\.)?env\\b`);
const GATE_VARS = [envRead("PTREE_DOCKER_TESTS"), envRead("PTREE_E2E_IMAGE")];
export const readsDockerEnv = (code: string) => GATE_VARS.some((r) => r.test(code));

// A test that probes the Docker daemon itself (`"docker", ["info"]`) needs Docker even without a gate variable. Only a test
// file's own code counts: production modules probe Docker too, and importing them does not make a test need it.
export const probesDocker = (code: string) => /["'`]docker["'`]\s*,\s*\[\s*["'`]info["'`]/.test(code);

// Repo-relative target of an import specifier: relative paths, and `@pomtree/<pkg>/<path>` (packages/<pkg>/<path>). A bare
// package import goes through its index, whose re-exports are not followed (no index re-exports a gate today).
export function resolveImport(from: string, spec: string): string | undefined {
  if (spec.startsWith(".")) return posix.normalize(posix.join(posix.dirname(from), spec));
  const m = /^@pomtree\/([^/]+)\/(.+)$/.exec(spec);
  return m ? `packages/${m[1]}/${m[2]}` : undefined;
}

// `{ a, type B, c as d }` specifiers as [imported, local] pairs, type-only ones dropped.
const specifiers = (list: string): [string, string][] =>
  list
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("type "))
    .map((s) => {
      const [imported = "", local = imported] = s.split(/\s+as\s+/);
      return [imported, local];
    });

// Value imports of a module: local name -> [resolved file, imported name, "*" for a namespace or "default"]. Type-only imports
// cannot gate. Covers `import d, { a } from`, `import * as n from` and `import d, * as n from`.
export function valueImports(file: string, code: string): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  const re = /^import\s+(type\s+)?(?:([\w$]+)\s*(?:,\s*)?)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) {
    const target = resolveImport(file, m[5] ?? "");
    if (m[1] || !target) continue;
    if (m[2]) out.set(m[2], [target, "default"]);
    if (m[4]) out.set(m[4], [target, "*"]);
    for (const [imported, local] of specifiers(m[3] ?? "")) out.set(local, [target, imported]);
  }
  return out;
}

// Re-exports of a module: `export { a, b as c } from "x"` as [exported name, target, imported name], `export * from "x"` as
// [ "*", target, "*" ].
export function reExports(file: string, code: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const m of code.matchAll(/^export\s+(type\s+)?(?:\{([^}]*)\}|(\*))\s*from\s*["']([^"']+)["']/gm)) {
    const target = resolveImport(file, m[4] ?? "");
    if (m[1] || !target) continue;
    if (m[3]) out.push(["*", target, "*"]);
    for (const [imported, exported] of specifiers(m[2] ?? "")) out.push([exported, target, imported]);
  }
  return out;
}

// Targets of dynamic `import("...")` calls with a literal specifier.
export const dynamicImports = (file: string, code: string): string[] =>
  [...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => resolveImport(file, m[1] ?? "")).filter((t): t is string => !!t);

// Top-level declarations with their text up to the next top-level statement.
export function topLevelDecls(code: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  let cur: { name: string; text: string } | undefined;
  for (const line of code.split("\n")) {
    const m = /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      cur = { name: m[1] ?? "", text: line };
      out.push(cur);
    } else if (/^[^\s}\])]/.test(line)) cur = undefined;
    else if (cur) cur.text += `\n${line}`;
  }
  return out;
}

const mentions = (text: string, name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text);

// Docker-gated test files among `sources` (repo-relative path -> source). A gate is a top-level declaration that reads a gate
// variable or uses another gate (docker-gate.ts gate/engineGate, cli-scenarios-harness.ts cliScenarioSkip and image, then each
// kit's `SKIP = cliScenarioSkip()`, to a fixed point), or a name a module re-exports from a gate. A gate is used through a static
// import (named, default, namespace) or a dynamic import() whose module's gate the code names. A test file is gated when it
// reads a gate variable, uses a gate, or probes the Docker daemon itself.
export function dockerGatedFiles(sources: Map<string, string>): string[] {
  const parsed = [...sources].map(([file, src]) => {
    const code = codeOf(src);
    return { file, code, imports: valueImports(file, code), reExports: reExports(file, code), dynamic: dynamicImports(file, code), decls: topLevelDecls(code) };
  });
  const gates = new Map<string, Set<string>>();
  const add = (file: string, name: string) => {
    if (gates.get(file)?.has(name)) return false;
    gates.set(file, (gates.get(file) ?? new Set()).add(name));
    return true;
  };
  const usesGate = (p: (typeof parsed)[number], text: string) =>
    readsDockerEnv(text) ||
    [...(gates.get(p.file) ?? [])].some((g) => mentions(text, g)) ||
    [...p.imports].some(([local, [target, name]]) =>
      name === "*" ? [...(gates.get(target) ?? [])].some((g) => text.includes(`${local}.${g}`)) : gates.get(target)?.has(name) && mentions(text, local),
    ) ||
    p.dynamic.some((target) => {
      // The names the code uses, without the import specifiers themselves (`import("./gate.ts")` names no gate).
      const names = text.replace(/\bimport\(\s*["'][^"']*["']\s*\)/g, "import()").replace(/\.(?=[\w$])/g, " ");
      return [...(gates.get(target) ?? [])].some((g) => mentions(names, g));
    });
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of parsed) {
      for (const d of p.decls) if (!gates.get(p.file)?.has(d.name) && usesGate(p, d.text)) changed = add(p.file, d.name) || changed;
      for (const [exported, target, imported] of p.reExports)
        for (const g of gates.get(target) ?? []) if (imported === "*" || imported === g) changed = add(p.file, imported === "*" ? g : exported) || changed;
    }
  }
  return parsed
    .filter((p) => /\.test\.m?ts$/.test(p.file) && (usesGate(p, p.code) || probesDocker(p.code)))
    .map((p) => p.file)
    .sort();
}

// Coverage problems: a gated file in no group (unless exempt) or in two, a pattern that matches nothing, a group file that is not
// gated (test-lite already runs it, so the Docker job would run it twice), and an exemption that is stale or gives no reason.
export function groupProblems(gated: string[], groups: Record<string, string[]>, testFilePaths: string[], exempt: Record<string, string> = {}): string[] {
  const problems: string[] = [];
  for (const [file, why] of Object.entries(exempt)) {
    if (!gated.includes(file)) problems.push(`${file} is exempt but not Docker-gated: drop it from exempt in scripts/ci/docker-groups.json`);
    if (!why.trim()) problems.push(`${file} is exempt without a reason: say why it never passes in CI`);
  }
  for (const file of gated) {
    const owners = Object.keys(groups).filter((g) => (groups[g] ?? []).some((p) => globMatch(p, file)));
    if (owners.length === 0 && !(file in exempt))
      problems.push(
        `${file} is Docker-gated but in no group, so CI never runs it: add it to one group in scripts/ci/docker-groups.json, or to exempt with the reason`,
      );
    if (owners.length > 1) problems.push(`${file} is in groups ${owners.join(", ")}: keep it in exactly one`);
  }
  for (const [group, patterns] of Object.entries(groups))
    for (const pattern of patterns) {
      const hits = testFilePaths.filter((f) => globMatch(pattern, f));
      if (hits.length === 0) problems.push(`${group}: ${pattern} matches no test file: fix or drop the pattern`);
      for (const f of hits.filter((h) => !gated.includes(h)))
        problems.push(
          `${group}: ${f} matches this group's pattern ${pattern} but is not Docker-gated, so test-lite already runs it and this group's skip accounting counts a test it does not own: rename the file so the pattern misses it, narrow the pattern, or drop it from the group in scripts/ci/docker-groups.json`,
        );
    }
  return problems;
}

// Every .ts/.mts source under packages and examples, except this file: its fixtures quote the gate read as strings.
function repoSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const top of ["packages", "examples"])
    for (const rel of readdirSync(join(ROOT, top), { recursive: true }) as string[]) {
      const file = `${top}/${rel.split("\\").join("/")}`;
      if (/\.m?ts$/.test(rel) && !rel.split(/[\\/]/).includes("node_modules") && file !== "packages/e2e/src/ci-guard.test.ts")
        out.set(file, readFileSync(join(ROOT, top, rel), "utf8"));
    }
  return out;
}

test("dockerGatedFiles follows env reads, daemon probes, imported, re-exported and dynamically imported gates, and ignores types, comments and local helpers (negative variants included)", () => {
  const src = new Map([
    [
      "p/gate.ts",
      'export function gate(): string | false {\n  if (process.env.PTREE_DOCKER_TESTS !== "1") return "off";\n  return false;\n}\nexport const IMAGE = "x";\n',
    ],
    ["p/kit.ts", 'import { gate } from "./gate.ts";\nexport const SKIP = gate();\nexport const bash = () => 1;\n'],
    ["p/kit2.ts", 'import { SKIP as S } from "./kit.ts";\nexport function withSkip() {\n  return S;\n}\n'],
    ["p/direct.test.ts", 'import { gate } from "./gate.ts";\ntest("a", { skip: gate() }, () => {});\n'],
    ["p/aliased.test.ts", 'import { gate as g } from "./gate.ts";\ntest("a", { skip: g() }, () => {});\n'],
    ["p/kit.test.ts", 'import { bash, SKIP } from "./kit.ts";\ntest("a", { skip: SKIP }, () => bash());\n'],
    ["p/kit2.test.ts", 'import { withSkip } from "./kit2.ts";\ntest("a", { skip: withSkip() }, () => {});\n'],
    ["p/ns.test.ts", 'import * as k from "./kit.ts";\ntest("a", { skip: k.SKIP }, () => {});\n'],
    ["p/env.test.ts", 'const on = process.env["PTREE_DOCKER_TESTS"] === "1";\ntest("a", { skip: !on }, () => {});\n'],
    ["p/pkg.test.ts", 'import { gate } from "@pomtree/p/gate.ts";\ntest("a", { skip: gate() }, () => {});\n'],
    ["p/types.test.ts", 'import type { gate } from "./gate.ts";\nimport { type SKIP, bash } from "./kit.ts";\ntest("a", () => bash());\n'],
    ["p/image.test.ts", 'import { IMAGE } from "./gate.ts";\ntest(IMAGE, () => {});\n'],
    ["p/comment.test.ts", '// run with PTREE_DOCKER_TESTS=1, see process.env.PTREE_DOCKER_TESTS\ntest("a", () => {});\n'],
    ["p/string.test.ts", 'const names = [{ name: "PTREE_DOCKER_TESTS" }];\ntest("a", () => names);\n'],
    ["p/local.test.ts", "const gate = () => 1;\ntest('a', () => gate());\n"],
    // Destructured env reads, the image variable, and a daemon probe; negatives: another variable, a probe of another command.
    ["p/destructure.test.ts", 'const { PTREE_DOCKER_TESTS } = process.env;\ntest("a", { skip: !PTREE_DOCKER_TESTS }, () => {});\n'],
    ["p/destructure-other.test.ts", 'const { PTREE_NET_TESTS } = process.env;\ntest("a", { skip: !PTREE_NET_TESTS }, () => {});\n'],
    ["p/image-env.test.ts", 'const IMAGE = process.env.PTREE_E2E_IMAGE;\ntest("a", { skip: !IMAGE }, () => {});\n'],
    ["p/probe.test.ts", 'const up = spawnSync("docker", ["info"]).status === 0;\ntest("a", { skip: !up }, () => {});\n'],
    ["p/probe-other.test.ts", 'const v = spawnSync("docker", ["version"]);\ntest("a", () => v);\n'],
    // Re-exports: a kit that re-exports the gate, and one that re-exports everything; negative: re-exporting a non-gate.
    ["p/rekit.ts", 'export { SKIP as GATED, bash } from "./kit.ts";\n'],
    ["p/starkit.ts", 'export * from "./kit.ts";\n'],
    ["p/rekit.test.ts", 'import { GATED } from "./rekit.ts";\ntest("a", { skip: GATED }, () => {});\n'],
    ["p/starkit.test.ts", 'import { SKIP } from "./starkit.ts";\ntest("a", { skip: SKIP }, () => {});\n'],
    ["p/rekit-other.test.ts", 'import { bash } from "./rekit.ts";\ntest("a", () => bash());\n'],
    // A default import beside named ones; negative: the named import is not a gate.
    ["p/default.test.ts", 'import kit, { SKIP } from "./kit.ts";\ntest("a", { skip: SKIP }, () => kit);\n'],
    ["p/default-other.test.ts", 'import kit, { bash } from "./kit.ts";\ntest("a", () => bash(kit));\n'],
    // A dynamic import whose gate the code names; negative: a dynamic import of the same module that uses only IMAGE.
    ["p/dynamic.test.ts", 'const g = await import("./gate.ts");\ntest("a", { skip: g.gate() }, () => {});\n'],
    ["p/dynamic-destructure.test.ts", 'const { gate } = await import("./gate.ts");\ntest("a", { skip: gate() }, () => {});\n'],
    ["p/dynamic-other.test.ts", 'const { IMAGE } = await import("./gate.ts");\ntest(IMAGE, () => {});\n'],
  ]);
  const inPackage = new Map([...src].map(([f, s]) => [`packages/${f}`, s]));
  assert.deepEqual(
    dockerGatedFiles(inPackage),
    [
      "aliased",
      "default",
      "destructure",
      "direct",
      "dynamic-destructure",
      "dynamic",
      "env",
      "image-env",
      "kit",
      "kit2",
      "ns",
      "pkg",
      "probe",
      "rekit",
      "starkit",
    ].map((n) => `packages/p/${n}.test.ts`),
  );
});

test("groupProblems requires every gated file in exactly one group and every group file to be gated (negative variants included)", () => {
  const files = ["e/a.test.ts", "e/b.test.ts", "e/lite.test.ts", "s/c.test.ts"];
  const gated = ["e/a.test.ts", "e/b.test.ts", "s/c.test.ts"];
  assert.deepEqual(groupProblems(gated, { one: ["e/a.test.ts", "e/b.test.ts"], two: ["s/*.test.ts"] }, files), []);
  const uncovered = groupProblems(gated, { one: ["e/a.test.ts"], two: ["s/*.test.ts"] }, files);
  assert.deepEqual(uncovered.length, 1);
  assert.match(uncovered[0] ?? "", /^e\/b\.test\.ts is Docker-gated but in no group/);
  const twice = groupProblems(gated, { one: ["e/a.test.ts", "e/b.test.ts"], two: ["s/*.test.ts", "e/b.test.ts"] }, files);
  assert.deepEqual(twice, ["e/b.test.ts is in groups one, two: keep it in exactly one"]);
  // A pattern, not a listed path, is what usually drags an offline file in: a new `e/lite*.test.ts` matches `e/*.test.ts` and
  // nothing tells its author that a filename did it (it happened on 2026-11-03). The message names the pattern and both ways out.
  const pulledIn = groupProblems(gated, { one: ["e/*.test.ts"], two: ["s/c.test.ts"] }, files).join("\n");
  assert.match(pulledIn, /one: e\/lite\.test\.ts matches this group's pattern e\/\*\.test\.ts but is not Docker-gated/);
  assert.match(pulledIn, /rename the file.*narrow the pattern.*docker-groups\.json/);
  assert.match(groupProblems(gated, { one: ["e/a.test.ts", "e/b.test.ts", "e/z*.test.ts"], two: ["s/c.test.ts"] }, files).join("\n"), /matches no test file/);
  // Exempt: a gated file in no group is fine with a reason; a stale or unexplained exemption is not.
  assert.deepEqual(groupProblems(gated, { one: ["e/a.test.ts"], two: ["s/*.test.ts"] }, files, { "e/b.test.ts": "needs a live key" }), []);
  assert.match(
    groupProblems(gated, { one: ["e/a.test.ts", "e/b.test.ts"], two: ["s/c.test.ts"] }, files, { "e/lite.test.ts": "x" }).join("\n"),
    /e\/lite\.test\.ts is exempt but not Docker-gated/,
  );
  assert.match(groupProblems(gated, { one: ["e/a.test.ts"], two: ["s/c.test.ts"] }, files, { "e/b.test.ts": " " }).join("\n"), /exempt without a reason/);
  assert.ok(globMatch("src/cli-relay*.test.ts", "src/cli-relay-k4.test.ts"));
  assert.ok(!globMatch("src/*.test.ts", "src/sub/x.test.ts"), "a star stays inside one path segment");
  assert.ok(!globMatch("e/[ab].test.ts", "e/a.test.ts"), "brackets are literal, not a character class");
});

test("every Docker-gated test file is in exactly one CI Docker group or exempt, and each group's required titles are in its own files", (t) => {
  const sources = repoSources();
  const gated = dockerGatedFiles(sources);
  // Anchors on the real tree: one file per gate shape is found, and files with a local `gate` helper are not.
  for (const f of [
    "packages/sandbox-docker/src/docker.test.ts",
    "packages/sandbox-docker/src/network-docker.test.ts",
    "packages/pomtreed/src/agent-net.docker.test.ts",
    "packages/e2e/src/cli-scenarios.test.ts",
    "packages/e2e/src/cli-relay-k4.test.ts",
    "examples/hn-digest/content-live-smoke.test.mts",
  ])
    assert.ok(gated.includes(f), `${f} is detected as Docker-gated`);
  for (const f of ["packages/e2e/src/e2e.test.ts", "packages/e2e/src/custody.test.ts", "packages/pomtreed/src/daemon.lifecycle.test.ts"])
    assert.ok(!gated.includes(f), `${f} only has a local gate() helper`);
  const groups = dockerGroups();
  const patterns = Object.fromEntries(Object.entries(groups).map(([name, g]) => [name, groupPatterns(g)]));
  const exempt = dockerExempt();
  assert.deepEqual(groupProblems(gated, patterns, testFiles(), exempt), []);
  // Stated, not missed: the files that never pass in CI by design, and why.
  for (const [file, why] of Object.entries(exempt)) t.diagnostic(`exempt: ${file}: ${why}`);
  const problems: string[] = [];
  for (const [name, g] of Object.entries(groups)) {
    assert.ok(g.required.length > 0, `${name} requires at least one test, or the whole group could skip unnoticed`);
    for (const title of g.required) {
      const files = testFiles().filter((f) => testTitles(readFileSync(join(ROOT, f), "utf8")).includes(title));
      if (files.length !== 1) problems.push(`${name}: "${title}" is defined in ${files.length} files`);
      else if (!(patterns[name] ?? []).some((p) => globMatch(p, files[0] ?? ""))) problems.push(`${name}: "${title}" is in ${files[0]}, outside the group`);
    }
  }
  assert.deepEqual(problems, [], "update `required` in scripts/ci/docker-groups.json");
});

// The runs a root `test:docker:<group>` script makes, read from its `;`/`||`/`&&` segments: `node --test` (cwd: the repo root),
// `pnpm --filter @pomtree/<pkg> exec node --test` (cwd: packages/<pkg>), or `pnpm --filter @pomtree/<pkg> <script>` (that
// package's script, cwd: packages/<pkg>). Files are the test-file arguments as sh passes them (quotes removed, no globbing).
// `ungated` lists segments that run tests without PTREE_DOCKER_TESTS=1, so every gated test in them would skip.
export function scriptRuns(script: string, pkgScript: (dir: string, name: string) => string): { runs: { cwd: string; files: string[] }[]; ungated: string[] } {
  const words = (s: string) =>
    spawnSync("sh", ["-c", `set -f; set -- ${s}; printf '%s\\n' "$@"`], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" })
      .stdout.split("\n")
      .slice(0, -1);
  const out: { runs: { cwd: string; files: string[] }[]; ungated: string[] } = { runs: [], ungated: [] };
  for (const raw of script.split(/;|\|\||&&/).map((s) => s.trim())) {
    const segment = raw.replace(/^PTREE_DOCKER_TESTS=1 /, "");
    const filtered = /^pnpm --filter @pomtree\/([\w-]+) (?:exec )?(.*)$/.exec(segment);
    const cwd = filtered ? `packages/${filtered[1]}` : ".";
    const command = filtered && !segment.includes(" exec ") ? pkgScript(cwd, filtered[2] ?? "") : (filtered?.[2] ?? segment);
    if (!/^node --test /.test(command)) continue;
    if (segment === raw) out.ungated.push(raw);
    out.runs.push({ cwd, files: words(command).filter((w) => /\.test\.m?ts$/.test(w)) });
  }
  return out;
}

// The argv of each node segment of a script, as sh expands it with `env` after the script's leading assignments (`x=...;`).
export function segmentArgs(script: string, env: Record<string, string>): string[][] {
  const segments = script.split(/;|\|\||&&/).map((s) => s.trim());
  const assignments = segments.filter((s) => /^[a-z_]\w*=\S*$/.test(s)).join("; ");
  return segments
    .filter((s) => s.includes("node --test"))
    .map((s) =>
      spawnSync("sh", ["-c", `${assignments}; set -f; set -- ${s}; printf '%s\\n' "$@"`], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" })
        .stdout.split("\n")
        .slice(0, -1),
    );
}

// node:test pairs the n-th --test-reporter with the n-th --test-reporter-destination.
export function reporterPairs(args: string[]): [string, string | undefined][] {
  const value = (prefix: string) => args.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
  const destinations = value("--test-reporter-destination=");
  return value("--test-reporter=").map((r, i) => [r, destinations[i]]);
}

const packageScripts = (dir: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};

test("each root test:docker:<group> script runs exactly its group's files with the gate set, and e2e keeps its concurrency flags (negative variants included)", () => {
  const root = packageScripts(".");
  const groups = dockerGroups();
  const fromPkg = (dir: string, name: string) => packageScripts(dir)[name] ?? "";
  assert.deepEqual(
    Object.keys(root).filter((k) => k.startsWith("test:docker:")),
    Object.keys(groups).map((g) => `test:docker:${g}`),
    "one root script per group, in manifest order",
  );
  for (const [name, g] of Object.entries(groups)) {
    assert.deepEqual(
      scriptRuns(root[`test:docker:${name}`] ?? "", fromPkg),
      { runs: g.runs, ungated: [] },
      `test:docker:${name} matches scripts/ci/docker-groups.json`,
    );
  }
  for (const name of Object.keys(groups).filter((g) => g.startsWith("e2e-"))) {
    const script = packageScripts("packages/e2e")[`test:docker:${name}`] ?? "";
    const args = scriptArgs(script, { E2E_TEST_CONCURRENCY: "2" });
    assert.ok(
      args.includes("--test-concurrency=2") && args.includes("--test-timeout=120000"),
      `${name}: separate concurrency and timeout flags: ${JSON.stringify(args)}`,
    );
    assert.equal(e2eConcurrency(script, {}), 6, `${name}: local runs keep the default of 6`);
    // Spec to stdout (the log the guard reads) and TAP to E2E_TAP, a file that keeps what was reported if a timeout kills the run.
    assert.deepEqual(reporterPairs(scriptArgs(script, { E2E_TAP: "/tmp/a dir/e2e.tap" })), [
      ["spec", "stdout"],
      ["tap", "/tmp/a dir/e2e.tap"],
    ]);
    assert.deepEqual(reporterPairs(scriptArgs(script, {})), [
      ["spec", "stdout"],
      ["tap", "/dev/null"],
    ]);
  }
  // The sandbox script runs three node processes, so each writes its own TAP file beside E2E_TAP (none when it is unset).
  const sandbox = (env: Record<string, string>) => segmentArgs(root["test:docker:sandbox"] ?? "", env).map(reporterPairs);
  assert.deepEqual(
    sandbox({ E2E_TAP: "/t/a dir/e2e.tap" }),
    ["sandbox-docker", "pomtreed", "examples"].map((p) => [
      ["spec", "stdout"],
      ["tap", `/t/a dir/e2e-${p}.tap`],
    ]),
  );
  assert.deepEqual(
    sandbox({}),
    [0, 1, 2].map(() => [
      ["spec", "stdout"],
      ["tap", "/dev/null"],
    ]),
  );
  const noAssignment = (root["test:docker:sandbox"] ?? "").replace(/^tap=\S*; /, "");
  assert.equal(
    reporterPairs(segmentArgs(noAssignment, { E2E_TAP: "/t/e2e.tap" })[0] ?? [])[1]?.[1],
    "/dev/null",
    "negative control: without the assignment nothing is kept",
  );
  // Negative variants: a fused reporter flag, and a reporter without its destination, do not pair.
  const fusedReporter = scriptArgs("node --test --test-reporter=tap--test-reporter-destination=/dev/null x", {});
  assert.deepEqual(reporterPairs(fusedReporter), [["tap--test-reporter-destination=/dev/null", undefined]]);
  assert.deepEqual(reporterPairs(["--test-reporter=spec", "--test-reporter=tap", "--test-reporter-destination=stdout"]), [
    ["spec", "stdout"],
    ["tap", undefined],
  ]);
  // The parser follows a package script; negative variants: a missing gate variable, and a dropped file.
  const stub = (_: string, n: string) => (n === "t:x" ? "node --test --test-timeout=1 'src/a*.test.ts' 'src/b.test.ts'" : "");
  assert.deepEqual(scriptRuns("PTREE_DOCKER_TESTS=1 pnpm --filter @pomtree/e2e t:x", stub), {
    runs: [{ cwd: "packages/e2e", files: ["src/a*.test.ts", "src/b.test.ts"] }],
    ungated: [],
  });
  assert.deepEqual(scriptRuns("node --test 'x/a.test.mts'; r=$?; exit $r", stub), {
    runs: [{ cwd: ".", files: ["x/a.test.mts"] }],
    ungated: ["node --test 'x/a.test.mts'"],
  });
  const dropped = scriptRuns("PTREE_DOCKER_TESTS=1 pnpm --filter @pomtree/sandbox-docker exec node --test 'src/a.test.ts'", stub);
  assert.notDeepEqual(dropped.runs, [{ cwd: "packages/sandbox-docker", files: ["src/a.test.ts", "src/b.test.ts"] }]);
});

// Every `uses:` line pins an action to a full commit SHA with its version in a comment (negative variants included).
export const unpinnedActions = (yml: string): string[] =>
  [...yml.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].filter((m) => !/@[0-9a-f]{40}$/.test(m[1] ?? "") || !/^ # v\d/.test(m[2] ?? "")).map((m) => m[1] ?? "");

test("every action is pinned to a commit SHA, and the docker groups write and upload their TAP stream outside the checkout (negative variants included)", () => {
  const yml = readFileSync(WORKFLOW, "utf8");
  assert.deepEqual(unpinnedActions(yml), []);
  assert.deepEqual(unpinnedActions("      - uses: actions/x@v7\n        uses: a/b@0123456789012345678901234567890123456789\n"), [
    "actions/x@v7",
    "a/b@0123456789012345678901234567890123456789",
  ]);
  const docker = jobBlock(yml, "docker");
  const tap = yamlValue(stepWith(docker, TEST_RUN), "E2E_TAP") ?? "";
  assert.match(
    tap,
    /^\$\{\{ runner\.temp \}\}\/e2e-tap\//,
    "the TAP file lives under RUNNER_TEMP, not the checkout (a file there turns image suites into skips)",
  );
  const prep = stepWith(docker, "useradd -m -u 1000");
  assert.ok(prep.includes('sudo install -d -o 1000 "$RUNNER_TEMP/e2e-tap"'), "uid 1000 owns the TAP directory, not RUNNER_TEMP itself");
  assert.ok(!/chown[^\n]*"\$RUNNER_TEMP"(\s|$)/.test(prep), "RUNNER_TEMP itself is not handed over");
  const upload = stepWith(docker, "actions/upload-artifact@");
  assert.match(upload, /^ {8}if: always\(\)$/m, "the TAP file is uploaded after a failure or a timeout too");
  assert.equal(yamlValue(upload, "path"), tap.replace(/[^/]*$/, ""), "the whole TAP directory, so the sandbox group's per-process files go too");
  assert.ok(steps(docker).indexOf(upload) > steps(docker).indexOf(stepWith(docker, TEST_RUN)), "upload after the tests");
});

// Per-group limits from the docker matrix: `include` entries override the step and job defaults in the timeout expressions.
export function groupTimeouts(docker: string): Record<string, { test: number; job: number }> {
  const fallback = (key: string) => Number(new RegExp(`\\$\\{\\{ matrix\\.${key} \\|\\| (\\d+) \\}\\}`).exec(docker)?.[1]);
  const groups =
    /^ {8}group: \[([^\]]*)\]$/m
      .exec(docker)?.[1]
      ?.split(",")
      .map((g) => g.trim()) ?? [];
  const out: Record<string, { test: number; job: number }> = {};
  for (const g of groups) out[g] = { test: fallback("test_minutes"), job: fallback("job_minutes") };
  for (const m of docker.matchAll(/^ {10}- group: (\S+)\n((?: {12}\w+: \d+\n)*)/gm)) {
    const entry = out[m[1] ?? ""];
    if (!entry) continue;
    entry.test = Number(/test_minutes: (\d+)/.exec(m[2] ?? "")?.[1] ?? entry.test);
    entry.job = Number(/job_minutes: (\d+)/.exec(m[2] ?? "")?.[1] ?? entry.job);
  }
  return out;
}

test("each e2e group gets a 25-minute test step in a 35-minute job and sandbox 15 in 30, each with setup headroom (negative variants included)", () => {
  const limits = groupTimeouts(jobBlock(readFileSync(WORKFLOW, "utf8"), "docker"));
  assert.deepEqual(limits, {
    sandbox: { test: 15, job: 30 },
    "e2e-scenarios": { test: 25, job: 35 },
    "e2e-custody": { test: 25, job: 35 },
    "e2e-lifecycle": { test: 25, job: 35 },
  });
  for (const [g, l] of Object.entries(limits)) assert.ok(l.job - l.test >= 10, `${g}: install, image load and the guard need time after the test step`);
  const fixed = "    timeout-minutes: 30\n      matrix:\n        group: [a]\n        timeout-minutes: 15\n";
  assert.deepEqual(groupTimeouts(fixed), { a: { test: Number.NaN, job: Number.NaN } }, "fixed limits are not per-group expressions");
});
