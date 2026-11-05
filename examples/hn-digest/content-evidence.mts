// Trusted host-side capture verification. No source fetch, credentials, Docker or model calls.
// Authority is an injected mechanical worker adapter, NOT the child's/model's self-reported JSON.
import type { AgentRecord, Registry, ReportStore, WorkflowRunContext } from "../../packages/core/src/index.ts";
import {
  ARTICLE_THIN_TEXT,
  type ArticleEvidence,
  type ArticleInput,
  type BoundDetail,
  boundLimitBytes,
  boundSentence,
  CAPTURE_CAUSES,
  type CaptureCause,
  type CaptureReason,
  type CaptureScreenshot,
  type CaptureSettle,
  type CaptureStatus,
  type CaptureSummary,
  captureStaticArticleDetailed,
  captureSummaryOf,
  challengeMarker,
  checkPublicUrl,
  validCaptureScreenshot,
  validateArticleEvidence,
} from "./article.mts";
import { CLIP_UTF8_MAX_BACKOFF } from "../../packages/agent-image/src/browser-capture.ts";
import { EXTRACTION_REGIONS } from "../../packages/agent-image/src/main-content.ts";
import type { PagePlan } from "./article-pages.mts";
import { BROWSER_NAVIGATION_BYTES, nativeCaptureArgs, type NativeCaptureArgs } from "./browser-contract.mts";
import type { ContentBounds } from "./content-bounds.mts";
import { hash, jsonHash, record, SHA } from "./content-contract.mts";
import { ARTICLE_LIMITATION_MAX, BROWSER_HOST_LIMITATIONS, NAVIGATION_LIMITATIONS_MAX, STORY_LIMITATION_MAX } from "./limitation-bounds.mts";

export type Artifact = { id: string; sha256: string };
export type CaptureReceipt = {
  worker: string;
  generation: number;
  originalUrl: string;
  finalUrl: string;
  method: "static-http" | "browser";
  status: number;
  contentType: string;
  rawBodyReport: Artifact;
  textReport: Artifact;
  navigationReport?: Artifact;
  domReport?: Artifact;
  screenshotReport?: Artifact;
  // Static worker only: the retained body is a prefix of the response; bytesRetained must equal the retained body length.
  truncated?: boolean;
  bytesRetained?: number;
  fetchedAt?: string;
};
export interface CaptureAuthority {
  // Actual mechanical worker/native-tool audit only. Expected arguments are private host inputs, not model authorization.
  receipt(worker: string, generation: number, expected: NativeCaptureArgs): Promise<CaptureReceipt | null>;
}
type VerificationContext = Pick<WorkflowRunContext, "agent" | "generation" | "signal" | "deadlineAt">;
// What the host can state about a capture it verified: the structured summary, and for a page that was not analysed the specific
// reason as one limitation line ("Article not analysed: ..."); null for a usable capture.
export type CaptureOutcome = { capture: CaptureSummary; limitation: string | null };
export interface ArticleVerifier {
  verify(ctx: VerificationContext, child: AgentRecord, input: ArticleInput, method: "static-http" | "browser"): Promise<ArticleEvidence | null>;
  // Same authority and artifact checks as verify, without retaining anything. Null only when the receipt or its artifacts do not
  // verify (the caller then records reason "other"); a verified capture that is not usable yields its specific reason.
  summarize(ctx: VerificationContext, child: AgentRecord, input: ArticleInput, method: "static-http" | "browser"): Promise<CaptureOutcome | null>;
  // The usable article's whole stored text, read from the retained report and checked against textHash, textBytes and the byte bound;
  // null when the report is missing or any check fails. Quotes are verified against this, never against pages.
  articleText(article: ArticleEvidence): Promise<string | null>;
  // Publishes the plan's pages as reports under the analyst child's own custody (the only reports an agent's `pomtree report show` can
  // reach besides its children's), idempotent by page name. A page is a view; it grants no authority over the stored text.
  publishPages(ctx: VerificationContext, analyst: AgentRecord, plan: PagePlan): Promise<void>;
}

