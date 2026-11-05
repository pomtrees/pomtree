// Offline checks for the live hn-content composition: preflight refusals (cap, pricing, auth), the secret-free guarantee, and one full
// run through the real composition (SQLite, canonical CLI, proxy, egress collector, host-fetch audit, static article adapter) with a
// scripted Pi harness, fake sandbox and scripted source transport. No Docker, model, network or real credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ANALYST_EXT, ANALYST_TOOLS } from "../../packages/agent-image/ext/pomtree-analyst/analyst-contract.ts";
import { ALLOWLIST_PROFILE_TOOLS } from "../../packages/agent-image/src/allowlist-profiles.ts";
import { PI_EVENTS_EXT, PI_ISOLATION_FLAGS, piArgv } from "../../packages/harness-pi/src/index.ts";
import { ScriptHarness } from "../../packages/testing/src/test-harness.ts";
import { createFakes } from "../../packages/testing/src/fakes.ts";
import { tmpDir } from "../../packages/testing/src/tmp.ts";
import { evidenceOf, firstArticlePage, modelResult } from "./content-harness.mts";
import { collectRun, executeLive, exitCodeOf, fromEgress, provenanceOf, runLiveContent, writeRunOutputs } from "./content-live-run.mts";
import { BROWSER_ARTICLE_BUDGET_MICROS, BROWSER_DEADLINE_MS, BROWSER_LIMITS, BROWSER_TEMPLATE } from "./content-browser-method.mts";
import {
  browserImageCheckCommand,
  BROWSER_IMAGE_PATHS,
  isArticleTask,
  liveContainerConfig,
  liveDefaultDeadlineMs,
  liveSessionMs,
  LIVE_DEFAULT_DEADLINE_MS,
  LIVE_MAX_REQUEST_MICROS,
  LIVE_MODEL,
  ANALYST_ALLOWLIST,
  liveCommand,
  liveLaunchInput,
  liveTemplates,
  MODEL_TEMPLATE,
  CAPTURE_TEMPLATE,
  workerEgress,
  openLiveContentRuntime,
  pinnedTransport,
  createLiveBaseRepo,
  planCaps,
  preflightLive,
  readUpstreamKey,
  requireLivePricing,
  requireLiveUpstream,
} from "./content-live-runtime.mts";
import { CONFIG_REGISTRY, CONTAINER_CONFIG_ENV, containerConfigEnv } from "../../packages/core/src/index.ts";
import { CONTENT_CONFIG_DEFAULTS, type ContentConfig } from "./content-bounds.mts";
import { TEST_FETCH_USER_AGENT } from "./runtime.mts";
import { resolveLiveConfig } from "./content-live.mts";
import { storyNumberOf } from "./content-story.mts";
import { CONTENT_LIMIT } from "./content-contract.mts";

const HTML = readFileSync(new URL("./content-fixtures/article-positive.html", import.meta.url), "utf8");
const UPSTREAM = "https://openrouter.ai/api"; // the offline tests never reach it: modelFetch throws
const SENTINEL = "sk-or-v1-SENTINEL-do-not-leak-0123456789";

