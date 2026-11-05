import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeProbeRunner } from "@pomtree/testing";
import { probeArgs } from "../image-check.ts";
import { evaluateObservations, parseMinRange } from "./findings.ts";
import { runPreflight } from "./preflight.ts";
import { DOCKER_RUN_TIMEOUT_MS, gatherObservations, PNPM_PROBE_ENV, type FileStat, type ProbeHost, type ProbeResult, type ProbeRunner } from "./probes.ts";
import { onboardingSteps } from "./steps.ts";

const facts = { nodeRange: ">=24", pnpmVersion: "10.19.0", minGit: "2.38.0", defaultImage: "pomtree/agent:dev" };
const steps = onboardingSteps(facts);
const ok = (stdout = ""): ProbeResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1, stderr = ""): ProbeResult => ({ code, stdout: "", stderr });
const LABEL = `docker image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }} pomtree/agent:dev`;
const proxyFor = (ref: string) => ["docker", ...probeArgs(ref)].join(" "); // the boot check's own probe, so the two cannot drift
const PROXY = proxyFor("pomtree/agent:dev");
const RUN_PROBE =
  "docker run --rm --network none --entrypoint ls --mount type=bind,src=/state,dst=/pomtreed-state-probe,readonly pomtree/agent:dev /pomtreed-state-probe";

// A healthy host; each test overrides or removes entries.
const healthy = (): Record<string, ProbeResult> => ({
  "git --version": ok("git version 2.43.0\n"),
  "corepack --version": ok("0.30.0\n"),
  "pnpm --version": ok("10.19.0\n"),
  "docker --version": ok("Docker version 27.1.1\n"),
  "docker info --format {{.ServerVersion}}": ok("27.1.1\n"),
  "docker buildx version": ok("github.com/docker/buildx v0.16\n"),
  [LABEL]: ok("abc1234\n"),
  "git -C /checkout rev-parse --short HEAD": ok("abc1234\n"),
  [RUN_PROBE]: ok("x"),
  [PROXY]: ok(),
  "systemctl is-active ufw": fail(3),
  "git -C /repo rev-parse --verify -q HEAD": ok("sha"),
});

const dir: FileStat = { mode: 0o40700, uid: 1000, isDirectory: true };
const host = (over: Partial<ProbeHost> = {}, files: Record<string, FileStat> = { "/state": dir }): ProbeHost => ({
  platform: "linux",
  nodeVersion: "v24.1.0",
  uid: 1000,
  facts,
  checkout: "/checkout",
  repoDir: "/repo",
  stateDir: "/state",
  image: facts.defaultImage,
  stat: (p) => files[p] ?? null,
  realpath: (p) => p,
  ...over,
});

async function findingsFor(script: Record<string, ProbeResult>, h: ProbeHost = host()) {
  const runner = new FakeProbeRunner(script);
  return { findings: evaluateObservations(await gatherObservations(h, runner), steps), runner };
}
const get = (fs: { id: string }[], id: string) => fs.find((f) => f.id === id) as ReturnType<typeof evaluateObservations>[number];

test("FakeProbeRunner satisfies the ProbeRunner contract structurally", () => {
  const r: ProbeRunner = new FakeProbeRunner({});
  assert.equal(typeof r.run, "function");
});

test("a healthy host yields no warning or error", async () => {
  const { findings } = await findingsFor(healthy());
  assert.deepEqual(
    findings.filter((f) => f.severity === "warn" || f.severity === "error"),
    [],
  );
  assert.equal(get(findings, "state.visible").severity, "ok");
});

test("parseMinRange understands >=N[.M[.P]] and nothing else", () => {
  assert.deepEqual(parseMinRange(">=24"), [24, 0, 0]);
  assert.deepEqual(parseMinRange(">=22.5.1"), [22, 5, 1]);
  assert.equal(parseMinRange("^24"), null);
});

test("node: too old is an error naming install-node; an unevaluable range is a warning", async () => {
  const old = get((await findingsFor(healthy(), host({ nodeVersion: "v22.3.0" }))).findings, "node.version");
  assert.equal(old.severity, "error");
  assert.equal(old.step, "install-node");
  const odd = (await findingsFor(healthy(), host({ facts: { ...facts, nodeRange: "^24" } }))).findings;
  assert.equal(get(odd, "node.version").severity, "warn");
});

