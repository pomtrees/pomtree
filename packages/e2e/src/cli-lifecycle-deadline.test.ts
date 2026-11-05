// YLD-5 and BUD-8 (S1 lifecycle): deadlines while yielded, extend and unlimited deadlines.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-lifecycle-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern '<id>' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import {
  callReply,
  lineValue,
  MODEL_FLAG,
  runningContainers,
  SKIP,
  sleep,
  spawnAgent,
  TEMPLATES,
  TIMEOUT,
  textReply,
  toolLines,
  waitDone,
  withStack,
} from "./cli-lifecycle-support.ts";
import type { AgentJson } from "./cli-scenarios-harness.ts";

// ---- YLD-5 ----
// It is open whether a session deadline fires while an agent is yielded (YLD-5, "verify and record"; unconfirmed).
// Observed here: it does. The parked agent is settled `timed_out` by the reconcile sweep, about 1 s after its deadline with the sweep at 1 s; at the default 30 s
// sweep it was measured 4.5 s late and can be up to one tick late, with no wake, no new container, no model call and no exit cause. The CLI takes any positive
// duration (`--deadline 1ms` parses), but an agent needs several seconds to start and park, so 15 s leaves margin for parking on a loaded host (it parked 7.9 s early on an idle one).
// A yielded agent's deadline is enforced by pomtreed's reconcile sweep (agent.reconcileSweepMs, default 30 s, counted from pomtreed's
// start; measured: with watchdog.sweepMs 1 s and a 15 s deadline it still ended 14.5 s late). The test sets the key to 1 s so the deadline
// and the bounds below can be short; the lateness bound keeps margin over one tick plus the polling interval.
const YLD5_RECONCILE_SWEEP_MS = "1000";
const YLD5_DEADLINE = "15s"; // must exceed the time to start and park (the script sleeps 2 s first)
const YLD5_POLL_MS = 250;
const YLD5_END_WINDOW_MS = 15_000; // how long past the deadline to keep polling for the end
const YLD5_MAX_LATE_MS = 5_000; // allowed lateness: one 1 s tick, the poll interval and teardown, with margin

test("cli lifecycle YLD-5: a deadline that passes while the agent is yielded ends it timed_out shortly after the deadline, with no wake", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "yld5",
    rules: [
      { id: "yield", when: { toolResults: 0 }, reply: callReply("sleep 2; pomtree yield --until message") },
      { id: "parked", when: { toolResults: 1 }, reply: textReply("parked") },
    ],
  };
  await withStack({ script, set: { "agent.reconcileSweepMs": YLD5_RECONCILE_SWEEP_MS } }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:yld5]] park", name: "dl", budget: 500_000, deadline: YLD5_DEADLINE });
    const shown = (await s.pomtree(["show", a.id])).json<{ deadline: { deadlineAt: number | null } }>();
    const deadlineAt = shown.deadline.deadlineAt!;
    assert.ok(Number.isFinite(deadlineAt), "the spawn must carry a finite deadline");
    let yieldedAt = 0;
    let endAt = 0;
    let rec: AgentJson | undefined;
    while (Date.now() < deadlineAt + YLD5_END_WINDOW_MS) {
      rec = await showAgent(s, a.id);
      if (rec.state === "yielded" && !yieldedAt) yieldedAt = Date.now();
      if (["exited", "reaped"].includes(rec.state)) {
        endAt = Date.now();
        break;
      }
      await sleep(YLD5_POLL_MS);
    }
    assert.ok(yieldedAt > 0 && yieldedAt < deadlineAt, `the agent must park before its deadline (parked at ${yieldedAt - deadlineAt} ms from it)`);
    assert.ok(endAt > 0, `the parked agent was still ${rec?.state} ${YLD5_END_WINDOW_MS} ms after its deadline`);
    const lateMs = endAt - deadlineAt;
    const exited = (await s.events(a.id)).filter((e) => e.payload.kind === "exited");
    t.diagnostic(
      `parked ${deadlineAt - yieldedAt} ms before the deadline; seen ended ${lateMs} ms after it as ${rec!.state}/${rec!.exit} cause ${rec!.exitCause}; exited entry ${JSON.stringify(exited.map((e) => e.payload))}`,
    );
    assert.equal(rec!.exit, "timed_out", JSON.stringify(rec));
    assert.ok(lateMs >= -1000 && lateMs <= YLD5_MAX_LATE_MS, `ended ${lateMs} ms after the deadline; expected within ${YLD5_MAX_LATE_MS} ms after it`);
    assert.equal(exited.length, 1, "exactly one exited entry");
    assert.equal(rec!.generation, 0, "no resume: nothing woke the agent");
    assert.equal((await s.kinds(a.id, "resumed")).length, 0, "the deadline must not resume the agent");
    assert.equal(s.stub.calls.length, 1, "no model call after the park");
    await s.until("no container left", async () => (await runningContainers(a.id)).length === 0, 20_000);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// ---- BUD-8 (scaled down: 20 s and 30 s sessions instead of 2 m and 10 m; watchdog.sweepMs 1 s so a deadline is enforced within about a second) ----
