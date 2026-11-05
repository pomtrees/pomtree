import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRecord, Signal } from "@pomtree/core";
import { DEFAULT_CONTAINER_CONFIG } from "./daemon-util.ts";
import { get, setup, until } from "./test-setup.ts";

const msg = (t: ReturnType<typeof setup>, id: string, body: object) => t.operator("POST", `/v1/agents/${id}/message`, body);
const FAR = Date.now() + 3_600_000;

test("interrupt wakes a yielded agent whatever it waits on; the message is its resume prompt; replay is safe", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: "y" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const r = await msg(t, aId, { body: "stop that", mode: "interrupt", idempotencyKey: "m1" });
  assert.equal(r.status, 201);
  assert.deepEqual(
    { mode: (r.body as { mode: string }).mode, delivered: (r.body as { delivered: string }).delivered },
    { mode: "interrupt", delivered: "woke" },
  );
  await until(() => wakes.length === 1);
  assert.match(wakes[0]!, /^Resumed: woken by an operator message: stop that$/);
  assert.deepEqual(await t.fakes.mailbox.peek(aId), [], "the resume prompt carries it; its flagged signal is dropped");
  const recv = (await t.journal.read({ agent: aId })).find((e) => e.payload.kind === "message_received")!.payload as { interrupt?: boolean };
  assert.equal(recv.interrupt, true);
  // replay with the same key: same outcome, no second resume, no duplicate delivery
  const again = await msg(t, aId, { body: "stop that", mode: "interrupt", idempotencyKey: "m1" });
  assert.equal((again.body as { delivered: string }).delivered, "woke");
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  assert.deepEqual(await t.fakes.mailbox.peek(aId), []);
});

test("queue mode leaves a yielded agent parked (unchanged) and queues an unflagged signal", async () => {
  let aId = "";
  let woke = 0;
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      woke++;
      return;
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: "y" });
  });
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  const r = await msg(t, aId, { body: "later" });
  assert.equal((r.body as { mode: string; delivered: string }).mode, "queue");
  assert.equal((r.body as { delivered: string }).delivered, "queued");
  await t.orchestrator.idle();
  assert.equal(woke, 0);
  assert.equal((await get(t, aId)).state, "yielded");
  assert.deepEqual(
    (await t.fakes.mailbox.peek(aId)).map(({ id: _id, ...sig }) => sig),
    [{ kind: "human_message", from: { channel: "cli", sender: "operator" }, body: "later" }],
  );
  assert.equal((await msg(t, aId, { body: "x", mode: "bogus" })).status, 400);
});

test("interrupt on a running agent flags the signal first in its mailbox and releases a blocked inbox wait at once", { timeout: 10_000 }, async () => {
  let aId = "";
  let inboxP: Promise<{ status: number; body: unknown }> | undefined;
  const t = setup(async (c) => {
    aId = c.agent;
    inboxP = c.api("GET", "/v1/agents/self/inbox?waitMs=30000");
    await c.stopped;
  });
  await t.spawn();
  await until(() => inboxP !== undefined);
  await t.daemon.deliver(aId, { kind: "nudge" } as unknown as Signal, "test:1");
  await t.fakes.mailbox.receive(aId, "drain"); // start from an empty box
  await new Promise((r) => setTimeout(r, 80));
  const started = Date.now();
  const r = await msg(t, aId, { body: "now!", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal((r.body as { delivered: string }).delivered, "interrupting");
  const got = await inboxP!;
  assert.ok(Date.now() - started < 2000, "the blocked long-poll returned immediately, not at its 30s cap");
  assert.equal((got.body as Signal[])[0]!.kind, "human_message");
  assert.equal((got.body as { interrupt?: boolean }[])[0]!.interrupt, true);
});

test("an interrupt is ordered ahead of already-queued signals", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.stopped;
  });
  await t.spawn();
  await until(() => aId !== "");
  await msg(t, aId, { body: "first" });
  await msg(t, aId, { body: "urgent", mode: "interrupt", idempotencyKey: "i" });
  const peek = (await t.fakes.mailbox.peek(aId)) as { body: string }[];
  assert.deepEqual(
    peek.map((s) => s.body),
    ["urgent", "first"],
  );
});

test("cancel releases a blocked wait long-poll immediately", async () => {
  let aId = "";
  let childWait: Promise<{ status: number; body: unknown }> | undefined;
  const t = setup(async (c) => {
    aId = c.agent;
    if (c.prompt === "child") return void (await c.stopped);
    const kid = await c.api("POST", "/v1/agents", { name: "k", task: "child", idempotencyKey: "kid" });
    childWait = c.api("GET", `/v1/agents/${(kid.body as AgentRecord).id}/wait?timeoutMs=30000`);
    await c.stopped;
  });
  await t.spawn();
  await until(() => childWait !== undefined);
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  await t.daemon.cancel(aId, 20);
  const w = await childWait!;
  assert.ok(Date.now() - started < 2000);
});

test("agents get 403 for --interrupt on peer sends", async () => {
  let status = 0;
  let body: { error?: string } = {};
  const t = setup(async (c) => {
    const root = await t.daemon.root();
    const r = await c.api("POST", `/v1/peers/${root.id}/send`, { body: "hey", generation: 1, idempotencyKey: "k", interrupt: true });
    status = r.status;
    body = r.body as { error?: string };
  });
  await t.spawn();
  await until(() => status !== 0);
  assert.equal(status, 403);
  assert.match(body.error ?? "", /only the operator may interrupt/);
});

