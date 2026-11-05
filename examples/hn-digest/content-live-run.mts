// Launch, supervise (deadline, publish approval), fact collection and visible-file output for one live hn-content run.
// Everything here works against a LiveContentRuntime, so it is exercised offline with the scripted composition.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRun, type AuditRecord, type RunFacts, type RunVerdict } from "./content-assertions.mts";
import { hash, type StoryResult } from "./content-contract.mts";
import type { ModelRouteProbe } from "../../packages/e2e/src/model-preflight.ts";
import { type BrowserImageProbe, type LiveCaps, type LiveContentRuntime, liveLaunchInput, type SpendSummary } from "./content-live-runtime.mts";
import { type ArticleMethod, BROWSER_TEMPLATE } from "./content-browser-method.mts";
import { modelCallRows, type ModelCallRow, modelCallsFile } from "./content-model-calls.mts";
import { workerEvidenceOf, workerSummaryOf, type WorkerEvidence } from "./content-live-workers.mts";
import { analystEvidenceOf, analystSummaryOf, type AnalystEvidence, type PagingPlan } from "./content-live-analyst.mts";
import { planPages } from "./article-pages.mts";
import { recordSeen, SeenFileError, type SeenStore } from "./content-seen.mts";
import { decideViaPomtree, type PomtreeCommand, type PomtreeSpawner, DECIDE_TIMEOUT_MS, pendingPublish } from "./content-live-pomtree.mts";
import { storyNumberOf, UNATTRIBUTED } from "./content-story.mts";

