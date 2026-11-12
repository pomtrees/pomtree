import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyEngineError,
  findLegacyContainers,
  isEngineError,
  legacyContainerRefusal,
  networkInspectView,
  normalizeImageId,
  type EngineErrorClass,
} from "./engine-dialect.ts";
import { DOCKER_PROFILE, engineProfile, PODMAN_PROFILE, type EngineId } from "./engine-profile.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "engine");
const read = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(FIXTURES, ...parts), "utf8")) as T;

interface ErrorFixture {
  engine: EngineId;
  class: EngineErrorClass;
  provenance: string;
  source: string;
  verb: string;
  exitCode: number;
  stderr: string;
  negative: { stderr: string; note: string };
}

const CLASSES: EngineErrorClass[] = [
  "socketPermission",
  "daemonUnreachable",
  "nameInUse",
  "containerGone",
  "removalRace",
  "mountRace",
  "noSuchVolume",
  "noSuchNetwork",
  "networkExists",
  "imageUnavailable",
  "pullFailed",
];
const kebab = (c: string) => c.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`);
// What the CLI wrapper (makeExec) hands the classifiers.
const wrapped = (f: ErrorFixture, stderr: string) => `${f.engine} ${f.verb.split(" ")[0]} failed: ${stderr}`;

test("fixtures: every error class has a file for each engine, headed with provenance and a source", () => {
  for (const engine of ["docker", "podman"] as const) {
    const files = readdirSync(join(FIXTURES, engine)).sort();
    for (const cls of CLASSES) assert.ok(files.includes(`${kebab(cls)}.json`), `${engine} lacks a ${cls} fixture`);
    for (const cls of CLASSES) {
      const f = read<ErrorFixture>(engine, `${kebab(cls)}.json`);
      assert.equal(f.engine, engine);
      assert.equal(f.class, cls);
      assert.ok(f.provenance === "captured" || f.provenance === "inferred", `${engine}/${cls}: provenance is "${f.provenance}"`);
      assert.ok(f.source.length > 0 && f.negative.stderr.length > 0);
      // Scrubbed: no machine path, token or host name survives.
      assert.doesNotMatch(JSON.stringify(f), /\/Users\/|\/home\/|\/run\/user\/\d|token|secret|bearer/i, `${engine}/${cls} holds an unscrubbed value`);
    }
  }
});

for (const engine of ["docker", "podman"] as const) {
  const profile = engineProfile(engine);
  for (const cls of CLASSES) {
    const f = read<ErrorFixture>(engine, `${kebab(cls)}.json`);
    test(`${engine} dialect: ${cls} classifies its fixture and only that class`, () => {
      assert.equal(isEngineError(profile, cls, wrapped(f, f.stderr)), true, f.stderr);
      assert.equal(classifyEngineError(profile, wrapped(f, f.stderr)), cls);
    });
    test(`${engine} dialect: ${cls} rejects its similar-looking negative fixture`, () => {
      assert.equal(isEngineError(profile, cls, wrapped(f, f.negative.stderr)), false, f.negative.stderr);
    });
  }
}

test("dialects differ: a missing network is worded per engine, and a line from the other engine does not classify", () => {
  const podmanNet = read<ErrorFixture>("podman", "no-such-network.json").stderr;
  const dockerNet = read<ErrorFixture>("docker", "no-such-network.json").stderr;
  assert.equal(isEngineError(DOCKER_PROFILE, "noSuchNetwork", podmanNet), false);
  assert.equal(isEngineError(PODMAN_PROFILE, "noSuchNetwork", dockerNet), false);
});

test("both engines word a duplicate container name with 'is already in use' (P9, verified on Docker 28.4.0 and Podman 6.2.0)", () => {
  for (const engine of ["docker", "podman"] as const) {
    const f = read<ErrorFixture>(engine, "name-in-use.json");
    assert.equal(f.provenance, "captured");
    assert.match(f.stderr, /is already in use/);
  }
});

test("daemonUnreachable: a bare 'no such file or directory' is a container-side error, not an unreachable engine", () => {
  for (const profile of [DOCKER_PROFILE, PODMAN_PROFILE]) {
    assert.equal(isEngineError(profile, "daemonUnreachable", "open /x: no such file or directory"), false);
    assert.equal(isEngineError(profile, "daemonUnreachable", "stat /opt/x: no such file or directory"), false);
  }
});

test("socketPermission outranks daemonUnreachable: a Podman 'Cannot connect' line that ends in permission denied is not retryable", () => {
  const f = read<ErrorFixture>("podman", "socket-permission.json");
  assert.match(f.stderr, /cannot connect to podman/i);
  assert.equal(PODMAN_PROFILE.errors.daemonUnreachable.test(f.stderr), true, "the profile pattern alone would call it unreachable");
  assert.equal(isEngineError(PODMAN_PROFILE, "daemonUnreachable", f.stderr), false);
  assert.equal(classifyEngineError(PODMAN_PROFILE, f.stderr), "socketPermission");
});

test("container gone vs removal race: an in-progress removal is never read as an absent container", () => {
  for (const engine of ["docker", "podman"] as const) {
    const race = read<ErrorFixture>(engine, "removal-race.json").stderr;
    assert.equal(isEngineError(engineProfile(engine), "containerGone", race), false, race);
  }
});

interface ImageIdFixture {
  provenance: string;
  accepted: { digestRaw: string; expected: string }[];
  rejected: { digestRaw: string }[];
}

test("image id: Docker's sha256:<hex> passes, Podman's bare hex is normalized, anything else is refused", () => {
  const docker = read<ImageIdFixture>("docker", "image-id.json");
  const podman = read<ImageIdFixture>("podman", "image-id.json");
  assert.equal(podman.provenance, "captured");
  for (const a of docker.accepted) assert.equal(normalizeImageId(DOCKER_PROFILE, a.digestRaw), a.expected);
  for (const a of podman.accepted) assert.equal(normalizeImageId(PODMAN_PROFILE, a.digestRaw), a.expected);
  for (const r of docker.rejected) assert.equal(normalizeImageId(DOCKER_PROFILE, r.digestRaw), undefined, r.digestRaw);
  for (const r of podman.rejected) assert.equal(normalizeImageId(PODMAN_PROFILE, r.digestRaw), undefined, r.digestRaw);
});

test("image id: Podman's bare hex is not accepted as a Docker id (a negative control for the normalization)", () => {
  const bare = read<ImageIdFixture>("podman", "image-id.json").accepted[0]!.digestRaw;
  assert.equal(normalizeImageId(DOCKER_PROFILE, bare), undefined);
  assert.notEqual(normalizeImageId(PODMAN_PROFILE, bare), undefined);
});

interface NetFixture {
  output: string;
  expected: { driver: string; internal: boolean };
  negativeOutput: string;
}

test("network inspect: each engine's field names normalize to one view; the other engine's casing yields no fields", () => {
  for (const engine of ["docker", "podman"] as const) {
    const profile = engineProfile(engine);
    const f = read<NetFixture>(engine, "network-inspect.json");
    const view = networkInspectView(profile, f.output);
    assert.ok(typeof view !== "string", String(view));
    assert.equal(view.driver, f.expected.driver);
    assert.equal(view.internal, f.expected.internal);
    // Podman refuses `--opt com.docker.network.bridge.enable_icc` ("unsupported bridge network option"), so a real Podman network has no options.
    assert.equal(view.options?.["com.docker.network.bridge.enable_icc"], engine === "docker" ? "false" : undefined);
    assert.equal(view.labels?.["pomtree.egress"], "1");
    const wrong = networkInspectView(profile, f.negativeOutput);
    assert.ok(typeof wrong !== "string");
    assert.equal(wrong.driver, undefined, "the other engine's casing must not be read");
  }
});

test("network inspect: unreadable output names the engine's own binary", () => {
  assert.equal(networkInspectView(DOCKER_PROFILE, "nope"), "docker network inspect output is not JSON");
  assert.equal(networkInspectView(PODMAN_PROFILE, "nope"), "podman network inspect output is not JSON");
  assert.equal(networkInspectView(DOCKER_PROFILE, "[1]"), "docker network inspect output is not an object");
  assert.equal(
    networkInspectView(DOCKER_PROFILE, '[{"Driver":"bridge"}]'),
    "docker network inspect output is not an object",
    "Docker's array form is not accepted",
  );
});

interface LegacyFixture {
  containers: { engineId: string; legacy: boolean; labels: Record<string, string> }[];
}

test("legacy containers: only a pomtree container lacking the host or generation tag is legacy", () => {
  const f = read<LegacyFixture>("legacy-containers.json");
  assert.deepEqual(
    findLegacyContainers(f.containers),
    f.containers.filter((c) => c.legacy).map((c) => c.engineId),
  );
  assert.deepEqual(findLegacyContainers([]), []);
  const current = f.containers.find((c) => !c.legacy && c.labels.pomtree === "1")!;
  assert.deepEqual(
    findLegacyContainers([{ engineId: current.engineId, labels: { ...current.labels, "pomtree.generation": "" } }]),
    [current.engineId],
    "an empty tag counts as absent",
  );
});

test("legacy refusal: names cause, count, the exact engine ids (quoted) and the engine's own remove command; never removes", () => {
  const ids = ["1".repeat(12), "2".repeat(12)];
  const docker = legacyContainerRefusal(DOCKER_PROFILE, ids);
  assert.match(docker, /^2 containers on the docker engine predate the pomtree\.host and pomtree\.generation labels/);
  assert.match(docker, /run `docker rm -f '1{12}' '2{12}'`/);
  assert.match(docker, /Pomtree never removes them itself/);
  assert.match(legacyContainerRefusal(PODMAN_PROFILE, ids.slice(0, 1)), /^1 container on the podman engine predates .*run `podman rm -f '1{12}'`/);
});

test("legacy refusal: an id that is not hex is never embedded; with none valid the text sends the operator to the listing", () => {
  const hostile = ["x; rm -rf ~", "a b", `q'uote`, "line\nbreak", "$(reboot)", "", "ABCDEF123456", "12345"];
  const text = legacyContainerRefusal(DOCKER_PROFILE, [...hostile, "3".repeat(12)]);
  for (const bad of ["rm -rf", "reboot", "q'uote", "break", "ABCDEF", "12345'"]) assert.ok(!text.includes(bad), bad);
  assert.match(text, /^9 containers /);
  assert.match(text, /run `docker rm -f '3{12}'` \(then restart/);
  const none = legacyContainerRefusal(DOCKER_PROFILE, hostile);
  assert.match(none, /find them with `docker ps -a --filter label=pomtree=1` and remove each with `docker rm -f <container id>`/);
  assert.ok(!none.includes("rm -rf"));
});

