import assert from "node:assert/strict";
import test from "node:test";
import { type CdxjEntry, cdxjLines, cdxjTimestamp, parseCdxj, surt } from "./cdxj.ts";

test("surt table", () => {
  const cases: [string, string][] = [
    ["http://example.com/", "com,example)/"],
    ["http://Example.COM/Path", "com,example)/path"],
    ["https://www.example.com/path/", "com,example)/path"],
    ["http://www2.example.org/?", "org,example)/"],
    ["http://example.com:8080/x", "com,example:8080)/x"],
    ["http://example.com:80/x", "com,example)/x"],
    ["https://example.com:443/x", "com,example)/x"],
    ["http://example.com/p?z=1&a=2&m=", "com,example)/p?a=2&m=&z=1"],
    ["http://sub.example.co.uk/Page#frag", "uk,co,example,sub)/page"],
    ["http://user:pw@example.com/", "com,example)/"],
    ["http://1.2.3.4/a", "1.2.3.4)/a"],
  ];
  for (const [url, want] of cases) assert.equal(surt(url), want, url);
});

test("cdxjTimestamp is 14 digits in UTC", () => {
  assert.equal(cdxjTimestamp("2026-10-24T12:34:56Z"), "20261024123456");
  assert.equal(cdxjTimestamp("2026-10-24T12:34:56.789Z"), "20261024123456");
  assert.equal(cdxjTimestamp("2026-10-24T14:00:00+02:00"), "20261024120000");
  assert.throws(() => cdxjTimestamp("nope"), /bad date/);
});

const e = (url: string, date: string, offset = 0): CdxjEntry => ({
  url,
  date,
  status: 200,
  mime: "text/html",
  digest: "sha256:ab",
  offset,
  length: 10,
  filename: "data.warc.gz",
});

test("lines sort by key then timestamp and use pywb's string fields", () => {
  const text = cdxjLines([
    e("http://b.example/", "2026-01-01T00:00:00Z"),
    e("http://a.example/z", "2026-01-02T00:00:00Z", 5),
    e("http://a.example/z", "2026-01-01T00:00:00Z", 7),
    e("http://a.example/", "2026-01-01T00:00:00Z", 9),
  ]);
  const lines = text.split("\n");
  assert.deepEqual(
    lines.slice(0, 4).map((l) => l.split(" ").slice(0, 2).join(" ")),
    ["example,a)/ 20260101000000", "example,a)/z 20260101000000", "example,a)/z 20260102000000", "example,b)/ 20260101000000"],
  );
  assert.equal(lines[4], "");
  assert.equal(
    lines[1],
    'example,a)/z 20260101000000 {"url":"http://a.example/z","mime":"text/html","status":"200","digest":"sha256:ab","length":"10","offset":"7","filename":"data.warc.gz"}',
  );
});

test("parseCdxj round-trips and rejects malformed lines", () => {
  const rows = parseCdxj(cdxjLines([e("http://a.example/", "2026-01-01T00:00:00Z", 3)]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.key, "example,a)/");
  assert.equal(rows[0]?.timestamp, "20260101000000");
  assert.equal(rows[0]?.fields.offset, "3");
  assert.throws(() => parseCdxj("garbage line\n"), /malformed/);
  assert.throws(() => parseCdxj("k 20260101000000 [1]\n"), /malformed|object/);
});

test("an entry without a payload digest writes no digest field, and a truncated reason is carried", () => {
  const { digest: _digest, ...noDigest } = e("http://a.example/", "2026-01-01T00:00:00Z");
  const [row] = parseCdxj(cdxjLines([{ ...noDigest, truncated: "unspecified" }]));
  assert.equal("digest" in (row?.fields ?? {}), false);
  assert.equal(row?.fields.truncated, "unspecified");
  const [plain] = parseCdxj(cdxjLines([e("http://a.example/", "2026-01-01T00:00:00Z")]));
  assert.equal("truncated" in (plain?.fields ?? {}), false);
});
