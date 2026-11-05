import assert from "node:assert/strict";
import { test } from "node:test";
import { captureBrowser } from "../../packages/agent-image/src/browser-capture.ts";
import { captureStaticArticle, screenshotLimitation } from "./article.mts";
import { DEFAULT_CONTENT_BOUNDS as BOUNDS, captureLimitsOption } from "./content-bounds.mts";
import { hash } from "./content-contract.mts";
import { notAnalysed } from "./content-evidence.mts";
import {
  ARTICLE_LIMITATION_MAX,
  ARTICLE_LIMITATIONS_MAX,
  BROWSER_HOST_LIMITATIONS,
  NAVIGATION_LIMITATIONS_MAX,
  STORY_LIMITATION_MAX,
  STORY_LIMITATIONS_MAX,
} from "./limitation-bounds.mts";

// The real worker's navigation log at its worst: every conditional limitation at once, with the largest byte counts the capture can
// state (the raw body at the allocation ceiling, the screenshot retaken twice).
async function worstWorkerLimitations(): Promise<string[]> {
  let samples = 0;
  let log: Record<string, unknown> | null = null;
  const body = new Uint8Array(BOUNDS.capture.rawAllocationMaxBytes);
  await captureBrowser(
    {
      goto: async () => ({ body: async () => body, status: () => 200, headerValue: async (n) => (n === "content-type" ? "text/html" : null) }),
      url: () => "https://publisher.example/final",
      evaluate: async () => ({
        dom: "d".repeat(BOUNDS.capture.maxBytesCeiling + 1),
        text: `${"w ".repeat(BOUNDS.capture.textMaxBytes)}${"z".repeat(++samples)}`,
      }),
      screenshot: async (o) => new Uint8Array(o.clip?.height === 180 ? 8 : 10 * BOUNDS.capture.screenshotMaxBytes),
      close: async () => {},
    },
    {
      url: "https://publisher.example/a",
      maxBytes: BOUNDS.capture.maxBytesCeiling,
      deadlineMs: BOUNDS.browserCaptureDeadlineMs,
      ...captureLimitsOption(BOUNDS),
      settle: { pollMs: 1, stablePolls: 2, maxMs: 20 },
      worker: "w",
      generation: 1,
      publish: async (data, name) => {
        if (name === "browser-navigation") log = JSON.parse(Buffer.from(data).toString("utf8"));
        return { id: name, sha256: hash(data) };
      },
    },
  );
  assert.ok(log, "the worker published its navigation log");
  return (log as { limitations: string[] }).limitations;
}

test("limitation bounds nest: worker output <= verifier cap <= article bound, and article (or dropped) lines plus comment lines <= story bound", async () => {
  const worker = await worstWorkerLimitations();
  // Every conditional line is present, so this is the worker's maximum count.
  for (const re of [/DOM text clipped/, /raw body clipped/, /^DOM clipped/, /screenshot reduced/, /not stabilized/])
    assert.ok(
      worker.some((l) => re.test(l)),
      String(re),
    );
  assert.ok(worker.length <= NAVIGATION_LIMITATIONS_MAX, `worker emits ${worker.length}; verifier accepts ${NAVIGATION_LIMITATIONS_MAX}`);
  for (const l of [...worker, ...BROWSER_HOST_LIMITATIONS]) assert.ok(l.length <= ARTICLE_LIMITATION_MAX, `${l.length}: ${l}`);
  assert.ok(NAVIGATION_LIMITATIONS_MAX + BROWSER_HOST_LIMITATIONS.length <= ARTICLE_LIMITATIONS_MAX, "verified browser article");

  // The static capture at its worst: two fixed lines, the body truncation note and the text clip.
  const long = `<article>${"<p>Sentence about reliable pipelines and careful accounting. </p>".repeat(1000)}</article>`;
  const input = { storyId: 1, url: "https://example.com/a", itemHash: "a".repeat(64), maxBytes: 1_048_576 };
  const stat = captureStaticArticle(input, { status: 200, body: long, sha256: hash(long), contentType: "text/html" }, BOUNDS, {
    truncated: true,
    bytesRetained: 1_048_576,
  });
  assert.ok(stat.limitations.length <= ARTICLE_LIMITATIONS_MAX && stat.limitations.every((l) => l.length <= ARTICLE_LIMITATION_MAX));

  // Story evidence (content-workflow.mts): the article's lines, or for a dropped article the not-analysed line and the screenshot line,
  // plus at most two comment lines (comment failure or none captured, and the unusable-context note).
  const COMMENT_LINES = 2;
  assert.ok(ARTICLE_LIMITATIONS_MAX + COMMENT_LINES <= STORY_LIMITATIONS_MAX);
  assert.ok(2 + COMMENT_LINES <= STORY_LIMITATIONS_MAX);
  assert.ok(ARTICLE_LIMITATION_MAX <= STORY_LIMITATION_MAX);
  assert.ok(notAnalysed("x".repeat(10 * STORY_LIMITATION_MAX)).length <= STORY_LIMITATION_MAX);
  const shot = screenshotLimitation(
    {
      bytes: BOUNDS.capture.screenshotMaxBytes,
      viewportBytes: Number.MAX_SAFE_INTEGER,
      clip: { x: 0, y: 0, width: 1280, height: 360 },
    },
    BOUNDS,
  );
  assert.ok(shot !== null && shot.length <= STORY_LIMITATION_MAX, String(shot?.length));
});
