// Negative-control fixture for contract(): fakes.test.ts spawns `node --test` on this file with CONTRACT_NEGATIVE_SCENARIO set.
// It is named .fixture.ts so the package's `src/**/*.test.ts` glob never runs it directly.
import { contract } from "./fakes.ts";

const scenario = process.env.CONTRACT_NEGATIVE_SCENARIO;

if (scenario === "throw") {
  // A real adapter whose construction fails with a non-allowlisted error must fail the case, not skip it.
  const c = contract<number>("NegThrow", {
    real: () => {
      throw new Error("boom");
    },
  });
  c("body", () => {});
} else if (scenario === "no-cases") {
  // A port with a real adapter and no registered cases is silent zero coverage; the after() hook must fail.
  contract<number>("NegNoCases", { real: () => 1 });
} else if (scenario === "gated" || scenario === "gated-require-real") {
  // Every case gate-skipped: passes by default, fails when the scenario is gated-require-real (requireReal: true).
  const c = contract<number>("NegGated", { real: () => 1, gate: () => "negative control gate closed", requireReal: scenario === "gated-require-real" });
  c("one", () => {});
  c("two", () => {});
} else if (scenario === "shared-label") {
  // Two sites share a label; the empty one must still be caught even though its sibling registers a case.
  contract<number>("NegShared", { real: () => 1 });
  const c = contract<number>("NegShared", { real: () => 1 });
  c("only", () => {});
} else {
  throw new Error(
    `contract-negative.fixture: set CONTRACT_NEGATIVE_SCENARIO to throw, no-cases, gated, gated-require-real or shared-label (got ${scenario ?? "nothing"})`,
  );
}