export type RunOutcome = RunFacts["outcome"];
export interface RunOptions {
  deadlineMs: number;
  // The single human publish gate; the operator decides it by flag, never implicitly. "pomtree" leaves it pending and runs the real `pomtree decide`
  // CLI as a child against the operator socket (token in the child's env only).
  approval: "approve" | "deny" | "pomtree";
  pomtreeCommand?: PomtreeCommand; // test seam: the child to run in place of the real pomtree
  pomtreeSpawner?: PomtreeSpawner; // test seam
  pomtreeTimeoutMs?: number; // default min(DECIDE_TIMEOUT_MS, a quarter of the deadline)
  articleMethod?: ArticleMethod; // default static-http; must match the caps and runtime it is given
  instance?: string;
  seen?: readonly number[]; // story ids the launch treats as already seen (from the stored seen state)
  pick?: readonly number[]; // operator-chosen HN item ids (--story-id) in place of the top-stories feed; one per story
  pollMs?: number;
  settleMs?: number; // extra wait after a deadline cancel before the run is declared failed
  now?: () => number;
}
export interface RunHandle {
  rootId: string;
  seed: number[]; // the seen ids the launch started from
  picked?: number[]; // the operator-chosen item ids the launch carried; absent when the stories came from the top-stories feed
  instance: string; // the workflow instance this run launched; the durable scope of its state rows
  outcome: RunOutcome;
  decided: "approved" | "denied" | null;
  decidedVia?: "pomtree"; // set only when the real pomtree CLI decided; absent for the in-process flag path
  pomtreeFailed?: boolean; // the pomtree child failed, hung or decided the wrong approval: the root was cancelled and the run is failed
  ambiguousApproval?: boolean; // more than one publish approval was pending: none was decided, the root was cancelled and the run is failed
  deadlineHit: boolean;
  notes: string[];
}
type RootResult = {
  report?: { id: string; sha256: string };
  draftSha?: string;
  reportBody?: string;
  stories: StoryResult[];
  failedStories?: unknown[];
  entryIds: number[];
  provenance?: { url: string; sha256: string; fetchedAt: number }[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ROOT_WORKFLOW = "hn-content/content";

// The seen list the root workflow last wrote for this run. pomtreed keys state rows by workflow and instance, so a journal that holds
// other runs' rows must not answer for this one: only rows of ROOT_WORKFLOW with this instance count.
export function rootSeenOf(payloads: readonly unknown[], instance: string): number[] {
  let seen: number[] = [];
  for (const p of payloads) {
    if (typeof p !== "object" || p === null) continue;
    const row = p as { kind?: unknown; workflow?: unknown; instance?: unknown; value?: { seen?: unknown } | null };
    if (row.kind !== "ext.pomtreed.workflow_state" || row.workflow !== ROOT_WORKFLOW || row.instance !== instance) continue;
    if (Array.isArray(row.value?.seen)) seen = row.value.seen as number[];
  }
  return seen;
}

export async function runLiveContent(rt: LiveContentRuntime, caps: LiveCaps, o: RunOptions): Promise<RunHandle> {
  const now = o.now ?? Date.now;
  const input = liveLaunchInput(caps, o.instance ?? `live-${now().toString(36)}`, o.seen, o.articleMethod, o.pick);
  const launch = await rt.cli([
    "--json",
    "workflow",
    "launch",
    ROOT_WORKFLOW,
    "--input",
    JSON.stringify(input),
    "--key",
    `live-${input.instance}`,
    "--budget",
    String(caps.rootBudgetMicros),
  ]);
  if (launch.code !== 0) throw new Error(`workflow launch failed: ${[...launch.err, ...launch.out].join(" ").slice(0, 300)}`);
  const rootId = (JSON.parse(launch.out.join("\n")) as { agent: string }).agent;
  const handle: RunHandle = {
    rootId,
    instance: input.instance,
    seed: [...(o.seen ?? [])],
    ...(o.pick && o.pick.length > 0 && { picked: [...o.pick] }),
    outcome: "failed",
    decided: null,
    deadlineHit: false,
    notes: [],
  };
  const start = now();
  let settleUntil = Number.POSITIVE_INFINITY;
  for (;;) {
    const agent = await rt.daemon.get(rootId as never);
    if (agent && (agent.state === "exited" || agent.state === "reaped")) {
      handle.outcome = classifyRootOutcome(handle, agent);
      // A picked-story refusal ends as a succeeded root with no report; its summary names the unusable ids (see the root workflow).
      const summary = (agent.result as { summary?: unknown } | null)?.summary;
      if (o.pick && o.pick.length > 0 && agent.exit === "succeeded" && handle.outcome !== "published" && typeof summary === "string")
        handle.notes.push(summary);
      if (agent.exit !== "succeeded") handle.notes.push(`root exit ${agent.exit ?? "unknown"}: ${JSON.stringify(agent.result ?? null)}`);
      return handle;
    }
    // The one pending publish approval (pendingPublish); more than one is ambiguous and refused below, never guessed.
    const rows = handle.decided === null && !handle.pomtreeFailed && !handle.ambiguousApproval ? await rt.stores.approvals.list({ state: "pending" }) : [];
    const pending = pendingPublish(rows);
    if (pending === null && rows.filter((a) => a.state === "pending" && a.action.kind === "publish").length > 1) {
      handle.ambiguousApproval = true;
      handle.notes.push("more than one pending publish approval; neither was decided; root cancelled");
      await rt.daemon.cancel(rootId as never, 1_000);
      settleUntil = now() + (o.settleMs ?? 30_000);
    } else if (handle.decided === null && !handle.pomtreeFailed && o.approval === "pomtree") {
      if (pending) {
        try {
          await decideViaPomtree(String(pending.id), {
            list: async () => (await rt.stores.approvals.list()).map((a) => ({ id: String(a.id), state: a.state, action: { kind: a.action.kind } })),
            operator: rt.operatorEnv(),
            ...(o.pomtreeCommand && { command: o.pomtreeCommand }),
            ...(o.pomtreeSpawner && { spawner: o.pomtreeSpawner }),
            timeoutMs: o.pomtreeTimeoutMs ?? Math.min(DECIDE_TIMEOUT_MS, Math.floor(o.deadlineMs / 4)),
          });
          handle.decided = "approved";
          handle.decidedVia = "pomtree";
        } catch (e) {
          handle.pomtreeFailed = true;
          handle.notes.push(`pomtree approval failed: ${e instanceof Error ? e.message : String(e)}; root cancelled`);
          await rt.daemon.cancel(rootId as never, 1_000);
          settleUntil = now() + (o.settleMs ?? 30_000);
        }
      }
    } else if (handle.decided === null && !handle.ambiguousApproval && o.approval !== "pomtree") {
      if (pending) {
        const verb = o.approval === "approve" ? "approve" : "deny";
        await rt.daemon.decideApproval(pending.id, verb, "operator", `live run ${verb} by flag`, `live-${verb}-${pending.id}`);
        handle.decided = o.approval === "approve" ? "approved" : "denied";
      }
    }
    if (!handle.deadlineHit && now() - start > o.deadlineMs) {
      handle.deadlineHit = true;
      handle.notes.push(`deadline ${o.deadlineMs}ms elapsed; root cancelled`);
      await rt.daemon.cancel(rootId as never, 1_000);
      settleUntil = now() + (o.settleMs ?? 30_000);
    }
    if (now() > settleUntil) {
      handle.outcome = handle.pomtreeFailed || handle.ambiguousApproval ? "failed" : "cancelled";
      handle.notes.push("root did not settle after cancel");
      return handle;
    }
    await sleep(o.pollMs ?? 500);
  }
}

// The outcome of a root that reached a terminal state. A root that exited succeeded with a report published, whatever else happened: a
// deadline that passed while it was publishing must not turn a published digest into "cancelled" (recordSeen would skip and the stories
// would repeat). Only then do the cancel causes and denial apply.
export function classifyRootOutcome(
  handle: Pick<RunHandle, "pomtreeFailed" | "deadlineHit" | "decided" | "ambiguousApproval">,
  agent: { exit?: string | null; result?: unknown },
): RunHandle["outcome"] {
  if (handle.pomtreeFailed || handle.ambiguousApproval) return "failed";
  if (agent.exit === "succeeded" && (agent.result as { report?: unknown } | null)?.report) return "published";
  if (handle.deadlineHit) return "cancelled";
  if (handle.decided === "denied") return "denied";
  return "failed";
}

const hostOf = (u: string | null | undefined): string | null => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};

// Host feed and item fetches made before any story exists: no story, no resolvable agent and no model route. A closed marker, not a story
// number; every other unresolved row stays UNATTRIBUTED.
export const FEED_STORY = "feed";
// Fields consumed by the fixed mapping (or deliberately dropped) when passing a container record through.
const EGRESS_FIXED: ReadonlySet<string> = new Set(["kind", "eventId", "host", "url", "sandbox", "sequence", "authority", "peer", "outcome", "at"]);

// Story attribution for one audit row, in order: its own story; the story of its agent (a story-N ancestor); for a model-call row (route
// present) the story of the model-call row with the same requestId; a host row with none of those and no model route is the feed; else unattributed.
export function storyOfAuditRow(
  r: { stream: string; story?: string; agent?: string; route?: string; requestId?: string },
  agents: ReadonlyMap<string, { name: string; parent?: string | null }>,
  modelStoryByRequest: ReadonlyMap<string, string>,
): string {
  if (r.story !== undefined) return r.story;
  const byAgent = storyNumberOf(agents, r.agent ?? "");
  if (byAgent !== undefined) return byAgent;
  if (r.route !== undefined && r.requestId !== undefined) return modelStoryByRequest.get(r.requestId) ?? UNATTRIBUTED;
  if (r.stream === "host" && r.route === undefined) return FEED_STORY;
  return UNATTRIBUTED;
}

// Host audit outcome as written to egress-audit.json: denied, error, cancelled and pending pass through (pending is an open row that never
// settled, so it must not read as complete); every other outcome is served and reads as complete.
export function hostAuditOutcome(outcome: string): AuditRecord["outcome"] {
  return outcome === "denied" || outcome === "error" || outcome === "cancelled" || outcome === "pending" ? outcome : "complete";
}

// Container egress rows keep authority "host[:port]"; split it into the assertion shape. Every other field is kept separately (bytesIn and
// bytesOut are not summed in the output; `bytes` is the sum only for the assertions). Unknown optional fields (denyReason, limitKind,
// errorClass, admittedAt, ...) pass through when present.
export function fromEgress(
  r: { sandbox: string; sequence: number; authority: string; peer?: string; outcome: string; at?: number } & Record<string, unknown>,
): AuditRecord {
  const m = /^(.*):(\d+)$/.exec(r.authority);
  const bytesIn = typeof r.bytesIn === "number" ? r.bytesIn : undefined;
  const bytesOut = typeof r.bytesOut === "number" ? r.bytesOut : undefined;
  const extra = Object.fromEntries(Object.entries(r).filter(([k, v]) => !EGRESS_FIXED.has(k) && v !== undefined));
  return {
    ...extra,
    stream: r.sandbox,
    sandbox: r.sandbox,
    sequence: r.sequence,
    authority: m ? (m[1] as string) : r.authority,
    ...(m && { port: Number(m[2]) }),
    ...(r.peer !== undefined && { peer: r.peer }),
    ...(typeof r.at === "number" && Number.isFinite(r.at) && { at: new Date(r.at).toISOString() }),
    outcome: r.outcome as AuditRecord["outcome"],
    bytes: (bytesIn ?? 0) + (bytesOut ?? 0),
  } as AuditRecord;
}

// Provenance file content: feed origin, item ids, and the sha256 of each retained feed/item body with its fetch time; plus per-story
// article capture facts. Metadata only: no paths, query strings or bodies.
export function provenanceOf(result: RootResult | null, workers: readonly WorkerEvidence[] = [], analysts: readonly AnalystEvidence[] = []) {
  const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const feed = (result?.provenance ?? []).find((p) => !/\/item\/\d+\.json$/.test(p.url));
  const items = (result?.provenance ?? []).flatMap((p) => {
    const m = /\/item\/(\d+)\.json$/.exec(p.url);
    return m ? [{ id: Number(m[1]), sha256: p.sha256, fetchedAt: iso(p.fetchedAt) }] : [];
  });
  const fromResult = (result?.stories ?? []).map((s) => {
    const a = s.evidence.article;
    const c = s.evidence.capture;
    const w = workers.find((x) => x.storyId === s.story.id);
    const an = analysts.find((x) => x.storyId === s.story.id);
    // The retained article wins; otherwise the host's capture summary says what happened and why (null only when truly unknown).
    return {
      storyId: s.story.id,
      status: a?.status ?? c?.status ?? null,
      fetchedAt: a?.fetchedAt ?? null,
      rawHash: a?.rawHash ?? c?.rawHash ?? null,
      // `truncated` is the raw body's clip only; the text clip is `textTruncated`.
      ...(a?.truncated !== undefined && { truncated: a.truncated }),
      ...(a?.textTruncated !== undefined && { textTruncated: a.textTruncated }),
      ...(a?.bytesRetained !== undefined && { bytesRetained: a.bytesRetained }),
      ...(c && { capture: c }),
      // The worker's exit, closed exit cause and last failed tool error, when the run collected them (the full account is workers/<id>.json).
      ...(w && { worker: workerSummaryOf(w) }),
      // The analyst's exit, stop reason, wall time and paging counts (the full account is workers/<id>.analysis.json).
      ...(an && { analyst: analystSummaryOf(an) }),
    };
  });
  // A worker ran for a story the root never reported (the root ended failed, no result): the story is still listed with the failure the
  // worker left, so the cause is not only in the kept session events.
  const unreported: (typeof fromResult)[number][] = workers
    .filter((w) => !fromResult.some((a) => a.storyId === w.storyId))
    .map((w) => ({ storyId: w.storyId, status: null, fetchedAt: null, rawHash: null, worker: workerSummaryOf(w) }));
  return {
    feedOrigin: feed ? hostOriginOf(feed.url) : null,
    feed: feed ? { sha256: feed.sha256, fetchedAt: iso(feed.fetchedAt) } : null,
    items,
    articles: [...fromResult, ...unreported],
  };
}

function hostOriginOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

export interface RunBundle {
  facts: RunFacts;
  verdict: RunVerdict;
  spend: SpendSummary;
  audit: AuditRecord[];
  approvals: ApprovalArtifact[];
  result: RootResult | null;
  modelCalls: ModelCallRow[];
  workers?: WorkerEvidence[]; // one per story whose article child is known; absent in a bundle built without collection
  analysts?: AnalystEvidence[]; // one per story whose analysis child ran; absent in a bundle built without collection
}

// Full approval record as written to approvals.json (decidedAt and journal times are ISO strings).
export interface ApprovalArtifact {
  id: string;
  action: { kind: string; target: string };
  state: string;
  rungs: string[];
  rungIndex: number;
  decidedBy: string | null;
  decidedVia?: "pomtree"; // present only on the approval the real pomtree CLI decided
  why: string | null;
  decidedAt: string | null;
  createdAt: string;
  journal: { rung: string; rank: string | number; who: string | null; decision: string; why: string; at: string }[];
}

// The article worker of each story, by story id: the child the root's result names, else (a root that ended failed reports no stories) the
// newest registry agent named `article-<id>` by the content workflow.
export function articleChildrenOf(
  result: { stories: readonly { story: { id: number }; evidence: { upstream?: { article?: { child: string } | null } } }[] } | null,
  registry: readonly { id: string; name: string; createdAt: number }[],
): Map<number, string> {
  const children = new Map<number, string>();
  for (const s of result?.stories ?? []) {
    const up = s.evidence.upstream?.article;
    if (up) children.set(s.story.id, up.child);
  }
  const named = new Set(children.keys());
  for (const a of [...registry].sort((x, y) => x.createdAt - y.createdAt)) {
    const m = /^article-(\d+)$/.exec(a.name);
    if (m && !named.has(Number(m[1]))) children.set(Number(m[1]), a.id);
  }
  return children;
}

export async function collectRun(rt: LiveContentRuntime, caps: LiveCaps, handle: RunHandle): Promise<RunBundle> {
  await rt.ingestEgress();
  const rootAgent = await rt.daemon.get(handle.rootId as never);
  const raw = (rootAgent?.result ?? null) as Partial<RootResult> | null;
  const result: RootResult | null = raw && Array.isArray(raw.stories) ? { ...raw, stories: raw.stories, entryIds: raw.entryIds ?? [] } : null;
  let publishedReport: RunFacts["publishedReport"] = null;
  if (result?.report) {
    const got = await rt.reportStore.read(rt.root.id, result.report.id as never);
    if (got) {
      const body = Buffer.from(got.content).toString("utf8");
      publishedReport = { sha256: got.report.sha256, body };
    }
  }
  const entries = await rt.stores.journal.read({ limit: 100000 });
  const rows = entries.map((e) => e.payload);
  const seen = rootSeenOf(rows, handle.instance);
  const approvalRows = await rt.stores.approvals.list();
  const approvals = approvalRows.map((a) => ({ kind: a.action.kind, decision: a.state, subjectSha: a.action.target ?? null }));
  const approvalArtifacts: ApprovalArtifact[] = approvalRows.map((a) => {
    const last = a.journal.at(-1);
    return {
      id: String(a.id),
      action: { kind: a.action.kind, target: a.action.target },
      state: a.state,
      rungs: a.rungs.map(String),
      rungIndex: a.rungIndex,
      decidedBy: last?.who ?? null,
      ...(handle.decidedVia === "pomtree" && a.action.kind === "publish" && a.state === "approved" && { decidedVia: "pomtree" as const }),
      why: last?.why ?? null,
      decidedAt: a.decidedAt === null ? null : new Date(a.decidedAt).toISOString(),
      createdAt: new Date(a.createdAt).toISOString(),
      journal: a.journal.map((j) => ({
        rung: String(j.rung),
        rank: j.rank as string | number,
        who: j.who,
        decision: String(j.decision),
        why: j.why,
        at: new Date(j.at).toISOString(),
      })),
    };
  });
  const spend = await rt.spend();
  const registry = await rt.stores.registry.list();
  const agents = new Map(registry.map((a) => [a.id as string, { name: a.name, parent: a.parent ?? null }]));
  const modelCalls = modelCallRows(entries, agents);
  const modelStoryByRequest = new Map(modelCalls.filter((m) => m.story !== UNATTRIBUTED).map((m): [string, string] => [m.requestId, m.story]));
  const storyOfRecord = <T extends AuditRecord>(r: T): T => ({ ...r, story: storyOfAuditRow(r, agents, modelStoryByRequest) });
  const retainedSha256 = (await rt.reportStore.list(rt.root.id)).map((r) => r.sha256);
  const articleTexts: Record<string, string> = {};
  for (const s of result?.stories ?? []) {
    const ref = s.evidence.article?.status === "usable" ? s.evidence.article.textReport : undefined;
    const got = ref ? await rt.reportStore.read(rt.root.id, ref.id as never) : null;
    if (got) articleTexts[String(s.story.id)] = Buffer.from(got.content).toString("utf8");
  }
  const hosts = new Set<string>();
  for (const s of result?.stories ?? []) {
    for (const u of [s.story.itemSource, s.story.url, s.evidence.article?.finalUrl]) {
      const h = hostOf(u);
      if (h) hosts.add(h);
    }
  }
  const hostRecords: AuditRecord[] = rt.hostAudit.records().map((r) => storyOfRecord({ ...r, outcome: hostAuditOutcome(r.outcome) } as AuditRecord));
  const containerRecords = (await rt.egressRecords()).map((r) => storyOfRecord(fromEgress(r as unknown as Parameters<typeof fromEgress>[0])));
  const audit = [...hostRecords, ...containerRecords];
  const declaredCounts: Record<string, number> = { host: rt.hostAudit.count() };
  for (const r of containerRecords) declaredCounts[r.stream] = (declaredCounts[r.stream] ?? 0) + 1;
  if (hostRecords.length === 0) delete declaredCounts.host;
  // The analysis child of each story (named `analysis-<story id>` by the content workflow): its journal rows, model calls and page plan.
  const analysts: AnalystEvidence[] = [];
  const analystTools: NonNullable<RunFacts["analystTools"]> = [];
  for (const s of result?.stories ?? []) {
    const child = registry.filter((a) => a.name === `analysis-${s.story.id}`).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!child) continue;
    const mine = entries.filter((e) => e.agent === child.id);
    analystTools.push({ storyId: s.story.id, tools: mine.flatMap((e) => (e.payload.kind === "tool_call" ? [e.payload.tool] : [])) });
    const text = articleTexts[String(s.story.id)];
    let plan: PagingPlan | null = null;
    if (text !== undefined) {
      const p = planPages(text, { pageMaxBytes: rt.bounds.articlePageMaxBytes, readMaxBytes: rt.bounds.articleAnalystReadMaxBytes });
      plan = {
        pageBytes: p.pages.map((x) => x.end - x.start),
        totalBytes: p.totalBytes,
        offeredBytes: p.offeredBytes,
        pageMaxBytes: p.limits.pageMaxBytes,
        readMaxBytes: p.limits.readMaxBytes,
      };
    }
    analysts.push(
      analystEvidenceOf({
        storyId: s.story.id,
        agent: child,
        entries: mine,
        calls: modelCalls.filter((m) => m.agent === child.id),
        plan,
        env: process.env,
      }),
    );
  }
  const facts: RunFacts = {
    limit: caps.stories,
    modelBudgetMicros: caps.modelBudgetMicros,
    outcome: handle.outcome,
    result,
    publishedReport,
    seen,
    seed: handle.seed,
    approvals,
    spend: {
      totalMicros: spend.totalMicros,
      byStory: spend.byStory,
      ...(spend.errors.length > 0 && { unreadable: spend.errors.map((e) => e.name) }),
    },
    retainedSha256,
    articleTexts,
    expectedAuthorities: [...hosts],
    audit,
    declaredCounts,
    relayPorts: [...rt.relayPorts],
    modelCalls: modelCalls.map(({ requestId, micros }) => ({ requestId, micros })),
    analystTools,
  };
  const workers: WorkerEvidence[] = [];
  const articleChildren = articleChildrenOf(result, registry as unknown as { id: string; name: string; createdAt: number }[]);
  for (const [storyId, child] of articleChildren) {
    const agent = await rt.daemon.get(child as never);
    if (!agent) continue;
    const payloads = (await rt.stores.journal.read({ agent: agent.id, limit: 500 })).map((e) => e.payload);
    const listed = await rt.reportStore.list(agent.id);
    const reports = await Promise.all(
      listed.map(async (r) => {
        const got = r.name === "browser-navigation" ? await rt.reportStore.read(agent.id, r.id) : null;
        return { name: r.name, mediaType: r.mediaType, sizeBytes: r.sizeBytes, sha256: r.sha256, ...(got && { content: got.content }) };
      }),
    );
    workers.push(workerEvidenceOf({ storyId, agent, payloads, reports, env: process.env }));
  }
  return { facts, verdict: checkRun(facts), spend, audit, approvals: approvalArtifacts, result, modelCalls, workers, analysts };
}

