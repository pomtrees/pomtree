// Shared offline harness for the content-tree tests: real SQLite + canonical operator launch, offline source transport,
// mechanical worker and scripted model harness. Imported by content*.test.mts; contains no tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_TOOL } from "../../packages/agent-image/ext/pomtree-analyst/analyst-contract.ts";
import { ScriptHarness } from "../../packages/testing/src/test-harness.ts";
import { until as pollUntil } from "../../packages/testing/src/index.ts";
import { runStaticWorker } from "./article-worker.mts";
import { captureStaticArticleDetailed } from "./article.mts";
import { pageName } from "./article-pages.mts";
import { captureBrowser } from "../../packages/agent-image/src/browser-capture.ts";
import { nativeCaptureArgs } from "./browser-contract.mts";
import { type ContentBounds, DEFAULT_CONTENT_BOUNDS, captureLimitsOption } from "./content-bounds.mts";
import { dispatchBrowserWorkerTool } from "./content-live-stub.mts";
import { BROWSER_LIMITS } from "./content-browser-method.mts";
import { approvedBrowserWorker, createJournalCaptureAuthority } from "./content-authority.mts";
import { type ContentInput, EVIDENCE_BEGIN, EVIDENCE_END, type EvidenceBundle, hash, jsonHash } from "./content-contract.mts";
import { openContentRuntime } from "./content-runtime.mts";
import type { CaptureReceipt } from "./content-evidence.mts";
import type { ReportStore } from "../../packages/core/src/index.ts";
import type { Runtime } from "./runtime.mts";

const HTML = readFileSync(new URL("./content-fixtures/article-positive.html", import.meta.url), "utf8");
export const INPUT: ContentInput = {
  instance: "offline-content",
  limit: 1,
  workers: {
    articleTemplate: "capture-static",
    articleMethod: "static-http",
    publicEgressAuthorization: "operator-approved-profile-record",
    modelTemplate: "grounded-model",
    modelRoute: "fixture/model",
    modelBudgetMicros: 5000,
    articleBudgetMicros: 1000,
    modelAuthorization: "offline-fixture-only",
  },
};
const fixtureInput = { storyId: 101, url: "https://example.com/article", itemHash: "a".repeat(64), maxBytes: 32768 };
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
// The analysis prompt carries the evidence JSON between fixed untrusted-data delimiters.
export const evidenceOf = (prompt: string): EvidenceBundle =>
  JSON.parse(prompt.slice(prompt.lastIndexOf(EVIDENCE_BEGIN) + EVIDENCE_BEGIN.length, prompt.lastIndexOf(EVIDENCE_END)).trim()) as EvidenceBundle;
export async function until<T>(read: () => Promise<T | null | undefined | false>, note: string): Promise<T> {
  let found: T | undefined;
  await pollUntil(
    async () => {
      const result = await read();
      if (!result) return false;
      found = result;
      return true;
    },
    7000,
    { what: note, intervalMs: 5 },
  );
  return found as T;
}

// What a scripted analyst does: reads the first article page the host published to it (the same reports `pomtree report show` reads) and
// returns its text without the untrusted-data banner. Empty when the story has no usable article.
export async function firstArticlePage(rt: { reportStore: Pick<ReportStore, "read"> }, agent: string, evidence: EvidenceBundle): Promise<string> {
  if (evidence.article?.status !== "usable") return "";
  const page = await until(() => rt.reportStore.read(agent, pageName(1)), "article page 1 published to the analyst");
  return Buffer.from(page.content).toString("utf8").split("\n\n").slice(1).join("\n\n").trim();
}

