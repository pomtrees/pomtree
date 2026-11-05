import assert from "node:assert/strict";
import test from "node:test";
import { cdxjTimestamp, parseCdxj } from "./cdxj.ts";
import { parseWarcGz, sha256Hex, warcGzMember, warcRecord } from "./warc.ts";
import { httpResponseBlock, type WarcRecordInput } from "./warc.ts";
import { buildWacz, verifyWacz } from "./wacz.ts";
import { readZip, zipStored } from "./zip.ts";

const DATE = "2026-10-24T12:00:00Z";
const html = httpResponseBlock({ status: 200, statusText: "OK", headers: [["Content-Type", "text/html; charset=utf-8"]], body: Buffer.from("<p>hi</p>") });
const ids = [0, 1, 2].map((i) => `<urn:uuid:00000000-0000-0000-0000-00000000000${i}>`);
const records: WarcRecordInput[] = [
  {
    type: "warcinfo",
    recordId: ids[0],
    date: DATE,
    contentType: "application/warc-fields",
    block: Buffer.from("capture-method: cdp\r\n"),
    filename: "data.warc.gz",
  },
  { type: "response", recordId: ids[1], date: DATE, targetUri: "https://example.com/", contentType: "application/http;msgtype=response", block: html },
  {
    type: "resource",
    recordId: ids[2],
    date: "2026-10-24T12:00:01Z",
    targetUri: "https://example.com/screenshot.png",
    contentType: "image/png",
    block: Buffer.from("PNGDATA"),
  },
];
const build = () => buildWacz({ records, pages: [{ url: "https://example.com/", ts: DATE, title: "Ex" }], created: DATE, software: "test 1" });

type Entry = { name: string; data: Uint8Array };
const entriesOf = (z: Uint8Array): Entry[] => readZip(z).map((e) => ({ name: e.name, data: Buffer.from(e.data) }));
// Re-zips with a mutation; `fix` recomputes datapackage.json so only the intended defect remains.
function rezip(z: Uint8Array, mutate: (m: Map<string, Uint8Array>) => void, fix = true): Uint8Array {
  const m = new Map(entriesOf(z).map((e) => [e.name, e.data]));
  mutate(m);
  if (fix) {
    const dp = JSON.parse(Buffer.from(m.get("datapackage.json") ?? "{}").toString()) as { resources: { path: string; hash: string; bytes: number }[] };
    dp.resources = [...m.entries()]
      .filter(([n]) => n !== "datapackage.json")
      .map(([path, d]) => ({ path, hash: `sha256:${sha256Hex(d)}`, bytes: d.byteLength }));
    m.set("datapackage.json", Buffer.from(JSON.stringify(dp)));
  }
  return zipStored([...m.entries()].map(([name, data]) => ({ name, data })));
}
const problems = (z: Uint8Array): string[] => {
  const v = verifyWacz(z);
  assert.equal(v.ok, false);
  return v.ok ? [] : v.problems;
};

test("buildWacz output verifies and has the WACZ layout", () => {
  const w = build();
  const v = verifyWacz(w.wacz);
  assert.deepEqual(v, { ok: true, files: ["archive/data.warc.gz", "indexes/index.cdxj", "pages/pages.jsonl", "datapackage.json"], records: 3, pages: 1 });
  assert.equal(w.datapackage.wacz_version, "1.1.1");
  assert.equal(w.datapackage.profile, "data-package");
  const resources = w.datapackage.resources as { name: string; path: string; hash: string; bytes: number }[];
  assert.deepEqual(
    resources.map((r) => r.path),
    ["archive/data.warc.gz", "indexes/index.cdxj", "pages/pages.jsonl"],
  );
  assert.equal(resources[0]?.hash, `sha256:${sha256Hex(w.warc)}`);
  assert.equal(resources[0]?.bytes, w.warc.byteLength);
  // response and resource are indexed; warcinfo is not
  const lines = w.cdxj.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(
    lines[0] ?? "",
    /^com,example\)\/ 20261024120000 \{"url":"https:\/\/example.com\/","mime":"text\/html","status":"200","digest":"sha256:[0-9a-f]{64}","length":"\d+","offset":"\d+","filename":"data.warc.gz"\}$/,
  );
  assert.match(lines[1] ?? "", /^com,example\)\/screenshot.png 20261024120001 /);
  const pages = Buffer.from(readZip(w.wacz).find((e) => e.name === "pages/pages.jsonl")?.data ?? [])
    .toString()
    .split("\n");
  assert.equal(pages[0], '{"format":"json-pages-1.0","id":"pages","title":"All Pages"}');
  assert.equal(JSON.parse(pages[1] ?? "").url, "https://example.com/");
  assert.equal(cdxjTimestamp(DATE), "20261024120000");
});

