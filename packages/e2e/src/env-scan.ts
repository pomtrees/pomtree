import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Shared scanner behind the env lint tests (env-drift.test.ts: set versus read sites; config-registry-drift.test.ts: every name
// in source is registered). Kept out of the test files so both import it without re-running the other's tests.

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Calls visit(path, text) for each git-tracked file; files listed but deleted in the working tree are skipped.
export function eachTrackedFile(visit: (path: string, text: string) => void): void {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    visit(f, text);
  }
}

// --- Set/read sites (env-drift) ---

const NAME = /\b(?:POMTREED?|PTREE)_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g;
const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
// TypeScript identifiers that match the pattern but are not environment variables.
const NOT_ENV = new Set(["POMTREED_KINDS", "POMTREED_KIND_PREFIX"]);
const SOURCE_FILE = /\.(ts|mts|js|mjs|sh|plist|service|yml|example)$|(^|\/)Dockerfile$/;
const DOC_FILE = /\.md$|pomtreed\.env\.example$/;

export type Site = "set" | "read" | "doc";

// A line sets NAME when it assigns it (`env.NAME =`, `NAME=value` in a shell/env line), or writes it as an object key
// (`NAME:` / `"NAME":` inside an env literal). Everything else that mentions it in code is a read.
export function classify(line: string, name: string): "set" | "read" {
  const n = name.replace(/[$]/g, "\\$&");
  if (new RegExp(`\\.${n}\\s*=(?!=)|\\[["']${n}["']\\]\\s*=(?!=)`).test(line)) return "set";
  if (new RegExp(`(^\\s*|[^\\w.?\\s]\\s*|,\\s*|{\\s*)["']?${n}["']?\\s*:(?!:)\\s*[^\\s)]`).test(line)) return "set";
  if (new RegExp(`(^|[\\s"'\`,;(])${n}=`).test(line)) return "set";
  return "read";
}

export interface Seen {
  set: Set<string>;
  read: Set<string>;
  doc: Set<string>;
  registry: Set<string>; // live registry names: declared and documented by the registry, and read by resolveConfig by definition
  testRead: Set<string>; // read only from a *.test.* file (counts as a reader for the set-but-never-read check)
}

// The registry's view of env names (packages/core/src/config), passed in so the scanner stays free of core imports.
export interface RegistryNames {
  live: ReadonlySet<string>; // every owned name: resolveConfig reads each, so each counts as READ by definition
  excluded: (name: string) => boolean; // CONFIG_ENV_EXCLUSIONS membership: declared, neither set nor read there
}

// Where exclusion literals live: the core registry tables and the digest's extension table (params.mts).
const CONFIG_SRC = /^(packages\/core\/src\/config\/(?!.*\.test\.m?ts$)|examples\/hn-digest\/params\.mts$)/;

export function scanSites(reg?: RegistryNames, each: typeof eachTrackedFile = eachTrackedFile): Seen {
  const seen: Seen = { set: new Set(), read: new Set(), doc: new Set(), registry: new Set(), testRead: new Set() };
  each((f, text) => {
    if (/pnpm-lock|^TODO\.md$|^HANDOFF\.md$|^CLAUDE\.md$/.test(f)) return;
    const isTest = /\.test\.m?ts$/.test(f);
    const doc = DOC_FILE.test(f);
    if (!doc && !SOURCE_FILE.test(f)) return;
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(NAME)) {
        const name = m[0];
        if (NOT_ENV.has(name)) continue;
        // Exclusion literals under the registry declare excluded names; they are not sites.
        if (reg && CONFIG_SRC.test(f) && reg.excluded(name)) continue;
        if (isTest) {
          if (!doc && !COMMENT.test(line) && classify(line, name) === "read") seen.testRead.add(name);
        } else if (doc || COMMENT.test(line))
          seen.doc.add(name); // a comment naming the variable documents it
        else seen[classify(line, name)].add(name);
      }
    }
  });
  if (reg) for (const n of reg.live) seen.registry.add(n);
  return seen;
}

// --- Names in non-test source (config-registry-drift) ---

// A trailing `_` is a family reference (`POMTREED_EXT_${name}`, `POMTREED_JOURNAL_*` in a comment).
const FAMILY_NAME = /\b(?:POMTREED?|PTREE)_[A-Z][A-Z0-9_]*/g;
const CODE_FILE = /^(packages|examples)\/.*\.(ts|mts|js|mjs|sh)$/;
const TEST_FILE = /\.test\.m?ts$/;

// Every env-looking name in non-test packages/ and examples/ source, mapped to the first file that names it.
export function scanNames(): Map<string, string> {
  const found = new Map<string, string>();
  eachTrackedFile((f, text) => {
    if (!CODE_FILE.test(f) || TEST_FILE.test(f) || f.includes("/node_modules/")) return;
    for (const m of text.matchAll(FAMILY_NAME)) if (!found.has(m[0])) found.set(m[0], f);
  });
  return found;
}
