// HN digest pure helpers: ranked-feed proxy, not velocity. Extracted fields only; no model analysis.
// Zero imports. No I/O. Input is untrusted remote JSON; every field is checked before use.

export const FEED_SOURCE = "https://hacker-news.firebaseio.com/v0/topstories.json";
export const ITEM_SOURCE_PREFIX = "https://hacker-news.firebaseio.com/v0/item/";
export const DISCUSSION_PREFIX = "https://news.ycombinator.com/item?id=";
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 10;
export const TITLE_MAX = 300;
export const ITEM_TEXT_MAX = 400;
export const SANITIZE_DEFAULT_MAX = 2000;
export const REPORT_MAX = 65536;
export const URL_MAX = 2048;
export const CAUSE_MAX = 160;

const ALLOWED_TYPES: ReadonlySet<string> = new Set(["story", "job", "poll"]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export type ParsedItem = {
  id: number;
  title: string;
  text: string;
  url?: string;
  type: string;
  by?: string;
  time?: number;
  score?: number;
  descendants?: number;
};

export type ItemResult = { ok: true; item: ParsedItem } | { ok: false; cause: string };

export type DigestEntry = ParsedItem & {
  rank: number;
  itemSource: string;
  itemHash: string;
};

export type DigestPlan = {
  schema: "hn-digest/1";
  instance: string;
  runId: string;
  fetchedAt: string;
  feedSource: string;
  feedHash: string;
  rankBasis: "ranked-feed-position";
  limit: number;
  entries: DigestEntry[];
  // detail: errorCause of the fetch/parse failure, when one was thrown (never the raw message).
  skipped: Array<{ id: number; cause: string; detail?: string }>;
  // feedIds: distinct ids the feed returned; feedSeen: how many of those were already seen. Together they tell an
  // all-seen feed apart from a short one in the report.
  provenance: { seenBefore: number; feedIds: number; feedSeen: number; insights: "none" };
};

function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// Returns the feed's IDs in order, validated. Throws on any malformed entry.
// Duplicate removal happens in selectRanked, so each ID keeps its original 1-based feed position.
export function parseFeed(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new TypeError("feed: expected an array");
  const ids: number[] = [];
  raw.forEach((v: unknown, i: number) => {
    if (!isId(v)) throw new TypeError(`feed: entry ${i} is not a positive safe integer`);
    ids.push(v);
  });
  return ids;
}

// Selects unseen IDs in feed order. rank is the 1-based position in the original feed (first occurrence of a duplicate).
export function selectRanked(ids: number[], seen: readonly number[], limit: number): Array<{ id: number; rank: number }> {
  if (!Number.isSafeInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) {
    throw new RangeError(`limit must be an integer ${LIMIT_MIN}..${LIMIT_MAX}`);
  }
  for (const id of ids) if (!isId(id)) throw new TypeError("selectRanked: ids must be positive safe integers");
  const skip = new Set<number>(seen);
  const taken = new Set<number>();
  const out: Array<{ id: number; rank: number }> = [];
  ids.forEach((id, i) => {
    if (out.length >= limit || taken.has(id) || skip.has(id)) return;
    taken.add(id);
    out.push({ id, rank: i + 1 });
  });
  return out;
}

// Feed coverage for the report: distinct feed ids, and how many of them were already seen.
export function feedCounts(ids: readonly number[], seen: readonly number[]): { feedIds: number; feedSeen: number } {
  const done = new Set<number>(seen);
  const distinct = new Set<number>(ids);
  let feedSeen = 0;
  for (const id of distinct) if (done.has(id)) feedSeen++;
  return { feedIds: distinct.size, feedSeen };
}

const CREDENTIAL = /\b(token|secret|password|passwd|api[_-]?key|key|auth|authorization|sig|signature|cookie)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
// A thrown fetch/parse failure as a short operator-facing cause: the error name, a closed-shape code (ECONNRESET), and the
// message with URL query strings and credential-looking values removed, clipped to CAUSE_MAX. The raw message never leaves.
export function errorCause(e: unknown): string {
  if (!(e instanceof Error)) return "non-error value thrown";
  const name = /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
  const code = (e as { code?: unknown }).code;
  const head = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? `${name} ${code}` : name;
  const msg = e.message
    .replace(/\?[^\s#]*/g, "?[query]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(CREDENTIAL, "$1$2[redacted]");
  return plainText(msg === "" ? head : `${head}: ${msg}`, CAUSE_MAX);
}

// Validates one item response against the ID that was requested. Returns a skip cause instead of throwing.
export function parseItem(raw: unknown, expectedId: number): ItemResult {
  if (raw === null || raw === undefined) return fail("null");
  if (!isRecord(raw)) return fail("malformed");
  if (raw.deleted === true) return fail("deleted");
  if (raw.dead === true) return fail("dead");
  if (raw.id !== expectedId) return fail("id_mismatch");
  if (typeof raw.type !== "string" || !ALLOWED_TYPES.has(raw.type)) return fail("unexpected_type");
  if (typeof raw.title !== "string") return fail("missing_title");
  const title = plainText(sanitizeHtml(raw.title, TITLE_MAX).replace(/\s+/g, " "), TITLE_MAX);
  if (title === "") return fail("missing_title");

  const item: ParsedItem = {
    id: expectedId,
    title,
    text: typeof raw.text === "string" ? sanitizeHtml(raw.text, ITEM_TEXT_MAX) : "",
    type: raw.type,
  };
  if (typeof raw.url === "string") {
    const url = articleUrl(raw.url);
    if (url !== undefined) item.url = url;
  }
  if (typeof raw.by === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.by)) item.by = raw.by;
  if (typeof raw.time === "number" && isId(raw.time)) item.time = raw.time;
  if (isCount(raw.score)) item.score = raw.score;
  if (isCount(raw.descendants)) item.descendants = raw.descendants;
  return { ok: true, item };

  function fail(cause: string): ItemResult {
    return { ok: false, cause };
  }
}

// Only http(s) article links without credentials or whitespace/control characters. Empty or invalid -> undefined.
export function articleUrl(raw: string): string | undefined {
  const t = raw.trim();
  if (t.length > URL_MAX) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in untrusted URLs
  if (t === "" || /[\u0000-\u0020\u007F-\u009F]/.test(t)) return undefined;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  // The bound applies to the serialized URL: parsing can expand the raw input (punycode, percent-encoding).
  if (u.href.length > URL_MAX) return undefined;
  return u.href;
}

// Decodes and removes HTML: script/style blocks (including unclosed ones) with content, comments, tags.
// Entities decode in one pass, so "&amp;lt;" becomes the text "&lt;", not "<". Invalid code points become U+FFFD.
export function sanitizeHtml(raw: string, maxChars: number = SANITIZE_DEFAULT_MAX): string {
  if (typeof raw !== "string") throw new TypeError("sanitizeHtml: expected a string");
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new RangeError("sanitizeHtml: maxChars must be a positive integer");
  let s = raw;
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, " ");
  s = s.replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?p\b[^>]*>/gi, "\n");
  s = s.replace(/<\/?[A-Za-z!][^>]*>/g, "");
  s = s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{1,31});/g, (m: string, body: string) => decodeEntity(body, m));
  return plainText(s, maxChars);
}

