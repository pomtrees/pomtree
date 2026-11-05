import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  articleUrl,
  CAUSE_MAX,
  type DigestEntry,
  type DigestPlan,
  errorCause,
  feedCounts,
  parseFeed,
  parseItem,
  plainText,
  REPORT_MAX,
  renderDigest,
  sanitizeHtml,
  selectRanked,
  URL_MAX,
} from "./logic.mts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const FETCHED = "2026-10-19T00:00:00.000Z";
const HASH = "a".repeat(64);

function plan(over: Partial<DigestPlan> = {}): DigestPlan {
  return {
    schema: "hn-digest/1",
    instance: "daily",
    runId: "run-1",
    fetchedAt: FETCHED,
    feedSource: "https://hacker-news.firebaseio.com/v0/topstories.json",
    feedHash: HASH,
    rankBasis: "ranked-feed-position",
    limit: 5,
    entries: [],
    skipped: [],
    provenance: { seenBefore: 0, feedIds: 7, feedSeen: 0, insights: "none" },
    ...over,
  };
}

describe("parseFeed", () => {
  it("returns feed IDs in order, keeping duplicates for selectRanked", () => {
    assert.deepEqual(parseFeed(fixture("feed_topstories.json")), [101, 102, 103, 102, 104, 105, 106]);
  });
  it("accepts an empty feed", () => {
    assert.deepEqual(parseFeed(fixture("feed_empty.json")), []);
  });
  it("throws on malformed entries and non-arrays", () => {
    assert.throws(() => parseFeed(fixture("feed_malformed.json")), TypeError);
    assert.throws(() => parseFeed({ ids: [1] }), TypeError);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) assert.throws(() => parseFeed([bad]), TypeError);
  });
});

describe("selectRanked", () => {
  it("ranks by original 1-based position and removes duplicates keeping first rank", () => {
    const ids = parseFeed(fixture("feed_topstories.json"));
    assert.deepEqual(selectRanked(ids, [], 10), [
      { id: 101, rank: 1 },
      { id: 102, rank: 2 },
      { id: 103, rank: 3 },
      { id: 104, rank: 5 },
      { id: 105, rank: 6 },
      { id: 106, rank: 7 },
    ]);
  });
  it("skips seen IDs without shifting remaining ranks", () => {
    assert.deepEqual(selectRanked([1, 2, 3, 4], [2], 2), [
      { id: 1, rank: 1 },
      { id: 3, rank: 3 },
    ]);
  });
  it("returns empty for an empty feed or fully seen feed", () => {
    assert.deepEqual(selectRanked([], [], 3), []);
    assert.deepEqual(selectRanked([1, 2], [1, 2], 3), []);
  });
  it("enforces limit 1..10", () => {
    for (const bad of [0, 11, 1.5]) assert.throws(() => selectRanked([1], [], bad), RangeError);
    assert.equal(selectRanked([1, 2, 3], [], 1).length, 1);
  });
});

