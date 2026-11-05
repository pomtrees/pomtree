// HN discussion capture: a reviewed workflow (`capture`) that reads at most 2 depth-1 comments per story from the official HN
// item API and persists them as a bounded sample. No feed, profile, article or model reads; no report, ask or spawn.
// Each comment is marked `interrupted` BEFORE its one GET, so a repaired task never refetches it. Comment IDs are never seen posts.
import type { JsonValue, WorkflowDef, WorkflowFetchResult, WorkflowRunContext } from "../../packages/core/src/index.ts";
import { type DiscussionSample, parseDiscussion, selectDiscussionIds, sourceUrlOf } from "./discussion.mts";
import { SHA256_HEX } from "./digest-hash.mts";

export const SCHEMA = "hn-discussion/1" as const;
export const FETCH_HOST = "hacker-news.firebaseio.com";
export const FETCH_MAX_REQUESTS = 6;
export const FETCH_MAX_BYTES = 262144;
export const FETCH_TIMEOUT_MS = 10000;
export const STORIES_MAX = 3;
export const KIDS_PER_STORY = 2;
const INSTANCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type DiscussionStory = { id: number; sha256: string; kids: number[] };
export type DiscussionInput = { instance: string; stories: DiscussionStory[] };
export type CommentRecord = { id: number; storyId: number; sample: DiscussionSample | null; cause: string | null };
export type CaptureState = {
  schema: typeof SCHEMA;
  runId: string;
  seq: number;
  phase: "capturing" | "complete";
  instance: string;
  stories: DiscussionStory[];
  comments: CommentRecord[];
};

export function validateDiscussionInput(input: JsonValue): { ok: true; value: DiscussionInput } | { ok: false; error: string } {
  if (!isRecord(input) || typeof input.instance !== "string" || !INSTANCE.test(input.instance)) {
    return { ok: false, error: "instance must be a safe name" };
  }
  if (!Array.isArray(input.stories) || input.stories.length < 1 || input.stories.length > STORIES_MAX) {
    return { ok: false, error: `stories must hold 1..${STORIES_MAX} entries` };
  }
  const stories: DiscussionStory[] = [];
  const storyIds = new Set<number>();
  const commentIds = new Set<number>();
  for (const s of input.stories) {
    if (!isRecord(s) || !isId(s.id) || typeof s.sha256 !== "string" || !SHA256_HEX.test(s.sha256) || !Array.isArray(s.kids)) {
      return { ok: false, error: "each story needs a positive integer id, a sha256 hex digest and a kids array" };
    }
    if (storyIds.has(s.id)) return { ok: false, error: `duplicate story ${s.id}` };
    storyIds.add(s.id);
    let kids: number[];
    try {
      kids = selectDiscussionIds(s.kids, KIDS_PER_STORY);
    } catch (e) {
      return { ok: false, error: `story ${s.id}: ${e instanceof Error ? e.message : "invalid kids"}` };
    }
    for (const k of kids) {
      if (commentIds.has(k)) return { ok: false, error: `comment ${k} appears under more than one story` };
      commentIds.add(k);
    }
    stories.push({ id: s.id, sha256: s.sha256, kids });
  }
  return { ok: true, value: { instance: input.instance, stories } };
}

// Persisted state is validated shallowly; a corrupt cell fails the task instead of guessing.
function parseState(raw: JsonValue | null): CaptureState | null {
  if (raw === null) return null;
  if (!isRecord(raw) || raw.schema !== SCHEMA || typeof raw.runId !== "string" || !Number.isSafeInteger(raw.seq)) {
    throw new Error("capture state is corrupt");
  }
  if (!Array.isArray(raw.comments) || !Array.isArray(raw.stories) || typeof raw.instance !== "string") {
    throw new Error("capture state is corrupt");
  }
  return raw as unknown as CaptureState;
}

// JSON round-trip drops undefined optional fields so the persisted value is strictly JSON.
const toJson = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

async function save(wf: WorkflowRunContext["workflow"], state: CaptureState): Promise<CaptureState> {
  const next = { ...state, seq: state.seq + 1 };
  // Mutation keys are per sequence number, so a replayed write returns the original and cannot collide with another value.
  await wf.setState(toJson(next), `${next.runId}:state:${next.seq}`);
  return next;
}

