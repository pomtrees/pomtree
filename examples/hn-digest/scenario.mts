// Scenario runner for the hn-digest workflow on the real stack (runtime.mts: SQLite, dir reports, daemon, CLI socket,
// host HTTP, the real DiscordAdapter over a scripted Discord transport). Metadata-only: no model, sandbox, harness or real
// Discord. The default run is offline (recorded fixtures, stubbed DNS). `liveHn` fetches the official HN API under hard
// caps; it is never run by tests.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DiscordAdapter,
  type DiscordInbound,
  type DiscordTransport,
  type OutboxEntry,
  type OutboxState,
  type PomtreedClient,
} from "../../packages/messaging-discord/src/index.ts";
import { defaultFetch, type FetchFn } from "../../packages/pomtreed/src/ext-gateway.ts";
import { DirReportStore } from "../../packages/report-dir/src/index.ts";
import { CHAT_SENDER, OFFLINE_CAPTURE_FRESHNESS, openRuntime, resolveFetchUserAgent, type Runtime, TEST_FETCH_USER_AGENT } from "./runtime.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const EXTENSION_DIR = resolve(HERE, "..");
const WORKFLOW = "hn-digest/digest";
const CHANNEL_ID = "scenario-channel";
const LIVE_ORIGIN = "https://hacker-news.firebaseio.com";
const FEED_URL = `${LIVE_ORIGIN}/v0/topstories.json`;
const ITEM_PREFIX = `${LIVE_ORIGIN}/v0/item/`;
export const DEADLINE_MAX_MS = 180_000;
export const CLEANUP_RESERVE_MAX_MS = 5_000; // kept free for runtime.close() within the total deadline
export const LIVE_FEEDS_MAX = 3; // authorized: first feed plus at most two refreshes
export const LIVE_ITEMS_MAX = 10;
export const LIVE_REQUEST_TIMEOUT_MS = 10_000;
export const LIVE_BODY_MAX = 262144;

export interface ScenarioOptions {
  liveHn?: boolean;
  artifactDir?: string;
  deadlineMs?: number;
  openRuntime?: typeof openRuntime; // test seam: defaults to the real-stack runtime
  // workflow.fetch.userAgent with liveHn (the CLI reads POMTREED_WORKFLOW_FETCH_USER_AGENT): unset or blank resolves to the registry default
  // "pomtree", a contact is recommended; offline runs default to TEST_FETCH_USER_AGENT.
  fetchUserAgent?: string;
}

export interface SourceRecord {
  url: string;
  status: number;
  sha256: string;
  fetchedAt: number;
  bytes: number;
  file: string;
}

export interface ScenarioSummary {
  status: "passed" | "failed";
  live: boolean;
  artifactDir: string;
  timing: { deadlineMs: number; reserveMs: number; startedAt: number; endedAt: number; elapsedMs: number };
  dispatch: { feedDispatches: number; itemDispatches: number; dispatchFailures: number; responses: number };
  checks: Record<string, boolean>;
  counts: Record<string, number>;
  phases: string[];
  runIds: string[];
  reportIds: string[];
  entryIds: { repair: number[]; fresh: number[] };
  outboxPurposes: string[];
  unusedCalls: string[];
  simulatedDiscord: true;
  cleanup: { ok: boolean; error?: string; preservedStateDir?: string }; // open/close cleanup outcome; state is kept when unproven or failed
  error?: string;
}

// Validates the caller's deadline: an integer in 1..180000. Options can only lower the cap, never raise it.
export function validateDeadlineMs(v: unknown = DEADLINE_MAX_MS): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > DEADLINE_MAX_MS) {
    throw new RangeError(`deadlineMs must be an integer 1..${DEADLINE_MAX_MS}`);
  }
  return v;
}

