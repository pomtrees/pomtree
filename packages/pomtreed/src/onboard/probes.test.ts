import assert from "node:assert/strict";
import { test } from "node:test";
import { PODMAN_PROFILE } from "@pomtree/sandbox-docker";
import { FakeProbeRunner } from "@pomtree/testing";
import { evaluateObservations } from "./findings.ts";
import { onboardingSteps } from "./steps.ts";
import { gatherObservations, type ProbeHost, type ProbeResult, type ProbeRunner } from "./probes.ts";

const ok = (stdout: string): ProbeResult => ({ code: 0, stdout, stderr: "" });
const host: ProbeHost = {
  platform: "linux",
  nodeVersion: "v24.1.0",
  uid: 1000,
  facts: { nodeRange: ">=24", pnpmVersion: "10.19.0", minGit: "2.38.0", defaultImage: "pomtree/agent:dev" },
  checkout: "/checkout",
  stateDir: "/state",
  image: "pomtree/agent:dev",
  stat: () => null,
  realpath: (p) => p,
};
const script = { "git --version": ok("git version 2.43.0\n"), "pnpm --version": ok("10.19.0\n") };

// A runner that fails (as Node >= 26 does for ENOEXEC) for the commands `bad` accepts, delegating the rest to the fake.
const failing = (bad: (cmd: string) => boolean, how: "throw" | "reject"): ProbeRunner => {
  const inner = new FakeProbeRunner(script);
  return {
    run(command, args, opts) {
      if (!bad(command)) return inner.run(command, args, opts);
      const err = new Error(`spawn ENOEXEC (${command})`);
      if (how === "throw") throw err;
      return Promise.reject(err);
    },
  };
};

for (const how of ["throw", "reject"] as const) {
  test(`gatherObservations: a runner that ${how}s for pnpm yields a null pnpm and still gathers the rest`, async () => {
    const o = await gatherObservations(
      host,
      failing((c) => c === "pnpm", how),
    );
    assert.equal(o.pnpm, null);
    assert.equal(o.pnpmUnresolved, false); // no answer is not "answered without a version"
    assert.equal(o.git, "git version 2.43.0");
  });
}

test("gatherObservations: a runner that throws for every command still resolves", async () => {
  const o = await gatherObservations(
    host,
    failing(() => true, "throw"),
  );
  assert.equal(o.git, null);
  assert.equal(o.pnpm, null);
  assert.equal(o.engine.version, null);
  assert.equal(o.repo, "unset");
  assert.equal(o.host, host);
});

test("podman engine: every engine probe runs podman (no docker, no buildx), and the findings name podman, never docker", async () => {
  const label = 'image inspect --format {{ index .Config.Labels "org.opencontainers.image.revision" }} pomtree/agent:dev';
  const runner = new FakeProbeRunner({
    ...script,
    "podman --version": ok("podman version 6.2.0\n"),
    "podman info --format {{.Version.Version}}": ok("6.2.0\n"),
    [`podman ${label}`]: ok("abc1234\n"),
  });
  const o = await gatherObservations({ ...host, engine: PODMAN_PROFILE, stat: () => ({ mode: 0o700, uid: 1000, isDirectory: true }) }, runner);
  const commands = runner.calls.map((c) => c.command);
  assert.ok(commands.includes("podman"));
  assert.ok(!commands.includes("docker"), JSON.stringify(runner.calls));
  assert.ok(!runner.calls.some((c) => c.args[0] === "buildx"));
  assert.deepEqual([o.engine.version, o.engine.daemon, o.engine.buildx, o.podman], ["podman version 6.2.0", true, null, null]);
  const findings = evaluateObservations(o, onboardingSteps({ nodeRange: ">=24", pnpmVersion: "10.19.0", minGit: "2.38.0", defaultImage: "pomtree/agent:dev" }));
  const engineText = findings.filter((f) => /^(podman|docker)\.|^image\.|^state\./.test(f.id));
  assert.ok(engineText.some((f) => f.id === "podman.cli" && f.severity === "ok"));
  assert.ok(engineText.some((f) => f.id === "podman.daemon" && f.message === "the podman daemon answers"));
  assert.ok(!findings.some((f) => f.id === "podman.runtime" || f.id.endsWith(".buildx")));
  for (const f of engineText) assert.doesNotMatch(f.message, /docker/i, f.id);
});
