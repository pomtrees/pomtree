import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureFailureDiagnostic } from "../ext/pomtree-browser/capture-diagnostic.ts";
import { type CapturePage, captureLimits } from "./browser-capture.ts";
import { CAPTURE_ARTIFACT_ROLES } from "./capture-types.ts";
import {
  assembleReceipt,
  CAPTURE_JOB_ENV,
  CAPTURE_MEDIA_TYPES,
  captureIdempotencyKey,
  captureRecorded,
  captureReportName,
  composeUserAgent,
  exchangeRecords,
  pageUrlOf,
  operatorUserAgentProblem,
  parseCaptureJob,
  payloadHeaders,
  WARCINFO_STATEMENT,
  workerIdentity,
} from "./capture-worker.ts";
import { type CdpSessionLike, createCdpRecorder, type RecordedBody, type RecordedExchange } from "./cdp-recorder.ts";
import { CONTAINER_DEFAULTS } from "./container-contract.gen.ts";
import { MAIN_CONTENT_TUNING, snapshotInPage } from "./main-content.ts";
import { buildWacz, verifyWacz } from "./wacz.ts";
import { parseCdxj } from "./cdxj.ts";
import { parseWarcGz, type WarcRecordInput } from "./warc.ts";
import { readZip } from "./zip.ts";

const LIMITS = captureLimits(CONTAINER_DEFAULTS);
const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
const UA = "pomtree-research/1.0 (ops@example.test)";
const JOB = { job: "cj-abc123", mode: "browser", url: "http://a.test/start", maxBytes: 262144, deadlineMs: 30000, userAgent: UA };

test("parseCaptureJob accepts the exact job document and returns its normalized fields", () => {
  assert.deepEqual(parseCaptureJob(JSON.stringify(JOB), LIMITS), { ...JOB, url: "http://a.test/start" });
});

test("parseCaptureJob refuses fail-closed, naming the key and never echoing the document", () => {
  const refused = (doc: unknown, re: RegExp) => assert.throws(() => parseCaptureJob(typeof doc === "string" ? doc : JSON.stringify(doc), LIMITS), re);
  assert.throws(() => parseCaptureJob(undefined, LIMITS), new RegExp(`capture job refused: ${CAPTURE_JOB_ENV} is not set`));
  refused("{not json", /is not JSON/);
  refused([JOB], /must be a JSON object/);
  refused({ ...JOB, extra: 1 }, /unknown key "extra"/);
  refused({ ...JOB, "\n\u0000x": 1 }, /unknown key "\?\?x"/);
  const { userAgent: _u, ...noUa } = JOB;
  refused(noUa, /missing key userAgent/);
  refused({ ...JOB, job: "../x" }, /job must match/);
  refused({ ...JOB, job: "x".repeat(129) }, /job must match/);
  refused({ ...JOB, mode: "static" }, /mode must be "browser"/);
  refused({ ...JOB, url: "file:///etc/passwd" }, /credential-free bounded HTTP\(S\) URL/);
  refused({ ...JOB, url: "http://u:p@a.test/" }, /credential-free bounded HTTP\(S\) URL/);
  refused({ ...JOB, maxBytes: LIMITS.maxBytesCeiling + 1 }, /maxBytes must be an integer in 1\.\.1048576 \(browser\.capture\.maxBytesCeiling\)/);
  refused({ ...JOB, maxBytes: 1.5 }, /maxBytes/);
  refused({ ...JOB, deadlineMs: LIMITS.deadlineMinMs - 1 }, /deadlineMs must be an integer in 1000\.\.120000/);
  refused({ ...JOB, deadlineMs: "30000" }, /deadlineMs/);
  refused({ ...JOB, userAgent: "" }, /userAgent is empty; pomtreed must pass the resolved workflow\.fetch\.userAgent/);
  refused({ ...JOB, userAgent: "a\r\nX-Injected: 1" }, /userAgent must be printable ASCII/);
  refused({ ...JOB, userAgent: " a" }, /leading or trailing whitespace/);
  refused({ ...JOB, userAgent: "a".repeat(257) }, /over 256 characters/);
  // A bad URL keeps its fixed phrase, so the diagnostic classifies it.
  assert.throws(
    () => parseCaptureJob(JSON.stringify({ ...JOB, url: "ftp://x" }), LIMITS),
    (e: Error) => captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause === "bad_url",
  );
});