test("wait under the hood: a long child wait parks, the child's exit resumes the parent with the outcome", async () => {
  let gate!: () => void;
  const opened = new Promise<void>((r) => (gate = r));
  const wakes: string[] = [];
  let parked: { parked: boolean } | undefined;
  let pId = "";
  const t = setup(
    async (c) => {
      if (c.prompt === "child") {
        await opened;
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "child-result" } }));
      }
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      pId = c.agent;
      const kid = (await c.api("POST", "/v1/agents", { name: "k", task: "child", idempotencyKey: "kid" })).body as AgentRecord;
      const r = await c.api("POST", "/v1/agents/self/park", { on: { kind: "child", child: kid.id }, timeoutMs: 60_000, idempotencyKey: "pk" });
      parked = r.body as { parked: boolean };
    },
    { containerConfig: { ...DEFAULT_CONTAINER_CONFIG, "wait.yieldMs": 20 } },
  );
  await t.spawn();
  await until(async () => pId !== "" && (await get(t, pId)).state === "yielded", 30_000).catch(() => {
    throw new Error("parent never reached yielded (child-wait park) within 30s");
  });
  assert.equal(parked?.parked, true);
  gate();
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!, /^Resumed: child \S+ exited \(succeeded\)\. Handoff: child-result Branch: agent\/\S+\.$/);
});

test("wait under the hood: an ask park resumes on the answer (other messages do not wake it)", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      const gen = (await t.daemon.get(c.agent))!.generation;
      const ask = (await c.api("POST", "/v1/agents/self/ask", { question: "ok?", generation: gen, idempotencyKey: "q" })).body as {
        escalation: { id: string };
      };
      await c.api("POST", "/v1/agents/self/park", { on: { kind: "ask", escalation: ask.escalation.id }, timeoutMs: 60_000, idempotencyKey: "pk" });
    },
    { containerConfig: { ...DEFAULT_CONTAINER_CONFIG, "wait.yieldMs": 20 } },
  );
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  await msg(t, aId, { body: "unrelated chatter" });
  await t.orchestrator.idle();
  assert.equal(wakes.length, 0, "a plain message does not release an ask park");
  const esc = (await t.fakes.escalations.list({ state: "open" }))[0]!;
  await t.daemon.answerEscalation(esc.id, "yes", { channel: "operator", sender: "op" }, "ans");
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0], "Resumed: your question was answered: yes");
});

test("wait under the hood: the timer wakes an inbox park with a timeout message; short or satisfied waits do not park", async () => {
  const wakes: string[] = [];
  let aId = "";
  const results: unknown[] = [];
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      results.push((await c.api("POST", "/v1/agents/self/park", { on: { kind: "inbox" }, timeoutMs: 3, idempotencyKey: "short" })).body); // below threshold
      await t.daemon.deliver(c.agent, { kind: "nudge" } as unknown as Signal, "test:1");
      results.push((await c.api("POST", "/v1/agents/self/park", { on: { kind: "inbox" }, timeoutMs: 60, idempotencyKey: "queued" })).body); // inbox not empty
      await t.fakes.mailbox.receive(c.agent, "drain");
      results.push((await c.api("POST", "/v1/agents/self/park", { on: { kind: "inbox" }, timeoutMs: 60, idempotencyKey: "long" })).body);
    },
    { containerConfig: { ...DEFAULT_CONTAINER_CONFIG, "wait.yieldMs": 10 } },
  );
  await t.spawn();
  await until(() => wakes.length === 1, 30_000).catch(() => {
    throw new Error("timer never woke the inbox-parked agent within 30s");
  });
  assert.deepEqual(
    results.map((r) => (r as { parked: boolean }).parked),
    [false, false, true],
  );
  assert.equal(wakes[0], "Resumed: wait for messages timed out after 60 ms (no new messages).");
  assert.ok(aId);
});

test("yield honours a cancel that lands before the transition: the agent finishes cancelled, not yielded", async () => {
  let aId = "";
  let status = 0;
  const t = setup(async (c) => {
    aId = c.agent;
    status = (await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y" })).status;
    await c.stopped;
  });
  const real = t.daemon.deps.sessions;
  let fired = false;
  t.daemon.deps.sessions = {
    get: (r) => real.get(r),
    put: async (b) => {
      const ref = await real.put(b);
      if (!fired) {
        fired = true;
        await t.daemon.stop(aId, 20);
      } // cancel arrives mid-yield
      return ref;
    },
  };
  await t.spawn();
  await until(async () => aId !== "" && ["exited", "reaped"].includes((await get(t, aId)).state));
  const rec = await get(t, aId);
  assert.equal(rec.exit, "cancelled");
  assert.equal(status, 409);
  assert.ok(!(await t.journal.read({ agent: aId })).some((e) => e.payload.kind === "yielded"));
});

test("yield retried with the same key returns the checkpoint it already wrote", async () => {
  let aId = "";
  const ids: string[] = [];
  const t = setup(async (c) => {
    aId = c.agent;
    for (let i = 0; i < 2; i++) {
      const r = await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "same" });
      ids.push(`${r.status}:${(r.body as { id?: string }).id}`);
    }
  });
  await t.spawn();
  await until(() => ids.length === 2);
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0]!, /^201:/);
  assert.equal((await get(t, aId)).state, "yielded");
});

// --- interrupt = abort + resume with the operator's message as the prompt ---

