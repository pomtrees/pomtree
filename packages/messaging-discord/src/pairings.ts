import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Persisted sender pairings: the Discord user ids an operator approved with `!approve` or the
// Approve button. The file is plain JSON, one object: `{ "version": 1, "paired": ["<user id>", ...] }`.
//
// The file is read once at startup. Hand edits and revocations need an adapter restart to take
// effect. A running adapter's next approval rewrites the file from its in-memory set, so a
// hand edit made while it runs is lost on that write.

// The pairing-state boundary (injectable; the real one is the visible file below).
export interface PairingStore {
  read(): Promise<string[]>;
  write(ids: readonly string[]): Promise<void>;
}

// Parses the pairings file text. Anything malformed throws, so the caller fails closed.
export function parsePairings(text: string): string[] {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("pairings file must be a JSON object");
  const { version, paired } = raw as Record<string, unknown>;
  if (version !== 1) throw new Error("pairings file version must be 1");
  if (!Array.isArray(paired) || paired.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new Error("pairings file paired must be an array of non-empty strings");
  }
  return [...new Set(paired as string[])].sort();
}

export function formatPairings(ids: readonly string[]): string {
  return `${JSON.stringify({ version: 1, paired: [...new Set(ids)].sort() }, null, 2)}\n`;
}

// The real pairing store. A missing file is no pairings; any other read or parse error throws.
// Writes go to a sibling temp file (0600) and are renamed over the target. rename makes the
// replace atomic within the filesystem, but there is no fsync: after a power loss the file can
// be left bad, and a bad file fails closed at load.
export function filePairingStore(path: string): PairingStore {
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      return parsePairings(text);
    },
    async write(ids) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(tmp, formatPairings(ids), { mode: 0o600, flag: "wx" });
        await rename(tmp, path);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
    },
  };
}

// The errno code of a failed fs call (e.g. EACCES), or "write failed" for anything else. Used in
// channel replies, which must not carry absolute paths or other fs message text.
export function errorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "write failed";
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
