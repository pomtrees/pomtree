import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { POMTREED_KINDS } from "@pomtree/core";
import { budgetRaiseTarget } from "../../pomtreed/src/budget-raise.ts";
import { parseBudgetFlag } from "../../pomtree/src/ux.ts";
import type { DebitRow } from "./browser-live-audit.ts";
import { SANDBOX_KIND, SETTLEMENT_KIND } from "./crash-recovery-decisions.ts";
import type { JEntry } from "./crash-recovery-decisions.ts";
import {
  BUDGET_REFUSE_ABOVE,
  BUDGET_REFUSE_BELOW,
  CHILD_BUDGET_MICROS,
  childTask,
  DEFAULT_DEADLINE_MS,
  decideArgs,
  decideStep,
  evaluateCampaign,
  evaluateMulti,
  GRANT_MICROS,
  MAX_DECIDE_FAILURES,
  MAX_GRANTS,
  MAX_REQUESTED_MICROS,
  newDecideState,
  parentTask,
  parseCampaignRows,
  parseMultiArgs,
  planGrants,
  renderCampaign,
  renderPlan,
  ROOT_BUDGET_FACTOR,
  STALL_OBSERVATION,
  spendPlan,
} from "./crash-recovery-multi-decisions.ts";
import type { AgentEvidence, ApprovalRow, CampaignRun, MultiEvidence, WireDebitRow } from "./crash-recovery-multi-decisions.ts";

const row = (id: string, charged: number, status = "settled"): DebitRow => ({
  request_id: id,
  status,
  charged_micros: charged,
  maximum_micros: 5000,
  created_at: 1,
});
// A provider-wire row as a live run records it: a settled call carries a charge, tokens, a model, a 200 status and the provider's response id.
// A row that never got a reply (a probe the crash cancelled, or one the crash charged) carries none of them.
const wrow = (id: string, charged: number, status = "settled"): WireDebitRow => ({
  request_id: id,
  status,
  charged_micros: charged,
  tokens_in: status === "settled" ? 12 : null,
  tokens_out: status === "settled" ? 34 : null,
  model: status === "settled" ? "anthropic/claude-haiku-5.5" : null,
  response_id: status === "settled" ? `msg_${id}` : null,
  upstream_status: status === "settled" ? 200 : null,
});
const e = (seq: number, payload: JEntry["payload"]): JEntry => ({ seq, generation: 1, payload });

// One healthy adopted agent. `n` makes ids unique; seqs start at `base`; the kill boundary is global maxSeq 20.
function agent(role: AgentEvidence["role"], n: number, base: number, o: { parent?: string | null; reaped?: number; resultSeq?: number } = {}): AgentEvidence {
  const sb = `sb${n}`;
  const pre = [
    e(base, { kind: "spawned" }),
    e(base + 1, { kind: SANDBOX_KIND, phase: "started", sandbox: sb }),
    e(base + 2, { kind: SETTLEMENT_KIND, requestId: `r${n}a` }),
  ];
  const post = [
    e(30 + base, { kind: SETTLEMENT_KIND, requestId: `r${n}b` }),
    e(31 + base, { kind: SANDBOX_KIND, phase: "exited", sandbox: sb, exitCode: 0 }),
    e(o.resultSeq ?? 32 + base, { kind: POMTREED_KINDS.result }),
    ...(o.reaped !== undefined ? [e(o.reaped, { kind: "reaped" })] : []),
    e(100 + base, { kind: "exited", exit: "succeeded" }),
  ].sort((a, b) => a.seq - b.seq);
  return {
    role,
    id: `id${n}`,
    name: `agent${n}`,
    parent: o.parent ?? null,
    capMicros: role === "child" ? CHILD_BUDGET_MICROS : 100_000,
    pre: {
      agent: { state: "running", exit: null, generation: 1, sandbox: sb },
      debit: [row(`r${n}a`, 10), row(`r${n}a:probe`, 0, "cancelled")],
      spentMicros: 10,
      containerRunningAfterKill: true,
    },
    preJournal: pre,
    wireDebit: [wrow(`r${n}a`, 10), wrow(`r${n}a:probe`, 0, "cancelled"), wrow(`r${n}b`, 12)],
    final: {
      agent: { state: role === "child" ? "reaped" : "exited", exit: "succeeded", generation: 1, sandbox: null },
      journal: [...pre, ...post],
      debit: [row(`r${n}a`, 10), row(`r${n}a:probe`, 0, "cancelled"), row(`r${n}b`, 12)],
      spentMicros: 22,
      agentContainers: [{ id: `pomtree-${sb}`, running: false }],
      workspaceDirs: 0,
      operatorApiOk: true,
    },
  };
}

// The root supervisor, shaped like a real one (`root-` and 24 hex, `rootAgentIdFor` in packages/pomtreed/src/daemon.ts).
const ROOT = "root-0123456789abcdef01234567";

