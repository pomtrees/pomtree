// Negative-control fixture for the sandbox conformance suite floor: sandbox-conformance-floor.test.ts spawns `node --test` on this file
// with CONFORMANCE_NEGATIVE_SCENARIO set to each scenario, and each must exit non-zero with its own finding. Each scenario is a
// deliberately non-conforming backend or coverage table run through `runSandboxConformance`, so the registration path's floor is what
// fails it. It is named .fixture.ts so the package's `src/**/*.test.ts` glob never runs it directly; with the variable unset the file
// registers one skipped test and exits zero.
import { test } from "node:test";
import type { Sandbox } from "@pomtree/core";
import { SANDBOX_CAPABILITY_COVERAGE } from "./sandbox-capability-coverage.ts";
import { SANDBOX_CONFORMANCE_CLAUSES, fakeSandboxUnderTest, runSandboxConformance } from "./sandbox-conformance.ts";

const NEGATIVE_SCENARIOS = [
  "probe-error",
  "probe-widens",
  "declared-no-clauses",
  "all-capability-skipped",
  "gated-everything",
  "uncovered-capability",
  "deferred-blank-reason",
] as const;
type Scenario = (typeof NEGATIVE_SCENARIOS)[number];

function register(scenario: Scenario) {
  switch (scenario) {
    case "probe-error":
      // A probe that throws must fail the run loudly, never skip clauses.
      runSandboxConformance(
        fakeSandboxUnderTest({
          name: "neg-probe-error",
          wrap: (fake) =>
            new Proxy(fake as Sandbox, {
              get: (t, p) => (p === "probe" ? async () => Promise.reject(new Error("negative control: probe down")) : Reflect.get(t, p, t)),
            }),
        }),
      );
      return;
    case "probe-widens":
      // A probe withholding a capability the backend never declared widens the declaration.
      runSandboxConformance(fakeSandboxUnderTest({ name: "neg-probe-widens", probe: { withheld: ["pause"], problems: [], account: null } }));
      return;
    case "declared-no-clauses":
      // Declares connect and files but registers no clause: the declaration and probe checks pass, the floor must not.
      runSandboxConformance(fakeSandboxUnderTest({ name: "neg-declared-no-clauses" }), { clauses: [] });
      return;
    case "all-capability-skipped":
      // Declares only a terminal (loopback is turned off) and is handed only clauses that need a capability: every clause skips and the run proves nothing.
      runSandboxConformance(
        fakeSandboxUnderTest({
          name: "neg-all-capability-skipped",
          remote: false,
          snapshots: false,
          fake: { declaration: { capabilities: { loopback: false } }, facets: { loopback: undefined } },
        }),
        {
          clauses: SANDBOX_CONFORMANCE_CLAUSES.filter((c) => c.needs.length > 0),
        },
      );
      return;
    case "gated-everything":
      // The environment gate is closed and the descriptor does not accept that: every check is gated, and a gate must not dodge the floor.
      runSandboxConformance({ ...fakeSandboxUnderTest({ name: "neg-gated-everything" }), gate: () => "negative control: gate closed" });
      return;
    case "uncovered-capability": {
      const { connect: _row, ...withoutConnect } = SANDBOX_CAPABILITY_COVERAGE;
      runSandboxConformance(fakeSandboxUnderTest({ name: "neg-uncovered-capability" }), { coverage: withoutConnect });
      return;
    }
    case "deferred-blank-reason":
      runSandboxConformance(fakeSandboxUnderTest({ name: "neg-deferred-blank-reason" }), {
        coverage: { ...SANDBOX_CAPABILITY_COVERAGE, connect: { deferred: " " } },
      });
      return;
  }
}

const scenario = process.env.CONFORMANCE_NEGATIVE_SCENARIO;
if (scenario === undefined || scenario === "") {
  test("sandbox conformance negative fixture", {
    skip: `set CONFORMANCE_NEGATIVE_SCENARIO to one of ${NEGATIVE_SCENARIOS.join(", ")} to run a negative control`,
  }, () => {});
} else if ((NEGATIVE_SCENARIOS as readonly string[]).includes(scenario)) {
  register(scenario as Scenario);
} else {
  throw new Error(
    `sandbox-conformance.fixture: unknown CONFORMANCE_NEGATIVE_SCENARIO ${JSON.stringify(scenario)}; use one of ${NEGATIVE_SCENARIOS.join(", ")}`,
  );
}
