import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type ArticleEvidence, type ArticleInput, type CaptureSummary, captureStaticArticleDetailed } from "./article.mts";
import { DEFAULT_CONTENT_BOUNDS as BOUNDS } from "./content-bounds.mts";
import { type AuditRecord, checkRun, type RunFacts, type RunVerdict } from "./content-assertions.mts";
import type { DiscussionSample } from "./discussion.mts";
import { articleRetryable, type EvidenceBundle, hash, jsonHash, parseAnalysis, renderContent, type Story, type StoryResult } from "./content-contract.mts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const fixture = (name: string): string => readFileSync(new URL(`./content-fixtures/${name}`, import.meta.url), "utf8");
const ARTICLE_QUOTE = "append-only ledger of attempts";
const COMMENT_QUOTE = "the ledger idea is useful";
const ARTICLE_INPUT: ArticleInput = { storyId: 101, url: "https://example.com/post", itemHash: "b".repeat(64), maxBytes: 65536 };
const ALL_CHECKS = [
  "digest-claims-union",
  "story-count",
  "analysed-stories",
  "usable-article",
  "seen-set",
  "citations-resolve",
  "spend-total",
  "spend-per-story",
  "fetch-audited",
  "no-private-ranges",
  "audit-contiguous",
  "audit-counts",
  "approval-sha",
  "cancel-nothing-published",
  "model-calls-match-ledger",
  "analyst-tools-only",
];

