// HN digest workflow handler. Touches the world only through ctx.workflow (locked facade) and ctx.ops
// (signals), and speaks no daemon internals. Input is validated before any task exists. Insights are not
// implemented: nonzero insightBudgetMicros is rejected by validate (TODO(hn-insights)).
import type { Delivered, ExtensionConfigView, JsonValue, WorkflowDef, WorkflowRunContext } from "../../packages/core/src/index.ts";
import {
  type DigestEntry,
  type DigestPlan,
  errorCause,
  FEED_SOURCE,
  feedCounts,
  ITEM_SOURCE_PREFIX,
  type ItemResult,
  parseFeed,
  parseItem,
  renderDigest,
  selectRanked,
} from "./logic.mts";
import { HN_DIGEST_DEFAULTS, HN_DIGEST_EXTENSION, HN_DIGEST_PARAMS, HN_DIGEST_SEGMENT } from "./params.mts";

export type HnInput = { instance: string; limit: number; ask: boolean; insightBudgetMicros: number };

type Evidence = { url: string; sha256: string; fetchedAt: number };
// Active is the durable plan record, written with the plan before any effect. confirmRequired is the original ask
// requirement: a repair may raise it (ask:true) but never lower it. confirmed is persisted BEFORE the matching answer is
// acked, and before publish. Declined plans are cleared (active null); cancelled or timed-out plans stay with
// confirmRequired:true and confirmed:false, so a later repair asks again and never publishes automatically.
export type Active = {
  runId: string;
  plan: DigestPlan;
  evidence: Evidence[];
  phase: "plan" | "report" | "outbox";
  report?: { id: string };
  confirmRequired: boolean;
  confirmed: boolean;
};
// A task can only ack deliveries in its own inbox, so a repair task never acks a prior task's answer. The durable marker
// (confirmed or declined) is written before the ack of the current matching answer; if that ack fails, the marker still
// stops a repair from reasking or republishing.
type State = { schema: "hn-digest-state/1"; seen: number[]; active: Active | null };
type Feed = Awaited<ReturnType<WorkflowRunContext["workflow"]["fetch"]>>;

const SCHEMA = "hn-digest-state/1" as const;
const INSTANCE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INPUT_KEYS: ReadonlySet<string> = new Set(["instance", "limit", "ask", "insightBudgetMicros"]);
const CONFIRM_POLL_MS = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function validateInput(input: unknown): { ok: true; value: HnInput } | { ok: false; error: string } {
  if (!isRecord(input)) return fail("input must be an object");
  for (const k of Object.keys(input)) if (!INPUT_KEYS.has(k)) return fail(`unknown input key: ${k}`);
  const { instance, limit, ask, insightBudgetMicros } = input;
  if (typeof instance !== "string" || !INSTANCE.test(instance)) return fail("instance must match [a-z0-9][a-z0-9-]{0,63}");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10)) {
    return fail("limit must be an integer 1..10");
  }
  if (ask !== undefined && typeof ask !== "boolean") return fail("ask must be a boolean");
  if (
    insightBudgetMicros !== undefined &&
    (!Number.isSafeInteger(insightBudgetMicros) || (insightBudgetMicros as number) < 0 || (insightBudgetMicros as number) > 100000)
  ) {
    return fail("insightBudgetMicros must be an integer 0..100000");
  }
  if (typeof insightBudgetMicros === "number" && insightBudgetMicros > 0) {
    return fail("insights are not implemented: TODO(hn-insights) current behavior is metadata-only (no model analysis); use insightBudgetMicros=0");
  }
  return {
    ok: true,
    value: { instance, limit: (limit as number | undefined) ?? 5, ask: ask === true, insightBudgetMicros: 0 },
  };
}

function loadState(raw: JsonValue | null): State {
  if (raw === null) return { schema: SCHEMA, seen: [], active: null };
  if (!isRecord(raw) || raw.schema !== SCHEMA || !Array.isArray(raw.seen)) throw new Error("hn-digest: unrecognized state");
  return raw as unknown as State;
}

