import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergeResult, Repo } from "@pomtree/core";
import { createFakes, tmpDir } from "@pomtree/testing";
import { evaluateGitVersion } from "./git-env.ts";
import { GitRepoStore, type MergeObserver } from "./repo-store.ts";
import { GitWorkspace } from "./workspace.ts";
import { agentRef, git, kit, type Kit } from "./repo-kit.ts";

const gv = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gv.warning ? `needs git >= 2.38 (found ${gv.version ?? "unknown"})` : false;
const REPO: Repo = { id: "repo-1", name: "repo", defaultBranch: "main", policy: { deniedPaths: [], check: null } };
const SPEC = { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };

async function world(observe?: MergeObserver) {
  const k = kit();
  const f = createFakes();
  await f.registry.create({ id: "p", parent: null, name: "p", task: "t", host: "h", budgetMicros: 1, spec: SPEC, idempotencyKey: "mk-p" });
  const store = new GitRepoStore({
    mirrorDir: k.mirror,
    repo: REPO,
    host: "h",
    merges: f.merges,
    tmpRoot: join(k.base, "tmp"),
    now: () => 1_700_000_000_000,
    ...(observe && { observe }),
  });
  return { k, store };
}
const parents = (k: Kit, sha: string): string[] => k.mirrorGit("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
const show = (k: Kit, sha: string, path: string): string => k.mirrorGit("show", `${sha}:${path}`);
const merged = (r: MergeResult) => {
  assert.equal(r.status, "merged", JSON.stringify(r));
  return r as Extract<MergeResult, { status: "merged" }>;
};
const codeOf = (r: MergeResult) => (r as { code?: string }).code;
// child === caller is the whole request-shape change: the caller's own ingested branch into refs/heads/<default>, with an approval.
const selfReq = (k: Kit, over: Record<string, unknown> = {}) =>
  k.request({ child: "p", source: agentRef("p"), target: "refs/heads/main", approval: "appr-1", ...over });

test("self-merge: the top-level branch merges into main with an approval; refused without one or into a non-default target", { skip }, async () => {
  const { k, store } = await world();
  const P = k.commit(k.root, { "top.txt": "t\n" });
  k.put(agentRef("p"), P);
  assert.equal(codeOf(await store.merge(selfReq(k, { approval: undefined }), "s0")), "approval_required");
  assert.equal(codeOf(await store.merge(selfReq(k, { target: agentRef("p", "other") }), "s1")), "bad_ref");
  assert.equal(codeOf(await store.merge(selfReq(k, { target: "refs/heads/release" }), "s1b")), "bad_ref");
  assert.equal(k.ref("refs/heads/main"), k.root);
  const r = merged(await store.merge(selfReq(k), "s2"));
  assert.equal(k.ref("refs/heads/main"), r.commit);
  assert.deepEqual(parents(k, r.commit), [k.root, P]);
  assert.match(k.mirrorGit("log", "-1", "--format=%B", r.commit), /^Pomtree-Agent: p$/m);
  assert.deepEqual(await store.merge(selfReq(k), "s2"), r);
  assert.deepEqual(await store.mergeStatus({ child: "p", target: "refs/heads/main" }), { state: "merged", merged: true, failedRounds: 0, settled: true });
});

test("self-merge: a moving main retries via CAS; a conflict against a moved main returns the paths", { skip }, async () => {
  let kk!: Kit;
  let moved = false;
  const { k, store } = await world((e) => {
    if (e.phase === "candidate" && !moved) {
      moved = true;
      kk.put("refs/heads/main", kk.commit(e.record.base!, { "op.txt": "operator\n" }));
    }
  });
  kk = k;
  const P = k.commit(k.root, { "top.txt": "t\n" });
  k.put(agentRef("p"), P);
  const r = merged(await store.merge(selfReq(k), "sc1"));
  assert.notEqual(r.base, k.root);
  assert.equal(show(k, r.commit, "op.txt"), "operator");
  k.setupGit("fetch", "-q", k.mirror, "refs/heads/main"); // the engine's commit lives only in the mirror
  const M2 = k.commit(r.commit, { "a.txt": "main side\n" });
  k.put("refs/heads/main", M2);
  k.put(agentRef("p"), k.commit(P, { "a.txt": "agent side\n" }));
  const c = await store.merge(selfReq(k), "sc2");
  assert.deepEqual([c.status, (c as { paths?: string[] }).paths], ["conflict", ["a.txt"]]);
  assert.equal(k.ref("refs/heads/main"), M2);
  assert.equal((await store.mergeStatus({ child: "p", target: "refs/heads/main" })).state, "conflict");
});

test("self-merge: a real SIGKILL between candidate and ref update leaves main untouched", { skip }, async () => {
  const { k, store } = await world();
  k.put(agentRef("p"), k.commit(k.root, { "top.txt": "t\n" }));
  const child = spawnSync(process.execPath, [join(import.meta.dirname, "merge-kill-child.ts"), k.mirror, join(k.base, "tmp-kill"), "self"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.signal, "SIGKILL", `child stderr: ${child.stderr}`);
  assert.equal(k.ref("refs/heads/main"), k.root);
  merged(await store.merge(selfReq(k), "self-retry"));
  assert.notEqual(k.ref("refs/heads/main"), k.root);
});

test("ingested() follows the ref: after an engine merge into the caller's branch it returns the merge commit", { skip }, async () => {
  const base = tmpDir("ingmv-");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "one");
  const one = git(repo, "rev-parse", "HEAD");
  const mirror = join(base, "mirror.git");
  const ws = new GitWorkspace({ repoDir: repo, mirrorDir: mirror, foldersRoot: join(base, "f"), tmpRoot: join(base, "t") });
  await ws.refreshMirror();
  git(repo, "checkout", "-q", "-b", "agent/p");
  writeFileSync(join(repo, "p.txt"), "p");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "p");
  const out = join(base, "p.bundle");
  git(repo, "bundle", "create", out, "agent/p", `^${one}`);
  const bytes = readFileSync(out);
  assert.equal(
    (
      await ws.ingest(
        "p",
        (async function* () {
          yield bytes;
        })(),
        { maxBytes: 1 << 20 },
      )
    ).ok,
    true,
  );
  const tip = git(repo, "rev-parse", "HEAD");
  assert.equal((await ws.ingested("p"))?.commit, tip);
  const engine = git(mirror, "commit-tree", git(mirror, "rev-parse", `${tip}^{tree}`), "-p", tip, "-m", "engine merge");
  git(mirror, "update-ref", "refs/agents/p/heads/agent/p", engine, tip);
  const now = await ws.ingested("p");
  assert.deepEqual(now, { ref: "refs/agents/p/heads/agent/p", commit: engine });
  const f = createFakes();
  await f.registry.create({ id: "p", parent: null, name: "p", task: "t", host: "h", budgetMicros: 1, spec: SPEC, idempotencyKey: "p" });
  const cp = await f.checkpoints.write(
    {
      agent: "p",
      host: "h",
      generation: 0,
      sessionRef: "s",
      workspace: "ws-p",
      node: "h",
      ingested: now,
      wait: null,
      remainingBudgetMicros: 1,
      imageDigest: "d",
      envManifestHash: null,
      template: "code",
      templateDigest: null,
      resumeLevel: "session",
    },
    "cp1",
  );
  assert.equal(cp.ingested?.commit, engine);
});
