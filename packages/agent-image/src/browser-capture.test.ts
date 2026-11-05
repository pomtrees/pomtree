import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureBrowser,
  clipBytes,
  clipRawBytes,
  CLIP_UTF8_MAX_BACKOFF,
  BROWSER_SETTLE_POLLS_MAX,
  BROWSER_SETTLE_WAIT_MAX_MS,
  DEFAULT_SETTLE,
  type CaptureLimits,
  captureLimits,
  settleSample,
  captureUrl,
  clipCapturedDomText,
  normalizeCapturedDomText,
  parseReportPublishJson,
  BROWSER_VIEWPORT,
  BROWSER_SCREENSHOT_FALLBACK_HEIGHTS,
  publishArgv,
  type CapturePage,
  type CaptureSession,
  CAPTURE_TEARDOWN_MS,
  runCaptureProcess,
  type ScreenshotClip,
} from "./browser-capture.ts";
import { type ExtractionRegion, EXTRACTION_REGIONS, EXTRACTION_REGION_FALLBACK, MAIN_CONTENT_TUNING, snapshotInPage } from "./main-content.ts";
import { CONTAINER_DEFAULTS } from "./container-contract.gen.ts";
import { captureFailureDiagnostic } from "../ext/pomtree-browser/capture-diagnostic.ts";

// The capture limits at the registry defaults, as main() builds them from an all-default document.
const LIMITS = captureLimits(CONTAINER_DEFAULTS);
const BROWSER_SCREENSHOT_MAX_BYTES = LIMITS.screenshotMaxBytes;

const RAW = new TextEncoder().encode("<html>wire-entity-bytes</html>");
const DOM = new TextEncoder().encode("<html><body><p>rendered</p></body></html>");
const TEXT = "rendered";
const SHOT = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const sha = (d: Uint8Array | string) => createHash("sha256").update(d).digest("hex");

function fakePage(
  over: Partial<{
    response: unknown;
    finalUrl: string;
    settledUrl: string;
    contentLength: string | null;
    raw: Uint8Array;
    dom: Uint8Array;
    text: string;
    region: ExtractionRegion;
    rejected: string;
    hang: boolean;
    shot: (clip: ScreenshotClip | undefined) => Uint8Array;
  }> = {},
) {
  const o = {
    response: undefined as unknown,
    finalUrl: "https://example.test/a",
    settledUrl: "",
    contentLength: null as string | null,
    raw: RAW,
    dom: DOM,
    text: TEXT,
    region: undefined as ExtractionRegion | undefined,
    rejected: undefined as string | undefined,
    hang: false,
    shot: (_clip: ScreenshotClip | undefined) => SHOT,
    ...over,
  };
  const shots: (ScreenshotClip | undefined)[] = [];
  const closed = { n: 0 };
  const evaluated = { n: 0 };
  const response =
    o.response !== undefined
      ? o.response
      : {
          body: async () => o.raw,
          status: () => 200,
          headerValue: async (name: string) => (name === "content-type" ? "text/html; charset=utf-8" : name === "content-length" ? o.contentLength : null),
        };
  const page: CapturePage = {
    goto: async () => (o.hang ? new Promise(() => {}) : (response as never)),
    url: () => (o.settledUrl && evaluated.n > 0 ? o.settledUrl : o.finalUrl),
    evaluate: async (fn, arg) => (
      evaluated.n++,
      assert.equal(fn, snapshotInPage),
      assert.equal(arg, MAIN_CONTENT_TUNING),
      { dom: new TextDecoder().decode(o.dom), text: o.text, ...(o.region ? { region: o.region } : {}), ...(o.rejected ? { rejected: o.rejected } : {}) }
    ),
    screenshot: async (opts) => {
      shots.push(opts.clip);
      return o.shot(opts.clip);
    },
    close: async () => {
      closed.n++;
    },
  };
  return { page, closed, shots };
}
function publisher() {
  const published: { name: string; type: string; data: Uint8Array }[] = [];
  return {
    published,
    publish: async (data: Uint8Array, name: string, type: string) => {
      published.push({ name, type, data });
      return { id: `id-${published.length}`, sha256: sha(data) };
    },
  };
}
const opts = (pub: ReturnType<typeof publisher>, over: Record<string, unknown> = {}) => ({
  url: "https://example.test/a",
  maxBytes: 65536,
  deadlineMs: 5000,
  limits: LIMITS,
  settle: { pollMs: 1, stablePolls: 2, maxMs: 50 },
  worker: "w1",
  generation: 3,
  ...pub,
  ...over,
});

