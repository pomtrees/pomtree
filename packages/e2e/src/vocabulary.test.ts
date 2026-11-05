import assert from "node:assert/strict";
import { test } from "node:test";
import { eachTrackedFile } from "./env-scan.ts";

// docs/economy.md: "mint" names nothing. Credential issuance is "issue" (`issueKey`, `issueToken`,
// `issueUiCookie`); money added to the root is a "top-up". This lite test keeps the word out of packages/ and examples/
// so the pre-release rename is not undone by a new identifier, comment or error message. The same holds repo-wide for the
// project's old name: `oldNameHits` fails any tracked line that still says it, bar the allowlist below.

const SELF = "packages/e2e/src/vocabulary.test.ts";

// Each word that starts with "mint" in any case (`mintKey`, `MINT_REFUSAL`, `key-minting`), but not one that merely
// contains it (`armInterrupt`).
export function mintWords(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z])mint[A-Za-z_]*/gi)].map((m) => m[0]);
}

test("mintWords flags words starting with mint and ignores words that only contain it", () => {
  assert.deepEqual(mintWords("gw.mintKey(a); MINT_REFUSAL; the key-minting proxy; Minted"), ["mintKey", "MINT_REFUSAL", "minting", "Minted"]);
  assert.deepEqual(mintWords("this.armInterrupt(agent); issueKey(a); the key-issuing proxy"), []);
});

test("no tracked file in packages/ or examples/ uses the word mint (credential issuance is issue)", () => {
  const hits: string[] = [];
  eachTrackedFile((path, text) => {
    if (path === SELF || !/^(packages|examples)\//.test(path)) return;
    const words = mintWords(text);
    if (words.length) hits.push(`${path}: ${[...new Set(words)].join(", ")}`);
  });
  assert.deepEqual(hits, [], "rename to issue* for credential issuance (top-up for money added to the root); see docs/economy.md");
});

// Files that keep the old name as history, plus this test, which spells it to ban it.
const OLD_NAME_ALLOWED = new Set(["docs/naming.md", "docs/release-results.md", SELF]);

// The old name is built from fragments, like "mint" above, so this file does not spell it (the public export is scanned for it).
const OLD = ["promul", "gatr"].join("");
const OLD_CAP = OLD.charAt(0).toUpperCase() + OLD.slice(1);
const OLD_UP = OLD.toUpperCase();

// Each `path:line` where the old name appears in any case (capitalized, upper-case in an env var, or in a scoped package
// name). A line that also says `pomtree` is allowed: text explaining the rename names both.
export function oldNameHits(path: string, text: string): string[] {
  if (OLD_NAME_ALLOWED.has(path)) return [];
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (new RegExp(OLD, "i").test(line) && !/pomtree/i.test(line)) hits.push(`${path}:${i + 1}`);
  });
  return hits;
}

test("oldNameHits flags the old name in any case or identifier form, except allowlisted files and rename explanations", () => {
  const planted = `ok\nimport x from "@${OLD}/core";\nconst a = process.env.${OLD_UP}_HOME;\n${OLD_CAP} is great\n`;
  assert.deepEqual(oldNameHits("packages/core/src/x.ts", planted), ["packages/core/src/x.ts:2", "packages/core/src/x.ts:3", "packages/core/src/x.ts:4"]);
  assert.deepEqual(oldNameHits("README.md", `the ${OLD} tool`), ["README.md:1"]);
  assert.deepEqual(oldNameHits("docs/naming.md", planted), []);
  assert.deepEqual(oldNameHits("docs/release-results.md", planted), []);
  assert.deepEqual(oldNameHits("README.md", `pomtree was formerly ${OLD}\nPOMTREE, ex-${OLD_CAP}`), []);
  assert.deepEqual(oldNameHits("README.md", "pomtree is fine\nclean line"), []);
});

test("no tracked file uses the old project name (it is pomtree)", () => {
  const hits: string[] = [];
  eachTrackedFile((path, text) => {
    hits.push(...oldNameHits(path, text));
  });
  assert.deepEqual(hits, [], "rename to pomtree; a line may name both when it explains the rename");
});
