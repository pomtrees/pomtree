// No-spend end-to-end smoke test of the LIVE hn-content composition (TODO(model-egress), TODO(flow-proof)): real SQLite store, DockerSandbox, real Pi in
// the agent image, the real scoped model proxy and the real egress-audit collector. Only the edges are fake: the model upstream is a local stub
// chat-completions server (sentinel upstream key, canned analysis delivered through the analyst's `analysis_result` tool), and HN/article sources are a static
// fixture behind the injectable fetch seam. No real model, key, or network is used.
// Docker-gated: PTREE_DOCKER_TESTS=1 and PTREE_E2E_IMAGE=<agent image tag built from this revision, e.g. via
// `AGENT_IMAGE_TAG=at3-agent:test node packages/agent-image/scripts/build.ts`>. Without them it skips with the reason. The image's baked revision is only
// reported by `pomtree doctor` (no gate fails on it); building from the checked-out HEAD keeps it matching.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { articlePageText, evidenceOf, modelResult, READ_FIRST_PAGE_CALL, textsIn } from "./content-harness.mts";
import { CONTENT_CONFIG_DEFAULTS } from "./content-bounds.mts";
import { TEST_FETCH_USER_AGENT } from "./runtime.mts";
import { executeLive } from "./content-live-run.mts";
import { createLiveBaseRepo, liveTemplates, MODEL_TEMPLATE, openLiveContentRuntime, planCaps, requireLiveUpstream } from "./content-live-runtime.mts";
import { analystToolViolation, type ModelStub, type StubRequest, startModelStub } from "./content-live-stub.mts";

const SENTINEL = "sk-or-v1-SMOKE-SENTINEL-never-reaches-the-container";
const HTML = readFileSync(new URL("./content-fixtures/article-positive.html", import.meta.url), "utf8");
const image = process.env.PTREE_E2E_IMAGE;

function dockerSkip(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (lite run)";
  if (!image) return "PTREE_E2E_IMAGE unset";
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
  } catch {
    return `${image} unavailable (docker unreachable or image not built; this test never pulls)`;
  }
  return false;
}

const tmp = () => mkdtempSync(join(tmpdir(), "hn-smoke-"));
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });

// A Pi-priced fixture catalog so the proxy can charge the stub's usage (rates are USD per million tokens).
function catalogDir(): string {
  const dir = tmp();
  // The shape of the real catalog entry for the route: Pi speaks anthropic-messages and requests /v1/messages relative to this baseUrl.
  const model = {
    id: "anthropic/claude-haiku-5.5",
    type: "chat",
    api: "anthropic-messages",
    baseUrl: "https://openrouter.ai/api",
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  };
  writeFileSync(join(dir, "openrouter.json"), JSON.stringify({ "anthropic-messages": { "chat:anthropic/claude-haiku-5.5": model } }));
  return dir;
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === "object" && p ? String((p as { text?: unknown }).text ?? "") : "")).join("\n")
      : "";

// (Pi speaks the Anthropic Messages API for this route: tool results come back as user content blocks.) First turn: read the article's first page with the `article_page` tool; then the analysis through the `analysis_result` tool, whose quote comes from that page; once its tool result is back: a closing text.
function respond(req: StubRequest) {
  const messages = (req.body as { messages?: { role: string; content: unknown }[] }).messages ?? [];
  const hasToolResult = (m: { role: string; content: unknown }): boolean =>
    m.role === "tool" ||
    m.role === "toolResult" ||
    (Array.isArray(m.content) && m.content.some((p) => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "tool_result"));
  const prompt = text(messages.find((m) => m.role === "user")?.content);
  const evidence = evidenceOf(prompt);
  // A usable article is read first, as the task instructs (the command lists its page), and the quote comes from the page text.
  const reads = evidence.article?.status === "usable" ? 1 : 0;
  const results = messages.filter(hasToolResult);
  if (results.length > reads) return { kind: "text" as const, text: "Result submitted." };
  if (reads > results.length) return { kind: "tool" as const, ...READ_FIRST_PAGE_CALL };
  return { kind: "tool" as const, name: "analysis_result", args: { analysis: modelResult(evidence, false, articlePageText(textsIn(results))) } };
}

function sourceFetch(requests: string[]) {
  const bytes = (v: string) =>
    (async function* () {
      yield new TextEncoder().encode(v);
    })();
  const json = (v: unknown) => ({ status: 200, headers: new Headers(), body: bytes(JSON.stringify(v)) });
  return async (url: string) => {
    requests.push(url);
    if (url.endsWith("topstories.json")) return json([101]);
    if (url.endsWith("/item/101.json"))
      return json({ id: 101, type: "story", title: "Reliable batches", url: "https://example.com/article", kids: [201, 203] });
    if (url.endsWith("/item/201.json")) return json({ id: 201, parent: 101, type: "comment", text: "I appreciate the clear documentation.", time: 1700000201 });
    if (url.endsWith("/item/203.json")) return json({ id: 203, parent: 101, type: "comment", deleted: true });
    if (url === "https://example.com/article") return { status: 200, headers: new Headers({ "content-type": "text/html" }), body: bytes(HTML) };
    throw new Error(`unexpected source request ${url}`);
  };
}

