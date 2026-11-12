import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExecOutputCapError, type TransferFailure } from "@pomtree/sandbox-kit/result-work-exec";
import type { ExecWithStdinFn } from "./exec.ts";
import { PUT_EXIT, getFile, putFile, relativeToRoot } from "./files.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const base = mkdtempSync(join(tmpdir(), "pomtree-k8s-files-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const freshRoot = (): string => {
  const d = join(base, `r${n++}`);
  mkdirSync(d);
  return d;
};

class TransferErr extends Error {
  reason: TransferFailure;
  constructor(reason: TransferFailure) {
    super(reason);
    this.reason = reason;
  }
}
const transferError = (r: TransferFailure) => new TransferErr(r);

// Runs argv as a real local process, standing in for the pod: this proves the node program and `cat` really work, and records
// every argv so tests can assert nothing was joined into a shell string.
function localExec(calls: string[][] = []): ExecWithStdinFn {
  return (argv, opts) =>
    new Promise((resolve, reject) => {
      calls.push(argv);
      const [cmd, ...rest] = argv as [string, ...string[]];
      const p = spawn(cmd === "node" ? process.execPath : cmd, rest, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let outBytes = 0;
      const err: Buffer[] = [];
      p.stdout.on("data", (b: Buffer) => {
        outBytes += b.length;
        if (outBytes > opts.maxStdoutBytes) {
          p.kill();
          reject(new ExecOutputCapError(opts.maxStdoutBytes));
          return;
        }
        out.push(b);
      });
      p.stderr.on("data", (b: Buffer) => err.push(b));
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        reject(new Error(`local exec of ${cmd} hung for 20s`));
      }, 20_000);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.stdin.on("error", () => undefined);
      p.stdin.end(opts.stdin);
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() });
      });
    });
}

const reason = (e: unknown, r: TransferFailure) => e instanceof TransferErr && e.reason === r;

test("put: writes the file atomically (parents created, no temp file left) and the exec argv is exact", async () => {
  const root = freshRoot();
  const calls: string[][] = [];
  const body = Buffer.from("hello\nworld");
  await putFile({ exec: localExec(calls), root, transferError }, { path: `${root}/dir/sub dir/$HOME; x.txt`, body, sha256: sha(body), maxBytes: 1000 });
  assert.equal(readFileSync(join(root, "dir/sub dir/$HOME; x.txt"), "utf8"), "hello\nworld");
  assert.deepEqual(readdirSync(join(root, "dir/sub dir")), ["$HOME; x.txt"]);
  assert.equal(calls.length, 1);
  const [cmd, flag, script, dd, dest, hash, size, mode] = calls[0] as string[];
  assert.deepEqual([cmd, flag, dd, dest, hash, size, mode], ["node", "-e", "--", `${root}/dir/sub dir/$HOME; x.txt`, sha(body), "11", "0600"]);
  assert.ok(script?.includes("renameSync"));
});

test("put: an async iterable body is collected and large bodies round-trip", async () => {
  const root = freshRoot();
  const big = Buffer.alloc(300_000, 9);
  const body = (async function* () {
    yield big.subarray(0, 100_000);
    yield big.subarray(100_000);
  })();
  await putFile({ exec: localExec(), root, transferError }, { path: `${root}/big.bin`, body, sha256: sha(big), maxBytes: 1_000_000 });
  assert.equal(readFileSync(join(root, "big.bin")).equals(big), true);
});

test("NEG put: a body that does not match the caller's sha256 is refused before anything is sent", async () => {
  const root = freshRoot();
  const calls: string[][] = [];
  await assert.rejects(
    putFile({ exec: localExec(calls), root, transferError }, { path: `${root}/a`, body: Buffer.from("tampered"), sha256: sha("original"), maxBytes: 100 }),
    (e) => reason(e, "hash-mismatch"),
  );
  assert.equal(calls.length, 0);
});

test("NEG put: a body over maxBytes is too-large, from a buffer and from a stream, and nothing is sent", async () => {
  const root = freshRoot();
  const calls: string[][] = [];
  const body = Buffer.alloc(11);
  await assert.rejects(putFile({ exec: localExec(calls), root, transferError }, { path: `${root}/a`, body, sha256: sha(body), maxBytes: 10 }), (e) =>
    reason(e, "too-large"),
  );
  const stream = (async function* () {
    yield Buffer.alloc(6);
    yield Buffer.alloc(6);
  })();
  await assert.rejects(
    putFile({ exec: localExec(calls), root, transferError }, { path: `${root}/a`, body: stream, sha256: sha(Buffer.alloc(12)), maxBytes: 10 }),
    (e) => reason(e, "too-large"),
  );
  assert.equal(calls.length, 0);
});

