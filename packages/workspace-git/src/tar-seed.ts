// Tar fallback for a workspace that is not a git repository (or a backend whose only verb is file put/get). Node built-ins only.
// The archive is plain ustar: no PAX, no compression (gzip output differs between zlib versions, so the hash would not be
// reproducible), entries sorted by path, mtime 0, owner 0:0, mode 0644 or 0755. Every limit is checked, and the whole entry
// set is validated (paths, duplicates, structure, symlink resolution) before the destination is touched; the destination must
// already be an existing empty directory, so a refused archive changes nothing. Names are compared case-folded and
// NFC-normalized, so an archive cannot rely on a case-insensitive or normalizing filesystem to merge two entries.
//
// Accepted entry kinds: regular file, directory, symlink whose target, resolved through the links in the archive itself
// (hop-capped, loops refused), stays inside the root. Everything else (hard link, device node, fifo, PAX header, absolute or
// `..` path, a path below a symlink or a file) is refused. Each write is also checked against the real destination path.
//
// Repository metadata: createTarSeed skips `.git` directories at any depth, which covers CREATION only. The parse side refuses
// any entry with a path segment that looks like `.git` (case-folded, NFC, zero-width and other ignorable code points removed,
// trailing spaces and dots dropped, or the 8.3 name `git~1`) and any symlink named like `.gitmodules`, so a return archive
// cannot write hooks or config into a checkout. Known limits: the fold ignores the wider set of HFS+-ignorable code points and
// Turkish dotted-I beyond that list; the empty-target check and the per-write realpath check are racy against a LOCAL attacker
// who can modify the target while extraction runs, which is outside the threat model (the target is a fresh private directory).

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";

export class TarSeedError extends Error {
  readonly reason: "hash-mismatch" | "partial" | "too-large" | "unsafe" | "unsupported";
  constructor(reason: TarSeedError["reason"], message: string) {
    super(message);
    this.name = "TarSeedError";
    this.reason = reason;
  }
}

export interface TarLimits {
  maxBytes: number; // whole archive
  maxFileBytes: number; // any single file
  maxEntries: number; // files, directories and symlinks together: each costs a header block, an inode and a validation step
}

export const DEFAULT_TAR_LIMITS: TarLimits = { maxBytes: 256 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024, maxEntries: 200_000 };

const tooManyEntries = (limits: TarLimits) =>
  new TarSeedError(
    "too-large",
    `archive has more than ${limits.maxEntries} entries, over the entry cap; exclude directories such as dependency trees or raise the cap`,
  );

export interface TarSeed {
  bytes: Uint8Array;
  sha256: string;
  size: number;
  fileCount: number;
}

const BLOCK = 512;

export interface TarEntry {
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  data: Buffer;
  target: string;
}

// A relative POSIX path that stays inside the root. Directories may carry one trailing slash.
export function checkTarPath(raw: string): string {
  const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const bad = (why: string) =>
    new TarSeedError(
      "unsafe",
      `tar entry path ${JSON.stringify(raw)} is refused (${why}); rebuild the archive from the workspace root with relative paths and exclude repository metadata`,
    );
  if (path === "") throw bad("empty");
  if (path.includes("\0") || path.includes("\\")) throw bad("NUL or backslash");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw bad("absolute");
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") throw bad("empty, `.` or `..` segment");
    if (isGitDirName(seg)) throw bad("a segment that looks like a .git directory");
  }
  return path;
}

// A symlink target must be relative and, resolved against the link's own directory, stay inside the root.
function checkSymlink(path: string, target: string): void {
  const bad = (why: string) =>
    new TarSeedError(
      "unsafe",
      `tar symlink ${JSON.stringify(path)} -> ${JSON.stringify(target)} is refused (${why}); remove the link or point it inside the workspace`,
    );
  if (target === "" || target.includes("\0") || target.includes("\\")) throw bad("empty or malformed target");
  if (target.startsWith("/")) throw bad("absolute target");
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === ".." || resolved.startsWith("../")) throw bad("escapes the workspace");
}