async function withRig<T>(
  templates: ReturnType<typeof liveTemplates> | undefined,
  fn: (r: {
    rt: Awaited<ReturnType<typeof openLiveContentRuntime>>;
    stub: ModelStub;
    stateDir: string;
    outDir: string;
    sources: string[];
    logs: string[];
    staged: string[];
  }) => Promise<T>,
  // doubledBase: compose with the old wrong base (/api/v1, which Pi's /v1/messages doubles) instead of the catalog-derived one.
  opts: { doubledBase?: boolean } = {},
): Promise<T> {
  const stateDir = realTmp();
  const catalog = catalogDir();
  // Production derivation from the (synthetic) catalog, then only the origin swapped for the local stub.
  const derived = new URL(requireLiveUpstream({ POMTREED_PI_CATALOG_DIR: catalog, PATH: "" }, catalog));
  const upstreamPath = opts.doubledBase ? "/api/v1" : derived.pathname;
  const servePaths = [`${derived.pathname}/v1/messages`]; // what OpenRouter serves for Pi's /v1/messages; every other path is a 404
  // While the worker is live (a request is in flight), copy the scoped auth.json files staged for containers; they are removed at teardown.
  const staged: string[] = [];
  const stub = await startModelStub({
    respond: (req) => {
      for (const p of allFiles(stateDir)) if (p.endsWith("/pi/auth.json")) staged.push(readFileSync(p, "utf8"));
      return respond(req);
    },
    servePaths,
  });
  const upstreamBaseUrl = `${new URL(stub.baseUrl).origin}${upstreamPath}`;
  const outDir = join(tmp(), "out");
  const previous = process.env.POMTREED_PI_CATALOG_DIR;
  process.env.POMTREED_PI_CATALOG_DIR = catalog;
  const repoDir = join(stateDir, "repo");
  createLiveBaseRepo(repoDir);
  const sources: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const rt = await openLiveContentRuntime({
    stateDir,
    repoDir,
    caps: planCaps({ stories: 1 }),
    upstreamKey: SENTINEL,
    upstreamBaseUrl,
    modelFetch: globalThis.fetch,
    hostAuditLog: join(outDir, "host-audit.jsonl"),
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    sourceFetch: sourceFetch(sources),
    config: { ...CONTENT_CONFIG_DEFAULTS, "workflow.fetch.userAgent": TEST_FETCH_USER_AGENT },
    image: image!,
    ...(templates && { templates }),
  });
  try {
    return await fn({ rt, stub, stateDir, outDir, sources, logs, staged });
  } finally {
    console.error = originalError;
    await rt.close().catch(() => {});
    await stub.close();
    if (previous === undefined) delete process.env.POMTREED_PI_CATALOG_DIR;
    else process.env.POMTREED_PI_CATALOG_DIR = previous;
    for (const d of [stateDir, join(outDir, ".."), catalog]) rmSync(d, { recursive: true, force: true });
  }
}

// Unix socket paths must stay short, so the state dir lives directly under the OS temp dir.
const realTmp = () => mkdtempSync(join(tmpdir(), "hns-"));

