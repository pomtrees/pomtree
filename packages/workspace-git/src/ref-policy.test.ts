import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentBranchOf,
  checkBundleRefs,
  checkEntry,
  checkSymlinkTarget,
  hasRefClash,
  isDotGit,
  isDotGitmodules,
  mapToAgentRef,
  parseRawZ,
  validAgentId,
  validBranchName,
} from "./ref-policy.ts";
import { buildGitInvocation, evaluateGitVersion, MIN_SAFE_GIT } from "./git-env.ts";
import { parseBundleHead } from "./bundle.ts";

test("validBranchName follows check-ref-format and rejects HEAD", () => {
  for (const ok of ["main", "agent/a1", "feat/x-y_z.1", "a@b"]) assert.equal(validBranchName(ok), true, ok);
  for (const bad of [
    "",
    "HEAD",
    "@",
    "a..b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "/a",
    "a/",
    "a//b",
    ".a",
    "a/.b",
    "a.lock",
    "a/b.lock",
    "a.",
    "a@{x",
    "-a",
    "é",
    "a\tb",
    "x".repeat(201),
  ]) {
    assert.equal(validBranchName(bad), false, JSON.stringify(bad));
  }
});

test("validAgentId rejects separators, traversal, option-like and ref-special ids", () => {
  for (const ok of ["a1", "agent-7", "x_y.z"]) assert.equal(validAgentId(ok), true, ok);
  for (const bad of ["", "a/b", "a\\b", "a\0b", "..", "a..b", "-x", ".x", "a b", "a:b", "a.lock"]) assert.equal(validAgentId(bad), false, JSON.stringify(bad));
});

test("namespace mapping maps refs/heads/x to refs/agents/<id>/heads/x and nothing else", () => {
  assert.equal(mapToAgentRef("a1", "refs/heads/agent/a1"), "refs/agents/a1/heads/agent/a1");
  for (const r of ["HEAD", "refs/tags/v1", "refs/agents/b/heads/x", "refs/heads/", "refs/heads/a..b", "refs/remotes/o/x", "heads/x"])
    assert.equal(mapToAgentRef("a1", r), null, r);
  assert.equal(agentBranchOf("a1", "refs/agents/a1/heads/x/y"), "x/y");
  assert.equal(agentBranchOf("a1", "refs/agents/a2/heads/x"), null);
  assert.equal(agentBranchOf("a1", "refs/agents/a1/heads/a..b"), null);
});

test("ref clash: a name that is a directory prefix of another is rejected", () => {
  assert.equal(hasRefClash(["a", "b", "c/d"]), null);
  assert.equal(hasRefClash(["a", "a/b"]), "a/b");
});

test("checkBundleRefs ignores HEAD, accepts heads, rejects tags/odd names/clashes/empty", () => {
  assert.deepEqual(checkBundleRefs(["HEAD", "refs/heads/agent/a"]), { branches: ["agent/a"] });
  for (const refs of [["refs/tags/v1"], ["refs/heads/a..b"], ["refs/agents/x/heads/y"], ["HEAD"], []]) {
    const r = checkBundleRefs(refs);
    assert.equal("code" in r && r.code, "bad_ref", JSON.stringify(refs));
  }
  const clash = checkBundleRefs(["refs/heads/a/b"], ["a"]);
  assert.equal("code" in clash && clash.code, "bad_ref");
});

test("isDotGit catches case, NTFS, HFS and 8.3 variants; isDotGitmodules likewise", () => {
  for (const c of [".git", ".GIT", ".Git", ".git ", ".git.", ".git...", "git~1", "GIT~2", ".g\u200cit", ".git::$INDEX_ALLOCATION", ".git\u200d"])
    assert.equal(isDotGit(c), true, JSON.stringify(c));
  for (const c of [".gitignore", ".github", "git", "x.git", ".gitattributes", "gitx"]) assert.equal(isDotGit(c), false, c);
  for (const c of [".gitmodules", ".GITMODULES", ".gitmodules ", "gitmod~1"]) assert.equal(isDotGitmodules(c), true, c);
});

test("checkEntry: .git components, dot components, gitlinks, .gitmodules, odd modes", () => {
  assert.equal(checkEntry({ mode: "100644", path: "src/a.ts" }), null);
  assert.equal(checkEntry({ mode: "100755", path: ".github/run.sh" }), null);
  assert.equal(checkEntry({ mode: "120000", path: "link" }), null);
  for (const p of [".git/config", "a/.git/hooks/x", "a/.GIT/x", "a\\.git\\x", ".git", "a//b", "a/../b", "./a"])
    assert.equal(checkEntry({ mode: "100644", path: p })?.code, "unsafe_path", p);
  assert.equal(checkEntry({ mode: "160000", path: "sub" })?.code, "submodule");
  assert.equal(checkEntry({ mode: "100644", path: "x/.gitmodules" })?.code, "submodule");
  assert.equal(checkEntry({ mode: "100664", path: "a" })?.code, "unsafe_path");
});

