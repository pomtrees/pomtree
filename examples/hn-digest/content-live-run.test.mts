import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  articleChildrenOf,
  classifyRootOutcome,
  executeLive,
  hostAuditOutcome,
  ROOT_WORKFLOW,
  type RunBundle,
  type RunHandle,
  rootSeenOf,
  runLiveContent,
  writeRunOutputs,
} from "./content-live-run.mts";
import { disposeRunDir, parseLiveArgs } from "./content-live.mts";
import type { LiveCaps, LiveContentRuntime } from "./content-live-runtime.mts";
import type { StoryResult } from "./content-contract.mts";

describe("classifyRootOutcome", () => {
  const report = { id: "r", sha256: "a".repeat(64) };
  const base = { pomtreeFailed: false, deadlineHit: false, decided: "approved" as const };
  it("a root that exited succeeded with a report is published even when the deadline passed while it published", () => {
    assert.equal(classifyRootOutcome({ ...base, deadlineHit: true }, { exit: "succeeded", result: { report } }), "published");
  });
  it("a deadline hit without a published report is cancelled, a denial is denied, anything else is failed", () => {
    assert.equal(classifyRootOutcome({ ...base, deadlineHit: true }, { exit: "cancelled", result: null }), "cancelled");
    assert.equal(classifyRootOutcome({ ...base, deadlineHit: true }, { exit: "succeeded", result: {} }), "cancelled");
    assert.equal(classifyRootOutcome({ ...base, decided: "denied" }, { exit: "succeeded", result: {} }), "denied");
    assert.equal(classifyRootOutcome(base, { exit: "failed", result: { report } }), "failed");
    assert.equal(classifyRootOutcome(base, { exit: "succeeded", result: null }), "failed");
  });
  it("a failed pomtree approval is failed", () => {
    assert.equal(classifyRootOutcome({ ...base, pomtreeFailed: true }, { exit: "cancelled", result: null }), "failed");
  });
});

describe("runLiveContent: more than one pending publish approval", () => {
  // A minimal runtime: the launch answers, two publish approvals are pending, and the root exits only once cancelled.
  const fakeRuntime = () => {
    const calls = { decided: [] as string[], cancelled: 0 };
    let cancelled = false;
    const pending = (id: string) => ({ id, state: "pending", action: { kind: "publish", target: "a".repeat(64) } });
    const rt = {
      cli: async () => ({ code: 0, out: [JSON.stringify({ agent: "root" })], err: [] }),
      daemon: {
        get: async () => (cancelled ? { state: "exited", exit: "cancelled", result: null } : { state: "running" }),
        decideApproval: async (id: string) => {
          calls.decided.push(id);
        },
        cancel: async () => {
          calls.cancelled++;
          cancelled = true;
        },
      },
      stores: { approvals: { list: async () => [pending("ap-1"), pending("ap-2")] } },
      operatorEnv: () => ({ POMTREE_SOCKET: "/nonexistent.sock", POMTREE_TOKEN: "t" }),
    };
    return { rt: rt as unknown as LiveContentRuntime, calls };
  };
  const caps: LiveCaps = { stories: 1, modelBudgetMicros: 200_000, rootBudgetMicros: 500_000, maxRequestMicros: 50_000, articleBudgetMicros: 1_000 };
  for (const approval of ["approve", "deny", "pomtree"] as const)
    it(`--approval ${approval}: decides neither, cancels the root once and fails the run`, async () => {
      const { rt, calls } = fakeRuntime();
      let spawned = 0;
      const handle = await runLiveContent(rt, caps, {
        deadlineMs: 60_000,
        approval,
        pollMs: 1,
        pomtreeSpawner: async () => {
          spawned++;
          return { code: 0, timedOut: false, output: "" };
        },
      });
      assert.deepEqual(calls.decided, []);
      assert.equal(spawned, 0, "pomtree decide is never run");
      assert.equal(calls.cancelled, 1);
      assert.equal(handle.ambiguousApproval, true);
      assert.equal(handle.decided, null);
      assert.equal(handle.outcome, "failed");
      assert.ok(handle.notes.some((n) => /more than one pending publish approval/.test(n)));
    });
});