test("the operator User-Agent is appended to Chromium's own, never replacing it (decision C4)", () => {
  const chromium = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
  assert.equal(composeUserAgent(chromium, UA), `${chromium} ${UA}`);
  assert.throws(() => composeUserAgent("", UA), /could not read Chromium's own User-Agent/);
  assert.equal(operatorUserAgentProblem(UA), null);
});

test("report names, idempotency keys and media types are derived from job, agent, generation, role and digest", () => {
  assert.equal(captureReportName("cj-1", "wacz"), "capture/cj-1/wacz");
  assert.equal(captureIdempotencyKey("cj-1", "w1", 3, "raw", "ab"), "capture-worker:cj-1:w1:3:raw:ab");
  for (const role of Object.keys(CAPTURE_MEDIA_TYPES)) assert.ok((CAPTURE_ARTIFACT_ROLES as readonly string[]).includes(role));
});

test("workerIdentity requires the controller's agent id and a whole generation", () => {
  assert.deepEqual(workerIdentity({ POMTREE_AGENT_ID: "w1", POMTREE_AGENT_GENERATION: "2" }), { worker: "w1", generation: 2 });
  assert.throws(() => workerIdentity({ POMTREE_AGENT_GENERATION: "2" }), /identity bounds required/);
  assert.throws(() => workerIdentity({ POMTREE_AGENT_ID: "w1", POMTREE_AGENT_GENERATION: "1e3" }), /identity bounds required/);
});

test("payloadHeaders keeps wire framing headers under X-Orig- and states the stored payload length", () => {
  assert.deepEqual(
    payloadHeaders(
      [
        ["Content-Encoding", "gzip"],
        ["content-length", "99"],
        ["Content-Type", "text/html"],
      ],
      5,
    ),
    [
      ["X-Orig-Content-Encoding", "gzip"],
      ["X-Orig-content-length", "99"],
      ["Content-Type", "text/html"],
      ["Content-Length", "5"],
    ],
  );
});

const hop = (url: string, status: number | null, headers: [string, string][] = []) => ({
  url,
  method: "GET",
  requestHeaders: [["Host", new URL(url).host]] as [string, string][],
  requestHeadersSource: "raw" as const,
  postData: null,
  wallTimeMs: 1_700_000_000_000,
  response: status === null ? null : { url, status, statusText: "", protocol: "http/1.1", mimeType: "text/html", headers, headersSource: "raw" as const },
  body: { state: "complete", bytes: Buffer.from("x") } as RecordedBody,
});
const exchange = (requestId: string, hops: ReturnType<typeof hop>[], state: RecordedExchange["state"] = "finished"): RecordedExchange => ({
  requestId,
  frameId: "F1",
  resourceType: "Document",
  navigation: true,
  hops,
  state,
});

test("a subresource whose header holds CR/LF/NUL is a recorded omission; the same in the main document fails with a fixed phrase", () => {
  const main = exchange("D", [hop("http://a.test/", 200)]);
  const bad = exchange("S", [hop("http://cdn.test/x.js", 200, [["X-Evil", "a\r\nWARC-Type: forged"]])]);
  const failed = exchange("F", [hop("http://cdn.test/f.css", null)], "failed");
  const { records, summary } = exchangeRecords([main, bad, failed], main, "<urn:uuid:00000000-0000-4000-8000-000000000000>", 0);
  assert.equal(summary.archived, 2);
  assert.deepEqual(summary.omissions, [
    { url: "http://cdn.test/x.js", reason: "unrepresentable" },
    { url: "http://cdn.test/f.css", reason: "failed" },
  ]);
  assert.deepEqual(
    records.map((r) => [r.type, r.targetUri]),
    [
      ["request", "http://a.test/"],
      ["response", "http://a.test/"],
      ["request", "http://cdn.test/f.css"],
    ],
  );
  const badMain = exchange("D", [hop("http://a.test/", 200, [["X", "a\u0000b"]])]);
  assert.throws(
    () => exchangeRecords([badMain], badMain, "<urn:uuid:00000000-0000-4000-8000-000000000000>", 0),
    (e: Error) => {
      assert.match(e.message, /main response cannot be archived/);
      assert.ok(!e.message.includes("a\u0000b"));
      // Producer to consumer: the extension's diagnostic classifies the worker's own message, never as `other`.
      assert.equal(captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause, "unarchivable");
      return true;
    },
  );
});

test("assembleReceipt has exactly the receipt keys and refuses a duplicated role", () => {
  const fetch = { requestedUrl: "u", finalUrl: "u", redirects: [], status: 200, contentType: "text/html", headers: {}, fetchedAt: 1, userAgent: UA };
  const a = { role: "raw" as const, mediaType: "text/html", sizeBytes: 1, sha256: "0".repeat(64), report: { id: "r" } };
  assert.deepEqual(Object.keys(assembleReceipt({ job: "j", worker: "w", generation: 0, fetch, artifacts: [a] })), [
    "job",
    "worker",
    "generation",
    "mode",
    "captureMethod",
    "fetch",
    "artifacts",
  ]);
  assert.throws(() => assembleReceipt({ job: "j", worker: "w", generation: 0, fetch, artifacts: [a, a] }), /role twice/);
});

// A scripted page plus a scripted CDP session that replays a cross-host 302 then 200, a subresource with a CRLF-bearing header and a
// failed subresource, as Chromium reports them during page.goto.
function scripted(over: { goto?: () => void; publishSha?: (sha: string) => string; pageUrl?: string } = {}) {
  const listeners = new Map<string, ((p: unknown) => void)[]>();
  const emit = (event: string, params: unknown) => {
    for (const l of listeners.get(event) ?? []) l(params);
  };
  const html = "<html><head><title>T</title></head><body><p>rendered text</p></body></html>";
  const cdp: CdpSessionLike = {
    on: (e, l) => void listeners.set(e, [...(listeners.get(e) ?? []), l as (p: unknown) => void]),
    async send(method, params) {
      if (method === "Network.getResponseBody") {
        if (params?.requestId === "D") return { body: html, base64Encoded: false };
        if (params?.requestId === "S") return { body: "js", base64Encoded: false };
        throw new Error("No resource");
      }
      return {};
    },
  };
  const base = { loaderId: "D", frameId: "F1", wallTime: 1_700_000_000 };
  const page: CapturePage & { title(): Promise<string> } = {
    async goto() {
      over.goto?.();
      emit("Network.requestWillBeSent", {
        ...base,
        requestId: "D",
        type: "Document",
        request: { url: "http://a.test/start", method: "GET", headers: { "User-Agent": "sent-UA" } },
      });
      emit("Network.requestWillBeSent", {
        ...base,
        requestId: "D",
        type: "Document",
        request: { url: "http://b.test/final", method: "GET", headers: { "User-Agent": "sent-UA" } },
        redirectResponse: { url: "http://a.test/start", status: 302, statusText: "Found", headers: { Location: "http://b.test/final" } },
      });
      emit("Network.responseReceived", {
        requestId: "D",
        response: {
          url: "http://b.test/final",
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "text/html", "Set-Cookie": "s=1", ETag: '"e"' },
          protocol: "http/1.1",
        },
      });
      emit("Network.loadingFinished", { requestId: "D" });
      emit("Network.requestWillBeSent", { ...base, requestId: "S", type: "Script", request: { url: "http://cdn.test/x.js", method: "GET", headers: {} } });
      emit("Network.responseReceived", { requestId: "S", response: { url: "http://cdn.test/x.js", status: 200, headers: { "X-Evil": "a\rb" } } });
      emit("Network.loadingFinished", { requestId: "S" });
      emit("Network.requestWillBeSent", { ...base, requestId: "F", type: "Image", request: { url: "http://cdn.test/f.png", method: "GET", headers: {} } });
      emit("Network.loadingFailed", { requestId: "F", errorText: "net::ERR_FAILED" });
      return {
        body: async () => Buffer.from(html),
        status: () => 200,
        headerValue: async (n: string) => (n === "content-type" ? "text/html" : null),
      };
    },
    url: () => over.pageUrl ?? "http://b.test/final",
    evaluate: async (fn, arg) => {
      assert.equal(fn, snapshotInPage);
      assert.equal(arg, MAIN_CONTENT_TUNING);
      return { dom: html, text: "rendered text" };
    },
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    close: async () => {},
    title: async () => "T",
  };
  const published: { name: string; type: string; role: string; data: Uint8Array }[] = [];
  return {
    page,
    recorder: createCdpRecorder(cdp, {
      perBodyMaxBytes: 262144,
      perBodyAllocationMaxBytes: LIMITS.rawAllocationMaxBytes,
      totalMaxBytes: LIMITS.rawAllocationMaxBytes,
    }),
    published,
    publish: async (data: Uint8Array, name: string, type: string, role: string) => {
      published.push({ name, type, role, data });
      return { id: `id-${role}`, sha256: over.publishSha ? over.publishSha(sha(data)) : sha(data) };
    },
  };
}
const opts = (s: ReturnType<typeof scripted>) => ({
  url: "http://a.test/start",
  maxBytes: 262144,
  deadlineMs: 30000,
  limits: LIMITS,
  settle: { pollMs: 1, stablePolls: 1, maxMs: 5 },
  worker: "w1",
  generation: 2,
  job: "cj-abc123",
  userAgent: `Chromium ${UA}`,
  recorder: s.recorder,
  mainFrameId: async () => "F1",
  publish: s.publish,
});

