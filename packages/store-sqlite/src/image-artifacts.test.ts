import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StaleGenerationError } from "@pomtree/core";
import type { ImageArtifact } from "@pomtree/core";
import { FakeImageArtifacts, imageArtifactsContractBody, tmpDir } from "@pomtree/testing";
import { openStore } from "./store.ts";

const DIGEST = `sha256:${"c".repeat(64)}`;
const art = (over: Partial<ImageArtifact> = {}): ImageArtifact => ({
  configDigest: DIGEST,
  revision: null,
  engineLocalId: null,
  providerImage: "tmpl-1",
  backend: "e2b",
  hostId: "h",
  generation: 1,
  idempotencyKey: "k1",
  ...over,
});
const file = (): string => join(tmpDir("image-artifacts-"), "s.sqlite");

test("fake and sqlite ImageArtifacts satisfy one contract", async () => {
  await imageArtifactsContractBody({ imageArtifacts: new FakeImageArtifacts() });
  const s = openStore(file());
  try {
    await imageArtifactsContractBody({ imageArtifacts: s.imageArtifacts });
  } finally {
    s.close();
  }
});

test("the same key and content leaves one row; a different content under the key is a conflict", async () => {
  const path = file();
  const s = openStore(path);
  try {
    await s.imageArtifacts.put(art());
    await s.imageArtifacts.put(art());
    await assert.rejects(() => s.imageArtifacts.put(art({ providerImage: "tmpl-2" })), { code: "idempotency_conflict" });
  } finally {
    s.close();
  }
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM image_artifacts").get() as { n: number }).n, 1);
  raw.close();
});

test("a stale generation is refused and the stored row survives a reopen", async () => {
  const path = file();
  let s = openStore(path);
  await s.imageArtifacts.put(art({ generation: 5 }));
  await assert.rejects(() => s.imageArtifacts.put(art({ generation: 4, idempotencyKey: "k2", providerImage: "tmpl-9" })), StaleGenerationError);
  s.close();
  s = openStore(path);
  try {
    assert.equal((await s.imageArtifacts.get(DIGEST, "e2b"))?.providerImage, "tmpl-1");
  } finally {
    s.close();
  }
});

test("reading a malformed stored row fails with the cause and the action", async () => {
  const path = file();
  const s = openStore(path);
  await s.imageArtifacts.put(art());
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE image_artifacts SET doc=?").run(JSON.stringify({ ...art(), providerImage: "/home/u/img" }));
  raw.close();
  try {
    await assert.rejects(() => s.imageArtifacts.get(DIGEST, "e2b"), /looks like a local path.*restore it from a backup or move the file aside/s);
    const raw2 = new DatabaseSync(path);
    raw2.prepare("UPDATE image_artifacts SET doc='not json'").run();
    raw2.close();
    await assert.rejects(() => s.imageArtifacts.get(DIGEST, "e2b"), /is invalid.*move the file aside/s);
  } finally {
    s.close();
  }
});

test("a store file without the image_artifacts table gains it on open, empty (additive like the capture tables)", async () => {
  const path = file();
  openStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP TABLE image_artifacts");
  raw.close();
  const s = openStore(path);
  try {
    assert.equal(await s.imageArtifacts.get(DIGEST, "e2b"), null);
    await s.imageArtifacts.put(art());
    assert.equal((await s.imageArtifacts.get(DIGEST, "e2b"))?.providerImage, "tmpl-1");
  } finally {
    s.close();
  }
});

test("the table has no path column and a path-looking reference is rejected", async () => {
  const path = file();
  const s = openStore(path);
  try {
    const cols = (new DatabaseSync(path).prepare("PRAGMA table_info(image_artifacts)").all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ["config_digest", "backend", "generation", "doc"]);
    assert.ok(!cols.some((c) => /path|dir|file/i.test(c)));
    await assert.rejects(() => s.imageArtifacts.put(art({ engineLocalId: "/var/lib/docker/image/x" })), /looks like a local path/);
    await assert.rejects(() => s.imageArtifacts.put(art({ configDigest: "sha256:short", idempotencyKey: "k9" })), /configDigest/);
  } finally {
    s.close();
  }
});

test("a retry of a superseded write after idempotency pruning replays its original answer and does not overwrite the newer row", async () => {
  const s = openStore(file());
  try {
    const k1 = await s.imageArtifacts.put(art({ generation: 2, idempotencyKey: "K1", providerImage: "tmpl-k1" }));
    await s.imageArtifacts.put(art({ generation: 2, idempotencyKey: "K2", providerImage: "tmpl-k2" })); // equal generation: last write wins
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); // pruneIdempotency removes rows strictly older than now
    s.pruneIdempotency(0);
    assert.deepEqual(await s.imageArtifacts.put(art({ generation: 2, idempotencyKey: "K1", providerImage: "tmpl-k1" })), k1);
    assert.equal((await s.imageArtifacts.get(DIGEST, "e2b"))?.providerImage, "tmpl-k2");
  } finally {
    s.close();
  }
});

test("the stored row records its key, so replay is safe even when the idempotency row is gone", async () => {
  const path = file();
  const s = openStore(path);
  try {
    const first = await s.imageArtifacts.put(art({ idempotencyKey: "K1" }));
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM idempotency WHERE scope='imageArtifacts.put'").run();
    raw.close();
    assert.deepEqual(await s.imageArtifacts.put(art({ idempotencyKey: "K1" })), first);
    const raw2 = new DatabaseSync(path);
    raw2.prepare("DELETE FROM idempotency WHERE scope='imageArtifacts.put'").run();
    raw2.close();
    await assert.rejects(() => s.imageArtifacts.put(art({ idempotencyKey: "K1", providerImage: "tmpl-other" })), { code: "idempotency_conflict" });
    assert.equal((await s.imageArtifacts.get(DIGEST, "e2b"))?.providerImage, "tmpl-1");
  } finally {
    s.close();
  }
});