describe("parseItem", () => {
  it("parses a story with optional fields and ignores unknown fields", () => {
    const r = parseItem(fixture("item_101_story.json"), 101);
    assert.deepEqual(r, {
      ok: true,
      item: {
        id: 101,
        title: "Show: A & B — launch",
        text: "",
        url: "https://example.com/a?x=1&y=2",
        type: "story",
        by: "pg",
        time: 1700000000,
        score: 300,
        descendants: 42,
      },
    });
  });
  it("omits an empty job URL and keeps the job", () => {
    const r = parseItem(fixture("item_102_job.json"), 102);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.item.type, "job");
      assert.equal("url" in r.item, false);
    }
  });
  it("parses Ask HN with text and no URL, and decodes entities once", () => {
    const r = parseItem(fixture("item_103_ask.json"), 103);
    assert.ok(r.ok);
    assert.equal(r.item.text, "I want simple & fast.\nSecond para @ bob");
    assert.equal("url" in r.item, false);
  });
  it("parses a poll with no article URL", () => {
    const r = parseItem(fixture("item_104_poll.json"), 104);
    assert.ok(r.ok);
    assert.equal(r.item.type, "poll");
    assert.equal(r.item.descendants, 3);
  });
  it("skips pollopt, comment and unknown types with a fixed cause", () => {
    assert.deepEqual(parseItem(fixture("item_105_pollopt.json"), 105), { ok: false, cause: "unexpected_type" });
    assert.deepEqual(parseItem(fixture("item_106_comment.json"), 106), { ok: false, cause: "unexpected_type" });
    assert.deepEqual(parseItem({ id: 9, type: "<script>" }, 9), { ok: false, cause: "unexpected_type" });
  });
  it("skips deleted, dead and null items", () => {
    assert.deepEqual(parseItem(fixture("item_107_deleted.json"), 107), { ok: false, cause: "deleted" });
    assert.deepEqual(parseItem(fixture("item_108_dead.json"), 108), { ok: false, cause: "dead" });
    assert.deepEqual(parseItem(fixture("item_109_null.json"), 109), { ok: false, cause: "null" });
    assert.deepEqual(parseItem(undefined, 109), { ok: false, cause: "null" });
  });
  it("skips malformed, missing-title and mismatched-id items", () => {
    assert.deepEqual(parseItem(fixture("item_110_malformed.json"), 110), { ok: false, cause: "missing_title" });
    assert.deepEqual(parseItem(fixture("item_111_missing_title.json"), 111), { ok: false, cause: "missing_title" });
    assert.deepEqual(parseItem("text", 1), { ok: false, cause: "malformed" });
    assert.deepEqual(parseItem(fixture("item_101_story.json"), 999), { ok: false, cause: "id_mismatch" });
  });
  it("treats a changed score as an update to the same ID, not a new item", () => {
    const r = parseItem(fixture("item_101_changed_score.json"), 101);
    assert.ok(r.ok);
    assert.equal(r.item.score, 310);
    assert.equal(r.item.id, 101);
  });
  it("sanitizes injected HTML in title and text and drops unsafe URLs", () => {
    const r = parseItem(fixture("item_112_html_injection.json"), 112);
    assert.ok(r.ok);
    const { title, text } = r.item;
    assert.equal(title, "Safe <b>title</b> gnp");
    assert.equal(/script|alert|hidden|style/.test(title + text), false);
    assert.equal(text.includes("\uFFFD"), true);
    assert.equal(text.includes("\u{1F600}"), true);
    assert.equal(text.includes("&lt;tag&gt;"), true);
    assert.equal(text.includes("&bogus;"), true);
    assert.equal(text.includes("@ everyone"), true);
    assert.equal("url" in r.item, false);
  });
});

describe("sanitizeHtml", () => {
  it("removes script and style with content, including unclosed script to end", () => {
    assert.equal(sanitizeHtml("a<script>x()</script>b<style>p{}</style>c"), "a b c");
    assert.equal(sanitizeHtml("keep<SCRIPT>never closed"), "keep");
  });
  it("turns breaks and paragraph ends into newlines and strips tags", () => {
    assert.equal(sanitizeHtml("one<br>two</p>three<i>x</i>"), "one\ntwo\nthreex");
  });
  it("decodes entities in a single pass", () => {
    assert.equal(sanitizeHtml("&amp;lt;"), "&lt;");
    assert.equal(sanitizeHtml("&#60;b&#62;"), "<b>");
    assert.equal(sanitizeHtml("&#x41;&#66;"), "AB");
  });
  it("replaces invalid numeric code points with U+FFFD", () => {
    for (const bad of ["&#0;", "&#xD800;", "&#xDFFF;", "&#1114112;", "&#99999999999999999999;"]) {
      assert.equal(sanitizeHtml(bad), "\uFFFD");
    }
  });
  it("keeps unknown named entities literal and decodes nbsp to space", () => {
    assert.equal(sanitizeHtml("&madeup; a&nbsp;b"), "&madeup; a b");
  });
  it("removes controls, bidi overrides and zero-width characters", () => {
    assert.equal(plainText("a\u0007b\u202Ec\u200Bd\uFEFFe\u0085f"), "abcdef");
    assert.equal(sanitizeHtml("x&#1;y&#8238;z"), "xyz");
  });
  it("breaks @-mentions", () => {
    assert.equal(plainText("hi @everyone and @bob"), "hi @ everyone and @ bob");
  });
  it("clips by code point with a visible marker", () => {
    assert.equal(sanitizeHtml("abcdef", 4), "abc…");
    assert.equal(sanitizeHtml("\u{1F600}\u{1F600}\u{1F600}", 2), "\u{1F600}…");
    assert.equal(sanitizeHtml("short", 10), "short");
  });
  it("rejects invalid maxChars", () => {
    assert.throws(() => sanitizeHtml("x", 0), RangeError);
    assert.throws(() => sanitizeHtml(5 as unknown as string), TypeError);
  });
});

