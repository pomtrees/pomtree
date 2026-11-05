import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ARTICLE_STATUSES,
  ARTICLE_THIN_TEXT,
  LIMITATION_MAX,
  type ArticleEvidence,
  type ArticleInput,
  type ArticleStatus,
  type BoundDetail,
  boundSentence,
  buildArticleTask,
  CAPTURE_BYTES_MAX,
  CAPTURE_CAUSES,
  CAPTURE_REASONS,
  CAPTURE_STATUSES,
  type CaptureStatus,
  type CaptureSummary,
  type DetailedCapture,
  captureStaticArticle,
  captureStaticArticleDetailed,
  captureSummaryOf,
  challengeMarker,
  checkPublicUrl,
  extractArticleText,
  interruptedArticleEvidence,
  validateArticleEvidence,
  validateArticleInput,
  validateCaptureSummary,
} from "./article.mts";
import { DEFAULT_CONTENT_BOUNDS as BOUNDS } from "./content-bounds.mts";

const fixture = (name: string): string => readFileSync(new URL(`./content-fixtures/${name}`, import.meta.url), "utf8");
// Extra article paragraph (also the final paragraph of the positive fixture) used where a test builds its own page.
const PAD =
  "The remaining paragraph restates the central claim: a ledger of attempts, checked against the source count, makes silent loss visible. Operators can then audit every run.";
const POSITIVE = fixture("article-positive.html");
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const INPUT: ArticleInput = { storyId: 101, url: "https://example.com/post", itemHash: "b".repeat(64), maxBytes: 65536 };
// What the verifier hands on after retaining the text report: the evidence carries the report ref, whose sha256 is the textHash.
const retained = (ev: ArticleEvidence): ArticleEvidence => (ev.textHash === null ? ev : { ...ev, textReport: { id: "text", sha256: ev.textHash } });
const HTML = { status: 200, contentType: "text/html; charset=utf-8" };
const respond = (body: string, over: Partial<{ status: number; contentType: string; maxBytes: number }> = {}) => ({
  status: over.status ?? HTML.status,
  body,
  sha256: sha(body),
  contentType: over.contentType ?? HTML.contentType,
});
const POSITIVE_PARAGRAPHS = [
  "Why reliable batch systems fail quietly",
  "Most batch pipelines do not crash. They finish, report success, and quietly drop a small share of their records.",
  "The authors traced the losses to retries that reuse stale cursors, so later pages overwrite earlier ones without an error.",
  "Their remedy is an append-only ledger of attempts, checked against the source count at the end of every run.",
];

describe("validateArticleInput and checkPublicUrl", () => {
  it("accepts a plain public https URL and returns it canonicalized", () => {
    const r = validateArticleInput({ ...INPUT, url: "HTTPS://Example.COM/post" }, BOUNDS);
    assert.deepEqual(r, { ok: true, value: { ...INPUT, url: "https://example.com/post" } });
  });

  it("rejects credentials, loopback, private, link-local, CGNAT, IP literals, single labels and local names", () => {
    const bad = [
      "https://user:pw@example.com/",
      "https://user@example.com/",
      "http://localhost/x",
      "http://app.localhost/x",
      "http://127.0.0.1/",
      "http://10.1.2.3/",
      "http://192.168.0.5/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://8.8.8.8/",
      "http://intranet/",
      "http://box.internal/",
      "http://printer.local/",
      "ftp://example.com/a",
      "file:///etc/passwd",
      "http://example.com:8080/",
      "https://example.com/a b",
      "https://example.com/\u0007",
      "",
      "not a url",
    ];
    for (const url of bad) assert.equal(checkPublicUrl(url).ok, false, url);
  });

  it("rejects invalid input fields", () => {
    assert.equal(validateArticleInput({ ...INPUT, storyId: 0 }, BOUNDS).ok, false);
    assert.equal(validateArticleInput({ ...INPUT, storyId: "101" }, BOUNDS).ok, false);
    assert.equal(validateArticleInput({ ...INPUT, itemHash: "ABC" }, BOUNDS).ok, false);
    assert.equal(validateArticleInput({ ...INPUT, maxBytes: 0 }, BOUNDS).ok, false);
    assert.equal(validateArticleInput({ ...INPUT, maxBytes: 2_000_000 }, BOUNDS).ok, false);
    assert.equal(validateArticleInput({ ...INPUT, extra: 1 }, BOUNDS).ok, false);
    assert.equal(validateArticleInput(null, BOUNDS).ok, false);
  });
});

