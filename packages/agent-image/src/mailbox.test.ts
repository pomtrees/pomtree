import { test } from "node:test";
import assert from "node:assert/strict";
import { Dedupe, formatSignal, plan, planPairs, pollInbox, type Fetch } from "../ext/pomtree-mailbox/mailbox.ts";

const resp =
  (body: unknown, ok = true) =>
  async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

test("pollInbox sends bearer to self inbox and filters junk", async () => {
  let seen: [string, string] | undefined;
  const f: Fetch = async (u, i) => {
    seen = [u, i.headers.authorization!];
    return resp([{ kind: "nudge", id: "a" }, { kind: "nudge" }, 3, {}])();
  };
  const r = await pollInbox({ POMTREE_API: "http://h:1/", POMTREE_TOKEN: "t" }, f);
  assert.deepEqual(seen, ["http://h:1/v1/agents/self/inbox", "Bearer t"]);
  assert.deepEqual(r, [{ kind: "nudge", id: "a" }]); // id-less signals cannot be acked: dropped
});

test("pollInbox is inert without env and on failure", async () => {
  assert.deepEqual(await pollInbox({}, resp([{ kind: "x", id: "1" }])), []);
  assert.deepEqual(await pollInbox({ POMTREE_API: "http://h", POMTREE_TOKEN: "t" }, resp([], false)), []);
  assert.deepEqual(
    await pollInbox({ POMTREE_API: "http://h", POMTREE_TOKEN: "t" }, async () => {
      throw new Error("x");
    }),
    [],
  );
});

test("Dedupe is by signal id: same content with a new id is new, same id is not", () => {
  const d = new Dedupe();
  assert.equal(d.fresh([{ kind: "message", id: "a", from: "x", body: "b" }]).length, 1);
  assert.equal(d.fresh([{ kind: "message", id: "a", body: "changed", from: "x" }]).length, 0);
  assert.equal(d.fresh([{ kind: "message", id: "b", from: "x", body: "b" }]).length, 1);
  assert.equal(d.fresh([{ kind: "message", from: "x", body: "no id" }]).length, 0);
});

test("plan orders cancel first, aborts, steers humans and agent signals", () => {
  const p = plan([
    { kind: "child_exited", child: "c", exit: 0 },
    { kind: "human_message", from: "u", body: "hi" },
    { kind: "cancel", graceMs: 1 },
  ]);
  assert.deepEqual(
    p.map((x) => [x.deliverAs, x.abort]),
    [
      ["steer", true],
      ["steer", false],
      ["steer", false],
    ],
  );
  assert.match(formatSignal({ kind: "human_message", from: "u", body: "hi" }), /hi/);
});

test("plan steers child_result and job_exited like child_exited; nudge and budget_warning stay follow-ups", () => {
  const p = plan([
    { kind: "budget_warning" },
    { kind: "job_exited", job: "j", exit: 0 },
    { kind: "nudge" },
    { kind: "child_result", child: "c", result: "ok" },
  ]);
  assert.deepEqual(
    p.map((x) => x.deliverAs),
    ["steer", "steer", "followUp", "followUp"],
  );
});

test("ackInbox posts injected ids with a key; fail-safe", async () => {
  const { ackInbox } = await import("../ext/pomtree-mailbox/mailbox.ts");
  let seen: { u: string; body: string } | undefined;
  const ok = await ackInbox(
    { POMTREE_API: "http://h:1/", POMTREE_TOKEN: "t" },
    async (u, i) => {
      seen = { u, body: i.body };
      return { ok: true, status: 200 };
    },
    ["s1", "s2"],
    "k1",
  );
  assert.equal(ok, true);
  assert.equal(seen!.u, "http://h:1/v1/agents/self/inbox/ack");
  assert.deepEqual(JSON.parse(seen!.body), { ids: ["s1", "s2"], idempotencyKey: "k1" });
  assert.equal(
    await ackInbox(
      { POMTREE_API: "http://h", POMTREE_TOKEN: "t" },
      async () => {
        throw new Error("x");
      },
      ["s1"],
      "k",
    ),
    false,
  );
  assert.equal(await ackInbox({}, async () => ({ ok: true, status: 200 }), ["s1"], "k"), false);
});