test("NEG put: the in-pod writer re-checks and maps its exit codes (corrupted in transit -> hash-mismatch, truncated -> partial), leaving no file", async () => {
  const root = freshRoot();
  const body = Buffer.from("0123456789");
  const run = (mutate: (stdin: Uint8Array | undefined) => Uint8Array | undefined): ExecWithStdinFn => {
    const inner = localExec();
    return (argv, o) => inner(argv, { ...o, stdin: mutate(o.stdin) as Uint8Array });
  };
  await assert.rejects(
    putFile({ exec: run((s) => Buffer.from(s as Uint8Array).fill(0x78)), root, transferError }, { path: `${root}/f`, body, sha256: sha(body), maxBytes: 100 }),
    (e) => reason(e, "hash-mismatch"),
  );
  await assert.rejects(
    putFile({ exec: run((s) => (s as Uint8Array).subarray(0, 4)), root, transferError }, { path: `${root}/f`, body, sha256: sha(body), maxBytes: 100 }),
    (e) => reason(e, "partial"),
  );
  await assert.rejects(
    putFile(
      { exec: run((s) => Buffer.concat([s as Uint8Array, Buffer.from("extra")])), root, transferError },
      { path: `${root}/f`, body, sha256: sha(body), maxBytes: 100 },
    ),
    (e) => reason(e, "too-large"),
  );
  assert.deepEqual(readdirSync(root), [], "no target and no temp file after a failed put");
  assert.deepEqual([PUT_EXIT.hashMismatch, PUT_EXIT.partial, PUT_EXIT.tooLarge], [60, 61, 62]);
});

test("NEG put: an unexpected writer failure surfaces its stderr with an action", async () => {
  const exec: ExecWithStdinFn = async () => ({ exitCode: 127, stdout: new Uint8Array(0), stderr: "node: not found" });
  await assert.rejects(
    putFile({ exec, root: "/work", transferError }, { path: "/work/a", body: Buffer.from("x"), sha256: sha("x"), maxBytes: 10 }),
    (e: Error) => /exit 127/.test(e.message) && /node: not found/.test(e.message) && /check that the sandbox is running/.test(e.message),
  );
});

test("get: reads the file, verifies size and sha256 before exposing bytes, and the argv is exact", async () => {
  const root = freshRoot();
  const data = Buffer.alloc(2_500_000, 3);
  writeFileSync(join(root, "out.bin"), data);
  const calls: string[][] = [];
  const r = await getFile({ exec: localExec(calls), root, transferError }, { path: `${root}/out.bin`, maxBytes: 10_000_000 });
  const parts: Buffer[] = [];
  for await (const c of r.body) parts.push(Buffer.from(c));
  assert.equal(Buffer.concat(parts).equals(data), true);
  assert.equal(await r.sha256, sha(data));
  assert.ok(parts.length >= 3, "the body is delivered in chunks");
  assert.deepEqual(calls[1], ["cat", "--", `${root}/out.bin`]);
  assert.deepEqual([calls[0]?.[0], calls[0]?.[1], calls[0]?.[3], calls[0]?.[4]], ["node", "-e", "--", `${root}/out.bin`]);
});

test("NEG get: a file over maxBytes is too-large and is never read", async () => {
  const root = freshRoot();
  writeFileSync(join(root, "f"), "12345678901");
  const calls: string[][] = [];
  await assert.rejects(getFile({ exec: localExec(calls), root, transferError }, { path: `${root}/f`, maxBytes: 10 }), (e) => reason(e, "too-large"));
  assert.equal(calls.length, 1, "only the header exec ran");
});

test("NEG get: bytes that differ from the header hash are a hash-mismatch and nothing is exposed", async () => {
  const root = freshRoot();
  writeFileSync(join(root, "f"), "abcdef");
  const real = localExec();
  const lying: ExecWithStdinFn = async (argv, o) => {
    const r = await real(argv, o);
    return argv[0] === "cat" ? { ...r, stdout: Buffer.from("abcdeX") } : r;
  };
  await assert.rejects(getFile({ exec: lying, root, transferError }, { path: `${root}/f`, maxBytes: 100 }), (e) => reason(e, "hash-mismatch"));
});

test("NEG get: fewer bytes than declared is partial, and a file that grew past its header is a hash-mismatch", async () => {
  const root = freshRoot();
  writeFileSync(join(root, "f"), "abcdef");
  const real = localExec();
  const short: ExecWithStdinFn = async (argv, o) => {
    const r = await real(argv, o);
    return argv[0] === "cat" ? { ...r, stdout: Buffer.from("abc") } : r;
  };
  await assert.rejects(getFile({ exec: short, root, transferError }, { path: `${root}/f`, maxBytes: 100 }), (e) => reason(e, "partial"));
  const growing: ExecWithStdinFn = async (argv, o) => {
    if (argv[0] === "cat") writeFileSync(join(root, "f"), "abcdef-and-more");
    return real(argv, o);
  };
  await assert.rejects(getFile({ exec: growing, root, transferError }, { path: `${root}/f`, maxBytes: 100 }), (e) => reason(e, "hash-mismatch"));
});