// The closed capture cause of a worker's failure token (ExecutorReapReceipt.toolFailureCause, read by the daemon from the child's last
// failed tool error). An absent token is null; a token outside the closed list is "other", never passed through.
export function captureCauseOf(token: string | null | undefined): CaptureCause | null {
  if (token === undefined || token === null) return null;
  return (CAPTURE_CAUSES as readonly string[]).includes(token) ? (token as CaptureCause) : "other";
}
// Maps a browser capture cause onto the closed capture reasons: non_html and bound as they are, navigation_error is a fetch error,
// bot_challenge is blocked (the worker stopped at an anti-bot interstitial), and the rest (and no cause) is "other".
const BROWSER_FAILURE_REASONS: Readonly<Partial<Record<CaptureCause, CaptureReason>>> = {
  non_html: "non_html",
  bound: "bound",
  navigation_error: "fetch_error",
  bot_challenge: "blocked",
  // navigation_changed (the final URL differs from the one captured) has no closed reason of its own: the page was fetched but is not the
  // article that was asked for, which is neither a fetch error nor thin text, so it stays "other" with the cause kept in the summary.
};
export function browserFailureReason(cause: CaptureCause | null): CaptureReason {
  return (cause !== null ? BROWSER_FAILURE_REASONS[cause] : undefined) ?? "other";
}

// What a browser cause "bound" can say. The worker reports only the closed token (its own messages name the main response or the
// screenshot, but the daemon keeps the cause alone), so both configured bounds are candidates and the observed size is unknown.
// TODO(bound-diag): a worker-side detail (which bound and the observed bytes in the tool error) would let this name one bound.
export function browserBoundDetail(b: ContentBounds): BoundDetail {
  const keys = ["browser.capture.rawAllocationMaxBytes", "browser.capture.screenshotMaxBytes"] as const;
  return { limits: keys.map((key) => ({ key, bytes: boundLimitBytes(key, b) })), observedBytes: null };
}
// The limitation line for a failed browser capture: the cause, and for "bound" the quotable reason.
export const browserFailureLimitation = (cause: CaptureCause, exit: string, b: ContentBounds): string =>
  cause === "bound"
    ? `browser capture failed (cause bound): ${boundSentence(browserBoundDetail(b))}`
    : `browser capture failed (cause ${cause}); worker ${exit}`;

// One digest line for an article that was not analysed; clipped so it fits the story result's per-limitation bound.
export const notAnalysed = (reason: string): string => `Article not analysed: ${reason}`.slice(0, STORY_LIMITATION_MAX);

// The static reader's HTML media types (article.mts HTML_TYPES), for the browser capture's content type.
const BROWSER_HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
// Why a verified browser capture is not analysed, on the static reader's terms; null when its text is usable article text.
function browserShortfall(receipt: CaptureReceipt, text: string): { status: CaptureStatus; reason: CaptureReason; limitation: string } | null {
  if (receipt.status < 200 || receipt.status > 299) {
    const marker = challengeMarker(receipt.status, text);
    return marker !== null
      ? { status: "unusable", reason: "blocked", limitation: `HTTP ${receipt.status} challenge page ("${marker}")` }
      : { status: "unusable", reason: "fetch_error", limitation: `HTTP ${receipt.status}` };
  }
  const mediaType = receipt.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!BROWSER_HTML_TYPES.has(mediaType))
    return { status: "unsupported", reason: "non_html", limitation: `content type ${mediaType || "missing"} is not HTML` };
  if (Array.from(text).length < ARTICLE_THIN_TEXT)
    return {
      status: "unsupported",
      reason: "thin",
      limitation: `too thin to ground: under ${ARTICLE_THIN_TEXT} characters of readable text after extraction`,
    };
  return null;
}