const sawInterrupt = async (c: { api: (m: string, u: string) => Promise<{ body: unknown }> }) => {
  for (;;) {
    const peek = (await c.api("GET", "/v1/agents/self/inbox?peek=1")).body as { interrupt?: boolean }[];
    if (peek.some((x) => x.interrupt)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("interrupt on a running agent: Pi exits without settling -> checkpoint -> immediate resume with the interrupted note + message", async () => {
  const wakes: string[] = [];
  let aId = "";
  let started = false;
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "answered" } }));
    }
    aId = c.agent;
    started = true;
    await sawInterrupt(c); // the mailbox extension: sees the flag and ctx.abort()s; the process exits
  });
  await t.spawn();
  await until(() => started);
  const r = await msg(t, aId, { body: "change course", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal((r.body as { delivered: string }).delivered, "interrupting");
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  assert.equal(
    wakes[0],
    "Your previous turn was interrupted by the operator (in-flight tool calls were aborted; re-check workspace state before continuing). Operator message: change course",
  );
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  const rec = await get(t, aId);
  assert.equal(rec.exit, "succeeded");
  assert.ok(rec.generation >= 1, "resumed as a new generation");
  assert.deepEqual(await t.fakes.mailbox.peek(aId), [], "the flagged signal was consumed with the resume");
  const kinds = (await t.journal.read({ agent: aId })).map((e) => e.payload as { kind: string; keys?: string[]; mode?: string; key?: string; body?: string });
  assert.deepEqual(
    kinds.find((p) => p.kind === "ext.pomtreed.interrupt"),
    { kind: "ext.pomtreed.interrupt", key: "i1", body: "change course" },
  );
  assert.deepEqual(
    kinds.find((p) => p.kind === "ext.pomtreed.interrupt_done"),
    { kind: "ext.pomtreed.interrupt_done", keys: ["i1"], mode: "interrupted" },
  );
  assert.ok(!kinds.some((p) => p.kind === "exited" && (p as { exit?: string }).exit === "failed"));
  const cps = t.fakes.checkpoints.all.filter((c) => c.agent === aId);
  assert.equal(cps.length, 1);
  assert.equal(cps[0]!.wait, null);
});

// One backstop driver: a Pi that never exits on its own is interrupted past the grace, and the run resumes with the message.
async function runBackstop(opts: { graceMs: number; failKill?: boolean; settleFirst?: boolean }) {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      await c.stopped; // never exits on its own (no extension); only session.stop() (the harness contract) ends this stream
    },
    { interruptGraceMs: opts.graceMs },
  );
  if (opts.failKill) {
    t.sandbox.kill = async () => {
      throw new Error("docker kill: connection refused");
    };
  }
  await t.spawn();
  await until(() => aId !== "");
  if (opts.settleFirst) await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await msg(t, aId, { body: "hey", mode: "interrupt", idempotencyKey: "i1" });
  await t.orchestrator.idle();
  const elapsed = Date.now() - t0;
  const errs = (await t.journal.read({ agent: aId }))
    .map((e) => e.payload as { kind: string; message?: string })
    .filter((p) => p.kind === "error" && /interrupt backstop/.test(p.message ?? ""));
  return { t, wakes, elapsed, errs };
}

test("interrupt backstop: a Pi that ignores the interrupt is killed after agent.interruptGraceMs, then resumed with the message", async () => {
  const { t, wakes, elapsed } = await runBackstop({ graceMs: 40, settleFirst: true });
  assert.equal(wakes.length, 1);
  assert.ok(elapsed >= 35, "not before the grace elapsed");
  assert.match(wakes[0]!, /interrupted by the operator.*Operator message: hey$/);
  assert.ok(
    t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill"),
    "the container was killed by the backstop",
  );
});

test("interrupt backstop: a failed kill is journaled once (cause and action), and stopping the session still ends the run and resumes it", async () => {
  const { wakes, errs } = await runBackstop({ graceMs: 20, failKill: true });
  assert.equal(wakes.length, 1, "resumed with the message although the kill failed");
  assert.equal(errs.length, 1, "the kill failure is journaled exactly once");
  assert.match(errs[0]!.message!, /docker kill: connection refused/, "names the cause");
  assert.match(errs[0]!.message!, /docker rm -f/, "names the operator's action");
});

test("interrupt backstop: a kill that succeeds journals no backstop error (negative control)", async () => {
  const { wakes, errs } = await runBackstop({ graceMs: 20 });
  assert.ok(wakes.length > 0);
  assert.equal(errs.length, 0);
});

test("a Pi process that exits 143 on interrupt is INTERRUPTED (resumed), not host_stopped/failed", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      await c.stopped;
    },
    { interruptGraceMs: 20 },
  );
  t.fakes.sandbox.exitCodes.push(143);
  await t.spawn();
  await until(() => aId !== "");
  await msg(t, aId, { body: "x", mode: "interrupt", idempotencyKey: "i1" });
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  assert.equal((await get(t, aId)).exit, "succeeded");
});

test("two rapid interrupts coalesce, in order, into one resume prompt", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      await c.stopped;
    },
    { interruptGraceMs: 30 },
  );
  await t.spawn();
  await until(() => aId !== "");
  await msg(t, aId, { body: "first", mode: "interrupt", idempotencyKey: "a" });
  await msg(t, aId, { body: "second", mode: "interrupt", idempotencyKey: "b" });
  await t.orchestrator.idle();
  assert.ok(wakes.length >= 1);
  assert.match(wakes[0]!, /Operator messages: 1\. first\n2\. second$/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(wakes.length, 1, "one resume, not two");
});

