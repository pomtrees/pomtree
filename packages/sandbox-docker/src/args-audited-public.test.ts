import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { buildEgressProxyArgs, buildRunArgs } from "./args.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

// The audited-public minimum is the sandbox floor every egress mode meets (args-floor.test.ts covers each field and egress mode).

const auditedSpec: SandboxSpec = {
  agent: "ag1",
  image: "alpine@sha256:abc",
  env: {},
  mounts: [wsMount("/work")],
  cmd: ["echo"],
  egress: { allow: [], relay: [], auditedPublic: { host: "captured-host", generation: 1 } },
};
const plainSpec: SandboxSpec = { ...auditedSpec, egress: undefined };

// Mirrors DockerSandbox.start: resolve every spec mount through the provider, then build argv.
async function build(s: SandboxSpec): Promise<string[]> {
  const provider = stubMounts("/h");
  const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
  return buildRunArgs("i", s, { mounts });
}
const withRuntime = (spec: SandboxSpec, runtime: Record<string, unknown>): SandboxSpec => ({ ...spec, runtime });

test("audited-public accepts the default code shape", async () => {
  const a = await build(auditedSpec);
  assert.ok(a.includes("--read-only"));
  assert.ok(a.includes("--cap-drop=ALL"));
  assert.ok(a.includes("no-new-privileges"));
  assert.equal(a[a.indexOf("--user") + 1], "1000:1000");
});

test("a non-root user outside the egress socket's group 1000 is refused before any start, naming the cause and the fix", async () => {
  const cause = /docker runtime user "1000:1001" cannot reach the egress socket: its gid must be 1000, .*set runtime\.user to "<uid>:1000"/;
  const sidecarOpts = { uid: 501, network: "n", hostAddresses: [], image: "img", config: { allow: [], relay: [] } };
  for (const spec of [auditedSpec, { ...auditedSpec, egress: { allow: [] } }]) {
    await assert.rejects(build(withRuntime(spec, { user: "1000:1001" })), cause);
    assert.throws(() => buildEgressProxyArgs("i", withRuntime(spec, { user: "1000:1001" }), sidecarOpts), cause);
  }
  // Another uid in group 1000 reaches the socket; without egress the group is not constrained.
  const ok = await build(withRuntime(auditedSpec, { user: "2000:1000" }));
  assert.equal(ok[ok.indexOf("--user") + 1], "2000:1000");
  const plain = await build(withRuntime(plainSpec, { user: "1000:1001" }));
  assert.equal(plain[plain.indexOf("--user") + 1], "1000:1001");
});