test("interrupt outranks cancel and human; abort-only (no text injection)", () => {
  const p = planPairs([{ kind: "cancel" }, { kind: "human_message", from: "u", body: "stop", interrupt: true }, { kind: "human_message", body: "x" }]);
  assert.deepEqual(
    p.map((x) => [x.s.kind, x.inj.abort, x.inj.inject]),
    [
      ["human_message", true, false],
      ["cancel", true, false],
      ["human_message", false, true],
    ],
  );
  assert.equal(p[0]!.s.interrupt, true);
  assert.equal(p[0]!.inj.text, "");
});

const escalation = {
  kind: "escalation",
  id: "e1",
  escalation: "esc_1",
  subject: "budget_raise",
  from: "agent_7",
  body: "need more",
  requestedMicros: 5_000_000,
  spentMicros: 9_000_000,
  budgetMicros: 10_000_000,
  deadlineAt: Date.UTC(2026, 9, 14, 12),
};

test("formatSignal escalation: asker, ask, amount, deadline and exact verbs", () => {
  const t = formatSignal(escalation);
  for (const m of [
    /agent_7/,
    /need more/,
    /\$5\.00/,
    /2026-10-14T12:00:00/,
    /pomtree decide esc_1 approve\|deny\|pass \[--grant \$USD\]/,
    /pomtree answer esc_1 <text>/,
    /pomtree pass esc_1/,
    /out of YOUR own remaining budget/,
    /pomtree decide esc_1 pass/,
  ])
    assert.match(t, m);
  assert.doesNotMatch(formatSignal({ ...escalation, subject: "ask", requestedMicros: undefined }), /budget raise/);
});

test("formatSignal budget_warning: remaining/budget and wrap-up advice", () => {
  const t = formatSignal({ kind: "budget_warning", id: "w", remainingMicros: 1_500_000, budgetMicros: 10_000_000, thresholdFraction: 0.2 });
  assert.match(t, /\$1\.50 remaining of \$10\.00/);
  assert.match(t, /pomtree push/);
  assert.match(t, /report/);
  assert.match(t, /yield/);
});

test("escalation steers like other steering kinds; budget_warning is advisory and last", () => {
  const p = planPairs([
    { kind: "budget_warning", id: "w" },
    { kind: "nudge", id: "n" },
    { kind: "message", id: "m", from: "a", body: "x" },
    escalation,
    { kind: "human_message", id: "h", from: "u", body: "x" },
  ]);
  assert.deepEqual(
    p.map((x) => x.s.kind),
    ["escalation", "human_message", "message", "nudge", "budget_warning"],
  );
  assert.deepEqual(
    p.map((x) => x.inj.deliverAs),
    ["steer", "steer", "steer", "followUp", "followUp"],
  );
});

test("formatSignal child_exited names the dead parent and the custody commands when custodyOf is set", () => {
  const out = formatSignal({ kind: "child_exited", child: "c1", exit: "succeeded", custodyOf: "p1" });
  assert.equal(
    out,
    '[pomtree] Child agent c1 exited ("succeeded"). Held for you: its parent p1 is gone; inspect it with `pomtree show c1`, then `pomtree reap c1`.',
  );
});

test("formatSignal child_exited without custodyOf is the plain exit text", () => {
  assert.equal(formatSignal({ kind: "child_exited", child: "c1", exit: "succeeded" }), '[pomtree] Child agent c1 exited ("succeeded").');
  assert.equal(formatSignal({ kind: "child_exited", child: "c1", exit: "succeeded", custodyOf: "" }), '[pomtree] Child agent c1 exited ("succeeded").');
});