test("legacy refusal: a long list is capped and says how to see the rest", () => {
  const ids = Array.from({ length: 8 }, (_, i) => String(i).repeat(12));
  const text = legacyContainerRefusal(DOCKER_PROFILE, ids);
  assert.equal(text.match(/'\d{12}'/g)?.length, 6, "three ids in the list and three in the command");
  assert.match(text, /\(5 more are not listed; list them with `docker ps -a --filter label=pomtree=1`\)/);
  assert.ok(text.length < 1000, `${text.length} chars must fit the daemon's 1000-char message clip`);
});

test("daemonUnreachable under Docker keeps its original single-pattern class: a line matching both patterns stays unreachable", () => {
  const both =
    "Cannot connect to the Docker daemon at unix://<socket>. Is the docker daemon running? permission denied while trying to connect to the Docker daemon socket";
  assert.equal(isEngineError(DOCKER_PROFILE, "daemonUnreachable", both), true);
  assert.equal(isEngineError(DOCKER_PROFILE, "socketPermission", both), true);
});

test("podman mountRace: a bind source path containing spaces still classifies; a different operation does not", () => {
  assert.equal(isEngineError(PODMAN_PROFILE, "mountRace", "Error: statfs /my work dir/ws: no such file or directory"), true);
  assert.equal(isEngineError(PODMAN_PROFILE, "mountRace", "Error: lstat /my work dir/ws: no such file or directory"), false);
});
