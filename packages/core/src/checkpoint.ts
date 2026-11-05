import { UnsupportedCheckpointVersion } from "./errors.ts";
import { CHECKPOINT_FORMAT, type Checkpoint } from "./types.ts";

// Read a stored checkpoint body: only CHECKPOINT_FORMAT is accepted; a missing or any other version throws.
export function checkpointOf(raw: Omit<Checkpoint, "version"> & { version?: number }): Checkpoint {
  if (raw.version !== CHECKPOINT_FORMAT) throw new UnsupportedCheckpointVersion(raw.version, CHECKPOINT_FORMAT);
  return { ...raw, version: raw.version };
}
