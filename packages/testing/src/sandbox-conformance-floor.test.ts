import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX_CAPABILITIES } from "@pomtree/core";
import type { SandboxCapability } from "@pomtree/core";
import {
  MAX_DEFERRED_CAPABILITIES,
  SANDBOX_CAPABILITY_COVERAGE,
  coverageCounts,
  coverageTableFindings,
  deferralCeilingFindings,
  deferredCapabilities,
  suiteFloorFindings,
} from "./sandbox-capability-coverage.ts";
import type { CapabilityTable } from "./sandbox-capability-coverage.ts";
import { CLAUSE_IDS, declaredCapabilities, evaluateSandboxConformance, fakeSandboxUnderTest } from "./sandbox-conformance.ts";

const table: CapabilityTable = SANDBOX_CAPABILITY_COVERAGE;
const connectOnly = new Set<SandboxCapability>(["connect"]);

test("the coverage table has a row for every core capability, covered by real clauses or deferred with a reason", () => {
  assert.deepEqual(Object.keys(SANDBOX_CAPABILITY_COVERAGE).sort(), [...SANDBOX_CAPABILITIES].sort());
  assert.deepEqual(coverageTableFindings(table), []);
  for (const c of ["connect", "loopback", "files.put", "files.get"] as const) {
    const row = SANDBOX_CAPABILITY_COVERAGE[c];
    assert.ok("clauses" in row && row.clauses.every((id) => (CLAUSE_IDS as readonly string[]).includes(id)), `${c} is covered by real clause ids`);
  }
});

test("snapshot capabilities are covered by their snapshot clauses, and a reasoned deferral passes the floor while a blank one does not", () => {
  assert.deepEqual(SANDBOX_CAPABILITY_COVERAGE["snapshot.disk"], { clauses: ["snapshot-start-from"] });
  assert.deepEqual(SANDBOX_CAPABILITY_COVERAGE["snapshot.memory"], { clauses: ["snapshot-memory"] });
  assert.deepEqual(SANDBOX_CAPABILITY_COVERAGE.fork, { clauses: ["snapshot-fork"] });
  assert.deepEqual(coverageTableFindings({ ...table, "snapshot.disk": { deferred: "no clause yet, tracked as a later change" } }), []);
  assert.notDeepEqual(coverageTableFindings({ ...table, "snapshot.disk": { deferred: "" } }), []);
});

test("every deferral gives its own reason, and the deferred count stays at or below its ceiling", () => {
  const deferred = deferredCapabilities();
  assert.deepEqual(coverageCounts(), { covered: SANDBOX_CAPABILITIES.length - deferred.length, deferred: deferred.length });
  assert.ok(deferred.length > 0 && deferred.length < SANDBOX_CAPABILITIES.length);
  for (const c of deferred) {
    const row = SANDBOX_CAPABILITY_COVERAGE[c];
    assert.ok("deferred" in row && /would need|tracked as/.test(row.deferred), `${c} states what clause would cover it`);
  }
  assert.deepEqual(deferralCeilingFindings(table), []);
  assert.equal(MAX_DEFERRED_CAPABILITIES, deferred.length, "lower MAX_DEFERRED_CAPABILITIES to the deferred count when a clause lands");
  assert.match(deferralCeilingFindings(table, deferred.length - 1).join("\n"), /above the ceiling/);
});

test("negative: a missing row, a blank deferral, an unknown clause id and an empty clause list each yield a named finding", () => {
  const { connect: _c, ...missing } = SANDBOX_CAPABILITY_COVERAGE;
  assert.match(coverageTableFindings(missing).join("\n"), /capability connect has no row/);
  assert.match(coverageTableFindings({ ...table, pause: { deferred: "  " } }).join("\n"), /pause is deferred without a reason/);
  assert.match(coverageTableFindings({ ...table, pause: { clauses: ["no-such-clause" as never] } }).join("\n"), /pause names clause no-such-clause/);
  assert.match(coverageTableFindings({ ...table, pause: { clauses: [] } }).join("\n"), /pause is covered by no clause ids/);
});

