// Real SQLite + canonical operator launch, offline source transport, mechanical worker and scripted model harness (see content-harness.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { hash, type StoryResult } from "./content-contract.mts";
import { INPUT, type Options, setup, until } from "./content-harness.mts";
import { provenanceOf } from "./content-live-run.mts";

test("content tree: concurrent article/comments, wait-driven grounded model, one SHA-bound approval and retained final body", { timeout: 20000 }, async () => {
  const e = await setup({ attention: true });
  try {
    await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
    assert.deepEqual(e.starts, ["article-101"]);
    assert.equal((await e.rt.daemon.get(e.id))?.state, "yielded", "root releases execution rather than polling");
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "final publish approval",
    );
    assert.deepEqual(e.errors, []);
    assert.deepEqual(e.starts, ["article-101", "analysis-101"]);
    const reportsBefore = await e.rt.cli(["--json", "report", "list", e.rt.root.id]);
    assert.equal(reportsBefore.code, 0);
    assert.ok(!reportsBefore.out.join("\n").includes("hn-content-offline-content.md"));
    assert.match(approval.action.target, /^[a-f0-9]{64}$/);
    const escalations = await e.rt.stores.escalations.list();
    assert.equal(escalations.length, 1, "attention forwards the same escalation without another ask/approval");
    assert.equal(escalations[0]?.holder, null);
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "offline fixture draft accepted", "approve-fixture");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "content root succeeded");
    assert.equal(done.exit, "succeeded", JSON.stringify(done.result));
    const result = done.result as { reportBody: string; draftSha: string; stories: StoryResult[]; report: { id: string }; entryIds: number[] };
    assert.equal(hash(result.reportBody), approval.action.target);
    assert.equal(result.draftSha, approval.action.target);
    assert.match(result.reportBody, /silent batch record loss/);
    assert.match(result.reportBody, /Comment 203: deleted/);
    assert.match(result.reportBody, /not representative of HN/);
    assert.match(result.reportBody, /Sample-only sentiment: unclear/);
    assert.ok(result.stories[0]?.evidence.article?.bodyReport);
    const all = await e.rt.stores.registry.list();
    assert.ok(all.filter((r) => r.id !== e.rt.root.id && r.id !== e.id).every((r) => r.state === "reaped"));
    const reports = await e.rt.cli(["report", "show", e.rt.root.id, result.report.id]);
    assert.equal(reports.code, 0, reports.err.join("\n"));
    assert.ok(reports.out.join("\n").includes("silent batch record loss"), "actual retained report body readable through canonical report API");
    const replay = await e.rt.cli([
      "--json",
      "workflow",
      "launch",
      "hn-content/content",
      "--input",
      JSON.stringify(INPUT),
      "--key",
      "content-offline",
      "--budget",
      "5000",
    ]);
    assert.equal(replay.code, 0);
    assert.equal((JSON.parse(replay.out.join("\n")) as { agent: string }).agent, e.id);
    assert.equal(e.starts.length, 2, "replay does not redispatch any paid child");
    const fresh = await e.rt.cli([
      "--json",
      "workflow",
      "launch",
      "hn-content/content",
      "--input",
      JSON.stringify(INPUT),
      "--key",
      "content-fresh",
      "--budget",
      "5000",
    ]);
    assert.equal(fresh.code, 0);
    const freshId = (JSON.parse(fresh.out.join("\n")) as { agent: string }).agent;
    const noNew = await until(async () => {
      const r = await e.rt.daemon.get(freshId);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "fresh selection respects committed seen IDs");
    assert.equal(noNew.exit, "succeeded");
    assert.deepEqual((noNew.result as { entryIds: number[] }).entryIds, []);
    assert.equal(e.starts.length, 2);
    assert.equal((await e.rt.stores.approvals.list()).length, 1, "noop creates no second publication gate");
  } finally {
    await e.cleanup();
  }
});

