import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatDuration, GUARDRAILS, onboardingSteps, troubleshooting, type SetupFacts, type StepCommand, STEP_IDS, setupFacts, stepById } from "./steps.ts";

const FACTS: SetupFacts = { nodeRange: ">=99", pnpmVersion: "9.9.9", minGit: "8.8.8", defaultImage: "example/agent:tag" };
const steps = onboardingSteps(FACTS);

test("the steps come in STEP_IDS order, one per id, each with prose", () => {
  assert.deepEqual(
    steps.map((s) => s.id),
    [...STEP_IDS],
  );
  for (const s of steps) assert.ok(s.prose.length > 20 && s.title !== s.id, `${s.id} has real content`);
});

test("a step is flagged needsRoot or network exactly when one of its commands is", () => {
  for (const s of steps) {
    assert.equal(
      s.needsRoot === true,
      s.commands.some((c) => c.needsRoot === true),
      `${s.id} needsRoot`,
    );
    assert.equal(
      s.network === true,
      s.commands.some((c) => c.network === true),
      `${s.id} network`,
    );
  }
  assert.equal(stepById(steps, "firewall").needsRoot, true);
  assert.equal(stepById(steps, "install-node").needsRoot, undefined);
});

test("no step spends money", () => {
  for (const s of steps) assert.equal(s.spend, false, s.id);
});

test("version facts are quoted from SetupFacts, not written as literals", () => {
  const all = (id: (typeof STEP_IDS)[number]) => JSON.stringify(stepById(steps, id));
  assert.ok(all("install-node").includes(">=99"));
  assert.ok(all("install-git").includes("8.8.8"));
  assert.ok(all("enable-pnpm").includes("9.9.9"));
  assert.ok(all("build-image").includes("example/agent:tag"));
  const other = onboardingSteps({ ...FACTS, nodeRange: ">=77" });
  assert.ok(!JSON.stringify(stepById(other, "install-node")).includes(">=99"));
});

test("steps.ts source holds no POMTREED_ literal: environment names arrive through SetupFacts from the registry", () => {
  assert.ok(!/POMTREED_/.test(readFileSync(join(import.meta.dirname, "steps.ts"), "utf8")));
});

// The release export's own credential pattern, read at test time so this scan cannot drift from it.
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DENYLIST_PATH = join(ROOT, "scripts", "release-export", "denylist.json");
// The shipped tree has no release-export tooling, so the drift check can only run where the pattern file exists.
const SKIP_NO_DENYLIST = existsSync(DENYLIST_PATH)
  ? false
  : "scripts/release-export/denylist.json is absent: the shipped tree has no release-export tooling to drift from";
const denylist = SKIP_NO_DENYLIST
  ? undefined
  : (JSON.parse(readFileSync(DENYLIST_PATH, "utf8")) as {
      patterns: { name: string; pattern: string; flags?: string }[];
    });
const credentialEntry = denylist?.patterns.find((p) => p.name === "credential");
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

test("steps.ts, GETTING_STARTED.md and the onboarding skill hold nothing the release export's credential scan flags, with a negative control", {
  skip: SKIP_NO_DENYLIST,
}, () => {
  assert.ok(credentialEntry, "scripts/release-export/denylist.json has no credential pattern; update this test to its new name");
  const pattern = new RegExp(credentialEntry.pattern, credentialEntry.flags ?? "");
  // a guardrail id once contained "sk-safety-decisions"
  assert.ok(pattern.test("ask-safety-decisions"), "negative control: the old id is what the scan flags");
  const scanned = [
    join(import.meta.dirname, "steps.ts"),
    join(ROOT, "GETTING_STARTED.md"),
    ...filesUnder(join(ROOT, ".agents", "skills", "pomtree-onboarding")),
  ];
  assert.ok(scanned.length > 3);
  for (const f of scanned) assert.ok(!pattern.test(readFileSync(f, "utf8")), `${f} matches the release export's credential pattern`);
});

test("every step command starting with sudo is marked needsRoot, and every command that downloads asks first; negative control on a sample", () => {
  const sudoUnmarked = (cs: readonly StepCommand[]) => cs.filter((c) => /^sudo\s/.test(c.run) && c.needsRoot !== true).map((c) => c.run);
  for (const s of steps) {
    assert.deepEqual(sudoUnmarked(s.commands), [], `${s.id}: a sudo command without needsRoot`);
    for (const c of s.commands) if (c.network === true) assert.equal(c.confirm, true, `${s.id}: ${c.run} downloads but does not ask first`);
  }
  assert.deepEqual(sudoUnmarked([{ run: "sudo make install" }]), ["sudo make install"]);
});

test("the install-like pnpm commands ask first: corepack enable (both forms), corepack install and pnpm --version", () => {
  const pnpm = stepById(steps, "enable-pnpm").commands;
  for (const run of ["corepack enable", "corepack enable --install-directory ~/.local/bin", "npm install --global corepack", "pnpm --version"])
    assert.equal(pnpm.find((c) => c.run === run)?.confirm, true, run);
});

test("the guardrails have unique stable ids and cover root, keys, spend and the forced decisions", () => {
  const ids = GUARDRAILS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["no-root", "confirm-installs", "no-live-spend", "no-keys-in-chat", "safety-decisions-asked", "repo-untrusted", "no-fresh"])
    assert.ok(ids.includes(id), id);
});

