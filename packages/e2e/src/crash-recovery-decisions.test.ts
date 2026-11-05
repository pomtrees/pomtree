import assert from "node:assert/strict";
import { test } from "node:test";
import type { DebitRow } from "./browser-live-audit.ts";
import { BUDGET_REFUSE_ABOVE, evaluateRecovery, parseArgs, SANDBOX_KIND, SETTLEMENT_KIND } from "./crash-recovery-decisions.ts";
import type { Evidence, JEntry } from "./crash-recovery-decisions.ts";

const row = (id: string, charged: number, status = "settled"): DebitRow => ({
  request_id: id,
  status,
  charged_micros: charged,
  maximum_micros: 5000,
  created_at: 1,
});
const e = (seq: number, payload: JEntry["payload"], generation = 1): JEntry => ({ seq, generation, payload });

// A healthy ADOPT run: container survives, one sandbox, one exit, calls continue after the kill (seq 5 is the boundary).
function adoptEvidence(): Evidence {
  return {
    variant: "adopt",
    capMicros: 100_000,
    pre: {
      agent: { state: "running", exit: null, generation: 1, sandbox: "sb1" },
      maxSeq: 5,
      debit: [row("r1", 10), row("r1:probe", 0, "cancelled")],
      spentMicros: 10,
      containerRunningAfterKill: true,
    },
    final: {
      agent: { state: "exited", exit: "succeeded", generation: 1, sandbox: null },
      journal: [
        e(1, { kind: "spawned" }),
        e(2, { kind: SANDBOX_KIND, phase: "started", sandbox: "sb1" }),
        e(3, { kind: SETTLEMENT_KIND, requestId: "r1" }),
        e(6, { kind: SETTLEMENT_KIND, requestId: "r2" }),
        e(7, { kind: SANDBOX_KIND, phase: "exited", sandbox: "sb1", exitCode: 0 }),
        e(8, { kind: "exited", exit: "succeeded" }),
      ],
      debit: [row("r1", 10), row("r1:probe", 0, "cancelled"), row("r2", 12)],
      spentMicros: 22,
      agentContainers: [{ id: "sb1", running: false }],
      workspaceDirs: 1,
      operatorApiOk: true,
    },
  };
}
const failed = (ev: Evidence) =>
  evaluateRecovery(ev)
    .checks.filter((c) => !c.ok)
    .map((c) => c.name);
const clone = (ev: Evidence): Evidence => structuredClone(ev);

test("a healthy adopt run passes every check and records observations", () => {
  const v = evaluateRecovery(adoptEvidence());
  assert.deepEqual(failed(adoptEvidence()), []);
  assert.equal(v.ok, true);
  assert.ok(v.observations.some((o) => o.name === "model calls after the restart" && o.detail.startsWith("1 ")));
});

test("negative: a duplicated terminal exited record fails", () => {
  const ev = clone(adoptEvidence());
  ev.final.journal.push(e(9, { kind: "exited", exit: "succeeded" }));
  assert.deepEqual(failed(ev), ["exactly one terminal exited record"]);
});

test("negative: a duplicated publish and a duplicated settlement fail", () => {
  const ev = clone(adoptEvidence());
  ev.final.journal.push(
    e(9, { kind: "report_published", report: "rp1" }),
    e(10, { kind: "report_published", report: "rp1" }),
    e(11, { kind: SETTLEMENT_KIND, requestId: "r2" }),
  );
  assert.deepEqual(failed(ev), ["no duplicate publish", "no duplicate model settlement"]);
});

test("negative: a missing adopt (second container, bumped generation, resume) fails", () => {
  const ev = clone(adoptEvidence());
  ev.final.agent.generation = 2;
  ev.final.journal.push(e(9, { kind: SANDBOX_KIND, phase: "started", sandbox: "sb2" }, 2), e(10, { kind: "resumed" }, 2));
  ev.final.agentContainers.push({ id: "sb2", running: false });
  const f = failed(ev);
  for (const n of ["adopted, not restarted: no second container", "generation not bumped by adoption", "no resume journaled"]) assert.ok(f.includes(n), n);
});

