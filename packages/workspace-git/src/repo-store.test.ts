import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StaleGenerationError } from "@pomtree/core";
import type { MergeResult, MergeStore, Repo } from "@pomtree/core";
import { createFakes } from "@pomtree/testing";
import { evaluateGitVersion } from "./git-env.ts";
import { GitRepoStore, type MergeObserver } from "./repo-store.ts";
import { runGit } from "./git-runner.ts";
import { agentRef, kit, type Kit } from "./repo-kit.ts";

const gitVersion = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gitVersion.warning ? `merge engine tests need git >= 2.38 (found ${gitVersion.version ?? "unknown"})` : false;

const REPO: Repo = { id: "repo-1", name: "repo", defaultBranch: "main", policy: { deniedPaths: [".github/"], check: null } };

async function world(o: { check?: string[]; observe?: MergeObserver; maxAttempts?: number; merges?: (m: MergeStore) => MergeStore } = {}) {
  const k = kit();
  const f = createFakes();
  for (const id of ["p", "c", "d", "gp"])
    await f.registry.create({
      id,
      parent: null,
      name: id,
      task: "t",
      host: "h",
      budgetMicros: 1,
      spec: { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
      idempotencyKey: `mk-${id}`,
    });
  const merges = o.merges ? o.merges(f.merges) : f.merges;
  const observe: MergeObserver = (e) => o.observe?.(e);
  const store = new GitRepoStore({
    mirrorDir: k.mirror,
    repo: { ...REPO, policy: { ...REPO.policy, check: o.check ?? null } },
    host: "h",
    merges,
    checks: f.checks,
    tmpRoot: join(k.base, "tmp"),
    ...(o.maxAttempts !== undefined && { maxAttempts: o.maxAttempts }),
    observe,
    now: () => 1_700_000_000_000,
  });
  return { k, f, store, raw: f.hooks.raw };
}

const parents = (k: Kit, sha: string): string[] => k.mirrorGit("rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
const show = (k: Kit, sha: string, path: string): string => k.mirrorGit("show", `${sha}:${path}`);
const merged = (r: MergeResult) => {
  assert.equal(r.status, "merged", JSON.stringify(r));
  return r as Extract<MergeResult, { status: "merged" }>;
};

test("repo() returns the configured repository, with and without a check command", async () => {
  const { store } = await world();
  assert.deepEqual(await store.repo(), { ...REPO, policy: { ...REPO.policy, check: null } });
  const withCheck = await world({ check: ["npm", "test"] });
  assert.deepEqual(await withCheck.store.repo(), { ...REPO, policy: { ...REPO.policy, check: ["npm", "test"] } });
});

test("clean merge: candidate has parents (B, T) and a Pomtree-Agent trailer; the target moves once; replay is identical", { skip }, async () => {
  const { k, store } = await world();
  const B = k.commit(k.root, { "p.txt": "p\n" });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  const r = merged(await store.merge(k.request(), "m1"));
  assert.equal(k.ref(agentRef("p")), r.commit);
  assert.deepEqual(parents(k, r.commit), [B, T]);
  assert.equal(show(k, r.commit, "p.txt") + show(k, r.commit, "c.txt"), "pc");
  const msg = k.mirrorGit("log", "-1", "--format=%B", r.commit);
  assert.match(msg, /^Pomtree-Agent: p$/m);
  assert.match(msg, new RegExp(`^Pomtree-Merged: c ${T}$`, "m"));
  assert.deepEqual(await store.merge(k.request(), "m1"), r); // idempotent replay
  assert.equal(k.ref(agentRef("p")), r.commit);
  // a second invocation finds the child already merged and writes nothing
  const again = merged(await store.merge(k.request(), "m2"));
  assert.deepEqual([again.alreadyMerged, again.commit], [true, r.commit]);
  assert.deepEqual(await store.mergeStatus({ child: "c", target: agentRef("p") }), { state: "merged", merged: true, failedRounds: 0, settled: true });
});

test("the top-level branch merges into main only with an approval id", { skip }, async () => {
  const { k, store } = await world();
  const T = k.commit(k.root, { "top.txt": "t\n" });
  k.put(agentRef("c"), T);
  const denied = await store.merge(k.request({ caller: "p", target: "refs/heads/main" }), "t1");
  assert.deepEqual([denied.status, (denied as { code?: string }).code], ["policy_rejected", "approval_required"]);
  assert.equal(k.ref("refs/heads/main"), k.root);
  const ok = merged(await store.merge(k.request({ target: "refs/heads/main", approval: "appr-1" }), "t2"));
  assert.equal(k.ref("refs/heads/main"), ok.commit);
  assert.deepEqual(parents(k, ok.commit), [k.root, T]);
});

test("a moved target retries from the top and succeeds on the new tip", { skip }, async () => {
  let moved = false;
  let kk!: Kit;
  const { k, store, raw } = await world({
    observe: (e) => {
      if (e.phase === "candidate" && !moved) {
        // the caller pushes between candidate and ref update
        moved = true;
        const B2 = kk.commit(e.record.base!, { "p2.txt": "p2\n" });
        kk.put(agentRef("p"), B2);
      }
    },
  });
  kk = k;
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("c"), T);
  const r = merged(await store.merge(k.request(), "mv"));
  assert.equal(parents(k, r.commit)[0], r.base);
  assert.notEqual(r.base, k.root); // merged onto the moved tip
  assert.equal(show(k, r.commit, "p2.txt"), "p2");
  assert.equal(k.ref(agentRef("p")), r.commit);
  assert.equal((await raw.merges.get([...raw.merges.records.keys()][0]!))!.attempts, 2);
});

test("a target that keeps moving reports `moved` without writing, and is not a failed round", { skip }, async () => {
  let kk!: Kit;
  let n = 0;
  const { k, store, raw } = await world({
    maxAttempts: 2,
    observe: (e) => {
      if (e.phase === "candidate") kk.put(agentRef("p"), kk.commit(e.record.base!, { [`m${n++}.txt`]: "x\n" }));
    },
  });
  kk = k;
  k.put(agentRef("c"), k.commit(k.root, { "c.txt": "c\n" }));
  const r = await store.merge(k.request(), "mv2");
  assert.equal(r.status, "moved");
  assert.ok(!k.mirrorGit("log", "--format=%s", agentRef("p")).includes("Merge"));
  assert.equal((await raw.merges.status("repo-1", "c")).failedRounds, 0);
  assert.deepEqual(await store.merge(k.request(), "mv2"), r);
});

test("a conflict returns the paths and leaves the target alone; it succeeds after the caller resolves and pushes", { skip }, async () => {
  const { k, store } = await world();
  const B = k.commit(k.root, { "a.txt": "parent\n" });
  const T = k.commit(k.root, { "a.txt": "child\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  const r = await store.merge(k.request(), "cf1");
  assert.deepEqual(r, { status: "conflict", paths: ["a.txt"], targetTip: B, sourceTip: T, round: 1 });
  assert.equal(k.ref(agentRef("p")), B);
  // unchanged tips, new invocation: the same conflict, no new round
  assert.deepEqual(await store.merge(k.request(), "cf1b"), r);
  assert.equal((await store.mergeStatus({ child: "c", target: agentRef("p") })).failedRounds, 1);
  // the caller resolves in its own clone (merge T, fix the file) and pushes
  k.setupGit("checkout", "-q", "--detach", "--force", B);
  try {
    k.setupGit("merge", "--no-edit", T);
  } catch {
    /* conflict markers expected */
  }
  writeFileSync(join(k.work, "a.txt"), "resolved\n");
  k.setupGit("add", "a.txt");
  k.setupGit("commit", "-qm", "resolve");
  const M = k.setupGit("rev-parse", "HEAD");
  k.put(agentRef("p"), M);
  const done = merged(await store.merge(k.request(), "cf2"));
  assert.deepEqual([done.alreadyMerged, done.commit, k.ref(agentRef("p"))], [true, M, M]);
});

test("a conflict also clears when the child resumes, updates onto the parent's tip and pushes", { skip }, async () => {
  const { k, store } = await world();
  const B = k.commit(k.root, { "a.txt": "parent\n" });
  const T = k.commit(k.root, { "a.txt": "child\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  assert.equal((await store.merge(k.request(), "rs1")).status, "conflict");
  k.setupGit("checkout", "-q", "--detach", "--force", T);
  try {
    k.setupGit("merge", "--no-edit", B);
  } catch {
    /* conflict markers expected */
  }
  writeFileSync(join(k.work, "a.txt"), "child-resolved\n");
  k.setupGit("add", "a.txt");
  k.setupGit("commit", "-qm", "child resolves");
  const T2 = k.setupGit("rev-parse", "HEAD");
  k.put(agentRef("c"), T2);
  const r = merged(await store.merge(k.request(), "rs2"));
  assert.equal(show(k, r.commit, "a.txt"), "child-resolved");
  assert.deepEqual(parents(k, r.commit), [B, T2]);
});

test("three failed rounds escalate; escalation settles the child for reap; a later clean merge resets", { skip }, async () => {
  const { k, store } = await world();
  const B = k.commit(k.root, { "a.txt": "parent\n" });
  k.put(agentRef("p"), B);
  let result: MergeResult | undefined;
  for (let round = 1; round <= 3; round++) {
    k.put(agentRef("c"), k.commit(k.root, { "a.txt": `child ${round}\n` })); // each round the child pushes another conflicting attempt
    result = await store.merge(k.request(), `esc${round}`);
    if (round < 3) {
      assert.equal(result.status, "conflict");
      assert.equal((result as { round: number }).round, round);
      assert.equal((await store.mergeStatus({ child: "c", target: agentRef("p") })).settled, false);
    }
  }
  assert.equal(result!.status, "escalate");
  assert.deepEqual(
    [(result as { reason: string }).reason, (result as { rounds: number }).rounds, (result as { paths: string[] }).paths],
    ["conflict", 3, ["a.txt"]],
  );
  assert.equal(k.ref(agentRef("p")), B);
  assert.deepEqual(await store.mergeStatus({ child: "c", target: agentRef("p") }), { state: "escalated", merged: false, failedRounds: 3, settled: true });
  // Documented behavior: the counter stays at the cap, so the next failure of any kind escalates again at once (re-asks the user).
  k.put(agentRef("c"), k.commit(k.root, { "a.txt": "child again\n" }));
  const again = await store.merge(k.request(), "esc3b");
  assert.deepEqual([again.status, (again as { rounds?: number }).rounds], ["escalate", 4]);
  // the user resolves it by hand: the next clean merge resets the counter
  k.put(agentRef("c"), k.commit(B, { "z.txt": "z\n" }));
  merged(await store.merge(k.request(), "esc4"));
  assert.deepEqual(await store.mergeStatus({ child: "c", target: agentRef("p") }), { state: "merged", merged: true, failedRounds: 0, settled: true });
});

test("fault injection: a crash between the candidate commit and the ref update leaves the old ref; a retry with the same key completes", { skip }, async () => {
  let crash = true;
  const { k, store, raw } = await world({
    observe: (e) => {
      if (e.phase === "candidate" && crash) throw new Error("injected crash");
    },
  });
  const B = k.commit(k.root, { "p.txt": "p\n" });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  await assert.rejects(() => store.merge(k.request(), "ft1"), /injected crash/);
  assert.equal(k.ref(agentRef("p")), B); // old ref
  const open = await raw.merges.list({ open: true });
  assert.equal(open.length, 1);
  assert.equal(open[0]!.phase, "candidate");
  const cand = open[0]!.candidate!;
  assert.equal(k.mirrorGit("cat-file", "-t", cand), "commit"); // written but unreferenced
  crash = false;
  const r = merged(await store.merge(k.request(), "ft1"));
  assert.equal(r.commit, cand); // the same candidate: dates come from the record
  assert.equal(k.ref(agentRef("p")), cand);
  assert.deepEqual(await store.merge(k.request(), "ft1"), r);
  assert.equal((await raw.merges.list({ open: true })).length, 0);
});

test("fault injection: a crash after the ref moved but before the journal settles is recognised on retry (no second merge commit)", { skip }, async () => {
  let failSettle = true;
  const { k, store } = await world({
    merges: (m) =>
      new Proxy(m, {
        get(t, p, r) {
          if (p === "settle")
            return async (...a: Parameters<MergeStore["settle"]>) => {
              if (failSettle) {
                failSettle = false;
                throw new Error("injected settle crash");
              }
              return t.settle(...a);
            };
          return Reflect.get(t, p, r);
        },
      }),
  });
  const B = k.commit(k.root, { "p.txt": "p\n" });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  await assert.rejects(() => store.merge(k.request(), "fs1"), /settle crash/);
  const moved = k.ref(agentRef("p"))!;
  assert.notEqual(moved, B);
  const r = merged(await store.merge(k.request(), "fs1"));
  assert.deepEqual([r.commit, r.alreadyMerged, k.ref(agentRef("p"))], [moved, undefined, moved]);
  assert.equal(k.mirrorGit("rev-list", "--count", `${B}..${moved}`), "2"); // the merge and T, nothing more
});

test("C2b-14: a double crash after the ref moved still settles with the original candidate, not alreadyMerged", { skip }, async () => {
  let failures = 2;
  const { k, store } = await world({
    merges: (m) =>
      new Proxy(m, {
        get(t, p, r) {
          if (p === "settle")
            return async (...a: Parameters<MergeStore["settle"]>) => {
              if (failures-- > 0) throw new Error("injected settle crash");
              return t.settle(...a);
            };
          return Reflect.get(t, p, r);
        },
      }),
  });
  const B = k.commit(k.root, { "p.txt": "p\n" });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  await assert.rejects(() => store.merge(k.request(), "dc1"), /settle crash/);
  const moved = k.ref(agentRef("p"))!;
  await assert.rejects(() => store.merge(k.request(), "dc1"), /settle crash/);
  const r = merged(await store.merge(k.request(), "dc1"));
  assert.deepEqual([r.commit, r.alreadyMerged, k.ref(agentRef("p"))], [moved, undefined, moved]);
  // negative: a source that was already in the target before any attempt is still reported alreadyMerged
  k.put(agentRef("c"), B);
  assert.equal(merged(await store.merge(k.request(), "dc2")).alreadyMerged, true);
});

test("recover() finishes merges left open by a crash", { skip }, async () => {
  let crash = true;
  const { k, store } = await world({
    observe: (e) => {
      if (e.phase === "pinned" && crash) throw new Error("boom");
    },
  });
  k.put(agentRef("c"), k.commit(k.root, { "c.txt": "c\n" }));
  await assert.rejects(() => store.merge(k.request(), "rc1"), /boom/);
  crash = false;
  const out = await store.recover();
  assert.deepEqual(
    out.map((r) => r.status),
    ["merged"],
  );
});

test("a real SIGKILL between candidate and ref update leaves the old ref and no ref lock; a fresh run then merges", { skip }, async () => {
  const { k, store } = await world();
  const B = k.commit(k.root, { "p.txt": "p\n" });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  const child = spawnSync(process.execPath, [join(import.meta.dirname, "merge-kill-child.ts"), k.mirror, join(k.base, "tmp-kill")], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(child.signal, "SIGKILL", `child stderr: ${child.stderr}`);
  const cand = /candidate (\w{40})/.exec(child.stdout)?.[1];
  assert.ok(cand, "child reported its candidate before dying");
  assert.equal(k.ref(agentRef("p")), B);
  assert.equal(k.mirrorGit("cat-file", "-t", cand), "commit");
  const locks = k
    .mirrorGit("for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((l) => l.endsWith(".lock"));
  assert.deepEqual(locks, []);
  assert.ok(!readdirSync(join(k.mirror, "refs", "agents", "p", "heads", "agent")).some((n) => n.endsWith(".lock")));
  merged(await store.merge(k.request(), "kill-retry"));
  assert.notEqual(k.ref(agentRef("p")), B);
});

test("a failing check leaves the target untouched and is a failed round; the runner saw the exact candidate", { skip }, async () => {
  const { k, store, raw } = await world({ check: ["make", "test"] });
  const B = k.commit(k.root, { "p.txt": "p\n" });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  raw.checks.results.push({ ok: false, summary: "3 tests failed" });
  const r = await store.merge(k.request(), "ck1");
  assert.equal(r.status, "check_failed");
  const cf = r as Extract<MergeResult, { status: "check_failed" }>;
  assert.deepEqual([cf.summary, cf.round, cf.targetTip, cf.sourceTip], ["3 tests failed", 1, B, T]);
  assert.equal(k.ref(agentRef("p")), B);
  assert.deepEqual(
    raw.checks.runs.map((x) => [x.commit, x.command]),
    [[cf.candidate, ["make", "test"]]],
  );
  assert.deepEqual(parents(k, cf.candidate), [B, T]);
  assert.deepEqual(await store.mergeStatus({ child: "c", target: agentRef("p") }), { state: "check_failed", merged: false, failedRounds: 1, settled: false });
  // the check passes on a second invocation (unlike a conflict, a failed check is re-run)
  const ok = merged(await store.merge(k.request(), "ck2"));
  assert.equal(ok.commit, cf.candidate);
  assert.equal(raw.checks.runs.at(-1)!.commit, ok.commit);
});

test("three failing checks escalate; a missing runner fails closed; a runner crash leaves the target and retries", { skip }, async () => {
  const w = await world({ check: ["make"] });
  const B = w.k.commit(w.k.root, { "p.txt": "p\n" });
  w.k.put(agentRef("p"), B);
  w.k.put(agentRef("c"), w.k.commit(w.k.root, { "c.txt": "c\n" }));
  w.raw.checks.results.push(new Error("runner down"));
  await assert.rejects(() => w.store.merge(w.k.request(), "cr1"), /runner down/);
  assert.equal(w.k.ref(agentRef("p")), B);
  w.raw.checks.results.push({ ok: false, summary: "x" }, { ok: false, summary: "y" }, { ok: false, summary: "z" });
  assert.equal((await w.store.merge(w.k.request(), "cr1")).status, "check_failed"); // same key resumes the open record
  assert.equal((await w.store.merge(w.k.request(), "cr2")).status, "check_failed");
  const esc = await w.store.merge(w.k.request(), "cr3");
  assert.deepEqual([esc.status, (esc as { reason?: string }).reason, (esc as { summary?: string }).summary], ["escalate", "check_failed", "z"]);
  const f2 = createFakes();
  await f2.registry.create({
    id: "p",
    parent: null,
    name: "p",
    task: "t",
    host: "h",
    budgetMicros: 1,
    spec: { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" } },
    idempotencyKey: "x",
  });
  const closed = await new GitRepoStore({
    mirrorDir: w.k.mirror,
    repo: { ...REPO, policy: { deniedPaths: [], check: ["make"] } },
    host: "h",
    merges: f2.merges,
  }).merge(w.k.request(), "cr4");
  assert.deepEqual([closed.status, (closed as { code?: string }).code], ["policy_rejected", "check_unavailable"]);
});

test("policy: a denied path, a submodule and a .gitmodules file are rejected and the target is untouched", { skip }, async () => {
  const { k, store } = await world();
  const B = k.commit(k.root, { "p.txt": "p\n" });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), k.commit(k.root, { ".github/workflows/ci.yml": "on: push\n" }));
  assert.deepEqual([((await store.merge(k.request(), "pol1")) as { code?: string }).code], ["denied_path"]);
  k.put(agentRef("c"), k.commit(k.root, { ".gitmodules": '[submodule "s"]\n path = s\n url = ../x\n' }));
  assert.equal(((await store.merge(k.request(), "pol2")) as { code?: string }).code, "submodule");
  // a gitlink entry (mode 160000) made directly in the index
  k.setupGit("checkout", "-q", "--detach", "--force", k.root);
  k.setupGit("update-index", "--add", "--cacheinfo", `160000,${k.root},sub`);
  k.setupGit("commit", "-qm", "gitlink");
  k.put(agentRef("c"), k.setupGit("rev-parse", "HEAD"));
  assert.equal(((await store.merge(k.request(), "pol3")) as { code?: string }).code, "submodule");
  assert.equal(k.ref(agentRef("p")), B);
});

// What this proves: merging a tree full of hostile-looking content (attribute, hook and config files, odd and huge paths)
// while the host environment carries injection attempts creates no marker file, and the engine's git runner ignores
// environment- and HOME-supplied config (controls: a plain git DOES honour them). It does not claim that bare
// `merge-tree` would run a merge driver: it reads no tree attributes, so that is not an execution vector here.
test("hostile input: hostile tree content and host env/HOME config leave no side effect, and the runner ignores injected config (with controls)", {
  skip,
}, async () => {
  const { k, store } = await world();
  const marker = join(k.base, "PWNED");
  const evil = `touch ${marker}`;
  const home = join(k.base, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = injected-from-home\n[merge "evil"]\n\tdriver = ${evil}\n[core]\n\tfsmonitor = ${evil}\n`);
  {
    // Controls: the same injection DOES alter an unhardened git that reads config, but not the engine's runner.
    const inject = { HOME: home, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/injected-hooks" };
    const plain = (key: string) =>
      spawnSync("git", ["--git-dir", k.mirror, "config", "--get", key], { env: { PATH: process.env.PATH ?? "", ...inject }, encoding: "utf8" }).stdout.trim();
    assert.equal(plain("core.hooksPath"), "/injected-hooks", "control: env injection reaches an unhardened git");
    assert.equal(plain("user.name"), "injected-from-home", "control: HOME config reaches an unhardened git");
    const saved0 = { ...process.env };
    Object.assign(process.env, inject);
    try {
      const hardened = async (key: string) => (await runGit(["--git-dir", k.mirror, "config", "--get", key], { okCodes: [1] })).stdout.toString("utf8").trim();
      assert.equal(await hardened("core.hooksPath"), "/dev/null");
      assert.equal(await hardened("user.name"), "");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved0)) delete process.env[key];
      Object.assign(process.env, saved0);
    }
  }
  const longName = "n".repeat(240);
  const deep = Array.from({ length: 60 }, () => "d").join("/") + "/leaf.txt";
  const B = k.commit(k.root, { "a.txt": "parent\n", ".gitattributes": "* merge=evil filter=evil diff=evil export-subst\n" });
  const T = k.commit(k.root, {
    "a.txt": "child\n",
    ".gitattributes": "* merge=evil filter=evil diff=evil\n",
    "hooks/pre-merge-commit": `#!/bin/sh\n${evil}\n`,
    config: `[core]\n\tfsmonitor = ${evil}\n`,
    ".gitconfig": `[core]\n\tfsmonitor = ${evil}\n`,
    HEAD: "ref: refs/heads/evil\n",
    [longName]: "long\n",
    [deep]: "deep\n",
    "weird ‮ name\t.txt": "odd\n",
    "new\nline.txt": "nl\n",
  });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  const saved = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "merge.evil.driver",
    GIT_CONFIG_VALUE_0: evil,
    GIT_EXTERNAL_DIFF: evil,
    GIT_SSH_COMMAND: evil,
    GIT_EDITOR: evil,
  });
  let r: MergeResult;
  try {
    r = await store.merge(k.request(), "host1");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  assert.equal(r.status, "conflict");
  assert.deepEqual((r as { paths: string[] }).paths, [".gitattributes", "a.txt"]); // both really conflict; nothing ran to "resolve" them
  assert.equal(existsSync(marker), false, "no hostile command ran");
  assert.equal(k.ref(agentRef("p")), B);
  // Resolve the conflict away and merge the same hostile tree cleanly: still nothing runs, and the odd paths land as objects.
  const T2 = k.commit(T, { "a.txt": "parent\n", ".gitattributes": "* merge=evil filter=evil diff=evil export-subst\n" });
  k.put(agentRef("c"), T2);
  Object.assign(process.env, { HOME: home, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "merge.evil.driver", GIT_CONFIG_VALUE_0: evil });
  try {
    r = await store.merge(k.request(), "host2");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const m = merged(r);
  assert.equal(existsSync(marker), false, "no hostile command ran on the clean path either");
  assert.equal(show(k, m.commit, `${longName}`), "long");
  assert.equal(show(k, m.commit, deep), "deep");
  assert.equal(readdirSync(k.mirror).includes("hooks") && existsSync(join(k.mirror, "hooks", "pre-merge-commit")), false); // the tree's hooks dir never reaches the mirror's own
  assert.equal(existsSync(join(k.mirror, "a.txt")), false); // nothing was checked out
});

test("revisions are validated: missing refs, non-commit refs, a stale pin, foreign namespaces and option-like refs are rejected without touching anything", {
  skip,
}, async () => {
  const { k, store } = await world();
  const B = k.ref(agentRef("p"))!;
  const code = async (over: Parameters<Kit["request"]>[0], key: string) => ((await store.merge(k.request(over), key)) as { code?: string }).code;
  assert.equal(await code({ source: agentRef("c", "nosuch") }, "v1"), "no_source");
  assert.equal(await code({ target: agentRef("p", "nosuch") }, "v2"), "no_target");
  const treeOid = k.mirrorGit("rev-parse", `${k.root}^{tree}`);
  k.mirrorGit("update-ref", agentRef("c", "tree"), treeOid);
  assert.equal(await code({ source: agentRef("c", "tree") }, "v3"), "no_source"); // a tree is not a commit
  assert.equal(await code({ expectSource: "f".repeat(40) }, "v4"), "stale_source");
  assert.equal(await code({ expectSource: "abc" }, "v5"), "bad_revision");
  assert.equal(await code({ source: agentRef("d") }, "v6"), "bad_ref"); // another agent's namespace
  assert.equal(await code({ target: agentRef("d") }, "v7"), "bad_ref"); // not the caller's branch
  assert.equal(await code({ source: "--output=/tmp/x" }, "v8"), "bad_ref");
  assert.equal(await code({ source: agentRef("c", "-x") }, "v9"), "bad_ref");
  assert.equal(await code({ child: "p" }, "v10"), "bad_ref");
  assert.equal(await code({ repo: "other" }, "v11"), "bad_ref");
  assert.equal(await code({ target: "refs/tags/v1" }, "v12"), "bad_ref");
  assert.equal(k.ref(agentRef("p")), B);
  await assert.rejects(() => store.merge(k.request({ callerGeneration: 7 }), "v13"), StaleGenerationError);
});

test("unrelated histories are refused", { skip }, async () => {
  const { k, store } = await world();
  k.setupGit("checkout", "-q", "--orphan", "other");
  writeFileSync(join(k.work, "o.txt"), "o\n");
  k.setupGit("add", "o.txt");
  k.setupGit("commit", "-qm", "orphan");
  k.put(agentRef("c"), k.setupGit("rev-parse", "HEAD"));
  assert.equal(((await store.merge(k.request(), "un1")) as { code?: string }).code, "unrelated_history");
});

test("concurrent merges into one target are serialized: no lost update", { skip }, async () => {
  const { k, store } = await world();
  const ids = ["c", "d"];
  for (const id of ids) k.put(agentRef(id), k.commit(k.root, { [`${id}.txt`]: `${id}\n` }));
  const out = await Promise.all(ids.map((id) => store.merge(k.request({ child: id, source: agentRef(id) }), `cc-${id}`)));
  for (const r of out) assert.equal(r.status, "merged", JSON.stringify(r));
  const tip = k.ref(agentRef("p"))!;
  for (const id of ids) assert.equal(show(k, tip, `${id}.txt`), id);
  assert.equal(k.mirrorGit("rev-list", "--count", `${k.root}..${tip}`), "4"); // two children, two merge commits
});

// merge-lock: two OS processes (no shared in-process lock) race the compare-and-swap with candidates built on the
// same target tip. The CAS loser sees the target moved and retries from the top (or reports `moved` when it has
// no attempts left); either way the winner's merge is never overwritten.
async function race(k: Kit, maxAttempts: number): Promise<MergeResult[]> {
  const barrier = join(k.base, `barrier-${maxAttempts}`);
  mkdirSync(barrier);
  const run = (child: string) =>
    new Promise<MergeResult>((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [join(import.meta.dirname, "merge-race-child.ts"), k.mirror, join(k.base, `tmp-${child}`), child, barrier, String(maxAttempts)],
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 90_000,
        },
      );
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.stderr.on("data", (d) => {
        err += d;
      });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as MergeResult) : reject(new Error(`race child ${child} exited ${code}: ${err}`))));
    });
  return Promise.all([run("c"), run("d")]);
}

