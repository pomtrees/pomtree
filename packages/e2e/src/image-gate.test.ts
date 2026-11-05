import assert from "node:assert/strict";
import { test } from "node:test";
import { imageRevisionSkip } from "./image-gate.ts";

test("image revision gate: matching short or full revisions pass", () => {
  assert.equal(imageRevisionSkip("img", "a2ad369", "a2ad369", false), false);
  assert.equal(imageRevisionSkip("img", "a2ad369", "a2ad369f00d", false), false);
});

test("image revision gate: stale, unlabelled or unknown revisions skip with a reason", () => {
  assert.match(String(imageRevisionSkip("img", "f2fb7cc", "a2ad369", false)), /built from f2fb7cc, this checkout is a2ad369/);
  assert.match(String(imageRevisionSkip("img", "", "a2ad369", false)), /no org\.opencontainers\.image\.revision label/);
  assert.match(String(imageRevisionSkip("img", "a2ad369", undefined, false)), /cannot determine/);
});

test("image revision gate: dirty adapter or image sources skip even when the image revision matches", () => {
  assert.match(String(imageRevisionSkip("img", "a2ad369", "a2ad369", true)), /sources differ from a2ad369 or have untracked files/);
  assert.match(String(imageRevisionSkip("img", "f2fb7cc", "a2ad369", true)), /untracked files/, "dirty is checked before the mismatch");
  assert.match(String(imageRevisionSkip("img", "", "a2ad369", true)), /untracked files/, "dirty is checked before the missing label");
});

test("image revision gate: clean sources with a matching image pass; unknown revision still skips first", () => {
  assert.equal(imageRevisionSkip("img", "a2ad369", "a2ad369f00d", false), false);
  assert.match(String(imageRevisionSkip("img", "a2ad369", undefined, true)), /cannot determine/);
});
