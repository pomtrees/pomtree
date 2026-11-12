import type { DatabaseSync } from "node:sqlite";
import { assertImageArtifactFence, checkImageArtifact, replayOfImageArtifact } from "@pomtree/core";
import type { ImageArtifact, ImageArtifacts } from "@pomtree/core";
import type { Row } from "./db.ts";

// Baseline table (CREATE IF NOT EXISTS on every open). One row per (config_digest, backend); backend '' is the registry artifact
// (core ImageArtifact.backend null). The artifact is one JSON document beside the columns the fence and lookups need. There is no
// path column: rows hold ids and digests only.
export const IMAGE_ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS image_artifacts (config_digest TEXT NOT NULL, backend TEXT NOT NULL, generation INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (config_digest, backend));
`;

// Never pruned (store.ts IDEMPOTENCY_KEPT_SCOPES): a retry of a superseded write after the retention window must replay its original
// answer, never re-run and overwrite the newer row.
export const IMAGE_ARTIFACT_PUT_SCOPE = "imageArtifacts.put";

export interface ImageArtifactsDeps {
  db: DatabaseSync;
  once<T>(scope: string, key: string, fn: () => T, fingerprint?: string): T;
  fingerprintOf(...parts: unknown[]): string;
}

export function sqliteImageArtifacts(d: ImageArtifactsDeps): ImageArtifacts {
  const { db, once, fingerprintOf } = d;
  const read = (configDigest: string, backend: string | null): ImageArtifact | null => {
    const r = db.prepare("SELECT doc FROM image_artifacts WHERE config_digest=? AND backend=?").get(configDigest, backend ?? "") as Row | undefined;
    if (!r) return null;
    try {
      const a = JSON.parse(r.doc) as ImageArtifact;
      checkImageArtifact(a);
      if (a.configDigest !== configDigest || a.backend !== backend) throw new Error("its document names a different slot than its columns");
      return a;
    } catch (e) {
      throw new Error(
        `stored image artifact ${configDigest} (backend ${backend ?? "any"}) is invalid: ${e instanceof Error ? e.message : String(e)}; the store file is damaged: restore it from a backup or move the file aside and restart to re-initialize`,
      );
    }
  };
  return {
    async put(a) {
      checkImageArtifact(a);
      return once(
        IMAGE_ARTIFACT_PUT_SCOPE,
        a.idempotencyKey,
        () => {
          const stored = read(a.configDigest, a.backend);
          const replay = replayOfImageArtifact(stored, a);
          if (replay) return replay;
          assertImageArtifactFence(stored, a);
          db.prepare(
            "INSERT INTO image_artifacts (config_digest,backend,generation,doc) VALUES (?,?,?,?) ON CONFLICT(config_digest,backend) DO UPDATE SET generation=excluded.generation, doc=excluded.doc",
          ).run(a.configDigest, a.backend ?? "", a.generation, JSON.stringify(a));
          return structuredClone(a);
        },
        fingerprintOf("imageArtifacts.put", a),
      );
    },
    async get(configDigest, backend) {
      return read(configDigest, backend);
    },
  };
}
