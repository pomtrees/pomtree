// Bounded real-DeepSeek follow-on scenario for hn-insight/synthesize. OFFLINE by default: the CLI loads and verifies a captured
// metadata artifact DIRECTORY (the layout written by scenario.mts) and prints the plan. --live-deepseek is a positive opt-in that
// is fail-closed in this build. Nothing here reads credentials, touches Docker or the network, or creates temporary resources.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BUDGET_MAX_MICROS, type InsightInput, type InsightItem, itemSourceUrl, MODEL_BINDING, validateInput } from "./insight.mts";
import { FEED_SOURCE, LIMIT_MAX, parseFeed, parseItem, selectRanked } from "./logic.mts";
import { SHA256_HEX } from "./digest-hash.mts";

export const PROVIDER = "deepseek";
export const MODEL = "deepseek-flash";
export const UPSTREAM_ORIGIN = "https://api.deepseek.com";
export const CHAT_PATH = "/chat/completions";
export const MAX_ATTEMPTS = 2;
export const MAX_OUTPUT_TOKENS = 1024;
export const REQUEST_TIMEOUT_MS = 60_000;
export const SCENARIO_TIMEOUT_MS = 180_000;
export const TOTAL_BUDGET_MICROS = 100_000;
export const ITEMS_MAX = 3;

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });

export interface AttemptState {
  attempts: number; // actual upstream POSTs dispatched through the wrapper
  rejected: number; // requests refused before dispatch (never reached the upstream)
}
// Conservative paid upper bound: every dispatched POST counts, including retries and failures.
export const paidUpperBound = (s: AttemptState): number => s.attempts;

export interface AttemptMetric {
  attempt: number;
  model: string;
  maxTokens: number;
  status?: number;
  bodySha256?: string;
  promptTokens?: number;
  completionTokens?: number;
  truncated?: boolean; // response body exceeded RESPONSE_MAX_BYTES; not hashed
  failed?: boolean; // dispatched but the transport/body read threw (network error, timeout, abort)
  cleanupFailed?: boolean; // body cancellation rejected or did not join within RESPONSE_CANCEL_TIMEOUT_MS
}
export const RESPONSE_MAX_BYTES = 262_144;
export const RESPONSE_CANCEL_TIMEOUT_MS = 250;

// A body stream supplied by a transport need not react to abort on its own. Observe the same request deadline here too.
function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Join ordinary cancellation, but never await an uncooperative cancel (or an unread external tee sibling) forever.
// The losing cancellation promise has rejection handling; an incomplete join is exposed in the metric, not hidden.
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.cancel().then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), RESPONSE_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Retains at most `max` bytes, never a view into an arbitrarily large transport-owned backing buffer. No cloning/teeing.
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>, max: number, signal: AbortSignal): Promise<{ bytes: Buffer; truncated: boolean }> {
  const bytes = Buffer.alloc(max);
  let total = 0;
  for (;;) {
    const { done, value } = await withAbort(reader.read(), signal);
    if (done) return { bytes: bytes.subarray(0, total), truncated: false };
    if (value.byteLength > max - total) return { bytes: Buffer.alloc(0), truncated: true };
    bytes.set(value, total);
    total += value.byteLength;
  }
}