// The capture bounds the navigation log states for the retained raw body and DOM, checked against the retained bytes themselves. The worker
// clips the raw body exactly (a truncated raw body retains exactly `maxBytes`) and the DOM at a UTF-8 boundary (a truncated DOM retains
// between `maxBytes - CLIP_SLACK` and `maxBytes`). Null when any key is absent or malformed (no
// compatibility with a log that lacks them) or inconsistent with what was retained.
// The screenshot reduction: limits.screenshotClip and limits.viewportScreenshotBytes are both present (a reduced screenshot) or both
// absent; when present they must be a clip the worker can take of a viewport PNG over the bound, and the log's own limitations must
// state that clip and that size. `bytes` is the retained screenshot artifact's own length, never a logged number.
type BrowserLimits = {
  bodyBytesSeen: number;
  bodyTruncated: boolean;
  domBytesSeen: number;
  domTruncated: boolean;
  settle: CaptureSettle;
  screenshot: CaptureScreenshot;
};
const CLIP_SLACK = CLIP_UTF8_MAX_BACKOFF;
function screenshotOf(log: Record<string, unknown>, limits: Record<string, unknown>, screenshotLength: number, b: ContentBounds): CaptureScreenshot | null {
  const hasClip = "screenshotClip" in limits;
  if (hasClip !== "viewportScreenshotBytes" in limits) return null;
  if (!hasClip)
    return validCaptureScreenshot({ bytes: screenshotLength, viewportBytes: null, clip: null }, b)
      ? { bytes: screenshotLength, viewportBytes: null, clip: null }
      : null;
  const shot = { bytes: screenshotLength, viewportBytes: limits.viewportScreenshotBytes, clip: limits.screenshotClip };
  if (!validCaptureScreenshot(shot, b) || shot.clip === null) return null;
  const { width, height } = shot.clip;
  const stated =
    Array.isArray(log.limitations) &&
    log.limitations.some(
      (s) => typeof s === "string" && /^screenshot reduced/.test(s) && s.includes(`${width}x${height}`) && s.includes(` ${shot.viewportBytes} bytes`),
    );
  return stated ? { bytes: shot.bytes, viewportBytes: shot.viewportBytes, clip: { x: 0, y: 0, width, height } } : null;
}
export function browserLimits(
  log: Record<string, unknown>,
  maxBytes: number,
  rawLength: number,
  domLength: number,
  screenshotLength: number,
  b: ContentBounds,
): BrowserLimits | null {
  const limits = log.limits;
  const extraction = log.extraction;
  if (!record(limits) || !record(extraction) || !record(extraction.settle)) return null;
  const clipped = (seen: unknown, truncated: unknown, kept: number, slack: number): boolean | null => {
    if (!Number.isSafeInteger(seen) || typeof truncated !== "boolean" || kept > maxBytes) return null;
    const full = seen as number;
    if (!truncated) return full === kept ? false : null;
    return full > maxBytes && kept <= maxBytes && kept >= maxBytes - slack ? true : null;
  };
  const body = clipped(limits.rawBodyBytes, limits.rawBodyTruncated, rawLength, 0);
  const dom = clipped(limits.domBytes, limits.domTruncated, domLength, CLIP_SLACK);
  const st = extraction.settle;
  const screenshot = screenshotOf(log, limits, screenshotLength, b);
  if (
    screenshot === null ||
    body === null ||
    dom === null ||
    Object.keys(st).sort().join(",") !== "polls,settled,waitedMs" ||
    typeof st.settled !== "boolean" ||
    !Number.isSafeInteger(st.polls) ||
    (st.polls as number) < 0 ||
    (st.polls as number) > b.settlePollsMax ||
    !Number.isSafeInteger(st.waitedMs) ||
    (st.waitedMs as number) < 0 ||
    (st.waitedMs as number) > b.settleWaitMaxMs
  )
    return null;
  return {
    bodyBytesSeen: limits.rawBodyBytes as number,
    bodyTruncated: body,
    domBytesSeen: limits.domBytes as number,
    domTruncated: dom,
    settle: { settled: st.settled, polls: st.polls as number, waitedMs: st.waitedMs as number },
    screenshot,
  };
}