test("an interrupt that races a natural yield is not lost: the parked agent is woken with it", async () => {
  const wakes: string[] = [];
  let aId = "";
  let ready = false;
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      ready = true;
      await sawInterrupt(c);
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: "y" });
    },
    { interruptGraceMs: 5000 },
  );
  await t.spawn();
  await until(() => ready);
  await msg(t, aId, { body: "late", mode: "interrupt", idempotencyKey: "i1" });
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1);
  assert.ok(/late$/.test(wakes[0]!));
});

test("an interrupt to a terminal agent is 409; a yielded agent resumes ahead of queued resumes", async () => {
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "done" } });
  });
  await t.spawn();
  await until(async () => aId !== "" && ["exited", "reaped"].includes((await get(t, aId)).state));
  const r = await msg(t, aId, { body: "too late", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal(r.status, 409);
  assert.match((r.body as { error: string }).error, /cannot interrupt/);
});

test("a yielded agent's interrupt resume is admitted at top priority", async () => {
  let aId = "";
  const prios: number[] = [];
  const t = setup(async (c) => {
    if (c.wake !== undefined) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: "y" });
  });
  const admit = t.daemon.deps.placement.admit.bind(t.daemon.deps.placement);
  t.daemon.deps.placement.admit = async (req) => (prios.push(req.priority), admit(req));
  await t.spawn();
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).state, "yielded");
  prios.length = 0;
  await msg(t, aId, { body: "go", mode: "interrupt", idempotencyKey: "i1" });
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  assert.deepEqual(prios, [0]);
});

// --- an interrupt that aborts the in-flight model request (YLD-4, a hosted CI run) ---
// Pi reports the aborted request as a retryable provider outage ("This operation was aborted"), with a zero usage event before it.

const abortedUsage = { kind: "usage" as const, inputTokens: 0, outputTokens: 0, costMicros: 0, stopReason: "aborted" };
const abortedOutage = { kind: "provider_error" as const, code: "outage" as const, message: "This operation was aborted", retryable: true };
const realOutage = { kind: "provider_error" as const, code: "outage" as const, message: "502 upstream down", retryable: true };
const failedUsage = { kind: "usage" as const, inputTokens: 0, outputTokens: 0, costMicros: 0, stopReason: "error" };
const INTERRUPTED_PREFIX = "Your previous turn was interrupted by the operator";
const payloads = async (t: ReturnType<typeof setup>, id: string) =>
  (await t.journal.read({ agent: id })).map((e) => e.payload as { kind: string; message?: string; mode?: string; exit?: string; cause?: string });
// Counts the provider retry ladder's durable bumps (Registry.bumpProviderAttempts) per agent.
const countBumps = (t: ReturnType<typeof setup>) => {
  const n = new Map<string, number>();
  const reg = t.daemon.deps.registry;
  const bump = reg.bumpProviderAttempts.bind(reg);
  reg.bumpProviderAttempts = async (agent, key) => {
    n.set(agent, (n.get(agent) ?? 0) + 1);
    return bump(agent, key);
  };
  return n;
};

test("an interrupt that aborts the in-flight model request resumes at once with the message: no retry ladder, no backoff yield", async () => {
  const wakes: string[] = [];
  let aId = "";
  let started = false;
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      started = true;
      await sawInterrupt(c); // the mailbox extension aborts the turn; Pi reports the aborted request, then the process ends
      c.emit(abortedUsage as never);
      c.emit(abortedOutage as never);
    },
    // A backoff yield would wait an hour: only the interrupt resume can end this run in test time.
    { limits: { providerBackoffMs: 3_600_000, maxProviderBackoffMs: 3_600_000, maxProviderRetries: 3 }, random: () => 0.5 },
  );
  const bumps = countBumps(t);
  await t.spawn();
  await until(() => started);
  await msg(t, aId, { body: "INT-RUN-31 finish now", mode: "interrupt", idempotencyKey: "i1" });
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  await t.orchestrator.idle();
  assert.deepEqual(wakes, [
    `${INTERRUPTED_PREFIX} (in-flight tool calls were aborted; re-check workspace state before continuing). Operator message: INT-RUN-31 finish now`,
  ]);
  assert.equal((await get(t, aId)).exit, "succeeded");
  assert.equal(bumps.get(aId) ?? 0, 0, "the aborted request is not a provider attempt");
  const ps = await payloads(t, aId);
  assert.ok(!ps.some((p) => p.kind === "yielded"), "no provider-backoff yield");
  assert.ok(!ps.some((p) => p.kind === "ext.pomtreed.provider_degraded"), "the aborted request does not feed the provider breaker");
  assert.deepEqual(
    ps.filter((p) => p.kind === "ext.pomtreed.interrupt_done").map((p) => p.mode),
    ["interrupted"],
  );
  assert.equal(ps.filter((p) => p.kind === "resumed").length, 1, "exactly one resume");
});