// Pure pre-dispatch guard. Refuses anything except one POST to the direct DeepSeek chat-completions route, for the pinned
// model, with an explicit bounded max_tokens, while attempts remain. Never reads headers or returns them.
export function guardUpstreamRequest(url: string, init: RequestInit | undefined, state: AttemptState): Verdict {
  if (state.attempts >= MAX_ATTEMPTS) return no(`attempt cap ${MAX_ATTEMPTS} reached`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return no("malformed upstream url");
  }
  if (u.origin !== UPSTREAM_ORIGIN) return no("upstream origin is not the direct DeepSeek origin");
  if (u.pathname !== CHAT_PATH || u.search !== "" || u.hash !== "") return no("upstream path is not the chat-completions route");
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return no("method must be POST");
  if (typeof init?.body !== "string") return no("body must be a JSON string");
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return no("body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return no("body must be an object");
  const b = body as Record<string, unknown>;
  if (b.model !== MODEL) return no(`model must be ${MODEL}`);
  if (typeof b.max_tokens !== "number" || !Number.isSafeInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > MAX_OUTPUT_TOKENS) {
    return no(`max_tokens must be an integer 1..${MAX_OUTPUT_TOKENS}`);
  }
  return { ok: true };
}

// Wraps an upstream fetch so the guard runs BEFORE dispatch. Refused calls never reach `inner`. Metrics carry only safe fields.
export function createCountingFetch(
  inner: typeof globalThis.fetch,
  state: AttemptState,
  onMetric: (m: AttemptMetric) => void = () => {},
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const verdict = guardUpstreamRequest(url, init, state);
    if (!verdict.ok) {
      state.rejected++;
      throw new Error(`upstream call refused before dispatch: ${verdict.reason}`);
    }
    state.attempts++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; max_tokens: number };
    const attempt = state.attempts;
    // Redirects are never followed: a 3xx could otherwise replay Authorization to another origin.
    const transport = new AbortController();
    const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), transport.signal]);
    // Ref'ed for the operation's lifetime: a stalled read must time out, not leave an unresolved promise at process exit.
    const timer = setTimeout(() => transport.abort(new Error("upstream request deadline reached")), REQUEST_TIMEOUT_MS);
    const metric: AttemptMetric = { attempt, model: body.model, maxTokens: body.max_tokens };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let consumed = false;
    let refused = false;
    try {
      const res = await inner(input, { ...init, redirect: "manual", signal });
      metric.status = res.status;
      reader = res.body?.getReader();
      if (res.status >= 300 && res.status < 400) {
        refused = true;
        throw new Error(`upstream returned redirect ${res.status}; not followed`);
      }
      const { bytes, truncated } = reader ? await readCapped(reader, RESPONSE_MAX_BYTES, signal) : { bytes: Buffer.alloc(0), truncated: false };
      if (truncated) {
        metric.truncated = true;
        refused = true;
        throw new Error(`upstream response exceeds ${RESPONSE_MAX_BYTES} bytes; refused`);
      }
      consumed = true;
      metric.bodySha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        const usage = (JSON.parse(bytes.toString("utf8")) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
        // Only bounded numeric token counts belong in safe metrics; provider output is untrusted.
        const tokenCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
        if (tokenCount(usage?.prompt_tokens)) metric.promptTokens = usage.prompt_tokens;
        if (tokenCount(usage?.completion_tokens)) metric.completionTokens = usage.completion_tokens;
      } catch {
        // non-JSON body: counted as an attempt, no token detail
      }
      // Consume the ORIGINAL, then rebuild; cloning here would leave an unread tee branch buffering the entire body.
      return new Response(res.body === null ? null : new Uint8Array(bytes), { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      if (!refused) metric.failed = true;
      throw e;
    } finally {
      try {
        if (!consumed) transport.abort(new Error("upstream response refused or failed"));
        if (reader) {
          try {
            if (!consumed && !(await cancelReader(reader))) metric.cleanupFailed = true;
          } finally {
            reader.releaseLock();
          }
        }
      } finally {
        clearTimeout(timer);
        onMetric(metric);
      }
    }
  };
}

// Captured source artifact: the directory written by scenario.mts (actual producer wins):
//   <dir>/manifest.json            { status: "passed", live: boolean, ... }
//   <dir>/source/sources.json      array of { url, status, sha256, fetchedAt, bytes, file }
//   <dir>/source/raw/<sha256>.json raw HN bodies (feed = id array, item = item object)
// Raw sha256 values are provenance and are verified against the bytes. They are kept apart from the normalized input hash.
export const RAW_MAX_BYTES = 262_144;
export const INDEX_MAX_BYTES = 262_144;
export const MANIFEST_MAX_BYTES = 262_144;
export const SOURCES_MAX = 13; // 3 feed dispatches + 10 item dispatches

export interface SourceProvenance {
  id: number;
  url: string;
  rawSha256: string;
  bytes: number;
  fetchedAt: number;
}
export type SourceLoad =
  | { ok: false; reason: string }
  | {
      ok: true;
      items: InsightItem[];
      live: boolean;
      feed: { url: string; rawSha256: string; bytes: number; fetchedAt: number };
      provenance: SourceProvenance[];
    };

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

