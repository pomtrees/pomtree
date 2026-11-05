import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenFileProblem } from "./token-file.ts";

test("accepts an owner-only file owned by the caller", () => {
  assert.equal(tokenFileProblem({ mode: 0o100600, uid: 501 }, 501, "/t"), null);
  assert.equal(tokenFileProblem({ mode: 0o100400, uid: 501 }, undefined, "/t"), null);
});

test("refuses group/world access with the chmod fix", () => {
  for (const mode of [0o100640, 0o100604, 0o100660, 0o100644]) {
    assert.match(tokenFileProblem({ mode, uid: 501 }, 501, "/t")!, /chmod 600 \/t/);
  }
});

test("refuses a file owned by someone else", () => {
  assert.match(tokenFileProblem({ mode: 0o100600, uid: 0 }, 501, "/t")!, /owned by uid 0.*chown/);
});
