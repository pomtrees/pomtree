import assert from "node:assert/strict";
import { test } from "node:test";
import { clipAgentText } from "./daemon-util.ts";

test("clipAgentText removes each invisible class", () => {
  const cases: [string, string][] = [
    ["bidi override", "a\u202eb"],
    ["bidi isolates", "a\u2066b\u2069c"],
    ["zero-width", "a\u200bb\u200dc"],
    ["BOM", "a\ufeffb"],
    ["line separator", "a\u2028b"],
  ];
  for (const [name, input] of cases) assert.equal(clipAgentText(input, 100), input.replace(/[^a-c]/g, ""), name);
});

test("clipAgentText still strips control characters and caps with the marker, counting visible text only", () => {
  assert.equal(clipAgentText("a\u0000b\u001b[1mc", 100), "ab[1mc");
  assert.equal(clipAgentText(`${"\u200b".repeat(50)}abcdef`, 4), "abcd… [truncated 2 chars]");
});

test("clipAgentText leaves ordinary visible text unchanged", () => {
  for (const s of ["line one\n\tindented", "café naïve Ångström", "日本語のテキスト", "ok 👍 done"]) assert.equal(clipAgentText(s, 100), s);
});