// Fixtures mirror examples/hn-digest/content-contract.test.mts so the analysis passes the real parseAnalysis.
const articleCapture = () => {
  const body = fixture("article-positive.html");
  return captureStaticArticleDetailed(ARTICLE_INPUT, { status: 200, body, sha256: sha(body), contentType: "text/html; charset=utf-8" }, BOUNDS);
};
const ARTICLE_TEXT = articleCapture().text;
const usableArticle = (): ArticleEvidence => {
  const article = articleCapture().evidence;
  return { ...article, textReport: { id: "text-1", sha256: article.textHash as string } };
};
const STORY: Story = {
  id: 101,
  rank: 1,
  title: "Batch systems",
  url: "https://example.com/post",
  kids: [201, 202, 203],
  itemHash: "c".repeat(64),
  itemSource: "https://hacker-news.firebaseio.com/v0/item/101.json",
};
const STORY2: Story = {
  id: 102,
  rank: 2,
  title: "Second story",
  url: null,
  kids: [],
  itemHash: "f".repeat(64),
  itemSource: "https://hacker-news.firebaseio.com/v0/item/102.json",
};
const comment = (id: number): DiscussionSample => {
  const text = `comment ${id} says the ledger idea is useful`;
  return {
    id,
    storyId: 101,
    sourceUrl: `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
    sha256: sha(text),
    fetchedAt: 1700000000,
    status: "usable",
    parent: 101,
    text,
  };
};
const bundle = (): EvidenceBundle => ({
  story: STORY,
  article: usableArticle(),
  comments: [comment(201), comment(202)],
  upstream: {
    article: { child: "article", generation: 1, evidenceHash: "d".repeat(64) },
    comments: { child: "comments", generation: 1, evidenceHash: "e".repeat(64) },
  },
  limitations: ["static HTTP capture; no JavaScript was executed"],
});
const raw = (ev: EvidenceBundle): Record<string, unknown> => ({
  storyId: 101,
  evidenceHash: jsonHash(ev),
  claims: [
    {
      observation: "The article describes an append-only ledger.",
      basis: "article",
      tentative: true,
      citations: [{ kind: "article", id: 101, sha256: ev.article?.textHash, quote: ARTICLE_QUOTE }],
    },
  ],
  sentiment: {
    label: "positive",
    target: "the ledger idea",
    summary: "Two commenters find it useful.",
    citations: [201, 202],
    scope: "captured_depth1_sample_only",
    tentative: true,
  },
  sentimentEvidence: [
    { kind: "comment", id: 201, sha256: comment(201).sha256, quote: COMMENT_QUOTE },
    { kind: "comment", id: 202, sha256: comment(202).sha256, quote: COMMENT_QUOTE },
  ],
  summary: "short handoff",
});
const story1 = (observation?: string): StoryResult => {
  const ev = bundle();
  const parsed = parseAnalysis(raw(ev), ev, ARTICLE_TEXT);
  if (!parsed.ok) throw new Error(parsed.error);
  const analysis = observation === undefined ? parsed.value : { ...parsed.value, claims: [{ ...parsed.value.claims[0]!, observation }] };
  return { story: STORY, evidence: ev, analysis, failure: null };
};
const story2 = (): StoryResult => ({
  story: STORY2,
  evidence: {
    story: STORY2,
    article: null,
    comments: [],
    upstream: {
      article: { child: "article", generation: 1, evidenceHash: "a".repeat(64) },
      comments: { child: "comments", generation: 1, evidenceHash: "b".repeat(64) },
    },
    limitations: [],
  },
  analysis: null,
  failure: "model timed out",
});
const H = (body: string) => hash(body);
const ARTICLE_TEXT_SHA = usableArticle().textHash as string;

// A valid published run: story 101 analyzed and seen, story 102 failed (not seen), limit 2.
function publishedRun(observation?: string): RunFacts {
  const body = renderContent("run-1", [story1(observation), story2()], BOUNDS);
  const sha256 = H(body);
  return {
    limit: 2,
    modelBudgetMicros: 10000,
    outcome: "published",
    result: {
      report: { id: "report-1", sha256 },
      draftSha: sha256,
      reportBody: body,
      stories: [story1(observation), story2()],
      failedStories: [],
      entryIds: [101],
    },
    publishedReport: { sha256, body },
    seen: [101],
    approvals: [{ kind: "publish", decision: "approved", subjectSha: sha256 }],
    spend: { totalMicros: 4000, byStory: { "101": 2000, "102": 1000 } },
    retainedSha256: [ARTICLE_TEXT_SHA],
    articleTexts: { "101": ARTICLE_TEXT },
    expectedAuthorities: ["example.com"],
    audit: [
      { stream: "host", sequence: 1, authority: "example.com:443", port: 443, peer: "93.184.216.34", outcome: "complete", bytes: 1200 },
      { stream: "sb-1", sequence: 1, authority: "model.example:443", peer: "203.0.113.7", outcome: "connected" },
    ],
    declaredCounts: { host: 1, "sb-1": 1 },
  };
}

function cancelledRun(): RunFacts {
  return {
    limit: 2,
    modelBudgetMicros: 10000,
    outcome: "cancelled",
    result: null,
    publishedReport: null,
    seen: [],
    approvals: [],
    spend: { totalMicros: 0, byStory: {} },
    retainedSha256: [],
    expectedAuthorities: [],
    audit: [{ stream: "host", sequence: 1, authority: "example.com:443", outcome: "cancelled" }],
    declaredCounts: { host: 1 },
  };
}

// Deep-copies a base run, applies one deliberate mutation, and returns the copy.
function edit(mutate: (f: RunFacts) => void, base: RunFacts = publishedRun()): RunFacts {
  const f = structuredClone(base);
  mutate(f);
  return f;
}

// Changes the rendered digest and rehashes every place that pins it, so only the digest-related check can fail.
function withBody(f: RunFacts, body: string): RunFacts {
  const sha256 = H(body);
  const next = structuredClone(f);
  assert.ok(next.result);
  next.result.reportBody = body;
  next.result.draftSha = sha256;
  next.result.report = { id: "report-1", sha256 };
  next.publishedReport = { sha256, body };
  for (const a of next.approvals) a.subjectSha = sha256;
  return next;
}

const failing = (v: RunVerdict): string[] => v.checks.filter((c) => !c.ok).map((c) => c.name);
const fetchCheck = (f: RunFacts) => checkRun(f).checks.find((c) => c.name === "fetch-audited")!;
const expectOnly = (f: RunFacts, name: string): void => {
  const v = checkRun(f);
  assert.deepEqual(failing(v), [name], JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.equal(v.ok, false);
};
const extraHostRecord = (overrides: Partial<AuditRecord>): AuditRecord => ({
  stream: "sb-1",
  sequence: 2,
  authority: "model.example:443",
  outcome: "denied",
  ...overrides,
});

describe("checkRun on valid runs", () => {
  it("passes every check on a valid published run, with all fourteen names in order", () => {
    const v = checkRun(publishedRun());
    assert.deepEqual(
      v.checks.map((c) => c.name),
      ALL_CHECKS,
    );
    for (const c of v.checks) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
    assert.equal(v.ok, true);
    assert.deepEqual(v.warnings, []);
  });

  it("passes every check on a valid cancelled run", () => {
    const v = checkRun(cancelledRun());
    assert.deepEqual(
      v.checks.map((c) => c.name),
      ALL_CHECKS,
    );
    for (const c of v.checks) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
    assert.equal(v.ok, true);
  });

  it("matches the rendered claim line for an observation that inert escapes", () => {
    const f = publishedRun("# not a heading");
    assert.ok(f.result?.reportBody?.includes("- Tentative (story 101) article: \\# not a heading"));
    assert.equal(checkRun(f).ok, true);
  });
});

describe("digest-claims-union", () => {
  it("fails when a validated claim line is missing from the body", () => {
    const body = publishedRun().result!.reportBody!;
    expectOnly(
      withBody(
        publishedRun(),
        body
          .split("\n")
          .filter((l) => !l.startsWith("- Tentative "))
          .join("\n"),
      ),
      "digest-claims-union",
    );
  });

  it("fails when the body carries an extra tentative line", () => {
    const body = `${publishedRun().result!.reportBody!}\n- Tentative (story 101) comments: injected claim`;
    expectOnly(withBody(publishedRun(), body), "digest-claims-union");
  });

  it("fails when a claim line carries another story's id", () => {
    const body = publishedRun().result!.reportBody!.replace("- Tentative (story 101) article:", "- Tentative (story 102) article:");
    expectOnly(withBody(publishedRun(), body), "digest-claims-union");
  });

  it("expects each story's claim lines to carry that story's own id", () => {
    const base = publishedRun();
    const second = { ...story1(), story: { ...STORY, id: 102, rank: 2 } };
    const stories = [story1(), second];
    const body = renderContent("run-1", stories, BOUNDS);
    assert.ok(body.includes("- Tentative (story 101) article: The article describes an append-only ledger."));
    assert.ok(body.includes("- Tentative (story 102) article: The article describes an append-only ledger."));
    const v = checkRun(withBody({ ...base, result: { ...base.result!, stories, reportBody: body } }, body));
    assert.equal(v.checks.find((c) => c.name === "digest-claims-union")?.ok, true);
  });
});

describe("story-count", () => {
  it("fails when analyzed plus failed stories do not equal the limit", () => {
    expectOnly(
      edit((f) => (f.limit = 3)),
      "story-count",
    );
  });

  it("fails when failedStories is not an array", () => {
    expectOnly(
      edit((f) => (f.result!.failedStories = "none" as unknown as unknown[])),
      "story-count",
    );
  });
});

describe("analysed-stories", () => {
  const check = (f: RunFacts) => checkRun(f).checks.find((c) => c.name === "analysed-stories")!;
  const noneAnalysed = (f: RunFacts) => {
    for (const s of f.result!.stories) {
      s.analysis = null;
      s.failure = "model timed out";
    }
    f.result!.entryIds = [];
    f.seen = [];
  };

  it("fails a published run that requested stories but analysed none (the vacuous success)", () => {
    const f = edit(noneAnalysed);
    assert.equal(check(f).ok, false);
    assert.match(check(f).detail, /0 analysed/);
    assert.equal(checkRun(f).ok, false);
  });

  it("fails when published with no stories at all but a positive limit", () => {
    assert.equal(check(edit((f) => (f.result!.stories = []))).ok, false);
  });

  it("passes when at least one story was analysed, and for a run that did not publish", () => {
    assert.equal(check(publishedRun()).ok, true);
    assert.equal(check(cancelledRun()).ok, true);
  });
});

describe("usable-article", () => {
  const check = (f: RunFacts) => checkRun(f).checks.find((c) => c.name === "usable-article")!;
  const unknown = {
    textChars: null,
    bodyBytes: null,
    bodyBytesSeen: null,
    truncated: false,
    domBytesSeen: null,
    domTruncated: false,
    cause: null,
    settle: null,
    screenshot: null,
    rawHash: null,
    textHash: null,
    finalOrigin: null,
  };
  // Story 101 (the only URL-bearing story) loses its article with this capture account.
  const dropped = (capture: CaptureSummary | undefined) =>
    edit((f) => {
      const s = f.result!.stories[0]!;
      s.evidence = { ...s.evidence, article: null, ...(capture && { capture }) };
      if (capture === undefined) delete s.evidence.capture;
    });

  it("fails a published run whose every URL-bearing article was dropped for a worker or verification reason", () => {
    for (const capture of [
      undefined,
      { status: "unusable" as const, reason: "other" as const, httpStatus: null, ...unknown },
      { status: "unusable" as const, reason: "fetch_error" as const, httpStatus: null, ...unknown },
    ]) {
      const f = dropped(capture);
      assert.equal(articleRetryable(f.result!.stories[0]!), true);
      assert.equal(check(f).ok, false, JSON.stringify(capture));
      assert.match(check(f).detail, /worker or verification reason/);
    }
  });

  it("passes when the drop is a property of the page (thin, non-HTML, blocked, an HTTP error), and for a run that did not publish", () => {
    for (const capture of [
      { status: "unsupported" as const, reason: "thin" as const, httpStatus: 200, ...unknown },
      { status: "unsupported" as const, reason: "non_html" as const, httpStatus: null, ...unknown },
      { status: "unusable" as const, reason: "blocked" as const, httpStatus: 403, ...unknown },
      { status: "unusable" as const, reason: "fetch_error" as const, httpStatus: 404, ...unknown },
    ]) {
      const f = dropped(capture);
      assert.equal(articleRetryable(f.result!.stories[0]!), false);
      assert.equal(check(f).ok, true, JSON.stringify(capture));
    }
    assert.equal(check(publishedRun()).ok, true);
    assert.equal(check(cancelledRun()).ok, true);
  });

  it("passes a published run with no URL-bearing story", () => {
    assert.equal(check(edit((f) => (f.result!.stories = [f.result!.stories[1]!]))).ok, true);
  });
});

describe("seen-set", () => {
  it("fails when a story whose article is retried next run (worker or verification drop) is marked seen", () => {
    const f = edit((f) => {
      const s = f.result!.stories[0]!;
      s.evidence = { ...s.evidence, article: null };
    });
    assert.equal(checkRun(f).checks.find((c) => c.name === "seen-set")?.ok, false);
    const unseen = edit((f) => {
      const s = f.result!.stories[0]!;
      s.evidence = { ...s.evidence, article: null };
      f.result!.entryIds = [];
      f.seen = [];
    });
    assert.equal(checkRun(unseen).checks.find((c) => c.name === "seen-set")?.ok, true);
  });

  it("fails when seen has an id that was not analyzed", () => {
    expectOnly(
      edit((f) => (f.seen = [101, 102])),
      "seen-set",
    );
  });

  it("run 1 (empty seed): seen equals this run's entryIds", () => {
    const v = checkRun(edit((f) => (f.seed = [])));
    assert.deepEqual(failing(v), []);
  });

  it("run 2 (persistent seen file): the union with the seed passes when only the newly added ids match entryIds", () => {
    const v = checkRun(
      edit((f) => {
        f.seed = [901, 902, 903];
        f.seen = [901, 902, 903, 101];
      }),
    );
    assert.deepEqual(failing(v), []);
    assert.match(v.checks.find((c) => c.name === "seen-set")!.detail, /1 newly seen ids .* 3 seeded ids not re-selected/);
  });

  it("run 2: a union that adds an id this run did not analyse fails", () => {
    expectOnly(
      edit((f) => {
        f.seed = [901, 902, 903];
        f.seen = [901, 902, 903, 101, 904];
      }),
      "seen-set",
    );
  });

  it("fails when a seeded id was selected again, even if it is also in seen and entryIds", () => {
    const f = edit((f) => {
      f.seed = [101];
      f.seen = [101];
    });
    expectOnly(f, "seen-set");
    assert.match(checkRun(f).checks.find((c) => c.name === "seen-set")!.detail, /selected again: \[101\]/);
  });

  it("fails when entryIds and seen disagree", () => {
    expectOnly(
      edit((f) => (f.result!.entryIds = [101, 102])),
      "seen-set",
    );
  });
});

describe("citations-resolve", () => {
  it("accepts a quote that differs from the captured text only in whitespace, and rejects a case change", () => {
    const f = edit((f) => {
      const c = f.result!.stories[0]!.analysis!.claims[0]!.citations[0]!;
      c.quote = c.quote.replace(/ /g, " ");
    });
    assert.equal(checkRun(f).checks.find((c) => c.name === "citations-resolve")?.ok, true);
    expectOnly(
      edit((f) => {
        const c = f.result!.stories[0]!.analysis!.claims[0]!.citations[0]!;
        c.quote = c.quote.toUpperCase();
      }),
      "citations-resolve",
    );
  });

  it("fails when an article quote is not a substring of the captured text", () => {
    expectOnly(
      edit((f) => (f.result!.stories[0]!.analysis!.claims[0]!.citations[0]!.quote = "this sentence never appears in the article")),
      "citations-resolve",
    );
  });

  it("fails when an article citation sha256 is wrong", () => {
    expectOnly(
      edit((f) => (f.result!.stories[0]!.analysis!.claims[0]!.citations[0]!.sha256 = "0".repeat(64))),
      "citations-resolve",
    );
  });

  it("fails when the article text report is not retained", () => {
    expectOnly(
      edit((f) => (f.retainedSha256 = [])),
      "citations-resolve",
    );
  });

  it("fails when captured article text no longer hashes to textHash", () => {
    expectOnly(
      edit((f) => (f.articleTexts!["101"] += " tampered")),
      "citations-resolve",
    );
  });

  it("fails when the article text was not collected, and when an article quote is not in the collected whole text", () => {
    expectOnly(
      edit((f) => delete f.articleTexts),
      "citations-resolve",
    );
    expectOnly(
      edit((f) => (f.result!.stories[0]!.analysis!.claims[0]!.citations[0]!.quote = "a quote that is not in the stored article text")),
      "citations-resolve",
    );
  });

  it("fails when a sentimentEvidence quote is not a substring of the comment", () => {
    expectOnly(
      edit((f) => (f.result!.stories[0]!.analysis!.sentimentEvidence[0]!.quote = "a quote not in the comment")),
      "citations-resolve",
    );
  });

  it("fails when a sentimentEvidence sha256 is wrong", () => {
    expectOnly(
      edit((f) => (f.result!.stories[0]!.analysis!.sentimentEvidence[1]!.sha256 = "1".repeat(64))),
      "citations-resolve",
    );
  });

  it("fails when a sentiment citation id has no sampled evidence", () => {
    expectOnly(
      edit((f) => (f.result!.stories[0]!.analysis!.sentiment.citations = [201, 999])),
      "citations-resolve",
    );
  });
});

describe("spend-total", () => {
  it("fails when the total exceeds the whole-run budget", () => {
    expectOnly(
      edit((f) => (f.spend.totalMicros = 10001)),
      "spend-total",
    );
  });

  it("fails on a non-finite total", () => {
    expectOnly(
      edit((f) => (f.spend.totalMicros = Number.NaN)),
      "spend-total",
    );
  });

  it("fails when any agent's spend was unreadable, naming the agents", () => {
    const f = edit((f) => (f.spend.unreadable = ["pomtreed-agent-2", "sb-3"]));
    expectOnly(f, "spend-total");
    assert.equal(checkRun(f).checks.find((c) => c.name === "spend-total")?.detail, "spend unreadable for 2 agent(s): pomtreed-agent-2,sb-3");
  });

  it("accepts an empty unreadable list", () => {
    assert.deepEqual(failing(checkRun(edit((f) => (f.spend.unreadable = [])))), []);
  });
});

describe("spend-per-story", () => {
  it("fails when one story exceeds floor(budget / limit)", () => {
    expectOnly(
      edit((f) => (f.spend.byStory = { "101": 5001, "102": 1000 })),
      "spend-per-story",
    );
  });
});

describe("fetch-audited", () => {
  it("fails when an expected authority has no audit record", () => {
    expectOnly(
      edit((f) => (f.expectedAuthorities = ["example.org"])),
      "fetch-audited",
    );
  });

  it("fails when the expected authority only has an error record without bytes or status", () => {
    expectOnly(
      edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", outcome: "error" })),
      "fetch-audited",
    );
  });

  it("fails when an error record carries dialled but no response (a dial that never connected)", () => {
    expectOnly(
      edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", dialled: "93.184.216.34", outcome: "error" })),
      "fetch-audited",
    );
  });

  it("fails when an error record carries only a peer without status or bytes", () => {
    expectOnly(
      edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", peer: "93.184.216.34", outcome: "error" })),
      "fetch-audited",
    );
  });

  it("fails when a dialled address is private", () => {
    const f = edit(
      (f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", dialled: "10.0.0.5", outcome: "error", status: 502, bytes: 1 }),
    );
    assert.equal(fetchCheck(f).ok, false);
    assert.match(fetchCheck(f).detail, /private dialled 10\.0\.0\.5/);
  });

  it("fails when the expected authority only has a cancelled record without bytes or peer", () => {
    const f = edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", outcome: "cancelled" }));
    expectOnly(f, "fetch-audited");
    assert.equal(fetchCheck(f).detail, "example.com: no allowed, connected or complete audit record, and no connected error record");
  });

  it("passes with a warning when the only record is an error with bytes", () => {
    const f = edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", peer: "93.184.216.34", outcome: "error", bytes: 512 }));
    const v = checkRun(f);
    assert.equal(v.ok, true);
    assert.deepEqual(failing(v), []);
    assert.deepEqual(v.warnings, ["fetch-audited: example.com: audited only by outcome=error record(s) (bytes 512); fetch was recorded but did not complete"]);
  });

  it("passes with a warning when the only record is an error with a 5xx status and bytes", () => {
    const f = edit(
      (f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", peer: "93.184.216.34", outcome: "error", status: 503, bytes: 64 }),
    );
    const v = checkRun(f);
    assert.equal(v.ok, true);
    assert.deepEqual(v.warnings, ["fetch-audited: example.com: audited only by outcome=error record(s) (bytes 64); fetch was recorded but did not complete"]);
  });

  it("passes with a warning when the only record is an error with a status but no bytes", () => {
    const f = edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", outcome: "error", upstreamStatus: 502 }));
    const v = checkRun(f);
    assert.equal(v.ok, true);
    assert.deepEqual(v.warnings, ["fetch-audited: example.com: audited only by outcome=error record(s) (bytes 0); fetch was recorded but did not complete"]);
  });

  it("fails when the only record for the expected authority is pending (the call never settled)", () => {
    expectOnly(
      edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", peer: "93.184.216.34", outcome: "pending" })),
      "fetch-audited",
    );
  });

  it("passes with a warning naming the host and count when a pending record sits beside a served record", () => {
    const f = edit((f) => {
      f.audit.push({ stream: "host", sequence: 2, authority: "example.com:443", peer: "93.184.216.34", outcome: "pending" });
      f.declaredCounts.host = 2;
    });
    const v = checkRun(f);
    assert.equal(v.ok, true);
    assert.deepEqual(failing(v), []);
    assert.deepEqual(v.warnings, ["fetch-audited: example.com: 1 pending audit record(s); the call did not settle"]);
  });

  it("does not let pending rows break the row-counting checks", () => {
    const f = edit((f) => {
      f.audit.push({ stream: "host", sequence: 2, authority: "example.com:443", peer: "93.184.216.34", outcome: "pending" });
      f.declaredCounts.host = 2;
    });
    assert.deepEqual(failing(checkRun(f)), []);
  });

  it("fails when the expected authority has a denied record", () => {
    expectOnly(
      edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", outcome: "denied" })),
      "fetch-audited",
    );
  });

  it("passes without a warning when the article read was truncated at the cap (complete, truncated: true)", () => {
    const f = edit(
      (f) =>
        (f.audit[0] = {
          stream: "host",
          sequence: 1,
          authority: "example.com:443",
          peer: "93.184.216.34",
          outcome: "complete",
          bytes: 262144,
          truncated: true,
        }),
    );
    const v = checkRun(f);
    assert.equal(v.ok, true);
    assert.deepEqual(failing(v), []);
    assert.deepEqual(v.warnings, []);
  });

  it("passes without warnings when a served record exists beside an error record", () => {
    const f = edit((f) => {
      f.audit.push({ stream: "host", sequence: 2, authority: "example.com:443", peer: "93.184.216.34", outcome: "error", bytes: 512 });
      f.declaredCounts.host = 2;
    });
    const v = checkRun(f);
    assert.equal(v.ok, true);
    assert.deepEqual(v.warnings, []);
  });

  it("fails when the host also has a denied record, matched case-insensitively", () => {
    expectOnly(
      edit((f) => {
        f.audit.push({ stream: "host", sequence: 2, authority: "EXAMPLE.com:443", peer: "93.184.216.34", outcome: "denied" });
        f.declaredCounts.host = 2;
      }),
      "fetch-audited",
    );
  });

  it("fails when the expected authority is private, naming it", () => {
    const f = edit((f) => {
      f.expectedAuthorities = ["10.0.0.5"];
      f.audit[0] = { stream: "host", sequence: 1, authority: "10.0.0.5:443", peer: "93.184.216.34", outcome: "complete", bytes: 10 };
    });
    assert.equal(fetchCheck(f).ok, false);
    assert.match(fetchCheck(f).detail, /private authority 10\.0\.0\.5/);
  });

  it("fails when a served record for the host has a private peer, naming it", () => {
    const f = edit((f) => (f.audit[0]!.peer = "127.0.0.1"));
    assert.equal(fetchCheck(f).ok, false);
    assert.match(fetchCheck(f).detail, /private peer 127\.0\.0\.1/);
  });

  it("fails when an error record for the host has a private peer, naming it", () => {
    const f = edit((f) => (f.audit[0] = { stream: "host", sequence: 1, authority: "example.com:443", peer: "192.168.1.1", outcome: "error", bytes: 5 }));
    assert.equal(fetchCheck(f).ok, false);
    assert.match(fetchCheck(f).detail, /private peer 192\.168\.1\.1/);
  });
});

describe("no-private-ranges", () => {
  const privatePeers: { authority?: string; peer?: string }[] = [
    { peer: "10.0.0.5" },
    { peer: "172.16.0.1" },
    { peer: "172.31.255.1" },
    { peer: "192.168.1.1" },
    { peer: "127.0.0.1" },
    { peer: "169.254.169.254" },
    { peer: "0.0.0.0" },
    { peer: "100.64.0.1" },
    { peer: "::1" },
    { peer: "[::1]:443" },
    { peer: "::" },
    { peer: "fd12:3456::1" },
    { peer: "fe80::1%en0" },
    { peer: "::ffff:10.1.2.3" },
    { peer: "::ffff:127.0.0.1" },
    { peer: "[::ffff:192.168.0.1]:443" },
    { peer: "0:0:0:0:0:ffff:7f00:1" },
    { authority: "localhost:8080" },
    { authority: "intranet:80" },
    { authority: "[fe80::1]:443" },
  ];
  for (const c of privatePeers) {
    it(`fails on a denied record with private ${c.peer ?? c.authority}`, () => {
      const rec = extraHostRecord({ ...(c.authority ? { authority: c.authority } : {}), ...(c.peer ? { peer: c.peer } : {}) });
      expectOnly(
        edit((f) => {
          f.audit.push(rec);
          f.declaredCounts["sb-1"] = 2;
        }),
        "no-private-ranges",
      );
    });
  }

  const relayRows = (relayPorts: number[] | undefined) =>
    edit((f) => {
      f.audit.push(
        extraHostRecord({ stream: "live-model-pre", sequence: 1, authority: "host.docker.internal:43111", peer: "192.168.65.254", outcome: "complete" }),
      );
      f.audit.push(extraHostRecord({ authority: "host.docker.internal:43112", peer: "192.168.65.254", outcome: "connected" }));
      f.declaredCounts["live-model-pre"] = 1;
      f.declaredCounts["sb-1"] = 2;
      if (relayPorts !== undefined) f.relayPorts = relayPorts;
    });

  it("exempts the model/report relay rows at host.docker.internal on the granted relay ports, including the unattributed preflight stream", () => {
    assert.deepEqual(failing(checkRun(relayRows([43111, 43112]))), []);
  });

  it("does not exempt the Docker host alias on a port the run did not grant, nor at all without relay ports", () => {
    expectOnly(relayRows([43111]), "no-private-ranges");
    expectOnly(relayRows(undefined), "no-private-ranges");
    expectOnly(relayRows([]), "no-private-ranges");
    assert.match(checkRun(relayRows([43111])).checks.find((c) => c.name === "no-private-ranges")?.detail ?? "", /sequence 2: peer 192\.168\.65\.254/);
  });

  for (const target of ["169.254.169.254", "10.0.0.1", "192.168.65.254"]) {
    it(`still fails a worker row to ${target} (authority and peer), even beside relay rows`, () => {
      for (const rec of [extraHostRecord({ authority: `${target}:80` }), extraHostRecord({ authority: "model.example:443", peer: target })]) {
        expectOnly(
          edit((f) => {
            f.audit.push(extraHostRecord({ stream: "live-model-pre", sequence: 1, authority: "host.docker.internal:43111", peer: "192.168.65.254" }), rec);
            f.relayPorts = [43111];
            f.declaredCounts["live-model-pre"] = 1;
            f.declaredCounts["sb-1"] = 2;
          }),
          "no-private-ranges",
        );
      }
    });
  }

  const publicPeers = ["93.184.216.34", "172.32.0.1", "172.15.0.1", "100.128.0.1", "192.169.0.1", "2606:4700::1111", "2001:db8::1", "::ffff:8.8.8.8"];
  for (const peer of publicPeers) {
    it(`accepts public peer ${peer}`, () => {
      const v = checkRun(
        edit((f) => {
          f.audit.push(extraHostRecord({ peer, outcome: "allowed" }));
          f.declaredCounts["sb-1"] = 2;
        }),
      );
      assert.deepEqual(failing(v), []);
    });
  }
});

describe("audit-contiguous", () => {
  it("fails on a sequence gap", () => {
    expectOnly(
      edit((f) => {
        f.audit.push(extraHostRecord({ sequence: 3, outcome: "allowed" }));
        f.declaredCounts["sb-1"] = 2;
      }),
      "audit-contiguous",
    );
  });

  it("fails on a duplicate sequence", () => {
    expectOnly(
      edit((f) => {
        f.audit.push(extraHostRecord({ sequence: 1, outcome: "allowed" }));
        f.declaredCounts["sb-1"] = 2;
      }),
      "audit-contiguous",
    );
  });
});

describe("audit-counts", () => {
  it("fails when a declared count differs from the collected records", () => {
    expectOnly(
      edit((f) => (f.declaredCounts["sb-1"] = 3)),
      "audit-counts",
    );
  });

  it("fails when a stream with a positive declared count has no records", () => {
    expectOnly(
      edit((f) => (f.declaredCounts.ghost = 1)),
      "audit-counts",
    );
  });

  it("accepts a zero declared count for a stream with no records", () => {
    assert.deepEqual(failing(checkRun(edit((f) => (f.declaredCounts.ghost = 0)))), []);
  });
});

describe("approval-sha", () => {
  it("fails when the approval subject hash differs from the published report", () => {
    expectOnly(
      edit((f) => {
        f.approvals[0]!.subjectSha = "f".repeat(64);
      }),
      "approval-sha",
    );
  });

  it("fails when there is no approved publish", () => {
    expectOnly(
      edit((f) => {
        f.approvals[0]!.decision = "denied";
      }),
      "approval-sha",
    );
  });

  it("fails when a published run has no retained report", () => {
    expectOnly(
      edit((f) => (f.publishedReport = null)),
      "approval-sha",
    );
  });

  it("fails when an approved publish exists but nothing was published", () => {
    const f = cancelledRun();
    f.approvals = [{ kind: "publish", decision: "approved", subjectSha: H("x") }];
    expectOnly(f, "approval-sha");
  });
});

describe("cancel-nothing-published", () => {
  it("passes a cancelled run that started from a non-empty seen set and added nothing", () => {
    const v = checkRun(edit((f) => (f.seed = f.seen = [901, 902]), cancelledRun()));
    assert.equal(v.checks.find((c) => c.name === "cancel-nothing-published")?.ok, true);
  });

  it("fails a cancelled run that added an id beyond its seed", () => {
    expectOnly(
      edit((f) => {
        f.seed = [901];
        f.seen = [901, 101];
      }, cancelledRun()),
      "cancel-nothing-published",
    );
  });

  it("fails when a cancelled run has seen ids", () => {
    expectOnly(
      edit((f) => (f.seen = [101]), cancelledRun()),
      "cancel-nothing-published",
    );
  });

  it("fails when a cancelled run retains a published report", () => {
    expectOnly(
      edit((f) => (f.publishedReport = { sha256: H("x"), body: "x" }), cancelledRun()),
      "cancel-nothing-published",
    );
  });

  it("fails when a cancelled run has a result report or entry ids", () => {
    expectOnly(
      edit((f) => {
        f.result = { report: { id: "r", sha256: H("y") }, stories: [], entryIds: [101] };
      }, cancelledRun()),
      "cancel-nothing-published",
    );
  });
});

describe("analyst-tools-only", () => {
  const find = (f: RunFacts) => checkRun(f).checks.find((c) => c.name === "analyst-tools-only");

  it("passes when every analyst call is article_page or analysis_result, and when no traces are supplied", () => {
    const f = edit((f) => (f.analystTools = [{ storyId: 1, tools: ["article_page", "article_page", "analysis_result"] }]));
    assert.equal(find(f)?.ok, true);
    assert.match(find(f)?.detail ?? "", /3 tool call\(s\)/);
    assert.equal(find(publishedRun())?.ok, true);
  });

  it("fails naming the story and the tool for bash, read, write, edit, a browser tool and an unknown tool", () => {
    for (const tool of ["bash", "read", "write", "edit", "browser_capture", "capture_finish", "made_up"]) {
      const f = edit((f) => (f.analystTools = [{ storyId: 7, tools: ["article_page", tool, "analysis_result"] }]));
      assert.deepEqual(failing(checkRun(f)), ["analyst-tools-only"], tool);
      assert.match(find(f)?.detail ?? "", new RegExp(`story 7 called "${tool}"`));
    }
  });

  it("matches names exactly: a near-miss or a differently cased name fails, and a malformed field fails the check instead of throwing", () => {
    for (const tool of ["Article_Page", "article_page ", "article_pages", ""])
      assert.deepEqual(failing(checkRun(edit((f) => (f.analystTools = [{ storyId: 1, tools: [tool] }])))), ["analyst-tools-only"], JSON.stringify(tool));
    assert.deepEqual(failing(checkRun(edit((f) => (f.analystTools = {} as never)))), ["analyst-tools-only"]);
  });
});

describe("model-calls-match-ledger", () => {
  const rows = (): { requestId: string; micros: number }[] => [
    { requestId: "req-1", micros: 1500 },
    { requestId: "req-2", micros: 2500 },
  ];

  it("passes when the model-call micros sum to the ledger total", () => {
    const f = edit((f) => {
      f.modelCalls = rows();
      f.spend.totalMicros = 4000;
    });
    assert.deepEqual(failing(checkRun(f)), []);
    assert.equal(checkRun(f).checks.find((c) => c.name === "model-calls-match-ledger")?.ok, true);
  });

  it("fails when the model-call sum differs from the ledger total", () => {
    const f = edit((f) => {
      f.modelCalls = rows();
      f.spend.totalMicros = 4001;
    });
    assert.deepEqual(failing(checkRun(f)), ["model-calls-match-ledger"]);
  });

  it("fails on a duplicate requestId", () => {
    const f = edit((f) => {
      f.modelCalls = [
        { requestId: "req-1", micros: 2000 },
        { requestId: "req-1", micros: 2000 },
      ];
      f.spend.totalMicros = 4000;
    });
    assert.deepEqual(failing(checkRun(f)), ["model-calls-match-ledger"]);
    assert.match(checkRun(f).checks.find((c) => c.name === "model-calls-match-ledger")?.detail ?? "", /duplicate requestId req-1/);
  });

  it("skips the check when the field is absent, and fails empty rows against a positive ledger total", () => {
    const absent = checkRun(publishedRun()).checks.find((c) => c.name === "model-calls-match-ledger");
    assert.equal(absent?.ok, true);
    assert.match(absent?.detail ?? "", /no model-call rows/);
    const empty = checkRun(edit((f) => (f.modelCalls = [])));
    assert.deepEqual(failing(empty), publishedRun().spend.totalMicros > 0 ? ["model-calls-match-ledger"] : []);
    const zero = checkRun(
      edit((f) => {
        f.modelCalls = [];
        f.spend.totalMicros = 0;
        f.spend.byStory = {};
      }),
    );
    assert.equal(zero.checks.find((c) => c.name === "model-calls-match-ledger")?.ok, true);
  });

  it("fails only this check when the rows do not match the ledger", () => {
    const f = edit((f) => (f.modelCalls = [{ requestId: "req-1", micros: 1 }]));
    assert.deepEqual(failing(checkRun(f)), ["model-calls-match-ledger"]);
  });
});

describe("malformed input", () => {
  it("never throws on null and reports every check as failed", () => {
    const v = checkRun(null as unknown as RunFacts);
    assert.equal(v.ok, false);
    assert.deepEqual(
      v.checks.map((c) => c.name),
      ALL_CHECKS,
    );
  });

  it("fails the check that reads a non-array stories list without failing unrelated checks", () => {
    const f = edit((f) => {
      f.result!.stories = "nope" as unknown as StoryResult[];
    });
    const names = failing(checkRun(f));
    assert.ok(names.includes("digest-claims-union"));
    assert.ok(names.includes("seen-set"));
    assert.ok(!names.includes("spend-total"));
    assert.ok(!names.includes("audit-contiguous"));
  });
});
