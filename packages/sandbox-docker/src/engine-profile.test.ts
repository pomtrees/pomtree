import test from "node:test";
import assert from "node:assert/strict";
import {
  cliSocketEnv,
  DOCKER_PROFILE,
  engineProfile,
  parseDockerContextInspect,
  parsePodmanMachinePath,
  PODMAN_PROFILE,
  resolveSocket,
  socketPathFromHost,
  type EngineProfile,
  type SocketProbes,
} from "./engine-profile.ts";

// Scrubbed placeholders, not real machine paths.
const CTX_SOCKET = "/ctx/docker.sock";
const MACHINE_SOCKET = "/machine/podman-api.sock";

const DOCKER_CONTEXT_JSON = JSON.stringify([{ Name: "desktop-linux", Endpoints: { docker: { Host: `unix://${CTX_SOCKET}`, SkipTLSVerify: false } } }]);

function probes(over: { cli?: Record<string, string | undefined>; existing?: string[] } = {}): SocketProbes & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cliView: async (p: EngineProfile) => {
      calls.push(`cli:${p.id}`);
      return over.cli?.[p.id];
    },
    exists: (path) => {
      calls.push(`exists:${path}`);
      return (over.existing ?? []).includes(path);
    },
  };
}

test("engineProfile returns the profile per id and rejects an unknown id with cause and action", () => {
  assert.equal(engineProfile("docker"), DOCKER_PROFILE);
  assert.equal(engineProfile("podman"), PODMAN_PROFILE);
  assert.throws(() => engineProfile("nerdctl"), /unknown container engine "nerdctl".*set sandbox\.backend/);
});

test("error dialect: both ids share the duplicate-name substring; unreachable wording differs", () => {
  const dup = 'Error: creating container storage: the container name "x" is already in use by abc. You have to remove that container';
  assert.match(dup, DOCKER_PROFILE.errors.alreadyInUse);
  assert.match(dup, PODMAN_PROFILE.errors.alreadyInUse);
  assert.doesNotMatch("No such container: x", DOCKER_PROFILE.errors.alreadyInUse);
  const dockerDown = "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?";
  const podmanDown = "Cannot connect to Podman. Please verify your connection to the Linux system";
  assert.match(dockerDown, DOCKER_PROFILE.errors.daemonUnreachable);
  assert.doesNotMatch(podmanDown, DOCKER_PROFILE.errors.daemonUnreachable);
  assert.match(podmanDown, PODMAN_PROFILE.errors.daemonUnreachable);
  assert.doesNotMatch(dockerDown, PODMAN_PROFILE.errors.daemonUnreachable);
});

test("daemon-unreachable dialect needs a socket or daemon context; a container-side missing path is not a down daemon", () => {
  const dial = "error during connect: dial unix /var/run/docker.sock: connect: no such file or directory";
  const refused = "dial unix /run/podman/podman.sock: connect: connection refused";
  const containerSide = 'OCI runtime exec failed: exec: "/opt/missing": stat /opt/missing: no such file or directory';
  assert.match(dial, DOCKER_PROFILE.errors.daemonUnreachable);
  assert.match(refused, PODMAN_PROFILE.errors.daemonUnreachable);
  assert.doesNotMatch(containerSide, DOCKER_PROFILE.errors.daemonUnreachable);
  assert.doesNotMatch(containerSide, PODMAN_PROFILE.errors.daemonUnreachable);
  assert.doesNotMatch("open /x: no such file or directory", DOCKER_PROFILE.errors.daemonUnreachable);
});

test("both ids expose the same host alias constant", () => {
  assert.equal(DOCKER_PROFILE.hostAlias, "host.docker.internal");
  assert.equal(PODMAN_PROFILE.hostAlias, DOCKER_PROFILE.hostAlias);
});

