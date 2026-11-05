// The seen set: story ids already published, so a later live run digests only NEW stories. It lives in the state database
// (owner hn-digest, key seen/hn, value { ids: [ascending], updatedAt }); the file format below is the interchange format of
// --seen-import / --seen-export and the validation rule for the stored value, so the two cannot drift:
// { "version": 1, "seen": [<positive integer ids, strictly ascending>], "updatedAt": "<ISO>" }.
// parseSeenFile/serializeSeenFile/mergeSeen are pure; createStoreSeen is the CAS shell over a StateStore; importSeenFile and
// exportSeenFile are the thin fs shell (lockfile + atomic write).
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StateStore } from "../../packages/core/src/index.ts";
import { SEEN_MAX, safeId } from "./content-contract.mts";

export class SeenFileError extends Error {}

// The seam the live entry depends on: where the seen ids live is the implementation's business. load() returns the ids sorted ascending
// (empty when nothing is stored yet); save() adds `ids` to what is stored (union, bounded at SEEN_MAX) and throws on failure.
export interface SeenStore {
  load(): Promise<number[]>;
  save(ids: readonly number[]): Promise<void>;
}

export const SEEN_OWNER = "hn-digest";
export const SEEN_KEY = "seen/hn";
export const SEEN_SAVE_ATTEMPTS = 5;

const KEYS = ["version", "seen", "updatedAt"];

export function parseSeenFile(text: string): { ok: true; ids: number[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not a JSON object" };
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k));
  if (extra.length > 0 || KEYS.some((k) => !(k in o))) return { ok: false, error: `keys must be exactly ${KEYS.join(", ")}` };
  if (o.version !== 1) return { ok: false, error: `unsupported version ${JSON.stringify(o.version)} (this build reads version 1)` };
  if (typeof o.updatedAt !== "string" || Number.isNaN(Date.parse(o.updatedAt))) return { ok: false, error: "updatedAt must be an ISO timestamp" };
  const seen = o.seen;
  if (!Array.isArray(seen) || !seen.every(safeId)) return { ok: false, error: "seen must be an array of positive integer story ids" };
  if (seen.length > SEEN_MAX) return { ok: false, error: `seen holds ${seen.length} ids; the limit is ${SEEN_MAX}` };
  if (seen.some((id, i) => i > 0 && id <= (seen[i - 1] as number))) return { ok: false, error: "seen must be sorted ascending without duplicates" };
  return { ok: true, ids: seen as number[] };
}

// Union, deduped and sorted; when over SEEN_MAX the highest (newest: HN ids only grow) ids are kept.
export function mergeSeen(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y).slice(-SEEN_MAX);
}

export const serializeSeenFile = (ids: readonly number[], now: Date): string =>
  `${JSON.stringify({ version: 1, seen: mergeSeen(ids, []), updatedAt: now.toISOString() }, null, 2)}\n`;

const staleHint = (path: string) =>
  `lock ${path}.lock exists: another run is exporting the seen file, or one died. If no run is active, delete that file and retry (it is never removed automatically)`;

// The stored value goes through parseSeenFile, so the stored and file rules are one definition.
function storedIds(value: unknown): number[] {
  const v = (typeof value === "object" && value !== null ? value : {}) as { ids?: unknown; updatedAt?: unknown };
  const parsed = parseSeenFile(JSON.stringify({ version: 1, seen: v.ids, updatedAt: v.updatedAt }));
  if (!parsed.ok)
    throw new SeenFileError(
      `stored seen state ${SEEN_OWNER}/${SEEN_KEY} is invalid: ${parsed.error}. Inspect it with \`pomtree state show ${SEEN_OWNER} ${SEEN_KEY}\`; reset it with \`pomtree state rm ${SEEN_OWNER} ${SEEN_KEY}\``,
    );
  return parsed.ids;
}

// The state-database implementation of SeenStore. save() is a compare-and-set merge: read the doc and its rev, union, put with
// expectRev under a fresh idempotency key (a conflict is a stored result, so a retry needs a new key), up to SEEN_SAVE_ATTEMPTS
// times. A save that adds nothing is not rewritten, so re-importing a file is idempotent. The writer is the operator: the digest is
// a standalone tool, not an agent.
export function createStoreSeen(state: StateStore, now: () => Date = () => new Date()): SeenStore {
  return {
    async load() {
      const doc = await state.get(SEEN_OWNER, SEEN_KEY);
      return doc ? storedIds(doc.value) : [];
    },
    async save(ids) {
      for (let attempt = 0; attempt < SEEN_SAVE_ATTEMPTS; attempt++) {
        const doc = await state.get(SEEN_OWNER, SEEN_KEY);
        const current = doc ? storedIds(doc.value) : [];
        const merged = mergeSeen(current, ids);
        if (doc && merged.length === current.length && merged.every((id, i) => id === current[i])) return;
        const r = await state.put(
          {
            owner: SEEN_OWNER,
            key: SEEN_KEY,
            value: { ids: merged, updatedAt: now().toISOString() },
            expectRev: doc ? doc.rev : null,
            writer: { operator: true },
          },
          randomUUID(),
        );
        if (r.ok) return;
      }
      throw new SeenFileError(`${SEEN_OWNER}/${SEEN_KEY} was changed concurrently on each of ${SEEN_SAVE_ATTEMPTS} attempts`);
    },
  };
}

// --seen-import: a missing, corrupt or wrong-version file is refused (nothing is read from or written to the database).
export function importSeenFile(path: string): number[] {
  if (!existsSync(path) || !statSync(path).isFile()) throw new SeenFileError(`seen import file ${path} does not exist or is not a regular file`);
  const parsed = parseSeenFile(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new SeenFileError(`seen import file ${path} is invalid: ${parsed.error}`);
  return parsed.ids;
}

// --seen-export, checked before the run: the directory must exist and no lock may be held. Returns the path with its parent realpathed.
export function prepareSeenExport(requested: string): string {
  let parent: string;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    throw new SeenFileError(`directory of seen export file ${requested} does not exist; create it first`);
  }
  const path = join(parent, basename(requested));
  if (existsSync(`${path}.lock`)) throw new SeenFileError(staleHint(path));
  if (existsSync(path) && !statSync(path).isFile()) throw new SeenFileError(`seen export file ${path} is not a regular file`);
  return path;
}

// Writes the full set under an O_EXCL lockfile; the content goes to a temp file in the same directory, is fsynced, then renamed over the
// old one. Throws SeenFileError with the path on any failure.
export function exportSeenFile(path: string, ids: readonly number[], now: Date): void {
  const lock = `${path}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  } catch (e) {
    throw new SeenFileError((e as NodeJS.ErrnoException).code === "EEXIST" ? staleHint(path) : `cannot create lock ${lock}: ${(e as Error).message}`);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeSync(fd, `${process.pid}\n`);
    const out = openSync(tmp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o644);
    try {
      writeSync(out, serializeSeenFile(ids, now));
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e instanceof SeenFileError ? e : new SeenFileError(`cannot write seen export file ${path}: ${(e as Error).message}`);
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {}
  }
}

// After the run: only a published run with ids to add touches the store. Failures propagate from store.save.
export async function recordSeen(store: SeenStore, outcome: string, entryIds: readonly number[]): Promise<{ written: boolean; total: number }> {
  if (outcome !== "published" || entryIds.length === 0) return { written: false, total: (await store.load()).length };
  await store.save(entryIds);
  return { written: true, total: (await store.load()).length };
}
