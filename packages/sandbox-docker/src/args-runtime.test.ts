import test from "node:test";
import assert from "node:assert/strict";
import type { SandboxSpec } from "@pomtree/core";
import { buildEgressProxyArgs, buildRunArgs, CODE_DOCKER_SHAPE, describeRunHardening, parseDockerShape } from "./args.ts";
import { EGRESS_NETWORK } from "./network.ts";
import { NetSandbox } from "./test-network.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";
import type { Exec } from "./docker.ts";
import { gateBackend, gateExecFileSync, runtimeSkip } from "./docker-gate.ts";

const base: SandboxSpec = { agent: "ag1", image: "img@sha256:abc", env: {}, mounts: [wsMount("/work")] };
const runsc = (s: SandboxSpec = base): SandboxSpec => ({ ...s, runtime: { ociRuntime: "runsc" } });
const mountsFor = async (s: SandboxSpec) => Promise.all(s.mounts.map((m) => stubMounts("/host/ws").resolve(s.agent, m)));
const INFO_ARGS = ["info", "--format", "{{json .Runtimes}}"];

test("ociRuntime: default shape is runc, validated, and absent from the hardening description", () => {
  assert.equal(CODE_DOCKER_SHAPE.ociRuntime, "default");
  assert.equal(parseDockerShape(undefined).ociRuntime, "default");
  assert.equal("ociRuntime" in describeRunHardening(base), false);
  assert.equal("ociRuntime" in describeRunHardening({ ...base, runtime: { ociRuntime: "default" } }), false);
});

test("ociRuntime: unknown or mistyped values are rejected", () => {
  for (const bad of ["kata", "", 1, true, null, ["runsc"]])
    assert.throws(() => parseDockerShape({ ociRuntime: bad }), /invalid docker runtime value for ociRuntime/);
});

test("ociRuntime: runsc is described and rendered as --runtime=runsc on the worker, for any worker", async () => {
  for (const s of [runsc(), runsc({ ...base, env: { PTREE_BROWSER: "1" } })]) {
    assert.equal(describeRunHardening(s).ociRuntime, "runsc");
    assert.ok((await buildRunArgs("i", s, { mounts: await mountsFor(s) })).includes("--runtime=runsc"));
  }
});

test("ociRuntime: the default runtime renders no --runtime flag", async () => {
  assert.equal(
    (await buildRunArgs("i", base, { mounts: await mountsFor(base) })).some((a) => a.startsWith("--runtime")),
    false,
  );
});

test("ociRuntime: browser seccomp is unchanged under runsc", async () => {
  const s = runsc({ ...base, env: { PTREE_BROWSER: "1" } });
  assert.equal(describeRunHardening(s).seccomp, "chromium");
  assert.ok((await buildRunArgs("i", s, { mounts: await mountsFor(s) })).some((a) => a.startsWith("seccomp=")));
});

test("ociRuntime: the egress sidecar never inherits the runtime", () => {
  const s = runsc({ ...base, egress: { allow: [] } });
  const argv = buildEgressProxyArgs("i", s, { uid: 501, network: EGRESS_NETWORK, hostAddresses: [], image: "img", config: { allow: [], relay: [] } });
  assert.equal(
    argv.some((a) => a.includes("runtime") || a === "runsc"),
    false,
  );
});

test("ociRuntime: the hardening floor still applies alongside runsc", () => {
  assert.throws(() => parseDockerShape({ ociRuntime: "runsc", readOnlyRootfs: false }), /below the sandbox floor/);
});

function fakeExec(runtimesOut: string | Error, calls: string[][]): Exec {
  return async (args) => {
    calls.push(args);
    if (args[0] === "inspect") throw new Error("No such object");
    if (args[0] === "info") {
      if (runtimesOut instanceof Error) throw runtimesOut;
      return runtimesOut;
    }
    return "";
  };
}
const egressRunsc = runsc({ ...base, agent: "ag-rt", egress: { allow: [{ host: "pypi.org" }] } });
const isRun = (c: string[]) => c[0] === "run";

test("start: runsc present proceeds; the worker argv carries the flag and the sidecar does not; info is cached", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({ mounts: stubMounts(), exec: fakeExec('{"runc":{"path":"runc"},"runsc":{"path":"/usr/bin/runsc"}}', calls) });
  await sb.start(egressRunsc, "k-runsc-present");
  await sb.start(egressRunsc, "k-runsc-present-2");
  const runs = calls.filter(isRun);
  assert.equal(runs.length, 4);
  const worker = runs.filter((c) => c.includes("--runtime=runsc"));
  assert.equal(worker.length, 2);
  assert.ok(worker.every((c) => c[3]?.startsWith("pomtree-") && !c[3]!.startsWith("pomtree-egress-proxy-")));
  assert.equal(calls.filter((c) => c[0] === "info").length, 1, "docker info cached per instance");
  assert.deepEqual(
    calls.find((c) => c[0] === "info"),
    INFO_ARGS,
  );
});

