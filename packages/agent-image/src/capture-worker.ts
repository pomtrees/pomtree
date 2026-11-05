// Model-free capture worker: the container's command, with no Pi process. It starts
// Chromium with the hardened browser-run.ts flags (only through the browser proxy port), attaches over CDP with the image's pinned
// Playwright, records the page's HTTP traffic from the CDP Network domain (cdp-recorder.ts; the HAR-versus-CDP decision is recorded
// there), runs the one shared capture core (browser-capture.ts observeCapture: limits, challenge detection, settle, clipping,
// screenshot fallback), writes WARC 1.1 into a WACZ beside the companion evidence, publishes every artifact with `pomtree report publish`,
// and prints one CaptureWorkerReceipt line. The model never sees page bytes, only the receipt the broker relays.
//
// Run as `/usr/local/bin/node /opt/pomtree/capture-worker.ts` with no arguments. Exit 0 with the receipt on stdout; on failure exit
// 1 with one stderr line whose fixed phrases ext/pomtree-browser/capture-diagnostic.ts classifies.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  BROWSER_VIEWPORT,
  CAPTURE_TEARDOWN_MS,
  type CaptureCoreOptions,
  type CaptureLimits,
  type CaptureObservation,
  type CapturePage,
  type CaptureReport,
  type CaptureSession,
  captureLimits,
  captureUrl,
  checkCaptureOptions,
  contextUserAgent,
  navigationSummary,
  operatorUserAgentProblem,
  observeCapture,
  PLAYWRIGHT_MODULE,
  parseReportPublishJson,
  pomtree,
  publishArgv,
  runCaptureSession,
  withCaptureDeadline,
} from "./browser-capture.ts";
import { BROWSER_PROXY_URL, CDP_READY_POLL_MS, cdpReady, startChromium } from "./browser-run.ts";
import { allowlistHeaders, type CaptureArtifactRole, type CaptureWorkerReceipt, type FetchMeta, type WorkerArtifact } from "./capture-types.ts";
import { type CdpRecorder, type CdpSessionLike, createCdpRecorder, mainDocument, type RecordedExchange, type RecordedHop } from "./cdp-recorder.ts";
import { CDP_PORT, readContainerConfig } from "./container-contract.gen.ts";
import { buildWacz, verifyWacz } from "./wacz.ts";
import { httpRequestBlock, httpResponseBlock, type WarcRecordInput, warcRecord } from "./warc.ts";

export const CAPTURE_JOB_ENV = "PTREE_CAPTURE_JOB";
export const CAPTURE_WORKER_SOFTWARE = "pomtree-capture-worker";
export const CAPTURE_WARC_NAME = "data.warc.gz";

export interface CaptureJob {
  job: string;
  mode: "browser";
  url: string;
  maxBytes: number;
  deadlineMs: number;
  userAgent: string;
}
const JOB_KEYS = ["job", "mode", "url", "maxBytes", "deadlineMs", "userAgent"] as const;
// The job id becomes part of report names and idempotency keys, so it is a short closed alphabet (the broker's `cj-<sha256 hex>` fits).
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// The operator User-Agent's check and its composition with Chromium's own live in browser-capture.ts (shared with the Pi tool capture).
export { composeUserAgent, operatorUserAgentProblem } from "./browser-capture.ts";

