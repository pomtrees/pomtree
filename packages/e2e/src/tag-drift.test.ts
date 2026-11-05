import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { ROOT, eachTrackedFile } from "./env-scan.ts";

// THE RULE: every breadcrumb in code must be tracked somewhere. The current realization reads Markdown ledgers (TODO.md files), and
// that source is deliberately isolated in one function, `ledgerTags()`, because the ledger format may change (for example to
// issues). Swap that function's body and the rest of this file, the rule included, stays as is.
//
// A `TODO(tag)` breadcrumb in code is a promise that the deferred work is tracked. `TODO(gw-contract)` once lived only as two
// code comments, with three real open items invisible to the release ledger. This lite test, like ci-guard.test.ts and
// vocabulary.test.ts, keeps the two sides honest in one direction only: every `TODO(tag)` or `seed(tag)` in a code file must be
// named in the header of some ledger entry. The reverse is not enforced: many tags are ledger-only by design.
//
// Code files are those under packages/, examples/, scripts/ and .github/. docs/ is not scanned: documents cite tags they do not
// own. HANDOFF.md cites tags but does not define them, so it is not a ledger here.

const CODE_DIRS = /^(packages|examples|scripts|\.github)\//;
const LEDGER = /(^|\/)TODO\.md$/;
// This file holds fixture tags (`TODO(orphan)` and others) as test data, so it is not scanned.
const SELF = "packages/e2e/src/tag-drift.test.ts";
const HANDOFF = /(^|\/)HANDOFF\.md$/;
// The public tree ships no ledger file: known gaps there are GitHub issues, and its tags stay unledgered until each has one. So the
// whole-tree rule runs only where a tracked ledger exists (the dev tree) and skips, with this reason, where none does; the fixture
// tests below run everywhere. If git cannot list the tree, the rule is not skipped: it runs and fails on the same git error, as before.
const skipNoLedger = (): false | string => {
  let paths: string[];
  try {
    paths = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
  } catch {
    return false;
  }
  return paths.some((p) => LEDGER.test(p))
    ? false
    : "no tracked TODO.md ledger in this tree (the public tree ships none and tracks gaps as GitHub issues), so there is nothing to check code tags against";
};

// Words that appear as `TODO(...)` in prose or test strings but are not tags. Each needs a written reason. Placeholder forms
// `<tag>` and `${...}` never match TAG, which starts with a lowercase letter.
const NOT_A_TAG: Record<string, string> = {
  tag: "the literal placeholder in the docs that describe the breadcrumb syntax (the public contributor guide, test comments)",
};

const TAG = /\b(TODO|seed)\(([a-z][a-z0-9-]*)\)/g;

export interface Mention {
  tag: string; // as written, e.g. "TODO(gw-contract)" or "seed(evals)"
  line: number;
}

// Every breadcrumb in `text`, skipping the documented non-tags. String literals are not stripped: `todo: "seed(evals)"` in a
// node:test option is a real breadcrumb.
export function breadcrumbs(text: string): Mention[] {
  const out: Mention[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(TAG)) {
      if (!Object.hasOwn(NOT_A_TAG, m[2] ?? "")) out.push({ tag: `${m[1]}(${m[2]})`, line: i + 1 });
    }
  });
  return out;
}

// The text of a ledger bullet's first line up to the first ": " outside parentheses (a tag's own parentheses balance, so they
// do not end the header). A bullet is a line starting "- " at column 0; sub-bullets and prose are not headers.
export function headerOf(line: string): string {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0 && line[i + 1] === " ") return line.slice(0, i);
  }
  return line;
}

// Every backticked tag in the header of every top-level bullet, so a multi-tag header ("`TODO(a)`, `TODO(b)`: ...") counts all.
function parseLedger(text: string, tags: Set<string>): void {
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    for (const m of headerOf(line).matchAll(/`(TODO|seed)\(([a-z][a-z0-9-]*)\)`/g)) tags.add(`${m[1]}(${m[2]})`);
  }
}

// THE SEAM: the set of tags that have a ledger entry, e.g. "TODO(gw-contract)". Everything about where entries live (every tracked
// TODO.md, the root one and any package-local one) and how they are parsed (Markdown bullet headers) is inside this function.
// `files` is for fixtures; by default it reads the tracked tree.
export function ledgerTags(files: Map<string, string> = trackedFiles()): Set<string> {
  const tags = new Set<string>();
  for (const [path, text] of files) if (LEDGER.test(path)) parseLedger(text, tags);
  return tags;
}

function trackedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  eachTrackedFile((path, text) => files.set(path, text));
  return files;
}

// Tags mentioned in code but named in no ledger header, each with its file:line sites.
export function unledgered(files: Map<string, string>, ledgered: Set<string>): Map<string, string[]> {
  const missing = new Map<string, string[]>();
  for (const [path, text] of files) {
    if (!CODE_DIRS.test(path) || LEDGER.test(path) || HANDOFF.test(path)) continue;
    for (const { tag, line } of breadcrumbs(text)) {
      if (!ledgered.has(tag)) missing.set(tag, [...(missing.get(tag) ?? []), `${path}:${line}`]);
    }
  }
  return missing;
}

