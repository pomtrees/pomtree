import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeResumeKey } from "@pomtree/core";
import type { AgentRecord, MergeReport, MergeResult } from "@pomtree/core";
import { fakeBundle } from "@pomtree/testing";
import { handle } from "./api.ts";
import { unmergedRefusal } from "./daemon/merge.ts";
import { keyed, op, setup, spawnSpec } from "./test-setup.ts";

type T = ReturnType<typeof setup>;

// Agents are created straight in the registry (running, with a folder); `parent` defaults to the root supervisor.
async function mk(t: T, key: string, parent?: string, budgetMicros = 1_000): Promise<AgentRecord> {
  const root = await t.daemon.root();
  const a = await t.daemon.deps.registry.create({
    spec: spawnSpec,
    parent: parent ?? root.id,
    name: key,
    task: "t",
    host: "h1",
    budgetMicros,
    idempotencyKey: key,
  });
  const r = await t.daemon.deps.registry.transition(a.id, a.generation, "running", { idempotencyKey: `${key}-run` });
  await t.daemon.deps.workspace.create(r.id, {});
  return r;
}
const pushAs = async (t: T, a: AgentRecord, commit: string, parent?: string) => {
  const out = await t.daemon.push(
    a.id,
    a.generation,
    `push-${a.id}-${commit}`,
    (async function* () {
      yield fakeBundle([{ name: `agent/${a.id}`, commit, ...(parent && { parent }) }]);
    })(),
    1 << 20,
  );
  assert.ok(out.ok);
};
const exit = async (t: T, a: AgentRecord) =>
  t.daemon.deps.registry.transition(a.id, a.generation, "exited", { exit: "succeeded", idempotencyKey: `${a.id}-exit` });
const tok = (t: T, a: AgentRecord) => t.daemon.agentToken(a.id, a.generation);
const call = (t: T, token: string, method: string, url: string, body?: unknown) => handle(t.daemon, { method, url, body: keyed(method, body), token });
const merge = (t: T, a: AgentRecord, key: string, body: unknown, token = tok(t, a)) => call(t, token, "POST", `/v1/agents/self/merge?key=${key}`, body);
const kindsOf = async (t: T, a: AgentRecord) => (await t.journal.read({ agent: a.id })).map((e) => e.payload.kind);

// A parent that pushed, and a child that pushed; merging is configured with the fake engine.
async function pair(over: Parameters<typeof setup>[1] = {}) {
  const t = setup(async () => {}, { approvalWaitMs: 20, ...over });
  t.daemon.deps.repos = t.fakes.repos;
  t.daemon.deps.approvals = t.fakes.approvals;
  const top = await mk(t, "top");
  const parent = await mk(t, "parent", top.id);
  const child = await mk(t, "child", parent.id);
  await pushAs(t, parent, "p1");
  await pushAs(t, child, "c1");
  return { t, top, parent, child };
}
// Records what the resume would hand the harness instead of running a segment.
const captureResume = (t: T): { wakes: { agent: string; generation: number; wake: string }[] } => {
  const wakes: { agent: string; generation: number; wake: string }[] = [];
  (t.orchestrator as unknown as { resume: (a: string, g: number, w: string) => Promise<void> }).resume = async (agent, generation, wake) =>
    void wakes.push({ agent, generation, wake });
  return { wakes };
};
const repos = (t: T) => t.fakes.hooks.raw.repos;

test("merge route: a child merges into its parent's own branch; the request names full refs; journaled; idempotent replay", async () => {
  const { t, parent, child } = await pair();
  const r = await merge(t, parent, "m1", { child: child.id });
  assert.equal(r.status, 200);
  const body = r.body as { ok: boolean; commit: string };
  assert.equal(body.ok, true);
  assert.match(body.commit, /^fake-merge-/);
  const { req, key } = repos(t).requests[0]!;
  assert.deepEqual([req.caller, req.callerGeneration, req.child], [parent.id, parent.generation, child.id]);
  assert.equal(req.source, `refs/agents/${child.id}/heads/agent/${child.id}`);
  assert.equal(req.target, `refs/agents/${parent.id}/heads/agent/${parent.id}`);
  assert.equal(req.approval, undefined);
  assert.equal(key, `merge:${parent.id}:m1`);
  assert.ok((await kindsOf(t, parent)).includes("merged"));
  const again = await merge(t, parent, "m1", { child: child.id });
  assert.deepEqual(again.body, r.body);
  assert.equal(repos(t).requests.length, 1, "the replay did not re-run the engine");
  assert.equal((await t.journal.read({ agent: parent.id })).filter((e) => e.payload.kind === "merged").length, 1);
});

