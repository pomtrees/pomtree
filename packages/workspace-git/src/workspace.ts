import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AgentId, ForcedRefUpdate, IngestFailCode, IngestResult, PruneResult, PublishReview, Workspace, WorkspaceId } from "@pomtree/core";
import { parseBundleHead, MAX_BUNDLE_HEADER_BYTES } from "./bundle.ts";
import { fileSource, scanPack } from "./pack-scan.ts";
import { evaluateGitVersion } from "./git-env.ts";
import { GitError, gitText, runGit, type RunOptions } from "./git-runner.ts";
import {
  agentBasePrefix,
  agentBranchOf,
  agentHeadsPrefix,
  checkBundleRefs,
  checkEntry,
  checkSymlinkTarget,
  modeKind,
  parseRawZ,
  validAgentId,
  validBranchName,
  type PolicyViolation,
} from "./ref-policy.ts";

export { MIN_SAFE_GIT, evaluateGitVersion } from "./git-env.ts";

export interface GitWorkspaceOptions {
  repoDir: string; // the operator's repository (POMTREED_REPO_DIR); trusted, read only
  mirrorDir: string; // the controller's bare mirror; created on first use
  foldersRoot: string; // one private full clone per agent lives directly under this directory
  tmpRoot?: string; // quarantine and bundle scratch space; defaults to os.tmpdir()
  maxObjects?: number; // ingest cap on pack objects (default 2,000,000)
  maxCommits?: number; // ingest cap on new commits inspected (default 50,000)
  maxUnpackedBytes?: number; // ingest cap on the summed inflated size of new objects (default 2 GiB); enforced by a pack scan before index-pack runs
  maxQuarantineBytes?: number; // ingest cap on total quarantine disk use (default 8 GiB); fail closed
  // Construction removes `.tmp-<agent>-<hex>` copies a crashed create or fork left under foldersRoot once they are
  // at least this old (default 1 hour, by the later of mtime and ctime; 0 sweeps every such copy); copies in flight in
  // this process are never touched.
  staleTmpMs?: number;
  // Called after each named step. A throw simulates (or is) a crash at that point. The fault-injection and tracing seam.
  observe?: WorkspaceObserver;
  // gitignore patterns for host-managed paths inside a folder (pomtreed passes the Pi session mount, WORKSPACE_GIT_EXCLUDES), written as
  // the folder's controller-authored `.git/info/exclude` when create clones it and when fork sanitises it, so git in the folder (the
  // agent's own, `pomtree result`'s dirtiness check, an approved save's `git add -A`) never counts or commits them. Absent = no exclude file.
  infoExclude?: readonly string[];
  // Lets publish push to an absolute local path (a bare repo on this host). Off by default: a local path
  // publishes nothing off the machine and bypasses the remote's own access control; tests and an operator's local mirror opt in.
  allowLocalPublishRemotes?: boolean;
}

// A publish refused by policy (the pushed range or the remote's report did not match the review); nothing was pushed
// unless the message says the remote reported an unexpected update.
export class PublishRefusedError extends Error {
  constructor(message: string) {
    super(`publish refused: ${message}`);
    this.name = "PublishRefusedError";
  }
}

// "ingest_intent_written": the write-ahead intent exists, the refs have not moved yet (a crash here leaves only the intent).
// "ingest_refs_updated": the mirror refs moved, the ingested record is not yet written (the C2b-13 window).
// "fork_copied": the child's temp copy exists under foldersRoot and is about to be sanitised.
export type WorkspaceObserver = (e: {
  phase: "ingest_intent_written" | "ingest_refs_updated" | "fork_copied";
  agent: AgentId;
  path?: string;
}) => void | Promise<void>;

// Temp copies being built by any GitWorkspace in this process; the construction sweep skips them.
const inflightTmp = new Set<string>();
const TMP_COPY = /^\.tmp-(.+)-[0-9a-f]{8}$/;
// Scratch a crashed ingest or serve leaves under tmpRoot (mkdtemp's six-character suffix), and the mirror's own
// half-written files: writeAtomic's `<name>.<hex>.tmp` and ingest's `tmp_<hex>_pack-*` copies.
const TMP_SCRATCH = /^ws[qs]-[A-Za-z0-9]{6}$/;
const MIRROR_TMP = /^(?:.+\.[0-9a-f]{8}\.tmp|tmp_[0-9a-f]{8}_pack-[0-9a-f]+\.(?:pack|rev|idx))$/;
const inflightScratch = new Set<string>();

// A cheap fingerprint of a folder tree (path, type, size, mtime, inode; symlinks not followed), to tell whether the
// parent's folder changed while fork copied it.
function treeFingerprint(root: string): string {
  const h = createHash("sha256");
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p, { bigint: true });
      h.update(`${p}\0${st.mode}\0${st.size}\0${st.mtimeNs}\0${st.ino}\n`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return h.digest("hex");
}

class IngestFail extends Error {
  readonly code: IngestFailCode;
  constructor(code: IngestFailCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface FolderMeta {
  commit: string;
  branch: string;
}

const HEX40 = /^[0-9a-f]{40}$/;

// Thrown when an agent-written `.git` is not a plain files-backend repository the controller will run git on.
export class UnsafeGitDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeGitDirError";
  }
}

// Paths under `.git` that redirect git elsewhere or extend its behaviour; removed from a forked copy.
const GITDIR_REMOVE = [
  "commondir",
  "gitdir",
  "worktrees",
  "modules",
  "config.worktree",
  "shallow",
  "info/grafts",
  "info/attributes",
  "info/sparse-checkout",
  "hooks",
  "objects/info/alternates",
  "objects/info/http-alternates",
];

// Removes a copy even when it holds read-only directories (mode 0500 inside the copy): a failed cleanup must not mask the error.
function forceRemove(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    try {
      makeWritable(p);
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort: the caller rethrows the original failure
    }
  }
}

function makeWritable(p: string): void {
  if (!lstatSync(p).isDirectory()) return;
  chmodSync(p, 0o700);
  for (const n of readdirSync(p)) makeWritable(join(p, n));
}

// Stale lock files (a parent killed mid-git) would make the fork's own git fail closed; the copy is private, so they go.
function scanGitDir(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new UnsafeGitDirError("symlink inside .git");
    if (e.isDirectory()) scanGitDir(p);
    else if (e.name.endsWith(".promisor") || e.name.endsWith(".lock")) rmSync(p, { force: true });
  }
}

