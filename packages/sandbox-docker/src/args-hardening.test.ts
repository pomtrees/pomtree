import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { buildEgressProxyArgs, buildRunArgs, describeRunHardening, type RunHardening } from "./args.ts";
import { EGRESS_NETWORK } from "./network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

const base: SandboxSpec = {
  agent: "ag1",
  image: "img@sha256:abc",
  env: { SECRET: "s3cret" },
  mounts: [wsMount("/work")],
  cmd: ["pi", "--prompt", "private prompt"],
};

async function build(s: SandboxSpec, pidsLimit?: number): Promise<string[]> {
  const provider = stubMounts("/host/private/ws");
  const mounts = await Promise.all(s.mounts.map((m) => provider.resolve(s.agent, m)));
  return buildRunArgs("i", s, { mounts, ...(pidsLimit !== undefined ? { pidsLimit } : {}) });
}
const sidecar = (s: SandboxSpec, network = EGRESS_NETWORK) =>
  s.egress ? buildEgressProxyArgs("i", s, { uid: 501, network, hostAddresses: ["10.0.0.5"], image: "img", config: { allow: [], relay: [] } }) : undefined;

// Independent reader of the argv: recovers the hardening from the flags alone (the part of argv before the `--` image separator).
// The sidecar's argv contributes only its network: the shared egress network by name (ensureEgressNetwork vouches for ICC off).
function parseHardening(argv: string[], sidecarArgv?: string[]): RunHardening {
  const sidecarNet = sidecarArgv?.[sidecarArgv.indexOf("--network") + 1];
  const a = argv.slice(0, argv.indexOf("--"));
  const val = (flag: string) => {
    const i = a.indexOf(flag);
    return i < 0 ? undefined : a[i + 1];
  };
  const secOpts = a.flatMap((x, i) => (x === "--security-opt" ? [a[i + 1]!] : []));
  const shm = a.find((x) => x.startsWith("--shm-size="));
  return {
    networkMode: val("--network") === "none" ? "none" : "default",
    user: val("--user")!,
    capDrop: a.filter((x) => x.startsWith("--cap-drop=")).map((x) => x.slice("--cap-drop=".length)),
    noNewPrivileges: secOpts.includes("no-new-privileges"),
    seccomp: secOpts.some((o) => o.startsWith("seccomp=")) ? "chromium" : "docker-default",
    readOnlyRootfs: a.includes("--read-only"),
    init: a.includes("--init"),
    pidsLimit: Number(val("--pids-limit")),
    memoryBytes: Number(val("--memory")),
    memorySwapBytes: Number(val("--memory-swap")),
    cpus: Number(val("--cpus")),
    ...(shm ? { shmBytes: Number(shm.slice("--shm-size=".length)) } : {}),
    stopTimeoutSeconds: Number(val("--stop-timeout")),
    ipv6Disabled: a.includes("net.ipv6.conf.all.disable_ipv6=1"),
    hostGateway: a.includes("--add-host"),
    ...(a.includes("--runtime=runsc") ? { ociRuntime: "runsc" as const } : {}),
    ...(sidecarArgv?.includes("--network") && sidecarNet === EGRESS_NETWORK ? { sidecarNetwork: "shared-icc-off" as const } : {}),
  };
}

const variants: [string, SandboxSpec, number?][] = [
  ["plain code worker", base],
  ["egress (network none)", { ...base, egress: { allow: [{ host: "pypi.org" }] } }],
  [
    "audited public + browser + shm + resources",
    {
      ...base,
      env: { PTREE_BROWSER: "1" },
      egress: { allow: [], auditedPublic: {} } as never,
      resources: { cpus: 4, memoryBytes: 1024 ** 3, shmBytes: 256 * 1024 ** 2 },
    },
  ],
  ["pids override", base, 64],
  ["gVisor browser worker with egress", { ...base, env: { PTREE_BROWSER: "1" }, egress: { allow: [] }, runtime: { ociRuntime: "runsc" } }],
];