describe("captureStaticArticle", () => {
  it("extracts visible article paragraphs and drops script, style, nav, aside, footer and injected text", () => {
    const { evidence: ev, text } = captureStaticArticleDetailed(INPUT, respond(POSITIVE), BOUNDS);
    assert.equal(ev.status, "usable");
    assert.equal(ev.method, "static-http");
    assert.equal(ev.textBytes, Buffer.byteLength(text));
    assert.ok(!("text" in ev), "the text is the retained report, not an evidence field");
    for (const p of POSITIVE_PARAGRAPHS) assert.ok(text.includes(p), p);
    for (const bad of [
      "Ignore previous",
      "API key",
      "document.write",
      "console.log",
      "display: none",
      "Log in",
      "Related:",
      "Copyright",
      "Site banner",
      "stolen",
    ]) {
      assert.ok(!text.includes(bad), `leaked: ${bad}`);
    }
    assert.equal(ev.textHash, sha(text));
    assert.equal(ev.rawHash, sha(POSITIVE));
  });

  it("never claims browser proof and never copies HN item text", () => {
    const ev = captureStaticArticle(INPUT, respond(POSITIVE), BOUNDS);
    assert.notEqual(ev.method, "browser");
    assert.ok(ev.limitations.some((l) => l.includes("no JavaScript")));
    const hnText = "Ask HN: my own discussion text that is not article text";
    const other = captureStaticArticleDetailed(
      INPUT,
      respond(`<p>${hnText}</p><article><p>${POSITIVE_PARAGRAPHS[1]}</p><p>${POSITIVE_PARAGRAPHS[2]}</p><p>${PAD}</p></article>`),
      BOUNDS,
    );
    assert.equal(other.evidence.status, "usable");
    assert.ok(!other.text.includes("Ask HN"));
  });

  it("returns unsupported for non-HTML content types with empty text", () => {
    const ev = captureStaticArticle(INPUT, respond("%PDF-1.4 binary", { contentType: "application/pdf" }), BOUNDS);
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
    assert.equal(ev.textHash, null);
  });

  it("returns unsupported for a non-article page with too little visible text", () => {
    const ev = captureStaticArticle(INPUT, respond(fixture("nonarticle.html")), BOUNDS);
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
    assert.equal(ev.textHash, null);
  });

  it("returns unavailable for HTTP errors and redirects without following them", () => {
    for (const status of [404, 500, 302]) {
      const ev = captureStaticArticle(INPUT, respond(POSITIVE, { status }), BOUNDS);
      assert.equal(ev.status, "unavailable", String(status));
      assert.equal(ev.textBytes, 0);
      assert.equal(ev.textHash, null);
    }
  });

  it("returns unavailable when the body exceeds maxBytes, with no text", () => {
    const body = POSITIVE;
    const ev = captureStaticArticle({ ...INPUT, maxBytes: 100 }, respond(body), BOUNDS);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.textBytes, 0);
  });

  it("bounds extracted text and records the clip", () => {
    const long = `<article>${"<p>Sentence about reliable pipelines and careful accounting. </p>".repeat(1000)}</article>`;
    const small = { ...BOUNDS, articleTextMaxBytes: 8192 };
    const { evidence: ev, text } = captureStaticArticleDetailed({ ...INPUT, maxBytes: 1_048_576 }, respond(long), small);
    assert.equal(ev.status, "usable");
    assert.ok(Buffer.byteLength(text) <= small.articleTextMaxBytes);
    assert.equal(ev.textBytes, Buffer.byteLength(text));
    assert.ok(
      ev.limitations.some((l) => l.startsWith("text clipped") && l.includes("ext.hnDigest.articleTextMaxBytes")),
      "the clip names the bound's registry key",
    );
    assert.equal(validateArticleEvidence(retained(ev), INPUT, small).ok, true);
    // The text clip has its own field; `truncated` stays the raw body's.
    assert.deepEqual([ev.textTruncated, ev.truncated], [true, undefined]);
    assert.equal(captureStaticArticle(INPUT, respond(POSITIVE), BOUNDS).textTruncated, false);
    assert.equal(validateArticleEvidence({ ...retained(ev), textTruncated: "yes" }, INPUT, small).ok, false);
    const thin = captureStaticArticle(INPUT, respond("<article>short</article>"), BOUNDS);
    assert.equal(validateArticleEvidence({ ...thin, textTruncated: false }, INPUT, BOUNDS).ok, false, "only a usable capture carries textTruncated");
  });

  it("throws on an invalid envelope", () => {
    assert.throws(() => captureStaticArticle({ ...INPUT, url: "http://127.0.0.1/" }, respond("x"), BOUNDS), TypeError);
    assert.throws(() => captureStaticArticle(INPUT, { ...respond("x"), status: 700 }, BOUNDS), TypeError);
    assert.throws(() => captureStaticArticle(INPUT, { ...respond("x"), sha256: "XYZ" }, BOUNDS), TypeError);
    assert.throws(() => captureStaticArticle(INPUT, { ...respond("x"), sha256: "f".repeat(64) }, BOUNDS), /does not match captured body/);
    assert.throws(() => captureStaticArticle(INPUT, { ...respond("x"), body: 5 as unknown as string }, BOUNDS), TypeError);
  });

  it("interrupted evidence carries no hashes or text", () => {
    const ev = interruptedArticleEvidence(INPUT, "timeout after 30s");
    assert.equal(ev.status, "interrupted");
    assert.equal(ev.rawHash, null);
    assert.equal(ev.textHash, null);
    assert.equal(ev.textBytes, 0);
    assert.deepEqual(validateArticleEvidence(ev, INPUT, BOUNDS), { ok: true, value: ev });
  });
});

