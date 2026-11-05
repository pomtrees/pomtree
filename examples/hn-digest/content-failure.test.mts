// Multi-story failure, budget, cancellation and seen-marking behavior of the content tree (harness: content-harness.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord } from "../../packages/core/src/index.ts";
import type { MissingStory, StoryResult } from "./content-contract.mts";
import { setup, until } from "./content-harness.mts";

type Env = Awaited<ReturnType<typeof setup>>;
type Result = { reportBody: string; stories: StoryResult[]; entryIds: number[]; failedStories: MissingStory[] };

const terminal = (e: Env) =>
  until(async () => {
    const r = await e.rt.daemon.get(e.id);
    return r && ["exited", "reaped"].includes(r.state) && r;
  }, "root terminal");
const pendingPublish = (e: Env) =>
  until(async () => (await e.rt.stores.approvals.list({ state: "pending" })).find((a) => a.action.kind === "publish"), "publication gate");
const storyChild = async (e: Env, storyId: number): Promise<AgentRecord> => {
  const child = (await e.rt.stores.registry.list({ parent: e.id })).find((a) => a.name === `story-${storyId}`);
  assert.ok(child, `story child ${storyId}`);
  return child;
};
// The root's committed seen set: last workflow-state row that carries one.
async function seenOf(e: Env): Promise<number[]> {
  const rows = await e.rt.stores.journal.read({ limit: 10000 });
  const states = rows.map((r) => r.payload).filter((p) => p.kind === "ext.pomtreed.workflow_state") as unknown as Array<{ value: { seen?: number[] } }>;
  return states.filter((p) => Array.isArray(p.value.seen)).at(-1)?.value.seen ?? [];
}
async function assertNothingPublished(e: Env) {
  assert.equal((await e.rt.stores.approvals.list()).length === 0 || (await e.rt.stores.approvals.list({ state: "approved" })).length === 0, true);
  const rows = await e.rt.stores.journal.read({ agent: e.rt.root.id, limit: 5000 });
  assert.ok(!rows.some((r) => r.payload.kind === "message_sent" || r.payload.kind === "ext.pomtreed.workflow_report"));
  assert.deepEqual(await seenOf(e), []);
}
const bothArticlesStarted = (e: Env, n = 2) =>
  until(async () => e.starts.filter((s) => s.startsWith("article-")).length === n && true, `${n} article workers started`);

for (const via of ["cancelled", "budget_exceeded"] as const)
  test(`content tree: one story child ${via} while another succeeds -> digest keeps the survivor, marks the failure missing, seen excludes it`, {
    timeout: 20000,
  }, async () => {
    const e = await setup({ stories: 2 });
    try {
      await bothArticlesStarted(e);
      const victim = await storyChild(e, 102);
      // budget_exceeded is only observed at the story's next wake (attention()); the capture children's exit wakes it.
      if (via === "cancelled") await e.rt.daemon.cancel(victim.id, 0);
      else await e.rt.stores.mailbox.send(victim.id, { kind: "budget_exceeded" }, "story-budget");
      e.releaseCapture.resolve();
      e.releaseComment.resolve();
      const approval = await pendingPublish(e);
      await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "survivor only", "survivor-approve");
      const done = await terminal(e);
      assert.equal(done.exit, "succeeded", JSON.stringify(done.result));
      const result = done.result as Result;
      assert.deepEqual(
        result.stories.map((s) => s.story.id),
        [101],
      );
      assert.deepEqual(result.entryIds, [101]);
      assert.deepEqual(
        result.failedStories.map((f) => f.storyId),
        [102],
      );
      assert.match(result.reportBody, /Story 102: coordinator failed or returned invalid evidence/);
      assert.match(result.reportBody, /not marked seen/);
      assert.match(result.reportBody, /silent batch record loss/);
      assert.deepEqual(await seenOf(e), [101]);
    } finally {
      await e.cleanup();
    }
  });

