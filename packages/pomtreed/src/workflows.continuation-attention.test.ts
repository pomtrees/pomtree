import { buildChannelRegistry } from "./channels.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DeterministicExecutor, JsonValue, WorkflowDef, WorkflowRunContext } from "@pomtree/core";
import { openStore } from "@pomtree/store-sqlite";
import { createFakes, FakeDeterministicExecutor, ScriptHarness } from "@pomtree/testing";
import { Daemon } from "./daemon.ts";
import { ProxyCredentialGateway } from "./gateway.ts";
import { LocalNode } from "./local-node.ts";
import { LocalOrchestrator } from "./orchestrator.ts";
import { HostPlacement } from "./placement.ts";
import { get, scratch, SECRET, until } from "./test-setup.ts";
import type { WorkflowCapabilityServices } from "./workflow-capabilities.ts";
import { WorkflowHost } from "./workflows.ts";

// Offline runtime tests over a real SQLite file for continuation workflows that touch attention (escalations) and approvals.
// Independent harness (no import from the continuation base test). Each boot is a fresh Daemon on the same database; a
// workflow's ask goes through the daemon's own ask path via the capability services, so the escalation is a real row.

const EXT = "att";
const ASKER = `${EXT}/asker`;
const WAITER = `${EXT}/waiter`;
const HANG = `${EXT}/hang`;
const APPROVER = `${EXT}/approver`;
const READER = `${EXT}/reader`;
const TERMINAL = ["exited", "reaped"];
const TIMEOUT = { timeout: 15_000 };
const forever = () => new Promise<void>(() => {});

type Fakes = ReturnType<typeof createFakes>;
type Boot = { store: ReturnType<typeof openStore>; daemon: Daemon; host: WorkflowHost };

function boot(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], kids: DeterministicExecutor[]): Boot {
  const store = openStore(dbPath);
  const placement = new HostPlacement({ hosts: store.hosts, host: "h1" });
  const orchestrator = new LocalOrchestrator();
  const harness = new ScriptHarness(async (c) => {
    await c.stopped;
  });
  let daemon!: Daemon;
  // Capability services over the live daemon: only ask/root/agent/now are used by these workflows.
  const services = {
    redactText: (text: string) => text,
    readRoot: (from: number, limit: number) => store.journal.read({ agent: "root", from, limit }),
    recordRoot: async (payload: import("@pomtree/core").ExtensionJournalPayload, key: string) => {
      const root = await daemon.root();
      return store.journal.append({ agent: root.id, host: root.host, generation: root.generation, payload, idempotencyKey: key });
    },
    root: async () => daemon.root(),
    agent: (id: string) => daemon.get(id),
    now: () => daemon.now(),
    ask: async (agent: string, req: { question: string; generation: number; idempotencyKey: string }) => ({
      escalation: (await daemon.ask(agent, req)).escalation.id,
    }),
  } as unknown as WorkflowCapabilityServices;
  const host = new WorkflowHost({
    registry: () => store.registry,
    reviewed: (o) => o === EXT,
    startDeterministic: (requester, req) => daemon.startDeterministic(requester, req),
    services: () => services,
  });
  host.commit(EXT, [
    ...defs,
    ...kids.map((k): WorkflowDef => ({ name: k.driver.split("/")[1]!, validate: (input) => ({ ok: true, value: input }), run: (ctx) => k.run(ctx) })),
  ]);
  daemon = new Daemon({
    hostId: "h1",
    secret: SECRET,
    image: "img@sha256:x",
    sandboxSocketPath: "/run/pomtreed.sock",
    socketHostPath: "/host/pomtreed.sock",
    rootBudgetMicros: 10_000,
    defaultBudgetMicros: 1_000,
    graceMs: 20,
    admitRetryMs: 5,
    epoch: "1",
    registry: store.registry,
    journal: store.journal,
    mailbox: store.mailbox,
    sandbox: fakes.hooks.raw.sandbox,
    workspace: fakes.hooks.raw.workspace,
    harness,
    gateway: new ProxyCredentialGateway({ journal: store.journal, registry: store.registry, secret: SECRET, proxyBaseUrl: "http://m", tokenTtlMs: 3_600_000 }),
    checkpoints: store.checkpoints,
    sessions: store.sessions,
    sessionRoot: join(dir, "sessions"),
    escalations: store.escalations,
    approvals: store.approvals,
    channels: buildChannelRegistry([], []),
    watchdogs: store.watchdogs,
    schedules: store.schedules,
    reportStore: fakes.reportStore,
    reportMaxBytes: 1 << 20,
    placement,
    orchestrator,
    deterministicExecutors: host.executors,
    approvalTimeoutMs: 50,
  });
  placement.onAdmit((agent) => daemon.admitted(agent));
  return { store, daemon, host };
}