// Existing report-store primitives, privately scoped to a direct custodian and live generation. No store enters plugin inputs.
// `bounds` are the resolved values the worker was given: a navigation log that records any other text, screenshot, byte or deadline
// limit (an image/daemon skew, or tampering) is refused.
export function createArticleVerifier(deps: {
  registry: Pick<Registry, "get">;
  reports: ReportStore;
  authority: CaptureAuthority;
  root(): Promise<AgentRecord>;
  bounds: ContentBounds;
  now?: () => number;
}): ArticleVerifier {
  const now = deps.now ?? Date.now;
  const b = deps.bounds;
  const live = async (ctx: VerificationContext) => {
    const caller = await deps.registry.get(ctx.agent);
    if (caller?.state !== "running" || caller.generation !== ctx.generation || ctx.signal.aborted || (ctx.deadlineAt !== null && now() >= ctx.deadlineAt))
      throw new Error("capture verifier caller is stale/cancelled");
    return caller;
  };
  // Caller liveness, direct-child custody, the mechanical capture receipt and a bounded verified artifact reader; null when any fails.
  const open = async (ctx: VerificationContext, observed: AgentRecord, input: ArticleInput, method: "static-http" | "browser") => {
    await live(ctx);
    const child = await deps.registry.get(observed.id);
    // Match canonical report self/direct-child authorization. No arbitrary sibling or root-wide read is exposed.
    if (
      !child ||
      child.parent !== ctx.agent ||
      child.generation !== observed.generation ||
      child.state !== "exited" ||
      child.exit !== "succeeded" ||
      child.executor !== "container" ||
      child.spec.egress.kind !== "audited-public"
    )
      return null;
    const expected = nativeCaptureArgs(input, b);
    const receipt = await deps.authority.receipt(child.id, child.generation, expected);
    if (
      !receipt ||
      receipt.worker !== child.id ||
      receipt.generation !== child.generation ||
      receipt.originalUrl !== input.url ||
      receipt.method !== method ||
      !checkPublicUrl(receipt.finalUrl).ok ||
      (method === "browser" && (!receipt.navigationReport || !receipt.domReport || !receipt.screenshotReport))
    )
      return null;
    const read = async (ref: Artifact, limit = input.maxBytes): Promise<Uint8Array | null> => {
      if (!ref || typeof ref.id !== "string" || !SHA.test(ref.sha256)) return null;
      await live(ctx);
      const found = await deps.reports.read(child.id, ref.id);
      if (
        !found ||
        found.report.agent !== child.id ||
        found.report.generation !== child.generation ||
        found.report.sha256 !== ref.sha256 ||
        hash(found.content) !== ref.sha256 ||
        found.content.byteLength !== found.report.sizeBytes ||
        found.content.byteLength > limit
      )
        return null;
      return found.content;
    };
    return { child, receipt, expected, read };
  };
  type Opened = NonNullable<Awaited<ReturnType<typeof open>>>;
  // Browser capture: the navigation log must bind the receipt, the expected invocation and every artifact reference, and the text must be
  // the exact normalized UTF-8 of the retained text report. Returns that text and log, or null. Native tool telemetry is trusted only at the
  // reviewed boundary: it is not agent-independent or cryptographic attestation, nor a complete network-asset log (see verify).
  const browserText = async (
    opened: Opened,
    input: ArticleInput,
    text: Uint8Array,
    raw: Uint8Array,
  ): Promise<{ text: string; log: Record<string, unknown>; limits: BrowserLimits } | null> => {
    const { child, receipt, expected, read } = opened;
    const navigation = receipt.navigationReport ? await read(receipt.navigationReport, BROWSER_NAVIGATION_BYTES) : null;
    const dom = receipt.domReport ? await read(receipt.domReport) : null;
    const screenshot = receipt.screenshotReport ? await read(receipt.screenshotReport, b.capture.screenshotMaxBytes) : null;
    if (!navigation || !dom || !screenshot) return null;
    let log: unknown;
    try {
      log = JSON.parse(Buffer.from(navigation).toString("utf8"));
    } catch {
      return null;
    }
    // Match native capture observations and exact invocation bounds. CONNECT audit alone cannot prove page intent;
    // native tool telemetry is not agent-independent or cryptographic attestation, nor a complete network-asset log.
    // Every limit the log records must EQUAL this host's resolved bounds: a worker that ran with other bounds is refused.
    if (
      !record(log) ||
      log.kind !== "browser-navigation" ||
      log.method !== "browser" ||
      log.sourceKind !== "playwright-cdp-tool-capture" ||
      log.rawBodySource !== "main-response-content-decoded-entity-not-wire" ||
      log.contentType !== receipt.contentType ||
      log.worker !== child.id ||
      log.generation !== child.generation ||
      log.originalUrl !== input.url ||
      log.finalUrl !== receipt.finalUrl ||
      log.status !== receipt.status ||
      jsonHash(log.rawBodyReport) !== jsonHash(receipt.rawBodyReport) ||
      jsonHash(log.domReport) !== jsonHash(receipt.domReport) ||
      jsonHash(log.textReport) !== jsonHash(receipt.textReport) ||
      jsonHash(log.screenshotReport) !== jsonHash(receipt.screenshotReport) ||
      !Array.isArray(log.actions) ||
      log.actions.length < 1 ||
      log.actions.length > 50 ||
      !record(log.extraction) ||
      log.extraction.source !== "rendered-dom-innerText" ||
      !(EXTRACTION_REGIONS as readonly unknown[]).includes(log.extraction.region) ||
      log.extraction.normalization !== "collapse-whitespace-trim" ||
      log.extraction.maxBytes !== b.capture.textMaxBytes ||
      typeof log.extraction.truncated !== "boolean" ||
      !record(log.limits) ||
      log.limits.maxBytes !== expected.maxBytes ||
      log.limits.deadlineMs !== expected.deadlineMs ||
      log.limits.textBytes !== b.capture.textMaxBytes ||
      log.limits.screenshotBytes !== b.capture.screenshotMaxBytes ||
      log.limits.truncated !== log.extraction.truncated ||
      !Array.isArray(log.limitations) ||
      log.limitations.length > NAVIGATION_LIMITATIONS_MAX ||
      !log.limitations.every((s) => typeof s === "string" && s.length <= ARTICLE_LIMITATION_MAX) ||
      (log.extraction.truncated && !log.limitations.some((s) => typeof s === "string" && /clipped/i.test(s)))
    )
      return null;
    const limits = browserLimits(log, expected.maxBytes, raw.byteLength, dom.byteLength, screenshot.byteLength, b);
    // A clipped raw body or DOM must say so in the log's own limitations, as the text clip does.
    if (!limits || ((limits.bodyTruncated || limits.domTruncated) && !log.limitations.some((s) => typeof s === "string" && /clipped/i.test(s)))) return null;
    if (
      !log.actions.every((a) => record(a) && typeof a.kind === "string" && typeof a.url === "string" && checkPublicUrl(a.url).ok) ||
      !log.actions.some((a) => record(a) && a.kind === "navigate" && a.url === expected.url) ||
      !log.actions.some((a) => record(a) && a.kind === "navigation" && a.url === receipt.finalUrl)
    )
      return null;
    const capturedText = Buffer.from(text).toString("utf8");
    // A NUL is refused here, as `articleText` refuses it at retention, so the capture fails at verification rather than later ("retained article text did not verify").
    if (!Buffer.from(capturedText).equals(Buffer.from(text)) || capturedText.replace(/\s+/g, " ").trim() !== capturedText || capturedText.includes("\u0000"))
      return null;
    return { text: capturedText, log, limits };
  };
  return {
    async verify(ctx, observed, input, method) {
      const opened = await open(ctx, observed, input, method);
      if (!opened) return null;
      const { child, receipt, read } = opened;
      const raw = await read(receipt.rawBodyReport);
      // The stored text's bound is the method's: the browser capture's own clip, or the static reader's article text bound.
      const text = await read(receipt.textReport, method === "browser" ? b.capture.textMaxBytes : b.articleTextMaxBytes);
      if (!raw || !text) return null;
      let evidence: ArticleEvidence;
      if (method === "static-http") {
        if (receipt.truncated === true && receipt.bytesRetained !== raw.byteLength) return null;
        const detail = captureStaticArticleDetailed(
          input,
          {
            status: receipt.status,
            contentType: receipt.contentType,
            body: Buffer.from(raw).toString("utf8"),
            sha256: receipt.rawBodyReport.sha256,
          },
          b,
          { truncated: receipt.truncated, bytesRetained: receipt.bytesRetained, fetchedAt: receipt.fetchedAt },
        );
        evidence = detail.evidence;
        if (evidence.status !== "usable" || detail.text !== Buffer.from(text).toString("utf8") || detail.text.includes("\u0000")) return null;
      } else {
        const captured = await browserText(opened, input, text, raw);
        if (!captured || browserShortfall(receipt, captured.text)) return null;
        evidence = {
          storyId: input.storyId,
          url: input.url,
          status: "usable",
          method,
          rawHash: receipt.rawBodyReport.sha256,
          textHash: receipt.textReport.sha256,
          textBytes: text.byteLength,
          limitations: [...BROWSER_HOST_LIMITATIONS, ...(captured.log.limitations as string[])],
          bodyReport: receipt.rawBodyReport,
          domReport: receipt.domReport,
          textReport: receipt.textReport,
          screenshotReport: receipt.screenshotReport,
          browserEvidence: receipt.navigationReport,
          truncated: captured.limits.bodyTruncated,
          // Verified in browserText: the log's text clip flag equals limits.truncated and a clipped text states it in the limitations.
          textTruncated: (captured.log.extraction as Record<string, unknown>).truncated as boolean,
          bytesRetained: raw.byteLength,
          bytesSeen: captured.limits.bodyBytesSeen,
        };
      }
      const root = await deps.root();
      type ArtifactKind = "body" | "dom" | "text" | "screenshot" | "navigation";
      const retain = async (ref: Artifact, bytes: Uint8Array, kind: ArtifactKind): Promise<Artifact> => {
        await live(ctx);
        const id = `capture-${hash(`${child.id}:${child.generation}:${kind}:${ref.id}:${ref.sha256}`)}`;
        // Keep raw/DOM HTML inert; preserve safe image/JSON identity after child GC. Do not enable active HTML rendering.
        const mediaType = kind === "screenshot" ? "image/png" : kind === "navigation" ? "application/json" : "text/plain";
        const copy = await deps.reports.write(
          {
            id,
            agent: root.id,
            generation: root.generation,
            host: root.host,
            name: `hn-${input.storyId}-${kind}`,
            mediaType,
            sha256: ref.sha256,
            sizeBytes: bytes.byteLength,
            content: bytes,
          },
          `${ctx.agent}:retain:${id}`,
        );
        const retained = await deps.reports.read(root.id, copy.id);
        if (!retained || retained.report.mediaType !== mediaType || retained.report.sha256 !== ref.sha256 || hash(retained.content) !== hash(bytes))
          throw new Error("capture retention verification failed");
        await live(ctx);
        return { id: copy.id, sha256: copy.sha256 };
      };
      evidence.bodyReport = await retain(receipt.rawBodyReport, raw, "body");
      evidence.textReport = await retain(receipt.textReport, text, "text");
      evidence.finalUrl = receipt.finalUrl;
      if (receipt.domReport) {
        const dom = await read(receipt.domReport);
        if (!dom) return null;
        evidence.domReport = await retain(receipt.domReport, dom, "dom");
      }
      if (receipt.screenshotReport) {
        const screenshot = await read(receipt.screenshotReport, b.capture.screenshotMaxBytes);
        if (!screenshot) return null;
        evidence.screenshotReport = await retain(receipt.screenshotReport, screenshot, "screenshot");
      }
      if (receipt.navigationReport) {
        const navigation = await read(receipt.navigationReport, BROWSER_NAVIGATION_BYTES);
        if (!navigation) return null;
        evidence.browserEvidence = await retain(receipt.navigationReport, navigation, "navigation");
      }
      const checked = validateArticleEvidence(evidence, input, b);
      await live(ctx);
      return checked.ok ? checked.value : null;
    },
    async summarize(ctx, observed, input, method) {
      const opened = await open(ctx, observed, input, method);
      if (!opened) return null;
      const { receipt, read } = opened;
      const raw = await read(receipt.rawBodyReport);
      if (!raw) return null;
      if (method === "browser") {
        // TODO(capture-browser-reason): a browser capture gets the thin-text rule only. The static boilerplate ratio is not applied to
        // mechanical innerText, so a page whose visible text is mostly chrome counts as usable once it reaches the thin-text length.
        const text = await read(receipt.textReport, b.capture.textMaxBytes);
        const captured = text ? await browserText(opened, input, text, raw) : null;
        if (!captured) return null;
        const shortfall = browserShortfall(receipt, captured.text);
        // Origin only, as the static summary: the receipt's final URL passed checkPublicUrl in open. Over 200 characters is not kept.
        const origin = new URL(receipt.finalUrl).origin;
        return {
          capture: {
            status: shortfall?.status ?? "usable",
            reason: shortfall?.reason ?? null,
            textChars: Array.from(captured.text).length,
            bodyBytes: raw.byteLength,
            bodyBytesSeen: captured.limits.bodyBytesSeen,
            // From the verified navigation limits: the retained raw body is a prefix when the capture clipped it at the bound.
            truncated: captured.limits.bodyTruncated,
            domBytesSeen: captured.limits.domBytesSeen,
            domTruncated: captured.limits.domTruncated,
            httpStatus: receipt.status,
            cause: null,
            settle: captured.limits.settle,
            screenshot: captured.limits.screenshot,
            rawHash: receipt.rawBodyReport.sha256,
            textHash: receipt.textReport.sha256,
            finalOrigin: origin.length <= 200 ? origin : null,
          },
          limitation: shortfall ? notAnalysed(shortfall.limitation) : null,
        };
      }
      if (receipt.truncated === true && receipt.bytesRetained !== raw.byteLength) return null;
      const body = Buffer.from(raw).toString("utf8");
      const detail = captureStaticArticleDetailed(
        input,
        { status: receipt.status, contentType: receipt.contentType, body, sha256: receipt.rawBodyReport.sha256 },
        b,
        { truncated: receipt.truncated, bytesRetained: receipt.bytesRetained, fetchedAt: receipt.fetchedAt },
      );
      const reason = detail.evidence.limitations[0] ?? "capture did not yield article text";
      return {
        capture: captureSummaryOf(detail, raw.byteLength, receipt.finalUrl),
        limitation: detail.evidence.status === "usable" ? null : notAnalysed(reason),
      };
    },
    async articleText(article) {
      if (article.status !== "usable" || !article.textReport || article.textHash === null || article.textReport.sha256 !== article.textHash) return null;
      const root = await deps.root();
      const found = await deps.reports.read(root.id, article.textReport.id);
      if (
        !found ||
        found.report.sha256 !== article.textHash ||
        hash(found.content) !== article.textHash ||
        found.content.byteLength !== found.report.sizeBytes ||
        found.content.byteLength !== article.textBytes ||
        found.content.byteLength > b.articleTextMaxBytes
      )
        return null;
      const text = Buffer.from(found.content).toString("utf8");
      // Lossy decode or NUL: not the text that was hashed, or not safe to quote against.
      return Buffer.from(text).equals(Buffer.from(found.content)) && !text.includes("\u0000") ? text : null;
    },
    async publishPages(ctx, analyst, plan) {
      const caller = await live(ctx);
      const current = await deps.registry.get(analyst.id);
      if (!current || current.parent !== caller.id) throw new Error("article pages are published only to the caller's own analyst child");
      for (const page of plan.pages) {
        await live(ctx);
        const content = Buffer.from(page.content);
        const written = await deps.reports.write(
          {
            id: page.name,
            agent: current.id,
            generation: current.generation,
            host: current.host,
            name: page.name,
            mediaType: "text/plain",
            sha256: page.sha256,
            sizeBytes: content.byteLength,
            content,
          },
          `${ctx.agent}:page:${current.id}:${page.name}`,
        );
        if (written.sha256 !== page.sha256)
          throw new Error(
            `article page ${page.name} already exists with different content: the page bounds (ext.hnDigest.articlePageMaxBytes, ext.hnDigest.articleAnalystReadMaxBytes) or text changed across a restart; resume with the bounds of the first run`,
          );
      }
    },
  };
}
