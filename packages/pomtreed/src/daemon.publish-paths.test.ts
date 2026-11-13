import assert from "node:assert/strict";
import { test } from "node:test";
import { runningAgent, setup } from "./test-setup.ts";
import type { PublishReview } from "@pomtree/core";

test("publish fails closed when the pin carries no path list, and still publishes when it carries an empty one", async () => {
  const pushed: string[] = [];
  const publisher = (paths: string[]) => ({
    allowedTargets: ["origin/main"],
    requireApproval: false,
    resolve: async () => ({ sha: "abc123def456", summary: "s", paths, exclude: [] }),
    push: async (_a: string, _b: string, _t: string, sha: string) => void pushed.push(sha),
  });

  // `paths` is required by the type: a resolver that omits it does not compile. The runtime guard
  // still covers an untyped (JS) caller, which is what the ts-expect-error resolver simulates.
  const bad = setup(async () => {}, {
    publisher: {
      ...publisher([]),
      // @ts-expect-error `paths` is required in the publisher resolve return type
      resolve: async () => ({ sha: "abc123def456", summary: "s" }),
    },
  });
  const a = await runningAgent(bad, "a");
  const req = { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "k" };
  await assert.rejects(bad.daemon.publish(a.id, req), (e: { status?: number }) => e.status === 409);
  assert.deepEqual(pushed, []);

  const good = setup(async () => {}, { publisher: publisher([]) });
  const b = await runningAgent(good, "b");
  await good.daemon.publish(b.id, { branch: `agent/${b.id}`, target: "origin/main", idempotencyKey: "k" });
  assert.deepEqual(pushed, ["abc123def456"]);
});

test("publish.deny reaches the publish check through the publisher (default denylist, replaced, or emptied)", async () => {
  const pushed: string[] = [];
  const publisher = (deniedPaths?: readonly string[]) => ({
    allowedTargets: ["origin/main"],
    requireApproval: false,
    resolve: async () => ({ sha: "abc123def456", summary: "s", paths: [".github/workflows/ci.yml", "docs/x.md"], exclude: [] }),
    push: async (_a: string, _b: string, _t: string, sha: string) => void pushed.push(sha),
    ...(deniedPaths !== undefined && { deniedPaths }),
  });
  const publishAs = async (t: ReturnType<typeof setup>, key: string) => {
    const a = await runningAgent(t, key);
    return t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: key });
  };
  // Absent: DEFAULT_DENIED_PATHS refuses the CI file.
  await assert.rejects(
    publishAs(
      setup(async () => {}, { publisher: publisher() }),
      "a",
    ),
    /denied path \.github\/workflows\/ci\.yml/,
  );
  // A replacement list applies instead of the default.
  await assert.rejects(
    publishAs(
      setup(async () => {}, { publisher: publisher(["docs/"]) }),
      "b",
    ),
    /denied path docs\/x\.md/,
  );
  // Empty: no denylist.
  await publishAs(
    setup(async () => {}, { publisher: publisher([]) }),
    "c",
  );
  assert.deepEqual(pushed, ["abc123def456"]);
});

test("publish fails closed with a 409 naming the action when the pin carries no review boundary, and hands the pin's exclude to the push", async () => {
  const pushed: { sha: string; reviewed: PublishReview }[] = [];
  const TIP = "c".repeat(40);
  const publisher = (exclude: unknown) => ({
    allowedTargets: ["origin/main"],
    requireApproval: false,
    // `exclude` is required by the type; the unknown-typed stub simulates an untyped or stale resolver
    resolve: async () => ({ sha: "abc123def456", summary: "s", paths: [], exclude: exclude as string[] }),
    push: async (_a: string, _b: string, _t: string, sha: string, reviewed: PublishReview) => void pushed.push({ sha, reviewed }),
  });
  for (const bad of [undefined, "main", [1]]) {
    const t = setup(async () => {}, { publisher: publisher(bad) });
    const a = await runningAgent(t, "a");
    await assert.rejects(
      t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "k" }),
      (e: { status?: number; message?: string }) => e.status === 409 && /no review boundary \(exclude\).*request the publish again/.test(e.message ?? ""),
      String(bad),
    );
  }
  assert.deepEqual(pushed, []);
  for (const exclude of [[], [TIP]]) {
    const t = setup(async () => {}, { publisher: publisher(exclude) });
    const a = await runningAgent(t, "a");
    await t.daemon.publish(a.id, { branch: `agent/${a.id}`, target: "origin/main", idempotencyKey: "k" });
  }
  assert.deepEqual(pushed, [
    { sha: "abc123def456", reviewed: { exclude: [] } },
    { sha: "abc123def456", reviewed: { exclude: [TIP] } },
  ]);
});
