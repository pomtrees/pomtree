import { spawn } from "node:child_process";
import { COMMIT_MARK, describeFindings, scanDiff, scanMessages } from "./publish-scan.ts";

// Host-side publish pin (TODO(publish-pin)): pins the branch to a commit plus a one-line diffstat for the approval prompt
// and returns the paths the daemon checks against the denylist and credential heuristics. The path list covers every
// commit the push would deliver (a secret added then deleted still travels in history), and any git failure throws (fail
// closed; it never degrades to an empty, passing path list). Only a policy refusal is a PublishPinError (the daemon's 403).
// The same commit range also gets a content scan (publish-scan.ts): the ADDED lines of every commit (merge commits against
// each parent), its message and its author/committer lines are checked for high-confidence credential patterns, and added
// content in workflow/CI files is refused (a symlink there included: its target is an added line). Empty CI adds,
// mode-only changes and deletions add no content and are left to the path denylist. A
// finding throws a PublishPinError naming the commit, file and line, never the matched text. `contentScan: false` skips it.
// The pin also returns `exclude`, the exact boundary it checked (the remote tip as a full commit id, or empty when the whole
// reachable history was checked); the push must deliver nothing outside `sha ^exclude`.
// Bounds: every git call runs in its own process group, and a timeout, abort or output overflow SIGKILLs the whole group (git's
// own children, such as pack-objects, hooks and remote helpers, die with it). Each call is bounded (`gitTimeoutMs`, output
// limit), and the whole resolution is bounded too: `resolveTimeoutMs` of wall clock and `resolveMaxBytes` of stdout summed over
// all its calls (stderr is capped per call but not charged to this budget; it is never returned), so N calls cannot run N times the per-call bound. Both are code options (main.ts uses the defaults; there is no config key). A blown deadline is a plain error (409); a blown stdout budget
// is a refusal (PublishPinError, 403). TODO(publish-pin): git still runs with the daemon's inherited environment (current
// behavior; a scrubbed environment is not yet built).