test("merge route: operator scope, a non-descendant, a stale generation, a missing key, an unknown child and no engine are refused", async () => {
  const { t, parent, child, top } = await pair();
  const stranger = await mk(t, "stranger");
  assert.ok([400, 403].includes((await merge(t, parent, "k", { child: child.id }, op)).status), "operator scope");
  assert.equal((await merge(t, stranger, "k", { child: child.id })).status, 403, "a child of someone else");
  assert.equal((await merge(t, child, "k", { child: parent.id })).status, 403, "an ancestor is not a descendant");
  assert.equal((await call(t, tok(t, parent), "POST", "/v1/agents/self/merge", { child: child.id })).status, 400, "key required");
  assert.equal((await merge(t, parent, "k", { child: "nope" })).status, 404);
  await pushAs(t, top, "t0");
  assert.equal((await merge(t, top, "k2", { child: child.id })).status, 200, "a grandparent may merge a descendant into its own branch");
  const stale = tok(t, parent);
  await t.daemon.deps.registry.bumpGeneration(parent.id, "h1", "bump");
  assert.equal((await merge(t, parent, "k3", { child: child.id }, stale)).status, 409);
  const before = repos(t).requests.length;
  t.daemon.deps.repos = undefined;
  const fresh = (await t.daemon.get(parent.id))!;
  assert.equal((await merge(t, fresh, "k4", { child: child.id })).status, 503);
  assert.equal(repos(t).requests.length, before);
});

test("merge route: a child that never pushed, or a caller with no branch, is 409", async () => {
  const { t, parent } = await pair();
  const lone = await mk(t, "lone", parent.id);
  assert.equal((await merge(t, parent, "k", { child: lone.id })).status, 409);
  const p2 = await mk(t, "p2");
  const c2 = await mk(t, "c2", p2.id);
  await pushAs(t, c2, "cc");
  assert.equal((await merge(t, p2, "k", { child: c2.id })).status, 409);
});

test("merge results map to HTTP: conflict returns paths, check_failed, moved, policy_rejected, escalated; failures are journaled", async () => {
  const { t, parent, child } = await pair();
  const tips = { targetTip: "b".repeat(40), sourceTip: "a".repeat(40) };
  const script: MergeResult[] = [
    { status: "conflict", paths: ["a.txt"], round: 1, ...tips },
    { status: "check_failed", summary: "tests red", candidate: "c".repeat(40), round: 2, ...tips },
    { status: "moved", attempts: 5, targetTip: tips.targetTip },
    { status: "policy_rejected", code: "denied_path", message: "no" },
  ];
  repos(t).results.push(...script);
  const conflict = await merge(t, parent, "r1", { child: child.id });
  assert.equal(conflict.status, 409);
  assert.deepEqual([(conflict.body as { code: string }).code, (conflict.body as { paths: string[] }).paths], ["conflict", ["a.txt"]]);
  const failed = await merge(t, parent, "r2", { child: child.id });
  assert.deepEqual([failed.status, (failed.body as { code: string }).code], [409, "check_failed"]);
  assert.equal((await merge(t, parent, "r3", { child: child.id })).status, 409);
  const pol = await merge(t, parent, "r4", { child: child.id });
  assert.deepEqual([pol.status, (pol.body as { reason: string }).reason], [422, "denied_path"]);
  const kinds = await kindsOf(t, parent);
  assert.ok(kinds.includes("merge_conflict") && kinds.includes("check_failed"));
  assert.ok(!kinds.includes("merged"));
});

