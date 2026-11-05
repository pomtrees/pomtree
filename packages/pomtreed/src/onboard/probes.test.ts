import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeProbeRunner } from "@pomtree/testing";
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
  assert.equal(o.docker.version, null);
  assert.equal(o.repo, "unset");
  assert.equal(o.host, host);
});