test("git: missing and too old are errors with install-git", async () => {
  const s = healthy();
  delete s["git --version"];
  const missing = get((await findingsFor(s)).findings, "git.version");
  assert.equal(missing.severity, "error");
  assert.equal(missing.step, "install-git");
  const oldGit = get((await findingsFor({ ...healthy(), "git --version": ok("git version 2.30.1") })).findings, "git.version");
  assert.equal(oldGit.severity, "error");
  assert.match(oldGit.message, /2\.30\.1/);
});

test("pnpm: missing is an error, a version other than the pin is a warning, corepack missing is a warning", async () => {
  const s = healthy();
  delete s["pnpm --version"];
  delete s["corepack --version"];
  const f = (await findingsFor(s)).findings;
  assert.equal(get(f, "pnpm.version").severity, "error");
  assert.equal(get(f, "pnpm.corepack").severity, "warn");
  assert.equal(get(f, "pnpm.version").step, "enable-pnpm");
  assert.equal(get((await findingsFor({ ...healthy(), "pnpm --version": ok("9.0.0") })).findings, "pnpm.version").severity, "warn");
});

test("corepack: missing on node 24 (bundled) vs node 26 (unbundled) names the case, command and flags; present is ok; the negative control keeps the cases apart", async () => {
  const s = healthy();
  delete s["corepack --version"];
  const n24 = get((await findingsFor(s, host({ nodeVersion: "v24.9.0" }))).findings, "pnpm.corepack");
  assert.equal(n24.severity, "warn");
  assert.equal(n24.step, "enable-pnpm");
  assert.match(n24.message, /bundles it/);
  assert.match(n24.message, /`corepack enable`/);
  assert.doesNotMatch(n24.message, /npm install/);
  assert.deepEqual([n24.needsRoot, n24.network], [true, false]);
  const n26 = get((await findingsFor(s, host({ nodeVersion: "v26.12.1" }))).findings, "pnpm.corepack");
  assert.match(n26.message, /does not bundle it/);
  assert.match(n26.message, /`npm install --global corepack`/);
  assert.deepEqual([n26.needsRoot, n26.network], [true, true]);
  // the install command in the message is the one the step lists
  assert.ok(steps.find((x) => x.id === "enable-pnpm")?.commands.some((c) => n26.message.includes(c.run) && c.network === true));
  const present = get((await findingsFor(healthy(), host({ nodeVersion: "v26.12.1" }))).findings, "pnpm.corepack");
  assert.equal(present.severity, "ok");
  assert.equal(present.needsRoot, false);
});

test("docker missing: error install-docker, and the daemon-dependent probes never run", async () => {
  const s = healthy();
  for (const k of Object.keys(s)) if (k.startsWith("docker")) delete s[k];
  const { findings, runner } = await findingsFor(s);
  assert.equal(get(findings, "docker.cli").step, "install-docker");
  assert.equal(get(findings, "docker.cli").severity, "error");
  assert.equal(
    findings.some((f) => f.id === "docker.daemon"),
    false,
  );
  assert.equal(get(findings, "image.agent.present").message, "skipped: docker daemon not reachable");
  assert.equal(
    runner.calls.some((c) => c.command === "docker" && c.args[0] === "run"),
    false,
  );
});

test("docker daemon down: error start-docker; buildx missing: error install-docker; image and state probes skipped", async () => {
  const down = (await findingsFor({ ...healthy(), "docker info --format {{.ServerVersion}}": fail(1, "Cannot connect") })).findings;
  assert.equal(get(down, "docker.daemon").severity, "error");
  assert.equal(get(down, "docker.daemon").step, "start-docker");
  assert.equal(get(down, "image.agent.present").severity, "info");
  assert.match(get(down, "state.visible").message, /skipped/);
  const s = healthy();
  delete s["docker buildx version"];
  assert.equal(get((await findingsFor(s)).findings, "docker.buildx").step, "install-docker");
});