for (const failure of ["deny", "cancel", "timeout", "allUnusable"] as const)
  test(`content tree: ${failure} never publishes/outboxes/marks seen`, { timeout: 20000 }, async () => {
    const e = await setup({ [failure]: true });
    try {
      await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
      e.releaseCapture.resolve();
      e.releaseComment.resolve();
      if (failure === "allUnusable") {
        const done = await until(async () => {
          const r = await e.rt.daemon.get(e.id);
          return r && ["exited", "reaped"].includes(r.state) && r;
        }, "all evidence unusable terminal failure");
        assert.equal(done.exit, "failed");
        assert.equal(e.starts.length, 1);
      } else {
        // The timeout scenario's gate expires on its own after approvalTimeoutMs, so under load it can leave "pending" before a poll sees it:
        // wait for the gate in any state, and for that scenario assert it fail-closed to denied.
        const approval = await until(
          async () => (await e.rt.stores.approvals.list(failure === "timeout" ? {} : { state: "pending" })).find((a) => a.action.kind === "publish"),
          "publication gate",
        );
        if (failure === "deny") await e.rt.daemon.decideApproval(approval.id, "deny", "operator", "fixture denial", "deny-fixture");
        else if (failure === "cancel") await e.rt.daemon.cancel(e.id, 0);
        await until(async () => {
          const r = await e.rt.daemon.get(e.id);
          return r && ["exited", "reaped"].includes(r.state) && r;
        }, "denied/cancelled terminal");
        if (failure === "timeout") assert.equal((await e.rt.stores.approvals.get(approval.id))?.state, "denied", "an expired gate fails closed");
      }
      const rows = await e.rt.stores.journal.read({ agent: e.rt.root.id, limit: 5000 });
      assert.ok(!rows.some((r) => r.payload.kind === "message_sent"));
      assert.ok(!rows.some((r) => r.payload.kind === "ext.pomtreed.workflow_report"));
      const stateRows = rows.map((r) => r.payload).filter((p) => p.kind === "ext.pomtreed.workflow_state") as unknown as Array<{ value: { seen?: number[] } }>;
      assert.ok(stateRows.filter((r) => r.value.seen).every((r) => r.value.seen?.length === 0));
    } finally {
      await e.cleanup();
    }
  });

test("content tree: missing article still analyzes captured comments without article claims", { timeout: 20000 }, async () => {
  const e = await setup({ articleFailure: true });
  try {
    await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "limited draft gate",
    );
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "limited draft", "limited-approve");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "partial result");
    assert.equal(done.exit, "succeeded");
    const result = done.result as { reportBody: string; stories: StoryResult[] };
    assert.match(result.reportBody, /Article text unavailable; no article claims permitted/);
    assert.ok(result.stories[0]?.analysis?.claims.every((c) => c.basis === "comments"));
    assert.deepEqual(e.errors, []);
  } finally {
    await e.cleanup();
  }
});

test("content tree: cancellation during capture prevents analysis dispatch and publication", { timeout: 20000 }, async () => {
  const e = await setup();
  try {
    await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
    await e.rt.daemon.cancel(e.id, 0);
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "cancelled capture tree");
    assert.equal(done.exit, "cancelled");
    assert.ok(!e.starts.some((s) => s.startsWith("analysis-")));
    assert.equal((await e.rt.stores.approvals.list()).length, 0);
    const rows = await e.rt.stores.journal.read({ agent: e.rt.root.id, limit: 5000 });
    assert.ok(!rows.some((r) => r.payload.kind === "ext.pomtreed.workflow_report" || r.payload.kind === "message_sent"));
  } finally {
    await e.cleanup();
  }
});

test("content tree: zero unseen stories (every feed id already seen) is a no-op without approval, model or publication", { timeout: 10000 }, async () => {
  const e = await setup({ feed: [101, 102], seen: [101, 102] });
  try {
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "zero item result");
    assert.equal(done.exit, "succeeded");
    assert.equal(e.starts.length, 0);
    assert.deepEqual(await e.rt.stores.approvals.list(), []);
  } finally {
    await e.cleanup();
  }
});

test("content tree: an empty feed (zero ids) fails instead of reporting no unseen stories", { timeout: 10000 }, async () => {
  const e = await setup({ noItems: true });
  try {
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "empty feed result");
    assert.equal(done.exit, "failed");
    assert.equal(e.starts.length, 0);
    assert.deepEqual(await e.rt.stores.approvals.list(), []);
    assert.ok(JSON.stringify(await e.rt.stores.journal.read({ limit: 2000 })).includes("HN feed returned zero ids"), "the cause is journaled");
  } finally {
    await e.cleanup();
  }
});

