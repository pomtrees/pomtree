// HN discussion evidence: bounded depth-1 comment samples and grounding for tentative sentiment. Captured-sample only.
// Pure helpers, zero I/O. Input is untrusted remote JSON; parsers classify rather than throw. Kids are ranked DISPLAY order,
// not chronological. Sentiment labels are model output validated against captured comment IDs; no keyword heuristics.
import { plainText, sanitizeHtml } from "./logic.mts";
import { SHA256_HEX } from "./digest-hash.mts";

export const ITEM_ORIGIN = "https://hacker-news.firebaseio.com/v0/item/";
export const DISCUSSION_TEXT_MAX = 1000;
export const KIDS_MAX = 500;
export const TARGET_MAX = 160;
export const SUMMARY_MAX = 400;
export const SENTIMENT_SCOPE = "captured_depth1_sample_only" as const;
const LABELS: ReadonlySet<string> = new Set(["positive", "negative", "mixed", "unclear"]);

export type DiscussionStatus = "usable" | "deleted" | "dead" | "null" | "malformed" | "wrong_parent" | "missing_text" | "unavailable" | "interrupted";

// Public facts only: no author fields, no profile data, no recursive kids.
export type DiscussionSample = {
  id: number;
  storyId: number;
  sourceUrl: string;
  sha256: string;
  fetchedAt: number;
  status: DiscussionStatus;
  parent?: number;
  time?: number;
  text: string;
};

export type SentimentLabel = "positive" | "negative" | "mixed" | "unclear" | "insufficient_discussion_data";

export type SampleSentiment = {
  label: SentimentLabel;
  target: string;
  summary: string;
  citations: number[];
  scope: typeof SENTIMENT_SCOPE;
  tentative: true;
};

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Official item URL, computed from the ID only. Never taken from remote data.
export function sourceUrlOf(id: number): string {
  if (!isId(id)) throw new TypeError("sourceUrlOf: id must be a positive safe integer");
  return `${ITEM_ORIGIN}${id}.json`;
}

// First `limit` unique safe IDs in kids order (ranked display order). Invalid and repeated entries are skipped.
// Throws on a non-array or on more than KIDS_MAX entries; callers validate before use.
export function selectDiscussionIds(kids: unknown, limit: number = 2): number[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > KIDS_MAX) throw new RangeError(`limit must be an integer 1..${KIDS_MAX}`);
  if (!Array.isArray(kids)) throw new TypeError("kids: expected an array");
  if (kids.length > KIDS_MAX) throw new RangeError(`kids: more than ${KIDS_MAX} entries`);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of kids) {
    if (out.length >= limit) break;
    if (!isId(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Classifies one item response for a comment ID under a story. Usable only when the ID matches, type is comment,
// parent is exactly the story, and sanitized text is non-empty. Parent and time are copied only when the raw record has them.
export function parseDiscussion(raw: unknown, expectedId: number, storyId: number, meta: { sha256: string; fetchedAt: number }): DiscussionSample {
  if (!isId(expectedId) || !isId(storyId)) throw new TypeError("parseDiscussion: ids must be positive safe integers");
  if (!SHA256_HEX.test(meta.sha256) || !Number.isSafeInteger(meta.fetchedAt) || meta.fetchedAt < 0) {
    throw new TypeError("parseDiscussion: meta requires a sha256 hex digest and a non-negative integer fetchedAt");
  }
  const base = { id: expectedId, storyId, sourceUrl: sourceUrlOf(expectedId), sha256: meta.sha256, fetchedAt: meta.fetchedAt };
  const out = (status: DiscussionStatus, rec: Record<string, unknown> | null, text: string): DiscussionSample => {
    const s: DiscussionSample = { ...base, status, text };
    if (rec !== null) {
      if (isId(rec.parent)) s.parent = rec.parent;
      if (isId(rec.time)) s.time = rec.time;
    }
    return s;
  };
  if (raw === null || raw === undefined) return out("null", null, "");
  if (!isRecord(raw)) return out("malformed", null, "");
  if (raw.deleted === true) return out("deleted", raw, "");
  if (raw.dead === true) return out("dead", raw, "");
  if (raw.id !== expectedId || raw.type !== "comment") return out("malformed", raw, "");
  if (raw.parent !== storyId) return out("wrong_parent", raw, "");
  const text = typeof raw.text === "string" ? sanitizeHtml(raw.text, DISCUSSION_TEXT_MAX) : "";
  if (text === "") return out("missing_text", raw, "");
  return out("usable", raw, text);
}

// Grounds a model's sentiment output in USABLE captured comments of one story. Returns null for invalid model output so the
// caller falls back to no sentiment. Zero usable comments yield a deterministic insufficient result and ignore the model.
// One usable comment is forced to "unclear". Two or more accept the four labels. Extra fields (score, confidence) are dropped.
export function normalizeSentiment(raw: unknown, storyId: number, samples: readonly DiscussionSample[]): SampleSentiment | null {
  if (!isId(storyId)) throw new TypeError("normalizeSentiment: storyId must be a positive safe integer");
  const usable = samples.filter((s) => s.status === "usable" && s.storyId === storyId && s.parent === storyId);
  const target = `captured HN comments on story ${storyId}`;
  if (usable.length === 0) {
    return {
      label: "insufficient_discussion_data",
      target,
      summary: "No usable captured comments; no sentiment is inferred from this sample.",
      citations: [],
      scope: SENTIMENT_SCOPE,
      tentative: true,
    };
  }
  if (!isRecord(raw)) return null;
  if (typeof raw.target !== "string" || typeof raw.summary !== "string" || !Array.isArray(raw.citations)) return null;
  const cleanTarget = plainText(raw.target, TARGET_MAX);
  const summary = plainText(raw.summary, SUMMARY_MAX);
  if (cleanTarget === "" || summary === "") return null;
  const allowed = new Set(usable.map((s) => s.id));
  const citations: number[] = [];
  for (const c of raw.citations) {
    if (!isId(c) || !allowed.has(c) || citations.includes(c)) return null;
    citations.push(c);
  }
  if (citations.length === 0) return null;
  let label: SentimentLabel;
  if (usable.length === 1) {
    label = "unclear";
  } else {
    if (typeof raw.label !== "string" || !LABELS.has(raw.label)) return null;
    label = raw.label as SentimentLabel;
  }
  return { label, target: cleanTarget, summary, citations, scope: SENTIMENT_SCOPE, tentative: true };
}
