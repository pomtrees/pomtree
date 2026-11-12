import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ExecOutputCapError, type ExecFn, type TransferFailure, checkResultPath, resultWorkViaExec } from "./result-work-exec.ts";

const FP = "ab".repeat(32);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

class TransferStub extends Error {
  reason: TransferFailure;
  constructor(reason: TransferFailure) {
    super(`transfer ${reason}`);
    this.reason = reason;
  }
}

// A scripted exec: the collector call returns `header`; `cat` calls return `content` (or a custom outcome).
function fixture(opts: { header: unknown; content?: Uint8Array; catExit?: number; headerExit?: number }) {
  const calls: { argv: string[]; max: number }[] = [];
  const exec: ExecFn = async (argv, o) => {
    calls.push({ argv, max: o.maxStdoutBytes });
    if (argv[0] === "cat") return { exitCode: opts.catExit ?? 0, stdout: opts.content ?? new Uint8Array(), stderr: opts.catExit ? "cat: no such file" : "" };
    return { exitCode: opts.headerExit ?? 0, stdout: enc(`${JSON.stringify(opts.header)}\n`), stderr: opts.headerExit ? "collector missing" : "" };
  };
  return {
    calls,
    run: (over: { maxBytes?: number; save?: boolean; expectedFingerprint?: string } = {}) =>
      resultWorkViaExec({
        exec,
        collect: (a) => ["collector", JSON.stringify(a)],
        resultDir: "/work/.pomtree",
        transferError: (r) => new TransferStub(r),
        maxBytes: 1024,
        save: true,
        expectedFingerprint: FP,
        ...over,
      }),
  };
}

async function drain(it: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of it) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

test("result-work-exec: collects the declared file over exec, verifies size and sha256, returns the bundle", async () => {
  const data = enc("bundle-bytes");
  const f = fixture({ header: { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: data.length, sha256: sha(data) } }, content: data });
  const r = await f.run({ save: true, expectedFingerprint: FP });
  assert.equal(r.dirty, false);
  assert.equal(r.fingerprint, FP);
  assert.equal((await drain(r.bundle!)).toString(), "bundle-bytes");
  assert.deepEqual(f.calls[0]?.argv.slice(0, 1), ["collector"]);
  assert.deepEqual(JSON.parse(f.calls[0]!.argv[1]!), { save: true, expectedFingerprint: FP, maxBytes: 1024 });
  assert.deepEqual(f.calls[1], { argv: ["cat", "--", "/work/.pomtree/result.bundle"], max: data.length + 1 });
});

test("result-work-exec: a header with no declared file returns dirty and fingerprint only, with no read", async () => {
  const f = fixture({ header: { dirty: false, fingerprint: FP } });
  const r = await f.run();
  assert.deepEqual(r, { dirty: false, fingerprint: FP });
  assert.equal(f.calls.length, 1);
});

test("result-work-exec NEG: a sha256 mismatch is refused with hash-mismatch and no bytes are yielded", async () => {
  const data = enc("tampered");
  const f = fixture({
    header: { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: data.length, sha256: sha(enc("original")) } },
    content: data,
  });
  await assert.rejects(f.run(), (e: unknown) => e instanceof TransferStub && e.reason === "hash-mismatch");
});

test("result-work-exec NEG: a short read is partial, an overlong read is too-large", async () => {
  const data = enc("0123456789");
  const header = { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: data.length, sha256: sha(data) } };
  await assert.rejects(fixture({ header, content: data.subarray(0, 4) }).run(), (e: unknown) => e instanceof TransferStub && e.reason === "partial");
  await assert.rejects(fixture({ header, content: enc("0123456789X") }).run(), (e: unknown) => e instanceof TransferStub && e.reason === "too-large");
});

test("result-work-exec NEG: a declared size over maxBytes is refused before any read", async () => {
  const f = fixture({ header: { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: 2048, sha256: "cd".repeat(32) } } });
  await assert.rejects(f.run({ maxBytes: 1024 }), (e: unknown) => e instanceof TransferStub && e.reason === "too-large");
  assert.equal(f.calls.length, 1, "the file was never read");
});

test("result-work-exec NEG: traversal and absolute paths are refused before any read, with cause and action", async () => {
  for (const path of ["../etc/passwd", "a/../../b", "/etc/passwd", "a\\b", "a\0b", ""]) {
    const f = fixture({ header: { dirty: false, fingerprint: FP, file: { path, size: 1, sha256: "cd".repeat(32) } } });
    await assert.rejects(
      f.run(),
      /result file path .*(escapes the result directory; the collector must declare a relative path|is missing; the collector must declare)/s,
      JSON.stringify(path),
    );
    assert.equal(f.calls.length, 1, `no read for ${JSON.stringify(path)}`);
  }
  assert.equal(checkResultPath("sub/./dir/result.bundle"), "sub/dir/result.bundle", "a plain nested path is accepted");
});

