// Synthetic astral-plane (non-BMP) fixtures: producers bound by Unicode code points; consumers must accept the same inputs.
// Byte ceilings (TITLE_MAX*4, DISCUSSION_TEXT_MAX*4) are independent of code-point limits and checked at their edges.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type Story, validateComments, type WorkerConfig } from "./content-contract.mts";
import { createContentWorkflows } from "./content-workflow.mts";
import { DEFAULT_CONTENT_BOUNDS } from "./content-bounds.mts";
import { DISCUSSION_TEXT_MAX, type DiscussionSample, parseDiscussion } from "./discussion.mts";
import { ITEM_SOURCE_PREFIX, parseItem, TITLE_MAX } from "./logic.mts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const fixture = JSON.parse(readFileSync(new URL("./content-fixtures/astral.json", import.meta.url), "utf8")) as {
  synthetic: boolean;
  titleCodePoints200: string;
  commentCodePoints600: string;
};
const cps = (s: string): number => Array.from(s).length;
const EMOJI = "\u{1F9EA}";
const WORKERS: WorkerConfig = {
  articleTemplate: "article-template",
  articleMethod: "static-http",
  publicEgressAuthorization: "egress-auth",
  modelTemplate: "model-template",
  modelRoute: "fixture/model",
  modelBudgetMicros: 10000,
  articleBudgetMicros: 1000,
  modelAuthorization: "model-auth",
};
const storyWith = (title: string, kids: number[] = [201]): Story => ({
  id: 101,
  rank: 1,
  title,
  url: "https://example.com/post",
  kids,
  itemHash: "c".repeat(64),
  itemSource: `${ITEM_SOURCE_PREFIX}101.json`,
});
// The public story validator is the production entry point; the verifier is unused by validate().
const storyWorkflow = createContentWorkflows(
  { verify: async () => null, summarize: async () => null, articleText: async () => null, publishPages: async () => {} },
  DEFAULT_CONTENT_BOUNDS,
).find((w) => w.name === "story");
if (!storyWorkflow) throw new Error("story workflow missing");
const validateStory = (story: Story) => storyWorkflow.validate({ instance: "run-1", runId: "run-1", story, workers: WORKERS, budgetMicros: 4000 });
const rawComment = (text: string) => ({ id: 201, type: "comment", parent: 101, time: 1700000000, text });
const sampleOf = (text: string): DiscussionSample =>
  parseDiscussion(rawComment(text), 201, 101, { sha256: sha(JSON.stringify(rawComment(text))), fetchedAt: 1700000001 });

describe("synthetic astral fixture", () => {
  it("is clearly synthetic and contains real non-BMP characters with the stated code-point counts", () => {
    assert.equal(fixture.synthetic, true);
    assert.equal(cps(fixture.titleCodePoints200), 200);
    assert.equal(fixture.titleCodePoints200.length, 400);
    assert.equal(cps(fixture.commentCodePoints600), 600);
    assert.equal(Buffer.byteLength(fixture.commentCodePoints600), 2400);
    assert.equal(fixture.titleCodePoints200, EMOJI.repeat(200));
  });
});

describe("producer bounds (existing parsers)", () => {
  it("parseItem accepts a 200-emoji title and keeps it intact", () => {
    const r = parseItem({ id: 101, type: "story", title: fixture.titleCodePoints200 }, 101);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.item.title, fixture.titleCodePoints200);
  });

  it("parseItem clips over-long astral titles to TITLE_MAX code points, not UTF-16 units", () => {
    const r = parseItem({ id: 101, type: "story", title: EMOJI.repeat(400) }, 101);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(cps(r.item.title), TITLE_MAX);
      assert.ok(Buffer.byteLength(r.item.title) <= TITLE_MAX * 4);
    }
  });

  it("parseDiscussion keeps a 600-emoji depth-1 comment as usable text", () => {
    const s = sampleOf(fixture.commentCodePoints600);
    assert.equal(s.status, "usable");
    assert.equal(s.text, fixture.commentCodePoints600);
  });

  it("parseDiscussion clips over-long astral comments to DISCUSSION_TEXT_MAX code points", () => {
    const s = sampleOf(EMOJI.repeat(1500));
    assert.equal(s.status, "usable");
    assert.ok(cps(s.text) <= DISCUSSION_TEXT_MAX);
    assert.ok(Buffer.byteLength(s.text) <= DISCUSSION_TEXT_MAX * 4);
  });
});

describe("new content consumers accept producer-valid astral inputs", () => {
  it("story validator accepts a 200-emoji title produced by parseItem", () => {
    const r = validateStory(storyWith(fixture.titleCodePoints200));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("story validator accepts a title of exactly TITLE_MAX astral code points (UTF-8 at 4*TITLE_MAX)", () => {
    const title = EMOJI.repeat(TITLE_MAX);
    assert.equal(Buffer.byteLength(title), TITLE_MAX * 4);
    const r = validateStory(storyWith(title));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("story validator rejects a title of TITLE_MAX+1 code points", () => {
    const r = validateStory(storyWith(EMOJI.repeat(TITLE_MAX + 1)));
    assert.equal(r.ok, false);
  });

  it("validateComments accepts a 600-emoji usable comment and returns the full retained sample", () => {
    const story = storyWith(fixture.titleCodePoints200, [201]);
    const sample = sampleOf(fixture.commentCodePoints600);
    const r = validateComments({ samples: [sample] }, story);
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (r.ok) {
      assert.equal(r.value.length, 1);
      assert.equal(r.value[0]?.text, fixture.commentCodePoints600);
      assert.equal(r.value[0]?.status, "usable");
      assert.equal(r.value[0]?.sha256, sample.sha256);
    }
  });

  it("validateComments accepts a comment of exactly DISCUSSION_TEXT_MAX astral code points (UTF-8 at 4*max)", () => {
    const text = EMOJI.repeat(DISCUSSION_TEXT_MAX);
    assert.equal(Buffer.byteLength(text), DISCUSSION_TEXT_MAX * 4);
    const r = validateComments({ samples: [sampleOf(text)] }, storyWith(fixture.titleCodePoints200, [201]));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });

  it("validateComments rejects a usable comment of DISCUSSION_TEXT_MAX+1 code points", () => {
    const over = { ...sampleOf(EMOJI.repeat(DISCUSSION_TEXT_MAX)), text: EMOJI.repeat(DISCUSSION_TEXT_MAX + 1) };
    const r = validateComments({ samples: [over] }, storyWith(fixture.titleCodePoints200, [201]));
    assert.equal(r.ok, false);
  });

  it("parseDiscussion output for an over-long comment is accepted by validateComments", () => {
    const r = validateComments({ samples: [sampleOf(EMOJI.repeat(1500))] }, storyWith(fixture.titleCodePoints200, [201]));
    assert.equal(r.ok, true, r.ok ? "" : r.error);
  });
});
