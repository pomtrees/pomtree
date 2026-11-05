import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { POMTREED_KIND_PREFIX, POMTREED_KINDS } from "@pomtree/core";
import * as daemonUtil from "./daemon-util.ts";

// Files that must reference journal kinds only through the core registry (POMTREED_KINDS), never by literal.
const OWNED = ["daemon-util.ts", "daemon/lifecycle.ts", "trace.ts", "daemon/tree.ts"];

function codeLines(relPath: string): { file: string; text: string }[] {
  const src = readFileSync(new URL(relPath, import.meta.url), "utf8");
  const out: { file: string; text: string }[] = [];
  let inBlock = false;
  for (const raw of src.split("\n")) {
    const t = raw.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*")) continue;
    out.push({ file: relPath, text: raw });
  }
  return out;
}

test("owned pomtreed sources reference journal kinds only through POMTREED_KINDS", () => {
  const hits = OWNED.flatMap(codeLines).filter((l) => l.text.includes("ext.pomtreed."));
  assert.deepEqual(
    hits.map((h) => `${h.file}: ${h.text.trim()}`),
    [],
    "ext.pomtreed. literal found in code; use POMTREED_KINDS instead",
  );
});

test("every POMTREED_KINDS value starts with POMTREED_KIND_PREFIX", () => {
  const values = Object.values(POMTREED_KINDS);
  assert.ok(values.length > 0);
  for (const v of values) assert.ok(v.startsWith(POMTREED_KIND_PREFIX), `${v} lacks ${POMTREED_KIND_PREFIX}`);
});

test("exported ext.pomtreed *_KIND constants in daemon-util are registry members", () => {
  const members = new Set<string>(Object.values(POMTREED_KINDS));
  const kindExports = Object.entries(daemonUtil).filter(([name, v]) => name.endsWith("_KIND") && typeof v === "string" && v.startsWith("ext.pomtreed."));
  assert.ok(kindExports.length > 0);
  for (const [name, v] of kindExports) assert.ok(members.has(v as string), `${name} = ${String(v)} is not in POMTREED_KINDS`);
});
