import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_MARK, describeFindings, isCiPath, scanDiff, scanLine, scanMessages } from "./publish-scan.ts";

// Every token is assembled at runtime from fragments and fake filler, so no credential-shaped literal sits in this file.
const rep = (s: string, n: number) => s.repeat(n);
const mixed = (n: number) => rep("aB3", Math.ceil(n / 3)).slice(0, n);
const upper = (n: number) => rep("Q7", Math.ceil(n / 2)).slice(0, n);
const hex = (n: number) => rep("4f7a", Math.ceil(n / 4)).slice(0, n);
const POSITIVES: Record<string, string> = {
  "private key header": `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`,
  "AWS access key id": `${"AK"}${"IA"}${upper(16)}`,
  "GitHub token": `${"gh"}${"p_"}${mixed(36)}`,
  "GitLab token": `${"glp"}${"at-"}${mixed(20)}`,
  "Slack token": `${"xo"}${"xb-"}1234567890-${mixed(24)}`,
  "Slack webhook URL": `https://hooks.${"slack"}.com/services/T${upper(9)}/B${upper(9)}/${mixed(24)}`,
  "Stripe live key": `${"sk"}_${"live"}_${mixed(24)}`,
  "Anthropic API key": `${"sk-"}${"ant-"}api03-${mixed(90)}`,
  "OpenAI API key": `${"sk-"}${"proj-"}${mixed(48)}`,
  "Google API key": `${"AI"}${"za"}${mixed(35)}`,
  "Authorization bearer literal": `Authorization: Bearer ${mixed(40)}`,
};

test("each high-confidence credential shape is detected under its own rule", () => {
  for (const [rule, token] of Object.entries(POSITIVES)) {
    assert.equal(scanLine(`const x = "${token}";`), rule, rule);
    assert.equal(scanLine(token), rule, `${rule} bare`);
  }
  assert.equal(scanLine(`-----BEGIN RSA PRIVATE KEY-----`), "private key header");
  assert.equal(scanLine(`-----BEGIN PRIVATE KEY-----`), "private key header");
  assert.equal(scanLine(`-----BEGIN PGP PRIVATE KEY BLOCK-----`), "private key header");
  assert.equal(scanLine(`sk-${mixed(20)}T3BlbkFJ${mixed(20)}`), "OpenAI API key");
  assert.equal(scanLine(`sk-${mixed(48)}`), "OpenAI API key");
  assert.equal(scanLine(`  "authorization": "bearer ${mixed(30)}"`), "Authorization bearer literal");
  assert.equal(scanLine(`${"gh"}${"s_"}${mixed(40)}`), "GitHub token");
  assert.equal(scanLine(`${"github_"}${"pat_"}${mixed(60)}`), "GitHub token");
});

test("ordinary code, prose, placeholders and documented examples do not match", () => {
  const benign = [
    "-----BEGIN CERTIFICATE-----",
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN PRIVATE-----",
    "grep PRIVATE KEY file",
    `${"AK"}${"IA"}IOSFODNN7EXAMPLE`, // AWS's documented example id
    `${"AK"}${"IA"}SHORT`,
    `const k = ${"gh"}${"p_"}tooshort`,
    `${"sk"}_${"test"}_${mixed(30)}`, // test-mode key cannot move money
    `task-${mixed(48)}`, // `sk-` inside a word
    "sk-learn is a library",
    `${"sk-"}${"ant-"}short`,
    `Authorization: Bearer ${"$"}{token}`,
    "Authorization: Bearer <your-token-here>",
    `Authorization: Bearer ${rep("x", 40)}`,
    `Authorization: Bearer ${rep("A", 40)}`,
    `headers.Authorization = \`Bearer ${"$"}{await getToken()}\``,
    "Authorization: Bearer abc",
    "const AIzaSyShort = 1;",
    "import { hooks } from 'slack/services'",
    "x".repeat(5000),
    "",
  ];
  for (const line of benign) assert.equal(scanLine(line), undefined, line.slice(0, 60));
});

test("a long minified line scans quickly (bounded patterns)", () => {
  const t = Date.now();
  assert.equal(scanLine(`${rep("sk-", 50_000)}${rep("Authorization: Bearer ", 3_000)}`), undefined);
  assert.ok(Date.now() - t < 2000);
});

