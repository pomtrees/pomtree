// S1 operator-surface scenarios on the CLI harness (INS-6, RLY-4, BUD-5 operator part, OPS-6, SCH-4, GIT-6, GIT-4,
// YLD-4; the custody items CUS-3 and CUS-7 are in cli-custody.test.ts): the real pomtreed, real agent containers, FakeModelUpstream, driven through the real `pomtree` binary.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern 'INS-6' packages/e2e/src/cli-operator.test.ts
// Late-signal rule: after its final reply an agent can still receive pomtreed's injected `[pomtree] ...` turns (a child exited, an answer).
// Every script here keys its closing text reply on the tool-result count (and marker), not on the task text, so such a turn is matched by
// that closing rule again and stub.unmatched stays empty.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { showAgent } from "./cli-crash.ts";
import {
  callReply,
  type Esc,
  lineValue,
  MODEL_FLAG,
  SKIP,
  socketGet,
  spawnAgent,
  summaryOf,
  TEMPLATES,
  TIMEOUT,
  textReply,
  toolLines,
  untilEscalation,
  waitDone,
  withStack,
} from "./cli-operator-kit.ts";
import type { AgentJson } from "./cli-scenarios-harness.ts";
import { spawnKidCmd, waitReapCmd } from "./rly4-spawn.ts";