test("content tree: two parallel stories with a 64-character root instance keep unique bounded stage instances", { timeout: 20000 }, async () => {
  const e = await setup({ stories: 2, longInstance: true });
  try {
    await until(async () => e.starts.filter((s) => s.startsWith("article-")).length === 2 && true, "both article workers started concurrently");
    assert.ok(!e.starts.some((s) => s.startsWith("analysis-")));
    const stories = await e.rt.stores.registry.list({ parent: e.id });
    assert.equal(stories.length, 2);
    const instances = stories.map((s) =>
      s.executor === "deterministic" && typeof s.spec.input === "object" && s.spec.input !== null && !Array.isArray(s.spec.input)
        ? s.spec.input.instance
        : null,
    );
    assert.equal(new Set(instances).size, 2);
    assert.ok(instances.every((s) => typeof s === "string" && s.length <= 64));
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "single joined publication gate",
    );
    assert.equal((await e.rt.stores.approvals.list()).length, 1);
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "two-story fixture", "two-story-approve");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "two-story content result");
    assert.equal(done.exit, "succeeded");
    assert.deepEqual((done.result as { entryIds: number[] }).entryIds, [101, 102]);
    assert.equal(e.starts.filter((s) => s.startsWith("analysis-")).length, 2);
    assert.equal(e.sourceRequests.filter((u) => u.includes("topstories")).length, 1);
    assert.deepEqual(e.errors, []);
  } finally {
    await e.cleanup();
  }
});

test("content tree: maximum three stories retain astral/JSON-escaping evidence within real state and suspension ceilings", { timeout: 20000 }, async () => {
  const e = await setup({ stories: 3, worstCase: true, longInstance: true });
  try {
    await until(async () => e.starts.filter((s) => s.startsWith("article-")).length === 3 && true, "all bounded article workers");
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "maximum-size draft gate",
    );
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "worst-case fixture only", "max-size-approve");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "three bounded story results");
    assert.equal(done.exit, "succeeded");
    const result = done.result as { stories: StoryResult[]; reportBody: string };
    assert.equal(result.stories.length, 3);
    assert.ok(
      result.stories.every(
        (s) => s.analysis !== null && s.evidence.comments.length === 2 && s.evidence.comments.every((c) => Array.from(c.text).length === 1000),
      ),
    );
    assert.ok(
      result.stories.every(
        // Past the former 8192-byte inline clip: the whole text is stored (as a retained report), not clipped.
        (s) => (s.evidence.article?.textBytes ?? 0) > 8192 && s.evidence.article?.textTruncated === false,
      ),
    );
    const rows = await e.rt.stores.journal.read({ limit: 10000 });
    const states = rows
      .filter((e) => e.payload.kind === "ext.pomtreed.workflow_state" || e.payload.kind === "ext.workflow.continuation")
      .map((e) => e.payload as { kind: string; value?: unknown; state?: unknown });
    assert.ok(states.length > 20);
    const sizes = states.map((p) => Buffer.byteLength(JSON.stringify(p.kind === "ext.pomtreed.workflow_state" ? p.value : p.state)));
    assert.ok(
      sizes.every((n) => n <= 128 * 1024),
      `maximum snapshot/state ${Math.max(...sizes)}`,
    );
    assert.ok(Buffer.byteLength(result.reportBody) <= 65536);
    assert.equal(e.starts.length, 6);
    assert.deepEqual(e.errors, []);
  } finally {
    await e.cleanup();
  }
});

test("content tree: native browser_capture contract on injected page traverses authority, analysis and final approval without browser-live claims", {
  timeout: 20000,
}, async () => {
  const e = await setup({ browser: true });
  try {
    await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "native-contract publication gate",
    );
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "injected-page fixture, not live browser", "native-fixture-approve");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "native-contract tree result");
    assert.equal(done.exit, "succeeded");
    const result = done.result as { stories: StoryResult[]; reportBody: string };
    const article = result.stories[0]?.evidence.article;
    assert.ok(article?.browserEvidence && article.domReport && article.screenshotReport);
    assert.equal(article.method, "browser");
    assert.notEqual(article.rawHash, article.domReport.sha256);
    assert.ok(result.stories[0]?.analysis);
    assert.match(result.reportBody, /not rendered DOM or wire capture/);
    assert.deepEqual(e.errors, []);
  } finally {
    await e.cleanup();
  }
});