test("raw main-response entity, rendered DOM and DOM text are separate artifacts with their own hashes", async () => {
  const { page } = fakePage();
  const pub = publisher();
  const r = await captureBrowser(page, opts(pub));
  assert.deepEqual(
    pub.published.map((p) => p.name),
    ["browser-main-response", "browser-rendered-dom", "browser-dom-text", "browser-screenshot", "browser-navigation"],
  );
  assert.equal(sha(RAW) === sha(DOM), false);
  assert.deepEqual(r.rawBodyReport, { id: "id-1", sha256: sha(RAW) });
  assert.deepEqual(r.domReport, { id: "id-2", sha256: sha(DOM) });
  assert.deepEqual(r.textReport, { id: "id-3", sha256: sha(TEXT) });
  assert.deepEqual(r.navigationReport, { id: "id-5", sha256: sha(pub.published[4]!.data) });
  assert.deepEqual(Object.keys(r).sort(), [
    "contentType",
    "domReport",
    "finalUrl",
    "generation",
    "method",
    "navigationReport",
    "originalUrl",
    "rawBodyReport",
    "screenshotReport",
    "status",
    "textReport",
    "worker",
  ]);
  assert.equal(r.method, "browser");
  assert.equal(r.worker, "w1");
  assert.equal(r.generation, 3);
});

test("navigation report binds URLs, status, content type, every artifact hash, declared extraction and no truncation", async () => {
  const { page } = fakePage({ finalUrl: "https://example.test/final" });
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  const nav = JSON.parse(new TextDecoder().decode(pub.published[4]!.data));
  assert.equal(nav.originalUrl, "https://example.test/a");
  assert.equal(nav.finalUrl, "https://example.test/final");
  assert.equal(nav.status, 200);
  assert.equal(nav.contentType, "text/html; charset=utf-8");
  assert.equal(nav.rawBodyReport.sha256, sha(RAW));
  assert.equal(nav.domReport.sha256, sha(DOM));
  assert.equal(nav.textReport.sha256, sha(TEXT));
  assert.equal(nav.screenshotReport.sha256, sha(SHOT));
  assert.equal(nav.limits.truncated, false);
  assert.equal(nav.limits.maxBytes, 65536);
  assert.match(nav.rawBodySource, /entity-not-wire/);
  assert.equal(nav.extraction.source, "rendered-dom-innerText");
  assert.equal(nav.extraction.region, EXTRACTION_REGION_FALLBACK);
  assert.equal(nav.extraction.maxBytes, LIMITS.textMaxBytes);
  assert.equal(nav.extraction.truncated, false);
  assert.deepEqual(nav.actions, [
    { kind: "navigate", url: "https://example.test/a" },
    { kind: "navigation", url: "https://example.test/final" },
  ]);
  assert.ok(nav.limitations.length >= 2);
});

test("the navigation log states the region the page snapshot reported; an unreported region is the unrefined fallback", async () => {
  for (const region of EXTRACTION_REGIONS) {
    const { page } = fakePage({ region });
    const pub = publisher();
    await captureBrowser(page, opts(pub));
    assert.equal(JSON.parse(new TextDecoder().decode(pub.published[4]!.data)).extraction.region, region);
  }
  const { page } = fakePage();
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  assert.equal(JSON.parse(new TextDecoder().decode(pub.published[4]!.data)).extraction.region, EXTRACTION_REGION_FALLBACK);
});

test("a fallback snapshot's rejection reasons replace the generic limitation line, so the limitation count does not grow", async () => {
  const rejected = "tier_rejected: article=none main=none body=sliver(before=12345678,after=12345678)";
  const base = fakePage();
  const baseRun = publisher();
  await captureBrowser(base.page, opts(baseRun));
  const baseNav = JSON.parse(new TextDecoder().decode(baseRun.published[4]!.data));
  const { page } = fakePage({ rejected });
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  const nav = JSON.parse(new TextDecoder().decode(pub.published[4]!.data));
  assert.equal(nav.extraction.region, EXTRACTION_REGION_FALLBACK);
  assert.ok(nav.limitations.includes(`Unrefined region read; ${rejected}`));
  assert.equal(nav.limitations.length, baseNav.limitations.length);
  assert.ok(nav.limitations.every((l: string) => l.length <= 200));
});

test("live DOM text clipping preserves UTF-8 code points and reports exact retained bytes/hash", async () => {
  const raw = "あ".repeat(4000);
  const limits: CaptureLimits = { ...LIMITS, textMaxBytes: 8192 };
  const clipped = clipCapturedDomText(raw, limits.textMaxBytes);
  assert.equal(clipped.truncated, true);
  assert.equal(Buffer.byteLength(clipped.text), 8190);
  assert.doesNotMatch(clipped.text, /�/);
  assert.equal(clipCapturedDomText(`${"a".repeat(8191)} b`, limits.textMaxBytes).text, "a".repeat(8191), "clipped text remains trimmed canonical text");
  const { page } = fakePage({ text: raw });
  const pub = publisher();
  const receipt = await captureBrowser(page, opts(pub, { limits }));
  const retained = pub.published[2]!.data;
  assert.equal(Buffer.from(retained).toString(), clipped.text);
  assert.equal(receipt.textReport.sha256, sha(retained));
  const nav = JSON.parse(Buffer.from(pub.published[4]!.data).toString());
  assert.equal(nav.extraction.truncated, true);
  assert.equal(nav.extraction.maxBytes, 8192);
  assert.equal(nav.limits.screenshotBytes, 1048576);
  assert.ok(nav.limitations.some((v: string) => v.includes("clipped")));
});