const write = (dir: string, name: string, data: string) => {
  mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, name), data);
};

// Visible files only: digest, per-story reports, cost ledger, egress audit, assertions (with their inputs), approvals, provenance, run summary.
export function writeRunOutputs(dir: string, caps: LiveCaps, handle: RunHandle, bundle: RunBundle): string[] {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const out = (name: string, data: string) => {
    write(dir, name, data);
    files.push(name);
  };
  const body = bundle.facts.publishedReport?.body ?? bundle.result?.reportBody;
  if (body !== undefined) out("digest.md", body);
  // A rejected story's detail lives only in its .rejected.json; the story file keeps today's shape.
  for (const s of bundle.result?.stories ?? []) {
    const { rejected, ...story } = s;
    out(`stories/${s.story.id}.json`, `${JSON.stringify(story, null, 2)}\n`);
    if (rejected) out(`stories/${s.story.id}.rejected.json`, `${JSON.stringify({ storyId: s.story.id, ...rejected }, null, 2)}\n`);
  }
  // Per article attempt: sandbox exit, tool errors and the navigation log when published (bounded, redacted; see content-live-workers.mts).
  for (const w of bundle.workers ?? []) out(`workers/${w.storyId}.json`, `${JSON.stringify(w, null, 2)}\n`);
  // Per analysis attempt: tool calls, turns, wall time, stop reason and paging (bounded; see content-live-analyst.mts).
  for (const a of bundle.analysts ?? []) out(`workers/${a.storyId}.analysis.json`, `${JSON.stringify(a, null, 2)}\n`);
  out("cost-ledger.json", `${JSON.stringify({ caps, ...bundle.spend }, null, 2)}\n`);
  // Every field is kept separately (bytesIn/bytesOut not summed); `story` is the resolved story number or "unattributed".
  out(
    "egress-audit.json",
    `${JSON.stringify(
      bundle.audit.map(({ bytes, ...rest }) => (rest.stream === "host" ? { ...rest, bytesIn: bytes } : rest)),
      null,
      2,
    )}\n`,
  );
  const { seen, seed, approvals, retainedSha256, expectedAuthorities } = bundle.facts;
  out("model-calls.json", `${JSON.stringify(modelCallsFile(bundle.modelCalls), null, 2)}\n`);
  out("assertions.json", `${JSON.stringify({ ...bundle.verdict, inputs: { seen, seed, approvals, retainedSha256, expectedAuthorities } }, null, 2)}\n`);
  out("approvals.json", `${JSON.stringify(bundle.approvals, null, 2)}\n`);
  out("provenance.json", `${JSON.stringify(provenanceOf(bundle.result, bundle.workers, bundle.analysts), null, 2)}\n`);
  out(
    "run.json",
    `${JSON.stringify({ selection: handle.picked ? { mode: "operator-picked", ids: handle.picked } : { mode: "top-ranked" }, outcome: handle.outcome, decided: handle.decided, deadlineHit: handle.deadlineHit, notes: handle.notes, digestSha256: body === undefined ? null : hash(body), workers: files.filter((f) => f.startsWith("workers/")), paging: (bundle.analysts ?? []).map((a) => ({ storyId: a.storyId, paging: a.paging })) }, null, 2)}\n`,
  );
  return files;
}

