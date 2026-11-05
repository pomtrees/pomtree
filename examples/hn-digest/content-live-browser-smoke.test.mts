// No-spend end-to-end smoke test of the LIVE hn-content composition with `--article-method browser`: real SQLite store, DockerSandbox, real Pi
// and real Chromium in the hardened agent image (template capture-browser, audited-public egress), the real audited proxy, the real journal capture
// authority, the real scoped model proxy. Only the edges are fake: the model upstream is a local stub (sentinel upstream key) scripted to drive
// browser_capture once and then capture_finish, and the HN API is a fixture behind the injectable fetch seam.
// The article is a PUBLIC page: a local fixture cannot pass the audited-public proxy (it denies private/host addresses) or checkPublicUrl (no
// non-80/443 ports, IP literals or *.internal hosts), so the capture goes through the real proxy to the public web (no model, no spend).
// Gated:PTREE_DOCKER_TESTS=1, PTREE_NET_TESTS=1 and PTREE_E2E_IMAGE=<agent image built from this revision, via
// `AGENT_IMAGE_TAG=<tag> node packages/agent-image/scripts/build.ts`>. Without them it skips with the reason.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { articlePageText, evidenceOf, modelResult, READ_FIRST_PAGE_CALL, textsIn } from "./content-harness.mts";
import { liveDefaultDeadlineMs, createLiveBaseRepo, openLiveContentRuntime, planCaps, requireLiveUpstream } from "./content-live-runtime.mts";
import { CONFIG_DEFAULTS } from "../../packages/core/src/index.ts";
import { resolveLiveConfig } from "./content-live.mts";
import { executeLive } from "./content-live-run.mts";
import { CONTENT_CONFIG_DEFAULTS } from "./content-bounds.mts";
import { TEST_FETCH_USER_AGENT } from "./runtime.mts";
import { analystToolViolation, browserToolViolation, type StubRequest, startModelStub } from "./content-live-stub.mts";
import { EXTRACTION_REGIONS } from "../../packages/agent-image/src/main-content.ts";

// The `extraction.region` of a retained report when it is a browser-navigation log, else undefined.
function navigationRegionOf(content: Buffer): string | undefined {
  try {
    const log = JSON.parse(content.toString("utf8"));
    return log?.kind === "browser-navigation" && typeof log.extraction?.region === "string" ? log.extraction.region : undefined;
  } catch {
    return undefined;
  }
}

const SENTINEL = "sk-or-v1-BROWSER-SMOKE-SENTINEL-never-reaches-the-container";
const ARTICLE = "https://www.rfc-editor.org/rfc/rfc2324.html";
const PHRASE = "Hyper Text Coffee Pot Control Protocol";
// Chromium background traffic no switch in chromiumArgs suppresses (see BROWSER_BACKGROUND in packages/sandbox-docker/src/browser-real-article.test.ts).
const BACKGROUND = new Set(["android.clients.google.com", "update.googleapis.com", "edgedl.me.gvt1.com"]);
// Named audit baseline: Pi calls pi.dev from inside the container. Observed in a real gated run, audited and default-deny-adjacent (it appears as
// an audited row), and NOT proven disableable: no documented switch has been found (TODO(web) item (v)). Every other host must still fail.
const PI_BASELINE = new Set(["pi.dev"]);
// Container egress authorities that are neither the article host nor the relay nor a known baseline host.
const strayAuthorities = (authorities: Iterable<string>): string[] => {
  const hostOf = (a: string) => a.replace(/:\d+$/, "");
  return [...authorities].filter(
    (a) => hostOf(a) !== "www.rfc-editor.org" && hostOf(a) !== "host.docker.internal" && !BACKGROUND.has(hostOf(a)) && !PI_BASELINE.has(hostOf(a)),
  );
};
const image = process.env.PTREE_E2E_IMAGE;

function skipReason(): string | false {
  if (process.env.PTREE_DOCKER_TESTS !== "1") return "PTREE_DOCKER_TESTS not set (lite run)";
  if (process.env.PTREE_NET_TESTS !== "1") return "PTREE_NET_TESTS not set (the article is a public page; offline CI skips)";
  if (!image) return "PTREE_E2E_IMAGE unset";
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 });
  } catch {
    return `${image} unavailable (docker unreachable or image not built; this test never pulls)`;
  }
  return false;
}