describe("articleUrl", () => {
  it("allows only http(s) without credentials or whitespace", () => {
    assert.equal(articleUrl("https://example.com/x"), "https://example.com/x");
    assert.equal(articleUrl("http://example.com/"), "http://example.com/");
    assert.equal(articleUrl("javascript:alert(1)"), undefined);
    assert.equal(articleUrl("file:///etc/passwd"), undefined);
    assert.equal(articleUrl("https://u:p@example.com/"), undefined);
    assert.equal(articleUrl("https://example.com/a b"), undefined);
    assert.equal(articleUrl("   "), undefined);
    assert.equal(articleUrl("not a url"), undefined);
  });
  it("bounds the serialized URL, not the raw input", () => {
    // 1100 raw chars, but each "é" serializes to %C3%A9 (6 chars): 6600 > URL_MAX.
    assert.equal(articleUrl(`https://example.com/${"é".repeat(1100)}`), undefined);
    const ok = `https://example.com/${"a".repeat(URL_MAX - 20)}`;
    assert.equal(ok.length, URL_MAX);
    assert.equal(articleUrl(ok), ok);
    assert.equal(articleUrl(`${ok}a`), undefined);
  });
});

describe("renderDigest", () => {
  const ids = parseFeed(fixture("feed_topstories.json"));
  const picked = selectRanked(ids, [], 3);
  const entries = picked.map(({ id, rank }) => {
    const r = parseItem(fixture(`item_${id}_${id === 101 ? "story" : id === 102 ? "job" : "ask"}.json`), id);
    if (!r.ok) throw new Error(`fixture ${id} unexpectedly skipped`);
    return { ...r.item, rank, itemSource: `https://hacker-news.firebaseio.com/v0/item/${id}.json`, itemHash: HASH };
  });

  it("renders the proxy and no-analysis headers, discussion links and article lines only when valid", () => {
    const out = renderDigest(plan({ entries, limit: 3, skipped: [{ id: 104, cause: "dead" }] }));
    assert.match(out, /ranked feed position: a proxy, not velocity/i);
    assert.match(out, /Extracted fields only; no model analysis/);
    assert.match(out, /1\. Show: A & B — launch/);
    assert.match(out, /article: https:\/\/example\.com\/a\?x=1&y=2/);
    assert.match(out, /discussion: https:\/\/news\.ycombinator\.com\/item\?id=101/);
    assert.match(out, /Acme is hiring/);
    assert.equal(out.includes("article: \n"), false);
    assert.match(out, /Skipped: 1 \(dead=1\)/);
  });
  it("is deterministic", () => {
    const p = plan({ entries, limit: 3 });
    assert.equal(renderDigest(p), renderDigest(p));
  });
  it("says so when there are no new posts and does not count skips as success", () => {
    const out = renderDigest(
      plan({
        entries: [],
        skipped: [
          { id: 1, cause: "deleted" },
          { id: 2, cause: "deleted" },
        ],
      }),
    );
    assert.match(out, /No new posts \(feed 7 ids, 0 seen\)\./);
    assert.match(out, /Skipped: 2 \(deleted=2\); skipped items are not marked seen/);
    assert.equal(out.includes("New posts:"), false);
  });
  it("accepts underscore instance names and rejects path traversal", () => {
    assert.match(renderDigest(plan({ instance: "team_daily" })), /instance team_daily/);
    assert.throws(() => renderDigest(plan({ instance: "../etc" })), TypeError);
    assert.throws(() => renderDigest(plan({ instance: "a/../b" })), TypeError);
    assert.throws(() => renderDigest(plan({ instance: "_daily" })), TypeError);
  });
  it("ten multibyte maximal entries fit the 64 KiB byte cap with every entry and the skip summary present", () => {
    const maximal: DigestEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: 9000 + i,
      title: "😀".repeat(400),
      text: "😀".repeat(500),
      url: `https://example.com/${"p".repeat(URL_MAX - 20)}`,
      type: "story",
      by: "a".repeat(64),
      time: 1700000000,
      score: 1,
      descendants: 1,
      rank: i + 1,
      itemSource: "https://hacker-news.firebaseio.com/v0/item/1.json",
      itemHash: HASH,
    }));
    const skipped = [
      { id: 1, cause: "dead" },
      { id: 2, cause: "deleted" },
    ];
    const out = renderDigest(plan({ entries: maximal, limit: 10, skipped, provenance: { seenBefore: 0, feedIds: 7, feedSeen: 0, insights: "none" } }));
    assert.ok(Buffer.byteLength(out, "utf8") <= 65536, `report is ${Buffer.byteLength(out, "utf8")} bytes`);
    for (const e of maximal) assert.ok(out.includes(`item ${e.id} · source`), `entry ${e.id} missing`);
    assert.match(out, /New posts: 10/);
    assert.ok(out.endsWith("Skipped: 2 (dead=1, deleted=1); skipped items are not marked seen"));
    assert.equal(out.includes("…\n\nSkipped"), false);
  });
  it("caps report length", () => {
    const big = entries.map((e) => ({ ...e, text: "x".repeat(400) }));
    const first = big[0];
    assert.ok(first);
    const many = Array.from({ length: 10 }, (_, i) => ({ ...first, id: 200 + i, rank: i + 1 }));
    const out = renderDigest(plan({ entries: many, limit: 10 }));
    assert.ok(Array.from(out).length <= REPORT_MAX);
  });
  it("rejects invalid instance, run and entries", () => {
    const base = entries[0];
    assert.ok(base);
    assert.throws(() => renderDigest(plan({ instance: "Bad Name" })), TypeError);
    assert.throws(() => renderDigest(plan({ runId: "" })), TypeError);
    assert.throws(() => renderDigest(plan({ fetchedAt: "not a date" })), TypeError);
    assert.throws(() => renderDigest(plan({ entries: [{ ...base, rank: 0 }] })), TypeError);
  });
  it("strips controls from plan text and keeps tags as inert plain text", () => {
    const base = entries[0];
    assert.ok(base);
    const out = renderDigest(plan({ entries: [{ ...base, text: "<script>x</script>\u202Eok" }] }));
    assert.equal(out.includes("<script>"), true);
    assert.equal(out.includes("\u202E"), false);
  });
});