test("stepById throws for an unknown id; setupFacts reads the root package.json and names a missing field", () => {
  assert.throws(() => stepById([], "preflight"), /no onboarding step/);
  assert.deepEqual(setupFacts('{"engines":{"node":">=24"},"packageManager":"pnpm@10.1.0"}', [2, 38, 0], "img"), {
    nodeRange: ">=24",
    pnpmVersion: "10.1.0",
    minGit: "2.38.0",
    defaultImage: "img",
  });
  assert.deepEqual(setupFacts('{"engines":{"node":">=24"},"packageManager":"pnpm@10.1.0"}', [2], "img", { sessionDefaultMs: 5, egressProxyImageEnv: "E" }), {
    nodeRange: ">=24",
    pnpmVersion: "10.1.0",
    minGit: "2",
    defaultImage: "img",
    sessionDefaultMs: 5,
    egressProxyImageEnv: "E",
  });
  assert.throws(() => setupFacts('{"packageManager":"pnpm@1.0.0"}', [2], "i"), /engines\.node/);
  assert.throws(() => setupFacts('{"engines":{"node":">=1"},"packageManager":"yarn@1"}', [2], "i"), /packageManager/);
});

test("the build-image step describes one image, offers both rebuild commands and the unset of the registry's env name", () => {
  const withEnv = onboardingSteps({ ...FACTS, egressProxyImageEnv: "SOME_ENV_NAME" });
  const build = stepById(withEnv, "build-image");
  assert.ok(build.prose.includes("One image"));
  const run = build.commands.map((c) => c.run);
  assert.deepEqual(run, [
    "scripts/pomtree-up <repo> --rebuild",
    "AGENT_IMAGE_TAG=example/agent:tag pnpm --filter @pomtree/agent-image build:image",
    "unset SOME_ENV_NAME",
  ]);
  assert.ok(build.commands.slice(0, 2).every((c) => c.confirm === true));
  assert.equal(build.commands[1]?.network, true);
  assert.ok(!JSON.stringify(steps).includes("--egress-image"));
  // negative control: without the registry name there is no unset command
  assert.ok(!stepById(steps, "build-image").commands.some((c) => c.run.startsWith("unset")));
});

test("formatDuration uses the largest exact unit", () => {
  assert.equal(formatDuration(4 * 3_600_000), "4 h");
  assert.equal(formatDuration(90 * 60_000), "90 min");
  assert.equal(formatDuration(45_000), "45 s");
  assert.equal(formatDuration(1500), "1500 ms");
});

test("troubleshooting quotes the session default humanly and names no key; absent, it points to the docs", () => {
  const fix = (f: SetupFacts) =>
    troubleshooting(f)
      .flatMap((g) => g.entries)
      .find((e) => e.id === "timed-out")?.fix as string;
  assert.match(fix({ ...FACTS, sessionDefaultMs: 4 * 3_600_000 }), /default of 4 h/);
  assert.match(fix({ ...FACTS, sessionDefaultMs: 4 * 3_600_000 }), /pomtree extend <id>/);
  assert.ok(!fix({ ...FACTS, sessionDefaultMs: 1 }).includes("session.defaultMs"));
  assert.doesNotMatch(fix(FACTS), /default of/);
});

test("enable-pnpm: the version note does not promise the pinned pnpm before the checkout, and the prose says to run one variant", () => {
  const step = stepById(onboardingSteps(FACTS), "enable-pnpm");
  const note = step.commands.find((c) => c.run === "pnpm --version")?.note ?? "";
  assert.match(note, /outside the checkout corepack fetches its own default pnpm/);
  assert.match(note, new RegExp(`pnpm ${FACTS.pnpmVersion} \\(the pinned version\\) is fetched on the first pnpm command inside the checkout`));
  assert.doesNotMatch(note, /^the first run downloads/);
  assert.match(step.prose, /Run exactly one of the three `corepack enable` variants/);
});

test("start-docker offers the optional docker group command with its root, confirm and re-login caveats", () => {
  const step = stepById(onboardingSteps(FACTS), "start-docker");
  const cmd = step.commands.find((c) => c.run === 'sudo usermod -aG docker "$USER"');
  assert.ok(cmd, "the usermod command is present");
  assert.equal(cmd.needsRoot, true);
  assert.equal(cmd.confirm, true);
  assert.match(cmd.note ?? "", /optional/);
  assert.match(cmd.note ?? "", /root-equivalent/);
  assert.match(cmd.note ?? "", /log out and back in/);
  assert.match(cmd.note ?? "", /newgrp docker/);
  assert.match(step.prose, /root-equivalent/);
  assert.match(step.prose, /log out and back in/);
});

test("smoke-test points the fresh terminal at the state directory before the doctor command; absent the name, no export", () => {
  const runs = (f: SetupFacts) => stepById(onboardingSteps(f), "smoke-test").commands.map((c) => c.run);
  const run = runs({ ...FACTS, stateDirEnv: "SOME_STATE_ENV" });
  const exportAt = run.indexOf("export SOME_STATE_ENV=<state-dir>");
  const doctorAt = run.indexOf("pomtree doctor --json");
  assert.ok(exportAt >= 0, "the export command is present");
  assert.ok(doctorAt >= 0);
  assert.ok(exportAt < doctorAt, "the export comes before doctor");
  assert.ok(!runs(FACTS).some((r) => r.startsWith("export ")));
});