test("captureRecorded publishes a verified WACZ and the companion evidence, and returns the receipt with every redirect hop", async () => {
  const s = scripted();
  const receipt = await captureRecorded(s.page, opts(s));
  assert.deepEqual(
    s.published.map((p) => [p.name, p.type]),
    [
      ["capture/cj-abc123/wacz", "application/zip"],
      ["capture/cj-abc123/raw", "text/html"],
      ["capture/cj-abc123/dom", "text/html"],
      ["capture/cj-abc123/text", "text/plain"],
      ["capture/cj-abc123/screenshot", "image/png"],
      ["capture/cj-abc123/navigation", "application/json"],
    ],
  );
  assert.equal(receipt.mode, "browser");
  assert.equal(receipt.captureMethod, "cdp");
  assert.deepEqual(receipt.fetch, {
    requestedUrl: "http://a.test/start",
    finalUrl: "http://b.test/final",
    redirects: [{ url: "http://a.test/start", status: 302 }],
    status: 200,
    contentType: "text/html",
    // Allowlisted only: Set-Cookie is dropped.
    headers: { "content-type": "text/html", etag: '"e"' },
    fetchedAt: 1_700_000_000_000,
    userAgent: "sent-UA",
  });
  for (const [i, a] of receipt.artifacts.entries()) {
    const p = s.published[i]!;
    assert.deepEqual(a, { role: p.role, mediaType: p.type, sizeBytes: p.data.byteLength, sha256: sha(p.data), report: { id: `id-${p.role}` } });
  }
  const wacz = s.published[0]!.data;
  const verdict = verifyWacz(wacz);
  assert.ok(verdict.ok, JSON.stringify(verdict));
  const files = Object.fromEntries(readZip(wacz).map((f) => [f.name, f.data]));
  const records = parseWarcGz(files["archive/data.warc.gz"]!);
  const types = records.map((r) => [r.headers.get("warc-type"), r.headers.get("warc-target-uri") ?? null]);
  assert.deepEqual(types, [
    ["warcinfo", null],
    ["request", "http://a.test/start"],
    ["response", "http://a.test/start"],
    ["request", "http://b.test/final"],
    ["response", "http://b.test/final"],
    ["request", "http://cdn.test/f.png"],
    ["resource", "urn:view:http://b.test/final"],
    ["resource", "urn:text:http://b.test/final"],
    ["metadata", "http://b.test/final"],
  ]);
  const info = Buffer.from(records[0]!.block).toString();
  assert.match(info, /capture-method: cdp/);
  assert.match(info, /format: WARC File Format 1\.1/);
  assert.ok(info.includes(WARCINFO_STATEMENT));
  // The main response payload is exactly the raw artifact's bytes, with the stored length.
  const finalResponse = Buffer.from(records[4]!.block).toString("latin1");
  assert.ok(finalResponse.endsWith(Buffer.from(s.published[1]!.data).toString("latin1")));
  assert.match(finalResponse, /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(records[2]!.headers.get("warc-payload-omission"), "redirect");
  assert.equal(records[1]!.headers.get("warc-concurrent-to"), records[2]!.headers.get("warc-record-id"));
  assert.equal(records[8]!.headers.get("warc-refers-to"), records[4]!.headers.get("warc-record-id"));
  const meta = JSON.parse(Buffer.from(records[8]!.block).toString());
  assert.equal(meta.sourceKind, "cdp-capture-worker");
  assert.deepEqual(meta.recording.omissions, [
    { url: "http://cdn.test/x.js", reason: "unrepresentable" },
    { url: "http://cdn.test/f.png", reason: "failed" },
  ]);
  const pages = Buffer.from(files["pages/pages.jsonl"]!)
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(pages[1].url, "http://b.test/final");
  assert.equal(pages[1].title, "T");
  assert.equal(pages[1].text, "rendered text");
  const nav = JSON.parse(Buffer.from(s.published[5]!.data).toString());
  assert.deepEqual(nav.artifacts, receipt.artifacts.slice(0, 5));
});

async function archivedPages(pageUrl: string) {
  const s = scripted({ pageUrl });
  await captureRecorded(s.page, opts(s));
  const wacz = s.published[0]!.data;
  const files = Object.fromEntries(readZip(wacz).map((f) => [f.name, f.data]));
  const pages = Buffer.from(files["pages/pages.jsonl"]!)
    .toString()
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => JSON.parse(l));
  return { verdict: verifyWacz(wacz), pages, cdxj: parseCdxj(Buffer.from(files["indexes/index.cdxj"]!).toString()) };
}

