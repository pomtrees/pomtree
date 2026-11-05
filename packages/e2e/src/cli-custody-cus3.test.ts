// CUS-3 of cli-custody.test.ts (same harness, helpers in cli-custody-kit.ts; a file of its own so node --test runs it in parallel).
import assert from "node:assert/strict";
import { test } from "node:test";
import { POMTREED_KINDS } from "@pomtree/core";
import type { ModelScript } from "@pomtree/testing";
import { agentContainers, showAgent } from "./cli-crash.ts";
import {
  callReply,
  cancelSignals,
  lineValue,
  MODEL_FLAG,
  SKIP,
  spawnAgent,
  summaryOf,
  TEMPLATES,
  TIMEOUT,
  textReply,
  toolLines,
  waitDone,
  withStack,
} from "./cli-custody-kit.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";

// CUS-3 (verify and record): a parent reports `failed` while one child has exited (unreaped) and one is still running. assertNoOpenChildren
// runs only for `succeeded`, so the result is accepted; then the parent's exit path (Lifecycle.finishTail -> cancelChildren) holds the exited
// child for the parent's nearest live ancestor (here the root, so the operator: a status line, never an auto-reap) and cancels the running
// one (grace period, then kill). Custody applies to a failed parent as to any other (answered as built).
test("cli operator CUS-3: a failed result with an exited and a running child is accepted; cancelChildren holds the exited child for the operator and cancels the running one", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const KID_BUDGET = 150_000;
  const spawnKid = (tag: string) =>
    `pomtree spawn --task '[[scn:${tag}]] go' --name ${tag} --budget ${KID_BUDGET} --model ${MODEL_FLAG} > /tmp/${tag}; echo ${tag}=$(cat /tmp/${tag})`;
  const script: ModelScript = {
    name: "cus3",
    rules: [
      { id: "parent-spawn", when: { marker: "parent", toolResults: 0 }, reply: callReply([spawnKid("cus3a"), spawnKid("cus3b")].join("; ")) },
      {
        id: "parent-fail",
        when: { marker: "parent", toolResults: 1 },
        reply: callReply(
          // A has exited and B is running (inside its sleep) before the parent fails: the host releases this hold only once B's
          // container is up and B is inside its tool call. The parent never reaps either. (`pomtree show` is self-only for an agent,
          // pomtreed/src/api.ts `target` without allowChild, so the parent cannot poll B itself.)
          "for i in 1 2 3 4 5 6 7 8; do pomtree wait $(cat /tmp/cus3a) --timeout 15000 && break; done; " +
            holdUntilReleased("pomtree result --status failed --summary x; echo result-exit=$?"),
        ),
      },
      { id: "parent-done", when: { marker: "parent", toolResults: 2 }, reply: textReply("STUB-PARENT-DONE") },
      { id: "kid-a-result", when: { lastUserIncludes: "[[scn:cus3a]]", toolResults: 0 }, reply: callReply("pomtree result --summary 'a done'") },
      { id: "kid-b-busy", when: { lastUserIncludes: "[[scn:cus3b]]", toolResults: 0 }, reply: callReply("sleep 300; echo b-slept") },
      { id: "kid-done", when: { toolResults: 1 }, reply: textReply("STUB-KID-DONE") },
    ],
  };
  await withStack({ script, templates: TEMPLATES }, async (s) => {
    const p = await spawnAgent(s, { task: "[[scn:cus3parent]] go", name: "parent", budget: 1_000_000, template: "scn-parent" });
    await s.until("both children are spawned", async () => lineValue(await toolLines(s, p.id), "cus3b") !== undefined, 60_000);
    const bId = lineValue(await toolLines(s, p.id), "cus3b")!;
    await s.until("sibling B is running inside its sleep", async () => (await s.kinds(bId, "tool_call")).length > 0, 60_000);
    assert.equal((await showAgent(s, bId)).state, "running", "B must be running (not pending) when the parent fails");
    await release([`pomtree-${(await showAgent(s, p.id)).sandbox}`]);
    const rec = await waitDone(s, p.id);
    const lines = await toolLines(s, p.id);
    const aId = lineValue(lines, "cus3a");
    assert.ok(aId && bId, `expected both child ids in the parent's tool output, got ${JSON.stringify(lines)}`);

    // Observed: the failed result is accepted (exit 0), recorded once, and the parent exits failed.
    assert.equal(lineValue(lines, "result-exit"), "0", `the failed result: expected exit 0, got ${lineValue(lines, "result-exit")}`);
    assert.equal(rec.exit, "failed", JSON.stringify(rec));
    assert.equal(summaryOf(rec), "x");
    assert.equal((await s.kinds(p.id, POMTREED_KINDS.result)).length, 1, "exactly one recorded result on the parent");

    // Observed: the exited child is held, not reaped: the parent's nearest live ancestor is the root, so the operator is told once and reaps it.
    const a = await waitDone(s, aId);
    assert.equal(a.state, "exited", `exited child: expected held (exited) for the operator, got ${a.state}`);
    assert.equal(a.exit, "succeeded");
    assert.equal(summaryOf(a), "a done");
    const sentLines = async () => (await s.kinds(aId, "message_sent")).map((e) => String(e.payload.subject));
    await s.until("the custody status line is journaled", async () => (await sentLines()).some((l) => l.includes("held for the operator")), 60_000);
    const sent = await sentLines();
    const held = sent.filter((l) => l.includes("held for the operator"));
    assert.equal(held.length, 1, `expected one custody status line for the operator, got ${JSON.stringify(sent)}`);
    assert.ok(held[0]!.includes(`pomtree show ${aId}`) && held[0]!.includes(`pomtree reap ${aId}`), `the line names the action: ${held[0]}`);

    // Observed: the running child is stopped by the parent's exit path (its sleep is aborted), and its container goes away.
    const b = await waitDone(s, bId, 90_000);
    const updatedAt = (x: unknown) => (x as { updatedAt: number }).updatedAt;
    const lag = updatedAt(b) - updatedAt(await showAgent(s, p.id));
    t.diagnostic(
      `parent ${rec.exit}/${rec.state}; exited child ${a.state}; running child ${b.exit}/${b.state} cause ${b.exitCause}; child update minus parent update ${lag} ms`,
    );
    assert.ok(Math.abs(lag) <= 10_000 + 30_000, `the running child ended ${lag} ms from the parent's exit; expected within the 10 s grace plus a kill`);
    assert.equal((await cancelSignals(s, bId)).length, 1, "the running child's journal records the parent-exit cancel signal");
    assert.equal((await cancelSignals(s, aId)).length, 0, "the exited child was held, not cancelled: no cancel signal");
    await t.test("the running child is recorded cancelled", () => {
      assert.equal(b.exit, "cancelled", `running child: expected cancelled, got ${b.exit}/${b.state} cause ${b.exitCause}`);
    });
    await s.until("the cancelled child's container is gone", async () => (await agentContainers(bId)).every((c) => !c.running), 30_000);
    assert.equal(
      (await s.kinds(p.id, "error")).filter((e) => String(e.payload.message).startsWith("orphan cancel")).length,
      0,
      "no orphan-cancel error on the parent",
    );
    // The operator reaps the held child by hand; the result survives.
    const reap = await s.pomtree(["reap", aId]);
    assert.equal(reap.code, 0, `operator reap of the held child: exit ${reap.code}: ${reap.out} ${reap.err}`);
    assert.equal((await showAgent(s, aId)).state, "reaped");
    assert.equal(summaryOf(await showAgent(s, aId)), "a done");
    assert.deepEqual(s.stub.unmatched, []);
  });
});
