// S1 custody scenarios on the CLI harness (CUS-3, CUS-7): the real pomtreed, real agent containers and
// FakeModelUpstream, driven through the real `pomtree` binary. Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends
// money. The in-process half of CUS-6, CUS-9 and CUS-11 is custody.test.ts. Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern 'CUS-7' packages/e2e/src/cli-custody.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { agentContainers, showAgent } from "./cli-crash.ts";
import {
  answerAsk,
  callReply,
  cancelSignals,
  doneRule,
  idsFromPs,
  kidRule,
  lateSignal,
  lineValue,
  MODEL_FLAG,
  nodeOf,
  reapView,
  SETTINGS,
  SKIP,
  signalsOn,
  spawnAgent,
  spawnKidCmd,
  summaryOf,
  TEMPLATES,
  TIMEOUT,
  toolLines,
  waitAllCmd,
  waitDone,
  waitView,
  withStack,
} from "./cli-custody-kit.ts";
import type { AgentJson, JournalEvent } from "./cli-scenarios-harness.ts";

// CUS-7: an operator kill of a parent cancels its live child (SPEC lifecycle rule 4).
test("cli operator CUS-7: pomtree kill of a parent cancels its sleeping child within grace plus kill, the container is gone, no orphan-cancel-error", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "cus7",
    rules: [
      {
        id: "parent-spawn",
        when: { marker: "parent", toolResults: 0 },
        reply: callReply(
          `pomtree spawn --task '[[scn:cus7kid]] sleep' --name cus7kid --budget 150000 --model ${MODEL_FLAG} > /tmp/kid; echo kid=$(cat /tmp/kid)`,
        ),
      },
      { id: "parent-sleep", when: { marker: "parent", toolResults: 1 }, reply: callReply("sleep 300; echo parent-slept") },
      { id: "kid-busy", when: { lastUserIncludes: "[[scn:cus7kid]]", toolResults: 0 }, reply: callReply("sleep 300; echo kid-slept") },
    ],
  };
  await withStack({ script, templates: TEMPLATES }, async (s) => {
    const p = await spawnAgent(s, { task: "[[scn:cus7parent]] go", name: "parent", budget: 1_000_000, template: "scn-parent" });
    let kidId = "";
    await s.until(
      "the child running its sleep",
      async () => {
        const kid = (await s.pomtree(["ps"])).json<AgentJson[]>().find((a) => a.parent === p.id);
        kidId = kid?.id ?? "";
        return kid?.state === "running" && s.stub.calls.some((c) => c.matched === "kid-busy");
      },
      120_000,
    );
    await s.until("the parent in its sleep", async () => s.stub.calls.some((c) => c.matched === "parent-sleep"), 60_000);
    const killedAt = Date.now();
    const k = await s.pomtree(["kill", p.id]);
    assert.equal(k.code, 0, `kill: exit ${k.code}: ${k.out} ${k.err}`);
    const kid = await waitDone(s, kidId, 90_000);
    const tookMs = Date.now() - killedAt;
    t.diagnostic(`child ended ${kid.exit}/${kid.state} ${tookMs} ms after the kill (graceMs 10000)`);
    assert.ok(tookMs <= 10_000 + 30_000, `child took ${tookMs} ms after the kill; expected within the 10 s grace plus a kill`);
    assert.equal((await cancelSignals(s, kidId)).length, 1, "the child's journal records the parent-exit cancel signal");
    await t.test("the child is recorded cancelled", () => {
      assert.equal(kid.exit, "cancelled", `child: expected cancelled, got ${kid.exit} cause ${kid.exitCause}`);
    });
    await s.until("the child's container to be gone", async () => (await agentContainers(kidId)).length === 0, 30_000);
    const parent = await waitDone(s, p.id);
    assert.equal(parent.exit, "cancelled", `pomtree kill ends the parent as cancelled, got ${parent.exit}`);
    assert.equal(
      (await s.kinds(p.id, "error")).filter((e) => String(e.payload.message).includes("orphan cancel")).length,
      0,
      "no orphan-cancel-error on the parent",
    );
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// CUS-6 (S1, main path): top -> mid -> two children that report and exit; mid parks in `pomtree ask` and is killed. The children stay exited,
// the top gets one custody signal each (custodyOf = mid), a non-custodian sibling is denied, and the top reaps both and gets the budget back.
// The top and its sibling never yield, so this checks delivery and authorization over the CLI; the wake of a yielded custodian is custody.test.ts.
test("cli operator CUS-6: a killed middle's exited children are held for the top: custody signals, reads and reaps over the CLI, a sibling gets denied", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "cus6",
    rules: [
      lateSignal,
      {
        id: "top",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus6top]]", toolResults: 0 },
        reply: callReply(
          [
            `pomtree spawn --task '[[scn:cus6mid]] go' --name mid --budget 400000 --model ${MODEL_FLAG} > /tmp/mid; MID=$(cat /tmp/mid); echo mid=$MID`,
            "for i in $(seq 1 90); do pomtree wait $MID --timeout 10000 > /dev/null && break; done; echo mid-done=$?",
            // the ids come with the answer to an ask, not from the inbox: the agent's own mailbox extension acks inbox signals as it injects them
            `A=$(pomtree ask "top: send the children ids" --wait 600000); KIDS=$(echo "$A" | cut -d' ' -f2-); echo kids=$KIDS`,
            "for K in $KIDS; do echo kidview-$K=$(" + waitView("$K") + "); done",
            "for K in $KIDS; do echo reap-$K=$(" + reapView("$K") + "); done",
            "echo mid-reap=$(" + reapView("$MID") + ")",
            "pomtree result --summary top-done; echo result-exit=$?",
          ].join("; "),
        ),
      },
      {
        id: "sib",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus6sib]]", toolResults: 0 },
        reply: callReply(
          [
            // The ids come with the answer to an ask, not from the inbox: the pomtree-mailbox extension also peeks and acks the agent's mailbox while a
            // tool call runs, so an operator `send` raced a polling `inbox` loop (two consumers, one message) and could be consumed before the loop saw it.
            `A=$(pomtree ask "sib: send the children ids" --wait 600000); IDS=$(echo "$A" | cut -d' ' -f2-); A=\${IDS% *}; echo sib-target=$A`,
            "pomtree wait $A --timeout 5000 > /tmp/w 2>&1; echo sib-wait-rc=$?; echo sib-wait-out=$(head -c 300 /tmp/w | tr '\\n' ' ')",
            "pomtree reap $A > /tmp/r 2>&1; echo sib-reap-rc=$?; echo sib-reap-out=$(head -c 300 /tmp/r | tr '\\n' ' ')",
            "pomtree result --summary sib-done; echo sib-result-exit=$?",
          ].join("; "),
        ),
      },
      {
        id: "mid",
        when: { lastUserIncludes: "[[scn:cus6mid]]", toolResults: 0 },
        reply: callReply(
          [spawnKidCmd("cus6kida"), spawnKidCmd("cus6kidb"), waitAllCmd("cus6kida", "cus6kidb"), 'pomtree ask "reap?" --wait 600000; echo ask-exit=$?'].join(
            "; ",
          ),
        ),
      },
      kidRule("cus6kida", "poem-a"),
      kidRule("cus6kidb", "poem-b"),
      doneRule("any-done"),
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: SETTINGS }, async (s) => {
    const sib = await spawnAgent(s, { task: "[[scn:cus6sib]] wait for ids", name: "sib", budget: 200_000, template: "scn-parent" });
    const top = await spawnAgent(s, { task: "[[scn:cus6top]] go", name: "top", budget: 1_000_000, template: "scn-parent" });
    let mid!: AgentJson;
    let kids: AgentJson[] = [];
    await s.until(
      "the middle running with both children exited",
      async () => {
        const m = (await idsFromPs(s, top.id)).mid;
        if (!m) return false;
        mid = m;
        kids = Object.values(await idsFromPs(s, m.id));
        return m.state === "running" && kids.length === 2 && kids.every((k) => k.state === "exited");
      },
      120_000,
    );
    const killedAt = Date.now();
    assert.equal((await s.pomtree(["kill", mid.id])).code, 0);
    await waitDone(s, mid.id, 60_000);
    t.diagnostic(`the middle ended ${Date.now() - killedAt} ms after the kill`);
    // The top parks on its ask; its journal holds one custody signal per child, and the children are still exited.
    await s.until(
      "the top's ask for the children ids",
      async () =>
        (await s.pomtree(["escalations", "ls", "--agent", top.id])).json<{ question: string }[]>().some((e) => e.question.includes("send the children ids")),
      90_000,
    );
    t.diagnostic(`the top's park ${Date.now() - killedAt} ms after the kill`);
    for (const k of kids) assert.equal((await showAgent(s, k.id)).state, "exited", `${k.name}: never auto-reaped`);
    const signals = (await s.kinds(top.id, "signal")).map((e) => (e.payload as unknown as { signal: Record<string, unknown> }).signal);
    const custody = signals.filter((x) => x.kind === "child_exited" && x.custodyOf === mid.id);
    assert.deepEqual(custody.map((x) => x.child).sort(), kids.map((k) => k.id).sort(), "one journaled custody signal per child, naming the dead parent");

    // The sibling (not the custodian) is told to read and reap them, and is denied.
    await answerAsk(s, sib.id, "send the children ids", `IDS ${kids[0]!.id} ${kids[1]!.id}`);
    const sibRec = await waitDone(s, sib.id, 90_000);
    const sibLines = await toolLines(s, sib.id);
    t.diagnostic(`sibling: ${JSON.stringify(sibLines.filter((l) => l.startsWith("sib-")))}`);
    assert.equal(lineValue(sibLines, "sib-target"), kids[0]!.id);
    assert.equal(lineValue(sibLines, "sib-wait-rc"), "4", "the sibling's wait is denied (exit 4)");
    assert.equal(lineValue(sibLines, "sib-reap-rc"), "4", "the sibling's reap is denied (exit 4)");
    assert.match(lineValue(sibLines, "sib-reap-out") ?? "", /custody/, "the denial names the rule");
    assert.equal(sibRec.exit, "succeeded");
    for (const k of kids) assert.equal((await showAgent(s, k.id)).state, "exited", `${k.name}: the denied reap changed nothing`);

    // The custodian gets the ids, reads each (still exited), reaps each (and the dead middle) and gets the budget back.
    const ans = (await s.pomtree(["escalations", "ls", "--agent", top.id]))
      .json<{ id: string; question: string }[]>()
      .find((e) => e.question.includes("send the children ids"))!;
    assert.equal((await s.pomtree(["escalations", "answer", ans.id, `IDS ${kids.map((k) => k.id).join(" ")}`])).code, 0);
    const topRec = await waitDone(s, top.id, 90_000);
    const lines = await toolLines(s, top.id);
    assert.equal(topRec.exit, "succeeded", JSON.stringify(topRec));
    assert.deepEqual(lineValue(lines, "kids")?.split(" ").sort(), kids.map((k) => k.id).sort());
    for (const [k, poem] of [
      [kids.find((x) => x.name === "cus6kida")!, "poem-a"],
      [kids.find((x) => x.name === "cus6kidb")!, "poem-b"],
    ] as const) {
      assert.equal(lineValue(lines, `kidview-${k.id}`), `exited/succeeded/${poem}`, `${k.name}: the custodian reads it exited, with its result`);
      const [st, unused] = (lineValue(lines, `reap-${k.id}`) ?? "").split("/");
      assert.equal(st, "reaped");
      assert.ok(Number(unused) > 0 && Number(unused) <= 100_000, `${k.name}: the unused budget comes back, got ${unused}`);
      assert.equal((await showAgent(s, k.id)).state, "reaped");
      assert.equal(summaryOf(await showAgent(s, k.id)), poem, "the result survives the reap");
    }
    assert.match(lineValue(lines, "mid-reap") ?? "", /^reaped\/\d+$/, "the top reaps the dead middle too, so its own result is accepted");
    assert.equal(lineValue(lines, "result-exit"), "0");
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// CUS-1 (stub only, not live): the poem relay at k=2 with a dead middle parent. Level 1 (the top, an operator-spawned root child) spawns level 2,
// which spawns the leaf; the leaf writes the poem and exits; level 2 asks instead of reaping and is killed. The leaf's poem reaches the top as
// a held zombie (custodyOf = level 2) that it reads and reaps; the top, a root child, is itself reaped at exit and the operator is the custodian
// for whatever it leaves (CUS-5: what the operator still has is recorded below).
test("cli operator CUS-1: the dead-middle-parent poem relay (k=2, stub): the leaf's poem is held for the top, which reads and reaps it; the operator's view of the top is recorded", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const POEM = ["I feel steady,", "a small lamp in a long hall,", "passing light along."].join("\n");
  const NODE_POEM = `const fs=require("fs");const r=JSON.parse(fs.readFileSync("/tmp/leaf.json","utf8")).record;fs.writeFileSync("/tmp/poem.txt",r.result.summary)`;
  const NODE_PAGE = `const fs=require("fs");fs.writeFileSync("/tmp/poem.html","<!doctype html><html><head><meta charset=utf-8><title>poem</title></head><body><pre>"+fs.readFileSync("/tmp/poem.txt","utf8")+"</pre></body></html>")`;
  const script: ModelScript = {
    name: "cus1",
    rules: [
      lateSignal,
      {
        id: "l1",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus1l1]]", toolResults: 0 },
        reply: callReply(
          [
            `pomtree spawn --task '[[scn:cus1l2]] relay level 2' --name relay-2 --budget 400000 --model ${MODEL_FLAG} > /tmp/l2; L2=$(cat /tmp/l2); echo L2=$L2`,
            "for i in $(seq 1 90); do pomtree wait $L2 --timeout 10000 > /dev/null && break; done; echo l2-done=$?",
            `A=$(pomtree ask "L2 is done; send the leaf id" --wait 600000); LEAF=$(echo "$A" | cut -d' ' -f2); echo LEAF=$LEAF`,
            `echo leaf-view=$(pomtree --json wait $LEAF --timeout 5000 | ${nodeOf('console.log(s.record.state+"/"+s.record.exit)')})`,
            "pomtree --json reap $LEAF > /tmp/leaf.json; echo leaf-reap=$(cat /tmp/leaf.json | " +
              nodeOf(`console.log(s.record.state+"/"+s.unusedMicros)`) +
              ")",
            `node -e '${NODE_POEM}'; echo poem-len=$(wc -c < /tmp/poem.txt)`,
            "pomtree reap $L2 > /dev/null; echo l2-reap-rc=$?",
            `node -e '${NODE_PAGE}'; pomtree report publish /tmp/poem.html --name poem --media-type text/html; echo publish-exit=$?`,
            "pomtree result --summary-file /tmp/poem.txt; echo result-exit=$?",
          ].join("; "),
        ),
      },
      {
        id: "l2",
        when: { lastUserIncludes: "[[scn:cus1l2]]", toolResults: 0 },
        reply: callReply(
          [
            `pomtree spawn --task '[[scn:cus1leaf]] relay leaf' --name relay-3 --budget 150000 --model ${MODEL_FLAG} > /tmp/leaf; echo LEAF=$(cat /tmp/leaf)`,
            waitAllCmd("leaf"),
            'pomtree ask "child exited; reply OK to reap" --wait 600000; echo ask-exit=$?',
          ].join("; "),
        ),
      },
      {
        id: "leaf",
        when: { lastUserIncludes: "[[scn:cus1leaf]]", toolResults: 0 },
        reply: callReply(`printf '%s' '${POEM}' > /tmp/poem.txt; pomtree result --summary-file /tmp/poem.txt; echo result-exit=$?`),
      },
      doneRule("any-done"),
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: SETTINGS }, async (s) => {
    const top = await spawnAgent(s, { task: "[[scn:cus1l1]] relay level 1", name: "relay-1", budget: 1_000_000, template: "scn-parent" });
    let l2!: AgentJson;
    let leaf!: AgentJson;
    await s.until(
      "level 2's ask with the leaf exited",
      async () => {
        const m = (await idsFromPs(s, top.id))["relay-2"];
        if (!m) return false;
        l2 = m;
        const l = (await idsFromPs(s, m.id))["relay-3"];
        if (!l) return false;
        leaf = l;
        const asks = (await s.pomtree(["escalations", "ls", "--agent", m.id])).json<{ question: string }[]>();
        return l.state === "exited" && asks.some((e) => e.question.includes("child exited; reply OK to reap"));
      },
      120_000,
    );
    assert.equal((await s.pomtree(["kill", l2.id])).code, 0);
    await answerAsk(s, top.id, "send the leaf id", `LEAF ${leaf.id}`);
    const topRec = await waitDone(s, top.id, 120_000);
    const lines = await toolLines(s, top.id);
    t.diagnostic(`top tool lines: ${JSON.stringify(lines.filter((l) => /^(L2|l2|custody|LEAF|leaf|poem|publish|result)/.test(l)))}`);

    const journaled = (await signalsOn(s, top.id)).map((x) => `${x.seq}:${String(x.kind)}${x.custodyOf ? `(custodyOf ${String(x.custodyOf)})` : ""}`);
    t.diagnostic(`signals journaled on the top: ${JSON.stringify(journaled)}`);
    // The leaf's poem was held, not auto-reaped, and reached the top, which read it exited and reaped it.
    assert.equal(lineValue(lines, "LEAF"), leaf.id);
    assert.equal(lineValue(lines, "leaf-view"), "exited/succeeded", "the leaf is still exited (a held zombie) when the top reads it");
    assert.match(lineValue(lines, "leaf-reap") ?? "", /^reaped\/\d+$/);
    assert.equal(lineValue(lines, "l2-reap-rc"), "0");
    assert.equal(lineValue(lines, "result-exit"), "0");
    assert.equal(topRec.exit, "succeeded", JSON.stringify(topRec));
    assert.equal(summaryOf(topRec), POEM, "the top's result is the leaf's poem, unchanged");
    const l2Final = await showAgent(s, l2.id);
    assert.equal(l2Final.exit, "cancelled", `the killed middle: ${l2Final.exit}`);
    assert.equal((await showAgent(s, leaf.id)).state, "reaped");
    assert.equal(summaryOf(await showAgent(s, leaf.id)), POEM);
    const custody = (await s.kinds(top.id, "signal"))
      .map((e) => (e.payload as unknown as { signal: Record<string, unknown> }).signal)
      .filter((x) => x.kind === "child_exited" && x.custodyOf === l2.id);
    assert.deepEqual(
      custody.map((x) => x.child),
      [leaf.id],
      "one journaled custody signal for the leaf",
    );

    // CUS-5 for the top (a root child): reaped at exit by the root supervisor; record what the operator still has.
    const show = await s.pomtree(["show", top.id]);
    const topNow = await showAgent(s, top.id);
    assert.equal(topNow.state, "reaped", "a root child is reaped at exit");
    assert.equal(summaryOf(topNow), POEM, "pomtree show still has the result");
    const sent = (await s.kinds(top.id, "message_sent")).map((e) => `${e.payload.channel}/${e.payload.purpose}: ${String(e.payload.subject).slice(0, 120)}`);
    const reports = await s.pomtree(["report", "list", top.id]);
    const reported = reports.json<{ name: string; mediaType: string }[]>();
    const cat = await s.pomtree(["logs", top.id]);
    t.diagnostic(
      `CUS-5 operator view of the top: pomtree show exit ${show.code} state ${topNow.state}; user-outbox lines ${JSON.stringify(sent)}; reports ${JSON.stringify(reported)}; ` +
        `journal kinds ${[
          ...new Set(
            cat.out
              .split("\n")
              .filter(Boolean)
              .map((l) => (JSON.parse(l) as JournalEvent).payload.kind),
          ),
        ].join(",")}`,
    );
    assert.ok(
      sent.some((l) => l.includes("status") && l.includes(top.id)),
      `an exit status line for the operator, got ${JSON.stringify(sent)}`,
    );
    assert.deepEqual(
      reported.map((r) => r.name),
      ["poem"],
      "the reaped root child's report is kept",
    );
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// CUS-9: --disposition reap-on-exit. The parent is told first (child_exited with the clipped handoff and the branch, which is where the work
// is), then the child is reaped; hold and the default stay exited; the bad invocations are usage errors that name the cause and the action.
test("cli operator CUS-9: spawn --disposition reap-on-exit reaps at exit after the parent is told; hold and the default stay exited; bad flags are usage errors", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const kid = (tag: string, flags: string) =>
    `pomtree spawn --task '[[scn:${tag}]] go' --name ${tag} ${flags} --budget 100000 --model ${MODEL_FLAG} > /tmp/${tag}; echo ${tag}=$(cat /tmp/${tag})`;
  const script: ModelScript = {
    name: "cus9",
    rules: [
      lateSignal,
      {
        id: "parent",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus9parent]]", toolResults: 0 },
        reply: callReply(
          [
            kid("cus9adv", "--disposition reap-on-exit"),
            kid("cus9hold", "--disposition hold"),
            kid("cus9plain", ""),
            waitAllCmd("cus9adv", "cus9hold", "cus9plain"),
            'pomtree ask "children done; proceed?" --wait 600000 > /dev/null; echo ask-exit=$?',
            "pomtree reap $(cat /tmp/cus9hold) > /dev/null; echo hold-reap-rc=$?; pomtree reap $(cat /tmp/cus9plain) > /dev/null; echo plain-reap-rc=$?",
            "pomtree result --summary p9; echo result-exit=$?",
          ].join("; "),
        ),
      },
      kidRule("cus9adv", "advisory-result"),
      kidRule("cus9hold", "hold-result"),
      kidRule("cus9plain", "plain-result"),
      doneRule("any-done"),
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: SETTINGS }, async (s) => {
    for (const args of [
      ["--disposition", "other"],
      ["--ttl", "5m", "--disposition", "reap-on-exit"],
      ["--ttl", "0"],
    ]) {
      const r = await s.pomtree(["spawn", "--task", "x", ...args]);
      t.diagnostic(`pomtree spawn ${args.join(" ")} -> exit ${r.code} stdout ${JSON.stringify(r.out.trim())} stderr ${JSON.stringify(r.err.trim())}`);
      assert.equal(r.code, 2, `pomtree spawn ${args.join(" ")}: expected usage exit 2, got ${r.code}: ${r.out} ${r.err}`);
      assert.match(
        r.err + r.out,
        /--disposition must be|--ttl applies only to --disposition hold|--ttl 0 is not a valid TTL; pass a positive duration such as 30m or 2h, or omit --ttl/,
        `the message names the cause: ${r.err}${r.out}`,
      );
    }
    assert.equal((await s.pomtree(["ps"])).json<AgentJson[]>().filter((a) => a.parent !== null).length, 0, "the refused spawns created nothing");

    const parent = await spawnAgent(s, { task: "[[scn:cus9parent]] go", name: "parent", budget: 1_000_000, template: "scn-parent" });
    await s.until(
      "the parent waiting on its ask with all three children exited or reaped",
      async () => {
        const kids = await idsFromPs(s, parent.id);
        return (
          Object.keys(kids).length === 3 &&
          Object.values(kids).every((k) => k.state === "exited" || k.state === "reaped") &&
          s.stub.calls.length > 0 &&
          (await s.pomtree(["escalations", "ls", "--agent", parent.id])).json<{ question: string }[]>().some((e) => e.question.includes("children done"))
        );
      },
      120_000,
    );
    const kids = await idsFromPs(s, parent.id);
    assert.equal(kids.cus9adv!.state, "reaped", "reap-on-exit is reaped at exit");
    assert.equal(kids.cus9hold!.state, "exited", "hold stays exited until the parent reaps it");
    assert.equal(kids.cus9plain!.state, "exited", "the default is hold");
    assert.equal(summaryOf(await showAgent(s, kids.cus9adv!.id)), "advisory-result", "the reaped child's record and result stay readable");

    // The parent was told before the reap, and the notice carries the handoff and the branch (where the work is).
    const told = (await signalsOn(s, parent.id)).find((x) => x.kind === "child_exited" && x.child === kids.cus9adv!.id);
    assert.ok(told, "the parent's journal has the child_exited signal for the reap-on-exit child");
    assert.equal(told.handoff, "advisory-result");
    assert.equal(told.branch, `agent/${kids.cus9adv!.id}`, "the notice names the branch that keeps the work");
    assert.equal(told.custodyOf, undefined, "a live parent is notified as the parent, not as a custodian");
    const reaped = await s.kinds(kids.cus9adv!.id, "reaped");
    assert.equal(reaped.length, 1);
    assert.ok(told.seq < reaped[0]!.seq, `the parent is told (seq ${told.seq}) before the reap (seq ${reaped[0]!.seq})`);
    for (const k of [kids.cus9hold!, kids.cus9plain!]) assert.equal((await s.kinds(k.id, "reaped")).length, 0, `${k.name}: not reaped by the daemon`);

    await answerAsk(s, parent.id, "children done", "go");
    const rec = await waitDone(s, parent.id, 90_000);
    const lines = await toolLines(s, parent.id);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.deepEqual([lineValue(lines, "hold-reap-rc"), lineValue(lines, "plain-reap-rc"), lineValue(lines, "result-exit")], ["0", "0", "0"]);
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// CUS-11: agent.rootCustodyMax = 1. A root-child middle spawns two children that exit and are unreaped, then is killed: the operator is their
// custodian. Both get a status line (nothing dropped or refused), the delivery past the cap is also an error entry and an alert, and both are
// listed as exited and reapable. Only the second delivery is escalated.
test("cli operator CUS-11: past agent.rootCustodyMax every held result still gets its status line, an error entry and an alert are added, and all are reapable", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "cus11",
    rules: [
      lateSignal,
      {
        id: "mid",
        when: { marker: "parent", lastUserIncludes: "[[scn:cus11mid]]", toolResults: 0 },
        reply: callReply(
          [
            spawnKidCmd("cus11kida"),
            spawnKidCmd("cus11kidb"),
            waitAllCmd("cus11kida", "cus11kidb"),
            'pomtree ask "reap?" --wait 600000; echo ask-exit=$?',
          ].join("; "),
        ),
      },
      kidRule("cus11kida", "poem-a"),
      kidRule("cus11kidb", "poem-b"),
      doneRule("any-done"),
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { ...SETTINGS, "agent.rootCustodyMax": "1" } }, async (s) => {
    const mid = await spawnAgent(s, { task: "[[scn:cus11mid]] go", name: "mid", budget: 1_000_000, template: "scn-parent" });
    let kids: AgentJson[] = [];
    await s.until(
      "both children exited under the parked middle",
      async () => {
        kids = Object.values(await idsFromPs(s, mid.id));
        return (
          kids.length === 2 &&
          kids.every((k) => k.state === "exited") &&
          (await s.pomtree(["escalations", "ls", "--agent", mid.id])).json<unknown[]>().length > 0
        );
      },
      120_000,
    );
    assert.equal((await s.pomtree(["kill", mid.id])).code, 0);
    const lines = async (k: AgentJson) =>
      (await s.kinds(k.id, "message_sent")).map((e) => ({ purpose: String(e.payload.purpose), subject: String(e.payload.subject) }));
    await s.until(
      "a status line for each child",
      async () => (await Promise.all(kids.map(lines))).every((l) => l.some((x) => x.purpose === "status" && x.subject.includes("held for the operator"))),
      60_000,
    );
    for (const k of kids) {
      const held = (await lines(k)).filter((x) => x.purpose === "status" && x.subject.includes("held for the operator"));
      assert.equal(held.length, 1, `${k.name}: one status line`);
      assert.ok(held[0]!.subject.includes(`pomtree show ${k.id}`) && held[0]!.subject.includes(`pomtree reap ${k.id}`), held[0]!.subject);
      assert.equal((await showAgent(s, k.id)).state, "exited", `${k.name}: held, never auto-reaped`);
    }
    const alerts = (
      await Promise.all(kids.map(async (k) => ({ k, l: (await lines(k)).filter((x) => x.purpose === "alert" && x.subject.startsWith("custody queue full")) })))
    ).filter((x) => x.l.length);
    const errors = (
      await Promise.all(
        kids.map(async (k) => ({ k, e: (await s.kinds(k.id, "error")).filter((e) => String(e.payload.message).startsWith("custody queue full")) })),
      )
    ).filter((x) => x.e.length);
    t.diagnostic(
      `alerts on ${JSON.stringify(alerts.map((a) => [a.k.name, a.l.length]))}; error entries on ${JSON.stringify(errors.map((a) => [a.k.name, a.e.length]))}; ${alerts[0]?.l[0]?.subject}`,
    );
    assert.ok(alerts.length >= 1 && errors.length >= 1, "past the cap there is an alert and an error entry");
    assert.deepEqual(alerts.map((a) => a.k.id).sort(), errors.map((a) => a.k.id).sort(), "each alert comes with its error entry, on the same child");
    await t.test("only the delivery past the cap is escalated", () => {
      assert.equal(alerts.length, 1, `expected one alert (the second delivery), got ${alerts.length}`);
    });
    const exited = (await s.pomtree(["ps", "--state", "exited"])).json<AgentJson[]>().map((a) => a.id);
    for (const k of kids) {
      assert.ok(exited.includes(k.id), `${k.name} is listed as exited`);
      const r = await s.pomtree(["reap", k.id]);
      assert.equal(r.code, 0, `operator reap of ${k.name}: exit ${r.code}: ${r.out} ${r.err}`);
      assert.equal((await showAgent(s, k.id)).state, "reaped");
    }
    assert.deepEqual(s.stub.unmatched, []);
  });
});