test("screenshots above one MiB reject without truncating PNG or issuing a receipt", async () => {
  const { page } = fakePage();
  page.screenshot = async () => new Uint8Array(1048577);
  const pub = publisher();
  await assert.rejects(captureBrowser(page, opts(pub)), /exceeds byte bound/);
  assert.equal(pub.published.length, 0);
});

test("rejects a missing main response before any artifact is published", async () => {
  const { page } = fakePage({ response: null });
  const pub = publisher();
  await assert.rejects(captureBrowser(page, opts(pub)), /missing main response/);
  assert.equal(pub.published.length, 0);
});

// A main response with the given status and content type; the content-type header is absent when `type` is null.
function typedResponse(status: number, type: string | null) {
  return {
    body: async () => RAW,
    status: () => status,
    headerValue: async (n: string) => (n === "content-type" ? type : null),
  };
}

test("a main response without a content type (200 or non-2xx) is a missing response, never non_html", async () => {
  for (const status of [200, 204, 404, 502]) {
    const { page } = fakePage({ response: typedResponse(status, null) });
    const pub = publisher();
    await assert.rejects(captureBrowser(page, opts(pub)), (e: Error) => {
      assert.match(e.message, new RegExp(`missing main response content type \\(status ${status}\\)`));
      assert.doesNotMatch(e.message, /requires an HTML main response/);
      assert.equal(captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause, "no_response");
      return true;
    });
    assert.equal(pub.published.length, 0);
  }
});

test("a main response with a declared non-HTML content type stays non_html, whatever the status", async () => {
  for (const [status, type] of [
    [200, "application/pdf"],
    [404, "application/json"],
    [200, `text/html${";".repeat(200)}`],
  ] as const) {
    const { page } = fakePage({ response: typedResponse(status, type) });
    const pub = publisher();
    await assert.rejects(captureBrowser(page, opts(pub)), (e: Error) => {
      assert.match(e.message, /requires an HTML main response/);
      assert.equal(captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause, "non_html");
      return true;
    });
    assert.equal(pub.published.length, 0);
  }
});

test("rejects a declared main response above the allocation ceiling before reading the body", async () => {
  let read = false;
  const { page } = fakePage({
    response: {
      body: async () => {
        read = true;
        return RAW;
      },
      status: () => 200,
      headerValue: async (n: string) => (n === "content-length" ? String(LIMITS.rawAllocationMaxBytes + 1) : n === "content-type" ? "text/html" : null),
    },
  });
  const pub = publisher();
  await assert.rejects(captureBrowser(page, opts(pub)), /exceeds capture bound/);
  assert.equal(read, false);
  assert.equal(pub.published.length, 0);
});

test("raw body and DOM above maxBytes are clipped, recorded, and hashed as retained", async () => {
  const big = new TextEncoder().encode(`<html>${"é".repeat(1500)}</html>`);
  const { page } = fakePage({ raw: big, dom: big, contentLength: String(big.byteLength) });
  const pub = publisher();
  const receipt = await captureBrowser(page, opts(pub, { maxBytes: 1001 }));
  const [rawPub, domPub] = [pub.published[0]!.data, pub.published[1]!.data];
  assert.equal(rawPub.byteLength, 1001); // raw bytes are clipped exactly (not necessarily UTF-8)
  assert.equal(domPub.byteLength, 1000); // DOM is UTF-8 text: 1001 would split an "é"
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(domPub).length > 0, true);
  assert.equal(receipt.rawBodyReport.sha256, sha(rawPub));
  assert.equal(receipt.domReport.sha256, sha(domPub));
  const nav = JSON.parse(Buffer.from(pub.published[4]!.data).toString());
  assert.equal(nav.limits.rawBodyTruncated, true);
  assert.equal(nav.limits.domTruncated, true);
  assert.equal(nav.limits.rawBodyBytes, big.byteLength);
  assert.equal(nav.limits.truncated, false); // text-report flag only: unchanged contract with the host validator
  assert.ok(nav.limitations.some((v: string) => /^raw body clipped/.test(v)));
  assert.ok(nav.limitations.some((v: string) => /^DOM clipped/.test(v)));
  assert.ok(nav.limitations.every((v: string) => v.length <= 300) && nav.limitations.length <= 10);
});

test("a body within maxBytes records no raw or DOM clip", async () => {
  const { page } = fakePage();
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  const nav = JSON.parse(Buffer.from(pub.published[4]!.data).toString());
  assert.equal(nav.limits.rawBodyTruncated, false);
  assert.equal(nav.limits.domTruncated, false);
  assert.ok(!nav.limitations.some((v: string) => /clipped to/.test(v)));
});

