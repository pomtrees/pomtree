import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type {
  AgentId,
  Delivered,
  DeterministicOps,
  ExecutorReapReceipt,
  ExecutorSpawnRequest,
  ExitStatus,
  ExtensionHost,
  JsonValue,
  WorkflowRunContext,
  WorkflowRunOps,
} from "../../packages/core/src/index.ts";
import { type DiscussionSample, parseDiscussion } from "./discussion.mts";
import extension, {
  bindingSignature,
  buildPrompt,
  clipBytes,
  type InsightActive,
  type InsightInput,
  type InsightItem,
  insightWorkflow,
  parseModelResult,
  validateInput,
} from "./insight.mts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const url = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const HASH = sha("x");
const item = (id: number, rank: number, text = ""): Record<string, unknown> => ({
  id,
  rank,
  title: `Title ${id}`,
  text,
  score: 10,
  descendants: 2,
  sourceUrl: url(id),
  sha256: sha(`item ${id}`),
});
const goodInput = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  instance: "team_daily",
  items: [item(101, 1, "Plain <i>text</i> &amp; more"), item(102, 2)],
  budgetMicros: 50000,
  ask: true,
  ...over,
});
const parsedGood = (over: Partial<Record<string, unknown>> = {}): InsightInput => {
  const v = validateInput(goodInput(over));
  if (!v.ok) throw new Error(v.error);
  return v.value;
};

// An existing instance bound to the default batch, optionally overridden for a repair scenario.
function existing(over: Partial<InsightActive> = {}): InsightActive {
  const base = parsedGood();
  return {
    runId: "run-1",
    instance: "team_daily",
    binding: bindingSignature(base.items, base.budgetMicros, base.sentiment),
    items: base.items,
    budgetMicros: base.budgetMicros,
    sentiment: base.sentiment,
    modelAttempted: false,
    modelResult: null,
    confirmRequired: true,
    confirmed: false,
    phase: "plan",
    ...over,
  };
}

type Child = { exit: ExitStatus; spent?: number; result?: unknown; unused?: number };
// Ask behaviour for the escalation the host creates for the asking task. `stale` also delivers an answer addressed to a
// different (old task's) escalation first; a correct driver must ignore it.
type Reply = { kind: "answer"; body: string; stale?: boolean } | { kind: "cancel" } | { kind: "silent" };
type Opts = {
  child?: Child | "refuse" | "silent";
  crashBefore?: string;
  crashAfter?: string;
  failAckOf?: string;
  state?: InsightActive | null;
};
type Env = ReturnType<typeof makeEnv>;