test("an interrupt-aborted request does not advance the retry ladder: a run one outage from its cap resumes instead of failing", async () => {
  const wakes: string[] = [];
  let aId = "";
  let runs = 0;
  const t = setup(
    async (c) => {
      aId = c.agent;
      runs++;
      if (runs === 1) {
        // A genuine outage: attempt 1 of a ladder capped at one retry; the 5 ms backoff resumes it.
        c.emit(failedUsage as never);
        return void c.emit(realOutage as never);
      }
      wakes.push(c.wake ?? "");
      if (runs === 2) {
        // The retry is interrupted mid-request: counted as an attempt, this would exhaust the ladder and fail the run.
        await sawInterrupt(c);
        c.emit(abortedUsage as never);
        return void c.emit(abortedOutage as never);
      }
      await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
    },
    { limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 1 }, random: () => 0.5 },
  );
  const bumps = countBumps(t);
  await t.spawn();
  await until(() => runs === 2);
  await msg(t, aId, { body: "change course", mode: "interrupt", idempotencyKey: "i1" });
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).exit, "succeeded");
  assert.equal(bumps.get(aId), 1, "only the genuine outage was counted");
  assert.equal(wakes.length, 2);
  assert.match(wakes[1]!, new RegExp(`^${INTERRUPTED_PREFIX}.*Operator message: change course$`));
  assert.ok(!(await payloads(t, aId)).some((p) => p.kind === "error" && /provider/i.test(p.message ?? "")), "no provider-exhausted error");
});

test("an interrupt sent while a genuine outage is backing off wakes the parked agent with the message (the ladder count stays)", async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      aId = c.agent;
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      c.emit(failedUsage as never);
      c.emit(realOutage as never);
    },
    { limits: { providerBackoffMs: 3_600_000, maxProviderBackoffMs: 3_600_000, maxProviderRetries: 3 }, random: () => 0.5 },
  );
  const bumps = countBumps(t);
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  const r = await msg(t, aId, { body: "status?", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal((r.body as { delivered: string }).delivered, "woke");
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  await t.orchestrator.idle();
  assert.deepEqual(wakes, ["Resumed: woken by an operator message: status?"]);
  assert.equal(bumps.get(aId), 1, "the genuine outage was counted once");
  assert.equal((await get(t, aId)).exit, "succeeded");
});

test("cancel still wins over a pending interrupt when the aborted request reports an outage", async () => {
  const wakes: string[] = [];
  let aId = "";
  let started = false;
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) return void wakes.push(c.wake);
      aId = c.agent;
      started = true;
      await sawInterrupt(c);
      await c.stopped;
      c.emit(abortedUsage as never);
      c.emit(abortedOutage as never);
    },
    { interruptGraceMs: 5000, limits: { providerBackoffMs: 5, maxProviderBackoffMs: 20, maxProviderRetries: 0 }, random: () => 0.5 },
  );
  const bumps = countBumps(t);
  await t.spawn();
  await until(() => started);
  await msg(t, aId, { body: "x", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal((await t.operator("POST", `/v1/agents/${aId}/cancel`, {})).status, 202);
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).exit, "cancelled");
  assert.deepEqual(wakes, [], "a cancelled agent is not resumed with the interrupt");
  assert.equal(bumps.get(aId) ?? 0, 0);
});

test("a non-retryable provider error with an interrupt pending still fails the run at once (resuming cannot fix it)", async () => {
  const wakes: string[] = [];
  let aId = "";
  let started = false;
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) return void wakes.push(c.wake);
      aId = c.agent;
      started = true;
      await sawInterrupt(c);
      c.emit(failedUsage as never);
      c.emit({ kind: "provider_error", code: "auth", message: "401 invalid key", retryable: false } as never);
    },
    { interruptGraceMs: 5000 },
  );
  await t.spawn();
  await until(() => started);
  await msg(t, aId, { body: "x", mode: "interrupt", idempotencyKey: "i1" });
  await until(async () => ["exited", "reaped"].includes((await get(t, aId)).state));
  await t.orchestrator.idle();
  const rec = await get(t, aId);
  assert.equal(rec.exit, "failed");
  assert.deepEqual(wakes, []);
  const exited = (await payloads(t, aId)).find((p) => p.kind === "exited");
  assert.equal(exited?.cause, "provider_error");
});

// --- every resume delivers the interrupts still pending (Lifecycle.takeInterrupts), serialized with queueInterrupt ---

const interruptDone = async (t: ReturnType<typeof setup>, id: string) => (await payloads(t, id)).filter((p) => p.kind === "ext.pomtreed.interrupt_done");
const occurrences = (s: string, sub: string) => s.split(sub).length - 1;
const INTERRUPTED_NOTE = `${INTERRUPTED_PREFIX} (in-flight tool calls were aborted; re-check workspace state before continuing).`;
type LiveView = { interrupt?: boolean; interruptTimer?: unknown; session?: unknown };
const internals = (t: ReturnType<typeof setup>) =>
  (t.daemon as unknown as { lifecycle: { live: Map<string, LiveView>; armInterrupt(a: string): void } }).lifecycle;
const flagged = async (c: { api: (m: string, u: string) => Promise<{ body: unknown }> }) =>
  ((await c.api("GET", "/v1/agents/self/inbox?peek=1")).body as { interrupt?: boolean }[]).some((x) => x.interrupt);
const terminal = async (t: ReturnType<typeof setup>, id: string) => ["exited", "reaped"].includes((await get(t, id)).state);
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { open, opened };
};