// Parent id0 (result at seq 200), children id1 and id2 (reaped before it), solo id3. The parent and the solo are operator spawns,
// so the daemon records both as children of the root; only the root itself is parentless.
//
// This fixture is a COMPLETE run, which now includes the crash charge and the stall it forces: the harness waits for a child to have a
// request in flight before it kills, so every REC-1 run charges that request in full, exhausts the child and grants it a raise.
// `noStall()` below strips that back out for the negative case.
function healthy(): MultiEvidence {
  const ev: MultiEvidence = {
    parentId: "id0",
    rootId: ROOT,
    maxSeq: 20,
    totalCapMicros: 300_000,
    agents: [
      agent("parent", 0, 1, { parent: ROOT, resultSeq: 200 }),
      agent("child", 1, 4, { parent: "id0", reaped: 150 }),
      agent("child", 2, 7, { parent: "id0", reaped: 151 }),
      agent("solo", 3, 10, { parent: ROOT }),
    ],
    samples: [["sb0", "sb1", "sb2", "sb3"], ["sb0", "sb2", "sb3"], []],
    leftovers: { containers: [], volumes: [], networks: [] },
    decisions: [],
    skippedApprovals: [],
  };
  const a = ev.agents[2]!; // child kid2: its in-flight request is the one the crash charged
  a.final.journal.push(
    e(25, {
      kind: POMTREED_KINDS.budgetEscalated,
      approval: APPROVAL,
      requested: 7500,
      spent: 15_000,
      budget: 15_000,
      remainingMicros: 0,
      minimumMicros: 8381,
    }),
    e(26, { kind: POMTREED_KINDS.budgetGranted, approval: APPROVAL, amount: 15_000, payer: "id0", newBudget: 30_000 }),
    { seq: 27, generation: 2, payload: { kind: "resumed" } },
    { seq: 28, generation: 2, payload: { kind: SANDBOX_KIND, phase: "started", sandbox: "sb2b" } },
  );
  a.final.journal.sort((x, y) => x.seq - y.seq);
  a.final.agent.generation = 2;
  a.final.debit.push(row("r2x", 15_000, "expired-charged"));
  a.wireDebit.push(wrow("r2x", 15_000, "expired-charged"));
  a.final.spentMicros += 15_000;
  ev.samples.push(["sb2b"]);
  ev.decisions = [{ approval: APPROVAL, requester: "id2", grantMicros: 15_000, outcome: "approved", detail: "approved" }];
  return ev;
}

// The same run with the crash charge and the stall removed: the shape a run would have if the kill missed every in-flight request.
function noStall(): MultiEvidence {
  const ev = clone(healthy());
  const a = A(ev, 2);
  a.final.journal = a.final.journal.filter(
    (x) => ![POMTREED_KINDS.budgetEscalated, POMTREED_KINDS.budgetGranted, "resumed"].includes(x.payload.kind as string) && x.payload.sandbox !== "sb2b",
  );
  a.final.agent.generation = 1;
  a.final.debit = a.final.debit.filter((r) => r.status !== "expired-charged");
  a.wireDebit = a.wireDebit.filter((r) => r.status !== "expired-charged");
  a.final.spentMicros -= 15_000;
  ev.samples = ev.samples.filter((s) => !s.includes("sb2b"));
  ev.decisions = [];
  return ev;
}
const failed = (ev: MultiEvidence) =>
  evaluateMulti(ev)
    .checks.filter((c) => !c.ok)
    .map((c) => c.name);
const clone = (ev: MultiEvidence): MultiEvidence => structuredClone(ev);
const A = (ev: MultiEvidence, i: number) => ev.agents[i]!;

test("a healthy tree passes every check", () => {
  assert.deepEqual(failed(healthy()), []);
  const v = evaluateMulti(healthy());
  assert.equal(v.ok, true);
  assert.ok(
    v.checks.some((c) => c.name === "agent1: adopted, not restarted: no second container"),
    "evaluateRecovery runs per agent",
  );
});

test("negative: a third child, a parented solo agent, or an agent not running at the kill fails", () => {
  const three = clone(healthy());
  A(three, 3).parent = "id0";
  assert.ok(failed(three).includes("the parent spawned exactly two children"));
  assert.ok(failed(three).includes("the unrelated agent is a child of the root, not of the killed parent"));
  // A parentless solo agent is not a shape the daemon can produce: only the root has no parent, so it fails too.
  const orphanSolo = clone(healthy());
  A(orphanSolo, 3).parent = null;
  assert.ok(failed(orphanSolo).includes("the unrelated agent is a child of the root, not of the killed parent"));
  // A root id the harness failed to read cannot make the check pass vacuously.
  const noRoot = clone(healthy());
  noRoot.rootId = "";
  assert.ok(failed(noRoot).includes("the unrelated agent is a child of the root, not of the killed parent"));
  const idle = clone(healthy());
  A(idle, 2).pre.agent.state = "yielded";
  assert.deepEqual(failed(idle), ["every agent was running when pomtreed was killed"]);
});

test("negative: no settled call before the kill fails the precondition", () => {
  const ev = clone(healthy());
  for (const a of ev.agents) a.pre.debit = [row("x", 0, "reserved")];
  assert.ok(failed(ev).includes("at least one model call had settled before the kill"));
});

test("negative: a duplicated exited, resumed or result entry on one agent fails by name", () => {
  const dupExit = clone(healthy());
  A(dupExit, 1).final.journal.push(e(300, { kind: "exited", exit: "succeeded" }));
  assert.deepEqual(failed(dupExit), ["agent1: exactly one terminal exited record"]);
  // agent1, not agent2: agent2 is the stalled child, whose grant legitimately resumes it once.
  const resumed = clone(healthy());
  A(resumed, 1).final.journal.push(e(301, { kind: "resumed" }));
  assert.deepEqual(failed(resumed), ["agent1: no resume journaled", "agent1: no duplicate resumed entry"]);
  const dupResult = clone(healthy());
  A(dupResult, 3).final.journal.push(e(302, { kind: POMTREED_KINDS.result }));
  assert.deepEqual(failed(dupResult), ["agent3: exactly one recorded result"]);
});

