// Client/server revision skew detection: pomtreed runs from source (its own git sha) while the agent
// image bakes a `pomtree` CLI at build time (OCI label org.opencontainers.image.revision). When they
// drift, agents hit protocol errors the operator cannot see, so this module centralises the two
// revisions and a pure mismatch predicate. Both lookups are best-effort and memoised: a daemon not
// in a git checkout, an unlabelled/old image, or an unreachable engine yield undefined (unknown),
// never a throw.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION_LABEL } from "@pomtree/agent-image";
import { type BuildIdentity, formatBuildIdentity, REVISION_FILE, resolveBuildIdentity } from "@pomtree/core";
import { DOCKER_PROFILE, type LocalEngine, localEngineFrom } from "@pomtree/sandbox-docker";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

let identity: BuildIdentity | undefined;
// pomtreed's build identity (core build-identity.ts): the root package.json version, the export tool's
// REVISION file at the repo root if present, else git in the checkout. Best effort and memoised.
export function buildIdentity(): BuildIdentity {
  identity ??= resolveBuildIdentity({
    version: ((): string | undefined => {
      try {
        return (JSON.parse(readOptional(join(repoRoot, "package.json")) ?? "{}") as { version?: string }).version;
      } catch {
        return undefined;
      }
    })(),
    stamped: readOptional(join(repoRoot, REVISION_FILE)),
    git: (args) => {
      try {
        return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
      } catch {
        return undefined;
      }
    },
  });
  return identity;
}

// The one printed form: `v0.1.0 (abc1234)`, `v0.1.0* (abc1234)` dirty, `v0.1.0 (unknown revision)`.
export function buildVersion(): string {
  return formatBuildIdentity(buildIdentity());
}

// The short revision alone (no dirty flag), so the image comparison below matches revisions only.
// A daemon with neither a REVISION file nor a git checkout reports no sha.
export function gitSha(): string | undefined {
  return buildIdentity().revision;
}

const revisions = new Map<string, string | undefined>();
// The engine for callers that are not handed one (the Daemon's default when main.ts injects none): Docker on the CLI's own socket.
const defaultEngine = localEngineFrom({ profile: DOCKER_PROFILE });
// Best effort and memoised per engine and image: a missing image, an unlabelled image, or an unreachable engine yields undefined
// (unknown), never a throw. The engine's CLI is shelled out through the LocalEngine (no runtime dependency).
export function imageRevision(image: string, engine: Pick<LocalEngine, "binary" | "imageLabel"> = defaultEngine): string | undefined {
  const key = `${engine.binary}\0${image}`;
  if (!revisions.has(key)) revisions.set(key, engine.imageLabel(image, REVISION_LABEL));
  return revisions.get(key);
}

// True only when both revisions are known and unequal (an absent/unknown label is never a mismatch).
// Both are bare short shas: a dirty daemon checkout at the image's commit is not a mismatch.
export function revisionMismatch(git: string | undefined, image: string | undefined): boolean {
  return git !== undefined && image !== undefined && git !== image;
}
