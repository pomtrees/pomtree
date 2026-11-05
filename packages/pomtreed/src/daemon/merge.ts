// Publish, merge, pull and fork-source resolution of the Daemon. Calls up go
// through `ctx.hub`: approvals (`escalation.requireApproval`), the escalate-on-failed-merge ask (`escalation.ask`), the
// keyed op markers, and the checkpoint write and per-folder lock the merge-resume path shares with lifecycle. It owns no state.

import type { AgentId, AgentRecord, JournalEntry, MergeReport, MergeResult, WorkspaceId } from "@pomtree/core";
import { DEFAULT_DENIED_PATHS, MAX_MERGE_ROUNDS, StaleGenerationError, mergeJournalPayload, mergeResumeKey, pathDenied } from "@pomtree/core";
import { basename } from "node:path";
import type { SpawnRequest } from "../daemon-types.ts";
import { FORK_KIND, PUBLISHED_KIND, clipText, credentialPath, journalFailed, transitionKey } from "../daemon-util.ts";
import { LifecycleError, isDone } from "../lifecycle.ts";
import { PublishPinError } from "../publish-pin.ts";
import { lastMergeFailure, mergeTarget, resumeWake, scrubResult } from "../merge-route.ts";
import type { MergeOutcome as MergeAnswer } from "../merge-route.ts";
import type { DaemonCtx } from "./ctx.ts";
import type { Tree } from "./tree.ts";

// The reap refusal for an unsettled merge, in plain words: the cause and what to run. `state` is the merge record's state, where
// `none` means no merge was attempted yet (the child pushed, nobody merged it). There is no reap override for unmerged work
// (TODO(merge-discard)), so every action is a merge. `escalated` and `empty` are settled and never refused; they are named for
// exhaustiveness only.
export function unmergedRefusal(id: AgentId, state: MergeReport["state"], failedRounds: number): string {
  const merge = `run \`pomtree merge ${id}\``;
  const round = `round ${failedRounds} of ${MAX_MERGE_ROUNDS}`;
  switch (state) {
    case "none":
      return `cannot reap ${id}: it pushed work that was never merged; ${merge}, then reap it`;
    case "merged":
      return `cannot reap ${id}: some of its pushed work is not merged into your branch (it pushed after its last merge, or that merge went to another branch); ${merge} again, then reap it`;
    case "conflict":
      return `cannot reap ${id}: its last merge conflicted (${round}); resolve the conflict in your clone or resume the child (\`pomtree resume ${id}\`), ${merge} again, then reap it`;
    case "check_failed":
      return `cannot reap ${id}: its last merge failed the merge check (${round}); fix the cause, ${merge} again, then reap it`;
    case "escalated":
    case "empty":
      return `cannot reap ${id}: its merge is not settled; ${merge}, then reap it`;
  }
}

export class Merge {
  private readonly ctx: DaemonCtx;
  private readonly tree: Tree;
  private readonly redactText: (text: string) => string;

  constructor(ctx: DaemonCtx, tree: Tree, redactText: (text: string) => string) {
    this.ctx = ctx;
    this.tree = tree;
    this.redactText = redactText;
  }