const tmp = () => mkdtempSync(join(tmpdir(), "hnb-"));
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (typeof p === "object" && p ? String((p as { text?: unknown }).text ?? "") : "")).join("\n")
      : "";

type Msg = { role: string; content: unknown };
const blocks = (m: Msg): { type?: string; name?: string; id?: string; tool_use_id?: string }[] =>
  Array.isArray(m.content) ? (m.content as { type?: string }[]) : [];

// Which tools already have a tool_result in the conversation (Pi sends the Anthropic Messages shape: tool_use blocks in assistant turns,
// tool_result blocks in user turns). Turns are decided from this, not from the request index.
function answeredTools(messages: Msg[]): Set<string> {
  const names = new Map<string, string>();
  for (const m of messages) for (const b of blocks(m)) if (b.type === "tool_use" && b.id && b.name) names.set(b.id, b.name);
  const done = new Set<string>();
  for (const m of messages) for (const b of blocks(m)) if (b.type === "tool_result" && b.tool_use_id) done.add(names.get(b.tool_use_id) ?? "?");
  return done;
}

const captureArgsOf = (prompt: string): Record<string, unknown> => {
  const at = prompt.indexOf("browser_capture tool once with exactly ");
  assert.ok(at >= 0, "browser prompt lacks the exact-args instruction");
  const start = prompt.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === "{") depth++;
    if (prompt[i] === "}" && --depth === 0) return JSON.parse(prompt.slice(start, i + 1));
  }
  throw new Error("unterminated capture args");
};

function respond(req: StubRequest) {
  const messages = (req.body as { messages?: Msg[] }).messages ?? [];
  const first = textOf(messages.find((m) => m.role === "user")?.content);
  const done = answeredTools(messages);
  if (first.includes("browser_capture")) {
    if (!done.has("browser_capture")) return { kind: "tool" as const, name: "browser_capture", args: captureArgsOf(first) };
    assert.equal(browserToolViolation(req.body), null, "the browser worker's request declares exactly the allowlisted tools");
    if (!done.has("capture_finish")) return { kind: "tool" as const, name: "capture_finish", args: { status: "succeeded", summary: "captured" } };
    return { kind: "text" as const, text: "Done." };
  }
  const evidence = evidenceOf(first);
  const reads = evidence.article?.status === "usable" ? 1 : 0;
  const results = messages.flatMap(blocks).filter((b) => b.type === "tool_result");
  if (results.length > reads) return { kind: "text" as const, text: "Result submitted." };
  if (reads > results.length) return { kind: "tool" as const, ...READ_FIRST_PAGE_CALL };
  return { kind: "tool" as const, name: "analysis_result", args: { analysis: modelResult(evidence, false, articlePageText(textsIn(results))) } };
}

function catalogDir(): string {
  const dir = tmp();
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

function sourceFetch() {
  const bytes = (v: string) =>
    (async function* () {
      yield new TextEncoder().encode(v);
    })();
  const json = (v: unknown) => ({ status: 200, headers: new Headers(), body: bytes(JSON.stringify(v)) });
  return async (url: string) => {
    if (url.endsWith("topstories.json")) return json([101]);
    if (url.endsWith("/item/101.json")) return json({ id: 101, type: "story", title: "Reliable batches", url: ARTICLE, kids: [201, 203] });
    if (url.endsWith("/item/201.json")) return json({ id: 201, parent: 101, type: "comment", text: "I appreciate the clear documentation.", time: 1700000201 });
    if (url.endsWith("/item/203.json")) return json({ id: 203, parent: 101, type: "comment", deleted: true });
    throw new Error(`unexpected source request ${url}`);
  };
}

const inspected: { name: string; networkMode?: string; capDrop?: string[] }[] = [];

// The article worker's container is short-lived: poll `docker ps` during the run and keep the first successful inspect of each container.
function pollContainers(): () => void {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    try {
      for (const id of execFileSync("docker", ["ps", "-q"], { encoding: "utf8", timeout: 5000 }).split("\n").filter(Boolean)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const j = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8", timeout: 5000 })) as {
          Name: string;
          Config: { Env?: string[] };
          HostConfig: { NetworkMode: string; CapDrop: string[] | null };
        }[];
        const c = j[0];
        if (c?.Config.Env?.some((e) => e.startsWith("PTREE_BROWSER=")))
          inspected.push({ name: c.Name, networkMode: c.HostConfig.NetworkMode, ...(c.HostConfig.CapDrop && { capDrop: c.HostConfig.CapDrop }) });
      }
    } catch {}
  }, 500);
  return () => clearInterval(timer);
}

