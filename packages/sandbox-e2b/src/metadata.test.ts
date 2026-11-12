import assert from "node:assert/strict";
import test from "node:test";
import { readOwnerStamp } from "@pomtree/core";
import { decodeMetadata, metadataQuery, sandboxMetadata, sandboxSelector } from "./metadata.ts";

test("plain tags are stored as-is; a value the filter string cannot carry is hashed with its annotation, and decodes back", () => {
  const m = sandboxMetadata("abc", "agent&one=two", { host: "host-a", generation: 4 }, { store_id: "s1" });
  assert.equal(m["pomtree.sandbox"], "abc");
  assert.match(m["pomtree.agent"] ?? "", /^h\.[0-9a-f]{40}$/, "a value with & or = would break the k=v&k=v filter, so it is hashed");
  assert.equal(m["pomtree.dev/tag.pomtree.agent"], "agent&one=two");
  const d = decodeMetadata(m);
  assert.deepEqual(d.tags, {
    "pomtree.sandbox": "abc",
    "pomtree.agent": "agent&one=two",
    "pomtree.backend": "e2b",
    "pomtree.host": "host-a",
    "pomtree.generation": "4",
  });
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

test("the owner stamp is stored as metadata and round-trips; a host the filter string cannot carry or the limit exceeds is hashed and decodes back", () => {
  const long = `host-${"h".repeat(200)}`;
  for (const host of ["host-a", "host&1=2", long]) {
    const m = sandboxMetadata("abc", "a", { host, generation: 9 }, undefined);
    const d = decodeMetadata(m);
    assert.deepEqual(readOwnerStamp(d.tags), { host, generation: 9 }, host);
    assert.deepEqual(d.unresolved, []);
    if (host !== "host-a") assert.match(m["pomtree.host"] ?? "", /^h\.[0-9a-f]{40}$/, "an unsafe or over-long host is hashed");
    assert.ok(Object.values(m).every((v) => v.length <= 256));
  }
  assert.throws(() => sandboxMetadata("abc", "a", { host: "", generation: 1 }, undefined), /host id.*pass the daemon's host id/s);
  assert.throws(() => sandboxMetadata("abc", "a", { host: "h", generation: -1 }, undefined), /generation.*pass the agent's generation/s);
});
