import assert from "node:assert/strict";
import test from "node:test";
import { SandboxUnavailableError } from "@pomtree/core";
import { DockerSandbox, type Exec, type ExecFileFn } from "./docker.ts";
import { EngineMismatchError, type EngineProbes, type PingInfo, type VersionInfo } from "./engine-detect.ts";
import { DOCKER_PROFILE, PODMAN_PROFILE } from "./engine-profile.ts";
import { gatewayInspectArgs, hostGatewayArgs, legacyContainerBootCheck, openLocalEngine } from "./local-engine.ts";
import { scriptedLocalEngine } from "./local-engine-fake.ts";
import { stubMounts } from "./test-mounts.ts";

const DOCKER = { ping: { headers: { "api-version": "1.51" } } as PingInfo, version: { Components: [{ Name: "Engine" }] } as VersionInfo };
const PODMAN = {
  ping: { headers: { "libpod-api-version": "6.2.0" } } as PingInfo,
  version: { Components: [{ Name: "Podman Engine" }] } as VersionInfo,
};
const SOCK = { docker: "/sockets/docker.sock", podman: "/sockets/podman.sock" } as const;

// Engines keyed by socket path; a socket with no entry does not answer.
function probes(engines: Record<string, typeof DOCKER>): EngineProbes {
  const at = (s: string) => {
    const e = engines[s];
    if (!e) throw new Error(`connect ENOENT ${s}`);
    return e;
  };
  return { cliView: async () => undefined, exists: () => false, ping: async (s) => at(s).ping, version: async (s) => at(s).version };
}

test("openLocalEngine: docker by default; the resolved socket reaches every CLI call through DOCKER_HOST", async () => {
  const fake = scriptedLocalEngine();
  const engine = await openLocalEngine({
    env: { DOCKER_HOST: `unix://${SOCK.docker}` },
    probes: probes({ [SOCK.docker]: DOCKER }),
    exec: { run: (_f, a, o) => fake.run(a, o).then((r) => ({ ...r, stdout: JSON.stringify(o.env) })), runSync: () => ({ code: 0, stdout: "", stderr: "" }) },
  });
  assert.equal(engine.id, "docker");
  assert.equal(engine.binary, "docker");
  assert.equal(engine.displayName, "Docker");
  assert.equal(engine.socket?.path, SOCK.docker);
  assert.deepEqual(engine.findings, []);
  assert.deepEqual(JSON.parse((await engine.run(["info"], { timeoutMs: 1 })).stdout), { DOCKER_HOST: `unix://${SOCK.docker}` });
  assert.deepEqual(engine.sandboxDeps(), { profile: DOCKER_PROFILE, socket: SOCK.docker });
});

test("openLocalEngine: an explicit engine that does not answer is not fatal; no socket is passed and the cause is a finding", async () => {
  const engine = await openLocalEngine({ env: { DOCKER_HOST: `unix://${SOCK.docker}` }, probes: probes({}) });
  assert.equal(engine.socket, undefined);
  assert.deepEqual(engine.sandboxDeps(), { profile: DOCKER_PROFILE }, "the adapter keeps the CLI's own default, as before detection");
  assert.equal(engine.findings.length, 1);
  assert.match(engine.findings[0]!, /the docker engine does not answer on \/sockets\/docker\.sock .*sandbox calls fail until the docker engine answers/);
});

test("openLocalEngine: an engine that answers as another id, a remote socket and auto finding nothing all refuse", async () => {
  await assert.rejects(openLocalEngine({ env: { DOCKER_HOST: `unix://${SOCK.docker}` }, probes: probes({ [SOCK.docker]: PODMAN }) }), EngineMismatchError);
  await assert.rejects(openLocalEngine({ env: { DOCKER_HOST: "tcp://10.0.0.1:2375" }, probes: probes({}) }), /not a local unix socket/);
  await assert.rejects(openLocalEngine({ selection: "auto", env: {}, probes: probes({}) }), /no local container engine answered/);
});

