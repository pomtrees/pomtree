// File transfer into and out of a pod over exec. The agent image guarantees node and git but not tar, so a small node program
// does the writing and hashing, and `cat` does the reading (the same two-exec style as the kit's `resultWorkViaExec`).
//
// put: the bytes are hashed here and must equal the caller's sha256 BEFORE anything is sent; they travel on stdin to a node
//   program that re-hashes them, writes a temporary file beside the target and renames it into place only when size and hash
//   match, so a half-written or corrupt file never appears at the target path.
// get: exec 1 prints { size, sha256 } of the file; exec 2 `cat`s it, capped at size + 1 bytes. The bytes are exposed only after
//   their length and sha256 equal the header. Nothing partial is ever returned.
//
// Paths are sandbox-absolute and must stay under `root` (checked by the kit's `checkResultPath`). That check is lexical: it stops
// "..", absolute and backslash escapes, but a symlink already inside the pod can point out of `root`, so this is a request-hygiene
// check, not a boundary; the pod is the boundary. Every exec takes an argv array
// and is never joined into a shell string. The kit takes no dependency on @pomtree/core, so transfer failures come from an
// injected factory, for example `(reason) => new SandboxTransferError(id, reason)`.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { redact } from "@pomtree/sandbox-kit/redact";
import { ExecOutputCapError, checkResultPath, type TransferFailure } from "@pomtree/sandbox-kit/result-work-exec";
import type { ExecWithStdinFn } from "./exec.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const HEADER_MAX = 4096;
const CHUNK = 1024 * 1024;

// Exit codes of PUT_SCRIPT.
// They sit in 60-79 because Node reserves 1 to 14 for its own failures (3 and 4 are internal JavaScript errors, 5 is a fatal
// error), so a Node-level failure can never read as a transfer verdict.
export const PUT_EXIT = { hashMismatch: 60, partial: 61, tooLarge: 62 } as const;
export const DEFAULT_PUT_MODE = "0600";

// argv after `--`: destination, expected sha256, expected size, file mode (octal, 3 or 4 digits). Reads stdin to the end. Any
// failure removes the temporary file; the target appears only by rename after size and hash match.
export const PUT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [dest, sha, sizeText, modeText] = process.argv.slice(1);
const size = Number(sizeText);
const mode = parseInt(modeText, 8);
const tmp = path.join(path.dirname(dest), ".pomtree-put-" + process.pid);
let out;
let done = false;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  try { if (out !== undefined) fs.closeSync(out); } catch {}
  if (code !== 0) { try { fs.unlinkSync(tmp); } catch {} }
  if (msg) process.stderr.write(msg + "\\n");
  process.exit(code);
};
try {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  out = fs.openSync(tmp, "w", 0o600);
  const hash = crypto.createHash("sha256");
  let n = 0;
  process.stdin.on("error", (e) => finish(1, "stdin failed: " + e.message));
  process.stdin.on("data", (b) => {
    try { n += b.length; if (n > size) return; hash.update(b); fs.writeSync(out, b); } catch (e) { finish(1, String(e && e.message)); }
  });
  process.stdin.on("end", () => {
    try {
      if (n > size) return finish(${PUT_EXIT.tooLarge}, "received more than " + size + " bytes");
      if (n < size) return finish(${PUT_EXIT.partial}, "received " + n + " of " + size + " bytes");
      if (hash.digest("hex") !== sha) return finish(${PUT_EXIT.hashMismatch}, "sha256 mismatch");
      fs.fchmodSync(out, mode);
      fs.fsyncSync(out);
      fs.closeSync(out);
      out = undefined;
      fs.renameSync(tmp, dest);
      finish(0);
    } catch (e) { finish(1, String(e && e.message)); }
  });
} catch (e) { finish(1, String(e && e.message)); }
`;

// argv after `--`: the file. Prints one JSON line { size, sha256 }.
export const STAT_SCRIPT = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const file = process.argv[1];
const st = fs.statSync(file);
if (!st.isFile()) { process.stderr.write(file + " is not a regular file\\n"); process.exit(2); }
const hash = crypto.createHash("sha256");
let size = 0;
fs.createReadStream(file).on("data", (b) => { size += b.length; hash.update(b); }).on("end", () => {
  process.stdout.write(JSON.stringify({ size, sha256: hash.digest("hex") }) + "\\n");
});
`;

export interface FileOptions {
  exec: ExecWithStdinFn;
  // Absolute directory that every path must stay under.
  root: string;
  transferError: (reason: TransferFailure) => Error;
}

// "/root/a/b" -> "a/b"; anything outside root, relative, or with ".." is refused.
export function relativeToRoot(root: string, path: string): string {
  const base = root.replace(/\/+$/, "");
  if (typeof path !== "string" || !path.startsWith(`${base}/`)) {
    throw new Error(`path "${String(path).replace(/[^\x20-\x7e]/g, "?")}" is not under ${base}; use an absolute path inside that directory`);
  }
  return checkResultPath(path.slice(base.length + 1));
}