async function up(dir: string, dbPath: string, fakes: Fakes, defs: WorkflowDef[], kids: DeterministicExecutor[]): Promise<Boot> {
  const b = boot(dir, dbPath, fakes, defs, kids);
  await new LocalNode({
    hostId: "h1",
    sandbox: fakes.sandbox,
    workspace: fakes.workspace,
    capacity: { maxSessions: 4 },
    bootEpoch: "1",
    workspacePath: (id) => `/fake/${id}`,
    sessionDir: (a) => join(dir, "sess", a),
  }).register(b.store.hosts);
  return b;
}

const rootId = async (b: { daemon: Daemon }) => (await b.daemon.root()).id;
const settled = async (b: { daemon: Daemon }, id: string) => TERMINAL.includes((await get(b, id)).state);
const closeQuietly = (b: Boot | undefined) => {
  try {
    b?.store.close();
  } catch {
    // already closed by the test
  }
};
const startReq = (workflow: string, key: string, input: JsonValue = null, extra: object = {}) => ({
  workflow,
  name: "w",
  task: "t",
  idempotencyKey: key,
  input,
  budgetMicros: 5000,
  ...extra,
});
type Phase = { phase: number; child?: string };

// The asker raises an escalation through the workflow capability, then tries to answer it itself (not its holder: refused).
function asker(seen: { esc?: string; childAnswer?: string }): WorkflowDef {
  return {
    name: "asker",
    continuation: true,
    capabilities: { ask: true },
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      if (!ctx.continuation) {
        const q = await ctx.workflow.ask("approve the outbound call?", "q1");
        seen.esc = q.escalation;
        try {
          await ctx.ops.answerEscalation(q.escalation, "self", "self-answer");
          seen.childAnswer = "accepted";
        } catch {
          seen.childAnswer = "refused";
        }
        await ctx.ops.suspend({ phase: 1, escalation: q.escalation }, { kind: "message" }, "answer-wait");
      }
      await ctx.ops.submitResult({ summary: "asked", escalation: seen.esc }, "asked");
    },
  };
}

// Parks on its child's exit. On resume it reaps the child, then answers or passes the child's ask (its holder), per input.mode.
function waiter(seen: {
  esc?: string;
  stale?: WorkflowRunContext["ops"];
  staleRefused?: boolean;
  stage2?: boolean;
  passed?: string;
  answered?: string;
}): WorkflowDef {
  return {
    name: "waiter",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as Phase;
      if (st.phase === 2) {
        await ctx.ops.reap(st.child!, "reap-answered");
        await ctx.ops.submitResult({ summary: "answered" }, "done");
        return;
      }
      if (st.phase === 0) {
        seen.stale = ctx.ops;
        const child = await ctx.ops.spawn({
          name: "asker",
          task: "t",
          idempotencyKey: "asker-1",
          executor: "deterministic",
          spec: { driver: ASKER, input: null },
          budgetMicros: 200,
        });
        await ctx.ops.suspend({ phase: 1, child }, { kind: "child_exited", children: [child], mode: "all" }, "park-1");
        return;
      }
      seen.staleRefused = await seen.stale!.findChild("asker-1").then(
        () => false,
        () => true,
      );
      const rec = await ctx.ops.findChild("asker-1");
      assert.ok(rec && !TERMINAL.includes(rec.state), "attention wakes before the dependency exits");
      await assert.rejects(ctx.ops.reap(rec.id, "too-early"), /not exited/);
      const attention = (await ctx.ops.peek()).find((signal) => signal.kind === "escalation");
      if (attention?.kind !== "escalation") throw new Error("missing attention");
      const esc = attention.escalation;
      seen.esc = esc;
      const mode = (ctx.input as { mode?: string } | null)?.mode;
      if (mode === "pass") {
        await ctx.ops.passEscalation(esc, "pass-1");
        seen.passed = esc;
      } else {
        await ctx.ops.answerEscalation(esc, "yes", "answer-1");
        seen.answered = esc;
      }
      await ctx.ops.ack(
        (await ctx.ops.peek()).filter((signal) => signal.kind === "escalation").map((s) => s.id),
        "attention-ack",
      );
      await ctx.ops.suspend({ phase: 2, child: rec.id }, { kind: "child_exited", children: [rec.id], mode: "all" }, "park-2");
    },
  };
}