describe("feedCounts", () => {
  it("counts distinct feed ids and how many were already seen", () => {
    assert.deepEqual(feedCounts([101, 102, 103, 102], [102, 999]), { feedIds: 3, feedSeen: 1 });
    assert.deepEqual(feedCounts([101, 102], [101, 102]), { feedIds: 2, feedSeen: 2 });
    assert.deepEqual(feedCounts([], [1]), { feedIds: 0, feedSeen: 0 });
  });
});

describe("renderDigest feed coverage", () => {
  it("renders feed N ids, M seen on both the empty and the non-empty report", () => {
    assert.match(renderDigest(plan({ provenance: { seenBefore: 9, feedIds: 4, feedSeen: 4, insights: "none" } })), /No new posts \(feed 4 ids, 4 seen\)\./);
  });
  it("rejects a plan without coverage counts or with more seen than feed ids", () => {
    const bad = (provenance: unknown) => plan({ provenance: provenance as DigestPlan["provenance"] });
    assert.throws(() => renderDigest(bad({ seenBefore: 0, insights: "none" })), /feedIds, feedSeen/);
    assert.throws(() => renderDigest(bad({ seenBefore: 0, feedIds: 1, feedSeen: 2, insights: "none" })), /feedSeen <= feedIds/);
  });
});

describe("errorCause", () => {
  it("keeps name, closed code and message, redacting credentials and query strings", () => {
    const e = Object.assign(new Error("connect failed token=abc123 key: 'k-1' https://h/x?sig=zz Authorization=Bearer qq"), { code: "ECONNRESET" });
    const out = errorCause(e);
    assert.equal(out, "Error ECONNRESET: connect failed token=[redacted] key: [redacted] https://h/x?[query] Authorization=[redacted] [redacted]");
    for (const s of ["abc123", "k-1", "zz"]) assert.equal(out.includes(s), false, s);
    assert.equal(errorCause(new Error("Bearer sk-live-1")), "Error: Bearer [redacted]");
  });
  it("ignores odd names and codes, clips, and handles non-errors", () => {
    const odd = Object.assign(new Error("x"), { code: "lower case", name: "Weird Name!" });
    assert.equal(errorCause(odd), "Error: x");
    assert.equal(errorCause(new TypeError("")), "TypeError");
    assert.ok(Array.from(errorCause(new Error("y".repeat(1000)))).length <= CAUSE_MAX);
    assert.equal(errorCause("boom"), "non-error value thrown");
  });
});