const tmp = () => tmpDir("hn-live-test-");
// An offline Pi-shaped catalog for the route (rates are USD per million tokens), so no host install is read.
const FIXTURE_CATALOG = tmp();
writeFileSync(
  join(FIXTURE_CATALOG, "openrouter.json"),
  JSON.stringify({
    "anthropic-messages": {
      [`chat:${LIVE_MODEL}`]: {
        id: LIVE_MODEL,
        type: "chat",
        api: "anthropic-messages",
        baseUrl: "https://openrouter.ai/api",
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      },
    },
  }),
);
after(() => rmSync(FIXTURE_CATALOG, { recursive: true, force: true }));
function keyFile(dir: string, body: string): string {
  const path = join(dir, "upstream.key");
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

test("caps: defaults per story count, the 1000000 ceiling and the per-request funding floor", () => {
  assert.deepEqual(planCaps({ stories: 1 }), {
    stories: 1,
    modelBudgetMicros: 200_000,
    rootBudgetMicros: 500_000,
    maxRequestMicros: LIVE_MAX_REQUEST_MICROS,
    articleBudgetMicros: 1_000,
  });
  const three = planCaps({ stories: 3 });
  assert.equal(three.modelBudgetMicros, 600_000);
  assert.equal(three.rootBudgetMicros, 700_000);
  assert.throws(() => planCaps({ stories: 1, budgetMicros: 1_000_001 }), /--i-know-the-cap/);
  assert.equal(planCaps({ stories: 1, budgetMicros: 1_000_001, iKnowTheCap: true }).modelBudgetMicros, 1_000_001);
  assert.throws(() => planCaps({ stories: 4 }), /--stories/);
  assert.throws(() => planCaps({ stories: 3, budgetMicros: 90_000 }), /cannot fund/);
  assert.throws(() => planCaps({ stories: 1, budgetMicros: 0 }), /positive/);
});

test("pricing: a missing or lacking catalog refuses to start instead of charging the floor", () => {
  const dir = tmp();
  try {
    assert.throws(() => requireLivePricing({ POMTREED_PI_CATALOG_DIR: dir, PATH: "" }, dir), /refusing to start/); // no openrouter.json at all
    writeFileSync(join(dir, "openrouter.json"), "{}");
    assert.throws(() => requireLivePricing({ POMTREED_PI_CATALOG_DIR: dir, PATH: "" }, dir), /not priced/); // catalog without the route
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing: the fixture catalog prices the haiku route", () => {
  const rates = requireLivePricing({ POMTREED_PI_CATALOG_DIR: FIXTURE_CATALOG, PATH: "" });
  assert.ok(rates.input > 0 && rates.output > 0);
});

test("upstream: derived from the catalog entry's baseUrl; a missing entry, missing baseUrl or foreign origin refuses", () => {
  const dir = tmp();
  const env = { POMTREED_PI_CATALOG_DIR: dir, PATH: "" };
  const entry = (extra: Record<string, unknown>) =>
    writeFileSync(join(dir, "openrouter.json"), JSON.stringify({ "anthropic-messages": { m: { id: LIVE_MODEL, type: "chat", ...extra } } }));
  try {
    assert.throws(() => requireLiveUpstream(env, dir), /unreadable/);
    writeFileSync(join(dir, "openrouter.json"), "{}");
    assert.throws(() => requireLiveUpstream(env, dir), /no entry/);
    entry({});
    assert.throws(() => requireLiveUpstream(env, dir), /no baseUrl/);
    entry({ baseUrl: "https://evil.example/api" });
    assert.throws(() => requireLiveUpstream(env, dir), /must be a plain https:\/\/openrouter\.ai URL/);
    entry({ api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" });
    assert.equal(requireLiveUpstream(env, dir), "https://openrouter.ai/api");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upstream: the fixture catalog's route resolves to an openrouter.ai base", () => {
  assert.match(requireLiveUpstream({ POMTREED_PI_CATALOG_DIR: FIXTURE_CATALOG, PATH: "" }, tmp()), /^https:\/\/openrouter\.ai(\/[a-z0-9/]*)?$/);
});

test("upstream key: an unset variable, a missing, empty, group-readable or relative file each refuse (core's secret-file rule), naming no key value; a good file loses its trailing newline", () => {
  const dir = tmp();
  try {
    assert.throws(() => readUpstreamKey({}), /POMTREED_MODEL_UPSTREAM_KEY_FILE is required/);
    const absent = join(dir, "absent.key");
    assert.throws(
      () => readUpstreamKey({ POMTREED_MODEL_UPSTREAM_KEY_FILE: absent }),
      (e: Error) => e.message.includes(`cannot read ${absent}`),
    );
    assert.throws(() => readUpstreamKey({ POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile(dir, "  \n") }), /empty/);
    const loose = keyFile(dir, `${SENTINEL}\n`);
    chmodSync(loose, 0o644);
    assert.throws(
      () => readUpstreamKey({ POMTREED_MODEL_UPSTREAM_KEY_FILE: loose }),
      (e: Error) => e.message.includes(`${loose} is readable by group/other; run chmod 600`) && !e.message.includes(SENTINEL),
    );
    assert.throws(() => readUpstreamKey({ POMTREED_MODEL_UPSTREAM_KEY_FILE: "upstream.key" }), /expected an absolute path/);
    chmodSync(loose, 0o600);
    assert.equal(readUpstreamKey({ POMTREED_MODEL_UPSTREAM_KEY_FILE: keyFile(dir, `${SENTINEL}\n`) }), SENTINEL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight: an over-cap request, an unpriced model and a missing key file each refuse before anything opens", () => {
  const dir = tmp();
  try {
    const good = keyFile(dir, SENTINEL);
    const env = { POMTREED_PI_CATALOG_DIR: FIXTURE_CATALOG, PATH: "", POMTREED_MODEL_UPSTREAM_KEY_FILE: good };
    assert.equal(preflightLive({ env, stories: 1, home: dir }).caps.modelBudgetMicros, 200_000);
    assert.throws(() => preflightLive({ env, stories: 1, budgetMicros: 2_000_000, home: dir }), /refusing --budget-micros/);
    assert.throws(() => preflightLive({ env: { ...env, POMTREED_PI_CATALOG_DIR: dir }, stories: 1, home: dir }), /refusing to start/);
    assert.throws(
      () => preflightLive({ env: { ...env, POMTREED_MODEL_UPSTREAM_KEY_FILE: join(dir, "nope.key") }, stories: 1, home: dir }),
      /upstream key file refused: POMTREED_MODEL_UPSTREAM_KEY_FILE: cannot read /,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TODO(analyst-allowlist) landing criterion: the analyst's Pi argv offers exactly the page reader and the result tool, loads only the events
// sink and the analyst extension, and has the isolation flags; nothing in it can widen the tool set.
function assertAnalystArgv(argv: string[]): void {
  const sep = argv.indexOf("--");
  const head = argv.slice(0, sep);
  assert.deepEqual(
    head.filter((a) => a === "--tools" || a === "-t" || a.startsWith("--tools=")),
    ["--tools"],
    "exactly one tool flag",
  );
  assert.equal(head[head.indexOf("--tools") + 1], [...ANALYST_TOOLS].join(","));
  assert.equal(head[head.indexOf("--tools") + 1], "article_page,analysis_result");
  assert.deepEqual(
    head.flatMap((a, i) => (a === "--extension" ? [head[i + 1]] : [])),
    [PI_EVENTS_EXT.path, ANALYST_EXT],
  );
  for (const f of PI_ISOLATION_FLAGS) assert.ok(head.includes(f), f);
  assert.ok(!head.includes("--append-system-prompt"), "no guide: it teaches shell commands");
  for (const gone of ["bash", "read", "write", "edit", "web_search", "web_fetch", "mailbox", "jobs", "--no-tools", "--no-builtin-tools"])
    assert.ok(!head.some((a) => a === gone || a.includes(`/${gone}`) || a.split(",").includes(gone)), gone);
}

test("analyst argv (negative variants): any widening of the tool set is refused by piArgv, so no caller can build one", () => {
  assert.throws(() => piArgv({ prompt: "p", allowlist: ANALYST_ALLOWLIST, tools: ["bash"] }), /excludes/);
  const widened = piArgv({ prompt: "p", allowlist: { ...ANALYST_ALLOWLIST, tools: [...ANALYST_TOOLS, "bash"] } });
  assert.throws(() => assertAnalystArgv(widened));
  const defaults = piArgv({ prompt: "p" });
  assert.throws(() => assertAnalystArgv(defaults), "the default Pi argv (all built-in tools) fails the same check");
  assert.throws(() => assertAnalystArgv(["pi", "--tools", "article_page,analysis_result,bash", "--", "p"]));
  assert.throws(() => assertAnalystArgv(["pi", "--tools", "article_page,analysis_result", "--tools", "bash", "--", "p"]));
});

test("harness command: article tasks get an inert container command, analysis gets the pinned openrouter route", () => {
  assert.equal(isArticleTask('x {"kind":"hn-article-capture","input":{}}'), true);
  assert.deepEqual(liveCommand('{"kind":"hn-article-capture"'), ["sleep", "3600"]);
  const argv = liveCommand("analyze this", { allowlist: "analyst" });
  assert.ok(argv.includes("openrouter") && argv.includes(LIVE_MODEL), argv.join(" "));
  assertAnalystArgv(argv);
  assert.deepEqual(argv, piArgv({ prompt: "analyze this", provider: "openrouter", model: LIVE_MODEL, allowlist: ALLOWLIST_PROFILE_TOOLS.analyst }));
  assert.deepEqual(ANALYST_ALLOWLIST, { tools: ANALYST_TOOLS, extension: ANALYST_EXT }, "the live runtime reads the one profile table");
  assert.equal(liveTemplates().find((x) => x.id === "grounded-model")?.allowlist, "analyst", "the reviewed model template names the profile");
  // Negative: an analysis spec without the profile never gets an argv (the default loadout has a shell).
  assert.throws(() => liveCommand("analyze this"), /analyst allowlist profile/);
  assert.throws(() => liveCommand("analyze this", {}), /analyst allowlist profile/);
  const t = liveTemplates();
  assert.deepEqual(
    t.map((x) => [x.id, x.egress?.kind]),
    [
      ["capture-static", "audited-public"],
      ["grounded-model", "registry"],
    ],
  );
  const input = liveLaunchInput(planCaps({ stories: 3 }), "i");
  assert.equal(input.workers.articleMethod, "static-http");
  assert.equal(input.workers.modelRoute, "openrouter/anthropic/claude-haiku-5.5");
  assert.ok(!("pick" in input), "no pick unless the operator picked");
  assert.deepEqual(liveLaunchInput(planCaps({ stories: 2 }), "i", [], "static-http", [42, 7]).pick, [42, 7]);
});

// The worker egress the daemon resolves for each reviewed template (pomtreed's egressPolicy over the template's policy, the agent API and the
// model proxy). Regression for TODO(model-egress): egress `none` resolved to no relay, so the grounded-model worker could not reach the proxy.
const API = "http://host.docker.internal:4321";
const PROXY = "http://host.docker.internal:9000";
const PROXY_TARGET = { host: "host.docker.internal", port: 9000 };

test("grounded-model egress: relay-only; the model proxy is relayed and nothing public is allowed", () => {
  const e = workerEgress(MODEL_TEMPLATE, { apiUrl: API, modelBaseUrl: PROXY });
  assert.ok(
    e.relay?.some((t) => t.host === PROXY_TARGET.host && t.port === PROXY_TARGET.port),
    JSON.stringify(e),
  );
  assert.deepEqual(e.relay, [
    { host: "host.docker.internal", port: 4321 },
    { host: "host.docker.internal", port: 9000 },
  ]);
  assert.deepEqual(e.allow, e.relay); // allow holds only the relayed endpoints: no registry host, no provider host, no public target
  assert.ok((e.allow ?? []).every((t) => t.host === "host.docker.internal"));
  assert.equal(e.auditedPublic, undefined);
  // The model proxy alone (no agent API) is exactly the proxy.
  assert.deepEqual(workerEgress(MODEL_TEMPLATE, { modelBaseUrl: PROXY }).relay, [PROXY_TARGET]);
});

test("capture-static keeps audited-public egress", () => {
  const e = workerEgress(CAPTURE_TEMPLATE, { apiUrl: API, modelBaseUrl: PROXY, host: "h1", generation: 0 });
  assert.deepEqual(e.auditedPublic, { host: "h1", generation: 0 });
  assert.equal(liveTemplates().find((t) => t.id === CAPTURE_TEMPLATE)?.egress?.kind, "audited-public");
});

test("workerEgress rejects an unknown template", () => {
  assert.throws(() => workerEgress("nope", { modelBaseUrl: PROXY }), /unknown template/);
});

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

type Opened = Awaited<ReturnType<typeof openLiveContentRuntime>>;
async function openOffline(
  stateDir: string,
  caps: ReturnType<typeof planCaps>,
  analysis: (rt: () => Opened | undefined) => ConstructorParameters<typeof ScriptHarness>[0],
  sourceRequests: string[] = [],
  extra: { config?: ContentConfig; fakes?: { f?: ReturnType<typeof createFakes> } } = {},
): Promise<Opened> {
  mkdirSync(join(stateDir, "repo"), { recursive: true });
  let rt: Opened | undefined;
  rt = await openLiveContentRuntime({
    stateDir,
    repoDir: join(stateDir, "repo"),
    caps,
    upstreamKey: SENTINEL,
    upstreamBaseUrl: UPSTREAM,
    bridgeGateway: TEST_BRIDGE_GATEWAY,
    modelFetch: async () => {
      throw new Error("offline: the model transport must not be used");
    },
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    config: { ...(extra.config ?? CONTENT_CONFIG_DEFAULTS), "workflow.fetch.userAgent": TEST_FETCH_USER_AGENT },
    sourceFetch: async (url) => {
      sourceRequests.push(url);
      const bytes = (v: string) =>
        (async function* () {
          yield new TextEncoder().encode(v);
        })();
      const json = (v: unknown) => ({ status: 200, headers: new Headers(), body: bytes(JSON.stringify(v)) });
      if (url.endsWith("topstories.json")) return json([101]);
      if (url.endsWith("/item/101.json"))
        return json({ id: 101, type: "story", title: "Reliable batches", url: "https://example.com/article", kids: [201, 203] });
      if (url.endsWith("/item/201.json"))
        return json({ id: 201, parent: 101, type: "comment", text: "I appreciate the clear documentation.", time: 1700000201 });
      if (url.endsWith("/item/203.json")) return json({ id: 203, parent: 101, type: "comment", deleted: true });
      if (url === "https://example.com/article") return { status: 200, headers: new Headers({ "content-type": "text/html" }), body: bytes(HTML) };
      throw new Error(`unexpected source request ${url}`);
    },
    wire: ({ hostId }) => {
      const f = createFakes({ host: hostId });
      if (extra.fakes) extra.fakes.f = f;
      return { sandbox: f.sandbox, placement: f.placement, workspace: f.workspace };
    },
    piHarness: () => new ScriptHarness(analysis(() => rt)),
  });
  return rt;
}

test("composition: deadline cancels cleanly; nothing is published or marked seen and the assertions still hold", { timeout: 60000 }, async () => {
  const stateDir = tmp();
  const caps = planCaps({ stories: 1 });
  let rt: Opened | undefined;
  const originalError = console.error;
  console.error = () => {};
  try {
    rt = await openOffline(stateDir, caps, () => async (c) => {
      await c.stopped; // the analysis worker never answers
    });
    const handle = await runLiveContent(rt, caps, { deadlineMs: 400, approval: "approve", pollMs: 20, settleMs: 10_000 });
    assert.equal(handle.deadlineHit, true);
    assert.equal(handle.outcome, "cancelled");
    const bundle = await collectRun(rt, caps, handle);
    assert.deepEqual(bundle.facts.seen, []);
    assert.equal(bundle.facts.publishedReport, null);
    assert.deepEqual(
      bundle.verdict.checks.filter((c) => !c.ok),
      [],
    );
  } finally {
    console.error = originalError;
    await rt?.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("composition: full offline run publishes, every assertion holds, and the upstream key appears nowhere", { timeout: 60000 }, async () => {
  const stateDir = tmp();
  const outDir = join(tmp(), "out");
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  mkdirSync(join(stateDir, "repo"));
  const caps = planCaps({ stories: 1 });
  const sourceRequests: string[] = [];
  let rt: Awaited<ReturnType<typeof openLiveContentRuntime>> | undefined;
  try {
    const fakesRef: { f?: ReturnType<typeof createFakes> } = {};
    rt = await openLiveContentRuntime({
      stateDir,
      repoDir: join(stateDir, "repo"),
      caps,
      upstreamKey: SENTINEL,
      upstreamBaseUrl: UPSTREAM,
      bridgeGateway: TEST_BRIDGE_GATEWAY,
      hostAuditLog: join(outDir, "host-audit.jsonl"),
      config: { ...CONTENT_CONFIG_DEFAULTS, "workflow.fetch.userAgent": TEST_FETCH_USER_AGENT },
      modelFetch: async () => {
        throw new Error("offline: the model transport must not be used");
      },
      resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
      sourceFetch: async (url) => {
        sourceRequests.push(url);
        const json = (v: unknown) => ({
          status: 200,
          headers: new Headers(),
          body: (async function* () {
            yield new TextEncoder().encode(JSON.stringify(v));
          })(),
        });
        if (url.endsWith("topstories.json")) return json([101]);
        if (url.endsWith("/item/101.json"))
          return json({ id: 101, type: "story", title: "Reliable batches", url: "https://example.com/article", kids: [201, 203] });
        if (url.endsWith("/item/201.json"))
          return json({ id: 201, parent: 101, type: "comment", text: "I appreciate the clear documentation.", time: 1700000201 });
        if (url.endsWith("/item/203.json")) return json({ id: 203, parent: 101, type: "comment", deleted: true });
        if (url === "https://example.com/article")
          return {
            status: 200,
            headers: new Headers({ "content-type": "text/html" }),
            body: (async function* () {
              yield new TextEncoder().encode(HTML);
            })(),
          };
        throw new Error(`unexpected source request ${url}`);
      },
      wire: ({ hostId }) => {
        const f = createFakes({ host: hostId });
        fakesRef.f = f;
        return { sandbox: f.sandbox, placement: f.placement, workspace: f.workspace };
      },
      piHarness: () =>
        new ScriptHarness(async (c) => {
          const agent = await rt?.daemon.get(c.agent);
          assert.ok(agent);
          const evidence = evidenceOf(c.prompt);
          const text = rt ? await firstArticlePage(rt, c.agent, evidence) : "";
          c.emit({ kind: "tool_call", tool: "article_page", callId: "page-1", input: { page: 1 } });
          c.emit({ kind: "tool_result", callId: "page-1", ok: true, output: text });
          c.emit({ kind: "tool_call", tool: "analysis_result", callId: "result-1", input: { summary: "s" } });
          c.emit({ kind: "tool_result", callId: "result-1", ok: true, output: "result recorded" });
          await rt?.daemon.submitResult(c.agent, "succeeded", modelResult(evidence, false, text), "analysis-result");
        }),
    });
    const handle = await runLiveContent(rt, caps, { deadlineMs: 45_000, approval: "approve", pollMs: 20 });
    assert.equal(handle.outcome, "published", JSON.stringify(handle) + logs.slice(0, 8).join("\n"));
    const bundle = await collectRun(rt, caps, handle);
    assert.deepEqual(
      bundle.verdict.checks.filter((c) => !c.ok),
      [],
    );
    assert.equal(bundle.verdict.ok, true);
    assert.deepEqual([...new Set(rt.hostAudit.records().map((r) => r.authority))].sort(), ["example.com", "hacker-news.firebaseio.com"]);
    assert.ok(rt.hostAudit.records().every((r) => r.outcome === "complete"));
    const files = writeRunOutputs(outDir, caps, handle, bundle);
    for (const f of [
      "digest.md",
      "cost-ledger.json",
      "egress-audit.json",
      "assertions.json",
      "run.json",
      "stories/101.json",
      "approvals.json",
      "provenance.json",
    ])
      assert.ok(files.includes(f), f);
    const json = (name: string) => JSON.parse(readFileSync(join(outDir, name), "utf8"));
    const assertionsFile = json("assertions.json");
    assert.deepEqual(assertionsFile.inputs.seen, [101]);
    assert.ok(assertionsFile.inputs.expectedAuthorities.includes("example.com"));
    assert.ok(Array.isArray(assertionsFile.inputs.retainedSha256) && Array.isArray(assertionsFile.inputs.approvals));
    assert.ok(Array.isArray(assertionsFile.warnings));
    const approvalFile = json("approvals.json");
    assert.equal(approvalFile.length, 1);
    assert.equal(approvalFile[0].action.kind, "publish");
    assert.equal(approvalFile[0].state, "approved");
    assert.equal(approvalFile[0].decidedBy, "operator");
    assert.match(approvalFile[0].why, /live run approve by flag/);
    assert.ok(approvalFile[0].id && approvalFile[0].decidedAt && approvalFile[0].rungs.length > 0);
    // The analyst's own account: its two tool calls, the page it read of those offered, and the allowlist assertion over the real journal.
    assert.ok(files.includes("workers/101.analysis.json"));
    const analysis = json("workers/101.analysis.json");
    assert.deepEqual(
      analysis.tools.map((t: { tool: string; page: number | null; ok: boolean }) => [t.tool, t.page, t.ok]),
      [
        ["article_page", 1, true],
        ["analysis_result", null, true],
      ],
    );
    assert.equal(analysis.paging.pagesRead, 1);
    assert.ok(analysis.paging.pagesOffered >= 1 && analysis.paging.readBudgetFraction > 0);
    assert.equal(json("run.json").paging[0].paging.pagesOffered, analysis.paging.pagesOffered);
    assert.equal(bundle.verdict.checks.find((c) => c.name === "analyst-tools-only")?.ok, true);
    assert.equal(json("provenance.json").articles[0].analyst.pagesRead, 1);
    const prov = json("provenance.json");
    assert.equal(prov.feedOrigin, "https://hacker-news.firebaseio.com");
    assert.deepEqual(
      prov.items.map((i: { id: number }) => i.id),
      [101],
    );
    assert.match(prov.feed.sha256, /^[0-9a-f]{64}$/);
    assert.ok(prov.articles[0].fetchedAt, "article fetchedAt");
    const hostRows = json("egress-audit.json").filter((r: { stream: string }) => r.stream === "host");
    assert.ok(hostRows.length >= 3);
    for (const r of hostRows) {
      assert.equal(r.sandbox, null);
      assert.match(r.urlSha256, /^[0-9a-f]{64}$/);
      assert.ok(r.at && typeof r.durationMs === "number" && r.method === "GET");
    }
    const articleRow = hostRows.find((r: { authority: string }) => r.authority === "example.com");
    assert.equal(articleRow.pinnedPeer, "93.184.216.34");
    assert.equal(articleRow.story, "101");
    const jsonl = readFileSync(join(outDir, "host-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(jsonl.some((r) => r.phase === "open") && jsonl.some((r) => r.phase === "final"));
    for (const line of readFileSync(join(outDir, "host-audit.jsonl"), "utf8").split("\n"))
      assert.ok(!line.includes("/article") && !line.includes("topstories"), "no URL path in audit log");
    const journal = JSON.stringify(await rt.stores.journal.read({ limit: 100000 }));
    const hay = [...allFiles(outDir).map((p) => readFileSync(p, "utf8")), journal, ...logs, JSON.stringify(bundle)];
    for (const h of hay) assert.ok(!h.includes(SENTINEL), "upstream key leaked");
  } finally {
    console.error = originalError;
    await rt?.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(join(outDir, ".."), { recursive: true, force: true });
  }
});

// The operator's resolved values (--set) reach the embedded host: the workflow ceiling and the document the daemon writes into containers.
test("config: the embedded host enforces the resolved report ceiling (a declaration above it is refused at commit; at it is accepted)", async () => {
  const quiet = console.error;
  console.error = () => {};
  const caps = planCaps({ stories: 1 });
  const idle = () => async (c: { stopped: Promise<unknown> }) => void (await c.stopped);
  try {
    // Hand-built (the registry would reject this combination): the content workflow declares ext.hnDigest.reportMaxBytes 65536 > ceiling 1000,
    // so its extension does not start and the launch is refused.
    const stateDir = tmp();
    const low = await openOffline(stateDir, caps, idle as never, [], { config: { ...CONTENT_CONFIG_DEFAULTS, "report.workflowMaxBytes": 1000 } });
    try {
      await assert.rejects(runLiveContent(low, caps, { deadlineMs: 5_000, approval: "approve", pollMs: 20 }), /workflow launch failed/);
    } finally {
      await low.close().catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
    // Resolved through the registry with the ceiling exactly at the declaration: accepted.
    const r = resolveLiveConfig({
      env: {},
      set: ["report.workflowMaxBytes=65536"],
      readFile: () => {
        throw new Error("no file");
      },
    } as never);
    assert.ok(r.ok, JSON.stringify(r));
    const okDir = tmp();
    const rt = await openOffline(okDir, caps, idle as never, [], { config: r.values });
    assert.equal(rt.bounds.reportCeilingBytes, 65536);
    await rt.close();
    rmSync(okDir, { recursive: true, force: true });
  } finally {
    console.error = quiet;
  }
});

test("config: a --set capture bound reaches the started container, and the delivered document equals core's containerConfigEnv of the resolved values", async () => {
  const quiet = console.error;
  console.error = () => {};
  const stateDir = tmp();
  const caps = planCaps({ stories: 1 });
  const r = resolveLiveConfig({
    env: {},
    set: ["browser.capture.textMaxBytes=4096"],
    readFile: () => {
      throw new Error("no file");
    },
  } as never);
  assert.ok(r.ok, JSON.stringify(r));
  const fakes: { f?: ReturnType<typeof createFakes> } = {};
  let rt: Opened | undefined;
  try {
    rt = await openOffline(
      stateDir,
      caps,
      (get) => async (c) => {
        const rt = get();
        const evidence = evidenceOf(c.prompt);
        await rt?.daemon.submitResult(
          c.agent,
          "succeeded",
          modelResult(evidence, false, rt ? await firstArticlePage(rt, c.agent, evidence) : ""),
          "analysis-result",
        );
      },
      [],
      { config: r.values, fakes },
    );
    await runLiveContent(rt, caps, { deadlineMs: 45_000, approval: "approve", pollMs: 20 });
    const started = fakes.f?.hooks.raw.sandbox.started ?? [];
    assert.ok(started.length > 0, "the run started containers");
    const want = containerConfigEnv(CONFIG_REGISTRY, liveContainerConfig(r.values))[CONTAINER_CONFIG_ENV];
    assert.equal(containerConfigEnv(CONFIG_REGISTRY, r.values)[CONTAINER_CONFIG_ENV], want, "the live subset equals the whole-value document");
    for (const s of started) assert.equal(s.env[CONTAINER_CONFIG_ENV], want);
    assert.equal(JSON.parse(want).values["browser.capture.textMaxBytes"], 4096);
  } finally {
    console.error = quiet;
    await rt?.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The real pomtree CLI (child process, operator socket) decides the publish approval; fake children cover the failure modes.
const pomtreeRun = async (command: { command: string; args: string[] } | undefined, extra: { pomtreeTimeoutMs?: number } = {}) => {
  const stateDir = tmp();
  const caps = planCaps({ stories: 1 });
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  let rt: Opened | undefined;
  try {
    rt = await openOffline(stateDir, caps, (get) => async (c) => {
      const rt = get();
      const evidence = evidenceOf(c.prompt);
      await rt?.daemon.submitResult(
        c.agent,
        "succeeded",
        modelResult(evidence, false, rt ? await firstArticlePage(rt, c.agent, evidence) : ""),
        "analysis-result",
      );
    });
    const token = rt.operatorEnv().POMTREE_TOKEN;
    const handle = await runLiveContent(rt, caps, {
      deadlineMs: 45_000,
      approval: "pomtree",
      pollMs: 20,
      settleMs: 10_000,
      ...(command && { pomtreeCommand: command }),
      ...extra,
    });
    const bundle = await collectRun(rt, caps, handle);
    const outDir = join(stateDir, "out");
    writeRunOutputs(outDir, caps, handle, bundle);
    const journal = JSON.stringify(await rt.stores.journal.read({ limit: 100000 }));
    const hay = [...allFiles(outDir).map((p) => readFileSync(p, "utf8")), journal, ...logs, JSON.stringify(handle), JSON.stringify(bundle)];
    for (const h of hay) assert.ok(!h.includes(token), "operator token leaked");
    return { handle, bundle, approvals: JSON.parse(readFileSync(join(outDir, "approvals.json"), "utf8")) };
  } finally {
    console.error = originalError;
    await rt?.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
};
const fakePomtree = (body: string) => {
  const dir = tmp();
  const path = join(dir, "fake-pomtree.mjs");
  writeFileSync(path, body);
  return { command: process.execPath, args: [path] };
};

test("pomtree approval: the real pomtree CLI decides over the operator socket; the run publishes and records the CLI path", { timeout: 90000 }, async () => {
  const { handle, bundle, approvals } = await pomtreeRun(undefined);
  assert.equal(handle.outcome, "published", JSON.stringify(handle));
  assert.equal(handle.decidedVia, "pomtree");
  assert.equal(bundle.verdict.ok, true);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].state, "approved");
  assert.equal(approvals[0].decidedBy, "cli:operator"); // the in-process flag path records "operator"
  assert.equal(approvals[0].decidedVia, "pomtree");
  assert.match(approvals[0].why, /live run approve via pomtree/);
});

test("pomtree approval: a child that hangs is killed; the run fails (exit 3) and nothing is published", { timeout: 90000 }, async () => {
  const { handle, bundle, approvals } = await pomtreeRun(fakePomtree("setTimeout(() => {}, 60000);"), { pomtreeTimeoutMs: 300 });
  assert.equal(handle.outcome, "failed");
  assert.equal(handle.pomtreeFailed, true);
  assert.match(handle.notes.join("\n"), /pomtree decide timed out/);
  assert.equal(exitCodeOf(handle.outcome, bundle.verdict), 3);
  assert.equal(approvals[0].decidedVia, undefined);
});

test("pomtree approval: a nonzero child fails the run and its echoed token is scrubbed from notes and outputs", { timeout: 90000 }, async () => {
  const { handle } = await pomtreeRun(
    fakePomtree(
      `console.error("denied " + process.env.POMTREE_TOKEN);
process.exit(5);`,
    ),
  );
  assert.equal(handle.outcome, "failed");
  assert.match(handle.notes.join("\n"), /exited 5: denied \[redacted\]/);
});

test("pomtree approval: a child that exits 0 without deciding the pending approval (wrong id) fails the run", { timeout: 90000 }, async () => {
  const { handle } = await pomtreeRun(fakePomtree(`console.log(JSON.stringify({ id: "some-other-approval", decision: "approve" }));`));
  assert.equal(handle.outcome, "failed");
  assert.equal(handle.pomtreeFailed, true);
  assert.match(handle.notes.join("\n"), /still pending/);
});

test("storyNumberOf resolves the nearest story-N ancestor and is undefined elsewhere", () => {
  const byId = new Map([
    ["root", { name: "root", parent: null }],
    ["s", { name: "story-7", parent: "root" }],
    ["w", { name: "article-worker", parent: "s" }],
  ]);
  assert.equal(storyNumberOf(byId, "w"), "7");
  assert.equal(storyNumberOf(byId, "s"), "7");
  assert.equal(storyNumberOf(byId, "root"), undefined);
  assert.equal(storyNumberOf(byId, "missing"), undefined);
});

test("fromEgress keeps fields separate and passes unknown optional fields through, dropping kind/eventId/url", () => {
  const r = fromEgress({
    kind: "egress",
    eventId: "e",
    url: "https://a.example/",
    sandbox: "sb1",
    agent: "ag",
    host: "h",
    generation: 2,
    connection: "c1",
    phase: "outcome",
    sequence: 3,
    at: 1_700_000_000_000,
    authority: "a.example:443",
    method: "CONNECT",
    outcome: "limit",
    status: 200,
    durationMs: 12,
    bytesIn: 5,
    bytesOut: 7,
    denyReason: "private",
    limitKind: "bytes",
    errorClass: "reset",
    admittedAt: "2026-01-01T00:00:00.000Z",
  } as never) as Record<string, unknown>;
  assert.equal(r.authority, "a.example");
  assert.equal(r.port, 443);
  assert.equal(r.bytesIn, 5);
  assert.equal(r.bytesOut, 7);
  assert.equal(r.bytes, 12);
  assert.equal(r.at, "2023-11-14T22:13:20.000Z");
  for (const k of [
    "agent",
    "generation",
    "connection",
    "phase",
    "method",
    "status",
    "durationMs",
    "denyReason",
    "limitKind",
    "errorClass",
    "admittedAt",
    "sandbox",
  ])
    assert.ok(k in r, k);
  for (const k of ["kind", "eventId", "url"]) assert.ok(!(k in r), k);
  const bare = fromEgress({ sandbox: "sb", sequence: 1, authority: "b.example", outcome: "complete" }) as Record<string, unknown>;
  assert.ok(!("denyReason" in bare) && !("admittedAt" in bare));
});

test("provenanceOf lists feed origin, item ids, hashes and article capture facts without paths", () => {
  const sha = "a".repeat(64);
  const out = provenanceOf({
    stories: [],
    entryIds: [],
    provenance: [
      { url: "https://hacker-news.firebaseio.com/v0/topstories.json", sha256: sha, fetchedAt: 1_700_000_000_000 },
      { url: "https://hacker-news.firebaseio.com/v0/item/5.json", sha256: sha, fetchedAt: 1_700_000_001_000 },
    ],
  });
  assert.equal(out.feedOrigin, "https://hacker-news.firebaseio.com");
  assert.deepEqual(out.items, [{ id: 5, sha256: sha, fetchedAt: "2023-11-14T22:13:21.000Z" }]);
  assert.equal(JSON.stringify(out).includes("topstories"), false);
  assert.deepEqual(provenanceOf(null).items, []);
});

test("provenanceOf takes status and rawHash from the capture summary when the article was dropped, and never invents them", () => {
  const sha = "a".repeat(64);
  const story = (id: number, evidence: Record<string, unknown>) => ({ story: { id }, evidence }) as never;
  const capture = {
    status: "unsupported",
    reason: "boilerplate",
    textChars: 700,
    bodyBytes: 262_361,
    truncated: true,
    rawHash: sha,
    textHash: null,
    finalOrigin: "https://github.com",
  };
  const out = provenanceOf({
    stories: [
      story(1, { article: null, capture }),
      story(2, { article: null }),
      story(3, { article: null, capture: { ...capture, status: "unusable", reason: "fetch_error", rawHash: null } }),
    ],
    entryIds: [],
    provenance: [],
  });
  assert.deepEqual(out.articles[0], { storyId: 1, status: "unsupported", fetchedAt: null, rawHash: sha, capture });
  assert.deepEqual(out.articles[1], { storyId: 2, status: null, fetchedAt: null, rawHash: null });
  assert.deepEqual([out.articles[2]?.status, out.articles[2]?.rawHash], ["unusable", null]);
});

test("pinnedTransport records a refusal through onDeny with a closed reason", async () => {
  const denied: string[] = [];
  const audited = async () => {
    throw new Error("must not be reached");
  };
  const blocked = pinnedTransport(
    audited as never,
    async () => [{ address: "10.0.0.1", family: 4 }],
    (_u, r) => denied.push(r),
  );
  await assert.rejects(() => blocked("https://a.example.com/x", { redirect: "manual", signal: new AbortController().signal }), /blocked or empty/);
  const empty = pinnedTransport(
    audited as never,
    async () => [],
    (_u, r) => denied.push(r),
  );
  await assert.rejects(() => empty("https://a.example.com/x", { redirect: "manual", signal: new AbortController().signal }));
  const failing = pinnedTransport(
    audited as never,
    async () => {
      throw new Error("ENOTFOUND");
    },
    (_u, r) => denied.push(r),
  );
  await assert.rejects(() => failing("https://a.example.com/x", { redirect: "manual", signal: new AbortController().signal }), /ENOTFOUND/);
  assert.deepEqual(denied, ["private", "dns", "dns"]);
});

// Offline tests never ask the Docker CLI for the bridge gateway: they inject a bindable stand-in. 127.0.0.2 is loopback-range (bindable
// anywhere on Linux, so no docker0 address is needed) but is not the 127.0.0.1 string the route check treats as "unreachable from a container".
const TEST_BRIDGE_GATEWAY = async () => "127.0.0.2";

// Preflight before any model request (TODO(model-egress)): the entry asserts the real template egress reaches the proxy, with an injected probe.
async function openForPreflight(stateDir: string, templates?: ReturnType<typeof liveTemplates>, articleMethod?: "static-http" | "browser") {
  mkdirSync(join(stateDir, "repo"), { recursive: true });
  const sourceRequests: string[] = [];
  const rt = await openLiveContentRuntime({
    stateDir,
    repoDir: join(stateDir, "repo"),
    caps: planCaps({ stories: 1 }),
    upstreamKey: SENTINEL,
    upstreamBaseUrl: UPSTREAM,
    bridgeGateway: TEST_BRIDGE_GATEWAY,
    config: { ...CONTENT_CONFIG_DEFAULTS, "workflow.fetch.userAgent": TEST_FETCH_USER_AGENT },
    modelFetch: async () => {
      throw new Error("offline: the model transport must not be used");
    },
    sourceFetch: async (url) => {
      sourceRequests.push(url);
      throw new Error("offline: no source request expected");
    },
    wire: ({ hostId }) => {
      const f = createFakes({ host: hostId });
      return { sandbox: f.sandbox, placement: f.placement, workspace: f.workspace };
    },
    piHarness: () => new ScriptHarness(async () => {}),
    ...(templates && { templates }),
    ...(articleMethod && { articleMethod }),
  });
  return { rt, sourceRequests };
}

test("preflight: a passing probe lets the route through; a failing probe names the url and reason", async () => {
  const stateDir = tmp();
  const { rt } = await openForPreflight(stateDir);
  try {
    const seen: string[] = [];
    await rt.assertModelRoute(async (url) => {
      seen.push(url);
      return 401;
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? "", /^http:\/\/host\.docker\.internal:\d+$/);
    await assert.rejects(
      rt.assertModelRoute(async () => Promise.reject(new Error("Connection error."))),
      new RegExp(`model proxy unreachable from container via ${seen[0]?.replaceAll(".", "\\.")}: Connection error\\.`),
    );
  } finally {
    await rt.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("preflight: the original bug (grounded-model egress none, no relay) fails before the probe and before any run", async () => {
  const stateDir = tmp();
  const none = liveTemplates().map((t) => (t.id === MODEL_TEMPLATE ? { ...t, egress: { kind: "none" as const } } : t));
  const { rt, sourceRequests } = await openForPreflight(stateDir, none);
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    let probed = false;
    const probe = async () => {
      probed = true;
      return 200;
    };
    await assert.rejects(
      rt.assertModelRoute(probe),
      /model proxy unreachable from container via http:\/\/host\.docker\.internal:\d+: egress policy grants no relay/,
    );
    const outDir = join(tmp(), "out");
    const code = await executeLive(rt, planCaps({ stories: 1 }), { outputDir: outDir, deadlineMs: 5_000, approval: "approve", routeProbe: probe });
    assert.equal(code, 2);
    assert.equal(probed, false);
    assert.deepEqual(sourceRequests, []);
    assert.equal(existsSync(outDir), false, "nothing is written when the preflight refuses");
    assert.ok(logs.some((l) => /live content: model proxy unreachable from container via /.test(l)));
  } finally {
    console.error = originalError;
    await rt.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("preflight: a refused preflight leaves the stored seen state untouched by --seen-import", async () => {
  const stateDir = tmp();
  const none = liveTemplates().map((t) => (t.id === MODEL_TEMPLATE ? { ...t, egress: { kind: "none" as const } } : t));
  const { rt } = await openForPreflight(stateDir, none);
  const originalError = console.error;
  console.error = () => {};
  try {
    const saved: (readonly number[])[] = [];
    const seenStore = { load: async () => [], save: async (ids: readonly number[]) => void saved.push(ids) };
    const code = await executeLive(rt, planCaps({ stories: 1 }), {
      outputDir: join(tmp(), "out"),
      deadlineMs: 5_000,
      approval: "approve",
      seenStore,
      seenImport: [101, 102],
      routeProbe: async () => 200,
    });
    assert.equal(code, 2);
    assert.deepEqual(saved, [], "the import is not merged when a preflight refuses");
  } finally {
    console.error = originalError;
    await rt.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("preflight: a failing probe makes the entry exit 2 without launching", async () => {
  const stateDir = tmp();
  const { rt, sourceRequests } = await openForPreflight(stateDir);
  const originalError = console.error;
  console.error = () => {};
  try {
    const outDir = join(tmp(), "out");
    const code = await executeLive(rt, planCaps({ stories: 1 }), {
      outputDir: outDir,
      deadlineMs: 5_000,
      approval: "approve",
      routeProbe: async () => Promise.reject(new Error("Connection error.")),
    });
    assert.equal(code, 2);
    assert.deepEqual(sourceRequests, []);
    assert.equal(existsSync(outDir), false);
  } finally {
    console.error = originalError;
    await rt.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the default base repo ignores Pi's in-workspace session dir so workers can `pomtree result` without uncommitted work", () => {
  const dir = join(tmp(), "base");
  try {
    createLiveBaseRepo(dir);
    mkdirSync(join(dir, ".pi-session"));
    writeFileSync(join(dir, ".pi-session", "session.jsonl"), "{}");
    assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }), "");
    assert.equal(execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).trim(), ".gitignore");
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("exit code: published with zero analysed stories exits 3 even when approval and publication happened; other codes are unchanged", () => {
  const ok = { ok: true, checks: [{ name: "analysed-stories", ok: true, detail: "" }], warnings: [] };
  const vacuous = {
    ok: false,
    checks: [
      { name: "analysed-stories", ok: false, detail: "0 analysed stories of 1 requested" },
      { name: "seen-set", ok: false, detail: "x" },
    ],
    warnings: [],
  };
  const other = {
    ok: false,
    checks: [
      { name: "analysed-stories", ok: true, detail: "" },
      { name: "spend-total", ok: false, detail: "x" },
    ],
    warnings: [],
  };
  // Every URL-bearing article dropped for a worker or verification reason: no usable article, exit 3 even with an analysed story.
  const noArticle = {
    ok: false,
    checks: [
      { name: "analysed-stories", ok: true, detail: "" },
      { name: "usable-article", ok: false, detail: "x" },
    ],
    warnings: [],
  };
  assert.equal(exitCodeOf("published", noArticle), 3);
  assert.equal(exitCodeOf("published", ok), 0);
  assert.equal(exitCodeOf("published", vacuous), 3);
  assert.equal(exitCodeOf("published", other), 4);
  assert.equal(exitCodeOf("failed", ok), 3);
  assert.equal(exitCodeOf("cancelled", other), 3);
});

test("caps: the browser article reservation is 30000; the carve check uses the method's reservation", () => {
  assert.equal(planCaps({ stories: 1, articleMethod: "browser" }).articleBudgetMicros, BROWSER_ARTICLE_BUDGET_MICROS);
  assert.equal(planCaps({ stories: 3, articleMethod: "browser" }).articleBudgetMicros, 30_000);
  assert.equal(planCaps({ stories: 1 }).articleBudgetMicros, 1_000);
  assert.equal(planCaps({ stories: 3, articleMethod: "browser" }).modelBudgetMicros, 600_000);
  // 60000 carves 50000 for a request under static (60000 - 1000) but not under browser (60000 - 30000).
  assert.equal(planCaps({ stories: 1, budgetMicros: 60_000 }).modelBudgetMicros, 60_000);
  assert.throws(
    () => planCaps({ stories: 1, budgetMicros: 60_000, articleMethod: "browser" }),
    /cannot fund one 50000-micro request after the 30000-micro article reservation/,
  );
});

test("launch and templates: browser uses the capture-browser template, its limits, shared memory and audited-public egress", () => {
  const caps = planCaps({ stories: 1, articleMethod: "browser" });
  const input = liveLaunchInput(caps, "i", [], "browser");
  assert.equal(input.workers.articleMethod, "browser");
  assert.equal(input.workers.articleTemplate, BROWSER_TEMPLATE);
  assert.equal(input.workers.articleBudgetMicros, 30_000);
  assert.equal(liveLaunchInput(caps, "i").workers.articleTemplate, "capture-static");
  const t = liveTemplates("browser");
  assert.deepEqual(
    t.map((x) => x.id),
    ["capture-browser", MODEL_TEMPLATE],
  );
  const browser = t.find((x) => x.id === BROWSER_TEMPLATE);
  assert.deepEqual(browser?.browser, BROWSER_LIMITS);
  assert.equal(browser?.shmBytes, 268435456);
  assert.equal(browser?.egress?.kind, "audited-public");
  const e = workerEgress(BROWSER_TEMPLATE, { modelBaseUrl: PROXY, host: "h1", generation: 0, templates: t });
  assert.deepEqual(e.auditedPublic, { host: "h1", generation: 0 });
  assert.deepEqual(e.relay, [PROXY_TARGET]);
  assert.throws(() => workerEgress(BROWSER_TEMPLATE, { modelBaseUrl: PROXY, templates: t }), /audited-public egress requires/);
});

test("default deadline: static keeps the 10 minute default; browser adds one browser article deadline per story", () => {
  assert.equal(liveDefaultDeadlineMs(1), LIVE_DEFAULT_DEADLINE_MS);
  assert.equal(liveDefaultDeadlineMs(3, "static-http"), LIVE_DEFAULT_DEADLINE_MS);
  assert.equal(liveDefaultDeadlineMs(1, "browser"), LIVE_DEFAULT_DEADLINE_MS + BROWSER_DEADLINE_MS);
  assert.equal(liveDefaultDeadlineMs(3, "browser"), LIVE_DEFAULT_DEADLINE_MS + 3 * BROWSER_DEADLINE_MS);
});

test("session cap: the daemon cap is never below the run deadline, for every story count and method (no silent clamp of the agents)", () => {
  for (const method of ["static-http", "browser"] as const)
    for (let stories = 1; stories <= CONTENT_LIMIT; stories++) {
      const deadline = liveDefaultDeadlineMs(stories, method);
      assert.ok(liveSessionMs(deadline, stories, method) >= deadline, `${method} ${stories}`);
      assert.equal(liveSessionMs(deadline, stories, method), deadline, "the default deadline is the cap");
      assert.equal(liveSessionMs(deadline * 2, stories, method), deadline * 2, "a longer --deadline-ms raises the cap");
      assert.equal(liveSessionMs(1000, stories, method), deadline, "a shorter --deadline-ms keeps the default cap; the supervisor stops first");
    }
  assert.equal(liveSessionMs(LIVE_DEFAULT_DEADLINE_MS + 0.5, 1, "static-http"), LIVE_DEFAULT_DEADLINE_MS + 1, "an integer cap");
  // The default browser deadline for one story is past the old fixed cap, which is why the cap must follow it.
  assert.ok(liveDefaultDeadlineMs(1, "browser") > LIVE_DEFAULT_DEADLINE_MS);
});

test("browser image check: the command tests the Chromium binary and both runner files, and names the first missing one", () => {
  const cmd = browserImageCheckCommand();
  assert.deepEqual(cmd.slice(0, 2), ["sh", "-c"]);
  const script = cmd[2] ?? "";
  assert.ok(script.includes(`test -x ${BROWSER_IMAGE_PATHS.chromium}`), script);
  assert.ok(script.includes(`test -f ${BROWSER_IMAGE_PATHS.extension}`), script);
  assert.ok(script.includes(`test -f ${BROWSER_IMAGE_PATHS.runner}`), script);
  assert.ok(script.includes("MISSING /usr/bin/chromium"), script);
});

test("preflight (browser): the capture-browser route is probed with its own egress; a missing browser file refuses before any launch", async () => {
  const stateDir = tmp();
  const { rt, sourceRequests } = await openForPreflight(stateDir, liveTemplates("browser"), "browser");
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const probed: string[] = [];
    await rt.assertModelRoute(async (url) => {
      probed.push(url);
      return 401;
    }, BROWSER_TEMPLATE);
    assert.equal(probed.length, 1);
    let probes = 0;
    await rt.assertBrowserImage(async (cmd) => {
      probes++;
      assert.deepEqual(cmd, browserImageCheckCommand());
      return { code: 0, output: "BROWSER-IMAGE-OK\n" };
    });
    assert.equal(probes, 1);
    await assert.rejects(
      rt.assertBrowserImage(async () => ({ code: 1, output: "MISSING /opt/pomtree/browser-run.ts\n" })),
      /browser image .* is not ready: MISSING \/opt\/pomtree\/browser-run\.ts/,
    );
    const outDir = join(tmp(), "out");
    const code = await executeLive(rt, planCaps({ stories: 1, articleMethod: "browser" }), {
      outputDir: outDir,
      deadlineMs: 5_000,
      approval: "approve",
      articleMethod: "browser",
      imageProbe: async () => ({ code: 1, output: "MISSING /usr/bin/chromium\n" }),
      routeProbe: async () => 401,
    });
    assert.equal(code, 2);
    assert.ok(logs.some((l) => /live content: browser image .* is not ready: MISSING \/usr\/bin\/chromium/.test(l)));
    assert.deepEqual(sourceRequests, []);
    assert.equal(existsSync(outDir), false, "nothing is written when the browser image check refuses");
  } finally {
    console.error = originalError;
    await rt.close().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