test("the shared fake passes the run floor", async () => {
  const sut = fakeSandboxUnderTest();
  const report = await evaluateSandboxConformance(sut);
  assert.deepEqual(
    suiteFloorFindings({ name: sut.name, declared: declaredCapabilities(sut.capabilities), results: report.results, table, clauseIds: CLAUSE_IDS }),
    [],
  );
});

test("negative: declaring capabilities while skipping or never running their clauses fails the run floor", async () => {
  const declared = declaredCapabilities(fakeSandboxUnderTest().capabilities);
  const none = suiteFloorFindings({ name: "x", declared, results: [], table, clauseIds: CLAUSE_IDS }).join("\n");
  assert.match(none, /ran no clause/);
  assert.match(none, /declares connect, but none of its clauses \(channel-drop-throws\)/);
  const skipped = suiteFloorFindings({
    name: "x",
    declared,
    results: [
      { id: "lifecycle-run", status: "passed" },
      { id: "channel-drop-throws", status: "skipped", reason: "r" },
    ],
    table,
    clauseIds: CLAUSE_IDS,
  }).join("\n");
  assert.match(skipped, /declares connect, but none of its clauses/);
  const onlyChecks = suiteFloorFindings({ name: "x", declared: new Set(), results: [{ id: "probe", status: "passed" }], table, clauseIds: CLAUSE_IDS });
  assert.match(onlyChecks.join("\n"), /ran no clause/);
});

test("a gated clause does not satisfy the run floor, and a declared capability without a table row fails it", () => {
  const gated = [{ id: "channel-drop-throws", status: "gated", reason: "r" } as const];
  assert.match(suiteFloorFindings({ name: "x", declared: connectOnly, results: gated, table, clauseIds: CLAUSE_IDS }).join("\n"), /ran no clause/);
  const { connect: _c, ...missing } = SANDBOX_CAPABILITY_COVERAGE;
  assert.match(
    suiteFloorFindings({ name: "x", declared: connectOnly, results: gated, table: missing, clauseIds: CLAUSE_IDS }).join("\n"),
    /declares connect, which has no row/,
  );
});

// Each scenario of the fixture is a deliberately non-conforming backend or table; a spawned `node --test` must exit non-zero.
function runFixture(scenario: string | undefined) {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "sandbox-conformance.fixture.ts");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a child node --test must not think it runs inside this runner
  delete env.CONFORMANCE_NEGATIVE_SCENARIO;
  if (scenario !== undefined) env.CONFORMANCE_NEGATIVE_SCENARIO = scenario;
  const r = spawnSync(process.execPath, ["--test", fixture], { encoding: "utf8", timeout: 60000, env });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// The finding each scenario must produce, so a crash or import error cannot satisfy the non-zero exit.
const SCENARIOS: Record<string, RegExp> = {
  "probe-error": /negative control: probe down/,
  "probe-widens": /which is not declared true/,
  "declared-no-clauses": /ran no clause/,
  "all-capability-skipped": /ran no clause/,
  "gated-everything": /environment gate is closed/,
  "uncovered-capability": /capability connect has no row in the coverage table/,
  "deferred-blank-reason": /capability connect is deferred without a reason/,
};
for (const [scenario, finding] of Object.entries(SCENARIOS)) {
  test(`negative: fixture scenario ${scenario} exits non-zero with its finding`, () => {
    const r = runFixture(scenario);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, finding);
  });
}

test("the fixture with no scenario skips itself and exits zero; an unknown scenario fails naming the choices", () => {
  const unset = runFixture(undefined);
  assert.equal(unset.code, 0, unset.out);
  const unknown = runFixture("nope");
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.out, /unknown CONFORMANCE_NEGATIVE_SCENARIO/);
});