test("clipBytes keeps whole UTF-8 sequences and leaves short input untouched", () => {
  const b = new TextEncoder().encode("a€b"); // 61 e2 82 ac 62
  assert.deepEqual([...clipBytes(b, 3).data], [0x61]);
  assert.deepEqual([...clipBytes(b, 4).data], [0x61, 0xe2, 0x82, 0xac]);
  assert.equal(clipBytes(b, 5).truncated, false);
});

test("clipRawBytes cuts exactly at max even when the bytes are not UTF-8 (windows-1252 0x91-0x94, 0x85, 0xA0)", () => {
  const b = new Uint8Array(105).fill(0x91);
  const raw = clipRawBytes(b, 100);
  assert.equal(raw.data.byteLength, 100);
  assert.equal(raw.truncated, true);
  assert.equal(clipRawBytes(b, 105).truncated, false);
});

test("clipBytes backs up at most 3 bytes, even through a run of stray continuation bytes (negative: unbounded retreat)", () => {
  const b = new Uint8Array(105).fill(0x91);
  const r = clipBytes(b, 100);
  assert.ok(r.data.byteLength >= 100 - CLIP_UTF8_MAX_BACKOFF, `kept ${r.data.byteLength}`);
  const four = new TextEncoder().encode("a😀b"); // 61 f0 9f 98 80 62
  assert.deepEqual([...clipBytes(four, 3).data], [0x61]);
  assert.deepEqual([...clipBytes(four, 4).data], [0x61]);
  assert.equal(clipBytes(four, 5).data.byteLength, 5);
  const euro = new TextEncoder().encode("ab€cd");
  assert.deepEqual([...clipBytes(euro, 4).data], [0x61, 0x62]);
});

test("the exported settle bounds are the real maximum of the default settle wait", async () => {
  let polls = 0;
  const r = await settleSample(
    async () => polls++,
    (n) => n,
    DEFAULT_SETTLE,
    async () => {},
  );
  assert.equal(r.polls, BROWSER_SETTLE_POLLS_MAX);
  assert.equal(r.waitedMs, BROWSER_SETTLE_WAIT_MAX_MS);
  assert.equal(BROWSER_SETTLE_POLLS_MAX, 21);
});

test("whitespace-only text is not settled content", async () => {
  const { page } = fakePage({ text: " \n\t  " });
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  const nav = JSON.parse(Buffer.from(pub.published[4]!.data).toString());
  assert.equal(nav.extraction.settle.settled, false);
});

test("a path or origin change during settle fails the capture; a query or fragment change does not", async () => {
  for (const settledUrl of ["https://example.test/consent", "https://other.test/a"]) {
    const { page } = fakePage({ settledUrl });
    const pub = publisher();
    await assert.rejects(captureBrowser(page, opts(pub)), /final URL changed during settle/, settledUrl);
    assert.equal(pub.published.length, 0);
  }
  const { page } = fakePage({ settledUrl: "https://example.test/a?x=1#frag" });
  await captureBrowser(page, opts(publisher()));
});

test("a publisher receipt whose hash differs from the published bytes is rejected", async () => {
  const { page } = fakePage();
  await assert.rejects(captureBrowser(page, { ...opts(publisher()), publish: async () => ({ id: "x", sha256: "0".repeat(64) }) }), /hash mismatch/);
});

test("the deadline rejects a hung navigation and closes the page", async () => {
  const { page, closed } = fakePage({ hang: true });
  const pub = publisher();
  await assert.rejects(captureBrowser(page, opts(pub, { deadlineMs: 1000 })), /browser capture deadline/);
  assert.equal(closed.n, 1);
  assert.equal(pub.published.length, 0);
});

test("explicit byte, deadline and identity bounds are mandatory", async () => {
  const { page } = fakePage();
  const bad: Record<string, unknown>[] = [
    { maxBytes: 0 },
    { maxBytes: 1048577 },
    { maxBytes: 1.5 },
    { deadlineMs: 999 },
    { deadlineMs: 120001 },
    { worker: "" },
    { generation: -1 },
    { generation: Number.NaN },
  ];
  for (const over of bad) await assert.rejects(captureBrowser(page, opts(publisher(), over)), /explicit capture/, JSON.stringify(over));
});

test("captureUrl admits only credential-free bounded HTTP(S) URLs", () => {
  assert.equal(captureUrl("https://example.test/a?b=1"), "https://example.test/a?b=1");
  assert.throws(() => captureUrl("file:///etc/passwd"), /credential-free/);
  assert.throws(() => captureUrl("https://user:pw@example.test/"), /credential-free/);
  assert.throws(() => captureUrl(`https://example.test/${"a".repeat(4100)}`), /credential-free/);
});

test("a final URL that leaves HTTP(S) rejects the capture", async () => {
  const { page } = fakePage({ finalUrl: "about:blank" });
  await assert.rejects(captureBrowser(page, opts(publisher())), /credential-free/);
});

test("normalizeCapturedDomText collapses whitespace and trims", () => {
  assert.equal(normalizeCapturedDomText("  a \n\t b  \u00a0c  "), "a b c");
  assert.equal(normalizeCapturedDomText(" \n "), "");
});