test("a final URL with a #fragment still captures: the page is keyed on the main hop's URL without the fragment", async () => {
  const { verdict, pages, cdxj } = await archivedPages("http://b.test/final#section-2");
  assert.ok(verdict.ok, JSON.stringify(verdict));
  assert.equal(pages[0].url, "http://b.test/final");
  assert.ok(cdxj.some((r) => r.fields.url === "http://b.test/final"));
});

test("a page.url() that differs from the main hop in more than the fragment still captures, keyed on the hop", async () => {
  const { verdict, pages } = await archivedPages("http://b.test/final/?client=side#x");
  assert.ok(verdict.ok, JSON.stringify(verdict));
  assert.equal(pages[0].url, "http://b.test/final");
});

test("pageUrlOf is the final hop's URL with the fragment stripped", () => {
  const main = exchange("D", [hop("http://a.test/start", 302), hop("http://b.test/final?q=1#frag", 200)]);
  assert.equal(pageUrlOf(main), "http://b.test/final?q=1");
});

test("an omitted or truncated subresource body is marked in the WARC and CDXJ, and the omitted one has no payload digest; the archive verifies", () => {
  const main = exchange("D", [hop("http://a.test/", 200)]);
  const lost = exchange("L", [
    { ...hop("http://cdn.test/lost.js", 200), body: { state: "omitted" as const, bytes: new Uint8Array(0), omission: "not_retained" as const } },
  ]);
  const cut = exchange("C", [{ ...hop("http://cdn.test/cut.js", 200), body: { state: "truncated" as const, bytes: Buffer.from("ab"), fullBytes: 9 } }]);
  const redirect = exchange("R", [
    { ...hop("http://cdn.test/r", 302), body: { state: "omitted" as const, bytes: new Uint8Array(0), omission: "redirect" as const } },
  ]);
  const { records } = exchangeRecords([main, lost, cut, redirect], main, "<urn:uuid:00000000-0000-4000-8000-000000000000>", 0);
  const w = buildWacz({
    records: records as WarcRecordInput[],
    pages: [{ url: "http://a.test/", ts: "2026-10-24T12:00:00Z" }],
    created: "2026-10-24T12:00:00Z",
    software: "t",
  });
  assert.ok(verifyWacz(w.wacz).ok, JSON.stringify(verifyWacz(w.wacz)));
  const warc = parseWarcGz(w.warc);
  const rec = (url: string) => warc.find((r) => r.headers.get("warc-type") === "response" && r.headers.get("warc-target-uri") === url)!;
  assert.equal(rec("http://cdn.test/lost.js").headers.has("warc-payload-digest"), false);
  assert.equal(rec("http://cdn.test/lost.js").headers.get("warc-truncated"), "unspecified");
  assert.match(rec("http://cdn.test/cut.js").headers.get("warc-payload-digest") ?? "", /^sha256:/);
  assert.equal(rec("http://cdn.test/cut.js").headers.get("warc-truncated"), "length");
  // A redirect has no body to lose: it keeps its (genuinely empty) digest and is not marked truncated.
  assert.match(rec("http://cdn.test/r").headers.get("warc-payload-digest") ?? "", /^sha256:/);
  assert.equal(rec("http://cdn.test/r").headers.has("warc-truncated"), false);
  const rows = parseCdxj(w.cdxj);
  const row = (url: string) => rows.find((r) => r.fields.url === url)!.fields;
  assert.equal("digest" in row("http://cdn.test/lost.js"), false);
  assert.equal(row("http://cdn.test/lost.js").truncated, "unspecified");
  assert.equal(row("http://cdn.test/cut.js").truncated, "length");
  assert.equal("truncated" in row("http://cdn.test/r"), false);
});