// Reads a file whole only after its size is known to be within `max`; the read itself is also capped (no unbounded reads).
function readBounded(path: string, max: number, what: string): Buffer {
  // Nonblocking open plus fstat avoids hanging on a FIFO disguised as a JSON file. Only regular files may be read.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return refuse(`${what} must be a regular file`);
    if (stat.size > max) return refuse(`${what} exceeds ${max} bytes`);
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) return refuse(`${what} exceeds ${max} bytes`);
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function parseJson(buf: Buffer, what: string): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return refuse(`${what} is not valid JSON`);
  }
}

const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

interface IndexRecord {
  url: string;
  status: number;
  sha256: string;
  fetchedAt: number;
  bytes: number;
  file: string;
}

function loadVerified(dir: string, opts: { requireLive: boolean }): Extract<SourceLoad, { ok: true }> {
  if (!statSync(dir).isDirectory()) return refuse("source artifact must be a directory (as written by scenario.mts)");
  const root = realpathSync(dir);
  const within = (base: string, p: string, what: string): string => {
    let r: string;
    try {
      r = realpathSync(p);
    } catch {
      return refuse(`${what} is missing or dangling`);
    }
    return r.startsWith(base + sep) ? r : refuse(`${what} escapes the artifact directory`);
  };
  const manifest = parseJson(readBounded(within(root, resolve(root, "manifest.json"), "manifest.json"), MANIFEST_MAX_BYTES, "manifest.json"), "manifest.json");
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return refuse("manifest.json must be an object");
  const m = manifest as { status?: unknown; live?: unknown };
  if (m.status !== "passed") return refuse("source manifest status is not passed");
  if (typeof m.live !== "boolean") return refuse("source manifest live flag missing");
  if (opts.requireLive && m.live !== true) return refuse("source artifact is not a live capture; refusing paid run");

  const sourceRoot = within(root, resolve(root, "source"), "source directory");
  const rawRoot = within(sourceRoot, resolve(sourceRoot, "raw"), "source/raw directory");
  const index = parseJson(
    readBounded(within(sourceRoot, resolve(sourceRoot, "sources.json"), "source/sources.json"), INDEX_MAX_BYTES, "source/sources.json"),
    "source/sources.json",
  );
  if (!Array.isArray(index)) return refuse("source/sources.json must be an array");
  if (index.length > SOURCES_MAX) return refuse(`source/sources.json has more than ${SOURCES_MAX} records`);
  const records: IndexRecord[] = index.map((r, i) => {
    const o = r as Partial<IndexRecord> | null;
    if (typeof o !== "object" || o === null) return refuse(`source record ${i} is not an object`);
    if (typeof o.url !== "string" || typeof o.file !== "string") return refuse(`source record ${i} lacks url or file`);
    if (typeof o.sha256 !== "string" || !SHA256_HEX.test(o.sha256)) return refuse(`source record ${i} has a malformed sha256`);
    if (!isInt(o.status) || !isInt(o.fetchedAt) || !isInt(o.bytes)) return refuse(`source record ${i} has non-integer status, fetchedAt or bytes`);
    return o as IndexRecord;
  });

  // Reads one raw body: realpath-fenced under source/raw, size-checked before reading, hash and byte-count verified.
  const readRaw = (r: IndexRecord): unknown => {
    if (r.bytes > RAW_MAX_BYTES) return refuse(`raw body for ${r.url} exceeds ${RAW_MAX_BYTES} bytes`);
    const p = within(rawRoot, resolve(root, r.file), `raw file for ${r.url}`);
    const raw = readBounded(p, RAW_MAX_BYTES, `raw file for ${r.url}`);
    if (raw.length !== r.bytes) return refuse(`raw byte count mismatch for ${r.url}`);
    if (createHash("sha256").update(raw).digest("hex") !== r.sha256) return refuse(`raw hash mismatch for ${r.url}`);
    return parseJson(raw, `raw body for ${r.url}`);
  };

  const feedRec = records.find((r) => r.url === FEED_SOURCE && r.status === 200);
  if (!feedRec) return refuse("no successful feed record in the artifact");
  let ids: number[];
  try {
    ids = parseFeed(readRaw(feedRec));
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return refuse(e instanceof Error ? e.message : "feed is malformed");
  }
  const byUrl = new Map<string, IndexRecord>();
  for (const r of records) if (r.status === 200 && !byUrl.has(r.url)) byUrl.set(r.url, r);

  // Feed order decides rank; ranked ids with no usable captured item are skipped, never fetched.
  const items: InsightItem[] = [];
  const provenance: SourceProvenance[] = [];
  for (const { id, rank } of selectRanked(ids, [], LIMIT_MAX)) {
    if (items.length >= ITEMS_MAX) break;
    const rec = byUrl.get(itemSourceUrl(id));
    if (!rec) continue;
    const parsed = parseItem(readRaw(rec), id);
    if (!parsed.ok) continue;
    const it = parsed.item;
    items.push({
      id,
      rank,
      title: it.title,
      text: it.text,
      ...(it.score !== undefined && { score: it.score }),
      ...(it.descendants !== undefined && { descendants: it.descendants }),
      sourceUrl: itemSourceUrl(id),
      sha256: rec.sha256,
    });
    provenance.push({ id, url: rec.url, rawSha256: rec.sha256, bytes: rec.bytes, fetchedAt: rec.fetchedAt });
  }
  if (items.length === 0) return refuse("artifact has no usable captured items");
  return {
    ok: true,
    items,
    live: m.live,
    feed: { url: feedRec.url, rawSha256: feedRec.sha256, bytes: feedRec.bytes, fetchedAt: feedRec.fetchedAt },
    provenance,
  };
}