// TODO(capture-broker): adopt core types from S1; the job document moves into the container config the controller writes
// Parses the job document fail-closed: unknown or missing keys, wrong types and out-of-bound values are refused with a message that names
// the key, never echoes the document. The bounds are the container config's browser.capture.* limits (readContainerConfig, required).
export function parseCaptureJob(raw: string | undefined, limits: CaptureLimits): CaptureJob {
  const refuse = (why: string): never => {
    throw new Error(`capture job refused: ${why}`);
  };
  if (raw === undefined || raw === "") return refuse(`${CAPTURE_JOB_ENV} is not set`);
  if (raw.length > 16384) return refuse(`${CAPTURE_JOB_ENV} is over 16384 characters`);
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return refuse(`${CAPTURE_JOB_ENV} is not JSON`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return refuse("the job document must be a JSON object");
  const o = doc as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(JOB_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return refuse(`unknown key ${JSON.stringify(unknown[0]?.slice(0, 64).replace(/\p{Cc}/gu, "?"))}`);
  for (const k of JOB_KEYS) if (!(k in o)) refuse(`missing key ${k}`);
  if (typeof o.job !== "string" || !JOB_ID.test(o.job)) refuse("job must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}");
  if (o.mode !== "browser") refuse('mode must be "browser"');
  if (typeof o.url !== "string") refuse("url must be a string");
  const url = captureUrl(o.url as string); // its own fixed phrase (cause bad_url)
  if (!Number.isSafeInteger(o.maxBytes) || (o.maxBytes as number) < 1 || (o.maxBytes as number) > limits.maxBytesCeiling)
    refuse(`maxBytes must be an integer in 1..${limits.maxBytesCeiling} (browser.capture.maxBytesCeiling)`);
  if (!Number.isSafeInteger(o.deadlineMs) || (o.deadlineMs as number) < limits.deadlineMinMs || (o.deadlineMs as number) > limits.deadlineMaxMs)
    refuse(`deadlineMs must be an integer in ${limits.deadlineMinMs}..${limits.deadlineMaxMs} (browser.capture.deadlineMinMs..deadlineMaxMs)`);
  if (typeof o.userAgent !== "string") refuse("userAgent must be a string");
  const uaProblem = operatorUserAgentProblem(o.userAgent as string);
  if (uaProblem) refuse(`userAgent ${uaProblem}`);
  return { job: o.job as string, mode: "browser", url, maxBytes: o.maxBytes as number, deadlineMs: o.deadlineMs as number, userAgent: o.userAgent as string };
}

// TODO(capture-broker): pomtreed slugifyReportName flattens "/" and caps at 64 chars, and isAllowedMediaType has no zip; until the S2 report-prefix scope lands, a real daemon refuses these publishes (publish_failed)
export const captureReportName = (job: string, role: CaptureArtifactRole): string => `capture/${job}/${role}`;
export const captureIdempotencyKey = (job: string, agent: string, generation: number, role: CaptureArtifactRole, sha256: string): string =>
  `capture-worker:${job}:${agent}:${generation}:${role}:${sha256}`;
export const CAPTURE_MEDIA_TYPES = {
  // WACZ is a zip container; no media type of its own is registered [knowledge-only].
  wacz: "application/zip",
  raw: "text/html",
  dom: "text/html",
  text: "text/plain",
  screenshot: "image/png",
  navigation: "application/json",
} as const satisfies Partial<Record<CaptureArtifactRole, string>>;
type PublishedRole = keyof typeof CAPTURE_MEDIA_TYPES;

// What the WARC could not hold, by exchange: a closed reason, never Chromium's error text.
export interface RecordingOmission {
  url: string | null;
  reason: "unrepresentable" | "failed" | "unfinished";
}
export interface RecordingSummary {
  exchanges: number;
  archived: number;
  bodies: { complete: number; truncated: number; omitted: Record<string, number> };
  omissions: RecordingOmission[];
}
const OMISSIONS_LISTED_MAX = 200;

const isoAt = (ms: number): string => new Date(ms).toISOString();
const recordId = (): string => `<urn:uuid:${randomUUID()}>`;
// The stored payload is the content-decoded entity Chromium reports, so the framing headers that described the wire bytes are kept under
// an X-Orig- prefix and a Content-Length of the stored payload is added; a reader then parses the record as it stands.
const FRAMING = new Set(["content-encoding", "transfer-encoding", "content-length"]);
export function payloadHeaders(headers: [string, string][], payloadBytes: number): [string, string][] {
  const out: [string, string][] = headers.map(([k, v]) => (FRAMING.has(k.toLowerCase()) ? [`X-Orig-${k}`, v] : [k, v]));
  out.push(["Content-Length", String(payloadBytes)]);
  return out;
}

function hopRecords(hop: RecordedHop, warcinfoId: string, fallbackMs: number): WarcRecordInput[] {
  const date = isoAt(hop.wallTimeMs ?? fallbackMs);
  const requestId = recordId();
  const responseId = hop.response ? recordId() : undefined;
  const records: WarcRecordInput[] = [
    {
      type: "request",
      recordId: requestId,
      date,
      targetUri: hop.url,
      contentType: "application/http;msgtype=request",
      block: httpRequestBlock({
        method: hop.method,
        url: hop.url,
        headers: hop.requestHeaders,
        ...(hop.postData !== null && { body: Buffer.from(hop.postData, "utf8") }),
      }),
      ...(responseId && { concurrentTo: responseId }),
      warcinfoId,
    },
  ];
  if (hop.response && responseId) {
    const body = hop.body;
    const extra: [string, string][] = [];
    if (hop.response.protocol) extra.push(["WARC-Protocol", hop.response.protocol]);
    // A truncated body keeps its payload digest: WARC 1.1 digests the stored (cut) content, and WARC-Truncated says it is a prefix [knowledge-only].
    if (body.state === "truncated") extra.push(["WARC-Truncated", "length"]);
    // An omitted body (not retained, over a bound) is truncated in WARC terms; a redirect or a bodiless status has nothing to truncate.
    // Its payload digest is left out: the empty-body digest would let a replayer or deduper see a genuine empty body.
    const bodyLost = body.state === "omitted" && body.omission !== "redirect" && body.omission !== "no_body";
    if (bodyLost) extra.push(["WARC-Truncated", "unspecified"]);
    if (body.omission) extra.push(["WARC-Payload-Omission", body.omission]);
    records.push({
      type: "response",
      recordId: responseId,
      date,
      targetUri: hop.url,
      contentType: "application/http;msgtype=response",
      block: httpResponseBlock({
        status: hop.response.status,
        statusText: hop.response.statusText,
        headers: payloadHeaders(hop.response.headers, body.bytes.byteLength),
        body: body.bytes,
      }),
      concurrentTo: requestId,
      warcinfoId,
      ...(extra.length > 0 && { extra }),
      ...(bodyLost && { omitPayloadDigest: true }),
    });
  }
  return records;
}

// Every exchange as WARC request/response records, the main document first. A subresource whose URL or headers the WARC writer refuses
// (CR, LF or NUL in page-controlled text, a non-token header name) is a recorded omission; the main document's refusal fails the capture.
export function exchangeRecords(
  exchanges: readonly RecordedExchange[],
  main: RecordedExchange,
  warcinfoId: string,
  fallbackMs: number,
): { records: WarcRecordInput[]; mainResponseId: string | undefined; summary: RecordingSummary } {
  const records: WarcRecordInput[] = [];
  const summary: RecordingSummary = { exchanges: exchanges.length, archived: 0, bodies: { complete: 0, truncated: 0, omitted: {} }, omissions: [] };
  const omit = (url: string | null, reason: RecordingOmission["reason"]) => {
    if (summary.omissions.length < OMISSIONS_LISTED_MAX) summary.omissions.push({ url: url && url.length <= 2048 ? url : null, reason });
  };
  let mainResponseId: string | undefined;
  for (const ex of [main, ...exchanges.filter((e) => e !== main)]) {
    let built: WarcRecordInput[];
    try {
      built = ex.hops.flatMap((h) => hopRecords(h, warcinfoId, fallbackMs));
      for (const r of built) warcRecord(r); // validate now, so a refusal is attributed to this exchange
    } catch {
      if (ex === main)
        throw new Error(
          "browser capture main response cannot be archived (its URL or headers hold characters a WARC header refuses); no raw body receipt can be issued",
        );
      omit(ex.hops[0]?.url ?? null, "unrepresentable");
      continue;
    }
    if (ex === main) mainResponseId = built.filter((r) => r.type === "response").at(-1)?.recordId;
    records.push(...built);
    summary.archived++;
    if (ex.state !== "finished") omit(ex.hops[0]?.url ?? null, ex.state === "failed" ? "failed" : "unfinished");
    for (const h of ex.hops) {
      if (!h.response) continue;
      if (h.body.state === "complete") summary.bodies.complete++;
      else if (h.body.state === "truncated") summary.bodies.truncated++;
      else if (h.body.omission) summary.bodies.omitted[h.body.omission] = (summary.bodies.omitted[h.body.omission] ?? 0) + 1;
    }
  }
  return { records, mainResponseId, summary };
}

// The main document's final hop carries exactly the raw artifact's bytes (Playwright's content-decoded entity, clipped to maxBytes), so the
// WARC payload and the raw report hash the same bytes.
export function withMainBody(main: RecordedExchange, obs: CaptureObservation): RecordedExchange {
  const hops = main.hops.map((h, i) =>
    i === main.hops.length - 1 && h.response
      ? {
          ...h,
          body: obs.rawTruncated
            ? { state: "truncated" as const, bytes: obs.raw, fullBytes: obs.fullRawBytes }
            : { state: "complete" as const, bytes: obs.raw },
        }
      : h,
  );
  return { ...main, hops };
}

// The page entry's URL: the main response hop's own URL (what the CDXJ entry is keyed on), fragment stripped as the SURT key strips it.
// page.url() (obs.finalUrl) keeps the fragment and can differ from the hop in other ways, which would leave the page without an index entry.
export function pageUrlOf(main: RecordedExchange): string {
  return (main.hops[main.hops.length - 1] as RecordedHop).url.split("#")[0] as string;
}

export function fetchMetaOf(main: RecordedExchange, obs: CaptureObservation, sentUserAgent: string, fallbackMs: number): FetchMeta {
  const final = main.hops[main.hops.length - 1] as RecordedHop;
  const sent = main.hops[0]?.requestHeaders.find(([k]) => k.toLowerCase() === "user-agent")?.[1];
  return {
    requestedUrl: obs.originalUrl,
    finalUrl: obs.finalUrl,
    // Every hop in order: each redirect's URL and status; the final URL and status follow.
    redirects: main.hops.slice(0, -1).map((h) => ({ url: h.url, status: h.response?.status ?? 0 })),
    status: obs.status,
    contentType: obs.contentType,
    headers: allowlistHeaders(final.response?.headers ?? []),
    fetchedAt: main.hops[0]?.wallTimeMs ?? fallbackMs,
    userAgent: sent ?? sentUserAgent,
  };
}

export const WARCINFO_STATEMENT =
  "Reconstructed from Chromium's DevTools Protocol network reports, not a wire capture: header case and order are Chromium's, HTTP/2 framing is not recorded, text bodies are as Chromium decoded them, redirect responses carry no body, and some subresource bodies are unavailable or truncated (WARC-Truncated, WARC-Payload-Omission).";
export function warcinfoBlock(userAgent: string, job: string): Uint8Array {
  const fields: [string, string][] = [
    ["software", CAPTURE_WORKER_SOFTWARE],
    ["format", "WARC File Format 1.1"],
    ["conformsTo", "https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/"],
    ["capture-method", "cdp"],
    ["description", WARCINFO_STATEMENT],
    ["http-header-user-agent", userAgent],
    ["job", job],
  ];
  return Buffer.from(fields.map(([k, v]) => `${k}: ${v}\r\n`).join(""), "utf8");
}

export interface RecordedCaptureOptions extends CaptureCoreOptions {
  job: string;
  // The User-Agent the context was given (Chromium's own plus the operator's); FetchMeta reports the header actually sent when recorded.
  userAgent: string;
  recorder: CdpRecorder;
  mainFrameId(): Promise<string | null>;
  publish(data: Uint8Array, name: string, mediaType: string, role: PublishedRole): Promise<CaptureReport>;
  now?: () => number;
}

// The worker's capture: the shared core under the shared deadline, plus the network recording, the WACZ and the six publishes.
export async function captureRecorded(page: CapturePage & { title?(): Promise<string> }, opts: RecordedCaptureOptions): Promise<CaptureWorkerReceipt> {
  const originalUrl = checkCaptureOptions(opts);
  const now = opts.now ?? Date.now;
  const deadlineAt = opts.deadlineAt ?? now() + opts.deadlineMs;
  return withCaptureDeadline(page, deadlineAt, async (ctx) => {
    const startedAt = now();
    await opts.recorder.start();
    const obs = await observeCapture(page, opts, originalUrl, ctx.remaining);
    const title = page.title ? await page.title().catch(() => undefined) : undefined;
    const exchanges = await opts.recorder.finish();
    const found = mainDocument(exchanges, await opts.mainFrameId().catch(() => null), obs.finalUrl);
    if (!found) throw new Error("browser capture missing main response in the network recording; no raw body receipt can be issued");
    const main = withMainBody(found, obs);
    const all = exchanges.map((e) => (e === found ? main : e));
    const fetch = fetchMetaOf(main, obs, opts.userAgent, startedAt);
    const warcinfoId = recordId();
    const { records, mainResponseId, summary } = exchangeRecords(all, main, warcinfoId, startedAt);
    const fetchedIso = isoAt(fetch.fetchedAt);
    const capturedIso = isoAt(now());
    const nav = navigationSummary(obs, opts);
    const recording = { ...nav, sourceKind: "cdp-capture-worker", job: opts.job, captureMethod: "cdp" as const, fetch, recording: summary };
    const warc: WarcRecordInput[] = [
      {
        type: "warcinfo",
        recordId: warcinfoId,
        date: capturedIso,
        contentType: "application/warc-fields",
        block: warcinfoBlock(fetch.userAgent, opts.job),
        filename: CAPTURE_WARC_NAME,
      },
      ...records,
      { type: "resource", date: capturedIso, targetUri: `urn:view:${obs.finalUrl}`, contentType: "image/png", block: obs.screenshot, warcinfoId },
      { type: "resource", date: capturedIso, targetUri: `urn:text:${obs.finalUrl}`, contentType: "text/plain; charset=utf-8", block: obs.text, warcinfoId },
      {
        type: "metadata",
        date: capturedIso,
        targetUri: obs.finalUrl,
        contentType: "application/json",
        block: Buffer.from(JSON.stringify(recording)),
        ...(mainResponseId && { refersTo: mainResponseId }),
        warcinfoId,
      },
    ];
    const built = buildWacz({
      records: warc,
      pages: [
        { url: pageUrlOf(main), ts: fetchedIso, ...(title !== undefined && { title: title.slice(0, 1000) }), text: Buffer.from(obs.text).toString("utf8") },
      ],
      created: capturedIso,
      software: CAPTURE_WORKER_SOFTWARE,
      warcName: CAPTURE_WARC_NAME,
    });
    const verdict = verifyWacz(built.wacz);
    if (!verdict.ok) throw new Error(`capture archive failed its own verification (${verdict.problems.length} problems)`);
    const artifacts: WorkerArtifact[] = [];
    const publish = async (role: PublishedRole, data: Uint8Array) => {
      const mediaType = CAPTURE_MEDIA_TYPES[role];
      const ref = await ctx.checked((d, name, type) => opts.publish(d, name, type, role))(data, captureReportName(opts.job, role), mediaType);
      const artifact: WorkerArtifact = { role, mediaType, sizeBytes: data.byteLength, sha256: ref.sha256, report: { id: ref.id } };
      artifacts.push(artifact);
      return artifact;
    };
    await publish("wacz", built.wacz);
    await publish("raw", obs.raw);
    await publish("dom", obs.dom);
    await publish("text", obs.text);
    await publish("screenshot", obs.screenshot);
    // The navigation artifact is the metadata record's summary plus the artifacts published before it (it cannot name itself).
    await publish("navigation", Buffer.from(JSON.stringify({ ...recording, artifacts: [...artifacts] })));
    return assembleReceipt({ job: opts.job, worker: opts.worker, generation: opts.generation, fetch, artifacts });
  });
}

// The receipt's one shape, key order fixed: the broker parses it exactly.
export function assembleReceipt(r: { job: string; worker: string; generation: number; fetch: FetchMeta; artifacts: WorkerArtifact[] }): CaptureWorkerReceipt {
  const roles = r.artifacts.map((a) => a.role);
  if (new Set(roles).size !== roles.length) throw new Error("capture receipt names a role twice");
  return { job: r.job, worker: r.worker, generation: r.generation, mode: "browser", captureMethod: "cdp", fetch: r.fetch, artifacts: r.artifacts };
}

// The worker's identity, as browser-capture.ts main() reads it: the controller's POMTREE_AGENT_ID and POMTREE_AGENT_GENERATION.
export function workerIdentity(env: Readonly<Record<string, string | undefined>>): { worker: string; generation: number } {
  const worker = env.POMTREE_AGENT_ID ?? "";
  const generation = /^\d{1,9}$/.test(env.POMTREE_AGENT_GENERATION ?? "") ? Number(env.POMTREE_AGENT_GENERATION) : Number.NaN;
  if (!worker || !Number.isSafeInteger(generation)) throw new Error("explicit capture byte/deadline/identity bounds required");
  return { worker, generation };
}

interface WorkerSession extends CaptureSession {
  page: CapturePage & { title(): Promise<string> };
  cdp: CdpSessionLike;
  userAgent: string;
  mainFrameId(): Promise<string | null>;
}

async function main(): Promise<void> {
  // Before Chromium is touched: a missing, invalid or mismatched config or job document exits 1 with no receipt.
  const limits = captureLimits(readContainerConfig(process.env, { required: true }));
  const job = parseCaptureJob(process.env[CAPTURE_JOB_ENV], limits);
  const { worker, generation } = workerIdentity(process.env);
  const deadlineAt = Date.now() + job.deadlineMs;
  let chrome: ChildProcess | undefined;
  const open = async (): Promise<WorkerSession> => {
    chrome = startChromium(BROWSER_PROXY_URL);
    let exited = false;
    chrome.once("exit", () => (exited = true));
    chrome.once("error", () => (exited = true));
    let ready = false;
    while (!exited && Date.now() < deadlineAt) {
      if (await cdpReady()) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, CDP_READY_POLL_MS));
    }
    // The fixed phrase names connectOverCDP so capture-diagnostic.ts classifies it cdp_unavailable.
    if (!ready)
      throw new Error("browser capture could not attach: connectOverCDP endpoint unavailable (Chromium sandbox/CDP not ready; no --no-sandbox fallback)");
    const { chromium } = await import(PLAYWRIGHT_MODULE);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: Math.max(1, deadlineAt - Date.now()) });
    const userAgent = await contextUserAgent(browser, job.userAgent);
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: BROWSER_VIEWPORT, userAgent });
    const page = await context.newPage();
    const cdp = (await context.newCDPSession(page)) as CdpSessionLike;
    return {
      page,
      cdp,
      userAgent,
      mainFrameId: async () => ((await cdp.send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } }).frameTree?.frame?.id ?? null,
      close: () => context.close(),
    };
  };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pomtree-capture-")));
  try {
    const receipt = await runCaptureSession(
      open,
      job.deadlineMs,
      (session, at) =>
        captureRecorded(session.page, {
          url: job.url,
          maxBytes: job.maxBytes,
          deadlineMs: job.deadlineMs,
          deadlineAt: at,
          limits,
          worker,
          generation,
          job: job.job,
          userAgent: session.userAgent,
          // The total body budget is the per-response allocation bound: one archive never holds more recorded bodies than one main
          // response may be. Each body is kept up to the job's maxBytes, as the raw artifact is.
          recorder: createCdpRecorder(session.cdp, {
            perBodyMaxBytes: job.maxBytes,
            perBodyAllocationMaxBytes: limits.rawAllocationMaxBytes,
            totalMaxBytes: limits.rawAllocationMaxBytes,
          }),
          mainFrameId: session.mainFrameId,
          publish: async (data, name, mediaType, role) => {
            const file = join(dir, role);
            const sha256 = createHash("sha256").update(data).digest("hex");
            writeFileSync(file, data, { mode: 0o600 });
            return parseReportPublishJson(
              await pomtree(publishArgv(file, name, mediaType, captureIdempotencyKey(job.job, worker, generation, role, sha256))),
              sha256,
            );
          },
        }),
      CAPTURE_TEARDOWN_MS,
      deadlineAt,
    );
    await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(receipt)}\n`, (error) => (error ? reject(error) : resolve())));
  } finally {
    // This process owns Chromium (no shared browser here), so it is killed outright; its profile is container-local /tmp.
    chrome?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    // One line: the message of a fixed phrase, never page text (control characters collapsed in case a library message carries any).
    const message = error instanceof Error ? error.message : "capture worker failed";
    console.error(
      message
        .replace(/[\s\p{Cc}]+/gu, " ")
        .trim()
        .slice(0, 2000),
    );
    process.exit(1);
  }
}