describe("validateArticleEvidence", () => {
  const good = (): ArticleEvidence => retained(captureStaticArticle(INPUT, respond(POSITIVE), BOUNDS));

  it("accepts captured evidence", () => {
    assert.deepEqual(validateArticleEvidence(good(), INPUT, BOUNDS), { ok: true, value: good() });
  });

  it("rejects an inline text field, a forged text hash and a textReport that is not the textHash", () => {
    const ev = good();
    assert.equal(validateArticleEvidence({ ...ev, text: "inline" }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, textHash: "c".repeat(64) }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, textReport: { id: "text", sha256: "c".repeat(64) } }, INPUT, BOUNDS).ok, false);
  });

  it("rejects usable evidence without a textReport (nothing to verify quotes against)", () => {
    const { textReport: _unused, ...unretained } = good();
    assert.equal(validateArticleEvidence(unretained, INPUT, BOUNDS).ok, false);
  });

  it("rejects stored text beyond the bound, and a textBytes that is not a positive integer", () => {
    assert.equal(validateArticleEvidence({ ...good(), textBytes: BOUNDS.articleTextMaxBytes + 1 }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...good(), textBytes: BOUNDS.articleTextMaxBytes }, INPUT, BOUNDS).ok, true);
    assert.equal(validateArticleEvidence({ ...good(), textBytes: 0 }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...good(), textBytes: 1.5 }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...good(), textBytes: undefined }, INPUT, BOUNDS).ok, false);
  });

  it("rejects missing hashes on usable evidence", () => {
    const ev = good();
    assert.equal(validateArticleEvidence({ ...ev, textHash: null }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, rawHash: null }, INPUT, BOUNDS).ok, false);
  });

  it("requires unsuccessful evidence to have zero textBytes and null textHash", () => {
    const ev = captureStaticArticle(INPUT, respond("%PDF", { contentType: "application/pdf" }), BOUNDS);
    assert.equal(validateArticleEvidence({ ...ev, textBytes: 6 }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, textHash: "d".repeat(64) }, INPUT, BOUNDS).ok, false);
  });

  it("binds story and URL to the expected input", () => {
    assert.equal(validateArticleEvidence(good(), { ...INPUT, storyId: 102 }, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence(good(), { ...INPUT, url: "https://example.com/other" }, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...good(), storyId: 999 }, INPUT, BOUNDS).ok, false);
  });

  it("rejects unknown keys, schema versions, unknown status or method, and bad hash shape", () => {
    const ev = good();
    assert.equal(validateArticleEvidence({ ...ev, extra: true }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, schema: "hn-article/2" }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, status: "ok" }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, method: "ftp" }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, rawHash: "ABC" }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence({ ...ev, limitations: "none" }, INPUT, BOUNDS).ok, false);
    assert.equal(validateArticleEvidence(null, INPUT, BOUNDS).ok, false);
  });

  it("requires retained body and action reports before accepting a browser method", () => {
    assert.equal(validateArticleEvidence({ ...good(), method: "browser" }, INPUT, BOUNDS).ok, false);
    const bodyReport = { id: "body", sha256: good().rawHash };
    const browserEvidence = { id: "navigation-actions", sha256: "d".repeat(64) };
    assert.equal(
      validateArticleEvidence(
        {
          ...good(),
          method: "browser",
          bodyReport,
          browserEvidence,
          domReport: bodyReport,
          textReport: { id: "text", sha256: good().textHash },
          screenshotReport: browserEvidence,
        },
        INPUT,
        BOUNDS,
      ).ok,
      true,
    );
    assert.equal(
      validateArticleEvidence({ ...good(), method: "browser", bodyReport, browserEvidence: { id: "x", sha256: "invalid" } }, INPUT, BOUNDS).ok,
      false,
    );
  });

  it("never accepts HN item text as article text: the evidence has no HN text field", () => {
    const ev = good();
    assert.equal(validateArticleEvidence({ ...ev, hnText: "Ask HN" }, INPUT, BOUNDS).ok, false);
  });
});

describe("truncated static capture", () => {
  const body = POSITIVE;
  const bytes = Buffer.byteLength(body);
  const fetchedAt = "2026-10-20T12:00:00.000Z";
  const LIMITATION = `article truncated at ${bytes} bytes (cap ${INPUT.maxBytes}); analysis covers the retained prefix only`;
  const truncatedMeta = { truncated: true, bytesRetained: bytes, bytesSeen: bytes + 4096, fetchedAt };

  it("adds one truncation limitation after the two fixed static limitations and copies the meta", () => {
    const ev = captureStaticArticle(INPUT, respond(body), BOUNDS, truncatedMeta);
    assert.equal(ev.status, "usable");
    assert.deepEqual(ev.limitations.slice(0, 3), [
      "static HTTP capture; no JavaScript was executed",
      "visible text only; images and media are not captured",
      LIMITATION,
    ]);
    assert.equal(ev.limitations.filter((l) => l.startsWith("article truncated")).length, 1);
    assert.equal(ev.truncated, true);
    assert.equal(ev.bytesRetained, bytes);
    assert.equal(ev.bytesSeen, bytes + 4096);
    assert.equal(ev.fetchedAt, fetchedAt);
  });

  it("adds no truncation fields or limitation when no truncation meta is given", () => {
    const ev = captureStaticArticle(INPUT, respond(body), BOUNDS);
    for (const key of ["truncated", "bytesRetained", "bytesSeen", "fetchedAt"]) assert.equal(key in ev, false);
    assert.equal(
      ev.limitations.some((l) => l.startsWith("article truncated")),
      false,
    );
  });

  it("validates and passes through the truncation fields", () => {
    const ev = retained(captureStaticArticle(INPUT, respond(body), BOUNDS, truncatedMeta));
    assert.deepEqual(validateArticleEvidence(ev, INPUT, BOUNDS), { ok: true, value: ev });
  });

  it("rejects malformed truncation fields", () => {
    const ev = retained(captureStaticArticle(INPUT, respond(body), BOUNDS, truncatedMeta));
    const bad: unknown[] = [
      { ...ev, fetchedAt: "2026-10-20" },
      { ...ev, fetchedAt: "2026-10-20T12:00:00Z" },
      { ...ev, fetchedAt: "not a date" },
      { ...ev, fetchedAt: 1 },
      { ...ev, bytesSeen: bytes - 1 },
      { ...ev, truncated: "yes" },
      { ...ev, bytesRetained: -1 },
      { ...ev, bytesRetained: 1.5 },
      { ...ev, bytesRetained: INPUT.maxBytes + 1, bytesSeen: INPUT.maxBytes + 2 },
      { ...ev, truncated: true, bytesRetained: undefined },
    ];
    for (const raw of bad) assert.equal(validateArticleEvidence(raw, INPUT, BOUNDS).ok, false, JSON.stringify(raw));
  });
});

