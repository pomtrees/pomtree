import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { buildEgressProxyArgs, buildRunArgs, describeRunHardening, PODMAN_USERNS } from "./args.ts";
import { DOCKER_PROFILE, PODMAN_PROFILE } from "./engine-profile.ts";
import { ICC_OPTION, EGRESS_NETWORK } from "./network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const base: SandboxSpec = {
  host: "host-test",
  generation: 0,
  agent: "ag1",
  image: "img@sha256:abc",
  env: { A: "1" },
  mounts: [wsMount("/work"), { kind: "bind", hostPath: "/ro", containerPath: "/ro", readOnly: true }],
  cmd: ["pi"],
};
const egressSpec: SandboxSpec = { ...base, egress: { allow: [{ host: "pypi.org" }] } };

async function build(s: SandboxSpec, profile?: Parameters<typeof buildRunArgs>[3], relabel?: boolean): Promise<string[]> {
  const provider = stubMounts("/h");
  const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
  return buildRunArgs("i", s, { mounts, ...(relabel !== undefined ? { selinuxRelabel: relabel } : {}) }, profile);
}
const sidecarOpts = { uid: 501, network: EGRESS_NETWORK, hostAddresses: ["10.0.0.5"], image: "img", config: { allow: [], relay: [] } };
const flags = (argv: string[]) => argv.slice(0, argv.indexOf("--"));

// Options and values that exist only on Docker (or its shared bridge network), so a Podman argv must never carry them.
const DOCKER_ONLY = [ICC_OPTION, "com.docker.network.bridge", "idmap", "--storage-opt"];
function assertNoDockerOnly(argv: string[]): void {
  for (const bad of DOCKER_ONLY) assert.ok(!argv.some((x) => x.includes(bad)), `Docker-only option in podman argv: ${bad}`);
  assert.ok(!argv.includes(EGRESS_NETWORK), `Docker-only option in podman argv: shared network ${EGRESS_NETWORK}`);
}

test("podman worker without egress: keep-id, no add-host (Podman supplies both host aliases), no Docker-only option", async () => {
  const a = await build(base, PODMAN_PROFILE);
  assert.equal(PODMAN_USERNS, "keep-id:uid=1000,gid=1000");
  assert.equal(a[a.indexOf("--user") + 2], `--userns=${PODMAN_USERNS}`);
  assert.ok(!a.includes("--add-host"));
  assertNoDockerOnly(a);
  assert.ok(!describeRunHardening(base, {}, PODMAN_PROFILE).hostGateway);
});

test("podman worker with egress: network none and the socket volume as on Docker, plus keep-id", async () => {
  const a = await build(egressSpec, PODMAN_PROFILE);
  assert.ok(a.includes(`--userns=${PODMAN_USERNS}`));
  assert.deepEqual(a.slice(a.indexOf("--network"), a.indexOf("--network") + 4), [
    "--network",
    "none",
    "--mount",
    "type=volume,source=pomtree-egress-socket-i,target=/run/pomtree-egress,readonly",
  ]);
  assertNoDockerOnly(a);
});

test("podman sidecar: own pasta network instead of the shared ICC-off network, keep-id, no add-host", () => {
  const a = buildEgressProxyArgs("i", egressSpec, sidecarOpts, PODMAN_PROFILE);
  const f = flags(a);
  assert.equal(f[f.indexOf("--network") + 1], "pasta");
  assert.ok(f.includes(`--userns=${PODMAN_USERNS}`));
  assert.ok(!f.includes("--add-host"));
  assert.equal(f[f.indexOf("--user") + 1], "501:1000");
  for (const kept of ["--cap-drop=ALL", "no-new-privileges", "--read-only", "--pids-limit"]) assert.ok(f.includes(kept), kept);
  assertNoDockerOnly(a);
  assert.equal(describeRunHardening(egressSpec, {}, PODMAN_PROFILE).sidecarNetwork, "pasta");
});

test("podman hardening description names the userns and no extra drift: the shared policy is unchanged", () => {
  const p = describeRunHardening(egressSpec, {}, PODMAN_PROFILE);
  const d = describeRunHardening(egressSpec);
  const { userns, sidecarNetwork, ...rest } = p;
  const { sidecarNetwork: dNet, ...dRest } = d;
  assert.equal(userns, PODMAN_USERNS);
  assert.deepEqual(rest, dRest);
  assert.equal(dNet, "shared-icc-off");
  assert.equal(sidecarNetwork, "pasta");
  assert.equal("userns" in d, false);
});

test("selinux relabel adds relabel=shared to read-only bind mounts only (workspace stays writable and unlabeled)", async () => {
  const a = await build(base, PODMAN_PROFILE, true);
  assert.ok(a.includes("type=bind,source=/ro,target=/ro,readonly,relabel=shared"));
  assert.ok(a.includes("type=bind,source=/h,target=/work"));
  assert.ok(!(await build(base, PODMAN_PROFILE)).some((x) => x.includes("relabel")));
  const s = buildEgressProxyArgs("i", egressSpec, { ...sidecarOpts, spool: { configDir: "/cfg", logDir: "/log" }, selinuxRelabel: true }, PODMAN_PROFILE);
  assert.ok(s.includes("type=bind,source=/cfg,target=/etc/pomtree-egress,readonly,relabel=shared"));
  assert.ok(s.includes("type=bind,source=/log,target=/var/log/pomtree-egress"));
});

test("negative: selinuxRelabel on the docker engine is refused naming the cause and the action", async () => {
  await assert.rejects(build(base, undefined, true), /Podman mount option.*docker engine rejects it.*drop selinuxRelabel or select the podman engine/);
  await assert.rejects(build(base, DOCKER_PROFILE, true), /selinuxRelabel/);
  assert.throws(
    () => buildEgressProxyArgs("i", egressSpec, { ...sidecarOpts, spool: { configDir: "/c", logDir: "/l" }, selinuxRelabel: true }),
    /selinuxRelabel/,
  );
});

test("docker profile and absent profile give identical argv, with none of the podman deltas", async () => {
  for (const s of [base, egressSpec, { ...egressSpec, env: { PTREE_BROWSER: "1" } }, { ...base, tty: { cols: 80, rows: 24 } }]) {
    const none = await build(s);
    assert.deepEqual(await build(s, DOCKER_PROFILE), none);
    assert.ok(!none.some((x) => x.startsWith("--userns") || x.includes("relabel") || x === "pasta"));
  }
  assert.deepEqual(buildEgressProxyArgs("i", egressSpec, sidecarOpts, DOCKER_PROFILE), buildEgressProxyArgs("i", egressSpec, sidecarOpts));
  const dock = buildEgressProxyArgs("i", egressSpec, sidecarOpts);
  assert.equal(dock[dock.indexOf("--network") + 1], EGRESS_NETWORK);
  assert.ok(dock.includes("host.docker.internal:host-gateway"));
});

test("negative control: the Docker-only check catches a Docker-only option", () => {
  assert.throws(() => assertNoDockerOnly(["run", "--opt", ICC_OPTION]), /Docker-only option/);
  assert.throws(() => assertNoDockerOnly(["--userns=keep-id", "idmap"]), /Docker-only option/);
});

test("the podman path still enforces the shared sandbox floor", async () => {
  await assert.rejects(build({ ...base, runtime: { user: "0:0" } }, PODMAN_PROFILE), /below the sandbox floor/);
  await assert.rejects(build({ ...egressSpec, runtime: { user: "1000:1001" } }, PODMAN_PROFILE), /egress socket/);
});