test("merge-lock: across two processes the ref compare-and-swap admits exactly one move per target tip; the loser reports `moved`", { skip }, async () => {
  const k = kit();
  for (const id of ["c", "d"]) k.put(agentRef(id), k.commit(k.root, { [`${id}.txt`]: `${id}\n` }));
  const out = await race(k, 1);
  const win = out.find((r) => r.status === "merged");
  const lose = out.find((r) => r.status === "moved");
  assert.ok(win && lose, JSON.stringify(out));
  const w = merged(win);
  assert.equal(w.base, k.root);
  assert.equal(k.ref(agentRef("p")), w.commit); // the loser never overwrote the winner
  assert.equal((lose as Extract<MergeResult, { status: "moved" }>).targetTip, w.commit);
  assert.deepEqual(parents(k, w.commit), [k.root, w.source]);
});

test("merge-lock: across two processes the CAS loser retries on the winner's tip, so both land with no lost update", { skip }, async () => {
  const k = kit();
  for (const id of ["c", "d"]) k.put(agentRef(id), k.commit(k.root, { [`${id}.txt`]: `${id}\n` }));
  const out = (await race(k, 3)).map(merged);
  const tip = k.ref(agentRef("p"))!;
  const [first, second] = out[0]!.base === k.root ? [out[0]!, out[1]!] : [out[1]!, out[0]!];
  assert.equal(first.base, k.root);
  assert.equal(second.base, first.commit); // rebuilt on the winner's move, not on the stale tip
  assert.equal(tip, second.commit);
  for (const id of ["c", "d"]) assert.equal(show(k, tip, `${id}.txt`), id);
});