// Never throws: filesystem and parse failures become a refusal reason.
export function loadSourceArtifact(dir: string, opts: { requireLive: boolean }): SourceLoad {
  try {
    return loadVerified(dir, opts);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message };
    const code = (e as { code?: string }).code;
    return { ok: false, reason: `source artifact unreadable${code ? ` (${code})` : ""}` };
  }
}

export function buildInput(load: Extract<SourceLoad, { ok: true }>, budgetMicros: number): { ok: true; input: InsightInput } | { ok: false; reason: string } {
  const v = validateInput({ instance: "hn-model-run", items: load.items, budgetMicros, ask: true });
  return v.ok ? { ok: true, input: v.value } : { ok: false, reason: v.error };
}

export interface ScenarioManifest {
  provider: string;
  model: string;
  binding: string;
  route: string;
  mode: "dry-run" | "live";
  items: number;
  budgetMicros: number;
  attempts: number;
  rejected: number;
  metrics: AttemptMetric[];
  sourceLive?: boolean;
  feed?: { url: string; rawSha256: string; bytes: number; fetchedAt: number };
  provenance?: SourceProvenance[];
  inputSha256?: string; // normalized input hash; distinct from the raw provenance hashes
  refused?: string;
}

// Offline runner. `backend` is a scripted fetch for tests; the default is none, so no network is ever reachable from here.
// No temporary resources are created.
export async function runModelScenario(o: {
  sourceDir: string;
  budgetMicros?: number;
  backend?: typeof globalThis.fetch;
  mode?: "dry-run" | "live";
}): Promise<ScenarioManifest> {
  const budget = o.budgetMicros ?? TOTAL_BUDGET_MICROS;
  if (budget < 1 || budget > TOTAL_BUDGET_MICROS || budget > BUDGET_MAX_MICROS) throw new Error("budget outside the authorized total");
  const base = {
    provider: PROVIDER,
    model: MODEL,
    binding: MODEL_BINDING,
    route: `${UPSTREAM_ORIGIN}${CHAT_PATH}`,
    mode: o.mode ?? "dry-run",
    budgetMicros: budget,
  };
  const refused = (reason: string): ScenarioManifest => ({ ...base, items: 0, attempts: 0, rejected: 0, metrics: [], refused: reason });
  const load = loadSourceArtifact(o.sourceDir, { requireLive: false });
  if (!load.ok) return refused(load.reason);
  const built = buildInput(load, budget);
  if (!built.ok) return refused(built.reason);
  const state: AttemptState = { attempts: 0, rejected: 0 };
  const metrics: AttemptMetric[] = [];
  if (o.backend) {
    // A scripted backend is only reachable through the guard; the single allowed probe uses the pinned route and cap.
    const guarded = createCountingFetch(o.backend, state, (m) => metrics.push(m));
    await guarded(`${UPSTREAM_ORIGIN}${CHAT_PATH}`, {
      method: "POST",
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, messages: [] }),
    }).catch(() => {});
  }
  return {
    ...base,
    items: built.input.items.length,
    attempts: state.attempts,
    rejected: state.rejected,
    metrics,
    sourceLive: load.live,
    feed: load.feed,
    provenance: load.provenance,
    inputSha256: createHash("sha256").update(JSON.stringify(built.input)).digest("hex"),
  };
}