// INS-6: doctor, /readyz and one agent on the stub stack.
test("cli operator INS-6: doctor ok, /readyz 200 with no reasons, one agent succeeds and pomtree show prints its result", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async () => {
  const script: ModelScript = {
    name: "ins6",
    rules: [
      { id: "result", when: { toolResults: 0 }, reply: callReply("pomtree result --summary 'stub done'") },
      { id: "done", when: { toolResults: 1 }, reply: textReply("STUB-DONE") },
    ],
  };
  await withStack({ script }, async (s) => {
    const d = await s.pomtree(["doctor"]);
    assert.equal(d.code, 0, `doctor: exit ${d.code}: ${d.out} ${d.err}`);
    // The harness always passes --json, so the plain "ok" line is the renderer's; the JSON carries ok and an empty reasons list.
    const doc = d.json<{ ok: boolean; reasons: string[] }>();
    assert.equal(doc.ok, true, d.out);
    assert.deepEqual(doc.reasons, []);

    const socket = join(dirname(s.stateDir), "pomtreed.sock");
    const ready = await socketGet(socket, "/readyz");
    assert.equal(ready.status, 200, `/readyz: expected 200, got ${ready.status}: ${ready.body}`);
    const body = JSON.parse(ready.body) as { status: string; reasons: string[] };
    assert.equal(body.status, "ready");
    assert.deepEqual(body.reasons, []);

    const a = await spawnAgent(s, { task: "[[scn:ins6]] t", name: "first", budget: 500_000 });
    const ps = await s.pomtree(["ps"]);
    assert.ok(
      ps.json<AgentJson[]>().some((x) => x.id === a.id),
      "the spawned agent must be listed by pomtree ps",
    );
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded");
    const shown = await s.pomtree(["show", a.id]);
    assert.equal(shown.code, 0, shown.err);
    assert.equal(summaryOf(shown.json<{ agent: AgentJson }>().agent), "stub done");
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// RLY-4: agent.maxChildren bounds the unreaped children of a non-root parent; the root (the operator's spawns) is exempt.
test("cli operator RLY-4: a third unreaped child is refused with exit 5 at maxChildren 2, a spawn after a reap succeeds, three operator spawns are accepted", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async () => {
  const KID_BUDGET = 100_000;
  const spawnKid = (n: number) => spawnKidCmd(n, { budget: KID_BUDGET, model: MODEL_FLAG });
  const waitReap = (n: number) => waitReapCmd(n);
  const script: ModelScript = {
    name: "rly4",
    rules: [
      { id: "parent-spawn3", when: { marker: "parent", toolResults: 0 }, reply: callReply([spawnKid(1), spawnKid(2), spawnKid(3)].join("; ")) },
      // Reap kid1, then the spawn that was refused before fits.
      { id: "parent-reap-spawn", when: { marker: "parent", toolResults: 1 }, reply: callReply([waitReap(1), spawnKid(4)].join("; ")) },
      { id: "parent-reap-rest", when: { marker: "parent", toolResults: 2 }, reply: callReply([waitReap(2), waitReap(4)].join("; ")) },
      { id: "parent-result", when: { marker: "parent", toolResults: 3 }, reply: callReply("pomtree result --summary 'rly4 done'; echo result-exit=$?") },
      { id: "parent-done", when: { marker: "parent", toolResults: 4 }, reply: textReply("STUB-PARENT-DONE") },
      { id: "kid-result", when: { lastUserIncludes: "[[scn:rly4kid]]", toolResults: 0 }, reply: callReply("pomtree result --summary 'kid done'") },
      { id: "kid-done", when: { toolResults: 1 }, reply: textReply("STUB-KID-DONE") },
    ],
  };
  await withStack({ script, templates: TEMPLATES, set: { "agent.maxChildren": "2" } }, async (s) => {
    // The root is exempt: three operator spawns are all accepted (each is a child of the root supervisor).
    const ops = [
      await spawnAgent(s, { task: "[[scn:rly4kid]] op 1", name: "op1", budget: KID_BUDGET }),
      await spawnAgent(s, { task: "[[scn:rly4kid]] op 2", name: "op2", budget: KID_BUDGET }),
      await spawnAgent(s, { task: "[[scn:rly4kid]] op 3", name: "op3", budget: KID_BUDGET }),
    ];
    for (const o of ops) assert.equal((await waitDone(s, o.id)).exit, "succeeded");

    const p = await spawnAgent(s, { task: "[[scn:rly4parent]] go", name: "parent", budget: 1_000_000, template: "scn-parent" });
    const rec = await waitDone(s, p.id);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    const lines = await toolLines(s, p.id);
    assert.equal(lineValue(lines, "SPAWN1"), "0");
    assert.equal(lineValue(lines, "SPAWN2"), "0");
    assert.equal(lineValue(lines, "SPAWN3"), "5", `third spawn: expected exit 5, got ${lineValue(lines, "SPAWN3")}`);
    assert.ok(
      lineValue(lines, "ERR3")?.includes("parent already has 2 unreaped children (limit 2)"),
      `third spawn error: expected the limit message, got ${lineValue(lines, "ERR3")}`,
    );
    assert.equal(lineValue(lines, "REAPED1"), "0");
    assert.equal(lineValue(lines, "SPAWN4"), "0", `spawn after a reap: expected exit 0, got ${lineValue(lines, "SPAWN4")}: ${lineValue(lines, "ERR4")}`);
    assert.equal(lineValue(lines, "REAPED2"), "0");
    assert.equal(lineValue(lines, "REAPED4"), "0");
    assert.equal(lineValue(lines, "result-exit"), "0");
    const kids = (await s.pomtree(["ps"])).json<AgentJson[]>().filter((a) => a.parent === p.id);
    assert.deepEqual(kids.map((k) => k.name).sort(), ["kid1", "kid2", "kid4"], "kid3 must not exist");
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// BUD-5, operator part: a budget above budget.rootMicros is refused by the daemon (409, exit 5); a negative or fractional amount is a usage
// error caught by the CLI (exit 2). No agent starts, so no container is involved. The agent part (carve above the parent's remainder)
// runs offline through the real API in proxy-budget.test.ts.
test("cli operator BUD-5 (operator part): a spawn budget above budget.rootMicros exits 5, a negative or fractional one exits 2", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  await withStack({ script: { name: "bud5", rules: [] } }, async (s) => {
    const spawn = (budget: string) => s.pomtree(["spawn", "--task", "t", "--name", "over", "--budget", budget, "--model", MODEL_FLAG]);
    const over = await spawn("10000001"); // the default budget.rootMicros is 10_000_000
    t.diagnostic(`above rootMicros: exit ${over.code}; stdout ${JSON.stringify(over.out)}; stderr ${JSON.stringify(over.err)}`);
    assert.equal(over.code, 5, `above rootMicros: expected exit 5, got ${over.code}: ${over.out} ${over.err}`);
    // The CLI prints only the daemon's message ({"error":...}); the machine code budget_exceeds_parent is not surfaced by pomtree (reported to the lead).
    assert.match(over.out, /exceeds the \$10\.00 \(10000000 micros\) the parent has left/);
    const neg = await spawn("-5");
    t.diagnostic(`negative: exit ${neg.code}; stderr ${JSON.stringify(neg.err)}`);
    assert.equal(neg.code, 2, `--budget -5: expected exit 2, got ${neg.code}: ${neg.out} ${neg.err}`);
    // The parser has no `--budget=-5` form (flags take the next argv), so the spaced form stays; the usage error (printed on stdout under --json) must name the flag.
    assert.match(neg.out + neg.err, /--budget must be/, `--budget -5: exit 2 must come from the budget check, got ${neg.out} ${neg.err}`);
    const frac = await spawn("1.5");
    t.diagnostic(`fractional: exit ${frac.code}; stderr ${JSON.stringify(frac.err)}`);
    assert.equal(frac.code, 2, `--budget 1.5: expected exit 2, got ${frac.code}: ${frac.out} ${frac.err}`);
    assert.match(frac.out + frac.err, /--budget must be/, `--budget 1.5: exit 2 must come from the budget check, got ${frac.out} ${frac.err}`);
    const agents = (await s.pomtree(["ps"])).json<AgentJson[]>().filter((a) => a.parent !== null);
    assert.deepEqual(agents, [], "no refused spawn may leave an agent behind");
  });
});

// OPS-6, answer path: `pomtree ask --wait 600000` is longer than wait.yieldMs (default 20 s), so the asker yields and the operator's answer
// wakes it with a bumped generation; the resume message carries the answer exactly once. The options are alpha-1/beta-2 (not a/b) so the
// answer text is unique in the model's requests.
test("cli operator OPS-6: an ask lists its options, pomtree answer wakes the asker once with the answer", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const script: ModelScript = {
    name: "ops6-answer",
    rules: [
      { id: "answered", when: { lastUserIncludes: "alpha-1" }, times: 1, reply: callReply("pomtree result --summary 'got alpha-1'") },
      { id: "after-answer", when: { lastUserIncludes: "alpha-1" }, reply: textReply("STUB-DONE") },
      { id: "ask", when: { toolResults: 0 }, reply: callReply('pomtree ask "pick one" --options alpha-1,beta-2 --wait 600000; echo ask-exit=$?') },
      { id: "parked", when: {}, reply: textReply("parked") },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:ops6]] ask the operator", name: "asker", budget: 500_000 });
    const esc = await untilEscalation(s, a.id);
    assert.equal(esc.question, "pick one");
    assert.deepEqual(esc.options, ["alpha-1", "beta-2"]);
    await s.until("the asker parked", async () => (await showAgent(s, a.id)).state === "yielded", 60_000);
    const genBefore = (await showAgent(s, a.id)).generation;

    const ans = await s.pomtree(["answer", esc.id, "alpha-1"]);
    assert.equal(ans.code, 0, `answer: exit ${ans.code}: ${ans.out} ${ans.err}`);
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.equal(summaryOf(rec), "got alpha-1");
    const carrying = s.stub.calls.filter((c) => c.lastUserText?.includes("alpha-1"));
    t.diagnostic(
      `requests carrying the answer: ${carrying.length} (${carrying.map((c) => c.matched)}); last user text: ${JSON.stringify(carrying[0]?.lastUserText)}`,
    );
    assert.equal(carrying.filter((c) => c.matched === "answered").length, 1, "the answer must reach the model's next request exactly once");
    assert.equal(rec.generation, genBefore + 1, "one resume: generation bumped once");
    const delivered = (await s.events(a.id)).filter(
      (e) => e.payload.kind === "message" && e.payload.role === "user" && String(e.payload.text).includes("alpha-1"),
    );
    assert.equal(delivered.length, 1, `the answer must be delivered to the model once, journal shows ${delivered.length}`);
    const done = (await s.pomtree(["escalations", "ls", "--agent", a.id])).json<Esc[]>().find((e) => e.id === esc.id);
    assert.equal(done?.state, "answered");
    assert.equal(done?.answer, "alpha-1");
    assert.deepEqual(s.stub.unmatched, []);
  });
});