// Scripted host stand-in. Each ctx.agent (task) has its own inbox; ops.peek/ack act only on the calling task's inbox.
// human_answer is delivered only to the inbox of the task that asked, under an escalation scoped to that task.
// Reports and outbox are deduped by key; a crash is injected once.
function makeEnv(instance: string, opts: Opts) {
  const log: string[] = [];
  const script: { ask: Reply } = { ask: { kind: "answer", body: "yes" } };
  const state = new Map<string, unknown>();
  if (opts.state !== undefined) state.set(instance, { schema: "hn-insight/2", active: opts.state });
  const reports = new Map<string, { id: string; name: string; content: string }>();
  const outbox = new Map<string, string>();
  const spawns: ExecutorSpawnRequest[] = [];
  const acks: Array<{ agent: string; id: string }> = [];
  const asks: Array<{ agent: string; question: string; key: string; escalation: string }> = [];
  const results: Array<{ summary: string; key: string }> = [];
  const receipts = new Map<AgentId, ExecutorReapReceipt>();
  const inboxes = new Map<string, Delivered[]>();
  const inboxOf = (agent: string): Delivered[] => {
    let box = inboxes.get(agent);
    if (box === undefined) {
      box = [];
      inboxes.set(agent, box);
    }
    return box;
  };
  let crashed = false;
  const guard =
    <A extends unknown[], R>(name: string, fn: (...a: A) => R | Promise<R>) =>
    async (...a: A): Promise<R> => {
      log.push(name);
      if (opts.crashBefore === name && !crashed) {
        crashed = true;
        throw new Error(`simulated crash before ${name}`);
      }
      const out = await fn(...a);
      if (opts.crashAfter === name && !crashed) {
        crashed = true;
        throw new Error(`simulated crash after ${name}`);
      }
      return out;
    };

  const unusedContinuationOp = async (): Promise<never> => {
    throw new Error("legacy insight fixture does not use continuation ops");
  };
  const opsFor = (agent: string): DeterministicOps => ({
    findChild: unusedContinuationOp,
    suspend: unusedContinuationOp,
    answerEscalation: unusedContinuationOp,
    passEscalation: unusedContinuationOp,
    openApproval: unusedContinuationOp,
    getApproval: unusedContinuationOp,
    peek: async () => structuredClone(inboxOf(agent)),
    ack: guard("ack", async (ids: string[]) => {
      if (opts.failAckOf !== undefined && ids.includes(opts.failAckOf) && !crashed) {
        crashed = true;
        throw new Error("simulated crash before confirm ack");
      }
      for (const id of ids) acks.push({ agent, id });
      const box = inboxOf(agent);
      const kept = box.filter((s) => !ids.includes(s.id));
      box.splice(0, box.length, ...kept);
      return ids;
    }),
    message: async () => {
      throw new Error("message not used");
    },
    spawn: guard("spawn", async (req: ExecutorSpawnRequest) => {
      spawns.push(req);
      if (opts.child === "refuse") throw new Error("spawn refused by host");
      const child = `child-${spawns.length}`;
      const c: Child = opts.child === undefined || opts.child === "silent" ? { exit: "succeeded", spent: 0 } : opts.child;
      if (opts.child !== "silent") {
        const budget = req.budgetMicros ?? 0;
        const spent = c.spent ?? 0;
        receipts.set(child, {
          child,
          state: "reaped",
          exit: c.exit,
          result: c.result ?? null,
          unusedMicros: c.unused ?? Math.max(0, budget - spent),
        });
        inboxOf(agent).push({
          kind: "child_exited",
          id: `sig-${child}`,
          child,
          exit: c.exit,
          spentMicros: spent,
          budgetMicros: budget,
        } as Delivered);
      }
      return child;
    }),
    reap: guard("reap", async (child: AgentId) => {
      const r = receipts.get(child);
      if (r === undefined) throw new Error("no such child");
      return r;
    }),
    submitResult: guard("submitResult", async (h: { summary: string }, key: string) => {
      results.push({ summary: h.summary, key });
    }),
  });
  const workflowFor = (agent: string): WorkflowRunOps => ({
    instance,
    runKey: "run-1",
    // No fetch capability is declared: any call is a contract violation and must fail closed.
    fetch: async () => {
      throw new Error("fetch not declared");
    },
    store: {
      get: guard("store.get", async () => {
        throw new Error("not used");
      }),
      put: guard("store.put", async () => {
        throw new Error("not used");
      }),
      list: guard("store.list", async () => {
        throw new Error("not used");
      }),
      rm: guard("store.rm", async () => {
        throw new Error("not used");
      }),
    },
    shared: {
      get: guard("shared.get", async () => {
        throw new Error("not used");
      }),
      put: guard("shared.put", async () => {
        throw new Error("not used");
      }),
      list: guard("shared.list", async () => {
        throw new Error("not used");
      }),
      rm: guard("shared.rm", async () => {
        throw new Error("not used");
      }),
    },
    getState: guard("getState", async () => structuredClone((state.get(instance) ?? null) as JsonValue | null)),
    setState: guard("setState", async (v: JsonValue) => {
      state.set(instance, structuredClone(v));
    }),
    publishReport: guard("publishReport", async (rep: { name: string; content: string }, key: string) => {
      if (!reports.has(key)) reports.set(key, { id: `rpt:${key}`, name: rep.name, content: rep.content });
      return { id: `rpt:${key}`, agent: "a1" } as never;
    }),
    sendToUser: guard("sendToUser", async (body: string, key: string) => {
      if (!outbox.has(key)) outbox.set(key, body);
    }),
    ask: guard("ask", async (question: string, key: string) => {
      const escalation = `esc:${agent}:${key}`;
      asks.push({ agent, question, key, escalation });
      const box = inboxOf(agent);
      const r = script.ask;
      if (r.kind === "cancel") box.push({ kind: "cancel", id: `cancel:${escalation}`, graceMs: 0 } as Delivered);
      if (r.kind === "answer") {
        if (r.stale === true) {
          box.push({
            kind: "human_answer",
            id: `stale:${escalation}`,
            escalation: `esc:old:${key}`,
            from: { channel: "discord", sender: "u1" },
            body: "yes",
          } as Delivered);
        }
        box.push({ kind: "human_answer", id: `ans:${escalation}`, escalation, from: { channel: "discord", sender: "u1" }, body: r.body } as Delivered);
      }
      return { escalation };
    }),
  });
  return { log, state, reports, outbox, spawns, acks, asks, results, script, inboxOf, opsFor, workflowFor };
}

// A typed WorkflowRunContext for one task (ctx.agent). Ops and workflow are bound to that task's inbox and escalations.
function ctxOf(env: Env, input: unknown, signal?: AbortSignal, agent = "a1"): WorkflowRunContext & { input: InsightInput } {
  const v = validateInput(input);
  if (!v.ok) throw new Error(v.error);
  return {
    agent,
    generation: 1,
    host: "h1",
    input: v.value as unknown as JsonValue,
    signal: signal ?? new AbortController().signal,
    deadlineAt: null,
    ops: env.opsFor(agent),
    workflow: env.workflowFor(agent),
  } as WorkflowRunContext & { input: InsightInput };
}