test("browser smoke: one story, a real Pi browsing worker in the hardened container reads a public article through the audited proxy; nothing spent for real", {
  skip: skipReason(),
  timeout: 540_000,
}, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "hnbs-"));
  const catalog = catalogDir();
  const outDir = join(tmp(), "out");
  const derived = new URL(requireLiveUpstream({ POMTREED_PI_CATALOG_DIR: catalog, PATH: "" }, catalog));
  const staged: string[] = [];
  const stub = await startModelStub({
    respond: (req) => {
      for (const p of allFiles(stateDir)) if (p.endsWith("/pi/auth.json")) staged.push(readFileSync(p, "utf8"));
      return respond(req);
    },
    servePaths: [`${derived.pathname}/v1/messages`],
  });
  const previous = process.env.POMTREED_PI_CATALOG_DIR;
  process.env.POMTREED_PI_CATALOG_DIR = catalog;
  const repoDir = join(stateDir, "repo");
  createLiveBaseRepo(repoDir);
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const caps = planCaps({ stories: 1, articleMethod: "browser" });
  const rt = await openLiveContentRuntime({
    stateDir,
    repoDir,
    caps,
    upstreamKey: SENTINEL,
    upstreamBaseUrl: `${new URL(stub.baseUrl).origin}${derived.pathname}`,
    modelFetch: globalThis.fetch,
    hostAuditLog: join(outDir, "host-audit.jsonl"),
    sourceFetch: sourceFetch(),
    config: { ...CONTENT_CONFIG_DEFAULTS, "workflow.fetch.userAgent": TEST_FETCH_USER_AGENT },
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    image: image!,
    articleMethod: "browser",
  });
  const stopPolling = pollContainers();
  try {
    const code = await executeLive(rt, caps, {
      outputDir: outDir,
      deadlineMs: liveDefaultDeadlineMs(1, "browser"),
      approval: "approve",
      articleMethod: "browser",
    });
    stopPolling();
    const read = (name: string) => JSON.parse(readFileSync(join(outDir, name), "utf8"));
    const assertions = (() => {
      try {
        return read("assertions.json");
      } catch {
        return null;
      }
    })();
    const failed: { name: string; detail: string }[] = (assertions?.checks ?? []).filter((c: { ok: boolean }) => !c.ok);
    const stubOnly = failed.every((c) => c.name === "no-private-ranges" && c.detail.includes("authority 127.0.0.1"));
    assert.ok(
      (code === 0 || code === 4) && stubOnly,
      `exit ${code}; stub saw ${stub.requests.length} request(s); failed checks ${JSON.stringify(failed)}; log ${logs.slice(-15).join(" | ")}`,
    );

    // Stub conversation: the browser worker called browser_capture with the exact args, then capture_finish.
    const pathOf = (u: string) => u.split("?")[0] ?? u;
    const completions = stub.requests.filter((r) => /\/messages$/.test(pathOf(r.url)));
    for (const r of completions) {
      assert.equal(r.headers.authorization, `Bearer ${SENTINEL}`);
      assert.ok(!JSON.stringify(r.body).includes(SENTINEL));
    }
    // The analyst's requests (the browser worker's are checked in the stub's respond) declare exactly the analyst's two tools.
    const analystRequests = completions.filter((r) => JSON.stringify(r.body).includes("Grounded HN analysis"));
    assert.ok(analystRequests.length >= 1, "the stub saw no analyst request");
    for (const r of analystRequests) assert.equal(analystToolViolation(r.body), null, "the analyst's request declares exactly the allowlisted tools");
    const toolUses = completions.flatMap((r) =>
      ((r.body as { messages?: Msg[] }).messages ?? []).flatMap((m) => blocks(m) as { type?: string; name?: string; input?: Record<string, unknown> }[]),
    );
    const captureCalls = toolUses.filter((b) => b.type === "tool_use" && b.name === "browser_capture");
    assert.ok(captureCalls.length >= 1, "the stub never saw a browser_capture tool_use echoed back");
    const sentArgs = captureCalls[0]?.input as Record<string, unknown>;
    assert.equal(sentArgs.url, ARTICLE);

    // Story: analysed, browser report ids retained and hash-equal to their bytes.
    const story = read("stories/101.json");
    assert.ok(story.analysis, `story analysis missing: ${story.failure}`);
    assert.deepEqual(assertions.inputs.seen, [101]);
    const evidence = JSON.stringify(story);
    const reportIds = [...evidence.matchAll(/"id":"([^"]+)","sha256":"([0-9a-f]{64})"/g)].map((m) => ({ id: m[1]!, sha256: m[2]! }));
    assert.ok(reportIds.length >= 4, `browser report references missing in the story file: ${evidence.slice(0, 600)}`);
    // The story ids are ROOT-retained copies (retain in content-evidence.mts writes them under the root agent), so read them as the root.
    const agents = await rt.stores.registry.list();
    const article = agents.find((a) => a.name === "article-101");
    assert.ok(article, "no article-101 agent");
    const retainedIds = [...new Map(reportIds.map((r) => [r.id, r])).values()];
    assert.equal(retainedIds.length, 5, `expected five retained browser reports (body, text, dom, screenshot, navigation): ${JSON.stringify(retainedIds)}`);
    const checkedReports: string[] = [];
    let region: string | undefined; // the navigation log's extraction.region (TODO(main-content-tuning): which label a real page produces)
    for (const r of retainedIds) {
      const got = await rt.reportStore.read(rt.root.id, r.id as never);
      assert.ok(got, `retained report ${r.id} unreadable as root agent ${rt.root.id}`);
      assert.equal(sha(got.content), r.sha256, `retained report ${r.id} (root ${rt.root.id}) does not hash-match the receipt`);
      checkedReports.push(`${r.id}=${r.sha256.slice(0, 12)}`);
      region ??= navigationRegionOf(Buffer.from(got.content));
    }
    assert.ok(region !== undefined && (EXTRACTION_REGIONS as readonly string[]).includes(region), `extraction.region ${region} is not in the closed set`);

    // Journal authority inputs: exactly one browser_capture call and an ok result for the article worker.
    const journal = await rt.stores.journal.read({ agent: article!.id, limit: 100000 });
    const calls = journal.filter((e) => e.payload.kind === "tool_call" && e.payload.tool === "browser_capture");
    const results = journal.filter((e) => e.payload.kind === "tool_result" && e.payload.ok === true);
    assert.equal(calls.length, 1, "exactly one browser_capture call");
    assert.ok(results.length >= 1);

    // Audit: only the article host, the relays and the known Chromium background hosts.
    const audit = read("egress-audit.json") as { stream: string; authority: string }[];
    const containerAuthorities = new Set(audit.filter((r) => r.stream !== "host").map((r) => r.authority));
    const hostOf = (a: string) => a.replace(/:\d+$/, "");
    const stray = strayAuthorities(containerAuthorities);
    assert.deepEqual(stray, [], `unexpected container egress authorities: ${[...containerAuthorities].join(", ")}`);
    assert.ok(
      [...containerAuthorities].some((a) => hostOf(a) === "www.rfc-editor.org"),
      `no article host row: ${[...containerAuthorities].join(", ")}`,
    );
    assert.ok(
      [...containerAuthorities].some((a) => hostOf(a) === "host.docker.internal"),
      "no model/agent relay row",
    );

    // Hardened container shape of the browser worker.
    assert.ok(inspected.length >= 1, "never inspected the browser worker container");
    for (const c of inspected) {
      assert.equal(c.networkMode, "none", JSON.stringify(c));
      assert.ok(c.capDrop?.includes("ALL"), JSON.stringify(c));
    }

    // Sandbox exits are journaled on the exiting agent's own journal (the browser worker's), not the root's: the root runs no sandbox.
    const exits = journal.filter((e) => e.payload.kind === "ext.pomtreed.sandbox" && e.payload.phase === "exited");
    assert.ok(exits.length >= 1, "no ext.pomtreed.sandbox exit entries");

    // Secrets: the sentinel is staged nowhere the container can see and appears in no output.
    assert.ok(staged.length >= 1);
    for (const auth of staged) assert.ok(!auth.includes(SENTINEL), "sentinel staged for the container");
    assert.ok(!JSON.stringify(await rt.stores.journal.read({ limit: 100000 })).includes(SENTINEL));
    for (const p of allFiles(outDir)) assert.ok(!readFileSync(p, "utf8").includes(SENTINEL), p);
    assert.ok(readFileSync(join(outDir, "digest.md"), "utf8").includes("Reliable batches"));
    t.diagnostic(
      `exit ${code}; stub requests ${stub.requests.length}; browser_capture args ${JSON.stringify(sentArgs)}; reports ${checkedReports.join(",")}; container authorities ${[...containerAuthorities].join(",")}; inspected ${JSON.stringify(inspected)}; sandbox exits ${exits.length}; extraction.region ${region}; phrase in article ${PHRASE}`,
    );
  } finally {
    stopPolling();
    console.error = originalError;
    await rt.close().catch(() => {});
    await stub.close();
    if (previous === undefined) delete process.env.POMTREED_PI_CATALOG_DIR;
    else process.env.POMTREED_PI_CATALOG_DIR = previous;
    for (const d of [stateDir, join(outDir, ".."), catalog]) rmSync(d, { recursive: true, force: true });
  }
});