// A timer resume that holds the resume slot while the yield's teardown runs: settleYield's interrupt wake finds a resume in
// flight and does nothing, so the timer resume's own run must deliver the message (before: the new run was not armed and the
// flagged signal wedged its mailbox, the second half of the YLD-4 hang, a hosted CI run).
test("an interrupt is delivered in the prompt of a timer resume that won the race with the yield's interrupt wake", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  let ready = false;
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      if (c.wake.includes("late")) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      return; // the mailbox extension aborted an idle Pi for the flagged signal: the process ends with no result
    }
    aId = c.agent;
    ready = true;
    await sawInterrupt(c);
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: Date.now() }, idempotencyKey: "y" });
  });
  // Order the race: the yield teardown (settleYield's key revoke, the only one made while the agent is `yielded`) waits until
  // the timer resume is in flight, and that resume's run (holding the resume slot) waits until the teardown has finished.
  const held = gate();
  const timerResumed = gate();
  const resume = t.orchestrator.resume.bind(t.orchestrator);
  t.orchestrator.resume = async (agent, gen, wake) => {
    timerResumed.open();
    await held.opened;
    return resume(agent, gen, wake);
  };
  const revoke = t.daemon.deps.gateway.revoke.bind(t.daemon.deps.gateway);
  t.daemon.deps.gateway.revoke = async (agent) => {
    if ((await get(t, agent)).state === "yielded") await timerResumed.opened;
    return revoke(agent);
  };
  await t.spawn();
  await until(() => ready);
  await msg(t, aId, { body: "late", mode: "interrupt", idempotencyKey: "i1" });
  await until(async () => (await get(t, aId)).state === "running" && (await get(t, aId)).generation === 1 && !internals(t).live.has(aId));
  held.open();
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.deepEqual(wakes, ["timer elapsed Operator message received while you were parked: late"]);
  assert.equal((await get(t, aId)).exit, "succeeded");
  assert.deepEqual(
    (await interruptDone(t, aId)).map((p) => p.mode),
    ["resume"],
  );
  assert.deepEqual(await t.fakes.mailbox.peek(aId), [], "the flagged signal never reaches the new container");
});

test("an interrupt sent while the resume is queued in admission is delivered in that resume's prompt, once", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      if (c.wake.includes("INT-ADM")) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      return;
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y" });
  });
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  const held = gate();
  let queued = false;
  const admit = t.daemon.deps.placement.admit.bind(t.daemon.deps.placement);
  t.daemon.deps.placement.admit = async (req) => {
    queued = true;
    await held.opened;
    return admit(req);
  };
  await msg(t, aId, { body: "plain note", idempotencyKey: "q1" });
  await until(() => queued);
  assert.equal((await get(t, aId)).state, "running");
  const r = await msg(t, aId, { body: "INT-ADM stop", mode: "interrupt", idempotencyKey: "i1" });
  assert.equal((r.body as { delivered: string }).delivered, "interrupting");
  held.open();
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.equal(wakes.length, 1, `wakes: ${JSON.stringify(wakes)}`);
  assert.equal(occurrences(wakes[0]!, "INT-ADM stop"), 1);
  assert.equal((await get(t, aId)).exit, "succeeded");
  assert.deepEqual(
    (await interruptDone(t, aId)).map((p) => p.mode),
    ["resume"],
  );
});

// Review finding 1: the resumed run reads pending interrupts between messageAgent's journal row and its flagged signal. Without
// one lock over both sides the message went out in the prompt AND armed the run, the extension aborted that turn, and settle
// found nothing pending and failed the agent.
test("an interrupt journaled while a resume reads pending interrupts is delivered once and does not arm the run", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  const sendDone = gate();
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      await sendDone.opened; // the extension's first poll comes after the signal landed
      if (await flagged(c)) return; // the extension aborts the turn: no result
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y" });
  });
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  // Block the flagged signal's send (after the journal row), and count interrupt-lock requests for this agent.
  const sendHeld = gate();
  let sendBlocked = false;
  const send = t.daemon.deps.mailbox.send.bind(t.daemon.deps.mailbox);
  t.daemon.deps.mailbox.send = async (agent, sig, key) => {
    if ((sig as { interrupt?: boolean }).interrupt) {
      sendBlocked = true;
      await sendHeld.opened;
    }
    return send(agent, sig, key);
  };
  let lockRequests = 0;
  const locks = (t.daemon as unknown as { locks: { withLock<T>(k: string, fn: () => Promise<T>): Promise<T> } }).locks;
  const withLock = locks.withLock.bind(locks);
  locks.withLock = (k, fn) => {
    if (k === `interrupt:${aId}`) lockRequests++;
    return withLock(k, fn);
  };
  const interrupting = msg(t, aId, { body: "RACE-1", mode: "interrupt", idempotencyKey: "i1" });
  await until(() => sendBlocked);
  await msg(t, aId, { body: "plain note", idempotencyKey: "q1" }); // a message wake resumes the agent meanwhile
  // Release once the resumed run is waiting for the interrupt lock (or, without the lock, has already reached its harness).
  await until(() => lockRequests >= 2 || wakes.length > 0);
  sendHeld.open();
  await interrupting;
  sendDone.open();
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.equal((await get(t, aId)).exit, "succeeded", `wakes: ${JSON.stringify(wakes)}`);
  assert.equal(wakes.length, 1);
  assert.equal(occurrences(wakes[0]!, "RACE-1"), 1);
  assert.equal((await interruptDone(t, aId)).length, 1);
});

