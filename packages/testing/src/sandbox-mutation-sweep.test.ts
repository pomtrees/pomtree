import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUSE_IDS, evaluateSandboxConformance, fakeSandboxUnderTest } from "./sandbox-conformance.ts";
import type { ClauseId, ConformanceReport } from "./sandbox-conformance.ts";
import { BREAK_MODES, newBreakEnv } from "./sandbox-broken.ts";
import type { BreakEnable, BreakEnv, BreakMode, BreakVariant } from "./sandbox-broken.ts";

// The mutation sweep: every break mode (each clause's primary mode and its `also` variants) runs the WHOLE clause suite over the shared
// fake broken that one way, and the sweep reads which clauses failed from the structured report. A mode that fails none of the clauses
// is a surviving mutant: the clause it targets cannot tell a correct sandbox from that broken one. A mode that fails a clause outside its
// target and declared collateral is a stray. Each mode's correct reference world must first pass everything (the positive control). A
// no-op control mode (the identity wrapper) proves the sweep can fail: it breaks nothing, so the sweep must flag it as a survivor.

interface SweptMode {
  clause: ClauseId;
  mode: BreakVariant;
  enable?: BreakEnable;
}

interface SweepRow {
  mode: string;
  clause: ClauseId;
  // Every check that failed over the broken sandbox, sorted.
  failed: string[];
  // Checks that failed over the correct reference world (must be empty) and whether the target clause ran and passed there.
  controlFailed: string[];
  controlRan: boolean;
}

const failedIds = (r: ConformanceReport) =>
  r.results
    .filter((x) => x.status === "failed")
    .map((x) => x.id)
    .sort();

// The descriptor for one swept mode: a fresh engine and provider per world, the clause's enabling reference layer, the mode on top when broken.
function descriptor(s: SweptMode, broken: boolean) {
  let world = newBreakEnv();
  const live: BreakEnv = {
    get engine() {
      return world.engine;
    },
    get provider() {
      return world.provider;
    },
  };
  return fakeSandboxUnderTest({
    ...s.enable?.descriptor(live),
    wrap: (fake) => {
      world = newBreakEnv();
      const base = s.enable ? s.enable.reference(fake, world) : fake;
      return broken ? s.mode.wrap(base, world) : base;
    },
  });
}

async function sweep(modes: readonly SweptMode[]): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];
  for (const s of modes) {
    const good = await evaluateSandboxConformance(descriptor(s, false));
    const bad = await evaluateSandboxConformance(descriptor(s, true));
    rows.push({
      mode: s.mode.name,
      clause: s.clause,
      failed: failedIds(bad),
      controlFailed: failedIds(good),
      controlRan: good.results.some((x) => x.id === s.clause && x.status === "passed"),
    });
  }
  return rows;
}

// Survivors: modes whose broken sandbox failed no clause at all, or not the clause they target.
const survivors = (rows: readonly SweepRow[]) => rows.filter((r) => !r.failed.includes(r.clause)).map((r) => `${r.mode} (${r.clause})`);
// Strays: modes that fail a check outside their target and declared collateral.
const strays = (rows: readonly SweepRow[], modes: readonly SweptMode[]) =>
  rows.flatMap((r) => {
    const m = modes.find((x) => x.mode.name === r.mode);
    const allowed = new Set<string>([r.clause, ...(m?.mode.collateral ?? [])]);
    const extra = r.failed.filter((id) => !allowed.has(id));
    return extra.length > 0 ? [`${r.mode} also failed ${extra.join(", ")}`] : [];
  });
// Broken controls: modes whose correct reference world did not pass everything, or skipped the target clause.
const brokenControls = (rows: readonly SweepRow[]) =>
  rows.flatMap((r) =>
    r.controlFailed.length > 0 || !r.controlRan
      ? [`${r.mode}: reference world failed [${r.controlFailed.join(", ")}]${r.controlRan ? "" : `, ${r.clause} did not run and pass`}`]
      : [],
  );

const ALL_MODES: SweptMode[] = CLAUSE_IDS.flatMap((clause) => {
  const entry: BreakMode = BREAK_MODES[clause];
  return [entry, ...(entry.also ?? [])].map((mode) => ({ clause, mode, ...(entry.enable && { enable: entry.enable }) }));
});

// The identity wrapper: breaks nothing. One per clause, with that clause's enabling layer, so it is checked under every descriptor shape.
const NO_OP: BreakVariant = { name: "no-op-control", collateral: [], fails: /$^/, wrap: (inner) => inner };
const NO_OP_MODES: SweptMode[] = CLAUSE_IDS.map((clause) => {
  const entry: BreakMode = BREAK_MODES[clause];
  return { clause, mode: NO_OP, ...(entry.enable && { enable: entry.enable }) };
});

test("sweep: every break mode kills its clause, fails only its declared collateral, and every clause is killed by some mode", async () => {
  const rows = await sweep(ALL_MODES);
  assert.equal(rows.length, ALL_MODES.length);
  assert.deepEqual(brokenControls(rows), [], "each mode's correct reference world must pass every check and run its target clause");
  assert.deepEqual(survivors(rows), [], "surviving mutants: these modes left their target clause passing; strengthen the clause or the mode");
  assert.deepEqual(strays(rows, ALL_MODES), [], "these modes failed checks outside their declared collateral; fix the mode or declare the collateral");
  const killed = new Set(rows.filter((r) => r.failed.includes(r.clause)).map((r) => r.clause));
  assert.deepEqual(
    CLAUSE_IDS.filter((c) => !killed.has(c)),
    [],
    "vacuous clauses: no break mode makes these fail; author a mode that does",
  );
});

test("sweep control: the no-op mode fails nothing and the sweep flags it as a surviving mutant under every clause's descriptor", async () => {
  const rows = await sweep(NO_OP_MODES);
  assert.deepEqual(
    rows.filter((r) => r.failed.length > 0).map((r) => `${r.clause}: ${r.failed.join(", ")}`),
    [],
    "the identity wrapper must fail no check; a failure here means the suite fails a correct sandbox",
  );
  assert.deepEqual(brokenControls(rows), []);
  assert.deepEqual(
    survivors(rows),
    CLAUSE_IDS.map((c) => `no-op-control (${c})`),
    "the sweep must report the no-op mode as surviving for every clause, or it cannot detect a mode that breaks nothing",
  );
  // The same detector over the real modes plus one no-op: exactly the no-op survives.
  const mixed = await sweep([...ALL_MODES.slice(0, 2), NO_OP_MODES[0] as SweptMode]);
  assert.deepEqual(survivors(mixed), [`no-op-control (${CLAUSE_IDS[0]})`]);
});

// ---- the coverage table's exhaustiveness negative control ----

const root = join(import.meta.dirname, "..", "..", "..");

test("negative: the coverage fixture missing the terminal row stops the type check with TS1360 naming it", () => {
  const tsc = join(root, "node_modules", "typescript", "lib", "tsc.js");
  const r = spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(root, "packages", "testing", "tsconfig.coverage-negative.json")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, `the fixture that drops a capability row must not compile; tsc printed: ${out}`);
  assert.match(out, /sandbox-coverage\.negative\.ts.*error TS1360/);
  assert.match(out, /Property 'terminal' is missing/);
});