test("adopt: 0 containers left after the reap with one started id passes; two containers alone fails", () => {
  const ev = clone(adoptEvidence());
  ev.final.agentContainers = [];
  assert.ok(!failed(ev).includes("adopted, not restarted: no second container"));
  const two = clone(adoptEvidence());
  two.final.agentContainers = [
    { id: "sb1", running: false },
    { id: "sb2", running: false },
  ];
  assert.ok(failed(two).includes("adopted, not restarted: no second container"));
});

test("negative: the exit journaled against a different container fails the adopt binding", () => {
  const ev = clone(adoptEvidence());
  ev.final.journal = ev.final.journal.map((x) => (kind(x) === SANDBOX_KIND && x.payload.phase === "exited" ? e(x.seq, { ...x.payload, sandbox: "other" }) : x));
  assert.deepEqual(failed(ev), ["adopted container's exit is journaled against the original container"]);
});

test("negative: the variant precondition (container survived the kill) is enforced", () => {
  const ev = clone(adoptEvidence());
  ev.pre.containerRunningAfterKill = false;
  assert.deepEqual(failed(ev), ["container survived the pomtreed SIGKILL"]);
});

test("negative: lost, altered or over-cap debit rows fail", () => {
  const lost = clone(adoptEvidence());
  lost.final.debit = lost.final.debit.filter((r) => r.request_id !== "r1");
  lost.final.spentMicros = 12;
  lost.pre.spentMicros = 20;
  assert.ok(failed(lost).includes("debit rows survive the restart unchanged"));
  assert.ok(failed(lost).includes("spend is monotone across the restart"));
  const altered = clone(adoptEvidence());
  altered.final.debit[0] = row("r1", 99);
  altered.final.spentMicros = 111;
  assert.ok(failed(altered).includes("debit rows survive the restart unchanged"));
  const over = clone(adoptEvidence());
  over.capMicros = 20;
  assert.deepEqual(failed(over), ["total spend within cap"]);
});

test("negative: spend that disagrees with the settled debits, a dead operator API and a leaked running container fail", () => {
  const ev = clone(adoptEvidence());
  ev.final.spentMicros = 30;
  ev.final.operatorApiOk = false;
  ev.final.agentContainers[0]!.running = true;
  const f = failed(ev);
  for (const n of ["spend equals settled debits", "operator API and token work after the restart", "no agent container left running"])
    assert.ok(f.includes(n), n);
});

test("an expired-charged debit row counts in spend equals settled debits; omitting it fails", () => {
  const ev = clone(adoptEvidence());
  ev.final.debit.push(row("r3", 40, "expired-charged"));
  ev.final.spentMicros = 62;
  assert.deepEqual(failed(ev), []);
  ev.final.spentMicros = 22;
  assert.deepEqual(failed(ev), ["spend equals settled debits"]);
});

function resumedByGrant(grantResumes: number): Evidence {
  const ev = clone(adoptEvidence());
  ev.grantResumes = grantResumes;
  ev.final.agent.generation = 2;
  ev.final.journal.push(e(9, { kind: SANDBOX_KIND, phase: "started", sandbox: "sb2" }, 2), e(10, { kind: "resumed" }, 2));
  ev.final.agentContainers.push({ id: "sb2", running: false });
  return ev;
}

test("grantResumes: a second container and bumped generation pass with one grant and still fail without it", () => {
  assert.deepEqual(failed(resumedByGrant(1)), []);
  const f = failed(resumedByGrant(0));
  for (const n of ["adopted, not restarted: no second container", "generation not bumped by adoption", "no resume journaled"]) assert.ok(f.includes(n), n);
});

test("grantResumes: more resumes than grants, an unbumped generation, or a wrong first container fails", () => {
  const many = resumedByGrant(1);
  many.final.journal.push(e(11, { kind: "resumed" }, 2));
  assert.deepEqual(failed(many), ["no more resumes than grants"]);
  const flat = resumedByGrant(1);
  flat.final.agent.generation = 1;
  assert.deepEqual(failed(flat), ["a budget grant bumped the generation"]);
  const wrong = resumedByGrant(1);
  wrong.pre.agent.sandbox = "other";
  assert.deepEqual(failed(wrong), ["adopted first, then resumed by a budget grant: the original container started first"]);
});

