import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { allowlistHeaders } from "./capture-types.ts";
import { httpRequestBlock, httpResponseBlock, parseWarcGz, parseWarcRecord, sha256Hex, splitHttpBlock, warcGzMember, warcRecord } from "./warc.ts";

const ID = "<urn:uuid:11111111-2222-3333-4444-555555555555>";
const str = (b: Uint8Array) => Buffer.from(b).toString("utf8");

test("resource record bytes are exactly the hand-written header block", () => {
  const got = str(
    warcRecord({
      type: "resource",
      recordId: ID,
      date: "2026-10-24T12:00:00Z",
      targetUri: "https://example.com/a",
      contentType: "text/plain",
      block: Buffer.from("hello"),
    }),
  );
  const want =
    "WARC/1.1\r\nWARC-Type: resource\r\nWARC-Record-ID: <urn:uuid:11111111-2222-3333-4444-555555555555>\r\nWARC-Date: 2026-10-24T12:00:00Z\r\n" +
    "WARC-Target-URI: https://example.com/a\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n" +
    "WARC-Block-Digest: sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\r\n\r\nhello\r\n\r\n";
  assert.equal(got, want);
});

test("response record digests the whole block and the entity body separately", () => {
  const block = httpResponseBlock({ status: 200, statusText: "OK", headers: [["Content-Type", "text/plain"]], body: Buffer.from("hi") });
  assert.equal(str(block), "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhi");
  const { headers } = parseWarcRecord(
    warcRecord({
      type: "response",
      recordId: ID,
      date: "2026-10-24T12:00:00.5Z",
      targetUri: "http://example.com/",
      contentType: "application/http;msgtype=response",
      block,
    }),
  );
  assert.equal(headers.get("warc-block-digest"), "sha256:31f06f664d6aba13e6c4d8602e5bc0821b3fa10dc7ec85c333c006b0a0232ffe");
  assert.equal(headers.get("warc-payload-digest"), "sha256:8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4");
  assert.equal(headers.get("content-length"), "47");
});

test("request block uses path+query as the request target and keeps Host as given", () => {
  const b = httpRequestBlock({ method: "GET", url: "https://example.com/a/b?x=1#frag", headers: [["Host", "example.com"]] });
  assert.equal(str(b), "GET /a/b?x=1 HTTP/1.1\r\nHost: example.com\r\n\r\n");
  assert.equal(str(httpRequestBlock({ method: "POST", url: "http://h", headers: [], body: Buffer.from("x") })), "POST / HTTP/1.1\r\n\r\nx");
});

test("header injection and bad inputs are refused", () => {
  const ok = { type: "resource" as const, date: "2026-10-24T12:00:00Z", targetUri: "https://e.com/", contentType: "text/plain", block: new Uint8Array(0) };
  assert.throws(() => warcRecord({ ...ok, targetUri: "https://e.com/\r\nWARC-Payload-Digest: sha256:00" }), /CR, LF or NUL/);
  assert.throws(() => warcRecord({ ...ok, contentType: "text/plain\nX: y" }), /CR, LF or NUL/);
  assert.throws(() => warcRecord({ ...ok, extra: [["X-A", "v\0"]] }), /CR, LF or NUL/);
  assert.throws(() => warcRecord({ ...ok, extra: [["X A", "v"]] }), /token/);
  assert.throws(() => warcRecord({ ...ok, targetUri: "ftp://e.com/" }), /http\(s\)/);
  assert.throws(() => warcRecord({ ...ok, targetUri: "/relative" }), /absolute/);
  assert.throws(() => warcRecord({ ...ok, targetUri: undefined }), /needs a targetUri/);
  assert.throws(() => warcRecord({ ...ok, date: "2026-10-24" }), /date/);
  assert.throws(() => warcRecord({ ...ok, filename: "x.warc" }), /warcinfo/);
  assert.throws(() => httpResponseBlock({ status: 200, statusText: "OK\r\nX: y", headers: [], body: new Uint8Array(0) }), /CR, LF or NUL/);
  assert.throws(() => httpResponseBlock({ status: 200, statusText: "OK", headers: [["A", "b\r\nC: d"]], body: new Uint8Array(0) }), /CR, LF or NUL/);
  assert.throws(() => httpResponseBlock({ status: 200, statusText: "OK", headers: [["A\r\nB", "c"]], body: new Uint8Array(0) }), /token/);
  assert.throws(() => httpRequestBlock({ method: "GET /", url: "http://h/", headers: [] }), /method/);
  // an http response record whose block has no header terminator cannot have a payload digest
  assert.throws(
    () => warcRecord({ ...ok, type: "response", contentType: "application/http;msgtype=response", block: Buffer.from("HTTP/1.1 200 OK") }),
    /terminator/,
  );
});