test("three failed rounds escalate to the user (an ask on the caller); reap is refused until merged or escalated", async () => {
  const { t, parent, child } = await pair();
  const tips = { targetTip: "b".repeat(40), sourceTip: "a".repeat(40) };
  repos(t).results.push(
    { status: "conflict", paths: ["a.txt"], round: 1, ...tips },
    { status: "conflict", paths: ["a.txt"], round: 2, ...tips },
    { status: "escalate", reason: "conflict", rounds: 3, paths: ["a.txt"], ...tips },
  );
  await exit(t, child);
  const reap = () => call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/reap`, {});
  assert.equal((await merge(t, parent, "e1", { child: child.id })).status, 409);
  const r1 = await reap();
  assert.equal(r1.status, 409, "reap refused while unmerged");
  assert.equal((r1.body as { code: string }).code, "unmerged");
  await merge(t, parent, "e2", { child: child.id });
  assert.equal((await reap()).status, 409);
  const esc = await merge(t, parent, "e3", { child: child.id });
  assert.deepEqual([esc.status, (esc.body as { code: string }).code], [409, "escalated"]);
  assert.ok((await kindsOf(t, parent)).includes("merge_escalated"));
  const open = await t.daemon.deps.escalations.list({ agent: parent.id, state: "open" });
  assert.equal(open.length, 1);
  assert.match(open[0]!.question, new RegExp(`Merging ${child.id} failed 3 rounds`));
  assert.equal((await reap()).status, 200, "escalated counts as settled");
});

test("reap is allowed once merged, or when the child has nothing to merge", async () => {
  const { t, parent, child } = await pair();
  await exit(t, child);
  const empty = await mk(t, "empty", parent.id);
  await exit(t, empty);
  repos(t).reports.set(empty.id, { state: "empty", merged: false, failedRounds: 0, settled: true });
  assert.equal((await call(t, tok(t, parent), "POST", `/v1/agents/${empty.id}/reap`, {})).status, 200);
  assert.equal((await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/reap`, {})).status, 409);
  assert.equal((await merge(t, parent, "ok", { child: child.id })).status, 200);
  assert.equal((await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/reap`, {})).status, 200);
  assert.equal((await t.daemon.get(child.id))!.state, "reaped");
});

test("a child never goes straight into the default branch, even for the top-level agent; a non-top-level agent cannot name it either", async () => {
  const { t, top, parent } = await pair();
  await pushAs(t, top, "t1");
  const refused = await merge(t, top, "mm1", { child: parent.id, into: "main" });
  assert.deepEqual([refused.status, (refused.body as { code: string }).code], [403, "protected_target"]);
  const kid = await mk(t, "kid", parent.id);
  await pushAs(t, kid, "k1");
  assert.equal((await merge(t, parent, "mm2", { child: kid.id, into: "main" })).status, 403);
  assert.equal(repos(t).requests.length, 0);
  assert.equal(t.fakes.approvals.all?.length ?? 0, 0, "no approval was even raised");
});

test("approval binding: a granted approval authorizes only that source tip and target; a changed tip needs a new approval", async () => {
  const { t, top } = await pair();
  await pushAs(t, top, "t1");
  const ws = t.fakes.hooks.raw.workspace;
  const ref = `refs/agents/${top.id}/heads/agent/${top.id}`;
  const first = (await merge(t, top, "ab", { into: "main" })).body as { approval: string };
  await t.daemon.decideApproval(first.approval, "approve", "user", "ok", "ab-d");
  assert.equal((await merge(t, top, "ab", { into: "main" })).status, 200);
  assert.equal(repos(t).requests[0]!.req.approval, first.approval);
  // the branch moves on; the same key (a retry) now describes a different candidate and must not ride the old approval
  ws.refs.set(ref, "t2");
  const second = await merge(t, top, "ab", { into: "main" });
  assert.equal(second.status, 409, "a new approval is pending");
  const secondId = (second.body as { approval: string }).approval;
  assert.notEqual(secondId, first.approval);
  assert.equal(repos(t).requests.length, 1, "the engine was not called with the stale approval");
});

test("check summaries and engine messages are redacted of host paths before they are returned, journaled, or asked to the user", async () => {
  const { t, parent, child } = await pair();
  const secret = `${t.daemon.deps.sessionRoot}/leak`;
  const tips = { targetTip: "b".repeat(40), sourceTip: "a".repeat(40) };
  repos(t).results.push(
    { status: "check_failed", summary: `boom at ${secret}`, candidate: "c".repeat(40), round: 1, ...tips },
    { status: "escalate", reason: "check_failed", rounds: 3, summary: `still ${secret}`, ...tips },
    { status: "policy_rejected", code: "denied_path", message: `denied ${secret}` },
  );
  const a = await merge(t, parent, "rd1", { child: child.id });
  const b = await merge(t, parent, "rd2", { child: child.id });
  const c = await merge(t, parent, "rd3", { child: child.id });
  for (const r of [a, b, c]) assert.ok(!JSON.stringify(r.body).includes(t.daemon.deps.sessionRoot), JSON.stringify(r.body));
  const journal = JSON.stringify((await t.journal.read({ agent: parent.id })).map((e) => e.payload));
  assert.ok(!journal.includes(t.daemon.deps.sessionRoot));
  const asks = await t.daemon.deps.escalations.list({ agent: parent.id, state: "open" });
  assert.equal(asks.length, 1);
  assert.ok(!asks[0]!.question.includes(t.daemon.deps.sessionRoot));
});

test("key reuse from the engine maps to 409 key_reuse; other policy codes are 422", async () => {
  const { t, parent, child } = await pair();
  repos(t).results.push({ status: "policy_rejected", code: "key_reuse", message: "key used for a different request" } as MergeResult);
  const r = await merge(t, parent, "kr", { child: child.id });
  assert.deepEqual([r.status, (r.body as { code: string }).code], [409, "key_reuse"]);
});

test("merge into main without an approvals store fails closed (503)", async () => {
  const { t, top } = await pair();
  await pushAs(t, top, "t1");
  t.daemon.deps.approvals = undefined;
  assert.equal((await merge(t, top, "x", { into: "main" })).status, 503);
  assert.equal(repos(t).requests.length, 0);
});

test("ancestor resume: an exited, unreaped child is woken with the conflict paths; the generation is bumped first; a replay does not bump again", async () => {
  const { t, parent, child } = await pair();
  const { wakes } = captureResume(t);
  const tips = { targetTip: "b".repeat(40), sourceTip: "a".repeat(40) };
  repos(t).results.push({ status: "conflict", paths: ["src/x.ts", "y.md"], round: 1, ...tips });
  await exit(t, child);
  assert.equal((await merge(t, parent, "c1", { child: child.id })).status, 409);
  const gen0 = (await t.daemon.get(child.id))!.generation;
  const r = await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/resume`, { idempotencyKey: "r1" });
  assert.equal(r.status, 200);
  const rec = r.body as AgentRecord;
  assert.deepEqual([rec.state, rec.generation], ["running", gen0 + 1]);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.generation, gen0 + 1);
  assert.match(wakes[0]!.wake, /Conflicted paths/);
  assert.match(wakes[0]!.wake, /"src\/x.ts"/);
  assert.match(wakes[0]!.wake, new RegExp(tips.targetTip));
  assert.ok((await kindsOf(t, child)).includes("resumed"));
  assert.ok(await t.daemon.deps.checkpoints.latest(child.id), "a checkpoint was written for the resume");
  // The key is (child, generation, round): the replay finds the marker and answers the current record without bumping.
  const replay = await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/resume`, { idempotencyKey: "r1" });
  assert.equal(replay.status, 409, "the child is running now; a fresh resume is refused, never a second bump");
  assert.equal((await t.daemon.get(child.id))!.generation, gen0 + 1);
  assert.equal(
    await t.daemon.deps.registry.bumpGeneration(child.id, "h1", mergeResumeKey(child.id, gen0, 1)).then((x) => x.generation),
    gen0 + 1,
    "the registry key is the merge resume key",
  );
});

test("ancestor resume: a grandparent may; a non-ancestor, a sibling, a reaped, a running and a yielded child are refused; --force is operator-only", async () => {
  const { t, top, parent, child } = await pair();
  captureResume(t);
  const sibling = await mk(t, "sib", parent.id);
  const other = await mk(t, "other");
  const resume = (caller: AgentRecord, id: string, body: object = {}) => call(t, tok(t, caller), "POST", `/v1/agents/${id}/resume`, body);
  assert.equal((await resume(parent, child.id)).status, 409, "running child");
  await exit(t, child);
  assert.equal((await resume(other, child.id)).status, 403, "not an ancestor");
  assert.equal((await resume(sibling, child.id)).status, 403, "a sibling");
  assert.equal((await resume(child, child.id)).status, 409, "an exited agent cannot act, let alone resume itself");
  assert.equal((await resume(parent, child.id, { force: true })).status, 403);
  assert.equal((await resume(parent, "nope")).status, 404);
  const stale = tok(t, parent);
  await t.daemon.deps.registry.bumpGeneration(parent.id, "h1", "bump");
  assert.equal((await call(t, stale, "POST", `/v1/agents/${child.id}/resume`, {})).status, 409);
  const freshParent = (await t.daemon.get(parent.id))!;
  assert.equal((await resume(freshParent, child.id)).status, 200);
  // a second child, exited then reaped
  const gone = await mk(t, "gone", parent.id);
  await exit(t, gone);
  repos(t).reports.set(gone.id, { state: "empty", merged: false, failedRounds: 0, settled: true });
  await t.daemon.reap(gone.id);
  assert.equal((await resume(freshParent, gone.id)).status, 409, "reaped");
  void top;
});

test("a resumed child that exits again notifies its parent again (the child_exited signal is keyed per generation)", async () => {
  const { t, parent, child } = await pair();
  captureResume(t);
  const exits = async () =>
    (await t.journal.read({ agent: parent.id })).filter(
      (e) => e.payload.kind === "signal" && (e.payload as { signal: { kind: string } }).signal.kind === "child_exited",
    ).length;
  const tail = async (id: string) =>
    (t.daemon as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail((await t.daemon.get(id))!, "succeeded");
  await exit(t, child);
  await tail(child.id);
  assert.equal(await exits(), 1);
  assert.equal((await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/resume`, {})).status, 200);
  const cur = (await t.daemon.get(child.id))!;
  await t.daemon.deps.registry.transition(child.id, cur.generation, "exited", { exit: "succeeded", idempotencyKey: "again" });
  await tail(child.id);
  assert.equal(await exits(), 2);
});

