// Negative control for the exhaustiveness of SANDBOX_CAPABILITY_COVERAGE: this file must NOT compile. It takes the real table, drops
// the `terminal` row (the situation a capability added to core without a row creates) and checks the rest against the same type the
// table's own `satisfies` uses. `tsc --noEmit -p packages/testing/tsconfig.coverage-negative.json` must exit non-zero with TS1360 naming
// `terminal`. It is compiled only by that config, never by the package build or the tests; sandbox-mutation-sweep.test.ts runs it.
import type { SandboxCapability } from "@pomtree/core";
import { SANDBOX_CAPABILITY_COVERAGE } from "./sandbox-capability-coverage.ts";
import type { CoverageEntry } from "./sandbox-capability-coverage.ts";

const { terminal: _dropped, ...withoutTerminal } = SANDBOX_CAPABILITY_COVERAGE;

export const incomplete = withoutTerminal satisfies Record<SandboxCapability, CoverageEntry>;