test("podman found is info with 'not validated' and carries no step; absent podman yields no finding", async () => {
  const withPodman = (await findingsFor({ ...healthy(), "podman --version": ok("podman version 4.9\n") })).findings;
  const p = get(withPodman, "podman.runtime");
  assert.equal(p.severity, "info");
  assert.ok(p.message.includes("not validated"));
  assert.equal(p.step, undefined);
  assert.equal(
    (await findingsFor(healthy())).findings.some((f) => f.id === "podman.runtime"),
    false,
  );
});

const labelFor = (ref: string) => `docker image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }} ${ref}`;
const EGRESS = "registry.example/egress@sha256:abc";

test("images: with no --egress-image the egress image is the agent image, probed once, both ids reported, and the message says so", async () => {
  const { findings, runner } = await findingsFor(healthy());
  assert.equal(runner.calls.filter((c) => c.args[0] === "image").length, 1);
  assert.equal(get(findings, "image.agent.present").severity, "ok");
  assert.equal(get(findings, "image.egress.present").severity, "ok");
  assert.match(get(findings, "image.egress.revision").message, /defaulted to the agent image/);
  assert.equal(
    findings.some((f) => f.id === "image.present" || f.id === "image.revision"),
    false,
  );
});

test("images: a missing agent image is a blocking error naming the cause, with the build-image step", async () => {
  const f = get((await findingsFor({ ...healthy(), [LABEL]: fail(1, "No such image") })).findings, "image.agent.present");
  assert.equal(f.severity, "error");
  assert.equal(f.step, "build-image");
  assert.match(f.message, /not present: an agent start would fail when the sandbox starts its containers/);
});

test("images: a stale agent image is a warning naming both revisions; negative control: a current label is ok", async () => {
  const stale = get((await findingsFor({ ...healthy(), [LABEL]: ok("def5678\n") })).findings, "image.agent.revision");
  assert.equal(stale.severity, "warn");
  assert.equal(stale.step, "build-image");
  assert.match(stale.message, /built from def5678, checkout is abc1234/);
  assert.equal(get((await findingsFor(healthy())).findings, "image.agent.revision").severity, "ok");
});

test("images: an unlabelled image is a warning with build-image", async () => {
  const f = get((await findingsFor({ ...healthy(), [LABEL]: ok("\n") })).findings, "image.agent.revision");
  assert.equal(f.severity, "warn");
  assert.equal(f.step, "build-image");
});

const blocking = (fs: { severity: string }[]) => fs.filter((f) => f.severity === "warn" || f.severity === "error");

test("image check, missing: error build-image, and the egress proxy probe is not run", async () => {
  const { findings, runner } = await findingsFor({ ...healthy(), [LABEL]: fail(1, "No such image") });
  const f = get(findings, "image.egress.present");
  assert.equal(f.severity, "error");
  assert.equal(f.step, "build-image");
  assert.equal(get(findings, "image.egress.proxy").severity, "info");
  assert.equal(
    runner.calls.some((c) => c.args.includes("node")),
    false,
  );
});

test("image check, no proxy: a blocking error naming the cause and build-image; the probe is exactly the boot check's argv with the docker timeout", async () => {
  const { findings, runner } = await findingsFor({ ...healthy(), [PROXY]: fail(3) });
  const f = get(findings, "image.egress.proxy");
  assert.equal(f.severity, "error");
  assert.equal(f.step, "build-image");
  assert.match(f.message, /built before the egress proxy existed \(it lacks \/opt\/pomtree\/egress\/proxy\.ts\)/);
  const probes = runner.calls.filter((c) => c.args.includes("node"));
  assert.equal(probes.length, 1, "agent and egress are one ref: probed once");
  assert.deepEqual(probes[0], {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--entrypoint",
      "node",
      "pomtree/agent:dev",
      "-e",
      "process.exit(require('node:fs').existsSync('/opt/pomtree/egress/proxy.ts')?0:3)",
    ],
    timeoutMs: DOCKER_RUN_TIMEOUT_MS,
  });
  assert.equal((await runPreflight([], { runner: new FakeProbeRunner({ ...healthy(), [PROXY]: fail(3) }), steps, host: host() })).code, 1);
});