export class PublishPinError extends Error {
  constructor(message: string) {
    super(`publish pin failed closed: ${message}`);
    this.name = "PublishPinError";
  }
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface PublishPin {
  sha: string;
  summary: string;
  paths: string[];
  // The review boundary the pin actually checked: the remote tip as a full commit id when known, else empty (the whole reachable
  // history was checked). Handed to the push, which may deliver only commits reachable from `sha` and not from these.
  exclude: string[];
}

export interface GitRunOptions {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

// Runs git with the given argv (the caller includes `--git-dir` or `-C`) and resolves its stdout. Every failure is a
// GitRunError whose code names the cause; the message never carries stderr or any output.
export type GitRunner = (args: string[], opts: GitRunOptions) => Promise<string>;

export interface PublishResolverOptions {
  mirrorDir: string;
  repoDir: string;
  defaultBranch: string;
  // The content-level secret/CI scan of every commit in the pushed range; on unless explicitly false (fail closed by default).
  contentScan?: boolean;
  // Largest git output the content scan will buffer (default 128 MiB); a range over it is refused, never skipped.
  scanMaxBytes?: number;
  // Wall-clock bound per git call (default 120 s; capped at 180 s). A call over it fails closed as a plain error (409).
  gitTimeoutMs?: number;
  // Wall-clock bound on one whole resolution, all git calls together (default 300 s). Over it fails closed as a plain error (409).
  resolveTimeoutMs?: number;
  // Git stdout bytes one whole resolution may buffer, summed over all its calls (default 512 MiB); stderr is not charged. Over it is a refusal (403).
  resolveMaxBytes?: number;
  // The git runner; the default is execGit. Injected by tests so they run without a repository or a child process.
  runGit?: GitRunner;
  // Pins an agent's ingested branch (GitWorkspace.resolve): net diff against merge-base(HEAD, commit).
  resolveAgentBranch: (agent: string, branch: string) => Promise<{ commit: string; diffstat: string; subject: string; paths: string[] }>;
}

export class GitRunError extends Error {
  // EGIT: non-zero exit; ETIMEOUT: killed at the bound; EABORT: the caller aborted; EOVERFLOW: stdout over maxBytes.
  readonly code: "EGIT" | "ETIMEOUT" | "EABORT" | "EOVERFLOW";
  constructor(code: GitRunError["code"], message: string) {
    super(message);
    this.name = "GitRunError";
    this.code = code;
  }
}

const GIT_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_CAP_MS = 180_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const SCAN_MAX_BYTES = 128 * 1024 * 1024;
const RESOLVE_TIMEOUT_MS = 300_000;
const RESOLVE_MAX_BYTES = 512 * 1024 * 1024;
const FULL_ID = /^[0-9a-f]{40}$/;

// The default GitRunner: the one async, bounded spawn. stdin is closed at once (no call reads it). The child leads its own
// process group, and a timeout, abort or output overflow SIGKILLs the whole group, so git's own children (pack-objects,
// hooks, remote helpers) cannot outlive the call; SIGKILL cannot be ignored. stdout and stderr are each capped at maxBytes.
// The call settles only on the child's close, so the child is reaped before the promise settles; the first cause wins.
export const execGit: GitRunner = (args, opts) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let cause: "ETIMEOUT" | "EABORT" | "EOVERFLOW" | undefined;
    const out: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); // no group to signal: at least the child
      }
    };
    const stop = (why: NonNullable<typeof cause>) => {
      cause ??= why;
      killGroup();
    };
    const onAbort = () => stop("EABORT");
    const timer = setTimeout(() => stop("ETIMEOUT"), opts.timeoutMs);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout.on("data", (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > opts.maxBytes) return stop("EOVERFLOW");
      out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      errBytes += b.length;
      if (errBytes > opts.maxBytes) stop("EOVERFLOW");
    });
    child.on("error", () => {
      // a spawn failure (no git binary): there is no child to wait for
      if (child.pid === undefined) settle(() => reject(new GitRunError("EGIT", "git call failed (exit unknown)")));
    });
    child.on("close", (code) =>
      settle(() => {
        if (cause === "EABORT") return reject(new GitRunError("EABORT", "git call aborted"));
        if (cause === "EOVERFLOW") return reject(new GitRunError("EOVERFLOW", `git output exceeded ${opts.maxBytes} bytes`));
        if (cause === "ETIMEOUT") return reject(new GitRunError("ETIMEOUT", `git call timed out after ${opts.timeoutMs} ms`));
        if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
        reject(new GitRunError("EGIT", `git call failed (exit ${typeof code === "number" ? code : "unknown"})`));
      }),
    );
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });

// Everything one resolution needs: the injected runner, the bounds and the signal, bound once per call. `signal` is the
// caller's signal joined with the resolution deadline; `bytesLeft` is the stdout budget the remaining calls share.
interface Ctx {
  run: GitRunner;
  mirror: string;
  repo: string;
  timeoutMs: number;
  signal: AbortSignal;
  deadline: AbortSignal;
  deadlineMs: number;
  maxBytes: number;
  bytesLeft: number;
}

// Every git call goes through here, so the whole-resolution bounds hold for all of them. The call's output cap is the smaller of
// its own and what the budget has left; its stdout is charged to the budget once it returns.
async function call(c: Ctx, args: string[], maxBytes = MAX_BUFFER): Promise<string> {
  const budgeted = Math.min(maxBytes, c.bytesLeft);
  const overDeadline = () =>
    new GitRunError(
      "ETIMEOUT",
      `publish resolution exceeded its ${c.deadlineMs} ms deadline; retry the publish, or publish a smaller range (fewer commits not yet on the remote)`,
    );
  if (c.deadline.aborted) throw overDeadline();
  let out: string;
  try {
    out = await c.run(args, { maxBytes: budgeted, timeoutMs: c.timeoutMs, signal: c.signal });
  } catch (e) {
    if (e instanceof GitRunError && e.code === "EABORT" && c.deadline.aborted) throw overDeadline();
    if (e instanceof GitRunError && e.code === "EOVERFLOW" && budgeted < maxBytes)
      throw new PublishPinError(
        `git output of this resolution exceeds its ${c.maxBytes}-byte budget; publish a smaller range (fetch the remote first, or push fewer commits at a time)`,
      );
    throw e;
  }
  c.bytesLeft -= Buffer.byteLength(out);
  return out;
}

