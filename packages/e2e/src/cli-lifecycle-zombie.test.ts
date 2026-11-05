// CUS-4 (S1 lifecycle): the zombie alert.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-lifecycle-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern '<id>' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import {
  callReply,
  childIds,
  lineValue,
  MODEL_FLAG,
  SKIP,
  sleep,
  spawnAgent,
  summaryOf,
  TEMPLATES,
  TIMEOUT,
  textReply,
  toolLines,
  waitDone,
  withStack,
} from "./cli-lifecycle-support.ts";

// ---- CUS-4 ----
// The zombie sweep runs every agent.zombieSweepMs (default 30 s; set to 1 s here), counted from pomtreed's start, so an alert lands up to one
// sweep after agent.zombieMs.
// Observed on a default stack: the alert is two
// entries on the zombie's own journal, an `error` "zombie: ..." and a `message_sent` (channel "ui", purpose alert) which is what the user
// outbox shows. It is not an escalation, so `pomtree escalations ls` does not list it. Pi runs the calls of one reply in parallel, so each
// scripted reply here is one bash command.
test("cli lifecycle CUS-4: an unreaped child of a live parent raises one zombie alert on its journal and stays exited with its result until the parent reaps it", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "cus4",
    rules: [
      {
        id: "parent-reap",
        when: { marker: "parent", lastUserIncludes: "ANSWER-4" },
        times: 1,
        reply: callReply("K=$(pomtree peers | awk '$2==\"zkid\"{print $1}'); echo kid=$K; pomtree reap $K; echo reap-exit=$?; pomtree result --summary p4"),
      },
      { id: "parent-end", when: { marker: "parent", lastUserIncludes: "ANSWER-4" }, reply: textReply("STUB-PARENT-DONE") },
      {
        id: "parent-spawn",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus4parent]]", toolResults: 0 },
        reply: callReply(
          `K=$(pomtree spawn --task '[[scn:cus4kid]] go' --name zkid --budget 150000 --model ${MODEL_FLAG}); echo kid=$K; pomtree wait $K --timeout 15000; echo wait-exit=$?; pomtree ask "hold" --wait 600000; echo ask-exit=$?`,
        ),
      },
      { id: "parent-parked", when: { marker: "parent" }, reply: textReply("parked") },
      { id: "kid-result", when: { lastUserIncludes: "[[scn:cus4kid]]", toolResults: 0 }, reply: callReply("pomtree result --summary KID-ZOMBIE-DONE") },
      { id: "kid-end", when: { lastUserIncludes: "[[scn:cus4kid]]", toolResults: 1 }, reply: textReply("STUB-KID-DONE") },
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { "agent.zombieMs": "1000", "agent.zombieSweepMs": "1000" } }, async (s) => {
    const p = await spawnAgent(s, { task: "[[scn:cus4parent]] spawn and hold", name: "holder", budget: 1_000_000, template: "scn-parent" });
    const kid = (await childIds(s, p.id, ["zkid"])).zkid!;
    await s.until("the child exited", async () => (await showAgent(s, kid)).state === "exited", 90_000);
    const exitedAt = Date.now();
    const zombieErrors = async () => (await s.kinds(kid, "error")).filter((e) => String(e.payload.message).startsWith("zombie:"));
    await s.until("the zombie alert", async () => (await zombieErrors()).length > 0, 90_000);
    const alertAfter = Date.now() - exitedAt;
    const first = await zombieErrors();
    t.diagnostic(`zombie alert ${alertAfter} ms after the child was seen exited: ${JSON.stringify(first.map((e) => e.payload.message))}`);
    assert.equal(first.length, 1, "one alert");
    assert.match(
      String(first[0]!.payload.message),
      new RegExp(`^zombie: exited succeeded and unreaped by parent ${p.id} for \\d+s$`),
      "the alert names the cause and the parent",
    );
    assert.equal(first[0]!.agent, kid, "the alert is on the zombie's own journal");

    const esc = (await s.pomtree(["escalations", "ls"])).json<{ id: string; agent: string; question: string }[]>();
    t.diagnostic(`escalations ls: ${JSON.stringify(esc.map((e) => [e.agent === p.id ? "parent" : e.agent, e.question]))}`);
    assert.deepEqual(
      esc.map((e) => e.question),
      ["hold"],
      "the only escalation is the parent's ask; the zombie alert is not one",
    );
    const sent = await s.kinds(kid, "message_sent");
    t.diagnostic(`message_sent on the zombie: ${JSON.stringify(sent.map((e) => e.payload))}`);
    assert.equal(sent.length, 1, "one user-outbox alert");
    assert.equal(sent[0]!.payload.channel, "ui");
    assert.equal(sent[0]!.payload.purpose, "alert");
    assert.equal(sent[0]!.payload.subject, first[0]!.payload.message, "the outbox alert carries the same text, naming the parent");

    // Two more sweeps: no repeated alert; the child is neither reaped nor changed.
    await sleep(5_000); // several 1 s sweeps: still one alert
    assert.equal((await zombieErrors()).length, 1, "the sweep alerts once per zombie, not once per sweep");
    const stillThere = await showAgent(s, kid);
    assert.equal(stillThere.state, "exited", "the sweep never reaps");
    assert.equal(stillThere.exit, "succeeded");
    assert.equal(summaryOf(stillThere), "KID-ZOMBIE-DONE");
    assert.equal((await s.kinds(kid, "reaped")).length, 0);
    assert.equal((await s.kinds(kid, "message_sent")).length, 1, "still one outbox alert after the later sweeps");

    // Only the parent reaps: answer its ask, it reaps the child and reports.
    const ans = await s.pomtree(["answer", esc[0]!.id, "ANSWER-4 go on"]);
    assert.equal(ans.code, 0, `answer: exit ${ans.code}: ${ans.out} ${ans.err}`);
    const parent = await waitDone(s, p.id);
    assert.equal(parent.exit, "succeeded", JSON.stringify(parent));
    const lines = await toolLines(s, p.id);
    assert.equal(lineValue(lines, "reap-exit"), "0", `the parent's reap: ${JSON.stringify(lines)}`);
    const reaped = await showAgent(s, kid);
    assert.equal(reaped.state, "reaped");
    assert.equal(summaryOf(reaped), "KID-ZOMBIE-DONE", "the result survives the reap");
    assert.equal((await zombieErrors()).length, 1);
    assert.deepEqual(s.stub.unmatched, []);
  });
});