test("openLocalEngine: auto keeps the refusal it skipped as a finding (a remote DOCKER_HOST never silently becomes Podman)", async () => {
  const engine = await openLocalEngine({
    selection: "auto",
    env: { DOCKER_HOST: "tcp://10.0.0.1:2375", CONTAINER_HOST: `unix://${SOCK.podman}` },
    probes: probes({ [SOCK.podman]: PODMAN }),
  });
  assert.equal(engine.id, "podman");
  assert.equal(engine.binary, "podman");
  assert.ok(
    engine.findings.some((f) => /skipped docker: .*not a local unix socket/.test(f)),
    engine.findings.join("\n"),
  );
});

test("podman: the binary, the socket variable and the gateway read are Podman's; no --add-host (Podman adds the alias itself)", async () => {
  const fake = scriptedLocalEngine({ profile: PODMAN_PROFILE, socket: { path: SOCK.podman, source: "env", via: "CONTAINER_HOST" } });
  fake.script("network inspect podman -f {{(index .Subnets 0).Gateway}}", { stdout: "10.88.0.1\n" });
  assert.equal(await fake.output(gatewayInspectArgs(PODMAN_PROFILE), { timeoutMs: 5000 }), "10.88.0.1\n");
  assert.deepEqual(fake.calls, [
    { file: "podman", args: gatewayInspectArgs(PODMAN_PROFILE), timeoutMs: 5000, env: { CONTAINER_HOST: `unix://${SOCK.podman}` }, sync: false },
  ]);
  assert.deepEqual(gatewayInspectArgs(DOCKER_PROFILE), ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"]);
  assert.deepEqual(hostGatewayArgs(PODMAN_PROFILE), []);
  assert.deepEqual(hostGatewayArgs(DOCKER_PROFILE), ["--add-host", "host.docker.internal:host-gateway"]);
  const docker = scriptedLocalEngine();
  await docker.run(["info"], { timeoutMs: 1 });
  assert.equal(docker.calls[0]?.env, undefined, "no socket: the CLI runs on its own default");
});

test("imageLabel: the label value, or undefined for <no value>, an empty label or an absent image; output rejects on failure", async () => {
  const fake = scriptedLocalEngine();
  fake.script('image inspect --format {{ index .Config.Labels "rev" }} img:1', { stdout: "abc1234\n" });
  fake.script('image inspect --format {{ index .Config.Labels "rev" }} img:2', { stdout: "<no value>\n" });
  assert.equal(fake.imageLabel("img:1", "rev"), "abc1234");
  assert.equal(fake.imageLabel("img:2", "rev"), undefined);
  assert.equal(fake.imageLabel("img:3", "rev"), undefined);
  assert.ok(fake.calls.every((c) => c.sync && c.file === "docker"));
  await assert.rejects(fake.output(["info"], { timeoutMs: 1 }), /^Error: docker info exited 1: unscripted call/);
  assert.equal(fake.normalizeImageId("d".repeat(64)), undefined, "Docker never prints a bare id");
  assert.equal(scriptedLocalEngine({ profile: PODMAN_PROFILE }).normalizeImageId("d".repeat(64)), `sha256:${"d".repeat(64)}`);
});

// A DockerSandbox over a recording exec: two pomtree containers, one without the host and generation labels.
function legacyEngineSandbox(profile = DOCKER_PROFILE) {
  const calls: string[][] = [];
  const rows: Record<string, Record<string, string>> = {
    aaaaaaaaaaaa: { pomtree: "1", "pomtree.sandbox": "legacy1", "pomtree.agent": "a" },
    bbbbbbbbbbbb: { pomtree: "1", "pomtree.sandbox": "current1", "pomtree.agent": "a", "pomtree.host": "h", "pomtree.generation": "1" },
  };
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args[0] === "ps") return Object.keys(rows).join("\n");
    if (args[0] === "image") return "{}";
    const row = rows[args.at(-1)!]!;
    return `${row["pomtree.sandbox"]}\ta\t${JSON.stringify(row)}\timg\trunning`;
  };
  return { calls, sandbox: new DockerSandbox({ mounts: stubMounts(), exec, profile, ...(profile.id === "podman" && { socket: SOCK.podman }) }) };
}