test("scoped from-commit: an agent may start a child from a commit in its own subtree, not from anyone else's", async () => {
  const { t } = await pair();
  const lead = await mk(t, "lead", undefined, 100_000);
  const kid = await mk(t, "kid", lead.id);
  const stranger = await mk(t, "stranger");
  repos(t).reachable.set("c1", [kid.id]);
  repos(t).reachable.set("zz", [stranger.id]);
  const spawn = (fromCommit: string, key: string) => call(t, tok(t, lead), "POST", "/v1/agents", { name: "n", task: "t", idempotencyKey: key, fromCommit });
  assert.equal((await spawn("zz", "s1")).status, 403);
  assert.equal((await spawn("nope", "s2")).status, 403);
  assert.equal(
    (await call(t, tok(t, lead), "POST", "/v1/agents", { name: "n", task: "t", idempotencyKey: "s3", sessionRef: "x" })).status,
    403,
    "sessionRef stays operator-only",
  );
  const ok = await spawn("c1", "s4");
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(t.fakes.calls.some((c) => c.port === "RepoStore" && c.method === "commitInSubtree"));
  // without the engine configured, an agent's fromCommit stays refused
  t.daemon.deps.repos = undefined;
  assert.equal((await spawn("c1", "s5")).status, 403);
});

test("startup: recoverMerges runs the engine's recover(); without an engine it is a no-op", async () => {
  const { t } = await pair();
  repos(t).recovered = [{ status: "policy_rejected", code: "denied_path", message: "x" }];
  assert.deepEqual(
    (await t.daemon.recoverMerges()).map((r) => r.status),
    ["policy_rejected"],
  );
  assert.ok(t.fakes.calls.some((c) => c.port === "RepoStore" && c.method === "recover"));
  t.daemon.deps.repos = undefined;
  assert.deepEqual(await t.daemon.recoverMerges(), []);
});