// A git read against the mirror (`--git-dir`), buffered up to maxBytes.
const git = (c: Ctx, args: string[], maxBytes = MAX_BUFFER): Promise<string> => call(c, ["--git-dir", c.mirror, ...args], maxBytes);

// One read for the content scan. Output too large to buffer fails closed as a refusal (403), never skipped.
async function scanRead(c: Ctx, args: string[], maxBytes: number): Promise<string> {
  try {
    return await git(c, args, maxBytes);
  } catch (e) {
    if (e instanceof GitRunError && e.code === "EOVERFLOW")
      throw new PublishPinError(`content scan: the pushed range's git output exceeds ${maxBytes} bytes and cannot be scanned`);
    throw e;
  }
}

// Content scan of every commit in `sha ^exclude` (the same walk as rangePaths; `-m` diffs a merge against each parent).
// `--text` diffs files git would call binary, `-U0` keeps the stream to the added/removed lines, and the explicit
// prefixes and no external diff/textconv make the stream independent of the repo's config. Signature display is off and
// the root commit is always shown, so the stream does not depend on the operator's log config. Commit messages and
// author/committer lines are read in a second, NUL-delimited pass over the same range.
async function assertNoSecrets(c: Ctx, sha: string, exclude: string | undefined, maxBytes: number): Promise<void> {
  const range = exclude ? [sha, `^${exclude}`] : [sha];
  const pinned = ["-c", "log.showSignature=false", "-c", "log.showRoot=true", "log", "--no-show-signature"];
  const diff = await scanRead(
    c,
    [
      "-c",
      "core.quotePath=false",
      ...pinned,
      "-p",
      "-m",
      "--text",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-U0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `--format=${COMMIT_MARK}%H`,
      ...range,
    ],
    maxBytes,
  );
  const messages = await scanRead(c, [...pinned, "-z", "--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B", ...range], maxBytes);
  const findings = [...scanDiff(diff), ...scanMessages(messages)];
  if (findings.length > 0) throw new PublishPinError(`content scan refused: ${describeFindings(findings)} (matched text withheld)`);
}

const nul = (out: string): string[] =>
  out
    .split("\0")
    .filter(Boolean)
    .map((p) => p.normalize("NFC"));

// The remote's last known tip for `target` ("remote/branch"), from the operator repo's remote-tracking ref, when that
// commit also exists in the mirror. A missing ref (or a tip the mirror lacks) means no tip: the range widens to the whole
// history, which is the safe direction. A timeout, abort or overflow is not a missing ref and is not swallowed.
async function remoteTip(c: Ctx, target: string): Promise<string | undefined> {
  const slash = target.indexOf("/");
  if (slash <= 0) return undefined;
  let tip: string;
  try {
    tip = (await call(c, ["-C", c.repo, "rev-parse", "--verify", `refs/remotes/${target}^{commit}`])).trim();
  } catch (e) {
    if (e instanceof GitRunError && e.code !== "EGIT") throw e;
    return undefined;
  }
  try {
    await git(c, ["cat-file", "-e", `${tip}^{commit}`]);
  } catch (e) {
    if (e instanceof GitRunError && e.code !== "EGIT") throw e;
    return undefined;
  }
  return tip;
}

// Every path touched by any commit in `sha ^exclude` (merge commits diffed against each parent), plus the commit count.
async function rangePaths(c: Ctx, sha: string, exclude: string | undefined): Promise<{ paths: string[]; commits: number }> {
  const range = exclude ? [sha, `^${exclude}`] : [sha];
  const touched = nul(await git(c, ["log", "-z", "-m", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "--format=", ...range]));
  const commits = Number((await git(c, ["rev-list", "--count", ...range])).trim());
  return { paths: touched, commits };
}

// The review boundary as the push consumes it: the checked remote tip (a full commit id) or nothing.
function exclusion(tip: string | undefined): string[] {
  if (tip === undefined) return [];
  if (!FULL_ID.test(tip)) throw new PublishPinError("the remote tip is not a full commit id; fetch the remote and request the publish again");
  return [tip];
}

