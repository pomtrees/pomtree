import assert from "node:assert/strict";
import { test } from "node:test";
import { isExcludedEnv } from "@pomtree/core";
import { digestComposedRegistry } from "./digest-registry.ts";
import { classify, scanSites } from "./env-scan.ts";
import type { RegistryNames, Seen } from "./env-scan.ts";

// Set-site versus read-site lint for the POMTREE_* / POMTREED_* environment names (TODO(env-drift), wave W5). Most past
// producer/consumer drift hid behind per-package fakes; an env name that is read but never set (or set but never read) is
// the same shape. Every name used in non-test source must be (a) set somewhere in source, or (b) a documented operator
// input (deploy/pomtreed.env.example, README, SPEC, docs/, deploy/INSTALL.md), and a name that is set must be read somewhere.
// Known one-sided names are listed in GAPS with their TODO tag; the test also fails when a gap is fixed but still listed.

// Names with a one-sided site, each tied to the ledger tag that owns the fix. The tests below fail when an entry is
// stale (the gap closed) so the list cannot rot.
const GAPS: Record<string, string> = {
  // Operator or test-harness inputs read by non-test code with no documenting comment or doc line.
  PTREE_TEST_CAPTURE_URL: "env-drift",
  PTREE_TEST_RELAY_URL: "env-drift",
  // Deliberately retired and never set: live-model.ts reads it only to refuse it with the fix (a raw key in the env reaches every child).
  PTREE_E2E_MODEL_KEY: "env-drift",
  // Read by the capture worker; the setter is the pomtreed capture broker in S1. Remove this entry when S1 lands.
  PTREE_CAPTURE_JOB: "capture-broker",
};

// POMTREE_* names that are operator or test seams, not daemon-injected: a documenting comment is enough (POMTREE_LIVE_* are the scripts/live operator overrides, documented in stack.sh).
const SEAMS = new Set(["POMTREE_REVISION_FILE", "POMTREE_LIVE_MODEL", "POMTREE_LIVE_REPO", "POMTREE_LIVE_TMP"]);

test("classify: assignments and env-literal keys are set sites, everything else is a read (negative variants included)", () => {
  assert.equal(classify("process.env.POMTREE_X = 'a';", "POMTREE_X"), "set");
  assert.equal(classify("POMTREE_X: token,", "POMTREE_X"), "set");
  assert.equal(classify('"POMTREE_X": token,', "POMTREE_X"), "set");
  assert.equal(classify("  -e POMTREE_X=1 \\", "POMTREE_X"), "set");
  assert.equal(classify("const v = process.env.POMTREE_X;", "POMTREE_X"), "read");
  assert.equal(classify("const v = env.POMTREE_X ?? 5;", "POMTREE_X"), "read");
  assert.equal(classify('if (env.POMTREE_X === "a") {}', "POMTREE_X"), "read");
  assert.equal(classify('envInt(env, "POMTREE_X", 1)', "POMTREE_X"), "read");
  assert.equal(classify("const t = c ? POMTREE_X : 1;", "POMTREE_X"), "read");
});

// POMTREE_* names are injected by the daemon into agent containers: a comment is not enough, they need a real set site.
// POMTREED_* and PTREE_* are operator or test-harness inputs: a set site or a documenting comment/doc line is enough.
const injected = (n: string) => n.startsWith("POMTREE_") && !SEAMS.has(n);

export function findings(seen: Seen, gaps: Record<string, string>): { readNotSet: string[]; setNotRead: string[]; staleGaps: string[] } {
  const reads = new Set([...seen.read, ...seen.set]);
  const readNotSet = [...reads].filter((n) => !(n in gaps) && !seen.registry.has(n) && !seen.set.has(n) && (injected(n) || !seen.doc.has(n))).sort();
  const hasReader = (n: string) => seen.read.has(n) || seen.registry.has(n) || seen.testRead.has(n);
  const setNotRead = [...seen.set].filter((n) => !(n in gaps) && !hasReader(n)).sort();
  const staleGaps = Object.keys(gaps)
    .filter((n) => !((seen.set.has(n) && !hasReader(n)) || (seen.read.has(n) && !seen.set.has(n))))
    .sort();
  return { readNotSet, setNotRead, staleGaps };
}

const empty = (): Seen => ({ set: new Set(), read: new Set(), doc: new Set(), registry: new Set(), testRead: new Set() });

test("findings: a read with no set site, a set with no reader and a stale gap are each reported; operator docs and test readers are honoured", () => {
  const s = empty();
  s.read.add("POMTREE_ONLY_READ").add("POMTREED_DOC_ONLY").add("POMTREED_UNDOC");
  s.doc.add("POMTREED_DOC_ONLY").add("POMTREE_ONLY_READ"); // a doc line does not excuse a daemon-injected POMTREE_* name
  s.set.add("POMTREE_ONLY_SET").add("POMTREE_SET_TEST_READ").add("POMTREE_BOTH");
  s.read.add("POMTREE_BOTH");
  s.testRead.add("POMTREE_SET_TEST_READ");
  const f = findings(s, { POMTREE_BOTH: "t" });
  assert.deepEqual(f.readNotSet, ["POMTREED_UNDOC", "POMTREE_ONLY_READ"]);
  assert.deepEqual(f.setNotRead, ["POMTREE_ONLY_SET"]);
  assert.deepEqual(f.staleGaps, ["POMTREE_BOTH"]);
});

// The registry is the single declaration of env names: live names are read by resolveConfig, excluded names are
// declared (not used) where the registry lists them.
const composed = digestComposedRegistry(); // core plus the hn-digest manifest's keys
const registryNames: RegistryNames = {
  live: composed.envNames,
  excluded: (n) => isExcludedEnv(n) !== undefined,
};

test("registry names: live names count as read, excluded literals under core/config are not sites, and unregistered one-sided names are still flagged (negative variants)", () => {
  const reg: RegistryNames = { live: new Set(["POMTREED_LIVE_KNOB"]), excluded: (n) => n === "POMTREE_TOKEN" };
  const files = [
    ["packages/core/src/config/params.ts", 'name: "POMTREE_TOKEN",\nx("POMTREED_FAB_READ");'],
    ["packages/harness/run.ts", 'env.POMTREED_LIVE_KNOB = "1";\nenv.POMTREED_FAB_SET = "1";'],
  ] as const;
  const seen = scanSites(reg, (visit) => {
    for (const [path, text] of files) visit(path, text);
  });
  assert.ok(seen.registry.has("POMTREED_LIVE_KNOB"), "a live registry name is read by the resolver, so a harness set is not dead");
  assert.ok(!seen.read.has("POMTREE_TOKEN"), "declaration literals are not reads");
  const f = findings(seen, {});
  assert.deepEqual(f.setNotRead, ["POMTREED_FAB_SET"], "set-but-never-read names that nothing reads are flagged");
  assert.deepEqual(f.readNotSet, ["POMTREED_FAB_READ"], "a read of an unregistered, unset name is flagged");
});

test("the repo has no unledgered env set/read drift", () => {
  const f = findings(scanSites(registryNames), GAPS);
  assert.deepEqual(f.readNotSet, [], "read but never set: set it, document it (POMTREED_*), or add it to GAPS with a TODO tag");
  assert.deepEqual(f.setNotRead, [], "set but never read: remove the dead set site, or add it to GAPS with a TODO tag");
  assert.deepEqual(f.staleGaps, [], "now has both a set and a read site: drop it from GAPS");
});
