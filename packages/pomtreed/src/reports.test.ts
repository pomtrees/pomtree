import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CAPTURE_ARTIFACT_ROLES } from "@pomtree/core";
import { CAPTURE_REPORT_NAME_MAX, inferMediaType, isAllowedMediaType, reportIdFor, sha256hex, slugifyReportName } from "./reports.ts";

test("slugifyReportName collapses invalid runs, strips leading dots, and caps length", () => {
  assert.equal(slugifyReportName("My Report.html"), "My-Report.html");
  assert.equal(slugifyReportName("foo/bar\\baz"), "foo-bar-baz");
  assert.equal(slugifyReportName("..hidden"), "hidden");
  assert.equal(slugifyReportName(".dotfile"), "dotfile");
  assert.equal(slugifyReportName("abc-123_X.Y"), "abc-123_X.Y"); // valid chars pass through
  assert.equal(slugifyReportName("a".repeat(100)).length, 64);
});

test("slugifyReportName rejects names with no valid slug", () => {
  assert.throws(() => slugifyReportName(""), /slugifies to nothing/);
  assert.throws(() => slugifyReportName("."), /slugifies to nothing/);
  assert.throws(() => slugifyReportName(".."), /slugifies to nothing/);
  assert.throws(() => slugifyReportName("..."), /slugifies to nothing/);
  // @ts-expect-error a non-string is rejected at the boundary
  assert.throws(() => slugifyReportName(undefined));
});

test("inferMediaType maps the extension allowlist and defaults to text/plain", () => {
  assert.equal(inferMediaType("notes.md"), "text/markdown");
  assert.equal(inferMediaType("page.html"), "text/html");
  assert.equal(inferMediaType("data.csv"), "text/csv");
  assert.equal(inferMediaType("data.json"), "application/json");
  assert.equal(inferMediaType("doc.pdf"), "application/pdf");
  assert.equal(inferMediaType("pic.png"), "image/png");
  assert.equal(inferMediaType("pic.jpg"), "image/jpeg");
  assert.equal(inferMediaType("pic.jpeg"), "image/jpeg");
  assert.equal(inferMediaType("anim.gif"), "image/gif");
  assert.equal(inferMediaType("diagram.svg"), "image/svg+xml");
  assert.equal(inferMediaType("README"), "text/plain"); // no extension
});

test("inferMediaType rejects off-allowlist extensions", () => {
  assert.throws(() => inferMediaType("notes.txt"), /unsupported report extension/);
  assert.throws(() => inferMediaType("app.exe"), /unsupported report extension/);
  assert.throws(() => inferMediaType("report.tar.gz"), /unsupported report extension/);
});

test("isAllowedMediaType accepts only the report media types", () => {
  for (const mt of [
    "text/plain",
    "text/markdown",
    "text/html",
    "text/csv",
    "application/json",
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/svg+xml",
  ]) {
    assert.equal(isAllowedMediaType(mt), true, mt);
  }
  assert.equal(isAllowedMediaType("application/x-foo"), false);
  assert.equal(isAllowedMediaType("text/x-markdown"), false);
});

test("reportIdFor is a deterministic lowercase sha256 of agent\\0name\\0key", () => {
  const id = reportIdFor("a1", "report.md", "k1");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, createHash("sha256").update("a1\0report.md\0k1").digest("hex"));
  assert.equal(id, reportIdFor("a1", "report.md", "k1"));
  assert.notEqual(id, reportIdFor("a1", "report.md", "k2"));
  assert.notEqual(id, reportIdFor("a2", "report.md", "k1"));
});

test("sha256hex matches node's own digest", () => {
  assert.equal(sha256hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256hex(Buffer.from("hello")), createHash("sha256").update("hello").digest("hex"));
});

test("capture/<job>/<role> names keep their segments for every artifact role; other names slug exactly as before", () => {
  const job = `cj-${"a".repeat(64)}`;
  for (const role of CAPTURE_ARTIFACT_ROLES) assert.equal(slugifyReportName(`capture/${job}/${role}`), `capture/${job}/${role}`);
  const longest = `capture/${"j".repeat(128)}/screenshot`;
  assert.equal(longest.length, CAPTURE_REPORT_NAME_MAX);
  assert.equal(slugifyReportName(longest), longest);
  // Every other name: the unchanged slug rule ("/" becomes "-", 64-character cap).
  assert.equal(slugifyReportName("foo/bar\\baz"), "foo-bar-baz");
  assert.equal(slugifyReportName("captures/x"), "captures-x");
  assert.equal(slugifyReportName(`cap/${job}/raw`), `cap-${job}-raw`.slice(0, 64));
});

test("capture report names refuse traversal, empty segments, bad job ids, unknown roles and over-length names, naming the fix", () => {
  const job = `cj-${"a".repeat(64)}`;
  const fix = /name a capture artifact capture\/<job>\/<role>/;
  for (const [bad, cause] of [
    [`capture/../raw`, /"\." or "\.\." segment/],
    [`capture/${job}/..`, /"\." or "\.\." segment/],
    [`capture//raw`, /empty segment/],
    [`capture/${job}/`, /empty segment/],
    [`capture/-bad/raw`, /invalid job id/],
    [`capture/a.b/raw`, /invalid job id/],
    [`capture/${job}/video`, /unknown role "video"/],
    [`capture/${job}/raw/extra`, /3 segments after capture\/, not 2/],
    [`capture/${"j".repeat(129)}/raw`, /invalid job id/],
    [`capture/${"j".repeat(200)}/raw`, /212 characters, over 147/],
  ] as const) {
    assert.throws(() => slugifyReportName(bad), cause, bad);
    assert.throws(() => slugifyReportName(bad), fix, bad);
  }
});

test("application/zip is allowed only for a capture/<job>/wacz name", () => {
  const job = `cj-${"a".repeat(64)}`;
  assert.equal(isAllowedMediaType("application/zip", `capture/${job}/wacz`), true);
  assert.equal(isAllowedMediaType("application/zip", `capture/${job}/raw`), false, "a non-wacz role");
  assert.equal(isAllowedMediaType("application/zip", "archive.zip"), false, "outside capture/");
  assert.equal(isAllowedMediaType("application/zip"), false, "no name");
  assert.equal(isAllowedMediaType("text/html", `capture/${job}/raw`), true, "the usual types still pass for capture names");
});