// Review finding 2: messageAgent read `yielded`, then a resume ran before it journaled the interrupt; the stale branch tried a
// wake (409, swallowed) and nothing armed the new run. queueInterrupt now arms the started run, which delivers the message.
test("an interrupt whose sender saw a yielded agent that a resume then started is armed on the new run and delivered", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        if (c.wake.includes("STALE-2")) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
        return void (await sawInterrupt(c)); // the extension aborts the turn for the flagged signal
      }
      aId = c.agent;
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y" });
    },
    { interruptGraceMs: 5000 },
  );
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  // Hold messageAgent just after its audit row (it read `yielded` before writing it), before the interrupt is journaled. Called
  // directly: the HTTP route journals the audit row itself, before messageAgent reads the state.
  const held = gate();
  let blocked = false;
  const append = t.daemon.deps.journal.append.bind(t.daemon.deps.journal);
  t.daemon.deps.journal.append = async (e) => {
    const row = await append(e);
    const p = e.payload as { kind: string; interrupt?: boolean };
    if (p.kind === "message_received" && p.interrupt) {
      blocked = true;
      await held.opened;
    }
    return row;
  };
  const interrupting = t.daemon.messageAgent(aId, "STALE-2", "i1", "interrupt");
  await until(() => blocked);
  await msg(t, aId, { body: "plain note", idempotencyKey: "q1" });
  await until(() => wakes.length === 1); // the message wake's run started, its pending-interrupt read found nothing
  held.open();
  assert.equal((await interrupting).delivered, "interrupting");
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.equal(wakes.length, 2, `wakes: ${JSON.stringify(wakes)}`);
  assert.equal(wakes[1], `${INTERRUPTED_NOTE} Operator message: STALE-2`);
  assert.equal((await get(t, aId)).exit, "succeeded");
  assert.deepEqual(
    (await interruptDone(t, aId)).map((p) => p.mode),
    ["interrupted"],
  );
});

// Negative control for a spurious arming (nothing pending): the run is resumed with the interrupted note, never failed.
test("an armed run with no pending interrupt is resumed with the interrupted note, not failed", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
      }
      aId = c.agent;
      await c.stopped;
    },
    { interruptGraceMs: 20 },
  );
  await t.spawn();
  await until(() => aId !== "" && internals(t).live.get(aId)?.session !== undefined);
  internals(t).armInterrupt(aId);
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.deepEqual(wakes, [INTERRUPTED_NOTE]);
  assert.equal((await get(t, aId)).exit, "succeeded");
  assert.deepEqual(await interruptDone(t, aId), []);
});

// Review finding 6: an interrupt armed before the resumed run's session exists starts no backstop until the session does, so
// the backstop is never spent on a run with nothing to stop.
test("an interrupt armed before the session starts gets its backstop once the session exists", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(
    async (c) => {
      if (c.wake !== undefined) {
        wakes.push(c.wake);
        if (c.wake.includes("EARLY-6")) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
        return void (await c.stopped); // ignores the interrupt: only the backstop ends this run
      }
      aId = c.agent;
      await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y" });
    },
    { interruptGraceMs: 20 },
  );
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  const held = gate();
  let starting = false;
  const start = t.daemon.deps.sandbox.start.bind(t.daemon.deps.sandbox);
  t.daemon.deps.sandbox.start = async (spec, key) => {
    starting = true;
    await held.opened;
    return start(spec, key);
  };
  await msg(t, aId, { body: "plain note", idempotencyKey: "q1" });
  await until(() => starting);
  await msg(t, aId, { body: "EARLY-6", mode: "interrupt", idempotencyKey: "i1" });
  const e = internals(t).live.get(aId)!;
  assert.equal(e.interrupt, true, "armed");
  assert.equal(e.interruptTimer, undefined, "no backstop before the session exists");
  held.open();
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.equal(wakes.length, 2, `wakes: ${JSON.stringify(wakes)}`);
  assert.equal(wakes[1], `${INTERRUPTED_NOTE} Operator message: EARLY-6`);
  assert.ok(
    t.fakes.calls.some((c) => c.port === "Sandbox" && c.method === "kill"),
    "the backstop killed the started container",
  );
});

// No double delivery: an interrupt woken or interrupted for is in exactly one prompt with one interrupt_done, and the run that
// carries it is not left armed.
test("an interrupt is delivered exactly once on the woke and the interrupted paths (one prompt, one interrupt_done, not armed)", {
  timeout: 15_000,
}, async () => {
  for (const path of ["woke", "interrupted"] as const) {
    const wakes: string[] = [];
    const armedAtWake: boolean[] = [];
    let aId = "";
    let started = false;
    let t!: ReturnType<typeof setup>;
    t = setup(
      async (c) => {
        if (c.wake !== undefined) {
          wakes.push(c.wake);
          armedAtWake.push(internals(t).live.get(c.agent)?.interrupt === true);
          return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
        }
        aId = c.agent;
        started = true;
        if (path === "woke") await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: "y" });
        else await sawInterrupt(c);
      },
      { interruptGraceMs: 5000 },
    );
    await t.spawn();
    if (path === "woke") await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
    else await until(() => started);
    await msg(t, aId, { body: "ONCE-31", mode: "interrupt", idempotencyKey: "i1" });
    await until(() => terminal(t, aId));
    await t.orchestrator.idle();
    assert.equal(wakes.length, 1, `${path}: wakes ${JSON.stringify(wakes)}`);
    assert.equal(occurrences(wakes[0]!, "ONCE-31"), 1, `${path}: the message appears once`);
    assert.deepEqual(armedAtWake, [false], `${path}: the run carrying the message is not armed for it`);
    assert.deepEqual(
      (await interruptDone(t, aId)).map((p) => p.mode),
      [path],
      path,
    );
    assert.equal((await get(t, aId)).exit, "succeeded", path);
  }
});