test("build is deterministic given fixed record ids", () => {
  const fixed = records.map((r, i) => ({ ...r, recordId: `<urn:uuid:00000000-0000-0000-0000-00000000000${i}>` }));
  const o = { records: fixed, pages: [], created: DATE, software: "t" };
  assert.deepEqual(buildWacz(o).wacz, buildWacz(o).wacz);
});

test("flipped byte in a WARC member is caught", () => {
  const z = Buffer.from(build().wacz);
  const warc = readZip(z).find((e) => e.name === "archive/data.warc.gz");
  z[(warc?.dataOffset ?? 0) + 40] = (z[(warc?.dataOffset ?? 0) + 40] ?? 0) ^ 0xff;
  const p = problems(z).join("\n");
  assert.match(p, /zip: archive\/data.warc.gz CRC mismatch/);
  // the same flip with the zip and package digests repaired still fails inside the WARC
  const repaired = rezip(build().wacz, (m) => {
    const w = Buffer.from(m.get("archive/data.warc.gz") ?? []);
    w[40] = (w[40] ?? 0) ^ 0xff;
    m.set("archive/data.warc.gz", w);
  });
  assert.match(problems(repaired).join("\n"), /warc: archive\/data.warc.gz is unreadable/);
});

test("block and payload digest mismatches inside a well-formed member are named", () => {
  const raw = Buffer.from(warcRecord(records[1] as WarcRecordInput));
  const pos = raw.indexOf("hi</p>");
  const tampered = Buffer.from(raw);
  tampered[pos] = 0x48; // 'H': block changes, headers still claim the old digests
  const w = build();
  const z = rezip(w.wacz, (m) => {
    const file = Buffer.from(m.get("archive/data.warc.gz") ?? []);
    const first = Buffer.from(warcGzMember(warcRecord(records[0] as WarcRecordInput)));
    // swap the second member for a same-length-irrelevant tampered one and keep the index honest
    const rest = file.subarray(first.length);
    const old = Buffer.from(warcGzMember(raw));
    const swapped = Buffer.concat([first, Buffer.from(warcGzMember(tampered)), rest.subarray(old.length)]);
    m.set("archive/data.warc.gz", swapped);
    m.set(
      "indexes/index.cdxj",
      Buffer.from(
        Buffer.from(m.get("indexes/index.cdxj") ?? [])
          .toString()
          .replace(/"length":"\d+"/, `"length":"${warcGzMember(tampered).length}"`),
      ),
    );
  });
  const p = problems(z).join("\n");
  assert.match(p, /block digest mismatch in archive\/data.warc.gz record 1/);
  assert.match(p, /payload digest mismatch/);
});

test("datapackage defects: wrong hash, wrong size, extra, missing, duplicate listing", () => {
  const w = build();
  const wrongHash = rezip(
    w.wacz,
    (m) => {
      const dp = JSON.parse(Buffer.from(m.get("datapackage.json") ?? []).toString());
      dp.resources[1].hash = `sha256:${"0".repeat(64)}`;
      m.set("datapackage.json", Buffer.from(JSON.stringify(dp)));
    },
    false,
  );
  assert.deepEqual(problems(wrongHash), ["datapackage: hash mismatch for indexes/index.cdxj"]);
  const wrongSize = rezip(
    w.wacz,
    (m) => {
      const dp = JSON.parse(Buffer.from(m.get("datapackage.json") ?? []).toString());
      dp.resources[2].bytes += 1;
      m.set("datapackage.json", Buffer.from(JSON.stringify(dp)));
    },
    false,
  );
  assert.deepEqual(problems(wrongSize), ["datapackage: byte size mismatch for pages/pages.jsonl"]);
  const extra = zipStored([...entriesOf(w.wacz), { name: "extra.txt", data: Buffer.from("x") }]);
  assert.deepEqual(problems(extra), ["datapackage: extra.txt is in the archive but not listed"]);
  const missing = zipStored(entriesOf(w.wacz).filter((e) => e.name !== "pages/pages.jsonl"));
  assert.deepEqual(problems(missing), ["datapackage: listed file pages/pages.jsonl is not in the archive"]);
  const dup = rezip(
    w.wacz,
    (m) => {
      const dp = JSON.parse(Buffer.from(m.get("datapackage.json") ?? []).toString());
      dp.resources.push(dp.resources[0]);
      m.set("datapackage.json", Buffer.from(JSON.stringify(dp)));
    },
    false,
  );
  assert.deepEqual(problems(dup), ["datapackage: archive/data.warc.gz is listed twice"]);
  assert.deepEqual(problems(zipStored(entriesOf(w.wacz).filter((e) => e.name !== "datapackage.json"))), ["datapackage: datapackage.json is missing"]);
});

