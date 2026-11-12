// The agent image's identity labels and a pure reader of `docker image inspect` output, for consumers that must state which image
// ran (the run manifest's `image` fields, docs/demo.md, 'Image identity'). The Pi version is read from the image, never assumed from the build
// script: the Dockerfile stamps PI_VERSION_LABEL from the PI_VERSION build arg, whose one definition is the pin in scripts/build.ts.
export const PI_VERSION_LABEL = "org.pomtree.pi.version";
// The OCI revision label (short git sha) the Dockerfile stamps from AGENT_REVISION.
export const REVISION_LABEL = "org.opencontainers.image.revision";

// The build targets of packages/agent-image/Dockerfile. `full` is the default (and last) stage; `demo` is the slim image (docs/demo.md,
// 'The slim image'): no Chromium, fonts, Rust toolchain, compilers, Python or pi-browser.
export const IMAGE_TARGETS = ["full", "demo"] as const;
export type ImageTarget = (typeof IMAGE_TARGETS)[number];
export const DEFAULT_IMAGE_TAGS: Readonly<Record<ImageTarget, string>> = { full: "pomtree/agent:dev", demo: "pomtree/agent:demo" };

export interface ImageIdentity {
  // `docker image inspect .Id`: sha256 of the image config, so equal ids mean identical images.
  id: string;
  revision: string;
  piVersion: string;
}

