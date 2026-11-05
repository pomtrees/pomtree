// Pure revision check for the Docker-gated e2e suites: a default or leftover image built from an older commit makes
// the suite fail with an opaque agent error, so a mismatch is a skip reason that names both revisions.
// `sourcesDirty` is true when packages/agent-image or packages/sandbox-docker differ from `expected` or have untracked
// files; the caller computes it with git, and the rule is the one in packages/sandbox-docker/src/docker-gate.ts.
export function imageRevisionSkip(image: string, actual: string | undefined, expected: string | undefined, sourcesDirty: boolean): string | false {
  if (!expected) return `cannot determine the current revision to match ${image} against`;
  if (sourcesDirty) return `adapter/image sources differ from ${expected} or have untracked files; commit them before Docker gates`;
  if (!actual) return `image ${image} has no org.opencontainers.image.revision label; rebuild it from this checkout`;
  if (actual.startsWith(expected) || expected.startsWith(actual)) return false;
  return `image ${image} was built from ${actual}, this checkout is ${expected}; rebuild it (AGENT_IMAGE_TAG=${image}) or set PTREE_E2E_IMAGE`;
}
