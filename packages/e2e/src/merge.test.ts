import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { handle } from "@pomtree/pomtreed";
import { keyed } from "@pomtree/testing";
import { GitRepoStore } from "@pomtree/workspace-git";
import type { MergeObserver } from "@pomtree/workspace-git";
import type { CheckRunner } from "@pomtree/core";
import { agentPush, gitSkip, rig, until } from "./harness.ts";
import type { Rig } from "./harness.ts";

// Merge flow end to end with real git and the real sqlite stores: two agents, the child pushes, the parent calls the merge route,
// the merge commit lands in the parent's ref in the mirror, and only then may the child be reaped. Docker-free.
const skip = gitSkip();

async function mergeRig(o: { observe?: MergeObserver; checks?: CheckRunner; check?: string[] } = {}) {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const r = rig({
    deps: { approvals: undefined, approvalWaitMs: 20 },
    play: (_agent, prompt) =>
      prompt === "parent" ? { hold, result: { status: "succeeded", result: null } } : { result: { status: "succeeded", result: null } },
  });
  await r.workspace.refreshMirror();
  r.daemon.deps.repos = new GitRepoStore({
    mirrorDir: join(r.stateDir, "mirror.git"),
    host: "h1",
    merges: r.store.merges,
    repo: { id: "repo-e2e", name: "repo", defaultBranch: "main", policy: { deniedPaths: [], check: o.check ?? null } },
    ...(o.observe && { observe: o.observe }),
    ...(o.checks && { checks: o.checks }),
  });
  r.daemon.deps.approvals = r.store.approvals;
  const root = await r.daemon.root();
  const parent = await r.daemon.spawn(root.id, { name: "p", task: "parent", idempotencyKey: "p" });
  await until(async () => (await r.daemon.get(parent.id))?.state === "running", "parent running");
  const spawnChild = async (key: string) => {
    const c = await r.daemon.spawn(parent.id, { name: key, task: "child", idempotencyKey: key });
    await until(async () => (await r.daemon.get(c.id))?.state === "exited", `${key} exited`);
    return c;
  };
  const tok = () => r.daemon.agentToken(parent.id, parent.generation);
  const api = (method: string, url: string, body?: unknown) => handle(r.daemon, { method, url, body: keyed(method, body), token: tok() });
  return { r, parent, spawnChild, api, release: () => release() };
}

const mirrorGit = (r: Rig, ...a: string[]) => execFileSync("git", ["--git-dir", join(r.stateDir, "mirror.git"), ...a], { encoding: "utf8" }).trim();

