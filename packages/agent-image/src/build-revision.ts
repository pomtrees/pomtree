// The revision and version the image build bakes (scripts/build.ts), derived through core's resolveBuildIdentity so a
// stamped REVISION file (an exported tree has no .git) wins, else git, else unknown. Pure: build.ts injects the reads.
import { type BuildIdentitySources, resolveBuildIdentity } from "@pomtree/core";

export interface BakedIdentity {
  revision: string; // short sha, or "" when unknown: an empty label/file reads back as unknown, so pomtreed's mismatch warning stays quiet
  version: string | undefined;
  notice: string | undefined; // one operator line when no revision is available
}

export function bakedIdentity(sources: BuildIdentitySources): BakedIdentity {
  const { version, revision } = resolveBuildIdentity(sources);
  return {
    revision: revision ?? "",
    version,
    notice:
      revision === undefined ? "agent image: no revision available (no REVISION file and no git checkout); the image is built without a revision" : undefined,
  };
}
