import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRecord } from "../../packages/core/src/index.ts";
import { DirReportStore } from "../../packages/report-dir/src/index.ts";
import { openStore } from "../../packages/store-sqlite/src/index.ts";
import { CAPTURE_CAUSES, CAPTURE_REASONS, type CaptureSummary, captureStaticArticleDetailed, validateCaptureSummary } from "./article.mts";
import { CONTENT_CONFIG_DEFAULTS, type ContentBounds, DEFAULT_CONTENT_BOUNDS as BOUNDS, captureLimitsOption, contentBounds } from "./content-bounds.mts";
import {
  BROWSER_SCREENSHOT_FALLBACK_HEIGHTS,
  BROWSER_SETTLE_POLLS_MAX,
  BROWSER_SETTLE_WAIT_MAX_MS,
  BROWSER_VIEWPORT,
  CLIP_UTF8_MAX_BACKOFF,
  captureBrowser,
} from "../../packages/agent-image/src/browser-capture.ts";
import { EXTRACTION_REGIONS, type ExtractionRegion } from "../../packages/agent-image/src/main-content.ts";
import { planPages } from "./article-pages.mts";
import { nativeCaptureArgs } from "./browser-contract.mts";
import { createJournalCaptureAuthority } from "./content-authority.mts";
import { runStaticWorker } from "./article-worker.mts";
import { hash } from "./content-contract.mts";
import { ARTICLE_LIMITATIONS_MAX, BROWSER_HOST_LIMITATIONS, STORY_LIMITATION_MAX } from "./limitation-bounds.mts";
import { type Artifact, type CaptureReceipt, browserFailureReason, browserLimits, captureCauseOf, createArticleVerifier } from "./content-evidence.mts";
import { CAPTURE_FAILURE_CAUSES, captureFailureSuffix } from "../../packages/agent-image/ext/pomtree-browser/capture-diagnostic.ts";
import { toolFailureCauseOf } from "../../packages/pomtreed/src/daemon-util.ts";
import { articleOutcome, urlExtensionOutcome } from "./content-workflow.mts";

const HTML = readFileSync(new URL("./content-fixtures/article-positive.html", import.meta.url), "utf8");
const staticText = (b: ContentBounds = BOUNDS): string =>
  captureStaticArticleDetailed(input, { status: 200, body: HTML, sha256: hash(HTML), contentType: "text/html" }, b).text;
const input = { storyId: 101, url: "https://example.com/article", itemHash: "a".repeat(64), maxBytes: 32768 };

// Visible text of an injected browser page: long enough to pass the thin-text rule (ARTICLE_THIN_TEXT = 400 characters).
const LONG_TEXT = "Rendered article sentence that the injected page presents as visible text. ".repeat(8);