// A story whose article is not analysed must say why, from the worker's capture through the story result, the digest and provenance.
const WORDS = "Repository stars forks issues pull requests branches tags releases packages ";
const THIN = "<html><body><article><p>too short</p></article></body></html>";
const BOILERPLATE = `<html><body><article><p>${WORDS.repeat(10).slice(0, 700)}${"<span></span>".repeat(15_000)}</p></article></body></html>`;
const DROPPED: { name: string; options: Options; reason: string; status: string; limitation: RegExp; rawHash: boolean }[] = [
  {
    name: "thin",
    options: { page: { body: THIN } },
    reason: "thin",
    status: "unsupported",
    limitation: /^Limitation: Article not analysed: too thin to ground: under 400 characters of readable text after extraction$/m,
    rawHash: true,
  },
  {
    name: "boilerplate",
    options: { page: { body: BOILERPLATE } },
    reason: "boilerplate",
    status: "unsupported",
    limitation: /^Limitation: Article not analysed: page is mostly markup\/boilerplate \(700 chars of text in \d+ bytes\)$/m,
    rawHash: true,
  },
  {
    name: "non_html",
    options: { page: { contentType: "application/pdf", body: "%PDF-1.7 binary" } },
    reason: "non_html",
    status: "unsupported",
    limitation: /^Limitation: Article not analysed: content type application\/pdf is not HTML$/m,
    rawHash: true,
  },
  {
    name: "fetch_error (HTTP 404)",
    options: { page: { status: 404, body: "<html>gone</html>" } },
    reason: "fetch_error",
    status: "unusable",
    limitation: /^Limitation: Article not analysed: HTTP 404$/m,
    rawHash: true,
  },
  {
    name: "fetch_error (worker failed, no receipt)",
    options: { articleFailure: true },
    reason: "fetch_error",
    status: "unusable",
    limitation: /^Limitation: Article not analysed: article worker failed; no capture receipt$/m,
    rawHash: false,
  },
];
for (const c of DROPPED)
  test(`content tree: a dropped article (${c.name}) keeps its specific reason in the result, digest and provenance`, { timeout: 20000 }, async () => {
    const e = await setup(c.options);
    try {
      await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
      e.releaseCapture.resolve();
      e.releaseComment.resolve();
      const approval = await until(
        async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
        "limited draft gate",
      );
      await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "limited draft", "limited-approve");
      const done = await until(async () => {
        const r = await e.rt.daemon.get(e.id);
        return r && ["exited", "reaped"].includes(r.state) && r;
      }, "partial result");
      assert.equal(done.exit, "succeeded", JSON.stringify(done.result));
      const result = done.result as { reportBody: string; stories: StoryResult[] };
      const story = result.stories[0];
      assert.equal(story?.evidence.article, null);
      assert.match(result.reportBody, c.limitation);
      assert.ok(!result.reportBody.includes("Article capture unavailable or invalid"));
      assert.equal(story?.evidence.capture?.status, c.status);
      assert.equal(story?.evidence.capture?.reason, c.reason);
      assert.equal(typeof story?.evidence.capture?.rawHash === "string", c.rawHash);
      const row = provenanceOf({ stories: result.stories, entryIds: [], provenance: [] }).articles[0];
      assert.equal(row?.status, c.status);
      assert.equal(typeof row?.rawHash === "string", c.rawHash);
      assert.deepEqual(row && "capture" in row ? row.capture : null, story?.evidence.capture);
      assert.deepEqual(e.errors, []);
    } finally {
      await e.cleanup();
    }
  });

test("content tree: a usable article carries no separate capture summary", { timeout: 20000 }, async () => {
  const e = await setup();
  try {
    await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"), "publish gate");
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "ok", "usable-approve");
    const done = await until(async () => {
      const r = await e.rt.daemon.get(e.id);
      return r && ["exited", "reaped"].includes(r.state) && r;
    }, "result");
    const story = (done.result as { stories: StoryResult[] }).stories[0];
    assert.equal(story?.evidence.article?.status, "usable");
    assert.equal(story?.evidence.capture, undefined);
  } finally {
    await e.cleanup();
  }
});