test("a child's ask reaches the parent that waits on it; the parent resumes after the child exits and answers the same escalation", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  try {
    const a: { esc?: string; childAnswer?: string } = {};
    const w: Parameters<typeof waiter>[0] = {};
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [asker(a), waiter(w)], []);
    await one.host.start(await rootId(one), startReq(WAITER, "ans-1", { mode: "answer" }));
    await until(() => w.answered !== undefined, 10_000);
    assert.ok(a.esc, "the child raised an escalation");
    assert.equal(w.esc, a.esc, "the parent reaped the child and read the same escalation id");
    const esc = await one.store.escalations.get(a.esc!);
    assert.equal(esc?.state, "answered");
    assert.equal(esc?.answer, "yes");
    assert.equal(a.childAnswer, "refused", "the child, not the holder, cannot answer its own ask");
    assert.equal(w.staleRefused, true, "a stage-0 wrapper is fenced once the task has resumed");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passing a child's ask forwards the same escalation id to the operator; no second ask is raised", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  try {
    const a: { esc?: string } = {};
    const w: Parameters<typeof waiter>[0] = {};
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [asker(a), waiter(w)], []);
    await one.host.start(await rootId(one), startReq(WAITER, "pass-1", { mode: "pass" }));
    await until(() => w.passed !== undefined, 10_000);
    const esc = await one.store.escalations.get(a.esc!);
    assert.equal(esc?.id, a.esc, "the escalation keeps its original id");
    assert.equal(esc?.holder, null, "the ask is forwarded to the operator (null holder)");
    assert.equal(esc?.state, "open", "a pass does not answer the ask");
    const raised = (await one.store.journal.read({ agent: esc!.agent })).filter((e) => e.payload.kind === "escalation_raised");
    assert.equal(raised.length, 1, "one raise, no duplicate ask");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

const fresh = () => ({ opened: {}, states: {} }) as Parameters<typeof approver>[0];
// Approver opens an approval (keyed), records it, then parks on a short timer so the test can decide it.
function approver(seen: {
  id?: string;
  target?: string;
  bad?: string;
  again?: string;
  state?: string;
  opened: Record<string, string>;
  states: Record<string, string | undefined>;
}): WorkflowDef {
  return {
    name: "approver",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as Phase;
      if (st.phase === 0) {
        seen.bad = await ctx.ops.openApproval("publish", "NOT-A-SHA256", "bad-1").then(
          () => "accepted",
          () => "refused",
        );
        const target = (ctx.input as { target: string }).target;
        const ap = await ctx.ops.openApproval("publish", target, "ap-1");
        seen.id = ap.id;
        seen.opened[target] = ap.id;
        seen.target = ap.action.target;
        seen.again = (await ctx.ops.openApproval("publish", target, "ap-1")).id;
        assert.deepEqual(ap.rungs, ["operator", "owner"], "no agent approver may authorize publication");
        const differentDraft = target === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
        const mismatched = await ctx.ops.openApproval("publish", differentDraft, "ap-1");
        assert.notEqual(mismatched.id, ap.id, "a different draft requires its own human approval");
        assert.equal((await ctx.ops.getApproval(ap.id))!.action.target, target);
        await ctx.ops.suspend({ phase: 1, child: ap.id }, { kind: "timer", at: Date.now() + 400 }, "park-1");
        return;
      }
      const target = (ctx.input as { target: string }).target;
      const approval = await ctx.ops.getApproval(st.child!);
      seen.state = approval?.state;
      seen.states[target] = seen.state;
      if (approval?.state === "pending")
        await ctx.ops.suspend({ phase: 1, child: approval.id }, { kind: "timer", at: approval.deadlineAt }, `rung-${approval.rungIndex}`);
      await ctx.ops.submitResult({ summary: "decided" }, "decided");
    },
  };
}

