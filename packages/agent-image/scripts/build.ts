import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bakedIdentity } from "../src/build-revision.ts";
import { REVISION_FILE } from "@pomtree/core";
import { DEFAULT_IMAGE_TAGS, IMAGE_TARGETS, type ImageTarget } from "../src/image-labels.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// `--target demo` builds the slim fake-model demo image (docs/demo.md, 'The slim image'); the default is the full image.
const targetArg = process.argv.slice(2);
if (targetArg.length > 0 && !(targetArg.length === 2 && targetArg[0] === "--target"))
  throw new Error(`usage: node scripts/build.ts [--target ${IMAGE_TARGETS.join("|")}]`);
const target = (targetArg[1] ?? "full") as ImageTarget;
if (!IMAGE_TARGETS.includes(target)) throw new Error(`unknown image target ${JSON.stringify(target)}; expected one of ${IMAGE_TARGETS.join(", ")}`);
const tag = process.env.AGENT_IMAGE_TAG ?? DEFAULT_IMAGE_TAGS[target];
// Baked revision and version (core build-identity.ts): the repo-root REVISION file if present (an exported tree has no .git),
// else `git rev-parse --short HEAD`, else none. Stamped into the image as an OCI label and /opt/pomtree/pomtree/revision (with
// the sibling /opt/pomtree/pomtree/version) so `pomtree --version` can report `v<version> (<sha>)`. No revision bakes empty.
const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
const baked = bakedIdentity({
  version: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version,
  stamped: readOptional(join(root, REVISION_FILE)),
  git: (args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  },
});
if (baked.notice) console.log(baked.notice);
const revision = baked.revision;
const version = baked.version ?? "";

// Sole Pi version authority. On bump, update the npm integrity alongside this pin (no fallback). The Dockerfile stamps it as the
// org.pomtree.pi.version label (PI_VERSION_LABEL in src/image-labels.ts), so readers take it from the image, never from here.
const PI_VERSION = "1.5.1";
const PI_NPM_INTEGRITY = "sha512-rdu4pRvpQba2ep83nqHaN8L1pvY1OQ3i/2FucogA/eyRxwoUXMUXdk1Z9JnZFJR+9ck9Gs1ajuSb9m7Hz7ejYw==";

// Opt-in layer cache shared across builds (CI): AGENT_IMAGE_CACHE_DIR=<dir> makes buildx import from and export to a local cache directory
// (type=local, mode=max so the slow apt layers are kept). Unset (the default) is the plain `docker build` with no cache flags. Needs a
// buildx builder that supports cache export (the docker-container driver, e.g. docker/setup-buildx-action); `--load` puts the image
// in the local daemon as a plain build does. The image content and labels are the same either way.
const cacheDir = process.env.AGENT_IMAGE_CACHE_DIR;
if (cacheDir !== undefined && cacheDir.trim() === "")
  throw new Error("AGENT_IMAGE_CACHE_DIR is set but empty; unset it to build without a cache, or set it to a directory path");
const cache = cacheDir
  ? { builder: ["buildx", "build", "--load"], flags: ["--cache-from", `type=local,src=${cacheDir}`, "--cache-to", `type=local,dest=${cacheDir},mode=max`] }
  : { builder: ["build"], flags: [] as string[] };

const buildArgs = [
  "--build-arg",
  `AGENT_REVISION=${revision}`,
  "--build-arg",
  `AGENT_VERSION=${version}`,
  "--build-arg",
  `PI_VERSION=${PI_VERSION}`,
  "--build-arg",
  `PI_NPM_INTEGRITY=${PI_NPM_INTEGRITY}`,
];

// pomtree imports @pomtree/observe at runtime, but node 24 refuses to type-strip TS that lives under
// node_modules. So every workspace package pomtree depends on must ship as compiled JS. Derive that set
// from pomtree's own workspace deps (currently core + observe), compile each to JS with the repo's tsc
// (offline-deterministic: no npm install), and hand docker the result as the `bundle` build context;
// the Dockerfile copies it into /node_modules, the one location resolvable from both pomtree's src
// (/opt/pomtree/pomtree/src) and the /workspace working dir.
const bundleDir = mkdtempSync(join(tmpdir(), "pomtree-agent-bundle-"));
try {
  const pomtreePkg = JSON.parse(readFileSync(join(root, "packages/pomtree/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const name of Object.keys(pomtreePkg.dependencies ?? {}).filter((n) => n.startsWith("@pomtree/"))) {
    const subdir = name.slice("@pomtree/".length); // @pomtree/core -> packages/core
    const pkgDir = join(root, "packages", subdir);
    const outDir = join(bundleDir, "node_modules", name, "src");
    mkdirSync(outDir, { recursive: true });

    // Compile index.ts alone; tsc follows its relative imports, so test files and fixtures are
    // excluded. rewriteRelativeImportExtensions (in tsconfig.base) turns ./x.ts into ./x.js.
    const tsconfigPath = join(bundleDir, `${subdir}.tsconfig.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: join(root, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: false,
          declaration: false,
          sourceMap: false,
          typeRoots: [join(root, "node_modules", "@types")],
          outDir,
          rootDir: join(pkgDir, "src"),
        },
        files: [join(pkgDir, "src", "index.ts")],
      }),
    );
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", tsconfigPath], { stdio: "inherit" });

    // Stage a runtime package.json whose exports point at the compiled JS entry.
    const srcPkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      name: string;
      version: string;
      type?: string;
      exports?: unknown;
    };
    const rewriteTs = (v: unknown): unknown =>
      typeof v === "string"
        ? v.endsWith(".ts")
          ? `${v.slice(0, -3)}.js`
          : v
        : Array.isArray(v)
          ? v.map(rewriteTs)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, rewriteTs(val)]))
            : v;
    writeFileSync(
      join(bundleDir, "node_modules", name, "package.json"),
      `${JSON.stringify({ name: srcPkg.name, version: srcPkg.version, type: srcPkg.type ?? "module", exports: rewriteTs(srcPkg.exports) }, null, 2)}\n`,
    );
  }

  execFileSync(
    "docker",
    [
      ...cache.builder,
      "-f",
      join(root, "packages/agent-image/Dockerfile"),
      "--target",
      target,
      "-t",
      tag,
      "--build-context",
      `bundle=${bundleDir}`,
      ...buildArgs,
      ...cache.flags,
      root,
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(bundleDir, { recursive: true, force: true });
}

// TODO(demo-image): publish the slim demo image. Current behavior: this script builds and tags the demo target locally and never
// pushes.
const digest = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" }).trim();
console.log(`${tag} ${digest}`);