export interface EntryOptions extends RunOptions {
  outputDir: string;
  seenStore?: SeenStore; // e.g. from openSeenState; absent = no persistence
  seenImport?: readonly number[]; // --seen-import ids, already validated by the caller; merged into seenStore only after the preflights pass
  seenLabel?: string; // names the store in log lines (the database path for the state store)
  seenExport?: (ids: readonly number[]) => void; // --seen-export: rewrites the full stored set after a published run that added ids
  routeProbe?: ModelRouteProbe; // default: a short container with the worker's network shape (see assertModelRoute)
  imageProbe?: BrowserImageProbe; // browser method only; default: a short container (see assertBrowserImage)
}

// 0 published and every assertion held, 5 published and every assertion held but the seen state was not updated, 3 did not publish, published
// without an analysed story, or published with no usable article because every URL-bearing story's article failed for a worker or
// verification reason (checked first, so a vacuous success never reads as 4), 4 some other assertion failed.
const NO_RESULT_CHECKS: ReadonlySet<string> = new Set(["analysed-stories", "usable-article"]);
export function exitCodeOf(outcome: string, verdict: { ok: boolean; checks: { name: string; ok: boolean }[] }): number {
  if (outcome !== "published") return 3;
  if (verdict.checks.some((c) => NO_RESULT_CHECKS.has(c.name) && !c.ok)) return 3;
  return verdict.ok ? 0 : 4;
}

