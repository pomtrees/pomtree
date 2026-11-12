import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEngineMatches,
  detectLocalEngine,
  EngineMismatchError,
  identifyEngine,
  realEngineProbes,
  type EngineProbes,
  type PingInfo,
  type VersionInfo,
} from "./engine-detect.ts";
import { DOCKER_PROFILE } from "./engine-profile.ts";

// Scripted response shapes captured from a Podman 6.2 machine and a Docker Desktop 4.46 engine, with machine paths scrubbed.
const PODMAN_PING: PingInfo = {
  headers: { "api-version": "1.44", "libpod-api-version": "6.2.0", "libpod-buildah-version": "1.46.0", server: "Libpod/6.2.0 (linux)", "buildkit-version": "" },
};
const PODMAN_VERSION: VersionInfo = { Components: [{ Name: "Podman Engine" }, { Name: "OCI Runtime (crun)" }] };
const DOCKER_PING: PingInfo = { headers: { "api-version": "1.51", "buildkit-version": "v0.23.0", server: "Docker/28.4.0 (linux)" } };
const DOCKER_VERSION: VersionInfo = { Components: [{ Name: "Engine" }, { Name: "containerd" }, { Name: "runc" }] };

const SOCKETS = { docker: "/sockets/docker.sock", podman: "/sockets/podman.sock" } as const;
const ENV = { DOCKER_HOST: `unix://${SOCKETS.docker}`, CONTAINER_HOST: `unix://${SOCKETS.podman}` };

type Reply = { ping: PingInfo; version: VersionInfo } | Error;

