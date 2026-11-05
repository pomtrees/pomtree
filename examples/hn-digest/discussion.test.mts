import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type DiscussionSample, normalizeSentiment, parseDiscussion, SUMMARY_MAX, selectDiscussionIds, sourceUrlOf, TARGET_MAX } from "./discussion.mts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./discussion-fixtures/${name}`, import.meta.url), "utf8"));
const META = { sha256: "a".repeat(64), fetchedAt: 1_700_000_000_000 };
const parse = (raw: unknown, id = 201, storyId = 100) => parseDiscussion(raw, id, storyId, META);
const sample = (over: Partial<DiscussionSample>): DiscussionSample => ({
  id: 201,
  storyId: 100,
  parent: 100,
  sourceUrl: sourceUrlOf(201),
  sha256: META.sha256,
  fetchedAt: META.fetchedAt,
  status: "usable",
  text: "text",
  ...over,
});

describe("selectDiscussionIds", () => {
  it("keeps ranked display order (not sorted), skips invalid and repeated entries, caps at 2 by default", () => {
    assert.deepEqual(selectDiscussionIds([900, 5, 300]), [900, 5]);
    assert.deepEqual(selectDiscussionIds(["x", -1, 0, 1.5, 7, 7, 8]), [7, 8]);
    assert.deepEqual(selectDiscussionIds([1, 2, 3], 3), [1, 2, 3]);
  });
  it("rejects non-arrays and oversized arrays", () => {
    assert.throws(() => selectDiscussionIds("1,2"), TypeError);
    assert.throws(() => selectDiscussionIds(Array.from({ length: 501 }, (_, i) => i + 1)), RangeError);
    assert.equal(
      selectDiscussionIds(
        Array.from({ length: 500 }, (_, i) => i + 1),
        2,
      ).length,
      2,
    );
  });
});

describe("parseDiscussion", () => {
  it("usable comment: official URL, parent, time, sanitized text, no author fields", () => {
    const s = parse(fixture("comment_201_usable.json"));
    assert.equal(s.status, "usable");
    assert.equal(s.sourceUrl, "https://hacker-news.firebaseio.com/v0/item/201.json");
    assert.equal(s.parent, 100);
    assert.equal(s.time, 1700000201);
    assert.equal(s.text, 'I like the "small batch" approach & the clear docs.');
    assert.equal("by" in s, false);
    assert.deepEqual(Object.keys(s).sort(), ["fetchedAt", "id", "parent", "sha256", "sourceUrl", "status", "storyId", "text", "time"]);
  });
  it("deleted and dead records keep only actual fields and never a used text", () => {
    const d = parse(fixture("comment_203_deleted.json"), 203);
    assert.equal(d.status, "deleted");
    assert.equal(d.text, "");
    assert.equal(d.parent, 100);
    const dead = parse(fixture("comment_204_dead.json"), 204);
    assert.equal(dead.status, "dead");
    assert.equal(dead.text, "");
  });
  it("sparse record without parent gets no invented parent", () => {
    const s = parse({ id: 206, type: "comment" }, 206);
    assert.equal(s.status, "wrong_parent");
    assert.equal(s.text, "");
    assert.equal(s.status, "wrong_parent");
    assert.equal("parent" in s, false);
    assert.equal("time" in s, false);
  });
  it("null, non-object and mismatched records classify without throwing", () => {
    assert.equal(parse(null).status, "null");
    assert.equal(parse(fixture("null_item.json")).status, "null");
    assert.equal(parse("text").status, "malformed");
    assert.equal(parse([1]).status, "malformed");
    assert.equal(parse({ id: 999, type: "comment", parent: 100, text: "x" }).status, "malformed");
    assert.equal(parse({ id: 201, type: "story", parent: 100, text: "x" }).status, "malformed");
    assert.equal(parse(fixture("comment_205_wrong_parent.json"), 205).status, "wrong_parent");
  });
  it("missing text is classified and an HTML-only body is missing text", () => {
    assert.equal(parse(fixture("comment_206_missing_text.json"), 206).status, "missing_text");
    assert.equal(parse({ id: 201, type: "comment", parent: 100, text: "<script>x</script>" }).status, "missing_text");
  });
  it("HTML: strips scripts/styles/tags, decodes entities, keeps public text", () => {
    const s = parse(fixture("comment_207_html.json"), 207);
    assert.equal(s.status, "usable");
    assert.ok(!s.text.includes("alert"));
    assert.ok(!/<\/?[a-z]/i.test(s.text));
    assert.ok(s.text.includes("Nice work."));
    assert.ok(s.text.includes("'team'"));
    assert.ok(s.text.includes("<3"));
    assert.ok(s.text.includes("@ someone"));
  });
  it("comment without time omits time; text is clipped to 1000 characters", () => {
    const s = parse(fixture("comment_208_no_time.json"), 208);
    assert.equal("time" in s, false);
    const long = parse({ id: 201, type: "comment", parent: 100, text: "word ".repeat(400) });
    assert.equal(long.status, "usable");
    assert.ok(Array.from(long.text).length <= 1000);
  });
  it("rejects a malformed meta argument", () => {
    assert.throws(() => parseDiscussion({}, 201, 100, { sha256: "xyz", fetchedAt: 1 }), TypeError);
    assert.throws(() => parseDiscussion({}, 0, 100, META), TypeError);
  });
});