// Operator override reaching a real worker: the same stub-model flow, once with `--set browser.capture.textMaxBytes=4096` resolved by the live
// entry's own resolveLiveConfig and once with registry defaults (the control). The worker's navigation log, retained as a report, records the
// limits it actually ran with (read from PTREE_CONFIG_JSON in the container); the host verifier must still accept the clipped article.
const OVERRIDE_BYTES = 4096;
type ClipRun = { code: number; textBytes: unknown; truncated: unknown; clip: Buffer; region: unknown };

async function runClipFlow(set: string[]): Promise<ClipRun> {
  const resolved = resolveLiveConfig({ env: { POMTREED_WORKFLOW_FETCH_USER_AGENT: TEST_FETCH_USER_AGENT }, set, readFile: (p) => readFileSync(p, "utf8") });
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.errors.join("; "));
  const stateDir = mkdtempSync(join(tmpdir(), "hnbo-"));
  const catalog = catalogDir();
  const outDir = join(tmp(), "out");
  const derived = new URL(requireLiveUpstream({ POMTREED_PI_CATALOG_DIR: catalog, PATH: "" }, catalog));
  const stub = await startModelStub({ respond, servePaths: [`${derived.pathname}/v1/messages`] });
  const previous = process.env.POMTREED_PI_CATALOG_DIR;
  process.env.POMTREED_PI_CATALOG_DIR = catalog;
  const repoDir = join(stateDir, "repo");
  createLiveBaseRepo(repoDir);
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  const caps = planCaps({ stories: 1, articleMethod: "browser" });
  const rt = await openLiveContentRuntime({
    stateDir,
    repoDir,
    caps,
    upstreamKey: SENTINEL,
    upstreamBaseUrl: `${new URL(stub.baseUrl).origin}${derived.pathname}`,
    modelFetch: globalThis.fetch,
    hostAuditLog: join(outDir, "host-audit.jsonl"),
    sourceFetch: sourceFetch(),
    resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
    image: image!,
    articleMethod: "browser",
    config: resolved.values,
  });
  try {
    const code = await executeLive(rt, caps, {
      outputDir: outDir,
      deadlineMs: liveDefaultDeadlineMs(1, "browser"),
      approval: "approve",
      articleMethod: "browser",
    });
    const story = JSON.parse(readFileSync(join(outDir, "stories/101.json"), "utf8"));
    assert.ok(story.analysis, `story analysis missing (the verifier refused the article?): ${story.failure}; exit ${code}; log ${logs.slice(-10).join(" | ")}`);
    const ids = new Map([...JSON.stringify(story).matchAll(/"id":"([^"]+)","sha256":"([0-9a-f]{64})"/g)].map((m) => [m[1]!, m[2]!]));
    const reports = new Map<string, Buffer>();
    for (const id of ids.keys()) {
      const got = await rt.reportStore.read(rt.root.id, id as never);
      assert.ok(got, `retained report ${id} unreadable`);
      reports.set(id, Buffer.from(got.content));
    }
    const navLogs = [...reports.values()].flatMap((b) => {
      try {
        const j = JSON.parse(b.toString("utf8"));
        return j?.kind === "browser-navigation" ? [j] : [];
      } catch {
        return [];
      }
    });
    assert.equal(navLogs.length, 1, "exactly one retained browser-navigation log");
    const nav = navLogs[0];
    // The story holds root-retained copies under new ids; the log's text report is matched by content hash.
    const clip = [...reports.values()].find((b) => sha(b) === nav.textReport.sha256);
    assert.ok(clip, "the navigation log's text report is not among the retained reports");
    return { code, textBytes: nav.limits.textBytes, truncated: nav.limits.truncated, clip, region: nav.extraction?.region };
  } finally {
    console.error = originalError;
    await rt.close().catch(() => {});
    await stub.close();
    if (previous === undefined) delete process.env.POMTREED_PI_CATALOG_DIR;
    else process.env.POMTREED_PI_CATALOG_DIR = previous;
    for (const d of [stateDir, join(outDir, ".."), catalog]) rmSync(d, { recursive: true, force: true });
  }
}

