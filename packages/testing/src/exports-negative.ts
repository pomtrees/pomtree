// Negative control for exports-check.ts: this file must NOT compile. It reads a name the barrel does not export, the situation a
// renamed or dropped export creates for a third-party backend author. `tsc --noEmit -p packages/testing/tsconfig.exports-negative.json`
// must exit non-zero with TS2305 naming `notExportedByTheBarrel`. It is compiled only by that config, never by the package build or the
// tests; exports-check.test.ts runs it.
import { PUBLIC_SANDBOX_TOOLKIT_EXPORTS } from "./exports-check.ts";
import { notExportedByTheBarrel } from "./index.ts";

export const names: readonly string[] = [...PUBLIC_SANDBOX_TOOLKIT_EXPORTS, String(notExportedByTheBarrel)];
