import { test } from "node:test";
import assert from "node:assert/strict";
import { ABORT_RETRY_MS, Dedupe, MAX_ABORT_ATTEMPTS, batchInjections, planPairs, runTick, type MailSignal } from "../ext/pomtree-mailbox/mailbox.ts";

const env = { POMTREE_API: "http://h:1", POMTREE_TOKEN: "t" };

// Models the part of the pinned Pi's AgentSession.prompt() that matters here: on an IDLE session
// sendUserMessage starts a turn and ignores deliverAs; on a streaming one it queues per deliverAs; a second call that
// lands before the first turn is streaming would start a competing turn (counted as `racing`).
function fakePi(opts: { streaming: boolean }) {
  const f = { streaming: opts.streaming, turns: [] as string[], queued: [] as { text: string; deliverAs: string }[], calls: 0, racing: 0, startPending: false };
  const sendUserMessage = (text: string, o: { deliverAs: "steer" | "followUp" }) => {
    f.calls++;
    if (f.streaming) {
      f.queued.push({ text, deliverAs: o.deliverAs });
      return;
    }
    if (f.startPending) f.racing++;
    f.startPending = true;
    f.turns.push(text);
  };
  return { f, sendUserMessage };
}

const harness = (inbox: MailSignal[], pi: ReturnType<typeof fakePi>) => {
  const acks: { ids: string[]; idempotencyKey: string }[] = [];
  const dedupe = new Dedupe();
  let n = 0;
  const tick = (abort?: () => void) =>
    runTick({
      env,
      dedupe,
      sendUserMessage: pi.sendUserMessage,
      abort,
      nextAckKey: () => `k${++n}`,
      get: async () => ({ ok: true, status: 200, json: async () => inbox }),
      post: async (_u, i) => {
        acks.push(JSON.parse(i.body));
        return { ok: true, status: 200 };
      },
    });
  return { tick, acks };
};

test("idle Pi: a human message is injected once as a steer, which starts a turn, and is acked", async () => {
  const pi = fakePi({ streaming: false });
  const inbox: MailSignal[] = [{ kind: "human_message", id: "h1", from: { channel: "operator", sender: "operator" }, body: "carry on" }];
  const h = harness(inbox, pi);
  assert.equal(await h.tick(), "ok");
  assert.equal(pi.f.turns.length, 1);
  assert.match(pi.f.turns[0]!, /Message from a human.*carry on/);
  assert.deepEqual(
    h.acks.map((a) => [a.ids, a.idempotencyKey]),
    [[["h1"], "k1"]],
  );
  await h.tick(); // the same unconsumed signal (peek) is not re-injected
  assert.equal(pi.f.calls, 1);
});

test("idle Pi: several signals in one poll become ONE message so a second send cannot race the first turn", async () => {
  const pi = fakePi({ streaming: false });
  const h = harness(
    [
      { kind: "child_exited", id: "c", child: "c1", exit: "succeeded" },
      { kind: "human_message", id: "h", from: "u", body: "hi" },
    ],
    pi,
  );
  await h.tick();
  assert.equal(pi.f.calls, 1);
  assert.equal(pi.f.racing, 0);
  assert.match(pi.f.turns[0]!, /Message from a human[\s\S]*Child agent c1 exited/, "human first (priority order)");
  assert.deepEqual(h.acks[0]!.ids, ["h", "c"]);
});

test("streaming Pi: queued per deliverAs (steer for humans and agent signals, followUp for nudges)", async () => {
  const pi = fakePi({ streaming: true });
  const h = harness([{ kind: "human_message", id: "h", from: "u", body: "hi" }], pi);
  await h.tick();
  assert.deepEqual(
    pi.f.queued.map((q) => q.deliverAs),
    ["steer"],
  );
  const pi2 = fakePi({ streaming: true });
  await harness([{ kind: "child_exited", id: "c", child: "c", exit: "succeeded" }], pi2).tick();
  assert.deepEqual(
    pi2.f.queued.map((q) => q.deliverAs),
    ["steer"],
  );
  const pi3 = fakePi({ streaming: true });
  await harness([{ kind: "nudge", id: "n" }], pi3).tick();
  assert.deepEqual(
    pi3.f.queued.map((q) => q.deliverAs),
    ["followUp"],
  );
});

test("streaming Pi: child_result and job_exited are queued as steers, so they reach the agent between tool rounds", async () => {
  const pi = fakePi({ streaming: true });
  await harness([{ kind: "child_result", id: "r", child: "c", result: "ok" }], pi).tick();
  assert.deepEqual(
    pi.f.queued.map((q) => q.deliverAs),
    ["steer"],
  );
  const pi2 = fakePi({ streaming: true });
  await harness([{ kind: "job_exited", id: "j", job: "j", exit: 0 }], pi2).tick();
  assert.deepEqual(
    pi2.f.queued.map((q) => q.deliverAs),
    ["steer"],
  );
});

