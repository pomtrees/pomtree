// S1 lifecycle scenarios on the CLI harness (REC-8, GIT-3, SAF-6, OPS-2): drain and restart, workspace clones, workflow launch refusal, observability commands; the YLD, BUD and CUS items are in cli-lifecycle-*.test.ts.
// Docker-gated like cli-scenarios.test.ts (cliScenarioSkip); nothing here spends money. Helpers: cli-lifecycle-support.ts.
// Run one test at a time:
//   PTREE_DOCKER_TESTS=1 PTREE_E2E_IMAGE=<image> node --test --test-name-pattern '<id>' packages/e2e/src/<this file>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelScript } from "@pomtree/testing";
import { agentContainers, showAgent } from "./cli-crash.ts";
import { holdUntilReleased, release } from "./cli-hold.ts";
import { callReply, MODEL_FLAG, runningContainers, SKIP, spawnAgent, summaryOf, TIMEOUT, textReply, waitDone, withStack } from "./cli-lifecycle-support.ts";
import type { AgentJson, Stack } from "./cli-scenarios-harness.ts";
import { gitRepo } from "./harness.ts";

// REC-8: `pomtree drain` stops admission without stopping agents; a SIGTERM restart (the supervisor's drain) leaves the container running and
// the new pomtreed adopts it, so the agent finishes once with one container and no duplicate agent.
test("cli lifecycle REC-8: drain refuses the next spawn, the busy agent's container survives the SIGTERM restart, is adopted and finishes once", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const script: ModelScript = {
    name: "rec8",
    rules: [
      { id: "busy", when: { toolResults: 0 }, reply: callReply(holdUntilReleased("echo slept-through-drain")) },
      { id: "result", when: { toolResults: 1 }, reply: callReply("pomtree result --summary 'finished after drain'") },
      { id: "done", when: { toolResults: 2 }, reply: textReply("STUB-DONE") },
    ],
  };
  await withStack({ script }, async (s) => {
    const a = await spawnAgent(s, { task: "[[scn:rec8]] go", name: "busy", budget: 500_000 });
    await s.until(
      "the agent inside its sleep",
      async () => s.stub.calls.some((c) => c.matched === "busy") && (await runningContainers(a.id)).length === 1,
      120_000,
    );
    const before = await runningContainers(a.id);
    const genBefore = (await showAgent(s, a.id)).generation;

    const drain = await s.pomtree(["drain", "--deadline", "30000"]);
    t.diagnostic(`drain: exit ${drain.code} out ${JSON.stringify(drain.out.trim())} err ${JSON.stringify(drain.err.trim())}`);
    assert.equal(drain.code, 0, `drain: exit ${drain.code}: ${drain.out} ${drain.err}`);
    assert.equal(drain.json<{ draining: boolean }>().draining, true);

    const late = await s.pomtree(["spawn", "--task", "[[scn:rec8late]] go", "--name", "late", "--budget", "500000", "--model", MODEL_FLAG]);
    t.diagnostic(`spawn after drain: exit ${late.code} out ${JSON.stringify(late.out.trim())} err ${JSON.stringify(late.err.trim())}`);
    // Observed: refused by the daemon (LifecycleError 503 "daemon is draining; spawns are paused"), not queued.
    assert.notEqual(late.code, 0, "a spawn after the drain must not be accepted");
    assert.match(late.out + late.err, /draining; spawns are paused/, `the refusal must name the drain and the cause, got: ${late.out} ${late.err}`);
    assert.equal(
      (await s.pomtree(["ps"])).json<AgentJson[]>().filter((x) => x.name === "late").length,
      0,
      "a refused spawn must leave no agent (neither queued nor pending)",
    );
    assert.deepEqual(await runningContainers(a.id), before, "the drain must not stop the container");
    assert.equal((await showAgent(s, a.id)).state, "running");

    // TODO(e2e-time-reconcile-sweep): the ~30 s after `release` is not the reconcile sweep (see cli-recovery-tree.test.ts).
    await s.restart(); // SIGTERM: pomtreed drains and exits; the container must outlive it
    const afterRestart = await runningContainers(a.id);
    assert.deepEqual(afterRestart, before, `the container must survive the stop and the restart: before ${before}, after ${afterRestart}`);
    const ps = (await s.pomtree(["ps"])).json<AgentJson[]>().filter((x) => x.parent !== null);
    assert.equal(ps.filter((x) => x.name === "busy").length, 1, `no duplicate agent after the restart: ${JSON.stringify(ps.map((x) => [x.name, x.state]))}`);
    assert.equal(ps.filter((x) => x.name === "late").length, 0, "the refused spawn must not appear after the restart");

    await release(afterRestart);
    const rec = await waitDone(s, a.id);
    assert.equal(rec.exit, "succeeded", JSON.stringify(rec));
    assert.equal(summaryOf(rec), "finished after drain");
    assert.equal(rec.generation, genBefore, "adoption must not bump the generation");
    const kinds = (await s.events(a.id)).map((e) => String(e.payload.kind));
    assert.equal(kinds.filter((k) => k === "started").length, 1, `exactly one started entry, got ${kinds}`);
    assert.equal(kinds.filter((k) => k === "resumed").length, 0, `adoption must not journal a resume, got ${kinds}`);
    assert.equal(kinds.filter((k) => k === "exited").length, 1, `exactly one exited entry, got ${kinds}`);
    assert.equal(s.stub.calls.filter((c) => c.matched === "busy").length, 1, "the tool turn must not replay after the restart");
    await s.until("the adopted agent's teardown", async () => (await runningContainers(a.id)).length === 0, 30_000);
    assert.equal((await agentContainers(a.id)).length <= 1, true, "no second container for the agent");
    assert.deepEqual(s.stub.unmatched, []);
  });
});