// Exact live URL contract: official origin, port 443 (implicit), no credentials, query or fragment, and one of two paths.
export function checkLiveUrl(raw: string): { kind: "feed" } | { kind: "item"; id: number } {
  const u = new URL(raw);
  if (u.origin !== LIVE_ORIGIN || u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "") {
    throw new Error("scenario: live URL is outside the official origin");
  }
  if (u.search !== "" || u.hash !== "") throw new Error("scenario: live URL must not carry a query or fragment");
  if (u.pathname === "/v0/topstories.json") return { kind: "feed" };
  const m = /^\/v0\/item\/([1-9]\d{0,15})\.json$/.exec(u.pathname);
  const id = m?.[1] === undefined ? Number.NaN : Number(m[1]);
  if (Number.isSafeInteger(id)) return { kind: "item", id };
  throw new Error("scenario: live URL path is not an allowed HN path");
}

// Counts every dispatch before it happens. Caps apply to offline and live runs alike.
export class DispatchBudget {
  feedDispatches = 0;
  itemDispatches = 0;
  dispatchFailures = 0;
  reserve(kind: "feed" | "item"): void {
    if (kind === "feed") {
      if (this.feedDispatches >= LIVE_FEEDS_MAX) throw new Error("scenario: feed dispatch cap reached");
      this.feedDispatches += 1;
    } else {
      if (this.itemDispatches >= LIVE_ITEMS_MAX) throw new Error("scenario: item dispatch cap reached");
      this.itemDispatches += 1;
    }
  }
}

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

function writeFile(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Offline transport: serves only the recorded public fixtures; anything else is refused after its dispatch is counted.
// The workflow's own root reports: the capture broker stores each fetched body as a root-owned report too (named capture-<role>), which the digest's population checks do not count.
const digestReports = <T extends { name: string }>(rs: T[]): T[] => rs.filter((r) => !/^capture[-/]/.test(r.name));

function fixtureFetch(budget: DispatchBudget, records: SourceRecord[], rawDir: string): FetchFn {
  const bodies = new Map<string, string>([[FEED_URL, join(FIXTURES, "feed_topstories.json")]]);
  for (const [id, name] of [
    [101, "item_101_story.json"],
    [102, "item_102_job.json"],
    [103, "item_103_ask.json"],
    [104, "item_104_poll.json"],
  ] as const) {
    bodies.set(`${ITEM_PREFIX}${id}.json`, join(FIXTURES, name));
  }
  return async (url) => {
    const isFeed = url === FEED_URL;
    budget.reserve(isFeed ? "feed" : "item");
    const path = bodies.get(url);
    if (path === undefined) {
      budget.dispatchFailures += 1;
      throw new Error("scenario: offline fetch refused");
    }
    const bytes = new TextEncoder().encode(readFileSync(path, "utf8"));
    const digest = sha(bytes);
    const file = join(rawDir, `${digest}.json`);
    writeFile(file, bytes);
    records.push({ url, status: 200, sha256: digest, fetchedAt: Date.now(), bytes: bytes.length, file });
    return {
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        yield bytes;
      })(),
    };
  };
}

// Live transport: exact URL contract, dispatch counted before the request, one request timeout, a body cap and the
// global deadline signal. Redirects and DNS pinning stay in the lower layer (defaultFetch receives the gateway's init).
// Composes the request signal: the global deadline, the request timeout and the caller's incoming init.signal
// (per-task cancel from webFetchOnce), so an incoming abort reaches the socket and body.
export function liveRequestSignal(global: AbortSignal, incoming?: AbortSignal): AbortSignal {
  const parts = [global, AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS)];
  if (incoming !== undefined) parts.push(incoming);
  return AbortSignal.any(parts);
}