test("browser smoke override: --set browser.capture.textMaxBytes=4096 reaches the real worker, clips the article and the verifier still accepts it", {
  skip: skipReason(),
  timeout: 540_000,
}, async (t) => {
  const run = await runClipFlow([`browser.capture.textMaxBytes=${OVERRIDE_BYTES}`]);
  assert.equal(run.textBytes, OVERRIDE_BYTES, "the worker log does not show the operator's limit");
  assert.equal(run.truncated, true, "the fixture article must exceed the override so the clip is real");
  assert.ok(run.clip.byteLength > 0 && run.clip.byteLength <= OVERRIDE_BYTES, `clip is ${run.clip.byteLength} bytes`);
  t.diagnostic(`exit ${run.code}; limits.textBytes ${run.textBytes}; clip ${run.clip.byteLength} bytes; extraction.region ${run.region}`);
});

// Control: the same flow with registry defaults must show the larger default limit and a longer clip, so the override test cannot pass vacuously.
test("browser smoke override control: registry defaults show the default limit and a clip longer than the override", {
  skip: skipReason(),
  timeout: 540_000,
}, async (t) => {
  const run = await runClipFlow([]);
  assert.equal(run.textBytes, CONFIG_DEFAULTS["browser.capture.textMaxBytes"]);
  assert.ok((run.textBytes as number) > OVERRIDE_BYTES);
  assert.ok(run.clip.byteLength > OVERRIDE_BYTES && run.clip.byteLength <= (run.textBytes as number), `clip is ${run.clip.byteLength} bytes`);
  t.diagnostic(`exit ${run.code}; limits.textBytes ${run.textBytes}; clip ${run.clip.byteLength} bytes; extraction.region ${run.region}`);
});

// Ungated: the allowlist stays strict. The named baseline hosts pass; any other host, including a lookalike, is stray.
test("browser smoke egress allowlist: baseline hosts pass, an unlisted host still fails", () => {
  assert.deepEqual(strayAuthorities(["www.rfc-editor.org:443", "host.docker.internal:8080", "pi.dev:443", "update.googleapis.com:443"]), []);
  assert.deepEqual(strayAuthorities(["pi.dev:443", "evil.example:443", "api.pi.dev:443", "pi.dev.evil.example:443"]), [
    "evil.example:443",
    "api.pi.dev:443",
    "pi.dev.evil.example:443",
  ]);
});