// Fresh selection: one feed fetch, then at most `limit` item fetches, serially. Nothing is persisted here.
async function selectFresh(wf: WorkflowRunContext["workflow"], input: HnInput, state: State, runId: string): Promise<Active> {
  let feed: Feed;
  try {
    feed = await wf.fetch(FEED_SOURCE);
  } catch (e) {
    throw new Error(`hn-digest: feed unavailable (${errorCause(e)})`);
  }
  if (feed.status !== 200) throw new Error(`hn-digest: feed unavailable (status ${feed.status})`);
  let ids: number[];
  try {
    ids = parseFeed(JSON.parse(feed.body));
  } catch (e) {
    throw new Error(`hn-digest: feed malformed (${errorCause(e)})`);
  }
  // An empty top-stories feed is a source fault, not "no new posts": an all-seen feed still lists its ids.
  if (ids.length === 0) throw new Error(`hn-digest: feed returned zero ids (sha256:${feed.sha256}); nothing to digest, nothing marked seen`);
  const picked = selectRanked(ids, state.seen, input.limit);
  const evidence: Evidence[] = [{ url: FEED_SOURCE, sha256: feed.sha256, fetchedAt: feed.fetchedAt }];
  const entries: DigestEntry[] = [];
  const skipped: DigestPlan["skipped"] = [];
  for (const { id, rank } of picked) {
    const url = `${ITEM_SOURCE_PREFIX}${id}.json`;
    let res: Feed;
    try {
      res = await wf.fetch(url);
    } catch (e) {
      skipped.push({ id, cause: "unavailable", detail: errorCause(e) });
      continue;
    }
    if (res.status !== 200) {
      skipped.push({ id, cause: "unavailable", detail: `status ${res.status}` });
      continue;
    }
    evidence.push({ url, sha256: res.sha256, fetchedAt: res.fetchedAt });
    let parsed: ItemResult;
    try {
      parsed = parseItem(JSON.parse(res.body), id);
    } catch (e) {
      skipped.push({ id, cause: "malformed", detail: errorCause(e) });
      continue;
    }
    if (!parsed.ok) {
      skipped.push({ id, cause: parsed.cause });
      continue;
    }
    entries.push({ ...parsed.item, rank, itemSource: url, itemHash: res.sha256 });
  }
  // Every candidate was unusable: fail, persist no plan, mark nothing seen.
  if (picked.length > 0 && entries.length === 0) throw new Error("hn-digest: no usable candidates; nothing marked seen");
  const plan: DigestPlan = {
    schema: "hn-digest/1",
    instance: input.instance,
    runId,
    fetchedAt: new Date(feed.fetchedAt).toISOString(),
    feedSource: FEED_SOURCE,
    feedHash: feed.sha256,
    rankBasis: "ranked-feed-position",
    limit: input.limit,
    entries,
    skipped,
    provenance: { seenBefore: state.seen.length, ...feedCounts(ids, state.seen), insights: "none" },
  };
  return { runId, plan, evidence, phase: "plan", confirmRequired: input.ask, confirmed: false };
}

function outboxBody(instance: string, active: Active, reportId: string): string {
  const n = active.plan.entries.length;
  const k = active.plan.skipped.length;
  const { feedIds, feedSeen } = active.plan.provenance;
  const head = n === 0 ? `No new posts (feed ${feedIds} ids, ${feedSeen} seen)` : `New posts: ${n}${k > 0 ? " (partial: some candidates skipped)" : ""}`;
  return `HN digest · instance ${instance} · run ${active.runId} · ${head} · skipped ${k} · report ${reportId} (owner root)`;
}

function isYes(body: string): boolean {
  const b = body.trim().toLowerCase();
  return b === "yes" || b === "approve";
}

function abortError(): Error {
  return new Error("hn-digest: confirmation aborted");
}

// Bounded, abortable delay. Rejects as soon as the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Waits for the human answer to our escalation and returns it WITHOUT acking. Only the matching escalation counts; others
// are left for their owner. Cancel, timeout, abort and deadline throw with no state change. The caller persists the durable
// marker first and acks the returned id afterwards.
async function awaitConfirm(ctx: WorkflowRunContext, escalation: string): Promise<{ id: string; accepted: boolean }> {
  for (;;) {
    if (ctx.signal.aborted) throw abortError();
    if (ctx.deadlineAt !== null && Date.now() >= ctx.deadlineAt) throw new Error("hn-digest: confirmation deadline reached");
    const delivered: Delivered[] = await ctx.ops.peek();
    for (const s of delivered) {
      if (s.kind === "cancel" || s.kind === "timeout") throw new Error("hn-digest: confirmation cancelled");
      if (s.kind !== "human_answer" || s.escalation !== escalation) continue;
      return { id: s.id, accepted: isYes(s.body) };
    }
    const wait = ctx.deadlineAt === null ? CONFIRM_POLL_MS : Math.max(0, Math.min(CONFIRM_POLL_MS, ctx.deadlineAt - Date.now()));
    await sleep(wait, ctx.signal);
  }
}

function ackKey(runId: string, id: string): string {
  return `${runId}:confirm:${id}:ack`;
}

