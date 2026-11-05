import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DENIED_PATHS, MAX_MERGE_ATTEMPTS, MAX_MERGE_ROUNDS, mergeSettled, sameMergeRequest } from "@pomtree/core";
import type {
  AgentId,
  CheckRunner,
  HostId,
  MergeId,
  MergePolicyCode,
  MergeRecord,
  MergeReport,
  MergeRequest,
  MergeResult,
  MergeStore,
  Repo,
  RepoStore,
} from "@pomtree/core";
import { checkGitVersion } from "./workspace.ts";
import { GitError, runGit, type RunOptions } from "./git-runner.ts";
import { agentHeadsPrefix, validAgentId } from "./ref-policy.ts";
import { candidateMessage, checkDiff, checkRequest, isOid, parseChangeSet, parseMergeTree, type Rejection } from "./merge-parse.ts";

export type MergeObserver = (e: { phase: "pinned" | "candidate" | "checked" | "done"; record: MergeRecord; commit?: string }) => void | Promise<void>;

export interface GitRepoStoreOptions {
  mirrorDir: string; // the controller's bare mirror (the same directory GitWorkspace owns); must already exist
  repo: Repo;
  host: HostId;
  merges: MergeStore;
  checks?: CheckRunner; // required when repo.policy.check is set; otherwise the merge is refused (fail closed)
  tmpRoot?: string;
  maxRounds?: number; // failed rounds before escalation (default MAX_MERGE_ROUNDS)
  maxAttempts?: number; // restarts for a moving target before `moved` (default MAX_MERGE_ATTEMPTS)
  now?: () => number; // epoch ms; fixes the candidate's date at begin
  // Called after each journaled phase. A throw simulates (or is) a crash at that point: the record stays open
  // and a retry with the same idempotency key resumes. This is the fault-injection and tracing seam.
  observe?: MergeObserver;
  // Applied to check-runner summaries before they reach the merges table, a result or a journal payload.
  redact?: (s: string) => string;
}

// Merges for one repo run one at a time within a process; across processes the ref compare-and-swap is the guard.
// merge-lock: this lock is in-process only; the cross-process guarantee is the compare-and-swap, exercised by two
// racing processes in repo-store.test.ts ("merge-lock: across two processes ...", child script merge-race-child.ts).
const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

class Settle {
  readonly result: MergeResult;
  constructor(result: MergeResult) {
    this.result = result;
  }
}

// The only writer of merge targets. Everything runs against the
// bare mirror with the hardened git builder: no hooks, no fsmonitor, no system or global config, no checkout, so
// hostile content in a child's tree is only ever read as git objects and never written to a working tree.
export class GitRepoStore implements RepoStore {
  private mirror: string;
  private tmp: string;
  private o: GitRepoStoreOptions;
  private maxRounds: number;
  private maxAttempts: number;
  private versionCheck: ReturnType<typeof checkGitVersion> | undefined;

  constructor(o: GitRepoStoreOptions) {
    this.o = o;
    this.mirror = realpathSync(o.mirrorDir);
    const tmpRoot = o.tmpRoot ?? tmpdir();
    mkdirSync(tmpRoot, { recursive: true });
    this.tmp = realpathSync(tmpRoot);
    this.maxRounds = o.maxRounds ?? MAX_MERGE_ROUNDS;
    this.maxAttempts = o.maxAttempts ?? MAX_MERGE_ATTEMPTS;
  }

  private scrub(text: string): string {
    return text.split(this.mirror).join("<mirror>");
  }

  private run(args: string[], opts: RunOptions = {}) {
    return runGit(["--git-dir", this.mirror, ...args], { tmpdir: this.tmp, ...opts }, (s) => this.scrub(s));
  }

  private async text(args: string[], opts: RunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.toString("utf8").trim();
  }

