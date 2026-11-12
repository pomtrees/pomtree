// The pomtreed polling helper routes through the shared timing module: its default is 5000 ms and its budget follows the scale.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UNTIL_DEFAULT_MS, until } from "./test-setup.ts";

const VAR = "POMTREE_TEST_TIMEOUT_SCALE";

async function budgetAt(scale: string): Promise<string> {
  const prev = process.env[VAR];
  process.env[VAR] = scale;
  try {
    await until(() => false, 50);
  } catch (e) {
    return (e as Error).message;
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
  throw new Error("until resolved on a never-true condition");
}

test("until: the timeout message reports the budget scaled by the environment", async () => {
  assert.match(await budgetAt("1"), /budget 50 ms \(50 ms x scale 1\)/);
  assert.match(await budgetAt("2"), /budget 100 ms \(50 ms x scale 2\)/);
});

test("until: the default deadline is 5000 ms", () => {
  assert.equal(UNTIL_DEFAULT_MS, 5000);
});

test("until: resolves once the condition becomes true", async () => {
  let n = 0;
  await until(() => ++n >= 3, 1000);
  assert.equal(n, 3);
});
