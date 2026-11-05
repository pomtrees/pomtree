import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DEFAULT_DENIED_PATHS, pathDenied } from "@pomtree/core";
import type { MergeResult, Repo } from "@pomtree/core";
import { createFakes } from "@pomtree/testing";
import { evaluateGitVersion } from "./git-env.ts";
import { GitRepoStore } from "./repo-store.ts";
import { agentRef, kit, type Kit } from "./repo-kit.ts";

const gv = evaluateGitVersion(execFileSync("git", ["--version"]).toString());
const skip: string | false = gv.warning ? `needs git >= 2.38 (found ${gv.version ?? "unknown"})` : false;
const SPEC = { image: "i", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "none" as const } };

async function world(policy: Repo["policy"], redact?: (s: string) => string) {
  const k = kit();
  const f = createFakes();
  await f.registry.create({ id: "p", parent: null, name: "p", task: "t", host: "h", budgetMicros: 1, spec: SPEC, idempotencyKey: "mk-p" });
  const store = new GitRepoStore({
    mirrorDir: k.mirror,
    repo: { id: "repo-1", name: "r", defaultBranch: "main", policy },
    host: "h",
    merges: f.merges,
    checks: f.checks,
    tmpRoot: `${k.base}/tmp`,
    ...(redact && { redact }),
  });
  return { k, f, store };
}
const codeOf = (r: MergeResult) => (r as { code?: string }).code;
const NODENY: Repo["policy"] = { check: null }; // undefined deniedPaths: DEFAULT_DENIED_PATHS

test("a rename on the target side cannot smuggle an edit into a denied path (policy judges the landing diff)", { skip }, async () => {
  const { k, store } = await world(NODENY);
  const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const R = k.commit(k.root, { a: content });
  // B renames a -> .github/workflows/ci.yml; T edits a. The source-side diff (base..T) only shows `a`.
  const B = k.commit(R, { a: null, ".github/workflows/ci.yml": content });
  const T = k.commit(R, { a: content.replace("line 20", "line 20 EVIL") });
  k.put(agentRef("p"), B);
  k.put(agentRef("c"), T);
  const r = await store.merge(k.request(), "ren1");
  assert.deepEqual([r.status, codeOf(r)], ["policy_rejected", "denied_path"]);
  assert.equal(k.ref(agentRef("p")), B);
});

test("deletions, case variants and the default list are enforced on what lands", { skip }, async () => {
  const { k, store } = await world(NODENY);
  // the target already holds a workflow; the child deletes it
  const B = k.commit(k.root, { ".github/workflows/ci.yml": "on: push\n", "x.txt": "x\n" });
  k.put(agentRef("p"), B);
  const del = k.commit(B, { ".github/workflows/ci.yml": null });
  k.put(agentRef("c"), del);
  const rd = await store.merge(k.request(), "del1");
  assert.deepEqual([rd.status, codeOf(rd)], ["policy_rejected", "denied_path"]);
  assert.equal(k.ref(agentRef("p")), B);
  // case variant of a denied prefix
  k.put(agentRef("c"), k.commit(k.root, { ".GitHub/Workflows/ci.yml": "on: push\n" }));
  assert.equal(codeOf(await store.merge(k.request(), "case1")), "denied_path");
  k.put(agentRef("c"), k.commit(k.root, { ".github/actions/x/action.yml": "a\n" }));
  assert.equal(codeOf(await store.merge(k.request(), "act1")), "denied_path");
  assert.equal(k.ref(agentRef("p")), B);
  // an explicit empty list disables the denylist
  const open = await world({ deniedPaths: [], check: null });
  open.k.put(agentRef("c"), open.k.commit(open.k.root, { ".github/workflows/ci.yml": "on: push\n" }));
  assert.equal((await open.store.merge(open.k.request(), "open1")).status, "merged");
});

test("a mode/type change to a denied path is rejected", { skip }, async () => {
  const { k, store } = await world({ deniedPaths: ["scripts/"], check: null });
  const B = k.commit(k.root, { "scripts/run.sh": "echo\n", "other.txt": "o\n" });
  k.put(agentRef("p"), B);
  k.setupGit("checkout", "-q", "--detach", "--force", B);
  k.setupGit("update-index", "--chmod=+x", "scripts/run.sh");
  k.setupGit("commit", "-qm", "chmod");
  k.put(agentRef("c"), k.setupGit("rev-parse", "HEAD"));
  assert.equal(codeOf(await store.merge(k.request(), "mode1")), "denied_path");
  assert.equal(k.ref(agentRef("p")), B);
});

test("pathDenied: case-insensitive, NFC-normalized, component-wise; DEFAULT_DENIED_PATHS shape", () => {
  assert.deepEqual([...DEFAULT_DENIED_PATHS], [".github/workflows/", ".github/actions/", ".gitmodules"]);
  assert.ok(pathDenied(".GITHUB/Workflows/ci.yml", DEFAULT_DENIED_PATHS));
  assert.ok(pathDenied(".GitModules", DEFAULT_DENIED_PATHS));
  assert.equal(pathDenied(".github/other.md", DEFAULT_DENIED_PATHS), null);
  assert.ok(pathDenied("café/x", ["café/"])); // decomposed prefix vs composed path
  assert.ok(pathDenied("café/x", ["café"]));
  assert.equal(pathDenied(".githubx/workflows/a", DEFAULT_DENIED_PATHS), null);
});

test("F4a: an idempotency key reused with a different request is rejected as key_reuse and never replays", { skip }, async () => {
  const { k, store, f } = await world({ deniedPaths: [], check: null });
  k.put(agentRef("c"), k.commit(k.root, { "c.txt": "c\n" }));
  k.put(agentRef("d"), k.commit(k.root, { "d.txt": "d\n" }));
  const first = await store.merge(k.request(), "reuse");
  assert.equal(first.status, "merged");
  const other = await store.merge(k.request({ child: "d", source: agentRef("d") }), "reuse");
  assert.deepEqual([other.status, codeOf(other)], ["policy_rejected", "key_reuse"]);
  assert.deepEqual(await store.merge(k.request(), "reuse"), first); // the genuine replay still works
  assert.equal((await f.merges.list({ child: "d" })).length, 0); // nothing recorded for d
  assert.ok(!k.mirrorGit("ls-tree", "-r", "--name-only", agentRef("p")).split("\n").includes("d.txt")); // and nothing merged
});

test("check summaries are redacted before they reach the result or the merges table", { skip }, async () => {
  const { k, store, f } = await world({ deniedPaths: [], check: ["make"] }, (s) => s.replaceAll("sk-secret", "[redacted]"));
  k.put(agentRef("c"), k.commit(k.root, { "c.txt": "c\n" }));
  f.hooks.raw.checks.results.push({ ok: false, summary: "failed with token sk-secret" });
  const r = await store.merge(k.request(), "red1");
  assert.equal((r as { summary?: string }).summary, "failed with token [redacted]");
  assert.ok(!JSON.stringify(await f.merges.list()).includes("sk-secret"));
});
