import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, run } from "./cli.ts";
import type { Reply } from "./client.ts";
import { pushError } from "./git.ts";
import { harness as baseHarness } from "./test-kit.ts";

// An empty env so the host environment cannot leak into the CLI under test.
const harness: typeof baseHarness = (handler, extra = {}) => baseHarness(handler, { env: {}, ...extra });

const reply = (status: number, body: unknown) => () => ({ status, body }) as Reply;

test("merge success posts {child} with a key and prints the commit", async () => {
  const h = harness(reply(200, { ok: true, commit: "abc123", target: "agent/p1" }));
  assert.equal(await run(["merge", "c1"], h.io), EXIT.ok);
  const c = h.calls[0]!;
  assert.equal(c.method, "POST");
  assert.match(c.path, /^\/v1\/agents\/self\/merge\?key=[^&]+$/);
  assert.deepEqual(c.body, { child: "c1" });
  assert.match(h.out.join("\n"), /merged c1 into agent\/p1 at abc123/);
  assert.match(h.out.join("\n"), /pomtree pull/);
});

test("merge --into and --key are sent; a retry with --key reuses the key, otherwise keys differ", async () => {
  const h = harness(reply(200, { ok: true, commit: "abc", target: "agent/p1/x" }));
  await run(["merge", "c1", "--into", "agent/p1/x", "--key", "k9"], h.io);
  await run(["merge", "c1", "--into", "agent/p1/x", "--key", "k9"], h.io);
  assert.equal(h.calls[0]!.path, "/v1/agents/self/merge?key=k9");
  assert.deepEqual(h.calls[0]!.body, { child: "c1", into: "agent/p1/x" });
  assert.deepEqual(h.calls[1], h.calls[0]);
  await run(["merge", "c1"], h.io);
  await run(["merge", "c1"], h.io);
  assert.notEqual(h.calls[2]!.path, h.calls[3]!.path);
});

test("merge conflict prints the paths and exits 5, on 200 or 409", async () => {
  for (const status of [200, 409]) {
    const h = harness(reply(status, { ok: false, code: "conflict", paths: ["a.txt", "dir/b.ts"] }));
    assert.equal(await run(["merge", "c1"], h.io), 5);
    assert.match(h.err.join("\n"), /a\.txt\n\s+dir\/b\.ts/);
  }
});