const failed = (what: string, exitCode: number, stderr: string): Error =>
  new Error(
    `${what} failed with exit ${exitCode}${stderr ? `: ${redact(stderr.slice(-500))}` : ""}; check that the sandbox is running, node is installed in its image and the path is writable`,
  );

async function collect(body: AsyncIterable<Uint8Array> | Uint8Array, maxBytes: number, tooLarge: () => Error): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.length > maxBytes) throw tooLarge();
    return Buffer.from(body);
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of body) {
    total += c.length;
    if (total > maxBytes) throw tooLarge();
    parts.push(c);
  }
  return Buffer.concat(parts);
}

// Writes `body` to `path` in the pod. `sha256` is the caller's expected hash of the whole body.
export async function putFile(
  opts: FileOptions,
  args: { path: string; body: AsyncIterable<Uint8Array> | Uint8Array; sha256: string; maxBytes: number; mode?: string },
): Promise<void> {
  if (!HEX64.test(args.sha256)) throw new Error("sha256 must be 64 lowercase hex characters; pass the hash of the whole body");
  if (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1)
    throw new Error("maxBytes must be a safe integer of at least 1; pass the resolved transfer limit");
  const mode = args.mode ?? DEFAULT_PUT_MODE;
  if (!/^[0-7]{3,4}$/.test(mode))
    throw new Error(
      `file mode "${mode.replace(/[^\x20-\x7e]/g, "?").slice(0, 20)}" is not an octal mode; pass 3 or 4 octal digits such as "0644" (default ${DEFAULT_PUT_MODE})`,
    );
  const rel = relativeToRoot(opts.root, args.path);
  const bytes = await collect(args.body, args.maxBytes, () => opts.transferError("too-large"));
  if (createHash("sha256").update(bytes).digest("hex") !== args.sha256) throw opts.transferError("hash-mismatch");
  const dest = posix.join(opts.root, rel);
  const res = await opts
    .exec(["node", "-e", PUT_SCRIPT, "--", dest, args.sha256, String(bytes.length), mode], { maxStdoutBytes: 0, stdin: bytes })
    .catch((e: unknown) => {
      if (e instanceof ExecOutputCapError) throw failed("file write", -1, "the writer printed unexpected output");
      throw e;
    });
  if (res.exitCode === PUT_EXIT.hashMismatch) throw opts.transferError("hash-mismatch");
  if (res.exitCode === PUT_EXIT.partial) throw opts.transferError("partial");
  if (res.exitCode === PUT_EXIT.tooLarge) throw opts.transferError("too-large");
  if (res.exitCode !== 0) throw failed("file write", res.exitCode, res.stderr);
}

// Reads `path` from the pod. The returned hash is the verified sha256 of the returned bytes.
export async function getFile(
  opts: FileOptions,
  args: { path: string; maxBytes: number },
): Promise<{ body: AsyncIterable<Uint8Array>; sha256: Promise<string> }> {
  if (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1)
    throw new Error("maxBytes must be a safe integer of at least 1; pass the resolved transfer limit");
  const file = posix.join(opts.root, relativeToRoot(opts.root, args.path));
  let head: Awaited<ReturnType<ExecWithStdinFn>>;
  try {
    head = await opts.exec(["node", "-e", STAT_SCRIPT, "--", file], { maxStdoutBytes: HEADER_MAX });
  } catch (e) {
    if (e instanceof ExecOutputCapError)
      throw new Error(`file header exceeded ${HEADER_MAX} bytes; check the node program in the sandbox image prints one short JSON line`);
    throw e;
  }
  if (head.exitCode !== 0) throw failed("file stat", head.exitCode, head.stderr);
  let header: { size?: unknown; sha256?: unknown };
  try {
    header = JSON.parse(Buffer.from(head.stdout).toString("utf8").split("\n")[0] ?? "");
  } catch {
    throw new Error("file stat returned no valid JSON header; check the node program in the sandbox image");
  }
  const { size, sha256 } = header;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof sha256 !== "string" || !HEX64.test(sha256)) {
    throw new Error("file stat header lacks a valid size and sha256; check the node program in the sandbox image");
  }
  if (size > args.maxBytes) throw opts.transferError("too-large");
  let read: Awaited<ReturnType<ExecWithStdinFn>>;
  try {
    read = await opts.exec(["cat", "--", file], { maxStdoutBytes: size });
  } catch (e) {
    // The file grew after the header: more than `size` bytes is not the file that was hashed.
    if (e instanceof ExecOutputCapError) throw opts.transferError("hash-mismatch");
    throw e;
  }
  if (read.exitCode !== 0) throw failed("file read", read.exitCode, read.stderr);
  const bytes = read.stdout;
  if (bytes.length < size) throw opts.transferError("partial");
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw opts.transferError("hash-mismatch");
  const body = (async function* () {
    for (let off = 0; off < bytes.length; off += CHUNK) yield bytes.subarray(off, off + CHUNK);
  })();
  return { body, sha256: Promise.resolve(sha256) };
}
