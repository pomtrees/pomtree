// Trusted in-image capture shell: executes inside the worker, never on the daemon host.
// Main response entity bytes and rendered DOM are distinct. This is tool provenance, not attestation.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CDP_PORT,
  CLI_POMTREE_MAIN,
  CLI_POMTREE_TIMEOUT_MS,
  CONTAINER_CONFIG_ENV,
  type ContainerConfig,
  FIXED_PATH,
  PROXY_ENV_NAMES,
  readContainerConfig,
} from "./container-contract.gen.ts";
import { EXTRACTION_REGION_FALLBACK, type ExtractionRegion, MAIN_CONTENT_TUNING, snapshotInPage } from "./main-content.ts";

export interface CaptureReport {
  id: string;
  sha256: string;
}
export interface CaptureReceipt {
  worker: string;
  generation: number;
  originalUrl: string;
  finalUrl: string;
  method: "browser";
  status: number;
  contentType: string;
  screenshotReport: CaptureReport;
  rawBodyReport: CaptureReport;
  domReport: CaptureReport;
  textReport: CaptureReport;
  navigationReport: CaptureReport;
}
export interface CapturePage {
  goto(
    url: string,
    opts: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<{
    body(): Promise<Uint8Array>;
    status(): number;
    headerValue(name: string): Promise<string | null>;
    // Playwright's Response.request(): the main request as sent (its headers include the User-Agent). Optional so a scripted page may omit it;
    // a capture that checks the User-Agent then refuses (captureBrowser).
    request?(): { headerValue(name: string): Promise<string | null> };
  } | null>;
  url(): string;
  // Runs `fn(arg)` in the page. `region` is optional so a scripted page may omit it; the receipt then states the unrefined region.
  evaluate(fn: typeof snapshotInPage, arg: typeof MAIN_CONTENT_TUNING): Promise<{ dom: string; text: string; region?: ExtractionRegion; rejected?: string }>;
  screenshot(opts: { type: "png"; timeout: number; clip?: ScreenshotClip }): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
}
// Report names this capture publishes under. The e2e audit maps these to file extensions, so it must stay exhaustive over them.
export const CAPTURE_REPORT_NAMES = {
  rawBody: "browser-main-response",
  dom: "browser-rendered-dom",
  text: "browser-dom-text",
  screenshot: "browser-screenshot",
  navigation: "browser-navigation",
} as const;
export function captureUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || raw.length > 4096)
    throw new Error("capture requires a credential-free bounded HTTP(S) URL");
  // Destination/private checks are authoritative in the proxy, including every redirect/asset.
  return url.href;
}
// core's `fetch.userAgent` check (userAgentReason in packages/core/src/config/params-daemon.ts) is authoritative; the capture re-checks
// the value it is about to put in a header and refuses rather than sending a malformed or empty identity (rule 8, fail closed).
const USER_AGENT_MAX = 256;
export function operatorUserAgentProblem(v: string): string | null {
  if (v === "") return "is empty; pomtreed must pass the resolved workflow.fetch.userAgent, which is never blank (a wiring bug: report it)";
  if (v.length > USER_AGENT_MAX) return `is over ${USER_AGENT_MAX} characters`;
  if (!/^[\x20-\x7e]+$/.test(v)) return "must be printable ASCII (no control characters or non-ASCII)";
  if (v.trim() !== v) return "has leading or trailing whitespace";
  return null;
}
// Decision C4: Chromium keeps its own UA string, HeadlessChrome included, with the operator's value appended. Never a desktop browser's.
// The one composition for both browser paths: the Pi tool's capture (main below) and the model-free capture worker.
export function composeUserAgent(chromium: string, operator: string): string {
  if (operatorUserAgentProblem(chromium) !== null) throw new Error("browser capture could not read Chromium's own User-Agent over CDP");
  return `${chromium} ${operator}`;
}
// The slice of a Playwright Browser that reads Chromium's own User-Agent.
export interface ChromiumVersionSource {
  newBrowserCDPSession(): Promise<{ send(method: "Browser.getVersion"): Promise<unknown> }>;
}
// The User-Agent a capture context is given: Chromium's own (Browser.getVersion over CDP) with the operator's value appended.
export async function contextUserAgent(browser: ChromiumVersionSource, operator: string): Promise<string> {
  return composeUserAgent(await reportedUserAgent(browser), operator);
}
// The User-Agent Chromium reports over CDP (Browser.getVersion); "" when absent, which composeUserAgent refuses.
async function reportedUserAgent(browser: ChromiumVersionSource): Promise<string> {
  const version = (await (await browser.newBrowserCDPSession()).send("Browser.getVersion")) as { userAgent?: unknown };
  return typeof version.userAgent === "string" ? version.userAgent : "";
}
// The controller-set operator identity of a Pi-driven browser worker (pomtreed browserEnv: the resolved workflow.fetch.userAgent).
export const BROWSER_USER_AGENT_ENV = "PTREE_BROWSER_USER_AGENT";
// Read before Chromium is touched; absent or invalid refuses the capture (never a default of this layer: config resolves blank to the default).
export function browserOperatorUserAgent(env: Readonly<Record<string, string | undefined>>): string {
  const v = env[BROWSER_USER_AGENT_ENV];
  const problem =
    v === undefined
      ? "is not set; pomtreed must pass the resolved workflow.fetch.userAgent to every browser worker (a wiring bug: report it)"
      : operatorUserAgentProblem(v);
  if (problem !== null) throw new Error(`browser capture refused: ${BROWSER_USER_AGENT_ENV} ${problem}`);
  return v as string;
}
// The main request must have carried exactly the User-Agent the context was given: a capture that cannot show it, or sent another, issues no receipt.
export function checkSentUserAgent(sent: string | undefined, expected: string): void {
  if (sent === undefined) throw new Error("browser capture could not read the User-Agent the main request sent; no receipt is issued");
  if (sent !== expected)
    throw new Error(
      `browser capture sent User-Agent ${JSON.stringify(sent.slice(0, 300))}, not the composed ${JSON.stringify(expected)} (Chromium's own plus workflow.fetch.userAgent); no receipt is issued`,
    );
}
export function normalizeCapturedDomText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
// The capture's bounds: the delivered browser.capture.* registry keys (container config), never literals. main() fills them from
// readContainerConfig, which fails closed; the host verifier compares the navigation log's limits with its own resolved values.
export interface CaptureLimits {
  // The largest maxBytes a caller may request (raw body and DOM clip).
  maxBytesCeiling: number;
  // A declared main response above this is not read at all (Playwright buffers the whole entity).
  rawAllocationMaxBytes: number;
  // The DOM text clip: the whole text is stored as one report up to this bound (browser.capture.textMaxBytes), and the digest analyst reads it in pages.
  textMaxBytes: number;
  // A screenshot PNG above this is retaken smaller (see the fallback heights), never truncated.
  screenshotMaxBytes: number;
  deadlineMinMs: number;
  deadlineMaxMs: number;
}
export function captureLimits(cfg: ContainerConfig): CaptureLimits {
  return {
    maxBytesCeiling: cfg["browser.capture.maxBytesCeiling"],
    rawAllocationMaxBytes: cfg["browser.capture.rawAllocationMaxBytes"],
    textMaxBytes: cfg["browser.capture.textMaxBytes"],
    screenshotMaxBytes: cfg["browser.capture.screenshotMaxBytes"],
    deadlineMinMs: cfg["browser.capture.deadlineMinMs"],
    deadlineMaxMs: cfg["browser.capture.deadlineMaxMs"],
  };
}
// The capture context's viewport: Playwright's default, made explicit in main() so the oversize fallback below knows its geometry.
export const BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;
// A PNG is never truncated, and the host verifier requires a screenshot report labeled image/png. So a viewport PNG over the byte bound
// (a photo-heavy page) is retaken as the top half, then the top quarter, of the viewport, and the reduction is recorded as a limitation.
// Only when the smallest region still exceeds the bound does the capture fail (cause=bound).
export const BROWSER_SCREENSHOT_FALLBACK_HEIGHTS = [BROWSER_VIEWPORT.height / 2, BROWSER_VIEWPORT.height / 4] as const;
// Raw main-response bytes are not necessarily UTF-8 (a windows-1252 page has 0x80-0xBF bytes that are not continuations), so the
// clip is exact: the retained bytes are the first `max`, and the host verifier accepts exactly `max` (slack 0) for a truncated raw body.
export function clipRawBytes(bytes: Uint8Array, max: number): { data: Uint8Array; truncated: boolean } {
  if (bytes.byteLength <= max) return { data: bytes, truncated: false };
  return { data: bytes.subarray(0, max), truncated: true };
}
// Longest a UTF-8 clip can fall short of `max`: a sequence is at most 4 bytes, so at most 3 are dropped. The host verifier accepts this slack for the DOM.
export const CLIP_UTF8_MAX_BACKOFF = 3;
// Cuts at most `max` bytes of UTF-8 text without splitting a sequence, backing up at most CLIP_UTF8_MAX_BACKOFF bytes (mirrors
// trimIncompleteUtf8 in examples/hn-digest/article-worker.mts). The retained bytes are what get hashed and published.
export function clipBytes(bytes: Uint8Array, max: number): { data: Uint8Array; truncated: boolean } {
  if (bytes.byteLength <= max) return { data: bytes, truncated: false };
  for (let i = max - 1; i >= Math.max(0, max - CLIP_UTF8_MAX_BACKOFF - 1); i--) {
    const b = bytes[i]!;
    if ((b & 0xc0) === 0x80) continue; // continuation: the sequence began earlier
    const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return { data: bytes.subarray(0, length > max - i ? i : max), truncated: true };
  }
  return { data: bytes.subarray(0, max), truncated: true };
}
export function clipCapturedDomText(raw: string, max: number): { text: string; truncated: boolean } {
  const text = normalizeCapturedDomText(raw);
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return { text, truncated: false };
  // Streaming decode retains an incomplete final code point instead of replacing/splitting it.
  return { text: new TextDecoder().decode(bytes.subarray(0, max), { stream: true }).trimEnd(), truncated: true };
}
// Deterministic, bounded settle wait for JS-rendered pages: domcontentloaded can fire before a client-side app has drawn any text,
// and the model does not scroll or retry. Samples the page every `pollMs`; the page is settled once the text length is non-zero and
// unchanged for `stablePolls` consecutive samples. A page that never settles (or stays empty) is sampled until `maxMs` and the last
// sample is used, with settled=false recorded. No model involvement; `sleep` is injected so the logic is unit-testable.
export interface SettleOptions {
  pollMs: number;
  stablePolls: number;
  maxMs: number;
}
export const DEFAULT_SETTLE: SettleOptions = { pollMs: 250, stablePolls: 2, maxMs: 5000 };
// The most the capture can record: the host verifier imports these instead of keeping looser guesses. captureBrowser only ever lowers maxMs.
export const BROWSER_SETTLE_WAIT_MAX_MS = DEFAULT_SETTLE.maxMs;
export const BROWSER_SETTLE_POLLS_MAX = 1 + Math.floor(DEFAULT_SETTLE.maxMs / DEFAULT_SETTLE.pollMs);
export interface SettleResult<T> {
  sample: T;
  settled: boolean;
  polls: number;
  waitedMs: number;
}
export async function settleSample<T>(
  take: () => Promise<T>,
  size: (sample: T) => number,
  opts: SettleOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SettleResult<T>> {
  let sample = await take();
  let polls = 1;
  let waitedMs = 0;
  let stable = 0;
  let last = size(sample);
  while (!(stable >= opts.stablePolls && last > 0) && waitedMs + opts.pollMs <= opts.maxMs) {
    await sleep(opts.pollMs);
    waitedMs += opts.pollMs;
    sample = await take();
    polls++;
    const now = size(sample);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  return { sample, settled: stable >= opts.stablePolls && last > 0, polls, waitedMs };
}
// Bot-challenge interstitials the capture recognizes and stops at; it never solves or bypasses one. `strong` markers belong only to a
// challenge page. A page that merely loads AWS WAF's token script (`*.token.awswaf.com`, also used by sites that integrate the WAF SDK
// on an ordinary page) counts as a challenge only when the page then navigates (the interstitial reloads once solved) or renders no
// text. The marker shapes are [knowledge-only] from the vendors' public interstitials, plus the 2026-10-23 StartEngine run
// (a domain example's live report).
export interface BotChallengeMarker {
  marker: string;
  strong: boolean;
}
const STRONG_BODY_MARKERS: [RegExp, string][] = [
  [/window\.gokuProps|id=["']challenge-container["']|captcha\.awswaf\.com/i, "aws-waf-interstitial"],
  [/\/cdn-cgi\/challenge-platform\//i, "cloudflare-challenge"],
  [/<title>\s*(?:Just a moment\.\.\.|Attention Required!|Human Verification)\s*<\/title>/i, "challenge-title"],
];
export function botChallengeMarker(html: string, headers: { wafAction: string | null; cfMitigated: string | null }): BotChallengeMarker | null {
  // AWS WAF names the action it took (`challenge` or `captcha`) in x-amzn-waf-action; any other value is not a challenge.
  if (/^(?:challenge|captcha)$/i.test(headers.wafAction?.trim() ?? "")) return { marker: "aws-waf-action-header", strong: true };
  if (headers.cfMitigated?.trim().toLowerCase() === "challenge") return { marker: "cloudflare-mitigated-header", strong: true };
  for (const [re, marker] of STRONG_BODY_MARKERS) if (re.test(html)) return { marker, strong: true };
  if (/\.token\.awswaf\.com\b/i.test(html)) return { marker: "aws-waf-token-script", strong: false };
  return null;
}
// The fixed message capture-diagnostic.ts classifies as bot_challenge. The marker is a fixed name, never page text.
export const botChallengeError = (m: BotChallengeMarker): Error =>
  new Error(`browser capture stopped: the site served a bot challenge (marker=${m.marker}); it is not solved or bypassed`);
// Time the capture process may spend after its deadline closing the browser context and exiting (runCaptureProcess). The process
// therefore ends at most deadlineMs + CAPTURE_TEARDOWN_MS after main() starts; only Node's own startup comes before that.
export const CAPTURE_TEARDOWN_MS = 2000;
// The options of one capture, shared by the Pi tool path (captureBrowser) and the model-free worker (capture-worker.ts).
export interface CaptureCoreOptions {
  url: string;
  maxBytes: number;
  deadlineMs: number;
  // When the deadline ends (Date.now() epoch ms): runCaptureProcess starts it before Chromium is attached. Defaults to now + deadlineMs.
  deadlineAt?: number;
  limits: CaptureLimits;
  settle?: SettleOptions;
  worker: string;
  generation: number;
}
// Refuses unbounded or anonymous options before the page is touched; returns the normalized original URL.
export function checkCaptureOptions(opts: CaptureCoreOptions): string {
  const limits = opts.limits;
  // A non-integer limit would make a comparison below vacuous (x > NaN is false), so it is refused, never read as unbounded.
  if (!Object.values(limits).every((v) => Number.isSafeInteger(v) && v >= 1)) throw new Error("capture limits must be positive integers");
  if (
    !Number.isInteger(opts.maxBytes) ||
    opts.maxBytes < 1 ||
    opts.maxBytes > limits.maxBytesCeiling ||
    !Number.isInteger(opts.deadlineMs) ||
    opts.deadlineMs < limits.deadlineMinMs ||
    opts.deadlineMs > limits.deadlineMaxMs ||
    !opts.worker ||
    !Number.isSafeInteger(opts.generation) ||
    opts.generation < 0
  )
    throw new Error("explicit capture byte/deadline/identity bounds required");
  return captureUrl(opts.url);
}
// What one capture observed, before anything is published: the one place the capture's policy runs (limits, challenge detection,
// settle, clipping, screenshot fallback). Both entry points publish from it.
export interface CaptureObservation {
  originalUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  fullRawBytes: number;
  raw: Uint8Array;
  rawTruncated: boolean;
  fullDomBytes: number;
  dom: Uint8Array;
  domTruncated: boolean;
  text: Uint8Array;
  textTruncated: boolean;
  region: ExtractionRegion | string;
  rejected?: string;
  settle: { settled: boolean; polls: number; waitedMs: number };
  screenshot: Uint8Array;
  screenshotClip?: ScreenshotClip;
  viewportScreenshotBytes: number;
  // The User-Agent header the main request carried, when the response exposes its request (absent otherwise).
  sentUserAgent?: string;
}
export async function observeCapture(page: CapturePage, opts: CaptureCoreOptions, originalUrl: string, remaining: () => number): Promise<CaptureObservation> {
  const limits = opts.limits;
  const response = await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
  if (!response) throw new Error("browser capture missing main response; no raw body receipt can be issued");
  const finalUrl = captureUrl(page.url());
  const contentType = await response.headerValue("content-type");
  // A response without a content type (for example an empty non-2xx reply) is not evidence of a non-HTML page: it classifies as `no_response`
  // (the fixed phrase below), keeping `non_html` for a response that declared a type that is not HTML.
  if (!contentType) throw new Error(`browser capture missing main response content type (status ${response.status()}); no raw body receipt can be issued`);
  if (contentType.length > 200 || !["text/html", "application/xhtml+xml"].includes((contentType.split(";")[0] ?? "").trim().toLowerCase()))
    throw new Error("browser article capture requires an HTML main response");
  const length = Number(await response.headerValue("content-length"));
  if (Number.isFinite(length) && length > limits.rawAllocationMaxBytes) throw new Error("main response exceeds capture bound");
  const sentUserAgent = (await response.request?.().headerValue("user-agent")) ?? undefined;
  const fullRaw = await response.body(); // Playwright content-decoded entity bytes, NOT wire packets.
  const challenge = botChallengeMarker(Buffer.from(fullRaw).toString("latin1"), {
    wafAction: await response.headerValue("x-amzn-waf-action"),
    cfMitigated: await response.headerValue("cf-mitigated"),
  });
  if (challenge?.strong) throw botChallengeError(challenge);
  // A reload or navigation after domcontentloaded (a challenge solved in place, a client redirect) leaves no stable document of finalUrl.
  const navigated = (detail: string): Error => (challenge ? botChallengeError(challenge) : new Error(`capture page navigated after load (${detail})`));
  // Ordinary pages (a GitHub repo page, a Next.js news page) exceed the maxBytes the caller passes (the digest's ext.hnDigest.articleCaptureBytes default is 262144; the extension's schema ceiling is
  // browser.capture.maxBytesCeiling, 1 MiB by default), so the raw body and DOM are clipped to it, as the static reader does, and the clip is recorded; the published hashes cover exactly the retained bytes.
  const clippedRaw = clipRawBytes(fullRaw, opts.maxBytes);
  // One synchronous browser evaluation observes DOM serialization and live-region innerText; it is repeated until the text settles
  // (bounded, see settleSample) and the final sample is the snapshot. The screenshot is a separate observation, never an atomic
  // screenshot/DOM claim. The settle bound is a quarter of the deadline at most, so the screenshot and publishes keep their time.
  const settle = await settleSample(
    () =>
      page.evaluate(snapshotInPage, MAIN_CONTENT_TUNING).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw /Execution context was destroyed|navigat/i.test(message) ? navigated(message) : err;
      }),
    (snap) => normalizeCapturedDomText(snap.text).length, // whitespace-only text is not settled content
    { ...(opts.settle ?? DEFAULT_SETTLE), maxMs: Math.min((opts.settle ?? DEFAULT_SETTLE).maxMs, Math.floor(opts.deadlineMs / 4)) },
  );
  const snapshot = settle.sample;
  // An SPA replaceState or consent redirect during settle leaves DOM/text that are not of the recorded finalUrl: fail rather than mislabel.
  const settledUrl = new URL(captureUrl(page.url()));
  const recorded = new URL(finalUrl);
  if (settledUrl.origin !== recorded.origin || settledUrl.pathname !== recorded.pathname) {
    if (challenge) throw botChallengeError(challenge);
    throw new Error("capture final URL changed during settle");
  }
  // The token script on a page that rendered no text is the interstitial still waiting to be solved, not content.
  if (challenge && !settle.settled && normalizeCapturedDomText(snapshot.text) === "") throw botChallengeError(challenge);
  const fullDom = Buffer.from(snapshot.dom);
  const clippedDom = clipBytes(fullDom, opts.maxBytes);
  const clipped = clipCapturedDomText(snapshot.text, limits.textMaxBytes);
  let screenshot = await page.screenshot({ type: "png", timeout: remaining() });
  const viewportScreenshotBytes = screenshot.byteLength;
  let screenshotClip: ScreenshotClip | undefined;
  for (const height of BROWSER_SCREENSHOT_FALLBACK_HEIGHTS) {
    if (screenshot.byteLength <= limits.screenshotMaxBytes) break;
    screenshotClip = { x: 0, y: 0, width: BROWSER_VIEWPORT.width, height };
    screenshot = await page.screenshot({ type: "png", timeout: remaining(), clip: screenshotClip });
  }
  if (screenshot.byteLength > limits.screenshotMaxBytes)
    throw new Error(`capture screenshot exceeds byte bound (${screenshot.byteLength} > ${limits.screenshotMaxBytes}; a PNG is not truncated)`);
  return {
    originalUrl,
    finalUrl,
    status: response.status(),
    contentType,
    fullRawBytes: fullRaw.byteLength,
    raw: clippedRaw.data,
    rawTruncated: clippedRaw.truncated,
    fullDomBytes: fullDom.byteLength,
    dom: clippedDom.data,
    domTruncated: clippedDom.truncated,
    text: Buffer.from(clipped.text),
    textTruncated: clipped.truncated,
    region: snapshot.region ?? EXTRACTION_REGION_FALLBACK,
    ...(snapshot.rejected !== undefined && { rejected: snapshot.rejected }),
    settle: { settled: settle.settled, polls: settle.polls, waitedMs: settle.waitedMs },
    screenshot,
    ...(screenshotClip && { screenshotClip }),
    viewportScreenshotBytes,
    ...(sentUserAgent !== undefined && { sentUserAgent }),
  };
}
// The navigation log of an observation, without report references: the Pi path appends its five report refs, the worker records it
// in the WARC metadata record and in its own navigation artifact.
export function navigationSummary(obs: CaptureObservation, opts: CaptureCoreOptions) {
  const limits = opts.limits;
  return {
    kind: "browser-navigation",
    worker: opts.worker,
    generation: opts.generation,
    originalUrl: obs.originalUrl,
    finalUrl: obs.finalUrl,
    method: "browser",
    action: "page.goto",
    waitUntil: "domcontentloaded",
    status: obs.status,
    contentType: obs.contentType,
    sourceKind: "playwright-cdp-tool-capture",
    rawBodySource: "main-response-content-decoded-entity-not-wire",
    actions: [
      { kind: "navigate", url: obs.originalUrl },
      { kind: "navigation", url: obs.finalUrl },
    ],
    extraction: {
      source: "rendered-dom-innerText",
      region: obs.region,
      normalization: "collapse-whitespace-trim",
      maxBytes: limits.textMaxBytes,
      truncated: obs.textTruncated,
      domSource: "document.documentElement.outerHTML",
      observation: "DOM and innerText in one synchronous evaluation; screenshot separate",
      settle: obs.settle,
    },
    limitations: [
      // The fallback replaces the generic line (not adds one): the navigation log's limitation count is already at its cap in the worst case.
      obs.rejected
        ? `Unrefined region read; ${obs.rejected}`
        : "Mechanical live DOM innerText of the chosen region, page chrome (nav, aside, header, footer, dialogs) stripped when a main-content root qualified (extraction.region); not a complete-article claim",
      ...(obs.textTruncated
        ? [
            `DOM text clipped at a complete UTF-8 code point to at most ${limits.textMaxBytes} bytes (browser.capture.textMaxBytes); retained text report contains exactly the clipped bytes`,
          ]
        : []),
      ...(obs.rawTruncated
        ? [
            `raw body clipped to ${obs.raw.byteLength} of ${obs.fullRawBytes} bytes (maxBytes ${opts.maxBytes}); the raw body report hash covers the retained bytes only`,
          ]
        : []),
      ...(obs.domTruncated
        ? [`DOM clipped to ${obs.dom.byteLength} of ${obs.fullDomBytes} bytes (maxBytes ${opts.maxBytes}); the DOM report hash covers the retained bytes only`]
        : []),
      "DOM snapshot can differ from main HTTP response",
      ...(obs.screenshotClip
        ? [
            `screenshot reduced to the top ${obs.screenshotClip.width}x${obs.screenshotClip.height} px of the ${BROWSER_VIEWPORT.width}x${BROWSER_VIEWPORT.height} viewport: the viewport PNG was ${obs.viewportScreenshotBytes} bytes, over the ${limits.screenshotMaxBytes}-byte bound`,
          ]
        : []),
      ...(obs.settle.settled ? [] : ["DOM text had not stabilized (or was empty) when the bounded settle wait ended; the last sample is retained"]),
      "Response entity and DOM are buffered before artifact byte checks, not streamed/download/allocation quotas; container hard memory limit is the final allocation bound",
      "tool provenance is not cryptographic or packet attestation",
    ],
    limits: {
      maxBytes: opts.maxBytes,
      deadlineMs: opts.deadlineMs,
      textBytes: limits.textMaxBytes,
      screenshotBytes: limits.screenshotMaxBytes,
      truncated: obs.textTruncated,
      rawBodyBytes: obs.fullRawBytes,
      rawBodyTruncated: obs.rawTruncated,
      domBytes: obs.fullDomBytes,
      domTruncated: obs.domTruncated,
      ...(obs.screenshotClip && { screenshotClip: obs.screenshotClip, viewportScreenshotBytes: obs.viewportScreenshotBytes }),
    },
  };
}
// What a capture body gets from withCaptureDeadline: the time left for a step, and a publish that refuses after the deadline and checks
// every returned sha256 against the bytes.
export interface CaptureDeadlineContext {
  remaining(): number;
  checked(
    publish: (data: Uint8Array, name: string, mediaType: string) => Promise<CaptureReport>,
  ): (data: Uint8Array, name: string, mediaType: string) => Promise<CaptureReport>;
}
// Runs `run` against the capture deadline: on expiry the page is closed unawaited and the capture rejects with the fixed deadline phrase.
export async function withCaptureDeadline<T>(page: CapturePage, deadlineAt: number, run: (ctx: CaptureDeadlineContext) => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  const ctx: CaptureDeadlineContext = {
    // Each Playwright step's own timeout is the time left, never a fresh full deadline.
    remaining: () => Math.max(1, deadlineAt - Date.now()),
    checked: (publish) => async (data, name, type) => {
      if (expired) throw new Error("capture deadline");
      const r = await publish(data, name, type);
      if (r.sha256 !== createHash("sha256").update(data).digest("hex") || !r.id) throw new Error("capture report hash mismatch");
      return r;
    },
  };
  try {
    return await Promise.race([
      run(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          void page.close().catch(() => {});
          reject(new Error("browser capture deadline"));
        }, deadlineAt - Date.now());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function captureBrowser(
  page: CapturePage,
  opts: CaptureCoreOptions & {
    publish(data: Uint8Array, name: string, mediaType: string): Promise<CaptureReport>;
    // The User-Agent the context was given (composeUserAgent). When set, the main request must have sent exactly it, and the
    // navigation log records the header sent (`userAgent`). The image's main() always sets it; absent (host-side harnesses) = no check.
    userAgent?: string;
  },
): Promise<CaptureReceipt> {
  const originalUrl = checkCaptureOptions(opts);
  const deadlineAt = opts.deadlineAt ?? Date.now() + opts.deadlineMs;
  return withCaptureDeadline(page, deadlineAt, async (ctx) => {
    const obs = await observeCapture(page, opts, originalUrl, ctx.remaining);
    if (opts.userAgent !== undefined) checkSentUserAgent(obs.sentUserAgent, opts.userAgent);
    const publish = ctx.checked(opts.publish);
    const rawBodyReport = await publish(obs.raw, CAPTURE_REPORT_NAMES.rawBody, "text/html");
    const domReport = await publish(obs.dom, CAPTURE_REPORT_NAMES.dom, "text/html");
    const textReport = await publish(obs.text, CAPTURE_REPORT_NAMES.text, "text/plain");
    const screenshotReport = await publish(obs.screenshot, CAPTURE_REPORT_NAMES.screenshot, "image/png");
    const binding = {
      ...navigationSummary(obs, opts),
      ...(opts.userAgent !== undefined && { userAgent: obs.sentUserAgent }),
      rawBodyReport,
      domReport,
      textReport,
      screenshotReport,
    };
    const navigationReport = await publish(Buffer.from(JSON.stringify(binding)), CAPTURE_REPORT_NAMES.navigation, "application/json");
    return {
      worker: opts.worker,
      generation: opts.generation,
      originalUrl,
      finalUrl: obs.finalUrl,
      method: "browser" as const,
      status: obs.status,
      contentType: obs.contentType,
      screenshotReport,
      rawBodyReport,
      domReport,
      textReport,
      navigationReport,
    };
  });
}
// The capture's browser side: a page in a fresh context, and that context's close.
export interface CaptureSession {
  page: CapturePage;
  close(): Promise<void>;
}
// The capture process's body: the deadline starts here, before Chromium is attached (`open` imports Playwright, attaches over CDP and opens
// the context), so attach time counts against it; and teardown is bounded by `teardownMs`, so a context close that hangs on a page that
// is mid-navigation cannot hold the process past deadlineMs + teardownMs. A session that opens only after the deadline is closed unawaited.
// A session that carries `userAgent` (openCaptureContext) makes the capture check and record the header sent (captureBrowser).
export async function runCaptureProcess(
  open: () => Promise<CaptureSession & { userAgent?: string }>,
  opts: Omit<Parameters<typeof captureBrowser>[1], "deadlineAt" | "userAgent">,
  teardownMs: number = CAPTURE_TEARDOWN_MS,
): Promise<CaptureReceipt> {
  return runCaptureSession(
    open,
    opts.deadlineMs,
    (session, deadlineAt) => captureBrowser(session.page, { ...opts, deadlineAt, ...(session.userAgent !== undefined && { userAgent: session.userAgent }) }),
    teardownMs,
  );
}
// The slice of a Playwright Browser (attached over CDP) a capture opens its context on.
export interface CaptureBrowserLike extends ChromiumVersionSource {
  newContext(opts: {
    acceptDownloads: false;
    serviceWorkers: "block";
    viewport: typeof BROWSER_VIEWPORT;
    userAgent: string;
  }): Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }>;
}
// The Pi worker's Chromium already runs with `--user-agent=<composeUserAgent(own, operator)>` (browser-run.ts launchIdentifiedChromium),
// so Browser.getVersion may report the composed string rather than Chromium's own [knowledge-only: a live run shows which]. A reported
// string that already ends with " <operator>" is that composition and is used as is, never appended twice; any other is composed.
export function composeUserAgentOnce(reported: string, operator: string): string {
  return reported.endsWith(` ${operator}`) && operatorUserAgentProblem(operator) === null ? reported : composeUserAgent(reported, operator);
}
// The Pi tool capture's context: Chromium's own User-Agent with the operator's appended (composeUserAgentOnce), set at context creation.
export async function openCaptureContext(browser: CaptureBrowserLike, operator: string): Promise<CaptureSession & { userAgent: string }> {
  const userAgent = composeUserAgentOnce(await reportedUserAgent(browser), operator);
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: BROWSER_VIEWPORT, userAgent });
  // connectOverCDP attaches to the shared Chromium: close only our context, never browser.close().
  return { page: (await context.newPage()) as CapturePage, close: () => context.close(), userAgent };
}
// runCaptureProcess's deadline and teardown for any capture body over any session shape (the worker's session also holds its recorder).
export async function runCaptureSession<S extends CaptureSession, R>(
  open: () => Promise<S>,
  deadlineMs: number,
  body: (session: S, deadlineAt: number) => Promise<R>,
  teardownMs: number = CAPTURE_TEARDOWN_MS,
  deadlineAt: number = Date.now() + deadlineMs,
): Promise<R> {
  const within = <T>(work: Promise<T>, ms: number, onLate: () => T | Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([work, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(onLate()), Math.max(0, ms))))]).finally(() => clearTimeout(timer));
  };
  const opening = open();
  const session = await within<S | undefined>(opening, deadlineAt - Date.now(), () => undefined);
  if (!session) {
    void opening.then((late) => late.close()).catch(() => {});
    throw new Error("browser capture deadline");
  }
  try {
    return await body(session, deadlineAt);
  } finally {
    await within(
      session.close().catch(() => {}),
      teardownMs,
      () => {},
    );
  }
}
// The image's pinned Playwright (the reviewed pi-browser checkout's lockfile pins it; see the Dockerfile).
export const PLAYWRIGHT_MODULE = "/opt/pomtree/pi-browser/node_modules/playwright/index.mjs";
// The `pomtree report publish --json` stdout is the daemon's full Report; the receipt ref keeps only id and sha256.
export function parseReportPublishJson(stdout: string, sha256: string): CaptureReport {
  const report = JSON.parse(stdout) as Partial<CaptureReport>;
  if (typeof report.id !== "string" || report.id === "" || report.sha256 !== sha256) throw new Error("capture report receipt mismatch");
  return { id: report.id, sha256 };
}
// `pomtree` is run as Node on its main.ts by absolute path with a fixed env (PATH has agent-writable dirs first); `cmd` is injectable for tests only.
// The env keeps POMTREE_*, HOME, TMPDIR and the egress proxy selectors (PROXY_ENV_NAMES): without them `pomtree` cannot reach the daemon.
// It also keeps the container config document (CONTAINER_CONFIG_ENV), so `pomtree` reads the operator's values, not image defaults.
export function pomtreeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { PATH: FIXED_PATH };
  const keep = (k: string) =>
    k.startsWith("POMTREE_") || k === "HOME" || k === "TMPDIR" || k === CONTAINER_CONFIG_ENV || (PROXY_ENV_NAMES as readonly string[]).includes(k);
  for (const [k, v] of Object.entries(env)) if (keep(k) && v !== undefined) out[k] = v;
  return out;
}
// The `pomtree` argv that publishes one capture report as JSON; main() and the Docker-gated e2e proxy-path probe both build it here.
export function publishArgv(file: string, name: string, mediaType: string, key: string): string[] {
  return ["report", "publish", file, "--name", name, "--media-type", mediaType, "--key", key, "--json"];
}
// The publish failure as one line: the fixed phrase (classifyCaptureFailure keys on it), then exit code, signal, timeout flag and the
// child's whitespace-collapsed stderr. It reaches only this process's stderr, which the extension redacts and bounds (pomtreeFailureDetail
// in capture-diagnostic.ts) into the operator-only browser-capture-failure entry; the model-visible tool error never carries stderr.
export function pomtreeFailureMessage(err: { code?: unknown; signal?: unknown; killed?: unknown }, stderr: string | Buffer | undefined): string {
  const code = typeof err.code === "number" || typeof err.code === "string" ? String(err.code) : "null";
  const signal = typeof err.signal === "string" ? err.signal : "null";
  const line = String(stderr ?? "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  // execFile also kills the child on a stdout overflow, but then reports a string code (ERR_CHILD_PROCESS_STDIO_MAXBUFFER), not a timeout.
  const timedOut = err.killed === true && typeof err.code !== "string";
  return `scoped report publication failed (pomtree code=${code} signal=${signal} timedOut=${timedOut})${line ? ` stderr: ${line}` : ""}`;
}
export function pomtree(
  args: string[],
  cmd: { file: string; argv: string[] } = { file: process.execPath, argv: [CLI_POMTREE_MAIN] },
  env = process.env,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd.file, [...cmd.argv, ...args], { timeout: CLI_POMTREE_TIMEOUT_MS, maxBuffer: 64 * 1024, env: pomtreeEnv(env) }, (err, stdout, stderr) =>
      err ? reject(new Error(pomtreeFailureMessage(err, stderr))) : resolve(stdout),
    ),
  );
}
async function main(): Promise<void> {
  const [url, maxBytes, deadlineMs] = process.argv.slice(2);
  if (!url || !maxBytes || !deadlineMs) throw new Error("usage: node /opt/pomtree/browser-capture.ts URL MAX_BYTES DEADLINE_MS");
  // Before Chromium is touched: a missing, invalid or mismatched document exits 1 with no receipt (fails closed, never image defaults).
  const limits = captureLimits(readContainerConfig(process.env, { required: true }));
  const operatorUserAgent = browserOperatorUserAgent(process.env);
  const open = async (): Promise<CaptureSession & { userAgent: string }> => {
    const { chromium } = await import(PLAYWRIGHT_MODULE);
    return openCaptureContext(await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 5000 }), operatorUserAgent);
  };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-capture-")));
  try {
    const receipt = await runCaptureProcess(open, {
      url,
      maxBytes: Number(maxBytes),
      deadlineMs: Number(deadlineMs),
      limits,
      worker: process.env.POMTREE_AGENT_ID ?? "",
      generation: Number(process.env.POMTREE_AGENT_GENERATION),
      publish: async (data, name, mediaType) => {
        const file = join(dir, name);
        const sha256 = createHash("sha256").update(data).digest("hex");
        writeFileSync(file, data, { mode: 0o600 });
        return parseReportPublishJson(
          await pomtree(
            publishArgv(file, name, mediaType, `browser-capture:${process.env.POMTREE_AGENT_ID}:${process.env.POMTREE_AGENT_GENERATION}:${name}:${sha256}`),
          ),
          sha256,
        );
      },
    });
    await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(receipt)}\n`, (error) => (error ? reject(error) : resolve())));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  // This short-lived capture process owns its CDP connection, not the shared browser. Exiting
  // after context cleanup drops that connection without issuing Browser.close to Chromium.
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "browser capture failed");
    process.exit(1);
  }
}