test("parseReportPublishJson keeps only id and sha256 and rejects a missing id or a hash mismatch", () => {
  const good = sha(RAW);
  assert.deepEqual(parseReportPublishJson(JSON.stringify({ id: "rep-1", sha256: good, name: "x", sizeBytes: 3 }), good), { id: "rep-1", sha256: good });
  assert.throws(() => parseReportPublishJson(JSON.stringify({ id: "", sha256: good }), good), /receipt mismatch/);
  assert.throws(() => parseReportPublishJson(JSON.stringify({ sha256: good }), good), /receipt mismatch/);
  assert.throws(() => parseReportPublishJson(JSON.stringify({ id: "rep-1", sha256: "0".repeat(64) }), good), /receipt mismatch/);
  assert.throws(() => parseReportPublishJson("not json", good), SyntaxError);
});

const instant = async () => {};
const seq = <T>(...xs: T[]) => {
  let i = 0;
  return async () => xs[Math.min(i++, xs.length - 1)] as T;
};

test("settleSample waits through an empty then growing page and stops once the length is stable", async () => {
  const r = await settleSample(
    seq("", "", "abc", "abcdef", "abcdef", "abcdef", "never"),
    (s) => s.length,
    { pollMs: 100, stablePolls: 2, maxMs: 5000 },
    instant,
  );
  assert.deepEqual(r, { sample: "abcdef", settled: true, polls: 6, waitedMs: 500 });
});

test("settleSample returns immediately-stable content after the minimum stable polls", async () => {
  const r = await settleSample(seq("text"), (s) => s.length, { pollMs: 250, stablePolls: 2, maxMs: 5000 }, instant);
  assert.deepEqual({ settled: r.settled, polls: r.polls, waitedMs: r.waitedMs }, { settled: true, polls: 3, waitedMs: 500 });
});

test("settleSample is bounded: a page that stays empty or keeps changing ends at maxMs with settled=false", async () => {
  const empty = await settleSample(seq(""), (s) => s.length, { pollMs: 250, stablePolls: 2, maxMs: 1000 }, instant);
  assert.deepEqual({ settled: empty.settled, polls: empty.polls, waitedMs: empty.waitedMs }, { settled: false, polls: 5, waitedMs: 1000 });
  let n = 0;
  const churn = await settleSample(
    async () => "x".repeat(++n),
    (s) => s.length,
    { pollMs: 250, stablePolls: 2, maxMs: 1000 },
    instant,
  );
  assert.deepEqual({ settled: churn.settled, waitedMs: churn.waitedMs, sample: churn.sample.length }, { settled: false, waitedMs: 1000, sample: 5 });
});

test("captureBrowser snapshots the settled text of a JS-rendered page and records the settle outcome", async () => {
  const { page } = fakePage();
  const texts = ["", "", "rendered later", "rendered later", "rendered later"];
  let i = 0;
  page.evaluate = async () => ({ dom: "<html><body>x</body></html>", text: texts[Math.min(i++, texts.length - 1)]! });
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  const text = pub.published.find((p) => p.name === "browser-dom-text")!;
  assert.equal(new TextDecoder().decode(text.data), "rendered later");
  const nav = JSON.parse(new TextDecoder().decode(pub.published.find((p) => p.name === "browser-navigation")!.data));
  assert.equal(nav.extraction.settle.settled, true);
  assert.equal(nav.extraction.settle.polls, 5);
});

test("a page that never renders text is captured with settled=false and a limitation", async () => {
  const { page } = fakePage({ text: "" });
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  const nav = JSON.parse(new TextDecoder().decode(pub.published.find((p) => p.name === "browser-navigation")!.data));
  assert.equal(nav.extraction.settle.settled, false);
  assert.ok(nav.limitations.some((l: string) => l.includes("had not stabilized")));
});

// A PNG the size of the viewport's bytes-per-row times the clip height, with a scripted viewport size, so each fallback region is predictable.
const scaledShot = (viewportBytes: number) => (clip: ScreenshotClip | undefined) =>
  new Uint8Array(clip ? Math.ceil((viewportBytes * clip.height) / BROWSER_VIEWPORT.height) : viewportBytes);
const navigationLog = (pub: ReturnType<typeof publisher>) =>
  JSON.parse(new TextDecoder().decode(pub.published.find((p) => p.name === "browser-navigation")!.data)) as {
    limitations: string[];
    limits: Record<string, unknown>;
    extraction: { truncated: boolean; maxBytes: number };
    screenshotReport: unknown;
  };

test("a viewport PNG within the bound is taken once, unclipped, with no screenshot limitation", async () => {
  const { page, shots } = fakePage();
  const pub = publisher();
  await captureBrowser(page, opts(pub));
  assert.deepEqual(shots, [undefined]);
  const log = navigationLog(pub);
  assert.ok(!log.limitations.some((l) => /screenshot reduced/.test(l)));
  assert.equal("screenshotClip" in log.limits, false);
});