test("a publisher receipt whose hash differs from the bytes fails as a publish failure", async () => {
  const s = scripted({ publishSha: () => "0".repeat(64) });
  await assert.rejects(captureRecorded(s.page, opts(s)), (e: Error) => captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause === "publish_failed");
});

test("the shared core's policy applies to the worker: a bot challenge stops it before anything is published", async () => {
  const s = scripted();
  s.page.goto = async () => ({
    body: async () => Buffer.from("<html><script>window.gokuProps={}</script></html>"),
    status: () => 202,
    headerValue: async (n: string) => (n === "content-type" ? "text/html" : null),
  });
  await assert.rejects(captureRecorded(s.page, opts(s)), (e: Error) => captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause === "bot_challenge");
  assert.equal(s.published.length, 0);
});

test("a recording without the main document fails as no_response", async () => {
  const s = scripted();
  await assert.rejects(
    captureRecorded(s.page, { ...opts(s), mainFrameId: async () => "other-frame" }),
    (e: Error) => captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause === "no_response",
  );
});

test("the deadline holds for the worker capture and classifies as deadline", async () => {
  const s = scripted();
  s.page.goto = () => new Promise(() => {});
  await assert.rejects(
    captureRecorded(s.page, { ...opts(s), deadlineMs: 1000, deadlineAt: Date.now() + 50 }),
    (e: Error) => captureFailureDiagnostic({ code: 1, stderr: e.message }, {}).cause === "deadline",
  );
});

test("the shipped worker imports only files the Dockerfile copies beside it", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = new Set([
    "browser-capture.ts",
    "browser-run.ts",
    "main-content.ts",
    "container-contract.gen.ts",
    "capture-worker.ts",
    "cdp-recorder.ts",
    "capture-types.ts",
    "warc.ts",
    "cdxj.ts",
    "zip.ts",
    "wacz.ts",
  ]);
  for (const f of ["capture-worker.ts", "cdp-recorder.ts", "capture-types.ts", "warc.ts", "cdxj.ts", "zip.ts", "wacz.ts"]) {
    const src = readFileSync(join(here, f), "utf8");
    for (const m of src.matchAll(/from "(\.[^"]+)"/g)) assert.ok(shipped.has(m[1]!.replace(/^\.\//, "")), `${f} imports ${m[1]}`);
  }
});