test("image check, negative control: a no-proxy image with a CURRENT revision label is still the blocking error", async () => {
  const { findings } = await findingsFor({ ...healthy(), [PROXY]: fail(3), [LABEL]: ok("abc1234\n") });
  assert.equal(get(findings, "image.egress.revision").severity, "ok");
  assert.equal(get(findings, "image.egress.proxy").severity, "error");
});

test("image check, proxy probe that never answered: a warning 'could not check' with build-image, not an error", async () => {
  const s = healthy();
  delete s[PROXY];
  const f = get((await findingsFor(s)).findings, "image.egress.proxy");
  assert.equal(f.severity, "warn");
  assert.equal(f.step, "build-image");
  assert.match(f.message, /could not check/);
});

test("image check, proxy probe: only the probe's exit 3 is absent; node's 1 (any crash) and docker's 125-127 are a warning, never an error", async () => {
  for (const code of [1, 125, 126, 127]) {
    const f = get((await findingsFor({ ...healthy(), [PROXY]: fail(code) })).findings, "image.egress.proxy");
    assert.equal(f.severity, "warn", `exit ${code}`);
    assert.match(f.message, /could not check/);
  }
  assert.equal(get((await findingsFor({ ...healthy(), [PROXY]: fail(3) })).findings, "image.egress.proxy").severity, "error");
});

test("image check, negative control: exit 1 does not block preflight", async () => {
  const r = await runPreflight([], { runner: new FakeProbeRunner({ ...healthy(), [PROXY]: fail(1) }), steps, host: host() });
  assert.equal(r.code, 0);
});

test("image check, stale revision: a warning (not an error) with build-image, even though the proxy is present", async () => {
  const { findings } = await findingsFor({ ...healthy(), [LABEL]: ok("def5678\n") });
  assert.equal(get(findings, "image.egress.proxy").severity, "ok");
  assert.equal(get(findings, "image.egress.revision").severity, "warn");
  assert.equal(get(findings, "image.egress.revision").step, "build-image");
});

test("image check, unlabelled: a warning with build-image", async () => {
  const f = get((await findingsFor({ ...healthy(), [LABEL]: ok("\n") })).findings, "image.egress.revision");
  assert.equal(f.severity, "warn");
  assert.equal(f.step, "build-image");
});

test("image check, current with the proxy: ok, no warn or error image finding", async () => {
  const { findings } = await findingsFor(healthy());
  assert.equal(get(findings, "image.egress.proxy").severity, "ok");
  assert.deepEqual(blocking(findings.filter((f) => f.id.startsWith("image."))), []);
});

test("image check, daemon down: the proxy probe is not run and the finding is info", async () => {
  const { findings, runner } = await findingsFor({ ...healthy(), "docker info --format {{.ServerVersion}}": fail(1, "Cannot connect") });
  assert.equal(get(findings, "image.egress.proxy").severity, "info");
  assert.equal(
    runner.calls.some((c) => c.args.includes("node")),
    false,
  );
});

test("images: a separate --egress-image is probed on its own; missing is an error, stale a warning, no proxy an error, current ok", async () => {
  const h = host({ egressImage: EGRESS });
  const noProxy = (await findingsFor({ ...healthy(), [labelFor(EGRESS)]: ok("abc1234\n"), [proxyFor(EGRESS)]: fail(3) }, h)).findings;
  assert.equal(get(noProxy, "image.egress.proxy").severity, "error");
  assert.equal(get(noProxy, "image.agent.present").severity, "ok");
  const missing = (await findingsFor({ ...healthy(), [labelFor(EGRESS)]: fail(1) }, h)).findings;
  assert.equal(get(missing, "image.agent.present").severity, "ok");
  assert.equal(get(missing, "image.egress.present").severity, "error");
  assert.equal(get(missing, "image.egress.present").step, "build-image");
  assert.doesNotMatch(get(missing, "image.egress.present").message, /defaulted/);
  const stale = (await findingsFor({ ...healthy(), [labelFor(EGRESS)]: ok("0000000\n"), [proxyFor(EGRESS)]: ok() }, h)).findings;
  assert.equal(get(stale, "image.egress.revision").severity, "warn");
  assert.equal(get(stale, "image.agent.revision").severity, "ok");
  assert.equal(
    get((await findingsFor({ ...healthy(), [labelFor(EGRESS)]: ok("abc1234\n"), [proxyFor(EGRESS)]: ok() }, h)).findings, "image.egress.revision").severity,
    "ok",
  );
});

