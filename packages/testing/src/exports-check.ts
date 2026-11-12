// The public sandbox toolkit of `@pomtree/testing`: the names a third-party backend author imports (the sandbox backend author documentation) and so
// must stay exported from the package barrel (`index.ts`, the package's only entry point). exports-check.test.ts checks every name at
// runtime; the `satisfies` clauses below check them at type level, so a dropped or renamed export fails `tsc -p packages/testing`.
//
// Deliberately NOT promised, though some are reachable through `export *`: the model of the provider stub (`provider-stub/model.ts`:
// ProviderModel, bodySha256, MODEL_VERB_CLAUSES), the extended clause table (`sandbox-conformance-extra.ts`, reached through
// SANDBOX_CONFORMANCE_CLAUSES), and break-mode internals (SimulatedEngine, SimulatedProvider and the wrapper builders in sandbox-broken.ts). They are
// implementation detail an author need not call; promising them would freeze them. Only the provider stub's `FaultPlan` is renamed: it is
// exported as `ProviderFaultPlan` because the fake sandbox's `FaultPlan` already holds that name.
import type * as Barrel from "./index.ts";

/** Values (functions, classes, constants) the author docs promise. */
export const PUBLIC_SANDBOX_TOOLKIT_EXPORTS = [
  // conformance runner, clauses, floor and coverage
  "runSandboxConformance",
  "evaluateSandboxConformance",
  "fakeSandboxUnderTest",
  "SANDBOX_CONFORMANCE_CLAUSES",
  "CLAUSE_IDS",
  "SANDBOX_CAPABILITY_COVERAGE",
  "coverageTableFindings",
  "coverageCounts",
  "suiteFloorFindings",
  // fake sandbox and fault plan
  "FakeSandbox",
  "fakeSandboxDeclaration",
  "FaultPlan",
  "assertStartIdempotent",
  // broken-sandbox decorator
  "brokenSandbox",
  "BREAK_MODES",
  // provider stub, fixture loader, identity helper
  "ProviderStub",
  "ProviderFaultPlan",
  "FAULT_NAMES",
  "BREAK_FAULTS",
  "loadFixture",
  "parseFixture",
  "assertFixtureFresh",
  "FixtureError",
  "identityCollector",
  "assertAllRequestsCarry",
  // schema check
  "checkSchema",
  "assertSchema",
  "kubernetesPodCreate",
] as const satisfies readonly (keyof typeof Barrel)[];

/** Types the author docs promise; the `satisfies` below fails to compile when one stops being exported. */
export type PublicSandboxToolkitTypes = [
  Barrel.SandboxUnderTest,
  Barrel.SandboxConformanceHooks,
  Barrel.ConformanceOptions,
  Barrel.ConformanceReport,
  Barrel.ClauseId,
  Barrel.CapabilityTable,
  Barrel.FakeSandboxOptions,
  Barrel.BreakModeName,
  Barrel.ProviderStubOptions,
  Barrel.Fixture,
  Barrel.IdentityCollector,
  Barrel.Schema,
];