describe("hostAuditOutcome", () => {
  it("keeps the failure outcomes and pending unchanged", () => {
    for (const outcome of ["denied", "error", "cancelled", "pending"] as const) assert.equal(hostAuditOutcome(outcome), outcome);
  });

  it("relabels every other host outcome as complete", () => {
    for (const outcome of ["allowed", "complete", "connected", "limit"]) assert.equal(hostAuditOutcome(outcome), "complete", outcome);
  });
});

describe("writeRunOutputs", () => {
  const story = (id: number) => ({
    story: { id, rank: 1, title: `story ${id}`, url: null, kids: [], itemHash: "h", itemSource: "https://hacker-news.firebaseio.com/v0/item/1.json" },
    evidence: {},
    analysis: null,
    failure: null,
  });
  const normal = story(101) as unknown as StoryResult;
  const rejectedDetail = {
    failure: "citation not grounded",
    raw: '{"claims":[]}',
    rawTruncated: false,
    citations: [{ claim: 0, ok: false, reason: "quote not found" }],
    claimCount: 5,
    outputBytes: 13,
    limits: { maxClaims: 4, maxBytes: 8192 },
  };
  const rejectedStory = { ...story(102), failure: "citation not grounded", rejected: rejectedDetail } as unknown as StoryResult;
  const withoutRejected = Object.fromEntries(Object.entries(rejectedStory).filter(([k]) => k !== "rejected"));
  const bundle = {
    facts: { publishedReport: { sha256: "s", body: "# digest\n" }, seen: [101], approvals: [], retainedSha256: [], expectedAuthorities: [] },
    verdict: { ok: true, checks: [], warnings: [] },
    spend: { totalMicros: 0, byAgent: [], byStory: {}, unattributedMicros: 0, errors: [] },
    audit: [{ stream: "host", sequence: 1, authority: "example.com", outcome: "pending" }],
    approvals: [],
    result: { stories: [normal, rejectedStory], entryIds: [] },
    modelCalls: [],
  } as unknown as RunBundle;
  const caps = {} as LiveCaps;
  const handle: RunHandle = { rootId: "root", instance: "live-a", seed: [], outcome: "published", decided: "approved", deadlineHit: false, notes: [] };

  it("writes a rejected story's detail to its own file and strips it from the story file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-run-outputs-"));
    try {
      const files = writeRunOutputs(dir, caps, handle, bundle);
      assert.deepEqual(files, [
        "digest.md",
        "stories/101.json",
        "stories/102.json",
        "stories/102.rejected.json",
        "cost-ledger.json",
        "egress-audit.json",
        "model-calls.json",
        "assertions.json",
        "approvals.json",
        "provenance.json",
        "run.json",
      ]);
      const read = (name: string) => readFileSync(join(dir, name), "utf8");
      assert.equal(read("stories/102.rejected.json"), `${JSON.stringify({ storyId: 102, ...rejectedDetail }, null, 2)}\n`);
      assert.equal(read("stories/102.json"), `${JSON.stringify(withoutRejected, null, 2)}\n`);
      assert.equal(read("stories/101.json"), `${JSON.stringify(normal, null, 2)}\n`);
      assert.equal(read("digest.md"), "# digest\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.json records whether the stories were operator-picked or top-ranked", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-run-selection-"));
    try {
      const sel = () => (JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as { selection: unknown }).selection;
      writeRunOutputs(dir, caps, handle, bundle);
      assert.deepEqual(sel(), { mode: "top-ranked" });
      writeRunOutputs(dir, caps, { ...handle, picked: [42, 7] }, bundle);
      assert.deepEqual(sel(), { mode: "operator-picked", ids: [42, 7] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes workers/<story>.json per collected worker and lists them in run.json and provenance; none without workers", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-run-outputs-"));
    try {
      const w = {
        storyId: 101,
        child: "a",
        generation: 1,
        exit: "failed",
        exitCause: "signal",
        tools: [],
        errors: [],
        diagnostics: [],
        reports: [],
        navigation: null,
        navigationNote: "none published",
      };
      const files = writeRunOutputs(dir, caps, handle, { ...bundle, result: { stories: [normal], entryIds: [] }, workers: [w] } as unknown as RunBundle);
      assert.ok(files.includes("workers/101.json"));
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "workers/101.json"), "utf8")), w);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).workers, ["workers/101.json"]);
      const prov = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")) as { articles: { worker?: { exit: string; exitCause: string } }[] };
      assert.deepEqual(prov.articles[0]?.worker, { exit: "failed", exitCause: "signal", failure: null, captureCause: null, captureReason: null });
      const none = writeRunOutputs(dir, caps, handle, { ...bundle, result: { stories: [normal], entryIds: [] } } as unknown as RunBundle);
      assert.ok(!none.some((f) => f.startsWith("workers/")));
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).workers, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a root that ended failed (no result) still writes the workers that ran and lists their stories with the failure cause in provenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-run-failed-root-"));
    try {
      const w = {
        storyId: 201,
        child: "a",
        generation: 1,
        exit: "failed",
        exitCause: null,
        tools: [{ tool: "browser_capture", ok: false, output: "trusted browser capture failed; no receipt issued (cause=non_html)", outputBytes: 60 }],
        errors: [],
        diagnostics: [],
        reports: [],
        navigation: null,
        navigationNote: "none published",
      };
      const files = writeRunOutputs(dir, caps, { ...handle, outcome: "failed" }, { ...bundle, result: null, workers: [w] } as unknown as RunBundle);
      assert.ok(files.includes("workers/201.json"));
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).workers, ["workers/201.json"]);
      const prov = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")) as { items: unknown[]; articles: { storyId: number; worker?: unknown }[] };
      assert.deepEqual(prov.items, []);
      assert.deepEqual(prov.articles, [
        {
          storyId: 201,
          status: null,
          fetchedAt: null,
          rawHash: null,
          worker: { exit: "failed", exitCause: null, failure: w.tools[0]?.output, captureCause: "non_html", captureReason: null },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the pending host row through to egress-audit.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-run-outputs-"));
    try {
      writeRunOutputs(dir, caps, handle, bundle);
      const audit = JSON.parse(readFileSync(join(dir, "egress-audit.json"), "utf8")) as { outcome: string }[];
      assert.equal(audit[0]?.outcome, "pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes no rejected file for a run with no rejected stories", () => {
    const dir = mkdtempSync(join(tmpdir(), "hn-run-outputs-"));
    try {
      const plain = { ...bundle, result: { stories: [normal], entryIds: [] } } as unknown as RunBundle;
      const files = writeRunOutputs(dir, caps, handle, plain);
      assert.deepEqual(files, [
        "digest.md",
        "stories/101.json",
        "cost-ledger.json",
        "egress-audit.json",
        "model-calls.json",
        "assertions.json",
        "approvals.json",
        "provenance.json",
        "run.json",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Payloads shaped as pomtreed's workflow-capabilities writes them: a state row carries the workflow and instance it belongs to.
const state = (workflow: string, instance: string, value: Record<string, unknown>) => ({
  kind: "ext.pomtreed.workflow_state",
  v: 1,
  workflow,
  instance,
  key: "state",
  value,
});

describe("articleChildrenOf", () => {
  const reg = [
    { id: "old", name: "article-5", createdAt: 1 },
    { id: "new", name: "article-5", createdAt: 2 },
    { id: "c", name: "comments-5", createdAt: 3 },
    { id: "x", name: "article-9", createdAt: 4 },
    { id: "named", name: "article-7", createdAt: 5 },
  ];
  it("without a result, takes the newest registry agent named article-<id>, and ignores other names", () => {
    assert.deepEqual(
      [...articleChildrenOf(null, reg)],
      [
        [5, "new"],
        [9, "x"],
        [7, "named"],
      ],
    );
  });
  it("prefers the child a story's result names", () => {
    const result = { stories: [{ story: { id: 5 }, evidence: { upstream: { article: { child: "from-result" } } } }] };
    assert.equal(articleChildrenOf(result, reg).get(5), "from-result");
    assert.equal(articleChildrenOf(result, reg).get(9), "x");
  });
});

describe("rootSeenOf", () => {
  // Two live runs (instances live-a and live-b) interleaved in one journal, and the last state row belongs to live-b.
  const journal = [
    state(ROOT_WORKFLOW, "live-a", { seen: [1, 2], seq: 1, active: null }),
    state(ROOT_WORKFLOW, "live-b", { seen: [9], seq: 1, active: null }),
    state("hn-content/story", "story-abc", { article: { child: null } }),
    state(ROOT_WORKFLOW, "live-a", { seen: [1, 2, 3], seq: 2, active: null }),
    state(ROOT_WORKFLOW, "live-b", { seen: [9, 10], seq: 2, active: null }),
    { kind: "ext.pomtreed.model_settlement", requestId: "req-1", micros: 5, settlement: "priced" },
  ];

  it("returns the seen list of the run's own instance even when another run wrote the last state row", () => {
    assert.deepEqual(rootSeenOf(journal, "live-a"), [1, 2, 3]);
    assert.deepEqual(rootSeenOf(journal, "live-b"), [9, 10]);
  });

  it("ignores a state row of another workflow that carries the same instance name", () => {
    const storyOnly = [state("hn-content/story", "live-c", { seen: [77] })];
    assert.deepEqual(rootSeenOf(storyOnly, "live-c"), []);
  });

  it("returns no seen list for an instance with no state row", () => {
    assert.deepEqual(rootSeenOf(journal, "live-z"), []);
  });

  it("negative control: an unscoped last-seen read returns the other run's list, which the scoped read must not", () => {
    const unscoped = journal
      .filter((p) => (p as { kind?: string }).kind === "ext.pomtreed.workflow_state")
      .filter((p) => Array.isArray((p as { value: { seen?: unknown } }).value.seen))
      .at(-1) as { value: { seen: number[] } } | undefined;
    assert.deepEqual(unscoped?.value.seen, [9, 10]);
    assert.notDeepEqual(rootSeenOf(journal, "live-a"), unscoped?.value.seen);
  });
});

describe("disposeRunDir", () => {
  it("removes the run dir with its contents, and keeps it with its path printed under --keep-run-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "hnl-test-"));
    writeFileSync(join(dir, "pomtreed.sqlite"), "x");
    const lines: string[] = [];
    try {
      disposeRunDir(dir, true, (l) => lines.push(l));
      assert.equal(existsSync(join(dir, "pomtreed.sqlite")), true);
      assert.ok(lines.some((l) => l.includes(dir)));
      disposeRunDir(dir, false, (l) => lines.push(l));
      assert.equal(existsSync(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseLiveArgs", () => {
  const base = ["--output-dir", "/tmp/out"];
  it("defaults to static-http with the static default deadline", () => {
    const a = parseLiveArgs(base);
    assert.equal(a.articleMethod, "static-http");
    assert.equal(a.deadlineMs, 600000);
    assert.equal(a.stories, 1);
    assert.equal(a.approval, "approve");
    assert.equal(a.iKnowTheCap, false);
    assert.equal(a.keepRunDir, false);
  });
  it("--keep-run-dir keeps the per-run temp dir", () => {
    assert.equal(parseLiveArgs([...base, "--keep-run-dir"]).keepRunDir, true);
  });
  it("browser scales the default deadline per story, and an explicit --deadline-ms overrides it", () => {
    assert.equal(parseLiveArgs([...base, "--article-method", "browser"]).deadlineMs, 840000);
    assert.equal(parseLiveArgs([...base, "--article-method", "browser", "--stories", "3"]).deadlineMs, 1320000);
    assert.equal(parseLiveArgs([...base, "--article-method", "browser", "--deadline-ms", "123"]).deadlineMs, 123);
  });
  it("refuses an unknown article method, an unknown flag, a missing output dir and a non-positive deadline with a live content message", () => {
    assert.throws(() => parseLiveArgs([...base, "--article-method", "chrome"]), /^Error: live content: --article-method must be static-http or browser$/);
    assert.throws(() => parseLiveArgs([...base, "--no-such-flag"]), /^Error: live content: /);
    assert.throws(() => parseLiveArgs([]), /live content: --output-dir is required/);
    assert.throws(() => parseLiveArgs([...base, "--deadline-ms", "0"]), /live content: --deadline-ms must be positive/);
  });
  it("refuses the removed --seen-file flag as an unknown option (the entry exits 2 on it)", () => {
    assert.throws(() => parseLiveArgs([...base, "--seen-file", "/tmp/s.json"]), /^Error: live content: .*--seen-file/);
  });
  it("--story-id picks stories in order; --stories defaults to their count and must match it", () => {
    const a = parseLiveArgs([...base, "--story-id", "300", "--story-id", "100"]);
    assert.deepEqual(a.pick, [300, 100]);
    assert.equal(a.stories, 2);
    assert.equal(parseLiveArgs([...base, "--story-id", "5"]).stories, 1);
    assert.deepEqual(parseLiveArgs(base).pick, []);
    const same = parseLiveArgs([...base, "--story-id", "300", "--story-id", "100", "--stories", "2"]);
    assert.deepEqual(same.pick, [300, 100]);
    assert.equal(same.stories, 2);
    assert.equal(parseLiveArgs([...base, "--story-id", "300", "--story-id", "100", "--article-method", "browser"]).deadlineMs, 1080000);
  });
  it("--story-id refuses non-integers, zero, negatives, duplicates, too many and more --stories than ids", () => {
    for (const bad of ["abc", "1.5", "0", "-3", "", "01", "1e3", "9007199254740993"])
      assert.throws(() => parseLiveArgs([...base, `--story-id=${bad}`]), /live content: --story-id must be a positive integer HN item id/, bad);
    assert.throws(() => parseLiveArgs([...base, "--story-id", "5", "--story-id", "5"]), /--story-id given more than once/);
    assert.throws(() => parseLiveArgs([...base, "--story-id", "1", "--story-id", "2", "--story-id", "3", "--story-id", "4"]), /at most 3 --story-id/);
    assert.throws(() => parseLiveArgs([...base, "--story-id", "5", "--stories", "2"]), /--stories may not exceed the number of --story-id values/);
    assert.throws(
      () => parseLiveArgs([...base, "--story-id", "5", "--story-id", "6", "--stories", "1"]),
      /--stories may not be fewer than the number of --story-id values/,
    );
  });
  const IMAGE = `sha256:${"ab".repeat(32)}`;
  it("carries the article method, the seen flags and the optional image and repo through", () => {
    const a = parseLiveArgs([
      ...base,
      "--article-method",
      "browser",
      "--state-dir",
      "/tmp/sd",
      "--seen-import",
      "/tmp/i.json",
      "--seen-export",
      "/tmp/o.json",
      "--image",
      IMAGE,
      "--repo-dir",
      "/tmp/r",
    ]);
    assert.equal(a.articleMethod, "browser");
    assert.equal(a.stateDir, "/tmp/sd");
    assert.equal(a.seenImport, "/tmp/i.json");
    assert.equal(a.seenExport, "/tmp/o.json");
    assert.equal(a.image, IMAGE);
    assert.equal(a.repoDir, "/tmp/r");
  });
});

describe("executeLive: picked stories and the seen state", () => {
  it("a --seen-import holding a picked id exits 2 without persisting the import", async () => {
    const saved: (readonly number[])[] = [];
    const store = { load: async () => [5], save: async (ids: readonly number[]) => void saved.push(ids) };
    const orig = console.error;
    console.error = () => {};
    try {
      const rt = { assertModelRoute: async () => {} } as unknown as LiveContentRuntime;
      const code = await executeLive(rt, {} as LiveCaps, {
        outputDir: "/nonexistent",
        deadlineMs: 1,
        approval: "approve",
        pick: [202],
        seenStore: store,
        seenImport: [202],
      });
      assert.equal(code, 2);
    } finally {
      console.error = orig;
    }
    assert.deepEqual(saved, []);
  });
  const rt = { assertModelRoute: async () => {} } as unknown as LiveContentRuntime;
  const stores = (ids: number[]) => ({ load: async () => ids, save: async () => {} });
  it("refuses a picked story that is already seen with exit 2, before any launch", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (line: string) => void errors.push(String(line));
    try {
      const code = await executeLive(rt, {} as LiveCaps, {
        outputDir: "/nonexistent",
        deadlineMs: 1,
        approval: "approve",
        pick: [101, 202],
        seenStore: stores([202, 5]),
        seenLabel: "seen state X",
      });
      assert.equal(code, 2);
    } finally {
      console.error = orig;
    }
    assert.match(errors.join("\n"), /--story-id 202 already in the seen state \(seen state X\); no override exists/);
  });
});