test("CI and workflow files across common hosts", () => {
  for (const p of [
    ".github/workflows/ci.yml",
    ".GitHub/Workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".gitea/workflows/a.yml",
    ".circleci/config.yml",
    ".gitlab-ci.yml",
    ".gitlab/ci/build.yml",
    ".travis.yml",
    ".drone.yml",
    "azure-pipelines.yml",
    "azure-pipelines.ci.yaml",
    "bitbucket-pipelines.yml",
    ".buildkite/pipeline.yml",
    "Jenkinsfile",
    "sub/Jenkinsfile.release",
    "cloudbuild.yaml",
  ])
    assert.equal(isCiPath(p), true, p);
  for (const p of ["README.md", "src/ci.ts", ".github/CODEOWNERS", ".github/ISSUE_TEMPLATE/bug.md", "docs/.github/workflows-notes.md", "jenkinsfile-notes.md"])
    assert.equal(isCiPath(p), false, p);
});

const sha = (c: string) => c.repeat(40);
const stream = (...parts: string[]) => parts.join("\n");
const fileDiff = (path: string, hunks: string, oldPath = path) =>
  `diff --git a/${oldPath} b/${path}\nindex 1111111..2222222 100644\n--- a/${oldPath}\n+++ b/${path}\n${hunks}`;

test("scanDiff reports commit, path, new-file line and rule from added lines only", () => {
  const token = POSITIVES["GitHub token"] as string;
  const diff = stream(
    `${COMMIT_MARK}${sha("a")}`,
    "",
    fileDiff("src/a.ts", `@@ -3,2 +3,3 @@\n context\n-old ${token}\n+new line\n+const t = "${token}";\n`),
    `${COMMIT_MARK}${sha("b")}`,
    "",
    fileDiff("keys/new.txt", `@@ -0,0 +1,2 @@\n+fine\n+${POSITIVES["AWS access key id"]}\n`).replace("--- a/keys/new.txt", "--- /dev/null"),
  );
  assert.deepEqual(scanDiff(diff), [
    { commit: sha("a"), path: "src/a.ts", line: 5, rule: "GitHub token" },
    { commit: sha("b"), path: "keys/new.txt", line: 2, rule: "AWS access key id" },
  ]);
});

test("removed lines and context lines never count; deletions of a secret pass", () => {
  const token = POSITIVES["Anthropic API key"] as string;
  const diff = stream(
    `${COMMIT_MARK}${sha("c")}`,
    "",
    fileDiff("a.txt", `@@ -1,3 +1,2 @@\n ${token}\n-${token}\n+ok\n`),
    fileDiff("gone.txt", `@@ -1 +0,0 @@\n-${token}\n`).replace("+++ b/gone.txt", "+++ /dev/null"),
  );
  assert.deepEqual(scanDiff(diff), []);
});

test("an added line that looks like diff structure is data, not structure", () => {
  const token = POSITIVES["GitLab token"] as string;
  // `+++ b/.github/...` and a commit marker as ADDED content must not retarget the path, nor hide the next added line
  const diff = stream(`${COMMIT_MARK}${sha("d")}`, "", fileDiff("notes.txt", `@@ -0,0 +1,3 @@\n+++ b/other.txt\n+${COMMIT_MARK}${sha("f")}\n+${token}\n`));
  assert.deepEqual(scanDiff(diff), [{ commit: sha("d"), path: "notes.txt", line: 3, rule: "GitLab token" }]);
});

test("added content in a CI file is a finding (once per file); a pure deletion or other file is not", () => {
  const diff = stream(
    `${COMMIT_MARK}${sha("e")}`,
    "",
    fileDiff(".github/workflows/ci.yml", `@@ -1 +1,2 @@\n name: x\n+run: ls\n@@ -9,0 +11 @@\n+more\n`),
    fileDiff(".gitlab-ci.yml", `@@ -1,2 +0,0 @@\n-a\n-b\n`),
    fileDiff("src/x.ts", `@@ -0,0 +1 @@\n+y\n`),
  );
  assert.deepEqual(scanDiff(diff), [{ commit: sha("e"), path: ".github/workflows/ci.yml", line: 0, rule: "workflow/CI file change" }]);
});