export function createPublishResolver(o: PublishResolverOptions): (agent: string, branch: string, target: string, signal?: AbortSignal) => Promise<PublishPin> {
  // A configured bound must be a positive integer of milliseconds: Node treats 0 (and NaN, Infinity, fractions) as no
  // timeout or an invalid one, so an unbounded git call would be accepted silently. Rejected here, before any spawn.
  if (o.gitTimeoutMs !== undefined && !(Number.isSafeInteger(o.gitTimeoutMs) && o.gitTimeoutMs > 0))
    throw new Error(`publish resolver gitTimeoutMs must be a positive safe integer of milliseconds, got ${String(o.gitTimeoutMs)}`);
  const timeoutMs = Math.min(o.gitTimeoutMs ?? GIT_TIMEOUT_MS, GIT_TIMEOUT_CAP_MS);
  for (const [name, v] of [
    ["resolveTimeoutMs", o.resolveTimeoutMs],
    ["resolveMaxBytes", o.resolveMaxBytes],
  ] as const)
    if (v !== undefined && !(Number.isSafeInteger(v) && v > 0)) throw new Error(`publish resolver ${name} must be a positive safe integer, got ${String(v)}`);
  const deadlineMs = o.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
  const maxBytes = o.resolveMaxBytes ?? RESOLVE_MAX_BYTES;
  return async (agent, branch, target, signal) => {
    const deadline = AbortSignal.timeout(deadlineMs);
    const c: Ctx = {
      run: o.runGit ?? execGit,
      mirror: o.mirrorDir,
      repo: o.repoDir,
      timeoutMs,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      deadline,
      deadlineMs,
      maxBytes,
      bytesLeft: maxBytes,
    };
    // Only a policy refusal (a PublishPinError: a finding, the scan size cap) is a 403 at the daemon. Plain git/IO failures
    // (a missing default branch, a failed scan read, a timeout, an abort) propagate unchanged: the daemon maps them to 409,
    // and they still fail closed, since a throw never yields a publishable pin.
    // An unresolvable ref ("has not been ingested") is the caller's 409 and passes through untouched.
    const agentPin = branch === o.defaultBranch ? undefined : await o.resolveAgentBranch(agent, branch);
    const tip = await remoteTip(c, target);
    if (agentPin === undefined) {
      // the top-level agent publishing the default branch the merge engine advanced (the daemon checked who)
      const sha = (await git(c, ["rev-parse", "--verify", `refs/heads/${o.defaultBranch}^{commit}`])).trim();
      // With a known remote tip, the range is tip..sha and the diffstat is the net change from the common ancestor;
      // without one, every commit reachable from sha would be pushed, so all of it is checked.
      let base = EMPTY_TREE;
      if (tip) base = (await git(c, ["merge-base", tip, sha])).trim() || EMPTY_TREE;
      else
        try {
          base = (await git(c, ["rev-parse", "--verify", `${sha}^`])).trim() || EMPTY_TREE;
        } catch (e) {
          // root commit: no parent; diff against the empty tree. Any other failure is not a root commit and propagates.
          if (!(e instanceof GitRunError && e.code === "EGIT")) throw e;
        }
      const stat = (await git(c, ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--no-color", base, sha])).trim();
      const net = nul(await git(c, ["diff", "--name-only", "-z", "--no-renames", base, sha]));
      const range = await rangePaths(c, sha, tip);
      if (o.contentScan !== false) await assertNoSecrets(c, sha, tip, o.scanMaxBytes ?? SCAN_MAX_BYTES);
      const summary = range.commits > 1 ? `${range.commits} commits: ${stat || "no changes"}` : stat || "no changes";
      return { sha, summary, paths: [...new Set([...net, ...range.paths])].sort(), exclude: exclusion(tip) };
    }
    const r = agentPin;
    // resolve() diffs merge-base(HEAD, commit)..commit (net paths only); widen to every commit not on the remote
    // (or, with no known tip, the whole reachable history, as the default branch does) so an add-then-delete cannot hide a secret.
    const exclude = tip;
    const range = await rangePaths(c, r.commit, exclude);
    if (o.contentScan !== false) await assertNoSecrets(c, r.commit, exclude, o.scanMaxBytes ?? SCAN_MAX_BYTES);
    return {
      sha: r.commit,
      summary: r.diffstat || r.subject || "no changes vs target",
      paths: [...new Set([...r.paths, ...range.paths])].sort(),
      exclude: exclusion(exclude),
    };
  };
}
