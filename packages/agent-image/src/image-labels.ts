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
