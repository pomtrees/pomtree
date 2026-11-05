// Browser article capture through the digest and provenance: success, and the four ways a native capture fails to verify (harness: content-harness.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { provenanceOf } from "./content-live-run.mts";
import { articleRetryable, type MissingStory, type StoryResult } from "./content-contract.mts";
import { DEFAULT_CONTENT_BOUNDS } from "./content-bounds.mts";
import { browserBoundDetail } from "./content-evidence.mts";
import { setup } from "./content-harness.mts";

type Env = Awaited<ReturnType<typeof setup>>;
type Result = { reportBody: string; stories: StoryResult[]; entryIds: number[]; failedStories: MissingStory[] };
type Provenance = NonNullable<Parameters<typeof provenanceOf>[0]>;

// Polls like until() but with a caller-chosen budget.
async function waitFor<T>(read: () => Promise<T | null | undefined | false>, note: string, ms = 7000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out: ${note}`);
}

// Runs the tree to its publication gate, approves it, and returns the root result.
async function publish(e: Env): Promise<Result> {
  e.releaseCapture.resolve();
  e.releaseComment.resolve();
  const gate = await waitFor(async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"), "publication gate");
  await e.rt.daemon.decideApproval(gate.id, "approve", "operator", "browser fixture, not live browser", "browser-approve");
  const done = await waitFor(async () => {
    const r = await e.rt.daemon.get(e.id);
    return r && ["exited", "reaped"].includes(r.state) && r;
  }, "root terminal");
  assert.equal(done.exit, "succeeded", JSON.stringify(done.result));
  return done.result as Result;
}

// The article is not analysed with this reason, in the story, the digest Limitation line and provenance; the comments still analyse,
// so the run publishes the story. A worker or verification reason ("other", or a fetch_error without an HTTP status) leaves the story
// unseen so the next run retries it (articleRetryable); a page reason marks it seen as before.
function assertNotAnalysed(result: Result, limitation: string, reason: string) {
  const story = result.stories[0];
  assert.ok(story, "story presented");
  assert.equal(story.evidence.article, null);
  assert.equal(story.evidence.capture?.status, "unusable");
  assert.equal(story.evidence.capture?.reason, reason);
  assert.ok(story.evidence.limitations.includes(`Article not analysed: ${limitation}`), story.evidence.limitations.join(" | "));
  assert.ok(result.reportBody.split("\n").includes(`Limitation: Article not analysed: ${limitation}`), "digest Limitation line");
  assert.ok(story.analysis, "comments still analysed and published");
  const retried = reason === "other" || (reason === "fetch_error" && story.evidence.capture?.httpStatus === null);
  assert.equal(articleRetryable(story), retried);
  assert.deepEqual(result.entryIds, retried ? [] : [101]);
  assert.equal(
    result.reportBody.split("\n").includes("Article capture failed for a worker or verification reason; not marked seen."),
    retried,
    "digest says a retried story is not marked seen",
  );
  const article = provenanceOf(result as unknown as Provenance).articles[0];
  assert.deepEqual([article?.status, article?.capture?.reason, article?.capture?.status], ["unusable", reason, "unusable"]);
  assert.equal(article?.rawHash, null, "no verified body hash for a dropped capture");
}

test("browser article: a verified native capture is analysed with its browser reports and provenance", { timeout: 20000 }, async () => {
  const e = await setup({ browser: true });
  try {
    const result = await publish(e);
    const story = result.stories[0];
    const article = story?.evidence.article;
    assert.equal(article?.status, "usable");
    assert.equal(article?.method, "browser");
    assert.ok(article?.bodyReport && article.textReport && article.domReport && article.screenshotReport && article.browserEvidence);
    // A browser capture keeps its summary beside the usable article: the settle result is in no article field.
    assert.equal(story?.evidence.capture?.status, "usable");
    assert.equal(story?.evidence.capture?.cause, null);
    assert.equal(story?.evidence.capture?.truncated, false);
    assert.equal(typeof story?.evidence.capture?.settle?.settled, "boolean");
    assert.ok(story?.analysis);
    assert.ok(!result.reportBody.split("\n").some((line) => line.startsWith("Limitation: Article not analysed")));
    const provenance = provenanceOf(result as unknown as Provenance).articles[0];
    assert.deepEqual([provenance?.status, provenance?.rawHash], ["usable", article?.rawHash]);
    assert.deepEqual(provenance?.capture, story?.evidence.capture, "provenance carries the capture block, settle included");
    assert.deepEqual(story?.evidence.capture?.screenshot, { bytes: 8, viewportBytes: null, clip: null }, "an unreduced screenshot");
    assert.deepEqual([provenance?.truncated, provenance?.textTruncated], [false, false], "body and text clips are separate fields");
    // The worker finished through the capture_finish tool; it has no bash.
    const articleAgent = (await e.rt.stores.registry.list()).find((a) => a.name === "article-101");
    const calls = (await e.rt.stores.journal.read({ agent: articleAgent?.id as never, limit: 1000 })).flatMap((x) =>
      x.payload.kind === "tool_call" ? [x.payload.tool] : [],
    );
    assert.deepEqual(calls, ["browser_capture", "capture_finish"]);
    assert.deepEqual(e.errors, []);
  } finally {
    await e.cleanup();
  }
});

test("browser article: a bash `pomtree result` finish is rejected as tool-not-found, never recorded as a finish", { timeout: 20000 }, async () => {
  const e = await setup({ browser: true, browserFinish: "bash" });
  try {
    e.releaseCapture.resolve();
    const article = await waitFor(async () => (await e.rt.stores.registry.list()).find((a) => a.name === "article-101"), "article child");
    const rejected = await waitFor(
      async () =>
        (await e.rt.stores.journal.read({ agent: article.id, limit: 1000 })).find(
          (x) => x.payload.kind === "tool_result" && x.payload.callId === "native-finish",
        ),
      "bash finish attempt journaled",
    );
    assert.deepEqual(
      [rejected.payload.kind === "tool_result" && rejected.payload.ok, rejected.payload.kind === "tool_result" && rejected.payload.output],
      [false, "Tool bash not found"],
    );
  } finally {
    await e.cleanup();
  }
});

for (const [browserCapture, name] of [
  ["missing", "browser article: a worker that returns a receipt without invoking browser_capture is not analysed"],
  ["wrong-hash", "browser article: a receipt whose text hash differs from the retained report is not analysed"],
  ["twice", "browser article: a second browser_capture invocation voids the capture and the article is not analysed"],
] as const) {
  test(name, { timeout: 20000 }, async () => {
    const e = await setup({ browser: true, browserCapture });
    try {
      assertNotAnalysed(await publish(e), "capture receipt or retained artifacts did not verify", "other");
    } finally {
      await e.cleanup();
    }
  });
}

test("browser article: a worker that reports succeeded after a failed capture is recorded with the tool's closed cause", { timeout: 20000 }, async () => {
  for (const [cause, reason] of [
    ["bound", "bound"],
    ["non_html", "non_html"],
    ["navigation_error", "fetch_error"],
    ["deadline", "other"],
  ] as const) {
    const e = await setup({ browser: true, browserCapture: "failed", browserFailureCause: cause });
    try {
      const result = await publish(e);
      const story = result.stories[0];
      // A bound drop carries the quotable reason and the machine-readable detail; any other cause gets neither.
      const bound = story?.evidence.capture?.bound;
      if (cause === "bound") {
        assertNotAnalysed(
          result,
          `browser capture failed (cause bound): a size bound was exceeded (browser.capture.rawAllocationMaxBytes ${DEFAULT_CONTENT_BOUNDS.capture.rawAllocationMaxBytes} or browser.capture.screenshotMaxBytes ${DEFAULT_CONTENT_BOUNDS.capture.screenshotMaxBytes}); the worker did not report which one or the observed size`,
          reason,
        );
        assert.deepEqual(bound, browserBoundDetail(DEFAULT_CONTENT_BOUNDS));
        assert.equal(bound?.observedBytes, null, "no observed size is invented");
        assert.deepEqual(provenanceOf(result as unknown as Provenance).articles[0]?.capture?.bound, bound);
      } else {
        assertNotAnalysed(result, `browser capture failed (cause ${cause}); worker succeeded`, reason);
        assert.equal(bound, undefined);
      }
      assert.equal(story?.evidence.capture?.cause, cause);
      assert.equal(story?.evidence.capture?.settle, null, "no verified capture, no settle result");
      assert.equal(provenanceOf(result as unknown as Provenance).articles[0]?.capture?.cause, cause);
    } finally {
      await e.cleanup();
    }
  }
});

test("browser article: an unknown or hostile cause token is recorded as other, never passed through", { timeout: 20000 }, async () => {
  const e = await setup({ browser: true, browserCapture: "failed", browserFailureCause: "not_a_cause" });
  try {
    const result = await publish(e);
    assertNotAnalysed(result, "browser capture failed (cause other); worker succeeded", "other");
    assert.equal(result.stories[0]?.evidence.capture?.cause, "other");
    assert.equal(result.stories[0]?.evidence.capture?.bound, undefined, "an unknown token is not a bound drop");
    assert.ok(!JSON.stringify(result).includes("not_a_cause"));
  } finally {
    await e.cleanup();
  }
});

// TODO(capture-browser-timeout): the browser article worker's hard deadline is 240 seconds (articleSpawnLimits("browser")), longer than an
// offline test may wait. The scenario is kept, skipped, until the deadline can be shortened for tests; the current behavior (the worker is
// stopped at the deadline and recorded as timed_out) is exercised by the daemon's own deadline tests, not here.
test("browser article: a worker that hits its hard deadline is not analysed, and the run still publishes", {
  skip: "TODO(capture-browser-timeout): 240 s real-time deadline",
}, async () => {
  const e = await setup({ browser: true, browserCapture: "hang" });
  try {
    assertNotAnalysed(await publish(e), "article worker timed_out; no capture receipt", "fetch_error");
  } finally {
    await e.cleanup();
  }
});

// The L3 live case: a viewport PNG over the bound is retaken as the top 1280x360 band. Previously only the kept run dir showed it.
test("browser article: a reduced screenshot is in the capture summary, provenance and the digest, for a usable and a dropped article", {
  timeout: 30000,
}, async () => {
  const clip = { x: 0, y: 0, width: 1280, height: 360 };
  const usable = await setup({ browser: true, browserScreenshotReduced: true });
  try {
    const result = await publish(usable);
    const story = result.stories[0];
    assert.equal(story?.evidence.article?.status, "usable");
    assert.deepEqual(story?.evidence.capture?.screenshot?.clip, clip);
    assert.deepEqual(provenanceOf(result as unknown as Provenance).articles[0]?.capture?.screenshot, story?.evidence.capture?.screenshot);
    // A usable article carries the worker's own line; the host does not repeat it.
    assert.ok(result.reportBody.split("\n").some((l) => l.startsWith("Limitation: screenshot reduced to the top 1280x360")));
    assert.ok(!story?.evidence.limitations.some((l) => l.startsWith("Screenshot reduced")));
  } finally {
    await usable.cleanup();
  }
  const thin = await setup({ browser: true, browserScreenshotReduced: true, browserText: "Loading the app." });
  try {
    const result = await publish(thin);
    const story = result.stories[0];
    assert.equal(story?.evidence.article, null);
    assert.equal(story?.evidence.capture?.reason, "thin");
    const shot = story?.evidence.capture?.screenshot;
    assert.deepEqual(shot?.clip, clip);
    assert.equal(shot?.bytes, 8);
    assert.ok((shot?.viewportBytes ?? 0) > 1_048_576);
    const line = `Screenshot reduced to the top 1280x360 px of the 1280x720 viewport (viewport PNG ${shot?.viewportBytes} bytes over the 1048576-byte bound; retained 8 bytes)`;
    assert.ok(story?.evidence.limitations.includes(line), story?.evidence.limitations.join(" | "));
    assert.ok(result.reportBody.split("\n").includes(`Limitation: ${line}`), "digest Limitation line");
    assert.deepEqual(provenanceOf(result as unknown as Provenance).articles[0]?.capture?.screenshot, shot);
  } finally {
    await thin.cleanup();
  }
});

test("a story whose URL names a non-HTML file starts no article worker and is recorded non_html (a page property: marked seen)", {
  timeout: 20000,
}, async () => {
  const item = { id: 101, type: "story", title: "A paper", url: "https://example.com/files/Paper.PDF", kids: [201, 203] };
  const e = await setup({ browser: true, items: { 101: item } });
  try {
    const result = await publish(e);
    assert.equal(
      (await e.rt.stores.registry.list()).some((a) => a.name === "article-101"),
      false,
      "no article worker was spawned",
    );
    const story = result.stories[0];
    assert.equal(story?.evidence.article, null);
    assert.deepEqual(
      [story?.evidence.capture?.status, story?.evidence.capture?.reason, story?.evidence.capture?.cause],
      ["unsupported", "non_html", "non_html"],
    );
    assert.ok(story?.evidence.limitations.includes("Article not analysed: URL path ends in .pdf, not an HTML page; no article worker was started"));
    assert.ok(story?.analysis, "comments still analysed and published");
    assert.equal(articleRetryable(story as StoryResult), false);
    assert.deepEqual(result.entryIds, [101]);
    assert.equal(provenanceOf(result as unknown as Provenance).articles[0]?.capture?.reason, "non_html");
  } finally {
    await e.cleanup();
  }
});