async function main(argv: string[]): Promise<number> {
  const live = argv.includes("--live-deepseek");
  const i = argv.indexOf("--source-artifact");
  const path = i >= 0 ? argv[i + 1] : undefined;
  if (!path) {
    console.error("usage: node examples/hn-digest/model-scenario.mts [--live-deepseek] --source-artifact DIR");
    return 2;
  }
  if (live) {
    // TODO(hn-model-live): the positive branch must call openModelRuntime (DockerSandbox, controller proxy, scoped keys,
    // capped fetch, canonical CLI launch of hn-insight/capture then hn-insight/synthesize). Not wired in this build: no
    // credentials are read, no network, no Docker.
    const check = loadSourceArtifact(path, { requireLive: true });
    if (!check.ok) console.error(`source artifact refused: ${check.reason}`);
    console.error("TODO(hn-model-live): live branch not wired in this build; requires coordinator go-ahead. No credentials were read.");
    return 3;
  }
  const manifest = await runModelScenario({ sourceDir: path, mode: "dry-run" });
  console.log(JSON.stringify(manifest, null, 2));
  return manifest.refused ? 1 : 0;
}

// Source capture guard (HN official API, GET only, serial, pre-dispatch). Pure: the caller's transport is injected elsewhere.
export const HN_HOST = "hacker-news.firebaseio.com";
export const HN_ITEM_CAP = 10;
export const HN_FEED_CAP = 3;
export const HN_REQUEST_TIMEOUT_MS = 10_000;
export const HN_BODY_MAX_BYTES = 262_144;
export interface SourceBudget {
  items: number;
  feeds: number;
}
// Remaining budget derived from the ORIGINAL metadata manifest counts (never from responses). Refuses negative remainders.
export function remainingSourceBudget(original: SourceBudget): SourceBudget | { refused: string } {
  if (!Number.isSafeInteger(original.items) || !Number.isSafeInteger(original.feeds) || original.items < 0 || original.feeds < 0) {
    return { refused: "original source counts must be non-negative integers" };
  }
  if (original.items > HN_ITEM_CAP || original.feeds > HN_FEED_CAP) return { refused: "original source counts already exceed the caps" };
  return { items: HN_ITEM_CAP - original.items, feeds: HN_FEED_CAP - original.feeds };
}
// Attaches captured discussion samples to their stories by actual storyId (never by position). At most 2 per story.
export function mapDiscussionToItems<T extends { id: number; discussion?: unknown[] }>(items: readonly T[], samples: readonly { storyId: number }[]): T[] {
  return items.map((it) => {
    const mine = samples.filter((s) => s.storyId === it.id).slice(0, 2);
    return mine.length === 0 ? { ...it } : { ...it, discussion: mine };
  });
}
export function guardSourceRequest(url: string, method: string, allowedKidIds: ReadonlySet<number>, budget: SourceBudget): Verdict {
  if ((method ?? "GET").toUpperCase() !== "GET") return no("source method must be GET");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return no("malformed source url");
  }
  if (u.protocol !== "https:" || u.hostname !== HN_HOST || u.port !== "" || u.username !== "" || u.password !== "")
    return no("source origin is not official HN");
  const feed = /^\/v0\/(topstories|newstories)\.json$/.exec(u.pathname);
  const item = /^\/v0\/item\/(\d+)\.json$/.exec(u.pathname);
  if (u.search !== "" || u.hash !== "") return no("source url must have no query or fragment");
  // Independent caps: items <= 10 and feeds <= 3. Comment-phase GETs never read a feed (the caller passes only preselected kids).
  if (feed) return no("feed reads are not allowed from the comment phase");
  if (item) {
    const id = Number(item[1]);
    if (!Number.isSafeInteger(id) || id <= 0 || !allowedKidIds.has(id)) return no("item id is not a preselected direct kid");
    if (budget.items >= HN_ITEM_CAP) return no("source item budget exhausted");
    return { ok: true };
  }
  return no("source path is not an allowed feed or item");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
