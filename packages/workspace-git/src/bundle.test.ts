import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpDir } from "@pomtree/testing";
import { parseBundleHead } from "./bundle.ts";
import { evaluateGitVersion } from "./git-env.ts";
import { GitWorkspace } from "./workspace.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gitVersion.warning ? `real-git tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;

const oid = (c: string) => c.repeat(40);

// The 12-byte pack preamble: "PACK", version 2, object count.
function preamble(count: number): Buffer {
  const b = Buffer.alloc(12);
  b.write("PACK", 0, "latin1");
  b.writeUInt32BE(2, 4);
  b.writeUInt32BE(count, 8);
  return b;
}

const stream = (b: Uint8Array) =>
  (async function* () {
    yield b;
  })();

test("parseBundleHead reads a v3 header with a capability line, refs and object count", () => {
  const text = `# v3 git bundle\n@object-format=sha1\n${oid("c")} refs/heads/x\n\n`;
  const r = parseBundleHead(Buffer.concat([Buffer.from(text), preamble(7)]));
  assert.deepEqual(r, {
    ok: true,
    header: { version: 3, prerequisites: [], refs: [{ oid: oid("c"), name: "refs/heads/x" }], packOffset: text.length, objectCount: 7 },
  });
});

test("parseBundleHead refuses a filter capability line: as a malformed ref in v2, as a filter in v3", () => {
  const filter = "@filter=blob:none\n\n";
  assert.deepEqual(parseBundleHead(Buffer.concat([Buffer.from(`# v2 git bundle\n${filter}`), preamble(0)])), {
    ok: false,
    message: "malformed ref line",
  });
  assert.deepEqual(parseBundleHead(Buffer.concat([Buffer.from(`# v3 git bundle\n${filter}`), preamble(0)])), {
    ok: false,
    message: "filtered bundles are not accepted",
  });
});

test("parseBundleHead refuses a header with no blank line terminator as truncated, without throwing", () => {
  assert.deepEqual(parseBundleHead(Buffer.from(`# v2 git bundle\n${oid("b")} refs/heads/x\n`)), {
    ok: false,
    message: "truncated bundle header",
  });
  // Control: the same ref line, terminated by the blank line and followed by a preamble, parses.
  assert.equal(parseBundleHead(Buffer.concat([Buffer.from(`# v2 git bundle\n${oid("b")} refs/heads/x\n\n`), preamble(0)])).ok, true);
});

test("parseBundleHead refuses a PACK magic with fewer than 12 preamble bytes instead of reading past the end", () => {
  const short = Buffer.concat([Buffer.from("# v2 git bundle\n\n"), Buffer.from("PACK"), Buffer.from([0, 0, 0, 2])]);
  assert.deepEqual(parseBundleHead(short), { ok: false, message: "missing pack data" });
  // Control: the full 12-byte preamble parses.
  assert.equal(parseBundleHead(Buffer.concat([Buffer.from("# v2 git bundle\n\n"), preamble(0)])).ok, true);
});

test("ingest refuses a header longer than MAX_BUNDLE_HEADER_BYTES as bad_bundle; the parser alone has no such cap", { skip }, async () => {
  const refs = Array.from({ length: 20_000 }, (_, i) => `${oid("d")} refs/heads/r${i}\n`).join("");
  const bytes = Buffer.concat([Buffer.from(`# v2 git bundle\n${refs}\n`), preamble(0)]);
  assert.ok(bytes.length > 1 << 20, "the fixture must exceed the 1 MiB header bound");
  // Control: the same bytes parse when the caller hands the parser the whole file, so the refusal below comes from the bound.
  assert.equal(parseBundleHead(bytes).ok, true);

  const base = tmpDir("wsgit-bundle-");
  const repo = join(base, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "one");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  const ws = new GitWorkspace({
    repoDir: repo,
    mirrorDir: join(base, "mirror.git"),
    foldersRoot: join(base, "folders"),
    tmpRoot: join(base, "tmp"),
  });
  const r = await ws.ingest("x", stream(bytes), { maxBytes: 1 << 22 });
  assert.deepEqual(r, { ok: false, code: "bad_bundle", message: "truncated bundle header" });
});