test("merge maps check_failed, approval_required, moved, escalated to distinct exit codes", async () => {
  const cases: [unknown, number, RegExp][] = [
    [{ ok: false, code: "check_failed", error: "tests red" }, 8, /check failed: tests red/],
    [{ ok: false, code: "policy_rejected", reason: "approval_required" }, 9, /awaits the user's approval/],
    [{ ok: false, code: "moved" }, 10, /moved/],
    [{ ok: false, code: "escalated" }, 11, /Stop trying/],
  ];
  const seen = new Set<number>([5]);
  for (const [body, code, re] of cases) {
    const h = harness(reply(409, body));
    assert.equal(await run(["merge", "c1"], h.io), code);
    assert.match(h.err.join("\n"), re);
    seen.add(code);
  }
  assert.equal(seen.size, 5);
});

test("merge --json prints the daemon body and keeps the exit code", async () => {
  const body = { ok: false, code: "conflict", paths: ["a"] };
  const h = harness(reply(409, body));
  assert.equal(await run(["merge", "c1", "--json"], h.io), 5);
  assert.deepEqual(JSON.parse(h.out[0]!), body);
});

test("merge maps 403 to denied, 404 to not found, plain errors by status", async () => {
  assert.equal(await run(["merge", "c1"], harness(reply(403, { error: "forbidden" })).io), EXIT.denied);
  assert.equal(await run(["merge", "c1"], harness(reply(404, { error: "no such agent" })).io), EXIT.notFound);
  assert.equal(await run(["merge", "c1"], harness(reply(500, { error: "boom" })).io), EXIT.error);
});

test("merge usage errors make no call", async () => {
  const none = harness(reply(200, {}));
  assert.equal(await run(["merge"], none.io), EXIT.usage);
  assert.equal(await run(["merge", "c1", "--into"], none.io), EXIT.usage);
  assert.equal(await run(["merge", "--key", "k"], none.io), EXIT.usage);
  assert.equal(none.calls.length, 0);
});

test("agent help lists merge and resume and documents push --force", async () => {
  const h = harness(reply(200, {}));
  await run(["--help"], h.io);
  const t = h.out.join("\n");
  assert.match(t, /whoami, ext, push, pull, merge, resume,/);
  assert.match(t, /push \[--branch NAME\] \[--force\]/);
  assert.match(t, /merge CHILD \[--into BRANCH\]/);
});

test("pushError maps non_fast_forward to a pull-and-merge hint", () => {
  const m = pushError(409, { code: "non_fast_forward", error: "x" });
  assert.match(m, /non_fast_forward/);
  assert.match(m, /pomtree pull/);
  assert.match(m, /merge or rebase and push again/);
  assert.doesNotMatch(m, /--force/, "agents are not offered the operator-only --force");
});

test("self-merge: --into without a child omits child; approval and conflict messages fit", async () => {
  const h = harness(reply(200, { ok: true, commit: "abc", target: "main" }));
  assert.equal(await run(["merge", "--into", "main", "--key", "k1"], h.io), EXIT.ok);
  assert.equal(h.calls[0]!.path, "/v1/agents/self/merge?key=k1");
  assert.deepEqual(h.calls[0]!.body, { into: "main" });
  assert.match(h.out.join("\n"), /merged your branch into main/);
  const ap = harness(reply(409, { ok: false, code: "policy_rejected", reason: "approval_required", approval: "x" }));
  assert.equal(await run(["merge", "--into", "main", "--key", "k1"], ap.io), 9);
  assert.match(ap.err.join("\n"), /awaits the user's approval/);
  assert.match(ap.err.join("\n"), /pomtree merge --into main --key k1/);
  const cf = harness(reply(409, { ok: false, code: "conflict", paths: ["a"] }));
  assert.equal(await run(["merge", "--into", "main"], cf.io), 5);
  assert.match(cf.err.join("\n"), /pomtree pull, git merge the default branch/);
  const none = harness(reply(409, { code: "nothing_to_merge", error: "nothing pushed" }));
  assert.equal(await run(["merge", "--into", "main"], none.io), EXIT.conflict);
  assert.match(none.err.join("\n"), /nothing pushed/);
});

test("policy rejections other than approval_required exit 12 without a retry hint; key_reuse exits 2", async () => {
  const dp = harness(reply(409, { ok: false, code: "policy_rejected", reason: "denied_path", paths: [".github/ci.yml"] }));
  assert.equal(await run(["merge", "c1", "--key", "k"], dp.io), 12);
  assert.match(dp.err.join("\n"), /denied_path[\s\S]*\.github\/ci\.yml[\s\S]*will not succeed on retry/);
  assert.doesNotMatch(dp.err.join("\n"), /retry later/);
  const br = harness(reply(409, { ok: false, code: "policy_rejected", reason: "bad_ref", ref: "refs/x" }));
  assert.equal(await run(["merge", "c1"], br.io), 12);
  assert.match(br.err.join("\n"), /bad_ref[\s\S]*refs\/x/);
  const ap = harness(reply(409, { ok: false, code: "policy_rejected", reason: "approval_required" }));
  assert.equal(await run(["merge", "--into", "main", "--key", "k"], ap.io), 9);
  assert.match(ap.err.join("\n"), /retry later with/);
  const kr = harness(reply(409, { code: "key_reuse", error: "x" }));
  assert.equal(await run(["merge", "c1", "--key", "k"], kr.io), EXIT.usage);
  assert.match(kr.err.join("\n"), /omit --key/);
});