test("a viewport PNG slightly over the bound is retaken as the top half of the viewport and the reduction is recorded", async () => {
  const viewportBytes = 1_091_012; // the live oversize case
  const { page, shots } = fakePage({ shot: scaledShot(viewportBytes) });
  const pub = publisher();
  const r = await captureBrowser(page, opts(pub));
  const half = { x: 0, y: 0, width: BROWSER_VIEWPORT.width, height: BROWSER_VIEWPORT.height / 2 };
  assert.deepEqual(shots, [undefined, half]);
  const shot = pub.published.find((p) => p.name === "browser-screenshot")!;
  assert.equal(shot.type, "image/png");
  assert.ok(shot.data.byteLength <= BROWSER_SCREENSHOT_MAX_BYTES);
  assert.deepEqual(r.screenshotReport, { id: "id-4", sha256: sha(shot.data) });
  const log = navigationLog(pub);
  assert.deepEqual(log.screenshotReport, r.screenshotReport);
  assert.deepEqual(log.limits.screenshotClip, half);
  assert.equal(log.limits.viewportScreenshotBytes, viewportBytes);
  assert.equal(log.limits.screenshotBytes, BROWSER_SCREENSHOT_MAX_BYTES);
  const note = log.limitations.find((l) => /screenshot reduced/.test(l));
  assert.equal(
    note,
    `screenshot reduced to the top 1280x360 px of the 1280x720 viewport: the viewport PNG was ${viewportBytes} bytes, over the ${BROWSER_SCREENSHOT_MAX_BYTES}-byte bound`,
  );
  // The host verifier accepts at most 10 limitations of at most 300 characters each.
  assert.ok(log.limitations.length <= 10 && log.limitations.every((l) => l.length <= 300));
});

test("the fallback steps down to the top quarter, and only a quarter still over the bound fails the capture as bound", async () => {
  const quarter = fakePage({ shot: scaledShot(3 * BROWSER_SCREENSHOT_MAX_BYTES) });
  const pub = publisher();
  await captureBrowser(quarter.page, opts(pub));
  assert.deepEqual(
    quarter.shots.map((c) => c?.height),
    [undefined, 360, 180],
  );
  assert.deepEqual(navigationLog(pub).limits.screenshotClip, { x: 0, y: 0, width: 1280, height: 180 });
  const huge = fakePage({ shot: scaledShot(5 * BROWSER_SCREENSHOT_MAX_BYTES) });
  const none = publisher();
  await assert.rejects(captureBrowser(huge.page, opts(none)), /capture screenshot exceeds byte bound/);
  assert.equal(huge.shots.length, 3);
  assert.equal(none.published.length, 0);
});

test("publishArgv pins the report publish flags and key placement", () => {
  assert.deepEqual(publishArgv("/tmp/f", "n.png", "image/png", "k:1"), [
    "report",
    "publish",
    "/tmp/f",
    "--name",
    "n.png",
    "--media-type",
    "image/png",
    "--key",
    "k:1",
    "--json",
  ]);
});

test("screenshot fallback heights are the top half and top quarter of the viewport", () => {
  assert.deepEqual([...BROWSER_SCREENSHOT_FALLBACK_HEIGHTS], [360, 180]);
});

// Phase 2 moved the capture's bounds from literals to the delivered config. At the registry defaults they are exactly the old
// constants (BROWSER_SCREENSHOT_MAX_BYTES 1024 ** 2, BROWSER_RAW_ALLOCATION_CEILING 8 * 1024 ** 2, the `maxBytes > 1024 ** 2` ceiling and
// the 1000..120000 deadline literals), except the text bound: article paging raised it from 8192 to 1 MiB (the analyst reads it in pages).
test("the default capture limits equal the constants they replaced", () => {
  assert.deepEqual(LIMITS, {
    maxBytesCeiling: 1024 ** 2,
    rawAllocationMaxBytes: 8 * 1024 ** 2,
    textMaxBytes: 1024 ** 2,
    screenshotMaxBytes: 1024 ** 2,
    deadlineMinMs: 1000,
    deadlineMaxMs: 120000,
  });
});

test("non-default limits drive the text clip, the recorded limits and the limitation text", async () => {
  const limits: CaptureLimits = { ...LIMITS, textMaxBytes: 4096, screenshotMaxBytes: 524288 };
  const { page } = fakePage({ text: "a ".repeat(5000) });
  const pub = publisher();
  await captureBrowser(page, opts(pub, { limits }));
  assert.equal(pub.published[2]!.data.byteLength, 4096 - 1, "the clip ends on a whole word after trimEnd");
  const nav = JSON.parse(new TextDecoder().decode(pub.published[4]!.data));
  assert.equal(nav.extraction.maxBytes, 4096);
  assert.equal(nav.limits.textBytes, 4096);
  assert.equal(nav.limits.screenshotBytes, 524288);
  assert.ok(
    nav.limitations.includes(
      "DOM text clipped at a complete UTF-8 code point to at most 4096 bytes (browser.capture.textMaxBytes); retained text report contains exactly the clipped bytes",
    ),
  );
});

