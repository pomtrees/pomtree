import { IdempotencyConflictError, StaleGenerationError } from "./errors.ts";
import type { ImageArtifact } from "./ports.ts";
import { isBackendId } from "./sandbox-backend.ts";

// Pure rules of the ImageArtifacts port, shared by the durable store and its fake so the two cannot drift.

const DIGEST = /^sha256:[0-9a-f]{64}$/;

// A reference that names a place on some machine instead of an image: absolute, relative or home paths, a file: URL, a Windows
// drive or UNC path, or anything with a backslash or a ".." segment. Registry refs ("ghcr.io/org/app:tag", "app@sha256:...") pass.
export const looksLikeLocalPath = (s: string): boolean =>
  s.startsWith("/") ||
  s.startsWith("./") ||
  s.startsWith("../") ||
  s.startsWith("~") ||
  /^file:/i.test(s) ||
  /^[A-Za-z]:[\\/]/.test(s) ||
  s.includes("\\") ||
  s.split("/").includes("..");

// Throws an Error naming the bad field and the action when the artifact could not be stored or trusted. Used on write and on read.
export function checkImageArtifact(a: ImageArtifact): void {
  const bad = (field: string, why: string, action: string): never => {
    throw new Error(`image artifact ${field} ${why}; ${action}`);
  };
  if (typeof a.configDigest !== "string" || !DIGEST.test(a.configDigest))
    bad("configDigest", `must be "sha256:<64 hex>", got ${JSON.stringify(a.configDigest)}`, "pass the image's OCI config digest");
  if (a.sourceConfigDigest !== undefined && (typeof a.sourceConfigDigest !== "string" || !DIGEST.test(a.sourceConfigDigest)))
    bad("sourceConfigDigest", `must be "sha256:<64 hex>", got ${JSON.stringify(a.sourceConfigDigest)}`, "pass the source image's OCI config digest");
  for (const [field, v] of [
    ["engineLocalId", a.engineLocalId],
    ["providerImage", a.providerImage],
  ] as const) {
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v === "") bad(field, "must be a non-empty string when present", "omit it or pass the image id or provider reference");
    else if (looksLikeLocalPath(v))
      bad(
        field,
        `looks like a local path (${JSON.stringify(v)}); records hold ids and digests only`,
        "record the engine image id, provider template id or registry reference instead",
      );
  }
  if (a.revision !== null && (typeof a.revision !== "string" || a.revision === ""))
    bad("revision", "must be null or a non-empty string", "pass the org.opencontainers.image.revision label or null");
  if (a.backend !== null && (typeof a.backend !== "string" || !/^[a-z0-9-]+$/.test(a.backend)))
    bad("backend", `must be null or [a-z0-9-]+, got ${JSON.stringify(a.backend)}`, "pass the sandbox backend id or null");
  if (typeof a.hostId !== "string" || a.hostId === "") bad("hostId", "must be a non-empty string", "pass the owning host id");
  if (!Number.isSafeInteger(a.generation) || a.generation < 0)
    bad("generation", `must be a non-negative safe integer, got ${a.generation}`, "pass the owner's current generation");
  if (typeof a.idempotencyKey !== "string" || a.idempotencyKey === "")
    bad("idempotencyKey", "must be a non-empty string", "pass the key of the call that produced the image");
}

// The slot an artifact occupies: one row per (configDigest, backend); a registry artifact (backend null) is its own slot.
export const imageArtifactSlot = (configDigest: string, backend: string | null): string => `${configDigest}@${backend ?? ""}`;

// The generation fence: a write below the slot's stored generation is refused. Equal or higher replaces the row. Decision: an equal
// generation with a different key and different content OVERWRITES (last write wins within a generation: generation orders owners,
// equal means the same owner); change this deliberately, the contract test pins it.
export function assertImageArtifactFence(stored: ImageArtifact | null, incoming: ImageArtifact): void {
  if (stored !== null && incoming.generation < stored.generation)
    throw new StaleGenerationError(imageArtifactSlot(incoming.configDigest, incoming.backend), incoming.generation, stored.generation);
}

// Canonical content equality: key order and absent-versus-undefined fields do not matter.
export const sameImageArtifact = (a: ImageArtifact, b: ImageArtifact): boolean =>
  JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

// Replay rule that holds without the shared idempotency table: the stored row records the key of the write that produced it, so a
// retry of that key returns the stored row (same content) or conflicts (different content), even after the key's table row is gone.
// Returns the stored row on a replay, null when the write is new.
export function replayOfImageArtifact(stored: ImageArtifact | null, incoming: ImageArtifact): ImageArtifact | null {
  if (stored === null || stored.idempotencyKey !== incoming.idempotencyKey) return null;
  if (!sameImageArtifact(stored, incoming)) throw new IdempotencyConflictError("imageArtifacts.put", incoming.idempotencyKey);
  return stored;
}