const DEFAULT_DOM = "<html><main>Rendered content differs from HTTP entity</main></html>";
// `browserBody` overrides the served main response body and `browserDom` the live DOM (both larger than the input's maxBytes exercise the
// capture clip).
// `screenshotSteps` makes the viewport PNG exceed the screenshot bound so the worker's reduction runs: 1 fits at the first fallback
// height, 2 only at the second. `unsettled` grows the visible text by one character per sample, so the settle wait never settles.
async function fixture(
  options: {
    browserText?: string;
    browserStatus?: number;
    browserBody?: string;
    browserDom?: string;
    browserRegion?: ExtractionRegion;
    screenshotSteps?: 1 | 2;
    unsettled?: boolean;
    bounds?: ContentBounds; // the bounds the worker and the verifier share (default: the registry defaults)
  } = {},
) {
  const B = options.bounds ?? BOUNDS;
  let samples = 0;
  const dir = mkdtempSync(join(tmpdir(), "hn-capture-verify-"));
  const db = join(dir, "pomtreed.sqlite");
  let store = openStore(db);
  let reports = new DirReportStore({ root: join(dir, "reports"), registry: store.registry });
  const make = async (id: string, parent: string | null, container: boolean) => {
    const base = { id, parent, name: id, task: id, host: "h1", budgetMicros: 1000, idempotencyKey: id };
    const a = container
      ? await store.registry.create({
          ...base,
          executor: "container",
          spec: { image: "fixture@sha256:abc", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "audited-public" } },
        })
      : await store.registry.create({ ...base, executor: "deterministic", spec: { driver: "hn-content/story", input: {} } });
    return store.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${id}:start` });
  };
  const root = await make("root", null, false);
  const parent = await make("story", root.id, false);
  const child = await make("article", parent.id, true);
  const publish = async (name: string, bytes: Uint8Array, mediaType = "text/plain"): Promise<Artifact> => {
    const id = `${name.replace(/[^a-z0-9]/g, "-")}-${hash(bytes).slice(0, 16)}`;
    const report = await reports.write(
      {
        id,
        agent: child.id,
        generation: child.generation,
        host: child.host,
        name,
        mediaType,
        sizeBytes: bytes.byteLength,
        sha256: hash(bytes),
        content: bytes,
      },
      id,
    );
    return { id: report.id, sha256: report.sha256 };
  };
  let receipt: CaptureReceipt | null = null;
  if (options.browserText !== undefined)
    await store.journal.append({
      agent: child.id,
      host: child.host,
      generation: child.generation,
      payload: { kind: "tool_call", tool: "browser_capture", callId: "native-capture", input: nativeCaptureArgs(input, B) },
      idempotencyKey: "native-call",
    });
  const served = new TextEncoder().encode(options.browserBody ?? HTML);
  const out =
    options.browserText !== undefined
      ? {
          summary: "offline native capture contract fixture (not real browser execution)",
          capture: await captureBrowser(
            {
              goto: async () => ({
                body: async () => served,
                status: () => options.browserStatus ?? 200,
                headerValue: async (name) => (name === "content-type" ? "text/html" : String(served.byteLength)),
              }),
              url: () => "https://publisher.example/final",
              evaluate: async () => ({
                dom: options.browserDom ?? DEFAULT_DOM,
                ...(options.browserRegion ? { region: options.browserRegion } : {}),
                text: `${options.browserText ?? ""}${options.unsettled ? "z".repeat(++samples) : ""}`,
              }),
              screenshot: async (opts) => {
                const steps = options.screenshotSteps ?? 0;
                const over = opts.clip === undefined ? steps > 0 : steps === 2 && opts.clip.height === BROWSER_SCREENSHOT_FALLBACK_HEIGHTS[0];
                return over ? new Uint8Array(BOUNDS.capture.screenshotMaxBytes + 1) : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
              },
              close: async () => {},
            },
            {
              ...nativeCaptureArgs(input, B),
              ...captureLimitsOption(B),
              // Within the production bounds: an unsettled page records 1 + maxMs / pollMs = 21 polls, the verifier's maximum.
              settle: { pollMs: 2, stablePolls: 2, maxMs: 40 },
              worker: child.id,
              generation: child.generation,
              publish: (data, name, type) => publish(name, data, type),
            },
          ),
        }
      : await runStaticWorker(input, {
          worker: child.id,
          generation: child.generation,
          profile: "audited-public",
          bounds: B,
          signal: new AbortController().signal,
          transport: async () => ({
            status: 200,
            headers: new Headers({ "content-type": "text/html" }),
            body: (async function* () {
              yield new TextEncoder().encode(HTML);
            })(),
          }),
          publish,
          record: async (got) => {
            receipt = got;
          },
        });
  receipt = out.capture;
  if (options.browserText !== undefined)
    await store.journal.append({
      agent: child.id,
      host: child.host,
      generation: child.generation,
      payload: { kind: "tool_result", callId: "native-capture", ok: true, output: JSON.stringify(receipt) },
      idempotencyKey: "native-result",
    });
  const terminal = await store.registry.transition(child.id, child.generation, "exited", { exit: "succeeded", result: out, idempotencyKey: "article:exit" });
  const ctx = { agent: parent.id, generation: parent.generation, signal: new AbortController().signal, deadlineAt: null };
  const verifier = (native = false, bounds: ContentBounds = B) =>
    createArticleVerifier({
      registry: store.registry,
      reports,
      root: async () => root,
      bounds,
      authority: native
        ? createJournalCaptureAuthority({
            registry: store.registry,
            journal: store.journal,
            approvedWorker: (a) => a.executor === "container" && a.spec.image === "fixture@sha256:abc",
            bounds,
          })
        : { receipt: async () => receipt },
    });
  return {
    dir,
    root,
    parent,
    child,
    terminal,
    ctx,
    publish,
    verifier,
    get receipt() {
      return receipt;
    },
    set receipt(value) {
      receipt = value;
    },
    get reports() {
      return reports;
    },
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = openStore(db);
      reports = new DirReportStore({ root: join(dir, "reports"), registry: store.registry });
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("capture verifier: mechanically captured bytes/hash/extraction retained at root BEFORE reap, survive child GC and SQLite reopen", async () => {
  const f = await fixture();
  try {
    const evidence = await f.verifier().verify(f.ctx, f.terminal, input, "static-http");
    assert.ok(evidence?.bodyReport && evidence.textReport);
    assert.ok(!("text" in evidence), "the text is the retained report, not an evidence field");
    assert.equal(evidence.textBytes, Buffer.byteLength(staticText()));
    assert.equal(await f.verifier().articleText(evidence), staticText(), "resolved from the retained report, hash-checked");
    await f.store.registry.transition(f.child.id, f.child.generation, "reaped", { idempotencyKey: "reap-article" });
    for (const report of await f.reports.list(f.child.id)) await f.reports.remove(f.child.id, report.id);
    f.reopen();
    const raw = await f.reports.read(f.root.id, evidence.bodyReport.id);
    const text = await f.reports.read(f.root.id, evidence.textReport.id);
    assert.equal(Buffer.from(raw?.content ?? []).toString("utf8"), HTML);
    assert.equal(Buffer.from(text?.content ?? []).toString("utf8"), staticText());
    assert.equal(await f.verifier().articleText(evidence), staticText(), "still resolves after child GC and reopen");
  } finally {
    f.close();
  }
});

test("capture verifier summarize: states the verified capture, and refuses what verify refuses", async () => {
  const f = await fixture();
  try {
    const receipt = f.receipt;
    assert.ok(receipt);
    const outcome = await f.verifier().summarize(f.ctx, f.terminal, input, "static-http");
    assert.equal(outcome?.limitation, null);
    assert.deepEqual(outcome?.capture, {
      status: "usable",
      reason: null,
      textChars: Array.from(staticText()).length,
      bodyBytes: Buffer.byteLength(HTML),
      bodyBytesSeen: null,
      truncated: false,
      domBytesSeen: null,
      domTruncated: false,
      httpStatus: 200,
      cause: null,
      settle: null,
      screenshot: null,
      rawHash: receipt.rawBodyReport.sha256,
      textHash: hash(staticText()),
      finalOrigin: new URL(receipt.finalUrl).origin,
    });
    f.receipt = { ...receipt, status: 404 };
    const missing = await f.verifier().summarize(f.ctx, f.terminal, input, "static-http");
    assert.deepEqual([missing?.capture.status, missing?.capture.reason, missing?.limitation], ["unusable", "fetch_error", "Article not analysed: HTTP 404"]);
    f.receipt = { ...receipt, truncated: true, bytesRetained: Buffer.byteLength(HTML) + 1 };
    assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = { ...receipt, rawBodyReport: { ...receipt.rawBodyReport, sha256: "b".repeat(64) } };
    assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = null;
    assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = receipt;
    assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null);
  } finally {
    f.close();
  }
});

test("capture verifier: rejects model assertions without authoritative worker receipt, forged hashes, source binding and foreign custody", async () => {
  const f = await fixture();
  try {
    const receipt = f.receipt;
    assert.ok(receipt);
    f.receipt = null;
    assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = { ...receipt, rawBodyReport: { ...receipt.rawBodyReport, sha256: "b".repeat(64) } };
    assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = { ...receipt, finalUrl: "http://127.0.0.1/private" };
    assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = { ...receipt, originalUrl: "https://other.example/post" };
    assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = receipt;
    assert.equal(await f.verifier().verify({ ...f.ctx, agent: f.root.id }, f.terminal, input, "static-http"), null);
    assert.equal(await f.verifier().verify(f.ctx, { ...f.terminal, generation: 1 } as AgentRecord, input, "static-http"), null);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(f.verifier().verify({ ...f.ctx, signal: aborted.signal }, f.terminal, input, "static-http"), /stale\/cancelled/);
  } finally {
    f.close();
  }
});

test("capture verifier: actual native helper contract with injected page retains distinct bytes and safe MIME after child GC/reopen", async () => {
  const f = await fixture({ browserText: `  ${LONG_TEXT.replace(" ", "\n ")} ` });
  try {
    const old = f.receipt;
    assert.ok(old?.domReport && old.navigationReport && old.screenshotReport);
    const result = await f.verifier(true).verify(f.ctx, f.terminal, input, "browser");
    assert.ok(result?.browserEvidence && result.domReport && result.screenshotReport && result.bodyReport && result.textReport);
    assert.equal(result.rawHash, old.rawBodyReport.sha256);
    assert.equal(result.textHash, old.textReport.sha256);
    assert.notEqual(result.rawHash, old.domReport.sha256);
    assert.equal(await f.verifier(true).articleText(result), LONG_TEXT.trim());
    assert.equal(result.finalUrl, "https://publisher.example/final");
    assert.match(result.limitations.join(" "), /not.*cryptographic attestation/);
    await f.store.registry.transition(f.child.id, f.child.generation, "reaped", { idempotencyKey: "reap-browser" });
    for (const report of await f.reports.list(f.child.id)) await f.reports.remove(f.child.id, report.id);
    f.reopen();
    for (const [ref, type] of [
      [result.bodyReport, "text/plain"],
      [result.domReport, "text/plain"],
      [result.textReport, "text/plain"],
      [result.screenshotReport, "image/png"],
      [result.browserEvidence, "application/json"],
    ] as const) {
      const retained = await f.reports.read(f.root.id, ref.id);
      assert.ok(retained);
      assert.equal(retained.report.mediaType, type);
      assert.equal(hash(retained.content), ref.sha256);
    }
  } finally {
    f.close();
  }
});

test("capture verifier: native text clipping is explicit and exact bytes/hash are retained", async () => {
  const small = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "browser.capture.textMaxBytes": 8192, "ext.hnDigest.articleTextMaxBytes": 8192 });
  const f = await fixture({ browserText: "🧪".repeat(3000), bounds: small });
  try {
    const result = await f.verifier(true).verify(f.ctx, f.terminal, input, "browser");
    assert.ok(result?.textReport && result.browserEvidence);
    assert.equal(result.textBytes, 8192);
    assert.equal(result.textTruncated, true);
    const whole = await f.verifier(true).articleText(result);
    assert.equal(Buffer.byteLength(whole ?? ""), 8192);
    assert.equal(result.textHash, hash(whole ?? ""));
    assert.match(result.limitations.join(" "), /clipped.*browser\.capture\.textMaxBytes/);
    const text = await f.reports.read(f.root.id, result.textReport.id);
    assert.equal(Buffer.from(text?.content ?? []).toString("utf8"), whole);
    const nav = await f.reports.read(f.root.id, result.browserEvidence.id);
    const value = JSON.parse(Buffer.from(nav?.content ?? []).toString("utf8"));
    assert.equal(value.extraction.truncated, true);
    assert.equal(value.limits.truncated, true);
  } finally {
    f.close();
  }
});

test("capture verifier summarize (browser): a usable native capture is stated with counts, hashes and origin only", async () => {
  const f = await fixture({ browserText: LONG_TEXT });
  try {
    const old = f.receipt;
    assert.ok(old);
    const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
    assert.equal(outcome?.limitation, null);
    assert.deepEqual(outcome?.capture, {
      status: "usable",
      reason: null,
      textChars: Array.from(LONG_TEXT.trim()).length,
      bodyBytes: Buffer.byteLength(HTML),
      bodyBytesSeen: Buffer.byteLength(HTML),
      truncated: false,
      domBytesSeen: Buffer.byteLength(DEFAULT_DOM),
      domTruncated: false,
      httpStatus: 200,
      cause: null,
      settle: outcome?.capture.settle ?? null,
      screenshot: { bytes: 8, viewportBytes: null, clip: null },
      rawHash: old.rawBodyReport.sha256,
      textHash: old.textReport.sha256,
      finalOrigin: "https://publisher.example",
    });
  } finally {
    f.close();
  }
});

test("capture verifier (browser): a 403/503/429 with a challenge marker in the text is blocked; other non-2xx stay fetch_error", async () => {
  for (const [options, reason, httpStatus] of [
    [{ browserText: `Just a moment... ${LONG_TEXT}`, browserStatus: 403 }, "blocked", 403],
    [{ browserText: `${LONG_TEXT} Verify you are human`, browserStatus: 503 }, "blocked", 503],
    [{ browserText: `ATTENTION REQUIRED ${LONG_TEXT}`, browserStatus: 429 }, "blocked", 429],
    [{ browserText: LONG_TEXT, browserStatus: 403 }, "fetch_error", 403],
    [{ browserText: `Just a moment... ${LONG_TEXT}`, browserStatus: 404 }, "fetch_error", 404],
    [{ browserText: `Just a moment... ${LONG_TEXT}`, browserStatus: 500 }, "fetch_error", 500],
  ] as const) {
    const f = await fixture(options);
    try {
      const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
      assert.deepEqual(
        [outcome?.capture.status, outcome?.capture.reason, outcome?.capture.httpStatus],
        ["unusable", reason, httpStatus],
        JSON.stringify(options),
      );
      assert.equal(outcome ? validateCaptureSummary(outcome.capture, BOUNDS).ok : false, true);
      if (reason === "blocked") assert.match(outcome?.limitation ?? "", /^Article not analysed: HTTP \d+ challenge page \(".+"\)$/);
      else assert.equal(outcome?.limitation, `Article not analysed: HTTP ${httpStatus}`);
      assert.equal(await f.verifier(true).verify(f.ctx, f.terminal, input, "browser"), null);
    } finally {
      f.close();
    }
  }
});

test("capture verifier (browser): a 200 page that shows a challenge marker is not blocked", async () => {
  const f = await fixture({ browserText: `Just a moment... ${LONG_TEXT}` });
  try {
    const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
    assert.deepEqual([outcome?.capture.reason, outcome?.capture.httpStatus], [null, 200]);
  } finally {
    f.close();
  }
});

test("capture verifier (browser): a non-200 navigation and empty visible text are not analysed with their specific reason", async () => {
  for (const [options, status, reason, limitation, textChars] of [
    [{ browserText: LONG_TEXT, browserStatus: 404 }, "unusable", "fetch_error", "Article not analysed: HTTP 404", Array.from(LONG_TEXT.trim()).length],
    [{ browserText: "" }, "unsupported", "thin", `Article not analysed: too thin to ground: under 400 characters of readable text after extraction`, 0],
  ] as const) {
    const f = await fixture(options);
    try {
      const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
      assert.deepEqual(outcome?.capture, {
        status,
        reason,
        textChars,
        bodyBytes: Buffer.byteLength(HTML),
        bodyBytesSeen: Buffer.byteLength(HTML),
        truncated: false,
        domBytesSeen: Buffer.byteLength(DEFAULT_DOM),
        domTruncated: false,
        httpStatus: status === "unusable" ? 404 : 200,
        cause: null,
        settle: outcome?.capture.settle ?? null,
        screenshot: { bytes: 8, viewportBytes: null, clip: null },
        rawHash: f.receipt?.rawBodyReport.sha256 ?? null,
        textHash: f.receipt?.textReport.sha256 ?? null,
        finalOrigin: "https://publisher.example",
      });
      assert.equal(outcome?.limitation, limitation);
      assert.equal(await f.verifier(true).verify(f.ctx, f.terminal, input, "browser"), null);
    } finally {
      f.close();
    }
  }
});

test("articleOutcome: a summary that says usable while verify refused the article is downgraded to unusable/other (verification failed)", () => {
  const usable: CaptureSummary = {
    status: "usable",
    reason: null,
    textChars: 700,
    bodyBytes: 1000,
    bodyBytesSeen: null,
    truncated: false,
    domBytesSeen: null,
    domTruncated: false,
    httpStatus: 200,
    cause: null,
    settle: null,
    screenshot: null,
    rawHash: "a".repeat(64),
    textHash: "b".repeat(64),
    finalOrigin: "https://example.com",
  };
  const outcome = articleOutcome(true, { capture: usable, limitation: null }, null, "succeeded");
  assert.deepEqual(outcome?.capture, { ...usable, status: "unusable", reason: "other" });
  assert.match(outcome?.limitation ?? "", /^Article not analysed: verification failed/);
  assert.ok(validateCaptureSummary(outcome?.capture, BOUNDS).ok, "the downgraded summary is a valid capture summary");
  // Unchanged: a verified usable article keeps no outcome, a non-usable summary is used as is, a story without a URL has none.
  const article = captureStaticArticleDetailed(input, { status: 200, body: HTML, sha256: hash(HTML), contentType: "text/html" }, BOUNDS).evidence;
  assert.deepEqual(articleOutcome(true, { capture: usable, limitation: null }, article, "succeeded"), { capture: usable, limitation: null });
  const thin = { capture: { ...usable, status: "unsupported" as const, reason: "thin" as const }, limitation: "Article not analysed: too thin" };
  assert.deepEqual(articleOutcome(true, thin, null, "succeeded"), thin);
  assert.equal(articleOutcome(false, { capture: usable, limitation: null }, null, "succeeded"), null);
});

test("urlExtensionOutcome: a pre-refused URL's account passes the pinned capture-summary shape and is non_html", () => {
  const o = urlExtensionOutcome("pdf");
  assert.equal(validateCaptureSummary(o.capture, BOUNDS).ok, true);
  assert.deepEqual([o.capture.status, o.capture.reason, o.capture.cause], ["unsupported", "non_html", "non_html"]);
  assert.ok(o.limitation && o.limitation.length <= 300);
  // The account is what articleOutcome returns for a verified summary, so the workflow stores it unchanged.
  assert.deepEqual(articleOutcome(true, o, null, "succeeded"), o);
});

test("articleOutcome: a bound cause names the configured bounds without inventing a size; other causes and tokens get no detail", () => {
  const b = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "browser.capture.rawAllocationMaxBytes": 1_000_000, "browser.capture.screenshotMaxBytes": 500_000 });
  const bound = articleOutcome(true, null, null, "succeeded", "bound", undefined, b);
  assert.deepEqual(bound?.capture.bound, {
    limits: [
      { key: "browser.capture.rawAllocationMaxBytes", bytes: 1_000_000 },
      { key: "browser.capture.screenshotMaxBytes", bytes: 500_000 },
    ],
    observedBytes: null,
  });
  assert.equal(
    bound?.limitation,
    "Article not analysed: browser capture failed (cause bound): a size bound was exceeded (browser.capture.rawAllocationMaxBytes 1000000 or browser.capture.screenshotMaxBytes 500000); the worker did not report which one or the observed size",
  );
  assert.ok((bound?.limitation ?? "").length <= STORY_LIMITATION_MAX, "the sentence is not clipped");
  assert.ok(validateCaptureSummary(bound?.capture, b).ok);
  assert.equal(validateCaptureSummary(bound?.capture, BOUNDS).ok, false, "limits must be the configured ones");
  // The closed exit cause is kept in the limitation of a worker that failed; absent, the wording is unchanged.
  assert.match(articleOutcome(true, null, null, "failed", undefined, "signal", b)?.limitation ?? "", /article worker failed \(signal\); no capture receipt/);
  assert.match(
    articleOutcome(true, null, null, "failed", "publish_failed", "oom_killed", b)?.limitation ?? "",
    /\(cause publish_failed\); worker failed \(oom_killed\)$/,
  );
  assert.match(articleOutcome(true, null, null, "failed", undefined, undefined, b)?.limitation ?? "", /article worker failed; no capture receipt/);
  // Negative: another cause, an unknown token, no token and a bare failed worker carry no bound detail.
  for (const token of ["deadline", "non_html", "navigation_error", "not_a_cause", undefined]) {
    const o = articleOutcome(true, null, null, "failed", token, undefined, b);
    assert.equal(o?.capture.bound, undefined, String(token));
    assert.doesNotMatch(o?.limitation ?? "", /size bound/);
  }
});

test("capture verifier (browser): text with a NUL is refused at capture verification, as articleText would refuse it later", async () => {
  const ok = await fixture({ browserText: LONG_TEXT });
  const bad = await fixture({ browserText: `${LONG_TEXT} before\u0000after` });
  try {
    assert.ok(await ok.verifier().verify(ok.ctx, ok.terminal, input, "browser"), "control: the same fixture without a NUL verifies");
    assert.equal(await bad.verifier().verify(bad.ctx, bad.terminal, input, "browser"), null);
    assert.equal(await bad.verifier().summarize(bad.ctx, bad.terminal, input, "browser"), null);
  } finally {
    ok.close();
    bad.close();
  }
});

test("capture verifier (browser): an unverifiable receipt has no summary and no usable article", async () => {
  const f = await fixture({ browserText: LONG_TEXT });
  try {
    const old = f.receipt;
    assert.ok(old);
    const unverifiable: CaptureReceipt[] = [
      { ...old, rawBodyReport: { ...old.rawBodyReport, sha256: "b".repeat(64) } },
      { ...old, navigationReport: undefined },
      { ...old, finalUrl: "http://127.0.0.1/private" },
    ];
    for (const receipt of unverifiable) {
      f.receipt = receipt;
      assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null);
      assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "browser"), null);
    }
  } finally {
    f.close();
  }
});

test("capture verifier: native navigation must match actual argument limits, extraction and all report references", async () => {
  for (const mutate of [
    (nav: Record<string, unknown>) => {
      nav.limits = { maxBytes: 1048576, deadlineMs: 1000, textBytes: 8192, screenshotBytes: 1048576, truncated: false };
    },
    (nav: Record<string, unknown>) => {
      nav.textReport = { id: "invented", sha256: "b".repeat(64) };
    },
    (nav: Record<string, unknown>) => {
      nav.extraction = { ...(nav.extraction as Record<string, unknown>), region: "main-content/everything" };
    },
    (nav: Record<string, unknown>) => {
      nav.extraction = {
        source: "rendered-dom-innerText",
        region: "article/main/body",
        normalization: "collapse-whitespace-trim",
        maxBytes: 8192,
        truncated: true,
      };
      nav.limits = { maxBytes: input.maxBytes, deadlineMs: 60000, textBytes: 8192, screenshotBytes: 1048576, truncated: true };
      nav.limitations = [];
    },
  ]) {
    const f = await fixture({ browserText: "Native capture contract fixture" });
    try {
      const old = f.receipt;
      assert.ok(old?.navigationReport);
      const nav = await f.reports.read(f.child.id, old.navigationReport.id);
      assert.ok(nav);
      const value = JSON.parse(Buffer.from(nav.content).toString("utf8"));
      mutate(value);
      const navigationReport = await f.publish("wrong-navigation.json", new TextEncoder().encode(JSON.stringify(value)), "application/json");
      f.receipt = { ...old, navigationReport };
      assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "browser"), null);
    } finally {
      f.close();
    }
  }
});

// Every label in the closed region set is accepted (a refined capture and the unrefined fallback); the receipt states the label the capture reported.
test("capture verifier: every extraction.region label in the closed set is accepted and recorded", async () => {
  for (const region of EXTRACTION_REGIONS) {
    const f = await fixture({ browserText: LONG_TEXT, browserRegion: region });
    try {
      assert.ok(f.receipt?.navigationReport);
      const nav = JSON.parse(Buffer.from((await f.reports.read(f.child.id, f.receipt.navigationReport.id))!.content).toString("utf8"));
      assert.equal(nav.extraction.region, region);
      assert.equal((await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser"))?.capture.status, "usable", region);
    } finally {
      f.close();
    }
  }
});

// A log recorded with other bounds than the host resolved (image/daemon skew, or tampering) is refused; the same log is accepted by a host
// whose resolved bounds equal it. The 4096/524288 log stands for a worker that was given those values (the real worker records exactly
// what it was given: agent-image captureBrowser limits).
test("capture verifier: the navigation log's recorded text and screenshot limits must EQUAL the host's resolved bounds", async () => {
  const text4096 = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "browser.capture.textMaxBytes": 4096 });
  const shot512 = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "browser.capture.screenshotMaxBytes": 524288 });
  const rewrite = async (
    f: Awaited<ReturnType<typeof fixture>>,
    mutate: (nav: { extraction: Record<string, unknown>; limits: Record<string, unknown> }) => void,
  ) => {
    const old = f.receipt;
    assert.ok(old?.navigationReport);
    const nav = await f.reports.read(f.child.id, old.navigationReport.id);
    assert.ok(nav);
    const value = JSON.parse(Buffer.from(nav.content).toString("utf8"));
    mutate(value);
    const navigationReport = await f.publish("rebound-navigation.json", new TextEncoder().encode(JSON.stringify(value)), "application/json");
    f.receipt = { ...old, navigationReport };
  };
  const f = await fixture({ browserText: LONG_TEXT });
  try {
    // The default (8192 / 1 MiB) log: accepted at the defaults, refused by a host resolved to text 4096 or screenshot 512 KiB.
    assert.ok(await f.verifier(false).summarize(f.ctx, f.terminal, input, "browser"));
    assert.equal(await f.verifier(false, text4096).summarize(f.ctx, f.terminal, input, "browser"), null);
    assert.equal(await f.verifier(false, shot512).summarize(f.ctx, f.terminal, input, "browser"), null);
    // A 4096 log: accepted by the 4096 host, refused at the defaults.
    await rewrite(f, (n) => {
      n.extraction.maxBytes = 4096;
      n.limits.textBytes = 4096;
    });
    assert.ok(await f.verifier(false, text4096).summarize(f.ctx, f.terminal, input, "browser"));
    assert.equal(await f.verifier(false).summarize(f.ctx, f.terminal, input, "browser"), null);
    assert.equal(await f.verifier(false).verify(f.ctx, f.terminal, input, "browser"), null);
    // Extraction and limits must agree with each other too: a log with only one of them at 4096 is refused by both hosts.
    await rewrite(f, (n) => {
      n.extraction.maxBytes = 8192;
      n.limits.textBytes = 4096;
    });
    assert.equal(await f.verifier(false, text4096).summarize(f.ctx, f.terminal, input, "browser"), null);
    assert.equal(await f.verifier(false).summarize(f.ctx, f.terminal, input, "browser"), null);
  } finally {
    f.close();
  }
  const g = await fixture({ browserText: LONG_TEXT });
  try {
    await rewrite(g, (n) => {
      n.limits.screenshotBytes = 524288;
    });
    assert.ok(await g.verifier(false, shot512).summarize(g.ctx, g.terminal, input, "browser"));
    assert.equal(await g.verifier(false).summarize(g.ctx, g.terminal, input, "browser"), null);
  } finally {
    g.close();
  }
});

test("static worker: bounded public redirects recorded, private/credential redirects denied before transport", async () => {
  const urls: string[] = [];
  let receipt: CaptureReceipt | null = null;
  const base = {
    worker: "worker",
    generation: 0,
    profile: "audited-public" as const,
    bounds: BOUNDS,
    signal: new AbortController().signal,
    publish: async (name: string, bytes: Uint8Array) => ({ id: name, sha256: hash(bytes) }),
    record: async (r: CaptureReceipt) => {
      receipt = r;
    },
  };
  await runStaticWorker(input, {
    ...base,
    transport: async (url) => {
      urls.push(url);
      return urls.length === 1
        ? { status: 302, headers: new Headers({ location: "https://publisher.example/final" }), body: null }
        : {
            status: 200,
            headers: new Headers({ "content-type": "text/html" }),
            body: (async function* () {
              yield new TextEncoder().encode(HTML);
            })(),
          };
    },
  });
  assert.equal(urls.length, 2);
  assert.equal((receipt as CaptureReceipt | null)?.finalUrl, "https://publisher.example/final");
  for (const target of ["http://127.0.0.1/private", "https://key:password@example.com/a"])
    await assert.rejects(
      runStaticWorker(input, { ...base, transport: async () => ({ status: 302, headers: new Headers({ location: target }), body: null }) }),
      /credential-free public URL/,
    );
  await assert.rejects(
    runStaticWorker(input, { ...base, transport: async () => ({ status: 302, headers: new Headers({ location: "https://example.com/again" }), body: null }) }),
    /redirect bound exceeded/,
  );
});

const CAP = input.maxBytes;
const DOC = new TextEncoder().encode(HTML);
// Streams bytes in fixed-size chunks, then one empty chunk, as a network body may end.
function streamed(bytes: Uint8Array, chunk: number): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < bytes.byteLength; i += chunk) yield bytes.subarray(i, i + chunk);
    yield new Uint8Array(0);
  })();
}
// The article document followed by spaces, exactly `length` bytes long.
function padded(length: number): Uint8Array {
  const out = new Uint8Array(length).fill(0x20);
  out.set(DOC.subarray(0, Math.min(DOC.byteLength, length)));
  return out;
}
async function captureBody(bytes: Uint8Array, over: { chunk?: number; now?: () => number } = {}) {
  const published = new Map<string, Uint8Array>();
  let receipt: CaptureReceipt | null = null;
  const result = await runStaticWorker(input, {
    worker: "worker",
    generation: 0,
    profile: "audited-public",
    bounds: BOUNDS,
    signal: new AbortController().signal,
    ...(over.now && { now: over.now }),
    transport: async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      body: streamed(bytes, over.chunk ?? 16384),
    }),
    publish: async (name, b) => {
      published.set(name, b);
      return { id: name, sha256: hash(b) };
    },
    record: async (r) => {
      receipt = r;
    },
  });
  return { result, receipt: receipt as CaptureReceipt | null, retained: published.get("article-body.html") };
}

test("static worker: a body above maxBytes is truncated to exactly maxBytes, not refused", async () => {
  for (const [extra, chunk] of [
    [1, CAP],
    [5000, 16384],
  ] as const) {
    const bytes = padded(CAP + extra);
    const { result, receipt, retained } = await captureBody(bytes, { chunk });
    assert.equal(receipt?.truncated, true);
    assert.equal(receipt?.bytesRetained, CAP);
    assert.equal(retained?.byteLength, CAP);
    assert.deepEqual(retained, bytes.subarray(0, CAP));
    assert.equal(receipt?.rawBodyReport.sha256, hash(bytes.subarray(0, CAP)));
    assert.match(result.summary, /Static article capture usable/);
  }
});

test("static worker: a body of exactly maxBytes is not truncated, with or without a trailing empty chunk", async () => {
  for (const chunk of [CAP, 1000]) {
    const { receipt, retained } = await captureBody(padded(CAP), { chunk });
    assert.equal(receipt?.truncated, undefined);
    assert.equal(receipt?.bytesRetained, undefined);
    assert.equal(retained?.byteLength, CAP);
  }
});

test("static worker: a multibyte character cut by the cap is trimmed so the UTF-8 check still passes", async () => {
  // A three-byte character occupies byte offsets CAP-1 .. CAP+1; only its lead byte falls inside the cap.
  const bytes = new Uint8Array(CAP + 2);
  bytes.set(padded(CAP - 1));
  bytes.set(new TextEncoder().encode("€"), CAP - 1);
  const { result, receipt, retained } = await captureBody(bytes);
  assert.equal(receipt?.truncated, true);
  assert.equal(receipt?.bytesRetained, CAP - 1);
  assert.equal(retained?.byteLength, CAP - 1);
  assert.equal(
    Buffer.from(retained ?? [])
      .toString("utf8")
      .includes("�"),
    false,
  );
  assert.match(result.summary, /Static article capture usable/);
});

test("static worker: fetchedAt is an ISO time from the injected clock, or the default clock when none is injected", async () => {
  const at = Date.parse("2026-10-20T12:34:56.789Z");
  assert.equal((await captureBody(DOC, { now: () => at })).receipt?.fetchedAt, "2026-10-20T12:34:56.789Z");
  const fetchedAt = (await captureBody(DOC)).receipt?.fetchedAt;
  assert.equal(typeof fetchedAt, "string");
  assert.equal(new Date(fetchedAt ?? "").toISOString(), fetchedAt);
});

test("capture verifier: a receipt claiming truncation must match the retained body length, and a matching one carries the limitation", async () => {
  const f = await fixture();
  try {
    const receipt = f.receipt;
    assert.ok(receipt);
    const size = Buffer.byteLength(HTML);
    f.receipt = { ...receipt, truncated: true, bytesRetained: size + 1, fetchedAt: "2026-10-20T00:00:00.000Z" };
    assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "static-http"), null);
    f.receipt = { ...receipt, truncated: true, bytesRetained: size, fetchedAt: "2026-10-20T00:00:00.000Z" };
    const evidence = await f.verifier().verify(f.ctx, f.terminal, input, "static-http");
    assert.ok(evidence);
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.bytesRetained, size);
    assert.equal(evidence.fetchedAt, "2026-10-20T00:00:00.000Z");
    assert.ok(evidence.limitations.includes(`article truncated at ${size} bytes (cap ${input.maxBytes}); analysis covers the retained prefix only`));
  } finally {
    f.close();
  }
});

test("CAPTURE_CAUSES mirrors the worker's CAPTURE_FAILURE_CAUSES exactly (round trip)", () => {
  assert.deepEqual([...CAPTURE_CAUSES], [...CAPTURE_FAILURE_CAUSES]);
});

test("captureCauseOf / browserFailureReason: every worker cause, as the worker's own suffix writer renders it and the daemon's parser reads it, maps into the closed reasons", () => {
  const expected: Record<string, string> = { non_html: "non_html", bound: "bound", navigation_error: "fetch_error", bot_challenge: "blocked" };
  for (const cause of CAPTURE_FAILURE_CAUSES) {
    for (const netError of [undefined, "ERR_NAME_NOT_RESOLVED"]) {
      const text = `trusted browser capture failed; no receipt issued (${captureFailureSuffix({ cause, netError })})`;
      const token = toolFailureCauseOf(text); // pomtreed's parser: the token the receipt carries
      assert.equal(token, cause, "the daemon parser recovers the worker's cause");
      const mapped = captureCauseOf(token);
      assert.equal(mapped, cause);
      const reason = browserFailureReason(mapped);
      assert.ok((CAPTURE_REASONS as readonly string[]).includes(reason), `${cause} -> ${reason} is not a closed reason`);
      assert.equal(reason, expected[cause] ?? "other", `${cause} ${netError ?? ""}`);
    }
  }
});

test("captureCauseOf / browserFailureReason: absent is null and other, an unknown or hostile token is other", () => {
  assert.equal(captureCauseOf(undefined), null);
  assert.equal(captureCauseOf(null), null);
  assert.equal(browserFailureReason(null), "other");
  for (const bad of ["", "bogus", "NON_HTML", "__proto__", "constructor", "toString", "bound ", "non_html net=x"]) {
    assert.equal(captureCauseOf(bad), "other", bad);
    assert.equal(browserFailureReason(captureCauseOf(bad)), "other", bad);
  }
});

// A response and DOM larger than input.maxBytes (32768): the real captureBrowser clips both at the bound and records it in the navigation limits.
const BIG_BODY = `<html><body>${"x".repeat(input.maxBytes * 2)}</body></html>`;
const BIG_DOM = `<html><main>${"y".repeat(input.maxBytes + 500)}</main></html>`;

test("capture verifier (browser): a body and DOM clipped at the bound verify, are retained, and are reported truncated with the full size", async () => {
  const f = await fixture({ browserText: LONG_TEXT, browserBody: BIG_BODY, browserDom: BIG_DOM });
  try {
    const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
    assert.ok(outcome);
    assert.equal(outcome.capture.truncated, true);
    assert.equal(outcome.capture.bodyBytes, input.maxBytes, "the retained prefix is exactly the bound for ASCII");
    assert.equal(outcome.capture.bodyBytesSeen, Buffer.byteLength(BIG_BODY));
    assert.equal(outcome.capture.domTruncated, true);
    assert.equal(outcome.capture.domBytesSeen, Buffer.byteLength(BIG_DOM));
    assert.equal(validateCaptureSummary(outcome.capture, BOUNDS).ok, true);
    const evidence = await f.verifier(true).verify(f.ctx, f.terminal, input, "browser");
    assert.ok(evidence);
    assert.deepEqual(
      { truncated: evidence.truncated, bytesRetained: evidence.bytesRetained, bytesSeen: evidence.bytesSeen },
      { truncated: true, bytesRetained: input.maxBytes, bytesSeen: Buffer.byteLength(BIG_BODY) },
    );
    assert.match(evidence.limitations.join(" "), /raw body clipped/);
    assert.equal(hash(Buffer.from(BIG_BODY).subarray(0, input.maxBytes)), evidence.rawHash, "the hash covers the retained bytes");
  } finally {
    f.close();
  }
});

test("capture verifier (browser): an unclipped capture reports truncated false and equal body counts", async () => {
  const f = await fixture({ browserText: LONG_TEXT });
  try {
    const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
    assert.deepEqual(
      [outcome?.capture.truncated, outcome?.capture.bodyBytes, outcome?.capture.bodyBytesSeen],
      [false, Buffer.byteLength(HTML), Buffer.byteLength(HTML)],
    );
    const evidence = await f.verifier(true).verify(f.ctx, f.terminal, input, "browser");
    assert.equal(evidence?.truncated, false);
  } finally {
    f.close();
  }
});

test("capture verifier (browser): the settle result is surfaced, and an unsettled page says so", async () => {
  const settled = await fixture({ browserText: LONG_TEXT });
  const empty = await fixture({ browserText: "" });
  try {
    const a = await settled.verifier(true).summarize(settled.ctx, settled.terminal, input, "browser");
    assert.equal(a?.capture.settle?.settled, true);
    assert.ok(Number.isInteger(a?.capture.settle?.polls) && (a?.capture.settle?.polls ?? 0) >= 2);
    // Empty text never settles: sampled until maxMs, then recorded as unsettled.
    const b = await empty.verifier(true).summarize(empty.ctx, empty.terminal, input, "browser");
    assert.equal(b?.capture.settle?.settled, false);
  } finally {
    settled.close();
    empty.close();
  }
});

// Rewrites the navigation log of a verified browser capture and republishes it (with matching receipt) so only the mutated rule is in play.
async function mutatedNavigation(
  f: Awaited<ReturnType<typeof fixture>>,
  mutate: (nav: Record<string, unknown> & { limits: Record<string, unknown>; extraction: Record<string, unknown>; limitations: string[] }) => void,
) {
  const old = f.receipt;
  assert.ok(old?.navigationReport);
  const nav = await f.reports.read(f.child.id, old.navigationReport.id);
  assert.ok(nav);
  const value = JSON.parse(Buffer.from(nav.content).toString("utf8"));
  mutate(value);
  const navigationReport = await f.publish("mutated-navigation.json", new TextEncoder().encode(JSON.stringify(value)), "application/json");
  f.receipt = { ...old, navigationReport };
}

test("capture verifier (browser): malformed or inconsistent capture limits and settle are rejected, with no compatibility for a log that lacks them", async () => {
  const cases: [string, (nav: Parameters<Parameters<typeof mutatedNavigation>[1]>[0]) => void, string?][] = [
    ["rawBodyBytes absent", (n) => void delete n.limits.rawBodyBytes],
    ["rawBodyTruncated absent", (n) => void delete n.limits.rawBodyTruncated],
    ["domBytes absent", (n) => void delete n.limits.domBytes],
    ["domTruncated absent", (n) => void delete n.limits.domTruncated],
    ["settle absent", (n) => void delete n.extraction.settle],
    [
      "rawBodyBytes not an integer",
      (n) => {
        n.limits.rawBodyBytes = 1.5;
      },
    ],
    [
      "rawBodyBytes a string",
      (n) => {
        n.limits.rawBodyBytes = String(n.limits.rawBodyBytes);
      },
    ],
    [
      "rawBodyTruncated not boolean",
      (n) => {
        n.limits.rawBodyTruncated = "false";
      },
    ],
    [
      "rawBodyTruncated false but the full size exceeds what was retained",
      (n) => {
        n.limits.rawBodyBytes = (n.limits.rawBodyBytes as number) + 1;
      },
    ],
    [
      "rawBodyTruncated true on an unclipped body",
      (n) => {
        n.limits.rawBodyTruncated = true;
      },
    ],
    [
      "domTruncated true on an unclipped DOM",
      (n) => {
        n.limits.domTruncated = true;
      },
    ],
    [
      "settle.polls negative",
      (n) => {
        (n.extraction.settle as Record<string, unknown>).polls = -1;
      },
    ],
    [
      "settle.waitedMs beyond the bound",
      (n) => {
        (n.extraction.settle as Record<string, unknown>).waitedMs = 10 ** 9;
      },
    ],
    [
      "settle.settled not boolean",
      (n) => {
        (n.extraction.settle as Record<string, unknown>).settled = 1;
      },
    ],
    [
      "settle with an extra key",
      (n) => {
        (n.extraction.settle as Record<string, unknown>).extra = 1;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = await fixture({ browserText: LONG_TEXT });
    try {
      await mutatedNavigation(f, mutate);
      assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "browser"), null, `verify: ${name}`);
      assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null, `summarize: ${name}`);
    } finally {
      f.close();
    }
  }
});

test("capture verifier (browser): a clipped body that its log does not admit is rejected, and one retained past the bound is rejected", async () => {
  const lies: [string, (nav: Parameters<Parameters<typeof mutatedNavigation>[1]>[0]) => void][] = [
    [
      "clipped but the log claims it was not (full size above what was retained)",
      (n) => {
        n.limits.rawBodyTruncated = false;
      },
    ],
    [
      "clipped body without the clipped limitation",
      (n) => {
        n.limitations = n.limitations.filter((l) => !/clipped/i.test(l));
      },
    ],
    [
      "clipped but the full size is not over the bound",
      (n) => {
        n.limits.rawBodyBytes = input.maxBytes;
      },
    ],
  ];
  for (const [name, mutate] of lies) {
    const f = await fixture({ browserText: LONG_TEXT, browserBody: BIG_BODY, browserDom: BIG_DOM });
    try {
      await mutatedNavigation(f, mutate);
      assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null, name);
    } finally {
      f.close();
    }
  }
  // Retained one byte past the bound: the verifier's read cap (input.maxBytes) refuses it even though the log would be self-consistent.
  const f = await fixture({ browserText: LONG_TEXT, browserBody: "z".repeat(input.maxBytes + 1) });
  try {
    const old = f.receipt;
    assert.ok(old);
    const tooBig = await f.publish("raw-too-big", new TextEncoder().encode("z".repeat(input.maxBytes + 1)), "text/html");
    f.receipt = { ...old, rawBodyReport: tooBig };
    assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null);
  } finally {
    f.close();
  }
});

// browserLimits is pure: retained lengths are given directly, so each clip rule has a positive and a negative case.
const SETTLE = { settled: true, polls: 2, waitedMs: 500 };
const logOf = (limits: Record<string, unknown>, settle: Record<string, unknown> = SETTLE) => ({ limits, extraction: { settle } });
const MAX = 1000;
const FULL = MAX + 500;

test("browserLimits: a truncated raw body retains exactly maxBytes (slack 0), a truncated DOM within [maxBytes - 3, maxBytes]", () => {
  const log = logOf({ rawBodyBytes: FULL, rawBodyTruncated: true, domBytes: FULL, domTruncated: true });
  assert.notEqual(browserLimits(log, MAX, MAX, MAX, 8, BOUNDS), null);
  assert.notEqual(browserLimits(log, MAX, MAX, MAX - CLIP_UTF8_MAX_BACKOFF, 8, BOUNDS), null, "DOM at the slack edge");
  assert.equal(browserLimits(log, MAX, MAX - 1, MAX, 8, BOUNDS), null, "raw one byte short is rejected");
  assert.equal(browserLimits(log, MAX, MAX - CLIP_UTF8_MAX_BACKOFF, MAX, 8, BOUNDS), null, "raw at the DOM slack edge is rejected");
  assert.equal(browserLimits(log, MAX, MAX, MAX - CLIP_UTF8_MAX_BACKOFF - 1, 8, BOUNDS), null, "DOM past the slack is rejected");
  assert.equal(browserLimits(log, MAX, MAX + 1, MAX, 8, BOUNDS), null, "raw past the bound is rejected");
  assert.equal(browserLimits(log, MAX, MAX, MAX + 1, 8, BOUNDS), null, "DOM past the bound is rejected");
});

test("browserLimits: the settle bounds are the worker's maxima, one past either is rejected", () => {
  const limits = { rawBodyBytes: 10, rawBodyTruncated: false, domBytes: 10, domTruncated: false };
  const at = (settle: Record<string, unknown>) => browserLimits(logOf(limits, settle), MAX, 10, 10, 8, BOUNDS);
  assert.notEqual(at({ settled: true, polls: BROWSER_SETTLE_POLLS_MAX, waitedMs: BROWSER_SETTLE_WAIT_MAX_MS }), null);
  assert.equal(at({ settled: true, polls: BROWSER_SETTLE_POLLS_MAX + 1, waitedMs: 1 }), null);
  assert.equal(at({ settled: true, polls: 1, waitedMs: BROWSER_SETTLE_WAIT_MAX_MS + 1 }), null);
});

test("capture verifier (browser): a reduced screenshot is surfaced as a verified clip with the viewport and retained PNG sizes", async () => {
  for (const [steps, height] of [
    [1, BROWSER_SCREENSHOT_FALLBACK_HEIGHTS[0]],
    [2, BROWSER_SCREENSHOT_FALLBACK_HEIGHTS[1]],
  ] as const) {
    const f = await fixture({ browserText: LONG_TEXT, screenshotSteps: steps });
    try {
      const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
      assert.ok(outcome);
      assert.deepEqual(outcome.capture.screenshot, {
        bytes: 8,
        viewportBytes: BOUNDS.capture.screenshotMaxBytes + 1,
        clip: { x: 0, y: 0, width: BROWSER_VIEWPORT.width, height },
      });
      assert.equal(validateCaptureSummary(outcome.capture, BOUNDS).ok, true);
      const evidence = await f.verifier(true).verify(f.ctx, f.terminal, input, "browser");
      assert.ok(evidence);
      assert.match(evidence.limitations.join(" "), new RegExp(`screenshot reduced to the top ${BROWSER_VIEWPORT.width}x${height}`));
    } finally {
      f.close();
    }
  }
  const whole = await fixture({ browserText: LONG_TEXT });
  try {
    const outcome = await whole.verifier(true).summarize(whole.ctx, whole.terminal, input, "browser");
    assert.deepEqual(outcome?.capture.screenshot, { bytes: 8, viewportBytes: null, clip: null }, "an unreduced screenshot has no clip");
  } finally {
    whole.close();
  }
});

test("capture verifier (browser): a forged or inconsistent screenshot clip is rejected", async () => {
  type Nav = Parameters<Parameters<typeof mutatedNavigation>[1]>[0];
  const clipOf = (n: Nav) => n.limits.screenshotClip as Record<string, unknown>;
  const set = (o: Record<string, unknown>, k: string, v: unknown): void => {
    o[k] = v;
  };
  const reduced: [string, (n: Nav) => void][] = [
    ["clip without viewport bytes", (n) => void delete n.limits.viewportScreenshotBytes],
    ["viewport bytes without clip", (n) => void delete n.limits.screenshotClip],
    ["clip height the worker never takes", (n) => set(clipOf(n), "height", 500)],
    ["clip offset", (n) => set(clipOf(n), "x", 5)],
    ["clip wider than the viewport", (n) => set(clipOf(n), "width", BROWSER_VIEWPORT.width + 1)],
    ["clip with an extra key", (n) => set(clipOf(n), "extra", 1)],
    ["viewport bytes within the bound (no reason to reduce)", (n) => set(n.limits, "viewportScreenshotBytes", BOUNDS.capture.screenshotMaxBytes)],
    ["viewport bytes not an integer", (n) => set(n.limits, "viewportScreenshotBytes", "1092557")],
    [
      "the log's limitations do not state the reduction",
      (n) =>
        set(
          n,
          "limitations",
          n.limitations.filter((l) => !/^screenshot reduced/.test(l)),
        ),
    ],
    ["the stated size differs from the limit", (n) => set(n.limits, "viewportScreenshotBytes", BOUNDS.capture.screenshotMaxBytes + 2)],
    ["the stated clip differs from the limit", (n) => set(clipOf(n), "height", BROWSER_SCREENSHOT_FALLBACK_HEIGHTS[1])],
  ];
  for (const [name, mutate] of reduced) {
    const f = await fixture({ browserText: LONG_TEXT, screenshotSteps: 1 });
    try {
      await mutatedNavigation(f, mutate);
      assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null, `summarize: ${name}`);
      assert.equal(await f.verifier().verify(f.ctx, f.terminal, input, "browser"), null, `verify: ${name}`);
    } finally {
      f.close();
    }
  }
  // A clip forged onto a capture whose screenshot was never reduced, without the worker's limitation line.
  const f = await fixture({ browserText: LONG_TEXT });
  try {
    await mutatedNavigation(f, (n) => {
      n.limits.screenshotClip = { x: 0, y: 0, width: BROWSER_VIEWPORT.width, height: BROWSER_SCREENSHOT_FALLBACK_HEIGHTS[0] };
      n.limits.viewportScreenshotBytes = BOUNDS.capture.screenshotMaxBytes + 1;
    });
    assert.equal(await f.verifier().summarize(f.ctx, f.terminal, input, "browser"), null);
  } finally {
    f.close();
  }
});

test("capture verifier (browser): textTruncated on the evidence follows the verified text clip, separately from the body", async () => {
  const clipped = await fixture({ browserText: "w ".repeat(BOUNDS.capture.textMaxBytes) });
  const whole = await fixture({ browserText: LONG_TEXT });
  try {
    const a = await clipped.verifier(true).verify(clipped.ctx, clipped.terminal, input, "browser");
    assert.deepEqual([a?.textTruncated, a?.truncated], [true, false], "text clipped, body whole");
    const b = await whole.verifier(true).verify(whole.ctx, whole.terminal, input, "browser");
    assert.deepEqual([b?.textTruncated, b?.truncated], [false, false]);
  } finally {
    clipped.close();
    whole.close();
  }
});

// The worst case of the limitation chain (limitation-bounds.mts): every conditional worker line at once (text, raw body and DOM clipped,
// screenshot reduced twice, text unsettled). It once overflowed the article's bound (worker lines plus two host lines), so verify refused it.
test("capture verifier (browser): a capture with every worker limitation verifies within the article's limitation bound", async () => {
  const f = await fixture({
    browserText: "w ".repeat(BOUNDS.capture.textMaxBytes),
    browserBody: BIG_BODY,
    browserDom: BIG_DOM,
    screenshotSteps: 2,
    unsettled: true,
  });
  try {
    const outcome = await f.verifier(true).summarize(f.ctx, f.terminal, input, "browser");
    assert.ok(outcome);
    assert.equal(outcome.capture.settle?.settled, false);
    assert.equal(outcome.capture.screenshot?.clip?.height, BROWSER_SCREENSHOT_FALLBACK_HEIGHTS[1]);
    const evidence = await f.verifier(true).verify(f.ctx, f.terminal, input, "browser");
    assert.ok(evidence, "the worst-case capture verifies");
    assert.deepEqual(evidence.limitations.slice(0, BROWSER_HOST_LIMITATIONS.length), [...BROWSER_HOST_LIMITATIONS]);
    assert.ok(evidence.limitations.length <= ARTICLE_LIMITATIONS_MAX, `${evidence.limitations.length} lines`);
    for (const [kind, re] of [
      ["text", /DOM text clipped/],
      ["raw", /raw body clipped/],
      ["dom", /^DOM clipped/],
      ["screenshot", /screenshot reduced/],
      ["settle", /not stabilized/],
    ] as const)
      assert.ok(
        evidence.limitations.some((l) => re.test(l)),
        kind,
      );
  } finally {
    f.close();
  }
});

// ---- Paged reading: the whole-text resolver and the page publisher ----

const analystSpec = { image: "fixture@sha256:abc", envManifestHash: null, extensions: [], systemPrompt: null, egress: { kind: "registry" as const } };
const newAnalyst = async (f: Awaited<ReturnType<typeof fixture>>, id: string, parent: string): Promise<AgentRecord> => {
  const made = await f.store.registry.create({
    id,
    parent,
    name: id,
    task: id,
    host: "h1",
    budgetMicros: 1,
    idempotencyKey: id,
    executor: "container",
    spec: analystSpec,
  });
  return f.store.registry.transition(made.id, made.generation, "running", { idempotencyKey: `${id}:start` });
};

test("articleText: resolves the whole retained text, and refuses a report whose bytes, hash or size no longer match the evidence", async () => {
  const f = await fixture();
  try {
    const evidence = await f.verifier().verify(f.ctx, f.terminal, input, "static-http");
    assert.ok(evidence?.textReport);
    const verifier = f.verifier();
    assert.equal(await verifier.articleText(evidence), staticText());
    // The evidence claims: another size, another hash, another report, no report, an unusable status.
    assert.equal(await verifier.articleText({ ...evidence, textBytes: evidence.textBytes + 1 }), null);
    assert.equal(await verifier.articleText({ ...evidence, textHash: "c".repeat(64), textReport: { ...evidence.textReport, sha256: "c".repeat(64) } }), null);
    assert.equal(await verifier.articleText({ ...evidence, textReport: { ...evidence.textReport, id: "no-such-report" } }), null);
    assert.equal(await verifier.articleText({ ...evidence, textReport: undefined }), null);
    assert.equal(await verifier.articleText({ ...evidence, status: "unsupported" }), null);
    // The retained file itself altered after retention: the hash check refuses it.
    writeFileSync(join(f.dir, "reports", f.root.id, evidence.textReport.id, "content"), "altered ".repeat(40));
    assert.equal(await verifier.articleText(evidence), null);
  } finally {
    f.close();
  }
});

test("articleText: text beyond ext.hnDigest.articleTextMaxBytes is refused even when the report and hash agree", async () => {
  const f = await fixture();
  try {
    const evidence = await f.verifier().verify(f.ctx, f.terminal, input, "static-http");
    assert.ok(evidence);
    const tight = contentBounds({ ...CONTENT_CONFIG_DEFAULTS, "ext.hnDigest.articleTextMaxBytes": 256, "browser.capture.textMaxBytes": 256 });
    assert.ok(evidence.textBytes > 256);
    assert.equal(await f.verifier(false, tight).articleText(evidence), null);
  } finally {
    f.close();
  }
});

test("publishPages: pages land under the analyst child's own custody, idempotently, and only for the caller's own child", async () => {
  const f = await fixture();
  try {
    const text = "Paged sentence about ledgers and retries. ".repeat(400).trim();
    const plan = planPages(text, { pageMaxBytes: 4096, readMaxBytes: 8192 });
    assert.ok(plan.pages.length >= 2);
    const analyst = await newAnalyst(f, "analyst", f.parent.id);
    const verifier = f.verifier();
    await verifier.publishPages(f.ctx, analyst, plan);
    await verifier.publishPages(f.ctx, analyst, plan); // a resumed segment re-publishes harmlessly
    const listed = await f.reports.list(analyst.id);
    assert.deepEqual(
      listed.map((r) => r.name).sort(),
      plan.pages.map((p) => p.name),
    );
    for (const page of plan.pages) {
      const got = await f.reports.read(analyst.id, page.name);
      assert.equal(Buffer.from(got?.content ?? []).toString("utf8"), page.content);
      assert.equal(got?.report.sha256, page.sha256);
      assert.equal(got?.report.mediaType, "text/plain");
    }
    assert.deepEqual(await f.reports.list(f.root.id), [], "nothing is written under the root or the caller");
    // Different content under an existing page name is an error, never a silent keep.
    const other = planPages("Different text entirely. ".repeat(400).trim(), { pageMaxBytes: 4096, readMaxBytes: 8192 });
    await assert.rejects(() => verifier.publishPages(f.ctx, analyst, other), /already exists with different content.*changed across a restart/);
    // An agent that is not the caller's child is refused: the pages are not a channel to arbitrary custody.
    const foreign = await newAnalyst(f, "foreign", f.root.id);
    await assert.rejects(() => verifier.publishPages(f.ctx, foreign, plan), /only to the caller's own analyst child/);
    assert.deepEqual(await f.reports.list(foreign.id), []);
  } finally {
    f.close();
  }
});
