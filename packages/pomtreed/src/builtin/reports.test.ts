import assert from "node:assert/strict";
import { test } from "node:test";
import { isActiveMediaType } from "./reports.ts";

test("isActiveMediaType: case-insensitive base type, parameters ignored, xhtml included", () => {
  for (const t of ["text/html", "TEXT/HTML", "text/html; charset=utf-8", "image/svg+xml", "Image/SVG+XML;x=1", "application/xhtml+xml"]) {
    assert.equal(isActiveMediaType(t), true, t);
  }
  for (const t of ["text/markdown", "text/plain", "application/json"]) assert.equal(isActiveMediaType(t), false, t);
});