test("runPreflight: --egress-image reaches the probe, and a missing image makes the exit code 1", async () => {
  const runner = new FakeProbeRunner({ ...healthy(), [labelFor(EGRESS)]: fail(1) });
  const r = await runPreflight(["--egress-image", EGRESS], { runner, steps, host: host() });
  assert.equal(r.code, 1);
  assert.ok(runner.calls.some((c) => c.args.at(-1) === EGRESS));
});

test("state.visible: a failing docker run is an error with state-dir; a missing state dir is skipped without running docker", async () => {
  const bad = get((await findingsFor({ ...healthy(), [RUN_PROBE]: fail(125, "invalid mount\n") })).findings, "state.visible");
  assert.equal(bad.severity, "error");
  assert.equal(bad.step, "state-dir");
  const { findings, runner } = await findingsFor(healthy(), host({}, {}));
  assert.equal(get(findings, "state.visible").severity, "info");
  assert.equal(
    runner.calls.some((c) => c.args.includes("ls")),
    false,
  );
});

test("state.visible: the probe is exactly the no-network --mount form with the docker timeout", async () => {
  const { runner } = await findingsFor(healthy());
  assert.deepEqual(
    runner.calls.find((c) => c.args.includes("ls")),
    {
      command: "docker",
      args: [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "ls",
        "--mount",
        "type=bind,src=/state,dst=/pomtreed-state-probe,readonly",
        "pomtree/agent:dev",
        "/pomtreed-state-probe",
      ],
      timeoutMs: DOCKER_RUN_TIMEOUT_MS,
    },
  );
});

test("state.visible: a probe that never answered (null) is a warning, not a blocking error; a numeric nonzero stays an error", async () => {
  const s = healthy();
  delete s[RUN_PROBE];
  const f = get((await findingsFor(s)).findings, "state.visible");
  assert.equal(f.severity, "warn");
  assert.match(f.message, /could not check/);
  assert.equal(get((await findingsFor({ ...healthy(), [RUN_PROBE]: fail(125, "x\n") })).findings, "state.visible").severity, "error");
});

test("state.visible: a state dir with a comma, double quote is skipped with an info finding (mount CSV), docker is not run for it; a colon is probed", async () => {
  for (const stateDir of ["/st,ate", '/st"ate']) {
    const { findings, runner } = await findingsFor(healthy(), host({ stateDir }, { [stateDir]: dir }));
    const f = get(findings, "state.visible");
    assert.equal(f.severity, "info");
    assert.match(f.message, /cannot be probed/);
    assert.equal(
      runner.calls.some((c) => c.args.includes("ls")),
      false,
    );
  }
  const colon = await findingsFor(healthy(), host({ stateDir: "/st:ate" }, { "/st:ate": dir }));
  assert.ok(colon.runner.calls.some((c) => c.args.includes("type=bind,src=/st:ate,dst=/pomtreed-state-probe,readonly")));
});

test("firewall: ufw active warns on linux; not probed elsewhere", async () => {
  const active = get((await findingsFor({ ...healthy(), "systemctl is-active ufw": ok("active\n") })).findings, "firewall.ufw");
  assert.equal(active.severity, "warn");
  assert.equal(active.step, "firewall");
  assert.equal(active.needsRoot, true);
  const { findings, runner } = await findingsFor(healthy(), host({ platform: "darwin" }));
  assert.equal(
    findings.some((f) => f.id === "firewall.ufw"),
    false,
  );
  assert.equal(
    runner.calls.some((c) => c.command === "systemctl"),
    false,
  );
});