test("negative: a duplicated settlement request id fails", () => {
  const ev = clone(healthy());
  A(ev, 3).final.journal.push(e(303, { kind: SETTLEMENT_KIND, requestId: "r3b" }));
  assert.deepEqual(failed(ev), ["agent3: no duplicate model settlement"]);
});

test("negative: a debit row with no journaled settlement, and the reverse, fail the equality check", () => {
  const onlyDebit = clone(healthy());
  A(onlyDebit, 0).final.debit.push(row("ghost", 5));
  A(onlyDebit, 0).final.spentMicros += 5;
  assert.deepEqual(failed(onlyDebit), ["agent0: debit rows equal journaled settlements"]);
  const onlyJournal = clone(healthy());
  A(onlyJournal, 0).final.journal.push(e(304, { kind: SETTLEMENT_KIND, requestId: "ghost" }));
  assert.deepEqual(failed(onlyJournal), ["agent0: debit rows equal journaled settlements"]);
});

test("negative: a rewritten pre-kill journal row, or a bumped generation with a second container, fails", () => {
  const rewritten = clone(healthy());
  A(rewritten, 1).preJournal[0] = e(4, { kind: "tampered" });
  assert.deepEqual(failed(rewritten), ["agent1: pre-kill journal is an unchanged prefix"]);
  // agent1, not agent2: agent2's grant bumps its generation and starts a second container by design.
  const restarted = clone(healthy());
  A(restarted, 1).final.agent.generation = 2;
  A(restarted, 1).final.journal.push(e(305, { kind: SANDBOX_KIND, phase: "started", sandbox: "sb1b" }), e(306, { kind: "resumed" }));
  const f = failed(restarted);
  assert.ok(f.includes("agent1: generation not bumped by adoption"));
  assert.ok(f.includes("agent1: adopted, not restarted: no second container"));
});

test("negative: two containers of one agent running at once fails; other agents running together do not", () => {
  const ev = clone(healthy());
  A(ev, 1).final.journal.push(e(307, { kind: SANDBOX_KIND, phase: "started", sandbox: "sb1b" }));
  ev.samples.push(["sb1", "sb1b"]);
  assert.ok(failed(ev).includes("agent1: at most one container at a time"));
  const none = clone(healthy());
  none.samples = [];
  assert.ok(failed(none).includes("agent0: at most one container at a time"), "no samples is no proof");
});

test("negative: a child not reaped, reaped twice, reaped after the parent's result, or unreaped by the parent fails", () => {
  const unreaped = clone(healthy());
  A(unreaped, 1).final.agent.state = "exited";
  A(unreaped, 1).final.journal = A(unreaped, 1).final.journal.filter((x) => x.payload.kind !== "reaped");
  const f = failed(unreaped);
  assert.ok(f.includes("agent1: reaped under the parent"));
  assert.ok(f.includes("agent1: exactly one reaped entry"));
  const twice = clone(healthy());
  A(twice, 2).final.journal.push(e(310, { kind: "reaped" }));
  assert.ok(failed(twice).includes("agent2: exactly one reaped entry"));
  const late = clone(healthy());
  A(late, 1).final.journal.find((x) => x.payload.kind === "reaped")!.seq = 250;
  assert.ok(failed(late).includes("agent1: reaped before the parent's result"));
  const orphan = clone(healthy());
  A(orphan, 2).parent = "someone-else";
  assert.ok(failed(orphan).includes("the parent spawned exactly two children"));
});

test("negative: a failed agent, a never-finished agent, and a top-level agent reaped twice fail; a root child reaped at exit passes", () => {
  const bad = clone(healthy());
  A(bad, 3).final.agent.exit = "failed";
  assert.deepEqual(failed(bad), ["agent3: finished succeeded"]);
  const running = clone(healthy());
  A(running, 0).final.agent.state = "running";
  assert.ok(failed(running).includes("agent0: finished succeeded"));
  const reapedSolo = clone(healthy());
  A(reapedSolo, 3).final.agent.state = "reaped";
  A(reapedSolo, 3).final.journal.push(e(301, { kind: "reaped" }));
  assert.deepEqual(failed(reapedSolo), []);
  A(reapedSolo, 3).final.journal.push(e(302, { kind: "reaped" }));
  assert.deepEqual(failed(reapedSolo), ["agent3: at most one reaped entry"]);
});

test("negative: spend over the root budget and leftovers of this run fail", () => {
  const spend = clone(healthy());
  spend.totalCapMicros = 50;
  assert.deepEqual(failed(spend), ["tree spend within the root budget"]);
  const left = clone(healthy());
  left.leftovers.volumes = ["vol1"];
  assert.deepEqual(failed(left), ["no containers, volumes or networks of this run left after cleanup"]);
  const net = clone(healthy());
  net.leftovers.networks = ["docker network ls failed: exit 1"];
  assert.deepEqual(failed(net), ["no containers, volumes or networks of this run left after cleanup"]);
});