// The argv (after `docker`) whose stdout parseImageInspect reads.
export function imageInspectArgv(ref: string): string[] {
  if (ref === "" || ref.startsWith("-")) throw new Error(`image reference ${JSON.stringify(ref)} is not a docker image reference`);
  return ["image", "inspect", "--", ref];
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{4,64}$/;
const PI_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REBUILD = "rebuild it with `pnpm --filter @pomtree/agent-image build:image`";

// Reads the identity of the one image `docker image inspect <ref>` printed. Throws, naming the ref and the fix, when the output is not
// one image, or when a label is missing or malformed (an image built before the label existed, or by hand without the build script).
export function parseImageInspect(ref: string, stdout: string): ImageIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`docker image inspect ${ref}: output is not JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`docker image inspect ${ref}: expected exactly one image`);
  const image = parsed[0] as { Id?: unknown; Config?: { Labels?: unknown } | null } | null;
  const id = image?.Id;
  if (typeof id !== "string" || !IMAGE_ID.test(id)) throw new Error(`docker image inspect ${ref}: no sha256 image id`);
  const labels = image?.Config?.Labels;
  const label = (name: string, shape: RegExp): string => {
    const value = labels && typeof labels === "object" ? (labels as Record<string, unknown>)[name] : undefined;
    if (value === undefined || value === "") throw new Error(`image ${ref} has no ${name} label; ${REBUILD}`);
    if (typeof value !== "string" || !shape.test(value)) throw new Error(`image ${ref} has a malformed ${name} label; ${REBUILD}`);
    return value;
  };
  return { id, revision: label(REVISION_LABEL, REVISION), piVersion: label(PI_VERSION_LABEL, PI_VERSION) };
}

// ---- Build engine selection and image identity (scripts/build.ts) ----------------------------------------------------------------
// The image's identity is its OCI config digest, never the engine's image id: Podman's `.Id` is the config digest without the
// `sha256:` prefix, but Docker with the containerd store reports an index or manifest digest there and `inspect` never shows the
// config digest. Everything below is pure so build.ts stays a thin shell over the engine binary.
export const BUILD_ENGINES = ["docker", "podman"] as const;
export type BuildEngine = (typeof BUILD_ENGINES)[number];

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const CONFIG_DIGEST = /^sha256:[0-9a-f]{64}$/;

// AGENT_IMAGE_ENGINE=docker|podman; unset means docker (the AGENT_IMAGE_TAG precedent). Anything else is refused.
export function parseBuildEngine(value: string | undefined): BuildEngine {
  if (value === undefined) return "docker";
  if ((BUILD_ENGINES as readonly string[]).includes(value)) return value as BuildEngine;
  throw new Error(`AGENT_IMAGE_ENGINE=${JSON.stringify(value)} is not a build engine; set it to ${BUILD_ENGINES.join(" or ")}, or unset it for docker`);
}

export interface BuildPlanInput {
  engine: BuildEngine;
  dockerfile: string;
  target: ImageTarget;
  tag: string;
  bundleDir: string;
  buildArgs: readonly string[];
  root: string;
  // AGENT_IMAGE_CACHE_DIR, already checked non-empty: docker only (buildx cache export).
  cacheDir?: string | undefined;
  // Where the engine writes the build result: buildx `--metadata-file` (docker) or `--iidfile` (podman).
  resultFile: string;
}

// The binary and argv of the one build command. Docker always goes through buildx: `--metadata-file` is a buildx flag, and
// `--provenance=false` keeps the result a single image manifest, the only case in which buildx emits `containerimage.config.digest`
// (without it the result is an index and the key is absent). Podman pins `--format oci` explicitly because BUILDAH_FORMAT=docker
// overrides the default, and a docker-format to OCI conversion changes the config digest. `--metadata-file` is refused by Podman in
// remote mode (macOS), so Podman reads the digest from `--iidfile`.
export function buildCommand(p: BuildPlanInput): { binary: BuildEngine; argv: string[] } {
  const common = ["-f", p.dockerfile, "--target", p.target, "-t", p.tag, "--build-context", `bundle=${p.bundleDir}`, ...p.buildArgs];
  if (p.engine === "podman") {
    if (p.cacheDir !== undefined)
      throw new Error(
        "AGENT_IMAGE_CACHE_DIR needs buildx, which only docker has; unset AGENT_IMAGE_CACHE_DIR to build with podman, or set AGENT_IMAGE_ENGINE=docker",
      );
    return { binary: "podman", argv: ["build", "--format", "oci", "--iidfile", p.resultFile, ...common, p.root] };
  }
  const cache = p.cacheDir ? ["--cache-from", `type=local,src=${p.cacheDir}`, "--cache-to", `type=local,dest=${p.cacheDir},mode=max`] : [];
  return { binary: "docker", argv: ["buildx", "build", "--load", "--provenance=false", "--metadata-file", p.resultFile, ...common, ...cache, p.root] };
}

export interface BuiltImage {
  configDigest: string;
  // The manifest media type when the engine reported it (buildx descriptor), else undefined (Podman is pinned to OCI by --format oci).
  mediaType?: string | undefined;
}

function normalizeDigest(raw: string, what: string, action: string): string {
  const t = raw.trim();
  const d = /^[0-9a-f]{64}$/.test(t) ? `sha256:${t}` : t;
  if (!CONFIG_DIGEST.test(d)) throw new Error(`${what} is not a sha256 config digest (${JSON.stringify(t.slice(0, 80))}); ${action}`);
  return d;
}

// Podman: the `--iidfile` content (`sha256:<hex>`) or `podman image inspect --format '{{.Id}}'` output (bare hex); both are the config digest.
export function parsePodmanImageId(stdout: string): BuiltImage {
  return { configDigest: normalizeDigest(stdout, "podman image id", "rebuild with `AGENT_IMAGE_ENGINE=podman`, and report this output if it persists") };
}

// Docker: buildx `--metadata-file` JSON. Returns undefined when the config digest key is absent (the result was an index, or the
// engine did not emit it) so the caller falls back to `docker save`; throws on a malformed file or a non-manifest media type.
export function parseBuildxMetadata(json: string): BuiltImage | undefined {
  let meta: unknown;
  try {
    meta = JSON.parse(json);
  } catch {
    throw new Error("buildx metadata file is not JSON; check that `docker buildx version` works and rebuild");
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta))
    throw new Error("buildx metadata file is not a JSON object; rebuild with a current buildx");
  const m = meta as Record<string, unknown>;
  const raw = m["containerimage.config.digest"];
  const descriptor = m["containerimage.descriptor"];
  const rawType = descriptor && typeof descriptor === "object" ? (descriptor as { mediaType?: unknown }).mediaType : undefined;
  const mediaType = typeof rawType === "string" ? rawType : undefined;
  // An index or an unknown type means attestations leaked in or the format is not one we pin; the digest would not be the image config.
  if (mediaType !== undefined && mediaType !== OCI_MANIFEST && mediaType !== DOCKER_MANIFEST)
    throw new Error(
      `built image manifest media type is ${JSON.stringify(mediaType)}, expected ${OCI_MANIFEST} or ${DOCKER_MANIFEST}; rebuild with --provenance=false and a current buildx`,
    );
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("buildx metadata containerimage.config.digest is not a string; rebuild with a current buildx");
  const configDigest = normalizeDigest(raw, "buildx containerimage.config.digest", "rebuild with a current buildx");
  return mediaType === undefined ? { configDigest } : { configDigest, mediaType };
}

// Docker fallback: `manifest.json` of a `docker save` archive, `[{ "Config": "blobs/sha256/<hex>" | "<hex>.json", ... }]`.
export function parseSaveManifest(json: string): BuiltImage {
  const action = "check `docker save <image>` works, or use AGENT_IMAGE_ENGINE=podman";
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`docker save manifest.json is not JSON; ${action}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`docker save manifest.json must hold exactly one image; ${action}`);
  const config = (parsed[0] as { Config?: unknown } | null)?.Config;
  const hex = typeof config === "string" ? /^(?:blobs\/sha256\/)?([0-9a-f]{64})(?:\.json)?$/.exec(config)?.[1] : undefined;
  if (hex === undefined) throw new Error(`docker save manifest.json has no sha256 Config entry; ${action}`);
  return { configDigest: `sha256:${hex}` };
}

// Docker when buildx gave no config digest: the saved archive's manifest.json, else fail closed (never the engine's `.Id`).
export function resolveDockerIdentity(metadataJson: string, readSaveManifest: () => string): BuiltImage {
  const fromMetadata = parseBuildxMetadata(metadataJson);
  if (fromMetadata) return fromMetadata;
  const fromSave = parseSaveManifest(readSaveManifest());
  const mediaType = parseBuildxMetadataMediaType(metadataJson);
  return mediaType === undefined ? fromSave : { ...fromSave, mediaType };
}