  // `pomtree publish`: push an agent's branch to an allowed remote target, host-side (TODO(publish)). The agent never
  // holds credentials. The branch must be the agent's own, the target must be allow-listed, and (by default) an
  // approval gates it. Idempotent by key: a replay returns the journaled result without pushing again.
  // TODO(repos): publishes only the agent's own branch of the single POMTREED_REPO_DIR repo; multiple repos and clone-by-URL are not supported.
  async publish(agent: AgentId, req: { branch: string; target: string; idempotencyKey: string }): Promise<{ branch: string; target: string }> {
    const d = this.ctx.deps;
    const pub = d.publisher;
    if (!pub) throw new LifecycleError(503, "publish is not configured");
    const a = await d.registry.get(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    // The top-level agent may also publish the default branch the merge engine advanced (the pin is a commit reachable from it).
    const defaultBranch = d.repos ? (await d.repos.repo()).defaultBranch : null;
    const isDefault = defaultBranch !== null && req.branch === defaultBranch;
    if (isDefault ? !(await this.tree.isTopLevel(a)) : req.branch !== `agent/${agent}`)
      throw new LifecycleError(403, `agents may publish only their own branch (agent/${agent})`);
    if (!pub.allowedTargets.includes(req.target)) throw new LifecycleError(403, `target ${req.target} is not allowed`);
    const key = `${agent}:publish:${req.idempotencyKey}`;
    for (let from = 1; ; ) {
      const page = await d.journal.read({ from, agent, limit: 500 });
      for (const e of page)
        if (e.payload.kind === PUBLISHED_KIND && (e.payload as { key?: string }).key === key) return { branch: req.branch, target: req.target };
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    // Pin the tip: the approver sees (and the approval id binds) the exact sha + diffstat, and the push publishes that
    // sha, so a commit landing after approval cannot ride along.
    if (typeof pub.resolve !== "function") throw new LifecycleError(503, "publish is not configured with a pinning resolver; refusing an unpinned push");
    let pin: { sha: string; summary: string; paths: string[] };
    try {
      pin = await pub.resolve(agent, req.branch, req.target);
    } catch (e) {
      // A refused pin (the content scan, PublishPinError) is a policy refusal; its text never carries matched secret text.
      if (e instanceof PublishPinError) throw new LifecycleError(403, `publish refused: ${e.message}`);
      throw new LifecycleError(
        409,
        `nothing to publish: ${req.branch} has no ingested commit (run \`pomtree push\` first): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (typeof pin?.sha !== "string" || pin.sha === "") throw new LifecycleError(409, "publish refused: the branch tip was not pinned to a commit");
    // Fail closed (runtime guard for untyped callers; `paths` is required by the type): a pin without `paths` cannot be checked against the denylist or the credential flag.
    if (!Array.isArray(pin.paths)) throw new LifecycleError(409, "publish refused: the pin carries no changed-path list to check against the denylist");
    const paths = pin.paths;
    // Fail closed: a change under a denied path prefix is refused before it can reach the approver.
    const deniedPaths = pub.deniedPaths ?? DEFAULT_DENIED_PATHS;
    for (const p of paths) {
      const hit = pathDenied(p, deniedPaths);
      if (hit !== null) throw new LifecycleError(403, `publish refused: change touches denied path ${p} (denied prefix ${hit})`);
    }
    // Flag-only: a credential-like file is surfaced to the approver (and hashed into the approval id), never silently pushed.
    let shown = `${req.branch}@${pin.sha.slice(0, 12)}->${req.target} (${clipText(pin.summary, 200)})`;
    for (const p of paths) {
      const name = basename(p);
      if (credentialPath(name)) shown += ` [WARN: credential file ${name}]`;
    }
    if (pub.requireApproval !== false) await this.ctx.hub.escalation.requireApproval(a, "publish", shown, req.idempotencyKey);
    await pub.push(agent, req.branch, req.target, pin.sha);
    await this.ctx.record(a, { kind: PUBLISHED_KIND, key, branch: req.branch, target: req.target }, `${key}:published`);
    return { branch: req.branch, target: req.target };
  }

  // `pomtree merge CHILD`: the controller merges the child's newest pushed branch into the caller's branch (or, for the top-level
  // agent with `into` = the default branch, into main under an approval the user grants). Generation-fenced, descendants only,
  // idempotent by `key` (a retry replays the engine's recorded result). Failed rounds are journaled; a third escalates to the user.
  async merge(agent: AgentId, generation: number, key: string, req: { child?: AgentId; into?: string }): Promise<MergeAnswer> {
    const d = this.ctx.deps;
    const repos = d.repos;
    if (!repos) throw new LifecycleError(503, "merging is not configured");
    const a = await d.registry.get(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (a.generation !== generation) throw new StaleGenerationError(agent, generation, a.generation);
    if (a.state !== "running") throw new LifecycleError(409, `agent is ${a.state}, not running`);
    const repo = await repos.repo();
    // Self-merge: the top-level agent's own branch into the default branch (child omitted or equal to the caller).
    const child = req.child ?? agent;
    const self = child === agent;
    if (self) {
      if (req.into === undefined || req.into.replace(/^refs\/heads\//, "") !== repo.defaultBranch)
        throw new LifecycleError(400, `merging yourself needs into: ${repo.defaultBranch}`);
      if (!(await this.tree.isTopLevel(a))) throw new LifecycleError(403, `only the top-level agent may merge itself into ${repo.defaultBranch}`);
    } else {
      if (!(await d.registry.get(child))) throw new LifecycleError(404, `no such agent: ${child}`);
      if (!(await this.tree.isDescendant(agent, child))) throw new LifecycleError(403, `${agent} may merge only its descendants`);
    }
    const src = await d.workspace.ingested(child);
    if (!src)
      throw new LifecycleError(409, self ? "you have not pushed any branch; run `pomtree push` first" : `${child} has not pushed any branch; nothing to merge`);
    const t = mergeTarget({
      agent,
      topLevel: await this.tree.isTopLevel(a),
      defaultBranch: repo.defaultBranch,
      ...(req.into !== undefined && { into: req.into }),
      own: self ? null : ((await d.workspace.ingested(agent))?.ref ?? null),
    });
    if (!t.ok) throw new LifecycleError(t.status, t.error);
    // Only the top-level agent's OWN branch goes into the default branch; a child merges into its caller's own branch.
    if (!self && t.protectedTarget)
      throw new LifecycleError(
        403,
        `a child merges only into your own branch; only your own branch (pomtree merge --into ${repo.defaultBranch}, no child) goes into ${repo.defaultBranch}`,
        { code: "protected_target" },
      );
    let approval: string | undefined;
    if (t.protectedTarget) {
      // Same mechanism as publish: the user grants it; the engine only checks the id. A pending approval answers approval_required.
      // The approval id hashes (requester, "merge", child@FULL source tip->target ref, key): a changed source tip or target needs a new approval.
      // TODO(merge-approval-tip): the target ref's tip is not bound, so the approval holds if the target moves before the merge; the CAS still guards the write.
      try {
        approval = (await this.ctx.hub.escalation.requireApproval(a, "merge", `${child}@${src.commit}->${t.target}`, key)).id;
      } catch (e) {
        const pending = e instanceof LifecycleError && e.status === 409 && typeof e.extra?.approval === "string" ? e.extra.approval : null;
        if (pending === null) throw e;
        return {
          result: { status: "policy_rejected", code: "approval_required", message: `approval pending: ${pending}` },
          target: t.target,
          approval: pending,
        };
      }
    }
    const result = scrubResult(
      await repos.merge(
        {
          repo: repo.id,
          host: d.hostId,
          caller: agent,
          callerGeneration: generation,
          child,
          source: src.ref,
          target: t.target,
          ...(approval !== undefined && { expectSource: src.commit, approval }),
        },
        `merge:${agent}:${key}`,
      ),
      (x) => this.redactText(x),
    );
    const jp = mergeJournalPayload(child, t.target, result);
    if (jp) await this.ctx.record(a, jp, `${agent}:merge:${key}:${result.status}`);
    if (result.status === "escalate") {
      const what = result.reason === "conflict" ? `conflicts in ${(result.paths ?? []).slice(0, 10).join(", ")}` : `a failing check: ${result.summary ?? ""}`;
      await this.ctx.hub.escalation.ask(agent, {
        question: `Merging ${child} failed ${result.rounds} rounds (${what}). How should ${agent} proceed?`,
        generation,
        idempotencyKey: `merge-escalate:${key}`,
      });
    }
    return { result, target: t.target, ...(approval !== undefined && { approval }) };
  }

  // Boot: re-run merges a crash left open (the engine resumes each from its journaled phase) before the API serves.
  // TODO(merge-journal): a recovered merge is settled in the merge store but not journaled on the caller until the caller retries its key.
  async recoverMerges(): Promise<MergeResult[]> {
    return this.ctx.deps.repos ? this.ctx.deps.repos.recover() : [];
  }

  // An ancestor wakes its EXITED, UNREAPED child to fix a merge conflict or failed check (the one exited->running edge).
  // The generation is bumped first and the transition runs at the new one; the key is (child, generation, round), so a
  // retry converges. The controller supplies the paths and the parent's tip as the wake message.
  async resumeChild(agent: AgentId, generation: number, child: AgentId): Promise<AgentRecord> {
    const d = this.ctx.deps;
    const a = await d.registry.get(agent);
    if (!a) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (a.generation !== generation) throw new StaleGenerationError(agent, generation, a.generation);
    if (a.state !== "running") throw new LifecycleError(409, `agent is ${a.state}, not running`);
    const c = await d.registry.get(child);
    if (!c) throw new LifecycleError(404, `no such agent: ${child}`);
    if (!(await this.tree.isDescendant(agent, child))) throw new LifecycleError(403, `${agent} may resume only its descendants`);
    const entries: JournalEntry[] = [];
    for (let from = 1; ; ) {
      const page = await d.journal.read({ from, agent, limit: 500 });
      entries.push(...page);
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    const failure = lastMergeFailure(entries, child);
    // The key names the generation the child EXITED at, not its current one: a crash between the bump and the transition leaves the
    // child exited at a higher generation, and a retry must reuse the same key (the registry replays the bump) instead of bumping again.
    let exitedAt: number | null = null;
    for (let from = 1; ; ) {
      const page = await d.journal.read({ from, agent: child, limit: 500 });
      for (const e of page) if (e.payload.kind === "exited") exitedAt = Math.max(exitedAt ?? 0, e.generation);
      const last = page.at(-1);
      if (!last || page.length < 500) break;
      from = last.seq + 1;
    }
    exitedAt ??= c.generation; // no journaled exit (only a test that moved the registry directly)
    const rkey = mergeResumeKey(child, exitedAt, failure?.round ?? 0);
    if (await this.ctx.hub.ops.seen(child, "resume", rkey)) return (await this.ctx.deps.registry.get(child)) ?? c;
    if (c.state === "reaped") throw new LifecycleError(409, `${child} is already reaped; it cannot be resumed`);
    if (c.state !== "exited") throw new LifecycleError(409, `${child} is ${c.state}, not exited`);
    // A child with no budget left is refused up front rather than started with zero. TODO(merge-budget): there is no parent top-up yet,
    // so such a child cannot be resumed; the parent resolves the conflict itself (or the user raises the budget).
    // `gateway.spend` reads the proxy debit store (the single spend authority), so this reflects provider-reported cost.
    if (c.budgetMicros - (await d.gateway.spend(child)).spentMicros <= 0)
      throw new LifecycleError(409, `${child} has no budget left to resume`, { code: "budget_exhausted" });
    // An exited agent has no checkpoint of its own: write one from the stopped container's session and folder. A folder the
    // cleanup sweep evicted is restored first at the child's last ingested ref (the default branch if it never pushed); un-pushed work is gone.
    let restored: WorkspaceId | undefined;
    if (!(await d.workspace.has(child))) {
      const last = await d.workspace.ingested(child);
      restored = (await d.workspace.create(child, last ? { fromCommit: last.commit } : {})).workspace;
      await this.ctx
        .record(
          c,
          {
            kind: "error",
            message: `workspace folder was evicted; restored from ${last ? `the last ingested ref ${last.ref}` : "the default branch"}; un-pushed work is gone`,
          },
          `${child}:${c.generation}:merge-resume:restored`,
        )
        .catch(journalFailed(this.ctx.record, c, "restored"));
    }
    // A retry after a crash past the bump already wrote the checkpoint (at the exit generation, which the fenced write could not repeat now).
    if (c.generation === exitedAt) await this.ctx.hub.lifecycle.stopCheckpoint(c, `${child}:${exitedAt}:merge-resume:checkpoint`, null, restored);
    const rec = await this.ctx.hub.lifecycle.withFolderLock(child, async () => {
      const bumped = await d.registry.bumpGeneration(child, d.hostId, rkey);
      return d.registry.transition(child, bumped.generation, "running", { resume: true, idempotencyKey: transitionKey(child, bumped.generation, "running") });
    });
    // TODO(merge-resume-recovery): a crash after the transition above but before the wake below leaves the child running and a retry gets 409; reconcile does not pick it up yet.
    await this.ctx.record(rec, { kind: "resumed" }, `${child}:${rec.generation}:resumed`);
    await d.orchestrator.resume(child, rec.generation, resumeWake(failure));
    await this.ctx.hub.ops.mark(rec, "resume", rkey);
    return rec;
  }

  // `pomtree pull`: a bundle of the default branch plus `from`'s ingested refs. `from` defaults to the caller; the caller may pull
  // itself or an agent it is an ancestor of (via parent links), never a sibling or an ancestor.
  async pull(agent: AgentId, generation: number, from?: AgentId): Promise<AsyncIterable<Uint8Array>> {
    const d = this.ctx.deps;
    const r = await d.registry.get(agent);
    if (!r) throw new LifecycleError(404, `no such agent: ${agent}`);
    if (r.generation !== generation) throw new StaleGenerationError(agent, generation, r.generation);
    const scope = from ?? agent;
    if (scope !== agent) {
      if (!(await d.registry.get(scope))) throw new LifecycleError(404, `no such agent: ${scope}`);
      const ok = await this.tree.isDescendant(agent, scope);
      if (!ok) throw new LifecycleError(403, `${agent} may pull only itself or its descendants`);
    }
    return d.workspace.serve(agent, { scope });
  }

  // The fork source for a spawn: explicit fromCommit/sessionRef, else (`fork`) the requester's latest
  // checkpoint. A sessionRef must exist in the session store (404 otherwise); nothing is guessed.
  async resolveFork(requester: AgentRecord, req: SpawnRequest): Promise<{ commit?: string; sessionRef?: string; fromAgent?: AgentId } | null> {
    if (!req.fork && req.fromCommit === undefined && req.sessionRef === undefined) return null;
    let commit = req.fromCommit;
    let sessionRef = req.sessionRef;
    let fromAgent: AgentId | undefined;
    if (req.fork && commit === undefined && sessionRef === undefined) {
      const cp = await this.ctx.deps.checkpoints.latest(requester.id);
      if (!cp) throw new LifecycleError(409, `no checkpoint to fork from for ${requester.id}`);
      // The child's folder is a copy of the parent's, so the parent must not be writing to it.
      if (requester.state !== "yielded" && requester.state !== "exited")
        throw new LifecycleError(409, `cannot fork ${requester.id} while it is ${requester.state}; yield or exit first`);
      if (!(await this.ctx.deps.workspace.has(requester.id)))
        throw new LifecycleError(409, `the workspace folder of ${requester.id} is gone (evicted); fork needs the folder`);
      fromAgent = requester.id;
      sessionRef = cp.sessionRef;
    }
    if (sessionRef !== undefined && !(await this.ctx.deps.sessions.get(sessionRef))) throw new LifecycleError(404, `no such session: ${sessionRef}`);
    return { ...(commit !== undefined && { commit }), ...(sessionRef !== undefined && { sessionRef }), ...(fromAgent !== undefined && { fromAgent }) };
  }

  // The durable fork source journaled at spawn, or null (a plain spawn).
  async forkSource(id: AgentId): Promise<{ commit?: string; sessionRef?: string; fromAgent?: AgentId } | null> {
    for (let from = 1; ; ) {
      const page = await this.ctx.deps.journal.read({ from, agent: id, limit: 500 });
      for (const e of page) {
        if (e.payload.kind === FORK_KIND) {
          const f = e.payload as { commit?: string; sessionRef?: string; fromAgent?: AgentId };
          return {
            ...(f.commit !== undefined && { commit: f.commit }),
            ...(f.sessionRef !== undefined && { sessionRef: f.sessionRef }),
            ...(f.fromAgent !== undefined && { fromAgent: f.fromAgent }),
          };
        }
      }
      const last = page.at(-1);
      if (!last || page.length < 500) return null;
      from = last.seq + 1;
    }
  }

  // `reap` (with guard) is refused until the child's work is merged, escalated to the user, or there is nothing to merge.
  // TODO(merge-discard): there is no way to reap a child whose work is deliberately abandoned; it stays unreaped until it merges or escalates.
  async requireMergeSettled(id: AgentId): Promise<void> {
    const repos = this.ctx.deps.repos;
    if (!repos) return;
    const r = await this.ctx.deps.registry.get(id);
    if (!r || r.state !== "exited") return; // reapNow answers 404/409 for these
    const repo = await repos.repo();
    // A zombie whose parent is done has nobody merging into that parent's branch: its custodian is the owner.
    const parent = r.parent ? await this.ctx.deps.registry.get(r.parent) : null;
    const owner = parent && !isDone(parent) ? parent.id : (await this.tree.custodian(r)).id;
    const top = !owner || owner === (await this.tree.rootAgentId());
    const ownRef = top ? null : ((await this.ctx.deps.workspace.ingested(owner))?.ref ?? null);
    // Merged into the owner's branch, or (a top-level agent's merge) into the default branch, both count.
    let st = await repos.mergeStatus({ child: id, target: ownRef ?? `refs/heads/${repo.defaultBranch}` });
    if (!st.settled && ownRef) {
      const alt = await repos.mergeStatus({ child: id, target: `refs/heads/${repo.defaultBranch}` });
      if (alt.settled) st = alt;
    }
    if (!st.settled) {
      throw new LifecycleError(409, unmergedRefusal(id, st.state, st.failedRounds), {
        code: "unmerged",
        state: st.state,
        failedRounds: st.failedRounds,
      });
    }
  }
}
