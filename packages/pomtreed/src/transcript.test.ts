import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "./transcript.ts";

test("parseTranscript drops a torn tail and corrupt lines and keeps the newest entries", () => {
  const b = Buffer.from('{"a":1}\nnot json\n{"a":2}\n{"a":3}\n{"a":4');
  const r = parseTranscript(b, 2);
  assert.deepEqual(r.entries, [{ a: 2 }, { a: 3 }]);
  assert.equal(r.skipped, 1);
  assert.equal(r.total, 3);
});