test("mergeStatus: empty child, unmerged work, and new work after a merge; commitInSubtree is scoped", { skip }, async () => {
  const { k, store } = await world();
  const q = { child: "d", target: agentRef("p") };
  assert.deepEqual(await store.mergeStatus(q), { state: "empty", merged: false, failedRounds: 0, settled: true });
  const T = k.commit(k.root, { "c.txt": "c\n" });
  k.put(agentRef("c"), T);
  assert.deepEqual(await store.mergeStatus({ child: "c", target: agentRef("p") }), { state: "none", merged: false, failedRounds: 0, settled: false });
  merged(await store.merge(k.request(), "ms1"));
  const T2 = k.commit(T, { "c2.txt": "c2\n" });
  k.put(agentRef("c"), T2);
  assert.deepEqual(await store.mergeStatus({ child: "c", target: agentRef("p") }), { state: "none", merged: false, failedRounds: 0, settled: false });
  // scoped --from-commit
  assert.equal(await store.commitInSubtree(T2, ["c"]), T2);
  assert.equal(await store.commitInSubtree(T2.slice(0, 10), ["c", "d"]), T2);
  assert.equal(await store.commitInSubtree(T2, ["d"]), null); // not in d's heads
  assert.equal(await store.commitInSubtree(T2, []), null);
  assert.equal(await store.commitInSubtree("--all", ["c"]), null);
  assert.equal(await store.commitInSubtree("f".repeat(40), ["c"]), null);
  assert.equal(await store.commitInSubtree(T2, ["../c"]), null);
});

test("the engine appends no foreign refs and leaves other agents' refs alone", { skip }, async () => {
  const { k, store } = await world();
  k.put(agentRef("d"), k.commit(k.root, { "d.txt": "d\n" }));
  const before = k.mirrorGit("for-each-ref", "--format=%(refname) %(objectname)", "refs/agents/d", "refs/heads");
  k.put(agentRef("c"), k.commit(k.root, { "c.txt": "c\n" }));
  merged(await store.merge(k.request(), "iso"));
  assert.equal(k.mirrorGit("for-each-ref", "--format=%(refname) %(objectname)", "refs/agents/d", "refs/heads"), before);
});
