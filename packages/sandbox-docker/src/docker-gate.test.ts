// Offline tests of the Docker-gate helpers (docker-gate.ts): the engine samples, runtimeSkip, and the threading of the verified engine into
// the gated suites' CLI calls and DockerSandbox. Nothing here starts a container or calls docker/podman; every engine is a scripted answer
// or a recording stub, so it runs in the normal suite.
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { DOCKER_GATE_REASONS } from "@pomtree/testing";
import { DockerSandbox } from "./docker.ts";
import type { ExecFileFn } from "./docker.ts";
import { identifyEngine, type PingInfo, type VersionInfo } from "./engine-detect.ts";
import { DOCKER_PROFILE, PODMAN_PROFILE, type EngineId } from "./engine-profile.ts";
import { engineInfoArgs, gatewayInspectArgs } from "./local-engine.ts";
import {
  checkGateEngine,
  gateCommand,
  gateExecFile,
  gateExecFileSync,
  gatePinnedImage,
  gateSandboxDeps,
  gateSpawn,
  runtimeSkip,
  type EngineLookup,
  type GateEngine,
} from "./docker-gate.ts";
import { stubMounts, wsMount } from "./test-mounts.ts";

interface EngineSample {
  engine: EngineId;
  provenance: "captured" | "inferred";
  source: string;
  socket: string;
  ping: PingInfo;
  version: VersionInfo;
}
const sample = (id: EngineId): EngineSample => JSON.parse(readFileSync(new URL(`./engine-samples/${id}.json`, import.meta.url), "utf8")) as EngineSample;

// What the lookup child process would report for an engine that answers with this sample's /_ping and /version.
function lookupOf(s: EngineSample): EngineLookup {
  return { kind: "answered", id: identifyEngine(s.ping, s.version).id, socket: s.socket };
}
// The resolver runtimeSkip takes, fed from a sample instead of a live socket.
const resolveFrom = (s: EngineSample) => (backend: EngineId) => checkGateEngine(backend, lookupOf(s));

const OPTED_IN = { PTREE_DOCKER_TESTS: "1" };

test("engine samples: each carries honest provenance and source, scrubbed content, and identifies as its own engine", () => {
  for (const id of ["docker", "podman"] as const) {
    const s = sample(id);
    assert.equal(s.engine, id);
    assert.ok(s.provenance === "captured" || s.provenance === "inferred", `${id}: provenance is captured or inferred`);
    assert.ok(s.source.length > 20, `${id}: names its source`);
    assert.equal(identifyEngine(s.ping, s.version).id, id);
    const raw = JSON.stringify({ socket: s.socket, ping: s.ping, version: s.version });
    assert.ok(!/\/(Users|home)\/|token|secret|key/i.test(raw), `${id}: no machine path or credential`);
  }
});