// An unrelated workflow tries to read the approver's approval.
function reader(seen: { refused?: boolean }): WorkflowDef {
  return {
    name: "reader",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const id = (ctx.input as { id: string }).id;
      seen.refused = await ctx.ops.getApproval(id).then(
        () => false,
        () => true,
      );
      await ctx.ops.submitResult({ summary: "read" }, "read");
    },
  };
}

test("approval: a publish target that is not a sha256 is refused; a keyed open replays the same approval with its target preserved", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  try {
    const s = fresh();
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [approver(s)], []);
    const rec = await one.host.start(await rootId(one), startReq(APPROVER, "apv-1", { target: "a".repeat(64) }));
    await until(() => s.state !== undefined, 10_000);
    assert.equal(s.bad, "refused", "publish with a non-sha256 target is rejected");
    assert.equal(s.again, s.id, "a keyed replay returns the same approval");
    assert.equal(s.target, "a".repeat(64), "the target is preserved");
    await until(() => settled(one!, rec.id), 10_000);
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "approval outcomes: an approve and a deny decided by the operator are read back with their target; an undecided one settles fail-closed",
  TIMEOUT,
  async () => {
    const { dir, dbPath } = scratch("pomtreed-att-");
    let one: Boot | undefined;
    try {
      const cases = [
        { key: "ok", target: "a".repeat(64), decision: "approve" as const, expect: "approved" },
        { key: "no", target: "b".repeat(64), decision: "deny" as const, expect: "denied" },
        { key: "timeout", target: "c".repeat(64), decision: null, expect: "denied" },
      ];
      const s = fresh();
      one = await up(dir, dbPath, createFakes({ host: "h1" }), [approver(s)], []);
      for (const c of cases) {
        const rec = await one.host.start(await rootId(one), startReq(APPROVER, `case-${c.key}`, { target: c.target }));
        await until(() => s.opened[c.target] !== undefined, 10_000);
        const id = s.opened[c.target]!;
        if (c.decision) {
          await one.store.approvals!.decide(id, { who: "cli:operator", rank: "operator", decision: c.decision, why: c.key }, `d-${c.key}`);
        }
        await until(() => settled(one!, rec.id), 10_000);
        const ap = await one.store.approvals!.get(id);
        assert.equal(ap?.action.target, c.target, `${c.key}: target preserved`);
        assert.equal(s.states[c.target], c.expect, `${c.key}: getApproval outcome`);
      }
    } finally {
      closeQuietly(one);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("getApproval refuses an unrelated workflow: only the requester or the current holder may read an approval", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  try {
    const s = fresh();
    const r: { refused?: boolean } = {};
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [approver(s), reader(r)], []);
    const rec = await one.host.start(await rootId(one), startReq(APPROVER, "own-1", { target: "d".repeat(64) }));
    await until(() => s.id !== undefined, 10_000);
    await until(() => settled(one!, rec.id), 10_000);
    const other = await one.host.start(await rootId(one), startReq(READER, "other-1", { id: s.id! }));
    await until(() => settled(one!, other.id), 10_000);
    assert.equal(r.refused, true, "an unrelated workflow id is refused");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Parent waits on a hanging child, then (if it ever resumes) would start a second stage. Cancel or deadline must end it.
function parker(seen: { stage2?: boolean }): WorkflowDef {
  return {
    name: "parker",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx: WorkflowRunContext & { input: JsonValue }) {
      const st = (ctx.continuation ?? { phase: 0 }) as Phase;
      if (st.phase === 0) {
        const child = await ctx.ops.spawn({
          name: "hang",
          task: "t",
          idempotencyKey: "hang-1",
          executor: "deterministic",
          spec: { driver: HANG, input: null },
          budgetMicros: 200,
        });
        await ctx.ops.suspend({ phase: 1, child }, { kind: "child_exited", children: [child], mode: "all" }, "park-1");
        return;
      }
      seen.stage2 = true;
      await ctx.ops.submitResult({ summary: "late" }, "late");
    },
  };
}

test("cancel while yielded cascades to the waiting child; no downstream stage ever starts", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  try {
    const seen: { stage2?: boolean } = {};
    const hang = new FakeDeterministicExecutor(HANG);
    hang.setHandler(forever);
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [parker(seen)], [hang]);
    const rec = await one.host.start(await rootId(one), startReq(`${EXT}/parker`, "cancel-1"));
    await until(async () => (await one!.daemon.list({ parent: rec.id })).length === 1);
    const child = (await one.daemon.list({ parent: rec.id }))[0]!;
    await until(async () => (await get(one!, child.id)).state === "running");
    await until(async () => (await get(one!, rec.id)).state === "yielded");
    await one.daemon.cancel(rec.id);
    await until(() => settled(one!, rec.id), 10_000);
    assert.ok(await settled(one, child.id), "the waiting child is terminal");
    assert.equal(seen.stage2, undefined, "no downstream stage starts");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workflow passes the same held approval rung through the existing approval engine", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  const seen: { opened?: string; passed?: string } = {};
  const grant: WorkflowDef = {
    name: "grant",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx) {
      const approval = await ctx.ops.openApproval("budget_raise", `${ctx.agent}:${ctx.generation}:${ctx.generation}:1`, "grant");
      seen.opened = approval.id;
      await ctx.ops.suspend({ approval: approval.id }, { kind: "timer", at: Date.now() + 3600000 }, "park");
    },
  };
  const holder: WorkflowDef = {
    name: "holder",
    continuation: true,
    validate: (input) => ({ ok: true, value: input }),
    async run(ctx) {
      if (!ctx.continuation) {
        const child = await ctx.ops.spawn({
          executor: "deterministic",
          spec: { driver: `${EXT}/grant`, input: null },
          name: "grant",
          task: "grant",
          budgetMicros: 100,
          idempotencyKey: "grant",
        });
        await ctx.ops.suspend({ child }, { kind: "child_exited", children: [child], mode: "all" }, "child-wait");
      }
      const signal = (await ctx.ops.peek()).find((s) => s.kind === "escalation");
      if (signal?.kind !== "escalation") throw new Error("missing held approval");
      await ctx.ops.passEscalation(signal.escalation, "pass");
      seen.passed = signal.escalation;
      await ctx.ops.ack([signal.id], "ack");
      await ctx.ops.suspend(ctx.continuation!, { kind: "message" }, "passed");
    },
  };
  try {
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [holder, grant], []);
    const rec = await one.host.start(await rootId(one), startReq(`${EXT}/holder`, "approval-pass"));
    await until(() => seen.passed !== undefined);
    assert.equal(seen.passed, seen.opened);
    const approval = await one.store.approvals.get(seen.passed!);
    assert.equal(approval?.state, "pending");
    assert.equal(approval?.rungs[approval.rungIndex], "operator");
    assert.equal((await one.store.approvals.list()).length, 1, "passing never creates a replacement approval");
    await one.daemon.cancel(rec.id);
    await until(() => settled(one!, rec.id));
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deadline that fires while yielded cascades to the waiting child; no downstream stage ever starts", TIMEOUT, async () => {
  const { dir, dbPath } = scratch("pomtreed-att-");
  let one: Boot | undefined;
  try {
    const seen: { stage2?: boolean } = {};
    const hang = new FakeDeterministicExecutor(HANG);
    hang.setHandler(forever);
    one = await up(dir, dbPath, createFakes({ host: "h1" }), [parker(seen)], [hang]);
    const rec = await one.host.start(await rootId(one), startReq(`${EXT}/parker`, "deadline-1", null, { deadlineMs: 400 }));
    await until(() => settled(one!, rec.id), 10_000);
    const done = await get(one, rec.id);
    assert.notEqual(done.exit, "succeeded", "the deadline ends the yielded task");
    const kids = await one.daemon.list({ parent: rec.id });
    assert.equal(kids.length, 1);
    assert.ok(await settled(one, kids[0]!.id), "the waiting child is terminal");
    assert.equal(seen.stage2, undefined, "no downstream stage starts");
  } finally {
    closeQuietly(one);
    rmSync(dir, { recursive: true, force: true });
  }
});