// Scripted engines keyed by socket path; a socket with no entry (or an Error) does not answer.
function scripted(replies: Record<string, Reply>): EngineProbes & { pinged: string[] } {
  const pinged: string[] = [];
  const reply = (socket: string): Exclude<Reply, Error> => {
    const r = replies[socket];
    if (r === undefined) throw new Error(`connect ENOENT ${socket}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    pinged,
    cliView: async () => undefined,
    exists: () => false,
    ping: async (s) => {
      pinged.push(s);
      return reply(s).ping;
    },
    version: async (s) => reply(s).version,
  };
}

const dockerEngine = { ping: DOCKER_PING, version: DOCKER_VERSION };
const podmanEngine = { ping: PODMAN_PING, version: PODMAN_VERSION };

test("identifyEngine: the Libpod-Api-Version header and the Podman Engine component identify Podman", () => {
  assert.deepEqual(identifyEngine(PODMAN_PING, PODMAN_VERSION), { id: "podman", component: "Podman Engine", libpodVersion: "6.2.0" });
});

test("identifyEngine: no Libpod header and an Engine component identify Docker", () => {
  assert.deepEqual(identifyEngine(DOCKER_PING, DOCKER_VERSION), { id: "docker", component: "Engine", libpodVersion: undefined });
});

test("identifyEngine: a missing /version component list falls back to the header alone", () => {
  assert.equal(identifyEngine(PODMAN_PING, {}).id, "podman");
  assert.equal(identifyEngine(DOCKER_PING, {}).id, "docker");
});

test("identifyEngine: header and component that disagree fail loudly in both directions", () => {
  assert.throws(
    () => identifyEngine(PODMAN_PING, DOCKER_VERSION),
    /has the Libpod-Api-Version header but \/version names the first component "Engine".*not at a proxy/,
  );
  assert.throws(
    () => identifyEngine(DOCKER_PING, PODMAN_VERSION),
    /lacks the Libpod-Api-Version header but \/version names the first component "Podman Engine"/,
  );
});

test("identifyEngine: header names are matched case-insensitively", () => {
  assert.equal(identifyEngine({ headers: { "Libpod-Api-Version": "6.2.0" } }, PODMAN_VERSION).id, "podman");
});

test("identifyEngine: non-object /version JSON (null, array, string) is a clear error, not a TypeError", () => {
  for (const bad of [null, [], "x"]) {
    assert.throws(
      () => identifyEngine(DOCKER_PING, bad as unknown as VersionInfo),
      (e: unknown) => e instanceof Error && !(e instanceof TypeError) && /not an object; point the socket/.test(e.message),
    );
  }
});

test("identifyEngine: an empty Libpod header is absent, not Podman", () => {
  assert.equal(identifyEngine({ headers: { "libpod-api-version": "" } }, DOCKER_VERSION).id, "docker");
});

test("assertEngineMatches names both ids, the socket and the action", () => {
  const podman = identifyEngine(PODMAN_PING, PODMAN_VERSION);
  assert.doesNotThrow(() => assertEngineMatches("podman", podman, "/s"));
  assert.throws(
    () => assertEngineMatches("docker", podman, "/s.sock"),
    (e: unknown) =>
      e instanceof EngineMismatchError &&
      /"docker".*answering on \/s\.sock is podman; set sandbox\.backend to "podman", or point sandbox\.docker\.socket/.test(e.message),
  );
});

test("detect, explicit docker: resolves the socket, identifies, and returns the docker engine", async () => {
  const got = await detectLocalEngine({ selection: "docker", env: ENV, probes: scripted({ [SOCKETS.docker]: dockerEngine }) });
  assert.equal(got.id, "docker");
  assert.equal(got.profile, DOCKER_PROFILE);
  assert.deepEqual(got.socket, { path: SOCKETS.docker, source: "env", via: "DOCKER_HOST" });
  assert.deepEqual(got.findings, []);
});

test("detect, explicit podman: a configured socket is used and identity is read from the engine", async () => {
  const got = await detectLocalEngine({
    selection: "podman",
    env: {},
    configured: { podman: SOCKETS.podman },
    probes: scripted({ [SOCKETS.podman]: podmanEngine }),
  });
  assert.equal(got.id, "podman");
  assert.equal(got.identity.libpodVersion, "6.2.0");
  assert.equal(got.socket.source, "config");
});

test("detect: identity comes from the engine, never from the socket path", async () => {
  // A path named docker.sock that serves Podman (a podman-docker shim) must not pass as docker.
  await assert.rejects(
    detectLocalEngine({ selection: "docker", env: ENV, probes: scripted({ [SOCKETS.docker]: podmanEngine }) }),
    (e: unknown) => e instanceof EngineMismatchError && e.selected === "docker" && e.actual === "podman",
  );
  // And a path named podman.sock that serves Docker must not pass as podman.
  await assert.rejects(
    detectLocalEngine({ selection: "podman", env: ENV, probes: scripted({ [SOCKETS.podman]: dockerEngine }) }),
    (e: unknown) => e instanceof EngineMismatchError && e.selected === "podman" && e.actual === "docker",
  );
});

test("detect, explicit: an engine that does not answer fails with the cause, the socket and the action", async () => {
  await assert.rejects(
    detectLocalEngine({ selection: "docker", env: ENV, probes: scripted({}) }),
    /docker engine does not answer on \/sockets\/docker\.sock \(from DOCKER_HOST\): connect ENOENT.*start docker.*sandbox\.docker\.socket/,
  );
});

test("detect, explicit: an unresolvable socket surfaces the resolver error", async () => {
  await assert.rejects(detectLocalEngine({ selection: "podman", env: {}, probes: scripted({}) }), /no podman socket found/);
});

test("auto: only docker answers -> docker, no findings", async () => {
  const got = await detectLocalEngine({ selection: "auto", env: ENV, probes: scripted({ [SOCKETS.docker]: dockerEngine }) });
  assert.equal(got.id, "docker");
  assert.deepEqual(got.findings, []);
});

test("auto: only podman answers -> podman", async () => {
  const got = await detectLocalEngine({ selection: "auto", env: ENV, probes: scripted({ [SOCKETS.podman]: podmanEngine }) });
  assert.equal(got.id, "podman");
  assert.equal(got.socket.path, SOCKETS.podman);
});

test("auto: a docker socket that serves Podman resolves to podman, once", async () => {
  const probes = scripted({ [SOCKETS.docker]: podmanEngine, [SOCKETS.podman]: podmanEngine });
  const got = await detectLocalEngine({ selection: "auto", env: ENV, probes });
  assert.equal(got.id, "podman");
  assert.equal(got.profile.id, "podman");
  assert.deepEqual(got.findings, [], "the same engine seen through both sockets is not a second engine");
});

test("auto: both ids answer -> docker wins with an info finding naming podman", async () => {
  const got = await detectLocalEngine({ selection: "auto", env: ENV, probes: scripted({ [SOCKETS.docker]: dockerEngine, [SOCKETS.podman]: podmanEngine }) });
  assert.equal(got.id, "docker");
  assert.equal(got.findings.length, 1);
  assert.match(got.findings[0] ?? "", /both docker and podman answer; using docker \(set sandbox\.backend to "podman"/);
});

test("auto: a remote DOCKER_HOST is refused, podman answers, and the refusal reaches the operator as a finding", async () => {
  const env = { DOCKER_HOST: "tcp://prod:2375", CONTAINER_HOST: ENV.CONTAINER_HOST };
  const got = await detectLocalEngine({ selection: "auto", env, probes: scripted({ [SOCKETS.podman]: podmanEngine }) });
  assert.equal(got.id, "podman");
  assert.equal(got.findings.length, 1);
  assert.match(got.findings[0] ?? "", /skipped docker: DOCKER_HOST.*tcp:\/\/prod:2375.*not a local unix socket.*unset it/);
});

test("auto: an inconsistent identity on one id surfaces as a finding when the other answers", async () => {
  const bad = { ping: PODMAN_PING, version: DOCKER_VERSION };
  const got = await detectLocalEngine({ selection: "auto", env: ENV, probes: scripted({ [SOCKETS.docker]: bad, [SOCKETS.podman]: podmanEngine }) });
  assert.equal(got.id, "podman");
  assert.match(got.findings.join("\n"), /skipped docker: .*docker engine on \/sockets\/docker\.sock.*identity is inconsistent/);
});

test("detect: /version null names the engine, the socket and the action", async () => {
  const nullVersion = { ping: DOCKER_PING, version: null as unknown as VersionInfo };
  await assert.rejects(
    detectLocalEngine({ selection: "docker", env: ENV, probes: scripted({ [SOCKETS.docker]: nullVersion }) }),
    /docker engine on \/sockets\/docker\.sock \(from DOCKER_HOST\) cannot be identified: .*not an object; point the socket at the engine itself/,
  );
});

test("auto: none answers -> one error carrying both causes and the action", async () => {
  await assert.rejects(
    detectLocalEngine({ selection: "auto", env: ENV, probes: scripted({}) }),
    /no local container engine answered \(docker: .*does not answer.*; podman: .*does not answer.*\); start Docker or Podman, or set sandbox\.backend/,
  );
});

test("auto: an unresolvable socket for one id is a cause, not a failure, when the other answers", async () => {
  const got = await detectLocalEngine({ selection: "auto", env: { CONTAINER_HOST: ENV.CONTAINER_HOST }, probes: scripted({ [SOCKETS.podman]: podmanEngine }) });
  assert.equal(got.id, "podman");
});

test("auto: an inconsistent engine is a cause and does not count as answering", async () => {
  const bad = { ping: PODMAN_PING, version: DOCKER_VERSION };
  await assert.rejects(detectLocalEngine({ selection: "auto", env: ENV, probes: scripted({ [SOCKETS.docker]: bad }) }), /identity is inconsistent/);
});

test("real probes: ping headers and version JSON over a unix socket, and a non-200 is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-"));
  const socket = join(dir, "e.sock");
  const server = createServer((req, res) => {
    if (req.url === "/_ping") res.writeHead(200, { "Libpod-Api-Version": "6.2.0", "Api-Version": "1.44" }).end("OK");
    else if (req.url === "/version") res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(PODMAN_VERSION));
    else res.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const ping = await realEngineProbes.ping(socket);
    assert.equal(ping.headers["libpod-api-version"], "6.2.0");
    assert.deepEqual(await realEngineProbes.version(socket), PODMAN_VERSION);
    const got = await detectLocalEngine({ selection: "podman", env: { CONTAINER_HOST: `unix://${socket}` }, probes: realEngineProbes });
    assert.equal(got.id, "podman");
    server.removeAllListeners("request");
    server.on("request", (_req, res) => res.writeHead(500).end());
    await assert.rejects(realEngineProbes.ping(socket), /returned HTTP 500/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real probes: a missing socket rejects", async () => {
  await assert.rejects(realEngineProbes.ping(join(tmpdir(), "pd-absent", "none.sock")), /ENOENT/);
});