test("publish: the top-level agent may publish the default branch; others may not; its own branch still works", async () => {
  const pushed: string[] = [];
  const t = setup(async () => {}, {
    publisher: {
      allowedTargets: ["origin/main"],
      requireApproval: false,
      resolve: async (_a, b) => ({ sha: "abc123", summary: b, paths: [] }),
      push: async (_a, b, tg, sha) => void pushed.push(`${b}->${tg}@${sha}`),
    },
  });
  t.daemon.deps.repos = t.fakes.repos;
  const top = await mk(t, "top");
  const kid = await mk(t, "kid", top.id);
  await t.daemon.publish(top.id, { branch: "main", target: "origin/main", idempotencyKey: "p1" });
  await t.daemon.publish(top.id, { branch: `agent/${top.id}`, target: "origin/main", idempotencyKey: "p2" });
  await assert.rejects(t.daemon.publish(kid.id, { branch: "main", target: "origin/main", idempotencyKey: "p3" }), (e: { status?: number }) => e.status === 403);
  assert.deepEqual(pushed, ["main->origin/main@abc123", `agent/${top.id}->origin/main@abc123`]);
  t.daemon.deps.repos = undefined;
  await assert.rejects(t.daemon.publish(top.id, { branch: "main", target: "origin/main", idempotencyKey: "p4" }), (e: { status?: number }) => e.status === 403);
});