test("quoted paths are unquoted; identical findings from each merge parent are deduplicated", () => {
  const token = POSITIVES["Stripe live key"] as string;
  const d = `diff --git "a/q" "b/q"\n--- /dev/null\n+++ "b/we\\"ird \\303\\251.txt"\n@@ -0,0 +1 @@\n+${token}\n`;
  const diff = stream(`${COMMIT_MARK}${sha("1")}`, "", d, `${COMMIT_MARK}${sha("1")}`, "", d);
  assert.deepEqual(scanDiff(diff), [{ commit: sha("1"), path: 'we"ird é.txt', line: 1, rule: "Stripe live key" }]);
});

test("describeFindings names commit, file, line and rule and caps the list; it never carries content", () => {
  const f = (i: number) => ({ commit: sha("9"), path: `f${i}.txt`, line: i, rule: "GitHub token" });
  const text = describeFindings([f(1), f(2), f(3), f(4), f(5), f(6), f(7)]);
  assert.match(text, /GitHub token in commit 999999999999 file f1\.txt line 1;/);
  assert.match(text, /\(\+2 more\)$/);
  assert.equal(
    describeFindings([{ commit: sha("9"), path: "a\nb\x00.txt", line: 0, rule: "workflow/CI file change" }]),
    "workflow/CI file change in commit 999999999999 file a?b?.txt",
  );
});

test("new credential shapes: DeepSeek, OpenRouter, Discord bot, Telegram bot, JWT and URL userinfo", () => {
  const cases: [string, string][] = [
    ["DeepSeek API key", `${"sk-"}${hex(32)}`],
    ["OpenRouter API key", `${"sk-or-v1-"}${hex(64)}`],
    ["Discord bot token", `M${"aB3".repeat(8)}.${"Ab3-_x"}.${mixed(27)}`],
    ["Telegram bot token", `123456789:${mixed(35)}`],
    ["JWT", `${"eyJ"}${mixed(20)}.${mixed(20)}.${mixed(20)}`],
    ["URL credentials", `https://svc:${mixed(12)}@db.example.com/x`],
  ];
  for (const [rule, token] of cases) {
    assert.equal(scanLine(`const t = "${token}";`), rule, rule);
  }
});

test("new credential shapes do not match near misses, placeholders or each other's shapes", () => {
  const benign = [
    `task-${hex(32)}`, // `sk-` inside a word
    `sk-${hex(33)}`, // one hex digit too long
    `sk-${hex(31)}`, // one hex digit too short
    `sk-or-v1-${hex(63)}`, // OpenRouter one digit short
    hex(40), // a git sha
    `M${"aB3".repeat(3)}.${"Ab3-_x"}.${mixed(27)}`, // Discord first segment too short
    `1234567:${mixed(35)}`, // Telegram id too short
    `123456789:${mixed(34)}`, // Telegram secret too short
    `eyJshort.${mixed(20)}.${mixed(20)}`, // JWT first segment too short
    `https://user:${"$"}{DB_PASSWORD}@host.example.com`, // placeholder reference
    "https://user@host.example.com/path", // no password
    "https://host.example.com:8080/path", // no userinfo
    "git@github.com:org/repo.git", // scp-style remote, no scheme
  ];
  for (const line of benign) assert.equal(scanLine(line), undefined, line.slice(0, 60));
  // the DeepSeek key is one rule name, not also the OpenAI shape
  assert.equal(scanLine(`${"sk-"}${hex(32)}`), "DeepSeek API key");
});

test("GitHub token: a trailing underscore does not let a token past the lookahead", () => {
  const tok = `${"gh"}${"p_"}${mixed(36)}`;
  assert.equal(scanLine(`${tok}_`), "GitHub token");
  assert.equal(scanLine(`${tok}x`), "GitHub token"); // the token body is not cut short by a letter either way
  assert.equal(scanLine(`${"gh"}${"p_"}${mixed(35)}`), undefined); // 35 is one short
});

test("a placeholder earlier on the line does not hide a real secret of the same rule", () => {
  const realAws = `${"AK"}${"IA"}${upper(16)}`;
  assert.equal(scanLine(`${"AK"}${"IA"}IOSFODNN7EXAMPLE ${realAws}`), "AWS access key id");
  assert.equal(scanLine(`${realAws} ${"AK"}${"IA"}IOSFODNN7EXAMPLE`), "AWS access key id");
  assert.equal(scanLine(`${"AK"}${"IA"}IOSFODNN7EXAMPLE and ${"AK"}${"IA"}IOSFODNN7EXAMPLE`), undefined);
  assert.equal(scanLine(`Authorization: Bearer ${rep("x", 24)} Authorization: Bearer ${mixed(40)}`), "Authorization bearer literal");
  assert.equal(scanLine(`${"gh"}${"p_"}${mixed(36)} then ${"gh"}${"p_"}${mixed(36)}`), "GitHub token");
});