test("the limitation text for a clipped DOM names the bound's registry key", async () => {
  const { page } = fakePage({ text: "b".repeat(9000) });
  const pub = publisher();
  await captureBrowser(page, opts(pub, { limits: { ...LIMITS, textMaxBytes: 8192 } }));
  assert.ok(
    navigationLog(pub).limitations.includes(
      "DOM text clipped at a complete UTF-8 code point to at most 8192 bytes (browser.capture.textMaxBytes); retained text report contains exactly the clipped bytes",
    ),
  );
});

test("maxBytes, deadline and allocation bounds follow the limits, not literals", async () => {
  const limits: CaptureLimits = { ...LIMITS, maxBytesCeiling: 2048, deadlineMinMs: 2000, deadlineMaxMs: 3000, rawAllocationMaxBytes: 4096 };
  const { page } = fakePage();
  await captureBrowser(page, opts(publisher(), { limits, maxBytes: 2048, deadlineMs: 3000 }));
  for (const over of [{ maxBytes: 2049 }, { deadlineMs: 1999 }, { deadlineMs: 3001 }])
    await assert.rejects(
      captureBrowser(fakePage().page, opts(publisher(), { limits, maxBytes: 2048, deadlineMs: 2000, ...over })),
      /explicit capture/,
      JSON.stringify(over),
    );
  const big = fakePage({ contentLength: "4097" });
  await assert.rejects(captureBrowser(big.page, opts(publisher(), { limits, maxBytes: 2048, deadlineMs: 2000 })), /exceeds capture bound/);
  // A raised ceiling admits what the default refuses.
  await captureBrowser(fakePage().page, opts(publisher(), { limits: { ...LIMITS, maxBytesCeiling: 2 * 1024 ** 2 }, maxBytes: 2 * 1024 ** 2 }));
});

test("a non-integer or non-positive limit is refused rather than read as unbounded", async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5, -1])
    for (const key of Object.keys(LIMITS) as (keyof CaptureLimits)[])
      await assert.rejects(captureBrowser(fakePage().page, opts(publisher(), { limits: { ...LIMITS, [key]: bad } })), /capture limits/, `${key}=${bad}`);
});

test("text beyond the default stored bound is clipped to it, marked truncated and names browser.capture.textMaxBytes; text within it is stored whole", async () => {
  const whole = `${"word ".repeat(300_000)}`.trim();
  assert.ok(Buffer.byteLength(whole) > LIMITS.textMaxBytes);
  const over = fakePage({ text: whole });
  const overPub = publisher();
  await captureBrowser(over.page, opts(overPub));
  assert.ok(overPub.published[2]!.data.byteLength <= LIMITS.textMaxBytes);
  assert.ok(overPub.published[2]!.data.byteLength > LIMITS.textMaxBytes - 8, "the stored text is the clipped whole, not a short excerpt");
  const overNav = navigationLog(overPub);
  assert.equal(overNav.extraction.truncated, true);
  assert.equal(overNav.extraction.maxBytes, LIMITS.textMaxBytes);
  assert.ok(overNav.limitations.some((v: string) => v.includes("clipped") && v.includes("browser.capture.textMaxBytes")));
  const within = "word ".repeat(100_000).trim();
  const fit = fakePage({ text: within });
  const fitPub = publisher();
  await captureBrowser(fit.page, opts(fitPub));
  assert.equal(Buffer.from(fitPub.published[2]!.data).toString(), within);
  assert.equal(navigationLog(fitPub).extraction.truncated, false);
});

// The 2026-10-23 StartEngine run (a domain example's live report): a timeout kill, a deadline overrun and a challenge reload.
const htmlResponse = (raw: Uint8Array, headers: Record<string, string> = {}) => ({
  body: async () => raw,
  status: () => 200,
  headerValue: async (name: string) => (name === "content-type" ? "text/html" : (headers[name] ?? null)),
});
const DESTROYED = "page.evaluate: Execution context was destroyed, most likely because of a navigation";
const TOKEN_SCRIPT = new TextEncoder().encode(
  '<html><head><script src="https://abc123.edge.token.awswaf.com/abc123/challenge.js"></script></head><body></body></html>',
);
const causeOfError = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => assert.fail("capture should fail"),
    (e: Error) => e,
  );
  return captureFailureDiagnostic({ code: 1, stderr: err.message }, {}).cause;
};

test("a navigation after load (evaluate's context destroyed) fails as navigation_changed, never other, and publishes nothing", async () => {
  const { page } = fakePage();
  page.evaluate = async () => {
    throw new Error(DESTROYED);
  };
  const pub = publisher();
  assert.equal(await causeOfError(captureBrowser(page, opts(pub))), "navigation_changed");
  assert.equal(pub.published.length, 0);
  // Playwright's own wording alone classifies the same way (a failure outside the settle wait).
  assert.equal(captureFailureDiagnostic({ code: 1, stderr: DESTROYED }, {}).cause, "navigation_changed");
});