test("smoke: one story runs end to end through the real proxy and a real Pi against a stub upstream; nothing spent for real", {
  skip: dockerSkip(),
  timeout: 480_000,
}, async (t) => {
  await withRig(undefined, async ({ rt, stub, outDir, logs, staged }) => {
    const caps = planCaps({ stories: 1 });
    const code = await executeLive(rt, caps, { outputDir: outDir, deadlineMs: 360_000, approval: "approve" });
    const read = (name: string) => JSON.parse(readFileSync(join(outDir, name), "utf8"));
    const assertions = (() => {
      try {
        return read("assertions.json");
      } catch {
        return null;
      }
    })();
    // The only tolerated failed assertion is the stub itself: its model-call host row is loopback (no-private-ranges), by construction of this test.
    const failed: { name: string; detail: string }[] = (assertions?.checks ?? []).filter((c: { ok: boolean }) => !c.ok);
    const stubOnly = failed.every((c) => c.name === "no-private-ranges" && c.detail.includes("authority 127.0.0.1"));
    assert.ok(
      (code === 0 || code === 4) && stubOnly,
      `exit ${code}; stub saw ${stub.requests.length} request(s); failed checks ${JSON.stringify(failed)}; log ${logs.slice(-12).join(" | ")}`,
    );

    // The stub received the proxied call: scoped path, the sentinel as the UPSTREAM credential (substituted by the proxy).
    const pathOf = (u: string) => u.split("?")[0] ?? u;
    const completions = stub.requests.filter((r) => /\/(messages|chat\/completions)$/.test(pathOf(r.url)));
    assert.ok(completions.length >= 1, `stub saw no completion request: ${JSON.stringify(stub.requests.map((r) => [r.method, r.url]))}`);
    for (const r of completions) {
      assert.equal(pathOf(r.url), "/api/v1/messages"); // exactly what the catalog baseUrl + Pi's /v1/messages gives (no doubled /v1)
      assert.equal(r.headers.authorization, `Bearer ${SENTINEL}`);
      // TODO(analyst-allowlist) landing criterion: the real Pi in the container offered the model exactly the analyst's two tools, nothing else.
      assert.equal(analystToolViolation(r.body), null, "the analyst's request declares exactly the allowlisted tools");
    }

    // The container-side credential is the scoped token, never the sentinel; the prompt Pi sent upstream does not carry it either.
    assert.ok(staged.length >= 1, "no staged scoped credential captured");
    for (const auth of staged) {
      assert.ok(!auth.includes(SENTINEL), "sentinel staged for the container");
      const key = (Object.values(JSON.parse(auth))[0] as { key?: string }).key;
      assert.ok(key && key !== SENTINEL, "container holds a scoped credential distinct from the upstream key");
    }
    for (const r of completions) assert.ok(!JSON.stringify(r.body).includes(SENTINEL));

    // Ledger: charged for the stub's usage, within the cap.
    const ledger = read("cost-ledger.json");
    assert.ok(ledger.totalMicros > 0 && ledger.totalMicros <= caps.modelBudgetMicros, `ledger ${JSON.stringify(ledger)}`);

    // Artifacts: digest, per-story result, every assertion, the analysed story marked seen.
    const story = read("stories/101.json");
    assert.ok(story.analysis, `story analysis missing: ${story.failure}`);
    assert.ok(assertions.checks.length > 0);
    assert.deepEqual(assertions.inputs.seen, [101]);
    assert.ok(readFileSync(join(outDir, "digest.md"), "utf8").includes("Reliable batches"));

    // Audit: host fetches (HN, article) and the model call record.
    const audit = read("egress-audit.json");
    const hostAuthorities = new Set(audit.filter((r: { stream: string }) => r.stream === "host").map((r: { authority: string }) => r.authority));
    for (const a of ["hacker-news.firebaseio.com", "example.com", "127.0.0.1"])
      assert.ok(hostAuthorities.has(a), `host audit lacks ${a}: ${[...hostAuthorities]}`);
    // Static article capture is host-side and the model worker is relay-only, so no container (public) egress rows are expected.
    assert.ok(
      audit.some((r: { authority: string; status?: number }) => r.authority === "127.0.0.1" && r.status === 200),
      "no 200 model-call row",
    );

    t.diagnostic(
      `stub requests ${stub.requests.length}; ledger ${ledger.totalMicros} micros; audit rows ${audit.length} (host ${hostAuthorities.size} authorities); exit ${code}`,
    );

    // The sentinel appears in no output file, state file other than the process-private sqlite, or journal.
    const journal = JSON.stringify(await rt.stores.journal.read({ limit: 100000 }));
    assert.ok(!journal.includes(SENTINEL));
    for (const p of allFiles(outDir)) assert.ok(!readFileSync(p, "utf8").includes(SENTINEL), p);
  });
});

test("smoke (negative): composed with the doubled /api/v1/v1/messages path the stub 404s, no story is analysed and the run does not succeed", {
  skip: dockerSkip(),
  timeout: 300_000,
}, async () => {
  await withRig(
    undefined,
    async ({ rt, stub, outDir }) => {
      const code = await executeLive(rt, planCaps({ stories: 1 }), { outputDir: outDir, deadlineMs: 150_000, approval: "approve" });
      assert.equal(code, 3, `exit ${code}; stub saw ${JSON.stringify(stub.requests.map((r) => [r.method, r.url]))}`);
      const pathOf = (u: string) => u.split("?")[0] ?? u;
      assert.ok(stub.requests.length >= 1, "the model was never called");
      for (const r of stub.requests) assert.equal(pathOf(r.url), "/api/v1/v1/messages", r.url); // every call was the doubled path, each a 404
      const storyFile = join(outDir, "stories/101.json");
      const analysis = (() => {
        try {
          return JSON.parse(readFileSync(storyFile, "utf8")).analysis;
        } catch {
          return null;
        }
      })();
      assert.equal(analysis ?? null, null, "a story was analysed through the wrong path");
    },
    { doubledBase: true },
  );
});

test("smoke (negative): without the relay grant the preflight aborts with exit 2 before the stub receives anything", {
  skip: dockerSkip(),
  timeout: 240_000,
}, async () => {
  const none = liveTemplates().map((t) => (t.id === MODEL_TEMPLATE ? { ...t, egress: { kind: "none" as const } } : t));
  await withRig(none, async ({ rt, stub, outDir, sources }) => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
    let code: number;
    try {
      code = await executeLive(rt, planCaps({ stories: 1 }), { outputDir: outDir, deadlineMs: 60_000, approval: "approve" });
    } finally {
      console.error = original;
    }
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /model proxy unreachable from container via http:\/\/host\.docker\.internal:\d+: /);
    assert.equal(stub.requests.length, 0);
    assert.deepEqual(sources, []);
  });
});