// Makes the copied `.git` safe for the controller's git, with plain fs calls only (no git runs). Fails closed.
function sanitizeGitDir(gitDir: string, child: AgentId): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(gitDir);
  } catch {
    throw new UnsafeGitDirError(".git is missing");
  }
  if (!st.isDirectory()) throw new UnsafeGitDirError(".git is not a real directory"); // symlink or gitfile
  scanGitDir(gitDir);
  if (existsSync(join(gitDir, "reftable"))) throw new UnsafeGitDirError("reftable repositories are not supported");
  let cfg = "";
  try {
    cfg = readFileSync(join(gitDir, "config"), "utf8");
  } catch {
    // a missing config is replaced below
  }
  if (/^\s*\[\s*extensions\s*[\].\s]/im.test(cfg)) throw new UnsafeGitDirError("repository extensions are not supported");
  for (const rel of GITDIR_REMOVE) rmSync(join(gitDir, rel), { recursive: true, force: true });
  // Deliberate: the child's git runs in a Linux container, so the macOS keys `git clone` wrote (core.ignorecase,
  // precomposeunicode, symlinks) are dropped and filemode is fixed true. Revisit if children ever run git on the host fs.
  writeFileSync(
    join(gitDir, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[user]\n\tname = ${child}\n\temail = ${child}@agents.pomtree\n`,
  );
}

// Probe `git --version` through the hardened runner; null warning means >= MIN_SAFE_GIT.
export async function checkGitVersion(): Promise<{ version: string | null; warning: string | null }> {
  try {
    return evaluateGitVersion(await gitText(["--version"]));
  } catch {
    return evaluateGitVersion("");
  }
}

export class GitWorkspace implements Workspace {
  private repo: string;
  private mirror: string;
  private root: string;
  private tmp: string;
  private maxObjects: number;
  private maxCommits: number;
  private maxUnpackedBytes: number;
  private maxQuarantineBytes: number;
  private locks = new Map<string, Promise<unknown>>();
  private versionCheck: Promise<{ version: string | null; warning: string | null }> | undefined;
  private observe: WorkspaceObserver | undefined;
  private exclude: string | undefined;
  private localPublish: boolean;

  constructor(o: GitWorkspaceOptions) {
    mkdirSync(o.foldersRoot, { recursive: true });
    mkdirSync(o.mirrorDir, { recursive: true });
    this.repo = realpathSync(o.repoDir);
    this.mirror = realpathSync(o.mirrorDir);
    this.root = realpathSync(o.foldersRoot);
    const tmpRoot = o.tmpRoot ?? tmpdir();
    mkdirSync(tmpRoot, { recursive: true });
    this.tmp = realpathSync(tmpRoot);
    this.maxObjects = o.maxObjects ?? 2_000_000;
    this.maxCommits = o.maxCommits ?? 50_000;
    this.maxUnpackedBytes = o.maxUnpackedBytes ?? 2 * 1024 ** 3;
    this.maxQuarantineBytes = o.maxQuarantineBytes ?? 8 * 1024 ** 3;
    this.observe = o.observe;
    if (o.infoExclude?.some((p) => p.trim() === "" || /[\r\n\0]/.test(p))) throw new Error("infoExclude patterns must be non-blank single lines");
    this.exclude = o.infoExclude?.length ? `${o.infoExclude.join("\n")}\n` : undefined;
    this.localPublish = o.allowLocalPublishRemotes === true;
    this.sweepStaleTmp(o.staleTmpMs ?? 60 * 60 * 1000);
  }

  // A crash mid-create or mid-fork leaves its `.tmp-<agent>-<hex>` copy behind (fork-git-version residual). Only
  // entries named exactly like a copy, not in flight in this process, and at least `ageMs` old go (so ageMs 0 sweeps
  // every such copy); live folders (no leading dot) and anything else under the root are left alone. ctime counts
  // because a fork's copy keeps the parent's mtime (preserveTimestamps). The age is clamped at zero: fs timestamps
  // carry sub-millisecond fractions (or a future mtime), so a copy from this very millisecond reads slightly
  // negative against Date.now(). Best effort: a failure here never blocks construction.
  private sweepStaleTmp(ageMs: number): void {
    const now = Date.now();
    for (const name of readdirSync(this.root)) {
      const m = TMP_COPY.exec(name);
      if (!m || !validAgentId(m[1]!)) continue;
      const p = join(this.root, name);
      if (inflightTmp.has(p)) continue;
      try {
        const st = lstatSync(p);
        if (Math.max(0, now - Math.max(st.mtimeMs, st.ctimeMs)) < ageMs) continue;
        if (st.isDirectory()) forceRemove(p);
        else rmSync(p, { force: true });
      } catch {
        // gone already, or not removable: the next construction retries
      }
    }
    // The same age rule for ingest/serve scratch under tmpRoot (only this user's directories with the exact mkdtemp shape,
    // since tmpRoot may be the shared os.tmpdir()) and for the mirror's half-written temp files.
    const uid = process.getuid?.();
    const old = (p: string, st: { mtimeMs: number; ctimeMs: number }) =>
      Math.max(0, now - Math.max(st.mtimeMs, st.ctimeMs)) >= ageMs && !inflightScratch.has(p);
    for (const name of readdirSync(this.tmp)) {
      if (!TMP_SCRATCH.test(name)) continue;
      const p = join(this.tmp, name);
      try {
        const st = lstatSync(p);
        if (st.isDirectory() && (uid === undefined || st.uid === uid) && old(p, st)) rmSync(p, { recursive: true, force: true });
      } catch {
        // best effort, as above
      }
    }
    for (const d of [join(this.mirror, "objects", "pack"), ...["folders", "ingested", "ingest-pending"].map((n) => join(this.mirror, "pomtree", n))]) {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!MIRROR_TMP.test(name)) continue;
        try {
          const st = lstatSync(join(d, name));
          if (st.isFile() && old(join(d, name), st)) rmSync(join(d, name), { force: true });
        } catch {
          // best effort, as above
        }
      }
    }
  }

  // --- plumbing -----------------------------------------------------------------------------

  // Thrown messages echo command lines and git stderr, which name host paths; they become placeholders so
  // a failure surfaced to a journal row never carries them.
  private scrub(text: string): string {
    return [
      [this.root, "<workspaces>"],
      [this.mirror, "<mirror>"],
      [this.repo, "<repo>"],
      [this.tmp, "<tmp>"],
    ]
      .sort((a, b) => b[0]!.length - a[0]!.length)
      .reduce((t, [p, ph]) => t.split(p!).join(ph!), text);
  }

  private run(args: string[], opts: RunOptions = {}) {
    return runGit(args, { tmpdir: this.tmp, ...opts }, (s) => this.scrub(s));
  }

  private async text(args: string[], opts: RunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.toString("utf8").trim();
  }

  // Runs in the mirror (controller-owned bare repo).
  private mg(args: string[], opts: RunOptions = {}) {
    return this.text(["--git-dir", this.mirror, ...args], opts);
  }

  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private checkAgent(agent: AgentId): void {
    if (!validAgentId(agent)) throw new Error(`invalid agent id for workspace: ${JSON.stringify(agent)}`);
  }

  private dir(agent: AgentId): string {
    this.checkAgent(agent);
    return join(this.root, agent);
  }

  // Opaque, restart-stable workspace id derived from the agent id alone (no in-memory map, no path).
  idFor(agent: AgentId): WorkspaceId {
    this.checkAgent(agent);
    return `ws-${createHash("sha256").update(`workspace\0${agent}`).digest("hex").slice(0, 16)}`;
  }

  // NOT a Workspace port method: adapter-internal id -> folder directory, for the daemon's MountProvider.
  hostPath(id: WorkspaceId): string {
    for (const name of readdirSync(this.root)) {
      try {
        if (name.startsWith(".") || this.idFor(name) !== id) continue;
        const dir = this.dir(name);
        if (dirname(realpathSync(dir)) !== this.root) continue; // a symlink escaping the root is not a folder
        return dir;
      } catch {
        continue;
      }
    }
    throw new Error(`unknown workspace ${JSON.stringify(id)}`);
  }

  // Controller metadata lives in the mirror dir, never in an agent-writable folder.
  private metaFile(agent: AgentId) {
    return join(this.mirror, "pomtree", "folders", `${agent}.json`);
  }
  private ingestedFile(agent: AgentId) {
    return join(this.mirror, "pomtree", "ingested", agent);
  }
  // `<ref> <new> <old>`: the write-ahead intent of an ingest's ref update; removed once the record is written.
  private pendingFile(agent: AgentId) {
    return join(this.mirror, "pomtree", "ingest-pending", agent); // own directory: agent ids may contain dots
  }

  private writeAtomic(file: string, data: string): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  }

  private readMeta(agent: AgentId): FolderMeta | null {
    try {
      const m = JSON.parse(readFileSync(this.metaFile(agent), "utf8")) as FolderMeta;
      return HEX40.test(m.commit) && typeof m.branch === "string" ? m : null;
    } catch {
      return null;
    }
  }

  private async ensureMirror(): Promise<void> {
    if (existsSync(join(this.mirror, "HEAD"))) return;
    await this.run(["init", "--bare", "-q", "--template=", this.mirror]);
    // Resume falls back to a commit that is only reachable from refs/agents/*; the clone fetches it by id.
    await this.mg(["config", "uploadpack.allowAnySHA1InWant", "true"]);
  }

  // Brings the operator's branches into the mirror (create-time refresh; also how operator commits reach agents).
  // Returns the branches (full refs) NOT updated because the mirror's copy diverged from the operator's (the merge
  // engine advanced it, or the operator rewrote history); fast-forward-only, so they keep the mirror's tip.
  async refreshMirror(): Promise<{ diverged: string[] }> {
    return this.lock("mirror", async () => {
      let diverged: string[] = [];
      await this.ensureMirror();
      // Fast-forward only: a branch the merge engine advanced (main after an approved top-level merge) is never
      // rewound to the operator's older tip. A rejected update exits 1 while the other refs still update.
      // TODO(repos): a diverged branch is only reported (refreshMirror's return value); publish and an operator pull reconcile it.
      const fetched = await this.run(["--git-dir", this.mirror, "fetch", "--no-tags", "--prune", this.repo, "refs/heads/*:refs/heads/*"], { okCodes: [1] });
      if (fetched.code !== 0 && !/\(non-fast-forward\)|\(would clobber/.test(fetched.stderr))
        throw new GitError(this.scrub(`git fetch failed (exit ${fetched.code}): ${fetched.stderr.trim()}`), fetched.code, this.scrub(fetched.stderr));
      diverged = [...fetched.stderr.matchAll(/^\s*!\s+\[rejected\]\s+\S+\s+->\s+(\S+)/gm)].map((m) => `refs/heads/${m[1]!.replace(/^refs\/heads\//, "")}`);
      const head = await this.text(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: this.repo }).catch(() => "");
      if (
        head &&
        validBranchName(head) &&
        (await this.mg(["rev-parse", "--verify", "--quiet", `refs/heads/${head}`]).then(
          () => true,
          () => false,
        ))
      ) {
        await this.mg(["symbolic-ref", "HEAD", `refs/heads/${head}`]);
      }
      return { diverged };
    });
  }

  private async resolveStart(fromCommit: string | undefined): Promise<string> {
    if (fromCommit !== undefined && (fromCommit.startsWith("-") || fromCommit === "")) throw new Error("invalid reference");
    try {
      return await this.mg(["rev-parse", "--verify", "--quiet", `${fromCommit ?? "HEAD"}^{commit}`]);
    } catch {
      // A repository with no commits fails every rev-parse the same way; say so, since "invalid reference" gives the operator nothing to fix.
      const refs = await this.mg(["for-each-ref", "--count=1", "--format=%(refname)"]).catch(() => "unknown");
      if (refs === "")
        throw new Error("the repository has no commits yet, so there is nothing to branch from; create one (git commit --allow-empty -m init), then retry");
      throw new Error("invalid reference");
    }
  }

  // Entitlement anchor for a fork/resume base the controller itself handed the agent: create({fromCommit})
  // seeds the commit under the agent's own refs/agents/<id>/base/ so the ingest prerequisite check accepts
  // exactly that base, without opening refs/agents/* to sibling namespaces. Idempotent (same ref, same
  // value); prune deletes it with the rest of the agent's refs.
  private async seedBase(agent: AgentId, commit: string): Promise<void> {
    await this.lock("mirror", async () => {
      await this.ensureMirror();
      await this.mg(["update-ref", `${agentBasePrefix(agent)}${commit}`, commit]);
    });
  }

  // --- folders ------------------------------------------------------------------------------

  // Only on a copy no agent has written yet (a fresh clone) or one sanitizeGitDir has just checked (no symlink inside `.git`), so the
  // write cannot be redirected. It replaces any exclude file the copy had: like `.git/config`, the content is controller-authored.
  private writeInfoExclude(gitDir: string): void {
    if (this.exclude === undefined) return;
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), this.exclude);
  }

  async create(agent: AgentId, opts: { fromCommit?: string }) {
    const dir = this.dir(agent);
    return this.lock(`folder:${agent}`, async () => {
      const prior = this.readMeta(agent);
      if (prior && existsSync(dir)) {
        // TODO(session-exclude): an existing folder is agent-written, so its `.git/info/exclude` is not (re)written here; a folder cloned
        // before infoExclude existed keeps counting `.pi-session/` as uncommitted work until the agent is respawned into a new folder.
        if (opts.fromCommit) {
          const want = await this.resolveStart(opts.fromCommit);
          if (want !== prior.commit) throw new Error(`workspace ${agent} already exists at ${prior.commit}, not requested ${want}`);
          await this.seedBase(agent, want); // a no-op replay; repairs a create that crashed before seeding
        }
        return { branch: prior.branch, commit: prior.commit, workspace: this.idFor(agent) };
      }
      rmSync(dir, { recursive: true, force: true }); // a crashed create leaves a folder without metadata
      await this.refreshMirror();
      const start = await this.resolveStart(opts.fromCommit);
      if (opts.fromCommit !== undefined) await this.seedBase(agent, start);
      const branch = `agent/${agent}`;
      const tmp = join(this.root, `.tmp-${agent}-${randomBytes(4).toString("hex")}`);
      inflightTmp.add(tmp);
      try {
        // A fresh clone of our own mirror: nothing agent-supplied is read. Hardlinks are off so an agent can never write the mirror's object files.
        await this.run(["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--template=", this.mirror, tmp]);
        const g = (args: string[]) => this.text(["--git-dir", join(tmp, ".git"), "--work-tree", tmp, ...args], { cwd: tmp });
        if (
          !(await g(["cat-file", "-t", start]).then(
            (t) => t === "commit",
            () => false,
          ))
        ) {
          await g(["fetch", "--quiet", "--no-tags", this.mirror, start]);
        }
        await g(["checkout", "--quiet", "--force", "-B", branch, start]);
        await g(["remote", "remove", "origin"]);
        await g(["config", "user.name", agent]);
        await g(["config", "user.email", `${agent}@agents.pomtree`]);
        this.writeInfoExclude(join(tmp, ".git"));
        this.writeAtomic(this.metaFile(agent), JSON.stringify({ commit: start, branch } satisfies FolderMeta));
        renameSync(tmp, dir);
      } catch (err) {
        rmSync(tmp, { recursive: true, force: true });
        rmSync(this.metaFile(agent), { force: true });
        throw err;
      } finally {
        inflightTmp.delete(tmp);
      }
      return { branch, commit: start, workspace: this.idFor(agent) };
    });
  }

  // TODO(git-clone): finish the untrusted-agent gate and test fork on git 2.38 to 2.43. Current behavior: fork sanitizes the
  // copied .git before running git, and runs git only in that copy. The gate spans other components, with no single code site.
  // Invariant: git runs only on a sanitised copy. The folder is agent-written, so the byte copy (symlinks copied as
  // links, never followed) is sanitised BEFORE any git touches it: `.git` must be a real directory holding no symlink
  // and no extension/reftable markers, every redirect or extension file is deleted, and `.git/config` is replaced with
  // controller-authored content (nothing the agent wrote survives: no promisor/partialClone, sshCommand, uploadpack,
  // include, url rewrites, credential helpers). Only then is the copy re-branched in place and renamed into place: the
  // child gets `agent/<child>` at the copy's HEAD (the fork point), checked out. The parent's folder is never touched.
  async fork(parent: AgentId, child: AgentId) {
    const from = this.dir(parent);
    const dir = this.dir(child);
    return this.lock(`folder:${child}`, async () => {
      const pm = this.readMeta(parent);
      if (!pm || !existsSync(from)) throw new Error(`no workspace for ${parent}`);
      const prior = this.readMeta(child);
      // Idempotent: a re-run for a folder that already exists returns its recorded branch and never moves it.
      if (prior && existsSync(dir)) return { branch: prior.branch, commit: prior.commit, workspace: this.idFor(child) };
      rmSync(dir, { recursive: true, force: true });
      const tmp = join(this.root, `.tmp-${child}-${randomBytes(4).toString("hex")}`);
      const branch = `agent/${child}`;
      inflightTmp.add(tmp);
      try {
        // The parent must be stopped: a folder still being written (a parent still stopping) would give a torn copy, so the
        // source is fingerprinted around the copy and a change fails the fork closed.
        const before = treeFingerprint(from);
        cpSync(from, tmp, { recursive: true, verbatimSymlinks: true, dereference: false, preserveTimestamps: true, errorOnExist: true });
        await this.observe?.({ phase: "fork_copied", agent: child, path: tmp });
        if (treeFingerprint(from) !== before)
          throw new Error(
            `fork of ${parent}: the parent's folder changed while it was being copied (the parent is still running or stopping); stop the parent and retry the fork`,
          );
        sanitizeGitDir(join(tmp, ".git"), child);
        this.writeInfoExclude(join(tmp, ".git"));
        // TODO(fork-git-version): test the fork on git 2.40 to 2.43. Current behavior: GIT_NO_LAZY_FETCH, set by noLazyFetch, is
        // only honoured by git 2.44 and later; before that, the config overwrite in sanitizeGitDir is the defence.
        // Lazy fetch is off for the copy's git calls only (the copy's config is controller-authored, see sanitizeGitDir).
        const copyOpts = { cwd: tmp, noLazyFetch: true };
        const g = (args: string[]) => this.text(["--git-dir", join(tmp, ".git"), "--work-tree", tmp, ...args], copyOpts);
        const forkPoint = await g(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
        // The bundle base is the controller's fork commit (pm.commit); seed the child's own anchor for it so the first ingest accepts it.
        await this.seedBase(child, pm.commit);
        await g(["update-ref", `refs/heads/${branch}`, forkPoint]);
        await g(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
        // Drop the copied parent branch name only when nothing is lost: absent is skipped, and a tip that is not an ancestor
        // of the fork point (the parent's HEAD was on another branch, with unshipped work here) is kept, a stray but safe branch.
        const parentRef = `refs/heads/${pm.branch}`;
        if (parentRef !== `refs/heads/${branch}`) {
          const tip = (await this.run(["--git-dir", join(tmp, ".git"), "rev-parse", "--verify", "--quiet", parentRef], { ...copyOpts, okCodes: [1] })).stdout
            .toString("utf8")
            .trim();
          if (tip) {
            const anc = await this.run(["--git-dir", join(tmp, ".git"), "merge-base", "--is-ancestor", tip, forkPoint], { ...copyOpts, okCodes: [1] });
            if (anc.code === 0) await g(["update-ref", "-d", parentRef]);
          }
        }
        this.writeAtomic(this.metaFile(child), JSON.stringify({ commit: pm.commit, branch } satisfies FolderMeta));
        renameSync(tmp, dir);
      } catch (err) {
        forceRemove(tmp);
        rmSync(this.metaFile(child), { force: true });
        if (err instanceof GitError || err instanceof UnsafeGitDirError) throw err;
        // fs errors name the copy's host path; scrub it like a GitError message before it reaches a journal row.
        throw new Error(this.scrub(err instanceof Error ? err.message : String(err)));
      } finally {
        inflightTmp.delete(tmp);
      }
      return { branch, commit: pm.commit, workspace: this.idFor(child) };
    });
  }

  async has(agent: AgentId): Promise<boolean> {
    return existsSync(this.dir(agent)) && this.readMeta(agent) !== null;
  }

  async list(): Promise<AgentId[]> {
    return readdirSync(this.root).filter((n) => !n.startsWith(".") && lstatSync(join(this.root, n)).isDirectory());
  }

  async evict(agent: AgentId): Promise<void> {
    const dir = this.dir(agent);
    await this.lock(`folder:${agent}`, async () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(this.metaFile(agent), { force: true });
    });
  }

  // --- ingest -------------------------------------------------------------------------------

  async ingest(agent: AgentId, bundle: AsyncIterable<Uint8Array>, opts: { maxBytes: number; force?: boolean }): Promise<IngestResult> {
    this.checkAgent(agent);
    const q = mkdtempSync(join(this.tmp, "wsq-"));
    inflightScratch.add(q);
    try {
      this.versionCheck ??= checkGitVersion();
      const v = await this.versionCheck;
      if (v.warning) throw new IngestFail("git_version", v.warning);
      const out = await this.quarantine(agent, q, bundle, opts.maxBytes, opts.force === true);
      // `forcedFrom` is the only record of the tips the force overwrote, so it rides out with `forced` rather than being dropped here.
      return out.forcedFrom.length > 0 ? { ok: true, refs: out.refs, forced: true, forcedFrom: out.forcedFrom } : { ok: true, refs: out.refs };
    } catch (err) {
      if (err instanceof IngestFail) return { ok: false, code: err.code, message: this.scrub(err.message) };
      return { ok: false, code: "unknown", message: this.scrub(err instanceof Error ? err.message : String(err)) };
    } finally {
      rmSync(q, { recursive: true, force: true });
      inflightScratch.delete(q);
    }
  }

  private async quarantine(
    agent: AgentId,
    q: string,
    bundle: AsyncIterable<Uint8Array>,
    maxBytes: number,
    force: boolean,
  ): Promise<{ refs: { ref: string; commit: string }[]; forcedFrom: ForcedRefUpdate[] }> {
    // 1. Stream to a temp file; the cap is enforced while streaming.
    const file = join(q, "in.bundle");
    const fh = await open(file, "w", 0o600);
    let size = 0;
    try {
      for await (const chunk of bundle) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new IngestFail("too_large", `bundle exceeds ${maxBytes} bytes`);
        await fh.write(chunk);
      }
    } finally {
      await fh.close();
    }
    // 2. Header and pack preamble, before any git process sees the data.
    const head = Buffer.alloc(Math.min(size, MAX_BUNDLE_HEADER_BYTES + 12));
    const rfd = openSync(file, "r");
    try {
      readSync(rfd, head, 0, head.length, 0);
    } finally {
      closeSync(rfd);
    }
    const parsed = parseBundleHead(head);
    if (!parsed.ok) throw new IngestFail("bad_bundle", parsed.message);
    const h = parsed.header;
    if (h.objectCount > this.maxObjects) throw new IngestFail("too_large", `bundle holds ${h.objectCount} objects (cap ${this.maxObjects})`);
    const existing = (await this.mg(["for-each-ref", "--format=%(refname)", agentHeadsPrefix(agent)]))
      .split("\n")
      .filter(Boolean)
      .map((r) => agentBranchOf(agent, r))
      .filter((n): n is string => n !== null);
    const refCheck = checkBundleRefs(
      h.refs.map((r) => r.name),
      existing,
    );
    if ("code" in refCheck) throw new IngestFail(refCheck.code, refCheck.message);
    const tips = h.refs.filter((r) => r.name !== "HEAD");

    // 2b. Pre-execution inflation bound: index-pack inflates every object to hash it, so a small pack that
    // expands hugely (a zlib bomb) is only bounded by a scan that counts inflated bytes before git sees the
    // pack; the post-hoc accounting below comes too late to bound the disk or memory used during verification.
    // The pack is read in bounded windows straight from the quarantined file, never loaded whole (C2b-12).
    const pfh = await open(file, "r");
    let scan: Awaited<ReturnType<typeof scanPack>>;
    try {
      scan = await scanPack(fileSource(pfh, h.packOffset, size - h.packOffset), { maxInflatedBytes: this.maxUnpackedBytes });
    } finally {
      await pfh.close();
    }
    if (!scan.ok) throw new IngestFail(scan.code, scan.message);

    // 3. Throwaway bare repo with the mirror as read-only alternate.
    const qg = join(q, "q.git");
    await this.run(["init", "--bare", "-q", "--template=", qg]);
    writeFileSync(join(qg, "objects", "info", "alternates"), `${join(this.mirror, "objects")}\n`);
    const g = (args: string[], o: RunOptions = {}) => this.run(["--git-dir", qg, ...args], o);
    const gt = async (args: string[], o: RunOptions = {}) => (await g(args, o)).stdout.toString("utf8").trim();
    for (const p of h.prerequisites) {
      const kind = await this.mg(["cat-file", "-t", p]).catch(() => "");
      if (kind !== "commit") throw new IngestFail("prerequisite", `bundle requires commit ${p} which the mirror does not hold`);
      // The quarantine resolves objects against the whole mirror, so every prerequisite must be reachable from
      // refs the agent is entitled to build on: the operator's branches, its own namespace, or a fork base the
      // controller seeded under refs/agents/<id>/base/. A guessed foreign commit (another agent's) cannot
      // anchor a bundle or its thin-pack bases.
      const held = await this.mg([
        "for-each-ref",
        "--contains",
        p,
        "--count=1",
        "--format=%(refname)",
        "refs/heads",
        agentHeadsPrefix(agent),
        agentBasePrefix(agent),
      ]);
      if (!held) throw new IngestFail("prerequisite", `bundle prerequisite ${p} is not reachable from the operator's branches or ${agent}'s own refs`);
    }

    // 4. index-pack --strict is the integrity control (fsck rules, connectivity, size cap).
    try {
      await g(["index-pack", "--stdin", "--strict", "--fix-thin", `--max-input-size=${maxBytes}`], { stdinFrom: { path: file, start: h.packOffset } });
    } catch (err) {
      throw this.classifyPackFailure(err);
    }
    // Total quarantine disk bound, fail closed: the bundle file, the received pack, index-pack's temp files for
    // large objects and any fix-thin bases adopted from the mirror all live under q and together stay under the cap.
    let qBytes = 0;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) qBytes += lstatSync(p).size;
      }
    };
    walk(q);
    if (qBytes > this.maxQuarantineBytes) throw new IngestFail("too_large", `quarantine used ${qBytes} bytes on disk (cap ${this.maxQuarantineBytes})`);
    for (const t of tips) {
      if ((await gt(["cat-file", "-t", t.oid]).catch(() => "")) !== "commit")
        throw new IngestFail("bad_bundle", `ref ${JSON.stringify(t.name)} does not name a commit in the bundle`);
    }

    // 5. Path / mode / symlink / submodule rules over what the new commits introduce.
    const range = `${tips.map((t) => t.oid).join("\n")}\n${h.prerequisites.map((p) => `^${p}`).join("\n")}\n`;
    const objects = await g(["rev-list", "--stdin", "--objects", "--no-object-names"], { input: range }).catch(() => {
      throw new IngestFail("bad_bundle", "bundle is not self-contained (missing objects)");
    });
    const listed = objects.stdout.toString("latin1").split("\n").filter(Boolean);
    if (listed.length > this.maxObjects) throw new IngestFail("too_large", "bundle introduces too many objects");
    // Connectivity must come from the bundle itself: an object the pack does not carry but the mirror (the
    // alternate) happens to hold, e.g. another agent's blob named by guessed hash, is refused rather than adopted.
    const packOids = new Set<string>();
    const qpack = join(qg, "objects", "pack");
    for (const n of readdirSync(qpack).filter((f) => f.endsWith(".idx"))) {
      const idx = await this.run(["show-index"], { input: readFileSync(join(qpack, n)), maxOutput: 512 * 1024 * 1024 });
      for (const l of idx.stdout.toString("latin1").split("\n")) {
        const o = l.split(" ")[1];
        if (o) packOids.add(o);
      }
    }
    if (listed.some((o) => !packOids.has(o)))
      throw new IngestFail("prerequisite", "bundle references objects it does not carry and that are not in its prerequisites' history");
    // --fix-thin adopts a thin pack's base objects from the alternate (the whole mirror): a guessed foreign blob
    // named as a ref-delta base would be pulled in this way. The adopted objects are exactly those in the indexed
    // pack that the scan did not see as non-delta entries and that are not new objects of the bundle's own
    // history; each must come from the prerequisites' history (itself scoped to refs the agent is entitled to).
    const listedSet = new Set(listed);
    const appended = [...packOids].filter((o) => !scan.oids.has(o) && !listedSet.has(o));
    if (appended.length > 0) {
      const closure = new Set(
        (await this.mg(["rev-list", "--objects", "--no-object-names", ...h.prerequisites], { maxOutput: 512 * 1024 * 1024 })).split("\n").filter(Boolean),
      );
      const foreign = appended.filter((o) => !closure.has(o));
      if (foreign.length > 0) throw new IngestFail("prerequisite", `bundle deltas against ${foreign.length} object(s) outside its prerequisites' history`);
    }
    // Post-hoc inflated-size accounting (index-pack's --max-input-size bounds compressed input only); nothing has reached the mirror yet.
    const sizes = await g(["cat-file", "--batch-check=%(objectsize)"], { input: `${listed.join("\n")}\n`, maxOutput: 512 * 1024 * 1024 });
    let unpacked = 0;
    for (const l of sizes.stdout.toString("latin1").split("\n")) {
      unpacked += Number(l) || 0;
      if (unpacked > this.maxUnpackedBytes) throw new IngestFail("too_large", `bundle inflates beyond ${this.maxUnpackedBytes} bytes`);
    }
    const commits = (await gt(["rev-list", "--stdin"], { input: range })).split("\n").filter(Boolean);
    if (commits.length > this.maxCommits) throw new IngestFail("too_large", `bundle introduces ${commits.length} commits (cap ${this.maxCommits})`);
    const raw = await g(["diff-tree", "--stdin", "-r", "-z", "--raw", "--no-renames", "-m", "--root", "--no-commit-id", "--no-abbrev"], {
      input: `${commits.join("\n")}\n`,
    }).catch((err) => {
      throw err instanceof GitError && /exceeded/.test(err.message) ? new IngestFail("too_large", "bundle introduces too large a change set") : err;
    });
    const seen = new Set<string>(); // (path, oid): validity depends on the link's depth, so the same blob is checked per path
    const targets = new Map<string, string>();
    for (const e of parseRawZ(raw.stdout.toString("utf8"))) {
      const bad: PolicyViolation | null = checkEntry(e);
      if (bad) throw new IngestFail(bad.code, bad.message);
      if (modeKind(e.mode) === "symlink" && !seen.has(`${e.path}\0${e.oid}`)) {
        if (seen.size >= 100_000) throw new IngestFail("too_large", "bundle introduces too many symlinks");
        seen.add(`${e.path}\0${e.oid}`);
        let target = targets.get(e.oid);
        if (target === undefined) {
          target = (await g(["cat-file", "blob", e.oid], { maxOutput: 8192 })).stdout.toString("utf8");
          targets.set(e.oid, target);
        }
        const sym = checkSymlinkTarget(e.path, target);
        if (sym) throw new IngestFail(sym.code, sym.message);
      }
    }

    // 6. Success: only now does anything touch the mirror (packs, then one ref transaction).
    const written = tips.map((t) => ({ ref: agentHeadsPrefix(agent) + t.name.slice("refs/heads/".length), commit: t.oid }));
    const forcedFrom: ForcedRefUpdate[] = [];
    await this.lock("mirror", async () => {
      await this.ensureMirror();
      // Fast-forward only, checked in the quarantine (the mirror is its alternate, so the current tips resolve there)
      // before anything reaches the mirror; the update-ref below carries the old value, so a race cannot slip a rewind in.
      const olds = new Map<string, string>();
      for (const w of written) {
        const cur = await this.mg(["rev-parse", "--verify", "--quiet", w.ref]).catch(() => "");
        if (!cur) continue;
        olds.set(w.ref, cur);
        if ((await g(["merge-base", "--is-ancestor", cur, w.commit], { okCodes: [1] })).code === 0) continue;
        if (!force)
          throw new IngestFail(
            "non_fast_forward",
            `${w.ref} would move from ${cur} to ${w.commit}, which does not descend from it; pull and merge first (forcing is operator-only)`,
          );
        forcedFrom.push({ ref: w.ref, from: cur, to: w.commit });
      }
      const qpack = join(qg, "objects", "pack");
      const mpack = join(this.mirror, "objects", "pack");
      mkdirSync(mpack, { recursive: true });
      const names = readdirSync(qpack)
        .filter((n) => /^pack-[0-9a-f]+\.(pack|rev|idx)$/.test(n))
        .sort((a, b) => Number(a.endsWith(".idx")) - Number(b.endsWith(".idx"))); // idx last: a pack is visible only when complete
      for (const n of names) {
        if (existsSync(join(mpack, n))) continue;
        const tmp = join(mpack, `tmp_${randomBytes(4).toString("hex")}_${n}`);
        copyFileSync(join(qpack, n), tmp);
        renameSync(tmp, join(mpack, n));
      }
      const own = written.find((w) => w.ref === agentHeadsPrefix(agent) + `agent/${agent}`) ?? written[written.length - 1]!;
      // Write-ahead intent (C2b-13): a crash after update-ref but before the record below leaves this file, and
      // ingested() honours it once the ref has moved off the old value onto (or past) the new commit.
      const pending = this.pendingFile(agent);
      // An earlier crashed push whose refs did land is finalized first (record written, intent removed): this push's intent holds a new
      // old-value, which would make ingested() ignore the earlier one if this push then crashed before its own update-ref.
      const landed = await this.landedIntent(agent);
      if (landed) {
        this.writeAtomic(this.ingestedFile(agent), `${landed.ref} ${landed.commit}\n`);
        rmSync(pending, { force: true });
      }
      let earlier: string | null = null; // an earlier crashed push's intent that did NOT land, restored if this push moves nothing
      try {
        earlier = readFileSync(pending, "utf8");
      } catch {}
      this.writeAtomic(pending, `${own.ref} ${own.commit} ${olds.get(own.ref) ?? "0".repeat(40)}\n`);
      await this.observe?.({ phase: "ingest_intent_written", agent });
      try {
        await this.mg(["update-ref", "--stdin"], {
          input: `start\n${written.map((w) => `update ${w.ref} ${w.commit} ${olds.get(w.ref) ?? "0".repeat(40)}\n`).join("")}commit\n`,
        });
      } catch (err) {
        // nothing moved: the previous record stands, and so does an earlier crashed push's intent (ingest-intent-overwrite)
        if (earlier === null) rmSync(pending, { force: true });
        else this.writeAtomic(pending, earlier);
        throw err;
      }
      await this.observe?.({ phase: "ingest_refs_updated", agent });
      this.writeAtomic(this.ingestedFile(agent), `${own.ref} ${own.commit}\n`);
      rmSync(pending, { force: true });
    });
    return { refs: written, forcedFrom };
  }

  private classifyPackFailure(err: unknown): IngestFail {
    const text = err instanceof GitError ? err.stderr : String(err); // stderr only: the message echoes our own flags
    if (/hasDotgit|hasDotdot|hasDot\b|fullPathname|nulInPathname/i.test(text))
      return new IngestFail("unsafe_path", "bundle holds an unsafe path (.git or relative component)");
    if (/gitmodules/i.test(text)) return new IngestFail("submodule", "bundle holds a .gitmodules file");
    if (/symlink/i.test(text)) return new IngestFail("symlink", "bundle holds an unsafe symlink");
    if (/exceeds maximum allowed size|too large/i.test(text)) return new IngestFail("too_large", "pack exceeds the input size cap");
    return new IngestFail(
      "bad_bundle",
      `bundle failed verification: ${
        text
          .split("\n")
          .find((l) => l.trim())
          ?.trim()
          .slice(0, 200) ?? "unknown"
      }`,
    );
  }

  // An intent left by a crash between update-ref and the record (C2b-13) wins when the agent ref shows the update
  // landed: it moved off the old value and the new commit is in its history (an engine merge may have moved it on).
  private async landedIntent(agent: AgentId): Promise<{ ref: string; commit: string } | null> {
    let text = "";
    try {
      text = readFileSync(this.pendingFile(agent), "utf8").trim();
    } catch {}
    const p = /^(\S+) ([0-9a-f]{40}) ([0-9a-f]{40})$/.exec(text);
    if (!p || agentBranchOf(agent, p[1]!) === null) return null;
    const now = await this.mg(["rev-parse", "--verify", "--quiet", p[1]!]).catch(() => "");
    if (!HEX40.test(now) || now === p[3]) return null;
    if (now === p[2] || (await this.run(["--git-dir", this.mirror, "merge-base", "--is-ancestor", p[2]!, now], { okCodes: [1, 128] })).code === 0)
      return { ref: p[1]!, commit: now };
    return null;
  }

  async ingested(agent: AgentId): Promise<{ ref: string; commit: string } | null> {
    this.checkAgent(agent);
    const read = (file: string): string => {
      try {
        return readFileSync(file, "utf8").trim();
      } catch {
        return "";
      }
    };
    const tipOf = async (ref: string): Promise<string> => {
      const now = await this.mg(["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
      return HEX40.test(now) ? now : "";
    };
    const landed = await this.landedIntent(agent);
    if (landed) return landed;
    const m = /^(\S+) ([0-9a-f]{40})$/.exec(read(this.ingestedFile(agent)));
    if (!m || agentBranchOf(agent, m[1]!) === null) return null;
    const now = await tipOf(m[1]!);
    return now ? { ref: m[1]!, commit: now } : null; // the ref's CURRENT tip, whoever moved it (an engine merge included); null once pruned
  }

  // --- serve / resolve / publish / prune ----------------------------------------------------

  async serve(agent: AgentId, opts?: { scope?: AgentId }): Promise<AsyncIterable<Uint8Array>> {
    this.checkAgent(agent);
    const scope = opts?.scope ?? agent;
    this.checkAgent(scope);
    const q = mkdtempSync(join(this.tmp, "wss-"));
    const file = join(q, "out.bundle");
    inflightScratch.add(q);
    try {
      const def = await this.mg(["symbolic-ref", "-q", "HEAD"]);
      await this.mg(["bundle", "create", file, def, `--glob=${agentHeadsPrefix(scope)}*`]);
      const fh = await open(file, "r");
      unlinkSync(file); // the open handle keeps the bytes; nothing is left to clean if the caller never reads
      rmSync(q, { recursive: true, force: true });
      return (async function* () {
        try {
          for await (const chunk of fh.createReadStream()) yield chunk as Uint8Array;
        } finally {
          await fh.close().catch(() => undefined);
        }
      })();
    } catch (err) {
      rmSync(q, { recursive: true, force: true });
      throw err;
    } finally {
      inflightScratch.delete(q);
    }
  }

  async resolve(agent: AgentId, ref: string): Promise<{ commit: string; diffstat: string; subject: string; paths: string[] }> {
    this.checkAgent(agent);
    if (agentBranchOf(agent, ref) === null) throw new Error(`ref ${JSON.stringify(ref)} is not in ${agent}'s ingested namespace`);
    const commit = await this.mg(["rev-parse", "--verify", `${ref}^{commit}`]).catch(() => {
      throw new Error(`ref ${JSON.stringify(ref)} has not been ingested`);
    });
    const base = await this.mg(["merge-base", "HEAD", commit]).catch(() => "");
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const stat = await this.mg(["diff", "--stat", "--no-ext-diff", "--no-textconv", "--no-color", base || emptyTree, commit]);
    const subject = await this.mg(["log", "-1", "--format=%s", commit]);
    const names = await this.mg(["diff", "--name-only", "-z", "--no-renames", base || emptyTree, commit]);
    return {
      commit,
      diffstat: stat.slice(0, 4000),
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
      subject: subject.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200),
      paths: names
        .split("\0")
        .filter(Boolean)
        .map((p) => p.normalize("NFC"))
        .sort(),
    };
  }

  // The commits a push of `commit` would deliver are those not reachable from what the remote advertises. The pin reviewed
  // `commit ^<reviewed.exclude...>` (TODO(publish-pin)); so before pushing, the remote is asked for its refs (`ls-remote`) and the
  // push is refused when it would deliver any commit outside the reviewed range: a stale remote-tracking ref, or a remote branch
  // deleted or rewound since the review, would otherwise send unreviewed history. The push is one explicit
  // `<sha>:refs/heads/<target>` refspec with no `+`: never forced, no tags (push.followTags is overridden), no submodules, no
  // other ref; the porcelain report must show exactly that one ref, created, fast-forwarded or already up to date.
  async publish(agent: AgentId, push: { commit: string; remote: string; target: string; reviewed?: PublishReview }): Promise<void> {
    this.checkAgent(agent);
    if (!HEX40.test(push.commit)) throw new Error("publish needs a full commit id");
    if (!validBranchName(push.target)) throw new Error(`invalid publish target ${JSON.stringify(push.target)}`);
    if (push.reviewed && !push.reviewed.exclude.every((e) => HEX40.test(e))) throw new Error("publish review boundary must be full commit ids");
    const url = await this.remoteUrl(push.remote);
    const holders = await this.mg(["for-each-ref", "--contains", push.commit, "--format=%(refname)", agentHeadsPrefix(agent)]).catch(() => "");
    // Also the mirror's default branch: the top-level agent publishes the main the merge engine advanced.
    const onDefault = holders
      ? true
      : await this.mg(["symbolic-ref", "-q", "HEAD"]).then(
          async (def) => (await this.run(["--git-dir", this.mirror, "merge-base", "--is-ancestor", push.commit, def], { okCodes: [1, 128] })).code === 0,
          () => false,
        );
    if (!onDefault) throw new Error(`commit ${push.commit} is not reachable from ${agent}'s ingested refs or the default branch`);
    // The operator's remote may need their credentials, so these calls honour their global git config; the transport is
    // still pinned (GIT_ALLOW_PROTOCOL overrides any protocol.* config), so an operator url rewrite cannot reach ext:: or a local path.
    const remoteOpts: RunOptions = {
      trustOperatorConfig: true,
      passthrough: {
        ...Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"].map((k) => [k, process.env[k]])),
        GIT_ALLOW_PROTOCOL: this.localPublish ? "https:ssh:git:file" : "https:ssh:git",
      },
    };
    const redact = (err: unknown): Error => new Error(this.scrub((err instanceof Error ? err.message : String(err)).split(url).join("<remote>")));
    // A boundary the mirror does not hold excludes nothing from the pinned commit's history, so it is dropped (not a git error).
    const exclude = push.reviewed ? await this.heldCommits(push.reviewed.exclude) : await this.trackedTip(push.remote, push.target);
    const advertised = await this.text(["--git-dir", this.mirror, "ls-remote", "--", url], { ...remoteOpts, maxOutput: 64 * 1024 * 1024 }).catch((err) => {
      throw redact(err);
    });
    const remoteHas = await this.heldCommits(advertised.split("\n").map((l) => l.split("\t")[0]!));
    const sent = await this.countRange(push.commit, remoteHas);
    const reviewed = await this.countRange(push.commit, [...remoteHas, ...exclude]);
    if (sent !== reviewed)
      throw new PublishRefusedError(
        `the push would deliver ${sent - reviewed} commit(s) the publish review did not cover, because the remote no longer holds history the review assumed it had (a stale remote-tracking ref, or a branch deleted or rewound on the remote); fetch the remote and request the publish again`,
      );
    const ref = `refs/heads/${push.target}`;
    const out = (
      await this.run(
        ["--git-dir", this.mirror, "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--no-verify", "--", url, `${push.commit}:${ref}`],
        remoteOpts,
      ).catch((err) => {
        throw redact(err);
      })
    ).stdout.toString("utf8");
    const lines = out.split("\n").filter((l) => /^[ +\-*!=]\t/.test(l));
    if (lines.length !== 1 || !/^[ *=]$/.test(lines[0]![0]!) || lines[0]!.split("\t")[1] !== `${push.commit}:${ref}`)
      throw new PublishRefusedError(
        `the remote reported an unexpected ref update (${this.scrub(lines.join("; ").split(url).join("<remote>")) || "none"}); inspect the remote before publishing again`,
      );
  }

  // The review boundary pomtreed's pin uses today (publish-pin.ts remoteTip): the operator repo's remote-tracking ref for
  // `<remote>/<target>`, when the mirror holds it; none means the whole reachable history was reviewed.
  // TODO(publish-pin): pomtreed should pass `reviewed.exclude` from the pin itself so this default (a second copy of that rule) goes.
  private async trackedTip(remote: string, target: string): Promise<string[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) return [];
    const tip = await this.text(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${target}^{commit}`], { cwd: this.repo, okCodes: [1] }).catch(
      () => "",
    );
    return HEX40.test(tip) && (await this.heldCommits([tip])).length === 1 ? [tip] : [];
  }

  // The subset of `oids` the mirror holds as commits (what git push can use to trim the pack).
  private async heldCommits(oids: string[]): Promise<string[]> {
    const want = [...new Set(oids.filter((o) => HEX40.test(o)))];
    if (want.length === 0) return [];
    const types = (
      await this.mg(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${want.join("\n")}\n`, maxOutput: 64 * 1024 * 1024 })
    ).split("\n");
    return types.map((l) => l.split(" ")).flatMap(([o, t]) => (t === "commit" && o ? [o] : []));
  }

  private async countRange(tip: string, not: string[]): Promise<number> {
    return Number(await this.mg(["rev-list", "--count", "--stdin"], { input: `${tip}\n${not.map((n) => `^${n}\n`).join("")}` }));
  }

  // A remote NAME (e.g. "origin") is resolved against the trusted operator repo, since the mirror keeps no remotes. Either
  // way the URL must be https://, ssh:// or git:// with a host that cannot read as an option, or scp-like user@host:path.
  // Refused: ext:: and other transports, file:// and local paths (unless allowLocalPublishRemotes), a
  // leading "-", and credentials embedded in the URL (they would sit in argv and error text; use a credential helper).
  private async remoteUrl(remote: string): Promise<string> {
    let url = remote;
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
      url = await this.text(["remote", "get-url", "--", remote], { cwd: this.repo }).catch(() => "");
      if (!url) throw new Error(`unknown publish remote ${JSON.stringify(remote)}: add it to the operator repository (git remote add) or name a URL`);
    }
    const bad = (why: string) => new Error(`invalid publish remote: ${why}`);
    if (/[\0\n\r\s]/.test(url)) throw bad("whitespace or control characters in the URL");
    if (url.startsWith("/")) {
      if (this.localPublish) return url;
      throw bad("a local path; publish to an https://, ssh:// or user@host:path remote (allowLocalPublishRemotes permits local paths for tests)");
    }
    const m = /^(https|ssh|git):\/\/([^/?#]*)(\/.*)?$/i.exec(url);
    if (m) {
      const auth = m[2]!.lastIndexOf("@");
      if (auth >= 0 && m[2]!.slice(0, auth).includes(":")) throw bad("credentials embedded in the URL; configure a credential helper instead");
      if (!/^[A-Za-z0-9[]/.test(m[2]!.slice(auth + 1))) throw bad("the host must start with a letter, digit or '['");
      return url;
    }
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:\S+$/.test(url)) return url;
    throw bad("only https://, ssh://, git:// and user@host:path remotes are allowed (no ext::, file:// or relative paths)");
  }

  async prune(agent: AgentId, opts: { mergedInto: AgentId }): Promise<PruneResult> {
    this.checkAgent(agent);
    this.checkAgent(opts.mergedInto);
    if (agent === opts.mergedInto) return "refused";
    return this.lock("mirror", async () => {
      const list = async (prefix: string) =>
        (await this.mg(["for-each-ref", "--format=%(refname) %(objectname)", prefix]))
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(" ") as [string, string]);
      const mine = await list(agentHeadsPrefix(agent));
      const into = await list(agentHeadsPrefix(opts.mergedInto));
      if (mine.length === 0) return "nothing";
      if (into.length === 0) return "refused";
      for (const [, tip] of mine) {
        let merged = false;
        for (const [, dest] of into) {
          const r = await this.run(["--git-dir", this.mirror, "merge-base", "--is-ancestor", tip, dest], { okCodes: [1] });
          if (r.code === 0) {
            merged = true;
            break;
          }
        }
        if (!merged) return "refused";
      }
      // Fork-base anchors are controller-seeded entitlement tokens, not agent work: once every head is merged
      // they go with the rest of the namespace rather than leaking past it.
      const anchors = await list(agentBasePrefix(agent));
      await this.mg(["update-ref", "--stdin"], { input: `start\n${[...mine, ...anchors].map(([r, t]) => `delete ${r} ${t}\n`).join("")}commit\n` });
      rmSync(this.ingestedFile(agent), { force: true });
      rmSync(this.pendingFile(agent), { force: true });
      return "pruned";
    });
  }
}
