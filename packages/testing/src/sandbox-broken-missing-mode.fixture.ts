// Negative control for the exhaustiveness of BREAK_MODES: this file must NOT compile. It checks the real table against the clause ids
// plus one that was "added without a mode", which is the situation a new entry in CLAUSE_IDS creates. `tsc --noEmit -p
// packages/testing/tsconfig.negative.json` must exit non-zero with TS1360 naming that id. It is compiled only by that config, never by
// the package build or the tests; the real table's own `satisfies` is proven separately in sandbox-broken.test.ts.
import { BREAK_MODES } from "./sandbox-broken.ts";
import type { BreakMode } from "./sandbox-broken.ts";
import type { ClauseId } from "./sandbox-conformance.ts";

export const incomplete = BREAK_MODES satisfies Record<ClauseId | "clause-added-without-a-mode", BreakMode>;