export function failureMessage(missing: Map<string, string[]>): string {
  return [...missing]
    .map(
      ([tag, sites]) =>
        `${tag} appears in code but has no ledger entry:\n${sites.map((s) => `    ${s}`).join("\n")}\n` +
        `  Add an entry whose header names it to TODO.md (or a package-local TODO.md), under the right priority:\n` +
        `    - [P2] \`${tag}\`: <current behavior>. <what remains>. <trigger to act>.\n` +
        `  If it is not a tag, rename the text; if the work is done, delete the breadcrumb.`,
    )
    .join("\n\n");
}

const sample = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

test("ledgerTags collects every backticked tag in a multi-tag header, not just the first", () => {
  const ledger = [
    "- [P2] `TODO(budget-correctness)`, `TODO(meter-zero-cost)`, `TODO(adopted-unmetered)`: PARTIAL. see `TODO(body-only)`.",
    "- [P2] `TODO(exit-cause)`, `TODO(spawn-fail)`: PARTIAL.",
    "- `seed(evals)`, extension, P2 (2026-10-24 release road): a fixed-task baseline.",
    "- [P2] `TODO(analytics)` (ledger only; see `TODO(in-parens)`): text",
    "  - `TODO(sub-bullet)`: not a header",
  ].join("\n");
  const tags = ledgerTags(sample({ "TODO.md": ledger }));
  for (const t of ["budget-correctness", "meter-zero-cost", "adopted-unmetered", "exit-cause", "spawn-fail", "analytics"]) {
    assert.ok(tags.has(`TODO(${t})`), t);
  }
  assert.ok(tags.has("seed(evals)"));
  assert.ok(!tags.has("TODO(body-only)") && !tags.has("TODO(sub-bullet)"));
});

test("the six formerly first-tag-only cases are not flagged when ledgered in multi-tag headers", () => {
  const files = sample({
    "TODO.md": [
      "- [P2] `TODO(exit-cause)`, `TODO(spawn-fail)`: PARTIAL.",
      "- [P2] `TODO(budget-correctness)`, `TODO(meter-zero-cost)`, `TODO(adopted-unmetered)`: PARTIAL.",
      "- `seed(evals)`, extension, P2: baseline.",
      "- `seed(workflows)`, extension: later.",
      "- [P2] `TODO(e2e-time-adopt-exit)`: x",
    ].join("\n"),
    "packages/a/src/a.ts": [
      "// TODO(spawn-fail) a",
      "// TODO(e2e-time-adopt-exit) b",
      "// TODO(meter-zero-cost) c",
      "// TODO(adopted-unmetered) d",
      'const t = { todo: "seed(evals)" };',
      "// seed(workflows)",
    ].join("\n"),
  });
  assert.deepEqual([...unledgered(files, ledgerTags(files))], []);
});

test("placeholders are not breadcrumbs and docs/ is not scanned", () => {
  assert.deepEqual(breadcrumbs(`// \`todo: "TODO(<tag>)"\` and TODO(\${t.gap}) and TODO(tag)`), []);
  const files = sample({ "docs/notes.md": "see `TODO(not-ours)`", "HANDOFF.md": "`TODO(cited-only)`", "packages/a/x.md": "ok" });
  assert.deepEqual([...unledgered(files, ledgerTags(files))], []);
});

test("negative control: a code breadcrumb with no ledger header is reported with every file:line and the entry skeleton", () => {
  const files = sample({
    "TODO.md": "- [P2] `TODO(other)`: x",
    "packages/a/a.ts": "x\n// TODO(orphan) one\n// TODO(orphan) two",
    "packages/b/TODO.md": "- [P3] `TODO(local)`: y",
    "packages/b/b.ts": "// TODO(local)",
  });
  const missing = unledgered(files, ledgerTags(files));
  assert.deepEqual([...missing], [["TODO(orphan)", ["packages/a/a.ts:2", "packages/a/a.ts:3"]]]);
  const msg = failureMessage(missing);
  assert.match(msg, /TODO\(orphan\) appears in code but has no ledger entry/);
  assert.match(msg, /packages\/a\/a\.ts:3/);
  assert.match(msg, /- \[P2\] `TODO\(orphan\)`:/);
});

test("every TODO(tag) or seed(tag) in a code file is tracked in a ledger", { skip: skipNoLedger() }, () => {
  const code = new Map<string, string>();
  eachTrackedFile((path, text) => {
    if (CODE_DIRS.test(path) && path !== SELF) code.set(path, text);
  });
  const tracked = ledgerTags();
  assert.ok(tracked.size > 0, `no ledger entries found under ${ROOT}; run from a checkout`);
  const missing = unledgered(code, tracked);
  if (missing.size > 0) assert.fail(`\n${failureMessage(missing)}\n`);
});