test("podman sample: the recorded info and gateway-inspect commands are the argv the adapter runs, and Docker's argv is not them", () => {
  const { info, gatewayInspect } = (
    JSON.parse(readFileSync(new URL("./engine-samples/podman.json", import.meta.url), "utf8")) as {
      cli: { info: { format: string; stdout: string }; gatewayInspect: { network: string; format: string; stdout: string } };
    }
  ).cli;
  assert.deepEqual(engineInfoArgs(PODMAN_PROFILE), ["info", "--format", info.format]);
  assert.match(info.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.deepEqual(gatewayInspectArgs(PODMAN_PROFILE), ["network", "inspect", gatewayInspect.network, "-f", gatewayInspect.format]);
  assert.notDeepEqual(engineInfoArgs(DOCKER_PROFILE), ["info", "--format", info.format]);
  assert.notDeepEqual(gatewayInspectArgs(DOCKER_PROFILE), ["network", "inspect", gatewayInspect.network, "-f", gatewayInspect.format]);
});

test("runtimeSkip: a sample of the requested engine opens the gate; the skip reasons are unchanged", () => {
  assert.equal(runtimeSkip(undefined, { ...OPTED_IN, PTREE_SANDBOX_BACKEND: "docker" }, resolveFrom(sample("docker"))), false);
  assert.equal(runtimeSkip(undefined, { ...OPTED_IN, PTREE_SANDBOX_BACKEND: "podman" }, resolveFrom(sample("podman"))), false);
  assert.equal(runtimeSkip(undefined, {}, resolveFrom(sample("docker"))), "PTREE_DOCKER_TESTS not set (no Docker execution)");
  assert.equal(
    runtimeSkip(undefined, { PTREE_SANDBOX_BACKEND: "podman" }, resolveFrom(sample("podman"))),
    "PTREE_DOCKER_TESTS not set (no Podman execution; backend podman)",
  );
});

test("runtimeSkip negative: a Docker sample under PTREE_SANDBOX_BACKEND=podman throws, and a Podman sample under docker throws (a failure, not a skip)", () => {
  assert.throws(
    () => runtimeSkip(undefined, { ...OPTED_IN, PTREE_SANDBOX_BACKEND: "podman" }, resolveFrom(sample("docker"))),
    /PTREE_SANDBOX_BACKEND=podman but the engine answering on \/sockets\/docker\.sock identifies itself as docker/,
  );
  assert.throws(
    () => runtimeSkip(undefined, { ...OPTED_IN }, resolveFrom(sample("podman"))),
    /PTREE_SANDBOX_BACKEND=docker but the engine answering on \/sockets\/podman\.sock identifies itself as podman/,
  );
});

test("runtimeSkip: without the opt-in it never consults an engine, so a mismatch cannot fail a default run", () => {
  let consulted = 0;
  const reason = runtimeSkip(undefined, { PTREE_SANDBOX_BACKEND: "podman" }, () => {
    consulted++;
    return "unused";
  });
  assert.match(String(reason), /PTREE_DOCKER_TESTS not set/);
  assert.equal(consulted, 0);
  assert.throws(() => runtimeSkip(undefined, { PTREE_SANDBOX_BACKEND: "podmna" }), /"podmna".*one of docker, podman/, "a typo throws even without the opt-in");
});

test("runtimeSkip: an absent engine skips, with the legacy wording for docker and a backend-naming reason for podman", () => {
  const absent = (backend: EngineId) => checkGateEngine(backend, { kind: "absent", message: "no socket" });
  assert.equal(runtimeSkip("Docker unavailable; legacy", OPTED_IN, absent), "Docker unavailable; legacy");
  assert.equal(runtimeSkip(undefined, OPTED_IN, absent), "Docker unavailable (backend docker): no socket");
  assert.equal(
    runtimeSkip("Docker unavailable; legacy", { ...OPTED_IN, PTREE_SANDBOX_BACKEND: "podman" }, absent),
    "Podman unavailable (backend podman): no socket",
  );
});

test("DOCKER_GATE_REASONS recognises every reason the gate can return, for both backends, and not a lookalike", () => {
  const reasons = [
    // docker-gate.ts optInSkip, docker and podman
    runtimeSkip(undefined, {}, resolveFrom(sample("docker"))),
    runtimeSkip(undefined, { PTREE_SANDBOX_BACKEND: "podman" }, resolveFrom(sample("podman"))),
    // checkGateEngine: absent engine, both backends
    checkGateEngine("docker", { kind: "absent", message: "no socket" }),
    checkGateEngine("podman", { kind: "absent", message: "Cannot connect to Podman" }),
    // gate() and engineGate() fixed reasons (spelled exactly as in docker-gate.ts)
    "explicit committed PTREE_AGENT_TEST_REVISION required; no old-image proof",
    "commit adapter/image checkpoint before Docker gates; untracked sources are not image proof",
    "adapter/image source differs from requested committed image revision",
    "Docker unavailable; network-none/UDS/browser confinement unverified",
    "Docker unavailable; egress network isolation unverified",
    "Podman unavailable; network-none/UDS/browser confinement unverified",
    "Podman unavailable; egress network isolation unverified",
    "rebuilt pomtree/agent:dev unavailable; this gate never pulls or builds",
    "pomtree/agent:dev unavailable; this gate never pulls or builds",
    "rebuilt pomtree/agent:dev unavailable in the podman image store; this gate never pulls or builds",
    "pomtree/agent:dev unavailable in the podman image store; this gate never pulls or builds",
    "image revision abc1234 does not match approved def5678",
    "cannot establish rebuilt image revision",
  ].map(String);
  for (const r of reasons)
    assert.ok(
      DOCKER_GATE_REASONS.some((re) => re.test(r)),
      `recognised: ${r}`,
    );
  for (const lookalike of [
    "Podman unavailable (backend podman)",
    "PTREE_DOCKER_TESTS not set (no Podman execution)",
    "PTREE_DOCKER_TESTS not set (no Docker execution) and more",
    "Docker unavailable (backend podman): no socket",
    "some other failure; this gate never pulls or builds soon",
  ])
    assert.ok(!DOCKER_GATE_REASONS.some((re) => re.test(lookalike)), `not recognised: ${lookalike}`);
});

// ---- Threading: the gated helpers run the verified engine's CLI, never a hard-coded docker ----

const SOCK = "/machine/podman-api.sock";
const podmanEngine: GateEngine = checkGateEngine("podman", lookupOf({ ...sample("podman"), socket: SOCK })) as GateEngine;
const dockerEngine: GateEngine = checkGateEngine("docker", lookupOf(sample("docker"))) as GateEngine;

interface Call {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}
function recorder(out = "ok\n") {
  const calls: Call[] = [];
  const run = ((file: string, args: readonly string[], options: ExecFileSyncOptions) => {
    calls.push({ file, args, env: options.env });
    return out;
  }) as never;
  return { calls, run };
}

test("gateExecFileSync: under a scripted podman engine it runs podman against the engine socket and never docker", () => {
  const { calls, run } = recorder();
  assert.equal(gateExecFileSync(["inspect", "x"], {}, { engine: podmanEngine, run }), "ok\n");
  gateExecFileSync(["ps"], { env: { PATH: "/bin", CONTAINER_HOST: "unix:///some/other.sock" } }, { engine: podmanEngine, run });
  assert.deepEqual(
    calls.map((c) => c.file),
    ["podman", "podman"],
  );
  assert.equal(calls[0]?.env?.CONTAINER_HOST, `unix://${SOCK}`);
  assert.equal(calls[1]?.env?.CONTAINER_HOST, `unix://${SOCK}`, "the engine's socket wins over a caller-supplied variable");
  assert.equal(calls[1]?.env?.PATH, "/bin", "the caller's other variables are kept");
  assert.ok(!calls.some((c) => c.file === "docker"));
});

test("gateExecFileSync: under a docker engine it runs docker and leaves the environment alone", () => {
  const { calls, run } = recorder();
  gateExecFileSync(["info"], {}, { engine: dockerEngine, run });
  gateExecFileSync(["info"], { env: { PATH: "/bin" } }, { engine: dockerEngine, run });
  assert.deepEqual(
    calls.map((c) => c.file),
    ["docker", "docker"],
  );
  assert.equal(calls[0]?.env, undefined);
  assert.deepEqual(calls[1]?.env, { PATH: "/bin" });
});

test("gateExecFile, gateSpawn and gatePinnedImage use the engine's binary and socket too", () => {
  const seen: Call[] = [];
  const record = (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => seen.push({ file, args, env: options.env });
  gateExecFile(["rm", "-f", "c"], { timeout: 1 }, () => {}, { engine: podmanEngine, run: ((f: string, a: string[], o: object) => record(f, a, o)) as never });
  gateSpawn(["exec", "c", "sh"], {}, { engine: podmanEngine, run: ((f: string, a: string[], o: object) => record(f, a, o)) as never });
  const { calls, run } = recorder(`sha256:${"a".repeat(64)}\n`);
  assert.equal(gatePinnedImage("pomtree/agent:gate-test", { engine: podmanEngine, run }), `sha256:${"a".repeat(64)}`);
  gatePinnedImage("pomtree/agent:gate-test", { engine: podmanEngine, run });
  assert.equal(calls.length, 1, "resolved once per name");
  for (const c of [...seen, ...calls]) {
    assert.equal(c.file, "podman");
    assert.equal(c.env?.CONTAINER_HOST, `unix://${SOCK}`);
  }
  assert.equal(seen.length, 2);
  const pinned = `pomtree/agent@sha256:${"b".repeat(64)}`;
  assert.equal(gatePinnedImage(pinned, { engine: podmanEngine, run }), pinned, "an already pinned reference makes no call");
  assert.equal(calls.length, 1);
});

test("gatePinnedImage: Podman's bare 64-hex image id is prefixed with sha256:, Docker's is unchanged, and an unrecognisable id throws", () => {
  const hex = "c".repeat(64);
  assert.equal(gatePinnedImage("pomtree/agent:bare-hex", { engine: podmanEngine, run: recorder(`${hex}\n`).run }), `sha256:${hex}`);
  assert.equal(gatePinnedImage("pomtree/agent:docker-id", { engine: dockerEngine, run: recorder(`sha256:${hex}\n`).run }), `sha256:${hex}`);
  // Docker never prints a bare id, so a bare id there is not an image id it can pin.
  assert.throws(() => gatePinnedImage("pomtree/agent:docker-bare", { engine: dockerEngine, run: recorder(`${hex}\n`).run }), /docker-bare[\s\S]*sha256/);
  assert.throws(() => gatePinnedImage("pomtree/agent:garbage", { engine: podmanEngine, run: recorder("not-an-id\n").run }), /garbage[\s\S]*sha256/);
  // A failed normalisation is not cached: the next call inspects again.
  const retry = recorder(`${hex}\n`);
  assert.equal(gatePinnedImage("pomtree/agent:garbage", { engine: podmanEngine, run: retry.run }), `sha256:${hex}`);
});

test("gateCommand: podman drops a named CONTAINER_CONNECTION that would outrank the socket; docker leaves the env alone", () => {
  const callerEnv: NodeJS.ProcessEnv = { PATH: "/bin", CONTAINER_CONNECTION: "other" };
  const p = gateCommand(["ps"], { env: callerEnv }, podmanEngine);
  assert.equal(p.options.env?.CONTAINER_CONNECTION, undefined);
  assert.equal(p.options.env?.CONTAINER_HOST, `unix://${SOCK}`);
  assert.equal(callerEnv.CONTAINER_CONNECTION, "other", "the caller's env is not mutated");
  assert.deepEqual(gateCommand(["ps"], { env: callerEnv }, dockerEngine).options.env, callerEnv);
});

test("gateCommand: the engine's socket reaches a caller env without mutating it", () => {
  const callerEnv: NodeJS.ProcessEnv = { PATH: "/bin" };
  const c = gateCommand(["ps"], { env: callerEnv }, podmanEngine);
  assert.equal(c.file, "podman");
  assert.equal(c.options.env?.CONTAINER_HOST, `unix://${SOCK}`);
  assert.deepEqual(callerEnv, { PATH: "/bin" });
});

test("gateSandboxDeps: a DockerSandbox built from a podman engine launches only podman, with the socket", async () => {
  assert.deepEqual(gateSandboxDeps(podmanEngine), { profile: PODMAN_PROFILE, socket: SOCK });
  assert.deepEqual(gateSandboxDeps(dockerEngine), { profile: DOCKER_PROFILE, socket: "/sockets/docker.sock" });
  const files: string[] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const pin = `sha256:${"c".repeat(64)}`;
  const execFile: ExecFileFn = (file, args, options, callback) => {
    files.push(file);
    envs.push(options.env);
    if (args[0] === "inspect") callback(new Error("exit 1"), "", "Error: No such object: x");
    else callback(null, args[0] === "image" ? pin : "", "");
    return undefined;
  };
  const sb = new DockerSandbox({ ...gateSandboxDeps(podmanEngine), mounts: stubMounts(), egressProxyImage: pin, execFile, warn: () => {} });
  await sb.start(
    { host: "host-test", generation: 0, agent: "ag-gate", image: "i", env: {}, mounts: [wsMount("/w")], egress: { allow: [{ host: "pypi.org" }] } },
    "k-gate-threading",
  );
  assert.ok(files.length > 3, "the start issued its calls");
  assert.deepEqual([...new Set(files)], ["podman"]);
  for (const e of envs) assert.equal(e?.CONTAINER_HOST, `unix://${SOCK}`);
});

// ---- Drift guard: the gated suites stay threaded ----

const GATED_SUITES = [
  "src/docker.test.ts",
  "src/sandbox-contract.test.ts",
  "src/result-work.test.ts",
  "src/capture-worker-wacz.test.ts",
  "src/browser-real-article.test.ts",
  "src/network-docker.test.ts",
  "src/network-podman.test.ts",
  "src/args-runtime.test.ts",
  "../e2e/src/docker-fanout.test.ts",
  "../e2e/src/docker-pi.test.ts",
  "../e2e/src/docker-proxy-path.test.ts",
  "../e2e/src/cli-scenarios-harness.ts",
  "../e2e/src/cli-crash.ts",
  "../e2e/src/cli-hold.ts",
  "../e2e/src/cli-recovery.test.ts",
  "../e2e/src/cli-credentials.test.ts",
  "../e2e/src/browser-live-run.test.ts",
  "../e2e/src/docker-browse-smoke.test.ts",
  "../harness-pi/src/pi-ext-live.test.ts",
  "../pomtreed/src/agent-net.docker.test.ts",
  "../../examples/hn-digest/content-live-smoke.test.mts",
  "../../examples/hn-digest/content-live-browser-smoke.test.mts",
  // Drivers that take the engine as an option (the gated suites pass gateSandboxDeps()): only the hard-coded binary is scanned.
  "../e2e/src/browser-live-run.ts",
  "../../examples/hn-digest/content-live-runtime.mts",
  "../../examples/hn-digest/model-runtime.mts",
].map((f) => new URL(`../${f}`, import.meta.url));
const ENGINE_OPTION_DRIVERS = new Set(["browser-live-run.ts", "content-live-runtime.mts", "model-runtime.mts"]);

// The text of each `new DockerSandbox(...)` call, to its balanced closing parenthesis.
function sandboxCalls(src: string): string[] {
  const calls: string[] = [];
  for (let at = src.indexOf("new DockerSandbox("); at !== -1; at = src.indexOf("new DockerSandbox(", at + 1)) {
    let depth = 0;
    for (let i = at + "new DockerSandbox".length; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        calls.push(src.slice(at, i + 1));
        break;
      }
    }
  }
  return calls;
}

// Violations in one source: a real DockerSandbox (no injected exec/spawn) built without the gate's engine, or a hard-coded `docker` binary.
// The exec/execFile/spawn/engine exemption is intentionally loose: a scan cannot tell a recording stub from a real runner, so any call that
// names one of those properties is trusted to be a stub. The hard-coded-binary pattern still applies to those files, and the helper tests
// above prove the real wrappers; this guard only catches the common slip of an unthreaded constructor or CLI call.
function unthreaded(src: string, driver = false): string[] {
  const found = driver
    ? []
    : sandboxCalls(src)
        .filter((c) => !/\b(exec|execFile|spawn|engine)\b\s*[:,}]/.test(c) && !c.includes("gateSandboxDeps("))
        .map((c) => `new DockerSandbox without gateSandboxDeps(): ${c.slice(0, 60)}`);
  for (const m of src.matchAll(/\w+\(\s*["']docker["']\s*,/g)) found.push(`hard-coded docker binary: ${m[0]}`);
  return found;
}

test("every gated suite builds DockerSandbox from the gate's engine and calls no hard-coded docker (negative: unthreaded sources are caught)", () => {
  for (const url of GATED_SUITES)
    assert.deepEqual(unthreaded(readFileSync(url, "utf8"), ENGINE_OPTION_DRIVERS.has(url.pathname.split("/").at(-1)!)), [], url.pathname);
  assert.equal(unthreaded('execFileSync("docker", ["info"]);', true).length, 1, "a driver may not hard-code docker either");
  assert.equal(unthreaded("const sb = new DockerSandbox({ mounts, egressNetwork });").length, 1);
  assert.equal(unthreaded('execFileSync("docker", ["info"]);').length, 1);
  assert.deepEqual(unthreaded("const sb = new DockerSandbox({ ...gateSandboxDeps(), mounts });"), []);
  assert.deepEqual(unthreaded("new DockerSandbox({ mounts, spawn })"), [], "an injected stub is not an engine");
});