test("bot challenges: a challenge header or interstitial marker stops the capture as bot_challenge before anything is published", async () => {
  const cases: [Uint8Array, Record<string, string>][] = [
    [RAW, { "x-amzn-waf-action": "challenge" }],
    [RAW, { "cf-mitigated": "challenge" }],
    [RAW, { "x-amzn-waf-action": "captcha" }],
    [new TextEncoder().encode("<html><script>window.gokuProps = {};</script><div id='challenge-container'></div></html>"), {}],
    [new TextEncoder().encode('<html><script src="https://x.captcha.awswaf.com/x/captcha.js"></script></html>'), {}],
    [new TextEncoder().encode("<html><head><title>Just a moment...</title></head></html>"), {}],
    [new TextEncoder().encode('<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>'), {}],
  ];
  for (const [raw, headers] of cases) {
    const { page } = fakePage({ response: htmlResponse(raw, headers) });
    const pub = publisher();
    await assert.rejects(captureBrowser(page, opts(pub)), /served a bot challenge \(marker=[a-z-]+\); it is not solved or bypassed/);
    assert.equal(await causeOfError(captureBrowser(fakePage({ response: htmlResponse(raw, headers) }).page, opts(pub))), "bot_challenge");
    assert.equal(pub.published.length, 0);
  }
});

test("the AWS WAF token script is a challenge when the page then navigates or renders no text; on a page with content it is captured", async () => {
  const reloading = fakePage({ response: htmlResponse(TOKEN_SCRIPT) }).page;
  reloading.evaluate = async () => {
    throw new Error(DESTROYED);
  };
  assert.equal(await causeOfError(captureBrowser(reloading, opts(publisher()))), "bot_challenge");
  const redirected = fakePage({ response: htmlResponse(TOKEN_SCRIPT), settledUrl: "https://example.test/listing" }).page;
  assert.equal(await causeOfError(captureBrowser(redirected, opts(publisher()))), "bot_challenge");
  const empty = fakePage({ response: htmlResponse(TOKEN_SCRIPT), text: "" }).page;
  assert.equal(await causeOfError(captureBrowser(empty, opts(publisher()))), "bot_challenge");
  // Negative: a header that names no challenge action is not one (a fake or proxy that answers every header name).
  await captureBrowser(fakePage({ response: htmlResponse(RAW, { "x-amzn-waf-action": "text/html", "cf-mitigated": "text/html" }) }).page, opts(publisher()));
  // Negative: a site using the WAF SDK on an ordinary, rendered page is not refused.
  const pub = publisher();
  await captureBrowser(fakePage({ response: htmlResponse(TOKEN_SCRIPT) }).page, opts(pub));
  assert.equal(pub.published.length, 5);
});

test("the deadline holds from deadlineAt, not from when the page work starts", async () => {
  const { page } = fakePage({ hang: true });
  const started = Date.now();
  await assert.rejects(captureBrowser(page, opts(publisher(), { deadlineMs: 5000, deadlineAt: started + 100 })), /browser capture deadline/);
  assert.ok(Date.now() - started < 1000, `ended after ${Date.now() - started} ms`);
});

test("runCaptureProcess ends within deadline + teardown slack even when the context close hangs", async () => {
  const { page } = fakePage({ hang: true });
  let closes = 0;
  const started = Date.now();
  const open = async () => ({
    page,
    close: () => {
      closes++;
      return new Promise<void>(() => {});
    },
  });
  await assert.rejects(runCaptureProcess(open, opts(publisher(), { deadlineMs: 1000 }), 200), /browser capture deadline/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1000 && elapsed < 1000 + 200 + 300, `ended after ${elapsed} ms`);
  assert.equal(closes, 1);
  assert.equal(CAPTURE_TEARDOWN_MS, 2000);
});

test("runCaptureProcess counts browser attach against the deadline and closes a session that opens late", async () => {
  const { page } = fakePage();
  let closes = 0;
  const started = Date.now();
  const open = () =>
    new Promise<CaptureSession>((resolve) =>
      setTimeout(
        () =>
          resolve({
            page,
            close: async () => {
              closes++;
            },
          }),
        1300,
      ),
    );
  await assert.rejects(runCaptureProcess(open, opts(publisher(), { deadlineMs: 1000 }), 200), /browser capture deadline/);
  assert.ok(Date.now() - started < 1250, `ended after ${Date.now() - started} ms`);
  await new Promise((r) => setTimeout(r, 600)); // the session opens at 1300 ms
  assert.equal(closes, 1);
  // An on-time session is captured, then closed.
  const ok = fakePage();
  let okCloses = 0;
  const receipt = await runCaptureProcess(
    async () => ({
      page: ok.page,
      close: async () => {
        okCloses++;
      },
    }),
    opts(publisher()),
  );
  assert.equal(receipt.finalUrl, "https://example.test/a");
  assert.equal(okCloses, 1);
});