test("streaming Pi: a nudge with an agent message in one poll is queued once as a steer (documented current behaviour)", async () => {
  // Current behaviour: one steering signal makes the whole batch a steer, so the nudge rides along in that message.
  const pi = fakePi({ streaming: true });
  await harness(
    [
      { kind: "nudge", id: "n" },
      { kind: "message", id: "m", from: "a", body: "x" },
    ],
    pi,
  ).tick();
  assert.deepEqual(
    pi.f.queued.map((q) => q.deliverAs),
    ["steer"],
  );
});

test("an interrupt/cancel aborts only: no injection, no ack, 'aborted' returned", async () => {
  const pi = fakePi({ streaming: false });
  let aborted = 0;
  const h = harness(
    [
      { kind: "human_message", id: "i", from: "u", body: "stop", interrupt: true },
      { kind: "human_message", id: "x", from: "u", body: "x" },
    ],
    pi,
  );
  assert.equal(
    await h.tick(() => {
      aborted++;
    }),
    "aborted",
  );
  assert.deepEqual([aborted, pi.f.calls, h.acks.length], [1, 0, 0]);
});

test("a throwing sendUserMessage leaves the signal unmarked and unacked, so the next poll retries", async () => {
  let fail = true;
  const sent: string[] = [];
  const acks: unknown[] = [];
  const dedupe = new Dedupe();
  const deps = {
    env,
    dedupe,
    nextAckKey: () => "k",
    get: async () => ({ ok: true, status: 200, json: async () => [{ kind: "human_message", id: "h", from: "u", body: "hi" }] }),
    post: async (_u: string, i: { body: string }) => {
      acks.push(i.body);
      return { ok: true, status: 200 };
    },
    sendUserMessage: (t: string) => {
      if (fail) throw new Error("no");
      sent.push(t);
    },
  };
  await runTick(deps);
  assert.deepEqual([sent.length, acks.length], [0, 0]);
  fail = false;
  await runTick(deps);
  assert.deepEqual([sent.length, acks.length], [1, 1]);
});

const rejecting = (failTimes: number) => {
  let n = 0;
  const sent: string[] = [];
  const acks: { ids: string[] }[] = [];
  const logs: string[] = [];
  const deps = {
    env,
    dedupe: new Dedupe(),
    nextAckKey: () => "k",
    log: (l: string) => logs.push(l),
    get: async () => ({ ok: true, status: 200, json: async () => [{ kind: "human_message", id: "h", from: "u", body: "hi" }] }),
    post: async (_u: string, i: { body: string }) => {
      acks.push(JSON.parse(i.body));
      return { ok: true, status: 200 };
    },
    sendUserMessage: async (t: string) => {
      if (++n <= failTimes) throw new Error("rejected");
      sent.push(t);
    },
  };
  return { deps, sent, acks, logs };
};

test("acks only after a successful (awaited) injection, with just the injected ids", async () => {
  const r = rejecting(1);
  await runTick(r.deps);
  assert.deepEqual([r.sent.length, r.acks.length], [0, 0]);
  await runTick(r.deps);
  assert.deepEqual([r.sent.length, r.acks], [1, [{ ids: ["h"], idempotencyKey: "k" }]]);
  assert.equal(r.logs.length, 0);
});

test("a persistently rejected injection is retried, then acked with a logged note", async () => {
  const r = rejecting(99);
  await runTick(r.deps);
  await runTick(r.deps);
  assert.equal(r.acks.length, 0);
  await runTick(r.deps); // MAX_INJECT_ATTEMPTS reached
  assert.deepEqual(
    r.acks.map((a) => a.ids),
    [["h"]],
  );
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0]!, /dropping signals h/);
  await runTick(r.deps); // marked: not retried again
  assert.equal(r.acks.length, 1);
});

test("a coalesced replacement with a new id is injected once; an already-injected id is not re-injected", async () => {
  let inbox: MailSignal[] = [{ kind: "budget_warning", id: "w1", remainingMicros: 2, budgetMicros: 10, thresholdFraction: 0.2 }];
  const sent: string[] = [];
  const acks: string[][] = [];
  const deps = {
    env,
    dedupe: new Dedupe(),
    nextAckKey: () => "k",
    get: async () => ({ ok: true, status: 200, json: async () => inbox }),
    post: async (_u: string, i: { body: string }) => {
      acks.push(JSON.parse(i.body).ids);
      return { ok: true, status: 200 };
    },
    sendUserMessage: (t: string) => void sent.push(t),
  };
  await runTick(deps);
  await runTick(deps);
  inbox = [{ ...inbox[0]!, id: "w2", remainingMicros: 1 }];
  await runTick(deps);
  await runTick(deps);
  assert.equal(sent.length, 2);
  assert.deepEqual(acks, [["w1"], ["w2"]]);
});