const ansId = (escalation: string) => `ans:${escalation}`;
const savedActive = (env: Env): InsightActive => (env.state.get("team_daily") as { active: InsightActive }).active;
const modelOk = (items: Array<{ id: number; basis: string; observation?: string }>) => ({
  summary: "tentative",
  insights: items.map((i) => ({ id: i.id, observation: i.observation ?? "tentative note", basis: i.basis, tentative: true })),
});
const okChild: Child = {
  exit: "succeeded",
  spent: 1200,
  result: modelOk([
    { id: 101, basis: "hn_text" },
    { id: 102, basis: "ranked_metadata" },
  ]),
};

describe("validateInput", () => {
  it("accepts a normalized input, defaults ask to true, and allows underscore instances", () => {
    const v = validateInput(goodInput({ ask: undefined }));
    if (!v.ok) throw new Error(v.error);
    assert.equal(v.value.ask, true);
    assert.equal(v.value.instance, "team_daily");
    assert.equal(v.value.items[0]?.text, "Plain text & more");
  });
  it("rejects bad ranges, counts, URLs, hashes and unknown keys", () => {
    const bad: Array<Record<string, unknown>> = [
      goodInput({ items: [] }),
      goodInput({ items: [item(1, 1), item(2, 2), item(3, 3), item(4, 4)] }),
      goodInput({ budgetMicros: 0 }),
      goodInput({ budgetMicros: 100001 }),
      goodInput({ instance: "_team" }),
      goodInput({ extra: 1 }),
      goodInput({ items: [{ ...item(101, 1), sourceUrl: "https://evil.example/v0/item/101.json" }] }),
      goodInput({ items: [{ ...item(101, 1), sha256: "ABC" }] }),
      goodInput({ items: [{ ...item(101, 501) }] }),
      goodInput({ items: [item(101, 1), item(101, 2)] }),
    ];
    for (const b of bad) assert.equal(validateInput(b).ok, false);
  });
  it("clips title to 300 and text to 2000 characters", () => {
    const v = validateInput(goodInput({ items: [{ ...item(101, 1), title: "t".repeat(400), text: "x".repeat(3000) }] }));
    if (!v.ok) throw new Error(v.error);
    assert.equal(Array.from(v.value.items[0]?.title ?? "").length, 300);
    assert.equal(Array.from(v.value.items[0]?.text ?? "").length, 2000);
  });
});

describe("parseModelResult", () => {
  const items: InsightItem[] = [
    { id: 101, rank: 1, title: "A", text: "has text", sourceUrl: url(101), sha256: HASH },
    { id: 102, rank: 2, title: "B", text: "", sourceUrl: url(102), sha256: HASH },
  ];
  it("accepts valid insights and clips observations to 600", () => {
    const r = parseModelResult(modelOk([{ id: 101, basis: "hn_text", observation: "o".repeat(900) }]), items);
    if (!r.ok) throw new Error(r.error);
    assert.equal(r.value.value.insights[0]?.observation.length, 600);
    assert.equal(r.value.value.insights[0]?.tentative, true);
  });
  it("discards unknown, duplicate, and wrongly-based ids", () => {
    const r = parseModelResult(
      modelOk([
        { id: 999, basis: "hn_text" },
        { id: 101, basis: "hn_text" },
        { id: 101, basis: "hn_text" },
        { id: 102, basis: "hn_text" },
        { id: 102, basis: "ranked_metadata" },
      ]),
      items,
    );
    if (!r.ok) throw new Error(r.error);
    assert.deepEqual(
      r.value.value.insights.map((i) => [i.id, i.basis]),
      [
        [101, "hn_text"],
        [102, "ranked_metadata"],
      ],
    );
    assert.equal(r.value.discarded, 3);
  });
  it("fails the whole result on malformed structure or non-tentative claims", () => {
    assert.equal(parseModelResult("nope", items).ok, false);
    assert.equal(parseModelResult({ summary: "s", insights: [], extra: 1 }, items).ok, false);
    assert.equal(parseModelResult({ summary: "s", insights: [{ id: 101, observation: "o", basis: "hn_text", tentative: false }] }, items).ok, false);
    assert.equal(parseModelResult({ summary: "s", insights: [{ id: 101, observation: "o", basis: "web", tentative: true }] }, items).ok, false);
  });
});

describe("clipBytes", () => {
  it("bounds bytes on whole code points and keeps valid text", () => {
    const s = "😀".repeat(20000);
    const out = clipBytes(s, 65536);
    assert.ok(new TextEncoder().encode(out).byteLength <= 65536);
    assert.equal(clipBytes("short", 65536), "short");
  });
});

