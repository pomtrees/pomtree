import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { buildRunArgs, DEFAULT_CONTAINER_CPUS, describeRunHardening } from "./args.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const spec: SandboxSpec = { host: "host-test", generation: 0, agent: "ag1", image: "img@sha256:abc", env: {}, mounts: [wsMount("/work")], cmd: ["pi"] };

async function cpusFlag(s: SandboxSpec): Promise<string> {
  const provider = stubMounts("/host/private/ws");
  const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
  const a = buildRunArgs("i", s, { mounts });
  return a[a.indexOf("--cpus") + 1]!;
}

test("a spec without resources.cpus gets DEFAULT_CONTAINER_CPUS as --cpus (2)", async () => {
  assert.equal(DEFAULT_CONTAINER_CPUS, 2);
  assert.equal(await cpusFlag(spec), String(DEFAULT_CONTAINER_CPUS));
  assert.equal(describeRunHardening(spec).cpus, DEFAULT_CONTAINER_CPUS);
  assert.equal(await cpusFlag({ ...spec, resources: { cpus: 1 } }), "1");
});
