import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_TOOL_DETAILS_BYTES } from "@pomtree/core";
import { IMAGES_KEY, IMAGES_OMITTED_KEY, MAX_IMAGE_HASH_BYTES, MAX_IMAGE_REFS, TOOL_DETAILS_KEY, imageRef } from "./image-ref.ts";
import { normalizeRecord } from "./pi-format.ts";

const png = Buffer.from("\x89PNG\r\n\x1a\nfake-pixels");
const b64 = png.toString("base64");
const sha = createHash("sha256").update(png).digest("hex");
const block = (extra: Record<string, unknown> = {}) => ({ type: "image", data: b64, mimeType: "image/png", ...extra });
const end = (result: unknown) =>
  normalizeRecord({ type: "tool_execution_end", toolCallId: "c1", toolName: "shot", result })[0] as {
    output: string;
    details?: Record<string, unknown>;
  };

const imgs = (ev: { details?: Record<string, unknown> }): unknown[] => (ev.details?.[IMAGES_KEY] ?? []) as unknown[];

test("image result: a reference (mime, bytes, sha256 of the decoded bytes), never the payload", () => {
  const ev = end({ content: [block()] });
  assert.deepEqual(ev.details, { [IMAGES_KEY]: [{ kind: "image", mime: "image/png", bytes: png.length, sha256: sha, status: "ok" }] });
  assert.ok(!JSON.stringify(ev).includes(b64));
  assert.equal(ev.output, "");
});

test("mixed text and image: text stays output, the image is a reference; several images keep order; extras are counted", () => {
  const ev = end({ content: [{ type: "text", text: "shot taken" }, block(), { type: "text", text: "!" }, block({ mimeType: "image/jpeg" })] });
  assert.equal(ev.output, "shot taken!");
  assert.deepEqual(
    imgs(ev).map((r) => (r as { mime: string }).mime),
    ["image/png", "image/jpeg"],
  );
  const many = end({ content: Array.from({ length: MAX_IMAGE_REFS + 3 }, () => block()) });
  assert.equal(imgs(many).length, MAX_IMAGE_REFS);
  assert.equal(many.details?.[IMAGES_OMITTED_KEY], 3);
  assert.ok(new TextEncoder().encode(JSON.stringify(many.details)).length <= MAX_TOOL_DETAILS_BYTES);
});

test("tool details survive beside the refs; non-object details nest; oversize tool details yield to the refs", () => {
  assert.deepEqual(end({ content: [block()], details: { page: 2 } }).details?.page, 2);
  assert.equal(end({ content: [block()], details: "s" }).details?.[TOOL_DETAILS_KEY], "s");
  const big = end({ content: Array.from({ length: MAX_IMAGE_REFS }, () => block()), details: { x: "y".repeat(5000) } });
  assert.equal(big.details?.pomtree_dropped, "oversize");
  assert.equal(imgs(big).length, MAX_IMAGE_REFS);
});

test("no image blocks: details are exactly the bounded tool details (absent stays absent)", () => {
  assert.equal(end({ content: [{ type: "text", text: "a" }] }).details, undefined);
  assert.ok(!("details" in end({ content: [{ type: "text", text: "a" }] })));
  assert.deepEqual(end({ content: "plain", details: { a: 1 } }).details, { a: 1 });
});

test("negative: absent, empty or non-string data is no_data with no size or hash", () => {
  for (const data of [undefined, "", 5, null, { x: 1 }])
    assert.deepEqual(imageRef({ type: "image", data, mimeType: "image/png" }), { kind: "image", mime: "image/png", status: "no_data" });
});

test("negative: malformed base64 is reported malformed, not hashed", () => {
  for (const data of ["not base64!", "abc", "ab=c", "AAAA=", `${b64}\n`])
    assert.deepEqual(imageRef({ type: "image", data, mimeType: "image/png" }), { kind: "image", mime: "image/png", status: "malformed" });
});

test("negative: unknown, absent or hostile mime becomes 'unknown'; a well-formed unlisted type is kept", () => {
  for (const mimeType of [undefined, 7, "", "png", "image/png; x".padEnd(200, "x"), "<script>/x"]) assert.equal(imageRef(block({ mimeType })).mime, "unknown");
  assert.equal(imageRef(block({ mimeType: "Image/X-Weird" })).mime, "image/x-weird");
  assert.equal(imageRef(block({ mimeType: "unknown/thing" })).status, "ok");
});

test("oversize: past the decode cap the size comes from the length, nothing is hashed or validated", () => {
  const chars = Math.ceil(MAX_IMAGE_HASH_BYTES / 3) * 4 + 4;
  const data = `${"A".repeat(chars - 2)}==`;
  assert.deepEqual(imageRef({ type: "image", data, mimeType: "image/png" }), {
    kind: "image",
    mime: "image/png",
    bytes: (chars * 3) / 4 - 2,
    status: "oversize",
  });
  // At the cap exactly it is still decoded and hashed.
  const atCap = Buffer.alloc(MAX_IMAGE_HASH_BYTES, 1);
  const ref = imageRef({ type: "image", data: atCap.toString("base64"), mimeType: "image/png" });
  assert.equal(ref.status, "ok");
  assert.equal(ref.bytes, MAX_IMAGE_HASH_BYTES);
});

test("oversize: a single '=' pad is one byte, not two", () => {
  const chars = Math.ceil(MAX_IMAGE_HASH_BYTES / 3) * 4 + 4;
  const data = `${"A".repeat(chars - 1)}=`;
  assert.deepEqual(imageRef({ type: "image", data, mimeType: "image/png" }), {
    kind: "image",
    mime: "image/png",
    bytes: (chars * 3) / 4 - 1,
    status: "oversize",
  });
});

test("negative: non-image blocks and a non-array content yield no refs", () => {
  assert.equal(end({ content: [{ type: "text", text: "x", data: b64 }, "image", null] }).details, undefined);
  assert.equal(end({ content: { type: "image", data: b64 } }).details, undefined);
});
