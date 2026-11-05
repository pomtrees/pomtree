// The content pipeline's bounds, built once from resolved registry values (packages/core/src/config, CONFIG_REGISTRY) and threaded
// by injection to every check that used to read a hand-copied constant: the article input and evidence checks, the static worker, the
// browser-capture argument check, the host verifier, the story-result check, the report renderer, the audited host fetch and the live
// daemon's report limits. The live entry resolves `--config`/`--set`/env exactly as pomtreed does (resolveLiveConfig in content-live.mts);
// everything else uses DEFAULT_CONTENT_BOUNDS, the registry defaults (core's and the digest's params.mts). The worker, the daemon and the verifier agree by construction
// because all three are fed from the one resolved value set.
// Not bounds: the story-result and analysis-shape constants (STORY_RESULT_MAX_BYTES, ANALYSIS_MAX_BYTES, MAX_CLAIMS, the limitation
// bounds) stay digest schema constants (registry Phase 2 decision F2), covered by the measured worst-case tests.
import {
  BROWSER_SCREENSHOT_FALLBACK_HEIGHTS,
  BROWSER_SETTLE_POLLS_MAX,
  BROWSER_SETTLE_WAIT_MAX_MS,
  BROWSER_VIEWPORT,
} from "../../packages/agent-image/src/browser-capture.ts";
import { CONFIG_DEFAULTS, type ConfigParams, type ConfigValues } from "../../packages/core/src/index.ts";
import { HN_DIGEST_DEFAULTS, type HnDigestConfig } from "./params.mts";

// The resolved core keys plus the digest's own (ext.hnDigest.*, params.mts): what resolveLiveConfig returns and contentBounds reads.
export type ContentConfig = ConfigValues<ConfigParams> & HnDigestConfig;

// Every key's registry default, core and digest: the defaults the tests and the non-live paths build their bounds from.
export const CONTENT_CONFIG_DEFAULTS: ContentConfig = Object.freeze({ ...CONFIG_DEFAULTS, ...HN_DIGEST_DEFAULTS });

// What the browser worker was told (browser.capture.*): the same six numbers as agent-image's CaptureLimits, so `capture` is passed to
// captureBrowser as its `limits` unchanged. The host verifier requires the navigation log's recorded limits to equal these.
export type CaptureBounds = {
  maxBytesCeiling: number; // browser.capture.maxBytesCeiling: the largest maxBytes a capture (and an article input) may request
  rawAllocationMaxBytes: number; // browser.capture.rawAllocationMaxBytes: the worker reads no declared main response above it
  textMaxBytes: number; // browser.capture.textMaxBytes: the worker's DOM text clip
  screenshotMaxBytes: number; // browser.capture.screenshotMaxBytes: the largest screenshot PNG
  deadlineMinMs: number; // browser.capture.deadlineMinMs
  deadlineMaxMs: number; // browser.capture.deadlineMaxMs
};

export type ContentBounds = {
  capture: CaptureBounds;
  articleCaptureBytes: number; // ext.hnDigest.articleCaptureBytes: the maxBytes of every article input (raw body and DOM)
  articleTextMaxBytes: number; // ext.hnDigest.articleTextMaxBytes: UTF-8 bytes of article text stored per story, as one retained report (static clip and evidence check)
  articlePageMaxBytes: number; // ext.hnDigest.articlePageMaxBytes: UTF-8 bytes of one page of that text published to the analyst
  articleAnalystReadMaxBytes: number; // ext.hnDigest.articleAnalystReadMaxBytes: UTF-8 bytes of the stored text offered to the analyst as pages
  browserCaptureDeadlineMs: number; // ext.hnDigest.articleBrowserCaptureDeadlineMs: the deadlineMs of every browser_capture call
  auditBodyMaxBytes: number; // ext.hnDigest.articleAuditBodyMaxBytes: the largest body the host's audited fetch reads
  digestReportMaxBytes: number; // ext.hnDigest.reportMaxBytes: the content workflow's report bound
  reportMaxBytes: number; // report.maxBytes: the live daemon's per-report ceiling
  reportCeilingBytes: number; // min(report.workflowMaxBytes, report.maxBytes): the workflow capability ceiling
  // Image facts, not registry keys: agent-image host exports (the worker's own constants), never copies.
  viewport: { width: number; height: number };
  screenshotClipHeights: readonly number[];
  settlePollsMax: number;
  settleWaitMaxMs: number;
};

export function contentBounds(c: ContentConfig): ContentBounds {
  return Object.freeze({
    capture: Object.freeze({
      maxBytesCeiling: c["browser.capture.maxBytesCeiling"],
      rawAllocationMaxBytes: c["browser.capture.rawAllocationMaxBytes"],
      textMaxBytes: c["browser.capture.textMaxBytes"],
      screenshotMaxBytes: c["browser.capture.screenshotMaxBytes"],
      deadlineMinMs: c["browser.capture.deadlineMinMs"],
      deadlineMaxMs: c["browser.capture.deadlineMaxMs"],
    }),
    articleCaptureBytes: c["ext.hnDigest.articleCaptureBytes"],
    articleTextMaxBytes: c["ext.hnDigest.articleTextMaxBytes"],
    articlePageMaxBytes: c["ext.hnDigest.articlePageMaxBytes"],
    articleAnalystReadMaxBytes: c["ext.hnDigest.articleAnalystReadMaxBytes"],
    browserCaptureDeadlineMs: c["ext.hnDigest.articleBrowserCaptureDeadlineMs"],
    auditBodyMaxBytes: c["ext.hnDigest.articleAuditBodyMaxBytes"],
    digestReportMaxBytes: c["ext.hnDigest.reportMaxBytes"],
    reportMaxBytes: c["report.maxBytes"],
    reportCeilingBytes: Math.min(c["report.workflowMaxBytes"], c["report.maxBytes"]),
    viewport: Object.freeze({ width: BROWSER_VIEWPORT.width, height: BROWSER_VIEWPORT.height }),
    screenshotClipHeights: Object.freeze([...BROWSER_SCREENSHOT_FALLBACK_HEIGHTS]),
    settlePollsMax: BROWSER_SETTLE_POLLS_MAX,
    settleWaitMaxMs: BROWSER_SETTLE_WAIT_MAX_MS,
  });
}

export const DEFAULT_CONTENT_BOUNDS: ContentBounds = contentBounds(CONTENT_CONFIG_DEFAULTS);

// The `limits` option of agent-image's captureBrowser, for spreading into its options (`{ ...captureLimitsOption(b), url, ... }`).
export const captureLimitsOption = (b: ContentBounds): { limits: CaptureBounds } => ({ limits: b.capture });