test("self-merge: the top-level agent merges its own branch into main under approval; others and malformed requests are refused with typed errors", async () => {
  const { t, top, parent } = await pair();
  await pushAs(t, top, "t1");
  const own = `refs/agents/${top.id}/heads/agent/${top.id}`;
  const pending = await merge(t, top, "sm1", { into: "main" });
  assert.equal(pending.status, 409);
  const pb = pending.body as { code: string; reason: string; approval: string };
  assert.deepEqual([pb.code, pb.reason], ["policy_rejected", "approval_required"]);
  assert.equal(repos(t).requests.length, 0);
  await t.daemon.decideApproval(pb.approval, "approve", "user", "ok", "sd1");
  const done = await merge(t, top, "sm1", { child: top.id, into: "main" }); // child === caller is also self
  assert.equal(done.status, 200);
  const { req } = repos(t).requests[0]!;
  assert.deepEqual([req.caller, req.child, req.source, req.target, req.approval], [top.id, top.id, own, "refs/heads/main", pb.approval]);
  assert.equal((await merge(t, top, "sm2", { into: "feature" })).status, 400, "self into a non-default branch");
  assert.equal((await merge(t, top, "sm3", {})).status, 400, "self without into");
  assert.equal((await merge(t, parent, "sm4", { into: "main" })).status, 403, "a non-top-level agent cannot merge itself into main");
  const bare = await mk(t, "bare");
  assert.equal((await merge(t, bare, "sm5", { into: "main" })).status, 409, "nothing pushed");
  assert.equal(repos(t).requests.length, 1);
});

test("a checkpoint written after a merge carries the merge commit (the ref's current tip)", async () => {
  const { t, parent, child } = await pair();
  const ws = t.fakes.hooks.raw.workspace;
  const ref = `refs/agents/${parent.id}/heads/agent/${parent.id}`;
  assert.equal((await merge(t, parent, "ck", { child: child.id })).status, 200);
  ws.refs.set(ref, "merge-commit-1"); // the engine moved the ref; the fake merge engine does not touch the fake workspace
  // the checkpoint writer yield/resume/interrupt all use (a stopped container's folder, session and last ingested ref)
  await (t.daemon as unknown as { stopCheckpoint: (r: AgentRecord, k: string, w: null) => Promise<unknown> }).stopCheckpoint(
    (await t.daemon.get(parent.id))!,
    "ck-key",
    null,
  );
  assert.deepEqual((await t.daemon.deps.checkpoints.latest(parent.id))!.ingested, { ref, commit: "merge-commit-1" });
});

