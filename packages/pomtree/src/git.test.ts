import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleArgs, bundleFailure, fetchArgs, gitTooOld, planBundle, pullPath, pushError } from "./git.ts";

const base = "a".repeat(40);

test("planBundle requires a full base commit and a branch", () => {
  assert.match((planBundle({ baseCommit: undefined, branch: undefined, current: "agent/x" }) as { message: string }).message, /POMTREE_BASE_COMMIT is not set/);
  assert.equal(planBundle({ baseCommit: "abc", branch: undefined, current: "agent/x" }).ok, false);
  assert.equal(planBundle({ baseCommit: base, branch: undefined, current: "HEAD" }).ok, false);
  assert.equal(planBundle({ baseCommit: base, branch: "-x", current: undefined }).ok, false);
  assert.deepEqual(planBundle({ baseCommit: base, branch: undefined, current: "agent/x" }), { ok: true, branch: "agent/x", base });
  assert.deepEqual(planBundle({ baseCommit: base, branch: "refs/heads/b", current: "agent/x" }), { ok: true, branch: "b", base });
});

test("bundle/fetch args and errors", () => {
  assert.deepEqual(bundleArgs("/t/b", "agent/x", base), ["bundle", "create", "/t/b", "refs/heads/agent/x", `^${base}`]);
  assert.match(bundleFailure("b", { code: 128, stdout: "", stderr: "fatal: Refusing to create empty bundle." }), /nothing to push/);
  assert.match(bundleFailure("b", { code: 128, stdout: "", stderr: "fatal: 'refs/heads/b' does not exist" }), /does not exist/);
  assert.ok(fetchArgs("/t/b").includes("+refs/agents/*:refs/remotes/pomtreed-agents/*"));
  assert.equal(pullPath(), "/v1/agents/self/pull");
  assert.equal(pullPath("a/b"), "/v1/agents/self/pull?from=a%2Fb");
});

test("pushError maps codes and statuses", () => {
  assert.match(pushError(413, { error: "too big", code: "too_large" }), /too large/);
  assert.match(pushError(422, { error: "x", code: "prerequisite" }), /prerequisite.*does not have/);
  assert.match(pushError(409, { error: "stale" }), /stale generation/);
  assert.equal(pushError(500, null), "HTTP 500");
});

test("gitTooOld enforces 2.38", () => {
  assert.equal(gitTooOld("git version 2.38.0"), null);
  assert.equal(gitTooOld("git version 2.54.0 (Apple Git-157)"), null);
  assert.match(gitTooOld("git version 2.30.1")!, /too old/);
});
