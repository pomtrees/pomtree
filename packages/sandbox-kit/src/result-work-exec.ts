// `resultWork` for providers with no engine API: everything goes through one injected exec function. Two exec calls, both
// bounded: the adapter's collector program prints one JSON header (the same header as the Docker adapter's collector, plus
// the declared result file), then the declared file is read back with `cat`, size-checked and sha256-verified before a single
// byte is handed on. Nothing partial is ever returned.
//
// Header the collector prints (one line of JSON on stdout, at most 4 KiB):
//   { dirty: boolean, fingerprint: <64 hex>, file?: { path: <relative>, size: <bytes>, sha256: <64 hex> } }
// `file.path` is relative to `resultDir`; an absolute path, a `..` segment, a backslash or a NUL is refused.
//
// Every exec takes an argv array and must never be joined into a shell string (see ExecFn).
//
// The kit takes no dependency on @pomtree/core, so transfer failures are built by an injected factory, for example
// `(reason) => new SandboxTransferError(id, reason)`.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { redact } from "./redact.ts";

// TODO(sandbox-result-header): the one-line JSON header above is a contract no program in the sandbox image emits yet; current behavior: only test
// doubles print it. A hosted adapter needs the collector program in its image first.
export interface ExecOutcome {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}

// Thrown by an ExecFn that stopped because the output reached `maxStdoutBytes`.
export class ExecOutputCapError extends Error {
  constructor(maxStdoutBytes: number) {
    super(`exec output reached the ${maxStdoutBytes}-byte cap and was stopped`);
    this.name = "ExecOutputCapError";
  }
}

// Runs `argv` inside the sandbox. An implementation takes the argv array as is and never joins it into a shell string (the
// adapter guarantees this; a path with spaces or metacharacters must stay one argument). `maxStdoutBytes` is a hard cap: an implementation must stop and throw ExecOutputCapError rather than buffer more.
export type ExecFn = (argv: string[], opts: { maxStdoutBytes: number }) => Promise<ExecOutcome>;

export type TransferFailure = "hash-mismatch" | "partial" | "too-large";

export interface ResultWorkExecOptions {
  exec: ExecFn;
  // Builds the collector's argv from the port arguments.
  collect: (args: { save: boolean; expectedFingerprint?: string; maxBytes: number }) => string[];
  // Absolute directory inside the sandbox that the declared file path is relative to.
  resultDir: string;
  transferError: (reason: TransferFailure) => Error;
  save?: boolean;
  expectedFingerprint?: string;
  // The resolved push.maxBytes; a larger file is refused, never truncated.
  maxBytes: number;
}

const HEADER_MAX = 4096;
const CHUNK = 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

// A declared path must stay inside resultDir.
export function checkResultPath(path: unknown): string {
  if (typeof path !== "string" || path === "") throw new Error("result file path is missing; the collector must declare file.path");
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || posix.normalize(path).split("/").includes("..") || path.split("/").includes("..")) {
    throw new Error(
      `result file path "${path.replace(/[^\x20-\x7e]/g, "?")}" escapes the result directory; the collector must declare a relative path without ".." segments`,
    );
  }
  return posix.normalize(path);
}

const fail = (what: string, exit: ExecOutcome): Error =>
  new Error(
    `result collection ${what} failed with exit ${exit.exitCode}${exit.stderr ? `: ${redact(exit.stderr.slice(-500))}` : ""}; check that the sandbox is running and the collector is installed in its image`,
  );

export async function resultWorkViaExec(opts: ResultWorkExecOptions): Promise<{ dirty: boolean; fingerprint: string; bundle?: AsyncIterable<Uint8Array> }> {
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1)
    throw new Error("maxBytes must be a safe integer of at least 1; pass the resolved push.maxBytes");
  const save = opts.save ?? false;
  let head: ExecOutcome;
  try {
    head = await opts.exec(
      opts.collect({ save, ...(opts.expectedFingerprint === undefined ? {} : { expectedFingerprint: opts.expectedFingerprint }), maxBytes: opts.maxBytes }),
      { maxStdoutBytes: HEADER_MAX },
    );
  } catch (e) {
    if (e instanceof ExecOutputCapError) {
      throw new Error(`result collection header exceeded ${HEADER_MAX} bytes; check that the collector prints one short JSON line and nothing else on stdout`);
    }
    throw e;
  }
  if (head.exitCode !== 0) throw fail("program", head);
  const line = Buffer.from(head.stdout).toString("utf8").split("\n")[0] ?? "";
  let header: { dirty?: unknown; fingerprint?: unknown; file?: unknown };
  try {
    header = JSON.parse(line);
  } catch {
    throw new Error("result collection returned no valid JSON header; check that the collector prints one JSON line on stdout");
  }
  if (typeof header.dirty !== "boolean" || typeof header.fingerprint !== "string" || !HEX64.test(header.fingerprint)) {
    throw new Error("result collection header lacks a boolean dirty and a 64-hex fingerprint; check the collector version in the sandbox image");
  }
  const result = { dirty: header.dirty, fingerprint: header.fingerprint };
  if (header.file === undefined) return result;

  // What the Docker collector enforces: a file is only ever declared for a confirmed save, of a clean tree, whose fingerprint is
  // the one the caller approved.
  if (!save || header.dirty || header.fingerprint !== opts.expectedFingerprint) {
    throw new Error(
      "result collection declared a file although this call was not a confirmed save of the approved clean state (save must be true, dirty false and the fingerprint equal to expectedFingerprint); the file was not read. Check the collector version in the sandbox image",
    );
  }
  const file = header.file as { path?: unknown; size?: unknown; sha256?: unknown };
  const rel = checkResultPath(file.path);
  if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !HEX64.test(file.sha256)) {
    throw new Error("result collection header declares a file without a valid size and sha256; check the collector version in the sandbox image");
  }
  if (file.size > opts.maxBytes) throw opts.transferError("too-large");
  let read: ExecOutcome;
  try {
    read = await opts.exec(["cat", "--", posix.join(opts.resultDir, rel)], { maxStdoutBytes: file.size + 1 });
  } catch (e) {
    if (e instanceof ExecOutputCapError) throw opts.transferError("too-large");
    throw e;
  }
  if (read.exitCode !== 0) throw fail("file read", read);
  const bytes = read.stdout;
  if (bytes.length > opts.maxBytes || bytes.length > file.size) throw opts.transferError("too-large");
  if (bytes.length < file.size) throw opts.transferError("partial");
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw opts.transferError("hash-mismatch");
  const bundle = (async function* () {
    for (let off = 0; off < bytes.length; off += CHUNK) yield bytes.subarray(off, off + CHUNK);
  })();
  return { ...result, bundle };
}