describe("extractArticleText", () => {
  const READABLE = "Readable paragraph.";
  // GitHub-like chrome of roughly 750 characters, cut by a byte cap in the middle of a tag.
  const GITHUB_LIKE = `<html><head><title>owner/repo</title></head><body><header>${"Search&nbsp;&nbsp;Sign in&nbsp;".repeat(12)}</header><main><div class="Box">${"<span>Repository&nbsp;&nbsp;stars&nbsp;&nbsp;</span>".repeat(5)}<table><tr><td class="react-d`;

  it("drops a trailing unterminated tag at the end of the input", () => {
    for (const tail of ['<td class="react-d', "<scr", "</a", "<!", "<?xml", "<"]) {
      assert.equal(extractArticleText(`<p>${READABLE}</p>${tail}`, BOUNDS).text, READABLE, tail);
    }
  });

  it("leaves no comment or CDATA fragment when the input ends inside one", () => {
    for (const tail of ["<!-- unterminated comment <td", "<![CDATA[ unterminated", "<!-"]) {
      const { text } = extractArticleText(`<p>${READABLE}</p>${tail}`, BOUNDS);
      assert.equal(text, READABLE, tail);
      assert.ok(!text.includes("<!"), tail);
    }
  });

  it("never leaks script or style content, even when unterminated", () => {
    assert.ok(!extractArticleText(`<p>${READABLE}</p><script>var secret = 1;`, BOUNDS).text.includes("secret"));
    assert.ok(!extractArticleText(`<p>${READABLE}</p><style>.x{color:red}`, BOUNDS).text.includes("color"));
  });

  it("yields no tag fragments from a GitHub-like page truncated mid-tag", () => {
    const { text } = extractArticleText(GITHUB_LIKE, BOUNDS);
    assert.ok(GITHUB_LIKE.length >= 700 && GITHUB_LIKE.length <= 800, String(GITHUB_LIKE.length));
    assert.ok(!text.includes("<"), text);
    assert.ok(!text.includes("react-d"));
    assert.ok(!text.includes(" "));
    assert.ok(text.includes("Repository stars"));
  });

  it("converts NBSP and Unicode space separators to ordinary spaces", () => {
    assert.equal(extractArticleText("<p>alpha beta gamma delta　end one two</p>", BOUNDS).text, "alpha beta gamma delta end one two");
    for (let cp = 0x2000; cp <= 0x200a; cp++) {
      const c = String.fromCodePoint(cp);
      assert.equal(extractArticleText(`<p>a${c}b</p>`, BOUNDS).text, "a b", cp.toString(16));
    }
    assert.equal(extractArticleText("<p>a&nbsp;&nbsp;&nbsp;b   c</p>", BOUNDS).text, "a b c");
  });

  it("decodes supported named and numeric entities", () => {
    const { text } = extractArticleText(
      "<p>Tom &amp; Jerry &lt;3 &gt; &quot;quoted&quot; &#39;single&#39; &#x27;hex&#x27; &apos;apos&apos; a&nbsp;b</p>",
      BOUNDS,
    );
    assert.equal(text, `Tom & Jerry <3 > "quoted" 'single' 'hex' 'apos' a b`);
    assert.equal(extractArticleText("<p>&amp;lt;</p>", BOUNDS).text, "&lt;");
  });

  it("captured text containing NBSP is normalized and passes validateArticleEvidence", () => {
    const body = `<article><p>${"Long sentence of readable text.&nbsp;".repeat(14)}</p></article>`;
    const { evidence, text } = captureStaticArticleDetailed(INPUT, respond(body), BOUNDS);
    const ev = retained(evidence);
    assert.equal(ev.status, "usable");
    assert.ok(!text.includes(" "));
    assert.deepEqual(validateArticleEvidence(ev, INPUT, BOUNDS), { ok: true, value: ev });
  });
});