// Review finding B: the pending-interrupt read is new work on every resume; an unreadable journal there must not fail a resume.
test("a resume whose pending-interrupt read fails proceeds without them and records why", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  const t = setup(async (c) => {
    if (c.wake !== undefined) {
      wakes.push(c.wake);
      return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    }
    aId = c.agent;
    await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "message" }, idempotencyKey: "y" });
  });
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  // Fail the journal read made under this agent's interrupt lock (takeInterrupts), once.
  let inLock = false;
  let failed = 0;
  const locks = (t.daemon as unknown as { locks: { withLock<T>(k: string, fn: () => Promise<T>): Promise<T> } }).locks;
  const withLock = locks.withLock.bind(locks);
  locks.withLock = (k, fn) =>
    k === `interrupt:${aId}`
      ? withLock(k, async () => {
          inLock = true;
          try {
            return await fn();
          } finally {
            inLock = false;
          }
        })
      : withLock(k, fn);
  const read = t.daemon.deps.journal.read.bind(t.daemon.deps.journal);
  t.daemon.deps.journal.read = async (q) => {
    if (inLock && q.agent === aId && failed === 0) {
      failed++;
      throw new Error("SQLITE_IOERR: disk I/O error");
    }
    return read(q);
  };
  await msg(t, aId, { body: "plain note", idempotencyKey: "q1" });
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.equal(failed, 1, "the read under the interrupt lock failed once");
  assert.equal(wakes.length, 1);
  assert.equal((await get(t, aId)).exit, "succeeded", "the resume went ahead");
  const errs = (await payloads(t, aId)).filter((p) => p.kind === "error" && /pending operator interrupts unreadable/.test(p.message ?? ""));
  assert.equal(errs.length, 1);
  assert.match(errs[0]!.message!, /SQLITE_IOERR/, "names the cause");
  assert.match(errs[0]!.message!, /next resume delivers them/, "says what happens to them");
});

// Review finding G: delivery is at-least-once when the interrupt_done write fails. The message went out in the prompt but stays
// pending in the journal, so the next resume delivers it again.
test("an interrupt_done write failure leaves the message pending: at-least-once, the next resume delivers it again", { timeout: 15_000 }, async () => {
  const wakes: string[] = [];
  let aId = "";
  let runs = 0;
  const t = setup(async (c) => {
    aId = c.agent;
    runs++;
    if (c.wake !== undefined) wakes.push(c.wake);
    if (runs < 3) return void (await c.api("POST", "/v1/agents/self/yield", { wait: { kind: "timer", at: FAR }, idempotencyKey: `y${runs}` }));
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
  });
  await t.spawn();
  await until(async () => aId !== "" && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  let failDone = 1;
  const append = t.daemon.deps.journal.append.bind(t.daemon.deps.journal);
  t.daemon.deps.journal.append = async (e) => {
    if ((e.payload as { kind: string }).kind === "ext.pomtreed.interrupt_done" && failDone > 0) {
      failDone--;
      throw new Error("SQLITE_FULL: database or disk is full");
    }
    return append(e);
  };
  await msg(t, aId, { body: "AL-1", mode: "interrupt", idempotencyKey: "i1" });
  await until(async () => wakes.length === 1 && (await get(t, aId)).state === "yielded");
  await t.orchestrator.idle();
  await t.daemon.probeStore(); // the failed write latched the store down (admission holds); the health probe clears it
  await msg(t, aId, { body: "AL-2", mode: "interrupt", idempotencyKey: "i2" });
  await until(() => terminal(t, aId));
  await t.orchestrator.idle();
  assert.equal(wakes.length, 2, `wakes: ${JSON.stringify(wakes)}`);
  assert.equal(wakes[0], "Resumed: woken by an operator message: AL-1", "delivered once already");
  assert.equal(wakes[1], "Resumed: woken by an operator messages: 1. AL-1\n2. AL-2", "and again, with the next message");
  assert.deepEqual(
    (await interruptDone(t, aId)).map((p) => (p as unknown as { keys: string[] }).keys),
    [["i1", "i2"]],
  );
  assert.equal((await get(t, aId)).exit, "succeeded");
});

// Known gap (pre-existing): a fresh start never takes pending interrupts. An interrupt to a `pending` agent is journaled and
// flagged; drive() neither puts it in the first prompt nor arms the run, so the extension aborts the first turn while the daemon
// is unarmed and the message is never delivered.
test("an interrupt sent to a pending agent is delivered when it starts", { todo: "TODO(interrupts)", timeout: 15_000 }, async () => {
  const prompts: string[] = [];
  let aId = "";
  const t = setup(async (c) => {
    aId = c.agent;
    prompts.push(c.wake ?? "(start)");
    if (c.wake?.includes("PEND-1")) return void (await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } }));
    if (await flagged(c)) return; // the extension aborts the first turn for the flagged signal: no result
    await c.api("POST", "/v1/agents/self/result", { result: { summary: "ok", value: "ok" } });
  });
  const held = gate();
  let queued = false;
  const admit = t.daemon.deps.placement.admit.bind(t.daemon.deps.placement);
  t.daemon.deps.placement.admit = async (req) => {
    queued = true;
    await held.opened;
    return admit(req);
  };
  const spawned = t.spawn();
  await until(() => queued);
  const id = (await t.daemon.list({})).find((a) => a.state === "pending")!.id;
  await msg(t, id, { body: "PEND-1", mode: "interrupt", idempotencyKey: "i1" });
  held.open();
  await spawned;
  await until(() => aId !== "" && terminal(t, id), 5_000).catch(() => {});
  await t.orchestrator.idle();
  assert.ok(
    prompts.some((p) => p.includes("PEND-1")),
    `the message never reached a prompt: ${JSON.stringify(prompts)}`,
  );
  assert.equal((await get(t, id)).exit, "succeeded");
});