test("bearer placeholders: only a WHOLE-value placeholder is ignored; padding a placeholder into a real value is not", () => {
  assert.equal(scanLine(`Authorization: Bearer ${rep("x", 40)}`), undefined);
  assert.equal(scanLine(`Authorization: Bearer YOUR_TOKEN_PLACEHOLDER_VALUE_HERE`), undefined);
  assert.equal(scanLine(`Authorization: Bearer ${rep("Z", 30)}`), undefined);
  assert.equal(scanLine(`Authorization: Bearer ${rep("x", 24)}${mixed(30)}`), "Authorization bearer literal");
  assert.equal(scanLine(`Authorization: Bearer ${mixed(30)}xxxxxxxx`), "Authorization bearer literal");
});

test("scanMessages: commit message and author/committer lines are scanned, reporting line and commit only", () => {
  const tok = POSITIVES["GitHub token"] as string;
  const log = [sha("e"), "dev <dev@example.com>", "dev <dev@example.com>", `subject\nnote ${tok}\n`, ""].join("\0");
  assert.deepEqual(scanMessages(log), [{ commit: sha("e"), path: "", line: 2, rule: "GitHub token", where: "commit message" }]);
  const author = [sha("f"), `dev ${tok} <dev@example.com>`, "dev <dev@example.com>", "clean\n", ""].join("\0");
  assert.deepEqual(scanMessages(author), [{ commit: sha("f"), path: "", line: 0, rule: "GitHub token", where: "author or committer" }]);
  assert.deepEqual(scanMessages([sha("g"), "a <a@x>", "a <a@x>", "fine\n", ""].join("\0")), []);
});

test("scanDiff: a pure deletion of a workflow file is not an addition", () => {
  assert.deepEqual(scanDiff(stream(`${COMMIT_MARK}${sha("h")}`, "", fileDiff(".github/workflows/ci.yml", "@@ -1,2 +0,0 @@\n-a\n-b\n"))), []);
});

test("CI paths added in this release: woodpecker, cirrus, appveyor, semaphore, bitrise, dependabot", () => {
  for (const p of [
    ".woodpecker/build.yml",
    ".woodpecker.yml",
    ".woodpecker.yaml",
    ".cirrus.yml",
    "appveyor.yml",
    ".appveyor.yml",
    ".semaphore/semaphore.yml",
    "bitrise.yml",
    ".github/dependabot.yml",
  ])
    assert.equal(isCiPath(p), true, p);
  for (const p of ["docs/appveyor.yml.md", "sub/bitrise.yml", "woodpecker.yml"]) assert.equal(isCiPath(p), false, p);
});

test("describeFindings caps a hostile long filename after sanitizing it", () => {
  const text = describeFindings([{ commit: sha("9"), path: `${"d\n/".repeat(100)}é.txt`, line: 0, rule: "workflow/CI file change" }]);
  assert.doesNotMatch(text, /[^\x20-\x7e]/); // printable ASCII only: no newline, NUL or non-ASCII survives
  const file = text.slice(text.lastIndexOf("file ") + 5);
  assert.ok(file.length <= 120, `file part is ${file.length} chars`);
  assert.match(file, /\.\.\.$/);
});