test("batchInjections: nothing injectable -> null; steer wins when mixed", () => {
  assert.equal(batchInjections(planPairs([{ kind: "cancel" }])), null);
  assert.equal(batchInjections(planPairs([{ kind: "nudge" }, { kind: "human_message", from: "u", body: "x" }]))!.deliverAs, "steer");
  assert.equal(batchInjections(planPairs([{ kind: "nudge" }]))!.deliverAs, "followUp");
});

// The interactive Pi stays open after ctx.abort(): an abort that did not end the turn must be retried (bounded), and the
// interrupt counts as handled only when the turn actually settled (Dedupe.turnEnded, wired to Pi's agent_settled).
const aborter = (inbox: MailSignal[]) => {
  let t = 0;
  const r = { aborts: 0, sent: 0, acks: 0, logs: [] as string[], dedupe: new Dedupe() };
  const tick = (abort: () => void = () => void r.aborts++) =>
    runTick({
      env,
      dedupe: r.dedupe,
      now: () => t,
      sendUserMessage: () => void r.sent++,
      abort,
      nextAckKey: () => "k",
      log: (l) => r.logs.push(l),
      get: async () => ({ ok: true, status: 200, json: async () => inbox }),
      post: async () => {
        r.acks++;
        return { ok: true, status: 200 };
      },
    });
  const advance = (ms: number) => {
    t += ms;
  };
  return { r, tick, advance };
};
const intr: MailSignal[] = [
  { kind: "human_message", id: "i", from: "u", body: "stop", interrupt: true },
  { kind: "human_message", id: "x", from: "u", body: "x" },
];

test("interrupt: a normal abort ends the turn; handled once, no retry, no injection, no ack (negative control)", async () => {
  const h = aborter(intr);
  assert.equal(await h.tick(), "aborted");
  assert.equal(h.r.dedupe.abortPending(), true, "polls fast until the turn settles");
  assert.equal(h.r.dedupe.turnEnded(), true, "the settle after the abort marks the interrupt handled");
  assert.equal(h.r.dedupe.abortPending(), false);
  h.advance(ABORT_RETRY_MS * 10);
  assert.equal(await h.tick(), "ok");
  assert.equal(h.r.dedupe.turnEnded(), false, "a later settle is not a second interruption");
  assert.deepEqual([h.r.aborts, h.r.sent, h.r.acks, h.r.logs.length], [1, 0, 0, 0]);
});

test("interrupt: an abort ignored once is retried after ABORT_RETRY_MS, then honored: exactly one effective interruption", async () => {
  const h = aborter(intr);
  assert.equal(await h.tick(), "aborted");
  h.advance(ABORT_RETRY_MS - 1);
  assert.equal(await h.tick(), "ok", "not re-aborted before the retry interval");
  assert.equal(h.r.aborts, 1);
  h.advance(1);
  assert.equal(await h.tick(), "aborted", "the interrupt is still queued and the turn did not end: abort again");
  assert.equal(h.r.dedupe.turnEnded(), true);
  h.advance(ABORT_RETRY_MS);
  await h.tick();
  assert.equal(h.r.dedupe.turnEnded(), false);
  assert.deepEqual([h.r.aborts, h.r.sent, h.r.acks, h.r.logs.length], [2, 0, 0, 0]);
});

test("interrupt: an abort never honored is retried MAX_ABORT_ATTEMPTS times, then left to the daemon's kill backstop (logged once)", async () => {
  const h = aborter(intr);
  for (let i = 0; i < MAX_ABORT_ATTEMPTS + 5; i++) {
    await h.tick();
    h.advance(ABORT_RETRY_MS);
  }
  assert.equal(h.r.aborts, MAX_ABORT_ATTEMPTS);
  assert.equal(h.r.logs.length, 1);
  assert.match(h.r.logs[0]!, /interrupt i: .*did not end the turn after 3 attempts.*backstop/);
  assert.deepEqual([h.r.sent, h.r.acks], [0, 0], "the queued message is still never injected (the resume prompt carries it)");
  assert.equal(h.r.dedupe.abortPending(), false, "no fast polling once the retries are spent");
  assert.equal(h.r.dedupe.turnEnded(), true, "a turn that finally settles still counts as handled");
});

test("interrupt: a throwing abort counts as an attempt, so the retries stay bounded", async () => {
  const h = aborter(intr);
  let calls = 0;
  const boom = () => {
    calls++;
    throw new Error("no ctx");
  };
  for (let i = 0; i < MAX_ABORT_ATTEMPTS + 3; i++) {
    assert.equal(await h.tick(boom), "ok");
    h.advance(ABORT_RETRY_MS);
  }
  assert.equal(calls, MAX_ABORT_ATTEMPTS);
  assert.equal(h.r.logs.length, 1);
});

test("interrupt: a settle with no abort in flight marks nothing", async () => {
  const h = aborter([{ kind: "human_message", id: "x", from: "u", body: "x" }]);
  await h.tick();
  assert.equal(h.r.dedupe.turnEnded(), false);
});