// Only a published run that does not exit 3 marks anything seen, and only its validated-analysis stories (the root's entryIds). A failed save or export never
// drops the published result: it is reported with the ids to add by hand and turns a 0 into 5 (3/4 keep their own code). The export runs
// after the store write, so its failure says the stored state was updated.
export async function recordSeenAfterRun(
  store: SeenStore,
  label: string,
  outcome: string,
  entryIds: readonly number[],
  code: number,
  exportTo?: (ids: readonly number[]) => void,
): Promise<number> {
  // Exit 3 is the run's verdict that it produced nothing countable (see exitCodeOf), so it marks nothing: a URL-less story analysed in a run
  // whose every article worker failed is retried too, and the exit code and the seen state never disagree.
  if (code === 3) {
    console.error(`live content: ${label} unchanged (exit 3 marks nothing seen)`);
    return code;
  }
  let stored = false;
  try {
    const r = await recordSeen(store, outcome, entryIds);
    stored = true;
    if (r.written && exportTo) exportTo(await store.load());
    console.error(`live content: ${label} ${r.written ? `updated (${r.total} ids)` : "unchanged"}`);
    return code;
  } catch (e) {
    const detail = e instanceof SeenFileError ? e.message : String(e);
    console.error(
      `live content: PUBLISHED, but the seen state was NOT updated: ${stored ? "export failed: " : ""}${detail}${stored ? " (the stored seen state WAS updated)" : ""}. Story ids to add by hand: ${JSON.stringify(entryIds)}`,
    );
    return code === 0 ? 5 : code;
  }
}