const settled = (e: Awaited<ReturnType<typeof setup>>, note: string) =>
  until(async () => {
    const r = await e.rt.daemon.get(e.id);
    return r && ["exited", "reaped"].includes(r.state) && r;
  }, note);

test("content tree: operator-picked story is fetched by id, reads no feed, and its provenance has no feed", { timeout: 20000 }, async () => {
  const e = await setup({ pick: [102], feed: [101] });
  try {
    await Promise.all([e.captureStarted.promise, e.commentStarted.promise]);
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await until(
      async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"),
      "final publish approval",
    );
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "offline fixture draft accepted", "approve-pick");
    const done = await settled(e, "picked run terminal");
    assert.equal(done.exit, "succeeded");
    assert.ok(!e.sourceRequests.some((u) => u.endsWith("topstories.json")), "no feed read");
    assert.ok(e.sourceRequests.some((u) => u.endsWith("item/102.json")));
    assert.ok(!e.sourceRequests.some((u) => u.endsWith("item/101.json")), "the top story is not touched");
    assert.deepEqual(e.starts, ["article-102", "analysis-102"]);
    const result = done.result as { entryIds: number[]; stories: StoryResult[]; provenance: { url: string }[] };
    assert.deepEqual(result.entryIds, [102]);
    const body = (done.result as { reportBody: string }).reportBody;
    assert.match(body, /Operator-picked stories \(order as given\)/);
    assert.doesNotMatch(body, /Ranked feed position/);
    assert.deepEqual(
      result.stories.map((s) => s.story.id),
      [102],
    );
    const prov = provenanceOf(done.result as never);
    assert.equal(prov.feed, null);
    assert.equal(prov.feedOrigin, null);
    assert.deepEqual(
      prov.items.map((i) => i.id),
      [102],
    );
  } finally {
    await e.cleanup();
  }
});

for (const [name, items] of [
  ["a comment", { 777: { id: 777, type: "comment", text: "not a story", parent: 101 } }],
  ["a deleted item", { 777: { id: 777, deleted: true } }],
  ["an unknown item (null)", { 777: null }],
] as const)
  test(`content tree: a picked id that is ${name} fails the run before any child or spend`, { timeout: 20000 }, async () => {
    const e = await setup({ pick: [101, 777], stories: 2, items });
    try {
      const done = await settled(e, "picked non-story terminal");
      assert.equal(done.exit, "succeeded");
      assert.match(JSON.stringify(done.result), /Picked HN items are not usable stories.*: 777; nothing was run/);
      assert.equal((done.result as { report?: unknown }).report, undefined);
      assert.deepEqual(e.starts, []);
      assert.deepEqual(await e.rt.stores.approvals.list(), []);
    } finally {
      await e.cleanup();
    }
  });

test("content tree: a picked id whose fetch failed is reported as unread, not as an unusable story, and nothing runs", { timeout: 20000 }, async () => {
  const e = await setup({ pick: [101, 777, 888], stories: 3, items: { 888: { id: 888, deleted: true } }, itemErrors: [777] });
  try {
    const done = await settled(e, "picked unread terminal");
    assert.equal(done.exit, "succeeded");
    const summary = (done.result as { summary: string }).summary;
    assert.match(summary, /could not be read \(fetch failed or interrupted\): 777/);
    assert.match(summary, /not usable stories \(unavailable, deleted, dead, or not a story, job or poll\): 888/);
    assert.doesNotMatch(summary, /888.*777|usable stories[^;]*777/);
    assert.match(summary, /nothing was run/);
    assert.deepEqual(e.starts, []);
    assert.deepEqual(await e.rt.stores.approvals.list(), []);
  } finally {
    await e.cleanup();
  }
});

test("content tree: a picked id already in the seen set is refused by the workflow too", { timeout: 20000 }, async () => {
  const e = await setup({ pick: [101], seen: [101] });
  try {
    const done = await settled(e, "picked seen terminal");
    assert.equal(done.exit, "failed");
    assert.deepEqual(e.starts, []);
  } finally {
    await e.cleanup();
  }
});
