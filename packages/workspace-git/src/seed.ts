// Workspace transfer for a sandbox with no bind mount. Seed: the daemon bundles the workspace HEAD (optionally with the
// uncommitted TRACKED changes as one extra commit on a per-call private ref, plus an explicit allowlist of untracked files; other
// untracked files, notably secrets, are never shipped: the throwaway index does not see the operator's global excludes) and records the bundle's sha256 and size; the sandbox runs
// SEED_APPLY_SCRIPT, which refuses a size or hash mismatch and a bundle `git bundle verify` rejects before it touches the
// destination. Results: the bundle comes back with its declared sha256 and size; verifyAndFetchResult checks both,
// verifies the bundle, and fetches it into a private ref, returning the ref. The user's checked-out branch is never moved.
//
// Nothing here is a host path: the bundle carries object ids and the private ref name only, and the failures name no path.
// The seed is taken from the clone the daemon made before the agent ran; git runs hardened (see git-env.ts). Making the
// uncommitted commit leaves loose objects in the workspace repository until gc (gc.auto=0 here).
//
// History leak: the bundle carries every commit reachable from HEAD, so a secret committed once and later removed still ships.
// The deny list below only guards the allowlist and the shipped diff (reported in `warnings`); it is a guard rail, and the
// allowlist is the real control. Review the repository history before seeding a remote sandbox.
//
// Result bundles are untrusted. `git fetch` from a bundle does not run fsck, so the pack is first indexed with `index-pack
// --strict` in a scratch repository that borrows the user's objects (for thin-pack bases); a tree with a `.git` entry or a
// `.gitmodules` symlink stops there and nothing reaches the user's object store. That pass is only as strong as the installed
// git (the fsck rules for .gitattributes and .gitmodules need 2.45.1), so verification fails closed on an older git.

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBundleHead } from "./bundle.ts";
import { evaluateGitVersion } from "./git-env.ts";
import { isGitDirName } from "./tar-seed.ts";
import { GitError, runGit } from "./git-runner.ts";

export type SeedFailure = "hash-mismatch" | "partial" | "too-large" | "invalid" | "git-too-old";
export const MIN_RESULT_GIT = [2, 45, 1] as const;

export class SeedTransferError extends Error {
  readonly reason: SeedFailure;
  constructor(reason: SeedFailure, message: string) {
    super(message);
    this.name = "SeedTransferError";
    this.reason = reason;
  }
}

export const SEED_REF_PREFIX = "refs/pomtree/seed-";
export const DEFAULT_MAX_OBJECTS = 1_000_000;
export const DEFAULT_SEED_MAX_BYTES = 256 * 1024 * 1024;

export interface SeedBundle {
  bytes: Uint8Array;
  sha256: string;
  size: number;
  headCommit: string; // the workspace HEAD
  seedCommit: string; // what the sandbox checks out: headCommit, or the commit holding the uncommitted tree
  warnings: string[]; // shipped tracked paths that look secret (paths only); surface them to the operator
  ref: string; // per-call private ref name inside the bundle; the apply script needs it
}

export interface SeedOptions {
  // Ship tracked changes (modified, deleted, staged) as one commit on top of HEAD. Untracked files are NOT included.
  includeUncommitted?: boolean;
  // Repo-relative untracked files to ship too (implies includeUncommitted). Secret-looking names are refused.
  includeUntracked?: string[];
  maxBytes?: number;
}

const OID = /^[0-9a-f]{40}$/;
const DENY_NAME = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials/i,
  /\.p12$/i,
  /\.(pfx|keystore|jks|p8|ppk|gpg|asc)$/i,
  /^\.git-credentials$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^\.dockercfg$/i,
  /^\.vault-token$/i,
  /^terraform\.tfstate/i,
  /\.tfvars$/i,
  /secret/i,
  /^service-account/i,
  /^kubeconfig$/i,
  /^auth\.json$/i,
];
const DENY_DIR = new Set([".ssh", ".aws", ".kube", ".gnupg", ".docker"]);

// Why a repo-relative path looks secret, or null. A guard rail on names and directory segments, not a scanner of contents.
export function secretLikePath(path: string): string | null {
  const segs = path.split("/");
  const dir = segs.slice(0, -1).find((s) => DENY_DIR.has(s.toLowerCase()));
  if (dir) return `it is under the ${dir} directory`;
  if (DENY_NAME.some((re) => re.test(segs[segs.length - 1]!))) return "the name matches the secret deny list";
  return null;
}