test("negative: an adopted container that did not survive the kill fails for that agent only", () => {
  const ev = clone(healthy());
  A(ev, 1).pre.containerRunningAfterKill = false;
  assert.deepEqual(failed(ev), ["agent1: container survived the pomtreed SIGKILL"]);
});

test("parseMultiArgs: defaults and every refusal", () => {
  const ok = parseMultiArgs(["--image", "i", "--out", "o"]);
  assert.deepEqual(ok, {
    image: "i",
    out: "o",
    budgetMicros: 100_000,
    model: "openrouter/anthropic/claude-haiku-5.5",
    deadlineMs: 600_000,
    agentListen: undefined,
    dryRun: false,
  });
  assert.equal(DEFAULT_DEADLINE_MS, 600_000);
  const dry = parseMultiArgs(["--image", "i", "--dry-run", "--out", "o"]);
  assert.ok(!("refusal" in dry) && dry.dryRun === true);
  const refusal = (...a: string[]) => (parseMultiArgs(a) as { refusal: string }).refusal;
  assert.match(refusal("--out", "o"), /--image is required/);
  assert.match(refusal("--image", "i"), /--out is required/);
  assert.match(refusal("--image", "i", "--out", "o", "--budget-micros", String(BUDGET_REFUSE_ABOVE + 1)), /exceeds/);
  assert.match(refusal("--image", "i", "--out", "o", "--budget-micros", String(BUDGET_REFUSE_BELOW - 1)), /below/);
  assert.match(refusal("--image", "i", "--out", "o", "--budget-micros", "1.5"), /positive integer/);
  assert.match(refusal("--image", "i", "--out", "o", "--kill-container"), /adopt variant only/);
  assert.match(refusal("--image", "i", "--out", "o", "--i-know-the-cap"), /not supported/);
  assert.match(refusal("--image", "i", "--out", "o", "--deadline-ms", "10"), />= 30000/);
  assert.match(refusal("--image", "i", "--out", "o", "--model", "nomodel"), /PROVIDER\/ID/);
  assert.match(refusal("--image", "i", "--out"), /needs a value/);
  assert.match(refusal("stray"), /unexpected argument/);
  assert.equal(typeof parseMultiArgs(["--image", "i", "--out", "o", "--budget-micros", String(BUDGET_REFUSE_ABOVE)]), "object");
});

test("task texts: both child tasks are single-quote safe and write different files; the parent merges then reaps each child after its wait", () => {
  assert.ok(!childTask(1).includes("'"));
  assert.ok(!childTask(2).includes("'"));
  assert.match(childTask(1), /progress-kid1\.txt/);
  assert.match(childTask(2), /progress-kid2\.txt/);
  assert.ok(!childTask(1).includes("kid2") && !childTask(2).includes("kid1"));
  const t = parentTask("openrouter/anthropic/claude-haiku-5.5");
  assert.equal((t.match(/pomtree spawn/g) ?? []).length, 2);
  assert.equal((t.match(new RegExp(`--budget ${CHILD_BUDGET_MICROS}`, "g")) ?? []).length, 2);
  assert.equal((t.match(/pomtree merge/g) ?? []).length, 2);
  assert.equal((t.match(/pomtree reap/g) ?? []).length, 2);
  assert.match(t, /pomtree wait \$\(cat \/tmp\/kid1\.id\) --timeout 15000/);
  assert.match(t, /pomtree wait \$\(cat \/tmp\/kid2\.id\) --timeout 15000/);
  assert.ok(t.indexOf("pomtree push") >= 0 && t.indexOf("pomtree push") < t.indexOf("pomtree spawn"), "the parent pushes its own branch before spawning");
  // Every merge is followed by the pull-and-fast-forward the product asks for, so the parent's final push is never a non-fast-forward
  // that the model has to recover from by forcing. The task must also never invite a force push.
  assert.equal((t.match(/pomtree pull && git merge --ff-only/g) ?? []).length, 2, "one sync per merge");
  assert.equal((t.match(/refs\/remotes\/pomtreed-agents\/\$POMTREE_AGENT_ID\/heads\/agent\/\$POMTREE_AGENT_ID/g) ?? []).length, 2);
  for (const n of [1, 2]) {
    const mergeAt = t.indexOf(`pomtree merge $(cat /tmp/kid${n}.id)`);
    assert.ok(mergeAt >= 0 && t.indexOf("pomtree pull && git merge --ff-only", mergeAt) > mergeAt, `kid${n}: the sync follows its merge`);
  }
  // The task names --force only to forbid it, so what must be absent is the command itself.
  assert.ok(!/push\s+--force/.test(t), "the parent task never tells the agent to force a push");
  assert.match(t, /never pass --force to pomtree push/);
  assert.ok(t.lastIndexOf("pomtree push") > t.lastIndexOf("pomtree pull && git merge --ff-only"), "the final push comes after the last sync");
  assert.match(childTask(1), /git commit -m kid1-result/);
  for (const n of [1, 2]) {
    assert.ok(t.includes(`pomtree merge $(cat /tmp/kid${n}.id); pomtree reap $(cat /tmp/kid${n}.id)`), `kid${n}: merge and reap in one command`);
    const w = t.indexOf(`kid${n}.id) --timeout`);
    const m = t.indexOf(`pomtree merge $(cat /tmp/kid${n}.id)`);
    const r = t.indexOf(`pomtree reap $(cat /tmp/kid${n}.id)`);
    assert.ok(w >= 0 && w < m && m < r, `kid${n}: wait < merge < reap`);
  }
});

