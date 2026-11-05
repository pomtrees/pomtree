import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { buildRunArgs, CODE_DOCKER_SHAPE, DEFAULT_PIDS_LIMIT, parseDockerShape } from "./args.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const spec: SandboxSpec = { agent: "ag1", image: "img@sha256:abc", env: {}, mounts: [wsMount("/work")], cmd: ["echo"] };

async function build(s: SandboxSpec, pidsLimit?: number): Promise<string[]> {
  const provider = stubMounts("/h");
  const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
  return buildRunArgs("i", s, { mounts, ...(pidsLimit !== undefined ? { pidsLimit } : {}) });
}

const TIGHTEN = "(templates may only tighten hardening)";
const refused = (field: string, value: string, action: string) =>
  new Error(`docker runtime ${field} ${value} is below the sandbox floor: ${action} ${TIGHTEN}`).message;

test("sandbox floor: each loosening runtime field is refused with its field, value and action", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ user: "0:0" }, refused("user", '"0:0"', "use a non-root numeric uid:gid")],
    [{ user: "1000:0" }, refused("user", '"1000:0"', "use a non-root numeric uid:gid")],
    [{ user: "0:1000" }, refused("user", '"0:1000"', "use a non-root numeric uid:gid")],
    [{ user: "00:1000" }, refused("user", '"00:1000"', "use a non-root numeric uid:gid")],
    [{ user: "1000" }, refused("user", '"1000"', "use a non-root numeric uid:gid")],
    [{ user: "node" }, refused("user", '"node"', "use a non-root numeric uid:gid")],
    [{ user: "node:node" }, refused("user", '"node:node"', "use a non-root numeric uid:gid")],
    [{ capDrop: [] }, refused("capDrop", "[]", 'include "ALL"')],
    [{ capDrop: ["NET_ADMIN"] }, refused("capDrop", '["NET_ADMIN"]', 'include "ALL"')],
    [{ noNewPrivileges: false }, refused("noNewPrivileges", "false", "set it to true")],
    [{ readOnlyRootfs: false }, refused("readOnlyRootfs", "false", "set it to true")],
    [{ pidsLimit: DEFAULT_PIDS_LIMIT + 1 }, refused("pidsLimit", String(DEFAULT_PIDS_LIMIT + 1), `use at most ${DEFAULT_PIDS_LIMIT}`)],
  ];
  for (const [runtime, message] of cases) assert.throws(() => parseDockerShape(runtime), { message }, JSON.stringify(runtime));
});

test("sandbox floor: a loosening template fails the run build for every egress mode", async () => {
  for (const egress of [undefined, { allow: [] }, { allow: [], relay: [], auditedPublic: { host: "h", generation: 1 } }]) {
    await assert.rejects(build({ ...spec, egress, runtime: { user: "0:0" } } as SandboxSpec), /below the sandbox floor/);
  }
});

test("sandbox floor: tightening is accepted", async () => {
  const s = parseDockerShape({ user: "2000:3000", capDrop: ["ALL", "NET_RAW"], pidsLimit: 64, noNewPrivileges: true, readOnlyRootfs: true });
  assert.deepEqual([s.user, s.capDrop, s.pidsLimit], ["2000:3000", ["ALL", "NET_RAW"], 64]);
  assert.equal(parseDockerShape({ pidsLimit: DEFAULT_PIDS_LIMIT }).pidsLimit, DEFAULT_PIDS_LIMIT);
  const a = await build({ ...spec, runtime: { user: "2000:3000", capDrop: ["ALL", "NET_RAW"], pidsLimit: 64 } });
  assert.equal(a[a.indexOf("--user") + 1], "2000:3000");
  assert.ok(a.includes("--cap-drop=ALL") && a.includes("--cap-drop=NET_RAW"));
  assert.equal(a[a.indexOf("--pids-limit") + 1], "64");
});

test("sandbox floor: the default code shape meets it, and the operator's pidsLimit knob is not a template field", async () => {
  assert.deepEqual(parseDockerShape(undefined), CODE_DOCKER_SHAPE);
  const a = await build(spec, DEFAULT_PIDS_LIMIT * 2);
  assert.equal(a[a.indexOf("--pids-limit") + 1], String(DEFAULT_PIDS_LIMIT * 2));
});