function parseBuildxMetadataMediaType(json: string): string | undefined {
  const d = (JSON.parse(json) as Record<string, { mediaType?: unknown } | undefined>)["containerimage.descriptor"];
  return typeof d?.mediaType === "string" ? d.mediaType : undefined;
}

// The engine-local image id (`docker image inspect --format '{{.Id}}'`, or Podman's iidfile): what existing consumers verify against the
// local store. NOT the identity: on Docker's containerd store it is an index or manifest digest, not the config digest.
export function parseEngineLocalId(stdout: string): string {
  return normalizeDigest(stdout, "engine image id", "rebuild the image and report this output if it persists");
}

// The result line build.ts prints: `<tag> <engineLocalId> <configDigest> [mediaType]`. Field 2 stays the engine-local id so that
// consumers that check it against the local store (agent.egressProxyImage) keep working; field 3 is the canonical identity.
export function buildResultLine(tag: string, engineLocalId: string, image: BuiltImage): string {
  return [tag, engineLocalId, image.configDigest, image.mediaType].filter((f) => f !== undefined).join(" ");
}

// Images are per engine store; a missing image names the store and prints the build command.
export function imageMissingMessage(engine: BuildEngine, ref: string, target: ImageTarget): string {
  const script = target === "full" ? "build:image" : `build:image:${target}`;
  return `image ${ref} is not in the ${engine} store (images are per engine store; an image built by the other engine is not visible here); build it with: AGENT_IMAGE_ENGINE=${engine} AGENT_IMAGE_TAG=${ref} pnpm --filter @pomtree/agent-image ${script}`;
}

// ---- Reading the built image's identity with injected I/O, and exit-path cleanup -----------------------------------------------------
export interface IdentityIo {
  // The engine's result file (buildx metadata JSON, or Podman's iidfile), undefined when it was not written.
  readResultFile(): string | undefined;
  // Runs `<binary> <args>` and returns stdout; throws the spawn error (`code: "ENOENT"` when the binary is missing).
  run(binary: BuildEngine, args: string[]): string;
  // The `manifest.json` of a `docker save` archive of the built image.
  readSaveManifest(): string;
}

function runStep(io: IdentityIo, binary: BuildEngine, args: string[], tag: string, target: ImageTarget): string {
  try {
    return io.run(binary, args);
  } catch (error) {
    const e = error as { code?: unknown; message?: string };
    if (e.code === "ENOENT") throw new Error(`${binary} was not found on PATH; install ${binary}, or set AGENT_IMAGE_ENGINE to the engine that built ${tag}`);
    if (binary === "podman" && args[0] === "image") throw new Error(imageMissingMessage("podman", tag, target));
    throw new Error(
      `\`${binary} ${args.slice(0, 2).join(" ")}\` failed (${e.message ?? "unknown error"}); check that the ${binary} engine is running and that ${tag} was built in its store`,
    );
  }
}

// The identity of the image just built: the engine-local id (existing consumers) and the config digest (canonical), or a thrown error
// naming the cause and the action. Fails closed: never substitutes the engine id for the config digest.
export function readBuiltIdentity(engine: BuildEngine, tag: string, target: ImageTarget, io: IdentityIo): { image: BuiltImage; localId: string } {
  if (engine === "podman") {
    const fromFile = io.readResultFile()?.trim();
    const image = parsePodmanImageId(fromFile || runStep(io, "podman", ["image", "inspect", "--format", "{{.Id}}", tag], tag, target));
    return { image, localId: image.configDigest }; // Podman `.Id` is the config digest
  }
  const metadata = io.readResultFile();
  if (metadata === undefined) throw new Error("the buildx metadata file was not written by the build; check that `docker buildx version` works, then rebuild");
  const image = resolveDockerIdentity(metadata, () => {
    try {
      return io.readSaveManifest();
    } catch (error) {
      const e = error as { code?: unknown; message?: string };
      throw new Error(
        e.code === "ENOENT"
          ? "docker or tar was not found on PATH, so the config digest could not be read from `docker save`; install it, or use AGENT_IMAGE_ENGINE=podman"
          : `reading the config digest from \`docker save ${tag}\` failed (${e.message ?? "unknown error"}); check that the docker engine is running and ${tag} was built in its store`,
      );
    }
  });
  const localId = parseEngineLocalId(runStep(io, "docker", ["image", "inspect", "--format", "{{.Id}}", tag], tag, target));
  return { image, localId };
}

// Runs `work`; on a throw reports it and sets the failure, and always runs `cleanup`. Used instead of `process.exit` so temp files go.
export function guarded(work: () => void, cleanup: () => void, report: (error: Error) => void): boolean {
  try {
    work();
    return true;
  } catch (error) {
    report(error as Error);
    return false;
  } finally {
    cleanup();
  }
}
