// Paged article reading through the real offline stack (content-harness.mts): the whole text is stored as a retained report, the analyst is
// offered only the first pages of it under its own custody, and every article quote is verified against the WHOLE stored text.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ANALYSIS_DEADLINE_BASE_MS, ANALYSIS_DEADLINE_PER_PAGE_MS, analysisDeadlineMs, pageName } from "./article-pages.mts";
import { CONTENT_CONFIG_DEFAULTS, contentBounds } from "./content-bounds.mts";
import type { StoryResult } from "./content-contract.mts";
import { type Options, setup, until } from "./content-harness.mts";
import { DEADLINE_KIND } from "../../packages/pomtreed/src/watchdog.ts";

// About 15 KB of distinct paragraphs; with 4096-byte pages and an 8192-byte read budget the analyst is offered the first three short pages and the rest is unread.
const PARAGRAPHS = Array.from(
  { length: 110 },
  (_, k) => `<p>Paragraph ${k} of the long report explains why batch pipelines drop records quietly and how an append-only ledger of attempts exposes it.</p>`,
);
const LONG = { status: 200, contentType: "text/html", body: `<html><body><article>${PARAGRAPHS.join("")}</article></body></html>` };
const BOUNDS = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "ext.hnDigest.articlePageMaxBytes": 4096, "ext.hnDigest.articleAnalystReadMaxBytes": 8192 });

async function run(options: Options) {
  const before = Date.now();
  const e = await setup({ page: LONG, bounds: BOUNDS, ...options });
  try {
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "final publish approval",
    );
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "offline fixture draft accepted", "approve-paging");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "content root finished");
    assert.equal(done.exit, "succeeded", JSON.stringify(done.result));
    const story = (done.result as { stories: StoryResult[] }).stories[0] as StoryResult;
    const agents = await e.rt.stores.registry.list();
    const analyst = agents.find((a) => a.name === "analysis-101");
    assert.ok(analyst);
    const pages = (await e.rt.reportStore.list(analyst.id)).map((r) => r.name).sort();
    assert.deepEqual(e.errors, []);
    const entries = await e.rt.stores.journal.read({ agent: analyst.id, limit: 100 });
    const deadlineAt = entries.map((x) => x.payload as { kind?: string; at?: unknown }).find((p) => p.kind === DEADLINE_KIND)?.at;
    return { story, analyst, pages, deadlineAt, before };
  } finally {
    await e.cleanup();
  }
}

test("paging: the whole text is stored, the analyst is offered only the pages within the read budget and is told what is not offered", {
  timeout: 20000,
}, async () => {
  const { story, analyst, pages, deadlineAt, before } = await run({});
  const article = story.evidence.article;
  assert.ok(article && article.status === "usable");
  assert.ok(article.textBytes > BOUNDS.articleAnalystReadMaxBytes, "the stored text is larger than the read budget");
  assert.equal(article.textTruncated, false, "the stored bound (ext.hnDigest.articleTextMaxBytes) was not reached, so the text is whole");
  // Pages end at a word boundary, so slightly under 4096 bytes each: the 8192-byte budget takes three of them, and no fourth page exists to read.
  assert.deepEqual(pages, [pageName(1), pageName(2), pageName(3)]);
  const offered = /you are offered 3 page\(s\) of it, (\d+) bytes/.exec(analyst.task);
  assert.ok(offered && Number(offered[1]) <= BOUNDS.articleAnalystReadMaxBytes && Number(offered[1]) > 8192 - 4096, analyst.task.slice(0, 600));
  assert.match(analyst.task, /Read page N \(1\.\.3\) by calling the article_page tool with page: N/);
  assert.match(analyst.task, /bytes at the end of the article are NOT offered \(read budget ext\.hnDigest\.articleAnalystReadMaxBytes 8192\)/);
  assert.ok(!analyst.task.includes("Paragraph 100 "), "the article text is not in the prompt");
  assert.equal(story.analysis !== null, true, story.failure ?? "");
  // The analysis child's spawn deadline follows the pages offered (the durable deadline entry is spawn + deadlineMs; the root carries none offline).
  const expected = analysisDeadlineMs(3);
  assert.equal(expected, ANALYSIS_DEADLINE_BASE_MS + 3 * ANALYSIS_DEADLINE_PER_PAGE_MS);
  assert.ok(
    typeof deadlineAt === "number" && deadlineAt >= before + expected && deadlineAt <= Date.now() + expected,
    `analysis deadline ${String(deadlineAt)} is not spawn + ${expected}`,
  );
});

test("paging: a quote that is only in the unread part of the stored text verifies against the whole text's hash", { timeout: 20000 }, async () => {
  const { story, pages } = await run({ articleQuote: "tail" });
  assert.equal(pages.length, 3);
  assert.ok(story.analysis, story.failure ?? "a tail quote the analyst was never offered must verify");
  const cited = story.analysis.claims.flatMap((c) => c.citations).find((c) => c.kind === "article");
  assert.ok(cited?.quote.includes("Paragraph 109"), "the quote is from the last paragraph, beyond both pages");
});

test("paging: a quote that is in no part of the stored text is refused and recorded as not_found", { timeout: 20000 }, async () => {
  const { story } = await run({ articleQuote: "absent" });
  assert.equal(story.analysis, null);
  assert.equal(story.failure, "claim citation is not grounded in captured text");
  assert.deepEqual(
    story.rejected?.citations.filter((c) => c.kind === "article").map((c) => c.reason),
    ["not_found"],
  );
});