test("CLI view parsers: docker context inspect JSON and podman machine inspect path", () => {
  assert.equal(parseDockerContextInspect(DOCKER_CONTEXT_JSON), `unix://${CTX_SOCKET}`);
  assert.equal(parseDockerContextInspect("[]"), undefined);
  assert.equal(parseDockerContextInspect("not json"), undefined);
  assert.equal(parseDockerContextInspect(JSON.stringify([{ Endpoints: {} }])), undefined);
  assert.equal(parsePodmanMachinePath(`${MACHINE_SOCKET}\n`), MACHINE_SOCKET);
  assert.equal(parsePodmanMachinePath(`${MACHINE_SOCKET}\n/second/line.sock\n`), MACHINE_SOCKET, "only the first line counts");
  assert.equal(parsePodmanMachinePath("Error: no machine\n/looks/like/a/path"), undefined);
  assert.equal(parsePodmanMachinePath(""), undefined);
  assert.equal(parsePodmanMachinePath("Error: no machine"), undefined);
});

test("socketPathFromHost accepts unix:// and absolute paths and refuses remote engines with an action", () => {
  assert.equal(socketPathFromHost(DOCKER_PROFILE, "DOCKER_HOST", "unix:///a/b.sock"), "/a/b.sock");
  assert.equal(socketPathFromHost(DOCKER_PROFILE, "DOCKER_HOST", "/a/b.sock"), "/a/b.sock");
  assert.equal(socketPathFromHost(DOCKER_PROFILE, "DOCKER_HOST", "UNIX:///a/b.sock"), "/a/b.sock");
  assert.throws(() => socketPathFromHost(DOCKER_PROFILE, "DOCKER_HOST", "tcp://10.0.0.1:2375"), /not a local unix socket.*unix:\/\/\/<absolute path> or unset/);
  assert.throws(() => socketPathFromHost(PODMAN_PROFILE, "CONTAINER_HOST", "ssh://u@h/run/podman.sock"), /CONTAINER_HOST.*not a local unix socket/);
  assert.throws(() => socketPathFromHost(DOCKER_PROFILE, "DOCKER_HOST", "unix://relative.sock"), /not a local unix socket/);
});

test("resolver order, docker: configured wins over env, CLI view and default", async () => {
  const p = probes({ cli: { docker: DOCKER_CONTEXT_JSON }, existing: ["/var/run/docker.sock"] });
  const got = await resolveSocket({ profile: DOCKER_PROFILE, configured: "/cfg.sock", env: { DOCKER_HOST: "unix:///env.sock" }, probes: p });
  assert.deepEqual(got, { path: "/cfg.sock", source: "config", via: "sandbox.docker.socket" });
  assert.deepEqual(p.calls, [], "no probe runs once an explicit source answers");
});

test("resolver order, docker: DOCKER_HOST wins over CLI view and default", async () => {
  const p = probes({ cli: { docker: DOCKER_CONTEXT_JSON }, existing: ["/var/run/docker.sock"] });
  const got = await resolveSocket({ profile: DOCKER_PROFILE, env: { DOCKER_HOST: "unix:///env.sock" }, probes: p });
  assert.deepEqual(got, { path: "/env.sock", source: "env", via: "DOCKER_HOST" });
  assert.deepEqual(p.calls, []);
});

test("resolver order, docker: the CLI's current context wins over the default socket", async () => {
  const p = probes({ cli: { docker: DOCKER_CONTEXT_JSON }, existing: ["/var/run/docker.sock"] });
  const got = await resolveSocket({ profile: DOCKER_PROFILE, env: {}, probes: p });
  assert.deepEqual(got, { path: CTX_SOCKET, source: "cli", via: "docker context inspect" });
});

test("resolver order, docker: falls back to /var/run/docker.sock only when it exists", async () => {
  const got = await resolveSocket({ profile: DOCKER_PROFILE, env: {}, probes: probes({ existing: ["/var/run/docker.sock"] }) });
  assert.deepEqual(got, { path: "/var/run/docker.sock", source: "default", via: "/var/run/docker.sock" });
  await assert.rejects(
    resolveSocket({ profile: DOCKER_PROFILE, env: {}, probes: probes() }),
    /no docker socket found.*sandbox\.docker\.socket and DOCKER_HOST are unset.*\/var\/run\/docker\.sock.*start docker/,
  );
});