const usable = [sample({ id: 201, text: "praise" }), sample({ id: 202, text: "cost" })];

describe("normalizeSentiment grounding", () => {
  it("zero usable comments: deterministic insufficient result, model output ignored, no score", () => {
    const deleted = [sample({ id: 203, status: "deleted" })];
    const out = normalizeSentiment(null, 100, deleted);
    assert.ok(out);
    assert.equal(out.label, "insufficient_discussion_data");
    assert.deepEqual(out.citations, []);
    assert.deepEqual(Object.keys(out).sort(), ["citations", "label", "scope", "summary", "target", "tentative"]);
  });
  it("mixed fixture with a positive and a negative captured comment is accepted", () => {
    const out = normalizeSentiment(fixture("sentiment_mixed.json"), 100, usable);
    assert.ok(out);
    assert.equal(out.label, "mixed");
    assert.deepEqual(out.citations, [201, 202]);
    assert.equal(out.scope, "captured_depth1_sample_only");
    assert.equal(out.tentative, true);
    assert.equal("score" in out, false);
    assert.equal("confidence" in out, false);
  });
  it("one usable comment forces unclear and cites that comment", () => {
    const out = normalizeSentiment({ label: "mixed", target: "t", summary: "s", citations: [202] }, 100, [sample({ id: 202 })]);
    assert.ok(out);
    assert.equal(out.label, "unclear");
    assert.deepEqual(out.citations, [202]);
  });
  it("sarcasm-prone thin sample from the model stays unclear with both citations", () => {
    const out = normalizeSentiment(fixture("sentiment_sarcasm.json"), 100, [sample({ id: 201 }), sample({ id: 208 })]);
    assert.ok(out);
    assert.equal(out.label, "unclear");
    assert.deepEqual(out.citations, [201, 208]);
    assert.match(out.summary, /too small/);
  });
  it("cross-story, unknown, duplicate and uncited outputs are invalid", () => {
    const other = sample({ id: 301, storyId: 200, parent: 200 });
    assert.equal(normalizeSentiment(fixture("sentiment_cross_story.json"), 100, [...usable, other]), null);
    assert.equal(normalizeSentiment(fixture("sentiment_unknown_citation.json"), 100, usable), null);
    assert.equal(normalizeSentiment(fixture("sentiment_duplicate_citation.json"), 100, usable), null);
    assert.equal(normalizeSentiment({ label: "mixed", target: "t", summary: "s", citations: [] }, 100, usable), null);
  });
  it("invalid labels, insufficient label with usable comments, and non-objects are rejected", () => {
    assert.equal(normalizeSentiment({ label: "great", target: "t", summary: "s", citations: [201] }, 100, usable), null);
    assert.equal(normalizeSentiment({ label: "insufficient_discussion_data", target: "t", summary: "s", citations: [201] }, 100, usable), null);
    assert.equal(normalizeSentiment("mixed", 100, usable), null);
  });
  it("ignores samples from other stories and non-usable statuses when grounding", () => {
    const mixedBag = [sample({ id: 201 }), sample({ id: 202, status: "dead" }), sample({ id: 301, storyId: 200, parent: 200 })];
    const out = normalizeSentiment({ label: "positive", target: "t", summary: "s", citations: [201] }, 100, mixedBag);
    assert.ok(out);
    assert.equal(out.label, "unclear");
    assert.equal(normalizeSentiment({ label: "positive", target: "t", summary: "s", citations: [202] }, 100, mixedBag), null);
  });
  it("clips target and summary", () => {
    const out = normalizeSentiment({ label: "mixed", target: "t".repeat(500), summary: "s".repeat(900), citations: [201, 202] }, 100, usable);
    assert.ok(out);
    assert.ok(Array.from(out.target).length <= TARGET_MAX);
    assert.ok(Array.from(out.summary).length <= SUMMARY_MAX);
  });
});
