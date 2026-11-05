import assert from "node:assert/strict";
import { test } from "node:test";
import { dispositionError } from "@pomtree/core";
import { spawnDisposition } from "./cli.ts";

// Drift test: the client-side --disposition/--ttl checks must refuse exactly what core's `dispositionError` (the
// authority the daemon applies) refuses, for the body the flags would produce.
const MODES = [undefined, "hold", "reap-on-exit", "bogus", "", "HOLD"];
// ttl flag text -> the millisecond value it denotes (NaN when it is not a duration at all).
const TTLS: Array<[string | undefined, number | undefined]> = [
  [undefined, undefined],
  ["0", 0],
  ["0s", 0],
  ["1", 1],
  ["5000", 5000],
  ["30m", 1_800_000],
  ["2h", 7_200_000],
  ["abc", Number.NaN],
  ["-5", Number.NaN],
  ["1.5h", Number.NaN],
];

const refuses = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

test("pomtree spawn --disposition/--ttl refuses exactly the inputs core's dispositionError refuses", () => {
  let accepted = 0;
  let refused = 0;
  for (const mode of MODES) {
    for (const [ttlFlag, ttlMs] of TTLS) {
      if (mode === undefined && ttlFlag === undefined) {
        assert.equal(spawnDisposition(mode, ttlFlag), undefined, "no flags sends no disposition");
        continue;
      }
      const body = { mode: mode ?? "hold", ...(ttlFlag !== undefined && { ttlMs }) };
      const authority = dispositionError(body) !== null;
      const cli = refuses(() => spawnDisposition(mode, ttlFlag));
      assert.equal(cli, authority, `--disposition ${JSON.stringify(mode)} --ttl ${JSON.stringify(ttlFlag)}: cli refuses=${cli}, core refuses=${authority}`);
      if (cli) refused++;
      else {
        accepted++;
        assert.equal(dispositionError(spawnDisposition(mode, ttlFlag)), null, "the body the CLI sends passes core");
      }
    }
  }
  assert.ok(accepted > 0 && refused > 0, `enumeration must cover both outcomes (accepted ${accepted}, refused ${refused})`);
});