async function run(ctx: WorkflowRunContext & { input: HnInput }): Promise<void> {
  const wf = ctx.workflow;
  const input = validateInput(ctx.input);
  if (!input.ok) throw new Error(`hn-digest: ${input.error}`);
  const { value } = input;
  let state = loadState(await wf.getState());
  // An existing active plan always wins: repair it with its saved runId and keys before any fetch.
  let active = state.active;
  if (active === null) {
    active = await selectFresh(wf, value, state, wf.runKey);
    state = { ...state, active };
    await wf.setState(state as unknown as JsonValue, `${active.runId}:plan`);
  }
  const runId = active.runId;
  const key = (phase: string) => `${runId}:${phase}`;
  if (active.phase === "plan") {
    if (value.ask && !active.confirmRequired) {
      // Escalate only: a repair with ask:true raises the saved requirement before any effect; it is never lowered.
      active = { ...active, confirmRequired: true };
      state = { ...state, active };
      await wf.setState(state as unknown as JsonValue, key("confirm-required"));
    }
    if (active.confirmRequired && !active.confirmed) {
      const n = active.plan.entries.length;
      const question = `Publish ranked digest for ${value.instance} (run ${runId}, ${n} new)? Reply yes to continue.`;
      // Asked again on each task until confirmed; the ask key and runId are stable across repairs.
      const asked = await wf.ask(question, key("confirm"));
      const answer = await awaitConfirm(ctx, asked.escalation);
      if (!answer.accepted) {
        // Durable decline first: clear the plan so it cannot be repaired into a publish; seen is untouched. Then ack.
        state = { ...state, active: null };
        await wf.setState(state as unknown as JsonValue, key("declined"));
        await ctx.ops.ack([answer.id], ackKey(runId, answer.id));
        throw new Error("digest publication declined");
      }
      // Durable confirmed marker first, then the ack; publish only after both.
      active = { ...active, confirmed: true };
      state = { ...state, active };
      await wf.setState(state as unknown as JsonValue, key("confirmed"));
      await ctx.ops.ack([answer.id], ackKey(runId, answer.id));
    }
    const report = await wf.publishReport({ name: `hn-${value.instance}.md`, content: renderDigest(active.plan), mediaType: "text/markdown" }, key("report"));
    active = { ...active, phase: "report", report: { id: report.id } };
    state = { ...state, active };
    await wf.setState(state as unknown as JsonValue, key("report-phase"));
  }
  if (active.phase === "report") {
    const reportId = active.report?.id ?? "unknown";
    await wf.sendToUser(outboxBody(value.instance, active, reportId), key("outbox"));
    active = { ...active, phase: "outbox" };
    state = { ...state, active };
    await wf.setState(state as unknown as JsonValue, key("outbox-phase"));
  }
  // Only entries the rendered report presented are marked seen; the final write clears the active plan.
  const presented = active.plan.entries.map((e) => e.id);
  const seen = [...new Set([...state.seen, ...presented])].sort((a, b) => a - b);
  await wf.setState({ schema: SCHEMA, seen, active: null } as unknown as JsonValue, key("seen"));
  // Result last: only after seen is committed. A crash before this line leaves no submitted result for this run; the next
  // launch is fresh (active is null) and submits its own result under its own run id.
  const reportId = active.report?.id ?? "unknown";
  await ctx.ops.submitResult(
    {
      summary: `HN digest · instance ${value.instance} · run ${runId} · new ${presented.length} · skipped ${active.plan.skipped.length} · report ${reportId}`,
      instance: value.instance,
      runId,
      reportId,
      entryIds: presented,
      skipped: active.plan.skipped.length,
    },
    key("result"),
  );
}

// The metadata digest's report capability is the digest's own `reportMaxBytes` key (params.mts), read from host.config at init;
// `hnDigest` is the workflow at the key's default.
export function digestWorkflow(reportMaxBytes: number): WorkflowDef<HnInput> {
  return {
    name: "digest",
    capabilities: {
      state: true,
      fetch: { hosts: ["hacker-news.firebaseio.com"], maxRequests: 11, maxBytes: 262144, timeoutMs: 10000 },
      reports: { maxBytes: reportMaxBytes },
      ask: true,
    },
    validate: validateInput,
    run,
  };
}

const REPORT_MAX_BYTES_KEY = `ext.${HN_DIGEST_SEGMENT}.reportMaxBytes` as const;

export const hnDigest: WorkflowDef<HnInput> = digestWorkflow(HN_DIGEST_DEFAULTS[REPORT_MAX_BYTES_KEY]);

const extension = {
  manifest: { name: HN_DIGEST_EXTENSION, entry: "entry.mts", capabilities: {}, deps: [], params: HN_DIGEST_PARAMS },
  init(host: { config: ExtensionConfigView; workflow(def: WorkflowDef): void }) {
    const reportMaxBytes = host.config[REPORT_MAX_BYTES_KEY];
    if (typeof reportMaxBytes !== "number") throw new TypeError(`hn-digest: host.config has no ${REPORT_MAX_BYTES_KEY} (declared in manifest.json params)`);
    host.workflow(digestWorkflow(reportMaxBytes) as unknown as WorkflowDef);
  },
};

export default extension;