// A repo-relative regular file that is not secret-looking. Throws SeedTransferError("invalid") naming the cause and the action.
function checkUntracked(repo: string, path: string): void {
  const bad = (why: string, action: string) =>
    new SeedTransferError("invalid", `includeUntracked entry ${JSON.stringify(path)} is refused (${why}); ${action}`);
  if (path === "" || path.startsWith("-") || path.startsWith("/") || path.includes("\0") || path.includes("\\") || /^[A-Za-z]:/.test(path))
    throw bad("not a plain repo-relative path", "list repo-relative paths with forward slashes");
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw bad("empty, `.` or `..` segment", "list the file by its path inside the workspace");
  if (segs.some(isGitDirName)) throw bad("inside .git (or a look-alike name)", "remove it from the allowlist");
  const secret = secretLikePath(path);
  if (secret)
    throw bad(
      `${secret}: secret deny list is .env*, *.pem, *.key, id_*, .npmrc, .netrc, credentials*, key stores, tokens, *secret*, kubeconfig and the .ssh, .aws, .kube, .gnupg, .docker directories`,
      "remove it from includeUntracked, or rename the file if it holds no secret",
    );
  // lstat follows a symlinked parent directory, so check each parent on its own.
  for (let i = 1; i < segs.length; i++) {
    const parent = segs.slice(0, i).join("/");
    let pst: ReturnType<typeof lstatSync> | undefined;
    try {
      pst = lstatSync(join(repo, parent));
    } catch {
      // A missing parent is reported as a missing file below.
    }
    if (pst?.isSymbolicLink())
      throw bad(
        `its parent directory ${JSON.stringify(parent)} is a symlink, which could lead outside the workspace`,
        "list individual regular files by their real path",
      );
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(join(repo, path));
  } catch {
    throw bad("it does not exist", "create the file or remove it from the allowlist");
  }
  if (!st.isFile()) throw bad("not a regular file (directory or symlink)", "list individual regular files");
}
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function out(repo: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  const r = await runGit(args, { cwd: repo, passthrough: env, ...(input !== undefined && { input }) });
  return r.stdout.toString("utf8").trim();
}

