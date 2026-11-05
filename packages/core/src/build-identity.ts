// Build identity: the one string every surface prints for "which build is this" (`pomtree --version`,
// `pomtreed --version`, `pomtree doctor`, the pomtreed listening line). Pure: the shells inject the reads.
//
// Precedence: a stamped revision wins and implies a clean build. Two files are stamped: REVISION at
// the repo root, written by the export tool when it cuts and tags a release tree (that tag's commit
// is the export's, not this repo's, so git in the exported tree cannot name it), and the agent
// image's baked /opt/pomtree/pomtree/revision, written by the image build (which has no dirty check,
// so an image never carries the dirty flag). Otherwise `git rev-parse --short HEAD` names the
// revision and a non-empty `git status --porcelain --untracked-files=no` marks it dirty (untracked
// files are ignored, as `git describe --dirty` does). With neither, the revision is unknown.

// The stamped revision file at the repo root. Content: the short commit sha on its first line.
export const REVISION_FILE = "REVISION";

export interface BuildIdentity {
  version: string | undefined; // the root package.json version (e.g. "0.1.0"); undefined when unreadable
  revision: string | undefined; // short commit sha; undefined when unknown
  dirty: boolean; // uncommitted tracked changes in the source tree; never true for a stamped revision
}

export interface BuildIdentitySources {
  version: string | undefined;
  stamped: string | undefined; // a stamped revision file's contents, or undefined when absent/unreadable
  git: (args: readonly string[]) => string | undefined; // git's stdout in the source tree, or undefined when git fails
}

export function resolveBuildIdentity(s: BuildIdentitySources): BuildIdentity {
  const version = s.version?.trim() || undefined;
  const stamped = s.stamped?.split("\n")[0]?.trim();
  if (stamped) return { version, revision: stamped, dirty: false };
  const revision = s.git(["rev-parse", "--short", "HEAD"])?.trim() || undefined;
  if (revision === undefined) return { version, revision: undefined, dirty: false };
  const status = s.git(["status", "--porcelain", "--untracked-files=no"]);
  return { version, revision, dirty: status !== undefined && status.trim() !== "" };
}

// `v0.1.0 (abc1234)`, `v0.1.0* (abc1234)` when dirty, `v0.1.0 (unknown revision)` when no revision is known.
export function formatBuildIdentity(id: BuildIdentity): string {
  const version = id.version === undefined ? "unknown version" : `v${id.version}`;
  return `${version}${id.dirty ? "*" : ""} (${id.revision ?? "unknown revision"})`;
}