function decodeEntity(body: string, literal: string): string {
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
    return String.fromCodePoint(code);
  }
  const named = NAMED_ENTITIES[body];
  return named === undefined ? literal : named;
}

// Removes controls, bidi overrides and zero-width characters; breaks @-mentions; collapses whitespace; clips by code point.
export function plainText(raw: string, maxChars: number = SANITIZE_DEFAULT_MAX): string {
  let s = raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from untrusted text
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  s = s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  s = s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  s = s.replace(/@(?=\w)/g, "@ ");
  s = s
    .replace(/[ \f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(s, maxChars);
}

export function clip(s: string, maxChars: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

// Renders a plan to report text. Throws on a structurally invalid plan; never fabricates analysis.
export function renderDigest(plan: DigestPlan): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(plan.instance)) throw new TypeError("renderDigest: invalid instance name");
  if (typeof plan.runId !== "string" || plan.runId === "") throw new TypeError("renderDigest: runId required");
  if (!Number.isFinite(Date.parse(plan.fetchedAt))) throw new TypeError("renderDigest: fetchedAt must be a date");
  const { feedIds, feedSeen, seenBefore } = plan.provenance;
  if (!isCount(feedIds) || !isCount(feedSeen) || feedSeen > feedIds || !isCount(seenBefore)) {
    throw new TypeError("renderDigest: provenance feedIds, feedSeen and seenBefore must be counts with feedSeen <= feedIds");
  }
  const coverage = `feed ${feedIds} ids, ${feedSeen} seen`;
  const lines: string[] = [
    `HN ranked digest · instance ${plan.instance} · run ${plan.runId}`,
    `Fetched ${plan.fetchedAt} from ${plan.feedSource} (feed sha256:${plan.feedHash})`,
    "Ranked feed position: a proxy, not velocity. Extracted fields only; no model analysis.",
    "",
  ];
  if (plan.entries.length === 0) {
    lines.push(`No new posts (${coverage}).`);
  } else {
    lines.push(`New posts: ${plan.entries.length} (limit ${plan.limit}; ${coverage}; seen before: ${seenBefore})`, "");
    for (const e of plan.entries) {
      if (!isId(e.id) || !isId(e.rank)) throw new TypeError("renderDigest: entry ids and ranks must be positive integers");
      lines.push(`${e.rank}. ${plainText(e.title, TITLE_MAX)}`);
      const meta = [`rank ${e.rank}`, e.type];
      if (e.by !== undefined) meta.push(`by ${e.by}`);
      if (e.score !== undefined) meta.push(`score ${e.score}`);
      if (e.descendants !== undefined) meta.push(`${e.descendants} comments`);
      if (e.time !== undefined) meta.push(`posted ${isoOf(e.time)}`);
      lines.push(`   ${meta.join(" · ")}`);
      const url = e.url === undefined ? undefined : articleUrl(e.url);
      if (url !== undefined) lines.push(`   article: ${url}`);
      lines.push(`   discussion: ${DISCUSSION_PREFIX}${e.id}`);
      if (e.text !== "") lines.push(`   text: ${plainText(e.text, ITEM_TEXT_MAX)}`);
      lines.push(`   item ${e.id} · source ${ITEM_SOURCE_PREFIX}${e.id}.json · sha256:${e.itemHash}`, "");
    }
  }
  lines.push(skipSummary(plan.skipped));
  return clip(lines.join("\n"), REPORT_MAX);
}

function isoOf(seconds: number): string {
  const d = new Date(seconds * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : "unknown time";
}

function skipSummary(skipped: ReadonlyArray<{ id: number; cause: string; detail?: string }>): string {
  if (skipped.length === 0) return "Skipped: 0";
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.cause, (counts.get(s.cause) ?? 0) + 1);
  const parts = [...counts.keys()].sort().map((c) => `${c}=${counts.get(c)}`);
  const details = skipped.flatMap((s) =>
    s.detail === undefined || !isId(s.id) ? [] : [`   item ${s.id} ${plainText(s.cause, 40)}: ${plainText(s.detail, CAUSE_MAX)}`],
  );
  return [`Skipped: ${skipped.length} (${parts.join(", ")}); skipped items are not marked seen`, ...details].join("\n");
}