describe("thin article threshold", () => {
  const THIN = "too thin to ground: under 400 characters of readable text after extraction";

  it("sets the thin threshold to 400 characters", () => {
    assert.equal(ARTICLE_THIN_TEXT, 400);
  });

  it("returns unsupported with the thin limitation for 399 characters", () => {
    const ev = captureStaticArticle(INPUT, respond(`<article><p>${"a".repeat(399)}</p></article>`), BOUNDS);
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
    assert.equal(ev.textHash, null);
    assert.deepEqual(ev.limitations, [THIN]);
    assert.ok(THIN.length <= LIMITATION_MAX);
  });

  it("accepts exactly 400 characters", () => {
    const { evidence: ev, text } = captureStaticArticleDetailed(INPUT, respond(`<article><p>${"a".repeat(400)}</p></article>`), BOUNDS);
    assert.equal(ev.status, "usable");
    assert.equal(Array.from(text).length, 400);
  });

  it("returns unsupported for a page of only NBSP and markup", () => {
    const ev = captureStaticArticle(INPUT, respond("<article><p>&nbsp;</p><span>  </span><div>&nbsp;&nbsp;</div></article>"), BOUNDS);
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
  });

  it("treats a mid-tag-truncated GitHub-like page as thin, with no tag text", () => {
    const github = `<html><body><header>${"Search&nbsp;&nbsp;Sign in&nbsp;".repeat(12)}</header><main><div>${"<span>Repository&nbsp;&nbsp;stars&nbsp;&nbsp;</span>".repeat(5)}<table><tr><td class="react-d`;
    const ev = captureStaticArticle(INPUT, respond(github), BOUNDS);
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
    assert.deepEqual(ev.limitations, [THIN]);
    assert.ok(!extractArticleText(github, BOUNDS).text.includes("<"));
  });
});

describe("boilerplate heuristic", () => {
  const BIG_INPUT: ArticleInput = { ...INPUT, maxBytes: 1_048_576 };
  const WORDS = "Repository stars forks issues pull requests branches tags releases packages ";
  const words = (n: number): string => WORDS.repeat(Math.ceil(n / WORDS.length)).slice(0, n);
  // Pads with empty inline elements (no text) so the body reaches about the target byte size.
  const padded = (text: string, bytes: number): string => {
    const head = "<article><p>";
    const tail = "</p></article>";
    const fill = Math.max(0, Math.ceil((bytes - head.length - tail.length - Buffer.byteLength(text)) / "<span></span>".length));
    return `${head}${text}${"<span></span>".repeat(fill)}${tail}`;
  };

  it("treats a truncated GitHub-like page with about 700 characters in 262144 retained bytes as unsupported", () => {
    const body = padded(words(700), 262_144);
    const chars = Array.from(extractArticleText(body, BOUNDS).text).length;
    assert.ok(chars >= 600 && chars <= 800, String(chars));
    const ev = captureStaticArticle(BIG_INPUT, respond(body), BOUNDS, { truncated: true, bytesRetained: 262_144, bytesSeen: 300_000 });
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
    assert.equal(ev.textHash, null);
    assert.equal(ev.limitations[0], `page is mostly markup/boilerplate (${chars} chars of text in 262144 bytes)`);
    assert.ok((ev.limitations[0] ?? "").length <= LIMITATION_MAX);
    assert.ok(ev.limitations[1]?.startsWith("article truncated at 262144 bytes"));
  });

  it("keeps an ordinary short article usable", () => {
    const body = padded(words(500), 4000);
    assert.ok(Buffer.byteLength(body) < 5000);
    const ev = captureStaticArticle(INPUT, respond(body), BOUNDS);
    assert.equal(ev.status, "usable");
  });

  it("keeps a long article usable, untruncated or truncated at 5% text density", () => {
    const long = padded(words(15_000), 200_000);
    assert.equal(captureStaticArticle(BIG_INPUT, respond(long), BOUNDS).status, "usable");
    const dense = padded(words(10_000), 200_000);
    const ev = captureStaticArticle(BIG_INPUT, respond(dense), BOUNDS, { truncated: true, bytesRetained: 200_000, bytesSeen: 250_000 });
    assert.equal(ev.status, "usable");
  });

  it("flags an untruncated page with 600 characters in about 200000 bytes as unsupported", () => {
    const body = padded(words(600), 200_000);
    const chars = Array.from(extractArticleText(body, BOUNDS).text).length;
    const bytes = Buffer.byteLength(body);
    const ev = captureStaticArticle(BIG_INPUT, respond(body), BOUNDS);
    assert.equal(ev.status, "unsupported");
    assert.equal(ev.textBytes, 0);
    assert.deepEqual(ev.limitations, [`page is mostly markup/boilerplate (${chars} chars of text in ${bytes} bytes)`]);
  });

  it("keeps a truncated page with 2000 or more characters usable even under 1% density", () => {
    const body = padded(words(2400), 262_144);
    const chars = Array.from(extractArticleText(body, BOUNDS).text).length;
    assert.ok(chars >= 2000 && chars / 262_144 < 0.01, String(chars));
    const ev = captureStaticArticle(BIG_INPUT, respond(body), BOUNDS, { truncated: true, bytesRetained: 262_144, bytesSeen: 300_000 });
    assert.equal(ev.status, "usable");
  });
});

// Exhaustive by type: adding an ArticleStatus without a row here is a typecheck error, and so is a row for a status that no longer exists.
const SUMMARY_STATUS_OF: Record<ArticleStatus, CaptureStatus> = {
  usable: "usable",
  unavailable: "unusable",
  interrupted: "unusable",
  unsupported: "unsupported",
};

