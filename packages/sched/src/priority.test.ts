import { test } from "node:test";
import assert from "node:assert/strict";
import { PRIORITY } from "./priority.ts";

test("PRIORITY pins the class values: alert 0, interactive 1, scheduled 2", () => {
  assert.deepEqual(PRIORITY, { alert: 0, interactive: 1, scheduled: 2 });
});
