import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { ROOT, eachTrackedFile } from "./env-scan.ts";
import { RULES, formatFinding, isScannedPath, scanText } from "./fixture-scrub-rules.ts";
import type { Finding } from "./fixture-scrub-rules.ts";

// Fixture scrub scan: committed offline fixtures must hold no secret, token or machine-specific path, because adapter
// tests replay them in public CI and a leaked value would be published with the repository. The rules are in fixture-scrub-rules.ts; planted-bad inputs live in scrub-negative/ and are
// excluded from the tree scan by design. `SCRUB_SCAN_ROOT=<repo-relative dir>` points the scan at a directory instead of
// the tracked fixtures, so the negative directory proves the scan exits non-zero (one finding per class).

const NEGATIVE = "packages/e2e/src/scrub-negative";

function scanDir(rootRel: string): Finding[] {
  const abs = join(ROOT, rootRel);
  const findings: Finding[] = [];
  for (const rel of readdirSync(abs, { recursive: true, encoding: "utf8" }).sort()) {
    const file = join(abs, rel);
    if (statSync(file).isFile()) findings.push(...scanText(relative(ROOT, file), readFileSync(file, "utf8")));
  }
  return findings;
}

function scanTracked(): Finding[] {
  const findings: Finding[] = [];
  eachTrackedFile((path, text) => {
    if (isScannedPath(path)) findings.push(...scanText(path, text));
  });
  return findings;
}

const override = process.env.SCRUB_SCAN_ROOT;

test(`fixture scrub: no finding in ${override ?? "tracked fixtures"}`, () => {
  const findings = override ? scanDir(override) : scanTracked();
  assert.deepEqual(
    findings.map(formatFinding),
    [],
    "a fixture leaks a secret, token or local path: apply each action, and re-record through the scrubbing recorder",
  );
});

test("negative: the planted-bad directory yields exactly one finding per rule class, and the clean file none", () => {
  const found = scanDir(NEGATIVE).map((f) => [f.path.split("/").pop(), f.rule]);
  const expected = RULES.map((r) => [`${r.id}.txt`, r.id]);
  assert.deepEqual(found.sort(), expected.sort());
});

test("isScannedPath covers adapter fixture directories and excludes the planted-bad directory", () => {
  assert.equal(isScannedPath("packages/harness-pi/src/fixtures/plain.jsonl"), true);
  assert.equal(isScannedPath("packages/sandbox-e2b/conformance/fixtures/x.jsonl"), true);
  assert.equal(isScannedPath("examples/foo/conformance/fixtures/x.jsonl"), true);
  assert.equal(isScannedPath("packages/e2e/src/scrub-negative/absolute-path.txt"), false);
  assert.equal(isScannedPath("packages/core/src/index.ts"), false);
});

test("token variable rule recognizes both the pending-rename name and the new name, and the _FILE forms", () => {
  for (const name of ["POMTREE_TOKEN", "POMTREE_TOKEN_FILE", `POMTREE_${"API_"}TOKEN`, `POMTREE_${"API_"}TOKEN_FILE`]) {
    assert.deepEqual(
      scanText("x", `${name}=FAKE-value`).map((f) => f.rule),
      ["pomtree-token-env"],
      name,
    );
    assert.deepEqual(
      scanText("x", `"${name}": "FAKE-value"`).map((f) => f.rule),
      ["pomtree-token-env"],
      name,
    );
    assert.deepEqual(scanText("x", `${name}=<REDACTED>`), [], `${name} placeholder`);
  }
});