// ---- decide step -----------------------------------------------------------------------------------------------------

const tree = new Set(["id1", "id2"]);
const pendingRow = (id: string, requester = "id1", o: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id,
  requester_id: requester,
  action_kind: "budget_raise",
  action_target: budgetRaiseTarget(requester, 1, 7500),
  state: "pending",
  ...o,
});
function fakeIo(rows: ApprovalRow[], failTimes = 0) {
  const calls: [string, number][] = [];
  let fails = failTimes;
  return {
    calls,
    io: {
      pending: () => rows,
      decide: async (a: string, g: number) => {
        calls.push([a, g]);
        if (fails > 0) {
          fails--;
          throw new Error("boom");
        }
      },
    },
  };
}

test("decideStep approves a pending budget raise from the tree with GRANT_MICROS", async () => {
  const f = fakeIo([pendingRow("a1")]);
  const st = newDecideState();
  await decideStep(f.io, tree, st);
  assert.deepEqual(f.calls, [["a1", GRANT_MICROS]]);
  assert.deepEqual(st.records, [{ approval: "a1", requester: "id1", grantMicros: GRANT_MICROS, outcome: "approved", detail: "approved" }]);
  assert.equal(st.skipped.size, 0);
  await decideStep(f.io, tree, st);
  assert.equal(f.calls.length, 1, "an approval already recorded is not decided again");
});