describe("insightWorkflow run", () => {
  it("has no fetch capability and is named synthesize", () => {
    assert.equal(insightWorkflow.name, "synthesize");
    assert.equal(insightWorkflow.capabilities?.fetch, undefined);
    assert.equal(insightWorkflow.capabilities?.modelChildren?.maxBudgetMicros, 100000);
  });

  it("spawns one bounded child, reaps before ack, confirms, publishes, and stores a sticky complete receipt", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    await insightWorkflow.run(ctxOf(env, goodInput()));
    assert.equal(env.spawns.length, 1);
    assert.equal(env.spawns[0]?.budgetMicros, 50000);
    assert.equal(env.spawns[0]?.deadlineMs, 60000);
    assert.equal(env.spawns[0]?.idempotencyKey, "run-1:model");
    assert.match(env.spawns[0]?.task, /pomtree result --key hn-insight-result/);
    const reapAt = env.log.indexOf("reap");
    assert.ok(reapAt > env.log.indexOf("spawn") && reapAt < env.log.indexOf("ack"));
    assert.equal(env.asks.length, 1);
    assert.match(env.asks[0]?.question ?? "", /item 101/);
    assert.doesNotMatch(env.asks[0]?.question ?? "", /spend|budget/i);
    const report = env.reports.get("run-1:report");
    assert.equal(report?.name, "hn-insight-team_daily.md");
    assert.match(report?.content ?? "", /TENTATIVE/);
    assert.match(report?.content ?? "", /requested: deepseek\/deepseek-flash; actual route\/model\/cost require host scenario manifest verification/);
    assert.equal(env.outbox.size, 1);
    assert.deepEqual(env.results, [{ summary: "HN insight team_daily: 2 item(s); model tentative synthesis", key: "run-1:result" }]);
    assert.deepEqual(env.acks, [
      { agent: "a1", id: "sig-child-1" },
      { agent: "a1", id: ansId(env.asks[0]?.escalation ?? "") },
    ]);
    const a = savedActive(env);
    assert.equal(a.phase, "complete");
    assert.equal(a.report?.id, "rpt:run-1:report");
    assert.equal("escalation" in a, false);
    assert.equal("pendingAck" in a, false);
  });

  it("labels metadata-only synthesis when item text is absent and wrong ids are discarded", async () => {
    const env = makeEnv("team_daily", {
      child: {
        exit: "succeeded",
        result: modelOk([
          { id: 101, basis: "hn_text" },
          { id: 555, basis: "ranked_metadata" },
          { id: 102, basis: "ranked_metadata" },
        ]),
      },
    });
    await insightWorkflow.run(ctxOf(env, goodInput({ items: [item(102, 1), item(103, 2)] })));
    const content = env.reports.get("run-1:report")?.content ?? "";
    assert.doesNotMatch(content, /item 555/);
    assert.match(content, /item 102 \[ranked_metadata\]/);
    assert.match(content, /text: \(none captured\)/);
  });

  it("falls back to extracted facts on spawn refusal, failed, over-budget, and malformed child results", async () => {
    const cases: Array<{ child: Child | "refuse"; cause: RegExp }> = [
      { child: "refuse", cause: /spawn refused/ },
      { child: { exit: "failed" }, cause: /model child failed/ },
      { child: { exit: "succeeded", spent: 60000 }, cause: /over budget/ },
      { child: { exit: "succeeded", result: { summary: 1 } }, cause: /malformed/ },
    ];
    for (const c of cases) {
      const env = makeEnv("team_daily", { child: c.child });
      await insightWorkflow.run(ctxOf(env, goodInput()));
      assert.match(env.reports.get("run-1:report")?.content ?? "", c.cause);
      assert.equal(env.results.length, 1);
    }
  });

  it("never respawns an interrupted or not-started model step and uses neutral wording", async () => {
    const env = makeEnv("team_daily", { child: okChild, state: existing({ modelAttempted: true }) });
    await insightWorkflow.run(ctxOf(env, goodInput()));
    assert.equal(env.spawns.length, 0);
    const content = env.reports.get("run-1:report")?.content ?? "";
    assert.match(content, /model step interrupted or not started; no retry attempted/);
    assert.doesNotMatch(content, /paid|charged/i);
    assert.equal(env.results.length, 1);
  });

  it("crash after the complete receipt and before submitResult: repair replays only the result, no respawn or duplicate report", async () => {
    const env = makeEnv("team_daily", { child: okChild, crashBefore: "submitResult" });
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput())), /simulated crash before submitResult/);
    assert.equal(savedActive(env).phase, "complete");
    await insightWorkflow.run(ctxOf(env, goodInput(), undefined, "a2"));
    assert.equal(env.spawns.length, 1);
    assert.equal(env.reports.size, 1);
    assert.equal(env.outbox.size, 1);
    assert.equal(env.asks.length, 1);
    assert.deepEqual(
      env.results.map((r) => r.key),
      ["run-1:result"],
    );
  });

  it("crash after sendToUser: repair reuses the original keys without duplicates or a fresh ask", async () => {
    const env = makeEnv("team_daily", { child: okChild, crashAfter: "sendToUser" });
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput())), /simulated crash after sendToUser/);
    await insightWorkflow.run(ctxOf(env, goodInput(), undefined, "a2"));
    assert.equal(env.reports.size, 1);
    assert.equal(env.outbox.size, 1);
    assert.equal(env.spawns.length, 1);
    assert.equal(env.asks.length, 1);
    assert.equal(env.results.length, 1);
  });

  it("decline persists a terminal receipt; repair throws without spawn, report or outbox", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    env.script.ask = { kind: "answer", body: "no" };
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput())), /declined/);
    assert.equal(savedActive(env).phase, "declined");
    assert.deepEqual(env.acks.at(-1), { agent: "a1", id: ansId(env.asks[0]?.escalation ?? "") });
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput(), undefined, "a2")), /declined/);
    assert.equal(env.spawns.length, 1);
    assert.equal(env.asks.length, 1);
    assert.equal(env.reports.size, 0);
    assert.equal(env.outbox.size, 0);
    assert.equal(env.results.length, 0);
  });

  it("cancel leaves the plan blocked: confirmRequired kept, not confirmed, no escalation persisted", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    env.script.ask = { kind: "cancel" };
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput())), /cancelled/);
    const a = savedActive(env);
    assert.equal(a.confirmRequired, true);
    assert.equal(a.confirmed, false);
    assert.equal(a.modelAttempted, true);
    assert.equal("escalation" in a, false);
    assert.equal(env.reports.size, 0);
  });

  it("cross-task repair: old ask cancelled; new task with ask:false honors the saved requirement, asks on its own escalation, ignores the stale reply, and publishes once", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    env.script.ask = { kind: "cancel" };
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput(), undefined, "a1")), /cancelled/);
    assert.equal(savedActive(env).confirmed, false);
    assert.equal(savedActive(env).confirmRequired, true);

    env.script.ask = { kind: "answer", body: "yes", stale: true };
    await insightWorkflow.run(ctxOf(env, goodInput({ ask: false }), undefined, "a2"));
    assert.equal(env.asks.length, 2);
    assert.equal(env.asks[1]?.agent, "a2");
    assert.equal(env.asks[1]?.key, "run-1:confirm");
    assert.notEqual(env.asks[1]?.escalation, env.asks[0]?.escalation ?? "");
    assert.equal(env.spawns.length, 1);
    assert.deepEqual([...env.reports.keys()], ["run-1:report"]);
    assert.equal(env.outbox.size, 1);
    assert.deepEqual(env.results, [{ summary: "HN insight team_daily: 2 item(s); model tentative synthesis", key: "run-1:result" }]);
    // Only the new task's own answer is acked; the stale and old-task signals are never touched by this task.
    assert.deepEqual(
      env.acks.filter((x) => x.agent === "a2").map((x) => x.id),
      [ansId(env.asks[1]?.escalation)],
    );
    assert.equal(
      env.acks.some((x) => x.id.startsWith("stale:")),
      false,
    );
    assert.equal(savedActive(env).phase, "complete");
  });

  it("confirmed repair asks nothing and acks nothing foreign after an ack failure following the durable marker", async () => {
    const env = makeEnv("team_daily", { child: okChild, failAckOf: ansId("esc:a1:run-1:confirm") });
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput())), /simulated crash before confirm ack/);
    const a = savedActive(env);
    assert.equal(a.confirmed, true);
    assert.equal(env.reports.size, 0);
    await insightWorkflow.run(ctxOf(env, goodInput(), undefined, "a2"));
    assert.equal(env.asks.length, 1);
    assert.equal(env.spawns.length, 1);
    assert.equal(env.reports.size, 1);
    assert.equal(env.results.length, 1);
    assert.deepEqual(
      env.acks.filter((x) => x.agent === "a2"),
      [],
    );
  });

  it("rejects a repair with different items or budget before any spawn", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    await insightWorkflow.run(ctxOf(env, goodInput()));
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput({ budgetMicros: 40000 }), undefined, "a2")), /different batch/);
    await assert.rejects(insightWorkflow.run(ctxOf(env, goodInput({ items: [item(103, 1)] }), undefined, "a2")), /different batch/);
    assert.equal(env.spawns.length, 1);
    assert.equal(env.results.length, 1);
  });

  it("ask:false publishes without asking; a repair with ask:true raises the requirement and is never lowered", async () => {
    const quiet = makeEnv("team_daily", { child: okChild });
    await insightWorkflow.run(ctxOf(quiet, goodInput({ ask: false })));
    assert.equal(quiet.asks.length, 0);
    assert.equal(quiet.reports.size, 1);

    const raised = makeEnv("team_daily", { child: okChild, state: existing({ modelAttempted: true, confirmRequired: false }) });
    await insightWorkflow.run(ctxOf(raised, goodInput({ ask: true })));
    assert.equal(raised.asks.length, 1);

    const kept = makeEnv("team_daily", { child: okChild, state: existing({ modelAttempted: true, confirmRequired: true }) });
    await insightWorkflow.run(ctxOf(kept, goodInput({ ask: false })));
    assert.equal(kept.asks.length, 1);
  });

  it("confirmed saved state: a fresh task asks nothing and publishes", async () => {
    const env = makeEnv("team_daily", {
      child: okChild,
      state: existing({ modelAttempted: true, phase: "model", confirmed: true, confirmRequired: true }),
    });
    await insightWorkflow.run(ctxOf(env, goodInput(), undefined, "a2"));
    assert.equal(env.asks.length, 0);
    assert.equal(env.reports.size, 1);
    assert.equal(env.results.length, 1);
  });

  it("ignores non-matching human answers without acking them", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    env.script.ask = { kind: "silent" };
    env
      .inboxOf("a1")
      .push({ kind: "human_answer", id: "other", escalation: "esc:other", from: { channel: "discord", sender: "u2" }, body: "yes" } as Delivered);
    const p = insightWorkflow.run(ctxOf(env, goodInput()));
    setTimeout(() => env.inboxOf("a1").push({ kind: "cancel", id: "c", graceMs: 0 } as Delivered), 30);
    await assert.rejects(p, /cancelled/);
    assert.equal(
      env.acks.some((x) => x.id === "other"),
      false,
    );
    assert.equal(env.reports.size, 0);
  });

  it("aborts without a report when cancelled during the model wait", async () => {
    const env = makeEnv("team_daily", { child: "silent" });
    const ac = new AbortController();
    const p = insightWorkflow.run(ctxOf(env, goodInput(), ac.signal));
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, /wait aborted/);
    assert.equal(env.reports.size, 0);
  });

  it("keeps the report within 64 KiB with three maximal multibyte items and clipped text", async () => {
    const big = (id: number, rank: number) => ({
      ...item(id, rank, "😀".repeat(2000)),
      title: "🙂".repeat(300),
    });
    const env = makeEnv("team_daily", {
      child: {
        exit: "succeeded",
        result: modelOk([
          { id: 101, basis: "hn_text", observation: "🙂".repeat(600) },
          { id: 102, basis: "hn_text", observation: "🙂".repeat(600) },
          { id: 103, basis: "hn_text", observation: "🙂".repeat(600) },
        ]),
      },
    });
    await insightWorkflow.run(ctxOf(env, goodInput({ items: [big(101, 1), big(102, 2), big(103, 3)] })));
    const content = env.reports.get("run-1:report")?.content ?? "";
    assert.ok(new TextEncoder().encode(content).byteLength <= 65536);
    for (const id of [101, 102, 103]) assert.match(content, new RegExp(`\\[item ${id}\\]`));
  });

  it("rejects an invalid input before any effect", async () => {
    const env = makeEnv("team_daily", { child: { exit: "succeeded" } });
    const ctx = { ...ctxOf(env, goodInput()), input: { ...goodInput(), budgetMicros: 100001 } as unknown as InsightInput };
    await assert.rejects(insightWorkflow.run(ctx as WorkflowRunContext & { input: InsightInput }), /budgetMicros/);
    assert.equal(env.spawns.length, 0);
    assert.equal(env.state.size, 0);
  });
});