test("warcinfo carries filename and extra headers; metadata may omit the target", () => {
  const r = parseWarcRecord(
    warcRecord({
      type: "warcinfo",
      date: "2026-10-24T12:00:00Z",
      contentType: "application/warc-fields",
      block: Buffer.from("capture-method: cdp\r\n"),
      filename: "data.warc.gz",
      extra: [["X-Note", "n"]],
    }),
  );
  assert.equal(r.headers.get("warc-filename"), "data.warc.gz");
  assert.equal(r.headers.get("x-note"), "n");
  assert.match(r.headers.get("warc-record-id") ?? "", /^<urn:uuid:[0-9a-f-]{36}>$/);
});

test("parseWarcGz walks concatenated members with exact compressed offsets", () => {
  const recs = ["a", "bb".repeat(5000), ""].map((s, i) =>
    warcRecord({
      type: "resource",
      recordId: ID,
      date: "2026-10-24T12:00:00Z",
      targetUri: `https://e.com/${i}`,
      contentType: "text/plain",
      block: Buffer.from(s),
    }),
  );
  const members = recs.map((r) => Buffer.from(warcGzMember(r)));
  const all = Buffer.concat(members);
  const parsed = parseWarcGz(all);
  assert.equal(parsed.length, 3);
  let off = 0;
  for (const [i, p] of parsed.entries()) {
    assert.equal(p.offset, off);
    assert.equal(p.length, members[i]?.length);
    assert.equal(p.headers.get("warc-target-uri"), `https://e.com/${i}`);
    off += p.length;
  }
  assert.equal(parsed[1]?.block.byteLength, 10000);
  // each member decodes alone, which is what a range-reading replayer does
  assert.equal(parseWarcGz(all.subarray(parsed[1]?.offset, (parsed[1]?.offset ?? 0) + (parsed[1]?.length ?? 0))).length, 1);
  assert.equal(members[0]?.[9], 3);
});

test("the reader is bounded and refuses malformed input", () => {
  const huge = `WARC/1.1\r\nX: ${"a".repeat(70000)}\r\n\r\n`;
  assert.throws(() => parseWarcRecord(Buffer.from(huge)), /64 KiB/);
  assert.throws(() => parseWarcRecord(Buffer.from("WARC/1.1\r\nContent-Length: 99\r\n\r\nhi\r\n\r\n")), /beyond/);
  assert.throws(() => parseWarcRecord(Buffer.from("WARC/1.1\r\nContent-Length: 2\r\n\r\nhiXXXX")), /CRLF CRLF/);
  assert.throws(() => parseWarcRecord(Buffer.from("HTTP/1.1\r\nContent-Length: 0\r\n\r\n\r\n\r\n")), /version/);
  assert.throws(() => parseWarcGz(Buffer.from("not gzip")), /gzip/);
  const good = warcGzMember(
    warcRecord({
      type: "resource",
      date: "2026-10-24T12:00:00Z",
      targetUri: "https://e.com/",
      contentType: "text/plain",
      block: Buffer.from("x".repeat(1000)),
    }),
  );
  assert.throws(() => parseWarcGz(good.subarray(0, good.length - 3)), /./);
  assert.throws(() => parseWarcGz(good, { maxRecordBytes: 100 }), /./);
  assert.throws(() => parseWarcGz(gzipSync(Buffer.from("not a warc record"))), /warc/);
});