test("result-work-exec NEG: a failing collector or file read names the cause and the action", async () => {
  await assert.rejects(
    fixture({ header: {}, headerExit: 127 }).run(),
    /result collection program failed with exit 127: collector missing; check that the sandbox is running/,
  );
  const data = enc("x");
  const header = { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: 1, sha256: sha(data) } };
  await assert.rejects(fixture({ header, catExit: 1 }).run(), /result collection file read failed with exit 1: cat: no such file/);
});

test("result-work-exec NEG: a malformed header is refused (bad fingerprint, no JSON, bad size)", async () => {
  await assert.rejects(fixture({ header: { dirty: true, fingerprint: "xyz" } }).run(), /lacks a boolean dirty and a 64-hex fingerprint/);
  await assert.rejects(
    fixture({ header: { dirty: false, fingerprint: FP, file: { path: "r", size: -1, sha256: "cd".repeat(32) } } }).run(),
    /without a valid size and sha256/,
  );
  const exec: ExecFn = async () => ({ exitCode: 0, stdout: enc("not json\n"), stderr: "" });
  await assert.rejects(
    resultWorkViaExec({ exec, collect: () => ["c"], resultDir: "/w", transferError: (r) => new TransferStub(r), maxBytes: 10 }),
    /no valid JSON header/,
  );
  await assert.rejects(fixture({ header: { dirty: false, fingerprint: FP } }).run({ maxBytes: 0 }), /maxBytes must be a safe integer of at least 1/);
});

test("result-work-exec: a bundle over 1 MiB is streamed in chunks and reassembles exactly", async () => {
  const data = Buffer.alloc(2 * 1024 * 1024 + 5, 7);
  const f = fixture({ header: { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: data.length, sha256: sha(data) } }, content: data });
  const r = await f.run({ maxBytes: data.length });
  const parts: number[] = [];
  const all: Buffer[] = [];
  for await (const p of r.bundle!) {
    parts.push(p.length);
    all.push(Buffer.from(p));
  }
  assert.deepEqual(parts, [1048576, 1048576, 5]);
  assert.ok(Buffer.concat(all).equals(data));
});

test("result-work-exec NEG: a declared file is refused unless this was a confirmed save of the approved clean state", async () => {
  const data = enc("bundle");
  const file = { path: "result.bundle", size: data.length, sha256: sha(data) };
  const refused = /declared a file although this call was not a confirmed save/;
  for (const [name, header, over] of [
    ["save false", { dirty: false, fingerprint: FP, file }, { save: false }],
    ["dirty true", { dirty: true, fingerprint: FP, file }, {}],
    ["other fingerprint", { dirty: false, fingerprint: "cd".repeat(32), file }, {}],
    ["no expected fingerprint", { dirty: false, fingerprint: FP, file }, { expectedFingerprint: undefined }],
  ] as const) {
    const f = fixture({ header, content: data });
    await assert.rejects(f.run(over), refused, name);
    assert.equal(f.calls.length, 1, `${name}: never read`);
  }
});

test("result-work-exec: stderr in an error is redacted, and an exec stopped at the size cap maps to too-large", async () => {
  const exec: ExecFn = async () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: "denied Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx" });
  const err = await resultWorkViaExec({ exec, collect: () => ["c"], resultDir: "/w", transferError: (r) => new TransferStub(r), maxBytes: 10 }).catch((e) => e);
  assert.match(String(err.message), /exit 1: denied/);
  assert.doesNotMatch(String(err.message), /sk-ant-abcdefghijklmnopqrstuvwx/);
  const data = enc("0123456789");
  const header = { dirty: false, fingerprint: FP, file: { path: "result.bundle", size: data.length, sha256: sha(data) } };
  const capped: ExecFn = async (argv, o) => {
    if (argv[0] === "cat") throw new ExecOutputCapError(o.maxStdoutBytes);
    return { exitCode: 0, stdout: enc(`${JSON.stringify(header)}\n`), stderr: "" };
  };
  await assert.rejects(
    resultWorkViaExec({
      exec: capped,
      collect: () => ["c"],
      resultDir: "/w",
      transferError: (r) => new TransferStub(r),
      maxBytes: 1024,
      save: true,
      expectedFingerprint: FP,
    }),
    (e: unknown) => e instanceof TransferStub && e.reason === "too-large",
  );
  const bigHeader: ExecFn = async (_a, o) => {
    throw new ExecOutputCapError(o.maxStdoutBytes);
  };
  await assert.rejects(
    resultWorkViaExec({ exec: bigHeader, collect: () => ["c"], resultDir: "/w", transferError: (r) => new TransferStub(r), maxBytes: 10 }),
    /header exceeded 4096 bytes/,
  );
});
