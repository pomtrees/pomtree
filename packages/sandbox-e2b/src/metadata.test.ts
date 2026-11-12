import assert from "node:assert/strict";
import test from "node:test";
import { decodeMetadata, metadataQuery, sandboxMetadata, sandboxSelector } from "./metadata.ts";

test("plain tags are stored as-is; a value the filter string cannot carry is hashed with its annotation, and decodes back", () => {
  const m = sandboxMetadata("abc", "agent&one=two", { store_id: "s1" });
  assert.equal(m["pomtree.sandbox"], "abc");
  assert.match(m["pomtree.agent"] ?? "", /^h\.[0-9a-f]{40}$/, "a value with & or = would break the k=v&k=v filter, so it is hashed");
  assert.equal(m["pomtree.dev/tag.pomtree.agent"], "agent&one=two");
  const d = decodeMetadata(m);
  assert.deepEqual(d.tags, { "pomtree.sandbox": "abc", "pomtree.agent": "agent&one=two", "pomtree.backend": "e2b" });
  assert.deepEqual(d.unresolved, []);
  assert.deepEqual(d.labels, { store_id: "s1" });
});

test("a hashed tag without its annotation is unresolved, never trusted", () => {
  const d = decodeMetadata({ "pomtree.sandbox": `h.${"0".repeat(40)}`, other: "x" });
  assert.deepEqual(d.unresolved, ["pomtree.sandbox"]);
  assert.deepEqual(d.labels, { other: "x" });
});

test("the metadata filter is k=v&k=v with each part URL-encoded", () => {
  assert.equal(metadataQuery({ a: "1", "b c": "x/y" }), "a=1&b%20c=x%2Fy");
  assert.deepEqual(sandboxSelector("abc"), { "pomtree.sandbox": "abc" });
});