test("allowlistHeaders lowercases, drops unlisted and joins duplicates", () => {
  assert.deepEqual(
    allowlistHeaders([
      ["Content-Type", "text/html"],
      ["Set-Cookie", "a=b"],
      ["Vary", "Accept"],
      ["vary", "Cookie"],
    ]),
    { "content-type": "text/html", vary: "Accept, Cookie" },
  );
  assert.deepEqual(allowlistHeaders({ ETag: '"x"', "X-Proxy": "1" }), { etag: '"x"' });
});

test("urn: targets are accepted for resource and metadata only, and still refuse injection", () => {
  const base = { date: "2026-10-24T12:00:00Z", contentType: "text/plain", block: new Uint8Array(0) };
  for (const type of ["resource", "metadata"] as const) {
    const h = parseWarcRecord(warcRecord({ ...base, type, targetUri: "urn:view:https://example.com/a?b=1" })).headers;
    assert.equal(h.get("warc-target-uri"), "urn:view:https://example.com/a?b=1");
  }
  const http = { contentType: "application/http;msgtype=response", block: Buffer.from("HTTP/1.1 200 OK\r\n\r\n") };
  assert.throws(() => warcRecord({ ...base, ...http, type: "response", targetUri: "urn:view:https://example.com/" }), /resource and metadata/);
  assert.throws(() => warcRecord({ ...base, ...http, type: "request", targetUri: "urn:text:https://example.com/" }), /resource and metadata/);
  assert.throws(() => warcRecord({ ...base, type: "resource", targetUri: "urn:view:https://example.com/\r\nX: y" }), /CR, LF or NUL/);
  assert.throws(() => warcRecord({ ...base, type: "resource", targetUri: "urn:view:ftp://example.com/" }), /http\(s\)/);
  assert.throws(() => warcRecord({ ...base, type: "resource", targetUri: "urn:view:nothing" }), /absolute/);
});

test("characters above U+00FF in header values survive as UTF-8, not '?'", () => {
  const value = "caf\u00e9 \u2603 \u{1f600}";
  const b = httpResponseBlock({ status: 200, statusText: "OK", headers: [["X-Title", value]], body: Buffer.from("b") });
  assert.ok(!str(b).includes("?"));
  const parts = splitHttpBlock(b);
  assert.ok(parts);
  assert.ok(parts.head.includes(`X-Title: ${value}`));
  assert.equal(Buffer.from(parts.body).toString(), "b");
  assert.ok(Buffer.from(b).includes(Buffer.from(`X-Title: ${value}`, "utf8")));
});

test("omitPayloadDigest drops WARC-Payload-Digest only with a WARC-Truncated header; the block digest stays", () => {
  const block = httpResponseBlock({ status: 200, statusText: "OK", headers: [], body: new Uint8Array(0) });
  const base = {
    type: "response" as const,
    date: "2026-10-24T12:00:00Z",
    targetUri: "https://e.com/",
    contentType: "application/http;msgtype=response",
    block,
  };
  const kept = parseWarcRecord(warcRecord(base));
  assert.equal(kept.headers.get("warc-payload-digest"), `sha256:${sha256Hex(new Uint8Array(0))}`);
  const omitted = parseWarcRecord(warcRecord({ ...base, extra: [["WARC-Truncated", "unspecified"]], omitPayloadDigest: true }));
  assert.equal(omitted.headers.has("warc-payload-digest"), false);
  assert.equal(omitted.headers.get("warc-block-digest"), `sha256:${sha256Hex(block)}`);
  assert.throws(() => warcRecord({ ...base, omitPayloadDigest: true }), /WARC-Truncated/);
});