test("rules: each class fires on its variants and stays quiet on placeholders and allowed values", () => {
  const rule = (line: string) => scanText("x", line).map((f) => f.rule);
  assert.deepEqual(rule("Authorization: Bearer FAKEtoken123"), ["bearer-token"]);
  assert.deepEqual(rule("Authorization: Bearer <TOKEN>"), []);
  assert.deepEqual(rule('{"x-api-key":"FAKEkey"}'), ["auth-header"]);
  assert.deepEqual(rule("x-api-key: <REDACTED>"), []);
  for (const k of ["sk-ant-FAKEFAKE1", "ghp_FAKEFAKEFAKE1", "AKIAFAKEFAKEFAKE1", "xoxb-FAKEFAKE1"])
    assert.deepEqual(rule(`k=${k}`), ["provider-key-prefix"], k);
  assert.deepEqual(rule("a risk-assessment of disk-usage"), []);
  assert.deepEqual(rule('"organization_id":"org-FAKE1"'), ["account-id"]);
  assert.deepEqual(rule('{"placeholders":["org-ok"],"org_id":"org-ok"}'), []);
  assert.deepEqual(rule("v=0123456789abcdef0123456789abcdef"), ["high-entropy"]);
  assert.deepEqual(rule("sha256:0123456789abcdef0123456789abcdef0123456789abcdef"), []);
  assert.deepEqual(rule("this-is-a-long-kebab-case-identifier-without-digits"), []);
  for (const p of ["/Users/someone/x", "/home/someone/x", "C:\\Users\\someone", '"cwd":"C:\\\\Users\\\\someone"'])
    assert.deepEqual(rule(p), ["absolute-path"], p);
  assert.deepEqual(rule("cwd=/workspace/project and /usr/local/bin"), []);
});

test("findings name file, line, rule and action, and never echo the matched value", () => {
  const f = scanText("a/b.txt", "ok\ncwd: /Users/someone/FAKEsecretpath")[0];
  assert.ok(f);
  assert.equal(f.path, "a/b.txt");
  assert.equal(f.line, 2);
  assert.match(formatFinding(f), /^a\/b\.txt:2 \[absolute-path\] replace /);
  assert.doesNotMatch(formatFinding(f), /FAKEsecretpath/);
});

test("rules: machine paths beyond /Users and /home are flagged, URL paths and container paths are not", () => {
  const rule = (line: string) => scanText("x", line).map((f) => f.rule);
  for (const p of ["cwd: ~/proj/x", "cwd=/root/proj", '"p":"/var/folders/ab/cd/T/x"', "tmp: /private/tmp/x", "tmp: /private/var/x"])
    assert.deepEqual(rule(p), ["absolute-path"], p);
  assert.deepEqual(rule("GET https://host/v1/private/items and /api/root/x"), []);
  assert.deepEqual(rule("cwd: /workspace/x and a~/b"), []);
});

test("rules: long numeric, hex and base64url blobs are flagged; UUIDs, labelled digests, URL paths and kebab ids are not", () => {
  const rule = (line: string) => scanText("x", line).map((f) => f.rule);
  assert.deepEqual(rule(`n: ${"1234567890".repeat(4)}`), ["high-entropy"]);
  assert.deepEqual(rule(`h: ${"abcdef".repeat(6)}`), ["high-entropy"]);
  assert.deepEqual(rule("k: Ab3-Cd4_Ef5-Gh6_Ij7-Kl8_Mn9-Op0_Qr1-St2"), ["high-entropy"]);
  assert.deepEqual(rule("id: 123e4567-e89b-12d3-a456-426614174000"), []);
  assert.deepEqual(rule(`image: sha256:${"ab12".repeat(16)}`), []);
  assert.deepEqual(rule("GET /v1/sandboxes/sbx/files/list/everything/under/the/workspace"), []);
  assert.deepEqual(rule("name: item_111_missing_title_something_quite_long_here"), []);
  assert.deepEqual(rule(`{"placeholders":["${"ab12".repeat(10)}"],"x":"${"ab12".repeat(10)}"}`), []);
});

test("rules: password and secret assignments and PEM private key headers are flagged; short values and placeholders are not", () => {
  const rule = (line: string) => scanText("x", line).map((f) => f.rule);
  for (const l of ["password=hunter2hunter2", '"client_secret": "FAKEsecret1"', "DB_PASSWD: FAKEpass99", "secret = 'FAKEvalue1'"])
    assert.deepEqual(rule(l), ["secret-assignment"], l);
  for (const l of ["password=short", "secret: <REDACTED>", "password: ${DB_PASSWORD}", "secretName: x"]) assert.deepEqual(rule(l), [], l);
  for (const l of ["-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----"])
    assert.deepEqual(rule(l), ["private-key-block"], l);
  assert.deepEqual(rule("-----BEGIN CERTIFICATE-----"), []);
});

test("rules: model names and call ids in real fixtures are not key material", () => {
  assert.deepEqual(scanText("x", "deepseek-ai/DeepSeek-V4-Flash-0731 nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B call_00_C7nLFjjxyAGSITEHMeW26436"), []);
});
