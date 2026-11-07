import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BuildPlanInput,
  type IdentityIo,
  buildCommand,
  buildResultLine,
  guarded,
  DEFAULT_IMAGE_TAGS,
  IMAGE_TARGETS,
  imageInspectArgv,
  imageMissingMessage,
  PI_VERSION_LABEL,
  parseBuildEngine,
  parseBuildxMetadata,
  parseEngineLocalId,
  parseImageInspect,
  parsePodmanImageId,
  parseSaveManifest,
  readBuiltIdentity,
  REVISION_LABEL,
  resolveDockerIdentity,
} from "./image-labels.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(here, "..", "Dockerfile"), "utf8");
const buildScript = readFileSync(resolve(here, "..", "scripts", "build.ts"), "utf8");
const instructions = dockerfile
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

const ID = `sha256:${"ab".repeat(32)}`;
const inspect = (labels: Record<string, string> | null, id: unknown = ID) => JSON.stringify([{ Id: id, Config: { Labels: labels } }]);

test("parseImageInspect reads the image id, the revision and the Pi version labels", () => {
  const out = inspect({ [REVISION_LABEL]: "c6e8c16", [PI_VERSION_LABEL]: "1.5.1", other: "x" });
  assert.deepEqual(parseImageInspect("pomtree/agent:dev", out), { id: ID, revision: "c6e8c16", piVersion: "1.5.1" });
});

test("parseImageInspect refuses an image without the Pi version label and names the rebuild", () => {
  assert.throws(
    () => parseImageInspect("img:old", inspect({ [REVISION_LABEL]: "c6e8c16" })),
    /^Error: image img:old has no org\.pomtree\.pi\.version label; rebuild it with `pnpm --filter @pomtree\/agent-image build:image`$/,
  );
  // An empty build arg stamps an empty label: that is no label either.
  assert.throws(() => parseImageInspect("img", inspect({ [REVISION_LABEL]: "c6e8c16", [PI_VERSION_LABEL]: "" })), /has no org\.pomtree\.pi\.version label/);
  assert.throws(() => parseImageInspect("img", inspect({ [PI_VERSION_LABEL]: "1.5.1" })), /has no org\.opencontainers\.image\.revision label/);
  assert.throws(() => parseImageInspect("img", inspect(null)), /has no org\.opencontainers\.image\.revision label/);
});

test("parseImageInspect refuses malformed labels, ids and output", () => {
  const ok = { [REVISION_LABEL]: "c6e8c16", [PI_VERSION_LABEL]: "1.5.1" };
  assert.throws(() => parseImageInspect("img", inspect({ ...ok, [PI_VERSION_LABEL]: "latest" })), /malformed org\.pomtree\.pi\.version label/);
  assert.throws(() => parseImageInspect("img", inspect({ ...ok, [REVISION_LABEL]: "HEAD; rm" })), /malformed org\.opencontainers\.image\.revision label/);
  assert.throws(() => parseImageInspect("img", inspect(ok, "abc")), /no sha256 image id/);
  assert.throws(() => parseImageInspect("img", inspect(ok, null)), /no sha256 image id/);
  assert.throws(() => parseImageInspect("img", "[]"), /expected exactly one image/);
  assert.throws(() => parseImageInspect("img", `[${inspect(ok).slice(1, -1)},${inspect(ok).slice(1, -1)}]`), /expected exactly one image/);
  assert.throws(() => parseImageInspect("img", "[null]"), /no sha256 image id/);
  assert.throws(() => parseImageInspect("img", "Error: No such image"), /output is not JSON/);
});

test("imageInspectArgv ends flag parsing before the reference and refuses flag-like references", () => {
  assert.deepEqual(imageInspectArgv("pomtree/agent:dev"), ["image", "inspect", "--", "pomtree/agent:dev"]);
  assert.throws(() => imageInspectArgv("--format=x"), /not a docker image reference/);
  assert.throws(() => imageInspectArgv(""), /not a docker image reference/);
});

test("the Dockerfile stamps the Pi version label from the PI_VERSION build arg, never from a literal", () => {
  assert.ok(instructions.includes(`ARG PI_VERSION\nARG PI_NPM_INTEGRITY\nLABEL ${PI_VERSION_LABEL}=$PI_VERSION\n`));
  assert.ok(instructions.includes(`LABEL ${REVISION_LABEL}=$AGENT_REVISION\n`));
  // One pin: the version literal lives in build.ts only, which passes it as the build arg.
  const pin = /^const PI_VERSION = "(\d+\.\d+\.\d+)";$/m.exec(buildScript)?.[1];
  assert.ok(pin, "build.ts holds the Pi pin");
  assert.ok(!dockerfile.includes(pin), "the Dockerfile carries no copy of the Pi version");
  assert.match(buildScript, /`PI_VERSION=\$\{PI_VERSION\}`/);
});