const MAX_LINK_HOPS = 40;
// Zero-width, bidi and variation-selector code points that some filesystems ignore when comparing names.
const IGNORABLE = new RegExp("[\\u00ad\\u034f\\u180b-\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u206a-\\u206f\\ufe00-\\ufe0f\\ufeff]", "g");
const looseName = (seg: string) =>
  seg
    .replace(IGNORABLE, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[ .]+$/, "");

// True for `.git`, `git~1` and their case, Unicode and trailing-dot or -space variants. Exported for the seed allowlist check.
export function isGitDirName(seg: string): boolean {
  const n = looseName(seg);
  return n === ".git" || n === "git~1";
}

export function isGitmodulesName(seg: string): boolean {
  const n = looseName(seg);
  return n === ".gitmodules" || n === "gitmod~1";
}
const foldKey = (path: string) => path.normalize("NFC").toLowerCase().normalize("NFC");

// Whole-set validation, no filesystem access: unique folded names, every ancestor is a directory entry (or absent, so created
// implicitly), and every symlink resolves, through the archive's own links, to a place inside the root.
export function validateEntries(entries: TarEntry[]): void {
  const byKey = new Map<string, TarEntry>();
  const unsafe = (message: string) => new TarSeedError("unsafe", message);
  for (const e of entries) {
    const key = foldKey(e.path);
    const other = byKey.get(key);
    if (other)
      throw unsafe(
        `tar entries ${JSON.stringify(other.path)} and ${JSON.stringify(e.path)} are the same name after case-folding or Unicode normalization; refused, rename one before archiving`,
      );
    byKey.set(key, e);
  }
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = byKey.get(foldKey(parts.slice(0, i).join("/")));
      if (anc && anc.kind !== "dir")
        throw unsafe(`tar entry ${JSON.stringify(e.path)} lies below ${JSON.stringify(anc.path)}, which is not a directory; refused, fix the archive's layout`);
    }
  }
  for (const e of entries) {
    if (e.kind !== "symlink") continue;
    if (isGitmodulesName(e.path.split("/").pop()!))
      throw unsafe(
        `tar symlink ${JSON.stringify(e.path)} is named like .gitmodules; refused, a symlinked .gitmodules can read or write outside the workspace, so exclude it`,
      );
    resolveLink(e, byKey);
  }
}

function resolveLink(link: TarEntry, byKey: Map<string, TarEntry>): void {
  const bad = (why: string) =>
    new TarSeedError(
      "unsafe",
      `tar symlink ${JSON.stringify(link.path)} -> ${JSON.stringify(link.target)} is refused (${why}); remove the link or point it inside the workspace`,
    );
  const stack = link.path.split("/").slice(0, -1);
  const queue = link.target.split("/");
  let hops = 0;
  while (queue.length) {
    const seg = queue.shift()!;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!stack.length) throw bad("escapes the workspace");
      stack.pop();
      continue;
    }
    stack.push(seg);
    const hit = byKey.get(foldKey(stack.join("/")));
    if (hit?.kind === "symlink") {
      if (++hops > MAX_LINK_HOPS) throw bad("symlink loop or more than 40 hops");
      stack.pop();
      queue.unshift(...hit.target.split("/"));
    }
  }
}

function octal(n: number, width: number): Buffer {
  return Buffer.from(`${n.toString(8).padStart(width - 1, "0")}\0`, "latin1");
}

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new TarSeedError("unsupported", `path ${JSON.stringify(path)} is too long for a ustar entry; shorten it or use the git bundle transfer`);
}