export async function createSeedBundle(repo: string, opts: SeedOptions = {}): Promise<SeedBundle> {
  const maxBytes = opts.maxBytes ?? DEFAULT_SEED_MAX_BYTES;
  const scratch = mkdtempSync(join(tmpdir(), "pomtree-seed-"));
  try {
    let headCommit: string;
    try {
      headCommit = await out(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {
      throw new SeedTransferError("invalid", "the workspace has no commit to seed from; commit once, or use the tar transfer for a non-git workspace");
    }
    let seedCommit = headCommit;
    let warnings: string[] = [];
    const untracked = opts.includeUntracked ?? [];
    for (const p of untracked) checkUntracked(repo, p);
    if (opts.includeUncommitted || untracked.length) {
      // A throwaway index keeps the user's index and branch untouched.
      const env = {
        GIT_INDEX_FILE: join(scratch, "index"),
        GIT_AUTHOR_NAME: "pomtree",
        GIT_AUTHOR_EMAIL: "seed@pomtree",
        GIT_COMMITTER_NAME: "pomtree",
        GIT_COMMITTER_EMAIL: "seed@pomtree",
        GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
      };
      await out(repo, ["read-tree", headCommit], env);
      await out(repo, ["add", "-u", "--", "."], env);
      if (untracked.length) await out(repo, ["add", "--", ...untracked.map((p) => `:(literal)${p}`)], env);
      const tree = await out(repo, ["write-tree"], env);
      if (tree !== (await out(repo, ["rev-parse", `${headCommit}^{tree}`]))) {
        seedCommit = await out(repo, ["commit-tree", tree, "-p", headCommit, "-m", "Uncommitted work at seed time"], env);
        const changed = (await runGit(["diff-tree", "-r", "--name-only", "-z", headCommit, seedCommit], { cwd: repo })).stdout.toString("utf8").split("\0");
        warnings = changed.filter((p) => p && !untracked.includes(p) && secretLikePath(p) !== null);
      }
    }
    if (!OID.test(seedCommit)) throw new SeedTransferError("invalid", "git returned no commit id for the seed; check the workspace repository");
    const ref = `${SEED_REF_PREFIX}${randomBytes(8).toString("hex")}`;
    await out(repo, ["update-ref", ref, seedCommit]);
    const file = join(scratch, "seed.bundle");
    try {
      await out(repo, ["bundle", "create", file, ref]);
    } finally {
      await out(repo, ["update-ref", "-d", ref]).catch(() => undefined);
    }
    const bytes = readFileSync(file);
    if (bytes.length > maxBytes)
      throw new SeedTransferError(
        "too-large",
        `seed bundle is ${bytes.length} bytes, over the ${maxBytes}-byte cap; shrink the repository, drop uncommitted large files, or raise the cap`,
      );
    return { bytes, sha256: sha256(bytes), size: bytes.length, headCommit, seedCommit, warnings, ref };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Fixed program the sandbox runs (`node -e SEED_APPLY_SCRIPT '<json>'`), node built-ins and git only. Args:
// {bundle: path of the uploaded bundle, sha256, size, dest: new directory, branch, ref: SeedBundle.ref}. It stops before creating `dest` on any size or hash
// mismatch, runs git inside `dest` (the process cwd need not be a repository), and removes what it created if git rejects the bundle.
export const SEED_APPLY_SCRIPT = String.raw`
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const a = JSON.parse(process.argv[1]);
const fail = m => { process.stderr.write(m+'\n'); process.exit(1); };
if (!/^[0-9a-f]{64}$/.test(a.sha256||'') || !Number.isSafeInteger(a.size)) fail('seed arguments are invalid; the daemon must pass sha256 and size');
if (!/^refs\/pomtree\/seed-[0-9a-f]{16}$/.test(a.ref||'')) fail('seed ref is invalid');
if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(a.branch||'') || a.branch.startsWith('-') || a.branch.includes('..')) fail('seed branch name is invalid');
if (typeof a.bundle !== 'string' || typeof a.dest !== 'string' || a.bundle.startsWith('-') || a.dest.startsWith('-')) fail('seed bundle and dest paths must not start with -; pass absolute paths');
if (!require('node:path').isAbsolute(a.dest)) fail('seed destination must be an absolute path; pass the absolute path of a new or empty directory');
if (fs.existsSync(a.dest) && !fs.statSync(a.dest).isDirectory()) fail('seed destination exists and is not a directory; choose a new or empty directory');
let bytes;
try { bytes = fs.readFileSync(a.bundle); } catch (e) { fail('cannot read the seed bundle ('+e.code+'); check the upload completed and the path is correct'); }
if (bytes.length !== a.size) fail('seed bundle is '+bytes.length+' bytes but '+a.size+' were declared; the upload is truncated, resend it whole');
if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) fail('seed bundle sha256 does not match; the upload is corrupt, resend it whole');
const config = ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.ext.allow=never'];
if (fs.existsSync(a.dest) && fs.readdirSync(a.dest).length) fail('seed destination is not empty; choose a fresh directory');
const created = !fs.existsSync(a.dest);
fs.mkdirSync(a.dest, {recursive:true});
function gitIn(args) {
  const r = spawnSync('git', [...config, ...args], {cwd: a.dest, maxBuffer: 16*1024*1024});
  if (r.error || r.status !== 0) {
    fs.rmSync(created ? a.dest : a.dest+'/.git', {recursive:true, force:true});
    fail('seed git '+args.slice(0, args[0]==='bundle' ? 2 : 1).join(' ')+' failed: '+(r.error ? r.error.message : r.stderr.toString().slice(0,2000)));
  }
  return r.stdout.toString();
}
gitIn(['init','-q','-b',a.branch,'.']);
gitIn(['bundle','verify',a.bundle]);
gitIn(['fetch','-q','--',a.bundle,a.ref+':'+a.ref]);
gitIn(['checkout','-q','-B',a.branch,a.ref]);
gitIn(['update-ref','-d',a.ref]);
process.stdout.write(gitIn(['rev-parse','HEAD']).trim()+'\n');
`;

export interface ResultExpect {
  sha256: string;
  size: number;
  maxBytes?: number;
  gitVersion?: string; // output of `git --version`; injected by tests, otherwise the installed git is asked
  maxObjects?: number; // from the bundle's pack preamble; default DEFAULT_MAX_OBJECTS
  // Private ref the result lands on; must be under refs/pomtree/.
  ref: string;
}

async function requireResultGit(output?: string): Promise<void> {
  const raw = output ?? (await runGit(["--version"])).stdout.toString("utf8");
  const found = evaluateGitVersion(raw).version;
  const parts = found?.split(".").map(Number) ?? [];
  const need = MIN_RESULT_GIT.join(".");
  const cmp = parts.length ? (MIN_RESULT_GIT.map((n, i) => Math.sign((parts[i] ?? 0) - n)).find((d) => d !== 0) ?? 0) : -1;
  const older = cmp < 0;
  if (older)
    throw new SeedTransferError(
      "git-too-old",
      `result verification needs git >= ${need} (its strict object check relies on fsck rules added by then) but found ${found ?? "an unknown version"}; upgrade git on the daemon host, then collect again; nothing was applied`,
    );
}

const SOURCE_REF = /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/;
const PRIVATE_REF = /^refs\/pomtree\/[A-Za-z0-9._/-]{1,200}$/;

// Verify, then fetch into `expect.ref` of `repo`. Returns the ref and commit; the caller decides whether to merge.
export async function verifyAndFetchResult(repo: string, bytes: Uint8Array, expect: ResultExpect): Promise<{ ref: string; commit: string }> {
  if (!PRIVATE_REF.test(expect.ref) || expect.ref.includes("..") || expect.ref.endsWith("/") || expect.ref.endsWith(".lock"))
    throw new SeedTransferError("invalid", "result ref must be a plain name under refs/pomtree/; pass a name like refs/pomtree/result/<id>");
  await requireResultGit(expect.gitVersion);
  // The refspec below is not forced, so git would also refuse; this names the cause and the action first. A repeated name must not replace an earlier result or a seed ref.
  const taken = await out(repo, ["rev-parse", "--verify", "--quiet", `${expect.ref}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (taken)
    throw new SeedTransferError(
      "invalid",
      `result ref ${expect.ref} already exists; choose a new ref name (for example one ending in a fresh id) so the earlier ref is not overwritten; nothing was applied`,
    );
  const maxBytes = expect.maxBytes ?? DEFAULT_SEED_MAX_BYTES;
  if (bytes.length > maxBytes)
    throw new SeedTransferError("too-large", `result bundle is ${bytes.length} bytes, over the ${maxBytes}-byte cap; nothing was applied`);
  if (bytes.length !== expect.size)
    throw new SeedTransferError(
      "partial",
      `result bundle is ${bytes.length} bytes but ${expect.size} were declared; it is truncated, resend it whole; nothing was applied`,
    );
  if (sha256(bytes) !== expect.sha256)
    throw new SeedTransferError("hash-mismatch", "result bundle sha256 does not match the declared hash; discard it and collect again; nothing was applied");
  const head = parseBundleHead(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  if (!head.ok) throw new SeedTransferError("invalid", `result bundle is refused (${head.message}); nothing was applied`);
  if (head.header.refs.length !== 1)
    throw new SeedTransferError("invalid", "result bundle must carry exactly one ref; collect again with a single branch; nothing was applied");
  const source = head.header.refs[0]!.name;
  if (!SOURCE_REF.test(source) || source.includes("..") || source.endsWith("/") || source.endsWith(".lock") || source.includes("//"))
    throw new SeedTransferError(
      "invalid",
      "result bundle's ref name is not a plain refs/heads or refs/tags name; collect again from a normally named branch; nothing was applied",
    );
  const maxObjects = expect.maxObjects ?? DEFAULT_MAX_OBJECTS;
  if (head.header.objectCount > maxObjects)
    throw new SeedTransferError(
      "too-large",
      `result bundle claims ${head.header.objectCount} objects, over the ${maxObjects}-object cap; collect a smaller result or raise the cap; nothing was applied`,
    );
  const scratch = mkdtempSync(join(tmpdir(), "pomtree-result-"));
  try {
    const file = join(scratch, "result.bundle");
    writeFileSync(file, bytes);
    try {
      await out(repo, ["bundle", "verify", file]);
    } catch {
      throw new SeedTransferError("partial", "result bundle failed git verification (missing objects or prerequisites); collect again; nothing was applied");
    }
    // Strict pass in a scratch repository that borrows the user's objects (thin-pack bases); nothing is written to the user's store.
    const sandbox = join(scratch, "strict.git");
    try {
      const objects = resolve(repo, await out(repo, ["rev-parse", "--git-path", "objects"]));
      await out(scratch, ["init", "-q", "--bare", sandbox]);
      writeFileSync(join(sandbox, "objects", "info", "alternates"), `${objects}\n`);
    } catch {
      // A raw git or fs error here would name the scratch path.
      throw new SeedTransferError(
        "partial",
        "preparing the strict check for the result bundle failed; check free space in the temporary directory, then collect again; nothing was applied",
      );
    }
    try {
      await runGit(["index-pack", "--stdin", "--strict", "--fix-thin"], { cwd: sandbox, stdinFrom: { path: file, start: head.header.packOffset } });
    } catch (e) {
      // An fsck finding is a hostile object; anything else (bad pack, missing bytes) is a damaged transfer.
      if (e instanceof GitError && /fsck error|hasDotgit|gitmodules/i.test(e.stderr))
        throw new SeedTransferError(
          "invalid",
          "result bundle failed the strict object check (a malformed object, a `.git` tree entry or a `.gitmodules` symlink); discard it and collect again from a clean checkout; nothing was applied",
        );
      throw new SeedTransferError("partial", "result bundle's pack is damaged or truncated; collect again; nothing was applied");
    }
    try {
      await out(repo, ["fetch", "--no-tags", "--no-write-fetch-head", file, `${source}:${expect.ref}`]);
    } catch {
      throw new SeedTransferError("partial", "fetching the result bundle failed; collect again; the user's branch was not changed");
    }
    return { ref: expect.ref, commit: await out(repo, ["rev-parse", "--verify", `${expect.ref}^{commit}`]) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