test("the Dockerfile's stages are the declared targets, the full image is the default, and slow layers precede the per-commit copies", () => {
  const stages = [...instructions.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(stages.slice(1), [
    ["scratch", "app"],
    ["scratch", "app-browser"],
    ["system", "demo"],
    ["system", "full"],
  ]);
  assert.equal(stages[0]?.[1], "system");
  // `docker build` without --target builds the last stage.
  assert.equal(stages.at(-1)?.[1], "full");
  assert.deepEqual([...IMAGE_TARGETS].sort(), ["demo", "full"]);
  const [system, app, appBrowser, demo, full] = instructions.split(/^FROM .*$/m).slice(1);
  // Pi label, runtime user (set per target), workdir, entrypoint and env are set once, in system; the revision label is stamped last, per target.
  for (const stage of [app, appBrowser, demo, full]) assert.doesNotMatch(stage ?? "", /^(?:ENV|ENTRYPOINT) /m);
  assert.match(system ?? "", /^ENTRYPOINT \["\/usr\/local\/bin\/pomtree-entrypoint"\]/m);
  for (const stage of [demo, full]) assert.match(stage ?? "", /\nUSER 1000:1000\n(?:#[^\n]*\n)?WORKDIR \/workspace\n*$/);
  // Cache order (the point of the stage split): the per-commit copies (`app*`, scratch stages with COPY only) come after every apt/git/npm RUN in a target.
  for (const stage of [app, appBrowser]) assert.doesNotMatch(stage ?? "", /^RUN /m);
  const f = full ?? "";
  const appAt = f.indexOf("COPY --from=app / /");
  for (const slow of ["chromium", "npm ci", "git clone"])
    assert.ok(f.indexOf(slow) > -1 && f.indexOf(slow) < appAt, `full runs "${slow}" before the per-commit copy`);
  assert.ok(f.indexOf("COPY --from=app-browser / /") > appAt);
  assert.ok((system ?? "").indexOf("npm install -g") > -1 && !/COPY packages\//.test(system ?? ""), "system holds no per-commit copy");
  // npm ci in the full stage must not fill the env-layer mount path the system ENV names as npm's cache.
  assert.match(full ?? "", /npm ci [^\n]*--cache \/tmp\/npm-ci-cache/);
});

test("the demo image carries no browser, fonts, toolchain, Python or pi-browser; the full image does", () => {
  const [system, app, appBrowser, demo, full] = instructions.split(/^FROM .*$/m).slice(1);
  const slim = `${system}${app}${demo}`;
  // The system ENV names agent-side install paths (CARGO_HOME, PIP_*) for every image; what matters is what is installed or copied.
  const installed = [...slim.matchAll(/apt-get install[^\n]*/g)].map((m) => m[0]).join("\n");
  assert.ok(installed.length > 0);
  assert.doesNotMatch(installed, /\b(?:chromium|fonts-\S+|cargo|build-essential|python3\S*)\b/);
  assert.doesNotMatch(slim, /pi-browser|browser-run\.ts|browser-capture\.ts|capture-worker\.ts|cdp-recorder\.ts|loopback-bridge|app-browser/);
  const fullAll = `${full}${appBrowser}`;
  for (const re of [/\bchromium\b/, /\bcargo\b/, /\bbuild-essential\b/, /\bpython3-pip\b/, /pi-browser/, /capture-worker\.ts/, /browser-run\.ts/])
    assert.match(fullAll, re);
  // What E1's agents and sidecars run: git, curl, Pi, pomtree, the egress sidecar and the extension loadout.
  for (const re of [/apt-get install[^\n]*\bgit\b/, /apt-get install[^\n]*\bcurl\b/, /pi-coding-agent/]) assert.match(system ?? "", re);
  for (const re of [/\/usr\/local\/bin\/pomtree\b/, /^COPY --from=app \/ \/$/m]) assert.match(demo ?? "", re);
  for (const re of [/\/opt\/pomtree\/egress\//, /^COPY packages\/agent-image\/ext /m]) assert.match(app ?? "", re);
});

const plan: BuildPlanInput = {
  engine: "docker",
  dockerfile: "/r/Dockerfile",
  target: "full",
  tag: "pomtree/agent:dev",
  bundleDir: "/tmp/b",
  buildArgs: ["--build-arg", "A=1"],
  root: "/r",
  resultFile: "/tmp/res",
};

test("the build script's layer cache is opt-in, local-directory based, and off by default", () => {
  assert.match(buildScript, /process\.env\.AGENT_IMAGE_CACHE_DIR/);
  assert.ok(!buildCommand(plan).argv.some((a) => a.includes("cache")));
  const cached = buildCommand({ ...plan, cacheDir: "/c" }).argv;
  assert.ok(cached.includes("type=local,src=/c") && cached.includes("type=local,dest=/c,mode=max"));
});

test("parseBuildEngine defaults to docker, accepts podman and refuses anything else naming the fix", () => {
  assert.equal(parseBuildEngine(undefined), "docker");
  assert.equal(parseBuildEngine("podman"), "podman");
  assert.throws(() => parseBuildEngine("nerdctl"), /AGENT_IMAGE_ENGINE="nerdctl" is not a build engine; set it to docker or podman/);
  assert.throws(() => parseBuildEngine(""), /is not a build engine/);
  assert.match(buildScript, /parseBuildEngine\(process\.env\.AGENT_IMAGE_ENGINE\)/);
});

test("buildCommand: docker uses buildx with a single-manifest result and a metadata file", () => {
  const { binary, argv } = buildCommand(plan);
  assert.equal(binary, "docker");
  assert.deepEqual(argv.slice(0, 6), ["buildx", "build", "--load", "--provenance=false", "--metadata-file", "/tmp/res"]);
  assert.deepEqual(argv.slice(-1), ["/r"]);
  assert.ok(!argv.includes("--format") && !argv.includes("--iidfile"));
});

test("buildCommand: podman pins the OCI format, reads --iidfile and never passes --metadata-file", () => {
  const { binary, argv } = buildCommand({ ...plan, engine: "podman" });
  assert.equal(binary, "podman");
  assert.deepEqual(argv.slice(0, 5), ["build", "--format", "oci", "--iidfile", "/tmp/res"]);
  assert.ok(!argv.includes("--metadata-file") && !argv.includes("buildx") && !argv.includes("--provenance=false"));
  assert.ok(argv.includes("bundle=/tmp/b") && argv.includes("--target") && argv.includes("pomtree/agent:dev"));
});

test("buildCommand refuses the buildx cache under podman, naming the cause and the action", () => {
  assert.throws(
    () => buildCommand({ ...plan, engine: "podman", cacheDir: "/c" }),
    /needs buildx, which only docker has; unset AGENT_IMAGE_CACHE_DIR .* AGENT_IMAGE_ENGINE=docker/,
  );
});

const HEX = "ab".repeat(32);
const meta = (o: unknown) => JSON.stringify(o);

test("parsePodmanImageId reads an iidfile (prefixed) or `.Id` (bare hex) as the config digest", () => {
  assert.deepEqual(parsePodmanImageId(`sha256:${HEX}`), { configDigest: `sha256:${HEX}` });
  assert.deepEqual(parsePodmanImageId(`${HEX}\n`), { configDigest: `sha256:${HEX}` });
  assert.throws(() => parsePodmanImageId(""), /not a sha256 config digest/);
  assert.throws(() => parsePodmanImageId("abc123"), /not a sha256 config digest/);
});

test("parseBuildxMetadata reads the config digest and media type of a single-manifest result", () => {
  const out = parseBuildxMetadata(
    meta({
      "containerimage.config.digest": `sha256:${HEX}`,
      "containerimage.descriptor": { mediaType: "application/vnd.docker.distribution.manifest.v2+json", digest: `sha256:${"cd".repeat(32)}` },
      "containerimage.digest": `sha256:${"cd".repeat(32)}`,
    }),
  );
  assert.deepEqual(out, { configDigest: `sha256:${HEX}`, mediaType: "application/vnd.docker.distribution.manifest.v2+json" });
});

test("parseBuildxMetadata returns undefined for an index result without the key, and refuses an index media type or bad shapes", () => {
  // Default provenance: P9 saw an index and no containerimage.config.digest.
  assert.equal(parseBuildxMetadata(meta({ "containerimage.digest": `sha256:${HEX}` })), undefined);
  assert.throws(
    () =>
      parseBuildxMetadata(
        meta({ "containerimage.config.digest": `sha256:${HEX}`, "containerimage.descriptor": { mediaType: "application/vnd.oci.image.index.v1+json" } }),
      ),
    /media type is "application\/vnd\.oci\.image\.index\.v1\+json", expected .*rebuild with --provenance=false/,
  );
  assert.throws(() => parseBuildxMetadata(meta({ "containerimage.config.digest": HEX.slice(1) })), /not a sha256 config digest/);
  assert.throws(() => parseBuildxMetadata(meta({ "containerimage.config.digest": 5 })), /is not a string/);
  assert.throws(() => parseBuildxMetadata("nope"), /not JSON/);
  assert.throws(() => parseBuildxMetadata("[]"), /not a JSON object/);
});

test("parseSaveManifest reads the Config field of both archive layouts and refuses anything else", () => {
  assert.deepEqual(parseSaveManifest(meta([{ Config: `blobs/sha256/${HEX}`, RepoTags: ["x"] }])), { configDigest: `sha256:${HEX}` });
  assert.deepEqual(parseSaveManifest(meta([{ Config: `${HEX}.json` }])), { configDigest: `sha256:${HEX}` });
  assert.throws(() => parseSaveManifest(meta([{ Config: "blobs/sha256/short" }])), /no sha256 Config entry/);
  assert.throws(() => parseSaveManifest(meta([{}, {}])), /exactly one image/);
  assert.throws(() => parseSaveManifest("x"), /not JSON/);
});

test("resolveDockerIdentity prefers the buildx digest, falls back to docker save once, else fails closed", () => {
  const withKey = meta({ "containerimage.config.digest": `sha256:${HEX}` });
  const saved = meta([{ Config: `blobs/sha256/${"ef".repeat(32)}` }]);
  let reads = 0;
  const read = () => {
    reads++;
    return saved;
  };
  assert.deepEqual(resolveDockerIdentity(withKey, read), { configDigest: `sha256:${HEX}` });
  assert.equal(reads, 0, "no docker save when buildx gave the digest");
  const idx = meta({
    "containerimage.digest": `sha256:${HEX}`,
    "containerimage.descriptor": { mediaType: "application/vnd.docker.distribution.manifest.v2+json" },
  });
  assert.deepEqual(resolveDockerIdentity(idx, read), {
    configDigest: `sha256:${"ef".repeat(32)}`,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  });
  assert.equal(reads, 1);
  assert.throws(() => resolveDockerIdentity("{}", () => "[]"), /exactly one image/);
});

const LOCAL = `sha256:${"cd".repeat(32)}`;

test("buildResultLine keeps the engine-local id as field 2 and adds the config digest, even when the two differ (containerd store)", () => {
  // Docker with the containerd store: `.Id` is the index or manifest digest, not the config digest (P9). Existing consumers
  // (egressProxyImage, safety-boot) verify field 2 against `docker image inspect .Id`, so it must stay that value.
  const line = buildResultLine("t:1", LOCAL, { configDigest: `sha256:${HEX}`, mediaType: "m" });
  assert.deepEqual(line.split(" "), ["t:1", LOCAL, `sha256:${HEX}`, "m"]);
  assert.equal(buildResultLine("t:1", LOCAL, { configDigest: `sha256:${HEX}` }), `t:1 ${LOCAL} sha256:${HEX}`);
  // Podman: `.Id` is the config digest, so both fields are equal.
  assert.equal(buildResultLine("t:1", `sha256:${HEX}`, { configDigest: `sha256:${HEX}` }), `t:1 sha256:${HEX} sha256:${HEX}`);
});

test("parseEngineLocalId reads `.Id` (prefixed or bare hex) and refuses anything else, naming the action", () => {
  assert.equal(parseEngineLocalId(`${LOCAL}\n`), LOCAL);
  assert.equal(parseEngineLocalId("cd".repeat(32)), LOCAL);
  assert.throws(() => parseEngineLocalId(""), /engine image id is not a sha256 config digest.*rebuild/);
});

test("imageMissingMessage names the store and the build command", () => {
  assert.equal(
    imageMissingMessage("podman", "pomtree/agent:demo", "demo"),
    "image pomtree/agent:demo is not in the podman store (images are per engine store; an image built by the other engine is not visible here); build it with: AGENT_IMAGE_ENGINE=podman AGENT_IMAGE_TAG=pomtree/agent:demo pnpm --filter @pomtree/agent-image build:image:demo",
  );
});

test("the build script rejects an unknown target and an unknown engine before building anything", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [resolve(here, "..", "scripts", "build.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const target = run(["--target", "nope"], {});
  assert.notEqual(target.status, 0);
  assert.match(target.stderr, /unknown image target "nope"; expected one of full, demo/);
  const engineRun = run([], { AGENT_IMAGE_ENGINE: "nerdctl" });
  assert.notEqual(engineRun.status, 0);
  assert.match(engineRun.stderr, /AGENT_IMAGE_ENGINE="nerdctl" is not a build engine/);
});

test("the build script builds a declared target with its default tag", () => {
  assert.deepEqual(DEFAULT_IMAGE_TAGS, { full: "pomtree/agent:dev", demo: "pomtree/agent:demo" });
  const demo = buildCommand({ ...plan, target: "demo" }).argv;
  assert.equal(demo[demo.indexOf("--target") + 1], "demo");
  const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["build:image:demo"], "node scripts/build.ts --target demo");
});

const io = (o: Partial<IdentityIo>): IdentityIo => ({ readResultFile: () => undefined, run: () => "", readSaveManifest: () => "[]", ...o });
const enoent = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });

test("readBuiltIdentity: containerd-store docker keeps the local id apart from the config digest", () => {
  const got = readBuiltIdentity(
    "docker",
    "t",
    "full",
    io({ readResultFile: () => meta({ "containerimage.config.digest": `sha256:${HEX}` }), run: () => `${LOCAL}\n` }),
  );
  assert.deepEqual(got, { image: { configDigest: `sha256:${HEX}` }, localId: LOCAL });
});

test("readBuiltIdentity: podman reads the iidfile, else `.Id`, and an uppercase-hex id fails closed with cause and action", () => {
  assert.equal(readBuiltIdentity("podman", "t", "full", io({ readResultFile: () => `sha256:${HEX}` })).localId, `sha256:${HEX}`);
  assert.equal(readBuiltIdentity("podman", "t", "full", io({ run: () => HEX })).image.configDigest, `sha256:${HEX}`);
  assert.throws(
    () => readBuiltIdentity("podman", "t", "full", io({ readResultFile: () => `sha256:${HEX.toUpperCase()}` })),
    /not a sha256 config digest.*rebuild/,
  );
  assert.throws(() => readBuiltIdentity("podman", "t", "full", io({ readResultFile: () => HEX.toUpperCase() })), /not a sha256 config digest/);
});

test("readBuiltIdentity names the real cause and action for a missing binary, a missing result file and a failing engine", () => {
  const ok = meta({ "containerimage.config.digest": `sha256:${HEX}` });
  assert.throws(
    () =>
      readBuiltIdentity(
        "docker",
        "t",
        "full",
        io({
          readResultFile: () => ok,
          run: () => {
            throw enoent;
          },
        }),
      ),
    /^Error: docker was not found on PATH; install docker, or set AGENT_IMAGE_ENGINE/,
  );
  assert.throws(
    () => readBuiltIdentity("docker", "t", "full", io({})),
    /metadata file was not written by the build; check that `docker buildx version` works, then rebuild/,
  );
  assert.throws(
    () =>
      readBuiltIdentity(
        "docker",
        "t",
        "full",
        io({
          readResultFile: () => ok,
          run: () => {
            throw new Error("daemon down");
          },
        }),
      ),
    /failed \(daemon down\); check that the docker engine is running/,
  );
  assert.throws(
    () =>
      readBuiltIdentity(
        "podman",
        "t",
        "demo",
        io({
          run: () => {
            throw new Error("no such image");
          },
        }),
      ),
    /not in the podman store.*build:image:demo/,
  );
  // docker save fallback: a missing tar or docker is its own cause, and unreadable output still fails closed.
  const idx = meta({ "containerimage.digest": `sha256:${HEX}` });
  assert.throws(
    () =>
      readBuiltIdentity(
        "docker",
        "t",
        "full",
        io({
          readResultFile: () => idx,
          readSaveManifest: () => {
            throw enoent;
          },
        }),
      ),
    /docker or tar was not found on PATH/,
  );
  assert.throws(() => readBuiltIdentity("docker", "t", "full", io({ readResultFile: () => idx })), /exactly one image/);
});

test("guarded always runs cleanup and reports instead of exiting, on success and on failure", () => {
  const calls: string[] = [];
  assert.equal(
    guarded(
      () => calls.push("work"),
      () => calls.push("cleanup"),
      () => calls.push("report"),
    ),
    true,
  );
  assert.deepEqual(calls, ["work", "cleanup"]);
  calls.length = 0;
  const failed = guarded(
    () => {
      throw new Error("boom");
    },
    () => calls.push("cleanup"),
    (e) => calls.push(`report:${e.message}`),
  );
  assert.equal(failed, false);
  assert.deepEqual(calls, ["report:boom", "cleanup"]);
});