test("CDXJ offset off by one, wrong digest, unindexed record, wrong url", () => {
  const w = build();
  const edit = (f: (s: string) => string) =>
    rezip(w.wacz, (m) => m.set("indexes/index.cdxj", Buffer.from(f(Buffer.from(m.get("indexes/index.cdxj") ?? []).toString()))));
  const off = edit((s) => s.replace(/"offset":"(\d+)"/, (_, n) => `"offset":"${Number(n) + 1}"`));
  assert.match(problems(off).join("\n"), /cdxj: cdxj line 1 offset \d+ is not a gzip member boundary/);
  assert.match(problems(off).join("\n"), /response record at archive\/data.warc.gz@\d+ .* is not indexed/);
  const dig = edit((s) => s.replace(/"digest":"sha256:[0-9a-f]/, '"digest":"sha256:x'));
  assert.match(problems(dig).join("\n"), /digest differs/);
  const len = edit((s) => s.replace(/"length":"(\d+)"/, (_, n) => `"length":"${Number(n) + 1}"`));
  assert.match(problems(len).join("\n"), /length \d+ is not the member length/);
  const half = edit((s) => `${s.split("\n")[0]}\n`);
  assert.match(problems(half).join("\n"), /resource record at .* \(https:\/\/example.com\/screenshot.png\) is not indexed/);
  const url = edit((s) => s.replace('"url":"https://example.com/"', '"url":"https://example.com/other"'));
  assert.match(problems(url).join("\n"), /key does not match its url/);
  const noIndex = rezip(w.wacz, (m) => m.delete("indexes/index.cdxj"));
  assert.match(problems(noIndex).join("\n"), /indexes\/index.cdxj is missing/);
});

test("pages without an index entry or with a bad header are named; all problems are collected", () => {
  const w = buildWacz({
    records,
    pages: [
      { url: "https://example.com/", ts: DATE },
      { url: "https://example.com/unindexed", ts: DATE },
    ],
    created: DATE,
    software: "t",
  });
  assert.deepEqual(problems(w.wacz), ["pages: page https://example.com/unindexed has no CDXJ entry"]);
  const hdr = rezip(w.wacz, (m) => m.set("pages/pages.jsonl", Buffer.from('{"format":"x"}\n{"url":"https://example.com/"}\n')));
  assert.deepEqual(problems(hdr), ["pages: header line is not a json-pages-1.0 header"]);
  const multi = rezip(w.wacz, (m) => {
    m.set("pages/pages.jsonl", Buffer.from("junk\n{}\n"));
    m.set("indexes/index.cdxj", Buffer.from("garbage\n"));
  });
  const p = problems(multi);
  assert.ok(p.length >= 3, p.join("|"));
});

test("hostile input never throws", () => {
  for (const bytes of [new Uint8Array(0), Buffer.from("PK\x05\x06"), Buffer.alloc(100, 0xff), Buffer.from("not a zip at all")]) {
    const v = verifyWacz(bytes);
    assert.equal(v.ok, false);
  }
  const z = Buffer.from(build().wacz);
  for (let i = 0; i < z.length; i += 37) {
    const t = Buffer.from(z);
    t[i] = (t[i] ?? 0) ^ 0x55;
    assert.doesNotThrow(() => verifyWacz(t));
  }
  assert.doesNotThrow(() => verifyWacz(z.subarray(0, z.length >> 1)));
});

test("buildWacz refuses an unsafe warc name and a bad page timestamp", () => {
  assert.throws(() => buildWacz({ records: [], pages: [], created: DATE, software: "t", warcName: "../x.warc.gz" }), /warcName/);
  assert.throws(() => buildWacz({ records: [], pages: [{ url: "https://e.com/", ts: "bad" }], created: DATE, software: "t" }), /bad date/);
});

test("urn:view and urn:text resources do not shadow the page: the URL resolves to the response, and verification agrees", () => {
  const page = "https://example.com/";
  const w = buildWacz({
    records: [
      ...records.slice(0, 2),
      { type: "resource", date: DATE, targetUri: `urn:view:${page}`, contentType: "image/png", block: Buffer.from("PNG") },
      { type: "resource", date: DATE, targetUri: `urn:text:${page}`, contentType: "text/plain", block: Buffer.from("text") },
    ],
    pages: [{ url: page, ts: DATE }],
    created: DATE,
    software: "t",
  });
  assert.deepEqual(verifyWacz(w.wacz), {
    ok: true,
    files: ["archive/data.warc.gz", "indexes/index.cdxj", "pages/pages.jsonl", "datapackage.json"],
    records: 4,
    pages: 1,
  });
  const rows = parseCdxj(w.cdxj).filter((r) => r.fields.url === page);
  assert.equal(rows.length, 1);
  const rec = parseWarcGz(w.warc).find((r) => r.offset === Number(rows[0]?.fields.offset));
  assert.equal(rec?.headers.get("warc-type"), "response");
  assert.equal(parseCdxj(w.cdxj).length, 1);
});

const lostBody = (extra: [string, string][], omit: boolean): WarcRecordInput => ({
  type: "response",
  recordId: ids[1],
  date: DATE,
  targetUri: "https://example.com/",
  contentType: "application/http;msgtype=response",
  block: httpResponseBlock({ status: 200, statusText: "OK", headers: [["Content-Type", "text/html"]], body: new Uint8Array(0) }),
  extra,
  ...(omit && { omitPayloadDigest: true }),
});
const buildLost = (r: WarcRecordInput) =>
  buildWacz({ records: [records[0] as WarcRecordInput, r], pages: [{ url: "https://example.com/", ts: DATE }], created: DATE, software: "t" });
const emptyDigest = `sha256:${sha256Hex(new Uint8Array(0))}`;

test("an omitted body has no payload digest in the WARC or the CDXJ, is marked truncated, and still verifies", () => {
  const w = buildLost(lostBody([["WARC-Truncated", "unspecified"]], true));
  assert.ok(verifyWacz(w.wacz).ok, JSON.stringify(verifyWacz(w.wacz)));
  const [row] = parseCdxj(w.cdxj);
  assert.equal("digest" in (row?.fields ?? {}), false);
  assert.equal(row?.fields.truncated, "unspecified");
  assert.ok(!w.cdxj.includes(emptyDigest));
  assert.equal(parseWarcGz(w.warc)[1]?.headers.has("warc-payload-digest"), false);
});

test("a truncated body keeps the digest of its retained prefix, marked truncated in the CDXJ, and verifies", () => {
  const w = buildLost(lostBody([["WARC-Truncated", "length"]], false));
  assert.ok(verifyWacz(w.wacz).ok);
  const [row] = parseCdxj(w.cdxj);
  assert.equal(row?.fields.digest, emptyDigest);
  assert.equal(row?.fields.truncated, "length");
});

test("negative: a response with no payload digest and no WARC-Truncated is refused, and a CDXJ that restores a digest or drops the mark is named", () => {
  const w = buildLost(lostBody([["WARC-Truncated", "unspecified"]], true));
  const plain = buildLost(lostBody([], false));
  const stripped = rezip(plain.wacz, (m) => {
    const raw = Buffer.from(warcRecord(lostBody([], false)))
      .toString("latin1")
      .replace(/WARC-Payload-Digest: [^\r]*\r\n/, "");
    const recs = parseWarcGz(m.get("archive/data.warc.gz") as Uint8Array);
    assert.equal(recs.length, 2);
    m.set(
      "archive/data.warc.gz",
      Buffer.concat([Buffer.from(warcGzMember(warcRecord(records[0] as WarcRecordInput))), Buffer.from(warcGzMember(Buffer.from(raw, "latin1")))]),
    );
  });
  assert.ok(problems(stripped).some((p) => /has no WARC-Payload-Digest/.test(p)));
  const digestBack = rezip(w.wacz, (m) => {
    m.set(
      "indexes/index.cdxj",
      Buffer.from(
        Buffer.from(m.get("indexes/index.cdxj") as Uint8Array)
          .toString()
          .replace('"filename"', `"digest":"${emptyDigest}","filename"`),
      ),
    );
  });
  assert.ok(problems(digestBack).some((p) => /digest differs/.test(p)));
  const unmarked = rezip(w.wacz, (m) => {
    m.set(
      "indexes/index.cdxj",
      Buffer.from(
        Buffer.from(m.get("indexes/index.cdxj") as Uint8Array)
          .toString()
          .replace(',"truncated":"unspecified"', ""),
      ),
    );
  });
  assert.ok(problems(unmarked).some((p) => /truncated differs/.test(p)));
});

test("negative: a length-truncated response whose prefix digest was stripped is refused", () => {
  const truncated = lostBody([["WARC-Truncated", "length"]], false);
  const w = rezip(buildLost(truncated).wacz, (m) => {
    const raw = Buffer.from(warcRecord(truncated))
      .toString("latin1")
      .replace(/WARC-Payload-Digest: [^\r]*\r\n/, "");
    m.set(
      "archive/data.warc.gz",
      Buffer.concat([Buffer.from(warcGzMember(warcRecord(records[0] as WarcRecordInput))), Buffer.from(warcGzMember(Buffer.from(raw, "latin1")))]),
    );
  });
  assert.ok(problems(w).some((p) => /has no WARC-Payload-Digest/.test(p)));
});