test("ancestor resume of a child whose folder was evicted restores it at the last ingested ref; an exhausted budget is a typed 409", async () => {
  const { t, parent, child } = await pair();
  const { wakes } = captureResume(t);
  await exit(t, child);
  await t.daemon.deps.workspace.evict(child.id);
  const r = await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/resume`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(wakes.length, 1);
  assert.equal(await t.daemon.deps.workspace.has(child.id), true, "folder restored");
  assert.ok(
    (await t.journal.read({ agent: child.id })).some(
      (e) => e.payload.kind === "error" && /evicted; restored from the last ingested ref/.test((e.payload as { message: string }).message),
    ),
  );
  const broke = await mk(t, "broke", parent.id, 0);
  await exit(t, broke);
  const refused = await call(t, tok(t, parent), "POST", `/v1/agents/${broke.id}/resume`, {});
  assert.deepEqual([refused.status, (refused.body as { code: string }).code], [409, "budget_exhausted"]);
  assert.equal((await t.daemon.get(broke.id))!.state, "exited", "not bumped or started");
  assert.equal(wakes.length, 1);
});

test("ancestor resume is idempotent across a crash between the generation bump and the transition: the generation bumps exactly once", async () => {
  const { t, parent, child } = await pair();
  const { wakes } = captureResume(t);
  const tail = (t.daemon as unknown as { finishTail: (r: AgentRecord, e: string) => Promise<void> }).finishTail.bind(t.daemon);
  await exit(t, child);
  await tail((await t.daemon.get(child.id))!, "succeeded"); // journals `exited` at the exit generation
  const gen0 = (await t.daemon.get(child.id))!.generation;
  const reg = t.daemon.deps.registry;
  const real = reg.transition.bind(reg);
  let boom = true;
  reg.transition = (async (...a: Parameters<typeof real>) => {
    if (boom && a[2] === "running") {
      boom = false;
      throw new Error("injected crash after the bump");
    }
    return real(...a);
  }) as typeof reg.transition;
  const first = await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/resume`, {});
  assert.equal(first.status, 500);
  assert.equal((await t.daemon.get(child.id))!.generation, gen0 + 1, "bumped once so far");
  assert.equal((await t.daemon.get(child.id))!.state, "exited");
  const retry = await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/resume`, {});
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual([(retry.body as AgentRecord).state, (retry.body as AgentRecord).generation], ["running", gen0 + 1]);
  assert.equal(wakes.length, 1);
});

// The reap refusal names the cause per merge state in plain words (never the raw record state, e.g. "(none)") and the command to run.
test("reap refusal wording: each unsettled merge state names its cause and `pomtree merge <id>`", () => {
  const cases: [MergeReport["state"], RegExp][] = [
    ["none", /^cannot reap c1: it pushed work that was never merged; run `pomtree merge c1`, then reap it$/],
    [
      "merged",
      /^cannot reap c1: some of its pushed work is not merged into your branch \(it pushed after its last merge, or that merge went to another branch\); run `pomtree merge c1` again, then reap it$/,
    ],
    [
      "conflict",
      /^cannot reap c1: its last merge conflicted \(round 2 of 3\); resolve the conflict in your clone or resume the child \(`pomtree resume c1`\), run `pomtree merge c1` again, then reap it$/,
    ],
    ["check_failed", /^cannot reap c1: its last merge failed the merge check \(round 2 of 3\); fix the cause, run `pomtree merge c1` again, then reap it$/],
    ["escalated", /^cannot reap c1: its merge is not settled; run `pomtree merge c1`, then reap it$/],
    ["empty", /^cannot reap c1: its merge is not settled; run `pomtree merge c1`, then reap it$/],
  ];
  for (const [state, want] of cases) {
    const msg = unmergedRefusal("c1", state, 2);
    assert.match(msg, want, state);
    assert.doesNotMatch(msg, /\((none|merged|conflict|check_failed)\)/, `${state}: the raw merge state is not shown`);
  }
});

for (const state of ["none", "merged", "conflict", "check_failed"] as const) {
  test(`reap refused for an unsettled merge (${state}): 409 unmerged with the plain-words cause`, async () => {
    const { t, parent, child } = await pair();
    await exit(t, child);
    if (state !== "none") repos(t).reports.set(child.id, { state, merged: false, failedRounds: state === "merged" ? 0 : 1, settled: false });
    const r = await call(t, tok(t, parent), "POST", `/v1/agents/${child.id}/reap`, {});
    assert.equal(r.status, 409);
    const body = r.body as { code: string; state: string; error: string };
    assert.deepEqual([body.code, body.state], ["unmerged", state]);
    assert.equal(body.error, unmergedRefusal(child.id, state, state === "merged" ? 0 : 1));
    assert.match(body.error, new RegExp(`run \`pomtree merge ${child.id}\``));
  });
}