test("NEG get: a missing file and a directory fail with exit status and an action", async () => {
  const root = freshRoot();
  mkdirSync(join(root, "d"));
  for (const p of ["nope", "d"]) {
    await assert.rejects(
      getFile({ exec: localExec(), root, transferError }, { path: `${root}/${p}`, maxBytes: 100 }),
      (e: Error) => /file stat failed with exit [12]/.test(e.message) && /check that the sandbox is running/.test(e.message),
    );
  }
});

test("path safety: paths outside the root, relative paths, '..' segments, backslashes and NULs are refused without any exec", async () => {
  const calls: string[][] = [];
  const o = { exec: localExec(calls), root: "/work", transferError };
  for (const p of ["/etc/passwd", "/workshop/a", "a/b", "/work/../etc/passwd", "/work/a/../../x", "/work/a\\b", "/work/a\0b", "/work/"]) {
    await assert.rejects(putFile(o, { path: p, body: Buffer.from("x"), sha256: sha("x"), maxBytes: 10 }), Error, `put ${JSON.stringify(p)}`);
    await assert.rejects(getFile(o, { path: p, maxBytes: 10 }), Error, `get ${JSON.stringify(p)}`);
  }
  assert.equal(calls.length, 0);
  assert.equal(relativeToRoot("/work/", "/work/a/b.txt"), "a/b.txt");
  assert.throws(() => relativeToRoot("/work", "/etc/x"), /not under \/work; use an absolute path inside that directory/);
  assert.throws(() => relativeToRoot("/work", "/work/../x"), /escapes the result directory/);
});

test("input checks: a malformed sha256 or a bad maxBytes is refused with the action", async () => {
  const o = { exec: localExec(), root: "/work", transferError };
  await assert.rejects(putFile(o, { path: "/work/a", body: Buffer.from("x"), sha256: "ABC", maxBytes: 10 }), /64 lowercase hex/);
  await assert.rejects(putFile(o, { path: "/work/a", body: Buffer.from("x"), sha256: sha("x"), maxBytes: 0 }), /pass the resolved transfer limit/);
  await assert.rejects(getFile(o, { path: "/work/a", maxBytes: 1.5 }), /pass the resolved transfer limit/);
});

test("put: the file gets the default 0600 mode, or the requested octal mode, and a bad mode is refused", async () => {
  const root = freshRoot();
  const body = Buffer.from("m");
  const o = { exec: localExec(), root, transferError };
  await putFile(o, { path: `${root}/a`, body, sha256: sha(body), maxBytes: 10 });
  await putFile(o, { path: `${root}/b`, body, sha256: sha(body), maxBytes: 10, mode: "0755" });
  assert.equal(statSync(join(root, "a")).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "b")).mode & 0o777, 0o755);
  for (const bad of ["rwx", "9999", "0o755", "07555", ""]) {
    await assert.rejects(
      putFile(o, { path: `${root}/c`, body, sha256: sha(body), maxBytes: 10, mode: bad }),
      /not an octal mode; pass 3 or 4 octal digits/,
      bad,
    );
  }
});

test("NEG put: a failure after the temp file exists (rename onto a directory) leaves no temp file and is a generic failure", async () => {
  const root = freshRoot();
  mkdirSync(join(root, "target"));
  const body = Buffer.from("data");
  await assert.rejects(
    putFile({ exec: localExec(), root, transferError }, { path: `${root}/target`, body, sha256: sha(body), maxBytes: 10 }),
    (e: Error) => !(e instanceof TransferErr) && /file write failed with exit 1/.test(e.message) && /check that the sandbox is running/.test(e.message),
  );
  assert.deepEqual(readdirSync(root), ["target"], "no .pomtree-put temp file remains");
});

test("NEG put: Node-reserved exit codes (3, 4, 5) are generic exec failures, never transfer verdicts", async () => {
  for (const code of [1, 3, 4, 5, 9]) {
    const exec: ExecWithStdinFn = async () => ({ exitCode: code, stdout: new Uint8Array(0), stderr: "node internal failure" });
    await assert.rejects(
      putFile({ exec, root: "/work", transferError }, { path: "/work/a", body: Buffer.from("x"), sha256: sha("x"), maxBytes: 10 }),
      (e: Error) => !(e instanceof TransferErr) && new RegExp(`exit ${code}`).test(e.message),
      String(code),
    );
  }
});