test("start: runsc absent fails before any container or volume is created, naming cause and action", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({ mounts: stubMounts(), exec: fakeExec('{"io.containerd.runc.v2":{},"runc":{}}', calls) });
  await assert.rejects(
    sb.start(egressRunsc, "k-runsc-absent"),
    /docker runtime ociRuntime "runsc" is not available: docker info reports runtimes \[io\.containerd\.runc\.v2, runc\]; install gVisor and register it as "runsc" in the Docker daemon config \(https:\/\/gvisor\.dev\/docs\/user_guide\/install\/\), or remove runtime\.ociRuntime from the template/,
  );
  assert.equal(
    calls.some((c) => isRun(c) || (c[0] === "volume" && c[1] === "create") || c[0] === "network"),
    false,
  );
});

test("start: a failed or garbled docker info is an error and creates nothing", async () => {
  for (const out of [new Error("docker info failed: daemon down"), "not json", "null", "[]"]) {
    const calls: string[][] = [];
    const sb = new NetSandbox({ mounts: stubMounts(), exec: fakeExec(out, calls) });
    await assert.rejects(sb.start(egressRunsc, "k-runsc-info"));
    assert.equal(calls.some(isRun), false);
  }
});

test("start: a failed docker info is not cached; a later start retries it", async () => {
  const calls: string[][] = [];
  let ok = false;
  const exec: Exec = async (args, env) => {
    if (args[0] === "info" && ok) return '{"runsc":{}}';
    return fakeExec(new Error("daemon down"), calls)(args, env);
  };
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  await assert.rejects(sb.start(egressRunsc, "k-runsc-retry"));
  ok = true;
  await sb.start(egressRunsc, "k-runsc-retry");
});

test("start: the default shape never calls docker info", async () => {
  const calls: string[][] = [];
  const sb = new NetSandbox({ mounts: stubMounts(), exec: fakeExec("{}", calls) });
  await sb.start({ ...base, egress: { allow: [] } }, "k-default-rt");
  assert.equal(
    calls.some((c) => c[0] === "info"),
    false,
  );
});

// Real-Docker proof, only where gVisor is registered; skipped with an explicit reason otherwise. The gVisor probe reads Docker's
// `.Runtimes` shape, so it runs on the docker backend only.
function runscSkip(): string | false {
  const early = runtimeSkip("Docker unavailable; runsc unverified");
  if (early) return early;
  if (gateBackend() !== "docker") return `gVisor detection is only implemented for the docker backend (backend ${gateBackend()})`;
  try {
    const out = gateExecFileSync(["info", "--format", "{{json .Runtimes}}"], { timeout: 10000 });
    return Object.hasOwn(JSON.parse(out), "runsc") ? false : "docker info lists no runsc runtime; gVisor is not installed here";
  } catch {
    return "Docker unavailable; runsc unverified";
  }
}
test("docker: a runsc worker runs under gVisor", { skip: runscSkip() }, () => {
  const out = gateExecFileSync(
    ["run", "--rm", "--runtime=runsc", process.env.PTREE_AGENT_TEST_IMAGE ?? "pomtree/agent:dev", "node", "-e", "console.log('ok')"],
    { timeout: 60000 },
  );
  assert.equal(out.trim(), "ok");
});

test("start: a runtimes list lacking runsc is not cached; installing it later succeeds without restart", async () => {
  const calls: string[][] = [];
  let out = '{"runc":{}}';
  const exec: Exec = async (args, env) => (args[0] === "info" ? out : fakeExec("{}", calls)(args, env));
  const sb = new NetSandbox({ mounts: stubMounts(), exec });
  await assert.rejects(sb.start(egressRunsc, "k-runsc-late"), /is not available/);
  out = '{"runc":{},"runsc":{}}';
  await sb.start(egressRunsc, "k-runsc-late");
  assert.ok(calls.some((c) => isRun(c) && c.includes("--runtime=runsc")));
});

test("start: a wedged docker info times out with cause and action and creates nothing", async () => {
  const calls: string[][] = [];
  const exec: Exec = (args, env) => (args[0] === "info" ? new Promise<string>(() => {}) : fakeExec("{}", calls)(args, env));
  const sb = new NetSandbox({ mounts: stubMounts(), exec, startTimeoutMs: 20 });
  await assert.rejects(sb.start(egressRunsc, "k-runsc-wedged"), /docker info timed out after 20ms.*Docker daemon is responsive/);
  assert.equal(calls.some(isRun), false);
});