function header(e: TarEntry): Buffer {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(e.kind === "dir" ? `${e.path}/` : e.path);
  h.write(name, 0, "utf8");
  octal(e.mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(e.kind === "file" ? e.data.length : 0, 12).copy(h, 124);
  octal(0, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write(e.kind === "file" ? "0" : e.kind === "dir" ? "5" : "2", 156, "latin1");
  if (e.kind === "symlink") {
    if (Buffer.byteLength(e.target) > 100)
      throw new TarSeedError("unsupported", `symlink target of ${JSON.stringify(e.path)} is longer than 100 bytes; shorten it`);
    h.write(e.target, 157, "utf8");
  }
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  h.write(prefix, 345, "utf8");
  h.write(`${(h.reduce((a, b) => a + b, 0) & 0o777777).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}

export function packEntries(entries: TarEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(header(e));
    if (e.kind === "file" && e.data.length) {
      parts.push(e.data);
      const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

// Archive `root`. A `.git` directory, at any depth, is not carried (the git bundle path owns repositories).
export function createTarSeed(root: string, limits: TarLimits = DEFAULT_TAR_LIMITS): TarSeed {
  const entries: TarEntry[] = [];
  let total = 0;
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      if (isGitDirName(name)) continue;
      const path = rel ? `${rel}/${name}` : name;
      checkTarPath(path);
      if (entries.length >= limits.maxEntries) throw tooManyEntries(limits);
      const abs = join(root, path);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        entries.push({ path, kind: "dir", mode: 0o755, data: Buffer.alloc(0), target: "" });
        walk(path);
      } else if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        checkSymlink(path, target);
        entries.push({ path, kind: "symlink", mode: 0o777, data: Buffer.alloc(0), target });
      } else if (st.isFile()) {
        if (st.size > limits.maxFileBytes)
          throw new TarSeedError(
            "too-large",
            `file ${JSON.stringify(path)} is ${st.size} bytes, over the ${limits.maxFileBytes}-byte per-file cap; exclude it or raise the cap`,
          );
        total += st.size;
        if (total > limits.maxBytes)
          throw new TarSeedError("too-large", `workspace exceeds the ${limits.maxBytes}-byte transfer cap; exclude large files or raise the cap`);
        const data = readFileSync(abs);
        if (data.length !== st.size || lstatSync(abs).size !== st.size)
          throw new TarSeedError("partial", `file ${JSON.stringify(path)} changed while it was being archived; stop the writer and archive again`);
        entries.push({ path, kind: "file", mode: st.mode & 0o111 ? 0o755 : 0o644, data, target: "" });
      } else {
        throw new TarSeedError("unsupported", `${JSON.stringify(path)} is a device node, socket or fifo; remove it before transfer`);
      }
    }
  };
  walk("");
  validateEntries(entries);
  const bytes = packEntries(entries);
  if (bytes.length > limits.maxBytes)
    throw new TarSeedError("too-large", `archive is ${bytes.length} bytes, over the ${limits.maxBytes}-byte cap; exclude large files or raise the cap`);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, fileCount: entries.filter((e) => e.kind === "file").length };
}

function field(h: Buffer, from: number, len: number): string {
  const raw = h.subarray(from, from + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? len : end).toString("utf8");
}

function parseOctal(h: Buffer, from: number, len: number, what: string): number {
  const s = field(h, from, len).trim();
  if (!/^[0-7]+$/.test(s)) throw new TarSeedError("partial", `tar ${what} field is not octal; the archive is corrupt, resend it whole`);
  return Number.parseInt(s, 8);
}

// Parse and fully validate; returns the entries without touching the filesystem.
export function parseTarSeed(bytes: Uint8Array, limits: TarLimits = DEFAULT_TAR_LIMITS): TarEntry[] {
  if (bytes.length > limits.maxBytes) throw new TarSeedError("too-large", `archive is ${bytes.length} bytes, over the ${limits.maxBytes}-byte cap`);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: TarEntry[] = [];
  let pos = 0;
  for (;;) {
    if (pos + BLOCK * 2 > buf.length) throw new TarSeedError("partial", "tar archive ends without its terminator blocks; it is truncated, resend it whole");
    const h = buf.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) {
      if (!buf.subarray(pos, pos + BLOCK * 2).every((b) => b === 0)) throw new TarSeedError("partial", "tar terminator is malformed; resend it whole");
      if (!buf.subarray(pos).every((b) => b === 0)) throw new TarSeedError("unsafe", "tar archive has data after its terminator; refused");
      validateEntries(entries);
      return entries;
    }
    if (h.toString("latin1", 257, 262) !== "ustar")
      throw new TarSeedError("unsafe", "tar header lacks the ustar magic; only archives made by createTarSeed are accepted");
    const sum = parseOctal(h, 148, 8, "checksum");
    const copy = Buffer.from(h);
    copy.fill(0x20, 148, 156);
    if (copy.reduce((a, b) => a + b, 0) !== sum) throw new TarSeedError("partial", "tar header checksum mismatch; the archive is corrupt, resend it whole");
    if (entries.length >= limits.maxEntries) throw tooManyEntries(limits);
    const type = String.fromCharCode(h[156] === 0 ? 48 : h[156]!);
    const prefix = field(h, 345, 155);
    const path = checkTarPath(prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    const mode = parseOctal(h, 100, 8, "mode");
    const size = parseOctal(h, 124, 12, "size");
    pos += BLOCK;
    if (type === "0") {
      if (size > limits.maxFileBytes)
        throw new TarSeedError("too-large", `file ${JSON.stringify(path)} is ${size} bytes, over the ${limits.maxFileBytes}-byte per-file cap`);
      if (pos + size > buf.length) throw new TarSeedError("partial", "tar file data runs past the end of the archive; it is truncated, resend it whole");
      entries.push({ path, kind: "file", mode: mode & 0o111 ? 0o755 : 0o644, data: buf.subarray(pos, pos + size), target: "" });
      pos += Math.ceil(size / BLOCK) * BLOCK;
    } else if (type === "5") {
      entries.push({ path, kind: "dir", mode: 0o755, data: Buffer.alloc(0), target: "" });
    } else if (type === "2") {
      const target = field(h, 157, 100);
      checkSymlink(path, target);
      entries.push({ path, kind: "symlink", mode: 0o777, data: Buffer.alloc(0), target });
    } else {
      throw new TarSeedError(
        "unsafe",
        `tar entry ${JSON.stringify(path)} has type ${JSON.stringify(type)} (hard link, device node, fifo or extended header); refused`,
      );
    }
  }
}

// TODO(workspace-transfer-hardening): known gap, current behaviour. In seed.ts verifyAndFetchResult, `index-pack --strict` inflation is not
// bounded beyond the bundle byte cap and the object-count cap; bounding it needs a decision on how to measure inflated size.
// Verify size and sha256 first, then validate every entry, then write. `dest` must be an existing empty directory.
export function extractTarSeed(
  bytes: Uint8Array,
  dest: string,
  expect: { sha256: string; size: number },
  limits: TarLimits = DEFAULT_TAR_LIMITS,
): { fileCount: number } {
  if (bytes.length !== expect.size)
    throw new TarSeedError("partial", `archive is ${bytes.length} bytes but ${expect.size} were declared; it is truncated or padded, resend it whole`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expect.sha256) throw new TarSeedError("hash-mismatch", "archive sha256 does not match the declared hash; discard it and resend");
  const entries = parseTarSeed(bytes, limits);
  let root: string;
  try {
    root = realpathSync(dest);
    if (!lstatSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new TarSeedError("unsafe", "extraction target does not exist or is not a directory; create an empty directory and pass it");
  }
  if (readdirSync(root).length)
    throw new TarSeedError("unsafe", "extraction target is not empty; extract into a fresh empty directory so nothing existing is overwritten or followed");
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  try {
    for (const e of entries) {
      const abs = join(root, e.path);
      if (e.kind === "dir") mkdirSync(abs, { recursive: true });
      else mkdirSync(dirname(abs), { recursive: true });
      if (!inside(realpathSync(e.kind === "dir" ? abs : dirname(abs))))
        throw new TarSeedError("unsafe", `tar entry ${JSON.stringify(e.path)} would be written outside the extraction target; refused, discard the archive`);
      if (e.kind === "file") writeFileSync(abs, e.data, { flag: "wx", mode: e.mode });
      else if (e.kind === "symlink") symlinkSync(e.target, abs);
    }
  } catch (e) {
    // The target was empty, so everything in it is ours: leave it empty again rather than half-extracted.
    for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
    if (e instanceof TarSeedError) throw e;
    throw new TarSeedError(
      "partial",
      `writing the archive into the extraction target failed (${(e as NodeJS.ErrnoException).code ?? "I/O error"}); the target was emptied again, check free space and permissions, then retry`,
    );
  }
  return { fileCount: entries.filter((e) => e.kind === "file").length };
}