test("checkSymlinkTarget: inside the tree is fine; absolute, escaping and .git targets are not", () => {
  assert.equal(checkSymlinkTarget("a", "b"), null);
  assert.equal(checkSymlinkTarget("d/a", "../b"), null);
  assert.equal(checkSymlinkTarget("d/e/a", "../../b/c"), null);
  for (const [path, target] of [
    ["a", "/etc/passwd"],
    ["a", "C:/x"],
    ["a", "../x"],
    ["d/a", "../../x"],
    ["a", ".git"],
    ["a", "sub/.git/config"],
    ["a", "x/.GIT"],
    ["a", ""],
    ["d/a", "x/../../../y"],
  ] as const) {
    assert.equal(checkSymlinkTarget(path, target)?.code, "symlink", `${path} -> ${target}`);
  }
});

test("parseRawZ reads added/modified entries and skips deletions", () => {
  const z = "\0";
  const out =
    [
      `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M`,
      "x/y",
      `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D`,
      "gone",
      `:000000 120000 ${"0".repeat(40)} ${"c".repeat(40)} A`,
      "l",
    ].join(z) + z;
  assert.deepEqual(parseRawZ(out), [
    { mode: "100644", oid: "b".repeat(40), path: "x/y" },
    { mode: "120000", oid: "c".repeat(40), path: "l" },
  ]);
});

test("buildGitInvocation hardens every call and inherits nothing", () => {
  const inv = buildGitInvocation(["status"], { path: "/usr/bin", tmpdir: "/t" });
  assert.equal(inv.args[0], "--no-replace-objects");
  assert.equal(inv.args.at(-1), "status");
  const cfg = inv.args.filter((_, i) => inv.args[i - 1] === "-c");
  for (const want of [
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "protocol.file.allow=always",
    "protocol.ext.allow=never",
    "core.attributesFile=/dev/null",
  ])
    assert.ok(cfg.includes(want), want);
  assert.equal(inv.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(inv.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(inv.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(inv.env.GIT_ATTR_NOSYSTEM, "1");
  assert.equal(inv.env.GIT_NO_REPLACE_OBJECTS, "1");
  // Global env never disables lazy fetch: operator-side fetches (refreshMirror) from a promisor repo must work.
  assert.equal(inv.env.GIT_NO_LAZY_FETCH, undefined);
  assert.equal(buildGitInvocation(["fetch"], { path: "/p" }, { noLazyFetch: true }).env.GIT_NO_LAZY_FETCH, "1");
  assert.match(inv.args.join(" "), /core\.commitGraph=false/);
  assert.match(inv.args.join(" "), /core\.multiPackIndex=false/);
  assert.equal(inv.env.TMPDIR, "/t");
  assert.deepEqual(
    Object.keys(inv.env).filter((k) => !/^(PATH|LANG|LC_ALL|TMPDIR|GIT_)/.test(k)),
    [],
  );
  assert.equal(
    buildGitInvocation(["push"], { path: "/p" }, { trustOperatorConfig: true, passthrough: { HOME: "/h", X: undefined } }).env.GIT_CONFIG_GLOBAL,
    undefined,
  );
  assert.throws(() => buildGitInvocation(["x"], { path: "/p" }, { config: ["core.hooksPath=/tmp/h"] }), /fixed by the hardened/);
});

test("evaluateGitVersion enforces 2.38", () => {
  assert.deepEqual(MIN_SAFE_GIT, [2, 38, 0]);
  assert.equal(evaluateGitVersion("git version 2.54.0 (Apple Git-157)").warning, null);
  assert.equal(evaluateGitVersion("git version 2.38.0").warning, null);
  assert.match(evaluateGitVersion("git version 2.34.1").warning ?? "", /older than 2\.38\.0/);
  assert.match(evaluateGitVersion("nonsense").warning ?? "", /could not be determined/);
});

test("parseBundleHead reads prerequisites, refs and object count; rejects junk", () => {
  const pack = Buffer.concat([Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.from([0, 0, 0, 7])]);
  const text = `# v2 git bundle\n-${"a".repeat(40)} subject\n${"b".repeat(40)} refs/heads/x\n\n`;
  const r = parseBundleHead(Buffer.concat([Buffer.from(text), pack]));
  assert.ok(r.ok);
  if (r.ok)
    assert.deepEqual([r.header.prerequisites, r.header.refs, r.header.objectCount], [["a".repeat(40)], [{ oid: "b".repeat(40), name: "refs/heads/x" }], 7]);
  assert.equal(parseBundleHead(Buffer.from("hello")).ok, false);
  assert.equal(parseBundleHead(Buffer.from(`# v2 git bundle\n${"b".repeat(40)} refs/heads/x\n\nXXXX`)).ok, false);
  assert.equal(parseBundleHead(Buffer.concat([Buffer.from(`# v3 git bundle\n@object-format=sha256\n\n`), pack])).ok, false);
  assert.equal(parseBundleHead(Buffer.concat([Buffer.from(`# v3 git bundle\n@filter=blob:none\n\n`), pack])).ok, false);
});