test("negative: no pre-kill journal or debit evidence is a vacuous run and fails", () => {
  const ev = clone(adoptEvidence());
  ev.pre.maxSeq = 0;
  ev.pre.debit = [];
  const f = failed(ev);
  assert.ok(f.includes("journal rows from before the kill survive"));
  assert.ok(f.includes("debit rows survive the restart unchanged"));
});

test("dead-container: a same-folder resume passes; a fresh clone or eviction fails; an unresumed failure is only observed", () => {
  const base = clone(adoptEvidence());
  base.variant = "dead-container";
  base.pre.containerRunningAfterKill = false;
  base.final.agent.generation = 2;
  base.final.journal.push(e(9, { kind: SANDBOX_KIND, phase: "started", sandbox: "sb2" }, 2), e(10, { kind: "resumed" }, 2));
  base.final.agentContainers = [
    { id: "sb1", running: false },
    { id: "sb2", running: false },
  ];
  assert.deepEqual(failed(base), []);

  const fresh = clone(base);
  fresh.final.workspaceDirs = 2;
  assert.deepEqual(failed(fresh), ["resume reused the same folder"]);
  const evicted = clone(base);
  evicted.final.journal.push(e(11, { kind: "workspace_evicted" }));
  assert.deepEqual(failed(evicted), ["resume reused the same folder"]);

  const notFenced = clone(base);
  notFenced.final.agent.generation = 1;
  assert.deepEqual(failed(notFenced), ["resume fenced the dead instance (generation bumped)"]);

  const noResume = clone(adoptEvidence());
  noResume.variant = "dead-container";
  noResume.pre.containerRunningAfterKill = false;
  noResume.final.agent = { state: "exited", exit: "failed", generation: 1, sandbox: null };
  noResume.final.journal = noResume.final.journal.filter((x) => kind(x) !== SANDBOX_KIND || x.payload.phase === "started");
  const v = evaluateRecovery(noResume);
  assert.deepEqual(
    v.checks.filter((c) => !c.ok).map((c) => c.name),
    [],
  );
  assert.ok(v.observations.some((o) => o.name === "dead-container outcome" && o.detail.startsWith("not resumed")));
});

test("dead-container: a container still running at the end fails", () => {
  const ev = clone(adoptEvidence());
  ev.variant = "dead-container";
  ev.pre.containerRunningAfterKill = false;
  ev.final.agentContainers = [{ id: "sb1", running: true }];
  assert.ok(failed(ev).includes("dead container: no concurrent second container"));
});

test("parseArgs: caps, required flags and the refused cap override", () => {
  const ok = parseArgs(["--image", "img", "--out", "/o"]);
  assert.ok(!("refusal" in ok));
  if (!("refusal" in ok)) assert.deepEqual([ok.budgetMicros, ok.variant], [100_000, "adopt"]);
  const dead = parseArgs(["--image", "img", "--out", "/o", "--kill-container"]);
  assert.ok(!("refusal" in dead) && dead.variant === "dead-container");
  assert.match((parseArgs(["--image", "img", "--out", "/o", "--budget-micros", String(BUDGET_REFUSE_ABOVE + 1)]) as { refusal: string }).refusal, /exceeds/);
  assert.match((parseArgs(["--image", "img", "--out", "/o", "--i-know-the-cap"]) as { refusal: string }).refusal, /not supported/);
  assert.match((parseArgs(["--out", "/o"]) as { refusal: string }).refusal, /--image/);
  assert.match((parseArgs(["--image", "i", "--out", "/o", "--budget-micros", "0"]) as { refusal: string }).refusal, /positive/);
  assert.match((parseArgs(["--image", "i", "--out", "/o", "--model", "nope"]) as { refusal: string }).refusal, /PROVIDER/);
});

function kind(x: JEntry) {
  return x.payload.kind;
}