function withComment(state: CaptureState, i: number, rec: CommentRecord): CaptureState {
  return { ...state, comments: state.comments.map((c, j) => (j === i ? rec : c)) };
}

function failed(id: number, storyId: number, status: DiscussionSample["status"], cause: string, meta: WorkflowFetchResult | null) {
  const sample: DiscussionSample = {
    id,
    storyId,
    sourceUrl: sourceUrlOf(id),
    sha256: meta?.sha256 ?? "0".repeat(64),
    fetchedAt: meta?.fetchedAt ?? 0,
    status,
    text: "",
  };
  return { sample, cause };
}

// One GET per comment. Transport failures, timeouts and non-200 responses are recorded as `unavailable`; a body that is not
// JSON is recorded as `malformed`. Nothing is retried. A cancelled task rethrows so the host treats it as an interruption.
async function captureOne(ctx: WorkflowRunContext, id: number, storyId: number): Promise<{ sample: DiscussionSample; cause: string | null }> {
  let res: WorkflowFetchResult;
  try {
    res = await ctx.workflow.fetch(sourceUrlOf(id));
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return failed(id, storyId, "unavailable", /time ?out|timed out/i.test(msg) ? "timeout" : "network", null);
  }
  if (res.status !== 200) return failed(id, storyId, "unavailable", `http_${res.status}`, res);
  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch {
    return failed(id, storyId, "malformed", "malformed_json", res);
  }
  const sample = parseDiscussion(raw, id, storyId, { sha256: res.sha256, fetchedAt: res.fetchedAt });
  return { sample, cause: sample.status === "usable" ? null : sample.status };
}

async function run(ctx: WorkflowRunContext & { input: DiscussionInput }): Promise<void> {
  const wf = ctx.workflow;
  const input = ctx.input;
  let state = parseState(await wf.getState());
  if (state !== null) {
    // The first accepted batch binds the instance. A different batch is refused before any network effect.
    if (state.instance !== input.instance || JSON.stringify(state.stories) !== JSON.stringify(input.stories)) {
      throw new Error("instance is bound to a different capture batch; no network performed");
    }
  } else {
    const comments: CommentRecord[] = input.stories.flatMap((s) => s.kids.map((id) => ({ id, storyId: s.id, sample: null, cause: null })));
    // The plan (selected stories, hashes and comment IDs) is persisted before any source effect.
    state = await save(wf, {
      schema: SCHEMA,
      runId: ctx.workflow.runKey,
      seq: 0,
      phase: "capturing",
      instance: input.instance,
      stories: input.stories,
      comments,
    });
  }

  for (let i = 0; i < state.comments.length; i++) {
    const c = state.comments[i];
    if (c === undefined || c.sample !== null) continue; // already attempted: captured, failed, or interrupted; never refetch
    const marked = { ...c, sample: failed(c.id, c.storyId, "interrupted", "interrupted", null).sample };
    state = await save(wf, withComment(state, i, marked));
    const got = await captureOne(ctx, c.id, c.storyId);
    state = await save(wf, withComment(state, i, { ...marked, sample: got.sample, cause: got.cause }));
  }

  if (state.phase !== "complete") state = await save(wf, { ...state, phase: "complete" });
  const samples = state.comments.flatMap((c) => (c.sample === null ? [] : [c.sample]));
  const usable = samples.filter((s) => s.status === "usable").length;
  await ctx.ops.submitResult(
    {
      summary: `Captured ${usable} usable comment sample(s) from ${state.stories.length} stories; captured sample only, not representative`,
      stories: state.stories,
      samples,
      runId: state.runId,
    },
    `${state.runId}:result`,
  );
}

export const discussionWorkflow: WorkflowDef<DiscussionInput> = {
  name: "capture",
  capabilities: {
    state: true,
    fetch: { hosts: [FETCH_HOST], maxRequests: FETCH_MAX_REQUESTS, maxBytes: FETCH_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
  },
  validate: validateDiscussionInput,
  run,
};