test("decideStep never approves non-pending rows, and records a reason for what it skips", async () => {
  const rows = [
    pendingRow("done", "id1", { state: "approved" }),
    pendingRow("kind", "id1", { action_kind: "shell" }),
    pendingRow("out", "someone"),
    pendingRow("bad", "id1", { action_target: "garbage" }),
    pendingRow("big", "id1", { action_target: budgetRaiseTarget("id1", 1, MAX_REQUESTED_MICROS + 1) }),
  ];
  const f = fakeIo(rows);
  const st = newDecideState();
  await decideStep(f.io, tree, st);
  assert.deepEqual(f.calls, []);
  assert.deepEqual([...st.skipped.keys()].sort(), ["bad", "big", "kind", "out"]);
  assert.match(st.skipped.get("kind")!, /not a budget raise/);
  assert.match(st.skipped.get("out")!, /not in this run's tree/);
  assert.match(st.skipped.get("bad")!, /malformed/);
  assert.match(st.skipped.get("big")!, /over the/);
  assert.ok(!st.skipped.has("done"));
  assert.deepEqual(st.records, []);
  // a request exactly at the cap is still decided
  const edge = fakeIo([pendingRow("edge", "id2", { action_target: budgetRaiseTarget("id2", 1, MAX_REQUESTED_MICROS) })]);
  await decideStep(edge.io, tree, newDecideState());
  assert.equal(edge.calls.length, 1);
});

test("decideStep stops after MAX_GRANTS approvals and records the reason", async () => {
  const rows = Array.from({ length: MAX_GRANTS + 1 }, (_, i) => pendingRow(`g${i}`));
  const f = fakeIo(rows);
  const st = newDecideState();
  await decideStep(f.io, tree, st);
  assert.equal(f.calls.length, MAX_GRANTS);
  assert.equal(st.records.filter((r) => r.outcome === "approved").length, MAX_GRANTS);
  assert.match(st.skipped.get(`g${MAX_GRANTS}`)!, /grant limit/);
  const plan = planGrants(rows, tree, st);
  assert.deepEqual(plan.grants, []);
});

test("decideStep retries a throwing decide on the next poll, then gives up after MAX_DECIDE_FAILURES without retrying again", async () => {
  const f = fakeIo([pendingRow("flaky")], 1);
  const st = newDecideState();
  await decideStep(f.io, tree, st);
  assert.equal(st.records.length, 0, "first failure is not recorded");
  await decideStep(f.io, tree, st);
  assert.equal(f.calls.length, 2);
  assert.equal(st.records[0]?.outcome, "approved");

  const dead = fakeIo([pendingRow("dead")], 99);
  const st2 = newDecideState();
  for (let i = 0; i < MAX_DECIDE_FAILURES + 3; i++) await decideStep(dead.io, tree, st2);
  assert.equal(dead.calls.length, MAX_DECIDE_FAILURES);
  assert.equal(st2.records.length, 1);
  assert.equal(st2.records[0]?.outcome, "failed");
  assert.match(st2.records[0]!.detail, /gave up after 3 failures: boom/);
});

test("decideArgs: the grant is raw micros that pomtree's --grant parser accepts exactly", () => {
  const a = decideArgs("ap1", GRANT_MICROS);
  assert.deepEqual(a.slice(0, 5), ["decide", "ap1", "approve", "--grant", String(GRANT_MICROS)]);
  assert.equal(a[5], "--why");
  assert.ok(a[6]!.length > 0);
  assert.equal(parseBudgetFlag(a[4]), GRANT_MICROS);
});

test("spendPlan and renderPlan: root budget is 3x, the max grant total is named, nothing is started", () => {
  const p = spendPlan({ budgetMicros: 100_000 });
  assert.equal(p.rootBudgetMicros, 100_000 * ROOT_BUDGET_FACTOR);
  assert.equal(p.rootBudgetMicros, 300_000);
  assert.equal(p.maxGrantMicros, MAX_GRANTS * GRANT_MICROS);
  const args = parseMultiArgs(["--image", "i", "--out", "o", "--dry-run"]);
  assert.ok(!("refusal" in args));
  const text = renderPlan(args as Exclude<typeof args, { refusal: string }>);
  assert.match(text, /nothing was started or spent/);
  assert.ok(text.includes(String(p.rootBudgetMicros)));
  assert.ok(text.includes(String(p.maxGrantMicros)));
});

// ---- budget stall: escalated, granted, resumed in a second container ------------------------------------------------

const APPROVAL = "ap-1";
// The stalled-and-granted child is now part of every complete run, so this is `healthy()` itself. The name is kept because the
// escalation tests below read as deltas against it.
const granted = (): MultiEvidence => clone(healthy());

// The provider-wire assertions. These are the facts only a real provider can produce, so they are the ones a live run buys over a
// stub run; before them a settled call charged zero, or priced with no token counts at all, still passed every check.
test("negative: a settled call charged zero, or missing its wire facts, fails", () => {
  const zero = clone(healthy());
  A(zero, 1).wireDebit = A(zero, 1).wireDebit.map((r) => (r.status === "settled" ? { ...r, charged_micros: 0 } : r));
  assert.ok(failed(zero).includes("every settled model call was charged more than zero micros"));
  const nullCharge = clone(healthy());
  A(nullCharge, 1).wireDebit = A(nullCharge, 1).wireDebit.map((r) => (r.status === "settled" ? { ...r, charged_micros: null } : r));
  assert.ok(failed(nullCharge).includes("every settled model call was charged more than zero micros"));
  for (const [field, value] of [
    ["tokens_in", 0],
    ["tokens_out", null],
    ["model", null],
    ["upstream_status", 500],
  ] as const) {
    const ev = clone(healthy());
    A(ev, 1).wireDebit = A(ev, 1).wireDebit.map((r) => (r.status === "settled" ? { ...r, [field]: value } : r));
    assert.ok(
      failed(ev).includes("every settled model call records provider tokens, a model and a 200 upstream status"),
      `${field}=${String(value)} should fail the wire-facts check`,
    );
  }
  const noId = clone(healthy());
  A(noId, 1).wireDebit = A(noId, 1).wireDebit.map((r) => (r.status === "settled" ? { ...r, response_id: "" } : r));
  assert.ok(failed(noId).includes("every settled model call kept a provider response id for invoice reconciliation"));
});

test("negative: a run with no settled wire rows at all fails rather than passing vacuously", () => {
  const ev = clone(healthy());
  for (const a of ev.agents) a.wireDebit = [];
  const f = failed(ev);
  assert.ok(f.includes("every settled model call was charged more than zero micros"));
  assert.ok(f.includes("every settled model call kept a provider response id for invoice reconciliation"));
});

test("a probe row is not held to the wire facts: probes are cancelled and charge nothing", () => {
  const ev = clone(healthy());
  assert.ok(
    ev.agents.every((a) => a.wireDebit.some((r) => r.request_id.endsWith(":probe"))),
    "the fixture has probe rows",
  );
  assert.deepEqual(failed(ev), []);
});

// The stall is a per-run observation again, so a run that did not stall still passes; the guarantee moved to the campaign gate below.
// The observation's leading word is that gate's input, so it is pinned here.
test("the stall observation leads with yes or no, and a run that did not stall still passes", () => {
  const yes = evaluateMulti(healthy());
  assert.equal(yes.ok, true);
  assert.match(yes.observations.find((o) => o.name === STALL_OBSERVATION)!.detail, /^yes: /);
  const no = evaluateMulti(noStall());
  assert.equal(no.ok, true, "a run whose kill missed every in-flight request is still a valid run");
  assert.match(no.observations.find((o) => o.name === STALL_OBSERVATION)!.detail, /^no: /);
});

// A crash charge on the parent or the solo agent is no longer a per-run failure: it cannot be prevented, because the crash charges every
// in-flight request and a reservation is clamped to the agent's whole remainder (runs 4 and 5 of 2026-11-03). It is still reported.
test("a crash charge on the parent is reported, not failed", () => {
  const ev = clone(healthy());
  A(ev, 0).wireDebit.push(wrow("r0x", 27_979, "expired-charged"));
  assert.deepEqual(failed(ev), []);
  assert.match(evaluateMulti(ev).observations.find((o) => o.name === STALL_OBSERVATION)!.detail, /agent0:parent/);
});

const crun = (o: Partial<CampaignRun> = {}): CampaignRun => ({
  date: "2026-11-03",
  base: "abc1234",
  outcome: "pass",
  stalled: true,
  spendMicros: 25_000,
  ...o,
});

test("the campaign gate passes only on three passing runs of which at least one stalled", () => {
  const v = evaluateCampaign([crun(), crun({ stalled: false }), crun({ stalled: false })], ["abc1234"]);
  assert.equal(v.ok, true);
  assert.equal(v.passes, 3);
  assert.equal(v.stalledPasses, 1);
  assert.equal(v.spendMicros, 75_000);
});

// The check this whole option exists for: three green runs must NOT clear the item if none of them exercised the stall.
test("negative: three passing runs that never stalled fail the campaign by name", () => {
  const v = evaluateCampaign([crun({ stalled: false }), crun({ stalled: false }), crun({ stalled: false })], ["abc1234"]);
  assert.equal(v.ok, false);
  assert.deepEqual(
    v.checks.filter((c) => !c.ok).map((c) => c.name),
    ["at least one passing run exercised the budget stall"],
  );
});

test("negative: too few passes, an unaccepted base, a silent row and a failed run all count correctly", () => {
  assert.ok(evaluateCampaign([crun(), crun()], ["abc1234"]).checks.some((c) => !c.ok && c.name.includes("passing runs on the accepted assertion set")));
  // A pass on an older commit does not count, which is what keeps run 3 of 2026-11-03 out of this campaign.
  const wrongBase = evaluateCampaign([crun(), crun(), crun({ base: "0000000" })], ["abc1234"]);
  assert.equal(wrongBase.passes, 2);
  assert.equal(wrongBase.ok, false);
  assert.ok(evaluateCampaign([crun(), crun(), crun({ stalled: null })], ["abc1234"]).checks.some((c) => !c.ok && c.name.includes("states whether it stalled")));
  assert.equal(evaluateCampaign([crun(), crun(), crun({ outcome: "fail", stalled: false })], ["abc1234"]).passes, 2, "a failed run is not a pass");
});

test("campaign rows parse out of the results ledger, with the stall word and the spend", () => {
  const md = [
    "| Gate | Date (UTC) | Commit | Outcome | Evidence | Spend (micros) |",
    "| --- | --- | --- | --- | --- | --- |",
    "| REC-1 | 2026-11-03 | abc1234 | pass | Clean run. stall: yes, kid2 crash-charged | 25496 |",
    "| REC-1 | 2026-11-03 | abc1234 | fail | Timed out. stall: no | 23807 |",
    "| YLD-1 | 2026-11-03 | abc1234 | pass | not this item. stall: yes | 999 |",
    "not a table row at all",
  ].join("\n");
  const rows = parseCampaignRows(md);
  assert.equal(rows.length, 2, "only REC-1 rows");
  assert.deepEqual(
    rows.map((r) => [r.outcome, r.stalled, r.spendMicros]),
    [
      ["pass", true, 25496],
      ["fail", false, 23807],
    ],
  );
  // A row with no stall word parses as unstated rather than as a quiet run, so the gate fails it instead of guessing.
  const header = "| Gate | Date (UTC) | Commit | Outcome | Evidence | Spend (micros) |\n| --- | --- | --- | --- | --- | --- |\n";
  assert.equal(parseCampaignRows(`${header}| REC-1 | 2026-11-03 | abc1234 | pass | says nothing | 1 |`)[0]!.stalled, null);
});

test("campaign rows are read by header name, so the eight-column results format parses and a missing column throws", () => {
  const md = [
    "| Gate | Date (UTC) | Commit | Host | Seam | Outcome | Spend (micros) | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| REC-1 | 2026-11-04 | aaaa001 | host-a | 4 | pass | 23,016 | variant `adopt`. stall: yes |",
    "| REC-1 | 2026-11-04 | aaaa002 | host-a | 4 | fail | 21976 | deadline. stall: no |",
    "",
    "| Gate | Date (UTC) | Commit | Outcome | Evidence | Spend (micros) |",
    "| --- | --- | --- | --- | --- | --- |",
    "| REC-1 | 2026-10-25 | aaaa003 | fail | old six-column row. stall: no | 200000 |",
  ].join("\n");
  assert.deepEqual(
    parseCampaignRows(md).map((r) => [r.base, r.outcome, r.stalled, r.spendMicros]),
    [
      ["aaaa001", "pass", true, 23016],
      ["aaaa002", "fail", false, 21976],
      ["aaaa003", "fail", false, 200000],
    ],
    "Host and Seam are skipped, and each table is read under its own header",
  );
  // The failure this guards: a positional reader on the eight-column form took `Host` for the outcome and reported 0 passes.
  assert.equal(evaluateCampaign(parseCampaignRows(md), ["aaaa001"]).passes, 1);
  // Negative controls: a REC-1 row whose table lacks a required column, or has no header at all, is an error and not an empty result.
  const noOutcome = md.replace("| Outcome |", "| Result |").split("\n").slice(0, 3).join("\n");
  assert.throws(() => parseCampaignRows(noOutcome), /lacks the column\(s\) outcome/);
  assert.throws(() => parseCampaignRows("| REC-1 | 2026-11-04 | aaaa001 | pass | x | 1 |"), /no table header above it/);
  // An unrelated table missing columns is not this parser's business.
  assert.deepEqual(parseCampaignRows("| Name | Value |\n| --- | --- |\n| YLD-1 | 1 |"), []);
});

test("results rows: rows written by scripts/live/results-row.sh parse by header name, and validation.md's own header is accepted", (t) => {
  const bash = spawnSync("bash", ["--version"]);
  if (bash.error) return t.skip("bash is not on PATH; the producer is a bash script");
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const script = [
    `source ${JSON.stringify(`${root}/scripts/live/results-row.sh`)}`,
    "results_header",
    "row() { ROW_GATE=REC-1 ROW_COMMIT=$1 ROW_DATE=2026-11-04 ROW_HOST=host-x+docker1 ROW_OUTCOME=$2 ROW_SPEND=$3 ROW_EVIDENCE=$4 results_row; }",
    'row abc1234 pass 25496 "`rec.sh` rec1, exit 0; stall: yes; rundir 01-rec1"',
    'row abc1235 fail "<=1234" "`rec.sh` rec1, exit 1; stall: no; rundir 02-rec1"',
    'row abc1236+dirty pass 0 "`rec.sh` rec1, exit 0; no stall word"',
  ].join("\n");
  const md = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  assert.deepEqual(
    parseCampaignRows(md).map((r) => [r.date, r.base, r.outcome, r.stalled, r.spendMicros]),
    [
      ["2026-11-04", "abc1234", "pass", true, 25496],
      ["2026-11-04", "abc1235", "fail", false, 1234],
      ["2026-11-04", "abc1236+dirty", "pass", null, 0],
    ],
    "every cell lands in the column of its header name",
  );
  // Host is part of the producer's row even though the parser does not read it.
  assert.ok(
    md.split("\n").some((l) => l.includes("| host-x+docker1 |")),
    md,
  );
  // The one definition: the Results header in docs/validation.md is read by the parser with every column found.
  const header = readFileSync(`${root}/docs/validation.md`, "utf8")
    .split("\n")
    .find((l) => l.startsWith("| Gate |"));
  assert.ok(header, "docs/validation.md has no Results header starting `| Gate |`");
  const doc = `${header}\n| --- | --- | --- | --- | --- | --- | --- |\n| REC-1 | abc1234 | 2026-11-04 | h | pass | 7 | stall: no |`;
  assert.deepEqual(
    parseCampaignRows(doc).map((r) => [r.date, r.base, r.outcome, r.stalled, r.spendMicros]),
    [["2026-11-04", "abc1234", "pass", false, 7]],
  );
});

test("the campaign verdict renders its failures by name", () => {
  const text = renderCampaign(evaluateCampaign([crun({ stalled: false })], ["abc1234"]), ["abc1234"]);
  assert.match(text, /REC-1 campaign verdict: FAIL/);
  assert.match(text, /FAIL at least one passing run exercised the budget stall/);
  assert.match(renderCampaign(evaluateCampaign([crun(), crun(), crun()], ["abc1234"]), ["abc1234"]), /campaign verdict: PASS/);
});

test("a stalled-and-granted child passes every check and the stall is observed", () => {
  const ev = granted();
  assert.deepEqual(failed(ev), []);
  const v = evaluateMulti(ev);
  assert.equal(v.ok, true);
  assert.ok(v.observations.some((o) => o.name === "agent2: budget stall"));
  assert.match(v.observations.find((o) => o.name === "budget stall exercised")!.detail, /^yes/);
});

test("a grant to a child also raises the parent's budget: the parent's cap includes its children's grants", () => {
  const ev = granted();
  const p = A(ev, 0);
  p.final.debit.push(row("rpx", 100_000, "expired-charged"));
  p.final.spentMicros += 100_000; // 100022: over the parent's own 100000, inside 100000 + the 15000 its child was granted
  assert.deepEqual(failed(ev), []);
  p.final.spentMicros += 20_000;
  p.final.debit.push(row("rpy", 20_000, "expired-charged"));
  assert.ok(failed(ev).includes("agent0: total spend within cap"));
});

test("negative: an escalation with no grant fails", () => {
  const ev = granted();
  const a = A(ev, 2);
  a.final.journal = a.final.journal.filter(
    (x) => ![POMTREED_KINDS.budgetGranted, "resumed"].includes(x.payload.kind as string) && x.payload.sandbox !== "sb2b",
  );
  a.final.agent.generation = 1;
  ev.decisions = [];
  assert.ok(failed(ev).includes("agent2: every budget escalation was granted exactly once, none denied"));
});

test("negative: a budget_denied row fails", () => {
  const ev = granted();
  A(ev, 2).final.journal.push(e(29, { kind: POMTREED_KINDS.budgetDenied, approval: "ap-2" }));
  assert.ok(failed(ev).includes("agent2: every budget escalation was granted exactly once, none denied"));
});

test("negative: a grant with no escalation fails", () => {
  const ev = granted();
  A(ev, 2).final.journal = A(ev, 2).final.journal.filter((x) => x.payload.kind !== POMTREED_KINDS.budgetEscalated);
  assert.ok(failed(ev).includes("agent2: every budget escalation was granted exactly once, none denied"));
});

test("negative: an undecided (skipped) approval or a failed decision fails the operator check", () => {
  const skipped = granted();
  skipped.skippedApprovals = [["ap-9", "requester x is not in this run's tree"]];
  assert.deepEqual(failed(skipped), ["the operator decided every budget approval the tree raised"]);
  const bad = granted();
  bad.decisions[0]!.outcome = "failed";
  assert.deepEqual(failed(bad), ["the operator decided every budget approval the tree raised"]);
});

test("negative: a second container and bumped generation without grant rows is still rejected", () => {
  const ev = granted();
  A(ev, 2).final.journal = A(ev, 2).final.journal.filter(
    (x) => x.payload.kind !== POMTREED_KINDS.budgetEscalated && x.payload.kind !== POMTREED_KINDS.budgetGranted,
  );
  ev.decisions = [];
  const f = failed(ev);
  for (const n of ["agent2: adopted, not restarted: no second container", "agent2: generation not bumped by adoption", "agent2: no resume journaled"])
    assert.ok(f.includes(n), n);
});