  // The commit a full ref or a full object id names, or null when it does not exist.
  private async commitOf(rev: string): Promise<string | null> {
    if (rev.startsWith("-") || rev === "") return null;
    const r = await this.run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { okCodes: [1] });
    const out = r.stdout.toString("utf8").trim();
    return r.code === 0 && isOid(out) ? out : null;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.run(["merge-base", "--is-ancestor", a, b], { okCodes: [1] })).code === 0;
  }

  async repo(): Promise<Repo> {
    return structuredClone(this.o.repo);
  }

  // --- merge ------------------------------------------------------------------------------------

  async merge(req: MergeRequest, idempotencyKey: string): Promise<MergeResult> {
    const rec = await this.o.merges.begin(
      { repo: this.o.repo.id, host: this.o.host, request: req, startedAt: Math.floor((this.o.now ?? Date.now)() / 1000) },
      idempotencyKey,
    );
    // A key reused with a different request never replays (or resumes) the old outcome.
    if (!sameMergeRequest(rec.request, req))
      return { status: "policy_rejected", code: "key_reuse", message: "this idempotency key was already used with a different merge request" };
    if (rec.result) return rec.result; // replay of a finished request
    return serialized(this.mirror, () => this.drive(rec.id, rec.idempotencyKey));
  }

  async recover(): Promise<MergeResult[]> {
    const out: MergeResult[] = [];
    for (const rec of await this.o.merges.list({ open: true })) out.push(await this.merge(rec.request, rec.idempotencyKey));
    return out;
  }

  private async drive(id: MergeId, key: string): Promise<MergeResult> {
    let rec = (await this.o.merges.get(id))!;
    if (rec.result) return rec.result;
    const settle = async (result: MergeResult): Promise<MergeResult> => {
      rec = await this.o.merges.settle(id, result, `${key}:settle`);
      await this.o.observe?.({ phase: "done", record: rec });
      return rec.result!;
    };
    const reject = (r: Rejection) => settle({ status: "policy_rejected", code: r.code, message: r.message });
    const req = rec.request;
    const bad = checkRequest(req, this.o.repo);
    if (bad) return reject(bad);
    this.versionCheck ??= checkGitVersion();
    const v = await this.versionCheck;
    if (v.warning) return reject({ code: "git_version", message: v.warning });
    if (!existsSync(join(this.mirror, "HEAD"))) return reject({ code: "no_target", message: "the repository mirror does not exist yet" });

    // `passes` bounds this call; `attempts` numbers the journal steps across calls (a crash resume continues the count).
    let passes = 0;
    for (;;) {
      if (++passes > this.maxAttempts) return settle({ status: "moved", attempts: rec.attempts, targetTip: (await this.commitOf(req.target)) ?? "" });
      const outcome = await this.attempt(rec, rec.attempts + 1, key);
      if (outcome instanceof Settle) return settle(outcome.result);
      rec = (await this.o.merges.get(id))!;
      // outcome === "retry": the target moved under the compare-and-swap; start over from the top with the new tip.
    }
  }

  // One merge attempt: pin target and source, already-merged check, policy on the source, merge-tree, policy on the
  // landing diff, candidate commit, optional check, then the compare-and-swap ref move. Returns a result to settle, or "retry" when the target moved.
  private async attempt(rec: MergeRecord, attempts: number, key: string): Promise<Settle | "retry"> {
    const req = rec.request;
    const rej = (code: MergePolicyCode, message: string) => new Settle({ status: "policy_rejected", code, message });
    const B = await this.commitOf(req.target);
    if (!B) return rej("no_target", `${req.target} does not exist in the mirror (push the caller's branch first)`);
    const T = await this.commitOf(req.source);
    if (!T) return rej("no_source", `${req.source} does not exist in the mirror (the child has not pushed)`);
    if (req.expectSource !== undefined && req.expectSource !== T) return rej("stale_source", `${req.source} moved from the pinned ${req.expectSource} to ${T}`);
    // Already contained (including a previous run of this very request that moved the ref before it could settle).
    // Checked before pinning: pinning clears the stored candidate, which a second replay still needs to recognise its own merge (C2b-14).
    if (await this.isAncestor(T, B)) {
      return new Settle({ status: "merged", commit: B, base: B, source: T, ...(rec.candidate === B ? {} : { alreadyMerged: true as const }) });
    }
    let cur = await this.o.merges.advance(rec.id, { phase: "pinned", attempts, base: B, source: T, candidate: null }, `${key}:a${attempts}:pinned`);
    await this.o.observe?.({ phase: "pinned", record: cur });
    const prior = await this.o.merges.findConflict({ repo: rec.repo, caller: rec.caller, child: rec.child, base: B, source: T });
    if (prior?.result) return new Settle(prior.result); // unchanged tips replay the same conflict without burning a round

    // 2. Policy over what the source introduces.
    const mb = await this.run(["merge-base", B, T], { okCodes: [1] });
    const base = mb.stdout.toString("utf8").trim();
    if (mb.code !== 0 || !isOid(base)) return rej("unrelated_history", "the branches share no history");
    let raw: string;
    try {
      raw = (await this.run(["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", base, T])).stdout.toString("utf8");
    } catch (err) {
      if (err instanceof GitError && /exceeded/.test(err.message)) return rej("too_large", "the source introduces too large a change set");
      throw err;
    }
    const denied = this.o.repo.policy.deniedPaths ?? DEFAULT_DENIED_PATHS;
    const violation = checkDiff(parseChangeSet(raw), denied);
    if (violation) return rej(violation.code, violation.message);

    // 3. Compute the merge with no checkout. Exit 1 is a conflict, but a bad revision also exits 1: both are full
    // commit ids that exist (verified above), so a result that does not start with a tree id is an error.
    const mt = await this.run(["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", B, T], { okCodes: [1] });
    const parsed = parseMergeTree(mt.stdout.toString("utf8"));
    if (!parsed || (mt.code === 0) !== (parsed.conflicts.length === 0)) throw new Error(`merge-tree gave an unexpected result (exit ${mt.code})`);
    // Rounds and status are keyed (repo, child): a child merges only into its parent's branch, or the top-level agent into
    // the default branch as its own "child", so one key never mixes targets. After an escalation the counter stays at
    // the cap, so the next failure of any kind escalates again at once (re-asks the user) until a clean merge resets it.
    // TODO(repos): the engine does not check that `child` really is the caller's child; that authorization is the daemon's.
    const status = await this.o.merges.status(rec.repo, rec.child);
    if (mt.code === 1) return this.failure(rec, status.failedRounds + 1, { kind: "conflict", paths: parsed.conflicts }, B, T);

    // The policy must judge what will actually land, not what the source diff looks like: merge-tree does rename
    // detection against B, so B renaming `a` to a denied path while T edits `a` changes the denied path in the merge.
    // Diff the target tip against the merged tree (adds, edits, deletions, mode and type changes).
    let landing: string;
    try {
      landing = (await this.run(["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", B, parsed.tree])).stdout.toString("utf8");
    } catch (err) {
      if (err instanceof GitError && /exceeded/.test(err.message)) return rej("too_large", "the merge changes too large a change set");
      throw err;
    }
    const landed = checkDiff(parseChangeSet(landing), denied);
    if (landed) return rej(landed.code, landed.message);

    // TODO(merge-gc): the trees and candidates written by merge-tree/commit-tree (conflicted, failed or superseded attempts) stay as loose objects in the mirror and are never collected.
    // 4. The candidate commit. Dates come from the record, so rewriting it after a crash yields the same id.
    const date = `${rec.startedAt} +0000`;
    const candidate = await this.text(["commit-tree", parsed.tree, "-p", B, "-p", T, "-F", "-"], {
      input: candidateMessage({ caller: rec.caller, child: rec.child, source: T, target: req.target }),
      passthrough: {
        GIT_AUTHOR_NAME: "pomtree",
        GIT_AUTHOR_EMAIL: "controller@pomtree",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "pomtree",
        GIT_COMMITTER_EMAIL: "controller@pomtree",
        GIT_COMMITTER_DATE: date,
      },
    });
    if (!isOid(candidate)) throw new Error("commit-tree returned no commit id");
    cur = await this.o.merges.advance(rec.id, { phase: "candidate", candidate }, `${key}:a${attempts}:candidate`);
    await this.o.observe?.({ phase: "candidate", record: cur, commit: candidate });

    // 5. The optional check runs on exactly this candidate; a failure leaves the target untouched.
    const check = this.o.repo.policy.check;
    if (check) {
      // TODO(merge-checks): no docker check runner exists yet (only the CheckRunner port and a fake); with policy.check set and no runner the merge fails closed here.
      if (!this.o.checks) return rej("check_unavailable", "the repository requires a check but no check runner is configured");
      const res = await this.o.checks.run({ repo: rec.repo, commit: candidate, command: check, idempotencyKey: `${key}:a${attempts}:check` });
      const summary = this.o.redact ? this.o.redact(res.summary) : res.summary;
      if (!res.ok) return this.failure(rec, status.failedRounds + 1, { kind: "check_failed", summary, candidate }, B, T);
      cur = await this.o.merges.advance(rec.id, { phase: "checked" }, `${key}:a${attempts}:checked`);
      await this.o.observe?.({ phase: "checked", record: cur, commit: candidate });
    }

    // 6. The commit point: move the target only if it is still B.
    const moved = await this.run(["update-ref", "-m", `pomtree merge ${rec.child}`, req.target, candidate, B], { okCodes: [1, 128] });
    if (moved.code !== 0) {
      if ((await this.commitOf(req.target)) !== B) return "retry";
      throw new GitError(this.scrub(`update-ref ${req.target} failed: ${moved.stderr.trim()}`), moved.code, "");
    }
    return new Settle({ status: "merged", commit: candidate, base: B, source: T });
  }

  private failure(
    rec: MergeRecord,
    round: number,
    f: { kind: "conflict"; paths: string[] } | { kind: "check_failed"; summary: string; candidate: string },
    B: string,
    T: string,
  ): Settle {
    if (round >= this.maxRounds) {
      return new Settle({
        status: "escalate",
        reason: f.kind,
        rounds: round,
        targetTip: B,
        sourceTip: T,
        ...(f.kind === "conflict" ? { paths: f.paths } : { summary: f.summary }),
      });
    }
    return new Settle(
      f.kind === "conflict"
        ? { status: "conflict", paths: f.paths, targetTip: B, sourceTip: T, round }
        : { status: "check_failed", summary: f.summary, candidate: f.candidate, targetTip: B, sourceTip: T, round },
    );
  }

  // --- status / scoped commits --------------------------------------------------------------------

  async mergeStatus(q: { child: AgentId; target: string }): Promise<MergeReport> {
    if (!validAgentId(q.child) || !q.target.startsWith("refs/") || q.target.includes("..")) throw new Error("invalid merge status query");
    const tips = (await this.text(["for-each-ref", "--format=%(objectname)", agentHeadsPrefix(q.child)])).split("\n").filter(Boolean);
    const st = await this.o.merges.status(this.o.repo.id, q.child);
    if (tips.length === 0) return { state: "empty", merged: false, failedRounds: st.failedRounds, settled: true };
    const targetTip = await this.commitOf(q.target);
    let merged = targetTip !== null;
    for (const t of tips) if (merged && !(await this.isAncestor(t, targetTip!))) merged = false;
    // A recorded `merged` that no longer holds (the child pushed more) reads as `none`; the rounds restart with it.
    const state = merged ? "merged" : st.state === "merged" ? "none" : st.state;
    const failedRounds = st.state === "merged" ? 0 : st.failedRounds;
    return { state, merged, failedRounds, settled: mergeSettled(state, merged) };
  }

  async commitInSubtree(commit: string, agents: AgentId[]): Promise<string | null> {
    const full = await this.commitOf(commit);
    if (!full) return null;
    for (const a of agents) {
      if (!validAgentId(a)) continue;
      const holders = await this.text(["for-each-ref", "--contains", full, "--count=1", "--format=%(refname)", agentHeadsPrefix(a)]).catch(() => "");
      if (holders) return full;
    }
    return null;
  }
}