// ---- GIT-3 ----
// The operator's repo is created here and handed to the stack as repo.dir, because the harness does not return its own.
test("cli lifecycle GIT-3: two busy agents each get their own workspace clone under the state dir, and the operator repo has no agent branch", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  const repo = gitRepo();
  const script: ModelScript = {
    name: "git3",
    rules: [
      { id: "busy", when: { toolResults: 0 }, reply: callReply("sleep 600; echo slept") },
      { id: "stray", when: {}, reply: textReply("stray") },
    ],
  };
  const branches = () => execFileSync("git", ["-C", repo, "branch", "-a", "--format", "%(refname)"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const refs = () => execFileSync("git", ["-C", repo, "for-each-ref", "--format", "%(refname)"], { encoding: "utf8" }).split("\n").filter(Boolean);
  try {
    await withStack({ script, set: { "repo.dir": repo } }, async (s) => {
      const a = await spawnAgent(s, { task: "[[scn:git3a]] busy", name: "one", budget: 500_000 });
      const b = await spawnAgent(s, { task: "[[scn:git3b]] busy", name: "two", budget: 500_000 });
      await s.until(
        "both inside their sleep",
        async () =>
          s.stub.calls.filter((c) => c.matched === "busy").length === 2 &&
          (await showAgent(s, a.id)).state === "running" &&
          (await showAgent(s, b.id)).state === "running",
        120_000,
      );
      const wsRoot = join(s.stateDir, "workspaces");
      const dirs = existsSync(wsRoot) ? readdirSync(wsRoot).filter((d) => statSync(join(wsRoot, d)).isDirectory()) : [];
      t.diagnostic(`workspaces/: ${JSON.stringify(dirs)}; operator repo branches: ${JSON.stringify(branches())}; refs: ${JSON.stringify(refs())}`);
      for (const id of [a.id, b.id]) {
        const mine = dirs.filter((d) => d.includes(id));
        assert.equal(mine.length, 1, `one workspace folder for ${id}, got ${JSON.stringify(dirs)}`);
        assert.ok(existsSync(join(wsRoot, mine[0]!, ".git")), `${id}: the folder is its own git clone`);
      }
      assert.equal(dirs.length, 2, `exactly one folder per agent, got ${JSON.stringify(dirs)}`);
      assert.deepEqual(
        branches().filter((x) => x.includes("agent")),
        [],
        "no agent branch in the operator's repo",
      );
      assert.deepEqual(
        refs().filter((x) => /agent/.test(x)),
        [],
        "no agent ref of any kind in the operator's repo",
      );
      assert.equal(s.stub.calls.filter((c) => c.matched === "stray").length, 0);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- SAF-6 (CLI half) ----
// Skipped half: a chat-rank spawn through the host route with messaging.allowSpawn off needs the host listener and a messaging token, which
// this harness does not start; packages/pomtreed/src/workflow-launch.test.ts asserts the "spawn intent is not allowed" rejection offline.
// A default stack loads no extension and reviews no owner, so every qualified name is refused by the same 404: the daemon does not tell
// "owner not reviewed" from "no such workflow" (WorkflowHost.launch), by design (publicLaunchError keeps the messages fixed).
test("cli lifecycle SAF-6: pomtree workflow launch is refused on a default stack (hn-digest/digest, the name the hn-digest example registers) and starts no agent", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  await withStack({ script: { name: "saf6", rules: [{ id: "any", when: {}, reply: textReply("unused") }] } }, async (s) => {
    const before = (await s.pomtree(["ps"])).json<AgentJson[]>().length;
    for (const name of ["hn-digest/digest", "nobody/nothing"]) {
      const r = await s.pomtree(["workflow", "launch", name, "--input", "{}"]);
      t.diagnostic(`workflow launch ${name}: exit ${r.code} out ${JSON.stringify(r.out.trim())} err ${JSON.stringify(r.err.trim())}`);
      assert.equal(r.code, 3, `${name}: exit ${r.code}: ${r.out} ${r.err}`);
      assert.match(r.out + r.err, /unknown or unavailable workflow/, `${name}: the refusal names the cause`);
    }
    const bad = await s.pomtree(["workflow", "launch", "not-qualified", "--input", "{}"]);
    assert.equal(bad.code, 2, "an unqualified name is a usage error");
    assert.equal((await s.pomtree(["ps"])).json<AgentJson[]>().length, before, "a refused launch starts no agent");
    assert.equal(s.stub.calls.length, 0, "no model call");
  });
});

// ---- OPS-2 ----
const STUB_KEY = "stub-upstream-key-not-real";
const countOf = (text: string, needle: string) => text.split(needle).length - 1;
// The harness runs pomtree with --json, so `trace --out` writes {"markdown": "..."}; the key scan runs on the raw file and the header on the markdown.
const markdownOf = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { markdown: string }).markdown;

test("cli lifecycle OPS-2: ps, tree, top, show, logs, trace --children, spend and escalations ls work with two agents running and after they end; the trace has a redaction count and no key bytes", {
  skip: SKIP,
  timeout: TIMEOUT,
}, async (t) => {
  // Each agent raises an ask (kept open: the 5 s wait returns while the escalation stays) so escalations ls has both agents, then sleeps.
  const script: ModelScript = {
    name: "ops2",
    rules: [
      { id: "ask-a", when: { lastUserIncludes: "[[scn:ops2a]]", toolResults: 0 }, reply: callReply('pomtree ask "ops2-question-a" --wait 5000; sleep 600') },
      { id: "ask-b", when: { lastUserIncludes: "[[scn:ops2b]]", toolResults: 0 }, reply: callReply('pomtree ask "ops2-question-b" --wait 5000; sleep 600') },
      { id: "stray", when: {}, reply: textReply("stray") },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "pops2-"));
  try {
    await withStack({ script }, async (s) => {
      const a = await spawnAgent(s, { task: "[[scn:ops2a]] watch me", name: "watched-a", budget: 500_000 });
      const b = await spawnAgent(s, { task: "[[scn:ops2b]] watch me", name: "watched-b", budget: 500_000 });
      const ids = [a.id, b.id];
      await s.until("both asks open", async () => (await s.pomtree(["escalations", "ls"])).json<unknown[]>().length === 2, 120_000);
      const root = (await s.pomtree(["ps"])).json<AgentJson[]>().find((x) => x.parent === null)!;

      const observe = async (phase: string) => {
        const runs: Record<string, Awaited<ReturnType<Stack["pomtree"]>>> = {
          ps: await s.pomtree(["ps"]),
          tree: await s.pomtree(["tree"]),
          top: await s.pomtree(["top"]),
          spend: await s.pomtree(["spend"]),
          escalations: await s.pomtree(["escalations", "ls"]),
          [`show-${a.id}`]: await s.pomtree(["show", a.id]),
          [`show-${b.id}`]: await s.pomtree(["show", b.id]),
          [`logs-${a.id}`]: await s.pomtree(["logs", a.id]),
          [`logs-${b.id}`]: await s.pomtree(["logs", b.id]),
        };
        for (const [what, r] of Object.entries(runs)) assert.equal(r.code, 0, `${phase}: pomtree ${what}: exit ${r.code}: ${r.out.slice(0, 300)} ${r.err}`);
        for (const verb of ["ps", "tree", "top"])
          for (const id of ids) assert.ok(runs[verb]!.out.includes(id), `${phase}: pomtree ${verb} must list ${id}: ${runs[verb]!.out.slice(0, 600)}`);
        for (const id of ids) {
          assert.equal(runs[`show-${id}`]!.json<{ agent: AgentJson }>().agent.id, id, `${phase}: show ${id}`);
          assert.ok(runs[`logs-${id}`]!.out.split("\n").filter(Boolean).length > 0, `${phase}: logs ${id} printed no events`);
        }
        const spend = runs.spend!.json<Record<string, unknown>>();
        t.diagnostic(`${phase}: spend ${JSON.stringify(spend).slice(0, 400)}`);
        // spend prints totals, not rows: both agents show as the running count while they run and as the reaped count after.
        const byState = spend.agentsByState as Record<string, number>;
        if (phase === "running") for (const id of ids) assert.ok(JSON.stringify(spend).includes(id), `${phase}: spend lists ${id} among the running agents`);
        else assert.equal(byState.reaped, 2, `${phase}: spend counts both agents as reaped`);
        const esc = runs.escalations!.json<{ agent: string }[]>();
        assert.deepEqual(esc.map((e) => e.agent).sort(), [...ids].sort(), `${phase}: escalations ls lists both asks`);

        const out = join(dir, `trace-${phase}.md`);
        const tr = await s.pomtree(["trace", root.id, "--children", "--out", out]);
        assert.equal(tr.code, 0, `${phase}: trace: exit ${tr.code}: ${tr.out} ${tr.err}`);
        const raw = readFileSync(out, "utf8");
        const text = markdownOf(out);
        const header = /^- redacted: (\d+) values$/m.exec(text);
        t.diagnostic(`${phase}: trace ${text.length} bytes, header ${JSON.stringify(header?.[0])}`);
        assert.ok(header, `${phase}: the trace header carries a redaction count`);
        for (const id of ids) assert.ok(text.includes(id), `${phase}: the trace with children mentions ${id}`);
        assert.equal(countOf(raw, STUB_KEY), 0, `${phase}: the upstream key must not appear in the trace file`);
        for (const id of ids) {
          const one = join(dir, `trace-${phase}-${id}.md`);
          assert.equal((await s.pomtree(["trace", id, "--out", one])).code, 0, `${phase}: trace ${id}`);
          assert.equal(countOf(readFileSync(one, "utf8"), STUB_KEY), 0);
          assert.ok(/^- redacted: \d+ values$/m.test(markdownOf(one)));
        }
      };
      assert.equal(countOf(`x ${STUB_KEY} y`, STUB_KEY), 1, "negative control: the key scan can find the key");

      await observe("running");
      for (const id of ids) assert.equal((await s.pomtree(["kill", id])).code, 0);
      for (const id of ids) await waitDone(s, id, 60_000);
      await observe("ended");
      assert.equal(s.stub.calls.filter((c) => c.matched === "stray").length, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