// Adversarial lines, each 800 KB: the rule's own character class, repeated near-prefixes and separators, and long runs after
// a prefix. Typical cost is single-digit ms. The 1000 ms bound is generous on purpose (a loaded CI host must not flake); a
// superlinear rule measured 1.3 s on the 800 KB JWT line before its lookbehind was fixed, so it still fails.
test("adversarial 800 KB lines scan in linear time under every rule", () => {
  const N = 800_000;
  const cases: [string, string][] = [
    ["JWT near-prefix eyJ-", "eyJ-".repeat(N / 4)],
    ["JWT near-prefix eyJ.", "eyJ.".repeat(N / 4)],
    ["JWT header run", `eyJ${"a".repeat(N)}`],
    ["JWT segments", `eyJaaaaaaa.${"a".repeat(20)}`.repeat(N / 30)],
    ["URL scheme run", `${"a".repeat(N)}://`],
    ["URL userinfo near-prefix", "a://a:".repeat(N / 6)],
    ["URL password run", `a://a:${"b".repeat(N)}`],
    ["bearer near-prefix", "Authorization: Bearer ".repeat(N / 22)],
    ["bearer value run", `authorization: bearer ${"a".repeat(N)}`],
    ["bearer separators", `authorization:${" ".repeat(N)}`],
    ["Discord near-prefix", `M${"a".repeat(24)}.`.repeat(N / 27)],
    ["Discord run", `M${"a".repeat(N)}`],
    ["Telegram near-prefix", "1234567890:".repeat(N / 11)],
    ["Telegram digit run", "1".repeat(N)],
    ["DeepSeek near-prefix", "sk-".repeat(N / 3)],
    ["DeepSeek hex run", `sk-${"a".repeat(N)}`],
    ["GitHub near-prefix", "ghp_".repeat(N / 4)],
    ["GitHub run", `ghp_${"a".repeat(N)}`],
    ["fine-grained GitHub run", `github_pat_${"a".repeat(N)}`],
    ["Slack near-prefix", "xoxb-".repeat(N / 5)],
    ["Slack app near-prefix", "xapp-".repeat(N / 5)],
    ["Slack webhook run", `hooks.slack.com/services/${"T".repeat(N)}`],
    ["PEM header near-prefix", "-----BEGIN ".repeat(N / 11)],
    ["PEM header words", `-----BEGIN ${"A ".repeat(N / 2)}`],
    ["Stripe near-prefix", "sk_live_".repeat(N / 8)],
    ["Stripe run", `sk_live_${"a".repeat(N)}`],
    ["Google near-prefix", "AIza".repeat(N / 4)],
    ["AWS near-prefix", "AKIA".repeat(N / 4)],
    ["AWS run", `AKIA${"A".repeat(N)}`],
    ["GitLab near-prefix", "glpat-".repeat(N / 6)],
    ["Anthropic near-prefix", "sk-ant-".repeat(N / 7)],
    ["OpenAI near-prefix", `sk-${"a".repeat(20)}T3BlbkFJ`.repeat(N / 26)],
    ["OpenAI project near-prefix", "sk-proj-".repeat(N / 8)],
  ];
  for (const [name, line] of cases) {
    const t = performance.now();
    scanLine(line);
    const ms = performance.now() - t;
    assert.ok(ms < 1000, `${name}: ${ms.toFixed(0)} ms for ${line.length} chars`);
  }
});

test("a 4 MB JWT-shaped line stays linear (scales with the input, not with starts times the bound)", () => {
  const line = "eyJ-".repeat(1_000_000);
  const t = performance.now();
  assert.equal(scanLine(line), undefined);
  // 2 s: typical is tens of ms; the superlinear rule took ~6.9 s on this input, so it still fails.
  assert.ok(performance.now() - t < 2000);
});

test("obviously fake Discord, JWT and Telegram values are ignored; realistic-looking ones are not", () => {
  const fakes = [
    `M${"x".repeat(24)}.${"xxxxxx"}.${"x".repeat(27)}`, // one repeated character per segment
    `${"eyJ"}${"0".repeat(20)}.${"0".repeat(20)}.${"0".repeat(20)}`, // all-zero body
    `123456789:${"A".repeat(35)}`, // all-A body
    `123456789:${"REDACTED".repeat(4)}RED`, // stand-in word
    `${"eyJ"}${"EXAMPLE"}${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`, // stand-in word in the header
  ];
  for (const f of fakes) assert.equal(scanLine(`t = "${f}"`), undefined, f.slice(0, 30));
  // realistic-looking values still match
  assert.equal(scanLine(`${"M"}${"aB3".repeat(8)}.${"Ab3-_x"}.${mixed(27)}`), "Discord bot token");
  assert.equal(scanLine(`123456789:${mixed(35)}`), "Telegram bot token");
  assert.equal(scanLine(`${"eyJ"}${mixed(20)}.${mixed(20)}.${mixed(20)}`), "JWT");
});