export function liveFetch(budget: DispatchBudget, records: SourceRecord[], rawDir: string, global: AbortSignal, send: FetchFn = defaultFetch): FetchFn {
  return async (url, init) => {
    const target = checkLiveUrl(url);
    const signal = liveRequestSignal(global, init.signal);
    // A request already cancelled before dispatch is refused without counting a dispatch.
    if (signal.aborted) throw new Error("scenario: live fetch cancelled before dispatch");
    budget.reserve(target.kind);
    try {
      const res = await send(url, { ...init, signal });
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        for await (const c of res.body) {
          total += c.length;
          if (total > LIVE_BODY_MAX) throw new Error("scenario: live response exceeds body cap");
          chunks.push(c);
        }
      }
      const bytes = Buffer.concat(chunks);
      const digest = sha(bytes);
      const file = join(rawDir, `${digest}.json`);
      writeFile(file, bytes);
      records.push({ url, status: res.status, sha256: digest, fetchedAt: Date.now(), bytes: bytes.length, file });
      return {
        status: res.status,
        headers: res.headers,
        body: (async function* () {
          yield bytes;
        })(),
      };
    } catch (e) {
      budget.dispatchFailures += 1;
      throw e;
    }
  };
}

// Scripted Discord transport: records outbound bodies with sequential ids; no network.
interface Sent {
  id: string;
  channel: string;
  content: string;
}
function scriptedDiscord(transcript: Sent[]): DiscordTransport {
  return {
    send: async (channel, content) => {
      const id = `m${transcript.length + 1}`;
      transcript.push({ id, channel, content });
      return id;
    },
    onMessage: () => () => {},
    isBotAuthored: async () => true,
  } as DiscordTransport;
}