// The refusal of an agent's `--deadline 0` is the daemon's: the CLI sends the zero (deadlineDuration(.., allowZero true)) and pomtreed's spawn
// route answers 403 "an unlimited deadline requires operator scope" (api.ts), which pomtree maps to exit 4.
test("cli lifecycle BUD-8: a short deadline ends timed_out, pomtree extend moves one, the operator may spawn --deadline 0, an agent's --deadline 0 exits 4", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "bud8",
    rules: [
      {
        id: "agent-zero",
        when: { lastUserIncludes: "[[scn:bud8agent]]", toolResults: 0 },
        reply: callReply(`pomtree spawn --task 'x' --name zz --budget 150000 --deadline 0 --model ${MODEL_FLAG} 2>&1; echo spawn-exit=$?`, "sleep 200"),
      },
      { id: "busy", when: { lastUserIncludes: "[[scn:bud8", toolResults: 0 }, reply: callReply("sleep 600; echo slept") },
      { id: "stray", when: {}, reply: textReply("stray") },
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { "capacity.maxSessions": "6", "watchdog.sweepMs": "1000" } }, async (s) => {
    const t0 = Date.now();
    const a = await spawnAgent(s, { task: "[[scn:bud8a]] busy", name: "short", budget: 500_000, deadline: "20s" });
    const b = await spawnAgent(s, { task: "[[scn:bud8b]] busy", name: "extended", budget: 500_000, deadline: "30s" });
    const dl = async (id: string) => (await s.pomtree(["show", id])).json<{ deadline: { deadlineAt: number | null } }>().deadline.deadlineAt;
    const aDeadline = await dl(a.id);
    const bDeadline = (await dl(b.id))!;
    assert.ok(aDeadline !== null && Number.isFinite(aDeadline));
    assert.ok(Math.abs(bDeadline - (t0 + 30_000)) < 10_000, `b's deadline is about 30 s out, got ${bDeadline - t0} ms`);

    // pomtree extend: +2 minutes on the current deadline; the shown deadline moves with it.
    const ext = await s.pomtree(["extend", b.id, "--deadline", "2m"]);
    assert.equal(ext.code, 0, `extend: exit ${ext.code}: ${ext.out} ${ext.err}`);
    const moved = ext.json<{ deadlineAt: number; previousDeadlineAt: number }>();
    assert.equal(moved.previousDeadlineAt, bDeadline);
    assert.equal(moved.deadlineAt - moved.previousDeadlineAt, 120_000, "the extension adds the requested two minutes");
    assert.equal(await dl(b.id), moved.deadlineAt);
    // extend refusals: a zero is a usage error (exit 2).
    const zeroExt = await s.pomtree(["extend", b.id, "--deadline", "0"]);
    assert.equal(zeroExt.code, 2, `extend --deadline 0: exit ${zeroExt.code}: ${zeroExt.out} ${zeroExt.err}`);

    // The operator may spawn an unlimited session; it has no recorded deadline, so there is nothing to extend (exit 5).
    const c = await spawnAgent(s, { task: "[[scn:bud8c]] busy", name: "unlimited", budget: 500_000, deadline: "0" });
    assert.equal(await dl(c.id), null, "an operator's --deadline 0 session has no deadline");
    const extC = await s.pomtree(["extend", c.id, "--deadline", "1m"]);
    t.diagnostic(`extend of an unlimited session: exit ${extC.code} ${extC.out.trim()}`);
    assert.equal(extC.code, 5, `extend of an unlimited session: exit ${extC.code}: ${extC.out} ${extC.err}`);

    // From inside an agent: the daemon refuses an unlimited deadline (403 -> exit 4).
    const d = await spawnAgent(s, { task: "[[scn:bud8agent]] try an unlimited child", name: "asker", budget: 1_000_000, template: "scn-parent" });
    await s.until("the asker's tool output", async () => (await toolLines(s, d.id)).some((l) => l.startsWith("spawn-exit=")), 120_000);
    const lines = await toolLines(s, d.id);
    t.diagnostic(`agent spawn --deadline 0: ${JSON.stringify(lines)}`);
    assert.equal(lineValue(lines, "spawn-exit"), "4", `agent's --deadline 0: expected exit 4, got ${JSON.stringify(lines)}`);
    assert.ok(lines.join("\n").includes("an unlimited deadline requires operator scope"), "the refusal names the cause");
    assert.equal((await s.pomtree(["ps", "--parent", d.id])).json<AgentJson[]>().length, 0, "the refused spawn created no child");

    // The first session ends timed_out at its deadline.
    const rec = await waitDone(s, a.id, 90_000);
    const endedAfter = Date.now() - aDeadline!;
    t.diagnostic(`short session: ${rec.state}/${rec.exit} cause ${rec.exitCause}; observed ended ${endedAfter} ms after its deadline`);
    assert.equal(rec.exit, "timed_out", JSON.stringify(rec));
    await s.until("the timed-out container is gone", async () => (await runningContainers(a.id)).length === 0, 30_000);

    // The extended session outlives its original deadline; the unlimited one is still running.
    while (Date.now() < bDeadline + 5000) await sleep(500); // five 1 s watchdog sweeps past the original deadline
    const bNow = await showAgent(s, b.id);
    assert.equal(
      bNow.state,
      "running",
      `extended session must outlive its original deadline (${Date.now() - bDeadline} ms past it), got ${bNow.state}/${bNow.exit}`,
    );
    assert.equal((await showAgent(s, c.id)).state, "running");
    for (const id of [b.id, c.id]) assert.equal((await s.pomtree(["kill", id])).code, 0);
    for (const id of [b.id, c.id]) await waitDone(s, id, 60_000);
    assert.equal(s.stub.calls.filter((x) => x.matched === "stray").length, 0);
  });
});