test("resolver order, podman: configured, CONTAINER_HOST, machine inspect, then XDG and system defaults", async () => {
  const cli = { podman: `${MACHINE_SOCKET}\n` };
  const existing = ["/xdg/podman/podman.sock", "/run/podman/podman.sock"];
  assert.equal(
    (await resolveSocket({ profile: PODMAN_PROFILE, configured: "/cfg.sock", env: { CONTAINER_HOST: "unix:///env.sock" }, probes: probes({ cli, existing }) }))
      .source,
    "config",
  );
  assert.deepEqual(await resolveSocket({ profile: PODMAN_PROFILE, env: { CONTAINER_HOST: "unix:///env.sock" }, probes: probes({ cli, existing }) }), {
    path: "/env.sock",
    source: "env",
    via: "CONTAINER_HOST",
  });
  assert.deepEqual(
    (await resolveSocket({ profile: PODMAN_PROFILE, env: { XDG_RUNTIME_DIR: "/xdg" }, probes: probes({ cli, existing }) })).path,
    MACHINE_SOCKET,
  );
  assert.deepEqual(await resolveSocket({ profile: PODMAN_PROFILE, env: { XDG_RUNTIME_DIR: "/xdg" }, probes: probes({ existing }) }), {
    path: "/xdg/podman/podman.sock",
    source: "default",
    via: "/xdg/podman/podman.sock",
  });
  assert.equal(
    (await resolveSocket({ profile: PODMAN_PROFILE, env: { XDG_RUNTIME_DIR: "/xdg" }, probes: probes({ existing: ["/run/podman/podman.sock"] }) })).path,
    "/run/podman/podman.sock",
  );
  assert.equal(
    (await resolveSocket({ profile: PODMAN_PROFILE, env: {}, probes: probes({ existing: ["/run/podman/podman.sock"] }) })).path,
    "/run/podman/podman.sock",
  );
});

test("resolver order, podman: an empty or failed machine inspect falls through; nothing found names every location", async () => {
  const got = await resolveSocket({ profile: PODMAN_PROFILE, env: {}, probes: probes({ cli: { podman: "" }, existing: ["/run/podman/podman.sock"] }) });
  assert.equal(got.source, "default");
  await assert.rejects(
    resolveSocket({ profile: PODMAN_PROFILE, env: { XDG_RUNTIME_DIR: "/xdg" }, probes: probes() }),
    /no podman socket found.*CONTAINER_HOST are unset.*\/xdg\/podman\/podman\.sock, \/run\/podman\/podman\.sock.*start podman/,
  );
});

test("resolver: an empty configured value or env var is treated as unset; a remote DOCKER_HOST fails rather than falls through", async () => {
  const got = await resolveSocket({
    profile: DOCKER_PROFILE,
    configured: "",
    env: { DOCKER_HOST: "" },
    probes: probes({ existing: ["/var/run/docker.sock"] }),
  });
  assert.equal(got.source, "default");
  await assert.rejects(
    resolveSocket({ profile: DOCKER_PROFILE, env: { DOCKER_HOST: "tcp://h:2375" }, probes: probes({ existing: ["/var/run/docker.sock"] }) }),
    /not a local unix socket/,
  );
});

test("cliSocketEnv points each CLI at the resolved socket through its own variable", () => {
  assert.deepEqual(cliSocketEnv(DOCKER_PROFILE, "/s.sock"), { DOCKER_HOST: "unix:///s.sock" });
  assert.deepEqual(cliSocketEnv(PODMAN_PROFILE, "/s.sock"), { CONTAINER_HOST: "unix:///s.sock" });
});