test("content tree: budget_exceeded delivered to the root stops the run cleanly with nothing published or seen", { timeout: 20000 }, async () => {
  const e = await setup({ stories: 2 });
  try {
    await bothArticlesStarted(e);
    // attention() treats budget_exceeded like cancel/timeout: the root throws at its next wake (a story exit) -> failed exit.
    await e.rt.stores.mailbox.send(e.id, { kind: "budget_exceeded" }, "root-budget");
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const done = await terminal(e);
    assert.equal(done.exit, "failed");
    assert.equal((await e.rt.stores.approvals.list()).length, 0);
    await assertNothingPublished(e);
  } finally {
    await e.cleanup();
  }
});

test("content tree: cancellation while three story children are in flight publishes nothing and marks nothing seen", { timeout: 20000 }, async () => {
  const e = await setup({ stories: 3 });
  try {
    await bothArticlesStarted(e, 3);
    await e.rt.daemon.cancel(e.id, 0);
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const done = await terminal(e);
    assert.equal(done.exit, "cancelled");
    assert.ok(!e.starts.some((s) => s.startsWith("analysis-")));
    assert.equal((await e.rt.stores.approvals.list()).length, 0);
    await assertNothingPublished(e);
  } finally {
    await e.cleanup();
  }
});

test("content tree: cancellation during multi-story analysis publishes nothing and marks nothing seen", { timeout: 20000 }, async () => {
  const e = await setup({ stories: 2, holdAnalysis: true });
  try {
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    await e.analysisStarted.promise;
    await e.rt.daemon.cancel(e.id, 0);
    e.releaseAnalysis.resolve();
    const done = await terminal(e);
    assert.equal(done.exit, "cancelled");
    assert.equal((await e.rt.stores.approvals.list()).length, 0);
    await assertNothingPublished(e);
  } finally {
    await e.cleanup();
  }
});

test("content tree: a story whose analysis failed validation is published as unavailable but NOT marked seen", { timeout: 20000 }, async () => {
  const e = await setup({ stories: 2, invalidAnalysis: [102] });
  try {
    e.releaseCapture.resolve();
    e.releaseComment.resolve();
    const approval = await pendingPublish(e);
    await e.rt.daemon.decideApproval(approval.id, "approve", "operator", "one analysis unavailable", "partial-approve");
    const done = await terminal(e);
    assert.equal(done.exit, "succeeded", JSON.stringify(done.result));
    const result = done.result as Result;
    assert.equal(result.stories.length, 2, "both stories appear in the digest");
    assert.equal(result.stories.find((s) => s.story.id === 102)?.analysis, null);
    assert.match(result.reportBody, /Analysis unavailable: .*; not marked seen\./);
    // The retained rejection explains the failure without changing the digest line (exact line, not a prefix match).
    assert.ok(result.reportBody.split("\n").includes("Analysis unavailable: analysis evidence binding mismatch; not marked seen."));
    const rejected = result.stories.find((s) => s.story.id === 102)?.rejected;
    assert.equal(rejected?.failure, "analysis evidence binding mismatch");
    assert.equal(rejected?.rawTruncated, false);
    assert.deepEqual(rejected?.limits, { maxClaims: 4, maxBytes: 8192 });
    assert.ok((rejected?.outputBytes ?? 0) > 0, "output size is retained");
    assert.ok((rejected?.citations.length ?? 0) > 0, "verdicts are retained for each citation");
    assert.ok(rejected?.citations.every((c) => c.reason === "ok" && c.found));
    assert.equal(result.stories.find((s) => s.story.id === 101)?.rejected, undefined);
    assert.deepEqual(result.entryIds, [101]);
    assert.match(
      (done.result as { summary: string }).summary,
      /2 stories presented, 1 marked seen \(1 published without validated analysis, not marked seen\)/,
    );
    assert.deepEqual(await seenOf(e), [101]);
  } finally {
    await e.cleanup();
  }
});