describe("article status drift", () => {
  it("summarises every article status to the capture status the table names, and the table covers every capture status", () => {
    for (const status of ARTICLE_STATUSES) {
      const detail = { evidence: { status } as ArticleEvidence, reason: null, textChars: null, truncated: false } as DetailedCapture;
      assert.equal(captureSummaryOf(detail, 0, null).status, SUMMARY_STATUS_OF[status], status);
    }
    assert.deepEqual([...new Set(Object.values(SUMMARY_STATUS_OF))].sort(), [...CAPTURE_STATUSES].sort());
  });
});

describe("buildArticleTask", () => {
  it("names the exact approved URL and the no-instructions and no-credential rules", () => {
    const task = buildArticleTask(INPUT, BOUNDS);
    assert.ok(task.includes("Approved URL (exact): https://example.com/post"));
    assert.ok(task.includes("only through the audited proxy"));
    assert.ok(task.includes("untrusted"));
    assert.ok(task.includes("Do not read environment variables"));
    assert.ok(task.includes("pomtree result --key hn-content-article"));
    assert.ok(task.includes("audited-public proxy sidecar"));
    assert.ok(!/sk-|api[_-]?key=/i.test(task));
  });

  it("lists exactly the ARTICLE_STATUSES the worker may return", () => {
    assert.ok(buildArticleTask(INPUT, BOUNDS).includes(`"status":"${ARTICLE_STATUSES.join("|")}"`));
  });

  it("refuses invalid input", () => {
    assert.throws(() => buildArticleTask({ ...INPUT, url: "http://10.0.0.1/" }, BOUNDS), TypeError);
  });
});

