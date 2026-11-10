import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_IMAGE_TAGS, IMAGE_TARGETS, imageInspectArgv, PI_VERSION_LABEL, parseImageInspect, REVISION_LABEL } from "./image-labels.ts";

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
  assert.doesNotMatch(slim, /pi-browser|browser-run\.ts|browser-capture\.ts|capture-worker\.ts|cdp-recorder\.ts|app-browser/);
  const fullAll = `${full}${appBrowser}`;
  for (const re of [/\bchromium\b/, /\bcargo\b/, /\bbuild-essential\b/, /\bpython3-pip\b/, /pi-browser/, /capture-worker\.ts/, /browser-run\.ts/])
    assert.match(fullAll, re);
  // What E1's agents and sidecars run: git, curl, Pi, pomtree, the egress sidecar and the extension loadout.
  for (const re of [/apt-get install[^\n]*\bgit\b/, /apt-get install[^\n]*\bcurl\b/, /pi-coding-agent/]) assert.match(system ?? "", re);
  for (const re of [/\/usr\/local\/bin\/pomtree\b/, /^COPY --from=app \/ \/$/m]) assert.match(demo ?? "", re);
  for (const re of [/\/opt\/pomtree\/egress\//, /^COPY packages\/agent-image\/ext /m]) assert.match(app ?? "", re);
});

test("the build script's layer cache is opt-in, local-directory based, and off by default", () => {
  assert.match(buildScript, /process\.env\.AGENT_IMAGE_CACHE_DIR/);
  assert.match(buildScript, /: \{ builder: \["build"\], flags: \[\] as string\[\] \}/);
  assert.match(buildScript, /type=local,src=\$\{cacheDir\}/);
  assert.match(buildScript, /type=local,dest=\$\{cacheDir\},mode=max/);
});

test("the build script builds a declared target with its default tag", () => {
  assert.deepEqual(DEFAULT_IMAGE_TAGS, { full: "pomtree/agent:dev", demo: "pomtree/agent:demo" });
  assert.match(buildScript, /"--target",\s+target,/);
  const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["build:image:demo"], "node scripts/build.ts --target demo");
});
