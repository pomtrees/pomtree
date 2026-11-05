import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveReportKey, isTextMediaType, renderReport, reportPublishQuery } from "./reports.ts";

test("effectiveReportKey prefers the explicit key and otherwise issues a fresh per-invocation key", () => {
  assert.equal(effectiveReportKey("k1"), "k1");
  assert.notEqual(effectiveReportKey(), effectiveReportKey()); // two identical publishes are not deduplicated
  assert.match(effectiveReportKey(), /^[0-9a-f-]{36}$/);
});

test("isTextMediaType matches text/* only", () => {
  assert.equal(isTextMediaType("text/plain"), true);
  assert.equal(isTextMediaType("text/html; charset=utf-8"), true);
  assert.equal(isTextMediaType("application/json"), false);
  assert.equal(isTextMediaType("image/png"), false);
});

test("reportPublishQuery encodes the required key and optional params", () => {
  assert.equal(reportPublishQuery({ key: "k" }), "key=k");
  const q = new URLSearchParams(reportPublishQuery({ name: "r", mediaType: "text/html", generation: "3", key: "k" }));
  assert.equal(q.get("name"), "r");
  assert.equal(q.get("mediaType"), "text/html");
  assert.equal(q.get("generation"), "3");
  assert.equal(q.get("key"), "k");
});

test("renderReport formats the metadata fields", () => {
  const r = { id: "r1", agent: "a1", generation: 2, host: "h", name: "n", mediaType: "text/plain", sizeBytes: 5, sha256: "abc", createdAt: 0 };
  const out = renderReport(r);
  assert.match(out, /id:         r1/);
  assert.match(out, /agent:      a1/);
  assert.match(out, /type:       text\/plain/);
  assert.match(out, /size:       5 bytes/);
  assert.match(out, /sha256:     abc/);
  assert.match(out, /created:    1970-01-01T00:00:00\.000Z/);
});