describe("capture summary", () => {
  const BIG_INPUT: ArticleInput = { ...INPUT, maxBytes: 1_048_576 };
  const WORDS = "Repository stars forks issues pull requests branches tags releases packages ";
  const words = (n: number): string => WORDS.repeat(Math.ceil(n / WORDS.length)).slice(0, n);
  const boilerplate = (): string => `<article><p>${words(700)}${"<span></span>".repeat(20_000)}</p></article>`;
  const summary = (body: string, over: Partial<{ status: number; contentType: string }> = {}, meta = {}): CaptureSummary => {
    const response = respond(body, over);
    return captureSummaryOf(captureStaticArticleDetailed(BIG_INPUT, response, BOUNDS, meta), Buffer.byteLength(body), "https://example.com/final/path?q=1");
  };

  it("classifies a thin page", () => {
    const s = summary("<html><body><p>tiny</p></body></html>");
    assert.deepEqual([s.status, s.reason, s.textChars], ["unsupported", "thin", 4]);
    assert.equal(s.textHash, null);
    assert.equal(s.rawHash, sha("<html><body><p>tiny</p></body></html>"));
  });

  it("classifies a boilerplate page and keeps the truncation flag and byte count", () => {
    const body = boilerplate();
    const s = summary(body, {}, { truncated: true, bytesRetained: Buffer.byteLength(body), bytesSeen: Buffer.byteLength(body) + 10 });
    assert.deepEqual([s.status, s.reason, s.truncated, s.bodyBytes], ["unsupported", "boilerplate", true, Buffer.byteLength(body)]);
    assert.ok((s.textChars ?? 0) >= 600);
  });

  it("classifies a non-HTML type, an oversize body and an HTTP error", () => {
    const pdf = summary("%PDF-1.7 binary", { contentType: "application/pdf" });
    assert.deepEqual([pdf.status, pdf.reason, pdf.textChars], ["unsupported", "non_html", null]);
    const bound = captureSummaryOf(captureStaticArticleDetailed({ ...INPUT, maxBytes: 5 }, respond("<html>abcdef</html>"), BOUNDS, {}), 19, null);
    assert.deepEqual([bound.status, bound.reason], ["unusable", "bound"]);
    const missing = summary("<html>gone</html>", { status: 404 });
    assert.deepEqual([missing.status, missing.reason], ["unusable", "fetch_error"]);
  });

  it("a static bound drop carries the limit, the observed size and one quotable sentence; other drops carry none", () => {
    const small = { ...BOUNDS, articleCaptureBytes: 5 };
    const detail = captureStaticArticleDetailed({ ...INPUT, maxBytes: 5 }, respond("<html>abcdef</html>"), small, {});
    const summary = captureSummaryOf(detail, 19, null);
    assert.deepEqual(summary.bound, { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: 5 }], observedBytes: 19 });
    assert.deepEqual(detail.evidence.limitations, ["body exceeds maxBytes: size bound exceeded: 19 bytes observed, limit ext.hnDigest.articleCaptureBytes 5"]);
    assert.equal(boundSentence(summary.bound as BoundDetail), "size bound exceeded: 19 bytes observed, limit ext.hnDigest.articleCaptureBytes 5");
    assert.ok(validateCaptureSummary(summary, small).ok);
    // Negative: a non-bound drop has no detail, and a bound summary without (or a non-bound one with) detail is refused.
    const thin = captureSummaryOf(captureStaticArticleDetailed(INPUT, respond("<html>short</html>"), BOUNDS, {}), 18, null);
    assert.equal("bound" in thin, false);
    const missing = captureSummaryOf(captureStaticArticleDetailed(INPUT, respond("<html>gone</html>", { status: 404 }), BOUNDS, {}), 17, null);
    assert.equal("bound" in missing, false);
    const { bound: _b, ...withoutDetail } = summary;
    assert.equal(validateCaptureSummary(withoutDetail, small).ok, false);
    assert.equal(validateCaptureSummary({ ...thin, bound: summary.bound }, small).ok, false);
  });

  it("validateCaptureSummary refuses a bound detail that does not name a configured bound", () => {
    const base = captureSummaryOf(
      captureStaticArticleDetailed({ ...INPUT, maxBytes: 5 }, respond("<html>abcdef</html>"), { ...BOUNDS, articleCaptureBytes: 5 }, {}),
      19,
      null,
    );
    const small = { ...BOUNDS, articleCaptureBytes: 5 };
    for (const bound of [
      { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: 6 }], observedBytes: 19 },
      { limits: [{ key: "article.nope", bytes: 5 }], observedBytes: 19 },
      { limits: [], observedBytes: 19 },
      {
        limits: [
          { key: "ext.hnDigest.articleCaptureBytes", bytes: 5 },
          { key: "ext.hnDigest.articleCaptureBytes", bytes: 5 },
        ],
        observedBytes: 19,
      },
      { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: 5 }], observedBytes: -1 },
      { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: 5 }], observedBytes: 1.5 },
      { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: 5 }] },
    ])
      assert.equal(validateCaptureSummary({ ...base, bound }, small).ok, false, JSON.stringify(bound));
    assert.equal(
      validateCaptureSummary({ ...base, bound: { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: 5 }], observedBytes: null } }, small).ok,
      true,
    );
  });

  it("classifies a refusing status with a challenge marker as blocked, and everything else non-2xx as fetch_error", () => {
    const page = (title: string, text = "") => `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
    for (const [status, body] of [
      [403, page("Just a moment...")],
      [503, page("x", "Enable JavaScript and cookies to continue")],
      [429, page("ATTENTION REQUIRED! | Cloudflare")],
      [403, page("x", "please VERIFY YOU ARE HUMAN")],
    ] as const) {
      const s = summary(body, { status });
      assert.deepEqual([s.status, s.reason, s.httpStatus], ["unusable", "blocked", status], body);
    }
    const detail = captureStaticArticleDetailed(BIG_INPUT, respond(page("Just a moment..."), { status: 403 }), BOUNDS, {});
    assert.match(detail.evidence.limitations[0] ?? "", /^HTTP 403 challenge page \("just a moment"\)$/);
    // Negative variants: no marker, a marker under a status that is not a challenge status, and a marker on a 2xx page.
    for (const [status, body] of [
      [403, page("Forbidden", "You do not have access")],
      [503, page("Service Unavailable")],
      [404, page("Just a moment...")],
      [500, page("Attention Required")],
    ] as const) {
      const s = summary(body, { status });
      assert.deepEqual([s.reason, s.httpStatus], ["fetch_error", status], body);
    }
    assert.notEqual(summary(page("Just a moment...", POSITIVE), { status: 200 }).reason, "blocked");
    assert.deepEqual(
      [challengeMarker(403, "nothing"), challengeMarker(200, "Just a moment"), challengeMarker(403, "Just a moment")],
      [null, null, "just a moment"],
    );
  });

  it("carries the response status in the summary", () => {
    assert.equal(summary(POSITIVE).httpStatus, 200);
    assert.equal(summary("<html>gone</html>", { status: 404 }).httpStatus, 404);
  });

  it("reports a usable page without a reason and reduces the final URL to its origin", () => {
    const s = summary(POSITIVE);
    assert.deepEqual([s.status, s.reason, s.finalOrigin], ["usable", null, "https://example.com"]);
    assert.equal(typeof s.textHash, "string");
  });

  it("does not change captureStaticArticle", () => {
    const body = boilerplate();
    assert.deepEqual(captureStaticArticleDetailed(BIG_INPUT, respond(body), BOUNDS, {}).evidence, captureStaticArticle(BIG_INPUT, respond(body), BOUNDS));
  });

  const SETTLED = { settled: true, polls: 2, waitedMs: 500 };
  const REDUCED = {
    bytes: 8,
    viewportBytes: BOUNDS.capture.screenshotMaxBytes + 1,
    clip: { x: 0, y: 0, width: BOUNDS.viewport.width, height: BOUNDS.screenshotClipHeights[0] as number },
  };
  it("validateCaptureSummary accepts the closed shape and rejects unknown keys, enums and oversize values", () => {
    const ok: CaptureSummary = {
      status: "unsupported",
      reason: "boilerplate",
      textChars: 700,
      bodyBytes: 262_361,
      bodyBytesSeen: null,
      truncated: true,
      domBytesSeen: null,
      domTruncated: false,
      httpStatus: 200,
      cause: null,
      settle: null,
      screenshot: null,
      rawHash: "a".repeat(64),
      textHash: null,
      finalOrigin: "https://github.com",
    };
    assert.equal(validateCaptureSummary(ok, BOUNDS).ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(ok)) <= CAPTURE_BYTES_MAX);
    for (const reason of CAPTURE_REASONS)
      assert.equal(
        validateCaptureSummary(
          {
            ...ok,
            reason,
            httpStatus: reason === "blocked" ? 403 : 200,
            ...(reason === "bound" && {
              bound: { limits: [{ key: "ext.hnDigest.articleCaptureBytes", bytes: BOUNDS.articleCaptureBytes }], observedBytes: null },
            }),
          },
          BOUNDS,
        ).ok,
        true,
        reason,
      );
    for (const httpStatus of [null, 100, 599]) assert.equal(validateCaptureSummary({ ...ok, httpStatus }, BOUNDS).ok, true, String(httpStatus));
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, reason: "weird" },
      { ...ok, status: "gone" },
      { ...ok, status: "usable" },
      { ...ok, textChars: -1 },
      { ...ok, bodyBytes: 1.5 },
      { ...ok, truncated: "yes" },
      { ...ok, rawHash: "short" },
      { ...ok, finalOrigin: "https://github.com/path" },
      { ...ok, finalOrigin: `https://${"a".repeat(300)}.example` },
      { ...ok, cause: "bogus" },
      { ...ok, bodyBytesSeen: -1 },
      { ...ok, domBytesSeen: -1 },
      { ...ok, domBytesSeen: 1.5 },
      { ...ok, domTruncated: "yes" },
      { ...ok, httpStatus: 99 },
      { ...ok, httpStatus: 600 },
      { ...ok, httpStatus: 200.5 },
      { ...ok, httpStatus: "200" },
      { ...ok, httpStatus: undefined },
      { ...ok, reason: "blocked", httpStatus: 200 }, // blocked needs a refusing status
      { ...ok, reason: "blocked", httpStatus: null },
      { ...ok, settle: { settled: true, polls: 1 } },
      { ...ok, settle: { settled: "yes", polls: 1, waitedMs: 1 } },
      { ...ok, settle: { settled: true, polls: -1, waitedMs: 1 } },
      { ...ok, settle: { settled: true, polls: 1, waitedMs: 1.5 } },
      { ...ok, settle: { settled: true, polls: BOUNDS.settlePollsMax + 1, waitedMs: 1 } },
      { ...ok, settle: { settled: true, polls: 1, waitedMs: BOUNDS.settleWaitMaxMs + 1 } },
      { ...ok, settle: { settled: true, polls: 1, waitedMs: 1, extra: 1 } },
      { ...ok, settle: "settled" },
      { ...ok, status: "usable", reason: null, cause: "bound" },
      // A forged or malformed screenshot account (SETTLED makes it a browser summary, so only the screenshot rule is in play).
      { ...ok, settle: SETTLED, screenshot: { bytes: 8, viewportBytes: null } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, extra: 1 } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, bytes: 0 } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, bytes: BOUNDS.capture.screenshotMaxBytes + 1 } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, viewportBytes: null } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, viewportBytes: BOUNDS.capture.screenshotMaxBytes } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, viewportBytes: 1.5 } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, clip: null } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, clip: { ...REDUCED.clip, height: 500 } } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, clip: { ...REDUCED.clip, y: 10 } } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, clip: { ...REDUCED.clip, width: BOUNDS.viewport.width + 1 } } },
      { ...ok, settle: SETTLED, screenshot: { ...REDUCED, clip: { ...REDUCED.clip, extra: 1 } } },
      { ...ok, settle: SETTLED, screenshot: "reduced" },
      { ...ok, screenshot: REDUCED }, // a screenshot without a verified browser settle result
      (({ screenshot: _s, ...rest }) => rest)(ok),
      (({ cause: _c, ...rest }) => rest)(ok), // the new keys are required, not optional
      (({ domTruncated: _d, ...rest }) => rest)(ok),
      (({ domBytesSeen: _d, ...rest }) => rest)(ok),
      (({ httpStatus: _h, ...rest }) => rest)(ok),
      null,
    ])
      assert.equal(validateCaptureSummary(bad, BOUNDS).ok, false, JSON.stringify(bad));
    // Positive: every closed cause and a maximal browser summary validate and stay within the bound.
    for (const cause of CAPTURE_CAUSES) assert.equal(validateCaptureSummary({ ...ok, cause }, BOUNDS).ok, true, cause);
    for (const height of BOUNDS.screenshotClipHeights)
      assert.equal(
        validateCaptureSummary({ ...ok, settle: SETTLED, screenshot: { ...REDUCED, clip: { ...REDUCED.clip, height } } }, BOUNDS).ok,
        true,
        String(height),
      );
    assert.equal(validateCaptureSummary({ ...ok, settle: SETTLED, screenshot: { bytes: 8, viewportBytes: null, clip: null } }, BOUNDS).ok, true);
    const browserMax: CaptureSummary = {
      ...ok,
      textChars: Number.MAX_SAFE_INTEGER,
      bodyBytes: Number.MAX_SAFE_INTEGER,
      bodyBytesSeen: Number.MAX_SAFE_INTEGER,
      domBytesSeen: Number.MAX_SAFE_INTEGER,
      domTruncated: true,
      httpStatus: 599,
      cause: "cdp_unavailable",
      settle: { settled: false, polls: BOUNDS.settlePollsMax, waitedMs: BOUNDS.settleWaitMaxMs },
      screenshot: { bytes: BOUNDS.capture.screenshotMaxBytes, viewportBytes: Number.MAX_SAFE_INTEGER, clip: REDUCED.clip },
      textHash: "b".repeat(64),
      finalOrigin: `https://${"a".repeat(180)}.example`,
    };
    assert.equal(validateCaptureSummary(browserMax, BOUNDS).ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(browserMax)) <= CAPTURE_BYTES_MAX, `${Buffer.byteLength(JSON.stringify(browserMax))} bytes`);
  });
});