// Rejects as soon as the global deadline fires; a late rejection of the losing promise is swallowed.
function raceDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(new Error("scenario: deadline reached"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(new Error("scenario: deadline reached"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function waitFor<T>(what: string, signal: AbortSignal, probe: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const v = await raceDeadline(probe(), signal);
    if (v !== undefined) return v;
    await raceDeadline(new Promise((r) => setTimeout(r, 25)), signal);
    if (signal.aborted) throw new Error(`timed out waiting for ${what}`);
  }
}

// Terminal = exited or reaped; resolves with the exit status.
async function waitExit(rt: Runtime, agent: string, signal: AbortSignal): Promise<string> {
  return waitFor(`task ${agent} to exit`, signal, async () => {
    const a = await rt.daemon.get(agent as never);
    if (a && (a.state === "exited" || a.state === "reaped")) return a.exit ?? "unknown";
    return undefined;
  });
}

// Result of a finished task (AgentRecord.result), read from the registry and shape-checked.
function resultOf(rec: unknown): { runId: string; reportId: string; entryIds: number[] } {
  const r = (rec as { result?: unknown } | null)?.result as Record<string, unknown> | undefined;
  if (!r || typeof r.runId !== "string" || typeof r.reportId !== "string" || !Array.isArray(r.entryIds)) {
    throw new Error("scenario: task result has no digest shape");
  }
  const entryIds = r.entryIds.filter((n): n is number => Number.isSafeInteger(n));
  return { runId: r.runId, reportId: r.reportId, entryIds };
}

// Failure diagnostics. Only evaluated on a failed task, and redacted: no tokens, keys or local paths.
async function debugTask(rt: Runtime, agent: string): Promise<string> {
  const rec = await rt.daemon.get(agent as never);
  const tail = (await rt.stores.journal.read({ agent: agent as never, from: 0, limit: 500 })).slice(-6).map((e) => {
    const p = e.payload as { kind: string; message?: unknown };
    const msg = p.kind === "error" && typeof p.message === "string" ? `:${redact(p.message).slice(0, 120)}` : "";
    return `${p.kind}${msg}`;
  });
  return `cause=${rec?.exitCause ?? "none"} journal=${tail.join(",")}`;
}

function redact(s: string): string {
  return s.replace(/(token|secret|bearer|key)[=:]\S*/gi, "[redacted]").replace(/\/[\w.\-/]+/g, "[path]");
}

export async function runScenario(options: ScenarioOptions = {}): Promise<ScenarioSummary> {
  const deadlineMs = validateDeadlineMs(options.deadlineMs);
  const reserveMs = Math.min(CLEANUP_RESERVE_MAX_MS, Math.floor(deadlineMs / 4));
  const live = options.liveHn === true;
  // Resolved through the registry before any dir, runtime or request (a header-unsafe value is refused here); a live run never sends the test identity.
  const fetchUserAgent = live ? resolveFetchUserAgent(options.fetchUserAgent, "scenario --live-hn") : (options.fetchUserAgent ?? TEST_FETCH_USER_AGENT);
  const artifactDir = options.artifactDir ?? mkdtempSync(join(tmpdir(), "hn-scenario-"));
  const stateDir = mkdtempSync(join(tmpdir(), "hn-scenario-state-"));
  const rawDir = join(artifactDir, "source", "raw");
  const records: SourceRecord[] = [];
  const budget = new DispatchBudget();
  const transcript: Sent[] = [];
  const checks: Record<string, boolean> = {};
  const counts: Record<string, number> = {};
  const phases: string[] = [];
  const runIds: string[] = [];
  const reportIds: string[] = [];
  const entryIds = { repair: [] as number[], fresh: [] as number[] };
  let outboxPurposes: string[] = [];
  let error: string | undefined;
  let status: ScenarioSummary["status"] = "passed";
  let rt: Runtime | undefined;
  let cleanup: ScenarioSummary["cleanup"] = { ok: true };
  const startedAt = Date.now();
  const global = new AbortController();
  const timer = setTimeout(() => global.abort(new Error("scenario: deadline reached")), deadlineMs - reserveMs);
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks[name] = ok;
    if (!ok) throw new Error(`check failed: ${name}${detail ? ` (${detail})` : ""}`);
  };
  const crash = { armed: true };
  const fetchFn = live ? liveFetch(budget, records, rawDir, global.signal) : fixtureFetch(budget, records, rawDir);
  const current = (): Runtime => {
    if (!rt) throw new Error("scenario: runtime not open");
    return rt;
  };
  const reportStore = () => new DirReportStore({ root: join(stateDir, "reports"), registry: current().stores.registry });
  const open = async (): Promise<Runtime> => {
    try {
      return await (options.openRuntime ?? openRuntime)({
        stateDir,
        extensionDir: EXTENSION_DIR,
        reviewedOwners: ["hn-digest"],
        chatWorkflows: [WORKFLOW],
        chatApproval: true,
        fetch: fetchFn,
        fetchUserAgent,
        // Offline only: the stub never runs live, where the lower layer performs the real lookup and address check.
        ...(live ? {} : { resolveDns: async () => [{ address: "1.1.1.1", family: 4 }] }),
        // Offline only: the fixture run counts a feed dispatch per run, so the broker must not serve the fresh run the first run's
        // capture. --live-hn keeps the registry's freshness defaults.
        ...(live ? {} : { captureFreshness: OFFLINE_CAPTURE_FRESHNESS }),
        publishAfterWrite: async () => {
          if (crash.armed) {
            crash.armed = false;
            throw new Error("scenario: injected crash after root report write");
          }
        },
      });
    } catch (e) {
      // A rejected factory has no close handle. Never infer that its partial teardown joined every resource.
      cleanup = {
        ok: false,
        error: `runtime open failed; partial cleanup unproven: ${redact(e instanceof Error ? e.message : String(e))}`,
        preservedStateDir: stateDir,
      };
      throw e;
    }
  };
  try {
    rt = await open();
    const r = rt;
    const signal = global.signal;
    const pomtreed: PomtreedClient = {
      outbox: async (from) => (await r.daemon.outbox({ channel: "discord", from })) as unknown as OutboxEntry[],
      postMessage: (b) => r.hostPost(b as never),
      hostRead: async () => ({ status: 404, body: null }),
    };
    const outboxStore = { state: { cursor: 0, attempts: {}, retryAfter: null, deadLetters: [] } as OutboxState };
    const makeAdapter = () =>
      new DiscordAdapter({
        pomtreed,
        discord: scriptedDiscord(transcript),
        outbox: {
          read: async () => outboxStore.state,
          write: async (s) => {
            outboxStore.state = s;
          },
        },
        channelId: CHANNEL_ID,
        allowedSenders: [CHAT_SENDER],
        log: () => {},
      });
    let adapter = makeAdapter();
    const poll = () => raceDeadline(adapter.pollOnce(), signal);
    const cli = (argv: string[]) => raceDeadline(current().cli(argv), signal);

    // Phase 1: operator CLI launch (ask:true, limit 2); the ask is answered through the adapter; the crash fires after the report write.
    const first = await cli([
      "--json",
      "workflow",
      "launch",
      WORKFLOW,
      "--input",
      JSON.stringify({ instance: "scenario", limit: 2, ask: true }),
      "--key",
      "scenario-1",
    ]);
    check("first-launch-ok", first.code === 0, first.err.join("\n"));
    const taskA = (JSON.parse(first.out.join("\n")) as { agent: string }).agent;
    phases.push("operator-launch");
    const ask = await waitFor("ask in transcript", signal, async () => {
      await poll();
      return transcript.find((t) => t.content.includes("Reply yes to continue"));
    });
    const answered = await raceDeadline(
      adapter.handleInbound({ id: "d-yes-1", authorId: CHAT_SENDER, authorName: "u1", body: "yes", replyToId: ask.id }),
      signal,
    );
    check("human-answer-accepted", answered.kind === "answered", JSON.stringify(answered));
    phases.push("human-answer");
    const exitA = await waitExit(r, taskA, signal);
    if (exitA !== "failed") throw new Error(`first task must fail at the injected crash, got ${exitA}`);
    checks["first-task-failed-at-crash"] = true;
    phases.push("crash-after-report-write");
    const initial = digestReports(await reportStore().list(r.root.id));
    check("one-report-after-crash", initial.length === 1, String(initial.length));
    const initialReportId = initial[0]?.id ?? "";
    reportIds.push(initialReportId);

    // Close and reopen on the same stateDir; the crash is disarmed.
    await r.close();
    rt = undefined; // a failed reopen must not let the previous runtime's clean close stand in for its cleanup
    rt = await open();
    const r2 = rt;
    adapter = new DiscordAdapter({
      pomtreed: {
        ...pomtreed,
        outbox: async (from) => (await r2.daemon.outbox({ channel: "discord", from })) as unknown as OutboxEntry[],
        postMessage: (b) => r2.hostPost(b as never),
      },
      discord: scriptedDiscord(transcript),
      outbox: {
        read: async () => outboxStore.state,
        write: async (s) => {
          outboxStore.state = s;
        },
      },
      channelId: CHANNEL_ID,
      allowedSenders: [CHAT_SENDER],
      log: () => {},
    });
    phases.push("reopen");

    // Phase 2: chat repair. The chat launch needs a durable spawn approval, so the first attempt is pending.
    const repairMsg: DiscordInbound = { id: "d-launch-1", authorId: CHAT_SENDER, authorName: "u1", body: "!workflow launch hn-digest/digest scenario" };
    const pending = await raceDeadline(adapter.handleInbound(repairMsg), signal);
    check("chat-launch-pending", pending.kind === "rejected", JSON.stringify(pending));
    const approvals = await r2.stores.approvals.list({ state: "pending" });
    check("one-pending-approval", approvals.length === 1, String(approvals.length));
    const approval = approvals[0];
    if (!approval) throw new Error("scenario: pending approval missing");
    const decided = await cli(["--json", "decide", approval.id, "approve", "--why", "scenario"]);
    check("operator-decide-ok", decided.code === 0, decided.err.join("\n"));
    phases.push("chat-approval-decided");

    // Repair counters are snapshotted before the repair; the repair must not dispatch or add a source record.
    const beforeRepair = { dispatches: budget.feedDispatches + budget.itemDispatches, responses: records.length };
    const repaired = await raceDeadline(adapter.handleInbound(repairMsg), signal);
    check("chat-retry-launched", repaired.kind === "launched", JSON.stringify(repaired));
    const taskR = (repaired as { agent: string }).agent;
    const exitR = await waitExit(r2, taskR, signal);
    if (exitR !== "succeeded") throw new Error(`repair task exit ${exitR}: ${await debugTask(r2, taskR)}`);
    checks["repair-succeeded"] = true;
    phases.push("repair");
    const afterRepair = { dispatches: budget.feedDispatches + budget.itemDispatches, responses: records.length };
    check("repair-fetches-none", afterRepair.dispatches === beforeRepair.dispatches && afterRepair.responses === beforeRepair.responses);
    const repairResult = resultOf(await r2.daemon.get(taskR as never));
    entryIds.repair.push(...repairResult.entryIds);
    runIds.push(repairResult.runId);
    check("repair-keeps-initial-report", repairResult.reportId === initialReportId, `${repairResult.reportId} vs ${initialReportId}`);
    check("repair-keeps-original-run", repairResult.runId === taskA, `${repairResult.runId} vs ${taskA}`);
    check("repair-has-items", repairResult.entryIds.length >= 1, String(repairResult.entryIds.length));
    const repairSnapshot = await r2.daemon.outbox({ channel: "discord", from: 0 });
    const repairDigest = repairSnapshot.filter((e) => isDigestPost(e.payload)).length;
    counts.repairDigestOutbox = repairDigest;
    check("one-digest-after-repair", repairDigest === 1, String(repairDigest));

    // Fresh run on the same instance with a new key: items not seen before, so the result ids must be disjoint from the repair's.
    const fresh = await cli([
      "--json",
      "workflow",
      "launch",
      WORKFLOW,
      "--input",
      JSON.stringify({ instance: "scenario", limit: 2, ask: false }),
      "--key",
      "scenario-2",
    ]);
    check("fresh-launch-ok", fresh.code === 0, fresh.err.join("\n"));
    const taskF = (JSON.parse(fresh.out.join("\n")) as { agent: string }).agent;
    const exitF = await waitExit(r2, taskF, signal);
    if (exitF !== "succeeded") throw new Error(`fresh task exit ${exitF}: ${await debugTask(r2, taskF)}`);
    phases.push("fresh-run");
    const freshResult = resultOf(await r2.daemon.get(taskF as never));
    entryIds.fresh.push(...freshResult.entryIds);
    check(
      "fresh-disjoint-from-repair",
      freshResult.entryIds.every((id) => !repairResult.entryIds.includes(id)),
    );
    check("fresh-new-report", freshResult.reportId !== initialReportId);
    reportIds.push(freshResult.reportId);

    // Final populations, read after the fresh run and a final adapter poll.
    await poll();
    const finalReports = digestReports(await reportStore().list(r2.root.id));
    check("two-reports-final", finalReports.length === 2, String(finalReports.length));
    const freshBody = await reportStore().read(r2.root.id, freshResult.reportId as never);
    if (!freshBody) throw new Error("scenario: fresh report content missing");
    check("fresh-report-has-content", freshBody.content.byteLength > 0);
    const finalJournal = await r2.daemon.outbox({ channel: "discord", from: 0 });
    outboxPurposes = finalJournal.map((e) => (e.payload as { purpose: string }).purpose);
    const digestOutbox = finalJournal.filter((e) => isDigestPost(e.payload)).length;
    check("two-digest-outbox-final", digestOutbox === 2, String(digestOutbox));
    const digestPosts = transcript.filter((t) => t.content.startsWith("[report] HN digest")).length;
    check("two-digest-transcript-posts", digestPosts === 2, String(digestPosts));
    counts.digestOutbox = digestOutbox;
    counts.reports = finalReports.length;
    counts.transcriptLength = transcript.length;
    counts.digestPosts = digestPosts;
    counts.repairEntries = repairResult.entryIds.length;
    counts.freshEntries = freshResult.entryIds.length;

    // Source budget: the ordinary run is one feed (per run) and two items per run.
    check("dispatch-feeds-2", budget.feedDispatches === 2, String(budget.feedDispatches));
    check("dispatch-items-4", budget.itemDispatches === 4, String(budget.itemDispatches));
    check("dispatch-no-failures", budget.dispatchFailures === 0, String(budget.dispatchFailures));
    if (r2.unusedCalls.length !== 0) throw new Error("scenario: unused ports were called");
    checks["no-model-or-container-calls"] = true;
    phases.push("final-counts");
  } catch (e) {
    status = "failed";
    error = redact(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    const unusedCalls = rt?.unusedCalls ?? [];
    if (rt) {
      try {
        await rt.close();
      } catch (e) {
        const msg = redact(e instanceof Error ? e.message : String(e));
        cleanup = { ok: false, error: msg, preservedStateDir: stateDir };
        // The original failure (if any) stays first; a cleanup failure alone also fails the run.
        error = error === undefined ? `cleanup failed: ${msg}` : `${error}; cleanup failed: ${msg}`;
        status = "failed";
      }
    }
    counts.feedDispatches = budget.feedDispatches;
    counts.itemDispatches = budget.itemDispatches;
    counts.dispatchFailures = budget.dispatchFailures;
    counts.responses = records.length;
    const endedAt = Date.now();
    const elapsedMs = endedAt - startedAt;
    if (status === "passed" && elapsedMs > deadlineMs) {
      status = "failed";
      error = "scenario exceeded its total deadline";
    }
    writeFile(join(artifactDir, "transcript.json"), JSON.stringify(transcript, null, 2));
    writeFile(join(artifactDir, "source", "sources.json"), JSON.stringify(records, null, 2));
    const result: ScenarioSummary = {
      status,
      live,
      artifactDir,
      timing: { deadlineMs, reserveMs, startedAt, endedAt, elapsedMs },
      dispatch: {
        feedDispatches: budget.feedDispatches,
        itemDispatches: budget.itemDispatches,
        dispatchFailures: budget.dispatchFailures,
        responses: records.length,
      },
      checks,
      counts,
      phases,
      runIds,
      reportIds,
      entryIds,
      outboxPurposes,
      unusedCalls,
      simulatedDiscord: true,
      cleanup,
      ...(error !== undefined && { error }),
    };
    writeFile(join(artifactDir, "manifest.json"), JSON.stringify(result, null, 2));
    // Diagnostic state survives an unclean close; it is only removed once the runtime reported a clean close.
    if (cleanup.ok) rmSync(stateDir, { recursive: true, force: true });
  }
  return JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as ScenarioSummary;
}

// Digest posts are the root-owned report-purpose outbox entries for this workflow.
function isDigestPost(payload: unknown): boolean {
  const p = payload as { purpose?: unknown; subject?: unknown };
  return p.purpose === "report" && typeof p.subject === "string" && p.subject.startsWith("HN digest");
}

// Direct CLI: `node scenario.mts [--live-hn] [--deadline-ms N]`. A failed run writes status failed and exits nonzero.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--deadline-ms");
  const deadlineMs = i >= 0 ? Number(process.argv[i + 1]) : undefined;
  const fetchUserAgent = process.env.POMTREED_WORKFLOW_FETCH_USER_AGENT;
  runScenario({
    liveHn: process.argv.includes("--live-hn"),
    ...(deadlineMs !== undefined && { deadlineMs }),
    ...(fetchUserAgent !== undefined && { fetchUserAgent }),
  })
    .then((s) => {
      console.log(`scenario ${s.status}; artifacts: ${s.artifactDir}`);
      if (s.error) console.error(`scenario error: ${s.error}`);
      process.exitCode = s.status === "passed" ? 0 : 1;
    })
    .catch((e) => {
      console.error(`scenario failed: ${redact(e instanceof Error ? e.message : String(e))}`);
      process.exitCode = 1;
    });
}
