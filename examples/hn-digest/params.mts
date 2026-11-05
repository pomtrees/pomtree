// The digest's own config keys: the single source in code. manifest.json carries the identical `params` array (the daemon reads the
// manifest as JSON and never runs this file); handler.test.mts and params.test.mts keep the two equal. The loader composes each key as
// `ext.hnDigest.<key>` (env `POMTREED_EXT_HN_DIGEST_<KEY>`) through core's extendRegistry; the keys
// are host-side only and never reach a container. A relation or ceiling names a key of this table bare and a core key by its path.
// Type-only import: a loaded extension file cannot resolve @pomtree/core values at runtime.
import type { ExtParamDecl } from "../../packages/core/src/index.ts";

export const HN_DIGEST_PARAMS = [
  {
    key: "articleCaptureBytes",
    kind: "bytes",
    default: 262_144,
    min: 1,
    doc: "Bytes of raw body and rendered DOM captured per article.",
    // Not bounded by report.workflowMaxBytes: no path carries article bytes through a workflow capability (raw and DOM bytes
    // travel as worker reports or through the digest host's audited fetch, which articleAuditBodyMaxBytes bounds).
    relations: [
      { op: "lte", key: "browser.capture.maxBytesCeiling" },
      { op: "lte", key: "articleAuditBodyMaxBytes" },
    ],
  },
  {
    key: "articleAuditBodyMaxBytes",
    kind: "bytes",
    default: 2 * 1024 * 1024,
    min: 1,
    doc: "Largest response body the digest host's audited fetch reads.",
  },
  {
    key: "articleTextMaxBytes",
    kind: "bytes",
    default: 1024 * 1024,
    min: 1,
    doc: "UTF-8 bytes of article text the digest stores per story, as one retained report (static clip and evidence check); the analyst reads at most ext.hnDigest.articleAnalystReadMaxBytes of it. The browser worker's own clip (browser.capture.textMaxBytes) may not exceed it.",
    relations: [
      { op: "lte", key: "report.maxBytes" },
      { op: "gte", key: "browser.capture.textMaxBytes" },
    ],
  },
  {
    key: "articlePageMaxBytes",
    kind: "bytes",
    default: 16_384,
    min: 4096,
    doc: "UTF-8 bytes of one article page the digest publishes to the analyst (a page is a view of the stored text, never the verification authority).",
    relations: [
      { op: "lte", key: "articleAnalystReadMaxBytes" },
      { op: "lte", key: "report.maxBytes" },
    ],
  },
  {
    key: "articleAnalystReadMaxBytes",
    kind: "bytes",
    default: 262_144,
    min: 1,
    max: 1024 * 1024,
    doc: "UTF-8 bytes of the stored article text the digest offers the analyst, as pages; the first pages that fit are published and the rest is named as unread. Quotes still verify against the whole stored text.",
  },
  {
    key: "articleBrowserCaptureDeadlineMs",
    kind: "ms",
    default: 60_000,
    min: 1,
    doc: "Deadline the digest's browser worker requests for one article capture.",
    relations: [
      { op: "gte", key: "browser.capture.deadlineMinMs" },
      { op: "lte", key: "browser.capture.deadlineMaxMs" },
    ],
  },
  {
    key: "reportMaxBytes",
    kind: "bytes",
    default: 65_536,
    min: 1,
    doc: "Largest rendered digest report the digest workflows publish (the content workflow's report bound and the metadata digest's report capability).",
    relations: [{ op: "lte", key: "report.workflowMaxBytes" }],
  },
] as const satisfies readonly ExtParamDecl[];

export const HN_DIGEST_EXTENSION = "hn-digest";
export const HN_DIGEST_SEGMENT = "hnDigest"; // core's extensionSegment("hn-digest"); params.test.mts checks it

type HnDigestKey = (typeof HN_DIGEST_PARAMS)[number]["key"];
// The digest's resolved keys by full path; every one is a number.
export type HnDigestConfig = { readonly [K in HnDigestKey as `ext.${typeof HN_DIGEST_SEGMENT}.${K}`]: number };

// The table's defaults by full path, typed. The values come from the table above, never a copy.
export const HN_DIGEST_DEFAULTS: HnDigestConfig = Object.freeze(
  Object.fromEntries(HN_DIGEST_PARAMS.map((p) => [`ext.${HN_DIGEST_SEGMENT}.${p.key}`, p.default])),
) as HnDigestConfig;