for (const [name, s, pids] of variants) {
  test(`describeRunHardening agrees with the built argv: ${name}`, async () => {
    assert.deepEqual(parseHardening(await build(s, pids), sidecar(s)), describeRunHardening(s, pids !== undefined ? { pidsLimit: pids } : {}));
  });
}

test("realized values: code worker is hardened, browser worker names the chromium seccomp profile", () => {
  const h = describeRunHardening({ ...base, egress: { allow: [] } });
  assert.deepEqual(
    [h.networkMode, h.user, h.capDrop, h.noNewPrivileges, h.readOnlyRootfs, h.seccomp, h.memorySwapBytes === h.memoryBytes],
    ["none", "1000:1000", ["ALL"], true, true, "docker-default", true],
  );
  assert.equal(describeRunHardening({ ...base, env: { PTREE_BROWSER: "1" } }).seccomp, "chromium");
});

test("description is content-free: no host paths, env values, cmd, or seccomp file path", () => {
  const json = JSON.stringify(describeRunHardening({ ...base, env: { SECRET: "s3cret", PTREE_BROWSER: "1" } }));
  for (const leak of ["s3cret", "/host/private", "private prompt", "chromium.json", "/"]) assert.ok(!json.includes(leak), leak);
});

test("negative: argv drift from the description is detected", async () => {
  const s: SandboxSpec = { ...base, egress: { allow: [] } };
  const want = describeRunHardening(s);
  const argv = await build(s);
  const without = (pred: (x: string, i: number, a: string[]) => boolean) => argv.filter((x, i, a) => !pred(x, i, a));
  const drifts: Record<string, string[]> = {
    "cap-drop removed": without((x) => x === "--cap-drop=ALL"),
    "no-new-privileges removed": without((x, i, a) => x === "no-new-privileges" || a[i + 1] === "no-new-privileges"),
    "read-only removed": without((x) => x === "--read-only"),
    "network flag removed": without((x, i, a) => x === "--network" || a[i - 1] === "--network"),
    "user changed": argv.map((x, i, a) => (a[i - 1] === "--user" ? "0:0" : x)),
  };
  for (const [name, bad] of Object.entries(drifts)) assert.notDeepEqual(parseHardening(bad, sidecar(s)), want, name);
  assert.deepEqual(parseHardening(argv, sidecar(s)), want);
  // The sidecar on the default bridge (the pre-ICC-off realization) or with no --network flag is drift too.
  assert.notDeepEqual(parseHardening(argv, sidecar(s, "bridge")), want, "sidecar on default bridge");
  const noNet = sidecar(s)!.filter((x, i, a) => x !== "--network" && a[i - 1] !== "--network");
  assert.notDeepEqual(parseHardening(argv, noNet), want, "sidecar network flag removed");
});

test("sidecar realization: shared ICC-off network named only when there is an egress spec; argv keeps its hardening", () => {
  assert.equal(describeRunHardening(base).sidecarNetwork, undefined);
  assert.equal(describeRunHardening({ ...base, egress: { allow: [] } }).sidecarNetwork, "shared-icc-off");
  assert.throws(
    () => buildEgressProxyArgs("i", base, { uid: 501, network: EGRESS_NETWORK, hostAddresses: [], image: "img", config: { allow: [], relay: [] } }),
    /egress spec/,
  );
  const a = sidecar({ ...base, egress: { allow: [] } })!;
  const flags = a.slice(0, a.indexOf("--"));
  for (const f of ["--cap-drop=ALL", "no-new-privileges", "--read-only"]) assert.ok(flags.includes(f), f);
  assert.equal(flags[flags.indexOf("--network") + 1], EGRESS_NETWORK);
  assert.equal(flags[flags.indexOf("--user") + 1], "501:1000");
  assert.ok(!flags.includes("bridge"));
});
