// Pure helpers for `pomtree state`: local validation, argument parsing, file formats, rendering. No I/O.
// This module imports nothing from core: the key/owner/prefix rules are local copies, which keeps it dependency-free (the image does
// ship core in /node_modules, so this is a choice, not a limit). `state.test.ts` pins every copy against core's definitions on a shared table.
import { stripControl } from "./sanitize.ts";

export const STATE_KEY_MAX_LENGTH_LOCAL = 128;
export const STATE_KEY_RE_LOCAL = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
export const STATE_OWNER_RE_LOCAL = /^[a-z0-9][a-z0-9_-]*$/;
const STATE_PREFIX_RE_LOCAL = /^[a-z0-9._/-]+$/;
export const STATE_IMPORT_MAX_DOCS_LOCAL = 1000; // the daemon's per-call import cap (pomtreed STATE_IMPORT_MAX_DOCS)

export const validKey = (key: string): boolean => key.length <= STATE_KEY_MAX_LENGTH_LOCAL && !key.includes("..") && STATE_KEY_RE_LOCAL.test(key);
export const validOwner = (owner: string): boolean => owner.length <= STATE_KEY_MAX_LENGTH_LOCAL && STATE_OWNER_RE_LOCAL.test(owner);
export const validPrefix = (prefix: string): boolean =>
  prefix.length > 0 && prefix.length <= STATE_KEY_MAX_LENGTH_LOCAL && !prefix.includes("..") && STATE_PREFIX_RE_LOCAL.test(prefix);

// "30d", "12h", "90m", "45s", "500ms"; a bare integer is milliseconds (as elsewhere in the CLI).
export function parseOlderThan(raw: string): number {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw);
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m?.[2] ?? "ms") as "ms"];
  const ms = m ? Number(m[1]) * factor : Number.NaN;
  if (!Number.isSafeInteger(ms)) throw new Error(`--older-than must be a duration such as 30d or 12h, got "${raw}"`);
  return ms;
}

// "none" = the document must not exist yet (expectRev null); otherwise a non-negative integer revision.
export function parseExpectRev(raw: string): number | null {
  if (raw === "none") return null;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`--expect-rev must be a non-negative integer or "none", got "${raw}"`);
  return n;
}

export interface ImportDoc {
  key: string;
  value: unknown;
}

// The daemon caps a JSON request body at 1 MiB; an import batch stays under this, leaving room for the envelope.
export const STATE_IMPORT_BATCH_BYTES = 900 * 1024;

// Splits an import into consecutive batches whose serialized docs total at most `maxBytes` (a single larger doc is its own batch) and
// at most STATE_IMPORT_MAX_DOCS_LOCAL docs, so each batch is one request the daemon accepts. Order is preserved.
export function chunkImportDocs(docs: ImportDoc[], maxBytes = STATE_IMPORT_BATCH_BYTES): ImportDoc[][] {
  const out: ImportDoc[][] = [];
  let cur: ImportDoc[] = [];
  let bytes = 0;
  for (const d of docs) {
    const n = Buffer.byteLength(JSON.stringify(d)) + 1;
    if (cur.length > 0 && (bytes + n > maxBytes || cur.length >= STATE_IMPORT_MAX_DOCS_LOCAL)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(d);
    bytes += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// An export file is {owner, docs:[{key, rev?, value}]}. Import ignores owner and rev (the owner is the command's argument).
export function parseImportFile(text: string): ImportDoc[] {
  let f: unknown;
  try {
    f = JSON.parse(text);
  } catch (e) {
    throw new Error(`import file is not valid JSON: ${(e as Error).message}`);
  }
  const docs = typeof f === "object" && f !== null ? (f as { docs?: unknown }).docs : undefined;
  if (!Array.isArray(docs)) throw new Error("import file must be an object with a docs array");
  if (docs.length < 1 || docs.length > STATE_IMPORT_MAX_DOCS_LOCAL)
    throw new Error(`import file must hold 1 to ${STATE_IMPORT_MAX_DOCS_LOCAL} docs, has ${docs.length}`);
  const seen = new Set<string>();
  return docs.map((d, i) => {
    const o = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { key?: unknown; value?: unknown }) : null;
    if (!o || typeof o.key !== "string" || !validKey(o.key)) throw new Error(`docs[${i}]: invalid state key ${JSON.stringify(o?.key)}`);
    if (!("value" in o)) throw new Error(`docs[${i}] (${o.key}): missing value`);
    if (seen.has(o.key)) throw new Error(`docs[${i}]: duplicate key ${o.key}`);
    seen.add(o.key);
    return { key: o.key, value: o.value };
  });
}

// One line for a failed state call: the daemon's message, plus the current revision on a CAS conflict.
export function stateErrorMessage(status: number, body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; kind?: unknown; reason?: unknown; currentRev?: unknown };
  const base = typeof b.error === "string" && b.error ? stripControl(b.error) : `HTTP ${status}`;
  if (b.reason === "conflict")
    return `${base}: current rev is ${typeof b.currentRev === "number" ? b.currentRev : "unknown"} (re-read, then retry with --expect-rev)`;
  if (status === 409 && typeof b.kind === "string") return `${base} (${stripControl(b.kind)})`;
  if (status === 413) return `${base} (document or request too large)`;
  if (status === 503) return `${base} (state store unavailable; retry later)`;
  return base;
}

export interface MetaRow {
  key: string;
  rev: number;
  bytes: number;
  updatedAt: number;
}

export function renderStateList(docs: MetaRow[], next: string | undefined, rowsToTable: (rows: string[][]) => string, age: (ms: number) => string): string {
  if (!docs.length) return "no state documents";
  const t = rowsToTable([["KEY", "REV", "BYTES", "AGE"], ...docs.map((d) => [stripControl(d.key), String(d.rev), String(d.bytes), age(d.updatedAt)])]);
  return next === undefined ? t : `${t}\n(more after ${stripControl(next)})`;
}

export function renderStateDoc(d: { owner: string; key: string; rev: number; bytes: number; value: unknown }): string {
  return stripControl(`${d.owner}/${d.key}  rev ${d.rev}  ${d.bytes} bytes\n${JSON.stringify(d.value, null, 2)}`);
}
