import { test } from "node:test";
import assert from "node:assert/strict";
import { assertImageArtifactFence, checkImageArtifact, looksLikeLocalPath, replayOfImageArtifact, StaleGenerationError } from "./index.ts";
import type { ImageArtifact } from "./index.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const art = (over: Partial<ImageArtifact> = {}): ImageArtifact => ({
  configDigest: DIGEST,
  revision: null,
  engineLocalId: null,
  backend: "e2b",
  hostId: "h",
  generation: 1,
  idempotencyKey: "k",
  ...over,
});

test("looksLikeLocalPath flags paths and file URLs", () => {
  for (const p of ["/x", "../x", "./x", "~/x", "C:\\x", "\\\\h\\s", "file:///x", "a/../b", "a\\b"]) assert.equal(looksLikeLocalPath(p), true, p);
});

test("looksLikeLocalPath passes registry refs, digests and provider template ids", () => {
  for (const p of ["ghcr.io/o/a:t", `a@sha256:${"b".repeat(64)}`, "b".repeat(64), "ns/templates/x", "localhost:5000/a"])
    assert.equal(looksLikeLocalPath(p), false, p);
});

test("checkImageArtifact bounds the digest, host, generation and backend", () => {
  checkImageArtifact(art());
  checkImageArtifact(art({ backend: null, generation: 0, providerImage: "ns/templates/x", sourceConfigDigest: DIGEST }));
  const bad: [Partial<ImageArtifact>, RegExp][] = [
    [{ configDigest: "sha256:abc" }, /configDigest/],
    [{ configDigest: `sha256:${"A".repeat(64)}` }, /configDigest/],
    [{ configDigest: `sha512:${"a".repeat(64)}` }, /configDigest/],
    [{ sourceConfigDigest: "x" }, /sourceConfigDigest/],
    [{ hostId: "" }, /hostId/],
    [{ generation: -1 }, /generation/],
    [{ generation: 1.5 }, /generation/],
    [{ generation: Number.MAX_SAFE_INTEGER + 1 }, /generation/],
    [{ backend: "E2B" }, /backend/],
    [{ backend: "a b" }, /backend/],
    [{ backend: "" }, /backend/],
    [{ idempotencyKey: "" }, /idempotencyKey/],
    [{ providerImage: "/tmp/x" }, /local path/],
    [{ engineLocalId: "" }, /engineLocalId/],
  ];
  for (const [over, re] of bad) assert.throws(() => checkImageArtifact(art(over)), re, JSON.stringify(over));
  assert.throws(() => checkImageArtifact(art({ generation: 1.5 })), /pass the owner's current generation/); // names the action
});

test("the fence refuses only a lower generation", () => {
  assertImageArtifactFence(null, art());
  assertImageArtifactFence(art({ generation: 2 }), art({ generation: 2 }));
  assertImageArtifactFence(art({ generation: 2 }), art({ generation: 3 }));
  assert.throws(() => assertImageArtifactFence(art({ generation: 2 }), art({ generation: 1 })), StaleGenerationError);
});

test("replayOfImageArtifact returns the stored row for the same key, conflicts on other content, and ignores other keys", () => {
  const stored = art({ providerImage: "t" });
  assert.equal(replayOfImageArtifact(null, art()), null);
  assert.equal(replayOfImageArtifact(stored, art({ idempotencyKey: "other" })), null);
  assert.equal(replayOfImageArtifact(stored, { ...stored }), stored);
  assert.throws(() => replayOfImageArtifact(stored, art({ providerImage: "u" })), { code: "idempotency_conflict" });
});