test("repo: no commit and not a repo are errors with target-repo", async () => {
  const none = { ...healthy(), "git -C /repo rev-parse --verify -q HEAD": fail(1), "git -C /repo rev-parse --git-dir": ok(".git") };
  assert.match(get((await findingsFor(none)).findings, "repo.commit").message, /no commit/);
  const notGit = get((await findingsFor({ ...none, "git -C /repo rev-parse --git-dir": fail(128) })).findings, "repo.commit");
  assert.match(notGit.message, /not a git repository/);
  assert.equal(notGit.step, "target-repo");
});

test("key file: only stat'ed (never opened); missing, loose mode and foreign owner are errors, a 0600 own file is ok", async () => {
  const check = async (stat: FileStat | undefined) =>
    get((await findingsFor(healthy(), host({ keyFile: "/k" }, { "/state": dir, ...(stat && { "/k": stat }) }))).findings, "keyfile.mode");
  assert.match((await check(undefined)).message, /does not exist/);
  assert.match((await check({ mode: 0o100644, uid: 1000, isDirectory: false })).message, /chmod 600/);
  assert.match((await check({ mode: 0o100600, uid: 0, isDirectory: false })).message, /owned by uid 0/);
  const good = await check({ mode: 0o100600, uid: 1000, isDirectory: false });
  assert.equal(good.severity, "ok");
  assert.equal(
    (await findingsFor(healthy())).findings.some((f) => f.id === "keyfile.mode"),
    false,
  );
});

test("needsRoot and network on a finding come from its step", async () => {
  const s = healthy();
  delete s["git --version"];
  const f = get((await findingsFor(s)).findings, "git.version");
  const step = steps.find((x) => x.id === "install-git");
  assert.equal(f.needsRoot, step?.needsRoot ?? false);
  assert.equal(f.network, step?.network ?? false);
});

test("runPreflight: exit 1 on an error with text lines; exit 0 and JSON when healthy; exit 2 on a usage error", async () => {
  const mk = (script: Record<string, ProbeResult>) => ({ runner: new FakeProbeRunner(script), steps, host: host() });
  const s = healthy();
  delete s["git --version"];
  const bad = await runPreflight([], mk(s));
  assert.equal(bad.code, 1);
  assert.ok(bad.lines.some((l) => l.startsWith("[error] git.version:")));
  assert.ok(bad.lines.some((l) => l.includes("fix (install-git)")));
  const good = await runPreflight(["--json"], mk(healthy()));
  assert.equal(good.code, 0);
  assert.equal(JSON.parse(good.lines[0] as string).ok, true);
  const badJson = JSON.parse((await runPreflight(["--json"], mk(s))).lines[0] as string);
  assert.equal(badJson.ok, false);
  assert.equal(badJson.findings.find((f: { id: string }) => f.id === "git.version").fix.step, "install-git");
  const usage = await runPreflight(["--nope"], mk(healthy()));
  assert.equal(usage.code, 2);
  assert.match(usage.lines[0] as string, /unknown option --nope/);
});

test("runPreflight: command flags are marked in the text fix hint", async () => {
  const s = healthy();
  delete s["git --version"];
  const r = await runPreflight([], {
    runner: new FakeProbeRunner(s),
    steps: [...steps.map((x) => (x.id === "install-git" ? { ...x, commands: [{ run: "sudo apt install git", needsRoot: true, network: true }] } : x))],
    host: host(),
  });
  assert.ok(r.lines.includes("    (run as root yourself) (needs network) sudo apt install git"));
});