test("merge e2e: the child's work lands in the parent's ref through the route, and reap is refused until then", { skip }, async () => {
  const { r, parent, spawnChild, api, release } = await mergeRig();
  try {
    const [pRef] = await agentPush(r, parent.id, "p.txt", "parent");
    const child = await spawnChild("c1");
    await agentPush(r, child.id, "c.txt", "child");
    const reap = () => api("POST", `/v1/agents/${child.id}/reap`, {});
    assert.equal((await reap()).status, 409, "reap refused before the merge");

    const out = await api("POST", "/v1/agents/self/merge?key=m1", { child: child.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const commit = (out.body as { commit: string }).commit;
    assert.equal(mirrorGit(r, "rev-parse", pRef!.ref), commit, "the parent's ref moved to the merge commit");
    assert.deepEqual(mirrorGit(r, "ls-tree", "--name-only", commit).split("\n").sort(), ["c.txt", "p.txt"]);
    assert.deepEqual((await api("POST", "/v1/agents/self/merge?key=m1", { child: child.id })).body, out.body, "replay by key");
    assert.equal(mirrorGit(r, "rev-parse", pRef!.ref), commit, "the replay moved nothing");

    assert.equal((await reap()).status, 200, "reap allowed once merged");
    assert.equal((await r.daemon.get(child.id))!.state, "reaped");
    assert.ok((await r.store.journal.read({ agent: parent.id })).some((e) => e.payload.kind === "merged"));
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("merge e2e: a conflict returns the paths and the merge succeeds after the parent resolves it", { skip }, async () => {
  const { r, parent, spawnChild, api, release } = await mergeRig();
  try {
    await agentPush(r, parent.id, "x.txt", "parent side");
    const child = await spawnChild("c2");
    await agentPush(r, child.id, "x.txt", "child side");
    const conflict = await api("POST", "/v1/agents/self/merge?key=c1", { child: child.id });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.deepEqual([(conflict.body as { code: string }).code, (conflict.body as { paths: string[] }).paths], ["conflict", ["x.txt"]]);
    assert.ok((await r.store.journal.read({ agent: parent.id })).some((e) => e.payload.kind === "merge_conflict"));
    assert.equal((await api("POST", `/v1/agents/${child.id}/reap`, {})).status, 409, "unmerged after a conflict");

    // The parent resolves in its own clone (pull the child's branch, merge, fix, push) and merges again.
    const pcreated = await r.workspace.create(parent.id, {});
    const dir = r.workspace.hostPath(pcreated.workspace);
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();
    g("fetch", "-q", r.workspace.hostPath(r.workspace.idFor(child.id)), `agent/${child.id}`);
    g("merge", "-q", "-s", "ours", "FETCH_HEAD", "-m", "resolve");
    const bundle = join(r.stateDir, "resolve.bundle");
    g("bundle", "create", bundle, pcreated.branch, `^${pcreated.commit}`);
    const bytes = (await import("node:fs")).readFileSync(bundle);
    const ing = await r.workspace.ingest(
      parent.id,
      (async function* () {
        yield bytes;
      })(),
      { maxBytes: 16 << 20 },
    );
    assert.ok(ing.ok, JSON.stringify(ing));
    const done = await api("POST", "/v1/agents/self/merge?key=c2", { child: child.id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await api("POST", `/v1/agents/${child.id}/reap`, {})).status, 200);
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("merge e2e: the top-level agent merges itself into main under approval (pending 409, grant, CAS), and a second agent's clone sees it", {
  skip,
}, async () => {
  const { r, parent, api, release } = await mergeRig();
  try {
    await agentPush(r, parent.id, "top.txt", "top");
    const mainBefore = mirrorGit(r, "rev-parse", "refs/heads/main");
    const pending = await api("POST", "/v1/agents/self/merge?key=mm", { into: "main" });
    assert.equal(pending.status, 409, JSON.stringify(pending.body));
    const pb = pending.body as { code: string; reason: string; approval: string };
    assert.deepEqual([pb.code, pb.reason], ["policy_rejected", "approval_required"]);
    assert.equal(mirrorGit(r, "rev-parse", "refs/heads/main"), mainBefore, "main untouched while pending");
    await r.daemon.decideApproval(pb.approval, "approve", "user", "ok", "mm-decide");
    const done = await api("POST", "/v1/agents/self/merge?key=mm", { into: "main" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const commit = (done.body as { commit: string }).commit;
    assert.equal(mirrorGit(r, "rev-parse", "refs/heads/main"), commit);
    assert.equal(mirrorGit(r, "rev-parse", `${commit}^1`), mainBefore, "the target moved by compare-and-swap from the pinned tip");
    const second = await r.workspace.create("second-agent", {});
    assert.equal(
      execFileSync("git", ["log", "-1", "--format=%H"], { cwd: r.workspace.hostPath(second.workspace), encoding: "utf8" }).trim(),
      commit,
      "a later clone starts at the merged main",
    );
    // a non-top-level agent cannot do the same
    const c = await r.daemon.spawn(parent.id, { name: "k", task: "child", idempotencyKey: "kk" });
    await until(async () => (await r.daemon.get(c.id))?.state === "exited", "child exited");
    const kid = r.daemon.agentToken(c.id, c.generation);
    assert.ok([403, 409].includes((await handle(r.daemon, { method: "POST", url: "/v1/agents/self/merge?key=z", body: { into: "main" }, token: kid })).status));
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("merge e2e: a target that moves mid-merge retries and merges onto the new tip", { skip }, async () => {
  let ctx!: Awaited<ReturnType<typeof mergeRig>>;
  let moved = false;
  let parentRef = "";
  const observe: MergeObserver = (e) => {
    if (e.phase !== "candidate" || moved) return;
    moved = true;
    const tree = mirrorGit(ctx.r, "rev-parse", `${e.record.base}^{tree}`);
    const bump = execFileSync(
      "git",
      ["--git-dir", join(ctx.r.stateDir, "mirror.git"), "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-p", e.record.base!, "-m", "moved"],
      { encoding: "utf8" },
    ).trim();
    mirrorGit(ctx.r, "update-ref", parentRef, bump);
  };
  ctx = await mergeRig({ observe });
  const { r, parent, spawnChild, api, release } = ctx;
  try {
    parentRef = (await agentPush(r, parent.id, "p.txt", "p"))[0]!.ref;
    const child = await spawnChild("mv");
    await agentPush(r, child.id, "c.txt", "c");
    const out = await api("POST", "/v1/agents/self/merge?key=mv", { child: child.id });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok(moved);
    const commit = (out.body as { commit: string }).commit;
    assert.equal(mirrorGit(r, "log", "-1", "--format=%s", `${commit}^1`), "moved", "merged onto the moved tip");
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});

test("merge e2e: a failing check leaves the target untouched and reports check_failed; a passing stub merges", { skip }, async () => {
  const verdicts = [false, true];
  const checks: CheckRunner = { run: async () => ({ ok: verdicts.shift()!, summary: "stub check" }) };
  const { r, parent, spawnChild, api, release } = await mergeRig({ checks, check: ["true"] });
  try {
    const [pRef] = await agentPush(r, parent.id, "p.txt", "p");
    const child = await spawnChild("ck");
    await agentPush(r, child.id, "c.txt", "c");
    const before = mirrorGit(r, "rev-parse", pRef!.ref);
    const bad = await api("POST", "/v1/agents/self/merge?key=ck1", { child: child.id });
    assert.deepEqual([bad.status, (bad.body as { code: string }).code], [409, "check_failed"]);
    assert.equal(mirrorGit(r, "rev-parse", pRef!.ref), before);
    assert.equal((await api("POST", `/v1/agents/${child.id}/reap`, {})).status, 409);
    assert.equal((await api("POST", "/v1/agents/self/merge?key=ck2", { child: child.id })).status, 200);
    assert.notEqual(mirrorGit(r, "rev-parse", pRef!.ref), before);
  } finally {
    release();
    await r.orchestrator.idle();
    r.store.close();
  }
});