// The tool call a scripted model makes to read the first page, and the page text out of that tool's result (the `pomtree report show` output: the
// metadata block, then the host's banner, a blank line and the text). Empty when the output holds no page.
export const READ_FIRST_PAGE_CALL = { name: PAGE_TOOL, args: { page: 1 } } as const;
export const articlePageText = (shown: string): string => /\[UNTRUSTED ARTICLE TEXT[^\n]*\]\n\n([\s\S]*)/.exec(shown)?.[1]?.trim() ?? "";
// Every `text` and `content` string inside a provider message value, newline-joined: tool results nest their text in either shape.
export function textsIn(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textsIn).join("\n");
  if (typeof value === "object" && value !== null) {
    const o = value as { text?: unknown; content?: unknown };
    return [o.text, o.content]
      .map(textsIn)
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

// `articleText` is text the analyst read (a page); article citations quote from it.
export function modelResult(evidence: EvidenceBundle, worstCase = false, articleText = "") {
  const article = evidence.article;
  const comment = evidence.comments.find((s) => s.status === "usable");
  const commentQuote = comment ? Array.from(comment.text).slice(0, 120).join("") : "";
  const claims = [];
  if (article?.status === "usable")
    claims.push({
      observation: "The captured article describes silent batch record loss and an append-only attempt ledger remedy.",
      basis: "article",
      tentative: true,
      citations: [{ kind: "article", id: evidence.story.id, sha256: article.textHash, quote: Array.from(articleText).slice(0, 500).join("") }],
    });
  if (comment)
    claims.push({
      observation: worstCase
        ? "The captured sample contains repeated astral fixture symbols; no opinion can be inferred."
        : "One captured commenter values clear documentation.",
      basis: "comments",
      tentative: true,
      citations: [{ kind: "comment", id: comment.id, sha256: comment.sha256, quote: commentQuote }],
    });
  return {
    summary: "Grounded fixture analysis",
    storyId: evidence.story.id,
    evidenceHash: jsonHash(evidence),
    claims,
    sentiment: comment
      ? {
          label: worstCase ? "unclear" : "positive",
          target: "captured comments on this story",
          summary: worstCase
            ? "The synthetic captured symbols express no interpretable sentiment."
            : "The captured comment values the documentation; a single comment is too thin for a general sentiment inference.",
          citations: [comment.id],
          scope: "captured_depth1_sample_only",
          tentative: true,
        }
      : null,
    sentimentEvidence: comment ? [{ kind: "comment", id: comment.id, sha256: comment.sha256, quote: commentQuote }] : [],
  };
}

// The image the harness approves for browser workers (the template carries it into the spawned record).
const HARNESS_BROWSER_IMAGE = `fixture/browser@sha256:${"b".repeat(64)}`;

export type Options = {
  // The bounds the whole composition shares (workers, verifier, workflows); default: the registry defaults.
  bounds?: ContentBounds;
  // Where the scripted analyst's article quote comes from: "head" the first page it read (default), "tail" the end of the whole stored text
  // (a part it was never offered, so the host's whole-text check is what accepts it), "absent" a sentence that is in no part of the article.
  articleQuote?: "head" | "tail" | "absent";
  articleFailure?: boolean;
  // Replaces the fixture article response (static capture only): status, content type and body as the worker's transport returns them.
  page?: { status?: number; contentType?: string; body: string };
  deny?: boolean;
  cancel?: boolean;
  timeout?: boolean;
  noItems?: boolean;
  allUnusable?: boolean;
  attention?: boolean;
  stories?: 1 | 2 | 3;
  // Feed ids (default 101..100+stories) and the launch input's already-seen ids.
  feed?: number[];
  seen?: number[];
  // Operator-picked item ids in the launch input (no feed is read) and raw item responses that replace the built-in ones for an id.
  pick?: number[];
  items?: Record<number, unknown>;
  // Item ids whose fetch throws (a transient network error), as opposed to answering with an unusable record.
  itemErrors?: number[];
  worstCase?: boolean;
  browser?: boolean;
  // Browser scenario variants (with browser): "missing" returns without invoking browser_capture; "wrong-hash" reports a receipt whose
  // text hash differs from the retained report; "twice" invokes browser_capture a second time; "hang" never returns (the hard deadline stops it).
  // "failed" makes browser_capture return the worker's tool error with `(cause=<browserFailureCause>)` (default bound) and the worker then
  // reports `succeeded` anyway, as a model did in a real run.
  browserCapture?: "missing" | "wrong-hash" | "twice" | "hang" | "failed";
  browserFailureCause?: string;
  // How the browser worker tries to finish: the capture_finish tool (default) or the bash `pomtree result` it no longer has (rejected as tool-not-found).
  browserFinish?: "capture_finish" | "bash";
  // Browser: the viewport PNG exceeds the screenshot bound, so the worker retakes it as the top band (the L3 live case); and a visible
  // text that replaces the extracted article text (e.g. a thin JS-rendered page).
  browserScreenshotReduced?: boolean;
  browserText?: string;
  longInstance?: boolean;
  // Declare the grounded-model template WITHOUT the analyst allowlist profile (the misconfiguration the host must refuse before any analyst starts).
  modelTemplateWithoutProfile?: boolean;
  holdAnalysis?: boolean;
  // Story ids whose analysis result is deliberately invalid (wrong evidence binding), so analysis is null.
  invalidAnalysis?: number[];
};
export async function setup(options: Options = {}) {
  const BOUNDS = options.bounds ?? DEFAULT_CONTENT_BOUNDS;
  const dir = mkdtempSync(join(tmpdir(), "hn-content-real-"));
  mkdirSync(join(dir, "extensions"));
  const receipts = new Map<string, CaptureReceipt>();
  const launchInput = {
    ...INPUT,
    limit: options.stories ?? INPUT.limit,
    instance: options.longInstance ? `long-${"x".repeat(59)}` : INPUT.instance,
    ...(options.seen && { seen: options.seen }),
    ...(options.pick && { pick: options.pick }),
    workers: { ...INPUT.workers, ...(options.browser && { articleMethod: "browser" as const, articleTemplate: "capture-browser" }) },
  };
  const articleBody = options.page ? options.page.body : options.worstCase ? HTML.replace("</article>", `${'\\\\"'.repeat(5000)}</article>`) : HTML;
  const kidsByStory: Record<number, number[]> = { 101: [201, 203], 102: [202, 204], 103: [205, 206], 104: [207, 208], 105: [209, 210] };
  const sourceRequests: string[] = [];
  const starts: string[] = [];
  const errors: string[] = [];
  const captureStarted = deferred();
  const releaseCapture = deferred();
  const analysisStarted = deferred();
  const releaseAnalysis = deferred();
  const commentStarted = deferred();
  const releaseComment = deferred();
  let rt!: Runtime;
  const harness = new ScriptHarness(async (c) => {
    try {
      const agent = await rt.daemon.get(c.agent);
      assert.ok(agent);
      const cancellation = new AbortController();
      void c.stopped.then(() => cancellation.abort());
      starts.push(agent.name);
      if (agent.name.startsWith("article-")) {
        captureStarted.resolve();
        await releaseCapture.promise;
        if (options.articleFailure || options.allUnusable) {
          await rt.daemon.submitResult(c.agent, "failed", { summary: "fixture source unavailable" }, "article-failed");
          return;
        }
        const task = JSON.parse(c.prompt.slice(c.prompt.indexOf('{"kind":"hn-article-capture"')));
        const publish = async (name: string, bytes: Uint8Array, mediaType?: string) => {
          const got = await rt.reports.publish(c.agent, { name, content: bytes, ...(mediaType && { mediaType }), generation: agent.generation, key: name });
          return { id: got.report.id, sha256: got.report.sha256 };
        };
        if (options.browser) assert.deepEqual(task.nativeTool, { name: "browser_capture", arguments: nativeCaptureArgs(task.input, BOUNDS) });
        if (options.browser && options.browserCapture === "hang") return void (await c.stopped);
        if (options.browser && options.browserCapture !== "missing")
          c.emit({ kind: "tool_call", tool: "browser_capture", callId: "native-capture", input: task.nativeTool.arguments });
        if (options.browser && options.browserCapture === "failed") {
          const callId = "native-capture";
          c.emit({
            kind: "tool_result",
            callId,
            ok: false,
            output: `trusted browser capture failed; no receipt issued (cause=${options.browserFailureCause ?? "bound"})`,
          });
          await until(
            async () =>
              (await rt.stores.journal.read({ agent: c.agent, limit: 1000 })).some((e) => e.payload.kind === "tool_result" && e.payload.callId === callId),
            "host ingests the failed capture result before terminal handoff",
          );
          await rt.daemon.submitResult(c.agent, "succeeded", { summary: "capture failed" }, "article-result");
          return;
        }
        const result = options.browser
          ? {
              summary: "Native capture contract with injected page; not real browser proof",
              capture: await captureBrowser(
                {
                  goto: async () => ({
                    body: async () => new TextEncoder().encode(articleBody),
                    status: () => 200,
                    headerValue: async (name) => (name === "content-type" ? "text/html" : String(Buffer.byteLength(articleBody))),
                  }),
                  url: () => task.input.url,
                  evaluate: async () => ({
                    dom: `<html><main>Rendered fixture DOM differs from HTTP entity</main></html>`,
                    text:
                      options.browserText ??
                      captureStaticArticleDetailed(task.input, { status: 200, body: articleBody, sha256: hash(articleBody), contentType: "text/html" }, BOUNDS)
                        .text,
                  }),
                  screenshot: async (o) =>
                    options.browserScreenshotReduced && o.clip === undefined
                      ? new Uint8Array(BOUNDS.capture.screenshotMaxBytes + 1)
                      : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
                  close: async () => {},
                },
                {
                  ...nativeCaptureArgs(task.input, BOUNDS),
                  ...captureLimitsOption(BOUNDS),
                  worker: c.agent,
                  generation: agent.generation,
                  publish: (data, name, type) => publish(name, data, type),
                },
              ),
            }
          : await runStaticWorker(task.input, {
              worker: c.agent,
              generation: agent.generation,
              signal: cancellation.signal,
              profile: "audited-public",
              bounds: BOUNDS,
              transport: async () => ({
                status: options.page?.status ?? 200,
                headers: new Headers({ "content-type": options.page?.contentType ?? "text/html" }),
                body: (async function* () {
                  yield new TextEncoder().encode(articleBody);
                })(),
              }),
              publish: async (name, bytes) => {
                const got = await rt.reports.publish(c.agent, {
                  name,
                  ...(name.endsWith(".md") && { mediaType: "text/plain" }),
                  content: bytes,
                  generation: agent.generation,
                  key: name,
                });
                return { id: got.report.id, sha256: got.report.sha256 };
              },
              record: async (receipt) => {
                receipts.set(`${c.agent}:${agent.generation}`, receipt);
              },
            });
        // The host must ingest each native result before the terminal handoff.
        const ingested = (callId: string) =>
          until(
            async () =>
              (await rt.stores.journal.read({ agent: c.agent, limit: 1000 })).some((e) => e.payload.kind === "tool_result" && e.payload.callId === callId) &&
              true,
            `host ingests native receipt ${callId} before terminal handoff`,
          );
        if (options.browser && options.browserCapture !== "missing") {
          const receipt =
            options.browserCapture === "wrong-hash"
              ? { ...result.capture, textReport: { ...result.capture.textReport, sha256: "b".repeat(64) } }
              : result.capture;
          c.emit({ kind: "tool_result", callId: "native-capture", ok: true, output: JSON.stringify(receipt) });
          await ingested("native-capture");
          if (options.browserCapture === "twice") {
            c.emit({ kind: "tool_call", tool: "browser_capture", callId: "native-capture-2", input: task.nativeTool.arguments });
            c.emit({ kind: "tool_result", callId: "native-capture-2", ok: true, output: JSON.stringify(result.capture) });
            await ingested("native-capture-2");
          }
        }
        if (options.browser && options.browserCapture !== "missing") {
          const tool = options.browserFinish === "bash" ? "bash" : "capture_finish";
          const outcome = dispatchBrowserWorkerTool(tool);
          c.emit({
            kind: "tool_call",
            tool,
            callId: "native-finish",
            input: tool === "bash" ? { command: 'pomtree result --summary "captured"' } : { status: "succeeded", summary: "captured" },
          });
          c.emit({ kind: "tool_result", callId: "native-finish", ok: outcome.ok, output: outcome.text });
          await ingested("native-finish");
          if (!outcome.ok) {
            await rt.daemon.submitResult(c.agent, "failed", { summary: "could not finish" }, "article-result");
            return;
          }
        }
        if (options.attention) {
          const asked = await rt.daemon.ask(c.agent, {
            question: "Fixture capture attention; pass the same escalation",
            generation: agent.generation,
            idempotencyKey: "capture-attention",
          });
          await until(async () => {
            const got = await rt.stores.escalations.get(asked.escalation.id);
            return got?.holder === null && got;
          }, "same capture escalation bubbled to root/human");
        }
        await rt.daemon.submitResult(c.agent, "succeeded", result, "article-result");
      } else {
        const parent = await rt.daemon.get(agent.parent as string);
        const deps = await rt.stores.registry.list({ parent: parent?.id });
        assert.ok(
          deps.filter((d) => d.id !== c.agent).every((d) => d.state === "reaped"),
          "analysis starts only after both capture dependencies reaped",
        );
        const evidence = evidenceOf(c.prompt);
        analysisStarted.resolve();
        if (options.holdAnalysis) await releaseAnalysis.promise;
        const head = await firstArticlePage(rt, c.agent, evidence);
        const stored = evidence.article?.textReport ? await rt.reportStore.read(rt.root.id, evidence.article.textReport.id) : null;
        const whole = Buffer.from(stored?.content ?? []).toString("utf8");
        const quoteFrom =
          options.articleQuote === "tail"
            ? Array.from(whole).slice(-300).join("")
            : options.articleQuote === "absent"
              ? "This sentence appears nowhere in the stored article text."
              : head;
        const result = modelResult(evidence, options.worstCase, quoteFrom);
        await rt.daemon.submitResult(
          c.agent,
          "succeeded",
          options.invalidAnalysis?.includes(evidence.story.id) ? { ...result, evidenceHash: "0".repeat(64) } : result,
          "analysis-result",
        );
      }
    } catch (error) {
      errors.push(String(error));
      throw error;
    }
  });
  rt = await openContentRuntime({
    stateDir: dir,
    extensionDir: join(dir, "extensions"),
    reviewedOwners: ["hn-content"],
    bounds: BOUNDS,
    harness,
    durableGateway: true,
    ...(options.timeout && { approvalTimeoutMs: 30 }),
    templates: [
      { id: "capture-static", provider: "fixture", model: "model", egress: { kind: "audited-public" } },
      {
        id: "capture-browser",
        image: HARNESS_BROWSER_IMAGE,
        provider: "fixture",
        model: "model",
        egress: { kind: "audited-public" },
        browser: { ...BROWSER_LIMITS },
      },
      {
        id: "grounded-model",
        provider: "fixture",
        model: "model",
        egress: { kind: "none" },
        ...(!options.modelTemplateWithoutProfile && { allowlist: "analyst" as const }),
      },
    ],
    mayUseTemplate: (_caller, template) => ["capture-static", "capture-browser", "grounded-model"].includes(template.id),
    models: { list: async () => ({ source: "pi", models: [{ provider: "fixture", id: "model" }] }) },
    captureAuthority: {
      receipt: async (worker, generation, expected) =>
        options.browser
          ? createJournalCaptureAuthority({
              registry: rt.stores.registry,
              journal: rt.stores.journal,
              approvedWorker: (a) => approvedBrowserWorker(a, HARNESS_BROWSER_IMAGE),
              bounds: BOUNDS,
            }).receipt(worker, generation, expected)
          : (receipts.get(`${worker}:${generation}`) ?? null),
    },
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      sourceRequests.push(String(url));
      if (String(url).endsWith("topstories.json"))
        return new Response(JSON.stringify(options.noItems ? [] : (options.feed ?? Array.from({ length: options.stories ?? 1 }, (_, i) => 101 + i))), {
          status: 200,
        });
      const id = Number(String(url).match(/item\/(\d+)\.json$/)?.[1]);
      if (options.itemErrors?.includes(id)) throw new Error("network down");
      if (options.items && id in options.items) return new Response(JSON.stringify(options.items[id]), { status: 200 });
      if (kidsByStory[id])
        return new Response(
          JSON.stringify({ id, type: "story", title: options.worstCase ? "🧪".repeat(300) : "Reliable batches", url: fixtureInput.url, kids: kidsByStory[id] }),
          { status: 200 },
        );
      commentStarted.resolve();
      await releaseComment.promise;
      const owner = Number(Object.keys(kidsByStory).find((story) => kidsByStory[Number(story)]?.includes(id)));
      const usable = !options.allUnusable && (options.worstCase || kidsByStory[owner]?.[0] === id);
      const raw = usable
        ? { id, parent: owner, type: "comment", text: options.worstCase ? "🧪".repeat(1000) : "I appreciate the clear documentation.", time: 1700000201 }
        : { id, parent: owner, type: "comment", deleted: true };
      return new Response(JSON.stringify(raw), { status: 200 });
    },
  });
  const launch = await rt.cli([
    "--json",
    "workflow",
    "launch",
    "hn-content/content",
    "--input",
    JSON.stringify(launchInput),
    "--key",
    "content-offline",
    "--budget",
    "5000",
  ]);
  assert.equal(launch.code, 0, launch.err.join("\n"));
  const id = (JSON.parse(launch.out.join("\n")) as { agent: string }).agent;
  return {
    rt,
    dir,
    id,
    starts,
    errors,
    sourceRequests,
    launchInput,
    captureStarted,
    releaseCapture,
    commentStarted,
    releaseComment,
    analysisStarted,
    releaseAnalysis,
    receipts,
    async cleanup() {
      releaseCapture.resolve();
      releaseComment.resolve();
      releaseAnalysis.resolve();
      // Debug dumps live inside the mkdtemp runtime dir and are removed with it below.
      const prefix = join(dir, `debug-${hash(JSON.stringify(options)).slice(0, 12)}`);
      const agents = await rt.stores.registry.list();
      writeFileSync(`${prefix}-state.json`, JSON.stringify({ agents, errors, journal: await rt.stores.journal.read({ limit: 2000 }) }, null, 2));
      const result = agents.find((a) => a.id === id)?.result as { reportBody?: string } | null;
      if (typeof result?.reportBody === "string") writeFileSync(`${prefix}-report.md`, result.reportBody);
      await rt.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