test("pnpm is probed from the checkout with downloads disabled; no other probe runs with a cwd; the negative control is a probe without them", async () => {
  const { runner } = await findingsFor(healthy());
  const pnpm = runner.calls.find((c) => c.command === "pnpm");
  assert.equal(pnpm?.cwd, "/checkout", "from the checkout, so the target repo's packageManager never picks what runs");
  assert.deepEqual(pnpm?.env, PNPM_PROBE_ENV);
  assert.equal(PNPM_PROBE_ENV.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(PNPM_PROBE_ENV.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0");
  assert.ok(runner.calls.filter((c) => c.command !== "pnpm").every((c) => c.cwd === undefined && c.env === undefined));
});

test("pnpm on PATH that gives no version offline is a warning that preflight did not download it; not on PATH stays an error", async () => {
  const unresolved = get((await findingsFor({ ...healthy(), "pnpm --version": fail(1, "network access disabled") })).findings, "pnpm.version");
  assert.equal(unresolved.severity, "warn");
  assert.match(unresolved.message, /never downloads it/);
  assert.equal(unresolved.step, "enable-pnpm");
  const s = healthy();
  delete s["pnpm --version"];
  assert.equal(get((await findingsFor(s)).findings, "pnpm.version").severity, "error");
});

// A runner that refuses the pnpm spawn with an errno code (as Node >= 26 throws for ENOEXEC), delegating the rest to the fake.
const refusingPnpm = (code: string): ProbeRunner => {
  const inner = new FakeProbeRunner(healthy());
  return {
    run(command, args, opts) {
      if (command !== "pnpm") return inner.run(command, args, opts);
      return Promise.reject(Object.assign(new Error(`spawn pnpm ${code}`), { code }));
    },
  };
};

for (const code of ["EACCES", "ENOEXEC"]) {
  test(`pnpm spawn refused with ${code} names the code and is not reported as not on PATH`, async () => {
    const f = get(evaluateObservations(await gatherObservations(host(), refusingPnpm(code)), steps), "pnpm.version");
    assert.equal(f.severity, "error");
    assert.ok(f.message.includes(code));
    assert.match(f.message, /exists but could not be run/);
    assert.match(f.message, /ls -l/);
    assert.doesNotMatch(f.message, /not on PATH/);
    assert.equal(f.step, "enable-pnpm");
  });
}

test("pnpm spawn refused with ENOENT is still reported as not on PATH (negative control)", async () => {
  const f = get(evaluateObservations(await gatherObservations(host(), refusingPnpm("ENOENT")), steps), "pnpm.version");
  assert.equal(f.severity, "error");
  assert.match(f.message, /pnpm is not on PATH/);
});

test("repo: without --repo nothing is checked and no cwd default is used; the checkout, a dir inside it, or a repo holding it is refused", async () => {
  const unset = await findingsFor(healthy(), host({ repoDir: undefined }));
  const f = get(unset.findings, "repo.commit");
  assert.equal(f.severity, "info");
  assert.match(f.message, /pass --repo/);
  assert.ok(!unset.runner.calls.some((c) => c.args.includes("rev-parse") && c.args.includes("HEAD") && c.args[1] !== "/checkout"));
  for (const repoDir of ["/checkout", "/checkout/sub", "/"]) {
    const r = await findingsFor(healthy(), host({ repoDir }));
    const refused = get(r.findings, "repo.commit");
    assert.equal(refused.severity, "error", repoDir);
    assert.match(refused.message, /checkout/);
    assert.ok(!r.runner.calls.some((c) => c.args[0] === "-C" && c.args[1] === repoDir && c.args.includes("--verify")), "git is not run in it");
  }
  // the comparison is by realpath: a link to the checkout is the checkout
  const linked = await findingsFor(healthy(), host({ repoDir: "/link", realpath: (p) => (p === "/link" ? "/checkout" : p) }));
  assert.equal(get(linked.findings, "repo.commit").severity, "error");
  // negative control: a sibling directory whose name merely starts with the checkout's is a real target
  const sibling = { ...healthy(), "git -C /checkout-other rev-parse --verify -q HEAD": ok("sha") };
  assert.equal(get((await findingsFor(sibling, host({ repoDir: "/checkout-other" }))).findings, "repo.commit").severity, "ok");
});

test("runPreflight: --repo reaches the probe; a relative --repo is a usage error", async () => {
  const runner = new FakeProbeRunner({ ...healthy(), "git -C /target rev-parse --verify -q HEAD": ok("sha") });
  const r = await runPreflight(["--json", "--repo", "/target"], { runner, steps, host: host({ repoDir: undefined }) });
  assert.equal(get(JSON.parse(r.lines[0] as string).findings, "repo.commit").severity, "ok");
  const rel = await runPreflight(["--repo", "target"], { runner, steps, host: host({ repoDir: undefined }) });
  assert.equal(rel.code, 2);
  assert.match(rel.lines[0] as string, /--repo target must be an absolute path/);
});