describe("default extension", () => {
  it("manifest is hn-insight and init registers the workflow only through host.workflow", () => {
    assert.equal(extension.manifest.name, "hn-insight");
    assert.equal(extension.manifest.entry, "entry.mts");
    const seen: string[] = [];
    const host = { workflow: (d: { name: string }) => seen.push(d.name) } as unknown as ExtensionHost;
    extension.init?.(host);
    assert.deepEqual(seen, ["synthesize"]);
  });
});

// ---- Discussion sentiment integration (offline; fixtures are synthetic, not captured from HN) ----
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./discussion-fixtures/${name}`, import.meta.url), "utf8"));
const META = { sha256: sha("captured-body"), fetchedAt: 1700000999 };
const sampleOf = (file: string, id: number): DiscussionSample => parseDiscussion(fixture(file), id, 100, META);
const story = (over: Record<string, unknown> = {}): InsightItem => ({ ...item(100, 1, "A story text."), ...over }) as unknown as InsightItem;
const withDiscussion = (samples: DiscussionSample[]): InsightItem => ({ ...story(), discussion: samples });
const usable2 = () => [sampleOf("comment_201_usable.json", 201), sampleOf("comment_202_usable.json", 202)];
const sentimentObj = (file: string, citations?: number[]) => {
  const raw = fixture(file) as Record<string, unknown>;
  return citations === undefined ? raw : { ...raw, citations };
};
const modelWith = (insights: unknown[]) => ({ summary: "tentative", insights });
const ins = (id: number, basis: string, sentiment?: unknown) => ({
  id,
  observation: "tentative note",
  basis,
  tentative: true,
  ...(sentiment === undefined ? {} : { sentiment }),
});

describe("discussion validation", () => {
  it("keeps legacy inputs unchanged and defaults sentiment to false", () => {
    const v = validateInput(goodInput());
    if (!v.ok) throw new Error(v.error);
    assert.equal(v.value.sentiment, false);
    const item = v.value.items[0];
    assert.ok(item);
    assert.equal("discussion" in item, false);
    assert.equal(validateInput(goodInput({ sentiment: "yes" })).ok, false);
  });
  it("accepts captured samples, sanitizes usable quotes, and empties non-usable text", () => {
    const html = sampleOf("comment_207_html.json", 207);
    const dead = sampleOf("comment_204_dead.json", 204);
    const v = validateInput(goodInput({ sentiment: true, items: [{ ...story(), discussion: [html, dead] }] }));
    if (!v.ok) throw new Error(v.error);
    const [h, d] = v.value.items[0]?.discussion ?? [];
    assert.equal(v.value.sentiment, true);
    assert.ok(h);
    assert.doesNotMatch(h.text, /<(p|i|br|script|style)\b|alert/);
    assert.equal(d?.text, "");
    assert.equal(d?.status, "dead");
  });
  it("clips usable quotes to 1000 characters", () => {
    const long = { ...sampleOf("comment_201_usable.json", 201), text: "q".repeat(1500) };
    const v = validateInput(goodInput({ items: [{ ...story(), discussion: [long] }] }));
    if (!v.ok) throw new Error(v.error);
    assert.equal(Array.from(v.value.items[0]?.discussion?.[0]?.text ?? "").length, 1000);
  });
  it("rejects more than two samples, mismatched story or parent, unknown or author fields, and bad hashes", () => {
    const [a, b] = usable2();
    const third = sampleOf("comment_208_no_time.json", 208);
    const bad: unknown[] = [
      { ...story(), discussion: [a, b, third] },
      { ...story(), discussion: [{ ...a, storyId: 999 }] },
      { ...story(), discussion: [{ ...a, parent: 999 }] },
      { ...story(), discussion: [{ ...a, author: "someone" }] },
      { ...story(), discussion: [{ ...a, sha256: "ABC" }] },
      { ...story(), discussion: [{ ...a, status: "maybe" }] },
      { ...story(), discussion: [a, a] },
    ];
    for (const it of bad) assert.equal(validateInput(goodInput({ items: [it] })).ok, false);
  });
  it("binds the sentiment flag and normalized discussion: a different batch fails before any spawn", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    const first = goodInput({ items: [withDiscussion(usable2())], sentiment: false });
    await insightWorkflow.run(ctxOf(env, first));
    await assert.rejects(insightWorkflow.run(ctxOf(env, { ...first, sentiment: true }, undefined, "a2")), /different batch/);
    assert.equal(env.spawns.length, 1);
  });
});

describe("grounded sentiment parsing", () => {
  const items = (): InsightItem[] => {
    const v = validateInput(goodInput({ sentiment: true, items: [withDiscussion(usable2())] }));
    if (!v.ok) throw new Error(v.error);
    return v.value.items;
  };
  it("accepts a grounded mixed sentiment and keeps the model's citations only", () => {
    const r = parseModelResult(modelWith([ins(100, "hn_discussion", sentimentObj("sentiment_mixed.json"))]), items(), true);
    if (!r.ok) throw new Error(r.error);
    const s = r.value.value.insights[0]?.sentiment;
    assert.equal(s?.label, "mixed");
    assert.deepEqual(s?.citations, [201, 202]);
    assert.equal(s?.tentative, true);
    assert.equal("score" in (s ?? {}), false);
  });
  it("rejects unknown, cross-story, duplicate-citation fixtures and fails the whole result", () => {
    for (const f of ["sentiment_unknown_citation.json", "sentiment_cross_story.json", "sentiment_duplicate_citation.json"]) {
      assert.equal(parseModelResult(modelWith([ins(100, "hn_discussion", sentimentObj(f))]), items(), true).ok, false, f);
    }
  });
  it("rejects a deleted or unusable citation", () => {
    const deleted = sentimentObj("sentiment_mixed.json", [201, 203]);
    const r = parseModelResult(
      modelWith([ins(100, "hn_discussion", deleted)]),
      [story({ discussion: [sampleOf("comment_201_usable.json", 201), sampleOf("comment_203_deleted.json", 203)] })],
      true,
    );
    assert.equal(r.ok, false);
  });
  it("fails when usable comments exist but the grounded sentiment is missing or invalid (no fabricated label)", () => {
    assert.equal(parseModelResult(modelWith([ins(100, "hn_discussion")]), items(), true).ok, false);
    assert.equal(
      parseModelResult(modelWith([ins(100, "hn_discussion", { label: "great", target: "t", summary: "s", citations: [201] })]), items(), true).ok,
      false,
    );
  });
  it("forces unclear for a single usable comment and ignores the model for zero usable comments", () => {
    const one = [story({ discussion: [sampleOf("comment_201_usable.json", 201)] })];
    const r1 = parseModelResult(modelWith([ins(100, "hn_discussion", sentimentObj("sentiment_mixed.json", [201]))]), one, true);
    if (!r1.ok) throw new Error(r1.error);
    assert.equal(r1.value.value.insights[0]?.sentiment?.label, "unclear");
    const none = [story({ discussion: [sampleOf("comment_203_deleted.json", 203)] })];
    const r0 = parseModelResult(modelWith([ins(100, "ranked_metadata", sentimentObj("sentiment_mixed.json", [201]))]), none, true);
    if (!r0.ok) throw new Error(r0.error);
    const first = r0.value.value.insights[0];
    assert.ok(first);
    assert.equal(first.sentiment, undefined);
  });
  it("rejects a sentiment key when sentiment was not requested", () => {
    assert.equal(parseModelResult(modelWith([ins(100, "hn_discussion", sentimentObj("sentiment_mixed.json"))]), items(), false).ok, false);
  });
});

describe("discussion sentiment run", () => {
  it("prompt carries only bounded captured quotes and the sample-only disclaimers", () => {
    const p = buildPrompt([story({ discussion: usable2() })], true);
    assert.match(p, /captured_depth1_sample_only/);
    assert.match(p, /ranked display order/);
    assert.match(p, /not representative/);
    assert.doesNotMatch(p, /"author"|"profile"|"demographic"/);
    assert.match(p, /I like the/);
    assert.match(p, /"comment_id":201/);
  });
  it("renders evidence, tentative synthesis, and sampled sentiment separately with citations and the hash rule", async () => {
    const samples = [sampleOf("comment_201_usable.json", 201), sampleOf("comment_202_usable.json", 202), sampleOf("comment_203_deleted.json", 203)];
    const env = makeEnv("team_daily", {
      child: { exit: "succeeded", result: modelWith([ins(100, "hn_discussion", sentimentObj("sentiment_mixed.json"))]) },
    });
    const inputItem = { ...story(), discussion: samples.slice(0, 2) };
    await insightWorkflow.run(ctxOf(env, goodInput({ items: [inputItem], sentiment: true })));
    const c = env.reports.get("run-1:report")?.content ?? "";
    assert.match(c, /DISCUSSION EVIDENCE/);
    assert.match(c, /SAMPLED SENTIMENT/);
    assert.match(c, /item 100: mixed · target: captured comments on story 100 · citations: 201, 202/);
    assert.match(c, /comment 201 · usable/);
    assert.match(c, /quote: I like the/);
    assert.match(c, /linked articles not read/);
    assert.doesNotMatch(c, /(we|model) (read|summari[sz]ed|opened) (the |any )?(linked )?articles?/i);
  });
  it("zero usable comments yields insufficient_discussion_data and no invented score", async () => {
    const env = makeEnv("team_daily", { child: { exit: "succeeded", result: modelWith([]) } });
    const uncaptured = { ...sampleOf("comment_204_dead.json", 204), sha256: "0".repeat(64), fetchedAt: 0 };
    const dead = { ...story(), discussion: [sampleOf("comment_203_deleted.json", 203), uncaptured] };
    await insightWorkflow.run(ctxOf(env, goodInput({ items: [dead], sentiment: true })));
    const c = env.reports.get("run-1:report")?.content ?? "";
    assert.match(c, /insufficient_discussion_data/);
    const sentimentPart = c.slice(c.indexOf("SAMPLED SENTIMENT"));
    assert.doesNotMatch(sentimentPart, /score|confidence|probability/i);
    assert.match(c, /raw hash: not captured/);
  });
  it("missing grounded sentiment falls back to facts only without a label", async () => {
    const env = makeEnv("team_daily", { child: { exit: "succeeded", result: modelWith([ins(100, "hn_text")]) } });
    await insightWorkflow.run(ctxOf(env, goodInput({ items: [withDiscussion(usable2())], sentiment: true })));
    const c = env.reports.get("run-1:report")?.content ?? "";
    assert.match(c, /missing grounded sentiment/);
    assert.match(c, /item 100: not produced \(model fallback; no label inferred\)/);
    assert.doesNotMatch(c, /item 100: (positive|negative|mixed|unclear) ·/);
    assert.equal(env.results.length, 1);
  });
  it("sentiment:false keeps the legacy path: no discussion or sentiment sections", async () => {
    const env = makeEnv("team_daily", { child: okChild });
    await insightWorkflow.run(ctxOf(env, goodInput()));
    const c = env.reports.get("run-1:report")?.content ?? "";
    assert.doesNotMatch(c, /SAMPLED SENTIMENT|DISCUSSION EVIDENCE/);
  });
});