test("legacy boot check: refuses with the ids, the missing labels and the exact cleanup command, and deletes nothing", async () => {
  const { calls, sandbox } = legacyEngineSandbox();
  const v = await legacyContainerBootCheck(scriptedLocalEngine(), sandbox);
  assert.ok("refuse" in v, JSON.stringify(v));
  assert.match(v.refuse, /'aaaaaaaaaaaa'/);
  assert.match(v.refuse, /pomtree\.host and pomtree\.generation labels/);
  assert.match(v.refuse, /run `docker rm -f 'aaaaaaaaaaaa'`/);
  assert.ok(!v.refuse.includes("bbbbbbbbbbbb"));
  assert.ok(calls.length > 0);
  assert.ok(
    calls.every((a) => a[0] === "ps" || a[0] === "inspect" || (a[0] === "image" && a[1] === "inspect")),
    `only read-only calls: ${JSON.stringify(calls)}`,
  );
});

test("legacy boot check: the podman engine names podman in the cleanup command", async () => {
  const { sandbox } = legacyEngineSandbox(PODMAN_PROFILE);
  const v = await legacyContainerBootCheck(scriptedLocalEngine({ profile: PODMAN_PROFILE }), sandbox);
  assert.ok("refuse" in v);
  assert.match(v.refuse, /on the podman engine .*run `podman rm -f 'aaaaaaaaaaaa'`/);
  assert.doesNotMatch(v.refuse, /docker/);
});

test("legacy boot check: an unreachable engine is a skip naming the cause; a clean engine passes", async () => {
  const down = { legacyContainerRefusal: async () => Promise.reject(new SandboxUnavailableError()) };
  const v = await legacyContainerBootCheck(scriptedLocalEngine(), down);
  assert.ok("skipped" in v);
  assert.match(v.skipped, /could not check the docker engine for containers without the pomtree\.host and pomtree\.generation labels/);
  const none = { legacyContainerRefusal: async () => undefined };
  assert.deepEqual(await legacyContainerBootCheck(scriptedLocalEngine(), none), { ok: true });
});

test("a Docker socket from the CLI's context (Colima or Desktop style) reaches the CLI as DOCKER_HOST and the adapter as the same socket", async () => {
  const ctxSocket = "/home/u/.colima/default/docker.sock";
  const context = JSON.stringify([{ Name: "colima", Endpoints: { docker: { Host: `unix://${ctxSocket}`, SkipTLSVerify: false } } }]);
  const viewed: string[] = [];
  const engine = await openLocalEngine({
    env: {},
    probes: {
      ...probes({ [ctxSocket]: DOCKER }),
      cliView: async (profile) => {
        viewed.push(`${profile.binary} ${profile.cliView.args.join(" ")}`);
        return context;
      },
    },
    exec: { run: async (_f, _a, o) => ({ code: 0, stdout: JSON.stringify(o.env ?? null), stderr: "" }), runSync: () => ({ code: 0, stdout: "", stderr: "" }) },
  });
  assert.deepEqual(viewed, ["docker context inspect"]);
  assert.deepEqual(engine.socket, { path: ctxSocket, source: "cli", via: "docker context inspect" });
  assert.deepEqual(JSON.parse((await engine.run(["info"], { timeoutMs: 1 })).stdout), { DOCKER_HOST: `unix://${ctxSocket}` });
  // The adapter built from the same engine runs its CLI against that socket too.
  const seen: (string | undefined)[] = [];
  const execFile: ExecFileFn = (_file, _args, options, cb) => {
    seen.push(options.env?.DOCKER_HOST);
    cb(null, "", "");
    return undefined;
  };
  const sandbox = new DockerSandbox({ mounts: stubMounts(), execFile, ...engine.sandboxDeps() });
  await sandbox.list({ host: "h", storeId: "s", epoch: 1 } as never);
  assert.ok(seen.length > 0);
  assert.ok(
    seen.every((v) => v === `unix://${ctxSocket}`),
    JSON.stringify(seen),
  );
});