// The entry's sequence after the runtime is open: browser-image and model-route preflights, the --seen-import merge, run, collect, write.
// Returns the exit code: 0 published and every assertion held, 2 refused before any model request (browser image, route unreachable, a picked story already seen, or the
// seen import could not be stored; the import is applied only after the preflights, so an exit 2 from them leaves the stored seen state
// untouched), 3 did not publish, produced no analysed story or no usable article (exitCodeOf), 4 an assertion failed, 5 published and every assertion held but the seen state
// could not be updated. The caller closes `rt`.
export async function executeLive(rt: LiveContentRuntime, caps: LiveCaps, o: EntryOptions): Promise<number> {
  const browser = o.articleMethod === "browser";
  try {
    if (browser) await rt.assertBrowserImage(o.imageProbe);
    await rt.assertModelRoute(o.routeProbe, browser ? BROWSER_TEMPLATE : undefined);
  } catch (e) {
    console.error(`live content: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const stored = o.seenStore ? await o.seenStore.load() : [];
  // The picked-seen refusal is checked against the stored set plus the import BEFORE the import is saved, so an exit 2 persists nothing.
  const pickedSeen = o.seenStore ? (o.pick ?? []).filter((id) => (o.seenImport ?? []).includes(id) || stored.includes(id)) : [];
  if (pickedSeen.length > 0) {
    console.error(
      `live content: --story-id ${pickedSeen.join(", ")} already in the seen state (${o.seenLabel ?? "seen state"}); no override exists: remove the id from the seen state first, or pick another story`,
    );
    return 2;
  }
  if (o.seenStore && o.seenImport) {
    try {
      await o.seenStore.save(o.seenImport);
    } catch (e) {
      console.error(`live content: seen import failed: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }
  const seen = o.seenStore ? await o.seenStore.load() : undefined;
  const handle = await runLiveContent(rt, caps, { ...o, ...(seen && { seen }) });
  const bundle = await collectRun(rt, caps, handle);
  const files = writeRunOutputs(o.outputDir, caps, handle, bundle);
  console.error(`live content: outcome ${handle.outcome}; spent ${bundle.spend.totalMicros} micros; wrote ${files.join(", ")}`);
  if (handle.picked && handle.outcome !== "published") for (const n of handle.notes) console.error(`live content: ${n}`);
  for (const c of bundle.verdict.checks.filter((x) => !x.ok)) console.error(`live content: ASSERTION FAILED ${c.name}: ${c.detail}`);
  if (handle.outcome === "published" && bundle.verdict.checks.some((c) => c.name === "analysed-stories" && !c.ok))
    console.error("live content: did not produce an analysed story");
  if (handle.outcome === "published" && bundle.verdict.checks.some((c) => c.name === "usable-article" && !c.ok))
    console.error("live content: did not produce a usable article (every article failed for a worker or verification reason)");
  const code = exitCodeOf(handle.outcome, bundle.verdict);
  const entryIds = bundle.result?.entryIds ?? [];
  return o.seenStore ? recordSeenAfterRun(o.seenStore, o.seenLabel ?? "seen state", handle.outcome, entryIds, code, o.seenExport) : code;
}
